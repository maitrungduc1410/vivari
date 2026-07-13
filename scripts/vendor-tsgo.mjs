// vendor-tsgo — build the real-TypeScript-7 (tsgo, the Go rewrite) delivery asset
// for the browser studio.
//
// Sibling of scripts/vendor-npm.mjs / vendor-corepack.mjs. TS 7's compiler is
// compiled Go, shipped by the community `tsgo-wasm` package as a GOOS=js/wasm
// module (`tsgo.wasm`, ~47 MB) plus the standard Go `wasm_exec.js` glue. The
// headless spike (scripts/spike-tsgo.mjs) proved it boots + type-checks on Path B
// (it drives everything through globalThis.fs, which is our real Node fs over the
// VFS). This packs the wasm + a CJS-normalized copy of the Go engine into ONE
// gzipped asset the kernel worker fetches once and unpacks into the VFS (see
// packages/kernel-host/load-real-tsgo.js).
//
// Same archive layout as the npm/corepack packers:
//   [u32le headerLen][headerJSON][file bytes ...]        then gzip the whole lot
//   header = { version, files: [{ p: relPath, o: offset, l: length }, ... ] }
//
// The Go engine we ship is EXTRACTED from tsgo-wasm's ESM launcher (its `const
// encoder … class Go { … }` section) and wrapped as a CJS module exporting `Go`,
// with `fs` bound to globalThis.fs (the fd-1/2-routing fs the loader installs).
// We drop the launcher's ESM import header and its boot tail (our loader supplies
// the argv/env/wasm-instantiate bootstrap instead).
//
// Build artifact (gitignored), rebuilt by `npm run vendor:tsgo`. Idempotent
// (--force rebuilds).
//
// Usage: node scripts/vendor-tsgo.mjs [--force]

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const VENDOR_DIR = process.env.OC_VENDOR_TSGO_DIR || "/tmp/oc-vendor-tsgo";
const VENDOR_TSGO = path.join(VENDOR_DIR, "node_modules", "tsgo-wasm");
const OUT_DIR = path.join(ROOT, "packages", "studio", "public", "vendor");
// Gzip-compressed but deliberately NOT named `.gz` (static servers would set
// Content-Encoding: gzip and the browser would double-decompress). See vendor-npm.
const OUT_FILE = path.join(OUT_DIR, "tsgo-pack.bin");

const force = process.argv.includes("--force");

function log(msg) {
  process.stderr.write(`[vendor-tsgo] ${msg}\n`);
}

if (fs.existsSync(OUT_FILE) && !force) {
  log(`asset already present: ${path.relative(ROOT, OUT_FILE)} (use --force to rebuild)`);
  process.exit(0);
}

// 1) Vendor tsgo-wasm into a scratch dir (host npm/network needed once).
if (!fs.existsSync(path.join(VENDOR_TSGO, "tsgo.wasm")) || force) {
  log(`installing tsgo-wasm into ${VENDOR_DIR} …`);
  fs.rmSync(VENDOR_DIR, { recursive: true, force: true });
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  try {
    execSync(`npm install tsgo-wasm --no-save --no-audit --no-fund --loglevel=error`, {
      cwd: VENDOR_DIR,
      stdio: ["ignore", "ignore", "inherit"],
    });
  } catch (e) {
    log(`FAILED to vendor tsgo-wasm (need network + host npm): ${(e && e.message) || e}`);
    process.exit(1);
  }
} else {
  log(`reusing vendored tsgo-wasm at ${VENDOR_TSGO}`);
}

const WASM_SRC = path.join(VENDOR_TSGO, "tsgo.wasm");
const LAUNCHER_SRC = path.join(VENDOR_TSGO, "tsgo-wasm");
if (!fs.existsSync(WASM_SRC) || !fs.existsSync(LAUNCHER_SRC)) {
  log(`vendored tsgo-wasm is missing tsgo.wasm / launcher — aborting`);
  process.exit(1);
}

const pkgJson = JSON.parse(fs.readFileSync(path.join(VENDOR_TSGO, "package.json"), "utf8"));
const VERSION = pkgJson.version || "0.0.0";

// 2) Extract the Go engine from the launcher and wrap it as a CJS module.
const launcher = fs.readFileSync(LAUNCHER_SRC, "utf8");
const startIdx = launcher.indexOf("const encoder");
const endIdx = launcher.indexOf("const go = new Go()");
if (startIdx === -1 || endIdx === -1) {
  log("could not locate the Go engine class in the tsgo-wasm launcher — layout changed?");
  process.exit(1);
}
const goEngine = launcher.slice(startIdx, endIdx).trim();
const wasmExecCjs = `// OpenContainer: Go js/wasm engine extracted VERBATIM from tsgo-wasm@${VERSION}'s
// launcher and wrapped as CJS. \`fs\` is globalThis.fs — the loader installs an fs
// whose fd 1/2 writes go to the terminal (see load-real-tsgo.js). Do not edit the
// engine body; re-run \`npm run vendor:tsgo --force\` to refresh.
const fs = globalThis.fs;

${goEngine}

module.exports = { Go };
`;

// 3) Assemble the flat file list: the wasm + our generated engine module.
const wasmBytes = fs.readFileSync(WASM_SRC);
const engineBytes = Buffer.from(wasmExecCjs, "utf8");
const entries = [
  { rel: "tsgo.wasm", bytes: wasmBytes },
  { rel: "wasm_exec.cjs", bytes: engineBytes },
];
log(`packing ${entries.length} files (${(entries.reduce((n, e) => n + e.bytes.length, 0) / 1e6).toFixed(1)} MB raw) …`);

// 4) Build the archive: header (path/offset/length index) + concatenated bytes.
const index = [];
let offset = 0;
for (const e of entries) {
  index.push({ p: e.rel, o: offset, l: e.bytes.length });
  offset += e.bytes.length;
}
const header = Buffer.from(JSON.stringify({ version: VERSION, files: index }), "utf8");
const headerLen = Buffer.alloc(4);
headerLen.writeUInt32LE(header.length, 0);
const blob = Buffer.concat(entries.map((e) => e.bytes));
const raw = Buffer.concat([headerLen, header, blob]);
const gz = zlib.gzipSync(raw, { level: 9 });

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, gz);
log(
  `wrote ${path.relative(ROOT, OUT_FILE)} — ${(gz.length / 1e6).toFixed(2)} MB gz ` +
    `(${(raw.length / 1e6).toFixed(1)} MB raw, tsgo-wasm@${VERSION})`,
);
