// Node worker_threads entry for a single process (used by the headless test and
// as the Node-side twin of the browser's packages/studio/src/workers/process-worker.js).

import { parentPort, markAsUntransferable } from "node:worker_threads";
import { createRequire } from "node:module";
import * as hostAsyncHooks from "node:async_hooks";

// A browser realm, planted on purpose (spike-realm sets the variable), BEFORE the
// runtime is imported — its capture of "what was here before us" happens at module
// load, so anything planted after would look like ours and never be swept.
//
// In a browser this worker's global is a DedicatedWorkerGlobalScope carrying
// `importScripts`, the origin's storage, and the kernel's own message channel; a
// Node worker has none of them, so nothing here could tell a working sweep from a
// sweep that never ran. This gives it something to find. The shapes are the
// measured ones — some own, some inherited, some accessors — because those are
// what decide whether hiding a name works at all (see packages/runtime/realm.js).
if (process.env.VV_PLANT_BROWSER_REALM) {
  const proto = Object.create(Object.getPrototypeOf(globalThis));
  for (const name of ["addEventListener", "removeEventListener", "importScripts", "close"]) {
    Object.defineProperty(proto, name, { value: () => "host:" + name, writable: true, configurable: true });
  }
  for (const name of ["location", "indexedDB", "caches", "origin", "crossOriginIsolated"]) {
    Object.defineProperty(proto, name, { get: () => "host:" + name, configurable: true });
  }
  Object.setPrototypeOf(globalThis, proto);
  for (const name of ["XMLHttpRequest", "OffscreenCanvas", "FileReader", "postMessage"]) {
    Object.defineProperty(globalThis, name, { value: () => "host:" + name, writable: true, configurable: true });
  }
}

const { bootProcess } = await import("../packages/runtime/boot.js");

// A browser hazard, planted on purpose (spike-fatal-errors sets the variable).
// In a browser this worker HAS a global `postMessage`, wired to the kernel, so guest
// code could post into the kernel's handler table; a Node worker has no such global,
// which is why nothing here could tell whether the runtime removes the guest's
// access or whether the name was simply never there. This gives it something to
// remove. Env-gated, so no ordinary run has a stray global postMessage for a
// feature-detecting dependency to find.
if (process.env.VV_PLANT_KERNEL_MAILBOX) globalThis.postMessage = () => "guest reached the kernel";

// Native codecs (Phase 2 #11 zlib, #12 crypto): the Rust/Wasm cores. nodejs
// target loads synchronously via require (which also compiles the wasm), so we
// [optimize] defer that require until first real use — a process that never
// compresses/hashes never compiles the codec. require.resolve only resolves the
// path (no compile), so we can still detect an unbuilt codec up front.
const require = createRequire(import.meta.url);
const CODEC_MOD = "../packages/codec/pkg-node/vivari_codec.js";
const CRYPTO_MOD = "../packages/crypto/pkg-node/vivari_crypto.js";

// BROTLI_DECODE / BROTLI_ENCODE in node_zlib_mode: the two modes the binding
// serves from the codec's brotli engine rather than its zlib one.
const BROTLI_MODES = new Set([8, 9]);

let makeZStream = null;
try {
  require.resolve(CODEC_MOD); // built? (throws if not — no compile either way)
  let codec = null;
  makeZStream = (mode, level, windowBits, brotliParams) => {
    if (!codec) codec = require(CODEC_MOD);
    if (BROTLI_MODES.has(mode)) return new codec.BrotliStream(mode === 9, brotliParams);
    return new codec.ZStream(mode, level, windowBits);
  };
} catch {
  // codec not built — zlib stays unavailable (crc32/constants still work).
}

let cryptoCodec = null;
try {
  require.resolve(CRYPTO_MOD); // built? (throws if not)
  let ns = null;
  const ensure = () => ns || (ns = require(CRYPTO_MOD));
  cryptoCodec = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === "symbol") return undefined;
        const mod = ensure();
        const v = mod[prop];
        return typeof v === "function" ? (...a) => mod[prop](...a) : v;
      },
    },
  );
} catch {
  // codec not built — md5/sha1/sha256 fall back to pure-JS.
}

let control = null;
let selfPid = 0;

// Read at module load, while `process` is still NODE's. bootProcess replaces
// globalThis.process with the GUEST's, whose env is just the spec's (HOME/PATH/PWD)
// — so a `process.env.VV_*` check inside onReady silently reads the wrong object and
// the flag never appears to be set. Cost me three inert test seams before I noticed.
const HOST_ENV = { ...process.env };

// Kernel deliveries that arrive BEFORE the runtime exists have to wait, not vanish.
// The browser twin (packages/core/src/workers/process-worker.ts) carries the full
// explanation; the short version is that `control` is only assigned in onReady, and
// a pipeline whose writer finishes before the reader has booted had its EOF dropped,
// hanging the reader forever.
//
// Kept in lockstep with that twin, but be clear about what this tier can prove:
// NOTHING. bootProcess() reaches onReady synchronously here, so the pre-ready window
// never opens and no spike can fail without this queue — measured, not assumed, by
// deleting the queue and watching the test still pass. That is exactly why the bug
// shipped: every gate we own runs on the end of the race that wins. The proof for
// this one is a browser.
const beforeReady = [];
const onControl = (fn) => {
  if (control) fn(control);
  else beforeReady.push(fn);
};
const flushBeforeReady = (c) => {
  const queued = beforeReady.splice(0, beforeReady.length);
  for (const fn of queued) fn(c);
};
parentPort.on("message", (msg) => {
  if (msg.type === "init") {
    selfPid = (msg.spec && msg.spec.pid) | 0;
    bootProcess({
      sab: msg.sab,
      spec: msg.spec,
      fsPort: msg.fsPort, // #14: fs syscalls ring the File System Worker over this port
      threadPort: msg.threadPort, // #16 stage 2b: our parentPort, if we are a thread
      postRaw: (m, transfer) => parentPort.postMessage(m, transfer || []),
      send: (type, extra) => parentPort.postMessage({ type, ...extra }),
      onReady: (c) => {
        control = c;
        flushBeforeReady(c);
        // VV_SIMULATE_DEV_HMR_PING=1 reproduces what a Vite dev server does to a
        // Process Worker. Its HMR client shares these globals and, once its
        // WebSocket opens, arms `setInterval(ping, 3e4)` — which by then is the
        // runtime's, so the ping lands in the GUEST's loop as a ref'd timer and no
        // guest that merely finishes can ever exit.
        //
        // Two details are load-bearing, both learned from getting them wrong. The
        // ping is armed LATE, from the client's async `connect`, well after the
        // guest's entry has started — an earlier version of this seam armed it in
        // onReady, which a fix that only ran before the entry appeared to pass. And
        // the fix keys on the CALLER's frame, so the simulated ping has to come from
        // a `/@vite/client` frame; `sourceURL` is what puts one in the stack. There
        // is no HMR client in this tier, so the bug is otherwise unobservable here.
        // `=early` covers the other defence instead: a host handle armed BEFORE the
        // entry, from an ordinary frame the `/@vite/client` match would not catch.
        // That is what loop.disownExistingHandles() is for, and without a case of
        // its own it is untested code.
        if (HOST_ENV.VV_SIMULATE_DEV_HMR_PING === "early") {
          globalThis.setInterval(() => {}, 30000);
        } else if (HOST_ENV.VV_SIMULATE_DEV_HMR_PING) {
          const armPing = new Function(
            "return setInterval(() => {}, 30000);\n//# sourceURL=http://localhost:5173/@vite/client",
          );
          setTimeout(armPing, 250);
        }
      },
      codec: makeZStream,
      cryptoCodec,
      // Real AsyncLocalStorage (V8 PromiseHook) for cross-await context — Next.js
      // App Router (RSC) workStore. The browser twin has no equivalent binding and
      // uses the runtime's best-effort polyfill instead; set VV_NO_HOST_ALS=1 to
      // force that polyfill here and exercise the browser path headlessly.
      hostAsyncHooks: process.env.VV_NO_HOST_ALS ? null : hostAsyncHooks,
      // Real worker_threads.markAsUntransferable so the runtime's Buffer pool can be
      // marked untransferable to the *platform's* postMessage — otherwise a guest
      // transferring a pooled Buffer's .buffer would detach (corrupt) the whole pool.
      hostMarkUntransferable: markAsUntransferable,
    });
    return;
  }
  // Diagnostic twin of the browser worker's "proc-mem": report this worker's
  // runtime stats, including the `alive` breakdown that names which handles are
  // holding the event loop. Mirrored here so the diagnostic can be exercised
  // headlessly — the browser is otherwise the only place it can be read, and a
  // diagnostic nobody can test is one that quietly reports nothing.
  if (msg.type === "proc-mem") {
    const heap = typeof process.memoryUsage === "function" ? process.memoryUsage().heapUsed : -1;
    const stats = control && control.memStats ? control.memStats() : { modules: -1, esbuildInproc: false };
    parentPort.postMessage({ type: "proc-mem-reply", id: msg.id, pid: selfPid, heap, ...stats });
    return;
  }
  // Kernel nudge: a network request is queued for us — wake the event loop.
  if (msg.type === "net") onControl((c) => c.wakeNet());
  // An async child's output/exit relayed by the kernel (#15).
  else if (msg.type === "child-stdout" || msg.type === "child-stderr" || msg.type === "child-exit")
    onControl((c) => c.dispatchChild(msg));
  // A worker_thread's online/exit relayed by the kernel (#16 stage 2b).
  else if (msg.type === "thread-started" || msg.type === "thread-exit")
    onControl((c) => c.dispatchThread(msg));
  // A browser preview ws tunnel message relayed by the kernel (#19 stage C).
  else if (msg.type === "ws-open" || msg.type === "ws-in" || msg.type === "ws-close")
    onControl((c) => c.dispatchWs(msg));
  // A browser preview SSE tunnel message relayed by the kernel.
  else if (msg.type === "sse-open" || msg.type === "sse-close")
    onControl((c) => c.dispatchSse(msg));
  // A cross-process pipe (UNIX socket) message relayed by the kernel.
  else if (msg.type === "pipe-open" || msg.type === "pipe-data" || msg.type === "pipe-shutdown" || msg.type === "pipe-close")
    onControl((c) => c.dispatchPipe(msg));
  // An interactive stdin chunk for this process (host terminal / parent -> child).
  else if (msg.type === "stdin") onControl((c) => c.dispatchStdin(msg));
  // A catchable signal (SIGTERM/SIGINT) the kernel is delivering to us.
  else if (msg.type === "signal") onControl((c) => c.dispatchSignal(msg));
  // An async fetch result relayed by the kernel (parallel downloads).
  else if (msg.type === "fetch-done") onControl((c) => c.dispatchFetch(msg));
});