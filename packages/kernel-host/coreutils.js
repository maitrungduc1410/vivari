// Built-in programs, written as ordinary CommonJS Node programs that run inside a
// process worker via the runtime. The kernel installs each as `/bin/<name>.js`,
// so from a program's point of view they are just files on PATH. Everything —
// even the shell — is "just a Node process", exactly like StackBlitz's per-PID
// Node workers.

import { NODE_GYP_STUB } from "./node-gyp-stub.js";
import { BUN_PROGRAM, BUNX_PROGRAM } from "./programs/bun.js";
import { PYTHON_PROGRAM } from "./programs/python.js";

export const COREUTILS = {
  // bun / bunx — the Bun runtime + package-manager analog. Unlike npm/yarn/pnpm
  // (real vendored JS CLIs), Bun is a native binary with no pure-JS build, so this
  // is a purpose-built shim: it runs TS/JS files with a `Bun` global installed,
  // runs package.json scripts, and DELEGATES `bun install` to the real npm CLI.
  // See packages/kernel-host/programs/bun.js + packages/runtime/builtins/bun.js.
  bun: BUN_PROGRAM,
  bunx: BUNX_PROGRAM,

  // python / python3 — the Python (CPython/WASM via Pyodide) runtime analog.
  // The tiny launcher installs eagerly on PATH; the heavy Pyodide bundle is
  // fetched from the same-origin vendored index ONLY when a `python` process runs
  // (globalThis.__ocInstallPython), so a plain node/bun process pays nothing at
  // boot. See packages/kernel-host/programs/python.js + packages/runtime/builtins/python.js.
  python: PYTHON_PROGRAM,
  python3: PYTHON_PROGRAM,

  // uvicorn / flask — authentic entrypoints for the Python web-server templates.
  // They just delegate to the `python` launcher's `-m uvicorn` / `-m flask`
  // handling (which boots Pyodide and bridges the WSGI/ASGI app to a guest http
  // server so the preview opens). See packages/kernel-host/programs/python.js.
  uvicorn: `
'use strict';
const cp = require('child_process');
const child = cp.spawn('python', ['-m', 'uvicorn'].concat(process.argv.slice(2)), { cwd: process.cwd(), env: process.env });
if (child.stdout) child.stdout.on('data', (d) => process.stdout.write(d));
if (child.stderr) child.stderr.on('data', (d) => process.stderr.write(d));
child.on('exit', (code) => process.exit(code | 0));
child.on('error', (e) => { process.stderr.write('uvicorn: ' + ((e && e.message) || e) + String.fromCharCode(10)); process.exit(1); });
`,
  flask: `
'use strict';
const cp = require('child_process');
const child = cp.spawn('python', ['-m', 'flask'].concat(process.argv.slice(2)), { cwd: process.cwd(), env: process.env });
if (child.stdout) child.stdout.on('data', (d) => process.stdout.write(d));
if (child.stderr) child.stderr.on('data', (d) => process.stderr.write(d));
child.on('exit', (code) => process.exit(code | 0));
child.on('error', (e) => { process.stderr.write('flask: ' + ((e && e.message) || e) + String.fromCharCode(10)); process.exit(1); });
`,

  // NOTE: there is no built-in `npm` here anymore. The Turbo-analog installer
  // (packages/kernel-host/programs/npm.js) has been RETIRED from the shipped
  // product — studio now boots the REAL npm CLI unconditionally (see
  // load-real-npm.js + packages/studio/src/workers/kernel-worker.js). The analog survives ONLY as an
  // offline test fixture: scripts/verify-node.mjs imports NPM_PROGRAM directly
  // and installs it to /bin/npm.js, so its deterministic install/tar/hoist
  // coverage keeps running without network. See roadmap.md ("Retiring the
  // Turbo-analog").

  // node-gyp stub on /bin: native addon builds can't run in-browser, so make
  // them a non-fatal no-op (North Star: real package managers). This is the
  // fallback for any node-gyp that resolves via PATH; real npm's own bundled
  // node-gyp shim is separately overwritten by stubNodeGyp() when it is loaded
  // into the VFS. See node-gyp-stub.js.
  "node-gyp": NODE_GYP_STUB,

  // npx: run a package's bin from node_modules/.bin (installing it first if it is
  // not already on PATH). Not installer logic, so it survives the switch to the
  // real npm/npx (North Star). Assumes the bin name matches the package name.
  npx: `
const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const argv = process.argv.slice(2).filter((a) => a !== '-y' && a !== '--yes');
if (!argv.length) { process.stderr.write('usage: npx <command> [args]\\n'); process.exit(1); }
const name = argv[0];
const rest = argv.slice(1);
const cwd = process.cwd();
function binPath(dir) {
  const dirs = [];
  let cur = dir;
  for (;;) { dirs.push(cur + '/node_modules/.bin'); const p = path.dirname(cur); if (p === cur) break; cur = p; }
  if (process.env.PATH) dirs.push(process.env.PATH);
  dirs.push('/bin');
  return dirs.join(':');
}
const PATH = binPath(cwd);
const env = Object.assign({}, process.env, { PATH });
function onPath(bin) {
  for (const d of PATH.split(':')) {
    try { if (fs.existsSync(d + '/' + bin) || fs.existsSync(d + '/' + bin + '.js')) return true; } catch (e) {}
  }
  return false;
}
if (!onPath(name)) {
  process.stdout.write('npx: ' + name + ' not found locally, installing…\\n');
  const inst = cp.spawnSync('npm', ['install', name], { cwd, env, encoding: 'utf8' });
  if (inst.stdout) process.stdout.write(inst.stdout);
  if (inst.stderr) process.stderr.write(inst.stderr);
  if (inst.status) process.exit(inst.status);
}
// Run the local bin async (#15) so its output streams and a long-running tool
// (e.g. a dev server) doesn't freeze npx. Resolved via node_modules/.bin on PATH.
const child = cp.spawn(name, rest, { cwd, env });
child.stdout.on('data', (d) => process.stdout.write(d));
child.stderr.on('data', (d) => process.stderr.write(d));
child.on('error', (e) => { process.stderr.write('npx: ' + ((e && e.message) || e) + '\\n'); process.exit(127); });
child.on('close', (code) => process.exit(code | 0));
`,

  echo: `process.stdout.write(process.argv.slice(2).join(' ') + '\\n');\nprocess.exit(0);\n`,

  // Reset the terminal: home the cursor (\\x1b[H), erase the screen (\\x1b[2J),
  // and erase the scrollback (\\x1b[3J). xterm interprets the sequence, so the
  // visible output and history are wiped and the next prompt starts at the top.
  clear: `process.stdout.write('\\x1b[H\\x1b[2J\\x1b[3J');\nprocess.exit(0);\n`,

  pwd: `process.stdout.write(process.cwd() + '\\n');\nprocess.exit(0);\n`,

  true: `process.exit(0);\n`,

  false: `process.exit(1);\n`,

  cat: `
const fs = require('fs');
const path = require('path');
const files = process.argv.slice(2);
let rc = 0;
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
async function main() {
  // No file operands (or '-') => copy stdin to stdout, the standard cat behaviour
  // a pipeline like \`echo hi | cat\` depends on.
  if (!files.length) {
    process.stdout.write(await readStdin());
  } else {
    for (const a of files) {
      if (a === '-') { process.stdout.write(await readStdin()); continue; }
      try {
        process.stdout.write(fs.readFileSync(path.resolve(process.cwd(), a)));
      } catch (e) {
        process.stderr.write('cat: ' + a + ': ' + (e.code || e.message) + '\\n');
        rc = 1;
      }
    }
  }
  process.exit(rc);
}
main();
`,

  ls: `
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
// Directories are printed bold-blue (GNU ls' di=01;34) so folders stand out.
// GNU-style --color mode: 'auto' (default) colors ONLY when an interactive
// terminal is attached (VV_TTY, set by the interactive shell) — so captured /
// piped / scripted output (\`sh -c\`, CI) stays plain. --color[=always] forces
// color; --color=never or a non-empty NO_COLOR disables it.
const colorArg = argv.find((a) => a === '--color' || a.startsWith('--color='));
const mode = colorArg == null ? 'auto' : (colorArg === '--color' ? 'always' : colorArg.slice(8));
const noColorEnv = process.env.NO_COLOR != null && process.env.NO_COLOR !== '';
const useColor = mode === 'never' ? false : mode === 'always' ? true : (!noColorEnv && process.env.VV_TTY === '1');
const args = argv.filter((a) => !a.startsWith('-'));
const target = args[0] ? path.resolve(process.cwd(), args[0]) : process.cwd();
try {
  const names = fs.readdirSync(target);
  if (names.length) {
    const out = names.map((name) => {
      if (!useColor) return name;
      let isDir = false;
      try { isDir = fs.statSync(path.join(target, name)).isDirectory(); } catch (e) {}
      return isDir ? '\\x1b[1;34m' + name + '\\x1b[0m' : name;
    });
    process.stdout.write(out.join('\\n') + '\\n');
  }
} catch (e) {
  process.stderr.write('ls: ' + (args[0] || '.') + ': ' + (e.code || e.message) + '\\n');
  process.exit(1);
}
process.exit(0);
`,

  mkdir: `
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const recursive = argv.includes('-p');
let rc = 0;
for (const d of argv.filter((a) => !a.startsWith('-'))) {
  try {
    fs.mkdirSync(path.resolve(process.cwd(), d), { recursive });
  } catch (e) {
    process.stderr.write('mkdir: ' + d + ': ' + (e.code || e.message) + '\\n');
    rc = 1;
  }
}
process.exit(rc);
`,

  rm: `
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith('-')).join('');
const recursive = flags.includes('r');
const force = flags.includes('f');
let rc = 0;
for (const f of argv.filter((a) => !a.startsWith('-'))) {
  try {
    fs.rmSync(path.resolve(process.cwd(), f), { recursive, force });
  } catch (e) {
    if (!force) {
      process.stderr.write('rm: ' + f + ': ' + (e.code || e.message) + '\\n');
      rc = 1;
    }
  }
}
process.exit(rc);
`,

  node: `
const path = require('path');
// argv is ['node', '/bin/node.js', ...cliArgs]; drop the launcher path so the
// loaded script sees Node semantics (argv[1] = its own path).
process.argv.splice(1, 1);
const cli = process.argv.slice(1); // node's own args: flags, then script, then its args

// Node CLI flags that consume the FOLLOWING token as a value (space form). Real
// tools spawn 'node' with flags (Nest: --enable-source-maps; others: -r, etc.),
// so we must skip flags to find the real entry instead of treating the first
// flag as the script (which required('/cwd/--enable-source-maps') -> not found).
const VALUE_FLAGS = new Set([
  '--loader', '--experimental-loader', '--conditions', '-C',
  '--title', '--cpu-prof-dir', '--heap-prof-dir', '--diagnostic-dir',
  '--redirect-warnings', '--disable-proto', '--report-dir', '--report-filename',
]);

// \`--env-file[=path]\` / \`--env-file-if-exists\`: load KEY=VALUE lines into
// process.env. A minimal .env parser (blank/#-comment lines skipped, optional
// leading \`export \`, surrounding single/double quotes stripped). Like Node and
// dotenv, an already-defined variable is NOT overridden. Missing file: throw for
// --env-file, silently skip for --env-file-if-exists.
function loadEnvFile(file, optional) {
  const abs = file[0] === '/' ? file : path.resolve(process.cwd(), file);
  let txt;
  try { txt = require('fs').readFileSync(abs, 'utf8'); }
  catch (e) {
    if (optional) return;
    process.stderr.write('node: --env-file ' + file + ': ' + ((e && e.code) || (e && e.message) || e) + '\\n');
    process.exit(9);
  }
  for (let line of txt.split(/\\r?\\n/)) {
    line = line.trim();
    if (!line || line[0] === '#') continue;
    if (line.slice(0, 7) === 'export ') line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && ((val[0] === '"' && val[val.length - 1] === '"') || (val[0] === "'" && val[val.length - 1] === "'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

const preload = [];
let evalCode = null, printResult = false, entry = null, i = 0;
for (; i < cli.length; i++) {
  const a = cli[i];
  if (a === '--') { i++; break; }
  // \`node -v\`/\`--version\` prints the runtime version and exits (some tooling,
  // and users, probe it). Answer with the spoofed process.version.
  if (a === '-v' || a === '--version') { process.stdout.write(process.version + '\\n'); process.exit(0); }
  if (a === '-e' || a === '--eval') { evalCode = cli[++i] || ''; continue; }
  if (a === '-p' || a === '--print') { evalCode = cli[++i] || ''; printResult = true; continue; }
  if (a[0] === '-') {
    const eq = a.indexOf('=');
    const name = eq >= 0 ? a.slice(0, eq) : a;
    if (name === '-r' || name === '--require' || name === '--import') {
      const val = eq >= 0 ? a.slice(eq + 1) : cli[++i];
      if (val) preload.push(val);
      continue;
    }
    if (name === '--env-file' || name === '--env-file-if-exists') {
      const val = eq >= 0 ? a.slice(eq + 1) : cli[++i];
      if (val) loadEnvFile(val, name === '--env-file-if-exists');
      continue;
    }
    if (eq < 0 && VALUE_FLAGS.has(name)) i++; // consume the value token
    continue; // boolean flag (e.g. --enable-source-maps) — ignore
  }
  entry = a; break; // first non-flag token is the script
}
const rest = cli.slice(i + 1); // script's own args

const req = (m) => require(m[0] === '.' || m[0] === '/' ? path.resolve(process.cwd(), m) : m);
if (typeof require.resolve === 'function') {
  req.resolve = (m) => require.resolve(m[0] === '.' || m[0] === '/' ? path.resolve(process.cwd(), m) : m);
}
for (const m of preload) {
  try { req(m); } catch (e) { process.stderr.write('node: failed to preload ' + m + ': ' + ((e && e.message) || e) + '\\n'); }
}

if (evalCode != null) {
  process.argv = ['node', ...rest];
  // Real \`node -e\`/\`-p\` runs the code in a CommonJS module scope: require, module,
  // exports, __filename ('[eval]'), __dirname (cwd) are all in scope, and require
  // resolves relative to cwd. Indirect eval ran it in the GLOBAL scope where none
  // of these exist ('require is not defined' — the exact failure npm lifecycle
  // scripts hit, since they're literally \`node -e "require('fs')..."\`). Build the
  // Node module wrapper explicitly and pass a cwd-aware require (\`req\`).
  const mod = { exports: {}, id: '[eval]', filename: '[eval]', loaded: false, paths: [] };
  const dir = process.cwd();
  const body = printResult ? 'return (' + evalCode + '\\n);' : evalCode;
  const fn = new Function('require', 'module', 'exports', '__filename', '__dirname', body);
  const r = fn(req, mod, mod.exports, '[eval]', dir);
  if (printResult) process.stdout.write(require('util').inspect(r) + '\\n');
} else {
  if (!entry) { process.stderr.write('node: missing script\\n'); process.exit(1); }
  const abs = path.resolve(process.cwd(), entry);
  process.argv = ['node', abs, ...rest]; // script sees argv[1] = its own path
  require(abs);
}
`,

  // A minimal POSIX-ish shell: sequencing (;), and/or (&& ||), comments (#),
  // pipes (|), redirects (< > >> 2> 2>> 2>&1), builtins (cd, pwd, export, :,
  // true, false), a leading NAME=value assignment prefix (\`PORT=3000 node app.js\`;
  // with no command it mutates the shell's own env), and everything else spawned
  // as a child process inheriting cwd/env. Quotes ("' ) are stripped by the lexer.
  // Not supported: $VAR expansion, globs, background (&), subshells.
  sh: `
const fs = require('fs');
const cp = require('child_process');
const path = require('path');

const argv = process.argv;
let script = '';
if (argv[2] === '-c') script = argv[3] || '';
else if (argv[2]) script = fs.readFileSync(argv[2], 'utf8');

// Quote-aware lexer: emits word tokens (quotes stripped) and operator tokens for
// sequencing (; && ||), pipes (|) and redirects (< > >> 2> 2>> 2>&1 1> 1>> 1>&2).
// fd-prefixed redirects (2>, 1>) are only recognized when the digit sits directly
// before '>' with no space (\`echo 2>f\` redirects fd2; \`echo 2 >f\` passes "2").
function lex(s) {
  const toks = [];
  let cur = '', q = null, has = false;
  const flush = () => { if (has) { toks.push({ t: 'word', v: cur }); cur = ''; has = false; } };
  const op = (v) => toks.push({ t: 'op', v: v });
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (/\\s/.test(c)) { flush(); continue; }
    if (c === '>') {
      const fd = (has && (cur === '1' || cur === '2')) ? cur : null;
      if (fd) { cur = ''; has = false; }
      if (fd === '2' && s[i + 1] === '&' && s[i + 2] === '1') { op('2>&1'); i += 2; continue; }
      if (fd === '1' && s[i + 1] === '&' && s[i + 2] === '2') { op('1>&2'); i += 2; continue; }
      if (!fd) flush();
      if (s[i + 1] === '>') { op((fd || '') + '>>'); i += 1; continue; }
      op((fd || '') + '>'); continue;
    }
    if (c === '<') { flush(); op('<'); continue; }
    if (c === '|') { flush(); if (s[i + 1] === '|') { op('||'); i += 1; } else op('|'); continue; }
    if (c === '&' && s[i + 1] === '&') { flush(); op('&&'); i += 1; continue; }
    if (c === ';') { flush(); op(';'); continue; }
    cur += c; has = true;
  }
  flush();
  return toks;
}

// Parse a token stream into command-list elements. Each element is a pipeline
// (stages separated by |) plus the operator that precedes it (; && ||). Each
// stage is { argv, redirs:[{type,file?}] }.
function parse(toks) {
  const els = [];
  let opBefore = ';';
  let stages = [];
  let stage = { argv: [], redirs: [] };
  const endStage = () => { stages.push(stage); stage = { argv: [], redirs: [] }; };
  const endPipe = () => { endStage(); els.push({ op: opBefore, stages: stages }); stages = []; };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === 'word') { stage.argv.push(t.v); continue; }
    const v = t.v;
    if (v === '|') { endStage(); continue; }
    if (v === ';' || v === '&&' || v === '||') { endPipe(); opBefore = v; continue; }
    if (v === '2>&1' || v === '1>&2') { stage.redirs.push({ type: v }); continue; }
    const tgt = toks[i + 1];
    if (tgt && tgt.t === 'word') { stage.redirs.push({ type: v, file: tgt.v }); i += 1; }
    else stage.redirs.push({ type: v, file: null });
  }
  endPipe();
  return els;
}

// External commands run ASYNC and stream their output live: a long-running server
// (e.g. \`node dist/main.js\`, spawned by \`nest start\` as \`sh -c 'node ...'\`) never
// exits, so spawnSync would block forever AND buffer all logs until exit — the
// Nest/Vite banner would never appear. Async spawn forwards each chunk as it lands.
// The foreground job of an interactive shell. \`currentChild\` is where the REPL's
// raw stdin is piped (so \`cat\`, a \`node\` REPL, the FIRST stage of a pipeline, etc.
// get keystrokes) instead of being line-edited by the shell itself. \`currentKill\`
// signals the WHOLE foreground job — for a pipeline that's every stage, so Ctrl+C
// tears the entire \`a | b | c\` down, not just the last stage.
let currentChild = null;
let currentKill = null;

// Interactive command history, shared between the line editor (up/down recall)
// and the \`history\` builtin below. Populated by the REPL in interactive mode;
// empty in batch mode (\`sh -c\`).
const commandHistory = [];

// A POSIX assignment prefix: leading NAME=value tokens (NAME a shell identifier)
// set env for the command that follows; with no command they mutate the shell's
// own env, like a plain \`FOO=bar\`. Returns { assign, rest } where rest is the
// command + args with the prefix stripped.
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
function peelAssignments(tokens) {
  let i = 0;
  const assign = {};
  while (i < tokens.length && ASSIGN.test(tokens[i])) {
    const eq = tokens[i].indexOf('=');
    assign[tokens[i].slice(0, eq)] = tokens[i].slice(eq + 1);
    i++;
  }
  return { assign, rest: tokens.slice(i) };
}

// Merge an assignment overlay onto the shell env for a spawned child. When there
// are no assignments we pass process.env by reference (unchanged behavior).
function envWith(assign) {
  return Object.keys(assign).length ? Object.assign({}, process.env, assign) : process.env;
}

function runSimple(tokens) {
  if (!tokens.length) return Promise.resolve(0);
  const { assign, rest } = peelAssignments(tokens);
  // Bare \`NAME=value ...\` with no command: set the shell's own env (POSIX).
  if (!rest.length) {
    for (const k in assign) process.env[k] = assign[k];
    return Promise.resolve(0);
  }
  const cmd = rest[0];
  const args = rest.slice(1);
  if (cmd === 'cd') {
    try { process.chdir(args[0] || '/'); return Promise.resolve(0); }
    catch (e) { process.stderr.write('cd: ' + (e.code || e.message) + '\\n'); return Promise.resolve(1); }
  }
  if (cmd === 'pwd') { process.stdout.write(process.cwd() + '\\n'); return Promise.resolve(0); }
  if (cmd === 'export') {
    for (const a of args) { const i = a.indexOf('='); if (i > 0) process.env[a.slice(0, i)] = a.slice(i + 1); }
    return Promise.resolve(0);
  }
  if (cmd === ':' || cmd === 'true') return Promise.resolve(0);
  if (cmd === 'false') return Promise.resolve(1);
  // \`history\` lists the interactive command history (bash-style, 1-indexed).
  // Like cd/pwd it is a builtin, so it only works standalone — inside a pipeline
  // it would be looked up on PATH (/bin/history.js, which doesn't exist).
  if (cmd === 'history') {
    const lines = commandHistory.map((h, i) => String(i + 1).padStart(4) + '  ' + h);
    if (lines.length) process.stdout.write(lines.join('\\n') + '\\n');
    return Promise.resolve(0);
  }
  return new Promise((resolve) => {
    const child = cp.spawn(cmd, args, { cwd: process.cwd(), env: envWith(assign) });
    currentChild = child;
    currentKill = (sig) => { try { child.kill(sig); } catch (e) {} };
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('error', (e) => {
      currentChild = null; currentKill = null;
      process.stderr.write('sh: ' + (e && e.code === 'ENOENT' ? cmd + ': not found' : ((e && e.message) || e)) + '\\n');
      resolve(127);
    });
    child.on('close', (code) => { currentChild = null; currentKill = null; resolve(code == null ? 0 : code); });
  });
}

function resolvePath(f) { return path.isAbsolute(f) ? f : path.resolve(process.cwd(), f); }

// /dev/null is a discard sink: the VFS has no device nodes, so instead of opening
// a real fd (which would fail) we drop writes and read it as immediate EOF. This
// makes the ubiquitous \`cmd > /dev/null 2>&1\` / \`cmd 2>/dev/null\` / \`< /dev/null\`
// patterns work.
function isDevNull(f) { return resolvePath(f) === '/dev/null'; }

// Execute a pipeline of >=1 stages: wire each stage's stdout into the next
// stage's stdin, apply per-stage redirects, and resolve with the LAST stage's
// exit code (sh semantics; no pipefail). Builtins are NOT special-cased here —
// every stage is spawned (bash runs pipeline/redirected builtins in a subshell).
function runPipeline(stages) {
  return new Promise((resolveAll) => {
    const specs = stages.map((s) => {
      const sp = { argv: s.argv.slice(), stdinFile: null, outFile: null, outAppend: false, errFile: null, errAppend: false, errToOut: false };
      for (const r of s.redirs) {
        if (r.type === '<') sp.stdinFile = r.file;
        else if (r.type === '>' || r.type === '1>') { sp.outFile = r.file; sp.outAppend = false; }
        else if (r.type === '>>' || r.type === '1>>') { sp.outFile = r.file; sp.outAppend = true; }
        else if (r.type === '2>') { sp.errFile = r.file; sp.errAppend = false; }
        else if (r.type === '2>>') { sp.errFile = r.file; sp.errAppend = true; }
        else if (r.type === '2>&1') sp.errToOut = true;
      }
      return sp;
    });
    const n = specs.length;
    // A stage with no command (e.g. \`> file\`, or a bare \`FOO=bar\`) is not spawned;
    // its redirects still apply (opening \`>\` truncates the target), then it
    // completes with status 0. A leading NAME=value prefix scopes env to the stage.
    const children = specs.map((sp) => {
      if (!sp.argv.length) return null;
      const { assign, rest } = peelAssignments(sp.argv);
      if (!rest.length) return null;
      return cp.spawn(rest[0], rest.slice(1), { cwd: process.cwd(), env: envWith(assign) });
    });
    // Interactive stdin goes to the FIRST stage (it reads the terminal); Ctrl+C
    // signals EVERY stage so the whole pipeline dies, not just one.
    currentChild = children[0];
    currentKill = (sig) => { for (const c of children) { if (c) { try { c.kill(sig); } catch (e) {} } } };
    const fds = [];
    const done = new Set();
    let lastCode = 0, remaining = n;
    const finish = (idx, code) => {
      if (done.has(idx)) return;
      done.add(idx);
      if (idx === n - 1) lastCode = code == null ? 0 : code;
      if (--remaining === 0) {
        for (const fd of fds) { try { fs.closeSync(fd); } catch (e) {} }
        currentChild = null; currentKill = null;
        resolveAll(lastCode);
      }
    };
    for (let idx = 0; idx < n; idx++) {
      const sp = specs[idx], child = children[idx], isLast = idx === n - 1, next = children[idx + 1];
      let outFd = null, errFd = null;
      const outNull = sp.outFile != null && isDevNull(sp.outFile);
      const errNull = sp.errFile != null && isDevNull(sp.errFile);
      if (sp.outFile && !outNull) { try { outFd = fs.openSync(resolvePath(sp.outFile), sp.outAppend ? 'a' : 'w'); fds.push(outFd); } catch (e) { process.stderr.write('sh: ' + sp.outFile + ': ' + (e.code || e.message) + '\\n'); } }
      if (sp.errFile && !errNull) { try { errFd = fs.openSync(resolvePath(sp.errFile), sp.errAppend ? 'a' : 'w'); fds.push(errFd); } catch (e) { process.stderr.write('sh: ' + sp.errFile + ': ' + (e.code || e.message) + '\\n'); } }
      if (!child) { if (!isLast && next) { try { next.stdin.end(); } catch (_) {} } finish(idx, 0); continue; }
      const writeOut = (buf) => {
        if (outNull) return;
        if (outFd != null) { try { fs.writeSync(outFd, buf); } catch (e) {} }
        else if (!isLast && next) { try { next.stdin.write(buf); } catch (e) {} }
        else process.stdout.write(buf);
      };
      const writeErr = (buf) => {
        if (errNull) return;
        if (errFd != null) { try { fs.writeSync(errFd, buf); } catch (e) {} }
        else if (sp.errToOut) writeOut(buf);
        else process.stderr.write(buf);
      };
      child.stdout.on('data', writeOut);
      child.stderr.on('data', writeErr);
      child.on('error', (e) => {
        process.stderr.write('sh: ' + (e && e.code === 'ENOENT' ? sp.argv[0] + ': not found' : ((e && e.message) || e)) + '\\n');
        if (!isLast && next) { try { next.stdin.end(); } catch (_) {} }
        finish(idx, 127);
      });
      child.on('close', (code) => {
        if (!isLast && next) { try { next.stdin.end(); } catch (_) {} }
        finish(idx, code);
      });
      if (idx === 0 && sp.stdinFile) {
        if (!isDevNull(sp.stdinFile)) {
          try { child.stdin.write(fs.readFileSync(resolvePath(sp.stdinFile))); }
          catch (e) { process.stderr.write('sh: ' + sp.stdinFile + ': ' + (e.code || e.message) + '\\n'); }
        }
        try { child.stdin.end(); } catch (e) {}
      }
    }
  });
}

async function runLine(line) {
  const toks = lex(line);
  if (!toks.length) return 0;
  let status = 0;
  for (const el of parse(toks)) {
    if (!el.stages.some((s) => s.argv.length || s.redirs.length)) continue;
    const skip = (el.op === '&&' && status !== 0) || (el.op === '||' && status === 0);
    if (skip) continue;
    // Fast path: a single stage with no redirects runs inline (handles builtins).
    if (el.stages.length === 1 && el.stages[0].redirs.length === 0) status = await runSimple(el.stages[0].argv);
    else status = await runPipeline(el.stages);
  }
  return status;
}

// Batch mode: \`sh script\` or \`sh -c "..."\`. Run each line, then exit.
async function runBatch() {
  let status = 0;
  for (const raw of script.split('\\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line) status = await runLine(line);
  }
  process.exit(status);
}

// Interactive mode: \`sh\` with no script. A real REPL over the raw TTY — it echoes
// keystrokes, edits the current line (backspace), runs on Enter, and forwards raw
// input to a foreground child while one is running. cwd/env persist across
// commands (one long-lived process), just like a local shell.
function runInteractive() {
  // Prompt shows the current folder name (basename of cwd) so you always know
  // where you are, e.g. \`asd$ \`. Root shows \`/\`. Recomputed each print so it
  // tracks \`cd\`.
  const cwdName = () => {
    const parts = process.cwd().split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '/';
  };
  const promptStr = () => '\\x1b[36m' + cwdName() + '$\\x1b[0m ';

  let line = '';   // current input buffer
  let pos = 0;     // cursor position within \`line\`
  const history = commandHistory; // shared with the \`history\` builtin
  let histIdx = 0; // == history.length means "editing a fresh line"
  let busy = false;
  const queue = [];

  const prompt = () => process.stdout.write(promptStr());
  // Redraw the current line in place (col 0 → clear → prompt+line) and put the
  // cursor back at \`pos\`. Used for edits that aren't a plain append-at-end.
  const redraw = () => {
    process.stdout.write('\\r\\x1b[K' + promptStr() + line);
    const back = line.length - pos;
    if (back > 0) process.stdout.write('\\x1b[' + back + 'D');
  };
  const setLine = (s) => { line = s; pos = s.length; redraw(); };

  // ---- Tab completion -------------------------------------------------------
  const BUILTINS = ['cd', 'pwd', 'export', 'history'];
  // Scripting no-ops: still handled by runSimple / installed on /bin (used in
  // shell scripts and \`&&\`||\` chains), but hidden from Tab suggestions since
  // nobody completes them interactively and they only clutter the list.
  const HIDDEN_COMMANDS = new Set([':', 'true', 'false']);
  // Command names for the first token: builtins + every entry on PATH, with a
  // trailing '.js' stripped (coreutils live on disk as /bin/<name>.js).
  const listCommands = () => {
    const set = new Set(BUILTINS);
    for (const d of (process.env.PATH || '/bin').split(':').filter(Boolean)) {
      let names;
      try { names = fs.readdirSync(d); } catch (e) { continue; }
      for (const n of names) set.add(n.endsWith('.js') ? n.slice(0, -3) : n);
    }
    return Array.from(set).filter((c) => !HIDDEN_COMMANDS.has(c));
  };
  // Filesystem candidates for an argument token. \`frag\` may carry a directory
  // part (e.g. "src/comp"); we readdir the directory and match the basename.
  // Directories come back with a trailing '/'. \`base\` is the dir part of frag,
  // kept verbatim when the caller rebuilds the token.
  const listPaths = (frag) => {
    const slash = frag.lastIndexOf('/');
    const base = slash >= 0 ? frag.slice(0, slash + 1) : '';
    const namePart = slash >= 0 ? frag.slice(slash + 1) : frag;
    const dirAbs = base ? (path.isAbsolute(base) ? base : path.resolve(process.cwd(), base)) : process.cwd();
    let names;
    try { names = fs.readdirSync(dirAbs); } catch (e) { return { base: base, namePart: namePart, matches: [] }; }
    const matches = [];
    for (const n of names) {
      if (!n.startsWith(namePart)) continue;
      let isDir = false;
      try { isDir = fs.statSync(path.join(dirAbs, n)).isDirectory(); } catch (e) {}
      matches.push(isDir ? n + '/' : n);
    }
    return { base: base, namePart: namePart, matches: matches };
  };
  const commonPrefix = (arr) => {
    if (!arr.length) return '';
    let p = arr[0];
    for (let k = 1; k < arr.length; k++) {
      const s = arr[k]; let j = 0;
      while (j < p.length && j < s.length && p[j] === s[j]) j++;
      p = p.slice(0, j);
      if (!p) break;
    }
    return p;
  };
  // Complete the whitespace-delimited token ending at the cursor. First token →
  // command; later tokens → filesystem path. Unique match: insert it (+ a space,
  // unless it's a directory ending in '/'). Several: fill the longest common
  // prefix; if that adds nothing, print the candidate list and redraw.
  const complete = () => {
    const left = line.slice(0, pos);
    const lastSpace = left.lastIndexOf(' ');
    const frag = left.slice(lastSpace + 1);
    const isCommand = left.slice(0, lastSpace + 1).trim() === '';
    let candidates, typed;
    if (isCommand) {
      candidates = listCommands().filter((c) => c.startsWith(frag)).sort();
      typed = frag;
    } else {
      const r = listPaths(frag);
      candidates = r.matches.slice().sort();
      typed = r.namePart;
    }
    if (!candidates.length) return;
    if (candidates.length === 1) {
      const completed = candidates[0];
      const addSpace = !completed.endsWith('/');
      const insert = completed.slice(typed.length) + (addSpace ? ' ' : '');
      line = line.slice(0, pos) + insert + line.slice(pos); pos += insert.length; redraw();
      return;
    }
    const lcp = commonPrefix(candidates);
    if (lcp.length > typed.length) {
      const insert = lcp.slice(typed.length);
      line = line.slice(0, pos) + insert + line.slice(pos); pos += insert.length; redraw();
      return;
    }
    process.stdout.write('\\n' + candidates.join('  ') + '\\n');
    redraw();
  };

  const drain = async () => {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const l = queue.shift().replace(/#.*$/, '').trim();
      if (l) { try { await runLine(l); } catch (e) { process.stderr.write(String((e && e.message) || e) + '\\n'); } }
    }
    busy = false;
    prompt();
  };

  const submit = () => {
    process.stdout.write('\\n');
    const cmd = line;
    if (cmd.trim() && history[history.length - 1] !== cmd) history.push(cmd);
    histIdx = history.length;
    queue.push(cmd);
    line = ''; pos = 0;
    drain();
  };

  // Mark that an interactive terminal is attached. Child processes inherit this
  // (spawned with env: process.env), so tools like \`ls\` can enable color only in
  // a real terminal. Batch mode (\`sh script\` / \`sh -c\`, used by CI) never sets
  // it, keeping captured/piped output plain.
  process.env.VV_TTY = '1';

  process.stdin.setRawMode && process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('Vivari shell — type commands, Enter to run.\\n');
  prompt();

  // Auto-run a command at startup (VV_RUN), exactly as if the user had typed it.
  // Used by the demo "Run" button so a dev server runs IN this shell tab (its
  // lifecycle == the tab's): echo it after the prompt, then execute. If it is a
  // long-running server the drain stays busy on it (the tab is "held" like a real
  // \`npm run dev\`); Ctrl+C / closing the tab kills it. Control returns to an
  // interactive prompt if/when it exits.
  const auto = process.env.VV_RUN;
  if (auto) { process.stdout.write(auto + '\\n'); queue.push(auto); drain(); }

  process.stdin.on('data', (buf) => {
    const s = typeof buf === 'string' ? buf : buf.toString('utf8');
    // A foreground job owns stdin: Ctrl+C interrupts it (SIGINT to every stage of
    // a pipeline); otherwise pass keystrokes straight through to the first stage
    // (Enter as newline), no line-edit/echo — the program drives the display.
    if (currentChild) {
      if (s.indexOf('\\x03') !== -1) { if (currentKill) currentKill('SIGINT'); else { try { currentChild.kill('SIGINT'); } catch (e) {} } }
      else { try { currentChild.stdin.write(s.replace(/\\r/g, '\\n')); } catch (e) {} }
      return;
    }
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      // CSI sequence: ESC [ <code>. Arrow keys, Home/End, Delete.
      if (ch === '\\x1b' && s[i + 1] === '[') {
        const code = s[i + 2];
        if (code === 'A') { // up → previous history entry
          if (histIdx > 0) { histIdx--; setLine(history[histIdx]); }
          i += 2; continue;
        }
        if (code === 'B') { // down → next history entry (or a fresh empty line)
          if (histIdx < history.length - 1) { histIdx++; setLine(history[histIdx]); }
          else if (histIdx < history.length) { histIdx = history.length; setLine(''); }
          i += 2; continue;
        }
        if (code === 'C') { if (pos < line.length) { pos++; process.stdout.write('\\x1b[C'); } i += 2; continue; } // right
        if (code === 'D') { if (pos > 0) { pos--; process.stdout.write('\\x1b[D'); } i += 2; continue; }          // left
        if (code === 'H') { pos = 0; redraw(); i += 2; continue; }               // Home
        if (code === 'F') { pos = line.length; redraw(); i += 2; continue; }     // End
        if (code === '3' && s[i + 3] === '~') { // Delete (forward)
          if (pos < line.length) { line = line.slice(0, pos) + line.slice(pos + 1); redraw(); }
          i += 3; continue;
        }
        if (code === '1' && s[i + 3] === '~') { pos = 0; redraw(); i += 3; continue; }            // Home
        if (code === '4' && s[i + 3] === '~') { pos = line.length; redraw(); i += 3; continue; }  // End
        i += 2; continue; // unknown CSI: swallow so it isn't echoed as garbage
      }
      if (ch === '\\r' || ch === '\\n') { submit(); }
      else if (ch === '\\x7f' || ch === '\\b') { // backspace: delete before cursor
        if (pos > 0) { line = line.slice(0, pos - 1) + line.slice(pos); pos--; redraw(); }
      } else if (ch === '\\x03') { // Ctrl+C: abort the current line
        process.stdout.write('^C\\n'); line = ''; pos = 0; histIdx = history.length; if (!busy) prompt();
      } else if (ch === '\\x04') { // Ctrl+D on an empty line: exit
        if (!line.length) { process.stdout.write('\\n'); process.exit(0); }
      } else if (ch === '\\x01') { pos = 0; redraw(); }          // Ctrl+A → start of line
      else if (ch === '\\x05') { pos = line.length; redraw(); }  // Ctrl+E → end of line
      else if (ch === '\\t') { complete(); }                     // Tab → autocomplete
      else if (ch >= ' ') { // printable: insert at cursor
        line = line.slice(0, pos) + ch + line.slice(pos); pos++;
        if (pos === line.length) process.stdout.write(ch); else redraw();
      }
    }
  });
}

if (argv[2]) runBatch();
else runInteractive();
`,
};