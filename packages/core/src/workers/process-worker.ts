// @ts-nocheck — authored in TS for Vite's native worker bundling, but not strictly
// type-checked: it boots the untyped Node runtime (packages/runtime) + generated wasm
// codecs. esbuild (via Vite) is the compiler; strict typing is a separate effort.
// Browser worker entry for a single process. Waits for the kernel's `init`
// message, then boots the runtime and runs the program. Later `net` messages
// from the kernel nudge the process event loop when a request is queued.

import { bootProcess } from "../../../runtime/boot.js";
import * as codecNs from "../../../codec/pkg/vivari_codec.js";
import * as cryptoNs from "../../../crypto/pkg/vivari_crypto.js";

// In a real Worker, `self` is a getter-only accessor on WorkerGlobalScope, so a
// third-party global shim — e.g. `Object.assign(globalThis, { self, window,
// global, ... })`, which Vite/rolldown runs in a worker it spawns — throws
// "Cannot set property self ... which has only a getter". Node makes `self`
// writable, so mirror that here: shadow the prototype accessor with an OWN
// writable data property (value is still globalThis, so nothing changes except
// that assigning to it now works). Only `self` needs this; `window`/`global` are
// absent in a worker, so the shim's own writes to them succeed on their own.
try {
  Object.defineProperty(globalThis, "self", {
    value: globalThis,
    writable: true,
    enumerable: false,
    configurable: true,
  });
} catch {
  /* environment doesn't allow it — leave the native accessor in place */
}

let control = null;

// [optimize] Native codecs (Phase 2 #11 zlib, #12 crypto): the Rust/Wasm cores
// beneath Node's real lib/zlib.js and our lib/crypto.js. The kernel worker
// compiled the wasm ONCE and handed us the `WebAssembly.Module`s; here we only
// *instantiate* them — and only LAZILY, on the first real zlib/crypto call.
// initSync from a pre-compiled Module is sync and allowed in a Worker (which
// already blocks on Atomics.wait), so gzipSync/createHash keep working. A
// process that never compresses/hashes instantiates neither (0 fetch/compile).
function buildCodecs(codecModule, cryptoModule) {
  // zlib: internalBinding('zlib') calls makeZStream() the first time a
  // gzip/deflate stream is created (never at boot).
  let zReady = false;
  const makeZStream = codecModule
    ? (mode, level, windowBits) => {
        if (!zReady) {
          codecNs.initSync({ module: codecModule });
          zReady = true;
        }
        return new codecNs.ZStream(mode, level, windowBits);
      }
    : null;

  // crypto: internalBinding('crypto') reads codec.digest/hmac_digest/... on
  // demand. Wrap the wasm namespace so the module instantiates on first call.
  let cReady = false;
  const ensureCrypto = () => {
    if (!cReady) {
      cryptoNs.initSync({ module: cryptoModule });
      cReady = true;
    }
  };
  const cryptoCodec = cryptoModule
    ? new Proxy(
        {},
        {
          get(_t, prop) {
            if (typeof prop === "symbol" || !(prop in cryptoNs)) return undefined;
            const v = cryptoNs[prop];
            if (typeof v !== "function") {
              ensureCrypto();
              return cryptoNs[prop];
            }
            return (...args) => {
              ensureCrypto();
              return cryptoNs[prop](...args);
            };
          },
        },
      )
    : null;

  return { makeZStream, cryptoCodec };
}

let selfPid = -1;

self.onmessage = async (event) => {
  const { type, sab, spec, fsPort, threadPort, codecModule, cryptoModule, debugSab } = event.data;
  if (type === "init") {
    selfPid = (spec && spec.pid) | 0;
    const { makeZStream, cryptoCodec } = buildCodecs(codecModule, cryptoModule);
    bootProcess({
      sab,
      spec,
      fsPort, // #14: fs syscalls ring the File System Worker over this port
      threadPort, // #16 stage 2b: our parentPort, if we are a spawned thread
      debugSab, // breakpoint debugger command channel (present under a debug session)
      postRaw: (msg, transfer) => self.postMessage(msg, transfer || []),
      send: (msgType, extra) => self.postMessage({ type: msgType, ...extra }),
      onReady: (c) => {
        control = c;
      },
      codec: makeZStream,
      cryptoCodec,
    });
    return;
  }
  // Diagnostic (studio "Measure Memory"): report THIS worker's own JS heap plus
  // its runtime retention stats (guest module-cache size, esbuild-wasm resident).
  // `performance.memory` is Chrome-only and coarse, but enough to attribute which
  // Process Worker holds the big heap; -1 when unavailable.
  if (type === "proc-mem") {
    let heap = -1;
    try {
      if (self.performance && performance.memory) heap = performance.memory.usedJSHeapSize;
    } catch {
      /* not available in this engine */
    }
    const stats = control && control.memStats ? control.memStats() : { modules: -1, esbuildInproc: false };
    self.postMessage({ type: "proc-mem-reply", id: event.data.id, pid: selfPid, heap, ...stats });
    return;
  }
  // Kernel nudge: a network request is queued for us — wake the event loop.
  if (type === "net") control && control.wakeNet();
  // An async child's output/exit relayed by the kernel (#15).
  else if (type === "child-stdout" || type === "child-stderr" || type === "child-exit")
    control && control.dispatchChild(event.data);
  // A worker_thread's online/exit relayed by the kernel (#16 stage 2b).
  else if (type === "thread-started" || type === "thread-exit")
    control && control.dispatchThread(event.data);
  // A browser preview ws tunnel message relayed by the kernel (#19 stage C).
  else if (type === "ws-open" || type === "ws-in" || type === "ws-close")
    control && control.dispatchWs(event.data);
  // A browser preview SSE tunnel message relayed by the kernel.
  else if (type === "sse-open" || type === "sse-close")
    control && control.dispatchSse(event.data);
  // A cross-process pipe (UNIX socket) message relayed by the kernel.
  else if (type === "pipe-open" || type === "pipe-data" || type === "pipe-shutdown" || type === "pipe-close")
    control && control.dispatchPipe(event.data);
  // An interactive stdin chunk for this process (host terminal / parent -> child).
  else if (type === "stdin") control && control.dispatchStdin(event.data);
  // A catchable signal (SIGTERM/SIGINT) the kernel is delivering to us.
  else if (type === "signal") control && control.dispatchSignal(event.data);
  // An async fetch result relayed by the kernel (parallel downloads).
  else if (type === "fetch-done") control && control.dispatchFetch(event.data);
  // A CDP debugger command for this process while it is RUNNING (paused commands
  // arrive over the debug SAB instead). Feeds the in-guest Debugger backend.
  else if (type === "dbg-cmd") control && control.dispatchDebugCommand(event.data.data);
};