// internal/blob — the platform's Blob, plus the one entry point that genuinely
// has no implementation here.
//
// Upstream this module IS Blob: ~600 lines over a C++ blob store, a data-URL
// registry for resolveObjectURL, and the transferable plumbing. We do not vendor
// it, and we do not need to: every engine this runtime boots on — a browser
// worker, a Node worker — already has a spec Blob global, and the pieces Node's
// own callers ask this module for are the constructor and resolveObjectURL.
//
// It used to export only createBlobFromFilePath (a throw), which was enough for
// lib/fs.js to load. But two public surfaces read Blob FROM here, and both were
// silently wrong for it: `require('buffer').Blob` was undefined (lib/buffer.js
// defines it as a lazy property off this module), and stream/consumers' blob()
// — the base that arrayBuffer/buffer/bytes are all built on — died on "Blob is
// not a constructor". Neither says anything about a blob to whoever hits it.
//
// createBlobFromFilePath still throws: fs.openAsBlob() needs a lazily-read file
// blob, which is a real capability we do not have, not a name we forgot to pass
// through.
export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  module.exports = {
    Blob: globalThis.Blob,
    // Upstream this resolves a blob: URL registered by URL.createObjectURL. There
    // is no such registry here (no document, no URL store), and a browser's own
    // one is not reachable from a worker's guest, so the honest answer to every
    // id is "not registered" — which is also what upstream returns for one it
    // does not know.
    resolveObjectURL() {
      return undefined;
    },
    createBlobFromFilePath() {
      throw new Error("Vivari: fs.openAsBlob() is not supported yet");
    },
  };
}
