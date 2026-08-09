// Spike (NETWORK): prove the Ember template's Embroider + Vite dev server boots +
// serves in-VM, and that every `.gjs` the browser loads is COMPILED — wire format, no
// compile-time API surviving into the shipped module.
//
// Takes the SHIPPED bytes (lib/shipped-templates.mjs), like spike-react: nothing
// about Ember needs to differ from what the studio writes, and the Vite-7 pins that
// force svelte/qwik to carry a copy do not apply here.
//
// Vite 8, deliberately, and this is the finding the template rests on. The
// rolldown-wasi tokio panic that pins Svelte to Vite 7 needs TWO rolldown dep-optimize
// passes in one process — a client optimize followed by an SSR one — because the napi
// tokio runtime is torn down after the first bundle and never re-inits under wasi.
// @embroider/vite configures no ssr environment and forces no SSR optimize: an Ember
// app is a client-rendered SPA (FastBoot is separate and opt-in), so it runs exactly
// ONE pass and never reaches the second. Measured, not assumed — the gate below
// requires `.vite/deps` to be non-empty, so the client optimize has to have RUN and
// SURVIVED for this spike to pass. It also carries @rolldown/binding-wasm32-wasi as a
// devDependency, which every Vite 8 template must declare for itself since rolldown
// 1.2.2 dropped it from optionalDependencies (AGENTS.md).
//
// ── WHY THE MARKERS BELOW ARE WHAT THEY ARE ───────────────────────────────────────
// Compiling a `.gjs` is TWO stages: content-tag rewrites `<template>` into a
// `precompileTemplate(...)` call, then babel-plugin-ember-template-compilation compiles
// that call away into a `createTemplateFactory(...)` carrying Glimmer wire format.
//
// This spike shipped once asserting `precompileTemplate` — which is the output of stage
// ONE and is exactly what a correctly built module must NOT contain. Stage two was
// silently not running (the template passed `targetFormat: 'hbs'`, the codemod mode that
// leaves the call for a later pass an app never performs), so every route module reached
// the browser with a live call into ember-source's runtime stub and the app threw
// "Attempted to call `precompileTemplate` at runtime" on boot. The gate was green because
// it was asserting the symptom. So:
//
//   POSITIVE  createTemplateFactory + a "block" wire payload — what a correctly compiled
//             module contains, verified against @ember/app-blueprint's own output. Run
//             over the `.gjs` modules, the only ones with a <template> to compile.
//   NEGATIVE  no `precompileTemplate(` call and no @ember/template-compilation import in
//             ANY app module, `.gjs` or not — the API is importable from plain .js and a
//             surviving call there throws on boot just the same. This is the assertion
//             that actually pins the bug: the positive alone would pass if ONE route
//             compiled.
//
// Both, over the WHOLE graph rather than the entry, because the two route modules failed
// identically and only the first-evaluated one showed in the stack trace. A per-entry
// check would have cleared the other. The graph is walked from index.html the way a
// browser walks it, so a route added later is covered without editing this file.
//
// `base` is here because the template is keep-prefix (Ember's router reads
// location.pathname, which under the preview is /preview/4200/), so the dev server serves
// the shell and /@vite/client under that prefix and a gate asking for "/" grades a
// redirect.
//
// Run (Node 22+, needs network for npm — see spike-vite-lib.mjs for setup):
//   node scripts/spike-ember.mjs

import { runViteSpike } from "./spike-vite-lib.mjs";
import { loadShippedTemplates } from "./lib/shipped-templates.mjs";

const templates = await loadShippedTemplates();
const ember = templates.find((t) => t.manifest.id === "ember");
if (!ember) {
  console.error("No `ember` template in packages/studio/src/vv/templates.ts — did its id change?");
  process.exit(2);
}

const BASE = "/preview/4200/";

// A live call into the compile-time API, i.e. stage two did not run. Deliberately not a
// bare /precompileTemplate/: the string also appears inside sourcemap comments (the
// base64 payload embeds the ORIGINAL source), and matching those would fail a correct
// build. What must be absent is the CALL and the runtime IMPORT of it.
const RUNTIME_COMPILE_CALL = /(?<!\/\/.*)\bprecompileTemplate\s*\(/;
const COMPILER_IMPORT = /import\s*\{[^}]*\bprecompileTemplate\b[^}]*\}\s*from|template-compilation_index/;

const ok = await runViteSpike({
  name: "Ember",
  dir: "/ember",
  templateId: "ember",
  files: ember.files,
  base: BASE,
  // ?import is not a trick to coax Vite into transforming: it is what Vite's own import
  // analysis appends, so it is the URL the BROWSER requests for this module (confirmed by
  // walking the graph). Without it the request is a plain static-file request and Vite
  // answers with the file's raw bytes and a 200, which is how the first draft passed.
  entryModule: `${BASE}app/templates/application.gjs?import`,
  entryMarker: /createTemplateFactory/,
  titleMarker: /Ember in Vivari/,

  extraChecks: async ({ get, getRetry, decode, base }) => {
    const results = [];
    const fetched = new Map();
    // The plain `get`, never `getRetry` — getRetry spends up to 60s retrying a 404 and a
    // graph walk finds plenty of those.
    const fetchMod = async (url) => {
      if (fetched.has(url)) return fetched.get(url);
      const r = await get(url);
      const rec = { url, status: r.status, body: decode(r.body || "") };
      fetched.set(url, rec);
      return rec;
    };

    // ── walk the app's module graph, from the shell, the way a browser does ──────
    const shell = await getRetry(base);
    const queue = [];
    for (const m of decode(shell.body || "").matchAll(/<script[^>]+src="([^"]+)"/g)) queue.push(m[1]);
    // An app module: served under our base, and not a vendor/pre-bundled/Vite-internal
    // one. Those are third-party code we are not compiling and must not grade.
    const isApp = (u) =>
      u.startsWith(base) && !u.includes("/node_modules/") && !u.includes("/@vite/") && !u.includes("/@id/");
    const appModules = [];
    while (queue.length) {
      const u = queue.shift();
      if (!u.startsWith("/") || fetched.has(u)) continue;
      const rec = await fetchMod(u);
      if (!isApp(u)) continue;
      appModules.push(rec);
      for (const m of rec.body.matchAll(/(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]/g)) queue.push(m[1]);
      for (const m of rec.body.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) queue.push(m[1]);
      for (const m of rec.body.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) queue.push(m[1]);
    }

    const gjs = appModules.filter((m) => /\.gjs(\?|$)/.test(m.url));
    results.push({
      label: "browser's module graph reaches both .gjs route modules",
      ok: gjs.length >= 2,
      detail: `${appModules.length} app modules, ${gjs.length} .gjs: ${gjs.map((m) => m.url.split("/").pop()).join(", ")}`,
    });

    // ── POSITIVE: every .gjs compiled to wire format ─────────────────────────────
    // Scoped to `.gjs` because only those carry a <template> to compile; requiring
    // createTemplateFactory of app.js would be nonsense.
    for (const m of gjs) {
      const short = m.url.replace(base, "");
      const compiled = /createTemplateFactory\s*\(/.test(m.body) && /"block":\s*"/.test(m.body);
      results.push({
        label: `${short} compiled to wire format (createTemplateFactory + block)`,
        ok: compiled,
        detail: compiled ? undefined : `${m.status}, ${m.body.length}B: ${m.body.slice(0, 120).replace(/\n/g, " ")}`,
      });
    }

    // ── NEGATIVE: no app module ANYWHERE reaches the compiler at runtime ─────────
    // Deliberately over every walked module, not the `.gjs` subset. `precompileTemplate`
    // is importable from plain `.js`/`.ts` too (the `@ember/template-compilation` public
    // API predates .gjs and is what .hbs colocation used), so a surviving call in a route
    // or component module throws on boot exactly like the shipped bug did. Scoping this
    // to `.gjs` made the assertion narrower than the guarantee stated above it: review
    // put a live call in app/router.js and this spike passed, exit 0.
    const leaking = appModules.filter((m) => RUNTIME_COMPILE_CALL.test(m.body) || COMPILER_IMPORT.test(m.body));
    results.push({
      label: "no app module makes a runtime precompileTemplate call",
      ok: leaking.length === 0,
      detail: leaking.length
        ? `stage two did not run for ${leaking.map((m) => m.url.replace(base, "")).join(", ")} — these throw on boot`
        : `${appModules.length} app modules checked`,
    });

    // ── the deep link, at MODULE level ───────────────────────────────────────────
    // Worth being precise about how little this proves, because an earlier version of
    // this work called it the strongest available evidence for keepPreviewPrefix. It is
    // not. Measured: `GET <base>definitely-not-a-route-xyz` returns the SAME 200 and the
    // same 441 bytes as `<base>about`, and on the build where every route module threw
    // on boot it still passed. A SPA fallback answers every URL with the shell.
    // So this asserts exactly one thing: the fallback is wired UNDER THE PREFIX, so a
    // reload on a child URL lands in the app instead of a 404. Whether the route works
    // is the compiled-module check above.
    const deep = await getRetry(`${base}about`);
    const deepBody = decode(deep.body || "");
    results.push({
      label: "deep link /about serves the app shell (SPA fallback under the prefix)",
      ok: deep.status === 200 && /Ember in Vivari/.test(deepBody),
      detail: `${deep.status}, ${deepBody.length}B`,
    });

    return results;
  },
});

process.exit(ok ? 0 : 1);