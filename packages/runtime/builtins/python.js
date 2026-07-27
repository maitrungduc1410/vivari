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

// Directories we never mirror between the project and Pyodide's FS.
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

export function createPythonRuntime({ process, require }) {
  const req = (name) => require(name);

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
        const decoder = new TextDecoder();
        const toText = (chunk) =>
          typeof chunk === "string" ? chunk : decoder.decode(chunk);
        const pyodide = await mod.loadPyodide({
          indexURL: url,
          // Emscripten calls these line-at-a-time without the trailing newline.
          stdout: (line) => process.stdout.write(toText(line) + "\n"),
          stderr: (line) => process.stderr.write(toText(line) + "\n"),
        });
        return pyodide;
      } finally {
        restoreEnv();
      }
    })();
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

  function mirrorBack(pyodide, cwd, snapshot) {
    const fs = req("fs");
    const path = req("path");
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
          // Only write files the script created or resized (cheap heuristic that
          // avoids re-writing the whole tree every run).
          if (snapshot.get(full) === st.size) continue;
          let data;
          try {
            data = pyodide.FS.readFile(full);
          } catch {
            continue;
          }
          try {
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, globalThis.Buffer.from(data));
          } catch {
            /* skip unwritable path */
          }
        }
      }
    };
    walk(cwd);
  }

  // ---- execution -------------------------------------------------------------
  function exitCodeFromError(e) {
    const msg = (e && e.message) || String(e);
    const m = /SystemExit:\s*(-?\d+)/.exec(msg);
    if (m) return Number(m[1]) | 0;
    if (/SystemExit/.test(msg)) return 0; // bare sys.exit()
    return 1;
  }

  async function runSource(indexUrl, source, opts) {
    const { filename = "<stdin>", argv, cwd } = opts || {};
    const pyodide = await bootPyodide(indexUrl);
    let snapshot = null;
    if (cwd) {
      try {
        snapshot = mirrorIn(pyodide, cwd);
        pyodide.FS.chdir(cwd);
      } catch {
        /* run anyway from the default home dir */
      }
    }
    try {
      pyodide.runPython(`import sys; sys.argv = ${JSON.stringify(argv || [filename])}`);
    } catch {
      /* non-fatal */
    }
    // Auto-load any vendored prebuilt packages the script imports (numpy, …).
    try {
      await pyodide.loadPackagesFromImports(source);
    } catch {
      /* a missing package surfaces as a Python ImportError below */
    }
    let code = 0;
    try {
      await pyodide.runPythonAsync(source, { filename });
    } catch (e) {
      const msg = (e && e.message) || String(e);
      process.stderr.write(msg.endsWith("\n") ? msg : msg + "\n");
      code = exitCodeFromError(e);
    } finally {
      if (cwd && snapshot) {
        try {
          mirrorBack(pyodide, cwd, snapshot);
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

  // ---- pip (best-effort): vendored wheel first, then micropip (network) ------
  async function pip(indexUrl, names) {
    const pyodide = await bootPyodide(indexUrl);
    const list = (names || []).filter(Boolean);
    if (!list.length) {
      process.stderr.write("pip: no packages specified\n");
      return 1;
    }
    try {
      // Resolves per-package from the hybrid lock: vendored wheels load
      // same-origin (offline), the rest from the Pyodide CDN (see scripts/
      // vendor-pyodide.mjs). micropip below handles pure-Python PyPI packages
      // that aren't in Pyodide's distribution at all.
      await pyodide.loadPackage(list);
      process.stdout.write(`Installed: ${list.join(", ")}\n`);
      return 0;
    } catch {
      /* not a Pyodide-distributed package — fall through to micropip (PyPI) */
    }
    try {
      await pyodide.loadPackage("micropip");
      const micropip = pyodide.pyimport("micropip");
      await micropip.install(list);
      process.stdout.write(`Installed via micropip: ${list.join(", ")}\n`);
      return 0;
    } catch (e) {
      process.stderr.write(
        `pip: could not install ${list.join(", ")}: ${(e && e.message) || e}\n`,
      );
      return 1;
    }
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
      await pyodide.loadPackage(names);
      return;
    } catch {
      /* not all are Pyodide-distributed — try micropip for the rest */
    }
    try {
      await pyodide.loadPackage("micropip");
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

  // Python side of the bridge. Imports the user's app once and defines a single
  // dispatch function per protocol. Requests/responses cross as JSON strings with
  // base64 bodies (JS strings convert to Python str cleanly; PyProxy/typed-array
  // conversions do not need to be reasoned about). Injected: module + attr.
  function setupSource(moduleName, attrName, mode) {
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
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": d.get("http_version", "1.1"),
        "method": d["method"],
        "scheme": "http",
        "path": d["path"],
        "raw_path": d["path"].encode("utf-8"),
        "query_string": d.get("query", "").encode("utf-8"),
        "root_path": d.get("root_path", ""),
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
        try {
          mirrorIn(pyodide, workdir);
          pyodide.FS.chdir(workdir);
        } catch {
          /* run from default home dir */
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
          await pyodide.loadPackagesFromImports(src);
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
        server.on("close", () => resolve(0));
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
        pip: (names) => pip(idx, names),
        repl: () => repl(idx),
        serve: (opts) => serve(idx, opts),
      };
    },
  };
}