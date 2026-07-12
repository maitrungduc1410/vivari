// Studio-wiring spike (Phase 4 — wire REAL yarn classic into the interactive shell).
//
// spike-yarn.mjs proved real yarn boots when loaded off the host disk. This proves
// the BROWSER path studio actually ships:
//
//   1) the vendor asset (packages/studio/public/vendor/yarn-pack.bin, built by
//      `npm run vendor:yarn`) decodes + unpacks into the VFS via the SHARED loader
//      packages/kernel-host/load-real-yarn.js (same code studio's kernel worker
//      calls), and
//   2) typing `yarn` on PATH resolves to the real CLI through the /bin/yarn.js
//      shim.
//
// Offline by default (version + shim gates). Set OC_NET=1 for the install gate
// (hits registry.yarnpkg.com). Run: node scripts/spike-yarn-studio.mjs
//
// Prereq: the vendor asset must exist — run `npm run vendor:yarn` first.

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { ensureRealYarn, YARN_VFS_ROOT } from "../packages/kernel-host/load-real-yarn.js";
import { Worker, MessageChannel } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const ASSET = path.join(ROOT, "packages", "studio", "public", "vendor", "yarn-pack.bin");

if (!fs.existsSync(ASSET)) {
  console.error(`No vendor asset at ${path.relative(ROOT, ASSET)} — run \`npm run vendor:yarn\` first.`);
  process.exit(2);
}

// ── kernel setup (same shape as spike-yarn.mjs) ──────────────────────────────
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
// This is exactly what packages/demo/kernel-worker.js does at boot (there the
// bytes come from fetch('/vendor/yarn-pack.bin'); here from disk). Large files
// (cli.js) go through kernel.fs.writeLarge, so the pump must be alive: it is,
// via onKernelFsMessage above.
kernel.mkdirp("/home/user");
kernel.mkdirp("/tmp/.yarn-cache");
kernel.mkdirp("/app");
const t0 = Date.now();
const loaded = await ensureRealYarn(kernel, async () => new Uint8Array(fs.readFileSync(ASSET)));
console.log(`ensureRealYarn: version=${loaded && loaded.version} files=${loaded && loaded.fileCount} (${Date.now() - t0}ms)`);

// Gate A: /bin/yarn.js is now the real-yarn shim.
const shim = kernel.readFile("/bin/yarn.js") || "";
const shimOk = /real yarn shim/.test(shim) && shim.includes(YARN_VFS_ROOT + "/bin/yarn.js");
console.log(`shim gate: ${shimOk ? "PASS" : "FAIL"}  (/bin/yarn.js -> real bin/yarn.js)`);

const env = { HOME: "/home/user", PATH: "/bin", YARN_CACHE_FOLDER: "/tmp/.yarn-cache" };
const YARN_FLAGS = ["--non-interactive", "--no-progress"];

// Gate B: `yarn --version` resolved via PATH -> /bin/yarn.js -> real yarn == 1.22.22.
const v = await kernel.start("yarn", ["--version", ...YARN_FLAGS], { cwd: "/app", env, capture: true });
const versionOk = v.code === 0 && /^\s*1\.22\.22\s*$/.test(v.stdout || "");
console.log(`version gate: ${versionOk ? "PASS" : "FAIL"}  yarn --version -> ${JSON.stringify((v.stdout || "").trim())}`);
if (!versionOk && v.stderr) console.log("stderr:\n" + v.stderr.trim());

// Gate C (opt-in, network): a real install through the shim on PATH.
let installOk = true;
if (process.env.OC_NET === "1") {
  const PKG = process.env.OC_PKG || "is-number";
  console.log(`\n── yarn add ${PKG} (via /bin/yarn.js shim, real registry) ──`);
  kernel.writeFile("/app/package.json", JSON.stringify({ name: "app", version: "1.0.0", license: "MIT", private: true }, null, 2));
  const TIMEOUT_MS = Number(process.env.OC_TIMEOUT || 120000);
  const t1 = Date.now();
  const inst = await Promise.race([
    kernel.start("yarn", ["add", PKG, ...YARN_FLAGS], { cwd: "/app", env, capture: true }),
    new Promise((r) => setTimeout(() => r({ code: 124, stdout: "", stderr: "TIMEOUT" }), TIMEOUT_MS)),
  ]);
  const installed = kernel.exists(`/app/node_modules/${PKG}/package.json`);
  const lockfile = kernel.exists("/app/yarn.lock");
  console.log(`install exit=${inst.code} (${Date.now() - t1}ms)  node_modules/${PKG}: ${installed}  yarn.lock: ${lockfile}`);
  if (inst.stdout && inst.stdout.trim()) console.log("stdout:\n" + inst.stdout.trim());
  if (!installed && inst.stderr) console.log("stderr:\n" + inst.stderr.trim());
  installOk = inst.code === 0 && installed && lockfile;
  console.log(`install gate: ${installOk ? "PASS" : "FAIL"}`);
} else {
  console.log("\n(install gate skipped — set OC_NET=1 to run it)");
}

const ok = shimOk && versionOk && installOk;
console.log(`\nRESULT: ${ok ? "PASS — studio ships real yarn (shim + shared loader)" : "FAIL — see logs above"}`);
process.exit(ok ? 0 : 1);
