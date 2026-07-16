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

  // A boxed primitive (`new Number(1)`, `Object('x')`, …) shares its toString tag
  // with the primitive, so the tag alone can't tell them apart — require an object
  // wrapper too. pnpm (and util.inspect / deep-equal paths) reach for these.
  const boxed = (tag) => {
    const s = `[object ${tag}]`;
    return (v) => typeof v === "object" && v !== null && Object.prototype.toString.call(v) === s;
  };
  const isNumberObject = boxed("Number");
  const isStringObject = boxed("String");
  const isBooleanObject = boxed("Boolean");
  const isBigIntObject = boxed("BigInt");
  const isSymbolObject = boxed("Symbol");

  module.exports = {
    isArrayBuffer: (v) => v instanceof ArrayBuffer,
    isAnyArrayBuffer: (v) => v instanceof ArrayBuffer || (hasShared && v instanceof SharedArrayBuffer),
    isSharedArrayBuffer: (v) => hasShared && v instanceof SharedArrayBuffer,
    isArrayBufferView: (v) => ArrayBuffer.isView(v),
    isTypedArray: (v) => ArrayBuffer.isView(v) && !(v instanceof DataView),
    isDataView: (v) => v instanceof DataView,
    isUint8Array: (v) => v instanceof Uint8Array,
    isUint8ClampedArray: (v) => v instanceof Uint8ClampedArray,
    isUint16Array: (v) => v instanceof Uint16Array,
    isUint32Array: (v) => v instanceof Uint32Array,
    isInt8Array: (v) => v instanceof Int8Array,
    isInt16Array: (v) => v instanceof Int16Array,
    isInt32Array: (v) => v instanceof Int32Array,
    isFloat32Array: (v) => v instanceof Float32Array,
    isFloat64Array: (v) => v instanceof Float64Array,
    isBigInt64Array: (v) => v instanceof BigInt64Array,
    isBigUint64Array: (v) => v instanceof BigUint64Array,
    isDate,
    isRegExp,
    isNativeError,
    isPromise: (v) => v instanceof Promise,
    isMap: (v) => v instanceof Map,
    isSet: (v) => v instanceof Set,
    isWeakMap: (v) => v instanceof WeakMap,
    isWeakSet: (v) => v instanceof WeakSet,
    isNumberObject,
    isStringObject,
    isBooleanObject,
    isBigIntObject,
    isSymbolObject,
    isBoxedPrimitive: (v) =>
      isNumberObject(v) || isStringObject(v) || isBooleanObject(v) || isBigIntObject(v) || isSymbolObject(v),
    isGeneratorFunction: tagIs("GeneratorFunction"),
    isAsyncFunction: tagIs("AsyncFunction"),
    isGeneratorObject: tagIs("Generator"),
    isArgumentsObject: tagIs("Arguments"),
    isMapIterator: tagIs("Map Iterator"),
    isSetIterator: tagIs("Set Iterator"),
    isModuleNamespaceObject: tagIs("Module"),
    // Not reliably detectable without V8 internals — Node code treats a `false`
    // here as "ordinary object", which is the safe default for these.
    isProxy: () => false,
    isExternal: () => false,
    // Recognise our symmetric crypto KeyObject via the brand it stamps on
    // instances (see node/lib/crypto.js) without importing crypto here.
    isKeyObject: (v) => v != null && typeof v === "object" && v[Symbol.for("vivari.crypto.KeyObject")] === true,
    isCryptoKey: () => false,
  };
}
