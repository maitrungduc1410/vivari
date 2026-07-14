// Browser worker entry for a single process. Waits for the kernel's `init`
// message, then boots the runtime and runs the program. Later `net` messages
// from the kernel nudge the process event loop when a request is queued.

import { bootProcess } from "../runtime/boot.js";
import * as codecNs from "../codec/pkg/open_webcontainer_codec.js";
import * as cryptoNs from "../crypto/pkg/open_webcontainer_crypto.js";

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

self.onmessage = async (event) => {
  const { type, sab, spec, fsPort, threadPort, codecModule, cryptoModule } = event.data;
  if (type === "init") {
    const { makeZStream, cryptoCodec } = buildCodecs(codecModule, cryptoModule);
    bootProcess({
      sab,
      spec,
      fsPort, // #14: fs syscalls ring the File System Worker over this port
      threadPort, // #16 stage 2b: our parentPort, if we are a spawned thread
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
  // An interactive stdin chunk for this process (host terminal / parent -> child).
  else if (type === "stdin") control && control.dispatchStdin(event.data);
  // An async fetch result relayed by the kernel (parallel downloads).
  else if (type === "fetch-done") control && control.dispatchFetch(event.data);
};
