// The Python runtime shim — a lazily-booted Pyodide (CPython/WASM) interpreter
// exposed to the in-VM `python` program (packages/kernel-host/programs/python.js).
//
// Like Bun (packages/runtime/builtins/bun.js), Python cannot be run the way
// npm/yarn are (pure-JS CLIs Vivari vendors + executes): it is CPython compiled
// to WebAssembly. So this is a purpose-built plug-in that boots Pyodide the FIRST
// time a `python` process runs — nothing is paid at studio boot, and a plain
// `node`/`bun` process never touches Pyodide (the `Bun`-style `__ocInstallPython`
// global is only invoked by the `python` launcher). See ARCHITECTURE.md.
//
// WHY WE MASK THE ENVIRONMENT DURING BOOT: our runtime masquerades as Node —
// process.release.name is "node" and process.versions.node is set
// (packages/runtime/builtins/process.js) — but we actually run inside a real
// *module* Web Worker where the vendored Pyodide files are only reachable over
// same-origin fetch. Pyodide has TWO independent Node probes that would each try
// `await import("node:module")` (which 404s in the worker):
//   * pyodide.mjs (loader):  IN_NODE = … && !process.browser  → we set
//     process.browser = true so it resolves to IN_BROWSER_WEB_WORKER (fetch).
//   * pyodide.asm.mjs (Emscripten): ENVIRONMENT_IS_NODE = process.versions.node
//     && process.type != "renderer"  → we set process.type = "renderer" (an
//     Electron renderer is treated as a browser) so it uses the worker path.
// Both masks are held across the whole boot and then restored, never leaving
// globalThis.process undefined. Verified against the vendored Pyodide 314.0.3
// getGlobalRuntimeEnv/calculateDerivedFlags and the asm.mjs env detection.
//
// Scope: run scripts + `-c` + a line REPL, streaming stdout/stderr to the
// terminal, with the project directory mirrored into Pyodide's FS so file I/O and
// sibling imports work. Prebuilt wheels (numpy/pandas/…) auto-load from the
// vendored, same-origin package index via loadPackagesFromImports.
//
// WEB SERVERS (Flask / FastAPI): Pyodide has no real sockets, so a Python
// uvicorn/Werkzeug server cannot bind a port. But the `python` launcher is itself
// a guest Node program on Vivari's Node-compatible runtime (full `require("http")`
// + event loop), and Pyodide runs in that same worker. So `serve()` stands up a
// tiny guest `http.createServer().listen(port)` — which registers the port with
// the kernel exactly like an Express app, opening a preview tab — and each request
// the preview tunnel replays into this process is converted to a WSGI `environ`
// (Flask) or ASGI `scope`/`receive`/`send` (FastAPI), driven through Pyodide, and
// written back. Binary crosses the JS<->Python boundary as base64 inside a JSON
// string to stay proxy-safe. v1: buffered request/response (no streaming/SSE/
// WebSocket), one request at a time.

import {
  DIST_QUERY,
  STORE_DIR,
  collectDelta,
  formatPipCheck,
  formatPipFreeze,
  formatPipList,
  formatPipShow,
  humanBytes,
  persistDelta,
  pyEnv,
  readStamp,
  restoreStore,
  stampProblem,
  storeCapError,
  storeDists,
  storePaths,
  uninstallSource,
  walkPyodide,
  writeStore,
} from "./python-store.js";

// Directories we never mirror between the project and Pyodide's FS.
// `.venv` is in here even though it is now the package store, and that is the
// point: the store has to land at the interpreter's OWN site-packages path
// (restoreStore), not at <cwd>/.venv where no import would look. Mirroring it
// generally would copy every byte a second time, to a place nothing reads.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  ".vivari",
  ".cache",
]);
// Per-file mirror cap (bytes) — keep a stray huge asset from ballooning MEMFS.
const MAX_MIRROR_FILE = 8 * 1024 * 1024;

function withTrailingSlash(u) {
  const s = String(u || "");
  return s.endsWith("/") ? s : s + "/";
}

// The CPython version the vendored Pyodide actually builds — `sys.version` says
// 3.14.2, not the 3.14.0 that pyodide-lock.json's `info.python` records (that is
// the ABI target). PYTHON_PROGRAM cannot import this, because it is a
// no-interpolation template literal, so /bin/python.js carries the same number
// as a bare literal for its boot-free `--version`. Same arrangement as
// BUN_PROGRAM/BUN_VERSION: spike-python-offline.mjs pins the literal against
// this constant, and the bridge spike pins this constant against `sys.version`
// in a real interpreter. Bump the vendored Pyodide and one of the two fails.
export const PYODIDE_PYTHON_VERSION = "3.14.2";


// Pass Python's bytes through verbatim and let IT decide where its newlines go.
//
// Pyodide's `stdout`/`stderr` load options are the *batched* handlers: it calls
// them once per flush with the trailing newline stripped, so appending one back
// is only correct when the flush happened to end a line. It does not for a
// partial-line flush, which is how every progress renderer works — pytest
// flushes after each `.`, so an 11-test run rendered as eleven lines instead of
// `...........`. The batched handler drops a final partial chunk outright as
// well, so `print("x", end="")` never arrived at all, and no amount of flushing
// brought it back. A byte Writer has neither problem. It must return how many
// bytes it accepted.
export function byteWriter(stream) {
  return {
    write: (buf) => {
      // Copy: stream.write may be asynchronous and Pyodide reuses the buffer as
      // soon as this returns.
      stream.write(globalThis.Buffer.from(buf));
      return buf.length;
    },
  };
}

// Python block-buffers a stdout it does not consider a terminal, so whatever a
// script wrote without a trailing newline is still inside CPython when the
// script ends — the byte Writer above never sees it until something flushes.
// Call this wherever control returns to us and the user should already be
// looking at that output.
export function flushStreams(pyodide) {
  try {
    pyodide.runPython("import sys; sys.stdout.flush(); sys.stderr.flush()");
  } catch {
    /* interpreter already gone, or streams replaced: nothing to flush */
  }
}

// How a top-level exception ends the process: the exit code, plus what (if
// anything) to print. CPython prints NO traceback when SystemExit reaches the
// top level — it exits with that code silently, or, if the argument isn't an
// integer, prints just that argument and exits 1. We used to dump the whole
// WASM traceback for every sys.exit(), which meant a clean `sys.exit(0)` — what
// `python -m pytest` does on every green run — looked like a crash.
export function terminationFromError(e) {
  const msg = (e && e.message) || String(e);
  const last = msg.trimEnd().split("\n").pop().trim();
  const isExit = (e && e.type === "SystemExit") || /^SystemExit\b/.test(last);
  if (!isExit) return { code: 1, report: msg };
  const m = /^SystemExit:\s*([\s\S]*)$/.exec(last);
  const value = m ? m[1].trim() : "";
  if (!value || value === "None") return { code: 0, report: "" }; // bare sys.exit()
  if (/^-?\d+$/.test(value)) return { code: Number(value) | 0, report: "" };
  // Bools ARE ints in Python: sys.exit(True) exits 1 and sys.exit(False) exits
  // 0, printing nothing either way. The traceback spells both as
  // "SystemExit: True"/"False" — indistinguishable from sys.exit("True"), so
  // the message is a lossy channel and this picks the far likelier reading.
  // `sys.exit(not ok)` is a common idiom; exiting with the literal string
  // "False" is not. It is also the reading that keeps a *successful* run
  // reporting success, which the string reading got backwards.
  if (value === "True") return { code: 1, report: "" };
  if (value === "False") return { code: 0, report: "" };
  return { code: 1, report: value }; // sys.exit("message")
}

// Undo one consequence of our own Node masquerade: it switches Python's HTTP off.
//
// `requests` in Pyodide does not use sockets — it cannot, there are none. urllib3
// ships an Emscripten transport that picks a door at request time
// (urllib3/contrib/emscripten/fetch.py):
//
//     if has_jspi():     return send_jspi_request(...)      # stack switching
//     elif is_in_node(): raise _RequestError(NODE_JSPI_ERROR)
//     js_xhr = js.XMLHttpRequest.new(); js_xhr.open(method, url, False)
//
// and it answers `is_in_node()` by reading `js.process.release.name`. We set that
// to "node" on purpose (builtins/process.js) because real tools branch on it, and
// `globalThis.process` is the object Pyodide hands Python as `js.process`. So
// urllib3 concludes that a browser Web Worker is Node, skips the synchronous
// XMLHttpRequest a Worker actually has, and tells the user to pass
// `--experimental-wasm-stack-switching` to a Node that is not there. The same
// expression also decides `_fetcher` at import time, so streaming is off too.
//
// The fix asks the REALM instead of asking `process`: a dedicated Worker has a
// synchronous XMLHttpRequest, the headless Node harnesses do not — and there the
// Node answer is the true one and must survive, which is why this is a derived
// predicate and not `return False`. Changing `process.release.name` was the other
// candidate and is the wrong one: it is load-bearing for real tools, and a
// `python` process genuinely IS a guest Node process.
//
// It has to run as a post-import hook rather than at boot, because urllib3 is not
// installed at boot and importing it eagerly would pull a wheel into every python
// process. Exported, with its installer, so scripts/spike-python-bridge.mjs
// drives the SHIPPED source through the SHIPPED call.
export const URLLIB3_REALM_PATCH = `
import sys as _vv_sys
from importlib.machinery import PathFinder as _VvPathFinder

_VV_FETCH = "urllib3.contrib.emscripten.fetch"


def _vv_browser_realm():
    # The realm question, asked of the realm. Synchronous XMLHttpRequest is
    # exactly the capability urllib3 is looking for, and it is the thing a
    # Worker has and Node has not.
    import js
    return hasattr(js, "XMLHttpRequest")


def _vv_patch_fetch(mod):
    if getattr(mod.is_in_node, "_vv_realm_derived", False):
        return
    if not _vv_browser_realm():
        return  # real Node: urllib3's own answer is correct, leave it alone
    _vv_node_answer = mod.is_in_node

    def is_in_node():
        return (not _vv_browser_realm()) and _vv_node_answer()

    is_in_node._vv_realm_derived = True
    mod.is_in_node = is_in_node
    # The import-time gate below ran with the OLD predicate, so replacing the
    # function alone would leave streaming off by an evaluation that no longer
    # holds. Re-run the module's own decision, verbatim, with the fixed one.
    if mod._fetcher is None and mod.is_worker_available() and (
        mod.is_cross_origin_isolated() and not mod.is_in_browser_main_thread()
    ):
        try:
            mod._fetcher = mod._StreamingFetcher()
        except Exception:
            mod._fetcher = None  # buffered transport still works; streaming does not


class _VvPatchedLoader:
    def __init__(self, inner):
        self._vv_inner = inner

    def create_module(self, spec):
        return self._vv_inner.create_module(spec)

    def exec_module(self, module):
        self._vv_inner.exec_module(module)
        try:
            _vv_patch_fetch(module)
        except Exception:
            pass  # an unbreak must never break the import it decorates

    def __getattr__(self, name):
        # Explicit, so a missing _vv_inner raises instead of recursing.
        return getattr(object.__getattribute__(self, "_vv_inner"), name)


class _VvEmscriptenFetchFinder:
    def find_spec(self, fullname, path=None, target=None):
        if fullname != _VV_FETCH:
            return None
        # 'path' is the parent package's __path__, handed to us by the import
        # machinery, so PathFinder resolves the real module without re-entering
        # sys.meta_path and without importing the parent a second time.
        spec = _VvPathFinder.find_spec(fullname, path, target)
        if spec is None or spec.loader is None:
            return None
        spec.loader = _VvPatchedLoader(spec.loader)
        return spec


# Compared by name, not isinstance: re-running this source rebinds the class, so
# an isinstance check would install a second finder every time.
if not any(type(_f).__name__ == "_VvEmscriptenFetchFinder" for _f in _vv_sys.meta_path):
    _vv_sys.meta_path.insert(0, _VvEmscriptenFetchFinder())

# Already imported (a re-run, or a harness that got there first): patch in place.
_vv_loaded = _vv_sys.modules.get(_VV_FETCH)
if _vv_loaded is not None:
    try:
        _vv_patch_fetch(_vv_loaded)
    except Exception:
        pass
`;

// Runs the patch in a namespace of its own, so none of those _vv names land in
// the user's `__main__` — this interpreter is also the REPL, and `dir()` there
// should show what the user defined, not our plumbing. The functions keep the
// dict alive through their __globals__, which is what the meta_path finder needs
// to still resolve them at import time, long after this returns.
// What the interpreter calls itself. Pyodide leaves `sys.executable` pointing at
// whatever JS entry booted it — under Node that is the .mjs file, which is both
// wrong and a leak of the host. It matters beyond tidiness because CPython's own
// runpy formats the -m failure as `"%s: %s" % (sys.executable, exc)`, so this
// string IS the prefix of `python -m nosuchthing`. `python` is the name the user
// typed and the name every other error in the shim uses.
export const PYTHON_EXECUTABLE = "python";

export function setExecutable(pyodide) {
  try {
    pyodide.runPython(`import sys; sys.executable = ${JSON.stringify(PYTHON_EXECUTABLE)}`);
  } catch {
    /* a wrong sys.executable is cosmetic next to a boot failure */
  }
}

// `python -m http.server`, running CPython's OWN SimpleHTTPRequestHandler.
//
// The module wants a socket and Pyodide has none — and worse than none: a
// Pyodide socket `connect()`s and `bind()`s without complaint and then carries
// no bytes, so the real module would bind port 8000, report itself serving, and
// accept() forever. Reimplementing a static file server is the other obvious
// move and also wrong: the value of `-m http.server` is that it is the same
// directory listing, the same mimetypes table, the same Range and If-Modified-
// Since handling and the same 404 that everyone already knows.
//
// So keep the handler and remove the socket. BaseHTTPRequestHandler does all of
// its I/O through `self.rfile` / `self.wfile`, which `StreamRequestHandler.setup`
// builds from `self.connection` — so an object with `makefile()` and `sendall()`
// is a complete substitute. Feed it the raw request bytes, collect the raw
// response bytes, and let the guest-Node http server carry them, which is the
// same bridge the WSGI and ASGI seams already use.
//
// Exported so the spikes drive the shipped source rather than a copy of it.
export const STATIC_SERVER_SOURCE = `
import io, sys, posixpath
from http.server import SimpleHTTPRequestHandler

class _VvConn:
    """Everything StreamRequestHandler.setup() asks of a socket, and no more."""
    def __init__(self, data):
        self._data = data
        self.out = bytearray()
    def makefile(self, mode="rb", bufsize=-1, *a, **k):
        # 'rb' is the request; BaseHTTPRequestHandler sets wbufsize = 0, so the
        # write side goes through sendall() instead of a file object.
        return io.BytesIO(self._data) if "r" in mode else io.BytesIO()
    def sendall(self, b):
        self.out += bytes(b)
    def settimeout(self, t):
        pass
    def setsockopt(self, *a):
        pass
    def shutdown(self, *a):
        pass
    def close(self):
        pass

class _VvServer:
    """Stands in for HTTPServer for the two attributes the handler reads."""
    def __init__(self, port):
        self.server_name = "localhost"
        self.server_port = port

def _vv_static(raw, directory, port, protocol):
    # A Uint8Array handed over from JS arrives as a JsProxy, not as bytes.
    # Accepting both keeps this callable with plain bytes from a test.
    if not isinstance(raw, (bytes, bytearray)):
        raw = raw.to_bytes()
    conn = _VvConn(raw)

    class _Handler(SimpleHTTPRequestHandler):
        protocol_version = protocol
        def __init__(self, *a, **k):
            super().__init__(*a, directory=directory, **k)
        def log_message(self, fmt, *args):
            # Real http.server logs every request to stderr. Keep that — it is
            # what tells someone their request arrived — but drop the timestamp,
            # which the terminal already carries.
            sys.stderr.write("%s - %s\\n" % (self.address_string(), fmt % args))

    _Handler(conn, ("127.0.0.1", 0), _VvServer(port))
    return bytes(conn.out)
`;

export function installUrllib3RealmPatch(pyodide) {
  const ns = pyodide.toPy({});
  try {
    pyodide.runPython(URLLIB3_REALM_PATCH, { globals: ns });
    return true;
  } catch {
    return false; // an unbreak, not a dependency: Python is fine without it
  }
}

// Python side of the bridge. Imports the user's app once and defines a single
// dispatch function per protocol. Requests/responses cross as JSON strings with
// base64 bodies (JS strings convert to Python str cleanly; PyProxy/typed-array
// conversions do not need to be reasoned about). Injected: module + attr.
//
// Exported so scripts/spike-python-bridge.mjs drives the SHIPPED dispatch source
// rather than a copy that would silently drift away from it.
export function setupSource(moduleName, attrName, mode) {
  const mod = JSON.stringify(moduleName);
  const attr = JSON.stringify(attrName);
  const common = `
import sys, json, base64, importlib, traceback
_vv_mod = importlib.import_module(${mod})
_vv_app = getattr(_vv_mod, ${attr})
`;
  if (mode === "asgi") {
    return (
      common +
      `
# Pyodide (WASM) has no OS threads, so FastAPI/Starlette's default threadpool for
# sync endpoints (anyio.to_thread.run_sync -> threading.Thread) raises "can't
# start new thread". Run such callables inline on the event loop instead — correct
# for our single-threaded model (starlette reads run_sync at call time, so this
# takes effect for every sync route/dependency).
try:
  import anyio.to_thread as _vv_att
  async def _vv_run_sync(func, *args, **kwargs):
      return func(*args)
  _vv_att.run_sync = _vv_run_sync
except Exception:
  pass


async def _vv_dispatch(req_json):
  d = json.loads(req_json)
  body = base64.b64decode(d["body_b64"]) if d.get("body_b64") else b""
    # ASGI defines "path" as the FULL request path INCLUDING root_path, with
    # root_path naming only the prefix the app is mounted under. The preview
    # tunnel hands us the already-stripped path, so we put the prefix back:
    # Starlette's get_route_path() subtracts root_path from path, and with a
    # pre-stripped path it subtracts a prefix that isn't there — which makes
    # every Mount(), StaticFiles included, 404 behind the preview proxy. WSGI
    # needs no equivalent: SCRIPT_NAME + PATH_INFO is already the split form.
  _vv_root = d.get("root_path", "")
  _vv_path = _vv_root + d["path"] if _vv_root else d["path"]
  scope = {
      "type": "http",
      "asgi": {"version": "3.0", "spec_version": "2.3"},
      "http_version": d.get("http_version", "1.1"),
      "method": d["method"],
      "scheme": "http",
      "path": _vv_path,
      "raw_path": _vv_path.encode("utf-8"),
      "query_string": d.get("query", "").encode("utf-8"),
      "root_path": _vv_root,
      "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in d["headers"]],
      "server": ("localhost", 80),
      "client": ("127.0.0.1", 0),
  }
  _sent = {"done": False}
  async def receive():
      if not _sent["done"]:
          _sent["done"] = True
          return {"type": "http.request", "body": body, "more_body": False}
      return {"type": "http.disconnect"}
  out = {"status": 200, "headers": [], "body": bytearray()}
  async def send(message):
      t = message["type"]
      if t == "http.response.start":
          out["status"] = message["status"]
          out["headers"] = [
              [bytes(k).decode("latin-1"), bytes(v).decode("latin-1")]
              for k, v in message.get("headers", [])
          ]
      elif t == "http.response.body":
          out["body"].extend(bytes(message.get("body", b"")))
  await _vv_app(scope, receive, send)
  return json.dumps({
      "status": out["status"],
      "headers": out["headers"],
      "body_b64": base64.b64encode(bytes(out["body"])).decode("ascii"),
  })
`
    );
  }
  // WSGI (Flask)
  return (
    common +
    `
import io
def _vv_dispatch(req_json):
  d = json.loads(req_json)
  body = base64.b64decode(d["body_b64"]) if d.get("body_b64") else b""
  environ = {
      "REQUEST_METHOD": d["method"],
      "SCRIPT_NAME": d.get("root_path", ""),
      "PATH_INFO": d["path"],
      "QUERY_STRING": d.get("query", ""),
      "SERVER_NAME": "localhost",
      "SERVER_PORT": "80",
      "SERVER_PROTOCOL": "HTTP/" + d.get("http_version", "1.1"),
      "wsgi.version": (1, 0),
      "wsgi.url_scheme": "http",
      "wsgi.input": io.BytesIO(body),
      "wsgi.errors": sys.stderr,
      "wsgi.multithread": False,
      "wsgi.multiprocess": False,
      "wsgi.run_once": False,
  }
  for k, v in d["headers"]:
      key = k.upper().replace("-", "_")
      if key in ("CONTENT_TYPE", "CONTENT_LENGTH"):
          environ[key] = v
      else:
          environ["HTTP_" + key] = v
  captured = {}
  def start_response(status, response_headers, exc_info=None):
      captured["status"] = status
      captured["headers"] = response_headers
      return lambda data: None
  result = _vv_app(environ, start_response)
  try:
      chunks = b"".join(bytes(c) for c in result)
  finally:
      if hasattr(result, "close"):
          result.close()
  status = captured.get("status", "200 OK")
  code = int(status.split(" ", 1)[0])
  return json.dumps({
      "status": code,
      "headers": [[k, v] for k, v in captured.get("headers", [])],
      "body_b64": base64.b64encode(chunks).decode("ascii"),
  })
`
  );
}

export function createPythonRuntime({ process, require, trackHost }) {
  const req = (name) => require(name);

  // WHERE PACKAGE-LOADER PROGRESS GOES, and why it is spelled out at every call
  // site. Pyodide's package manager keeps its own `stdout`, and it defaults to
  // the INTERPRETER'S stdout stream — the one `setStdout` sets, which bootPyodide
  // below points straight at `process.stdout`. Passing a `messageCallback`
  // overrides it for that one call; omitting it does not. So `pip freeze`
  // emitted
  //
  //     Loading packaging
  //     Loaded packaging
  //     tabulate==0.10.0
  //
  // and `pip freeze > requirements.txt` wrote all three lines into the file.
  // The content was right and the stream was wrong, which is the worse of the
  // two failures: it survives the terminal and breaks later, inside a file
  // someone committed. Loader progress is diagnostics — stderr keeps it visible
  // to a human and out of a pipe.
  //
  // Never rely on the default. (It is not console.log, which is the intuitive
  // guess: replacing globalThis.console does not intercept these, because the
  // manager writes to the Emscripten stream rather than through the console.)
  const loaderToStderr = {
    messageCallback: (m) => process.stderr.write(String(m) + "\n"),
    errorCallback: (m) => process.stderr.write(String(m) + "\n"),
  };
  // The one deliberate exception. `pip install` progress is command output, not
  // diagnostics: real pip prints "Collecting …" and "Downloading …" on stdout,
  // and this shim's own "Installed: …" / "Stored in .venv/ …" lines are already
  // there. Warnings still go to stderr, as real pip's do.
  const loaderToStdout = {
    messageCallback: (m) => process.stdout.write(String(m) + "\n"),
    errorCallback: (m) => process.stderr.write(String(m) + "\n"),
  };

  // One Pyodide per process (a fresh process worker = a fresh boot). Cached so a
  // REPL / repeated calls in the same process reuse it.
  let bootPromise = null;

  function bootPyodide(indexUrl) {
    if (bootPromise) return bootPromise;
    const url = withTrailingSlash(indexUrl);
    bootPromise = (async () => {
      // Pyodide has TWO independent Node probes, and our runtime masquerades as
      // Node (process.versions.node is set — see packages/runtime/builtins/process.js),
      // so BOTH would take the Node path and `await import("node:module")`, which
      // 404s inside a module Web Worker. We mask each:
      //   * pyodide.mjs (loader):  IN_NODE = … && !process.browser  — computed at
      //     module-eval time → set process.browser = true while it is imported.
      //   * pyodide.asm.mjs (Emscripten): ENVIRONMENT_IS_NODE =
      //     process?.versions?.node && process?.type != "renderer"  — computed
      //     when asm.mjs is imported *inside* loadPyodide() → set process.type =
      //     "renderer" (Emscripten treats an Electron renderer as browser).
      // Keep both masks set across the WHOLE boot (import + loadPyodide) and only
      // then restore, so globalThis.process is never left undefined. process ===
      // globalThis.process; each python invocation is its own process worker, so a
      // node/bun process is never affected.
      const hadBrowser = Object.prototype.hasOwnProperty.call(process, "browser");
      const prevBrowser = process.browser;
      const hadType = Object.prototype.hasOwnProperty.call(process, "type");
      const prevType = process.type;
      const restoreEnv = () => {
        if (hadBrowser) process.browser = prevBrowser;
        else delete process.browser;
        if (hadType) process.type = prevType;
        else delete process.type;
      };
      try {
        process.browser = true;
        process.type = "renderer";
        const mod = await import(/* @vite-ignore */ url + "pyodide.mjs");
        const pyodide = await mod.loadPyodide({ indexURL: url });
        pyodide.setStdout(byteWriter(process.stdout));
        pyodide.setStderr(byteWriter(process.stderr));
        // Before any user code can import requests. Installing a meta_path hook
        // costs one import of sys/importlib and touches nothing else, so a
        // process that never uses urllib3 pays nothing for it.
        installUrllib3RealmPatch(pyodide);
        setExecutable(pyodide);
        return pyodide;
      } finally {
        restoreEnv();
      }
    })();
    // Keep this process's event loop alive across the whole boot. Pyodide's own
    // fetch()/WebAssembly calls are liveness-tracked (see trackHost in
    // packages/runtime/index.js), but the initial dynamic `import(pyodide.mjs)`
    // — and the `import(pyodide.asm.mjs)` loadPyodide() does internally — are
    // native ES module imports that bypass that tracking. On a warm dev server
    // they resolve within a single loop turn, so main() reaches the tracked
    // fetches before drive() can quiesce; on a cold production/CDN load the
    // import takes longer than one macrotask, so drive() sees no ref'd work and
    // exits 0 BEFORE Pyodide finishes booting. Every `python`/`flask`/`uvicorn`
    // command then appears to exit instantly with no output. Holding a
    // host-liveness ref until the boot promise settles closes that race.
    if (typeof trackHost === "function") trackHost(bootPromise);
    return bootPromise;
  }

  // ---- project <-> Pyodide FS mirroring --------------------------------------
  function mirrorIn(pyodide, cwd) {
    const fs = req("fs");
    const snapshot = new Map();
    const walk = (dir) => {
      try {
        pyodide.FS.mkdirTree(dir);
      } catch {
        /* already exists */
      }
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const full = dir === "/" ? "/" + name : dir + "/" + name;
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (SKIP_DIRS.has(name)) continue;
          walk(full);
        } else if (st.isFile()) {
          if (st.size > MAX_MIRROR_FILE) continue;
          let buf;
          try {
            buf = fs.readFileSync(full);
          } catch {
            continue;
          }
          try {
            pyodide.FS.writeFile(
              full,
              new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
            );
            snapshot.set(full, buf.length);
          } catch {
            /* skip unwritable path */
          }
        }
      }
    };
    walk(cwd);
    return snapshot;
  }

  // Is `full` a path we are willing to copy back out to the host? Same rules the
  // inbound walk applies, restated for a path we did not reach by walking.
  function mirrorable(cwd, full) {
    if (full !== cwd && !full.startsWith(cwd === "/" ? "/" : cwd + "/")) return false;
    const rel = full.slice(cwd === "/" ? 1 : cwd.length + 1);
    for (const seg of rel.split("/").slice(0, -1)) if (SKIP_DIRS.has(seg)) return false;
    return true;
  }

  // Record every path Python writes, moves or deletes, so mirroring back is a
  // list of files rather than a search for them.
  //
  // Emscripten calls these on the way through the real FS ops, so they see what
  // a diff cannot. Two things forced this. A same-size rewrite —
  // `open(p,'w').write('bbbb')` over `'aaaa'` — is invisible to BOTH size and
  // mtime (MEMFS stamps mtime in whole milliseconds, and the two writes land in
  // the same one), so the old size heuristic silently dropped it. And a served
  // app must mirror after every request, where walking the project tree each
  // time is the thing that makes per-request persistence too expensive to do.
  //
  // Deletes are propagated, which is not merely symmetry: sqlite3 writes
  // `app.db-journal` and REMOVES it on commit. Copying the journal out and never
  // removing it leaves a hot journal beside a committed database, and the next
  // process to open it rolls back work that was committed. Mirroring writes
  // without deletes would corrupt exactly the file this change exists to save.
  function trackWrites(pyodide) {
    const writes = new Set();
    const deletes = new Set();
    const d = pyodide.FS && pyodide.FS.trackingDelegate;
    if (!d) return { pyodide, writes, deletes, ok: false };
    d.onWriteToFile = (p) => {
      writes.add(p);
      deletes.delete(p);
    };
    d.onDeletePath = (p) => {
      writes.delete(p);
      deletes.add(p);
    };
    d.onMovePath = (from, to) => {
      writes.delete(from);
      deletes.add(from);
      writes.add(to);
      deletes.delete(to);
    };
    return { pyodide, writes, deletes, ok: true };
  }

  // Copy one Pyodide file out to the host. Returns true if anything happened.
  function writeOutOne(pyodide, full) {
    const fs = req("fs");
    const path = req("path");
    let st;
    try {
      st = pyodide.FS.stat(full);
    } catch {
      return false;
    }
    if (!pyodide.FS.isFile(st.mode) || st.size > MAX_MIRROR_FILE) return false;
    let data;
    try {
      data = pyodide.FS.readFile(full);
    } catch {
      return false;
    }
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, globalThis.Buffer.from(data));
      return true;
    } catch {
      return false;
    }
  }

  function deleteOne(full) {
    const fs = req("fs");
    try {
      fs.rmSync(full, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  // Just the tracked paths — no tree walk. This is what a served app runs after
  // every request, so it has to cost nothing when the request wrote nothing.
  function mirrorTracked(cwd, tracker) {
    if (!tracker) return 0;
    let n = 0;
    for (const full of tracker.deletes) {
      if (!mirrorable(cwd, full)) continue;
      if (deleteOne(full)) n++;
    }
    tracker.deletes.clear();
    for (const full of tracker.writes) {
      if (!mirrorable(cwd, full)) continue;
      if (writeOutOne(tracker.pyodide, full)) n++;
    }
    tracker.writes.clear();
    return n;
  }

  // The full reconciliation: every tracked path, PLUS a walk that catches
  // anything whose size moved. The union is deliberate — tracking is precise
  // where the diff is blind (same-size rewrites), and the diff is the safety net
  // if a Pyodide bump ever stops the delegate firing, so the failure mode is the
  // old behaviour rather than no behaviour. spike-python-bridge asserts the
  // delegate DOES fire, so that net going live is loud rather than silent.
  function mirrorBack(pyodide, cwd, snapshot, tracker) {
    const tracked = tracker && tracker.writes;
    const walk = (dir) => {
      let names;
      try {
        names = pyodide.FS.readdir(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (name === "." || name === "..") continue;
        const full = dir === "/" ? "/" + name : dir + "/" + name;
        let st;
        try {
          st = pyodide.FS.stat(full);
        } catch {
          continue;
        }
        if (pyodide.FS.isDir(st.mode)) {
          if (SKIP_DIRS.has(name)) continue;
          walk(full);
        } else if (pyodide.FS.isFile(st.mode)) {
          if (!(tracked && tracked.has(full)) && snapshot.get(full) === st.size) continue;
          writeOutOne(pyodide, full);
          if (tracked) tracked.delete(full);
        }
      }
    };
    walk(cwd);
    // Tracked paths the walk could not reach (its directory is gone, say).
    if (tracker) {
      for (const full of tracker.writes) if (mirrorable(cwd, full)) writeOutOne(pyodide, full);
      tracker.writes.clear();
      for (const full of tracker.deletes) if (mirrorable(cwd, full)) deleteOne(full);
      tracker.deletes.clear();
    }
  }

  // ---- execution -------------------------------------------------------------

  async function runSource(indexUrl, source, opts) {
    const { filename = "<stdin>", argv, cwd, importSource } = opts || {};
    const pyodide = await bootPyodide(indexUrl);
    let snapshot = null;
    let tracker = null;
    if (cwd) {
      try {
        snapshot = mirrorIn(pyodide, cwd);
        // After mirrorIn, so the copy in is not itself reported as user writes.
        tracker = trackWrites(pyodide);
        pyodide.FS.chdir(cwd);
      } catch {
        /* run anyway from the default home dir */
      }
      // The project's installed packages, before the script gets to import.
      try {
        reportRestore(restoreStore(req("fs"), pyodide, cwd));
      } catch {
        /* the script may not need them; a missing import will say so */
      }
    }
    try {
      pyodide.runPython(`import sys; sys.argv = ${JSON.stringify(argv || [filename])}`);
    } catch {
      /* non-fatal */
    }
    // Auto-load any vendored prebuilt packages the script imports (numpy, …).
    // `importSource` is for callers whose real source imports nothing useful —
    // `python -m X` runs a runpy call, so the imports to scan for are X's.
    try {
      await pyodide.loadPackagesFromImports(importSource || source, loaderToStderr);
    } catch {
      /* a missing package surfaces as a Python ImportError below */
    }
    let code = 0;
    try {
      await pyodide.runPythonAsync(source, { filename });
      flushStreams(pyodide);
    } catch (e) {
      // Before our own report, so the script's output stays ahead of the error
      // that ended it.
      flushStreams(pyodide);
      const { code: rc, report } = terminationFromError(e);
      if (report) process.stderr.write(report.endsWith("\n") ? report : report + "\n");
      code = rc;
    } finally {
      if (cwd && snapshot) {
        try {
          mirrorBack(pyodide, cwd, snapshot, tracker);
        } catch {
          /* best-effort */
        }
      }
    }
    return code;
  }

  async function runFile(indexUrl, filePath, args) {
    const fs = req("fs");
    let source;
    try {
      source = fs.readFileSync(filePath, "utf8");
    } catch (e) {
      process.stderr.write(
        `python: can't open file '${filePath}': ${(e && e.code) || (e && e.message) || e}\n`,
      );
      return 2;
    }
    return runSource(indexUrl, source, {
      filename: filePath,
      argv: [filePath, ...(args || [])],
      cwd: process.cwd(),
    });
  }

  async function runCode(indexUrl, source, args) {
    return runSource(indexUrl, source, {
      filename: "<string>",
      argv: ["-c", ...(args || [])],
      cwd: process.cwd(),
    });
  }

  // `python -m <module>` for everything the shim does not special-case.
  //
  // This is CPython's own entry point, not an imitation of it:
  // `runpy._run_module_as_main` is the function `Modules/main.c` calls for -m,
  // so module resolution, `__main__` naming, `sys.argv[0]` rewriting and the
  // error text all come from the stdlib. A module that is missing raises
  // `SystemExit("<sys.executable>: No module named X")` from inside runpy — the
  // same string real CPython prints — and the shim's existing CPython-faithful
  // SystemExit handling turns that into exit 1 with the message on stderr. There
  // is nothing for us to format, which is the point: an invented "not supported"
  // line would be a claim about Vivari for something that is just a typo.
  async function runModule(indexUrl, mod, args, cwd) {
    const src = [
      "import runpy, sys",
      `sys.argv = ${JSON.stringify([mod, ...(args || [])])}`,
      `runpy._run_module_as_main(${JSON.stringify(mod)})`,
    ].join("\n");
    return runSource(indexUrl, src, {
      filename: "<module>",
      argv: [mod, ...(args || [])],
      cwd: cwd || process.cwd(),
      // Scan the TARGET module's imports for wheels to preload, not runpy's.
      importSource: `import ${String(mod).split(".")[0]}`,
    });
  }

  // ---- the persistent package store -----------------------------------------
  // See builtins/python-store.js for what the store is and why it lives at
  // .venv. This half is the I/O: reading it into an interpreter, and writing
  // back the delta an install produced.

  // One line, on stderr, only when there is something the user must act on.
  function reportRestore(r) {
    if (r.state !== "discarded") return;
    process.stderr.write(
      `python: ignoring the package store in ${STORE_DIR}/ - ${r.problem}.\n` +
        `        Nothing from it was loaded, because a half-restored site-packages\n` +
        `        breaks in stranger ways than an empty one. Rebuild it with:\n` +
        `            python -m venv --clear ${STORE_DIR}\n`,
    );
  }

  async function pipSession(indexUrl) {
    const pyodide = await bootPyodide(indexUrl);
    const cwd = process.cwd();
    const restore = restoreStore(req("fs"), pyodide, cwd);
    reportRestore(restore);
    return { pyodide, cwd, env: restore.env, restore };
  }

  async function queryDists(indexUrl) {
    const s = await pipSession(indexUrl);
    try {
      await s.pyodide.loadPackage("packaging", loaderToStderr);
    } catch {
      /* DIST_QUERY reports its absence rather than guessing */
    }
    const data = JSON.parse(await s.pyodide.runPythonAsync(DIST_QUERY));
    return { ...s, data, dists: storeDists(req("fs"), s.cwd, s.env, data.dists) };
  }

  // ---- pip ------------------------------------------------------------------

  async function pipInstall(indexUrl, names) {
    const list = (names || []).filter(Boolean);
    if (!list.length) {
      process.stderr.write("pip: no packages specified\n");
      return 1;
    }
    const { pyodide, cwd, env, restore } = await pipSession(indexUrl);
    // A discarded store must not be written INTO. Restoring it was refused, so
    // the baseline below would not include it — and the delta would then be
    // merged with bytes from an interpreter this one cannot use, and stamped as
    // current. That is the half-loaded store the stamp exists to prevent,
    // arrived at from the writing side. reportRestore() has already explained
    // the mismatch; this adds the one line about what it means for an install.
    if (restore.state === "discarded") {
      process.stderr.write(
        `pip: not installing on top of it - the new packages would be mixed with bytes\n` +
          `     the store already holds, and stamped as though they belonged together.\n` +
          `     Run 'python -m venv --clear ${STORE_DIR}' first; you will need to install\n` +
          "     again afterwards.\n",
      );
      return 1;
    }
    // micropip before the baseline, so our own machinery is never mistaken for
    // something the user asked to install.
    try {
      await pyodide.loadPackage("micropip", loaderToStderr);
    } catch {
      /* the install below will report if it is genuinely unavailable */
    }
    const baseline = walkPyodide(pyodide, env.sitePackages);

    let how = "";
    try {
      // Resolves per-package from the hybrid lock: vendored wheels load
      // same-origin (offline), the rest from the Pyodide CDN (see scripts/
      // vendor-pyodide.mjs). micropip below handles pure-Python PyPI packages
      // that aren't in Pyodide's distribution at all.
      await pyodide.loadPackage(list, loaderToStdout);
      how = "Installed";
    } catch {
      try {
        const micropip = pyodide.pyimport("micropip");
        await micropip.install(list);
        how = "Installed via micropip";
      } catch (e) {
        process.stderr.write(
          `pip: could not install ${list.join(", ")}: ${(e && e.message) || e}\n`,
        );
        return 1;
      }
    }

    const delta = collectDelta(pyodide, env, baseline);
    let total;
    try {
      total = persistDelta(
        req("fs"), pyodide, cwd, env, delta,
        "python -m pip install " + list.join(" "),
      );
    } catch (e) {
      process.stderr.write(
        `pip: installed ${list.join(", ")}, but could not write ${STORE_DIR}/: ` +
          `${(e && e.message) || e}\n`,
      );
      return 1;
    }
    if (!total.ok) {
      // Loud and non-zero: the packages are in this interpreter, which is about
      // to exit, so from the user's point of view the install did not happen.
      // Exiting 0 here would let `pip install X && python main.py` walk into an
      // ImportError with a success message sitting above it.
      process.stderr.write(storeCapError(total, list));
      return 1;
    }
    process.stdout.write(`${how}: ${list.join(", ")}\n`);
    process.stdout.write(
      `Stored in ${STORE_DIR}/ (${total.files} files, ${humanBytes(total.bytes)}) - ` +
        "every python command in this project will see it.\n",
    );
    return 0;
  }

  async function pipList(indexUrl) {
    const { dists } = await queryDists(indexUrl);
    process.stdout.write(formatPipList(dists));
    return 0;
  }

  async function pipFreeze(indexUrl) {
    const { dists } = await queryDists(indexUrl);
    process.stdout.write(formatPipFreeze(dists));
    return 0;
  }

  async function pipShow(indexUrl, names) {
    const wanted = (names || []).filter(Boolean);
    if (!wanted.length) {
      process.stderr.write("ERROR: Please provide a package name or names.\n");
      return 1;
    }
    const { data, dists } = await queryDists(indexUrl);
    if (!data.requirementsAvailable) {
      process.stderr.write(
        "pip: cannot read dependency metadata (the 'packaging' package did not load),\n" +
          "     so Requires/Required-by would be blank rather than empty. Refusing to\n" +
          "     print a partial answer.\n",
      );
      return 1;
    }
    const canon = (s) => String(s).toLowerCase().replace(/[-_.]+/g, "-");
    const found = [];
    const missing = [];
    for (const w of wanted) {
      const hit = dists.find((d) => canon(d.name) === canon(w));
      if (hit) found.push(hit);
      else missing.push(w);
    }
    process.stdout.write(found.map(formatPipShow).join("---\n"));
    if (missing.length) {
      process.stderr.write(`WARNING: Package(s) not found: ${missing.join(", ")}\n`);
    }
    return found.length ? 0 : 1;
  }

  async function pipCheck(indexUrl) {
    const { data, dists } = await queryDists(indexUrl);
    if (!data.requirementsAvailable) {
      process.stderr.write(
        "pip: cannot read dependency metadata (the 'packaging' package did not load).\n" +
          "     Refusing to report a clean bill of health it cannot verify.\n",
      );
      return 1;
    }
    const inStore = new Set(dists.map((d) => d.name));
    const problems = data.problems.filter((p) => inStore.has(p.name));
    process.stdout.write(formatPipCheck(problems));
    return problems.length ? 1 : 0;
  }

  async function pipUninstall(indexUrl, names, opts) {
    const wanted = (names || []).filter(Boolean);
    if (!wanted.length) {
      process.stderr.write("ERROR: Please provide a package name or names.\n");
      return 1;
    }
    // The -y policy is argv policy and lives in programs/python.js with the
    // other flag rules; this is the backstop for any other caller.
    if (!(opts && opts.yes)) {
      process.stderr.write("pip: uninstall needs -y.\n");
      return 1;
    }
    const { pyodide, cwd, env, dists } = await queryDists(indexUrl);
    // micropip does the removal, so it has to be here — queryDists only needs
    // packaging. Without this the first uninstall reports a failure it invented.
    try {
      await pyodide.loadPackage("micropip", loaderToStderr);
    } catch {
      /* reported by the per-package error below */
    }
    const fs = req("fs");
    const canon = (s) => String(s).toLowerCase().replace(/[-_.]+/g, "-");
    let removedAny = false;
    for (const w of wanted) {
      const hit = dists.find((d) => canon(d.name) === canon(w));
      if (!hit) {
        process.stdout.write(`WARNING: Skipping ${w} as it is not installed.\n`);
        continue;
      }
      process.stdout.write(`Found existing installation: ${hit.name} ${hit.version}\n`);
      process.stdout.write(`Uninstalling ${hit.name}-${hit.version}:\n`);
      const before = walkPyodide(pyodide, env.sitePackages);
      try {
        pyodide.runPython(uninstallSource(hit.name));
      } catch (e) {
        process.stderr.write(`ERROR: Cannot uninstall ${hit.name}: ${(e && e.message) || e}\n`);
        return 1;
      }
      const after = walkPyodide(pyodide, env.sitePackages);
      const p = storePaths(cwd, env.pyTag);
      for (const rel of before.keys()) {
        if (after.has(rel)) continue;
        try {
          fs.unlinkSync(p.sitePackages + "/" + rel);
        } catch {
          /* not in the store, or already gone */
        }
      }
      process.stdout.write(`  Successfully uninstalled ${hit.name}-${hit.version}\n`);
      removedAny = true;
    }
    if (removedAny) {
      try {
        writeStore(req("fs"), cwd, env, new Map(), "python -m pip uninstall " + wanted.join(" "));
      } catch {
        /* the files are gone either way; the stamp refresh is bookkeeping */
      }
    }
    return 0;
  }

  // ---- python -m venv ---------------------------------------------------------
  async function venv(indexUrl, dir, opts) {
    const fs = req("fs");
    const path = req("path");
    const o = opts || {};
    const cwd = process.cwd();
    const target = path.isAbsolute(dir) ? dir : path.join(cwd, dir);
    // The store's path is derived from the project directory, so a venv
    // somewhere else would be created and then never looked at again.
    if (path.resolve(target) !== path.resolve(path.join(cwd, STORE_DIR))) {
      process.stderr.write(
        `python -m venv: this shim can only create the store at ./${STORE_DIR}, and you asked\n` +
          `                for '${dir}'. The path is not cosmetic: every python command in this\n` +
          `                project looks for ./${STORE_DIR} and nowhere else.\n`,
      );
      return 1;
    }
    const pyodide = await bootPyodide(indexUrl);
    const env = pyEnv(pyodide);
    const p = storePaths(cwd, env.pyTag);
    const existing = readStamp(req("fs"), cwd);

    if (existing && o.clear) {
      try {
        fs.rmSync(p.root, { recursive: true, force: true });
      } catch (e) {
        process.stderr.write(`python -m venv: could not clear ${dir}: ${(e && e.message) || e}\n`);
        return 1;
      }
    } else if (existing) {
      const problem = stampProblem(existing, env);
      if (problem) {
        // Refusing beats silently deleting a store the user may still want to
        // copy something out of.
        process.stderr.write(
          `python -m venv: ${dir} already exists but ${problem}, so it cannot be used\n` +
            "                as it is. Nothing has been changed. To discard it and start over:\n" +
            `                    python -m venv --clear ${dir}\n`,
        );
        return 1;
      }
      const total = writeStore(req("fs"), cwd, env, new Map(), "python -m venv " + dir);
      process.stdout.write(
        `${dir} already exists (${total.files} files, ${humanBytes(total.bytes)}); refreshed its ` +
          "configuration.\n",
      );
      return 0;
    }

    try {
      writeStore(req("fs"), cwd, env, new Map(), "python -m venv " + dir);
    } catch (e) {
      process.stderr.write(`python -m venv: could not create ${dir}: ${(e && e.message) || e}\n`);
      return 1;
    }
    // Real venv prints nothing. This is not a real venv, and the difference is
    // the one thing a user needs to be told once.
    process.stdout.write(
      `Created ${dir} - a package store for Python ${env.pythonVersion}.\n` +
        "pip install writes here, and every python command in this project reads it.\n" +
        "There is no separate interpreter to activate, and nothing to isolate from:\n" +
        "each command boots one CPython/WASM interpreter and restores this into it.\n",
    );
    return 0;
  }

  // ---- interactive REPL ------------------------------------------------------
  function repl(indexUrl) {
    return new Promise((resolve) => {
      bootPyodide(indexUrl).then((pyodide) => {
        let version = "";
        try {
          version = pyodide.runPython("import sys; sys.version.split(' ')[0]");
        } catch {
          /* ignore */
        }
        process.stdout.write(
          `Python ${version} (Pyodide) on Vivari\nType "exit()" or press Ctrl-D to quit.\n`,
        );
        // Drive Python's own InteractiveConsole so multi-line blocks work.
        pyodide.runPython("import code as _vv_code\n_vv_console = _vv_code.InteractiveConsole()");
        const console_ = pyodide.globals.get("_vv_console");

        let more = false;
        const prompt = () => process.stdout.write(more ? "... " : ">>> ");
        prompt();

        const stdin = process.stdin;
        let buf = "";
        const finish = (codeVal) => {
          try {
            console_.destroy && console_.destroy();
          } catch {
            /* ignore */
          }
          resolve(codeVal | 0);
        };

        const feed = (line) => {
          try {
            // InteractiveConsole.push returns True when more input is needed.
            more = !!console_.push(line);
          } catch (e) {
            process.stderr.write(((e && e.message) || String(e)) + "\n");
            more = false;
          }
          // The statement's own output has to land before the next prompt, or
          // buffered text appears after the ">>> " that invited the next line.
          flushStreams(pyodide);
          prompt();
        };

        if (stdin.setEncoding) stdin.setEncoding("utf8");
        if (stdin.resume) stdin.resume();
        stdin.on("data", (chunk) => {
          buf += typeof chunk === "string" ? chunk : String(chunk);
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, "");
            buf = buf.slice(idx + 1);
            feed(line);
          }
        });
        stdin.on("end", () => finish(0));
        stdin.on("close", () => finish(0));
      }, (e) => {
        process.stderr.write(`python: failed to start Pyodide: ${(e && e.message) || e}\n`);
        resolve(1);
      });
    });
  }

  // ---- web server bridge (Flask WSGI / FastAPI ASGI) -------------------------
  // Best-effort: make sure the named packages are importable in THIS Pyodide
  // (each process is a fresh boot, so the project's `pip install` step — a
  // separate process — did not load them here). Vendored/lock packages load
  // same-origin/CDN; pure-Python PyPI packages (e.g. flask) fall back to micropip.
  async function ensurePackages(pyodide, list) {
    const names = (list || []).filter(Boolean);
    if (!names.length) return;
    try {
      await pyodide.loadPackage(names, loaderToStderr);
      return;
    } catch {
      /* not all are Pyodide-distributed — try micropip for the rest */
    }
    try {
      await pyodide.loadPackage("micropip", loaderToStderr);
      const micropip = pyodide.pyimport("micropip");
      await micropip.install(names);
    } catch {
      /* a still-missing import surfaces as a Python ImportError at app import */
    }
  }

  function readRequirements(cwd) {
    const fs = req("fs");
    const path = req("path");
    try {
      const text = fs.readFileSync(path.join(cwd, "requirements.txt"), "utf8");
      return text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && l.charAt(0) !== "#");
    } catch {
      return [];
    }
  }


  // Write out whatever the last request touched. Never throws: a server that
  // dies because a file could not be mirrored would be a worse bug than the one
  // this fixes.
  function persist(workdir, tracker) {
    try {
      mirrorTracked(workdir, tracker);
    } catch {
      /* best-effort */
    }
  }

  // `python -m http.server [port]` — CPython's SimpleHTTPRequestHandler, driven
  // over the guest-Node bridge instead of a socket. See STATIC_SERVER_SOURCE for
  // why the handler is the real one and the socket is not.
  function serveStatic(indexUrl, opts) {
    const { port, directory, cwd, protocol } = opts || {};
    const bindPort = port | 0;

    return new Promise((resolve, reject) => {
      bootPyodide(indexUrl).then(async (pyodide) => {
        const workdir = cwd || process.cwd();
        const root = directory
          ? req("path").resolve(workdir, directory)
          : workdir;
        try {
          mirrorIn(pyodide, workdir);
          pyodide.FS.chdir(workdir);
        } catch {
          /* serve from the default home dir */
        }
        if (!pyodide.FS.analyzePath(root).exists) {
          reject(new Error(`python -m http.server: ${directory}: No such directory`));
          return;
        }

        let handle;
        try {
          pyodide.runPython(STATIC_SERVER_SOURCE);
          handle = pyodide.globals.get("_vv_static");
        } catch (e) {
          reject(new Error(`failed to set up http.server: ${(e && e.message) || e}`));
          return;
        }

        const http = req("http");
        const server = http.createServer((sreq, sres) => {
          const chunks = [];
          sreq.on("data", (c) => chunks.push(c));
          sreq.on("end", () => {
            try {
              // Rebuild the request the handler would have read off the wire.
              // The incoming Connection header is dropped and `close` sent in
              // its place: the buffer holds exactly one request, and saying so
              // is what sets close_connection on the first pass. handle() would
              // in fact stop anyway — the BytesIO comes up empty and a short
              // read ends the loop — but that is termination by accident of the
              // transport, and Node upstream is keeping its own connection
              // alive regardless of what this handler is told.
              const raw = sreq.rawHeaders || [];
              let prefix = "";
              const lines = [`${sreq.method || "GET"} ${sreq.url || "/"} HTTP/1.1`];
              for (let i = 0; i + 1 < raw.length; i += 2) {
                if (raw[i].toLowerCase() === "connection") continue;
                if (raw[i].toLowerCase() === "x-forwarded-prefix") prefix = raw[i + 1];
                lines.push(`${raw[i]}: ${raw[i + 1]}`);
              }
              lines.push("Connection: close", "", "");
              const wire = globalThis.Buffer.concat([
                globalThis.Buffer.from(lines.join("\r\n"), "latin1"),
                globalThis.Buffer.concat(chunks),
              ]);

              // A plain Uint8Array, not the Buffer: Pyodide refuses a Buffer
              // with "Unknown typed array type". Python `bytes` comes back as a
              // PyProxy, so toJs() to get at the array.
              const result = handle(
                new Uint8Array(wire.buffer, wire.byteOffset, wire.byteLength),
                root,
                bindPort,
                protocol || "HTTP/1.0",
              );
              const outBytes = globalThis.Buffer.from(result.toJs());
              result.destroy();
              flushStreams(pyodide);

              const split = outBytes.indexOf("\r\n\r\n");
              const head = outBytes.slice(0, split === -1 ? outBytes.length : split).toString("latin1");
              const body = split === -1 ? globalThis.Buffer.alloc(0) : outBytes.slice(split + 4);
              const headLines = head.split("\r\n");
              const status = parseInt((headLines[0] || "").split(" ")[1], 10) || 200;
              const outHeaders = {};
              for (const line of headLines.slice(1)) {
                const c = line.indexOf(":");
                if (c === -1) continue;
                const k = line.slice(0, c).trim();
                let v = line.slice(c + 1).trim();
                // The tunnel strips /preview/<port> before the handler sees the
                // path, so the redirect it emits for a directory without a
                // trailing slash would point outside the preview. Put the prefix
                // back, the same way the WSGI seam hands over root_path.
                if (prefix && k.toLowerCase() === "location" && v.startsWith("/")) v = prefix + v;
                outHeaders[k] = v;
              }
              delete outHeaders["Content-Length"];
              delete outHeaders["content-length"];
              sres.writeHead(status, outHeaders);
              sres.end(sreq.method === "HEAD" ? undefined : body);
            } catch (e) {
              const msg = "Internal Server Error\n\n" + ((e && e.stack) || e) + "\n";
              try {
                sres.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
              } catch {
                /* headers already sent */
              }
              sres.end(msg);
              process.stderr.write(msg);
            }
          });
          sreq.on("error", () => {
            try {
              sres.writeHead(400);
              sres.end();
            } catch {
              /* ignore */
            }
          });
        });
        server.on("error", (e) => reject(e));
        server.listen(bindPort, () => {
          process.stdout.write(
            `Serving HTTP on 0.0.0.0 port ${bindPort} (http://0.0.0.0:${bindPort}/) ...\n`,
          );
        });
        server.on("close", () => resolve(0));
      }, (e) => {
        reject(new Error(`failed to start Pyodide: ${(e && e.message) || e}`));
      });
    });
  }

  // Long-running: boot Pyodide, import the WSGI/ASGI app, then stand up a guest
  // Node http server on `port`. Resolves only when the server closes/errors, so
  // the listening handle keeps the process alive (like Express's app.listen).
  function serve(indexUrl, opts) {
    const { app, port, cwd } = opts || {};
    const mode = opts && opts.mode === "asgi" ? "asgi" : "wsgi";
    const colon = String(app || "").indexOf(":");
    const moduleName = colon === -1 ? String(app || "main") : app.slice(0, colon);
    const attrName = colon === -1 ? "app" : app.slice(colon + 1) || "app";
    const bindPort = port | 0;

    return new Promise((resolve, reject) => {
      bootPyodide(indexUrl).then(async (pyodide) => {
        const workdir = cwd || process.cwd();
        let snapshot = null;
        let tracker = null;
        try {
          snapshot = mirrorIn(pyodide, workdir);
          tracker = trackWrites(pyodide);
          pyodide.FS.chdir(workdir);
        } catch {
          /* run from default home dir */
        }
        try {
          reportRestore(restoreStore(req("fs"), pyodide, workdir));
        } catch {
          /* ensurePackages below is the fallback */
        }
        // Ensure the working dir is importable so `import main` resolves.
        try {
          pyodide.runPython(
            `import sys\nif ${JSON.stringify(workdir)} not in sys.path: sys.path.insert(0, ${JSON.stringify(workdir)})`,
          );
        } catch {
          /* non-fatal */
        }
        // Load the framework + declared requirements into THIS interpreter.
        const reqs = readRequirements(workdir);
        const wanted = reqs.length ? reqs : mode === "asgi" ? ["fastapi"] : ["flask"];
        await ensurePackages(pyodide, wanted);
        // Also auto-load anything the module imports that lives in the lock.
        try {
          const fs = req("fs");
          const src = fs.readFileSync(req("path").join(workdir, moduleName + ".py"), "utf8");
          await pyodide.loadPackagesFromImports(src, loaderToStderr);
        } catch {
          /* module may be a package or unreadable; app import will report */
        }

        let dispatch;
        try {
          pyodide.runPython(setupSource(moduleName, attrName, mode));
          dispatch = pyodide.globals.get("_vv_dispatch");
        } catch (e) {
          reject(new Error(`failed to import ${moduleName}:${attrName}: ${(e && e.message) || e}`));
          return;
        }

        const http = req("http");
        const server = http.createServer((sreq, sres) => {
          const chunks = [];
          sreq.on("data", (c) => chunks.push(c));
          sreq.on("end", async () => {
            try {
              const bodyBuf = globalThis.Buffer.concat(chunks);
              const urlStr = sreq.url || "/";
              const q = urlStr.indexOf("?");
              const reqPath = q === -1 ? urlStr : urlStr.slice(0, q);
              const query = q === -1 ? "" : urlStr.slice(q + 1);
              const headers = [];
              const raw = sreq.rawHeaders || [];
              let rootPath = "";
              for (let i = 0; i + 1 < raw.length; i += 2) {
                headers.push([raw[i], raw[i + 1]]);
                // The preview tunnel sets this when it strips /preview/<port> off
                // the path; hand it to the app as ASGI root_path / WSGI SCRIPT_NAME
                // so it generates prefixed absolute URLs that route back correctly.
                if (raw[i].toLowerCase() === "x-forwarded-prefix") rootPath = raw[i + 1];
              }
              const reqJson = JSON.stringify({
                method: sreq.method || "GET",
                path: reqPath,
                query,
                headers,
                http_version: sreq.httpVersion || "1.1",
                root_path: rootPath,
                body_b64: bodyBuf.length ? bodyBuf.toString("base64") : "",
              });
              const resultJson =
                mode === "asgi" ? await dispatch(reqJson) : dispatch(reqJson);
              // A server never "ends", so a print() inside a view would sit in
              // Python's buffer until 8 KB of it accumulated. Flush per request
              // instead: the request already cost far more than this does.
              flushStreams(pyodide);
              const out = JSON.parse(resultJson);
              const outHeaders = {};
              for (const [k, v] of out.headers || []) outHeaders[k] = v;
              const bodyOut = out.body_b64
                ? globalThis.Buffer.from(out.body_b64, "base64")
                : globalThis.Buffer.alloc(0);
              // Let Node compute a correct content-length for the decoded body.
              delete outHeaders["content-length"];
              delete outHeaders["Content-Length"];
              delete outHeaders["transfer-encoding"];
              delete outHeaders["Transfer-Encoding"];
              sres.writeHead(out.status || 200, outHeaders);
              sres.end(bodyOut);
              // A view that wrote a file — an upload, a SQLite commit — has
              // finished writing by now: the handler returned, and Pyodide has no
              // threads, so nothing else is mid-write. That makes the end of a
              // request the one boundary where "what the app has written so far"
              // is a complete answer, which is why persistence happens here and
              // not on a timer. It is off the response path (the bytes are
              // already out) and costs nothing when the request wrote nothing.
              persist(workdir, tracker);
            } catch (e) {
              const msg = "Internal Server Error\n\n" + ((e && e.stack) || e) + "\n";
              try {
                sres.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
              } catch {
                /* headers already sent */
              }
              sres.end(msg);
              process.stderr.write(msg);
              // A 500 is exactly when a half-finished write is most likely, and
              // exactly when the user most wants to see what got as far as disk.
              persist(workdir, tracker);
            }
          });
          sreq.on("error", () => {
            try {
              sres.writeHead(400);
              sres.end();
            } catch {
              /* ignore */
            }
          });
        });
        server.on("error", (e) => {
          reject(e);
        });
        // listen(port, cb) — the proven form (net registers the port with the
        // kernel regardless of host; a host arg would only risk a guest dns.lookup).
        server.listen(bindPort, () => {
          const kind = mode === "asgi" ? "ASGI" : "WSGI";
          process.stdout.write(
            `${kind} server (${moduleName}:${attrName}) running on http://localhost:${bindPort}\n`,
          );
        });
        server.on("close", () => {
          // The reconciling pass: everything tracked, plus a size diff over the
          // tree. Per-request mirroring should already have written all of it —
          // this is what makes a tracking regression cost a delay rather than
          // the data.
          try {
            if (snapshot) mirrorBack(pyodide, workdir, snapshot, tracker);
          } catch {
            /* best-effort */
          }
          resolve(0);
        });
      }, (e) => {
        reject(new Error(`failed to start Pyodide: ${(e && e.message) || e}`));
      });
    });
  }

  return {
    // Bound to a resolved same-origin indexURL by the launcher.
    install(indexUrl) {
      const idx = withTrailingSlash(indexUrl);
      return {
        runFile: (filePath, args) => runFile(idx, filePath, args),
        runCode: (source, args) => runCode(idx, source, args),
        runModule: (mod, args, cwd) => runModule(idx, mod, args, cwd),
        serveStatic: (o) => serveStatic(idx, o),
        pipInstall: (names) => pipInstall(idx, names),
        pipList: () => pipList(idx),
        pipFreeze: () => pipFreeze(idx),
        pipShow: (names) => pipShow(idx, names),
        pipCheck: () => pipCheck(idx),
        pipUninstall: (names, opts) => pipUninstall(idx, names, opts),
        venv: (dir, opts) => venv(idx, dir, opts),
        repl: () => repl(idx),
        serve: (opts) => serve(idx, opts),
      };
    },
  };
}