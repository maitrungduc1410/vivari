// Spike (OFFLINE): prove two ESM→CJS loader guarantees the module system relies on,
// using self-contained fixtures (no npm, no kernel, no network):
//
//   1. Top-level await. A module doing `x = (await import('dep')).default` is real
//      ESM but our CJS wrapper is a plain function, so `new Function` rejects it —
//      and after our import-rewrite the parser blames the NEXT token ("Unexpected
//      identifier '__oc_import'"), NOT the tidy "await is only valid…" string. So
//      module.js must retry ANY failed ESM compile as an AsyncFunction. This is what
//      @sveltejs/kit/src/core/sync/ts.js hits when a SvelteKit config loads.
//
//   2. Circular re-export live bindings. A barrel that does
//      `import { Fragment } from './common.js'; export { Fragment }` must re-export
//      Fragment as a LAZY binding to common.js, not an eager `const Fragment =
//      common.Fragment` snapshot. When common.js is mid-cycle the eager read hits its
//      still-TDZ `const Fragment` → "Cannot access 'Fragment' before initialization"
//      (astro's runtime/server/render/index.js ⇄ common.js). A lazy re-export defers
//      the read until after the cycle resolves.
//
// Run:  node scripts/spike-esm.mjs

import { transpileEsm, transpileEsmLive } from "../packages/runtime/esm.js";
import urlFactory from "../packages/runtime/node/internal/url.js";
import { fromFileUrl } from "../packages/runtime/module.js";
import path from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath as hostFilePath } from "node:url";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
let failures = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

// ── 1. top-level await ───────────────────────────────────────────────────────
console.log("\n== [esm] top-level await → async retry ==");
{
  const src = `export let ts = undefined;\ntry { ts = (await import('typescript')).default; } catch {}\n`;
  const out = transpileEsm(src, "/ts.js");
  check("dynamic import rewritten to __oc_import", /await __oc_import\(/.test(out));
  let syncErr = "";
  try {
    new Function("__oc_exports", "__oc_require", "__oc_module", out + "\n");
  } catch (e) {
    syncErr = e.message;
  }
  // The exact bug signature the old narrow `/await.*(only|valid|allowed)/` regex missed.
  check("plain new Function rejects it (Unexpected identifier)", /Unexpected identifier/.test(syncErr));
  let asyncOk = true;
  try {
    new AsyncFunction("__oc_exports", "__oc_require", "__oc_module", out + "\n");
  } catch {
    asyncOk = false;
  }
  check("AsyncFunction compiles it (module.js's retry path)", asyncOk);
}

// ── 2. circular re-export live binding ───────────────────────────────────────
console.log("\n== [esm] circular re-export → lazy live binding ==");
{
  // barrel.js: import-then-re-export only (the astro render/index.js shape).
  const barrelSrc = `import { Fragment } from './common.js';\nexport { Fragment };\n`;
  const barrelOut = transpileEsm(barrelSrc, "/barrel.js");
  check("no eager `const Fragment = m.Fragment` snapshot", !/const Fragment\s*=/.test(barrelOut));
  // The re-export getter is emitted EARLY (before the requires) and re-resolves the
  // source module lazily via __oc_require (cached), so a circular importer reading it
  // mid-cycle sees a defined getter, not undefined.
  check("Fragment exported via an early lazy getter (re-require to source)", /get:function\(\)\{return __oc_require\("\.\/common\.js"\)\["Fragment"\]/.test(barrelOut));

  // Execute the whole cycle through a tiny OC-shaped loader (sync require + partial
  // exports on re-entry, exactly like packages/runtime/module.js). The cycle is
  // entry → common → barrel → common(mid-init). Old eager read threw TDZ here.
  const fixtures = {
    "/entry.js": `import './common.js';\nimport { Fragment } from './barrel.js';\n__oc_exports.result = Fragment;\n`,
    "/common.js": `import './barrel.js';\nexport const Fragment = Symbol.for('spike:fragment');\n`,
    "/barrel.js": barrelSrc,
  };
  const cache = new Map();
  const norm = (id) => "/" + id.replace(/^\.?\//, "");
  const load = (rawId) => {
    const id = norm(rawId);
    if (cache.has(id)) return cache.get(id).exports;
    const mod = { exports: Object.create(null) };
    cache.set(id, mod);
    const out = transpileEsm(fixtures[id], id);
    let wrapper;
    try {
      wrapper = new Function("__oc_exports", "__oc_require", "__oc_module", out + "\n");
    } catch {
      wrapper = new AsyncFunction("__oc_exports", "__oc_require", "__oc_module", out + "\n");
    }
    wrapper.call(mod.exports, mod.exports, load, mod);
    return mod.exports;
  };
  let result, threw = "";
  try {
    result = load("/entry.js").result;
  } catch (e) {
    threw = e.message;
  }
  check("cycle loads without TDZ throw", !threw);
  if (threw) console.log("       threw: " + threw);
  check("re-exported Fragment resolves to the source Symbol", result === Symbol.for("spike:fragment"));
}

// ── 2b. barrel re-export read mid-cycle must not snapshot `undefined` ─────────
// astro: middleware/index.js re-exports `sequence` (import-then-re-export); render-
// context.js eagerly imports it AND spread-calls it (`sequence(...mw)`). The re-export
// getter used to be emitted at the END of the barrel's prelude (after its requires), so
// a circular importer reading it mid-cycle got `undefined` — no TDZ throw, so no live
// fallback — and the later spread call `undefined(...args)` blew up with V8's
// "Function.prototype.apply was called on undefined". Emitting the re-export getter
// EARLY (before the requires) + resolving via __oc_require fixes it.
console.log("\n== [esm] barrel re-export read mid-cycle resolves (no apply-on-undefined) ==");
{
  const fixtures = {
    // consumer loaded FIRST; imports `seq` from the barrel and spread-calls it in a method
    "/rc.js": `import { seq } from './barrel.js';\nexport const SYM = Symbol.for('spike:rc');\nexport class RC { static make(){ return seq('a','b'); } }\n`,
    // barrel: pure import-then-re-export (seq not otherwise used)
    "/barrel.js": `import { seq } from './seq.js';\nexport { seq };\n`,
    // seq: hoisted function; imports SYM from rc (mid-cycle) → its own live fallback
    "/seq.js": `import { SYM } from './rc.js';\nfunction seq(...h){ return SYM ? 'seq#' + h.length : 'no'; }\nexport { seq };\n`,
  };
  const cache = new Map();
  const norm = (id) => "/" + id.replace(/^\.?\//, "");
  const load = (rawId) => {
    const id = norm(rawId);
    if (cache.has(id)) return cache.get(id).exports;
    const mod = { exports: Object.create(null) };
    cache.set(id, mod);
    const compile = (out) => {
      try { return new Function("__oc_exports", "__oc_require", "__oc_module", out + "\n"); }
      catch { return new AsyncFunction("__oc_exports", "__oc_require", "__oc_module", out + "\n"); }
    };
    try {
      compile(transpileEsm(fixtures[id], id)).call(mod.exports, mod.exports, load, mod);
    } catch (e) {
      if (e instanceof ReferenceError && /before initialization|is not defined/.test(e.message)) {
        compile(transpileEsmLive(fixtures[id], id)).call(mod.exports, mod.exports, load, mod);
      } else throw e;
    }
    return mod.exports;
  };
  // Load seq.js first so rc.js reads barrel['seq'] while the barrel is mid-cycle.
  load("/seq.js");
  let out, threw = "";
  try { out = load("/rc.js").RC.make(); } catch (e) { threw = e.message; }
  check("spread-calling the re-exported fn does not throw", !threw);
  if (threw) console.log("       threw: " + threw);
  check("re-exported function resolves (returns 'seq#2')", out === "seq#2");
}

// ── 3. imported name used ONLY via spread must keep its eager const ───────────
// Regression: the "is it used in the body" check must NOT treat `...X` (spread/rest)
// as `obj.X` member access. vite-plugin-svelte's options.js uses the constant only as
// `[...SVELTE_DEDUPED_IMPORTS]`, astro's vite.js only as `[...SUPPORTED_MARKDOWN_FILE_
// EXTENSIONS]` — dropping the const there → "X is not defined".
console.log("\n== [esm] spread-only use keeps the eager const ==");
{
  const spreadSrc = `import { DEDUPED } from './c.js';\nexport const list = [...DEDUPED];\n`;
  const out = transpileEsm(spreadSrc, "/opts.js");
  check("eager `const DEDUPED = m.DEDUPED` is kept (spread is a use)", /const DEDUPED\s*=/.test(out));
  // member access, by contrast, need not keep it — but keeping is harmless, so we only
  // assert the spread case (the one that actually broke).
}

// ── 4. live-binding fallback: circular singleton used inside a function ───────
// The eager `const X = m.X` snapshot TDZ-throws when a consumer imports a const/class/
// singleton from a module that's mid-cycle (astro's apiContextRoutesSymbol / AstroConfig
// Schema / globalContentLayer / telemetry). module.js recovers by recompiling the module
// with transpileEsmLive (imports bound lazily via `with (__oc_live)`) and re-running.
console.log("\n== [esm] live-binding fallback recovers a circular singleton ==");
{
  const fixtures = {
    "/entry.js": `import './def.js';\nimport { getSym } from './consumer.js';\n__oc_exports.result = getSym();\n`,
    "/def.js": `import './consumer.js';\nexport const theSymbol = Symbol.for('spike:live');\n`,
    // uses theSymbol only inside a function → live binding read happens after the cycle
    "/consumer.js": `import { theSymbol } from './def.js';\nexport function getSym() { return theSymbol; }\n`,
  };
  const cache = new Map();
  const norm = (id) => "/" + id.replace(/^\.?\//, "");
  const compile = (out) => {
    try { return new Function("__oc_exports", "__oc_require", "__oc_module", out + "\n"); }
    catch { return new AsyncFunction("__oc_exports", "__oc_require", "__oc_module", out + "\n"); }
  };
  let usedFallback = false;
  const load = (rawId) => {
    const id = norm(rawId);
    if (cache.has(id)) return cache.get(id).exports;
    const mod = { exports: Object.create(null) };
    cache.set(id, mod);
    const src = fixtures[id];
    try {
      compile(transpileEsm(src, id)).call(mod.exports, mod.exports, load, mod);
    } catch (e) {
      // mirror module.js's fallback
      if (e instanceof ReferenceError && /before initialization|is not defined/.test(e.message)) {
        usedFallback = true;
        compile(transpileEsmLive(src, id)).call(mod.exports, mod.exports, load, mod);
      } else throw e;
    }
    return mod.exports;
  };
  let result, threw = "";
  try { result = load("/entry.js").result; } catch (e) { threw = e.message; }
  check("eager compile hit a TDZ that triggered the fallback", usedFallback);
  check("module recovers (no throw) via the with-live-binding variant", !threw);
  if (threw) console.log("       threw: " + threw);
  check("the lazily-read singleton resolves to the source Symbol", result === Symbol.for("spike:live"));
}

// ── 5. dynamic import() of a CJS target yields an ESM namespace with `default` ─
// Node wraps a CJS dynamic-import target as { default: module.exports, ...ownKeys }.
// Returning the bare exports left it without `default`; Vite's SSR module runner
// asserts `'default' in mod` for externalized CJS deps (analyzeImportedModDifference)
// and threw "Named export 'default' not found … 'cssesc' is a CommonJS module" on astro.
console.log("\n== [esm] dynamic import() of CJS builds a namespace with default ==");
{
  const cssesc = function cssesc() { return "x"; };
  cssesc.version = "3.0.0"; // a function static → a named export in Node interop
  const esmTarget = Object.create(null);
  esmTarget.foo = 1;
  esmTarget.default = "D";
  Object.defineProperty(esmTarget, "__esModule", { value: true });
  const req = (s) => (s === "cssesc" ? cssesc : s === "esm" ? esmTarget : undefined);
  const src = `export const z=1; const a = await import("cssesc"); const b = await import("esm"); __oc_exports.__a=a; __oc_exports.__b=b;`;
  const out = transpileEsm(src, "/dyn.js");
  const w = new AsyncFunction("__oc_exports", "__oc_require", "__oc_module", out + "\n");
  const mod = { exports: Object.create(null) };
  let a, b, threw = "";
  try {
    await w.call(mod.exports, mod.exports, req, mod);
    a = mod.exports.__a;
    b = mod.exports.__b;
  } catch (e) { threw = e.message; }
  check("dynamic import resolves without throwing", !threw);
  check("CJS target namespace has a `default` binding", !!a && "default" in a);
  check("`default` is the whole module.exports (the cssesc fn)", a && a.default === cssesc);
  check("CJS function statics surface as named exports", a && a.version === "3.0.0");
  check("ESM target (already __esModule) is returned unchanged", b === esmTarget);
}

// ── 6. static default import of CJS: `__esModule` is not proof of a `default` ─
// `tsc --module commonjs` stamps `__esModule` on every file it emits, including the
// ones that only ever assign named exports — so the flag means "transpiled", not "has
// a default". Babel's rule (`m.__esModule ? m.default : m`) reads it as the second and
// hands back `undefined`. @embroider/core is exactly that shape, and it is why
// @embroider/vite died at `const { cleanUrl } = core` before Ember's config could load.
// Node has no such hazard: a CJS default import is `module.exports`, always. So the
// unwrap requires the key to be THERE, which keeps Babel's behaviour wherever a real
// `default` exists. The first check below is the one that fails on the old predicate;
// the second is what stops a fix from over-correcting into Node's rule outright.
//
// Note this is the STATIC path only — the namespace helpers still read the flag the old
// way, deliberately and on the record. See the cross-reference at esm.js's __oc_ns.
console.log("\n== [esm] default import of __esModule CJS with no `default` ==");
{
  // tsc's shape: the flag is non-enumerable, and there is no `default` key at all.
  const namedOnly = {};
  Object.defineProperty(namedOnly, "__esModule", { value: true });
  namedOnly.cleanUrl = (u) => u;
  // Babel's shape: the flag AND a real default export.
  const withDefault = {};
  Object.defineProperty(withDefault, "__esModule", { value: true });
  withDefault.default = "D";
  const plain = { x: 1 };

  const src =
    `import a from 'named-only';\nimport b from 'with-default';\nimport c from 'plain';\n` +
    `__oc_exports.a = a; __oc_exports.b = b; __oc_exports.c = c;\n`;
  const req = (s) => ({ "named-only": namedOnly, "with-default": withDefault, plain })[s];
  const mod = { exports: Object.create(null) };
  new Function("__oc_exports", "__oc_require", "__oc_module", transpileEsm(src, "/entry.js") + "\n")
    .call(mod.exports, mod.exports, req, mod);

  check("__esModule + named exports only -> module.exports, not undefined", mod.exports.a === namedOnly);
  check("__esModule + a real `default` -> still unwrapped (Babel interop kept)", mod.exports.b === "D");
  check("no __esModule -> module.exports", mod.exports.c === plain);
}

// ── 7. a comment between `export` and its declaration ─────────────────────────
// Comments are legal between ANY two tokens, and zod v4's build emits
// `export /*@__NO_SIDE_EFFECTS__*/ function`. The scanner used to skip only whitespace
// after `export`, read the comment's `/` as "not an export form", left the keyword in
// the CJS body, and every server route importing zod died inside the VM with
// "Unexpected token 'export'" (module.js retried it as an AsyncFunction and reported
// the same thing, because the transpiled source still had the keyword).
console.log("\n== [esm] comment between `export` and its declaration ==");
{
  const src =
    `export /*@__NO_SIDE_EFFECTS__*/ function $constructor(name) { return name; }\n` +
    `export /* keep */ const answer = 42;\n` +
    "export // trailing\nconst later = 1;\n" +
    "export default /*why*/ function named() { return 'd'; }\n" +
    // The default function must stay a DECLARATION (a local binding), not become
    // __oc_exports.default = /*c*/ function named(){}. Calling named from inside
    // the module is what tells those two apart: on the expression path it throws
    // "named is not defined", while calling exports.default() alone would pass
    // either way.
    "export const callNamed = () => named();\n";
  const out = transpileEsm(src, "/commented.js");
  check("no bare `export` survives the rewrite", !/^\s*export\b/m.test(out));
  let compiled = true;
  const mod = { exports: Object.create(null) };
  try {
    new Function("__oc_exports", "__oc_require", "__oc_module", out + "\n").call(
      mod.exports,
      mod.exports,
      () => ({}),
      mod,
    );
  } catch (e) {
    compiled = false;
    console.log("    compile error:", e.message);
  }
  check("the rewritten module compiles", compiled);
  check("a commented function declaration is exported", compiled && mod.exports.$constructor("x") === "x");
  check("a commented const is exported", compiled && mod.exports.answer === 42);
  check("a commented default declaration is exported", compiled && mod.exports.default() === "d");
  let namedOk = false;
  try {
    namedOk = compiled && mod.exports.callNamed() === "d";
  } catch {
    namedOk = false;
  }
  check("a commented default function keeps its local binding", namedOk);
}

// ── 8. a relative module id must never become the URL host ────────────────────
// `"file://" + id` is a three-slash file URL only when the id is absolute. With a
// relative id ("home/user/…") the first segment parses as the HOST, so
// `new URL('./pglite.data', import.meta.url)` resolves to file://home/user/… and
// fileURLToPath() returns /user/… — the /home is gone. That is how a PGlite ESM
// import failed with ENOENT while its stack frame looked right.
console.log("\n== [esm] relative module id must not become import.meta.url's host ==");
{
  const src = "export const url = import.meta.url; export const dir = import.meta.dirname;";
  const out = transpileEsm(src, "home/user/projects/app/node_modules/@electric-sql/pglite/dist/index.js");
  const mod = { exports: Object.create(null) };
  new Function("__oc_exports", "__oc_require", "__oc_module", out + "\n").call(
    mod.exports,
    mod.exports,
    () => ({}),
    mod,
  );
  const u = mod.exports.url;
  check(
    "import.meta.url is a three-slash file URL",
    u === "file:///home/user/projects/app/node_modules/@electric-sql/pglite/dist/index.js",
  );
  check(
    "a relative asset resolves under /home, not /user",
    new URL("./pglite.data", u).pathname ===
      "/home/user/projects/app/node_modules/@electric-sql/pglite/dist/pglite.data",
  );
  check(
    "import.meta.dirname is absolute too",
    mod.exports.dir === "/home/user/projects/app/node_modules/@electric-sql/pglite/dist",
  );
  check(
    "the live-binding variant builds the same URL",
    transpileEsmLive(src, "home/user/projects/app/x.js").includes('"file:///home/user/projects/app/x.js"'),
  );
}

// ── 9. fileURLToPath recovers the path from a hostful file URL ───────────────
// `"file:" + absolutePath` is how userland builds a file URL from `__filename`, and
// PGlite's CJS build does exactly that. Chrome does not parse the result the same way
// on every platform: url/url_parse_file.cc takes its WIN32 branch for anything that is
// not `C:\` and is not exactly three slashes, and reads the rest as an UNC path — so
// `file:/home/user/x` is `file://home/user/x` on Chrome/Windows, and
// `file:///home/user/x` in Node and on Chrome/Linux (url_parse_unittest.cc pins both
// tables). This VFS has no file hosts, so the segment the parser promoted is put back
// in front of the pathname instead of throwing (which killed the database boot) or
// dropping it (the old /user/… bug).
//
// The Windows branch is MODELLED here: the parser under test is the host's, and what
// is checked is the reconstruction. Two slashes reproduce that parse on any host
// (`file://home/user/x` is UNC everywhere), which is why this runs in CI.
console.log("\n== [url] fileURLToPath recovers the path from a hostful file URL ==");
{
  const mod = { exports: {} };
  urlFactory(mod.exports, () => { throw new Error("require is not available here"); }, mod, {}, {}, {});
  const { fileURLToPath } = mod.exports;
  // What Chrome/Windows makes of `"file:" + "/a/rest"`: host "a", pathname "/rest".
  const asChromeOnWindows = (absPath) => new URL("file://" + String(absPath).replace(/^\/+/, ""));
  check(
    "the Chrome/Windows parse promotes the first path segment to the host",
    asChromeOnWindows("/home/user/x").hostname === "home",
  );
  for (const p of [
    "/home/user/projects/app/x.js",
    "/home/user/projects/app/node_modules/@electric-sql/pglite/dist/index.cjs",
    "/home/user/projects/my project/x.js",
    "/home/user/progetti/città/x.js",
    "/home/user/projects/app/",
    "/home",
  ]) {
    check(`a hostful URL comes back as ${p}`, fileURLToPath(asChromeOnWindows(p)) === p);
  }
  check(
    "the string form recovers too",
    fileURLToPath("file://home/user/projects/x") === "/home/user/projects/x",
  );
  check(
    "a three-slash file URL still converts",
    fileURLToPath("file:///home/user/projects/x") === "/home/user/projects/x",
  );
  check(
    "localhost keeps its normal meaning",
    fileURLToPath("file://localhost/home/x") === "/home/x",
  );
  let scheme = null;
  try {
    fileURLToPath("https://example.com/x");
  } catch (e) {
    scheme = e.code;
  }
  check("a non-file scheme still throws", scheme === "ERR_INVALID_URL_SCHEME");
  // pathToFileURL has to escape a literal "%" in a file NAME: URL#pathname leaves it
  // alone, so without that "a%20b" would decode back as "a b" (Node's pathToFileURL
  // encodes it, and the round trip is the contract).
  const urlmod = { exports: {} };
  urlFactory(
    urlmod.exports,
    (m) => (m === "path" ? path : () => { throw new Error("require is not available here"); }),
    urlmod,
    {},
    {},
    {},
  );
  const pct = urlmod.exports.pathToFileURL("/home/user/a%20b.js");
  check("pathToFileURL escapes a literal % in a file name", pct.href === "file:///home/user/a%2520b.js");
  check(
    "…and fileURLToPath round-trips that name",
    urlmod.exports.fileURLToPath(pct) === "/home/user/a%20b.js",
  );

  // THE RECOVERY IS LOSSY, and it cannot be otherwise: the platform normalises the host
  // before anyone sees it. These three are what the parser hands back, not a choice this
  // code makes, and they are pinned so the docs promise exactly what it delivers — "the
  // path the URL now describes", not "the path it meant" (review of #35 asked for that
  // limit to be stated rather than glossed over).
  check("a lowercased host cannot be un-lowercased", fileURLToPath("file://MyApp/x") === "/myapp/x");
  check("a numeric host is parsed as IPv4", fileURLToPath("file://123/x") === "/0.0.0.123/x");
  check("localhost collapses to hostless, as in Node", fileURLToPath("file://localhost/x") === "/x");

  // …and every CALL SITE that turns a specifier into a path shares that rule, which is the
  // half the first version of this fix missed. `fromFileUrl` is what BOTH dynamic import()'s
  // resolution and Module.createRequire() go through, and `"file:" + __filename` is
  // `file://home/user/x` on Chrome/Windows — so a stripped prefix makes it "home/user/x",
  // a RELATIVE path that resolves against nothing.
  check(
    "the loader recovers a hostful specifier instead of returning a relative path",
    fromFileUrl("file://home/user/projects/app/node_modules/.bin/x.js") ===
      "/home/user/projects/app/node_modules/.bin/x.js",
  );
  check("…with Vite's cache-busting query and hash", fromFileUrl("file:///app/x.js?t=1#frag") === "/app/x.js");
  check("…and with one slash as well as two", fromFileUrl("file:/app/x.js") === "/app/x.js");
  check(
    "a file: specifier NEVER comes back relative",
    ["file://home/user/x", "file:///app/x", "file:/app/x", "file://@scope/x", "file://", "file://home"].every(
      (u) => fromFileUrl(u).startsWith("/"),
    ),
  );
}

// ── 10. no call site may hand-roll the file: URL → path conversion ───────────
// Section 9 pins the rule; this keeps every call site ON it. The bug does not look like
// one — `u.slice("file://".length)` reads as a tidy prefix strip and yields a perfectly
// plausible RELATIVE path — which is why the same three lines were written in module.js
// (twice), bun-worker.js, worker_threads.js and python-debugger.js AFTER the recovery
// existed. Any conversion here has to go through packages/runtime/file-url.js.
console.log("\n== [url] every file: URL → path conversion goes through one module ==");
{
  const RUNTIME = hostFilePath(new URL("../packages/runtime/", import.meta.url));
  const files = [];
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.name === "node_modules") continue;
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.name.endsWith(".js")) files.push(p);
    }
  };
  walk(RUNTIME);

  const STRIPS = [
    { re: /slice\(\s*["']file:\/\/["']/, why: 'strips the "file://" prefix by hand' },
    { re: /slice\(\s*0\s*,\s*7\s*\)/, why: "compares 7 characters of a file: URL" },
    { re: /\.slice\(\s*7\s*\)/, why: "slices 7 characters off a file: URL" },
    { re: /replace\(\s*\/\^file:/, why: "strips the file: scheme with a regex" },
  ];
  // A line only counts when it is about file: URLs (so net.js's `a.slice(7)` on an
  // IPv4-mapped address is not a hit).
  const hits = (file) => {
    const lines = readFileSync(file, "utf8").split("\n");
    const out = [];
    lines.forEach((line, i) => {
      // Comments are allowed to NAME the pattern — that is how the next person learns not
      // to write it. Only executed code counts.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      const about = line.includes("file:") || (i > 0 && lines[i - 1].includes("file:"));
      if (!about) return;
      for (const s of STRIPS) if (s.re.test(line)) out.push(`${relative(RUNTIME, file)}:${i + 1} ${s.why}`);
    });
    return out;
  };

  // TWO files may keep one, and both are named here with the reason, not inferred.
  const ALLOWED = new Map([
    ["file-url.js", "the one implementation — this is what everything else calls"],
    [
      "debugger.js",
      "fromUrl already rebuilds the promoted segment (it never returns relative); it is paired " +
        "with a toUrl that does NOT escape %, so it must not decode either. Converting it is a " +
        "debugger-identity change, not part of this fix",
    ],
    [
      "esm.js",
      "the Bun.resolveSync prelude is GENERATED source: it cannot import file-url.js, and " +
        "inlining the rule as a string is the second copy this whole change deletes",
    ],
  ]);

  const offenders = [];
  for (const f of files) {
    if (ALLOWED.has(relative(RUNTIME, f))) continue;
    offenders.push(...hits(f));
  }
  check(
    `no file: URL is converted outside file-url.js (${files.length} files scanned)` +
      (offenders.length ? ` — ${offenders.join("; ")}` : ""),
    offenders.length === 0,
  );
  // …and the allowlist cannot rot: an entry whose reason has been FIXED must be deleted,
  // or the next hand-rolled strip gets waved through by a list nobody re-read.
  const stale = [...ALLOWED.keys()].filter((rel) => hits(join(RUNTIME, rel)).length === 0);
  check("every allowlist entry still has its strip" + (stale.length ? ` — stale: ${stale.join(", ")}` : ""), stale.length === 0);
}

console.log(`\nRESULT: ${failures === 0 ? "PASS — esm.js live-binding + TLA loader guarantees hold" : `FAIL — ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);