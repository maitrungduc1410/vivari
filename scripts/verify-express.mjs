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
  // #16 stage 2b: a spawned thread (e.g. rolldown's wasi-worker) also receives its
  // parentPort — a MessagePort transferred from its creator through us — so it must
  // be included in both the init payload and the transfer list. Omitting it makes
  // nested workers boot with no parentPort and hang (vite build stalls forever).
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
// No manual keep-alive: hostLiveness holds the loop through the async
// WebAssembly.compile, and process.exit() now works from an async continuation
// (esbuild's Go service parks on a stdin reader that never ends, so we exit
// explicitly once the work is done).
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
  process.exit(0);
})().catch((e) => { console.error('ESB_ERR:' + (e && e.stack || e)); process.exit(1); });
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

// === Vite runs in-VM: load the module graph AND run a real production build ====
// Vite 8 (rolldown-vite) pulls ~21 packages incl. @rolldown/binding-wasm32-wasi,
// which our npm auto-selects (stage 2c). require('vite') exercises the whole
// resolver + builtin surface: fs/promises, perf_hooks, v8, http2, readline, the
// package.json "imports" (#) field, ESM->CJS transpile (incl. self-declared
// __dirname/require via createRequire), and namespace-import lazy getters.
// `vite.build()` then drives the REAL rolldown wasm bundler over nested worker
// threads (napi-on-wasm) — this only completes because (a) the loop drains
// microtasks before checking for handles, so an async main can start, and (b) the
// emnapi waiting-request counter is mirrored into our loop liveness, so the parent
// stays alive across rolldown's unref'd worker-pool async work until it settles.
console.log("\n== vite build (network) ==");
kernel.mkdirp("/vt/src");
kernel.writeFile("/vt/package.json", JSON.stringify({ name: "vt", version: "1.0.0", private: true, type: "module" }));
kernel.writeFile("/vt/index.html", '<!doctype html><html><body><script type="module" src="/src/main.js"></script></body></html>');
kernel.writeFile("/vt/src/main.js", "const el = document.createElement('div'); el.textContent = 'hi ' + (1 + 2); document.body.appendChild(el); export {};");
const vinst = await kernel.start("npm", ["install", "vite"], { cwd: "/vt", capture: true });
assert(vinst.code === 0 && vinst.stdout.includes("added"), "npm install vite (auto-selects @rolldown/binding-wasm32-wasi)");
kernel.writeFile(
  "/vt/load.js",
  `
const vite = require('vite');
console.log('VITE_OK ' + [typeof vite.build, typeof vite.createServer, typeof vite.defineConfig].join(','));
process.exit(0);
`,
);
const vload = await kernel.start("node", ["load.js"], { cwd: "/vt", capture: true });
if (!vload.stdout.includes("VITE_OK function,function,function")) {
  console.log("  (vite load code=" + vload.code + ")\n  STDOUT: " + vload.stdout + "\n  STDERR: " + vload.stderr);
}
assert(
  vload.code === 0 && vload.stdout.includes("VITE_OK function,function,function"),
  "require('vite') loads the full module graph (build/createServer/defineConfig)",
);

// A real production build (no keep-alive timer — exits naturally on completion).
kernel.writeFile(
  "/vt/build.js",
  `
(async () => {
  try {
    const vite = require('vite');
    await vite.build({
      root: '/vt',
      logLevel: 'silent',
      configFile: false,
      build: { write: true, minify: false, reportCompressedSize: false, target: 'esnext' },
    });
    const fs = require('fs');
    const out = fs.readdirSync('/vt/dist');
    const asset = fs.readdirSync('/vt/dist/assets').find((f) => f.endsWith('.js'));
    const code = fs.readFileSync('/vt/dist/assets/' + asset, 'utf8');
    console.log('BUILD_OK ' + out.sort().join(',') + ' hasHi=' + code.includes('hi '));
  } catch (e) {
    console.log('BUILD_ERR ' + (e && e.stack || e));
  }
})();
`,
);
const vbuild = await kernel.start("node", ["build.js"], { cwd: "/vt", capture: true });
if (!vbuild.stdout.includes("BUILD_OK")) {
  console.log("  (vite build code=" + vbuild.code + ")\n  STDOUT: " + vbuild.stdout + "\n  STDERR: " + vbuild.stderr);
}
assert(
  vbuild.code === 0 && vbuild.stdout.includes("BUILD_OK assets,index.html") && vbuild.stdout.includes("hasHi=true"),
  "vite.build() runs the real rolldown wasm bundler and writes dist/ (loop-liveness across napi async work)",
);

// === Vite DEV server runs in-VM and is reachable through the preview bridge =====
// Roadmap #19 stage A: `vite.createServer().listen()` boots a long-lived dev
// server; we drive it exactly like the browser preview (kernel.handleHttpRequest)
// and assert it serves the transformed HTML/JS AND a *binary* asset from /public
// (which exercises fs.watch's watcher shim, the IPv6 listen-address fix,
// fs.createReadStream for static files, and the base64 binary body bridge).
// Reuses /vt (vite already installed above) to avoid a second install.
console.log("\n== vite dev (network) ==");
const PNG_BYTES = [137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3, 4, 5, 250, 251, 252, 253, 254, 255];
kernel.writeFile(
  "/vt/dev.js",
  `
const fs = require('fs');
fs.mkdirSync('/vt/public', { recursive: true });
fs.writeFileSync('/vt/public/pixel.png', Buffer.from(${JSON.stringify(PNG_BYTES)}));
const vite = require('vite');
(async () => {
  try {
    const server = await vite.createServer({
      root: '/vt', configFile: false, logLevel: 'silent',
      server: { port: 5273, host: '127.0.0.1', hmr: false }, optimizeDeps: { noDiscovery: true },
    });
    await server.listen();
    console.log('DEV_READY');
    setInterval(() => {}, 1000); // keep the dev server alive for the harness to probe
  } catch (e) { console.log('DEV_ERR ' + (e && e.stack || e)); process.exit(1); }
})();
`,
);
kernel.start("node", ["dev.js"], { cwd: "/vt" });
for (let i = 0; i < 1500 && !listening.has(5273); i++) await new Promise((r) => setTimeout(r, 20));
assert(listening.has(5273), "vite.createServer().listen() boots a long-lived dev server");

const devGet = (url) => kernel.handleHttpRequest(5273, { port: 5273, method: "GET", url, headers: { host: "127.0.0.1:5273" }, body: "" });

const devRoot = await devGet("/");
assert(
  devRoot.status === 200 && decode(devRoot.body).includes("/@vite/client") && decode(devRoot.body).includes('src="/src/main.js"'),
  "dev server serves index.html with the injected HMR client script",
);
const devMain = await devGet("/src/main.js");
assert(
  devMain.status === 200 && decode(devMain.body).includes("createElement"),
  "dev server serves the on-demand transformed /src/main.js",
);
const devPng = await devGet("/pixel.png");
const devPngBytes = devPng.bodyEncoding === "base64" ? [...Buffer.from(devPng.body, "base64")] : null;
assert(
  devPng.status === 200 &&
    devPng.bodyEncoding === "base64" &&
    devPngBytes.length === PNG_BYTES.length &&
    devPngBytes.every((b, i) => b === PNG_BYTES[i]),
  "dev server serves a binary /public asset intact (base64 body bridge)",
);

console.log(failures === 0 ? "\nRESULT: PASS" : `\nRESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
