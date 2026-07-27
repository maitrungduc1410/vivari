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
// Scope (v1): run scripts + `-c` + a line REPL, streaming stdout/stderr to the
// terminal, with the project directory mirrored into Pyodide's FS so file I/O and
// sibling imports work. Prebuilt wheels (numpy/pandas/…) auto-load from the
// vendored, same-origin package index via loadPackagesFromImports. No HTTP/preview
// bridge (Pyodide has no real sockets).

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

  return {
    // Bound to a resolved same-origin indexURL by the launcher.
    install(indexUrl) {
      const idx = withTrailingSlash(indexUrl);
      return {
        runFile: (filePath, args) => runFile(idx, filePath, args),
        runCode: (source, args) => runCode(idx, source, args),
        pip: (names) => pip(idx, names),
        repl: () => repl(idx),
      };
    },
  };
}