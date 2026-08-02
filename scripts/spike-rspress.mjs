// Spike (NETWORK): prove Rspress (the Rspack-powered docs SSG) boots + serves in-VM.
//
// Rspress v2 is Rsbuild + MDX/React/Shiki, so it rides the exact in-VM path
// spike-rsbuild.mjs already proves: our runtime reports `process.arch === "wasm32"`,
// so npm's platform auto-select resolves `@rspack/binding-wasm32-wasi` out of
// @rspack/binding's optionalDependencies and the Rust core runs as
// wasm32-wasip1-threads. No registry aliasing is involved — the wasm build is
// published under the binding's own scope, unlike esbuild/rollup/lightningcss.
//
// This is why the template depends on `@rspress/core` (v2) and NOT on `rspress`
// (whose `latest` is still v1): v1 exact-pins @rsbuild/core ~1.3.18 -> @rspack/core
// 1.3.9 -> @rspack/binding 1.3.9, and wasm32-wasi only appears in @rspack/binding
// 1.4.0+. Gate 1 below asserts the wasm binding is what actually landed, so a
// regression back onto a native addon fails loudly instead of silently.
//
// Gates (all must pass):
//   1) install ok, pulled @rspack/binding-wasm32-wasi and NO native @rspack/binding-*,
//      and the rspress CLI bin exists,
//   2) `rspress dev` binds its port,
//   3) GET the site root -> 200 with the real Rspress shell (#__rspress_root) + a
//      bundled <script>.
//
// The shipped template serves Rspress under the preview proxy prefix (config `base`
// "/preview/3000/", keepPreviewPrefix) so its client router resolves the first route.
// Set VV_BASE=/preview/3000/ to exercise that base-prefixed path here — the root GET
// then goes to the base, and an asset under the prefix must serve too (mirroring what
// the SW forwards un-stripped). Default "/" keeps the fast/plain regression run, the
// same split scripts/spike-docusaurus.mjs uses for VV_BASEURL.
//
//   1) vendor npm:  rm -rf /tmp/vv-vendor && mkdir -p /tmp/vv-vendor \
//        && (cd /tmp/vv-vendor && npm install npm@10.9.2 --no-save --no-audit --no-fund)
//   2) run (Node 22+):  node scripts/spike-rspress.mjs
//      env: VV_LIVE=1 (stream), VV_INSTALL_ONLY=1, VV_BASE=/preview/3000/, VV_PORT.

import { bootSpikeKernel, writeProject, defaultEnv, npmInstall, waitListen, httpGet } from "./lib/spike-harness.mjs";

const DIR = "/rspress";
const PORT = Number(process.env.VV_PORT || 3000);
const BASE = process.env.VV_BASE || "/";
const RSPRESS_VERSION = process.env.VV_RSPRESS_VERSION || "^2.0.19";

const h = await bootSpikeKernel();

// Minimal Rspress v2 site — the same shape the studio template ships (an .mjs config
// loaded by @rsbuild/core's loadConfig, docs/ as the default root, _meta/_nav sidebar).
writeProject(h.kernel, DIR, {
  "package.json": JSON.stringify(
    {
      name: "rspress-site",
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        dev: `rspress dev --port ${PORT}`,
        build: "rspress build",
      },
      dependencies: { "@rspress/core": RSPRESS_VERSION },
      devDependencies: { react: "^19.2.0", "react-dom": "^19.2.0" },
    },
    null,
    2,
  ),
  "rspress.config.mjs": `import { defineConfig } from "@rspress/core";

export default defineConfig({
  base: "${BASE}",
  lang: "en",
  title: "Rspress in Vivari",
  description: "Rspack-powered docs that build and run entirely in the browser VM",
});
`,
  "docs/_nav.json": `[{ "text": "Guide", "link": "/guide/getting-started", "activeMatch": "/guide/" }]\n`,
  "docs/index.md": `---
pageType: home

hero:
  name: Rspress in Vivari
  text: Docs, in the browser VM
  tagline: An Rspack-powered docs site compiled entirely client-side
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
---
`,
  "docs/guide/_meta.json": `["getting-started"]\n`,
  "docs/guide/getting-started.md": `# Getting Started

Rspress running inside Vivari's in-browser VM. Code blocks are highlighted by Shiki
during MDX compilation:

\`\`\`ts
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
\`\`\`
`,
});

// RSPRESS_PERSISTENT_CACHE=false mirrors the shipped template's manifest `env`, and it
// is load-bearing: with Rspress's default persistent build cache ON, the wasm Rspack
// binding PANICS mid-build with "no pids on this platform" (std::process::id() is
// unsupported on wasm32-wasip1) and the site never compiles. Plain Rsbuild never hit
// this because Rsbuild leaves performance.buildCache off by default — see the template
// header comment in templates.ts. Drop this and gate 3 fails.
const env = { ...defaultEnv(DIR), RSPRESS_PERSISTENT_CACHE: "false" };

// ── gate 1: install pulls the WASM Rspack binding, not a native addon ────────
const inst = await npmInstall(h, { dir: DIR, env });
if (inst.code !== 0) process.exit(1);

const wasmBinding = h.kernel.exists(DIR + "/node_modules/@rspack/binding-wasm32-wasi");
const nativeBinding = [
  "darwin-x64",
  "darwin-arm64",
  "linux-x64-gnu",
  "linux-x64-musl",
  "linux-arm64-gnu",
  "linux-arm64-musl",
  "win32-x64-msvc",
].some((p) => h.kernel.exists(DIR + "/node_modules/@rspack/binding-" + p));
const CLI = "node_modules/@rspress/core/bin/rspress.js";
const cliBin = h.kernel.exists(DIR + "/" + CLI);
console.log("  @rspack/binding-wasm32-wasi present: " + wasmBinding);
console.log("  a NATIVE @rspack/binding-* present:  " + nativeBinding + (nativeBinding ? "  (BAD)" : ""));
console.log("  rspress CLI bin present:             " + cliBin);

if (process.env.VV_INSTALL_ONLY === "1") {
  console.log("\nVV_INSTALL_ONLY=1 — stopping after install.");
  process.exit(wasmBinding && !nativeBinding && cliBin ? 0 : 1);
}

// ── gate 2: `rspress dev` binds the port ─────────────────────────────────────
const devStart = h.out.length;
const bound = await waitListen(h, { dir: DIR, port: PORT, argv: [CLI, "dev", "--port", String(PORT)], env });

// ── gate 3: GET the site root -> 200 with the Rspress shell ──────────────────
let getOk = false;
if (bound) {
  // Request the path exactly as the browser would under this base (the dev server
  // serves the app AT base, via Rsbuild's server.base).
  const root = await httpGet(h.kernel, PORT, BASE);
  getOk = root.status === 200 && /__rspress_root/.test(root.body) && /<script/.test(root.body);
  console.log(`  GET ${BASE} -> ${root.status}  (${root.body.length} bytes)`);
  console.log("  body head: " + root.body.slice(0, 220).replace(/\n/g, " "));
  console.log("  #__rspress_root present: " + /__rspress_root/.test(root.body));
  console.log("  bundle script present:   " + /<script/.test(root.body));

  // For a base-prefixed run, prove an asset also serves under the prefix — exactly
  // the request the browser makes and the SW forwards with the prefix intact.
  if (getOk && BASE !== "/") {
    const sm = root.body.match(/<script[^>]+src="([^"]+)"/i);
    if (sm) {
      const asset = await h.kernel.handleHttpRequest(PORT, {
        port: PORT,
        method: "GET",
        url: sm[1],
        headers: { host: "127.0.0.1:" + PORT },
        body: "",
      });
      const ct = (asset.headers && (asset.headers["content-type"] || asset.headers["Content-Type"])) || "";
      const assetOk = asset.status === 200 && !/text\/html/.test(ct);
      console.log(`  GET ${sm[1]} -> ${asset.status} (${ct}) assetOk=${assetOk}`);
      getOk = assetOk;
    } else {
      console.log("  (no <script src> found in the shell to verify asset serving)");
      getOk = false;
    }
  }
} else {
  console.log("\n---- dev output tail (last 4000 chars) ----\n" + h.out.slice(devStart).join("").slice(-4000));
}

const ok = inst.code === 0 && wasmBinding && !nativeBinding && cliBin && bound && getOk;
console.log(
  "\nRESULT: " +
    (ok
      ? `PASS — Rspress dev server boots on the wasm Rspack binding and serves ${BASE} with 200`
      : "FAIL — see logs above"),
);
process.exit(ok ? 0 : 1);