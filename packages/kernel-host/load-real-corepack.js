// load-real-corepack — put the REAL, unmodified corepack into the VFS and make
// `corepack` on PATH resolve to it.
//
// Sibling of load-real-npm.js / load-real-yarn.js / load-real-pnpm.js, and the
// browser-side counterpart to scripts/spike-corepack.mjs: the corepack tree is
// delivered as one gzipped asset (built by scripts/vendor-corepack.mjs; same
// archive layout), fetched once by the kernel worker and unpacked into the VFS
// here. The SAME functions are exercised headlessly by
// scripts/spike-corepack-studio.mjs.
//
// Unlike npm/yarn/pnpm, corepack is a VERSION MANAGER, not a package manager: it
// reads a project's `packageManager` field, DOWNLOADS that exact yarn/pnpm/npm
// release (gunzip + untar + sha512 integrity), and execs it. So we install ONLY a
// `/bin/corepack.js` shim and deliberately DO NOT touch the direct `/bin/{npm,
// yarn,pnpm}.js` shims the other loaders install — those stay the default tools;
// corepack is the extra "run a project-pinned version" path (`corepack yarn ...`,
// `corepack use pnpm@x`, `corepack prepare ... --activate`).
//
// Two browser-shaped notes (mirrored by the shell env in kernel-worker):
//   - corepack verifies the registry's ECDSA signature, which our crypto layer
//     can't do (no crypto.verify) — so the shell sets COREPACK_INTEGRITY_KEYS=0,
//     corepack's official escape hatch. The sha512 tarball integrity check
//     (crypto.createHash) still runs.
//   - corepack downloads via the global `fetch()` and streams the body through
//     Readable.fromWeb (implemented in internal/webstreams/adapters.js); the
//     reader promises ref the event loop (see runtime index.js) so a download
//     doesn't race the loop to exit.
//
// Ordering: caller runs installCoreutils() + the npm/yarn/pnpm loaders FIRST, then
// ensureRealCorepack().

export const COREPACK_VFS_ROOT = "/usr/lib/node_modules/corepack";

// Thin shim on PATH. `node /bin/corepack.js <args>` loads the real entry
// (dist/corepack.js), which reads process.argv exactly like the spike wrapper
// proved.
const COREPACK_SHIM = `// OpenContainer: real corepack shim — see packages/kernel-host/load-real-corepack.js.
require(${JSON.stringify(COREPACK_VFS_ROOT + "/dist/corepack.js")});
`;

/** True once the real corepack tree is present in the VFS (e.g. restored from
 *  OPFS). Checks the bundle, not just the tiny entry, so a half-written tree
 *  isn't mistaken for a complete one. */
export function hasRealCorepack(kernel) {
  return kernel.isFile(COREPACK_VFS_ROOT + "/dist/lib/corepack.cjs");
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
export async function decodeCorepackPack(packBytes) {
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
 * Overwrite /bin/corepack.js so the shell resolves the real CLI.
 * Safe to call on every boot (idempotent).
 */
export function applyRealCorepackShims(kernel) {
  kernel.writeFile("/bin/corepack.js", COREPACK_SHIM);
}

/**
 * Unpack the corepack tree into the VFS and install the shim. `packBytes` is the
 * gzipped vendor asset. The whole tree is written in one batched transfer.
 */
export async function loadRealCorepack(kernel, packBytes) {
  const { version, files } = await decodeCorepackPack(packBytes);
  await kernel.writeFilesBatch(files.map((f) => ({ path: COREPACK_VFS_ROOT + "/" + f.path, bytes: f.bytes })));
  applyRealCorepackShims(kernel);
  return { version, fileCount: files.length };
}

/**
 * Ensure the real corepack is active. If already in the VFS (OPFS-restored), just
 * (re)apply the shim — cheap. Otherwise fetch + unpack via `fetchPackBytes()`.
 * Returns a small status object, or null if the asset was unavailable (caller
 * simply has no `corepack` on PATH).
 */
export async function ensureRealCorepack(kernel, fetchPackBytes) {
  if (hasRealCorepack(kernel)) {
    applyRealCorepackShims(kernel);
    return { version: null, fileCount: 0, restored: true };
  }
  const packBytes = await fetchPackBytes();
  if (!packBytes) return null;
  const res = await loadRealCorepack(kernel, packBytes);
  return { ...res, restored: false };
}
