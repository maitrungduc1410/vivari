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
} from "../protocol/syscall.js";

const EMPTY = new Uint8Array(0);

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
    this.clients = new Map(); // clientId -> { ctrl, data }
    // fd -> path, so fd-based writes (fd_write/ftruncate/close) know which file
    // to re-mirror. Only tracked when persistence is active.
    this.fdPaths = persistence ? new Map() : null;
  }

  /**
   * Start serving a client's SAB. `port` (a MessagePort) is the doorbell: when
   * the client rings it we service exactly one request. The kernel registers
   * without a port and rings via a direct message instead.
   */
  register(clientId, sab, port = null) {
    this.clients.set(clientId, makeViews(sab));
    if (port) {
      port.onmessage = () => this.service(clientId);
      if (port.start) port.start();
    }
  }

  unregister(clientId) {
    this.clients.delete(clientId);
  }

  /** Service one pending request sitting in the given client's SAB. */
  service(clientId) {
    const c = this.clients.get(clientId);
    if (!c) return;
    const { ctrl, data } = c;
    const opcode = Atomics.load(ctrl, I_OPCODE);
    const { flags, fields } = decodeRequest(data.slice(0, Atomics.load(ctrl, I_REQ_LEN)));
    try {
      const bytes = this.dispatch(opcode, flags, fields);
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
    this.vfs.write_file(path, bytes);
    const p = this.persistence;
    if (p) p.onWrite(path);
  }

  dispatch(opcode, flags, fields) {
    const vfs = this.vfs;
    const p = this.persistence; // null when persistence is off (headless)
    const s = (i) => decodeBytes(fields[i]);
    switch (opcode) {
      case OP_READ_FILE:
        return vfs.read_file(s(0));
      case OP_WRITE_FILE: {
        const path = s(0);
        vfs.write_file(path, fields[1]);
        if (p) p.onWrite(path);
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
        return EMPTY;
      }
      case OP_RMDIR: {
        const path = s(0);
        vfs.rmdir(path);
        if (p) p.onDelete(path);
        return EMPTY;
      }
      case OP_RENAME: {
        const from = s(0);
        const to = s(1);
        vfs.rename(from, to);
        if (p) p.onRename(from, to);
        return EMPTY;
      }
      case OP_SYMLINK: {
        const target = s(0);
        const linkpath = s(1);
        vfs.symlink(target, linkpath);
        if (p) p.onWrite(linkpath);
        return EMPTY;
      }
      case OP_READLINK:
        return encodeString(vfs.readlink(s(0)));
      case OP_OPEN: {
        const path = s(0);
        const oflags = bytesToU32(fields[1]) | 0;
        const fd = vfs.open(path, oflags, bytesToU32(fields[2]));
        if (p) {
          this.fdPaths.set(fd, path);
          const accmode = oflags & 0o3;
          const writable = accmode === 1 /* O_WRONLY */ || accmode === 2 /* O_RDWR */;
          // A file opened for write with create/truncate is dirty right away.
          if (writable && (oflags & (O_CREAT | O_TRUNC)) !== 0) p.onWrite(path);
        }
        return u32ToBytes(fd);
      }
      case OP_CLOSE: {
        const fd = bytesToU32(fields[0]);
        vfs.close(fd);
        if (p) {
          const path = this.fdPaths.get(fd);
          this.fdPaths.delete(fd);
          if (path) p.onWrite(path); // flush the final contents on close
        }
        return EMPTY;
      }
      case OP_FD_READ:
        return vfs.fd_read(bytesToU32(fields[0]), bytesToU32(fields[1]), bytesToF64(fields[2]));
      case OP_FD_WRITE: {
        const fd = bytesToU32(fields[0]);
        const n = vfs.fd_write(fd, fields[2], bytesToF64(fields[1]));
        if (p) {
          const path = this.fdPaths.get(fd);
          if (path) p.onWrite(path);
        }
        return u32ToBytes(n);
      }
      case OP_FSTAT:
        return encodeString(vfs.fstat(bytesToU32(fields[0])));
      case OP_FTRUNCATE: {
        const fd = bytesToU32(fields[0]);
        vfs.ftruncate(fd, bytesToU32(fields[1]));
        if (p) {
          const path = this.fdPaths.get(fd);
          if (path) p.onWrite(path);
        }
        return EMPTY;
      }
      default:
        throw "ENOSYS";
    }
  }
}
