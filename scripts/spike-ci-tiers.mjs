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
//
//   run:  node scripts/spike-ci-tiers.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
}));

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
  // `bun-templates`, deliberately.
  for (const s of wasmOffline) {
    ok(named.some((f) => s.name.includes(f)),
      `${s.name} is selected by that step (else it runs in no job at all)`);
  }
  // And nothing stale: a filter matching no registered offline spike is a typo
  // that silently narrows the job.
  for (const f of named) {
    ok(SPIKES.some((s) => !s.net && s.name.includes(f)), `the step's '${f}' filter still matches a registered offline spike`);
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
        SPIKES.some((s) => s.net && s.name.includes(f)),
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

console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: the spike tiers match what CI can give them");
process.exit(failed ? 1 : 0);