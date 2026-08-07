// Spike (OFFLINE): a synchronously spawned child's stdin — `input`, and the EOF
// that has to follow it.
//
// WHY THIS EXISTS. `spawnSync('cat', [], { input: 'hi' })` HUNG the guest. Not
// failed — hung, with no error, no timeout and no output, until something killed
// the tab. Two halves, and either one alone is enough to hang:
//
//   • `input` was never read. The string is not in child_process.js at all, so the
//     option was accepted and dropped, and the child sat waiting for bytes that
//     were never sent. `execSync(cmd, { input })` rides the same path.
//   • Nothing ever closed a sync child's stdin. The caller is parked on
//     Atomics.wait from the moment it spawns until the child exits, so it CANNOT
//     write to the pipe — there is no later. Any program that reads to end of
//     input (`cat` with no file operand is the small case; a formatter or a linter
//     reading a file from a pipe is the real one) waited for an EOF that had no
//     sender. So `spawnSync('cat')` with no input hung too.
//
// The third half is `sh`. `execSync('cat', { input })` becomes `sh -c cat`, and
// `cat` is a different process: the input lands on the SHELL's stdin, and unless
// the shell hands it to the first stage of its foreground job — which is all
// "inherit" means — the grandchild still hangs.
//
// WHAT IS PINNED HERE. Every case runs on the host's real Node and in the VM, and
// the transcripts must match. The regression cases matter as much as the fixes:
// `sh` now subscribes to its own stdin, and a subscriber that refs the loop would
// stop every async `sh -c 'node server.js'` from ever exiting, so a plain
// `execSync('echo hi')` and an async `exec` are held to finishing too.
//
//   run:  node scripts/spike-child-stdin.mjs

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

// `NODE` is the one thing the two sides spell differently: the host runs its own
// executable, the VM runs the `node` on its PATH.
const program = (node) => `
const cp = require('child_process');
// Printed as they happen, not collected: the failure this spike is about is a
// hang, and a transcript that is only flushed at the end tells you nothing about
// which case never returned.
const say = (name, fn) => {
  let r;
  try { r = fn(); } catch (e) { r = 'THREW ' + (e.code || '') + ' ' + String(e.message).slice(0, 60); }
  console.log(name + ' ' + r);
};
const NODE = ${JSON.stringify(node)};

// input, the plain case.
say('spawnSync-input', () => {
  const r = cp.spawnSync('cat', [], { input: 'hi there', encoding: 'utf8' });
  return JSON.stringify(r.stdout) + ' status=' + r.status;
});

// No input at all: stdin is an empty pipe that is ALREADY closed, so a reader
// gets end-of-input immediately rather than waiting for one.
say('spawnSync-no-input', () => {
  const r = cp.spawnSync('cat', [], { encoding: 'utf8' });
  return JSON.stringify(r.stdout) + ' status=' + r.status;
});

// Through the shell: the bytes arrive at \`sh\`, the reader is its child.
say('execSync-input', () => JSON.stringify(cp.execSync('cat', { input: 'a\\nb\\n', encoding: 'utf8' })));

// A real reader, not a coreutil: what most tools actually are.
say('execSync-node-reader', () => {
  const r = cp.execSync(NODE + ' reader.js', { input: 'four', encoding: 'utf8' });
  return JSON.stringify(r);
});

// Binary in, binary out. A string would have been mangled to utf8 on the way.
say('spawnSync-binary', () => {
  const r = cp.spawnSync(NODE, ['hex.js'], { input: Buffer.from([0, 1, 2, 254, 255]), encoding: 'utf8' });
  return JSON.stringify(r.stdout.trim());
});

// A view into a larger buffer sends its own slice, not the whole allocation.
say('spawnSync-subarray', () => {
  const big = Buffer.from('XXXhelloXXX');
  const r = cp.spawnSync('cat', [], { input: big.subarray(3, 8), encoding: 'utf8' });
  return JSON.stringify(r.stdout);
});

// An empty input is still an input: the child reads nothing and ends.
say('spawnSync-empty-input', () => {
  const r = cp.spawnSync('cat', [], { input: '', encoding: 'utf8' });
  return JSON.stringify(r.stdout) + ' status=' + r.status;
});

// WHICH children have a stdin at all. \`child.stdin\` is a stream only when the
// parent holds the write end of fd 0 — a pipe. For 'inherit' and 'ignore' node
// answers null, because fd 0 then belongs to somebody else and the parent has no
// end of it to write to.
//
// This is not decoration: \`if (child.stdin)\` is how a caller ASKS which it got.
// npm's run-script does \`if (p.stdin) p.stdin.end()\`, correct against node, where
// a script spawned with stdio:'inherit' answers null. We answered with an object,
// so npm sent EOF to a child that had inherited the terminal — and vite treats
// end-of-stdin as "my parent is gone" and shuts the dev server down. Every Vite
// template's \`npm run dev\` died seconds after printing its URL.
const shape = (stdio) => {
  const c = cp.spawn(NODE, ['noop.js'], stdio === undefined ? {} : { stdio });
  const s = c.stdin === null ? 'null' : c.stdin === undefined ? 'undefined' : 'stream';
  const zero = Array.isArray(c.stdio) ? (c.stdio[0] == null ? 'null' : 'stream') : 'no-stdio-array';
  try { c.kill(); } catch (e) {}
  return s + ' stdio[0]=' + zero;
};
say('stdin-shape-default', () => shape(undefined));
say('stdin-shape-pipe', () => shape('pipe'));
say('stdin-shape-inherit', () => shape('inherit'));
say('stdin-shape-ignore', () => shape('ignore'));
say('stdin-shape-inherit-fd0', () => shape(['inherit', 'pipe', 'pipe']));
say('stdin-shape-pipe-fd0', () => shape(['pipe', 'inherit', 'inherit']));

// Regressions. The shell now listens to its own stdin; these are the two shapes
// that would break if that listener held the loop open or swallowed the line.
say('execSync-no-input', () => JSON.stringify(cp.execSync('echo hi', { encoding: 'utf8' })));
say('execSync-exit-code', () => {
  try { cp.execSync('false', { encoding: 'utf8' }); return 'no throw'; }
  catch (e) { return 'status=' + e.status; }
});

const done = () => process.exit(0);
// The async path is unchanged, but it is the one an stdin listener in \`sh\` could
// hang: nobody ever ends that child's stdin.
const child = cp.exec('echo async-ok', (err, stdout) => {
  console.log('exec-async ' + JSON.stringify(String(stdout).trim()) + ' err=' + (err ? 'yes' : 'no'));
  done();
});
child.on('error', () => { console.log('exec-async spawn failed'); done(); });
`;

const HELPERS = {
  "reader.js": `let n = 0;
process.stdin.on('data', (c) => { n += c.length; });
process.stdin.on('end', () => { process.stdout.write('read ' + n + ' bytes'); });
`,
  "hex.js": `const parts = [];
process.stdin.on('data', (c) => parts.push(Buffer.from(c)));
process.stdin.on('end', () => { process.stdout.write(Buffer.concat(parts).toString('hex')); });
`,
  // Something to spawn that says nothing and leaves: the stdin-shape cases are
  // about the object the PARENT gets back, which is answered at spawn time.
  "noop.js": `process.exit(0);
`,
};

// ── the host's real Node ─────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vv-child-stdin-"));
for (const [rel, body] of Object.entries(HELPERS)) fs.writeFileSync(path.join(tmp, rel), body);
fs.writeFileSync(path.join(tmp, "main.js"), program(process.execPath));
let hostOut = "";
try {
  hostOut = execFileSync(process.execPath, ["main.js"], { cwd: tmp, encoding: "utf8", timeout: 60000 });
} catch (e) {
  hostOut = (e.stdout || "") + "\nHOST FAILED " + String(e.message).slice(0, 200);
}

// ── and the VM ───────────────────────────────────────────────────────────────
const h = await bootSpikeKernel();
writeProject(h.kernel, "/app", { ...HELPERS, "main.js": program("node") });
// A hang is the failure this spike is about, so it must not be able to hang the
// spike: without a bound, a regression here reads as CI hanging rather than a red
// test naming the case.
const run = h.kernel.start("node", ["main.js"], { cwd: "/app", capture: true });
const guard = new Promise((r) => setTimeout(() => r({ stdout: "", stderr: "TIMED OUT — a child is waiting on stdin", code: -1 }), 60000));
const r = await Promise.race([run, guard]);
const vmOut = r.stdout || "";

const parse = (s) =>
  new Map(
    s
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[A-Za-z][\w-]* /.test(l))
      .map((l) => {
        const i = l.indexOf(" ");
        return [l.slice(0, i), l.slice(i + 1)];
      }),
  );
const H = parse(hostOut);
const V = parse(vmOut);
console.log(`child stdin: ${H.size} cases on the host, ${V.size} in the VM`);
if (r.code === -1) console.log("  VM: " + r.stderr);

for (const [name, hostLine] of H) {
  const vmLine = V.get(name);
  if (hostLine === vmLine) {
    ok(true, name);
  } else {
    ok(false, name);
    console.log(`      host: ${hostLine}`);
    console.log(`      vm:   ${vmLine === undefined ? "(never reported — hung or crashed)" : vmLine}`);
  }
}
if (!H.size) {
  ok(false, "the host produced no cases");
  console.log(hostOut.slice(0, 800));
}

console.log(failed === 0 ? "\nchild stdin: OK" : `\nchild stdin: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);