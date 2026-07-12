// vendor-npm — build the real-npm delivery asset for the browser studio.
//
// The North Star is running the REAL, unmodified npm CLI in-browser (not our
// Turbo-analog `programs/npm.js`). The headless spike (scripts/spike-npm.mjs)
// loads npm off the host disk with fs.readdirSync — impossible in a browser.
// This script vendors a pinned npm and packs its whole tree into ONE compact,
// gzipped asset that the kernel worker fetches once and unpacks straight into
// the VFS (see packages/kernel-host/load-real-npm.js).
//
// Why a custom archive and not a .tgz: we control both ends, so we avoid tar's
// long-path/GNU-extension edge cases (npm's @npmcli/* paths are long). Layout:
//
//   [u32le headerLen][headerJSON][file bytes ...]        then gzip the whole lot
//   header = { version, files: [{ p: relPath, o: offset, l: length }, ... ] }
//
// The asset is a build artifact (gitignored), rebuilt by `npm run vendor:npm`
// and wired as `predev`/`prebuild:studio`. Idempotent: skips work if the asset
// already exists (pass --force to rebuild).
//
// Usage: node scripts/vendor-npm.mjs [--force]

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const NPM_VERSION = "10.9.2"; // keep in sync with scripts/spike-npm.mjs
const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const VENDOR_DIR = process.env.OC_VENDOR_DIR || "/tmp/oc-vendor";
const VENDOR_NPM = path.join(VENDOR_DIR, "node_modules", "npm");
const OUT_DIR = path.join(ROOT, "packages", "studio", "public", "vendor");
// NOTE: the payload is gzip-compressed, but the file is deliberately NOT named
// `.gz`. Static servers (Vite's sirv, many CDNs) treat a `.gz` file as
// TRANSFER-encoded and serve it with `Content-Encoding: gzip`, so the browser
// transparently decompresses it before our fetch sees it — then our own gunzip
// fails on already-decompressed bytes. A neutral extension is served verbatim.
const OUT_FILE = path.join(OUT_DIR, "npm-pack.bin");

const force = process.argv.includes("--force");

function log(msg) {
  process.stderr.write(`[vendor-npm] ${msg}\n`);
}

if (fs.existsSync(OUT_FILE) && !force) {
  log(`asset already present: ${path.relative(ROOT, OUT_FILE)} (use --force to rebuild)`);
  process.exit(0);
}

// 1) Vendor a pinned npm into a scratch dir (host npm/network needed once).
if (!fs.existsSync(path.join(VENDOR_NPM, "bin", "npm-cli.js")) || force) {
  log(`installing npm@${NPM_VERSION} into ${VENDOR_DIR} …`);
  fs.rmSync(VENDOR_DIR, { recursive: true, force: true });
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  try {
    execSync(`npm install npm@${NPM_VERSION} --no-save --no-audit --no-fund --loglevel=error`, {
      cwd: VENDOR_DIR,
      stdio: ["ignore", "ignore", "inherit"],
    });
  } catch (e) {
    log(`FAILED to vendor npm (need network + host npm): ${(e && e.message) || e}`);
    process.exit(1);
  }
} else {
  log(`reusing vendored npm at ${VENDOR_NPM}`);
}

if (!fs.existsSync(path.join(VENDOR_NPM, "bin", "npm-cli.js"))) {
  log(`vendored npm is missing bin/npm-cli.js — aborting`);
  process.exit(1);
}

// 2) Walk the tree into a flat file list (files only; npm ships no symlinks in
//    its own package — the spike skips them too).
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
walk(VENDOR_NPM, "");
log(`packing ${files.length} files (${(totalBytes / 1e6).toFixed(1)} MB raw) …`);

// 3) Build the archive: header (path/offset/length index) + concatenated bytes.
const index = [];
let offset = 0;
for (const f of files) {
  index.push({ p: f.rel, o: offset, l: f.size });
  offset += f.size;
}
const header = Buffer.from(JSON.stringify({ version: NPM_VERSION, files: index }), "utf8");
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
    `(${(raw.length / 1e6).toFixed(1)} MB raw, npm@${NPM_VERSION})`,
);
