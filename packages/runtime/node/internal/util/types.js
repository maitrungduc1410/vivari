// internal/util/types (also served as the public `util/types`).
//
// Type predicates Node's C++ normally provides via internalBinding('util'). The
// browser gives us enough to implement the ones Buffer needs in pure JS. Grows
// as more modules need more predicates.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const hasShared = typeof SharedArrayBuffer !== "undefined";
  // Brand-check via the built-in toString tag, so cross-realm / subclassed
  // values are still recognised (closer to Node's native predicates than
  // `instanceof`, which is realm-bound).
  const tagIs = (tag) => {
    const s = `[object ${tag}]`;
    return (v) => Object.prototype.toString.call(v) === s;
  };
  const isDate = tagIs("Date");
  const isRegExp = tagIs("RegExp");
  const isNativeError = (v) => {
    if (v instanceof Error) return true;
    const t = Object.prototype.toString.call(v);
    return t === "[object Error]" || t === "[object DOMException]";
  };

  module.exports = {
    isArrayBuffer: (v) => v instanceof ArrayBuffer,
    isAnyArrayBuffer: (v) => v instanceof ArrayBuffer || (hasShared && v instanceof SharedArrayBuffer),
    isArrayBufferView: (v) => ArrayBuffer.isView(v),
    isUint8Array: (v) => v instanceof Uint8Array,
    isBigInt64Array: (v) => v instanceof BigInt64Array,
    isTypedArray: (v) => ArrayBuffer.isView(v) && !(v instanceof DataView),
    isDataView: (v) => v instanceof DataView,
    isDate,
    isRegExp,
    isNativeError,
    isPromise: (v) => v instanceof Promise,
    isMap: (v) => v instanceof Map,
    isSet: (v) => v instanceof Set,
  };
}
