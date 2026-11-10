// Spike (OFFLINE): a process learns its terminal's size, and hears when it changes.
//
// TUIs (ink, blessed, enquirer, anything drawing a progress bar) lay themselves out
// from process.stdout.columns/rows and redraw on stdout 'resize' / SIGWINCH. The VM
// used to say 80x24 forever. Now the spawner passes a size (the studio's xterm,
// Vivari.spawn's `terminal`), children inherit it, and Kernel#resize updates the
// whole tree under a pid.
//
// What this pins, all inside real guest processes:
//   • the size given at launch is what the first line of the program sees,
//     including through tty.WriteStream;
//   • a child spawned by it inherits that size;
//   • resize() reaches both, in Node's order: the new size is already in place
//     when stdout 'resize' fires, and 'resize' comes before process 'SIGWINCH'.
//     That order was measured on host Node 24 under a real pty (TIOCSWINSZ):
//     stdout 'resize', stderr 'resize', then SIGWINCH with the new size visible;
//   • SIGWINCH does not terminate a process with no listener (its POSIX default
//     action is to ignore it), and a listener does not keep the loop alive;
//   • a repeat of the current size, a bad size and an unknown pid do nothing.
//
// The studio xterm and SDK wiring around Kernel#resize is browser-only and not
// covered here.
//
//   run:  node scripts/spike-terminal-size.mjs

import { bootSpikeKernel } from "./lib/spike-harness.mjs";

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};

const h = await bootSpikeKernel();
const { kernel } = h;
kernel.mkdirp("/app");

kernel.writeFile(
  "/app/child.js",
  `const log = (s) => process.stdout.write(s + "\\n");
log("child start " + process.stdout.columns + "x" + process.stdout.rows);
process.stdout.on("resize", () => {
  log("child resize " + process.stdout.columns + "x" + process.stdout.rows);
  process.exit(0);
});
log("child-ready");
setInterval(() => {}, 1000);
`,
);
kernel.writeFile(
  "/app/main.js",
  `const tty = require("tty");
const { spawn } = require("child_process");
const log = (s) => process.stdout.write(s + "\\n");
log("start " + process.stdout.columns + "x" + process.stdout.rows + " stderr " + process.stderr.columns + "x" + process.stderr.rows);
log("tty.WriteStream " + new tty.WriteStream(1).columns + "x" + new tty.WriteStream(1).rows);
const events = [];
process.stdout.on("resize", () => events.push("stdout-resize " + process.stdout.columns + "x" + process.stdout.rows));
process.stderr.on("resize", () => events.push("stderr-resize"));
let winches = 0;
process.on("SIGWINCH", (sig) => {
  winches++;
  events.push("SIGWINCH " + sig);
  log("events " + events.join(" | "));
  events.length = 0;
});
const child = spawn("node", ["/app/child.js"], { stdio: "inherit" });
child.on("exit", (code) => {
  log("child exit " + code);
  // Let the second resize land, then end on our own: a SIGWINCH listener must
  // not be what keeps this process alive.
  setTimeout(() => {
    log("winches " + winches);
    process.removeAllListeners("SIGWINCH");
  }, 400);
});
log("ready");
`,
);
// A process with no SIGWINCH listener at all: a resize must not end it.
kernel.writeFile(
  "/app/plain.js",
  `process.stdout.write("plain up\\n");
setTimeout(() => process.stdout.write("plain still alive " + process.stdout.columns + "\\n"), 600);
`,
);

const waitFor = async (re, ms = 20000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (re.test(h.out.join(""))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

console.log("== launch at 120x40 ==");
let exitCode = null;
const before = new Set(kernel.procs.keys());
const done = kernel.start("node", ["/app/main.js"], { cwd: "/app", winsize: { cols: 120, rows: 40 } }).then((r) => (exitCode = r.code));
const pid = [...kernel.procs.keys()].find((p) => !before.has(p));
ok(await waitFor(/ready[\s\S]*child-ready|child-ready[\s\S]*ready/), "parent and child both started");

console.log("\n== resize to 100x30 ==");
ok(kernel.resize(pid, 100, 30) === true, "resize() accepts the pid");
ok(await waitFor(/child exit 0/), "the child heard the resize and exited");
ok(kernel.resize(pid, 100, 30) === true, "a repeat of the same size is accepted");
ok(kernel.resize(pid, 0, 30) === false && kernel.resize(pid, 1.5, 3) === false && kernel.resize(99999, 80, 24) === false, "a bad size or an unknown pid is refused");
kernel.resize(pid, 90, 20);
await Promise.race([done, new Promise((r) => setTimeout(r, 20000))]);

const out = h.out.join("");
console.log(out.replace(/^/gm, "    | "));
ok(/start 120x40 stderr 120x40/.test(out), "the size given at launch is what the program's first line sees, on stdout and stderr");
ok(/tty\.WriteStream 120x40/.test(out), "tty.WriteStream(1) agrees with process.stdout");
ok(/child start 120x40/.test(out), "a child inherits its parent's terminal size");
ok(/child resize 100x30/.test(out), "resize reaches a descendant, with the new size in place when 'resize' fires");
ok(/events stdout-resize 100x30 \| stderr-resize \| SIGWINCH SIGWINCH/.test(out), "parent: stdout 'resize' (size already updated), stderr 'resize', then SIGWINCH");
ok((out.match(/events /g) || []).length === 2 && /events stdout-resize 90x20/.test(out), "a repeated size fired nothing; the next real change fired once");
ok(/winches 2/.test(out), "exactly two SIGWINCH deliveries for two real changes");
ok(exitCode === 0, "the process ended on its own with exit 0; a SIGWINCH listener did not hold it (exit " + exitCode + ")");

console.log("\n== no listener: SIGWINCH is ignored ==");
h.out.length = 0;
const before2 = new Set(kernel.procs.keys());
const plainDone = kernel.start("node", ["/app/plain.js"], { cwd: "/app" });
const plainPid = [...kernel.procs.keys()].find((p) => !before2.has(p));
await waitFor(/plain up/);
kernel.resize(plainPid, 132, 50);
const pr = await plainDone;
const plainOut = h.out.join("");
ok(/plain still alive 132/.test(plainOut) && pr.code === 0, "a process with no SIGWINCH listener keeps running and sees the new size (exit " + pr.code + ")");
h.out.length = 0;
await kernel.start("node", ["-e", "process.stdout.write(process.stdout.columns + 'x' + process.stdout.rows + '\\n')"], { cwd: "/app" });
ok(/^80x24$/m.test(h.out.join("")), "no size given means 80x24, as before (" + h.out.join("").trim() + ")");

console.log(failed ? `\nFAIL: ${failed} check(s)` : "\nPASS: processes see their terminal size and hear it change");
process.exit(failed ? 1 : 0);
