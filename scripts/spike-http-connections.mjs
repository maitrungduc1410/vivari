// Spike (OFFLINE): an http.Server knows its connections, so server.close(),
// closeIdleConnections() and closeAllConnections() close them, as Node does.
//
// WHY THIS EXISTS. The parser binding's ConnectionsList was inert: all() and idle()
// were always empty, so the two close*Connections() calls did nothing and
// server.close() waited for every keep-alive or streaming connection to end on its
// own. Nuxt's CLI (4.1) closes its listener before a hard restart and drains it with
// closeIdleConnections() and then closeAllConnections(); with a browser holding a
// keep-alive or event-stream connection to the dev server, `nuxt dev`'s `r` hung at
// "Restarting Nuxt in a new process..." for good, and `q` waited out its 15 s budget.
//
// The guest script prints one line per check; the expected lines are what Node 26
// prints for the same script (`node` on it directly). It runs once per parser
// backend, since each carries its own copy of the list.
//
//   run:  node scripts/spike-http-connections.mjs

import { bootSpikeKernel } from "./lib/spike-harness.mjs";

let failed = 0;
const ok = (cond, msg, got) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg + (got !== undefined ? `  (${JSON.stringify(got)})` : ""));
  if (!cond) failed++;
};

const SCRIPT = `
const http = require("http");
const net = require("net");
const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => resolve(s)); });
const closed = (server, ms) => new Promise((resolve) => {
  const t = setTimeout(() => resolve("open"), ms);
  server.close(() => { clearTimeout(t); resolve("closed"); });
});
const get = (port, path, agent) => new Promise((resolve) => http.get({ port, host: "127.0.0.1", path, agent }, resolve));

(async () => {
  // 1. An idle keep-alive connection: close() closes it (it calls closeIdleConnections).
  let s = await listen((req, res) => res.end("ok"));
  const agent = new http.Agent({ keepAlive: true });
  const res = await get(s.address().port, "/", agent);
  res.resume();
  await new Promise((r) => res.on("end", r));
  console.log("idle keep-alive, close(): " + await closed(s, 1000));
  agent.destroy();

  // 2. A response still streaming: closeIdleConnections() leaves it, closeAllConnections() ends it.
  s = await listen((req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("retry: 1000\\n\\n"); });
  const sse = await get(s.address().port, "/sse");
  let ended = false;
  sse.on("data", () => {});
  sse.on("close", () => { ended = true; });
  const done = closed(s, 3000);
  s.closeIdleConnections();
  await new Promise((r) => setTimeout(r, 300));
  console.log("streaming, after closeIdleConnections(): " + (ended ? "ended" : "open"));
  s.closeAllConnections();
  console.log("streaming, after closeAllConnections(): " + await done);

  // 3. A request whose body is still arriving is not idle.
  let seen = 0;
  s = await listen((req, res) => { req.on("data", (c) => { seen += c.length; }); req.on("end", () => res.end("got " + seen)); });
  const sock = net.connect(s.address().port, "127.0.0.1");
  let reply = "";
  sock.on("data", (c) => { reply += c; });
  sock.write("POST / HTTP/1.1\\r\\nHost: x\\r\\nContent-Length: 10\\r\\n\\r\\nhello");
  await new Promise((r) => setTimeout(r, 200));
  s.closeIdleConnections();
  await new Promise((r) => setTimeout(r, 200));
  console.log("mid-body, after closeIdleConnections(): " + (sock.destroyed || sock.readyState !== "open" ? "closed" : "open"));
  sock.write("world");
  await new Promise((r) => setTimeout(r, 300));
  console.log("mid-body, reply: " + (/got 10$/.test(reply) ? "got 10" : JSON.stringify(reply.slice(-40))));
  sock.destroy();
  s.close();
  process.exit(0);
})();
`;

// What Node 26 prints for SCRIPT.
const EXPECTED = [
  "idle keep-alive, close(): closed",
  "streaming, after closeIdleConnections(): open",
  "streaming, after closeAllConnections(): closed",
  "mid-body, after closeIdleConnections(): open",
  "mid-body, reply: got 10",
];

const h = await bootSpikeKernel();
const k = h.kernel;
k.mkdirp("/t");
k.writeFile("/t/connections.js", SCRIPT);
for (const parser of ["wasm", "js"]) {
  console.log(`== ${parser} parser ==`);
  const r = await Promise.race([
    k.start("node", ["/t/connections.js"], { cwd: "/t", env: { PATH: "/bin", VV_HTTP_PARSER: parser }, capture: true }),
    new Promise((resolve) => setTimeout(() => resolve({ code: "timeout", stdout: "" }), 20000)),
  ]);
  const lines = (r.stdout || "").trim().split("\n");
  EXPECTED.forEach((want, i) => ok(lines[i] === want, want, lines[i] === want ? undefined : lines[i] ?? `no line, exit ${r.code} ${(r.stderr || "").slice(0, 200)}`));
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
