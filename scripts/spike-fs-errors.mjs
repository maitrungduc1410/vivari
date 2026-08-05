// Spike (OFFLINE): a failed `fs` call must throw the error Node throws — errno,
// syscall, path and a sentence, not just a code.
//
// WHY THIS EXISTS. Every fs failure in the VM arrived as `new Error('ENOENT')`:
// `err.code` was right and everything else was missing. Two things break on that.
// The first is every human reading a log, because "ENOENT" alone does not say WHICH
// file or WHAT was attempted, while Node says "ENOENT: no such file or directory,
// open '/app/config.json'". The second is library code: `err.syscall === 'unlink'`,
// `err.path`, and `err.errno` are all load-bearing in the wild (rimraf, graceful-fs,
// chokidar, webpack's caching), and an absent property reads as "some other error"
// so recovery paths silently do not run.
//
// The information was there all along — the binding knows the syscall it is running
// and the path it was handed; it just was not putting either on the error. The
// syscall bridge (fs-client.js) can only report a code, since that is all it gets
// back from the VFS, so labelling belongs one layer up, in bindings/fs.js, which is
// also exactly where Node does it (uvException, in node_errors.cc).
//
// HOW IT IS GATED. Each case runs on the HOST's real Node and in the VM and the two
// transcripts must be identical, character for character — including the message,
// which is the part a person actually reads. A hand-written table of expectations
// would only pin what I believe Node's wording and errno are; the host knows. Roots
// differ between the two sides, so every path is printed with its scratch root
// replaced by <R>.
//
//   run:  node scripts/spike-fs-errors.mjs

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

// argv[2] is the scratch root: the host and the VM each need a writable one.
const GUEST = String.raw`
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const ROOT = process.argv[2];

const out = [];

// The whole error, flattened. errno and syscall and path are the properties
// user code reads; the message is what a person reads, and it is included because
// getting the properties right while printing a bare code would still leave every
// log unreadable. ROOT is stripped so the host and the VM can be compared.
const scrub = (s) => String(s).split(ROOT).join('<R>');
const describe = (e) => {
  if (!e) return 'NO ERROR THROWN';
  const parts = [
    'code=' + e.code,
    'errno=' + e.errno,
    'syscall=' + e.syscall,
    'path=' + (e.path === undefined ? 'undefined' : scrub(e.path)),
  ];
  if (e.dest !== undefined) parts.push('dest=' + scrub(e.dest));
  parts.push('msg=' + scrub(e.message));
  return parts.join(' ');
};

const attempt = (name, fn) => {
  try {
    fn();
    out.push(name + ' NO ERROR THROWN');
  } catch (e) {
    out.push(name + ' ' + describe(e));
  }
};

const attemptAsync = async (name, fn) => {
  try {
    await fn();
    out.push(name + ' NO ERROR THROWN');
  } catch (e) {
    out.push(name + ' ' + describe(e));
  }
};

// A fresh directory per case, so one failure cannot bleed into the next.
let n = 0;
const fresh = () => {
  const d = path.join(ROOT, 'c' + n++);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

(async () => {
  // ── reading what is not there: the single most common fs error ────────────
  {
    const d = fresh();
    attempt('readFileSync-missing', () => fs.readFileSync(path.join(d, 'nope.txt')));
    attempt('readFileSync-missing-utf8', () => fs.readFileSync(path.join(d, 'nope.txt'), 'utf8'));
    attempt('openSync-missing', () => fs.openSync(path.join(d, 'nope.txt'), 'r'));
    attempt('statSync-missing', () => fs.statSync(path.join(d, 'nope.txt')));
    attempt('lstatSync-missing', () => fs.lstatSync(path.join(d, 'nope.txt')));
    attempt('accessSync-missing', () => fs.accessSync(path.join(d, 'nope.txt')));
    attempt('realpathSync-missing', () => fs.realpathSync(path.join(d, 'nope.txt')));
    attempt('readlinkSync-missing', () => fs.readlinkSync(path.join(d, 'nope.txt')));
    attempt('unlinkSync-missing', () => fs.unlinkSync(path.join(d, 'nope.txt')));
    attempt('rmdirSync-missing', () => fs.rmdirSync(path.join(d, 'nope.txt')));
    attempt('chmodSync-missing', () => fs.chmodSync(path.join(d, 'nope.txt'), 0o644));
    attempt('utimesSync-missing', () => fs.utimesSync(path.join(d, 'nope.txt'), 0, 0));
    attempt('truncateSync-missing', () => fs.truncateSync(path.join(d, 'nope.txt'), 0));
  }

  // ── a directory where a file was meant, and the reverse ──────────────────
  {
    const d = fresh();
    fs.mkdirSync(path.join(d, 'dir'));
    fs.writeFileSync(path.join(d, 'file.txt'), 'x');
    attempt('readFileSync-on-a-dir', () => fs.readFileSync(path.join(d, 'dir')));
    attempt('writeFileSync-onto-a-dir', () => fs.writeFileSync(path.join(d, 'dir'), 'x'));
    attempt('readdirSync-on-a-file', () => fs.readdirSync(path.join(d, 'file.txt')));
    attempt('rmdirSync-on-a-file', () => fs.rmdirSync(path.join(d, 'file.txt')));
    attempt('mkdirSync-under-a-file', () => fs.mkdirSync(path.join(d, 'file.txt', 'sub')));
    attempt('statSync-under-a-file', () => fs.statSync(path.join(d, 'file.txt', 'sub')));
    attempt('readlinkSync-on-a-file', () => fs.readlinkSync(path.join(d, 'file.txt')));
  }

  // ── already exists ───────────────────────────────────────────────────────
  {
    const d = fresh();
    fs.mkdirSync(path.join(d, 'dir'));
    fs.writeFileSync(path.join(d, 'file.txt'), 'x');
    attempt('mkdirSync-existing-dir', () => fs.mkdirSync(path.join(d, 'dir')));
    attempt('mkdirSync-existing-file', () => fs.mkdirSync(path.join(d, 'file.txt')));
    attempt('openSync-wx-existing', () => fs.openSync(path.join(d, 'file.txt'), 'wx'));
  }

  // ── the two-path calls, where Node reports a dest as well ─────────────────
  {
    const d = fresh();
    fs.writeFileSync(path.join(d, 'a.txt'), 'x');
    attempt('renameSync-missing-src', () =>
      fs.renameSync(path.join(d, 'nope.txt'), path.join(d, 'b.txt')));
    attempt('renameSync-into-missing-dir', () =>
      fs.renameSync(path.join(d, 'a.txt'), path.join(d, 'nodir', 'b.txt')));
    attempt('copyFileSync-missing-src', () =>
      fs.copyFileSync(path.join(d, 'nope.txt'), path.join(d, 'b.txt')));
    attempt('linkSync-missing-src', () =>
      fs.linkSync(path.join(d, 'nope.txt'), path.join(d, 'b.txt')));
    // Distinct names on purpose: symlink is the one call whose two paths are not
    // in (src, dest) order, and identical arguments would hide which is which.
    attempt('symlinkSync-existing-dest', () =>
      fs.symlinkSync(path.join(d, 'target-side.txt'), path.join(d, 'a.txt')));
  }

  // ── a non-empty directory ────────────────────────────────────────────────
  {
    const d = fresh();
    fs.mkdirSync(path.join(d, 'dir'));
    fs.writeFileSync(path.join(d, 'dir', 'child.txt'), 'x');
    attempt('rmdirSync-non-empty', () => fs.rmdirSync(path.join(d, 'dir')));
  }

  // ── a missing parent ─────────────────────────────────────────────────────
  {
    const d = fresh();
    attempt('writeFileSync-missing-parent', () =>
      fs.writeFileSync(path.join(d, 'nodir', 'a.txt'), 'x'));
    attempt('mkdirSync-missing-parent', () => fs.mkdirSync(path.join(d, 'nodir', 'sub')));
    attempt('mkdtempSync-missing-parent', () => fs.mkdtempSync(path.join(d, 'nodir', 'x-')));
  }

  // ── fd-based calls: a bad descriptor carries no path ─────────────────────
  {
    attempt('fstatSync-bad-fd', () => fs.fstatSync(9999));
    attempt('closeSync-bad-fd', () => fs.closeSync(9999));
    attempt('readSync-bad-fd', () => fs.readSync(9999, Buffer.alloc(8), 0, 8, 0));
    attempt('writeSync-bad-fd', () => fs.writeSync(9999, Buffer.from('x')));
    attempt('fsyncSync-bad-fd', () => fs.fsyncSync(9999));
    attempt('ftruncateSync-bad-fd', () => fs.ftruncateSync(9999, 0));
  }

  // ── the callback API: same error, delivered rather than thrown ────────────
  {
    const d = fresh();
    await attemptAsync('readFile-callback-missing', () =>
      new Promise((res, rej) => fs.readFile(path.join(d, 'nope.txt'), (e) => (e ? rej(e) : res()))));
    await attemptAsync('stat-callback-missing', () =>
      new Promise((res, rej) => fs.stat(path.join(d, 'nope.txt'), (e) => (e ? rej(e) : res()))));
    await attemptAsync('rename-callback-missing', () =>
      new Promise((res, rej) =>
        fs.rename(path.join(d, 'nope.txt'), path.join(d, 'b.txt'), (e) => (e ? rej(e) : res()))));
    await attemptAsync('mkdir-callback-existing', () => {
      fs.mkdirSync(path.join(d, 'dir'));
      return new Promise((res, rej) => fs.mkdir(path.join(d, 'dir'), (e) => (e ? rej(e) : res())));
    });
  }

  // ── fs/promises: the surface most new code uses ───────────────────────────
  {
    const d = fresh();
    await attemptAsync('promises-readFile-missing', () => fsp.readFile(path.join(d, 'nope.txt')));
    await attemptAsync('promises-stat-missing', () => fsp.stat(path.join(d, 'nope.txt')));
    await attemptAsync('promises-mkdir-existing', async () => {
      fs.mkdirSync(path.join(d, 'dir'));
      await fsp.mkdir(path.join(d, 'dir'));
    });
    await attemptAsync('promises-rmdir-non-empty', async () => {
      fs.mkdirSync(path.join(d, 'full'));
      fs.writeFileSync(path.join(d, 'full', 'c.txt'), 'x');
      await fsp.rmdir(path.join(d, 'full'));
    });
    await attemptAsync('promises-open-missing', () => fsp.open(path.join(d, 'nope.txt'), 'r'));
  }

  // ── a stream, which reports through 'error' rather than a throw ───────────
  {
    const d = fresh();
    await attemptAsync('createReadStream-missing', () =>
      new Promise((res, rej) => {
        const s = fs.createReadStream(path.join(d, 'nope.txt'));
        s.on('error', rej);
        s.on('end', res);
        s.resume();
      }));
  }

  for (const line of out) console.log('CASE ' + line);
})();
`;

// ── the host's real Node ─────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vv-fs-errors-"));
const guestFile = path.join(tmp, "guest.js");
fs.writeFileSync(guestFile, GUEST);
const hostRoot = path.join(tmp, "host");
fs.mkdirSync(hostRoot, { recursive: true });

let hostRaw = "";
try {
  hostRaw = execFileSync(process.execPath, [guestFile, hostRoot], {
    encoding: "utf8",
    timeout: 60000,
  });
} catch (e) {
  hostRaw = "HOST_FAILED: " + ((e && e.stderr) || e);
}
const lines = (raw) =>
  raw
    .split("\n")
    .filter((l) => l.startsWith("CASE "))
    .map((l) => l.slice(5).trim());
const hostCases = lines(hostRaw);

// ── and the VM ───────────────────────────────────────────────────────────────
const h = await bootSpikeKernel();
writeProject(h.kernel, "/t", { "guest.js": GUEST });
h.kernel.mkdirp?.("/t/vmroot");
const r = await h.kernel.start("node", ["/t/guest.js", "/t/vmroot"], { cwd: "/t", capture: true });
const vmCases = lines(r.stdout || "");

if (!hostCases.length) {
  console.log("  ✗ the host produced no transcript — the gate cannot judge anything");
  console.log(hostRaw.slice(0, 2000));
  process.exit(1);
}
if (!vmCases.length) {
  console.log(`  ✗ the VM produced no transcript (exit ${r.code})`);
  console.log((r.stderr || "").split("\n").slice(0, 12).join("\n"));
  process.exit(1);
}

// Cases where matching the host would mean reproducing something we cannot or
// should not. Both sides are pinned, so a change on either side surfaces as an
// obsolete exception rather than a stale allowance nobody revisits.
const DIVERGENCES = new Map([
  [
    "fsyncSync-bad-fd",
    {
      host: "code=EBADF errno=-9 syscall=fsync path=undefined msg=EBADF: bad file descriptor, fsync",
      vm: "NO ERROR THROWN",
      why:
        "fsync is a no-op here on purpose — a VFS write that has returned is already " +
        "as durable as this filesystem gets — and it deliberately does not validate " +
        "the fd, because write-file-atomic calls it after every write and the check " +
        "would be another sync round-trip on npm's hot path. A bad fd is a bug in the " +
        "caller either way; the price of catching it is paid by every correct call.",
    },
  ],
]);

// name -> the outcome, with the name itself stripped, so a pinned divergence can be
// written as the outcome alone.
const byName = (cases) =>
  new Map(
    cases.map((l) => {
      const name = l.split(" ")[0];
      return [name, l.slice(name.length + 1)];
    }),
  );
const hostByName = byName(hostCases);
const vmByName = byName(vmCases);

console.log(`fs error shape: ${hostByName.size} cases on the host, ${vmByName.size} in the VM`);

for (const [name, hostLine] of hostByName) {
  const vmLine = vmByName.get(name);
  if (vmLine === undefined) {
    ok(false, `${name}: the VM produced no line for a case the host ran`);
    continue;
  }
  const allowed = DIVERGENCES.get(name);
  if (allowed && hostLine === allowed.host && vmLine === allowed.vm) {
    console.log(`  ~ ${name}: known divergence — ${allowed.why}`);
    continue;
  }
  if (hostLine === vmLine) {
    ok(true, name);
  } else {
    ok(false, name);
    console.log(`      host: ${hostLine}`);
    console.log(`      vm:   ${vmLine}`);
  }
}

for (const name of vmByName.keys()) {
  if (!hostByName.has(name)) ok(false, `${name}: the VM produced a line the host did not`);
}

// A divergence that no longer happens is a line to delete, not a silent pass.
for (const [name, allowed] of DIVERGENCES) {
  const h2 = hostByName.get(name);
  const v2 = vmByName.get(name);
  if (h2 === v2) ok(false, `${name}: listed as a divergence but the two sides now agree — drop it`);
  else if (h2 !== allowed.host || v2 !== allowed.vm) {
    ok(false, `${name}: divergence no longer matches what was pinned — re-check it`);
  }
}

console.log(failed === 0 ? "\nfs errors: OK" : `\nfs errors: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
