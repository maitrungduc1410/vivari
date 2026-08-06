// The `python` a transport check spawns: the SHIPPED launcher and the SHIPPED
// runtime, on the host, reading a blocking stdin.
//
// This exists because `scripts/spike-notebook-transport.mjs` needs a real
// program on PATH for the real shell to spawn, and because the interesting half
// of "the notebook does nothing" has always been on the far side of that spawn.
// Everything below the shebang line is production code:
//
//   * `PYTHON_PROGRAM` — the exact argv seam `/bin/python.js` is, so
//     `--vv-notebook-kernel <path>` is dispatched by the code that ships, not by
//     a copy of its `if`.
//   * `createPythonRuntime(...).install(indexUrl)` — the real runtime, so
//     `notebookKernel` runs the real `runSource` (moduleName + drive) and the
//     real `driveNotebook` read loop.
//   * the vendored Pyodide — the real interpreter, running the real
//     `kernel-source.js`.
//
// WHAT IS SUBSTITUTED, AND WHY IT IS STILL WORTH RUNNING. Three things are the
// host's rather than the VM's: `process` (an object handed to the runtime, not
// the real one — see below), `require` (host node: modules instead of the guest
// loader), and stdin (a blocking `readSync` on fd 0 instead of OP_READ_STDIN on a
// SharedArrayBuffer). The property that matters is preserved in each case: the
// read BLOCKS, so the driver's line reader parks its thread and has to be woken
// by a line written later — which is the shape the whole design rests on.
//
// SIGINT is the fourth, and it is MODELLED rather than stubbed — see the block
// below, which reproduces the kernel's own rule that a guest with no registered
// handler is terminated rather than signalled. That rule is the feature's central
// mechanism and stubbing it is what let a fatal interrupt window ship green.
//
// The injected `process` is not cosmetic. `bootPyodide` masks `process.browser =
// true` for the duration of the boot to defeat Pyodide's Node probe, which is
// right in a browser worker and wrong here; masking a private object leaves the
// real `globalThis.process` alone, so Pyodide detects Node, boots as Node, and
// the runtime code under test is unchanged.
import fs from "node:fs";
import { createRequire } from "node:module";

const ROOT = new URL("../..", import.meta.url).pathname;
const { PYTHON_PROGRAM } = await import(ROOT + "packages/kernel-host/programs/python.js");
const { createPythonRuntime } = await import(ROOT + "packages/runtime/builtins/python.js");
const { INTERRUPT_SIGINT } = await import(ROOT + "packages/protocol/syscall.js");

// A plain path, not a file: URL: Pyodide's Node loader joins `indexURL` with
// `pyodide.asm.mjs` as a path, and a URL there resolves against the cwd.
const INDEX_URL = process.env.VV_PYODIDE_INDEX_URL || ROOT + "packages/studio/public/vendor/pyodide/";

// The blocking stdin a guest gets from the kernel, in the terms the host has:
// bytes, end of input as `null`, and NOTHING in between. The VM's version parks
// the worker in `Atomics.wait` until the kernel hands it a chunk, and this parks
// the host thread in the same call for the same reason.
//
// The park is not a detail. Node leaves a spawned child's stdin pipe
// non-blocking, so an empty pipe is `EAGAIN` rather than a wait, and an EAGAIN
// answered with `""` is a lie in one direction or the other: `makeLineReader`
// spins on it, but Pyodide's `input()` reads an empty string as end of input —
// so the kernel's own read loop saw EOF the instant it started and the shell
// went straight back to a prompt. A stand-in that ends a program the real one
// keeps running is worse than no stand-in.
const rbuf = Buffer.alloc(65536);
const parking = new Int32Array(new SharedArrayBuffer(4));
globalThis.__ocReadStdin = () => {
  for (;;) {
    try {
      const n = fs.readSync(0, rbuf, 0, rbuf.length, null);
      // Zero bytes from a pipe is the writer having closed it: end of input.
      return n > 0 ? rbuf.subarray(0, n).toString("utf8") : null;
    } catch (e) {
      if (e && e.code === "EAGAIN") {
        Atomics.wait(parking, 0, 0, 2);
        continue;
      }
      if (e && (e.code === "EOF" || e.code === "EBADF")) return null;
      throw e;
    }
  }
};

const hostRequire = createRequire(import.meta.url);
const req = (name) => hostRequire(name.startsWith("node:") ? name : "node:" + name);
// Unbuffered, and by descriptor: a frame has to be on its way out before the
// next blocking read parks the thread, and process.stdout on a pipe is async.
const writer = (fd) => ({ write: (s) => { fs.writeSync(fd, typeof s === "string" ? s : Buffer.from(s)); return true; } });

// ── SIGINT, which is the one thing here that must NOT be a stub ──────────────
//
// The notebook's transport was chosen over the tidier `proc-*` channel for
// exactly one reason: it can deliver a signal. So a harness that stubs signals
// cannot say anything about the feature's central mechanism, and the first version
// of this file did stub them — `on: () => proc` — which is how "an interrupt during
// the wheel fetch kills the kernel" shipped behind a green suite.
//
// What the VM does, and therefore what this has to do:
//
//   * `process.on("SIGINT", …)` in a guest is announced to the kernel
//     (packages/runtime/signals.js). Registering a listener is what makes the
//     kernel POST the signal; with none registered the kernel APPLIES the default
//     action and the process is terminated immediately.
//   * Posting means two writes: the byte CPython polls (`INTERRUPT_SIGINT` in the
//     syscall SAB) and a message the guest emits on a loop turn.
//   * `signalHandled` is the guest saying "I took it and I am staying", which
//     stands the kernel's force-kill window down. Printed here as a marker line so
//     a spike can assert the promise was made — in the VM it is the only thing
//     keeping an interrupted kernel alive, and it is invisible from outside.
//
// WHAT THIS STILL CANNOT REPRODUCE: an interrupt while the interpreter is running
// a cell. The byte is what CPython polls mid-execution, and in the VM a different
// thread (the kernel's) writes it. Here there is one thread, and while Pyodide is
// inside synchronous Python no Node signal handler can run at all — so the byte
// is only ever written between turns. The fetch window IS between turns, which is
// why the case that shipped broken is gateable here and the running-cell case is
// still a tab's job.
const sigintHandlers = new Set();
// One byte of shared memory, as the kernel hands a guest one.
const interrupt = new Uint8Array(new SharedArrayBuffer(1));

process.on("SIGINT", () => {
  if (sigintHandlers.size === 0) {
    // The default action, as immediate as the kernel's: no handler, no promise to
    // keep. 130 is what a shell reports for a process killed by SIGINT.
    process.exit(130);
    return;
  }
  interrupt[0] = INTERRUPT_SIGINT;
  // On a turn, not synchronously — signals.js delivers from the event loop so that
  // a handler calling process.exit() is honoured as an exit.
  for (const fn of [...sigintHandlers]) setImmediate(() => fn("SIGINT"));
});

const proc = {
  argv: ["node", "/bin/python.js", ...process.argv.slice(2)],
  env: { ...process.env, VV_PYODIDE_INDEX_URL: INDEX_URL },
  cwd: () => process.cwd(),
  platform: "linux",
  versions: { node: process.versions.node },
  stdout: writer(1),
  stderr: writer(2),
  on: (name, fn) => {
    if (name === "SIGINT" && typeof fn === "function") sigintHandlers.add(fn);
    return proc;
  },
  once: (name, fn) => proc.on(name, fn),
  off: (name, fn) => proc.removeListener(name, fn),
  removeListener: (name, fn) => {
    if (name === "SIGINT") sigintHandlers.delete(fn);
    return proc;
  },
  nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)),
  // What the runtime's own process.exit does: unwind by throwing, tagged, which
  // is what PYTHON_PROGRAM's main().catch already knows how to read. The catch
  // there SWALLOWS that tag — in the VM the kernel already has the code and
  // tears the process down itself — so the host has to be the one that leaves,
  // and it has to do it after the throw has finished unwinding.
  exit: (c) => {
    const e = new Error("exit");
    e.__processExit = c | 0;
    setImmediate(() => process.exit(c | 0));
    throw e;
  },
};

const py = createPythonRuntime({
  process: proc,
  require: req,
  trackHost: () => {},
  interrupt,
  // The stand-down the kernel needs to hear, made observable: without it a VM
  // kernel that armed and took an interrupt would still be force-killed, and no
  // assertion outside this process could tell.
  signalHandled: (name) => fs.writeSync(2, `<vv-signal-handled ${name}>\n`),
}).install(INDEX_URL);

const fn = new Function("require", "module", "process", "globalThis", PYTHON_PROGRAM);
try {
  // NOT awaited to completion: the program body ends in `main().catch(...)` and
  // returns the moment `main` first suspends. Exiting here would kill the child
  // before Pyodide had booted — which it did, and which is why this comment is
  // longer than the line it guards. `proc.exit` above is what ends this process.
  await fn(hostRequire, { exports: {} }, proc, { __ocInstallPython: () => py, setTimeout, clearTimeout });
} catch (e) {
  if (typeof e?.__processExit === "number") process.exit(e.__processExit);
  fs.writeSync(2, "python: " + ((e && e.stack) || e) + "\n");
  process.exit(1);
}
