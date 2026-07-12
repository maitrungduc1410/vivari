// load-real-yarn — put the REAL, unmodified yarn (classic) CLI into the VFS and
// make `yarn` (and `yarnpkg`) on PATH resolve to it.
//
// Sibling of load-real-npm.js. The browser-side counterpart to what
// scripts/spike-yarn.mjs did off the host disk: the yarn tree is delivered as one
// gzipped asset (built by scripts/vendor-yarn.mjs; same archive layout as npm),
// fetched once by the kernel worker and unpacked straight into the VFS here. The
// SAME functions are exercised headlessly by scripts/spike-yarn-studio.mjs, so
// the exact code path studio ships is what gets verified.
//
// Ordering matters (installCoreutils writes coreutils to /bin each boot): the
// caller must run installCoreutils() FIRST, then ensureRealYarn() so the shim
// at /bin/yarn.js wins on PATH.

export const YARN_VFS_ROOT = "/usr/lib/node_modules/yarn";

// yarn's lib/cli.js is a single ~5 MB webpack bundle — bigger than the 1 MiB SAB
// window kernel.writeFile uses, so files at/above this size go through the
// transferred writeLarge path (kernel.fs.writeLarge), like fetched tarballs.
const LARGE_THRESHOLD = 512 * 1024;

// Thin shims installed on PATH. `node /bin/yarn.js <args>` just loads the real
// entry (bin/yarn.js → lib/cli.js), which reads process.argv exactly like the
// spike's /run-yarn.js wrapper proved on Path B. `yarnpkg` is yarn's own alias.
const YARN_SHIM = `// OpenContainer: real yarn shim — see packages/kernel-host/load-real-yarn.js.
require(${JSON.stringify(YARN_VFS_ROOT + "/bin/yarn.js")});
`;

/** True once the real yarn tree is present in the VFS (e.g. restored from OPFS).
 *  Checks the big bundle, not just bin/yarn.js, so a half-written tree isn't
 *  mistaken for a complete one. */
export function hasRealYarn(kernel) {
  return kernel.isFile(YARN_VFS_ROOT + "/lib/cli.js");
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
export async function decodeYarnPack(packBytes) {
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
 * Overwrite /bin/yarn.js and /bin/yarnpkg.js so the shell resolves the real CLI.
 * Safe to call on every boot (idempotent).
 */
export function applyRealYarnShims(kernel) {
  kernel.writeFile("/bin/yarn.js", YARN_SHIM);
  kernel.writeFile("/bin/yarnpkg.js", YARN_SHIM);
}

/**
 * Unpack the yarn tree into the VFS and install the shims. `packBytes` is the
 * gzipped vendor asset (Uint8Array/ArrayBuffer). Large files (cli.js) use the
 * async writeLarge transfer path; the rest use the sync SAB writeFile.
 */
export async function loadRealYarn(kernel, packBytes) {
  const { version, files } = await decodeYarnPack(packBytes);
  const madeDirs = new Set();
  for (const f of files) {
    const abs = YARN_VFS_ROOT + "/" + f.path;
    const slash = abs.lastIndexOf("/");
    const dir = abs.slice(0, slash);
    if (!madeDirs.has(dir)) {
      kernel.mkdirp(dir);
      madeDirs.add(dir);
    }
    if (f.bytes.length >= LARGE_THRESHOLD) await kernel.fs.writeLarge(abs, f.bytes);
    else kernel.writeFile(abs, f.bytes);
  }
  applyRealYarnShims(kernel);
  return { version, fileCount: files.length };
}

/**
 * Ensure the real yarn is active. If already in the VFS (OPFS-restored), just
 * (re)apply the shims — cheap. Otherwise fetch + unpack via `fetchPackBytes()`.
 * Returns a small status object, or null if the asset was unavailable (caller
 * simply has no `yarn` on PATH, exactly as before this feature).
 */
export async function ensureRealYarn(kernel, fetchPackBytes) {
  if (hasRealYarn(kernel)) {
    applyRealYarnShims(kernel);
    return { version: null, fileCount: 0, restored: true };
  }
  const packBytes = await fetchPackBytes();
  if (!packBytes) return null;
  const res = await loadRealYarn(kernel, packBytes);
  return { ...res, restored: false };
}
