// Shared headless spike harness — boots the SAME kernel the browser runs (Rust/
// Wasm VFS + process workers + syscall SABs), on the host via Node worker_threads.
// Extracted from the copy-pasted boilerplate in scripts/spike-*.mjs so new spikes
// (and the CI runner, scripts/run-spikes.mjs) share one implementation.
//
// Requires a vendored real npm tree on the host (installs go to the live registry):
//   rm -rf /tmp/vv-vendor && mkdir -p /tmp/vv-vendor \
//     && (cd /tmp/vv-vendor && npm install npm@10.9.2 --no-save --no-audit --no-fund)
//
// Typical use:
//   const h = await bootSpikeKernel();
//   writeProject(h.kernel, "/app", { "package.json": "…", "src/index.js": "…" });
//   const inst = await npmInstall(h, { dir: "/app" });
//   const bound = await waitListen(h, { dir: "/app", port: 3000, argv: ["src/index.js"] });
//   const r = await httpGet(h.kernel, 3000, "/");

import { Kernel } from "../../packages/kernel-host/kernel.js";
import { createKernelFs } from "../../packages/kernel-host/kernel-fs.js";
import { stubNodeGyp } from "../../packages/kernel-host/node-gyp-stub.js";
import { Worker, MessageChannel } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";

export const LIVE = process.env.VV_LIVE === "1";
export const VFS_NPM = "/usr/lib/node_modules/npm";

/** Boot the kernel + FS worker and load the vendored real npm into the VFS. */
export async function bootSpikeKernel() {
  const VENDOR_NPM = process.env.VV_VENDOR_NPM || process.argv[2] || "/tmp/vv-vendor/node_modules/npm";
  if (!fs.existsSync(path.join(VENDOR_NPM, "bin/npm-cli.js"))) {
    console.error(`No vendored npm at ${VENDOR_NPM} (expected bin/npm-cli.js).`);
    console.error(
      "Vendor it:  rm -rf /tmp/vv-vendor && mkdir -p /tmp/vv-vendor && " +
        "(cd /tmp/vv-vendor && npm install npm@10.9.2 --no-save --no-audit --no-fund)",
    );
    process.exit(2);
  }

  const fsWorker = new Worker(new URL("../fs-worker.mjs", import.meta.url));
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
    const w = new Worker(new URL("../process-worker.mjs", import.meta.url));
    w.on("message", (m) => {
      const handler = info.on[m.type];
      if (handler) handler(m);
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
  kernel.onFetch = (u, i) => {
    fetchN++;
    if (LIVE) process.stderr.write(`  [net ${fetchN}] ${i.cached ? "cache" : "GET"} ${((i.size / 1024) | 0)}k  ${u}\n`);
  };

  let fileCount = 0;
  const loadDir = (hostDir, vfsDir) => {
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
  };
  const t0 = Date.now();
  loadDir(VENDOR_NPM, VFS_NPM);
  stubNodeGyp(kernel, VFS_NPM);
  console.log(`Loaded real npm into VFS: ${fileCount} files (${Date.now() - t0}ms)`);
  kernel.mkdirp("/home/user");
  kernel.mkdirp("/tmp/.npm/_logs");

  return { kernel, out, listening, VFS_NPM };
}

/** Write a { relPath: contents } project map under `dir`, mkdirp'ing parents. */
export function writeProject(kernel, dir, files) {
  for (const [rel, contents] of Object.entries(files)) {
    const p = dir + "/" + rel;
    const slash = p.lastIndexOf("/");
    if (slash > 0) kernel.mkdirp(p.slice(0, slash));
    kernel.writeFile(p, contents);
  }
}

/** A default shell env rooted at `dir` (PATH includes node_modules/.bin). */
export function defaultEnv(dir) {
  return {
    HOME: "/home/user",
    PATH: dir + "/node_modules/.bin:/bin",
    npm_config_cache: "/tmp/.npm",
    NODE_ENV: "development",
    VV_LIVE: LIVE ? "1" : "",
  };
}

/** Run `npm install` in `dir`. Returns the process result ({ code, ... }). */
export async function npmInstall(h, { dir, env = defaultEnv(dir), extraArgs = [] }) {
  const INSTALL_TIMEOUT = Number(process.env.VV_INSTALL_TIMEOUT || 300000);
  const t1 = Date.now();
  let timedOut = false;
  console.log(`\n== npm install (${dir}) ==`);
  const inst = await Promise.race([
    h.kernel.start(
      "node",
      [VFS_NPM + "/bin/npm-cli.js", "install", "--no-audit", "--no-fund", ...extraArgs],
      { cwd: dir, env, capture: !LIVE },
    ),
    new Promise((r) => setTimeout(() => { timedOut = true; r({ code: 124 }); }, INSTALL_TIMEOUT)),
  ]);
  console.log(`  install exit=${inst.code}${timedOut ? " (TIMED OUT)" : ""}  (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
  if (inst.code !== 0) console.log("  STDERR tail:\n" + ((inst.stderr || h.out.join("")).slice(-2500)));
  return inst;
}

/** Start a dev server (argv relative to `dir`) and wait until `port` binds. */
export async function waitListen(h, { dir, port, argv, env = defaultEnv(dir) }) {
  const devStart = h.out.length;
  console.log(`\n== start ${argv.join(" ")} ==`);
  h.kernel.start("node", argv, { cwd: dir, env });
  const BIND_TIMEOUT = Number(process.env.VV_BIND_TIMEOUT || 120000);
  const tb = Date.now();
  let fatal = "";
  while (!h.listening.has(port) && Date.now() - tb < BIND_TIMEOUT && !fatal) {
    await new Promise((r) => setTimeout(r, 100));
    const tail = h.out.slice(devStart).join("");
    const m = tail.match(/Cannot find module '([^']+)'|Error: ([^\n]*is not (?:a function|supported)[^\n]*)/);
    if (m) fatal = m[0];
  }
  if (fatal) console.log(`  early-abort: ${fatal}`);
  const bound = h.listening.has(port);
  console.log(`  listening on ${port}: ${bound}  (${((Date.now() - tb) / 1000).toFixed(1)}s)`);
  if (!bound) console.log("\n---- dev output tail ----\n" + h.out.slice(devStart).join("").slice(-4000));
  return bound;
}

/** GET a path through the in-VM server, retrying while it 5xx/404s (warm-up). */
export async function httpGet(kernel, port, url = "/") {
  const decode = (b) => (typeof b === "string" ? b : Buffer.from(b).toString());
  const get = (u) =>
    kernel.handleHttpRequest(port, { port, method: "GET", url: u, headers: { host: "127.0.0.1:" + port }, body: "" });
  let r = await get(url);
  for (let i = 0; i < 60 && (r.status === 502 || r.status === 404 || r.status >= 500); i++) {
    await new Promise((res) => setTimeout(res, 1000));
    r = await get(url);
  }
  return { status: r.status, body: decode(r.body || "") };
}

/** POST a JSON body to the in-VM server (single shot — no warm-up retry loop). */
export async function httpPost(kernel, port, url, body, headers = {}) {
  const decode = (b) => (typeof b === "string" ? b : Buffer.from(b).toString());
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const r = await kernel.handleHttpRequest(port, {
    port,
    method: "POST",
    url,
    headers: {
      host: "127.0.0.1:" + port,
      "content-type": "application/json",
      accept: "application/json",
      ...headers,
    },
    body: payload,
  });
  return { status: r.status, body: decode(r.body || "") };
}
