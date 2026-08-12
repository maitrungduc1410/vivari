// Spike (OFFLINE, no kernel, no Wasm): hold the spike tiers to what their own
// labels promise, so a spike cannot be registered in a job that cannot run it.
//
// WHY THIS EXISTS. `http-binary-body` is registered `net: false` and tests binary
// request bodies — it installs nothing. But booting the shared harness used to
// load the real npm CLI into the VFS, and that CLI is a vendored tree the runner
// only provisions for the `--net` tier. So the spike exited 2 before its first
// assertion, in the PR-gating `verify` job, on master. Nothing caught it, because
// the tier flag is a claim about the spike and we had never checked the claim.
//
// The cost had already been paid once, quietly: three spikes had hand-rolled
// their own kernel boot specifically to get away from that coupling, which is the
// opposite of what a shared harness is for. So the invariant below is not
// bookkeeping — it is the thing that was actually broken.
//
// Gates:
//   1. Every `net: false` spike is runnable with no registry: no `vendor` spec,
//      no npmInstall(), no bootSpikeKernel({ npm: true }).
//   2. The vendored-npm path is consulted in exactly ONE place in the harness,
//      inside loadRealNpm() — which is what makes gate 1's list of ways to
//      require it complete, rather than the three ways we happen to know about.
//   3. Every `needsWasm` offline spike is named in ci.yml's Wasm-VFS step, and
//      nothing else is. A `needsWasm` spike missing from that list runs NOWHERE:
//      the Wasm-free gate skips it for want of the crates, and it is never
//      selected in the only job that has them. ci.yml says so in a comment; this
//      is that comment, enforced.
//   3b. Every spike that exits 2 without a packed vendor asset declares that
//      asset in the runner's VENDORS table. The asset is a gitignored build
//      artifact, so an undeclared one makes the spike pass or fail on what ELSE
//      the run happened to select before it.
//   3c. Every NET spike that reads the shipped template locks declares them, so
//      a job cannot run a lock gate against a tree with no locks. Two jobs did.
//   4. Every offline spike that boots a kernel is marked `needsWasm` — the
//      converse of gate 3, and the hole it left. `net-close-order` and
//      `net-blocklist` were registered without the flag because neither guest
//      touches a file, which is true and is not the question: booting a kernel
//      starts the fs worker, and that worker loads the VFS crate before any
//      guest runs. Both crashed the Wasm-free gate with MODULE_NOT_FOUND, and
//      nothing local reproduced it, because a developer's tree has the crates.
//
//   run:  node scripts/spike-ci-tiers.mjs

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The runner's own selection rule, imported rather than restated so this gate
// cannot drift from the thing it is checking. Safe to import where run-spikes.mjs
// is not: it declares one function and touches nothing (see its header).
import { matchesFilter } from "./lib/spike-filter.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};

// The registry, parsed rather than imported: importing run-spikes.mjs would RUN
// the spikes. Same reason spike-python-offline.mjs parses templates.ts.
const runner = read("scripts/run-spikes.mjs");
const SPIKES = [...runner.matchAll(/^ {2}\{ name: "([^"]+)", file: "([^"]+)"(.*)$/gm)].map((m) => ({
  name: m[1],
  file: m[2],
  net: /\bnet:\s*true/.test(m[3]),
  needsWasm: /\bneedsWasm:\s*true/.test(m[3]),
  vendor: /\bvendor:\s*VENDORS\./.test(m[3]),
  vendorKey: (m[3].match(/\bvendor:\s*VENDORS\.(\w+)/) || [])[1] || null,
}));
// The `{ script, asset }` half of VENDORS, keyed the way a spike names it. The
// `{ install, dir }` half has no asset and simply does not appear here.
const VENDOR_ASSETS = Object.fromEntries(
  [...runner.matchAll(/^ {2}(\w+):\s*\{[^}]*\basset:\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]]),
);

console.log("== the registry parses ==");
ok(SPIKES.length > 40, `${SPIKES.length} spikes registered`);
ok(SPIKES.some((s) => s.net) && SPIKES.some((s) => !s.net), "…in both tiers");
ok(SPIKES.some((s) => s.vendor), "…and the vendor specs are visible to this check");

// A registered spike whose file is absent is not a loud failure: run-spikes.mjs
// skips it with a one-line note and still exits 0, so the tier stays green while
// the coverage is gone. That is how `signals` went missing for a whole sync.
{
  const missing = SPIKES.filter((s) => !fs.existsSync(path.join(ROOT, "scripts", s.file)));
  ok(missing.length === 0,
    missing.length
      ? `registered but absent, so the runner skips them silently: ${missing.map((s) => s.file).join(", ")}`
      : `all ${SPIKES.length} registered spike files exist, so none is being skipped into a green run`);
}

// ---------------------------------------------------------------------------
console.log("\n== every offline spike can actually run offline ==");
// ---------------------------------------------------------------------------
{
  const offline = SPIKES.filter((s) => !s.net);
  for (const s of offline) {
    const problems = [];
    // A `vendor` spec shells out to the live registry to provision itself, so a
    // spike carrying one is network-dependent whatever its own assertions do.
    if (s.vendor) problems.push("carries a `vendor` spec, which is provisioned from the registry");

    const srcPath = path.join(ROOT, "scripts", s.file);
    if (!fs.existsSync(srcPath)) {
      // Not this check's business — the runner skips a missing file with a note.
      console.log(`  · ${s.name}: scripts/${s.file} not present, nothing to read`);
      continue;
    }
    const src = fs.readFileSync(srcPath, "utf8");
    // These three all load the vendored npm tree, which only the --net tier
    // provisions (see lib/spike-harness.mjs) — but only if the spike is talking
    // to the harness at all. Scoping on the import keeps the scan off files that
    // merely mention the names, this one included.
    if (/from "\.\/lib\/spike-harness\.mjs"/.test(src)) {
      if (/\bnpmInstall\s*\(/.test(src)) problems.push("calls npmInstall(), which loads the vendored npm");
      if (/bootSpikeKernel\s*\(\s*\{[^}]*\bnpm:\s*true/.test(src)) problems.push("boots with { npm: true }");
      if (/\bloadRealNpm\s*\(/.test(src)) problems.push("calls loadRealNpm() directly");
    }

    ok(problems.length === 0, `${s.name}: ${problems.length ? problems.join("; ") : "needs nothing the --net tier provisions"}`);
  }
}

// ---------------------------------------------------------------------------
console.log("\n== a spike that refuses without a packed vendor asset declares it ==");
// A `-studio`-shape spike opens with a hard preflight: if its packed asset is not
// on disk it prints "No vendor asset at …" and exits 2. The asset is a gitignored
// build artifact, so on a fresh checkout it is NEVER on disk — the runner's
// `vendor` spec is the only thing that puts it there.
//
// Without the spec the spike does not fail honestly, it fails ORDER-DEPENDENTLY.
// `starlight-studio` and `starlight-depcache` both need npm-pack.bin and neither
// declared it, so both exited 2 in 0.0s — and then `npm-studio`, which does
// declare it and sorts after them, provisioned the very file they had just been
// killed for. Run those two alone and they fail; run the whole tier and whether
// they pass depends on what else was selected. That is the failure mode the
// VENDORS table exists to remove, so the declaration is what gets checked.
// ---------------------------------------------------------------------------
{
  for (const s of SPIKES) {
    // This file is itself a registered spike, and the scan below is a plain text
    // search — the marker it looks for is written twice right here, in the regex
    // and in the comment above it, so the filter reads this file's own source as a
    // spike demanding an asset. Today it gets no further, because nothing here
    // matches the packed-path shape: add one documentation example of that path and
    // the gate fails on itself, with a message about a spike that is not one. So
    // this is deliberate rather than lucky, for the reason the harness-scoped scans
    // above and below give for excluding this file from theirs.
    if (s.file === "spike-ci-tiers.mjs") continue;
    const srcPath = path.join(ROOT, "scripts", s.file);
    if (!fs.existsSync(srcPath)) continue;
    const src = fs.readFileSync(srcPath, "utf8");
    // Only the spikes that REFUSE to run without one — a spike that merely reads
    // the path, or provisions it itself, is not making a demand of the runner.
    if (!/No vendor asset at/.test(src)) continue;
    const packed = src.match(/path\.join\([^)]*"vendor",\s*"([^"]+)"\s*\)/);
    if (!packed) continue;
    const needs = `packages/studio/public/vendor/${packed[1]}`;
    ok(
      VENDOR_ASSETS[s.vendorKey] === needs,
      s.vendorKey
        ? `${s.name}: declares the ${packed[1]} it exits 2 without (VENDORS.${s.vendorKey})`
        : `${s.name}: exits 2 without ${packed[1]} but declares no vendor, so it only runs if something else provisioned it first`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3c. Every NET spike that reads the shipped template locks declares them.
//
// The gate above keys on one refusal marker — "No vendor asset at", the
// `-studio` preflight — and the lock consumers do not use it. `template-locks`
// refuses in its own words ("no generated lock at …") and the eight template
// spikes do not refuse at all: `runViteSpike` prints "NO generated lockfile —
// installing from ranges, which is not what the studio does" and carries on. So
// `template-gate`, which had a `vendor:locks` step, and `spikes-net`, which did
// not, ran the same nine spikes against different trees — one dead in 0.2s, the
// other eight quietly gating a code path the studio never takes.
//
// Derived from what the source reads rather than from a list, and one hop deep,
// because the eight reach the locks through scripts/lib/spike-vite-lib.mjs and a
// ninth will reach them through something else. Restricted to `net: true`: an
// offline spike cannot declare a vendor (gate 1 forbids it, since provisioning
// shells out to the registry), and the offline ones that read locks are covered
// instead by spike-clean-checkout.mjs, which runs them on a tree that has none.
// That split is the whole answer to "why did nothing catch this": clean-checkout
// covers the offline half by design and says so, and the net half is the
// runner's job, which had no entry for the artifact.
// ---------------------------------------------------------------------------
{
  const LOCKS = "packages/studio/public/vendor/locks";
  console.log("\n== a net spike that reads the shipped locks declares them ==");
  let checked = 0;
  for (const s of SPIKES) {
    if (!s.net) continue;
    const srcPath = path.join(ROOT, "scripts", s.file);
    if (!fs.existsSync(srcPath)) continue;
    let text = fs.readFileSync(srcPath, "utf8");
    for (const m of text.matchAll(/from\s+"(\.\/(?:lib\/)?[\w.-]+\.mjs)"/g)) {
      const lib = path.join(ROOT, "scripts", m[1]);
      if (fs.existsSync(lib)) text += fs.readFileSync(lib, "utf8");
    }
    if (!text.includes("vendor/locks")) continue;
    checked++;
    ok(s.vendorKey === "locks", `${s.name}: reads ${LOCKS} and declares VENDORS.locks`);
  }
  ok(checked >= 9, `${checked} net spikes read the shipped locks (template-locks + the template gates)`);
  // The producer writes a SET, so its manifest existing proves nothing about the
  // files it names — which is exactly the tree an interrupted run leaves. Pinned
  // because reverting to a plain existence probe would restore the bug silently:
  // every assertion above still passes, and CI goes back to running the lock
  // spikes against whatever locks happened to survive.
  ok(/\blocks:\s*\{[^}]*\balways:\s*true/.test(runner), "VENDORS.locks re-runs its producer rather than probing for one file");
  ok(/\blocks:\s*\{[^}]*"--strict"/.test(runner), "…with --strict, so a producer that ships nothing fails the spike rather than the assertion");
  ok(
    (VENDOR_ASSETS.locks || "").startsWith(LOCKS),
    `…and points at ${LOCKS}, so a failed run cannot report success`,
  );
}

// ---------------------------------------------------------------------------
console.log("\n== an offline spike that boots a kernel says it needs the Wasm VFS ==");
// The flag only changes anything in the Wasm-free gate, which runs the offline
// tier alone — a net spike boots the same kernel, but only ever in the job that
// builds the crates. So this is scoped to offline, exactly like gate 3.
//
// Scoped on the harness import for the same reason as the check above: this very
// file names bootSpikeKernel in a regex, and a bare scan would flag it.
//
// One-directional on purpose. A spike may need the crates for something other
// than a kernel — a dozen mark needsWasm and never call bootSpikeKernel, because
// they hand-roll a boot or load a crate directly — so booting implies the flag,
// not the reverse.
// ---------------------------------------------------------------------------
{
  for (const s of SPIKES.filter((x) => !x.net)) {
    const srcPath = path.join(ROOT, "scripts", s.file);
    if (!fs.existsSync(srcPath)) continue;
    const src = fs.readFileSync(srcPath, "utf8");
    if (!/from "\.\/lib\/spike-harness\.mjs"/.test(src)) continue;
    if (!/\bbootSpikeKernel\s*\(/.test(src)) continue;
    ok(s.needsWasm, `${s.name}: boots a kernel, so it is marked needsWasm`);
  }
}

// ---------------------------------------------------------------------------
console.log("\n== …and the list of ways to need it is complete ==");
// The check above enumerates three ways a spike can pull in the vendored npm.
// That enumeration is only trustworthy while the harness has one door. If a
// fourth appears — a second existsSync on the vendor path, a reader that is not
// loadRealNpm — the check above silently stops covering it, so pin the shape.
// ---------------------------------------------------------------------------
{
  const harness = read("scripts/lib/spike-harness.mjs");
  const body = harness.slice(harness.indexOf("export async function bootSpikeKernel"));
  const reads = [...body.matchAll(/VV_VENDOR_NPM|VENDOR_NPM/g)];
  const loader = body.slice(body.indexOf("const loadRealNpm"), body.indexOf("// Until then"));
  const readsInLoader = [...loader.matchAll(/VV_VENDOR_NPM|VENDOR_NPM/g)];
  ok(loader.length > 0 && reads.length === readsInLoader.length,
    `the vendored-npm path is read only inside loadRealNpm() (${readsInLoader.length}/${reads.length} references)`);
  ok(/process\.exit\(2\)/.test(loader), "…and the honest 'no vendored npm' refusal is still there for spikes that do install");
  ok(/npmInstall\([\s\S]{0,200}?loadRealNpm\(\)/.test(harness),
    "npmInstall() loads it on demand, so an installing spike needs no ceremony");
  ok(/bootSpikeKernel\(\{ npm = false/.test(harness), "…and booting does not, by default");
}

// ---------------------------------------------------------------------------
console.log("\n== the Wasm-VFS offline spikes are wired into the one job that can run them ==");
// ---------------------------------------------------------------------------
{
  const ci = read(".github/workflows/ci.yml");
  const line = ci.match(/run: node scripts\/run-spikes\.mjs --offline (.+)/);
  ok(line, "ci.yml has an offline step that names spikes explicitly");
  const named = line ? line[1].trim().split(/\s+/) : [];
  const wasmOffline = SPIKES.filter((s) => !s.net && s.needsWasm);
  ok(wasmOffline.length > 0, `${wasmOffline.length} offline spikes need the Wasm VFS`);

  // The runner's filter is a substring match, so a name is covered when any
  // listed filter is a substring of it — that is how `bun` also pulls in
  // `bun-templates`, deliberately. A `$`-suffixed filter is anchored instead.
  for (const s of wasmOffline) {
    ok(named.some((f) => matchesFilter(s.name, f)),
      `${s.name} is selected by that step (else it runs in no job at all)`);
  }
  // And nothing stale: a filter matching no registered offline spike is a typo
  // that silently narrows the job.
  for (const f of named) {
    ok(SPIKES.some((s) => !s.net && matchesFilter(s.name, f)), `the step's '${f}' filter still matches a registered offline spike`);
  }
}

// ---------------------------------------------------------------------------
console.log("\n== the net steps name spikes that exist ==");
// ---------------------------------------------------------------------------
// Same defect as the stale-filter check above, on the other tier, and it now has a
// job where it would matter: `template-gate` can go red, so a filter that matches
// nothing turns it into a job that proves nothing while reporting success. The
// runner exits 0 on an empty selection, which is what makes this invisible.
{
  const ci = read(".github/workflows/ci.yml");
  const steps = [...ci.matchAll(/run: node scripts\/run-spikes\.mjs --net (.+)/g)];
  ok(steps.length > 0, `ci.yml has ${steps.length} net step(s) that name spikes explicitly`);
  for (const step of steps) {
    const named = step[1].trim().split(/\s+/);
    for (const f of named) {
      ok(
        SPIKES.some((s) => s.net && matchesFilter(s.name, f)),
        `the net step's '${f}' filter matches a registered net spike`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
console.log("\n== the Wasm build pins its wasm-pack ==");
// ---------------------------------------------------------------------------
// `version: latest` is not the newest release — it is whatever the action
// resolves, and it resolved to wasm-pack 0.10.3, which fetches binaryen 90.
// Binaryen 90 predates multi-table support, and wasm-bindgen emits two tables,
// so wasm-opt died with "Only 1 table definition allowed in MVP" and took the
// whole `verify` job with it. No commit caused that and no commit can fix it:
// the version has to be a version.
{
  const MIN = [0, 13, 1]; // 0.13.1 fetches binaryen 117, which parses two tables.
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  for (const wf of ["ci.yml", "publish.yml"]) {
    const uses = [...read(`.github/workflows/${wf}`)
      .matchAll(/jetli\/wasm-pack-action@[^\n]*\n\s+with:\n\s+version:\s*(\S+)/g)].map((m) => m[1]);
    ok(uses.length > 0, `${wf}: installs wasm-pack in ${uses.length} job(s)`);
    for (const v of uses) {
      const parts = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v);
      ok(!!parts, `${wf}: pinned to a concrete version, not a moving target (got '${v}')`);
      if (parts) {
        ok(cmp(parts.slice(1).map(Number), MIN) >= 0,
          `${wf}: ${v} is >= 0.13.1, so its wasm-opt can parse a two-table module`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
console.log("\n== no tracked file names a private host ==");
// ---------------------------------------------------------------------------
// A host reaches a published repo through documentation: a failure gets quoted
// verbatim and the host inside the quote rides along, which is not something a
// review reliably catches. Every host in an example therefore belongs to a
// reserved TLD (RFC 2606: .invalid, .example, .test), so the substitute can
// never resolve to a real machine, and this check holds that line.
{
  const HOSTS = [
    // A bare `10.x` is RFC 1918 and appears legitimately in BlockList fixtures;
    // one with a port is somebody's actual service.
    /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+\b/,
  ];
  // Tracked files only: node_modules, target/ and public/vendor/ are fetched or
  // generated, and none of them is ours to keep clean.
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 })
    .split("\0")
    .filter((p) => p && /\.(m?js|cjs|ts|tsx|json|md|ya?ml|toml|sh|rs|html|css)$/.test(p));
  ok(tracked.length > 100, `scanning ${tracked.length} tracked text files`);

  const hits = [];
  for (const rel of tracked) {
    let text;
    try {
      text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    } catch {
      continue; // deleted between ls-files and here
    }
    text.split("\n").forEach((line, i) => {
      for (const re of HOSTS) if (re.test(line)) hits.push(`${rel}:${i + 1}`);
    });
  }
  ok(hits.length === 0, hits.length ? `private hosts in: ${hits.slice(0, 8).join(", ")}` : "none found");
}

console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: the spike tiers match what CI can give them");
process.exit(failed ? 1 : 0);