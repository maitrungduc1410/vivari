// Scratch probe (NETWORK): attempt to boot a real Next.js dev server in-VM to
// surface missing Node APIs and/or document hard native/browser limits (SWC is
// native Rust; Turbopack is native; webpack is JS).
//
//   node scripts/probe-next.mjs

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { initTransferList } from "../packages/kernel-host/worker-transfer.js";
import { Worker, MessageChannel } from "node:worker_threads";

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
const fetcher = async (url) => {
  const r = await fetch(url, { redirect: "follow" });
  const body = new Uint8Array(await r.arrayBuffer());
  const headers = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  return { ok: r.ok, status: r.status, headers, body };
};

const out = [];
const cap = (s) => {
  out.push(s);
  process.stdout.write(s);
};
const listening = new Set();
const kernel = new Kernel({ fs: kernelFs.fs, spawnWorker, fetcher, stdout: cap, stderr: cap });
kernel.onListen = (port) => listening.add(port);
kernel.installCoreutils();

const DIR = "/next";
const PORT = 3021;
const log = (...a) => console.log(...a);
const decode = (b) => (typeof b === "string" ? b : Buffer.from(b).toString());
kernel.mkdirp(DIR + "/pages");

kernel.writeFile(
  DIR + "/package.json",
  JSON.stringify({ name: "next-demo", version: "1.0.0", private: true }, null, 2),
);
kernel.writeFile(
  DIR + "/next.config.js",
  "module.exports = { reactStrictMode: true };\n",
);
kernel.writeFile(
  DIR + "/pages/index.js",
  `
export default function Home() {
  return <main><h1>Next.js in Vivari</h1></main>;
}
`,
);

log("== npm install (next react react-dom) ==");
const inst = await kernel.start("npm", ["install", "next", "react", "react-dom"], { cwd: DIR, capture: true });
log("  install code=" + inst.code);
if (inst.code !== 0) {
  log("  STDERR:", (inst.stderr || "").slice(-3000));
  process.exit(1);
}
log("  next installed: " + kernel.exists(DIR + "/node_modules/next/dist/bin/next"));
// Which swc packages did npm pull (native vs wasm)?
for (const p of ["@next/swc-wasm-nodejs", "@next/swc-darwin-arm64", "@next/swc-linux-x64-gnu"]) {
  log("  " + p + ": " + kernel.exists(DIR + "/node_modules/" + p + "/package.json"));
}

log("== next dev (webpack; turbopack is native) ==");
// NEXT_DISABLE_SWC_WASM unset — let it pick. Force webpack (no turbo). Bind port.
kernel.start(
  "node",
  ["node_modules/next/dist/bin/next", "dev", "-p", String(PORT), "-H", "127.0.0.1"],
  { cwd: DIR, env: { NODE_ENV: "development" } },
);
for (let i = 0; i < 4000 && !listening.has(PORT); i++) await new Promise((r) => setTimeout(r, 25));
log("  listening on " + PORT + ": " + listening.has(PORT));

if (listening.has(PORT)) {
  const get = (url) =>
    kernel.handleHttpRequest(PORT, { port: PORT, method: "GET", url, headers: { host: "127.0.0.1:" + PORT }, body: "" });
  let root = await get("/");
  for (let i = 0; i < 80 && root.status === 502; i++) {
    await new Promise((r) => setTimeout(r, 500));
    root = await get("/");
  }
  log("  GET / -> " + root.status);
  log("  body: " + decode(root.body).slice(0, 300));
} else {
  const joined = out.join("");
  log("\n---- captured tail (last 3500 chars) ----\n" + joined.slice(-3500));
}
process.exit(0);
