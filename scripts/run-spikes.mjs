// Spike CI harness — one runner for the headless spikes that prove a template or
// subsystem still boots + serves in-VM. Turns the ad-hoc "run scripts/spike-*.mjs
// by hand" ritual into a gate we can wire into CI (see .gitlab-ci.yml).
//
// Tiers:
//   --offline   only spikes that need NO live registry network (fast; the default
//               gate). Still needs the Wasm VFS build for kernel-based ones.
//   --net       only spikes that cannot run without the network (slow). Needs a
//               vendored real npm at /tmp/vv-vendor, plus per-spike scratch dirs
//               and studio delivery assets — all auto-provisioned here, see
//               VENDORS below.
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

// Host provisioning some spikes need before they can run at all. Two shapes:
//
//   { install: [<pkg@ver>...], dir, arg, probe }
//       `npm install` into a throwaway scratch dir. `arg` (relative to `dir`) is
//       the package root handed to the spike as argv[2]; `probe` (relative to
//       that root) is the idempotency check. Used by the spikes that load a real
//       CLI off the host disk — yarn/pnpm/corepack/tsgo/ws-demo.
//
//   { script: "vendor:<x>", asset: <repo-relative path> }
//       `npm run vendor:*`, which packs the browser DELIVERY asset the `-studio`
//       spikes decode through the shared loader. The vendor scripts are already
//       idempotent (they skip when the asset exists), and the assets are
//       gitignored build artifacts, so CI has to build them.
//
// Both shapes shell out to the live registry. That is why every spike carrying a
// `vendor` is `net: true` even when its own assertions are offline — the tier
// flag means "this spike cannot run without the network", not "it asserts over
// the network".
//
// Keep the pins in sync with the spike that asserts on them and with the matching
// scripts/vendor-*.mjs (each of those already carries the same note).
const VENDORS = {
  yarn: { install: ["yarn@1.22.22"], dir: "/tmp/vv-vendor-yarn", arg: "node_modules/yarn", probe: "bin/yarn.js" },
  pnpm: { install: ["pnpm@9.15.9"], dir: "/tmp/vv-vendor-pnpm", arg: "node_modules/pnpm", probe: "bin/pnpm.cjs" },
  corepack: { install: ["corepack@0.35.0"], dir: "/tmp/vv-vendor-corepack", arg: "node_modules/corepack", probe: "dist/corepack.js" },
  tsgo: { install: ["tsgo-wasm"], dir: "/tmp/vv-vendor-tsgo", arg: "node_modules/tsgo-wasm", probe: "tsgo.wasm" },
  wsDemo: { install: ["express@^4.21.0", "ws@^8.18.0"], dir: "/tmp/vv-vendor-wsdemo", arg: ".", probe: "node_modules/ws/package.json" },
  npmAsset: { script: "vendor:npm", asset: "packages/studio/public/vendor/npm-pack.bin" },
  yarnAsset: { script: "vendor:yarn", asset: "packages/studio/public/vendor/yarn-pack.bin" },
  pnpmAsset: { script: "vendor:pnpm", asset: "packages/studio/public/vendor/pnpm-pack.bin" },
  corepackAsset: { script: "vendor:corepack", asset: "packages/studio/public/vendor/corepack-pack.bin" },
  tsgoAsset: { script: "vendor:tsgo", asset: "packages/studio/public/vendor/tsgo-pack.bin" },
};

// The curated spike set. `net` marks spikes that cannot run without the live
// registry — either they install from it, or they need a `vendor` provisioned off
// it. `timeout` overrides the default where an install is unusually heavy.
const SPIKES = [
  // --- offline (no live registry) --------------------------------------------
  { name: "toolchain", file: "spike-toolchain.mjs", net: false, timeout: 60000 },
  // The tiers themselves: an offline spike that cannot run without the --net
  // provisioning is a category error, and `http-binary-body` shipped as one —
  // green here, exit 2 in the verify job. Pure static reads of this file, the
  // harness and ci.yml, so it costs nothing and runs in the earliest gate.
  { name: "ci-tiers", file: "spike-ci-tiers.mjs", net: false, timeout: 60000 },
  // No CI job compiles the studio — `tsc -b` runs in the Cloudflare build, which
  // is the deploy — so a JS module imported from TypeScript without a .d.ts
  // merges green and breaks the site afterwards. Static, so it needs neither bun
  // nor the studio's node_modules.
  { name: "studio-types", file: "spike-studio-types.mjs", net: false, timeout: 60000 },
  { name: "http-llhttp", file: "spike-http-llhttp.mjs", net: false, timeout: 60000 },
  // ESM→CJS loader guarantees: top-level-await async retry + circular re-export
  // live bindings (SvelteKit config / astro runtime). Pure parser, no kernel/wasm.
  { name: "esm", file: "spike-esm.mjs", net: false, timeout: 60000 },
  // Breakpoint debugger: the source instrumenter + in-guest CDP Debugger backend +
  // the debug-command SharedArrayBuffer channel (real Atomics across a worker).
  // Pure JS + vendored acorn, no kernel/wasm.
  { name: "debugger", file: "spike-debugger.mjs", net: false, timeout: 60000 },
  // pnpm/cmd-shim bin unwrap — pure parser, no kernel/wasm needed.
  { name: "cmd-shim", file: "spike-cmd-shim.mjs", net: false, timeout: 60000 },
  // Import/export/share codecs (P2): zip writer verified with Node's zlib, and
  // the shareable-URL codec round-tripped. Pure web primitives, no kernel/wasm.
  { name: "zip-share", file: "spike-zip-share.mjs", net: false, timeout: 60000 },
  { name: "tar", file: "spike-tar.mjs", net: false, timeout: 60000 },
  // Bun support (pure-JS tier): the synchronous TS/JSX transform, the Bun global
  // API surface, the bun:test runner, and the /bin/bun.js CLI source — all proven
  // with no kernel/wasm, so this runs in the Wasm-free toolchain-gate.
  { name: "bun-offline", file: "spike-bun-offline.mjs", net: false, timeout: 60000 },
  // Python (pure-JS tier): the python/gunicorn/uvicorn/flask argv seams run as
  // real Node subprocesses, CPython-faithful SystemExit, the generated bridge
  // dispatch source, and template-registry integrity. Pyodide itself is neither
  // committed nor installed by CI, so the interpreter-backed proof has to be
  // `net` (see "python" below) — everything provable without it lives here so
  // that Python, like Bun, is gated on every PR rather than nightly.
  { name: "python-offline", file: "spike-python-offline.mjs", net: false, timeout: 60000 },
  // Every shipped template's JavaScript parses. Templates are source stored in
  // template literals, where a backslash belongs to the OUTER literal first — a
  // regex can arrive in the generated project as a comment. No kernel, no Wasm,
  // no network: `node --check` per file, so it runs on every push.
  { name: "template-syntax", file: "spike-template-syntax.mjs", net: false, timeout: 120000 },
  // Signal delivery: the real Kernel, real Workers, a real SharedArrayBuffer and a
  // real Atomics.wait park — so it proves the mid-syscall path (the one a
  // postMessage cannot reach) as well as the default action, the grace window and
  // SIGKILL staying uncatchable. No VFS, no kernel-tier build needed.
  { name: "signals", file: "spike-signals.mjs", net: false, timeout: 60000 },
  // `__vv.diag()` must say WHY a process will not exit, not just that one hasn't.
  // Holds a guest open two different ways (a ref'd timer, a stdin reader) and
  // requires the reported `alive` breakdown to tell them apart — the distinction
  // the Bun template hang investigation had no way to make. Real Kernel + Workers,
  // no VFS needed.
  { name: "diag-liveness", file: "spike-diag-liveness.mjs", net: false, needsWasm: true, timeout: 60000 },
  // Exit codes and kernel survival when a guest fails; needs the VFS, so needsWasm.
  { name: "fatal-errors", file: "spike-fatal-errors.mjs", net: false, needsWasm: true, timeout: 120000 },
  // The inbound HTTP body path. Offline on purpose (plain node:http, no install):
  // a binary upload used to HANG rather than fail, so this belongs on every push.
  { name: "http-binary-body", file: "spike-http-binary-body.mjs", net: false, needsWasm: true, timeout: 120000 },
  // The mirror of http-binary-body: bodies leaving an in-VM server. Asserts the
  // bytes AND the encoding chosen for them — utf8 text that starts crossing as
  // base64 is a silent 33% inflation on every dev-server response.
  { name: "http-response-bytes", file: "spike-http-response-bytes.mjs", net: false, needsWasm: true, timeout: 120000 },
  // A login that survives to the next request. The seam dropped cookies both
  // ways, so every session flow in Node was silently unusable; the jar that fixes
  // it lives in the kernel, and this drives it through a real in-VM server.
  { name: "cookie-session", file: "spike-cookie-session.mjs", net: false, needsWasm: true, timeout: 120000 },
  // Persistent dependency cache (P1): pack node_modules → snapshot → wipe →
  // restore → require, against the real Wasm VFS. Offline + deterministic.
  // `needsWasm`: offline but requires the Node Wasm VFS build (pkg-node), so it
  // can't run in the Wasm-free toolchain-gate — it runs in the verify job.
  { name: "dep-cache", file: "spike-dep-cache.mjs", net: false, needsWasm: true, timeout: 120000 },
  // Bun runtime on the real kernel (offline): bun --version, zero-config `bun run
  // app.ts` (TS strip + Bun global), Bun.serve preview through the http bridge,
  // and `bun test`. Needs the Node Wasm VFS build → runs in the verify job.
  { name: "bun", file: "spike-bun.mjs", net: false, needsWasm: true, timeout: 120000 },
  // Every template in the studio's "Bun" tab, run from its SHIPPED bytes: the file
  // map and manifest are read out of templates.ts and the manifest's own `dev`
  // command is run in the kernel. The spike above proves the APIs; this proves the
  // things a user actually clicks. Offline — the Bun templates take no runtime
  // dependencies, which the spike asserts rather than assumes.
  { name: "bun-templates", file: "spike-bun-templates.mjs", net: false, needsWasm: true, timeout: 180000 },
  // --- network: graduated templates gated here -------------------------------
  { name: "koa", file: "spike-koa.mjs", net: true },
  { name: "hono", file: "spike-hono.mjs", net: true },
  // The S3 template. Installs the AWS SDK (net), then talks to an in-VM S3 that
  // verifies SigV4 byte for byte — so the signing is gated, not just the wiring.
  { name: "s3", file: "spike-s3.mjs", net: true, needsWasm: true, timeout: 300000 },
  // The shipped session template on real express-session. The offline
  // cookie-session spike gates the jar itself; this one exists for what a
  // hand-written server cannot check — a SIGNED, url-encoded `connect.sid` that
  // express-session parses back, and regenerate() rotating it on login.
  { name: "session-studio", file: "spike-session-studio.mjs", net: true, needsWasm: true, timeout: 300000 },
  { name: "h3", file: "spike-h3.mjs", net: true },
  { name: "fastify", file: "spike-fastify.mjs", net: true },
  { name: "preact", file: "spike-preact.mjs", net: true },
  { name: "lit", file: "spike-lit.mjs", net: true },
  { name: "solid", file: "spike-solid.mjs", net: true },
  // Svelte + Qwik round out the Vite frontend variants (same runViteSpike gates as
  // preact/lit/solid: install, dev-server bind, GET / with the title marker,
  // /@vite/client, and the entry module — the last one is what catches a broken
  // Svelte compiler pass or Qwik optimizer plugin). Pinned to Vite 7 on purpose;
  // see the spike headers for the rolldown-wasi bug that rules Vite 8 out.
  { name: "svelte", file: "spike-svelte.mjs", net: true },
  { name: "qwik", file: "spike-qwik.mjs", net: true },
  { name: "vue", file: "spike-vue.mjs", net: true },
  { name: "next", file: "spike-next.mjs", net: true, timeout: 600000 },
  { name: "docusaurus", file: "spike-docusaurus.mjs", net: true, timeout: 600000 },
  { name: "vitepress", file: "spike-vitepress.mjs", net: true, timeout: 600000 },
  { name: "webpack", file: "spike-webpack.mjs", net: true },
  // Rspack/Rsbuild — the Rust bundler (@rspack/binding-wasm32-wasi, a
  // wasm32-wasip1-threads build) runs in-VM. rspack: build + serve; rsbuild: dev
  // server. Rust-core installs are heavy, so give them the longer budget.
  { name: "rspack", file: "spike-rspack.mjs", net: true, timeout: 600000 },
  { name: "rsbuild", file: "spike-rsbuild.mjs", net: true, timeout: 600000 },
  // Rspress (docs SSG on Rsbuild) — same wasm Rspack binding, plus an MDX/React/Shiki
  // pipeline and a much larger dep tree than plain Rsbuild, so budget like Docusaurus.
  { name: "rspress", file: "spike-rspress.mjs", net: true, timeout: 900000 },
  // Starlight (docs SSG on Astro) — Astro's first in-VM Vite build plus a content-collection
  // pipeline; installs ~500 packages, so budget like the other docs templates.
  { name: "starlight", file: "spike-starlight.mjs", net: true, timeout: 900000 },
  // The STUDIO-shape counterpart, and the gate that should have existed first: spike-starlight
  // above drives npm through the kernel directly, which passed while the browser hung. This one
  // uses the shared loader + /bin shims + baseProcEnv + the interactive shell's VV_RUN, and
  // budgets the registry metadata a cold install pulls (see its header).
  { name: "starlight-studio", file: "spike-starlight-studio.mjs", net: true, timeout: 900000 },
  // Measures whether a PRE-BUILT dep-cache snapshot could replace a heavy template's first
  // install: install once, snapshot, wipe, restore, compare. Asserts a speedup RATIO rather
  // than a wall-clock budget so it does not go flaky on slower CI.
  { name: "starlight-depcache", file: "spike-starlight-depcache.mjs", net: true, timeout: 900000 },
  { name: "vitest", file: "spike-vitest.mjs", net: true },
  // Tailwind v4: proves the lightningcss -> lightningcss-wasm alias + the
  // @tailwindcss/oxide-wasm32-wasi selection let the v4 dev server generate CSS
  // in-VM. Rust-core install is heavy, so use the longer budget.
  { name: "tailwind", file: "spike-tailwind.mjs", net: true, timeout: 600000 },
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
  // Env ergonomics — inline `NAME=value cmd` prefix (via npm run), node --env-file,
  // and the dotenv package all loading a .env in-VM.
  { name: "dotenv", file: "spike-dotenv.mjs", net: true },
  // Bun install: `bun add <pkg>` delegates to the real npm CLI in-VM, writes a
  // text bun.lock, then a TS entry imports the installed dep. Network + Wasm VFS.
  { name: "bun-install", file: "spike-bun-install.mjs", net: true, needsWasm: true },
  // Astro dev server — Vite + @astrojs/compiler (Go/wasm) + esbuild; exercises the full
  // loader stack (live-binding fallback, globalThis.fs pre-seat, re-export getters). Heavy.
  { name: "astro", file: "spike-astro.mjs", net: true, timeout: 600000 },
  // Python: the WSGI/ASGI bridge + the seven Python templates, driven against real
  // Pyodide. Kernel-free by necessity (bootPyodide can't be reached from Node —
  // see the header of the spike), so it proves Python semantics and protocol
  // conversion, not the preview tunnel. `net` because Django/Flask come from PyPI
  // via micropip and pytest from the Pyodide CDN; the pyodide npm package is
  // provisioned into the same scratch dir vendor-pyodide.mjs uses.
  { name: "python", file: "spike-python-bridge.mjs", net: true, timeout: 600000 },
  // --- crypto-driven libraries (need `npm run build:crypto:node`) -------------
  // jsonwebtoken/jws: HS256/384/512 through the Wasm createHmac + the symmetric
  // KeyObject shim, and the RS256/PS256 asymmetric path through createSign/
  // createVerify. Proves the crypto layer holds up under a real library rather
  // than under our own unit calls.
  { name: "jwt", file: "spike-jwt.mjs", net: true, needsWasm: true },
  // jose importX509: the phase-3 X.509 driver. Imports a public key straight out
  // of a certificate via createPublicKey(certPem) and verifies a JWT with it
  // (RS256 + ES256), off the committed throwaway certs in scripts/fixtures/x509.
  { name: "jose", file: "spike-jose.mjs", net: true, needsWasm: true },
  // --- package managers: the North Star gate ---------------------------------
  // Running the REAL npm/yarn/pnpm/corepack CLIs in-VM is the headline capability
  // (README/roadmap), so it gets gated rather than hand-run. Each PM has two
  // spikes and they prove different things, so both are registered:
  //   <pm>         — the CLI loaded off the host disk: boots, does a live https
  //                  request through the in-VM stack, and completes a real install.
  //   <pm>-studio  — the BROWSER delivery path studio actually ships: the packed
  //                  vendor asset decodes + unpacks through the shared kernel-host
  //                  loader, and the CLI resolves on PATH via its /bin shim.
  // All of them drive the kernel, hence `needsWasm`. The `vendor` entries are what
  // make them runnable unattended — without one, the spike exits 2 on its own
  // "no vendored <pm>" preflight, which would register as a permanent FAIL.
  // `env` is how the tier turns on a spike's opt-in gates. Several of these were
  // written to be hand-run, so their most expensive assertion sits behind an env
  // flag AND initialises its ok-flag to `true` — skipping it does not merely skip,
  // it PASSES. Registering them without this table therefore bought a green tier
  // that had checked `--version` and nothing else: the four -studio spikes each
  // finished in under a second, never installing anything. The tier owns the
  // policy, so the flags belong here rather than flipped in each spike.
  //
  // npm additionally covers ground npm-studio does not: lifecycle scripts
  // (pre/post-install), the node-gyp stub being non-fatal, a dep's own JS
  // postinstall, .bin shim creation, `npm exec`, and an `npm ci` reinstall — three
  // full installs, hence the long budget. All of that is VV_PHASE2.
  { name: "npm", file: "spike-npm.mjs", net: true, needsWasm: true, env: { VV_PHASE2: "1" }, timeout: 600000 },
  { name: "npm-studio", file: "spike-npm-studio.mjs", net: true, needsWasm: true, vendor: VENDORS.npmAsset, env: { VV_NET: "1" }, timeout: 180000 },
  { name: "yarn", file: "spike-yarn.mjs", net: true, needsWasm: true, vendor: VENDORS.yarn, timeout: 600000 },
  { name: "yarn-studio", file: "spike-yarn-studio.mjs", net: true, needsWasm: true, vendor: VENDORS.yarnAsset, env: { VV_NET: "1" }, timeout: 180000 },
  // pnpm is the riskiest PM: real worker_threads for fetch/extract and a SYMLINKED
  // node_modules, on a ~20 MB / 900-file tree. Long budget for both.
  { name: "pnpm", file: "spike-pnpm.mjs", net: true, needsWasm: true, vendor: VENDORS.pnpm, timeout: 600000 },
  { name: "pnpm-studio", file: "spike-pnpm-studio.mjs", net: true, needsWasm: true, vendor: VENDORS.pnpmAsset, env: { VV_NET: "1" }, timeout: 300000 },
  // corepack proves the download->gunzip->untar->sha512-verify->exec path, so a
  // project can pin any yarn/pnpm version rather than only our vendored one.
  { name: "corepack", file: "spike-corepack.mjs", net: true, needsWasm: true, vendor: VENDORS.corepack, timeout: 600000 },
  { name: "corepack-studio", file: "spike-corepack-studio.mjs", net: true, needsWasm: true, vendor: VENDORS.corepackAsset, env: { VV_NET: "1" }, timeout: 300000 },
  // --- other real toolchains -------------------------------------------------
  // TypeScript 7 (tsgo): the Go/wasm compiler boots in a Process Worker off
  // globalThis.fs and type-checks VFS files. Gates both directions — a clean
  // project exits 0, and a real type error exits non-zero with a TS diagnostic
  // (without that second gate a compiler that never checks anything would pass).
  { name: "tsgo", file: "spike-tsgo.mjs", net: true, needsWasm: true, vendor: VENDORS.tsgo, timeout: 600000 },
  { name: "tsgo-studio", file: "spike-tsgo-studio.mjs", net: true, needsWasm: true, vendor: VENDORS.tsgoAsset, timeout: 300000 },
  // WebSocket template end-to-end: the kernel routes a tunneled ws 'open' to the
  // real `ws` backend on :3001 and relays frames BOTH ways (server push + a
  // client->server->client echo). No install in-VM, so a short budget is enough.
  { name: "ws-demo", file: "spike-ws-demo.mjs", net: true, needsWasm: true, vendor: VENDORS.wsDemo, timeout: 120000 },
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

/** Absolute path a `vendor` spec produces, and which the spike is handed as argv[2]. */
function vendorRoot(v) {
  return v.script ? path.join(ROOT, v.asset) : path.resolve(v.dir, v.arg);
}

/** Provision one `vendor` spec (see VENDORS). Idempotent; returns false if it failed. */
async function ensureVendor(v) {
  const root = vendorRoot(v);
  const probe = v.script ? root : path.join(root, v.probe);
  if (fs.existsSync(probe)) return true;
  if (v.script) {
    console.log(`\n== provisioning ${v.asset} (npm run ${v.script}) ==`);
    const r = await spawnInherit("npm", ["run", v.script], ROOT);
    return r === 0 && fs.existsSync(probe);
  }
  console.log(`\n== provisioning ${v.install.join(" ")} at ${v.dir} ==`);
  fs.rmSync(v.dir, { recursive: true, force: true });
  fs.mkdirSync(v.dir, { recursive: true });
  const r = await spawnInherit("npm", ["install", ...v.install, "--no-save", "--no-audit", "--no-fund"], v.dir);
  return r === 0 && fs.existsSync(probe);
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
    // argv[2] is the vendored tree the spike loads off the host disk. Spikes with
    // their own scratch dir get that; everything else gets the shared real npm.
    // (The `-studio` spikes read their packed asset from the repo and ignore it.)
    const vendorArg = s.vendor?.install ? vendorRoot(s.vendor) : VENDOR_NPM;
    const child = spawn("node", [path.join("scripts", s.file), vendorArg], {
      cwd: ROOT,
      env: { ...process.env, ...(s.env || {}) },
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
      console.log(`  ${pass ? "PASS" : "FAIL"}  ${s.name.padEnd(16)} (${secs}s${timedOut ? ", TIMED OUT" : `, exit ${code}`})`);
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
  // Provisioning failure is a FAIL, not a skip: these spikes exit 2 on their own
  // "no vendored <x>" preflight, and a gate that quietly disappears when its
  // input is missing is the failure mode this table exists to avoid.
  if (s.vendor && !(await ensureVendor(s.vendor))) {
    console.log(`  FAIL  ${s.name.padEnd(16)} (could not provision ${s.vendor.asset || s.vendor.install.join(" ")})`);
    results.push({ name: s.name, pass: false });
    continue;
  }
  results.push(await runSpike(s));
}

const failed = results.filter((r) => !r.pass);
console.log("\n──────────────── summary ────────────────");
for (const r of results) console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
console.log(`  ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);