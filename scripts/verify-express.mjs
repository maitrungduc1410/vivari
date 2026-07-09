// Express end-to-end smoke test (NETWORK REQUIRED).
//
// Unlike verify-node.mjs (hermetic — a mock fetcher serves local fixtures), this
// script installs the REAL `express` package + its ~70-package dependency tree
// from registry.npmjs.org, boots the app, and calls it through the kernel. It
// proves the framework runs unmodified on our vendored Node stack (router,
// params, and express.json() body parsing over the tty/crypto/zlib/url/
// querystring builtins).
//
//   node scripts/verify-express.mjs
//
// Kept separate from the main suite so `verify-node.mjs` stays offline.

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { Worker, MessageChannel } from "node:worker_threads";

let failures = 0;
function assert(cond, msg) {
  console.log(`  ${cond ? "\u2713" : "\u2717"} ${msg}`);
  if (!cond) failures++;
}

// #14: the Wasm VFS lives in a dedicated File System Worker.
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
  w.postMessage({ type: "init", sab: info.sab, spec: info.spec, fsPort: port1 }, [port1]);
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

const listening = new Set();
const kernel = new Kernel({ fs: kernelFs.fs, spawnWorker, fetcher, stdout: () => {}, stderr: () => {} });
kernel.onListen = (port) => listening.add(port);
kernel.installCoreutils();

kernel.mkdirp("/app");
kernel.writeFile("/app/package.json", JSON.stringify({ name: "exp", version: "1.0.0" }));
kernel.writeFile(
  "/app/server.js",
  `
const express = require('express');
const app = express();
app.use(express.json());
app.get('/api/hello', (req, res) => res.json({ ok: true, node: process.version }));
app.get('/api/users/:id', (req, res) => res.json({ id: req.params.id }));
app.post('/api/echo', (req, res) => res.json({ youSent: req.body }));
app.listen(3000, () => console.log('express up'));
`,
);

console.log("== Express e2e (network) ==");
const ni = await kernel.start("npm", ["install", "express"], { cwd: "/app", capture: true });
assert(ni.code === 0 && ni.stdout.includes("added"), "npm install express resolves the full dependency tree");

kernel.start("node", ["server.js"], { cwd: "/app" });
for (let i = 0; i < 500 && !listening.has(3000); i++) await new Promise((r) => setTimeout(r, 10));
assert(listening.has(3000), "express app boots and listens (app.listen)");

const decode = (b) => (typeof b === "string" ? b : Buffer.from(b).toString());

const hello = await kernel.handleHttpRequest(3000, { method: "GET", url: "/api/hello", headers: {}, body: "" });
assert(hello.status === 200 && JSON.parse(decode(hello.body)).ok === true, "GET /api/hello routes + res.json (ETag via crypto)");

const user = await kernel.handleHttpRequest(3000, { method: "GET", url: "/api/users/42", headers: {}, body: "" });
assert(user.status === 200 && JSON.parse(decode(user.body)).id === "42", "GET /api/users/:id resolves route params");

const echo = await kernel.handleHttpRequest(3000, {
  method: "POST",
  url: "/api/echo",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ a: 1 }),
});
assert(echo.status === 200 && JSON.parse(decode(echo.body)).youSent.a === 1, "POST /api/echo parses JSON body (express.json / body-parser)");

// === real bundler in-VM: esbuild-wasm (Go→wasm) via the browser build =========
// The Node entry spawns a child `node bin/esbuild` and pipes over stdin/stdout;
// instead we use the BROWSER build with `worker:false`, which runs the Go wasm on
// the current thread (postMessage-simulated stdio) — no child process, no stdin
// fd. It needs only crypto.getRandomValues / performance / TextEncoder / self,
// which our runtime provides. Proves a real, unmodified bundler runs in-VM.
console.log("\n== esbuild-wasm e2e (network) ==");
kernel.mkdirp("/esb");
kernel.writeFile("/esb/package.json", JSON.stringify({ name: "esb", version: "1.0.0" }));
const ei = await kernel.start("npm", ["install", "esbuild-wasm"], { cwd: "/esb", capture: true });
assert(ei.code === 0 && ei.stdout.includes("added"), "npm install esbuild-wasm");
kernel.writeFile(
  "/esb/run.js",
  `
const fs = require('fs');
const esbuild = require('esbuild-wasm/lib/browser.js');
const wasmPath = require.resolve('esbuild-wasm/esbuild.wasm');
// hostLiveness now keeps the loop alive through async host work, but esbuild's Go
// service parks on a stdin reader that never ends, so we still exit explicitly —
// and process.exit() must run from a loop-managed callback (its throw-sentinel is
// only caught there, not in a raw Promise microtask), hence the keep-alive timer.
let done = false, code = 0;
const keepAlive = setInterval(() => { if (done) { clearInterval(keepAlive); process.exit(code); } }, 15);
(async () => {
  const wasmModule = await WebAssembly.compile(fs.readFileSync(wasmPath));
  await esbuild.initialize({ wasmModule, worker: false });
  const t = await esbuild.transform('const x: number = 1; export const y = x+1', { loader: 'ts' });
  const b = await esbuild.build({
    stdin: { contents: 'export const sum=(a,b)=>a+b; console.log(sum(2,3))', loader: 'js' },
    bundle: true, format: 'iife', write: false,
  });
  console.log('ESB_TRANSFORM:' + JSON.stringify(t.code));
  console.log('ESB_BUILD:' + JSON.stringify(b.outputFiles[0].text));
  done = true;
})().catch((e) => { console.error('ESB_ERR:' + (e && e.stack || e)); code = 1; done = true; });
`,
);
const er = await kernel.start("node", ["run.js"], { cwd: "/esb", capture: true });
if (er.code !== 0 || !er.stdout.includes("const x = 1;")) {
  console.log("  (esbuild run code=" + er.code + ")\n  STDOUT: " + er.stdout + "\n  STDERR: " + er.stderr);
}
assert(er.code === 0 && er.stdout.includes('const x = 1;'),
  "esbuild-wasm transform: TS -> JS (strips the type annotation)");
assert(er.stdout.includes('sum(2, 3)') && er.stdout.includes('ESB_BUILD:'),
  "esbuild-wasm build: bundles an ESM entry to an IIFE");

console.log(failures === 0 ? "\nRESULT: PASS" : `\nRESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
