// Spike (NETWORK): prove the Starlight template installs + boots on the STUDIO path.
//
// Why this exists as a separate spike from scripts/spike-starlight.mjs: that one calls the
// harness's npmInstall(), which runs `node <vfs npm>/bin/npm-cli.js install` directly. The
// browser does something meaningfully different, and the difference hid a hang that shipped:
//
//   spike-starlight.mjs                    studio (packages/core/src/workers/kernel-worker.ts)
//   ─────────────────────────────────────  ────────────────────────────────────────────────────
//   npm tree copied off the host disk      ensureRealNpm() unpacks the vendored npm-pack.bin
//   `node …/bin/npm-cli.js install`        `npm install` resolved via PATH -> /bin/npm.js shim
//   HOME=/home/user, cache /tmp/.npm       HOME=/, cache /home/user/.cache/npm  (baseProcEnv)
//   one command                            a SHELL running `npm install && npm run dev`
//
// AGENTS.md (~L577) already says to verify browser-shape changes with a *-studio.mjs gate for
// exactly this reason; the Starlight template was shipped without one. This spike closes that
// gap: it drives the same shared loader + PATH shims + env the browser does, and runs the
// literal command a user types.
//
// HONEST LIMIT, worth reading before trusting a green run here. This spike passes, and so does
// a real cold Chrome run against the built studio, yet a user's first install still stalled for
// 30 minutes with no output. Whatever decides that outcome is not captured by anything below —
// most likely VFS/OPFS write throughput or a memory ceiling during reify on weaker hardware.
// A pass here means "the install/boot path is wired correctly", NOT "this is fast enough for a
// user". That is why the template is marked experimental.
//
// Gates (all must pass):
//   1) the shared loader lands real npm and the /bin/npm.js shim (studio wiring, not ours),
//   2) `npm install` COMPLETES through the shim under the studio env — the regression that
//      shipped was a hang here, after the downloads finished, so this asserts termination and
//      is the reason the spike has a hard timeout rather than an unbounded wait,
//   3) the install actually populated node_modules (astro + starlight + the wasm sharp),
//   4) `npm run dev` (again via the shim) binds the port and serves the Starlight shell.
//
// Run (Node 22+):  node scripts/spike-starlight-studio.mjs
//   Prereq: the vendor asset — `npm run vendor:npm` (packs npm@10.9.2 into
//   packages/studio/public/vendor/npm-pack.bin, the same bytes the browser fetches).
//   env: VV_LIVE=1 (stream output), VV_INSTALL_TIMEOUT, VV_KEEP_SCRIPTS=1 (see below).

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { ensureRealNpm, NPM_VFS_ROOT } from "../packages/kernel-host/load-real-npm.js";
import { initTransferList } from "../packages/kernel-host/worker-transfer.js";
import { createAliasedFetcher } from "./lib/aliased-fetcher.mjs";
import { Worker, MessageChannel } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIVE = process.env.VV_LIVE === "1";
const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const ASSET = path.join(ROOT, "packages", "studio", "public", "vendor", "npm-pack.bin");
const DIR = "/starlight-ts-app";
const PORT = 4321;
const BASE = `/preview/${PORT}/`;

if (!fs.existsSync(ASSET)) {
  console.error(`No vendor asset at ${path.relative(ROOT, ASSET)} — run \`npm run vendor:npm\` first.`);
  process.exit(2);
}

// ── kernel setup (same shape as spike-npm-studio.mjs) ────────────────────────
const fsWorker = new Worker(new URL("./fs-worker.mjs", import.meta.url));
let onKernelFsMessage = () => {};
await new Promise((resolve) => {
  fsWorker.on("message", (m) => {
    if (m.type === "ready") resolve();
    else onKernelFsMessage(m);
  });
});
const kernelFs = createKernelFs(fsWorker);
onKernelFsMessage = kernelFs.onMessage;

const spawnWorker = (info) => {
  const w = new Worker(new URL("./process-worker.mjs", import.meta.url));
  w.on("message", (m) => {
    const h = info.on[m.type];
    if (h) h(m);
  });
  w.on("error", (e) => process.stderr.write(`\n[worker-error pid ${info.pid}] ${(e && e.stack) || e}\n`));
  const { port1, port2 } = new MessageChannel();
  fsWorker.postMessage({ type: "fs-register", client: info.pid, sab: info.sab, port: port2 }, [port2]);
  const init = { type: "init", sab: info.sab, spec: info.spec, fsPort: port1 };
  if (info.threadPort) init.threadPort = info.threadPort;
  // A worker pool (tinypool, piscina, synckit) puts a MessagePort in workerData;
  // initTransferList is what knows those must be transferred on to the child.
  w.postMessage(init, initTransferList(info, port1));
  return {
    terminate: () => {
      w.terminate();
      fsWorker.postMessage({ type: "fs-unregister", client: info.pid });
    },
    postMessage: (m) => w.postMessage(m),
  };
};

const out = [];
const cap = (s) => {
  out.push(s);
  if (LIVE) process.stderr.write(s);
};
const listening = new Set();
// Registry-metadata budget. Be clear about what this does and does not prove: it guards the
// RESOLVE/DOWNLOAD phase, and it would NOT have caught the first-install stall a user reported
// (that sits later, in reify — see gotcha 6 in the template's header). It is kept because the
// volume regression it catches is real and was worth 4x. npm's
// ideal-tree builder always requests FULL packuments (arborist #fetchManifest hardcodes
// fullMetadata: true), and every optional peerDependency in the tree costs one. Astro's
// unstorage/db0 name ~19 of them, several among the largest packages on npm, so the template
// originally pulled ~420 MB of DECODED JSON through the fetcher and VFS on a cold cache —
// 4x Rspress, worse than Docusaurus — and the first install looked wedged for minutes.
// Byte volume, not wall-clock, is the honest signal here: it is stable across machines and
// network speed, whereas a timeout would be flaky in CI and is exactly what a slow-but-
// working install defeats. Measured baselines: Rspress 100 MB, Starlight WITH the template's
// .npmrc 108 MB, Starlight WITHOUT it 421 MB, Docusaurus 341 MB. The budget sits above the
// fixed figure with headroom for registry growth but far below the regression.
const METADATA_BUDGET_MB = Number(process.env.VV_METADATA_BUDGET_MB || 200);
let fetchedBytes = 0;
const biggest = [];
// The browser aliases native->wasm packuments in its fetcher worker
// (packages/core/src/workers/fetcher-worker.ts, same table as this helper), so the studio
// shape includes it — without it esbuild/rollup would fetch native binaries here.
const aliased = createAliasedFetcher();
const meteredFetcher = async (url, init) => {
  const r = await aliased(url, init);
  const n = (r.body && r.body.length) || 0;
  fetchedBytes += n;
  biggest.push([n, url]);
  return r;
};
const kernel = new Kernel({ fs: kernelFs.fs, spawnWorker, fetcher: meteredFetcher, stdout: cap, stderr: cap });
kernel.onListen = (port) => listening.add(port);
kernel.installCoreutils();
let fetchN = 0;
let lastFetch = "";
kernel.onFetch = (u, i) => {
  fetchN++;
  lastFetch = u;
  if (LIVE) process.stderr.write(`  [net ${fetchN}] ${i.cached ? "cache" : "GET"} ${((i.size / 1024) | 0)}k  ${u}\n`);
};

// ── gate 1: the studio's own wiring — shared loader + PATH shim ──────────────
// Mirrors kernel-worker.ts's boot: the same dirs it mkdirs, then ensureRealNpm fed the same
// vendor bytes the browser fetches from /vendor/npm-pack.bin.
kernel.mkdirp("/tmp");
kernel.mkdirp("/home/user");
kernel.mkdirp("/home/user/.cache/npm/_logs");
const t0 = Date.now();
const loaded = await ensureRealNpm(kernel, async () => new Uint8Array(fs.readFileSync(ASSET)));
console.log(`ensureRealNpm: version=${loaded && loaded.version} files=${loaded && loaded.fileCount} (${Date.now() - t0}ms)`);
const shim = kernel.readFile("/bin/npm.js") || "";
const shimOk = /real npm shim/.test(shim) && shim.includes(NPM_VFS_ROOT + "/bin/npm-cli.js");
console.log(`  shim gate: ${shimOk ? "PASS" : "FAIL"}  (/bin/npm.js -> real npm-cli.js)`);

// The studio's process env, verbatim from baseProcEnv() in kernel-worker.ts. The differences
// from the headless harness's defaultEnv() are load-bearing (HOME, the persisted cache dir,
// audit/fund/notifier off), so they are reproduced rather than approximated.
const env = {
  PATH: DIR + "/node_modules/.bin:/bin",
  HOME: "/",
  npm_config_cache: "/home/user/.cache/npm",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
  NO_UPDATE_NOTIFIER: "1",
  XDG_CACHE_HOME: "/home/user/.cache",
  XDG_CONFIG_HOME: "/home/user/.config",
  XDG_DATA_HOME: "/home/user/.local/share",
  XDG_STATE_HOME: "/home/user/.local/state",
  TERM: "xterm-256color",
  FORCE_COLOR: "3",
  PWD: DIR,
};

// ── the project under test: the shipped Starlight template ───────────────────
const FILES = {
  "package.json": `{
  "name": "starlight-docs",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "astro dev --port 4321",
    "build": "astro build",
    "preview": "astro preview --port 4321"
  },
  "dependencies": {
    "astro": "^5.18.0",
    "@astrojs/starlight": "^0.37.7"
  }
}
`,
  "astro.config.mjs": `import { defineConfig, passthroughImageService } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  base: '${BASE}',
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: 'Starlight on Vivari',
      description: 'Docs that build and run entirely in the browser VM',
      pagefind: false,
      sidebar: [
        { label: 'Guides', items: [{ label: 'Getting Started', slug: 'guides/getting-started' }] },
      ],
    }),
  ],
})
`,
  // Mirrors the shipped template. Without it npm resolves manifests for ~19 optional peer
  // deps of Astro's unstorage/db0 (Prisma, Drizzle, react-native, Azure, Xata) and drags
  // ~420 MB of decoded packument JSON through the fetcher instead of ~108 MB. See gate 5.
  ".npmrc": `legacy-peer-deps=true\n`,
  "ec.config.mjs": `export default {
  styleOverrides: { borderRadius: '0.4rem' },
}
`,
  "public/favicon.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M64 0 47 36 0 64l36 17 17 47 17-36 47-17-36-17Z"/></svg>
`,
  "src/content.config.ts": `import { defineCollection } from 'astro:content'
import { docsLoader } from '@astrojs/starlight/loaders'
import { docsSchema } from '@astrojs/starlight/schema'

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
}
`,
  "src/content/docs/index.mdx": `---
title: Starlight on Vivari
description: An Astro Starlight docs site compiled entirely in the browser VM
---

Welcome to **Starlight**, running entirely inside Vivari's in-browser VM.
`,
  "src/content/docs/guides/getting-started.md": `---
title: Getting Started
description: Add a page and watch it hot-reload
---

Drop a file under \`src/content/docs/\`.
`,
};
for (const [rel, contents] of Object.entries(FILES)) {
  const p = DIR + "/" + rel;
  kernel.mkdirp(p.slice(0, p.lastIndexOf("/")));
  kernel.writeFile(p, contents);
}

// ── gate 2: `npm install` via the shim TERMINATES ────────────────────────────
// The shipped regression was a hang right here — after the downloads finished, during the
// lifecycle-script phase — so the assertion is that this completes at all. A heartbeat prints
// the last fetched URL so a future hang is diagnosable from CI output instead of silent.
const INSTALL_TIMEOUT = Number(process.env.VV_INSTALL_TIMEOUT || 600000);
console.log(`\n== npm install (via /bin/npm.js, studio env) ==`);
const t1 = Date.now();
let done = false;
let timedOut = false;
const beat = setInterval(() => {
  if (!done) console.log(`  … ${((Date.now() - t1) / 1000).toFixed(0)}s, ${fetchN} fetches, last: ${lastFetch.slice(-70)}`);
}, 15000);
// THE SHAPE THAT MATTERS. The studio does not run `sh -c "npm install"`: openTerminal() in
// kernel-worker.ts launches an INTERACTIVE shell and hands it the compound command via VV_RUN
// (`<install> && <dev>`), which the shell auto-runs as if typed. Batch `sh -c` and the
// interactive shell are different code paths in coreutils.js (drain()/currentChild, VV_TTY),
// so the gate drives the interactive one — that is what a user actually triggers via Run.
// VV_NPM_ARGS appends flags for diagnosis; `--foreground-scripts --loglevel=silly` is what
// makes a wedged lifecycle script visible (the shipped hang printed nothing after the last
// tarball).
// Mirrors the manifest verbatim, --ignore-scripts included: that flag is what stops sharp's
// install script from wedging npm forever (see the header), so dropping it here would make this
// gate pass on a command the studio does not run.
const installCmd = `npm install --ignore-scripts${process.env.VV_NPM_ARGS ? " " + process.env.VV_NPM_ARGS : ""}`;
const shellEnv = { ...env, VV_RUN: `${installCmd} && npm run dev` };
const pid = kernel.launch("sh", [], { cwd: DIR, env: shellEnv });
if (pid < 0) {
  console.log("  FAIL: could not launch the shell");
  process.exit(1);
}
// The compound command means "installed" is observable only indirectly: node_modules
// appearing, then the dev server binding. Poll for both rather than awaiting an exit code,
// because the shell stays alive holding the dev server (exactly like a real terminal tab).
let installSeen = 0;
while (Date.now() - t1 < INSTALL_TIMEOUT) {
  await new Promise((r) => setTimeout(r, 500));
  if (!installSeen && /added \d+ packages/.test(out.join(""))) installSeen = Date.now();
  if (installSeen) break;
}
done = true;
clearInterval(beat);
const installOk = !!installSeen;
timedOut = !installOk;
console.log(
  `  install completed: ${installOk}${timedOut ? "  (TIMED OUT — the studio-path hang)" : ""}  (${((Date.now() - t1) / 1000).toFixed(1)}s)`,
);
if (!installOk) console.log("  output tail:\n" + out.join("").slice(-3000));

// ── gate 3: node_modules is actually populated ───────────────────────────────
const astroCli = ["node_modules/astro/astro.js", "node_modules/astro/bin/astro.mjs"].find((p) =>
  kernel.exists(DIR + "/" + p),
);
const starlightPkg = kernel.exists(DIR + "/node_modules/@astrojs/starlight/package.json");
const nativeSharp = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"].some((p) =>
  kernel.exists(DIR + "/node_modules/@img/sharp-" + p),
);
console.log(`  astro CLI present:              ${!!astroCli}${astroCli ? `  (${astroCli})` : ""}`);
console.log(`  @astrojs/starlight present:     ${starlightPkg}`);
console.log(`  a NATIVE @img/sharp-* present:  ${nativeSharp}${nativeSharp ? "  (BAD)" : ""}`);
const treeOk = !!astroCli && starlightPkg && !nativeSharp;

// ── gate 4: `npm run dev` binds + serves ─────────────────────────────────────
let bound = false;
let shellOk = false;
if (installOk && treeOk) {
  // No second spawn: the SAME shell continues past `&&` into `npm run dev`, so this waits on
  // the compound command the studio actually issued.
  console.log(`\n== npm run dev (same shell, after &&) ==`);
  const devStart = out.length;
  const BIND_TIMEOUT = Number(process.env.VV_BIND_TIMEOUT || 300000);
  const tb = Date.now();
  while (!listening.has(PORT) && Date.now() - tb < BIND_TIMEOUT) {
    await new Promise((r) => setTimeout(r, 200));
  }
  bound = listening.has(PORT);
  console.log(`  listening on ${PORT}: ${bound}  (${((Date.now() - tb) / 1000).toFixed(1)}s)`);
  if (!bound) console.log("  dev output tail:\n" + out.slice(devStart).join("").slice(-3000));
  else {
    const decode = (b) => (typeof b === "string" ? b : Buffer.from(b).toString());
    let r = { status: 0, body: "" };
    for (let i = 0; i < 60; i++) {
      const raw = await kernel.handleHttpRequest(PORT, {
        port: PORT,
        method: "GET",
        url: BASE,
        headers: { host: "127.0.0.1:" + PORT },
        body: "",
      });
      r = { status: raw.status, body: decode(raw.body || "") };
      if (r.status === 200) break;
      await new Promise((res) => setTimeout(res, 1000));
    }
    shellOk = r.status === 200 && /Starlight on Vivari/.test(r.body) && /\bsl-/.test(r.body);
    console.log(`  GET ${BASE} -> ${r.status} (${r.body.length} bytes)  Starlight shell: ${shellOk}`);
  }
}

// ── gate 5: registry-metadata volume stays inside budget ─────────────────────
const fetchedMB = fetchedBytes / 1048576;
biggest.sort((a, b) => b[0] - a[0]);
const budgetOk = fetchedMB <= METADATA_BUDGET_MB;
console.log(
  `\n  registry metadata pulled: ${fetchedMB.toFixed(1)} MB (budget ${METADATA_BUDGET_MB} MB) -> ${budgetOk ? "OK" : "OVER BUDGET"}`,
);
console.log(
  "  heaviest: " +
    biggest
      .slice(0, 5)
      .map(([n, u]) => `${(n / 1048576).toFixed(0)}MB ${decodeURIComponent(u.split("/").slice(3).join("/")).slice(0, 40)}`)
      .join(", "),
);
if (!budgetOk) {
  console.log(
    "  A jump here usually means new OPTIONAL peerDependencies entered the tree (npm fetches a\n" +
      "  FULL packument for each). Check the heaviest list above before raising the budget — the\n" +
      "  template's .npmrc (legacy-peer-deps) is what keeps this in range.",
  );
}

const ok = shimOk && installOk && treeOk && bound && shellOk && budgetOk;
console.log(
  "\nRESULT: " +
    (ok
      ? "PASS — Starlight installs and boots on the studio path (shared loader + /bin shims + studio env)"
      : "FAIL — see logs above"),
);
process.exit(ok ? 0 : 1);