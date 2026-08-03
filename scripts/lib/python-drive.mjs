// Run the shipped /bin/python.js against a stub runtime, and report what it
// asked the runtime to do. Argv parsing needs no Pyodide and no network, so
// both spike tiers share this: the offline tier gates it on every PR, the
// bridge tier re-runs it next to the real interpreter.

import { PYTHON_PROGRAM } from "../../packages/kernel-host/programs/python.js";

export const DRIVE_ENV = { VV_PYODIDE_INDEX_URL: "/vendor/pyodide/" };

export function drivePython(argv, env = DRIVE_ENV) {
  const calls = [];
  const written = [];
  // Recorded here rather than read off the thrown control-flow Error: the
  // handlers are async, so an exit() inside one rejects a promise instead of
  // unwinding through the call below, and the code would read as 0 for every
  // refusal. That is the wrong way round for a spike — a check on a refusal
  // would pass whether or not the refusal happened.
  let code = 0;
  const proc = {
    argv: ["node", "/bin/python.js", ...argv], env, cwd: () => "/project",
    stdout: { write: (s) => written.push(s) },
    stderr: { write: (s) => written.push(s) },
    exit(c) { code = c | 0; const e = new Error("exit"); e.__processExit = code; throw e; },
  };
  const py = {
    serve: async (o) => { calls.push(["serve", o]); },
    runCode: async (src) => { calls.push(["runCode", src]); return 0; },
    pipInstall: async (n) => { calls.push(["pipInstall", n]); return 0; },
    pipList: async () => { calls.push(["pipList"]); return 0; },
    pipFreeze: async () => { calls.push(["pipFreeze"]); return 0; },
    pipShow: async (n) => { calls.push(["pipShow", n]); return 0; },
    pipCheck: async () => { calls.push(["pipCheck"]); return 0; },
    pipUninstall: async (n, o) => { calls.push(["pipUninstall", n, o]); return 0; },
    venv: async (d, o) => { calls.push(["venv", d, o]); return 0; },
    runModule: async (m, a, c) => { calls.push(["runModule", m, a, c]); return 0; },
    serveStatic: async (o) => { calls.push(["serveStatic", o]); },
  };
  const fn = new Function("require", "module", "process", "globalThis", PYTHON_PROGRAM);
  try { fn(() => ({}), { exports: {} }, proc, { __ocInstallPython: () => py }); }
  catch (e) { if (typeof e?.__processExit !== "number") throw e; }
  return { calls, code, out: written.join("") };
}

// Run one of the PATH shims — /bin/pip.js, /bin/pytest.js and the rest — with
// child_process stubbed, and report the command it spawned. This is the half of
// the story drivePython cannot tell: drivePython starts at `python -m pip`, so
// it is blind to whether anything reaches `python -m pip` from the name a user
// types. `pip list` printing "sh: pip: not found" was invisible to every
// assertion we had for exactly that reason.
//
// exitWith replays the child's exit code so the shim's own code can be checked:
// a shim that swallows a failing exit breaks `pip install x && python main.py`.
export function driveShim(source, argv, { exitWith = 0, failWith = null } = {}) {
  let spawned = null;
  let code = null;
  const written = [];
  const handlers = {};
  const child = {
    stdout: { on: (ev, fn) => { handlers["out:" + ev] = fn; } },
    stderr: { on: (ev, fn) => { handlers["err:" + ev] = fn; } },
    on: (ev, fn) => { handlers[ev] = fn; },
  };
  const proc = {
    argv: ["node", "/bin/shim.js", ...argv],
    env: { ...DRIVE_ENV }, cwd: () => "/project",
    stdout: { write: (s) => written.push(String(s)) },
    stderr: { write: (s) => written.push(String(s)) },
    exit(c) { if (code === null) code = c | 0; },
  };
  const require = (m) => {
    if (m !== "child_process") throw new Error("shim required " + m);
    return { spawn: (cmd, args, opts) => { spawned = { cmd, args, opts }; return child; } };
  };
  new Function("require", "module", "process", source)(require, { exports: {} }, proc);
  if (failWith) handlers.error?.(new Error(failWith));
  else handlers.exit?.(exitWith);
  return { spawned, code: code === null ? 0 : code, out: written.join("") };
}

// The served app spec, or null if the command never reached serve().
export function servedApp(r) {
  const c = r.calls.find((x) => x[0] === "serve");
  return c ? c[1].app : null;
}