// Debug command channel — a SharedArrayBuffer ABI separate from the syscall SAB.
//
// The breakpoint debugger (packages/runtime/debugger.js) pauses a guest process by
// blocking its Worker thread on `Atomics.wait`, exactly like a sync syscall. While
// paused it must still receive CDP commands (resume/step/evaluate/getProperties)
// from the kernel — but the worker isn't draining postMessages then. So the kernel
// writes commands into THIS buffer and notifies; the parked worker wakes, reads the
// command, and either resumes or answers (via postMessage) and waits again.
//
// Events + responses always flow OUT over postMessage (the sender never needs to
// yield for the receiver). Only the inbound command stream needs the SAB, and only
// while paused; a running worker gets its commands as ordinary postMessages.
//
// Layout:
//   control (2 x Int32 = 8 bytes):
//     control[0] = STATE  (0 = empty/consumed, 1 = command present)  — the futex word
//     control[1] = LEN    (byte length of the command JSON in the data region)
//   data (DBG_DATA_BYTES): the UTF-8 CDP command JSON
//
// Single-producer (kernel) / single-consumer (worker). Environment-agnostic
// (browser Worker or Node worker_threads), like syscall.js.

export const DBG_CTRL_SLOTS = 2;
export const DBG_CTRL_BYTES = DBG_CTRL_SLOTS * 4;
export const DBG_DATA_BYTES = 1 << 18; // 256 KiB — plenty for a single CDP command
export const DBG_SAB_BYTES = DBG_CTRL_BYTES + DBG_DATA_BYTES;

export const DBG_STATE_EMPTY = 0;
export const DBG_STATE_CMD = 1;

const _enc = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
const _dec = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;

export function makeDebugViews(sab) {
  return {
    ctrl: new Int32Array(sab, 0, DBG_CTRL_SLOTS),
    data: new Uint8Array(sab, DBG_CTRL_BYTES, DBG_DATA_BYTES),
  };
}

// Kernel side: try to place one command. Returns false if the slot is still full
// (the worker hasn't consumed the previous one yet) or the payload is too large —
// the caller should retry the former shortly.
export function writeDebugCommand(views, str) {
  const bytes = _enc.encode(str);
  if (bytes.length > views.data.length) return false;
  if (Atomics.load(views.ctrl, 0) !== DBG_STATE_EMPTY) return false;
  views.data.set(bytes, 0);
  Atomics.store(views.ctrl, 1, bytes.length);
  Atomics.store(views.ctrl, 0, DBG_STATE_CMD);
  Atomics.notify(views.ctrl, 0);
  return true;
}

// Worker side: block until a command lands, then return its JSON string. Marks the
// slot empty + notifies so the kernel can send the next one. `timeoutMs` bounds the
// wait (default: block forever, as while paused); returns null on timeout so the
// caller can fall through — used by the --inspect-brk-style start gate so a run
// never hangs when no frontend attaches.
export function readDebugCommandBlocking(views, timeoutMs = Infinity) {
  const deadline = timeoutMs === Infinity ? Infinity : Date.now() + timeoutMs;
  while (Atomics.load(views.ctrl, 0) === DBG_STATE_EMPTY) {
    const remaining = deadline === Infinity ? Infinity : deadline - Date.now();
    if (remaining <= 0) return null;
    if (Atomics.wait(views.ctrl, 0, DBG_STATE_EMPTY, remaining) === "timed-out") return null;
  }
  const len = Atomics.load(views.ctrl, 1);
  const bytes = views.data.slice(0, len);
  Atomics.store(views.ctrl, 0, DBG_STATE_EMPTY);
  Atomics.notify(views.ctrl, 0);
  return _dec.decode(bytes);
}