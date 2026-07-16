// Spike (NETWORK): prove the Socket.IO Showcase template boots and serves a live
// Socket.IO endpoint in-VM. Mirrors the shipped `socketio` template in
// packages/studio/src/vv/templates.ts.
//
// The real-time chat runs over WebSockets tunneled through the preview (the ws
// tunnel is covered by ws-demo/spike-ws). Here we prove the server side in-VM:
// install ok, `node server.js` binds :3000, GET / serves the chat UI, the
// Socket.IO client script is served at /socket.io/socket.io.js, and the engine.io
// polling handshake responds with a session that advertises the websocket upgrade.
//   run (Node 22+):  node scripts/spike-socketio.mjs   (needs vendored npm — see spike-harness)
import { bootSpikeKernel, writeProject, npmInstall, waitListen, httpGet } from "./lib/spike-harness.mjs";

const DIR = "/socketio";
const PORT = Number(process.env.VV_PORT || 3000);
const h = await bootSpikeKernel();

writeProject(h.kernel, DIR, {
  "package.json": `{
  "name": "socketio-chat",
  "private": true,
  "version": "0.0.0",
  "type": "commonjs",
  "scripts": { "start": "node server.js", "dev": "node server.js" },
  "dependencies": { "express": "^4.21.0", "socket.io": "^4.8.0" }
}
`,
  "server.js": `const express = require('express');
const { createServer } = require('node:http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

io.on('connection', (socket) => {
  socket.on('chat', (msg) => io.emit('chat', msg));
});

app.use(express.static(path.join(__dirname, 'public')));

const port = Number(process.env.PORT ?? ${PORT});
httpServer.listen(port, () => console.log('Socket.IO chat on http://localhost:' + port));
`,
  "public/index.html": `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><title>Socket.IO chat</title></head>
<body><h1>Socket.IO chat</h1><script src="/socket.io/socket.io.js"></script></body></html>
`,
});

const inst = await npmInstall(h, { dir: DIR });
if (inst.code !== 0) process.exit(1);
if (process.env.VV_INSTALL_ONLY === "1") process.exit(0);

const bound = await waitListen(h, { dir: DIR, port: PORT, argv: ["server.js"] });

let uiOk = false;
let clientJsOk = false;
let handshakeOk = false;

if (bound) {
  const ui = await httpGet(h.kernel, PORT, "/");
  uiOk = ui.status === 200 && /Socket\.IO chat/.test(ui.body);
  console.log(`  GET / -> ${ui.status}  ${/Socket\.IO chat/.test(ui.body) ? "(chat UI)" : ui.body.slice(0, 80)}`);

  const clientJs = await httpGet(h.kernel, PORT, "/socket.io/socket.io.js");
  clientJsOk = clientJs.status === 200 && /socket\.io|io\b/i.test(clientJs.body);
  console.log(`  GET /socket.io/socket.io.js -> ${clientJs.status}  (${clientJs.body.length} bytes)`);

  // engine.io polling handshake: returns "0{...sid...upgrades:[websocket]...}".
  const hs = await httpGet(h.kernel, PORT, "/socket.io/?EIO=4&transport=polling");
  handshakeOk = hs.status === 200 && /"sid"/.test(hs.body) && /websocket/.test(hs.body);
  console.log(`  GET /socket.io/?EIO=4 -> ${hs.status}  ${hs.body.slice(0, 90)}`);
}

const ok = inst.code === 0 && bound && uiOk && clientJsOk && handshakeOk;
console.log(
  "\nRESULT: " +
    (ok
      ? "PASS — Socket.IO serves the chat UI, client script, and a live engine.io handshake in-VM"
      : "FAIL — see logs above"),
);
process.exit(ok ? 0 : 1);
