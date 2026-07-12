// vendor-pnpm — build the real-pnpm delivery asset for the browser studio.
//
// Sibling of scripts/vendor-npm.mjs / vendor-yarn.mjs. The headless spike
// (scripts/spike-pnpm.mjs) loads pnpm off the host disk with fs.readdirSync —
// impossible in a browser. This vendors a pinned pnpm and packs its tree into ONE
// gzipped asset the kernel worker fetches once and unpacks into the VFS (see
// packages/kernel-host/load-real-pnpm.js).
//
// Same archive layout as the npm/yarn packers:
//
//   [u32le headerLen][headerJSON][file bytes ...]        then gzip the whole lot
//   header = { version, files: [{ p: relPath, o: offset, l: length }, ... ] }
//
// pnpm is bin/pnpm.cjs (tiny entry) -> dist/pnpm.cjs (~8.8 MB bundle) +
// dist/worker.js + a real dist/node_modules (~902 files, 20 MB). We DROP the
// prebuilt `*.node` reflink addons: they only exist for darwin/win — on our
// Linux target pnpm falls back to JS, and `--package-import-method=copy` avoids
// reflink/hardlink entirely — so shipping ~1.3 MB of dead binaries is pointless.
//
// Build artifact (gitignored), rebuilt by `npm run vendor:pnpm`, wired as
// `predev`/`prebuild:studio`. Idempotent (--force rebuilds).
//
// Usage: node scripts/vendor-pnpm.mjs [--force]

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const PNPM_VERSION = "9.15.9"; // keep in sync with scripts/spike-pnpm.mjs
const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const VENDOR_DIR = process.env.OC_VENDOR_PNPM_DIR || "/tmp/oc-vendor-pnpm";
const VENDOR_PNPM = path.join(VENDOR_DIR, "node_modules", "pnpm");
const OUT_DIR = path.join(ROOT, "packages", "studio", "public", "vendor");
// Gzip-compressed but deliberately NOT named `.gz` (static servers would set
// Content-Encoding: gzip and the browser would double-decompress). See vendor-npm.
const OUT_FILE = path.join(OUT_DIR, "pnpm-pack.bin");

const force = process.argv.includes("--force");

function log(msg) {
  process.stderr.write(`[vendor-pnpm] ${msg}\n`);
}

if (fs.existsSync(OUT_FILE) && !force) {
  log(`asset already present: ${path.relative(ROOT, OUT_FILE)} (use --force to rebuild)`);
  process.exit(0);
}

// 1) Vendor a pinned pnpm into a scratch dir (host npm/network needed once).
if (!fs.existsSync(path.join(VENDOR_PNPM, "bin", "pnpm.cjs")) || force) {
  log(`installing pnpm@${PNPM_VERSION} into ${VENDOR_DIR} …`);
  fs.rmSync(VENDOR_DIR, { recursive: true, force: true });
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  try {
    execSync(`npm install pnpm@${PNPM_VERSION} --no-save --no-audit --no-fund --loglevel=error`, {
      cwd: VENDOR_DIR,
      stdio: ["ignore", "ignore", "inherit"],
    });
  } catch (e) {
    log(`FAILED to vendor pnpm (need network + host npm): ${(e && e.message) || e}`);
    process.exit(1);
  }
} else {
  log(`reusing vendored pnpm at ${VENDOR_PNPM}`);
}

if (!fs.existsSync(path.join(VENDOR_PNPM, "bin", "pnpm.cjs"))) {
  log(`vendored pnpm is missing bin/pnpm.cjs — aborting`);
  process.exit(1);
}

// 2) Walk the tree into a flat file list, dropping non-Linux native addons.
/** @type {{ rel: string, abs: string, size: number }[]} */
const files = [];
let totalBytes = 0;
let droppedNative = 0;
function walk(dir, rel) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) walk(abs, r);
    else if (ent.isFile()) {
      if (ent.name.endsWith(".node")) {
        droppedNative++;
        continue; // darwin/win reflink addons — dead weight on our Linux target
      }
      const size = fs.statSync(abs).size;
      files.push({ rel: r, abs, size });
      totalBytes += size;
    }
  }
}
walk(VENDOR_PNPM, "");
log(`packing ${files.length} files (${(totalBytes / 1e6).toFixed(1)} MB raw), dropped ${droppedNative} *.node …`);

// 3) Build the archive: header (path/offset/length index) + concatenated bytes.
const index = [];
let offset = 0;
for (const f of files) {
  index.push({ p: f.rel, o: offset, l: f.size });
  offset += f.size;
}
const header = Buffer.from(JSON.stringify({ version: PNPM_VERSION, files: index }), "utf8");
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
    `(${(raw.length / 1e6).toFixed(1)} MB raw, pnpm@${PNPM_VERSION})`,
);
