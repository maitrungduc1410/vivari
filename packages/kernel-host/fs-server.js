// The File System Worker's servicing core (Phase 2 #14).
//
// The Rust/Wasm VFS used to live inside the Kernel and every fs syscall was
// serviced on the kernel thread. #14 moves the VFS into its own dedicated worker
// so filesystem traffic never competes with process/network supervision. This
// class is the environment-agnostic half: it owns the single VFS instance and
// services fs opcodes **directly over each client's SharedArrayBuffer**, exactly
// like the kernel did — but off the kernel's thread.
//
// Clients (each with their own SAB) register once; a doorbell (a MessagePort for
// processes, or a plain message for the kernel's own sync fs) tells us which
// client has a request pending. We decode it, run it against the VFS, write the
// response back into that same SAB, and Atomics.notify the parked caller. The
// caller (fs-client.js) is unchanged: it still parks on Atomics.wait — it just
// gets woken by this worker instead of the kernel.

import {
  makeViews,
  encodeString,
  decodeBytes,
  decodeRequest,
  u32ToBytes,
  bytesToU32,
  bytesToF64,
  I_STATE,
  I_OPCODE,
  I_REQ_LEN,
  I_RES_LEN,
  STATE_RESPONSE_OK,
  STATE_RESPONSE_ERR,
  FLAG_RECURSIVE,
  OP_READ_FILE,
  OP_WRITE_FILE,
  OP_EXISTS,
  OP_READDIR,
  OP_MKDIR,
  OP_STAT,
  OP_LSTAT,
  OP_UNLINK,
  OP_RMDIR,
  OP_RENAME,
  OP_SYMLINK,
  OP_READLINK,
  OP_LINK,
  OP_OPEN,
  OP_CLOSE,
  OP_FD_READ,
  OP_FD_WRITE,
  OP_FSTAT,
  OP_FTRUNCATE,
  OP_WATCH,
  OP_UNWATCH,
} from "../protocol/syscall.js";

const EMPTY = new Uint8Array(0);

// POSIX path helpers (the VFS speaks absolute POSIX paths). Kept local so the
// server has no dependency on a path module.
const basename = (p) => {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
};
// Return `path` relative to `dir`, or null if it isn't within `dir`. "" means
// `path` IS `dir` (the watched entry itself).
const relWithin = (dir, path) => {
  if (path === dir) return "";
  const prefix = dir.endsWith("/") ? dir : dir + "/";
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
};
// First path segment (the top-level dir name), or "" for the root "/". Used to
// bucket watches: a mutation can only be *within* a watch dir if they share the
// same first segment — unless the watch is on "/" (bucket ""), which covers all.
// This makes "is anyone watching this path?" ~O(1), so churn in an unwatched
// top-level subtree (e.g. `npm install` in /app next to a dev server in /vt)
// costs nothing — no exists() probe, no fan-out scan.
const firstSeg = (p) => {
  let i = 0;
  while (i < p.length && p[i] === "/") i++;
  const j = p.indexOf("/", i);
  return j === -1 ? p.slice(i) : p.slice(i, j);
};

// POSIX open(2) bits we care about for persistence (must match the Rust VFS /
// internalBinding('constants').fs). A write-opened file with O_CREAT/O_TRUNC is
// dirty immediately (it may be created empty and never written before close).
const O_CREAT = 0o100;
const O_TRUNC = 0o1000;

// Where the kernel materializes fetched response bodies. MUST match
// Kernel._fetchCachePath — asserted by the fetch-body-lifetime spike. Reads under
// this prefix are reported via onBodyConsumed so the kernel can free them.
const FETCH_BODY_PREFIX = "/var/cache/vv-fetch/";
const isFetchBody = (p) => typeof p === "string" && p.startsWith(FETCH_BODY_PREFIX);

export class FsServer {
  // `persistence` (optional) is the OPFS write-behind adapter. When present we
  // forward every successful mutation to it so the VFS survives a reload; when
  // null (headless, or OPFS unavailable) the server behaves exactly as before.
  constructor(vfs, persistence = null) {
    this.vfs = vfs;
    this.persistence = persistence;
    // Optional: (path) => void, called once a read of a kernel-fetched body has
    // finished, so the kernel can drop its reference and free the scratch file (see
    // Kernel.releaseFetchBody). The kernel hands a process a PATH and cannot see
    // the read itself — it happens here, over the SAB — so this is the only place
    // "the reader is done" is observable. Left null by an embedder that doesn't
    // care: bodies then simply live until their process exits.
    this.onBodyConsumed = null;
    this.clients = new Map(); // clientId -> { ctrl, data, port }
    // fd -> path, so fd-based ops (fd_write/ftruncate/close) know which file they
    // touch — needed both for persistence re-mirroring and for watch events.
    this.fdPaths = new Map();
    // Active fs.watch registrations (roadmap #19 stage B). `watches` is the flat
    // map keyed by `clientId:watchId` -> { clientId, watchId, path, recursive,
    // port, top }, used for size/removal/per-client cleanup. `watchesByTop` is the
    // same set bucketed by the watch path's first segment (roadmap #19 optimize)
    // so a mutation only ever scans watches in its own top-level tree (+ root
    // watches). Both are empty in the common case (no watchers) → mutations pay
    // nothing, and a mutation under an unwatched top-level dir is ~O(1).
    this.watches = new Map();
    this.watchesByTop = new Map(); // top segment -> Map<key, watch>
  }

  // Could a mutation at `path` reach any watcher? Cheap gate for the exists()
  // probe and the fan-out: true only if some watch shares this path's top segment
  // (or a root "/" watch exists, which covers everything).
  couldNotify(path) {
    if (this.watches.size === 0) return false;
    const top = firstSeg(path);
    return this.watchesByTop.has(top) || (top !== "" && this.watchesByTop.has(""));
  }

  /**
   * Start serving a client's SAB. `port` (a MessagePort) is the doorbell: when
   * the client rings it we service exactly one request. The kernel registers
   * without a port and rings via a direct message instead.
   */
  register(clientId, sab, port = null) {
    const { ctrl, data } = makeViews(sab);
    this.clients.set(clientId, { ctrl, data, port });
    if (port) {
      port.onmessage = () => this.service(clientId);
      if (port.start) port.start();
    }
  }

  unregister(clientId) {
    this.clients.delete(clientId);
    // Drop any watches this client still held (its process is gone).
    if (this.watches.size) {
      for (const [key, w] of this.watches) {
        if (w.clientId === clientId) this._deleteWatch(key, w);
      }
    }
  }

  addWatch(clientId, watchId, path, recursive) {
    const c = this.clients.get(clientId);
    if (!c || !c.port) return; // only port-backed clients (processes) can receive events
    const key = clientId + ":" + watchId;
    const top = firstSeg(path);
    const w = { clientId, watchId, path, recursive, port: c.port, top };
    this.watches.set(key, w);
    let bucket = this.watchesByTop.get(top);
    if (!bucket) this.watchesByTop.set(top, (bucket = new Map()));
    bucket.set(key, w);
  }

  removeWatch(clientId, watchId) {
    const key = clientId + ":" + watchId;
    const w = this.watches.get(key);
    if (w) this._deleteWatch(key, w);
  }

  _deleteWatch(key, w) {
    this.watches.delete(key);
    const bucket = this.watchesByTop.get(w.top);
    if (bucket) {
      bucket.delete(key);
      if (bucket.size === 0) this.watchesByTop.delete(w.top);
    }
  }

  // Push a change to every watcher that covers `path`. Node's fs.watch fires
  // (eventType, filename) where filename is relative to the watched directory
  // (or the basename for a single-file watch). 'rename' = add/remove/rename,
  // 'change' = contents changed; chokidar (Vite's watcher) re-stats either way.
  notifyWatch(path, event) {
    if (this.watches.size === 0) return;
    // Only watches sharing this path's top segment (or a root "/" watch) can
    // possibly cover it — scan just those buckets, not every registration.
    const top = firstSeg(path);
    const bucket = this.watchesByTop.get(top);
    const rootBucket = top !== "" ? this.watchesByTop.get("") : undefined;
    if (!bucket && !rootBucket) return;
    const fan = (b) => {
      for (const w of b.values()) {
        const rel = relWithin(w.path, path);
        if (rel === null) continue;
        let filename;
        if (rel === "") filename = basename(w.path); // the watched entry itself
        else if (rel.indexOf("/") === -1) filename = rel; // direct child
        else if (w.recursive) filename = rel; // nested, recursive watch
        else continue; // nested but non-recursive: ignore
        try {
          w.port.postMessage({ type: "fs-watch", watchId: w.watchId, event, filename });
        } catch {
          /* port closed (process gone) — it'll be cleaned up on unregister */
        }
      }
    };
    if (bucket) fan(bucket);
    if (rootBucket) fan(rootBucket);
  }

  /** Service one pending request sitting in the given client's SAB. */
  service(clientId) {
    const c = this.clients.get(clientId);
    if (!c) return;
    const { ctrl, data } = c;
    const opcode = Atomics.load(ctrl, I_OPCODE);
    const { flags, fields } = decodeRequest(data.slice(0, Atomics.load(ctrl, I_REQ_LEN)));
    try {
      const bytes = this.dispatch(opcode, flags, fields, clientId);
      if (bytes.length > data.length) {
        // The response doesn't fit the shared window (e.g. a whole-file read of a
        // >1 MiB file). Signal EFBIG so the client retries via the chunked fd path
        // instead of throwing an opaque "offset is out of bounds" from data.set().
        const e = encodeString("EFBIG: response exceeds shared window");
        data.set(e, 0);
        Atomics.store(ctrl, I_RES_LEN, e.length);
        Atomics.store(ctrl, I_STATE, STATE_RESPONSE_ERR);
        Atomics.notify(ctrl, I_STATE);
        return;
      }
      data.set(bytes, 0);
      Atomics.store(ctrl, I_RES_LEN, bytes.length);
      Atomics.store(ctrl, I_STATE, STATE_RESPONSE_OK);
      Atomics.notify(ctrl, I_STATE);
    } catch (err) {
      const bytes = encodeString(typeof err === "string" ? err : String(err?.message || "EIO"));
      data.set(bytes, 0);
      Atomics.store(ctrl, I_RES_LEN, bytes.length);
      Atomics.store(ctrl, I_STATE, STATE_RESPONSE_ERR);
      Atomics.notify(ctrl, I_STATE);
    }
  }

  /**
   * Write an arbitrarily large body straight into the VFS, bypassing the 1 MiB
   * SAB window. Used by the kernel's deferred OP_FETCH: it hands us the fetched
   * tarball over a transferable ArrayBuffer and we materialize it here (the VFS
   * lives on this thread now), then the process reads it back with normal fs.
   */
  writeLarge(path, bytes) {
    const existed = this.couldNotify(path) ? this.vfs.exists(path) : false;
    this.vfs.write_file(path, bytes);
    const p = this.persistence;
    if (p) p.onWrite(path);
    this.notifyWatch(path, existed ? "change" : "rename");
  }

  /**
   * Write MANY files in ONE call — the boot-time delivery of a package manager's
   * tree (npm ~2400 files, pnpm/corepack/yarn) used to be one SAB round-trip per
   * file, which dominated cold-boot. Here the whole batch arrives over a single
   * transferable ArrayBuffer (see kernel-fs.writeFilesBatch): `entries` are
   * `{ path, byteOffset, byteLength }` slices into `buffer`. We create each unique
   * parent dir once and write every file against the VFS on this thread, so the
   * cost is one message + one loop instead of N doorbell/Atomics.wait cycles.
   */
  writeBatch(entries, buffer) {
    const view = new Uint8Array(buffer);
    const p = this.persistence;
    const madeDirs = new Set();
    for (const e of entries) {
      const slash = e.path.lastIndexOf("/");
      if (slash > 0) {
        const dir = e.path.slice(0, slash);
        if (!madeDirs.has(dir)) {
          try { this.vfs.mkdir(dir, true); } catch { /* exists */ }
          madeDirs.add(dir);
        }
      }
      const bytes = view.subarray(e.byteOffset, e.byteOffset + e.byteLength);
      const existed = this.couldNotify(e.path) ? this.vfs.exists(e.path) : false;
      this.vfs.write_file(e.path, bytes);
      if (p) p.onWrite(e.path);
      if (this.watches.size) this.notifyWatch(e.path, existed ? "change" : "rename");
    }
    return entries.length;
  }

  dispatch(opcode, flags, fields, clientId) {
    const vfs = this.vfs;
    const p = this.persistence; // null when persistence is off (headless)
    const s = (i) => decodeBytes(fields[i]);
    switch (opcode) {
      case OP_READ_FILE: {
        const path = s(0);
        const bytes = vfs.read_file(path);
        // Whole-file read: the reader is done the moment this returns.
        if (this.onBodyConsumed && isFetchBody(path)) this.onBodyConsumed(path);
        return bytes;
      }
      case OP_WRITE_FILE: {
        const path = s(0);
        const existed = this.couldNotify(path) ? vfs.exists(path) : false;
        vfs.write_file(path, fields[1]);
        if (p) p.onWrite(path);
        // A brand-new file is a 'rename' (creation) then its contents 'change';
        // an existing one is just 'change'. chokidar re-stats regardless.
        this.notifyWatch(path, existed ? "change" : "rename");
        return EMPTY;
      }
      case OP_EXISTS:
        return new Uint8Array([vfs.exists(s(0)) ? 1 : 0]);
      case OP_READDIR:
        return encodeString(vfs.readdir(s(0)).join("\n"));
      case OP_MKDIR: {
        const path = s(0);
        vfs.mkdir(path, (flags & FLAG_RECURSIVE) !== 0);
        if (p) p.onWrite(path);
        this.notifyWatch(path, "rename");
        return EMPTY;
      }
      case OP_STAT:
        return encodeString(vfs.stat(s(0)));
      case OP_LSTAT:
        return encodeString(vfs.lstat(s(0)));
      case OP_UNLINK: {
        const path = s(0);
        vfs.unlink(path);
        if (p) p.onDelete(path);
        this.notifyWatch(path, "rename");
        return EMPTY;
      }
      case OP_RMDIR: {
        const path = s(0);
        vfs.rmdir(path);
        if (p) p.onDelete(path);
        this.notifyWatch(path, "rename");
        return EMPTY;
      }
      case OP_RENAME: {
        const from = s(0);
        const to = s(1);
        vfs.rename(from, to);
        if (p) p.onRename(from, to);
        this.notifyWatch(from, "rename");
        this.notifyWatch(to, "rename");
        return EMPTY;
      }
      case OP_SYMLINK: {
        const target = s(0);
        const linkpath = s(1);
        vfs.symlink(target, linkpath);
        if (p) p.onWrite(linkpath);
        this.notifyWatch(linkpath, "rename");
        return EMPTY;
      }
      case OP_READLINK:
        return encodeString(vfs.readlink(s(0)));
      case OP_LINK: {
        // Guard: a wasm build predating VFS.link answers ENOSYS so the runtime's
        // fs.link falls back to a content copy (unchanged behaviour). With link
        // support, the new name shares the existing inode — no byte copy — which
        // is what stops pnpm doubling node_modules in the VFS's Wasm RAM.
        if (typeof vfs.link !== "function") throw "ENOSYS";
        const existing = s(0);
        const linkpath = s(1);
        vfs.link(existing, linkpath);
        // Persist the new name as its own on-disk entry (OPFS has no hard links);
        // the in-RAM dedup is what we're after here.
        if (p) p.onWrite(linkpath);
        this.notifyWatch(linkpath, "rename");
        return EMPTY;
      }
      case OP_OPEN: {
        const path = s(0);
        const oflags = bytesToU32(fields[1]) | 0;
        const accmode = oflags & 0o3;
        const writable = accmode === 1 /* O_WRONLY */ || accmode === 2 /* O_RDWR */;
        // Whether the file existed before the open decides create ('rename') vs
        // truncate ('change') for watchers; only checked when someone's watching.
        const existedBefore =
          writable && (oflags & (O_CREAT | O_TRUNC)) !== 0 && this.couldNotify(path) ? vfs.exists(path) : true;
        const fd = vfs.open(path, oflags, bytesToU32(fields[2]));
        if (this.fdPaths) this.fdPaths.set(fd, path);
        if (writable && (oflags & (O_CREAT | O_TRUNC)) !== 0) {
          if (p) p.onWrite(path);
          this.notifyWatch(path, existedBefore ? "change" : "rename");
        }
        return u32ToBytes(fd);
      }
      case OP_CLOSE: {
        const fd = bytesToU32(fields[0]);
        vfs.close(fd);
        const path = this.fdPaths.get(fd);
        this.fdPaths.delete(fd);
        if (path && p) p.onWrite(path); // flush the final contents on close
        // fs.readFileSync(path) with no encoding goes open()+readSync()+close(), so
        // close is where a body read finishes. Reporting on open() instead would
        // free the file while the fd was still being read.
        if (path && this.onBodyConsumed && isFetchBody(path)) this.onBodyConsumed(path);
        return EMPTY;
      }
      case OP_FD_READ:
        return vfs.fd_read(bytesToU32(fields[0]), bytesToU32(fields[1]), bytesToF64(fields[2]));
      case OP_FD_WRITE: {
        const fd = bytesToU32(fields[0]);
        const n = vfs.fd_write(fd, fields[2], bytesToF64(fields[1]));
        const path = this.fdPaths.get(fd);
        if (path) {
          if (p) p.onWrite(path);
          this.notifyWatch(path, "change");
        }
        return u32ToBytes(n);
      }
      case OP_FSTAT:
        return encodeString(vfs.fstat(bytesToU32(fields[0])));
      case OP_FTRUNCATE: {
        const fd = bytesToU32(fields[0]);
        vfs.ftruncate(fd, bytesToU32(fields[1]));
        const path = this.fdPaths.get(fd);
        if (path) {
          if (p) p.onWrite(path);
          this.notifyWatch(path, "change");
        }
        return EMPTY;
      }
      case OP_WATCH: {
        const watchId = bytesToU32(fields[0]);
        const path = s(1);
        this.addWatch(clientId, watchId, path, (flags & FLAG_RECURSIVE) !== 0);
        return EMPTY;
      }
      case OP_UNWATCH: {
        this.removeWatch(clientId, bytesToU32(fields[0]));
        return EMPTY;
      }
      default:
        throw "ENOSYS";
    }
  }
}