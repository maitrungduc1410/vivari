// Spike (OFFLINE, no kernel, no Wasm): the install-latency work that has no
// runtime surface to assert against — build wiring, boot ordering, and the two
// producer/consumer contracts that fail SILENTLY when they drift.
//
// Everything here is a fact about the repository, so it is checked by reading
// the repository. That is not a second-best: each of these failures is invisible
// at runtime by construction. A missing vendor step answers 200 with the SPA's
// index.html. A manifest nobody writes is caught and read as "feature off". An
// asset fetched at boot that nothing needs just makes the page slower. None of
// them throws, so nothing downstream can gate them.
//
// Gates:
//   1. cloudflare-build.sh — the DEPLOY — builds every vendor asset that
//      prebuild:studio does. This list drifted and shipped: ruff and sqlite were
//      in prebuild:studio and not in the deploy, so /studio/vendor/sqlite/
//      sqlite3.wasm has been answering with the landing page.
//   2. The depcache and lock producers write the exact paths the kernel worker
//      fetches. Coverage was 0/~70 templates because nothing wrote the manifest;
//      a renamed path is the same outage with a producer in place.
//   3. npm is loaded on demand, not at boot. 2.79 MB — 48.6% of the cold-boot
//      payload — was awaited between `kernel-online` and `ready`, including on
//      the snapshot-restore path where npm is never spawned.
//   4. `npm_config_prefer_offline`. Measured: 141 revalidation round-trips on a
//      warm second project, every one of them a 304 with no body.
//   5. gen-template-locks' eligibility rule still selects the templates whose
//      install is the expensive one. The rule is derived, not listed, so the way
//      it fails is by matching fewer and fewer templates in silence.
//   6. Neither producer can fail the deploy. Both run under `set -euo pipefail`,
//      where exiting non-zero over a missing optimisation takes the landing
//      page, the docs, the blog and the studio down with it.
//   7. Every SHIPPED lockfile has a `--net` spike that installs that template
//      from it. A lock resolved on the host and unreifiable in the VM breaks a
//      template rather than slowing it, for everyone, on one deploy.
//
//   run:  node scripts/spike-install-latency.mjs

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  COVERAGE,
  NOT_BOOTABLE,
  REGISTRY,
  aliasOverrides,
  assertNoAliasedNatives,
  assertPeerProviders,
  assertPublicRegistry,
  eligibility,
  unpublish,
  writeOptionalManifest,
} from "./gen-template-locks.mjs";
import { unreachable } from "./gen-depcache.mjs";
import { STRIP_DEFAULT_FROM, STRIP_FLAG_FROM, STRIP_HOOKS_FROM } from "./lib/import-ts.mjs";
import { hashDepKey, writeSnapshotContainer } from "../packages/kernel-host/dep-cache.js";
import { checkKernelAssets } from "./lib/site-headers.mjs";
import { loadShippedTemplates } from "./lib/shipped-templates.mjs";

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};

const pkg = JSON.parse(read("package.json"));
const build = read("scripts/cloudflare-build.sh");
const worker = read("packages/core/src/workers/kernel-worker.ts");

// ---------------------------------------------------------------------------
console.log("== the deploy builds every vendor asset the studio expects ==");
// ---------------------------------------------------------------------------
{
  const inPrebuild = [...pkg.scripts["prebuild:studio"].matchAll(/npm run (vendor:[\w-]+)/g)].map((m) => m[1]);
  ok(inPrebuild.length > 5, `prebuild:studio builds ${inPrebuild.length} vendor assets`);
  const inDeploy = new Set([...build.matchAll(/npm run (vendor:[\w-]+)/g)].map((m) => m[1]));
  ok(inDeploy.size > 0, `cloudflare-build.sh builds ${inDeploy.size}`);
  for (const step of inPrebuild) {
    ok(inDeploy.has(step), `${step} runs on the deploy, not only in prebuild:studio`);
  }
  // Every vendor:* script the root declares should be reachable from the deploy
  // too — a new asset added to package.json alone repeats exactly this bug.
  const declared = Object.keys(pkg.scripts).filter((k) => k.startsWith("vendor:"));
  for (const name of declared) {
    ok(inDeploy.has(name), `${name} is called by the deploy`);
  }

  // …and from the LOCAL paths, which is the half that shipped broken. `predev`
  // and `prebuild:studio` ran the original eight and not `vendor:locks` or
  // `vendor:depcache`, and packages/studio/public/vendor is gitignored — so
  // `npm run dev` produced a studio with no lockfile and no snapshot, and the
  // two headline optimisations of this change were invisible to anyone
  // verifying locally. A user lost an afternoon concluding they did nothing.
  //
  // Cheap to keep on: like all eight siblings, both reuse an existing asset
  // unless --force, so the cost after the first run is a stat().
  for (const local of ["predev", "prebuild:studio"]) {
    const steps = [...pkg.scripts[local].matchAll(/npm run (vendor:[\w-]+)/g)].map((m) => m[1]);
    for (const name of declared) ok(steps.includes(name), `${name} runs on \`npm run ${local}\``);
    // Order matters for exactly one pair: the snapshot is built by installing
    // from the resolved lock, so a depcache run that precedes the locks run
    // finds no lockfile and skips every template.
    const l = steps.indexOf("vendor:locks");
    const d = steps.indexOf("vendor:depcache");
    ok(l >= 0 && d >= 0 && l < d, `…with locks before depcache, since the snapshot installs from the lock`);
  }
}

// ---------------------------------------------------------------------------
console.log("\n== the template loader survives a Node that does not strip types ==");
// ---------------------------------------------------------------------------
// Thirteen scripts read the studio's templates by importing a .ts file, and two
// of them now run on every `npm run dev`. Node strips types by default only
// from 22.18.0; 22.6.0 added it as a FLAG. So on the 22.0-22.17 that
// `engines.node` used to admit, the import failed and the dev server came up
// with none of the speedup.
//
// `--no-experimental-strip-types` IS NOT AN OLD NODE, and reading it as one is
// why this bug shipped twice. It turns default stripping off and leaves the
// running Node's loader machinery in place, and the two disagree on exactly the
// behaviour the first fix was built on: after a .ts import fails,
//
//   22.23 + the flag     retrying the SAME specifier once a hook is installed  -> works
//   22.16.0, really      retrying the SAME specifier once a hook is installed  -> STILL FAILS
//
// because 22.16 has memoised the failure against that specifier. Every other
// row of that table matches, which is what made the proxy so convincing.
// Measured on a real 22.16.0 binary; roadmap.md has the table.
//
// So the flag is kept for what it can honestly do — put the hook path under
// test on any Node — and the assertions below are about the PROPERTIES that
// make the design immune to the difference, rather than about the symptom:
// the caller's specifier is imported exactly ONCE, after capability has been
// settled on throwaway files, and the post-hook check is a real import rather
// than a `typeof`. The symptom is gated where it is real, in the `toolchain-floor`
// CI job, which pins `engines.node`'s own floor.
{
  // spawnSync rather than execFileSync because the STDERR of a child that
  // SUCCEEDS is half of what is under test here, and execFileSync only hands
  // that back on the failure path.
  const node = (args, code) => {
    const r = spawnSync(process.execPath, [...args, "--input-type=module", "-e", code], {
      cwd: ROOT,
      encoding: "utf8",
      // NODE_OPTIONS is dropped, not inherited. Every child here is defined by
      // the stripping regime it runs under, and an inherited
      // `--no-experimental-strip-types` silently rewrites that: it turned the
      // fault case below — which needs stripping ON — into a false failure the
      // first time the whole tier was run under the simulated old Node.
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    // The child's own `Error: …` line, for when the assertion below has to
    // report why. Neither end of its stderr is that line — it opens with a code
    // frame and closes with the `Node.js v22.x` banner, and a gate whose failure
    // text is the runtime's version banner is unreadable.
    const lines = (r.stderr || "").trim().split("\n");
    const errLine = lines.find((l) => /^[A-Za-z]*Error:/.test(l.trim())) || lines[0] || "";
    return { out: r.stdout || "", err: r.stderr || "", say: (r.stdout || "").trim() || `threw: ${errLine.trim()}` };
  };

  // Two scratch modules, in a directory of their own so the nearest
  // package.json is one this gate controls: `.ts` takes its module system from
  // the same rules as `.js`, so without `"type": "module"` an `export` here
  // would be read as CommonJS and fail for a reason that is not the one on test.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vv-import-ts-"));
  fs.writeFileSync(path.join(scratch, "package.json"), '{"type":"module"}');
  const okTs = path.join(scratch, "second.ts");
  const boomTs = path.join(scratch, "boom.ts");
  fs.writeFileSync(okTs, "export const second: number = 2;\n");
  fs.writeFileSync(boomTs, 'const detail: string = "boom from module scope";\nthrow new Error(detail);\n');

  try {
    // A second .ts import, CONCURRENT with the first, because concurrency is
    // what makes the memoised `ready` promise load-bearing. Two sequential
    // loads cannot tell a shared one-shot decision from a per-call one: the
    // second call finds the hook already installed either way. Two in flight
    // before it lands go through whatever sharing there is, so dropping the
    // memoisation shows up here as a second probe pair and a second notice.
    const LOAD = `
      const { importTs } = await import("./scripts/lib/import-ts.mjs");
      const { loadShippedTemplates } = await import("./scripts/lib/shipped-templates.mjs");
      const [templates] = await Promise.all([loadShippedTemplates(), importTs(${JSON.stringify(okTs)})]);
      process.stdout.write("count=" + templates.length);
    `;
    const load = node(["--no-experimental-strip-types"], LOAD);
    ok(/count=\d+/.test(load.out), `templates load with no ambient type stripping (${load.say.slice(0, 110)})`);

    // The user-facing half of the fix, which lives entirely on stderr and so
    // had no coverage at all: without these three, the notice and the warning
    // mute can both be deleted and every other assertion here stays green.
    const notices = load.err.split("\n").filter((l) => l.includes("[import-ts]"));
    ok(notices.length > 0, "…and say so, rather than silently paying for a stripper");
    ok(notices.length === 1, `…once per process, not once per import (${notices.length} for two .ts imports)`);
    // Node's own warning names an API the contributor never called. The notice
    // replaces it precisely because it names the version that removes the
    // fallback, so a leak here is the worse message winning.
    ok(!/ExperimentalWarning/.test(load.err), "…with Node's raw ExperimentalWarning muted, not leaked");

    // The two properties the whole design rests on, instrumented rather than
    // inferred. A `resolve` hook sees every `import()` attempt — including one
    // that goes on to fail at load, confirmed on both runtimes — so it can
    // count what the loader was ASKED for, which is the thing that differs
    // between "probe first" and "try, fail, retry".
    //
    //   target=1   the caller's specifier was imported once. A retry strategy
    //              reads 2 here, on the runtime where the retry works and on the
    //              one where it does not — so this fails on 22.23 for the bug
    //              that only bites on 22.16, which is the whole point.
    //   probes=2   capability was settled on two DIFFERENT throwaway files:
    //     distinct one before the hook, one after. Collapse the post-hook check
    //              into a `typeof`, or re-probe the same path the first probe
    //              already failed against, and this moves.
    const TRACE = (target) => `
      const module = (await import("node:module")).default;
      const { pathToFileURL } = await import("node:url");
      const TARGET = pathToFileURL(${JSON.stringify(target)}).href;
      const seen = [];
      module.registerHooks({
        resolve(spec, ctx, next) { const r = next(spec, ctx); if (r.url.endsWith(".ts")) seen.push(r.url); return r; },
      });
      const { importTs } = await import("./scripts/lib/import-ts.mjs");
      const mod = await importTs(${JSON.stringify(target)});
      const probes = seen.filter((u) => u !== TARGET);
      process.stdout.write("value=" + mod.second + " target=" + seen.filter((u) => u === TARGET).length +
        " probes=" + probes.length + " distinct=" + new Set(probes).size);
    `;
    const hookRun = node(["--no-experimental-strip-types"], TRACE(okTs));
    ok(hookRun.out.includes("value=2"), `the hooked path returns the real module's live values (${hookRun.say.slice(0, 90)})`);
    ok(hookRun.out.includes("target=1"), "…having imported the caller's specifier exactly once, never retried it");
    ok(hookRun.out.includes("probes=2 distinct=2"), "…and proven the hook on a second, fresh throwaway file");

    // The same trace where stripping is already ambient: one probe, no hook, and
    // nothing said. A notice here would be a line of noise on every `npm run
    // dev` for the majority of contributors, and probing twice would mean the
    // hook was installed on a Node that does not need it.
    const ambient = node(["--experimental-strip-types"], TRACE(okTs));
    ok(ambient.out.includes("target=1 probes=1"), "with ambient stripping, one probe settles it and nothing is installed");
    ok(!ambient.err.includes("[import-ts]"), "…and the notice stays quiet on the Node that needs no fallback");

    // A hook that ACCEPTS the registration and does nothing with it — which is
    // indistinguishable from a working one by any `typeof` test, and is the
    // reason the post-install check has to be an import.
    const INERT = `
      const module = (await import("node:module")).default;
      module.registerHooks = () => {};
      const { importTs } = await import("./scripts/lib/import-ts.mjs");
      try { await importTs(${JSON.stringify(okTs)}); process.stdout.write("UNEXPECTEDLY OK"); }
      catch (e) { process.stdout.write((e.code || "no-code") + "|" + e.message); }
    `;
    const inert = node(["--no-experimental-strip-types"], INERT).say;
    ok(inert.startsWith("ERR_NODE_CANNOT_STRIP_TYPES|"), "a stripper that registers but never strips is caught…");
    ok(/scratch \.ts still would not import/.test(inert), "…by importing a fresh file, and the message says so");

    // …and the version below that, where the in-process stripper does not exist
    // either. Deleting the two APIs is a truer simulation than trusting a version
    // comparison, because it is the capability the code actually branches on.
    const NO_HOOKS = `
      const m = await import("node:module");
      delete m.default.registerHooks;
      delete m.default.stripTypeScriptTypes;
      const { loadShippedTemplates } = await import("./scripts/lib/shipped-templates.mjs");
      try { await loadShippedTemplates(); process.stdout.write("UNEXPECTEDLY OK"); }
      catch (e) { process.stdout.write(e.code + "|" + e.message); }
    `;
    const old = node(["--no-experimental-strip-types"], NO_HOOKS).say;
    ok(old.startsWith("ERR_NODE_CANNOT_STRIP_TYPES|"), "…and below that it fails with a diagnosis, not a guess");
    // The message that shipped asserted the file used an enum. Naming the flag is
    // what makes this one actionable on a pinned Node.
    ok(old.includes("--experimental-strip-types"), "…naming the flag that works from " + STRIP_FLAG_FROM);
    // Anchored on the remedy CLAUSE, not on the version anywhere in the string:
    // 22.18.0 is already named earlier in the same sentence, so a bare
    // `includes` stays green with the upgrade advice deleted.
    ok(old.includes(`upgrade to Node ${STRIP_DEFAULT_FROM}`), `…and the upgrade that needs no flag (${STRIP_DEFAULT_FROM})`);
    ok(!/enum|namespace|parameter propert/i.test(old), "…and not blaming a TypeScript feature for a Node version");

    // A fault in the FILE must never be re-labelled as a fault in the Node.
    // Probing first removes that failure mode structurally — there is no longer
    // a catch around the caller's import to widen — and this is what holds the
    // structure in place: reintroduce any try/install/retry around it and a
    // module-scope throw gets routed into the stripper, coming back on a
    // pre-22.15 Node as ERR_NODE_CANNOT_STRIP_TYPES. That is the misdiagnosis
    // class this whole change exists to remove, one layer down. Run in the hook
    // regime, since that is the only place the machinery is live.
    const FAULT = `
      const { importTs } = await import("./scripts/lib/import-ts.mjs");
      try { await importTs(${JSON.stringify(boomTs)}); process.stdout.write("UNEXPECTEDLY OK"); }
      catch (e) { process.stdout.write((e.code || "no-code") + "|" + e.message); }
    `;
    const fault = node(["--no-experimental-strip-types"], FAULT).say;
    ok(fault.includes("boom from module scope"), `a fault in the file keeps its own message (${fault.slice(0, 70)})`);
    ok(!fault.includes("ERR_NODE_CANNOT_STRIP_TYPES"), "…and is never re-labelled as a Node too old to strip types");

    // Two mutants that SURVIVE this block on purpose, recorded so the next
    // reader does not read the silence as dead code:
    //   - deleting the `typeof registerHooks === "function"` check changes
    //     nothing, because the `stripTypeScriptTypes` probe is the real
    //     capability test and the typeof is belt-and-braces.
    //   - dropping the hook's pathname `.ts` guard also passes, because
    //     stripping is a no-op on the plain JS in this graph. It would mangle a
    //     JSON or CommonJS import, so the guard is right and merely untested.
    //     `u.pathname` rather than `url` is likewise untested here — nothing in
    //     this repo imports a .ts with a query — and is kept because the
    //     `endsWith(".ts")` version of it is what made a cache-busting retry
    //     look impossible when it was merely mis-guarded.
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  // The version facts the code acts on, asserted as values rather than as prose,
  // since a wrong number in a comment is the whole of this bug.
  ok(STRIP_FLAG_FROM === "22.6.0", "type stripping arrived as a flag in 22.6.0");
  ok(STRIP_HOOKS_FROM === "22.15.0", "module.registerHooks arrived in 22.15.0");
  ok(STRIP_DEFAULT_FROM === "22.18.0", "type stripping became default-on in 22.18.0");
  ok(!/since 22\.6 it strips/.test(read("scripts/lib/shipped-templates.mjs")), "…and the false claim is gone");

  // `engines.node` has to track the floor the code can actually reach on its
  // own. `">=22"` admitted 22.0-22.17 and the loader worked on none of them.
  ok(pkg.engines.node === `>=${STRIP_HOOKS_FROM}`, `engines.node states that floor (${pkg.engines.node})`);

  // …and something has to RUN there, which is the part that was missing. Three
  // rounds of green gates shipped a broken `npm run dev` because every job pins
  // `node-version: 22` and `.nvmrc` says `22`; both resolve to the newest 22.x,
  // so the range `engines.node` admits was tested at exactly one end. A floor
  // that no machine exercises is a comment, and the fix to this file would be
  // as unverifiable as the last one.
  const ci = read(".github/workflows/ci.yml");
  const floorPin = new RegExp(`node-version:\\s*["']?${STRIP_HOOKS_FROM.replace(/\./g, "\\.")}["']?\\s*$`, "m");
  ok(floorPin.test(ci), `a CI job pins engines.node's floor exactly (${STRIP_HOOKS_FROM})`);
  // Pinned AND used: a job that installs the floor and then runs nothing on it
  // would satisfy the line above while testing the same nothing as before.
  const floorJob = ci.slice(ci.indexOf("  toolchain-floor:")).split(/\n {2}\w[\w-]*:/)[0];
  ok(/loadShippedTemplates/.test(floorJob), "…and imports the studio templates there, which is what broke");
  // Anchored to the end of the line, because `run-spikes.mjs --offline` is also
  // the prefix of `run-spikes.mjs --offline <filter>`. Narrowing the job to a
  // subset to save a minute would leave the rest of the tier running only on the
  // newest Node again — the same shape as the gap this job closes, and a looser
  // check reads as green while it happens.
  ok(
    /^\s*- run: node scripts\/run-spikes\.mjs --offline\s*$/m.test(floorJob),
    "…then runs the WHOLE offline tier there, unfiltered, like the latest-Node gate",
  );
  // The pin is a duplicate of `engines.node` by necessity — setup-node takes a
  // version, not a range — so the only thing keeping them together is this.
  ok(
    !/node-version:\s*["']?22\.(?!15\.0)/.test(ci),
    "…and no job pins some OTHER 22.x point release, which would test neither end",
  );

  // Which failure it is decides what the caller says. One asserted cause for
  // every failure is what put "enums/namespaces/parameter properties" in front
  // of someone whose Node simply could not read the file.
  const loader = read("scripts/lib/shipped-templates.mjs");
  ok(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/.test(loader), "the refused-TS-feature diagnosis is keyed on its own error code");
  ok(/ERR_NODE_CANNOT_STRIP_TYPES/.test(loader), "…and the version diagnosis passes through unwrapped");
}

// ---------------------------------------------------------------------------
console.log("\n== the producers write what the kernel worker reads ==");
// ---------------------------------------------------------------------------
{
  // The consumer's side of each contract, taken from the constant the fetch
  // actually uses rather than from a copy of the string kept here.
  const consumed = Object.fromEntries(
    [...worker.matchAll(/^const (DEPCACHE_MANIFEST|TEMPLATE_LOCK_MANIFEST) = "([^"]+)";$/gm)].map((m) => [m[1], m[2]]),
  );
  ok(consumed.DEPCACHE_MANIFEST === "vendor/depcache/index.json", `kernel fetches ${consumed.DEPCACHE_MANIFEST}`);
  ok(consumed.TEMPLATE_LOCK_MANIFEST === "vendor/locks/index.json", `kernel fetches ${consumed.TEMPLATE_LOCK_MANIFEST}`);

  // The producers' side. `vendorUrl` resolves a name against the app base, and
  // the vendor tree is served out of packages/studio/public/vendor — so the
  // producer's output path is the consumer's name with that prefix.
  const produced = {
    "scripts/gen-depcache.mjs": consumed.DEPCACHE_MANIFEST,
    "scripts/gen-template-locks.mjs": consumed.TEMPLATE_LOCK_MANIFEST,
  };
  for (const [script, name] of Object.entries(produced)) {
    const src = read(script);
    const want = `packages/studio/public/${name.replace(/\/index\.json$/, "")}`;
    ok(src.includes(want), `${path.basename(script)} writes into ${want}`);
    // And the asset paths it records must be base-relative, because vendorUrl
    // prefixes them with the app base. An origin-absolute "/vendor/…" resolves
    // off the studio's base and 404s — which, on a Pages SPA, is a 200 of HTML.
    ok(!/["'`]\/vendor\//.test(src), "…and records no origin-absolute asset path");
    ok(new RegExp(`\`${name.replace(/index\\.json$/, "")}`).test(src) || src.includes(`\`${name.split("/index.json")[0]}/`),
      `…and builds its asset paths under ${name.split("/index.json")[0]}/`);
  }
  // Locks before snapshots: a snapshot's key is the hash of the resolved lock,
  // so building them the other way round produces keys for a lock that does not
  // exist yet and the manifest silently comes out empty.
  ok(
    build.indexOf("npm run vendor:locks") > 0 &&
      build.indexOf("npm run vendor:locks") < build.indexOf("npm run vendor:depcache"),
    "the deploy resolves locks before it builds snapshots",
  );
}

// ---------------------------------------------------------------------------
console.log("\n== an unreadable manifest is loud; an uncovered template is not ==");
// ---------------------------------------------------------------------------
// The swallowed `JSON.parse` in the manifest loaders is how the shipped-snapshot
// feature ran for months with no producer, and then how `predev` not running the
// producers went unnoticed until a user spent an afternoon on it. Both are build
// defects and both were invisible.
//
// The other half is what must STAY quiet. Coverage is one template, so 52 of 53
// eligible templates legitimately have no entry — warning there would train
// everyone to scroll past the warning, which costs more than the silence.
{
  // Fired from the LOADERS (manifest unreadable), never from the lookups.
  for (const [loader, script, produces] of [
    ["function loadDepCacheManifest", "npm run vendor:depcache", "snapshots"],
    ["function loadTemplateLockManifest", "npm run vendor:locks", "lockfiles"],
  ]) {
    const at = worker.indexOf(loader);
    const src = worker.slice(at, worker.indexOf("\n}\n", at));
    const name = loader.replace("function ", "");
    ok(at > 0 && /reportAbsentManifest\(\{/.test(src), `${name} reports when it cannot read the manifest`);
    ok(src.includes(script), `…naming \`${script}\``);
    // An `r.ok` check that short-circuits the parse would miss the case that
    // actually happens in production: an SPA fallback answering 200 with HTML.
    ok(/throw new Error\(`HTTP /.test(src), "…and a non-OK response goes through the same path as a bad parse");
    // The status has to survive into the report or every shape looks alike.
    ok(/let status = 0;[\s\S]*status = r\.status;/.test(src), "…and it computes the status it actually got");

    // …and then HANDS IT OVER, which is a separate claim and the one the whole
    // four-shape design rests on. `status: 0` at a call site type-checks, keeps
    // every assertion above green, and quietly routes that manifest's
    // 200-that-will-not-parse — the defect this exists to keep loud — onto the
    // transient arm. Nothing else here looks at a call site, so this is also
    // what stops the two manifests swapping nouns in their 404 line.
    const opens = src.indexOf("reportAbsentManifest({");
    const arg = opens < 0 ? "" : src.slice(opens, src.indexOf("});", opens));
    ok(/[\s{]status,/.test(arg) || /[\s{]status: status,/.test(arg), "…and passes that variable on, not a literal");
    ok(arg.includes(`produces: "${produces}"`), `…describing what is absent as ${produces}`);
  }

  const lookup = worker.slice(worker.indexOf("async function tryFetchShippedSnapshot"));
  const untilReturn = lookup.slice(0, lookup.indexOf("depCacheAssetTried.add(key)"));
  ok(/if \(!entry \|\| !entry\.asset\) return false;/.test(untilReturn), "a template with no entry returns quietly");
  ok(!/reportAbsentManifest|console\.warn/.test(untilReturn), "…and says nothing, because that is the normal case");

  // Run the reporter, one call per condition, rather than grepping for a string
  // that proves nothing about which branch produces it. It is a pure function of
  // its argument, so lifting it out of the worker and stubbing `post` is enough;
  // the annotation strip is the only concession to it being TypeScript, and a
  // signature change makes the assertion below fail rather than pass quietly.
  const decl = "function reportAbsentManifest(m: {";
  const from = worker.indexOf(decl);
  const src = from < 0 ? "" : worker.slice(from, worker.indexOf("\n}\n", from) + 2);
  const js = src.replace(/^function reportAbsentManifest\(m: \{[\s\S]*?\n\}\) \{/, "function reportAbsentManifest(m) {");
  ok(from >= 0 && js.startsWith("function reportAbsentManifest(m) {"), "the reporter can be lifted out and run");

  const posted = [];
  const consoled = [];
  let report = null;
  try {
    report = new Function(
      "post", "errMsg", "console",
      `${js}\nreturn reportAbsentManifest;`,
    )((_k, m) => posted.push(m), (e) => (e && e.message) || String(e), { warn: (l) => consoled.push(l) });
  } catch (err) {
    // A gate that stack-traces says less than one that fails, so the shape
    // assertions below degrade to a single legible failure.
    ok(false, `the reporter could not be lifted (${err.message})`);
  }

  const call = (status, err) => {
    posted.length = 0;
    consoled.length = 0;
    if (!report) return { line: "" };
    try {
      report({ tag: "depcache", manifest: "vendor/depcache/index.json", fix: "npm run vendor:depcache", produces: "snapshots", status, err });
    } catch (e) {
      // Construction succeeding does not mean invocation will: a body that grew
      // a reference to a module binding outside the injected three throws here,
      // not above. Degrade the same way rather than stack-tracing.
      ok(false, `the reporter threw on status ${status} (${e.message})`);
      return { line: "" };
    }
    return posted[0] || { line: "" };
  };

  // 200 that will not parse: the producer never ran and a Pages SPA answered
  // with index.html. The one shape that is a build defect, so the one shape
  // that gets red, the console, and a command.
  {
    const m = call(200, new SyntaxError("Unexpected token '<'"));
    ok(m.stream === "stderr", "a 200 that will not parse is red in the terminal");
    ok(consoled.length === 1, "…and reaches the console too, for the create path");
    ok(m.line.includes("npm run vendor:depcache"), "…and names the command that fixes it");
    ok(m.line.includes("Unexpected token '<'"), "…and quotes what actually failed");
  }
  // 404: legitimately absent. KERNEL_ASSETS calls both manifests optional, and
  // an embedder hosting @vivari/core has no vendor tree and no such command.
  {
    const m = call(404, new Error("HTTP 404"));
    ok(m.dim === true && m.stream !== "stderr", "a 404 is dim, not red");
    ok(consoled.length === 0, "…and stays out of the console");
    ok(!m.line.includes("npm run"), "…and prescribes nothing, since absent is a supported state");
    ok(m.line.includes("not served"), "…and says only that: not served");
  }
  // 5xx: transient. Neither the cause nor the remedy of the defect applies.
  {
    const m = call(503, new Error("HTTP 503"));
    ok(m.dim === true && consoled.length === 0, "a 503 is dim and silent on the console");
    ok(m.line.includes("HTTP 503"), "…and reports the status it got");
    ok(!m.line.includes("npm run") && !m.line.includes("assembled without"), "…claiming neither a cause nor a fix");
  }
  // The locks path's own rejection: the manifest is fine, the link is slow.
  // Status stays 0 because no response ever arrived.
  {
    const m = call(0, new Error("lock budget exhausted"));
    ok(m.dim === true && consoled.length === 0, "a budget rejection is dim and silent on the console");
    ok(m.line.includes("lock budget exhausted"), "…and quotes the reason");
    ok(!m.line.includes("npm run") && !m.line.includes("assembled without"), "…claiming neither a cause nor a fix");
  }

  // One level down: a lock the manifest PROMISED and could not deliver. The
  // producer's merge only carries an entry forward when its file exists, so
  // this pair cannot happen by design — and it used to cost 10.8 s instead of
  // 3.6 s in silence, on the one template with a snapshot.
  const lock = worker.slice(worker.indexOf("async function fetchTemplateLock"));
  const lockBody = lock.slice(0, lock.indexOf("\n}\n") + 2);
  ok(!/\} catch \{\s*return null;/.test(lockBody), "a listed lock that fails is no longer swallowed");
  ok(/if \(!r\.ok\) throw new Error\(`HTTP /.test(lockBody), "…a non-OK asset response reaches the report");
  ok(/lockfileVersion\) throw new Error\("not a lockfile"\)/.test(lockBody), "…so does SPA HTML that is not a lockfile");
  ok(/if \(asset\) post\("log"/.test(lockBody), "…and it reports only once the manifest listed the template");
  ok(/if \(!entry \|\| !entry\.asset\) return null;/.test(lockBody), "…so an uncovered template is still silent");
  ok(/dim: true/.test(lockBody), "…dim, because the budget rejection lands in the same catch");
}

// ---------------------------------------------------------------------------
console.log("\n== nothing heavy is awaited between `kernel-online` and `ready` ==");
// ---------------------------------------------------------------------------
{
  const from = worker.indexOf('post("kernel-online"');
  const to = worker.indexOf('post("ready"');
  ok(from > 0 && to > from, "the boot window is identifiable");
  const window = worker.slice(from, to);
  // The kernel is already answering filesystem RPCs at `kernel-online`, so this
  // window is pure added latency before the studio is usable.
  for (const loader of ["ensureRealNpm", "ensureRealYarn", "ensureRealPnpm", "ensureRealCorepack", "ensureRealTsgo"]) {
    ok(!window.includes(loader), `${loader} is not called on the boot path`);
  }
  ok(!/await fetch\(/.test(window), "no vendor asset is fetched there either");
  // …and npm is genuinely registered, rather than merely removed from boot.
  ok(
    /lazyTool\(\[("npm"|'npm')[^\]]*\]/.test(worker),
    "npm is registered as an on-demand program",
  );
  ok(/lazyTool\(\[[^\]]*"npx"/.test(worker), "…and so is npx, which shells out to it");
}

// ---------------------------------------------------------------------------
console.log("\n== the install shell's npm config ==");
// ---------------------------------------------------------------------------
{
  const env = worker.slice(worker.indexOf("function baseProcEnv"), worker.indexOf("// ── Generic process spawn"));
  ok(env.length > 100, "baseProcEnv is identifiable");
  ok(/npm_config_prefer_offline:\s*"true"/.test(env), "prefer-offline is on (141 revalidation round-trips → 0)");
  ok(/npm_config_audit:\s*"false"/.test(env), "audit is still off (its endpoint has no CORS headers)");
  ok(/npm_config_fund:\s*"false"/.test(env), "fund is still off");
}

// ---------------------------------------------------------------------------
console.log("\n== the lock generator still selects the templates that need one ==");
// ---------------------------------------------------------------------------
{
  const templates = await loadShippedTemplates();
  const eligible = templates.filter((t) => eligibility(t) === null).map((t) => t.manifest.id);
  ok(eligible.length > 10, `${eligible.length} of ${templates.length} templates get a resolved lockfile`);

  // The two the measurements are about. react-ts is the "even a plain React TS
  // project feels slow" report: 100 packages, MORE than next-ts, and 143.0 MiB
  // of packument metadata against 12.6 MiB of tarballs.
  for (const id of ["react-ts", "next-ts"]) {
    const t = templates.find((x) => x.manifest.id === id);
    ok(!!t && eligibility(t) === null, `${id} is eligible${t ? "" : " (template missing!)"}`);
  }
  // The Bun tab is eligible, and used not to be, on the reasoning that its deps
  // are type-only so there is nothing to win. Measured in the VM, `bun install`
  // for bun-react is 17 requests / 20.21 MiB without a lock and 9 / 3.70 MiB
  // with one — the `@types/bun` packument, which the guess did not price. It
  // works at all because Bun cannot install in-browser and the shim delegates
  // to the real npm CLI.
  const bun = templates.filter((t) => t.manifest.category === "Bun");
  ok(bun.length > 0 && bun.every((t) => eligibility(t) === null), `the ${bun.length} Bun templates are eligible (bun install delegates to npm)`);

  // And the ones a lockfile cannot help, so a rule that started matching
  // everything would be caught as fast as one that matched nothing.
  const python = templates.filter((t) => t.manifest.language === "Python");
  ok(
    python.length === 0 || python.every((t) => eligibility(t) !== null),
    `the ${python.length} Python templates are excluded (no package.json)`,
  );
  // A yarn/pnpm template would get a package-lock.json npm resolved and yarn
  // would never read — worse than nothing, because the dep-cache key would then
  // be derived from a lockfile the install does not use. Bun is the exception
  // and only because its install IS npm's.
  for (const t of templates) {
    const pm = String(t.manifest.install || "npm").trim().split(/\s+/)[0];
    if (pm !== "npm" && pm !== "bun" && pm !== "") {
      ok(eligibility(t) !== null, `${t.manifest.id} installs with ${pm}, so it is excluded`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log("\n== a template's lockfile is written before the project is released ==");
// ---------------------------------------------------------------------------
{
  const create = worker.slice(worker.indexOf('m.type === "vv-create-project"'));
  const body = create.slice(0, create.indexOf('m.type === "vv-register-project"'));
  const fetched = body.indexOf("fetchTemplateLock");
  const written = body.indexOf("writeFilesBatch");
  // The SUCCESS reply. The `kernel not ready` guard replies first and is not the
  // one that releases a created project.
  const replied = body.indexOf('post("vv-reply", { reqId: m.reqId, ok: true })');
  ok(fetched > 0, "vv-create-project consults the lock manifest");
  ok(fetched < written, "…before the batch write, so the lock is part of it");
  ok(written < replied, "…and the reply that releases the studio to run comes after");
  ok(/!files\["package-lock\.json"\]/.test(body), "a template that ships its own lockfile is left alone");
  ok(/files\["package\.json"\]/.test(body), "a project with no package.json asks for nothing");
  // A hung asset host must not be able to wedge project creation — and the
  // budget has to be for the whole acquisition. Acquiring a lock is two fetches,
  // so a per-request timeout silently costs twice what it says: the ordering
  // above is what puts both of them in front of the user's Create button.
  ok(/TEMPLATE_LOCK_BUDGET_MS/.test(worker) && /AbortController/.test(worker), "the fetch is bounded");
  ok(!/fetchWithTimeout/.test(worker), "…by a deadline, not a per-request timeout");
  const budget = worker.match(/const TEMPLATE_LOCK_BUDGET_MS = (\d+)/);
  ok(!!budget && Number(budget[1]) <= 10000, `…of ${budget ? budget[1] : "?"}ms for the whole acquisition`);
  const deadlines = [...worker.matchAll(/fetchByDeadline\(/g)].length;
  ok(deadlines >= 2, `…shared by all ${deadlines} lock fetches`);
  ok(
    /const deadline = Date\.now\(\) \+ TEMPLATE_LOCK_BUDGET_MS/.test(worker),
    "…taken once per create, not once per request",
  );
}

// ---------------------------------------------------------------------------
console.log("\n== a producer that cannot produce must not fail the deploy ==");
// ---------------------------------------------------------------------------
// The whole point of these two scripts is an optimisation. `cloudflare-build.sh`
// runs under `set -euo pipefail`, so a non-zero exit from either does not turn
// the optimisation off — it cancels the deploy of the landing page, the docs,
// the blog and the studio. And the triggers are ordinary: a registry flake
// during a 60 MB install, or a transitive package gaining an install script,
// which gen-depcache is deliberately written to REFUSE. Exiting non-zero for
// choosing correctly would be the worst possible reading of its own contract.
{
  for (const [script, run] of [
    ["scripts/gen-depcache.mjs", "vendor:depcache"],
    ["scripts/gen-template-locks.mjs", "vendor:locks"],
  ]) {
    const src = read(script);
    const name = path.basename(script);
    // Named failure modes, one at a time — NOT "every non-zero exit is safe",
    // which is a claim this cannot make: `process.exit(2)` for an unknown
    // template id is deliberate and correct, and a regex cannot tell a new
    // deliberate one from a new mistake. What is covered is the three ways this
    // contract has actually been broken or could break silently.
    //
    // 1. The one exit that is allowed to be a build failure is behind `strict`.
    ok(/^.*\bstrict &&.*process\.exit\(1\).*$/m.test(src), `${name} exits 1 only under --strict`);
    // 2. The produced-nothing path warns instead of exiting.
    const emptyGuard = src.match(/if \(!wrote\) \{[\s\S]*?\n\}/);
    ok(!!emptyGuard, `${name} still notices that it produced nothing`);
    ok(!!emptyGuard && !/process\.exit/.test(emptyGuard[0]), "…and warns rather than exiting");
    ok(!!emptyGuard && /WARNING/.test(emptyGuard[0]), "…loudly");
    // 3. An UNEXPECTED throw — the case neither script enumerated — is caught
    //    too, or the contract only holds for the failures somebody thought of.
    ok(/installFailSoftHandler\(["']/.test(src), `${name} fails soft on an unexpected throw as well`);
    // And the deploy must invoke it in the fail-soft mode.
    const call = build.match(new RegExp(`npm run ${run}[^\\n]*`));
    ok(!!call, `the deploy runs ${run}`);
    ok(!!call && !/--strict/.test(call[0]), `…without --strict, so it cannot cancel the deploy`);
  }
  // The index is MERGED so a run naming one id keeps the others. That makes a
  // rebuilt asset reachable under the key of the lock it no longer contains
  // unless the old keys go — and a stale hit is worse than a miss, because a
  // restore hit means npm never runs to notice the tree and the lock disagree.
  ok(
    /entry\.template === id\) delete index\[key\]/.test(read("scripts/gen-depcache.mjs")),
    "a rebuilt snapshot drops the keys of the lock it replaced",
  );

  // …and the other half of the same rule, which was missing and cost react-ts
  // its snapshot. That assertion covers the REBUILD; this one covers the REUSE,
  // where `public/vendor/` survives from an earlier build and gen-depcache
  // decides it has nothing to do. The browser finds a snapshot by hashing the
  // project's LOCK, so once the lock's bytes move — a newer transitive version,
  // or the aliased second pass, which rewrote 27 locks at once — an asset
  // indexed under the old key is unreachable. Nothing about that is visible:
  // the asset is still there, the manifest still lists it, `vendor:depcache`
  // still prints "reused" and exits 0, and every user quietly pays a cold
  // install instead of a 3.6 s restore.
  //
  // Exercised rather than read, because "the source mentions hashDepKey" is
  // what a regex can see and it is not the property that matters.
  {
    const enc = new TextEncoder();
    const t = (await loadShippedTemplates()).find((x) => x.manifest.id === "react-ts");
    const pj = t.files["package.json"];
    // The lock is SUPPLIED, not read, so every case below holds on a tree with
    // no `vendor/` in it. Reading it here and letting `unreachable` re-read it
    // for itself is what made six of these vacuous in CI: on a clean checkout
    // it found no file and returned "no shipped lock to key it against" long
    // before the behaviour each one names. Fixed bytes rather than the shipped
    // ones, so what is proved is identical on both trees.
    const lockText = JSON.stringify({ name: "react-ts", lockfileVersion: 3, packages: { "": {} } });
    const asset = "vendor/depcache/react-ts.bin";
    const lockKey = await hashDepKey("npm", enc.encode(lockText), "package-lock.json");
    const pjKey = await hashDepKey("npm", enc.encode(pj), "package.json");
    const indexFor = (keys, bytes) => Object.fromEntries(keys.map((k) => [k, { asset, template: "react-ts", bytes }]));

    // The asset is supplied for the same reason the lock is. Both are `vendor/`
    // build output, and a fixture that borrows either from the tree only proves
    // anything on a tree that has them.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-snapshot-"));
    const at = path.join(dir, "react-ts.bin");
    const body = writeSnapshotContainer("gz", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { id: "react-ts" });
    const why = (index, extra = {}) => unreachable("react-ts", pj, index, { lockText, out: at, ...extra });
    const sized = (n) => indexFor([lockKey, pjKey], n);
    try {
      fs.writeFileSync(at, body);
      // Unconditional. This ran under `if (fs.existsSync(lockPath))`, which is
      // false exactly in CI — an assertion that only exists where it cannot fail.
      ok(
        (await why(indexFor([lockKey, pjKey]))) === null,
        "a snapshot indexed under that lock's own hash is reused",
      );
      // The regression itself: the lock moved on, the index did not.
      const stale = indexFor([await hashDepKey("npm", enc.encode(lockText + " "), "package-lock.json"), pjKey]);
      ok(
        /does not carry/.test((await why(stale)) || ""),
        "…and one whose lock key the index no longer carries is repacked, not reused",
      );
      // The package.json key is the fallback for a project whose lock never
      // arrived, so losing it is the same silent miss one level down. Pinned to
      // the reason rather than to truthiness: as `!!…` it passed on a clean tree
      // off the back of "no shipped lock to key it against", which is a
      // different rule failing, and read as if this one held.
      ok(
        /does not carry/.test((await why(indexFor([lockKey]))) || ""),
        "…as is one that has lost its package.json fallback key",
      );
      // Keys are only half of it. They decide whether anything LOOKS the
      // snapshot up; they say nothing about whether what it finds is a
      // snapshot, and "the file is there" is the assumption that has now been
      // wrong twice here. Both of these were reused silently until the asset
      // itself was checked, and both are reachable because `public/vendor/` is
      // build output that outlives whatever happened to it last: a run killed
      // mid-write (`predev`, so Ctrl-C on `npm run dev` does it), or an error
      // page saved in place of an asset — the shape that turned this feature
      // off in production once already.
      fs.writeFileSync(at, body.subarray(0, 6));
      const cut = await why(sized(body.length));
      ok(/where the index promises/.test(cut || ""), "…a TRUNCATED one is repacked, on the length the index already records");
      fs.writeFileSync(at, Buffer.alloc(body.length, "<!doctype html>"));
      ok(
        /not a snapshot container/.test((await why(sized(body.length))) || ""),
        "…and an error page of exactly the right length is repacked too",
      );
      fs.writeFileSync(at, body);
      ok((await why(sized(body.length))) === null, "a container of the promised length is reused");
      fs.rmSync(at);
      ok(
        /no asset on disk/.test((await why(sized(body.length))) || ""),
        "…and a missing asset is a reason rather than a crash, since a clean checkout has none",
      );

      // Right keys, wrong asset: reachable, but pointing at another template's bytes.
      const crossed = indexFor([lockKey, pjKey]);
      for (const k of Object.keys(crossed)) crossed[k].asset = "vendor/depcache/next-ts.bin";
      ok(
        /points that key at/.test((await why(crossed)) || ""),
        "…as is one whose keys point at a different template's asset",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // The defaults are `main`'s, and they must stay the path production takes —
    // an injectable that quietly became mandatory would gate code nothing runs.
    ok(
      (await unreachable("no-such-template-xyz", pj, indexFor([lockKey, pjKey]))) ===
        "no shipped lock to key it against",
      "…and with nothing injected it reads the shipped lock itself, which is what `main` calls",
    );
  }

  // Failing soft has to mean NO manifest, not an empty one — and this is the
  // only part of the contract with a runtime consequence rather than a build-log
  // one, so it is exercised rather than read. `checkKernelAssets` decides an
  // asset is present by testing for a non-empty FILE, and `{}\n` is three bytes:
  // a producer that failed honestly would be counted present and the deploy's
  // loudest check would print `✓ … asset paths present` over a manifest that
  // turns the largest install optimisation off for every visitor.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vv-manifest-"));
  try {
    const p = path.join(tmp, "index.json");
    // assemble-site's real probe, over a dist where the depcache manifest is the
    // file under test and everything else is stubbed present.
    const under = "vendor/depcache/index.json";
    const report = () =>
      checkKernelAssets("", (rel) => (rel.endsWith(under) ? fs.existsSync(p) && fs.statSync(p).size > 0 : true));

    ok(writeOptionalManifest(p, { k: { asset: "vendor/depcache/react-ts.bin" } }), "a manifest with entries is written");
    ok(report().absentOptional.length === 0, "…and the asset check counts it present");

    ok(!writeOptionalManifest(p, {}), "an empty manifest is not written");
    ok(!fs.existsSync(p), "…and a stale one is removed rather than left saying `{}`");
    const absent = report().absentOptional;
    ok(
      absent.some((r) => r.endsWith(under)),
      `…so assemble-site prints \`○ optional asset not produced\` (${absent.length} absent)`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
console.log("\n== a shipped lockfile has been installed in the VM at least once ==");
// ---------------------------------------------------------------------------
// A lock is resolved on a linux-x64 build host and reified in a wasm32 VM. When
// that goes wrong the template does not get slower, it BREAKS — and it breaks
// for every user at once, on the deploy that introduced it. So eligibility (53
// templates, a derived rule) is deliberately NOT the shipped set: an id ships
// only once a `--net` spike installs that template from this generated lock and
// boots it. `runViteSpike` writes the lock in so that gate means what it says.
{
  const templates = await loadShippedTemplates();
  const byId = new Map(templates.map((t) => [t.manifest.id, t]));
  const spikes = read("scripts/run-spikes.mjs");
  const viteLib = read("scripts/spike-vite-lib.mjs");

  ok(COVERAGE.length > 0, `${COVERAGE.length} template(s) ship a lockfile`);
  ok(
    COVERAGE.every((id) => byId.has(id) && eligibility(byId.get(id)) === null),
    "every covered template is also eligible",
  );

  // The gate itself. This used to demand a bespoke `--net` spike per covered id,
  // which was the right rule while COVERAGE was one template and an unpayable
  // one at forty: fifty near-identical files, each with its own timeout and its
  // own way of being subtly wrong. spike-template-locks.mjs is that gate, driven
  // once over the whole list.
  //
  // Which makes "does it gate id X" the wrong question — it iterates COVERAGE,
  // so the answer is yes by construction. The questions worth asserting are
  // whether it still DERIVES its list from COVERAGE (a literal list inside it
  // could drift silently), whether it installs the SHIPPED bytes from the
  // SHIPPED lock, and whether a missing lock fails rather than quietly
  // installing from ranges and proving nothing.
  const CORPUS = "spike-template-locks.mjs";
  const corpus = read(`scripts/${CORPUS}`);
  ok(
    /import \{[^}]*COVERAGE[^}]*\} from "\.\/gen-template-locks\.mjs"/.test(corpus),
    `${CORPUS} drives the shipped list itself, rather than keeping a second copy of it`,
  );
  ok(/return COVERAGE\.slice\(\)/.test(corpus), "…and gates all of it by default, not a subset it chose");
  ok(corpus.includes("loadShippedTemplates"), "…installing the SHIPPED template bytes, not a hand-copy");
  ok(
    /vendor\/locks\/\$\{id\}\.json|`\$\{id\}\.json`/.test(corpus) && /writeFile\(`\$\{dir\}\/package-lock\.json`/.test(corpus),
    "…from the generated lock, written into the VM before the install",
  );
  ok(
    /no generated lock/.test(corpus) && /continue;/.test(corpus),
    "…and a missing lock FAILS it, since installing from ranges would be green and prove nothing",
  );
  ok(
    new RegExp(`file: "${CORPUS}"[^}]*net: true`).test(spikes),
    `…and ${CORPUS} is registered as a net spike, so CI runs it`,
  );

  // The generator's alias handling reads the kernel's own table. A copy here
  // would let a fifth native package be added to the kernel and silently start
  // being pinned into a shipped lock under a name nothing substitutes.
  const gen = read("scripts/gen-template-locks.mjs");
  ok(
    /from "\.\.\/packages\/runtime\/toolchain-shims\.js"/.test(gen),
    "the generator reads the kernel's native→wasm alias table rather than a copy",
  );

  // THE GUARD. A lock that names esbuild or lightningcss gets the REAL package,
  // because a pinned tarball URL never reaches the packument alias that
  // substitutes the wasm drop-in. The previous guard keyed on `hasInstallScript`
  // and shipped `tailwind` anyway: that flag decides whether the breakage is
  // loud at install (esbuild exits 1) or silent until import (lightningcss
  // throws `Cannot find module '../lightningcss.linux-wasm32-gnu.node'`), never
  // whether there is any. All four alias-table members have zero wasm32-capable
  // optional deps. So the boundary is now "is this entry the drop-in", and these
  // cases are it — a guard that cannot fail is why the old one shipped.
  // `resolved` defaults to the tarball of whatever the entry claims to BE, which
  // is the only pairing npm ever writes. Cases below that want the two to
  // disagree say so explicitly, because that disagreement is a lock shape no
  // resolve produces and every guard has to survive anyway.
  const tarball = (n, v = "1.0.0") => `https://registry.npmjs.org/${n}/-/${n.split("/").pop()}-${v}.tgz`;
  const lockWith = (name, extra = {}) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {},
        [`node_modules/${name}`]: { version: "1.0.0", resolved: tarball(extra.name || name), ...extra },
      },
    });
  const refusal = (text) => {
    try {
      assertNoAliasedNatives(text);
      return null;
    } catch (e) {
      return e;
    }
  };

  const silent = refusal(lockWith("lightningcss"));
  ok(!!silent, "a lock pinning the REAL lightningcss is refused — the class that shipped tailwind broken");
  ok(!!silent && silent.code === "ERR_LOCK_PINS_ALIASED_NATIVE", "…under the code the generator routes on");
  ok(
    !!refusal(lockWith("esbuild", { hasInstallScript: true })),
    "…and so is the real esbuild, whose install script only makes the same defect louder",
  );
  ok(
    !!refusal(lockWith("lightningcss", { hasInstallScript: false })),
    "…with hasInstallScript explicitly false still refused, since it was never the discriminator",
  );
  ok(
    !refusal(lockWith("lightningcss", { name: "lightningcss-wasm" })),
    "an entry ALIASED to the kernel's registered drop-in is the fix, and is accepted",
  );
  ok(
    !refusal(lockWith("esbuild", { name: "esbuild-wasm", hasInstallScript: true })),
    "…judged on the alias and not on the flag, which the drop-in may also carry",
  );
  ok(
    !!refusal(lockWith("lightningcss", { name: "lightningcss-wasm-fork" })),
    "…but aliased to anything OTHER than the registered drop-in is unreviewed, and refused",
  );
  ok(!refusal(lockWith("react")), "a lock pinning nothing from the alias table is accepted");
  ok(
    !!refusal(JSON.stringify({ packages: { "": {}, "node_modules/vite/node_modules/esbuild": { version: "1.0.0" } } })),
    "…and the check reaches NESTED positions, which is where most natives are pinned",
  );

  // `name` is a claim about the entry; `resolved` is the URL that decides which
  // bytes land. Judging the entry on the claim alone accepts a lock labelled
  // esbuild-wasm that downloads esbuild — the defect wearing the fix as a
  // costume, and the one shape that reproduces the tailwind failure while
  // passing a name-only check. npm writes the pair together, so this can only
  // arrive on the reuse path, where `unshippable` re-reads a file on disk whose
  // generation is unknown. That is the path this guard is last on.
  const mislabelled = refusal(
    lockWith("esbuild", { name: "esbuild-wasm", resolved: tarball("esbuild") }),
  );
  ok(!!mislabelled, "an entry LABELLED the drop-in whose tarball is the native's is refused");
  ok(
    !!mislabelled && /labelled esbuild-wasm, resolved from esbuild/.test(mislabelled.message),
    "…naming both halves, since the label is the part that looks correct",
  );
  ok(
    !!refusal(lockWith("lightningcss", { name: "lightningcss-wasm", resolved: tarball("left-pad") })),
    "…and so is one whose tarball is some third package entirely",
  );
  ok(
    !!refusal(lockWith("lightningcss", { name: "lightningcss-wasm", resolved: undefined })),
    "…and one that claims the alias while naming no tarball at all",
  );
  ok(
    !refusal(lockWith("rollup", { name: "@rollup/wasm-node", resolved: tarball("@rollup/wasm-node", "4.62.4") })),
    "…while a SCOPED drop-in's own tarball is read correctly and accepted",
  );

  // THE SUBSTITUTION. `aliasOverrides` is what turns a refused tree into a
  // shippable one, per position and at the version that position resolved to —
  // moving a version would hand a dependent a package outside the range it asked
  // for, which is a different bug with the same shape.
  const nested = JSON.stringify({
    packages: {
      "": {},
      "node_modules/esbuild": { version: "0.27.7" },
      "node_modules/vite/node_modules/esbuild": { version: "0.25.12" },
      "node_modules/lightningcss": { version: "1.33.0", name: "lightningcss-wasm" },
    },
  });
  const ov = aliasOverrides(nested);
  ok(
    !!ov && ov.esbuild === "npm:esbuild-wasm@0.27.7",
    "aliasOverrides maps a top-level native to its drop-in at that position's own version",
  );
  ok(
    !!ov && !!ov.vite && ov.vite.esbuild === "npm:esbuild-wasm@0.25.12",
    "…and nests the override for a nested position, at ITS version rather than the top one's",
  );
  ok(!!ov && !("lightningcss" in ov), "…and leaves an already-aliased entry alone, so the second resolve is a no-op for it");
  ok(aliasOverrides(lockWith("react")) === null, "…returning null for a tree with no natives, which skips the second resolve");

  // …and the generator has to APPLY them and re-check. Resolving overrides and
  // then shipping the FIRST lock would be green here and broken in the VM.
  ok(
    /const overrides = aliasOverrides\(text\);/.test(gen) && /pkg\.overrides = \{ \.\.\.overrides/.test(gen),
    "resolveLock feeds those overrides back into a SECOND resolve",
  );
  ok(
    gen.lastIndexOf("assertNoAliasedNatives(text)") > gen.indexOf("const overrides = aliasOverrides(text);"),
    "…and re-runs the guard on what comes back, so a position that stayed native still fails",
  );

  // A SPLIT PEER PROVIDER, which is how eight framework gates went red without
  // any lock being wrong about a version. npm answers a peer it cannot place as
  // a singleton by installing a second copy, and the two only meet at runtime.
  // The fixture is the real tree, at the versions that shipped: the binding
  // pins alpha.3 for itself, its own napi-rs asks for a range that excludes
  // alpha.3, and npm reified 1.11.3 for napi-rs at the root.
  const peerLock = (over = {}) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/@emnapi/core": { version: "1.11.3", peer: true, ...over.reified },
        "node_modules/@napi-rs/wasm-runtime": {
          version: "1.2.3",
          peerDependencies: { "@emnapi/core": "^1.7.1 || ^2.0.0-alpha.4" },
          ...over.dep,
        },
        "node_modules/@rolldown/binding-wasm32-wasi": {
          version: "1.2.3",
          dependencies: { "@napi-rs/wasm-runtime": "~1.2.2", "@emnapi/core": "2.0.0-alpha.3" },
          ...over.consumer,
        },
        "node_modules/@rolldown/binding-wasm32-wasi/node_modules/@emnapi/core": {
          version: "2.0.0-alpha.3",
          ...over.nested,
        },
      },
    });
  const split = (text) => {
    try {
      assertPeerProviders(text);
      return null;
    } catch (e) {
      return e;
    }
  };

  const rolldown = split(peerLock());
  ok(!!rolldown, "a lock that splits a peer provider is refused — the shape that hung eight gates for 5 min each");
  ok(!!rolldown && rolldown.code === "ERR_LOCK_SPLITS_PEER_PROVIDER", "…under the code the generator routes on");
  ok(
    !!rolldown &&
      /@rolldown\/binding-wasm32-wasi@1\.2\.3 supplies @emnapi\/core@2\.0\.0-alpha\.3 to @napi-rs\/wasm-runtime@1\.2\.3, whose peer npm reified at 1\.11\.3/.test(
        rolldown.message,
      ),
    "…naming supplier, package, recipient and both versions, which the runtime error names none of",
  );
  ok(
    !split(peerLock({ nested: { version: "1.11.3" } })),
    "…accepted once both copies are the same version, which is the state upstream's 1.2.4 restored",
  );
  // The narrowing that keeps this from firing on ordinary trees. Without the
  // `peer: true` test it would refuse tslib at two majors and every wasm binding
  // that nests its own napi stack — 25 of 59 locks rather than the 18 that were
  // actually broken.
  ok(
    !split(peerLock({ reified: { peer: undefined } })),
    "a duplicate npm did NOT place for a peer is ordinary hoisting, and is accepted",
  );
  ok(
    !split(peerLock({ consumer: { dependencies: { "@napi-rs/wasm-runtime": "~1.2.2" } } })),
    "…and a package that does not itself supply the peer is not blamed for the copy it never chose",
  );
  ok(
    !!split(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": {},
          "node_modules/vite/node_modules/@emnapi/core": { version: "1.11.3", peer: true },
          "node_modules/vite/node_modules/@napi-rs/wasm-runtime": {
            version: "1.2.3",
            peerDependencies: { "@emnapi/core": "^1.7.1" },
          },
          "node_modules/vite/node_modules/b": {
            version: "1.0.0",
            dependencies: { "@napi-rs/wasm-runtime": "*", "@emnapi/core": "2.0.0-alpha.3" },
          },
          "node_modules/vite/node_modules/b/node_modules/@emnapi/core": { version: "2.0.0-alpha.3" },
        },
      }),
    ),
    "…and resolution walks OUTWARD from a nested position, which is where the real one sat",
  );

  // Both entry points, because the reuse path is the one that kept this alive
  // locally: the generator reuses an on-disk asset, so a stale broken lock went
  // on passing the corpus gate while CI, which resolves fresh, went red.
  ok(
    gen.lastIndexOf("assertPeerProviders(text)") > gen.indexOf("async function resolveLock"),
    "resolveLock runs the guard on what it resolved",
  );
  ok(
    /function unshippable[\s\S]{0,600}assertPeerProviders\(text\)/.test(gen),
    "…and `unshippable` runs it again on a file from disk, so a stale split is deleted and re-resolved",
  );
  // The deletion is the riskiest line in this change, because the manifest on
  // disk is the one being SERVED for as long as the run takes, and the run is
  // `predev` — Ctrl-C during a 60 s resolve is the expected input, not an exotic
  // one. Delete first and a kill leaves the manifest advertising a file that is
  // gone, which the runtime calls a build defect on the grounds that the merge
  // step cannot produce it. Unpublish first and the same kill leaves an orphan
  // file nothing points at, which the next run re-judges.
  ok(
    /unpublish\(INDEX, id\);\s*\n\s*fs\.rmSync\(out/.test(gen),
    "the warm path unpublishes a rejected lock BEFORE unlinking it, so a kill cannot strand a pointer",
  );
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-unpub-"));
    const idx = path.join(dir, "index.json");
    try {
      fs.writeFileSync(idx, JSON.stringify({ a: { asset: "vendor/locks/a.json", bytes: 1 }, b: { asset: "x", bytes: 2 } }));
      ok(unpublish(idx, "a") === true, "…and `unpublish` removes exactly the id it is given");
      const left = JSON.parse(fs.readFileSync(idx, "utf8"));
      ok(!left.a && !!left.b, "…leaving every other entry alone");
      ok(unpublish(idx, "nope") === false, "…is a no-op for an id that was never published");
      fs.rmSync(idx);
      ok(unpublish(idx, "a") === false, "…and for a manifest that is not there at all, rather than throwing");
      // Withdrawing the last entry has to take the manifest with it: an empty
      // object would advertise the feature as present and empty.
      fs.writeFileSync(idx, JSON.stringify({ a: { asset: "vendor/locks/a.json", bytes: 1 } }));
      unpublish(idx, "a");
      ok(!fs.existsSync(idx), "…and withdrawing the last entry removes the manifest rather than publishing an empty one");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  // Refusing must not fail the deploy: this is a property of what the registry
  // served this hour, and 40-odd healthy templates should not wait on someone
  // else's republish.
  ok(
    /ERR_LOCK_SPLITS_PEER_PROVIDER[\s\S]{0,200}refused\.push/.test(gen),
    "…and a split is skipped rather than failed, so `--strict` does not go red for an upstream publish",
  );
  // …but counted apart from the templates that were never going to have a lock.
  // A Python template with no package.json is permanently not applicable; a
  // template whose lock was refused had one yesterday. Summed together, an
  // incident that takes out eighteen of them reads as a slightly larger number
  // next to thirteen Python projects, and this branch exists because an
  // optimisation that switches itself off quietly stays off.
  ok(
    /\$\{refused\.length\} refused/.test(gen) && /\$\{skipped\.length\} not applicable/.test(gen),
    "…and counted separately from `not applicable`, which is a permanent condition and not an incident",
  );
  ok(
    /if \(refused\.length\)[\s\S]{0,400}console\.warn/.test(gen),
    "…with a warning naming what it costs, since a refusal is correct and still a bad day",
  );
  // Fail-soft on the deploy and fatal under `--strict` are answers to different
  // questions: "can I ship the site" must stay yes, and "are the locks what we
  // promised" must not be yes while eighteen ids in COVERAGE quietly ship
  // nothing. The gate that runs `--strict` exists to report exactly that
  // condition, and it was green for it.
  //
  // It takes no one hostage, which is the objection: the guard runs on a FRESH
  // resolve, so a refusal means npm builds the split from ranges right now, and
  // the template is already broken with or without a lock — measured, identical
  // trees both ways. Same rule the aliased-native refusal already follows:
  // not shippable is tolerable, not shippable for an id we listed is not.
  ok(
    /strict && \(failed\.length \|\| promised\.length \|\| !wrote\)/.test(gen),
    "a refusal is fatal under --strict, so the job whose subject is the locks cannot be green while they are missing",
  );
  ok(
    /const promised = refused\.filter\(\(r\) => COVERAGE\.includes/.test(gen),
    "…scoped to ids in COVERAGE, so a template that never promised a lock does not redden a PR",
  );

  // The snapshot producer has to refuse it too, and for a sharper reason: a
  // restore skips npm, so a snapshot packed from a split tree delivers the two
  // copies with nothing left to re-resolve them.
  const depgen = fs.readFileSync(path.join(ROOT, "scripts/gen-depcache.mjs"), "utf8");
  ok(
    /assertPeerProviders\(lockText\)/.test(depgen),
    "gen-depcache refuses to pack a snapshot from a lock that splits a peer provider",
  );
  ok(
    /assertPeerProviders,/.test(depgen),
    "…importing the generator's guard rather than keeping a second copy of the rule",
  );

  // The harness has to RECOGNISE that failure, or the gate that catches it
  // reports a 300s timeout instead of a reason. Exercise the real pattern
  // against the real output rather than grepping for the string.
  const harness = fs.readFileSync(path.join(ROOT, "scripts/lib/spike-harness.mjs"), "utf8");
  const abortSrc = (harness.match(/const m = tail\.match\(\s*(\/[\s\S]*?\/)[a-z]*,?\s*\);/) || [])[1];
  ok(!!abortSrc, "waitListen still decides fatality with a single inspectable pattern");
  if (abortSrc) {
    const abort = new RegExp(abortSrc.slice(1, abortSrc.lastIndexOf("/")));
    ok(
      abort.test("Error: Cannot find native binding. npm has a bug related to optional dependencies"),
      "…and treats `Cannot find native binding` as fatal, which names no module path and so matched neither other arm",
    );
    ok(
      abort.test("Error: Cannot find module '/x/y.js'") && abort.test("Error: foo is not a function"),
      "…without losing the two shapes it already caught",
    );
    ok(
      !abort.test("  VITE v8.2.1  ready in 412 ms") && !abort.test("warn: optional dependency skipped"),
      "…and ordinary dev-server output does not abort the wait",
    );
  }

  // The other half — that a server which prints one of these and binds anyway
  // is still waited for — cannot be shown by a regex, so it runs a real server
  // in a real kernel. That lives in `fatal-errors`, which is `needsWasm`,
  // because booting one HERE is what a bare checkout cannot do: this spike is
  // the earliest gate and runs in the Wasm-free job, where the fs worker dies
  // on MODULE_NOT_FOUND for the VFS crate before any of the above is reached.
  // Same rule `spike-ci-tiers` enforces one gate along.
  //
  // What CAN be checked here is that the mechanism the behavioural test relies
  // on still exists. Deleting the grace turns the match back into an instant
  // verdict, which is a one-line change that no assertion about the PATTERN
  // would notice, and the `needsWasm` job that would notice runs later and not
  // on every tier.
  ok(
    /FATAL_GRACE/.test(harness) && /fatalAt/.test(harness) && !/&& !fatal\)/.test(harness),
    "…and the wait is ended by that clock rather than by the match itself",
  );

  // THE SHIPPED BYTES. Everything above is about code; this is about the
  // artifacts, and it is the check that would have caught tailwind. Locks are
  // gitignored build output, so it only runs once they have been built.
  const lockDir = path.join(ROOT, "packages/studio/public/vendor/locks");
  const built = fs.existsSync(lockDir) ? fs.readdirSync(lockDir).filter((f) => f.endsWith(".json") && f !== "index.json") : [];
  if (!built.length) {
    console.log("  – no locks built; skipping the shipped-bytes checks (run `npm run vendor:locks`)");
  } else {
    const bad = built.filter((f) => refusal(fs.readFileSync(path.join(lockDir, f), "utf8")));
    ok(!bad.length, `none of the ${built.length} built locks pins an alias-table member under its own name (${bad.join(", ") || "clean"})`);
    // Every asset on disk, not just the COVERAGE ids, because the registry loop
    // further down iterates COVERAGE and so cannot see a stale asset.
    const aliasing = built.filter((f) =>
      Object.entries(JSON.parse(fs.readFileSync(path.join(lockDir, f), "utf8")).packages || {}).some(
        ([k, e]) => e && e.name && k.split("node_modules/").pop() !== e.name,
      ),
    );
    ok(aliasing.length > 0, `…and ${aliasing.length} of them DO alias one, so the accepting cases above are exercised by real bytes`);
    const torn = built.filter((f) => split(fs.readFileSync(path.join(lockDir, f), "utf8")));
    ok(
      !torn.length,
      `none of the ${built.length} built locks splits a peer provider (${torn.join(", ") || "clean"})`,
    );
    // The guard is worth nothing if no shipped lock has a peer to split, so
    // check the corpus actually contains the construct being judged.
    const withPeers = built.filter((f) =>
      Object.values(JSON.parse(fs.readFileSync(path.join(lockDir, f), "utf8")).packages || {}).some(
        (e) => e && e.peerDependencies,
      ),
    );
    ok(
      withPeers.length > 0,
      `…and ${withPeers.length} of them declare a peer somewhere, so that check has something to judge`,
    );
  }

  // COVERAGE vs NOT_BOOTABLE. The second is the record of what could not be
  // proven; an id in both would be a claim and its own retraction.
  const both = COVERAGE.filter((id) => NOT_BOOTABLE.has(id));
  ok(!both.length, `no id is both covered and recorded as unprovable (${both.join(", ") || "disjoint"})`);
  ok(
    [...NOT_BOOTABLE].every((id) => byId.has(id) && eligibility(byId.get(id)) === null),
    "…and every id kept out that way is one that COULD have had a lock, so the note is about evidence",
  );
  ok(COVERAGE.includes("tailwind"), "tailwind ships a lock again, on the aliased resolve that made it bootable");

  // …which is only safe while something spends the time to boot it. These pin
  // the CALL and the CONSEQUENCE rather than the words: an earlier pair matched
  // the import line and the failure string, and survived both deleting the boot
  // and making its result unused.
  ok(
    /const aliased = aliasedEntries\(/.test(corpus) && /if \(aliased\.length && t\.manifest\.port\)/.test(corpus),
    `${CORPUS} decides who owes a boot by reading the lock, not from a list that can drift`,
  );
  ok(
    /require\(\$\{JSON\.stringify\(name\)\}\)/.test(corpus) && /VV_ALIAS_OK/.test(corpus),
    "…require()s each aliased package in the VM, which is the check that installing cannot make",
  );
  ok(
    /\.name;/.test(corpus) && /if \(got !== want\) fail\(/.test(corpus),
    "…and fails unless the DROP-IN is what answered, not the native the alias exists to keep out",
  );
  ok(
    /const bound = await waitListen\(h, \{ dir, port: t\.manifest\.port/.test(corpus),
    "…then starts the template's own dev command and waits on its own port",
  );
  ok(
    /else fail\(`installs, but its dev server never bound port/.test(corpus),
    "…and fails the id when that port never binds, which is what installing cannot see",
  );

  // The alias surviving the user's next npm command is what the whole design
  // rests on, and it is a property of npm's reconciliation rather than of this
  // repo — so it is the one most likely to stop being true without anything
  // here changing. It has to be re-proved by the gate rather than recorded in a
  // comment, and it has to be proved on an id that actually aliases something.
  ok(
    /SURVIVAL_ID = "([a-z-]+)"/.test(corpus) && /id === SURVIVAL_ID && aliased\.length/.test(corpus),
    "…and re-proves, on one aliasing id, that the alias survives a user's own npm command",
  );
  ok(
    /"install", SURVIVAL_ADD/.test(corpus) || /SURVIVAL_ADD, "--no-audit"/.test(corpus),
    "…by adding a dependency the way a user would, not by re-reading the lock",
  );
  ok(
    /after \\`npm install \$\{SURVIVAL_ADD\}\\`, \$\{name\} is \$\{got\} rather than \$\{want\}/.test(corpus),
    "…and failing with the position and both names when the native comes back",
  );
  ok(
    /boots from the shipped lock, but not after/.test(corpus),
    "…and booting it a second time, since a surviving alias that cannot start is still broken",
  );
  {
    // The id it names must be one whose lock actually aliases something, or the
    // check silently does nothing — the failure mode of every allowlist this
    // design deleted.
    const id = corpus.match(/SURVIVAL_ID = "([a-z-]+)"/);
    const lockPath = id && path.join(ROOT, `packages/studio/public/vendor/locks/${id[1]}.json`);
    if (lockPath && fs.existsSync(lockPath)) {
      const shims = await import("../packages/runtime/toolchain-shims.js");
      const table = { ...shims.NATIVE_WASM_ALIASES, ...shims.NATIVE_DROPIN_ALIASES };
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      const aliases = Object.entries(lock.packages || {}).filter(
        ([k, v]) => k && v && v.name && table[k.split("node_modules/").pop()] === v.name,
      );
      ok(aliases.length > 0, `…on an id whose shipped lock aliases something (${id[1]}: ${aliases.length} position(s))`);
    }
  }
  // One kernel serves the whole corpus and nearly every one of these is Vite on
  // 5173, so a server left running would hold the port and leave the harness
  // saying the NEXT template bound.
  ok(
    /h\.listening\.delete\(t\.manifest\.port\)/.test(corpus) && /h\.kernel\.stop\(pid\)/.test(corpus),
    "…after stopping the previous one, so a stale bind cannot pass the next template",
  );

  // Ten of the covered ids are Bun templates, which get an npm lockfile because
  // Bun cannot install in-browser and its shim delegates to the real npm CLI.
  // Shipping one is only safe while a `package-lock.json` cannot move a Bun
  // project's dep-cache key, and that rests on exactly two things in
  // kernel-worker.ts. Both are one edit away from being false.
  const worker = read("packages/core/src/workers/kernel-worker.ts");
  ok(
    /const pm = pmName\(pmHint\);\n\s*const key = await computeDepKey/.test(worker) &&
      /const pm = pmName\(pmHint\);\n\s*const keys = await computeDepSaveKeys/.test(worker),
    "a Bun project's cache key comes from the INSTALL COMMAND, not from which lockfiles are on disk",
  );
  const bunLockfiles = worker.match(/bun:\s*\[([^\]]*)\]/);
  ok(
    bunLockfiles && !bunLockfiles[1].includes("package-lock"),
    `…and LOCKFILES.bun does not list package-lock.json, so it is not hashed into one (${bunLockfiles && bunLockfiles[1].trim()})`,
  );

  // …and the harness has to actually write the lock, or the gate above gates an
  // install from ranges and proves nothing about the file being shipped.
  ok(/vendor\/locks\/\$\{templateId\}\.json/.test(viteLib), "runViteSpike installs from the generated lock when there is one");
  ok(/NO generated lockfile/.test(viteLib), "…and says so when there is not, instead of passing quietly");

  // …and CI has to put one there. The locks are gitignored build output, so on a
  // fresh checkout the harness finds nothing and installs from ranges — green,
  // and having tested the wrong thing.
  const ci = read(".github/workflows/ci.yml");
  // This used to be a step in the template-gate JOB, and asserting it there was
  // asserting the wrong noun. `spikes-net` runs the same nine spikes and had no
  // such step, so its `vendor/locks/` was empty: `template-locks` died in 0.2s on
  // the first missing file and the eight template gates quietly installed from
  // ranges — the exact "green, and having tested the wrong thing" the paragraph
  // above warns about, in the job nobody had written a step for.
  //
  // A per-job step cannot be made safe by checking harder, because the thing it
  // gets wrong is that a job can be added without one. So provisioning moved onto
  // the spikes, and what follows gates the property the bug violated — no job can
  // exercise a lock-reading spike against a tree with no locks — rather than the
  // shape of any one job. Which spikes those are is DERIVED from what their source
  // reads, one hop through their imports, because the eight reach the locks
  // through spike-vite-lib.mjs and the ninth will reach them through something
  // else. spike-ci-tiers.mjs asks the same question from the tier side; both read
  // the runner rather than a list of names, so neither can drift from it.
  const runner = read("scripts/run-spikes.mjs");
  const SPIKE_ROW = /^ {2}\{ name: "([^"]+)", file: "([^"]+)"(.*)$/gm;
  const lockReaders = [];
  for (const m of runner.matchAll(SPIKE_ROW)) {
    const file = path.join(ROOT, "scripts", m[2]);
    if (!fs.existsSync(file)) continue;
    let src = fs.readFileSync(file, "utf8");
    for (const imp of src.matchAll(/from\s+"(\.\/(?:lib\/)?[\w.-]+\.mjs)"/g)) {
      const dep = path.join(ROOT, "scripts", imp[1]);
      if (fs.existsSync(dep)) src += fs.readFileSync(dep, "utf8");
    }
    if (!src.includes("vendor/locks")) continue;
    lockReaders.push({
      name: m[1],
      net: /\bnet:\s*true/.test(m[3]),
      vendor: (m[3].match(/vendor:\s*VENDORS\.(\w+)/) || [])[1] || null,
    });
  }
  const netReaders = lockReaders.filter((s) => s.net);
  const unprovisioned = netReaders.filter((s) => s.vendor !== "locks").map((s) => s.name);
  ok(netReaders.length >= 9, `${netReaders.length} net spikes read the shipped locks (the corpus gate and the template gates)`);
  ok(!unprovisioned.length, `…and every one of them declares VENDORS.locks${unprovisioned.length ? ` — missing: ${unprovisioned.join(", ")}` : ""}`);

  // The offline half cannot be provisioned — a `net: false` spike declaring a
  // vendor is itself a failure in spike-ci-tiers, because provisioning shells out
  // to the registry — so those are covered the other way, by running them on a
  // tree stripped to tracked files. Named here so the two halves add up to the
  // whole class rather than one of them being the half somebody remembered.
  const offlineReaders = lockReaders.filter((s) => !s.net).map((s) => s.name);
  const cleanCheckout = read("scripts/spike-clean-checkout.mjs");
  ok(offlineReaders.length > 0, `${offlineReaders.length} offline spikes also read them: ${offlineReaders.join(", ")}`);
  // Its rule is lifted out and RUN against a lock path rather than eyeballed, so
  // a narrowing of the pattern fails here instead of quietly shrinking the set.
  const readsRule = cleanCheckout.match(/const READS_BUILD_OUTPUT = \/(.+)\/;/);
  ok(
    !!readsRule && new RegExp(readsRule[1]).test("packages/studio/public/vendor/locks/react-ts.json"),
    "…and spike-clean-checkout's own derivation still counts a lock read as reading build output",
  );
  ok(/\.filter\(\(s\) => !s\.net/.test(cleanCheckout), "…across the offline tier, which is the half the runner cannot provision");

  // The declaration is only worth what the runner does with it. `always` is what
  // makes this a producer rather than a probe — the output is a SET and `asset`
  // can only name the manifest, which is precisely what an interrupted run leaves
  // behind pointing at locks it never wrote — and `--strict` is what turns a
  // producer that shipped nothing into a red step instead of an assertion failure
  // fifty lines into a spike. Both are inert unless ensureVendor honours them.
  const locksSpec = runner.match(/^ {2}locks:\s*\{[^}]*\}/m);
  ok(!!locksSpec && /script:\s*"vendor:locks"/.test(locksSpec[0]), "VENDORS.locks runs the lock producer");
  ok(!!locksSpec && /args:\s*\["--strict"\]/.test(locksSpec[0]), "…with --strict, since here a lock that cannot be produced is the whole subject");
  ok(!!locksSpec && /always:\s*true/.test(locksSpec[0]), "…and always, since a manifest can outlive the locks it names");
  ok(
    !!locksSpec && /asset:\s*"packages\/studio\/public\/vendor\/locks\//.test(locksSpec[0]),
    "…and reports success only if the manifest it names exists afterwards",
  );
  const ensure = runner.slice(runner.indexOf("async function ensureVendor("));
  ok(
    /if \(fs\.existsSync\(probe\) && !v\.always\) return true;/.test(ensure),
    "ensureVendor re-runs an `always` producer instead of short-circuiting on its manifest",
  );
  ok(
    /const extra = v\.args \? \["--", \.\.\.v\.args\] : \[\];/.test(ensure) && /"run", v\.script, \.\.\.extra/.test(ensure),
    "…and passes its args through, so --strict reaches the producer rather than being decoration",
  );

  // The last link: provisioning only runs for a spike the RUNNER selected. A job
  // that called the spike file directly would walk straight past it, which is the
  // same divergence in a new costume.
  const direct = [...ci.matchAll(/node scripts\/(spike-[\w-]+\.mjs)/g)].map((m) => m[1]);
  ok(!direct.length, `every ci.yml spike invocation goes through run-spikes.mjs${direct.length ? ` — direct: ${direct.join(", ")}` : ""}`);
  const gateJob = ci.slice(ci.indexOf("\n  template-gate:"));
  ok(
    /--net template-locks\$/.test(gateJob) && !/npm run vendor:locks/.test(gateJob),
    "…and the in-VM corpus gate gets its locks that way rather than from a step of its own",
  );

  // And a merge is guarded by the cheap half of that gate. The in-VM corpus
  // needs the Rust toolchain and an hour, so it is schedule-only; resolving the
  // locks needs neither and is where both guards run, which is what a
  // templates.ts edit that starts pulling in an aliased native trips on.
  const prJob = ci.slice(ci.indexOf("\n  lock-resolution-gate:"), ci.indexOf("\n  sdk-smoke:"));
  ok(
    ci.includes("\n  lock-resolution-gate:") && /npm run vendor:locks -- --strict/.test(prJob),
    "a PR resolves every shipped lock, so the guards run before a merge and not only nightly",
  );
  ok(
    /if: github\.event_name != 'schedule'/.test(prJob),
    "…on pull requests, which is the event the in-VM corpus gate does not cover",
  );
}

// ---------------------------------------------------------------------------
console.log("\n== forty lockfiles stay out of the bundle ==");
// ---------------------------------------------------------------------------
// The locks are 2.6 MB of JSON. That is fine while every byte is a separate
// asset fetched by the one project that needs it, and a disaster the moment
// something inlines them — a 2.6 MB bundle, or a service worker that precaches
// 40 files a visitor will use at most one of.
//
// It held at one lock by luck as much as design, because 54 KiB is small enough
// that nobody would have noticed. These assert the properties that make it hold
// at forty, so it cannot regress into a bundle silently.
{
  const idxPath = path.join(ROOT, "packages/studio/public/vendor/locks/index.json");
  if (fs.existsSync(idxPath)) {
    const raw = fs.readFileSync(idxPath, "utf8");
    const idx = JSON.parse(raw);
    const entries = Object.entries(idx);
    // The manifest is the one file EVERY project-create fetches, before it knows
    // which template it wants, so its size is on the critical path in a way the
    // locks themselves are not. 3.2 KiB at 40 entries; the bound is slack enough
    // for every eligible template and tight enough to catch an inlined lock.
    ok(raw.length < 16384, `the manifest every project-create fetches stays small (${raw.length} B for ${entries.length})`);
    ok(
      entries.every(([, e]) => Object.keys(e).sort().join() === "asset,bytes"),
      "…because an entry is a POINTER — {asset, bytes} — and never the lock itself",
    );
    ok(
      entries.every(([id, e]) => e.asset === `vendor/locks/${id}.json`),
      "…to a per-template asset, so a project fetches one lock and not forty",
    );
  }

  // `public/` is copied outside the rollup bundle, so the only way a lock reaches
  // the JS is if something imports it. Only the kernel names the directory, and
  // only as a URL it fetches at runtime.
  const sources = (dir) =>
    fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && /\.(ts|tsx|js|jsx)$/.test(e.name))
      .map((e) => path.join(e.parentPath || e.path, e.name));
  const importers = ["packages/studio/src", "packages/core/src"]
    .flatMap((d) => sources(path.join(ROOT, d)))
    .filter((f) => /(?:import|require)\s*\(?\s*["'][^"']*vendor\/locks/.test(fs.readFileSync(f, "utf8")));
  ok(importers.length === 0, `no module imports a lock (${importers.map((f) => path.relative(ROOT, f)).join(", ") || "none"})`);

  // And the templates themselves must not carry one. A template that shipped a
  // package-lock.json would put the bytes in templates.ts — which IS bundled —
  // and `eligibility()` would then skip it, so the cost would arrive with the
  // benefit removed.
  const templatesTs = read("packages/studio/src/vv/templates.ts");
  ok(!templatesTs.includes("lockfileVersion"), "no lock is inlined into templates.ts, which is bundled");

  // The service worker precaches the studio's own hashed output and nothing
  // else. `vendor/` URLs are stable across deploys and invisible to the build
  // id, so cache-first there is unbounded staleness — and at 40 locks it would
  // also be 2.6 MB fetched on first load for one file's worth of use.
  const viteConfig = read("packages/studio/vite.config.ts");
  const prefixes = viteConfig.match(/prefixes:\s*\[([^\]]*)\]/);
  ok(!!prefixes, "the precache manifest declares its asset prefixes");
  ok(prefixes && !prefixes[1].includes("vendor"), `…and vendor/ is not one of them (${prefixes && prefixes[1].trim()})`);
}

// ---------------------------------------------------------------------------
console.log("\n== a lockfile names tarball URLs the browser can reach ==");
// ---------------------------------------------------------------------------
// The defect this is here for is caught by the net gate above, not by review: a
// lock resolved on a host behind a private mirror pins
// `http://npm.mirror.invalid/…` for all 102 packages. `resolved` is an ABSOLUTE
// URL, so the resolving host's registry travels into the VM. There every fetch
// fails, npm exits **0**, and the project has no `vite` — a template that used to
// install slowly does not run at all.
{
  const gen = read("scripts/gen-template-locks.mjs");
  ok(/--registry=\$\{REGISTRY\}\//.test(gen), "the generator pins the registry it resolves against");
  ok(/--registry=\$\{REGISTRY\}\//.test(read("scripts/gen-depcache.mjs")), "…and so does the snapshot producer");

  // Pinning the input is not enough — a mirror also arrives via .npmrc, a
  // per-scope registry, or NPM_CONFIG_*. What ships is the OUTPUT, so that is
  // what gets checked, and here is proof the check can actually fail.
  const mirrored = JSON.stringify({
    lockfileVersion: 3,
    packages: { "": {}, "node_modules/vite": { resolved: "http://npm.mirror.invalid/vite/-/vite-8.2.1.tgz" } },
  });
  let refused = null;
  try {
    assertPublicRegistry(mirrored);
  } catch (e) {
    refused = e.message;
  }
  ok(!!refused, `a mirror-resolved lock is refused (${refused || "IT WAS ACCEPTED"})`);
  ok(!!refused && /npm\.mirror\.invalid/.test(refused), "…naming the host, so the cause is in the build log");

  let accepted = true;
  try {
    assertPublicRegistry(
      JSON.stringify({
        lockfileVersion: 3,
        // A workspace/link entry has no `resolved` and must not trip it.
        packages: { "": {}, "node_modules/vite": { resolved: `${REGISTRY}/vite/-/vite-8.2.1.tgz` }, "packages/x": {} },
      }),
    );
  } catch {
    accepted = false;
  }
  ok(accepted, "…and a public one is not");

  // And the lock actually on disk, when there is one, since that is what a local
  // `npm run vendor:depcache` would key a snapshot against.
  for (const id of COVERAGE) {
    const p = path.join(ROOT, `packages/studio/public/vendor/locks/${id}.json`);
    if (!fs.existsSync(p)) continue;
    let clean = true;
    let why = "";
    try {
      assertPublicRegistry(fs.readFileSync(p, "utf8"));
    } catch (e) {
      clean = false;
      why = ` — ${e.message}`;
    }
    ok(clean, `the generated ${id} lock on disk is clean${why}`);
  }
}

console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: the install path's build and boot wiring holds");
process.exit(failed ? 1 : 0);