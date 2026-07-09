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

// POSIX open(2) bits we care about for persistence (must match the Rust VFS /
// internalBinding('constants').fs). A write-opened file with O_CREAT/O_TRUNC is
// dirty immediately (it may be created empty and never written before close).
const O_CREAT = 0o100;
const O_TRUNC = 0o1000;

export class FsServer {
  // `persistence` (optional) is the OPFS write-behind adapter. When present we
  // forward every successful mutation to it so the VFS survives a reload; when
  // null (headless, or OPFS unavailable) the server behaves exactly as before.
  constructor(vfs, persistence = null) {
    this.vfs = vfs;
    this.persistence = persistence;
    this.clients = new Map(); // clientId -> { ctrl, data, port }
    // fd -> path, so fd-based ops (fd_write/ftruncate/close) know which file they
    // touch — needed both for persistence re-mirroring and for watch events.
    this.fdPaths = new Map();
    // Active fs.watch registrations (roadmap #19 stage B). Keyed by
    // `clientId:watchId` -> { clientId, watchId, path, recursive, port }. A single
    // flat map keeps fan-out simple; it's empty for the overwhelmingly common case
    // (no watchers), so mutations pay nothing then.
    this.watches = new Map();
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
      for (const key of this.watches.keys()) {
        if (this.watches.get(key).clientId === clientId) this.watches.delete(key);
      }
    }
  }

  addWatch(clientId, watchId, path, recursive) {
    const c = this.clients.get(clientId);
    if (!c || !c.port) return; // only port-backed clients (processes) can receive events
    this.watches.set(clientId + ":" + watchId, { clientId, watchId, path, recursive, port: c.port });
  }

  removeWatch(clientId, watchId) {
    this.watches.delete(clientId + ":" + watchId);
  }

  // Push a change to every watcher that covers `path`. Node's fs.watch fires
  // (eventType, filename) where filename is relative to the watched directory
  // (or the basename for a single-file watch). 'rename' = add/remove/rename,
  // 'change' = contents changed; chokidar (Vite's watcher) re-stats either way.
  notifyWatch(path, event) {
    if (this.watches.size === 0) return;
    for (const w of this.watches.values()) {
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
    const existed = this.watches.size ? this.vfs.exists(path) : false;
    this.vfs.write_file(path, bytes);
    const p = this.persistence;
    if (p) p.onWrite(path);
    this.notifyWatch(path, existed ? "change" : "rename");
  }

  dispatch(opcode, flags, fields, clientId) {
    const vfs = this.vfs;
    const p = this.persistence; // null when persistence is off (headless)
    const watching = this.watches.size > 0; // gate watch bookkeeping to when it matters
    const s = (i) => decodeBytes(fields[i]);
    switch (opcode) {
      case OP_READ_FILE:
        return vfs.read_file(s(0));
      case OP_WRITE_FILE: {
        const path = s(0);
        const existed = watching ? vfs.exists(path) : false;
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
      case OP_OPEN: {
        const path = s(0);
        const oflags = bytesToU32(fields[1]) | 0;
        const accmode = oflags & 0o3;
        const writable = accmode === 1 /* O_WRONLY */ || accmode === 2 /* O_RDWR */;
        // Whether the file existed before the open decides create ('rename') vs
        // truncate ('change') for watchers; only checked when someone's watching.
        const existedBefore = watching && writable && (oflags & (O_CREAT | O_TRUNC)) !== 0 ? vfs.exists(path) : true;
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
