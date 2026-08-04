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
//   python -m pip install ... install into the project's .venv package store
//   python -m venv .venv     create that store
//   python -m uvicorn m:app   serve a FastAPI/ASGI app via a guest http bridge
//   python -m flask run       serve a Flask/WSGI app via a guest http bridge
//   python -m gunicorn m:app  serve any WSGI app (Django, Flask, ...) the same way
//   python -m pytest [args]   run a pytest suite and propagate its exit code
//   python -m mypy [args]     type-check, propagating mypy's exit code
//   python -m black [args]    format — plain runpy, on the wheel the editor uses
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

// Swallowing a flag we cannot honour is the "stub that lies" failure in argv
// form: real gunicorn -w 4 forks four workers, and accepting the flag in
// silence tells the user we did. Two tiers, mirroring builtins/bun.js:
//   warn   - the server still does the job, just not the way the flag asked
//   refuse - the flag changes WHAT is served, so guessing would be wrong
function warnIgnored(cmd, flag, why) {
  err(cmd + ': ' + flag + ' is ignored here - ' + why + '.');
}
function refuse(cmd, flag, why) {
  err(cmd + ': ' + flag + ' is not supported here - ' + why + '.');
  process.exit(1);
}

// --flag=value and "--flag value" spell the same thing; normalise so the
// dispatch below states each rule once.
function flagName(a) {
  const eq = a.indexOf('=');
  return eq === -1 ? a : a.slice(0, eq);
}
function inlineValue(a) {
  const eq = a.indexOf('=');
  return eq === -1 ? null : a.slice(eq + 1);
}

const argv = process.argv.slice(2);

// Printed for --version WITHOUT booting Pyodide, so a version check stays
// instant and the interpreter stays lazy. That is worth keeping, and it is why
// this is a literal: PYTHON_PROGRAM is a no-interpolation template literal, so
// it cannot import PYODIDE_PYTHON_VERSION from builtins/python.js the way
// ordinary code would. The number is therefore pinned by test instead of by
// import — spike-python-offline.mjs holds this literal against that constant,
// and the bridge spike holds the constant against sys.version in a real
// interpreter. Bump the vendored Pyodide without bumping both and CI fails.
// Full patch version, as real CPython prints it: python --version says 3.14.2.
const STATIC_VERSION = 'Python 3.14.2 (Pyodide, Vivari)';

const HELP = [
  'Vivari python (Pyodide shim)',
  '',
  'Usage: python [option] ... [-c cmd | -m mod | file] [arg] ...',
  '',
  '  python <file.py> [args]     run a script file',
  '  python -c "code" [args]     run an inline program',
  '  python                      start an interactive REPL',
  '  python -m venv .venv        create the package store this project installs into',
  '  python -m pip install ...   install into the store (vendored wheel, else micropip)',
  '  python -m pip list          what the store holds (also: freeze, show, check)',
  '  python -m pip uninstall -y  remove a package from the store',
  '  python -m uvicorn main:app  serve a FastAPI/ASGI app (opens a preview)',
  '  python -m flask run         serve a Flask/WSGI app (opens a preview)',
  '  python -m gunicorn wsgi:app serve any WSGI app - Django, Flask, ... (opens a preview)',
  '  python -m pytest [args]     run a pytest suite',
  '  python -m unittest ...      run the stdlib test runner (discover, -v, ...)',
  '  python -m http.server [port] serve the current directory (opens a preview)',
  '  python -m <module> [args]   run any other importable module, as CPython does',
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

// pip's read-only verbs all take the same shape here: boot, restore the store,
// read real dist metadata out of it. The store is what makes them meaningful -
// before it existed there was nothing durable for them to describe.
const PIP_VERBS = ['install', 'list', 'freeze', 'show', 'uninstall', 'check'];

// Real pip's command list, as bare 'pip' prints it. It is here to keep two
// different answers apart, which matters now that pip is on PATH and people will
// type the whole surface at it:
//   - 'download' is a command pip HAS and we have not. Saying 'unknown command'
//     about it would be false, and would send someone hunting for a typo.
//   - 'frobnicate' is a command nobody has, and real pip's exact words for that
//     are: ERROR: unknown command "frobnicate"
const PIP_REAL_COMMANDS = [
  'install', 'lock', 'download', 'uninstall', 'freeze', 'inspect', 'list', 'show',
  'check', 'config', 'search', 'cache', 'index', 'wheel', 'hash', 'completion',
  'debug', 'help',
];

// Real pip suggests when the typo is close, printing: unknown command "instal"
// - maybe you meant "install". Same shape, over the commands this shim has.
function nearestVerb(word) {
  let best = '';
  let bestScore = 3; // pip uses difflib; two edits is close enough to be a typo
  for (let i = 0; i < PIP_VERBS.length; i++) {
    const d = editDistance(String(word), PIP_VERBS[i]);
    if (d < bestScore) { bestScore = d; best = PIP_VERBS[i]; }
  }
  return best;
}

function editDistance(a, b) {
  const prev = [];
  for (let j = 0; j <= b.length; j++) prev.push(j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + cost);
      diag = tmp;
    }
  }
  return prev[b.length];
}

// Bare 'pip', 'pip --help' and 'pip help'. Real pip prints a usage block listing
// every command with a one-line description, and exits 0; this is the same block
// over the commands that exist here, so what a user reads is the truth about
// this pip rather than a copy of another one's menu.
const PIP_USAGE = [
  '',
  'Usage:   ',
  '  pip <command> [options]',
  '',
  'Commands:',
  "  install                     Install packages into this project's .venv store.",
  '  uninstall                   Remove packages from the store (needs -y).',
  '  freeze                      Output installed packages in requirements format.',
  '  list                        List installed packages.',
  '  show                        Show information about installed packages.',
  '  check                       Verify installed packages have compatible dependencies.',
  '',
  "This is Vivari's pip, not pip itself: it installs into a per-project package",
  'store at .venv/ and supports the six commands above. Anything else pip can do',
  'will say so rather than pretend. See "python --help" for the interpreter.',
].join(NL);

async function doPip(rest) {
  const verb = rest[0];

  if (!verb || verb === '--help' || verb === '-h' || verb === 'help') {
    out(PIP_USAGE);
    process.exit(0);
    return;
  }
  if (verb === '--version' || verb === '-V') {
    // Real pip prints: pip 25.3 from /path/to/pip (python 3.11). Keeping that
    // shape means a script grepping it still finds what it looks for; naming a
    // pip version we do not have would be the lie the shape invites.
    out('pip (Vivari shim for python -m pip) from /bin/pip.js (python 3.14)');
    process.exit(0);
    return;
  }

  if (PIP_VERBS.indexOf(verb) === -1) {
    if (verb === 'cache') {
      // Honest refusal rather than a command that looks familiar and does
      // something else. Real 'pip cache purge' clears pip's own download cache;
      // ours is the browser's HTTP cache, which nothing in the VM can evict.
      err('pip: there is no pip cache here - wheels are cached by the browser,');
      err('     which the VM cannot clear. To free space in the package store,');
      err('     use "pip uninstall <package>" or "python -m venv --clear .venv".');
      process.exit(1);
      return;
    }
    if (PIP_REAL_COMMANDS.indexOf(verb) === -1) {
      const near = nearestVerb(verb);
      err('ERROR: unknown command "' + String(verb) + '"' + (near ? ' - maybe you meant "' + near + '"' : ''));
      process.exit(1);
      return;
    }
    err('pip: "' + String(verb) + '" is a real pip command that this shim does not have (have: ' + PIP_VERBS.join(', ') + ').');
    process.exit(1);
    return;
  }
  const py = getPy();
  if (verb === 'list') { process.exit((await py.pipList()) | 0); return; }
  if (verb === 'freeze') { process.exit((await py.pipFreeze()) | 0); return; }
  if (verb === 'check') { process.exit((await py.pipCheck()) | 0); return; }
  if (verb === 'show') {
    const names = rest.slice(1).filter(function (a) { return a.charAt(0) !== '-'; });
    process.exit((await py.pipShow(names)) | 0);
    return;
  }
  if (verb === 'uninstall') {
    const names = [];
    let yes = false;
    const items2 = rest.slice(1);
    for (let k = 0; k < items2.length; k++) {
      const a = items2[k];
      if (a === '-y' || a === '--yes') { yes = true; }
      else if (a === '-r' || a === '--requirement') {
        const f = items2[k + 1]; k++;
        if (f) { const more = readRequirements(f); for (let j = 0; j < more.length; j++) names.push(more[j]); }
      } else if (a.charAt(0) !== '-') { names.push(a); }
    }
    if (!yes) {
      // Real pip asks "Proceed (Y/n)?" here. This shim has nowhere to ask, and
      // assuming the answer would delete a user's packages on a typo.
      err('pip: uninstall needs -y here. Real pip asks for confirmation at this point,');
      err('     and this shim has nowhere to ask, so it will not assume the answer.');
      process.exit(1);
      return;
    }
    process.exit((await py.pipUninstall(names, { yes: yes })) | 0);
    return;
  }
  const items = rest.slice(1);
  const pkgs = [];
  const editable = [];
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (a === '-r' || a === '--requirement') {
      const f = items[i + 1]; i++;
      if (f) { const more = readRequirements(f); for (let j = 0; j < more.length; j++) pkgs.push(more[j]); }
    } else if (a === '-e' || a === '--editable') {
      // Without this, -e fell into the ignore-unknown-flags arm below and the
      // dot was taken for a package name, so the line at the top of most Python
      // READMEs failed with "could not install .".
      const t = items[i + 1]; i++;
      if (t) { editable.push(t); }
    } else if (a.charAt(0) === '-') {
      // ignore pip-only flags (quiet, no-cache-dir, upgrade, ...)
    } else {
      pkgs.push(a);
    }
  }
  if (editable.length) {
    for (let i = 0; i < editable.length; i++) {
      const code = await py.pipInstallEditable(editable[i]);
      if (code) { process.exit(code | 0); return; }
    }
    // "pip install -e . requests" is legal, so the ordinary packages still go
    // through afterwards rather than being dropped.
    if (!pkgs.length) { process.exit(0); return; }
  }
  if (!pkgs.length) { err('pip: nothing to install'); process.exit(1); return; }
  const code = await py.pipInstall(pkgs);
  process.exit(code | 0);
}

// python -m venv: the one -m module that belongs with the store, because
// creating the store is the entirety of what it means here. Same two tiers as
// the server shims for flags: warn when the server still does the job, refuse
// when honouring it would mean claiming something untrue.
async function doVenv(rest) {
  let dir = '';
  let clear = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const name = flagName(a);
    if (a.charAt(0) !== '-') { if (!dir) dir = a; continue; }
    if (name === '--clear') { clear = true; continue; }
    if (name === '-h' || name === '--help') {
      out('Usage: python -m venv [--clear] .venv');
      out('');
      out('Creates the package store this project installs into. It is a store, not a');
      out('second interpreter: there is no bin/activate, and nothing to isolate from.');
      process.exit(0); return;
    }
    if (name === '--system-site-packages') {
      warnIgnored('venv', '--system-site-packages', 'already true - there is one interpreter and it always sees its own site-packages');
      continue;
    }
    if (name === '--without-pip') {
      warnIgnored('venv', '--without-pip', 'pip here is this shim, which is always present');
      continue;
    }
    if (name === '--copies' || name === '--symlinks') {
      warnIgnored('venv', name, 'no interpreter is copied or linked - the store holds packages only');
      continue;
    }
    if (name === '--prompt') { if (inlineValue(a) === null) i++; warnIgnored('venv', '--prompt', 'there is no shell to activate, so no prompt to change'); continue; }
    if (name === '--upgrade' || name === '--upgrade-deps') {
      refuse('venv', name, 'it would re-stamp a store built by a different interpreter, which is exactly the half-loaded state the stamp exists to prevent - use --clear');
      return;
    }
    refuse('venv', name, 'unknown option');
    return;
  }
  if (!dir) { err('python -m venv: no directory given (try: python -m venv .venv)'); process.exit(1); return; }
  const py = getPy();
  const code = await py.venv(dir, { clear: clear });
  process.exit(code | 0);
}

// Same contract as doGunicorn on the ASGI side, and the same rule about flags
// it cannot honour. (Predates the gunicorn seam; brought up to the same
// standard here so the two entrypoints do not disagree about what honesty is.)
async function doUvicorn(rest) {
  let app = '';
  let host = '';
  let port = 0;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const name = flagName(a);
    const inline = inlineValue(a);
    const valueOf = function () { if (inline !== null) return inline; i++; return rest[i]; };
    if (name === '--host') { host = valueOf() || ''; }
    else if (name === '--port' || name === '-p') { port = parseInt(valueOf() || '0', 10); }
    // --factory means the app spec names a callable that RETURNS the app. The
    // bridge imports the attribute and serves it as-is, so honouring the flag
    // silently would serve the factory function itself.
    else if (name === '--factory') { refuse('uvicorn', name, 'the bridge serves the imported attribute directly, so an app factory would be served instead of the app it builds'); }
    else if (name === '--workers' || name === '-w') { valueOf(); warnIgnored('uvicorn', name, 'the WASM VM has no OS threads and no fork, so there is exactly one worker'); }
    else if (name === '--reload') { warnIgnored('uvicorn', name, 'reloading needs a file watcher, which needs a thread; restart the process to pick up changes'); }
    // Same rule as gunicorn: consume the value, or '--log-level debug main:app'
    // serves an app called 'debug'.
    else if (a.charAt(0) === '-') { if (inline === null && UVICORN_BOOLEAN.indexOf(name) === -1) valueOf(); }
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
    // Flask spells the short host flag '-h', not '--help' — a real difference
    // from every other CLI here, and dropping it silently ignored the bind
    // address in 'flask run -h 0.0.0.0'.
    else if (a === '--host' || a === '-h') { host = rest[i + 1] || ''; i++; }
    else if (a.indexOf('--host=') === 0) { host = a.slice(7); }
    else if (a === '--port' || a === '-p') { port = parseInt(rest[i + 1] || '0', 10); i++; }
    else if (a.indexOf('--port=') === 0) { port = parseInt(a.slice(7), 10); }
    // --debug turns on the reloader and the interactive debugger, both of which
    // need a watcher thread; --reload asks for half of that on its own.
    else if (a === '--debug' || a === '--reload') { warnIgnored('flask', a, 'the reloader and the interactive debugger both need a file watcher, which needs a thread'); }
    else { /* --no-reload, --cert, and friends: nothing to contradict */ }
  }
  if (!hasRun) { err('flask: only the "run" command is supported in the Vivari shim.'); process.exit(1); return; }
  if (!appSpec) appSpec = 'app';
  if (!port) port = parseInt(process.env.PORT || '8000', 10);
  const py = getPy();
  await py.serve({ app: appSpec, mode: 'wsgi', host: host, port: port });
  process.exit(0);
}

// gunicorn ADDRESS is host:port, port-only, or host-only.
function parseBind(value) {
  const v = String(value || '');
  const c = v.lastIndexOf(':');
  if (c === -1) return { host: '', port: parseInt(v, 10) || 0 };
  return { host: v.slice(0, c), port: parseInt(v.slice(c + 1), 10) || 0 };
}

// gunicorn is THE canonical WSGI entrypoint, so it is the seam every WSGI
// framework reaches for — Django, Flask, Bottle, Pyramid — rather than one shim
// per framework. Like doUvicorn it never imports the package it is named after:
// it parses argv and hands the app spec to the same guest-http bridge. That is
// an honest entrypoint rather than a stub, because the observable contract —
// "your WSGI app is now served on this port" — is the one it delivers; what it
// cannot deliver is gunicorn's PROCESS MODEL, so those flags say so out loud.
// Every flag real gunicorn declares as store_true, from its own --help
// (gunicorn 23.x); everything else that starts with a dash there takes a value.
// Listing the ~12 booleans rather than the ~56 value-takers is both smaller and
// the safer way to be wrong: mistaking a boolean for a value-taker eats the app
// spec and reports 'no app specified', which the user sees, while the reverse
// leaves the value sitting there to be read as the app spec, and silently
// serves something they never named.
var GUNICORN_BOOLEAN = [
  '--reload', '--spew', '--check-config', '--print-config', '--preload',
  '--no-sendfile', '--reuse-port', '--initgroups', '--capture-output',
  '--log-syslog', '--no-control-socket', '--daemon', '-D',
  '--version', '-v', '--help', '-h',
];

// Likewise for uvicorn, from its own --help (uvicorn 0.3x). Click spells the
// negatable ones '--x / --no-x'; both spellings are boolean.
var UVICORN_BOOLEAN = [
  '--reload', '--factory', '--version', '--help', '--reset-contextvars',
  '--access-log', '--no-access-log', '--use-colors', '--no-use-colors',
  '--proxy-headers', '--no-proxy-headers', '--server-header',
  '--no-server-header', '--date-header', '--no-date-header',
];

async function doGunicorn(rest) {
  let app = '';
  let host = '';
  let port = 0;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const name = flagName(a);
    const inline = inlineValue(a);
    const valueOf = function () { if (inline !== null) return inline; i++; return rest[i]; };
    if (name === '--bind' || name === '-b') { const b = parseBind(valueOf()); host = b.host; port = b.port; }
    // -k picks the server model itself. 'sync' IS what the bridge does, so
    // spelling out the default is honoured; anything else (gevent, eventlet,
    // uvicorn.workers.UvicornWorker) would serve a different protocol, and
    // ignoring it would hand an ASGI app to the WSGI bridge and blame the app.
    else if (name === '--worker-class' || name === '-k') {
      const cls = valueOf();
      if (cls !== 'sync') { refuse('gunicorn', name + ' ' + cls, 'the bridge serves WSGI in-process, so only the default sync worker exists here'); }
    }
    else if (name === '--workers' || name === '-w' || name === '--threads') { valueOf(); warnIgnored('gunicorn', name, 'the WASM VM has no OS threads and no fork, so there is exactly one worker'); }
    else if (name === '--reload') { warnIgnored('gunicorn', name, 'reloading needs a file watcher, which needs a thread; restart the process to pick up changes'); }
    else if (name === '--daemon' || name === '-D') { warnIgnored('gunicorn', name, 'there is no process to detach into, so the server stays in the foreground'); }
    // Tuning and logging knobs with no worker to apply them to. Nothing to
    // honour or contradict, but the VALUE has to be consumed or it becomes the
    // app spec: 'gunicorn -t 30 wsgi:app' used to serve an app called '30'.
    else if (a.charAt(0) === '-') { if (inline === null && GUNICORN_BOOLEAN.indexOf(name) === -1) valueOf(); }
    else if (!app) { app = a; }
  }
  if (!app) { err('gunicorn: no app specified (expected module:attr, e.g. wsgi:application)'); process.exit(1); return; }
  if (!port) port = parseInt(process.env.PORT || '8000', 10);
  const py = getPy();
  await py.serve({ app: app, mode: 'wsgi', host: host, port: port });
  process.exit(0);
}

// pytest needs no new runtime API: synthesise the two-line program a user would
// write by hand and run it through the ordinary script path. That gets package
// auto-loading for free (the synthesised source imports pytest, so
// loadPackagesFromImports fetches the wheel) and exit-code propagation for free
// (sys.exit raises SystemExit, which the runtime already maps to a process exit
// code). int() because pytest.main returns an ExitCode enum.
async function doPytest(rest) {
  const args = rest.length ? rest : ['-q'];
  const src = [
    'import sys',
    'import pytest',
    'sys.exit(int(pytest.main(' + JSON.stringify(args) + ')))',
  ].join(NL);
  const py = getPy();
  const rc = await py.runCode(src, args);
  process.exit(rc | 0);
}

// mypy is the one checker that cannot go through plain runpy. black does, and
// so does everything else that is simply a module with a __main__ — but mypy
// finishes by calling os._exit() to skip interpreter teardown, and under
// Emscripten that tears down the whole Pyodide runtime. The diagnostics land and
// then the process dies as a crash instead of carrying an exit code, so
// "mypy foo.py && echo clean" would print clean after a failed check.
//
// mypy.api.run() is upstream's own entrypoint for embedding: it calls main()
// with clean_exit=True, which is precisely the flag that skips the os._exit
// path, and hands back (stdout, stderr, status). The cost is that output is
// buffered to the end of the run rather than streamed, which for a checker that
// prints its findings at the end anyway is not a difference a user can see.
//
// Args are forwarded verbatim, including none at all: mypy with no target has
// its own usage error, and inventing a default here would be a command that
// behaved differently from the one being imitated.
async function doMypy(rest) {
  const src = [
    'import sys',
    'from mypy import api',
    'out, errs, code = api.run(' + JSON.stringify(rest) + ')',
    'sys.stdout.write(out)',
    'sys.stderr.write(errs)',
    'sys.exit(code)',
  ].join(NL);
  const py = getPy();
  const rc = await py.runCode(src, rest);
  process.exit(rc | 0);
}

// Stdlib modules whose __main__ is a network client or server. These are not
// refused because they are unimplemented — they import fine, and that is the
// problem. Pyodide's socket layer accepts connect(), bind() and listen() and
// then moves no bytes, so each of these would print its banner and hang rather
// than fail. An honest refusal names the reason; per the shim-honesty rule a
// silent nothing is the one outcome not allowed.
const SOCKET_MODULES = {
  smtplib: 'this is an SMTP client, and sending mail needs a TCP socket.',
  ftplib: 'this is an FTP client, and it needs a TCP socket.',
  poplib: 'this is a POP3 client, and it needs a TCP socket.',
  imaplib: 'this is an IMAP client, and it needs a TCP socket.',
  socketserver: 'this serves a TCP socket, and there is nothing to accept a connection from.',
  'wsgiref.simple_server': 'this binds a TCP socket. Use "python -m flask run" or "python -m uvicorn", which serve through the Vivari preview bridge.',
  'xmlrpc.server': 'this binds a TCP socket.',
};

// The same socket problem, arriving by a route SOCKET_MODULES cannot see:
// runserver is a management command on a script path, not a -m module. It gets
// its own arm because Vivari ships a Django template, which makes this both the
// first command a Django user reaches for and the worst-behaved one here.
// Pyodide accepts bind() and listen(), and select() then never reports the
// socket readable, so runserver prints its startup banner and answers nothing,
// for as long as it is left running. The template already serves the same app
// through the preview bridge, so there is a real command to point at.
//
// --help is let through on purpose: it binds nothing, and Django printing its
// own help is more useful than a refusal standing in front of it.
function refuseRunserver(file, rest) {
  const base = String(file).split('/').pop();
  if (base !== 'manage.py') return false;
  if (rest.indexOf('runserver') === -1) return false;
  if (rest.indexOf('--help') !== -1 || rest.indexOf('-h') !== -1) return false;
  err('manage.py runserver: the Django development server binds a TCP socket, and there is none in the browser.');
  err('Pyodide accepts bind() and listen() and then never reports a connection, so this would print "Starting development server at http://127.0.0.1:8000/" and never answer.');
  err('Serve the same app through the Vivari preview bridge instead:');
  err('  gunicorn wsgi:application --bind 0.0.0.0:8000');
  return true;
}

// python -m http.server [-b ADDR] [-d DIR] [-p VERSION] [--cgi] [port]
// The flag set is CPython's own (see its argparse), so a command copied out of
// a tutorial parses the same way here. --cgi is refused rather than ignored:
// it means "run these files as programs", and we have no subprocess to run them
// in, so honouring the flag silently would serve the source of a script that
// was meant to execute.
async function doHttpServer(rest) {
  let port = 8000;
  let directory = null;
  let protocol = 'HTTP/1.0';
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-h' || a === '--help') {
      out('usage: python -m http.server [-h] [-b ADDRESS] [-d DIRECTORY] [-p VERSION] [port]');
      out('');
      out('positional arguments:');
      out('  port                  bind to this port (default: 8000)');
      out('');
      out('options:');
      out('  -h, --help            show this help message and exit');
      out('  -b, --bind ADDRESS    accepted and ignored: every port is bound inside the VM');
      out('  -d, --directory DIR   serve this directory (default: current directory)');
      out('  -p, --protocol VER    conform to this HTTP version (default: HTTP/1.0)');
      process.exit(0); return;
    }
    if (a === '--cgi') {
      err('python -m http.server: --cgi is not supported: running a CGI script needs a subprocess, and there is none in the browser.');
      process.exit(1); return;
    }
    if (a === '-b' || a === '--bind') { warnIgnored('http.server', a, 'the port is bound inside the VM and reached through the preview'); i++; continue; }
    if (a.indexOf('--bind=') === 0) { warnIgnored('http.server', '--bind', 'the port is bound inside the VM and reached through the preview'); continue; }
    if (a === '-d' || a === '--directory') { directory = rest[++i]; continue; }
    if (a.indexOf('--directory=') === 0) { directory = a.slice(12); continue; }
    if (a === '-p' || a === '--protocol') { protocol = rest[++i]; continue; }
    if (a.indexOf('--protocol=') === 0) { protocol = a.slice(11); continue; }
    if (a.indexOf('--tls') === 0) {
      err('python -m http.server: ' + a + ' is not supported: the ssl module is a stub in Pyodide, so there is no TLS to configure.');
      process.exit(1); return;
    }
    if (a.charAt(0) === '-' && a !== '-') { err('python -m http.server: unrecognized argument: ' + a); process.exit(2); return; }
    const n = parseInt(a, 10);
    if (!(n > 0)) { err('python -m http.server: invalid port: ' + a); process.exit(2); return; }
    port = n;
  }
  const py = getPy();
  await py.serveStatic({ port: port, directory: directory, cwd: process.cwd(), protocol: protocol });
  process.exit(0);
}

// Everything else: CPython's own runpy, so module resolution and the error for
// a module that is not there are the stdlib's rather than ours.
async function doModule(mod, rest) {
  const py = getPy();
  const rc = await py.runModule(mod, rest, process.cwd());
  process.exit(rc | 0);
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
    if (!mod) { err('Argument expected for the -m option'); process.exit(2); return; }
    // The modules the shim has to intercept, each because it needs something a
    // plain runpy passthrough cannot reach: the package store (pip, venv), the
    // WSGI/ASGI bridge (uvicorn, flask, gunicorn), the exit-code seam (pytest),
    // or a socket we do not have (http.server). Everything else is an ordinary
    // module the interpreter can already import, and goes through runpy.
    if (mod === 'pip') { return doPip(rest); }
    if (mod === 'venv') { return doVenv(rest); }
    if (mod === 'uvicorn') { return doUvicorn(rest); }
    if (mod === 'flask') { return doFlask(rest); }
    if (mod === 'gunicorn') { return doGunicorn(rest); }
    if (mod === 'pytest') { return doPytest(rest); }
    if (mod === 'mypy') { return doMypy(rest); }
    if (mod === 'http.server') { return doHttpServer(rest); }
    if (SOCKET_MODULES[mod]) {
      err('python -m ' + mod + ': ' + SOCKET_MODULES[mod]);
      err('There is no TCP socket in the browser. the Pyodide socket connects and binds without error and then carries no bytes, so this would look like it was working and never answer.');
      process.exit(1);
      return;
    }
    return doModule(mod, rest);
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
  if (refuseRunserver(file, argv.slice(i + 1))) { process.exit(1); return; }
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