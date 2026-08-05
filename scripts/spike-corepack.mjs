// Phase 6 spike (North Star: run the REAL npm/yarn/pnpm CLIs on Path B).
//
// npm/yarn/pnpm are proven + wired with HARD-VENDORED pins. corepack is Node's
// official shim that reads a project's `packageManager` field, DOWNLOADS that exact
// version from the registry (gunzip + untar + sha512 integrity), and execs it —
// so a project can pin any yarn/pnpm version, not just our vendored one. This
// de-risks that download→extract→verify→exec path. Throwaway harness modelled on
// scripts/spike-pnpm.mjs.
//
// corepack is tiny (dist/corepack.js -> dist/lib/corepack.cjs, ~54 files, <1 MB).
// The catch: corepack normally verifies the registry's ECDSA signature, which our
// crypto layer can't do — so we set the OFFICIAL escape hatch
// COREPACK_INTEGRITY_KEYS=0 (skips the signature check; the sha512 tarball
// integrity check, which uses createHash, still runs).
//
//   1) vendor:  rm -rf /tmp/vv-vendor-corepack && mkdir -p /tmp/vv-vendor-corepack \
//        && (cd /tmp/vv-vendor-corepack && npm install corepack@latest --no-save --no-audit --no-fund)
//   2) run:  node scripts/spike-corepack.mjs [path-to-vendored-corepack]
//            VV_LIVE=1 streams output; VV_NONET=1 skips the download gate;
//            VV_PM=yarn@1.22.22 (default) picks which PM corepack should fetch.

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { initTransferList } from "../packages/kernel-host/worker-transfer.js";
import { Worker, MessageChannel } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";

const VENDOR_COREPACK = process.argv[2] || "/tmp/vv-vendor-corepack/node_modules/corepack";
const VFS_COREPACK = "/usr/lib/node_modules/corepack";
const COREPACK_VERSION = "0.35.0";
const LARGE_THRESHOLD = 512 * 1024;
const PM = process.env.VV_PM || "yarn@1.22.22";
const PM_EXPECT = PM.split("@")[1];
const PM_BIN = PM.split("@")[0];

if (!fs.existsSync(path.join(VENDOR_COREPACK, "dist/corepack.js"))) {
  console.error(`No vendored corepack at ${VENDOR_COREPACK} (expected dist/corepack.js).`);
  console.error(`Vendor it first:  rm -rf /tmp/vv-vendor-corepack && mkdir -p /tmp/vv-vendor-corepack && (cd /tmp/vv-vendor-corepack && npm install corepack@latest --no-save --no-audit --no-fund)`);
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

const LIVE = process.env.VV_LIVE === "1";
const kernel = new Kernel({
  fs: kernelFs.fs,
  spawnWorker,
  fetcher,
  stdout: LIVE ? (s) => process.stderr.write(s) : undefined,
  stderr: LIVE ? (s) => process.stderr.write(s) : undefined,
});
kernel.installCoreutils();
let fetchN = 0;
kernel.onFetch = (url, info) => {
  fetchN++;
  process.stderr.write(`  [net ${fetchN}] ${info.cached ? "cache" : "GET"} ${((info.size / 1024) | 0)}k  ${url}\n`);
};

// ── load the vendored corepack tree into the VFS ─────────────────────────────
let fileCount = 0;
async function loadDir(hostDir, vfsDir) {
  kernel.mkdirp(vfsDir);
  for (const entry of fs.readdirSync(hostDir, { withFileTypes: true })) {
    const hostPath = path.join(hostDir, entry.name);
    const vfsPath = vfsDir + "/" + entry.name;
    if (entry.isDirectory()) {
      await loadDir(hostPath, vfsPath);
    } else if (entry.isFile()) {
      const bytes = fs.readFileSync(hostPath);
      if (bytes.length >= LARGE_THRESHOLD) await kernelFs.fs.writeLarge(vfsPath, bytes);
      else kernel.writeFile(vfsPath, bytes);
      fileCount++;
    }
  }
}
const t0 = Date.now();
await loadDir(VENDOR_COREPACK, VFS_COREPACK);
console.log(`Loaded real corepack into VFS: ${fileCount} files at ${VFS_COREPACK} (${Date.now() - t0}ms)\n`);

kernel.mkdirp("/home/user");
kernel.mkdirp("/tmp/.corepack");
kernel.mkdirp("/app");

kernel.writeFile(
  "/run-corepack.js",
  `
const fs = require('fs');
const LOG = '/corepacklog.txt';
try { fs.writeFileSync(LOG, ''); } catch (e) {}
const LIVE = process.env.VV_LIVE === '1';
const append = (s) => { try { fs.appendFileSync(LOG, s + '\\n'); } catch (e) {} if (LIVE) { try { process.stderr.write('[corepack] ' + s + '\\n'); } catch (e) {} } };
process.on('uncaughtException', (e) => append('UNCAUGHT ' + ((e && e.stack) || e)));
process.on('unhandledRejection', (e) => append('UNHANDLED ' + ((e && e.stack) || e)));
process.on('exit', (code) => append('EXIT ' + code));
try {
  require(${JSON.stringify(VFS_COREPACK + "/dist/corepack.js")});
} catch (e) {
  append('THROW ' + ((e && e.stack) || e));
}
`,
);

const env = {
  HOME: "/home/user",
  PATH: "/bin",
  VV_LIVE: LIVE ? "1" : "",
  COREPACK_HOME: "/tmp/.corepack",
  // We can't do the registry ECDSA signature check (no crypto.verify), so use the
  // official escape hatch. sha512 tarball integrity (createHash) still runs.
  COREPACK_INTEGRITY_KEYS: "0",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  XDG_DATA_HOME: "/home/user/.local/share",
  XDG_CACHE_HOME: "/home/user/.cache",
  XDG_CONFIG_HOME: "/home/user/.config",
};

function dumpLog(tailN) {
  try {
    const txt = kernel.readFile("/corepacklog.txt") || "";
    if (!txt.trim()) return;
    const shown = tailN ? txt.split("\n").slice(-tailN).join("\n") : txt;
    console.log("── corepack wrapper tap (/corepacklog.txt) ──\n" + shown);
  } catch {}
}

// ── Gate A: corepack --version (real corepack.cjs on Path B, no network) ──────
console.log("── Gate A: corepack --version ──");
const t1 = Date.now();
const v = await kernel.start("node", ["/run-corepack.js", "--version"], { cwd: "/app", env, capture: true });
dumpLog();
console.log(`exit=${v.code}  (${Date.now() - t1}ms)`);
console.log("stdout:", JSON.stringify((v.stdout || "").trim()));
if (v.stderr && v.stderr.trim()) console.log("stderr:\n" + v.stderr.trim());
const versionOk = v.code === 0 && new RegExp(`^\\s*${COREPACK_VERSION.replace(/\./g, "\\.")}\\s*$`).test(v.stdout || "");
console.log("Gate A (boots): " + (versionOk ? "PASS" : "FAIL") + "\n");

// ── Gate B: https egress self-test ───────────────────────────────────────────
console.log("── Gate B: https.get self-test (registry.npmjs.org) ──");
kernel.writeFile(
  "/https-test.js",
  `
const https = require('https');
const req = https.get('https://registry.npmjs.org/${PM_BIN}', (res) => {
  let n = 0;
  res.on('data', (c) => { n += c.length; });
  res.on('end', () => { console.log('SELFTEST status=' + res.statusCode + ' bytes=' + n); process.exit(res.statusCode === 200 ? 0 : 1); });
  res.on('error', (e) => { console.log('SELFTEST res-error ' + e.message); process.exit(1); });
});
req.on('error', (e) => { console.log('SELFTEST req-error ' + e.message); process.exit(1); });
setTimeout(() => { console.log('SELFTEST TIMEOUT'); process.exit(2); }, 20000);
`,
);
const st = await Promise.race([
  kernel.start("node", ["/https-test.js"], { cwd: "/app", env, capture: true }),
  new Promise((r) => setTimeout(() => r({ code: 124, stdout: "", stderr: "outer timeout" }), 25000)),
]);
console.log("selftest exit=" + st.code + " stdout=" + JSON.stringify((st.stdout || "").trim()));
if (st.stderr && st.stderr.trim()) console.log("selftest stderr:\n" + st.stderr.trim());
const httpsOk = st.code === 0 && /SELFTEST status=200/.test(st.stdout || "");
console.log("Gate B (https): " + (httpsOk ? "PASS" : "FAIL") + "\n");

// ── Gate C: corepack DOWNLOADS + runs a project-pinned PM version ─────────────
let manageOk = true;
if (process.env.VV_NONET !== "1") {
  console.log(`── Gate C: corepack ${PM_BIN} --version with packageManager="${PM}" (download + exec) ──`);
  kernel.writeFile(
    "/app/package.json",
    JSON.stringify({ name: "app", version: "1.0.0", private: true, packageManager: PM }, null, 2),
  );
  const TIMEOUT_MS = Number(process.env.VV_TIMEOUT || 180000);
  const t2 = Date.now();
  let timedOut = false;
  const run = await Promise.race([
    kernel.start("node", ["/run-corepack.js", PM_BIN, "--version"], { cwd: "/app", env, capture: !LIVE }),
    new Promise((r) => setTimeout(() => { timedOut = true; r({ code: 124, stdout: "", stderr: "TIMEOUT" }); }, TIMEOUT_MS)),
  ]);
  console.log(`exit=${run.code}${timedOut ? " (TIMED OUT)" : ""}  (${Date.now() - t2}ms)`);
  if (run.stdout && run.stdout.trim()) console.log("stdout:\n" + run.stdout.trim());
  if (run.stderr && run.stderr.trim()) console.log("stderr:\n" + run.stderr.trim());
  dumpLog(80);

  const printedVersion = new RegExp(`(^|\\n)\\s*${PM_EXPECT.replace(/\./g, "\\.")}\\s*(\\n|$)`).test(run.stdout || "");
  manageOk = run.code === 0 && printedVersion;
  console.log(`\ncorepack ran ${PM} and it printed ${PM_EXPECT}: ${printedVersion}`);
  console.log("Gate C (manages PM): " + (manageOk ? "PASS" : "FAIL") + "\n");
} else {
  console.log("── Gate C skipped (VV_NONET=1) ──\n");
}

const ok = versionOk && httpsOk && manageOk;
console.log("RESULT: " + (ok ? "PASS — real corepack boots and downloads+runs a project-pinned PM on Path B" : "FAIL — see logs above"));
process.exit(ok ? 0 : 1);
