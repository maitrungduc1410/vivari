// Browser worker entry for a single process. Waits for the kernel's `init`
// message, then boots the runtime and runs the program. Later `net` messages
// from the kernel nudge the process event loop when a request is queued.

import { bootProcess } from "../runtime/boot.js";
import initCodec, { ZStream } from "../codec/pkg/open_webcontainer_codec.js";

let wake = null;

// zlib codec (Phase 2 #11): the Rust/Wasm compression core beneath Node's real
// lib/zlib.js. Instantiate once per worker; makeZStream is the factory the
// internalBinding('zlib') handle drives. ~70KB wasm, compiled once per worker.
let codecReady = null;
let makeZStream = null;
function ensureCodec() {
  if (!codecReady) {
    codecReady = initCodec()
      .then(() => {
        makeZStream = (mode, level, windowBits) => new ZStream(mode, level, windowBits);
      })
      .catch(() => {
        // codec unavailable — zlib stays unusable (crc32/constants still work).
        makeZStream = null;
      });
  }
  return codecReady;
}

self.onmessage = async (event) => {
  const { type, sab, spec } = event.data;
  if (type === "init") {
    await ensureCodec();
    bootProcess({
      sab,
      spec,
      send: (msgType, extra) => self.postMessage({ type: msgType, ...extra }),
      onReady: (w) => {
        wake = w;
      },
      codec: makeZStream,
    });
    return;
  }
  // Kernel nudge: a network request is queued for us — wake the event loop.
  if (type === "net") wake && wake();
};
