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
//
//   run:  node scripts/spike-toolchain.mjs

import path from "node:path";
import { maybePatchEsbuildInProcess } from "../packages/runtime/esbuild-inproc-patch.js";
import { NATIVE_WASM_ALIASES } from "../packages/runtime/toolchain-shims.js";

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

// --- 2. patch applies to the known block --------------------------------------
const patched = maybePatchEsbuildInProcess(wrap(SPAWN_BLOCK("0.28.1")), MAIN, wasmPresent, path);
ok(patched != null, "patch returns a rewritten source for esbuild-wasm@0.28.1");
ok(patched != null && patched.includes("[OpenContainer] in-process esbuild service"), "rewrite carries the OC marker");
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

console.log("\nRESULT: " + (failures === 0 ? "PASS — toolchain subsystem intact" : `FAIL — ${failures} check(s) failed`));
process.exit(failures === 0 ? 0 : 1);
