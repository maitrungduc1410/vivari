// Spike (OFFLINE, fast): guard the toolchain-generalization subsystem so a silent
// regression (esbuild-wasm version drift, or a broken native->wasm alias table)
// is caught in CI instead of surfacing as a mysterious in-browser build hang.
//
// Gates (all must pass):
//   1. NATIVE_WASM_ALIASES contains the expected native->wasm drop-ins.
//   2. The in-process esbuild patch APPLIES to the known esbuild-wasm@0.28.1
//      spawn block (produces the OC marker + the in-thread Go service).
//   3. It is VERSION-AGNOSTIC: the same block shape with a different version
//      literal still patches, threading that version into --service.
//   4. It is a strict no-op for a genuine NATIVE esbuild install (no wasm assets).
//   5. On block-shape DRIFT it warns loudly and returns null (fail loud, not silent).
//   6. NATIVE_DROPIN_ALIASES + synthesizeRemappedPackument version-remap a
//      non-lockstep drop-in (bcrypt -> bcryptjs) correctly.
//
//   run:  node scripts/spike-toolchain.mjs

import path from "node:path";
import { maybePatchEsbuildInProcess } from "../packages/runtime/esbuild-inproc-patch.js";
import {
  NATIVE_WASM_ALIASES,
  NATIVE_DROPIN_ALIASES,
  synthesizeRemappedPackument,
} from "../packages/runtime/toolchain-shims.js";

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ok   " : "  FAIL ") + msg);
  if (!cond) failures++;
};

// The exact child-spawn block esbuild-wasm ships in lib/main.js (0.28.1). The
// %VER% below is filled per-test to synthesize different releases.
const SPAWN_BLOCK = (ver) => `  let [command, args] = esbuildCommandAndArgs();
  let child = child_process.spawn(command, args.concat(\`--service=\${"${ver}"}\`, "--ping"), {
    windowsHide: true,
    stdio: ["pipe", "pipe", "inherit"],
    cwd: defaultWD
  });
  let { readFromStdout, afterClose, service } = createChannel({
    writeToStdin(bytes) {
      child.stdin.write(bytes, (err) => {
        if (err) afterClose(err);
      });
    },
    readFileSync: fs2.readFileSync,
    isSync: false,
    hasFS: true,
    esbuild: node_exports
  });
  child.stdin.on("error", afterClose);
  child.on("error", afterClose);
  const stdin = child.stdin;
  const stdout = child.stdout;
  stdout.on("data", readFromStdout);
  stdout.on("end", afterClose);
  stopService = () => {
    stdin.destroy();
    stdout.destroy();
    child.kill();
    initializeWasCalled = false;
    longLivedService = void 0;
    stopService = void 0;
  };
  let refCount = 0;
  child.unref();
  if (stdin.unref) {
    stdin.unref();
  }
  if (stdout.unref) {
    stdout.unref();
  }
  const refs = {
    ref() {
      if (++refCount === 1) child.ref();
    },
    unref() {
      if (--refCount === 0) child.unref();
    }
  };`;

const wrap = (block) => `"use strict";\nfunction ensureServiceIsRunning() {\n${block}\n  return service;\n}\n`;

// A mock fs whose existsSync answers per a set of "present" paths.
const mockFs = (present) => ({ existsSync: (p) => present.has(p) });
const MAIN = "/app/node_modules/esbuild/lib/main.js";
const PKG = "/app/node_modules/esbuild"; // where esbuild.wasm + wasm_exec.js live
const wasmPresent = mockFs(new Set([path.join(PKG, "esbuild.wasm"), path.join(PKG, "wasm_exec.js")]));
const noWasm = mockFs(new Set());

// --- 1. alias table -----------------------------------------------------------
ok(NATIVE_WASM_ALIASES.esbuild === "esbuild-wasm", "alias esbuild -> esbuild-wasm");
ok(NATIVE_WASM_ALIASES.rollup === "@rollup/wasm-node", "alias rollup -> @rollup/wasm-node");
ok(NATIVE_WASM_ALIASES.lightningcss === "lightningcss-wasm", "alias lightningcss -> lightningcss-wasm");

// --- 2. patch applies to the known block --------------------------------------
const patched = maybePatchEsbuildInProcess(wrap(SPAWN_BLOCK("0.28.1")), MAIN, wasmPresent, path);
ok(patched != null, "patch returns a rewritten source for esbuild-wasm@0.28.1");
ok(patched != null && patched.includes("[Vivari] in-process esbuild service"), "rewrite carries the OC marker");
ok(patched != null && !patched.includes('child_process.spawn(command'), "child spawn removed");
ok(patched != null && patched.includes('--service=${"0.28.1"}'), "version 0.28.1 threaded into --service");

// idempotent: patching the patched source again is a no-op
ok(maybePatchEsbuildInProcess(patched, MAIN, wasmPresent, path) === null, "already-patched source is a no-op");

// --- 3. version-agnostic ------------------------------------------------------
const patched2 = maybePatchEsbuildInProcess(wrap(SPAWN_BLOCK("0.29.7")), MAIN, wasmPresent, path);
ok(patched2 != null, "patch applies to a different version (0.29.7) with same block shape");
ok(patched2 != null && patched2.includes('--service=${"0.29.7"}'), "captured version 0.29.7 threaded into --service");

// --- 4. native esbuild left untouched ----------------------------------------
ok(
  maybePatchEsbuildInProcess(wrap(SPAWN_BLOCK("0.28.1")), MAIN, noWasm, path) === null,
  "native esbuild (no wasm assets) left untouched",
);

// --- 5. drift warns loudly and returns null -----------------------------------
const drifted = wrap(SPAWN_BLOCK("0.28.1").replace("child_process.spawn(command", "child_process.fork(command"));
let warned = false;
const origWarn = console.warn;
console.warn = (...a) => {
  if (String(a[0]).includes("in-process patch did NOT apply")) warned = true;
};
const driftResult = maybePatchEsbuildInProcess(drifted, MAIN, wasmPresent, path);
console.warn = origWarn;
ok(driftResult === null, "drifted block returns null (no silent patch)");
ok(warned, "drifted block warns loudly");

// --- 6. non-lockstep drop-in: version-remapped packument ----------------------
ok(NATIVE_DROPIN_ALIASES.bcrypt === "bcryptjs", "drop-in alias bcrypt -> bcryptjs");

// Mock the two real packuments: a native `bcrypt` (node-pre-gyp, native deps,
// install scripts, cpu/os gating) and a pure-JS `bcryptjs` (zero deps).
const bcryptPack = {
  name: "bcrypt",
  _id: "bcrypt",
  "dist-tags": { latest: "6.0.0" },
  versions: {
    "5.1.1": {
      name: "bcrypt",
      version: "5.1.1",
      dist: { tarball: "https://reg/bcrypt/-/bcrypt-5.1.1.tgz" },
      dependencies: { "@mapbox/node-pre-gyp": "^1.0.11", "node-addon-api": "^5.0.0" },
      optionalDependencies: {},
      scripts: { install: "node-pre-gyp install --fallback-to-build" },
      cpu: ["x64", "arm64"],
      os: ["linux", "darwin", "win32"],
    },
    "6.0.0": {
      name: "bcrypt",
      version: "6.0.0",
      dist: { tarball: "https://reg/bcrypt/-/bcrypt-6.0.0.tgz" },
      dependencies: { "@mapbox/node-pre-gyp": "^2.0.0", "node-addon-api": "^8.3.0" },
      scripts: { install: "node-pre-gyp install --fallback-to-build" },
    },
  },
};
const bcryptjsPack = {
  name: "bcryptjs",
  _id: "bcryptjs",
  "dist-tags": { latest: "3.0.3" },
  versions: {
    "3.0.3": {
      name: "bcryptjs",
      version: "3.0.3",
      dist: { tarball: "https://reg/bcryptjs/-/bcryptjs-3.0.3.tgz" },
      dependencies: {},
      main: "index.js",
      type: "module",
    },
  },
};

const synth = synthesizeRemappedPackument(bcryptPack, bcryptjsPack, "bcrypt");
ok(synth != null, "remap: synthesizes a packument");
ok(synth != null && synth.name === "bcrypt", "remap: served under the source name (bcrypt)");
ok(synth != null && synth["dist-tags"].latest === "6.0.0", "remap: keeps the SOURCE dist-tags");
const vkeys = synth ? Object.keys(synth.versions) : [];
ok(vkeys.includes("5.1.1") && vkeys.includes("6.0.0"), "remap: mirrors SOURCE versions (so any bcrypt@<range> resolves)");
const v6 = synth && synth.versions["6.0.0"];
ok(!!v6 && v6.dist.tarball === "https://reg/bcryptjs/-/bcryptjs-3.0.3.tgz", "remap: a source version points at the TARGET (bcryptjs) tarball");
ok(!!v6 && JSON.stringify(v6.dependencies) === "{}", "remap: deps come from the target (no native @mapbox/node-pre-gyp)");
ok(!!v6 && !("scripts" in v6) && !("optionalDependencies" in v6) && !("cpu" in v6) && !("os" in v6),
  "remap: native-install metadata (scripts/optionalDependencies/cpu/os) stripped");
ok(!!v6 && v6.main === "index.js" && v6.type === "module", "remap: carries the target's main/type");

// Guard: unusable inputs yield null (fetcher then falls back to the plain fetch).
ok(synthesizeRemappedPackument(null, bcryptjsPack, "bcrypt") === null, "remap: null source -> null");
ok(synthesizeRemappedPackument(bcryptPack, { name: "bcryptjs" }, "bcrypt") === null, "remap: target without versions -> null");

console.log("\nRESULT: " + (failures === 0 ? "PASS — toolchain subsystem intact" : `FAIL — ${failures} check(s) failed`));
process.exit(failures === 0 ? 0 : 1);