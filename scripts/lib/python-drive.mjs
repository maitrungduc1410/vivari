// Run the shipped /bin/python.js against a stub runtime, and report what it
// asked the runtime to do. Argv parsing needs no Pyodide and no network, so
// both spike tiers share this: the offline tier gates it on every PR, the
// bridge tier re-runs it next to the real interpreter.

import { PYTHON_PROGRAM } from "../../packages/kernel-host/programs/python.js";

export const DRIVE_ENV = { VV_PYODIDE_INDEX_URL: "/vendor/pyodide/" };

export function drivePython(argv, env = DRIVE_ENV) {
  const calls = [];
  const written = [];
  const proc = {
    argv: ["node", "/bin/python.js", ...argv], env, cwd: () => "/project",
    stdout: { write: (s) => written.push(s) },
    stderr: { write: (s) => written.push(s) },
    exit(code) { const e = new Error("exit"); e.__processExit = code | 0; throw e; },
  };
  const py = {
    serve: async (o) => { calls.push(["serve", o]); },
    runCode: async (src) => { calls.push(["runCode", src]); return 0; },
    pip: async (n) => { calls.push(["pip", n]); return 0; },
  };
  const fn = new Function("require", "module", "process", "globalThis", PYTHON_PROGRAM);
  try { fn(() => ({}), { exports: {} }, proc, { __ocInstallPython: () => py }); }
  catch (e) { if (typeof e?.__processExit !== "number") throw e; }
  return { calls, out: written.join("") };
}

// The served app spec, or null if the command never reached serve().
export function servedApp(r) {
  const c = r.calls.find((x) => x[0] === "serve");
  return c ? c[1].app : null;
}