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

  // util.parseArgs error codes (copied from Node's lib/internal/errors.js).
  const ERR_PARSE_ARGS_INVALID_OPTION_VALUE = makeNodeError(
    TypeError,
    "ERR_PARSE_ARGS_INVALID_OPTION_VALUE",
    (msg) => msg,
  );

  const ERR_PARSE_ARGS_UNKNOWN_OPTION = makeNodeError(
    TypeError,
    "ERR_PARSE_ARGS_UNKNOWN_OPTION",
    (option, allowPositionals) => {
      const suggestDashDash = allowPositionals
        ? ` To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- ${JSON.stringify(option)}`
        : "";
      return `Unknown option '${option}'.${suggestDashDash}`;
    },
  );

  const ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL = makeNodeError(
    TypeError,
    "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL",
    (positional) =>
      `Unexpected argument '${positional}'. This command does not take positional arguments`,
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

  // zlib (Phase 2 #11).
  const ERR_BUFFER_TOO_LARGE = makeNodeError(
    RangeError,
    "ERR_BUFFER_TOO_LARGE",
    (max) => `Cannot create a Buffer larger than ${max} bytes`,
  );
  const ERR_BROTLI_INVALID_PARAM = makeNodeError(
    RangeError,
    "ERR_BROTLI_INVALID_PARAM",
    (param) => `${param} is not a valid Brotli parameter`,
  );
  const ERR_ZSTD_INVALID_PARAM = makeNodeError(
    RangeError,
    "ERR_ZSTD_INVALID_PARAM",
    (param) => `${param} is not a valid zstd parameter`,
  );
  const ERR_TRAILING_JUNK_AFTER_STREAM_END = makeNodeError(
    Error,
    "ERR_TRAILING_JUNK_AFTER_STREAM_END",
    () => "Trailing junk found after the end of the compressed stream",
  );
  const ERR_ZLIB_INITIALIZATION_FAILED = makeNodeError(
    Error,
    "ERR_ZLIB_INITIALIZATION_FAILED",
    () => "Initialization failed",
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

  // Thrown by internal/mime.js (util.MIMEType / util.MIMEParams) on every parse
  // failure — the whole point of that API is to reject malformed input.
  const ERR_INVALID_MIME_SYNTAX = makeNodeError(
    TypeError,
    "ERR_INVALID_MIME_SYNTAX",
    (production, str, invalidIndex) =>
      `The MIME syntax for a ${production} in "${str}" is invalid` +
      (invalidIndex !== -1 ? ` at ${invalidIndex}` : ""),
  );

  const ERR_FS_FILE_TOO_LARGE = makeNodeError(
    RangeError,
    "ERR_FS_FILE_TOO_LARGE",
    (size) => `File size (${size}) is greater than 2 GiB`,
  );

  // SystemError-shaped: built from a ctx object ({ code, message, path, ... }).
  //
  // `code` is the ERR_* key, NOT ctx.code — that is Node's contract and callers
  // branch on it: `fs.rm(dir)` without `recursive` rejects with
  // ERR_FS_EISDIR, `fs.cp` over an existing file with ERR_FS_CP_EEXIST. The
  // libuv-level code ('EISDIR', 'EEXIST') stays reachable through `.info`, the
  // way real Node exposes it. Reading ctx.code here instead reported the raw
  // errno name, so every `err.code === 'ERR_FS_*'` check in the ecosystem
  // silently missed and the error fell through as an unrecognised failure.
  const makeSystemError = (code) => {
    const Cls = class extends Error {
      constructor(ctx = {}) {
        const syscall = ctx.syscall ? `${ctx.syscall} returned ${ctx.code}` : ctx.code;
        super(
          [code + ":", syscall, ctx.message && `(${ctx.message})`, ctx.path]
            .filter(Boolean)
            .join(" "),
        );
        this.code = code;
        this.info = ctx;
        if (ctx.errno !== undefined) this.errno = ctx.errno;
        if (ctx.syscall !== undefined) this.syscall = ctx.syscall;
        if (ctx.path !== undefined) this.path = ctx.path;
        if (ctx.dest !== undefined) this.dest = ctx.dest;
        this.name = "SystemError";
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

  // Copied from Node's internal/errors.js. The http client/server construct it
  // on a reset/hang-up connection: `new ConnResetException('socket hang up')`.
  // Without it these paths threw "ConnResetException is not a constructor" —
  // e.g. Nuxt's dev server tearing down a proxied socket during `nuxt dev`.
  class ConnResetException extends Error {
    constructor(msg) {
      super(msg);
      this.code = "ECONNRESET";
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

  // --- streams (internal/streams/*) --------------------------------------------
  // These are constructed only on error paths (e.g. writing after end, or calling
  // .end()/.write() on a destroyed stream — which happens when a peer closes the
  // socket mid-response). Absent, `new ERR_STREAM_*()` throws "not a constructor"
  // and crashes the response instead of surfacing a clean stream error.
  const ERR_METHOD_NOT_IMPLEMENTED = makeNodeError(
    Error,
    "ERR_METHOD_NOT_IMPLEMENTED",
    (method) => `The ${method} method is not implemented`,
  );
  const ERR_MULTIPLE_CALLBACK = makeNodeError(
    Error,
    "ERR_MULTIPLE_CALLBACK",
    () => "Callback called multiple times",
  );
  // lib/stream.js installs the Readable helpers (map/filter/take/…) with a
  // `if (new.target) throw new ERR_ILLEGAL_CONSTRUCTOR()` guard, so `new
  // readable.map(...)` reported "ERR_ILLEGAL_CONSTRUCTOR is not a constructor"
  // instead of the intended TypeError.
  const ERR_ILLEGAL_CONSTRUCTOR = makeNodeError(
    TypeError,
    "ERR_ILLEGAL_CONSTRUCTOR",
    () => "Illegal constructor",
  );
  const ERR_STREAM_ALREADY_FINISHED = makeNodeError(
    Error,
    "ERR_STREAM_ALREADY_FINISHED",
    (fn) => `Cannot call ${fn} after a stream was finished`,
  );
  const ERR_STREAM_CANNOT_PIPE = makeNodeError(
    Error,
    "ERR_STREAM_CANNOT_PIPE",
    () => "Cannot pipe, not readable",
  );
  const ERR_STREAM_DESTROYED = makeNodeError(
    Error,
    "ERR_STREAM_DESTROYED",
    (fn) => `Cannot call ${fn} after a stream was destroyed`,
  );
  const ERR_STREAM_NULL_VALUES = makeNodeError(
    TypeError,
    "ERR_STREAM_NULL_VALUES",
    () => "May not write null values to stream",
  );
  const ERR_STREAM_WRITE_AFTER_END = makeNodeError(
    Error,
    "ERR_STREAM_WRITE_AFTER_END",
    () => "write after end",
  );
  const ERR_STREAM_PREMATURE_CLOSE = makeNodeError(
    Error,
    "ERR_STREAM_PREMATURE_CLOSE",
    () => "Premature close",
  );
  const ERR_STREAM_UNABLE_TO_PIPE = makeNodeError(
    Error,
    "ERR_STREAM_UNABLE_TO_PIPE",
    () => "Cannot pipe to a closed or destroyed stream",
  );
  const ERR_STREAM_PUSH_AFTER_EOF = makeNodeError(
    Error,
    "ERR_STREAM_PUSH_AFTER_EOF",
    () => "stream.push() after EOF",
  );
  const ERR_STREAM_UNSHIFT_AFTER_END_EVENT = makeNodeError(
    Error,
    "ERR_STREAM_UNSHIFT_AFTER_END_EVENT",
    () => "stream.unshift() after end event",
  );
  const ERR_INVALID_RETURN_VALUE = makeNodeError(
    TypeError,
    "ERR_INVALID_RETURN_VALUE",
    (input, name, value) =>
      `Expected ${input} to be returned from the "${name}" function but got ${determineType(value)}.`,
  );

  // --- http (lib/_http_*) ------------------------------------------------------
  // Likewise only thrown on error paths; kept complete so a misbehaving request
  // (bad header, headers-after-sent, timeout, content-length mismatch) throws the
  // real coded error rather than crashing on an undefined constructor.
  const ERR_HTTP_HEADERS_SENT = makeNodeError(
    Error,
    "ERR_HTTP_HEADERS_SENT",
    (arg) => `Cannot ${arg} headers after they are sent to the client`,
  );
  const ERR_HTTP_INVALID_STATUS_CODE = makeNodeError(
    RangeError,
    "ERR_HTTP_INVALID_STATUS_CODE",
    (code) => `Invalid status code: ${code}`,
  );
  const ERR_HTTP_REQUEST_TIMEOUT = makeNodeError(
    Error,
    "ERR_HTTP_REQUEST_TIMEOUT",
    () => "Request timeout",
  );
  const ERR_HTTP_SOCKET_ASSIGNED = makeNodeError(
    Error,
    "ERR_HTTP_SOCKET_ASSIGNED",
    () => "ServerResponse has an already assigned socket",
  );
  const ERR_HTTP_SOCKET_ENCODING = makeNodeError(
    Error,
    "ERR_HTTP_SOCKET_ENCODING",
    () => "Changing the socket encoding is not allowed per RFC7230 Section 3.",
  );
  const ERR_HTTP_BODY_NOT_ALLOWED = makeNodeError(
    Error,
    "ERR_HTTP_BODY_NOT_ALLOWED",
    () => "Adding content for this request method or response status is not allowed.",
  );
  const ERR_HTTP_CONTENT_LENGTH_MISMATCH = makeNodeError(
    Error,
    "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
    (actual, expected) =>
      `Response body's content-length of ${actual} byte(s) does not match the content-length of ${expected} byte(s) set in header`,
  );
  const ERR_HTTP_INVALID_HEADER_VALUE = makeNodeError(
    TypeError,
    "ERR_HTTP_INVALID_HEADER_VALUE",
    (value, name) => `Invalid value "${value}" for header "${name}"`,
  );
  const ERR_HTTP_TRAILER_INVALID = makeNodeError(
    Error,
    "ERR_HTTP_TRAILER_INVALID",
    () => "Trailers are invalid with this transfer encoding",
  );
  const ERR_INVALID_CHAR = makeNodeError(
    TypeError,
    "ERR_INVALID_CHAR",
    (name, field) =>
      field ? `Invalid character in ${name} ["${field}"]` : `Invalid character in ${name}`,
  );
  const ERR_INVALID_HTTP_TOKEN = makeNodeError(
    TypeError,
    "ERR_INVALID_HTTP_TOKEN",
    (name, token) => `${name} must be a valid HTTP token ["${token}"]`,
  );
  const ERR_INVALID_PROTOCOL = makeNodeError(
    TypeError,
    "ERR_INVALID_PROTOCOL",
    (protocol, expectedProtocol) =>
      `Protocol "${protocol}" not supported. Expected "${expectedProtocol}"`,
  );
  const ERR_UNESCAPED_CHARACTERS = makeNodeError(
    TypeError,
    "ERR_UNESCAPED_CHARACTERS",
    (name) => `${name} contains unescaped characters`,
  );

  // --- net (lib/net.js) --------------------------------------------------------
  // Error paths only, but a couple are commonly hit: ERR_SERVER_ALREADY_LISTEN
  // and, via UVExceptionWithHostPort below, a port already in use (EADDRINUSE).
  const ERR_SERVER_ALREADY_LISTEN = makeNodeError(
    Error,
    "ERR_SERVER_ALREADY_LISTEN",
    () => "Listen method has been called more than once without closing.",
  );
  const ERR_SERVER_NOT_RUNNING = makeNodeError(
    Error,
    "ERR_SERVER_NOT_RUNNING",
    () => "Server is not running.",
  );
  const ERR_SOCKET_CLOSED = makeNodeError(Error, "ERR_SOCKET_CLOSED", () => "Socket is closed");
  const ERR_SOCKET_CLOSED_BEFORE_CONNECTION = makeNodeError(
    Error,
    "ERR_SOCKET_CLOSED_BEFORE_CONNECTION",
    () => "Socket closed before the connection was established",
  );
  const ERR_SOCKET_CONNECTION_TIMEOUT = makeNodeError(
    Error,
    "ERR_SOCKET_CONNECTION_TIMEOUT",
    () => "Socket connection timeout",
  );
  const ERR_INVALID_ADDRESS_FAMILY = makeNodeError(
    RangeError,
    "ERR_INVALID_ADDRESS_FAMILY",
    (addressType, host, port) => `Invalid address family: ${addressType} ${host}:${port}`,
  );
  const ERR_INVALID_FD_TYPE = makeNodeError(
    TypeError,
    "ERR_INVALID_FD_TYPE",
    (type) => `Unsupported fd type: ${type}`,
  );
  const ERR_INVALID_HANDLE_TYPE = makeNodeError(
    TypeError,
    "ERR_INVALID_HANDLE_TYPE",
    () => "This handle type cannot be sent",
  );
  const ERR_INVALID_IP_ADDRESS = makeNodeError(
    TypeError,
    "ERR_INVALID_IP_ADDRESS",
    (ip) => `Invalid IP address: ${ip}`,
  );
  const ERR_IP_BLOCKED = makeNodeError(
    Error,
    "ERR_IP_BLOCKED",
    (ip) => `IP(${ip}) is blocked by net.BlockList`,
  );

  // errno + host/port exception used by net.js on bind/connect/listen failures
  // (e.g. EADDRINUSE). Node exposes both a legacy `ExceptionWithHostPort` and a
  // uv-based `UVExceptionWithHostPort`; for us they're the same errno→message
  // builder, so alias the second to the first (already defined above).
  const UVExceptionWithHostPort = ExceptionWithHostPort;

  // Aggregate of several connect attempt errors (net.js "happy eyeballs").
  const AggregateBase = typeof AggregateError === "function" ? AggregateError : Error;
  class NodeAggregateError extends AggregateBase {
    constructor(errors, message) {
      super(errors, message);
      this.code = errors && errors[0] && errors[0].code;
      this.name = "AggregateError";
      this.errors = errors;
    }
  }

  module.exports = {
    hideStackFrames,
    genericNodeError,
    UVException,
    AbortError,
    ConnResetException,
    aggregateTwoErrors,
    ErrnoException,
    ExceptionWithHostPort,
    UVExceptionWithHostPort,
    NodeAggregateError,
    isErrorStackTraceLimitWritable,
    kEnhanceStackBeforeInspector,
    codes: {
      ERR_UNHANDLED_ERROR,
      ERR_FALSY_VALUE_REJECTION,
      ERR_INVALID_ARG_TYPE,
      ERR_INVALID_ARG_VALUE,
      ERR_OUT_OF_RANGE,
      ERR_PARSE_ARGS_INVALID_OPTION_VALUE,
      ERR_PARSE_ARGS_UNKNOWN_OPTION,
      ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL,
      ERR_UNKNOWN_SIGNAL,
      ERR_SOCKET_BAD_PORT,
      ERR_BUFFER_OUT_OF_BOUNDS,
      ERR_INVALID_BUFFER_SIZE,
      ERR_UNKNOWN_ENCODING,
      ERR_INVALID_URI,
      ERR_BUFFER_TOO_LARGE,
      ERR_BROTLI_INVALID_PARAM,
      ERR_ZSTD_INVALID_PARAM,
      ERR_TRAILING_JUNK_AFTER_STREAM_END,
      ERR_ZLIB_INITIALIZATION_FAILED,
      ERR_MISSING_ARGS,
      ERR_INCOMPATIBLE_OPTION_PAIR,
      ERR_ACCESS_DENIED,
      ERR_FS_FILE_TOO_LARGE,
      ERR_FS_EISDIR,
      ERR_INVALID_MIME_SYNTAX,
      // fs.js also destructures these two but only uses them in edge/async paths.
      ERR_FS_CP_EINVAL: makeSystemError("ERR_FS_CP_EINVAL"),
      // The rest of the ERR_FS_CP_* family, thrown by internal/fs/cp/cp.js on
      // every guarded branch of fs.cp (dest exists, type mismatch, unsupported
      // file type). Without them the guard itself dies as "X is not a
      // constructor" and a rejected copy looks like a successful one.
      ERR_FS_CP_DIR_TO_NON_DIR: makeSystemError("ERR_FS_CP_DIR_TO_NON_DIR"),
      ERR_FS_CP_EEXIST: makeSystemError("ERR_FS_CP_EEXIST"),
      ERR_FS_CP_FIFO_PIPE: makeSystemError("ERR_FS_CP_FIFO_PIPE"),
      ERR_FS_CP_NON_DIR_TO_DIR: makeSystemError("ERR_FS_CP_NON_DIR_TO_DIR"),
      ERR_FS_CP_SOCKET: makeSystemError("ERR_FS_CP_SOCKET"),
      ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY: makeSystemError("ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY"),
      ERR_FS_CP_UNKNOWN: makeSystemError("ERR_FS_CP_UNKNOWN"),
      ERR_INVALID_ARG_TYPE_RANGE: ERR_OUT_OF_RANGE,
      // streams
      ERR_METHOD_NOT_IMPLEMENTED,
      ERR_MULTIPLE_CALLBACK,
      ERR_ILLEGAL_CONSTRUCTOR,
      ERR_STREAM_ALREADY_FINISHED,
      ERR_STREAM_CANNOT_PIPE,
      ERR_STREAM_DESTROYED,
      ERR_STREAM_NULL_VALUES,
      ERR_STREAM_WRITE_AFTER_END,
      ERR_STREAM_PREMATURE_CLOSE,
      ERR_STREAM_UNABLE_TO_PIPE,
      ERR_STREAM_PUSH_AFTER_EOF,
      ERR_STREAM_UNSHIFT_AFTER_END_EVENT,
      ERR_INVALID_RETURN_VALUE,
      // http
      ERR_HTTP_HEADERS_SENT,
      ERR_HTTP_INVALID_STATUS_CODE,
      ERR_HTTP_REQUEST_TIMEOUT,
      ERR_HTTP_SOCKET_ASSIGNED,
      ERR_HTTP_SOCKET_ENCODING,
      ERR_HTTP_BODY_NOT_ALLOWED,
      ERR_HTTP_CONTENT_LENGTH_MISMATCH,
      ERR_HTTP_INVALID_HEADER_VALUE,
      ERR_HTTP_TRAILER_INVALID,
      ERR_INVALID_CHAR,
      ERR_INVALID_HTTP_TOKEN,
      ERR_INVALID_PROTOCOL,
      ERR_UNESCAPED_CHARACTERS,
      // net
      ERR_SERVER_ALREADY_LISTEN,
      ERR_SERVER_NOT_RUNNING,
      ERR_SOCKET_CLOSED,
      ERR_SOCKET_CLOSED_BEFORE_CONNECTION,
      ERR_SOCKET_CONNECTION_TIMEOUT,
      ERR_INVALID_ADDRESS_FAMILY,
      ERR_INVALID_FD_TYPE,
      ERR_INVALID_HANDLE_TYPE,
      ERR_INVALID_IP_ADDRESS,
      ERR_IP_BLOCKED,
    },
  };
}