// ESM -> CJS transpiler (Phase 2 #13, "S1"). Our module system is synchronous
// CommonJS (module.js), so instead of a spec ESM loader we rewrite `import`/
// `export` down to our existing require/exports at load time — exactly what a
// bundler's interop layer does. es-module-lexer (vendored, pure-JS asm build,
// SYNC, no wasm/init) robustly locates every import/re-export statement, dynamic
// `import()`, `import.meta`, and every export name; we do the rewrite.
//
// Covered: static import (default/named/namespace/side-effect), re-export
// (`export {x} from`, `export * from`, `export * as ns from`), local exports
// (const/let/var/function/class + `export {}` + `export default`), dynamic
// import (-> a Promise), and import.meta.url/resolve. Named/default/namespace
// interop with CJS uses the standard __esModule rules. Live bindings are modeled
// with getters. Known casualties (documented): top-level await (our wrapper is a
// sync function) and exact circular-eval ordering.

import { parse } from "./node/vendor/es-module-lexer.js";

// es-module-lexer ImportType
const T_STATIC = 1;
const T_DYNAMIC = 2;
const T_META = 3;

const ID = "[A-Za-z_$][\\w$]*";

// Per-module interop helpers + import.meta, kept on ONE leading line so user
// code line numbers are preserved. They close over the wrapper's `require`/
// `__filename`, so dynamic import + import.meta.resolve resolve relative to the
// importing module.
function helpers(fileUrl) {
  return (
    "const __oc_def=function(m){return m&&m.__esModule?m.default:m;};" +
    "const __oc_ns=function(m){if(m&&m.__esModule)return m;var ns=Object.create(null);if(m)for(var k of Object.keys(m)){Object.defineProperty(ns,k,{enumerable:true,configurable:true,get:(function(k){return function(){return m[k];};})(k)});}ns.default=m;Object.defineProperty(ns,'__esModule',{value:true});return ns;};" +
    "const __oc_star=function(e,m){if(m)for(var k of Object.keys(m)){if(k!=='default'&&!(k in e))Object.defineProperty(e,k,{enumerable:true,configurable:true,get:function(){return m[k];}});}};" +
    "const __oc_import=function(s){return Promise.resolve().then(function(){return __oc_require(s);});};" +
    "const __oc_meta={url:" + JSON.stringify(fileUrl) + ",resolve:function(s){return __oc_require.resolve?__oc_require.resolve(s):s;}};"
  );
}

function namedFromBraces(text) {
  const m = text.match(/\{([\s\S]*?)\}/);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const bits = part.split(/\s+as\s+/);
      const imported = bits[0].trim();
      const local = (bits[1] || bits[0]).trim();
      return { imported, local };
    });
}

// Parse the binding clause of a plain `import <clause> from 'x'` (or side-effect).
function parseImportClause(clause) {
  clause = clause.trim();
  if (clause[0] === '"' || clause[0] === "'") return { sideEffect: true, named: [] };
  const fromIdx = clause.search(/\bfrom\b/);
  const bindings = (fromIdx >= 0 ? clause.slice(0, fromIdx) : clause).trim();
  const out = { default: null, namespace: null, named: [], sideEffect: false };
  const ns = bindings.match(new RegExp("\\*\\s*as\\s+(" + ID + ")"));
  if (ns) out.namespace = ns[1];
  out.named = namedFromBraces(bindings);
  const lead = bindings.trimStart();
  if (!lead.startsWith("{") && !lead.startsWith("*")) {
    const dm = lead.match(new RegExp("^(" + ID + ")"));
    if (dm) out.default = dm[1];
  }
  return out;
}

// A string/comment/template-aware scan that finds top-level `export` keywords and
// emits edits to make the body valid CJS (the exports object itself is built from
// the lexer's export-name list). `isFrom(pos)` marks re-export statements already
// removed via the imports pass, which we skip here.
function scanExportEdits(src, isFrom) {
  const edits = [];
  const n = src.length;
  let i = 0;
  const isId = (c) => /[\w$]/.test(c);
  const prevSignificant = () => {
    let j = i - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    return src[j];
  };
  while (i < n) {
    const c = src[i];
    // skip line comment
    if (c === "/" && src[i + 1] === "/") {
      i += 2;
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    // skip block comment
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // skip strings + templates
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        // (nested template ${} is skipped coarsely; export can't legally start
        // inside one at top level, so we don't descend)
        i++;
      }
      continue;
    }
    // skip regex literal (best-effort: only when a '/' can start a regex)
    if (c === "/") {
      const p = prevSignificant();
      const canRegex = p === undefined || "(,=:[!&|?{};+-*%<>~^".includes(p);
      if (canRegex) {
        i++;
        let inClass = false;
        while (i < n) {
          if (src[i] === "\\") { i += 2; continue; }
          if (src[i] === "[") inClass = true;
          else if (src[i] === "]") inClass = false;
          else if (src[i] === "/" && !inClass) { i++; break; }
          else if (src[i] === "\n") break;
          i++;
        }
        continue;
      }
      i++;
      continue;
    }
    // candidate `export` keyword?
    if (
      c === "e" &&
      src.startsWith("export", i) &&
      !isId(src[i - 1] || " ") &&
      !isId(src[i + 6] || " ")
    ) {
      if (isFrom(i)) { i += 6; continue; }
      let r = i + 6;
      while (r < n && /\s/.test(src[r])) r++;
      if (src.startsWith("default", r) && !isId(src[r + 7] || " ")) {
        // export default <expr>  ->  exports.default = <expr>
        edits.push({ start: i, end: r + 7, text: "exports.default =" });
        i = r + 7;
        continue;
      }
      if (src[r] === "{") {
        // export { ... }  (local, or re-export handled elsewhere)
        let j = r + 1;
        while (j < n && src[j] !== "}") j++;
        let k = j + 1;
        while (k < n && /\s/.test(src[k])) k++;
        if (src.startsWith("from", k)) {
          // re-export; leave for the imports pass to remove
          i = j + 1;
          continue;
        }
        edits.push({ start: i, end: j + 1, text: "" });
        i = j + 1;
        continue;
      }
      if (src[r] === "*") {
        // export * ... : handled via the imports pass; leave alone
        i = r + 1;
        continue;
      }
      // export <decl> : strip just the `export ` keyword
      edits.push({ start: i, end: r, text: "" });
      i = r;
      continue;
    }
    i++;
  }
  return edits;
}

function applyEdits(src, edits) {
  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let last = 0;
  for (const e of edits) {
    if (e.start < last) continue; // drop overlaps defensively
    out += src.slice(last, e.start) + e.text;
    last = e.end;
  }
  out += src.slice(last);
  return out;
}

/**
 * Transpile ESM source to our CJS. Returns the rewritten source, or null if the
 * file has no module syntax at all (pure CJS — load it unchanged).
 */
export function transpileEsm(source, filename) {
  let parsed;
  try {
    parsed = parse(source, filename || "module");
  } catch {
    return null; // let the CJS path try (and surface a real error)
  }
  const [imports, exports, , hasModuleSyntax] = parsed;
  if (!hasModuleSyntax) return null;

  const edits = [];
  const prelude = []; // hoisted lines (helpers, requires, export getters)
  const fromRanges = [];
  let tmp = 0;
  const uniq = () => "__oc_m" + tmp++;

  for (const imp of imports) {
    if (imp.t === T_DYNAMIC) {
      edits.push({ start: imp.ss, end: imp.d, text: "__oc_import" });
      continue;
    }
    if (imp.t === T_META) {
      edits.push({ start: imp.ss, end: imp.se, text: "__oc_meta" });
      continue;
    }
    if (imp.t !== T_STATIC) continue;

    const stmt = source.slice(imp.ss, imp.se);
    const spec = imp.n;
    edits.push({ start: imp.ss, end: imp.se, text: "" });

    if (spec == null) continue; // unanalyzable specifier; drop (rare)

    if (stmt.startsWith("export")) {
      fromRanges.push([imp.ss, imp.se]);
      const clause = stmt.slice(6).trimStart();
      const m = uniq();
      prelude.push("const " + m + "=__oc_require(" + JSON.stringify(spec) + ");");
      if (clause.startsWith("*")) {
        const rest = clause.slice(1).trimStart();
        const asMatch = rest.match(new RegExp("^as\\s+(" + ID + ")"));
        if (asMatch) {
          prelude.push("exports[" + JSON.stringify(asMatch[1]) + "]=__oc_ns(" + m + ");");
        } else {
          prelude.push("__oc_star(exports," + m + ");");
        }
      } else {
        for (const { imported, local } of namedFromBraces(clause)) {
          if (imported === "default") {
            prelude.push("exports[" + JSON.stringify(local) + "]=__oc_def(" + m + ");");
          } else {
            prelude.push(
              "Object.defineProperty(exports," + JSON.stringify(local) +
              ",{enumerable:true,configurable:true,get:function(){return " + m + "[" + JSON.stringify(imported) + "];}});",
            );
          }
        }
      }
    } else {
      const clause = stmt.slice(6).trimStart();
      const c = parseImportClause(clause);
      if (c.sideEffect) {
        prelude.push("__oc_require(" + JSON.stringify(spec) + ");");
      } else {
        const m = uniq();
        prelude.push("const " + m + "=__oc_require(" + JSON.stringify(spec) + ");");
        if (c.default) prelude.push("const " + c.default + "=__oc_def(" + m + ");");
        if (c.namespace) prelude.push("const " + c.namespace + "=__oc_ns(" + m + ");");
        for (const { imported, local } of c.named) {
          prelude.push("const " + local + "=" + m + "[" + JSON.stringify(imported) + "];");
        }
      }
    }
  }

  // local exports -> getters (skip re-exports already handled above; default is
  // handled by the keyword rewrite in the body).
  const inFrom = (pos) => fromRanges.some(([s, e]) => pos >= s && pos < e);
  for (const ex of exports) {
    if (inFrom(ex.s)) continue;
    if (ex.n === "default") continue;
    const local = ex.ln || ex.n;
    prelude.push(
      "Object.defineProperty(exports," + JSON.stringify(ex.n) +
      ",{enumerable:true,configurable:true,get:function(){return " + local + ";}});",
    );
  }

  // body edits: strip/rewrite export keywords
  for (const e of scanExportEdits(source, inFrom)) edits.push(e);

  const fileUrl = "file://" + (filename || "");
  const head =
    helpers(fileUrl) +
    "Object.defineProperty(exports,'__esModule',{value:true});" +
    prelude.join("");
  return head + applyEdits(source, edits);
}
