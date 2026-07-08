// Browser worker entry for a single process. Waits for the kernel's `init`
// message, then boots the runtime and runs the program. Later `net` messages
// from the kernel nudge the process event loop when a request is queued.

import { bootProcess } from "../runtime/boot.js";
import initCodec, { ZStream } from "../codec/pkg/open_webcontainer_codec.js";
import initCrypto, * as cryptoWasm from "../crypto/pkg/open_webcontainer_crypto.js";

let control = null;

// Native codecs (Phase 2 #11 zlib, #12 crypto): the Rust/Wasm cores beneath
// Node's real lib/zlib.js and our lib/crypto.js. Instantiated once per worker.
// makeZStream drives internalBinding('zlib'); cryptoWasm is the crypto module
// namespace internalBinding('crypto') calls one-shot. (Eager today; the roadmap
// tracks lazy load + compile-once-share as an optimization.)
let codecReady = null;
let makeZStream = null;
let cryptoCodec = null;
function ensureCodec() {
  if (!codecReady) {
    codecReady = Promise.all([
      initCodec()
        .then(() => {
          makeZStream = (mode, level, windowBits) => new ZStream(mode, level, windowBits);
        })
        .catch(() => {
          // zlib codec unavailable — crc32/constants still work.
          makeZStream = null;
        }),
      initCrypto()
        .then(() => {
          cryptoCodec = cryptoWasm;
        })
        .catch(() => {
          // crypto codec unavailable — md5/sha1/sha256 fall back to pure-JS.
          cryptoCodec = null;
        }),
    ]);
  }
  return codecReady;
}

self.onmessage = async (event) => {
  const { type, sab, spec, fsPort } = event.data;
  if (type === "init") {
    await ensureCodec();
    bootProcess({
      sab,
      spec,
      fsPort, // #14: fs syscalls ring the File System Worker over this port
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
};
