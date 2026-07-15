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

import { transpileEsm } from "../packages/runtime/esm.js";

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
  check("Fragment exported via a lazy getter to the source module", /get:function\(\)\{return __oc_m\d+\["Fragment"\]/.test(barrelOut));

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

console.log(`\nRESULT: ${failures === 0 ? "PASS — esm.js live-binding + TLA loader guarantees hold" : `FAIL — ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
