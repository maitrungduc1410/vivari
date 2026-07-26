// Headless proof for the breakpoint debugger (offline tier — no network).
//
// Exercises the in-guest CDP Debugger backend (packages/runtime/debugger.js) +
// the source instrumenter (packages/runtime/instrument.js) directly, with a
// synchronous in-process transport standing in for the SharedArrayBuffer command
// channel used in the real Process Worker. It proves the full pause loop:
// breakpoint hit → Debugger.paused with a real call stack → evaluate-on-call-frame
// in the paused scope → Runtime.getProperties on the Local scope → step over →
// resume, plus a conditional breakpoint and a `debugger;` statement.
//
// Run: node scripts/spike-debugger.mjs

import { Worker } from "node:worker_threads";
import { createDebugger } from "../packages/runtime/debugger.js";
import {
  DBG_SAB_BYTES,
  makeDebugViews,
  writeDebugCommand,
  DBG_STATE_EMPTY,
} from "../packages/protocol/debug.js";

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok  " + msg);
  else {
    failures++;
    console.error(" FAIL " + msg);
  }
}

// ── transport: events collected; commands pulled from a scripted queue ────────
// A queued entry may be a plain command, or a FUNCTION (given the last paused
// event) that returns a command — so a test can react to the live pause (e.g. read
// the just-emitted Local scope objectId). When the queue drains we resume, so the
// guest never wedges (mirrors the runtime's fail-open behaviour).
const events = [];
const responses = new Map(); // id -> {id,result} | {id,error}
let cmdQueue = [];
let cmdSeq = 0;
const lastPaused = () => [...events].reverse().find((e) => e.method === "Debugger.paused");

const dbg = createDebugger({
  send: (msg) => {
    if (msg.method) events.push(msg);
    else if (msg.id != null) responses.set(msg.id, msg);
  },
  waitForCommand: () => {
    let next = cmdQueue.shift();
    if (typeof next === "function") next = next(lastPaused());
    return next || { id: ++cmdSeq, method: "Debugger.resume", params: {} };
  },
});
globalThis.__vvdbg = dbg.__vvdbg;

const clearEvents = () => (events.length = 0);
const cmd = (method, params) => {
  const id = ++cmdSeq;
  dbg.onCommand({ id, method, params: params || {} });
  return id;
};
const queue = (method, params) => cmdQueue.push({ id: ++cmdSeq, method, params: params || {} });

// ── the program under test ────────────────────────────────────────────────────
const FILE = "/home/user/app.js";
const SRC = `function compute(a, b) {
  const sum = a + b;
  const scaled = sum * 10;
  return scaled;
}
function loop(n) {
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += i;
  }
  return acc;
}
const r1 = compute(3, 4);
const r2 = loop(5);
debugger;
globalThis.__spikeResult = { r1, r2 };
`;

const woven = dbg.instrument(SRC, FILE, { isModule: false });
assert(woven !== SRC, "source was instrumented");
assert(woven.includes("__vvdbg.push"), "function frames woven in");

cmd("Runtime.enable");
cmd("Debugger.enable");
assert(events.some((e) => e.method === "Debugger.scriptParsed"), "scriptParsed emitted on enable");

// Breakpoint on `const scaled = sum * 10;` (line 3 → 0-based 2).
const bpId = cmd("Debugger.setBreakpointByUrl", { url: "file://" + FILE, lineNumber: 2 });
const bpResp = responses.get(bpId);
assert(bpResp && bpResp.result.breakpointId, "setBreakpointByUrl returned a breakpointId");
assert(bpResp.result.locations[0] && bpResp.result.locations[0].lineNumber === 2, "breakpoint bound to line 3");

// Conditional breakpoint inside the loop: `acc += i;` (line 9 → 0-based 8) when i === 3.
cmd("Debugger.setBreakpointByUrl", { url: "file://" + FILE, lineNumber: 8, condition: "i === 3" });

// Script the pauses:
//   #1 compute breakpoint: eval `sum`, read Local scope props, step over, resume.
const evalId = ++cmdSeq;
cmdQueue.push({ id: evalId, method: "Debugger.evaluateOnCallFrame", params: { callFrameId: "cf:0", expression: "sum" } });
const gpId = ++cmdSeq;
cmdQueue.push((p) => ({
  id: gpId,
  method: "Runtime.getProperties",
  params: { objectId: p.params.callFrames[0].scopeChain[0].object.objectId, ownProperties: true },
}));
queue("Debugger.stepOver"); // pauses again on `return scaled` (line 4)
queue("Debugger.resume");
//   #2 conditional breakpoint (i===3): eval `i`, resume.
const condEvalId = ++cmdSeq;
cmdQueue.push({ id: condEvalId, method: "Debugger.evaluateOnCallFrame", params: { callFrameId: "cf:0", expression: "i" } });
queue("Debugger.resume");
//   #3 `debugger;` statement: resume.
queue("Debugger.resume");

clearEvents();
new Function(woven)();

// ── assertions ────────────────────────────────────────────────────────────────
const pausedEvents = events.filter((e) => e.method === "Debugger.paused");
assert(pausedEvents.length === 4, `paused four times: 2 breakpoints + 1 step + debugger (got ${pausedEvents.length})`);

const p1 = pausedEvents[0];
assert(p1.params.reason === "breakpoint", "pause #1 reason is breakpoint");
assert(p1.params.callFrames[0].functionName === "compute", "pause #1 top frame is compute()");
assert(p1.params.callFrames[0].location.lineNumber === 2, "pause #1 at line 3");
assert(p1.params.callFrames[0].scopeChain[0].type === "local", "pause #1 exposes a Local scope");

const evalResp = responses.get(evalId);
assert(evalResp && evalResp.result.result.value === 7, "evaluateOnCallFrame('sum') === 7 in the paused frame");

const gpResp = responses.get(gpId);
const localNames = gpResp ? gpResp.result.result.map((p) => p.name).sort() : [];
// `scaled` is in TDZ at line 3 (not yet initialised), so it is correctly absent.
assert(localNames.join(",") === "a,b,sum", `Local scope lists a,b,sum (scaled still in TDZ) (got ${localNames.join(",")})`);
const sumProp = gpResp && gpResp.result.result.find((p) => p.name === "sum");
assert(sumProp && sumProp.value.value === 7, "Local scope shows sum === 7");

const stepPause = pausedEvents[1];
assert(stepPause.params.reason === "step", "pause #2 (after stepOver) reason is step");
assert(stepPause.params.callFrames[0].location.lineNumber === 3, "stepOver landed on `return scaled` (line 4)");

const condPause = pausedEvents[2];
const condResp = responses.get(condEvalId);
assert(condResp && condResp.result.result.value === 3, "conditional breakpoint fired exactly when i === 3");

const dbgPause = pausedEvents[3];
assert(dbgPause.params.callFrames.length >= 1, "`debugger;` at top level still yields a call frame");
assert(dbgPause.params.callFrames[0].functionName === "(module)", "`debugger;` top frame is the module scope");
assert(dbgPause.params.callFrames[0].location.lineNumber === 14, "`debugger;` paused on line 15");

assert(
  globalThis.__spikeResult && globalThis.__spikeResult.r1 === 70 && globalThis.__spikeResult.r2 === 10,
  "program produced correct results after debugging (r1=70, r2=10)",
);

// ── the debug-command SharedArrayBuffer channel (real Atomics across a worker) ──
// Proves protocol/debug.js: the kernel side writes commands; a parked worker reads
// them via a blocking Atomics.wait — the exact path used to feed commands to a
// process paused at a breakpoint.
async function testSabChannel() {
  const sab = new SharedArrayBuffer(DBG_SAB_BYTES);
  const views = makeDebugViews(sab);
  const debugUrl = new URL("../packages/protocol/debug.js", import.meta.url).href;
  const workerCode = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { makeDebugViews, readDebugCommandBlocking } = await import(workerData.debugUrl);
      const views = makeDebugViews(workerData.sab);
      for (let i = 0; i < 3; i++) {
        const s = readDebugCommandBlocking(views); // blocks on Atomics.wait
        parentPort.postMessage(s);
      }
    })();
  `;
  const w = new Worker(workerCode, { eval: true, workerData: { sab, debugUrl } });
  const received = [];
  const done = new Promise((resolve) => {
    w.on("message", (s) => {
      received.push(s);
      if (received.length === 3) resolve();
    });
  });

  const send = (obj) =>
    new Promise((resolve) => {
      const str = JSON.stringify(obj);
      const tick = () => {
        if (writeDebugCommand(views, str)) resolve();
        else setTimeout(tick, 2); // slot still full — the worker hasn't drained it
      };
      tick();
    });

  await send({ id: 1, method: "Debugger.resume" });
  await send({ id: 2, method: "Debugger.stepOver" });
  await send({ id: 3, method: "Runtime.evaluate", params: { expression: "1+1" } });
  await done;
  await w.terminate();

  assert(received.length === 3, "debug SAB channel delivered all 3 commands");
  const parsed = received.map((s) => JSON.parse(s));
  assert(parsed[0].method === "Debugger.resume", "SAB command #1 round-trips intact");
  assert(parsed[2].params.expression === "1+1", "SAB command #3 payload round-trips intact");
  assert(Atomics.load(views.ctrl, 0) === DBG_STATE_EMPTY, "debug SAB slot is empty after draining");
}

await testSabChannel();

// ── end-to-end: a real worker pauses on Atomics.wait and resumes over the SAB ───
// This mirrors the true Process Worker transport: the guest blocks its thread at a
// breakpoint (readDebugCommandBlocking → Atomics.wait), while the "kernel" (this
// main thread) drives evaluate + resume in over the debug SAB and reads the
// paused/response events back over postMessage.
async function testRealPause() {
  const sab = new SharedArrayBuffer(DBG_SAB_BYTES);
  const views = makeDebugViews(sab);
  const dbgUrl = new URL("../packages/runtime/debugger.js", import.meta.url).href;
  const debugUrl = new URL("../packages/protocol/debug.js", import.meta.url).href;

  const workerCode = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { createDebugger } = await import(workerData.dbgUrl);
      const { makeDebugViews, readDebugCommandBlocking } = await import(workerData.debugUrl);
      const views = makeDebugViews(workerData.sab);
      const dbg = createDebugger({
        send: (m) => parentPort.postMessage({ kind: 'ev', data: JSON.stringify(m) }),
        waitForCommand: () => { try { return JSON.parse(readDebugCommandBlocking(views)); } catch { return null; } },
      });
      globalThis.__vvdbg = dbg.__vvdbg;
      globalThis.__vvDebugHook = dbg;
      dbg.onCommand({ id: 1, method: 'Runtime.enable' });
      dbg.onCommand({ id: 2, method: 'Debugger.enable' });
      const src = 'function add(a, b) {\\n  const s = a + b;\\n  return s;\\n}\\nglobalThis.__r = add(20, 22);\\n';
      const woven = dbg.instrument(src, '/e2e.js', { isModule: false });
      dbg.onCommand({ id: 3, method: 'Debugger.setBreakpointByUrl', params: { url: 'file:///e2e.js', lineNumber: 2 } });
      new Function(woven)(); // blocks at the breakpoint until the parent resumes it
      parentPort.postMessage({ kind: 'result', value: globalThis.__r });
    })();
  `;

  const w = new Worker(workerCode, { eval: true, workerData: { sab, dbgUrl, debugUrl } });
  const sendCmd = (obj) =>
    new Promise((resolve) => {
      const str = JSON.stringify(obj);
      const tick = () => (writeDebugCommand(views, str) ? resolve() : setTimeout(tick, 2));
      tick();
    });

  let evalValue = null;
  let pausedSeen = false;
  let finalResult = null;
  const finished = new Promise((resolve) => {
    w.on("message", async (m) => {
      if (m.kind === "ev") {
        const msg = JSON.parse(m.data);
        if (msg.method === "Debugger.paused" && !pausedSeen) {
          pausedSeen = true;
          // drive evaluate-in-frame then resume, over the SAB (worker is parked)
          await sendCmd({ id: 100, method: "Debugger.evaluateOnCallFrame", params: { callFrameId: "cf:0", expression: "a * b" } });
          await sendCmd({ id: 101, method: "Debugger.resume" });
        } else if (msg.id === 100) {
          evalValue = msg.result && msg.result.result ? msg.result.result.value : undefined;
        }
      } else if (m.kind === "result") {
        finalResult = m.value;
        resolve();
      }
    });
  });

  await finished;
  await w.terminate();
  assert(pausedSeen, "real worker paused at the breakpoint (blocked on Atomics.wait)");
  assert(evalValue === 440, "evaluate-on-call-frame over the SAB saw the params (a*b === 440)");
  assert(finalResult === 42, "worker resumed over the SAB and ran to completion (add(20,22) === 42)");
}

await testRealPause();

// ── end-to-end: the --inspect-brk-style start gate (short synchronous entry) ─────
// The real failure mode this guards: a tiny synchronous script finishes before the
// frontend's async setBreakpoint commands are ever read, so nothing pauses. Here the
// worker attaches the debugger and calls waitForStart() BEFORE running the (woven)
// entry; ALL config — enable + the breakpoint — is sent by the "kernel" (this main
// thread) over the SAB only after the worker has started, ending with
// Runtime.runIfWaitingForDebugger to open the gate. If the gate works, execution
// pauses at the breakpoint even though the breakpoint was set "late".
async function testStartGate() {
  const sab = new SharedArrayBuffer(DBG_SAB_BYTES);
  const views = makeDebugViews(sab);
  const dbgUrl = new URL("../packages/runtime/debugger.js", import.meta.url).href;
  const debugUrl = new URL("../packages/protocol/debug.js", import.meta.url).href;

  const workerCode = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { createDebugger } = await import(workerData.dbgUrl);
      const { makeDebugViews, readDebugCommandBlocking } = await import(workerData.debugUrl);
      const views = makeDebugViews(workerData.sab);
      const dbg = createDebugger({
        send: (m) => parentPort.postMessage({ kind: 'ev', data: JSON.stringify(m) }),
        waitForCommand: (t) => { try { const s = readDebugCommandBlocking(views, t); return s == null ? null : JSON.parse(s); } catch { return null; } },
      });
      globalThis.__vvdbg = dbg.__vvdbg;
      globalThis.__vvDebugHook = dbg;
      // A short, fully synchronous entry — it would run to completion instantly.
      const src = 'const a = 2;\\nconst b = 3;\\nglobalThis.__g = a + b;\\n';
      const woven = dbg.instrument(src, '/gate.js', { isModule: false });
      parentPort.postMessage({ kind: 'started' });
      dbg.waitForStart(3000); // block until the parent opens the gate over the SAB
      new Function(woven)(); // must pause at the line-3 breakpoint set during the gate
      parentPort.postMessage({ kind: 'result', value: globalThis.__g });
    })();
  `;

  const w = new Worker(workerCode, { eval: true, workerData: { sab, dbgUrl, debugUrl } });
  const sendCmd = (obj) =>
    new Promise((resolve) => {
      const str = JSON.stringify(obj);
      const tick = () => (writeDebugCommand(views, str) ? resolve() : setTimeout(tick, 2));
      tick();
    });

  let pausedSeen = false;
  let pausedLine = null;
  let evalValue = null;
  let finalResult = null;

  const finished = new Promise((resolve) => {
    w.on("message", async (m) => {
      if (m.kind === "started") {
        // Send config only AFTER the worker has started — the gate must hold it.
        await sendCmd({ id: 1, method: "Runtime.enable" });
        await sendCmd({ id: 2, method: "Debugger.enable" });
        await sendCmd({ id: 3, method: "Debugger.setBreakpointsActive", params: { active: true } });
        await sendCmd({ id: 4, method: "Debugger.setBreakpointByUrl", params: { url: "file:///gate.js", lineNumber: 2 } });
        await sendCmd({ id: 5, method: "Runtime.runIfWaitingForDebugger" });
      } else if (m.kind === "ev") {
        const msg = JSON.parse(m.data);
        if (msg.method === "Debugger.paused" && !pausedSeen) {
          pausedSeen = true;
          pausedLine = msg.params.callFrames[0].location.lineNumber;
          await sendCmd({ id: 100, method: "Debugger.evaluateOnCallFrame", params: { callFrameId: "cf:0", expression: "a + b" } });
          await sendCmd({ id: 101, method: "Debugger.resume" });
        } else if (msg.id === 100) {
          evalValue = msg.result && msg.result.result ? msg.result.result.value : undefined;
        }
      } else if (m.kind === "result") {
        finalResult = m.value;
        resolve();
      }
    });
  });

  await finished;
  await w.terminate();
  assert(pausedSeen, "start gate: short synchronous entry paused on a late-set breakpoint");
  assert(pausedLine === 2, "start gate: paused on line 3 (the breakpoint)");
  assert(evalValue === 5, "start gate: evaluate in the module frame saw a + b === 5");
  assert(finalResult === 5, "start gate: entry ran to completion after resume (__g === 5)");
}

await testStartGate();

console.log("");
if (failures) {
  console.error(`spike-debugger: ${failures} assertion(s) FAILED`);
  process.exit(1);
} else {
  console.log("spike-debugger: all assertions passed");
}