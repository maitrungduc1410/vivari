// vendor-corepack — build the real-corepack delivery asset for the browser studio.
//
// Sibling of scripts/vendor-npm.mjs / vendor-yarn.mjs / vendor-pnpm.mjs. The
// headless spike (scripts/spike-corepack.mjs) loads corepack off the host disk
// with fs.readdirSync — impossible in a browser. This vendors a pinned corepack
// and packs its tree into ONE gzipped asset the kernel worker fetches once and
// unpacks into the VFS (see packages/kernel-host/load-real-corepack.js).
//
// Same archive layout as the npm/yarn/pnpm packers:
//
//   [u32le headerLen][headerJSON][file bytes ...]        then gzip the whole lot
//   header = { version, files: [{ p: relPath, o: offset, l: length }, ... ] }
//
// corepack is TINY (dist/corepack.js entry -> dist/lib/corepack.cjs ~520 KB, plus
// dist/{npm,npx,pnpm,pnpx,yarn,yarnpkg}.js shims and shims/*, ~54 files < 1 MB).
// No native addons, nothing to drop.
//
// Build artifact (gitignored), rebuilt by `npm run vendor:corepack`, wired as
// `predev`/`prebuild:studio`. Idempotent (--force rebuilds).
//
// Usage: node scripts/vendor-corepack.mjs [--force]

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const COREPACK_VERSION = "0.35.0"; // keep in sync with scripts/spike-corepack.mjs
const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const VENDOR_DIR = process.env.OC_VENDOR_COREPACK_DIR || "/tmp/oc-vendor-corepack";
const VENDOR_COREPACK = path.join(VENDOR_DIR, "node_modules", "corepack");
const OUT_DIR = path.join(ROOT, "packages", "studio", "public", "vendor");
// Gzip-compressed but deliberately NOT named `.gz` (static servers would set
// Content-Encoding: gzip and the browser would double-decompress). See vendor-npm.
const OUT_FILE = path.join(OUT_DIR, "corepack-pack.bin");

const force = process.argv.includes("--force");

function log(msg) {
  process.stderr.write(`[vendor-corepack] ${msg}\n`);
}

if (fs.existsSync(OUT_FILE) && !force) {
  log(`asset already present: ${path.relative(ROOT, OUT_FILE)} (use --force to rebuild)`);
  process.exit(0);
}

// 1) Vendor a pinned corepack into a scratch dir (host npm/network needed once).
if (!fs.existsSync(path.join(VENDOR_COREPACK, "dist", "corepack.js")) || force) {
  log(`installing corepack@${COREPACK_VERSION} into ${VENDOR_DIR} …`);
  fs.rmSync(VENDOR_DIR, { recursive: true, force: true });
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  try {
    execSync(`npm install corepack@${COREPACK_VERSION} --no-save --no-audit --no-fund --loglevel=error`, {
      cwd: VENDOR_DIR,
      stdio: ["ignore", "ignore", "inherit"],
    });
  } catch (e) {
    log(`FAILED to vendor corepack (need network + host npm): ${(e && e.message) || e}`);
    process.exit(1);
  }
} else {
  log(`reusing vendored corepack at ${VENDOR_COREPACK}`);
}

if (!fs.existsSync(path.join(VENDOR_COREPACK, "dist", "corepack.js"))) {
  log(`vendored corepack is missing dist/corepack.js — aborting`);
  process.exit(1);
}

// 2) Walk the tree into a flat file list.
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
walk(VENDOR_COREPACK, "");
log(`packing ${files.length} files (${(totalBytes / 1e6).toFixed(1)} MB raw) …`);

// 3) Build the archive: header (path/offset/length index) + concatenated bytes.
const index = [];
let offset = 0;
for (const f of files) {
  index.push({ p: f.rel, o: offset, l: f.size });
  offset += f.size;
}
const header = Buffer.from(JSON.stringify({ version: COREPACK_VERSION, files: index }), "utf8");
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
    `(${(raw.length / 1e6).toFixed(1)} MB raw, corepack@${COREPACK_VERSION})`,
);
