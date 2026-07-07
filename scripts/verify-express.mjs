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
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const wasm = require("../packages/kernel/pkg-node/open_webcontainer_kernel.js");

let failures = 0;
function assert(cond, msg) {
  console.log(`  ${cond ? "\u2713" : "\u2717"} ${msg}`);
  if (!cond) failures++;
}

const vfs = new wasm.VirtualFileSystem();
const spawnWorker = (info) => {
  const w = new Worker(new URL("./process-worker.mjs", import.meta.url));
  w.on("message", (m) => {
    const h = info.on[m.type];
    if (h) h(m);
  });
  w.postMessage({ type: "init", sab: info.sab, spec: info.spec });
  return { terminate: () => w.terminate(), postMessage: (m) => w.postMessage(m) };
};
const fetcher = async (url) => {
  const r = await fetch(url, { redirect: "follow" });
  const body = new Uint8Array(await r.arrayBuffer());
  const headers = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  return { ok: r.ok, status: r.status, headers, body };
};

const listening = new Set();
const kernel = new Kernel({ vfs, spawnWorker, fetcher, stdout: () => {}, stderr: () => {} });
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

console.log(failures === 0 ? "\nRESULT: PASS" : `\nRESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
