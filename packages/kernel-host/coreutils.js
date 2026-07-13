// Built-in programs, written as ordinary CommonJS Node programs that run inside a
// process worker via the runtime. The kernel installs each as `/bin/<name>.js`,
// so from a program's point of view they are just files on PATH. Everything —
// even the shell — is "just a Node process", exactly like StackBlitz's per-PID
// Node workers.

import { NODE_GYP_STUB } from "./node-gyp-stub.js";

export const COREUTILS = {
  // NOTE: there is no built-in `npm` here anymore. The Turbo-analog installer
  // (packages/kernel-host/programs/npm.js) has been RETIRED from the shipped
  // product — studio now boots the REAL npm CLI unconditionally (see
  // load-real-npm.js + demo/kernel-worker.js). The analog survives ONLY as an
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

  echo: `process.stdout.write(process.argv.slice(2).join(' ') + '\\n');\n`,

  pwd: `process.stdout.write(process.cwd() + '\\n');\n`,

  true: `process.exit(0);\n`,

  false: `process.exit(1);\n`,

  cat: `
const fs = require('fs');
const path = require('path');
let rc = 0;
for (const a of process.argv.slice(2)) {
  try {
    process.stdout.write(fs.readFileSync(path.resolve(process.cwd(), a), 'utf8'));
  } catch (e) {
    process.stderr.write('cat: ' + a + ': ' + (e.code || e.message) + '\\n');
    rc = 1;
  }
}
process.exit(rc);
`,

  ls: `
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const target = args[0] ? path.resolve(process.cwd(), args[0]) : process.cwd();
try {
  const names = fs.readdirSync(target);
  if (names.length) process.stdout.write(names.join('\\n') + '\\n');
} catch (e) {
  process.stderr.write('ls: ' + (args[0] || '.') + ': ' + (e.code || e.message) + '\\n');
  process.exit(1);
}
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
  '--loader', '--experimental-loader', '--env-file', '--conditions', '-C',
  '--title', '--cpu-prof-dir', '--heap-prof-dir', '--diagnostic-dir',
  '--redirect-warnings', '--disable-proto', '--report-dir', '--report-filename',
]);
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
  // builtins (cd, pwd, export, :, true, false), everything else spawned as a
  // child process inheriting cwd/env. Quotes ("' ) are stripped by the tokenizer.
  sh: `
const fs = require('fs');
const cp = require('child_process');

const argv = process.argv;
let script = '';
if (argv[2] === '-c') script = argv[3] || '';
else if (argv[2]) script = fs.readFileSync(argv[2], 'utf8');

function tokenize(s) {
  const out = [];
  let cur = '', q = null, has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      q = c; has = true;
    } else if (/\\s/.test(c)) {
      if (has) { out.push(cur); cur = ''; has = false; }
    } else {
      cur += c; has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

// External commands run ASYNC and stream their output live: a long-running server
// (e.g. \`node dist/main.js\`, spawned by \`nest start\` as \`sh -c 'node ...'\`) never
// exits, so spawnSync would block forever AND buffer all logs until exit — the
// Nest/Vite banner would never appear. Async spawn forwards each chunk as it lands.
// The foreground child of an interactive shell: while set, the REPL's raw stdin
// is piped to it (so \`cat\`, a \`node\` REPL, etc. get keystrokes) instead of being
// line-edited by the shell itself.
let currentChild = null;

function runSimple(tokens) {
  if (!tokens.length) return Promise.resolve(0);
  const cmd = tokens[0];
  const args = tokens.slice(1);
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
  return new Promise((resolve) => {
    const child = cp.spawn(cmd, args, { cwd: process.cwd(), env: process.env });
    currentChild = child;
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('error', (e) => {
      currentChild = null;
      process.stderr.write('sh: ' + (e && e.code === 'ENOENT' ? cmd + ': not found' : ((e && e.message) || e)) + '\\n');
      resolve(127);
    });
    child.on('close', (code) => { currentChild = null; resolve(code == null ? 0 : code); });
  });
}

async function runLine(line) {
  const segs = line.split(/(&&|\\|\\||;)/);
  let status = 0, op = ';';
  for (let seg of segs) {
    seg = seg.trim();
    if (seg === '' || seg === ';') { op = ';'; continue; }
    if (seg === '&&' || seg === '||') { op = seg; continue; }
    const skip = (op === '&&' && status !== 0) || (op === '||' && status === 0);
    if (!skip) status = await runSimple(tokenize(seg));
    op = ';';
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
  const history = [];
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

  process.stdin.setRawMode && process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('OpenContainer shell — type commands, Enter to run.\\n');
  prompt();

  // Auto-run a command at startup (OC_RUN), exactly as if the user had typed it.
  // Used by the demo "Run" button so a dev server runs IN this shell tab (its
  // lifecycle == the tab's): echo it after the prompt, then execute. If it is a
  // long-running server the drain stays busy on it (the tab is "held" like a real
  // \`npm run dev\`); Ctrl+C / closing the tab kills it. Control returns to an
  // interactive prompt if/when it exits.
  const auto = process.env.OC_RUN;
  if (auto) { process.stdout.write(auto + '\\n'); queue.push(auto); drain(); }

  process.stdin.on('data', (buf) => {
    const s = typeof buf === 'string' ? buf : buf.toString('utf8');
    // A foreground child owns stdin: Ctrl+C interrupts it (SIGINT); otherwise pass
    // keystrokes straight through (Enter as newline), no line-edit/echo — the
    // program drives the display.
    if (currentChild) {
      if (s.indexOf('\\x03') !== -1) { try { currentChild.kill('SIGINT'); } catch (e) {} }
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
