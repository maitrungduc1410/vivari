// load-real-npm — put the REAL, unmodified npm CLI into the VFS and make `npm`
// (and `npx`) on PATH resolve to it. This is the ONLY npm in the shipped product:
// the Turbo-analog `programs/npm.js` is retired (it lives on only as an offline
// verify-node fixture).
//
// This is the browser-side counterpart to what scripts/spike-npm.mjs did off the
// host disk. The npm tree is delivered as one gzipped asset (built by
// scripts/vendor-npm.mjs; see that file for the archive layout), fetched once by
// the kernel worker and unpacked straight into the VFS here.
//
// The SAME functions are exercised headlessly by scripts/spike-npm-studio.mjs,
// so the exact code path that studio ships is what gets verified.
//
// Ordering: the caller runs installCoreutils() FIRST (node/sh/npx/etc), then
// ensureRealNpm() to install the /bin/npm.js + /bin/npx.js shims.

import { stubNodeGyp } from "./node-gyp-stub.js";

export const NPM_VFS_ROOT = "/usr/lib/node_modules/npm";

// Thin shims installed on PATH. `node /bin/npm.js <args>` just loads the real
// CLI; npm-cli.js reads process.argv (argv[1] = /bin/npm.js, rest = its args),
// exactly like the spike's /run-npm.js wrapper proved on Path B.
const NPM_SHIM = `// Vivari: real npm shim — see packages/kernel-host/load-real-npm.js.
require(${JSON.stringify(NPM_VFS_ROOT + "/bin/npm-cli.js")});
`;
const NPX_SHIM = `// Vivari: real npx shim — see packages/kernel-host/load-real-npm.js.
require(${JSON.stringify(NPM_VFS_ROOT + "/bin/npx-cli.js")});
`;

/** True once the real npm tree is present in the VFS (e.g. restored from OPFS). */
export function hasRealNpm(kernel) {
  return kernel.isFile(NPM_VFS_ROOT + "/bin/npm-cli.js");
}

// gunzip via the platform-native DecompressionStream (present in browser workers
// and Node >= 18) — no extra dep, and identical bytes in both environments.
async function gunzip(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Decode the vendor asset into { version, files: [{ path, bytes }] }.
 * Layout: [u32le headerLen][headerJSON][file bytes ...] (all gzipped).
 */
export async function decodeNpmPack(packBytes) {
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
 * Write /bin/npm.js and /bin/npx.js so the shell resolves the real CLI.
 * Safe to call on every boot (idempotent).
 */
export function applyRealNpmShims(kernel) {
  kernel.writeFile("/bin/npm.js", NPM_SHIM);
  kernel.writeFile("/bin/npx.js", NPX_SHIM);
}

/**
 * Unpack the npm tree into the VFS, neutralize node-gyp, and install the shims.
 * `packBytes` is the gzipped vendor asset (Uint8Array/ArrayBuffer).
 */
export async function loadRealNpm(kernel, packBytes) {
  const { version, files } = await decodeNpmPack(packBytes);
  // One batched transfer instead of ~2400 per-file SAB round-trips — the FS
  // Worker mkdirp's parents and writes every file in a single message. This is
  // the dominant cost of cold boot, so it's the big win of the write-storm batch.
  await kernel.writeFilesBatch(files.map((f) => ({ path: NPM_VFS_ROOT + "/" + f.path, bytes: f.bytes })));
  // Native addon builds can't run in-browser — make node-gyp a non-fatal no-op
  // (see node-gyp-stub.js) so a native package's install lifecycle still passes.
  const stubbed = stubNodeGyp(kernel, NPM_VFS_ROOT);
  applyRealNpmShims(kernel);
  return { version, fileCount: files.length, nodeGypStubbed: stubbed.length };
}

/**
 * Ensure the real npm is active. If already in the VFS (OPFS-restored), just
 * (re)apply the shims — cheap. Otherwise fetch + unpack via `fetchPackBytes()`.
 * Returns a small status object, or null if the asset was unavailable (in which
 * case the shell simply has no `npm` on PATH — there is no analog fallback).
 */
export async function ensureRealNpm(kernel, fetchPackBytes) {
  if (hasRealNpm(kernel)) {
    applyRealNpmShims(kernel);
    return { version: null, fileCount: 0, nodeGypStubbed: 0, restored: true };
  }
  const packBytes = await fetchPackBytes();
  if (!packBytes) return null;
  const res = await loadRealNpm(kernel, packBytes);
  return { ...res, restored: false };
}
