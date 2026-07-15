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
// with getters. Top-level await is supported for the ENTRY module (module.js
// recompiles a TLA body as an AsyncFunction and run() awaits it while driving the
// loop); a non-entry module `require()`d synchronously still can't block on its
// TLA. Known casualty: exact circular-eval ordering.

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

// --- robust source skimming: strings, template literals (with ${} interpolation),
// comments. Returns the index just PAST the construct. A coarse template skip that
// ignores ${} can desync the export scanner on modern bundled code (a `}` or
// backtick inside an interpolation), leaving a real `export` unrewritten — which
// then throws "Unexpected token 'export'" at compile. These descend correctly.
function skipQuoted(src, i) {
  const q = src[i++];
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === q) return i + 1;
    if (ch === "\n") return i; // unterminated (defensive) — don't run off the end
    i++;
  }
  return i;
}
function skipTemplate(src, i) {
  const n = src.length;
  i++; // past opening backtick
  while (i < n) {
    const ch = src[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "`") return i + 1;
    if (ch === "$" && src[i + 1] === "{") {
      i = skipBalanced(src, i + 2); // skip the ${ ... } expression
      continue;
    }
    i++;
  }
  return i;
}
// i is just after `${` (or after `{`); skip to the matching `}`, descending into
// nested strings/templates/braces/comments.
function skipBalanced(src, i) {
  const n = src.length;
  let depth = 1;
  while (i < n && depth > 0) {
    const ch = src[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === '"' || ch === "'") { i = skipQuoted(src, i); continue; }
    if (ch === "`") { i = skipTemplate(src, i); continue; }
    if (ch === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (ch === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    // regex literal — must descend so its inner quotes/slashes don't desync the
    // brace scan. Real bundled code puts regexes inside `${...}` interpolations
    // (e.g. `` `"${v.replaceAll(/"|\\/g, "\\$&")}"` ``); the `"` in the regex was
    // being misread as a string, swallowing the matching `}` and losing later
    // top-level `export`s. Same canRegex heuristic as scanExportEdits.
    if (ch === "/") {
      let j = i - 1;
      while (j >= 0 && /\s/.test(src[j])) j--;
      const p = src[j];
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
    if (ch === "{") { depth++; i++; continue; }
    if (ch === "}") { depth--; i++; continue; }
    i++;
  }
  return i;
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
    // skip strings + templates (templates descend into ${} interpolations so a
    // brace/backtick inside an expression can't desync the scan)
    if (c === '"' || c === "'") { i = skipQuoted(src, i); continue; }
    if (c === "`") { i = skipTemplate(src, i); continue; }
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
        // A NAMED `export default function foo`/`class foo` is a *declaration*: it
        // binds `foo` at module scope (and, for functions, hoists it). Rewriting it
        // to `__oc_exports.default = function foo(){}` demotes it to an expression,
        // so `foo` is no longer a local binding — any later reference to it (e.g.
        // `export { foo as 'module.exports' }`, as cliui/index.mjs does) then throws
        // "foo is not defined". Keep the declaration intact (strip only `export
        // default `) and record the name so transpileEsm wires exports.default via a
        // lazy getter (which is safe for both hoisted functions and TDZ classes).
        let d = r + 7;
        while (d < n && /\s/.test(src[d])) d++;
        const declMatch = /^(?:async\s+)?function(?:\s*\*)?\s+([A-Za-z_$][\w$]*)|^class\s+([A-Za-z_$][\w$]*)/.exec(src.slice(d));
        if (declMatch) {
          edits.push({ start: i, end: d, text: "", defaultLocal: declMatch[1] || declMatch[2] });
          i = d;
          continue;
        }
        // export default <expr>  ->  __oc_exports.default = <expr>
        edits.push({ start: i, end: r + 7, text: "__oc_exports.default =" });
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
 * Rewrite dynamic `import()` in a PURE-CJS module so it routes through our
 * synchronous loader instead of the host realm's native `import()`. Without this,
 * a `const x = await import('esm-only-pkg')` inside a CommonJS file (e.g. npm's
 * chalk@5 usage) escapes the sandbox — the host Node resolves the specifier
 * against our runtime source dir and throws ERR_MODULE_NOT_FOUND. Returns the
 * rewritten source, or null if there are no dynamic imports to rewrite.
 *
 * Only for CJS: ESM files already get their dynamic imports rewritten by
 * transpileEsm. The injected `__oc_import` closes over the CJS wrapper's own
 * `require`, so relative specifiers resolve from the importing module, and it
 * synthesizes an ESM-style namespace (with `default`) for CJS targets.
 */
export function rewriteCjsDynamicImport(source, filename) {
  let parsed;
  try {
    parsed = parse(source, filename || "module");
  } catch {
    return null;
  }
  const imports = parsed[0];
  const edits = [];
  for (const imp of imports) {
    if (imp.t === T_DYNAMIC) edits.push({ start: imp.ss, end: imp.d, text: "__oc_import" });
  }
  if (!edits.length) return null;
  // One leading line (preserves user line numbers). Uses the wrapper's `require`.
  // The `(typeof m==='object'||typeof m==='function')` guard is load-bearing: Node's
  // CJS→ESM interop makes named exports from module.exports' OWN enumerable keys — and
  // that must include a FUNCTION export's statics. The `module` builtin export IS the
  // `Module` class with `createRequire`/`builtinModules`/… hung off it, and PGlite's
  // Emscripten glue does `const { createRequire } = await import('module')`; keying only
  // objects dropped it, surfacing as a minified "e is not a function" in PGlite.create().
  const head =
    "const __oc_import=function(s){return Promise.resolve().then(function(){" +
    "var m=require(s);if(m&&m.__esModule)return m;" +
    "var ns=Object.create(null);if(m&&(typeof m==='object'||typeof m==='function'))for(var k of Object.keys(m))ns[k]=m[k];ns.default=m;return ns;" +
    "});};";
  return head + applyEdits(source, edits);
}

/**
 * Rewrite dynamic `import()` in a FUNCTION-CONSTRUCTOR BODY so it routes through
 * our loader instead of the host realm's native `import()`.
 *
 * Some libraries deliberately obtain a "clean" dynamic import that transpilers
 * won't touch by building it at runtime: `new Function('s','return import(s)')`
 * (piscina & tinypool worker harnesses do exactly this). The Function
 * constructor compiles that string in the host realm, so the inner `import()`
 * escapes the sandbox and can't see our VFS. The Function-constructor wrapper
 * (index.js) feeds such bodies here; we point each dynamic import at the global
 * `__ocImport` shim (loader-backed). Returns the rewritten body, or null when
 * there are no dynamic imports to redirect.
 */
export function rewriteDynamicImportToGlobal(body) {
  let parsed;
  try {
    parsed = parse(body, "fn");
  } catch {
    return null;
  }
  const edits = [];
  for (const imp of parsed[0]) {
    if (imp.t === T_DYNAMIC) edits.push({ start: imp.ss, end: imp.d, text: "globalThis.__ocImport" });
  }
  if (!edits.length) return null;
  return applyEdits(body, edits);
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
  const prelude = []; // import requires + import-derived bindings + re-export getters
  // Local export getters (for `export function/class/const`, `export {local}`,
  // named `export default`). Emitted BEFORE the import requires so a circular
  // import that reads this module's exports mid-cycle sees a live binding rather
  // than `undefined`: an exported (hoisted) function is already reachable through
  // the getter even before this module's body runs. This is the ESM live-binding
  // contract — real transpilers (esbuild/rollup) model it the same way. yargs is
  // the canonical case: command.js `import { isYargsInstance }` <-> yargs-factory.js.
  const exportGetters = [];
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
          prelude.push("__oc_exports[" + JSON.stringify(asMatch[1]) + "]=__oc_ns(" + m + ");");
        } else {
          prelude.push("__oc_star(__oc_exports," + m + ");");
        }
      } else {
        for (const { imported, local } of namedFromBraces(clause)) {
          if (imported === "default") {
            prelude.push("__oc_exports[" + JSON.stringify(local) + "]=__oc_def(" + m + ");");
          } else {
            prelude.push(
              "Object.defineProperty(__oc_exports," + JSON.stringify(local) +
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

  const inFrom = (pos) => fromRanges.some(([s, e]) => pos >= s && pos < e);

  // body edits: strip/rewrite export keywords. Computed first so we can tell an
  // `export default <expr>` keyword form (rewritten to `exports.default = ...`)
  // apart from `export { x as default }` (brace form, handled below).
  const exportEdits = scanExportEdits(source, inFrom);
  const hasKeywordDefault = exportEdits.some((e) => e.text === "__oc_exports.default =");
  // A named `export default function/class` we kept as a declaration: wire
  // exports.default to the surviving local binding via a lazy getter.
  const keptDefault = exportEdits.find((e) => e.defaultLocal)?.defaultLocal;
  if (keptDefault) {
    exportGetters.push(
      "Object.defineProperty(__oc_exports,'default',{enumerable:true,configurable:true,get:function(){return " +
        keptDefault + ";}});",
    );
  }
  for (const e of exportEdits) edits.push(e);

  // local exports -> getters, with two special cases the plain getter loop misses:
  //  - `export { X as "module.exports" }`: the standard CJS-interop override
  //    (rolldown/tsdown emit it, e.g. @vitejs/plugin-react). Node makes require()
  //    return X verbatim; we mirror that by reassigning module.exports after the
  //    body defines X.
  //  - `export { X as default }` (brace form): the keyword rewrite never sees a
  //    `default` token here, so wire exports.default to the local X ourselves.
  let cjsOverride = null;
  for (const ex of exports) {
    if (inFrom(ex.s)) continue;
    const local = ex.ln || ex.n;
    if (ex.n === "module.exports") {
      if (ex.ln) cjsOverride = ex.ln;
      continue;
    }
    if (ex.n === "default") {
      if (!hasKeywordDefault && !keptDefault && ex.ln) {
        exportGetters.push(
          "Object.defineProperty(__oc_exports,'default',{enumerable:true,configurable:true,get:function(){return " +
            ex.ln + ";}});",
        );
      }
      continue;
    }
    exportGetters.push(
      "Object.defineProperty(__oc_exports," + JSON.stringify(ex.n) +
      ",{enumerable:true,configurable:true,get:function(){return " + local + ";}});",
    );
  }

  const fileUrl = "file://" + (filename || "");
  const head =
    helpers(fileUrl) +
    "Object.defineProperty(__oc_exports,'__esModule',{value:true});" +
    // Local export getters first (live bindings visible to circular importers),
    // then import requires + import-derived bindings + re-export getters.
    exportGetters.join("") +
    prelude.join("");
  // The CJS-interop override runs AFTER the body (so the local binding exists) and
  // intentionally replaces the whole exports object: require() returns it verbatim,
  // matching `export { x as "module.exports" }` semantics. The override value is
  // authored to carry its own default/named props, so dropping our getters is fine.
  const tail = cjsOverride ? "\n;__oc_module.exports=" + cjsOverride + ";" : "";
  return head + applyEdits(source, edits) + tail;
}
