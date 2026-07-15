// Spike (NETWORK): prove the Astro template boots its dev server and server-renders
// a page in-VM. Mirrors the shipped `astro` template in
// packages/studio/src/oc/templates.ts.
//
// Astro drives a real Vite dev server plus the Go/wasm `@astrojs/compiler` and esbuild's
// dep-optimizer. Getting here exercised the whole loader stack: the with-based live-binding
// fallback (astro's runtime is full of circular-const singletons), globalThis.fs pre-seating
// (so @astrojs/compiler doesn't lock fs away from esbuild), the ESM dynamic-import namespace
// fix (cssesc), and the early lazy re-export getter (middleware/index.js re-exports
// `sequence`, spread-called in RenderContext.create). This spike regression-gates all of it.
//
// Gates: install ok, `astro dev` binds :4321, and GET / server-renders the index page
// (contains the page title).
//   run (Node 22+):  node scripts/spike-astro.mjs   (needs vendored npm — see spike-harness)
process.env.OC_BIND_TIMEOUT ||= "300000"; // Astro's first Vite build + wasm boot can be slow in-VM.
import { bootSpikeKernel, writeProject, npmInstall, waitListen, httpGet, defaultEnv } from "./lib/spike-harness.mjs";

const DIR = "/astro";
const PORT = Number(process.env.OC_PORT || 4321);
const h = await bootSpikeKernel();

writeProject(h.kernel, DIR, {
  "package.json": `{
  "name": "astro-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview"
  },
  "dependencies": { "astro": "^5.1.0" }
}
`,
  "astro.config.mjs": `import { defineConfig } from 'astro/config'

export default defineConfig({})
`,
  "src/pages/index.astro": `---
const title = 'Astro on OpenContainer'
---

<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
  </head>
  <body style="font-family: system-ui, sans-serif; text-align: center; padding: 3rem">
    <h1>{title}</h1>
    <p>Edit <code>src/pages/index.astro</code> and save.</p>
  </body>
</html>
`,
});

const inst = await npmInstall(h, { dir: DIR });
if (inst.code !== 0) process.exit(1);
if (process.env.OC_INSTALL_ONLY === "1") process.exit(0);

// astro dev reads --port; pin it to the template's :4321.
const env = { ...defaultEnv(DIR), PORT: String(PORT) };
const bound = await waitListen(h, {
  dir: DIR,
  port: PORT,
  argv: ["node_modules/astro/astro.js", "dev", "--port", String(PORT)],
  env,
});

let rootOk = false;

if (bound) {
  const root = await httpGet(h.kernel, PORT, "/");
  rootOk = root.status === 200 && /Astro on OpenContainer/.test(root.body);
  console.log(`  GET / -> ${root.status}  ${root.body.slice(0, 120).replace(/\n/g, " ")}`);
}

const ok = inst.code === 0 && bound && rootOk;
console.log(
  "\nRESULT: " +
    (ok
      ? "PASS — Astro dev server boots (Vite + @astrojs/compiler wasm) and SSRs the index page in-VM"
      : "FAIL — see logs above"),
);
process.exit(ok ? 0 : 1);
