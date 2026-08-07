// Diagnostics spike — proves `__vv.diag()` can say WHY a process will not exit.
//
// This exists because of a hang we could not explain from the outside. Three Bun
// templates printed everything they were going to print and then sat there, and
// the only evidence available was a pid that never left the process table with
// `syscalls: 0`. That symptom is identical for every possible cause — a ref'd
// timer, an open socket, a stdin reader, a child never reaped — so it narrowed
// nothing, and the investigation turned into guesswork.
//
// So the diagnostic now names the handles. `memStats()` reports each of the
// runtime's liveness counters plus the loop's own ref'd timers/immediates/ticks,
// the kernel worker folds it into each proc as `alive`, and the studio surfaces
// it in `await __vv.diag()`.
//
// WHAT IS REAL HERE. The actual `Kernel`, real `node:worker_threads` Process
// Workers, the real runtime and event loop, and the real `proc-mem` round-trip
// the studio uses. What is NOT here is the browser: the studio's `__vv.diag()`
// wrapper is a thin fold over exactly this reply (kernel-worker.ts), so this
// covers the mechanism, not the console binding.
//
// The bar: a process held open for two DIFFERENT reasons must report two
// different breakdowns. A field that says "something is alive" is no better than
// the pid we already had.
//
// This one boots the kernel by hand rather than through lib/spike-harness.mjs,
// and unlike the others it is not a leftover: the spike has to send `proc-mem`
// to a LIVE process and read the reply, so it needs a pid→handle map and a
// message hook that runs ahead of the kernel's own routing. The harness's
// spawnWorker gives neither, and growing it a message-interception seam to serve
// one caller would move the complexity rather than remove it.

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { shouldReportStall, shouldReportStallFor, isUnobservable } from "../packages/core/terminal-feedback.js";
import { initTransferList } from "../packages/kernel-host/worker-transfer.js";
import { Worker, MessageChannel } from "node:worker_threads";

let failed = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failed++;
};

const fsWorker = new Worker(new URL("./fs-worker.mjs", import.meta.url));
let onFs = () => {};
await new Promise((r) => {
  fsWorker.on("message", (m) => {
    if (m.type === "ready") r();
    else onFs(m);
  });
});
const kernelFs = createKernelFs(fsWorker);
onFs = kernelFs.onMessage;

const memReplies = new Map();
const handles = new Map();
const spawnWorker = (info) => {
  const w = new Worker(new URL("./process-worker.mjs", import.meta.url));
  w.on("message", (m) => {
    if (m.type === "proc-mem-reply") {
      const r = memReplies.get(m.pid);
      if (r) r(m);
      return;
    }
    const h = info.on[m.type];
    if (h) h(m);
  });
  w.on("error", (e) => process.stderr.write(`[worker ${info.pid}] ${(e && e.stack) || e}\n`));
  const { port1, port2 } = new MessageChannel();
  fsWorker.postMessage({ type: "fs-register", client: info.pid, sab: info.sab, port: port2 }, [port2]);
  // A spawned worker_thread is handed its creator's MessageChannel end as its
  // parentPort. This harness used to drop it, which was invisible while nothing here
  // spawned threads and is not any more: without it `parentPort` is null in the child,
  // and the pool worker below dies on its first line instead of parking.
  const init = { type: "init", sab: info.sab, spec: info.spec, fsPort: port1 };
  if (info.threadPort) init.threadPort = info.threadPort;
  w.postMessage(init, initTransferList(info, port1));
  const handle = {
    terminate: () => {
      w.terminate();
      fsWorker.postMessage({ type: "fs-unregister", client: info.pid });
    },
    postMessage: (m) => w.postMessage(m),
  };
  handles.set(info.pid, handle);
  return handle;
};

// Captured rather than dropped: the awaiting-input section at the bottom needs to
// see a prompt actually arrive, because a flag read without one proves only that
// the flag exists.
let term = "";
const onTerm = (s) => {
  term += s;
};
const kernel = new Kernel({ fs: kernelFs.fs, spawnWorker, stdout: onTerm, stderr: onTerm });
kernel.installCoreutils();
const APP = "/app";
kernel.mkdirp(APP);
kernel.writeFile(APP + "/package.json", '{"name":"diag","type":"module"}');
const ENV = { HOME: "/home/user", PATH: "/bin", PWD: APP };

// Ask a live process the same question the studio's __vv.diag() asks.
const aliveOf = async (pid) => {
  const reply = await new Promise((resolve) => {
    memReplies.set(pid, resolve);
    handles.get(pid).postMessage({ type: "proc-mem", id: 1 });
    setTimeout(() => resolve(null), 5000);
  });
  memReplies.delete(pid);
  return reply && reply.alive;
};

const runHeld = async (name, source) => {
  kernel.writeFile(APP + "/held.js", source);
  const pid = kernel.launch("node", ["held.js"], { cwd: APP, env: ENV });
  // Let it reach the point where it has printed and gone quiet.
  await new Promise((r) => setTimeout(r, 2000));
  const alive = await aliveOf(pid);
  const stillUp = kernel.procs.has(pid) && !kernel.procs.get(pid).finalized;
  console.log(`  ${name}: ${JSON.stringify(alive)}`);
  try {
    // `kernel.kill` does not exist and never did; the catch swallowed the TypeError,
    // so every process this spike started stayed in the table for the rest of the run.
    // Harmless for the checks above, which read one pid at a time — not harmless for
    // the worker-thread section below, which counts a parent's live children.
    kernel.signal(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  return { alive, stillUp };
};

console.log("\n== a process held open by a ref'd timer ==");
const timer = await runHeld("timer", 'console.log("done");\nsetInterval(() => {}, 60000);\n');
ok(timer.stillUp, "the guest printed everything and still did not exit");
ok(!!timer.alive, "diag reports an `alive` breakdown for it, not just a pid");
ok(timer.alive && timer.alive.timers === 1, "…naming the ref'd timer as what holds the loop");
ok(timer.alive && timer.alive.stdin === 0 && timer.alive.net === 0, "…and not blaming a handle it does not hold");

console.log("\n== the same symptom, a different cause ==");
const stdin = await runHeld("stdin", 'console.log("done");\nprocess.stdin.on("data", () => {});\n');
ok(stdin.stillUp, "this guest also printed everything and did not exit");
ok(stdin.alive && stdin.alive.stdin === 1, "…and diag names the stdin reader instead");
ok(stdin.alive && stdin.alive.timers === 0, "…with no timer blamed");
// The whole point: from outside, these two are indistinguishable.
ok(
  JSON.stringify(timer.alive) !== JSON.stringify(stdin.alive),
  "two hangs that look identical from the process table read differently here",
);

// Counting the timers was not enough. In the first hang this diagnostic was used
// on, EVERY process reported exactly `timers: 1` and there was no way to tell
// which timer, so the count named a category and the investigation stalled again.
// The shape is what identifies it: a 1<<30 interval is the esbuild keepalive
// (esbuild-inproc-patch.js), 120ms is the ws reconnect, a long one-shot is usually
// the guest's own.
console.log("\n== the timers are identified by shape, not just counted ==");
{
  const held = await runHeld(
    "two timers",
    'console.log("done");\nsetInterval(() => {}, 1 << 30);\nsetTimeout(() => {}, 45000);\n',
  );
  const detail = (held.alive && held.alive.timerDetail) || [];
  ok(held.alive && held.alive.timers === 2, "both ref'd timers are counted");
  ok(detail.length === 2, "…and both are described, not just tallied");
  ok(
    detail.some((t) => t.everyMs === 1 << 30),
    "…the keepalive interval is recognisable by its period",
  );
  ok(
    detail.some((t) => t.everyMs === null && t.delayMs === 45000),
    "…and the one-shot is distinguishable from it by shape",
  );
  // The period narrowed the real hang to a suspect that turned out to be innocent.
  // A creation stack does not need a theory to be right.
  const interval = detail.find((t) => t.everyMs === 1 << 30);
  const origin = (interval && interval.createdAt) || "";
  ok(!!origin, "…and the interval carries the stack of where it was created");
  ok(!/loop\.js/.test(origin.split("\n")[0] || ""), "…starting at the caller, not at our own timer plumbing");
  // Guest code is eval'd by the module loader, so its frames name module.js; a timer
  // armed by something else sharing the worker names that file instead. That is the
  // distinction the reported hang needs, and the period alone could not make it.
  ok(/module\.js|eval/.test(origin), "…and a guest-created interval is identifiable as the guest's");
}

// A Process Worker's globals are shared with whatever else the host put in that
// worker, and the runtime installs the guest's timers on globalThis — so a
// host-armed interval lands in the GUEST's loop as a ref'd handle and nothing that
// simply finishes can exit. Nothing host-side has a vote on whether the guest is
// done. (This is a real invariant, but note it did NOT fix the reported browser
// hang, whose 30000ms interval is armed after the entry starts.)
console.log("\n== the dev server's HMR ping cannot hold a finished guest open ==");
{
  process.env.VV_SIMULATE_DEV_HMR_PING = "1";
  // The guest must still be running when the ping is armed (250ms), or the test
  // proves nothing — that is exactly how the first attempt at this fix passed while
  // the browser stayed broken.
  kernel.writeFile(APP + "/plain.js", 'setTimeout(() => console.log("finished"), 1200);\n');
  const pid = kernel.launch("node", ["plain.js"], { cwd: APP, env: ENV });
  const gone = await new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (!kernel.procs.has(pid) || kernel.procs.get(pid).finalized) return resolve(true);
      if (Date.now() - t0 > 12000) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
  delete process.env.VV_SIMULATE_DEV_HMR_PING;
  ok(gone, "a guest that finishes exits, though a dev-server ping was armed mid-run");
}

// The other defence, which the case above does not exercise: a host handle armed
// BEFORE the entry runs, from an ordinary frame that the `/@vite/client` match would
// not catch. loop.disownExistingHandles() is what covers that, and this is the case
// that keeps it from being untested code.
console.log("\n== a host handle armed before the entry cannot hold the guest either ==");
{
  process.env.VV_SIMULATE_DEV_HMR_PING = "early";
  kernel.writeFile(APP + "/plain2.js", 'console.log("finished");\n');
  const pid = kernel.launch("node", ["plain2.js"], { cwd: APP, env: ENV });
  const gone = await new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (!kernel.procs.has(pid) || kernel.procs.get(pid).finalized) return resolve(true);
      if (Date.now() - t0 > 12000) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
  delete process.env.VV_SIMULATE_DEV_HMR_PING;
  ok(gone, "a guest that finishes exits, though the worker armed an interval before it started");
}

console.log("\n== a process that is genuinely working reports nothing exotic ==");
{
  kernel.writeFile(APP + "/quick.js", 'console.log("bye");\n');
  const pid = kernel.launch("node", ["quick.js"], { cwd: APP, env: ENV });
  const gone = await new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (!kernel.procs.has(pid) || kernel.procs.get(pid).finalized) return resolve(true);
      if (Date.now() - t0 > 10000) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
  ok(gone, "a guest holding no handles exits on its own (the breakdown is not keeping it up)");
}

// The stall watchdog asks a neighbouring question — not "why won't it exit" but
// "why has it said nothing" — and it has the same problem: an idle prompt and a
// wedged interpreter make identical syscalls, namely none. It is answered by the
// process announcing that it is waiting for a person (`process.__awaitingInput`),
// the kernel recording it, and the watchdog excusing only processes that said so.
//
// That decision is unit-tested in probe-terminal-feedback.mjs, but the DELIVERY —
// guest postRaw, to handleAwaiting, to the flag the watchdog reads — needs a
// booted kernel with a real shell in it, and this spike has one. It is worth
// gating separately because the whole argument for announcing over inferring is
// that the announcement is load-bearing: if it never arrives, the rule silently
// stops excusing anything, and nothing else here would notice.
console.log("\n== a shell waiting for a person says so, and the watchdog can read it ==");
{
  const shPid = kernel.launch("sh", [], { cwd: APP, env: ENV, tty: true });
  const promptAt = term.length;
  const waited = await new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const p = kernel.procs.get(shPid);
      if (p && p.awaiting) return resolve(true);
      if (Date.now() - t0 > 15000) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
  ok(waited, "an interactive shell announces that it is waiting for input");
  ok(kernel.procs.get(shPid)?.awaiting === "input", "…and the announcement says WHICH kind of waiting it is");
  ok(/\$/.test(term.slice(promptAt)), "…and it announced it by drawing a prompt, which is the fact being claimed");
  // End to end: the flag the guest set, read the way the watchdog reads it.
  ok(
    !shouldReportStall({ serving: false, pendingRequests: 0, hasLiveChild: false, awaiting: kernel.procs.get(shPid)?.awaiting ?? null }),
    "…so the stall watchdog does not report it, however long it sits there",
  );

  // The other half, and the one the cheap rule (terminal + no live child = a
  // prompt) could not have given us: silence on its own still buys nothing.
  kernel.writeFile(APP + "/mute.js", 'setInterval(() => {}, 60000);\n');
  const mutePid = kernel.launch("node", ["mute.js"], { cwd: APP, env: ENV });
  await new Promise((r) => setTimeout(r, 2000));
  const muteProc = kernel.procs.get(mutePid);
  ok(!!muteProc && !muteProc.awaiting, "a process that is merely silent announces nothing");
  ok(
    shouldReportStall({ serving: false, pendingRequests: 0, hasLiveChild: false, awaiting: muteProc?.awaiting ?? null }),
    "…and is still reported, which is what makes the announcement worth having",
  );

  // And the flag comes back DOWN when the shell starts working, or it would excuse
  // the shell for the rest of the session after one prompt.
  kernel.sendStdin(shPid, "node mute.js\n");
  const retracted = await new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const p = kernel.procs.get(shPid);
      if (p && !p.awaiting) return resolve(true);
      if (Date.now() - t0 > 15000) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
  ok(retracted, "…and the shell retracts it the moment it starts running something");

  try {
    kernel.signal(shPid, "SIGKILL");
    kernel.signal(mutePid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

// The third kind of waiting, and the one that arrived from a user watching a healthy
// dev server. The React template's `vite` spawns rolldown worker threads
// (@rolldown/binding-wasm32-wasi/wasi-worker.mjs) which park waiting for a job; all
// of them were reported as `PID 7 () has printed nothing for 73s … it looks stuck
// rather than slow`, over and over, while the server served.
//
// This section stands in for that with worker threads of its own rather than a real
// Vite. What is real here is everything the bug was actually about: kernel-spawned
// threads, the runtime's loop parking, the announcement crossing the wire, and the
// decision function the watchdog calls. What is NOT here is rolldown — the shipped
// template is gated end to end by spike-react, which is where the real pool runs.
console.log("\n== a worker thread waiting for a job, and one that cannot say anything ==");
{
  // (1) A pool worker that PRINTS at boot and then parks on its parentPort. Printing
  // is the point: it puts this thread outside the "never printed" rule below, so what
  // is being gated here is the announcement alone.
  kernel.writeFile(
    APP + "/pool-worker.js",
    "const { parentPort } = require('node:worker_threads');\n" +
      "process.stdout.write('pool worker ready\\n');\n" +
      "parentPort.on('message', (m) => parentPort.postMessage(m));\n",
  );
  // (2) A worker that never prints and never returns to the event loop, which is what
  // a wasm pthread body does. Atomics.wait on a SAB nobody notifies is the same shape
  // measured on the real thing: no output, no syscalls, no messages answered, 0% CPU.
  kernel.writeFile(
    APP + "/gone-worker.js",
    "require('node:worker_threads');\n" +
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n",
  );
  kernel.writeFile(
    APP + "/pool.js",
    "const { Worker } = require('node:worker_threads');\n" +
      "process.stdout.write('pool up\\n');\n" +
      "new Worker('" + APP + "/pool-worker.js');\n" +
      "new Worker('" + APP + "/gone-worker.js');\n" +
      "setInterval(() => {}, 60000);\n",
  );
  const poolPid = kernel.launch("node", ["pool.js"], { cwd: APP, env: ENV });

  const threadsOf = (ppid) => [...kernel.procs.values()].filter((p) => p.parentPid === ppid && !p.finalized);
  const settled = await new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const kids = threadsOf(poolPid);
      if (kids.length >= 2 && kids.some((k) => k.awaiting === "work")) return resolve(kids);
      if (Date.now() - t0 > 20000) return resolve(kids);
      setTimeout(tick, 100);
    };
    tick();
  });

  // Defect 1: the kernel never had a name for a thread, because handleThreadSpawn is
  // the one creator that spawns by path and never passed a `command`. Every report
  // said `PID 7 ()`, and so did __vv.diag() — a row the reader cannot identify, in the
  // answer to "what is wrong with my machine".
  ok(settled.length >= 2, `the pool's worker threads are in the process table (${settled.length})`);
  ok(
    settled.every((k) => typeof k.command === "string" && k.command.length > 0),
    "…and every one of them has a name",
  );
  ok(
    settled.some((k) => k.command === "pool-worker.js") && settled.some((k) => k.command === "gone-worker.js"),
    "…the name of the program it is actually running",
  );
  const named = kernel.diagnostics().procs.filter((p) => settled.some((k) => k.pid === p.pid));
  ok(
    named.length >= 2 && named.every((p) => p.command.trim().length > 0),
    "…and __vv.diag() names them too, which is where the report sends the user",
  );

  // Identified by SPAWN ORDER, not by name and not by the flags under test. The names
  // are what the checks above gate, so using them here would make one broken fix turn
  // every check below it red as well — and a gate that goes red for a reason other
  // than the one it names is worse than no gate. pool.js spawns the parking worker
  // first, so it holds the lower pid.
  const [parked, gone] = [...settled].sort((a, b) => a.pid - b.pid);

  // Read through the SHIPPED decision, not a local copy of it. An earlier version of
  // this gate re-implemented the rule, which meant it kept passing while asserting a
  // rule production no longer had — the way a change to the real one would have gone
  // unnoticed. `report` is exactly what the kernel worker calls.
  const report = (pid) => shouldReportStallFor(kernel, pid);

  // Defect 2a, the announced half: a thread parked on its parentPort says so, through
  // the same one message the shell's prompt uses, carrying which kind of waiting it is.
  ok(parked?.awaiting === "work", `a worker parked on its port announces it (${JSON.stringify(parked?.awaiting)})`);
  ok(!!parked?.everOutput, "…and this one HAS printed, so only the announcement can be excusing it");
  ok(!report(parked.pid), "…so the watchdog does not report it");

  // Defect 2b, the unannounceable half: a thread inside a synchronous native call runs
  // no JS at all, so nothing in it can announce anything. It is excused by never having
  // used the channel the watchdog measures — see shouldReportStall for why that is a
  // measurement rather than a category, and for what it admits to giving up.
  ok(gone && !gone.everOutput && !gone.awaiting, "a thread inside a native call announces nothing, because nothing in it runs");
  ok(isUnobservable(gone), "…and is marked as a thread nobody can watch");
  ok(!report(gone.pid), "…so it is not reported either, which is the four lines the user was actually seeing");

  // THE MIXED POOL, which is the state this whole compensation exists for and the one
  // the first version of it got wrong. Right now the pool holds both kinds at once —
  // one wedged thread nobody can watch, one healthy sibling parked for work — which is
  // the rolldown pool's actual shape. Every thread in it is excused, so if the parent
  // is excused too the wedge is reported NOWHERE, and it was reported before this
  // change. Asserted while both children are alive: killing the sibling first, which
  // is what this gate used to do, tests only the easy all-unobservable case.
  const kids = threadsOf(poolPid);
  ok(
    kids.some((k) => isUnobservable(k)) && kids.some((k) => !isUnobservable(k)),
    `the pool holds a watched and an unwatched child at once (${kids.length} live)`,
  );
  ok(report(poolPid), "…and its parent IS reported, so the wedge has somewhere to surface");

  // The control for that, and the reason it is a revocation rather than a mute: with
  // the unwatched child gone, the parent goes back to being excused by the sibling
  // that is still watched. Without this, "always report parents of threads" would pass
  // the check above and hand back the false positives this task started from.
  kernel.signal(gone.pid, "SIGKILL");
  const wedgedGone = await new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const live = threadsOf(poolPid);
      if (live.length === 1 && !isUnobservable(live[0])) return resolve(true);
      if (Date.now() - t0 > 15000) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
  ok(wedgedGone, "once the unwatched child exits, only the watched sibling is left");
  ok(!report(poolPid), "…and the parent is excused again, by the child that is still watched");

  // The other control, and the reason none of this is just "stop reporting threads": a
  // thread that HAS used the output channel and then goes quiet with nothing to excuse
  // it is still reported.
  kernel.procs.get(parked.pid).awaiting = null;
  ok(report(parked.pid), "a thread that printed and then went silent without announcing is STILL reported");

  try {
    kernel.signal(poolPid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

// A fork child rides the same spawn path as a worker thread and is flagged the same
// way on the wire, so the rule that stops watching threads will silence forks too
// unless the kernel resolves the difference before storing it. A fork that wedges
// before its first write is precisely a thing worth reporting: user code launched it
// by module path, so its name means something to the person reading, and there is no
// native call it could be trapped in that would make watching it pointless.
console.log("\n== a forked child is not a worker thread ==");
{
  kernel.writeFile(APP + "/fork-child.js", "setInterval(() => {}, 60000);\n");
  kernel.writeFile(
    APP + "/forker.js",
    "const { fork } = require('node:child_process');\n" +
      "process.stdout.write('forker up\\n');\n" +
      "fork('" + APP + "/fork-child.js');\n" +
      "setInterval(() => {}, 60000);\n",
  );
  const forkerPid = kernel.launch("node", ["forker.js"], { cwd: APP, env: ENV });
  const child = await new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const kid = [...kernel.procs.values()].find((p) => p.parentPid === forkerPid && !p.finalized);
      if (kid) return resolve(kid);
      if (Date.now() - t0 > 20000) return resolve(null);
      setTimeout(tick, 100);
    };
    tick();
  });
  ok(!!child, "a forked child is in the process table");
  ok(!!child && !child.everOutput, "…and this one has never printed, which is the whole of the unobservable rule");
  ok(!!child && !child.isThread, "…but it is not marked a worker thread, because it is not one");
  ok(!!child && !isUnobservable(child), "…so it is still watched");
  ok(!!child && shouldReportStallFor(kernel, child.pid), "…and a fork that goes quiet before its first write is still reported");

  try {
    kernel.signal(forkerPid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

fsWorker.terminate();
console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: all diag liveness checks passed");
process.exit(failed ? 1 : 0);