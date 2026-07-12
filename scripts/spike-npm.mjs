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
const fetcher = async (url, init) => {
  const r = await fetch(url, { redirect: "follow", ...(init || {}) });
  const body = new Uint8Array(await r.arrayBuffer());
  const headers = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  return { ok: r.ok, status: r.status, statusText: r.statusText, headers, body };
};

const LIVE = process.env.OC_LIVE === "1";
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
const env = { HOME: "/home/user", PATH: "/bin", npm_config_cache: "/tmp/.npm", OC_LIVE: LIVE ? "1" : "" };

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
    const LIVE = process.env.OC_LIVE === '1';
    const append = (s) => { try { fs.appendFileSync(LOG, s + '\\n'); } catch (e) {} if (LIVE) { try { process.stderr.write('[npm] ' + s + '\\n'); } catch (e) {} } };
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

const versionOk = v.code === 0 && /^\s*10\.9\.2\s*$/.test(v.stdout || "");
console.log("version gate: " + (versionOk ? "PASS" : "FAIL"));

// ── https shim self-test (isolate the shim from npm's plumbing) ──────────────
console.log("\n── https.get self-test ──");
kernel.writeFile(
  "/https-test.js",
  `
const https = require('https');
const req = https.get('https://registry.npmjs.org/is-number', (res) => {
  let n = 0;
  res.on('data', (c) => { n += c.length; });
  res.on('end', () => { console.log('SELFTEST status=' + res.statusCode + ' bytes=' + n); process.exit(0); });
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

// ── phase 1 gate: real `npm install <pkg>` over the Fetcher Worker ────────────
const PKG = process.env.OC_PKG || "is-number";
console.log(`\n── npm install ${PKG} (real registry via Fetcher Worker) ──`);
kernel.mkdirp("/home/user");
kernel.mkdirp("/tmp/.npm/_logs");
kernel.writeFile("/app/package.json", JSON.stringify({ name: "app", version: "1.0.0" }, null, 2));
const t2 = Date.now();
const TIMEOUT_MS = Number(process.env.OC_TIMEOUT || 90000);
let timedOut = false;
const inst = await Promise.race([
  kernel.start(
    "node",
    ["/run-npm.js", "install", PKG, "--no-audit", "--no-fund", "--loglevel=silly"],
    { cwd: "/app", env, capture: !LIVE },
  ),
  new Promise((r) => setTimeout(() => { timedOut = true; r({ code: 124, stdout: "", stderr: "TIMEOUT" }); }, TIMEOUT_MS)),
]);
console.log(`exit=${inst.code}${timedOut ? " (TIMED OUT)" : ""}  (${Date.now() - t2}ms)`);
if (inst.stdout && inst.stdout.trim()) console.log("stdout:\n" + inst.stdout.trim());
try {
  const logtxt = kernel.readFile("/npmlog.txt") || "";
  // show only the tail — silly logs are huge
  const tail = logtxt.split("\n").slice(-40).join("\n");
  console.log("── npm proc-log tap (tail) ──\n" + tail);
} catch (e) {
  console.log("(no /npmlog.txt: " + (e && e.message) + ")");
}

const installedPkgJson = `/app/node_modules/${PKG}/package.json`;
const installed = kernel.exists(installedPkgJson);
console.log(`\nnode_modules/${PKG}/package.json exists: ${installed}`);

let requireOk = false;
if (installed) {
  kernel.writeFile("/app/use.js", `const p = require(${JSON.stringify(PKG)}); console.log('REQUIRE_OK ' + typeof p);`);
  const use = await kernel.start("node", ["/app/use.js"], { cwd: "/app", env, capture: true });
  requireOk = use.code === 0 && /REQUIRE_OK/.test(use.stdout || "");
  console.log("require installed pkg: " + (requireOk ? "PASS " + use.stdout.trim() : "FAIL\n" + (use.stderr || use.stdout)));
}

const installOk = inst.code === 0 && installed && requireOk;

// ── phase 2 gate: lifecycle scripts + .bin + non-fatal native (node-gyp) ─────
let lifecycleOk = true;
const PHASE2 = process.env.OC_PHASE2 === "1";
if (PHASE2) {
  console.log("\n══ PHASE 2: lifecycle scripts + .bin + node-gyp stub ══");
  kernel.mkdirp("/app2");
  // repro: run the exact script npm runs for a lifecycle hook, capture stderr.
  {
    const script = `node -e "require('fs').writeFileSync('preinstall.flag','ok')"`;
    const r = await kernel.start("sh", ["-c", script], { cwd: "/app2", env, capture: true });
    console.log(
      `[repro] sh -c ... exit=${r.code} stdout=${JSON.stringify((r.stdout || "").trim())} stderr=${JSON.stringify((r.stderr || "").trim())} flag=${kernel.exists("/app2/preinstall.flag")}`,
    );
    try { kernel.unlink("/app2/preinstall.flag"); } catch {}
  }
  // Root project with lifecycle scripts (preinstall/postinstall write markers, and
  // an `install` that shells out to node-gyp — must be non-fatal via the stub), a
  // dep that ships its own JS postinstall (core-js), and a dep with a bin (semver).
  kernel.writeFile(
    "/app2/package.json",
    JSON.stringify(
      {
        name: "app2",
        version: "1.0.0",
        scripts: {
          preinstall: "node -e \"require('fs').writeFileSync('preinstall.flag','ok')\"",
          install: "node-gyp rebuild",
          postinstall: "node -e \"require('fs').writeFileSync('postinstall.flag','ok')\"",
        },
        dependencies: { semver: "^7.6.0", "core-js": "3.38.1" },
      },
      null,
      2,
    ),
  );
  const t3 = Date.now();
  const inst2 = await Promise.race([
    kernel.start("node", ["/run-npm.js", "install", "--no-audit", "--no-fund", "--loglevel=silly"], {
      cwd: "/app2",
      env,
      capture: !LIVE,
    }),
    new Promise((r) => setTimeout(() => r({ code: 124, stdout: "", stderr: "TIMEOUT" }), TIMEOUT_MS)),
  ]);
  console.log(`install(app2) exit=${inst2.code}  (${Date.now() - t3}ms)`);
  if (inst2.stdout && inst2.stdout.trim()) console.log("stdout:\n" + inst2.stdout.trim());
  if (!LIVE) {
    try {
      const tail = (kernel.readFile("/npmlog.txt") || "").split("\n").slice(-50).join("\n");
      console.log("── npm proc-log tap (tail) ──\n" + tail);
    } catch {}
  }
  const checks = {
    "root preinstall ran": kernel.exists("/app2/preinstall.flag"),
    "root postinstall ran": kernel.exists("/app2/postinstall.flag"),
    "core-js installed": kernel.exists("/app2/node_modules/core-js/package.json"),
    "semver installed": kernel.exists("/app2/node_modules/semver/package.json"),
    ".bin/semver shim": kernel.exists("/app2/node_modules/.bin/semver"),
  };
  for (const [k, val] of Object.entries(checks)) console.log(`  ${val ? "PASS" : "FAIL"}  ${k}`);
  // .bin runnable via the local tool (semver CLI prints the coerced version)
  let binRun = false;
  if (checks[".bin/semver shim"]) {
    const r = await kernel.start("node", ["/run-npm.js", "exec", "--", "semver", "1.2.3"], {
      cwd: "/app2",
      env,
      capture: true,
    });
    binRun = r.code === 0 && /1\.2\.3/.test(r.stdout || "");
    console.log(`  ${binRun ? "PASS" : "FAIL"}  npx semver 1.2.3 -> ${JSON.stringify((r.stdout || "").trim())}`);
  }
  lifecycleOk = inst2.code === 0 && Object.values(checks).every(Boolean) && binRun;
  console.log("phase 2: " + (lifecycleOk ? "PASS" : "FAIL"));
}

const ok = versionOk && installOk && lifecycleOk;
console.log("\nRESULT: " + (ok ? "PASS — real npm boots, installs, and the tree is require-able" : "FAIL — see logs above"));
process.exit(ok ? 0 : 1);
