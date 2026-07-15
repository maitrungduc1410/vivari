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

console.log(`\nRESULT: ${failures === 0 ? "PASS — esm.js live-binding + TLA loader guarantees hold" : `FAIL — ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
