// Spike: the optional network relay (packages/kernel-host/net-relay.js +
// scripts/net-relay.mjs), headless, no browser.
//
// The relay is a local agent the developer runs; with it configured the VM gets a
// real network in BOTH directions. This spike starts the reference relay as a child
// process, boots a headless kernel pointed at it, and gates:
//
//   1) INBOUND — an in-VM `http.createServer().listen(P)` is reachable from the
//      host at 127.0.0.1:P. The request is a browser-shaped OAuth callback
//      (`/callback?code=…`) because that is the CLI login flow this exists for.
//   2) OUTBOUND — in-VM `net.connect(H, "host.vivari.internal")` reaches a TCP
//      server on the host and gets its bytes back.
//   3) REFUSAL still works — a dial to a port nobody serves closes promptly, and
//      with NO relay configured an external dial is refused exactly as before.
//
// Run (Node 22+):  node scripts/spike-net-relay.mjs

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { initTransferList } from "../packages/kernel-host/worker-transfer.js";
import { Worker, MessageChannel } from "node:worker_threads";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, what, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return;
    await sleep(25);
  }
  throw new Error("timed out waiting for " + what);
}
const httpGet = (url) =>
  new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });

// ── the relay, as the developer would run it ─────────────────────────────────
const relayProc = spawn(process.execPath, [new URL("./net-relay.mjs", import.meta.url).pathname, "--port", "0", "--allow-no-origin", "--json"], {
  stdio: ["ignore", "pipe", "pipe"],
});
const relayLog = [];
relayProc.stderr.on("data", (d) => relayLog.push(String(d)));
const relayUrl = await new Promise((resolve, reject) => {
  let buf = "";
  relayProc.stdout.on("data", (d) => {
    buf += d;
    const nl = buf.indexOf("\n");
    if (nl >= 0) resolve(JSON.parse(buf.slice(0, nl)).url);
  });
  relayProc.on("exit", (c) => reject(new Error("relay exited " + c)));
});

// ── headless kernel (same shape as probe-xtcp.mjs) ────────────────────────────
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
  w.on("error", (e) => process.stderr.write(`\n[worker-error pid ${info.pid}] ${(e && e.stack) || e}\n`));
  const { port1, port2 } = new MessageChannel();
  fsWorker.postMessage({ type: "fs-register", client: info.pid, sab: info.sab, port: port2 }, [port2]);
  const init = { type: "init", sab: info.sab, spec: info.spec, fsPort: port1 };
  if (info.threadPort) init.threadPort = info.threadPort;
  w.postMessage(init, initTransferList(info, port1));
  return {
    terminate: () => {
      w.terminate();
      fsWorker.postMessage({ type: "fs-unregister", client: info.pid });
    },
    postMessage: (m) => w.postMessage(m),
  };
};
const out = [];
const cap = (s) => {
  out.push(String(s));
  if (process.env.VV_LIVE === "1") process.stderr.write(String(s));
};
const kernel = new Kernel({ fs: kernelFs.fs, spawnWorker, stdout: cap, stderr: cap });
kernel.onNetLog = (line) => cap(line + "\n");
kernel.installCoreutils();
kernel.mkdirp("/home/user");
const env = { HOME: "/home/user", PATH: "/bin", NODE_ENV: "development" };
const has = (re) => re.test(out.join(""));

let failed = 0;
const check = (ok, msg) => {
  console.log((ok ? "  \u2713 " : "  \u2717 ") + msg);
  if (!ok) failed++;
};

// ── gate 3a: with NO relay, an external dial is refused as before ─────────────
kernel.writeFile(
  "/refused.js",
  `const net = require("net");
const s = net.connect(9, "example.invalid");
s.on("error", (e) => { console.log("NORELAY " + e.code); process.exit(0); });
s.on("connect", () => { console.log("NORELAY CONNECTED?!"); process.exit(1); });
setTimeout(() => { console.log("NORELAY TIMEOUT"); process.exit(2); }, 5000);
`,
);
{
  const r = await kernel.start("node", ["/refused.js"], { cwd: "/", env, capture: true });
  check(/NORELAY ENOTFOUND/.test(r.stdout), "no relay configured: net.connect(example.invalid) → ENOTFOUND (unchanged)");
}

// ── configure the relay ────────────────────────────────────────────────────────
kernel.setNetRelay(relayUrl);

// ── gate 1: INBOUND — in-VM http server, host-side OAuth-style callback ───────
const PORT = 3811;
kernel.writeFile(
  "/server.js",
  `const http = require("http");
const server = http.createServer((req, res) => {
  console.log("SERVER " + req.method + " " + req.url + " from " + req.socket.remoteAddress);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, url: req.url, host: req.headers.host }));
});
server.listen(${PORT}, () => console.log("LISTENING " + ${PORT}));
`,
);
const serverExit = kernel.start("node", ["/server.js"], { cwd: "/", env });
await waitFor(() => has(/LISTENING 3811/), "in-VM server to listen");
await waitFor(() => has(/listening on relay host :3811/), "relay to bind 127.0.0.1:3811");

let cb;
try {
  cb = await httpGet(`http://127.0.0.1:${PORT}/callback?code=from-idp-42&state=xyz`);
} catch (e) {
  cb = { status: 0, body: String(e) };
}
check(cb.status === 200, `host GET 127.0.0.1:${PORT}/callback → ${cb.status}`);
check(/"url":"\/callback\?code=from-idp-42&state=xyz"/.test(cb.body), "response body carries the callback url + code");
await waitFor(() => has(/SERVER GET \/callback\?code=from-idp-42&state=xyz/), "in-VM server to log the request").catch(() => {});
check(has(/SERVER GET \/callback\?code=from-idp-42&state=xyz/), "in-VM server logged the request (real request object, real socket)");

// keep-alive / second request on a fresh connection
const cb2 = await httpGet(`http://127.0.0.1:${PORT}/second`).catch((e) => ({ status: 0, body: String(e) }));
check(cb2.status === 200 && /"url":"\/second"/.test(cb2.body), "a second inbound connection works");

// ── gate 2: OUTBOUND — in-VM net.connect to a TCP server on the host ──────────
const echo = net.createServer((sock) => {
  sock.on("data", (d) => sock.write("echo:" + d.toString()));
  sock.on("end", () => sock.end());
});
await new Promise((r) => echo.listen(0, "127.0.0.1", r));
const ECHO_PORT = echo.address().port;
kernel.writeFile(
  "/client.js",
  `const net = require("net");
const s = net.connect(${ECHO_PORT}, "host.vivari.internal", () => {
  console.log("CLIENT connected");
  s.write("ping-from-vm");
});
s.on("data", (d) => { console.log("CLIENT got " + d.toString()); s.end(); });
s.on("close", () => { console.log("CLIENT closed"); process.exit(0); });
s.on("error", (e) => { console.log("CLIENT ERR " + e.code + " " + e.message); process.exit(1); });
setTimeout(() => { console.log("CLIENT TIMEOUT"); process.exit(2); }, 8000);
`,
);
{
  const r = await kernel.start("node", ["/client.js"], { cwd: "/", env, capture: true });
  check(/CLIENT connected/.test(r.stdout), "outbound: net.connect(host.vivari.internal:" + ECHO_PORT + ") connected via relay");
  check(/CLIENT got echo:ping-from-vm/.test(r.stdout), "outbound: bytes round-trip through the relay");
  check(/CLIENT closed/.test(r.stdout) && r.code === 0, "outbound: end() → remote close → socket 'close' (exit 0)");
}

// ── gate 3b: a dial to a port nobody serves closes promptly, not hangs ────────
kernel.writeFile(
  "/refused2.js",
  `const net = require("net");
const s = net.connect(1, "host.vivari.internal");
let ended = false;
s.on("connect", () => console.log("REF2 connected (relay accepts the dial; the refusal follows)"));
s.on("close", () => { console.log("REF2 closed"); process.exit(0); });
s.on("error", (e) => { console.log("REF2 error " + e.code); });
setTimeout(() => { console.log("REF2 TIMEOUT"); process.exit(2); }, 6000);
`,
);
{
  const r = await kernel.start("node", ["/refused2.js"], { cwd: "/", env, capture: true });
  check(/REF2 closed/.test(r.stdout) && r.code === 0, "relay-refused port → socket closes promptly (no hang)");
}

// ── teardown ───────────────────────────────────────────────────────────────────
kernel.stop(kernel.procs.keys().next().value);
await Promise.race([serverExit, sleep(2000)]);
await waitFor(() => /closed 127\.0\.0\.1:3811/.test(relayLog.join("")), "relay to release :3811 when the server process died", 5000).catch(() => {});
check(/closed 127\.0\.0\.1:3811/.test(relayLog.join("")), "killing the server process releases the host port on the relay");
echo.close();
relayProc.kill();
fsWorker.terminate();

if (process.env.VV_LIVE === "1" || failed) {
  console.log("\n── kernel/process output ──\n" + out.join("").trim());
  console.log("\n── relay log ──\n" + relayLog.join("").trim());
}
console.log("\nRESULT: " + (failed ? `FAIL (${failed})` : "PASS — relay gives the VM a network in both directions, and nothing changes without it"));
process.exit(failed ? 1 : 0);
