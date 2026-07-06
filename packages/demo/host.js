// Browser host (main thread). Boots the Rust/Wasm VFS, wraps it in the Kernel,
// installs coreutils, runs a short shell session, then starts a real HTTP server
// *inside* a worker process and previews it in an iframe — via a Service Worker
// that turns virtual requests into kernel calls (brick 5). No network involved.

import initKernel, {
  VirtualFileSystem,
} from "../kernel/pkg/open_webcontainer_kernel.js";
import { Kernel } from "../kernel-host/kernel.js";

const out = document.getElementById("output");
const frame = document.getElementById("preview");
const previewUrlEl = document.getElementById("preview-url");

function print(line, cls = "") {
  const el = document.createElement("div");
  el.className = "line " + cls;
  el.textContent = line;
  out.appendChild(el);
  out.scrollTop = out.scrollHeight;
}
const printChunk = (chunk, cls) => {
  for (const line of chunk.replace(/\n$/, "").split("\n")) print(line, cls);
};

const SCRIPT = `
# a small shell session, each command is its own process (PID)
echo "== OpenContainer shell =="
pwd
mkdir -p /srv
echo two && echo three
echo "== booting http server =="
`;

// A tiny HTTP server, like you'd write in Node. It never exits: the process
// parks in an accept loop serving requests forwarded by the Service Worker.
const SERVER_SRC = `
const http = require('http');

const server = http.createServer((req, res) => {
  if (req.url === '/api/time') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ now: Date.now(), pid: process.pid }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(\`<!doctype html>
<html><head><meta charset="utf-8"><title>Hello from OpenContainer</title>
<style>
  body{font-family:ui-monospace,Menlo,monospace;background:#0b0e14;color:#d4d7dd;
       display:grid;place-items:center;height:100vh;margin:0}
  .card{border:1px solid #1c2230;border-radius:12px;padding:32px 40px;background:#0e131c;text-align:center}
  h1{color:#7ee787;margin:0 0 8px} code{color:#79c0ff}
  button{margin-top:16px;font:inherit;background:#1f6feb;color:#fff;border:0;
         border-radius:8px;padding:8px 14px;cursor:pointer}
</style></head>
<body><div class="card">
  <h1>Hello from OpenContainer 🎉</h1>
  <p>Served by <code>http.createServer</code> in worker <code>PID \${process.pid}</code></p>
  <p>You requested <code>\${req.url}</code></p>
  <button onclick="fetch('api/time').then(r=>r.json()).then(t=>document.getElementById('t').textContent=JSON.stringify(t))">GET /api/time</button>
  <pre id="t"></pre>
</div></body></html>\`);
});

server.listen(3000, () => console.log('[server] listening on http://localhost:3000 (pid ' + process.pid + ')'));
`;

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    print("Service workers unavailable — preview disabled.", "err");
    return false;
  }
  await navigator.serviceWorker.register("./sw.js");
  await navigator.serviceWorker.ready;
  print("Service Worker registered (preview proxy ready).", "ok");
  return true;
}

async function main() {
  if (typeof SharedArrayBuffer === "undefined") {
    print(
      "SharedArrayBuffer is undefined — the page is NOT cross-origin isolated. " +
        "Serve it with COOP/COEP headers (use the dev server).",
      "err",
    );
    return;
  }
  print("crossOriginIsolated = " + self.crossOriginIsolated, "muted");

  await initKernel();
  const vfs = new VirtualFileSystem();
  print("Rust VFS booted (wasm).", "ok");

  const spawnWorker = (info) => {
    const worker = new Worker(new URL("./process-worker.js", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event) => {
      const handler = info.on[event.data.type];
      if (handler) handler(event.data);
    };
    worker.postMessage({ type: "init", sab: info.sab, spec: info.spec });
    return { terminate: () => worker.terminate() };
  };

  const kernel = new Kernel({
    vfs,
    spawnWorker,
    stdout: (chunk) => printChunk(chunk, ""),
    stderr: (chunk) => printChunk(chunk, "err"),
  });
  kernel.onProcExit = (pid, res) =>
    print(`  [kernel] pid ${pid} exited with code ${res.code}`, "muted");

  // When the server process registers its port, point the preview iframe at it.
  kernel.onListen = (port, pid) => {
    const url = `./preview/${port}/`;
    print(`  [kernel] pid ${pid} is listening on port ${port} → preview ${url}`, "ok");
    previewUrlEl.textContent = `/packages/demo/preview/${port}/`;
    frame.src = url;
  };

  // Route Service-Worker HTTP requests into the kernel's virtual network.
  navigator.serviceWorker.addEventListener("message", async (event) => {
    if (event.data?.type !== "oc-http") return;
    const port = event.ports[0];
    const { req } = event.data;
    const resp = await kernel.handleHttpRequest(req.port, req);
    port.postMessage(resp);
  });

  kernel.installCoreutils();
  await registerServiceWorker();

  kernel.mkdirp("/srv");
  kernel.writeFile("/srv/server.js", SERVER_SRC);
  kernel.writeFile("/root.sh", SCRIPT);

  print("$ sh /root.sh", "muted");
  await kernel.start("sh", ["/root.sh"], { cwd: "/" });

  print("$ node /srv/server.js  (long-running process)", "muted");
  // Do NOT await: a server never exits — it parks in its accept loop, and the
  // kernel keeps servicing requests to it while everything else runs.
  kernel.start("node", ["/srv/server.js"], { cwd: "/srv" });
}

main();
