// The per-project Python package store, and pip's read-only verbs.
//
// WHY THIS EXISTS. Every `python` command boots a fresh Pyodide (see the
// one-Pyodide-per-process note in builtins/python.js), so an install made by one
// process was gone by the next. We used to print `Installed: X` and then a
// paragraph explaining that X had already ceased to exist. This module makes the
// install real by persisting the bytes `pip` adds to the interpreter's
// site-packages, and restoring them into every later interpreter.
//
// WHERE IT LIVES: `<project>/.venv/lib/python3.14/site-packages`, alongside a
// real `pyvenv.cfg` and a `vivari-store.json` stamp. `.venv` is deliberate, not
// decorative — it is where a Python user already looks, and it makes
// `python -m venv .venv` a command that does something true instead of a missing
// module. But see renderPyvenvCfg(): it is a package store, NOT a second
// interpreter, and there is no isolation to be had when the whole VM shares one.
//
// WHY IT IS NOT THE ORDINARY MIRROR. builtins/python.js mirrors the project into
// Pyodide's filesystem and skips `.venv` via SKIP_DIRS. That skip is correct and
// must stay: the store belongs at Python's OWN site-packages path inside the
// interpreter, not at `<cwd>/.venv/...` where an import would never look, and
// copying it twice would double both the bytes and the time. So the store has
// its own deliberate path in and out, and SKIP_DIRS keeps the general mirror off
// it. It looks like an oversight; it is the opposite.

// ---------------------------------------------------------------------------
// Layout and stamp
// ---------------------------------------------------------------------------

export const STORE_DIR = ".venv";
export const STORE_STAMP_FILE = "vivari-store.json";

// Bump when the on-disk shape changes in a way an older/newer runtime cannot
// read. A stamp that does not match is DISCARDED, never partially loaded.
export const STORE_FORMAT = 1;

// A project that installs scipy persists ~13 MB; numpy alone is 10.1 MB (394
// files), measured in Pyodide 314.0.3. This has to hold a real scientific stack
// without letting a runaway install quietly eat the VFS, so it sits well above
// "numpy + pandas + scipy" and well below anything that would hurt.
export const STORE_MAX_BYTES = 64 * 1024 * 1024;

export function storePaths(cwd, pyTag) {
  const root = cwd.replace(/\/+$/, "") + "/" + STORE_DIR;
  return {
    root,
    stamp: root + "/" + STORE_STAMP_FILE,
    cfg: root + "/pyvenv.cfg",
    // Mirrors CPython's own venv layout, so the path a user sees is the path
    // they would see anywhere else.
    sitePackages: root + "/lib/" + pyTag + "/site-packages",
    // Where a real venv puts console scripts, and where ours puts the shims for
    // them. On PATH for processes started in this project, so an installed
    // package's command is spelled the way its README spells it.
    bin: root + "/bin",
  };
}

// ---------------------------------------------------------------------------
// Console scripts
// ---------------------------------------------------------------------------
// `pip install rich` puts a `rich` command on PATH everywhere else, and the
// metadata that says so is already in the store: every wheel that declares one
// ships `<dist>.dist-info/entry_points.txt`. Without this, `pip install httpie`
// succeeds, `httpie` says "not found", and the only way to run the thing you
// installed is to know the module name it hides behind.

/**
 * The `[console_scripts]` section of an entry_points.txt, as {name: "mod:attr"}.
 * Other sections are ignored: `gui_scripts` has nowhere to go here, and the
 * plugin sections (pytest11 and friends) are not commands at all.
 */
export function parseEntryPoints(text) {
  const out = {};
  let inSection = false;
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inSection = line.toLowerCase() === "[console_scripts]";
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const name = line.slice(0, eq).trim();
    // "pkg.module:func [extra]" — the extras marker selects optional
    // dependencies and is not part of what to import.
    const target = line.slice(eq + 1).trim().replace(/\s*\[.*\]$/, "");
    if (name && target && !name.includes("/")) out[name] = target;
  }
  return out;
}

/**
 * The program a console script becomes here: a JS shim, like every other thing
 * on PATH, that spawns the interpreter and calls the entry point.
 *
 * The loader is what a real console script does — set argv[0] to the command
 * name, import, call, exit with the return value — because tools read all three.
 * argv[0] matters more than it looks: argparse prints it in usage, so getting it
 * wrong makes `rich --help` explain how to use `-c`.
 */
export function consoleScriptSource(name, target) {
  const [module, attr] = String(target).split(":");
  const loader = [
    "import sys, importlib",
    `sys.argv[0] = ${JSON.stringify(name)}`,
    `_t = importlib.import_module(${JSON.stringify(module)})`,
    ...(attr ? [`for _p in ${JSON.stringify(attr)}.split("."): _t = getattr(_t, _p)`] : []),
    // A console script's return value IS its exit code (None means 0), which is
    // how `mytool && echo ok` works anywhere else.
    attr ? "sys.exit(_t())" : "sys.exit(0)",
  ].join("\n");
  return `
'use strict';
const cp = require('child_process');
const child = cp.spawn('python', ['-c', ${JSON.stringify(loader)}].concat(process.argv.slice(2)), { cwd: process.cwd(), env: process.env });
if (child.stdout) child.stdout.on('data', (d) => process.stdout.write(d));
if (child.stderr) child.stderr.on('data', (d) => process.stderr.write(d));
child.on('exit', (code) => process.exit(code | 0));
child.on('error', (e) => { process.stderr.write(${JSON.stringify(name)} + ': ' + ((e && e.message) || e) + String.fromCharCode(10)); process.exit(1); });
`;
}

/**
 * Commands a generated shim must never take over.
 *
 * .venv/bin comes BEFORE /bin on PATH, which is correct — a project's own tools
 * should win — but the /bin entries for these are not merely another way to
 * reach the same module. Each is a seam: `pytest` goes through the launcher arm
 * that turns pytest's exit code into the process's, `pip` is the package store
 * itself, `uvicorn`/`flask`/`gunicorn` are the WSGI/ASGI bridge that exists
 * because there are no sockets. Installing pytest and getting a shim that calls
 * console_main directly would quietly undo the seam, and `pytest && deploy`
 * would start lying again.
 *
 * spike-python-offline.mjs checks this set against the delegate table, so
 * putting a new seam on PATH without protecting it fails there.
 */
export const RESERVED_COMMANDS = new Set([
  "python", "python3", "pip", "pip3", "uvicorn", "flask", "gunicorn", "pytest", "black", "mypy",
  // ruff matters more than the rest: `pip install ruff` succeeds and installs a
  // console script that execs a Rust binary which cannot run here at all. Left
  // unprotected it would replace a working ruff with one that cannot start.
  "ruff",
]);

/**
 * Bring .venv/bin into line with what the store currently holds — writing the
 * shims for what is installed and removing the ones for what is not.
 *
 * Regenerating rather than appending is what makes uninstall work: `pip
 * uninstall rich` deletes the package, and a `rich` command left behind on PATH
 * would spawn an interpreter to fail at the import.
 */
export function writeConsoleScripts(fs, cwd, env) {
  const p = storePaths(cwd, env.pyTag);
  const wanted = new Map();
  for (const rel of walkHost(fs, p.sitePackages).keys()) {
    if (!/(^|\/)[^/]+\.dist-info\/entry_points\.txt$/.test(rel)) continue;
    let text = "";
    try {
      text = String(fs.readFileSync(p.sitePackages + "/" + rel));
    } catch {
      continue; // unreadable metadata is not worth failing an install over
    }
    for (const [name, target] of Object.entries(parseEntryPoints(text))) {
      if (RESERVED_COMMANDS.has(name)) continue;
      wanted.set(name, target);
    }
  }

  fs.mkdirSync(p.bin, { recursive: true });
  let existing = [];
  try {
    existing = fs.readdirSync(p.bin);
  } catch {
    /* just created; nothing there */
  }
  for (const file of existing) {
    const name = String(file).replace(/\.js$/, "");
    if (!wanted.has(name)) {
      try {
        fs.unlinkSync(p.bin + "/" + file);
      } catch {
        /* already gone */
      }
    }
  }
  for (const [name, target] of wanted) {
    fs.writeFileSync(p.bin + "/" + name + ".js", consoleScriptSource(name, target));
  }
  return [...wanted.keys()].sort();
}

// CPython's venv writes this file and keys several behaviours off it, so we
// write the same keys with values that are true here. `include-system-site-
// packages = true` is not a default we picked: there is exactly one interpreter
// and it always sees its own site-packages, so writing `false` would be a claim
// of isolation we cannot keep.
export function renderPyvenvCfg({ pyTag, pythonVersion, pyodideVersion, command }) {
  return [
    "home = /lib/" + pyTag,
    "include-system-site-packages = true",
    "version = " + pythonVersion,
    "executable = /lib/" + pyTag + "/python",
    "command = " + command,
    "",
    "# Vivari: this is a package STORE, not a second interpreter. Every `python`",
    "# command boots one fresh CPython/WASM interpreter and restores the",
    "# site-packages below into it; there is no separate binary to activate and",
    "# no isolation from anything, which is why include-system-site-packages is",
    "# true above. Delete this directory to start over.",
    "",
  ].join("\n");
}

export function makeStamp({ pyTag, pythonVersion, pyodideVersion, files, bytes }) {
  return {
    storeFormat: STORE_FORMAT,
    pyTag,
    pythonVersion,
    pyodideVersion,
    files,
    bytes,
    updated: new Date().toISOString(),
  };
}

// Returns null when the store is safe to restore, or a human sentence naming
// exactly what does not match. The caller DISCARDS on any non-null answer —
// a half-restored site-packages, where some of a package's files are the old
// build and some are missing, is the worst outcome available here: imports
// would half-work and the failure would surface far from the cause.
export function stampProblem(stamp, env) {
  if (!stamp || typeof stamp !== "object") return "it has no vivari-store.json stamp";
  if (stamp.storeFormat !== STORE_FORMAT) {
    return `it was written in store format ${stamp.storeFormat}, and this runtime reads format ${STORE_FORMAT}`;
  }
  if (stamp.pythonVersion !== env.pythonVersion) {
    return `it was built for Python ${stamp.pythonVersion}, and this interpreter is Python ${env.pythonVersion}`;
  }
  if (stamp.pyodideVersion !== env.pyodideVersion) {
    return `it was built under Pyodide ${stamp.pyodideVersion}, and this one is Pyodide ${env.pyodideVersion}`;
  }
  return null;
}

// What the user sees when the cap fires. Exported so the offline spike can hold
// it to naming all three things a person needs — how big, how big is allowed,
// and the two ways out — without an interpreter.
export function storeCapError(verdict, names) {
  return (
    `pip: not persisted - ${STORE_DIR}/ would reach ${humanBytes(verdict.projected)}, over the ` +
    `${humanBytes(verdict.max)} limit.\n` +
    `     ${(names || []).join(", ")} installed into this interpreter, which exits with\n` +
    "     this command, so nothing was kept. The store was left exactly as it was.\n" +
    "     Make room with 'pip uninstall <package>', or start over with\n" +
    `     'python -m venv --clear ${STORE_DIR}'.\n`
  );
}

export function humanBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / (1024 * 1024)).toFixed(1) + " MB";
}

// ---------------------------------------------------------------------------
// Reading and writing the store
// ---------------------------------------------------------------------------
//
// `fs` is passed in rather than imported: inside the VM it is the guest's
// node:fs, and in scripts/spike-python-bridge.mjs it is the real one, which is
// what lets that spike drive the SHIPPED store against a real interpreter
// instead of a copy of it. Everything here is deliberately free of `process`
// and of the runtime's closure for the same reason.

export function pyEnv(pyodide) {
  const info = JSON.parse(
    pyodide.runPython(
      "import json, sys, sysconfig\n" +
        'json.dumps({"pyTag": f"python{sys.version_info.major}.{sys.version_info.minor}",\n' +
        '            "pythonVersion": sys.version.split()[0],\n' +
        '            "sitePackages": sysconfig.get_path("purelib").replace("//", "/")})',
    ),
  );
  info.pyodideVersion = String(pyodide.version || "");
  return info;
}

// rel -> size, for both filesystems. The delta an install produced is a set
// difference over these, which is why the two walks return the same shape.
export function walkPyodide(pyodide, root) {
  const out = new Map();
  const walk = (dir, rel) => {
    let names;
    try {
      names = pyodide.FS.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === "." || name === "..") continue;
      const full = dir + "/" + name;
      const r = rel ? rel + "/" + name : name;
      let st;
      try {
        st = pyodide.FS.stat(full);
      } catch {
        continue;
      }
      if (pyodide.FS.isDir(st.mode)) walk(full, r);
      else if (pyodide.FS.isFile(st.mode)) out.set(r, st.size);
    }
  };
  walk(root, "");
  return out;
}

export function walkHost(fs, root) {
  const out = new Map();
  const walk = (dir, rel) => {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = dir + "/" + name;
      const r = rel ? rel + "/" + name : name;
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, r);
      else if (st.isFile()) out.set(r, st.size);
    }
  };
  walk(root, "");
  return out;
}

export function readStamp(fs, cwd) {
  try {
    return JSON.parse(fs.readFileSync(storePaths(cwd, "x").stamp, "utf8"));
  } catch {
    return null;
  }
}

// Copies the store into the interpreter's OWN site-packages — not into
// <cwd>/.venv, where no import would ever look. On a stamp mismatch NOTHING is
// copied: a half-restored site-packages imports half a package and then fails
// somewhere else entirely, which is worse than not having it at all.
export function restoreStore(fs, pyodide, cwd) {
  const env = pyEnv(pyodide);
  const stamp = readStamp(fs, cwd);
  if (!stamp) return { state: "absent", env };
  const problem = stampProblem(stamp, env);
  if (problem) return { state: "discarded", problem, env, stamp };
  const p = storePaths(cwd, env.pyTag);
  let files = 0;
  let bytes = 0;
  for (const [rel, size] of walkHost(fs, p.sitePackages)) {
    const target = env.sitePackages + "/" + rel;
    try {
      const slash = target.lastIndexOf("/");
      if (slash > 0) pyodide.FS.mkdirTree(target.slice(0, slash));
      const buf = fs.readFileSync(p.sitePackages + "/" + rel);
      pyodide.FS.writeFile(target, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      files++;
      bytes += size;
    } catch {
      /* one unreadable file must not take the rest of the store with it */
    }
  }
  return { state: "restored", files, bytes, env };
}

// What an install added to site-packages, against a baseline taken before it.
export function collectDelta(pyodide, env, baseline) {
  const delta = new Map();
  for (const [rel, size] of walkPyodide(pyodide, env.sitePackages)) {
    if (baseline.get(rel) === size) continue;
    delta.set(rel, size);
  }
  return delta;
}

// Total the store WOULD reach if this delta were written.
export function projectedSize(fs, cwd, env, delta) {
  const merged = walkHost(fs, storePaths(cwd, env.pyTag).sitePackages);
  for (const [rel, size] of delta) merged.set(rel, size);
  let bytes = 0;
  for (const size of merged.values()) bytes += size;
  return bytes;
}

// The whole write, cap check included, so that "over the cap changes nothing"
// is a property of one function rather than of the order two callers happen to
// do things in. Returns {ok:false} having touched nothing at all — a store
// grown half way to a package it cannot finish is the same partial-state
// failure the version stamp exists to prevent, arrived at from the other side.
//
// `max` is a parameter so the spike can drive a real install into a cap it will
// certainly exceed, instead of having to manufacture 64 MB of packages.
export function persistDelta(fs, pyodide, cwd, env, delta, command, max = STORE_MAX_BYTES) {
  const projected = projectedSize(fs, cwd, env, delta);
  if (projected > max) return { ok: false, projected, max };
  const additions = new Map();
  for (const rel of delta.keys()) {
    try {
      additions.set(rel, pyodide.FS.readFile(env.sitePackages + "/" + rel));
    } catch {
      /* vanished between the walk and the read */
    }
  }
  return { ok: true, projected, ...writeStore(fs, cwd, env, additions, command) };
}

export function writeStore(fs, cwd, env, additions, command) {
  const p = storePaths(cwd, env.pyTag);
  fs.mkdirSync(p.sitePackages, { recursive: true });
  for (const [rel, data] of additions || []) {
    const target = p.sitePackages + "/" + rel;
    fs.mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(target, globalThis.Buffer.from(data));
  }
  const scripts = writeConsoleScripts(fs, cwd, env);
  const now = walkHost(fs, p.sitePackages);
  let bytes = 0;
  for (const size of now.values()) bytes += size;
  fs.writeFileSync(
    p.cfg,
    renderPyvenvCfg({
      pyTag: env.pyTag,
      pythonVersion: env.pythonVersion,
      pyodideVersion: env.pyodideVersion,
      command,
    }),
  );
  fs.writeFileSync(
    p.stamp,
    JSON.stringify(
      makeStamp({
        pyTag: env.pyTag,
        pythonVersion: env.pythonVersion,
        pyodideVersion: env.pyodideVersion,
        files: now.size,
        bytes,
      }),
      null,
      2,
    ) + "\n",
  );
  return { files: now.size, bytes, scripts };
}

// Only what the STORE holds. A fresh interpreter always has micropip, and
// whatever a loadPackage pulled in; listing those would make `pip freeze`
// describe something other than the thing it claims to describe. Membership is
// decided by the store's own directory listing, so freeze cannot drift from the
// store — it is derived from it.
export function storeDists(fs, cwd, env, dists) {
  const top = new Set();
  for (const rel of walkHost(fs, storePaths(cwd, env.pyTag).sitePackages).keys()) {
    const slash = rel.indexOf("/");
    top.add(slash === -1 ? rel : rel.slice(0, slash));
  }
  // `distInfo` is the directory name the interpreter actually reported, not one
  // rebuilt from name + version. Rebuilding it looks equivalent and is not: an
  // install escapes the project name per PEP 427, so charset-normalizer lands in
  // `charset_normalizer-3.4.9.dist-info`. Matching on `${name}-${version}` drops
  // every dashed package from the listing, which is a `pip freeze` that silently
  // omits four of requests' five dependencies.
  return (dists || []).filter((d) => d.distInfo && top.has(d.distInfo));
}

// micropip warns "a package 'X' was not found in loadedPackages" for anything it
// did not load itself — which, for a package restored from the store, is every
// single one. Its own comment calls the branch "this should not happen"; here it
// always happens, and it happens on **stdout**, which is where pip's own output
// goes. So a correct uninstall would print a warning about the store working,
// mixed into the lines a script might be reading.
//
// It has to be a filter and not a level. `micropip.uninstall` takes
// `verbose: bool = False` and opens with `ctx_level(verbose)`, which for False
// means setLevel(WARNING) — so a level set before the call is overwritten inside
// it. A filter on the logger survives that, names the one message it drops, and
// is removed afterwards, so nothing else micropip has to say is affected.
export function uninstallSource(name) {
  return [
    "import logging, micropip",
    "",
    "",
    "class _VvDropLoadedPackagesNotice(logging.Filter):",
    "    def filter(self, record):",
    '        return "not found in loadedPackages" not in record.getMessage()',
    "",
    "",
    '_vv_lg = logging.getLogger("micropip")',
    "_vv_filter = _VvDropLoadedPackagesNotice()",
    "_vv_lg.addFilter(_vv_filter)",
    "try:",
    "    micropip.uninstall(" + JSON.stringify(name) + ")",
    "finally:",
    "    _vv_lg.removeFilter(_vv_filter)",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// pip's read-only verbs, formatted the way real pip formats them
// ---------------------------------------------------------------------------
//
// These are pure functions over plain data on purpose. The data comes out of the
// interpreter (DIST_QUERY below reads importlib.metadata, which is where the
// real answers are), but the RENDERING is ours — and rendering is exactly where
// a 95%-right implementation does its damage. `pip freeze > requirements.txt` is
// a load-bearing idiom; output that is almost `name==version` is worse than no
// output at all, because it fails later and somewhere else.
//
// So they live here, take a JSON-ish argument, and scripts/spike-python-offline.mjs
// asserts them byte-for-byte against the output of REAL pip run on the same
// packages — no interpreter needed, so it gates every PR. Formats captured from
// pip 25.3 and re-derived on each offline run where a host pip exists.

// pip sorts by canonical name, case-insensitively.
const byName = (a, b) => {
  const x = String(a.name).toLowerCase();
  const y = String(b.name).toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};

// Real pip pads the name column to the widest entry (minimum: the header) and
// leaves the LAST column unpadded, so there is no trailing whitespace.
export function formatPipList(dists) {
  const rows = [...(dists || [])].sort(byName);
  if (!rows.length) return ""; // real pip prints nothing at all for an empty env
  const nameWidth = Math.max("Package".length, ...rows.map((d) => String(d.name).length));
  const verWidth = Math.max("Version".length, ...rows.map((d) => String(d.version).length));
  const line = (a, b) => String(a).padEnd(nameWidth) + " " + b;
  return [
    line("Package", "Version"),
    line("-".repeat(nameWidth), "-".repeat(verWidth)),
    ...rows.map((d) => line(d.name, d.version)),
  ].join("\n") + "\n";
}

export function formatPipFreeze(dists) {
  const rows = [...(dists || [])].sort(byName);
  if (!rows.length) return "";
  return rows.map((d) => `${d.name}==${d.version}`).join("\n") + "\n";
}

// Field order is pip's. An absent value prints as an empty string after the
// colon — note the trailing space, which real pip emits and diffs will show.
// `License-Expression` REPLACES `License` when the metadata carries it, which is
// what modern packaging produces; getting this wrong is invisible until someone
// greps for a licence.
export function formatPipShow(dist) {
  const d = dist || {};
  const v = (x) => (x === null || x === undefined ? "" : String(x));
  const lines = [
    "Name: " + v(d.name),
    "Version: " + v(d.version),
    "Summary: " + v(d.summary),
    "Home-page: " + v(d.homePage),
    "Author: " + v(d.author),
    "Author-email: " + v(d.authorEmail),
  ];
  if (d.licenseExpression) lines.push("License-Expression: " + v(d.licenseExpression));
  else lines.push("License: " + v(d.license));
  lines.push("Location: " + v(d.location));
  lines.push("Requires: " + (d.requires || []).join(", "));
  lines.push("Required-by: " + (d.requiredBy || []).join(", "));
  return lines.join("\n") + "\n";
}

// Two sentences, both taken from real pip 25.3 rather than from our idea of what
// it says. The requirement is rendered by `packaging` on the Python side, so the
// specifier ordering ("urllib3<3,>=1.26") is packaging's canonical one and not a
// re-implementation of it.
export function formatPipCheck(problems) {
  const rows = problems || [];
  if (!rows.length) return "No broken requirements found.\n";
  return rows
    .map((p) =>
      p.kind === "missing"
        ? `${p.name} ${p.version} requires ${p.dependency}, which is not installed.`
        : `${p.name} ${p.version} has requirement ${p.requirement}, but you have ${p.dependency} ${p.have}.`,
    )
    .join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// The Python that produces the data above
// ---------------------------------------------------------------------------
//
// Everything here is read out of importlib.metadata — real dist metadata written
// by whatever built the wheel — rather than tracked by us in a side manifest. A
// manifest would be a second copy of the truth, free to drift from the store it
// claims to describe, which is precisely the `pip freeze` failure this phase has
// to avoid. There is nothing to drift: the store IS site-packages, and this reads
// site-packages.
export const DIST_QUERY = `
import json, string, sysconfig

# packaging is a Pyodide-distributed package, loaded by the caller before this
# runs. If it is somehow absent we report that and let the caller refuse: an
# empty "Requires:" and a clean "pip check" would both be confident lies, and
# swallowing the ImportError to produce them is exactly the failure mode the
# stub-that-lies rule is about. (It bit this very function during development.)
try:
    from packaging.requirements import Requirement
    _VV_HAVE_PACKAGING = True
except Exception:
    Requirement = None
    _VV_HAVE_PACKAGING = False


def _vv_canon(name):
    return name.lower().replace("_", "-")


def _vv_homepage(m):
    # pip's own rule, from pip/_internal/commands/show.py: fall back to a
    # Project-URL whose label normalises to "homepage" per PEP 753 — strip all
    # punctuation and whitespace, lowercase. PEP 621 projects rarely set
    # Home-page, so without this every modern package shows a blank one.
    home = m.get("Home-page", "")
    if home:
        return home
    drop = str.maketrans("", "", string.punctuation + string.whitespace)
    for url in (m.get_all("Project-URL", []) or []):
        label, _, value = url.partition(",")
        if label.translate(drop).lower() == "homepage":
            return value.strip()
    return ""


def _vv_requirements(dist):
    if not _VV_HAVE_PACKAGING:
        return []
    out = []
    for raw in (dist.requires or []):
        try:
            r = Requirement(raw)
        except Exception:
            continue
        # pip omits requirements that only apply under an extra, which is why
        # tabulate's 'wcwidth; extra == "widechars"' must not appear.
        if r.marker is not None and "extra" in str(r.marker):
            continue
        out.append(r)
    return out


def _vv_collect():
    import importlib.metadata as md
    location = sysconfig.get_path("purelib").replace("//", "/")
    dists = {}
    for d in md.distributions():
        try:
            name = d.metadata["Name"]
        except Exception:
            continue
        if name and name not in dists:
            dists[name] = d
    canon = {_vv_canon(n): n for n in dists}
    reverse = {}
    for name, d in dists.items():
        for r in _vv_requirements(d):
            reverse.setdefault(_vv_canon(r.name), []).append(name)
    rows = []
    problems = []
    for name in sorted(dists):
        d = dists[name]
        m = d.metadata
        reqs = _vv_requirements(d)
        try:
            dist_info = d._path.name
        except Exception:
            dist_info = ""
        rows.append({
            "name": name,
            "version": d.version,
            # The directory as it exists, so membership of the store is decided
            # by a lookup and never by re-deriving an escaped name.
            "distInfo": dist_info,
            "summary": m.get("Summary", ""),
            "homePage": _vv_homepage(m),
            "author": m.get("Author", ""),
            "authorEmail": m.get("Author-email", ""),
            "license": m.get("License", ""),
            "licenseExpression": m.get("License-Expression", ""),
            "location": location,
            "requires": sorted(r.name for r in reqs),
            "requiredBy": sorted(reverse.get(_vv_canon(name), [])),
        })
        for r in reqs:
            target = canon.get(_vv_canon(r.name))
            if target is None:
                problems.append({
                    "kind": "missing", "name": name, "version": d.version,
                    "dependency": r.name,
                })
                continue
            have = dists[target].version
            if r.specifier and not r.specifier.contains(have, prereleases=True):
                problems.append({
                    "kind": "version", "name": name, "version": d.version,
                    # str(Requirement) is packaging's canonical rendering, which
                    # is the spelling pip prints ("urllib3<3,>=1.26").
                    "requirement": str(r), "dependency": target, "have": have,
                })
    return json.dumps({
        "location": location,
        "dists": rows,
        "problems": problems,
        "requirementsAvailable": _VV_HAVE_PACKAGING,
    })


_vv_collect()
`;