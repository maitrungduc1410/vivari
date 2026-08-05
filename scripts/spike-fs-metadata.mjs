// Spike (OFFLINE): chmod and utimes actually change something.
//
// WHY THIS EXISTS. Both calls used to be accepted and discarded. The VFS had
// nowhere to put a mode change (it assigned `mode` at creation and never again)
// and no atime at all, so `chmod(f, 0o755)` returned cleanly and `stat` went on
// reporting 0o644. That was a defensible compromise right up until two things
// happened to it:
//
//   • `access()` started enforcing X_OK for real. From then on `chmod(f, 0o755)`
//     followed by `access(f, X_OK)` THREW — the write said yes, the check said
//     no, and the two calls disagreed about the same file.
//   • Anything that unpacks an archive lost every executable bit, which is not
//     visible until something tries to run the file, one layer away from the
//     cause.
//
// Now OP_CHMOD/OP_UTIMES reach the inode (VFS set_mode/set_times) and the inode
// carries its own atime. What this spike holds is that the values Node reads
// back are the values it wrote — mode, mtime AND atime, through the path forms,
// the fd forms, and the l- forms that stamp a symlink instead of its target.
//
// chown is deliberately NOT here: there is one user and no kernel underneath, so
// there is nothing to own a file, and the call stays a no-op. That is a missing
// MODEL, not a missing write, and a spike pretending otherwise would be pinning
// a fiction.
//
//   run:  node scripts/spike-fs-metadata.mjs

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

// Every case runs in `root`, which each side reports relative to, so the two
// transcripts can be compared verbatim.
const PROBE = `
const fs = require('fs');
const path = require('path');
const root = process.cwd();
const p = (n) => path.join(root, n);
const say = (name, fn) => {
  let r;
  try { r = fn(); } catch (e) { r = 'THREW ' + (e.code || '') + ' ' + e.syscall + ' ' + String(e.path || '').replace(root, '<R>'); }
  console.log(name + ' ' + r);
};
const perm = (f) => (fs.statSync(f).mode & 0o777).toString(8);
const secs = (f, useL) => {
  const s = useL ? fs.lstatSync(f) : fs.statSync(f);
  return 'm=' + Math.round(s.mtimeMs / 1000) + ' a=' + Math.round(s.atimeMs / 1000);
};

// The plain case, and the one that used to disagree with access().
say('chmod-755', () => { const f = p('a.txt'); fs.writeFileSync(f, 'x'); fs.chmodSync(f, 0o755); return perm(f); });
say('access-X_OK-after-chmod', () => { fs.accessSync(p('a.txt'), fs.constants.X_OK); return 'allowed'; });
say('chmod-644', () => { fs.chmodSync(p('a.txt'), 0o644); return perm(p('a.txt')); });
say('access-X_OK-after-644', () => { fs.accessSync(p('a.txt'), fs.constants.X_OK); return 'allowed'; });
say('chmod-sticky-bits', () => { const f = p('a.txt'); fs.chmodSync(f, 0o4711); return (fs.statSync(f).mode & 0o7777).toString(8); });

// A directory is an inode too.
say('chmod-dir', () => { const d = p('sub'); fs.mkdirSync(d); fs.chmodSync(d, 0o700); return perm(d); });

// Times. Node takes seconds here and reports milliseconds back.
say('utimes', () => { const f = p('b.txt'); fs.writeFileSync(f, 'x'); fs.utimesSync(f, 1000, 2000); return secs(f); });
say('utimes-date', () => {
  const f = p('b.txt');
  fs.utimesSync(f, new Date(5000 * 1000), new Date(6000 * 1000));
  return secs(f);
});

// The fd forms: what node-tar uses on every file it extracts.
say('fchmod-futimes', () => {
  const f = p('c.txt');
  fs.writeFileSync(f, 'x');
  const fd = fs.openSync(f, 'r+');
  try { fs.fchmodSync(fd, 0o700); fs.futimesSync(fd, 3000, 4000); } finally { fs.closeSync(fd); }
  return perm(f) + ' ' + secs(f);
});

// lutimes stamps the LINK; the target keeps its own times.
say('lutimes-link-vs-target', () => {
  const target = p('t.txt');
  const link = p('l.txt');
  fs.writeFileSync(target, 'x');
  fs.utimesSync(target, 1111, 2222);
  fs.symlinkSync(target, link);
  fs.lutimesSync(link, 7000, 8000);
  return 'link ' + secs(link, true) + ' target ' + secs(target);
});

// utimes FOLLOWS the link, so it lands on the target.
say('utimes-through-link', () => { fs.utimesSync(p('l.txt'), 9000, 9500); return 'target ' + secs(p('t.txt')); });

// A write after chmod keeps the mode: the two are independent fields, and an
// implementation that re-derived mode on write would quietly undo the chmod.
say('mode-survives-write', () => {
  const f = p('d.txt');
  fs.writeFileSync(f, 'one');
  fs.chmodSync(f, 0o600);
  fs.writeFileSync(f, 'two-longer');
  return perm(f) + ' size=' + fs.statSync(f).size;
});

// The mode a file is CREATED with, which was always honoured, still is.
say('create-with-mode', () => { const f = p('e.txt'); fs.writeFileSync(f, 'x', { mode: 0o750 }); return perm(f); });

// Failures carry the libuv syscall name and the path, like every other fs error.
say('chmod-missing', () => { fs.chmodSync(p('nope.txt'), 0o755); return 'no throw'; });
say('utimes-missing', () => { fs.utimesSync(p('nope.txt'), 1, 2); return 'no throw'; });

// The promise API rides the same binding.
fs.promises
  .chmod(p('f.txt'), 0o711)
  .then(() => console.log('promises-chmod ' + perm(p('f.txt'))))
  .catch((e) => console.log('promises-chmod THREW ' + (e.code || '') + ' ' + e.syscall))
  .then(() => process.exit(0));
`;

const SETUP = { "f.txt": "x" };

// ── the host's real Node ─────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vv-fs-meta-"));
for (const [n, b] of Object.entries(SETUP)) fs.writeFileSync(path.join(tmp, n), b);
fs.writeFileSync(path.join(tmp, "probe.js"), PROBE);
let hostOut = "";
try {
  hostOut = execFileSync(process.execPath, ["probe.js"], { cwd: tmp, encoding: "utf8", timeout: 60000 });
} catch (e) {
  hostOut = (e.stdout || "") + "\nHOST FAILED " + String(e.message).slice(0, 200);
}

// ── and the VM ───────────────────────────────────────────────────────────────
const h = await bootSpikeKernel();
writeProject(h.kernel, "/app", { ...SETUP, "probe.js": PROBE });
const r = await h.kernel.start("node", ["probe.js"], { cwd: "/app", capture: true });
const vmOut = r.stdout || "";

const parse = (s) =>
  new Map(
    s
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[a-zA-Z][\w-]* /.test(l))
      .map((l) => {
        const i = l.indexOf(" ");
        return [l.slice(0, i), l.slice(i + 1)];
      }),
  );
const H = parse(hostOut);
const V = parse(vmOut);
console.log(`fs metadata: ${H.size} cases on the host, ${V.size} in the VM`);
if (!V.size && r.stderr) console.log("  VM stderr: " + String(r.stderr).slice(0, 400));

for (const [name, hostLine] of H) {
  const vmLine = V.get(name);
  if (hostLine === vmLine) {
    ok(true, `${name} — ${hostLine}`);
  } else {
    ok(false, name);
    console.log(`      host: ${hostLine}`);
    console.log(`      vm:   ${vmLine === undefined ? "(missing)" : vmLine}`);
  }
}
if (!H.size) {
  ok(false, "the host produced no cases");
  console.log(hostOut.slice(0, 800));
}

console.log(failed === 0 ? "\nfs metadata: OK" : `\nfs metadata: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
