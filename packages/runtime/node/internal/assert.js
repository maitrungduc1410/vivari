// internal/assert — minimal shim. Node's internal modules use it as a
// developer-invariant check (require('internal/assert')(cond)). A throwing
// assert with the same call shape is all the vendored modules need.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  function assert(value, message) {
    if (!value) {
      throw new Error(message || "OpenContainer internal assertion failed");
    }
  }
  assert.ok = assert;
  assert.fail = (message) => {
    throw new Error(message || "OpenContainer internal assertion failed");
  };

  module.exports = assert;
}
