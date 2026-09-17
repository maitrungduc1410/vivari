// Host payloads that outgrow the 1 MiB shared window, in both directions.
//
//   node scripts/spike-large-fs-payloads.mjs
//
// Prereq: packages/vfs/pkg-node (npm run build:vfs:node).
//
// The kernel's fs client packs a whole request — path AND body — into one 1 MiB
// SharedArrayBuffer and answers into the same region. Every syscall a process
// makes is chunked to fit, but the HOST surface is not a syscall: `fs.writeFile`
// hands over a whole file, and `fs.readFile` asks for one back. Both therefore
// need a route that was never bounded by the window, and both used to fail at
// ~1 MiB instead — reported upstream as "files larger than ~1 MiB are silently
// dropped by fs.writeFile() / mount()".
//
// Nothing under test is re-implemented here. This drives the real KernelBridge,
// the real FileSystemAPI and the real mountTree from packages/core/src against the
// real kernel worker (scripts/kernel-worker.mjs) and the real Rust/Wasm VFS; only
// the browser edges are shimmed. `Vivari.boot()` is skipped because it gates on
// cross-origin isolation and registers a Service Worker, neither of which exists
// headlessly — it builds this same bridge + FileSystemAPI and calls this same
// mountTree.
//
// Each case separates the two halves the original report had to distinguish:
// whether the promise RESOLVED, and whether the bytes are actually THERE. A
// rejection and a silent drop are different failures, and the silent one is the
// one that cost the reporter a day.

import {
  installTsResolve,
  installWorkerShim,
  scriptUrl,
} from "./lib/browser-worker-shim.mjs";

installTsResolve();
installWorkerShim({ "kernel-worker.ts": scriptUrl("./kernel-worker.mjs") });

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  \u2713 " : "  \u2717 ") + msg);
  if (!cond) failed++;
};

const { KernelBridge } = await import("../packages/core/src/bridge.ts");
const { FileSystemAPI } = await import("../packages/core/src/fs.ts");
const { mountTree } = await import("../packages/core/src/mount.ts");

const bridge = new KernelBridge({ workerName: "repro kernel" });
const fs = new FileSystemAPI(bridge);

const ready = new Promise((resolve, reject) => {
  bridge.on("ready", () => resolve());
  bridge.on("error", (m) => reject(new Error(m.message || "kernel error")));
  setTimeout(() => reject(new Error("kernel did not become ready within 60s")), 60_000);
});
bridge.boot(true); // compress: true — the issue's default
await ready;

const signal = () => AbortSignal.timeout(30_000);
const label = (n) => n.toLocaleString("en-US");

/** Did `path` survive the write? Returns its size, or null when absent. */
async function sizeOf(path) {
  try {
    const st = await fs.stat(path, { signal: signal() });
    return st.size ?? -1;
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Run one write and report the two things that matter separately: how the
 * promise settled, and whether the bytes are actually in the VFS afterwards.
 */
async function attempt(how, path, bytes, run) {
  const row = { how, path, bytes, settled: "", present: null, error: "" };
  try {
    await run();
    row.settled = "resolved";
  } catch (err) {
    row.settled = "rejected";
    row.error = (err && err.message) || String(err);
  }
  row.present = await sizeOf(path);
  const verdict =
    row.settled === "resolved" && row.present === null
      ? "SILENTLY DROPPED"
      : row.settled === "resolved"
        ? "written"
        : "rejected (loud)";
  console.log(
    `  ${how.padEnd(11)} ${label(bytes).padStart(9)} B  ->  ${row.settled.padEnd(8)}` +
      `  vfs: ${row.present === null ? "absent" : label(row.present) + " B"}   ${verdict}`,
  );
  if (row.error) console.log(`      error: ${row.error}`);
  return row;
}

const write = (path, contents) => attempt("writeFile", path, contents.length, () =>
  fs.writeFile(path, contents, { signal: signal() }),
);
const mount = (path, contents) => attempt("mount", "/" + path, contents.length, () =>
  mountTree(bridge, { [path]: { file: { contents } } }, "/", signal()),
);

const big = "x".repeat(1_100_000); // the reported repro payload
const results = {};

/** The bytes resolved AND are on disk at their full length. Both halves, always. */
const landed = (row, what) =>
  ok(
    row.settled === "resolved" && row.present === row.bytes,
    `${what}: resolved, and all ${label(row.bytes)} B are in the VFS` +
      (row.settled === "resolved" ? "" : ` (${row.error})`),
  );

console.log("\n1. control — a small file, both routes");
results.smallWrite = await write("/small-write.txt", "x".repeat(1024));
results.smallMount = await mount("small-mount.txt", "x".repeat(1024));
landed(results.smallWrite, "writeFile, 1 KiB");
landed(results.smallMount, "mount, 1 KiB");

console.log("\n2. the reported repro — 1,100,000 bytes");
results.bigWrite = await write("/big-write.txt", big);
results.bigMount = await mount("big-mount.txt", big);
landed(results.bigWrite, "writeFile past the window");
landed(results.bigMount, "mount past the window");

console.log("\n3. the measured cliff either side of 1 MiB, via writeFile");
results.at1_030_000 = await write("/cliff-a.txt", "x".repeat(1_030_000));
results.at1_048_575 = await write("/cliff-b.txt", "x".repeat(1_048_575));
landed(results.at1_030_000, "writeFile just under the window");
landed(results.at1_048_575, "writeFile just over the window");

// `vv-write` carries either `contents` (a string, editor saves) or `bytes` (a
// Uint8Array, binary imports). The studio's drag-and-drop import sends `bytes`
// per file (controller.ts writeEntry), so if the ceiling applies to that shape
// too, dropping an ordinary photo into the IDE is affected, not just the SDK.
console.log("\n3b. the same ceiling via the binary (bytes) shape");
results.binaryWrite = await attempt("writeFile", "/dropped.bin", 1_100_000, () =>
  fs.writeFile("/dropped.bin", new Uint8Array(1_100_000).fill(7), { signal: signal() }),
);
landed(results.binaryWrite, "writeFile of raw bytes past the window");

console.log("\n4. where the cliff actually is for writeFile (binary search)");
// Same path length on every probe: the path is encoded into the same request as
// the body, so a longer path moves the cliff and would blur the number.
const CEILING_PROBE = 1_200_000;
const lands = async (path, size) => {
  try {
    await fs.writeFile(path, "x".repeat(size), { signal: signal() });
  } catch {
    return false;
  }
  return (await sizeOf(path)) !== null;
};
// Establish that the upper bound actually fails before bisecting towards it —
// otherwise, once the ceiling is lifted, the search happily "converges" on its
// own starting value and reports a cliff that isn't there.
const ceilingLifted = await lands("/ceiling-probe.txt", CEILING_PROBE);
ok(ceilingLifted, `no writeFile ceiling at or below ${label(CEILING_PROBE)} B`);
if (ceilingLifted) {
  console.log("  nothing to bisect");
} else {
  let lo = 1; // known good
  let hi = CEILING_PROBE; // known bad
  let probes = 0;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await lands(`/p${String(probes).padStart(4, "0")}.txt`, mid)) lo = mid;
    else hi = mid;
    probes++;
  }
  console.log(`  largest writeFile that lands: ${label(lo)} B   (first failing: ${label(hi)} B)`);
  console.log(`  probes: ${probes}`);
}

console.log("\n5. does mount() have the same ceiling? 8 MiB in one tree");
const huge = "y".repeat(8 * 1024 * 1024);
results.hugeMount = await mount("huge-mount.bin", huge);
landed(results.hugeMount, "mount, 8 MiB");

// The write side and the read side are separate windows, and a file that the
// batch path put in is not necessarily one the SDK can get back out: readFile
// answers over the same 1 MiB SAB the sync write path was too big for.
console.log("\n6. reading those files back through the SDK");
for (const path of ["/small-write.txt", "/big-mount.txt", "/huge-mount.bin"]) {
  const size = await sizeOf(path);
  if (size === null) {
    ok(false, `${path}: absent, so there is nothing to read back`);
    continue;
  }
  try {
    const back = await fs.readFile(path, { signal: signal() });
    ok(back.length === size, `${path}: read back all ${label(size)} B`);
  } catch (err) {
    ok(false, `${path}: readFile rejected — ${(err && err.message) || err}`);
  }
}

// Two writes to one path now take two different routes, only one of which is
// async, so last-write-wins has to survive the split. It does because both routes
// are messages to the same FS worker in post order (see writeOne in
// kernel-worker.ts) — and this is the case that notices if that stops being true:
// an `await` added above one route but not the other flips it to REORDERED.
// Measured, so it is a guard and not a hope: a 25ms sleep in the large branch
// alone fails this; a yield in both branches does not.
console.log("\n7. ordering — a big write immediately followed by a small one");
const orderPath = "/order.txt";
const bigFirst = fs.writeFile(orderPath, "B".repeat(2_000_000), { signal: signal() });
const smallSecond = fs.writeFile(orderPath, "small-wins", { signal: signal() });
await Promise.allSettled([bigFirst, smallSecond]);
const finalText = await fs.readFile(orderPath, "utf-8");
ok(
  finalText === "small-wins",
  finalText === "small-wins"
    ? "the later small write is what remains"
    : `REORDERED — ${label(finalText.length)} B of stale body won`,
);

// The failure this whole spike exists for is the SILENT one: a write that
// resolves and leaves nothing behind. Assert its absence as a category, so a
// future route that swallows an error is caught even if every case above is
// still individually green.
console.log("\n8. no write resolved without leaving its bytes behind");
const silent = Object.values(results).filter((r) => r.settled === "resolved" && r.present === null);
ok(silent.length === 0, `silent drops (resolved but absent): ${silent.length}`);

bridge.destroy();
console.log(failed === 0 ? "\nlarge fs payloads: OK" : `\nlarge fs payloads: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);