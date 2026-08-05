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

// Kernel deliveries that arrive BEFORE the runtime exists have to wait, not vanish.
//
// `control` is only assigned in bootProcess()'s onReady, which is several async
// ticks after this worker starts: the runtime has to be constructed and its wasm
// codecs built first. Until then every branch below read `control && …`, so
// anything the kernel sent in that window was silently dropped.
//
// A pipeline is the case that loses: `cat fruit.txt | bun run tools/uniq.ts` spawns
// both stages up front, and `cat` is a tiny coreutils program that finishes almost
// immediately, while the reader is a full runtime boot. The kernel then relays
// `cat`'s EOF to a worker that has no `control` yet — so the reader never sees end
// of input and waits for a chunk that will never come, hanging the whole pipeline.
// It is a race, so it hides wherever workers start fast (Node's worker_threads) and
// shows up where they don't (the browser).
//
// Queue in arrival order and replay on ready. Dropping is never right for any of
// these — they are all one-shot deliveries (an exit, a signal, a fetch result),
// not state that can be re-read later.
const beforeReady = [];
const onControl = (fn) => {
  if (control) fn(control);
  else beforeReady.push(fn);
};
const flushBeforeReady = (c) => {
  const queued = beforeReady.splice(0, beforeReady.length);
  for (const fn of queued) fn(c);
};

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
    ? (mode, level, windowBits, brotliParams) => {
        if (!zReady) {
          codecNs.initSync({ module: codecModule });
          zReady = true;
        }
        // 8/9 are BROTLI_DECODE/BROTLI_ENCODE in node_zlib_mode: the modes the
        // binding serves from the codec's brotli engine, not its zlib one.
        if (mode === 8 || mode === 9) return new codecNs.BrotliStream(mode === 9, brotliParams);
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

// The ONLY way this worker talks back to the kernel — captured once, at load,
// before any guest code exists.
//
// It has to be captured rather than read off `self` at each use, because the runtime
// removes `postMessage` from the global the guest can see (see
// packages/runtime/index.js). In a browser Worker that global is a real channel to
// this worker's creator, which is the KERNEL: guest code could post
// `{type:'thread-spawn'}` straight into the kernel's handler table, and several of
// those handlers threw on a malformed message — taking the whole VM down, since the
// dispatch had no guard. Removing the guest's access closes that door; this binding
// is what keeps ours open. Reading the property lazily instead would mean the
// removal silently killed every stdout byte, exit code and syscall wake this process
// ever sends.
const toKernel: (msg: unknown, transfer?: Transferable[]) => void = self.postMessage.bind(self);

self.onmessage = async (event) => {
  const { type, sab, spec, fsPort, threadPort, codecModule, cryptoModule, debugSab, debugLang } = event.data;
  if (type === "init") {
    selfPid = (spec && spec.pid) | 0;
    const { makeZStream, cryptoCodec } = buildCodecs(codecModule, cryptoModule);
    bootProcess({
      sab,
      spec,
      fsPort, // #14: fs syscalls ring the File System Worker over this port
      threadPort, // #16 stage 2b: our parentPort, if we are a spawned thread
      debugSab, // breakpoint debugger command channel (present under a debug session)
      debugLang, // which backend attaches to it: "js" (instrumented) or "python"
      postRaw: (msg, transfer) => toKernel(msg, transfer || []),
      send: (msgType, extra) => toKernel({ type: msgType, ...extra }),
      onReady: (c) => {
        control = c;
        flushBeforeReady(c);
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
    toKernel({ type: "proc-mem-reply", id: event.data.id, pid: selfPid, heap, ...stats });
    return;
  }
  // Kernel nudge: a network request is queued for us — wake the event loop.
  if (type === "net") onControl((c) => c.wakeNet());
  // An async child's output/exit relayed by the kernel (#15).
  else if (type === "child-stdout" || type === "child-stderr" || type === "child-exit")
    onControl((c) => c.dispatchChild(event.data));
  // A worker_thread's online/exit relayed by the kernel (#16 stage 2b).
  else if (type === "thread-started" || type === "thread-exit")
    onControl((c) => c.dispatchThread(event.data));
  // A browser preview ws tunnel message relayed by the kernel (#19 stage C).
  else if (type === "ws-open" || type === "ws-in" || type === "ws-close")
    onControl((c) => c.dispatchWs(event.data));
  // A browser preview SSE tunnel message relayed by the kernel.
  else if (type === "sse-open" || type === "sse-close")
    onControl((c) => c.dispatchSse(event.data));
  // A cross-process pipe (UNIX socket) message relayed by the kernel.
  else if (type === "pipe-open" || type === "pipe-data" || type === "pipe-shutdown" || type === "pipe-close")
    onControl((c) => c.dispatchPipe(event.data));
  // An interactive stdin chunk for this process (host terminal / parent -> child).
  else if (type === "stdin") onControl((c) => c.dispatchStdin(event.data));
  // A catchable signal (SIGTERM/SIGINT) the kernel is delivering to us.
  else if (type === "signal") onControl((c) => c.dispatchSignal(event.data));
  // An async fetch result relayed by the kernel (parallel downloads).
  else if (type === "fetch-done") onControl((c) => c.dispatchFetch(event.data));
  // A CDP debugger command for this process while it is RUNNING (paused commands
  // arrive over the debug SAB instead). Feeds the in-guest Debugger backend.
  else if (type === "dbg-cmd") onControl((c) => c.dispatchDebugCommand(event.data.data));
};