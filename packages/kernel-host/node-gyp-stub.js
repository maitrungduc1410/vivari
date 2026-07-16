// node-gyp stub (package-managers North Star).
//
// Native (C/C++) addons can't be built in the browser sandbox: there is no
// compiler toolchain (python/make/gcc), and a `.node` binary couldn't be loaded
// anyway (we run wasm, not native). Real npm, however, runs a package's
// `install`/`rebuild` lifecycle script — which for native packages is
// `node-gyp rebuild` — and a NON-ZERO exit there aborts the whole `npm install`.
//
// To keep installs working we make node-gyp a non-fatal no-op: the build is
// skipped and the script "succeeds". This mirrors how browser WebContainers
// handle native deps — the package's JS fallback (or its wasm32-wasi build,
// auto-selected via optionalDependencies) is what actually loads at runtime.
//
// npm resolves the `node-gyp` command to a shell shim it puts on PATH
// (`.../node-gyp-bin/node-gyp`, which execs either its bundled node-gyp or
// `$npm_config_node_gyp`). Our runtime can't execute that POSIX shell shim (it
// compiles programs as JS), so instead we OVERWRITE the shim — and the bundled
// node-gyp entry — in the vendored npm tree with this JS stub. It carries a
// `#!/usr/bin/env node` line (the loader neutralizes shebangs) so it runs as a
// plain Node program regardless of the file's original extension.

export const NODE_GYP_STUB = `#!/usr/bin/env node
// Vivari node-gyp stub — see packages/kernel-host/node-gyp-stub.js.
const argv = process.argv.slice(2);
const verb = argv.find((a) => a && a[0] !== '-') || '';
// \`node-gyp --version\` is probed by some tooling; answer it plausibly.
if (argv.includes('-v') || argv.includes('--version')) {
  process.stdout.write('v11.0.0\\n');
  process.exit(0);
}
process.stderr.write(
  'node-gyp (Vivari stub): skipping native build' +
    (verb ? ' \\'' + verb + '\\'' : '') +
    ' — native addons are not supported in-browser; using the package\\'s JS/wasm fallback\\n',
);
process.exit(0);
`;

// The node-gyp entry points inside a vendored real-npm tree, relative to its
// root (e.g. /usr/lib/node_modules/npm). We overwrite whichever exist.
export const NODE_GYP_TARGETS = (npmRoot) => [
  // npm adds THIS dir to PATH when running lifecycle scripts (run-script/set-path).
  npmRoot + "/node_modules/@npmcli/run-script/lib/node-gyp-bin/node-gyp",
  // npm's own CLI shim dir (older layout / direct callers).
  npmRoot + "/bin/node-gyp-bin/node-gyp",
  // The bundled node-gyp the shim execs when $npm_config_node_gyp is unset.
  npmRoot + "/node_modules/node-gyp/bin/node-gyp.js",
];

/**
 * Neutralize node-gyp inside a vendored real-npm tree so native builds become a
 * non-fatal no-op. Call after loading npm into the VFS, before running installs.
 *
 * @param kernel  a Kernel (uses its `exists`/`writeFile` VFS helpers)
 * @param npmRoot absolute VFS path to the npm package root
 * @returns the list of paths that were stubbed
 */
export function stubNodeGyp(kernel, npmRoot) {
  const stubbed = [];
  for (const target of NODE_GYP_TARGETS(npmRoot)) {
    if (kernel.exists(target)) {
      kernel.writeFile(target, NODE_GYP_STUB);
      stubbed.push(target);
    }
  }
  return stubbed;
}
