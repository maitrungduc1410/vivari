// load-real-tsgo — put the REAL TypeScript 7 compiler (tsgo, the Go rewrite) into
// the VFS and make `tsc` / `tsgo` on PATH resolve to it.
//
// Sibling of load-real-npm.js / load-real-corepack.js, and the browser-side
// counterpart to scripts/spike-tsgo.mjs. tsgo is compiled Go, delivered as one
// gzipped asset (built by scripts/vendor-tsgo.mjs; same archive layout) that
// contains `tsgo.wasm` (~47 MB, GOOS=js/GOARCH=wasm) plus `wasm_exec.cjs` (the Go
// engine extracted from the tsgo-wasm launcher). The kernel worker fetches it
// once and unpacks it here; the SAME functions are exercised headlessly by
// scripts/spike-tsgo-studio.mjs.
//
// How it runs on Path B: the Go `wasm_exec` glue drives everything through
// `globalThis.fs` — which is Node's real lib/fs.js over our Rust VFS — plus
// `globalThis.crypto.getRandomValues`, `performance.now`, `TextEncoder`, and
// `WebAssembly`, all of which the runtime already provides. The one shim we add:
// Go writes program output to fd 1/2 via `fs.writeSync` / `fs.write`, which the
// VFS fs doesn't wire to the terminal, so the runner routes those fds to
// process.stdout/stderr (everything else falls through to the real VFS fs).
//
// This is HUGE relative to npm/corepack (~11 MB gz), so the kernel worker loads it
// ON DEMAND — the first time `tsc`/`tsgo` is actually spawned (registered as a lazy
// program; see packages/core/src/workers/kernel-worker.ts + Kernel.ensureCommandLoaded).
// Boot pays nothing, and the tree persists in OPFS so a returning visitor's first
// use just re-applies the shims (only the very first origin visit pays the download).

export const TSGO_VFS_ROOT = "/usr/lib/tsgo";

// The runner that boots the Go wasm. Written into the VFS by the loader; the
// `/bin/tsc.js` + `/bin/tsgo.js` shims just `require` it. Kept as a string so the
// whole thing ships with the kernel host (no extra asset to fetch).
const TSGO_RUNNER = `// Vivari: tsgo (TypeScript 7, Go/wasm) runner — see load-real-tsgo.js.
const _fs = require('fs');
const path = require('path');

// Go writes program output to fd 1/2 via fs.writeSync / fs.write; the VFS fs
// doesn't wire those to the terminal, so route them to process.stdout/stderr and
// let everything else fall through (incl. fs.constants via the prototype chain).
const fs = Object.create(_fs);
const _toBuf = (b, off, len) => {
  const u = b && b.subarray ? b : Buffer.from(b);
  return (off != null || len != null) ? u.subarray(off || 0, (off || 0) + (len == null ? u.length : len)) : u;
};
fs.writeSync = function (fd, buf, ...rest) {
  if (fd === 1 || fd === 2) {
    const b = _toBuf(buf);
    (fd === 1 ? process.stdout : process.stderr).write(Buffer.from(b).toString('utf8'));
    return b.length;
  }
  return _fs.writeSync(fd, buf, ...rest);
};
fs.write = function (fd, buf, offset, length, position, cb) {
  if (fd === 1 || fd === 2) {
    const b = _toBuf(buf, typeof offset === 'number' ? offset : 0, typeof length === 'number' ? length : undefined);
    (fd === 1 ? process.stdout : process.stderr).write(Buffer.from(b).toString('utf8'));
    const done = typeof cb === 'function' ? cb : typeof position === 'function' ? position : typeof length === 'function' ? length : null;
    if (done) done(null, b.length, buf);
    return;
  }
  return _fs.write(fd, buf, offset, length, position, cb);
};

globalThis.fs = fs;
globalThis.path = path;
globalThis.require = require;
if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') {
  const _c = require('crypto');
  globalThis.crypto = { getRandomValues: (b) => { _c.randomFillSync(b); return b; } };
}
if (!globalThis.performance) globalThis.performance = { now: () => Date.now() };

const { Go } = require(${JSON.stringify(TSGO_VFS_ROOT + "/wasm_exec.cjs")});
const go = new Go();
// os.Args[0] is the program name; the rest are the user's tsc/tsgo flags.
go.argv = ['tsgo'].concat(process.argv.slice(2));
// Keep env TINY — Go's wasm_exec caps argv+env at ~12 KB of linear memory, and
// the shell env carries lots of npm_config_* noise the compiler doesn't need.
go.env = {
  TMPDIR: process.env.TMPDIR || '/tmp',
  HOME: process.env.HOME || '/home/user',
  PATH: process.env.PATH || '/bin',
};
go.exit = (code) => process.exit(code);
const bytes = _fs.readFileSync(${JSON.stringify(TSGO_VFS_ROOT + "/tsgo.wasm")});
WebAssembly.instantiate(bytes, go.importObject)
  .then((res) => go.run(res.instance))
  .catch((e) => { process.stderr.write(((e && e.stack) || String(e)) + '\\n'); process.exit(1); });
`;

// `tsc` and `tsgo` are the same binary for our purposes (tsgo mirrors tsc's CLI).
const TSC_SHIM = `require(${JSON.stringify(TSGO_VFS_ROOT + "/tsgo-run.js")});\n`;

/** True once the real tsgo tree is present in the VFS (e.g. restored from OPFS).
 *  Checks the wasm itself, not just a shim, so a half-written tree isn't mistaken
 *  for a complete one. */
export function hasRealTsgo(kernel) {
  return kernel.isFile(TSGO_VFS_ROOT + "/tsgo.wasm") && kernel.isFile(TSGO_VFS_ROOT + "/wasm_exec.cjs");
}

// gunzip via the platform-native DecompressionStream (browser workers + Node ≥ 18).
async function gunzip(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Decode the vendor asset into { version, files: [{ path, bytes }] }.
 * Layout: [u32le headerLen][headerJSON][file bytes ...] (all gzipped).
 */
export async function decodeTsgoPack(packBytes) {
  const raw = await gunzip(packBytes);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const headerLen = view.getUint32(0, true);
  const headerJson = new TextDecoder().decode(raw.subarray(4, 4 + headerLen));
  const header = JSON.parse(headerJson);
  const blobStart = 4 + headerLen;
  const files = header.files.map((f) => ({
    path: f.p,
    bytes: raw.subarray(blobStart + f.o, blobStart + f.o + f.l),
  }));
  return { version: header.version, files };
}

/**
 * Overwrite `/bin/tsc.js` + `/bin/tsgo.js` with the real runner shims and write
 * the runner. Safe to call on every boot (idempotent).
 */
export function applyRealTsgoShims(kernel) {
  kernel.writeFile(TSGO_VFS_ROOT + "/tsgo-run.js", TSGO_RUNNER);
  kernel.writeFile("/bin/tsc.js", TSC_SHIM);
  kernel.writeFile("/bin/tsgo.js", TSC_SHIM);
}

/**
 * Unpack the tsgo tree into the VFS and install the real shims. `packBytes` is the
 * gzipped vendor asset. The tree (one big wasm + the engine) is written in one
 * batched transfer.
 */
export async function loadRealTsgo(kernel, packBytes) {
  const { version, files } = await decodeTsgoPack(packBytes);
  await kernel.writeFilesBatch(files.map((f) => ({ path: TSGO_VFS_ROOT + "/" + f.path, bytes: f.bytes })));
  applyRealTsgoShims(kernel);
  return { version, fileCount: files.length };
}

/**
 * Ensure the real tsgo is active. If already in the VFS (OPFS-restored), just
 * (re)apply the shims — cheap. Otherwise fetch + unpack via `fetchPackBytes()`.
 * Returns a small status object, or null if the asset was unavailable (caller
 * simply has no `tsc`/`tsgo` on PATH).
 */
export async function ensureRealTsgo(kernel, fetchPackBytes) {
  kernel.mkdirp(TSGO_VFS_ROOT);
  if (hasRealTsgo(kernel)) {
    applyRealTsgoShims(kernel);
    return { version: null, fileCount: 0, restored: true };
  }
  const packBytes = await fetchPackBytes();
  if (!packBytes) return null;
  const res = await loadRealTsgo(kernel, packBytes);
  return { ...res, restored: false };
}
