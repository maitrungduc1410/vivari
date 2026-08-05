// Studio-wiring spike (Phase 5 — wire REAL pnpm into the interactive shell).
//
// spike-pnpm.mjs proved real pnpm boots + installs when loaded off the host disk.
// This proves the BROWSER path studio actually ships:
//
//   1) the vendor asset (packages/studio/public/vendor/pnpm-pack.bin, built by
//      `npm run vendor:pnpm`) decodes + unpacks into the VFS via the SHARED loader
//      packages/kernel-host/load-real-pnpm.js (same code studio's kernel worker
//      calls), and
//   2) typing `pnpm` on PATH resolves to the real CLI through the /bin/pnpm.js shim.
//
// Crucially it uses the SAME env studio sets (copy import-method + store-dir via
// npm_config_*), NOT CLI flags — so it verifies the studio config, not a bespoke
// invocation. Offline by default; set VV_NET=1 for the install gate.
//
// Prereq: run `npm run vendor:pnpm` first.

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { ensureRealPnpm, PNPM_VFS_ROOT } from "../packages/kernel-host/load-real-pnpm.js";
import { initTransferList } from "../packages/kernel-host/worker-transfer.js";
import { Worker, MessageChannel } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const ASSET = path.join(ROOT, "packages", "studio", "public", "vendor", "pnpm-pack.bin");

if (!fs.existsSync(ASSET)) {
  console.error(`No vendor asset at ${path.relative(ROOT, ASSET)} — run \`npm run vendor:pnpm\` first.`);
  process.exit(2);
}

// ── kernel setup (same shape as spike-pnpm.mjs) ──────────────────────────────
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
const fetcher = async (url, init) => {
  const r = await fetch(url, { redirect: "follow", ...(init || {}) });
  const body = new Uint8Array(await r.arrayBuffer());
  const headers = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  return { ok: r.ok, status: r.status, statusText: r.statusText, headers, body };
};

const kernel = new Kernel({ fs: kernelFs.fs, spawnWorker, fetcher });
kernel.installCoreutils();

// ── the wiring under test: the SHARED loader, fed the vendor asset ───────────
kernel.mkdirp("/home/user");
kernel.mkdirp("/tmp/.pnpm-store");
kernel.mkdirp("/app");
const t0 = Date.now();
const loaded = await ensureRealPnpm(kernel, async () => new Uint8Array(fs.readFileSync(ASSET)));
console.log(`ensureRealPnpm: version=${loaded && loaded.version} files=${loaded && loaded.fileCount} (${Date.now() - t0}ms)`);

// Gate A: /bin/pnpm.js is now the real-pnpm shim.
const shim = kernel.readFile("/bin/pnpm.js") || "";
const shimOk = /real pnpm shim/.test(shim) && shim.includes(PNPM_VFS_ROOT + "/bin/pnpm.cjs");
console.log(`shim gate: ${shimOk ? "PASS" : "FAIL"}  (/bin/pnpm.js -> real bin/pnpm.cjs)`);

// Mirror studio's openTerminal env (config via npm_config_*, NOT CLI flags).
const env = {
  HOME: "/home/user",
  PATH: "/bin",
  npm_config_package_import_method: "copy",
  npm_config_store_dir: "/tmp/.pnpm-store",
  XDG_DATA_HOME: "/home/user/.local/share",
  XDG_CACHE_HOME: "/home/user/.cache",
  XDG_STATE_HOME: "/home/user/.local/state",
  XDG_CONFIG_HOME: "/home/user/.config",
};

// Gate B: `pnpm --version` resolved via PATH -> /bin/pnpm.js -> real pnpm == 9.15.9.
const v = await kernel.start("pnpm", ["--version"], { cwd: "/app", env, capture: true });
const versionOk = v.code === 0 && /^\s*9\.15\.9\s*$/.test(v.stdout || "");
console.log(`version gate: ${versionOk ? "PASS" : "FAIL"}  pnpm --version -> ${JSON.stringify((v.stdout || "").trim())}`);
if (!versionOk && v.stderr) console.log("stderr:\n" + v.stderr.trim());

// Gate C (opt-in, network): a real install through the shim on PATH, using ONLY
// the env config (copy import-method + store-dir) — no CLI flags.
let installOk = true;
if (process.env.VV_NET === "1") {
  const PKG = process.env.VV_PKG || "is-number";
  console.log(`\n── pnpm add ${PKG} (via /bin/pnpm.js shim, env config only) ──`);
  kernel.writeFile("/app/package.json", JSON.stringify({ name: "app", version: "1.0.0", license: "MIT", private: true }, null, 2));
  const TIMEOUT_MS = Number(process.env.VV_TIMEOUT || 180000);
  const t1 = Date.now();
  const inst = await Promise.race([
    kernel.start("pnpm", ["add", PKG], { cwd: "/app", env, capture: true }),
    new Promise((r) => setTimeout(() => r({ code: 124, stdout: "", stderr: "TIMEOUT" }), TIMEOUT_MS)),
  ]);
  const linked = kernel.exists(`/app/node_modules/${PKG}/package.json`);
  const virtualStore = kernel.exists("/app/node_modules/.pnpm");
  const lockfile = kernel.exists("/app/pnpm-lock.yaml");
  console.log(`install exit=${inst.code} (${Date.now() - t1}ms)  node_modules/${PKG}: ${linked}  .pnpm: ${virtualStore}  lock: ${lockfile}`);
  if (inst.stdout && inst.stdout.trim()) console.log("stdout:\n" + inst.stdout.trim());
  if (!linked && inst.stderr) console.log("stderr:\n" + inst.stderr.trim());

  let requireOk = false;
  if (linked) {
    kernel.writeFile("/app/use.js", `const p = require(${JSON.stringify(PKG)}); console.log('REQUIRE_OK ' + typeof p);`);
    const use = await kernel.start("node", ["/app/use.js"], { cwd: "/app", env, capture: true });
    requireOk = use.code === 0 && /REQUIRE_OK/.test(use.stdout || "");
    console.log("require installed pkg (via symlink): " + (requireOk ? "PASS " + use.stdout.trim() : "FAIL\n" + (use.stderr || use.stdout)));
  }
  installOk = inst.code === 0 && linked && virtualStore && requireOk;
  console.log(`install gate: ${installOk ? "PASS" : "FAIL"}`);
} else {
  console.log("\n(install gate skipped — set VV_NET=1 to run it)");
}

const ok = shimOk && versionOk && installOk;
console.log(`\nRESULT: ${ok ? "PASS — studio ships real pnpm (shim + shared loader + env config)" : "FAIL — see logs above"}`);
process.exit(ok ? 0 : 1);
