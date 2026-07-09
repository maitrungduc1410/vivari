// Production build for the demo — bundle-by-worker-role (roadmap: Packaging).
//
// In dev the browser loads the runtime as ~120 individual ES modules (readable,
// debuggable, diffable against upstream Node). That's a deliberate DEV choice,
// not the shipping shape: it means a rain of requests on load and per Worker
// spawn. This script produces the shipping shape without touching the dev files:
// one esbuild bundle per worker role, so each Worker is a single cached request.
//
//   node scripts/build-demo.mjs   ->   packages/demo-dist/
//   (serve it at /packages/demo-dist/index.html)
//
// Why a SIBLING dir (packages/demo-dist) rather than packages/demo/dist: esbuild
// leaves `new URL(x, import.meta.url)` expressions verbatim (it does not bundle
// workers or copy assets referenced that way). The inter-worker refs
// (`new URL('./process-worker.js', import.meta.url)`) and the wasm refs
// (`new URL('../codec/pkg/..._bg.wasm', import.meta.url)`) therefore pass through
// unchanged — and because demo-dist sits at the SAME depth under packages/ as
// demo, every `../codec|crypto|wasi-demo/...` still resolves to the same file.
// Only `./vendor/...` (relative to the demo dir) needs copying alongside.

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { cpSync, mkdirSync, rmSync, copyFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEMO = join(ROOT, "packages/demo");
const OUT = join(ROOT, "packages/demo-dist");

// One bundle per worker role. Each is an independent module graph entry; the
// cross-worker `new Worker(new URL('./<role>.js', import.meta.url))` references
// resolve to the sibling bundle of the same basename inside demo-dist.
const ENTRIES = [
  "host.js", // main thread (UI + orchestration)
  "kernel-worker.js", // Kernel + virtual net + process supervision
  "process-worker.js", // a process: the whole vendored Node runtime (~120 files -> 1)
  "fs-worker.js", // Rust/Wasm VFS
  "fetcher-worker.js", // outbound network
  "sw.js", // preview Service Worker (standalone, no imports)
];

function dirSize(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    total += st.isDirectory() ? dirSize(p) : st.size;
  }
  return total;
}
const kb = (n) => (n / 1024).toFixed(1) + " KB";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// A per-build id stamped into sw.js (via `define`). It names the Service Worker's
// precache, so a new build gets a fresh cache and its `activate` drops the old
// one — a redeploy can never serve stale bundles. Changing bytes → changing
// sw.js → the browser installs the new SW and re-caches. (Dev never sees this
// token, so its sw.js keeps caching disabled and edits keep hot-reloading.)
const BUILD_ID = Date.now().toString(36);

const result = await build({
  entryPoints: ENTRIES.map((f) => join(DEMO, f)),
  outdir: OUT,
  bundle: true,
  format: "esm",
  target: "esnext",
  splitting: false, // each worker role must be a standalone file (no shared chunks)
  minify: true,
  legalComments: "none",
  logLevel: "info",
  metafile: true,
  define: { __OC_BUILD_ID__: JSON.stringify(BUILD_ID) },
});

// Assets fetched at runtime *relative to the demo dir* (not siblings under
// packages/). Only the napi-crc32 vendor tree qualifies; copy it alongside.
cpSync(join(DEMO, "vendor"), join(OUT, "vendor"), { recursive: true });

// The page shell references ./host.js + ./sw.js relatively, so it works as-is
// from demo-dist (pointing at the bundled siblings). Copy it verbatim.
copyFileSync(join(DEMO, "index.html"), join(OUT, "index.html"));

// Per-entry sizes (bundled), then the dev baseline for comparison.
console.log("\nBundled (packages/demo-dist/):");
for (const [file, meta] of Object.entries(result.metafile.outputs)) {
  if (file.endsWith(".js")) console.log("  " + file.replace(ROOT + "/", "") + "  " + kb(meta.bytes));
}
const devFiles = countJs(DEMO) + countJs(join(ROOT, "packages/runtime"));
console.log(
  `\nDev loads ~${devFiles} JS modules across the workers; the build collapses that to ${ENTRIES.length} bundles.`,
);
console.log("Total demo-dist: " + kb(dirSize(OUT)) + " (incl. copied vendor assets)");
console.log("Service Worker precache id: " + BUILD_ID + "\n");

function countJs(dir) {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) n += countJs(p);
    else if (name.endsWith(".js")) n++;
  }
  return n;
}
