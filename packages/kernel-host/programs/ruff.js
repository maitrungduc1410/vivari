// The `ruff` program — an ordinary CommonJS Node program that runs as a process
// inside Vivari, installed as /bin/ruff.js (see coreutils.js), so from the shell
// it is just `ruff` on PATH.
//
// The only Python tool here that is not Python. ruff is Rust compiled to
// WebAssembly (see scripts/vendor-ruff.mjs), which has one consequence worth
// stating plainly: it never boots the interpreter. `ruff check` on a cold
// project does not pay Pyodide's ~2s start, does not load a single wheel, and
// does not care whether the code it is reading could even import.
//
// What it supports, and why the list stops where it does:
//   ruff check [paths]     lint. --fix is refused, and the refusal says why:
//                          the wasm build does not mark which fixes are safe
//   ruff format [paths]    format in place; --check and --diff instead report
//   ruff --version         the vendored version, without loading the wasm
//
// Everything else the real CLI accepts is REFUSED rather than ignored. A linter
// that quietly drops --select is worse than no linter: it reports a clean file
// under rules the user never selected and they believe it.
//
// The one difference from the real thing that cannot be refused is
// configuration: a [tool.ruff] table in pyproject.toml (or a ruff.toml) is NOT
// read, because parsing TOML well enough to be trusted with someone's lint
// config is a bigger thing than this, and misreading it silently is precisely
// the failure above. So it is detected and reported, once, on stderr.
//
// Authoring note: like programs/python.js this source is embedded as a template
// string, so it deliberately uses NO backticks, NO ${...} and NO backslashes.
// Newlines come from String.fromCharCode(10).

export const RUFF_PROGRAM = `
'use strict';
const NL = String.fromCharCode(10);
const fs = require('fs');
const path = require('path');
function out(s) { process.stdout.write(s + NL); }
function err(s) { process.stderr.write(s + NL); }

// Not process.exit(). The runtime's exit() throws the event loop's exit
// sentinel, so calling it inside this program's async chain lands in the catch
// at the bottom, which would report the successful exit as a ruff crash - it
// printed "ruff: exit" on stderr after every clean check. The status travels as
// a thrown value of our own instead, and the catch tells the two apart.
function done(code) { const e = new Error('ruff-exit'); e.__ruffExit = code | 0; return e; }

const USAGE = [
  'Usage: ruff <command> [paths]',
  '',
  'Commands:',
  '  check [paths]    lint Python files',
  '  format [paths]   format Python files (--check or --diff to only report)',
  '',
  'Options:',
  '  --line-length N  override the line length (default 88)',
  '  --version        print the vendored ruff version',
].join(NL);

// Directories that are never someone's own source. Same list the Python file
// mirroring uses, for the same reason: linting a vendored dependency reports
// thousands of problems in code the user cannot edit.
const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.mypy_cache', '.ruff_cache', 'site-packages', 'dist', 'build', '.eggs']);

function pyFilesUnder(target, acc) {
  let st;
  try { st = fs.statSync(target); } catch (e) { return acc; }
  if (st.isFile()) { acc.push(target); return acc; }
  if (!st.isDirectory()) return acc;
  let names = [];
  try { names = fs.readdirSync(target); } catch (e) { return acc; }
  names.sort();
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (SKIP.has(name)) continue;
    const full = path.join(target, name);
    let s;
    try { s = fs.statSync(full); } catch (e) { continue; }
    if (s.isDirectory()) pyFilesUnder(full, acc);
    else if (s.isFile() && (name.endsWith('.py') || name.endsWith('.pyi'))) acc.push(full);
  }
  return acc;
}

// Relative to the working directory, the way ruff reports paths. An absolute
// path in a lint report is noise the user has to read past on every line.
function display(p) {
  const cwd = process.cwd();
  const prefix = cwd.endsWith('/') ? cwd : cwd + '/';
  return p.indexOf(prefix) === 0 ? p.slice(prefix.length) : p;
}

// A ruff config we are not reading is a difference the user has to be told
// about, since their rules are not the rules being applied.
function warnAboutConfig() {
  const candidates = ['ruff.toml', '.ruff.toml'];
  let found = null;
  for (let i = 0; i < candidates.length; i++) {
    if (fs.existsSync(path.join(process.cwd(), candidates[i]))) { found = candidates[i]; break; }
  }
  if (!found) {
    try {
      const py = fs.readFileSync(path.join(process.cwd(), 'pyproject.toml'), 'utf8');
      if (py.indexOf('[tool.ruff') !== -1) found = 'the [tool.ruff] table in pyproject.toml';
    } catch (e) { /* no pyproject */ }
  }
  if (found) {
    err('ruff: ' + found + ' is not being applied - this build runs ruff with its default rules.');
    err('      --select, --ignore and --line-length on the command line do work.');
  }
}

async function loadRuff(settings) {
  const base = process.env.VV_RUFF_URL || '';
  if (!base) {
    err('ruff: VV_RUFF_URL is not set; cannot locate the vendored ruff.');
    throw done(1);
  }
  const fetchSync = globalThis.__ocfetch;
  if (typeof fetchSync !== 'function') {
    err('ruff: this process has no synchronous fetch syscall to retrieve the wasm with.');
    throw done(1);
  }
  const meta = fetchSync(base + 'ruff_wasm_bg.wasm');
  if (!meta || !meta.ok) {
    err('ruff: fetching the ruff wasm returned HTTP ' + ((meta && meta.status) || '?') + '.');
    err('      The vendor step did not run for this build (npm run vendor:ruff).');
    throw done(1);
  }
  const bytes = fs.readFileSync(meta.path);
  const mod = await import(base + 'ruff_wasm.js');
  await mod.default({ module_or_path: bytes });
  return { mod: mod, workspace: new mod.Workspace(settings) };
}

// ruff's own settings object takes the keys its TOML does, so a flag maps
// straight through rather than being translated.
function settingsFrom(opts) {
  const s = {};
  if (opts.lineLength != null) s['line-length'] = opts.lineLength;
  const lint = {};
  if (opts.select) lint.select = opts.select;
  if (opts.ignore) lint.ignore = opts.ignore;
  if (opts.select || opts.ignore) s.lint = lint;
  return s;
}

function parseArgs(argv, cmd) {
  const opts = { paths: [], check: false, diff: false, lineLength: null, select: null, ignore: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? null : a.slice(eq + 1);
    const value = function () { return inline !== null ? inline : argv[++i]; };
    if (a.charAt(0) !== '-') { opts.paths.push(a); continue; }
    if (name === '--fix' || name === '--unsafe-fixes' || name === '--fix-only') {
      // Not "unimplemented": implemented, watched it turn a working file into
      // "n a+b", and taken back out. Two reasons, either one sufficient.
      // The wasm build reports a fix as a message and a list of edits and does
      // NOT say whether it is safe, so applying them is real ruff's
      // --unsafe-fixes, which is allowed to change what the code does - under a
      // flag the user did not type. And several fixes for one file are computed
      // against the same original text, so an unused-import deletion and an
      // import-sort rewrite overlap and shred each other unless you apply one,
      // re-lint, and repeat, which is what the real CLI does.
      err('ruff: --fix cannot be honoured here.');
      err('      The wasm build does not mark which fixes are safe, so applying them');
      err('      would be --unsafe-fixes without being asked, and rewriting your source');
      err('      on a guess is not worth it. "ruff check" still tells you what to change,');
      err('      and "ruff format" is safe because formatting is whole-file, not a patch.');
      throw done(2);
    }
    if (name === '--check') { opts.check = true; continue; }
    if (name === '--diff') { opts.diff = true; continue; }
    if (name === '--line-length') { opts.lineLength = parseInt(value(), 10); continue; }
    if (name === '--select') { opts.select = String(value()).split(','); continue; }
    if (name === '--ignore' || name === '--extend-ignore') { opts.ignore = String(value()).split(','); continue; }
    if (name === '--no-cache' || name === '-q' || name === '--quiet') { continue; }
    err('ruff: ' + name + ' is not supported here.');
    err('      Supported: --check, --diff, --line-length, --select, --ignore.');
    throw done(2);
  }
  if (!opts.paths.length) opts.paths.push('.');
  return opts;
}

function collect(paths) {
  const files = [];
  for (let i = 0; i < paths.length; i++) pyFilesUnder(path.resolve(process.cwd(), paths[i]), files);
  return files;
}

async function doCheck(argv) {
  const opts = parseArgs(argv, 'check');
  warnAboutConfig();
  let fixable = 0;
  const files = collect(opts.paths);
  const loaded = await loadRuff(settingsFrom(opts));
  let total = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    let source;
    try { source = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
    let diagnostics;
    try {
      diagnostics = loaded.workspace.check(source);
    } catch (e) {
      err(display(file) + ': ruff could not parse this file (' + ((e && e.message) || e) + ')');
      total++;
      continue;
    }
    for (let d = 0; d < diagnostics.length; d++) {
      const diag = diagnostics[d];
      total++;
      if (diag.fix && diag.fix.edits && diag.fix.edits.length) fixable++;
      out(
        display(file) + ':' + diag.start_location.row + ':' + diag.start_location.column + ': ' +
          (diag.code || '') + ' ' + diag.message,
      );
    }
  }
  if (total) {
    out('Found ' + total + ' error' + (total === 1 ? '' : 's') + '.');
    if (fixable) out('[' + fixable + ' fixable with a manual edit - the message above says what to change]');
    throw done(1);
  }
  out('All checks passed!');
  throw done(0);
}

async function doFormat(argv) {
  const opts = parseArgs(argv, 'format');
  warnAboutConfig();
  const files = collect(opts.paths);
  const loaded = await loadRuff(settingsFrom(opts));
  let changed = 0;
  let same = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    let source;
    try { source = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
    let formatted;
    try {
      formatted = loaded.workspace.format(source);
    } catch (e) {
      err(display(file) + ': ruff could not parse this file (' + ((e && e.message) || e) + ')');
      process.exitCode = 2;
      continue;
    }
    if (formatted === source) { same++; continue; }
    changed++;
    if (opts.diff) {
      out('--- ' + display(file));
      out('+++ ' + display(file) + ' (formatted)');
    } else if (!opts.check) {
      try { fs.writeFileSync(file, formatted); } catch (e) {
        err('ruff: could not write ' + display(file) + ' (' + ((e && e.message) || e) + ')');
      }
    }
  }
  const verb = opts.check || opts.diff ? 'would be reformatted' : 'reformatted';
  const parts = [];
  if (changed) parts.push(changed + ' file' + (changed === 1 ? '' : 's') + ' ' + verb);
  if (same) parts.push(same + ' file' + (same === 1 ? '' : 's') + ' left unchanged');
  out(parts.length ? parts.join(', ') : '0 files reformatted');
  throw done((opts.check || opts.diff) && changed ? 1 : 0);
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { out(USAGE); throw done(argv.length ? 0 : 2); }
  // Answered from the file the vendor step wrote, so asking which ruff this is
  // does not cost 11 MB of wasm.
  if (argv[0] === '--version' || argv[0] === '-V' || argv[0] === 'version') {
    const base = process.env.VV_RUFF_URL || '';
    const fetchSync = globalThis.__ocfetch;
    let version = 'unknown';
    try {
      const meta = fetchSync(base + 'version.txt');
      if (meta && meta.ok) version = fs.readFileSync(meta.path, 'utf8').trim();
    } catch (e) { /* reported as unknown */ }
    out('ruff ' + version);
    throw done(0);
  }
  const cmd = argv[0];
  if (cmd === 'check') return doCheck(argv.slice(1));
  if (cmd === 'format') return doFormat(argv.slice(1));
  // ruff's own subcommands that this build does not have. Named individually so
  // the answer is about the command the user typed.
  if (cmd === 'linter' || cmd === 'rule' || cmd === 'config' || cmd === 'clean' || cmd === 'server') {
    err('ruff: "' + cmd + '" is not available here - this build is ruff check and ruff format.');
    throw done(2);
  }
  err('ruff: unknown command "' + cmd + '".');
  err(USAGE);
  throw done(2);
}

main().then(
  function () {},
  function (e) {
    if (e && typeof e.__ruffExit === 'number') { process.exitCode = e.__ruffExit; return; }
    err('ruff: ' + ((e && e.message) || e));
    process.exitCode = 1;
  },
);
`;
