// SDK smoke test — a fast, offline guard for the @vivari/core / @vivari/react
// packaging + public API contract, plus the shipped preview Service Worker and
// the examples/basic app wiring. No browser, no Wasm build required, so it runs
// in the cheap CI gate on every push.
//
// It checks, statically:
//   • package manifests (type, exports map, files, main/module/types)
//   • the documented public API is actually exported from src/index.ts
//   • the shipped sw.js parses and carries no leftover `oc` branding
//   • the example app is wired correctly (SDK import, COOP/COEP, Vivari.boot)
//
// And, when `packages/core/dist/` has been built (e.g. in the publish pipeline),
// it ALSO does a real runtime import of the bundled ESM and exercises the pure
// API surface. That leg is skipped (not failed) when dist is absent.
//
//   node scripts/smoke-sdk.mjs

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const p = (rel) => fileURLToPath(new URL(rel, root));
const read = (rel) => readFileSync(p(rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));

let failed = 0;
let skipped = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  \u2713 " : "  \u2717 ") + msg);
  if (!cond) failed++;
};
const skip = (msg) => {
  console.log("  \u25CB " + msg + " (skipped)");
  skipped++;
};
const section = (title) => console.log("\n" + title);

// --- 1. package manifests ----------------------------------------------------
section("package manifests");
{
  const core = readJson("packages/core/package.json");
  ok(core.name === "@vivari/core", "@vivari/core: name");
  ok(core.type === "module", "@vivari/core: ESM (type: module)");
  ok(core.main?.startsWith("./dist/") && core.types?.startsWith("./dist/"),
    "@vivari/core: main/types point into ./dist");
  ok(core.exports?.["."]?.types && core.exports?.["."]?.default,
    "@vivari/core: exports['.'] has types + default");
  ok(Array.isArray(core.files) && core.files.includes("dist") && core.files.includes("README.md"),
    "@vivari/core: files ships dist + README");
  ok(core.publishConfig?.access === "public", "@vivari/core: publishConfig.access public");

  const react = readJson("packages/react/package.json");
  ok(react.name === "@vivari/react", "@vivari/react: name");
  ok(react.type === "module", "@vivari/react: ESM (type: module)");
  ok(!!react.peerDependencies?.react, "@vivari/react: react is a peerDependency");
  // A peer, not a dependency: two copies of core in one page mean two kernels,
  // two SharedArrayBuffer worlds and a preview Service Worker registered twice.
  ok(!!react.peerDependencies?.["@vivari/core"], "@vivari/react: @vivari/core is a peerDependency");
  ok(!react.dependencies?.["@vivari/core"], "@vivari/react: does not bundle its own @vivari/core");
  ok(react.exports?.["."]?.types && react.exports?.["."]?.default,
    "@vivari/react: exports['.'] has types + default");

  const example = readJson("examples/basic/package.json");
  ok(!!example.dependencies?.["@vivari/core"], "examples/basic: depends on @vivari/core");
  ok(!!example.scripts?.dev && !!example.scripts?.build, "examples/basic: has dev + build scripts");
}

// --- 2. public API surface ---------------------------------------------------
section("public API surface");
{
  const coreIndex = read("packages/core/src/index.ts");
  const coreValues = [
    "Vivari",
    "VivariError",
    "VivariFsError",
    "KernelBridge",
    "isCrossOriginIsolated",
    "resetVfs",
  ];
  for (const name of coreValues) {
    ok(new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(coreIndex),
      `@vivari/core exports ${name}`);
  }
  // FileSystemAPI/VivariProcess are handed to consumers but never constructed by
  // them, so they must stay type-only exports.
  for (const name of ["FileSystemAPI", "VivariProcess"]) {
    ok(new RegExp(`export type\\s*\\{[^}]*\\b${name}\\b`).test(coreIndex),
      `@vivari/core exports ${name} as a type only`);
  }
  const coreTypes = [
    "BootOptions",
    "ExportResult",
    "FileSystemTree",
    "FsChangeEvent",
    "KernelMessage",
    "OutputStream",
    "SpawnOptions",
    "Stats",
    "VivariEventMap",
    "VivariErrorCode",
  ];
  for (const name of coreTypes) {
    ok(new RegExp(`\\b${name}\\b`).test(coreIndex), `@vivari/core exports type ${name}`);
  }

  const reactIndex = read("packages/react/src/index.ts");
  for (const name of ["Vivari", "useVivari"]) {
    ok(new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(reactIndex),
      `@vivari/react exports ${name}`);
  }
}

// --- 2b. declaration-emit resolution (node16/nodenext) -----------------------
// `tsc` writes import specifiers into the .d.ts verbatim, so an extensionless
// relative specifier here is a hard TS2834 in any consumer using
// `moduleResolution: node16` — a break they cannot patch from their side.
section("declaration specifiers resolve under node16");
{
  const dir = p("packages/core/src");
  const sources = readdirSync(dir).filter((f) => f.endsWith(".ts")); // src/workers is bundled, not emitted
  let bad = [];
  for (const file of sources) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const match of text.matchAll(/\bfrom\s+"(\.[^"]*)"/g)) {
      if (!/\.(js|json|wasm)$/.test(match[1])) bad.push(`${file} -> ${match[1]}`);
    }
  }
  ok(sources.length > 0, `scanned ${sources.length} public source files`);
  ok(bad.length === 0,
    "every relative import carries a file extension" +
      (bad.length ? " (missing: " + bad.join(", ") + ")" : ""));
}

// --- 3. the shipped preview Service Worker -----------------------------------
section("preview service worker (sw.js)");
{
  const sw = read("packages/studio/public/sw.js");
  // Parse-check without executing (sw.js is a classic worker script, not ESM).
  let parses = true;
  try {
    // eslint-disable-next-line no-new-func
    new Function(sw);
  } catch (e) {
    parses = false;
    console.log("    " + (e && e.message));
  }
  ok(parses, "sw.js parses");

  // Regression guard for the oc -> vv branding cleanup: no OpenContainer-era
  // identifiers may ship in the public SW.
  const ocLeftovers = sw.match(/__oc|OCWebSocket|OCEventSource|oc\.config|__OC_|["']ocdt/g);
  ok(!ocLeftovers, "sw.js has no leftover `oc`-branded identifiers" +
    (ocLeftovers ? " (found: " + [...new Set(ocLeftovers)].join(", ") + ")" : ""));
  // The vv-config key + the devtools gate should be present.
  ok(sw.includes("vv.config/keep-prefix-ports"), "sw.js uses the vv.config keep-prefix key");
  ok(sw.includes("vv-devtools") && sw.includes("loadDevtoolsEnabled"),
    "sw.js gates DevTools injection (vv-devtools)");
}

// --- 4. the example app wiring ----------------------------------------------
section("examples/basic wiring");
{
  const viteConfig = read("examples/basic/vite.config.ts");
  ok(viteConfig.includes("Cross-Origin-Opener-Policy") && viteConfig.includes("same-origin"),
    "example sets COOP: same-origin");
  ok(viteConfig.includes("Cross-Origin-Embedder-Policy") && viteConfig.includes("require-corp"),
    "example sets COEP: require-corp");
  ok(viteConfig.includes("/sw.js") && viteConfig.includes("Service-Worker-Allowed"),
    "example serves /sw.js with a root scope");

  const main = read("examples/basic/src/main.ts");
  ok(/from ["']@vivari\/core["']/.test(main), "example imports from @vivari/core");
  ok(main.includes("Vivari.boot"), "example calls Vivari.boot()");
  ok(main.includes("vivari.mount") && main.includes("vivari.spawn"),
    "example mounts a tree + spawns a process");
  ok(main.includes('vivari.on("server-ready"') || main.includes("server-ready"),
    "example previews an in-VM server (server-ready)");
}

// --- 5. optional: real runtime import of the built ESM -----------------------
section("built dist runtime import");
if (existsSync(p("packages/core/dist/index.js"))) {
  const mod = await import(new URL("packages/core/dist/index.js", root));
  ok(typeof mod.Vivari === "function", "dist: Vivari is exported");
  ok(typeof mod.Vivari.boot === "function", "dist: Vivari.boot is a function");
  ok(typeof mod.KernelBridge === "function", "dist: KernelBridge is exported");
  ok(typeof mod.isCrossOriginIsolated === "function", "dist: isCrossOriginIsolated is exported");
  // The error classes are pure — exercise the discrimination contract consumers
  // are told to rely on (instanceof + a machine-readable code) with no browser.
  const fsErr = new mod.VivariFsError("ENOENT", "read", "/missing.txt");
  ok(fsErr instanceof mod.VivariError && fsErr instanceof Error,
    "dist: VivariFsError is a VivariError and an Error");
  ok(fsErr.code === "ENOENT" && fsErr.path === "/missing.txt" && fsErr.syscall === "read",
    "dist: VivariFsError carries code + path + syscall");
  ok(new mod.VivariError("ERR_BOOT_TIMEOUT", "boom").code === "ERR_BOOT_TIMEOUT",
    "dist: VivariError carries its code");
  ok(existsSync(p("packages/core/dist/assets/sw.js")), "dist: vendored assets/sw.js is present");
} else {
  skip("packages/core/dist not built — run `npm run build:sdk` for the runtime leg");
}

console.log(
  `\nRESULT: ${failed ? "FAIL" : "PASS"} (${failed} failed, ${skipped} skipped)`,
);
process.exit(failed ? 1 : 0);