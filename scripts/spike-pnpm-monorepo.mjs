// Spike (NET): the `monorepo` template, installed and served by the vendored pnpm.
//
// The template is the one place the studio ships pnpm settings, and pnpm 11 moved
// where it reads them: `node-linker=hoisted` in .npmrc is ignored, it has to be
// `nodeLinker: hoisted` in pnpm-workspace.yaml. Without the hoisted linker the
// preview crashes on react-dom's `scheduler` (see the template's comment), and
// nothing about the install says so. This spike takes the SHIPPED files and the
// shipped dev command, installs through the /bin/pnpm.js shim with the studio's
// environment, and checks the linker that actually ran as well as the page.
//
// Prereq: `npm run vendor:pnpm` (run-spikes provisions it).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootSpikeKernel, writeProject, httpGet } from "./lib/spike-harness.mjs";
import { loadShippedTemplates } from "./lib/shipped-templates.mjs";
import { ensureRealPnpm } from "../packages/kernel-host/load-real-pnpm.js";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const ASSET = path.join(ROOT, "packages/studio/public/vendor/pnpm-pack.bin");
if (!fs.existsSync(ASSET)) {
  console.error("No pnpm asset. Run `npm run vendor:pnpm` first.");
  process.exit(2);
}

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};

const templates = await loadShippedTemplates();
const tpl = templates.find((t) => t.manifest.id === "monorepo");
if (!tpl) {
  console.error("No `monorepo` template in templates.ts. Did its id change?");
  process.exit(2);
}

const h = await bootSpikeKernel();
const { kernel } = h;
const loaded = await ensureRealPnpm(kernel, async () => new Uint8Array(fs.readFileSync(ASSET)));
console.log(`pnpm ${loaded && loaded.version} loaded`);

const SQLITE = "/usr/lib/vivari/sqlite3.wasm";
kernel.mkdirp("/usr/lib/vivari");
kernel.mkdirp("/home/user/.local/share/pnpm/store");
await h.kernelFs.fs.writeLarge(SQLITE, new Uint8Array(fs.readFileSync(path.join(ROOT, "packages/runtime/vendor/sqlite/sqlite3.wasm"))));

const DIR = "/monorepo";
writeProject(kernel, DIR, tpl.files);

// The studio shell's pnpm settings (kernel-worker.ts openTerminal), both spellings.
const env = {
  HOME: "/home/user",
  PATH: DIR + "/node_modules/.bin:/bin",
  NODE_ENV: "development",
  npm_config_package_import_method: "hardlink",
  npm_config_store_dir: "/home/user/.local/share/pnpm/store",
  pnpm_config_package_import_method: "hardlink",
  pnpm_config_store_dir: "/home/user/.local/share/pnpm/store",
  pnpm_config_strict_store_pkg_content_check: "false",
  pnpm_config_update_notifier: "false",
  XDG_DATA_HOME: "/home/user/.local/share",
  XDG_CACHE_HOME: "/home/user/.cache",
  XDG_STATE_HOME: "/home/user/.local/state",
  XDG_CONFIG_HOME: "/home/user/.config",
  VV_SQLITE_WASM_PATH: SQLITE,
};

const [pm, ...installArgs] = tpl.manifest.install.split(" ");
console.log(`\n== ${tpl.manifest.install} ==`);
const inst = await Promise.race([
  kernel.start(pm, installArgs, { cwd: DIR, env, capture: true }),
  new Promise((r) => setTimeout(() => r({ code: 124, stdout: "", stderr: "TIMEOUT" }), 400000)),
]);
if (inst.code !== 0) console.log((inst.stdout || "") + "\n" + (inst.stderr || ""));
ok(inst.code === 0, `install exits 0 (${inst.code})`);

const reactPkg = kernel.exists(DIR + "/node_modules/react/package.json");
const schedulerTop = kernel.exists(DIR + "/node_modules/scheduler/package.json");
ok(reactPkg, "react is installed at the root node_modules");
// The hoisted linker's signature: a transitive dep sits at the top level. The
// isolated store would keep scheduler under node_modules/.pnpm only.
ok(schedulerTop, "react-dom's transitive `scheduler` is hoisted to the top level (nodeLinker: hoisted took effect)");
const modulesYaml = kernel.readFile(DIR + "/node_modules/.modules.yaml") || "";
ok(/"?nodeLinker"?:\s*"?hoisted/.test(modulesYaml), "node_modules/.modules.yaml records nodeLinker hoisted (it is JSON in pnpm 11)");
ok(kernel.exists(DIR + "/node_modules/@repo/ui/package.json"), "the workspace package @repo/ui is linked");

const [devPm, ...devArgs] = tpl.manifest.dev.split(" ");
console.log(`\n== ${tpl.manifest.dev} ==`);
kernel.start(devPm, devArgs, { cwd: DIR, env });
const tb = Date.now();
while (!h.listening.has(tpl.manifest.port) && Date.now() - tb < 180000) await new Promise((r) => setTimeout(r, 200));
ok(h.listening.has(tpl.manifest.port), `the dev server binds :${tpl.manifest.port} (${Date.now() - tb}ms)`);
if (h.listening.has(tpl.manifest.port)) {
  const page = await httpGet(kernel, tpl.manifest.port, "/");
  ok(page.status === 200 && /<div id="root">/.test(page.body), `GET / serves the app shell (${page.status})`);
  const app = await httpGet(kernel, tpl.manifest.port, "/src/App.jsx");
  ok(app.status === 200 && /@repo\/ui|greeting/.test(app.body), "the app module that imports the workspace package is served");
} else {
  console.log(h.out.join("").slice(-3000));
}

console.log(failed ? `\nFAIL: ${failed} check(s)` : "\nPASS: the monorepo template installs hoisted and serves under pnpm " + (loaded && loaded.version));
process.exit(failed ? 1 : 0);
