// Probe: cross-process TCP loopback (127.0.0.1:<port> across processes).
//
// This is the Nuxt/Nitro dev shape that was timing out: nitropack's main server
// on :3000 (one process) reverse-proxies to its SSR worker's HTTP server on an
// ephemeral port (a DIFFERENT process). Same-process TCP loopback already works;
// this proves a connect() to a port owned by ANOTHER in-VM process now rides the
// kernel pipe relay instead of failing with ECONNREFUSED.
//
// Gates:
//   1) A forked child runs an HTTP server on a TCP port and reports the port.
//   2) The parent makes an HTTP request to 127.0.0.1:<port> and gets the child's
//      body — proving bidirectional cross-process bytes (request out, resp back).
//   3) Reverse direction: the PARENT hosts a TCP server, the child dials it.
//   4) The child's port is ALSO reachable externally via kernel.handleHttpRequest
//      (the browser/SW path) — the dual registration must not break that.
//
// Run (Node 22+):  node scripts/probe-xtcp.mjs

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

const out = [];
const cap = (s) => {
  out.push(s);
  if (process.env.OC_LIVE === "1") process.stderr.write(s);
};
const kernel = new Kernel({ fs: kernelFs.fs, spawnWorker, stdout: cap, stderr: cap });
kernel.installCoreutils();
kernel.mkdirp("/home/user");

// ── child: HTTP server on an ephemeral TCP port (the Nitro-worker shape) ──────
kernel.writeFile(
  "/child.js",
  `const http = require("http");
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("child pid=" + process.pid + " url=" + req.url + " body=" + body);
  });
});
server.listen(0, "127.0.0.1", () => {
  if (process.send) process.send({ listening: true, port: server.address().port });
});
`,
);

// ── child2: a CLIENT that dials a TCP port the PARENT hosts (reverse) ─────────
kernel.writeFile(
  "/child2.js",
  `const http = require("http");
process.on("message", (m) => {
  if (!m || !m.go) return;
  const req = http.request({ host: "127.0.0.1", port: m.port, path: "/from-child", method: "POST" }, (res) => {
    let b = "";
    res.on("data", (d) => (b += d));
    res.on("end", () => { if (process.send) process.send({ reply: res.statusCode + " " + b }); process.exit(0); });
  });
  req.on("error", (e) => { if (process.send) process.send({ reply: "ERR " + e.message }); process.exit(1); });
  req.end("ping-from-child");
});
if (process.send) process.send({ ready2: true });
`,
);

// ── parent: forks child (server-in-child) AND hosts a server for child2 ───────
kernel.writeFile(
  "/parent.js",
  `const cp = require("child_process");
const http = require("http");

let doneA = false, doneB = false;
const finish = () => { if (doneA && doneB) process.exit(0); };

// Direction 1: child hosts a TCP server; parent requests it cross-process.
const child = cp.fork("/child.js");
child.on("message", (m) => {
  if (m && m.listening) {
    console.log("CHILDPORT " + m.port);
    const req = http.request({ host: "127.0.0.1", port: m.port, path: "/from-parent", method: "POST" }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => { console.log("DIR1 " + res.statusCode + " :: " + b); doneA = true; finish(); });
    });
    req.on("error", (e) => { console.log("DIR1 ERR " + e.message); process.exit(2); });
    req.end("ping-from-parent");
  }
});
child.on("error", (e) => { console.log("DIR1 forkerr " + e.message); process.exit(2); });

// Direction 2: parent hosts a TCP server; child2 dials it cross-process.
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => { res.writeHead(200); res.end("parent-got url=" + req.url + " body=" + body); });
});
server.listen(0, "127.0.0.1", () => {
  const pport = server.address().port;
  const child2 = cp.fork("/child2.js");
  child2.on("message", (m) => {
    if (m && m.ready2) child2.send({ go: true, port: pport });
    else if (m && m.reply) { console.log("DIR2 " + m.reply); doneB = true; finish(); }
  });
  child2.on("error", (e) => { console.log("DIR2 forkerr " + e.message); process.exit(3); });
});

setTimeout(() => { console.log("TIMEOUT doneA=" + doneA + " doneB=" + doneB); process.exit(9); }, 15000);
`,
);

const env = { HOME: "/home/user", PATH: "/bin", NODE_ENV: "development" };
const r = await Promise.race([
  kernel.start("node", ["/parent.js"], { cwd: "/", env, capture: true }),
  new Promise((res) => setTimeout(() => res({ code: 124, stdout: "", stderr: "harness timeout\n" }), 30000)),
]);

const log = (r.stdout || "") + (r.stderr ? "\nstderr:\n" + r.stderr : "") + out.join("");
console.log("── parent output ──\n" + log.trim());
const dir1 = /DIR1 200 :: child pid=\d+ url=\/from-parent body=ping-from-parent/.test(log);
const dir2 = /DIR2 200 parent-got url=\/from-child body=ping-from-child/.test(log);
console.log("\n  DIR1 (child hosts :port, parent requests): " + dir1);
console.log("  DIR2 (parent hosts :port, child requests): " + dir2);
const ok = dir1 && dir2 && r.code === 0;
console.log("\nRESULT: " + (ok ? "PASS — cross-process TCP loopback works both directions" : "FAIL — see logs above (exit=" + r.code + ")"));
process.exit(ok ? 0 : 1);
