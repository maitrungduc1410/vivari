// Spike (OFFLINE): a socket's 'close' must arrive AFTER its 'error', because
// `http` reads the order and reports a different failure if it is wrong.
//
// WHY THIS EXISTS. Dialling a port nobody listens on reported
// `ECONNRESET "socket hang up"` and then emitted the real `ECONNREFUSED` as a
// SECOND 'error' on a request Node guarantees emits one. Neither symptom points
// at the cause: `Socket._destroy` queues the 'close' emit via `handle.close(cb)`
// and only then calls `cb(exception)`, where the stream emits 'error'. Both landed
// in the nextTick queue in that order, so close won; libuv runs close callbacks in
// a later phase, so in Node error wins. `_http_client.socketCloseListener` then
// saw a close with no error recorded and synthesised the reset.
//
// It hid behind a second bug for a long time. verify-node.mjs asserted
// ECONNREFUSED inside the 'error' handler and passed, because the assertion failed
// on the phantom first error, an uncaught throw in a callback was silently
// swallowed back then, and the real ECONNREFUSED arrived afterwards and satisfied
// the retry. Once uncaught errors became fatal the phantom killed the process and
// the check went red — the bug was years old, the redness was one commit old.
//
// HOW IT IS GATED. Each scenario below runs BOTH on the host's real Node and in
// the VM, and the two transcripts must be identical. Asserting a hand-written
// expectation would only pin today's belief about Node; running Node is the
// oracle. Explicit invariants follow the comparison anyway, so a future Node that
// changes its own ordering fails loudly here instead of silently redefining
// "correct".
//
//   run:  node scripts/spike-net-close-order.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootSpikeKernel, writeProject } from "./lib/spike-harness.mjs";

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};

// A port nothing listens on, in the VM and on the host alike. The same one
// verify-node.mjs uses, so both gates fail together if the assumption ever breaks.
const DEAD_PORT = 65531;

const SCENARIOS = [
  {
    name: "http.request to a dead port: one error, ECONNREFUSED, before close",
    src: `const http = require('http');
const seen = [];
const req = http.request({ host: '127.0.0.1', port: ${DEAD_PORT}, path: '/', agent: false });
req.on('response', () => seen.push('response'));
req.on('error', (e) => seen.push('req.error:' + e.code + ':' + e.message));
req.on('socket', (s) => {
  s.on('error', (e) => seen.push('sock.error:' + e.code));
  s.on('close', (h) => seen.push('sock.close:hadError=' + h));
});
req.end();
setTimeout(() => console.log('ORDER ' + seen.join(' | ')), 250);
`,
  },
  {
    name: "net.connect to a dead port: error then close, hadError=true",
    src: `const net = require('net');
const seen = [];
const s = net.connect({ host: '127.0.0.1', port: ${DEAD_PORT} });
s.on('connect', () => seen.push('connect'));
s.on('error', (e) => seen.push('error:' + e.code));
s.on('close', (h) => seen.push('close:hadError=' + h));
setTimeout(() => console.log('ORDER ' + seen.join(' | ')), 250);
`,
  },
  {
    name: "the close phase runs after nextTick and after setImmediate",
    src: `const net = require('net');
const seen = [];
const s = net.connect({ host: '127.0.0.1', port: ${DEAD_PORT} });
s.on('error', () => {
  // Scheduled from the error handler, i.e. from inside the nextTick drain that
  // the pending close callback must NOT be part of.
  process.nextTick(() => seen.push('nextTick'));
  setImmediate(() => seen.push('setImmediate'));
  seen.push('error');
});
s.on('close', () => seen.push('close'));
setTimeout(() => console.log('ORDER ' + seen.join(' | ')), 250);
`,
  },
  {
    name: "a destroyed live socket still emits error before close",
    src: `const net = require('net');
const seen = [];
const server = net.createServer((c) => { c.on('error', () => {}); });
server.listen(0, '127.0.0.1', () => {
  const s = net.connect({ host: '127.0.0.1', port: server.address().port }, () => {
    s.destroy(new Error('deliberate'));
  });
  s.on('error', (e) => seen.push('error:' + e.message));
  s.on('close', (h) => seen.push('close:hadError=' + h));
  setTimeout(() => { console.log('ORDER ' + seen.join(' | ')); server.close(); }, 250);
});
`,
  },
  {
    name: "server.close(cb): the callback and the 'close' event both fire, in order",
    src: `const net = require('net');
const seen = [];
const server = net.createServer(() => {});
server.on('close', () => seen.push('event:close'));
server.listen(0, '127.0.0.1', () => {
  server.close(() => seen.push('cb'));
  process.nextTick(() => seen.push('nextTick'));
  setTimeout(() => console.log('ORDER ' + seen.join(' | ')), 250);
});
`,
  },
  {
    name: "a socket closed cleanly reports hadError=false and emits no error",
    src: `const net = require('net');
const seen = [];
const server = net.createServer((c) => c.end());
server.listen(0, '127.0.0.1', () => {
  const s = net.connect({ host: '127.0.0.1', port: server.address().port });
  s.on('error', (e) => seen.push('error:' + e.code));
  s.on('end', () => seen.push('end'));
  s.on('close', (h) => seen.push('close:hadError=' + h));
  setTimeout(() => { console.log('ORDER ' + seen.join(' | ')); server.close(); }, 250);
});
`,
  },
];

// ── run each scenario on the host's real Node ────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vv-close-order-"));
const hostOut = [];
for (const [i, s] of SCENARIOS.entries()) {
  const file = path.join(tmp, `s${i}.js`);
  fs.writeFileSync(file, s.src);
  let out = "";
  try {
    out = execFileSync(process.execPath, [file], { encoding: "utf8", timeout: 20000 }).trim();
  } catch (e) {
    out = "HOST_FAILED: " + ((e && e.stderr) || e);
  }
  hostOut.push(out);
}

// ── and in the VM ────────────────────────────────────────────────────────────
const h = await bootSpikeKernel();
const DIR = "/t";
const files = {};
for (const [i, s] of SCENARIOS.entries()) files[`s${i}.js`] = s.src;
writeProject(h.kernel, DIR, files);

const vmOut = [];
for (const [i] of SCENARIOS.entries()) {
  const r = await h.kernel.start("node", [`${DIR}/s${i}.js`], { cwd: DIR, capture: true });
  const line = (r.stdout || "").split("\n").find((l) => l.startsWith("ORDER "));
  vmOut.push(line ? line.trim() : `VM_NO_OUTPUT (code=${r.code}) ${(r.stderr || "").split("\n")[0]}`);
}

console.log("== the VM's transcript matches real Node's, scenario by scenario ==");
for (const [i, s] of SCENARIOS.entries()) {
  const same = hostOut[i] === vmOut[i] && hostOut[i].startsWith("ORDER ");
  ok(same, s.name);
  if (!same) {
    console.log("      host: " + hostOut[i]);
    console.log("      vm:   " + vmOut[i]);
  }
}

// ── the invariants themselves, so a drifting host Node cannot redefine them ──
console.log("\n== the invariants, stated outright ==");
{
  const t = vmOut[0];
  const errors = (t.match(/req\.error:/g) || []).length;
  ok(errors === 1, `a refused http request emits exactly one 'error' (got ${errors})`);
  ok(
    t.includes("req.error:ECONNREFUSED:connect ECONNREFUSED 127.0.0.1:" + DEAD_PORT),
    "…and it is ECONNREFUSED, with Node's message",
  );
  ok(!t.includes("ECONNRESET") && !t.includes("socket hang up"), "…and no phantom 'socket hang up' precedes it");
  ok(!t.includes("response"), "…and no response event is emitted");
}
{
  const t = vmOut[1];
  ok(
    t.indexOf("error:ECONNREFUSED") < t.indexOf("close:") && t.includes("error:ECONNREFUSED"),
    "a refused socket emits 'error' BEFORE 'close' — the ordering http depends on",
  );
  ok(t.includes("close:hadError=true"), "…and the close reports hadError=true");
}
{
  const t = vmOut[2];
  const at = (k) => t.indexOf(k);
  ok(at("nextTick") < at("close"), "a nextTick queued during the error handler runs before 'close'");
  ok(at("setImmediate") < at("close"), "…and so does a setImmediate, as libuv orders check before close");
}
{
  const t = vmOut[4];
  ok(t.includes("cb") && t.includes("event:close"), "server.close(cb) fires the callback and the 'close' event");
  // `Server.close` registers cb with `once('close', cb)`, so it is simply a later
  // 'close' listener — not a separate mechanism, and not the handle's close
  // callback. Worth pinning, because moving handle closes to their own phase could
  // plausibly have reordered these and did not.
  ok(t.indexOf("event:close") < t.indexOf("cb"), "…in that order, cb being the last-registered 'close' listener");
}
{
  ok(vmOut[5].includes("close:hadError=false"), "a clean close is not reported as an error");
  ok(!vmOut[5].includes("error:"), "…and emits no 'error' at all");
}

// A pending close callback must keep the loop alive, or the 'close' event would be
// owed to a process that already exited. Every scenario above ends on a timer, so
// this is the one case they cannot show.
console.log("\n== a pending close callback keeps the process alive ==");
{
  writeProject(h.kernel, DIR, {
    "live.js": `const net = require('net');
const s = net.connect({ host: '127.0.0.1', port: ${DEAD_PORT} });
s.on('error', () => {});
// No timer, no other handle: only the queued close callback can carry this to
// the 'close' event. If the loop exits first, nothing is printed.
s.on('close', () => console.log('CLOSE_ARRIVED'));
`,
  });
  const r = await h.kernel.start("node", [`${DIR}/live.js`], { cwd: DIR, capture: true });
  ok(r.code === 0, `the process exits 0 (got ${r.code})`);
  ok((r.stdout || "").includes("CLOSE_ARRIVED"), "'close' is delivered with no timer holding the loop open");
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* scratch */
}

console.log(
  `\nRESULT: ${failed === 0 ? "PASS — socket close ordering matches real Node" : `FAIL — ${failed} check(s)`}`,
);
process.exit(failed === 0 ? 0 : 1);
