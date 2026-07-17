// Vivari toolchain shims — the single source of truth for running NATIVE
// developer-toolchain packages inside the browser VM transparently, with ZERO
// per-project configuration (no package.json "overrides", no launcher script).
//
// Two cooperating mechanisms make up this subsystem:
//
//   1. Registry-level native->drop-in aliasing (two tables below). The Fetcher
//      Worker (packages/core/src/workers/fetcher-worker.ts) imports them and, when
//      npm asks for a SOURCE package's packument, serves the TARGET's instead —
//      StackBlitz-style, with the project's package.json left pristine. Two
//      contracts, in decreasing strictness:
//        a. NATIVE_WASM_ALIASES — LOCKSTEP renames. `source` and `target` publish
//           identical version numbers, so the target's packument is served verbatim
//           under the source name and any semver range resolves cleanly.
//        b. NATIVE_DROPIN_ALIASES — API-compatible drop-ins whose versions are NOT
//           lockstep (e.g. bcrypt 6.x vs bcryptjs 3.x). Here the packument is
//           VERSION-REMAPPED (synthesizeRemappedPackument, below): the SOURCE's
//           version list + dist-tags are kept (so any `source@<range>` resolves)
//           but each entry's tarball/deps come from the TARGET's latest.
//
//   2. The in-process esbuild service (packages/runtime/esbuild-inproc-patch.js),
//      applied by the CommonJS module loader. It rewrites esbuild-wasm's child-
//      spawn transport to run the Go wasm in-thread so it can't deadlock under a
//      worker pool (Angular/Vite/Vitest/tsup). See that file.
//
// TO ADD A NEW DROP-IN, append a { source: target } entry to NATIVE_WASM_ALIASES.
// REQUIREMENTS (all must hold, else DO NOT alias here):
//   - `source` and `target` are published in LOCKSTEP (identical version numbers),
//     so a semver range on `source` resolves cleanly against `target`'s versions.
//   - `target` is a pure-JS/wasm build with no native (non-wasm) dependencies.
//   - the pairing is proven by a headless spike (scripts/spike-*.mjs) before shipping.

/**
 * Native package name -> its official, API-compatible WASM drop-in package name.
 * Consumed by packages/studio/src/workers/fetcher-worker.js (registry packument aliasing).
 * @type {Record<string, string>}
 */
export const NATIVE_WASM_ALIASES = {
  // esbuild ships a Go binary with no wasm32 build; esbuild-wasm is the official
  // WASM drop-in, released in lockstep. Combined with the in-process patch it runs
  // deadlock-free under worker pools.
  esbuild: "esbuild-wasm",
  // Rollup's native binary (@rollup/rollup-<platform>, SWC-based) has no wasm32
  // build; @rollup/wasm-node is Rollup's official WASM build, released in lockstep.
  rollup: "@rollup/wasm-node",
};

/**
 * Native package name -> an API-compatible drop-in whose versions are NOT
 * published in lockstep with the source. Consumed by the Fetcher Worker via
 * synthesizeRemappedPackument (registry packument VERSION-remapping).
 *
 * TO ADD A NEW DROP-IN, append a { source: target } entry.
 * REQUIREMENTS (all must hold, else DO NOT alias here):
 *   - `target` is API-compatible with `source` (a genuine drop-in: same public
 *     surface the ecosystem relies on), pure-JS/wasm, with NO native deps.
 *   - the pairing is proven by an offline spike (scripts/spike-*.mjs) AND a live
 *     browser install before shipping.
 * NOTE the weaker contract vs NATIVE_WASM_ALIASES: because versions differ, a
 * `source@<range>` resolves to a SOURCE version number but downloads the TARGET's
 * latest tarball — acceptable for a stable, API-compatible drop-in.
 * @type {Record<string, string>}
 */
export const NATIVE_DROPIN_ALIASES = {
  // The native `bcrypt` (kelektiv/node.bcrypt.js, node-pre-gyp) has no wasm build;
  // `bcryptjs` is a zero-dependency pure-JS reimplementation that is API-compatible
  // (hash/hashSync/compare/compareSync/genSalt/getRounds, sync + async). Versions
  // are unrelated (bcrypt 6.x vs bcryptjs 3.x), so we version-remap.
  bcrypt: "bcryptjs",
};

/**
 * Build a packument for a version-remapped drop-in (NATIVE_DROPIN_ALIASES): keep
 * the SOURCE's version numbers + dist-tags (so any `source@<range>` resolves, since
 * npm.js runs semver.maxSatisfying over meta.versions), but point every version at
 * the TARGET's latest tarball + deps and drop native-install metadata. The single
 * target tarball is shared by every synthesized entry; npm.js verifies no integrity,
 * so this installs cleanly and `require('<source>')` loads the target's files.
 *
 * @param {any} sourceJson  the source package's real packument (for versions/tags)
 * @param {any} targetJson  the target package's real packument (for the tarball/deps)
 * @param {string} src      the source name to present the packument under
 * @returns {any|null} the synthesized packument, or null if either input is unusable
 */
export function synthesizeRemappedPackument(sourceJson, targetJson, src) {
  if (!sourceJson || typeof sourceJson !== "object") return null;
  if (!targetJson || typeof targetJson !== "object") return null;
  const srcVersions = sourceJson.versions;
  const tgtVersions = targetJson.versions;
  const tgtTags = targetJson["dist-tags"] || {};
  const targetLatest = tgtTags.latest || (tgtVersions && Object.keys(tgtVersions).pop());
  if (!srcVersions || typeof srcVersions !== "object") return null;
  if (!tgtVersions || typeof tgtVersions !== "object") return null;
  const tgtManifest = tgtVersions[targetLatest];
  if (!tgtManifest || !tgtManifest.dist || !tgtManifest.dist.tarball) return null;

  const versions = {};
  for (const v of Object.keys(srcVersions)) {
    // Take everything runtime-relevant from the target's latest manifest; only the
    // identity (name/version) is the source's. Native-install metadata (scripts,
    // optionalDependencies, os, cpu) is deliberately omitted so no node-pre-gyp /
    // platform-package resolution is attempted in-VM.
    versions[v] = {
      name: src,
      version: v,
      dist: tgtManifest.dist,
      dependencies: tgtManifest.dependencies || {},
      ...(tgtManifest.main ? { main: tgtManifest.main } : {}),
      ...(tgtManifest.module ? { module: tgtManifest.module } : {}),
      ...(tgtManifest.exports ? { exports: tgtManifest.exports } : {}),
      ...(tgtManifest.bin ? { bin: tgtManifest.bin } : {}),
      ...(tgtManifest.type ? { type: tgtManifest.type } : {}),
      ...(tgtManifest.engines ? { engines: tgtManifest.engines } : {}),
      _id: src + "@" + v,
    };
  }

  return {
    name: src,
    _id: src,
    "dist-tags": sourceJson["dist-tags"] || {},
    versions,
  };
}
