// internal/blob — stub. lib/fs.js requires createBlobFromFilePath at load, but
// only calls it from fs.openAsBlob(), which is out of scope for Phase 2 #4
// (sync + callback fs). Loading must succeed; calling it fails loudly.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  module.exports = {
    createBlobFromFilePath() {
      throw new Error("OpenContainer: fs.openAsBlob() is not supported yet");
    },
  };
}
