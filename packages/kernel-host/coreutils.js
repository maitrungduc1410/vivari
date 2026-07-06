// Built-in programs, written as ordinary CommonJS Node programs that run inside a
// process worker via the runtime. The kernel installs each as `/bin/<name>.js`,
// so from a program's point of view they are just files on PATH. Everything —
// even the shell — is "just a Node process", exactly like StackBlitz's per-PID
// Node workers.

export const COREUTILS = {
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
const target = process.argv[2];
if (!target) {
  process.stderr.write('node: missing script\\n');
  process.exit(1);
}
require(path.resolve(process.cwd(), target));
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

function runSimple(tokens) {
  if (!tokens.length) return 0;
  const cmd = tokens[0];
  const args = tokens.slice(1);
  if (cmd === 'cd') {
    try { process.chdir(args[0] || '/'); return 0; }
    catch (e) { process.stderr.write('cd: ' + (e.code || e.message) + '\\n'); return 1; }
  }
  if (cmd === 'pwd') { process.stdout.write(process.cwd() + '\\n'); return 0; }
  if (cmd === 'export') {
    for (const a of args) { const i = a.indexOf('='); if (i > 0) process.env[a.slice(0, i)] = a.slice(i + 1); }
    return 0;
  }
  if (cmd === ':' || cmd === 'true') return 0;
  if (cmd === 'false') return 1;
  const r = cp.spawnSync(cmd, args, { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status || 0;
}

function runLine(line) {
  const segs = line.split(/(&&|\\|\\||;)/);
  let status = 0, op = ';';
  for (let seg of segs) {
    seg = seg.trim();
    if (seg === '' || seg === ';') { op = ';'; continue; }
    if (seg === '&&' || seg === '||') { op = seg; continue; }
    const skip = (op === '&&' && status !== 0) || (op === '||' && status === 0);
    if (!skip) status = runSimple(tokenize(seg));
    op = ';';
  }
  return status;
}

let status = 0;
for (const raw of script.split('\\n')) {
  const line = raw.replace(/#.*$/, '').trim();
  if (line) status = runLine(line);
}
process.exit(status);
`,
};
