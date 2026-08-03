// A stand-in interpreter, so the offline tier can run the real pip code paths in
// a real process and look at the real stdout.
//
// WHY IT EXISTS. `pip freeze > requirements.txt` wrote a file that began
//
//     Loading packaging
//     Loaded packaging
//     tabulate==0.10.0
//
// and every assertion we had was green, because they all checked what pip
// *formatted* rather than what the process *printed*. Catching that needs the
// whole path — launcher, runtime, package loader, stdout — which needs an
// interpreter, which the offline tier cannot have. So it gets this one.
//
// THE ONE BEHAVIOUR THAT HAS TO BE FAITHFUL is the last thing you would model
// by accident. Pyodide's PackageManager has its own `stdout`, defaulting to the
// interpreter's stdout stream — the one `setStdout` sets, which bootPyodide
// points at `process.stdout`. `loadPackage(names, {messageCallback})` swaps that
// default for the duration of the call; `loadPackage(names)` does not. So the
// bug lives entirely in which of those two you call, and a stand-in that printed
// nothing would make the gate pass on broken code. `loadPackage` below takes the
// same fork, and writes Pyodide's exact bytes: "Loading x, y" and "\n" as two
// separate writes, one message per call with the names comma-joined.
//
// (It is NOT console.log, which is the intuitive guess and is wrong — replacing
// globalThis.console before importing pyodide.mjs does not intercept these.)
// spike-python-bridge.mjs checks all of that against real Pyodide, the same
// arrangement as scripts/lib/urllib3-emscripten.mjs and for the same reason.
//
// Everything else here is the minimum the pip paths touch, and is deliberately
// dumb: an in-memory FS, and two `runPython` bodies matched by a fragment of
// their source. It is not a Python interpreter and must never grow into one —
// anything needing real Python belongs in the bridge tier.

// Pyodide reports progress as one message per call, comma-joined, not one per
// package. `pip install numpy pandas` prints "Loading numpy, pandas" once.
export function loaderLines(names) {
  const list = (Array.isArray(names) ? names : [names]).filter(Boolean);
  if (!list.length) return [];
  return [`Loading ${list.join(", ")}`, `Loaded ${list.join(", ")}`];
}

const encode = (s) => new TextEncoder().encode(String(s));

function memFS() {
  const files = new Map(); // path -> Uint8Array
  const dirs = new Set(["/"]);
  const norm = (p) => String(p).replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  return {
    files,
    dirs,
    // Emscripten calls these hooks from inside the real FS operations, which is
    // how the runtime knows which files Python touched. Modelling them here
    // rather than leaving the object empty is the whole point of the fake: a
    // mirror that relies on them can then be gated with no Wasm, and
    // spike-python-bridge separately holds REAL Pyodide to firing them.
    trackingDelegate: {},
    cwd: "/",
    mkdirTree(p) {
      const parts = norm(p).split("/").filter(Boolean);
      let cur = "";
      for (const part of parts) {
        cur += "/" + part;
        dirs.add(cur);
      }
    },
    chdir(p) {
      const n = norm(p);
      if (!dirs.has(n)) throw new Error("ENOENT: " + p);
      this.cwd = n;
    },
    analyzePath(p) {
      const n = norm(p);
      return { exists: dirs.has(n) || files.has(n) };
    },
    writeFile(p, data) {
      const n = norm(p);
      this.mkdirTree(n.slice(0, n.lastIndexOf("/")) || "/");
      files.set(n, data instanceof Uint8Array ? data : new TextEncoder().encode(String(data)));
      this.trackingDelegate.onWriteToFile?.(n);
    },
    unlink(p) {
      const n = norm(p);
      if (!files.delete(n)) throw new Error("ENOENT: " + p);
      this.trackingDelegate.onDeletePath?.(n);
    },
    rename(from, to) {
      const a = norm(from);
      const b = norm(to);
      const d = files.get(a);
      if (!d) throw new Error("ENOENT: " + from);
      files.delete(a);
      files.set(b, d);
      this.trackingDelegate.onMovePath?.(a, b);
    },
    readFile(p) {
      const d = files.get(norm(p));
      if (!d) throw new Error("ENOENT: " + p);
      return d;
    },
    readdir(p) {
      const n = norm(p);
      if (!dirs.has(n)) throw new Error("ENOENT: " + p);
      const out = new Set([".", ".."]);
      const prefix = n === "/" ? "/" : n + "/";
      for (const key of [...files.keys(), ...dirs]) {
        if (key === n || !key.startsWith(prefix)) continue;
        out.add(key.slice(prefix.length).split("/")[0]);
      }
      return [...out];
    },
    stat(p) {
      const n = norm(p);
      if (dirs.has(n)) return { size: 0, mode: 0o040755 };
      const d = files.get(n);
      if (!d) throw new Error("ENOENT: " + p);
      return { size: d.length, mode: 0o100644 };
    },
    isDir: (mode) => (mode & 0o170000) === 0o040000,
    isFile: (mode) => (mode & 0o170000) === 0o100000,
  };
}

// Reads the .dist-info directories out of the in-memory site-packages and
// answers DIST_QUERY from them, the way importlib.metadata would.
function distsFrom(FS, sitePackages) {
  const rows = [];
  let names;
  try {
    names = FS.readdir(sitePackages);
  } catch {
    return rows;
  }
  for (const dir of names) {
    if (!dir.endsWith(".dist-info")) continue;
    let meta = "";
    try {
      meta = new TextDecoder().decode(FS.readFile(`${sitePackages}/${dir}/METADATA`));
    } catch {
      continue;
    }
    const field = (k) => (meta.match(new RegExp("^" + k + ": (.*)$", "m")) || [, ""])[1];
    rows.push({
      name: field("Name"),
      version: field("Version"),
      distInfo: dir,
      summary: field("Summary"),
      homePage: field("Home-page"),
      author: field("Author"),
      authorEmail: field("Author-email"),
      license: field("License"),
      licenseExpression: field("License-Expression"),
      location: sitePackages,
      requires: [],
      requiredBy: [],
    });
  }
  return rows;
}

export function makeFakePyodide({ pythonVersion = "3.14.2", pyodideVersion = "314.0.3" } = {}) {
  const FS = memFS();
  const pyTag = "python" + pythonVersion.split(".").slice(0, 2).join(".");
  const sitePackages = `/lib/${pyTag}/site-packages`;
  FS.mkdirTree(sitePackages);
  const loaded = [];

  // The fake's instruction set. It cannot execute Python, so a test that needs
  // "and then the script wrote these files" says so in the source it hands over:
  //
  //   # VVFS {"write": {"/proj/a.txt": "hi"}, "delete": ["/proj/b.txt"]}
  //
  // The writes go through FS.writeFile/unlink, so they fire the tracking hooks
  // exactly as a real interpreter's writes would — which is what lets the
  // mirroring be gated with no Wasm.
  const applyFsDirective = (code) => {
    const m = /^#\s*VVFS\s+(\{.*\})\s*$/m.exec(code);
    if (!m) return;
    const spec = JSON.parse(m[1]);
    for (const [p, contents] of Object.entries(spec.write || {})) FS.writeFile(p, String(contents));
    for (const p of spec.delete || []) {
      try { FS.unlink(p); } catch { /* already gone */ }
    }
    for (const [from, to] of spec.rename || []) FS.rename(from, to);
  };

  const answer = (code) => {
    applyFsDirective(code);
    // DIST_QUERY first: it calls sysconfig.get_path() too, so matching pyEnv's
    // probe on that alone answers this one with the wrong payload — silently,
    // since both are JSON.
    if (code.includes("_vv_collect")) {
      return JSON.stringify({
        location: sitePackages,
        dists: distsFrom(FS, sitePackages),
        problems: [],
        requirementsAvailable: true,
      });
    }
    // pyEnv()'s probe.
    if (code.includes("sysconfig.get_path")) {
      return JSON.stringify({ pyTag, pythonVersion, sitePackages });
    }
    return "";
  };

  // Pyodide buffers into these until setStdout/setStderr are called; bootPyodide
  // calls both immediately after loadPyodide, so the default target is whatever
  // the process's stdout is.
  let stdoutStream = { write: (b) => process.stdout.write(b) };
  let stderrStream = { write: (b) => process.stderr.write(b) };

  return {
    FS,
    loaded,
    version: pyodideVersion,
    setStdout(s) { stdoutStream = s; },
    setStderr(s) { stderrStream = s; },
    toPy: (v) => v,
    pyimport: () => ({ install: async () => {} }),
    runPython: (code) => answer(String(code)),
    runPythonAsync: async (code) => answer(String(code)),
    // serve() runs setupSource() and then reads _vv_dispatch out of globals.
    // The stand-in app writes and deletes files on request, because "did a file
    // a request produced reach the host?" is the question serve() has to answer.
    globals: {
      get: (name) => {
        if (name !== "_vv_dispatch") return undefined;
        return (reqJson) => {
          const r = JSON.parse(reqJson);
          const seg = r.path.split("/").filter(Boolean);
          const here = FS.cwd === "/" ? "" : FS.cwd;
          let body = "ok";
          if (seg[0] === "write") FS.writeFile(`${here}/${seg[1]}`, decodeURIComponent(seg[2] || ""));
          else if (seg[0] === "delete") { try { FS.unlink(`${here}/${seg[1]}`); } catch { /* gone */ } }
          else if (seg[0] === "boom") {
            // Write first, THEN fail: the point of persisting on a 500 is that
            // whatever reached the filesystem before the error is not lost.
            FS.writeFile(`${here}/${seg[1]}`, "half");
            throw new Error("the app raised");
          }
          return JSON.stringify({
            status: 200,
            headers: [["content-type", "text/plain"]],
            body_b64: Buffer.from(body).toString("base64"),
          });
        };
      },
    },
    // The fidelity point. See the header: no messageCallback means the
    // interpreter's own stdout stream, which is the whole bug.
    loadPackage(names, options) {
      const list = (Array.isArray(names) ? names : [names]).filter(Boolean);
      loaded.push(...list);
      const say = (options && options.messageCallback)
        || ((m) => { stdoutStream.write(encode(m)); stdoutStream.write(encode("\n")); });
      for (const line of loaderLines(list)) say(line);
      return Promise.resolve([]);
    },
    loadPackagesFromImports(_code, options) {
      return this.loadPackage([], options);
    },
  };
}

// bootPyodide() does `import(indexUrl + "pyodide.mjs")` and calls
// `mod.loadPyodide(...)`, so a stand-in has to be reachable as a module at a
// URL. This writes the smallest one that re-exports the fake.
export function writeFakeIndex(fs, path, dir, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const here = new URL("./fake-pyodide.mjs", import.meta.url).href;
  fs.writeFileSync(
    path.join(dir, "pyodide.mjs"),
    `import { makeFakePyodide } from ${JSON.stringify(here)};\n` +
      `export const loadPyodide = async () => makeFakePyodide(${JSON.stringify(opts)});\n`,
  );
  return dir;
}