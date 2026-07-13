// #1 spike — run the REAL TypeScript 7 compiler (tsgo, the Go rewrite) on Path B.
//
// TS 7's `tsc`/`tsgo` is compiled Go, not JS, so we can't `require()` it. The
// community `tsgo-wasm` package ships the compiler as a GOOS=js/GOARCH=wasm
// module (`tsgo.wasm`, ~47 MB) plus the standard Go `wasm_exec.js` glue, which
// drives everything through `globalThis.fs` (Node's callback fs API, with
// `.code` errors), `globalThis.crypto.getRandomValues`, `performance.now`,
// `TextEncoder`, and `WebAssembly` — ALL of which our runtime already provides
// (real Node lib/fs.js over the VFS). This spike proves the Go wasm boots inside
// our Process Worker and actually type-checks files it reads from the VFS.
//
// Throwaway harness modelled on scripts/spike-corepack.mjs.
//
//   1) vendor:  rm -rf /tmp/oc-vendor-tsgo && mkdir -p /tmp/oc-vendor-tsgo \
//        && (cd /tmp/oc-vendor-tsgo && npm install tsgo-wasm --no-save --no-audit --no-fund)
//   2) run:  node scripts/spike-tsgo.mjs [path-to-vendored-tsgo-wasm]
//            OC_LIVE=1 streams the guest's stdout/stderr live.

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { Worker, MessageChannel } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";

const VENDOR = process.argv[2] || "/tmp/oc-vendor-tsgo/node_modules/tsgo-wasm";
const WASM_SRC = path.join(VENDOR, "tsgo.wasm");
const LAUNCHER_SRC = path.join(VENDOR, "tsgo-wasm");
const VFS_WASM = "/usr/lib/tsgo/tsgo.wasm";

if (!fs.existsSync(WASM_SRC) || !fs.existsSync(LAUNCHER_SRC)) {
  console.error(`No vendored tsgo-wasm at ${VENDOR} (expected tsgo.wasm + tsgo-wasm launcher).`);
  console.error(`Vendor it first:  rm -rf /tmp/oc-vendor-tsgo && mkdir -p /tmp/oc-vendor-tsgo && (cd /tmp/oc-vendor-tsgo && npm install tsgo-wasm --no-save --no-audit --no-fund)`);
  process.exit(2);
}

// ── kernel setup (same shape as spike-corepack.mjs) ──────────────────────────
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

const LIVE = process.env.OC_LIVE === "1";
const kernel = new Kernel({
  fs: kernelFs.fs,
  spawnWorker,
  stdout: LIVE ? (s) => process.stderr.write(s) : undefined,
  stderr: LIVE ? (s) => process.stderr.write(s) : undefined,
});
kernel.installCoreutils();

// ── load tsgo.wasm into the VFS (47 MB — writeLarge, out of the syscall window) ─
kernel.mkdirp("/usr/lib/tsgo");
const t0 = Date.now();
const wasmBytes = fs.readFileSync(WASM_SRC);
await kernelFs.fs.writeLarge(VFS_WASM, wasmBytes);
console.log(`Loaded tsgo.wasm into VFS: ${(wasmBytes.length / 1e6).toFixed(1)} MB at ${VFS_WASM} (${Date.now() - t0}ms)\n`);

kernel.mkdirp("/home/user");
kernel.mkdirp("/tmp");

// ── build a CJS runner from the vendored ESM launcher ────────────────────────
// The launcher is ESM with top-level await; we only need its Go engine class.
// Slice out `const encoder … class Go { … }` (drop the ESM import header and the
// boot tail) and wrap it in a CJS bootstrap that wires globals + runs the wasm.
const launcher = fs.readFileSync(LAUNCHER_SRC, "utf8");
const startIdx = launcher.indexOf("const encoder");
const endIdx = launcher.indexOf("const go = new Go()");
if (startIdx === -1 || endIdx === -1) {
  console.error("Could not locate the Go engine class in the tsgo-wasm launcher — layout changed?");
  process.exit(2);
}
const goEngine = launcher.slice(startIdx, endIdx);

const runner = `
const _fs = require('fs');
const path = require('path');
// Go's wasm_exec writes program output to fd 1/2 via fs.writeSync / fs.write.
// Our VFS fs doesn't wire those fds to the terminal, so route them to
// process.stdout/stderr; everything else falls through to the real VFS fs.
// (inherit all other members — incl. fs.constants — via the prototype chain.)
const fs = Object.create(_fs);
const _toBuf = (b, off, len) => {
  const u = b && b.subarray ? b : Buffer.from(b);
  return (off != null || len != null) ? u.subarray(off || 0, (off || 0) + (len == null ? u.length : len)) : u;
};
fs.writeSync = function (fd, buf, ...rest) {
  if (fd === 1 || fd === 2) { const b = _toBuf(buf); (fd === 1 ? process.stdout : process.stderr).write(Buffer.from(b).toString('utf8')); return b.length; }
  return _fs.writeSync(fd, buf, ...rest);
};
fs.write = function (fd, buf, offset, length, position, cb) {
  if (fd === 1 || fd === 2) {
    const b = _toBuf(buf, typeof offset === 'number' ? offset : 0, typeof length === 'number' ? length : undefined);
    (fd === 1 ? process.stdout : process.stderr).write(Buffer.from(b).toString('utf8'));
    const done = typeof cb === 'function' ? cb : typeof position === 'function' ? position : typeof length === 'function' ? length : null;
    if (done) done(null, b.length, buf);
    return;
  }
  return _fs.write(fd, buf, offset, length, position, cb);
};
globalThis.fs = fs;
globalThis.path = path;
globalThis.require = require;
if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') {
  const _c = require('crypto');
  globalThis.crypto = { getRandomValues: (b) => { _c.randomFillSync(b); return b; } };
}
if (!globalThis.performance) globalThis.performance = { now: () => Date.now() };

${goEngine}

const go = new Go();
// os.Args[0] is the program name; the rest are the user's tsgo flags.
go.argv = ['tsgo'].concat(process.argv.slice(2));
// Keep env TINY — Go's wasm_exec caps argv+env at ~12 KB of linear memory.
go.env = { TMPDIR: '/tmp', HOME: '/home/user', PATH: '/bin' };
go.exit = (code) => process.exit(code);
const bytes = fs.readFileSync(${JSON.stringify(VFS_WASM)});
WebAssembly.instantiate(bytes, go.importObject)
  .then((res) => go.run(res.instance))
  .catch((e) => { console.error((e && e.stack) || String(e)); process.exit(1); });
`;
kernel.writeFile("/run-tsgo.js", runner);

const env = { HOME: "/home/user", PATH: "/bin", TMPDIR: "/tmp" };

// ── Gate A: tsgo --version (Go wasm boots inside our Process Worker) ──────────
console.log("── Gate A: tsgo --version ──");
const t1 = Date.now();
const v = await kernel.start("node", ["/run-tsgo.js", "--version"], { cwd: "/", env, capture: true });
console.log(`exit=${v.code}  (${Date.now() - t1}ms)`);
console.log("stdout:", JSON.stringify((v.stdout || "").trim()));
if (v.stderr && v.stderr.trim()) console.log("stderr:\n" + v.stderr.trim());
const versionOk = v.code === 0 && /Version\s+7\./.test(v.stdout || "");
console.log("Gate A (boots + prints version): " + (versionOk ? "PASS" : "FAIL") + "\n");

// ── Gate B: type-check a clean project read from the VFS ─────────────────────
kernel.mkdirp("/app/src");
kernel.writeFile(
  "/app/tsconfig.json",
  JSON.stringify(
    { compilerOptions: { strict: true, noEmit: true, target: "ES2020", module: "ESNext", moduleResolution: "bundler" }, include: ["src"] },
    null,
    2,
  ),
);
kernel.writeFile("/app/src/index.ts", `export const add = (a: number, b: number): number => a + b;\nconst r: number = add(1, 2);\nexport default r;\n`);

console.log("── Gate B: tsgo -p /app/tsconfig.json (clean → exit 0) ──");
const t2 = Date.now();
const good = await kernel.start("node", ["/run-tsgo.js", "-p", "/app/tsconfig.json"], { cwd: "/app", env, capture: true });
console.log(`exit=${good.code}  (${Date.now() - t2}ms)`);
if (good.stdout && good.stdout.trim()) console.log("stdout:\n" + good.stdout.trim());
if (good.stderr && good.stderr.trim()) console.log("stderr:\n" + good.stderr.trim());
const cleanOk = good.code === 0;
console.log("Gate B (clean type-check): " + (cleanOk ? "PASS" : "FAIL") + "\n");

// ── Gate C: a real type error is reported (exit != 0 + diagnostic) ───────────
kernel.writeFile("/app/src/index.ts", `export const add = (a: number, b: number): number => a + b;\nconst r: string = add(1, 2);\nexport default r;\n`);
console.log("── Gate C: tsgo catches a type error (exit != 0) ──");
const t3 = Date.now();
const bad = await kernel.start("node", ["/run-tsgo.js", "-p", "/app/tsconfig.json"], { cwd: "/app", env, capture: true });
console.log(`exit=${bad.code}  (${Date.now() - t3}ms)`);
const diag = ((bad.stdout || "") + (bad.stderr || "")).trim();
if (diag) console.log("diagnostics:\n" + diag);
const errorOk = bad.code !== 0 && /TS\d+|not assignable/i.test(diag);
console.log("Gate C (reports type error): " + (errorOk ? "PASS" : "FAIL") + "\n");

const ok = versionOk && cleanOk && errorOk;
console.log(
  "RESULT: " +
    (ok
      ? "PASS — real TypeScript 7 (tsgo, Go/wasm) boots and type-checks VFS files on Path B"
      : "FAIL — see logs above"),
);
process.exit(ok ? 0 : 1);
