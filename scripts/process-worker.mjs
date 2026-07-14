// Node worker_threads entry for a single process (used by the headless test and
// as the Node-side twin of the browser's demo/process-worker.js).

import { parentPort, markAsUntransferable } from "node:worker_threads";
import { createRequire } from "node:module";
import * as hostAsyncHooks from "node:async_hooks";
import { bootProcess } from "../packages/runtime/boot.js";

// Native codecs (Phase 2 #11 zlib, #12 crypto): the Rust/Wasm cores. nodejs
// target loads synchronously via require (which also compiles the wasm), so we
// [optimize] defer that require until first real use — a process that never
// compresses/hashes never compiles the codec. require.resolve only resolves the
// path (no compile), so we can still detect an unbuilt codec up front.
const require = createRequire(import.meta.url);
const CODEC_MOD = "../packages/codec/pkg-node/open_webcontainer_codec.js";
const CRYPTO_MOD = "../packages/crypto/pkg-node/open_webcontainer_crypto.js";

let makeZStream = null;
try {
  require.resolve(CODEC_MOD); // built? (throws if not — no compile either way)
  let ZStream = null;
  makeZStream = (mode, level, windowBits) => {
    if (!ZStream) ({ ZStream } = require(CODEC_MOD));
    return new ZStream(mode, level, windowBits);
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

parentPort.on("message", (msg) => {
  if (msg.type === "init") {
    bootProcess({
      sab: msg.sab,
      spec: msg.spec,
      fsPort: msg.fsPort, // #14: fs syscalls ring the File System Worker over this port
      threadPort: msg.threadPort, // #16 stage 2b: our parentPort, if we are a thread
      postRaw: (m, transfer) => parentPort.postMessage(m, transfer || []),
      send: (type, extra) => parentPort.postMessage({ type, ...extra }),
      onReady: (c) => {
        control = c;
      },
      codec: makeZStream,
      cryptoCodec,
      // Real AsyncLocalStorage (V8 PromiseHook) for cross-await context — Next.js
      // App Router (RSC) workStore. The browser twin has no equivalent binding and
      // uses the runtime's best-effort polyfill instead; set OC_NO_HOST_ALS=1 to
      // force that polyfill here and exercise the browser path headlessly.
      hostAsyncHooks: process.env.OC_NO_HOST_ALS ? null : hostAsyncHooks,
      // Real worker_threads.markAsUntransferable so the runtime's Buffer pool can be
      // marked untransferable to the *platform's* postMessage — otherwise a guest
      // transferring a pooled Buffer's .buffer would detach (corrupt) the whole pool.
      hostMarkUntransferable: markAsUntransferable,
    });
    return;
  }
  // Kernel nudge: a network request is queued for us — wake the event loop.
  if (msg.type === "net") control && control.wakeNet();
  // An async child's output/exit relayed by the kernel (#15).
  else if (msg.type === "child-stdout" || msg.type === "child-stderr" || msg.type === "child-exit")
    control && control.dispatchChild(msg);
  // A worker_thread's online/exit relayed by the kernel (#16 stage 2b).
  else if (msg.type === "thread-started" || msg.type === "thread-exit")
    control && control.dispatchThread(msg);
  // A browser preview ws tunnel message relayed by the kernel (#19 stage C).
  else if (msg.type === "ws-open" || msg.type === "ws-in" || msg.type === "ws-close")
    control && control.dispatchWs(msg);
  // An interactive stdin chunk for this process (host terminal / parent -> child).
  else if (msg.type === "stdin") control && control.dispatchStdin(msg);
  // An async fetch result relayed by the kernel (parallel downloads).
  else if (msg.type === "fetch-done") control && control.dispatchFetch(msg);
});
