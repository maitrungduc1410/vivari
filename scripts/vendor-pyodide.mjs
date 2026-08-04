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
// fastapi (+ its closure: starlette, pydantic, pydantic-core, anyio, …) is
// vendored so the FastAPI template serves offline. Flask is NOT in Pyodide's
// distribution, so it installs from PyPI via micropip at runtime (needs network).
// jedi backs the editor's Python completion/hover/signatures/go-to-definition
// (see builtins/python-lsp.js). It IS in Pyodide's distribution, so it costs a
// same-origin wheel and nothing else; black is not, and is handled by
// PYPI_PACKAGES below.
// mypy is the type checker behind `mypy` / `python -m mypy` — the one thing the
// editor's language services cannot do, since jedi infers types but does not
// check them. Also in Pyodide's distribution, and the largest single wheel here
// (~6.6 MB), which is why it is fetched only when something imports it.
// httpx is the modern HTTP client, and Pyodide's build of it defaults to a
// JavascriptFetchTransport — so unlike requests it needed no realm patch, only
// to be here rather than a CDN fetch away. requests is vendored for the same
// reason: "talking to an API" should not be the one thing that needs the network
// twice.
const DEFAULT_PACKAGES = [
  "numpy", "pandas", "matplotlib", "fastapi", "micropip", "jedi", "mypy", "httpx", "requests",
  // sqlalchemy is the ORM half of the sqlite story the runtime already tells,
  // and rich is what makes a terminal program look like the READMEs do. Both are
  // pure Python and small; between them they cost about 6 MB.
  "sqlalchemy", "rich",
  // Without tzdata there is not one timezone on this machine: no /usr/share/
  // zoneinfo under Emscripten, so ZoneInfo("Asia/Tokyo") raises for every key
  // anyone would type. datetime.now() works, which is what makes it a trap -
  // the aware half of the datetime API is the half that silently isn't there.
  // Pyodide's own error says to loadPackage it, which needs the network; this
  // is a 350 KB zip of text files, so vendoring it retires the question.
  "tzdata",
];

// Wheels Pyodide does NOT distribute, fetched from PyPI and INJECTED into the
// lockfile so `loadPackage("black")` resolves them same-origin like any other.
//
// Why not leave black to micropip at runtime: micropip needs the network, and
// "format on save works when you are online" is not the feature. Every one of
// these is a pure-Python py3-none-any wheel — nothing is being cross-compiled
// here, it is a zip of .py files that Pyodide's loader can already unpack.
//
// Versions are PINNED. An unpinned editor formatter would reformat a whole
// codebase differently the day upstream changed a default, and the person it
// happened to would have no way to know why. The bridge spike checks these
// against the same versions run under the host's own CPython.
const PYPI_PACKAGES = [
  { name: "black", version: "26.5.1", imports: ["black", "blib2to3"], depends: ["click", "mypy-extensions", "packaging", "pathspec", "platformdirs", "pytokens"] },
  // black's three dependencies that Pyodide does not ship either. (click,
  // packaging and platformdirs ARE in the lock, so they are ordinary depends.)
  { name: "mypy-extensions", version: "1.1.0", imports: ["mypy_extensions"], depends: [] },
  { name: "pathspec", version: "1.1.1", imports: ["pathspec"], depends: [] },
  { name: "pytokens", version: "0.4.1", imports: ["pytokens"], depends: [] },
  // rich.markdown's dependency, which is not in Pyodide's index at ALL — so
  // without these two wheels that module is simply missing, whatever the lock
  // says. Pure Python, ~120 KB the pair.
  { name: "markdown-it-py", version: "4.0.0", imports: ["markdown_it"], depends: ["mdurl"] },
  { name: "mdurl", version: "0.1.2", imports: ["mdurl"], depends: [] },
  // Type stubs for the two vendored libraries that ship no types of their own
  // (checked, not assumed: everything else here has a py.typed). These are read
  // by mypy off the filesystem and never imported, so `imports` is empty — an
  // entry there would have loadPackagesFromImports pull a stub package into a
  // script's interpreter, where it is dead weight. Their own dependencies are
  // runtime dependencies of the libraries they describe, which are already here.
  { name: "types-requests", version: "2.33.0.20260508", imports: [], depends: [] },
  { name: "pandas-stubs", version: "3.0.5.260730", imports: [], depends: [] },
];

// Packages the lockfile under-declares: names they import at runtime that their
// `depends` does not list. Pyodide's mypy entry depends on `librt` alone, but a
// checked file raises ModuleNotFoundError for typing_extensions, then
// mypy_extensions, then pathspec — one at a time, each only once the previous is
// satisfied. That class of bug survives vendoring precisely because
// loadPackage() succeeds: the wheel is there, and the import fails later, in
// front of the user. Naming the missing deps here fixes both halves at once —
// the closure below fetches their wheels, and the lock Pyodide reads pulls them
// in. mypy_extensions and pathspec cost nothing extra; black already vendors them.
const DEPENDS_FIXUPS = {
  mypy: ["typing-extensions", "mypy-extensions", "pathspec"],
  // rich's lock entry declares NO dependencies at all, and rich imports both of
  // these lazily — so `import rich` succeeds, `rich.syntax` raises
  // ModuleNotFoundError: pygments, and the failure arrives at the one line of a
  // program that highlights something. Same class of bug as mypy's, found the
  // same way: by importing every submodule rather than the package.
  rich: ["pygments", "markdown-it-py"],
  "markdown-it-py": ["mdurl"],
};

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
const requestedKey = [...PACKAGES, ...PYPI_PACKAGES.map((p) => p.name + "@" + p.version)].sort().join(",");

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

// Map a lock key insensitively AND separator-insensitively: `depends` entries
// mix hyphens/underscores (e.g. pydantic depends on "pydantic_core" while the
// lock key is "pydantic-core"), so normalize both before comparing — otherwise
// such deps silently drop out of the closure and only load from the CDN.
const normName = (s) => String(s).toLowerCase().replace(/[-_.]+/g, "-");
function findKey(name) {
  if (allPackages[name]) return name;
  const n = normName(name);
  return Object.keys(allPackages).find((k) => normName(k) === n) || null;
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
// A PyPI package's dependencies that DO live in the lock have to join the
// closure here, before the download loop — injecting the lock entry later (3b)
// is too late to get their wheels fetched. black depends on click, packaging and
// platformdirs, none of which any other vendored package pulls in, so without
// this `loadPackage("black")` resolves to a lock entry whose dependency wheels
// are not on disk and falls back to the CDN: a formatter that needs the network,
// which is the whole thing being avoided. Derived from the pins rather than
// listed again, so adding a dependency to PYPI_PACKAGES cannot forget this.
const fromPyPI = new Set(PYPI_PACKAGES.map((s) => normName(s.name)));
for (const spec of PYPI_PACKAGES) {
  for (const dep of spec.depends) {
    if (!fromPyPI.has(normName(dep))) addWithDeps(dep);
  }
}
// The under-declared deps join the closure on the same terms, so a fixup name
// that lives in the lock (typing-extensions) gets its wheel here, and one that
// comes from PyPI (mypy-extensions, pathspec) is left to 3b.
for (const target of Object.keys(DEPENDS_FIXUPS)) {
  if (!closure.has(findKey(target))) continue;
  for (const dep of DEPENDS_FIXUPS[target]) {
    if (!fromPyPI.has(normName(dep))) addWithDeps(dep);
  }
}
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

// 3b) Fetch the PyPI-only wheels and add them to the lock as first-class
// packages. Same best-effort contract as the CDN wheels above: a network failure
// warns and ships the rest, because a studio that boots without a formatter is
// far better than a build that will not finish.
async function vendorFromPyPI(spec) {
  const key = normName(spec.name);
  const url = `https://pypi.org/pypi/${encodeURIComponent(spec.name)}/${encodeURIComponent(spec.version)}/json`;
  const meta = await fetch(url);
  if (!meta.ok) {
    log(`  ! PyPI metadata for ${spec.name} ${spec.version} (HTTP ${meta.status})`);
    return false;
  }
  const body = await meta.json();
  // py3-none-any only. Anything else would be a compiled artifact built for a
  // platform that is not wasm32-emscripten, and Pyodide could not load it.
  const wheel = (body.urls || []).find(
    (u) => u.packagetype === "bdist_wheel" && /-py3-none-any\.whl$|-py2\.py3-none-any\.whl$/.test(u.filename),
  );
  if (!wheel) {
    log(`  ! ${spec.name} ${spec.version} has no pure-Python wheel — skipped`);
    return false;
  }
  const dest = path.join(OUT_DIR, wheel.filename);
  if (!fs.existsSync(dest) || force) {
    const res = await fetch(wheel.url);
    if (!res.ok) {
      log(`  ! failed ${wheel.filename} (HTTP ${res.status})`);
      return false;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    log(`  + ${wheel.filename} (${(buf.length / 1048576).toFixed(2)} MB, from PyPI)`);
  }
  allPackages[key] = {
    name: key,
    version: spec.version,
    file_name: wheel.filename, // relative -> resolved same-origin, never the CDN
    install_dir: "site",
    package_type: "package",
    sha256: (wheel.digests && wheel.digests.sha256) || "",
    imports: spec.imports,
    depends: spec.depends,
    unvendored_tests: false,
  };
  vendored.add(key);
  return true;
}

let pypiOk = 0;
for (const spec of PYPI_PACKAGES) {
  try {
    // eslint-disable-next-line no-await-in-loop
    if (await vendorFromPyPI(spec)) pypiOk++;
  } catch (e) {
    log(`  ! failed ${spec.name}: ${(e && e.cause && e.cause.code) || (e && e.message) || e}`);
  }
}
log(`vendored ${pypiOk}/${PYPI_PACKAGES.length} wheels from PyPI (the editor's formatter)`);
if (pypiOk < PYPI_PACKAGES.length) {
  log("NOTE: black is incomplete — Format Document will report itself unavailable rather than no-op.");
}

// 3c) Record the under-declared deps in the lock the browser reads, now that 3b
// has put the PyPI-sourced ones in it. After this, `loadPackage("mypy")` — and
// so `loadPackagesFromImports` on any file that imports mypy — pulls the whole
// set, instead of loading mypy and failing on its first import.
for (const [target, extras] of Object.entries(DEPENDS_FIXUPS)) {
  const key = findKey(target);
  if (!key) continue;
  const pkg = allPackages[key];
  const have = new Set((pkg.depends || []).map(normName));
  for (const dep of extras) {
    if (have.has(normName(dep))) continue;
    const depKey = findKey(dep);
    if (!depKey) {
      log(`  ! ${key}: dependency ${dep} is not in the lock — mypy will fail on import`);
      continue;
    }
    pkg.depends = [...(pkg.depends || []), depKey];
    have.add(normName(dep));
  }
  log(`depends fixup: ${key} -> ${(pkg.depends || []).join(", ")}`);
}

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