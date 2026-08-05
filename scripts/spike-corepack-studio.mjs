// Studio-wiring spike (Phase 6 — wire REAL corepack into the interactive shell).
//
// spike-corepack.mjs proved real corepack boots + downloads+runs a project-pinned
// PM when loaded off the host disk. This proves the BROWSER path studio ships:
//
//   1) the vendor asset (packages/studio/public/vendor/corepack-pack.bin, built by
//      `npm run vendor:corepack`) decodes + unpacks into the VFS via the SHARED
//      loader packages/kernel-host/load-real-corepack.js (same code studio's
//      kernel worker calls), and
//   2) typing `corepack` on PATH resolves to the real CLI via the /bin/corepack.js
//      shim.
//
// Crucially it uses the SAME env studio sets (COREPACK_HOME +
// COREPACK_INTEGRITY_KEYS=0 + COREPACK_ENABLE_DOWNLOAD_PROMPT=0), NOT CLI flags —
// so it verifies the studio config. Offline by default; set VV_NET=1 for the
// download+run gate.
//
// Prereq: run `npm run vendor:corepack` first.

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { ensureRealCorepack, COREPACK_VFS_ROOT } from "../packages/kernel-host/load-real-corepack.js";
import { initTransferList } from "../packages/kernel-host/worker-transfer.js";
import { Worker, MessageChannel } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const ASSET = path.join(ROOT, "packages", "studio", "public", "vendor", "corepack-pack.bin");
const COREPACK_VERSION = "0.35.0";
const PM = process.env.VV_PM || "yarn@1.22.22";
const PM_BIN = PM.split("@")[0];
const PM_EXPECT = PM.split("@")[1];

if (!fs.existsSync(ASSET)) {
  console.error(`No vendor asset at ${path.relative(ROOT, ASSET)} — run \`npm run vendor:corepack\` first.`);
  process.exit(2);
}

// ── kernel setup (same shape as spike-pnpm-studio.mjs) ───────────────────────
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
kernel.mkdirp("/tmp/.corepack");
kernel.mkdirp("/app");
const t0 = Date.now();
const loaded = await ensureRealCorepack(kernel, async () => new Uint8Array(fs.readFileSync(ASSET)));
console.log(`ensureRealCorepack: version=${loaded && loaded.version} files=${loaded && loaded.fileCount} (${Date.now() - t0}ms)`);

// Gate A: /bin/corepack.js is now the real-corepack shim.
const shim = kernel.readFile("/bin/corepack.js") || "";
const shimOk = /real corepack shim/.test(shim) && shim.includes(COREPACK_VFS_ROOT + "/dist/corepack.js");
console.log(`shim gate: ${shimOk ? "PASS" : "FAIL"}  (/bin/corepack.js -> real dist/corepack.js)`);

// Mirror studio's openTerminal env (config via COREPACK_* env, NOT CLI flags).
const env = {
  HOME: "/home/user",
  PATH: "/bin",
  COREPACK_HOME: "/tmp/.corepack",
  COREPACK_INTEGRITY_KEYS: "0",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  XDG_DATA_HOME: "/home/user/.local/share",
  XDG_CACHE_HOME: "/home/user/.cache",
  XDG_CONFIG_HOME: "/home/user/.config",
};

// Gate B: `corepack --version` resolved via PATH -> /bin/corepack.js == 0.35.0.
const v = await kernel.start("corepack", ["--version"], { cwd: "/app", env, capture: true });
const versionOk = v.code === 0 && new RegExp(`^\\s*${COREPACK_VERSION.replace(/\./g, "\\.")}\\s*$`).test(v.stdout || "");
console.log(`version gate: ${versionOk ? "PASS" : "FAIL"}  corepack --version -> ${JSON.stringify((v.stdout || "").trim())}`);
if (!versionOk && v.stderr) console.log("stderr:\n" + v.stderr.trim());

// Gate C (opt-in, network): corepack DOWNLOADS + runs a project-pinned PM using
// ONLY the env config (integrity escape hatch + home) — no CLI flags.
let manageOk = true;
if (process.env.VV_NET === "1") {
  console.log(`\n── corepack ${PM_BIN} --version with packageManager="${PM}" (via /bin/corepack.js shim, env config only) ──`);
  kernel.writeFile("/app/package.json", JSON.stringify({ name: "app", version: "1.0.0", private: true, packageManager: PM }, null, 2));
  const TIMEOUT_MS = Number(process.env.VV_TIMEOUT || 180000);
  const t1 = Date.now();
  const run = await Promise.race([
    kernel.start("corepack", [PM_BIN, "--version"], { cwd: "/app", env, capture: true }),
    new Promise((r) => setTimeout(() => r({ code: 124, stdout: "", stderr: "TIMEOUT" }), TIMEOUT_MS)),
  ]);
  const printedVersion = new RegExp(`(^|\\n)\\s*${PM_EXPECT.replace(/\./g, "\\.")}\\s*(\\n|$)`).test(run.stdout || "");
  const cached = kernel.exists(`/tmp/.corepack/v1/${PM_BIN}`);
  console.log(`run exit=${run.code} (${Date.now() - t1}ms)  printed ${PM_EXPECT}: ${printedVersion}  cached in COREPACK_HOME: ${cached}`);
  if (run.stdout && run.stdout.trim()) console.log("stdout:\n" + run.stdout.trim());
  if (!printedVersion && run.stderr) console.log("stderr:\n" + run.stderr.trim());
  manageOk = run.code === 0 && printedVersion;
  console.log(`manage gate: ${manageOk ? "PASS" : "FAIL"}`);
} else {
  console.log("\n(manage gate skipped — set VV_NET=1 to run it)");
}

const ok = shimOk && versionOk && manageOk;
console.log(`\nRESULT: ${ok ? "PASS — studio ships real corepack (shim + shared loader + env config)" : "FAIL — see logs above"}`);
process.exit(ok ? 0 : 1);
