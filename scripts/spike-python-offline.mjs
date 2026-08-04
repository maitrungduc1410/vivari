// Offline spike for Python support — the tier CI can enforce on every PR.
//
//   node scripts/spike-python-offline.mjs
//
// WHY THIS EXISTS SEPARATELY FROM spike-python-bridge.mjs. The bridge spike is
// the real proof: it runs the templates against actual Pyodide. But Pyodide is
// ~30 MB of CPython/WASM that is neither committed (public/vendor is
// .gitignore'd) nor installed by CI (no job runs `npm ci`), so it can only be
// fetched at run time — which makes that spike `net: true`, and the network tier
// is schedule/dispatch-only and `continue-on-error`. On its own it would gate
// nothing, exactly the hole the Bun Phase 0 change closed for spike-bun.mjs.
//
// So this file carries every Python check that needs neither Pyodide nor the
// network, and is registered `net: false` — landing it in `toolchain-gate`,
// which runs `run-spikes.mjs --offline` unfiltered on every push and PR.
//
// WHAT IT PROVES: the CLI seams' argv contract (including that flags we cannot
// honour say so), CPython-faithful termination, the shape of the generated
// bridge dispatch source (the ASGI root_path regression in particular), that
// the shipped templates are internally consistent with the shims they invoke,
// and — using the host's own python3 — the actual behaviour of the urllib3
// realm hook, which is ordinary Python and so needs no Pyodide to run. All
// against the SHIPPED sources, never a copy.
//
// WHAT IT DOES NOT PROVE: that any of it runs under Pyodide. Nothing here boots
// an interpreter, and the one place that matters most is called out where it
// happens: the realm hook is exercised against a stand-in for urllib3's
// Emscripten transport, because the real module exists nowhere but inside
// Pyodide. spike-python-bridge.mjs checks the stand-in against the real thing,
// on the network tier. See scripts/lib/urllib3-emscripten.mjs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PYTHON_PROGRAM } from "../packages/kernel-host/programs/python.js";
import { COREUTILS, PYTHON_DELEGATES } from "../packages/kernel-host/coreutils.js";
import {
  PYODIDE_PYTHON_VERSION,
  PYTHON_EXECUTABLE,
  BLOCKING_PATCH_SOURCE,
  MPL_BACKEND,
  MPL_SHOW_SOURCE,
  URLLIB3_REALM_PATCH,
  byteWriter,
  dataPackagesFor,
  installMatplotlibShow,
  installStdin,
  makeLineReader,
  readSnapshot,
  writeSnapshot,
  discardSnapshot,
  restoredOk,
  snapshotsEnabled,
  SNAPSHOT_BIN,
  SNAPSHOT_META,
  BYTECODE_DIR,
  PYCACHE_PREFIX,
  bytecodeEnabled,
  installBytecodeCache,
  readBytecodeIndex,
  restoreBytecode,
  harvestBytecode,
  setExecutable,
  setupSource,
  terminationFromError,
} from "../packages/runtime/builtins/python.js";
import { PY_DEBUG_SOURCE, createPythonDebugger } from "../packages/runtime/builtins/python-debugger.js";
import {
  STORE_DIR,
  STORE_FORMAT,
  STORE_MAX_BYTES,
  collectDelta,
  formatPipCheck,
  formatPipFreeze,
  formatPipList,
  formatPipShow,
  humanBytes,
  makeStamp,
  persistDelta,
  readStamp,
  renderPyvenvCfg,
  restoreStore,
  stampProblem,
  storeCapError,
  storeDists,
  storePaths,
  walkHost,
  parseEntryPoints,
  consoleScriptSource,
  writeConsoleScripts,
  RESERVED_COMMANDS,
} from "../packages/runtime/builtins/python-store.js";
import { CAPTURED, FIXTURE_DISTS, realPipFormat, realPipUnknown, writeFixtureSite } from "./lib/real-pip.mjs";
import { driveRuff } from "./lib/python-drive.mjs";
import { writeFakeIndex } from "./lib/fake-pyodide.mjs";
import { readShippedManifests, readShippedTemplates, readTemplatesSource } from "./lib/shipped-templates.mjs";
import { MODELLED_FRAGMENTS, STANDIN, normalize } from "./lib/urllib3-emscripten.mjs";
import { CPYTHON_EXITS, UNTRUNCATED, realCPythonExit } from "./lib/cpython-exit.mjs";
import { drivePython, driveShim, servedApp } from "./lib/python-drive.mjs";
import { fsDirective, get, hostRead, mirrorRuntime, scratchPort } from "./lib/python-mirror-drive.mjs";
import { makeFakeMonaco, makeHost, makeModel, makeToken } from "./lib/fake-monaco.mjs";
import {
  LSP_DRIVER_SOURCE,
  LSP_STATE,
  MONACO_KIND,
  completionKind,
  createRequestQueue,
  formatFailureMessage,
  hostPathFor,
  registerPythonLanguage,
  MARKER_OWNER,
  RUFF_MARKER_OWNER,
  CHECK_DEBOUNCE_MS,
  LINT_DEBOUNCE_MS,
  ruffMarkersFrom,
  TYPE_STUBS,
  MYPY_PACKAGES,
  stateLabel,
  toJediPosition,
} from "../packages/runtime/builtins/python-lsp.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  \u2713 " : "  \u2717 ") + msg);
  if (!cond) failed++;
};

// The seven templates this change added, plus the two that predate it.
const NEW_TEMPLATES = [
  "django",
  "flask-app",
  "fastapi-crud",
  "fastapi-dashboard",
  "python-pytest",
  "python-sqlite",
  "python-imaging",
];

// ---------------------------------------------------------------------------
console.log("== python CLI dispatch (PYTHON_PROGRAM run as a real process) ==");
// PYTHON_PROGRAM is an ordinary CommonJS program and every check below exits
// before it would reach the runtime, so plain Node can execute it with no
// kernel and no Pyodide — the same trick spike-bun-offline.mjs uses on
// BUN_PROGRAM. Off Vivari, globalThis.__ocInstallPython is absent, so anything
// that DOES reach the runtime stops with a stated reason, which is itself the
// behaviour worth asserting.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-python-cli-"));
  const bin = path.join(dir, "python.cjs");
  fs.writeFileSync(bin, PYTHON_PROGRAM);

  const run = (...args) => {
    const r = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: "utf8" });
    return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
  };

  ok(PYTHON_PROGRAM.indexOf("`") === -1, "PYTHON_PROGRAM stays free of backticks (it is an embedded template literal)");

  let r = run("--version");
  ok(r.code === 0 && /Python 3\.14/.test(r.out), "--version prints a version without booting Pyodide");

  // `-m` used to answer an unknown module with a Vivari refusal listing the six
  // it knew. It now hands the name to runpy, so off Vivari (no runtime bound)
  // the run stops at the stated reason for that instead — and, importantly, NOT
  // at a claim about which modules exist. The passing case is checked against
  // real CPython further down.
  r = run("-m", "nosuchmod");
  ok(!/not supported in the Vivari shim/.test(r.err), "python -m <unknown> no longer claims arbitrary modules are unsupported");
  ok(/Pyodide runtime is unavailable/.test(r.err), "…it reaches the interpreter, and says so when there is not one");

  // Two different unknowns, kept apart. Checked in full further down, against
  // real pip, in the section on reaching these commands by the name users type.
  r = run("-m", "pip", "download", "flask");
  ok(r.code === 1 && /"download" is a real pip command that this shim does not have/.test(r.err),
    "python -m pip <a real pip verb we lack> is not-implemented and names the verb");
  ok(/install, list, freeze, show, uninstall, check/.test(r.err), "…and lists the verbs that do work");
  r = run("-m", "pip", "frobnicate");
  ok(r.code === 1 && /unknown command "frobnicate"/.test(r.err),
    "…while a verb no pip has gets real pip's unknown-command line, which lists nothing, as pip's does not");

  // --- gunicorn: honest entrypoint, loud about the process model ------------
  r = run("-m", "gunicorn", "wsgi:app", "-k", "gevent");
  ok(r.code === 1 && /-k gevent is not supported/.test(r.err), "gunicorn -k gevent is refused, not ignored (it would change the server model)");
  r = run("-m", "gunicorn", "wsgi:app", "--worker-class=uvicorn.workers.UvicornWorker");
  ok(r.code === 1 && /--worker-class uvicorn\.workers\.UvicornWorker is not supported/.test(r.err), "…and the --flag=value spelling is refused identically, naming the class");
  // 'sync' is precisely what the bridge does, so spelling out the default is
  // not a lie and must keep working.
  r = run("-m", "gunicorn", "-k", "sync");
  ok(/no app specified/.test(r.err) && !/not supported/.test(r.err), "gunicorn -k sync is accepted (it is the model the bridge implements)");

  r = run("-m", "gunicorn", "wsgi:app", "-w", "4");
  ok(/-w is ignored here/.test(r.err) && /no OS threads/.test(r.err), "gunicorn -w warns that there is exactly one worker");
  // If the flag's value were not consumed, "4" would be taken as the app spec
  // and this would fail with the runtime error instead of "no app specified".
  r = run("-m", "gunicorn", "-w", "4");
  ok(/no app specified/.test(r.err), "…and its value is consumed rather than mistaken for the app spec");

  r = run("-m", "gunicorn", "wsgi:app", "--reload");
  ok(/--reload is ignored here/.test(r.err), "gunicorn --reload warns instead of pretending to watch files");
  r = run("-m", "gunicorn", "wsgi:app", "-D");
  ok(/-D is ignored here/.test(r.err), "gunicorn -D warns instead of pretending to daemonise");

  r = run("-m", "gunicorn", "--bind", "0.0.0.0:8000");
  ok(/no app specified/.test(r.err) && /wsgi:application/.test(r.err), "gunicorn with no app spec says so and shows the expected form");

  // --- uvicorn: same standard on the ASGI side ------------------------------
  r = run("-m", "uvicorn", "main:app", "--factory");
  ok(r.code === 1 && /--factory is not supported/.test(r.err), "uvicorn --factory is refused (the bridge serves the attribute directly)");
  r = run("-m", "uvicorn", "--workers", "3");
  ok(/--workers is ignored here/.test(r.err) && /no app specified/.test(r.err), "uvicorn --workers warns and consumes its value");
  r = run("-m", "uvicorn", "main:app", "--reload");
  ok(/--reload is ignored here/.test(r.err), "uvicorn --reload warns instead of pretending to watch files");

  // --- flask ----------------------------------------------------------------
  r = run("-m", "flask", "--app", "main", "run", "--debug");
  ok(/--debug is ignored here/.test(r.err), "flask --debug warns (no reloader, no interactive debugger)");
  r = run("-m", "flask", "--app", "main", "shell");
  ok(r.code === 1 && /only the "run" command/.test(r.err), "flask <other> names the one command it has");

  // --- the runtime being absent is itself stated, not guessed at ------------
  r = run("main.py");
  ok(r.code === 1 && /Pyodide runtime is unavailable/.test(r.err), "off Vivari, the shim says the runtime is unavailable rather than faking a run");

  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("\n== argv against the real gunicorn / uvicorn / Flask CLIs ==");
// Which flags exist, and which of them take a value, is not ours to decide —
// it is whatever the tools we are standing in for accept. These names and the
// value/boolean split were read off `gunicorn --help`, `uvicorn --help` and
// `flask run --help` from the real packages, and doing that turned up three
// cases this shim had wrong. A user typing a command that works everywhere
// else and getting a confusing failure here is the same lie as a stub return.
// ---------------------------------------------------------------------------
{
  // Discriminator: a consumed value leaves no app spec ("no app specified"),
  // while an unconsumed one is silently read AS the app spec and serves it.
  let r = drivePython(["-m", "gunicorn", "-t", "30"]);
  ok(servedApp(r) === null && /no app specified/.test(r.out),
    "gunicorn -t consumes its value (real gunicorn's short spelling of --timeout; this used to serve an app called '30')");
  r = drivePython(["-m", "gunicorn", "--log-level", "debug"]);
  ok(servedApp(r) === null, "…and so does every other value-taking knob, not just the handful we enumerated");
  r = drivePython(["-m", "gunicorn", "-t", "30", "wsgi:app"]);
  ok(servedApp(r) === "wsgi:app", "…so the app spec after one is still the app spec");
  // The other direction: a real store_true flag must NOT eat the app spec.
  r = drivePython(["-m", "gunicorn", "--preload", "wsgi:app"]);
  ok(servedApp(r) === "wsgi:app", "gunicorn --preload is boolean in real gunicorn, so it leaves the app spec alone");

  r = drivePython(["-m", "uvicorn", "--log-level", "debug"]);
  ok(servedApp(r) === null, "uvicorn --log-level consumes its value rather than serving an app called 'debug'");
  r = drivePython(["-m", "uvicorn", "--proxy-headers", "main:app"]);
  ok(servedApp(r) === "main:app", "…while uvicorn's boolean --proxy-headers leaves the app spec alone");

  // Flask is the odd one out: -h is --host there, not --help.
  r = drivePython(["-m", "flask", "--app", "main", "run", "-h", "0.0.0.0", "-p", "5001"]);
  const served = r.calls.find((c) => c[0] === "serve")?.[1] || {};
  ok(served.host === "0.0.0.0", `flask run -h sets the bind host, as it does in real Flask (${JSON.stringify(served.host)})`);
  ok(served.port === 5001, `flask run -p sets the port (${served.port})`);
}

// ---------------------------------------------------------------------------
console.log("\n== termination: SystemExit, against real CPython ==");
// A green `pytest` run ends in sys.exit(0). Dumping a WASM traceback for that
// made every passing run look like a crash — but the fix must not swallow real
// failures, which is what the last checks are for. The expected values come
// from scripts/lib/cpython-exit.mjs, captured from a real interpreter; see the
// note there on why writing them from memory is not good enough.
// ---------------------------------------------------------------------------
{
  const pyErr = (type, lastLine) => ({ type, message: `Traceback (most recent call last):\n  File "<exec>", line 1\n${lastLine}` });

  for (const row of [...CPYTHON_EXITS, ...UNTRUNCATED]) {
    const t = terminationFromError(pyErr("SystemExit", row.traceback));
    ok(t.code === row.code && t.report === row.report,
      `${row.expr} -> exit ${t.code}, prints ${JSON.stringify(t.report)}`);
  }

  // Re-derive the table from whatever CPython is installed here, so a row that
  // is wrong cannot survive just because it was written down once. A missing
  // interpreter is reported loudly rather than skipped — a silent skip reads
  // as green, which is the failure mode this whole tier exists to avoid.
  const live = realCPythonExit("sys.exit(0)", spawnSync);
  if (!live) {
    console.log("  ! no python3 on PATH: the table above was NOT re-derived here (captured under CPython 3.11.2)");
  } else {
    for (const row of CPYTHON_EXITS) {
      const got = realCPythonExit(row.expr, spawnSync);
      ok(got.code === row.code && got.report === row.report,
        `real CPython agrees: ${row.expr} -> exit ${got.code}, stderr ${JSON.stringify(got.report)}`);
    }
    for (const row of UNTRUNCATED) {
      const got = realCPythonExit(row.expr, spawnSync);
      ok(got.code === row.cpython,
        `real CPython truncates ${row.expr} to ${got.code} at the OS boundary; the VM has no such boundary, so the shim keeps ${row.code}`);
    }
    const boom = spawnSync("python3", ["-c", "raise ValueError('nope')"], { encoding: "utf8" });
    ok(boom.status === 1 && /^Traceback/m.test(boom.stderr) && /ValueError: nope/.test(boom.stderr),
      "real CPython: an unhandled exception exits 1 and prints a traceback");
  }

  const real = pyErr("PythonError", "ValueError: nope");
  const t = terminationFromError(real);
  ok(t.code === 1, "a real exception still exits 1");
  ok(t.report === real.message, "…and keeps its whole traceback, rather than being quietly swallowed");
}

// ---------------------------------------------------------------------------
console.log("\n== terminal output is passed through byte for byte ==");
// A user ran the python-pytest template and got one progress dot per LINE.
// Pyodide's batched stdout handler strips the trailing newline and fires once
// per flush, and the runtime appended a newline to every call — correct for a
// flush that ended a line, wrong for the partial-line flush pytest does after
// each dot. byteWriter is a plain function, so the rule it has to obey is
// checkable without an interpreter; that real pytest then renders as one line
// is the bridge tier's job, since only a real interpreter can show that.
// ---------------------------------------------------------------------------
{
  const enc = (s) => new TextEncoder().encode(s);
  const chunks = [];
  const w = byteWriter({ write: (b) => chunks.push(b.toString("utf8")) });

  ok(w.write(enc(".")) === 1, "the writer returns the byte count Pyodide's Writer contract requires");
  ok(chunks.join("") === ".", "a partial-line write is passed through with NO newline appended");
  w.write(enc("."));
  w.write(enc("."));
  ok(chunks.join("") === "...", "consecutive partial writes stay on one line (the reported bug)");

  chunks.length = 0;
  w.write(enc("a\nb\n"));
  ok(chunks.join("") === "a\nb\n", "newline-terminated output is not given an extra one either");

  // Pyodide reuses its output buffer, so the writer has to copy before an
  // asynchronous stream.write() gets to look at it.
  chunks.length = 0;
  const reused = enc("first");
  w.write(reused);
  reused.set(enc("XXXXX"));
  ok(chunks.join("") === "first", "the buffer is copied, so a reused Pyodide buffer cannot corrupt what was written");

  // And the runtime must actually be wired to it.
  const runtime = fs.readFileSync(path.join(ROOT, "packages/runtime/builtins/python.js"), "utf8");
  ok(/setStdout\(byteWriter\(process\.stdout\)\)/.test(runtime) && /setStderr\(byteWriter\(process\.stderr\)\)/.test(runtime),
    "both streams are wired to the byte writer, not to a batched handler");
  ok(!/stdout:\s*\(line\)/.test(runtime), "…and the newline-appending batched handler is gone");
  // Python holds a partial line in its own buffer until something flushes it,
  // so a script ending in print("x", end="") needs the explicit flush.
  ok(/flushStreams\(pyodide\)/.test(runtime), "runSource flushes Python's buffer so a trailing partial line is not swallowed");
}

// ---------------------------------------------------------------------------
console.log("\n== bridge dispatch source (setupSource) ==");
// String-level, because running it needs Pyodide. Deliberately self-referential
// — it asserts our source still says what it says — and that is all it claims
// to be: a drift guard against someone "simplifying" path back to the
// pre-stripped value. It is NOT evidence that the scope matches the ASGI spec,
// which no amount of grepping our own output could establish. That is the
// bridge tier's asgi-root-path case, which puts the scope in front of
// Starlette's own Mount and get_route_path.
// ---------------------------------------------------------------------------
{
  const asgi = setupSource("main", "app", "asgi");
  ok(/_vv_root = d\.get\("root_path", ""\)/.test(asgi), "ASGI scope reads root_path from the request");
  ok(/_vv_path = _vv_root \+ d\["path"\]/.test(asgi), "ASGI path is rebuilt to INCLUDE root_path (the Mount/StaticFiles fix)");
  ok(/"path": _vv_path/.test(asgi) && !/"path": d\["path"\]/.test(asgi), "…and the raw stripped path is not what goes into the scope");
  ok(/"raw_path": _vv_path\.encode/.test(asgi), "raw_path agrees with path");

  const wsgi = setupSource("wsgi", "application", "wsgi");
  ok(/SCRIPT_NAME/.test(wsgi) && /PATH_INFO/.test(wsgi), "WSGI keeps the SCRIPT_NAME/PATH_INFO split (already the two-part form)");
  ok(!/_vv_root \+ d\["path"\]/.test(wsgi), "…so it does not get the ASGI prefix treatment");

  ok(setupSource("pkg.mod", "app", "asgi").includes('"pkg.mod"'), "the module name is injected as a JSON literal");
}

// ---------------------------------------------------------------------------
console.log("\n== shipped Python templates are internally consistent ==");
// Reads packages/studio/src/vv/templates.ts, so a template that references a
// file it does not ship, or a command with no program behind it, fails here
// rather than in someone's browser.
//
// Self-referential on purpose, and correctly so: "the entry file this manifest
// names is one of the files it ships" is a claim about our registry and has no
// authority outside this repo to check it against. The parts of these
// templates that DO have one — that gunicorn accepts the dev command, that
// Django reads the env var settings.py sets — are checked against those
// authorities instead, here and in the bridge tier.
// ---------------------------------------------------------------------------
{
  const source = readTemplatesSource();
  const files = await readShippedTemplates(source);
  const manifests = await readShippedManifests(source);
  const icons = fs.readFileSync(path.join(ROOT, "packages/studio/src/components/ide/templateIcons.tsx"), "utf8");
  const programs = new Set(Object.keys(COREUTILS));

  for (const id of NEW_TEMPLATES) {
    const m = manifests[id];
    const f = files[id];
    if (!m || !f) {
      ok(false, `${id}: present in templates.ts`);
      continue;
    }
    const dev = String(m.dev || "");
    const install = String(m.install || "");
    const problems = [];
    if (m.language !== "Python") problems.push(`language is ${m.language}`);
    // Every one of these needs a browser pass before it can lose the badge.
    if (m.experimental !== true) problems.push("not marked experimental");
    if (!f[m.entry]) problems.push(`entry ${m.entry} is not one of its files`);
    if (!programs.has(dev.split(" ")[0])) problems.push(`dev runs '${dev.split(" ")[0]}', which is not on PATH`);
    if (!programs.has(install.split(" ")[0])) problems.push(`install runs '${install.split(" ")[0]}', which is not on PATH`);
    // templateIcons.tsx keys the map by the manifest's icon slug.
    if (!new RegExp(`^\\s*["']?${m.icon}["']?:`, "m").test(icons)) problems.push(`icon '${m.icon}' has no badge`);
    if (install.includes("-r requirements.txt") && !f["requirements.txt"]) problems.push("installs -r requirements.txt but ships none");
    ok(problems.length === 0, `${id}: ${problems.length ? problems.join("; ") : "manifest, entry, icon and commands all resolve"}`);
  }

  // The four Django constraints are load-bearing enough to assert two of them.
  const dj = files.django || {};
  ok(/(^|\n)tzdata\b/.test(dj["requirements.txt"] || ""), "django pins tzdata (the WASM stdlib ships no timezone database)");
  ok(
    Object.values(dj).some((c) => /DJANGO_ALLOW_ASYNC_UNSAFE/.test(c)),
    "django sets DJANGO_ALLOW_ASYNC_UNSAFE (Pyodide always has a running WebLoop)",
  );
  ok(
    !Object.entries(dj).some(([name, c]) => name.endsWith(".html") && /\{%\s*static\s/.test(c)),
    "django templates avoid {% static %} (STATIC_URL is cached before any request sets the prefix)",
  );

  // The bridge serves under /preview/<port>, so a hardcoded root escapes it.
  const web = ["django", "flask-app", "fastapi-crud", "fastapi-dashboard"];
  for (const id of web) {
    const m = manifests[id] || {};
    ok(String(m.dev || "").includes(String(m.port)), `${id}: the dev command binds the port the manifest advertises (${m.port})`);
  }
}

// ---------------------------------------------------------------------------
console.log("\n== the urllib3 realm hook, executed in real CPython ==");
// urllib3's Emscripten transport asks js.process.release.name whether it is
// running under Node. We answer "node" on purpose, so it skipped the synchronous
// XMLHttpRequest a Web Worker has and told browser users to pass a Node flag.
// URLLIB3_REALM_PATCH is the fix, and it is ordinary Python — so the host's own
// interpreter can run it, and this tier can gate the LOGIC on every PR rather
// than only string-matching it.
//
// The split, stated plainly. What runs here: our hook, in real CPython, against
// a stand-in module. What CANNOT run here: real urllib3, which exists only
// inside Pyodide. So the stand-in is a model, and a model is worth exactly as
// much as the check that it matches — spike-python-bridge.mjs asserts, against
// the real module, that every name and gate expression copied below is really
// urllib3's. Neither tier is sufficient alone; that is the point of the pair.
// ---------------------------------------------------------------------------
{
  // Drives the shipped patch through six scenarios and reports as JSON, so the
  // assertions below read as claims rather than as output parsing.
  const DRIVER = `
import importlib, json, os, pathlib, sys, types

PATCH = pathlib.Path(os.environ["VV_PATCH"]).read_text()
PKG = pathlib.Path(os.environ["VV_PKG"])
TARGET = "urllib3.contrib.emscripten.fetch"
sys.path.insert(0, str(PKG))

def realm(*, xhr, worker=True, coi=True, main_thread=False):
    """A fresh JS realm and a fresh import state, as a new process would have."""
    for name in [n for n in list(sys.modules) if n.split(".")[0] == "urllib3"]:
        del sys.modules[name]
    sys.meta_path[:] = [f for f in sys.meta_path
                        if type(f).__name__ != "_VvEmscriptenFetchFinder"]
    js = types.ModuleType("js")
    # The masquerade itself: this is what builtins/process.js really sets.
    js.process = types.SimpleNamespace(release=types.SimpleNamespace(name="node"))
    if xhr:
        js.XMLHttpRequest = object()
    if worker:
        js.Worker = object()
        js.Blob = object()
    if coi:
        js.crossOriginIsolated = True
    if main_thread:
        js.window = object()
        js.self = js.window
    sys.modules["js"] = js
    importlib.invalidate_caches()

def apply_patch():
    exec(compile(PATCH, "<URLLIB3_REALM_PATCH>", "exec"), {"__name__": "__vv_patch__"})

def finders():
    return [f for f in sys.meta_path if type(f).__name__ == "_VvEmscriptenFetchFinder"]

def wrap_depth(fn):
    """How many of OUR predicates are stacked in front of urllib3's own function.

    Counting closure cells would not do it: a re-wrap closes over the previous
    wrapper and still has exactly one cell. Walk the chain instead.
    """
    n = 0
    while getattr(fn, "_vv_realm_derived", False):
        n += 1
        inner = [c.cell_contents for c in (fn.__closure__ or ()) if callable(c.cell_contents)]
        if not inner:
            break
        fn = inner[0]
    return n

out = {}

# 1. a browser Worker: the patch takes effect
realm(xhr=True)
apply_patch()
import urllib3.contrib.emscripten.fetch as f
out["browser_is_in_node"] = f.is_in_node()
out["browser_fetcher"] = type(f._fetcher).__name__
out["browser_exec_count"] = f.EXEC_COUNT
out["browser_marker"] = getattr(f.is_in_node, "_vv_realm_derived", False)

# 2. real Node: urllib3's own answer must survive untouched
realm(xhr=False)
apply_patch()
import urllib3.contrib.emscripten.fetch as f
out["node_is_in_node"] = f.is_in_node()
out["node_marker"] = getattr(f.is_in_node, "_vv_realm_derived", False)
out["node_fetcher"] = type(f._fetcher).__name__

# 3. the hook is scoped to one module and does not intercept its siblings
realm(xhr=True)
apply_patch()
(PKG / "urllib3/contrib/emscripten/other.py").write_text("VALUE = 42\\n")
importlib.invalidate_caches()
import urllib3.contrib.emscripten.other as other
out["sibling_value"] = other.VALUE
out["sibling_untouched"] = not hasattr(other, "is_in_node")

# 4. already imported before the patch runs (a re-run, or a harness ordering)
realm(xhr=True)
import urllib3.contrib.emscripten.fetch as f
out["preimport_before"] = f.is_in_node()
apply_patch()
out["preimport_after"] = f.is_in_node()

# 5. idempotent, in BOTH orderings. Applying the patch before the module is
#    imported reaches _vv_patch_fetch only once however many times it is run
#    (the hook fires on the single import), so repetition has to be tested
#    where it can actually bite: against a module that is already loaded.
realm(xhr=True)
import urllib3.contrib.emscripten.fetch as f  # loaded BEFORE any patch
apply_patch()
apply_patch()
apply_patch()
out["finder_count"] = len(finders())
out["wrap_depth"] = wrap_depth(f.is_in_node)
out["idempotent_is_in_node"] = f.is_in_node()

# …and the other way round: patched by the hook at import, then re-applied.
realm(xhr=True)
apply_patch()
import urllib3.contrib.emscripten.fetch as f  # the hook wraps it here
apply_patch()
apply_patch()
out["wrap_depth_hooked"] = wrap_depth(f.is_in_node)

# 6. a _StreamingFetcher that throws must not cost us the fix
realm(xhr=True)
apply_patch()
import urllib3.contrib.emscripten.fetch as f
f.is_in_node = f.__dict__["is_in_node"]
sys.modules[TARGET].__dict__["_fetcher"] = None
def boom():
    raise RuntimeError("no nested worker here")
sys.modules[TARGET].__dict__["_StreamingFetcher"] = boom
del sys.modules[TARGET].__dict__["is_in_node"]._vv_realm_derived
apply_patch()
out["boom_fetcher"] = repr(f._fetcher)
out["boom_is_in_node"] = f.is_in_node()

print(json.dumps(out))
`;

  // Half of the pair: the model still contains everything it claims to model.
  // The other half — that this list is really urllib3's — is the bridge tier's,
  // against the installed module.
  for (const { label, source } of MODELLED_FRAGMENTS) {
    ok(normalize(STANDIN).includes(normalize(source)), `the stand-in reproduces urllib3's ${label} verbatim`);
  }

  const probe = spawnSync("python3", ["-c", "import sys; print(sys.version.split()[0])"], { encoding: "utf8" });
  if (probe.status !== 0) {
    // Loud, not skipped: a silent skip reads as green, which is the whole
    // reason this tier exists.
    console.log("  ! no python3 on PATH: the hook's LOGIC was not executed here — only the drift guards below ran");
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-python-realm-"));
    const pkg = path.join(dir, "pkg");
    for (const p of ["urllib3", "urllib3/contrib", "urllib3/contrib/emscripten"]) {
      fs.mkdirSync(path.join(pkg, p), { recursive: true });
      fs.writeFileSync(path.join(pkg, p, "__init__.py"), "");
    }
    fs.writeFileSync(path.join(pkg, "urllib3/contrib/emscripten/fetch.py"), STANDIN);
    const patchFile = path.join(dir, "patch.py");
    fs.writeFileSync(patchFile, URLLIB3_REALM_PATCH);
    const driver = path.join(dir, "driver.py");
    fs.writeFileSync(driver, DRIVER);

    const r = spawnSync("python3", [driver], {
      encoding: "utf8", env: { ...process.env, VV_PATCH: patchFile, VV_PKG: pkg },
    });
    if (r.status !== 0) {
      ok(false, `the patch runs under CPython ${probe.stdout.trim()}`);
      console.log((r.stderr || "").split("\n").slice(-14).map((l) => "      | " + l).join("\n"));
    } else {
      const o = JSON.parse(r.stdout.trim().split("\n").pop());
      console.log(`  (CPython ${probe.stdout.trim()})`);

      ok(o.browser_is_in_node === false, "browser Worker realm: is_in_node() is False, so requests takes the XHR branch");
      ok(o.browser_marker === true, "…via our predicate, which is marked so a second application cannot re-wrap it");
      ok(o.browser_fetcher === "_StreamingFetcher", "…and _fetcher is re-decided, not left off by the import-time evaluation");
      ok(o.browser_exec_count === 1, "…with the module executed exactly once (the wrapped loader does not double-exec)");

      // The assertion that stops the fix becoming a lie in the other direction.
      ok(o.node_is_in_node === true, "real Node realm: is_in_node() is STILL True — the predicate is realm-derived, not a flat False");
      ok(o.node_marker === false, "…and the patch does not even wrap it there, so urllib3's own function is what answers");
      ok(o.node_fetcher === "NoneType", "…and _fetcher stays off, as urllib3 decided");

      ok(o.sibling_value === 42 && o.sibling_untouched === true,
        "the hook intercepts that one module and lets its siblings import normally");
      ok(o.preimport_before === true && o.preimport_after === false,
        "a module already imported before the patch runs is patched in place");
      ok(o.finder_count === 1, `applying the patch three times installs one finder (${o.finder_count})`);
      ok(o.wrap_depth === 1, `…and wraps an already-loaded module's predicate once, not once per application (${o.wrap_depth})`);
      ok(o.wrap_depth_hooked === 1, `…and once for a module the hook itself wrapped, too (${o.wrap_depth_hooked})`);
      ok(o.idempotent_is_in_node === false, "…and still answers correctly afterwards");
      ok(o.boom_fetcher === "None" && o.boom_is_in_node === false,
        "a _StreamingFetcher that throws leaves _fetcher None and does NOT cost us the is_in_node fix");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Drift guards for the wiring, which no amount of running the patch can show.
  const runtime = fs.readFileSync(path.join(ROOT, "packages/runtime/builtins/python.js"), "utf8");
  ok(/installUrllib3RealmPatch\(pyodide\);/.test(runtime), "bootPyodide installs the hook, so it is in place before any user code imports requests");
  ok(/runPython\(URLLIB3_REALM_PATCH, \{ globals: ns \}\)/.test(runtime), "…into a namespace of its own, so the REPL's __main__ does not fill up with our plumbing");
  ok(URLLIB3_REALM_PATCH.includes("urllib3.contrib.emscripten.fetch"), "the hook names the module urllib3 actually puts the gate in");
  ok(/hasattr\(js, "XMLHttpRequest"\)/.test(URLLIB3_REALM_PATCH), "the predicate asks the realm for the capability urllib3 wants");
  ok(!/def is_in_node\(\):\s*\n\s*return False/.test(URLLIB3_REALM_PATCH), "…rather than being hard-coded to False");
  ok(/meta_path/.test(URLLIB3_REALM_PATCH) && !/^\s*import urllib3/m.test(URLLIB3_REALM_PATCH),
    "it hooks the import instead of importing urllib3 at boot (which would pull a wheel into every python process)");
}

// ---------------------------------------------------------------------------
console.log("\n== pip's output, held against the output of real pip ==");
// The formatters are pure functions over dist metadata precisely so this check
// can exist without an interpreter. `pip freeze > requirements.txt` is a
// load-bearing idiom, and output that is almost `name==version` is worse than
// none: it fails later, somewhere else, in a file someone committed. So the
// oracle is real pip run on this machine over the same packages — not our idea
// of what pip prints.
// ---------------------------------------------------------------------------
{
  const real = realPipFormat(spawnSync);
  if (!real) {
    // Loud, not skipped: a check that quietly does nothing reads as green.
    console.log("  ! no host python3 -m pip - falling back to the captured pip 25.3 output");
  } else {
    ok(true, `re-derived from real ${real.version} on this machine`);
    for (const k of ["list", "freeze", "emptyList", "emptyFreeze"]) {
      ok(real[k] === CAPTURED[k], `the captured ${k} fixture still matches what real pip prints`);
    }
  }
  const oracle = real || CAPTURED;

  ok(formatPipList(FIXTURE_DISTS) === oracle.list, "formatPipList is byte-identical to real pip list");
  ok(formatPipFreeze(FIXTURE_DISTS) === oracle.freeze, "formatPipFreeze is byte-identical to real pip freeze");
  // The failure this catches: a header row emitted into an empty
  // requirements.txt, or a stray newline that becomes a blank requirement.
  ok(formatPipList([]) === oracle.emptyList, "…and an empty environment prints NOTHING, as real pip does");
  ok(formatPipFreeze([]) === oracle.emptyFreeze, "…for freeze too");

  // Sorting and column width are the two places a hand-rolled table goes wrong.
  const listed = formatPipList(FIXTURE_DISTS).split("\n");
  ok(listed[1] === "-".repeat("zzz-wide-name".length) + " " + "-".repeat("0.3.1.dev0".length),
    "the rule under the header is as wide as the widest entry, not the header");
  ok(!listed.some((l) => / $/.test(l)), "no row is right-padded (real pip leaves the last column ragged)");
  // apple before Zebra: pip lowercases before comparing, and a plain ASCII sort
  // would put every capitalised package first.
  ok(formatPipFreeze([{ name: "Zebra", version: "1" }, { name: "apple", version: "2" }]) === "apple==2\nZebra==1\n",
    "sorting is case-insensitive, as pip's is");

  // pip check: both sentences were reproduced against real pip 25.3, one by
  // removing a dependency and one by rewriting an installed dist-info's Version.
  ok(formatPipCheck([]) === CAPTURED.checkClean, "a clean check prints real pip's exact sentence");
  ok(formatPipCheck([{ kind: "missing", name: "requests", version: "2.34.2", dependency: "idna" }])
    === CAPTURED.checkMissing, "…a missing dependency prints real pip's exact sentence");
  ok(formatPipCheck([{ kind: "version", name: "requests", version: "2.34.2",
    requirement: "urllib3<3,>=1.26", dependency: "urllib3", have: "1.0.0" }])
    === CAPTURED.checkVersion, "…and so does a version conflict");

  // pip show on PEP 621 metadata: no Home-page field, a License-Expression
  // rather than a License, and an extras-only requirement that must not appear.
  ok(formatPipShow({
    name: "tabulate", version: "0.10.0", summary: "Pretty-print tabular data",
    homePage: "https://github.com/astanin/python-tabulate", author: "",
    authorEmail: "Sergey Astanin <s.astanin@gmail.com>", licenseExpression: "MIT",
    requires: [], requiredBy: [],
  }).replace(/^Location: .*\n/m, "") === CAPTURED.showModern,
    "formatPipShow matches real pip on PEP 621 metadata (License-Expression replaces License)");
  ok(/^License: Apache-2\.0$/m.test(formatPipShow({ name: "x", version: "1", license: "Apache-2.0" })),
    "…and prints License when there is no License-Expression");
}

// ---------------------------------------------------------------------------
console.log("\n== the package store: what survives a process, and what must not ==");
// The store's whole job is to outlive the interpreter that filled it, so every
// rule about it is a rule about a fresh process reading someone else's bytes.
// These run against a stub interpreter — Pyodide's FS is a handful of calls, and
// stubbing them is what lets the restore/discard/cap logic gate every PR.
// spike-python-bridge.mjs runs the same shipped functions against a real
// interpreter and real wheels, which is what keeps the stub honest.
// ---------------------------------------------------------------------------
{
  const ENV = { pyTag: "python3.14", pythonVersion: "3.14.2", pyodideVersion: "314.0.3",
    sitePackages: "/lib/python3.14/site-packages" };
  // Just enough Pyodide to exercise the real store code: an in-memory FS.
  const stubPyodide = (files = new Map()) => ({
    version: ENV.pyodideVersion,
    runPython: () => JSON.stringify({ pyTag: ENV.pyTag, pythonVersion: ENV.pythonVersion, sitePackages: ENV.sitePackages }),
    FS: {
      _f: files,
      mkdirTree() {},
      writeFile(p2, data) { files.set(p2, Buffer.from(data)); },
      readFile(p2) { if (!files.has(p2)) throw new Error("ENOENT " + p2); return files.get(p2); },
      readdir(dir) {
        const out = new Set();
        for (const k of files.keys()) if (k.startsWith(dir + "/")) out.add(k.slice(dir.length + 1).split("/")[0]);
        return [".", "..", ...out];
      },
      stat(p2) { return files.has(p2) ? { mode: 1, size: files.get(p2).length } : { mode: 2, size: 0 }; },
      isDir: (m) => m === 2,
      isFile: (m) => m === 1,
    },
  });

  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "vv-store-offline-"));
  const paths = storePaths(proj, ENV.pyTag);

  ok(paths.sitePackages === path.join(proj, ".venv/lib/python3.14/site-packages"),
    "the store is at <project>/.venv/lib/python3.14/site-packages — CPython's own venv layout");
  ok(paths.cfg.endsWith("/.venv/pyvenv.cfg"), "…next to a pyvenv.cfg, where a Python user looks for one");

  // .venv is in SKIP_DIRS, and that is deliberate: the store has to be restored
  // to the INTERPRETER's site-packages, not copied to <cwd>/.venv where no
  // import would look. Guard the comment as well as the code, because the next
  // reader will see the skip and think it is the bug.
  const runtimeSrc = fs.readFileSync(path.join(ROOT, "packages/runtime/builtins/python.js"), "utf8");
  const skipComment = runtimeSrc.slice(0, runtimeSrc.indexOf("const SKIP_DIRS")).split("\n").slice(-6).join("\n");
  ok(/\.venv/.test(skipComment) && /site-packages/.test(skipComment),
    "SKIP_DIRS carries a comment saying why .venv is excluded even though it is now the store");

  // --- the version stamp -----------------------------------------------------
  const good = { storeFormat: STORE_FORMAT, pyTag: ENV.pyTag, pythonVersion: "3.14.2", pyodideVersion: "314.0.3" };
  ok(stampProblem(good, ENV) === null, "a matching stamp restores");
  ok(stampProblem(null, ENV) !== null, "an absent stamp does not");
  for (const [field, value] of [["pythonVersion", "3.13.0"], ["pyodideVersion", "0.26.0"], ["storeFormat", 99]]) {
    const problem = stampProblem({ ...good, [field]: value }, ENV);
    ok(typeof problem === "string" && problem.includes(String(value)),
      `a ${field} mismatch is refused, and the reason names both versions: "${problem}"`);
  }

  // --- restore is all-or-nothing ---------------------------------------------
  fs.mkdirSync(paths.sitePackages, { recursive: true });
  fs.mkdirSync(path.join(paths.sitePackages, "widget"), { recursive: true });
  fs.writeFileSync(path.join(paths.sitePackages, "widget/__init__.py"), "VALUE = 1\n");
  fs.mkdirSync(path.join(paths.sitePackages, "widget-1.0.dist-info"), { recursive: true });
  fs.writeFileSync(path.join(paths.sitePackages, "widget-1.0.dist-info/METADATA"), "Name: widget\nVersion: 1.0\n");
  fs.writeFileSync(paths.stamp, JSON.stringify(good));

  const py1 = stubPyodide();
  const r1 = restoreStore(fs, py1, proj);
  ok(r1.state === "restored" && r1.files === 2, `a valid store restores every file (${r1.files})`);
  ok(py1.FS._f.has(ENV.sitePackages + "/widget/__init__.py"),
    "…into the INTERPRETER's site-packages, which is the only path an import consults");

  fs.writeFileSync(paths.stamp, JSON.stringify({ ...good, pythonVersion: "3.13.0" }));
  const py2 = stubPyodide();
  const r2 = restoreStore(fs, py2, proj);
  ok(r2.state === "discarded", "a stale store is discarded");
  ok(py2.FS._f.size === 0,
    "…having copied NOTHING — a half-restored site-packages imports half a package and fails somewhere else");
  fs.writeFileSync(paths.stamp, JSON.stringify(good));

  // --- the cap is transactional ----------------------------------------------
  const before = walkHost(fs, paths.sitePackages);
  const py3 = stubPyodide(new Map([[ENV.sitePackages + "/big/data.bin", Buffer.alloc(4096)]]));
  const delta = collectDelta(py3, ENV, new Map());
  ok(delta.size === 1, "collectDelta sees only what appeared since the baseline");
  const refused = persistDelta(fs, py3, proj, ENV, delta, "cmd", 1024);
  ok(refused.ok === false && refused.projected > refused.max,
    `over the cap, persistDelta refuses (${refused.projected} B against ${refused.max} B)`);
  const after = walkHost(fs, paths.sitePackages);
  ok(after.size === before.size && [...after].every(([k, v]) => before.get(k) === v),
    "…and the store on disk is byte-for-byte what it was, not grown half way");
  ok(persistDelta(fs, py3, proj, ENV, delta, "cmd").ok === true, "under the cap, the same delta writes");
  fs.rmSync(path.join(paths.sitePackages, "big"), { recursive: true, force: true });

  const capMsg = storeCapError({ projected: 70 * 1024 * 1024, max: STORE_MAX_BYTES }, ["scipy"]);
  ok(/70\.0 MB/.test(capMsg) && /64\.0 MB/.test(capMsg), "the cap error says how big it got and how big is allowed");
  ok(/pip uninstall/.test(capMsg) && /venv --clear/.test(capMsg), "…and names both ways out");
  ok(/nothing was kept/.test(capMsg) && /left exactly as it was/.test(capMsg),
    "…and is explicit that the install did not survive, rather than leaving the user to find out");
  ok(STORE_MAX_BYTES >= 32 * 1024 * 1024, `the cap (${humanBytes(STORE_MAX_BYTES)}) leaves room for a real scientific stack — scipy alone is ~13 MB`);

  // --- freeze describes the store, not the interpreter -----------------------
  const dists = [
    { name: "widget", version: "1.0", distInfo: "widget-1.0.dist-info" },
    { name: "micropip", version: "0.11.1", distInfo: "micropip-0.11.1.dist-info" },
  ];
  const kept = storeDists(fs, proj, ENV, dists);
  ok(kept.length === 1 && kept[0].name === "widget",
    "storeDists keeps what the store holds and drops micropip, which every interpreter has anyway");
  ok(formatPipFreeze(kept) === "widget==1.0\n", "so freeze describes the project's environment, not this boot's");

  // The bug this catches, found by real pip and not by us: an install escapes
  // the project name before naming the directory, so charset-normalizer lands in
  // charset_normalizer-3.4.7.dist-info. Rebuilding `${name}-${version}` instead
  // of using the reported directory silently drops every dashed package.
  fs.mkdirSync(path.join(paths.sitePackages, "charset_normalizer-3.4.7.dist-info"), { recursive: true });
  fs.writeFileSync(path.join(paths.sitePackages, "charset_normalizer-3.4.7.dist-info/METADATA"), "Name: charset-normalizer\n");
  const dashed = storeDists(fs, proj, ENV, [
    { name: "charset-normalizer", version: "3.4.7", distInfo: "charset_normalizer-3.4.7.dist-info" },
  ]);
  ok(dashed.length === 1, "a dashed project name in an underscored dist-info directory is still found");

  // --- pyvenv.cfg is honest about what this is -------------------------------
  const cfg = renderPyvenvCfg({ pyTag: ENV.pyTag, pythonVersion: "3.14.2", pyodideVersion: "314.0.3", command: "python -m venv .venv" });
  ok(/^version = 3\.14\.2$/m.test(cfg) && /^home = /m.test(cfg) && /^command = /m.test(cfg),
    "pyvenv.cfg carries the keys CPython's venv writes");
  ok(/^include-system-site-packages = true$/m.test(cfg),
    "…and says true, because there is one interpreter and no isolation to claim otherwise");
  ok(/not a second interpreter/.test(cfg) && /no isolation/.test(cfg),
    "…and states, in the file itself, that this is a store rather than an environment");

  // Writing into a discarded store is the same partial state arrived at from the
  // other side: a delta merged with bytes this interpreter cannot use, stamped
  // as though they belonged together. pipInstall must refuse, not merge.
  const install = runtimeSrc.slice(runtimeSrc.indexOf("async function pipInstall"), runtimeSrc.indexOf("async function pipList"));
  ok(/restore\.state === "discarded"/.test(install), "pipInstall checks whether the store was discarded before writing to it");
  ok(install.indexOf('restore.state === "discarded"') < install.indexOf("collectDelta"),
    "…and does so before computing a delta, so no stale store is ever written into");
  ok(/venv --clear/.test(install), "…telling the user the one command that clears the way");

  ok(readStamp(fs, proj) !== null && readStamp(fs, path.join(proj, "nope")) === null,
    "readStamp finds a store, and reports its absence rather than throwing");
  ok(STORE_DIR === ".venv", "the store lives at .venv, which is where a Python user already looks");

  fs.rmSync(proj, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("\n== the store's CLI seams ==");
// ---------------------------------------------------------------------------
{
  const run = (...argv) => drivePython(argv);

  for (const [verb, call] of [["list", "pipList"], ["freeze", "pipFreeze"], ["check", "pipCheck"]]) {
    const r = run("-m", "pip", verb);
    ok(r.calls.some((c) => c[0] === call), `python -m pip ${verb} reaches ${call}()`);
  }
  let r = run("-m", "pip", "show", "flask");
  ok(r.calls.some((c) => c[0] === "pipShow" && c[1][0] === "flask"), "python -m pip show names the package");

  // Real pip prompts here. This shim has nowhere to prompt, and assuming the
  // answer would delete a user's packages on a typo.
  r = run("-m", "pip", "uninstall", "flask");
  ok(!r.calls.some((c) => c[0] === "pipUninstall") && /needs -y/.test(r.out),
    "python -m pip uninstall without -y refuses, and says what real pip would have done");
  r = run("-m", "pip", "uninstall", "-y", "flask");
  ok(r.calls.some((c) => c[0] === "pipUninstall" && c[2].yes === true), "…and -y goes through");

  // The escape hatch, refused honestly rather than aliased to something else:
  // real `pip cache purge` clears pip's download cache, and ours is the
  // browser's, which nothing in the VM can evict.
  r = run("-m", "pip", "cache", "purge");
  ok(r.code === 1 && /no pip cache here/.test(r.out) && /browser/.test(r.out),
    "python -m pip cache says why there is no cache to purge");
  ok(/pip uninstall/.test(r.out) && /venv --clear/.test(r.out), "…and names what does free space");

  r = run("-m", "venv", ".venv");
  ok(r.calls.some((c) => c[0] === "venv" && c[1] === ".venv"), "python -m venv .venv reaches venv()");
  r = run("-m", "venv", "--clear", ".venv");
  ok(r.calls.some((c) => c[0] === "venv" && c[2].clear === true), "…and --clear is honoured, since it is the documented rebuild");

  // Same two tiers as the server shims: warn where the job still gets done,
  // refuse where honouring the flag would mean claiming something untrue.
  r = run("-m", "venv", "--system-site-packages", ".venv");
  ok(/--system-site-packages is ignored/.test(r.out) && r.calls.some((c) => c[0] === "venv"),
    "venv --system-site-packages warns (it is already true) and still creates the store");
  r = run("-m", "venv", "--without-pip", ".venv");
  ok(/--without-pip is ignored/.test(r.out), "venv --without-pip warns rather than pretending to isolate pip");
  r = run("-m", "venv", "--upgrade", ".venv");
  ok(r.code === 1 && /--upgrade is not supported/.test(r.out) && /--clear/.test(r.out),
    "venv --upgrade is refused — re-stamping a store built elsewhere is the half-loaded state the stamp prevents");
  r = run("-m", "venv", "--nope", ".venv");
  ok(r.code === 1 && /unknown option/.test(r.out), "an unknown venv flag is refused, not ignored");

  const help = drivePython(["--help"]).out;
  ok(/python -m venv \.venv/.test(help), "the help text lists venv");
  ok(/pip list/.test(help) && /pip uninstall/.test(help), "…and the pip verbs the store made possible");
}

// ---------------------------------------------------------------------------
console.log("\n== every entrypoint, reachable by the name a user types ==");
// WHY THIS SECTION EXISTS. The store shipped working and unreachable: every
// verb above passed, because every assertion drove `python -m pip` — and a user
// typed `pip list` and got `sh: pip: not found`. The template check did not see
// it either, since it asserts a manifest's first word is on PATH and every
// Python manifest begins `python`. So the section above proves the seam works,
// and this one proves something can get to it.
//
// It is deliberately derived rather than listed. A hand-written list of the six
// entrypoints would have been written when pip was added and would have had the
// same hole; taking the list from the launcher's own dispatch means adding a
// seventh `-m` entrypoint fails here until it is either put on PATH or excused
// in writing, with the excuse checked against a real Python.
// ---------------------------------------------------------------------------
{
  const dispatched = [...PYTHON_PROGRAM.matchAll(/if \(mod === '([a-z0-9_.]+)'\)/g)].map((m) => m[1]);
  ok(dispatched.length >= 6, `the launcher dispatches ${dispatched.length} -m entrypoints: ${dispatched.join(", ")}`);

  // CPython ships no `venv` executable — `python -m venv` is the only spelling
  // there has ever been — so this one is excused. Asked of the host rather than
  // asserted, because "no such binary exists" is a claim about the outside world.
  const onHost = (name) => spawnSync("sh", ["-c", "command -v " + name], { encoding: "utf8" }).status === 0;
  const EXCUSED = {
    venv: "CPython ships no venv binary; python -m venv is the only spelling",
    "http.server": "a dotted module name is not a command; python -m http.server is the only spelling",
  };

  for (const mod of dispatched) {
    const bare = Object.entries(PYTHON_DELEGATES).filter(([, m]) => m === mod).map(([n]) => n);
    if (EXCUSED[mod]) {
      ok(bare.length === 0 && !onHost(mod),
        `${mod} has no bare command, and this host's Python agrees it should not (${EXCUSED[mod]})`);
    } else {
      ok(bare.length > 0, `python -m ${mod} is also reachable as: ${bare.join(", ") || "NOTHING — it would ship unreachable"}`);
    }
  }

  // pip3 beside pip for the same reason python3 sits beside python: both are
  // installed on a real machine and scripts pick either.
  ok(COREUTILS.pip && COREUTILS.pip3, "pip and pip3 are both on PATH");
  ok(onHost("pip3"), "…which is what this host has too");
  ok(Object.keys(COREUTILS).includes("python3"), "python3 is on PATH, the pattern pip3 follows");

  // Faithful delegation. A shim that drops a flag is the same lie as a runtime
  // that drops it, and `pip install -r requirements.txt` is the form every
  // template README uses, so it is the one worth spelling out.
  for (const [name, mod] of Object.entries(PYTHON_DELEGATES)) {
    const argv = ["install", "-r", "requirements.txt", "--no-input"];
    const r = driveShim(COREUTILS[name], argv);
    const got = r.spawned;
    ok(got && got.cmd === "python" && JSON.stringify(got.args) === JSON.stringify(["-m", mod, ...argv]),
      `${name} spawns python -m ${mod} with argv passed through verbatim`);
  }
  ok(driveShim(COREUTILS.uvicorn, ["main:app", "--port", "8000"]).spawned.opts.cwd === "/project",
    "…in the caller's cwd, so a relative app path resolves the way it reads");

  // Exit codes. `pip install x && python main.py` and `pytest && echo ok` are
  // both in our own template READMEs; a shim that reported 0 for a failed child
  // would break the second half of each.
  ok(driveShim(COREUTILS.pip, ["list"], { exitWith: 2 }).code === 2, "pip forwards the child's exit code");
  ok(driveShim(COREUTILS.pytest, ["-q"], { exitWith: 1 }).code === 1, "pytest forwards a failing exit code rather than swallowing it");
  ok(driveShim(COREUTILS.pip, ["list"], { exitWith: 0 }).code === 0, "…and a passing one");
  const broke = driveShim(COREUTILS.pip, ["list"], { failWith: "spawn ENOENT" });
  ok(broke.code === 1 && /^pip: spawn ENOENT/.test(broke.out), "a shim that cannot spawn says which command failed, and exits non-zero");

  // Every command the docs and the templates tell a user to type. This is the
  // check the old template assertion was reaching for, widened past the first
  // word of a manifest to the commands prose actually shows.
  const programs = new Set(Object.keys(COREUTILS));
  const pyDocs = fs.readFileSync(path.join(ROOT, "sites/docs/docs/python.md"), "utf8");
  const typed = new Set();
  for (const m of pyDocs.matchAll(/```(?:bash|sh|console|shell)\n([\s\S]*?)```/g)) {
    const block = m[1];
    // A block that installs something is allowed to then USE what it installed.
    // That is the console-scripts feature: `pip install httpie` and then `http`
    // is a command that exists, just not until the line above it ran. Blocks
    // that install nothing stay strict, which is what this check is for — the
    // bug it catches is prose telling someone to type a command Vivari does not
    // have, and a demonstrated install is the difference.
    if (/^\s*pip\s+install\s+\S/m.test(block)) continue;
    for (const line of block.split("\n")) {
      const t = line.trim();
      if (t && !t.startsWith("#")) typed.add(t.split(/\s+/)[0]);
    }
  }
  const templates = await readShippedManifests(readTemplatesSource());
  for (const id of NEW_TEMPLATES) {
    const man = templates[id];
    if (!man) continue;
    for (const key of ["install", "dev"]) if (man[key]) typed.add(String(man[key]).split(/\s+/)[0]);
  }
  const unreachable = [...typed].filter((w) => !programs.has(w));
  ok(unreachable.length === 0,
    unreachable.length
      ? `the docs and templates tell users to type: ${unreachable.join(", ")} — not on PATH`
      : `all ${typed.size} commands the docs and templates tell users to type are on PATH: ${[...typed].sort().join(", ")}`);

  // pip's top level, which nobody could reach before the shim: `python -m pip`
  // with no verb is not a thing people type, and `pip` alone very much is.
  // Shapes held against real pip, same as the formatters above.
  const unknown = realPipUnknown(spawnSync, "frobnicate");
  const suggest = realPipUnknown(spawnSync, "instal");
  if (!unknown || !suggest) {
    ok(false, "no usable pip on this machine to re-derive the unknown-command shape from");
  } else {
    ok(unknown.text === CAPTURED.unknownCommand && suggest.text === CAPTURED.unknownCommandSuggest,
      "real pip still prints the unknown-command lines this shim is shaped after");
  }
  const oracleUnknown = (unknown || { text: CAPTURED.unknownCommand, status: 1 });
  const oracleSuggest = (suggest || { text: CAPTURED.unknownCommandSuggest, status: 1 });

  let p = drivePython(["-m", "pip", "frobnicate"]);
  ok(p.out === oracleUnknown.text && p.code === oracleUnknown.status,
    "pip <nonsense> prints real pip's line, to the byte, and exits 1");
  p = drivePython(["-m", "pip", "instal", "flask"]);
  ok(p.out === oracleSuggest.text, "…and suggests the near miss the way pip's difflib does");

  // The distinction that matters more than either: 'download' is a command real
  // pip HAS. Calling it unknown would be false and would send someone hunting
  // for a typo that is not there; the honest answer names it and says what is here.
  p = drivePython(["-m", "pip", "download", "flask"]);
  ok(p.code === 1 && /a real pip command that this shim does not have/.test(p.out) && !/unknown command/.test(p.out),
    "a real pip command we lack is refused as missing, not as a typo");
  ok(/install, list, freeze, show, uninstall, check/.test(p.out), "…and the refusal names what is here");

  // Bare pip. Real pip prints a usage block and exits 0; this one lists the six
  // commands it has rather than reprinting a menu of nineteen it does not.
  const bare = drivePython(["-m", "pip"]);
  ok(bare.code === 0 && /^\nUsage:/.test(bare.out) && /\n {2}pip <command> \[options\]/.test(bare.out),
    "bare pip prints usage in pip's shape and exits 0, as real pip does");
  for (const verb of ["install", "uninstall", "freeze", "list", "show", "check"]) {
    ok(new RegExp("\\n  " + verb + " {2,}[A-Z]").test(bare.out), `…listing ${verb} in pip's two-column layout`);
  }
  ok(!/\n {2}(download|wheel|config|debug) /.test(bare.out), "…and listing nothing it cannot do");
  ok(drivePython(["-m", "pip", "--help"]).out === bare.out && drivePython(["-m", "pip", "help"]).out === bare.out,
    "pip --help and pip help print the same block");
  const ver = drivePython(["-m", "pip", "--version"]);
  ok(ver.code === 0 && /^pip .* from .* \(python 3\.14\)\n$/.test(ver.out),
    "pip --version keeps the shape scripts grep for");
  ok(/Vivari shim/.test(ver.out) && !/^pip \d/.test(ver.out),
    "…without claiming a pip version number this is not");
}

// ---------------------------------------------------------------------------
console.log("\n== what a pip command actually puts on stdout ==");
// WHY THIS IS A SUBPROCESS. `pip freeze > requirements.txt` wrote
//
//     Loading packaging
//     Loaded packaging
//     tabulate==0.10.0
//
// and every check above stayed green, because they all compare what
// formatPipFreeze() *returns*. Nothing that inspects a return value can see a
// second writer on the same stream. Pyodide's package loader defaults to the
// interpreter's own stdout — the stream bootPyodide points at process.stdout —
// so it was printing into pip's payload: the content right, the stream wrong,
// which is the version that survives the terminal and breaks later inside a
// committed file.
//
// So this runs the real runtime in a real process and trusts only the pipe.
// The interpreter is a stand-in (scripts/lib/fake-pyodide.mjs); the bug never
// needed a real one, because it lives entirely in whether a call passes a
// messageCallback — and the stand-in reproduces exactly that fork. The bridge
// tier checks the stand-in's claim against real Pyodide.
// ---------------------------------------------------------------------------
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vv-pipout-"));
  const proj = path.join(root, "proj");
  fs.mkdirSync(proj, { recursive: true });
  const ENV = { pyTag: "python3.14", pythonVersion: "3.14.2", pyodideVersion: "314.0.3" };
  const paths = storePaths(proj, ENV.pyTag);
  // Two packages, one of them dashed, so a listing that drops dashed names or
  // sorts case-sensitively shows up here as well.
  for (const [dir, name, version] of [
    ["tabulate-0.10.0.dist-info", "tabulate", "0.10.0"],
    ["charset_normalizer-3.4.9.dist-info", "charset-normalizer", "3.4.9"],
  ]) {
    fs.mkdirSync(path.join(paths.sitePackages, dir), { recursive: true });
    fs.writeFileSync(
      path.join(paths.sitePackages, dir, "METADATA"),
      `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\nSummary: fixture\n`,
    );
  }
  fs.writeFileSync(paths.cfg, renderPyvenvCfg({ ...ENV, command: "python -m venv .venv" }));
  fs.writeFileSync(paths.stamp, JSON.stringify(makeStamp({ ...ENV, files: 2, bytes: 137 })));
  const indexDir = writeFakeIndex(fs, path, path.join(root, "idx"));

  const runPip = (verb) =>
    spawnSync(process.execPath, [path.join(ROOT, "scripts/lib/pip-stdout-child.mjs"), verb, proj, indexDir],
      { encoding: "utf8" });

  const freeze = runPip("freeze");
  ok(freeze.stdout === "charset-normalizer==3.4.9\ntabulate==0.10.0\n",
    `pip freeze puts the requirements lines on stdout and nothing else: ${JSON.stringify(freeze.stdout)}`);
  const list = runPip("list");
  ok(list.stdout ===
      "Package            Version\n------------------ -------\ncharset-normalizer 3.4.9\ntabulate           0.10.0\n",
    "pip list puts the table on stdout and nothing else");

  // The other half of the same assertion, and the one that keeps it honest: the
  // loader really did run and really did have something to say. Without this,
  // deleting the loadPackage call would make the two checks above pass.
  ok(/Loading packaging\nLoaded packaging\n/.test(freeze.stderr),
    "…while the loader progress it emitted went to stderr, where a redirect leaves it");
  ok(/Loading packaging/.test(list.stderr), "…same for pip list");
  ok(freeze.status === 0 && list.status === 0, "both still exit 0");

  // pip install is the deliberate exception: the packages the user asked for
  // are command output — real pip prints Collecting/Downloading on stdout — and
  // this shim's own success lines are already there. Our own micropip is not.
  const install = runPip("install");
  ok(/^Loading tabulate\nLoaded tabulate\nInstalled: tabulate\n/.test(install.stdout),
    "pip install keeps progress for the requested package on stdout, as real pip does");
  ok(/Loading micropip/.test(install.stderr) && !/micropip/.test(install.stdout),
    "…but loading our own micropip is diagnostics, and stays off stdout");

  fs.rmSync(root, { recursive: true, force: true });

  // The generalisable half. Nothing stops the next call site omitting the
  // callback again, so require every one of them to say where it wants its
  // output to go — a check a reviewer would otherwise have to make by eye.
  const runtimeSrc = fs.readFileSync(path.join(ROOT, "packages/runtime/builtins/python.js"), "utf8");
  const callSites = [...runtimeSrc.matchAll(/\.(loadPackage|loadPackagesFromImports)\(([^;]*?)\);/g)];
  ok(callSites.length >= 8, `${callSites.length} package-loader call sites in the runtime`);
  const bare = callSites.filter((m) => !/,\s*loaderTo(Stderr|Stdout)\s*\)?$/.test(m[2].trim()));
  ok(bare.length === 0,
    bare.length
      ? `these inherit Pyodide's default, which is the interpreter's stdout: ${bare.map((m) => m[0]).join(" | ")}`
      : "every package-loader call names the stream it writes to, so none can inherit the default");
  ok(/loaderToStdout/.test(runtimeSrc) && runtimeSrc.match(/loaderToStdout\b/g).length === 2,
    "…and exactly one of them opts into stdout (the definition plus its single use)");
}

// ---------------------------------------------------------------------------
console.log("\n== the version literal /bin/python.js prints without booting ==");
// PYTHON_PROGRAM is a no-interpolation template literal, so it cannot import the
// version and has to carry a copy. Keeping --version boot-free is worth that;
// leaving the copy unpinned is not. Exactly the BUN_PROGRAM/BUN_VERSION
// arrangement in AGENTS.md: the literal is held against the constant here, and
// the constant against a real interpreter's sys.version in the bridge tier.
// ---------------------------------------------------------------------------
{
  const m = PYTHON_PROGRAM.match(/const STATIC_VERSION = '([^']+)'/);
  ok(m, "STATIC_VERSION is a findable literal in the shipped program");
  const literal = m ? m[1] : "";
  ok(literal.includes(PYODIDE_PYTHON_VERSION),
    `--version prints the vendored Pyodide's Python: ${JSON.stringify(literal)} carries ${PYODIDE_PYTHON_VERSION}`);
  // Real CPython prints the patch number. Printing 3.14 next to a script that
  // reports 3.14.2 is a difference a user notices and cannot explain.
  ok(/^\d+\.\d+\.\d+$/.test(PYODIDE_PYTHON_VERSION), "…and it is a full patch version, as CPython prints");
  ok(/^Python \d/.test(literal), "…in CPython's own `Python X.Y.Z` shape");

  const r = drivePython(["--version"]);
  ok(r.code === 0 && r.out === literal + "\n", "python --version prints it");
  ok(!r.calls.length, "…without booting Pyodide, which is why the literal exists at all");
}

// ---------------------------------------------------------------------------
console.log("\n== the docs claims this change corrected ==");
// These were published and wrong. A guard here is the cheapest way to stop the
// old wording coming back in a later edit.
// ---------------------------------------------------------------------------
{
  const docs = fs.readFileSync(path.join(ROOT, "sites/docs/docs/python.md"), "utf8");
  ok(!/No outbound network from Python/.test(docs), "the 'no outbound network' claim is gone (it was false: requests, pyfetch and js.fetch all reach the network)");
  ok(/## Talking to the network/.test(docs), "…replaced by a section that shows how");
  ok(/TLS not supported in this environment/.test(docs), "the real socket-level limit is named: ssl is a stub");
  ok(/Access-Control-Allow-Origin/.test(docs) && /not something Vivari can lift/.test(docs),
    "…and CORS is named as the ceiling, with no bypass implied");
  ok(!/not shipping yet/.test(docs), "the asyncio.run() claim no longer says the capability is unshipped");
  ok(/Chrome\s+\n?ships from 137|ships from 137/.test(docs) && /Firefox from 139/.test(docs),
    "…it names the versions that ship JSPI instead");

  // The store's claims. `.venv` is the one place a familiar name does not carry
  // all of its usual meaning, so the page has to say which parts it does carry.
  ok(!/pip install` does not accumulate state/.test(docs) && !/warm browser cache, making the next run faster/.test(docs),
    "the 'pip install does not persist' paragraph is gone — it stopped being true with this change");
  ok(/## `pip install`, and the `\.venv` it writes to/.test(docs), "…replaced by a section about the store");
  ok(/package store, not a second interpreter/.test(docs), "the docs say what .venv is here, in those words");
  ok(/no `bin\/activate`/.test(docs) && /no\s+isolation/.test(docs),
    "…and what it is not: no activate script, and no isolation to be had from one interpreter per process");
  ok(/Two projects get two stores/.test(docs), "…while naming the part of a virtualenv it does give you");
  ok(/capped at 64 MB/.test(docs) && /refused outright/.test(docs) && /left exactly as it was/.test(docs),
    "the size cap is documented, including that hitting it changes nothing");
  ok(/ignored rather than\s+half-loaded/.test(docs) && /venv --clear/.test(docs),
    "…and so is the stale-store rule, with the command that rebuilds it");
  // Spelled `pip …`, not `python -m pip …`. Both work, but the docs should show
  // the form a user will actually type — and for a while only the second one
  // did anything, which is how the missing PATH shim went unnoticed.
  ok(/\npip freeze/.test(docs) && /\npip uninstall -y/.test(docs),
    "the verbs the store made possible are shown, uninstall with the -y this shim needs");
  ok(!/python -m pip/.test(docs), "…and shown as `pip`, since that is now on PATH");
}

// ---------------------------------------------------------------------------
console.log("\n== the Python spikes are actually wired into CI ==");
// The Bun Phase 0 change found spike-bun.mjs running in no job at all. This is
// the same guard for Python: assert both tiers stay registered and that this
// file lands in the one CI runs per-PR.
// ---------------------------------------------------------------------------
{
  const runner = fs.readFileSync(path.join(ROOT, "scripts/run-spikes.mjs"), "utf8");
  const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");

  const offlineEntry = /\{ name: "python-offline",[^}]*net: false[^}]*\}/.test(runner);
  ok(offlineEntry, "run-spikes.mjs registers python-offline in the offline tier");
  ok(/\{ name: "python",[^}]*net: true[^}]*\}/.test(runner), "…and the Pyodide-backed bridge spike in the network tier");
  ok(!/name: "python-offline",[^}]*needsWasm/.test(runner), "python-offline claims no Wasm, so the Wasm-free gate cannot skip it");

  // toolchain-gate runs the offline tier with no filter, so anything net:false
  // and Wasm-free runs there on every push and PR.
  const unfiltered = ci.split("\n").some((l) => /run-spikes\.mjs --offline\s*$/.test(l.trim()));
  ok(unfiltered, "a CI job runs the offline spike tier unfiltered (that is what gates this file on every PR)");
}

// ---------------------------------------------------------------------------
console.log("\n== python -m: what the shim intercepts, and what it hands to runpy ==");
// `-m` used to be an allowlist of six modules and a refusal for everything else,
// which made a dispatch gap look like a capability gap: `python -m unittest`
// reported that arbitrary modules "are not supported" for a runner sitting in
// the stdlib the interpreter had already loaded. The six are still intercepted,
// and each has a reason that runpy cannot supply. Everything else goes through.
// ---------------------------------------------------------------------------
{
  // The interceptions, and what each one must reach instead of runpy.
  const SEAMS = [
    [["-m", "pip", "list"], "pipList", "the package store"],
    [["-m", "venv", ".venv"], "venv", "the package store"],
    [["-m", "uvicorn", "main:app"], "serve", "the ASGI bridge"],
    [["-m", "flask", "run"], "serve", "the WSGI bridge"],
    [["-m", "gunicorn", "wsgi:app"], "serve", "the WSGI bridge"],
    [["-m", "pytest", "-q"], "runCode", "the exit-code seam"],
    [["-m", "http.server"], "serveStatic", "a socket we do not have"],
  ];
  for (const [argv, verb, why] of SEAMS) {
    const r = drivePython(argv);
    const got = r.calls.length ? r.calls[0][0] : "(nothing)";
    ok(got === verb, `python ${argv.join(" ")} -> ${verb}() — intercepted, because it needs ${why}`);
  }

  // …and everything else reaches runpy, with argv and cwd passed through.
  for (const [argv, mod, rest] of [
    [["-m", "unittest"], "unittest", []],
    [["-m", "unittest", "discover", "-v"], "unittest", ["discover", "-v"]],
    [["-m", "json.tool", "in.json", "out.json"], "json.tool", ["in.json", "out.json"]],
    [["-m", "calendar", "2026", "8"], "calendar", ["2026", "8"]],
    [["-m", "this"], "this", []],
    // Not a real module. It still has to reach runpy: deciding here that a name
    // does not exist is how the old allowlist got the error wrong.
    [["-m", "nosuchthing"], "nosuchthing", []],
  ]) {
    const r = drivePython(argv);
    const c = r.calls[0];
    ok(
      c && c[0] === "runModule" && c[1] === mod && JSON.stringify(c[2]) === JSON.stringify(rest) && c[3] === "/project",
      `python ${argv.join(" ")} -> runModule(${JSON.stringify(mod)}, ${JSON.stringify(rest)}, cwd)`,
    );
  }

  // The allowlist refusal is gone. A module name must never produce it again.
  const gone = drivePython(["-m", "unittest"]);
  ok(
    !/not supported in the Vivari shim/.test(gone.out),
    "…and no module gets the old \"arbitrary modules are not supported\" line",
  );

  // runModule builds the runpy call the interpreter will execute. The argv it
  // hands over is CPython's: sys.argv[0] is the module, not the -m flag.
  const built = drivePython(["-m", "unittest", "discover"]);
  ok(built.calls[0][2].length === 1, "the module's own args are forwarded, and the module name is not one of them");
}

// ---------------------------------------------------------------------------
console.log("\n== the -m failures, against real CPython on this host ==");
// The oracle rule, same as lib/cpython-exit.mjs: once arbitrary modules run, a
// Vivari-flavoured error for a missing one is a lie about what happened. These
// messages are CPython's because they come OUT of CPython — runpy raises
// SystemExit("%s: %s" % (sys.executable, exc)) and the shim's existing
// SystemExit handling prints it. So what is checkable here is the shape, and
// the shape is checked against the interpreter on this machine.
// ---------------------------------------------------------------------------
{
  const real = (args) => {
    const r = spawnSync("python3", args, { encoding: "utf8" });
    return r.error ? null : { code: r.status, err: (r.stderr || "").trimEnd(), out: (r.stdout || "").trimEnd() };
  };
  const probe = real(["-c", "print(1)"]);
  ok(probe && probe.code === 0, "a real CPython is on PATH to be the oracle for the messages below");

  if (probe) {
    // 1. A module that is not there.
    const miss = real(["-m", "definitely_not_a_module"]);
    ok(miss.code === 1, `real CPython exits 1 for a missing -m module (got ${miss.code})`);
    ok(
      /^\S+: No module named definitely_not_a_module$/.test(miss.err),
      `…printing "<sys.executable>: No module named X" (got ${JSON.stringify(miss.err)})`,
    );
    // The shim produces that string by letting runpy produce it, so what the
    // spike can pin here is that it does not produce a DIFFERENT one, and that
    // the prefix it will carry is a name rather than a host path.
    ok(
      PYTHON_EXECUTABLE === "python" && !PYTHON_EXECUTABLE.includes("/"),
      `sys.executable is set to ${JSON.stringify(PYTHON_EXECUTABLE)} — the prefix runpy puts on that message`,
    );
    ok(
      /sys\.executable = /.test(String(setExecutable)),
      "…and setExecutable() is what assigns it, at boot",
    );

    // 2. -m with no module at all. This one the shim answers itself, because
    // there is no module name to hand runpy.
    const bare = real(["-m"]);
    const ours = drivePython(["-m"]);
    ok(bare.code === 2 && ours.code === 2, `python -m with no argument exits 2, as CPython does (got ${ours.code})`);
    ok(
      ours.out.trim().split("\n")[0] === bare.err.split("\n")[0],
      `…with CPython's first line verbatim: ${JSON.stringify(bare.err.split("\n")[0])}`,
    );

    // 3. The flags http.server really has, so a command copied from a tutorial
    // parses the same way here. Read them off the real module rather than a
    // list kept in this file.
    const help = real(["-m", "http.server", "--help"]);
    const flags = [...(help.out || "").matchAll(/(?:^|\s)(--[a-z-]+)/g)].map((m) => m[1]);
    for (const f of ["--bind", "--directory", "--protocol", "--cgi"]) {
      ok(flags.includes(f), `real http.server has ${f}, so the shim has to answer for it`);
    }
    for (const [argv, expect] of [
      [["-m", "http.server"], { port: 8000, directory: null }],
      [["-m", "http.server", "8080"], { port: 8080, directory: null }],
      [["-m", "http.server", "-d", "public"], { port: 8000, directory: "public" }],
      [["-m", "http.server", "--directory=public", "9000"], { port: 9000, directory: "public" }],
    ]) {
      const c = drivePython(argv).calls[0];
      ok(
        c && c[0] === "serveStatic" && c[1].port === expect.port && c[1].directory === expect.directory,
        `python ${argv.join(" ")} -> port ${expect.port}, directory ${JSON.stringify(expect.directory)}`,
      );
    }
    // A flag that changes what the server DOES cannot be quietly dropped.
    const cgi = drivePython(["-m", "http.server", "--cgi"]);
    ok(cgi.code === 1 && /needs a subprocess/.test(cgi.out), "--cgi is refused with the reason, not ignored (it would serve source instead of running it)");
    const tls = drivePython(["-m", "http.server", "--tls-cert", "x.pem"]);
    ok(tls.code === 1 && /ssl module is a stub/.test(tls.out), "--tls-cert is refused with the reason");
    // …and one that does not change the answer is ignored OUT LOUD.
    const bind = drivePython(["-m", "http.server", "-b", "0.0.0.0", "8080"]);
    ok(bind.calls[0][1].port === 8080 && /-b is ignored here/.test(bind.out), "-b is ignored out loud, and does not eat the port");
    // Bad input gets CPython's exit code for a usage error.
    ok(drivePython(["-m", "http.server", "nope"]).code === 2, "an unparseable port exits 2");
    ok(drivePython(["-m", "http.server", "--bogus"]).code === 2, "an unknown flag exits 2 rather than being swallowed");
  }
}

// ---------------------------------------------------------------------------
console.log("\n== the modules that cannot work here say why ==");
// Pyodide has a socket module, and that is the problem rather than the relief:
// connect(), bind() and listen() all succeed and then no bytes move (proven in
// the bridge spike). A module whose whole job is a socket would therefore print
// its banner and hang. The shim-honesty rule says name the reason.
// ---------------------------------------------------------------------------
{
  // Read the shipped list out of PYTHON_PROGRAM: a copy here would let the two
  // drift, and the drift would read as a passing test.
  const block = /const SOCKET_MODULES = \{([\s\S]*?)\n\};/.exec(PYTHON_PROGRAM);
  ok(!!block, "the refusal table is where this check expects to read it");
  const REFUSALS = [...block[1].matchAll(/^\s*'?([\w.]+)'?:\s*'((?:[^'\\]|\\.)*)'/gm)]
    .map((m) => [m[1], m[2].replace(/\\'/g, "'")]);
  const SOCKET_MODULES = REFUSALS.map(([m]) => m);
  ok(SOCKET_MODULES.length >= 5, `${SOCKET_MODULES.length} socket-bound modules are refused by name`);

  for (const [mod, reason] of REFUSALS) {
    const r = drivePython(["-m", mod]);
    ok(r.code === 1, `python -m ${mod} fails rather than hanging`);
    // The module's OWN reason, not just the shared note underneath it. "not
    // supported" next to a paragraph about sockets still leaves the reader
    // guessing which of the two applies to the command they typed.
    ok(r.out.includes(mod) && r.out.includes(reason), `…with its own reason: ${reason.slice(0, 52)}…`);
    ok(!r.calls.length, `…and never reaches the interpreter`);
  }
  // The refusal has to explain the trap, not just assert it: a reader who knows
  // Pyodide has `socket` needs to be told it is the connecting that is fake.
  const r = drivePython(["-m", "smtplib"]);
  ok(
    /connects and binds without error and then carries no bytes/.test(r.out),
    "…and explains that the socket is the lie, not the absence of one",
  );
  // Nothing in the refusal list may also be a seam: it would be unreachable.
  const seams = ["pip", "venv", "uvicorn", "flask", "gunicorn", "pytest", "mypy", "http.server"];
  ok(!seams.some((s) => SOCKET_MODULES.includes(s)), "no module is both intercepted and refused");
}

// ---------------------------------------------------------------------------
console.log("\n== the checkers, and the Django command that would hang ==");
// ---------------------------------------------------------------------------
{
  // mypy and black are the two tools a Python user runs over their own code,
  // and they reach the interpreter by deliberately different routes. black is
  // an ordinary module: runpy runs it and nothing here needs to know anything
  // about black. mypy cannot be, because it ends by calling os._exit(), which
  // under Emscripten tears down the interpreter — the diagnostics print and
  // then the exit code is lost, so `mypy && deploy` would deploy. The bridge
  // tier proves that against the real thing; this holds the shape in place.
  let r = drivePython(["-m", "black", "src/"]);
  const blackCall = r.calls.find((c) => c[0] === "runModule");
  ok(blackCall && blackCall[1] === "black" && JSON.stringify(blackCall[2]) === '["src/"]',
    "python -m black goes through plain runpy, argv intact");
  ok(!r.calls.some((c) => c[0] === "runCode"), "…with no seam of its own in the way");

  r = drivePython(["-m", "mypy", "--strict", "app.py"]);
  const mypyCall = r.calls.find((c) => c[0] === "runCode");
  ok(!!mypyCall, "python -m mypy runs a synthesised program instead");
  ok(mypyCall && /from mypy import api/.test(mypyCall[1]) && /api\.run\(/.test(mypyCall[1]),
    "…which goes in through mypy.api.run(), the entrypoint that skips the os._exit() path");
  ok(mypyCall && mypyCall[1].includes(JSON.stringify(["--strict", "app.py"])),
    "…forwarding argv verbatim, so mypy's own flags reach mypy");
  ok(mypyCall && /sys\.exit\(code\)/.test(mypyCall[1]), "…and mypy's exit status becomes the process's");
  // No invented default: mypy with no target has its own usage error, and a
  // silent "." here would check a different thing than the command it imitates.
  r = drivePython(["-m", "mypy"]);
  const bare = r.calls.find((c) => c[0] === "runCode");
  ok(bare && /api\.run\(\[\]\)/.test(bare[1]), "python -m mypy with no target forwards no target, rather than guessing one");

  // Both have to be reachable by the name people type. The generic check above
  // covers mypy (it is a -m seam); black is not, so it needs saying here.
  ok(PYTHON_DELEGATES.black === "black" && COREUTILS.black, "black is on PATH, not only reachable as python -m black");
  ok(PYTHON_DELEGATES.mypy === "mypy" && COREUTILS.mypy, "mypy is on PATH too");

  // --- manage.py runserver --------------------------------------------------
  // The socket refusals are keyed on -m module names, and runserver arrives as
  // a script path, so it slipped past all of them. Vivari ships a Django
  // template, which makes this the most likely command in the whole surface.
  r = drivePython(["manage.py", "runserver"]);
  ok(r.code === 1, "python manage.py runserver fails instead of hanging");
  ok(/binds a TCP socket/.test(r.out), "…saying that the dev server wants a socket");
  ok(/never answer/.test(r.out), "…and that the failure mode would have been silence, not an error");
  ok(/gunicorn wsgi:application/.test(r.out), "…and naming the command that does work, which the template already uses");
  ok(!r.calls.length, "…without booting an interpreter to find out");

  // The refusal must be narrow. Everything else about manage.py still works,
  // and a refusal standing in front of `migrate` would be its own bug.
  for (const sub of ["migrate", "makemigrations", "shell", "createsuperuser", "collectstatic"]) {
    const m = drivePython(["manage.py", sub]);
    ok(m.calls.some((c) => c[0] === "runFile"), `python manage.py ${sub} still reaches the interpreter`);
  }
  ok(drivePython(["manage.py", "runserver", "--help"]).calls.some((c) => c[0] === "runFile"),
    "…as does runserver --help, which binds nothing and prints Django's own help");
  ok(drivePython(["serve.py", "runserver"]).calls.some((c) => c[0] === "runFile"),
    "…and a script that merely has 'runserver' in its argv is not second-guessed");
  ok(drivePython(["app/manage.py", "runserver"]).code === 1,
    "…while manage.py in a subdirectory is still caught");
}

// ---------------------------------------------------------------------------
console.log("\n== mypy is actually vendored, or the command is a promise we break ==");
// ---------------------------------------------------------------------------
{
  // The seam above is inert without the wheel. Pyodide's lockfile declares mypy
  // as depending on librt alone, but a checked file imports typing_extensions,
  // then mypy_extensions, then pathspec — each surfacing only once the previous
  // is satisfied. loadPackage() succeeds either way, so an under-declared dep
  // fails in front of the user rather than at build time.
  const src = fs.readFileSync(path.join(ROOT, "scripts/vendor-pyodide.mjs"), "utf8");
  const defaults = /const DEFAULT_PACKAGES = \[([^\]]*)\]/.exec(src);
  ok(defaults && /"mypy"/.test(defaults[1]), "mypy is in the vendored package set, so `mypy` works offline");

  const fixups = /const DEPENDS_FIXUPS = \{([\s\S]*?)\n\};/.exec(src);
  ok(!!fixups, "the under-declared-dependency table is where this check reads it");
  const mypyFix = fixups && /mypy:\s*\[([^\]]*)\]/.exec(fixups[1]);
  ok(!!mypyFix, "…and it has an entry for mypy");
  for (const dep of ["typing-extensions", "mypy-extensions", "pathspec"]) {
    ok(mypyFix && mypyFix[1].includes(`"${dep}"`), `…naming ${dep}, which mypy imports but the lock does not declare`);
  }
  // Two of the three come from the PyPI pins black already needed. If someone
  // drops black's pins, mypy loses them too, and the failure would look like a
  // mypy bug rather than a vendoring one.
  const pypi = /const PYPI_PACKAGES = \[([\s\S]*?)\n\];/.exec(src);
  for (const dep of ["mypy-extensions", "pathspec"]) {
    ok(pypi && pypi[1].includes(`name: "${dep}"`), `${dep} is still pinned from PyPI (Pyodide ships neither)`);
  }
}

// ---------------------------------------------------------------------------
console.log("\n== what a program writes still exists afterwards ==");
// The mirroring is plain JavaScript over an FS-shaped object, so it can be
// gated here rather than only where a real interpreter boots. The stand-in
// interpreter supplies Emscripten's tracking hooks; spike-python-bridge holds
// REAL Pyodide to firing them, which is what stops this being a test of a
// fiction. See scripts/lib/python-mirror-drive.mjs.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-py-mirror-"));
  fs.writeFileSync(path.join(dir, "data.txt"), "aaaa");
  fs.writeFileSync(path.join(dir, "app.db"), "sqlite-ish");
  fs.writeFileSync(path.join(dir, "app.db-journal"), "hot");
  fs.mkdirSync(path.join(dir, ".venv/lib/python3.14/site-packages"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".venv/marker"), "store");

  const { api } = mirrorRuntime(dir);
  const rc = await api.runCode(
    fsDirective({
      // Same LENGTH as what is there. This is the case the old size heuristic
      // dropped, and it is not exotic: it is every fixed-width record, every
      // status flag, every counter that has not changed digits.
      write: { [path.join(dir, "data.txt")]: "bbbb", [path.join(dir, "made.txt")]: "new" },
      // sqlite3 removes its journal on commit. Copying the journal out and
      // never removing it leaves a hot journal beside a committed database,
      // and the next process to open it rolls back committed work.
      delete: [path.join(dir, "app.db-journal")],
    }),
    [],
  );
  ok(rc === 0, "the script path runs and mirrors back");
  ok(hostRead(path.join(dir, "data.txt")) === "bbbb", "a same-size rewrite reaches the host (a size diff alone loses this)");
  ok(hostRead(path.join(dir, "made.txt")) === "new", "…so does a newly created file");
  ok(hostRead(path.join(dir, "app.db-journal")) === null, "…and a deleted sqlite journal is deleted on the host, not left behind");

  // The store and the mirror must not both own .venv. persistDelta() is the
  // only thing allowed to write there — it puts an install's delta at the
  // interpreter's site-packages path. If the mirror wrote there too, a project
  // with packages would copy every wheel out a second time on every run, and a
  // half-written store would look to the next boot like a real one. So the
  // interpreter writing into .venv has to be dropped on the way out, and the
  // tracker makes that a live question: it reports the path whether or not the
  // inbound walk ever descended into the directory.
  const injected = path.join(dir, ".venv/lib/python3.14/site-packages/injected.py");
  await api.runCode(fsDirective({ write: { [injected]: "print('from the interpreter')" } }), []);
  ok(hostRead(injected) === null, "a write INTO .venv is dropped rather than mirrored — the package store owns that directory");
  ok(hostRead(path.join(dir, ".venv/marker")) === "store", "…and the store's own files are untouched");
}

// ---------------------------------------------------------------------------
console.log("\n== a served app's writes land while it is still serving ==");
// The defect: serve() mirrored IN and never back, so a Flask app that took an
// upload or wrote a SQLite row lost it when the server stopped, and the editor
// could not see it before then. Waiting for shutdown is not a fix — people
// close tabs. Writes land at the end of each request.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-py-serve-"));
  const port = scratchPort(1);
  const { api } = mirrorRuntime(dir);
  const closed = api.serve({ app: "main:app", mode: "wsgi", port, cwd: dir });
  closed.catch(() => {});
  for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, ".fake-pyodide")); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 200));

  const first = await get(port, "/write/upload.txt/from-a-request");
  ok(first.status === 200, "the served app answers");
  ok(
    hostRead(path.join(dir, "upload.txt")) === "from-a-request",
    "a file written by a request is on the host WHILE THE SERVER IS STILL RUNNING (this is the bug)",
  );
  await get(port, "/write/upload.txt/second-write");
  ok(hostRead(path.join(dir, "upload.txt")) === "second-write", "…and a later request's overwrite lands too, at the same length");

  const boom = await get(port, "/boom/half.txt");
  ok(boom.status === 500, "an app that raises still returns 500");
  ok(
    hostRead(path.join(dir, "half.txt")) === "half",
    "…and what it wrote before raising is persisted, rather than lost with the exception",
  );

  await get(port, "/delete/upload.txt");
  ok(hostRead(path.join(dir, "upload.txt")) === null, "a file the app deletes is deleted on the host");
}


// ---------------------------------------------------------------------------
console.log("\n== the Python language service: what gets registered ==");
// Python files used to get file icons and Monaco's default word-based
// suggestions — strings scraped out of the open buffer, which will offer a word
// from a comment and has never heard of requests.get. Five providers replace
// that. This is interpreter-free because Monaco is a parameter of
// registerPythonLanguage rather than an import of it.
// ---------------------------------------------------------------------------
{
  const monaco = makeFakeMonaco();
  const host = makeHost();
  const off = registerPythonLanguage(monaco, host);

  for (const kind of ["completion", "hover", "signature", "definition", "formatting"]) {
    const regs = monaco.registered[kind];
    ok(regs.length === 1, `a ${kind} provider is registered`);
    ok(regs[0] && regs[0].language === "python", `…for the "python" language id, which is what languageFor() gives a .py file`);
  }

  // "." is the one trigger character that matters. Without it Monaco only asks
  // after a word character, so `json.` — the single most common thing anyone
  // types before wanting a completion — produces nothing until another keypress.
  const comp = monaco.registered.completion[0].provider;
  ok((comp.triggerCharacters || []).includes("."), "completion triggers on \".\", not only on word characters");
  const sig = monaco.registered.signature[0].provider;
  ok((sig.signatureHelpTriggerCharacters || []).includes("("), "signature help triggers on \"(\"");
  ok((sig.signatureHelpTriggerCharacters || []).includes(","), "…and on \",\", so it follows you across arguments");
  ok(typeof comp.resolveCompletionItem === "function", "completion resolves lazily, so a docstring costs one lookup and not one per item");

  // Registering twice would double every request. The disposer has to work.
  off();
  ok(monaco.disposed.length === 5, "the disposer removes all five providers");

  // Nothing here may be registered for any other language: this service speaks
  // Python, and claiming .ts would fight the TypeScript service.
  const langs = new Set(Object.values(monaco.registered).flat().map((r) => r.language));
  ok(langs.size === 1 && langs.has("python"), "no provider is registered for any language other than python");
}

// ---------------------------------------------------------------------------
console.log("\n== the request contract, and the off-by-one in the middle of it ==");
// ---------------------------------------------------------------------------
{
  // Monaco counts columns from 1. jedi counts them from 0. Get this wrong and
  // every completion is for the character before the cursor — which mostly
  // still returns something, which is what makes it worth a test.
  ok(toJediPosition({ lineNumber: 3, column: 1 }).column === 0, "Monaco column 1 is jedi column 0");
  ok(toJediPosition({ lineNumber: 3, column: 7 }).column === 6, "…and column 7 is column 6");
  ok(toJediPosition({ lineNumber: 3, column: 7 }).line === 3, "lines agree at 1 and are passed through");
  ok(toJediPosition({ lineNumber: 1, column: 0 }).column === 0, "a column below 1 clamps rather than going negative");

  // The kind numbers are held against the SHIPPED enum, not a copy: a Monaco
  // upgrade that renumbers CompletionItemKind should fail here rather than draw
  // a Class icon for every function.
  const dts = path.join(ROOT, "packages/studio/node_modules/monaco-editor/esm/vs/editor/editor.api.d.ts");
  if (fs.existsSync(dts)) {
    const src = fs.readFileSync(dts, "utf8");
    const block = /export enum CompletionItemKind \{([\s\S]*?)\}/.exec(src);
    ok(!!block, "monaco-editor still declares CompletionItemKind where this check reads it");
    const real = {};
    for (const m of block[1].matchAll(/(\w+)\s*=\s*(\d+)/g)) real[m[1].toUpperCase()] = Number(m[2]);
    let agreed = 0;
    for (const [name, value] of Object.entries(MONACO_KIND)) {
      ok(real[name] === value, `MONACO_KIND.${name} is ${value}, which is what monaco-editor says`);
      agreed++;
    }
    ok(agreed >= 10, `${agreed} kind numbers checked against the real enum`);
  }

  // jedi's type vocabulary is fixed and short (api/classes.py).
  ok(completionKind("function") === MONACO_KIND.FUNCTION, "a jedi function is a Monaco Function");
  ok(completionKind("class") === MONACO_KIND.CLASS, "a class is a Class");
  ok(completionKind("module") === MONACO_KIND.MODULE, "a module is a Module");
  ok(completionKind("keyword") === MONACO_KIND.KEYWORD, "a keyword is a Keyword");
  ok(completionKind("instance") === MONACO_KIND.VARIABLE, "an instance is a Variable");
  // An unknown type must not be dressed up as something specific: a confident
  // wrong icon is worse than a neutral one.
  ok(completionKind("something-new") === MONACO_KIND.VALUE, "a type this map has not been taught falls back to Value");
  ok(completionKind(undefined) === MONACO_KIND.VALUE, "…and so does a missing type");
}

// ---------------------------------------------------------------------------
console.log("\n== where a definition lives, and whether it can be opened ==");
// Three kinds of answer come back from jedi and only one is a file the editor
// can open. Pretending otherwise means ctrl-click opening a blank tab.
// ---------------------------------------------------------------------------
{
  const inProject = hostPathFor("/project/helper.py", "/project");
  ok(inProject.openable && inProject.path === "/project/helper.py", "a project file is already a host path");

  // An installed package resolves inside the interpreter, but the bytes exist on
  // the host under the store — so this one is openable after a rewrite.
  const inPkg = hostPathFor("/lib/python3.14/site-packages/tabulate/__init__.py", "/project");
  ok(inPkg.openable, "a definition inside an installed package is openable");
  ok(
    inPkg.path === "/project/.venv/lib/python3.14/site-packages/tabulate/__init__.py",
    `…rewritten onto the package store: ${inPkg.path}`,
  );

  // The stdlib is a zip inside the WASM build. There is no host file at all.
  const inStd = hostPathFor("/lib/python314.zip/json/__init__.py", "/project");
  ok(!inStd.openable, "a stdlib definition is NOT openable");
  ok(/standard library/.test(inStd.reason), `…and says why: ${JSON.stringify(inStd.reason)}`);
  ok(!hostPathFor("", "/project").openable, "no path at all is not openable either");
  ok(!hostPathFor("/somewhere/else.py", "/project").openable, "and neither is a file outside the project");

  // The two halves of the mapping live in different packages and have to agree.
  const kw = fs.readFileSync(path.join(ROOT, "packages/core/src/workers/kernel-worker.ts"), "utf8");
  const rel = /const PY_STORE_REL = "([^"]+)"/.exec(kw);
  const interp = /const PY_INTERP_SITE = "([^"]+)"/.exec(kw);
  ok(!!rel && !!interp, "the kernel worker declares both halves of the store path mapping");
  ok(
    inPkg.path === "/project/" + rel[1] + "/tabulate/__init__.py",
    "the path the editor opens is the one the kernel worker copied FROM",
  );
  ok(interp[1] === "/lib/python3.14/site-packages", "…and the path it copied TO is the interpreter's own site-packages");
}

// ---------------------------------------------------------------------------
console.log("\n== keystrokes outrun the interpreter, so stale work is dropped ==");
// Pyodide has no threads: language requests serialise whether or not there is a
// queue. What the queue adds is DROPPING. A round trip is ~15 ms warm and nobody
// types slower than that, so without this the eighth keystroke waits behind seven
// answers nobody will read — which is what "feels broken" actually is.
// ---------------------------------------------------------------------------
{
  let inFlight = 0;
  let peak = 0;
  const seen = [];
  let release;
  const gate = () => new Promise((r) => { release = r; });
  let pending = gate();
  const q = createRequestQueue(async (job) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    seen.push(job.n);
    await pending;
    inFlight--;
    return { answered: job.n };
  });

  // Every await below is bounded. A queue that stops resolving superseded work
  // would otherwise HANG this spike rather than fail it, and a CI job that never
  // finishes is worse than one that goes red — it costs a timeout to find out.
  const settled = (p, ms = 2000) =>
    Promise.race([p, new Promise((r) => setTimeout(() => r("TIMED-OUT"), ms))]);

  // Eight keystrokes while the interpreter is busy with the first.
  const results = [];
  for (let n = 1; n <= 8; n++) results.push(q.submit("complete", { n }));
  await new Promise((r) => setTimeout(r, 5));
  ok(peak === 1, "only one request is ever handed to the interpreter at a time");
  const first = release; first();
  pending = gate();
  await new Promise((r) => setTimeout(r, 5));
  release();
  const answers = await settled(Promise.all(results));

  ok(answers !== "TIMED-OUT", "every one of the 8 keystrokes settles — a superseded request must not be left pending forever");
  ok(seen.length === 2, `8 keystrokes reached the interpreter twice, not 8 times (${seen.join(",")})`);
  ok(seen[0] === 1 && seen[1] === 8, "…the one that was already running, and the LATEST — not the queue in order");
  ok(answers !== "TIMED-OUT" && answers[7] && answers[7].answered === 8, "the last keystroke gets a real answer");
  ok(answers !== "TIMED-OUT" && answers.slice(1, 7).every((a) => a === null), "the six superseded ones resolve null rather than hanging");

  // Different kinds must not evict each other: a hover that supersedes a pending
  // format would silently cancel a key the user pressed on purpose.
  const q2 = createRequestQueue(async (job) => ({ op: job.op }));
  const both = await settled(Promise.all([q2.submit("hover", { op: "hover" }), q2.submit("format", { op: "format" })]));
  ok(both !== "TIMED-OUT" && both[0] && both[1], "a hover and a format are both answered — different kinds do not supersede each other");

  // A token that fires WHILE the interpreter is busy still suppresses the answer:
  // the position it answered for is not where the cursor is any more, so the
  // answer is wrong rather than merely late.
  let go;
  const slow = new Promise((r) => { go = r; });
  const q3 = createRequestQueue(async () => { await slow; return { late: true }; });
  const tok = makeToken();
  const p3 = q3.submit("complete", {}, () => tok.isCancellationRequested);
  await new Promise((r) => setTimeout(r, 5));
  tok.cancel();
  go();
  ok((await settled(p3)) === null, "an answer whose token fired mid-flight is discarded, not delivered late");

  // And a request cancelled before it starts must never reach the interpreter.
  let reached = 0;
  const q4 = createRequestQueue(async () => { reached++; return {}; });
  const dead = makeToken();
  dead.cancel();
  ok((await settled(q4.submit("complete", {}, () => dead.isCancellationRequested))) === null, "an already-cancelled request resolves null");
  ok(reached === 0, "…and never reaches the interpreter at all");

  // A throwing transport is an error, not a hang.
  const q5 = createRequestQueue(async () => { throw new Error("worker gone"); });
  const boom = await settled(q5.submit("complete", {}));
  ok(boom && boom.error === "raised" && /worker gone/.test(boom.message), "a transport failure resolves as an error rather than hanging");
}

// ---------------------------------------------------------------------------
console.log("\n== the providers, driven end to end against a stand-in interpreter ==");
// ---------------------------------------------------------------------------
{
  const monaco = makeFakeMonaco();
  const host = makeHost({
    complete: { items: [{ i: 0, label: "dumps", type: "function", detail: "def dumps" }] },
    hover: { items: [{ signature: "def dumps", doc: "Serialize obj to JSON.", type: "function" }] },
    signature: { items: [{ label: "dumps(obj)", params: [{ label: "obj", detail: "param obj" }], active: 0 }] },
    goto: { items: [{ path: "/project/helper.py", line: 4, column: 5, name: "helper_fn" }] },
    format: { text: "x = 1\n", changed: true },
  });
  registerPythonLanguage(monaco, host);
  const model = makeModel("/project/main.py", "import json\njson.du\n");
  const at = { lineNumber: 2, column: 8 };
  const P = monaco.registered;

  const list = await P.completion[0].provider.provideCompletionItems(model, at, {}, makeToken());
  ok(list.suggestions.length === 1 && list.suggestions[0].label === "dumps", "a completion comes back with jedi's label");
  ok(list.suggestions[0].kind === MONACO_KIND.FUNCTION, "…carrying the mapped kind");
  ok(list.suggestions[0].detail === "def dumps", "…and jedi's one-line description as the detail");
  // The range has to cover the word already typed. Without it Monaco guesses and
  // guesses wrong after a dot — `json.du` + `dumps` becomes `json.dudumps`.
  const r = list.suggestions[0].range;
  ok(r.startColumn === 6 && r.endColumn === 8, `the insert range replaces the typed "du" (cols ${r.startColumn}-${r.endColumn})`);
  ok(list.suggestions[0].insertText === "dumps", "…with the full name, so the result is json.dumps");

  // The buffer, not the file on disk. This is what makes completions describe
  // what is on screen rather than what was last saved.
  const sent = host.calls[host.calls.length - 1].req;
  ok(sent.code === "import json\njson.du\n", "the request carries the model's CURRENT text, unsaved edits included");
  ok(sent.path === "/project/main.py" && sent.root === "/project", "…plus the path and the project root, so jedi can resolve siblings");
  ok(sent.line === 2 && sent.column === 7, "…at the jedi-converted position");

  const hover = await P.hover[0].provider.provideHover(model, at, makeToken());
  ok(hover && hover.contents.length === 2, "hover returns the signature and the docstring");
  ok(/```python/.test(hover.contents[0].value), "…with the signature fenced as Python, so it renders as code");

  const help = await P.signature[0].provider.provideSignatureHelp(model, at, makeToken());
  ok(help.value.signatures[0].label === "dumps(obj)", "signature help returns jedi's rendering");
  ok(help.value.activeParameter === 0, "…and which parameter the cursor is in");

  const defs = await P.definition[0].provider.provideDefinition(model, at, makeToken());
  ok(defs.length === 1 && defs[0].uri.path === "/project/helper.py", "go-to-definition returns the project file");
  ok(defs[0].range.startLineNumber === 4, "…at jedi's line");

  const edits = await P.formatting[0].provider.provideDocumentFormattingEdits(model, {}, makeToken());
  ok(edits.length === 1 && edits[0].text === "x = 1\n", "formatting returns black's output as a whole-document edit");
}

// ---------------------------------------------------------------------------
console.log("\n== silence is the bug: every failure says something ==");
// A provider that returns an empty list when the service is missing is
// indistinguishable from "no suggestions" — the lying stub the house rule is
// about. Formatting is worse, because it is a key the user pressed on purpose.
// ---------------------------------------------------------------------------
{
  ok(/could not parse/i.test(formatFailureMessage({ error: "parse", message: "Cannot parse: 3:10" })), "a file black cannot parse is reported as such");
  ok(/3:10/.test(formatFailureMessage({ error: "parse", message: "Cannot parse: 3:10" })), "…including black's own line and column");
  ok(/discarded/.test(formatFailureMessage({ error: "unsafe", message: "" })), "output that does not match the source is reported as DISCARDED, not applied");
  ok(/black failed/.test(formatFailureMessage({ error: "raised", message: "boom" })), "an unexpected failure is reported");
  ok(!!formatFailureMessage(null), "even a missing response produces a message rather than silence");
  for (const kind of ["parse", "unsafe", "raised", null]) {
    const msg = formatFailureMessage(kind ? { error: kind, message: "x" } : null);
    ok(typeof msg === "string" && msg.length > 12, `the ${kind || "empty"} failure message is a sentence, not a code`);
  }

  // The service being down must reach the status bar, and formatting must say so.
  const monaco = makeFakeMonaco();
  const host = makeHost();
  host.responder = () => Promise.resolve({ ok: false, result: null, error: "Pyodide failed to load" });
  registerPythonLanguage(monaco, host);
  const model = makeModel("/project/main.py", "x=1\n");

  const list = await monaco.registered.completion[0].provider.provideCompletionItems(model, { lineNumber: 1, column: 2 }, {}, makeToken());
  ok(list.suggestions.length === 0, "a broken service offers no completions (there are none to offer)");
  ok(
    host.states.some(([s, d]) => s === LSP_STATE.FAILED && /Pyodide failed to load/.test(d)),
    "…but the failure reaches the status bar with the reason, so it is not silence",
  );

  const edits = await monaco.registered.formatting[0].provider.provideDocumentFormattingEdits(model, {}, makeToken());
  ok(edits.length === 0, "a broken service makes no edit");
  ok(host.notices.some((n) => /unavailable/.test(n)), `…and says so: ${JSON.stringify(host.notices[host.notices.length - 1])}`);

  // "Already formatted" and "formatting is broken" must not look the same.
  const m2 = makeFakeMonaco();
  const h2 = makeHost({ format: { text: "x = 1\n", changed: false } });
  registerPythonLanguage(m2, h2);
  const none = await m2.registered.formatting[0].provider.provideDocumentFormattingEdits(makeModel("/project/a.py", "x = 1\n"), {}, makeToken());
  ok(none.length === 0 && h2.notices.some((n) => /already formatted/.test(n)), "an already-formatted file says so, rather than looking like a failure");

  // black refusing to parse must not overwrite the buffer with anything.
  const m3 = makeFakeMonaco();
  const h3 = makeHost({ format: { error: "parse", message: "Cannot parse: 1:6" } });
  registerPythonLanguage(m3, h3);
  const bad = await m3.registered.formatting[0].provider.provideDocumentFormattingEdits(makeModel("/project/b.py", "def f(:\n"), {}, makeToken());
  ok(bad.length === 0, "a file black cannot parse produces NO edit — the buffer is left alone");
  ok(h3.notices.some((n) => /1:6/.test(n)), "…and the user is told where the syntax error is");

  // A definition jedi found but the editor cannot open has to explain itself.
  const m4 = makeFakeMonaco();
  const h4 = makeHost({ goto: { items: [{ path: "/lib/python314.zip/json/__init__.py", line: 185, column: 5, name: "dumps" }] } });
  registerPythonLanguage(m4, h4);
  const std = await m4.registered.definition[0].provider.provideDefinition(makeModel("/project/c.py", "x\n"), { lineNumber: 1, column: 1 }, makeToken());
  ok(std.length === 0, "a stdlib definition opens nothing");
  ok(h4.notices.some((n) => /standard library/.test(n)), "…and explains why, instead of a ctrl-click that does nothing");

  // The status readouts a user actually sees.
  ok(/starting/.test(stateLabel(LSP_STATE.STARTING)), "a boot in progress says it is starting");
  ok(stateLabel(LSP_STATE.READY) === "Python: jedi", "a ready service names what is answering");
  ok(/unavailable/.test(stateLabel(LSP_STATE.FAILED)), "a failed service says unavailable");
  ok(/no wheel/.test(stateLabel(LSP_STATE.FAILED, "no wheel")), "…and carries the detail");
  ok(stateLabel("off") === null, "and nothing is shown before Python has been opened at all");
}

// ---------------------------------------------------------------------------
console.log("\n== the jedi/black driver is valid Python, checked by a real one ==");
// The driver is a string until an interpreter reads it, so a typo in it is a
// runtime error in a worker with no terminal. Compiling it here is free and
// needs no jedi: compile() resolves no imports.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-lsp-src-"));
  const f = path.join(dir, "driver.py");
  fs.writeFileSync(f, LSP_DRIVER_SOURCE);
  const r = spawnSync("python3", ["-c", `compile(open(${JSON.stringify(f)}).read(), "driver", "exec")`], { encoding: "utf8" });
  ok(r.status === 0, `the driver compiles under the CPython on this host${r.status ? ": " + (r.stderr || "").trim().split("\n").pop() : ""}`);

  // Every op the providers ask for has to exist in the dispatch table, or the
  // failure is a string mismatch found by a user.
  const table = /_VV_OPS = \{([\s\S]*?)\n\}/.exec(LSP_DRIVER_SOURCE);
  ok(!!table, "the driver has an op table where this check reads it");
  const ops = [...table[1].matchAll(/"(\w+)":/g)].map((m) => m[1]);
  for (const op of ["complete", "resolve", "hover", "signature", "goto", "format"]) {
    ok(ops.includes(op), `the driver implements "${op}"`);
  }
  // …and the providers ask for exactly those, with ONE exception: "lint" is
  // answered by ruff's wasm in the worker and never reaches Python at all. That
  // is not a hole in the table, so it is named here — and the reason is checked
  // rather than asserted, because a lint that fell through to the interpreter
  // would boot 30 MB of CPython to run a tool that does not need it.
  const workerSrc = fs.readFileSync(path.join(ROOT, "packages/core/src/workers/python-lsp-worker.ts"), "utf8");
  const lintBranch = workerSrc.indexOf('req.op === "lint"');
  const bootCall = workerSrc.indexOf("if (!pyodide) await boot(indexUrl)");
  ok(lintBranch > 0 && bootCall > 0 && lintBranch < bootCall,
    "the worker answers a lint BEFORE it would boot an interpreter, which is the point of ruff being wasm of its own");
  ok(/ruffUrl/.test(fs.readFileSync(path.join(ROOT, "packages/core/src/workers/kernel-worker.ts"), "utf8")),
    "…and the host tells it where the vendored ruff is");

  const asked = new Set([...fs.readFileSync(path.join(ROOT, "packages/runtime/builtins/python-lsp.js"), "utf8")
    .matchAll(/op: "(\w+)"/g)].map((m) => m[1]));
  for (const op of asked) {
    if (op === "lint") continue;
    ok(ops.includes(op), `…and "${op}", which a provider asks for, is one of them`);
  }

  // The line that makes any of this work in Pyodide at all.
  ok(
    /environment=_VV_ENV/.test(LSP_DRIVER_SOURCE) && /InterpreterEnvironment\(\)/.test(LSP_DRIVER_SOURCE),
    "jedi is given an InterpreterEnvironment — its default discovery runs sys.executable in a SUBPROCESS, which Pyodide answers with OSError(138)",
  );
  // black's safety check is not optional: format_str does not run it, and what
  // it catches is black changing what the code means.
  ok(/assert_equivalent/.test(LSP_DRIVER_SOURCE), "black's --safe equivalence check is run before any text is returned");
  ok(!/except\s*:\s*\n\s*pass/.test(LSP_DRIVER_SOURCE), "the driver never swallows an exception into a bare pass");
}

// ---------------------------------------------------------------------------
console.log("\n== the interpreter behind it is not a process, and not eager ==");
// Two properties that are the whole lifecycle decision, and both are the kind of
// thing a later change breaks without noticing.
// ---------------------------------------------------------------------------
{
  const kw = fs.readFileSync(path.join(ROOT, "packages/core/src/workers/kernel-worker.ts"), "utf8");
  const lspWorker = fs.readFileSync(path.join(ROOT, "packages/core/src/workers/python-lsp-worker.ts"), "utf8");

  ok(/new Worker\(new URL\("\.\/python-lsp-worker\.ts"/.test(kw), "the language service is a nested worker of the kernel");
  // A process is anything that goes through createProcess/kernel.launch. This one
  // must not: it would show up in ps and diagnostics(), and a user tidying up
  // their jobs could kill their own editor's completions.
  const fn = /function pythonLspWorker\(\)[\s\S]*?\n\}/.exec(kw);
  ok(!!fn, "pythonLspWorker() is where the worker is created");
  ok(!/createProcess|kernel\.launch|spawnProcess/.test(fn[0]), "…and it never goes through createProcess, so it is absent from ps and diagnostics()");

  // Lazy: created on first use, not at boot. Pyodide is ~30 MB and someone
  // editing a .ts file must not pay for it.
  const bootFn = /async function boot\(\)[\s\S]*?\n\}/.exec(kw);
  if (bootFn) ok(!/pythonLspWorker\(/.test(bootFn[0]), "the kernel's boot() does not create it — it is not paid for until a .py file is opened");
  const created = [...kw.matchAll(/pythonLspWorker\(\)/g)].length;
  ok(created >= 2, `pythonLspWorker() is called from its own definition and from the request path (${created} sites)`);
  ok(/if \(pyLspWorker\) return pyLspWorker;/.test(kw), "…and returns the existing worker rather than booting a second interpreter");

  // The studio side must be lazy too, or the bundle carries the worker anyway.
  const ctl = fs.readFileSync(path.join(ROOT, "packages/studio/src/vv/controller.ts"), "utf8");
  ok(/import\("\.\/python-language"\)/.test(ctl), "the studio imports the provider module dynamically, so a TypeScript session never loads it");
  ok(/ensurePythonLanguage\(/.test(ctl), "…behind a guard called when a Python model appears");

  // One boot, not one per caller: two 30 MB boots racing is how a slow feature
  // becomes an out-of-memory one.
  ok(/if \(booting\) return booting;/.test(lspWorker), "concurrent first requests await ONE boot rather than starting two interpreters");
  ok(/booting = null;/.test(lspWorker), "…and a failed boot is retryable, since the network may come back");
  // black is four wheels nobody needs until they press the key.
  ok(/async function ensureBlack\(\)/.test(lspWorker), "black loads on the first format, not at boot");
  ok(/loadPackage\(JEDI_PACKAGES/.test(lspWorker), "…while jedi loads at boot, because it is what makes the editor feel alive");
}

// ---------------------------------------------------------------------------
console.log("\n== jedi and black are shipped, not fetched when someone types ==");
// An editor feature that only works when the network does, in a product whose
// pitch is running in the browser, is a different feature.
// ---------------------------------------------------------------------------
{
  const vend = fs.readFileSync(path.join(ROOT, "scripts/vendor-pyodide.mjs"), "utf8");
  ok(/DEFAULT_PACKAGES = \[[^\]]*"jedi"/.test(vend), "jedi is vendored (it IS in Pyodide's lock, so it costs one same-origin wheel)");

  const pypi = /const PYPI_PACKAGES = \[([\s\S]*?)\n\];/.exec(vend);
  ok(!!pypi, "black's wheels are declared for vendoring, since Pyodide does not distribute it");
  const pinned = [...pypi[1].matchAll(/name: "([^"]+)", version: "([^"]+)"/g)];
  ok(pinned.length >= 4, `${pinned.length} PyPI wheels are vendored for the formatter`);
  for (const [, name, version] of pinned) {
    ok(/^\d+\.\d+/.test(version), `${name} is pinned to ${version} — an unpinned formatter reformats a codebase differently the day upstream changes a default`);
  }

  // The bug this catches, which a network-enabled test would not have: black's
  // dependencies that live in the Pyodide lock (click, packaging, platformdirs)
  // are not in any other vendored package's closure, so without an explicit pull
  // their wheels are never downloaded and loadPackage("black") silently falls
  // back to the CDN.
  ok(
    /for \(const spec of PYPI_PACKAGES\) \{\s*\n\s*for \(const dep of spec\.depends\)/.test(vend),
    "a PyPI package's lock-resident dependencies are pulled into the download closure",
  );
  const blackSpec = /name: "black"[^}]*depends: \[([^\]]*)\]/.exec(vend);
  ok(!!blackSpec, "black declares its dependencies");
  for (const dep of ["click", "packaging", "platformdirs", "pathspec", "mypy-extensions", "pytokens"]) {
    ok(blackSpec[1].includes('"' + dep + '"'), `…including ${dep}`);
  }
  // Changing a pin must invalidate the vendor marker, or a re-run is a no-op.
  ok(/PYPI_PACKAGES\.map\(\(p\) => p\.name \+ "@" \+ p\.version\)/.test(vend), "the vendor marker covers the pins, so changing one actually re-vendors");

  // If the tree is present in this checkout, the wheels really are on disk.
  const out = path.join(ROOT, "packages/studio/public/vendor/pyodide");
  if (fs.existsSync(out)) {
    const names = fs.readdirSync(out);
    for (const want of ["jedi", "parso", "black", "pathspec", "pytokens", "mypy_extensions", "click", "platformdirs"]) {
      ok(names.some((n) => n.startsWith(want) && n.endsWith(".whl")), `${want}'s wheel is on disk in the vendored tree`);
    }
    const lock = JSON.parse(fs.readFileSync(path.join(out, "pyodide-lock.json"), "utf8"));
    for (const want of ["black", "pathspec", "pytokens", "mypy-extensions"]) {
      const e = lock.packages[want];
      ok(!!e, `${want} was injected into the lock, so loadPackage resolves it`);
      ok(e && !e.file_name.includes("://"), `…with a RELATIVE file_name, which is what makes it same-origin rather than the CDN`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log("\n== type errors reach the editor as markers, on a pause ==");
// The diagnostics path is pushed rather than pulled: no Monaco provider asks for
// it, so nothing else in this file would notice it breaking. What is gated here
// is everything that does not need mypy — the debounce, the supersession, the
// marker geometry and the two ways it can fail. The bridge tier runs the real
// checker and compares it to the host's.
// ---------------------------------------------------------------------------
{
  const DIAG = {
    items: [
      { line: 5, column: 12, endLine: 5, endColumn: 21, severity: "error", message: 'Incompatible return value type (got "int", expected "str")', code: "return-value" },
      { line: 8, column: 5, endLine: 8, endColumn: 11, severity: "warning", message: "unused thing", code: "unused-awaitable" },
    ],
  };
  const settle = (ms = CHECK_DEBOUNCE_MS + 60) => new Promise((r) => setTimeout(r, ms));

  const monaco = makeFakeMonaco();
  const host = makeHost({ check: DIAG });
  const off = registerPythonLanguage(monaco, host);
  const model = makeModel("/project/app.py", "x = 1\n");
  monaco.editor.openModel(model);

  // Nothing yet: the check is on a timer, and a file opened and immediately
  // closed must not have paid for an interpreter.
  ok(monaco.editor.markersFor(model, MARKER_OWNER) === null, "opening a file does not check it immediately");
  await settle();
  const marks = monaco.editor.markersFor(model, MARKER_OWNER);
  ok(Array.isArray(marks) && marks.length === 2, `after the pause, ${marks ? marks.length : 0} markers are published`);

  // The geometry is the whole point of a squiggle: mypy's end column is
  // inclusive and Monaco's is exclusive, so a marker that copied it straight
  // through would stop one character short of the code it is about.
  const first = marks && marks[0];
  ok(first && first.startLineNumber === 5 && first.startColumn === 12, "the marker starts where mypy said");
  ok(first && first.endColumn === 21, "…and ends one past mypy's inclusive end, which is what Monaco means by endColumn");
  ok(first && first.severity === monaco.MarkerSeverity.Error, "an error is an Error");
  ok(marks && marks[1].severity === monaco.MarkerSeverity.Warning, "…and a warning is a Warning, not everything-is-an-error");
  ok(first && first.code === "return-value", "the error code rides along, so a type: ignore[...] can be written from it");
  ok(first && first.source === "mypy", "…and the marker says who produced it");

  // The request the worker will see.
  const checkCalls = host.calls.filter((c) => c.req.op === "check");
  ok(checkCalls.length === 1, `one check was asked for, not one per event (${checkCalls.length})`);
  ok(checkCalls[0].req.code === "x = 1\n", "…carrying the BUFFER, since mypy reads files and the file is behind");
  ok(checkCalls[0].req.path === "/project/app.py", "…and the path it is about");

  // Typing must coalesce. Three edits inside the window are one check, or every
  // keystroke would queue 0.35s of interpreter time behind the cursor.
  const before = host.calls.filter((c) => c.req.op === "check").length;
  model.setValue("x = 2\n");
  model.setValue("x = 3\n");
  model.setValue("x = 4\n");
  await settle();
  const added = host.calls.filter((c) => c.req.op === "check").length - before;
  ok(added === 1, `three edits inside the window cost one check, not three (${added})`);
  ok(host.calls.filter((c) => c.req.op === "check").pop().req.code === "x = 4\n", "…and it checks the latest text, not the first");

  off();
  // A disposed registration must not leave a timer that fires into a dead editor.
  const quietBefore = host.calls.length;
  model.setValue("x = 5\n");
  await settle();
  ok(host.calls.length === quietBefore, "after dispose, editing checks nothing");
}

{
  const settle = (ms = CHECK_DEBOUNCE_MS + 60) => new Promise((r) => setTimeout(r, ms));

  // A file that is not Python is not checked, whatever else is open.
  const monaco = makeFakeMonaco();
  const host = makeHost({ check: { items: [] } });
  const off = registerPythonLanguage(monaco, host);
  const ts = makeModel("/project/app.ts", "const x = 1", "typescript");
  monaco.editor.openModel(ts);
  await settle();
  ok(host.calls.filter((c) => c.req.op === "check").length === 0, "a TypeScript model is never sent to mypy");
  off();
}

{
  const settle = (ms = CHECK_DEBOUNCE_MS + 60) => new Promise((r) => setTimeout(r, ms));

  // Failure wording, both kinds. A config error is not about the code, so it is
  // said once and draws nothing; a service that is down leaves the last markers
  // alone rather than claiming the file became clean.
  const monaco = makeFakeMonaco();
  const host = makeHost({ check: { error: "config", message: "mypy.ini: [mypy] section not found" } });
  const off = registerPythonLanguage(monaco, host);
  const model = makeModel("/project/app.py", "x = 1\n");
  monaco.editor.openModel(model);
  await settle();
  ok(host.notices.some((n) => /mypy: .*section not found/.test(n)), `a mypy configuration error is reported as itself: ${host.notices[0] || "(nothing)"}`);
  ok((monaco.editor.markersFor(model, MARKER_OWNER) || []).length === 0, "…and draws no squiggles, because it is not about the code");
  off();

  const monaco2 = makeFakeMonaco();
  const host2 = makeHost({ check: { items: [{ line: 1, column: 1, endLine: 1, endColumn: 2, severity: "error", message: "boom", code: "x" }] } });
  const off2 = registerPythonLanguage(monaco2, host2);
  const model2 = makeModel("/project/app.py", "x = 1\n");
  monaco2.editor.openModel(model2);
  await settle();
  ok((monaco2.editor.markersFor(model2, MARKER_OWNER) || []).length === 1, "a marker is published while the service is up");
  host2.responder = () => Promise.resolve({ ok: false, result: null, error: "worker gone" });
  model2.setValue("x = 2\n");
  await settle();
  ok((monaco2.editor.markersFor(model2, MARKER_OWNER) || []).length === 1,
    "…and when the service dies the markers STAY, because clearing them would claim the file is clean");
  off2();
}

// ---------------------------------------------------------------------------
console.log("\n== the check op is real Python, and mypy is loaded only for it ==");
// ---------------------------------------------------------------------------
{
  ok(/"check": _vv_check/.test(LSP_DRIVER_SOURCE), "the driver dispatches a check op");
  // The flags are the feature. Without --show-column-numbers every marker would
  // underline a whole line; without --show-error-end it would underline one
  // character; without --follow-imports=silent it would report errors in files
  // the editor is not showing, which have nowhere to be drawn.
  for (const flag of ["--show-column-numbers", "--show-error-end", "--follow-imports=silent", "--no-error-summary"]) {
    ok(LSP_DRIVER_SOURCE.includes(flag), `…passing ${flag}, without which the markers would be wrong`);
  }
  ok(/--cache-dir=/.test(LSP_DRIVER_SOURCE), "…and an incremental cache, which is the difference between 2s and 0.35s a check");
  ok(/from mypy import api/.test(LSP_DRIVER_SOURCE), "…and goes in through the API, not the command line that calls os._exit()");

  const worker = fs.readFileSync(path.join(ROOT, "packages/core/src/workers/python-lsp-worker.ts"), "utf8");
  ok(/if \(req\.op === "check"\) await ensureMypy\(\)/.test(worker), "the worker loads mypy on the first check");
  ok(!new RegExp("loadPackage\\(MYPY_PACKAGES[\\s\\S]{0,200}?post\\(\"state\", \\{ state: \"ready\"").test(worker),
    "…and not at boot, where it would put the biggest wheel in front of the first completion");
  ok(/mypyError = errText\(e\)/.test(worker), "a failed mypy load is remembered, not refetched on every pause");
}

// ---------------------------------------------------------------------------
console.log("\n== a package you install brings its command with it ==");
// `pip install <thing>` that is followed by "<thing>: command not found" is the
// shape of bug this feature is about: the metadata was always in the store, and
// nothing read it.
// ---------------------------------------------------------------------------
{
  const eps = parseEntryPoints([
    "[console_scripts]",
    "httpie = httpie.__main__:main",
    "http = httpie.cli:program [extra]",
    "deep = pkg.mod:obj.attr",
    "",
    "# a comment",
    "[gui_scripts]",
    "notme = pkg:gui",
    "",
    "[pytest11]",
    "alsonotme = plugin",
  ].join("\n"));
  ok(Object.keys(eps).length === 3, `only the console_scripts section becomes commands (${Object.keys(eps).join(", ")})`);
  ok(eps.httpie === "httpie.__main__:main", "a plain entry point is read");
  ok(eps.http === "httpie.cli:program", "…an extras marker is stripped, since it selects dependencies and is not part of the import");
  ok(eps.deep === "pkg.mod:obj.attr", "…and a dotted attribute survives");
  ok(!("notme" in eps) && !("alsonotme" in eps), "gui_scripts and plugin sections are not commands here");

  const src = consoleScriptSource("httpie", "httpie.__main__:main");
  ok(/cp\.spawn\('python', \['-c'/.test(src), "the shim runs the interpreter");
  ok(/sys\.argv\[0\] = \\"httpie\\"/.test(src), "…with argv[0] set to the command name, which is what argparse prints in its usage line");
  ok(/importlib\.import_module\(\\"httpie\.__main__\\"\)/.test(src), "…imports the module the entry point names");
  ok(/sys\.exit\(_t\(\)\)/.test(src), "…and exits with what the entry point returns, so `tool && next` works");
  ok(/concat\(process\.argv\.slice\(2\)\)/.test(src), "…forwarding argv verbatim");

  const deep = consoleScriptSource("deep", "pkg.mod:obj.attr");
  ok(/\\"obj\.attr\\"\.split/.test(deep), "a dotted attribute is walked rather than imported as a name that does not exist");
}

{
  // The real thing, over a real filesystem: install, then uninstall.
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "vv-scripts-"));
  const ENV2 = { pyTag: "python3.14", pythonVersion: "3.14.0", pyodideVersion: "0.28.0", sitePackages: "/lib/python3.14/site-packages" };
  const paths = storePaths(proj, ENV2.pyTag);
  const dist = (name, version, body) => {
    const d = path.join(paths.sitePackages, `${name}-${version}.dist-info`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "entry_points.txt"), body);
  };
  dist("httpie", "3.2.4", "[console_scripts]\nhttpie = httpie.__main__:main\nhttp = httpie.core:main\n");
  dist("rich", "14.0.0", "[console_scripts]\nrich = rich.__main__:main\n");

  const names = writeConsoleScripts(fs, proj, ENV2);
  ok(names.join(",") === "http,httpie,rich", `every console script in the store becomes a command (${names.join(", ")})`);
  ok(fs.existsSync(path.join(paths.bin, "httpie.js")), "…written into .venv/bin, where a venv puts them");
  ok(paths.bin === path.join(proj, ".venv/bin"), `…which is ${paths.bin.replace(proj, "<project>")}`);

  // Uninstall. The store loses the package; PATH has to lose the command, or it
  // spawns an interpreter to fail at the import.
  fs.rmSync(path.join(paths.sitePackages, "httpie-3.2.4.dist-info"), { recursive: true, force: true });
  const after = writeConsoleScripts(fs, proj, ENV2);
  ok(after.join(",") === "rich", `uninstalling takes the command away too (${after.join(", ") || "none"})`);
  ok(!fs.existsSync(path.join(paths.bin, "httpie.js")), "…the shim is deleted, not left behind to fail at an import");
  ok(fs.existsSync(path.join(paths.bin, "rich.js")), "…and the other package's command is untouched");

  // A package that declares a command we already own must not shadow the seam.
  dist("pytest", "8.0.0", "[console_scripts]\npytest = pytest:console_main\npy.test = pytest:console_main\n");
  const guarded = writeConsoleScripts(fs, proj, ENV2);
  ok(!guarded.includes("pytest"), "installing pytest does NOT overwrite the pytest on PATH, which carries the exit-code seam");
  ok(guarded.includes("py.test"), "…while its other, unclaimed alias is still installed");

  fs.rmSync(proj, { recursive: true, force: true });
}

{
  // Drift guard: every seam that lives on PATH has to be in the reserved set, or
  // a pip install can quietly replace it.
  const delegates = Object.keys(PYTHON_DELEGATES);
  for (const name of delegates) {
    ok(RESERVED_COMMANDS.has(name), `${name} is a /bin seam and is protected from being shadowed by an installed console script`);
  }
  ok(RESERVED_COMMANDS.has("python") && RESERVED_COMMANDS.has("python3"), "…as is the interpreter itself");

  // And the PATH that makes any of it reachable.
  const kw = fs.readFileSync(path.join(ROOT, "packages/core/src/workers/kernel-worker.ts"), "utf8");
  const m = /PATH: ([^\n]+),/.exec(kw);
  ok(!!m && /\.venv\/bin/.test(m[1]), `.venv/bin is on the default PATH: ${m ? m[1].trim() : "(not found)"}`);
  ok(!!m && m[1].indexOf(".venv/bin") < m[1].indexOf('"/bin"') + m[1].length && /\.venv\/bin[^:]*:\/bin/.test(m[1].replace(/" \+ dir \+ "/g, "").replace(/"/g, "")),
    "…before /bin, so a project's own tools win — which is why the seams above are reserved rather than merely first");
}

// ---------------------------------------------------------------------------
console.log("\n== pip install -e . reaches the editable path, not the package list ==");
// The first line of most Python projects' READMEs. Before this, `-e` fell into
// the ignore-unknown-flags arm and `.` was taken for a package name, so the
// command failed with "could not install .".
// ---------------------------------------------------------------------------
{
  const drive = drivePython;

  let r = drive(["-m", "pip", "install", "-e", "."]);
  ok(r.calls.some(([f, a]) => f === "pipInstallEditable" && a === "."),
    `pip install -e . asks for an editable install of "." (${JSON.stringify(r.calls)})`);
  ok(!r.calls.some(([f]) => f === "pipInstall"), "…and does not also try to install a package called \".\"");

  r = drive(["-m", "pip", "install", "--editable", "./libs/core"]);
  ok(r.calls.some(([f, a]) => f === "pipInstallEditable" && a === "./libs/core"), "--editable takes a path too");

  // Mixed, which real pip allows.
  r = drive(["-m", "pip", "install", "-e", ".", "requests"]);
  ok(r.calls.some(([f, a]) => f === "pipInstallEditable" && a === "."), "a mixed command does the editable part");
  // The launcher awaits the editable install before starting the ordinary one,
  // and this driver is synchronous — so the second call lands a tick later.
  await new Promise((res) => setTimeout(res, 10));
  ok(r.calls.some(([f, a]) => f === "pipInstall" && a.join() === "requests"), "…and still installs the ordinary packages, rather than dropping them");

  // The refusals, read off the implementation: each names what is missing and
  // what to do, because "could not install ." taught nobody anything.
  const src = fs.readFileSync(path.join(ROOT, "packages/runtime/builtins/python.js"), "utf8");
  const fn = src.slice(src.indexOf("async function pipInstallEditable"), src.indexOf("async function pipInstall(indexUrl, names)"));
  ok(/no pyproject\.toml in/.test(fn), "a project without a pyproject.toml is refused by name");
  ok(/There is a setup\.py, but running it needs a build backend/.test(fn),
    "…and a setup.py-only project is told why it specifically cannot work, since it looks installable");
  ok(/tool\.poetry/.test(fn) && /add a \[project\] table/.test(fn), "…as is a Poetry project with no [project] table");
  ok(/no static version/.test(fn) && /it is declared dynamic/.test(fn), "…and a dynamic version, which would have to be computed by a backend");
  ok(/tomllib\.loads/.test(fn) && /fs\.readFileSync\(pyprojectPath\)/.test(fn),
    "the TOML is read through the host filesystem and parsed by the stdlib, so it does not depend on the project being mirrored yet");
  ok(/Dependencies are NOT installed by -e here/.test(fn),
    "…and dependencies are declared un-installed rather than half-resolved in silence");
  ok(/\[console_scripts\]/.test(fn), "[project.scripts] is written as console_scripts, which is what the shim generator reads");
}

// ---------------------------------------------------------------------------
console.log("\n== the wheels a template needs are the wheels that are vendored ==");
// ---------------------------------------------------------------------------
{
  const vend = fs.readFileSync(path.join(ROOT, "scripts/vendor-pyodide.mjs"), "utf8");
  const defaults = /DEFAULT_PACKAGES = \[([\s\S]*?)\n\];/.exec(vend);
  const names = defaults ? [...defaults[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  for (const want of ["sqlalchemy", "rich", "httpx"]) {
    ok(names.includes(want), `${want} is vendored, so the template that uses it runs with the network off`);
  }

  // rich's lock entry declares no dependencies at all and it imports both of
  // these lazily, so the failure lands on the line that highlights something
  // rather than on the import at the top.
  const fixups = /const DEPENDS_FIXUPS = \{([\s\S]*?)\n\};/.exec(vend);
  const richFix = fixups && /rich:\s*\[([^\]]*)\]/.exec(fixups[1]);
  ok(!!richFix, "rich has a depends fixup, because its lock entry declares none");
  for (const dep of ["pygments", "markdown-it-py"]) {
    ok(richFix && richFix[1].includes(`"${dep}"`), `…naming ${dep}, which rich imports lazily and the lock does not mention`);
  }
  // markdown-it-py is not in Pyodide's index at all, so a fixup alone would
  // point at a wheel that does not exist.
  ok(/name: "markdown-it-py"/.test(vend), "markdown-it-py is vendored from PyPI, since Pyodide does not distribute it");
  ok(/name: "mdurl"/.test(vend), "…along with mdurl, which it needs");

  // And the bridge tier, which runs against a STOCK lock, has to load the same
  // names by hand — so the two lists cannot drift apart unnoticed.
  const bridge = fs.readFileSync(path.join(ROOT, "scripts/spike-python-bridge.mjs"), "utf8");
  const richCase = /"python-rich": \{([\s\S]*?)\n  \},/.exec(bridge);
  ok(!!richCase && /packages: \["rich", "pygments", "markdown-it-py"\]/.test(richCase[1]),
    "the python-rich case loads exactly the packages the fixup adds, so the tier proves the fixup is the right one");
}

// ---------------------------------------------------------------------------
// ruff: the linter that is not a Python package
//
// Everything here is about the program AROUND the wasm, which is where a linter
// gets dangerous: what it decides to read, what it refuses, and whether a
// refusal can still write to someone's source. The wasm itself is stubbed (see
// driveRuff); the real one runs on the bridge tier.
{
  console.log("\n== ruff: a linter that never boots the interpreter ==");

  const DIRTY = "import os\n\n\ndef f():\n    pass\n";
  const oneDiagnostic = [{
    code: "F401", message: "`os` imported but unused", tags: ["unnecessary"],
    start_location: { row: 1, column: 8 }, end_location: { row: 1, column: 10 },
    fix: { message: "Remove unused import", edits: [{ location: { row: 1, column: 1 }, end_location: { row: 2, column: 1 }, content: null }] },
  }];

  // --version before anything else: it is the one path that must not pay for
  // the wasm, and the only way to see that is that init never ran.
  const version = await driveRuff(["--version"], {});
  ok(/ruff 9\.9\.9/.test(version.out), "ruff --version reports the vendored version");
  ok(version.seen.init === 0, "…without loading 11 MB of wasm to answer it");
  ok(version.code === 0, "…and exits 0");

  // Which files a bare `ruff check` decides are the user's own.
  const walk = await driveRuff(["check"], {
    diagnostics: [],
    files: {
      "main.py": "x = 1\n",
      "pkg/mod.py": "y = 2\n",
      "typed.pyi": "def f() -> int: ...\n",
      "notes.txt": "not python\n",
      "node_modules/dep/setup.py": "raise SystemExit\n",
      ".venv/lib/site.py": "raise SystemExit\n",
      "__pycache__/main.cpython-313.py": "raise SystemExit\n",
    },
  });
  ok(walk.seen.checked.length === 3, "ruff check walks the project for .py and .pyi files");
  ok(walk.seen.checked.includes("y = 2\n"), "…including subdirectories");
  ok(!walk.seen.checked.includes("raise SystemExit\n"),
    "…and never node_modules, .venv or __pycache__, whose contents the user cannot edit");
  ok(/All checks passed!/.test(walk.out) && walk.code === 0, "a clean project says so and exits 0");

  // A finding has to reach the shell as a failure, or `ruff check && deploy`
  // deploys code that did not pass.
  const dirty = await driveRuff(["check"], { diagnostics: oneDiagnostic, files: { "main.py": DIRTY } });
  ok(/main\.py:1:8: F401 /.test(dirty.out), "a finding is printed as path:line:column: CODE message");
  ok(dirty.code === 1, "…and exits 1, so `ruff check && deploy` stops");
  ok(dirty.read("main.py") === DIRTY, "…and check never writes to the file it is reading");

  // --fix: refused, and the refusal must not be a refusal that wrote first.
  const fix = await driveRuff(["check", "--fix"], { diagnostics: oneDiagnostic, files: { "main.py": DIRTY } });
  ok(/--fix cannot be honoured here/.test(fix.out), "--fix is refused rather than quietly applied");
  ok(/does not mark which fixes are safe/.test(fix.out), "…naming the reason: the wasm does not say which fixes are safe");
  ok(fix.read("main.py") === DIRTY, "…and the file is untouched, which is the entire point of refusing");
  ok(fix.code === 2, "…exiting 2, the code the real CLI uses for a usage error");
  ok(fix.seen.init === 0, "…and it is refused before the wasm is even loaded");

  // format writes; --check and --diff report. A CI gate that silently rewrote
  // the tree would pass and leave a dirty checkout behind.
  const messy = "x=1\n";
  const tidy = "x = 1\n";
  const fmt = await driveRuff(["format"], { formatted: tidy, files: { "main.py": messy } });
  ok(fmt.read("main.py") === tidy, "ruff format rewrites the file");
  ok(/1 file reformatted/.test(fmt.out) && fmt.code === 0, "…reports what it did and exits 0");

  const fmtCheck = await driveRuff(["format", "--check"], { formatted: tidy, files: { "main.py": messy } });
  ok(fmtCheck.read("main.py") === messy, "ruff format --check does NOT write");
  ok(/would be reformatted/.test(fmtCheck.out), "…says what it would do");
  ok(fmtCheck.code === 1, "…and exits 1 so it can gate CI");

  // Flags that map onto ruff's own settings keys, and flags that do not.
  const selected = await driveRuff(["check", "--select", "E,F", "--line-length", "120"], { files: { "main.py": "x = 1\n" } });
  ok(selected.seen.settings && selected.seen.settings["line-length"] === 120,
    "--line-length is passed to ruff as its own setting, not reimplemented");
  ok(selected.seen.settings && Array.isArray(selected.seen.settings.lint?.select) &&
    selected.seen.settings.lint.select.join(",") === "E,F", "--select likewise");

  const bogus = await driveRuff(["check", "--statistics"], { files: { "main.py": "x = 1\n" } });
  ok(/--statistics is not supported here/.test(bogus.out) && bogus.code === 2,
    "an unsupported flag is refused by name rather than ignored");
  ok(bogus.seen.checked.length === 0, "…before linting anything, so the refusal is not a half-run");

  const sub = await driveRuff(["server"], { files: { "main.py": "x = 1\n" } });
  ok(/"server" is not available here/.test(sub.out) && sub.code === 2, "a real ruff subcommand we do not have is named in its own refusal");

  // Config we do not read is a difference the user has to hear about, once.
  const configured = await driveRuff(["check"], {
    files: { "main.py": "x = 1\n", "pyproject.toml": "[tool.ruff]\nline-length = 100\n" },
  });
  ok(/\[tool\.ruff\] table in pyproject\.toml is not being applied/.test(configured.out),
    "a [tool.ruff] table is reported as not applied, because it is not");
  const unconfigured = await driveRuff(["check"], { files: { "main.py": "x = 1\n" } });
  ok(!/not being applied/.test(unconfigured.out), "…and a project without one hears nothing about config");

  // The seams around it: on PATH, and protected from being replaced by a
  // `pip install ruff` that installs a Rust binary which cannot run here.
  ok(typeof COREUTILS.ruff === "string" && COREUTILS.ruff.includes("VV_RUFF_URL"),
    "ruff is installed on PATH as an ordinary program");
  ok(RESERVED_COMMANDS.has("ruff"),
    "…and reserved, so `pip install ruff` cannot shadow it with a binary that cannot start");
  const kernelWorker = fs.readFileSync(path.join(ROOT, "packages/core/src/workers/kernel-worker.ts"), "utf8");
  ok(/VV_RUFF_URL: vendorUrl\("vendor\/ruff\/"\)/.test(kernelWorker), "the kernel points it at the vendored copy");

  // The vendor step, which is the only reason any of the above can run offline.
  const vendorRuff = fs.readFileSync(path.join(ROOT, "scripts/vendor-ruff.mjs"), "utf8");
  ok(/const VERSION = "\d+\.\d+\.\d+"/.test(vendorRuff), "the vendored ruff version is pinned, so a lint result cannot change on its own");
  for (const file of ["ruff_wasm.js", "ruff_wasm_bg.wasm", "LICENSE"]) {
    ok(vendorRuff.includes(`"${file}"`), `the vendor step copies ${file}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  ok(/vendor:ruff/.test(pkg.scripts.prebuild || pkg.scripts["prebuild:studio"] || ""),
    "…and runs as part of the studio build, so a shipped build always has it");
}

// ---------------------------------------------------------------------------
// The three things a Python user hits before they hit anything else: a chart
// that never appears, a coroutine that will not run, and a timezone that does
// not exist. None of these needed an interpreter to get wrong, so none of them
// need one to check.
{
  console.log("\n== plt.show(), asyncio.run(), input(), ZoneInfo ==");

  // A fake Pyodide is enough here: what matters is which backend the boot
  // chooses, and that a backend the USER chose is left alone.
  const fakePyodide = () => {
    const calls = { dirs: [], files: {}, python: [] };
    return [calls, {
      FS: {
        mkdirTree: (d) => calls.dirs.push(d),
        writeFile: (p, body) => { calls.files[p] = body; },
      },
      runPython: (src) => { calls.python.push(src); },
    }];
  };

  const [plain, py1] = fakePyodide();
  ok(installMatplotlibShow(py1, {}) === true, "the matplotlib backend installs at boot");
  ok(Object.keys(plain.files).some((f) => f.endsWith("/vv_mpl.py")), "…writing its module somewhere importable");
  ok(!Object.keys(plain.files).some((f) => f.includes("site-packages")),
    "…and NOT into site-packages, which belongs to the package store");
  ok(plain.python.join("").includes(`os.environ["MPLBACKEND"] = "${MPL_BACKEND}"`),
    "…selected through MPLBACKEND, so nothing imports matplotlib to arrange it");

  const [chosen, py2] = fakePyodide();
  installMatplotlibShow(py2, { MPLBACKEND: "Agg" });
  ok(chosen.python.join("").includes('os.environ["MPLBACKEND"] = "Agg"'),
    "a backend the user set themselves is passed through, not overruled");

  // The backend's own contract with matplotlib, which is the part that silently
  // stops working if a name is wrong.
  ok(/^\s*def show\(/m.test(MPL_SHOW_SOURCE), "the backend defines show(), which is what plt.show() calls");
  ok(/class FigureCanvas\(FigureCanvasAgg\)/.test(MPL_SHOW_SOURCE), "…and FigureCanvas, which is how matplotlib finds it");
  ok(/manager_class = FigureManager/.test(MPL_SHOW_SOURCE),
    "…wired through manager_class, or figure.show() would warn that Agg cannot be shown");
  ok(/savefig\(/.test(MPL_SHOW_SOURCE) && /print\(/.test(MPL_SHOW_SOURCE),
    "…and it both writes the file and says where, since a chart nobody mentions is a chart nobody finds");
  ok(/_vv_plot_name/.test(MPL_SHOW_SOURCE) && /figure\._vv_plot_name = name/.test(MPL_SHOW_SOURCE),
    "the name is remembered on the figure, so a second chart cannot overwrite the first");

  // asyncio.run rewrites a message; the message IS the feature. (input() used to
  // be rewritten alongside it and is not any more — see the stdin section below,
  // which checks that its refusal is gone rather than reworded.)
  ok(/_vv_asyncio\.run = _vv_run/.test(BLOCKING_PATCH_SOURCE), "asyncio.run is wrapped");
  ok(/return _vv_real_run\(main, \*\*kwargs\)/.test(BLOCKING_PATCH_SOURCE),
    "…by trying the real one first, so a browser with JSPI is left alone");
  ok(/if "stack switching" not in str\(exc\):\n\s+raise/.test(BLOCKING_PATCH_SOURCE),
    "…and only its own failure is rewritten - every other RuntimeError is the user's");
  ok(/await main\(\)/.test(BLOCKING_PATCH_SOURCE), "…pointing at top-level await, which this runtime actually supports");

  // tzdata is loaded by matching the source, because no import statement names it.
  ok(dataPackagesFor("from zoneinfo import ZoneInfo").includes("tzdata"),
    "code that imports zoneinfo pulls tzdata in, which nothing else would");
  ok(dataPackagesFor("import zoneinfo").includes("tzdata"), "…however it is spelled");
  ok(dataPackagesFor("import datetime\nprint(datetime.datetime.now())").length === 0,
    "…and code that does not mention it pays nothing");
  const vendorSrc = fs.readFileSync(path.join(ROOT, "scripts/vendor-pyodide.mjs"), "utf8");
  ok(/"tzdata"/.test(vendorSrc), "tzdata is vendored, so timezones do not depend on the network");
}

// ---------------------------------------------------------------------------
console.log("\n== ruff's markers, which arrive before the interpreter does ==");
// The claim under test is not "ruff works" — the bridge tier holds the wasm to
// the real CLI for that. It is that the editor asks for a lint separately from a
// check, quickly, and publishes it under its own owner, so the two tools cannot
// erase each other.
// ---------------------------------------------------------------------------
{
  // Shapes recorded from the vendored wasm, so this tier tests the mapping the
  // worker actually runs. The bridge tier re-records them against the binary.
  const RUFF_OUT = [
    { code: "F401", message: "`os` imported but unused", start_location: { row: 1, column: 8 }, end_location: { row: 1, column: 10 } },
    { code: "I001", message: "Import block is un-sorted or un-formatted", start_location: { row: 1, column: 1 }, end_location: { row: 2, column: 11 } },
    // What a half-written line looks like. ruff reports it as a diagnostic like
    // any other, which is why dropping it has to be deliberate.
    { code: "invalid-syntax", message: "Expected an expression", start_location: { row: 3, column: 5 }, end_location: { row: 4, column: 1 } },
  ];
  const LINT = ruffMarkersFrom(RUFF_OUT);
  ok(LINT.items.length === 2, `the mapping drops the invalid-syntax finding and keeps the two real ones (${LINT.items.length})`);
  ok(!LINT.items.some((i) => i.code === "invalid-syntax"),
    "…so a pause in the middle of typing `x = ` does not put a red squiggle under the cursor");
  ok(ruffMarkersFrom([]).items.length === 0 && ruffMarkersFrom(null).items.length === 0,
    "a clean file and a missing answer both map to no markers, not to a crash");
  const monaco = makeFakeMonaco();
  const host = makeHost({ lint: LINT, check: { items: [] } });
  const off = registerPythonLanguage(monaco, host);
  const model = makeModel("/project/app.py", "import os\n");
  monaco.editor.openModel(model);

  // Fast enough to have answered before mypy's window has even opened, which is
  // the property that makes it worth running on top of mypy rather than instead.
  ok(LINT_DEBOUNCE_MS < CHECK_DEBOUNCE_MS, `the lint waits ${LINT_DEBOUNCE_MS}ms against the check's ${CHECK_DEBOUNCE_MS}ms`);
  await new Promise((r) => setTimeout(r, LINT_DEBOUNCE_MS + 60));
  const early = monaco.editor.markersFor(model, RUFF_MARKER_OWNER);
  ok(Array.isArray(early) && early.length === 2, `ruff's markers are up ${LINT_DEBOUNCE_MS}ms in, while mypy is still waiting`);
  ok(monaco.editor.markersFor(model, MARKER_OWNER) === null, "…and mypy has not run yet, so the two are genuinely independent");

  const [unused, unsorted] = early;
  ok(unused.startLineNumber === 1 && unused.startColumn === 8 && unused.endColumn === 10,
    "the marker is placed on ruff's own columns, which are 1-based with an exclusive end like Monaco's");
  ok(unused.severity === monaco.MarkerSeverity.Warning, "a lint finding is a Warning - the file still runs");
  ok(unsorted.severity === monaco.MarkerSeverity.Warning, "…every one of them, since the class that stops it running is dropped upstream");
  ok(unsorted.endLineNumber === 2, "a finding that spans lines keeps its end line, so the whole import block is underlined");
  ok(unused.code === "F401", "the rule id rides along, so a `# noqa: F401` can be written from it");
  ok(unused.source === "ruff", "…and the marker says ruff produced it, not mypy");

  const lintCalls = host.calls.filter((c) => c.req.op === "lint");
  ok(lintCalls.length === 1, `one lint was asked for (${lintCalls.length})`);
  ok(lintCalls[0].req.code === "import os\n", "…carrying the buffer, so an unsaved edit is what gets linted");

  // Typing coalesces here too, and the two timers do not interfere.
  const beforeLint = host.calls.filter((c) => c.req.op === "lint").length;
  model.setValue("import os\nimport sys\n");
  model.setValue("import os\nimport sys\nimport json\n");
  await new Promise((r) => setTimeout(r, CHECK_DEBOUNCE_MS + 120));
  const afterLint = host.calls.filter((c) => c.req.op === "lint").length;
  ok(afterLint === beforeLint + 1, `two edits inside the window are one lint (${afterLint - beforeLint})`);
  ok(monaco.editor.markersFor(model, MARKER_OWNER) !== null, "…and by now mypy has run too, on its own timer");

  // Both owners survive each other: mypy publishing an empty list is mypy saying
  // the types are fine, not ruff's findings being withdrawn.
  ok((monaco.editor.markersFor(model, RUFF_MARKER_OWNER) || []).length === 2,
    "ruff's markers are still there after mypy published its own");
  ok(RUFF_MARKER_OWNER !== MARKER_OWNER, "…which is only true because they are separate marker owners");

  // A ruff that cannot start is reported once, and does not clear what it said
  // before. There is nothing the user can do about it, so a squiggle is wrong.
  const m2 = makeFakeMonaco();
  const h2 = makeHost({ lint: { error: "boom", message: "no vendored ruff" }, check: { items: [] } });
  registerPythonLanguage(m2, h2);
  const model2 = makeModel("/project/b.py", "import os\n");
  m2.editor.openModel(model2);
  await new Promise((r) => setTimeout(r, LINT_DEBOUNCE_MS + 60));
  model2.setValue("import os\nimport sys\n");
  await new Promise((r) => setTimeout(r, LINT_DEBOUNCE_MS + 60));
  const ruffNotices = h2.notices.filter((n) => /^ruff: /.test(n));
  ok(ruffNotices.length === 1, `a ruff that cannot load says so exactly once, by name, across edits (${ruffNotices.length})`);
  ok(m2.editor.markersFor(model2, RUFF_MARKER_OWNER) === null, "…and publishes no markers at all rather than an all-clear");

  off();
}

// ---------------------------------------------------------------------------
console.log("\n== stubs, so mypy's first message is about the user's code ==");
// ---------------------------------------------------------------------------
{
  ok(TYPE_STUBS.includes("types-requests"), "requests has stubs, because requests ships none of its own");
  ok(TYPE_STUBS.includes("pandas-stubs"), "…and so does pandas");
  for (const stub of TYPE_STUBS) {
    ok(MYPY_PACKAGES.includes(stub), `${stub} is loaded with mypy, or the stubs would be vendored and never read`);
  }
  const vendorSrc = fs.readFileSync(path.join(ROOT, "scripts/vendor-pyodide.mjs"), "utf8");
  for (const stub of TYPE_STUBS) {
    ok(new RegExp(`name: "${stub}", version: "[0-9.]+"`).test(vendorSrc),
      `${stub} is vendored at a pinned version, so the editor's advice cannot change under the user`);
    ok(new RegExp(`name: "${stub}"[^}]*imports: \\[\\]`).test(vendorSrc),
      `…with no imports declared, so a script's interpreter never loads a stub package it cannot use`);
  }
}

// ---------------------------------------------------------------------------
console.log("\n== the interpreter snapshot, which is a cache and so must be able to be wrong ==");
// The bridge tier proves a restored interpreter works. What is gated here is
// everything around it: that a stale, truncated, foreign or switched-off cache
// is IGNORED rather than restored, because each of those would otherwise hand a
// user a broken CPython that they cannot connect to anything they did.
// ---------------------------------------------------------------------------
{
  // A filesystem small enough to reason about, with the same surface the boot
  // path uses. Buffers, because that is what the guest's fs returns.
  const fakeFs = () => {
    const files = new Map();
    return {
      files,
      readFileSync(p, enc) {
        if (!files.has(p)) { const e = new Error("ENOENT: " + p); e.code = "ENOENT"; throw e; }
        const b = files.get(p);
        return enc === "utf8" ? b.toString("utf8") : b;
      },
      writeFileSync: (p, data) => files.set(p, Buffer.from(data)),
      mkdirSync: () => {},
      rmSync: (p) => files.delete(p),
    };
  };
  const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const fakePy = { version: "0.29.0", makeMemorySnapshot: () => BYTES };
  const URL_A = "/vendor/pyodide/";

  const fs1 = fakeFs();
  ok(readSnapshot(fs1, URL_A, {}) === null, "the first command of a session finds no cache, and says so quietly");

  writeSnapshot(fs1, fakePy, URL_A);
  ok(fs1.files.has(SNAPSHOT_BIN) && fs1.files.has(SNAPSHOT_META), "…and leaves one behind for the next command");
  const got = readSnapshot(fs1, URL_A, {});
  ok(got && got.length === 8 && got[0] === 1 && got[7] === 8, "the next command gets the same bytes back");

  // A different interpreter build. The bytes are only meaningful to the one that
  // produced them, and restoring them into another is the failure this guards.
  ok(readSnapshot(fs1, "/vendor/pyodide-3.13/", {}) === null,
    "a snapshot from a different interpreter build is not used");

  // A half-written cache: the sidecar is the commit record, so bytes that do not
  // match it are not trusted.
  fs1.files.set(SNAPSHOT_BIN, Buffer.from([1, 2, 3]));
  ok(readSnapshot(fs1, URL_A, {}) === null, "a truncated cache is ignored rather than restored");
  const fs2 = fakeFs();
  writeSnapshot(fs2, fakePy, URL_A);
  fs2.files.set(SNAPSHOT_META, Buffer.from("{not json"));
  ok(readSnapshot(fs2, URL_A, {}) === null, "…as is one whose sidecar is corrupt");

  // The switch, and that it turns off BOTH halves — a session that will not read
  // a snapshot must not spend 31 MB writing one either.
  ok(snapshotsEnabled({}) === true && snapshotsEnabled({ VV_PYTHON_SNAPSHOT: "1" }) === true,
    "snapshots are on unless someone turns them off");
  ok(snapshotsEnabled({ VV_PYTHON_SNAPSHOT: "0" }) === false, "VV_PYTHON_SNAPSHOT=0 turns them off");
  const fs3 = fakeFs();
  writeSnapshot(fs3, fakePy, URL_A);
  ok(readSnapshot(fs3, URL_A, { VV_PYTHON_SNAPSHOT: "0" }) === null, "…and a switched-off session reads no cache");

  // Discarding has to be complete: a bin left behind with no sidecar is 31 MB of
  // a session's memory that nothing will ever read.
  discardSnapshot(fs3);
  ok(!fs3.files.has(SNAPSHOT_BIN) && !fs3.files.has(SNAPSHOT_META), "discarding removes both halves, not just the record");
  discardSnapshot(fs3);
  ok(true, "…and discarding a cache that is already gone is not an error");

  // A filesystem that refuses to write must cost the next command time, not this
  // command its run.
  const readonly = { readFileSync: () => { throw new Error("EROFS"); }, writeFileSync: () => { throw new Error("EROFS"); }, mkdirSync: () => {}, rmSync: () => {} };
  writeSnapshot(readonly, fakePy, URL_A);
  ok(true, "a cache that cannot be written does not fail the command that tried");
  ok(readSnapshot(readonly, URL_A, {}) === null, "…and a cache that cannot be read is simply absent");

  // The self-check, which is what makes a bad restore cost one cold boot.
  ok(restoredOk({ runPython: () => "[3, 2]" }) === true, "a restored interpreter that can import and format passes the check");
  ok(restoredOk({ runPython: () => "nonsense" }) === false, "one that answers wrongly fails it");
  ok(restoredOk({ runPython: () => { throw new Error("wasm trap"); } }) === false, "…and one that traps fails it rather than taking the command down");

  // The boot path has to use all of this in the right order, and in particular
  // must not restore a snapshot it then fails to check.
  const src = fs.readFileSync(path.join(ROOT, "packages/runtime/builtins/python.js"), "utf8");
  const iRead = src.indexOf("readSnapshot(snapFs");
  const iRestore = src.indexOf("_loadSnapshot: cached");
  const iCheck = src.indexOf("restoredOk(restored)");
  const iMake = src.indexOf("_makeSnapshot: making");
  ok(iRead > 0 && iRead < iRestore && iRestore < iCheck, "the boot reads the cache, restores from it, then checks the result");
  ok(iCheck < iMake, "…and only boots cold when that fails, rather than the other way round");
  const iPatch = src.indexOf("installMatplotlibShow(pyodide, process.env)");
  ok(iMake < iPatch,
    "the snapshot is taken BEFORE the per-process patches, since those read this process's environment");
  ok(/VV_PYTHON_SNAPSHOT/.test(src), "and the switch is reachable from the boot path");
}

// ---------------------------------------------------------------------------
console.log("\n== the bytecode a run compiled, kept for the run after it ==");
// The bridge tier proves the saving is real under a real interpreter. What is
// gated here is the bookkeeping around it, all of which can be wrong quietly:
// an entry from another CPython, a half-written one, a cache that is never
// consulted because the calls sit in the wrong order.
// ---------------------------------------------------------------------------
{
  const fakeFs = () => {
    const files = new Map();
    return {
      files,
      readFileSync(p, enc) {
        if (!files.has(p)) { const e = new Error("ENOENT: " + p); e.code = "ENOENT"; throw e; }
        const b = files.get(p);
        return enc === "utf8" ? b.toString("utf8") : b;
      },
      writeFileSync: (p, data) => files.set(p, Buffer.from(data)),
      readdirSync(p) {
        if (p !== BYTECODE_DIR) { const e = new Error("ENOENT: " + p); e.code = "ENOENT"; throw e; }
        return [...files.keys()].filter((f) => f.startsWith(p + "/")).map((f) => f.slice(p.length + 1));
      },
      statSync(p) {
        if (!files.has(p)) { const e = new Error("ENOENT: " + p); e.code = "ENOENT"; throw e; }
        return { size: files.get(p).length };
      },
      mkdirSync: () => {},
      rmSync: (p) => files.delete(p),
    };
  };
  const MAGIC = "cb0d0d0a";
  // An interpreter that records what it was asked to do, so that ordering and
  // the shape of the generated Python can both be asserted on.
  const fakePy = (over) => {
    const calls = [];
    return {
      calls,
      runPython(code) {
        calls.push(["runPython", code]);
        if (/MAGIC_NUMBER\.hex\(\)$/.test(code.trim())) return MAGIC;
        if (code.includes("_vv_keys.append")) return JSON.stringify({ magic: MAGIC, keys: (over && over.installed) || [] });
        if (code.includes("_vv_made")) return JSON.stringify({ magic: MAGIC, made: (over && over.made) || {} });
        return "";
      },
      FS: {
        mkdirTree: (p) => calls.push(["mkdirTree", p]),
        writeFile: (p) => calls.push(["writeFile", p]),
        readFile: (p) => { calls.push(["readFile", p]); return new Uint8Array([9, 9, 9]); },
        unlink: (p) => calls.push(["unlink", p]),
      },
    };
  };

  ok(bytecodeEnabled({}) === true && bytecodeEnabled({ VV_PYTHON_BYTECODE: "1" }) === true,
    "the bytecode cache is on unless someone turns it off");
  ok(bytecodeEnabled({ VV_PYTHON_BYTECODE: "0" }) === false, "VV_PYTHON_BYTECODE=0 turns it off");

  // The ordering that decides whether ANY bytecode is written at all: CPython
  // walks up from the .pyc looking for a directory that exists, and if the
  // prefix root is not there when the first import happens it silently writes
  // nothing. Measured: 0 files cached, no error, no clue.
  const boot = fakePy();
  installBytecodeCache(boot, {});
  const iMkdir = boot.calls.findIndex((c) => c[0] === "mkdirTree" && c[1] === PYCACHE_PREFIX);
  const iSet = boot.calls.findIndex((c) => c[0] === "runPython" && c[1].includes("pycache_prefix"));
  ok(iMkdir >= 0 && iSet > iMkdir, "the prefix directory is created BEFORE it is set, or nothing is ever cached");
  const setCode = boot.calls[iSet][1];
  ok(/sys\.dont_write_bytecode = False/.test(setCode), "…bytecode writing is turned back on, which Pyodide turns off");
  ok(setCode.includes(JSON.stringify(PYCACHE_PREFIX)),
    "…and it is directed at a tree of its own, so no __pycache__ appears in the user's project");
  const off = fakePy();
  ok(installBytecodeCache(off, { VV_PYTHON_BYTECODE: "0" }) === false && off.calls.length === 0,
    "a switched-off session does not touch the interpreter at all");

  // What counts as an entry. Each of these is a cache that would produce
  // wrong-looking imports rather than slow ones.
  const fs1 = fakeFs();
  ok(readBytecodeIndex(fs1, MAGIC).size === 0, "the first command of a session finds no entries, quietly");
  const put = (f, key, meta, tarLen) => {
    f.files.set(BYTECODE_DIR + "/" + key + ".tar", Buffer.alloc(tarLen === undefined ? meta.bytes : tarLen));
    f.files.set(BYTECODE_DIR + "/" + key + ".json", Buffer.from(JSON.stringify(meta)));
  };
  put(fs1, "numpy-2.4.3", { bytes: 100, count: 89, magic: MAGIC });
  ok(readBytecodeIndex(fs1, MAGIC).get("numpy-2.4.3").count === 89, "a complete entry is one, and remembers how much it holds");
  put(fs1, "pandas-3.0.2", { bytes: 200, count: 250, magic: "0a0d0dcb" });
  ok(!readBytecodeIndex(fs1, MAGIC).has("pandas-3.0.2"),
    "bytecode from a different CPython is not bytecode, and is not used");
  put(fs1, "six-1.17.0", { bytes: 300, count: 1, magic: MAGIC }, 12);
  ok(!readBytecodeIndex(fs1, MAGIC).has("six-1.17.0"),
    "…nor is a tar that disagrees with the sidecar written after it, which is a half-written cache");
  fs1.files.set(BYTECODE_DIR + "/pytz-2026.1.json", Buffer.from("{not json"));
  ok(!readBytecodeIndex(fs1, MAGIC).has("pytz-2026.1"), "…nor one whose record cannot be read");

  // Restoring: only what is BOTH installed and cached, because a tar for a
  // package this process does not have is bytes moved for nothing.
  const py1 = fakePy({ installed: ["numpy-2.4.3", "pandas-3.0.2"] });
  const res = restoreBytecode(fs1, py1, {});
  ok(res.keys.join() === "numpy-2.4.3", "only the installed packages the cache actually has are restored");
  const extract = py1.calls.filter((c) => c[0] === "runPython").pop()[1];
  ok(extract.includes("/tmp/vv-pyc-numpy-2.4.3.tar") && extract.includes(JSON.stringify(PYCACHE_PREFIX)),
    "…and they are unpacked into the prefix the interpreter was pointed at");
  ok(/finally:\s*\n\s*os\.remove/.test(extract), "…and the copy is removed afterwards, whatever the unpack did");
  const py2 = fakePy({ installed: ["numpy-2.4.3"] });
  ok(restoreBytecode(fs1, py2, { VV_PYTHON_BYTECODE: "0" }) === null && py2.calls.length === 0,
    "a switched-off session reads no entries");
  ok(restoreBytecode(fakeFs(), fakePy({ installed: ["numpy-2.4.3"] }), {}).restored === 0,
    "…and an empty cache restores nothing rather than failing");

  // Harvesting, which has to be told what is already held so that a package
  // imported more deeply this time replaces a thinner entry.
  const fs2 = fakeFs();
  put(fs2, "numpy-2.4.3", { bytes: 100, count: 89, magic: MAGIC });
  const py3 = fakePy({ made: { "pandas-3.0.2": ["/tmp/vv-pyc-pandas-3.0.2.tar", 250] } });
  const saved = harvestBytecode(fs2, py3, {});
  const harvestCode = py3.calls.filter((c) => c[0] === "runPython" && c[1].includes("_vv_made"))[0][1];
  const told = JSON.parse(JSON.parse(harvestCode.match(/_vv_known = json\.loads\((".*")\)/)[1]));
  ok(told["numpy-2.4.3"] === 89, "the harvest is told what the cache already holds, and how much of it");
  ok(/len\(_vv_members\) <= _vv_known\.get\(_vv_key, -1\)/.test(harvestCode),
    "…so a package imported more deeply than last time replaces its entry rather than being skipped");
  ok(/int\.from_bytes\(_vv_raw\[4:8\], "little"\) == 0/.test(harvestCode),
    "…and only a timestamp-based header is rewritten, since a restored one is already hash-based");
  ok(harvestCode.includes("(1).to_bytes(4, \"little\")"),
    "the rewritten header is hash-based and unchecked, which is what survives a wheel unpacked at a new mtime");
  ok(saved.saved.join() === "pandas-3.0.2", "what the run compiled is kept");
  const meta = JSON.parse(fs2.files.get(BYTECODE_DIR + "/pandas-3.0.2.json").toString("utf8"));
  ok(meta.count === 250 && meta.magic === MAGIC && meta.bytes === 3,
    "…with a record of how much it holds, and which CPython compiled it");
  ok(py3.calls.some((c) => c[0] === "unlink" && c[1] === "/tmp/vv-pyc-pandas-3.0.2.tar"),
    "…and the interpreter-side copy is not left behind");

  // Failure has to cost the next command time, never this command its run.
  const readonly = {
    readFileSync: () => { throw new Error("EROFS"); },
    writeFileSync: () => { throw new Error("EROFS"); },
    readdirSync: () => { throw new Error("EROFS"); },
    statSync: () => { throw new Error("EROFS"); },
    mkdirSync: () => {},
  };
  harvestBytecode(readonly, fakePy({ made: { "numpy-2.4.3": ["/tmp/x.tar", 89] } }), {});
  ok(true, "a cache that cannot be written does not fail the command that tried");
  ok(restoreBytecode(readonly, fakePy({ installed: ["numpy-2.4.3"] }), {}).restored === 0,
    "…and one that cannot be read is simply absent");
  const broken = { runPython: () => { throw new Error("wasm trap"); }, FS: {} };
  ok(harvestBytecode(fakeFs(), broken, {}) === null && restoreBytecode(fakeFs(), broken, {}) === null,
    "…as is an interpreter that will not answer, rather than taking the run down with it");

  // The order in the run path, which is what makes any of it apply.
  const pysrc = fs.readFileSync(path.join(ROOT, "packages/runtime/builtins/python.js"), "utf8");
  const iInstall = pysrc.indexOf("installBytecodeCache(pyodide, process.env)");
  const iSnap = pysrc.indexOf("_makeSnapshot: making");
  ok(iSnap < iInstall, "the setting is applied per process, after the snapshot, like the other patches");
  const iLoad = pysrc.indexOf("loadPackagesFromImports(importSource || source");
  const iRestore = pysrc.indexOf("restoreBytecode(req(\"fs\"), pyodide, process.env)");
  const iRun = pysrc.indexOf("runPythonAsync(source, { filename })");
  const iHarvest = pysrc.indexOf("harvestBytecode(req(\"fs\"), pyodide, process.env)");
  ok(iLoad < iRestore && iRestore < iRun,
    "the cache is put back after the packages are unpacked and before the first import, which is the point of it");
  ok(iRun < iHarvest, "…and collected after the run, when everything it imported has been imported");
  ok(/finally \{[\s\S]{0,600}harvestBytecode/.test(pysrc),
    "…in the finally, so a script that raises still leaves its bytecode for the next command");
}

// ---------------------------------------------------------------------------
console.log("\n== Ctrl-C interrupts Python instead of killing it ==");
// The interrupt itself is measured next door against a real interpreter in a
// real worker. What is gated here is the exit code it becomes, and the wiring
// that decides when Vivari is entitled to take Ctrl-C away from the kernel.
// ---------------------------------------------------------------------------
{
  ok(terminationFromError({ type: "KeyboardInterrupt", message: "KeyboardInterrupt" }).code === 130,
    "an interrupted run exits 130, which is 128+SIGINT and what a shell reports");
  ok(/KeyboardInterrupt/.test(terminationFromError({ type: "KeyboardInterrupt", message: "Traceback…\nKeyboardInterrupt" }).report),
    "…and still prints the traceback, so you can see where it was when you stopped it");
  ok(terminationFromError({ type: "ValueError", message: "ValueError: nope" }).code === 1,
    "…while an ordinary exception is still a plain failure");
  ok(terminationFromError({ type: "SystemExit", message: "SystemExit: 3" }).code === 3,
    "…and sys.exit(3) is still 3, not swallowed by the new branch");

  const pySrc = fs.readFileSync(path.join(ROOT, "packages/runtime/builtins/python.js"), "utf8");
  ok(/pyodide\.setInterruptBuffer\(interrupt\)/.test(pySrc),
    "the interpreter is handed the byte it polls, which is the only route into a busy interpreter");
  ok(/interrupt\[0\] = 0;\s*\n\s*process\.on\("SIGINT", onSigint\)/.test(pySrc),
    "arming clears the byte first, so a Ctrl-C nobody was running to receive cannot fire on the next thing typed");
  ok(/disarmInterrupts[\s\S]{0,200}removeListener\("SIGINT", onSigint\)/.test(pySrc),
    "…and the handler is removed again afterwards");
  ok(/signalHandled\("SIGINT"\)/.test(pySrc),
    "the handler stands the kernel's force-kill window down, since the process is alive on purpose");
  ok(/withInterruptsSync\(\(\) => console_\.push\(line\)\)/.test(pySrc),
    "the REPL arms it around each statement, which is where a runaway loop gets typed");
  ok(/interrupted \? "KeyboardInterrupt"/.test(pySrc),
    "…and an interrupted statement prints the name and gives a fresh prompt, as CPython does");
  const iArm = pySrc.indexOf("async function withInterrupts(");
  ok(iArm > 0 && /return await fn\(\)/.test(pySrc.slice(iArm, iArm + 260)),
    "the async arm AWAITS the run, or it would disarm while the interpreter was still going");

  // WHY THE STAND-DOWN IS OPT-IN. Making it automatic would have been one line
  // and would have quietly removed the only thing stopping a guest that catches
  // a signal and ignores it from living forever.
  const sigSrc = fs.readFileSync(path.join(ROOT, "packages/runtime/signals.js"), "utf8");
  ok(/const standDown = \(name\)/.test(sigSrc) && /"signal-handled"/.test(sigSrc),
    "a guest can tell the kernel it handled a signal and is staying");
  const drain = sigSrc.slice(sigSrc.indexOf("drain: () =>"));
  ok(!/standDown/.test(drain),
    "…but running a handler does NOT do it by itself: a handler that hangs must still be force-killed");

  const kernelSrc = fs.readFileSync(path.join(ROOT, "packages/kernel-host/kernel.js"), "utf8");
  ok(/if \(proc\.sigUnhandled === sig\) \{[\s\S]{0,120}finalize/.test(kernelSrc),
    "hammering Ctrl-C at a process that is NOT answering still escalates to a kill");
  ok(/handleSignalHandled\(pid, m\) \{[\s\S]{0,400}clearTimeout\(proc\.graceTimer\)/.test(kernelSrc),
    "…and answering clears the window, so the escalation is about silence rather than repetition");

  const runtimeSrc = fs.readFileSync(path.join(ROOT, "packages/runtime/index.js"), "utf8");
  ok(/interrupt: ctrl && ctrl\.buffer \? interruptView\(ctrl\.buffer\) : null/.test(runtimeSrc),
    "the byte is a window onto the process's own syscall SAB, so no new channel was needed");
  const protoSrc = fs.readFileSync(path.join(ROOT, "packages/protocol/syscall.js"), "utf8");
  ok(/if \(name === "SIGINT"\) interruptView\(ctrl\.buffer\)\[0\] = INTERRUPT_SIGINT;/.test(protoSrc),
    "only SIGINT is mirrored into it — the byte is not a second signal channel");
  ok(/I_INTERRUPT_BYTE = 20/.test(protoSrc) && /little-endian/.test(protoSrc),
    "…at a named offset, with the byte-order assumption written down rather than implied");
}

// ---------------------------------------------------------------------------
console.log("\n== breakpoints in a .py file, in the debug UI that already existed ==");
// The bridge tier stops a real interpreter on a real line and steps through it.
// What is gated here is everything that decides whether that backend is ever
// reached at all — which of the two debuggers a process gets, and the protocol
// bookkeeping a frontend is entitled to assume.
// ---------------------------------------------------------------------------
{
  // A Pyodide stand-in that records what Python was asked, and answers the way
  // the real _vv_dbg would.
  const fakePy = (over) => {
    const asked = [];
    const dbgObj = {
      start: (cb, roots) => asked.push(["start", roots]),
      stop: () => asked.push(["stop"]),
      set_breakpoints: (pairs) => asked.push(["set_breakpoints", pairs]),
      set_active: (on) => asked.push(["set_active", on]),
      request_pause: () => asked.push(["request_pause"]),
      breakable: () => JSON.stringify((over && over.breakable) || [1, 4, 5, 6]),
      scope: (i, kind) => JSON.stringify([{ name: kind + i, value: { type: "number", value: 1 } }]),
      props: (handle) => JSON.stringify([{ name: "from:" + handle, value: { type: "number", value: 2 } }]),
      evaluate: (i, expr) => JSON.stringify({ result: { type: "string", value: "eval:" + expr } }),
    };
    return {
      asked,
      runPython: () => dbgObj,
      FS: { readFile: () => "print(1)\n" },
    };
  };
  const harness = (over) => {
    const sent = [];
    const py = fakePy(over);
    const dbg = createPythonDebugger({
      pyodide: py,
      roots: ["/projects/"],
      send: (m) => sent.push(m),
      // The real transport (readDebugCommandBlocking) parks on the debug SAB for
      // up to `timeoutMs` and answers null only when that runs out. A stand-in
      // that returns null instantly would make a gate look instant when it is
      // not, so this waits the same way.
      waitForCommand: (timeoutMs) => {
        const next = over && over.commands && over.commands.shift();
        if (next) return next;
        if (timeoutMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, timeoutMs);
        return null;
      },
    });
    let seq = 0;
    const cmd = (method, params) => {
      const id = ++seq;
      dbg.onCommand({ id, method, params: params || {} });
      return sent.find((m) => m.id === id);
    };
    return { dbg, sent, py, cmd };
  };

  // The Python half. These are claims about the source because the behaviour
  // they describe is measured next door, under an interpreter.
  ok(/sys\.monitoring/.test(PY_DEBUG_SOURCE) && !/sys\.settrace/.test(PY_DEBUG_SOURCE),
    "the engine is sys.monitoring, not settrace — 23ms against 217ms on the same loop");
  ok(/return sys\.monitoring\.DISABLE/.test(PY_DEBUG_SOURCE),
    "…and a line that is not a breakpoint retires itself, which is where the 23ms comes from");
  ok(/if not self\._mine\(filename\)[\s\S]{0,120}DISABLE/.test(PY_DEBUG_SOURCE),
    "library code is dropped on the first line of it, so importing pandas under a breakpoint is not traced");
  ok(/restart_events/.test(PY_DEBUG_SOURCE),
    "…and stepping re-arms the locations that retired, or the step after a pause would run to the end");
  ok(/_HIDDEN = frozenset/.test(PY_DEBUG_SOURCE) && /__builtins__/.test(PY_DEBUG_SOURCE),
    "__builtins__ is kept out of the Variables panel, being 3 kB of dict in every module frame");
  ok(/action = "resume"[\s\S]{0,200}except Exception/.test(PY_DEBUG_SOURCE),
    "a frontend that disappears mid-pause resumes the program rather than wedging it");

  // Scripts, and the line a breakpoint actually lands on.
  {
    const { dbg, sent, py, cmd } = harness();
    cmd("Debugger.enable");
    dbg.registerScript("/projects/demo/main.py");
    const parsed = sent.find((m) => m.method === "Debugger.scriptParsed");
    ok(parsed && parsed.params.url === "file:///projects/demo/main.py",
      "a script is announced by file:// url, which is how the studio maps it back to the editor");
    ok(parsed.params.endLine === 6, "…with its last breakable line, so the frontend knows how far it goes");

    const onReal = cmd("Debugger.setBreakpointByUrl", { url: "file:///projects/demo/main.py", lineNumber: 3 });
    ok(onReal.result.locations[0].lineNumber === 3, "a breakpoint on a line that exists binds to that line");
    const onBlank = cmd("Debugger.setBreakpointByUrl", { url: "file:///projects/demo/main.py", lineNumber: 1 });
    ok(onBlank.result.locations[0].lineNumber === 3,
      "…and one on a blank line or a comment binds to the next line that exists, rather than never firing");
    const pairs = py.asked.filter((a) => a[0] === "set_breakpoints").pop()[1];
    ok(pairs.length === 2 && pairs.every((p) => p[0] === "/projects/demo/main.py" && p[1] === 4),
      `…and both reached the interpreter as resolved (file, line) pairs (${JSON.stringify(pairs)})`);
  }

  // Which commands are answered while the program is running, and which are not.
  {
    const { cmd } = harness();
    ok(cmd("Debugger.setBreakpointsActive", { active: false }), "breakpoints can be switched off without detaching");
    ok(cmd("Debugger.pause"), "…a pause can be requested of a program that is running");
    ok(cmd("Runtime.enable") && cmd("Debugger.setPauseOnExceptions", { state: "none" }),
      "…and the domain setup a frontend sends on attach is answered rather than ignored");
    const props = cmd("Runtime.getProperties", { objectId: "py:7" });
    ok(props.result.result[0].name === "from:py:7",
      "an objectId that is not a scope is looked up in the interpreter's own table");
  }

  // The start gate, which is what makes a breakpoint on line 1 of a fast script
  // work at all.
  {
    const commands = [{ id: 99, method: "Runtime.runIfWaitingForDebugger" }];
    const { dbg } = harness({ commands });
    const t0 = Date.now();
    dbg.waitForStart(2000);
    ok(Date.now() - t0 < 1500, "the gate opens as soon as the frontend says to run");
    const late = harness({ commands: [] });
    const t1 = Date.now();
    late.dbg.waitForStart(120);
    ok(Date.now() - t1 >= 100, "…and a debug session nobody is watching runs anyway, after a bounded wait");

    // The kernel starts a debug target in SAB-routing mode, because until the
    // gate opens the SAB is the only channel with a reader. It flips back on
    // `Debugger.resumed`. Without that, everything sent while the program runs —
    // a breakpoint set after it started — queues where nothing drains it.
    const gated = harness({ commands: [{ id: 1, method: "Runtime.runIfWaitingForDebugger" }] });
    gated.dbg.waitForStart(500);
    ok(gated.sent.some((m) => m.method === "Debugger.resumed"),
      "opening the gate tells the kernel to route commands by postMessage again");
    // A gate that never heard from anyone has to say the same thing, or an
    // unattended debug run leaves the kernel talking into the SAB forever.
    const silent = harness({ commands: [] });
    silent.dbg.waitForStart(50);
    ok(silent.sent.some((m) => m.method === "Debugger.resumed"),
      "…and so does one that timed out waiting for a frontend that never came");
  }

  // THE NAME THE SCRIPT RUNS UNDER. `python main.py` is how people run things,
  // and it used to reach the interpreter as the relative "main.py" — which is
  // the name every code object gets, and therefore the name a breakpoint has to
  // match. The editor's breakpoints are on VFS paths, which are absolute, so
  // nothing ever matched and the debugger did nothing at all. It did not look
  // broken: the target appeared, the script ran, the target went away.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-pyrel-"));
    fs.writeFileSync(path.join(dir, "main.py"), "print('hi')\n");
    const { api } = mirrorRuntime(dir);
    await api.runFile("main.py", []);
    const ran = (globalThis.__vvFakePyodide && globalThis.__vvFakePyodide.ran) || [];
    const script = ran.find((r) => r.source.includes("print('hi')"));
    ok(script && script.filename === path.join(dir, "main.py"),
      `a script run by a relative name still compiles under its absolute path (${script && script.filename})`);
    ok(script && script.filename.startsWith("/"),
      "…which is the only form a breakpoint set in the editor can match");
    const argvLine = ran.find((r) => r.source.includes("sys.argv ="));
    ok(argvLine && /sys\.argv = \["main\.py"\]/.test(argvLine.source),
      `…while sys.argv keeps the name as typed, which is what CPython does and what scripts print (${argvLine && argvLine.source})`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // WHICH BACKEND. Getting this wrong does not fail loudly: it instruments a
  // 2500-line launcher shim and offers the user breakpoints in it.
  const kernelSrc = fs.readFileSync(path.join(ROOT, "packages/kernel-host/kernel.js"), "utf8");
  const skip = kernelSrc.match(/const skipDebug = \/\^\(([^)]*)\)/);
  ok(skip && !/python/.test(skip[1]),
    "the kernel no longer refuses to debug python, since there is now something to debug it with");
  ok(/const debugLang = \/\^python3\?\$\/\.test\(cmd\) \? "python" : "js"/.test(kernelSrc),
    "…it labels the target by language instead, which rides along with the SAB");
  ok(/^(sh|bash|npm)/.test("sh") && /\bsh\|bash\b/.test(skip[1]),
    "…and the shell and package managers are still skipped, so auto-attach lands on the program");

  const runtimeSrc = fs.readFileSync(path.join(ROOT, "packages/runtime/index.js"), "utf8");
  ok(/debugIsPython = !!\(debug && debug\.sab && debug\.lang === "python"\)/.test(runtimeSrc),
    "the runtime reads that label");
  ok(/const debugEnabled = !!\(debug && debug\.sab\) && !debugIsPython/.test(runtimeSrc),
    "…and exactly one of the two backends attaches, never both");
  ok(/debug: debugIsPython \? debug : null/.test(runtimeSrc),
    "…with the python runtime given the channel only when it is the one that should have it");
  const bootSrc = fs.readFileSync(path.join(ROOT, "packages/runtime/boot.js"), "utf8");
  ok(/lang: debugLang/.test(bootSrc), "and the label survives the trip through the worker boot");

  const pySrc = fs.readFileSync(path.join(ROOT, "packages/runtime/builtins/python.js"), "utf8");
  ok(/if \(!debug \|\| !debug\.sab \|\| dbg\) return;/.test(pySrc),
    "a python process with no debug channel attaches nothing, which is every ordinary run");
  const iAttach = pySrc.indexOf("attachDebugger(pyodide)");
  const iStdin = pySrc.indexOf("installStdin(pyodide)");
  ok(iStdin < iAttach, "the debugger is armed after the boot patches, so a breakpoint cannot land inside one");
  const iRegister = pySrc.indexOf("dbg.registerScript(filename)");
  const iGate = pySrc.indexOf("dbg.waitForStart()");
  const iRun = pySrc.indexOf("runPythonAsync(source, { filename })");
  ok(iRegister > 0 && iRegister < iGate && iGate < iRun,
    "…and the file is announced, then the gate waits, then the program runs — in that order or breakpoints miss");
}

// ---------------------------------------------------------------------------
console.log("\n== input() waits, because stdin got a syscall ==");
// The syscall itself is proven in scripts/verify-node.mjs, against the real
// kernel and a real parked process worker. The interpreter half is proven in the
// bridge tier, under real CPython. What is left for here is the join: that the
// callback handed to Pyodide turns the syscall's answers into what Python
// expects, and that the refusal it replaces is actually gone.
// ---------------------------------------------------------------------------
{
  const fakePyodide = () => {
    const set = [];
    return { set, setStdin: (o) => set.push(o) };
  };

  const py = fakePyodide();
  const asked = [];
  const queue = ["duc\n", "42\n", null];
  ok(installStdin(py, () => { asked.push(1); return queue.shift(); }) === true, "the interpreter gets a stdin");
  const cb = py.set[0];
  ok(cb.isatty === true, "…that says it is a terminal, which is what pdb and input()'s prompt check");
  ok(cb.stdin() === "duc\n", "a line comes through with its newline, which is how Python knows it is a line");
  ok(cb.stdin() === "42\n", "…and the next call gets the next one");
  ok(cb.stdin() === null, "end of input is null, which Python turns into the EOFError it would give any closed stdin");
  ok(asked.length === 3, "one syscall per read, with no polling in between");

  // The syscall returns null for end of input; a defensive empty string has to
  // mean the same thing, or Python would read it as an infinitely empty line.
  const py2 = fakePyodide();
  installStdin(py2, () => "");
  ok(py2.set[0].stdin() === null, "an empty answer is end of input, not an empty line that repeats forever");

  // A runtime with no such syscall (an older host, or a non-process context)
  // must leave stdin alone rather than install a callback that throws.
  const py3 = fakePyodide();
  const hadGlobal = globalThis.__ocReadStdin;
  delete globalThis.__ocReadStdin;
  ok(installStdin(py3) === false && py3.set.length === 0,
    "without the syscall, stdin is left exactly as Pyodide had it");
  if (hadGlobal) globalThis.__ocReadStdin = hadGlobal;

  // The old refusal is gone, not reworded — and the one next to it, which is
  // still true, is still there.
  ok(!/input\(\) cannot wait/.test(BLOCKING_PATCH_SOURCE) && !/_vv_builtins\.input\s*=/.test(BLOCKING_PATCH_SOURCE),
    "builtins.input is no longer replaced, since the reason it was has been fixed");
  ok(/stack switching/.test(BLOCKING_PATCH_SOURCE),
    "…while asyncio.run's message stays, because blocking on a coroutine still needs something the browser lacks");

  // The wiring, in the three files it has to exist in at once.
  const protocolSrc = fs.readFileSync(path.join(ROOT, "packages/protocol/syscall.js"), "utf8");
  const opcodes = [...protocolSrc.matchAll(/export const (OP_\w+) = (\d+);/g)].map((m) => [m[1], +m[2]]);
  const readStdin = opcodes.find(([n]) => n === "OP_READ_STDIN");
  ok(!!readStdin, "the protocol has an opcode for it");
  ok(opcodes.filter(([, v]) => v === readStdin[1]).length === 1,
    `…and ${readStdin[1]} is not already some other syscall, which would route stdin into it`);
  const kernelSrc = fs.readFileSync(path.join(ROOT, "packages/kernel-host/kernel.js"), "utf8");
  ok(/opcode === OP_READ_STDIN/.test(kernelSrc) && /handleReadStdin/.test(kernelSrc), "the kernel dispatches it");
  ok(/proc\.syncStdin/.test(kernelSrc) && /stdinQueue/.test(kernelSrc),
    "…and buffers a synchronous reader's stdin, so a line typed between two reads is not delivered to a stream nobody reads");
  const handlerBody = kernelSrc.slice(kernelSrc.indexOf("handleReadStdin(proc) {"), kernelSrc.indexOf("sendStdin(pid, chunk)"));
  ok(/if \(proc\.capture\)/.test(handlerBody),
    "…and answers end-of-input to a process nobody can type at, rather than parking it forever");
  // The REPL reads through the same door, which is the whole reason it changed:
  // two readers of one stdin in one process is two readers too many.
  const lines = [];
  const chunks = ["print(", "1 +", " 1)\nx = 2\r\n", "input()\n", "half"];
  const read = makeLineReader(() => (chunks.length ? chunks.shift() : null));
  for (let i = 0; i < 5; i++) lines.push(read());
  ok(lines[0] === "print(1 + 1)", `a line spread over three reads is assembled (${JSON.stringify(lines[0])})`);
  ok(lines[1] === "x = 2", "…a CRLF line loses its carriage return, which a Python parser would choke on");
  ok(lines[2] === "input()", "…and a chunk holding a whole line does not wait for another read");
  ok(lines[3] === "half", "text typed without a newline before Ctrl-D is still a line, as it is in CPython");
  ok(lines[4] === null, "…and then the session ends");
  ok(makeLineReader(() => null)() === null, "a stdin that is closed from the start ends immediately");

  const pySrc = fs.readFileSync(path.join(ROOT, "packages/runtime/builtins/python.js"), "utf8");
  const replBody = pySrc.slice(pySrc.indexOf("function repl(indexUrl)"), pySrc.indexOf("web server bridge"));
  ok(/makeLineReader\(\)/.test(replBody), "the REPL takes its lines from the blocking reader");
  // Comments stripped, or this matches the comment explaining the change.
  const replCode = replBody.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  ok(!/stdin\.on\(/.test(replCode) && !/process\.stdin/.test(replCode),
    "…and no longer listens to the flowing stream, which input() would have taken from under it");

  const runtimeSrc = fs.readFileSync(path.join(ROOT, "packages/runtime/index.js"), "utf8");
  ok(/__ocReadStdin/.test(runtimeSrc), "the runtime exposes it to the guest");
  ok(!/process\.stdin[\s\S]{0,200}readStdin/.test(runtimeSrc),
    "…and does NOT wire it into process.stdin, which would let a Node program park its own event loop");
}

console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: all offline Python checks passed");
process.exit(failed ? 1 : 0);