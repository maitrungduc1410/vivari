// internal/file — provides the `File` class that lib/buffer.js lazily re-exports
// as `require('buffer').File`. Userland libraries feature-detect it (e.g.
// `const { File } = require('buffer')`). Both browsers and modern Node expose a
// global `File`, so we forward to it; otherwise a tiny Blob-based stub keeps
// `instanceof`/construction from throwing.

export default function (exports, require, module) {
  const G = globalThis;
  let FileImpl = typeof G.File === "function" ? G.File : null;

  if (!FileImpl) {
    const BlobImpl = typeof G.Blob === "function" ? G.Blob : class {};
    FileImpl = class File extends BlobImpl {
      constructor(bits, name, options = {}) {
        super(bits, options);
        this.name = String(name);
        this.lastModified = options.lastModified ?? Date.now();
      }
      get [Symbol.toStringTag]() {
        return "File";
      }
    };
  }

  module.exports = { File: FileImpl };
}
