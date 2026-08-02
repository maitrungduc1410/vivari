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
// and — against real urllib3 — that Python's outbound HTTP works once our own
// Node masquerade stops answering urllib3's realm question for it. It drives the
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
import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PYTHON_PROGRAM } from "../packages/kernel-host/programs/python.js";
import { COREUTILS } from "../packages/kernel-host/coreutils.js";
import {
  byteWriter,
  installUrllib3RealmPatch,
  flushStreams,
  setupSource,
  terminationFromError,
} from "../packages/runtime/builtins/python.js";
import { readShippedTemplates, readTemplatesSource } from "./lib/shipped-templates.mjs";
import { CPYTHON_EXITS, UNTRUNCATED } from "./lib/cpython-exit.mjs";
import { MODELLED_FRAGMENTS, normalize } from "./lib/urllib3-emscripten.mjs";
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

// ---------------------------------------------------------------------------
// Cases. `kind` picks the driver in the child process.
// ---------------------------------------------------------------------------
const CASES = {
  "python-sqlite": {
    kind: "script", entry: "main.py",
    stdout: [/Books per author/, /Le Guin\s+2 book\(s\), earliest 1968/, /Ada\s+A Wizard of Earthsea/, /3 of 5 books were published before 1970/],
    wrote: ["library.db"],
  },
  "python-imaging": {
    kind: "script", entry: "main.py",
    stdout: [/Wrote art\.png \(640x360\)/, /Wrote thumb\.png \(160x90\)/],
    wrote: ["art.png", "thumb.png"], png: ["art.png", "thumb.png"],
  },
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

  r = drive(["-m", "numpy"], ENV);
  ok(/not supported/.test(r.out) && /gunicorn/.test(r.out) && /pytest/.test(r.out), "an unknown -m module is still rejected, and lists the new ones");

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