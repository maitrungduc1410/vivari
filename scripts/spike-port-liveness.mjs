// Spike (OFFLINE): a listening MessagePort keeps the process alive, and ref()
// keeps it alive with nobody listening at all.
//
// WHY THIS EXISTS. `vitest run` exited 0 in 1.1 seconds having run no tests and
// printed nothing — the worst possible failure, because zero is indistinguishable
// from success and there is no output to read. Two earlier passes at it guessed
// (both times at Worker.unref()) and both guesses fit the symptom without being
// the cause.
//
// The cause was a port with no listener on it. `@emnapi/runtime` — under
// @napi-rs/wasm-runtime, under rolldown's wasm32-wasi binding, under Vite 8,
// under vitest — keeps Node alive across a native async request with:
//
//     this.refHandle = new MessageChannel().port1
//     increase() { if (this.count === 0) this.refHandle.ref(); this.count++ }
//     decrease() { if (this.count === 1) this.refHandle.unref(); this.count-- }
//
// Nothing is ever posted to that port and nothing ever listens. It is a handle,
// held and released, and Node's loop counts it. Ours had `ref()`/`unref()` as
// `return this` — so the counter counted nothing, the loop went idle mid-request,
// and the process left while rolldown was still loading.
//
// So the rule this pins is Node's, in both halves: a port holds the loop while it
// is REF'D — by an explicit ref() or by having a 'message' listener — and stops
// when unref'd, when the last listener goes, or when it closes. The ordering
// cases are here because they are the ones that look like contradictions:
// unref() then listen WAITS (listening re-refs), listen then unref() LEAVES.
//
// Every case is run against the host's real Node and compared line for line: the
// whole failure mode was a plausible-looking model that nobody had checked.
//
//   run:  node scripts/spike-port-liveness.mjs

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

// Each case is its own process: what is being measured is whether the process
// EXITS, which can only be observed once. Every one prints 'EXIT <code>' last,
// so a case that ends early is visible as a missing line rather than as silence.
const CASES = {
  // A listening port waits for the message, like any open handle.
  "listen": `const { MessageChannel } = require('worker_threads');
const { port1, port2 } = new MessageChannel();
port1.on('message', (m) => { console.log('got', m); port1.close(); });
setTimeout(() => port2.postMessage('hi'), 300);`,

  // …and stops waiting when the last listener is removed, mid-callback.
  "removeListener-in-handler": `const { MessageChannel } = require('worker_threads');
const { port1, port2 } = new MessageChannel();
const h = (m) => { console.log('got', m); port1.removeListener('message', h); };
port1.on('message', h);
setTimeout(() => port2.postMessage('hi'), 300);`,

  // A port nobody listens to holds nothing.
  "no-listener": `const { MessageChannel } = require('worker_threads');
const { port1, port2 } = new MessageChannel();
setTimeout(() => port2.postMessage('never heard'), 300);
console.log('no listener');`,

  // The @emnapi/runtime shape: ref() with nothing listening, then unref().
  "ref-without-listener": `const { MessageChannel } = require('worker_threads');
const { port1 } = new MessageChannel();
port1.ref();
const t = setTimeout(() => { console.log('still alive'); port1.unref(); }, 300);
t.unref();`,

  // …and the same hold released by close() instead.
  "ref-then-close": `const { MessageChannel } = require('worker_threads');
const { port1 } = new MessageChannel();
port1.ref();
const t = setTimeout(() => { console.log('still alive'); port1.close(); }, 300);
t.unref();`,

  // The two orderings. Listening starts the port, and starting refs it, so a
  // listener attached AFTER unref() takes a fresh hold.
  "unref-then-listen": `const { MessageChannel } = require('worker_threads');
const { port1, port2 } = new MessageChannel();
port1.unref();
port1.on('message', (m) => { console.log('got', m); port1.close(); });
const t = setTimeout(() => port2.postMessage('hi'), 300); t.unref();`,

  "listen-then-unref": `const { MessageChannel } = require('worker_threads');
const { port1, port2 } = new MessageChannel();
port1.on('message', (m) => console.log('got', m));
port1.unref();
const t = setTimeout(() => port2.postMessage('hi'), 300); t.unref();`,

  // A Worker owns a port too, and it obeys the same two orderings.
  "worker-unref-then-listen": `const { Worker } = require('worker_threads');
const w = new Worker('./reply.js');
w.unref();
w.on('message', (m) => console.log('got', m));`,

  "worker-listen-then-unref": `const { Worker } = require('worker_threads');
const w = new Worker('./reply.js');
w.on('message', (m) => console.log('got', m));
w.unref();`,
};

const REPLY = `const { parentPort } = require('worker_threads');
setTimeout(() => parentPort.postMessage('hi'), 300);`;

const files = { "reply.js": REPLY };
for (const [name, body] of Object.entries(CASES)) {
  files[name + ".js"] = body + "\nprocess.on('exit', (c) => console.log('EXIT ' + c));\n";
}

// ── the host's real Node ─────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vv-port-live-"));
for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(tmp, n), b);
const runHost = (file) => {
  try {
    return execFileSync(process.execPath, [file], { cwd: tmp, encoding: "utf8", timeout: 20000 }).trim();
  } catch (e) {
    return ((e.stdout || "") + " HOST-FAILED " + String(e.message).slice(0, 120)).trim();
  }
};

// ── and the VM ───────────────────────────────────────────────────────────────
const h = await bootSpikeKernel();
writeProject(h.kernel, "/app", files);
// A case that never exits is the bug this spike is for, so it must be reported
// as one rather than hanging the run: the timeout stands in for the exit line.
const runVm = async (file) => {
  const r = await Promise.race([
    h.kernel.start("node", [file], { cwd: "/app", capture: true }),
    new Promise((res) => setTimeout(() => res({ stdout: "TIMED-OUT (never exited)" }), 15000)),
  ]);
  return String(r.stdout || "").trim();
};

console.log("MessagePort liveness — the VM against the host, case by case:\n");
for (const name of Object.keys(CASES)) {
  const file = name + ".js";
  const host = runHost(file);
  const vm = await runVm(file);
  const same = host === vm;
  ok(same, `${name} — ${host.split("\n").join(" | ")}`);
  if (!same) console.log(`      host: ${JSON.stringify(host)}\n      vm:   ${JSON.stringify(vm)}`);
}

// The one place we do NOT copy Node, on purpose and with the measurement to
// hand. Removing the LAST 'message' listener releases the port on Node (the case
// above), but removeAllListeners('message') does not: Node keeps the handle and
// the process hangs — measured on Node 22, `rc=124` under a 3s timeout. The two
// calls remove the same listener and leave the same port in the same state, so
// only one of the two answers can be the intended one, and it is not the hang.
// We release in both, which can only turn a hang into an exit; the reverse
// (hanging where Node exits) is the direction that breaks programs.
console.log("\nthe deliberate divergence:");
{
  const file = "removeAllListeners-in-handler.js";
  fs.writeFileSync(
    path.join(tmp, file),
    `const { MessageChannel } = require('worker_threads');
const { port1, port2 } = new MessageChannel();
port1.on('message', (m) => { console.log('got', m); port1.removeAllListeners('message'); });
setTimeout(() => port2.postMessage('hi'), 300);
process.on('exit', (c) => console.log('EXIT ' + c));
`,
  );
  h.kernel.writeFile("/app/" + file, fs.readFileSync(path.join(tmp, file), "utf8"));
  const host = runHost(file);
  const vm = await runVm(file);
  ok(/HOST-FAILED/.test(host) && !/EXIT/.test(host), `Node hangs after removeAllListeners('message') — ${host.split("\n")[0]}`);
  ok(vm === "got hi\nEXIT 0", `…and we exit instead — ${JSON.stringify(vm)}`);
}

console.log(failed === 0 ? "\nPASS: port liveness matches Node." : `\nFAIL: ${failed} case(s) differ`);
process.exit(failed === 0 ? 0 : 1);
