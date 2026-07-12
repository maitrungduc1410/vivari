// Studio-wiring spike (Phase 3 — wire REAL npm into the interactive shell).
//
// spike-npm.mjs proved real npm boots when loaded off the host disk and invoked
// via a require() wrapper. This proves the BROWSER path studio actually ships:
//
//   1) the vendor asset (packages/studio/public/vendor/npm-pack.gz, built by
//      `npm run vendor:npm`) decodes + unpacks into the VFS via the SHARED
//      loader packages/kernel-host/load-real-npm.js (same code studio's kernel
//      worker calls), and
//   2) typing `npm`/`npx` on PATH resolves to the real CLI through the /bin
//      shims (NOT the Turbo-analog) — the analog would print a usage line for
//      `npm --version`, real npm prints 10.9.2.
//
// Offline by default (version + shim gates). Set OC_NET=1 for the install gate
// (hits registry.npmjs.org). Run: node scripts/spike-npm-studio.mjs
//
// Prereq: the vendor asset must exist — run `npm run vendor:npm` first.

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { ensureRealNpm, NPM_VFS_ROOT } from "../packages/kernel-host/load-real-npm.js";
import { Worker, MessageChannel } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const ASSET = path.join(ROOT, "packages", "studio", "public", "vendor", "npm-pack.gz");

if (!fs.existsSync(ASSET)) {
  console.error(`No vendor asset at ${path.relative(ROOT, ASSET)} — run \`npm run vendor:npm\` first.`);
  process.exit(2);
}

// ── kernel setup (same shape as spike-npm.mjs) ───────────────────────────────
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
kernel.installCoreutils(); // writes the Turbo-analog to /bin/npm.js …

// ── the wiring under test: the SHARED loader, fed the vendor asset ───────────
// This is exactly what packages/demo/kernel-worker.js does at boot (there the
// bytes come from fetch('/vendor/npm-pack.gz'); here from disk).
kernel.mkdirp("/home/user");
kernel.mkdirp("/tmp/.npm/_logs");
kernel.mkdirp("/app");
const t0 = Date.now();
const loaded = await ensureRealNpm(kernel, async () => new Uint8Array(fs.readFileSync(ASSET)));
console.log(`ensureRealNpm: version=${loaded && loaded.version} files=${loaded && loaded.fileCount} (${Date.now() - t0}ms)`);

// Gate A: /bin/npm.js is now the real-npm shim, not the Turbo-analog.
const shim = kernel.readFile("/bin/npm.js") || "";
const shimOk = /real npm shim/.test(shim) && shim.includes(NPM_VFS_ROOT + "/bin/npm-cli.js");
console.log(`shim gate: ${shimOk ? "PASS" : "FAIL"}  (/bin/npm.js -> real npm-cli.js)`);

const env = { HOME: "/home/user", PATH: "/bin", npm_config_cache: "/tmp/.npm" };

// Gate B: `npm --version` resolved via PATH -> /bin/npm.js -> real npm == 10.9.2.
// (The analog prints a usage line here, so this proves the real CLI is running.)
const v = await kernel.start("npm", ["--version"], { cwd: "/app", env, capture: true });
const versionOk = v.code === 0 && /^\s*10\.9\.2\s*$/.test(v.stdout || "");
console.log(`version gate: ${versionOk ? "PASS" : "FAIL"}  npm --version -> ${JSON.stringify((v.stdout || "").trim())}`);
if (!versionOk && v.stderr) console.log("stderr:\n" + v.stderr.trim());

// Gate C: `npx --version` resolves via the /bin/npx.js shim too.
const nx = await kernel.start("npx", ["--version"], { cwd: "/app", env, capture: true });
const npxOk = nx.code === 0 && /^\s*10\.9\.2\s*$/.test(nx.stdout || "");
console.log(`npx gate: ${npxOk ? "PASS" : "FAIL"}  npx --version -> ${JSON.stringify((nx.stdout || "").trim())}`);

// Gate D (opt-in, network): a real install through the shim on PATH.
let installOk = true;
if (process.env.OC_NET === "1") {
  const PKG = process.env.OC_PKG || "is-number";
  console.log(`\n── npm install ${PKG} (via /bin/npm.js shim, real registry) ──`);
  kernel.writeFile("/app/package.json", JSON.stringify({ name: "app", version: "1.0.0" }, null, 2));
  const TIMEOUT_MS = Number(process.env.OC_TIMEOUT || 90000);
  const t1 = Date.now();
  const inst = await Promise.race([
    kernel.start("npm", ["install", PKG, "--no-audit", "--no-fund"], { cwd: "/app", env, capture: true }),
    new Promise((r) => setTimeout(() => r({ code: 124, stdout: "", stderr: "TIMEOUT" }), TIMEOUT_MS)),
  ]);
  const installed = kernel.exists(`/app/node_modules/${PKG}/package.json`);
  console.log(`install exit=${inst.code} (${Date.now() - t1}ms)  node_modules/${PKG}: ${installed}`);
  if (inst.stdout && inst.stdout.trim()) console.log("stdout:\n" + inst.stdout.trim());
  if (!installed && inst.stderr) console.log("stderr:\n" + inst.stderr.trim());
  installOk = inst.code === 0 && installed;
  console.log(`install gate: ${installOk ? "PASS" : "FAIL"}`);
} else {
  console.log("\n(install gate skipped — set OC_NET=1 to run it)");
}

const ok = shimOk && versionOk && npxOk && installOk;
console.log(`\nRESULT: ${ok ? "PASS — studio ships real npm (shim + shared loader)" : "FAIL — see logs above"}`);
process.exit(ok ? 0 : 1);
