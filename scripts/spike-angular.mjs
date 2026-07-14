// Spike (NETWORK): prove Angular 21 (`@angular/build:dev-server`) boots + serves
// in-VM. STATUS: blocked on the esbuild binary-service hard path (see below /
// roadmap Phase 4). Kept as a regression + feasibility harness.
//
// Angular's builder uses **esbuild** (a filesystem-backed binary service) + Vite
// (which pulls **Rollup**) for the dev server. Neither native binary exists on
// `wasm32`, so we alias each to its official WASM drop-in via npm `overrides`:
//   - esbuild -> esbuild-wasm   (Node entry spawns `node bin/esbuild` running the
//     wasm via wasm_exec_node.js, which HAS fs — unlike the browser build)
//   - rollup  -> @rollup/wasm-node   (instantiates its .wasm synchronously)
//
// How far it gets today: install ok, CLI boots, `ng serve` binds its port, Vite +
// Rollup load, the esbuild Go/wasm actually runs (`--version` prints), the build
// begins — then fails `The service was stopped` because the esbuild service needs
// (a) byte-accurate binary child stdio through the kernel and (b) `fs.read(fd 0)`
// wired to stdin. Diagnostics: OC_SPAWNTEST=1 (spawn stdin/stdout roundtrip),
// OC_ESBTEST=1 (run the raw esbuild wasm bin), OC_INSTALL_ONLY=1.
//
//   1) vendor npm:  rm -rf /tmp/oc-vendor && mkdir -p /tmp/oc-vendor \
//        && (cd /tmp/oc-vendor && npm install npm@10.9.2 --no-save --no-audit --no-fund)
//   2) run (Node 22+):  node scripts/spike-angular.mjs

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { stubNodeGyp } from "../packages/kernel-host/node-gyp-stub.js";
import { Worker, MessageChannel } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";

const VENDOR_NPM = process.argv[2] || "/tmp/oc-vendor/node_modules/npm";
const VFS_NPM = "/usr/lib/node_modules/npm";
if (!fs.existsSync(path.join(VENDOR_NPM, "bin/npm-cli.js"))) {
  console.error(`No vendored npm at ${VENDOR_NPM} (expected bin/npm-cli.js).`);
  process.exit(2);
}

const LIVE = process.env.OC_LIVE === "1";
const DIR = "/ng";
const PORT = Number(process.env.OC_PORT || 4210);

// ── kernel setup (same shape as spike-next.mjs) ──────────────────────────────
const fsWorker = new Worker(new URL("./fs-worker.mjs", import.meta.url));
let onKernelFsMessage = () => {};
await new Promise((resolve) => {
  fsWorker.on("message", (m) => {
    if (m.type === "ready") resolve();
    else onKernelFsMessage(m);
  });
});
const kernelFs = createKernelFs(fsWorker);
onKernelFsMessage = kernelFs.onMessage;

const spawnWorker = (info) => {
  const w = new Worker(new URL("./process-worker.mjs", import.meta.url));
  w.on("message", (m) => {
    const h = info.on[m.type];
    if (h) h(m);
  });
  w.on("error", (e) => {
    process.stderr.write(`\n[worker-error pid ${info.pid}] ${(e && e.stack) || e}\n`);
  });
  const { port1, port2 } = new MessageChannel();
  fsWorker.postMessage({ type: "fs-register", client: info.pid, sab: info.sab, port: port2 }, [port2]);
  const init = { type: "init", sab: info.sab, spec: info.spec, fsPort: port1 };
  const transfer = [port1];
  if (info.threadPort) {
    init.threadPort = info.threadPort;
    transfer.push(info.threadPort);
  }
  w.postMessage(init, transfer);
  return {
    terminate: () => {
      w.terminate();
      fsWorker.postMessage({ type: "fs-unregister", client: info.pid });
    },
    postMessage: (m) => w.postMessage(m),
  };
};
const fetcher = async (url, init) => {
  const r = await fetch(url, { redirect: "follow", ...(init || {}) });
  const body = new Uint8Array(await r.arrayBuffer());
  const headers = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  return { ok: r.ok, status: r.status, statusText: r.statusText, headers, body };
};

const out = [];
const cap = (s) => {
  out.push(s);
  if (LIVE) process.stderr.write(s);
};
const listening = new Set();
const kernel = new Kernel({ fs: kernelFs.fs, spawnWorker, fetcher, stdout: cap, stderr: cap });
kernel.onListen = (port) => listening.add(port);
kernel.installCoreutils();
let fetchN = 0;
kernel.onFetch = (url, info) => {
  fetchN++;
  if (LIVE) process.stderr.write(`  [net ${fetchN}] ${info.cached ? "cache" : "GET"} ${((info.size / 1024) | 0)}k  ${url}\n`);
};

// ── load the vendored npm tree into the VFS ──────────────────────────────────
let fileCount = 0;
function loadDir(hostDir, vfsDir) {
  kernel.mkdirp(vfsDir);
  for (const entry of fs.readdirSync(hostDir, { withFileTypes: true })) {
    const hostPath = path.join(hostDir, entry.name);
    const vfsPath = vfsDir + "/" + entry.name;
    if (entry.isDirectory()) loadDir(hostPath, vfsPath);
    else if (entry.isFile()) {
      kernel.writeFile(vfsPath, fs.readFileSync(hostPath));
      fileCount++;
    }
  }
}
const t0 = Date.now();
loadDir(VENDOR_NPM, VFS_NPM);
stubNodeGyp(kernel, VFS_NPM);
console.log(`Loaded real npm into VFS: ${fileCount} files (${Date.now() - t0}ms)`);

kernel.mkdirp("/home/user");
kernel.mkdirp("/tmp/.npm/_logs");

// ── OC_SPAWNTEST: prove child_process.spawn bidirectional stdin/stdout pipe ───
// esbuild-wasm's Node service spawns `node bin/esbuild` and talks over a stdin
// pipe (parent writes) + stdout pipe (parent reads); the child reads fd0 in a
// loop. This is the exact capability. Prove it in isolation before blaming Angular.
if (process.env.OC_SPAWNTEST === "1") {
  kernel.mkdirp(DIR);
  kernel.writeFile(
    DIR + "/child.js",
    `process.stdin.on("data", (d) => { process.stdout.write("echo:" + d); });
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
`,
  );
  kernel.writeFile(
    DIR + "/parent.js",
    `const cp = require("child_process");
const c = cp.spawn("node", ["${DIR}/child.js"], { stdio: ["pipe", "pipe", "inherit"] });
let got = "";
c.on("error", (e) => { console.log("SPAWN_ERR " + e.message); process.exit(1); });
c.stdout.on("data", (d) => {
  got += d.toString();
  if (got.includes("echo:hi")) { console.log("ROUNDTRIP_OK"); try { c.kill(); } catch {} process.exit(0); }
});
c.on("exit", (code) => { if (!got.includes("echo:hi")) { console.log("CHILD_EXIT " + code + " got=" + JSON.stringify(got)); process.exit(1); } });
setTimeout(() => { try { c.stdin.write("hi"); } catch (e) { console.log("WRITE_ERR " + e.message); } }, 300);
setTimeout(() => { console.log("TIMEOUT got=" + JSON.stringify(got)); process.exit(1); }, 5000);
`,
  );
  console.log("\n== OC_SPAWNTEST: child_process.spawn stdin/stdout roundtrip ==");
  const r = await kernel.start("node", [DIR + "/parent.js"], { cwd: DIR, env: { HOME: "/home/user", PATH: "/bin" }, capture: true });
  console.log("  stdout: " + (r.stdout || "").trim());
  if (r.stderr) console.log("  stderr: " + r.stderr.trim());
  console.log("  exit=" + r.code);
  process.exit(r.code === 0 && /ROUNDTRIP_OK/.test(r.stdout || "") ? 0 : 1);
}


// ── Angular 21 project source (from the user's working local config) ─────────
const NG = process.env.OC_NG_VERSION || "^21.1.0";
kernel.mkdirp(DIR + "/src");
kernel.writeFile(
  DIR + "/package.json",
  JSON.stringify(
    {
      name: "angular-app",
      version: "0.0.0",
      private: true,
      scripts: { ng: "ng", start: "ng serve", build: "ng build" },
      dependencies: {
        "@angular/common": NG,
        "@angular/compiler": NG,
        "@angular/core": NG,
        "@angular/forms": NG,
        "@angular/platform-browser": NG,
        "@angular/router": NG,
        rxjs: "^7.8.1",
        tslib: "^2.5.0",
      },
      devDependencies: {
        "@angular/build": NG,
        "@angular/cli": NG,
        "@angular/compiler-cli": NG,
        typescript: "~5.9.2",
      },
      // Angular's builder (esbuild) and its Vite dev server (esbuild + Rollup) both
      // pull native binaries with no wasm32 build. Alias each to its official WASM
      // drop-in:
      //  - esbuild -> esbuild-wasm: its Node entry spawns `node bin/esbuild` running
      //    the wasm via wasm_exec_node.js (real fs access — unlike the browser build).
      //  - rollup  -> @rollup/wasm-node: instantiates its .wasm synchronously.
      overrides: {
        esbuild: "npm:esbuild-wasm@" + (process.env.OC_ESBUILD_WASM || "0.28.1"),
        rollup: "npm:@rollup/wasm-node@" + (process.env.OC_ROLLUP_WASM || "^4.62.0"),
      },
    },
    null,
    2,
  ),
);
kernel.writeFile(
  DIR + "/angular.json",
  JSON.stringify(
    {
      $schema: "./node_modules/@angular/cli/lib/config/schema.json",
      version: 1,
      cli: { packageManager: "npm", analytics: false },
      newProjectRoot: "projects",
      projects: {
        "angular-app": {
          projectType: "application",
          schematics: {},
          root: "",
          sourceRoot: "src",
          prefix: "app",
          architect: {
            build: {
              builder: "@angular/build:application",
              options: {
                browser: "src/main.ts",
                tsConfig: "tsconfig.app.json",
                index: "src/index.html",
                styles: ["src/styles.css"],
              },
              configurations: {
                production: { outputHashing: "all" },
                development: { optimization: false, extractLicenses: false, sourceMap: true },
              },
              defaultConfiguration: "development",
            },
            serve: {
              builder: "@angular/build:dev-server",
              configurations: {
                production: { buildTarget: "angular-app:build:production" },
                development: { buildTarget: "angular-app:build:development" },
              },
              defaultConfiguration: "development",
            },
          },
        },
      },
    },
    null,
    2,
  ),
);
kernel.writeFile(
  DIR + "/tsconfig.json",
  JSON.stringify(
    {
      compileOnSave: false,
      compilerOptions: {
        outDir: "./dist/out-tsc",
        strict: true,
        skipLibCheck: true,
        isolatedModules: true,
        experimentalDecorators: true,
        moduleResolution: "bundler",
        importHelpers: true,
        target: "ES2022",
        module: "preserve",
      },
      angularCompilerOptions: { strictTemplates: true },
    },
    null,
    2,
  ),
);
kernel.writeFile(
  DIR + "/tsconfig.app.json",
  JSON.stringify(
    { extends: "./tsconfig.json", compilerOptions: { outDir: "./out-tsc/app", types: [] }, files: ["src/main.ts"] },
    null,
    2,
  ),
);
kernel.writeFile(
  DIR + "/src/index.html",
  `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Angular on OpenContainer</title><base href="/"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><app-root></app-root></body>
</html>
`,
);
kernel.writeFile(DIR + "/src/styles.css", `body { font-family: system-ui, sans-serif; padding: 2rem; }\n`);
kernel.writeFile(
  DIR + "/src/main.ts",
  `import { bootstrapApplication } from '@angular/platform-browser';
import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-root',
  template: \`
    <h1 id="marker">Angular App Router in OpenContainer</h1>
    <button (click)="inc()">count is {{ count() }}</button>
  \`,
})
export class App {
  count = signal(0);
  inc() { this.count.update((c) => c + 1); }
}

bootstrapApplication(App).catch((err) => console.error(err));
`,
);

const env = {
  HOME: "/home/user",
  PATH: DIR + "/node_modules/.bin:/bin",
  npm_config_cache: "/tmp/.npm",
  NODE_ENV: "development",
  NG_CLI_ANALYTICS: "false",
  CI: "true",
  OC_LIVE: LIVE ? "1" : "",
  OC_TRACE_MODULES: process.env.OC_TRACE_MODULES || "",
};

// ── gate 1: install ──────────────────────────────────────────────────────────
console.log(`\n== npm install (angular ${NG} + esbuild-wasm) ==`);
const INSTALL_TIMEOUT = Number(process.env.OC_INSTALL_TIMEOUT || 600000);
const t1 = Date.now();
let installTimedOut = false;
// --ignore-scripts: esbuild's postinstall (install.js) throws "Unsupported
// platform: linux wasm32" trying to fetch a native binary we don't use (the
// wasm shim replaces esbuild entirely), which otherwise stalls the whole install.
const inst = await Promise.race([
  kernel.start("node", [VFS_NPM + "/bin/npm-cli.js", "install", "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: DIR, env, capture: !LIVE }),
  new Promise((r) => setTimeout(() => { installTimedOut = true; r({ code: 124 }); }, INSTALL_TIMEOUT)),
]);
console.log(`  install exit=${inst.code}${installTimedOut ? " (TIMED OUT)" : ""}  (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
if (inst.code !== 0) {
  console.log("  STDERR tail:\n" + ((inst.stderr || out.join("")).slice(-4000)));
  process.exit(1);
}

// ── inspect the installed tree (ground truth) ────────────────────────────────
const ngBin = kernel.exists(DIR + "/node_modules/@angular/cli/bin/ng.js");
const ngBuild = kernel.exists(DIR + "/node_modules/@angular/build/package.json");
const esbuildPkg = kernel.exists(DIR + "/node_modules/esbuild/package.json");
// esbuild is aliased to esbuild-wasm, so the .wasm ships inside node_modules/esbuild.
const esbuildWasm =
  kernel.exists(DIR + "/node_modules/esbuild/esbuild.wasm") ||
  kernel.exists(DIR + "/node_modules/esbuild-wasm/esbuild.wasm");
const vitePkg = kernel.exists(DIR + "/node_modules/vite/package.json");
const readJson = (p) => { try { return JSON.parse(Buffer.from(kernel.readFile(p)).toString()); } catch { return null; } };
const vMeta = readJson(DIR + "/node_modules/vite/package.json");
const ebMeta = readJson(DIR + "/node_modules/esbuild/package.json");
const abMeta = readJson(DIR + "/node_modules/@angular/build/package.json");
console.log("  @angular/cli ng bin:   " + ngBin);
console.log("  @angular/build:        " + ngBuild + (abMeta ? " v" + abMeta.version : ""));
console.log("  esbuild pkg present:   " + esbuildPkg + (ebMeta ? " v" + ebMeta.version : ""));
console.log("  esbuild-wasm .wasm:    " + esbuildWasm);
console.log("  vite present:          " + vitePkg + (vMeta ? " v" + vMeta.version : ""));
// native esbuild binaries (should be absent on wasm32)
for (const p of ["@esbuild/linux-x64", "@esbuild/darwin-arm64"]) {
  console.log("  " + p + " (native, want false): " + kernel.exists(DIR + "/node_modules/" + p + "/package.json"));
}
if (abMeta) console.log("  @angular/build deps: " + Object.keys(abMeta.dependencies || {}).filter((d) => /esbuild|vite|rollup|rolldown/.test(d)).map((d) => d + "@" + abMeta.dependencies[d]).join(", "));
console.log("  esbuild aliased to esbuild-wasm: " + (ebMeta ? ebMeta.name === "esbuild-wasm" || !!ebMeta._oc_alias || esbuildWasm : false));

// ── OC_ESBTEST: run the aliased esbuild's Go wasm bin directly (isolates the
// 'service was stopped' failure from the rest of the ng serve pipeline) ───────
if (process.env.OC_ESBTEST === "1") {
  console.log("\n== esbuild bin --version (raw Go wasm) ==");
  const r = await kernel.start("node", [DIR + "/node_modules/esbuild/bin/esbuild", "--version"], {
    cwd: DIR,
    env: { ...env, TMPDIR: "/tmp" },
    capture: true,
  });
  console.log("  stdout: " + JSON.stringify((r.stdout || "").trim()));
  if (r.stderr) console.log("  stderr:\n" + r.stderr.split("\n").slice(0, 40).map((l) => "    " + l).join("\n"));
  console.log("  exit=" + r.code);
  process.exit(r.code === 0 ? 0 : 1);
}

if (process.env.OC_INSTALL_ONLY === "1") {
  console.log("\nOC_INSTALL_ONLY=1 — stopping after install+inspect.");
  process.exit(inst.code === 0 && ngBin ? 0 : 1);
}

// ── diagnostic: expose the real stack the CLI swallows via err.toString() ─────
{
  const initPath = DIR + "/node_modules/@angular/cli/lib/init.js";
  try {
    let src = Buffer.from(kernel.readFile(initPath)).toString();
    src = src.replace("'Unknown error: ' + err.toString()", "'Unknown error: ' + ((err && err.stack) || err)");
    kernel.writeFile(initPath, src);
  } catch (e) {
    console.log("  (could not patch init.js: " + e.message + ")");
  }
}

// ── diagnostic: surface the swallowed stack in @angular/cli/lib/init.js ───────
kernel.writeFile(
  DIR + "/oc-patch-cli.js",
  `const fs = require("fs");
const p = "${DIR}/node_modules/@angular/cli/lib/init.js";
let s = fs.readFileSync(p, "utf8");
s = s.replace("'Unknown error: ' + err.toString()", "'Unknown error: ' + (err && err.stack || err)");
fs.writeFileSync(p, s);
console.log("patched init.js to print stack");
`,
);
const patchRun = await kernel.start("node", [DIR + "/oc-patch-cli.js"], { cwd: DIR, env, capture: true });
console.log("  " + (patchRun.stdout || "").trim() + (patchRun.stderr ? " ERR:" + patchRun.stderr.trim() : ""));

// ── diagnostic: does the CLI even bootstrap? ─────────────────────────────────
console.log("\n== ng version (CLI bootstrap check) ==");
const ver = await kernel.start("node", ["node_modules/@angular/cli/bin/ng.js", "version"], { cwd: DIR, env, capture: true });
console.log("  exit=" + ver.code);
console.log("  stdout:\n" + (ver.stdout || "").split("\n").map((l) => "    " + l).join("\n"));
if (ver.stderr) console.log("  stderr:\n" + ver.stderr.split("\n").map((l) => "    " + l).join("\n"));

// ── gate 2: ng serve binds the port ──────────────────────────────────────────
console.log("\n== ng serve --port " + PORT + " ==");
const devStart = out.length;
kernel.start(
  "node",
  ["node_modules/@angular/cli/bin/ng.js", "serve", "--port", String(PORT), "--host", "127.0.0.1", "--verbose"],
  { cwd: DIR, env },
);
const BIND_TIMEOUT = Number(process.env.OC_BIND_TIMEOUT || 300000);
const tb = Date.now();
let fatal = "";
while (!listening.has(PORT) && Date.now() - tb < BIND_TIMEOUT && !fatal) {
  await new Promise((r) => setTimeout(r, 200));
  const tail = out.slice(devStart).join("");
  const m = tail.match(/Cannot find module '([^']+)'|Error: ([^\n]*is not (?:a function|supported|implemented)[^\n]*)|✘ \[ERROR\][^\n]*/);
  if (m) fatal = m[0];
}
if (fatal) console.log(`  early-abort signal: ${fatal}`);
const bound = listening.has(PORT);
console.log(`  listening on ${PORT}: ${bound}  (${((Date.now() - tb) / 1000).toFixed(1)}s)`);

// ── gate 3: GET / -> 200 with app marker ─────────────────────────────────────
let getOk = false;
if (bound) {
  const decode = (b) => (typeof b === "string" ? b : Buffer.from(b).toString());
  const get = (url) => kernel.handleHttpRequest(PORT, { port: PORT, method: "GET", url, headers: { host: "127.0.0.1:" + PORT }, body: "" });
  let root = await get("/");
  for (let i = 0; i < 120 && (root.status === 502 || root.status === 404 || root.status >= 500); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    root = await get("/");
  }
  const body = decode(root.body || "");
  getOk = root.status === 200 && /app-root|Angular App Router in OpenContainer|<script/.test(body);
  console.log(`  GET / -> ${root.status}  (${body.length} bytes)`);
  console.log("  body head: " + body.slice(0, 300).replace(/\n/g, " "));
} else {
  console.log("\n---- dev output tail (last 6000 chars) ----\n" + out.slice(devStart).join("").slice(-6000));
}

const ok = inst.code === 0 && ngBin && esbuildWasm && bound && getOk;
console.log("\nRESULT: " + (ok ? "PASS — Angular 21 boots on esbuild-wasm + Vite and serves / with 200" : "FAIL — see logs above"));
process.exit(ok ? 0 : 1);
