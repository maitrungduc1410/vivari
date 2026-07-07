// The kernel-side syscall client, seen from inside a worker/process.
//
// This is the low-level half of the sync bridge: it serializes a request into
// the shared buffer, parks the thread on `Atomics.wait`, and reads the response
// back — turning the cross-thread round-trip into a blocking synchronous call.
// It is environment-agnostic: the caller injects a `notify` function that nudges
// the host (postMessage in a browser Worker, or via parentPort in Node).
//
// Returned values are raw (Uint8Array / string / boolean / plain objects). The
// `fs` builtin layers Node semantics (Buffer, Stats, encodings) on top.

import {
  encodeString,
  decodeBytes,
  encodeRequest,
  u32ToBytes,
  bytesToU32,
  f64ToBytes,
  I_STATE,
  I_OPCODE,
  I_REQ_LEN,
  I_RES_LEN,
  STATE_REQUEST,
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
  OP_SPAWN,
  OP_LISTEN,
  OP_ACCEPT,
  OP_RESPOND,
  OP_CLOSE_SERVER,
} from "../protocol/syscall.js";

// Cap each fd read/write to keep both request and response inside the 1 MiB
// shared-data window. Node's lib/fs.js loops on short reads/writes, so a large
// file is transferred in chunks transparently.
const FD_CHUNK = 512 * 1024;

export function createSyscalls({ ctrl, data, notify }) {
  const b = encodeString;

  function call(opcode, request) {
    if (request.length > data.length) {
      throw new Error("syscall request too large for the shared data region");
    }
    data.set(request, 0);
    Atomics.store(ctrl, I_OPCODE, opcode);
    Atomics.store(ctrl, I_REQ_LEN, request.length);
    Atomics.store(ctrl, I_STATE, STATE_REQUEST);

    notify(); // wake the host's event loop
    Atomics.wait(ctrl, I_STATE, STATE_REQUEST);

    const state = Atomics.load(ctrl, I_STATE);
    const payload = data.slice(0, Atomics.load(ctrl, I_RES_LEN));
    if (state === STATE_RESPONSE_ERR) {
      const code = decodeBytes(payload);
      const err = new Error(code);
      err.code = code;
      throw err;
    }
    return payload;
  }

  return {
    readFile: (p) => call(OP_READ_FILE, encodeRequest([b(p)])),
    writeFile: (p, content) => {
      const body = typeof content === "string" ? b(content) : content;
      call(OP_WRITE_FILE, encodeRequest([b(p), body]));
    },
    exists: (p) => call(OP_EXISTS, encodeRequest([b(p)]))[0] === 1,
    readdir: (p) => {
      const t = decodeBytes(call(OP_READDIR, encodeRequest([b(p)])));
      return t.length ? t.split("\n") : [];
    },
    mkdir: (p, recursive) =>
      call(OP_MKDIR, encodeRequest([b(p)], recursive ? FLAG_RECURSIVE : 0)),
    stat: (p) => JSON.parse(decodeBytes(call(OP_STAT, encodeRequest([b(p)])))),
    lstat: (p) => JSON.parse(decodeBytes(call(OP_LSTAT, encodeRequest([b(p)])))),
    unlink: (p) => call(OP_UNLINK, encodeRequest([b(p)])),
    rmdir: (p) => call(OP_RMDIR, encodeRequest([b(p)])),
    rename: (from, to) => call(OP_RENAME, encodeRequest([b(from), b(to)])),
    symlink: (target, link) => call(OP_SYMLINK, encodeRequest([b(target), b(link)])),
    readlink: (p) => decodeBytes(call(OP_READLINK, encodeRequest([b(p)]))),

    // ---- file-descriptor layer (Phase 2 #4) ----
    open: (p, flags, mode) =>
      bytesToU32(call(OP_OPEN, encodeRequest([b(p), u32ToBytes(flags), u32ToBytes(mode)]))),
    close: (fd) => call(OP_CLOSE, encodeRequest([u32ToBytes(fd)])),
    // Read up to `len` bytes at `pos` (-1 = fd cursor). Returns a Uint8Array,
    // possibly shorter than requested (short read) — callers loop.
    fdRead: (fd, len, pos) =>
      call(
        OP_FD_READ,
        encodeRequest([u32ToBytes(fd), u32ToBytes(Math.min(len, FD_CHUNK)), f64ToBytes(pos)]),
      ),
    // Write `bytes` at `pos` (-1 = fd cursor). Returns bytes actually written
    // (<= FD_CHUNK) so callers loop for large buffers.
    fdWrite: (fd, bytes, pos) => {
      const chunk = bytes.length > FD_CHUNK ? bytes.subarray(0, FD_CHUNK) : bytes;
      return bytesToU32(call(OP_FD_WRITE, encodeRequest([u32ToBytes(fd), f64ToBytes(pos), chunk])));
    },
    fstat: (fd) => JSON.parse(decodeBytes(call(OP_FSTAT, encodeRequest([u32ToBytes(fd)])))),
    ftruncate: (fd, len) => call(OP_FTRUNCATE, encodeRequest([u32ToBytes(fd), u32ToBytes(len)])),
    // Spawn a child and block until it exits (waitpid). Returns
    // { code, stdout, stderr, pid }. This is how execSync/spawnSync work.
    spawn: (spec) =>
      JSON.parse(decodeBytes(call(OP_SPAWN, encodeRequest([b(JSON.stringify(spec))])))),

    // ---- virtual network (brick 5) ----
    // Register a port. Returns nothing; throws EADDRINUSE if taken.
    listen: (port) => call(OP_LISTEN, encodeRequest([b(JSON.stringify({ port }))])),
    // Non-blocking accept: returns the next queued request
    // { reqId, port, req:{method,url,headers,body} }, or null if none is queued.
    // The event loop calls this after a `net` wake (kernel postMessage) and drains
    // in a tight loop; it never parks (the kernel replies immediately, empty when
    // the inbox is empty), so the SAB channel stays free for other sync syscalls.
    tryAccept: () => {
      const p = call(OP_ACCEPT, encodeRequest([]));
      return p.length ? JSON.parse(decodeBytes(p)) : null;
    },
    // Reply to a request; unblocks the caller (Service Worker) and lets us loop.
    respond: (reqId, resp) =>
      call(OP_RESPOND, encodeRequest([b(JSON.stringify({ reqId, ...resp }))])),
    closeServer: (port) => call(OP_CLOSE_SERVER, encodeRequest([b(JSON.stringify({ port }))])),
  };
}
