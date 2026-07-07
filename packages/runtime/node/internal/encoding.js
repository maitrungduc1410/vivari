// internal/encoding — bridge to the platform TextEncoder/TextDecoder.
//
// lib/util.js lazily attaches util.TextEncoder / util.TextDecoder from here. The
// Web implementations are spec-compatible, so we forward them straight through.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  module.exports = {
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
  };
}
