// Spike (NETWORK): prove Tailwind CSS v4 (@tailwindcss/vite) boots + serves a real
// React app in-VM, with its two native addons resolved through the runtime's
// wasm shims.
//
// Tailwind v4 reaches for two Rust addons that have no plain wasm32 build in their
// own package: `lightningcss` (the CSS transformer) and `@tailwindcss/oxide` (the
// class scanner). Both are handled by the runtime:
//   - lightningcss -> lightningcss-wasm  (NATIVE_WASM_ALIASES in
//     packages/runtime/toolchain-shims.js): the alias serves lightningcss-wasm's
//     tarball under the `lightningcss` name; its node/require build (wasm-node.cjs)
//     sync-inits the wasm at load and exposes the native surface.
//   - @tailwindcss/oxide -> @tailwindcss/oxide-wasm32-wasi (auto-selected by the
//     in-VM npm's wasm32 optional-dep gating, like every other napi-rs addon).
//
// Gates (all must pass):
//   1) install exit 0; node_modules/lightningcss carries lightningcss_node.wasm
//      (proves the alias fired) and @tailwindcss/oxide-wasm32-wasi is present
//      while NO native oxide/lightningcss binding is,
//   2) `vite` binds its port,
//   3) GET / -> 200 with the app HTML,
//   4) the served CSS module contains Tailwind-generated output (a used utility +
//      the @theme token), proving lightningcss-wasm actually transformed the CSS.
//
// Prereqs / run:
//   1) vendor npm:  rm -rf /tmp/vv-vendor && mkdir -p /tmp/vv-vendor \
//        && (cd /tmp/vv-vendor && npm install npm@10.9.2 --no-save --no-audit --no-fund)
//   2) run (Node 22+):  node scripts/spike-tailwind.mjs
//      env: VV_LIVE=1 (stream), VV_INSTALL_ONLY=1.

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { stubNodeGyp } from "../packages/kernel-host/node-gyp-stub.js";
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
const DIR = "/tailwind";
const PORT = Number(process.env.VV_PORT || 5199);

// ── kernel setup (same shape as spike-rsbuild.mjs) ───────────────────────────
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

// ── Tailwind v4 + Vite + React project source ────────────────────────────────
kernel.mkdirp(DIR + "/src");
kernel.writeFile(
  DIR + "/package.json",
  JSON.stringify(
    {
      name: "tailwind-app",
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: { dev: "vite", build: "vite build" },
      dependencies: {
        react: "^19.0.0",
        "react-dom": "^19.0.0",
      },
      devDependencies: {
        "@tailwindcss/vite": "^4.0.0",
        "@vitejs/plugin-react": "^5.0.0",
        tailwindcss: "^4.0.0",
        vite: "^8.0.0",
      },
    },
    null,
    2,
  ),
);
kernel.writeFile(
  DIR + "/vite.config.js",
  `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: ${PORT}, host: "127.0.0.1" },
});
`,
);
kernel.writeFile(
  DIR + "/index.html",
  `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Tailwind in Vivari</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
);
kernel.writeFile(
  DIR + "/src/index.css",
  `@import "tailwindcss";

@theme {
  --color-primary: #0f172a;
}
`,
);
kernel.writeFile(
  DIR + "/src/main.jsx",
  `import { createRoot } from "react-dom/client";
import "./index.css";

function App() {
  return (
    <main className="min-h-screen bg-primary text-white flex items-center justify-center">
      <h1 id="marker" className="text-3xl font-bold">Tailwind in Vivari</h1>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
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
console.log(`\n== npm install (tailwindcss v4 + @tailwindcss/vite + react) ==`);
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
// lightningcss alias fired if the wasm asset landed under the lightningcss name.
const lightningWasm =
  kernel.exists(DIR + "/node_modules/lightningcss/lightningcss_node.wasm") ||
  kernel.exists(DIR + "/node_modules/lightningcss-wasm/lightningcss_node.wasm");
const oxideWasm = kernel.exists(DIR + "/node_modules/@tailwindcss/oxide-wasm32-wasi");
const nativeOxide = ["darwin-x64", "darwin-arm64", "linux-x64-gnu", "linux-arm64-gnu", "win32-x64-msvc"].some(
  (p) => kernel.exists(DIR + "/node_modules/@tailwindcss/oxide-" + p),
);
const nativeLightning = ["darwin-x64", "darwin-arm64", "linux-x64-gnu", "linux-arm64-gnu", "win32-x64-msvc"].some(
  (p) => kernel.exists(DIR + "/node_modules/lightningcss-" + p),
);
const viteBin = kernel.exists(DIR + "/node_modules/.bin/vite");
console.log("  lightningcss wasm present:            " + lightningWasm);
console.log("  @tailwindcss/oxide-wasm32-wasi present: " + oxideWasm);
console.log("  a NATIVE oxide/lightningcss binding:  " + (nativeOxide || nativeLightning) + (nativeOxide || nativeLightning ? "  (BAD)" : ""));
console.log("  vite CLI bin present:                 " + viteBin);

if (process.env.VV_INSTALL_ONLY === "1") {
  console.log("\nVV_INSTALL_ONLY=1 — stopping after install.");
  process.exit(inst.code === 0 && lightningWasm && oxideWasm && !nativeOxide && !nativeLightning && viteBin ? 0 : 1);
}

// ── gate 2: `vite` binds the port ────────────────────────────────────────────
console.log("\n== vite (dev) ==");
const devStart = out.length;
// --configLoader native: the rolldown config bundler throws "Invalid URL" in-VM.
kernel.start("node", ["node_modules/vite/bin/vite.js", "--configLoader", "native"], { cwd: DIR, env });
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

// ── gates 3 + 4: GET / -> 200, and the CSS module carries generated utilities ─
let getOk = false;
let cssOk = false;
if (bound) {
  const decode = (b) => (typeof b === "string" ? b : Buffer.from(b).toString());
  const get = (url) => kernel.handleHttpRequest(PORT, { port: PORT, method: "GET", url, headers: { host: "127.0.0.1:" + PORT }, body: "" });
  let root = await get("/");
  for (let i = 0; i < 60 && (root.status === 502 || root.status === 404 || root.status >= 500); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    root = await get("/");
  }
  const body = decode(root.body || "");
  getOk = root.status === 200 && /Tailwind in Vivari|<div id="root">|<script/.test(body);
  console.log(`  GET / -> ${root.status}  (${body.length} bytes)`);

  // Vite serves the imported CSS at /src/index.css (a JS module that injects the
  // compiled stylesheet). Tailwind + lightningcss-wasm must have generated the
  // used utility (min-h-screen -> 100vh) and surfaced the @theme token.
  const css = await get("/src/index.css");
  const cssBody = decode(css.body || "");
  cssOk = css.status === 200 && (cssBody.includes("100vh") || cssBody.includes("min-h-screen")) && cssBody.includes("--color-primary");
  console.log(`  GET /src/index.css -> ${css.status}  (${cssBody.length} bytes)`);
  console.log("  CSS has generated utility + @theme token: " + cssOk);
} else {
  console.log("\n---- dev output tail (last 4000 chars) ----\n" + out.slice(devStart).join("").slice(-4000));
}

const ok =
  inst.code === 0 && lightningWasm && oxideWasm && !nativeOxide && !nativeLightning && viteBin && bound && getOk && cssOk;
console.log(
  "\nRESULT: " +
    (ok
      ? "PASS — Tailwind v4 dev server boots and serves generated CSS in-VM (lightningcss-wasm + oxide-wasm32-wasi)"
      : "FAIL — see logs above"),
);
process.exit(ok ? 0 : 1);