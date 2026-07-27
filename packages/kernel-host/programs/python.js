// The `python` (and `python3`) program — an ordinary CommonJS Node program that
// runs as a process inside Vivari, installed as /bin/python.js + /bin/python3.js
// (see coreutils.js), so from the shell it is just `python` on PATH. It is the
// CLI half of Python support; the runtime half (Pyodide/CPython WASM boot, VFS
// mirroring, stdout wiring, package auto-load) lives in packages/runtime.
//
// Unlike npm/yarn/pnpm (real vendored JS CLIs), Python is CPython compiled to
// WebAssembly, so — exactly like the Bun shim — this is a purpose-built analog:
//   python <file.py> [args]   run a script (project dir mirrored into Pyodide FS)
//   python -c "code" [args]   run an inline program
//   python                    start an interactive REPL
//   python -m pip install ... install packages (vendored wheel first, else micropip)
//   python -m uvicorn m:app   serve a FastAPI/ASGI app via a guest http bridge
//   python -m flask run       serve a Flask/WSGI app via a guest http bridge
//   python --version          print the interpreter version (does NOT boot Pyodide)
//
// The heavy Pyodide bundle is fetched from the same-origin vendored index
// (VV_PYODIDE_INDEX_URL, set by the kernel) ONLY when this program actually runs,
// via globalThis.__ocInstallPython — so a plain node/bun process pays nothing.
//
// Authoring note: like programs/bun.js this source is embedded as a template
// string, so it deliberately uses NO backticks, NO ${...} and NO backslashes.
// Newlines come from String.fromCharCode(10).

export const PYTHON_PROGRAM = `
'use strict';
const NL = String.fromCharCode(10);
function out(s) { process.stdout.write(s + NL); }
function err(s) { process.stderr.write(s + NL); }

const argv = process.argv.slice(2);

// Kept in sync with the vendored Pyodide (Python 3.14 line). Printed for
// --version WITHOUT booting Pyodide, so version checks stay instant + lazy.
const STATIC_VERSION = 'Python 3.14 (Pyodide, Vivari)';

const HELP = [
  'Vivari python (Pyodide shim)',
  '',
  'Usage: python [option] ... [-c cmd | -m mod | file] [arg] ...',
  '',
  '  python <file.py> [args]     run a script file',
  '  python -c "code" [args]     run an inline program',
  '  python                      start an interactive REPL',
  '  python -m pip install ...   install packages (vendored wheel, else micropip)',
  '  python -m uvicorn main:app  serve a FastAPI/ASGI app (opens a preview)',
  '  python -m flask run         serve a Flask/WSGI app (opens a preview)',
  '  python --version            print the interpreter version',
].join(NL);

function getPy() {
  const idx = process.env.VV_PYODIDE_INDEX_URL || '';
  if (typeof globalThis.__ocInstallPython !== 'function') {
    err('python: the Pyodide runtime is unavailable in this build.');
    process.exit(1);
  }
  if (!idx) {
    err('python: VV_PYODIDE_INDEX_URL is not set; cannot locate the vendored Pyodide.');
    process.exit(1);
  }
  return globalThis.__ocInstallPython(idx);
}

function readRequirements(file) {
  const fs = require('fs');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { err('python: cannot read ' + file); process.exit(1); }
  const pkgs = [];
  const lines = text.split(NL);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.charAt(0) === '#') continue;
    pkgs.push(line);
  }
  return pkgs;
}

async function doPip(rest) {
  if (rest[0] !== 'install') {
    err('python -m pip: only the "install" subcommand is supported in the Vivari shim.');
    process.exit(1);
    return;
  }
  const items = rest.slice(1);
  const pkgs = [];
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (a === '-r' || a === '--requirement') {
      const f = items[i + 1]; i++;
      if (f) { const more = readRequirements(f); for (let j = 0; j < more.length; j++) pkgs.push(more[j]); }
    } else if (a.charAt(0) === '-') {
      // ignore pip-only flags (quiet, no-cache-dir, upgrade, ...)
    } else {
      pkgs.push(a);
    }
  }
  if (!pkgs.length) { err('pip: nothing to install'); process.exit(1); return; }
  const py = getPy();
  const code = await py.pip(pkgs);
  process.exit(code | 0);
}

async function doUvicorn(rest) {
  let app = '';
  let host = '';
  let port = 0;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--host') { host = rest[i + 1] || ''; i++; }
    else if (a.indexOf('--host=') === 0) { host = a.slice(7); }
    else if (a === '--port' || a === '-p') { port = parseInt(rest[i + 1] || '0', 10); i++; }
    else if (a.indexOf('--port=') === 0) { port = parseInt(a.slice(7), 10); }
    else if (a.charAt(0) === '-') { /* ignore uvicorn-only flags (--reload, --factory, --workers, ...) */ }
    else if (!app) { app = a; }
  }
  if (!app) { err('uvicorn: no app specified (expected module:attr, e.g. main:app)'); process.exit(1); return; }
  if (!port) port = parseInt(process.env.PORT || '8000', 10);
  const py = getPy();
  await py.serve({ app: app, mode: 'asgi', host: host, port: port });
  process.exit(0);
}

async function doFlask(rest) {
  let appSpec = process.env.FLASK_APP || '';
  let host = '';
  let port = 0;
  let hasRun = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--app' || a === '-A') { appSpec = rest[i + 1] || appSpec; i++; }
    else if (a.indexOf('--app=') === 0) { appSpec = a.slice(6); }
    else if (a === 'run') { hasRun = true; }
    else if (a === '--host') { host = rest[i + 1] || ''; i++; }
    else if (a.indexOf('--host=') === 0) { host = a.slice(7); }
    else if (a === '--port' || a === '-p') { port = parseInt(rest[i + 1] || '0', 10); i++; }
    else if (a.indexOf('--port=') === 0) { port = parseInt(a.slice(7), 10); }
    else { /* ignore --debug / --reload / etc. */ }
  }
  if (!hasRun) { err('flask: only the "run" command is supported in the Vivari shim.'); process.exit(1); return; }
  if (!appSpec) appSpec = 'app';
  if (!port) port = parseInt(process.env.PORT || '8000', 10);
  const py = getPy();
  await py.serve({ app: appSpec, mode: 'wsgi', host: host, port: port });
  process.exit(0);
}

async function main() {
  const first = argv[0];

  if (first === '--version' || first === '-V') { out(STATIC_VERSION); process.exit(0); return; }
  if (first === '--help' || first === '-h') { out(HELP); process.exit(0); return; }

  if (first === '-c') {
    const code = argv[1] || '';
    const py = getPy();
    const rc = await py.runCode(code, argv.slice(2));
    process.exit(rc | 0);
    return;
  }

  if (first === '-m') {
    const mod = argv[1];
    const rest = argv.slice(2);
    if (mod === 'pip') { return doPip(rest); }
    if (mod === 'uvicorn') { return doUvicorn(rest); }
    if (mod === 'flask') { return doFlask(rest); }
    err('python -m ' + mod + ': running arbitrary modules is not supported in the Vivari shim yet (only "pip", "uvicorn", "flask").');
    process.exit(1);
    return;
  }

  if (!first) {
    const py = getPy();
    const rc = await py.repl();
    process.exit(rc | 0);
    return;
  }

  // Skip leading interpreter flags to reach the script path.
  let i = 0;
  while (i < argv.length && argv[i].length > 0 && argv[i].charAt(0) === '-' && argv[i] !== '-') i++;
  const file = argv[i];
  if (!file) { err('python: no script provided'); process.exit(1); return; }
  const py = getPy();
  const rc = await py.runFile(file, argv.slice(i + 1));
  process.exit(rc | 0);
}

main().catch(function (e) {
  // process.exit() unwinds by throwing a control-flow Error tagged
  // __processExit; the runtime already recorded the exit code, so this is a
  // normal termination, not a failure to report.
  if (e && typeof e.__processExit === 'number') { return; }
  process.stderr.write('python: ' + ((e && e.stack) || e) + NL);
  process.exit(1);
});
`;