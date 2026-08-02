// Spike (NETWORK): is a PRE-BUILT dep-cache snapshot a viable way to make a heavy template's
// first run cheap?
//
// The question this answers. Four rounds of work went into making Starlight's first
// `npm install` survivable on a constrained machine, and the honest state is that it is
// fundamentally expensive: ~364 packages, ~12k files, ~111 MB in node_modules. The dep cache
// (packages/kernel-host/dep-cache.js) already stores the RESULT of an install and restores it
// in one pass, and `tryRestoreDeps()` in kernel-worker.ts already consults it BEFORE installing
// — that is why a second project from the same template skips install today. So the idea is to
// ship the snapshot with the template and never pay the install at all.
//
// Before building the shipping half (which needs a producer script, a hosted asset and a
// consumer hook in the kernel), the premise has to be measured, because it is not obviously
// true: restore ALSO materializes ~12k files into the VFS. If writing the tree is what costs,
// restore is not meaningfully cheaper than install and the whole idea is dead. That is exactly
// what this measures, on the real Rust/Wasm VFS through the shipped code path.
//
// What it does: installs Starlight the studio way (shared loader + /bin shim + baseProcEnv,
// same as spike-starlight-studio.mjs), snapshots it, wipes node_modules, restores it, and
// compares. It asserts the SPEEDUP, not a wall-clock budget — a ratio is stable across
// machines and CI, whereas absolute times are not.
//
// The numbers it reports are the inputs to the ship/don't-ship decision:
//   * install seconds vs restore seconds (is restore worth shipping for?)
//   * the archive size (what would have to be hosted, per template)
//   * the entry count restore writes (whether restore is still a 12k-file write)
//   * that the restored tree is actually usable (astro CLI present, no native sharp)
//
// Run (Node 22+):  node scripts/spike-starlight-depcache.mjs
//   Prereq: `npm run vendor:npm` (packs npm into packages/studio/public/vendor/npm-pack.bin).
//   env: VV_LIVE=1 (stream install output), VV_INSTALL_TIMEOUT, VV_MIN_SPEEDUP.

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { ensureRealNpm } from "../packages/kernel-host/load-real-npm.js";
import { hashDepKey } from "../packages/kernel-host/dep-cache.js";
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
// Restore has to be enough faster to justify hosting a ~111 MB asset per template. Anything
// under a few x is not worth the machinery; the measured figure is far above this floor.
const MIN_SPEEDUP = Number(process.env.VV_MIN_SPEEDUP || 3);

if (!fs.existsSync(ASSET)) {
  console.error(`No vendor asset at ${path.relative(ROOT, ASSET)} — run \`npm run vendor:npm\` first.`);
  process.exit(2);
}

// ── kernel setup (same shape as spike-starlight-studio.mjs) ──────────────────
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
  const transfer = [port1];
  if (info.threadPort) {
    init.threadPort = info.threadPort;
    transfer.push(info.threadPort);
  }
  w.postMessage(init, transfer);
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
const aliased = createAliasedFetcher();
const kernel = new Kernel({ fs: kernelFs.fs, spawnWorker, fetcher: aliased, stdout: cap, stderr: cap });
kernel.installCoreutils();
let fetchN = 0;
kernel.onFetch = () => fetchN++;

kernel.mkdirp("/tmp");
kernel.mkdirp("/home/user");
kernel.mkdirp("/home/user/.cache/npm/_logs");
const loaded = await ensureRealNpm(kernel, async () => new Uint8Array(fs.readFileSync(ASSET)));
const shimOk = /real npm shim/.test(kernel.readFile("/bin/npm.js") || "");
console.log(`ensureRealNpm: version=${loaded && loaded.version} files=${loaded && loaded.fileCount}, shim=${shimOk}`);

// The studio's process env, verbatim from baseProcEnv() in kernel-worker.ts.
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

// Only the files the install depends on. astro.config/content live in the studio spike; what
// decides the dependency tree (and therefore the snapshot) is package.json plus .npmrc.
const FILES = {
  "package.json": `{
  "name": "starlight-docs",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "astro dev --port ${PORT}",
    "build": "astro build",
    "preview": "astro preview --port ${PORT}"
  },
  "dependencies": {
    "astro": "^5.18.0",
    "@astrojs/starlight": "^0.37.7"
  }
}
`,
  ".npmrc": `legacy-peer-deps=true\n`,
};
for (const [rel, body] of Object.entries(FILES)) {
  const p = DIR + "/" + rel;
  kernel.mkdirp(p.slice(0, p.lastIndexOf("/")));
  kernel.writeFile(p, body);
}
console.log(`project written to ${DIR} (base ${BASE})`);

// ── step 1: a real install, the studio way ───────────────────────────────────
const INSTALL_TIMEOUT = Number(process.env.VV_INSTALL_TIMEOUT || 600000);
console.log(`\n== step 1: npm install (via /bin/npm.js, studio env) ==`);
const t1 = Date.now();
let installDone = false;
const beat = setInterval(() => {
  if (!installDone) console.log(`  … ${((Date.now() - t1) / 1000) | 0}s, ${fetchN} fetches`);
}, 15000);
// Interactive shell + VV_RUN, not `sh -c` — the path a user's Run button actually takes.
const pid = kernel.launch("sh", [], { cwd: DIR, env: { ...env, VV_RUN: "npm install" } });
if (pid < 0) {
  console.log("  FAIL: could not launch the shell");
  process.exit(1);
}
let installSeen = 0;
while (Date.now() - t1 < INSTALL_TIMEOUT) {
  await new Promise((r) => setTimeout(r, 500));
  if (/added \d+ packages/.test(out.join(""))) { installSeen = Date.now(); break; }
}
installDone = true;
clearInterval(beat);
const installMs = installSeen ? installSeen - t1 : 0;
console.log(`  install completed: ${!!installSeen}  (${(installMs / 1000).toFixed(1)}s, ${fetchN} fetches)`);
if (!installSeen) {
  console.log("  output tail:\n" + out.join("").slice(-2000));
  process.exit(1);
}

// ── step 2: snapshot it, and record what shipping it would cost ──────────────
// Keyed exactly the way kernel-worker.ts keys a pre-install lookup for a fresh project: the
// package.json hash. That is the whole reason a shipped snapshot could work — the key is
// derivable at BUILD time from bytes that are already in templates.ts, with no lockfile and
// no install needed to compute it.
console.log(`\n== step 2: snapshot ==`);
const pjBytes = kernel.readFileBytes(DIR + "/package.json");
const pjKey = await hashDepKey("npm", pjBytes, "package.json");
console.log(`  package.json key: ${pjKey.slice(0, 34)}…`);
const t2 = Date.now();
const saved = await kernelFs.fs.depCacheSave(pjKey, DIR, []);
const saveMs = Date.now() - t2;
console.log(`  saved: ${saved && saved.files} files, archive ${((saved.bytes / 1048576).toFixed(1))} MB (${saveMs}ms)`);
const hasIt = await kernelFs.fs.depCacheHas(pjKey);
console.log(`  depCacheHas(package.json key): ${hasIt}   <- what a fresh project would hit`);

// ── step 2b: what shipping it would actually cost on the wire ────────────────
// The archive is the thing that would have to be hosted, so measure it BOTH raw and gzipped:
// node_modules is mostly JS and JSON, so the compressed figure is the honest transfer cost and
// it is what decides whether shipping one per heavy template is reasonable.
// VV_WRITE_SNAPSHOT=<path> also writes it out — the producer half of a shipped snapshot.
const exportSnapshot = (key) =>
  new Promise((resolve, reject) => {
    const onMsg = (m) => {
      if (m.id !== "exp") return;
      fsWorker.off("message", onMsg);
      if (m.type === "dep-cache-export-ok") resolve(m.bytes);
      else if (m.type === "dep-cache-export-err") reject(new Error(m.error));
    };
    fsWorker.on("message", onMsg);
    fsWorker.postMessage({ type: "dep-cache-export", id: "exp", key });
  });
let gzipMB = 0;
try {
  const blob = await exportSnapshot(pjKey);
  const { gzipSync } = await import("node:zlib");
  const tg = Date.now();
  const gz = gzipSync(blob, { level: 6 });
  gzipMB = gz.length / 1048576;
  console.log(
    `  archive ${(blob.length / 1048576).toFixed(1)} MB raw -> ${gzipMB.toFixed(1)} MB gzipped` +
      ` (${(blob.length / gz.length).toFixed(1)}x, ${Date.now() - tg}ms)`,
  );
  if (process.env.VV_WRITE_SNAPSHOT) {
    fs.writeFileSync(process.env.VV_WRITE_SNAPSHOT, blob);
    console.log(`  wrote snapshot to ${process.env.VV_WRITE_SNAPSHOT}`);
  }
} catch (err) {
  console.log(`  archive export unavailable (${err.message}) — size figures from save() only`);
}

// ── step 3: wipe node_modules, then restore ──────────────────────────────────
// The comparison only means something if node_modules is genuinely gone, so count before and
// after rather than trusting the wipe.
console.log(`\n== step 3: wipe + restore ==`);
const rmrf = (p) => {
  let st;
  try { st = kernel.stat(p); } catch { return; }
  if (st.kind === "dir") {
    for (const n of kernel.readdir(p)) rmrf(p + "/" + n);
    kernel.rmdir(p);
  } else kernel.unlink(p);
};
rmrf(DIR + "/node_modules");
const goneOk = !kernel.exists(DIR + "/node_modules");
console.log(`  node_modules removed: ${goneOk}`);
const t3 = Date.now();
const restored = await kernelFs.fs.depCacheRestore(pjKey, DIR);
const restoreMs = Date.now() - t3;
console.log(`  restored: ${restored} entries (${(restoreMs / 1000).toFixed(1)}s)`);

// ── step 4: is the restored tree actually usable? ────────────────────────────
const astroCli = ["node_modules/astro/astro.js", "node_modules/astro/bin/astro.mjs"].find((p) =>
  kernel.exists(DIR + "/" + p),
);
const starlightPkg = kernel.exists(DIR + "/node_modules/@astrojs/starlight/package.json");
// Symlinked bins are the fragile part of any pack/restore, and `astro dev` is launched through
// one, so assert the .bin entry survived rather than just the package directories.
const binOk = kernel.exists(DIR + "/node_modules/.bin/astro");
const nativeSharp = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"].some((p) =>
  kernel.exists(DIR + "/node_modules/@img/sharp-" + p),
);
console.log(`  astro CLI present:          ${!!astroCli}`);
console.log(`  @astrojs/starlight present: ${starlightPkg}`);
console.log(`  node_modules/.bin/astro:    ${binOk}`);
console.log(`  a NATIVE @img/sharp-*:      ${nativeSharp}${nativeSharp ? "  (BAD)" : ""}`);

// ── verdict ──────────────────────────────────────────────────────────────────
const speedup = restoreMs > 0 ? installMs / restoreMs : 0;
const treeOk = !!astroCli && starlightPkg && binOk && !nativeSharp;
const fastEnough = speedup >= MIN_SPEEDUP;
console.log(`\n──── snapshot vs install ────`);
console.log(`  install: ${(installMs / 1000).toFixed(1)}s (${fetchN} network fetches)`);
console.log(`  restore: ${(restoreMs / 1000).toFixed(1)}s (0 network fetches, ${restored} entries)`);
console.log(`  speedup: ${speedup.toFixed(1)}x   (floor ${MIN_SPEEDUP}x)`);
console.log(`  asset to host per template: ${(saved.bytes / 1048576).toFixed(1)} MB raw` +
  (gzipMB ? `, ${gzipMB.toFixed(1)} MB gzipped` : ""));
const ok = installSeen && hasIt && goneOk && restored > 0 && treeOk && fastEnough;
console.log(`\n${ok ? "PASS" : "FAIL"}  restore is ${fastEnough ? "" : "NOT "}a viable substitute for the install`);
process.exit(ok ? 0 : 1);