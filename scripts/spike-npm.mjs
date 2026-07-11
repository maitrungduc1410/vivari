// Phase 0 spike (North Star: run the REAL npm/yarn/pnpm CLIs on Path B).
//
// Goal: prove the substrate can BOOT the real npm CLI. We load a vendored real
// npm (node_modules/npm, bundled deps and all) into the VFS and run
//   node /usr/lib/node_modules/npm/bin/npm-cli.js --version
// plus a few primitive checks npm leans on (chmod, os.*, process.version).
//
// This is a throwaway harness — it reports which Phase-0 primitives already work
// vs. need filling in before we invest in the http-over-fetcher egress (Phase 1).
//
//   1) vendor npm:  (already done by the agent)
//        rm -rf /tmp/oc-vendor && mkdir -p /tmp/oc-vendor \
//          && (cd /tmp/oc-vendor && npm install npm@10.9.2 --no-save --no-audit --no-fund)
//   2) run:  node scripts/spike-npm.mjs [path-to-vendored-npm]

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { Worker, MessageChannel } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";

const VENDOR_NPM = process.argv[2] || "/tmp/oc-vendor/node_modules/npm";
const VFS_NPM = "/usr/lib/node_modules/npm";

if (!fs.existsSync(path.join(VENDOR_NPM, "bin/npm-cli.js"))) {
  console.error(`No vendored npm at ${VENDOR_NPM} (expected bin/npm-cli.js).`);
  console.error(`Vendor it first:  rm -rf /tmp/oc-vendor && mkdir -p /tmp/oc-vendor && (cd /tmp/oc-vendor && npm install npm@10.9.2 --no-save --no-audit --no-fund)`);
  process.exit(2);
}

// ── kernel setup (same shape as probe-realdev.mjs) ───────────────────────────
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
const fetcher = async (url) => {
  const r = await fetch(url, { redirect: "follow" });
  const body = new Uint8Array(await r.arrayBuffer());
  const headers = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  return { ok: r.ok, status: r.status, headers, body };
};

const kernel = new Kernel({ fs: kernelFs.fs, spawnWorker, fetcher });
kernel.installCoreutils();

// ── load the vendored npm tree into the VFS ──────────────────────────────────
let fileCount = 0;
function loadDir(hostDir, vfsDir) {
  kernel.mkdirp(vfsDir);
  for (const entry of fs.readdirSync(hostDir, { withFileTypes: true })) {
    const hostPath = path.join(hostDir, entry.name);
    const vfsPath = vfsDir + "/" + entry.name;
    if (entry.isDirectory()) {
      loadDir(hostPath, vfsPath);
    } else if (entry.isFile()) {
      kernel.writeFile(vfsPath, fs.readFileSync(hostPath));
      fileCount++;
    }
    // symlinks inside npm's tree are rare; skip for the spike.
  }
}
const t0 = Date.now();
loadDir(VENDOR_NPM, VFS_NPM);
console.log(`Loaded real npm into VFS: ${fileCount} files at ${VFS_NPM} (${Date.now() - t0}ms)\n`);

kernel.mkdirp("/home/user");
kernel.mkdirp("/app");

// ── primitive checks npm leans on ────────────────────────────────────────────
kernel.writeFile(
  "/prim.js",
  `
const fs = require('fs');
const os = require('os');
const report = (k, v) => console.log('PRIM ' + k + ' = ' + v);

report('process.version', process.version);
report('process.platform', process.platform);
report('process.arch', process.arch);
report('process.release', JSON.stringify(process.release && process.release.name));
report('os.homedir', os.homedir());
report('os.tmpdir', os.tmpdir());
report('os.availableParallelism', typeof os.availableParallelism === 'function' ? os.availableParallelism() : 'MISSING');
report('os.cpus.len', os.cpus().length);

// chmod (npm marks .bin executables +x)
try {
  fs.writeFileSync('/app/x.sh', '#!/bin/sh\\necho hi\\n');
  fs.chmodSync('/app/x.sh', 0o755);
  const m = fs.statSync('/app/x.sh').mode;
  report('fs.chmod', 'ok mode=' + (m & 0o777).toString(8));
} catch (e) { report('fs.chmod', 'FAIL ' + (e && e.code || e.message)); }

// sha512 (integrity/ssri)
try {
  const crypto = require('crypto');
  report('crypto.sha512', crypto.createHash('sha512').update('abc').digest('hex').slice(0, 16) + '...');
} catch (e) { report('crypto.sha512', 'FAIL ' + (e && e.message)); }

// zlib gunzip
try {
  const zlib = require('zlib');
  report('zlib.gunzip', zlib.gunzipSync(zlib.gzipSync(Buffer.from('hello'))).toString());
} catch (e) { report('zlib.gunzip', 'FAIL ' + (e && e.message)); }
`,
);
const prim = await kernel.start("node", ["/prim.js"], { cwd: "/app", capture: true });
console.log("── primitives ──");
console.log((prim.stdout || "").trim());
if (prim.stderr && prim.stderr.trim()) console.log("prim stderr:\n" + prim.stderr.trim());
console.log(`(prim exit ${prim.code})\n`);

// ── the gate: real npm --version ─────────────────────────────────────────────
console.log("── npm --version (real npm-cli.js on Path B) ──");
const env = { HOME: "/home/user", PATH: "/bin", npm_config_cache: "/tmp/.npm" };

// Wrapper that taps npm's proc-log events (process.emit('log'|'output', ...)) and
// catches a synchronous throw, so we can SEE what npm tried to say even if its
// own display/flush path doesn't reach our captured stdout/stderr.
kernel.writeFile(
  "/run-npm.js",
  `
const fs = require('fs');
const util = require('util');
const LOG = '/npmlog.txt';
try { fs.writeFileSync(LOG, ''); } catch (e) {}
const fmt = (a) => a.map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 3 }))).join(' ');
const append = (s) => { try { fs.appendFileSync(LOG, s + '\\n'); } catch (e) {} };
process.on('output', (level, ...a) => append('OUTPUT[' + level + '] ' + fmt(a)));
process.on('log', (level, ...a) => append('LOG[' + level + '] ' + fmt(a)));
process.on('uncaughtException', (e) => append('UNCAUGHT ' + ((e && e.stack) || e)));
process.on('unhandledRejection', (e) => append('UNHANDLED ' + ((e && e.stack) || e)));
process.on('exit', (code) => append('EXIT ' + code));
try {
  require(${JSON.stringify(VFS_NPM + "/bin/npm-cli.js")});
} catch (e) {
  append('THROW ' + ((e && e.stack) || e));
}
`,
);
const t1 = Date.now();
const v = await kernel.start("node", ["/run-npm.js", "--version"], {
  cwd: "/app",
  env,
  capture: true,
});
try {
  const logtxt = kernel.readFile("/npmlog.txt");
  console.log("── npm proc-log tap (/npmlog.txt) ──\n" + (logtxt || "(empty)"));
} catch (e) {
  console.log("(no /npmlog.txt: " + (e && e.message) + ")");
}
console.log(`exit=${v.code}  (${Date.now() - t1}ms)`);
console.log("stdout:", JSON.stringify(v.stdout));
if (v.stderr && v.stderr.trim()) console.log("stderr:\n" + v.stderr);

const ok = v.code === 0 && /^\s*10\.9\.2\s*$/.test(v.stdout || "");
console.log("\nRESULT: " + (ok ? "PASS — real npm booted + printed its version" : "FAIL — see stderr above"));
process.exit(ok ? 0 : 1);
