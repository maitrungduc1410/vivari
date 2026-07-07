// internal/errors — minimal, compatible subset.
//
// NOT vendored verbatim: Node's real internal/errors.js is ~1600 lines and
// drags internal/util/inspect. We provide the same public shape
// (`{ codes: { ERR_* }, hideStackFrames }`) with faithful messages for the few
// error codes the vendored modules throw. It grows as we adopt more lib/, and
// can be swapped for the real file once inspect/types exist.
//
// Authored as a builtin factory so the loader treats it like any other module.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const determineType = (actual) => {
    if (actual === null) return "null";
    if (actual === undefined) return "undefined";
    const t = typeof actual;
    if (t === "function") return `function ${actual.name || "(anonymous)"}`;
    if (t === "object") {
      const ctor = actual.constructor && actual.constructor.name;
      return ctor ? `an instance of ${ctor}` : "an object";
    }
    return `type ${t}`;
  };

  const makeNodeError = (Base, code, formatter) =>
    class extends Base {
      constructor(...args) {
        super(formatter(...args));
        this.code = code;
        this.name = `${Base.name} [${code}]`;
      }
    };

  const ERR_INVALID_ARG_TYPE = makeNodeError(
    TypeError,
    "ERR_INVALID_ARG_TYPE",
    (name, expected, actual) => {
      const exp = Array.isArray(expected) ? expected.join(" | ") : String(expected);
      return `The "${name}" argument must be of type ${exp}. Received ${determineType(actual)}`;
    },
  );

  const ERR_INVALID_ARG_VALUE = makeNodeError(
    TypeError,
    "ERR_INVALID_ARG_VALUE",
    (name, value, reason = "is invalid") => {
      let v;
      try {
        v = typeof value === "string" ? `'${value}'` : String(value);
      } catch {
        v = "<value>";
      }
      return `The ${name.includes(".") ? "property" : "argument"} '${name}' ${v} ${reason}`;
    },
  );

  const ERR_OUT_OF_RANGE = makeNodeError(
    RangeError,
    "ERR_OUT_OF_RANGE",
    (name, range, value) =>
      `The value of "${name}" is out of range. It must be ${range}. Received ${value}`,
  );

  const ERR_UNKNOWN_SIGNAL = makeNodeError(
    TypeError,
    "ERR_UNKNOWN_SIGNAL",
    (signal) => `Unknown signal: ${signal}`,
  );

  const ERR_SOCKET_BAD_PORT = makeNodeError(
    RangeError,
    "ERR_SOCKET_BAD_PORT",
    (name, port, allowZero = true) =>
      `${name} should be ${allowZero ? ">=" : ">"} 0 and < 65536. Received ${port}`,
  );

  const ERR_BUFFER_OUT_OF_BOUNDS = makeNodeError(
    RangeError,
    "ERR_BUFFER_OUT_OF_BOUNDS",
    (name) =>
      name
        ? `"${name}" is outside of buffer bounds`
        : "Attempt to access memory outside buffer bounds",
  );

  const ERR_INVALID_BUFFER_SIZE = makeNodeError(
    RangeError,
    "ERR_INVALID_BUFFER_SIZE",
    (size) => `Buffer size must be a multiple of ${size}`,
  );

  const ERR_UNKNOWN_ENCODING = makeNodeError(
    TypeError,
    "ERR_UNKNOWN_ENCODING",
    (enc) => `Unknown encoding: ${enc}`,
  );

  const ERR_MISSING_ARGS = makeNodeError(TypeError, "ERR_MISSING_ARGS", (...args) => {
    const names = args.map((a) => `"${a}"`);
    const list =
      names.length > 1
        ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
        : names[0];
    return `The ${list} argument${names.length > 1 ? "s" : ""} must be specified`;
  });

  // A plain Error carrying extra properties (used by Buffer.transcode et al.).
  const genericNodeError = (message, props) => Object.assign(new Error(message), props);

  // Node hides internal stack frames; for us the identity wrapper is fine.
  const hideStackFrames = (fn) => fn;

  module.exports = {
    hideStackFrames,
    genericNodeError,
    codes: {
      ERR_INVALID_ARG_TYPE,
      ERR_INVALID_ARG_VALUE,
      ERR_OUT_OF_RANGE,
      ERR_UNKNOWN_SIGNAL,
      ERR_SOCKET_BAD_PORT,
      ERR_BUFFER_OUT_OF_BOUNDS,
      ERR_INVALID_BUFFER_SIZE,
      ERR_UNKNOWN_ENCODING,
      ERR_MISSING_ARGS,
    },
  };
}
