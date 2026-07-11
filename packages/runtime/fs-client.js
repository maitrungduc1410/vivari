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
  OP_SPAWN_ASYNC,
  OP_KILL,
  OP_LISTEN,
  OP_ACCEPT,
  OP_RESPOND,
  OP_CLOSE_SERVER,
  OP_FETCH,
  OP_WATCH,
  OP_UNWATCH,
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

    // Wake whoever services this opcode. Since #14 the transport is split: fs
    // opcodes are serviced by the dedicated File System Worker over this same
    // SAB, everything else by the kernel. `notify` routes by opcode.
    notify(opcode);
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

    // ---- file watching (roadmap #19 stage B) ----
    // Register interest in `path` with the File System Worker; change events are
    // pushed back over the fs doorbell port (not this SAB). `watchId` is chosen by
    // the caller (per-process unique) so it can later unwatch.
    watch: (watchId, path, recursive) =>
      call(OP_WATCH, encodeRequest([u32ToBytes(watchId), b(path)], recursive ? FLAG_RECURSIVE : 0)),
    unwatch: (watchId) => call(OP_UNWATCH, encodeRequest([u32ToBytes(watchId)])),
    // Spawn a child and block until it exits (waitpid). Returns
    // { code, stdout, stderr, pid }. This is how execSync/spawnSync work.
    spawn: (spec) =>
      JSON.parse(decodeBytes(call(OP_SPAWN, encodeRequest([b(JSON.stringify(spec))])))),
    // Async spawn (Phase 2 #15): returns { pid } immediately without parking. The
    // child's stdout/stderr/exit arrive later as postMessages to this worker; the
    // runtime routes them to the ChildProcess object (see child_process.js).
    spawnAsync: (spec) =>
      JSON.parse(decodeBytes(call(OP_SPAWN_ASYNC, encodeRequest([b(JSON.stringify(spec))])))),
    // Send a signal to a running child. Throws ESRCH if the pid is gone.
    kill: (pid, signal) => {
      call(OP_KILL, encodeRequest([b(JSON.stringify({ pid: pid | 0, signal: signal || "SIGTERM" }))]));
      return true;
    },

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
    // The body crosses as a *raw* length-prefixed field (field1), NOT inside the
    // JSON metadata (field0): JSON-escaping a large text body (every " \\ and
    // newline doubles) can push it past the 1 MiB window and throw. Bodies larger
    // than the window are split into sequential frames the kernel reassembles by
    // reqId (`total` in the metadata marks completion). Frames for one reqId are
    // sent in a tight synchronous loop, so they never interleave with another.
    respond: (reqId, resp) => {
      const body = resp.body == null ? "" : resp.body;
      const bodyBytes = typeof body === "string" ? b(body) : body;
      const meta = b(
        JSON.stringify({
          reqId,
          status: resp.status,
          headers: resp.headers,
          bodyEncoding: resp.bodyEncoding,
          total: bodyBytes.length,
        }),
      );
      // Room for the body in one frame: window minus metadata minus frame headers
      // (8 flags/count + two 4-byte field length prefixes) with a safety margin.
      const room = data.length - meta.length - 64;
      if (bodyBytes.length <= room) {
        call(OP_RESPOND, encodeRequest([meta, bodyBytes]));
        return;
      }
      for (let off = 0; off < bodyBytes.length; off += room) {
        call(OP_RESPOND, encodeRequest([meta, bodyBytes.subarray(off, off + room)]));
      }
    },
    closeServer: (port) => call(OP_CLOSE_SERVER, encodeRequest([b(JSON.stringify({ port }))])),

    // ---- network fetch (Phase 2 #9) ----
    // Blocking fetch: parks until the kernel (via the Fetcher Worker) has streamed
    // the response body into the VFS. Returns { status, statusText, ok, headers,
    // contentType, size, path, cached }; read `path` with fs to get the bytes.
    // Throws on network error.
    //
    // opts (optional): { method, headers, bodyB64 } — the http/https client shim
    // (lib/https.js) passes these so a real ClientRequest can egress. Request body
    // is base64 (JSON can't carry bytes) and must fit the 1 MiB syscall window
    // (fine for registry GET/PUT metadata; large tarball PUT is future work).
    fetch: (url, opts) => {
      const o = opts || {};
      const req = {
        url,
        method: o.method || "GET",
        headers: o.headers || null,
        bodyB64: o.bodyB64 || null,
      };
      return JSON.parse(decodeBytes(call(OP_FETCH, encodeRequest([b(JSON.stringify(req))]))));
    },
  };
}
