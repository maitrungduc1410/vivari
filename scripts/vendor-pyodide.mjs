// vendor-pyodide — assemble the same-origin Pyodide (Python/WASM) distribution
// the studio serves for its lazy `python` runtime.
//
// Sibling of scripts/vendor-tsgo.mjs / vendor-npm.mjs, but simpler: Pyodide is
// loaded by the BROWSER at runtime (loadPyodide fetches its own wasm + stdlib +
// wheels from a same-origin `indexURL`), so we do NOT pack it into a VFS asset.
// We just copy Pyodide's core files — plus a curated closure of prebuilt package
// wheels (numpy, pandas, …) — into packages/studio/public/vendor/pyodide/, which
// ships inside each app's output and is served cross-origin-isolated (COEP-safe).
//
// Nothing here loads at studio boot: the whole tree is fetched only the first
// time a `python` process runs (see packages/runtime/builtins/python.js).
//
// How it works:
//   1) `npm install pyodide` into a scratch dir to get the CORE files that ship
//      on npm (pyodide.mjs / pyodide.asm.mjs / pyodide.asm.wasm / python_stdlib.zip
//      / pyodide-lock.json). These do NOT include package wheels.
//   2) Parse pyodide-lock.json, compute the dependency CLOSURE of a configurable
//      package list (default: numpy, pandas, micropip), and download each wheel
//      from the matching jsDelivr "full" channel for the EXACT installed version.
//   3) Rewrite pyodide-lock.json as a HYBRID lock: vendored wheels keep their
//      relative file_name (resolved same-origin → offline), every other package's
//      file_name is rewritten to its absolute jsDelivr URL. Pyodide resolves each
//      package independently, so anything we didn't vendor transparently falls
//      back to the CDN at runtime instead of 404-ing / "No known package"-ing.
//
// Configure the vendored package set with VV_PYODIDE_PACKAGES (comma-separated).
// Build artifact (gitignored, /packages/studio/public/vendor). Idempotent unless
// --force. Usage: node scripts/vendor-pyodide.mjs [--force]

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const SCRATCH = process.env.VV_VENDOR_PYODIDE_DIR || "/tmp/vv-vendor-pyodide";
const OUT_DIR = path.join(ROOT, "packages", "studio", "public", "vendor", "pyodide");

// The core files npm's `pyodide` package ships (see the package's file listing).
// pyodide.asm.js was renamed to pyodide.asm.mjs in Pyodide 314.x; copy whichever
// exists so this keeps working across the rename.
const CORE_FILES = [
  "pyodide.mjs",
  "pyodide.asm.mjs",
  "pyodide.asm.js",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
  "pyodide-lock.json",
];

// Prebuilt package wheels to vendor for offline use. Their transitive `depends`
// closure is resolved from the lockfile and pulled in automatically. micropip is
// included so `python -m pip install <pure-python-pkg>` can bootstrap.
const DEFAULT_PACKAGES = ["numpy", "pandas", "matplotlib", "micropip"];
const PACKAGES = (process.env.VV_PYODIDE_PACKAGES || DEFAULT_PACKAGES.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const force = process.argv.includes("--force");
// Bump when the vendored tree / lock schema changes so an existing install is
// rebuilt on the NEXT run even without --force. v2 = hybrid lock (vendored
// wheels relative/same-origin, everything else rewritten to its absolute CDN
// URL) instead of the old filtered-to-vendored-only lock.
const LOCK_FORMAT = 2;
// Records what was vendored so a changed package set / lock format (or --force)
// rebuilds, but a repeat build with the SAME set + format is a no-op. Keyed on
// the sorted requested set.
const MARKER = path.join(OUT_DIR, ".vendor-manifest.json");
const requestedKey = [...PACKAGES].sort().join(",");

function log(msg) {
  process.stderr.write(`[vendor-pyodide] ${msg}\n`);
}

if (!force && fs.existsSync(path.join(OUT_DIR, "pyodide.mjs")) && fs.existsSync(MARKER)) {
  try {
    const prev = JSON.parse(fs.readFileSync(MARKER, "utf8"));
    if (prev && prev.packagesKey === requestedKey && prev.lockFormat === LOCK_FORMAT) {
      log(`already present: ${path.relative(ROOT, OUT_DIR)} (packages: ${requestedKey || "core only"}; use --force to rebuild)`);
      process.exit(0);
    }
    if (prev && prev.lockFormat !== LOCK_FORMAT) {
      log(`lock format changed (${prev && prev.lockFormat} -> ${LOCK_FORMAT}) — rebuilding`);
    } else {
      log(`package set changed (${prev && prev.packagesKey} -> ${requestedKey}) — rebuilding`);
    }
  } catch {
    /* unreadable marker — rebuild */
  }
}

// Fresh build: clear any prior (possibly different) vendored tree so stale wheels
// from an earlier package set don't linger.
fs.rmSync(OUT_DIR, { recursive: true, force: true });

// 1) Install the pyodide npm package into a scratch dir (host npm + network).
const PKG_DIR = path.join(SCRATCH, "node_modules", "pyodide");
if (!fs.existsSync(path.join(PKG_DIR, "pyodide.mjs")) || force) {
  log(`installing pyodide into ${SCRATCH} …`);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  try {
    execSync(`npm install pyodide --no-save --no-audit --no-fund --loglevel=error`, {
      cwd: SCRATCH,
      stdio: ["ignore", "ignore", "inherit"],
    });
  } catch (e) {
    log(`FAILED to install pyodide (need network + host npm): ${(e && e.message) || e}`);
    process.exit(1);
  }
} else {
  log(`reusing installed pyodide at ${PKG_DIR}`);
}

const pkgJson = JSON.parse(fs.readFileSync(path.join(PKG_DIR, "package.json"), "utf8"));
const VERSION = pkgJson.version;
if (!VERSION) {
  log("could not read pyodide version from package.json — aborting");
  process.exit(1);
}
log(`pyodide version ${VERSION}`);

fs.mkdirSync(OUT_DIR, { recursive: true });

// 2) Copy core files.
for (const name of CORE_FILES) {
  const src = path.join(PKG_DIR, name);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(OUT_DIR, name));
    log(`copied ${name}`);
  }
}

// 3) Resolve the package closure from the lockfile and download wheels.
const lockPath = path.join(OUT_DIR, "pyodide-lock.json");
if (!fs.existsSync(lockPath)) {
  log("pyodide-lock.json missing — aborting");
  process.exit(1);
}
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const allPackages = lock.packages || {};

// Map an lock key insensitively (lockfile keys are usually lowercased).
function findKey(name) {
  if (allPackages[name]) return name;
  const lc = name.toLowerCase();
  return Object.keys(allPackages).find((k) => k.toLowerCase() === lc) || null;
}

const closure = new Set();
const missing = [];
function addWithDeps(name) {
  const key = findKey(name);
  if (!key) {
    missing.push(name);
    return;
  }
  if (closure.has(key)) return;
  closure.add(key);
  for (const dep of allPackages[key].depends || []) addWithDeps(dep);
}
for (const p of PACKAGES) addWithDeps(p);
if (missing.length) log(`WARNING: packages not in lockfile, skipped: ${missing.join(", ")}`);
log(`vendoring ${closure.size} package wheels (closure of: ${PACKAGES.join(", ")})`);

const CDN_BASE = `https://cdn.jsdelivr.net/pyodide/v${VERSION}/full/`;

// Downloading wheels is BEST-EFFORT: the core Pyodide runtime (copied above)
// runs plain Python fine without them — the wheels only back the "Data Science"
// template (numpy/pandas) and micropip. A network/TLS failure here (e.g. a
// corporate MITM proxy → UNABLE_TO_GET_ISSUER_CERT_LOCALLY) must NOT abort
// `npm run dev`; we warn, ship whatever downloaded, and let the user retry.
async function download(fileName) {
  const dest = path.join(OUT_DIR, fileName);
  if (fs.existsSync(dest) && !force) return true;
  const url = CDN_BASE + fileName;
  const res = await fetch(url);
  if (!res.ok) {
    log(`  ! failed ${fileName} (HTTP ${res.status})`);
    return false;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  log(`  + ${fileName} (${(buf.length / 1048576).toFixed(1)} MB)`);
  return true;
}

// Only packages whose wheel actually landed on disk go into the filtered lock,
// so the runtime never asks Pyodide for a wheel we didn't ship.
const vendored = new Set();
for (const key of closure) {
  const fileName = allPackages[key].file_name;
  if (!fileName) continue;
  let ok = false;
  try {
    // eslint-disable-next-line no-await-in-loop
    ok = await download(fileName);
  } catch (e) {
    const cause = (e && e.cause && e.cause.code) || (e && e.message) || e;
    log(`  ! failed ${fileName}: ${cause}`);
    ok = false;
  }
  if (ok) vendored.add(key);
}
const okCount = vendored.size;
log(`downloaded ${okCount}/${closure.size} wheels from ${CDN_BASE}`);

// 4) Rewrite the lockfile so EVERY package Pyodide knows stays loadable, with a
// hybrid resolution: wheels we vendored keep their relative file_name (Pyodide
// resolves them against the same-origin packageBaseUrl → offline), and every
// other package's file_name is rewritten to its ABSOLUTE jsDelivr URL. Pyodide
// resolves `new URL(file_name, base)` per package and treats a file_name
// containing "://" as absolute, so unvendored packages transparently fall back
// to the CDN at runtime (the browser can reach it even where Node's vendor-time
// fetch was blocked by a corporate TLS proxy). This keeps the whole package
// catalog usable — offline where vendored, online otherwise — instead of a
// filtered lock that 404s / "No known package"s on anything we didn't ship.
let cdnCount = 0;
for (const [key, pkg] of Object.entries(allPackages)) {
  if (!pkg || typeof pkg.file_name !== "string") continue;
  if (vendored.has(key)) continue; // vendored → keep relative (same-origin)
  if (pkg.file_name.includes("://")) continue; // already absolute
  pkg.file_name = CDN_BASE + pkg.file_name;
  cdnCount++;
}
fs.writeFileSync(lockPath, JSON.stringify(lock));
log(`wrote pyodide-lock.json (${vendored.size} vendored, ${cdnCount} via CDN)`);

if (okCount < closure.size) {
  const failed = [...closure].filter((k) => !vendored.has(k));
  log(`NOTE: ${closure.size - okCount}/${closure.size} requested wheel(s) not vendored offline: ${failed.join(", ")}`);
  log("  They will be fetched from the Pyodide CDN at runtime (needs network in the browser).");
  log("  To vendor them offline instead, once your network/TLS allows it:");
  log("    - point Node at your proxy's root CA:  export NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem");
  log("    - then re-run:                         npm run vendor:pyodide -- --force");
}

// Record only what was actually vendored so a later `--force` re-attempts the
// missing wheels, while a repeat `npm run dev` with the same set stays a no-op.
fs.writeFileSync(
  MARKER,
  JSON.stringify(
    {
      version: VERSION,
      lockFormat: LOCK_FORMAT,
      packagesKey: requestedKey,
      requested: [...closure],
      packages: [...vendored],
    },
    null,
    2,
  ),
);
log(`done → ${path.relative(ROOT, OUT_DIR)}`);