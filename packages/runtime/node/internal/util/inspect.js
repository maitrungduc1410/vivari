// internal/util/inspect — a compatible BRIDGE (not vendored verbatim).
//
// Node's real internal/util/inspect.js is ~2800 lines and destructures native
// V8 introspection through internalBinding('util') (getPromiseDetails,
// getProxyDetails, previewEntries, getConstructorName, getExternalValue, …) that
// has no pure-JS equivalent. Rather than stub all of that, we implement the
// public contract that Node's real lib/util.js and lib/events.js consume:
//   inspect(value, opts)   — a good-enough recursive formatter
//   format(...)            — printf-style, backing console.log
//   formatWithOptions(o,…) — same, with inspect options
//   stripVTControlCharacters(s)
//   identicalSequenceRange(a, b) — used by events' error-stack dedup
//
// This is the one seam in Path B that is deliberately ours, not Node's. It can
// graduate to the real inspect once the introspection bindings exist.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const customInspectSymbol = Symbol.for("nodejs.util.inspect.custom");

  // Node's color table (name -> [openCode, closeCode]); lib/util.js iterates it
  // in getStyleCache. Values match Node's util.inspect.colors.
  const colors = {
    __proto__: null,
    reset: [0, 0],
    bold: [1, 22],
    dim: [2, 22],
    italic: [3, 23],
    underline: [4, 24],
    blink: [5, 25],
    inverse: [7, 27],
    hidden: [8, 28],
    strikethrough: [9, 29],
    doubleunderline: [21, 24],
    black: [30, 39],
    red: [31, 39],
    green: [32, 39],
    yellow: [33, 39],
    blue: [34, 39],
    magenta: [35, 39],
    cyan: [36, 39],
    white: [37, 39],
    bgBlack: [40, 49],
    bgRed: [41, 49],
    bgGreen: [42, 49],
    bgYellow: [43, 49],
    bgBlue: [44, 49],
    bgMagenta: [45, 49],
    bgCyan: [46, 49],
    bgWhite: [47, 49],
    gray: [90, 39],
    grey: [90, 39],
    redBright: [91, 39],
    greenBright: [92, 39],
    yellowBright: [93, 39],
    blueBright: [94, 39],
    magentaBright: [95, 39],
    cyanBright: [96, 39],
    whiteBright: [97, 39],
  };

  const styles = {
    __proto__: null,
    special: "cyan",
    number: "yellow",
    bigint: "yellow",
    boolean: "yellow",
    undefined: "grey",
    null: "bold",
    string: "green",
    symbol: "green",
    date: "magenta",
    regexp: "red",
    module: "underline",
  };

  const quoteString = (s) => {
    if (!s.includes("'")) return `'${s}'`;
    if (!s.includes('"')) return `"${s}"`;
    return `'${s.replace(/'/g, "\\'")}'`;
  };

  const fnName = (fn) => {
    const isClass = /^class[\s{]/.test(Function.prototype.toString.call(fn).slice(0, 6));
    const kind = isClass ? "class" : "Function";
    return fn.name ? `[${kind}: ${fn.name}]` : `[${kind} (anonymous)]`;
  };

  function formatValue(value, ctx, depth) {
    const t = typeof value;
    if (value === null) return "null";
    if (t === "undefined") return "undefined";
    if (t === "boolean" || t === "number") return String(value);
    if (t === "bigint") return `${value}n`;
    if (t === "string") return depth === 0 ? value : quoteString(value);
    if (t === "symbol") return value.toString();
    if (t === "function") return decorateProps(value, ctx, depth, fnName(value));

    // Honour a user/lib-defined custom inspector (Buffer sets one).
    const custom = value[customInspectSymbol];
    if (typeof custom === "function") {
      try {
        const r = custom.call(value, ctx.depth == null ? null : ctx.depth - depth, ctx, inspect);
        return typeof r === "string" ? r : formatValue(r, ctx, depth);
      } catch {
        /* fall through to default formatting */
      }
    }

    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
    if (value instanceof RegExp) return RegExp.prototype.toString.call(value);
    if (value instanceof Date)
      return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();

    if (ctx.seen.includes(value)) return "[Circular *1]";
    if (ctx.depth != null && depth > ctx.depth) {
      return Array.isArray(value) ? "[Array]" : "[Object]";
    }
    ctx.seen.push(value);
    try {
      return formatRaw(value, ctx, depth);
    } finally {
      ctx.seen.pop();
    }
  }

  function formatRaw(value, ctx, depth) {
    if (Array.isArray(value)) {
      const items = value.map((v) => formatValue(v, ctx, depth + 1));
      return decorateProps(value, ctx, depth, wrap("[", "]", items), value.length);
    }
    if (value instanceof Map) {
      const items = [];
      for (const [k, v] of value)
        items.push(`${formatValue(k, ctx, depth + 1)} => ${formatValue(v, ctx, depth + 1)}`);
      return `Map(${value.size}) ${wrap("{", "}", items)}`;
    }
    if (value instanceof Set) {
      const items = [];
      for (const v of value) items.push(formatValue(v, ctx, depth + 1));
      return `Set(${value.size}) ${wrap("{", "}", items)}`;
    }
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const items = Array.prototype.map.call(value, (v) =>
        typeof v === "bigint" ? `${v}n` : String(v),
      );
      const ctorName = value.constructor ? value.constructor.name : "TypedArray";
      return `${ctorName}(${value.length}) ${wrap("[", "]", items)}`;
    }

    const keys = Object.keys(value);
    for (const s of Object.getOwnPropertySymbols(value)) {
      if (Object.getOwnPropertyDescriptor(value, s).enumerable) keys.push(s);
    }
    const items = keys.map((k) => {
      const label = typeof k === "symbol" ? `[${k.toString()}]` : keyLabel(k);
      return `${label}: ${formatValue(value[k], ctx, depth + 1)}`;
    });
    const prefix = ctorPrefix(value);
    return `${prefix}${wrap("{", "}", items)}`;
  }

  // Append any extra (non-index) own props to arrays/functions, mirroring Node.
  function decorateProps(value, ctx, depth, base, skipIndices = 0) {
    const extra = [];
    for (const k of Object.keys(value)) {
      if (skipIndices && /^(?:0|[1-9]\d*)$/.test(k) && Number(k) < skipIndices) continue;
      extra.push(`${keyLabel(k)}: ${formatValue(value[k], ctx, depth + 1)}`);
    }
    if (extra.length === 0) return base;
    return `${base} ${wrap("{", "}", extra)}`;
  }

  const keyLabel = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : quoteString(k));

  function ctorPrefix(value) {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype) return "";
    if (proto === null) return "[Object: null prototype] ";
    const name = proto.constructor && proto.constructor.name;
    return name && name !== "Object" ? `${name} ` : "";
  }

  function wrap(open, close, items) {
    if (items.length === 0) return open === "[" ? "[]" : "{}";
    const oneLine = `${open} ${items.join(", ")} ${close}`;
    if (oneLine.length <= 72 && !oneLine.includes("\n")) return oneLine;
    const indented = items.map((i) => `  ${i.replace(/\n/g, "\n  ")}`).join(",\n");
    return `${open}\n${indented}\n${close}`;
  }

  function inspect(value, opts) {
    let ctx;
    if (typeof opts === "boolean") ctx = { depth: 2, showHidden: opts };
    else ctx = { depth: 2, ...(opts || {}) };
    if (ctx.depth === null) ctx.depth = null;
    ctx.seen = [];
    return formatValue(value, ctx, 0);
  }
  inspect.custom = customInspectSymbol;
  inspect.colors = colors;
  inspect.styles = styles;
  inspect.defaultOptions = { depth: 2, colors: false, showHidden: false };

  // ---- format / formatWithOptions (printf) --------------------------------

  const formatRegExp = /%[sdifjoOc%]/g;

  function formatWithOptions(inspectOptions, ...args) {
    const first = args[0];
    let a = 0;
    let str = "";
    let join = "";
    if (typeof first === "string") {
      if (args.length === 1) return first;
      let lastPos = 0;
      for (let i = 0; i < first.length - 1; i++) {
        if (first.charCodeAt(i) === 37) {
          // '%'
          const nextChar = first.charCodeAt(++i);
          if (a + 1 !== args.length) {
            let repl;
            switch (nextChar) {
              case 115: // %s
                {
                  const val = args[++a];
                  if (typeof val === "number") repl = String(val);
                  else if (typeof val === "bigint") repl = `${val}n`;
                  else if (typeof val !== "object" || val === null) repl = String(val);
                  else repl = inspect(val, { ...inspectOptions, depth: 0 });
                }
                break;
              case 106: // %j
                repl = tryStringify(args[++a]);
                break;
              case 100: // %d
                {
                  const val = args[++a];
                  repl =
                    typeof val === "bigint"
                      ? `${val}n`
                      : typeof val === "symbol"
                        ? "NaN"
                        : String(Number(val));
                }
                break;
              case 79: // %O
                repl = inspect(args[++a], inspectOptions);
                break;
              case 111: // %o
                repl = inspect(args[++a], { ...inspectOptions, showHidden: true, depth: 4 });
                break;
              case 105: // %i
                repl = String(parseInt(args[++a], 10));
                break;
              case 102: // %f
                repl = String(parseFloat(args[++a]));
                break;
              case 99: // %c (CSS — ignored in a terminal)
                a += 1;
                repl = "";
                break;
              case 37: // %%
                str += first.slice(lastPos, i);
                lastPos = i + 1;
                continue;
              default:
                continue;
            }
            if (lastPos !== i - 1) str += first.slice(lastPos, i - 1);
            str += repl;
            lastPos = i + 1;
          } else if (nextChar === 37) {
            str += first.slice(lastPos, i);
            lastPos = i + 1;
          }
        }
      }
      if (lastPos !== 0) {
        a++;
        join = " ";
        if (lastPos < first.length) str += first.slice(lastPos);
      }
      // When no specifier matched, `a` stays 0 and the tail loop below emits
      // args[0] (the format string) itself — exactly as Node does.
    }
    while (a < args.length) {
      const value = args[a];
      str += join;
      str += typeof value !== "string" ? inspect(value, inspectOptions) : value;
      join = " ";
      a++;
    }
    return str;
  }

  function format(...args) {
    return formatWithOptions(undefined, ...args);
  }

  function tryStringify(arg) {
    try {
      return JSON.stringify(arg);
    } catch (err) {
      if (err instanceof RangeError) return "[Circular]";
      throw err;
    }
  }

  // ---- misc ---------------------------------------------------------------

  const ansiPattern =
    "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))";
  const ansiRegex = new RegExp(ansiPattern, "g");
  function stripVTControlCharacters(str) {
    if (typeof str !== "string") throw new TypeError('The "str" argument must be of type string');
    return str.replace(ansiRegex, "");
  }

  // Verbatim logic from Node's inspect.js: longest common run of >3 frames.
  function identicalSequenceRange(a, b) {
    for (let i = 0; i < a.length - 3; i++) {
      const pos = b.indexOf(a[i]);
      if (pos !== -1) {
        const rest = b.length - pos;
        if (rest > 3) {
          let len = 1;
          const maxLen = Math.min(a.length - i, rest);
          while (maxLen > len && a[i + len] === b[pos + len]) len++;
          if (len > 3) return [len, i];
        }
      }
    }
    return [0, 0];
  }

  module.exports = {
    inspect,
    format,
    formatWithOptions,
    stripVTControlCharacters,
    identicalSequenceRange,
  };
}
