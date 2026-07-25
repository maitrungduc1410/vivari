// Spike (NETWORK): prove VitePress (`vitepress dev`) boots + serves in-VM.
//
// VitePress was dropped once because its Shiki highlighter used `synckit` (a
// worker_threads Worker drained with Atomics.wait + receiveMessageOnPort, which a
// browser worker can't service). VitePress dropped synckit in 1.6.0
// (markdown-it-async + Shiki v3), so highlighted code blocks no longer deadlock.
// VitePress also bundles its own `.vitepress/config.*` via esbuild. An ESM config
// is loaded with `await import(file://…temp.mjs)`, which does NOT settle in-VM and
// hangs boot; a CommonJS config takes Vite's synchronous CJS branch instead. This
// spike ships a REAL CommonJS config (package NOT `type: module`) to exercise the
// path the studio template actually uses.
//
// Gates (all must pass): install ok, `vitepress dev` binds its port, GET base
// returns 200 with the VitePress app shell, and a page with a fenced code block
// serves 200 with Shiki highlight markup (proves highlighting ran, no deadlock).
//
//   1) vendor npm:  rm -rf /tmp/vv-vendor && mkdir -p /tmp/vv-vendor \
//        && (cd /tmp/vv-vendor && npm install npm@10.9.2 --no-save --no-audit --no-fund)
//   2) run (Node 22+):  node scripts/spike-vitepress.mjs

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { stubNodeGyp } from "../packages/kernel-host/node-gyp-stub.js";
import { createAliasedFetcher } from "./lib/aliased-fetcher.mjs";
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
const PORT = Number(process.env.VV_PORT || 5173);
// The shipped studio template serves VitePress under the preview proxy prefix
// (Vite `base` "/preview/5173/", keepPreviewPrefix) so its history-mode router
// resolves the first route. Set VV_BASEURL=/preview/5173/ to exercise that path
// here; default "/" keeps the fast/plain regression run.
const BASEURL = process.env.VV_BASEURL || "/";

// ── kernel setup (same shape as spike-docusaurus.mjs) ────────────────────────
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
// Transparent native->wasm packument aliasing (esbuild/rollup/lightningcss),
// mirroring the browser kernel — VitePress pulls Vite 5 + esbuild + rollup.
const fetcher = createAliasedFetcher();

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

// ── minimal VitePress site (mirrors the shipped studio template) ─────────────
const VITEPRESS_VERSION = process.env.VV_VITEPRESS_VERSION || "^1.6.0";
kernel.mkdirp(DIR + "/.vitepress");
kernel.mkdirp(DIR + "/guide");
kernel.writeFile(
  DIR + "/package.json",
  JSON.stringify(
    {
      name: "vitepress-site",
      private: true,
      // NOT "type": "module": forces Vite's synchronous CJS config branch (see header).
      scripts: {
        dev: `vitepress dev --port ${PORT} --host 127.0.0.1 --strictPort`,
        build: "vitepress build",
      },
      devDependencies: {
        vitepress: VITEPRESS_VERSION,
        vue: "^3.5.0",
      },
    },
    null,
    2,
  ),
);
kernel.writeFile(
  DIR + "/.vitepress/config.js",
  `// CommonJS on purpose — Vite loads this via require.extensions + module._compile
// (synchronous), instead of \`await import(file://…)\` which hangs in-VM.
// Pre-load the code-block languages: VitePress otherwise lazily loads them via
// synckit, which works under Node's real worker_threads (so this headless spike
// wouldn't catch a miss) but throws in a browser worker. Keep in sync with the
// shipped studio template.
module.exports = {
  base: "${BASEURL}",
  title: "VitePress in Vivari",
  description: "Docs that build and run entirely in the browser VM",
  markdown: {
    languages: ["js", "ts", "jsx", "tsx", "json", "yaml", "bash", "shell", "html", "css", "vue", "md"],
  },
  themeConfig: {
    nav: [
      { text: "Home", link: "/" },
      { text: "Guide", link: "/guide/getting-started" },
    ],
    sidebar: [
      { text: "Guide", items: [{ text: "Getting Started", link: "/guide/getting-started" }] },
    ],
  },
};
`,
);
kernel.writeFile(
  DIR + "/index.md",
  `---
layout: home
hero:
  name: VitePress in Vivari
  text: Docs, in the browser VM
  tagline: Vue-powered static site generator running fully client-side
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
---
`,
);
kernel.writeFile(
  DIR + "/guide/getting-started.md",
  `# Getting Started

Welcome to **VitePress**, running inside Vivari's in-browser VM.

\`\`\`ts
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
console.log(greet("Vivari"));
\`\`\`
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

// ── gate 1: install ──────────────────────────────────────────────────────────
console.log(`\n== npm install (vitepress + vue) ==`);
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
const vbin = kernel.exists(DIR + "/node_modules/vitepress/bin/vitepress.js");
console.log("  vitepress bin present: " + vbin);

if (process.env.VV_INSTALL_ONLY === "1") {
  console.log("\nVV_INSTALL_ONLY=1 — stopping after install.");
  process.exit(inst.code === 0 && vbin ? 0 : 1);
}

// ── gate 2: vitepress dev binds the port ─────────────────────────────────────
console.log("\n== vitepress dev ==");
const devStart = out.length;
kernel.start(
  "node",
  ["node_modules/vitepress/bin/vitepress.js", "dev", "--port", String(PORT), "--host", "127.0.0.1", "--strictPort"],
  { cwd: DIR, env },
);
const BIND_TIMEOUT = Number(process.env.VV_BIND_TIMEOUT || 360000);
const tb = Date.now();
let fatal = "";
while (!listening.has(PORT) && Date.now() - tb < BIND_TIMEOUT && !fatal) {
  await new Promise((r) => setTimeout(r, 100));
  const tail = out.slice(devStart).join("");
  const m = tail.match(/Cannot find module '([^']+)'|Error: ([^\n]*is not (?:a function|supported)[^\n]*)|could not be cloned/);
  if (m) fatal = m[0];
}
if (fatal) console.log(`  early-abort: ${fatal}`);
const bound = listening.has(PORT);
console.log(`  listening on ${PORT}: ${bound}  (${((Date.now() - tb) / 1000).toFixed(1)}s)`);

// ── gate 3+4: GET base -> 200 shell; guide page -> 200 with Shiki highlight ──
let getOk = false;
let hlOk = false;
if (bound) {
  const decode = (b) => (typeof b === "string" ? b : Buffer.from(b).toString());
  const get = (url) => kernel.handleHttpRequest(PORT, { port: PORT, method: "GET", url, headers: { host: "127.0.0.1:" + PORT }, body: "" });
  const join = (p) => (BASEURL === "/" ? "/" + p : BASEURL + p);

  // Home / app shell.
  let root = await get(BASEURL);
  for (let i = 0; i < 120 && (root.status === 502 || root.status === 404 || root.status >= 500); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    root = await get(BASEURL);
  }
  const body = decode(root.body || "");
  getOk = root.status === 200 && /id="app"|VitePress in Vivari|VPContent|vp-doc/.test(body);
  console.log(`  GET ${BASEURL} -> ${root.status}  (${body.length} bytes)`);
  console.log("  body head: " + body.slice(0, 220).replace(/\n/g, " "));

  // Guide page: must render (highlighting runs during transform, so a 200 here
  // already proves no synckit deadlock) and carry Shiki markup.
  const guide = await get(join("guide/getting-started"));
  const gbody = decode(guide.body || "");
  hlOk = guide.status === 200 && /class="shiki|language-ts|style="color:|class="line"/.test(gbody);
  console.log(`  GET ${join("guide/getting-started")} -> ${guide.status}  shiki=${hlOk}  (${gbody.length} bytes)`);
} else {
  console.log("\n---- dev output tail (last 4000 chars) ----\n" + out.slice(devStart).join("").slice(-4000));
}

const ok = inst.code === 0 && vbin && bound && getOk && hlOk;
console.log("\nRESULT: " + (ok ? "PASS — VitePress boots, serves the site, and highlights code in-VM" : "FAIL — see logs above"));
process.exit(ok ? 0 : 1);