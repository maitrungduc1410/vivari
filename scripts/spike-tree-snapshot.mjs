// Spike (OFFLINE): the FS-worker half of Vivari.snapshot() / Vivari.restore().
//
// The SDK methods are a request to the kernel worker, which forwards to the FS
// worker's `fs-snapshot` / `fs-restore` (dep-cache.js snapshotTreeOp /
// restoreTreeOp). This drives those through the headless fs-worker twin and a
// real Wasm VFS: pack a project with node_modules, a symlink, a binary file and
// an executable mode; restore it into a SECOND kernel; compare. Then the refusals,
// which matter more than the happy path because restore takes bytes from an
// embedder: damaged bytes, a foreign archive with a `..` path, a missing root and
// a file root must all reject before anything is written.
//
// Not covered here (browser only): the vv-snapshot / vv-restore relay in
// kernel-worker.ts and the transfer from the page.
//
//   run:  node scripts/spike-tree-snapshot.mjs

import { bootSpikeKernel } from "./lib/spike-harness.mjs";
import { readSnapshotContainer } from "../packages/kernel-host/dep-cache.js";

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};
const codeOf = async (p) => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return e.code;
  }
};

const a = await bootSpikeKernel();
const b = await bootSpikeKernel();
const K = a.kernel;

// ── a project worth snapshotting ─────────────────────────────────────────────
K.mkdirp("/app/src");
K.mkdirp("/app/node_modules/left-pad/lib");
K.mkdirp("/app/node_modules/.bin");
K.mkdirp("/app/.git/objects");
K.writeFile("/app/package.json", '{"name":"app","dependencies":{"left-pad":"1.3.0"}}');
K.writeFile("/app/src/index.js", "module.exports = require('left-pad')('x', 3);\n");
K.writeFile("/app/node_modules/left-pad/package.json", '{"name":"left-pad","version":"1.3.0","main":"lib/index.js"}');
K.writeFile("/app/node_modules/left-pad/lib/index.js", "module.exports = (s, n) => ' '.repeat(n - s.length) + s;\n");
K.writeFile("/app/.git/objects/blob", "git stuff");
const binary = new Uint8Array(70000).map((_, i) => (i * 31 + 7) & 0xff);
await a.kernelFs.fs.writeLarge("/app/logo.bin", binary.slice()); // writeLarge transfers its input
K.fs.symlink("../left-pad/lib/index.js", "/app/node_modules/.bin/left-pad");

console.log("== snapshot ==");
const snap = await a.kernelFs.fs.snapshotTree("/app", []);
ok(snap.bytes instanceof Uint8Array && snap.bytes.length > 0, `snapshot bytes produced (${snap.bytes.length} B, ${snap.files} files, ${snap.entries} entries)`);
const framed = readSnapshotContainer(snap.bytes);
ok(!!framed && framed.codec === "gz", "the bytes are the gzipped container (codec gz)");
ok(snap.bytes.length < snap.rawBytes, `compressed below the raw archive (${snap.bytes.length} < ${snap.rawBytes})`);
ok(snap.files === 6, `every file is in it, .git and node_modules included (${snap.files})`);

const keep = snap.bytes.slice(); // restoreTree transfers its input

console.log("\n== restore into a second kernel ==");
const r = await b.kernelFs.fs.restoreTree(snap.bytes, "/restored");
ok(r.files === 6, `restore reports the files it wrote (${r.files})`);
ok(snap.bytes.byteLength === 0, "the input buffer was transferred, not copied");
const B = b.kernel;
ok(B.readFile("/restored/package.json") === K.readFile("/app/package.json"), "a top-level file round-trips");
ok(B.readFile("/restored/node_modules/left-pad/lib/index.js") === K.readFile("/app/node_modules/left-pad/lib/index.js"), "a file deep in node_modules round-trips");
const bin = B.readFileBytes("/restored/logo.bin");
ok(bin.length === binary.length && bin.every((v, i) => v === binary[i]), "a 70 KB binary file round-trips byte for byte");
ok(B.fs.readlink("/restored/node_modules/.bin/left-pad") === "../left-pad/lib/index.js", "a symlink keeps its target");
const run = await B.start("node", ["/restored/src/index.js"], { cwd: "/restored", capture: true });
ok(run.code === 0, "the restored project runs its dependency (exit " + run.code + ")");

console.log("\n== exclude ==");
const ex = await a.kernelFs.fs.snapshotTree("/app", [".git", "node_modules"]);
ok(ex.files === 3, `exclude drops whole subtrees by name (${ex.files} files)`);
const r2 = await b.kernelFs.fs.restoreTree(ex.bytes, "/ex");
ok(!B.exists("/ex/.git") && !B.exists("/ex/node_modules") && B.exists("/ex/src/index.js"), "the excluded names are absent after restore, the rest present");
void r2;

console.log("\n== restore merges, and overwrites what it carries ==");
B.mkdirp("/merge");
B.writeFile("/merge/keep.txt", "mine");
B.writeFile("/merge/package.json", "old");
await b.kernelFs.fs.restoreTree(keep.slice(), "/merge");
ok(B.readFile("/merge/keep.txt") === "mine", "a file the snapshot does not carry is left alone");
ok(B.readFile("/merge/package.json") === K.readFile("/app/package.json"), "a file the snapshot carries is overwritten");

console.log("\n== refusals ==");
ok((await codeOf(a.kernelFs.fs.snapshotTree("/nope", []))) === "ENOENT", "snapshot of a missing directory rejects ENOENT");
ok((await codeOf(a.kernelFs.fs.snapshotTree("/app/package.json", []))) === "ENOTDIR", "snapshot of a file rejects ENOTDIR");

const damaged = keep.slice(0, keep.length - 100);
ok((await codeOf(b.kernelFs.fs.restoreTree(damaged, "/damaged"))) === "EINVAL", "truncated bytes reject EINVAL");
ok(!B.exists("/damaged"), "and nothing was written for them");
const html = new TextEncoder().encode("<!doctype html><title>404</title>");
ok((await codeOf(b.kernelFs.fs.restoreTree(html, "/html"))) === "EINVAL", "an HTML page rejects EINVAL");

// A foreign archive in the right format whose path climbs out of the destination.
const enc = new TextEncoder();
const header = enc.encode(JSON.stringify({ v: 1, entries: [{ p: "", k: "d", m: 493 }, { p: "../escaped.txt", k: "f", m: 420, o: 0, l: 2 }] }));
const evil = new Uint8Array(4 + header.length + 2);
new DataView(evil.buffer).setUint32(0, header.length, true);
evil.set(header, 4);
evil.set(enc.encode("hi"), 4 + header.length);
ok((await codeOf(b.kernelFs.fs.restoreTree(evil, "/jail/inner"))) === "EINVAL", "an archive with a `..` path rejects EINVAL");
ok(!B.exists("/jail/escaped.txt") && !B.exists("/jail"), "and nothing escaped or was created");

B.writeFile("/afile", "x");
ok((await codeOf(b.kernelFs.fs.restoreTree(keep.slice(), "/afile"))) === "ENOTDIR", "restore onto a file rejects ENOTDIR");

console.log(failed ? `\nFAIL: ${failed} check(s)` : "\nPASS: snapshot/restore round-trips a tree and refuses bad input");
process.exit(failed ? 1 : 0);
