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
  w.postMessage({ type: "init", sab: info.sab, spec: info.spec, fsPort: port1 }, [port1]);
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

const kernel = new Kernel({ fs: kernelFs.fs, spawnWorker, stdout: () => {}, stderr: () => {} });
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
    kernel.kill(pid, "SIGKILL");
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

fsWorker.terminate();
console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: all diag liveness checks passed");
process.exit(failed ? 1 : 0);