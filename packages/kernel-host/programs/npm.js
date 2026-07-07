// The `npm` program (Phase 2 #10, stage 1) — a real CommonJS Node program that
// runs as an ordinary process inside OpenContainer. The kernel installs it as
// /bin/npm.js (see coreutils.js), so from the shell it is just `npm` on PATH.
//
// What stage 1 does:
//   npm install [pkg[@range] ...]   (aliases: i, add)
//     - reads package.json dependencies+devDependencies when no names are given
//     - minimal semver: caret / tilde / exact / x-range / dist-tag
//     - walks the transitive dependency graph from the registry metadata
//     - downloads each tarball via the blocking __ocfetch syscall (Fetcher Worker
//       + kernel content cache, Phase 2 #9), gunzips it with the platform-native
//       DecompressionStream (no bundled zlib), untars it, and writes the files
//       into node_modules
//     - hoists like npm v3+: first-seen version goes to the project's root
//       node_modules; a conflicting version is nested under the dependent
//     - creates .bin symlinks and records explicit installs in package.json
//   Deferred to stage 2: package-lock.json, lifecycle scripts, peer/optional
//   deps, dedup nuance, `npm ci`.
//
// Authoring note: this source is embedded as a template string, so to stay
// escaping-free it deliberately uses NO backticks, NO ${...} and NO backslashes.
// Newlines come from String.fromCharCode(10); tar/gzip parsing compares raw byte
// values instead of using regexes. Keep it that way when editing.

export const NPM_PROGRAM = `
'use strict';
const fs = require('fs');
const path = require('path');

const NL = String.fromCharCode(10);
const REGISTRY = (process.env.npm_config_registry || 'https://registry.npmjs.org').replace(/[/]+$/, '');
const dec = new TextDecoder();

function out(s) { process.stdout.write(s + NL); }
function err(s) { process.stderr.write(s + NL); }

// ---- version selection: REAL node-semver (vendored) -------------------------
// The full range grammar (caret/tilde/exact/x-range + compound '>=1 <2', unions
// '1 || 2', hyphen '1 - 2') so resolution matches npm; a plain dist-tag name
// ('latest'/'next'/...) is honoured before treating the spec as a range.
const semver = require('semver');
function pickVersion(meta, range) {
  const dt = meta['dist-tags'] || {};
  range = String(range).trim();
  if (range === '' || range === '*' || range === 'latest') { if (dt.latest) return dt.latest; }
  if (dt[range]) return dt[range]; // dist-tag (e.g. 'next', 'beta')
  const all = Object.keys(meta.versions || {});
  return semver.maxSatisfying(all, range || '*'); // highest satisfying version, or null
}

// ---- registry metadata (via blocking __ocfetch) -----------------------------
function regName(name) {
  return name[0] === '@' ? '@' + encodeURIComponent(name.slice(1)) : encodeURIComponent(name);
}
const metaCache = {};
function getMeta(name) {
  if (metaCache[name]) return metaCache[name];
  const res = __ocfetch(REGISTRY + '/' + regName(name));
  if (!res.ok) throw new Error('cannot fetch metadata for ' + name + ' (HTTP ' + res.status + ')');
  const doc = JSON.parse(fs.readFileSync(res.path, 'utf8'));
  metaCache[name] = doc;
  return doc;
}

// ---- gunzip (platform-native) + ustar tar parse -----------------------------
async function gunzip(bytes) {
  const ds = new DecompressionStream('gzip');
  const stream = new Response(bytes).body.pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}
function cstr(buf, o, len) {
  let end = o; const max = o + len;
  while (end < max && buf[end] !== 0) end++;
  return dec.decode(buf.subarray(o, end));
}
function parseTar(buf) {
  const files = [];
  let off = 0;
  let override = null; // pending long-name from a GNU 'L' or pax 'path' record
  while (off + 512 <= buf.length) {
    let allZero = true;
    for (let z = off; z < off + 512; z++) { if (buf[z] !== 0) { allZero = false; break; } }
    if (allZero) break;
    const name = cstr(buf, off, 100);
    const size = parseInt(cstr(buf, off + 124, 12).trim(), 8) || 0;
    const typeByte = buf[off + 156];
    const type = String.fromCharCode(typeByte);
    const prefix = cstr(buf, off + 345, 155);
    const full = prefix ? prefix + '/' + name : name;
    const dataStart = off + 512;
    const blocks = Math.ceil(size / 512) * 512;
    if (type === 'L') { override = cstr(buf, dataStart, size); off = dataStart + blocks; continue; }
    if (type === 'x' || type === 'g') {
      const pax = dec.decode(buf.subarray(dataStart, dataStart + size));
      const lines = pax.split(NL);
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li]; if (!line) continue;
        const sp = line.indexOf(' '); if (sp < 0) continue;
        const kv = line.slice(sp + 1); const eq = kv.indexOf('='); if (eq < 0) continue;
        if (kv.slice(0, eq) === 'path') override = kv.slice(eq + 1);
      }
      off = dataStart + blocks; continue;
    }
    const entry = override || full; override = null;
    if (type === '0' || type === '' || typeByte === 0) {
      files.push({ name: entry, data: buf.subarray(dataStart, dataStart + size) });
    }
    off = dataStart + blocks;
  }
  return files;
}
// npm tarballs put everything under a single root dir (conventionally 'package/').
function stripRoot(n) { const i = n.indexOf('/'); return i >= 0 ? n.slice(i + 1) : ''; }

async function extractTo(tarballUrl, dir) {
  const res = __ocfetch(tarballUrl);
  if (!res.ok) throw new Error('cannot fetch tarball ' + tarballUrl + ' (HTTP ' + res.status + ')');
  const tar = await gunzip(fs.readFileSync(res.path));
  const files = parseTar(tar);
  for (let i = 0; i < files.length; i++) {
    const rel = stripRoot(files[i].name);
    if (!rel) continue;
    const dest = dir + '/' + rel;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(files[i].data));
  }
}

// ---- .bin symlinks ----------------------------------------------------------
function linkBins(dir, nmDir) {
  let pj;
  try { pj = JSON.parse(fs.readFileSync(dir + '/package.json', 'utf8')); } catch (e) { return; }
  if (!pj.bin) return;
  const map = typeof pj.bin === 'string' ? { [pj.name]: pj.bin } : pj.bin;
  const binDir = nmDir + '/.bin';
  fs.mkdirSync(binDir, { recursive: true });
  for (const bname in map) {
    try { fs.symlinkSync(dir + '/' + map[bname], binDir + '/' + bname); } catch (e) { /* already linked */ }
  }
}

// ---- resolve + hoist install ------------------------------------------------
const rootVersions = {};  // name -> version placed at <cwd>/node_modules
const installedDirs = {}; // dir  -> version (dedupe + cycle guard)
let added = 0;

async function installTree(rootDeps, cwd) {
  const rootNm = cwd + '/node_modules';
  const queue = [];
  for (const n in rootDeps) queue.push({ name: n, range: rootDeps[n], parentDir: cwd });
  while (queue.length) {
    const job = queue.shift();
    const meta = getMeta(job.name);
    const version = pickVersion(meta, job.range);
    if (!version) throw new Error('no version of ' + job.name + ' matches ' + job.range);
    let dir, nmDir;
    if (rootVersions[job.name] === undefined) {
      rootVersions[job.name] = version;
      nmDir = rootNm; dir = rootNm + '/' + job.name;
    } else if (rootVersions[job.name] === version) {
      nmDir = rootNm; dir = rootNm + '/' + job.name;
      if (installedDirs[dir]) continue; // already installed + its deps enqueued
    } else {
      nmDir = job.parentDir + '/node_modules'; dir = nmDir + '/' + job.name;
    }
    if (installedDirs[dir] === version) continue;
    out('npm: ' + job.name + '@' + job.range + ' -> ' + version + (nmDir === rootNm ? '' : ' (nested)'));
    await extractTo(meta.versions[version].dist.tarball, dir);
    installedDirs[dir] = version;
    added++;
    linkBins(dir, nmDir);
    const deps = meta.versions[version].dependencies || {};
    for (const dn in deps) queue.push({ name: dn, range: deps[dn], parentDir: dir });
  }
}

function parseSpec(s) {
  const at = s.lastIndexOf('@');
  if (at <= 0) return { name: s, range: 'latest' };
  return { name: s.slice(0, at), range: s.slice(at + 1) || 'latest' };
}
function readPkg(cwd) {
  try { return JSON.parse(fs.readFileSync(cwd + '/package.json', 'utf8')); } catch (e) { return {}; }
}

// ---- npm run <script> (not installer logic; survives the switch to real npm) --
// PATH with every node_modules/.bin from cwd up to root prepended, so a script's
// bare bin name (e.g. vite) resolves to the locally installed executable, then
// the process env, then /bin.
function binPath(cwd) {
  const dirs = [];
  let cur = cwd;
  for (;;) {
    dirs.push(cur + '/node_modules/.bin');
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  if (process.env.PATH) dirs.push(process.env.PATH);
  dirs.push('/bin');
  return dirs.join(':');
}
function runScript(cwd, name, extra) {
  const cp = require('child_process');
  const scripts = readPkg(cwd).scripts || {};
  if (!name) {
    out('available scripts:');
    for (const k in scripts) out('  ' + k + ': ' + scripts[k]);
    return 0;
  }
  const script = scripts[name];
  if (!script) { err('npm: missing script: ' + name); return 1; }
  const full = extra && extra.length ? script + ' ' + extra.join(' ') : script;
  const env = Object.assign({}, process.env, { PATH: binPath(cwd) });
  out('> ' + name + ': ' + full);
  // spawnSync blocks until the script exits — fine for build/one-off scripts; a
  // long-running dev server is better launched directly (async spawn is later).
  const r = cp.spawnSync('sh', ['-c', full], { cwd: cwd, env: env, encoding: 'utf8' });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status | 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const cwd = process.cwd();
  // Script running (synchronous, no network) — handle before the installer path.
  if (cmd === 'run' || cmd === 'run-script') return runScript(cwd, argv[1], argv.slice(2));
  if (cmd === 'start' || cmd === 'test') return runScript(cwd, cmd, argv.slice(1));
  if (cmd !== 'install' && cmd !== 'i' && cmd !== 'add') {
    err('usage: npm <install|run|start|test> ...');
    return 1;
  }
  const names = argv.slice(1).filter(function (a) { return a[0] !== '-'; });
  const rootDeps = {};
  const explicit = [];
  if (names.length === 0) {
    const pj = readPkg(cwd);
    Object.assign(rootDeps, pj.dependencies || {}, pj.devDependencies || {});
    if (Object.keys(rootDeps).length === 0) { out('npm: nothing to install (no dependencies in package.json)'); return 0; }
  } else {
    for (let i = 0; i < names.length; i++) {
      const spec = parseSpec(names[i]);
      rootDeps[spec.name] = spec.range;
      explicit.push(spec);
    }
  }
  await installTree(rootDeps, cwd);
  if (explicit.length) {
    const pj = readPkg(cwd);
    if (!pj.dependencies) pj.dependencies = {};
    for (let j = 0; j < explicit.length; j++) {
      const nm = explicit[j].name;
      pj.dependencies[nm] = '^' + rootVersions[nm];
    }
    if (!pj.name) pj.name = path.basename(cwd) || 'app';
    if (!pj.version) pj.version = '1.0.0';
    fs.writeFileSync(cwd + '/package.json', JSON.stringify(pj, null, 2) + NL);
  }
  out('npm: added ' + added + ' package' + (added === 1 ? '' : 's'));
  return 0;
}

// The event loop cannot see native async work (DecompressionStream) it does not
// own, so it would treat this process as idle and exit before extraction ends.
// A ref'd interval keeps the loop turning while main() runs; that same interval
// is a loop-run callback, so calling process.exit() from it lets the loop catch
// the exit sentinel and honour the code.
let finished = false, code = 0;
const keepAlive = setInterval(function () {
  if (!finished) return;
  clearInterval(keepAlive);
  process.exit(code);
}, 15);
main().then(
  function (c) { code = c | 0; finished = true; },
  function (e) { err('npm error: ' + ((e && e.message) || e)); code = 1; finished = true; },
);
`;
