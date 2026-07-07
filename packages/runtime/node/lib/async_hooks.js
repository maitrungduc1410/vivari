// async_hooks — public builtin, re-exports internal/async_hooks (as Node does).
// Sharing the one instance keeps owner_symbol/async_id_symbol identical across
// net.js, stream_base_commons and end-of-stream. See internal/async_hooks.js.
export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";
  module.exports = require("internal/async_hooks");
}
