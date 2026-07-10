// Focused probe (NETWORK): how do we load a REAL vite.config.js in-VM? The
// default rolldown config-bundler throws "Invalid URL"; Vite 6+ exposes
// `configLoader: 'bundle' | 'runner' | 'native'`. Install once, then try each
// strategy against the same real config (with @vitejs/plugin-react +
// react-compiler) to find one that loads the config AND activates the plugins.
//
//   node scripts/probe-viteconfig.mjs

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { Worker, MessageChannel } from "node:worker_threads";

const fsWorker = new Worker(new URL("./fs-worker.mjs", import.meta.url));
let onKernelFsMessage = () => {};
await new Promise((resolve) => {
  fsWorker.on("message", (m) => (m.type === "ready" ? resolve() : onKernelFsMessage(m)));
});
const kernelFs = createKernelFs(fsWorker);
onKernelFsMessage = kernelFs.onMessage;

const spawnWorker = (info) => {
  const w = new Worker(new URL("./process-worker.mjs", import.meta.url));
  w.on("message", (m) => info.on[m.type]?.(m));
  const { port1, port2 } = new MessageChannel();
  fsWorker.postMessage({ type: "fs-register", client: info.pid, sab: info.sab, port: port2 }, [port2]);
  const init = { type: "init", sab: info.sab, spec: info.spec, fsPort: port1 };
  const transfer = [port1];
  if (info.threadPort) { init.threadPort = info.threadPort; transfer.push(info.threadPort); }
  w.postMessage(init, transfer);
  return {
    terminate: () => { w.terminate(); fsWorker.postMessage({ type: "fs-unregister", client: info.pid }); },
    postMessage: (m) => w.postMessage(m),
  };
};
const fetcher = async (url) => {
  const r = await fetch(url, { redirect: "follow" });
  const body = new Uint8Array(await r.arrayBuffer());
  const headers = {}; r.headers.forEach((v, k) => (headers[k] = v));
  return { ok: r.ok, status: r.status, headers, body };
};

const listening = new Set();
let out = "";
const tap = (c) => { out += c; process.stdout.write(c); };
const kernel = new Kernel({ fs: kernelFs.fs, spawnWorker, fetcher, stdout: tap, stderr: tap });
kernel.onListen = (p) => listening.add(p);
const exited = new Map();
kernel.onProcExit = (pid, res) => exited.set(pid, res.code);
kernel.installCoreutils();

const write = (p, c) => { kernel.mkdirp(p.slice(0, p.lastIndexOf("/"))); kernel.writeFile(p, c); };
const D = "/vite-app";
write(D + "/package.json", JSON.stringify({
  name: "vite-react", private: true, version: "0.0.0", type: "module",
  dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
  devDependencies: { "@vitejs/plugin-react": "^5.0.0", "babel-plugin-react-compiler": "latest", vite: "^8.0.0" },
}, null, 2));
write(D + "/vite.config.js",
  "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\n" +
  "export default defineConfig({\n  plugins: [react({ babel: { plugins: [['babel-plugin-react-compiler', {}]] } })],\n})\n");
write(D + "/index.html", "<!doctype html><html><body><div id=root></div><script type=module src=/src/main.jsx></script></body></html>");
write(D + "/src/main.jsx", "import { createRoot } from 'react-dom/client'\nimport App from './App.jsx'\ncreateRoot(document.getElementById('root')).render(<App />)\n");
write(D + "/src/App.jsx", "import { useState } from 'react'\nexport default function App(){const [n,setN]=useState(0);return <button onClick={()=>setN(n+1)}>{n}</button>}\n");

console.log("installing…");
const inst = await kernel.start("npm", ["install"], { cwd: D, capture: true });
console.log("install:", inst.code === 0 ? "ok" : "FAILED\n" + inst.stderr.slice(-600));
if (inst.code !== 0) process.exit(1);

let port = 5300;
async function tryLoader(loader) {
  const p = port++;
  const runFile = D + "/__run_" + loader + ".js";
  write(runFile,
    "const vite=require('vite');(async()=>{try{" +
    "const s=await vite.createServer({root:'" + D + "',configFile:'" + D + "/vite.config.js',configLoader:'" + loader + "',logLevel:'silent',server:{port:" + p + ",host:'127.0.0.1'}});" +
    "await s.listen();console.log('LOADER_OK " + loader + " :" + p + "');setInterval(()=>{},1000);" +
    "}catch(e){console.log('LOADER_ERR " + loader + " '+(e&&e.message||e));process.exit(3);}})();\n");
  out = "";
  const pid = kernel.launch("node", [runFile], { cwd: D });
  for (let i = 0; i < 300 && !listening.has(p) && !exited.has(pid); i++) await new Promise((r) => setTimeout(r, 100));
  if (exited.has(pid)) console.log("  [" + loader + "] process EXITED code=" + exited.get(pid));
  const ok = listening.has(p);
  let jsxOk = false;
  if (ok) {
    const r = await kernel.handleHttpRequest(p, { method: "GET", url: "/src/App.jsx", headers: {}, body: "" });
    const body = typeof r.body === "string" ? r.body : Buffer.from(r.body).toString();
    jsxOk = r.status === 200 && (body.includes("react-refresh") || body.includes("_c(") || body.includes("jsxDEV") || body.includes("react/jsx"));
    console.log("  [" + loader + "] served /src/App.jsx status=" + r.status + " transformed(refresh/compiler)=" + jsxOk);
  }
  console.log("  [" + loader + "] " + (ok ? "CONFIG LOADED + server up" : "FAILED") + (out.includes("LOADER_ERR") ? " :: " + out.split("LOADER_ERR")[1].split("\n")[0].trim() : ""));
  kernel.stop(pid);
  await new Promise((r) => setTimeout(r, 300));
  return ok && jsxOk;
}

const results = {};
for (const loader of ["native", "runner", "bundle"]) {
  console.log("\n== configLoader: " + loader + " ==");
  try { results[loader] = await tryLoader(loader); }
  catch (e) { console.log("  threw:", e && e.message || e); results[loader] = false; }
}
console.log("\nSUMMARY:", JSON.stringify(results));
process.exit(0);
