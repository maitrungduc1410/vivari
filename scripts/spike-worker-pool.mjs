// Spike (OFFLINE): a worker must be able to receive a MessagePort — the handshake
// every worker POOL is built on.
//
// WHY THIS EXISTS. `new Worker(f, { workerData: { port }, transferList: [port] })` is
// how tinypool (vitest), piscina, and synckit's createSyncFn hand each worker a
// private channel. It threw DataCloneError — "Object that needs transfer was found in
// message but not listed in transferList" — and it threw it in the HOST, inside the
// kernel's spawnWorker, where the guest cannot catch it: the whole run died, or died
// quietly, depending on who was watching.
//
// The cause was duplication. Every environment that hosts processes builds the
// process-worker `init` message itself, because each opens its own channel to the
// File System Worker, and there were 36 hand-written copies of the transfer list.
// The browser kernel's copy scanned workerData for ports; the 35 in scripts/ did not.
// `initTransferList` (packages/kernel-host/worker-transfer.js) is now the single
// answer, and this spike is what keeps it answering.
//
// HOW IT IS GATED. Each case runs on the HOST's real Node and in the VM and the
// transcripts must be identical. These are worker_threads semantics, not ours to
// define, and the interesting cases (a port nested two levels down, two ports at
// once, a port sent back the other way) are exactly the ones a hand-written
// expectation would get subtly wrong.
//
//   run:  node scripts/spike-worker-pool.mjs

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

// The worker half. It answers on whichever port it was given, so the parent can tell
// a delivered port from a dropped one.
const WORKER = `
const { workerData, parentPort } = require('worker_threads');
const found = [];
const scan = (v, trail, depth) => {
  if (!v || typeof v !== 'object' || depth > 4) return;
  if (typeof v.postMessage === 'function' && typeof v.on === 'function') { found.push([trail, v]); return; }
  for (const k of Object.keys(v)) scan(v[k], trail ? trail + '.' + k : k, depth + 1);
};
scan(workerData, '', 0);
parentPort.postMessage('ports:' + found.map(([t]) => t).join(',') || 'ports:');
for (const [trail, port] of found) {
  port.on('message', (m) => port.postMessage('echo[' + trail + ']:' + m));
  port.postMessage('ready[' + trail + ']');
}
`;

const GUEST = String.raw`
const { Worker, MessageChannel } = require('worker_threads');
const out = [];
const say = (s) => out.push(s);

const runCase = (name, makeWorkerData, expectPorts) =>
  new Promise((resolve) => {
    const channels = [];
    const mkPort = () => {
      const { port1, port2 } = new MessageChannel();
      channels.push(port1);
      return port2;
    };
    let workerData, transferList;
    try {
      ({ workerData, transferList } = makeWorkerData(mkPort));
    } catch (e) {
      say(name + ' SETUP THREW ' + e.name);
      return resolve();
    }

    const seen = [];
    let settled = false;
    const done = (verdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { w.terminate(); } catch {}
      for (const p of channels) { try { p.close(); } catch {} }
      say(name + ' ' + verdict);
      resolve();
    };
    const timer = setTimeout(() => done('TIMED OUT after ' + JSON.stringify(seen)), 4000);

    let w;
    try {
      w = new Worker(WORKER_PATH, { workerData, transferList });
    } catch (e) {
      return done('SPAWN THREW ' + e.name + ': ' + e.message);
    }
    w.on('error', (e) => done('WORKER ERROR ' + e.message));
    w.on('message', (m) => {
      if (String(m).startsWith('ports:')) {
        seen.push(String(m));
        // With no ports to hand back there is no echo to wait for, so this message IS
        // the end of the case. It used to end on a 300ms timer instead, which is thin
        // for booting a whole runtime in a Worker: under parallel load 'ports:' arrived
        // after the deadline and the case reported a truthful-looking "ok" with the
        // evidence missing. It was the only case in the file ending on a clock.
        if (expectPorts === 0) done('ok ' + seen.sort().join(' '));
      }
    });
    let echoes = 0;
    for (const p of channels) {
      p.on('message', (m) => {
        const s = String(m);
        if (s.startsWith('ready[')) { seen.push(s); p.postMessage('hi'); }
        if (s.startsWith('echo[')) {
          seen.push(s);
          if (++echoes === expectPorts) done('ok ' + seen.sort().join(' '));
        }
      });
    }
  });

(async () => {
  // The plain case: one port, one level down. tinypool's handshake.
  await runCase('one-port', (mk) => {
    const p = mk();
    return { workerData: { port: p }, transferList: [p] };
  }, 1);

  // Two workers' worth of ports in one message.
  await runCase('two-ports', (mk) => {
    const a = mk(), b = mk();
    return { workerData: { a, b }, transferList: [a, b] };
  }, 2);

  // Nested, because workerData is user data and nobody promised it would be flat.
  await runCase('nested-port', (mk) => {
    const p = mk();
    return { workerData: { pool: { channels: [{ port: p }] } }, transferList: [p] };
  }, 1);

  // A port alongside ordinary data, which must still arrive intact.
  await runCase('port-with-data', (mk) => {
    const p = mk();
    return { workerData: { port: p, name: 'w1', n: 7 }, transferList: [p] };
  }, 1);

  // No port at all: the case that always worked, kept so a fix cannot regress it.
  await runCase('no-port', () => ({ workerData: { plain: true }, transferList: [] }), 0);

  for (const line of out) console.log('CASE ' + line);
})();
`;

// ── the host's real Node ─────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vv-worker-pool-"));
const hostWorker = path.join(tmp, "worker.js");
const hostGuest = path.join(tmp, "guest.js");
fs.writeFileSync(hostWorker, WORKER);
fs.writeFileSync(hostGuest, `const WORKER_PATH = ${JSON.stringify(hostWorker)};\n` + GUEST);

let hostRaw = "";
try {
  hostRaw = execFileSync(process.execPath, [hostGuest], { encoding: "utf8", timeout: 60000 });
} catch (e) {
  hostRaw = "HOST_FAILED: " + ((e && e.stderr) || e);
}
const lines = (raw) =>
  raw
    .split("\n")
    .filter((l) => l.startsWith("CASE "))
    .map((l) => l.slice(5).trim());
const hostCases = lines(hostRaw);

// ── and the VM ───────────────────────────────────────────────────────────────
const h = await bootSpikeKernel();
writeProject(h.kernel, "/t", {
  "worker.js": WORKER,
  "guest.js": `const WORKER_PATH = "/t/worker.js";\n` + GUEST,
});
const r = await h.kernel.start("node", ["/t/guest.js"], { cwd: "/t", capture: true });
const vmCases = lines(r.stdout || "");

if (!hostCases.length) {
  console.log("  ✗ the host produced no transcript — the gate cannot judge anything");
  console.log(hostRaw.slice(0, 2000));
  process.exit(1);
}
if (!vmCases.length) {
  console.log(`  ✗ the VM produced no transcript (exit ${r.code})`);
  console.log((r.stderr || "").split("\n").slice(0, 12).join("\n"));
  process.exit(1);
}

const byName = (cases) =>
  new Map(
    cases.map((l) => {
      const name = l.split(" ")[0];
      return [name, l.slice(name.length + 1)];
    }),
  );
const hostByName = byName(hostCases);
const vmByName = byName(vmCases);

console.log(`worker pool ports: ${hostByName.size} cases on the host, ${vmByName.size} in the VM`);

for (const [name, hostLine] of hostByName) {
  const vmLine = vmByName.get(name);
  if (vmLine === undefined) {
    ok(false, `${name}: the VM produced no line for a case the host ran`);
    continue;
  }
  if (hostLine === vmLine) {
    ok(true, `${name}: ${hostLine.length > 70 ? hostLine.slice(0, 70) + "…" : hostLine}`);
  } else {
    ok(false, name);
    console.log(`      host: ${hostLine}`);
    console.log(`      vm:   ${vmLine}`);
  }
}
for (const name of vmByName.keys()) {
  if (!hostByName.has(name)) ok(false, `${name}: the VM produced a line the host did not`);
}

console.log(failed === 0 ? "\nworker pool ports: OK" : `\nworker pool ports: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
