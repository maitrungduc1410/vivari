// Spike (NETWORK): prove Docusaurus 3 (`docusaurus start`) boots + serves in-VM.
// Docusaurus 3's dev server is webpack + webpack-dev-server (proven by
// spike-webpack.mjs) plus MDX/Babel/React. This is the heaviest Phase-4 target:
// the install pulls hundreds of packages and the first compile is slow.
//
// Gates (all must pass): install ok, `docusaurus start` binds its port, GET /
// returns 200 with the Docusaurus app shell (#__docusaurus / site title).
//
//   1) vendor npm:  rm -rf /tmp/vv-vendor && mkdir -p /tmp/vv-vendor \
//        && (cd /tmp/vv-vendor && npm install npm@10.9.2 --no-save --no-audit --no-fund)
//   2) run (Node 22+):  node scripts/spike-docusaurus.mjs

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
const DIR = "/docs-site";
const PORT = Number(process.env.VV_PORT || 3000);
// The shipped studio template serves Docusaurus under the preview proxy prefix
// (baseUrl "/preview/3000/", keepPreviewPrefix) so its client router resolves the
// first route. Set VV_BASEURL=/preview/3000/ to exercise that base-prefixed path
// here (GET the base, plus an asset under it, should both 200); default "/" keeps
// the fast/plain regression run.
const BASEURL = process.env.VV_BASEURL || "/";

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

// ── minimal classic Docusaurus site ──────────────────────────────────────────
const DOCUSAURUS_VERSION = process.env.VV_DOCUSAURUS_VERSION || "^3.6.0";
kernel.mkdirp(DIR + "/docs");
kernel.mkdirp(DIR + "/src/css");
kernel.mkdirp(DIR + "/static");
kernel.writeFile(
  DIR + "/package.json",
  JSON.stringify(
    {
      name: "docs-site",
      version: "0.1.0",
      private: true,
      scripts: {
        dev: `docusaurus start --port ${PORT} --host 127.0.0.1 --no-open`,
        build: "docusaurus build",
      },
      dependencies: {
        "@docusaurus/core": DOCUSAURUS_VERSION,
        "@docusaurus/preset-classic": DOCUSAURUS_VERSION,
        "@mdx-js/react": "^3.0.0",
        clsx: "^2.0.0",
        "prism-react-renderer": "^2.3.0",
        react: "^18.0.0",
        "react-dom": "^18.0.0",
      },
    },
    null,
    2,
  ),
);
kernel.writeFile(
  DIR + "/docusaurus.config.js",
  `module.exports = {
  title: "Docusaurus in Vivari",
  tagline: "Docs run in-VM",
  url: "http://localhost",
  baseUrl: "${BASEURL}",
  onBrokenLinks: "ignore",
  onBrokenMarkdownLinks: "ignore",
  favicon: undefined,
  presets: [
    [
      "@docusaurus/preset-classic",
      {
        docs: { sidebarPath: require.resolve("./sidebars.js"), routeBasePath: "/" },
        blog: false,
        theme: { customCss: require.resolve("./src/css/custom.css") },
      },
    ],
  ],
  themeConfig: {
    navbar: { title: "Docusaurus in Vivari", items: [] },
  },
};
`,
);
kernel.writeFile(
  DIR + "/sidebars.js",
  `module.exports = { tutorialSidebar: [{ type: "autogenerated", dirName: "." }] };\n`,
);
kernel.writeFile(DIR + "/src/css/custom.css", `:root { --ifm-color-primary: #2e8555; }\n`);
kernel.writeFile(
  DIR + "/docs/intro.md",
  `---
slug: /
title: Docusaurus in Vivari
---

# Docusaurus in Vivari

Hello from Vivari — a full Docusaurus dev server compiled in the browser VM.
`,
);

const env = {
  HOME: "/home/user",
  PATH: DIR + "/node_modules/.bin:/bin",
  npm_config_cache: "/tmp/.npm",
  NODE_ENV: "development",
  VV_LIVE: LIVE ? "1" : "",
  VV_TRACE_MODULES: process.env.VV_TRACE_MODULES || "",
};

// ── gate 1: install (large) ──────────────────────────────────────────────────
console.log(`\n== npm install (@docusaurus/core + preset-classic) ==`);
const INSTALL_TIMEOUT = Number(process.env.VV_INSTALL_TIMEOUT || 600000);
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
const dbin = kernel.exists(DIR + "/node_modules/@docusaurus/core/bin/docusaurus.mjs");
console.log("  docusaurus bin present: " + dbin);

if (process.env.VV_INSTALL_ONLY === "1") {
  console.log("\nOC_INSTALL_ONLY=1 — stopping after install.");
  process.exit(inst.code === 0 && dbin ? 0 : 1);
}

// ── diagnostic: run start captured (it crashes at load → returns fast) ────────
if (process.env.VV_STARTCAP === "1") {
  console.log("\n== docusaurus start (captured) ==");
  const r = await Promise.race([
    kernel.start(
      "node",
      ["node_modules/@docusaurus/core/bin/docusaurus.mjs", "start", "--port", String(PORT), "--host", "127.0.0.1", "--no-open"],
      { cwd: DIR, env, capture: true },
    ),
    new Promise((res) => setTimeout(() => res({ code: 124, stdout: "", stderr: "(timeout)" }), 60000)),
  ]);
  console.log("exit=" + r.code + "\n--- stdout ---\n" + (r.stdout || "") + "\n--- stderr ---\n" + (r.stderr || ""));
  process.exit(0);
}

// ── gate 2: docusaurus start binds the port ──────────────────────────────────
console.log("\n== docusaurus start ==");
const devStart = out.length;
kernel.start(
  "node",
  ["node_modules/@docusaurus/core/bin/docusaurus.mjs", "start", "--port", String(PORT), "--host", "127.0.0.1", "--no-open"],
  { cwd: DIR, env },
);
const BIND_TIMEOUT = Number(process.env.VV_BIND_TIMEOUT || 360000);
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

// ── gate 3: GET / -> 200 with the Docusaurus app shell ───────────────────────
let getOk = false;
if (bound) {
  const decode = (b) => (typeof b === "string" ? b : Buffer.from(b).toString());
  const get = (url) => kernel.handleHttpRequest(PORT, { port: PORT, method: "GET", url, headers: { host: "127.0.0.1:" + PORT }, body: "" });
  // Mirror the SW's keep-prefix behaviour: request paths exactly as the browser
  // would under this baseUrl (the dev server serves the app AT baseUrl).
  const home = BASEURL;
  let root = await get(home);
  for (let i = 0; i < 120 && (root.status === 502 || root.status === 404 || root.status >= 500); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    root = await get(home);
  }
  const body = decode(root.body || "");
  getOk = root.status === 200 && /__docusaurus|Docusaurus in Vivari/.test(body);
  console.log(`  GET ${home} -> ${root.status}  (${body.length} bytes)`);
  console.log("  body head: " + body.slice(0, 220).replace(/\n/g, " "));
  // For a base-prefixed run, prove an asset also serves under the prefix — this is
  // exactly the path the browser requests and the SW forwards un-stripped.
  if (getOk && BASEURL !== "/") {
    const sm = body.match(/<script[^>]+src="([^"]+)"/i);
    if (sm) {
      const asset = await get(sm[1]);
      const ct = (asset.headers && (asset.headers["content-type"] || asset.headers["Content-Type"])) || "";
      const assetOk = asset.status === 200 && !/text\/html/.test(ct);
      console.log(`  GET ${sm[1]} -> ${asset.status} (${ct}) assetOk=${assetOk}`);
      getOk = assetOk;
    } else {
      console.log("  (no <script src> found in shell to verify asset serving)");
    }
  }
} else {
  console.log("\n---- dev output tail (last 4000 chars) ----\n" + out.slice(devStart).join("").slice(-4000));
}

const ok = inst.code === 0 && dbin && bound && getOk;
console.log("\nRESULT: " + (ok ? "PASS — Docusaurus 3 boots and serves / with 200" : "FAIL — see logs above"));
process.exit(ok ? 0 : 1);
