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

// ---- minimal semver: caret / tilde / exact / x-range / dist-tag -------------
function parseVer(v) {
  v = String(v).trim();
  const plus = v.indexOf('+'); if (plus >= 0) v = v.slice(0, plus);
  let pre = ''; const dash = v.indexOf('-'); if (dash >= 0) { pre = v.slice(dash + 1); v = v.slice(0, dash); }
  const p = v.split('.');
  return { major: parseInt(p[0], 10) || 0, minor: parseInt(p[1], 10) || 0, patch: parseInt(p[2], 10) || 0, pre: pre };
}
function cmp(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (!a.pre && b.pre) return 1;
  if (a.pre && !b.pre) return -1;
  if (a.pre < b.pre) return -1;
  if (a.pre > b.pre) return 1;
  return 0;
}
function caretOk(v, b) {
  if (cmp(v, b) < 0) return false;
  if (b.major > 0) return v.major === b.major;
  if (b.minor > 0) return v.major === 0 && v.minor === b.minor;
  return v.major === 0 && v.minor === 0 && v.patch === b.patch;
}
function tildeOk(v, b) {
  if (cmp(v, b) < 0) return false;
  return v.major === b.major && v.minor === b.minor;
}
function xRangeOk(v, range) {
  const p = range.split('.');
  const p0 = p[0];
  if (p0 === undefined || p0 === '' || p0 === '*' || p0 === 'x' || p0 === 'X') return true;
  if (parseInt(p0, 10) !== v.major) return false;
  const p1 = p[1];
  if (p1 === undefined || p1 === '*' || p1 === 'x' || p1 === 'X') return true;
  if (parseInt(p1, 10) !== v.minor) return false;
  const p2 = p[2];
  if (p2 === undefined || p2 === '*' || p2 === 'x' || p2 === 'X') return true;
  return parseInt(p2, 10) === v.patch;
}
function satisfies(ver, range) {
  range = String(range).trim();
  if (range === '' || range === '*' || range === 'x' || range === 'X' || range === 'latest') return true;
  if (range[0] === '=' || range[0] === 'v') range = range.slice(1).trim();
  const v = parseVer(ver);
  if (range[0] === '^') return caretOk(v, parseVer(range.slice(1)));
  if (range[0] === '~') return tildeOk(v, parseVer(range.slice(1)));
  if (range.indexOf('x') >= 0 || range.indexOf('X') >= 0 || range.split('.').length < 3) return xRangeOk(v, range);
  return cmp(v, parseVer(range)) === 0;
}
function pickVersion(meta, range) {
  const dt = meta['dist-tags'] || {};
  range = String(range).trim();
  if (range === '' || range === '*' || range === 'latest') { if (dt.latest) return dt.latest; }
  if (dt[range]) return dt[range];
  const all = Object.keys(meta.versions || {});
  let best = null, bestP = null;
  for (let i = 0; i < all.length; i++) {
    const ver = all[i];
    if (satisfies(ver, range)) {
      const pv = parseVer(ver);
      if (!best || cmp(pv, bestP) > 0) { best = ver; bestP = pv; }
    }
  }
  return best;
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

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd !== 'install' && cmd !== 'i' && cmd !== 'add') {
    err('usage: npm install [package[@version] ...]');
    return 1;
  }
  const cwd = process.cwd();
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
