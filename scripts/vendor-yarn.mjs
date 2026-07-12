// vendor-yarn — build the real-yarn (classic) delivery asset for the browser studio.
//
// Sibling of scripts/vendor-npm.mjs. The North Star is running the REAL,
// unmodified yarn CLI in-browser. The headless spike (scripts/spike-yarn.mjs)
// loads yarn off the host disk with fs.readdirSync — impossible in a browser.
// This script vendors a pinned yarn and packs its whole tree into ONE compact,
// gzipped asset the kernel worker fetches once and unpacks into the VFS (see
// packages/kernel-host/load-real-yarn.js).
//
// Same archive layout as vendor-npm (we control both ends → no tar edge cases):
//
//   [u32le headerLen][headerJSON][file bytes ...]        then gzip the whole lot
//   header = { version, files: [{ p: relPath, o: offset, l: length }, ... ] }
//
// Yarn classic is tiny to deliver: bin/yarn.js + a ~5 MB lib/cli.js webpack
// bundle + lib/v8-compile-cache.js (~11 files). The asset is a build artifact
// (gitignored), rebuilt by `npm run vendor:yarn` and wired as
// `predev`/`prebuild:studio`. Idempotent: skips work if present (--force rebuilds).
//
// Usage: node scripts/vendor-yarn.mjs [--force]

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const YARN_VERSION = "1.22.22"; // keep in sync with scripts/spike-yarn.mjs
const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const VENDOR_DIR = process.env.OC_VENDOR_YARN_DIR || "/tmp/oc-vendor-yarn";
const VENDOR_YARN = path.join(VENDOR_DIR, "node_modules", "yarn");
const OUT_DIR = path.join(ROOT, "packages", "studio", "public", "vendor");
// Gzip-compressed but deliberately NOT named `.gz` — static servers (Vite's
// sirv, CDNs) serve a `.gz` file with `Content-Encoding: gzip`, so the browser
// auto-decompresses before our fetch sees it and our own gunzip then fails on
// already-decompressed bytes. A neutral extension is served verbatim.
const OUT_FILE = path.join(OUT_DIR, "yarn-pack.bin");

const force = process.argv.includes("--force");

function log(msg) {
  process.stderr.write(`[vendor-yarn] ${msg}\n`);
}

if (fs.existsSync(OUT_FILE) && !force) {
  log(`asset already present: ${path.relative(ROOT, OUT_FILE)} (use --force to rebuild)`);
  process.exit(0);
}

// 1) Vendor a pinned yarn into a scratch dir (host npm/network needed once).
if (!fs.existsSync(path.join(VENDOR_YARN, "bin", "yarn.js")) || force) {
  log(`installing yarn@${YARN_VERSION} into ${VENDOR_DIR} …`);
  fs.rmSync(VENDOR_DIR, { recursive: true, force: true });
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  try {
    execSync(`npm install yarn@${YARN_VERSION} --no-save --no-audit --no-fund --loglevel=error`, {
      cwd: VENDOR_DIR,
      stdio: ["ignore", "ignore", "inherit"],
    });
  } catch (e) {
    log(`FAILED to vendor yarn (need network + host npm): ${(e && e.message) || e}`);
    process.exit(1);
  }
} else {
  log(`reusing vendored yarn at ${VENDOR_YARN}`);
}

if (!fs.existsSync(path.join(VENDOR_YARN, "bin", "yarn.js"))) {
  log(`vendored yarn is missing bin/yarn.js — aborting`);
  process.exit(1);
}

// 2) Walk the tree into a flat file list (files only; yarn ships no symlinks).
/** @type {{ rel: string, abs: string, size: number }[]} */
const files = [];
let totalBytes = 0;
function walk(dir, rel) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) walk(abs, r);
    else if (ent.isFile()) {
      const size = fs.statSync(abs).size;
      files.push({ rel: r, abs, size });
      totalBytes += size;
    }
  }
}
walk(VENDOR_YARN, "");
log(`packing ${files.length} files (${(totalBytes / 1e6).toFixed(1)} MB raw) …`);

// 3) Build the archive: header (path/offset/length index) + concatenated bytes.
const index = [];
let offset = 0;
for (const f of files) {
  index.push({ p: f.rel, o: offset, l: f.size });
  offset += f.size;
}
const header = Buffer.from(JSON.stringify({ version: YARN_VERSION, files: index }), "utf8");
const headerLen = Buffer.alloc(4);
headerLen.writeUInt32LE(header.length, 0);

const blob = Buffer.allocUnsafe(totalBytes);
let pos = 0;
for (const f of files) {
  const bytes = fs.readFileSync(f.abs);
  bytes.copy(blob, pos);
  pos += bytes.length;
}

const raw = Buffer.concat([headerLen, header, blob]);
const gz = zlib.gzipSync(raw, { level: 9 });

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, gz);
log(
  `wrote ${path.relative(ROOT, OUT_FILE)} — ${(gz.length / 1e6).toFixed(2)} MB gz ` +
    `(${(raw.length / 1e6).toFixed(1)} MB raw, yarn@${YARN_VERSION})`,
);
