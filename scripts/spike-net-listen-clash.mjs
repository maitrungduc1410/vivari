// Spike (OFFLINE): a listen() that fails with EADDRINUSE must not take the port
// away from the server that actually holds it.
//
// WHY THIS EXISTS. TCP.close() on a server handle deleted the port's entry from
// the process-wide `listeners` map without checking the entry was its own. A
// second listen() on a taken port returns EADDRINUSE before it registers, and
// lib/net.js then closes that handle — so the FAILED listen evicted the REAL
// server. The kernel registration survived, so nothing looked wrong: the port
// kept serving in-VM callers in other processes. What broke was every dial from
// the owning process itself, including bridgeHttp, which is how a browser request
// (Service Worker / kernel.handleHttpRequest) reaches the server. That dial fell
// through to the cross-process pipe relay and came back into the same process,
// where the client end and the accepted end share one connId — so the response
// was delivered to the server's own endpoint and the request hung. A library that
// probes a port by listening on it and handling EADDRINUSE is enough to trigger it.
//
// HOW IT IS GATED. The in-process scenario runs on the host's real Node AND in the
// VM and the transcripts must match. The two VM-only checks (the browser path and
// a second process) are bounded, because the failure they guard is a hang.
//
//   run:  node scripts/spike-net-listen-clash.mjs

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootSpikeKernel, writeProject } from "./lib/spike-harness.mjs";

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};

// The VM's port. The VM network is virtual, so this never touches the host; the
// host run takes a port the OS hands out instead (see freeHostPort below).
const PORT = 39171;

// Server A holds `port`; server B tries the same port, gets EADDRINUSE and is
// closed by lib/net.js. A same-process request must still reach A. The port is
// not in the transcript, so the host and the VM runs compare on the events alone.
const clashSrc = (port) => `const http = require('http');
const seen = [];
const a = http.createServer((req, res) => res.end('A'));
a.listen(${port}, '127.0.0.1', () => {
  const b = http.createServer(() => {});
  b.on('error', (e) => {
    seen.push('b.error:' + e.code);
    http.get({ host: '127.0.0.1', port: ${port}, path: '/', agent: false }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        seen.push('get:' + res.statusCode + ':' + body);
        console.log('ORDER ' + seen.join(' | '));
        if (process.env.VV_KEEP) console.log('READY'); else a.close();
      });
    }).on('error', (e) => { seen.push('get.error:' + e.code); console.log('ORDER ' + seen.join(' | ')); a.close(); });
  });
  b.listen(${port}, '127.0.0.1');
});
setTimeout(() => { console.log('ORDER ' + seen.join(' | ') + ' | TIMEOUT'); process.exit(1); }, 8000).unref();
`;

const CLIENT = `const http = require('http');
http.get({ host: '127.0.0.1', port: ${PORT}, path: '/', agent: false }, (res) => {
  let body = '';
  res.on('data', (d) => (body += d));
  res.on('end', () => { console.log('CLIENT ' + res.statusCode + ':' + body); process.exit(0); });
}).on('error', (e) => { console.log('CLIENT error:' + e.code); process.exit(1); });
setTimeout(() => { console.log('CLIENT TIMEOUT'); process.exit(2); }, 5000);
`;

// ── on the host's real Node ────────────────────────────────────────────────
// A fixed port would fail this run whenever something on the CI machine holds it,
// so ask the OS for one that is free right now.
const freeHostPort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vv-listen-clash-"));
fs.writeFileSync(path.join(tmp, "clash.js"), clashSrc(await freeHostPort()));
let hostOut = "";
try {
  hostOut = execFileSync(process.execPath, [path.join(tmp, "clash.js")], { encoding: "utf8", timeout: 20000 }).trim();
} catch (e) {
  hostOut = "HOST_FAILED: " + ((e && e.stdout) || e);
}
const hostLine = hostOut.split("\n").find((l) => l.startsWith("ORDER ")) || hostOut;

// ── in the VM ──────────────────────────────────────────────────────────────
const h = await bootSpikeKernel();
const DIR = "/t";
writeProject(h.kernel, DIR, { "clash.js": clashSrc(PORT), "client.js": CLIENT });

console.log("== the VM's transcript matches real Node's ==");
{
  const r = await h.kernel.start("node", [`${DIR}/clash.js`], { cwd: DIR, capture: true });
  const vmLine = (r.stdout || "").split("\n").find((l) => l.startsWith("ORDER ")) || `VM_NO_OUTPUT (code=${r.code})`;
  ok(hostLine === vmLine && hostLine.startsWith("ORDER "), "a same-process request after an EADDRINUSE clash still reaches the real server");
  if (hostLine !== vmLine) {
    console.log("      host: " + hostLine);
    console.log("      vm:   " + vmLine);
  }
  ok(vmLine.includes("b.error:EADDRINUSE") && vmLine.includes("get:200:A"), "…the clash is reported as EADDRINUSE and A answers 200");
}

console.log("\n== the paths real Node has no equivalent of ==");
{
  const outStart = h.out.length;
  h.kernel.start("node", [`${DIR}/clash.js`], { cwd: DIR, env: { VV_KEEP: "1" } });
  const t0 = Date.now();
  while (!h.out.slice(outStart).join("").includes("READY") && Date.now() - t0 < 20000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  ok(h.out.slice(outStart).join("").includes("READY"), "the clashing server process is up and holding the port");

  const bounded = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r({ status: "TIMEOUT" }), ms))]);
  const res = await bounded(
    h.kernel.handleHttpRequest(PORT, { port: PORT, method: "GET", url: "/", headers: { host: "127.0.0.1:" + PORT }, body: "" }),
    5000,
  );
  const body = res.body ? (typeof res.body === "string" ? res.body : Buffer.from(res.body).toString()) : "";
  ok(res.status === 200 && body === "A", `the browser path (handleHttpRequest) still reaches A after the clash (got ${res.status} ${JSON.stringify(body)})`);

  const c = await bounded(h.kernel.start("node", [`${DIR}/client.js`], { cwd: DIR, capture: true }), 10000);
  ok(/CLIENT 200:A/.test((c && c.stdout) || ""), "a second VM process still reaches A");
}

console.log("\nRESULT: " + (failed ? `FAIL (${failed})` : "PASS — a failed listen leaves the port with its real owner"));
process.exit(failed ? 1 : 0);