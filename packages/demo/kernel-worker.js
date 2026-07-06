// The kernel worker — OpenContainer's kernel host, off the main thread.
//
// Phase 2, item #1 (Kernel worker). Everything heavy lives here now: the
// Rust/Wasm VFS, the Kernel (process table + syscall servicing + virtual
// network), and the process workers it spawns. The main thread (host.js) is
// left free for UI + orchestration only (Main = UI/orchestration in the target
// architecture map).
//
// Process workers are created as *nested* workers from inside this worker
// (requires a browser with nested Worker support — Chrome/Firefox, Safari 16.4+).
// The Kernel class itself stays environment-agnostic: it is handed a
// `spawnWorker` just like the headless Node test does.

import initKernel, {
  VirtualFileSystem,
} from "../kernel/pkg/open_webcontainer_kernel.js";
import { Kernel } from "../kernel-host/kernel.js";

const post = (type, extra) => self.postMessage({ type, ...extra });

// A small shell session, each command is its own process (PID).
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

let kernel = null;

async function boot() {
  await initKernel();
  const vfs = new VirtualFileSystem();
  post("log", { line: "Rust VFS booted (wasm) inside the kernel worker.", cls: "ok" });

  // Spawn a process as a *nested* worker under this kernel worker. Each gets a
  // human-readable name (shown in DevTools' JS VM instance list) with its PID.
  const spawnWorker = (info) => {
    const worker = new Worker(new URL("./process-worker.js", import.meta.url), {
      type: "module",
      name: "Process Worker PID " + info.pid,
    });
    worker.onmessage = (event) => {
      const handler = info.on[event.data.type];
      if (handler) handler(event.data);
    };
    worker.postMessage({ type: "init", sab: info.sab, spec: info.spec });
    return { terminate: () => worker.terminate() };
  };

  kernel = new Kernel({
    vfs,
    spawnWorker,
    stdout: (chunk) => post("stdout", { chunk }),
    stderr: (chunk) => post("stderr", { chunk }),
  });
  kernel.onProcExit = (pid, res) => post("exit", { pid, code: res.code });
  kernel.onListen = (port, pid) => post("listen", { port, pid });

  kernel.installCoreutils();
  kernel.mkdirp("/srv");
  kernel.writeFile("/srv/server.js", SERVER_SRC);
  kernel.writeFile("/root.sh", SCRIPT);

  post("log", { line: "$ sh /root.sh", cls: "muted" });
  await kernel.start("sh", ["/root.sh"], { cwd: "/" });

  post("log", { line: "$ node /srv/server.js  (long-running process)", cls: "muted" });
  // Do NOT await: a server never exits — it parks in its accept loop, and the
  // kernel keeps servicing requests to it while everything else runs.
  kernel.start("node", ["/srv/server.js"], { cwd: "/srv" });
}

self.onmessage = async (event) => {
  const m = event.data;

  if (m.type === "init") {
    boot().catch((err) => post("log", { line: "kernel worker boot failed: " + err, cls: "err" }));
    return;
  }

  // A preview request relayed from the main thread. The Service Worker's reply
  // port was transferred to us, so we answer it directly.
  if (m.type === "oc-http") {
    const port = event.ports[0];
    if (!kernel) {
      port.postMessage({ status: 503, headers: {}, body: "kernel not ready\n" });
      return;
    }
    const resp = await kernel.handleHttpRequest(m.req.port, m.req);
    port.postMessage(resp);
    return;
  }
};
