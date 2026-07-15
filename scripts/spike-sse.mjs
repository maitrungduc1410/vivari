// Spike (NETWORK): prove the Server-Sent Events showcase template streams live
// over the oc-sse tunnel. Mirrors the shipped `sse` template in
// packages/studio/src/oc/templates.ts.
//
// The browser reaches SSE via an EventSource polyfill that tunnels to
// kernel.handleSseClient(); the in-VM runtime opens a loopback GET to /events and
// relays each text/event-stream chunk back out via kernel.onSseSend(). We can't
// use httpGet() here — a never-ending event-stream never resolves the buffered
// HTTP path — so this drives that exact tunnel headlessly.
//
// Gates: install ok, `node server/index.js` binds :3000, the tunnel opens, and we
// receive default (tick), named `metric`, and named `notice` events within a few
// seconds.
//   run (Node 22+):  node scripts/spike-sse.mjs   (needs vendored npm — see spike-harness)
import { bootSpikeKernel, writeProject, npmInstall, waitListen } from "./lib/spike-harness.mjs";

const DIR = "/sse";
const PORT = Number(process.env.OC_PORT || 3000);
const h = await bootSpikeKernel();

writeProject(h.kernel, DIR, {
  "package.json": `{
  "name": "sse-demo",
  "private": true,
  "version": "0.0.0",
  "type": "commonjs",
  "scripts": { "start": "node server/index.js", "dev": "node server/index.js" },
  "dependencies": { "express": "^4.21.0" }
}
`,
  "server/index.js": `const express = require('express');
const app = express();
const port = Number(process.env.PORT ?? ${PORT});

app.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 2000\\n\\n');
  let n = 0;
  const send = (event, data) => {
    if (event) res.write('event: ' + event + '\\n');
    res.write('id: ' + Date.now() + '\\n');
    res.write('data: ' + JSON.stringify(data) + '\\n\\n');
  };
  send('notice', { level: 'info', text: 'stream opened' });
  send(null, { n: n, time: new Date().toISOString() });
  send('metric', { value: 50 });
  const tick = setInterval(() => {
    n++;
    send(null, { n: n, time: new Date().toISOString() });
    send('metric', { value: Math.round(20 + Math.random() * 80) });
    if (n % 2 === 0) send('notice', { level: 'ok', text: 'batch ' + n });
  }, 500);
  req.on('close', () => clearInterval(tick));
});

app.listen(port, () => console.log('SSE demo on http://localhost:' + port));
`,
});

const inst = await npmInstall(h, { dir: DIR });
if (inst.code !== 0) process.exit(1);
if (process.env.OC_INSTALL_ONLY === "1") process.exit(0);

const bound = await waitListen(h, { dir: DIR, port: PORT, argv: ["server/index.js"] });

// Drive the SSE tunnel exactly as the browser EventSource polyfill would.
const events = []; // parsed {type, data}
let opened = false;
let closed = false;
let buf = "";
const parseFrames = (text) => {
  buf = (buf + text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let idx;
  while ((idx = buf.indexOf("\n\n")) >= 0) {
    const raw = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    let type = "message";
    const data = [];
    for (const line of raw.split("\n")) {
      if (line === "" || line[0] === ":") continue;
      const c = line.indexOf(":");
      const field = c === -1 ? line : line.slice(0, c);
      let value = c === -1 ? "" : line.slice(c + 1);
      if (value[0] === " ") value = value.slice(1);
      if (field === "event") type = value;
      else if (field === "data") data.push(value);
    }
    if (data.length) events.push({ type, data: data.join("\n") });
  }
};

if (bound) {
  h.kernel.onSseSend = (m) => {
    if (m.sub === "open") opened = true;
    else if (m.sub === "chunk") parseFrames(String(m.data == null ? "" : m.data));
    else if (m.sub === "close") closed = true;
  };
  const connId = "spike-1";
  h.kernel.handleSseClient({ sub: "open", connId, port: PORT, fallbackPort: PORT, path: "/events" });

  const WATCH_MS = Number(process.env.OC_SSE_WATCH || 4000);
  const t0 = Date.now();
  while (Date.now() - t0 < WATCH_MS) {
    await new Promise((r) => setTimeout(r, 100));
  }
  h.kernel.handleSseClient({ sub: "close", connId });
}

const ticks = events.filter((e) => e.type === "message");
const metrics = events.filter((e) => e.type === "metric");
const notices = events.filter((e) => e.type === "notice");
console.log(
  `  tunnel: opened=${opened} events=${events.length}  ticks=${ticks.length} metric=${metrics.length} notice=${notices.length} closed=${closed}`,
);
if (ticks[0]) console.log(`  first tick: ${ticks[0].data.slice(0, 100)}`);

let ticksProgress = false;
try {
  // The default (unnamed) events carry an incrementing counter — prove it advances.
  const ns = ticks.map((e) => JSON.parse(e.data).n).filter((n) => Number.isInteger(n));
  ticksProgress = ns.length >= 2 && ns[ns.length - 1] > ns[0];
} catch {}

const ok =
  inst.code === 0 &&
  bound &&
  opened &&
  ticks.length >= 2 &&
  metrics.length >= 2 &&
  notices.length >= 1 &&
  ticksProgress;
console.log(
  "\nRESULT: " +
    (ok
      ? "PASS — SSE streams default + named (metric/notice) events over the oc-sse tunnel"
      : "FAIL — see logs above"),
);
process.exit(ok ? 0 : 1);
