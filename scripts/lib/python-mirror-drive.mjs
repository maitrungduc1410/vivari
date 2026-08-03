// Drive the SHIPPED python runtime — real mirrorIn/trackWrites/mirrorBack, real
// serve() — against the stand-in interpreter and a real directory on the host.
//
// The mirroring is the part of the Python runtime that decides whether a file a
// program wrote still exists afterwards, and it is plain JavaScript: it needs a
// filesystem and an object shaped like Pyodide's FS, not CPython. So it can be
// gated in the offline tier, on every PR, instead of only where a real
// interpreter can be booted. scripts/lib/fake-pyodide.mjs supplies the FS —
// including the Emscripten tracking hooks, which is what makes this honest;
// spike-python-bridge separately holds real Pyodide to firing them.

import fsMod from "node:fs";
import pathMod from "node:path";
import httpMod from "node:http";
import { writeFakeIndex } from "./fake-pyodide.mjs";
import { createPythonRuntime } from "../../packages/runtime/builtins/python.js";

/** A runtime wired to the fake interpreter, rooted at a real host directory. */
export function mirrorRuntime(dir) {
  const idx = writeFakeIndex(fsMod, pathMod, pathMod.join(dir, ".fake-pyodide")) + "/";
  const out = [];
  const proc = {
    cwd: () => dir,
    env: {},
    stdout: { write: (s) => out.push(String(s)) },
    stderr: { write: (s) => out.push(String(s)) },
  };
  const runtime = createPythonRuntime({
    process: proc,
    require: (m) => (m === "fs" ? fsMod : m === "path" ? pathMod : m === "http" ? httpMod : {}),
    trackHost: () => {},
  });
  return { api: runtime.install(idx), out, dir };
}

/** `# VVFS {...}` — the fake interpreter's "and then the script wrote this". */
export function fsDirective(spec) {
  return "# VVFS " + JSON.stringify(spec);
}

/** Read a host file, or null when it is not there. */
export function hostRead(p) {
  try {
    return fsMod.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** GET a path off a server the runtime stood up on `port`. */
export function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const r = httpMod.get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
      );
    });
    r.on("error", reject);
  });
}

/** A port unlikely to collide with a parallel spike run. */
export function scratchPort(n) {
  return 21000 + ((process.pid + n * 97) % 9000);
}