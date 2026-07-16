// #3 spike — prove a real cross-service WebSocket works end-to-end in-VM.
//
// The studio ships a "WebSocket" template: a Vite frontend (:5173) + an Express +
// `ws` backend (:3001), with the frontend reaching the backend's ws cross-service
// via /preview/3001/ws. The browser side is two moving parts:
//   1) the SW ws shim maps a /preview/<port>/ ws URL to that in-VM port (unit-
//      tested separately — see the regex), and
//   2) the kernel routes a tunneled ws 'open' to whatever process listens on that
//      port (kernel.handleWsClient → this.listeners.get(port)), and relays the
//      server's frames back out (kernel.onWsSend).
//
// This drives (2) against the REAL `ws` backend from the template: it opens a
// tunneled connection to :3001 and asserts BOTH directions — the backend's
// server→client tick + welcome, and a client→server→client echo.
//
// Prereq (host, one-time):  rm -rf /tmp/vv-vendor-wsdemo && mkdir -p /tmp/vv-vendor-wsdemo \
//   && (cd /tmp/vv-vendor-wsdemo && npm install express@^4.21.0 ws@^8.18.0 --no-audit --no-fund)
// Requires Node >= 22 on the host (runtime fs.js uses Array.fromAsync).

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { Worker, MessageChannel } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";

const VENDOR = process.env.VV_WS_DEPS || "/tmp/vv-vendor-wsdemo/node_modules";
const LARGE_THRESHOLD = 512 * 1024;
if (!fs.existsSync(path.join(VENDOR, "express")) || !fs.existsSync(path.join(VENDOR, "ws"))) {
  console.error(`Missing express/ws at ${VENDOR}.`);
  console.error(`Install first:  rm -rf /tmp/vv-vendor-wsdemo && mkdir -p /tmp/vv-vendor-wsdemo && (cd /tmp/vv-vendor-wsdemo && npm install express@^4.21.0 ws@^8.18.0 --no-audit --no-fund)`);
  process.exit(2);
}

// ── kernel setup (same shape as the other spikes) ────────────────────────────
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
  if (info.threadPort) { init.threadPort = info.threadPort; transfer.push(info.threadPort); }
  w.postMessage(init, transfer);
  return {
    terminate: () => { w.terminate(); fsWorker.postMessage({ type: "fs-unregister", client: info.pid }); },
    postMessage: (m) => w.postMessage(m),
  };
};

const LIVE = process.env.VV_LIVE === "1";
const kernel = new Kernel({
  fs: kernelFs.fs,
  spawnWorker,
  stdout: LIVE ? (s) => process.stderr.write(s) : undefined,
  stderr: LIVE ? (s) => process.stderr.write(s) : undefined,
});
kernel.installCoreutils();

// ── load express + ws into the VFS (host install → /app/node_modules) ────────
let fileCount = 0;
async function loadDir(hostDir, vfsDir) {
  kernel.mkdirp(vfsDir);
  for (const entry of fs.readdirSync(hostDir, { withFileTypes: true })) {
    const hostPath = path.join(hostDir, entry.name);
    const vfsPath = vfsDir + "/" + entry.name;
    if (entry.isDirectory()) await loadDir(hostPath, vfsPath);
    else if (entry.isFile()) {
      const bytes = fs.readFileSync(hostPath);
      if (bytes.length >= LARGE_THRESHOLD) await kernelFs.fs.writeLarge(vfsPath, bytes);
      else kernel.writeFile(vfsPath, bytes);
      fileCount++;
    }
  }
}
kernel.mkdirp("/app/server");
const t0 = Date.now();
await loadDir(VENDOR, "/app/node_modules");
console.log(`Loaded express + ws into VFS: ${fileCount} files (${Date.now() - t0}ms)\n`);

// The backend from the template (faithful copy — Express status page + ws /ws).
kernel.writeFile(
  "/app/server/index.js",
  `const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const PORT = 3001;
const app = express();
app.get('/', (_req, res) => res.type('html').send('<h1>backend</h1>'));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'echo', msg: 'welcome' }));
  const tick = setInterval(() => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'tick', time: Date.now() })); }, 500);
  ws.on('message', (data) => ws.send(JSON.stringify({ type: 'echo', msg: String(data) })));
  ws.on('close', () => clearInterval(tick));
});
server.listen(PORT, () => console.log('[backend] listening on :' + PORT));
`,
);

// ── start the backend, wait until it's listening on :3001 ────────────────────
const listeningOn = new Promise((resolve) => {
  const prev = kernel.onListen;
  kernel.onListen = (port, pid) => { if (prev) prev(port, pid); if (port === 3001) resolve(pid); };
});
kernel.launch("node", ["/app/server/index.js"], { cwd: "/app", env: { HOME: "/home/user", PATH: "/bin" } });
const backendPid = await Promise.race([
  listeningOn,
  new Promise((r) => setTimeout(() => r(null), 20000)),
]);
console.log(`backend listening on :3001 (pid=${backendPid})  ${backendPid ? "" : "— TIMEOUT"}`);
const listenOk = backendPid != null;

// ── drive the tunnel exactly as the host does for the browser preview ────────
const received = [];
kernel.onWsSend = (m) => received.push(m);

const CONN = "spike-conn-1";
// 1) open: binds connId → backend pid, posts ws-open to the backend process.
kernel.handleWsClient({ sub: "open", connId: CONN, port: 3001, path: "/ws" });

// Wait for the server→client 'open' + at least one message (welcome/tick).
async function waitFor(pred, ms) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

const openOk = await waitFor(() => received.some((m) => m.sub === "open" && m.connId === CONN), 8000);
const gotServerPush = await waitFor(() => received.some((m) => m.sub === "msg"), 8000);

// 2) client → server: send a message, expect it echoed back.
kernel.handleWsClient({ sub: "send", connId: CONN, data: "ping-42" });
const decode = (d) => (typeof d === "string" ? d : Buffer.from(d).toString("utf8"));
const echoOk = await waitFor(
  () => received.some((m) => m.sub === "msg" && /"msg":"ping-42"/.test(decode(m.data))),
  8000,
);

kernel.handleWsClient({ sub: "close", connId: CONN });

console.log(`\nlisten gate:        ${listenOk ? "PASS" : "FAIL"}  (backend bound :3001)`);
console.log(`open gate:          ${openOk ? "PASS" : "FAIL"}  (tunneled ws opened to :3001)`);
console.log(`server→client gate: ${gotServerPush ? "PASS" : "FAIL"}  (backend pushed welcome/tick)`);
console.log(`client→server gate: ${echoOk ? "PASS" : "FAIL"}  (backend echoed "ping-42")`);
if (LIVE || !echoOk) console.log("frames:\n" + received.map((m) => `  ${m.sub} ${m.data ? decode(m.data) : ""}`).join("\n"));

const ok = listenOk && openOk && gotServerPush && echoOk;
console.log(`\nRESULT: ${ok ? "PASS — real cross-service WebSocket (Express + ws) works both directions in-VM" : "FAIL — see logs above"}`);
process.exit(ok ? 0 : 1);
