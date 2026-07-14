// Shared harness for the frontend-variant Vite spikes (Preact / Lit / Solid /
// Qwik). Each of those templates is a plain Vite SPA that differs only in its
// framework plugin + JSX transform, so the in-VM proof is identical: install the
// real deps, boot the real `vite` dev server, and assert it serves the app.
//
// A spike PASSES when every gate is green:
//   1. `npm install` exits 0 and the `vite` bin landed on disk.
//   2. `vite` binds its port (its dev server actually started).
//   3. GET /                -> 200 with the template's <title> marker.
//   4. GET /@vite/client    -> 200 (Vite's dev middleware is live).
//   5. GET <entry module>   -> 200 (the framework plugin transformed the entry
//      without throwing — this is the check that would catch a Preact/Solid/Qwik
//      plugin or JSX-transform breakage that a plain "GET / 200" would miss).
//
// Usage (Node 22+, needs network for npm):
//   1) vendor npm:  rm -rf /tmp/oc-vendor && mkdir -p /tmp/oc-vendor \
//        && (cd /tmp/oc-vendor && npm install npm@10.9.2 --no-save --no-audit --no-fund)
//   2) a per-framework spike calls runViteSpike({...}); run e.g.
//        node scripts/spike-preact.mjs
//
// Env knobs: OC_LIVE=1 (stream in-VM output), OC_PORT, OC_INSTALL_TIMEOUT,
// OC_BIND_TIMEOUT, OC_INSTALL_ONLY=1.

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { stubNodeGyp } from "../packages/kernel-host/node-gyp-stub.js";
import { Worker, MessageChannel } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";

const VFS_NPM = "/usr/lib/node_modules/npm";

/**
 * @param {object} opts
 * @param {string} opts.name         Human label, e.g. "Preact".
 * @param {string} opts.dir          VFS project dir, e.g. "/preact".
 * @param {Record<string,string>} opts.files  relPath -> contents (the template source).
 * @param {string} opts.entryModule  root-absolute module the index.html loads, e.g. "/src/main.tsx".
 * @param {RegExp}  opts.titleMarker Regex the served index.html must match, e.g. /Vite \+ Preact/.
 * @returns {Promise<boolean>} true on PASS.
 */
export async function runViteSpike({ name, dir, files, entryModule, titleMarker }) {
  const LIVE = process.env.OC_LIVE === "1";
  const PORT = Number(process.env.OC_PORT || 5173);
  const VENDOR_NPM = process.argv[2] || "/tmp/oc-vendor/node_modules/npm";

  if (!fs.existsSync(path.join(VENDOR_NPM, "bin/npm-cli.js"))) {
    console.error(`No vendored npm at ${VENDOR_NPM} (expected bin/npm-cli.js).`);
    console.error(
      `Vendor it:  rm -rf /tmp/oc-vendor && mkdir -p /tmp/oc-vendor && (cd /tmp/oc-vendor && npm install npm@10.9.2 --no-save --no-audit --no-fund)`,
    );
    process.exit(2);
  }

  // ── kernel setup (same shape as spike-webpack.mjs / spike-next.mjs) ─────────
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

  // Transparent wasm drop-in aliasing — mirrors packages/demo/fetcher-worker.js
  // (PACKAGE_ALIASES). esbuild/rollup ship no wasm32 native build; their official
  // WASM drop-ins live under a different package name, which npm's platform
  // auto-select can't reach. Aliasing at the registry layer (serve the target's
  // packument under the source name) lets a plain in-VM `npm install` pull the wasm
  // drop-in with NO project-level "overrides". The headless spike must do this too,
  // otherwise it installs the native esbuild the browser kernel never sees — and the
  // module loader's in-process esbuild service (packages/runtime/esbuild-inproc-patch.js)
  // only patches esbuild-*wasm*. Keep in sync with fetcher-worker.js.
  const PACKAGE_ALIASES = { esbuild: "esbuild-wasm", rollup: "@rollup/wasm-node" };
  const encPkg = (n) => (n.startsWith("@") ? "@" + encodeURIComponent(n.slice(1)) : encodeURIComponent(n));
  const matchPackumentAlias = (url) => {
    let u;
    try { u = new URL(url); } catch { return null; }
    const segs = u.pathname.split("/").filter(Boolean);
    if (!segs.length || segs.includes("-")) return null; // empty or a tarball path
    let i = segs.length - 1;
    const last = decodeURIComponent(segs[i]);
    if ((/^\d/.test(last) || last === "latest") && segs.length >= 2) i = segs.length - 2;
    const src = decodeURIComponent(segs[i]);
    const dst = PACKAGE_ALIASES[src];
    if (!dst) return null;
    const ns = segs.slice();
    ns[i] = encPkg(dst);
    u.pathname = "/" + ns.join("/");
    return { targetUrl: u.toString(), src };
  };
  const rewritePackument = (json, src) => {
    if (json && typeof json === "object") {
      if ("name" in json) json.name = src;
      if ("_id" in json) json._id = src;
      const versions = json.versions;
      if (versions && typeof versions === "object") {
        for (const v of Object.keys(versions)) {
          const m = versions[v];
          if (m && typeof m === "object") {
            if ("name" in m) m.name = src;
            if ("_id" in m) m._id = src + "@" + (m.version || v);
          }
        }
      }
    }
    return json;
  };
  const fetcher = async (url, init) => {
    const method = ((init && init.method) || "GET").toUpperCase();
    if (method === "GET") {
      const alias = matchPackumentAlias(url);
      if (alias) {
        try {
          const r = await fetch(alias.targetUrl, { redirect: "follow", ...(init || {}) });
          if (r.ok) {
            const json = rewritePackument(await r.json(), alias.src);
            const body = new TextEncoder().encode(JSON.stringify(json));
            return {
              ok: true,
              status: r.status,
              statusText: r.statusText,
              headers: { "content-type": "application/json" },
              body,
            };
          }
        } catch {
          // fall through to the un-aliased fetch below
        }
      }
    }
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
  kernel.onFetch = (url, meta) => {
    fetchN++;
    if (LIVE) process.stderr.write(`  [net ${fetchN}] ${meta.cached ? "cache" : "GET"} ${((meta.size / 1024) | 0)}k  ${url}\n`);
  };

  // ── load the vendored npm tree into the VFS ────────────────────────────────
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
  console.log(`[${name}] Loaded real npm into VFS: ${fileCount} files (${Date.now() - t0}ms)`);

  kernel.mkdirp("/home/user");
  kernel.mkdirp("/tmp/.npm/_logs");

  // ── write the template source into the VFS ─────────────────────────────────
  for (const [rel, contents] of Object.entries(files)) {
    const abs = dir + "/" + rel;
    kernel.mkdirp(abs.slice(0, abs.lastIndexOf("/")));
    kernel.writeFile(abs, contents);
  }

  const env = {
    HOME: "/home/user",
    PATH: dir + "/node_modules/.bin:/bin",
    npm_config_cache: "/tmp/.npm",
    NODE_ENV: "development",
    OC_LIVE: LIVE ? "1" : "",
  };

  // ── gate 1: install ────────────────────────────────────────────────────────
  console.log(`\n== [${name}] npm install ==`);
  const INSTALL_TIMEOUT = Number(process.env.OC_INSTALL_TIMEOUT || 300000);
  const t1 = Date.now();
  let installTimedOut = false;
  const inst = await Promise.race([
    kernel.start("node", [VFS_NPM + "/bin/npm-cli.js", "install", "--no-audit", "--no-fund"], { cwd: dir, env, capture: !LIVE }),
    new Promise((r) => setTimeout(() => { installTimedOut = true; r({ code: 124 }); }, INSTALL_TIMEOUT)),
  ]);
  console.log(`  install exit=${inst.code}${installTimedOut ? " (TIMED OUT)" : ""}  (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
  if (inst.code !== 0) {
    console.log("  STDERR tail:\n" + ((inst.stderr || out.join("")).slice(-3000)));
    process.exit(1);
  }
  const viteBin = kernel.exists(dir + "/node_modules/vite/bin/vite.js");
  console.log("  vite bin present: " + viteBin);

  if (process.env.OC_INSTALL_ONLY === "1") {
    console.log(`\nOC_INSTALL_ONLY=1 — stopping after install.`);
    process.exit(inst.code === 0 && viteBin ? 0 : 1);
  }

  // ── gate 2: vite dev server binds its port ─────────────────────────────────
  console.log(`\n== [${name}] vite (dev server) ==`);
  const devStart = out.length;
  // `--configLoader native` avoids the rolldown config bundler's "Invalid URL"
  // in-VM (see templates.ts VITE_DEV); --strictPort so a mispick fails loudly.
  kernel.start(
    "node",
    ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort", "--configLoader", "native"],
    { cwd: dir, env },
  );
  const BIND_TIMEOUT = Number(process.env.OC_BIND_TIMEOUT || 240000);
  const tb = Date.now();
  let fatal = "";
  while (!listening.has(PORT) && Date.now() - tb < BIND_TIMEOUT && !fatal) {
    await new Promise((r) => setTimeout(r, 100));
    const tail = out.slice(devStart).join("");
    const m = tail.match(/Cannot find module '([^']+)'|Failed to resolve[^\n]*|\[plugin[^\]]*\][^\n]*|([A-Za-z]*Error: [^\n]*is not (?:a function|supported)[^\n]*)/);
    if (m) fatal = m[0];
  }
  if (fatal) console.log(`  early-abort: ${fatal}`);
  const bound = listening.has(PORT);
  console.log(`  listening on ${PORT}: ${bound}  (${((Date.now() - tb) / 1000).toFixed(1)}s)`);

  // ── gates 3-5: HTTP checks ─────────────────────────────────────────────────
  const decode = (b) => (typeof b === "string" ? b : Buffer.from(b).toString());
  const get = (url) =>
    kernel.handleHttpRequest(PORT, { port: PORT, method: "GET", url, headers: { host: "127.0.0.1:" + PORT }, body: "" });
  const getRetry = async (url) => {
    let r = await get(url);
    // Vite does on-demand work on first hit (optimizeDeps / transform) → allow
    // a warm-up window on 5xx/404 before giving up.
    for (let i = 0; i < 60 && (r.status === 502 || r.status === 404 || r.status >= 500); i++) {
      await new Promise((res) => setTimeout(res, 1000));
      r = await get(url);
    }
    return r;
  };

  let rootOk = false;
  let clientOk = false;
  let entryOk = false;
  if (bound) {
    const root = await getRetry("/");
    const rootBody = decode(root.body || "");
    rootOk = root.status === 200 && titleMarker.test(rootBody) && /<script[^>]+type="module"/.test(rootBody);
    console.log(`  GET /               -> ${root.status}  (${rootBody.length} bytes)  marker=${titleMarker.test(rootBody)}`);

    const client = await getRetry("/@vite/client");
    clientOk = client.status === 200;
    console.log(`  GET /@vite/client   -> ${client.status}`);

    const entry = await getRetry(entryModule);
    const entryBody = decode(entry.body || "");
    entryOk = entry.status === 200 && entryBody.length > 0;
    console.log(`  GET ${entryModule.padEnd(15)} -> ${entry.status}  (${entryBody.length} bytes)`);
    if (!entryOk) console.log("  entry body head: " + entryBody.slice(0, 300).replace(/\n/g, " "));
  } else {
    console.log("\n---- dev output tail (last 4000 chars) ----\n" + out.slice(devStart).join("").slice(-4000));
  }

  const ok = inst.code === 0 && viteBin && bound && rootOk && clientOk && entryOk;
  console.log(
    `\nRESULT: ${ok ? `PASS — ${name} + Vite boots and serves / (200), transforms ${entryModule}` : `FAIL — see logs above`}`,
  );
  return ok;
}
