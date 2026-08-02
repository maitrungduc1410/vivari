// The `bun` program — a CommonJS Node program that runs as an ordinary process
// inside Vivari, installed as /bin/bun.js (see coreutils.js), so from the shell it
// is just `bun` on PATH. It is the CLI half of Bun support; the runtime half (the
// `Bun` global + `bun:*` modules + zero-config TS/JSX) lives in packages/runtime.
//
// Unlike npm/yarn/pnpm — which Vivari runs as their REAL vendored JS CLIs — Bun is
// a native binary with no pure-JS build, so this is a purpose-built analog:
//   bun / bun run <file>     run a TS/JS/TSX file with the Bun global installed
//   bun run <script>         run a package.json script (with pre/post), via sh
//   bun install|add|remove|update|up|ci   DELEGATE to the real npm CLI, then write
//                            a best-effort text bun.lock (Bun cannot install
//                            natively in-browser; npm's proven installer does the
//                            work). NOTE `update`/`up` only — see `upgrade` below.
//   bun x / bunx <pkg>       run a package bin (delegates to npx)
//   bun build <entry>        BUNDLE (real dependency graph, npm deps included)
//                            to --outfile/--outdir, through the same engine as
//                            the programmatic Bun.build. Output is not
//                            byte-identical to real Bun's — see
//                            packages/runtime/builtins/bun-build.js.
//   bun test [filters]       run bun:test suites and report. A positional is a
//                            FILENAME FILTER (Bun's semantics), and the flags
//                            -t/--test-name-pattern, --bail[=N], --timeout=<ms>,
//                            -u/--update-snapshots, --todo, --only,
//                            --pass-with-no-tests, --reporter=junit|dots and
//                            --dots are honoured. Every other flag is refused by
//                            name — they used to be dropped silently, so
//                            `bun test -t auth` ran the whole suite and passed.
//   bun --version | -v       print the shim's Bun version
//   bun --revision           print <version>-vivari (same string as Bun.revision)
//   bun upgrade              NOT IMPLEMENTED: real `bun upgrade` replaces the Bun
//                            binary, which does not exist here. It used to be an
//                            alias for `npm update`, which is a different action.
//   bun init|create|pm|link|unlink|<unknown verb>   NOT IMPLEMENTED, exit 1. An
//                            argument that names a file or a package.json script
//                            still runs (that is real `bun <file>` / `bun <script>`).
//
// Authoring note: like programs/npm.js this source is embedded as a template
// string, so it deliberately uses NO backticks, NO ${...} and NO backslashes.
// Newlines come from String.fromCharCode(10). That also means the program cannot
// import the runtime's BUN_VERSION; it carries the fallback literal below instead,
// and scripts/spike-bun-offline.mjs asserts the two never drift.

// The version the CLI reports when the Vivari runtime is not present to install
// the Bun global (a plain `node` host, e.g. the offline spike). MUST equal
// BUN_VERSION in packages/runtime/builtins/bun.js — that is the real definition,
// and scripts/spike-bun-offline.mjs fails the build if these drift apart.
export const BUN_CLI_VERSION_FALLBACK = "1.1.34";

export const BUN_PROGRAM = `
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const NL = String.fromCharCode(10);
const VERSION_FALLBACK = '1.1.34';
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
//
// loadEnv asks the runtime to also perform Bun's automatic .env loading. Pass it
// wherever this process is about to RUN user code (a file, an eval, tests, a
// build) and only there. Two paths deliberately do not:
//   - version/help, which reads Bun.version off the global and exits;
//   - bun run <script>, which shells out: real Bun skips the default .env files
//     for the script runner and lets the bun instance the script starts load
//     them, so that a script like "NODE_ENV=production bun app.ts" is not handed
//     the runner's development environment (oven-sh/bun#9635).
// The install/x paths delegate to npm/npx, and we do not inject .env into that
// child either: our installer is npm, not Bun's, and quietly changing npm's
// environment from a project file is a surprise nobody asked for.
//
// mode, when given, pins which .env.{mode} files are read instead of deriving it
// from NODE_ENV. Only bun test passes it — see doTest.
function installBun(loadEnv, mode) {
  try {
    if (typeof globalThis.__ocInstallBun === 'function') {
      globalThis.__ocInstallBun(loadEnv ? { dotenv: true, mode: mode || null } : null);
    }
  } catch (e) {}
}

// Version + revision come from the Bun global, which is the single definition
// (packages/runtime/builtins/bun.js). Installing it first is what makes this a
// read rather than a second copy; VERSION_FALLBACK only applies on a host with no
// Vivari runtime. --revision used to print its own '-vivari' suffix while
// Bun.revision said 'vivari-shim'; now both come from Bun.revision.
function bunIdent() {
  installBun();
  const g = typeof globalThis.Bun !== 'undefined' ? globalThis.Bun : null;
  return {
    version: (g && g.version) || VERSION_FALLBACK,
    revision: (g && g.revision) || (VERSION_FALLBACK + '-vivari'),
  };
}

// ---- run a file with the Bun runtime active --------------------------------
function runFile(target, rest) {
  if (!target) { err('bun: no file to run'); process.exit(1); }
  const abs = path.resolve(cwd, target);
  if (!isFile(abs) && !isFile(abs + '.ts') && !isFile(abs + '.tsx') && !isFile(abs + '.js')) {
    err('bun: file not found: ' + target);
    process.exit(1);
  }
  installBun(true);
  process.argv = ['bun', abs, ...rest];
  // Surface load/parse/runtime errors from the entry directly (a bare throw here
  // would otherwise bubble up through the async main() chain as a silent
  // unhandled rejection and the process would just exit with no output).
  try {
    // Through the loader's runMain, NOT a bare require: runMain publishes the file
    // as the process ENTRY MODULE, which is what makes require.main === module and
    // import.meta.main true inside it. With a plain require the entry stayed
    // /bin/bun.js — this launcher — so the file the user actually ran reported
    // import.meta.main === false, and every 'am I the entrypoint?' guard in it
    // silently did nothing. It also gets the cmd-shim unwrapping and the
    // top-level-await entry handling that runMain owns.
    const moduleBuiltin = require('module');
    const started = typeof moduleBuiltin.runMain === 'function' ? moduleBuiltin.runMain(abs) : require(abs);
    // A top-level-await entry evaluates to a promise; a rejection in it must not
    // become a silent exit either.
    if (started && typeof started.then === 'function') {
      started.catch(function (e) { err('bun: ' + ((e && e.stack) || e)); process.exit(1); });
    }
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
  else if (sub === 'update') npmSub = 'update';
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

// ---- bun build : the real bundler, through Bun.build ------------------------
// One engine, two front doors: this CLI and the programmatic Bun.build() are the
// same code (packages/runtime/builtins/bun-build.js), so an option cannot be
// honoured in one and dropped in the other. Every flag below maps onto a
// Bun.build option and every unsupported one throws from there, naming itself.
// The output is NOT byte-identical to real Bun's -- see that file's header.
async function doBuild(rest) {
  installBun(true);
  // --compile asks for a standalone native executable with the Bun runtime
  // embedded. Without this guard we fell through to the transpile path and wrote
  // a JavaScript file under the name the user expected an executable at, then
  // reported success -- the shim's worst failure mode, since the file exists,
  // looks right, and is not a binary. It stays HERE, ahead of everything, so the
  // message is about --compile rather than about whatever else the command line
  // happened to get wrong.
  for (const a of rest) {
    if (a === '--compile' || a.indexOf('--compile=') === 0) {
      err('bun build --compile is not supported in Vivari (browser sandbox): it emits a standalone NATIVE executable with the Bun runtime embedded, and a browser tab can neither produce nor run one.');
      err('Use bun build <entry> --outfile=<file> for the JavaScript output, and run it with bun <file>.');
      process.exit(1);
    }
  }

  const entries = [];
  const opts = {};
  const external = [];
  const define = {};
  let outfile = null;
  // A flag we do not know is NOT dropped: it is very likely a real bun build
  // option, and quietly ignoring one is the failure this whole subsystem exists
  // to avoid. Options Bun has and this bundler does not (--minify, --splitting,
  // --sourcemap) are passed through to Bun.build so that IT produces the message
  // explaining what is missing and why.
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const eq = a.indexOf('=');
    const flag = a[0] === '-' && eq > 0 ? a.slice(0, eq) : a;
    const value = a[0] === '-' && eq > 0 ? a.slice(eq + 1) : null;
    const next = () => (value !== null ? value : rest[++i]);
    if (a[0] !== '-') { entries.push(a); continue; }
    if (flag === '--outfile') { outfile = next(); continue; }
    if (flag === '--outdir') { opts.outdir = next(); continue; }
    if (flag === '--target') { opts.target = next(); continue; }
    if (flag === '--format') { opts.format = next(); continue; }
    if (flag === '--root') { opts.root = next(); continue; }
    if (flag === '--entry-naming') { opts.naming = next(); continue; }
    if (flag === '--banner') { opts.banner = next(); continue; }
    if (flag === '--footer') { opts.footer = next(); continue; }
    if (flag === '--external') { external.push(next()); continue; }
    if (flag === '--define' || flag === '-d') {
      const pair = next() || '';
      const at = pair.indexOf('=');
      if (at < 0) { err('bun build: --define needs KEY=VALUE, got ' + JSON.stringify(pair)); process.exit(1); }
      define[pair.slice(0, at)] = pair.slice(at + 1);
      continue;
    }
    if (flag === '--minify' || flag === '--minify-whitespace' || flag === '--minify-identifiers' || flag === '--minify-syntax') { opts.minify = true; continue; }
    if (flag === '--splitting') { opts.splitting = true; continue; }
    if (flag === '--sourcemap') { opts.sourcemap = value === null ? 'linked' : value; continue; }
    if (flag === '--bytecode') { opts.bytecode = true; continue; }
    if (flag === '--public-path') { opts.publicPath = next(); continue; }
    if (flag === '--packages') { opts.packages = next(); continue; }
    if (flag === '--drop') { opts.drop = [next()]; continue; }
    if (flag === '--conditions') { opts.conditions = [next()]; continue; }
    err('bun build: unknown option ' + flag + '. It is rejected rather than ignored: a build that silently dropped an option you asked for would report success and hand you the wrong file.');
    process.exit(1);
  }
  if (!entries.length) { err('usage: bun build <entry> [--outfile=<file> | --outdir=<dir>] [--target=node] [--format=esm]'); process.exit(1); }

  // --outfile names ONE output file, which is a naming template in disguise:
  // Bun.build only knows outdir + naming, so express it as exactly that rather
  // than writing the file a second way and risking the two paths diverging.
  if (outfile) {
    if (opts.outdir) { err('bun build: --outfile and --outdir are mutually exclusive'); process.exit(1); }
    if (entries.length > 1) { err('bun build: --outfile takes a single entry point (got ' + entries.length + '); use --outdir for several'); process.exit(1); }
    const abs = path.resolve(cwd, outfile);
    opts.outdir = path.dirname(abs);
    opts.naming = path.basename(abs);
  }

  opts.entrypoints = entries;
  if (external.length) opts.external = external;
  if (Object.keys(define).length) opts.define = define;

  let result;
  try {
    result = await Bun.build(opts);
  } catch (e) {
    // A rejected option (minify/splitting/sourcemap/...) arrives here as the throw
    // from bun-build.js, which already names the option and the reason.
    err('bun build: ' + ((e && e.message) || e));
    process.exit(1);
    return;
  }
  for (const log of result.logs) err('bun build: ' + log.level + ': ' + log.message);
  if (!result.success) { err('bun build failed'); process.exit(1); }
  if (!opts.outdir) {
    // No destination: Bun prints the bundle to stdout.
    for (const artifact of result.outputs) process.stdout.write(await artifact.text());
    process.exit(0);
    return;
  }
  for (const artifact of result.outputs) out('bun build: wrote ' + artifact.path + '  (' + artifact.size + ' bytes)');
  out('Bundled ' + result.outputs.length + ' file(s). NOTE: Vivari bundles with its own bundler, so the bytes are not identical to real bun build.');
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
// bun test's flags. Every one of these used to be DROPPED silently (the old
// implementation was rest.filter(a => a[0] !== '-')), so 'bun test -t auth' ran the
// whole suite and reported success -- the exact class of quiet approximation this
// shim is not allowed to make. Anything not listed is now refused by name.
function parseTestArgs(rest) {
  const o = { files: [], timeout: null, bail: 0, pattern: null, update: false, todo: false, only: false, reporter: null, outfile: null, passWithNoTests: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a[0] !== '-') { o.files.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? null : a.slice(eq + 1);
    // A flag's value is either '--flag=value' or the next argument; taking the
    // next argument advances the loop past it.
    const value = function () {
      if (inline !== null) return inline;
      if (i + 1 >= rest.length) { err('bun test: ' + name + ' needs a value'); process.exit(1); }
      return rest[++i];
    };
    if (name === '--timeout') { o.timeout = parseInt(value(), 10); continue; }
    if (name === '-t' || name === '--test-name-pattern') { o.pattern = value(); continue; }
    // --bail with no value means 1, so it never consumes the next argument.
    if (name === '--bail') { o.bail = inline !== null ? parseInt(inline, 10) : 1; continue; }
    if (name === '-u' || name === '--update-snapshots') { o.update = true; continue; }
    if (name === '--todo') { o.todo = true; continue; }
    if (name === '--only') { o.only = true; continue; }
    if (name === '--pass-with-no-tests') { o.passWithNoTests = true; continue; }
    if (name === '--reporter') { o.reporter = value(); continue; }
    if (name === '--reporter-outfile') { o.outfile = value(); continue; }
    if (name === '--dots') { o.reporter = 'dots'; continue; }
    err('bun test: ' + name + ' is not implemented in the Vivari shim.');
    err('Supported: -t/--test-name-pattern, --bail[=N], --timeout=<ms>, -u/--update-snapshots, --todo, --only, --pass-with-no-tests, --reporter=junit|dots (+ --reporter-outfile), --dots.');
    process.exit(1);
  }
  if (o.reporter && o.reporter !== 'junit' && o.reporter !== 'dots') {
    err('bun test: --reporter=' + o.reporter + ' is not implemented in the Vivari shim (junit, dots).');
    process.exit(1);
  }
  if (o.reporter === 'junit' && !o.outfile) {
    err('bun test: --reporter=junit requires --reporter-outfile=<path>');
    process.exit(1);
  }
  return o;
}

// A positional argument to 'bun test' is a FILENAME FILTER, not a path: real Bun
// documents 'bun test foo bar' as "all test files with foo or bar in the file
// name". A path that exists is still honoured, so 'bun test src/a.test.ts' works
// either way.
function selectTestFiles(names, discovered, path) {
  if (!names.length) return discovered;
  const out = [];
  for (const n of names) {
    const abs = path.resolve(cwd, n);
    if (isFile(abs)) { if (out.indexOf(abs) === -1) out.push(abs); continue; }
    for (const f of discovered) if (f.indexOf(n) !== -1 && out.indexOf(f) === -1) out.push(f);
  }
  return out;
}

async function doTest(rest) {
  // A test run is Bun's TEST MODE, and that is two documented facts, in this
  // order (https://bun.com/docs/test/runtime-behavior):
  //   1. the .env file set is the test set -> .env.test.local, .env.test, .env.
  //      .env.local is machine-local developer state and is deliberately skipped,
  //      so a suite cannot pass on one laptop and fail in CI over a file nobody
  //      committed (oven-sh/bun#9877);
  //   2. NODE_ENV is then defaulted to 'test' -- 'unless it is already set in the
  //      environment or in .env files', which is why it happens AFTER the load and
  //      why the mode above cannot simply be derived from NODE_ENV.
  installBun(true, 'test');
  if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';
  const opts = parseTestArgs(rest);
  const targets = selectTestFiles(opts.files, findTestFiles(cwd, []), path);
  if (!targets.length) {
    if (opts.passWithNoTests) { out('bun test: no test files found'); process.exit(0); }
    err('bun test: no test files found');
    process.exit(1);
  }
  const bunTest = require('bun:test');
  let loadFailed = false;
  for (const f of targets) {
    out('# ' + path.relative(cwd, f));
    // Tell the runner which file it is loading: a test's file is what a snapshot
    // path, a mock.module() specifier and the JUnit report are all resolved from.
    if (typeof bunTest.__setFile === 'function') bunTest.__setFile(f);
    try { require(f); } catch (e) { loadFailed = true; err('  failed to load: ' + ((e && e.stack) || e)); }
  }
  if (typeof bunTest.__setFile === 'function') bunTest.__setFile(null);
  const code = await bunTest.__run({
    timeout: opts.timeout,
    bail: opts.bail,
    testNamePattern: opts.pattern,
    updateSnapshots: opts.update,
    todo: opts.todo,
    only: opts.only,
    reporter: opts.reporter,
    reporterOutfile: opts.outfile ? path.resolve(cwd, opts.outfile) : null,
  });
  // A file that failed to LOAD registers no tests, so the run below can report
  // "0 fail" over a suite that never ran. Exit non-zero regardless.
  process.exit(loadFailed ? 1 : (code | 0));
}

// ---- dispatch --------------------------------------------------------------
function helpText() {
  return [
    'Vivari bun (shim) ' + bunIdent().version,
    '',
    'Usage: bun <command|file> [...args]',
    '',
    '  bun <file.ts>            run a TS/JS/TSX file (Bun global + zero-config TS)',
    '  bun run <script|file>    run a package.json script or a file',
    '  bun install|add|remove   manage dependencies (delegates to npm; writes bun.lock)',
    '  bun x <pkg>              run a package binary (bunx)',
    '  bun build <entry>       bundle an entry point and its imports',
    '  bun test [filters]      run bun:test suites (-t, --bail, --timeout, -u, --reporter)',
    '  bun --version           print the shim Bun version',
    '',
    "Note: bun build uses Vivari's own bundler, so its output is NOT byte-identical",
    'to real bun build (no tree shaking, no minifier). --minify/--splitting/--sourcemap',
    'are refused rather than ignored; use esbuild or rollup when you need them.',
  ].join(NL);
}

// Tell a file argument apart from an unknown subcommand, so that bun ./app.ts and
// bun app.ts keep working while bun publish reports not-implemented instead of the
// misleading 'file not found: publish'. Path-shaped or a known script extension
// counts, and so does anything that actually resolves on disk (an extensionless
// entry, or one runFile would find by appending .ts/.tsx/.js).
function looksLikeFile(a) {
  if (!a || a[0] === '-') return false;
  if (a.indexOf('/') !== -1) return true;
  if (/[.](ts|tsx|js|jsx|mjs|cjs|mts|cts|json)$/.test(a)) return true;
  const abs = path.resolve(cwd, a);
  return isFile(abs) || isFile(abs + '.ts') || isFile(abs + '.tsx') || isFile(abs + '.js');
}
// bun <script> is real Bun shorthand for bun run <script>, so a package.json
// script name is not an unknown verb either.
function isScriptName(a) {
  const pkg = readJSON(path.join(cwd, 'package.json'));
  const scripts = (pkg && pkg.scripts) || {};
  return Object.prototype.hasOwnProperty.call(scripts, a);
}

async function main() {
  const first = argv[0];
  if (!first || first === '--help' || first === '-h' || first === 'help') { out(helpText()); process.exit(0); }
  if (first === '--version' || first === '-v') { out(bunIdent().version); process.exit(0); }
  if (first === '--revision') { out(bunIdent().revision); process.exit(0); }
  if (first === '-e' || first === '--eval') {
    installBun(true);
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
    case 'update': case 'up': return doInstall('update', rest);
    case 'ci': return doInstall('ci', rest);
    case 'x': case 'exec': return doExec(rest);
    case 'build': return doBuild(rest);
    case 'test': return doTest(rest);
    case 'upgrade':
      // Real bun upgrade replaces the Bun binary itself. There is no binary here
      // (Bun is emulated on the Node runtime), so this cannot be done, and the old
      // alias to npm update quietly did something else entirely.
      err('bun upgrade upgrades the Bun binary itself, which the Vivari shim cannot do: Bun is emulated on the Node runtime, not installed as a binary.');
      err('Did you mean "bun update" (update the dependencies in package.json)?');
      process.exit(1);
      return;
    case 'init': case 'create': case 'pm': case 'link': case 'unlink':
      err('bun ' + first + ' is not implemented in the Vivari shim yet.');
      process.exit(1);
      return;
    default:
      // Bare bun <file> / bun <script> -> run it. Anything else is a subcommand we
      // do not have; say so instead of failing later as a missing file.
      if (looksLikeFile(first) || isScriptName(first)) return doRun(argv);
      err('bun ' + first + ' is not implemented in the Vivari shim yet.');
      process.exit(1);
      return;
  }
}

// Any rejection from an async subcommand path (install/test/build/run) must be
// visible: without this catch a thrown error is a silent unhandled rejection and
// the process exits with no diagnostic.
main().catch((e) => {
  // process.exit() unwinds by THROWING (packages/runtime/builtins/process.js sets
  // __processExit on the error), so an async subcommand's ordinary exit arrives
  // here as a rejection. Re-reporting it printed an "Error: process.exit called"
  // stack trace to stderr on every SUCCESSFUL bun build / bun test, which reads as
  // a crash that also happened to work.
  if (e && e.__processExit !== undefined) return;
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