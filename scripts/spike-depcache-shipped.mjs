// Spike — the SHIPPED snapshot round trip: producer (scripts/gen-depcache.mjs)
// to consumer (kernel-worker.ts → the dep-cache store → the real Wasm VFS).
//
// spike-dep-cache.mjs next door gates the store's own pack/restore. This one
// gates the seam between the build and the browser, which is the seam that
// broke: the consumer has been complete and hardened for months, nothing ever
// produced the manifest it reads, `vendor/depcache/index.json` answered with the
// SPA's index.html and a 200, the JSON.parse threw into a catch that means
// "feature off", and coverage sat at 0 of ~70 templates in silence. Everything
// asserted below is a step on the path between those two halves.
//
// Deliberately OFFLINE and Wasm-only: the fixture is a hand-built tree, not a
// registry install, so the format contract is gated on every PR rather than
// nightly. What a real template install adds on top of this is size, and size is
// not what fails.
//
//   run: node scripts/spike-depcache-shipped.mjs   (needs `npm run build:vfs:node`)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import {
  createDepCache,
  decodeShippedSnapshot,
  hashDepKey,
  writeSnapshotContainer,
} from "../packages/kernel-host/dep-cache.js";
import { hostAccess, memoryStorage } from "./lib/host-vfs-access.mjs";
import { bootSpikeKernel } from "./lib/spike-harness.mjs";

const DIR = "/app";
const enc = new TextEncoder();

let ok = true;
const gate = (label, pass, extra = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!pass) ok = false;
};

// ── the producer half, on the host ──────────────────────────────────────────
// A node_modules with the three entry kinds pack() emits (dir, file, symlink),
// built on the host filesystem exactly the way gen-depcache.mjs sees one after
// `npm install`.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "vv-spike-depcache-"));
const PJ = JSON.stringify({ name: "app", version: "1.0.0", dependencies: { leftpad: "1.0.0" } }, null, 2);
const LOCK = JSON.stringify(
  { name: "app", lockfileVersion: 3, packages: { "node_modules/leftpad": { version: "1.0.0" } } },
  null,
  2,
);
fs.writeFileSync(path.join(stage, "package.json"), PJ);
fs.writeFileSync(path.join(stage, "package-lock.json"), LOCK);
fs.mkdirSync(path.join(stage, "node_modules/leftpad"), { recursive: true });
fs.mkdirSync(path.join(stage, "node_modules/.bin"), { recursive: true });
fs.writeFileSync(
  path.join(stage, "node_modules/leftpad/package.json"),
  JSON.stringify({ name: "leftpad", version: "1.0.0", main: "index.js" }),
);
fs.writeFileSync(
  path.join(stage, "node_modules/leftpad/index.js"),
  "module.exports = (s, n) => String(s).padStart(n);",
);
// The .bin shim npm creates. It is a symlink, and a snapshot that flattened it
// into a copy would restore a tree whose `vite`/`next` cannot be executed.
fs.symlinkSync("../leftpad/index.js", path.join(stage, "node_modules/.bin/leftpad"));

const storage = memoryStorage();
const producer = await createDepCache({ access: hostAccess, storage });
const lockKey = await hashDepKey("npm", enc.encode(LOCK), "package-lock.json");
const pjKey = await hashDepKey("npm", enc.encode(PJ), "package.json");
const saved = await producer.save(lockKey, stage);
gate("producer packs a host tree through the shipped pack()", !!saved && saved.files >= 2, saved ? `${saved.entries} entries` : "null");

const archive = storage.blobs.get(lockKey);
const asset = writeSnapshotContainer("gz", zlib.gzipSync(archive, { level: 9 }), { id: "fixture" });
gate("the shipped container is smaller than the archive", asset.length < archive.length, `${archive.length}B → ${asset.length}B`);

// ── the key contract ────────────────────────────────────────────────────────
// The producer's key must be the one the browser computes, or the asset is dead
// weight nobody ever looks up. computeDepKey (kernel-worker.ts) hashes the raw
// LOCKFILE BYTES under the source name "package-lock.json"; re-serialising
// parsed JSON at either end changes the hash and silently misses.
gate("the lock key is namespaced by pm and source", lockKey.startsWith("npm:package-lock.json:"), lockKey.slice(0, 32) + "…");
gate("the package.json alias key is distinct", pjKey !== lockKey && pjKey.startsWith("npm:package.json:"));
gate(
  "reserialising the lock produces a DIFFERENT key (so the bytes must be shipped verbatim)",
  (await hashDepKey("npm", enc.encode(JSON.stringify(JSON.parse(LOCK))), "package-lock.json")) !== lockKey,
);

// ── the consumer half ───────────────────────────────────────────────────────
// decodeShippedSnapshot is the SHIPPED decoder — kernel-worker.ts calls this
// same function on the bytes it downloads.
const decodeShipped = decodeShippedSnapshot;

const decoded = await decodeShipped(asset);
gate("the container decodes back to the exact archive", !!decoded && Buffer.compare(Buffer.from(decoded), Buffer.from(archive)) === 0);

// The one that reached production. An asset that is not served comes back as the
// SPA's index.html with a 200, so "did the fetch succeed" is not the question —
// "are these bytes a snapshot" is.
const html = enc.encode("<!DOCTYPE html>\n<html><head><title>Vivari</title></head><body></body></html>\n");
gate("an HTML error page served with a 200 is rejected", (await decodeShipped(html)) === null);
gate("a truncated download is rejected", (await decodeShipped(asset.subarray(0, 64))) === null);
gate(
  "a codec this build cannot decode is rejected rather than unpacked",
  (await decodeShipped(writeSnapshotContainer("br", zlib.gzipSync(archive)))) === null,
);
// Backward compatibility: a snapshot produced before the container existed is a
// bare archive, and must still import.
const v1 = await decodeShipped(archive);
gate("an uncompressed v1 archive still decodes", !!v1 && Buffer.compare(Buffer.from(v1), Buffer.from(archive)) === 0);

const { kernel, kernelFs } = await bootSpikeKernel();
kernel.mkdirp(DIR);
kernel.writeFile(`${DIR}/package.json`, PJ);
kernel.writeFile(`${DIR}/package-lock.json`, LOCK);

// The key the VM derives from the files on disk must equal the producer's. This
// is the assertion the missing manifest hid: a producer keyed even one byte
// differently ships an asset that is never requested, and the only symptom is
// that nothing gets faster.
const vmLockKey = await hashDepKey("npm", kernelFs.fs.readFileBytes(`${DIR}/package-lock.json`), "package-lock.json");
const vmPjKey = await hashDepKey("npm", kernelFs.fs.readFileBytes(`${DIR}/package.json`), "package.json");
gate("the VM derives the producer's lock key from the files on disk", vmLockKey === lockKey);
gate("the VM derives the producer's package.json key", vmPjKey === pjKey);

gate("no snapshot for this key before the import", (await kernelFs.fs.depCacheHas(lockKey)) === false);
const imported = await kernelFs.fs.depCacheImport(lockKey, decoded);
gate("importArchive accepts the produced asset", !!imported && imported.entries === saved.entries, imported ? `${imported.entries} entries` : "null");

const restored = await kernelFs.fs.depCacheRestore(lockKey, DIR);
gate("restore() rebuilds the tree in the Wasm VFS", restored === saved.entries, `${restored} entries`);

const verify = await kernel.start(
  "node",
  [
    "-e",
    "const fs=require('fs');console.log(JSON.stringify({" +
      `padded: require('leftpad')('x', 3), bin: fs.readlinkSync('${DIR}/node_modules/.bin/leftpad') }))`,
  ],
  { cwd: DIR, env: { HOME: "/home/user", PATH: "/bin", PWD: DIR }, capture: true },
);
let seen = null;
try {
  seen = JSON.parse((verify.stdout || "").trim());
} catch {
  /* reported by the gates below */
}
gate("a package from the shipped snapshot require()s", verify.code === 0 && seen?.padded === "  x", (verify.stderr || "").trim());
// A snapshot that flattened symlinks into copies would restore a tree whose
// `vite`/`next` cannot be executed, and every gate above would still be green.
gate("the .bin shim survives as a symlink, not a copy", seen?.bin === "../leftpad/index.js", String(seen?.bin));

fs.rmSync(stage, { recursive: true, force: true });
console.log(ok ? "\nOK: the build-time snapshot reaches the VM intact" : "\nFAIL");
process.exit(ok ? 0 : 1);
