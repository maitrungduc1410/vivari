// Run the shipped /bin/python.js against a stub runtime, and report what it
// asked the runtime to do. Argv parsing needs no Pyodide and no network, so
// both spike tiers share this: the offline tier gates it on every PR, the
// bridge tier re-runs it next to the real interpreter.

import { PYTHON_PROGRAM } from "../../packages/kernel-host/programs/python.js";
import { RUFF_PROGRAM } from "../../packages/kernel-host/programs/ruff.js";

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
    pipInstallEditable: async (t) => { calls.push(["pipInstallEditable", t]); return 0; },
    pipList: async () => { calls.push(["pipList"]); return 0; },
    pipFreeze: async () => { calls.push(["pipFreeze"]); return 0; },
    pipShow: async (n) => { calls.push(["pipShow", n]); return 0; },
    pipCheck: async () => { calls.push(["pipCheck"]); return 0; },
    pipUninstall: async (n, o) => { calls.push(["pipUninstall", n, o]); return 0; },
    venv: async (d, o) => { calls.push(["venv", d, o]); return 0; },
    runModule: async (m, a, c) => { calls.push(["runModule", m, a, c]); return 0; },
    runFile: async (f, a) => { calls.push(["runFile", f, a]); return 0; },
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
// Run the shipped /bin/ruff.js against a STUB ruff, on real files in a real
// temp directory, and report what it printed and what it left on disk.
//
// Stubbing the linter rather than the filesystem is deliberate. Everything this
// program gets wrong is on the outside of the wasm — which files it decides to
// read, which flags it refuses, whether a refusal writes anyway, what it exits
// with — and none of that needs 11 MB of Rust to check. The wasm's own answers
// are the bridge tier's job (spike-python-bridge.mjs, "ruff"), where the real
// one runs.
//
// The stub is written to disk as an ES module because the program reaches it
// the way it will in production: a dynamic import of VV_RUFF_URL, which is a
// URL and not a bundler-resolved name.
export async function driveRuff(argv, { cwd, diagnostics = [], formatted = null, files = {} } = {}) {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createRequire } = await import("node:module");

  const dir = cwd || fs.mkdtempSync(path.join(os.tmpdir(), "vv-ruff-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }

  // The stub records every source it is handed, which is how the path-walking
  // checks see what `ruff check .` decided to lint.
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-ruff-stub-"));
  fs.writeFileSync(path.join(stubDir, "ruff_wasm_bg.wasm"), "not really wasm");
  fs.writeFileSync(path.join(stubDir, "version.txt"), "9.9.9\n");
  fs.writeFileSync(
    path.join(stubDir, "ruff_wasm.js"),
    [
      "export const seen = { init: 0, checked: [], formatted: [], settings: null };",
      "globalThis.__vvRuffStub = seen;",
      "export default async function init() { seen.init++; }",
      "export class Workspace {",
      "  constructor(settings) { seen.settings = settings; }",
      "  static version() { return '9.9.9'; }",
      `  check(source) { seen.checked.push(source); return ${JSON.stringify(diagnostics)}; }`,
      `  format(source) { seen.formatted.push(source); return ${JSON.stringify(formatted)} ?? source; }`,
      "}",
    ].join("\n"),
  );

  const result = await runRuff(argv, dir, stubDir);
  const seen = globalThis.__vvRuffStub || { init: 0, checked: [], formatted: [], settings: null };
  delete globalThis.__vvRuffStub;
  return { ...result, seen };
}

// The same program against the REAL vendored ruff, for the bridge tier: same
// entry, same env var, 11 MB of actual Rust behind it.
export async function driveRuffReal(argv, cwd, vendorDir) {
  return runRuff(argv, cwd, vendorDir);
}

async function runRuff(argv, dir, baseDir) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { createRequire } = await import("node:module");
  const written = [];
  let code = null;
  // The program reports its status by assigning process.exitCode (it cannot
  // call exit(): the runtime's exit throws the loop's sentinel, which its own
  // catch would then report as a crash). So the assignment IS the completion
  // signal, and waiting for it beats sleeping a fixed number of turns and
  // hoping an 11 MB wasm finished instantiating inside them.
  let settled = false;
  let exitCode = 0;
  const proc = {
    argv: ["node", "/bin/ruff.js", ...argv],
    env: { VV_RUFF_URL: "file://" + baseDir + "/" },
    get exitCode() { return exitCode; },
    set exitCode(v) { exitCode = v | 0; settled = true; },
    cwd: () => dir,
    stdout: { write: (s) => written.push(String(s)) },
    stderr: { write: (s) => written.push(String(s)) },
    // First exit wins, matching driveShim: the runtime's real exit() throws the
    // loop's sentinel, so a program that keeps running after one would report
    // whichever code it reached last.
    exit(c) { if (code === null) code = c | 0; settled = true; const e = new Error("exit"); e.__processExit = code; throw e; },
  };
  const ocfetch = (url) => {
    const file = String(url).replace("file://", "");
    return fs.existsSync(file) ? { ok: true, status: 200, path: file } : { ok: false, status: 404, path: null };
  };

  const fn = new Function("require", "module", "process", "globalThis", RUFF_PROGRAM);
  fn(createRequire(import.meta.url), { exports: {} }, proc, { __ocfetch: ocfetch });
  // main() is async: give its promise chain (a dynamic import, an 11 MB wasm
  // instantiation on the real path, and a few file reads) time to settle.
  const deadline = Date.now() + 60000;
  while (!settled && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  const read = (rel) => {
    try { return fs.readFileSync(path.join(dir, rel), "utf8"); } catch { return null; }
  };
  return { out: written.join(""), code: code === null ? exitCode : code, dir, read, settled };
}
