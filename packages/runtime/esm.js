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
// import (-> a Promise), and import.meta (url/filename/dirname/resolve, plus
// Bun's dir/file/path/env/main/resolveSync when the Bun global is installed —
// see importMetaSource). Named/default/namespace
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

// Keywords after which a `/` begins a regex literal, not division. Bundlers
// routinely omit the space (`return/re/.test(x)`, `typeof/re/`), so a single
// previous-char check misreads the `/` as division and then mis-lexes the
// regex body — desyncing the whole scan and losing later top-level `export`s.
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "case", "do", "else", "yield", "await", "throw",
]);

// Whether the `/` at `src[i]` can start a regex literal (vs. be a division).
// A `/` is a regex start after nothing, after most operators/punctuation, or
// after a regex-preceding keyword; it is division after an identifier, number,
// or a closing `)`/`]`/`}`.
function canStartRegex(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true; // start of input
  const p = src[j];
  if ("(,=:[!&|?{};+-*%<>~^".includes(p)) return true;
  if (/[\w$]/.test(p)) {
    // Read the identifier/keyword ending at j; a regex follows only keywords.
    let k = j;
    while (k >= 0 && /[\w$]/.test(src[k])) k--;
    return REGEX_PRECEDING_KEYWORDS.has(src.slice(k + 1, j + 1));
  }
  return false;
}

// The `import.meta` object, as source — one statement, no newlines, because the
// whole prelude sits on ONE leading line so user code line numbers survive. It is
// split out of helpers() because half of it is conditional and all of it is worth
// testing directly: scripts/spike-bun-offline.mjs evaluates this string against a
// stub require/module instead of booting a kernel.
//
// url + resolve + filename/dirname are the Node set. Node has exposed
// `import.meta.filename` / `import.meta.dirname` (for file: modules) since
// v20.11, and modern bundled ESM uses them directly instead of the older
// `fileURLToPath(import.meta.url)` shim — e.g. unplugin 2.x:
//   const LOADER = resolve(import.meta.dirname, "webpack/loaders/transform.mjs");
// Without them `import.meta.dirname` is undefined and path.resolve throws
// (`"paths[0]" argument must be of type string`).
//
// The BUN ones
// (path/dir/file/env/main/resolveSync — https://bun.com/docs/api/import-meta) are
// installed only when the Bun global is present, i.e. only in a process started
// by /bin/bun.js. That gate is not tidiness: `import.meta.env` in particular is
// NOT a Node member, and defining it as an alias of process.env for every module
// would turn a Vite SSR file's `import.meta.env.MODE` from a loud TypeError on
// `undefined` into a quiet `undefined` — the exact silent-wrongness this shim
// exists to avoid. Bun draws the same line from the other side: invoked as node,
// it turns its own env behaviour off.
//
// `globalThis.Bun` rather than a bare `typeof Bun`: a module is free to declare
// its own top-level `const Bun`, and this prelude runs in that same scope, so a
// bare reference would hit the TDZ and throw before the module body starts.
export function importMetaSource(fileUrl, filename) {
  const fp = filename || "";
  const idx = fp.lastIndexOf("/");
  const dir = idx < 0 ? "." : idx === 0 ? "/" : fp.slice(0, idx);
  const file = idx < 0 ? fp : fp.slice(idx + 1);
  const J = JSON.stringify;
  // `.main` is the entrypoint IDENTITY question, and only the loader can answer
  // it: `require.main` is a live getter onto the module runMain() published as
  // the entry (module.js), and `__oc_module` is this module's own record — so
  // this is the ESM spelling of `require.main === module`, not a path-string
  // comparison (which would disagree the moment a bin shim, a symlink or a
  // realpath rewrite made argv[1] differ from the file we actually loaded). If a
  // require without that seam ever reaches here we cannot answer, so we say so.
  const noMain =
    "import.meta.main cannot be determined: this module was loaded by a require " +
    "without the loader's entry-module link, so the runtime does not know which " +
    "module is the process entrypoint";
  const noResolver =
    "import.meta.resolveSync is unavailable: this module was loaded by a require " +
    "with no resolver attached";
  const noProcess = "import.meta.env is unavailable: this realm has no process object";
  return (
    "const __oc_meta={url:" + J(fileUrl) +
      ",filename:" + J(fp) +
      ",dirname:" + J(dir) +
      ",resolve:function(s){return __oc_require.resolve?__oc_require.resolve(s):s;}};" +
    "if(globalThis.Bun){" +
      // path/dir/file are Bun's names for filename/dirname/basename. `.file` is
      // the basename WITH its extension ("index.tsx"), per Bun's docs.
      "__oc_meta.path=" + J(fp) + ";__oc_meta.dir=" + J(dir) + ";__oc_meta.file=" + J(file) + ";" +
      // resolveSync(specifier, parent?) — the second argument is the importing
      // MODULE, not a directory: Bun's own typings define this overload as
      // `Bun.resolveSync(moduleId, path.dirname(parent))`, so we take the dirname.
      // (Bun.resolveSync itself takes the directory directly — see builtins/bun.js.)
      "__oc_meta.resolveSync=function(s,p){" +
        "if(!__oc_require.resolve)throw new Error(" + J(noResolver) + ");" +
        "if(p===undefined||p===null)return __oc_require.resolve(s);" +
        "var b=String(p);if(b.slice(0,7)==='file://')b=b.slice(7);" +
        "var i=b.lastIndexOf('/');" +
        "return __oc_require.resolve(s,{paths:[i>0?b.slice(0,i):(i===0?'/':'.')]});};" +
      "Object.defineProperty(__oc_meta,'env',{enumerable:true,configurable:true,get:function(){" +
        "var p=globalThis.process;if(!p)throw new Error(" + J(noProcess) + ");return p.env;}});" +
      "Object.defineProperty(__oc_meta,'main',{enumerable:true,configurable:true,get:function(){" +
        "if(!__oc_require||!('main' in __oc_require))throw new Error(" + J(noMain) + ");" +
        "return __oc_require.main===__oc_module;}});" +
    "}"
  );
}

// Per-module interop helpers + import.meta, kept on ONE leading line so user
// code line numbers are preserved. They close over the wrapper's `require`/
// `__filename`, so dynamic import + import.meta.resolve resolve relative to the
// importing module.
function helpers(fileUrl, filename) {
  return (
    "const __oc_def=function(m){return m&&m.__esModule?m.default:m;};" +
    "const __oc_ns=function(m){if(m&&m.__esModule)return m;var ns=Object.create(null);if(m)for(var k of Object.keys(m)){Object.defineProperty(ns,k,{enumerable:true,configurable:true,get:(function(k){return function(){return m[k];};})(k)});}ns.default=m;Object.defineProperty(ns,'__esModule',{value:true});return ns;};" +
    // Each getter MUST close over its OWN `k` (per-iteration IIFE), not the shared
    // loop `var k` — otherwise every re-exported name resolves to the LAST key of
    // `m`. That desync silently collapses all of `export * from 'x'`'s names onto
    // one value (e.g. vue's `index.mjs` re-exports everything, so `createApp`
    // became `withScopeId` — Nuxt SSR then read `.config` off the wrong object).
    "const __oc_star=function(e,m){if(m)for(var k of Object.keys(m)){if(k!=='default'&&!(k in e))Object.defineProperty(e,k,{enumerable:true,configurable:true,get:(function(k){return function(){return m[k];};})(k)});}};" +
    // Dynamic import() must resolve to a MODULE NAMESPACE, not the raw require() value:
    // Node wraps a CJS target as { default: module.exports, ...ownKeys }. Returning the
    // bare exports left a CJS default-import with no `default` — real code mostly reads
    // it via __oc_def on the STATIC path so it went unnoticed, but Vite's SSR module
    // runner asserts `'default' in mod` for externalized CJS deps
    // (analyzeImportedModDifference) and threw "Named export 'default' not found. The
    // requested module 'cssesc' is a CommonJS module…" on astro. __oc_ns is a no-op for
    // an ESM target (already __esModule) and synthesizes the namespace for CJS.
    "const __oc_import=function(s){return Promise.resolve().then(function(){return __oc_ns(__oc_require(s));});};" +
    importMetaSource(fileUrl, filename)
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
      if (canStartRegex(src, i)) {
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
      if (canStartRegex(src, i)) {
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
      // `export` is only a keyword when a real export form follows: `default`,
      // `{`, `*`, or a declaration (function/class/const/let/var/async/... —
      // i.e. an identifier-start char). When the next token is `:` / `.` / `(`
      // / `=` / `,` etc. this `export` is actually a property name or member
      // access (`{ export: x }`, `obj.export`, `export()`), NOT a statement.
      // Stripping it there corrupts the code (e.g. `export: name` -> `: name`,
      // "Unexpected token ':'"). Skip it and keep scanning.
      const follow = src[r];
      if (follow !== "{" && follow !== "*" && !/[A-Za-z_$]/.test(follow || " ")) {
        i += 6;
        continue;
      }
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
  // Named imports (`import { X } from 'm'`). We record each so that (a) an eager
  // `const X = m.X` snapshot is only emitted when X is actually referenced in the
  // module body, and (b) a re-export of X (`export { X }`) becomes a LAZY live
  // binding to the source module instead of reading the eager snapshot. This makes
  // barrel files that import-then-re-export a name behave like `export { X } from 'm'`
  // (which we already treat lazily) — the fix for astro's render/index.js, which does
  // `import { Fragment } from './common.js'; export { ...Fragment... }`. common.js is
  // mid-cycle when render/index.js loads, so the eager `const Fragment = common.Fragment`
  // hit common.js's still-TDZ `const Fragment` getter → "Cannot access 'Fragment'
  // before initialization". A lazy re-export defers the read until after the cycle.
  const namedImports = new Map(); // local -> { m, imported }
  const deferredNamedConsts = []; // { local, m, imported } — emitted only if used in body
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
            // Emit the re-export getter EARLY (in exportGetters, before the prelude
            // requires) and resolve the source module LAZILY via __oc_require (cached)
            // rather than closing over `m` (declared later in the prelude). Otherwise a
            // circular importer that reads this re-exported name mid-cycle sees `undefined`
            // (the getter isn't defined yet) and silently snapshots it — no TDZ throw, so
            // the live-binding fallback never fires. astro's middleware/index.js barrel
            // re-exports `sequence` while render-context.js eagerly imports it, and
            // render-context read `undefined` → `sequence(...)` later → "Function.prototype
            // .apply was called on undefined". __oc_require is cached, so re-resolving in
            // the getter returns the same (possibly mid-cycle, but hoisted) module.
            exportGetters.push(
              "Object.defineProperty(__oc_exports," + JSON.stringify(local) +
              ",{enumerable:true,configurable:true,get:function(){return __oc_require(" + JSON.stringify(spec) + ")[" + JSON.stringify(imported) + "];}});",
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
          // Defer: we only need the eager `const local = m.imported` snapshot if the
          // body actually references `local`. If it's only re-exported, we skip the
          // snapshot (avoiding a cyclic TDZ read) and wire a lazy getter below.
          namedImports.set(local, { m, imported, spec });
          deferredNamedConsts.push({ local, m, imported });
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

  // Decide which deferred named-import snapshots are actually needed. Build a "code
  // only" view of the source with every import statement and every local `export {…}`
  // clause blanked, so an imported name that appears ONLY in those statements reads as
  // unused. Strings/comments are left intact and count as a use, so the check errs
  // toward KEEPING the eager snapshot (current behaviour) — it only ever removes a
  // snapshot when the name is provably absent from executable code.
  if (deferredNamedConsts.length) {
    const masked = source.split("");
    const blank = (s, e) => { for (let k = s; k < e && k < masked.length; k++) if (masked[k] !== "\n") masked[k] = " "; };
    for (const imp of imports) if (imp.t === T_STATIC) blank(imp.ss, imp.se);
    for (const e of exportEdits) if (/^export\s*\{/.test(source.slice(e.start, e.end))) blank(e.start, e.end);
    const maskedStr = masked.join("");
    const usedInBody = (name) => {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Any identifier-boundaried occurrence counts as a use. We deliberately do NOT
      // try to discount `obj.X` member access: a `.`-preceded match is ambiguous with
      // spread/rest `...X` (e.g. `[...SVELTE_DEDUPED_IMPORTS]`, `...SUPPORTED_MARKDOWN_
      // FILE_EXTENSIONS`), and mis-classifying a real spread use as "unused" drops the
      // eager `const` → "X is not defined". Keeping an occasional truly-unused const is
      // harmless; dropping a needed one is not — so we err toward keeping.
      return new RegExp("(?:^|[^\\w$])" + esc + "(?![\\w$])").test(maskedStr);
    };
    for (const nc of deferredNamedConsts) {
      if (usedInBody(nc.local)) {
        prelude.push("const " + nc.local + "=" + nc.m + "[" + JSON.stringify(nc.imported) + "];");
      }
    }
  }

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
        const src = namedImports.get(ex.ln);
        if (src) {
          exportGetters.push(
            "Object.defineProperty(__oc_exports,'default',{enumerable:true,configurable:true,get:function(){return __oc_require(" +
              JSON.stringify(src.spec) + ")[" + JSON.stringify(src.imported) + "];}});",
          );
        } else {
          exportGetters.push(
            "Object.defineProperty(__oc_exports,'default',{enumerable:true,configurable:true,get:function(){return " +
              ex.ln + ";}});",
          );
        }
      }
      continue;
    }
    // `export { X }` where X is itself a named import → re-export as a LAZY live binding
    // to the source module, emitted EARLY (before the requires) and resolved via
    // __oc_require, so a circular importer reading it mid-cycle gets a defined getter, not
    // undefined / a mid-TDZ eager snapshot. (See the `export … from` note above.)
    const src = namedImports.get(local);
    if (src) {
      exportGetters.push(
        "Object.defineProperty(__oc_exports," + JSON.stringify(ex.n) +
        ",{enumerable:true,configurable:true,get:function(){return __oc_require(" + JSON.stringify(src.spec) + ")[" + JSON.stringify(src.imported) + "];}});",
      );
      continue;
    }
    exportGetters.push(
      "Object.defineProperty(__oc_exports," + JSON.stringify(ex.n) +
      ",{enumerable:true,configurable:true,get:function(){return " + local + ";}});",
    );
  }
  const fileUrl = "file://" + (filename || "");
  const head =
    helpers(fileUrl, filename) +
    // Mark the module ESM, but defensively: some CJS/ESM-hybrid bundles (e.g. rsbuild
    // v2's dev-server middleware chunks) already carry an `__esModule` on their exports
    // object (an accessor, or a non-configurable data prop) before our head runs, so a
    // bare `Object.defineProperty(exports,'__esModule',{value:true})` throws
    // "Cannot redefine property: __esModule". Define it configurable (so the module's own
    // later re-define can't clash) and fall back to assignment if the property is locked.
    "try{Object.defineProperty(__oc_exports,'__esModule',{value:true,configurable:true});}catch(_e){try{__oc_exports.__esModule=true;}catch(__e){}}" +
    // Export getters first (local live bindings + lazy re-export getters, both visible to
    // circular importers before this module's body runs), then the import requires.
    exportGetters.join("") +
    prelude.join("");
  // The CJS-interop override runs AFTER the body (so the local binding exists) and
  // intentionally replaces the whole exports object: require() returns it verbatim,
  // matching `export { x as "module.exports" }` semantics. The override value is
  // authored to carry its own default/named props, so dropping our getters is fine.
  const tail = cjsOverride ? "\n;__oc_module.exports=" + cjsOverride + ";" : "";
  return head + applyEdits(source, edits) + tail;
}

/**
 * LIVE-BINDING variant of transpileEsm — a runtime FALLBACK, not the default path.
 *
 * `transpileEsm` snapshots each named import eagerly (`const X = __oc_m['X']`). In a
 * circular import of a `const`/`class`/singleton (astro's runtime is full of them —
 * `apiContextRoutesSymbol`, `AstroConfigSchema`, `globalContentLayer`, `telemetry`, …)
 * that eager read fires while the source module is mid-cycle → "Cannot access 'X'
 * before initialization". Real ESM avoids this because imports are LIVE bindings: a
 * reference reads the source binding lazily, at use — by which point the cycle has
 * resolved (uses are typically inside functions called later, not at module top level).
 *
 * We model that here by binding every import onto an `__oc_live` object as a getter and
 * running the whole module body inside `with (__oc_live) { … }`. A bare reference to an
 * import name then resolves through the getter (lazy), while any local declaration that
 * shadows it wins natively — so this is scope-correct WITHOUT reference rewriting (no
 * risk of clobbering a shadowing param/const). The cost: `with` deopts and needs sloppy
 * mode, so module.js only compiles a module this way AFTER the eager version throws a
 * TDZ/"not defined" ReferenceError. Normal modules never pay for it.
 *
 * Caveats (acceptable for the fallback): assignment to an imported binding is a silent
 * no-op (real ESM throws); a module whose import is used at TOP-LEVEL init inside a
 * cycle still can't be satisfied (the source truly isn't ready yet — same as real ESM
 * would deadlock/return undefined). Returns null for non-ESM (same contract as transpileEsm).
 */
export function transpileEsmLive(source, filename) {
  let parsed;
  try {
    parsed = parse(source, filename || "module");
  } catch {
    return null;
  }
  const [imports, exports, , hasModuleSyntax] = parsed;
  if (!hasModuleSyntax) return null;

  const edits = [];
  const prelude = []; // requires
  const reexportEarly = []; // lazy re-export getters, emitted BEFORE the requires
  const liveDefs = []; // getters on __oc_live for each imported binding
  const localGetters = []; // export getters for local names (run INSIDE the `with`)
  const fromRanges = [];
  const namedImports = new Map();
  let tmp = 0;
  const uniq = () => "__oc_m" + tmp++;
  const defLive = (name, expr) =>
    "Object.defineProperty(__oc_live," + JSON.stringify(name) +
    ",{configurable:true,get:function(){return " + expr + ";}});";

  for (const imp of imports) {
    if (imp.t === T_DYNAMIC) { edits.push({ start: imp.ss, end: imp.d, text: "__oc_import" }); continue; }
    if (imp.t === T_META) { edits.push({ start: imp.ss, end: imp.se, text: "__oc_meta" }); continue; }
    if (imp.t !== T_STATIC) continue;
    const stmt = source.slice(imp.ss, imp.se);
    const spec = imp.n;
    edits.push({ start: imp.ss, end: imp.se, text: "" });
    if (spec == null) continue;
    if (stmt.startsWith("export")) {
      fromRanges.push([imp.ss, imp.se]);
      const clause = stmt.slice(6).trimStart();
      const m = uniq();
      prelude.push("const " + m + "=__oc_require(" + JSON.stringify(spec) + ");");
      if (clause.startsWith("*")) {
        const rest = clause.slice(1).trimStart();
        const asMatch = rest.match(new RegExp("^as\\s+(" + ID + ")"));
        if (asMatch) prelude.push("__oc_exports[" + JSON.stringify(asMatch[1]) + "]=__oc_ns(" + m + ");");
        else prelude.push("__oc_star(__oc_exports," + m + ");");
      } else {
        for (const { imported, local } of namedFromBraces(clause)) {
          if (imported === "default") prelude.push("__oc_exports[" + JSON.stringify(local) + "]=__oc_def(" + m + ");");
          // Lazy re-require, emitted early (before requires) — see transpileEsm note.
          else reexportEarly.push("Object.defineProperty(__oc_exports," + JSON.stringify(local) + ",{enumerable:true,configurable:true,get:function(){return __oc_require(" + JSON.stringify(spec) + ")[" + JSON.stringify(imported) + "];}});");
        }
      }
    } else {
      const clause = stmt.slice(6).trimStart();
      const c = parseImportClause(clause);
      if (c.sideEffect) { prelude.push("__oc_require(" + JSON.stringify(spec) + ");"); }
      else {
        const m = uniq();
        prelude.push("const " + m + "=__oc_require(" + JSON.stringify(spec) + ");");
        if (c.default) liveDefs.push(defLive(c.default, "__oc_def(" + m + ")"));
        if (c.namespace) liveDefs.push(defLive(c.namespace, "__oc_ns(" + m + ")"));
        for (const { imported, local } of c.named) {
          namedImports.set(local, { m, imported, spec });
          liveDefs.push(defLive(local, m + "[" + JSON.stringify(imported) + "]"));
        }
      }
    }
  }

  const inFrom = (pos) => fromRanges.some(([s, e]) => pos >= s && pos < e);
  const exportEdits = scanExportEdits(source, inFrom);
  const hasKeywordDefault = exportEdits.some((e) => e.text === "__oc_exports.default =");
  const keptDefault = exportEdits.find((e) => e.defaultLocal)?.defaultLocal;
  if (keptDefault) {
    localGetters.push("Object.defineProperty(__oc_exports,'default',{enumerable:true,configurable:true,get:function(){return " + keptDefault + ";}});");
  }
  for (const e of exportEdits) edits.push(e);

  let cjsOverride = null;
  for (const ex of exports) {
    if (inFrom(ex.s)) continue;
    const local = ex.ln || ex.n;
    if (ex.n === "module.exports") { if (ex.ln) cjsOverride = ex.ln; continue; }
    if (ex.n === "default") {
      if (!hasKeywordDefault && !keptDefault && ex.ln) {
        const src = namedImports.get(ex.ln);
        if (src) reexportEarly.push("Object.defineProperty(__oc_exports,'default',{enumerable:true,configurable:true,get:function(){return __oc_require(" + JSON.stringify(src.spec) + ")[" + JSON.stringify(src.imported) + "];}});");
        else localGetters.push("Object.defineProperty(__oc_exports,'default',{enumerable:true,configurable:true,get:function(){return " + ex.ln + ";}});");
      }
      continue;
    }
    const src = namedImports.get(local);
    if (src) {
      reexportEarly.push("Object.defineProperty(__oc_exports," + JSON.stringify(ex.n) + ",{enumerable:true,configurable:true,get:function(){return __oc_require(" + JSON.stringify(src.spec) + ")[" + JSON.stringify(src.imported) + "];}});");
      continue;
    }
    localGetters.push("Object.defineProperty(__oc_exports," + JSON.stringify(ex.n) + ",{enumerable:true,configurable:true,get:function(){return " + local + ";}});");
  }

  // A leading "use strict" directive makes `with` a SyntaxError — strip it (the module
  // still runs under our sloppy `new Function` wrapper, same as the eager variant).
  let body = applyEdits(source, edits).replace(/^\uFEFF?\s*(["'])use strict\1\s*;?/, "");

  const fileUrl = "file://" + (filename || "");
  const head =
    helpers(fileUrl, filename) +
    "try{Object.defineProperty(__oc_exports,'__esModule',{value:true,configurable:true});}catch(_e){try{__oc_exports.__esModule=true;}catch(__e){}}" +
    "const __oc_live=Object.create(null);" +
    reexportEarly.join("") +
    prelude.join("") +
    liveDefs.join("");
  const tail = cjsOverride ? "\n;__oc_module.exports=" + cjsOverride + ";" : "";
  // Local export getters go INSIDE the `with` so their closures capture the body's
  // (block-scoped) top-level const/let bindings.
  return head + "with(__oc_live){" + localGetters.join("") + body + "\n}" + tail;
}