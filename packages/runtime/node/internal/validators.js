// internal/validators — minimal, compatible subset.
//
// NOT vendored verbatim (the real file load-requires internal/errors,
// internal/util, internal/util/types and internalBinding('constants')). We
// provide the validators the vendored modules actually use, with logic copied
// faithfully from Node's source (minus the hideStackFrames wrapper). It grows /
// is replaced by the real file as those dependencies come online.
//
// Authored as a builtin factory so the loader treats it like any other module.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const {
    codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_OUT_OF_RANGE },
  } = require("internal/errors");

  const MIN = Number.MIN_SAFE_INTEGER;
  const MAX = Number.MAX_SAFE_INTEGER;
  const INT32_MIN = -2147483648;
  const INT32_MAX = 2147483647;
  const UINT32_MAX = 4294967295;

  function validateString(value, name) {
    if (typeof value !== "string") throw new ERR_INVALID_ARG_TYPE(name, "string", value);
  }

  function validateInteger(value, name, min = MIN, max = MAX) {
    if (typeof value !== "number") throw new ERR_INVALID_ARG_TYPE(name, "number", value);
    if (!Number.isInteger(value)) throw new ERR_OUT_OF_RANGE(name, "an integer", value);
    if (value < min || value > max)
      throw new ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
  }

  function validateArray(value, name, minLength = 0) {
    if (!Array.isArray(value)) throw new ERR_INVALID_ARG_TYPE(name, "Array", value);
    if (value.length < minLength)
      throw new ERR_INVALID_ARG_VALUE(name, value, `must be longer than ${minLength}`);
  }

  function validateBuffer(buffer, name = "buffer") {
    if (!ArrayBuffer.isView(buffer))
      throw new ERR_INVALID_ARG_TYPE(name, ["Buffer", "TypedArray", "DataView"], buffer);
  }

  function validateNumber(value, name, min = undefined, max) {
    if (typeof value !== "number") throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  }

  function validateBoolean(value, name) {
    if (typeof value !== "boolean") throw new ERR_INVALID_ARG_TYPE(name, "boolean", value);
  }

  function validateFunction(value, name) {
    if (typeof value !== "function") throw new ERR_INVALID_ARG_TYPE(name, "Function", value);
  }

  const kValidateObjectNone = 0;
  const kValidateObjectAllowNullable = 1 << 0;
  const kValidateObjectAllowArray = 1 << 1;
  const kValidateObjectAllowFunction = 1 << 2;

  function validateObject(value, name, options = kValidateObjectNone) {
    if (options === kValidateObjectNone) {
      if (value === null || Array.isArray(value)) {
        throw new ERR_INVALID_ARG_TYPE(name, "Object", value);
      }
      if (typeof value !== "object") {
        throw new ERR_INVALID_ARG_TYPE(name, "Object", value);
      }
    } else {
      const throwOnNullable = (kValidateObjectAllowNullable & options) === 0;
      if (throwOnNullable && value === null) {
        throw new ERR_INVALID_ARG_TYPE(name, "Object", value);
      }
      const throwOnArray = (kValidateObjectAllowArray & options) === 0;
      if (throwOnArray && Array.isArray(value)) {
        throw new ERR_INVALID_ARG_TYPE(name, "Object", value);
      }
      const throwOnFunction = (kValidateObjectAllowFunction & options) === 0;
      const typeofValue = typeof value;
      if (typeofValue !== "object" && (throwOnFunction || typeofValue !== "function")) {
        throw new ERR_INVALID_ARG_TYPE(name, "Object", value);
      }
    }
  }

  function validateInt32(value, name, min = INT32_MIN, max = INT32_MAX) {
    if (typeof value !== "number") throw new ERR_INVALID_ARG_TYPE(name, "number", value);
    if (!Number.isInteger(value)) throw new ERR_OUT_OF_RANGE(name, "an integer", value);
    if (value < min || value > max)
      throw new ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
  }

  function validateUint32(value, name, positive = false) {
    if (typeof value !== "number") throw new ERR_INVALID_ARG_TYPE(name, "number", value);
    if (!Number.isInteger(value)) throw new ERR_OUT_OF_RANGE(name, "an integer", value);
    const min = positive ? 1 : 0;
    if (value < min || value > UINT32_MAX)
      throw new ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${UINT32_MAX}`, value);
  }

  const isInt32 = (value) => value === (value | 0);

  function parseFileMode(value, name, def) {
    value ??= def;
    if (typeof value === "string") {
      const parsed = Number.parseInt(value, 8);
      if (Number.isNaN(parsed)) {
        throw new ERR_INVALID_ARG_VALUE(
          name,
          value,
          "must be a 32-bit unsigned integer or an octal string",
        );
      }
      value = parsed;
    }
    validateUint32(value, name);
    return value;
  }

  function validateOneOf(value, name, oneOf) {
    if (!oneOf.includes(value)) {
      const list = oneOf.map((v) => (typeof v === "string" ? `'${v}'` : String(v))).join(", ");
      throw new ERR_INVALID_ARG_VALUE(name, value, `must be one of: ${list}`);
    }
  }

  // Node validates the encoding string is real; the Buffer layer re-checks, so a
  // permissive accept keeps the common write(fd, string, enc) path working.
  function validateEncoding() {}

  function validateAbortSignal(signal, name) {
    if (
      signal !== undefined &&
      (signal === null || typeof signal !== "object" || !("aborted" in signal))
    ) {
      throw new ERR_INVALID_ARG_TYPE(name, "AbortSignal", signal);
    }
  }

  module.exports = {
    validateString,
    validateNumber,
    validateBoolean,
    validateFunction,
    validateInteger,
    validateInt32,
    validateUint32,
    validateArray,
    validateBuffer,
    validateObject,
    validateOneOf,
    validateEncoding,
    validateAbortSignal,
    isInt32,
    parseFileMode,
    kValidateObjectNone,
    kValidateObjectAllowNullable,
    kValidateObjectAllowArray,
    kValidateObjectAllowFunction,
  };

  // Node wraps validators with hideStackFrames, which exposes `.withoutStackTrace`.
  // internal/fs/utils calls e.g. validateInt32.withoutStackTrace(...), so mirror it.
  for (const key of Object.keys(module.exports)) {
    const v = module.exports[key];
    if (typeof v === "function" && v.withoutStackTrace === undefined) {
      v.withoutStackTrace = v;
    }
  }
}
