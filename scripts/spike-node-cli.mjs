// Spike (OFFLINE): `node` the command — main module, -r preloads, and how a program
// is allowed to end.
//
// WHY THIS EXISTS. `node` inside the VM is a shim (/bin/node.js, coreutils.js) that
// loads the user's program. How it did that leaked in three ways that all looked like
// the program's fault:
//
//   • It ran the entry with `require(abs)`, so the entry was an ordinary child of the
//     shim and `require.main` stayed /bin/node.js. `if (require.main === module)` —
//     the guard a large share of npm's CLIs are built around — was false, and those
//     programs loaded their imports and then quietly did nothing.
//   • `-r <bare>` was resolved from the shim's own directory, so `node -r
//     dotenv/config app.js` reported "Cannot find module 'dotenv/config' from '/bin'":
//     a project could not preload its own dependencies.
//   • A program that ended while its main module was still suspended on a top-level
//     await exited 0, in silence. Node exits 13 and says so. Exit 0 is the one answer
//     that cannot be debugged, because it is indistinguishable from success.
//
// And 'beforeExit' was never emitted at all — the event whose entire purpose is to let
// a listener schedule more work before the process ends.
//
// HOW IT IS GATED. Every case runs on the HOST's real Node and in the VM, and the
// transcripts must match. The unsettled-await case compares the exit code and whether
// a warning was printed, not the warning's text: Node's includes the source line and
// a caret drawn from V8's promise state, which we do not have.
//
//   run:  node scripts/spike-node-cli.mjs

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

// The project the cases run in: a program, a local dependency to preload, and a
// handful of entries that each end in a different way.
const FILES = {
  "main.js": `console.log('isMain=' + (require.main === module));
console.log('mainIsSelf=' + (!!require.main && require.main.filename === __filename));
console.log('argv1IsSelf=' + (process.argv[1] === __filename));
`,
  "beforeexit.js": `let rounds = 0;
process.on('beforeExit', (code) => {
  rounds++;
  console.log('beforeExit#' + rounds + ' code=' + code);
  // The event's point: a listener may schedule more work, and the loop must pick it
  // up. Twice, then stop, so the transcript is finite.
  if (rounds < 3) setTimeout(() => console.log('work after beforeExit#' + rounds), 1);
});
process.on('exit', (code) => console.log('exit code=' + code));
console.log('main done');
`,
  "beforeexit-explicit.js": `process.on('beforeExit', () => console.log('beforeExit MUST NOT RUN'));
process.on('exit', (code) => console.log('exit code=' + code));
console.log('calling exit');
process.exit(0);
`,
  "settled-await.mjs": `await new Promise((r) => setTimeout(r, 10));
console.log('top-level await settled');
`,
  "unsettled-await.mjs": `console.log('about to hang');
await new Promise(() => {});
console.log('unreachable');
`,
  "exitcode.js": `process.exitCode = 4;
process.on('beforeExit', (code) => console.log('beforeExit code=' + code));
`,
  // For --check. `syntax-ok.js` parses, `syntax-bad.js` does not, and `loud.js` says
  // so if it is ever RUN — which is what --check used to do to it.
  "syntax-ok.js": `const x = 1;
module.exports = x;
`,
  "syntax-bad.js": `const x = ;
`,
  // A bare process.exit() takes process.exitCode, not 0. The two-step shape half of
  // npm's CLIs use — exitCode set somewhere deep, a bare exit() at the end — used to
  // report success for a run that had failed.
  "exit-bare.js": `process.exitCode = 7;
process.exit();
`,
  "exit-bare-unset.js": `process.exit();
`,
  "loud.js": `console.log('EXECUTED');
`,
  // --check went through the loader's compileWrapper, which uses indirect eval so it
  // can attach a sourceURL. A body can CLOSE THAT WRAPPER EARLY and run whatever
  // follows, which evaluates as a complete script — so --check ran the file it exists
  // to avoid running. The Function constructor cannot be escaped that way. The host
  // rejects this too, so it is held to parity rather than asserted one-sidedly.
  "escape.js": `}); process.stdout.write('SIDE-EFFECT-RAN'); (function(){
`,
};
const DEP = {
  "node_modules/mydep/package.json": JSON.stringify({ name: "mydep", version: "1.0.0", main: "index.js" }),
  "node_modules/mydep/index.js": "console.log('mydep preloaded');\n",
  "local-preload.js": "console.log('local preload');\n",
};

// argv for each case, and what the transcript records about it.
const CASES = [
  ["main-module", ["main.js"]],
  ["preload-bare", ["-r", "mydep", "main.js"]],
  ["preload-relative", ["-r", "./local-preload.js", "main.js"]],
  ["preload-missing", ["-r", "no-such-package", "main.js"]],
  ["eval-require-from-cwd", ["-e", "require('mydep'); console.log('eval done')"]],
  ["beforeexit-reschedules", ["beforeexit.js"]],
  ["beforeexit-skipped-on-exit", ["beforeexit-explicit.js"]],
  ["settled-top-level-await", ["settled-await.mjs"]],
  ["unsettled-top-level-await", ["unsettled-await.mjs"]],
  ["exitcode-set", ["exitcode.js"]],
  // The argv parser used to drop every flag it did not recognise, so a typo and a
  // request it could not honour both exited 0. These four are the cases where the
  // honest answer is also the one real node gives, so they can be held to parity.
  ["check-parses", ["--check", "syntax-ok.js"]],
  ["check-rejects", ["--check", "syntax-bad.js"]],
  ["check-does-not-run", ["--check", "loud.js"]],
  ["check-cannot-be-escaped", ["--check", "escape.js"]],
  ["bad-option", ["--bogus", "main.js"]],
  ["exit-honours-exitcode", ["exit-bare.js"]],
  ["exit-bare-still-zero", ["exit-bare-unset.js"]],
  // Everything after `--` is the program: breaking out of the parse loop with no entry
  // meant this ran nothing and said nothing. Pre-existing, but in the loop this commit
  // rewrote, so it is pinned here now.
  ["double-dash-runs-the-entry", ["--", "main.js"]],
];

// The transcript for one run. The unsettled-await warning is reduced to a yes/no:
// Node's text carries the source line and a caret we cannot reproduce.
const transcribe = (name, code, stdout, stderr) => {
  const all = (stdout || "") + (stderr || "");
  const warned = /Detected unsettled top-level await/.test(all);
  const lines = (stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // stderr is reduced to the facts both sides can be held to. Node frames its errors
  // with internal file/line context ("node:internal/modules/cjs/loader:1433") and
  // draws a caret under the offending source, neither of which we reproduce; what
  // must match is WHICH failure happened, and whether the program ran at all.
  const notFound = /Cannot find module/.test(all);
  return `${name} exit=${code} warned=${warned} notFound=${notFound} out=[${lines.join(" | ")}]`;
};

// ── the host's real Node ─────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vv-node-cli-"));
for (const [rel, body] of Object.entries({ ...FILES, ...DEP })) {
  const f = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
}
const hostCases = [];
for (const [name, argv] of CASES) {
  let stdout = "";
  let stderr = "";
  let code = 0;
  try {
    stdout = execFileSync(process.execPath, argv, { cwd: tmp, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    code = typeof e.status === "number" ? e.status : 1;
    stdout = e.stdout || "";
    stderr = e.stderr || "";
  }
  hostCases.push(transcribe(name, code, stdout, stderr));
}

// ── and the VM ───────────────────────────────────────────────────────────────
const h = await bootSpikeKernel();
const kernel = h.kernel;
kernel.mkdirp("/app/node_modules/mydep");
writeProject(kernel, "/app", FILES);
for (const [rel, body] of Object.entries(DEP)) kernel.writeFile("/app/" + rel, body);

const vmCases = [];
for (const [name, argv] of CASES) {
  const r = await kernel.start("node", argv, { cwd: "/app", capture: true });
  vmCases.push(transcribe(name, r.code, r.stdout, r.stderr));
}

const byName = (cases) =>
  new Map(
    cases.map((l) => {
      const n = l.split(" ")[0];
      return [n, l.slice(n.length + 1)];
    }),
  );
const hostByName = byName(hostCases);
const vmByName = byName(vmCases);

console.log(`node CLI: ${hostByName.size} cases on the host, ${vmByName.size} in the VM`);

for (const [name, hostLine] of hostByName) {
  const vmLine = vmByName.get(name);
  if (hostLine === vmLine) {
    ok(true, name);
  } else {
    ok(false, name);
    console.log(`      host: ${hostLine}`);
    console.log(`      vm:   ${vmLine}`);
  }
}

// ── the two groups that CANNOT be held to host parity ────────────────────────
// Real node implements --watch and --test, so a differential case would only ever
// report that we are not node. What is worth pinning is the SHAPE of the answer: a
// flag whose whole job we cannot do is refused by name, and a flag that merely asks
// for a refinement we cannot offer is still allowed to run the program. Getting that
// line wrong in either direction is a regression — silence for the first group is the
// bug this replaced, and an error for the second breaks working projects.
console.log("\na flag we cannot honour is refused BY NAME, not dropped");
for (const [flag, argv] of [
  // --watch and --watch-path used to be here and are now implemented (see
  // spike-watch.mjs). Moving an entry out of this list is what implementing one
  // looks like; the list is the inventory of what is still owed.
  ["--test", ["--test"]],
  ["--run", ["--run", "build"]],
]) {
  const r = await kernel.start("node", argv, { cwd: "/app", capture: true });
  const err = r.stderr || "";
  ok(
    r.code === 9 && err.includes(flag) && /not implemented/.test(err),
    `${flag}: exits 9 naming itself — ${JSON.stringify(err.trim().slice(0, 72))}`,
  );
  // The refusal has to happen INSTEAD of the run, or it is just a warning.
  ok(!/isMain=/.test(r.stdout || ""), `${flag}: …and the script does not run anyway`);
}

console.log("\na flag that only asks for a refinement still runs the program");
for (const argv of [
  ["--enable-source-maps", "main.js"],
  ["--max-old-space-size=4096", "main.js"],
  ["--no-warnings", "main.js"],
  ["--experimental-strip-types", "main.js"],
  ["--inspect", "main.js"],
  ["--trace-uncaught", "main.js"],
  ["--conditions", "development", "main.js"],
  // Six that real node accepts and this parser used to answer `bad option` to. They are
  // group 2 by the definition above — the program still does its job — so refusing them
  // was a misclassification, not a policy. --stack-trace-limit (error-reporting
  // libraries) and --nolazy (debugger configs) are the two seen in practice.
  ["--stack-trace-limit=50", "main.js"],
  ["--nolazy", "main.js"],
  ["--es-module-specifier-resolution=node", "main.js"],
  ["--optimize-for-size", "main.js"],
  ["--force-context-aware", "main.js"],
  ["--http-parser=legacy", "main.js"],
]) {
  const r = await kernel.start("node", argv, { cwd: "/app", capture: true });
  ok(
    r.code === 0 && /isMain=true/.test(r.stdout || ""),
    `${argv[0]}: exit ${r.code}, script ran — ${JSON.stringify((r.stderr || "").trim().slice(0, 60))}`,
  );
}

// ── a pipe on fd 0 is not a terminal ─────────────────────────────────────────
// `node` with no script has to answer two different questions, and it used to answer
// only one: a terminal gets a REPL, a PIPE gets its program read from stdin. isTTY was
// derived from the kernel's `capture` flag, which is a narrower question ("can anybody
// type at us") than "is fd 0 a terminal" — a pipeline stage is not captured and yet its
// stdin is a pipe. So `echo 'console.log(1)' | node` opened a prompt and fed the
// program text to it as keystrokes.
//
// Held to host parity, through a shell on both sides so the pipe is real.
console.log("\na pipe or a redirect on stdin is not a terminal");
{
  const TTY_PROBE = "console.log('isTTY=' + process.stdin.isTTY);";
  fs.writeFileSync(path.join(tmp, "tty-probe.js"), TTY_PROBE + "\n");
  kernel.writeFile("/app/tty-probe.js", TTY_PROBE + "\n");
  fs.writeFileSync(path.join(tmp, "prog.js"), "console.log('PROG-RAN');\n");
  kernel.writeFile("/app/prog.js", "console.log('PROG-RAN');\n");

  const SHELL_CASES = [
    ["pipe-into-script", "echo hi | \"$NODE\" tty-probe.js"],
    ["redirect-into-script", "\"$NODE\" tty-probe.js < prog.js"],
    ["plain-script", "\"$NODE\" tty-probe.js < /dev/null"],
    ["pipe-a-program-in", "echo 'console.log(1)' | \"$NODE\""],
    // `-` is node's own spelling for "the program is on stdin". It is not a flag, so it
    // must not reach the flag branch, where it matches no prefix and was reported as a
    // bad option.
    ["dash-means-stdin", "echo 'console.log(2)' | \"$NODE\" -"],
    ["redirect-a-program-in", "\"$NODE\" < prog.js"],
  ];
  for (const [name, cmd] of SHELL_CASES) {
    let hostOut = "";
    try {
      hostOut = execFileSync("/bin/sh", ["-c", cmd], {
        cwd: tmp,
        encoding: "utf8",
        timeout: 30000,
        env: { ...process.env, NODE: process.execPath },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      hostOut = (e.stdout || "") + (e.stderr || "");
    }
    // The VM's `sh` resolves `node` off PATH, so $NODE is just the name there.
    const vm = await kernel.start("sh", ["-c", cmd.replace(/"\$NODE"/g, "node")], {
      cwd: "/app",
      env: { PATH: "/bin", HOME: "/app", PWD: "/app", NODE: "node" },
      capture: true,
    });
    const vmOut = (vm.stdout || "") + (vm.stderr || "");
    ok(
      hostOut.trim() === vmOut.trim(),
      `${name}: host and vm agree — ${JSON.stringify(vmOut.trim().slice(0, 40))}`,
    );
    if (hostOut.trim() !== vmOut.trim()) {
      console.log(`      host: ${JSON.stringify(hostOut.trim().slice(0, 60))}`);
      console.log(`      vm:   ${JSON.stringify(vmOut.trim().slice(0, 60))}`);
    }
  }
}

console.log(failed === 0 ? "\nnode CLI: OK" : `\nnode CLI: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
