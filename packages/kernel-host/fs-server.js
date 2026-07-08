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

export class FsServer {
  constructor(vfs) {
    this.vfs = vfs;
    this.clients = new Map(); // clientId -> { ctrl, data }
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
  }

  dispatch(opcode, flags, fields) {
    const vfs = this.vfs;
    const s = (i) => decodeBytes(fields[i]);
    switch (opcode) {
      case OP_READ_FILE:
        return vfs.read_file(s(0));
      case OP_WRITE_FILE:
        return vfs.write_file(s(0), fields[1]), EMPTY;
      case OP_EXISTS:
        return new Uint8Array([vfs.exists(s(0)) ? 1 : 0]);
      case OP_READDIR:
        return encodeString(vfs.readdir(s(0)).join("\n"));
      case OP_MKDIR:
        return vfs.mkdir(s(0), (flags & FLAG_RECURSIVE) !== 0), EMPTY;
      case OP_STAT:
        return encodeString(vfs.stat(s(0)));
      case OP_LSTAT:
        return encodeString(vfs.lstat(s(0)));
      case OP_UNLINK:
        return vfs.unlink(s(0)), EMPTY;
      case OP_RMDIR:
        return vfs.rmdir(s(0)), EMPTY;
      case OP_RENAME:
        return vfs.rename(s(0), s(1)), EMPTY;
      case OP_SYMLINK:
        return vfs.symlink(s(0), s(1)), EMPTY;
      case OP_READLINK:
        return encodeString(vfs.readlink(s(0)));
      case OP_OPEN:
        return u32ToBytes(vfs.open(s(0), bytesToU32(fields[1]) | 0, bytesToU32(fields[2])));
      case OP_CLOSE:
        return vfs.close(bytesToU32(fields[0])), EMPTY;
      case OP_FD_READ:
        return vfs.fd_read(bytesToU32(fields[0]), bytesToU32(fields[1]), bytesToF64(fields[2]));
      case OP_FD_WRITE:
        return u32ToBytes(vfs.fd_write(bytesToU32(fields[0]), fields[2], bytesToF64(fields[1])));
      case OP_FSTAT:
        return encodeString(vfs.fstat(bytesToU32(fields[0])));
      case OP_FTRUNCATE:
        return vfs.ftruncate(bytesToU32(fields[0]), bytesToU32(fields[1])), EMPTY;
      default:
        throw "ENOSYS";
    }
  }
}
