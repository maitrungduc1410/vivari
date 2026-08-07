// Spike (NETWORK): the React template — the studio's flagship, and until now the
// only frontend template with no dev-server gate at all. `react` was absent from
// the template-gate CI job (preact, lit, solid, vue, svelte, qwik were there), so
// the template most users start from was the one nothing ran.
//
// One thing here is deliberately unlike its neighbours, and it is the point.
//
// IT USES THE SHIPPED BYTES. Its neighbours hand-copy their template into the spike,
// which gates a copy: the file can drift from templates.ts and the spike stays green
// while the product breaks. This imports the real template through
// lib/shipped-templates.mjs — the same loader spike-template-syntax already uses — so
// the files are whatever the studio actually writes into the VFS. (The two Vite-7 pins,
// svelte and qwik, deliberately differ from their templates, so this is not simply the
// better way and theirs the worse one; it is available here because nothing about this
// template needs to differ.)
//
// What is no longer unlike them: RUNNING THE COMMAND THE STUDIO RUNS. `runViteSpike`
// boots every one of the seven via an interactive `sh` with that template's own
// manifest `dev` string, rather than calling the vite bin directly. That difference is
// why this class of bug survived: the
//    real path goes through npm's run-script, which does `if (p.stdin) p.stdin.end()`
//    — correct against node, where a script spawned with stdio:'inherit' has a null
//    stdin — and our ChildProcess used to answer with an object. The EOF that
//    produced reached vite, which treats end-of-stdin as "my parent is gone" and
//    shuts the dev server down. Every Vite template shipped that; every Vite spike
//    was green; the gap between them was two programs the harness stepped over.
//
// Run (Node 22+, needs network for npm — see spike-vite-lib.mjs for setup):
//   node scripts/spike-react.mjs

import { runViteSpike } from "./spike-vite-lib.mjs";
import { loadShippedTemplates } from "./lib/shipped-templates.mjs";

const templates = await loadShippedTemplates();
const react = templates.find((t) => t.manifest.id === "react-ts");
if (!react) {
  console.error("No `react-ts` template in packages/studio/src/vv/templates.ts — did its id change?");
  process.exit(2);
}

const ok = await runViteSpike({
  name: "React",
  dir: "/react",
  // The harness reads the dev command from this template's manifest — as it now does
  // for all seven, so there is one place the command lives rather than two.
  templateId: "react-ts",
  files: react.files,
  entryModule: "/src/main.tsx",
  titleMarker: /Vite \+ React/,
});

process.exit(ok ? 0 : 1);