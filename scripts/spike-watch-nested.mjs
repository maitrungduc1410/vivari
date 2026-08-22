// Spike: a directory created below a watched root is reported, however deep it is.
//
//   node scripts/spike-watch-nested.mjs
//
// `mkdir -p a/b` used to notify only the DEEPEST path it created. Node's recursive
// watcher is userland (node/internal/fs/recursive_watch.js): one non-recursive watch
// per directory, and it learns about a new directory from an event naming it as a
// DIRECT CHILD of something already watched. An event for `a/b` is not that, so it was
// dropped, no watch was ever attached to `a`, and everything created under it stayed
// invisible — until an unrelated event on an already-watched path arrived and the
// queued events came through with it. Not lost, deferred, which is the worse shape:
// the route a user just added 404s, they edit some other file, and it starts working.
//
// It cost a real dev-server user a route: creating `src/routes/api/ping/+server.js`
// (two new directories) left SvelteKit's router never re-syncing, while
// `src/routes/about/+page.svelte` (one) worked. Next.js is affected identically —
// `app/deep/nested/page.js` 404s for as long as nothing else changes. Astro is not,
// because it tracks directories itself rather than relying on the userland watcher.
//
// So the assertions are about the delivery, not about mkdir returning 0:
//
//   1. one new directory is reported (the case that always worked — the control that
//      says the watch itself is live and the harness is sound)
//   2. TWO new directories in one `mkdir -p` are reported, both of them, plus the file
//   3. three levels, because the fix walks a chain and a chain is where an off-by-one
//      hides
//   4. the deferral signature is gone: with nothing else touching the tree, the events
//      arrive on their own. This is the assertion that fails on the unfixed tree —
//      everything above it passes there too once a later event flushes the queue.
//   5. a directory that already exists is NOT re-reported, so the fix did not buy its
//      correctness by notifying unconditionally
//   6. the same holds for the batch path (`writeFilesBatch` -> `FsServer.writeBatch`),
//      which creates directories of its own and is what `vv-import-tree` uses to drop
//      a folder into a workspace that may already have a dev server watching it
//
// Offline, needs the Wasm VFS. Registered `net: false, needsWasm: true`.

import { bootSpikeKernel } from "./lib/spike-harness.mjs";

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};

const h = await bootSpikeKernel();
const { kernel } = h;

/**
 * Run one guest that watches /w/root recursively, does `body`, and reports what it saw.
 *
 * The watcher is created inside the guest rather than driven from the host on purpose:
 * the defect was in what reaches Node's userland recursive watcher, so the assertion
 * has to be made from where that watcher lives. Nothing here touches the host fs.
 */
async function watched(body, { seed = true } = {}) {
  await kernel.start("rm", ["-rf", "/w"], { cwd: "/", capture: true });
  kernel.mkdirp("/w/root");
  // A pre-existing file, so case 4 has something unrelated it could have been flushed
  // by — and, when nothing touches it, so its absence from the log is evidence.
  if (seed) kernel.writeFile("/w/root/seed.txt", "s");
  kernel.writeFile(
    "/w/p.js",
    `const fs = require('fs');
const seen = [];
fs.watch('/w/root', { recursive: true }, (ev, name) => seen.push(ev + ' ' + name));
${body}
setTimeout(() => { console.log('EV ' + JSON.stringify(seen)); process.exit(0); }, 4000);
`,
  );
  const r = await kernel.start("node", ["/w/p.js"], { cwd: "/w", capture: true });
  const line = String(r.stdout || "").split("\n").find((l) => l.startsWith("EV ")) || "EV []";
  return JSON.parse(line.slice(3));
}

const has = (events, frag) => events.some((e) => e.includes(frag));

console.log("\n== one new directory (the case that always worked) ==");
{
  const ev = await watched(`
setTimeout(() => { fs.mkdirSync('/w/root/one', { recursive: true }); fs.writeFileSync('/w/root/one/f.txt','x'); }, 400);`);
  ok(has(ev, "rename one"), "the directory is reported: " + JSON.stringify(ev));
  ok(has(ev, "one/f.txt"), "…and the file inside it");
}

console.log("\n== two new directories in one mkdir -p, and NOTHING else afterwards ==");
{
  const ev = await watched(`
setTimeout(() => { fs.mkdirSync('/w/root/a/b', { recursive: true }); fs.writeFileSync('/w/root/a/b/f.txt','x'); }, 400);`);
  // The load-bearing one. On the unfixed tree this is `[]` — no intermediate directory,
  // no leaf, no file — and it stays `[]` for as long as the watch is open.
  ok(ev.length > 0, "something is reported at all: " + JSON.stringify(ev));
  ok(has(ev, "rename a"), "the INTERMEDIATE directory is reported, not just the deepest");
  ok(has(ev, "a/b"), "…and the directory that mkdir was asked for");
  ok(has(ev, "a/b/f.txt"), "…and the file written into it");
  ok(!has(ev, "seed.txt"), "…without anything else having touched the tree to flush them");
}

console.log("\n== three levels, because a chain is where an off-by-one hides ==");
{
  const ev = await watched(`
setTimeout(() => { fs.mkdirSync('/w/root/x/y/z', { recursive: true }); fs.writeFileSync('/w/root/x/y/z/f.txt','x'); }, 400);`);
  ok(has(ev, "rename x") && has(ev, "x/y") && has(ev, "x/y/z"), "every level is reported: " + JSON.stringify(ev));
  ok(has(ev, "x/y/z/f.txt"), "…and the file at the bottom");
}

console.log("\n== an existing directory is not re-reported ==");
{
  // Guards the shape of the fix rather than its effect: notifying unconditionally would
  // pass every assertion above and lie to chokidar about directories it already knows.
  const ev = await watched(`
setTimeout(() => { fs.mkdirSync('/w/root/dup', { recursive: true }); }, 300);
setTimeout(() => { fs.mkdirSync('/w/root/dup/inner', { recursive: true }); }, 900);`);
  const dupCount = ev.filter((e) => e === "rename dup").length;
  ok(dupCount === 1, "`dup` is reported exactly once across two mkdirs that both name it: " + dupCount);
  ok(has(ev, "dup/inner"), "…and the second mkdir's own new directory is reported");
}

console.log("\n== the batch path creates directories too (vv-import-tree) ==");
{
  await kernel.start("rm", ["-rf", "/w"], { cwd: "/", capture: true });
  kernel.mkdirp("/w/root");
  kernel.writeFile("/w/root/seed.txt", "s");
  kernel.writeFile(
    "/w/p.js",
    `const fs = require('fs');
const seen = [];
fs.watch('/w/root', { recursive: true }, (ev, name) => seen.push(ev + ' ' + name));
setTimeout(() => { console.log('EV ' + JSON.stringify(seen)); process.exit(0); }, 4000);
`,
  );
  const proc = kernel.start("node", ["/w/p.js"], { cwd: "/w", capture: true });
  // Let the guest register its watch before the batch lands, or there is nothing to miss.
  await new Promise((r) => setTimeout(r, 800));
  await kernel.writeFilesBatch([
    { path: "/w/root/imported/deep/a.txt", contents: "a" },
    { path: "/w/root/imported/deep/b.txt", contents: "b" },
  ]);
  const r = await proc;
  const line = String(r.stdout || "").split("\n").find((l) => l.startsWith("EV ")) || "EV []";
  const ev = JSON.parse(line.slice(3));
  ok(has(ev, "rename imported") && has(ev, "imported/deep"), "both directories the batch created are reported: " + JSON.stringify(ev));
  ok(has(ev, "imported/deep/a.txt") && has(ev, "imported/deep/b.txt"), "…and both files");
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL: ${failed} check(s)`}`);
process.exit(failed === 0 ? 0 : 1);
