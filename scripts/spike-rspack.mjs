// Spike (NETWORK): prove Rspack (the Rust/webpack-compatible bundler) runs in-VM.
//
// Rspack's core is a native N-API addon (`@rspack/binding`). Like rolldown/Vite,
// it publishes a `wasm32-wasip1-threads` build under a platform package
// (`@rspack/binding-wasm32-wasi`, gated `cpu: ["wasm32"]`) as an optionalDependency.
// Because our runtime reports `process.arch === "wasm32"` (packages/runtime/
// builtins/process.js), in-VM npm auto-selects that wasm binding — exactly the
// Stage 2c path that already brings in `@rolldown/binding-wasm32-wasi` and
// `@node-rs/*`. `@rspack/binding`'s generated loader then falls back to it and
// `require('@rspack/core')` works unmodified.
//
// The open question this spike answers: whether the `wasm32-wasip1-threads`
// binding runs in-VM (emnapi/wasi-threads) or hits the Stage 2b async-work block.
//
// Gates (all must pass):
//   1) install pulls @rspack/binding-wasm32-wasi (NOT a native @rspack/binding-*),
//   2) `rspack build` produces dist/main.js (the decisive threading test),
//   3) `rspack serve` binds its port and GET / -> 200 with the page marker.
//
//   1) vendor npm:  rm -rf /tmp/vv-vendor && mkdir -p /tmp/vv-vendor \
//        && (cd /tmp/vv-vendor && npm install npm@10.9.2 --no-save --no-audit --no-fund)
//   2) run (Node 22+):  node scripts/spike-rspack.mjs
//      env: VV_LIVE=1 (stream output), VV_INSTALL_ONLY=1 (stop after install),
//           VV_NO_SERVE=1 (stop after build), VV_WSPROBE=1 (HMR ws probe).

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { stubNodeGyp } from "../packages/kernel-host/node-gyp-stub.js";
import { initTransferList } from "../packages/kernel-host/worker-transfer.js";
import { Worker, MessageChannel } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";

const VENDOR_NPM = process.argv[2] || "/tmp/vv-vendor/node_modules/npm";
const VFS_NPM = "/usr/lib/node_modules/npm";
if (!fs.existsSync(path.join(VENDOR_NPM, "bin/npm-cli.js"))) {
  console.error(`No vendored npm at ${VENDOR_NPM} (expected bin/npm-cli.js).`);
  console.error(`Vendor it:  rm -rf /tmp/vv-vendor && mkdir -p /tmp/vv-vendor && (cd /tmp/vv-vendor && npm install npm@10.9.2 --no-save --no-audit --no-fund)`);
  process.exit(2);
}

const LIVE = process.env.VV_LIVE === "1";
const DIR = "/rspack";
const PORT = Number(process.env.VV_PORT || 8081);

// ── kernel setup (same shape as spike-webpack.mjs) ───────────────────────────
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
  if (info.threadPort) init.threadPort = info.threadPort;
  // A worker pool (tinypool, piscina, synckit) puts a MessagePort in workerData;
  // initTransferList is what knows those must be transferred on to the child.
  w.postMessage(init, initTransferList(info, port1));
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

// ── Rspack project source ────────────────────────────────────────────────────
kernel.mkdirp(DIR + "/src");
kernel.writeFile(
  DIR + "/package.json",
  JSON.stringify(
    {
      name: "rspack-app",
      version: "0.1.0",
      private: true,
      scripts: {
        dev: "rspack serve --mode development",
        build: "rspack build --mode production",
      },
      devDependencies: {
        "@rspack/core": "^1.5.0",
        "@rspack/cli": "^1.5.0",
      },
    },
    null,
    2,
  ),
);
kernel.writeFile(
  DIR + "/rspack.config.js",
  `const path = require("path");
const rspack = require("@rspack/core");

module.exports = {
  mode: "development",
  entry: "./src/index.js",
  output: { path: path.resolve(__dirname, "dist"), filename: "main.js", clean: true },
  experiments: { css: true },
  module: {
    rules: [
      { test: /\\.css$/i, type: "css" },
    ],
  },
  plugins: [new rspack.HtmlRspackPlugin({ template: "./src/index.html" })],
  devServer: {
    port: ${PORT},
    host: "127.0.0.1",
    hot: true,
    open: false,
    allowedHosts: "all",
    client: { overlay: false },
  },
};
`,
);
kernel.writeFile(
  DIR + "/src/index.html",
  `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Rspack in Vivari</title></head>
<body>
  <h1 id="marker">Rspack in Vivari</h1>
  <div id="app"></div>
</body>
</html>
`,
);
kernel.writeFile(
  DIR + "/src/styles.css",
  `body { font-family: system-ui, sans-serif; padding: 2rem; }
button { padding: 0.5rem 1rem; font-size: 1rem; }
`,
);
kernel.writeFile(
  DIR + "/src/index.js",
  `import "./styles.css";

let count = 0;
const app = document.getElementById("app");
const btn = document.createElement("button");
btn.textContent = "count is " + count;
btn.addEventListener("click", () => { count++; btn.textContent = "count is " + count; });
app.appendChild(btn);

if (module.hot) module.hot.accept();
`,
);

const env = {
  HOME: "/home/user",
  PATH: DIR + "/node_modules/.bin:/bin",
  npm_config_cache: "/tmp/.npm",
  NODE_ENV: "development",
  VV_LIVE: LIVE ? "1" : "",
};

// ── gate 1: install ──────────────────────────────────────────────────────────
console.log(`\n== npm install (@rspack/core + @rspack/cli) ==`);
const INSTALL_TIMEOUT = Number(process.env.VV_INSTALL_TIMEOUT || 420000);
const t1 = Date.now();
let installTimedOut = false;
const inst = await Promise.race([
  kernel.start("node", [VFS_NPM + "/bin/npm-cli.js", "install", "--no-audit", "--no-fund"], { cwd: DIR, env, capture: !LIVE }),
  new Promise((r) => setTimeout(() => { installTimedOut = true; r({ code: 124 }); }, INSTALL_TIMEOUT)),
]);
console.log(`  install exit=${inst.code}${installTimedOut ? " (TIMED OUT)" : ""}  (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
if (inst.code !== 0) {
  console.log("  STDERR tail:\n" + ((inst.stderr || out.join("")).slice(-3000)));
  process.exit(1);
}

// The wasm binding must be the one that got installed (never a native platform pkg).
const wasmBinding = kernel.exists(DIR + "/node_modules/@rspack/binding-wasm32-wasi");
const nativeBinding = ["darwin-x64", "darwin-arm64", "linux-x64-gnu", "linux-arm64-gnu", "win32-x64-msvc"].some(
  (p) => kernel.exists(DIR + "/node_modules/@rspack/binding-" + p),
);
const coreBin = kernel.exists(DIR + "/node_modules/@rspack/core/dist/index.js");
const cliBin =
  kernel.exists(DIR + "/node_modules/@rspack/cli/bin/rspack.js") ||
  kernel.exists(DIR + "/node_modules/.bin/rspack");
console.log("  @rspack/binding-wasm32-wasi present: " + wasmBinding);
console.log("  a NATIVE @rspack/binding-* present:  " + nativeBinding + (nativeBinding ? "  (BAD)" : ""));
console.log("  @rspack/core present:                " + coreBin);
console.log("  rspack CLI bin present:              " + cliBin);

if (process.env.VV_INSTALL_ONLY === "1") {
  console.log("\nVV_INSTALL_ONLY=1 — stopping after install.");
  process.exit(inst.code === 0 && wasmBinding && !nativeBinding && coreBin && cliBin ? 0 : 1);
}

// resolve the CLI entry once (bin path differs across @rspack/cli minors)
const CLI = kernel.exists(DIR + "/node_modules/@rspack/cli/bin/rspack.js")
  ? "node_modules/@rspack/cli/bin/rspack.js"
  : "node_modules/.bin/rspack";

// ── gate 2: `rspack build` produces a bundle (the decisive threading test) ────
console.log("\n== rspack build ==");
const buildStart = out.length;
const tbuild = Date.now();
const BUILD_TIMEOUT = Number(process.env.VV_BUILD_TIMEOUT || 300000);
let buildTimedOut = false;
const build = await Promise.race([
  kernel.start("node", [CLI, "build", "--mode", "production"], { cwd: DIR, env, capture: !LIVE }),
  new Promise((r) => setTimeout(() => { buildTimedOut = true; r({ code: 124 }); }, BUILD_TIMEOUT)),
]);
console.log(`  build exit=${build.code}${buildTimedOut ? " (TIMED OUT)" : ""}  (${((Date.now() - tbuild) / 1000).toFixed(1)}s)`);
const builtBundle = kernel.exists(DIR + "/dist/main.js");
const builtHtml = kernel.exists(DIR + "/dist/index.html");
console.log("  dist/main.js emitted:    " + builtBundle);
console.log("  dist/index.html emitted: " + builtHtml);
if (!builtBundle) {
  console.log("\n---- build output tail (last 4000 chars) ----\n" + out.slice(buildStart).join("").slice(-4000));
}

if (process.env.VV_NO_SERVE === "1" || !builtBundle) {
  const ok = build.code === 0 && builtBundle;
  console.log("\nRESULT: " + (ok ? "PASS (build only) — Rspack compiled a bundle in-VM" : "FAIL — see logs above"));
  process.exit(ok ? 0 : 1);
}

// ── gate 3: `rspack serve` binds the port + GET / -> 200 ─────────────────────
// `rspack serve` uses @rspack/dev-server, which @rspack/cli already pulls in as
// its own dependency (a version-matched peer) — so no extra install is needed.
console.log("\n== rspack serve ==");
const devStart = out.length;
kernel.start("node", [CLI, "serve", "--mode", "development"], { cwd: DIR, env });
const BIND_TIMEOUT = Number(process.env.VV_BIND_TIMEOUT || 240000);
const tb = Date.now();
let fatal = "";
while (!listening.has(PORT) && Date.now() - tb < BIND_TIMEOUT && !fatal) {
  await new Promise((r) => setTimeout(r, 100));
  const tail = out.slice(devStart).join("");
  const m = tail.match(/Cannot find module '([^']+)'|Error: ([^\n]*is not (?:a function|supported)[^\n]*)/);
  if (m) fatal = m[0];
}
if (fatal) console.log(`  early-abort: ${fatal}`);
const bound = listening.has(PORT);
console.log(`  listening on ${PORT}: ${bound}  (${((Date.now() - tb) / 1000).toFixed(1)}s)`);

let getOk = false;
if (bound) {
  const decode = (b) => (typeof b === "string" ? b : Buffer.from(b).toString());
  const get = (url) => kernel.handleHttpRequest(PORT, { port: PORT, method: "GET", url, headers: { host: "127.0.0.1:" + PORT }, body: "" });
  let root = await get("/");
  for (let i = 0; i < 60 && (root.status === 502 || root.status === 404 || root.status >= 500); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    root = await get("/");
  }
  const body = decode(root.body || "");
  getOk = root.status === 200 && /Rspack in Vivari|id="marker"/.test(body);
  console.log(`  GET / -> ${root.status}  (${body.length} bytes)`);
  console.log("  body head: " + body.slice(0, 200).replace(/\n/g, " "));
  console.log("  bundle script present: " + /main\.js|bundle/.test(body));
} else {
  console.log("\n---- dev output tail (last 4000 chars) ----\n" + out.slice(devStart).join("").slice(-4000));
}

// ── optional: HMR ws probe (rspack dev-server serves /ws) ────────────────────
if (process.env.VV_WSPROBE === "1" && bound) {
  console.log("\n== HMR ws probe ==");
  const frames = [];
  kernel.onWsSend = (m) => {
    let text = m.data;
    if (m.data && typeof m.data !== "string") {
      try { text = Buffer.from(m.data).toString("utf8"); } catch { text = "<binary>"; }
    }
    frames.push({ sub: m.sub, code: m.code });
    console.log(`  [ws ${m.sub}] ${m.code ? "code=" + m.code + " " : ""}${typeof text === "string" ? text.slice(0, 160) : ""}`);
  };
  const connId = "probe-" + Math.random().toString(36).slice(2, 8);
  kernel.handleWsClient({ sub: "open", connId, port: PORT, path: "/ws" });
  const t = Date.now();
  while (Date.now() - t < 6000) await new Promise((r) => setTimeout(r, 500));
  const opens = frames.filter((f) => f.sub === "open").length;
  const msgs = frames.filter((f) => f.sub === "msg").length;
  console.log(`  ws summary: opens=${opens} msgs=${msgs} over 6s`);
}

const ok = inst.code === 0 && wasmBinding && !nativeBinding && coreBin && cliBin && build.code === 0 && builtBundle && bound && getOk;
console.log("\nRESULT: " + (ok ? "PASS — Rspack builds AND serves / with 200 in-VM (wasm32-wasi binding)" : "FAIL — see logs above"));
process.exit(ok ? 0 : 1);