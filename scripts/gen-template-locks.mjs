// Resolve a `package-lock.json` for each shipped template, once, at build time.
//
//   node scripts/gen-template-locks.mjs              # the COVERAGE set
//   node scripts/gen-template-locks.mjs react-ts     # just these ids
//   node scripts/gen-template-locks.mjs --all        # every ELIGIBLE template
//   node scripts/gen-template-locks.mjs --force      # ignore already-built assets
//   node scripts/gen-template-locks.mjs --strict     # any failure fails the run
//
// `--strict` is the only mode that exits non-zero. The deploy runs this without
// it, because a lock is a pure optimisation and must not be able to cancel the
// deploy of the whole site; see the note above the strict check at the bottom.
//
// WHY. A template ships a package.json and no lockfile, so npm's Arborist has to
// build an ideal tree from ranges — and to do that it takes the
// `fullMetadata: true` branch and asks the registry for the COMPLETE packument
// of every package in the graph. Measured on react-ts against
// registry.npmjs.org: 301 requests / 155.6 MiB, of which 151 requests and
// 143.0 MiB are packuments and only 12.6 MiB are the tarballs it actually
// installs. 92% of the bytes go on deciding what to install. With a lockfile
// present the same install is 150 requests / 12.6 MiB and ZERO packument bytes.
//
// In the browser each of those MiB costs more than it does here: it is gunzipped
// in the Fetcher Worker, transferred to the kernel, written to the VFS, read back
// through the 1 MiB SAB window, parsed, and written again into npm's _cacache.
//
// The second reason is A2. A lockfile makes an install reproducible, which is
// what lets scripts/gen-depcache.mjs build a node_modules snapshot at build time
// whose dep-cache key is the one the browser will look up.
//
// WHY THE ASSETS ARE BUILT AND NOT COMMITTED. Same division as every other
// vendor script: packages/studio/public/vendor is gitignored, the deploy builds
// it. ~70 locks at 30-120 KiB each is 4 MB of generated JSON that would turn
// every dependency bump into an unreviewable diff, and a lock refreshed on each
// deploy floats in bounded steps instead of rotting until someone notices.
//
// WHY --cpu/--os. The VM reports `wasm32`/`linux` (runtime/builtins/process.js),
// and those are what decide which optional platform binaries npm selects. A
// lockfileVersion 3 lock records every variant with its own `os`/`cpu` so the
// filtering happens at reify time either way — but resolution honours them too,
// and generating on the host's arch is how a tree that cannot exist in the VM
// gets pinned into the file the VM installs from.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

import { loadShippedTemplates } from "./lib/shipped-templates.mjs";
import { NATIVE_DROPIN_ALIASES, NATIVE_WASM_ALIASES } from "../packages/runtime/toolchain-shims.js";

// Driven by the kernel's own alias tables rather than a copy of them, so a
// fourth native package added there cannot silently start being pinned here,
// and so the drop-in this file resolves is by construction the one the Fetcher
// would have served. `{ esbuild: "esbuild-wasm", lightningcss:
// "lightningcss-wasm", rollup: "@rollup/wasm-node", bcrypt: "bcryptjs" }`.
const ALIASED_NATIVES = { ...NATIVE_WASM_ALIASES, ...NATIVE_DROPIN_ALIASES };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "packages/studio/public/vendor/locks");
const INDEX = path.join(OUT_DIR, "index.json");
// One cache for the whole run. The templates overlap heavily (every Vite variant
// pulls the same rolldown graph), so the second template onwards is mostly warm.
const CACHE = path.join(os.tmpdir(), "vv-gen-locks-cache");
// The registry the BROWSER will fetch from. No trailing slash — it is compared
// against `resolved` prefixes as well as passed to npm. See assertPublicRegistry.
export const REGISTRY = "https://registry.npmjs.org";

// The templates whose lock is SHIPPED. Eligibility (below) is the derived rule
// for "could have a lock"; this is the narrower "has been proven to install from
// one in the VM", and the two are deliberately not the same list.
//
// A lock is resolved on the build host and reified in a wasm32 VM. Get that wrong
// — pin an optional variant the VM cannot build — and the template does not get
// slower, it BREAKS, and it breaks for everyone at once on the deploy that
// introduced it. A latency win is not worth that trade on a template nobody has
// watched install. So an id goes here only once a `--net` spike installs that
// template from this generated lock and boots its dev server; `runViteSpike`
// writes the lock in for exactly that reason, and `spike-install-latency.mjs`
// refuses an id here that has no such gate.
//
// 63 templates are eligible; 59 are here. The four missing ones are `nuxt`,
// `slidev`, `vitepress` and `vitest`, and none of them is refused over its lock:
// the first three cannot be BOOTED in this VM at all — measured with and
// without a lock, identically — and `vitest` has no port to bind, so the gate
// below cannot produce the evidence this list requires. See NOT_BOOTABLE.
//
// The gate for every id below is scripts/spike-template-locks.mjs, which
// installs each one in the VM from this exact generated file — with the
// template's own package manager, so the Bun tab goes through `bun install` —
// and asserts the tree is usable: direct deps resolve, and every binary the
// template's own dev command reaches is in node_modules/.bin.
//
// Installing is a floor, not a ceiling: a tree can install and then throw on
// import, which is how `tailwind` shipped broken once. So an id whose lock has
// an ALIASED entry — the wasm drop-in resolved under the native name, see
// aliasOverrides — additionally has that package `require()`d and the dev server
// booted by the same gate. Which ids those are is read off the lock rather than
// listed here, so it cannot drift from what the locks actually pin.
//
// Ordered as the studio lists them, so a diff here reads as "what changed about
// the template set" rather than as a reshuffle.
export const COVERAGE = [
  "react-js",
  // The template the "even a plain React TS project feels slow" report is about,
  // and the one with a shipped snapshot. 143.0 MiB of packuments -> 0.
  "react-ts",
  "angular",
  "vue-js",
  "vue-ts",
  "svelte-js",
  "svelte-ts",
  "vanilla-js",
  "vanilla-ts",
  "bootstrap",
  // Shipped a lock that installed with exit 0 and could not boot, which is why
  // the gate for these ids boots them. Its lock pinned the real lightningcss,
  // @tailwindcss/node requires that synchronously, and the VM has no binding —
  // `failed to load config from vite.config.js`. The lock now resolves
  // lightningcss-wasm under the `lightningcss` name and it boots; 250.9 MiB of
  // transfer without a lock, 28.0 MiB with one.
  "tailwind",
  "preact",
  "lit",
  "solid",
  "qwik",
  "ember",
  "tanstack-router",
  "express-js",
  "express-ts",
  "nest-ts",
  "koa",
  "hono",
  "s3",
  "session-login",
  "h3",
  "fastify",
  "nitro",
  "graphql",
  "feathers",
  // The whole Bun tab. `bun install` delegates to the real npm CLI, so it reads
  // these: 20.21 MiB -> 3.70 MiB for bun-react, almost all of it the @types/bun
  // packument. See the `bun` arm of `eligibility` for the measurement.
  "bun",
  "bun-routes",
  "bun-ws",
  "bun-react",
  "bun-test",
  "bun-sqlite",
  "bun-fullstack",
  "bun-shell",
  "bun-build",
  "bun-apis",
  // 144.7 MiB of packuments, and install scripts rule out a snapshot for it, so
  // a lock is the only optimisation it can have. It was blocked on
  // `spike-next.mjs` hand-writing its own Next project instead of loading the
  // shipped template; the corpus gate installs the shipped bytes, so the block
  // is gone without touching that 250 MB net gate.
  "next-ts",
  "next-js",
  "sveltekit",
  "react-router",
  // The heavy fullstack templates the original report named. Both were refused
  // until the generator started aliasing esbuild, whose install script exits 1
  // on wasm32 and took the whole install down with it.
  "astro",
  "docusaurus",
  "rspress",
  "starlight",
  "three",
  "gsap-react",
  "webpack",
  "rsbuild",
  "rsbuild-ts",
  "fullstack",
  "sse",
  "ws-demo",
  "socketio",
  "trpc",
  "sqlite",
  "pglite",
];

/**
 * Eligible ids kept OUT of COVERAGE, and what stops each — none of it the lock.
 *
 * The rule is that an id ships a lock once the corpus gate proves the tree it
 * produces is usable, and for these four the gate cannot produce that proof.
 * Every one of them resolves an aliased lock that passes both guards, installs
 * in the VM with exit 0, and imports its aliased packages; what fails is the
 * boot, or there is no boot to run. Measured on a kernel booted fresh for each
 * arm, so the in-VM npm cache is cold both times and the two are comparable —
 * `nolock` being the same template with no lock at all:
 *
 *   nuxt       lock 597 req / 37.7 MiB, nolock 1342 / 574.0 — neither binds.
 *              `oxc-parser` throws `Unsupported architecture on Linux: wasm32`
 *              and it is not an alias-table member, so nothing substitutes it.
 *   slidev     lock 681 / 92.9, nolock 1376 / 347.3 — neither binds.
 *   vitepress  lock 125 / 20.2, nolock  293 / 165.3 — neither binds.
 *
 * The lock is a large win on all three and it buys nothing, which is the whole
 * reason they are here rather than in COVERAGE. An earlier revision of this
 * block quoted lower figures for both arms — the lock arm was measured over a
 * batch sharing one kernel, so each template was charged only for what the
 * previous one had not already fetched. Re-measured one kernel per arm.
 *   vitest     installs and imports; `vitest` is a test runner with no port, so
 *              there is no dev server to bind and the gate's strongest check
 *              does not apply to it.
 *
 * They are listed rather than merely omitted so the reason travels with them:
 * "we could not prove it" is a different thing from "it broke", and the first
 * three would ship the moment their template boots in the VM for reasons that
 * have nothing to do with this file. spike-install-latency.mjs asserts the two
 * sets do not overlap.
 */
export const NOT_BOOTABLE = new Set(["nuxt", "slidev", "vitepress", "vitest"]);

const args = process.argv.slice(2);
const all = args.includes("--all");
const force = args.includes("--force");
const strict = args.includes("--strict");
// Resolution is round-trip bound rather than CPU bound, so the default is not
// the core count. Re-measured cold over the 59 shipped templates on this host,
// which is 86 resolves because 27 of them alias and so resolve twice: 63.3s at
// 8, 63.6s at 12, 64.8s at 16, 66.9s at 24. Saturated well below 8 — the extra
// pass is the cost, not the queue, and buying it back would mean giving local
// dev a smaller set than the deploy, which is the divergence this branch has
// already shipped twice. Warm is 0.18s, since an existing asset is reused.
const jobsArg = args.find((a) => a.startsWith("--jobs="));
const jobs = Math.max(1, Number(jobsArg ? jobsArg.slice(7) : 8) || 8);
const only = new Set(args.filter((a) => !a.startsWith("--")));

/**
 * Why this template can NOT have an npm lockfile resolved for it, or null if it
 * can.
 *
 * The answer is derived from the template rather than kept in a list here, so a
 * template added to the studio is covered without anyone remembering to add it.
 * Exported because scripts/spike-install-latency.mjs drives this exact function
 * over the shipped set: a rule that quietly stops matching any template would
 * otherwise show up only as a manifest that got smaller.
 */
export function eligibility(t) {
  const files = t.files || {};
  const pj = files["package.json"];
  if (!pj) return "no package.json (Python/static template)";
  if (files["package-lock.json"]) return "already ships a lockfile";
  const install = String(t.manifest.install || "");
  const pm = install.trim().split(/\s+/)[0] || "npm";
  // yarn.lock and pnpm-lock.yaml are different formats with different key
  // derivations (see LOCKFILES in kernel-worker.ts); npm cannot produce them and
  // a package-lock.json would not be read.
  //
  // `bun` is here because Bun cannot install in-browser and its shim DELEGATES
  // to the real npm CLI (packages/kernel-host/programs/bun.js), so the npm
  // lockfile is read by the thing actually doing the install. Measured in the
  // VM rather than assumed: `bun install` for bun-react goes 17 requests /
  // 20.21 MiB → 9 / 3.70 MiB with one on disk, and the file is byte-identical
  // afterwards. The bulk is the `@types/bun` packument, which is why the
  // "type-only deps, so nothing to win" guess was wrong by 16 MiB.
  if (pm !== "npm" && pm !== "bun") return `installs with ${pm}, not npm`;
  let parsed;
  try {
    parsed = JSON.parse(pj);
  } catch (e) {
    return `package.json does not parse (${e.message})`;
  }
  const deps = { ...(parsed.dependencies || {}), ...(parsed.devDependencies || {}) };
  // A dependency-free template (the whole Bun tab) installs in the VM without
  // touching the registry, so a lock buys it nothing.
  if (Object.keys(deps).length === 0) return "no dependencies";
  return null;
}

/**
 * Make an UNEXPECTED throw fail soft too.
 *
 * Both producers catch per-template failures, but neither guarded the rest of
 * itself: a template loader that throws, a full disk, a bad JSON parse in the
 * merge step. Any of those escapes as a non-zero exit, and under
 * `cloudflare-build.sh`'s `set -euo pipefail` a non-zero exit from an
 * optimisation cancels the deploy of the whole site. The contract has to hold
 * for the failures nobody enumerated, or it is not a contract — those are the
 * ones that will actually happen.
 *
 * `--strict` still exits 1, because there the assets ARE the subject.
 */
export function installFailSoftHandler(label, strict) {
  const bail = (err) => {
    console.error(`\n${label}: WARNING — unexpected failure; assets for this run are incomplete or absent.`);
    console.error(`  ${(err && err.stack) || err}`);
    if (!strict) console.error("  Exiting 0 anyway: this is an optimisation and must not cancel the deploy.");
    process.exit(strict ? 1 : 0);
  };
  process.on("uncaughtException", bail);
  process.on("unhandledRejection", bail);
}

/**
 * Write a vendor manifest, or leave NO manifest when there is nothing in it.
 *
 * An empty manifest and an absent one mean the same thing to the kernel — the
 * feature is off — but they do not mean the same thing to the deploy. The build
 * asserts a kernel-fetchable asset is there by testing for a non-empty FILE
 * (`checkKernelAssets`, via assemble-site.mjs), and `{}\n` is three bytes. So a
 * producer that failed honestly and exited 0 would still be counted present, and
 * the deploy's loudest check would print `✓ … asset paths present` for a manifest
 * that disables the largest install optimisation there is. Writing nothing is
 * what makes the existing `○ optional asset not produced` line fire.
 *
 * A stale manifest is removed rather than left, because the file on disk is
 * exactly the lie this is here to stop telling.
 */
export function writeOptionalManifest(indexPath, index) {
  if (Object.keys(index).length > 0) {
    // Atomically, because this is the one file EVERY project-create fetches:
    // a torn write is not a slow template, it is a manifest that does not parse.
    writeAtomic(indexPath, JSON.stringify(index, null, 2) + "\n");
    return true;
  }
  fs.rmSync(indexPath, { force: true });
  return false;
}

/**
 * Take one id out of the manifest that is CURRENTLY ON DISK, before its asset
 * is removed.
 *
 * The in-memory `index` is not the published one — it is written once, at the
 * end — so between a rejection early in a run and that write, the manifest
 * being served still names every lock the previous run left. Removing the file
 * first is what makes "listed but unusable" reachable, and the runtime calls
 * that a build defect on the grounds that the merge step cannot produce it.
 *
 * Absent or unparseable is not an error: there is then nothing published to
 * withdraw. Atomic, because this is the file every project-create fetches.
 */
export function unpublish(indexPath, id) {
  let published;
  try {
    published = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  } catch {
    return false;
  }
  if (!published || typeof published !== "object" || !(id in published)) return false;
  delete published[id];
  writeOptionalManifest(indexPath, published);
  return true;
}

/**
 * Write `text` to `p` so that `p` is either absent or complete, never partial.
 *
 * `vendor:locks` runs from `predev`, so the cold run happens under `npm run dev`
 * and the user is watching a 34s pause — Ctrl-C is the expected input, not an
 * exotic one. A plain writeFileSync of a 400 KiB lock has a window where the
 * file exists and is short, and the reuse path on the next run would then adopt
 * it. Rename within the same directory is atomic, so the interrupted run leaves
 * a stray `.tmp` and nothing else.
 *
 * The pid is in the temp name because up to `--jobs` of these run at once.
 */
export function writeAtomic(p, data) {
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, p);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * The line of a failure worth putting in the build log.
 *
 * This used to be the LAST line of npm's stderr, which for npm is always
 * `A complete log of this run can be found in: /tmp/…` — a path that does not
 * survive the build container, attached to no cause. The cause is the first
 * `npm error` line that is not one of npm's own framing lines, e.g.
 * `404 Not Found - GET https://registry.npmjs.org/@scope/typo`.
 */
function npmDetail(e) {
  const lines = String((e && e.stderr) || "")
    .split("\n")
    .map((l) => l.replace(/^npm (error|ERR!)\s*/, "").trim())
    .filter(Boolean)
    .filter((l) => !/^(code |A complete log|errno |command failed|command sh )/i.test(l));
  return lines[0] || (e && e.message) || String(e);
}

/**
 * Why an on-disk lock must not be shipped as-is, or null if it can be.
 *
 * The same two checks the resolve path runs, plus wholeness — so the warm path
 * cannot ship a truncated file, nor one that predates a tightening of either
 * guard.
 */
function unshippable(p) {
  let text;
  try {
    text = fs.readFileSync(p, "utf8");
    const lock = JSON.parse(text);
    if (!lock || !lock.packages) return "no packages";
  } catch (e) {
    return `truncated or unparseable: ${e.message}`;
  }
  try {
    assertPublicRegistry(text);
    assertNoAliasedNatives(text);
    assertPeerProviders(text);
  } catch (e) {
    return e.message;
  }
  return null;
}

/**
 * Every tarball URL a lock names must be one the BROWSER can reach.
 *
 * A lockfile pins `resolved` as an absolute URL, so it carries whatever registry
 * the build host was configured with straight into the VM. This is not
 * hypothetical and it is not loud: resolved behind a private mirror, the lock
 * for react-ts named `http://npm.mirror.invalid/vite/-/vite-8.2.1.tgz` for all 102
 * packages. In the VM every one of those fetches fails, npm still exits **0**,
 * and the template lands with no `node_modules/.bin/vite` — a template that
 * merely installed slowly before now does not run at all. `--registry` is set on
 * the invocation, but a mirror can also arrive via `.npmrc`, `NPM_CONFIG_*`, or
 * a per-scope registry, so the produced file is checked rather than the input.
 */
export function assertPublicRegistry(lockText) {
  const lock = JSON.parse(lockText);
  const bad = new Set();
  for (const [name, meta] of Object.entries(lock.packages || {})) {
    const url = meta && meta.resolved;
    if (!url || !/^https?:/.test(url)) continue; // link:/workspace entries
    if (!url.startsWith(`${REGISTRY}/`)) bad.add(`${name || "<root>"} → ${new URL(url).host}`);
  }
  if (bad.size) {
    const shown = [...bad].slice(0, 3).join(", ");
    throw new Error(`${bad.size} package(s) resolved off ${REGISTRY}: ${shown}${bad.size > 3 ? ", …" : ""}`);
  }
}

/**
 * Refuse a lock that pins a package the VM cannot run under its own name.
 *
 * esbuild, rollup, lightningcss and bcrypt ship native binaries with no wasm32
 * build, and their working substitutes live under different names. The kernel
 * deals with this in the Fetcher by serving the drop-in's PACKUMENT under the
 * native name (`NATIVE_WASM_ALIASES` / `NATIVE_DROPIN_ALIASES`,
 * packages/runtime/toolchain-shims.js), so a plain in-VM `npm install` resolves
 * "lightningcss" and receives lightningcss-wasm with no project-level overrides.
 *
 * That substitution happens at the metadata layer, and both fetchers say so:
 * "tarball requests (…/<name>/-/<file>.tgz) are deliberately left untouched".
 * A lockfile skips the metadata layer entirely — it carries an exact `resolved`
 * URL and an integrity hash — so installing from one gets the REAL native
 * package and the alias never runs. `resolveLock` therefore performs the same
 * substitution itself (see aliasOverrides), and this function is what holds it
 * to that: an entry aliased to the native's registered drop-in is the fix and
 * passes, one under its own name is the defect, and one aliased to some OTHER
 * package is unreviewed and refused with it.
 *
 * `hasInstallScript` IS NOT THE DISCRIMINATOR, AND KEYING ON IT SHIPPED A BROKEN
 * TEMPLATE. All four of these have zero wasm32-capable optional deps; the flag
 * only decides whether the failure is loud or silent:
 *
 *   esbuild        install script — exits 1, `Unsupported platform: linux
 *                  wasm32 LE`. Loud: the install fails and nothing ships. This
 *                  refused 13 templates, astro among them.
 *   lightningcss   no install script — installs clean, exit 0, and then
 *                  `require('lightningcss')` throws `Cannot find module
 *                  '../lightningcss.linux-wasm32-gnu.node'`. Silent.
 *
 * The version that keyed on the flag reasoned that the silent class was
 * theoretical because "every lock that pins rollup also pins esbuild". No
 * shipped lock pinned rollup at all — the Vite templates are on rolldown — so
 * the claim was unfalsifiable rather than true, and it was watching the wrong
 * package: eighteen locks pinned lightningcss, and `tailwind` imports it via
 * @tailwindcss/node. It installed with exit 0 and its dev server never bound:
 * `failed to load config from vite.config.js`. Measured in the VM, installing
 * from the shipped lock and then importing:
 *
 *   pinned as itself   real lightningcss, no .wasm asset, none of its 11
 *                      platform packages installable on wasm32 → IMPORT FAILED
 *   aliased / no lock  lightningcss-wasm under the `lightningcss` name,
 *                      carrying lightningcss_node.wasm          → IMPORT OK
 *
 * There is consequently no class of lock that needs excusing, and no `id`
 * parameter: the ids that alias something are BOOTED by
 * spike-template-locks.mjs, which reads them off the locks themselves.
 *
 * This lives here rather than in `eligibility()` because it is not a property of
 * the template — react-ts and svelte-ts declare almost the same thing — it is a
 * property of the tree npm resolves, which is only knowable after resolving it.
 */
export function assertNoAliasedNatives(lockText) {
  const lock = JSON.parse(lockText);
  const hit = new Set();
  for (const [key, meta] of Object.entries(lock.packages || {})) {
    const name = nativeAt(key);
    if (!name) continue;
    // `name` on an entry is npm's alias marker: the key is the name the tree
    // resolves under, `meta.name` the package actually fetched. Aliased to this
    // native's registered drop-in, the entry is the fix rather than the defect —
    // but aliased to anything else it is unreviewed, so it is refused too.
    if (meta && meta.name === ALIASED_NATIVES[name]) {
      // `name` is a CLAIM; `resolved` is the URL npm downloads. An entry
      // labelled esbuild-wasm whose tarball is esbuild's installs the native
      // and satisfies a check that only reads the label — the exact state this
      // function exists to prevent, wearing the fix as a costume. The two are
      // written together by npm and can only disagree in a lock that something
      // else produced, which is precisely what the reuse path in `main` hands
      // to `unshippable`: a file on disk, from an unknown generation.
      if (resolvedPackage(meta.resolved) === meta.name) continue;
      hit.add(`${name} (labelled ${meta.name}, resolved from ${resolvedPackage(meta.resolved) || "nowhere"})`);
      continue;
    }
    hit.add(meta && meta.name ? `${name} (as ${meta.name})` : name);
  }
  if (!hit.size) return;
  throw Object.assign(
    new Error(
      `lock pins ${[...hit].join(", ")}, which the VM cannot run: a pinned tarball URL bypasses the ` +
        `packument alias that substitutes the wasm drop-in. resolveLock is supposed to have aliased it`,
    ),
    { code: "ERR_LOCK_PINS_ALIASED_NATIVE" },
  );
}

/**
 * Which copy of a package a given position resolves, by npm's own rule: the
 * innermost enclosing `node_modules` that has it, walking outward to the root.
 */
function resolveFrom(packages, fromKey, name) {
  const parts = fromKey ? fromKey.split("/node_modules/") : [];
  for (let i = parts.length; i >= 0; i--) {
    const scope = parts.slice(0, i).join("/node_modules/");
    const candidate = (scope ? `${scope}/node_modules/` : "node_modules/") + name;
    if (packages[candidate]) return candidate;
  }
  return null;
}

const entryName = (key, meta) => (meta && meta.name) || key.slice(key.lastIndexOf("node_modules/") + 13);

/**
 * A lock must not hand a package a peer its own dependency has been given a
 * different copy of.
 *
 * A peer dependency is a request to be a SINGLETON: `Y` declaring `peer P` means
 * "whoever depends on me must supply P, and we must both mean the same P". npm
 * satisfies that by placing one copy where both can see it and marking the entry
 * `peer: true`. When it cannot, it does not fail — it installs a second copy,
 * and the two only meet at runtime, inside whichever package passes an object
 * from one to the other.
 *
 * That is not a hypothetical. `@rolldown/binding-wasm32-wasi` 1.2.1 through
 * 1.2.3 pins `@emnapi/core` and `@emnapi/runtime` at exactly `2.0.0-alpha.3`,
 * while the `@napi-rs/wasm-runtime` it also depends on declares
 * `peerDependencies: ^1.7.1 || ^2.0.0-alpha.4` — a range alpha.3 misses on both
 * sides, alpha.4 having been published five days after the binding was. So npm
 * put `@emnapi/*@1.11.3` at the root for napi-rs and nested alpha.3 under the
 * binding. Measured in the VM, the require then dies inside the runtime:
 *
 *   this.bridge.setLastError is not a function <- this.bridge.deleteEnv is not a function
 *
 * rolldown catches that, falls to the branch it keeps for `process.versions
 * .webcontainer` — which this VM sets, deliberately, for Next's wasm SWC — and
 * that branch shells out to `pnpm i` into /tmp, which is not a thing here. The
 * message a template author finally sees names none of it:
 *
 *   Cannot find native binding. npm has a bug related to optional dependencies
 *
 * Eight framework spikes hung for five minutes each on that sentence. Every one
 * of the eighteen locks holding the split is caught by the two lines below, by
 * name, in milliseconds.
 *
 * The check is deliberately narrower than "P appears twice". Duplicated copies
 * are ordinary and mostly harmless — a wasm binding that nests its whole napi
 * stack is self-consistent, and `tslib` is in half these trees at two majors —
 * so what is refused is only the case where a package supplies its OWN
 * dependency a copy other than the one npm reified for that dependency's peer.
 * Measured over the 59 shipped locks: 18 of the stale set, all of them this one
 * defect; 0 of the set resolved after upstream fixed it.
 */
export function assertPeerProviders(lockText) {
  const packages = JSON.parse(lockText).packages || {};
  const split = new Map();
  for (const [consumerKey, consumer] of Object.entries(packages)) {
    // devDependencies too, which only the ROOT entry has — and the root is
    // where these templates declare the very package this defect came in:
    // `@rolldown/binding-wasm32-wasi` is a devDependency of nineteen of them.
    // npm usually cannot build a split at the root, because a peer it cannot
    // satisfy there is an ERESOLVE rather than a nested copy, so leaving them
    // out was very nearly right; but "very nearly" and "the exact package
    // family that caused this" are a bad pair. Verdict-neutral when it was
    // added: no change on any of the 59 healthy locks or the 3 stale ones.
    const deps = {
      ...(consumer.dependencies || {}),
      ...(consumer.optionalDependencies || {}),
      ...(consumer.devDependencies || {}),
    };
    for (const depName of Object.keys(deps)) {
      const depKey = resolveFrom(packages, consumerKey, depName);
      if (!depKey) continue;
      for (const peerName of Object.keys(packages[depKey].peerDependencies || {})) {
        // Only the consumer that declares P itself is claiming to supply it.
        if (!(peerName in deps)) continue;
        const asDepSees = resolveFrom(packages, depKey, peerName);
        const asConsumerSees = resolveFrom(packages, consumerKey, peerName);
        if (!asDepSees || !asConsumerSees || asDepSees === asConsumerSees) continue;
        // `peer: true` is npm recording that it placed this copy TO SATISFY a
        // peer contract. Without it the two copies are just hoisting, which is
        // not this defect.
        if (!packages[asDepSees].peer) continue;
        if (packages[asDepSees].version === packages[asConsumerSees].version) continue;
        split.set(
          `${entryName(consumerKey, consumer)}+${peerName}`,
          `${entryName(consumerKey, consumer)}@${consumer.version} supplies ${peerName}@` +
            `${packages[asConsumerSees].version} to ${entryName(depKey, packages[depKey])}@` +
            `${packages[depKey].version}, whose peer npm reified at ${packages[asDepSees].version}`,
        );
      }
    }
  }
  if (!split.size) return;
  throw Object.assign(
    new Error(
      `lock splits a peer provider, so the two copies meet at runtime: ${[...split.values()].join("; ")}`,
    ),
    { code: "ERR_LOCK_SPLITS_PEER_PROVIDER" },
  );
}

/**
 * The package a registry tarball URL actually serves, from the `<name>/-/<file>`
 * shape npm writes: "…/esbuild-wasm/-/esbuild-wasm-0.27.7.tgz" -> "esbuild-wasm",
 * and scoped, "…/@rollup/wasm-node/-/wasm-node-4.62.4.tgz" -> "@rollup/wasm-node".
 * "" for anything that is not a URL of that shape.
 */
function resolvedPackage(resolved) {
  try {
    const p = new URL(resolved).pathname.slice(1);
    return p.includes("/-/") ? p.split("/-/")[0] : "";
  } catch {
    return "";
  }
}

/** "node_modules/vite/node_modules/esbuild" -> "esbuild", if that is an alias-table member. */
function nativeAt(key) {
  const name = key.split("node_modules/").pop();
  return name && Object.hasOwn(ALIASED_NATIVES, name) ? name : "";
}

/**
 * `overrides` that swap every aliased native in a resolved tree for its drop-in,
 * or null if the tree has none.
 *
 * PER POSITION, at the version that position already resolved to — so
 * `node_modules/esbuild@0.27.7` and `node_modules/vite/node_modules/esbuild@
 * 0.25.12` become `{esbuild: "npm:esbuild-wasm@0.27.7", vite: {esbuild:
 * "npm:esbuild-wasm@0.25.12"}}`. The lock that comes back is then the tree npm
 * resolved with the tarballs swapped, and nothing else: no version is moved, so
 * no dependent gets a package outside the range it asked for.
 *
 * A single flat `{esbuild: "npm:esbuild-wasm@<max>"}` is simpler and was
 * measured against this — astro 276 req / 30.2 MiB per position vs 277 / 31.2
 * unified, both booting. Identical cost, so the version-preserving one wins on
 * the argument it does not have to make.
 *
 * Correctness rests on lockstep publishing (lightningcss 1.33.0 ⇄
 * lightningcss-wasm 1.33.0), and that is a much weaker property across the
 * table than the two members appearing today suggest. Counted against the
 * registry:
 *
 *   esbuild ⇄ esbuild-wasm            482 vs 490 published, 1 unmatched
 *   lightningcss ⇄ lightningcss-wasm   43 vs  42 published, 1 unmatched
 *   rollup ⇄ @rollup/wasm-node        941 vs 203 published, 740 unmatched —
 *     the wasm build starts at 4.x, so no rollup 3 position can be aliased
 *   bcrypt ⇄ bcryptjs                  55 vs  30 published, 41 unmatched, and
 *     the version LINES do not correspond at all (bcrypt 6.x vs bcryptjs 3.x).
 *     A NATIVE_DROPIN_ALIASES member can therefore never be aliased in a lock:
 *     the runtime handles it by version-remapping the packument, which a lock
 *     has no way to express. No template depends on one today.
 *
 * So lockstep is not assumed anywhere. Two things fail the second resolve, and
 * both fail SAFELY — the template ships no lock and installs from ranges in the
 * VM, where the packument alias substitutes correctly as it always did:
 *
 *   1. a version the drop-in never published, which 404s;
 *   2. an alias-table member the template depends on DIRECTLY, which npm
 *      refuses with EOVERRIDE ("Override for rollup@^4.0.0 conflicts with
 *      direct dependency") no matter how perfect the lockstep. Overrides can
 *      only redirect a transitive position. Aliasing a direct one means
 *      rewriting the dependency SPEC, and npm records that spec in the lock's
 *      root entry, where it would no longer match the template's package.json
 *      and would take `npm ci` down with it. Every alias-table member is
 *      transitive in every template today, which is why this is a note and not
 *      a defect.
 *
 * And `assertNoAliasedNatives` fails the lock anyway if any position comes back
 * unaliased, so neither failure can ship.
 */
export function aliasOverrides(lockText) {
  const lock = JSON.parse(lockText);
  const overrides = {};
  let n = 0;
  for (const [key, meta] of Object.entries(lock.packages || {})) {
    const name = nativeAt(key);
    if (!name || !meta || meta.name || !meta.version) continue;
    let node = overrides;
    // Everything above the last segment is the path to nest the override under.
    for (const seg of key.split("node_modules/").slice(1, -1)) {
      const dep = seg.replace(/\/$/, "");
      node = node[dep] || (node[dep] = {});
    }
    node[name] = `npm:${ALIASED_NATIVES[name]}@${meta.version}`;
    n++;
  }
  return n ? overrides : null;
}

/**
 * The lock to ship for one template, resolved in TWO passes.
 *
 * The first pass is the plain resolve. If it pinned no aliased native, that is
 * the answer. If it did, the second pass re-resolves the same package.json with
 * `overrides` that point each of those positions at the drop-in
 * (`aliasOverrides`), and the lock from THAT pass is what ships.
 *
 * The overrides go in a temp copy of the package.json, never in the template's
 * own — and they do not travel: npm records `overrides` nowhere in the lock it
 * writes (the root entry carries name, version, dependencies, devDependencies
 * and nothing else), so the shipped file is a plain lock whose aliased entries
 * are indistinguishable from ones a user wrote by hand. That is what keeps this
 * out of the template sources, where it would show up in the user's editor as a
 * dependency on a package they did not choose.
 *
 * Measured in the VM against a template that installs from the result: the
 * substituted package is what lands under the native name, `require()` returns
 * it, and the dev server binds. See spike-template-locks.mjs, which re-proves
 * all three for every shipped lock that has an aliased entry.
 */
async function resolveLock(id, packageJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vv-lock-${id}-`));
  const lock = path.join(dir, "package-lock.json");
  const resolve = () =>
    execFileP(
      "npm",
      [
        "install",
        "--package-lock-only",
        "--cpu=wasm32",
        "--os=linux",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `--registry=${REGISTRY}/`,
        "--cache",
        CACHE,
      ],
      { cwd: dir, encoding: "utf8" },
    );
  try {
    fs.writeFileSync(path.join(dir, "package.json"), packageJson);
    await resolve();
    if (!fs.existsSync(lock)) throw new Error("npm wrote no package-lock.json");
    let text = fs.readFileSync(lock, "utf8");

    const overrides = aliasOverrides(text);
    if (overrides) {
      const pkg = JSON.parse(packageJson);
      // Merged under any the template already declares, which stay authoritative:
      // a template that has deliberately pinned something is not overruled here.
      pkg.overrides = { ...overrides, ...(pkg.overrides || {}) };
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
      fs.rmSync(lock, { force: true });
      try {
        await resolve();
      } catch (e) {
        // Either a version the drop-in never published (404) or a direct
        // dependency npm will not let an override redirect (EOVERRIDE) — see
        // aliasOverrides for both. Name the substitution so the failure reads
        // as "this alias is not available" rather than as a resolve error.
        throw Object.assign(new Error(`aliasing ${JSON.stringify(overrides)} failed: ${npmDetail(e)}`), {
          code: "ERR_LOCK_ALIAS_UNRESOLVABLE",
        });
      }
      if (!fs.existsSync(lock)) throw new Error("npm wrote no package-lock.json for the aliased resolve");
      text = fs.readFileSync(lock, "utf8");
    }

    assertPublicRegistry(text);
    assertNoAliasedNatives(text);
    assertPeerProviders(text);
    return text;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
const templates = await loadShippedTemplates();
const selected = templates.filter((t) => !only.size || only.has(t.manifest.id));
if (only.size) {
  const known = new Set(templates.map((t) => t.manifest.id));
  const unknown = [...only].filter((id) => !known.has(id));
  if (unknown.length) {
    console.error(`gen-template-locks: no such template: ${unknown.join(", ")}`);
    process.exit(2);
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
// A run killed between the write and the rename leaves its scratch file behind.
// Nothing reads one — the reuse path looks for `<id>.json` — but `public/` is
// copied into the deploy verbatim, so left alone they would ship.
for (const f of fs.readdirSync(OUT_DIR)) {
  if (f.endsWith(".tmp")) fs.rmSync(path.join(OUT_DIR, f), { force: true });
}
const index = {};
let built = 0;
let reused = 0;
const skipped = [];
// Kept apart from `skipped` on purpose. A template with no package.json is not
// applicable and always will be; a template whose lock was refused HAD one and
// just lost it to something upstream. Counting them together means an incident
// that takes out eighteen templates reads as "40 not applicable" next to
// thirteen Python projects, and the only way to notice is to have kept the
// previous run's number.
const refused = [];
const failed = [];

const queue = [];
for (const t of selected) {
  const id = t.manifest.id;
  const why = eligibility(t);
  if (why) {
    skipped.push(`${id}: ${why}`);
    continue;
  }
  // Eligible but not covered: reported, not built. Naming it keeps the gap
  // visible in the deploy log instead of leaving the difference between 53 and 2
  // to be rediscovered from the manifest.
  if (!all && !only.size && !COVERAGE.includes(id)) {
    skipped.push(`${id}: eligible, not in COVERAGE (no in-VM gate yet)`);
    continue;
  }
  const rel = `vendor/locks/${id}.json`;
  const out = path.join(OUT_DIR, `${id}.json`);
  // Reuse is what makes the warm path 250ms instead of 34s, but it is also the
  // only path that trusts a file this run did not write, and it used to trust it
  // on the strength of the NAME EXISTING. Two ways that goes wrong:
  //
  //   - an interrupted cold run (Ctrl-C on a slow `npm run dev`, which is where
  //     this runs from) leaves a truncated lock, and reusing it publishes a
  //     manifest entry pointing at bytes that do not parse, for every deploy
  //     after that;
  //   - a lock resolved before a guard was tightened keeps shipping under the
  //     old rules, because the guards only ever ran on the resolve path.
  //
  // So the reuse path re-checks. It is a parse and a scan, ~1ms per lock against
  // the 12s a re-resolve costs, and a file that fails is deleted and re-resolved
  // — which routes it through the same loud/quiet handling as any other refusal
  // rather than inventing a second one here.
  if (!force && fs.existsSync(out)) {
    const why = unshippable(out);
    if (!why) {
      index[id] = { asset: rel, bytes: fs.statSync(out).size };
      reused++;
      continue;
    }
    console.log(`  ${id.padEnd(22)} on-disk lock rejected (${why}) — re-resolving`);
    // Unpublished BEFORE it is unlinked, never after. The manifest on disk is
    // the one being served for as long as this run takes, and the run can be
    // killed at any point in it — `predev`, so Ctrl-C during a 60s resolve is
    // the expected input. Deleting first leaves the manifest advertising a file
    // that is gone, and the runtime treats a listed-but-missing lock as a build
    // defect precisely because the merge step is supposed to make it
    // impossible. Pruning first inverts the window into a harmless one: an
    // orphaned file that nothing points at, which the next run re-judges.
    unpublish(INDEX, id);
    fs.rmSync(out, { force: true });
  }
  queue.push({ id, out, rel, packageJson: t.files["package.json"] });
}

// Resolve up to `jobs` templates at once. Each is a separate `npm install
// --package-lock-only` in its own tmpdir against ONE shared cache, and npm's
// cacache is built for concurrent access — it is what npm does to itself.
//
// The win is not CPU, it is that resolution is a long chain of small dependent
// round-trips: one template spends most of its wall clock waiting on a
// registry it has already asked something of. Measured over the 53 eligible
// templates, cold, on this host: 169s at jobs=1.
async function runQueue() {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const job = queue[next++];
      if (!job) return;
      const t0 = Date.now();
      try {
        const lock = await resolveLock(job.id, job.packageJson);
        writeAtomic(job.out, lock);
        index[job.id] = { asset: job.rel, bytes: Buffer.byteLength(lock) };
        built++;
        console.log(
          `  ${job.id.padEnd(22)} ${(Buffer.byteLength(lock) / 1024).toFixed(0).padStart(4)} KiB  ` +
            `${((Date.now() - t0) / 1000).toFixed(1)}s`,
        );
      } catch (e) {
        const detail = npmDetail(e);
        // A tree that pins an aliased native is not a broken build, it is a
        // template that CANNOT have a shippable lock — the answer is the same
        // every time it is resolved, so reporting it as a failure would make
        // `--strict` permanently red for doing the right thing. Unless the id
        // is in COVERAGE, where we said we would ship one and now cannot: that
        // is a contradiction and should be loud.
        if (e.code === "ERR_LOCK_PINS_ALIASED_NATIVE" && !COVERAGE.includes(job.id)) {
          skipped.push(`${job.id}: ${detail}`);
          console.log(`  ${job.id.padEnd(22)} not shippable — ${detail}`);
          continue;
        }
        // A split peer provider is a property of what the registry is serving
        // this hour, not of anything in this repo — the rolldown one appeared
        // when a binding pinned an emnapi prerelease its own dependency
        // excluded, and cleared when the next binding shipped. Nobody here can
        // fix it, so failing would hold the whole deploy hostage to an upstream
        // publish, including for the 40-odd templates that are fine. The
        // template ships without a lock and installs the way it did before,
        // which is also the arm that RECOVERS on its own the moment upstream
        // republishes, where a lock would have frozen the broken tree. Loud in
        // the log and in the summary count, and it names both packages, which
        // is the diagnosis the runtime error does not give.
        if (e.code === "ERR_LOCK_SPLITS_PEER_PROVIDER") {
          refused.push(`${job.id}: ${detail}`);
          console.log(`  ${job.id.padEnd(22)} not shippable — ${detail}`);
          continue;
        }
        // An optimisation asset that cannot be produced must not fail the deploy —
        // a template without one installs exactly the way it does today. `--strict`
        // is for the run that is ABOUT the locks.
        failed.push(`${job.id}: ${detail}`);
        console.log(`  ${job.id.padEnd(22)} FAILED — ${detail}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker));
}
await runQueue();

// Merge rather than overwrite: a run naming specific ids must not delete the
// entries of the templates it was not asked about.
//
// But only for ids that are still SHIPPED. The locks are gitignored build
// output, so an id removed from COVERAGE still has its file sitting in a warm
// vendor directory, and carrying the entry forward on the strength of that file
// existing would keep publishing it — which would make removing a template from
// COVERAGE a no-op for everyone who does not start from a clean checkout. That
// is the opposite of what the list is for, so the stale asset is deleted too.
// A run naming specific ids has no opinion about the rest, so it prunes nothing.
const prunes = !only.size && !all;
let previous = {};
try {
  previous = JSON.parse(fs.readFileSync(INDEX, "utf8"));
} catch {
  /* first run */
}
for (const [id, entry] of Object.entries(previous)) {
  const asset = path.join(OUT_DIR, path.basename(entry.asset || ""));
  if (index[id] || !fs.existsSync(asset)) continue;
  if (!prunes || COVERAGE.includes(id)) {
    index[id] = entry;
    continue;
  }
  fs.rmSync(asset, { force: true });
  console.log(`  ${id.padEnd(22)} dropped — no longer in COVERAGE, stale asset removed`);
}
const wrote = writeOptionalManifest(INDEX, index);

console.log(
  `\ngen-template-locks: ${built} built, ${reused} reused, ${skipped.length} not applicable` +
    `, ${refused.length} refused, ${failed.length} failed` +
    (wrote ? ` → ${path.relative(ROOT, INDEX)} (${Object.keys(index).length} entries)` : " → no manifest written"),
);
for (const s of skipped) console.log(`  (skip) ${s}`);
for (const r of refused) console.log(`  (refused) ${r}`);
for (const f of failed) console.log(`  (fail) ${f}`);

// A refusal is the right outcome and still a bad day: every template in this
// list installed from a lock yesterday and will install from ranges today, and
// the reason is upstream, so it will keep happening until someone republishes.
// The whole point of this branch is that an optimisation which turns itself off
// quietly stays off, so this gets its own paragraph rather than a count in a
// line that also says "13 Python templates have no package.json".
if (refused.length) {
  console.warn(
    `\n${refused.length} template(s) lost their lock to a dependency tree nobody here controls.\n` +
      `They install from ranges until it is republished, which is slower and still correct.\n` +
      `Re-run \`npm run vendor:locks\` once upstream is fixed; nothing needs changing in this repo.`,
  );
}

// No manifest means the feature is off, and it is off SILENTLY — which is the
// failure this whole change exists to stop happening again. So say it loudly.
//
// Loudly, and not fatally. This runs inside `cloudflare-build.sh` under
// `set -euo pipefail`, where a non-zero exit does not disable an optimisation,
// it cancels the deploy of the landing page, the docs, the blog and the studio.
// A lock is a pure optimisation whose absence costs a template the install it
// already does today; trading the whole site for it is never the right ratio.
// The hard failure belongs to `--strict`, which is the invocation whose SUBJECT
// is the locks — a scheduled job, or a human checking their work.
if (!wrote) {
  console.error("gen-template-locks: WARNING — produced NO locks, so no manifest was written.");
  console.error("  Every template will install the way it does today. Re-run with --strict to make this fatal.");
}
// A refusal is fail-soft on the DEPLOY and fatal under `--strict`, which is not
// a contradiction: they are different questions.
//
// The deploy asks "can I ship the site", and the answer must stay yes — a lock
// is an optimisation whose absence costs a template the install it already
// does, and trading the landing page, the docs and the blog for it is never the
// ratio. `--strict` asks "are the locks what we promised", and it is run by the
// jobs whose SUBJECT is the locks. Eighteen ids in COVERAGE quietly not shipping
// one is the answer "no" to that question, and exiting 0 would make the gate
// green for precisely the condition it exists to report — which is this repo's
// oldest bug, not a new one.
//
// It costs nothing in hostage terms, which is the objection this has to answer.
// The guard runs on a FRESH resolve, so a refusal means the split is what npm
// builds from ranges right now; measured on tailwind, the lock arm and the
// lock-free arm produce identical trees and both fail to boot. A refused
// template is therefore already broken with or without a lock, and its own
// spike is already red. Being red HERE too adds no new blockage, only the
// sentence that names the two packages.
//
// Same rule the aliased-native refusal above already follows: not shippable is
// tolerable, not shippable for an id we listed in COVERAGE is a contradiction.
const promised = refused.filter((r) => COVERAGE.includes(r.split(":")[0]));
if (strict && promised.length) {
  console.error(
    `\ngen-template-locks: ${promised.length} template(s) in COVERAGE could not be given a lock.\n` +
      `  Under --strict that is a failure: the list says they ship one and they do not.\n` +
      `  Nothing in this repo can fix it — re-run when the dependency is republished.`,
  );
}
if (strict && (failed.length || promised.length || !wrote)) process.exit(1);
}

// Runnable AND importable: `eligibility` above is a rule about the shipped
// template set, and scripts/spike-install-latency.mjs gates it. Importing a
// script that resolves ~70 lockfiles on load would not be a gate.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installFailSoftHandler("gen-template-locks", strict);
  await main();
}