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
  URLLIB3_REALM_PATCH,
  byteWriter,
  setExecutable,
  setupSource,
  terminationFromError,
} from "../packages/runtime/builtins/python.js";
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
} from "../packages/runtime/builtins/python-store.js";
import { CAPTURED, FIXTURE_DISTS, realPipFormat, realPipUnknown, writeFixtureSite } from "./lib/real-pip.mjs";
import { writeFakeIndex } from "./lib/fake-pyodide.mjs";
import { readShippedManifests, readShippedTemplates, readTemplatesSource } from "./lib/shipped-templates.mjs";
import { MODELLED_FRAGMENTS, STANDIN, normalize } from "./lib/urllib3-emscripten.mjs";
import { CPYTHON_EXITS, UNTRUNCATED, realCPythonExit } from "./lib/cpython-exit.mjs";
import { drivePython, driveShim, servedApp } from "./lib/python-drive.mjs";
import { fsDirective, get, hostRead, mirrorRuntime, scratchPort } from "./lib/python-mirror-drive.mjs";

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
    for (const line of m[1].split("\n")) {
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
  const seams = ["pip", "venv", "uvicorn", "flask", "gunicorn", "pytest", "http.server"];
  ok(!seams.some((s) => SOCKET_MODULES.includes(s)), "no module is both intercepted and refused");
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

console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: all offline Python checks passed");
process.exit(failed ? 1 : 0);