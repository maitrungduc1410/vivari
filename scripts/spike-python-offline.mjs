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
// bridge dispatch source (the ASGI root_path regression in particular), and
// that the shipped templates are internally consistent with the shims they
// invoke. All against the SHIPPED sources, never a copy.
//
// WHAT IT DOES NOT PROVE: that any of it runs. Nothing here boots an
// interpreter. spike-python-bridge.mjs does that, on the network tier.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PYTHON_PROGRAM } from "../packages/kernel-host/programs/python.js";
import { COREUTILS } from "../packages/kernel-host/coreutils.js";
import { byteWriter, setupSource, terminationFromError } from "../packages/runtime/builtins/python.js";
import { readShippedManifests, readShippedTemplates, readTemplatesSource } from "./lib/python-templates.mjs";
import { CPYTHON_EXITS, UNTRUNCATED, realCPythonExit } from "./lib/cpython-exit.mjs";
import { drivePython, servedApp } from "./lib/python-drive.mjs";

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

  // The rule master codified: an unknown verb says not-implemented and names it.
  r = run("-m", "nosuchmod");
  ok(r.code === 1 && /nosuchmod/.test(r.err) && /not supported/.test(r.err), "python -m <unknown> is not-implemented and names the module");
  ok(/"pip".*"uvicorn".*"flask".*"gunicorn".*"pytest"/.test(r.err), "…and lists the modules that do work");

  r = run("-m", "pip", "download", "flask");
  ok(r.code === 1 && /only the "install" subcommand/.test(r.err), "python -m pip <other> names the one subcommand it has");

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
  const files = readShippedTemplates(source);
  const manifests = readShippedManifests(source);
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

console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: all offline Python checks passed");
process.exit(failed ? 1 : 0);