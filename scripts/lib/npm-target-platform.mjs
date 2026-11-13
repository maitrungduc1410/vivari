// The platform host-side npm resolves and installs FOR: what the VM reports
// (runtime/builtins/process.js), not what the build machine is.
//
// `--cpu`/`--os` are not enough on their own. npm applies them only to OPTIONAL
// dependencies: Arborist's build-ideal-tree checks a non-optional package with
// `checkPlatform(pkg, force)` and no environment, so npm-install-checks falls back
// to `process.arch`. A template that depends directly on a package declaring
// `"cpu": ["wasm32"]` (every Vite 8 template lists @rolldown/binding-wasm32-wasi,
// which declares it from 1.2.19) therefore fails on the build host with
// `notsup … wanted {"cpu":"wasm32"} (current: {"cpu":"x64"})`, while the same
// install inside the VM is fine.
//
// TARGET_PLATFORM_PRELOAD is CommonJS for npm's own process (`--require`). It wraps
// npm-install-checks' checkPlatform so a call with no environment gets this target,
// exactly what the optional-dependency call is already given. An explicit
// environment still wins. Nothing else in npm changes.
//
// Used by gen-template-locks.mjs (the lock resolve) and gen-depcache.mjs (the
// install from that lock). Both broke the same way on the same release.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TARGET_CPU = "wasm32";
export const TARGET_OS = "linux";

export const TARGET_PLATFORM_PRELOAD = `;(() => {
  const Module = require("node:module");
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    const mod = load.apply(this, arguments);
    if (request === "npm-install-checks" && mod && typeof mod.checkPlatform === "function" && !mod.__vvTarget) {
      const checkPlatform = mod.checkPlatform;
      mod.checkPlatform = (target, force, environment) =>
        checkPlatform(target, force, { cpu: ${JSON.stringify(TARGET_CPU)}, os: ${JSON.stringify(TARGET_OS)}, ...(environment || {}) });
      Object.defineProperty(mod, "__vvTarget", { value: true });
    }
    return mod;
  };
})();
`;

/** The npm flags for the same target. */
export const TARGET_FLAGS = [`--cpu=${TARGET_CPU}`, `--os=${TARGET_OS}`];

/**
 * Write the preload to a temp file and return an env for npm that loads it, plus a
 * cleanup. `extra` is more preload source to run first (the arborist patch).
 */
export function targetPlatformEnv(baseEnv = process.env, extra = "") {
  const file = path.join(os.tmpdir(), `vv-npm-target-${process.pid}-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(file, (extra ? extra + "\n" : "") + TARGET_PLATFORM_PRELOAD);
  const nodeOptions = `${baseEnv.NODE_OPTIONS || ""} --require ${JSON.stringify(file)}`.trim();
  return {
    env: { ...baseEnv, NODE_OPTIONS: nodeOptions },
    cleanup: () => fs.rmSync(file, { force: true }),
  };
}
