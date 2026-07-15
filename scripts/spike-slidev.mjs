// Spike (NETWORK): prove the Slidev Docs template boots its dev server and serves
// the slide deck in-VM. Mirrors the shipped `slidev` template in
// packages/studio/src/oc/templates.ts.
//
// Slidev is a Vite + Vue CLI dev server (@slidev/cli). Like Nitro, we drive the
// real CLI: `slidev --port 3030` (node_modules/@slidev/cli/bin/slidev.mjs). The
// first boot builds with Vite, so give the bind a longer budget.
//
// Gates: install ok, the dev server binds :3030, and GET / returns the Slidev app
// shell (contains "slidev").
//   run (Node 22+):  node scripts/spike-slidev.mjs   (needs vendored npm — see spike-harness)
process.env.OC_BIND_TIMEOUT ||= "300000"; // Slidev's first Vite build can be slow in-VM.
import { bootSpikeKernel, writeProject, npmInstall, waitListen, httpGet } from "./lib/spike-harness.mjs";

const DIR = "/slidev";
const PORT = Number(process.env.OC_PORT || 3030);
const h = await bootSpikeKernel();

writeProject(h.kernel, DIR, {
  "package.json": `{
  "name": "slidev-deck",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "slidev --port ${PORT}",
    "build": "slidev build",
    "export": "slidev export"
  },
  "dependencies": {
    "@slidev/cli": "^0.50.0",
    "@slidev/theme-default": "^0.25.0",
    "vue": "^3.5.0"
  }
}
`,
  "slides.md": `---
theme: default
title: Slidev on OpenContainer
---

# Slidev on OpenContainer

Presentation slides for developers — running in the browser

---

## Powered by Vite + Vue

- Write slides in Markdown
- Live hot reload as you edit slides.md
- Code highlighting, embedded components, and more
`,
});

const inst = await npmInstall(h, { dir: DIR });
if (inst.code !== 0) process.exit(1);
if (process.env.OC_INSTALL_ONLY === "1") process.exit(0);

const bound = await waitListen(h, {
  dir: DIR,
  port: PORT,
  argv: ["node_modules/@slidev/cli/bin/slidev.mjs", "--port", String(PORT)],
});

let rootOk = false;
if (bound) {
  const root = await httpGet(h.kernel, PORT, "/");
  rootOk = root.status === 200 && /slidev/i.test(root.body);
  console.log(`  GET / -> ${root.status}  (${root.body.length} bytes)  slidev-marker=${/slidev/i.test(root.body)}`);
}

const ok = inst.code === 0 && bound && rootOk;
console.log(
  "\nRESULT: " +
    (ok ? "PASS — Slidev dev server builds + serves the slide deck in-VM" : "FAIL — see logs above"),
);
process.exit(ok ? 0 : 1);
