// Node worker_threads entry for a single process (used by the headless test and
// as the Node-side twin of the browser's demo/process-worker.js).

import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
import { bootProcess } from "../packages/runtime/boot.js";

// zlib codec (Phase 2 #11): the Rust/Wasm compression core, instantiated once
// per worker. nodejs target loads synchronously via require. makeZStream is the
// factory internalBinding('zlib') drives.
const require = createRequire(import.meta.url);
let makeZStream = null;
try {
  const { ZStream } = require("../packages/codec/pkg-node/open_webcontainer_codec.js");
  makeZStream = (mode, level, windowBits) => new ZStream(mode, level, windowBits);
} catch {
  // codec not built — zlib stays unavailable (crc32/constants still work).
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
    });
    return;
  }
  // Kernel nudge: a network request is queued for us — wake the event loop.
  if (msg.type === "net") wake && wake();
});
