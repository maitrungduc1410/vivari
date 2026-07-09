// Scratch probe (NETWORK): boot a real React + Vite app WITH the React Compiler
// in-VM and drive the dev server, to surface any missing Node APIs. Not a
// committed test — a discovery loop for the framework-validation roadmap item.
//
//   node scripts/probe-react.mjs

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
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
const fetcher = async (url) => {
  const r = await fetch(url, { redirect: "follow" });
  const body = new Uint8Array(await r.arrayBuffer());
  const headers = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  return { ok: r.ok, status: r.status, headers, body };
};

const listening = new Set();
const kernel = new Kernel({
  fs: kernelFs.fs,
  spawnWorker,
  fetcher,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
});
kernel.onListen = (port) => listening.add(port);
kernel.installCoreutils();

const DIR = "/rc";
const PORT = 5401;
kernel.mkdirp(DIR + "/src");
kernel.writeFile(
  DIR + "/package.json",
  JSON.stringify({ name: "rc-demo", version: "1.0.0", private: true, type: "module" }, null, 2),
);
kernel.writeFile(
  DIR + "/vite.config.js",
  `
import react from '@vitejs/plugin-react';
export default {
  plugins: [react({ babel: { plugins: [['babel-plugin-react-compiler', {}]] } })],
};
`,
);
kernel.writeFile(
  DIR + "/index.html",
  '<!doctype html><html><head><meta charset="utf-8"><title>rc</title></head>' +
    '<body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>',
);
kernel.writeFile(
  DIR + "/src/main.jsx",
  `
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
`,
);
kernel.writeFile(
  DIR + "/src/App.jsx",
  `
import { useState } from 'react';
export default function App() {
  const [n, setN] = useState(0);
  const doubled = n * 2;
  return (
    <div>
      <h1>Count {n} (x2 = {doubled})</h1>
      <button onClick={() => setN((v) => v + 1)}>inc</button>
    </div>
  );
}
`,
);

const decode = (b) => (typeof b === "string" ? b : Buffer.from(b).toString());
const log = (...a) => console.log(...a);

log("== npm install (react + vite + plugin-react + react-compiler) ==");
const inst = await kernel.start(
  "npm",
  [
    "install",
    "react",
    "react-dom",
    "vite",
    "@vitejs/plugin-react",
    "babel-plugin-react-compiler",
    "@rolldown/plugin-babel",
    "@babel/core",
  ],
  { cwd: DIR, capture: true },
);
log("  install code=" + inst.code);
if (inst.code !== 0) {
  log("  STDOUT:", inst.stdout.slice(-2000));
  log("  STDERR:", inst.stderr.slice(-2000));
  process.exit(1);
}

log("== boot vite dev (react + react-compiler via @rolldown/plugin-babel) ==");
kernel.writeFile(
  DIR + "/dev.js",
  `
process.on('uncaughtException', (e) => console.log('RC_UNCAUGHT ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => console.log('RC_UNHANDLED ' + (e && e.stack || e)));
const vite = require('vite');
const reactMod = require('@vitejs/plugin-react');
const reactCompilerPreset = reactMod.reactCompilerPreset;
let react = reactMod;
while (react && typeof react !== 'function' && react.default) react = react.default;
const babelMod = require('@rolldown/plugin-babel');
let babel = babelMod;
while (babel && typeof babel !== 'function' && babel.default) babel = babel.default;
console.log('WIRING react=' + typeof react + ' babel=' + typeof babel + ' preset=' + typeof reactCompilerPreset);
(async () => {
  try {
    const server = await vite.createServer({
      root: '${DIR}', configFile: false, logLevel: 'info',
      plugins: [
        react(),
        babel({ presets: [reactCompilerPreset({ target: '19' })] }),
      ],
      server: { port: ${PORT}, host: '127.0.0.1' },
      optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client'] },
    });
    await server.listen();
    console.log('RC_DEV_READY');
    setInterval(() => {}, 1000);
  } catch (e) { console.log('RC_DEV_ERR ' + (e && e.stack || e)); process.exit(1); }
})();
`,
);
kernel.start("node", ["dev.js"], { cwd: DIR });
for (let i = 0; i < 2000 && !listening.has(PORT); i++) await new Promise((r) => setTimeout(r, 20));
log("  listening on " + PORT + ": " + listening.has(PORT));
if (!listening.has(PORT)) process.exit(1);

const get = (url) =>
  kernel.handleHttpRequest(PORT, { port: PORT, method: "GET", url, headers: { host: "127.0.0.1:" + PORT }, body: "" });

// The dep optimizer + HMR ws set up async after listen; give it a beat and retry.
let root = await get("/");
for (let i = 0; i < 40 && root.status === 502; i++) {
  await new Promise((r) => setTimeout(r, 250));
  root = await get("/");
}
log("  GET / -> " + root.status + " hasClient=" + decode(root.body).includes("/@vite/client"));

const appMod = await get("/src/App.jsx");
const appCode = decode(appMod.body);
log("  GET /src/App.jsx -> " + appMod.status);
log("  jsx compiled (no raw <h1>): " + !appCode.includes("<h1>"));
log("  react-refresh wired: " + (appCode.includes("$RefreshReg$") || appCode.includes("react-refresh")));
log("  react-compiler applied (c/_c cache): " + (/["']react\/compiler-runtime["']/.test(appCode) || /\b_c\(/.test(appCode)));
log("\n---- App.jsx transformed (first 1200 chars) ----\n" + appCode.slice(0, 1200));

// Repro for the browser 504: the entry imports react-dom/client, which Vite
// serves from its pre-bundled .vite/deps. Follow that request and time it out so
// a hang is visible (the browser hits exactly this URL and 504s after 60s).
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((r) => setTimeout(() => r({ status: "TIMEOUT(" + label + ")" }), ms))]);

log("\n== dep-optimizer serving (the browser-504 path) ==");
const mainMod = await get("/src/main.jsx");
const mainCode = decode(mainMod.body);
log("  GET /src/main.jsx -> " + mainMod.status);
const m = mainCode.match(/\/node_modules\/\.vite\/deps\/[\w.-]*react-dom[\w.-]*\.js(\?v=[0-9a-f]+)?/);
const depUrl = m ? m[0] : "/node_modules/.vite/deps/react-dom_client.js";
log("  resolved react-dom/client -> " + depUrl);
const dep = await withTimeout(get(depUrl), 15000, "dep");
log("  GET " + depUrl + " -> " + dep.status + (dep.body ? " len=" + decode(dep.body).length : ""));

// Isolate: does the hang follow the FILE (react-dom_client) or the ?v= QUERY?
const vq = (m && m[1]) || "?v=00000000";
const base = "/node_modules/.vite/deps/";
const cases = [
  base + "react.js",
  base + "react.js" + vq,
  base + "react-dom_client.js",
  base + "react-dom_client.js" + vq,
  base + "react_compiler-runtime.js" + vq,
];
for (const d of cases) {
  const r = await withTimeout(get(d), 12000, d);
  log("  GET " + d + " -> " + r.status + (r.body ? " len=" + decode(r.body).length : ""));
}

process.exit(0);
