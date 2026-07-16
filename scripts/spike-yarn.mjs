// Phase 4 spike (North Star: run the REAL npm/yarn/pnpm CLIs on Path B).
//
// npm is proven (Phase 0-3). This is the yarn CLASSIC (1.22.x) de-risk: load the
// vendored, unmodified `yarn` package into the VFS and run its real CLI headless
// — a go/no-go gate before we invest in studio delivery/wiring. Throwaway harness
// modelled on scripts/spike-npm.mjs.
//
// Yarn classic ships as just two real files: bin/yarn.js (entry) + lib/cli.js
// (~5 MB webpack bundle) + lib/v8-compile-cache.js. Requiring bin/yarn.js runs
// the CLI (it calls cli.default() when not auto-run).
//
//   1) vendor:  rm -rf /tmp/vv-vendor-yarn && mkdir -p /tmp/vv-vendor-yarn \
//        && (cd /tmp/vv-vendor-yarn && npm install yarn@1.22.22 --no-save --no-audit --no-fund)
//   2) run:  node scripts/spike-yarn.mjs [path-to-vendored-yarn]
//            VV_LIVE=1 streams yarn's stdout/stderr; VV_NONET=1 skips the install gate.

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { Worker, MessageChannel } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";

const VENDOR_YARN = process.argv[2] || "/tmp/vv-vendor-yarn/node_modules/yarn";
const VFS_YARN = "/usr/lib/node_modules/yarn";
const YARN_VERSION = "1.22.22";

if (!fs.existsSync(path.join(VENDOR_YARN, "bin/yarn.js"))) {
  console.error(`No vendored yarn at ${VENDOR_YARN} (expected bin/yarn.js).`);
  console.error(`Vendor it first:  rm -rf /tmp/vv-vendor-yarn && mkdir -p /tmp/vv-vendor-yarn && (cd /tmp/vv-vendor-yarn && npm install yarn@${YARN_VERSION} --no-save --no-audit --no-fund)`);
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

// ── load the vendored yarn tree into the VFS ─────────────────────────────────
// yarn's lib/cli.js is a single ~5 MB webpack bundle — too big for the 1 MiB SAB
// window that kernel.writeFile uses, so large files go through the transferred
// writeLarge path (the same one npm tarballs use).
const LARGE_THRESHOLD = 512 * 1024;
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
await loadDir(VENDOR_YARN, VFS_YARN);
console.log(`Loaded real yarn into VFS: ${fileCount} files at ${VFS_YARN} (${Date.now() - t0}ms)\n`);

kernel.mkdirp("/home/user");
kernel.mkdirp("/tmp/.yarn-cache");
kernel.mkdirp("/app");

// Wrapper: require yarn's real entry, tapping uncaught throws so a boot failure
// is visible even if yarn's own display path doesn't reach captured stdout.
kernel.writeFile(
  "/run-yarn.js",
  `
const fs = require('fs');
const LOG = '/yarnlog.txt';
try { fs.writeFileSync(LOG, ''); } catch (e) {}
const LIVE = process.env.VV_LIVE === '1';
const append = (s) => { try { fs.appendFileSync(LOG, s + '\\n'); } catch (e) {} if (LIVE) { try { process.stderr.write('[yarn] ' + s + '\\n'); } catch (e) {} } };
process.on('uncaughtException', (e) => append('UNCAUGHT ' + ((e && e.stack) || e)));
process.on('unhandledRejection', (e) => append('UNHANDLED ' + ((e && e.stack) || e)));
process.on('exit', (code) => append('EXIT ' + code));
try {
  require(${JSON.stringify(VFS_YARN + "/bin/yarn.js")});
} catch (e) {
  append('THROW ' + ((e && e.stack) || e));
}
`,
);

const env = {
  HOME: "/home/user",
  PATH: "/bin",
  YARN_CACHE_FOLDER: "/tmp/.yarn-cache",
  VV_LIVE: LIVE ? "1" : "",
};
const YARN_FLAGS = ["--non-interactive", "--no-progress"];

function dumpLog(tailN) {
  try {
    const txt = kernel.readFile("/yarnlog.txt") || "";
    if (!txt.trim()) return;
    const shown = tailN ? txt.split("\n").slice(-tailN).join("\n") : txt;
    console.log("── yarn wrapper tap (/yarnlog.txt) ──\n" + shown);
  } catch {}
}

// ── Gate A: yarn --version (real cli.js on Path B, no network) ────────────────
console.log("── Gate A: yarn --version ──");
const t1 = Date.now();
const v = await kernel.start("node", ["/run-yarn.js", "--version", ...YARN_FLAGS], { cwd: "/app", env, capture: true });
dumpLog();
console.log(`exit=${v.code}  (${Date.now() - t1}ms)`);
console.log("stdout:", JSON.stringify((v.stdout || "").trim()));
if (v.stderr && v.stderr.trim()) console.log("stderr:\n" + v.stderr.trim());
const versionOk = v.code === 0 && new RegExp(`^\\s*${YARN_VERSION.replace(/\./g, "\\.")}\\s*$`).test(v.stdout || "");
console.log("Gate A (boots): " + (versionOk ? "PASS" : "FAIL") + "\n");

// ── Gate B: https egress self-test (isolate our fetch shim from yarn) ─────────
console.log("── Gate B: https.get self-test (registry.yarnpkg.com) ──");
kernel.writeFile(
  "/https-test.js",
  `
const https = require('https');
const req = https.get('https://registry.yarnpkg.com/is-number', (res) => {
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

// ── Gate C: real `yarn add <pkg>` over the Fetcher Worker ────────────────────
let installOk = true;
if (process.env.VV_NONET !== "1") {
  const PKG = process.env.VV_PKG || "is-number";
  console.log(`── Gate C: yarn add ${PKG} (real registry via Fetcher Worker) ──`);
  kernel.writeFile("/app/package.json", JSON.stringify({ name: "app", version: "1.0.0", license: "MIT", private: true }, null, 2));
  const TIMEOUT_MS = Number(process.env.VV_TIMEOUT || 120000);
  const t2 = Date.now();
  let timedOut = false;
  const inst = await Promise.race([
    kernel.start("node", ["/run-yarn.js", "add", PKG, ...YARN_FLAGS], { cwd: "/app", env, capture: !LIVE }),
    new Promise((r) => setTimeout(() => { timedOut = true; r({ code: 124, stdout: "", stderr: "TIMEOUT" }); }, TIMEOUT_MS)),
  ]);
  console.log(`exit=${inst.code}${timedOut ? " (TIMED OUT)" : ""}  (${Date.now() - t2}ms)`);
  if (inst.stdout && inst.stdout.trim()) console.log("stdout:\n" + inst.stdout.trim());
  if (inst.stderr && inst.stderr.trim()) console.log("stderr:\n" + inst.stderr.trim());
  dumpLog(60);

  const installed = kernel.exists(`/app/node_modules/${PKG}/package.json`);
  const lockfile = kernel.exists("/app/yarn.lock");
  console.log(`\nnode_modules/${PKG}/package.json: ${installed}   yarn.lock: ${lockfile}`);

  let requireOk = false;
  if (installed) {
    kernel.writeFile("/app/use.js", `const p = require(${JSON.stringify(PKG)}); console.log('REQUIRE_OK ' + typeof p);`);
    const use = await kernel.start("node", ["/app/use.js"], { cwd: "/app", env, capture: true });
    requireOk = use.code === 0 && /REQUIRE_OK/.test(use.stdout || "");
    console.log("require installed pkg: " + (requireOk ? "PASS " + use.stdout.trim() : "FAIL\n" + (use.stderr || use.stdout)));
  }
  installOk = inst.code === 0 && installed && requireOk;
  console.log("Gate C (installs): " + (installOk ? "PASS" : "FAIL") + "\n");
} else {
  console.log("── Gate C skipped (VV_NONET=1) ──\n");
}

const ok = versionOk && httpsOk && installOk;
console.log("RESULT: " + (ok ? "PASS — real yarn classic boots, egresses, and installs on Path B" : "FAIL — see logs above"));
process.exit(ok ? 0 : 1);
