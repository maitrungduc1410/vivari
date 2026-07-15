// Headless estimator for the VFS's whole-file lazy compression (see
// packages/vfs/src/lib.rs). Walks a directory and applies the SAME eligibility
// rules the Rust VFS uses (MIN_COMPRESS_BYTES / MIN_COMPRESS_RATIO, zlib level 6)
// to project how much RAM the compressed VFS would save for a real project's
// files — without needing a browser or a wasm rebuild.
//
//   node scripts/spike-compress.mjs <dir>            # e.g. a project's node_modules
//   node scripts/spike-compress.mjs <dir> --top 20   # list the 20 biggest savers
//
// The numbers are an upper bound on the steady-state win: the live VFS also keeps
// a bounded hot-read cache and never compresses files with an open writable fd.

import { readdirSync, statSync, readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";

// Keep these in sync with packages/vfs/src/lib.rs.
const MIN_COMPRESS_BYTES = 4096;
const MIN_COMPRESS_RATIO = 0.95;
const LEVEL = 6;

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--")) ?? "node_modules";
const topN = Number(args[args.indexOf("--top") + 1]) || 15;

const fmt = (n) => {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
};

let files = 0;
let logical = 0; // raw bytes of all files
let physical = 0; // bytes we'd actually keep (compressed where it pays off)
let compressedCount = 0;
const savers = [];

function walk(p) {
  let entries;
  try {
    entries = readdirSync(p, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(p, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      walk(full);
      continue;
    }
    if (!e.isFile()) continue;
    let buf;
    try {
      const st = statSync(full);
      if (st.size === 0) continue;
      buf = readFileSync(full);
    } catch {
      continue;
    }
    files += 1;
    logical += buf.length;
    if (buf.length < MIN_COMPRESS_BYTES) {
      physical += buf.length;
      continue;
    }
    const z = deflateSync(buf, { level: LEVEL });
    if (z.length >= buf.length * MIN_COMPRESS_RATIO) {
      physical += buf.length; // poor ratio: kept Raw
      continue;
    }
    physical += z.length;
    compressedCount += 1;
    savers.push({ path: full, raw: buf.length, zip: z.length });
  }
}

console.log(`Scanning ${dir} …`);
const t0 = Date.now();
walk(dir);

if (files === 0) {
  console.error(`No files found under ${dir}. Pass a path, e.g. a project's node_modules.`);
  process.exit(1);
}

const saved = logical - physical;
const ratio = (physical / logical) * 100;
savers.sort((a, b) => b.raw - b.zip - (a.raw - a.zip));

console.log("");
console.log(`Files scanned:        ${files}`);
console.log(`  eligible+compressed ${compressedCount}`);
console.log(`Logical (raw):        ${fmt(logical)}`);
console.log(`Physical (stored):    ${fmt(physical)}  (${ratio.toFixed(1)}% of logical)`);
console.log(`Projected saving:     ${fmt(saved)}`);
console.log(`Scan took ${Date.now() - t0}ms`);
console.log("");
console.log(`Top ${topN} savers:`);
for (const s of savers.slice(0, topN)) {
  console.log(`  ${fmt(s.raw - s.zip).padStart(9)}  ${fmt(s.raw)} -> ${fmt(s.zip)}  ${s.path}`);
}
