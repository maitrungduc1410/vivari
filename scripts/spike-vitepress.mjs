// Spike (NETWORK): prove the VitePress Docs template boots its dev server and
// serves the docs site in-VM. Mirrors the shipped `vitepress` template in
// packages/studio/src/oc/templates.ts.
//
// VitePress runs Vite 5, whose config loader ALWAYS esbuild-bundles the config
// file and imports the bundle via a temp `file://` URL — a path that fails/hangs
// in-VM (regular Vite templates dodge it with `--configLoader native`, which
// VitePress 1.x can't pass). The template therefore ships NO `.vitepress/config.*`
// so VitePress boots on defaults; this spike is the regression guard for that.
//
// We drive the real CLI: `vitepress dev docs --port <p>`
// (node_modules/vitepress/bin/vitepress.js). The first boot builds with Vite, so
// give the bind a longer budget.
//
// Gates: install ok, the dev server binds :3040, and GET / returns the VitePress
// app shell.
//   run (Node 22+):  node scripts/spike-vitepress.mjs   (needs vendored npm — see spike-harness)
process.env.OC_BIND_TIMEOUT ||= "300000"; // VitePress's first Vite build can be slow in-VM.
import { bootSpikeKernel, writeProject, npmInstall, waitListen, httpGet } from "./lib/spike-harness.mjs";

const DIR = "/vitepress";
const PORT = Number(process.env.OC_PORT || 3040);
const h = await bootSpikeKernel();

writeProject(h.kernel, DIR, {
  "package.json": `{
  "name": "vitepress-docs",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vitepress dev docs --port ${PORT}",
    "build": "vitepress build docs"
  },
  "devDependencies": { "vitepress": "^1.5.0" }
}
`,
  // Deliberately NO docs/.vitepress/config.* — see the header + template comment.
  "docs/index.md": `---
layout: home
hero:
  name: OpenContainer
  text: VitePress in the browser
  tagline: Edit and save — HMR is live.
---
`,
  "docs/guide.md": `# Guide

VitePress running inside OpenContainer with no config file.

\`\`\`ts
const doc = { title: 'Hello' }
console.log(doc.title.toUpperCase())
\`\`\`
`,
});

const inst = await npmInstall(h, { dir: DIR });
if (inst.code !== 0) process.exit(1);
if (process.env.OC_INSTALL_ONLY === "1") process.exit(0);

const bound = await waitListen(h, {
  dir: DIR,
  port: PORT,
  argv: ["node_modules/vitepress/bin/vitepress.js", "dev", "docs", "--port", String(PORT)],
});

let rootOk = false;
let guideOk = false;
if (bound) {
  const root = await httpGet(h.kernel, PORT, "/");
  rootOk = root.status === 200 && /vitepress|VPHero|<div id="app">/i.test(root.body);
  console.log(`  GET / -> ${root.status}  (${root.body.length} bytes)`);

  const guide = await httpGet(h.kernel, PORT, "/guide.html");
  guideOk = guide.status === 200;
  console.log(`  GET /guide.html -> ${guide.status}  (${guide.body.length} bytes)`);
}

const ok = inst.code === 0 && bound && rootOk && guideOk;
console.log(
  "\nRESULT: " +
    (ok
      ? "PASS — VitePress (config-less) dev server builds + serves the docs site in-VM"
      : "FAIL — see logs above"),
);
process.exit(ok ? 0 : 1);
