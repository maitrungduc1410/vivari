// Spike (NETWORK): prove Angular 21 (`@angular/build`) builds + serves in-VM.
// STATUS: PASSING — kept as a regression gate for the studio "Angular" template.
//
// Angular's builder uses **esbuild** (a filesystem-backed binary service) + Vite
// (which pulls **Rollup**) for the dev server. Neither native binary exists on
// `wasm32`, so we alias each to its official WASM drop-in via npm `overrides`:
//   - esbuild -> esbuild-wasm        (Go wasm run via wasm_exec.js)
//   - rollup  -> @rollup/wasm-node   (instantiates its .wasm synchronously)
//
// esbuild-wasm's Node build normally spawns `node bin/esbuild --service` as a
// CHILD and talks a byte-accurate binary protocol over its stdio pipe. Brokered
// through the single-threaded in-VM kernel, that pipe deadlocks against Angular's
// Piscina linker pool + inline AOT (all contend for the one event loop). We patch
// ensureServiceIsRunning() to run the Go wasm IN-PROCESS — the exact patch the
// studio template applies via scripts/oc-ng.mjs (kept in sync here). This also
// depends on the runtime fixes in packages/runtime: the loop wake nudge, the
// Buffer-pool untransferable guard, dedicated fs.promises.readFile buffers, and
// the dynamic-import escape hatch that routes piscina's `new Function(...import)`
// through our loader.
//
//   1) vendor npm:  rm -rf /tmp/oc-vendor && mkdir -p /tmp/oc-vendor \
//        && (cd /tmp/oc-vendor && npm install npm@10.9.2 --no-save --no-audit --no-fund)
//   2) run (Node 22+):  node scripts/spike-angular.mjs   (OC_LIVE=1 to stream)

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

// ── Angular 21 project source (mirrors the studio "Angular" template) ─────────
const NG = process.env.OC_NG_VERSION || "^21.1.0";
kernel.mkdirp(DIR + "/src/app");
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
<head><meta charset="utf-8"><title>Angular in OpenContainer</title><base href="/"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><app-root></app-root></body>
</html>
`,
);
kernel.writeFile(DIR + "/src/styles.css", `body { font-family: system-ui, sans-serif; padding: 2rem; }\n`);
kernel.writeFile(
  DIR + "/src/main.ts",
  `import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';

bootstrapApplication(App).catch((err) => console.error(err));
`,
);
kernel.writeFile(
  DIR + "/src/app/app.ts",
  `import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-root',
  standalone: true,
  template: '<h1 id="marker">Angular in OpenContainer</h1><button (click)="inc()">count is {{ count() }}</button>',
})
export class App {
  count = signal(0);
  inc() { this.count.update((c) => c + 1); }
}
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
  // @angular/build runs the TypeScript/AOT compiler in a Node worker thread that
  // blocks on Atomics.wait then pulls results via receiveMessageOnPort — semantics
  // our cooperative worker_threads can't serve, so it deadlocks at "Building…".
  // NG_BUILD_PARALLEL_TS=0 selects the inline AotCompilation (main thread).
  NG_BUILD_PARALLEL_TS: process.env.NG_BUILD_PARALLEL_TS || "0",
  // Angular's JS/CSS transforms use a Piscina pool with the same Atomics fast-path;
  // PISCINA_DISABLE_ATOMICS=1 switches it to pure async message passing.
  PISCINA_DISABLE_ATOMICS: process.env.PISCINA_DISABLE_ATOMICS || "1",
};

// ── gate 1: install ──────────────────────────────────────────────────────────
console.log(`\n== npm install (angular ${NG} + esbuild-wasm) ==`);
const INSTALL_TIMEOUT = Number(process.env.OC_INSTALL_TIMEOUT || 600000);
const t1 = Date.now();
let installTimedOut = false;
// --ignore-scripts: esbuild-wasm has no native postinstall, and this also skips
// any transitive native install step (the in-process patch is applied below, not
// via a postinstall).
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
// esbuild is aliased to esbuild-wasm, so the .wasm ships inside node_modules/esbuild.
const esbuildWasm =
  kernel.exists(DIR + "/node_modules/esbuild/esbuild.wasm") ||
  kernel.exists(DIR + "/node_modules/esbuild-wasm/esbuild.wasm");
console.log("  @angular/cli ng bin:   " + ngBin);
console.log("  esbuild-wasm .wasm:    " + esbuildWasm);

// ── In-process esbuild service patch (kept in sync with the studio template's
// scripts/oc-ng.mjs). Rewrites ensureServiceIsRunning() to run the Go wasm in
// this thread instead of spawning a child that deadlocks the kernel. ──────────
const ESB_INPROC_OLD = `  let [command, args] = esbuildCommandAndArgs();
  let child = child_process.spawn(command, args.concat(\`--service=\${"0.28.1"}\`, "--ping"), {
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

const ESB_INPROC_NEW = `  // [OpenContainer] in-process esbuild service (no child spawn).
  require(path2.join(__dirname, "..", "wasm_exec.js"));
  const __ocWasmBytes = fs2.readFileSync(path2.join(__dirname, "..", "esbuild.wasm"));
  let __ocStdin = [];
  let __ocStdinPos = 0;
  let __ocResume = null;
  let __ocReadFromStdout = null;
  const __ocRealFs = fs2;
  const __ocFs = Object.create(__ocRealFs);
  __ocFs.writeSync = (fd, buf) => {
    if (fd === 1) { __ocReadFromStdout(buf.slice()); return buf.length; }
    if (fd === 2) { try { process.stderr.write(buf.slice()); } catch {} return buf.length; }
    return __ocRealFs.writeSync(fd, buf);
  };
  __ocFs.write = (fd, buf, offset, length, position, callback) => {
    if (fd === 1 || fd === 2) {
      const slice = (offset === 0 && length === buf.length) ? buf : buf.subarray(offset, offset + length);
      const n = __ocFs.writeSync(fd, slice);
      const cb = typeof position === "function" ? position : callback;
      if (typeof cb === "function") cb(null, n);
      return;
    }
    return __ocRealFs.write(fd, buf, offset, length, position, callback);
  };
  __ocFs.read = (fd, buffer, offset, length, position, callback) => {
    if (fd === 0) {
      if (__ocStdin.length === 0) {
        __ocResume = () => __ocFs.read(fd, buffer, offset, length, position, callback);
        return;
      }
      const first = __ocStdin[0];
      const count = Math.max(0, Math.min(length, first.length - __ocStdinPos));
      buffer.set(first.subarray(__ocStdinPos, __ocStdinPos + count), offset);
      __ocStdinPos += count;
      if (__ocStdinPos === first.length) { __ocStdin.shift(); __ocStdinPos = 0; }
      callback(null, count);
      return;
    }
    return __ocRealFs.read(fd, buffer, offset, length, position, callback);
  };
  globalThis.fs = __ocFs;
  const __ocGo = new globalThis.Go();
  __ocGo.argv = ["node", \`--service=\${"0.28.1"}\`];
  __ocGo.env = Object.assign({ TMPDIR: os2.tmpdir() }, process.env);
  let { readFromStdout, afterClose, service } = createChannel({
    writeToStdin(bytes) {
      __ocStdin.push(bytes);
      if (__ocResume) {
        const r = __ocResume;
        __ocResume = null;
        queueMicrotask(r);
      }
    },
    readFileSync: fs2.readFileSync,
    isSync: false,
    hasFS: true,
    esbuild: node_exports
  });
  __ocReadFromStdout = readFromStdout;
  __ocGo.exit = (code) => { afterClose(code ? new Error("esbuild service exited with code " + code) : null); };
  WebAssembly.instantiate(__ocWasmBytes, __ocGo.importObject).then(
    (result) => { __ocGo.run(result.instance); },
    (err) => { afterClose(err); }
  );
  let __ocRefCount = 0;
  let __ocRefTimer = null;
  stopService = () => {
    try { for (const t of __ocGo._scheduledTimeouts.values()) clearTimeout(t); } catch {}
    if (__ocRefTimer) { clearInterval(__ocRefTimer); __ocRefTimer = null; }
    initializeWasCalled = false;
    longLivedService = void 0;
    stopService = void 0;
  };
  const refs = {
    ref() { if (++__ocRefCount === 1) __ocRefTimer = setInterval(() => {}, 1 << 30); },
    unref() { if (--__ocRefCount === 0 && __ocRefTimer) { clearInterval(__ocRefTimer); __ocRefTimer = null; } },
  };`;

function patchEsbuildInProcess(pkgDir) {
  const mainPath = pkgDir + "/lib/main.js";
  if (!kernel.exists(mainPath)) return "no main.js";
  let src;
  try { src = Buffer.from(kernel.readFile(mainPath)).toString(); } catch { return "read failed"; }
  if (src.includes("[OpenContainer] in-process esbuild service")) return "already patched";
  if (!src.includes(ESB_INPROC_OLD)) return "PATTERN NOT FOUND";
  kernel.writeFile(mainPath, Buffer.from(src.replace(ESB_INPROC_OLD, ESB_INPROC_NEW)));
  return "patched";
}
for (const dir of ["/node_modules/esbuild", "/node_modules/esbuild-wasm"]) {
  if (kernel.exists(DIR + dir + "/lib/main.js")) {
    console.log("  esbuild in-process patch (" + dir + "): " + patchEsbuildInProcess(DIR + dir));
  }
}

// ── gate 2: ng serve binds the port ──────────────────────────────────────────
console.log("\n== ng serve --port " + PORT + " ==");
const devStart = out.length;
kernel.start(
  "node",
  ["node_modules/@angular/cli/bin/ng.js", "serve", "--port", String(PORT), "--host", "127.0.0.1"],
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
  const GET_RETRIES = Number(process.env.OC_GET_RETRIES || 120);
  let root = await get("/");
  for (let i = 0; i < GET_RETRIES && (root.status === 502 || root.status === 404 || root.status >= 500); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    root = await get("/");
    if (i % 15 === 0) console.log(`  …waiting for build (t+${i}s, status=${root.status}, devbytes=${out.slice(devStart).join("").length})`);
  }
  const body = decode(root.body || "");
  getOk = root.status === 200 && /app-root|Angular in OpenContainer|<script/.test(body);
  console.log(`  GET / -> ${root.status}  (${body.length} bytes)`);
  console.log("  body head: " + body.slice(0, 300).replace(/\n/g, " "));
}
if (!getOk) {
  const tailSize = Number(process.env.OC_TAIL || 8000);
  console.log("\n---- dev output tail (last " + tailSize + " chars) ----\n" + out.slice(devStart).join("").slice(-tailSize));
}

const ok = inst.code === 0 && ngBin && esbuildWasm && bound && getOk;
console.log("\nRESULT: " + (ok ? "PASS — Angular 21 boots on esbuild-wasm + Vite and serves / with 200" : "FAIL — see logs above"));
process.exit(ok ? 0 : 1);
