// Shared syscall ABI between the worker side (caller) and the host/kernel side.
//
// The whole point of brick #1: user code runs inside a Web Worker and calls
// something that *looks* synchronous (e.g. `readFileSync`). The browser does not
// let you block on async work... except on a Worker thread, where `Atomics.wait`
// can genuinely park the thread. So we encode a request into a shared buffer,
// park the worker, let the host (main thread) service it against the Rust VFS,
// then wake the worker up with the answer already sitting in memory.
//
// Brick #2 grew this into a multi-opcode ABI (stat, mkdir, readdir, ...) with a
// small self-describing request frame, and errno-style error responses.
//
// This module is the single source of truth for the wire format, imported by
// both the kernel host and the runtime. It is environment-agnostic (browser
// Worker or Node worker_threads).
//
// Memory layout of the single SharedArrayBuffer:
//
//   [ control region: 6 x Int32 = 24 bytes ][ data region: N bytes ]
//
//   control[0] = STATE   (the word we Atomics.wait / Atomics.notify on)
//   control[1] = OPCODE  (which syscall)
//   control[2] = REQ_LEN (bytes of request payload in the data region)
//   control[3] = RES_LEN (bytes of response payload in the data region)
//   control[4] = SIGNAL  (pending-signal bitmask, host -> worker; see below)
//   control[5] = —       (reserved; keeps the data region 8-byte aligned)
//
// Request frame inside the data region:
//   [ flags: u32 ][ fieldCount: u32 ]( [ len: u32 ][ bytes ] )*
//
// Response frame:
//   STATE_RESPONSE_OK  -> raw bytes, meaning is opcode-specific
//   STATE_RESPONSE_ERR -> UTF-8 errno code ("ENOENT", "ENOTDIR", ...)

export const CTRL_SLOTS = 6;
export const CTRL_BYTES = CTRL_SLOTS * 4;
export const DATA_BYTES = 1 << 20; // 1 MiB payload window, plenty for the PoC
export const SAB_BYTES = CTRL_BYTES + DATA_BYTES;

// control[0] STATE values
export const STATE_IDLE = 0;
export const STATE_REQUEST = 1; // worker -> host: "please service this"
export const STATE_RESPONSE_OK = 2; // host -> worker: result is in the data region
export const STATE_RESPONSE_ERR = 3; // host -> worker: data region holds an errno

// control[1] OPCODE values
export const OP_READ_FILE = 1;
export const OP_WRITE_FILE = 2;
export const OP_EXISTS = 3;
export const OP_READDIR = 4;
export const OP_MKDIR = 5;
export const OP_STAT = 6;
export const OP_LSTAT = 7;
export const OP_UNLINK = 8;
export const OP_RMDIR = 9;
export const OP_RENAME = 10;
export const OP_SYMLINK = 11;
export const OP_READLINK = 12;
// hard link (Phase — memory). field0 = existing path, field1 = new link path.
// Makes `newpath` an additional name for the SAME inode as `existing` (no byte
// copy), so pnpm's store↔node_modules linking stops doubling node_modules in the
// VFS's Wasm RAM. A build whose wasm predates VFS.link answers ENOSYS and the
// runtime falls back to a content copy (unchanged behaviour). -> OK empty.
export const OP_LINK = 19;

// file-descriptor layer (Phase 2 #4). These back Node's real lib/fs.js, which
// routes even readFileSync through open -> fstat -> read -> close on real fds.
//   OP_OPEN      field0=path, field1=i32 flags, field2=u32 mode -> OK u32 fd
//   OP_CLOSE     field0=u32 fd                                  -> OK empty
//   OP_FD_READ   field0=u32 fd, field1=u32 len, field2=f64 pos  -> OK raw bytes
//   OP_FD_WRITE  field0=u32 fd, field1=f64 pos, field2=bytes    -> OK u32 nwritten
//   OP_FSTAT     field0=u32 fd                                  -> OK JSON stat
//   OP_FTRUNCATE field0=u32 fd, field1=u32 len                  -> OK empty
// pos < 0 means "at the fd cursor" (and advance it); pos >= 0 is positional.
export const OP_OPEN = 13;
export const OP_CLOSE = 14;
export const OP_FD_READ = 15;
export const OP_FD_WRITE = 16;
export const OP_FSTAT = 17;
export const OP_FTRUNCATE = 18;

// process control (brick 4). OP_SPAWN blocks the caller until the child exits;
// the single field is a JSON spec {command,args,cwd,env,capture} and the OK
// response is JSON {code,stdout,stderr,pid}. This is how execSync/spawnSync work:
// the parent parks on Atomics.wait while the kernel drives the child to exit.
export const OP_SPAWN = 20;

// async process control (Phase 2 #15). Unlike OP_SPAWN, these DO NOT park the
// caller: the caller stays in its event loop so it can stream the child's output
// and react to exit — the model behind child_process.spawn() and a dev server
// launched by `npm run`.
//   OP_SPAWN_ASYNC  field0 = JSON {command,args,cwd,env} -> OK JSON {pid} (now)
//   OP_KILL         field0 = JSON {pid,signal}           -> OK empty / ERR ESRCH
// The child's stdout/stderr and its exit are delivered to the *parent worker* out
// of band, as postMessages the kernel sends to the parent's handle (never over
// this SAB — the parent isn't blocked on it): { type:'child-stdout'|'child-stderr',
// childPid, chunk } and { type:'child-exit', childPid, code, signal }.
export const OP_SPAWN_ASYNC = 26;
export const OP_KILL = 27;

// virtual network (brick 5). A server process registers a port (OP_LISTEN),
// then blocks on OP_ACCEPT until the kernel hands it the next HTTP request; it
// replies with OP_RESPOND, which unblocks whoever issued the request (the
// Service Worker, via the kernel). OP_ACCEPT is a *deferred* syscall: the kernel
// keeps the process parked on Atomics.wait until a request actually arrives —
// this blocking accept loop is the process's synchronous "event loop".
//   OP_LISTEN       field0 = JSON {port}                -> OK empty
//   OP_ACCEPT       (no fields)                         -> OK JSON {reqId,port,req}
//   OP_RESPOND      field0 = JSON {reqId,status,headers,bodyEncoding,total},
//                   field1 = raw body chunk -> OK empty. A body larger than the
//                   1 MiB window arrives as several sequential frames (same field0
//                   metadata) the kernel reassembles by reqId until `total` bytes.
//   OP_CLOSE_SERVER field0 = JSON {port}                -> OK empty
export const OP_LISTEN = 21;
export const OP_ACCEPT = 22;
export const OP_RESPOND = 23;
export const OP_CLOSE_SERVER = 24;

// file watching (roadmap #19 stage B). A process registers interest in a path
// with the File System Worker; the worker then *pushes* change events back over
// the same doorbell MessagePort (never the SAB — the process isn't parked on it):
//   { type:'fs-watch', watchId, event:'rename'|'change', filename }.
// Registration itself is an ordinary (fs-routed) SAB syscall so it's serviced by
// the worker that owns the VFS and can see every client's mutations.
//   OP_WATCH    field0 = u32 watchId, field1 = path; flag FLAG_RECURSIVE -> OK empty
//   OP_UNWATCH  field0 = u32 watchId                                     -> OK empty
export const OP_WATCH = 28;
export const OP_UNWATCH = 29;

// network fetch (Phase 2 #9). A *deferred* syscall like OP_SPAWN: the caller
// parks on Atomics.wait while the kernel delegates the actual fetch to the
// Fetcher Worker, streams the body straight into the VFS (bypassing the 1 MiB
// SAB window entirely), and only then wakes the caller with small JSON metadata.
//   OP_FETCH  field0 = JSON {url} -> OK JSON {status,ok,contentType,size,path,cached}
// The body lives at `path` in the VFS; the caller reads it back with normal fs
// (chunked fd reads), so arbitrary-size downloads (npm tarballs) work.
export const OP_FETCH = 25;

// async network fetch (parallel downloads). Unlike OP_FETCH, this DOES NOT park
// the caller on the result: the kernel acknowledges receipt immediately (empty
// OK) so the caller keeps running its event loop and can issue more fetches,
// then delivers each outcome out of band as a postMessage to the caller's worker
// (never over this SAB — the caller isn't parked on it):
//   { type:'fetch-done', fetchId, ok:true,  meta:{status,ok,headers,size,path,cached} }
//   { type:'fetch-done', fetchId, ok:false, error:'<code>' }
// `fetchId` is chosen by the caller (per-process unique) so it can match the
// async reply back to its pending request. This is what lets a single process
// (e.g. the real npm) keep many packument/tarball downloads in flight at once
// instead of one-at-a-time.
//   OP_FETCH_ASYNC  field0 = JSON {fetchId,url,method,headers,bodyB64} -> OK empty (now)
export const OP_FETCH_ASYNC = 30;

// cross-process UNIX-domain sockets / named pipes. A pipe server registers its
// socket path with the kernel (OP_PIPE_LISTEN); a client in ANOTHER process
// resolves that path to a live connection id (OP_PIPE_CONNECT). Once connected,
// raw bytes flow OUT OF BAND (never this SAB — neither side is parked on it) as
// postMessages the kernel relays between the two processes, keyed by connId:
//   { type:'pipe-open',  connId, path }         kernel -> server (accept it)
//   { type:'pipe-data',  connId, chunk }        peer   -> peer   (bytes)
//   { type:'pipe-shutdown', connId }            peer   -> peer   (half-close/EOF)
//   { type:'pipe-close', connId }               peer   -> peer   (teardown)
// This is what lets a tool that forks a worker and talks to it over a UNIX
// socket work in-VM — e.g. Nuxt/Nitro's dev server (its SSR worker <-> the main
// process over `*.sock`) and vite-node's module socket.
//   OP_PIPE_LISTEN        field0 = JSON {path} -> OK empty / ERR EADDRINUSE
//   OP_PIPE_CONNECT       field0 = JSON {path} -> OK JSON {connId} / ERR ENOENT
//   OP_PIPE_CLOSE_SERVER  field0 = JSON {path} -> OK empty
// metadata writes (chmod/utimes). Both take a path, a f64 flag for "follow a
// trailing symlink" (chmod vs lchmod, utimes vs lutimes) and land on the inode.
// Before these existed the calls were accepted and discarded, so stat() reported
// a mode and an mtime nobody had set: `chmod(f, 0o755)` then `access(f, X_OK)`
// threw, and an unpacked archive lost every executable bit.
//   OP_CHMOD   field0 = path, field1 = u32 mode, field2 = u32 follow  -> OK empty
//   OP_UTIMES  field0 = path, field1 = f64 atimeMs, field2 = f64 mtimeMs,
//              field3 = u32 follow                                    -> OK empty
//   OP_FCHMOD  field0 = u32 fd, field1 = u32 mode                     -> OK empty
//   OP_FUTIMES field0 = u32 fd, field1 = f64 atimeMs, field2 = f64 mtimeMs
//                                                                     -> OK empty
// 35-38, not 34-37: OP_READ_STDIN took 34 while this branch was in review, and two
// features numbering the same opcode is a collision no type can catch — the request
// would have been routed to the FS worker or to the kernel depending on which
// constant the caller happened to import. spike-python-offline.mjs asserts 34 is
// stdin's alone, which is what found it. Keep them contiguous: isFsOpcode() below
// tests the range, and 34 has to stay outside it.
export const OP_CHMOD = 35;
export const OP_UTIMES = 36;
export const OP_FCHMOD = 37;
export const OP_FUTIMES = 38;

export const OP_PIPE_LISTEN = 31;
export const OP_PIPE_CONNECT = 32;
export const OP_PIPE_CLOSE_SERVER = 33;

// BLOCKING read of this process's stdin. A *deferred* syscall like OP_SPAWN and
// OP_FETCH: the caller parks on Atomics.wait and the kernel wakes it when a
// chunk arrives — from a terminal's keystrokes, or from a parent writing to a
// child's stdin.
//   OP_READ_STDIN  field0 = JSON {} -> OK raw bytes, or OK EMPTY for end of input
//
// WHY THIS EXISTS WHEN STDIN ALREADY WORKS. Everywhere else stdin is a flowing
// stream: the kernel postMessages chunks in and the runtime delivers them on a
// loop turn, which is what Node wants and what a `node` REPL uses. But a
// synchronous reader cannot turn the loop — it has to have the bytes when it
// returns. CPython under WebAssembly is exactly that: `input()` is a C-level
// read, so is pdb's prompt, and Pyodide asks for them through a callback that
// must return a string THERE AND THEN. Without this opcode the only honest
// answer was end-of-input, which is why `input()` used to refuse.
//
// Zero bytes means end of input, as a read(2) of zero does; the caller turns it
// into whatever its language calls that (an EOFError, for Python).
//
// The kernel starts buffering a process's stdin the first time it makes this
// call, rather than posting it into the flowing stream — otherwise anything
// typed between two reads would be delivered to a stream nobody is reading and
// lost. A process that never makes this call is completely unaffected.
export const OP_READ_STDIN = 34;

// request flags (bitmask)
export const FLAG_RECURSIVE = 1; // mkdir -p

// Which opcodes are pure filesystem ops. Phase 2 #14 splits the Wasm VFS into a
// dedicated File System Worker: a process routes these directly to that worker's
// SAB doorbell, while everything else (spawn/net/http/fetch) still goes to the
// kernel. The two contiguous ranges are OP_READ_FILE..OP_READLINK (whole-file +
// metadata) and OP_OPEN..OP_FTRUNCATE (the fd layer).
export function isFsOpcode(op) {
  return (
    (op >= OP_READ_FILE && op <= OP_READLINK) ||
    (op >= OP_OPEN && op <= OP_FTRUNCATE) ||
    op === OP_LINK ||
    op === OP_WATCH ||
    op === OP_UNWATCH ||
    (op >= OP_CHMOD && op <= OP_FUTIMES)
  );
}

// control[0..5] indices, named for clarity
export const I_STATE = 0;
export const I_OPCODE = 1;
export const I_REQ_LEN = 2;
export const I_RES_LEN = 3;
export const I_SIGNAL = 4;
// control[5]'s FIRST BYTE, aliased. The pending-signal bitmask above is only
// observed by JS — at a syscall park, or on an event-loop turn — and a guest
// running CPython/Wasm is doing neither: the worker thread is inside the
// interpreter's eval loop, which will not return to JS until the Python code
// finishes. That is why Ctrl-C used to be able to do nothing but kill a python
// process outright.
//
// CPython's Emscripten build polls a byte of shared memory for exactly this
// reason (`Py_EmscriptenSignalBuffer`, driven by `pyodide.setInterruptBuffer`):
// the value 2 means SIGINT, and the interpreter raises `KeyboardInterrupt` at
// the next bytecode boundary and clears the byte itself. So SIGINT is *also*
// mirrored here as a byte, in the one format a running interpreter can see.
//
// Byte order is not a portability question here: Wasm is little-endian by
// specification, so the low byte of slot 5 is byte 20 everywhere this runs.
// A guest with no interpreter never reads it, and writing it costs one store.
export const I_INTERRUPT_BYTE = 20;
// The value CPython understands. Not our SIGINT bit, which happens to be the
// same number today — that is a coincidence, and they mean different things.
export const INTERRUPT_SIGINT = 2;

// ---- signals ---------------------------------------------------------------
// A catchable signal has to reach a guest that may be parked in `Atomics.wait`
// half-way through a syscall — where it is, by construction, not draining its
// message queue (the same reason the breakpoint debugger has its own SAB
// channel, see kernel.js). So the pending set lives in shared memory: the host
// ORs the bit into control[4] and notifies control[0], which is the word the
// parked caller is already waiting on. The caller wakes spuriously (no response
// yet), harvests the bits, and re-parks — so the signal is *observed* during the
// park even though it can only be *delivered* on the next event-loop turn.
//
// It is a bitmask, not a value, because Unix pending signals are a SET: two
// SIGTERMs before the process gets a turn collapse into one, which is exactly
// what `Atomics.or` gives us for free. SIGKILL is deliberately absent — it is
// not deliverable to the guest at all, the kernel just terminates the worker.
export const SIGNAL_BITS = {
  SIGHUP: 1 << 0,
  SIGINT: 1 << 1,
  SIGQUIT: 1 << 2,
  SIGTERM: 1 << 3,
  SIGUSR1: 1 << 4,
  SIGUSR2: 1 << 5,
};

/** Can a guest handler intercept `name`? (SIGKILL and anything unknown: no.) */
export function isCatchableSignal(name) {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(SIGNAL_BITS, name);
}

/**
 * Exit code a process gets when a signal is applied to it rather than handled.
 * These are the codes the kernel has always used; graceful exits do not come
 * through here (the process picks its own).
 */
export function defaultSignalExitCode(name) {
  return name === "SIGKILL" ? 137 : 143;
}

/**
 * Host side: mark `name` pending for the process owning `ctrl` and wake it if it
 * is parked. Returns false for a signal that is not deliverable.
 */
export function postSignal(ctrl, name) {
  const bit = SIGNAL_BITS[name];
  if (!bit) return false;
  Atomics.or(ctrl, I_SIGNAL, bit);
  // …and, for SIGINT, in the byte a busy interpreter polls. Both, because the
  // two are read by different things at different times: the interpreter reacts
  // to the byte within milliseconds, and the guest's own JS still gets the
  // signal event on its next turn.
  if (name === "SIGINT") interruptView(ctrl.buffer)[0] = INTERRUPT_SIGINT;
  Atomics.notify(ctrl, I_STATE);
  return true;
}

/**
 * The one-byte window CPython polls, over an existing syscall SAB. Handed to
 * `pyodide.setInterruptBuffer`; the interpreter clears it when it acts on it.
 */
export function interruptView(sab) {
  return new Uint8Array(sab, I_INTERRUPT_BYTE, 1);
}

/**
 * Guest side: atomically take (and clear) the pending set. Returns an array of
 * signal names, or null when nothing was pending — the common case, so callers
 * on the syscall hot path pay one atomic load-and-clear and nothing else.
 */
export function takePendingSignals(ctrl) {
  const bits = Atomics.exchange(ctrl, I_SIGNAL, 0);
  if (!bits) return null;
  const names = [];
  for (const name of Object.keys(SIGNAL_BITS)) {
    if (bits & SIGNAL_BITS[name]) names.push(name);
  }
  return names.length ? names : null;
}

const encoder = new TextEncoder();
// `ignoreBOM` because the default strips a leading U+FEFF, and a decoder that
// silently eats bytes is a corruption source: an HTTP body served from a
// BOM-prefixed file crossed this seam three bytes shorter than it left. Frames
// are machine-generated, so nothing here ever carries a BOM it wants removed.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** Build the two typed-array views over a shared buffer. */
export function makeViews(sab) {
  return {
    ctrl: new Int32Array(sab, 0, CTRL_SLOTS),
    data: new Uint8Array(sab, CTRL_BYTES, DATA_BYTES),
  };
}

export function encodeString(str) {
  return encoder.encode(str);
}

// Little-endian scalar fields, used by the fd syscalls to carry fds/lengths/
// positions without stringifying them. `f64` covers file positions > 2^32 and
// the sentinel -1 ("use the current cursor").
export function u32ToBytes(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}
export function bytesToU32(b) {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true);
}
export function f64ToBytes(n) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, n, true);
  return b;
}
export function bytesToF64(b) {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat64(0, true);
}

export function decodeBytes(bytes) {
  return decoder.decode(bytes);
}

/** Encode a request frame: a flags word + N length-prefixed byte fields. */
export function encodeRequest(fields, flags = 0) {
  let total = 8;
  for (const f of fields) total += 4 + f.length;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, flags, true);
  dv.setUint32(4, fields.length, true);
  let off = 8;
  for (const f of fields) {
    dv.setUint32(off, f.length, true);
    off += 4;
    buf.set(f, off);
    off += f.length;
  }
  return buf;
}

// ---- thread parking, on its own (no syscall involved) -----------------------
// The `Atomics.wait` park described at the top of this file is the mechanism the
// whole sync bridge stands on, but it was only ever reachable as a side effect of
// issuing a syscall. Some callers want the park WITHOUT a request — a blocking
// sleep (`Bun.sleepSync`) is the obvious one. The alternative, a `while
// (Date.now() < end);` spin, holds the core at 100% and starves nothing but
// itself; on a one-worker-per-process kernel that is a whole CPU burnt to do
// nothing. So the primitive is exported here, next to the ABI it belongs to,
// rather than re-derived by each caller.
//
// The word is private to this module and nobody ever notifies it, so a wait on it
// can only end by timing out — which is precisely a sleep.
let parkWord = null;
let parkAllowed = null; // null = not probed yet

/**
 * Whether this thread may block in `Atomics.wait` at all. TRUE on a Web Worker
 * and on Node's main thread; FALSE on a browser's main thread, where the call is
 * a TypeError ("Atomics.wait cannot be called in this context"), and on any host
 * without SharedArrayBuffer (no cross-origin isolation). Probed once with a
 * zero-length wait — there is no feature flag to read, only the throw.
 */
export function canPark() {
  if (parkAllowed !== null) return parkAllowed;
  parkAllowed = false;
  try {
    if (
      typeof SharedArrayBuffer === "function" &&
      typeof Atomics !== "undefined" &&
      typeof Atomics.wait === "function"
    ) {
      parkWord = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(parkWord, 0, 0, 0); // returns "timed-out", or throws here
      parkAllowed = true;
    }
  } catch {
    parkAllowed = false; // main thread (or no SAB): the caller must do something else
  }
  return parkAllowed;
}

/**
 * Park this thread for `ms` milliseconds without burning CPU. Returns true if it
 * really parked, and FALSE — immediately, having done nothing — when parking is
 * unavailable, so the caller can fall back rather than be left thinking it slept.
 * A `false` that a caller ignored would be a silent wrong answer (a sleep that
 * did not sleep), which is why this reports instead of throwing or spinning here.
 *
 * The loop re-checks the clock because `Atomics.wait` may return early: a wake is
 * impossible on our private word, but a host that clamps the timeout is not.
 */
export function parkFor(ms) {
  if (!(ms > 0)) return canPark(); // nothing to wait for; still report capability
  if (!canPark()) return false;
  const deadline = Date.now() + ms;
  for (let left = ms; left > 0; left = deadline - Date.now()) {
    Atomics.wait(parkWord, 0, 0, left);
  }
  return true;
}

/** Decode a request frame back into { flags, fields: Uint8Array[] }. */
export function decodeRequest(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = dv.getUint32(0, true);
  const count = dv.getUint32(4, true);
  const fields = [];
  let off = 8;
  for (let i = 0; i < count; i++) {
    const len = dv.getUint32(off, true);
    off += 4;
    fields.push(bytes.subarray(off, off + len));
    off += len;
  }
  return { flags, fields };
}