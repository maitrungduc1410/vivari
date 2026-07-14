// Spike (NETWORK): prove standalone Webpack 5 + webpack-dev-server boots + serves
// in-VM. Next's `--webpack` path already proves webpack's compiler runs; this
// proves the *standalone* dev server (webpack-dev-server v5 = connect + `ws` HMR
// + chokidar watch — all proven primitives) binds a port and serves the app.
//
// Gates (all must pass): install ok, `webpack serve` binds its port, GET / -> 200
// with the page marker. Optional HMR ws probe: OC_WSPROBE=1.
//
//   1) vendor npm:  rm -rf /tmp/oc-vendor && mkdir -p /tmp/oc-vendor \
//        && (cd /tmp/oc-vendor && npm install npm@10.9.2 --no-save --no-audit --no-fund)
//   2) run (Node 22+):  node scripts/spike-webpack.mjs

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
  console.error(`Vendor it:  rm -rf /tmp/oc-vendor && mkdir -p /tmp/oc-vendor && (cd /tmp/oc-vendor && npm install npm@10.9.2 --no-save --no-audit --no-fund)`);
  process.exit(2);
}

const LIVE = process.env.OC_LIVE === "1";
const DIR = "/wp";
const PORT = Number(process.env.OC_PORT || 8080);

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

// ── Webpack 5 project source ─────────────────────────────────────────────────
kernel.mkdirp(DIR + "/src");
kernel.writeFile(
  DIR + "/package.json",
  JSON.stringify(
    {
      name: "webpack-app",
      version: "0.1.0",
      private: true,
      scripts: {
        dev: `webpack serve --mode development`,
        build: "webpack --mode production",
      },
      devDependencies: {
        webpack: "^5.97.1",
        "webpack-cli": "^5.1.4",
        "webpack-dev-server": "^5.2.0",
        "html-webpack-plugin": "^5.6.3",
        "css-loader": "^7.1.2",
        "style-loader": "^4.0.0",
      },
    },
    null,
    2,
  ),
);
kernel.writeFile(
  DIR + "/webpack.config.js",
  `const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");

module.exports = {
  mode: "development",
  entry: "./src/index.js",
  output: { path: path.resolve(__dirname, "dist"), filename: "main.js", clean: true },
  module: { rules: [{ test: /\\.css$/i, use: ["style-loader", "css-loader"] }] },
  plugins: [new HtmlWebpackPlugin({ template: "./src/index.html" })],
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
<head><meta charset="utf-8"><title>Webpack in OpenContainer</title></head>
<body>
  <h1 id="marker">Webpack in OpenContainer</h1>
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
  OC_LIVE: LIVE ? "1" : "",
};

// ── gate 1: install ──────────────────────────────────────────────────────────
console.log(`\n== npm install (webpack + webpack-dev-server) ==`);
const INSTALL_TIMEOUT = Number(process.env.OC_INSTALL_TIMEOUT || 300000);
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
const wpBin = kernel.exists(DIR + "/node_modules/webpack/bin/webpack.js");
const wdsBin = kernel.exists(DIR + "/node_modules/webpack-dev-server/bin/webpack-dev-server.js");
console.log("  webpack bin present:            " + wpBin);
console.log("  webpack-dev-server bin present: " + wdsBin);

if (process.env.OC_INSTALL_ONLY === "1") {
  console.log("\nOC_INSTALL_ONLY=1 — stopping after install.");
  process.exit(inst.code === 0 && wpBin && wdsBin ? 0 : 1);
}

// ── gate 2: webpack serve binds the port ─────────────────────────────────────
console.log("\n== webpack serve ==");
const devStart = out.length;
kernel.start("node", ["node_modules/webpack/bin/webpack.js", "serve", "--mode", "development"], { cwd: DIR, env });
const BIND_TIMEOUT = Number(process.env.OC_BIND_TIMEOUT || 240000);
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

// ── gate 3: GET / -> 200 with the marker ─────────────────────────────────────
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
  getOk = root.status === 200 && /Webpack in OpenContainer|id="marker"/.test(body);
  console.log(`  GET / -> ${root.status}  (${body.length} bytes)`);
  console.log("  body head: " + body.slice(0, 200).replace(/\n/g, " "));
  // The dev-server-injected HMR client script proves the ws bundle wired up.
  console.log("  bundle script present: " + /main\.js|bundle/.test(body));
} else {
  console.log("\n---- dev output tail (last 4000 chars) ----\n" + out.slice(devStart).join("").slice(-4000));
}

// ── optional: HMR ws probe (webpack-dev-server serves /ws) ────────────────────
if (process.env.OC_WSPROBE === "1" && bound) {
  console.log("\n== HMR ws probe ==");
  const frames = [];
  kernel.onWsSend = (m) => {
    let text = m.data;
    if (m.data && typeof m.data !== "string") {
      try { text = Buffer.from(m.data).toString("utf8"); } catch { text = "<binary>"; }
    }
    frames.push({ sub: m.sub, code: m.code, data: typeof text === "string" ? text.slice(0, 200) : text });
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

const ok = inst.code === 0 && wpBin && wdsBin && bound && getOk;
console.log("\nRESULT: " + (ok ? "PASS — Webpack 5 + webpack-dev-server boots and serves / with 200" : "FAIL — see logs above"));
process.exit(ok ? 0 : 1);
