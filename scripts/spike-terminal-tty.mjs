// Spike (OFFLINE): a program whose stdout is the terminal sees a TTY, and one whose
// stdout is a pipe does not; full-screen programs can read keys and move the cursor.
//
// WHY THIS EXISTS. process.stdout.isTTY was false for every process, so a program
// the interactive shell ran in the foreground could not tell it was drawing on a
// terminal. Nuxt's `nuxt dev` shows its dashboard (status panel, logs view,
// single-key shortcuts) only when stdout and stdin are TTYs, so it fell back to
// plain logs; and readline.emitKeypressEvents was a no-op, so the dashboard would
// not have heard its keys anyway. Now:
//   • the kernel decides `outputTty` per process (kernel-host/kernel.js
//     createProcess): a top-level process has it when it was given a terminal size
//     and is not captured; a child has it when it inherits its parent's terminal
//     stdout (child_process `stdio: 'inherit'`), which the shell does for a single
//     foreground command. A pipeline stage, a redirect, a captured run and a
//     `stdio: 'pipe'` child keep writing into a pipe, and stay false.
//   • a TTY stdout/stderr has tty.WriteStream's methods (builtins/process.js).
//   • emitKeypressEvents is Node's (node/internal/readline), and readline's cursor
//     helpers write Node's sequences to a TTY stream.
//
//   run:  node scripts/spike-terminal-tty.mjs

import { bootSpikeKernel } from "./lib/spike-harness.mjs";

let failed = 0;
const ok = (cond, msg, got) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg + (got !== undefined ? `  (${JSON.stringify(got)})` : ""));
  if (!cond) failed++;
};

const h = await bootSpikeKernel();
const k = h.kernel;
k.mkdirp("/tmp");
const SIZE = { cols: 100, rows: 30 };
const PROBE =
  "const t=require('tty');process.stdout.write(JSON.stringify({out:!!process.stdout.isTTY,err:!!process.stderr.isTTY,isatty:t.isatty(1),depth:process.stdout.getColorDepth?.()??null})+'\\n')";

// What the probe printed, out of everything the kernel's own terminal received.
async function probe(command, args, opts) {
  const start = h.out.length;
  const r = await k.start(command, args, { cwd: "/", env: { PATH: "/bin", TERM: "xterm-256color" }, ...opts });
  const text = (r.stdout || "") + h.out.slice(start).join("");
  const line = text.split("\n").find((l) => l.startsWith("{"));
  return line ? JSON.parse(line) : { missing: text.slice(-300) };
}

console.log("== who gets a TTY ==");
let p = await probe("node", ["-e", PROBE], { winsize: SIZE });
ok(p.out && p.err && p.isatty, "a top-level process given a terminal: stdout and stderr are TTYs, tty.isatty(1)", p);
ok(p.depth === 8, "…and getColorDepth() reads TERM=xterm-256color as 8 bits", p.depth);
p = await probe("node", ["-e", PROBE], {});
ok(p.out === false && p.isatty === false, "no terminal given: not a TTY", p);
p = await probe("node", ["-e", PROBE], { winsize: SIZE, capture: true });
ok(p.out === false, "captured output, even with a size: not a TTY", p);
p = await probe("sh", ["-c", `node -e "${PROBE.replace(/"/g, '\\"')}"`], { winsize: SIZE });
ok(p.out === true && p.err === true, "the shell's single foreground command inherits the terminal", p);
p = await probe("sh", ["-c", `node -e "${PROBE.replace(/"/g, '\\"')}" | cat`], { winsize: SIZE });
ok(p.out === false, "a pipeline stage writes into a pipe: not a TTY", p);
k.writeFile("/tmp/child.js", `const cp = require('child_process');
(async () => {
  for (const stdio of ['pipe', 'inherit']) {
    const c = cp.spawn('node', ['-e', ${JSON.stringify(PROBE)}], { stdio });
    if (stdio === 'pipe') c.stdout.on('data', (d) => process.stdout.write('pipe ' + d));
    await new Promise((resolve) => c.on('close', resolve));
  }
})();`);
{
  const start = h.out.length;
  await k.start("node", ["/tmp/child.js"], { cwd: "/", env: { PATH: "/bin" }, winsize: SIZE });
  const text = h.out.slice(start).join("");
  const piped = text.match(/pipe (\{.*\})/);
  const inherited = text.split("\n").find((l) => l.startsWith("{"));
  ok(piped && JSON.parse(piped[1]).out === false, "child_process stdio 'pipe': not a TTY", piped && piped[1]);
  ok(inherited && JSON.parse(inherited).out === true, "child_process stdio 'inherit' from a TTY: a TTY", inherited);
}

console.log("== keys and the cursor ==");
k.writeFile("/tmp/keys.js", `const readline = require('readline');
readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
const seen = [];
process.stdin.on('keypress', (s, key) => {
  seen.push(key.name + (key.ctrl ? '+ctrl' : ''));
  if (key.name === 'q') {
    readline.cursorTo(process.stdout, 3);
    readline.moveCursor(process.stdout, -1, 2);
    readline.clearLine(process.stdout, 0);
    process.stdout.write('KEYS ' + seen.join(',') + '\\n');
    process.exit(0);
  }
});`);
{
  const start = h.out.length;
  const pid = k.launch("node", ["/tmp/keys.js"], { cwd: "/", env: { PATH: "/bin" }, winsize: SIZE });
  await new Promise((r) => setTimeout(r, 1500));
  k.sendStdin(pid, new TextEncoder().encode("l\x1b[A\x1b[Bxq"));
  for (let i = 0; i < 40 && !h.out.slice(start).join("").includes("KEYS"); i++) await new Promise((r) => setTimeout(r, 100));
  const text = h.out.slice(start).join("");
  ok(/KEYS l,up,down,x,q/.test(text), "emitKeypressEvents parses letters and arrow keys", text.match(/KEYS \S*/)?.[0]);
  ok(text.includes("\x1b[4G\x1b[1D\x1b[2B\x1b[2K"), "cursorTo / moveCursor / clearLine write Node's sequences to a TTY", text.slice(0, 40));
}
{
  const start = h.out.length;
  await k.start("node", ["-e", "require('readline').cursorTo(process.stdout, 3); process.stdout.write('DONE')"], { cwd: "/", env: { PATH: "/bin" } });
  const text = h.out.slice(start).join("");
  ok(text === "DONE", "…and nothing to a stream that is not one", text);
}

console.log("== Ctrl-C in the interactive shell ==");
// The shell turns Ctrl-C into one SIGINT for its foreground job. It used to arrive
// twice when the handler made a syscall (the kernel's message and the SAB bit
// each delivered it, see dispatchSignalEvent in runtime/index.js), and Nuxt's dev
// server reads a second Ctrl-C as "exit now".
k.writeFile("/tmp/ctrlc.js", `const fs = require('fs');
process.stdin.setRawMode(true);
process.on('SIGINT', () => {
  fs.appendFileSync('/tmp/ctrlc.log', 'SIGINT\\n');
  setTimeout(() => process.exit(0), 500);
});
fs.writeFileSync('/tmp/ctrlc.log', '');
process.stdout.write('READY\\n');
setInterval(() => {}, 1000);`);
{
  const start = h.out.length;
  const sh = k.launch("sh", [], { cwd: "/", env: { PATH: "/bin" }, winsize: SIZE });
  await new Promise((r) => setTimeout(r, 1500));
  k.sendStdin(sh, new TextEncoder().encode("node /tmp/ctrlc.js\r"));
  for (let i = 0; i < 50 && !h.out.slice(start).join("").includes("READY"); i++) await new Promise((r) => setTimeout(r, 100));
  k.sendStdin(sh, new TextEncoder().encode("\x03"));
  await new Promise((r) => setTimeout(r, 1500));
  const log = k.readFile("/tmp/ctrlc.log");
  ok(log === "SIGINT\n", "one Ctrl-C is one SIGINT, though the handler makes a syscall", log);
  k.stop(sh);
}

console.log(failed ? `\nFAILED: ${failed}` : "\nPASS: the terminal is a TTY to the programs drawing on it, and only to them");
process.exit(failed ? 1 : 0);
