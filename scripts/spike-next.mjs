// Spike (NETWORK): prove Next.js 16 (App Router) boots + serves in-VM via
// `next dev --webpack` + the `@next/swc-wasm-nodejs` wasm SWC fallback.
//
// The old roadmap verdict called Next a "hard native wall". That predates Next 16
// specifics: webpack is still selectable (`--webpack`; Turbopack has no wasm build)
// and the SWC wasm fallback (`@next/swc-wasm-nodejs`) is intact. Next's loadBindings
// forces wasm when `process.versions.webcontainer` is set (see runtime process shim)
// — and npm already skips the native `@next/swc-<platform>` optionalDeps on arch
// `wasm32`, so the wasm build is the only SWC binding present.
//
// Gates (all must pass): install pulls wasm SWC (not native), `next dev --webpack`
// binds its port, GET / returns 200 HTML with the page content, and the compile log
// shows the wasm build was used.
//
//   1) vendor npm:  rm -rf /tmp/oc-vendor && mkdir -p /tmp/oc-vendor \
//        && (cd /tmp/oc-vendor && npm install npm@10.9.2 --no-save --no-audit --no-fund)
//   2) run (Node 22+):  node scripts/spike-next.mjs

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
const DIR = "/next";
const PORT = 3024;

// ── kernel setup (same shape as spike-npm.mjs) ───────────────────────────────
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
  // Without this, an in-VM uncaught throw propagates out of the worker_thread and
  // kills the whole spike before diagnostics flush. Log it and keep the harness up.
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
const kernel = new Kernel({
  fs: kernelFs.fs,
  spawnWorker,
  fetcher,
  stdout: cap,
  stderr: cap,
});
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

// ── App Router project source ────────────────────────────────────────────────
const NEXT_VERSION = process.env.OC_NEXT_VERSION || "16";
kernel.mkdirp(DIR + "/app");
kernel.writeFile(
  DIR + "/package.json",
  JSON.stringify(
    {
      name: "next-app",
      version: "0.1.0",
      private: true,
      scripts: {
        dev: `next dev --webpack -p ${PORT} -H 127.0.0.1`,
        build: "next build --webpack",
        start: `next start -p ${PORT}`,
      },
      dependencies: {
        next: NEXT_VERSION,
        react: "^19.0.0",
        "react-dom": "^19.0.0",
        // The wasm SWC fallback — pinned in lockstep with next (same range).
        "@next/swc-wasm-nodejs": NEXT_VERSION,
      },
    },
    null,
    2,
  ),
);
// Empty config: a custom webpack()/turbopack key would make Next 16 refuse to run.
kernel.writeFile(DIR + "/next.config.mjs", "const nextConfig = {};\nexport default nextConfig;\n");
kernel.writeFile(
  DIR + "/app/layout.js",
  `export const metadata = { title: "Next in OpenContainer" };
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
);
kernel.writeFile(
  DIR + "/app/page.js",
  `export default function Home() {
  return (
    <main>
      <h1 id="marker">Next.js App Router in OpenContainer</h1>
      <p>compiled by wasm SWC + webpack</p>
    </main>
  );
}
`,
);

const env = { HOME: "/home/user", PATH: DIR + "/node_modules/.bin:/bin", npm_config_cache: "/tmp/.npm", NODE_ENV: "development", OC_LIVE: LIVE ? "1" : "" };

// ── fork IPC self-test (isolates child_process.fork from Next) ────────────────
if (process.env.OC_FORKTEST === "1") {
  kernel.writeFile(
    "/fork-child.js",
    `console.log("CHILD start, has send=" + (typeof process.send));
process.on("message", (m) => { console.log("CHILD got " + JSON.stringify(m)); process.send({ pong: m.n + 1 }); if (m.n >= 2) process.exit(0); });
if (process.send) process.send({ ready: true });
else { console.log("CHILD no process.send!"); process.exit(3); }
`,
  );
  kernel.writeFile(
    "/fork-parent.js",
    `const cp = require("child_process");
const child = cp.fork("/fork-child.js");
child.on("message", (m) => { console.log("PARENT got " + JSON.stringify(m)); if (m.ready) child.send({ n: 1 }); else if (m.pong < 3) child.send({ n: m.pong }); });
child.on("exit", (c) => { console.log("PARENT child exit " + c); process.exit(c); });
child.on("error", (e) => { console.log("PARENT child error " + e.message); process.exit(1); });
`,
  );
  const r = await kernel.start("node", ["/fork-parent.js"], { cwd: "/", env, capture: true });
  console.log("── fork self-test ──\n" + (r.stdout || "") + (r.stderr ? "\nstderr:\n" + r.stderr : "") + "\nexit=" + r.code);
  process.exit(r.code === 0 ? 0 : 1);
}

// ── gate 1: install (must pull wasm SWC, not native) ─────────────────────────
console.log(`\n== npm install (next@${NEXT_VERSION} react react-dom @next/swc-wasm-nodejs) ==`);
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
const nextBin = kernel.exists(DIR + "/node_modules/next/dist/bin/next");
const wasmSwc = kernel.exists(DIR + "/node_modules/@next/swc-wasm-nodejs/package.json");
console.log("  next bin present:        " + nextBin);
console.log("  @next/swc-wasm-nodejs:   " + wasmSwc);
for (const p of ["@next/swc-darwin-arm64", "@next/swc-linux-x64-gnu"]) {
  console.log("  " + p + " (native, want false): " + kernel.exists(DIR + "/node_modules/" + p + "/package.json"));
}

// ── seed the wasm SWC cache from the installed package ───────────────────────
// Next's SWC loader can't resolve the installed @next/swc-wasm-nodejs directly
// (it does `import(pathToFileURL('@next/swc-wasm-nodejs'))`, which points at cwd,
// not node_modules), so it otherwise downloads the wasm at runtime. But
// downloadWasmSwc() is skipped if `<next>/wasm/@next/swc-wasm-nodejs` already
// exists, after which it loads the wasm from there by absolute path. So we copy
// the installed package into that dir — no network, deterministic.
console.log("\n== seed wasm SWC cache ==");
kernel.writeFile(
  DIR + "/oc-seed-swc.js",
  `const fs = require("fs");
const path = require("path");
const src = "${DIR}/node_modules/@next/swc-wasm-nodejs";
const dst = "${DIR}/node_modules/next/wasm/@next/swc-wasm-nodejs";
function cp(s, d) {
  fs.mkdirSync(d, { recursive: true });
  for (const e of fs.readdirSync(s, { withFileTypes: true })) {
    const sp = path.join(s, e.name), dp = path.join(d, e.name);
    if (e.isDirectory()) cp(sp, dp);
    else fs.writeFileSync(dp, fs.readFileSync(sp));
  }
}
cp(src, dst);
console.log("seeded " + fs.readdirSync(dst).length + " entries");
`,
);
const seed = await kernel.start("node", [DIR + "/oc-seed-swc.js"], { cwd: DIR, env, capture: true });
console.log("  seed exit=" + seed.code + " " + (seed.stdout || "").trim() + (seed.stderr ? " ERR:" + seed.stderr.trim() : ""));

// ── gate 2: next dev --webpack binds the port ────────────────────────────────
console.log("\n== next dev --webpack ==");
// Long-running: do NOT await. Its stdout/stderr flow to the kernel `cap` sink
// (non-captured processes route to the global stdout/stderr callback).
const devStart = out.length;
kernel.start(
  "node",
  ["node_modules/next/dist/bin/next", "dev", "--webpack", "-p", String(PORT), "-H", "127.0.0.1"],
  { cwd: DIR, env },
);
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

// ── gate 3: GET / -> 200 with page content ───────────────────────────────────
let getOk = false;
let compiledWasm = false;
if (bound) {
  const decode = (b) => (typeof b === "string" ? b : Buffer.from(b).toString());
  const get = (url) => kernel.handleHttpRequest(PORT, { port: PORT, method: "GET", url, headers: { host: "127.0.0.1:" + PORT }, body: "" });
  let root = await get("/");
  // First request triggers on-demand compile; retry while Next warms up.
  for (let i = 0; i < 120 && (root.status === 502 || root.status === 404 || root.status >= 500); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    root = await get("/");
  }
  const body = decode(root.body || "");
  getOk = root.status === 200 && /Next\.js App Router in OpenContainer|id="marker"/.test(body);
  console.log(`  GET / -> ${root.status}  (${body.length} bytes)`);
  console.log("  body head: " + body.slice(0, 200).replace(/\n/g, " "));
  compiledWasm = /wasm build @next\/swc-wasm-nodejs|next-swc build: wasm/.test(out.join(""));
  console.log("  compiled via wasm SWC (log): " + compiledWasm);
} else {
  console.log("\n---- dev output tail (last 4000 chars) ----\n" + out.slice(devStart).join("").slice(-4000));
}

const ok = inst.code === 0 && nextBin && wasmSwc && bound && getOk;
console.log("\nRESULT: " + (ok ? "PASS — Next 16 App Router boots on webpack + wasm SWC and serves / with 200" : "FAIL — see logs above"));
process.exit(ok ? 0 : 1);
