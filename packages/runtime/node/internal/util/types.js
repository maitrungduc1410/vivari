// internal/util/types (also served as the public `util/types`).
//
// Type predicates Node's C++ normally provides via internalBinding('util'). The
// browser gives us enough to implement the ones Buffer needs in pure JS. Grows
// as more modules need more predicates.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const hasShared = typeof SharedArrayBuffer !== "undefined";

  module.exports = {
    isArrayBuffer: (v) => v instanceof ArrayBuffer,
    isAnyArrayBuffer: (v) => v instanceof ArrayBuffer || (hasShared && v instanceof SharedArrayBuffer),
    isArrayBufferView: (v) => ArrayBuffer.isView(v),
    isUint8Array: (v) => v instanceof Uint8Array,
    isTypedArray: (v) => ArrayBuffer.isView(v) && !(v instanceof DataView),
    isDataView: (v) => v instanceof DataView,
  };
}
