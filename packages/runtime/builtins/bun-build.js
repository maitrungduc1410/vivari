// Bun.build + Bun.plugin — a REAL bundler (dependency graph, npm dependencies,
// CJS/ESM interop) and the plugin hooks around it, on top of Vivari's own module
// machinery. Wired into the `Bun` global by ./bun.js and into `bun build` by
// packages/kernel-host/programs/bun.js; the runtime-side plugin hooks are called
// from packages/runtime/module.js.
//
// ============================================================================
// THE OUTPUT IS NOT BYTE-IDENTICAL TO REAL BUN'S. Say it here, say it in the
// docs, say it in the error messages.
// ============================================================================
// Bun's bundler is a Zig program with its own parser, scope hoister, tree shaker
// and printer. This is a different bundler that produces a DIFFERENT FILE for the
// same input — different module wrapping, different ordering, no tree shaking, no
// renaming. What it promises is that the output RUNS and computes the same thing,
// not that it diffs clean against `bun build` on your laptop. Do not file a bug
// about the bytes; do file one about behaviour.
//
// Two semantic divergences fall out of the design and are worth knowing before
// you read the code:
//   * every module is wrapped in a CommonJS-shaped factory and linked through a
//     tiny registry, even for `format: "esm"`. That is how the Vivari runtime
//     itself executes ESM (packages/runtime/esm.js rewrites import/export down to
//     require at load time), so a bundle behaves exactly like the same project run
//     with `bun <entry>` HERE. Real Bun hoists modules into one scope. The
//     observable difference is live bindings: see `collectExportNames` below.
//   * no tree shaking. An unused export keeps its module, and a module with side
//     effects always runs. Output is bigger than Bun's and never smaller.
//
// ---- why this bundler, and not esbuild-wasm ---------------------------------
// The obvious move is to delegate to esbuild-wasm: it is already aliased
// (runtime/toolchain-shims.js) and already patched to run in-thread
// (runtime/esbuild-inproc-patch.js), and it is a far better bundler than this one.
// It was rejected for four reasons, in order of weight:
//
//   1. `Bun.build` takes no dependency. That is not an incidental property of
//      Bun, it is the whole selling point of a batteries-included runtime — a Bun
//      project that bundles has no bundler in its package.json, so requiring one
//      would make `Bun.build` throw on essentially every real Bun project until
//      the author installed something Bun never asked them for. "Throws loudly"
//      is better than "lies", but it is much worse than "works".
//   2. Vivari cannot hand esbuild-wasm over for free. It is ~10 MB of Go/wasm; it
//      is not in the runtime tree, and putting it there means either committing
//      10 MB or fetching it from the network the first time somebody calls
//      Bun.build in a tab. Neither is a thing a browser sandbox should do behind
//      the caller's back.
//   3. Resolution would stop matching the runtime's. The graph here is walked with
//      the loader's OWN resolveFilename (packages/runtime/module.js) — the same
//      conditions, the same `exports` handling, the same node_modules walk, the
//      same TS/JSX transform — so what the bundle contains is what `require`
//      would have loaded in this VM. esbuild's resolver is excellent and it is
//      not ours, and a bundle that resolves differently from the runtime it was
//      built in is a debugging trap.
//   4. Testability. The kernel spike tier is OFFLINE (no registry), so an
//      esbuild-backed Bun.build could only ever be proven in the slow network
//      tier. The load-bearing proof would move to the least-run job.
//
// The cost of that choice is paid in the OPTION POLICY below: `minify`,
// `splitting` and `sourcemap` are real compiler work this bundler does not do, so
// they THROW, naming esbuild/rolldown as what to reach for when you need them. A
// build that quietly ignored `minify` and reported success is the one outcome
// this file exists to prevent.
//
// ---- option policy ----------------------------------------------------------
// Same three answers as bun-serve.js, chosen the same way: IMPLEMENT when the
// sandbox and this bundler genuinely can; DEGRADE LOUDLY when the option is
// meaningful but inert here; THROW when honouring it is real unwritten work and
// pretending otherwise would ship a wrong artifact. There is no fourth answer,
// and in particular there is no "accept and ignore".
//
// ---- Bun.plugin -------------------------------------------------------------
// Two lifetimes share one plugin shape. A plugin registered with `Bun.plugin()`
// is a RUNTIME plugin: it rewrites what `require`/`import` see in the process
// that registered it (the seam is in module.js). A plugin passed as
// `Bun.build({ plugins })` is a BUILD plugin and only affects that build. The
// registry below is deliberately per-realm — one process, one set of runtime
// plugins — which is Bun's model too.
//
// Runtime plugins must be SYNCHRONOUS here, and that is not negotiable: the
// module loader is synchronous all the way down to Atomics.wait (AGENTS.md golden
// rule 3), so there is nowhere to await. A runtime hook that returns a thenable
// throws instead of being silently ignored. Build plugins may be async — a build
// is a Promise already.

import { transpileTypeScript } from "../typescript-transform.js";
import { transpileEsm, rewriteCjsDynamicImport } from "../esm.js";
import { parse as lexModule } from "../node/vendor/es-module-lexer.js";
import { wyhash } from "./bun-hash.js";

// The extensions this bundler knows how to turn into JavaScript, and the Bun
// loader name each maps to. Anything else is a build ERROR naming the file: Bun
// has css/file/napi/wasm/sh loaders, this one does not, and inventing an empty
// module for `import "./app.css"` would produce a bundle that silently lost the
// stylesheet.
export const LOADER_BY_EXT = {
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".json": "json",
  ".txt": "text",
};

// Bun's default entry naming template.
export const DEFAULT_ENTRY_NAMING = "[dir]/[name].[ext]";

const TARGETS = ["browser", "bun", "node"];
const FORMATS = ["esm", "cjs", "iife"];

/**
 * The message shape for an option this bundler will not pretend to honour. Same
 * split as bun-unsupported.js: "not implemented in the Vivari shim" means
 * possible-but-unwritten, which is what all of these are — nothing here is
 * blocked by the browser.
 */
function unimplemented(option, reason) {
  return new Error(
    `Bun.build({ ${option} }) is not implemented in the Vivari shim: ${reason} ` +
      `It throws rather than being ignored, because a build that reported success ` +
      `without honouring ${option} would hand you an artifact that is wrong in a way ` +
      `nothing tells you about. For a production bundle with this option, run a real ` +
      `bundler in-VM instead — esbuild (installs as esbuild-wasm here), rolldown and ` +
      `rspack all work.`,
  );
}

// ---- option normalisation ---------------------------------------------------
// Pure: takes the options object and a {path, cwd} host, returns the config the
// bundler runs on plus the warnings bun.js prints once per process. Everything
// that can be rejected is rejected HERE, so a bad option fails at the Bun.build()
// call rather than half way through writing files.
export function normalizeBuildOptions(options, host) {
  const opts = options || {};
  const path = host.path;
  const cwd = host.cwd || "/";
  const warnings = [];
  const warn = (key, message) => warnings.push({ key, message });

  // ---- THROW: real compiler work this bundler does not do -------------------
  if (opts.minify) {
    throw unimplemented(
      "minify",
      "this bundler has no minifier — it does not rename identifiers, drop dead " +
        "code or reprint the AST, and a whitespace-only pass would be a rounding " +
        "error next to what Bun's minifier does.",
    );
  }
  if (opts.splitting) {
    throw unimplemented(
      "splitting",
      "code splitting means computing which modules are shared between entry points " +
        "and emitting them as separately-loadable chunks; this bundler emits exactly " +
        "one file per entry point, with shared modules duplicated into each.",
    );
  }
  if (opts.sourcemap !== undefined && opts.sourcemap !== false && opts.sourcemap !== "none") {
    throw unimplemented(
      "sourcemap",
      "the transform chain (type strip -> JSX lowering -> ESM rewrite -> module " +
        "wrapping) carries no position mappings, so any map emitted here would point " +
        "at the wrong lines — which is worse than no map, because a debugger believes it.",
    );
  }
  if (opts.bytecode) {
    throw unimplemented("bytecode", "bytecode caching is a JavaScriptCore feature, and this runtime is not JavaScriptCore.");
  }
  if (opts.compile) {
    throw new Error(
      "Bun.build({ compile }) is not supported in Vivari (browser sandbox): it emits a " +
        "standalone NATIVE executable with the Bun runtime embedded, and a browser tab can " +
        "neither produce nor run one.",
    );
  }
  for (const [key, why] of [
    ["publicPath", "there is no asset pipeline here to rewrite URLs for — this bundler emits no assets."],
    ["loader", "custom per-extension loaders need loader plugins this bundler does not have; the built-in set is js/jsx/ts/tsx/json/txt."],
    ["drop", "dropping calls (`console`, `debugger`) is an AST rewrite, and this bundler does not reprint the AST."],
    ["conditions", "export-condition overrides would have to be threaded into the runtime's own resolver, which resolves with a fixed condition set."],
    ["packages", "`packages: \"external\"` needs a bare-vs-relative split at resolve time that this bundler does not model; list the packages in `external` instead."],
    ["env", "inlining `process.env` at build time is a define-generation pass over the real environment, and getting the SET of keys wrong silently changes the artifact."],
  ]) {
    if (opts[key] !== undefined) throw unimplemented(key, why);
  }

  // ---- entrypoints ----------------------------------------------------------
  const entrypoints = opts.entrypoints;
  if (!Array.isArray(entrypoints) || entrypoints.length === 0) {
    throw new TypeError("Bun.build({ entrypoints }) must be a non-empty array of paths");
  }
  const entries = entrypoints.map((e) => {
    if (typeof e !== "string" || !e) throw new TypeError("Bun.build({ entrypoints }) entries must be non-empty strings");
    return path.resolve(cwd, e);
  });

  // ---- target / format ------------------------------------------------------
  const target = opts.target === undefined ? "browser" : opts.target;
  if (!TARGETS.includes(target)) {
    throw new TypeError(`Bun.build({ target }) must be one of ${TARGETS.join(", ")}, got ${JSON.stringify(target)}`);
  }
  const format = opts.format === undefined ? "esm" : opts.format;
  if (!FORMATS.includes(format)) {
    throw new TypeError(`Bun.build({ format }) must be one of ${FORMATS.join(", ")}, got ${JSON.stringify(format)}`);
  }

  // ---- naming ---------------------------------------------------------------
  // `naming` as a string is the ENTRY template (Bun's shorthand). The chunk and
  // asset templates can only ever be dead configuration here — there are no
  // chunks without `splitting` (which throws above) and no assets without the
  // loaders that produce them — so they throw rather than sit in the config
  // looking effective.
  let entryNaming = DEFAULT_ENTRY_NAMING;
  if (typeof opts.naming === "string") entryNaming = opts.naming;
  else if (opts.naming && typeof opts.naming === "object") {
    if (opts.naming.entry) entryNaming = opts.naming.entry;
    if (opts.naming.chunk !== undefined) {
      throw unimplemented("naming.chunk", "this bundler emits no chunks (see `splitting`), so a chunk template can never apply.");
    }
    if (opts.naming.asset !== undefined) {
      throw unimplemented("naming.asset", "this bundler emits no assets — a non-JS import is a build error, not a copied file.");
    }
  } else if (opts.naming !== undefined) {
    throw new TypeError("Bun.build({ naming }) must be a string or an object");
  }

  // ---- root -----------------------------------------------------------------
  // Bun's `root` is what `[dir]` in a naming template is relative to. Its default
  // is the longest common directory of the entry points, which is why a single
  // entry always lands at the top of outdir.
  const root = opts.root ? path.resolve(cwd, opts.root) : commonDir(entries.map((e) => path.dirname(e)), path);

  // ---- external -------------------------------------------------------------
  const external = [];
  if (opts.external !== undefined) {
    if (!Array.isArray(opts.external)) throw new TypeError("Bun.build({ external }) must be an array of strings");
    for (const e of opts.external) {
      if (typeof e !== "string") throw new TypeError("Bun.build({ external }) entries must be strings");
      external.push(e);
    }
  }

  // ---- define ---------------------------------------------------------------
  // Bun's define values are SOURCE TEXT, not JS values: you write
  // `{ "process.env.NODE_ENV": JSON.stringify("production") }`. Accepting a
  // non-string would mean guessing whether `true` meant the boolean or the
  // identifier, so it is a TypeError.
  const define = Object.create(null);
  if (opts.define !== undefined) {
    if (typeof opts.define !== "object" || opts.define === null) throw new TypeError("Bun.build({ define }) must be an object");
    for (const [k, v] of Object.entries(opts.define)) {
      if (typeof v !== "string") {
        throw new TypeError(
          `Bun.build({ define }) values must be strings of SOURCE TEXT (got ${typeof v} for ${JSON.stringify(k)}). ` +
            `Write JSON.stringify(value) — that is Bun's contract, and it is what makes ` +
            `{"__DEV__": "false"} the boolean and {"__NAME__": "\\"app\\""} the string.`,
        );
      }
      if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(k)) {
        throw new TypeError(
          `Bun.build({ define }) keys must be an identifier or a dotted member path, got ${JSON.stringify(k)}. ` +
            `This bundler substitutes at the token level, so it can only match something it can tokenize.`,
        );
      }
      define[k] = v;
    }
  }

  // ---- outdir / banner / footer / throw ------------------------------------
  const outdir = opts.outdir ? path.resolve(cwd, opts.outdir) : null;
  const banner = opts.banner === undefined ? "" : String(opts.banner);
  const footer = opts.footer === undefined ? "" : String(opts.footer);
  // Bun 1.1 (the version this shim reports) RETURNS a failed result; `throw: true`
  // opts into the AggregateError behaviour that later versions default to. Keeping
  // the 1.1 default is deliberate — BUN_VERSION is the contract we claim.
  const shouldThrow = opts.throw === true;

  const plugins = [];
  if (opts.plugins !== undefined) {
    if (!Array.isArray(opts.plugins)) throw new TypeError("Bun.build({ plugins }) must be an array");
    for (const p of opts.plugins) {
      if (!p || typeof p.setup !== "function") throw new TypeError("Bun.build({ plugins }) entries must be objects with a setup() function");
      plugins.push(p);
    }
  }

  // ---- DEGRADE LOUDLY -------------------------------------------------------
  // An IIFE is one self-contained script, so a bundled `import.meta` has no URL to
  // report and the entry's exports have nowhere to go. Bun says the same thing by
  // simply dropping them; saying it out loud costs nothing and stops the "where
  // did my exports go" afternoon.
  if (format === "iife") {
    warn(
      "format",
      "Bun.build({ format: 'iife' }) produces a self-executing script: the entry point's " +
        "exports are evaluated but not exposed anywhere, because an IIFE has no export " +
        "syntax. Use 'esm' or 'cjs' if the output is meant to be imported.",
    );
  }

  return {
    config: { entries, outdir, target, format, entryNaming, root, external, define, banner, footer, plugins, throw: shouldThrow },
    warnings,
  };
}

/** Longest common directory of a list of absolute directories. */
export function commonDir(dirs, path) {
  if (!dirs.length) return "/";
  let parts = dirs[0].split("/");
  for (const d of dirs.slice(1)) {
    const other = d.split("/");
    let i = 0;
    while (i < parts.length && i < other.length && parts[i] === other[i]) i++;
    parts = parts.slice(0, i);
  }
  const joined = parts.join("/");
  return joined || "/";
}

/**
 * Expand a Bun naming template. Tokens: [dir] [name] [ext] [hash]. `dir` is the
 * entry's directory relative to `root` ("." for the root itself, which Bun
 * collapses away rather than emitting "./index.js").
 */
export function applyNaming(template, vars) {
  const out = template.replace(/\[(dir|name|ext|hash)\]/g, (_, key) => (vars[key] === undefined ? "" : String(vars[key])));
  // "[dir]/[name].[ext]" with dir="." yields "./index.js"; normalise the leading
  // "./" and any doubled slash so the artifact path is the one Bun writes.
  return out.replace(/^\.\//, "").replace(/\/{2,}/g, "/").replace(/^\//, "");
}

// ---- source scanning --------------------------------------------------------
// One literal-aware pass over a module's transformed source that does both jobs
// the bundler needs: find every STATIC require specifier, and substitute the
// defines. It is a tokenizer, not a parser — which is the honest description of
// its accuracy:
//   * a `require("x")` inside a string or a comment is never seen, so there are no
//     phantom dependencies (that matters: a phantom would fail to resolve and take
//     the whole build down);
//   * a COMPUTED require — `require(name)`, `require("./" + n)` — cannot be seen,
//     so it stays in the output and throws at run time from __vv_ext with a message
//     saying exactly that. Bundlers all draw this line; esbuild's wording is
//     "Dynamic require of X is not supported".
// Regex literals are skipped properly (a naive scanner reads `/["']/` as the start
// of a string and desyncs for the rest of the file).

const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw",
  "case", "do", "else", "yield", "await",
]);

const isIdentStart = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
const isIdentPart = (c) => isIdentStart(c) || (c >= "0" && c <= "9");
const isSpace = (c) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";

function skipQuoted(src, i) {
  const q = src[i++];
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === q) return i + 1;
    i++;
  }
  return i;
}
function skipTemplate(src, i) {
  const n = src.length;
  i++;
  while (i < n) {
    const ch = src[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "`") return i + 1;
    if (ch === "$" && src[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        const c = src[i];
        if (c === "\\") { i += 2; continue; }
        if (c === '"' || c === "'") { i = skipQuoted(src, i); continue; }
        if (c === "`") { i = skipTemplate(src, i); continue; }
        if (c === "{") depth++;
        else if (c === "}") depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return i;
}
function skipRegex(src, i) {
  const n = src.length;
  i++;
  let inClass = false;
  while (i < n) {
    const ch = src[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "\n") return i; // unterminated — it was division after all
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) return i + 1;
    i++;
  }
  return i;
}

// The three callee names a bundled dependency can appear under: plain CJS
// `require`, the ESM rewrite's `__oc_require` (esm.js), and `__oc_import` — the
// dynamic-import helper both rewrites inject, whose argument at the CALL SITE is
// the literal specifier.
const REQUIRE_CALLEES = new Set(["require", "__oc_require", "__oc_import"]);

/**
 * Single pass: returns { code, requires }. `defines` is the normalised
 * name -> source-text map; substitution is token-level and never touches a
 * string, a comment, or a `.foo` property access that merely shares the name.
 */
export function scanAndDefine(src, defines) {
  const requires = [];
  const defineKeys = defines ? Object.keys(defines) : [];
  const hasDefines = defineKeys.length > 0;
  // Longest first, so "process.env.NODE_ENV" wins over a define on "process".
  const sortedKeys = defineKeys.sort((a, b) => b.length - a.length);
  let out = "";
  let copied = 0;
  const n = src.length;
  let i = 0;
  let prev = ""; // last significant token: a punctuation char, or "w:<word>"
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'") { i = skipQuoted(src, i); prev = '"'; continue; }
    if (c === "`") { i = skipTemplate(src, i); prev = "`"; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === "/" && regexCanStart(prev)) { i = skipRegex(src, i); prev = "/"; continue; }
    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdentPart(src[j])) j++;
      const word = src.slice(i, j);
      const afterDot = prev === ".";

      if (!afterDot && REQUIRE_CALLEES.has(word)) {
        const lit = literalCallArgument(src, j);
        if (lit) requires.push(lit.value);
      }

      if (hasDefines && !afterDot) {
        // Read the full dotted member path starting here, then take the longest
        // define that matches it exactly. Matching a PREFIX would rewrite
        // `process.env.HOME` for a define on `process.env`, which changes the
        // meaning of the trailing access.
        let end = j;
        let pathText = word;
        for (;;) {
          let k = end;
          if (src[k] !== "." || !isIdentStart(src[k + 1] || "")) break;
          let m = k + 1;
          while (m < n && isIdentPart(src[m])) m++;
          pathText += src.slice(k, m);
          end = m;
        }
        const hit = sortedKeys.find((key) => key === pathText || (pathText.startsWith(key) && pathText[key.length] === "."));
        if (hit) {
          const consumed = i + hit.length;
          out += src.slice(copied, i) + defines[hit];
          copied = consumed;
          i = consumed;
          prev = ")";
          continue;
        }
      }

      prev = "w:" + word;
      i = j;
      continue;
    }
    if (!isSpace(c)) prev = c;
    i++;
  }
  out += src.slice(copied);
  return { code: out, requires };
}

function regexCanStart(prev) {
  if (prev === "") return true;
  if (prev.startsWith("w:")) return REGEX_PRECEDING_KEYWORDS.has(prev.slice(2));
  return "([{,;:=!&|?+-*%^~<>".includes(prev);
}

// `(  "spec"  )` immediately after a callee name -> the decoded specifier.
function literalCallArgument(src, from) {
  const n = src.length;
  let k = from;
  while (k < n && isSpace(src[k])) k++;
  if (src[k] !== "(") return null;
  k++;
  while (k < n && isSpace(src[k])) k++;
  const q = src[k];
  if (q !== '"' && q !== "'") return null;
  const end = skipQuoted(src, k);
  let m = end;
  while (m < n && isSpace(src[m])) m++;
  if (src[m] !== ")") return null;
  const raw = src.slice(k + 1, end - 1);
  let value;
  try {
    value = JSON.parse(q === '"' ? '"' + raw + '"' : '"' + raw.replace(/\\'/g, "'").replace(/"/g, '\\"') + '"');
  } catch {
    return null;
  }
  return { value };
}

// ---- per-module transform ---------------------------------------------------

/**
 * Turn one file's bytes into the JavaScript the bundle will wrap, and report what
 * it depends on. Returns { code, kind, requires, exportNames, starFrom }.
 * `kind` is "esm" or "cjs" and decides the factory signature at codegen time.
 */
export function transformModule({ source, filename, loader, define }) {
  let code = source;
  let exportNames = [];
  let starFrom = [];

  if (loader === "json") {
    // A JSON module is a value, not code — no scanning, no defines, no ESM pass.
    // Parse it here so a syntax error is a build error with the file named,
    // rather than a runtime SyntaxError inside the bundle.
    let value;
    try {
      value = JSON.parse(source);
    } catch (e) {
      throw new Error(`could not parse as JSON: ${(e && e.message) || e}`);
    }
    return {
      code: "module.exports = " + JSON.stringify(value) + ";\n",
      kind: "cjs",
      requires: [],
      exportNames: ["default", ...(value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [])],
      starFrom: [],
    };
  }
  if (loader === "text") {
    return { code: "module.exports = " + JSON.stringify(source) + ";\n", kind: "cjs", requires: [], exportNames: ["default"], starFrom: [] };
  }

  // TS/JSX first, exactly as module.js compile() orders it: the ESM pass must see
  // plain ECMAScript, and the type stripper must see the original annotations.
  if (loader === "ts" || loader === "tsx" || loader === "jsx") {
    code = transpileTypeScript(code, filename);
  }
  // Plain `.js`/`.mjs`/`.cjs` is left alone, exactly as module.js compile() leaves
  // it: routing ordinary JavaScript through the type stripper is what that gate
  // exists to prevent (see typescript-transform.js).

  // Export names come from the POST-TS, PRE-rewrite source: that is the last point
  // where `export` is still syntax. They are what an `format: "esm"` bundle
  // re-exports from its entry.
  try {
    const [imports, exports] = lexModule(code, filename);
    exportNames = exports.map((e) => e.n).filter(Boolean);
    // `export * from "./x"` contributes names the lexer cannot know; record the
    // specifier so codegen can union in that module's exports.
    for (const imp of imports) {
      if (imp.n && /(^|[\s;}])export\s*\*\s*from/.test(code.slice(imp.ss, imp.s))) starFrom.push(imp.n);
    }
  } catch {
    /* not parseable as a module — the CJS path below still applies */
  }

  const esm = transpileEsm(code, filename);
  let kind = "cjs";
  if (esm != null) {
    code = esm;
    kind = "esm";
  } else {
    const rewritten = rewriteCjsDynamicImport(code, filename);
    if (rewritten != null) code = rewritten;
    exportNames = [];
    starFrom = [];
  }

  const scanned = scanAndDefine(code, define);
  return { code: scanned.code, kind, requires: scanned.requires, exportNames, starFrom };
}

// ---- the graph walk ---------------------------------------------------------

/**
 * Bundle one entry point. `host` injects everything environment-shaped so the
 * offline spike tier can drive the SHIPPED code over host Node's fs with no
 * kernel: { fs, path, resolve(specifier, fromDir) -> {builtin, id} }.
 *
 * Returns { code, logs, externals } or throws only on a programming error —
 * user-facing failures come back as error logs, which is what makes
 * `{ success: false, logs }` possible.
 */
export async function bundleEntry({ entry, config, host, hooks }) {
  const { fs, path, resolve } = host;
  const logs = [];
  const error = (message, position) => { logs.push(makeLog("error", message, position)); };

  const modules = new Map(); // id -> { id, deps: Map<spec,id>, code, kind, file, dir, exportNames, starFrom }
  const externals = new Set();
  const order = [];

  // Resolve one specifier from one importer, honouring `external`, the target's
  // node-builtin policy, and any plugin onResolve hook.
  async function resolveSpec(spec, importer, importerDir) {
    if (isExternalSpec(spec, config.external)) { externals.add(spec); return { external: true }; }

    const hooked = await hooks.resolve(spec, importer, importerDir);
    if (hooked) {
      if (hooked.external) { externals.add(spec); return { external: true }; }
      if (hooked.namespace && hooked.namespace !== "file") {
        return { id: hooked.namespace + ":" + hooked.path, virtual: true, resolveDir: hooked.resolveDir || importerDir };
      }
      return { id: path.resolve(importerDir, hooked.path) };
    }

    let r;
    try {
      r = resolve(spec, importerDir);
    } catch (e) {
      error(
        `Could not resolve ${JSON.stringify(spec)} from ${importer}: ${(e && e.message) || e}`,
        { file: importer },
      );
      return null;
    }
    if (r.builtin) {
      // A node/bun builtin is external for the runtimes that HAVE it. For the
      // browser target it is a hard error: Bun does not polyfill node builtins for
      // the browser either, and emitting an import of "node:fs" into a browser
      // bundle would move the failure to a place with no context.
      if (config.target === "browser") {
        error(
          `Could not bundle ${JSON.stringify(spec)} for target "browser": it is a built-in module, and a ` +
            `browser has no implementation of it. Build with target "node" or "bun", or list it in ` +
            `\`external\` if the loader you deploy to provides it.`,
          { file: importer },
        );
        return null;
      }
      externals.add(spec);
      return { external: true };
    }
    return { id: r.id };
  }

  async function addModule(id, opts) {
    if (modules.has(id)) return modules.get(id);
    const virtual = !!(opts && opts.virtual);
    const record = { id, deps: new Map(), file: id, dir: virtual ? opts.resolveDir || config.root : path.dirname(id) };
    modules.set(id, record);

    // The plugin onLoad hook owns the bytes AND the loader when it matches; a
    // virtual module has no file to read, so a namespace with no onLoad is a
    // build error rather than an fs throw about a path that never existed.
    const loaded = await hooks.load(id, virtual);
    let source;
    let loader;
    if (loaded) {
      source = loaded.contents;
      loader = loaded.loader;
    } else if (virtual) {
      error(`No plugin onLoad() handled ${JSON.stringify(id)}; a module in a non-"file" namespace has no file to read.`, { file: id });
      modules.delete(id);
      return null;
    } else {
      const ext = path.extname(id);
      loader = LOADER_BY_EXT[ext];
      if (!loader) {
        error(
          `No loader for ${JSON.stringify(id)} (extension ${JSON.stringify(ext || "<none>")}). This bundler handles ` +
            `${Object.keys(LOADER_BY_EXT).join(", ")}; Bun's css/file/wasm/napi/sh loaders are not implemented here, ` +
            `and emitting an empty module for one would silently drop it from the output.`,
          { file: id },
        );
        modules.delete(id);
        return null;
      }
      try {
        source = fs.readFileSync(id, "utf8");
      } catch (e) {
        error(`Could not read ${id}: ${(e && e.message) || e}`, { file: id });
        modules.delete(id);
        return null;
      }
    }

    let transformed;
    try {
      transformed = transformModule({ source, filename: id, loader, define: config.define });
    } catch (e) {
      error(`Failed to transform ${id}: ${(e && e.message) || e}`, { file: id });
      modules.delete(id);
      return null;
    }
    record.code = transformed.code;
    record.kind = transformed.kind;
    record.exportNames = transformed.exportNames;
    record.starFrom = transformed.starFrom;

    for (const spec of dedupe(transformed.requires)) {
      const res = await resolveSpec(spec, id, record.dir);
      if (!res || res.external) continue;
      const child = await addModule(res.id, res);
      if (child) record.deps.set(spec, res.id);
    }
    order.push(record);
    return record;
  }

  const entryRecord = await addModule(entry);
  if (!entryRecord || logs.some((l) => l.level === "error")) return { logs, externals: [...externals] };

  return { code: emitBundle({ entryRecord, order, externals: [...externals], config, logs, path }), logs, externals: [...externals] };
}

function dedupe(list) {
  return [...new Set(list)];
}

/** Bun's `external` matching: exact, package-prefix (`foo` covers `foo/bar`), `*`. */
export function isExternalSpec(spec, external) {
  for (const e of external) {
    if (e === "*") return true;
    if (e === spec) return true;
    if (spec.startsWith(e + "/")) return true;
    if (e.includes("*")) {
      const rx = new RegExp("^" + e.split("*").map(escapeRegExp).join(".*") + "$");
      if (rx.test(spec)) return true;
    }
  }
  return false;
}
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---- codegen ----------------------------------------------------------------

function emitBundle({ entryRecord, order, externals, config, logs, path }) {
  const parts = [];
  if (config.banner) parts.push(config.banner);

  // Externals bind at the TOP of the output, in the format's own syntax, and are
  // normalised to their CommonJS shape so the wrapped modules' `require()` sees
  // what it would have seen unbundled (`import * as ns` -> ns.default for a CJS
  // target; that is the standard interop and both Node and this VM agree on it).
  if (externals.length) {
    if (config.format === "iife") {
      logs.push(
        makeLog(
          "error",
          `format: "iife" cannot import ${externals.map((e) => JSON.stringify(e)).join(", ")}: an IIFE is a single ` +
            `self-contained script with no import syntax and no require(). Bundle those modules (drop them from ` +
            `\`external\`, and use target "node"/"bun" if they are built-ins) or emit "esm"/"cjs".`,
        ),
      );
      return null;
    }
    const entriesSrc = [];
    externals.forEach((spec, i) => {
      if (config.format === "esm") {
        parts.push(`import * as __vv_x${i} from ${JSON.stringify(spec)};`);
        entriesSrc.push(`  ${JSON.stringify(spec)}: ("default" in __vv_x${i} ? __vv_x${i}.default : __vv_x${i})`);
      } else {
        parts.push(`var __vv_x${i} = require(${JSON.stringify(spec)});`);
        entriesSrc.push(`  ${JSON.stringify(spec)}: __vv_x${i}`);
      }
    });
    parts.push(`var __vv_externals = {\n${entriesSrc.join(",\n")}\n};`);
  } else {
    parts.push("var __vv_externals = {};");
  }

  parts.push(RUNTIME_PRELUDE);

  // Definitions in dependency order (post-order from the walk), which is not
  // load-bearing — the registry is lazy — but keeps a diff readable.
  for (const m of order) {
    const deps = {};
    for (const [spec, id] of m.deps) deps[spec] = id;
    const params = m.kind === "esm" ? "__oc_exports, __oc_require, __oc_module" : "exports, require, module, __filename, __dirname";
    parts.push(
      `__vv_def(${JSON.stringify(m.id)}, ${JSON.stringify(deps)}, ${JSON.stringify(m.file)}, ${JSON.stringify(m.dir)}, function (${params}) {\n` +
        m.code +
        `\n});`,
    );
  }

  if (config.format === "iife") {
    parts.push(`__vv_req(${JSON.stringify(entryRecord.id)});`);
  } else {
    parts.push(`var __vv_entry = __vv_req(${JSON.stringify(entryRecord.id)});`);
    if (config.format === "cjs") {
      parts.push("module.exports = __vv_entry;");
    } else {
      parts.push(emitEsmExports(entryRecord, order, logs));
    }
  }
  if (config.footer) parts.push(config.footer);

  let body = parts.filter((p) => p != null && p !== "").join("\n");
  if (config.format === "iife") body = `(function () {\n${body}\n})();\n`;
  else body += "\n";
  return body;
}

/**
 * Re-export the entry's exports from the generated ESM file.
 *
 * DIVERGENCE, and the one worth knowing: these are SNAPSHOTS taken right after
 * the entry evaluates, not live bindings. Real Bun hoists modules into one scope,
 * so an importer sees a later reassignment of an exported `let`; here it sees the
 * value the entry finished with. Everything else about the graph is live (the
 * registry links modules through getters exactly as the runtime does) — it is only
 * the bundle's own OUTER boundary that freezes.
 */
function emitEsmExports(entryRecord, order, logs) {
  const names = collectExportNames(entryRecord, order, logs);
  const lines = [];
  const named = names.filter((n) => n !== "default" && /^[A-Za-z_$][\w$]*$/.test(n));
  if (named.length) {
    lines.push(`var { ${named.map((n) => `${n}: __vv_e_${n}`).join(", ")} } = __vv_entry;`);
    lines.push(`export { ${named.map((n) => `__vv_e_${n} as ${n}`).join(", ")} };`);
  }
  if (names.includes("default")) lines.push("export default __vv_entry.default;");
  // A CommonJS entry has no ESM exports at all; Bun still gives the importer a
  // `default` (module.exports), which is the only thing there is to give.
  else if (!names.length) lines.push("export default __vv_entry;");
  return lines.join("\n");
}

/** The entry's export names, following `export * from` through the bundled graph. */
function collectExportNames(entryRecord, order, logs) {
  const byId = new Map(order.map((m) => [m.id, m]));
  const seen = new Set();
  const names = new Set();
  const walk = (mod, isEntry) => {
    if (!mod || seen.has(mod.id)) return;
    seen.add(mod.id);
    for (const n of mod.exportNames || []) if (isEntry || n !== "default") names.add(n);
    for (const spec of mod.starFrom || []) {
      const targetId = mod.deps.get(spec);
      if (!targetId) {
        logs.push(
          makeLog(
            "warning",
            `\`export * from ${JSON.stringify(spec)}\` in ${mod.id} points at a module that is not in the bundle ` +
              `(external, or unresolved), so its names are not re-exported from the output. Name them explicitly if importers need them.`,
          ),
        );
        continue;
      }
      walk(byId.get(targetId), false);
    }
  };
  walk(entryRecord, true);
  return [...names];
}

// The bundle's module registry. Deliberately tiny and deliberately CommonJS-
// shaped: it is the same contract packages/runtime/module.js gives a module, so
// a file behaves identically bundled and unbundled inside Vivari.
const RUNTIME_PRELUDE = `var __vv_defs = Object.create(null);
var __vv_cache = Object.create(null);
function __vv_def(id, deps, file, dir, fn) { __vv_defs[id] = { deps: deps, file: file, dir: dir, fn: fn }; }
function __vv_ext(spec) {
  if (Object.prototype.hasOwnProperty.call(__vv_externals, spec)) return __vv_externals[spec];
  throw new Error("Vivari bundle: require(" + JSON.stringify(spec) + ") is neither bundled nor external. Bun.build resolves STATIC string specifiers only, so a computed require()/import() is left in the output and fails here.");
}
function __vv_req(id) {
  var hit = __vv_cache[id];
  if (hit) return hit.exports;
  var def = __vv_defs[id];
  if (!def) return __vv_ext(id);
  var mod = __vv_cache[id] = { id: id, exports: {}, loaded: false };
  var req = function (spec) {
    var to = def.deps[spec];
    return to === undefined ? __vv_ext(spec) : __vv_req(to);
  };
  req.resolve = function (spec) {
    var to = def.deps[spec];
    if (to === undefined) throw new Error("Vivari bundle: require.resolve(" + JSON.stringify(spec) + ") - not bundled.");
    return to;
  };
  def.fn.call(mod.exports, mod.exports, req, mod, def.file, def.dir);
  mod.loaded = true;
  return mod.exports;
}`;

// ---- logs + artifacts -------------------------------------------------------

function makeLog(level, message, position) {
  // Bun's logs are BuildMessage/ResolveMessage objects; what code actually does
  // with them is read `.message`/`.level` and stringify. Keeping them plain
  // objects with a useful toString() covers both without pretending to be a
  // class that has no other behaviour.
  const log = { level, message, name: "BuildMessage", position: position || null };
  Object.defineProperty(log, "toString", { value: () => `${level}: ${message}`, enumerable: false });
  return log;
}

/**
 * Bun's BuildArtifact: a Blob-like with `path`, `kind`, `loader`, `hash` and the
 * Blob read protocol. Not a platform Blob INSTANCE, for the same reason BunFile
 * is not (see bun-file.js): `extends Blob` is not portable between the Node
 * worker and the browser worker realms this runs in.
 */
export class BuildArtifact {
  constructor({ path, text, kind, loader, hash }) {
    this.path = path;
    this.kind = kind;
    this.loader = loader;
    this.hash = hash;
    this.type = "text/javascript;charset=utf-8";
    Object.defineProperty(this, "_text", { value: text, enumerable: false });
  }
  get size() { return byteLength(this._text); }
  async text() { return this._text; }
  async json() { return JSON.parse(this._text); }
  async arrayBuffer() { return toBytes(this._text).buffer; }
  async bytes() { return toBytes(this._text); }
  stream() {
    const bytes = toBytes(this._text);
    return new ReadableStream({
      start(controller) { controller.enqueue(bytes); controller.close(); },
    });
  }
  toString() { return this.path; }
}

const toBytes = (text) => new TextEncoder().encode(text);
const byteLength = (text) => toBytes(text).length;

/** Bun's artifact hash. Ours is wyhash of the output bytes — a real content hash,
 * and NOT the same string Bun prints for the same file. */
export function contentHash(text) {
  return wyhash(toBytes(text), 0).toString(16).padStart(16, "0");
}

// ---- plugins ----------------------------------------------------------------

/**
 * The shared onResolve/onLoad plumbing. A build gets a fresh one seeded with its
 * `plugins`; the process-wide runtime registry below is the same class, which is
 * what makes a plugin work identically in both lifetimes.
 */
export class PluginHost {
  constructor({ sync }) {
    this.onResolveHooks = [];
    this.onLoadHooks = [];
    this.onStartHooks = [];
    this.sync = !!sync; // runtime plugins may not return promises (see the header)
    this.names = [];
  }
  get active() { return this.onResolveHooks.length > 0 || this.onLoadHooks.length > 0; }

  register(plugin, buildConfig) {
    if (!plugin || typeof plugin.setup !== "function") {
      throw new TypeError("Bun.plugin(plugin) requires an object with a setup(build) function");
    }
    this.names.push(plugin.name || "(anonymous)");
    const builder = {
      config: buildConfig || {},
      onResolve: (constraints, callback) => {
        assertFilter(constraints, "onResolve");
        this.onResolveHooks.push({ ...constraints, callback, plugin: plugin.name });
      },
      onLoad: (constraints, callback) => {
        assertFilter(constraints, "onLoad");
        this.onLoadHooks.push({ ...constraints, callback, plugin: plugin.name });
      },
      // onStart is a BUILD hook: there is no "start" for a runtime plugin, so
      // accepting one there would register a callback that could never fire.
      onStart: (callback) => {
        if (this.sync) {
          throw new Error(
            "build.onStart() is a Bun.build hook and has no meaning for a runtime plugin registered with Bun.plugin(): " +
              "a runtime plugin is active from the moment it is registered, so there is no build for it to start.",
          );
        }
        this.onStartHooks.push(callback);
      },
      // Bun's virtual-module shorthand. It is not implemented rather than
      // approximated with an onResolve/onLoad pair, because Bun's version also
      // registers the specifier for `import`s that never reach a resolver.
      module: () => {
        throw new Error(
          "build.module() is not implemented in the Vivari shim: use build.onResolve() + build.onLoad() with a " +
            "namespace, which is the same mechanism spelled out.",
        );
      },
    };
    const r = plugin.setup(builder);
    if (r && typeof r.then === "function") {
      if (this.sync) {
        throw new Error(
          `Bun.plugin(${JSON.stringify(plugin.name || "(anonymous)")}) has an async setup(), which cannot work as a ` +
            `RUNTIME plugin here: Vivari's module loader is synchronous all the way down to Atomics.wait, so there is ` +
            `nowhere to await before require() must return. Do the async work before calling Bun.plugin, or pass the ` +
            `plugin to Bun.build({ plugins }) instead, where awaiting is legal.`,
        );
      }
      return r;
    }
    return undefined;
  }

  matches(hook, pathText, namespace) {
    const ns = hook.namespace || "file";
    if (ns !== namespace) return false;
    return hook.filter.test(pathText);
  }

  /** async form, used by Bun.build. Returns the first hook result, or null. */
  async resolve(spec, importer, importerDir) {
    for (const hook of this.onResolveHooks) {
      if (!this.matches(hook, spec, "file")) continue;
      const r = await hook.callback({ path: spec, importer, namespace: "file", resolveDir: importerDir, kind: "import-statement" });
      if (r && r.path) return r;
    }
    return null;
  }
  async load(id, virtual) {
    const { namespace, pathText } = splitNamespace(id, virtual);
    for (const hook of this.onLoadHooks) {
      if (!this.matches(hook, pathText, namespace)) continue;
      const r = await hook.callback({ path: pathText, namespace, loader: undefined });
      if (r && r.contents !== undefined) return { contents: String(r.contents), loader: r.loader || "js" };
    }
    return null;
  }

  /** sync form, used by the module loader. Throws if a hook goes async. */
  resolveSync(spec, importer, importerDir) {
    for (const hook of this.onResolveHooks) {
      if (!this.matches(hook, spec, "file")) continue;
      const r = assertSync(hook.callback({ path: spec, importer, namespace: "file", resolveDir: importerDir, kind: "import-statement" }), "onResolve", hook.plugin);
      if (r && r.path) return r;
    }
    return null;
  }
  loadSync(id, virtual) {
    const { namespace, pathText } = splitNamespace(id, virtual);
    for (const hook of this.onLoadHooks) {
      if (!this.matches(hook, pathText, namespace)) continue;
      const r = assertSync(hook.callback({ path: pathText, namespace, loader: undefined }), "onLoad", hook.plugin);
      if (r && r.contents !== undefined) return { contents: String(r.contents), loader: r.loader || "js" };
    }
    return null;
  }
}

function assertFilter(constraints, which) {
  if (!constraints || !(constraints.filter instanceof RegExp)) {
    throw new TypeError(`build.${which}({ filter }) requires a RegExp filter — Bun matches paths with it, and a string would be silently non-matching`);
  }
}
function assertSync(result, which, plugin) {
  if (result && typeof result.then === "function") {
    throw new Error(
      `A Bun.plugin ${which}() hook${plugin ? ` in ${JSON.stringify(plugin)}` : ""} returned a Promise. Runtime plugins ` +
        `must be synchronous in Vivari: require() cannot await, because the whole module loader is synchronous down to ` +
        `Atomics.wait. Pass this plugin to Bun.build({ plugins }) if it needs to be async.`,
    );
  }
  return result;
}
function splitNamespace(id, virtual) {
  if (!virtual) return { namespace: "file", pathText: id };
  const i = id.indexOf(":");
  return { namespace: id.slice(0, i), pathText: id.slice(i + 1) };
}

// The process-wide RUNTIME plugin registry. module.js consults it through the
// three functions below; everything is a cheap boolean read until somebody
// actually calls Bun.plugin().
const runtimePlugins = new PluginHost({ sync: true });

export function bunPluginsActive() {
  return runtimePlugins.active;
}

/**
 * module.js seam #1 — resolution. Returns a resolved id (possibly namespaced) or
 * null to fall through to normal Node resolution.
 */
export function bunPluginResolve(request, fromDir) {
  if (!runtimePlugins.onResolveHooks.length) return null;
  const r = runtimePlugins.resolveSync(request, fromDir + "/__require__", fromDir);
  if (!r || !r.path) return null;
  if (r.namespace && r.namespace !== "file") return r.namespace + ":" + r.path;
  return r.path;
}

/**
 * module.js seam #2 — loading. Returns JavaScript source for `filename`, or null.
 * The loader->JavaScript conversion happens HERE rather than in module.js so the
 * loader keeps exactly one concept ("source text for a filename") and the Bun
 * loader vocabulary stays in the Bun shim.
 */
export function bunPluginLoad(filename) {
  if (!runtimePlugins.onLoadHooks.length) return null;
  const virtual = !filename.startsWith("/") && filename.includes(":");
  const loaded = runtimePlugins.loadSync(filename, virtual);
  if (!loaded) return null;
  return loaderToJs(loaded.contents, loaded.loader, filename);
}

/** Turn an onLoad result into JavaScript the CommonJS loader can compile. */
export function loaderToJs(contents, loader, filename) {
  switch (loader) {
    case "js":
      return contents;
    case "jsx":
      return transpileTypeScript(contents, stripNamespace(filename) + (filename.endsWith(".jsx") ? "" : ".jsx"));
    case "ts":
      return transpileTypeScript(contents, stripNamespace(filename) + (filename.endsWith(".ts") ? "" : ".ts"));
    case "tsx":
      return transpileTypeScript(contents, stripNamespace(filename) + (filename.endsWith(".tsx") ? "" : ".tsx"));
    case "json":
      return "module.exports = " + JSON.stringify(JSON.parse(contents)) + ";";
    case "text":
      return "module.exports = " + JSON.stringify(contents) + ";";
    case "toml": {
      const TOML = globalThis.Bun && globalThis.Bun.TOML;
      if (!TOML) throw new Error('A plugin returned loader: "toml", which needs the Bun global (Bun.TOML) — this process is not running under `bun`.');
      return "module.exports = " + JSON.stringify(TOML.parse(contents)) + ";";
    }
    case "object":
      throw new Error(
        'A plugin returned loader: "object", which is not implemented in the Vivari shim: it hands the loader a live ' +
          "JavaScript value rather than source text, and this module system compiles source. Return `contents` with " +
          'loader "js" (e.g. "module.exports = ...") instead.',
      );
    default:
      throw new Error(
        `A plugin returned loader: ${JSON.stringify(loader)}, which is not implemented in the Vivari shim. ` +
          `Supported: js, jsx, ts, tsx, json, text, toml.`,
      );
  }
}
const stripNamespace = (id) => (id.startsWith("/") ? id : id.slice(id.indexOf(":") + 1));

// ---- the Bun.build entry point ----------------------------------------------

/**
 * Build the `Bun.build` / `Bun.plugin` pair.
 *
 * `resolveFrom(specifier, fromDir)` is the LOADER's own resolveFilename
 * (packages/runtime/index.js passes it in) — reason 3 in the header. `warn` is
 * how the once-per-process degrade messages reach the console; bun.js owns that.
 */
export function createBunBuild({ lazy, process, warn, resolveFrom }) {
  async function build(options) {
    const path = lazy("path");
    const fs = lazy("fs");
    const cwd = process.cwd();
    const { config, warnings } = normalizeBuildOptions(options, { path, cwd });
    for (const w of warnings) warn(w.key, w.message);

    const pluginHost = new PluginHost({ sync: false });
    for (const p of config.plugins) await pluginHost.register(p, { ...config, entrypoints: config.entries });
    for (const start of pluginHost.onStartHooks) await start();

    const resolve = requireResolver(resolveFrom);
    const logs = [];
    const outputs = [];

    for (const entry of config.entries) {
      const result = await bundleEntry({
        entry,
        config,
        host: { fs, path, resolve },
        hooks: pluginHost,
      });
      logs.push(...result.logs);
      if (!result.code) continue;

      const rel = path.relative(config.root, entry);
      const dir = path.dirname(rel);
      const base = path.basename(rel);
      const name = base.slice(0, base.length - path.extname(base).length);
      const hash = contentHash(result.code);
      const outPath = applyNaming(config.entryNaming, { dir: dir === "." ? "" : dir, name, ext: "js", hash });
      const artifactPath = config.outdir ? path.join(config.outdir, outPath) : "./" + outPath;

      if (config.outdir) {
        const full = path.join(config.outdir, outPath);
        try {
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, result.code);
        } catch (e) {
          logs.push(makeLog("error", `Could not write ${full}: ${(e && e.message) || e}`));
          continue;
        }
      }
      outputs.push(new BuildArtifact({ path: artifactPath, text: result.code, kind: "entry-point", loader: "js", hash }));
    }

    const success = !logs.some((l) => l.level === "error");
    if (!success && config.throw) {
      // `throw: true` is Bun's opt-in to an AggregateError instead of a result.
      throw new AggregateError(
        logs.filter((l) => l.level === "error").map((l) => new Error(l.message)),
        "Bun.build failed",
      );
    }
    return { success, outputs: success ? outputs : [], logs };
  }

  /**
   * Bun.plugin(plugin) — register a RUNTIME plugin (see the header for the
   * runtime/build split). Returns undefined, or the setup()'s promise when it is
   * async, which is Bun's documented shape.
   */
  function plugin(p) {
    return runtimePlugins.register(p, {});
  }
  plugin.clearAll = () => {
    runtimePlugins.onResolveHooks.length = 0;
    runtimePlugins.onLoadHooks.length = 0;
    runtimePlugins.names.length = 0;
  };

  return { build, plugin };
}

// The loader's own resolveFilename, handed in by packages/runtime/index.js.
// Without it (a bare embedder that never wired one) Bun.build says so rather than
// growing a second, different resolver — reason 3 in this file's header.
function requireResolver(resolveFrom) {
  if (typeof resolveFrom !== "function") {
    return () => {
      throw new Error(
        "Bun.build cannot resolve modules: this runtime was created without the loader's resolver " +
          "(createBunRuntime({ resolveFrom })). Bun.build deliberately has no resolver of its own — a bundle that " +
          "resolved differently from the runtime it was built in would be a debugging trap.",
      );
    };
  }
  return resolveFrom;
}