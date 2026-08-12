// Spike (OFFLINE, no kernel, no Wasm): run the offline gates that read build
// output on a tree that has NONE, because that is the tree CI checks out and it
// is not the tree any of us develop on.
//
// WHY THIS EXISTS. Three regressions in a row came from the same gap, and every
// one of them was found by CI or by a user rather than here:
//
//   1. `predev` did not run `vendor:locks`, so a developer's locks were only
//      ever the ones some earlier command left behind.
//   2. A react-ts snapshot was reused across a lock whose bytes had moved. The
//      asset was present, the manifest listed it, the producer printed "reused"
//      — and the key no user would ever compute again.
//   3. Six assertions in `install-latency` covering exactly that rule passed
//      here and failed in CI, because `unreachable` re-read the shipped lock
//      itself. Where the file exists the fixture and the function happened to
//      agree; on a bare checkout every call returned "no shipped lock to key it
//      against" before reaching any behaviour the six assertions named.
//
// The common shape is not a bug in any of those files. It is that
// `packages/studio/public/vendor` and the compiled crates are gitignored build
// output which SURVIVES between commands on a developer's machine and never
// exists on a fresh checkout, so a gate that reads one is exercised locally and
// vacuous in the job that gates the merge. Nothing about that is visible from
// here: the gate is green, it just green on inputs CI cannot supply.
//
// WHAT THIS COVERS, and what it deliberately does not. The designated set is
// DERIVED, not listed: every offline spike whose own source, or a scripts/lib
// module it imports, reads something under `packages/studio/public/vendor`. That
// is the artifact class all three incidents came from, and deriving it means a
// new gate over shipped bytes is covered the day it is written rather than the
// day someone remembers to add it here.
//
// Not the whole offline tier, for two reasons. It would contain this file, so it
// would recurse. And measured on a bare tree it is 3.5 minutes for 20 spikes that
// run and 28 that skip for want of the Wasm VFS — the skips prove nothing and the
// runners are mostly kernel behaviour that has no artifact to lose. The derived
// set is ~6 spikes and about 17 s, which is a price worth paying on every offline
// run; four minutes is not, and a guard people switch off is not a guard.
//
// This catches a gate that FAILS without its artifact. It does not catch one that
// PASSES vacuously — an assertion inside `if (fs.existsSync(built))` still reads
// as green here, because from the outside a skipped assertion and an absent one
// are the same thing. Hole 1 of incident 3 was exactly that shape and was fixed
// by hand, not by this. Closing it needs the count of assertions to be compared
// between the two trees, which turns every added assertion into a golden number
// to bump; that trade was refused deliberately, and this comment is the record.
//
//   run:  node scripts/spike-clean-checkout.mjs

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};

const git = (args, cwd = ROOT) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// ---------------------------------------------------------------------------
console.log("\n== which offline gates read build output ==");
// Parsed rather than imported, because importing run-spikes.mjs would run the
// spikes — the same reason spike-ci-tiers.mjs parses it.
// ---------------------------------------------------------------------------
const SELF = "spike-clean-checkout.mjs";
// `public/vendor` is the whole of it: the locks, the depcache, the packed
// package managers and pyodide all live under that one gitignored prefix, so one
// pattern covers the class without enumerating its members.
const READS_BUILD_OUTPUT = /public\/vendor|vendor\/(locks|depcache|npm|pyodide)/;

const designated = [];
{
  const runner = fs.readFileSync(path.join(ROOT, "scripts/run-spikes.mjs"), "utf8");
  const spikes = [...runner.matchAll(/^ {2}\{ name: "([^"]+)", file: "([^"]+)"(.*)$/gm)]
    .map((m) => ({ name: m[1], file: m[2], net: /net:\s*true/.test(m[3]), wasm: /needsWasm:\s*true/.test(m[3]) }))
    // `needsWasm` is out because no job runs one on a bare checkout: the
    // Wasm-free gate skips it for want of the crates, and the job that has them
    // built them. Running it here anyway reports a crash the runner would never
    // have let happen — `depcache-shipped` dies on MODULE_NOT_FOUND for the VFS
    // crate, which says nothing about build output and would train a reader to
    // ignore this spike.
    .filter((s) => !s.net && !s.wasm && s.file !== SELF);

  for (const s of spikes) {
    const at = path.join(ROOT, "scripts", s.file);
    if (!fs.existsSync(at)) continue;
    const src = fs.readFileSync(at, "utf8");
    // One level through scripts/lib and the generators, because a spike that
    // reads shipped bytes through a helper is in the class just as much as one
    // that spells the path itself — `install-latency` reaches the locks through
    // gen-depcache.mjs, and a scan of its own source alone would miss it.
    const sources = [src];
    for (const [, rel] of src.matchAll(/from "\.\/((?:lib\/)?[a-z0-9-]+\.mjs)"/g)) {
      const dep = path.join(ROOT, "scripts", rel);
      if (fs.existsSync(dep)) sources.push(fs.readFileSync(dep, "utf8"));
    }
    if (sources.some((t) => READS_BUILD_OUTPUT.test(t))) designated.push(s);
  }
}
ok(designated.length >= 4, `${designated.length} offline spikes read build output: ${designated.map((s) => s.name).join(", ")}`);
// The gate that broke is the reason this file exists; if the derivation ever
// stops reaching it, the derivation is wrong rather than the list being short.
ok(
  designated.some((s) => s.file === "spike-install-latency.mjs"),
  "…including install-latency, the one whose six checks were vacuous in CI",
);

// ---------------------------------------------------------------------------
console.log("\n== a tree of tracked files only ==");
// ---------------------------------------------------------------------------
let tree = null;
let absent = [];
{
  let tracked;
  try {
    tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean);
  } catch {
    console.log("  · not a git repository, so there is no tracked-file set to build one from; skipping");
    console.log("\nOK: nothing to check without git");
    process.exit(0);
  }

  // Copied from the WORKING TREE rather than `git archive HEAD`, so the files
  // under test are the ones being edited. CI's checkout is HEAD and the two
  // agree there; locally, archiving HEAD would gate the last commit and quietly
  // pass a change that has not been committed yet.
  tree = fs.mkdtempSync(path.join(os.tmpdir(), "vv-clean-"));
  for (const rel of tracked) {
    const from = path.join(ROOT, rel);
    if (!fs.existsSync(from)) continue; // deleted-but-tracked
    const to = path.join(tree, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  // A checkout has a git dir, and gates that ask git what is tracked need one.
  // `spike-ci-tiers` scans every tracked file for private hosts and dies
  // with "not a git repository" without this — a failure of the fixture, which
  // would read here as a failure of the spike.
  git(["init", "-q"], tree);
  // `-f`, because a few tracked files predate the .gitignore rule that now
  // matches them and a plain `add` silently leaves them out. A real checkout has
  // them in its index, so the fixture must too, or the two lists differ by three
  // files for a reason that has nothing to do with build output.
  git(["add", "-A", "-f"], tree);
  ok(fs.existsSync(path.join(tree, "scripts/run-spikes.mjs")), `${tracked.length} tracked files copied`);
  // Asserted rather than assumed, because without it the failure lands on
  // whichever spike asks git first and reads as that spike's bug. Anyone
  // reproducing this by hand with `git archive | tar -x` gets a directory with
  // no `.git`, `ci-tiers` dies "fatal: not a git repository", and the answer
  // looks like a seventh regression instead of a missing fixture.
  ok(
    git(["ls-files"], tree).split("\n").filter(Boolean).length === tracked.length,
    "…and git can see all of them there, which the gates that ask it what is tracked need",
  );

  // What this tree is MISSING relative to the one it was copied from: the
  // gitignored build output that a developer accumulates and a fresh checkout
  // has never had. Derived from .gitignore's absolute entries, so a new build
  // artifact is named without being registered anywhere.
  absent = fs
    .readFileSync(path.join(ROOT, ".gitignore"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("/") && !l.includes("*"))
    .map((l) => l.slice(1))
    .filter((rel) => fs.existsSync(path.join(ROOT, rel)) && !fs.existsSync(path.join(tree, rel)));
  ok(true, `absent here, present in the working tree: ${absent.length ? absent.join(", ") : "nothing — this tree is already clean"}`);
}

// ---------------------------------------------------------------------------
console.log("\n== every one of them still passes there ==");
// ---------------------------------------------------------------------------
try {
  for (const s of designated) {
    const started = Date.now();
    let out = "";
    let code = 0;
    try {
      out = execFileSync(process.execPath, [path.join("scripts", s.file)], {
        cwd: tree,
        encoding: "utf8",
        timeout: 120000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      out = `${e.stdout || ""}${e.stderr || ""}`;
      code = e.status ?? "killed";
    }
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    ok(code === 0, `${s.name} (${secs}s) on tracked files alone`);
    if (code === 0) continue;

    // Loud, and specific about WHICH tree it failed on, because the reader's own
    // tree will not reproduce it — that is the entire point of this spike, and a
    // bare non-zero exit here sends them looking for a bug in their working copy.
    //
    // But only if it is true. This used to print "It passes in this working tree"
    // unconditionally and then name the absent artifacts as the cause, which is a
    // diagnosis rather than an observation — and the first time a designated gate
    // failed for an unrelated reason (install-latency, holding three assertions
    // about a CI step that had just been deleted), it sent the reader hunting for
    // a missing build artifact that had nothing to do with it. The control run is
    // what tells the two apart, so it is run rather than assumed. Only on failure,
    // so the happy path still costs one run of each gate.
    const why = (t) => t.split("\n").filter((l) => /✗|FAIL:|Error:/.test(l));
    let controlCode = 0;
    let controlOut = "";
    try {
      controlOut = execFileSync(process.execPath, [path.join("scripts", s.file)], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 120000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      controlOut = `${e.stdout || ""}${e.stderr || ""}`;
      controlCode = e.status ?? "killed";
    }
    console.log(`\n    ${s.name} FAILED — scripts/${s.file}, exit ${code} on a tree of tracked files only`);
    if (controlCode === 0) {
      console.log(`    It PASSES in this working tree, so the difference is the build output it has and a checkout does not:`);
      for (const rel of absent) console.log(`      ${rel}`);
      console.log(`    So scripts/${s.file} reads one of those and does not survive its absence.`);
      console.log(`    Reproduce:  ${process.execPath} scripts/${s.file}   (in a tree with only tracked files)`);
      for (const l of why(out).slice(0, 12)) console.log(`      ${l.trim()}`);
    } else {
      // Same failure both ways: this spike's subject is absent, and saying so is
      // the whole value here. Naming the artifacts would point at the one thing
      // just proved innocent.
      console.log(`    It FAILS the same way in this working tree (exit ${controlCode}), so the checkout is NOT the cause.`);
      console.log(`    Nothing here is about build output. Fix scripts/${s.file} on its own terms:`);
      console.log(`    Reproduce:  ${process.execPath} scripts/${s.file}   (anywhere)`);
      for (const l of why(controlOut).slice(0, 12)) console.log(`      ${l.trim()}`);
    }
    console.log("");
  }
} finally {
  fs.rmSync(tree, { recursive: true, force: true });
}

console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: the gates that read build output survive a checkout without it");
process.exit(failed ? 1 : 0);