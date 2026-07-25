// The `bun` program — a CommonJS Node program that runs as an ordinary process
// inside Vivari, installed as /bin/bun.js (see coreutils.js), so from the shell it
// is just `bun` on PATH. It is the CLI half of Bun support; the runtime half (the
// `Bun` global + `bun:*` modules + zero-config TS/JSX) lives in packages/runtime.
//
// Unlike npm/yarn/pnpm — which Vivari runs as their REAL vendored JS CLIs — Bun is
// a native binary with no pure-JS build, so this is a purpose-built analog:
//   bun / bun run <file>     run a TS/JS/TSX file with the Bun global installed
//   bun run <script>         run a package.json script (with pre/post), via sh
//   bun install|add|remove|update|ci   DELEGATE to the real npm CLI, then write a
//                            best-effort text bun.lock (Bun cannot install natively
//                            in-browser; npm's proven installer does the work)
//   bun x / bunx <pkg>       run a package bin (delegates to npx)
//   bun build <entry>        single-file TS/JSX transpile to --outfile/--outdir
//   bun test [files]         run bun:test suites and report
//   bun --version | -v       print the shim's Bun version
//
// Authoring note: like programs/npm.js this source is embedded as a template
// string, so it deliberately uses NO backticks, NO ${...} and NO backslashes.
// Newlines come from String.fromCharCode(10).

export const BUN_PROGRAM = `
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const NL = String.fromCharCode(10);
const BUN_VERSION = (typeof Bun !== 'undefined' && Bun.version) || '1.1.34';
function out(s) { process.stdout.write(s + NL); }
function err(s) { process.stderr.write(s + NL); }

const argv = process.argv.slice(2);
const cwd = process.cwd();

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}
function isFile(p) { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }

function binPath(dir) {
  const dirs = [];
  let cur = dir;
  for (;;) { dirs.push(cur + '/node_modules/.bin'); const p = path.dirname(cur); if (p === cur) break; cur = p; }
  if (process.env.PATH) dirs.push(process.env.PATH);
  dirs.push('/bin');
  return dirs.join(':');
}

// Install the Bun global into this process realm (idempotent). Provided by the
// runtime (packages/runtime/index.js) so a plain \`node\` process never sees Bun.
function installBun() {
  try { if (typeof globalThis.__ocInstallBun === 'function') globalThis.__ocInstallBun(); } catch (e) {}
}

// ---- run a file with the Bun runtime active --------------------------------
function runFile(target, rest) {
  if (!target) { err('bun: no file to run'); process.exit(1); }
  const abs = path.resolve(cwd, target);
  if (!isFile(abs) && !isFile(abs + '.ts') && !isFile(abs + '.tsx') && !isFile(abs + '.js')) {
    err('bun: file not found: ' + target);
    process.exit(1);
  }
  installBun();
  process.argv = ['bun', abs, ...rest];
  // Surface load/parse/runtime errors from the entry directly (a bare throw here
  // would otherwise bubble up through the async main() chain as a silent
  // unhandled rejection and the process would just exit with no output).
  try {
    require(abs);
  } catch (e) {
    err('bun: ' + ((e && e.stack) || e));
    process.exit(1);
  }
}

// ---- run a package.json script (with pre/post), via the shell --------------
function runScriptCmd(command, rest) {
  return new Promise((resolve) => {
    const full = rest && rest.length ? command + ' ' + rest.join(' ') : command;
    const env = Object.assign({}, process.env, { PATH: binPath(cwd) });
    const child = cp.spawn('sh', ['-c', full], { cwd: cwd, env: env });
    if (child.stdout) child.stdout.on('data', (d) => process.stdout.write(d));
    if (child.stderr) child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('error', (e) => { err('bun: ' + ((e && e.message) || e)); resolve(127); });
    child.on('close', (code) => resolve(code | 0));
  });
}

async function doRun(rest) {
  const target = rest[0];
  const restArgs = rest.slice(1);
  if (!target) { err('usage: bun run <script|file>'); process.exit(1); }
  const pkg = readJSON(path.join(cwd, 'package.json'));
  const scripts = (pkg && pkg.scripts) || {};
  if (Object.prototype.hasOwnProperty.call(scripts, target)) {
    let code = 0;
    if (scripts['pre' + target]) code = await runScriptCmd(scripts['pre' + target], []);
    if (code === 0) code = await runScriptCmd(scripts[target], restArgs);
    if (code === 0 && scripts['post' + target]) code = await runScriptCmd(scripts['post' + target], []);
    process.exit(code);
  }
  // Not a script name -> treat as a file.
  runFile(target, restArgs);
}

// ---- install/add/remove/... : delegate to the real npm CLI -----------------
function mapInstallArgs(sub, rest) {
  const pkgs = [];
  const flags = [];
  for (const a of rest) {
    if (a === '-d' || a === '-D' || a === '--dev' || a === '--development' || a === '--save-dev') flags.push('--save-dev');
    else if (a === '-p' || a === '--production') flags.push('--omit=dev');
    else if (a === '-g' || a === '--global') flags.push('-g');
    else if (a === '--optional') flags.push('--save-optional');
    else if (a === '--exact' || a === '-E') flags.push('--save-exact');
    else if (a === '--frozen-lockfile') flags.push('--no-save');
    else if (a[0] === '-') { /* drop unknown bun-only flags */ }
    else pkgs.push(a);
  }
  let npmSub = 'install';
  if (sub === 'add') npmSub = 'install';
  else if (sub === 'remove' || sub === 'rm' || sub === 'uninstall') npmSub = 'uninstall';
  else if (sub === 'update' || sub === 'upgrade') npmSub = 'update';
  else if (sub === 'ci') npmSub = 'ci';
  return { npmSub: npmSub, args: [npmSub, ...pkgs, ...flags] };
}

function doInstall(sub, rest) {
  const mapped = mapInstallArgs(sub, rest);
  const env = Object.assign({}, process.env, { PATH: binPath(cwd) });
  out('bun ' + sub + ' -> npm ' + mapped.args.join(' ') + '  (Vivari delegates Bun installs to the real npm CLI)');
  const child = cp.spawn('npm', [...mapped.args, '--no-audit', '--no-fund'], { cwd: cwd, env: env });
  if (child.stdout) child.stdout.on('data', (d) => process.stdout.write(d));
  if (child.stderr) child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('error', (e) => { err('bun: npm delegation failed: ' + ((e && e.message) || e)); process.exit(127); });
  child.on('close', (code) => {
    if (code === 0) {
      try { writeBunLock(); out('Saved bun.lock'); } catch (e) { err('bun: could not write bun.lock: ' + ((e && e.message) || e)); }
    }
    process.exit(code | 0);
  });
}

// Best-effort TEXT bun.lock (Bun >= 1.1). This is an approximation, not a
// byte-exact Bun lockfile: it records the project's declared deps plus the
// versions npm actually installed at the node_modules top level. Nothing in-VM
// parses it back (installs delegate to npm); it exists so tools + our own
// detection see a Bun-installed project.
function installedVersion(name) {
  const pj = readJSON(path.join(cwd, 'node_modules', name, 'package.json'));
  return pj && pj.version ? pj.version : null;
}
function writeBunLock() {
  const pkg = readJSON(path.join(cwd, 'package.json')) || {};
  const deps = pkg.dependencies || {};
  const dev = pkg.devDependencies || {};
  const packages = {};
  const collect = (obj) => {
    for (const name of Object.keys(obj)) {
      const v = installedVersion(name);
      if (v) packages[name] = [name + '@' + v, {}];
    }
  };
  collect(deps); collect(dev);
  const lock = {
    lockfileVersion: 1,
    workspaces: { '': { name: pkg.name || path.basename(cwd), dependencies: deps, devDependencies: dev } },
    packages: packages,
  };
  const header = '// Generated by the Vivari bun shim (installs delegate to npm). Not a byte-exact Bun lockfile.' + NL;
  fs.writeFileSync(path.join(cwd, 'bun.lock'), header + JSON.stringify(lock, null, 2) + NL);
}

// ---- bun x / bunx : delegate to npx ----------------------------------------
function doExec(rest) {
  const env = Object.assign({}, process.env, { PATH: binPath(cwd) });
  const child = cp.spawn('npx', rest, { cwd: cwd, env: env });
  if (child.stdout) child.stdout.on('data', (d) => process.stdout.write(d));
  if (child.stderr) child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('error', (e) => { err('bunx: ' + ((e && e.message) || e)); process.exit(127); });
  child.on('close', (code) => process.exit(code | 0));
}

// ---- bun build : single-file TS/JSX transpile (no bundling) -----------------
function doBuild(rest) {
  installBun();
  let entry = null, outfile = null, outdir = null;
  for (const a of rest) {
    if (a.indexOf('--outfile=') === 0) outfile = a.slice(10);
    else if (a.indexOf('--outdir=') === 0) outdir = a.slice(9);
    else if (a[0] !== '-') entry = a;
  }
  if (!entry) { err('usage: bun build <entry> --outfile=<file>'); process.exit(1); }
  const abs = path.resolve(cwd, entry);
  const src = fs.readFileSync(abs, 'utf8');
  const t = new Bun.Transpiler({ loader: entry.slice(entry.lastIndexOf('.') + 1) });
  const js = t.transformSync(src);
  const dest = outfile ? path.resolve(cwd, outfile)
    : outdir ? path.resolve(cwd, outdir, path.basename(entry).replace(/[.](ts|tsx|jsx|mts|cts)$/, '.js'))
    : null;
  if (dest) {
    const slash = dest.lastIndexOf('/');
    if (slash > 0) { try { fs.mkdirSync(dest.slice(0, slash), { recursive: true }); } catch (e) {} }
    fs.writeFileSync(dest, js);
    out('bun build: wrote ' + dest + ' (single-file transpile; bundling is not supported by the shim)');
  } else {
    process.stdout.write(js + NL);
  }
  process.exit(0);
}

// ---- bun test : load suites and run ----------------------------------------
function findTestFiles(dir, acc) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name[0] === '.') continue;
    const full = dir + '/' + e.name;
    if (e.isDirectory()) findTestFiles(full, acc);
    else if (/[.](test|spec)[.](ts|tsx|js|jsx|mts|cts)$/.test(e.name)) acc.push(full);
  }
  return acc;
}
async function doTest(rest) {
  installBun();
  const files = rest.filter((a) => a[0] !== '-');
  const targets = files.length ? files.map((f) => path.resolve(cwd, f)) : findTestFiles(cwd, []);
  if (!targets.length) { err('bun test: no test files found'); process.exit(1); }
  const bunTest = require('bun:test');
  for (const f of targets) {
    out('# ' + path.relative(cwd, f));
    try { require(f); } catch (e) { err('  failed to load: ' + ((e && e.stack) || e)); }
  }
  const code = await bunTest.__run();
  process.exit(code | 0);
}

// ---- dispatch --------------------------------------------------------------
const HELP = [
  'Vivari bun (shim) ' + BUN_VERSION,
  '',
  'Usage: bun <command|file> [...args]',
  '',
  '  bun <file.ts>            run a TS/JS/TSX file (Bun global + zero-config TS)',
  '  bun run <script|file>    run a package.json script or a file',
  '  bun install|add|remove   manage dependencies (delegates to npm; writes bun.lock)',
  '  bun x <pkg>              run a package binary (bunx)',
  '  bun build <entry>       transpile a single TS/JSX file',
  '  bun test [files]        run bun:test suites',
  '  bun --version           print the shim Bun version',
].join(NL);

async function main() {
  const first = argv[0];
  if (!first || first === '--help' || first === '-h' || first === 'help') { out(HELP); process.exit(0); }
  if (first === '--version' || first === '-v') { out(BUN_VERSION); process.exit(0); }
  if (first === '--revision') { out(BUN_VERSION + '-vivari'); process.exit(0); }
  if (first === '-e' || first === '--eval') {
    installBun();
    const code = argv[1] || '';
    const fn = new Function('code', 'return eval(code)');
    fn(code);
    process.exit(0);
  }

  const rest = argv.slice(1);
  switch (first) {
    case 'run': return doRun(rest);
    case 'install': case 'i': return doInstall('install', rest);
    case 'add': case 'a': return doInstall('add', rest);
    case 'remove': case 'rm': case 'uninstall': return doInstall('remove', rest);
    case 'update': case 'upgrade': case 'up': return doInstall('update', rest);
    case 'ci': return doInstall('ci', rest);
    case 'x': case 'exec': return doExec(rest);
    case 'build': return doBuild(rest);
    case 'test': return doTest(rest);
    case 'init': case 'create': case 'pm': case 'link': case 'unlink':
      err('bun ' + first + ' is not implemented in the Vivari shim yet.');
      process.exit(1);
      return;
    default:
      // Bare \`bun <file>\` -> run the file.
      return doRun(argv);
  }
}

// Any rejection from an async subcommand path (install/test/build/run) must be
// visible: without this catch a thrown error is a silent unhandled rejection and
// the process exits with no diagnostic.
main().catch((e) => {
  process.stderr.write('bun: ' + ((e && e.stack) || e) + NL);
  process.exit(1);
});
`;

// `bunx` — Bun's package runner. Same behaviour as `bun x`; delegates to npx.
export const BUNX_PROGRAM = `
'use strict';
const cp = require('child_process');
const child = cp.spawn('npx', process.argv.slice(2), { cwd: process.cwd(), env: process.env });
if (child.stdout) child.stdout.on('data', (d) => process.stdout.write(d));
if (child.stderr) child.stderr.on('data', (d) => process.stderr.write(d));
child.on('error', (e) => { process.stderr.write('bunx: ' + ((e && e.message) || e) + String.fromCharCode(10)); process.exit(127); });
child.on('close', (code) => process.exit(code | 0));
`;