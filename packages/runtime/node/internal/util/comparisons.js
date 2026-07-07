// internal/util/comparisons — isDeepStrictEqual (compact).
//
// lib/util.js lazily pulls isDeepStrictEqual from here for util.isDeepStrictEqual.
// Node's real file also handles boxed primitives, typed arrays and Symbol keys;
// this covers the common object/array/Map/Set/Date/RegExp graph structurally.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  function isDeepStrictEqual(a, b) {
    return equal(a, b, new Map());
  }

  function equal(a, b, seen) {
    if (Object.is(a, b)) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;

    const s = seen.get(a);
    if (s !== undefined) return s === b;
    seen.set(a, b);

    if (a instanceof Date) return a.getTime() === b.getTime();
    if (a instanceof RegExp) return a.source === b.source && a.flags === b.flags;

    if (ArrayBuffer.isView(a) && !(a instanceof DataView)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }

    if (a instanceof Map) {
      if (a.size !== b.size) return false;
      for (const [k, v] of a) {
        if (!b.has(k) || !equal(v, b.get(k), seen)) return false;
      }
      return true;
    }
    if (a instanceof Set) {
      if (a.size !== b.size) return false;
      for (const v of a) if (!b.has(v)) return false;
      return true;
    }

    const ka = Reflect.ownKeys(a).filter((k) => enumerable(a, k));
    const kb = Reflect.ownKeys(b).filter((k) => enumerable(b, k));
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.propertyIsEnumerable.call(b, k)) return false;
      if (!equal(a[k], b[k], seen)) return false;
    }
    return true;
  }

  const enumerable = (obj, key) => Object.prototype.propertyIsEnumerable.call(obj, key);

  module.exports = { isDeepStrictEqual, isDeepEqual: isDeepStrictEqual };
}
