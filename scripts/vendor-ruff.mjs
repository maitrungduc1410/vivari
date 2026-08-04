// vendor-ruff — put ruff, the Python linter and formatter, on the same-origin
// vendor path so `ruff check` works with no network and no Pyodide.
//
// Why this is not a Python package: ruff is Rust, and roadmap.md wrote it off
// for exactly that reason — "not in Pyodide's index at all", which is true and
// turned out not to matter. Astral publish it compiled to WebAssembly with
// wasm-bindgen glue (@astral-sh/ruff-wasm-web), so it is a module this runtime
// can load directly. It never enters the interpreter: `ruff check` on a project
// with no Pyodide booted costs the wasm and nothing else, which is the whole
// reason it can also run on every keystroke in the editor where mypy cannot.
//
// The web build rather than the -nodejs or -bundler one, because it is ESM that
// takes its wasm as bytes: the guest has no fetch for host assets (it pulls them
// through a blocking syscall) and the studio worker does, and both can hand the
// same bytes to the same init.
//
// Build artifact, gitignored, same as the other vendor steps. Rebuild with
// `npm run vendor:ruff` (--force to refetch).
//
// Usage: node scripts/vendor-ruff.mjs [--force]

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const SCRATCH = process.env.VV_VENDOR_RUFF_DIR || "/tmp/vv-vendor-ruff";
const PKG = "@astral-sh/ruff-wasm-web";
// Pinned. An unpinned linter changes its mind about a codebase on a Tuesday,
// and the person it happens to has no way to connect it to anything they did.
const VERSION = "0.16.1";
const OUT_DIR = path.join(ROOT, "packages", "studio", "public", "vendor", "ruff");
// The two files the loader needs, plus the licence, which has to travel with it.
const FILES = ["ruff_wasm.js", "ruff_wasm_bg.wasm", "LICENSE"];

const force = process.argv.includes("--force");
const log = (msg) => process.stderr.write(`[vendor-ruff] ${msg}\n`);

if (FILES.every((f) => fs.existsSync(path.join(OUT_DIR, f))) && !force) {
  log(`already vendored: ${path.relative(ROOT, OUT_DIR)} (use --force to refetch)`);
  process.exit(0);
}

const installed = path.join(SCRATCH, "node_modules", PKG);
if (!fs.existsSync(path.join(installed, "ruff_wasm_bg.wasm")) || force) {
  log(`installing ${PKG}@${VERSION} into ${SCRATCH} …`);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  try {
    execSync(`npm install ${PKG}@${VERSION} --no-save --no-audit --no-fund --loglevel=error`, {
      cwd: SCRATCH,
      stdio: ["ignore", "ignore", "inherit"],
    });
  } catch (e) {
    log(`FAILED to fetch ${PKG} (needs network + host npm): ${(e && e.message) || e}`);
    process.exit(1);
  }
} else {
  log(`reusing ${installed}`);
}

const version = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8")).version;
if (version !== VERSION) {
  log(`FAILED: asked for ${VERSION}, npm gave ${version}`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
let total = 0;
for (const file of FILES) {
  const src = path.join(installed, file);
  if (!fs.existsSync(src)) {
    log(`FAILED: ${PKG}@${version} has no ${file} — its layout changed`);
    process.exit(1);
  }
  const bytes = fs.readFileSync(src);
  fs.writeFileSync(path.join(OUT_DIR, file), bytes);
  total += bytes.length;
}
// The CLI prints this, so it is the version the user is told they are running.
fs.writeFileSync(path.join(OUT_DIR, "version.txt"), version + "\n");

log(
  `wrote ${path.relative(ROOT, OUT_DIR)} — ${(total / 1e6).toFixed(1)} MB (ruff ${version}), ` +
    `fetched only when something asks for it`,
);
