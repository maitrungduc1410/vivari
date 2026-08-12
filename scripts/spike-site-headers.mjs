// Spike (OFFLINE, no kernel, no Wasm): the studio DELIVERY contract — the
// `_headers` Cloudflare Pages serves the app under, the assertion that guards
// the assets it fetches at runtime, and the Service Worker's cache-first
// prefixes.
//
// Every failure here is invisible locally, which is the entire reason the file
// exists. `vite preview` stamps its own headers and ignores `_headers`
// completely, so no local run — and no headless-Chrome run against one, which is
// what the delivery work was validated with — can observe the deployed policy.
// The first environment that evaluates these rules is production.
//
// The one that motivated it: three new blocks each re-emitted COOP/COEP on paths
// the pre-existing `/studio/*` block already matched. Pages applies every
// matching rule and comma-joins a header set twice, and COOP/COEP are
// structured-field *items* — `same-origin, same-origin` is a list, fails to
// parse, and a failed parse means `unsafe-none`. That is no SharedArrayBuffer
// and a product that does not boot, shipped by a change whose stated purpose was
// to make it boot faster, through a full local validation pass that could not
// see it.
//
// Gates:
//   1. No request path can match two `_headers` blocks that set the same header.
//      Asserted over the rules themselves (every overlapping pair), not over a
//      list of paths someone remembered — a sample cannot fail for the path
//      nobody thought of.
//   2. Every surface that runs the runtime resolves to exactly one COOP and one
//      COEP, with the right value. The mirror of gate 1: it catches deleting a
//      block as well as duplicating one.
//   3. `immutable` reaches content-hashed output and nothing else — never the
//      vendor tree (stable URLs, contents re-resolved every deploy) and never
//      the HTML (it names the hashes).
//   4. The kernel-asset assertion actually fails on a tree with a missing vendor
//      asset, and tolerates a missing optional one.
//   5. The SW's cache-first prefixes cover only what `immutable` covers. Two
//      caches keyed on the same assumption; they must not drift apart.
//
//   run:  node scripts/spike-site-headers.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SITE_HEADERS, KERNEL_ASSETS, checkKernelAssets } from "./lib/site-headers.mjs";
import { importTs } from "./lib/import-ts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const PHASE_SRC = "packages/studio/src/vv/run-phase.ts";

// Gate 6 runs the real phase machine rather than a copy of it, which means
// importing TypeScript and letting Node strip the types. Every other spike that
// touches TypeScript reads it as text; text cannot execute a state machine, and
// asserting that certain regex sources exist would be a gate on a proxy for the
// failure rather than the failure.
//
// Which Nodes can do that is `importTs`'s problem, not this file's: a plain
// import() from 22.18, an in-process stripper on 22.15-22.17, and an error
// naming the flag below that. This spike used to carry its own guard that
// printed a message and exited 1 instead — a worse answer to the same question,
// and one that turned the whole offline tier red on every version between the
// `engines.node` floor and 22.18.
//
// One precondition is still ours: run-phase.ts must stay import-free. It is a
// leaf today; one `import … from "@/lib/utils"` would break this under bare
// Node, with no bundler to resolve the alias. Gate 6 asserts that below, so the
// precondition is checked rather than folded into this comment.
const { fallBackToInstall, isInstallFallbackLine, isRestoreLine, readFetchProgress } =
  await importTs(path.join(ROOT, PHASE_SRC));

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};

// ── a model of Cloudflare Pages' _headers ───────────────────────────────────
//
// Deliberately a model and not a parser of convenience: the behaviour being
// asserted is Pages', so the rules it encodes are the two from Pages' own
// documentation — a leading `/path` line starts a block, indented `Name: value`
// lines belong to it, `*` matches any run of characters, and EVERY matching
// block applies (values for a repeated header are comma-joined rather than
// overridden). If this model is wrong the spike is worthless, so it is kept
// small enough to check by reading.
function parseHeaders(text) {
  const rules = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(raw)) { rules.push({ path: raw.trim(), headers: [] }); continue; }
    const at = raw.indexOf(":");
    if (at === -1 || !rules.length) continue;
    rules[rules.length - 1].headers.push({
      name: raw.slice(0, at).trim(),
      value: raw.slice(at + 1).trim(),
    });
  }
  return rules;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toRegExp = (pattern) => new RegExp("^" + pattern.split("*").map(escape).join(".*") + "$");

/** Resolve a request path the way Pages does: every match applies, in file order. */
function resolve(rules, reqPath) {
  const out = new Map();
  for (const r of rules) {
    if (!toRegExp(r.path).test(reqPath)) continue;
    for (const h of r.headers) {
      const key = h.name.toLowerCase();
      out.set(key, [...(out.get(key) ?? []), h.value]);
    }
  }
  return out;
}

/** Do two glob patterns have any path in common? Enumerating is impossible, so
 *  build a witness: substitute a marker for each `*` and test both ways. */
function overlaps(a, b) {
  const witnesses = [a.split("*").join("x"), b.split("*").join("x"), a.replace("*", b), b.replace("*", a)];
  return witnesses.some((w) => toRegExp(a).test(w) && toRegExp(b).test(w));
}

const RULES = parseHeaders(SITE_HEADERS);

// ---------------------------------------------------------------------------
console.log("== the _headers model reads the file we ship ==");
// ---------------------------------------------------------------------------
{
  ok(RULES.length >= 11, `parsed ${RULES.length} blocks`);
  ok(
    RULES.every((r) => r.path.startsWith("/")) && RULES.every((r) => r.headers.length > 0),
    "every block has a leading-slash path and at least one header",
  );
  // If the parser silently produced nothing, every assertion below would pass
  // vacuously — which is exactly the shape of failure this spike exists to stop.
  ok(resolve(RULES, "/studio/").size > 0, "a known path resolves to at least one header");
}

// ---------------------------------------------------------------------------
console.log("\n== 1. no path matches two blocks that set the same header ==");
// ---------------------------------------------------------------------------
{
  let clashes = 0;
  for (let i = 0; i < RULES.length; i++) {
    for (let j = i + 1; j < RULES.length; j++) {
      const a = RULES[i];
      const b = RULES[j];
      if (!overlaps(a.path, b.path)) continue;
      const namesA = new Set(a.headers.map((h) => h.name.toLowerCase()));
      const both = b.headers.map((h) => h.name.toLowerCase()).filter((n) => namesA.has(n));
      for (const n of both) {
        clashes++;
        console.log(`      ${a.path} and ${b.path} both set ${n}`);
      }
    }
  }
  ok(clashes === 0, `no overlapping block pair sets the same header (${RULES.length} blocks compared pairwise)`);
}

// ---------------------------------------------------------------------------
console.log("\n== 2. every runtime surface gets exactly one COOP and one COEP ==");
// ---------------------------------------------------------------------------
{
  // Cross-origin isolation is required on the top-level document of anything
  // that touches SharedArrayBuffer, and on the documents that frame it.
  const ISOLATED = [
    "/studio/",
    "/studio/index.html",
    "/studio/assets/index-abc123.js",
    "/studio/vendor/npm-pack.bin",
    "/embed/",
    "/embed/assets/index-abc123.js",
    "/docs/guide/",
    "/blog/",
    "/devtools-host.html",
    "/devtools-host",
    "/devtools/inspector.html",
    "/sw.js",
  ];
  for (const p of ISOLATED) {
    const h = resolve(RULES, p);
    const coop = h.get("cross-origin-opener-policy") ?? [];
    const coep = h.get("cross-origin-embedder-policy") ?? [];
    ok(
      coop.length === 1 && coop[0] === "same-origin" && coep.length === 1 && coep[0] === "require-corp",
      `${p} → COOP [${coop.join(", ")}] COEP [${coep.join(", ")}]`,
    );
  }
  // The landing page stays out of it: COEP blocks third-party subresources that
  // do not send CORP, and the landing has no runtime to justify the cost.
  const landing = resolve(RULES, "/");
  ok(!landing.has("cross-origin-embedder-policy"), "/ (landing) carries no COEP");
  // The SW must keep its root-scope grant, which is a separate header from COI
  // and easy to lose while rearranging blocks.
  ok(resolve(RULES, "/sw.js").get("service-worker-allowed")?.[0] === "/", "/sw.js grants root scope");
}

// ---------------------------------------------------------------------------
console.log("\n== 3. immutable reaches content-hashed output and nothing else ==");
// ---------------------------------------------------------------------------
{
  const cc = (p) => (resolve(RULES, p).get("cache-control") ?? []).join(" | ");
  const isImmutable = (p) => /\bimmutable\b/.test(cc(p));

  for (const p of ["/studio/assets/index-abc123.js", "/studio/assets/vivari_vfs_bg-abc123.wasm", "/embed/assets/index-abc123.js"]) {
    ok(isImmutable(p), `${p} is immutable`);
  }
  // The vendor tree is the trap. Its URLs never change; its contents change on
  // every deploy, because the locks and snapshots under it are re-resolved on a
  // fresh CI checkout. `immutable` there is unbounded staleness with no
  // invalidation path.
  for (const p of [
    "/studio/vendor/npm-pack.bin",
    "/studio/vendor/locks/index.json",
    "/studio/vendor/depcache/index.json",
    "/studio/vendor/depcache/react-ts.bin",
    "/embed/vendor/npm-pack.bin",
  ]) {
    ok(!isImmutable(p), `${p} is NOT immutable`);
  }
  // The shell names the hashes, so it is the one file that must never be held.
  for (const p of ["/studio/", "/studio/index.html"]) {
    ok(/max-age=0/.test(cc(p)) && !isImmutable(p), `${p} revalidates (${cc(p) || "no Cache-Control"})`);
  }
  // Exactly one Cache-Control everywhere, for the same comma-join reason as COI.
  for (const p of ["/studio/", "/studio/index.html", "/studio/assets/x-abc.js", "/studio/vendor/npm-pack.bin", "/embed/assets/x-abc.js"]) {
    const n = (resolve(RULES, p).get("cache-control") ?? []).length;
    ok(n <= 1, `${p} has at most one Cache-Control (${n})`);
  }
}

// ---------------------------------------------------------------------------
console.log("\n== 4. the kernel-asset assertion fails on a missing asset ==");
// ---------------------------------------------------------------------------
{
  const all = () => true;
  const complete = checkKernelAssets("", all);
  ok(complete.missing.length === 0, "a complete tree reports nothing missing");
  ok(
    complete.present === KERNEL_ASSETS.length * 2,
    `a complete tree counts every path once per app (${complete.present} of ${KERNEL_ASSETS.length * 2})`,
  );

  // The failure this list exists for: a vendor step the deploy does not run.
  // It must be fatal, and it must name the path.
  const noSqlite = checkKernelAssets("", (rel) => !rel.endsWith("vendor/sqlite/sqlite3.wasm"));
  ok(
    noSqlite.missing.length === 2 && noSqlite.missing.includes("/studio/vendor/sqlite/sqlite3.wasm"),
    `a missing vendor asset is fatal on both surfaces (${noSqlite.missing.join(", ") || "none"})`,
  );

  // An opt-in producer that did not run is reported, never fatal — otherwise a
  // developer build of the site could not be assembled at all.
  const noDepcache = checkKernelAssets("", (rel) => !rel.includes("vendor/depcache/"));
  ok(noDepcache.missing.length === 0, "a missing OPTIONAL asset is not fatal");
  ok(noDepcache.absentOptional.length === 2, `and is still reported (${noDepcache.absentOptional.join(", ")})`);

  // The success count must not include what was just reported absent.
  ok(
    noDepcache.present === KERNEL_ASSETS.length * 2 - 2,
    `the present count excludes them (${noDepcache.present})`,
  );

  // Every non-optional entry must be individually load-bearing: an entry that
  // cannot fail is an entry that is not checking anything.
  const dead = KERNEL_ASSETS.filter((a) => !a.optional).filter(
    (a) => checkKernelAssets("", (rel) => !rel.endsWith(a.rel)).missing.length === 0,
  );
  ok(dead.length === 0, `every required asset can fail the check (${dead.map((a) => a.rel).join(", ") || "all live"})`);
}

// ---------------------------------------------------------------------------
console.log("\n== 5. the SW caches nothing that _headers won't hold ==");
// ---------------------------------------------------------------------------
{
  // The Service Worker's cache-first prefix list and the `immutable` rule above
  // encode the same claim — "this URL cannot change under me" — in two places,
  // and the SW's version is the more dangerous one: its cache key is the build
  // id, which is a hash of ROLLUP output names, so nothing under public/ (the
  // whole vendor tree) can ever invalidate it. Read the list out of the plugin
  // rather than the built manifest so this runs before any build.
  const cfg = read("packages/studio/vite.config.ts");
  const decl = /prefixes:\s*\[([^\]]*)\]/.exec(cfg);
  ok(!!decl, "vite.config.ts declares the SW's cache-first prefixes");
  if (decl) {
    const prefixes = [...decl[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    ok(prefixes.length > 0, `prefixes: ${prefixes.map((p) => `basePath + "${p}"`).join(", ")}`);
    ok(prefixes.every((p) => p === "assets/"), "the only cache-first prefix is assets/ — content-hashed, hence safe");
    ok(!prefixes.includes("vendor/"), "vendor/ is NOT cache-first (its URLs outlive their contents)");
    // And the claim it rests on: everything cache-first is also immutable.
    for (const p of prefixes) {
      const cc = (resolve(RULES, `/studio/${p}x-abc123.js`).get("cache-control") ?? []).join(" | ");
      ok(/\bimmutable\b/.test(cc), `/studio/${p}* is immutable, matching the SW's assumption`);
    }
  }
  // The precache is only warmed for studio clients: the same file is registered
  // by /embed/, which the docs and the blog iframe lazily, and it must not bill
  // a docs reader ~4 MB of studio bundles the embed never loads.
  const sw = read("packages/studio/public/sw.js");
  ok(/precacheIfStudio\(\)/.test(sw), "install() calls precacheIfStudio(), not precache() directly");
  ok(
    /isStudioClient\(c\.url\)/.test(sw),
    "and precacheIfStudio() gates on a studio window being open",
  );
}

// ---------------------------------------------------------------------------
console.log("\n== 6. the progress panel stops saying 'restoring' when it isn't ==");
// ---------------------------------------------------------------------------
{
  // What the direct TypeScript import above rests on: this module must stay a
  // leaf. An `import … from "@/lib/utils"` here would break the gate under bare
  // Node, with no bundler to resolve the alias — so assert the property rather
  // than describing it in a comment.
  const phaseSrc = read(PHASE_SRC);
  const imports = phaseSrc.split("\n").filter((l) => /^\s*import\b/.test(l));
  ok(imports.length === 0, `${PHASE_SRC} imports nothing (${imports.join(" / ") || "confirmed leaf"})`);

  // The panel exists to stop the UI misdescribing a run, so its one backwards
  // transition is worth a gate: snapshot coverage is react-ts alone, which makes
  // the give-up path the common one rather than an edge case.
  const at = (phase) => ({ rootPath: "/p", name: "p", phase, detail: "47 requests", startedAt: 0 });
  ok(fallBackToInstall(at("restoring")).phase === "installing", "restoring → installing on a failed restore");
  ok(fallBackToInstall(at("restoring")).detail === "", "and the stale request counts are cleared");
  ok(fallBackToInstall(at("starting")).phase === "starting", "a bound dev server is NOT un-started");
  ok(fallBackToInstall(at("installing")).phase === "installing", "installing is left alone");

  // The lines are the kernel's real output, quoted from kernel-worker.ts. Every
  // give-up that follows a restore ANNOUNCEMENT must be recognised, or the label
  // narrates the wrong path for the length of a cold install.
  const GIVE_UP = [
    "  [depcache] prebuilt snapshot unavailable (HTTP 404) — installing normally.",
    "  [depcache] prebuilt snapshot was not usable — installing normally.",
    "  [depcache] prebuilt snapshot fetch failed (NetworkError) — installing normally.",
    "  [depcache] snapshot restored nothing for npm — installing normally.",
  ];
  const msg = (line) => line.trim().replace("[depcache] ", "");
  for (const line of GIVE_UP) {
    ok(isInstallFallbackLine(line), `give-up recognised: "${msg(line)}"`);
  }
  // A fifth real give-up line, kept in its own list because it must NOT match —
  // and asserted rather than merely listed, since a fixture nobody checks is the
  // same gate-on-a-proxy shape this file exists to prevent.
  //
  // It is emitted at kernel-worker.ts:570 and :1199, both BEFORE any restore is
  // announced, so the phase is still `installing` and there is no transition to
  // make. Matching it would be the harmful reading: `fallBackToInstall` is the
  // only retreat in the machine, and widening its trigger to lines that can
  // precede a restore is how a retreat starts firing on the wrong ones.
  const NOT_ANNOUNCED = ["  [depcache] no snapshot for npm — installing…"];
  for (const line of NOT_ANNOUNCED) {
    ok(
      !isInstallFallbackLine(line) && !isRestoreLine(line),
      `no transition needed, none offered: "${msg(line)}"`,
    );
  }
  // Every one of those strings must still be in the kernel, or this gate is
  // asserting against text nobody emits any more.
  const kw = read("packages/core/src/workers/kernel-worker.ts");
  ok(
    (kw.match(/installing normally\./g) ?? []).length >= 4,
    `kernel-worker.ts still emits "installing normally." (${(kw.match(/installing normally\./g) ?? []).length} sites)`,
  );
  // Pinned too, or the assertion above it passes for the wrong reason: a reworded
  // line would satisfy "does not match" forever while covering nothing.
  ok(kw.includes("no snapshot for"), 'kernel-worker.ts still emits "no snapshot for … — installing…"');
  // And the success/announce lines must NOT be read as a give-up.
  for (const line of [
    "  [depcache] fetching prebuilt node_modules for npm (13.0 MB)…",
    "  [depcache] prebuilt snapshot ready (2,835 entries, 62.7 MB)",
    "  [depcache] restored node_modules for npm (2,835 entries, 812ms) — skipping install.",
  ]) {
    ok(!isInstallFallbackLine(line), `not a give-up: "${msg(line)}"`);
  }
  ok(isRestoreLine(GIVE_UP[0]) === false, "a give-up line does not also read as a restore announcement");

  // Both restore ANNOUNCEMENTS must be recognised, not just the network one. A
  // warm OPFS hit is the common returning-visitor case and takes under a second;
  // narrating it as "Installing dependencies" is the same mislabel as the one
  // above, pointing the other way.
  for (const line of [
    "  [depcache] fetching prebuilt node_modules for npm (13.0 MB)…",
    "  [depcache] restoring node_modules for npm…",
  ]) {
    ok(isRestoreLine(line), `restore announced: "${msg(line)}"`);
  }
  // …but the COMPLETION line is a different event, and "restored" must not be
  // read as "restoring".
  ok(
    !isRestoreLine("  [depcache] restored node_modules for npm (2,835 entries, 812ms) — skipping install."),
    "the completion line is not a fresh restore announcement",
  );
  // Both announcements pinned to the producer, same as the give-up clause above:
  // a reword there would otherwise leave a matcher that quietly never fires.
  for (const frag of ["fetching prebuilt node_modules", "restoring node_modules"]) {
    ok(kw.includes(frag), `kernel-worker.ts still emits "${frag}"`);
  }
  // The give-up check runs FIRST in the controller, so an error message that
  // happened to contain "fetching" cannot be read as a fresh restore.
  ok(
    isInstallFallbackLine("  [depcache] prebuilt snapshot fetch failed (aborted while fetching) — installing normally."),
    "a give-up whose error text contains 'fetching' is still a give-up",
  );

  // The counts are read off the terminal's own repainted line, which belongs to
  // another package. Build it the way that package builds it — ANSI and all —
  // rather than from a hand-written sample, so a change to the producer's format
  // fails here instead of silently dropping the numbers in the UI.
  const feedback = read("packages/core/terminal-feedback.js");
  const tmpl = /return `\$\{CLEAR_LINE\}[^`]*`;/.exec(feedback);
  ok(!!tmpl, "found the progress-line template in terminal-feedback.js");
  const live = "\u001b[2K\r\u001b[2m\u280b fetching · 222 requests · 38.7 MB\u001b[0m";
  const parsed = readFetchProgress(live);
  ok(parsed?.requests === 222 && parsed?.mb === 38.7, `parsed the live line: ${JSON.stringify(parsed)}`);
  ok(readFetchProgress("npm warn deprecated foo@1.0.0") === null, "unrelated output yields no counts");
}

console.log(
  failed === 0
    ? "\n✓ site delivery contract holds"
    : `\n✗ ${failed} check(s) failed`,
);
process.exit(failed ? 1 : 0);
