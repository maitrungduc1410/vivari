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

  const makeNodeError = (Base, code, formatter) => {
    const Cls = class extends Base {
      constructor(...args) {
        super(formatter(...args));
        this.code = code;
        this.name = `${Base.name} [${code}]`;
      }
    };
    // Node exposes a stack-frame-hiding variant on each code; for us it is the
    // same constructor (we don't massage stacks). Vendored modules call
    // `new ERR_X.HideStackFramesError(...)`.
    Cls.HideStackFramesError = Cls;
    return Cls;
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

  const ERR_INVALID_URI = makeNodeError(
    URIError,
    "ERR_INVALID_URI",
    () => "URI malformed",
  );

  const ERR_MISSING_ARGS = makeNodeError(TypeError, "ERR_MISSING_ARGS", (...args) => {
    const names = args.map((a) => `"${a}"`);
    const list =
      names.length > 1
        ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
        : names[0];
    return `The ${list} argument${names.length > 1 ? "s" : ""} must be specified`;
  });

  const ERR_INCOMPATIBLE_OPTION_PAIR = makeNodeError(
    TypeError,
    "ERR_INCOMPATIBLE_OPTION_PAIR",
    (a, b) => `Option "${a}" cannot be used in combination with option "${b}"`,
  );

  const ERR_ACCESS_DENIED = makeNodeError(
    Error,
    "ERR_ACCESS_DENIED",
    (message) => message || "Access to this API has been restricted",
  );

  const ERR_FS_FILE_TOO_LARGE = makeNodeError(
    RangeError,
    "ERR_FS_FILE_TOO_LARGE",
    (size) => `File size (${size}) is greater than 2 GiB`,
  );

  // SystemError-shaped: built from a ctx object ({ code, message, path, ... }).
  const makeSystemError = (code) => {
    const Cls = class extends Error {
      constructor(ctx = {}) {
        super(ctx.message ? `${code}: ${ctx.message}` : code);
        this.code = ctx.code || code;
        if (ctx.errno !== undefined) this.errno = ctx.errno;
        if (ctx.syscall !== undefined) this.syscall = ctx.syscall;
        if (ctx.path !== undefined) this.path = ctx.path;
        if (ctx.dest !== undefined) this.dest = ctx.dest;
        this.name = `SystemError [${this.code}]`;
      }
    };
    Cls.HideStackFramesError = Cls;
    return Cls;
  };

  const ERR_FS_EISDIR = makeSystemError("ERR_FS_EISDIR");

  // libuv-style exception constructed from a binding ctx. Only reached via
  // handleErrorFromBinding, which our sync-throwing binding never triggers, but
  // fs.js destructures it at load.
  function UVException(ctx = {}) {
    const err = new Error(
      `${ctx.code || "EIO"}: ${ctx.message || "unknown error"}, ${ctx.syscall || ""}`,
    );
    err.code = ctx.code;
    err.errno = ctx.errno;
    err.syscall = ctx.syscall;
    if (ctx.path !== undefined) err.path = ctx.path;
    if (ctx.dest !== undefined) err.dest = ctx.dest;
    return err;
  }

  class AbortError extends Error {
    constructor(message = "The operation was aborted", options = undefined) {
      super(message, options);
      this.code = "ABORT_ERR";
      this.name = "AbortError";
    }
  }

  // Combine an error with a prior one (Node returns an AggregateError). We keep
  // it simple: prefer the newer error, stash the previous on it.
  function aggregateTwoErrors(innerError, outerError) {
    if (innerError && outerError && innerError !== outerError) {
      if (typeof AggregateError === "function") {
        const err = new AggregateError([outerError, innerError], outerError.message);
        err.code = outerError.code;
        return err;
      }
      outerError.previous = innerError;
    }
    return innerError || outerError;
  }

  const ERR_UNHANDLED_ERROR = makeNodeError(
    Error,
    "ERR_UNHANDLED_ERROR",
    (err) => `Unhandled error.${err === undefined ? "" : ` (${err})`}`,
  );

  // Thrown by callbackify when a promise rejects with a falsy value.
  class ERR_FALSY_VALUE_REJECTION extends Error {
    constructor(reason) {
      super("Promise was rejected with a falsy value");
      this.code = "ERR_FALSY_VALUE_REJECTION";
      this.name = "Error [ERR_FALSY_VALUE_REJECTION]";
      this.reason = reason;
    }
  }
  ERR_FALSY_VALUE_REJECTION.HideStackFramesError = ERR_FALSY_VALUE_REJECTION;

  // libuv errno-style exceptions. net.js builds connect/read/write errors through
  // these, so we resolve the code/message via the 'uv' binding (uv.errname) to
  // match Node — e.g. status -111 => { code: 'ECONNREFUSED', errno: -111 }.
  const uvErrname = (err) => {
    try {
      return internalBinding("uv").errname(err);
    } catch {
      return `UNKNOWN(${err})`;
    }
  };

  function ErrnoException(err, syscall, original) {
    const code = uvErrname(err);
    const e = new Error(`${syscall} ${code}${original ? ` ${original}` : ""}`);
    e.errno = err;
    e.code = code;
    e.syscall = syscall;
    return e;
  }

  function ExceptionWithHostPort(err, syscall, address, port, additional) {
    const code = uvErrname(err);
    let details = "";
    if (port && port > 0) details = ` ${address}:${port}`;
    else if (address) details = ` ${address}`;
    if (additional) details += ` - Local (${additional})`;
    const e = new Error(`${syscall} ${code}${details}`);
    e.errno = err;
    e.code = code;
    e.syscall = syscall;
    e.address = address;
    if (port) e.port = port;
    return e;
  }

  // Node guards stackTraceLimit writes; mirror the real predicate.
  function isErrorStackTraceLimitWritable() {
    const desc = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit");
    if (desc === undefined) return Object.isExtensible(Error);
    return Object.prototype.hasOwnProperty.call(desc, "writable")
      ? desc.writable
      : desc.set !== undefined;
  }

  // Symbol events.js tags on errors so the inspector can enhance the stack
  // before printing; we don't massage stacks, so it's an inert marker.
  const kEnhanceStackBeforeInspector = Symbol("kEnhanceStackBeforeInspector");

  // A plain Error carrying extra properties (used by Buffer.transcode et al.).
  const genericNodeError = (message, props) => Object.assign(new Error(message), props);

  // Node hides internal stack frames; we don't massage stacks, but we must still
  // expose the `.withoutStackTrace` alias the vendored modules call.
  const hideStackFrames = (fn) => {
    fn.withoutStackTrace = fn;
    return fn;
  };

  module.exports = {
    hideStackFrames,
    genericNodeError,
    UVException,
    AbortError,
    aggregateTwoErrors,
    ErrnoException,
    ExceptionWithHostPort,
    isErrorStackTraceLimitWritable,
    kEnhanceStackBeforeInspector,
    codes: {
      ERR_UNHANDLED_ERROR,
      ERR_FALSY_VALUE_REJECTION,
      ERR_INVALID_ARG_TYPE,
      ERR_INVALID_ARG_VALUE,
      ERR_OUT_OF_RANGE,
      ERR_UNKNOWN_SIGNAL,
      ERR_SOCKET_BAD_PORT,
      ERR_BUFFER_OUT_OF_BOUNDS,
      ERR_INVALID_BUFFER_SIZE,
      ERR_UNKNOWN_ENCODING,
      ERR_INVALID_URI,
      ERR_MISSING_ARGS,
      ERR_INCOMPATIBLE_OPTION_PAIR,
      ERR_ACCESS_DENIED,
      ERR_FS_FILE_TOO_LARGE,
      ERR_FS_EISDIR,
      // fs.js also destructures these two but only uses them in edge/async paths.
      ERR_FS_CP_EINVAL: makeSystemError("ERR_FS_CP_EINVAL"),
      ERR_INVALID_ARG_TYPE_RANGE: ERR_OUT_OF_RANGE,
    },
  };
}
