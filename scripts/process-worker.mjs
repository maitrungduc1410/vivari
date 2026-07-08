// Node worker_threads entry for a single process (used by the headless test and
// as the Node-side twin of the browser's demo/process-worker.js).

import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
import { bootProcess } from "../packages/runtime/boot.js";

// Native codecs (Phase 2 #11 zlib, #12 crypto): the Rust/Wasm cores, loaded once
// per worker. nodejs target loads synchronously via require. makeZStream drives
// internalBinding('zlib'); cryptoCodec is the module internalBinding('crypto')
// calls one-shot.
const require = createRequire(import.meta.url);
let makeZStream = null;
try {
  const { ZStream } = require("../packages/codec/pkg-node/open_webcontainer_codec.js");
  makeZStream = (mode, level, windowBits) => new ZStream(mode, level, windowBits);
} catch {
  // codec not built — zlib stays unavailable (crc32/constants still work).
}
let cryptoCodec = null;
try {
  cryptoCodec = require("../packages/crypto/pkg-node/open_webcontainer_crypto.js");
} catch {
  // codec not built — md5/sha1/sha256 fall back to pure-JS.
}

let wake = null;

parentPort.on("message", (msg) => {
  if (msg.type === "init") {
    bootProcess({
      sab: msg.sab,
      spec: msg.spec,
      send: (type, extra) => parentPort.postMessage({ type, ...extra }),
      onReady: (w) => {
        wake = w;
      },
      codec: makeZStream,
      cryptoCodec,
    });
    return;
  }
  // Kernel nudge: a network request is queued for us — wake the event loop.
  if (msg.type === "net") wake && wake();
});
