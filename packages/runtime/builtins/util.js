// A small subset of Node's `util`: format, inspect, inherits, promisify,
// deprecate, and TextEncoder/Decoder passthrough.

export function createUtil({ Buffer }) {
  function inspect(v, seen) {
    seen = seen || new Set();
    const t = typeof v;
    if (v === null) return "null";
    if (t === "undefined") return "undefined";
    if (t === "string") return `'${v.replace(/'/g, "\\'")}'`;
    if (t === "number" || t === "boolean" || t === "bigint") return String(v);
    if (t === "symbol") return v.toString();
    if (t === "function") return `[Function: ${v.name || "anonymous"}]`;
    if (Buffer && Buffer.isBuffer(v))
      return `<Buffer ${Array.from(v, (b) => b.toString(16).padStart(2, "0")).join(" ")}>`;
    if (v instanceof Error) return v.stack || String(v);
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    let result;
    if (Array.isArray(v)) {
      result = v.length ? `[ ${v.map((x) => inspect(x, seen)).join(", ")} ]` : "[]";
    } else {
      const keys = Object.keys(v);
      const body = keys.map((k) => {
        const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`;
        return `${key}: ${inspect(v[k], seen)}`;
      });
      result = body.length ? `{ ${body.join(", ")} }` : "{}";
    }
    seen.delete(v);
    return result;
  }

  function format(...args) {
    if (typeof args[0] !== "string") {
      return args.map((a) => (typeof a === "string" ? a : inspect(a))).join(" ");
    }
    let i = 1;
    let str = args[0].replace(/%[sdifjoO%]/g, (m) => {
      if (m === "%%") return "%";
      if (i >= args.length) return m;
      const a = args[i++];
      switch (m) {
        case "%s":
          return typeof a === "object" && a !== null ? inspect(a) : String(a);
        case "%d":
          return String(Number(a));
        case "%i":
          return String(parseInt(a, 10));
        case "%f":
          return String(parseFloat(a));
        case "%j":
          try {
            return JSON.stringify(a);
          } catch {
            return "[Circular]";
          }
        case "%o":
        case "%O":
          return inspect(a);
        default:
          return m;
      }
    });
    for (; i < args.length; i++) {
      const a = args[i];
      str += " " + (typeof a === "string" ? a : inspect(a));
    }
    return str;
  }

  function inherits(ctor, superCtor) {
    ctor.super_ = superCtor;
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: { value: ctor, enumerable: false, writable: true, configurable: true },
    });
  }

  function promisify(fn) {
    return (...args) =>
      new Promise((resolve, reject) => {
        fn(...args, (err, ...values) =>
          err ? reject(err) : resolve(values.length > 1 ? values : values[0]),
        );
      });
  }

  function deprecate(fn) {
    return fn; // no-op: we don't emit deprecation warnings
  }

  return {
    format,
    inspect,
    inherits,
    promisify,
    deprecate,
    TextEncoder,
    TextDecoder,
    types: {
      isDate: (v) => v instanceof Date,
      isRegExp: (v) => v instanceof RegExp,
      isNativeError: (v) => v instanceof Error,
    },
  };
}
