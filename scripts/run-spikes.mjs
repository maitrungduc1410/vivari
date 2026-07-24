// Spike CI harness — one runner for the headless spikes that prove a template or
// subsystem still boots + serves in-VM. Turns the ad-hoc "run scripts/spike-*.mjs
// by hand" ritual into a gate we can wire into CI (see .gitlab-ci.yml).
//
// Tiers:
//   --offline   only spikes that need NO live registry network (fast; the default
//               gate). Still needs the Wasm VFS build for kernel-based ones.
//   --net       only spikes that install from the live npm registry (slow; needs a
//               vendored real npm at /tmp/vv-vendor — auto-provisioned here).
//   --all       both tiers (default when no tier flag is given).
//
// Filters: any extra args are substring filters on the spike name, e.g.
//   node scripts/run-spikes.mjs --net koa hono
//
// Env: VV_SPIKE_TIMEOUT (per-spike ms, default 360000), VV_LIVE=1 (stream output).
// Exit code is non-zero if any selected spike fails, so CI fails loudly.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_DIR = "/tmp/vv-vendor";
const VENDOR_NPM = path.join(VENDOR_DIR, "node_modules/npm");

// The curated spike set. `net` marks spikes that hit the live registry.
// `timeout` overrides the default where an install is unusually heavy.
const SPIKES = [
  // --- offline (no live registry) --------------------------------------------
  { name: "toolchain", file: "spike-toolchain.mjs", net: false, timeout: 60000 },
  { name: "http-llhttp", file: "spike-http-llhttp.mjs", net: false, timeout: 60000 },
  // ESM→CJS loader guarantees: top-level-await async retry + circular re-export
  // live bindings (SvelteKit config / astro runtime). Pure parser, no kernel/wasm.
  { name: "esm", file: "spike-esm.mjs", net: false, timeout: 60000 },
  // pnpm/cmd-shim bin unwrap — pure parser, no kernel/wasm needed.
  { name: "cmd-shim", file: "spike-cmd-shim.mjs", net: false, timeout: 60000 },
  // Import/export/share codecs (P2): zip writer verified with Node's zlib, and
  // the shareable-URL codec round-tripped. Pure web primitives, no kernel/wasm.
  { name: "zip-share", file: "spike-zip-share.mjs", net: false, timeout: 60000 },
  { name: "tar", file: "spike-tar.mjs", net: false, timeout: 60000 },
  // Persistent dependency cache (P1): pack node_modules → snapshot → wipe →
  // restore → require, against the real Wasm VFS. Offline + deterministic.
  // `needsWasm`: offline but requires the Node Wasm VFS build (pkg-node), so it
  // can't run in the Wasm-free toolchain-gate — it runs in the verify job.
  { name: "dep-cache", file: "spike-dep-cache.mjs", net: false, needsWasm: true, timeout: 120000 },
  // --- network: graduated templates gated here -------------------------------
  { name: "koa", file: "spike-koa.mjs", net: true },
  { name: "hono", file: "spike-hono.mjs", net: true },
  { name: "h3", file: "spike-h3.mjs", net: true },
  { name: "fastify", file: "spike-fastify.mjs", net: true },
  { name: "preact", file: "spike-preact.mjs", net: true },
  { name: "lit", file: "spike-lit.mjs", net: true },
  { name: "solid", file: "spike-solid.mjs", net: true },
  { name: "vue", file: "spike-vue.mjs", net: true },
  { name: "next", file: "spike-next.mjs", net: true, timeout: 600000 },
  { name: "docusaurus", file: "spike-docusaurus.mjs", net: true, timeout: 600000 },
  { name: "vitepress", file: "spike-vitepress.mjs", net: true, timeout: 600000 },
  { name: "webpack", file: "spike-webpack.mjs", net: true },
  { name: "vitest", file: "spike-vitest.mjs", net: true },
  { name: "angular", file: "spike-angular.mjs", net: true, timeout: 600000 },
  // In-VM databases (WASM SQL engines). PGlite ships ~16 MB of WASM + data, so
  // its install + first-boot compile need a longer budget.
  { name: "sqlite", file: "spike-sqlite.mjs", net: true },
  { name: "pglite", file: "spike-pglite.mjs", net: true, timeout: 900000 },
  // Server-Sent Events over the vv-sse tunnel (streams past the buffered HTTP proxy).
  { name: "sse", file: "spike-sse.mjs", net: true },
  // GraphQL Yoga API + demo UI (queries via GET/POST + a mutation).
  { name: "graphql", file: "spike-graphql.mjs", net: true },
  // FeathersJS (Koa transport) REST service — find() + create().
  { name: "feathers", file: "spike-feathers.mjs", net: true },
  // Nitro (unjs) CLI dev server — rollup build + auto-imports, longer budget.
  { name: "nitro", file: "spike-nitro.mjs", net: true, timeout: 600000 },
  // Socket.IO showcase — UI + client script + engine.io handshake in-VM.
  { name: "socketio", file: "spike-socketio.mjs", net: true },
  // Slidev (Vite + Vue) CLI dev server — first build is heavy, longer budget.
  { name: "slidev", file: "spike-slidev.mjs", net: true, timeout: 600000 },
  // tRPC server — raw .ts entry through OC's loader (no `export type`), typed query.
  { name: "trpc", file: "spike-trpc.mjs", net: true },
  // Astro dev server — Vite + @astrojs/compiler (Go/wasm) + esbuild; exercises the full
  // loader stack (live-binding fallback, globalThis.fs pre-seat, re-export getters). Heavy.
  { name: "astro", file: "spike-astro.mjs", net: true, timeout: 600000 },
];

const args = process.argv.slice(2);
const tier = args.includes("--offline") ? "offline" : args.includes("--net") ? "net" : "all";
const filters = args.filter((a) => !a.startsWith("--"));
const DEFAULT_TIMEOUT = Number(process.env.VV_SPIKE_TIMEOUT || 360000);

let selected = SPIKES.filter((s) => (tier === "all" ? true : tier === "net" ? s.net : !s.net));
if (filters.length) selected = selected.filter((s) => filters.some((f) => s.name.includes(f)));
// Drop spikes whose file doesn't exist yet, with a note (keeps the runner robust
// as the spike set evolves).
selected = selected.filter((s) => {
  const exists = fs.existsSync(path.join(ROOT, "scripts", s.file));
  if (!exists) console.log(`  (skip ${s.name}: scripts/${s.file} not found)`);
  return exists;
});
// Drop spikes that need the Node Wasm VFS when it hasn't been built. Keeps the
// Wasm-free gate (toolchain-gate) green; these run in the verify job where the
// crates are built (see .github/workflows/ci.yml).
const WASM_VFS = path.join(ROOT, "packages/vfs/pkg-node/vivari_vfs.js");
selected = selected.filter((s) => {
  if (s.needsWasm && !fs.existsSync(WASM_VFS)) {
    console.log(`  (skip ${s.name}: Wasm VFS not built — run 'npm run build:vfs:node')`);
    return false;
  }
  return true;
});

if (selected.length === 0) {
  console.error("No spikes selected.");
  process.exit(2);
}

async function ensureVendoredNpm() {
  if (fs.existsSync(path.join(VENDOR_NPM, "bin/npm-cli.js"))) return true;
  console.log("\n== provisioning vendored npm at " + VENDOR_DIR + " ==");
  fs.rmSync(VENDOR_DIR, { recursive: true, force: true });
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  const r = await spawnInherit("npm", ["install", "npm@10.9.2", "--no-save", "--no-audit", "--no-fund"], VENDOR_DIR);
  return r === 0 && fs.existsSync(path.join(VENDOR_NPM, "bin/npm-cli.js"));
}

function spawnInherit(cmd, argv, cwd) {
  return new Promise((resolve) => {
    const c = spawn(cmd, argv, { cwd, stdio: "inherit" });
    c.on("close", (code) => resolve(code | 0));
  });
}

function runSpike(s) {
  return new Promise((resolve) => {
    const timeout = s.timeout || DEFAULT_TIMEOUT;
    const started = Date.now();
    let timedOut = false;
    const child = spawn("node", [path.join("scripts", s.file), VENDOR_NPM], {
      cwd: ROOT,
      env: { ...process.env },
      stdio: process.env.VV_LIVE === "1" ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    if (child.stdout) child.stdout.on("data", (d) => (buf += d));
    if (child.stderr) child.stderr.on("data", (d) => (buf += d));
    const killer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, timeout);
    child.on("close", (code) => {
      clearTimeout(killer);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const pass = !timedOut && code === 0;
      if (!pass && process.env.VV_LIVE !== "1") {
        console.log(buf.slice(-2000));
      }
      console.log(`  ${pass ? "PASS" : "FAIL"}  ${s.name.padEnd(12)} (${secs}s${timedOut ? ", TIMED OUT" : `, exit ${code}`})`);
      resolve({ name: s.name, pass });
    });
  });
}

console.log(`Spike runner: tier=${tier}, ${selected.length} spike(s): ${selected.map((s) => s.name).join(", ")}`);

const needNet = selected.some((s) => s.net);
if (needNet && !(await ensureVendoredNpm())) {
  console.error("Failed to provision vendored npm; cannot run network spikes.");
  process.exit(2);
}

const results = [];
for (const s of selected) {
  console.log(`\n=== spike: ${s.name} (${s.net ? "network" : "offline"}) ===`);
  results.push(await runSpike(s));
}

const failed = results.filter((r) => !r.pass);
console.log("\n──────────────── summary ────────────────");
for (const r of results) console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
console.log(`  ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);