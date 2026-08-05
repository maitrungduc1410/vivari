// Spike (OFFLINE): `fs.cpSync` and `fsPromises.cp` must behave as Node's do.
//
// WHY THIS EXISTS. Async `fs.cp` worked; `fs.cpSync` threw
// ERR_METHOD_NOT_IMPLEMENTED, and so did `fsPromises.cp` — because
// `lib/fs/promises.js` wires `cp: wrap("cpSync")`, so the promise API inherited a
// gap the callback API did not have. `fs/promises` is the surface modern code
// reaches for first, and `cpSync` is everywhere in build scripts, so between them
// this was the most-used missing thing in `fs`.
//
// Upstream's cp-sync is nearly all JS; it needs three helpers that are native in
// Node (`cpSyncCheckPaths`, `cpSyncOverrideFile`, `cpSyncCopyDir`). Two of them the
// vendored file can already do in JS — its filter path implements `copyDir`, and
// `copyFile` covers an override — so only the validation is genuinely new.
//
// HOW IT IS GATED. Every case runs on the HOST's real Node and in the VM, and the
// transcripts must be identical. Validation semantics here are a thicket of
// ERR_FS_CP_* codes with specific errno values and specific precedence, and a
// hand-written expectation would pin what I believe Node does rather than what it
// does. Transcripts carry no absolute paths, so the two sides are comparable.
//
//   run:  node scripts/spike-fs-cp.mjs

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

// The guest takes its scratch root as argv[2] so the host and the VM can each use
// a writable place, and prints outcomes only — never a path, or the transcripts
// could never match.
const GUEST = String.raw`
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const ROOT = process.argv[2];

const out = [];
const say = (name, extra) => out.push(name + ' ' + extra);

// Each case gets its own directory, so one failure cannot bleed into the next.
let n = 0;
const fresh = () => {
  const d = path.join(ROOT, 'c' + n++);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

// The code, which is what user code keys on. Deliberately NOT e.constructor.name:
// Node builds these through several internal factories and reports 'Error',
// 'NodeError' or 'TypeError' for errors of the same family, so it is an
// implementation detail rather than a contract. Not errno/syscall either — Node
// leaves both undefined on ERR_FS_CP_* despite passing them to the constructor, so
// there is nothing to compare here; the numbers we DO set are checked separately
// below, against this table rather than against the host. (Plain POSIX fs errors are
// a different matter: they carry errno/syscall/path, and spike-fs-errors.mjs holds
// them to the host's exact shape and message.)
const describe = (e) => 'error=' + (e && e.code) + ' isError=' + (e instanceof Error);

const attempt = (name, fn) => {
  try {
    const v = fn();
    say(name, 'ok' + (v === undefined ? '' : ' ' + v));
  } catch (e) {
    say(name, describe(e));
  }
};

const attemptAsync = async (name, fn) => {
  try {
    const v = await fn();
    say(name, 'ok' + (v === undefined ? '' : ' ' + v));
  } catch (e) {
    say(name, describe(e));
  }
};

(async () => {
  // ── a plain file ──────────────────────────────────────────────────────────
  {
    const d = fresh();
    fs.writeFileSync(path.join(d, 'a.txt'), 'hello');
    attempt('file-to-new-path', () => {
      fs.cpSync(path.join(d, 'a.txt'), path.join(d, 'b.txt'));
      return 'content=' + fs.readFileSync(path.join(d, 'b.txt'), 'utf8');
    });
  }

  // Does the sync path create a missing destination parent? The async one does,
  // via checkParentDir; asserting rather than assuming.
  {
    const d = fresh();
    fs.writeFileSync(path.join(d, 'a.txt'), 'hello');
    attempt('file-to-missing-parent', () => {
      fs.cpSync(path.join(d, 'a.txt'), path.join(d, 'deep', 'nested', 'b.txt'));
      return 'exists=' + fs.existsSync(path.join(d, 'deep', 'nested', 'b.txt'));
    });
  }

  // ── overwriting ───────────────────────────────────────────────────────────
  {
    const d = fresh();
    fs.writeFileSync(path.join(d, 'a.txt'), 'new');
    fs.writeFileSync(path.join(d, 'b.txt'), 'old');
    attempt('overwrite-default-force', () => {
      fs.cpSync(path.join(d, 'a.txt'), path.join(d, 'b.txt'));
      return 'content=' + fs.readFileSync(path.join(d, 'b.txt'), 'utf8');
    });
  }
  {
    const d = fresh();
    fs.writeFileSync(path.join(d, 'a.txt'), 'new');
    fs.writeFileSync(path.join(d, 'b.txt'), 'old');
    attempt('overwrite-force-false-is-a-silent-skip', () => {
      fs.cpSync(path.join(d, 'a.txt'), path.join(d, 'b.txt'), { force: false });
      return 'content=' + fs.readFileSync(path.join(d, 'b.txt'), 'utf8');
    });
  }
  {
    const d = fresh();
    fs.writeFileSync(path.join(d, 'a.txt'), 'new');
    fs.writeFileSync(path.join(d, 'b.txt'), 'old');
    attempt('overwrite-errorOnExist', () =>
      fs.cpSync(path.join(d, 'a.txt'), path.join(d, 'b.txt'), { force: false, errorOnExist: true }));
  }

  // ── directories ───────────────────────────────────────────────────────────
  {
    const d = fresh();
    fs.mkdirSync(path.join(d, 'src', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(d, 'src', 'one.txt'), '1');
    fs.writeFileSync(path.join(d, 'src', 'sub', 'two.txt'), '2');
    attempt('dir-without-recursive', () => fs.cpSync(path.join(d, 'src'), path.join(d, 'dst')));
  }
  {
    const d = fresh();
    fs.mkdirSync(path.join(d, 'src', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(d, 'src', 'one.txt'), '1');
    fs.writeFileSync(path.join(d, 'src', 'sub', 'two.txt'), '2');
    attempt('dir-recursive', () => {
      fs.cpSync(path.join(d, 'src'), path.join(d, 'dst'), { recursive: true });
      return 'one=' + fs.readFileSync(path.join(d, 'dst', 'one.txt'), 'utf8') +
        ' two=' + fs.readFileSync(path.join(d, 'dst', 'sub', 'two.txt'), 'utf8');
    });
  }
  {
    const d = fresh();
    fs.mkdirSync(path.join(d, 'src'), { recursive: true });
    fs.writeFileSync(path.join(d, 'src', 'one.txt'), '1');
    fs.mkdirSync(path.join(d, 'dst'), { recursive: true });
    fs.writeFileSync(path.join(d, 'dst', 'stale.txt'), 'x');
    attempt('dir-recursive-into-existing-dir-merges', () => {
      fs.cpSync(path.join(d, 'src'), path.join(d, 'dst'), { recursive: true });
      return 'copied=' + fs.existsSync(path.join(d, 'dst', 'one.txt')) +
        ' kept=' + fs.existsSync(path.join(d, 'dst', 'stale.txt'));
    });
  }

  // ── the validation cases, which is what the native helper existed for ─────
  {
    const d = fresh();
    fs.writeFileSync(path.join(d, 'a.txt'), 'x');
    attempt('src-equals-dest', () => fs.cpSync(path.join(d, 'a.txt'), path.join(d, 'a.txt')));
  }
  {
    const d = fresh();
    fs.mkdirSync(path.join(d, 'src'), { recursive: true });
    fs.writeFileSync(path.join(d, 'file.txt'), 'x');
    attempt('dir-onto-file', () =>
      fs.cpSync(path.join(d, 'src'), path.join(d, 'file.txt'), { recursive: true }));
  }
  {
    const d = fresh();
    fs.writeFileSync(path.join(d, 'file.txt'), 'x');
    fs.mkdirSync(path.join(d, 'dst'), { recursive: true });
    attempt('file-onto-dir', () => fs.cpSync(path.join(d, 'file.txt'), path.join(d, 'dst')));
  }
  {
    const d = fresh();
    fs.mkdirSync(path.join(d, 'src'), { recursive: true });
    fs.writeFileSync(path.join(d, 'src', 'a.txt'), 'x');
    attempt('dir-into-its-own-subdirectory', () =>
      fs.cpSync(path.join(d, 'src'), path.join(d, 'src', 'inner'), { recursive: true }));
  }
  {
    const d = fresh();
    attempt('missing-src', () => fs.cpSync(path.join(d, 'nope.txt'), path.join(d, 'out.txt')));
  }

  // ── filter, the path that already ran in JS ───────────────────────────────
  {
    const d = fresh();
    fs.mkdirSync(path.join(d, 'src'), { recursive: true });
    fs.writeFileSync(path.join(d, 'src', 'keep.txt'), 'k');
    fs.writeFileSync(path.join(d, 'src', 'skip.log'), 's');
    attempt('filter-excludes-by-extension', () => {
      fs.cpSync(path.join(d, 'src'), path.join(d, 'dst'), {
        recursive: true,
        filter: (s) => !s.endsWith('.log'),
      });
      return 'keep=' + fs.existsSync(path.join(d, 'dst', 'keep.txt')) +
        ' skip=' + fs.existsSync(path.join(d, 'dst', 'skip.log'));
    });
  }
  {
    const d = fresh();
    fs.mkdirSync(path.join(d, 'src'), { recursive: true });
    fs.writeFileSync(path.join(d, 'src', 'a.txt'), 'x');
    attempt('filter-returning-a-promise-is-refused', () =>
      fs.cpSync(path.join(d, 'src'), path.join(d, 'dst'), {
        recursive: true,
        filter: () => Promise.resolve(true),
      }));
  }

  // ── symlinks ──────────────────────────────────────────────────────────────
  {
    const d = fresh();
    fs.writeFileSync(path.join(d, 'target.txt'), 'T');
    try {
      fs.symlinkSync(path.join(d, 'target.txt'), path.join(d, 'link.txt'));
      attempt('symlink-copied-as-a-symlink', () => {
        fs.cpSync(path.join(d, 'link.txt'), path.join(d, 'copy.txt'));
        return 'isLink=' + fs.lstatSync(path.join(d, 'copy.txt')).isSymbolicLink();
      });
      attempt('symlink-with-dereference-copies-the-file', () => {
        fs.cpSync(path.join(d, 'link.txt'), path.join(d, 'deref.txt'), { dereference: true });
        return 'isLink=' + fs.lstatSync(path.join(d, 'deref.txt')).isSymbolicLink() +
          ' content=' + fs.readFileSync(path.join(d, 'deref.txt'), 'utf8');
      });
    } catch (e) {
      say('symlink-setup', describe(e));
    }
  }

  // ── the promise API, which is the one that routed into cpSync ─────────────
  {
    const d = fresh();
    fs.mkdirSync(path.join(d, 'src', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(d, 'src', 'sub', 'a.txt'), 'P');
    await attemptAsync('fsPromises.cp-recursive', async () => {
      await fsp.cp(path.join(d, 'src'), path.join(d, 'dst'), { recursive: true });
      return 'content=' + fs.readFileSync(path.join(d, 'dst', 'sub', 'a.txt'), 'utf8');
    });
  }
  {
    const d = fresh();
    fs.mkdirSync(path.join(d, 'src'), { recursive: true });
    await attemptAsync('fsPromises.cp-rejects-a-dir-without-recursive', () =>
      fsp.cp(path.join(d, 'src'), path.join(d, 'dst')));
  }
  {
    const d = fresh();
    fs.writeFileSync(path.join(d, 'a.txt'), 'A');
    await attemptAsync('fs.cp-callback-still-works', () =>
      new Promise((res, rej) =>
        fs.cp(path.join(d, 'a.txt'), path.join(d, 'b.txt'), (e) =>
          e ? rej(e) : res('content=' + fs.readFileSync(path.join(d, 'b.txt'), 'utf8')))));
  }

  for (const line of out) console.log('CASE ' + line);
})();
`;

// ── the host's real Node ─────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vv-fs-cp-"));
const guestFile = path.join(tmp, "guest.js");
fs.writeFileSync(guestFile, GUEST);
const hostRoot = path.join(tmp, "host");
fs.mkdirSync(hostRoot, { recursive: true });

let hostRaw = "";
try {
  hostRaw = execFileSync(process.execPath, [guestFile, hostRoot], { encoding: "utf8", timeout: 60000 });
} catch (e) {
  hostRaw = "HOST_FAILED: " + ((e && e.stderr) || e);
}
const hostCases = hostRaw
  .split("\n")
  .filter((l) => l.startsWith("CASE "))
  .map((l) => l.slice(5).trim());

// ── and the VM ───────────────────────────────────────────────────────────────
const h = await bootSpikeKernel();
writeProject(h.kernel, "/t", { "guest.js": GUEST });
h.kernel.mkdirp?.("/t/vmroot");
const r = await h.kernel.start("node", ["/t/guest.js", "/t/vmroot"], { cwd: "/t", capture: true });
const vmCases = (r.stdout || "")
  .split("\n")
  .filter((l) => l.startsWith("CASE "))
  .map((l) => l.slice(5).trim());

if (!hostCases.length) {
  console.log("  ✗ the host produced no transcript — the gate cannot judge anything");
  console.log(hostRaw.slice(0, 2000));
  process.exit(1);
}
if (!vmCases.length) {
  console.log(`  ✗ the VM produced no transcript (exit ${r.code})`);
  console.log((r.stderr || "").split("\n").slice(0, 8).join("\n"));
  process.exit(1);
}

// Cases where matching the host would mean reproducing a bug. Both sides are
// pinned, so a fixed Node reports the divergence as obsolete instead of leaving a
// stale exception in place for ever.
const DIVERGENCES = new Map([
  [
    "symlink-with-dereference-copies-the-file",
    {
      host: "error=ERR_FS_EISDIR isError=true",
      vm: "ok isLink=false content=T",
      why:
        "Node 22's native cpSyncCheckPaths calls a dereferenced symlink-to-a-file a " +
        "directory (its message even names the source with a trailing slash). The same " +
        "Node's async fs.cp copies it, and so does its own cpSync with recursive:true — " +
        "same operation, so the sync refusal is a bug, not a contract.",
    },
  ],
]);

console.log(`== ${hostCases.length} cases, host Node vs the VM ==`);
const hostByName = new Map(hostCases.map((l) => [l.split(" ")[0], l]));
const vmByName = new Map(vmCases.map((l) => [l.split(" ")[0], l]));
for (const [name, hostLine] of hostByName) {
  const vmLine = vmByName.get(name);
  const hostRest = hostLine.slice(name.length + 1);
  const vmRest = vmLine === undefined ? undefined : vmLine.slice(name.length + 1);
  const div = DIVERGENCES.get(name);
  if (div) {
    ok(
      hostRest === div.host && vmRest === div.vm,
      `${name}  →  deliberate divergence (host: ${div.host} · vm: ${div.vm})`,
    );
    if (hostRest !== div.host) {
      console.log("      the host no longer behaves as the divergence describes — it may be fixed upstream");
      console.log("      expected host: " + div.host);
      console.log("      actual host:   " + hostRest);
    }
    if (vmRest !== div.vm) {
      console.log("      expected vm:   " + div.vm);
      console.log("      actual vm:     " + vmRest);
    }
    continue;
  }
  const same = vmLine === hostLine;
  ok(same, name + "  →  " + hostRest);
  if (!same) {
    console.log("      host: " + hostLine);
    console.log("      vm:   " + (vmRest === undefined ? "(case missing)" : vmLine));
  }
}
for (const name of vmByName.keys()) {
  if (!hostByName.has(name)) ok(false, `the VM emitted a case the host did not: ${name}`);
}

// The two things that were actually broken, stated outright so a transcript that
// matches for the wrong reason (both sides throwing) cannot pass.
console.log("\n== the gap that prompted this, named ==");
{
  const cases = new Map(vmCases.map((l) => [l.split(" ")[0], l]));
  const notImplemented = [...cases.values()].filter((l) => l.includes("ERR_METHOD_NOT_IMPLEMENTED"));
  ok(notImplemented.length === 0, `no case reports ERR_METHOD_NOT_IMPLEMENTED (found ${notImplemented.length})`);
  ok(
    (cases.get("file-to-new-path") || "").includes("content=hello"),
    "fs.cpSync copies a file's bytes",
  );
  ok(
    (cases.get("fsPromises.cp-recursive") || "").includes("content=P"),
    "fsPromises.cp copies a tree — the surface modern code uses",
  );
  ok((cases.get("dir-recursive") || "").includes("one=1 two=2"), "a recursive copy reaches a nested file");
}

// Two things the host comparison cannot see, because on the host they are either
// absent or invisible.
console.log("\n== what the transcript cannot check ==");
{
  // `internalBinding('constants').os.errno` held one entry, so every ERR_FS_CP_*
  // error carried `errno: undefined`. Node leaves these undefined too, so the host
  // is no oracle here — the numbers are checked against the POSIX values directly.
  writeProject(h.kernel, "/t", {
    "errno.js": `const fs = require('fs');
fs.mkdirSync('/t/e/src', { recursive: true });
fs.writeFileSync('/t/e/file.txt', 'x');
const grab = (fn) => { try { fn(); return 'no-throw'; } catch (e) { return e.code + ':' + e.errno; } };
console.log('ERRNO ' + [
  grab(() => fs.cpSync('/t/e/src', '/t/e/file.txt', { recursive: true })),
  grab(() => fs.cpSync('/t/e/file.txt', '/t/e/src')),
  grab(() => fs.cpSync('/t/e/src', '/t/e/src/inner', { recursive: true })),
  grab(() => fs.cpSync('/t/e/src', '/t/e/out')),
].join(' '));
`,
  });
  const er = await h.kernel.start("node", ["/t/errno.js"], { cwd: "/t", capture: true });
  const line = ((er.stdout || "").split("\n").find((l) => l.startsWith("ERRNO ")) || "").slice(6);
  ok(
    line === "ERR_FS_CP_DIR_TO_NON_DIR:21 ERR_FS_CP_NON_DIR_TO_DIR:20 ERR_FS_CP_EINVAL:22 ERR_FS_EISDIR:21",
    `every ERR_FS_CP_* carries its POSIX errno (got "${line}")`,
  );

  // `fs.cp(a, a)` used to copy a file onto itself: Node decides "same file" with
  // `destStat.ino && destStat.dev && …`, and the VFS reported dev 0, which makes the
  // whole conjunction falsy. It is the async path that matters most here, since that
  // one was already reachable.
  writeProject(h.kernel, "/t", {
    "self.js": `const fs = require('fs');
fs.writeFileSync('/t/self.txt', 'PRECIOUS');
fs.cp('/t/self.txt', '/t/self.txt', (e) => {
  console.log('SELF ' + (e ? e.code : 'no-error') + ' content=' + fs.readFileSync('/t/self.txt', 'utf8'));
});
`,
  });
  const sr = await h.kernel.start("node", ["/t/self.js"], { cwd: "/t", capture: true });
  const self = ((sr.stdout || "").split("\n").find((l) => l.startsWith("SELF ")) || "").slice(5);
  ok(
    self === "ERR_FS_CP_EINVAL content=PRECIOUS",
    `async fs.cp refuses to copy a file onto itself, intact (got "${self}")`,
  );
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* scratch */
}

console.log(`\nRESULT: ${failed === 0 ? "PASS — fs.cp/cpSync match real Node" : `FAIL — ${failed} check(s)`}`);
process.exit(failed === 0 ? 0 : 1);
