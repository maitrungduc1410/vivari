// Vivari toolchain shims — the single source of truth for running NATIVE
// developer-toolchain packages inside the browser VM transparently, with ZERO
// per-project configuration (no package.json "overrides", no launcher script).
//
// Two cooperating mechanisms make up this subsystem:
//
//   1. Registry-level native->wasm aliasing (NATIVE_WASM_ALIASES, below).
//      Some tools ship no wasm32 native build; their official WASM drop-in is a
//      DIFFERENTLY-NAMED package that npm's platform auto-select can never reach.
//      The Fetcher Worker (packages/studio/src/workers/fetcher-worker.js) imports this table and
//      serves the TARGET's packument under the SOURCE name, so `npm install esbuild`
//      transparently downloads esbuild-wasm's tarball into node_modules/esbuild —
//      StackBlitz-style, with the project's package.json left pristine.
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
