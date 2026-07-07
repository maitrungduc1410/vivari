// internal/options — stub.
//
// Node exposes parsed CLI options here. We don't parse Node flags, so every
// option reads as unset. lib/buffer.js only consults this in the legacy
// Buffer() constructor's deprecation-warning path.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  module.exports = {
    getOptionValue: () => undefined,
    getEmbedderOptions: () => ({}),
  };
}
