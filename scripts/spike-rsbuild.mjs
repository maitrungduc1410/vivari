// Spike (NETWORK): prove Rsbuild (the Rspack-powered build tool) boots + serves
// a real React app in-VM, with HMR over the WebSocket tunnel.
//
// Rsbuild wraps Rspack, so it rides the exact same in-VM path: our runtime reports
// `process.arch === "wasm32"`, npm auto-selects `@rspack/binding-wasm32-wasi`, and
// `@rsbuild/core`'s Rspack instance runs the Rust core as `wasm32-wasip1-threads`.
// spike-rspack.mjs proves the binding builds + serves; this proves the higher-level
// Rsbuild dev server (the thing users actually reach for) + `@rsbuild/plugin-react`.
//
// Gates (all must pass):
//   1) install pulls @rspack/binding-wasm32-wasi (NOT a native @rspack/binding-*),
//   2) `rsbuild dev` binds its port,
//   3) GET / -> 200 with the app HTML + a bundled script tag.
// Optional: VV_WSPROBE=1 opens the HMR socket and reports frames.
//
//   1) vendor npm:  rm -rf /tmp/vv-vendor && mkdir -p /tmp/vv-vendor \
//        && (cd /tmp/vv-vendor && npm install npm@10.9.2 --no-save --no-audit --no-fund)
//   2) run (Node 22+):  node scripts/spike-rsbuild.mjs
//      env: VV_LIVE=1 (stream), VV_INSTALL_ONLY=1, VV_WSPROBE=1.

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
const DIR = "/rsbuild";
const PORT = Number(process.env.VV_PORT || 3030);

// ── kernel setup (same shape as spike-rspack.mjs) ────────────────────────────
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

// ── Rsbuild + React project source ───────────────────────────────────────────
kernel.mkdirp(DIR + "/src");
kernel.writeFile(
  DIR + "/package.json",
  JSON.stringify(
    {
      name: "rsbuild-app",
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        dev: "rsbuild dev",
        build: "rsbuild build",
      },
      dependencies: {
        react: "^19.0.0",
        "react-dom": "^19.0.0",
      },
      devDependencies: {
        "@rsbuild/core": "^2.1.0",
        "@rsbuild/plugin-react": "^2.1.0",
      },
    },
    null,
    2,
  ),
);
kernel.writeFile(
  DIR + "/rsbuild.config.mjs",
  `import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

export default defineConfig({
  plugins: [pluginReact()],
  server: { port: ${PORT}, host: "127.0.0.1" },
  html: { title: "Rsbuild in Vivari" },
});
`,
);
kernel.writeFile(
  DIR + "/src/index.jsx",
  `import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";

createRoot(document.getElementById("root")).render(<App />);
`,
);
kernel.writeFile(
  DIR + "/src/App.jsx",
  `import { useState } from "react";

export function App() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1 id="marker">Rsbuild in Vivari</h1>
      <button onClick={() => setCount((c) => c + 1)}>count is {count}</button>
    </main>
  );
}
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
console.log(`\n== npm install (@rsbuild/core + @rsbuild/plugin-react + react) ==`);
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
const wasmBinding = kernel.exists(DIR + "/node_modules/@rspack/binding-wasm32-wasi");
const nativeBinding = ["darwin-x64", "darwin-arm64", "linux-x64-gnu", "linux-arm64-gnu", "win32-x64-msvc"].some(
  (p) => kernel.exists(DIR + "/node_modules/@rspack/binding-" + p),
);
const cliBin = kernel.exists(DIR + "/node_modules/.bin/rsbuild") || kernel.exists(DIR + "/node_modules/@rsbuild/core/bin/rsbuild.js");
console.log("  @rspack/binding-wasm32-wasi present: " + wasmBinding);
console.log("  a NATIVE @rspack/binding-* present:  " + nativeBinding + (nativeBinding ? "  (BAD)" : ""));
console.log("  rsbuild CLI bin present:             " + cliBin);

if (process.env.VV_INSTALL_ONLY === "1") {
  console.log("\nVV_INSTALL_ONLY=1 — stopping after install.");
  process.exit(inst.code === 0 && wasmBinding && !nativeBinding && cliBin ? 0 : 1);
}

const CLI = kernel.exists(DIR + "/node_modules/@rsbuild/core/bin/rsbuild.js")
  ? "node_modules/@rsbuild/core/bin/rsbuild.js"
  : "node_modules/.bin/rsbuild";

// ── gate 2: `rsbuild dev` binds the port ─────────────────────────────────────
console.log("\n== rsbuild dev ==");
const devStart = out.length;
kernel.start("node", [CLI, "dev"], { cwd: DIR, env });
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

// ── gate 3: GET / -> 200 with the app HTML ───────────────────────────────────
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
  getOk = root.status === 200 && /Rsbuild in Vivari|<div id="root">|<script/.test(body);
  console.log(`  GET / -> ${root.status}  (${body.length} bytes)`);
  console.log("  body head: " + body.slice(0, 200).replace(/\n/g, " "));
  console.log("  bundle script present: " + /<script/.test(body));
} else {
  console.log("\n---- dev output tail (last 4000 chars) ----\n" + out.slice(devStart).join("").slice(-4000));
}

// ── optional: HMR ws probe (Rsbuild dev server serves an HMR socket) ─────────
if (process.env.VV_WSPROBE === "1" && bound) {
  console.log("\n== HMR ws probe ==");
  const frames = [];
  kernel.onWsSend = (m) => {
    frames.push({ sub: m.sub, code: m.code });
    let text = m.data;
    if (m.data && typeof m.data !== "string") {
      try { text = Buffer.from(m.data).toString("utf8"); } catch { text = "<binary>"; }
    }
    console.log(`  [ws ${m.sub}] ${m.code ? "code=" + m.code + " " : ""}${typeof text === "string" ? text.slice(0, 160) : ""}`);
  };
  const connId = "probe-" + Math.random().toString(36).slice(2, 8);
  kernel.handleWsClient({ sub: "open", connId, port: PORT, path: "/rsbuild-hmr" });
  const t = Date.now();
  while (Date.now() - t < 6000) await new Promise((r) => setTimeout(r, 500));
  const opens = frames.filter((f) => f.sub === "open").length;
  const msgs = frames.filter((f) => f.sub === "msg").length;
  console.log(`  ws summary: opens=${opens} msgs=${msgs} over 6s`);
}

const ok = inst.code === 0 && wasmBinding && !nativeBinding && cliBin && bound && getOk;
console.log("\nRESULT: " + (ok ? "PASS — Rsbuild (React) dev server boots and serves / with 200 in-VM" : "FAIL — see logs above"));
process.exit(ok ? 0 : 1);