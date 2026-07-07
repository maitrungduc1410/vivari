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

  module.exports = {
    validateString,
    validateNumber,
    validateBoolean,
    validateFunction,
    validateInteger,
    validateArray,
    validateBuffer,
    validateObject,
    kValidateObjectNone,
    kValidateObjectAllowNullable,
    kValidateObjectAllowArray,
    kValidateObjectAllowFunction,
  };
}
