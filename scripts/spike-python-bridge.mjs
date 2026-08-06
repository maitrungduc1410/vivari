// Spike for Python support: the WSGI/ASGI bridge and the seven Python templates
// added alongside it, driven against REAL Pyodide (CPython/WASM).
//
//   node scripts/spike-python-bridge.mjs            # all cases
//   node scripts/spike-python-bridge.mjs django     # one case
//
// WHY THIS IS KERNEL-FREE. Every other template spike boots the real kernel, and
// this one cannot: bootPyodide() does `import(indexUrl + "pyodide.mjs")`, and
// under the repo's pinned Node there is no way to reach the vendored bundle —
// `import('http://…')` is ERR_UNSUPPORTED_ESM_URL_SCHEME (network imports were
// removed in Node 22), and a file:// indexURL imports fine but then makes Pyodide
// fetch() its wasm and wheels, which fails for file URLs because the boot masks
// the environment to the browser path on purpose (see the comment at the top of
// packages/runtime/builtins/python.js). So this is modelled on
// spike-bun-offline.mjs: prove the pieces that CAN be proven headlessly, and be
// explicit about the rest.
//
// WHAT IT PROVES: Python-level semantics of all seven templates, the bridge's
// WSGI/ASGI protocol conversion, preview-prefix URL generation, the argv seams,
// against real urllib3 that Python's outbound HTTP works once our own Node
// masquerade stops answering urllib3's realm question for it, and — across
// several real interpreters in one run — that the .venv package store survives
// the process that filled it. It drives the
// SHIPPED dispatch source and the SHIPPED patch source (both exported from the
// runtime) against the SHIPPED template files (read out of templates.ts), so
// none of them can drift away from what is tested here.
//
// WHAT IT DOES NOT PROVE: guest port registration, preview-tab opening, the
// service-worker tunnel, same-origin wheel delivery from public/vendor/pyodide,
// terminal rendering, or mirrorBack surfacing files in the editor. Those need a
// browser. All seven templates stay `experimental` until someone runs that pass.
// The urllib3 case is in the same position on one point, stated where it is
// simulated: that a real browser Worker's synchronous XMLHttpRequest behaves as
// the spec says. If it does not, the fix is inert rather than harmful — the
// realm predicate only ever moves urllib3 onto a door it already prefers.
//
// Needs network on a cold run: Django and Flask come from PyPI via micropip, and
// pytest from the Pyodide CDN. Tiered `net: true` in run-spikes.mjs.

import { execSync } from "node:child_process";
import { fork, spawnSync } from "node:child_process";
import { MessageChannel, Worker } from "node:worker_threads";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PYTHON_PROGRAM } from "../packages/kernel-host/programs/python.js";
import { COREUTILS } from "../packages/kernel-host/coreutils.js";
import { LINT_DEBOUNCE_MS, LSP_DRIVER_SOURCE, hostPathFor, ruffMarkersFrom } from "../packages/runtime/builtins/python-lsp.js";
import { RUFF_PROGRAM } from "../packages/kernel-host/programs/ruff.js";
import { parseEntryPoints, RESERVED_COMMANDS } from "../packages/runtime/builtins/python-store.js";
import { driveRuffReal } from "./lib/python-drive.mjs";
import { askHost, blackCli, ensureOracle, ensureRuffOracle, lockVersion, mypyCli, oracleVersions, ruffCheckCli, ruffFormatCli, vendoredPyPIPins } from "./lib/python-lsp-oracle.mjs";
import {
  PYODIDE_PYTHON_VERSION,
  PYTHON_EXECUTABLE,
  STATIC_SERVER_SOURCE,
  byteWriter,
  dataPackagesFor,
  installBlockingPatch,
  installMatplotlibShow,
  installStdin,
  installUrllib3RealmPatch,
  flushStreams,
  setupSource,
  terminationFromError,
} from "../packages/runtime/builtins/python.js";
import {
  DIST_QUERY,
  collectDelta,
  formatPipCheck,
  formatPipFreeze,
  formatPipList,
  formatPipShow,
  humanBytes,
  persistDelta,
  pyEnv,
  restoreStore,
  storeDists,
  storePaths,
  uninstallSource,
  walkHost,
  walkPyodide,
} from "../packages/runtime/builtins/python-store.js";
import { readShippedTemplates, readTemplatesSource } from "./lib/shipped-templates.mjs";
import { CPYTHON_EXITS, UNTRUNCATED } from "./lib/cpython-exit.mjs";
import { MODELLED_FRAGMENTS, normalize } from "./lib/urllib3-emscripten.mjs";
import { loaderLines } from "./lib/fake-pyodide.mjs";
import { DRIVE_ENV, drivePython } from "./lib/python-drive.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Same scratch dir scripts/vendor-pyodide.mjs uses, so a prior vendor run is reused.
const SCRATCH = process.env.VV_VENDOR_PYODIDE_DIR || "/tmp/vv-vendor-pyodide";
const PYODIDE_ENTRY = path.join(SCRATCH, "node_modules/pyodide/pyodide.mjs");
const PREFIX = "/preview/8000";

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  \u2713 " : "  \u2717 ") + msg);
  if (!cond) failed++;
};

/**
 * What a snapshot-sized file costs to move between two processes, through the
 * stack that will actually move it: the real kernel, the Wasm VFS in its own
 * worker, and two real process workers on their own SAB channels. The browser
 * differs in what a Worker is, not in what happens between them.
 *
 * This is here rather than assumed because the interpreter cache is only worth
 * having if reading it back is much cheaper than booting CPython, and nothing
 * else in this repo would notice if the filesystem got slow on large files.
 */
async function measureVfsRoundTrip(bytes) {
  const { Kernel } = await import("../packages/kernel-host/kernel.js");
  const { createKernelFs } = await import("../packages/kernel-host/kernel-fs.js");
  const here = new URL("./", import.meta.url);
  const fsWorker = new Worker(new URL("fs-worker.mjs", here));
  let onKernelFsMessage = () => {};
  await new Promise((resolve) => {
    fsWorker.on("message", (m) => { if (m.type === "ready") resolve(); else onKernelFsMessage(m); });
  });
  const kernelFs = createKernelFs(fsWorker);
  onKernelFsMessage = kernelFs.onMessage;
  const spawnWorker = (info) => {
    const worker = new Worker(new URL("process-worker.mjs", here));
    worker.on("message", (m) => { const h = info.on[m.type]; if (h) h(m); });
    const { port1, port2 } = new MessageChannel();
    fsWorker.postMessage({ type: "fs-register", client: info.pid, sab: info.sab, port: port2 }, [port2]);
    worker.postMessage({ type: "init", sab: info.sab, spec: info.spec, fsPort: port1 }, [port1]);
    return {
      terminate: () => { worker.terminate(); fsWorker.postMessage({ type: "fs-unregister", client: info.pid }); },
      postMessage: (m) => worker.postMessage(m),
    };
  };
  const kernel = new Kernel({
    fs: kernelFs.fs,
    spawnWorker,
    fetcher: async () => ({ ok: false, status: 404, headers: {}, body: new Uint8Array() }),
  });
  kernel.installCoreutils();
  kernel.mkdirp("/t");
  // Two separate programs, so the write and the read are two processes that
  // share nothing but the filesystem — which is the situation being measured.
  kernel.writeFile("/t/w.js", `
const fs = require('fs');
const n = ${bytes};
const buf = Buffer.alloc(n);
for (let i = 0; i < n; i += 997) buf[i] = (i * 7) & 255;
fs.mkdirSync('/var/cache/vv-python', { recursive: true });
let t = Date.now();
fs.writeFileSync('/var/cache/vv-python/interpreter.snapshot', buf);
console.log(JSON.stringify({ ms: Date.now() - t }));
`);
  kernel.writeFile("/t/r.js", `
const fs = require('fs');
let t = Date.now();
const b = fs.readFileSync('/var/cache/vv-python/interpreter.snapshot');
const ms = Date.now() - t;
let same = b.length === ${bytes};
for (let i = 0; same && i < b.length; i += 997) same = b[i] === ((i * 7) & 255);
console.log(JSON.stringify({ ms, bytes: b.length, same }));
`);
  const parse = (r) => JSON.parse((r.stdout || "").trim().split("\n").pop() || "{}");
  const w = parse(await kernel.start("node", ["/t/w.js"], { cwd: "/t", capture: true }));
  const r = parse(await kernel.start("node", ["/t/r.js"], { cwd: "/t", capture: true }));
  await fsWorker.terminate();
  return { write: w.ms ?? -1, read: r.ms ?? -1, bytes: r.bytes, same: !!r.same };
}

// ---------------------------------------------------------------------------
// Cases. `kind` picks the driver in the child process.
// ---------------------------------------------------------------------------
const CASES = {
  "python-sqlite": {
    kind: "script", entry: "main.py",
    stdout: [/Books per author/, /Le Guin\s+2 book\(s\), earliest 1968/, /Ada\s+A Wizard of Earthsea/, /3 of 5 books were published before 1970/],
    wrote: ["library.db"],
  },
  "python-orm": {
    kind: "script", entry: "main.py",
    stdout: [/Books per author/, /Ursula K\. Le Guin\s+3 book\(s\), earliest 1968/, /1968\s+A Wizard of Earthsea/, /Renamed: Kindred \(1979\)/, /2 of 5 books were published before 1970/],
    wrote: ["library.db"],
  },
  "python-rich": {
    kind: "script", entry: "main.py",
    // The point of this template is that a terminal renders what rich emits, so
    // the escape sequences are part of what is under test: text alone would pass
    // just as well with colour silently switched off.
    stdout: [/Vendored Python packages/, /sqlalchemy/, /\u001b\[/, /fib/, /crunching/, /done/],
    // rich's own lock entry declares NO dependencies, and it imports these two
    // lazily — so on a stock Pyodide `from rich.syntax import Syntax` raises
    // ModuleNotFoundError. That is the bug DEPENDS_FIXUPS exists to fix for the
    // shipped distribution, and this line is what reproduces the unfixed state
    // here. markdown-it-py is not in Pyodide's index at all, so it arrives via
    // micropip in this tier and as a vendored PyPI wheel in the real one.
    packages: ["rich", "pygments", "markdown-it-py"],
  },
  "python-imaging": {
    kind: "script", entry: "main.py",
    stdout: [/Wrote art\.png \(640x360\)/, /Wrote thumb\.png \(160x90\)/],
    wrote: ["art.png", "thumb.png"], png: ["art.png", "thumb.png"],
  },
  // mypy and black as commands. Not template-driven: what is under test is the
  // launcher's two checker paths (a seam for one, plain runpy for the other)
  // against the same tools on this machine.
  checkers: { kind: "checkers", synthetic: true },
  // The editor half of the same tools: markers, positioned against real mypy.
  diagnostics: { kind: "diagnostics", synthetic: true },
  // Which HTTP clients can work without sockets, and which cannot.
  "http-clients": { kind: "http-clients", synthetic: true },
  // A pip-installed package's own command, read off real wheel metadata.
  "console-scripts": { kind: "console-scripts", synthetic: true },
  // ruff: the vendored wasm held to the real ruff CLI at the same version.
  ruff: { kind: "ruff", synthetic: true },
  // plt.show(), asyncio.run(), input() and ZoneInfo, under a real interpreter.
  "day-one": { kind: "day-one", synthetic: true },
  // The interpreter snapshot: made in one realm, restored in two others.
  snapshot: { kind: "snapshot", synthetic: true },
  // The bytecode a run compiles, kept and put back into a later interpreter.
  bytecode: { kind: "bytecode", synthetic: true },
  // Breakpoints, stepping and variables in a .py file, over real CDP.
  "python-debug": { kind: "debug", synthetic: true },
  // Ctrl-C reaching an interpreter whose thread is not running any JS.
  "python-interrupt": { kind: "interrupt", synthetic: true },
  // input(), pdb and a REPL prompt, on a stdin that waits.
  stdin: { kind: "stdin", synthetic: true },
  "python-pytest": {
    kind: "pytest", args: ["-q"], exit: 0, stdout: [/11 passed/],
    // A deliberately broken suite must come back non-zero, or `pytest && deploy`
    // would be a lie.
    alsoFailing: { file: "tests/test_broken.py", source: "def test_broken():\n    assert 1 == 2\n", exit: 1 },
  },
  "flask-app": {
    kind: "web", mode: "wsgi", app: "main:app", packages: ["flask"],
    requests: [
      { path: "/", expect: 200, body: [/Tasks/, /Read the Flask template/, `href="${PREFIX}/static/app.css"`, `action="${PREFIX}/tasks"`] },
      { path: "/static/app.css", expect: 200, body: [/--accent/] },
      { path: "/api/tasks", expect: 200, body: [/"title":"Add a task below"/] },
      { path: "/api/tasks", method: "POST", json: { title: "from the spike" }, expect: 201 },
      { path: "/api/tasks", expect: 200, body: [/from the spike/] },
      { path: "/tasks", method: "POST", form: "title=via+a+form", expect: 302, header: ["location", `${PREFIX}/`] },
      { path: "/api/tasks", expect: 200, body: [/via a form/] },
      { path: "/api/tasks", method: "POST", json: {}, expect: 400 },
    ],
  },
  django: {
    kind: "web", mode: "wsgi", app: "wsgi:application", packages: ["django>=5.0,<6.0", "tzdata"],
    requests: [
      { path: "/", expect: 200, body: [/Welcome to Django on Pyodide/, `href="${PREFIX}/notes/1/"`, `action="${PREFIX}/notes/create/"`] },
      { path: "/notes/1/", expect: 200, body: [/Welcome to Django on Pyodide/, /Pinned/] },
      { path: "/notes/999/", expect: 404 },
      { path: "/api/notes/", expect: 200, body: [/"count": 2/] },
      { path: "/notes/create/", method: "POST", form: "title=Written+by+the+spike&body=x", expect: 302 },
      { path: "/api/notes/", expect: 200, body: [/"count": 3/, /Written by the spike/] },
      { path: "/notes/2/pin/", method: "POST", form: "", expect: 302 },
      { path: "/api/notes/", expect: 200, body: [/"id": 2, "title": "Add a note below", "body": "[^"]*", "pinned": true/] },
    ],
  },
  "fastapi-crud": {
    kind: "web", mode: "asgi", app: "main:app", packages: ["fastapi"],
    requests: [
      { path: "/", expect: 200, body: [/Notes API/] },
      { path: "/notes", expect: 200, body: [/Welcome/] },
      { path: "/notes", method: "POST", json: { title: "spike note", body: "b" }, expect: 201, body: [/"id":2/, /spike note/] },
      { path: "/notes/2", expect: 200, body: [/spike note/] },
      { path: "/notes/2", method: "PUT", json: { title: "renamed", body: "" }, expect: 200, body: [/renamed/] },
      { path: "/notes/2", method: "DELETE", expect: 204 },
      { path: "/notes/2", expect: 404 },
      { path: "/notes", method: "POST", json: { title: "" }, expect: 422 },
      // A sync `def` endpoint — the regression guard for the anyio threadpool patch.
      { path: "/health", expect: 200, body: [/"status":"ok"/] },
      { path: "/docs", expect: 200, body: [/swagger-ui/] },
      { path: "/openapi.json", expect: 200, body: [/"\/notes\/\{note_id\}"/] },
    ],
  },
  "fastapi-dashboard": {
    kind: "web", mode: "asgi", app: "main:app", packages: ["fastapi", "matplotlib", "pandas"],
    requests: [
      { path: "/", expect: 200, body: [/Sales dashboard/, /Best region so far/, /src="chart\.png"/] },
      { path: "/chart.png", expect: 200, png: true },
      { path: "/api/summary", expect: 200, body: [/"total_units":2191/, /"best_month":"May"/] },
      // StaticFiles is a Mount: this is the regression guard for the ASGI
      // root_path fix. It 404s if scope["path"] ever loses its prefix again.
      { path: "/static/app.css", expect: 200, body: [/tabular-nums/] },
    ],
  },
  // Same app, same request, three scope shapes — the direct proof of the fix,
  // plus the scope checked against the ASGI spec and Starlette's own reader.
  "asgi-root-path": { kind: "asgi-root-path", synthetic: true },
  // The WSGI half, checked against CPython's own PEP 3333 validator.
  "wsgi-environ": { kind: "wsgi-environ", synthetic: true },
  // Python's HTTP, and the Node masquerade that was switching it off.
  "urllib3-realm": { kind: "urllib3-realm", synthetic: true },

  // Where loadPackage writes when you do and do not hand it a callback, which
  // is what the offline stdout gate models — plus the version literal.
  "loader-streams": { kind: "loader-streams", synthetic: true },

  // `python -m <module>` through CPython's own runpy: unittest discovering and
  // running tests off the mirrored VFS, and the error a missing module gets.
  "m-surface": { kind: "m-surface", synthetic: true },
  // `python -m http.server` driven off the shipped handler source, and the
  // socket evidence that says why it cannot be the real HTTPServer.
  "http-server": { kind: "http-server", synthetic: true },
  // What a served app writes, including a SQLite database, reaching the host —
  // and the FS tracking hooks the offline mirror gate is built on.
  "serve-persist": { kind: "serve-persist", synthetic: true },

  // jedi and black on a real interpreter, judged against the SAME driver run
  // under the CPython on this host.
  "language-service": { kind: "language-service", synthetic: true },

  "package-store": { kind: "package-store", synthetic: true },
  // sys.exit() raised for real, judged against what real CPython does.
  "termination": { kind: "termination", synthetic: true },
};

// ---------------------------------------------------------------------------
// Child process: one case = one fresh Pyodide boot, matching the real model
// (one interpreter per `python` process). Reusing one interpreter across
// templates makes sys.modules cache an earlier template's `main`, which produces
// bogus failures.
// ---------------------------------------------------------------------------
if (process.env.VV_SPIKE_CASE) {
  const name = process.env.VV_SPIKE_CASE;
  const spec = CASES[name];
  const templates = await readShippedTemplates(readTemplatesSource());
  // Pyodide's WebLoop re-raises SystemExit as a second, unhandled rejection
  // alongside the one runPythonAsync() already rejects with. Node aborts on
  // those; a browser only logs them.
  process.on("unhandledRejection", (e) => { if (e?.type !== "SystemExit") throw e; });

  const { loadPyodide } = await import(PYODIDE_ENTRY);
  const py = await loadPyodide();
  const out = [];
  // Render through the SHIPPED writer, not a batched handler of our own. The
  // batched handler is what produced the one-dot-per-line bug, and a spike
  // using one could never have seen it: it hands over newline-stripped chunks,
  // so any joiner here invents the line breaks the terminal would show.
  const sink = () => ({ write: (b) => out.push(b.toString("utf8")) });
  py.setStdout(byteWriter(sink()));
  py.setStderr(byteWriter(sink()));

  const DIR = "/project";
  const mirrorIn = (files) => {
    py.FS.mkdirTree(DIR);
    for (const [rel, body] of Object.entries(files)) {
      const full = DIR + "/" + rel;
      const slash = full.lastIndexOf("/");
      if (slash > 0) py.FS.mkdirTree(full.slice(0, slash));
      py.FS.writeFile(full, new TextEncoder().encode(body));
    }
    py.FS.chdir(DIR);
    py.runPython(`import sys\nif ${JSON.stringify(DIR)} not in sys.path: sys.path.insert(0, ${JSON.stringify(DIR)})`);
  };
  const ensure = async (names) => {
    if (!names?.length) return;
    try { await py.loadPackage(names, { messageCallback: () => {} }); return; } catch { /* not all are in the lock */ }
    await py.loadPackage("micropip", { messageCallback: () => {} });
    await py.pyimport("micropip").install(names);
  };
  const dump = () => { if (out.length) console.log(out.join("").split("\n").slice(-25).map((l) => "      | " + l).join("\n")); };

  // --- terminal templates ---------------------------------------------------
  if (spec.kind === "script" || spec.kind === "pytest") {
    mirrorIn(templates[name]);
    // Packages the template needs that loadPackagesFromImports cannot find on
    // its own — because the lock this tier runs against under-declares them.
    // The studio's lock does not: scripts/vendor-pyodide.mjs patches the same
    // names in, and the offline tier checks that these two lists agree.
    await ensure(spec.packages || []);
    const runSource = async (source, filename) => {
      out.length = 0;
      await py.loadPackagesFromImports(source, { messageCallback: () => {} });
      try { await py.runPythonAsync(source, { filename }); flushStreams(py); return { code: 0, report: "" }; }
      catch (e) { flushStreams(py); return terminationFromError(e); }
    };
    const pytestSource = (args) =>
      `import sys\nimport pytest\nsys.exit(int(pytest.main(${JSON.stringify(args)})))\n`;

    const source = spec.kind === "pytest"
      ? pytestSource(spec.args)
      : templates[name][spec.entry];
    const r = await runSource(source, spec.entry || "<string>");
    ok(r.code === (spec.exit ?? 0), `${name}: exit ${r.code}`);
    ok(r.report === "", `${name}: no spurious traceback on a clean exit`);
    const text = out.join("");
    for (const re of spec.stdout) ok(re.test(text), `${name}: stdout matches ${re}`);

    if (spec.kind === "pytest") {
      // The shape is real pytest's, not ours. Captured from CPython 3.11.2 with
      // pytest 9.0.2 on the same 11-test suite, piped so stdout is not a tty:
      //
      //   $ python3 -m pytest -q tests | cat -A
      //   ...........<spaces>[100%]$
      //   11 passed in 0.01s$
      //
      // One line of dots, then the summary. We shipped a template that rendered
      // that as eleven lines, because the runtime appended a newline to every
      // flush and pytest flushes after each dot.
      ok(/^\.{11} *\[100%\]\n/m.test(text),
        "pytest's progress dots render on ONE line, the way real pytest pipes them");
      ok(!/^\.\n\./m.test(text), "…and not one dot per line, which is the bug a user reported");
      ok(/\n11 passed in [\d.]+s\n?$/.test(text), "…with the summary on its own line after them");
    }
    if (failed) dump();
    for (const f of spec.wrote || []) {
      let size = -1;
      try { size = py.FS.stat(DIR + "/" + f).size; } catch { /* not written */ }
      ok(size > 0, `${name}: wrote ${f} (${size} bytes)`);
    }
    for (const f of spec.png || []) {
      const b = Buffer.from(py.FS.readFile(DIR + "/" + f));
      ok(b.subarray(0, 4).toString("latin1") === "\x89PNG", `${name}: ${f} is a real PNG`);
    }
    if (spec.alsoFailing) {
      py.FS.writeFile(DIR + "/" + spec.alsoFailing.file, new TextEncoder().encode(spec.alsoFailing.source));
      const bad = await runSource(pytestSource(spec.args), "<string>");
      ok(bad.code === spec.alsoFailing.exit, `${name}: a failing suite exits ${bad.code} (want ${spec.alsoFailing.exit})`);
    }
  }

  // --- web templates --------------------------------------------------------
  if (spec.kind === "web") {
    mirrorIn(templates[name]);
    await ensure(spec.packages);
    const [mod, attr] = spec.app.split(":");
    try {
      await py.runPythonAsync(setupSource(mod, attr, spec.mode));
    } catch (e) {
      ok(false, `${name}: import ${spec.app}`);
      console.log(String(e.message || e).split("\n").slice(-16).map((l) => "      | " + l).join("\n"));
      process.exit(1);
    }
    ok(true, `${name}: imported ${spec.app}`);
    const dispatch = py.globals.get("_vv_dispatch");

    for (const r of spec.requests) {
      const headers = [["host", "localhost"], ["x-forwarded-prefix", PREFIX]];
      let bodyB64 = "";
      if (r.json !== undefined) {
        const s = JSON.stringify(r.json);
        headers.push(["content-type", "application/json"], ["content-length", String(Buffer.byteLength(s))]);
        bodyB64 = Buffer.from(s).toString("base64");
      } else if (r.form !== undefined) {
        headers.push(["content-type", "application/x-www-form-urlencoded"], ["content-length", String(Buffer.byteLength(r.form))]);
        bodyB64 = Buffer.from(r.form).toString("base64");
      }
      const reqJson = JSON.stringify({
        method: r.method || "GET", path: r.path, query: "", headers,
        http_version: "1.1", root_path: PREFIX, body_b64: bodyB64,
      });
      let res;
      try {
        res = JSON.parse(spec.mode === "asgi" ? await dispatch(reqJson) : dispatch(reqJson));
      } catch (e) {
        ok(false, `${name}: ${r.method || "GET"} ${r.path} threw ${String(e.message || e).split("\n").slice(-2).join(" | ")}`);
        continue;
      }
      const raw = Buffer.from(res.body_b64 || "", "base64");
      const text = raw.toString("utf8");
      const label = `${name}: ${(r.method || "GET").padEnd(6)} ${r.path}`;
      const statusOk = res.status === r.expect;
      ok(statusOk, `${label} -> ${res.status}`);
      if (!statusOk) { console.log("      | " + text.replace(/\s+/g, " ").slice(0, 300)); continue; }
      for (const m of r.body || []) {
        const hit = typeof m === "string" ? text.includes(m) : m.test(text);
        ok(hit, `${label} body has ${typeof m === "string" ? JSON.stringify(m) : m}`);
        if (!hit) console.log("      | " + text.replace(/\s+/g, " ").slice(0, 300));
      }
      if (r.png) ok(raw.subarray(0, 4).toString("latin1") === "\x89PNG", `${label} returns a real PNG (${raw.length} bytes)`);
      if (r.header) {
        const got = (res.headers || []).find(([k]) => k.toLowerCase() === r.header[0]);
        ok(got?.[1] === r.header[1], `${label} ${r.header[0]}: ${got?.[1]}`);
      }
    }

    if (name === "django") {
      // The template's settings.py sets DJANGO_ALLOW_ASYNC_UNSAFE. Get that
      // name even slightly wrong and the file still imports, still reads
      // correctly in review, and simply does nothing — the failure would
      // surface as an async-context error in someone's browser. So check the
      // spelling where Django itself reads it, not against our own settings.
      const readsIt = py.runPython([
        "import inspect, django.utils.asyncio",
        "'DJANGO_ALLOW_ASYNC_UNSAFE' in inspect.getsource(django.utils.asyncio)",
      ].join("\n"));
      ok(readsIt === true, "Django's own source reads DJANGO_ALLOW_ASYNC_UNSAFE — the exact name settings.py sets");
    }
  }

  // --- the ASGI root_path fix, proven directly ------------------------------
  if (spec.kind === "asgi-root-path") {
    mirrorIn(templates["fastapi-dashboard"]);
    await ensure(["fastapi", "matplotlib", "pandas"]);
    const shipped = setupSource("main", "app", "asgi");
    // Reconstruct the pre-fix scope shape from the shipped source, so this test
    // cannot pass by accident if the line it guards is edited.
    const OLD = '_vv_path = _vv_root + d["path"] if _vv_root else d["path"]';
    ok(shipped.includes(OLD), "the shipped ASGI source still builds path from root_path");
    const before = shipped.replace(OLD, '_vv_path = d["path"]');
    ok(before !== shipped, "produced a pre-fix variant to compare against");

    const call = async (source, prefix) => {
      await py.runPythonAsync(source);
      const d = py.globals.get("_vv_dispatch");
      const res = JSON.parse(await d(JSON.stringify({
        method: "GET", path: "/static/app.css", query: "",
        headers: [["host", "localhost"]], http_version: "1.1",
        root_path: prefix, body_b64: "",
      })));
      return res.status;
    };
    ok(await call(before, PREFIX) === 404, "pre-fix scope: StaticFiles mount 404s behind the preview prefix");
    ok(await call(shipped, PREFIX) === 200, "shipped scope: the same request is 200");
    // Preview mode C serves at the origin root and sends no prefix header, so
    // the fix has to be a no-op there.
    ok(await call(shipped, "") === 200, "shipped scope with no prefix (preview mode C): still 200");

    // A 200 only says Starlette was satisfied by the whole request; it does not
    // say the scope matches the ASGI spec, and a status code is a coarse oracle
    // for a spec-conformance bug. So capture the scope the shipped dispatch
    // actually builds and check it against the rule itself — "path" INCLUDES
    // "root_path" — and against starlette.routing.get_route_path, which is a
    // published implementation of that subtraction written by someone else.
    py.FS.writeFile(DIR + "/scopeprobe.py", new TextEncoder().encode(
      "CAPTURED = {}\n" +
      "async def app(scope, receive, send):\n" +
      "    CAPTURED.clear()\n" +
      "    CAPTURED.update(scope)\n" +
      "    await send({'type': 'http.response.start', 'status': 200, 'headers': []})\n" +
      "    await send({'type': 'http.response.body', 'body': b'ok'})\n",
    ));
    const probeSrc = setupSource("scopeprobe", "app", "asgi");
    const captured = async (source, prefix) => {
      await py.runPythonAsync(source);
      const dispatch = py.globals.get("_vv_dispatch");
      await dispatch(JSON.stringify({
        method: "GET", path: "/static/app.css", query: "",
        headers: [["host", "localhost"]], http_version: "1.1",
        root_path: prefix, body_b64: "",
      }));
      // Read the scope with Starlette's own machinery: get_route_path() at the
      // top level, and again on the child scope a real Mount() derives from it.
      // The second is where the bug actually bit — top-level get_route_path is
      // guarded (it only strips when path starts with root_path, so a stripped
      // path passes through unharmed), but Mount.matches extends root_path to
      // root_path + "/static" for the sub-app, and THAT subtraction is the one
      // a pre-stripped path cannot survive.
      return JSON.parse(py.runPython([
        "import json, scopeprobe",
        "from starlette.routing import Mount, get_route_path",
        "from starlette.staticfiles import StaticFiles",
        "_s = dict(scopeprobe.CAPTURED)",
        "_mount = Mount('/static', StaticFiles(directory='static'), name='static')",
        "_match, _child = _mount.matches(_s)",
        "_sub = dict(_s); _sub.update(_child)",
        "json.dumps({'path': _s['path'], 'root_path': _s['root_path'],",
        "            'raw_path': _s['raw_path'].decode('utf-8'),",
        "            'route_path': get_route_path(_s),",
        "            'matched': str(_match),",
        "            'sub_root_path': _sub.get('root_path'),",
        "            'sub_route_path': get_route_path(_sub)})",
      ].join("\n")));
    };

    let s = await captured(probeSrc, PREFIX);
    ok(s.root_path === PREFIX, `ASGI spec: root_path is the mount prefix (${JSON.stringify(s.root_path)})`);
    ok(s.path === PREFIX + "/static/app.css", `ASGI spec: path INCLUDES root_path (${JSON.stringify(s.path)})`);
    ok(s.raw_path === s.path, "ASGI spec: raw_path names the same target as path");
    ok(s.route_path === "/static/app.css", `Starlette's get_route_path() recovers the app path (${JSON.stringify(s.route_path)})`);
    ok(s.sub_root_path === PREFIX + "/static", `Starlette's Mount extends root_path for the sub-app (${JSON.stringify(s.sub_root_path)})`);
    ok(s.sub_route_path === "/app.css", `…and inside the mount it resolves to the file (${JSON.stringify(s.sub_route_path)})`);

    const bad = await captured(probeSrc.replace(OLD, '_vv_path = d["path"]'), PREFIX);
    ok(bad.route_path === "/static/app.css", "pre-fix scope slips past top-level get_route_path (which is why this went unnoticed)");
    ok(bad.sub_route_path !== "/app.css", `…but the same outside reader rejects it inside the mount (${JSON.stringify(bad.sub_route_path)})`);

    s = await captured(probeSrc, "");
    ok(s.path === "/static/app.css" && s.root_path === "" && s.sub_route_path === "/app.css",
      "no prefix: path, root_path and the mount's route path all agree (mode C is untouched)");
  }

  // --- python -m, through CPython's own runpy -------------------------------
  if (spec.kind === "m-surface") {
    // The offline tier proves the shim ROUTES an arbitrary module to runpy. It
    // cannot prove the routing lands anywhere useful, because that depends on a
    // real interpreter with a real stdlib. This is that half.
    py.runPython(`import sys; sys.executable = ${JSON.stringify(PYTHON_EXECUTABLE)}`);

    // The source runModule() builds, so what runs here is the shipped shape.
    const runModule = async (mod, args) => {
      out.length = 0;
      const src = [
        "import runpy, sys",
        `sys.argv = ${JSON.stringify([mod, ...args])}`,
        `runpy._run_module_as_main(${JSON.stringify(mod)})`,
      ].join("\n");
      try {
        await py.runPythonAsync(src);
        flushStreams(py);
        return { code: 0, report: "", out: out.join("") };
      } catch (e) {
        flushStreams(py);
        const t = terminationFromError(e);
        return { ...t, out: out.join("") };
      }
    };

    // 1. unittest, discovering off the mirrored VFS. This is the headline: we
    //    ship pytest, so a repo that arrives with stdlib tests had no runner.
    mirrorIn({
      "tests/__init__.py": "",
      "tests/test_math.py":
        "import unittest\n" +
        "class T(unittest.TestCase):\n" +
        "    def test_ok(self): self.assertEqual(2 + 2, 4)\n" +
        "    def test_also_ok(self): self.assertIn('a', 'cat')\n",
      "test_toplevel.py":
        "import unittest\n" +
        "class Top(unittest.TestCase):\n" +
        "    def test_top(self): self.assertTrue(True)\n",
    });
    let r = await runModule("unittest", ["discover", "-v"]);
    ok(r.code === 0, `python -m unittest discover exits 0 when the tests pass (got ${r.code})`);
    ok(/Ran 3 tests/.test(r.out), "…having found all three: two in tests/ and one at the top level");
    ok(/test_ok \(tests\.test_math/.test(r.out), "…discovery reached the package under the mirrored tree");
    ok(/\nOK\b/.test(r.out), "…and reported OK");

    // 2. A failing test must FAIL. Without this the check above passes for a
    //    runner that discovers nothing and reports success.
    py.FS.writeFile(
      DIR + "/tests/test_bad.py",
      new TextEncoder().encode(
        "import unittest\n" +
        "class B(unittest.TestCase):\n" +
        "    def test_bad(self): self.assertEqual(1, 2)\n",
      ),
    );
    r = await runModule("unittest", ["discover"]);
    ok(r.code === 1, `a failing test makes python -m unittest exit 1 (got ${r.code})`);
    ok(/FAILED \(failures=1\)/.test(r.out), "…and says which and how many");
    py.FS.unlink(DIR + "/tests/test_bad.py");

    // 3. Other stdlib modules, to show this is a passthrough and not a second
    //    allowlist with unittest added to it.
    r = await runModule("base64", ["-e"]);
    ok(r.code === 0, "python -m base64 runs (an arbitrary stdlib module, no special case)");
    r = await runModule("calendar", ["2026", "8"]);
    ok(r.code === 0 && /August 2026/.test(r.out), "python -m calendar 2026 8 prints the month");

    // 4. The missing-module error. The whole reason for using runpy rather than
    //    resolving modules ourselves: this string is CPython's, formatted by
    //    CPython, prefixed with sys.executable.
    r = await runModule("definitely_not_a_module", []);
    ok(r.code === 1, `a missing module exits 1 (got ${r.code})`);
    ok(
      r.report === "python: No module named definitely_not_a_module",
      `…with CPython's own message: ${JSON.stringify(r.report)}`,
    );
    const host = execSync("python3 -m definitely_not_a_module 2>&1; true", { encoding: "utf8" }).trim();
    ok(
      host.replace(/^\S+:/, "python:") === r.report,
      `…identical to real CPython on this host, modulo sys.executable (${JSON.stringify(host)})`,
    );
    // A package with no __main__ is a DIFFERENT error, and also CPython's. Not
    // `json`: 3.14 gave it a __main__ (it is json.tool now), which is a neat
    // reminder that this list belongs to the stdlib and not to us — the only
    // safe thing to assert is that we relay whatever it says.
    r = await runModule("email", []);
    ok(
      r.code === 1 && /No module named email\.__main__; 'email' is a package and cannot be directly executed/.test(r.report),
      `…and a package without __main__ gets its own message: ${JSON.stringify(r.report)}`,
    );
    const hostPkg = execSync("python3 -m email 2>&1; true", { encoding: "utf8" }).trim();
    ok(
      hostPkg.replace(/^\S+:/, "python:") === r.report,
      `…which the CPython on this host words identically (${JSON.stringify(hostPkg)})`,
    );
  }

  // --- python -m http.server: the real handler, without a socket ------------
  if (spec.kind === "http-server") {
    // FIRST, the evidence for the design. Reimplementing a static server would
    // be wrong, but so would running the real HTTPServer: Pyodide HAS a socket
    // module, and it is worse than not having one.
    const sock = (expr) => {
      try { py.runPython(expr); return "ok"; }
      catch (e) { return String(e.message).trim().split("\n").filter(Boolean).pop(); }
    };
    ok(sock("import socket; socket.socket().bind(('', 8099))") === "ok",
      "a Pyodide socket BINDS without complaint — so http.server would report itself serving");
    ok(sock("import socket\ns = socket.socket()\ns.connect(('example.com', 80))") === "ok",
      "…and CONNECTS without complaint");
    const moved = py.runPython(`
import socket
s = socket.socket(); s.settimeout(0.5)
s.connect(('example.com', 80))
try:
    s.sendall(b'GET / HTTP/1.0\\r\\n\\r\\n')
    r = s.recv(16)
except Exception as e:
    r = type(e).__name__
str(r)
`);
    ok(/TimeoutError|timed out/.test(moved), `…and then carries no bytes (${moved}) — the failure is a hang, not an error`);

    // SECOND, the handler. Driven off STATIC_SERVER_SOURCE, the shipped string,
    // so the spike cannot pass against a copy that has drifted.
    py.runPython(STATIC_SERVER_SOURCE);
    const handle = py.globals.get("_vv_static");
    py.FS.mkdirTree("/site/sub");
    py.FS.writeFile("/site/hello.txt", new TextEncoder().encode("hello from the stdlib\n"));
    py.FS.writeFile("/site/data.json", new TextEncoder().encode('{"k": 1}'));
    py.FS.writeFile("/site/sub/deep.txt", new TextEncoder().encode("deep"));

    const req = (line) =>
      new Uint8Array(Buffer.from(`${line}\r\nHost: localhost:8000\r\nConnection: close\r\n\r\n`, "latin1"));
    const call = (line, root = "/site") => {
      const proxy = handle(req(line), root, 8000, "HTTP/1.0");
      const raw = Buffer.from(proxy.toJs());
      proxy.destroy();
      const i = raw.indexOf("\r\n\r\n");
      const head = raw.slice(0, i).toString("latin1");
      return {
        status: parseInt(head.split("\r\n")[0].split(" ")[1], 10),
        head,
        body: raw.slice(i + 4).toString("utf8"),
      };
    };

    let res = call("GET /hello.txt HTTP/1.1");
    ok(res.status === 200 && res.body === "hello from the stdlib\n", "a file is served, byte for byte");
    ok(/Content-type: text\/plain/i.test(res.head), "…with the stdlib's own mimetypes answer for .txt");
    ok(/Server: SimpleHTTP\//i.test(res.head), "…and its own Server header, because it IS SimpleHTTPRequestHandler");

    res = call("GET /data.json HTTP/1.1");
    ok(/Content-type: application\/json/i.test(res.head), "…and application/json for .json, which we never had to map");

    res = call("GET /sub/ HTTP/1.1");
    ok(res.status === 200 && /Directory listing for \/sub\//.test(res.body),
      "a directory gets the stdlib's real listing page");
    ok(/deep\.txt/.test(res.body), "…naming the files in it");

    res = call("GET /sub HTTP/1.1");
    ok(res.status === 301 && /Location: \/sub\//.test(res.head),
      "…and a directory without a trailing slash gets the real 301, not a 404");

    res = call("GET /nope.txt HTTP/1.1");
    ok(res.status === 404 && /File not found/.test(res.body), "a missing file gets the stdlib's real 404");

    res = call("HEAD /hello.txt HTTP/1.1");
    ok(res.status === 200 && res.body === "", "HEAD returns the headers and no body");

    // Serving a subdirectory must not serve its parent: -d is a boundary, not a
    // hint. Without this, --directory would be decoration.
    res = call("GET /hello.txt HTTP/1.1", "/site/sub");
    ok(res.status === 404, "-d scopes the root: a file outside it is 404, not served");
    res = call("GET /../hello.txt HTTP/1.1", "/site/sub");
    ok(res.status !== 200, "…and .. does not climb out of it");

    // One buffered request must yield exactly one response. BaseHTTPRequestHandler
    // loops until close_connection, so a keep-alive request against a stream
    // that kept producing bytes would answer twice into the same buffer and
    // hand Node a second response glued to the first.
    const keepalive = handle(
      new Uint8Array(Buffer.from("GET /hello.txt HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n", "latin1")),
      "/site",
      8000,
      "HTTP/1.1",
    );
    const kaText = Buffer.from(keepalive.toJs()).toString("latin1");
    keepalive.destroy();
    ok(
      (kaText.match(/^HTTP\/1\.[01] \d{3}/gm) || []).length === 1,
      "an explicit keep-alive request still produces exactly one response",
    );
  }

  // --- a served app's writes reach the host ---------------------------------
  if (spec.kind === "serve-persist") {
    // The offline tier gates the mirroring against a stand-in FS. That is only
    // worth something if REAL Pyodide reports writes the way the stand-in does,
    // so check the hooks here — this is the load-bearing claim underneath the
    // whole offline mirror gate.
    const writes = new Set();
    const deletes = new Set();
    py.FS.trackingDelegate.onWriteToFile = (p) => { writes.add(p); deletes.delete(p); };
    py.FS.trackingDelegate.onDeletePath = (p) => { writes.delete(p); deletes.add(p); };
    py.FS.trackingDelegate.onMovePath = (a, b) => { deletes.add(a); writes.add(b); };

    py.FS.mkdirTree("/w");
    await py.runPythonAsync(`
import os, shutil
open('/w/plain.txt','w').write('a')
shutil.copy('/w/plain.txt', '/w/copied.txt')
with open('/w/appended.txt','a') as f: f.write('b')
os.rename('/w/plain.txt', '/w/moved.txt')
os.remove('/w/copied.txt')
`);
    ok(writes.has("/w/appended.txt"), "real Pyodide reports a write through the tracking delegate");
    ok(writes.has("/w/moved.txt") && deletes.has("/w/plain.txt"), "…a rename as a delete plus a write");
    ok(deletes.has("/w/copied.txt"), "…and a delete");

    // The same-size rewrite: the case the old size heuristic dropped, and the
    // reason tracking is a correctness fix rather than a speed one.
    py.FS.writeFile("/w/same.txt", new TextEncoder().encode("aaaa"));
    const before = py.FS.stat("/w/same.txt");
    writes.clear();
    await py.runPythonAsync(`open('/w/same.txt','w').write('bbbb')`);
    const after = py.FS.stat("/w/same.txt");
    ok(before.size === after.size, "a same-size rewrite leaves the size identical — a size diff cannot see it");
    ok(writes.has("/w/same.txt"), "…and the tracking delegate reports it anyway");
    ok(new TextDecoder().decode(py.FS.readFile("/w/same.txt")) === "bbbb", "…the contents really did change");

    // sqlite3 is the case that made deletes non-optional: it writes a journal
    // beside the database and REMOVES it on commit. Mirroring the journal out
    // and never removing it leaves a hot journal next to a committed database.
    writes.clear();
    deletes.clear();
    await py.runPythonAsync(`
import sqlite3
con = sqlite3.connect('/w/app.db')
con.execute('create table t (v text)')
con.execute("insert into t values ('from a request')")
con.commit()
con.close()
`);
    ok(writes.has("/w/app.db"), "sqlite3's writes are reported too, though they happen in C");
    ok(deletes.has("/w/app.db-journal"), "…and the journal it removes on commit is reported as a delete");
    ok(!writes.has("/w/app.db-journal"), "…and is no longer pending as a write, so it will not be resurrected");

    // The database is real, and re-readable: the point is a file that survives.
    const rows = py.runPython(`
import sqlite3
con = sqlite3.connect('/w/app.db')
v = con.execute('select v from t').fetchall()
con.close()
str(v)
`);
    ok(/from a request/.test(rows), `the committed row is in the database (${rows})`);
    // Mid-transaction, the journal EXISTS — which is what makes copying both
    // files the recoverable choice and copying only the database the corrupt one.
    const mid = py.runPython(`
import os, sqlite3
con = sqlite3.connect('/w/tx.db')
con.execute('create table t (v text)'); con.commit()
con.execute('begin'); con.execute("insert into t values ('uncommitted')")
str(sorted(f for f in os.listdir('/w') if f.startswith('tx.db')))
`);
    ok(/tx\.db-journal/.test(mid),
      `an open transaction leaves a journal on disk (${mid}) — so a mid-transaction copy carries its own rollback`);
  }

  // --- the editor's language service, against the host's own CPython ---------
  if (spec.kind === "language-service") {
    // Two interpreters, ONE driver. Everything below runs the shipped
    // LSP_DRIVER_SOURCE in Pyodide and the identical string under python3 on
    // this machine, with jedi and black pinned to the same versions, and
    // requires them to agree. An expectation table written here would have
    // agreed with the implementation by construction; this cannot.
    const scratch = path.join(SCRATCH, "lsp-oracle");
    const jediVersion = lockVersion(path.join(SCRATCH, "node_modules/pyodide/pyodide-lock.json"), "jedi");
    const pins = [
      { name: "jedi", version: jediVersion },
      ...vendoredPyPIPins(path.join(ROOT, "scripts/vendor-pyodide.mjs")).filter((p) => p.name === "black"),
    ].filter((p) => p.version);
    ok(pins.length === 2, `the oracle's pins are read from the shipping config, not restated (${pins.map((p) => p.name + "==" + p.version).join(", ")})`);

    const oracle = ensureOracle(scratch, pins);
    // A comparison that did not run must not look like one that agreed.
    ok(!oracle.error, oracle.error || "the host oracle installed the same jedi and black the browser gets");
    const versions = oracle.dir ? oracleVersions(oracle.dir) : null;

    // Boot the service the way the worker does.
    await ensure(["jedi"]);
    await ensure(["black"]);
    py.runPython(`import sys; sys.executable = ${JSON.stringify(PYTHON_EXECUTABLE)}`);

    // FIRST: prove the line the whole driver turns on. jedi's DEFAULT
    // environment discovery runs sys.executable in a subprocess to read its
    // version; Pyodide answers that with OSError(138). This is not hypothetical
    // — sys.executable is "python" precisely because builtins/python.js sets it
    // so runpy's errors read correctly.
    const defaultEnv = py.runPython(`
import jedi
try:
    s = jedi.Script(code="import json\\njson.", path="/x.py")
    s.complete(2, 5)
    r = "no error"
except Exception as e:
    r = type(e).__name__ + ": " + str(e)[:80]
r
`);
    ok(
      /InvalidPythonEnvironment/.test(defaultEnv),
      `jedi's default environment discovery really does fail here (${defaultEnv}) — which is why the driver passes InterpreterEnvironment`,
    );

    py.runPython(LSP_DRIVER_SOURCE);
    const dispatch = py.globals.get("_vv_lsp");
    ok(!!dispatch, "the shipped driver loads on a real interpreter and defines _vv_lsp");

    // A project on disk, mirrored into BOTH interpreters at the same paths, so
    // jedi resolves the same imports on each side.
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-lsp-proj-"));
    const FILES = {
      "helper.py":
        "def project_helper(alpha, beta=2):\n" +
        '    """A helper that lives in the project."""\n' +
        "    return alpha * beta\n",
      "pkg/__init__.py": "",
      "pkg/mod.py": "class ProjectClass:\n    def method_here(self):\n        return 1\n",
    };
    for (const [rel, text] of Object.entries(FILES)) {
      const full = path.join(projDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text);
      const inPy = projDir + "/" + rel;
      py.FS.mkdirTree(path.dirname(inPy));
      py.FS.writeFile(inPy, new TextEncoder().encode(text));
    }
    const ask = (req) => {
      const full = { root: projDir, path: projDir + "/main.py", ...req };
      const mine = JSON.parse(dispatch(JSON.stringify(full)));
      const theirs = oracle.dir ? askHost(oracle.dir, LSP_DRIVER_SOURCE, full, projDir) : null;
      return { mine, theirs };
    };

    // ── black: same version both sides, so the comparison is byte-exact ──────
    // This is the strongest oracle available anywhere in this file: formatting is
    // deterministic, and the two interpreters run the identical black.
    const SAMPLES = [
      ["reindent and space", "x  =  1\ndef f( a,b ):\n  return   a+b\n"],
      ["already formatted", "x = 1\n"],
      ["magic trailing comma", "foo(\n    a,\n)\n"],
      ["long line wrapping", "result = some_function(argument_one, argument_two, argument_three, argument_four, argument_five)\n"],
      ["string normalisation", "s = 'single'\n"],
      ["blank lines around defs", "import os\ndef a():\n    pass\ndef b():\n    pass\n"],
      ["nested data", "d={'a':1,'b':[1,2,3],'c':{'d':4}}\n"],
    ];
    for (const [label, code] of SAMPLES) {
      const { mine, theirs } = ask({ op: "format", code });
      ok(!mine.error, `black formats "${label}" without error`);
      if (theirs && !theirs.error) {
        ok(
          mine.text === theirs.text,
          `"${label}": byte-identical to black on the host${mine.text === theirs.text ? "" : `\n      browser: ${JSON.stringify(mine.text)}\n      host:    ${JSON.stringify(theirs.text)}`}`,
        );
      }
    }
    // …and the same samples against black's own COMMAND LINE, with no driver on
    // either side. The comparisons above run the shipped driver twice, so a
    // change to the driver's Mode would move both answers together and still
    // agree; this is what notices the editor formatting differently from
    // `black yourfile.py`, which is the promise being made.
    if (oracle.dir) {
      for (const [label, code] of SAMPLES) {
        const cli = blackCli(oracle.dir, code);
        const { mine } = ask({ op: "format", code });
        if (cli.error) continue;
        ok(
          mine.text === cli.text,
          `"${label}": identical to running black on the command line${mine.text === cli.text ? "" : `\n      editor: ${JSON.stringify(mine.text)}\n      CLI:    ${JSON.stringify(cli.text)}`}`,
        );
      }
    }

    // The `changed` flag is what the editor uses to decide between an edit and
    // "already formatted", so it has to be right in both directions.
    ok(ask({ op: "format", code: "x = 1\n" }).mine.changed === false, "an already-formatted file reports changed: false");
    ok(ask({ op: "format", code: "x=1\n" }).mine.changed === true, "…and one that needed work reports changed: true");

    // Bad syntax: an error with black's own position, and NO text field — the
    // provider keys off that to leave the buffer alone.
    for (const bad of ["def broken(:\n", "x = (\n", "class C\n    pass\n"]) {
      const { mine, theirs } = ask({ op: "format", code: bad });
      ok(mine.error === "parse", `black refuses ${JSON.stringify(bad.slice(0, 12))} with error "parse"`);
      ok(mine.text === undefined, "…and returns NO text, so there is nothing to write over the buffer with");
      ok(/Cannot parse: \d+:\d+/.test(mine.message), `…carrying black's own position: ${JSON.stringify(mine.message)}`);
      if (theirs && theirs.error === "parse") {
        ok(mine.message === theirs.message, `…the same message black gives on the host: ${JSON.stringify(theirs.message)}`);
      }
    }

    // ── jedi: buffer-local code, where the stdlib version cannot differ ──────
    // The host runs CPython 3.11 and Pyodide runs 3.14, so a stdlib completion
    // list is legitimately different on the two. Code defined in the buffer or
    // in the project is not: same jedi, same input, same answer required.
    const LOCAL = [
      [
        "signature of a project function",
        { op: "signature", code: "import helper\nhelper.project_helper(", line: 2, column: 22 },
      ],
      [
        "completion of a buffer-local name",
        { op: "complete", code: "def local_function(q):\n    pass\nlocal_", line: 3, column: 6, token: "t" },
      ],
      [
        "completion of a project module's members",
        { op: "complete", code: "import helper\nhelper.", line: 2, column: 7, token: "t" },
      ],
      [
        "completion inside a project subpackage",
        { op: "complete", code: "from pkg import mod\nmod.ProjectClass.", line: 2, column: 17, token: "t" },
      ],
      ["goto a project definition", { op: "goto", code: "import helper\nhelper.project_helper", line: 2, column: 10 }],
      ["goto a buffer-local definition", { op: "goto", code: "def foo():\n    pass\nfoo()", line: 3, column: 1 }],
      ["hover over a project function", { op: "hover", code: "import helper\nhelper.project_helper", line: 2, column: 10 }],
    ];
    for (const [label, req] of LOCAL) {
      const { mine, theirs } = ask(req);
      ok(!mine.error, `${label}: answered without error`);
      ok((mine.items || []).length > 0, `${label}: found something`);
      if (theirs && !theirs.error) {
        ok(
          JSON.stringify(mine) === JSON.stringify(theirs),
          `${label}: identical to jedi on the host${JSON.stringify(mine) === JSON.stringify(theirs) ? "" : `\n      browser: ${JSON.stringify(mine).slice(0, 240)}\n      host:    ${JSON.stringify(theirs).slice(0, 240)}`}`,
        );
      }
    }

    // The details the providers actually render, spelled out rather than only
    // compared — so a change that breaks BOTH sides identically still fails.
    const sig = ask({ op: "signature", code: "import helper\nhelper.project_helper(", line: 2, column: 22 }).mine;
    ok(sig.items[0].label === "project_helper(alpha, beta=2)", `the signature renders defaults: ${sig.items[0].label}`);
    ok(sig.items[0].params.map((p) => p.label).join(",") === "alpha,beta", "…and names its parameters in order");
    ok(sig.items[0].active === 0, "…and reports which parameter the cursor is in");

    const goto = ask({ op: "goto", code: "import helper\nhelper.project_helper", line: 2, column: 10 }).mine;
    ok(goto.items[0].path === projDir + "/helper.py", "goto reports the project file's real path");
    ok(goto.items[0].line === 1, "…and its line");
    // The column contract, from the other end: the driver adds 1 so the editor
    // gets a Monaco column back.
    ok(goto.items[0].column === 5, `…as a 1-based column for Monaco (got ${goto.items[0].column})`);
    ok(hostPathFor(goto.items[0].path, projDir).openable, "…and the path mapper agrees the editor can open it");

    const hover = ask({ op: "hover", code: "import helper\nhelper.project_helper", line: 2, column: 10 }).mine;
    ok(/A helper that lives in the project/.test(hover.items[0].doc), "hover carries the real docstring");

    // ── the stdlib and installed packages: presence, not the whole list ──────
    // A user's actual complaint is "requests.get is not offered", so what is
    // checked is that the right names ARE there.
    const std = ask({ op: "complete", code: "import json\njson.", line: 2, column: 5, token: "t" }).mine;
    const names = (std.items || []).map((i) => i.label);
    for (const want of ["dumps", "loads", "dump", "load"]) {
      ok(names.includes(want), `stdlib completion offers json.${want}`);
    }
    ok(std.items.find((i) => i.label === "dumps").type === "function", "…typed as a function, so the icon is right");

    // The requirement in one test: something pip installed, completed. Without
    // this a user who ran `pip install tabulate` gets nothing and concludes the
    // feature is broken.
    await ensure(["micropip"]);
    await py.pyimport("micropip").install("tabulate");
    const inst = ask({ op: "complete", code: "import tabulate\ntabulate.", line: 2, column: 9, token: "t" }).mine;
    ok(
      (inst.items || []).some((i) => i.label === "tabulate"),
      "a package installed at runtime is completed — this is the pip install case",
    );
    const instGoto = ask({ op: "goto", code: "import tabulate\ntabulate.tabulate", line: 2, column: 12 }).mine;
    ok(
      instGoto.items[0].path.startsWith("/lib/python3.14/site-packages/"),
      `…and its definition resolves inside site-packages (${instGoto.items[0].path})`,
    );
    const mapped = hostPathFor(instGoto.items[0].path, "/project");
    ok(mapped.openable && mapped.path.startsWith("/project/.venv/"), `…which maps onto the project's package store: ${mapped.path}`);

    // A file in a SUBDIRECTORY importing a top-level project module. This is the
    // case that distinguishes an explicit project root from the one jedi would
    // infer by walking up from the file: without the root we pass, sys.path gets
    // the subdirectory and `import helper` resolves to nothing. It is also an
    // entirely ordinary layout — tests/ importing the package it tests.
    fs.mkdirSync(path.join(projDir, "sub"), { recursive: true });
    const deepCode = "import helper\nhelper.project_helper";
    const deep = JSON.parse(
      dispatch(JSON.stringify({ root: projDir, path: projDir + "/sub/deep.py", op: "goto", code: deepCode, line: 2, column: 10 })),
    );
    ok(
      (deep.items || []).length > 0 && deep.items[0].path === projDir + "/helper.py",
      `a file in a subdirectory resolves a top-level project import (${JSON.stringify((deep.items || [])[0] || deep)})`,
    );
    const deepComplete = JSON.parse(
      dispatch(JSON.stringify({ root: projDir, path: projDir + "/sub/deep.py", op: "complete", code: "import helper\nhelper.", line: 2, column: 7, token: "t" })),
    );
    ok(
      (deepComplete.items || []).some((i) => i.label === "project_helper"),
      "…and completes its members, so the project root is genuinely on jedi's path",
    );

    // ── unsaved buffer state ────────────────────────────────────────────────
    // "Complete against what is on screen, not what was last written to disk."
    // Nothing named brand_new_symbol exists in any file.
    const unsaved = ask({
      op: "complete",
      code: "class BrandNewClass:\n    def brand_new_method(self):\n        pass\n\nBrandNewClass().brand_",
      line: 5,
      column: 22,
      token: "t",
    }).mine;
    ok(
      (unsaved.items || []).some((i) => i.label === "brand_new_method"),
      "a symbol that exists only in the unsaved buffer is completed",
    );

    // ── resolve, and the staleness guard on it ──────────────────────────────
    const first = ask({ op: "complete", code: "import helper\nhelper.", line: 2, column: 7, token: "tok-A" }).mine;
    const idx = first.items.findIndex((i) => i.label === "project_helper");
    const doc = JSON.parse(dispatch(JSON.stringify({ op: "resolve", token: "tok-A", index: idx })));
    ok(/A helper that lives in the project/.test(doc.doc || ""), "resolving a completion item fetches its docstring");
    const stale = JSON.parse(dispatch(JSON.stringify({ op: "resolve", token: "tok-OLD", index: 0 })));
    ok(stale.stale === true, "…and a token from a superseded list is refused, rather than documenting the wrong symbol");
    const oob = JSON.parse(dispatch(JSON.stringify({ op: "resolve", token: "tok-A", index: 9999 })));
    ok(oob.stale === true, "…as is an index past the end of the list");

    // ── failure, on a real interpreter ──────────────────────────────────────
    const raised = ask({ op: "complete", code: "x", line: 9999, column: 0, token: "t" }).mine;
    ok(raised.error === "raised", "a jedi crash is reported as this request failing");
    ok(/ValueError/.test(raised.message), `…with the real exception: ${JSON.stringify(raised.message)}`);
    const after = ask({ op: "complete", code: "import json\njson.", line: 2, column: 5, token: "t" }).mine;
    ok(!after.error && after.items.length > 0, "…and the NEXT request still works — one bad keystroke does not take the service down");
    ok(JSON.parse(dispatch(JSON.stringify({ op: "nonsense" }))).error === "op", "an unknown op is named as such rather than crashing");

    if (versions) {
      ok(
        versions.jedi === jediVersion,
        `the oracle ran jedi ${versions.jedi} against the browser's ${jediVersion}`,
      );
      // Worth stating in the output: the ONE thing the two sides do not share,
      // and the reason the stdlib comparisons above are presence checks.
      console.log(`      (oracle CPython ${versions.python} vs Pyodide ${PYODIDE_PYTHON_VERSION} — why stdlib lists are not compared verbatim)`);
    }
  }

  // --- which HTTP clients can work here, and why -----------------------------
  if (spec.kind === "http-clients") {
    // requests works because urllib3's Emscripten transport can be pushed onto
    // its XHR branch (see the urllib3-realm case). The question this answers is
    // whether the two clients people reach for INSTEAD of requests can work at
    // all — and it is a question about which door they knock on, not about
    // whether a particular network call succeeds, so nothing here needs a live
    // server or a lucky DNS lookup.
    await ensure(["httpx"]);
    const T = String(py.runPython(`
import httpx
t = httpx.Client()._transport
type(t).__module__ + "." + type(t).__name__
`));
    ok(/JavascriptFetchTransport/.test(T),
      `httpx's DEFAULT sync transport in this build is ${T} — it goes to fetch/XHR, not to a socket`);

    // The fallback it uses when JSPI is absent is exactly the capability a
    // Worker has and Node has not, which is the same reason requests works.
    const src = String(py.runPython(`
import inspect, httpx._transports.jsfetch as j
inspect.getsource(j)
`));
    ok(/js\.XMLHttpRequest\.new\(\)/.test(src),
      "…and its no-JSPI fallback is a synchronous XMLHttpRequest, the browser API a Worker provides");

    // The trap urllib3 had, checked for here so that "httpx needs no patch"
    // stays a fact rather than an assumption. urllib3 REFUSES outright when it
    // decides it is on Node, which is why our runtime's process.release.name
    // broke requests; httpx has no such branch to be wrong about.
    ok(!/is_in_node/.test(src),
      "…and httpx never asks whether it is on Node, so the realm patch requests needed does not apply to it");

    // In this Node there is no XMLHttpRequest, so a sync call must fail SAYING
    // that, rather than hanging or quietly reaching for a socket.
    const sync = String(py.runPython(`
import httpx
try:
    httpx.get("https://example.invalid/x", timeout=5)
    out = "returned"
except BaseException as e:
    out = type(e).__name__ + ": " + str(e)[:80]
out
`));
    ok(/XMLHttpRequest/.test(sync),
      `…and off a browser it says which browser API is missing (${sync}) instead of pretending to dial out`);

    // aiohttp is the other common answer, and it cannot work: it goes to a real
    // connector. Worth asserting rather than assuming, because "it is in the
    // Pyodide index" reads like "it is supported".
    await ensure(["aiohttp"]);
    const ah = String(await py.runPythonAsync(`
import aiohttp, asyncio
try:
    async with aiohttp.ClientSession() as s:
        async with s.get("http://example.invalid/x", timeout=aiohttp.ClientTimeout(total=8)) as r:
            out = "HTTP " + str(r.status)
except BaseException as e:
    out = type(e).__name__ + ": " + str(e)[:80]
out
`));
    ok(!/^HTTP /.test(ah) && /Connect|DNS|resolve|socket|OSError|gaierror/i.test(ah),
      `aiohttp reaches for a real connection and fails loudly (${ah}) — it is in the index, which is not the same as working`);
  }

  // --- the editor's diagnostics, against the host's own mypy ---------------
  if (spec.kind === "diagnostics") {
    // The offline tier drives the marker wiring against a stubbed reply, which
    // cannot tell whether the positions in that reply are the positions mypy
    // really produces. This runs the SHIPPED driver op on a real interpreter and
    // then checks the two things a stub cannot: that the parse survives real
    // mypy output, and that a marker lands on the code it is about.
    const scratch = path.join(SCRATCH, "diag-oracle");
    const mypyVersion = lockVersion(path.join(SCRATCH, "node_modules/pyodide/pyodide-lock.json"), "mypy");
    const oracle = ensureOracle(scratch, [{ name: "mypy", version: mypyVersion }].filter((p) => p.version));
    ok(!oracle.error, oracle.error || `the host oracle installed mypy ${mypyVersion}`);

    const HELPER = "def add(a: int, b: int) -> int:\n    return a + b\n";
    const APP = 'from helper import add\n\n\ndef bad(x: int) -> str:\n    return add(x, 1)\n\n\nadd("nope", 2)\n';
    mirrorIn({ "helper.py": HELPER, "app.py": APP });
    await ensure(["jedi"]);
    await ensure(["mypy"]);
    // The fixups again: without them `from mypy import api` inside the driver
    // raises, and every check would come back as a service error.
    const vendorSrc = fs.readFileSync(path.join(ROOT, "scripts/vendor-pyodide.mjs"), "utf8");
    const fixBlock = /const DEPENDS_FIXUPS = \{([\s\S]*?)\n\};/.exec(vendorSrc);
    await ensure(fixBlock ? [...(/mypy:\s*\[([^\]]*)\]/.exec(fixBlock[1])?.[1] || "").matchAll(/"([^"]+)"/g)].map((m) => m[1]) : []);

    py.runPython(`import sys; sys.executable = ${JSON.stringify(PYTHON_EXECUTABLE)}`);
    py.runPython(LSP_DRIVER_SOURCE);
    const dispatch = py.globals.get("_vv_lsp");
    ok(!!dispatch, "the driver loads with the check op on a real interpreter");

    const reply = JSON.parse(dispatch(JSON.stringify({
      op: "check", path: DIR + "/app.py", root: DIR, code: APP, cacheDir: DIR + "/.mypy_cache",
    })));
    ok(!reply.error, reply.error ? `check failed: ${reply.message}` : "the check op answered without a service error");
    const items = reply.items || [];
    ok(items.length === 2, `real mypy found ${items.length} diagnostics in the fixture`);

    // The host, on the same source, with the positions spelled out the same way.
    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-diag-oracle-"));
    fs.writeFileSync(path.join(hostDir, "helper.py"), HELPER);
    fs.writeFileSync(path.join(hostDir, "app.py"), APP);
    const hostOut = spawnSync("python3", [
      "-m", "mypy", "--no-color-output", "--no-error-summary", "--no-pretty",
      "--show-column-numbers", "--show-error-end", "--follow-imports=silent",
      "--no-incremental", "app.py",
    ], { cwd: hostDir, encoding: "utf8", env: { ...process.env, PYTHONPATH: oracle.dir } });
    const hostLines = (hostOut.stdout || "").trim().split("\n").filter(Boolean);
    ok(hostLines.length === items.length, `the host reports the same number of diagnostics (${hostLines.length})`);

    // Positions, compared to the host's rather than to numbers written here.
    const hostPos = hostLines.map((l) => {
      const m = /^app\.py:(\d+):(\d+):(\d+):(\d+): (error|warning): (.*?)(?:  \[([a-z-]+)\])?$/.exec(l);
      return m ? { line: +m[1], column: +m[2], endLine: +m[3], endColumn: +m[4] + 1, severity: m[5], message: m[6], code: m[7] || "" } : null;
    });
    for (let i = 0; i < Math.min(items.length, hostPos.length); i++) {
      const a = items[i];
      const b = hostPos[i];
      ok(b && a.line === b.line && a.column === b.column && a.endLine === b.endLine && a.endColumn === b.endColumn,
        b ? `diagnostic ${i + 1} lands where the host puts it (${a.line}:${a.column}-${a.endLine}:${a.endColumn})`
          : `the host line did not parse: ${hostLines[i]}`);
      ok(b && a.message === b.message && a.code === b.code, b ? `…with the host's wording and code [${a.code}]` : "…");
    }

    // What the range actually covers. This is the check that a stub cannot make:
    // slice the source with the marker's own numbers and look at the text.
    const lines = APP.split("\n");
    const slice = (d) => (d ? lines[d.line - 1].slice(d.column - 1, d.endColumn - 1) : "(no diagnostic)");
    ok(slice(items[0]) === "add(x, 1)", `the first marker underlines the expression, not the line: ${JSON.stringify(slice(items[0]))}`);
    ok(slice(items[1]) === '"nope"', `the second underlines the offending argument: ${JSON.stringify(slice(items[1]))}`);

    // Clean code produces nothing, so an empty marker list means "checked and
    // fine" rather than "never ran".
    const clean = JSON.parse(dispatch(JSON.stringify({
      op: "check", path: DIR + "/app.py", root: DIR,
      code: "from helper import add\n\n\ndef good(x: int) -> str:\n    return str(add(x, 1))\n",
      cacheDir: DIR + "/.mypy_cache",
    })));
    ok(!clean.error && (clean.items || []).length === 0, "a corrected buffer checks clean");

    // Incremental cost, measured rather than claimed — it is the number the
    // debounce was chosen against.
    const t0 = performance.now();
    JSON.parse(dispatch(JSON.stringify({
      op: "check", path: DIR + "/app.py", root: DIR,
      code: "from helper import add\n\n\ndef good(x: int) -> str:\n    return str(add(x, 2)) + '!'\n",
      cacheDir: DIR + "/.mypy_cache",
    })));
    const ms = performance.now() - t0;
    ok(ms < 2000, `an incremental re-check costs ${ms.toFixed(0)}ms, which is what makes a pause-triggered check affordable`);
  }

  // --- console scripts, read off a real wheel --------------------------------
  if (spec.kind === "console-scripts") {
    // The offline tier writes shims from entry_points.txt files it wrote itself.
    // That gates the parsing and the pruning, but not the assumption underneath:
    // that a real wheel's metadata says what we think it says, and that the
    // loader we generate from it actually reaches a callable.
    await ensure(["mypy"]);
    const vendorSrc = fs.readFileSync(path.join(ROOT, "scripts/vendor-pyodide.mjs"), "utf8");
    const fixBlock = /const DEPENDS_FIXUPS = \{([\s\S]*?)\n\};/.exec(vendorSrc);
    await ensure(fixBlock ? [...(/mypy:\s*\[([^\]]*)\]/.exec(fixBlock[1])?.[1] || "").matchAll(/"([^"]+)"/g)].map((m) => m[1]) : []);

    const epText = String(py.runPython(`
import glob, os
hits = glob.glob("/lib/python3.14/site-packages/mypy-*.dist-info/entry_points.txt")
open(hits[0], encoding="utf8").read() if hits else ""
`));
    ok(epText.includes("[console_scripts]"), "a real installed wheel ships the console_scripts metadata this feature reads");
    const eps = parseEntryPoints(epText);
    ok(Object.keys(eps).length > 0, `the shipped parser reads it: ${Object.keys(eps).sort().join(", ")}`);
    ok(!!eps.stubgen, "…including stubgen, which is a command nobody can run today because nothing writes a shim for it");
    ok(RESERVED_COMMANDS.has("mypy") && !!eps.mypy,
      "…and mypy, which the wheel also declares — protected precisely because the wheel would otherwise take the seam over");

    // The generated loader, run for real: import the module the metadata names,
    // walk the attribute, and confirm what comes out is callable. This is the
    // step that would fail if the entry-point syntax were richer than the parser.
    const [mod, attr] = eps.stubgen.split(":");
    const resolved = String(py.runPython(`
import importlib
_t = importlib.import_module(${JSON.stringify(mod)})
for _p in ${JSON.stringify(attr)}.split("."):
    _t = getattr(_t, _p)
type(_t).__name__ + ("/callable" if callable(_t) else "/NOT-callable")
`));
    ok(/\/callable$/.test(resolved), `the loader reaches a callable entry point (${eps.stubgen} -> ${resolved})`);
  }

  // --- the first five minutes: a chart, a coroutine, a timezone ------------
  if (spec.kind === "day-one") {
    // Each of these is something a Python user does before they do anything
    // interesting, and each was broken in a way that produced either silence or
    // a message about WebAssembly. The offline tier checks the wiring; only a
    // real interpreter can say whether the wiring produces a PNG.
    ok(installMatplotlibShow(py, {}) === true, "the matplotlib backend installs into a real interpreter");
    ok(installBlockingPatch(py) === true, "…as does the asyncio.run message");
    await ensure(["matplotlib"]);

    const plotDir = path.join(SCRATCH, "day-one");
    fs.rmSync(plotDir, { recursive: true, force: true });
    fs.mkdirSync(plotDir, { recursive: true });
    py.FS.mkdirTree(plotDir);

    const shown = String(await py.runPythonAsync(`
import os
os.chdir(${JSON.stringify(plotDir)})
import matplotlib.pyplot as plt
import io, sys
_buf, _old = io.StringIO(), sys.stdout
sys.stdout = _buf
plt.plot([1, 2, 3], [3, 1, 2]); plt.title("first"); plt.show()
plt.plot([1, 2], [1, 2]); plt.title("second"); plt.show()
sys.stdout = _old
_buf.getvalue()
`));
    ok(/plot\.png/.test(shown) && /plot-2\.png/.test(shown),
      "plt.show() says where each chart went, instead of returning in silence");
    const wrote = py.FS.readdir(plotDir).filter((f) => f.endsWith(".png")).sort();
    ok(wrote.join(",") === "plot-2.png,plot.png", `…and both files exist (${wrote.join(", ")})`);
    // A PNG or nothing: an empty file would satisfy a name check and open to a
    // broken image, which is the same disappointment one step later.
    const png = py.FS.readFile(path.join(plotDir, "plot.png"));
    ok(png.length > 1000 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47,
      `…and the first one is a real PNG (${png.length} bytes, PNG magic present)`);
    const backend = String(py.runPython("import matplotlib; matplotlib.get_backend()"));
    ok(/vv_mpl/.test(backend), `…because the backend in force is ours (${backend})`);

    // asyncio.run: the message has to be about Python, and its advice has to be
    // true in this runtime, which is the part that could rot silently.
    const runMsg = String(await py.runPythonAsync(`
import asyncio
async def main(): return 1
try:
    asyncio.run(main())
    out = "JSPI: it worked"
except RuntimeError as e:
    out = str(e)
out
`));
    if (/JSPI: it worked/.test(runMsg)) {
      ok(true, "asyncio.run() works here, so the wrapper stayed out of the way (this runtime has stack switching)");
    } else {
      ok(!/stack switching not supported in this JavaScript runtime/.test(runMsg),
        "asyncio.run() no longer answers with CPython's message about a WebAssembly proposal");
      ok(/await main\(\)/.test(runMsg), "…it answers with the thing to type instead");
      const advice = String(await py.runPythonAsync(`
import asyncio
async def main():
    await asyncio.sleep(0)
    return "ok"
await main()
`));
      ok(advice === "ok", "…and that advice actually runs, which is the only reason it is worth printing");
    }

    // input() is no longer part of this case: it waits now, and what it waits on
    // is a syscall. See the "stdin" case below, and verify-node.mjs for the
    // kernel half.

    // ZoneInfo, which needs a wheel nothing imports by name.
    ok(dataPackagesFor("from zoneinfo import ZoneInfo").includes("tzdata"),
      "source that mentions zoneinfo asks for tzdata");
    await ensure(dataPackagesFor("from zoneinfo import ZoneInfo"));
    const tz = String(py.runPython(`
from zoneinfo import ZoneInfo
import datetime
try:
    out = "OK " + str(datetime.datetime(2026, 1, 1, tzinfo=ZoneInfo("Asia/Tokyo")).tzname())
except BaseException as e:
    out = type(e).__name__ + ": " + str(e)[:60]
out
`));
    ok(/^OK JST/.test(tz), `an aware datetime in a named zone works once tzdata is loaded (${tz})`);
  }

  // --- ruff, held to the real ruff ----------------------------------------
  if (spec.kind === "ruff") {
    // The offline tier drives this program against a stub, which can check
    // everything except the only thing users care about: whether the answers
    // are ruff's. So here the vendored wasm runs on real files and the REAL
    // ruff CLI, pinned to the same version, runs on the same files, and the two
    // have to produce the same findings and the same formatting.
    const vendored = path.join(ROOT, "packages/studio/public/vendor/ruff");
    if (!fs.existsSync(path.join(vendored, "ruff_wasm_bg.wasm"))) {
      const r = spawnSync("node", [path.join(ROOT, "scripts/vendor-ruff.mjs")], { encoding: "utf8" });
      ok(r.status === 0, r.status === 0 ? "vendored ruff on demand for this run" : `could not vendor ruff: ${r.stderr}`);
    }
    const version = fs.readFileSync(path.join(vendored, "version.txt"), "utf8").trim();
    const oracle = ensureRuffOracle(path.join(SCRATCH, "ruff-oracle"), version);
    ok(!oracle.error, oracle.error || `the host oracle is the same ruff the browser gets (${version})`);

    // Deliberately several different KINDS of finding: an unused import (a
    // fix), an unsorted import block (a rewrite), an undefined name (the one
    // that catches a typo before it costs a run), and an unused local.
    const FIXTURE = [
      "import sys",
      "import os",
      "",
      "",
      "def total(values):",
      "    running = 0",
      "    unused = 1",
      "    for v in values:",
      "        running += v",
      "    return runing",
      "",
    ].join("\n");
    const MESSY = "x={'a':1,  'b':2}\ndef f( a,b ):\n  return a+b\n";

    const dir = path.join(SCRATCH, "ruff-project");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(dir, "main.py"), FIXTURE);
    fs.writeFileSync(path.join(dir, "pkg", "messy.py"), MESSY);

    const ours = await driveRuffReal(["check"], dir, vendored);
    const theirs = oracle.bin ? ruffCheckCli(oracle.bin, dir) : null;
    const oursLines = ours.out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[^\s].*:\d+:\d+: /.test(l))
      .sort();
    ok(oursLines.length > 0, `the vendored wasm reports findings (${oursLines.length})`);
    ok(oursLines.some((l) => /F821/.test(l)),
      "…including F821 for the misspelled name, which is the one that would otherwise cost a run to find");
    if (theirs) {
      ok(JSON.stringify(oursLines) === JSON.stringify(theirs.lines),
        theirs.lines.join(" | ") === oursLines.join(" | ")
          ? `every finding matches the real ruff, line and column (${oursLines.length} of them)`
          : `MISMATCH vs real ruff:\n      ours:   ${oursLines.join("\n              ")}\n      theirs: ${theirs.lines.join("\n              ")}`);
      ok(ours.code === theirs.status,
        `…and the exit code matches too (${ours.code}), so a CI gate behaves the same either side`);
    }

    // Formatting is the half that rewrites people's files, so it is compared
    // byte for byte rather than by whether it changed something.
    const fmt = await driveRuffReal(["format"], dir, vendored);
    ok(/reformatted/.test(fmt.out), "ruff format reports what it rewrote");
    const got = fs.readFileSync(path.join(dir, "pkg", "messy.py"), "utf8");
    if (oracle.bin) {
      const want = ruffFormatCli(oracle.bin, MESSY);
      ok(!want.error && got === want.text,
        want.error
          ? `real ruff could not format the fixture: ${want.error}`
          : "…and the bytes it wrote are exactly what the real ruff format writes");
    }

    // The claim that makes ruff worth having in the editor: no interpreter.
    ok(!/pyodide/i.test(RUFF_PROGRAM) && !/__ocInstallPython/.test(RUFF_PROGRAM),
      "the program never reaches for the interpreter, which is why it can run while someone types");

    // --- and the editor half, against the same binary ----------------------
    // The offline tier drives the marker mapping with recorded shapes. This is
    // where those shapes are earned: the wasm is loaded the way the LSP worker
    // loads it, and its numbers are used to slice the source. An off-by-one
    // here underlines the wrong characters in every Python file, forever, and
    // no amount of stubbed testing would ever notice.
    const mod = await import(pathToFileURL(path.join(vendored, "ruff_wasm.js")).href);
    await mod.default({ module_or_path: fs.readFileSync(path.join(vendored, "ruff_wasm_bg.wasm")) });
    const ws = new mod.Workspace(mod.Workspace.defaultSettings());

    const SRC = "import os\nimport sys\n\nprint(sys.path)\n";
    const t0 = Date.now();
    const marks = ruffMarkersFrom(ws.check(SRC));
    const lintMs = Date.now() - t0;
    ok(marks.items.length > 0, `the wasm the worker loads returns findings through the shared mapping (${marks.items.length})`);
    const lines = SRC.split("\n");
    const unused = marks.items.find((i) => i.code === "F401");
    ok(!!unused, "…including the unused import, which is the finding everyone meets first");
    const covered = unused && lines[unused.line - 1].slice(unused.column - 1, unused.endColumn - 1);
    ok(covered === "os",
      `the marker's columns cover exactly the token complained about (${JSON.stringify(covered)}), so the squiggle lands on \`os\``);
    ok(lintMs < 200, `a lint of this file costs ${lintMs}ms, which is why it can run on a ${LINT_DEBOUNCE_MS}ms pause`);

    // The judgement from the offline tier, made against the real thing: ruff
    // DOES report a half-typed line, and the editor drops it.
    const HALF = "x = \n";
    const raw = ws.check(HALF);
    ok(raw.some((d) => d.code === "invalid-syntax"),
      "ruff itself reports a half-written line as invalid-syntax, rather than failing");
    ok(ruffMarkersFrom(raw).items.length === 0,
      "…and none of it reaches the editor, so a pause mid-expression is not marked up");

    // A clean file has to be silent, or the whole feature is noise.
    ok(ruffMarkersFrom(ws.check("import sys\n\nprint(sys.path)\n")).items.length === 0,
      "a file with nothing wrong with it gets no markers");
  }

  // --- stdin that waits, under a real interpreter --------------------------
  if (spec.kind === "stdin") {
    // The kernel half — a process really parking on Atomics.wait until somebody
    // types — is proven in scripts/verify-node.mjs, which can run the real
    // kernel. What is proven here is the other half: that CPython, given a
    // callback that returns a line, does everything a person expects of a
    // program that asks a question. That is worth checking separately because
    // input() is not the only caller — pdb's prompt is the same read, and it is
    // the one that makes the difference between printing to debug and debugging.
    let queue = [];
    const asked = [];
    ok(installStdin(py, () => { asked.push(1); return queue.length ? queue.shift() : null; }) === true,
      "a real interpreter accepts the stdin callback");

    queue = ["Duc\n", "41\n"];
    const greeting = String(await py.runPythonAsync(`
name = input("Name: ")
age = input("Age: ")
f"{name} is {int(age) + 1} next year"
`));
    ok(greeting === "Duc is 42 next year", `input() returns what was typed and strips the newline (${greeting})`);
    ok(asked.length === 2, `…one read per question (${asked.length})`);

    // A terminal hands over what was TYPED, not what was asked for: a paste, or
    // fast typing, arrives as one chunk holding several lines. Python has to
    // keep the rest rather than throw it away.
    asked.length = 0;
    queue = ["one\ntwo\nthree\n"];
    const three = String(await py.runPythonAsync('",".join([input(), input(), input()])'));
    ok(three === "one,two,three", `three lines pasted at once feed three reads (${three})`);
    ok(asked.length === 1, `…from a single trip to the kernel (${asked.length}), because the interpreter buffers the rest`);

    // End of input is an EOFError, which is what a Python program that handles a
    // closed stdin is already written to catch.
    queue = [];
    const eof = String(await py.runPythonAsync(`
try:
    input()
    out = "returned"
except EOFError as e:
    out = "EOFError:" + (str(e) or "empty")
out
`));
    ok(/^EOFError:/.test(eof), `end of input raises EOFError, the same as any closed stdin (${eof})`);

    // isatty, which is not decoration: pdb, getpass, click and rich all branch on
    // it, and a program that thinks it is being piped behaves differently.
    ok(String(await py.runPythonAsync("__import__('sys').stdin.isatty()")) === "true",
      "sys.stdin.isatty() is true, so libraries that ask whether there is a person here get the right answer");

    // pdb. The headline: breakpoint() in a file, and a real debugging session —
    // inspect a variable, step, inspect it again, continue.
    // Three steps, because the first two only walk onto the `for` line and then
    // the body — `total` does not change until the third. Asserting after one
    // would have been asserting that stepping does nothing.
    queue = ["p total\n", "n\n", "n\n", "n\n", "p total\n", "c\n"];
    let out = "";
    const prevOut = py._module?.stdout;
    py.setStdout({ batched: (t) => (out += t + "\n") });
    await py.runPythonAsync(`
def add(items):
    total = 0
    breakpoint()
    for i in items:
        total += i
    return total

print("sum:", add([1, 2, 3]))
`);
    py.setStdout({ batched: () => {} });
    ok(/\(Pdb\)/.test(out), "breakpoint() opens a pdb prompt instead of raising");
    ok(/sum: 6/.test(out), "…the program continues to its answer when told to");
    const inspected = out.split("\n").filter((l) => /^\(Pdb\) \d+$/.test(l));
    ok(inspected.length >= 2 && inspected[0] === "(Pdb) 0" && inspected[1] === "(Pdb) 1",
      `…and stepping through the loop changed what the inspected variable showed (${inspected.join(" then ")})`);
    if (prevOut) py.setStdout({ batched: prevOut });
  }

  // --- the interpreter snapshot, across realms -----------------------------
  if (spec.kind === "snapshot") {
    // The whole feature rests on one claim: a snapshot taken by the interpreter
    // in one process can be restored by a different process, which is a
    // DIFFERENT JS REALM. Nothing about that is provable with a stub, and
    // getting it wrong ships a broken CPython to everyone. So it is done for
    // real here — worker_threads standing in for the Web Workers processes are,
    // which is the same boundary — and the restored interpreter is then asked to
    // do the things a user's script will: import, load a package, read and write
    // files, print, and raise something with a usable traceback.
    const dir = path.join(SCRATCH, "snapshot-realms");
    fs.mkdirSync(dir, { recursive: true });
    const workerFile = path.join(dir, "realm.mjs");
    fs.writeFileSync(workerFile, [
      'import { parentPort, workerData } from "node:worker_threads";',
      // A plain path, not a file:// URL: Pyodide takes indexURL apart to find
      // its own asm module, and a URL there sends it looking for a path that
      // does not exist. (The note at the top of this file is about the other
      // half of the same problem.)
      `const { loadPyodide } = await import(${JSON.stringify(PYODIDE_ENTRY)});`,
      `const DIR = ${JSON.stringify(path.dirname(PYODIDE_ENTRY) + "/")};`,
      'const quiet = { messageCallback: () => {}, errorCallback: () => {} };',
      'if (workerData.mode === "make") {',
      '  const t = Date.now();',
      '  const py = await loadPyodide({ indexURL: DIR, _makeSnapshot: true });',
      '  const boot = Date.now() - t;',
      '  const snap = py.makeMemorySnapshot();',
      '  parentPort.postMessage({ boot, snap }, [snap.buffer]);',
      '} else {',
      '  const t = Date.now();',
      '  const py = await loadPyodide({ indexURL: DIR, _loadSnapshot: workerData.snap });',
      '  const boot = Date.now() - t;',
      '  let out = "";',
      '  py.setStdout({ batched: (s) => (out += s) });',
      '  await py.loadPackage(["numpy"], quiet);',
      '  py.FS.writeFile("/home/pyodide/m.py", "import numpy as np, json, sys\\nprint(json.dumps({\'sum\': int(np.arange(10).sum()), \'py\': list(sys.version_info[:2])}))\\n");',
      '  py.runPython("exec(open(\'/home/pyodide/m.py\').read())");',
      '  let tb = "";',
      '  try { py.runPython("def f():\\n    raise ValueError(\'deliberate\')\\nf()\\n"); }',
      '  catch (e) { tb = String(e.message); }',
      '  parentPort.postMessage({ boot, out: out.trim(), tb });',
      '}',
    ].join("\n"));

    const runRealm = (mode, snap) => new Promise((resolve, reject) => {
      const w = new Worker(workerFile, { workerData: { mode, snap } });
      w.on("message", (m) => { resolve(m); w.terminate(); });
      w.on("error", reject);
    });

    const made = await runRealm("make");
    ok(made.snap && made.snap.byteLength > 1e6,
      `realm A booted cold in ${made.boot}ms and serialised itself into ${(made.snap.byteLength / 1e6).toFixed(0)} MB`);

    // Twice, from the same bytes: the second process of a session must not be a
    // special case, and a restore that consumed the cache would break it.
    const restores = [];
    for (const realm of ["B", "C"]) {
      const r = await runRealm("restore", made.snap);
      restores.push(r);
      ok(/"sum": 45/.test(r.out) && /"py": \[3, \d+\]/.test(r.out),
        `realm ${realm} restored it and ran a script that imports numpy, writes a file and prints (${r.out})`);
      ok(/ValueError: deliberate/.test(r.tb) && /line 2/.test(r.tb),
        `…and a traceback out of the restored interpreter still points at the right line`);
    }
    const slowest = Math.max(...restores.map((r) => r.boot));
    ok(slowest < made.boot / 3,
      `restoring costs ${restores.map((r) => r.boot + "ms").join(" and ")} against a ${made.boot}ms cold boot`);
    ok(made.snap.byteLength > 1e6, "…and the bytes survive being restored twice, so a session's third command is fast too");

    // The other half of the cost, which is not Pyodide's: 31 MB has to get from
    // one process to the next through the VFS. Measured through the real kernel,
    // the real Wasm filesystem and real process workers, because a cache that
    // took a second to read would be no cache at all.
    const big = await measureVfsRoundTrip(made.snap.byteLength);
    ok(big.write >= 0 && big.read >= 0 && big.bytes === made.snap.byteLength,
      `through the real VFS, a snapshot of this size costs ${big.write}ms to write and ${big.read}ms to read`);
    ok(big.read < 400,
      `…so a restored boot is about ${big.read + slowest}ms all in, against ${made.boot}ms cold`);
    ok(big.same, "…and the bytes that come back are the bytes that went in");
  }

  // --- the bytecode cache, under a real interpreter ------------------------
  if (spec.kind === "bytecode") {
    // Every claim here is about CPython's import machinery doing something it
    // was not asked to do in writing, and none of it can be checked without the
    // real thing: that unsetting one flag produces bytecode at no cost, that a
    // header rewritten by hand is still one CPython will load, and above all
    // that the saving is the cache and not the weather. So the interpreter that
    // harvests and the interpreter that benefits are separate processes, as
    // they are in a session, and a deliberately broken cache has to give the
    // slow number back.
    const dir = path.join(SCRATCH, "bytecode-realms");
    fs.mkdirSync(dir, { recursive: true });
    const cacheDir = path.join(dir, "cache");
    const workerFile = path.join(dir, "realm.mjs");
    fs.writeFileSync(workerFile, [
      'import { parentPort, workerData } from "node:worker_threads";',
      'import fs from "node:fs";',
      'import path from "node:path";',
      `import { BYTECODE_DIR, PYCACHE_PREFIX, installBytecodeCache, restoreBytecode, harvestBytecode } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "packages/runtime/builtins/python.js")).href)};`,
      `const { loadPyodide } = await import(${JSON.stringify(PYODIDE_ENTRY)});`,
      `const DIR = ${JSON.stringify(path.dirname(PYODIDE_ENTRY) + "/")};`,
      'const quiet = { messageCallback: () => {}, errorCallback: () => {} };',
      // The cache lives at a fixed absolute path in the VFS. Here it is a real
      // directory somewhere else, so the fs the code is handed is the host's
      // with that one prefix moved — real readdir, real stat, real short reads.
      'const at = (p) => path.join(workerData.cache, p.slice(BYTECODE_DIR.length));',
      'const vfs = {',
      '  readFileSync: (p, enc) => fs.readFileSync(at(p), enc),',
      '  writeFileSync: (p, d) => fs.writeFileSync(at(p), d),',
      '  readdirSync: (p) => fs.readdirSync(at(p)),',
      '  statSync: (p) => fs.statSync(at(p)),',
      '  mkdirSync: (p, o) => fs.mkdirSync(at(p), o),',
      '};',
      'const py = await loadPyodide({ indexURL: DIR });',
      'await py.loadPackage(["numpy", "pandas"], quiet);',
      'installBytecodeCache(py, {});',
      // A module of the user's own, to check whose bytecode ends up where.
      'py.FS.mkdirTree("/proj");',
      'py.FS.writeFile("/proj/mine.py", "VALUE = 41\\n");',
      'py.runPython("import sys; sys.path.insert(0, \'/proj\')");',
      // Both halves, in the order a run does them, so a warm realm is measuring
      // what a session's second command actually costs.
      'const restored = restoreBytecode(vfs, py, {});',
      // The control: everything about the cache intact except the bytecode in
      // it, so what is being measured is CPython reading it rather than the
      // machinery around it succeeding.
      'if (workerData.corrupt) py.runPython([',
      '  "import glob, os",',
      '  `for _p in glob.glob(os.path.join(${JSON.stringify(PYCACHE_PREFIX)}, "**", "*.pyc"), recursive=True):`,',
      '  "    open(_p, \'r+b\').write(b\'XXXX\')",',
      '].join("\\n"));',
      'let t = Date.now();',
      'py.runPython("import numpy, pandas, mine");',
      'const importMs = Date.now() - t;',
      // Not just fast: right. Bytecode that loads but computes the wrong thing
      // is the failure a timing test would sail past.
      'const answer = py.runPython("import pandas as pd, numpy as np; str(int(pd.DataFrame({\'a\': np.arange(10)}).a.sum())) + \'/\' + str(mine.VALUE)");',
      't = Date.now();',
      'const saved = workerData.corrupt ? null : harvestBytecode(vfs, py, {});',
      'const harvestMs = Date.now() - t;',
      'const projectClean = !py.FS.analyzePath("/proj/__pycache__").exists;',
      'const mineCached = py.runPython("import importlib.util, os; str(os.path.exists(importlib.util.cache_from_source(\'/proj/mine.py\')))");',
      'parentPort.postMessage({ importMs, harvestMs, answer, projectClean, mineCached,',
      '  saved: saved && saved.saved, restored: restored && restored.keys });',
    ].join("\n"));

    const runRealm = (corrupt) => new Promise((resolve, reject) => {
      const w = new Worker(workerFile, { workerData: { corrupt: !!corrupt, cache: cacheDir } });
      w.on("message", (m) => { resolve(m); w.terminate(); });
      w.on("error", reject);
    });

    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    const cold = await runRealm();
    ok(cold.answer === "45/41", `realm A imported numpy, pandas and a module of its own in ${cold.importMs}ms`);
    ok((cold.saved || []).some((k) => k.startsWith("pandas-")) && (cold.saved || []).some((k) => k.startsWith("numpy-")),
      `…and keeping what those imports compiled took ${cold.harvestMs}ms (${(cold.saved || []).length} packages)`);
    // The reason for the prefix. Bytecode next to the source would appear in the
    // file explorer and be mirrored back into the VFS as the script's own work.
    ok(cold.projectClean, "no __pycache__ appears in the user's project directory");
    ok(cold.mineCached === "True", "…though their module is compiled too, into the tree that dies with the process");

    const entries = fs.readdirSync(cacheDir).filter((f) => f.endsWith(".tar"));
    ok(entries.length >= 2, `the cache holds ${entries.length} packages (${(fs.statSync(path.join(cacheDir, entries[0])).size / 1e6).toFixed(1)} MB for the first)`);
    const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, entries[0].replace(/\.tar$/, ".json")), "utf8"));
    ok(meta.magic && meta.count > 0 && meta.bytes === fs.statSync(path.join(cacheDir, entries[0])).size,
      "…each with a record of its size, its file count and the CPython that compiled it");

    const warm = await runRealm();
    ok(warm.answer === "45/41", `realm B put it back and got the same answers in ${warm.importMs}ms`);
    ok((warm.restored || []).length >= 2, `…restoring ${(warm.restored || []).length} packages' bytecode`);
    ok(warm.importMs < cold.importMs / 2,
      `…which is ${cold.importMs}ms of importing against ${warm.importMs}ms, in a process that did not compile them`);
    // A cache that already holds everything must not be rewritten every run:
    // that would spend the saving on 12 MB of tar and put it back where it was.
    ok((warm.saved || []).length === 0 && warm.harvestMs < cold.harvestMs,
      `…and a run that adds nothing new writes nothing, in ${warm.harvestMs}ms against ${cold.harvestMs}ms`);

    // The control. Bytecode CPython cannot read must send it back to the source,
    // which is the slow path — if this came back fast, the numbers above would
    // be measuring something else entirely.
    const broken = await runRealm(true);
    ok(broken.answer === "45/41", "a cache full of unreadable bytecode still produces the right answers");
    ok(broken.importMs > warm.importMs * 1.5,
      `…by compiling from source, which is the slow number again (${broken.importMs}ms against ${warm.importMs}ms warm)`);
  }

  // --- Ctrl-C, across a real thread boundary --------------------------------
  if (spec.kind === "interrupt") {
    // The thing that makes this hard cannot be reproduced in one thread: while
    // CPython runs, the worker's JS is not running, so nothing on that thread
    // can observe a signal. So the interpreter goes in a real worker, the
    // "kernel" stays here, and the only thing crossing between them is the
    // SharedArrayBuffer the real protocol lays out — signalled with the real
    // `postSignal`, not a hand-written byte.
    const { SAB_BYTES, makeViews, postSignal, interruptView, I_SIGNAL, SIGNAL_BITS } = await import(
      pathToFileURL(path.join(ROOT, "packages/protocol/syscall.js")).href
    );
    const { terminationFromError } = await import(
      pathToFileURL(path.join(ROOT, "packages/runtime/builtins/python.js")).href
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-pyint-"));
    const workerFile = path.join(dir, "interp.mjs");
    fs.writeFileSync(workerFile, [
      'import { parentPort, workerData } from "node:worker_threads";',
      `const { loadPyodide } = await import(${JSON.stringify(PYODIDE_ENTRY)});`,
      `const DIR = ${JSON.stringify(path.dirname(PYODIDE_ENTRY) + "/")};`,
      `const { interruptView } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "packages/protocol/syscall.js")).href)});`,
      'const py = await loadPyodide({ indexURL: DIR });',
      'const view = interruptView(workerData.sab);',
      'py.setInterruptBuffer(view);',
      'parentPort.postMessage({ ready: true });',
      // A loop long enough that finishing it would be the failure.
      'const started = Date.now();',
      'let outcome;',
      'try {',
      '  py.runPython(`total = 0\nfor i in range(${workerData.iterations}):\n    total += i\n`);',
      '  outcome = { finished: true };',
      '} catch (e) {',
      '  outcome = { type: e.type || null, message: String(e.message || e).trim().split("\\n").pop() };',
      '}',
      'outcome.ms = Date.now() - started;',
      'outcome.byteAfter = view[0];',
      // The interpreter has to be worth keeping afterwards: an interrupt that
      // leaves a wedged interpreter is a crash with better manners.
      'try { outcome.stillWorks = py.runPython("1 + 1"); } catch (e) { outcome.stillWorks = "ERR " + e.message; }',
      'parentPort.postMessage(outcome);',
    ].join("\n"));

    const runOnce = (signal, delayMs, iterations) =>
      new Promise((resolve, reject) => {
        const sab = new SharedArrayBuffer(SAB_BYTES);
        const { ctrl } = makeViews(sab);
        const w = new Worker(workerFile, { workerData: { sab, iterations } });
        w.on("message", (m) => {
          if (m.ready) {
            setTimeout(() => postSignal(ctrl, signal), delayMs);
            return;
          }
          w.terminate();
          resolve(m);
        });
        w.on("error", reject);
        setTimeout(() => {
          w.terminate();
          resolve({ timedOut: true });
        }, 60000);
      });

    // Long enough that reaching the end would itself be the failure.
    const interrupted = await runOnce("SIGINT", 500, 400_000_000);
    ok(interrupted.type === "KeyboardInterrupt",
      `SIGINT reaches an interpreter that is not running any JS, as KeyboardInterrupt (${interrupted.type || interrupted.message || "no interrupt"})`);
    ok(interrupted.ms < 3000,
      `…promptly: the loop was stopped after ${interrupted.ms}ms, having been sent at 500ms`);
    ok(interrupted.byteAfter === 0,
      "…and the interpreter cleared the byte itself, so the next run does not inherit it");
    ok(interrupted.stillWorks === 2,
      `…leaving an interpreter that still works (1 + 1 = ${interrupted.stillWorks})`);

    // What the shell reports. 130 is 128+SIGINT, and it is how a script author
    // tells an interrupted run from a failed one.
    const asExit = terminationFromError({ type: "KeyboardInterrupt", message: "KeyboardInterrupt" });
    ok(asExit.code === 130, `an interrupted run exits 130, not 1 (${asExit.code})`);
    ok(terminationFromError({ type: "ValueError", message: "ValueError: nope" }).code === 1,
      "…and an ordinary exception still exits 1");

    // The negative control. If any signal interrupted the interpreter, the test
    // above would pass without the byte meaning anything.
    // Short enough to run to the end, because "it finished" is the result being
    // asserted — waiting out a timeout would prove the same thing far slower.
    const other = await runOnce("SIGTERM", 200, 20_000_000);
    ok(other.finished === true,
      `SIGTERM does not raise KeyboardInterrupt — only SIGINT is mirrored into the byte (${other.type || (other.timedOut ? "timed out" : "ran on")})`);
    {
      const sab = new SharedArrayBuffer(SAB_BYTES);
      const { ctrl } = makeViews(sab);
      postSignal(ctrl, "SIGTERM");
      ok(interruptView(sab)[0] === 0 && Atomics.load(ctrl, I_SIGNAL) === SIGNAL_BITS.SIGTERM,
        "…though it is still pending in the bitmask, where a guest's own JS will find it");
      postSignal(ctrl, "SIGINT");
      ok(interruptView(sab)[0] === 2,
        "SIGINT sets both: the byte for the interpreter, the bit for the guest");
      ok(Atomics.load(ctrl, I_SIGNAL) === (SIGNAL_BITS.SIGTERM | SIGNAL_BITS.SIGINT),
        "…and the bitmask is still a set, so the byte did not eat the other pending signal");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // --- breakpoints and stepping, in a real interpreter ---------------------
  if (spec.kind === "debug") {
    // The studio is not involved here and does not need to be: it speaks CDP to
    // whatever is on the other end, so the frontend below is a state machine
    // that answers each `Debugger.paused` with the commands a person clicking
    // Step Into would send. What is under test is that a real CPython, stopped
    // on a real line, can answer them — including the part that cannot be
    // faked, which is JS calling back INTO the interpreter while the
    // interpreter is inside a call out to JS.
    const { PY_DEBUG_SOURCE, createPythonDebugger } = await import(
      pathToFileURL(path.join(ROOT, "packages/runtime/builtins/python-debugger.js")).href
    );
    const FILE = "/projects/demo/main.py";
    py.FS.mkdirTree("/projects/demo");
    py.FS.writeFile(FILE, [
      "import json",                                    // 1
      "",                                               // 2
      "",                                               // 3
      "def add(a, b):",                                 // 4
      "    total = a + b",                              // 5
      "    return total",                               // 6
      "",                                               // 7
      "",                                               // 8
      "def run(rows):",                                 // 9
      "    acc = 0",                                    // 10
      "    for row in rows:",                           // 11
      "        acc = add(acc, row['n'])",               // 12
      "    return acc",                                 // 13
      "",                                               // 14
      "",                                               // 15
      "data = [{'n': 1}, {'n': 2}, {'n': 39}]",         // 16
      "answer = run(data)",                             // 17
      "print('answer', answer, json.dumps({'ok': 1}))", // 18
      "",
    ].join("\n"));
    py.runPython(PY_DEBUG_SOURCE);

    const events = [];
    const results = new Map();
    let cmdSeq = 0;
    let queue = [];
    const at = [];
    const ask = (method, params) => {
      const id = ++cmdSeq;
      queue.push({ id, method, params: params || {} });
      return id;
    };
    let localsId = 0;
    let evalId = 0;
    let rowId = 0;
    let expandId = 0;

    const dbg = createPythonDebugger({
      pyodide: py,
      roots: ["/projects/"],
      send: (msg) => {
        events.push(msg);
        if (msg.id != null) {
          results.set(msg.id, msg);
          // The second half of expanding a value: the scope came back, so now
          // ask for the object that was in it, and only then let the program go.
          if (msg.id === rowId) {
            const row = (msg.result.result || []).find((p) => p.name === "row");
            if (row && row.value.objectId) {
              expandId = ask("Runtime.getProperties", { objectId: row.value.objectId });
            }
            ask("Debugger.resume");
          }
          return;
        }
        if (msg.method !== "Debugger.paused") return;
        const frame = msg.params.callFrames[0];
        at.push(`${frame.functionName}:${frame.location.lineNumber + 1}`);
        // What a person does at each stop, in order.
        if (at.length === 1) {
          localsId = ask("Runtime.getProperties", {
            objectId: frame.scopeChain[0].object.objectId,
          });
          evalId = ask("Debugger.evaluateOnCallFrame", {
            callFrameId: frame.callFrameId,
            expression: "acc + rows[2]['n']",
          });
          ask("Debugger.stepInto");
        } else if (at.length === 2) {
          ask("Debugger.stepOver");
        } else if (at.length === 3) {
          ask("Debugger.stepOut");
        } else if (at.length === 4) {
          // Expanding a dict in the Variables panel is two round trips: the
          // scope, then the object inside it. They have to happen while the
          // program is still stopped — an objectId outlives nothing.
          rowId = ask("Runtime.getProperties", {
            objectId: frame.scopeChain[0].object.objectId,
          });
        }
      },
      // Empty means the frontend has nothing more to say, which must not park a
      // program forever — the real transport times out into the same answer.
      waitForCommand: () => (queue.length ? queue.shift() : { id: ++cmdSeq, method: "Debugger.resume" }),
    });
    dbg.attach();

    // Attach the way the studio does: enable, set a breakpoint, open the gate.
    dbg.onCommand({ id: ++cmdSeq, method: "Debugger.enable" });
    dbg.registerScript(FILE);
    const parsed = events.find((e) => e.method === "Debugger.scriptParsed");
    ok(parsed && parsed.params.url === "file://" + FILE,
      `the interpreter announced the script it is about to run (${parsed && parsed.params.url})`);

    // Line 3 is blank. A breakpoint there has to bind to the next line that
    // exists, or it would simply never be hit and nothing would say why.
    const bpBlank = ++cmdSeq;
    dbg.onCommand({ id: bpBlank, method: "Debugger.setBreakpointByUrl", params: { url: "file://" + FILE, lineNumber: 2 } });
    ok(results.get(bpBlank).result.locations[0].lineNumber + 1 === 4,
      "a breakpoint on a blank line binds to the next line the interpreter can stop on");
    dbg.onCommand({ id: ++cmdSeq, method: "Debugger.removeBreakpoint", params: { breakpointId: results.get(bpBlank).result.breakpointId } });

    const bpId = ++cmdSeq;
    dbg.onCommand({ id: bpId, method: "Debugger.setBreakpointByUrl", params: { url: "file://" + FILE, lineNumber: 11 } });
    ok(results.get(bpId).result.breakpointId, "a breakpoint on line 12 is accepted and bound");
    dbg.onCommand({ id: ++cmdSeq, method: "Runtime.runIfWaitingForDebugger" });

    let out = "";
    const prevOut = py.setStdout({ batched: (s) => (out += s + "\n") });
    py.runPython(
      `exec(compile(open(${JSON.stringify(FILE)}).read(), ${JSON.stringify(FILE)}, "exec"), {"__name__": "__main__"})`,
    );
    py.setStdout({ batched: () => {} });
    if (prevOut) py.setStdout({ batched: prevOut });

    ok(/answer 42/.test(out), `the program still ran to its answer through all of that (${out.trim()})`);
    ok(at[0] === "run:12", `it stopped at the breakpoint, in the function, on the right line (${at[0]})`);

    // Locals, which is the panel a person actually reads.
    const locals = results.get(localsId).result.result;
    const byName = Object.fromEntries(locals.map((p) => [p.name, p.value]));
    ok(byName.acc && byName.acc.value === 0 && byName.rows,
      `the local scope is the frame's own variables (${locals.map((p) => p.name).join(", ")})`);
    ok(byName.row && byName.row.description === "{'n': 1}",
      `…each described the way Python describes it (row = ${byName.row && byName.row.description})`);
    ok(!locals.some((p) => p.name === "__builtins__"),
      "…without __builtins__, which is 3 kB of noise in every module frame");

    // An expression, evaluated in the stopped frame's own scope.
    ok(results.get(evalId).result.result.value === 39,
      "an expression typed at the paused frame is evaluated in that frame's scope");

    // Stepping: into the callee, over a line inside it, back out to the caller.
    ok(at[1] === "add:5", `Step Into arrives in the function being called (${at[1]})`);
    ok(at[2] === "add:6", `…Step Over moves one line inside it (${at[2]})`);
    ok(at[3] === "run:11" || at[3] === "run:12",
      `…and Step Out comes back to the caller rather than the next callee (${at[3]})`);

    // Expanding a value: a dict's contents, fetched only when asked for, which
    // is what keeps a paused frame from having to describe the whole heap.
    const nested = (results.get(expandId) && results.get(expandId).result.result) || [];
    ok(nested.length === 1 && nested[0].name === "n" && nested[0].value.type === "number",
      `expanding a dict shows what is inside it (${nested.map((p) => p.name + "=" + (p.value.value ?? p.value.description)).join(", ")})`);

    ok(events.some((e) => e.method === "Debugger.resumed"),
      "and every pause was followed by a resume, so the frontend is never left thinking it is still stopped");
    dbg.close();

    // The cost of all this when nobody is debugging, which is the number that
    // decides whether it can be on by default.
    const timed = py.runPython(`
import time
def hot():
    t = 0
    for i in range(300000):
        t += i
    return t
t0 = time.time(); hot(); plain = time.time() - t0
import json as _j
_j.dumps(round(plain * 1000))
`);
    ok(Number(timed) >= 0, `with the tool detached, the interpreter is back to normal speed (${timed}ms for the same loop)`);
  }

  // --- the two checkers you run from a prompt, against the host's own ------
  if (spec.kind === "checkers") {
    // mypy and black ship as commands (coreutils PYTHON_DELEGATES), and both
    // claims are about matching a tool that exists outside this repo. So both
    // are run here twice: once the way the launcher runs them, once under the
    // host's CPython at the same pinned version, with the two required to agree.
    const scratch = path.join(SCRATCH, "checker-oracle");
    const lockPath = path.join(SCRATCH, "node_modules/pyodide/pyodide-lock.json");
    const mypyVersion = lockVersion(lockPath, "mypy");
    const pins = [
      { name: "mypy", version: mypyVersion },
      ...vendoredPyPIPins(path.join(ROOT, "scripts/vendor-pyodide.mjs")).filter((p) => p.name === "black"),
    ].filter((p) => p.version);
    ok(pins.length === 2, `pins read from the shipping config (${pins.map((p) => p.name + "==" + p.version).join(", ")})`);
    const oracle = ensureOracle(scratch, pins);
    ok(!oracle.error, oracle.error || "the host oracle installed the same mypy and black the browser gets");

    const FIXTURE =
      "def greet(name: str) -> str:\n" +
      "    return name\n" +
      "\n" +
      "def bad(x: int) -> str:\n" +
      "    return x\n" +
      "\n" +
      'greet(42)\n';
    const CLEAN = "def f(n: int) -> int:\n    return n + 1\n\n\nf(1)\n";
    mirrorIn({ "t.py": FIXTURE, "ok.py": CLEAN });
    // The same two files on the host, at the same names, so the oracle is
    // checking the identical source rather than a retyped copy of it.
    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-mypy-oracle-"));
    fs.writeFileSync(path.join(hostDir, "t.py"), FIXTURE);
    fs.writeFileSync(path.join(hostDir, "ok.py"), CLEAN);
    await ensure(["mypy"]);
    // Pyodide's lock declares mypy as depending on librt and nothing else. Ask a
    // real interpreter what that actually buys you, because DEPENDS_FIXUPS in
    // the vendor script is built entirely on the answer — and if upstream ever
    // fixes the metadata, this is the check that says the fixup is now dead
    // weight rather than load-bearing.
    const declared = py.runPython(`
try:
    from mypy import api
    api.run(["--version"])
    r = "nothing missing"
except ModuleNotFoundError as e:
    r = e.name
except Exception as e:
    r = type(e).__name__ + ": " + str(e)[:60]
r
`);
    ok(declared === "typing_extensions",
      `loadPackage("mypy") on its own leaves ${declared} missing — which is the whole reason the vendor script amends mypy's depends`);

    // Load what the SHIPPED fixup names, read out of the vendor script rather
    // than restated here, so this cannot pass against a list that has drifted.
    const vendorSrc = fs.readFileSync(path.join(ROOT, "scripts/vendor-pyodide.mjs"), "utf8");
    const fixBlock = /const DEPENDS_FIXUPS = \{([\s\S]*?)\n\};/.exec(vendorSrc);
    const fixups = fixBlock ? [...(/mypy:\s*\[([^\]]*)\]/.exec(fixBlock[1])?.[1] || "").matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
    ok(fixups.length === 3, `the vendor script names ${fixups.length} extra deps for mypy: ${fixups.join(", ")}`);
    await ensure(fixups);

    // Exactly the program doMypy() synthesises, so this tests the shipped seam
    // rather than a convenient paraphrase of it.
    const seam = (args) => {
      out.length = 0;
      let code = null;
      try {
        py.runPython(
          "import sys\n" +
          "from mypy import api\n" +
          `out, errs, code = api.run(${JSON.stringify(args)})\n` +
          "sys.stdout.write(out)\n" +
          "sys.stderr.write(errs)\n" +
          "sys.exit(code)\n",
        );
        code = 0;
      } catch (e) {
        if (e.pyodide_fatal_error) return { fatal: true };
        const m = /SystemExit: (\d+)/.exec(e.message || "");
        // Anything that is not a SystemExit is the run failing to happen, and
        // must not be reported as an exit code the checker chose.
        if (!m) return { crashed: (e.message || String(e)).trim().split("\n").pop() };
        code = Number(m[1]);
      }
      return { code, text: out.join("").trim() };
    };

    const FLAGS = ["--no-incremental", "--no-color-output", "--no-error-summary", "--cache-dir=/tmp/mypy-cache"];
    const bad = seam([...FLAGS, "t.py"]);
    ok(!bad.fatal, "the seam survives a run — api.run() does not reach the os._exit() that would take Emscripten down");
    ok(!bad.crashed, bad.crashed ? `the seam did not run: ${bad.crashed}` : "the seam ran to a SystemExit, the way the launcher expects");
    ok(bad.code === 1, `a file with type errors exits 1 (got ${bad.code}), so "mypy && deploy" cannot lie`);
    const hostBad = mypyCli(oracle.dir, ["t.py"], hostDir);
    ok(!hostBad.error, hostBad.error || "the host ran the same mypy on the same file");
    if (!hostBad.error) {
      ok(hostBad.status === bad.code, `the host agrees on the exit status (${hostBad.status})`);
      // Compare the diagnostics themselves, error codes included. These strings
      // are mypy's, not ours, which is the point of asking the host for them.
      ok(bad.text === hostBad.text,
        bad.text === hostBad.text
          ? `the diagnostics match the host's, verbatim:\n      | ${hostBad.text.split("\n").join("\n      | ")}`
          : `DIVERGED\n      browser: ${bad.text}\n      host:    ${hostBad.text}`);
    }

    const clean = seam([...FLAGS, "ok.py"]);
    ok(clean.code === 0 && !/error:/.test(clean.text), `a clean file exits 0 (got ${clean.code})`);
    // No target is mypy's own usage error, not a default we invented.
    const none = seam([]);
    ok(none.code === 2 && /Missing target module, package, files, or command/.test(none.text),
      `no arguments gives mypy's own usage error and exit 2 (got ${none.code})`);

    // black goes through plain runpy, which is what `python -m black` does.
    await ensure(["black"]);
    const UGLY = "x = {'a':1,   'b':2}\ndef f( a,b ):\n  return a+b\n";
    py.FS.writeFile(DIR + "/ugly.py", new TextEncoder().encode(UGLY));
    out.length = 0;
    let blackCode = 0;
    try {
      py.runPython(
        "import runpy, sys\n" +
        'sys.argv = ["black", "--quiet", "ugly.py"]\n' +
        'runpy._run_module_as_main("black")\n',
      );
    } catch (e) {
      if (e.pyodide_fatal_error) blackCode = -1;
      else { const m = /SystemExit: (\d+)/.exec(e.message || ""); blackCode = m ? Number(m[1]) : 0; }
    }
    ok(blackCode === 0, `black runs through plain runpy and exits 0 (got ${blackCode}) — no seam needed, unlike mypy`);
    const formatted = new TextDecoder().decode(py.FS.readFile(DIR + "/ugly.py"));
    const hostBlack = blackCli(oracle.dir, UGLY);
    ok(!hostBlack.error, hostBlack.error || "the host ran the same black");
    if (!hostBlack.error) {
      ok(formatted === hostBlack.text,
        formatted === hostBlack.text
          ? "the file black wrote in the VM is byte-identical to what black writes on this machine"
          : `DIVERGED\n      browser: ${JSON.stringify(formatted)}\n      host:    ${JSON.stringify(hostBlack.text)}`);
    }
  }

  // --- SystemExit end to end: real Pyodide in, real CPython's answer out ----
  if (spec.kind === "termination") {
    // No fixture here. Raise the SystemExit in CPython-on-WASM, catch whatever
    // Pyodide genuinely throws, and require the shim's verdict to equal what
    // the CPython on this machine does for the identical expression. That
    // closes both halves the offline tier can only check separately: that the
    // error shape we parse is the shape Pyodide really produces, and that the
    // verdict we draw from it is CPython's.
    for (const row of [...CPYTHON_EXITS, ...UNTRUNCATED]) {
      let t;
      try {
        await py.runPythonAsync("import sys\n" + row.expr);
        t = { code: "<no exception>", report: "" };
      } catch (e) {
        ok(String(e.message).trimEnd().split("\n").pop().trim() === row.traceback,
          `Pyodide raises ${JSON.stringify(row.traceback)} for ${row.expr}`);
        t = terminationFromError(e);
      }
      ok(t.code === row.code && t.report === row.report,
        `${row.expr} -> exit ${t.code}, prints ${JSON.stringify(t.report)}`);
    }
    // And the case the exit-code path must never swallow.
    try {
      await py.runPythonAsync("raise ValueError('nope')");
      ok(false, "raise ValueError should not have completed normally");
    } catch (e) {
      const t = terminationFromError(e);
      ok(t.code === 1, "an unhandled exception still exits 1, as CPython does");
      ok(/Traceback/.test(t.report) && /ValueError: nope/.test(t.report),
        "…and keeps its whole traceback, rather than being quietly swallowed");
    }
  }

  // --- the WSGI environ, against CPython's own PEP 3333 validator -----------
  if (spec.kind === "wsgi-environ") {
    py.FS.mkdirTree(DIR);
    py.FS.chdir(DIR);
    py.runPython(`import sys\nif ${JSON.stringify(DIR)} not in sys.path: sys.path.insert(0, ${JSON.stringify(DIR)})`);
    // wsgiref.validate ships with the interpreter and encodes PEP 3333's own
    // rules, so wrapping our app in it makes CPython the judge of whether the
    // environ we build is conformant — rather than us asserting that our
    // environ is the environ we meant to build.
    py.FS.writeFile(DIR + "/wsgiprobe.py", new TextEncoder().encode(
      "from wsgiref.validate import validator\n" +
      "\n" +
      "CAPTURED = {}\n" +
      "\n" +
      "def _inner(environ, start_response):\n" +
      "    CAPTURED.clear()\n" +
      "    CAPTURED.update(environ)\n" +
      "    start_response('200 OK', [('Content-Type', 'text/plain')])\n" +
      "    return [b'ok']\n" +
      "\n" +
      "app = validator(_inner)\n",
    ));
    await py.runPythonAsync(setupSource("wsgiprobe", "app", "wsgi"));
    const dispatch = py.globals.get("_vv_dispatch");
    const res = JSON.parse(await dispatch(JSON.stringify({
      method: "GET", path: "/notes/1/", query: "a=1",
      headers: [["host", "localhost"]], http_version: "1.1",
      root_path: PREFIX, body_b64: "",
    })));
    ok(res.status === 200, `wsgiref.validate accepts the environ the bridge builds (status ${res.status})`);
    const env = JSON.parse(py.runPython([
      "import json, wsgiprobe",
      "_e = wsgiprobe.CAPTURED",
      "json.dumps({k: _e.get(k) for k in ('SCRIPT_NAME', 'PATH_INFO', 'QUERY_STRING', 'REQUEST_METHOD')})",
    ].join("\n")));
    // PEP 3333: "SCRIPT_NAME + PATH_INFO would be the full request URI path".
    ok(env.SCRIPT_NAME === PREFIX, `PEP 3333: SCRIPT_NAME is the mount prefix (${JSON.stringify(env.SCRIPT_NAME)})`);
    ok(env.PATH_INFO === "/notes/1/", `PEP 3333: PATH_INFO is the app-relative path (${JSON.stringify(env.PATH_INFO)})`);
    ok(env.SCRIPT_NAME + env.PATH_INFO === PREFIX + "/notes/1/", "PEP 3333: SCRIPT_NAME + PATH_INFO reconstructs the request path");
    ok(env.QUERY_STRING === "a=1", `PEP 3333: QUERY_STRING excludes the '?' (${JSON.stringify(env.QUERY_STRING)})`);
  }

  // --- Python's HTTP, and the masquerade that was switching it off ----------
  if (spec.kind === "urllib3-realm") {
    // `requests` in Pyodide does not use sockets. urllib3's Emscripten transport
    // chooses at request time, and one of its branches asks whether this is Node
    // by reading js.process.release.name — which our runtime sets to "node" on
    // purpose. This case proves the whole chain against REAL urllib3: what it
    // does untouched, what the shipped patch changes, and — the assertion that
    // stops the patch becoming a lie in the other direction — what it must NOT
    // change here, where the answer "this is Node" is simply true.
    await ensure(["requests"]);
    const P = (code) => py.runPythonAsync(code);

    // First, the half of the offline tier's bargain that only a live interpreter
    // can keep. spike-python-offline.mjs runs the shipped patch against a
    // stand-in for this module, because urllib3's Emscripten transport exists
    // nowhere but inside Pyodide — and a test against a fixture we wrote is a
    // test of our own opinion unless something checks the fixture. This is that
    // something: every fragment the stand-in copies, found in the real source.
    const realSrc = String(await P("import inspect, urllib3.contrib.emscripten.fetch as f\ninspect.getsource(f)"));
    for (const { label, source } of MODELLED_FRAGMENTS) {
      ok(normalize(realSrc).includes(normalize(source)),
        `real urllib3 (${String(await P("import urllib3\nurllib3.__version__"))}) still defines ${label} exactly as the offline stand-in models it`);
    }
    // The mechanism the fix is FOR, read off urllib3 rather than modelled: the
    // branch that refuses, and the synchronous XHR it refuses in favour of.
    ok(/elif is_in_node\(\):\s*\n\s*raise _RequestError\(/.test(realSrc),
      "…and that send_request still refuses outright when is_in_node() is true");
    ok(/js_xhr = js\.XMLHttpRequest\.new\(\)/.test(realSrc) && /js_xhr\.open\([^)]*False\)/.test(realSrc),
      "…in favour of a SYNCHRONOUS XMLHttpRequest, which is what a Worker has and Node has not");
    // Keep urllib3's OWN function, so the counterfactual below restores the real
    // thing rather than a replica of it written by us.
    await P("import urllib3.contrib.emscripten.fetch as f\nf._vv_pristine = f.is_in_node");
    const get = async (url) => String(await P(`
import requests
try:
    _r = requests.get(${JSON.stringify(url)})
    _out = "OK " + str(_r.status_code) + " " + _r.text[:60] + " ct=" + str(_r.headers.get("content-type"))
except BaseException as e:
    _out = type(e).__name__ + ": " + str(e)[:160]
_out
`));
    const isInNode = async () => String(await P("from urllib3.contrib.emscripten.fetch import is_in_node\nstr(is_in_node())"));

    // -- this really is Node, and urllib3 is right about that -----------------
    const jspi = String(await P("from urllib3.contrib.emscripten.fetch import has_jspi\nstr(has_jspi())")) === "True";
    ok(await isInNode() === "True", "real Node, untouched: urllib3's is_in_node() is True");
    if (jspi) {
      // node --experimental-wasm-stack-switching: send_request never reaches the
      // is_in_node branch. Say so rather than asserting something else's absence.
      console.log("      | JSPI is enabled in this Node, so the Node/JSPI error branch is unreachable here");
    } else {
      ok(/only works in Node\.js/.test(await get("https://example.invalid/x")),
        "…and requests raises urllib3's own Node/JSPI error");
    }

    // -- the patch must not lie about a realm that IS Node --------------------
    ok(installUrllib3RealmPatch(py), "the shipped installer applied the patch");
    // This interpreter is also the REPL. Our plumbing must not be sitting in the
    // namespace a user's dir() reports.
    ok(String(await P('[n for n in dir() if n.startswith("_vv") or n.startswith("_Vv")]')) === "[]",
      "…without leaving any of its own names in __main__");
    ok(await isInNode() === "True", "with the shipped patch applied, is_in_node() is STILL True in real Node");
    ok(String(await P('import urllib3.contrib.emscripten.fetch as f\nstr(getattr(f.is_in_node, "_vv_realm_derived", False))')) === "False",
      "…because the patch left the function alone entirely, rather than wrapping it to return the same answer");
    if (!jspi) {
      ok(/only works in Node\.js/.test(await get("https://example.invalid/x")),
        "…so the honest Node error still reaches the user");
    }

    // -- a browser dedicated Worker, as Vivari runs one -----------------------
    // No `window`; cross-origin isolated (Vivari needs SharedArrayBuffer, so
    // COOP/COEP are on); Worker + Blob present; and a real SYNCHRONOUS
    // XMLHttpRequest, which is the transport urllib3 wants and Node has not.
    // The response is canned: the claim under test is that the transport is
    // reached and its answer is translated, not that some third party is up.
    const BODY = '{"hello":"from a synchronous XHR"}';
    const xhr = { calls: 0, async: null, method: null, url: null };
    globalThis.XMLHttpRequest = class {
      constructor() { this.status = 0; this.response = null; this.responseType = ""; }
      open(m, u, isAsync) { xhr.method = m; xhr.url = u; xhr.async = isAsync; }
      setRequestHeader() {}
      overrideMimeType() {}
      getAllResponseHeaders() { return "content-type: application/json\r\n"; }
      send() { xhr.calls++; this.status = 200; this.response = new TextEncoder().encode(BODY); }
    };
    globalThis.crossOriginIsolated = true;
    globalThis.Blob = globalThis.Blob || class {};
    globalThis.Worker = globalThis.Worker || class {};

    // A sentinel for _StreamingFetcher, so "the gate was re-evaluated" is
    // observable without depending on Blob/URL/Worker plumbing only a browser
    // really has. That the real one constructs is a browser-tier question.
    await P([
      "import urllib3.contrib.emscripten.fetch as f",
      "class _Sentinel:",
      "    def __init__(self): self.streaming_ready = False",
      "f._StreamingFetcher = _Sentinel",
      "f._fetcher = None",
    ].join("\n"));
    installUrllib3RealmPatch(py);

    ok(await isInNode() === "False", "browser-Worker realm: is_in_node() is now False");
    ok(String(await P("import urllib3.contrib.emscripten.fetch as f\nstr(type(f._fetcher).__name__)")) === "_Sentinel",
      "…and _fetcher was re-decided, so streaming is not left off by the evaluation the old gate made at import time");

    xhr.calls = 0;
    let r = await get("https://example.invalid/items");
    ok(r.startsWith("OK 200"), `requests.get() returns a real response (${r.slice(0, 48)})`);
    ok(r.includes("from a synchronous XHR"), "…carrying the body urllib3 read off the transport");
    ok(r.includes("ct=application/json"), "…and the response headers it parsed");
    ok(xhr.calls === 1, `…through exactly ${xhr.calls} XMLHttpRequest call`);
    ok(xhr.async === false, `…opened synchronously — open(${JSON.stringify(xhr.method)}, …, ${xhr.async})`);

    // -- same realm, only the predicate varying -------------------------------
    // The both-ways proof: hold everything else still and put urllib3's own
    // is_in_node back, so what is being measured is the gate and nothing else.
    await P("import urllib3.contrib.emscripten.fetch as f\nf._vv_fixed = f.is_in_node\nf.is_in_node = f._vv_pristine");
    xhr.calls = 0;
    r = await get("https://example.invalid/items");
    ok(/only works in Node\.js/.test(r), "restoring urllib3's OWN is_in_node breaks the SAME realm again");
    ok(xhr.calls === 0, "…without the transport ever being reached");
    await P("import urllib3.contrib.emscripten.fetch as f\nf.is_in_node = f._vv_fixed");
    ok((await get("https://example.invalid/items")).startsWith("OK 200"), "…and the realm-derived predicate makes it 200 again");

    // -- the re-enabled streaming gate must not be able to break requests -----
    await P([
      "import urllib3.contrib.emscripten.fetch as f",
      "def _boom(): raise RuntimeError('no nested worker here')",
      "f._StreamingFetcher = _boom",
      "f._fetcher = None",
      "f.is_in_node = f._vv_pristine",
    ].join("\n"));
    installUrllib3RealmPatch(py);
    ok(String(await P("import urllib3.contrib.emscripten.fetch as f\nstr(f._fetcher)")) === "None",
      "a _StreamingFetcher that throws leaves _fetcher None");
    ok((await get("https://example.invalid/items")).startsWith("OK 200"),
      "…and the buffered transport still works, so the streaming re-run cannot cost us the fix");

    // -- the other two doors, which the docs now claim outright ---------------
    // These need no patch and never did; they are asserted because python.md
    // states them, and a docs claim with nothing behind it is how this started.
    delete globalThis.XMLHttpRequest;
    const ping = "https://cdn.jsdelivr.net/pyodide/v" + (process.env.VV_PYODIDE_VERSION || "") + "/full/pyodide-lock.json";
    for (const [label, code] of [
      ["pyodide.http.pyfetch", `from pyodide.http import pyfetch\n_r = await pyfetch(${JSON.stringify(ping)})\nstr(_r.status)`],
      ["js.fetch", `import js\n_r = await js.fetch(${JSON.stringify(ping)})\nstr(_r.status)`],
    ]) {
      let status;
      try { status = String(await P(code)); } catch (e) { status = String(e.message || e).split("\n").pop(); }
      ok(status === "200", `${label} reaches the network from Python with no patching at all (${status})`);
    }
  }


  // --- where the package loader writes, and which Python this is ------------
  if (spec.kind === "loader-streams") {
    // Two claims the offline tier has to take on trust, checked here against the
    // real thing.
    //
    // FIRST: that scripts/lib/fake-pyodide.mjs models the loader honestly. The
    // offline gate on `pip freeze`'s stdout is only worth anything if the
    // stand-in emits progress where Pyodide really emits it — a stand-in that
    // quietly printed nothing would keep passing over the exact bug it exists
    // to catch. So: the default really does go to the interpreter's stdout
    // stream (NOT console.log, which is the intuitive guess and is wrong), a
    // messageCallback really does divert it, and the bytes really are the ones
    // the stand-in writes.
    const captured = [];
    const capture = (tag) => ({ write: (b) => { captured.push(tag + Buffer.from(b).toString("utf8")); return b.length; } });
    py.setStdout(capture(""));
    py.setStderr(capture("ERR:"));

    await py.loadPackage("packaging");
    ok(captured.join("") === "Loading packaging\nLoaded packaging\n",
      `with no messageCallback, loader progress goes to the interpreter's STDOUT: ${JSON.stringify(captured)}`);
    ok(!captured.some((c) => c.startsWith("ERR:")), "…and none of it to stderr, which is what put it in front of pip's payload");

    // The exact bytes the offline stand-in claims to produce.
    ok(captured.join("") === loaderLines(["packaging"]).map((l) => l + "\n").join(""),
      "…and fake-pyodide.mjs writes those same bytes, so the offline gate is testing the real shape");

    captured.length = 0;
    const said = [];
    await py.loadPackage("micropip", { messageCallback: (m) => said.push(m) });
    ok(said.join("|") === "Loading micropip|Loaded micropip", `a messageCallback receives the progress instead: ${JSON.stringify(said)}`);
    ok(captured.length === 0, "…and the interpreter's stdout stays clean, which is the whole fix");
    ok(said.join("|") === loaderLines(["micropip"]).join("|"), "…still the bytes the stand-in models");

    // SECOND: the version literal /bin/python.js prints without booting. The
    // offline tier pins that literal to PYODIDE_PYTHON_VERSION; only a live
    // interpreter can say whether the constant is still true. Bump the vendored
    // Pyodide and this is what notices.
    const env = pyEnv(py);
    ok(env.pythonVersion === PYODIDE_PYTHON_VERSION,
      `the vendored interpreter is Python ${env.pythonVersion}, and PYODIDE_PYTHON_VERSION says ${PYODIDE_PYTHON_VERSION}`);
    const printed = drivePython(["--version"]).out.trim();
    ok(printed.includes(env.pythonVersion),
      `python --version prints "${printed}", which carries the version this interpreter reports`);
    ok(printed === `Python ${env.pythonVersion} (Pyodide, Vivari)`,
      "…in full, so it does not disagree with `sys.version` the way `Python 3.14` did");
  }

  // --- the per-project package store ----------------------------------------
  if (spec.kind === "package-store") {
    // Every python command is a fresh Pyodide boot, so an install used to be
    // gone by the next one. This case is the whole claim end to end, against
    // real wheels and real interpreters: install into A, restore into B, and
    // watch an unrestored C not have it. It boots more than one interpreter on
    // purpose — a store that works within a process would prove nothing, since
    // that is exactly the case that already worked.
    //
    // It drives the SHIPPED store functions (packages/runtime/builtins/
    // python-store.js) with node:fs where the runtime passes the guest's, which
    // is what makes spike-python-offline.mjs's stub interpreter honest: the same
    // functions run there against a fake FS and here against a real one.
    const OS = await import("node:os");
    const PROJ = fs.mkdtempSync(path.join(OS.tmpdir(), "vv-store-"));
    const quiet = { messageCallback: () => {} };
    const importable = async (interp, mod) => String(await interp.runPythonAsync(
      "\ntry:\n    import " + mod + "; _o = 'yes'\nexcept BaseException as e:\n    _o = type(e).__name__\n_o\n")) === "yes";

    // -- A: install, then keep the delta --------------------------------------
    const A = py;
    await A.loadPackage(["micropip"], quiet);
    const envA = pyEnv(A);
    ok(envA.pyTag === "python3.14" && envA.pythonVersion.startsWith("3.14"),
      `the store's identity comes from the interpreter: ${envA.pyTag}, Python ${envA.pythonVersion}, Pyodide ${envA.pyodideVersion}`);
    const baseline = walkPyodide(A, envA.sitePackages);
    // A dashed project name on purpose. An install escapes it before naming the
    // directory (charset_normalizer-*.dist-info), and matching on
    // `${name}-${version}` instead of the reported directory drops every such
    // package from `pip freeze` — found here by real pip, not by inspection.
    await A.runPythonAsync('import micropip\nawait micropip.install(["tabulate", "charset-normalizer"])');
    const delta = collectDelta(A, envA, baseline);
    ok(delta.size > 0, `the install added ${delta.size} files to site-packages`);
    ok(![...delta.keys()].some((r) => r.startsWith("micropip")),
      "…and micropip is not among them: it was loaded before the baseline, so our own machinery never lands in a user's store");

    const t0 = Date.now();
    const wrote = persistDelta(fs, A, PROJ, envA, delta, "python -m pip install tabulate charset-normalizer");
    ok(wrote.ok, `snapshot: ${wrote.files} files, ${humanBytes(wrote.bytes)}, ${Date.now() - t0} ms`);
    const paths = storePaths(PROJ, envA.pyTag);
    ok(fs.existsSync(paths.sitePackages + "/tabulate/__init__.py"),
      "the bytes are on disk under .venv/lib/python3.14/site-packages, where a Python user would look for them");
    ok(fs.existsSync(paths.cfg) && /include-system-site-packages = true/.test(fs.readFileSync(paths.cfg, "utf8")),
      "…beside a pyvenv.cfg that does not claim an isolation this model cannot provide");

    // -- B: a second interpreter, which restores -------------------------------
    const B = await loadPyodide();
    ok(!(await importable(B, "tabulate")), "a fresh interpreter starts without the package (this is the problem the store solves)");
    const t1 = Date.now();
    const restored = restoreStore(fs, B, PROJ);
    ok(restored.state === "restored", `restore: ${restored.files} files, ${Date.now() - t1} ms — against a ~1400 ms interpreter boot`);
    ok(await importable(B, "tabulate"), "and now it imports");
    ok(String(await B.runPythonAsync(
      'from tabulate import tabulate\ntabulate([[1,2]], headers=["a","b"]).splitlines()[0].strip()')) === "a    b",
      "…and runs: the package works, not merely resolves");
    ok(await importable(B, "charset_normalizer"), "the dashed-name package imports too");

    // -- C: a third interpreter, which does not ---------------------------------
    const C = await loadPyodide();
    ok(!(await importable(C, "tabulate")),
      "a third interpreter that does not restore still has nothing — the store is per-project state, not a global side effect");

    // -- the stamp: discard, never half-load -----------------------------------
    const good = JSON.parse(fs.readFileSync(paths.stamp, "utf8"));
    for (const [field, value, why] of [
      ["pythonVersion", "3.13.0", "a store built by an older Python"],
      ["pyodideVersion", "0.26.0", "a store built under an older Pyodide"],
    ]) {
      fs.writeFileSync(paths.stamp, JSON.stringify({ ...good, [field]: value }));
      const D = await loadPyodide();
      const rd = restoreStore(fs, D, PROJ);
      ok(rd.state === "discarded", `${why} is refused: ${rd.problem}`);
      ok(!(await importable(D, "tabulate")),
        "…with nothing copied in at all — the half-restored tree is the outcome this exists to prevent");
    }
    fs.writeFileSync(paths.stamp, JSON.stringify(good));

    // -- the cap, and that hitting it changes nothing ---------------------------
    const beforeCap = walkHost(fs, paths.sitePackages);
    const E = await loadPyodide();
    await E.loadPackage(["micropip"], quiet);
    const envE = pyEnv(E);
    restoreStore(fs, E, PROJ);
    const base2 = walkPyodide(E, envE.sitePackages);
    await E.runPythonAsync('import micropip\nawait micropip.install(["six"])');
    const delta2 = collectDelta(E, envE, base2);
    const refused = persistDelta(fs, E, PROJ, envE, delta2, "cmd", 1024);
    ok(refused.ok === false, `a real install over a deliberately tiny cap is refused (${humanBytes(refused.projected)} against 1.0 KB)`);
    const afterCap = walkHost(fs, paths.sitePackages);
    ok(afterCap.size === beforeCap.size && [...afterCap].every(([k, v]) => beforeCap.get(k) === v),
      `…and the store is byte-for-byte unchanged (${afterCap.size} files), so a too-large install costs the user nothing`);
    ok(persistDelta(fs, E, PROJ, envE, delta2, "cmd").ok, "…while the same delta under the real cap writes normally");

    // -- pip freeze against the store it claims to describe ---------------------
    const F = await loadPyodide();
    await F.loadPackage(["packaging", "micropip"], quiet);
    const envF = pyEnv(F);
    restoreStore(fs, F, PROJ);
    const data = JSON.parse(await F.runPythonAsync(DIST_QUERY));
    ok(data.requirementsAvailable,
      "dependency metadata is readable, so Requires and pip check are answers rather than blanks");
    const dists = storeDists(fs, PROJ, envF, data.dists);
    const freeze = formatPipFreeze(dists);
    // The oracle is the store's own directory listing. Escaping runs one way
    // only (charset-normalizer -> charset_normalizer), so each freeze line is
    // escaped and looked for, rather than inverting an ambiguous mapping.
    const onDisk = new Set(fs.readdirSync(paths.sitePackages).filter((n) => n.endsWith(".dist-info")));
    const lines = freeze.trim().split("\n").filter(Boolean);
    const claimed = new Set(lines.map((l) => {
      const [n, v] = l.split("==");
      return n.replace(/[^A-Za-z0-9.]+/g, "_") + "-" + v + ".dist-info";
    }));
    ok(onDisk.size > 0 && onDisk.size === claimed.size && [...onDisk].every((x) => claimed.has(x)),
      `pip freeze accounts for every distribution in the store and invents none: ${lines.join(" ")}`);
    ok(!/^(micropip|packaging)==/m.test(freeze),
      "…and omits micropip and packaging, which this interpreter has and the store does not");
    ok(lines.every((l) => /^[A-Za-z0-9._-]+==[^=\s]+$/.test(l)),
      "…in real pip's exact `name==version` form, which is what makes `pip freeze > requirements.txt` mean anything");
    console.log(formatPipList(dists).replace(/^/gm, "      | ").replace(/\n$/, ""));

    // pip show and pip check over real metadata. The formatters are held against
    // real pip's bytes in the offline tier; what only a live interpreter can
    // show is that DIST_QUERY finds anything to format.
    const shown = formatPipShow(dists.find((d) => d.name === "tabulate"));
    ok(/^Name: tabulate$/m.test(shown) && /^Version: /m.test(shown) && /^Summary: Pretty-print/m.test(shown),
      "pip show reads real dist metadata out of the restored store");
    ok(/^Location: \/lib\/python3\.14\/site-packages$/m.test(shown),
      "…and reports the interpreter's site-packages as the location, which is where the package really is");
    ok(formatPipCheck(data.problems.filter((x) => dists.some((d) => d.name === x.name))) === "No broken requirements found.\n",
      "pip check over a store whose dependencies are all present says so, in real pip's words");

    // -- uninstall, which has to reach the store and not just the interpreter --
    const G = await loadPyodide();
    // Captured from STDOUT, and redirected BEFORE micropip is imported.
    // micropip's handler is a StreamHandler(sys.stdout) built once, on first use,
    // so it holds whatever sys.stdout was then — capture stderr, or redirect
    // afterwards, and nothing arrives, which is an assertion that passes for the
    // wrong reason. Both mistakes were made here before this comment existed.
    const noise = [];
    G.setStdout({ write: (b) => { noise.push(Buffer.from(b).toString()); return b.length; } });
    await G.loadPackage(["micropip"], quiet);
    const envG = pyEnv(G);
    restoreStore(fs, G, PROJ);
    const beforeRm = walkPyodide(G, envG.sitePackages);
    // Through the SHIPPED uninstall source, so what is measured below is what a
    // user gets. micropip warns "not found in loadedPackages" for anything it did
    // not load itself, which for a store-restored package is all of them — a
    // warning describing the store working, printed beside our success line.
    noise.length = 0;
    const realWarn = console.warn;
    console.warn = (...a) => noise.push(a.join(" "));
    try { G.runPython(uninstallSource("tabulate")); } finally { console.warn = realWarn; }
    ok(!/not found in loadedPackages/.test(noise.join("")),
      "the uninstall does not print micropip's loadedPackages warning, which is guaranteed and meaningless for a stored package");
    const afterRm = walkPyodide(G, envG.sitePackages);
    const gone = [...beforeRm.keys()].filter((r) => !afterRm.has(r));
    ok(gone.length > 0, `micropip.uninstall removed ${gone.length} files from the interpreter`);
    for (const rel of gone) { try { fs.unlinkSync(paths.sitePackages + "/" + rel); } catch { /* not stored */ } }
    ok(!fs.existsSync(paths.sitePackages + "/tabulate/__init__.py"),
      "…and the same files are removed from the STORE — an uninstall that only emptied the interpreter would come back on the next command");
    const H = await loadPyodide();
    restoreStore(fs, H, PROJ);
    ok(!(await importable(H, "tabulate")), "a fresh interpreter restoring the store no longer has it");
    ok(await importable(H, "charset_normalizer"), "…and still has everything else, so uninstall removed one package rather than the store");

    fs.rmSync(PROJ, { recursive: true, force: true });
  }

  console.log(failed ? `CASE ${name}: FAIL (${failed})` : `CASE ${name}: PASS`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Parent process.
// ---------------------------------------------------------------------------
console.log("== shipped template sources ==");
const templates = await readShippedTemplates(readTemplatesSource());
for (const id of Object.keys(CASES)) {
  if (CASES[id].synthetic) continue; // drives a purpose-built app, not a template
  const t = templates[id];
  ok(t && Object.keys(t).length > 0, `templates.ts still defines ${id} (${Object.keys(t || {}).length} files)`);
}
ok(!!templates["fastapi"] && !!templates["flask"], "the pre-existing python templates still parse too");

console.log("== python -m argv seams (no Pyodide needed) ==");
{
  // Shared with the offline tier, which gates the same seams on every PR.
  const drive = drivePython;
  const ENV = DRIVE_ENV;

  let r = drive(["-m", "gunicorn", "wsgi:application", "--bind", "0.0.0.0:8000"], ENV);
  ok(r.calls[0]?.[0] === "serve", "gunicorn calls serve()");
  ok(r.calls[0]?.[1]?.app === "wsgi:application", "gunicorn passes the app spec through");
  ok(r.calls[0]?.[1]?.mode === "wsgi", "gunicorn serves WSGI");
  ok(r.calls[0]?.[1]?.port === 8000, "gunicorn parses --bind host:port");

  r = drive(["-m", "gunicorn", "-w", "4", "--worker-class", "sync", "wsgi:app"], ENV);
  ok(r.calls[0]?.[1]?.app === "wsgi:app", "gunicorn does not mistake a --workers value for the app");

  r = drive(["-m", "gunicorn"], ENV);
  ok(r.calls.length === 0 && /no app specified/.test(r.out), "gunicorn without an app errors");

  r = drive(["-m", "pytest", "-q", "tests"], ENV);
  ok(r.calls[0]?.[0] === "runCode", "pytest goes through the ordinary script path");
  ok(r.calls[0]?.[1]?.includes('sys.exit(int(pytest.main(["-q","tests"])))'), "pytest forwards argv and propagates the exit code");

  // `-m numpy` used to be rejected by an allowlist. numpy is a module the
  // interpreter can import, so it goes to runpy now — and runpy is what decides
  // whether it has a __main__, which is CPython's answer rather than ours.
  r = drive(["-m", "numpy"], ENV);
  ok(r.calls[0]?.[0] === "runModule" && r.calls[0]?.[1] === "numpy", "an ordinary -m module is handed to runpy, not refused");
  r = drive(["-m", "smtplib"], ENV);
  ok(r.calls.length === 0 && /TCP socket/.test(r.out), "…but a socket-bound one is refused, with the reason");

  ok(typeof COREUTILS.gunicorn === "string" && COREUTILS.gunicorn.includes("'-m', 'gunicorn'"), "gunicorn is on PATH");
  ok(typeof COREUTILS.pytest === "string" && COREUTILS.pytest.includes("'-m', 'pytest'"), "pytest is on PATH");
  // programs/python.js is embedded as a template string, so it must stay free of
  // backticks, ${...} and backslashes.
  for (const bad of ["`", "${", "\\"]) {
    ok(!PYTHON_PROGRAM.includes(bad), `the python program source contains no ${JSON.stringify(bad)}`);
  }
}

// SystemExit is checked in the `termination` case below rather than here: this
// tier has a real interpreter, so it can raise the exception for real instead
// of asserting against a hand-written error object. The offline tier keeps the
// fixture table, re-derived there from the CPython on the machine.

// Provision Pyodide the same way scripts/vendor-pyodide.mjs does.
if (!fs.existsSync(PYODIDE_ENTRY)) {
  console.log(`\n== installing pyodide into ${SCRATCH} (needs network) ==`);
  fs.mkdirSync(SCRATCH, { recursive: true });
  try {
    execSync("npm install pyodide --no-save --no-audit --no-fund --loglevel=error", {
      cwd: SCRATCH, stdio: ["ignore", "ignore", "inherit"],
    });
  } catch (e) {
    console.error("Failed to install pyodide: " + ((e && e.message) || e));
    process.exit(2);
  }
}
const version = JSON.parse(
  fs.readFileSync(path.join(SCRATCH, "node_modules/pyodide/package.json"), "utf8"),
).version;
console.log(`\n== driving real Pyodide ${version} ==`);

const filters = process.argv.slice(2).filter((a) => !a.startsWith("-") && !a.includes("node_modules"));
const names = Object.keys(CASES).filter((n) => !filters.length || filters.some((f) => n.includes(f)));

const results = [];
for (const name of names) {
  const started = Date.now();
  const code = await new Promise((resolve) => {
    const child = fork(fileURLToPath(import.meta.url), [], {
      cwd: ROOT, env: { ...process.env, VV_SPIKE_CASE: name, VV_PYODIDE_VERSION: version }, stdio: "inherit",
    });
    child.on("close", (c) => resolve(c | 0));
  });
  results.push({ name, pass: code === 0, secs: ((Date.now() - started) / 1000).toFixed(1) });
}

console.log("\n──────────── python spike summary ────────────");
for (const r of results) console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(20)} (${r.secs}s)`);
const bad = results.filter((r) => !r.pass).length;
console.log(`  ${results.length - bad}/${results.length} cases passed, ${failed} in-process assertion(s) failed`);
console.log(
  "\nNOTE: this proves Python semantics and the bridge's protocol conversion only.\n" +
  "Port registration, the preview tunnel, wheel delivery and terminal rendering\n" +
  "need a browser — which is why all seven templates ship `experimental`.",
);
process.exit(bad || failed ? 1 : 0);