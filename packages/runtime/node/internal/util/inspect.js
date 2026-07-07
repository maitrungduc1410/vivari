// internal/util/inspect — minimal.
//
// Node's real inspect is thousands of lines. lib/buffer.js only needs it to
// render a Buffer's *extra* (non-index) properties when you console.log one, so
// a compact formatter is plenty here. This is the module that graduates to
// vendored-real when we tackle `util` proper (Phase 2, later in this item).

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  function inspect(value, opts, depth = 0) {
    const seen = opts && opts.__seen ? opts.__seen : new Set();
    const t = typeof value;
    if (value === null) return "null";
    if (t === "string") return depth === 0 ? value : `'${value.replace(/'/g, "\\'")}'`;
    if (t === "number" || t === "boolean" || t === "undefined" || t === "bigint")
      return String(value) + (t === "bigint" ? "n" : "");
    if (t === "symbol") return value.toString();
    if (t === "function") return `[Function: ${value.name || "anonymous"}]`;
    if (seen.has(value)) return "[Circular]";
    if (depth > 4) return Array.isArray(value) ? "[Array]" : "[Object]";
    seen.add(value);
    const nextOpts = { ...(opts || {}), __seen: seen };
    try {
      if (Array.isArray(value)) {
        return "[ " + value.map((v) => inspect(v, nextOpts, depth + 1)).join(", ") + " ]";
      }
      const keys = Object.keys(value);
      const body = keys
        .map((k) => `${k}: ${inspect(value[k], nextOpts, depth + 1)}`)
        .join(", ");
      return body ? `{ ${body} }` : "{}";
    } finally {
      seen.delete(value);
    }
  }

  module.exports = { inspect };
}
