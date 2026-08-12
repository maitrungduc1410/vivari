// Build the prebuilt node_modules snapshots the studio ships, so a template's
// first run RESTORES its dependency tree instead of installing it.
//
//   node scripts/gen-depcache.mjs                # the default coverage set
//   node scripts/gen-depcache.mjs react-ts       # just these ids
//   node scripts/gen-depcache.mjs --force        # rebuild an existing asset
//   node scripts/gen-depcache.mjs --list         # what would be built, and why
//   node scripts/gen-depcache.mjs --strict       # a template that fails is an ERROR
//
// `--strict` is the one mode that exits non-zero for a build failure. Without it
// this always exits 0, because the deploy runs it: see the note above the strict
// check at the bottom for why a snapshot must never be able to cancel a deploy.
//
// THIS IS THE PRODUCER THAT DID NOT EXIST. The consumer side has been complete
// and hardened for a while — kernel-worker.ts fetches `vendor/depcache/index.json`,
// looks the project's dep-cache key up in it, downloads the asset and hands it to
// the store, which validates every entry before unpacking it. Nothing ever wrote
// that manifest. In production the fetch returned the SPA's index.html with a
// 200, `JSON.parse` threw, the catch set the manifest to null, and the feature
// turned itself off in silence. Coverage was 0 of ~70 templates and every user
// paid a full cold install.
//
// HOW THE KEY IS DERIVED. It has to be the byte-for-byte key the browser will
// compute, or the asset is dead weight: `hashDepKey(pm, <file bytes>, <source>)`
// over the project's lockfile (see computeDepKey in kernel-worker.ts). So the
// install here runs from the SAME resolved lock that gen-template-locks.mjs
// produced and that the kernel writes into the project at create time — which is
// the other reason A1 comes first. The package.json-hash key is registered as a
// second entry pointing at the same asset, so a project whose lock did not
// arrive (asset not served, fetch timed out) still hits.
//
// WHY COVERAGE IS AN ALLOWLIST AND NOT "EVERY TEMPLATE". Hosting bytes are a
// real product cost, not a free win: react-ts is 59.8 MiB raw and next-ts is
// 252.7 MiB, and ~8 popular templates would be 120-200 MB of static assets.
// react-ts is the cheapest and is also the case users report as slow, so it is
// where this starts. Widening it is a deliberate decision with a bill attached,
// which is why it is a list you have to edit rather than a default that grows.
//
// WHY A LIFECYCLE SCRIPT DISQUALIFIES A TEMPLATE. A restore is a REPLACEMENT for
// running the package manager: on a hit, `VV_RUN` is the dev command with no
// `install &&` prefix and npm is never spawned. So anything an install script
// would have done does not happen. Shipping a snapshot for such a template would
// silently drop that effect, which is why this refuses rather than warns. It is
// what currently excludes next-ts, whose postinstall seeds Next's wasm SWC cache.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { createDepCache, hashDepKey, readSnapshotContainer, writeSnapshotContainer } from "../packages/kernel-host/dep-cache.js";
import { hostAccess, memoryStorage } from "./lib/host-vfs-access.mjs";
import { loadShippedTemplates } from "./lib/shipped-templates.mjs";
import {
  REGISTRY,
  assertPeerProviders,
  assertPublicRegistry,
  installFailSoftHandler,
  writeAtomic,
  writeOptionalManifest,
} from "./gen-template-locks.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_DIR = path.join(ROOT, "packages/studio/public/vendor/locks");
const OUT_DIR = path.join(ROOT, "packages/studio/public/vendor/depcache");
const INDEX = path.join(OUT_DIR, "index.json");
const CACHE = path.join(os.tmpdir(), "vv-gen-depcache-cache");

// The templates whose snapshot is worth its hosting bytes. See the header before
// adding one, and record the measured size in the comment beside it.
const COVERAGE = [
  // 2,831 entries / 74.8 MB raw / 16.0 MB gzipped, from a 90-package lock —
  // which is why it is not the cheap case it looks like, and why the "even a
  // plain React TS project feels slow" report is about this template.
  //
  // Re-measured after the aliased resolve: the lock now pins lightningcss-wasm,
  // which carries a 3 MB lightningcss_node.wasm where the native package it
  // replaced carried a binary for a platform this tree never had. The snapshot
  // is ~3.5 MB of hosting bigger for it. That is the price of the substitution
  // and it is worth naming, because the paragraph above about hosting bytes is
  // the argument for keeping COVERAGE short.
  "react-ts",
];

const args = process.argv.slice(2);
const force = args.includes("--force");
const list = args.includes("--list");
const strict = args.includes("--strict");
const only = args.filter((a) => !a.startsWith("--"));
const wanted = only.length ? only : COVERAGE;

/**
 * Packages in the INSTALLED tree that npm would have run an install script for.
 *
 * Read from `node_modules/.package-lock.json` — the tree npm actually built —
 * and not from the project lockfile, which lists every platform's variant of
 * every optional dependency. react-ts's lock carries `fsevents`, whose install
 * script is a node-gyp rebuild; it is darwin-only and is in no tree this ever
 * packs, so gating on the project lock refused a template that has nothing to
 * lose. Ask what was installed, not what could be.
 */
function installScriptPackages(dir) {
  let tree;
  try {
    tree = JSON.parse(fs.readFileSync(path.join(dir, "node_modules/.package-lock.json"), "utf8"));
  } catch (e) {
    throw new Error(`could not read the installed tree (node_modules/.package-lock.json): ${e.message}`);
  }
  return Object.entries(tree.packages || {})
    .filter(([name, meta]) => name && meta && meta.hasInstallScript)
    .map(([name]) => name.replace(/^node_modules\//, ""));
}

/** The shipped lock's bytes, or null when this template has none built yet. */
function shippedLock(id) {
  const at = path.join(LOCK_DIR, `${id}.json`);
  return fs.existsSync(at) ? fs.readFileSync(at, "utf8") : null;
}

/**
 * The keys the BROWSER will look this template up under: the lock's bytes, and
 * package.json's as the fallback for a project whose lock did not arrive. Same
 * inputs as `buildOne` records, so the two cannot drift.
 *
 * Takes the BYTES rather than an id to read them by. The keys are a pure
 * function of the bytes, and a version of this that opened the file itself
 * could only be exercised where the file already existed — which is every
 * developer's tree and no clean checkout, so the gate over it passed here and
 * was vacuous in CI.
 */
async function reachKeys(packageJson, lockText) {
  if (lockText == null) return null;
  const enc = new TextEncoder();
  return [
    await hashDepKey("npm", enc.encode(lockText), "package-lock.json"),
    await hashDepKey("npm", enc.encode(packageJson), "package.json"),
  ];
}

/**
 * Why the snapshot already on disk cannot be reused, or null if it can.
 *
 * Existence is not the question, REACHABILITY is. The browser finds a snapshot
 * by hashing the project's lockfile (`computeDepKey` in kernel-worker.ts) and
 * looking that key up in this index, so an asset indexed under a key computed
 * over DIFFERENT lock bytes is not a cache — it is 12 MB of unreachable payload
 * and a full cold install for every user, with nothing in any log to say so.
 * That is the worst shape a failure can have here, and it is why this is
 * checked rather than assumed.
 *
 * Lock bytes move for ordinary reasons: a re-resolve picks up a newer
 * transitive version, and the aliased second pass in gen-template-locks.mjs
 * rewrote 27 locks at once. `public/vendor/` meanwhile survives between builds
 * on every machine that is not a fresh clone — `predev` runs this on every
 * `npm run dev`. Reusing on "the .bin exists and the index mentions it"
 * therefore keeps a snapshot alive long after the lock it was packed from is
 * gone, which is exactly what happened to react-ts here.
 *
 * The sibling producer already learned this rule: `unshippable` in
 * gen-template-locks.mjs re-validates a reused lock instead of trusting its
 * filename. This is the same rule, for the same reason, one artifact along.
 *
 * BOTH inputs this reads off disk are injectable, and they travel together in
 * one bag so that adding a third cannot quietly stay implicit. An earlier
 * version threaded only `out`, leaving the lock to be re-read from `LOCK_DIR`;
 * the gate then supplied a synthesised lock, computed the fixture's keys from
 * it, and this function keyed itself off a different file. On a developer's
 * tree that file existed and the two happened to agree, so six assertions read
 * as if they proved something. On a clean checkout the file is absent, every
 * call returned "no shipped lock to key it against" before reaching any of the
 * behaviour named, and CI failed all six. `main` passes neither, so the default
 * path — the production one — is what the gate exercises.
 */
export async function unreachable(
  id,
  packageJson,
  index,
  { out = path.join(OUT_DIR, `${id}.bin`), lockText = shippedLock(id) } = {},
) {
  const asset = `vendor/depcache/${id}.bin`;
  const keys = await reachKeys(packageJson, lockText);
  if (!keys) return "no shipped lock to key it against";
  for (const key of keys) {
    const entry = index[key];
    if (!entry) return `the shipped ${key.split(":")[1]} hashes to a key the index does not carry`;
    if (entry.asset !== asset) return `the index points that key at ${entry.asset}`;
  }
  // The keys decide whether anything ever LOOKS this snapshot up. They say
  // nothing about whether what it finds is a snapshot, and "the file exists" is
  // the assumption that has now been wrong twice on this branch. Two ways an
  // asset with perfectly good keys is not usable, both reachable here because
  // `public/vendor/` is build output that survives whatever happened last time:
  //
  //   - truncated, from a run killed mid-write (`predev`, so Ctrl-C on
  //     `npm run dev` does it). The index records the length it MEANT to write,
  //     so the discrepancy is already on disk waiting to be compared.
  //   - not a snapshot at all. `readSnapshotContainer`'s own docstring names the
  //     case: an SPA index.html served with a 200 in place of a missing asset,
  //     which is how this feature turned itself off silently once already.
  //
  // A prefix is enough for the frame — the header is a short JSON object at the
  // front — so this stays O(1) rather than reading 16 MB to look at 100 bytes.
  // `main` only asks about an asset it has just seen, but this is exported and
  // gated directly, and a clean checkout has no `public/vendor/` at all.
  if (!fs.existsSync(out)) return "there is no asset on disk";
  const size = fs.statSync(out).size;
  const promised = index[keys[0]].bytes;
  if (promised && size !== promised) return `the asset is ${size} B where the index promises ${promised}`;
  const fd = fs.openSync(out, "r");
  try {
    const head = Buffer.alloc(Math.min(4096, size));
    fs.readSync(fd, head, 0, head.length, 0);
    if (!readSnapshotContainer(new Uint8Array(head))) return "the asset is not a snapshot container";
  } finally {
    fs.closeSync(fd);
  }
  return null;
}

async function buildOne(template) {
  const id = template.manifest.id;
  const packageJson = template.files["package.json"];
  if (!packageJson) throw new Error("template ships no package.json");
  const lockPath = path.join(LOCK_DIR, `${id}.json`);
  if (!fs.existsSync(lockPath)) {
    throw new Error(`no resolved lockfile — run \`npm run vendor:locks -- ${id}\` first`);
  }
  const lockText = fs.readFileSync(lockPath, "utf8");
  // The lock on disk may predate the check that added this, or have been built
  // on a host behind a mirror. Refuse rather than pack a snapshot whose key
  // belongs to a lock no user can install from.
  assertPublicRegistry(lockText);
  // And the same for a split peer provider, which matters more here than one
  // artifact back: a restore skips npm entirely, so a snapshot packed from that
  // tree hands the broken copies straight to the user with nothing left to
  // re-resolve them. `public/vendor/` survives between builds, so the lock this
  // reads can predate the guard that would have refused it.
  assertPeerProviders(lockText);

  // The template's OWN install hooks, checked before the install because they
  // need no tree to see. A restore skips npm, so these would never run.
  const ownScripts = JSON.parse(packageJson).scripts || {};
  const ownInstallHooks = ["preinstall", "install", "postinstall"].filter((k) => ownScripts[k]);
  if (ownInstallHooks.length) {
    throw new Error(`the template's package.json declares ${ownInstallHooks.join("/")}; a restore skips npm`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vv-depcache-${id}-`));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), packageJson);
    fs.writeFileSync(path.join(dir, "package-lock.json"), lockText);
    execFileSync(
      "npm",
      [
        "install",
        "--cpu=wasm32",
        "--os=linux",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `--registry=${REGISTRY}/`,
        "--cache",
        CACHE,
      ],
      { cwd: dir, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
    );
    const withScripts = installScriptPackages(dir);
    if (withScripts.length) {
      throw new Error(
        `${withScripts.length} installed package(s) declare an install script (${withScripts.slice(0, 4).join(", ")}` +
          `${withScripts.length > 4 ? ", …" : ""}); a restore skips npm, so their effect would be lost`,
      );
    }
    // npm rewrites the lock during install (it fills in what a --package-lock-only
    // pass left out). The key must be over the bytes the BROWSER will have, which
    // are the ones the kernel writes at create time, so restore the file we shipped
    // before anything hashes it.
    fs.writeFileSync(path.join(dir, "package-lock.json"), lockText);

    const storage = memoryStorage();
    const store = await createDepCache({ access: hostAccess, storage });
    const lockKey = await hashDepKey("npm", new TextEncoder().encode(lockText), "package-lock.json");
    const saved = await store.save(lockKey, dir);
    if (!saved) throw new Error("pack produced nothing — is node_modules missing?");
    const archive = storage.blobs.get(lockKey);

    const compressed = zlib.gzipSync(archive, { level: 9 });
    const asset = writeSnapshotContainer("gz", compressed, {
      id,
      entries: saved.entries,
      files: saved.files,
      raw: archive.length,
    });
    const pjKey = await hashDepKey("npm", new TextEncoder().encode(packageJson), "package.json");
    return { id, asset, keys: [lockKey, pjKey], ...saved, compressed: asset.length };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
const templates = await loadShippedTemplates();
const byId = new Map(templates.map((t) => [t.manifest.id, t]));
const unknown = wanted.filter((id) => !byId.has(id));
if (unknown.length) {
  console.error(`gen-depcache: no such template: ${unknown.join(", ")}`);
  process.exit(2);
}

if (list) {
  for (const id of wanted) console.log(`  ${id}`);
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
// A run killed between the write and the rename leaves its scratch file behind.
// Nothing reads one, but `public/` is copied into the deploy verbatim, so left
// alone a 16 MB orphan ships. Same sweep the lock producer does.
for (const f of fs.readdirSync(OUT_DIR)) {
  if (f.endsWith(".tmp")) fs.rmSync(path.join(OUT_DIR, f), { force: true });
}
let index = {};
try {
  index = JSON.parse(fs.readFileSync(INDEX, "utf8"));
} catch {
  /* first run */
}

const failed = [];
for (const id of wanted) {
  const out = path.join(OUT_DIR, `${id}.bin`);
  if (!force && fs.existsSync(out)) {
    const why = await unreachable(id, byId.get(id).files["package.json"], index);
    if (!why) {
      console.log(`  ${id.padEnd(16)} reused (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
      continue;
    }
    // Loud, because a silently unreachable snapshot is indistinguishable from a
    // working one and costs every user a cold install. Repacking is a ~60 MB
    // install, so say why it is happening.
    console.log(`  ${id.padEnd(16)} on-disk snapshot unreachable (${why}) — repacking`);
  }
  const t0 = Date.now();
  try {
    const res = await buildOne(byId.get(id));
    // Atomic for the same reason the lock producer is: this writes 16 MB from
    // `predev`, and a run killed partway leaves a truncated asset whose index
    // keys are still the right ones. Rename or nothing.
    writeAtomic(out, res.asset);
    // Drop this template's PREVIOUS keys before recording the new ones. The
    // index is merged rather than overwritten so a run naming one id keeps the
    // others, but that also means a rebuilt asset would stay reachable under the
    // key of the lock it no longer contains: a project created from the old lock
    // would restore the new tree, and because a restore hit means npm never
    // runs, nothing would reconcile the two. Observed for real when the react-ts
    // lock was re-resolved off a mirror and the index kept both keys.
    for (const [key, entry] of Object.entries(index)) if (entry && entry.template === id) delete index[key];
    for (const key of res.keys) {
      index[key] = {
        asset: `vendor/depcache/${id}.bin`,
        bytes: res.compressed,
        entries: res.entries,
        template: id,
      };
    }
    console.log(
      `  ${id.padEnd(16)} ${res.entries.toLocaleString()} entries, ` +
        `${(res.bytes / 1048576).toFixed(1)} MB raw → ${(res.compressed / 1048576).toFixed(1)} MB gz, ` +
        `${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
  } catch (e) {
    // Same posture as gen-template-locks: a missing snapshot is a slower first
    // run, not a broken site, so it must not fail the deploy.
    failed.push(`${id}: ${e.message}`);
    console.log(`  ${id.padEnd(16)} SKIPPED — ${e.message}`);
  }
}

const wrote = writeOptionalManifest(INDEX, index);
console.log(
  `\ngen-depcache: ${Object.keys(index).length} key(s)` +
    (wrote ? ` → ${path.relative(ROOT, INDEX)}` : " → no manifest written"),
);
for (const f of failed) console.log(`  (skip) ${f}`);

// No manifest turns the feature off silently, so it is worth shouting about —
// but NOT worth exiting non-zero for on the deploy path. This runs
// inside `cloudflare-build.sh` under `set -euo pipefail` with a COVERAGE of one
// template, so any single failed `react-ts` install would abort the deploy of
// the landing page, the docs, the blog and the studio. Two of those failures are
// routine rather than exotic: a registry flake partway through a 60 MB install,
// and a transitive package gaining an install script — the case `buildOne` is
// deliberately written to REFUSE. A guard against quietly losing an optimisation
// must not become a way to take the site offline for choosing correctly.
//
// `--strict` is the invocation whose subject IS the snapshots, and it is also
// stricter than this check: there, a template that was asked for and did not
// build is a failure even if others succeeded.
if (!wrote) {
  console.error("gen-depcache: WARNING — produced NO snapshots, so no manifest was written.");
  console.error("  Every project will install normally. Re-run with --strict to make this fatal.");
}
if (strict && (failed.length || !wrote)) process.exit(1);
}

// Runnable AND importable, for the same reason the sibling producer is: the
// rule that decides whether a snapshot may be reused (`unreachable`) is the one
// that just failed silently, and a spike cannot gate it by reading the source.
// Importing a script that installs 60 MB on load would not be a gate either.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installFailSoftHandler("gen-depcache", strict);
  await main();
}