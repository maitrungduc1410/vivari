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
//   1b) an ACCEPT for a port the relay never confirmed LISTENING is refused, so a
//      relay cannot dial into an in-VM server on its own initiative.
//   1c) killing the relay and restarting it on the same port/token brings the
//      forwarded port back: the kernel reconnects with backoff and re-LISTENs.
//   4) replacing the relay (setNetRelay again) tells a guest with a live relayed
//      connection that it died: 'error' ECONNRESET, then 'close'.
//   5) no kernel log line carries the relay URL's access token.
//   2) OUTBOUND — in-VM `net.connect(H, "host.vivari.internal")` reaches a TCP
//      server on the host and gets its bytes back.
//   3a) with NO relay configured an external dial is refused exactly as before.
//   3b) through the relay, dials report what real Node reports — compared against
//      the host's Node: refused → 'error' ECONNREFUSED and no 'connect', an
//      unresolvable name → the host's lookup error, a reset after connect →
//      ECONNRESET, and a connected socket's remoteAddress is the real peer.
//   3c) relay→VM backpressure: a guest that stops reading stops the relay reading
//      TCP (≈ one 32-packet window reaches the tab), and resuming delivers it all.
//
// Run (Node 22+):  node scripts/spike-net-relay.mjs

import { bootSpikeKernel, LIVE } from "./lib/spike-harness.mjs";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
// A port free on this host: bind :0, read the number, release it.
const freePort = () =>
  new Promise((r) => {
    const t = net.createServer();
    t.listen(0, "127.0.0.1", () => {
      const p = t.address().port;
      t.close(() => r(p));
    });
  });
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
const relayLog = [];
function startRelay(extra = []) {
  const proc = spawn(
    process.execPath,
    [new URL("./net-relay.mjs", import.meta.url).pathname, "--allow-no-origin", "--json", ...extra],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  proc.stderr.on("data", (d) => relayLog.push(String(d)));
  const info = new Promise((resolve, reject) => {
    let buf = "";
    proc.stdout.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl >= 0) resolve(JSON.parse(buf.slice(0, nl)));
    });
    proc.on("exit", (c) => reject(new Error("relay exited " + c)));
  });
  return { proc, info };
}
let relay = startRelay(["--port", "0"]);
const relayInfo = await relay.info;
const relayUrl = relayInfo.url;

// ── headless kernel: the shared spike harness ─────────────────────────────────
const h = await bootSpikeKernel();
const { kernel, out } = h;
kernel.onNetLog = (line) => {
  out.push(line + "\n");
  if (LIVE) process.stderr.write(line + "\n");
};
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
// A host port nothing holds right now, so the relay can bind it for the in-VM
// server (a fixed number fails every inbound gate on a host that happens to use it).
const PORT = await freePort();
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
const boundRe = () => new RegExp("listening on relay host :" + PORT + "\\b", "g");
const releasedRe = new RegExp("closed 127\\.0\\.0\\.1:" + PORT + "\\b");
const serverExit = kernel.start("node", ["/server.js"], { cwd: "/", env });
await waitFor(() => has(new RegExp("LISTENING " + PORT + "\\b")), "in-VM server to listen");
await waitFor(() => has(boundRe()), "relay to bind 127.0.0.1:" + PORT);

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

// ── gate 1b: an ACCEPT for a port the relay never confirmed is refused ────────
// Hold a host port so the relay's bind fails (LISTENING ok=0), have the VM listen
// on it anyway, then play a rogue relay: inject an ACCEPT for that port. The
// in-VM server must never see a connection, and the kernel must answer CLOSE.
{
  const squat = net.createServer(() => {});
  await new Promise((r) => squat.listen(0, "127.0.0.1", r));
  const SQUAT = squat.address().port;
  kernel.writeFile(
    "/squat.js",
    `const net = require("net");
const srv = net.createServer((c) => { console.log("SQUAT accepted " + c.remoteAddress); c.destroy(); });
srv.listen(${SQUAT}, () => console.log("SQUAT listening"));
setTimeout(() => srv.close(), 3000);
`,
  );
  const squatExit = kernel.start("node", ["/squat.js"], { cwd: "/", env });
  await waitFor(() => has(new RegExp("could not bind :" + SQUAT)), "relay to fail binding the squatted port");
  const relay = kernel.netRelay;
  const sent = [];
  const realSend = relay._sendNow.bind(relay);
  relay._sendNow = (type, id, payload) => {
    sent.push({ type, id });
    return realSend(type, id, payload);
  };
  const rogueId = (0x80000000 | 0x7ff0) >>> 0;
  const pkt = new Uint8Array(5 + 2 + 11);
  const dv = new DataView(pkt.buffer);
  pkt[0] = 0x13; // VV_ACCEPT
  dv.setUint32(1, rogueId, true);
  dv.setUint16(5, SQUAT, true);
  pkt.set(new TextEncoder().encode("6.6.6.6:666"), 7);
  relay._onPacket(pkt.buffer);
  await sleep(300);
  relay._sendNow = realSend;
  check(!relay.isConfirmed(SQUAT) && !has(/SQUAT accepted/), "rogue ACCEPT on an unconfirmed port never reaches the in-VM server");
  check(sent.some((p) => p.type === 0x04 && p.id === rogueId), "…and the kernel answers it with CLOSE");
  await squatExit;
  squat.close();
}

// ── gate 1c: the relay restarts → forwarded ports come back on their own ─────
{
  const count = (re) => (out.join("").match(re) || []).length;
  const bound = boundRe();
  const before = count(bound);
  const died = new Promise((r) => relay.proc.once("exit", r));
  relay.proc.kill();
  await died;
  await waitFor(() => /relay socket closed/.test(out.join("")), "kernel to notice the relay went away");
  const gone = await httpGet(`http://127.0.0.1:${PORT}/while-down`).then(() => "served", (e) => e.code || String(e));
  check(gone !== "served", `relay down → host :${PORT} is closed (${gone})`);
  await sleep(600); // let at least one reconnect attempt fail against the dead port
  relay = startRelay(["--port", String(relayInfo.port), "--token", relayInfo.token]);
  await relay.info;
  let back = true;
  await waitFor(() => count(bound) > before, "the kernel to reconnect and re-bind :" + PORT, 20000).catch(() => (back = false));
  check(back, "relay restarted on the same port/token → kernel reconnects and re-announces LISTEN");
  const again = await httpGet(`http://127.0.0.1:${PORT}/after-restart`).catch((e) => ({ status: 0, body: String(e) }));
  check(again.status === 200 && /"url":"\/after-restart"/.test(again.body), "…and inbound works again without the guest doing anything");
}

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

// ── gate 3b: outbound dials fail and succeed the way real Node's do ──────────
// Each scenario runs on the HOST's real Node (dialling 127.0.0.1) and in the VM
// (dialling host.vivari.internal, i.e. the same socket via the relay), and the
// event transcripts must match. Real Node is the oracle, as in
// spike-net-close-order: a refused dial is 'error' ECONNREFUSED then 'close' —
// never 'connect' — and a connection reset after connect is 'error' ECONNRESET.
// ENOTFOUND compares the code only: in-VM DNS resolves every name, so the VM's
// error comes from connect(), not getaddrinfo, and its message says so.
const deadPort = await freePort();
const resetter = net.createServer((sock) => sock.resetAndDestroy());
await new Promise((r) => resetter.listen(0, "127.0.0.1", r));
const RESET_PORT = resetter.address().port;
const dialSrc = ({ port, host, msg, end }) => `const net = require("net");
const seen = [];
const s = net.connect(${port}, ${JSON.stringify(host)});
seen.push("pre:" + s.remoteAddress);
s.on("connect", () => {
  seen.push("connect:" + s.remoteAddress + ":" + (s.remotePort === ${port}) + ":" + s.remoteFamily);
  ${end ? "s.end();" : ""}
});
s.on("error", (e) => seen.push("error:" + e.code${msg ? ' + ":" + e.message' : ""}));
s.on("close", (h) => { seen.push("close:hadError=" + h); console.log("ORDER " + seen.join(" | ")); process.exit(0); });
setTimeout(() => { console.log("ORDER TIMEOUT " + seen.join(" | ")); process.exit(2); }, 12000);
`;
const DIALS = [
  { name: "refused port: 'error' ECONNREFUSED (Node's message), no 'connect'", port: deadPort, msg: true },
  { name: "unresolvable name: the host's own lookup error code, no 'connect'", port: 80, target: "nonexistent.invalid" },
  { name: "reset after connect: 'connect', then 'error' ECONNRESET", port: RESET_PORT, msg: true },
  { name: "successful dial: remoteAddress/remotePort/family are the relay's real peer", port: ECHO_PORT, msg: true, end: true },
];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vv-net-relay-"));
for (const [i, d] of DIALS.entries()) {
  const file = path.join(tmp, "d" + i + ".js");
  fs.writeFileSync(file, dialSrc({ ...d, host: d.target || "127.0.0.1" }));
  // Async, not execFileSync: the servers these dials reach live in THIS process.
  const hostT = await new Promise((resolve) =>
    execFile(process.execPath, [file], { encoding: "utf8", timeout: 20000 }, (err, stdout) =>
      resolve(err ? "HOST_FAILED " + (stdout || err) : stdout.trim()),
    ),
  );
  kernel.writeFile("/d" + i + ".js", dialSrc({ ...d, host: d.target || "host.vivari.internal" }));
  const r = await kernel.start("node", ["/d" + i + ".js"], { cwd: "/", env, capture: true });
  const vmT = ((r.stdout || "").split("\n").find((l) => l.startsWith("ORDER ")) || "VM_NO_OUTPUT code=" + r.code).trim();
  check(hostT === vmT && hostT.startsWith("ORDER ") && !hostT.includes("TIMEOUT"), d.name);
  if (hostT !== vmT || LIVE) {
    console.log("      host: " + hostT);
    console.log("      vm:   " + vmT);
  }
  if (i === 0) {
    check(!vmT.includes("connect:") && vmT.includes("error:ECONNREFUSED:connect ECONNREFUSED 127.0.0.1:" + deadPort), "…stated outright: ECONNREFUSED and no 'connect'");
  }
}
resetter.close();

// ── gate 3c: relay→VM backpressure — a guest that is not reading stops the sender
// A host server pushes TOTAL bytes as fast as TCP lets it into a guest that
// connects and then does not read for a while. With flow control the relay stops
// reading its socket after a bounded window (32 packets, ≤ 2 MB), so what reaches
// the tab while the guest is paused stays near that window; without it the relay
// swallows everything and forwards it all. Measured at the kernel's relay hook,
// not at the sender: how much the sender manages to flush also depends on the
// host's TCP buffer autotuning, which can be tens of MB. Then the guest reads, and
// every byte must still arrive, in order.
{
  const TOTAL = 48 * 1024 * 1024;
  const CHUNK = 64 * 1024;
  let intoTab = 0;
  let intoTabWhilePaused = -1;
  const hooks = kernel.netRelay.hooks;
  const realOnData = hooks.onData;
  hooks.onData = (id, chunk) => {
    intoTab += chunk.byteLength;
    return realOnData(id, chunk);
  };
  const blast = net.createServer((sock) => {
    sock.on("error", () => {});
    let off = 0;
    const pump = () => {
      while (off < TOTAL) {
        const n = Math.min(CHUNK, TOTAL - off);
        const b = Buffer.alloc(n, (off / CHUNK) & 0xff); // chunk index as the fill byte
        off += n;
        if (!sock.write(b)) return sock.once("drain", pump);
      }
      sock.end();
    };
    pump();
  });
  await new Promise((r) => blast.listen(0, "127.0.0.1", r));
  kernel.writeFile(
    "/slow.js",
    `const net = require("net");
const s = net.connect(${blast.address().port}, "host.vivari.internal", () => {
  s.pause();
  console.log("SLOW paused");
  setTimeout(() => { console.log("SLOW resume"); s.resume(); }, 1500);
});
let got = 0, bad = 0;
s.on("data", (d) => {
  for (let i = 0; i < d.length; i += 4096) if (d[i] !== (((got + i) / ${CHUNK}) & 0xff)) bad++;
  got += d.length;
});
s.on("end", () => { console.log("SLOW got " + got + " bad " + bad); process.exit(0); });
s.on("error", (e) => { console.log("SLOW error " + e.code); process.exit(1); });
setTimeout(() => { console.log("SLOW TIMEOUT got " + got); process.exit(2); }, 60000);
`,
  );
  const slow = kernel.start("node", ["/slow.js"], { cwd: "/", env });
  // Sample 1s into the guest's 1.5s pause: after the resume the transfer runs at
  // full speed, and a sample taken then measures the poll interval, not the window.
  await waitFor(() => has(/SLOW paused/), "the slow reader to connect and pause", 15000).catch(() => {});
  await sleep(1000);
  intoTabWhilePaused = has(/SLOW resume/) ? -1 : intoTab;
  await slow;
  hooks.onData = realOnData;
  blast.close();
  const mb = (n) => (n / 1048576).toFixed(1) + " MB";
  check(
    intoTabWhilePaused > 0 && intoTabWhilePaused <= 8 * 1048576,
    `guest not reading → only ${mb(intoTabWhilePaused)} of ${mb(TOTAL)} reaches the tab (relay stops reading TCP)`,
  );
  check(has(new RegExp("SLOW got " + TOTAL + " bad 0")), `…then the guest reads all ${mb(TOTAL)}, intact and in order`);
}

// ── gate 4: replacing the relay tells a guest its live connection is gone ─────
kernel.writeFile(
  "/held.js",
  `const net = require("net");
const s = net.connect(${ECHO_PORT}, "host.vivari.internal", () => console.log("HELD connected"));
s.on("error", (e) => console.log("HELD error " + e.code));
s.on("close", (h) => { console.log("HELD close hadError=" + h); process.exit(0); });
setTimeout(() => { console.log("HELD TIMEOUT"); process.exit(2); }, 8000);
`,
);
{
  const held = kernel.start("node", ["/held.js"], { cwd: "/", env });
  await waitFor(() => has(/HELD connected/), "the held connection to connect", 8000).catch(() => {});
  kernel.setNetRelay(relayUrl);
  await held;
  check(has(/HELD connected/) && has(/HELD error ECONNRESET/) && has(/HELD close hadError=true/) && !has(/HELD TIMEOUT/), "setNetRelay replacement → the guest's live socket gets 'error' ECONNRESET, then 'close'");
  await waitFor(() => (out.join("").match(boundRe()) || []).length >= 3, "the replacement relay to re-bind :" + PORT, 10000).catch(() => {});
}

// ── gate 5: the relay's access token never reaches a log line ────────────────
// By now the kernel has logged connects, a drop, failed reconnects ("relay
// unreachable at …") and a replacement, i.e. every line that names the relay.
check(/relay unreachable at ws:\/\/127\.0\.0\.1:\d+\/…/.test(out.join("")), "relay log lines name the relay by origin only (ws://host:port/…)");
check(!out.join("").includes(relayInfo.token), "the relay token appears in no kernel log line");

// ── teardown ───────────────────────────────────────────────────────────────────
kernel.stop(kernel.procs.keys().next().value);
await Promise.race([serverExit, sleep(2000)]);
await waitFor(() => releasedRe.test(relayLog.join("")), "relay to release :" + PORT + " when the server process died", 5000).catch(() => {});
check(releasedRe.test(relayLog.join("")), "killing the server process releases the host port on the relay");
echo.close();
relay.proc.kill();

if (LIVE || failed) {
  console.log("\n── kernel/process output ──\n" + out.join("").trim());
  console.log("\n── relay log ──\n" + relayLog.join("").trim());
}
console.log("\nRESULT: " + (failed ? `FAIL (${failed})` : "PASS — relay gives the VM a network in both directions, and nothing changes without it"));
process.exit(failed ? 1 : 0);