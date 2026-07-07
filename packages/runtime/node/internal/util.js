// internal/util — minimal, compatible subset (grows per adopted module).
//
// NOT vendored verbatim: Node's real internal/util.js is large and pulls
// internal/util/types, internalBinding('util'), the encodings table, etc. We
// provide only what the currently-vendored lib/ modules destructure.
//   path   → { isWindows, getLazy }
//   buffer → { customInspectSymbol, lazyDOMException, normalizeEncoding,
//              kIsEncodingSymbol, defineLazyProperties, encodingsMap, deprecate }
//
// Authored as a builtin factory so the loader treats it like any other module.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const isWindows = process.platform === "win32";

  // Memoize a value on first access (used for lazy internal requires).
  function getLazy(initializer) {
    let value;
    let initialized = false;
    return () => {
      if (initialized === false) {
        value = initializer();
        initialized = true;
      }
      return value;
    };
  }

  const customInspectSymbol = Symbol.for("nodejs.util.inspect.custom");
  const kIsEncodingSymbol = Symbol("kIsEncoding");

  // Canonical encoding names. Buffer indexes this by name and hands the value to
  // internalBinding('buffer'); since we own both ends, the value is just the name.
  const encodingsMap = {
    __proto__: null,
    ascii: "ascii",
    utf8: "utf8",
    "utf-8": "utf8",
    utf16le: "utf16le",
    "utf-16le": "utf16le",
    ucs2: "utf16le",
    "ucs-2": "utf16le",
    base64: "base64",
    base64url: "base64url",
    latin1: "latin1",
    binary: "latin1",
    hex: "hex",
    buffer: "buffer",
  };

  function normalizeEncoding(enc) {
    if (enc == null || enc === "utf8" || enc === "utf-8") return "utf8";
    const low = ("" + enc).toLowerCase();
    const mapped = encodingsMap[low];
    if (mapped) return mapped === "buffer" ? undefined : mapped;
    return undefined;
  }

  function defineLazyProperties(target, id, keys, enumerable = true) {
    for (const key of keys) {
      let cached;
      let loaded = false;
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable,
        get() {
          if (!loaded) {
            cached = require(id)[key];
            loaded = true;
          }
          return cached;
        },
        set(value) {
          Object.defineProperty(target, key, {
            value,
            writable: true,
            enumerable,
            configurable: true,
          });
        },
      });
    }
  }

  function deprecate(fn, msg, code) {
    let warned = false;
    function deprecated(...args) {
      if (!warned) {
        warned = true;
        if (typeof process.emitWarning === "function") {
          try {
            process.emitWarning(msg, "DeprecationWarning", code);
          } catch {
            /* ignore */
          }
        }
      }
      return Reflect.apply(fn, this, args);
    }
    return deprecated;
  }

  function lazyDOMException(message, name) {
    if (typeof DOMException === "function") return new DOMException(message, name);
    const err = new Error(message);
    err.name = name;
    return err;
  }

  const isMacOS = process.platform === "darwin";

  // Frozen empty object used as a default option bag (Node's kEmptyObject).
  const kEmptyObject = Object.freeze({ __proto__: null });

  // Wrap so the underlying fn runs at most once; later calls return the first
  // result. Used by internal/fs/utils.getDirents to guard its callback.
  function once(callback) {
    let called = false;
    let value;
    return function (...args) {
      if (!called) {
        called = true;
        value = Reflect.apply(callback, this, args);
      }
      return value;
    };
  }

  // Define a data property, replacing any accessor already there (used by the
  // lazy atime/mtime/... getters on Stats to memoize the Date on first access).
  function setOwnProperty(obj, key, value) {
    Object.defineProperty(obj, key, {
      __proto__: null,
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
    return value;
  }

  const customPromisifyArgs = Symbol("customPromisifyArgs");

  function promisify() {
    throw new Error("OpenContainer: util.promisify is not available in internal/util yet");
  }
  promisify.custom = Symbol.for("nodejs.util.promisify.custom");

  const SideEffectFreeRegExpPrototypeExec = (regexp, string) =>
    RegExp.prototype.exec.call(regexp, string);

  module.exports = {
    isWindows,
    isMacOS,
    getLazy,
    customInspectSymbol,
    kIsEncodingSymbol,
    kEmptyObject,
    encodingsMap,
    normalizeEncoding,
    defineLazyProperties,
    deprecate,
    lazyDOMException,
    once,
    setOwnProperty,
    customPromisifyArgs,
    promisify,
    SideEffectFreeRegExpPrototypeExec,
  };
}
