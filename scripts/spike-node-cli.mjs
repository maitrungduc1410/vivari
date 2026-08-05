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

console.log(failed === 0 ? "\nnode CLI: OK" : `\nnode CLI: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
