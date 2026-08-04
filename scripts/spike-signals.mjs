// Signal delivery spike — proves that a catchable signal reaches a guest and
// that everything which must stay abrupt stayed abrupt.
//
// WHAT IS REAL HERE, AND WHAT IS NOT. This runs the actual `Kernel` class from
// packages/kernel-host/kernel.js, real `node:worker_threads` Workers, a real
// SharedArrayBuffer per process laid out by packages/protocol/syscall.js, the
// real syscall client (packages/runtime/fs-client.js) parking in real
// `Atomics.wait`, the real event loop (packages/runtime/loop.js) and the real
// signal delivery (packages/runtime/signals.js). The guest's `process` object is
// the real packages/runtime/builtins/process.js.
//
// What is NOT here is the Wasm VFS, which cannot be built in this environment —
// so there is no module loader and no `node <entry>`. The guest of each scenario
// is a function in this file rather than a program in the VFS, and it reaches
// the syscall layer directly instead of through `fs`. That is the ceiling: this
// proves the MECHANISM end to end across a real thread boundary, not the browser
// kernel booting a real server and shutting it down.
//
// Blocking syscalls: the harness services one synthetic opcode, OP_READ_FILE on
// a path "/slow/<ms>", by deferring the real Kernel#respondOk by <ms>. That puts
// a guest in a genuine, controllable `Atomics.wait` park — the case a signal
// implementation is most likely to get wrong.
//
//   node scripts/spike-signals.mjs

import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

import {
  makeViews,
  decodeRequest,
  decodeBytes,
  encodeString,
  I_OPCODE,
  I_REQ_LEN,
  I_SIGNAL,
  OP_READ_FILE,
  SIGNAL_BITS,
} from "../packages/protocol/syscall.js";

// ───────────────────────────────── guest side ─────────────────────────────────

if (!isMainThread) {
  const { createSyscalls } = await import("../packages/runtime/fs-client.js");
  const { createEventLoop } = await import("../packages/runtime/loop.js");
  const { createSignalDelivery } = await import("../packages/runtime/signals.js");
  const { createProcess } = await import("../packages/runtime/builtins/process.js");

  const { sab, spec } = workerData;
  const { ctrl, data } = makeViews(sab);
  const scenario = spec.args[0];
  const say = (chunk) => parentPort.postMessage({ type: "stdout", chunk });

  // Wired below, once the pieces that need each other exist.
  let onPendingSignals = () => {};
  let drainSignals = () => {};

  const syscalls = createSyscalls({
    ctrl,
    data,
    notify: () => parentPort.postMessage({ type: "syscall" }),
    onSignal: (names) => onPendingSignals(names),
  });

  // Something for the loop to stay alive for, like a listening server would be.
  const alive = { on: true };
  const loop = createEventLoop({
    isAlive: () => alive.on,
    doSignal: () => drainSignals(),
  });

  const process_ = createProcess({
    pid: spec.pid,
    ppid: spec.ppid,
    argv: [],
    env: {},
    cwd: "/",
    stdout: say,
    stderr: (chunk) => parentPort.postMessage({ type: "stderr", chunk }),
    nextTick: loop.nextTick,
    onExit: (code) => loop.requestExit(code),
  });
  // The same EventEmitter mixin packages/runtime/index.js applies — `process`
  // has to be a real emitter before signal delivery can hang off it.
  {
    const ee = new EventEmitter();
    ee.setMaxListeners(0);
    const chainable = new Set([
      "on", "addListener", "once", "prependListener", "prependOnceListener",
      "off", "removeListener", "removeAllListeners", "setMaxListeners",
    ]);
    const methods = [...chainable, "listeners", "listenerCount", "eventNames", "emit"];
    for (const m of methods) {
      process_[m] = (...args) => {
        const r = ee[m](...args);
        return chainable.has(m) ? process_ : r;
      };
    }
  }

  const signals = createSignalDelivery({
    process: process_,
    loop,
    postRaw: (m) => parentPort.postMessage(m),
  });
  drainSignals = signals.drain;

  // Which inbound path saw the signal first. `sab-only` deliberately unhooks the
  // postMessage path so the SAB path has to carry the delivery on its own.
  const seen = [];
  onPendingSignals = (names) => {
    seen.push("sab:" + names.join(","));
    signals.onPending(names);
  };
  if (scenario !== "sab-only") {
    parentPort.on("message", (m) => {
      if (m && m.type === "signal") {
        seen.push("msg:" + m.signal);
        signals.dispatch(m);
      }
    });
  }

  const ready = () => say("READY\n");

  switch (scenario) {
    // No handler at all: the kernel must never post us anything.
    case "no-listener":
      ready();
      break;

    // A handler that shuts down cleanly and picks its own exit code.
    case "listener-exit-code":
      process_.on("SIGTERM", (name) => {
        say(`caught ${name}\n`);
        alive.on = false;
        process_.exit(7);
      });
      ready();
      break;

    // Ctrl-C for an interactive CLI.
    case "sigint":
      process_.on("SIGINT", (name) => {
        say(`caught ${name}\n`);
        alive.on = false;
        process_.exit(130);
      });
      ready();
      break;

    // A handler that catches and then never gets around to leaving. This is the
    // one that must not be allowed to wedge the kernel.
    case "listener-hangs":
      process_.on("SIGTERM", (name) => say(`caught ${name}, hanging\n`));
      ready();
      break;

    // Catches SIGINT, deals with it, and is deliberately still here — a Python
    // REPL taking a KeyboardInterrupt back to its prompt. Standing the window
    // down is the claim that makes that legal.
    case "sigint-stands-down":
      process_.on("SIGINT", (name) => {
        say(`caught ${name}\n`);
        signals.standDown(name);
      });
      ready();
      break;

    // Catches SIGINT but never exits — the parent sends it twice.
    case "sigint-hangs":
      process_.on("SIGINT", (name) => say(`caught ${name}\n`));
      ready();
      break;

    // Registers a handler for something uncatchable. It must not save it.
    case "sigkill-listener":
      process_.on("SIGTERM", () => say("caught SIGTERM\n"));
      process_.on("SIGKILL", () => say("caught SIGKILL — THIS MUST NOT HAPPEN\n"));
      ready();
      break;

    // Signalled while parked in Atomics.wait, half-way through a syscall. The
    // park length comes from the scenario so we can sit both inside and outside
    // the grace window.
    case "blocked":
    case "sab-only": {
      const parkMs = spec.args[1];
      process_.on("SIGTERM", (name) => {
        say(`caught ${name} via [${seen.join(" ")}]\n`);
        alive.on = false;
        process_.exit(9);
      });
      ready();
      // Not from the top-level stack: the loop has to be running (as it would be
      // for any real program past its first turn) for delivery to mean anything.
      loop.setTimeout(() => {
        say("BLOCKING\n");
        const t0 = Date.now();
        syscalls.readFile(`/slow/${parkMs}`);
        say(`unblocked after ${Date.now() - t0}ms, pending=[${seen.join(" ")}]\n`);
      }, 10);
      break;
    }

    // Sits there so the parent can probe it with signal 0.
    case "probe-target":
      ready();
      break;

    default:
      say(`unknown scenario ${scenario}\n`);
      alive.on = false;
  }

  loop.drive().then(
    () => {
      const code = loop.exiting ? loop.exitCode : process_.exitCode == null ? 0 : process_.exitCode | 0;
      parentPort.postMessage({ type: "exit", code });
    },
    (err) => {
      parentPort.postMessage({ type: "stderr", chunk: String((err && err.stack) || err) + "\n" });
      parentPort.postMessage({ type: "exit", code: 1 });
    },
  );
}

// ───────────────────────────────── host side ──────────────────────────────────

if (isMainThread) {
  const { Kernel } = await import("../packages/kernel-host/kernel.js");

  const SELF = fileURLToPath(import.meta.url);
  const GRACE_MS = 300; // shortened for the spike; the shipped default is 5000

  const out = new Map(); // pid -> accumulated stdout
  const waiters = []; // { pid, needle, resolve }
  const exits = new Map(); // pid -> { code, signal, at }

  const record = (chunk, pid) => {
    out.set(pid, (out.get(pid) || "") + chunk);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.pid === pid && (out.get(pid) || "").includes(w.needle)) {
        waiters.splice(i, 1);
        w.resolve();
      }
    }
  };
  const waitFor = (pid, needle) =>
    new Promise((resolve, reject) => {
      if ((out.get(pid) || "").includes(needle)) return resolve();
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${needle} from pid ${pid}`)), 5000);
      waiters.push({ pid, needle, resolve: () => { clearTimeout(timer); resolve(); } });
    });

  const workers = new Map(); // pid -> Worker

  const kernel = new Kernel({
    fs: null, // no VFS in this environment; createProcess() never touches it
    stdout: record,
    stderr: record,
    signalGraceMs: GRACE_MS,
    spawnWorker: (info) => {
      const w = new Worker(SELF, { workerData: { sab: info.sab, spec: info.spec } });
      workers.set(info.pid, w);
      w.on("message", (m) => {
        // Our synthetic blocking opcode is serviced here; everything else is the
        // real kernel's job (including 'signal-listen' and 'exit').
        if (m.type === "syscall" && serviceSlowRead(info.pid)) return;
        const h = info.on[m.type];
        if (h) h(m);
      });
      w.on("error", (e) => process.stderr.write(`[worker ${info.pid}] ${(e && e.stack) || e}\n`));
      return {
        terminate: () => w.terminate(),
        postMessage: (m) => w.postMessage(m),
      };
    },
  });

  // OP_READ_FILE of "/slow/<ms>" answers after <ms>. Any other opcode falls
  // through to the real kernel.
  function serviceSlowRead(pid) {
    const proc = kernel.procs.get(pid);
    if (!proc) return false;
    if (Atomics.load(proc.ctrl, I_OPCODE) !== OP_READ_FILE) return false;
    const { fields } = decodeRequest(proc.data.slice(0, Atomics.load(proc.ctrl, I_REQ_LEN)));
    const ms = parseInt(decodeBytes(fields[0]).split("/")[2], 10) || 0;
    setTimeout(() => {
      if (kernel.procs.has(pid) && !proc.finalized) kernel.respondOk(proc, encodeString("ok"));
    }, ms);
    return true;
  }

  // Every window asserted below is enforced by setTimeout, which libuv runs off
  // the monotonic clock. Date.now() follows the wall clock, and a CI host slewing
  // one against the other measured a 300ms window as 299ms. Measure on the clock
  // that decides the outcome, not a different one that merely resembles it.
  const now = () => performance.now();
  // libuv caches that clock at integer-millisecond resolution and fires when the
  // cached value reaches the deadline, so a window can still land one tick short
  // of its nominal length. One tick is the honest floor; anything more would be
  // loosening the check rather than fixing the measurement.
  const TICK_MS = 1;

  const spawn = (scenario, arg = null, opts = {}) => {
    const pid = kernel.createProcess(
      { command: "guest", programPath: "/guest.js", args: [scenario, arg], cwd: "/", env: {} },
      opts,
    );
    kernel.procs.get(pid).onExit = (res) => exits.set(pid, { ...res, at: Date.now() });
    return pid;
  };

  const settled = (pid) =>
    new Promise((resolve, reject) => {
      const t0 = now();
      const tick = () => {
        if (exits.has(pid)) return resolve(exits.get(pid));
        if (now() - t0 > 5000) return reject(new Error(`pid ${pid} never exited`));
        setTimeout(tick, 5);
      };
      tick();
    });

  // ---- assertions -----------------------------------------------------------
  let failures = 0;
  const check = (ok, label, detail = "") => {
    if (ok) console.log(`  ok    ${label}`);
    else {
      failures++;
      console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`);
    }
  };
  const section = (name) => console.log(`\n── ${name} ─────────────────────────────`);

  // 1 ── default action: no listener means terminate now, with today's code.
  section("no listener: default action, unchanged");
  {
    const pid = spawn("no-listener");
    await waitFor(pid, "READY");
    const t0 = now();
    kernel.signal(pid, "SIGTERM");
    const dead = !kernel.procs.has(pid);
    const res = exits.get(pid);
    check(dead, "terminated synchronously inside signal()");
    check(res && res.code === 143, "exit code 143", res && `got ${res.code}`);
    check(res && res.signal === "SIGTERM", "reports signal SIGTERM", res && `got ${res.signal}`);
    check(now() - t0 < 50, "no grace window was opened");
  }

  // 2 ── a listener means the process decides, including its exit code.
  section("SIGTERM listener: the process decides");
  {
    const pid = spawn("listener-exit-code");
    await waitFor(pid, "READY");
    const t0 = now();
    kernel.signal(pid, "SIGTERM");
    check(kernel.procs.has(pid), "not terminated on the spot");
    const res = await settled(pid);
    const took = Math.round(now() - t0);
    check((out.get(pid) || "").includes("caught SIGTERM"), "handler ran");
    check(res.code === 7, "exited with ITS OWN code 7, not 143", `got ${res.code}`);
    check(res.signal == null, "reported as a normal exit (signal null)", `got ${res.signal}`);
    check(took < GRACE_MS, `shut down inside the grace window (${took}ms)`);
  }

  // 3 ── SIGINT is the same mechanism; the shell's Ctrl-C path already sends it.
  section("SIGINT listener");
  {
    const pid = spawn("sigint");
    await waitFor(pid, "READY");
    kernel.signal(pid, "SIGINT");
    const res = await settled(pid);
    check((out.get(pid) || "").includes("caught SIGINT"), "handler ran");
    check(res.code === 130, "exited 130 (its own choice)", `got ${res.code}`);
  }

  // 4 ── the hard case: signalled while parked in Atomics.wait mid-syscall.
  section("blocked in Atomics.wait mid-syscall (park inside the grace window)");
  {
    const pid = spawn("blocked", 150);
    await waitFor(pid, "BLOCKING");
    await new Promise((r) => setTimeout(r, 40)); // firmly inside the park
    const proc = kernel.procs.get(pid);
    kernel.signal(pid, "SIGTERM");
    check(Atomics.load(proc.ctrl, I_SIGNAL) === SIGNAL_BITS.SIGTERM, "signal bit is pending in the SAB");
    const res = await settled(pid);
    const text = out.get(pid) || "";
    check(/unblocked after 1\d\dms/.test(text), "the syscall still completed normally", text.trim());
    check(text.includes("sab:SIGTERM"), "the parked worker saw it via the SAB", text.trim());
    check(text.includes("caught SIGTERM"), "handler ran once the syscall returned and the loop turned");
    check(res.code === 9, "exited with its own code 9", `got ${res.code}`);
    check(Atomics.load(proc.ctrl, I_SIGNAL) === 0, "pending set was cleared by the guest");
  }

  // 4b ── handled, and staying. Ctrl-C at a Python REPL raises KeyboardInterrupt
  //       and gives a fresh prompt: the process is alive on purpose, and the
  //       force-kill window has to be standable-down or it would be killed a few
  //       seconds after every interrupt.
  section("SIGINT handled by a process that is deliberately still running");
  {
    const pid = spawn("sigint-stands-down");
    await waitFor(pid, "READY");
    kernel.signal(pid, "SIGINT");
    await new Promise((r) => setTimeout(r, GRACE_MS + 150));
    check(kernel.procs.has(pid), "outlived the grace window it stood down");
    check((out.get(pid) || "").includes("caught SIGINT"), "handler ran");
    const proc = kernel.procs.get(pid);
    check(proc && proc.graceTimer == null, "the force-kill timer really was cleared");
    check(proc && proc.sigUnhandled == null, "…and the signal is no longer outstanding");

    // The escalation rule still has to work, but it is about a process that is
    // NOT answering. This one is, so a second Ctrl-C is a second interrupt.
    kernel.signal(pid, "SIGINT");
    await new Promise((r) => setTimeout(r, 150));
    check(kernel.procs.has(pid), "a second Ctrl-C at a prompt that answers is not a kill");
    const hits = (out.get(pid) || "").split("caught SIGINT").length - 1;
    check(hits === 2, `the handler ran for both interrupts (${hits})`);
    kernel.signal(pid, "SIGKILL");
    await settled(pid);
  }

  // 5 ── same, with the postMessage path unhooked: the SAB carries it alone.
  //      This is the path that exists BECAUSE a parked worker drains no messages.
  section("blocked mid-syscall, SAB path only (postMessage ignored)");
  {
    const pid = spawn("sab-only", 150);
    await waitFor(pid, "BLOCKING");
    await new Promise((r) => setTimeout(r, 40));
    kernel.signal(pid, "SIGTERM");
    const res = await settled(pid);
    const text = out.get(pid) || "";
    check(text.includes("caught SIGTERM"), "delivered with no message path at all");
    check(!text.includes("msg:"), "and it really was the SAB that carried it", text.trim());
    check(res.code === 9, "exited with its own code 9", `got ${res.code}`);
  }

  // 5b ── and the honest limit of that: the grace window is wall-clock from the
  //       moment the signal is sent, so a park that outlasts it is force-killed
  //       with the handler never having had a turn. Same as `docker stop` on a
  //       process wedged in a long synchronous call — and no worse than today,
  //       where it would have been killed outright with no window at all.
  section("blocked mid-syscall, park OUTLASTS the grace window");
  {
    const pid = spawn("blocked", 900);
    await waitFor(pid, "BLOCKING");
    await new Promise((r) => setTimeout(r, 40));
    const proc = kernel.procs.get(pid);
    const t0 = now();
    kernel.signal(pid, "SIGTERM");
    const res = await settled(pid);
    const took = Math.round(now() - t0);
    check(
      took >= GRACE_MS - TICK_MS && took < GRACE_MS + 500,
      `forced at the window (${took}ms), not at the end of the park`,
    );
    check(res.code === 143, "with today's exit code 143", `got ${res.code}`);
    check(!(out.get(pid) || "").includes("caught SIGTERM"), "handler never got a turn (it could not)");
    check(
      Atomics.load(proc.ctrl, I_SIGNAL) === 0,
      "but the parked guest HAD harvested the signal from the SAB — it was bounded, not lost",
    );
  }

  // 6 ── a handler that hangs must not wedge the kernel.
  section("grace period, then force");
  {
    const pid = spawn("listener-hangs");
    await waitFor(pid, "READY");
    const t0 = now();
    kernel.signal(pid, "SIGTERM");
    const res = await settled(pid);
    const took = Math.round(now() - t0);
    check((out.get(pid) || "").includes("caught SIGTERM, hanging"), "handler ran");
    check(took >= GRACE_MS - TICK_MS, `waited out the ${GRACE_MS}ms grace window (${took}ms)`);
    check(took < GRACE_MS + 1000, "then forced promptly", `${took}ms`);
    check(res.code === 143, "forced with today's exit code 143", `got ${res.code}`);
    check(res.signal === "SIGTERM", "and today's signal attribution");
    check((out.get(pid) || "").includes("forcing termination"), "and said so on stderr");
  }

  // 7 ── a second Ctrl-C means it.
  section("repeat signal inside the grace window escalates");
  {
    const pid = spawn("sigint-hangs");
    await waitFor(pid, "READY");
    kernel.signal(pid, "SIGINT");
    await waitFor(pid, "caught SIGINT");
    const t0 = now();
    kernel.signal(pid, "SIGINT");
    const took = Math.round(now() - t0);
    check(!kernel.procs.has(pid), "second SIGINT terminated it immediately");
    check(took < GRACE_MS, `without waiting out the window (${took}ms)`);
  }

  // 8 ── SIGKILL is not negotiable.
  section("SIGKILL stays uncatchable and immediate");
  {
    const pid = spawn("sigkill-listener");
    await waitFor(pid, "READY");
    const t0 = now();
    kernel.signal(pid, "SIGKILL");
    const dead = !kernel.procs.has(pid);
    const res = exits.get(pid);
    check(dead, "terminated synchronously");
    check(now() - t0 < 50, "no grace window");
    check(res && res.code === 137, "exit code 137", res && `got ${res.code}`);
    check(!(out.get(pid) || "").includes("caught SIGKILL"), "the handler it registered never ran");
  }

  // 9 ── internal teardown must not be interceptable either.
  section("kernel.stop() is not interceptable");
  {
    const pid = spawn("listener-hangs");
    await waitFor(pid, "READY");
    const t0 = now();
    kernel.stop(pid);
    check(!kernel.procs.has(pid), "terminated synchronously despite a SIGTERM handler");
    check(now() - t0 < 50, "no grace window");
    check(exits.get(pid) && exits.get(pid).code === 143, "exit code 143");
  }

  // 10 ── the regression that matters: killing a process still takes its whole
  //       subtree with it, immediately, even when a child catches signals.
  //       (kernel.js: an orphaned server keeps its port and the next restart
  //       hits EADDRINUSE.)
  section("subtree cascade still immediate (NestJS watch-mode restart)");
  {
    const parent = spawn("no-listener");
    await waitFor(parent, "READY");
    const child = spawn("listener-hangs", null, { parentPid: parent });
    await waitFor(child, "READY");
    const t0 = now();
    kernel.signal(parent, "SIGTERM");
    check(!kernel.procs.has(parent), "parent gone");
    check(!kernel.procs.has(child), "child gone in the same synchronous cascade");
    check(now() - t0 < 50, "no grace window was granted to the child's handler");
    const cres = exits.get(child);
    check(cres && cres.code === 143 && cres.signal === "SIGTERM", "child finalized as before");
    check(!(out.get(child) || "").includes("caught SIGTERM"), "the child's handler never ran");
  }

  // 11 ── signal 0 is a probe, not a kill.
  section("signal 0 is an existence probe");
  {
    const pid = spawn("probe-target");
    await waitFor(pid, "READY");
    const probe = { pid: pid, signal: 0 };
    // Straight through handleKill, as a guest's sys.kill(pid, 0) arrives.
    const killer = kernel.procs.get(spawn("probe-target"));
    await waitFor(killer.pid, "READY");
    kernel.handleKill(killer, probe);
    check(kernel.procs.has(pid), "still alive after signal 0");
    kernel.handleKill(killer, { pid, signal: "SIGTERM" });
    check(!kernel.procs.has(pid), "and a real SIGTERM still kills it");
    kernel.stop(killer.pid);
  }

  // 12 ── the shipped default, stated out loud so it cannot drift silently.
  section("shipped defaults");
  {
    const k = new Kernel({ fs: null, spawnWorker: () => ({ terminate() {} }) });
    check(k.signalGraceMs === 5000, "default grace window is 5000ms", `got ${k.signalGraceMs}`);
  }

  for (const w of workers.values()) await w.terminate();

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures} failing check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}