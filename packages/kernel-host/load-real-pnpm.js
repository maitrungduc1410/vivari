// load-real-pnpm — put the REAL, unmodified pnpm CLI into the VFS and make `pnpm`
// (and `pnpx`) on PATH resolve to it.
//
// Sibling of load-real-npm.js / load-real-yarn.js. The browser-side counterpart to
// scripts/spike-pnpm.mjs: the pnpm tree is delivered as one gzipped asset (built by
// scripts/vendor-pnpm.mjs; same archive layout), fetched once by the kernel worker
// and unpacked into the VFS here. The SAME functions are exercised headlessly by
// scripts/spike-pnpm-studio.mjs.
//
// pnpm leans on things the other PMs don't: real worker_threads (dist/worker.js
// for fetch/extract) and a SYMLINKED node_modules (the VFS supports symlink /
// readlink / lstat). Hardlink/reflink CoW isn't available in our VFS, so the shell
// forces `--package-import-method=copy` via env (see kernel-worker openTerminal).
//
// Ordering: caller runs installCoreutils() FIRST, then ensureRealPnpm().

export const PNPM_VFS_ROOT = "/usr/lib/node_modules/pnpm";

// pnpm's dist/pnpm.cjs is a single ~8.8 MB bundle — bigger than the 1 MiB SAB
// window kernel.writeFile uses, so files ≥ this size go through the transferred
// writeLarge path (kernel.fs.writeLarge).
const LARGE_THRESHOLD = 512 * 1024;

// Thin shims on PATH. `node /bin/pnpm.js <args>` loads the real entry
// (bin/pnpm.cjs → dist/pnpm.cjs), which reads process.argv exactly like the
// spike's /run-pnpm.js wrapper proved. `pnpx` is pnpm's `dlx` alias.
const PNPM_SHIM = `// OpenContainer: real pnpm shim — see packages/kernel-host/load-real-pnpm.js.
require(${JSON.stringify(PNPM_VFS_ROOT + "/bin/pnpm.cjs")});
`;
const PNPX_SHIM = `// OpenContainer: real pnpx shim — see packages/kernel-host/load-real-pnpm.js.
require(${JSON.stringify(PNPM_VFS_ROOT + "/bin/pnpx.cjs")});
`;

/** True once the real pnpm tree is present in the VFS (e.g. restored from OPFS).
 *  Checks the big bundle, not just the tiny bin, so a half-written tree isn't
 *  mistaken for a complete one. */
export function hasRealPnpm(kernel) {
  return kernel.isFile(PNPM_VFS_ROOT + "/dist/pnpm.cjs");
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
export async function decodePnpmPack(packBytes) {
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
 * Overwrite /bin/pnpm.js and /bin/pnpx.js so the shell resolves the real CLI.
 * Safe to call on every boot (idempotent).
 */
export function applyRealPnpmShims(kernel) {
  kernel.writeFile("/bin/pnpm.js", PNPM_SHIM);
  kernel.writeFile("/bin/pnpx.js", PNPX_SHIM);
}

/**
 * Unpack the pnpm tree into the VFS and install the shims. `packBytes` is the
 * gzipped vendor asset. Large files (dist/pnpm.cjs) use the async writeLarge
 * transfer path; the rest use the sync SAB writeFile.
 */
export async function loadRealPnpm(kernel, packBytes) {
  const { version, files } = await decodePnpmPack(packBytes);
  const madeDirs = new Set();
  for (const f of files) {
    const abs = PNPM_VFS_ROOT + "/" + f.path;
    const slash = abs.lastIndexOf("/");
    const dir = abs.slice(0, slash);
    if (!madeDirs.has(dir)) {
      kernel.mkdirp(dir);
      madeDirs.add(dir);
    }
    if (f.bytes.length >= LARGE_THRESHOLD) await kernel.fs.writeLarge(abs, f.bytes);
    else kernel.writeFile(abs, f.bytes);
  }
  applyRealPnpmShims(kernel);
  return { version, fileCount: files.length };
}

/**
 * Ensure the real pnpm is active. If already in the VFS (OPFS-restored), just
 * (re)apply the shims — cheap. Otherwise fetch + unpack via `fetchPackBytes()`.
 * Returns a small status object, or null if the asset was unavailable (caller
 * simply has no `pnpm` on PATH).
 */
export async function ensureRealPnpm(kernel, fetchPackBytes) {
  if (hasRealPnpm(kernel)) {
    applyRealPnpmShims(kernel);
    return { version: null, fileCount: 0, restored: true };
  }
  const packBytes = await fetchPackBytes();
  if (!packBytes) return null;
  const res = await loadRealPnpm(kernel, packBytes);
  return { ...res, restored: false };
}
