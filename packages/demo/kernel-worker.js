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

// A background timer that keeps ticking even while the server sits idle with no
// traffic — proof that Event loop v2 runs real timers alongside the accept loop.
const bootedAt = Date.now();
let backgroundTicks = 0;
setInterval(() => { backgroundTicks++; }, 1000);

// The handler is async: for /api/async we await a real timer before responding,
// so the reply is deferred until res.end() fires later. The loop keeps turning
// meanwhile, and concurrent requests are served independently.
const server = http.createServer(async (req, res) => {
  if (req.url === '/api/time') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      now: Date.now(),
      pid: process.pid,
      uptimeMs: Date.now() - bootedAt,
      backgroundTicks,
    }));
    return;
  }
  if (req.url === '/api/async') {
    // Real async request handling: await a timer (like a DB/network call would),
    // THEN finish the response. Nothing blocks; other requests keep flowing.
    const delayMs = 200;
    const start = Date.now();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const body = Buffer.from(JSON.stringify({
      node: process.version,
      awaited: true,
      requestedDelayMs: delayMs,
      actualWaitMs: Date.now() - start,
      backgroundTicks,
      note: 'This response was sent AFTER an awaited setTimeout, via Event loop v2.',
    }, null, 2), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }
  if (req.url === '/api/stream') {
    // Real Node streams (vendored lib/stream.js + internal/streams/*): pipe a
    // Readable through a Transform into a Writable, awaiting the promise API.
    // The response is deferred until the pipeline finishes (Event loop v2).
    const { Readable, Transform, Writable } = require('stream');
    const { pipeline } = require('stream/promises');
    const parts = [];
    await pipeline(
      Readable.from(['open', 'container', 'streams', 'in', 'the', 'browser']),
      new Transform({
        objectMode: true,
        transform(word, enc, cb) { cb(null, word.toString().toUpperCase()); },
      }),
      new Writable({
        objectMode: true,
        write(chunk, enc, cb) { parts.push(chunk.toString()); cb(); },
      }),
    );
    const body = Buffer.from(JSON.stringify({
      node: process.version,
      note: 'Built by pipeline(Readable -> Transform(uppercase) -> Writable) — real Node lib/stream.js in the browser.',
      result: parts.join(' '),
    }, null, 2), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }
  if (req.url === '/api/net') {
    // Real Node net (vendored lib/net.js + internal/stream_base_commons on our
    // tcp_wrap/stream_wrap loopback binding): spin up an in-process TCP echo
    // server, connect a client to it over 127.0.0.1, and round-trip a message —
    // net.Server/net.Socket are real streams, all inside this browser worker.
    const net = require('net');
    const result = await new Promise((resolve, reject) => {
      const echo = net.createServer((sock) => {
        sock.setEncoding('utf8');
        sock.on('data', (d) => sock.write('echo:' + d));
        sock.on('end', () => sock.end());
      });
      echo.listen(0, () => {
        const port = echo.address().port;
        const client = net.connect(port, '127.0.0.1', () => client.end('hello over TCP'));
        client.setEncoding('utf8');
        let buf = '';
        client.on('data', (d) => { buf += d; });
        client.on('end', () => echo.close(() => resolve({ port, reply: buf })));
        client.on('error', reject);
      });
      echo.on('error', reject);
    });
    const body = Buffer.from(JSON.stringify({
      node: process.version,
      note: 'Client wrote "hello over TCP" to an in-process net.Server on 127.0.0.1:' + result.port + '; the server echoed it back — real Node lib/net.js in the browser.',
      ephemeralPort: result.port,
      reply: result.reply,
    }, null, 2), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }
  if (req.url === '/api/http') {
    // Real Node http (vendored lib/http.js + _http_* on the pure-JS
    // internalBinding('http_parser'), over the net loopback): spin up an
    // in-process http.Server, POST a body to it with an http client, and read
    // the echoed response — real ClientRequest/ServerResponse/IncomingMessage,
    // all inside this browser worker. This is the SAME require('http') that
    // serves THIS preview: the request you just made was parsed by Node's real
    // lib/http.js too, bridged in from the Service Worker (#8 stage 2).
    const result = await new Promise((resolve, reject) => {
      const server = http.createServer((r, s) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (c) => body += c);
        r.on('end', () => {
          s.writeHead(200, { 'content-type': 'application/json', 'x-served-by': 'real-node-http' });
          s.end(JSON.stringify({ echo: body, method: r.method, url: r.url }));
        });
      });
      server.listen(0, () => {
        const port = server.address().port;
        const cReq = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/echo' }, (r) => {
          let data = ''; r.setEncoding('utf8');
          r.on('data', (c) => data += c);
          r.on('end', () => server.close(() => resolve({ port, status: r.statusCode, servedBy: r.headers['x-served-by'], reply: data })));
        });
        cReq.on('error', reject);
        cReq.end('hello over HTTP');
      });
      server.on('error', reject);
    });
    const body = Buffer.from(JSON.stringify({
      node: process.version,
      note: 'An http client POSTed "hello over HTTP" to an in-process http.Server on 127.0.0.1:' + result.port + '; the server echoed it back — real Node lib/http.js parsing real HTTP/1.1 in the browser.',
      ephemeralPort: result.port,
      status: result.status,
      servedBy: result.servedBy,
      reply: result.reply,
    }, null, 2), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }
  if (req.url === '/api/buffer') {
    // Exercise Node's REAL Buffer (vendored lib/buffer.js on our
    // internalBinding('buffer')) entirely inside the browser.
    const alloc = Buffer.alloc(4);
    alloc.writeUInt32BE(0xdeadbeef, 0);
    const big = Buffer.alloc(8);
    big.writeBigUInt64BE(0x0102030405060708n, 0);

    const demo = {
      node: process.version,
      isUint8ArraySubclass: Buffer.from('x') instanceof Uint8Array,
      text: 'OpenContainer · café €',
      hex: Buffer.from('OpenContainer').toString('hex'),
      base64: Buffer.from('OpenContainer').toString('base64'),
      base64urlRoundTrip:
        Buffer.from(Buffer.from('café €').toString('base64url'), 'base64url').toString('utf8'),
      utf8ByteLength: Buffer.byteLength('café €', 'utf8'),
      utf16leHex: Buffer.from('hi', 'utf16le').toString('hex'),
      u32_BE_hex: alloc.toString('hex'),
      u32_LE_read: alloc.readUInt32LE(0),
      bigUInt64: big.readBigUInt64BE(0).toString(),
      swap16: Buffer.from([1, 2, 3, 4]).swap16().toString('hex'),
    };

    // The response body is itself built with Buffer, then sent through http.
    const body = Buffer.from(JSON.stringify(demo, null, 2), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }
  if (req.url === '/api/fs') {
    // Exercise Node's REAL fs (vendored lib/fs.js on our internalBinding('fs'),
    // backed by real file descriptors down to the Rust VFS) inside the browser.
    const fs = require('fs');
    const dir = '/tmp/oc-demo';
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir + '/sub', { recursive: true });

    // Low-level fd round-trip: openSync -> writeSync -> fstatSync -> readSync.
    const fd = fs.openSync(dir + '/hello.txt', 'w');
    fs.writeSync(fd, 'hello ');
    fs.writeSync(fd, 'fd world');
    const fdSize = fs.fstatSync(fd).size;
    fs.closeSync(fd);

    fs.appendFileSync(dir + '/hello.txt', '!');
    fs.writeFileSync(dir + '/sub/a.json', JSON.stringify({ ok: true }));
    fs.symlinkSync(dir + '/hello.txt', dir + '/link');
    fs.renameSync(dir + '/sub/a.json', dir + '/sub/b.json');

    const st = fs.statSync(dir + '/hello.txt');
    const demo = {
      node: process.version,
      content: fs.readFileSync(dir + '/hello.txt', 'utf8'),
      viaSymlink: fs.readFileSync(dir + '/link', 'utf8'),
      fdWrittenBytes: fdSize,
      size: st.size,
      ino: st.ino,
      isFile: st.isFile(),
      mtimeISO: st.mtime.toISOString(),
      dirEntries: fs
        .readdirSync(dir, { withFileTypes: true })
        .map((d) => d.name + (d.isDirectory() ? '/' : d.isSymbolicLink() ? '@' : '')),
      subEntries: fs.readdirSync(dir + '/sub'),
      linkTarget: fs.readlinkSync(dir + '/link'),
    };
    const body = Buffer.from(JSON.stringify(demo, null, 2), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }
  if (req.url === '/api/fetch') {
    // Real outbound network (Phase 2 #9): __ocfetch is a blocking fetch serviced
    // by the kernel's dedicated Fetcher Worker, which streams the body into the
    // VFS. We pull left-pad's registry metadata (direct from registry.npmjs.org —
    // it sends CORS *), list its versions, download the latest tarball, then fetch
    // the metadata again to prove the kernel-side content cache (no 2nd network hit).
    const fs = require('fs');
    const metaUrl = 'https://registry.npmjs.org/left-pad';
    const meta = __ocfetch(metaUrl);
    const doc = JSON.parse(fs.readFileSync(meta.path, 'utf8'));
    const versions = Object.keys(doc.versions || {});
    const latest = (doc['dist-tags'] || {}).latest;
    const tarballUrl = doc.versions[latest].dist.tarball;
    const tar = __ocfetch(tarballUrl);
    const again = __ocfetch(metaUrl); // cache hit
    const body = Buffer.from(JSON.stringify({
      node: process.version,
      note: '__ocfetch pulled npm registry metadata + tarball directly from the browser (no proxy) via the Fetcher Worker, into the VFS.',
      metadataUrl: metaUrl,
      status: meta.status,
      contentType: meta.contentType,
      versionCount: versions.length,
      latest,
      tarball: { url: tarballUrl, bytes: tar.size, contentType: tar.contentType },
      cache: { firstFetch: meta.cached, refetch: again.cached },
    }, null, 2), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
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
  <p>Real Node <code>\${process.version}</code> — <code>path</code> + <code>Buffer</code> + <code>fs</code> + <code>stream</code> + <code>net</code> + <code>http</code> vendored, on a real event loop, running in your browser</p>
  <p>You requested <code>\${req.url}</code></p>
  <button onclick="fetch('api/time').then(r=>r.json()).then(t=>document.getElementById('t').textContent=JSON.stringify(t))">GET /api/time</button>
  <button onclick="var el=document.getElementById('a');el.textContent='awaiting setTimeout(200ms)…';fetch('api/async').then(r=>r.json()).then(t=>el.textContent=JSON.stringify(t,null,2))">GET /api/async (awaits a timer)</button>
  <button onclick="fetch('api/stream').then(r=>r.json()).then(t=>document.getElementById('s').textContent=JSON.stringify(t,null,2))">GET /api/stream (pipeline)</button>
  <button onclick="fetch('api/net').then(r=>r.json()).then(t=>document.getElementById('n').textContent=JSON.stringify(t,null,2))">GET /api/net (TCP loopback)</button>
  <button onclick="fetch('api/http').then(r=>r.json()).then(t=>document.getElementById('h').textContent=JSON.stringify(t,null,2))">GET /api/http (real http server+client)</button>
  <button onclick="fetch('api/buffer').then(r=>r.json()).then(t=>document.getElementById('b').textContent=JSON.stringify(t,null,2))">GET /api/buffer</button>
  <button onclick="fetch('api/fs').then(r=>r.json()).then(t=>document.getElementById('f').textContent=JSON.stringify(t,null,2))">GET /api/fs</button>
  <button onclick="var el=document.getElementById('nf');el.textContent='fetching npm registry…';fetch('api/fetch').then(r=>r.json()).then(t=>el.textContent=JSON.stringify(t,null,2)).catch(e=>el.textContent=String(e))">GET /api/fetch (npm registry)</button>
  <p style="color:#8b949e;font-size:12px">Tip: hit <code>/api/time</code> repeatedly — <code>backgroundTicks</code> keeps rising because a <code>setInterval</code> runs while the server is idle.</p>
  <pre id="t"></pre>
  <pre id="a"></pre>
  <pre id="s"></pre>
  <pre id="n"></pre>
  <pre id="h"></pre>
  <pre id="b"></pre>
  <pre id="f"></pre>
  <pre id="nf"></pre>
</div></body></html>\`);
});

server.listen(3000, () =>
  console.log('[server] listening on http://localhost:3000 (pid ' + process.pid +
    ') · Buffer check ' + Buffer.from('ok').toString('hex') + ' · node ' + process.version));
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
    return {
      terminate: () => worker.terminate(),
      postMessage: (m) => worker.postMessage(m),
    };
  };

  // Dedicated Fetcher Worker (Phase 2 #9): all outbound network goes through it,
  // so downloading/decompressing large npm payloads never stalls syscall
  // servicing. The kernel calls `fetcher(url)`; we bridge that to the worker.
  const fetcherWorker = new Worker(new URL("./fetcher-worker.js", import.meta.url), {
    type: "module",
    name: "Fetcher Worker",
  });
  let fetchSeq = 1;
  const fetchPending = new Map();
  fetcherWorker.onmessage = (event) => {
    const m = event.data;
    if (m.type !== "fetch-result") return;
    const p = fetchPending.get(m.id);
    if (!p) return;
    fetchPending.delete(m.id);
    if (m.error) p.reject(new Error(m.error));
    else p.resolve({ ok: m.ok, status: m.status, headers: m.headers, body: new Uint8Array(m.body) });
  };
  const fetcher = (url) =>
    new Promise((resolve, reject) => {
      const id = fetchSeq++;
      fetchPending.set(id, { resolve, reject });
      fetcherWorker.postMessage({ type: "fetch", id, url });
    });

  kernel = new Kernel({
    vfs,
    spawnWorker,
    fetcher,
    stdout: (chunk) => post("stdout", { chunk }),
    stderr: (chunk) => post("stderr", { chunk }),
  });
  kernel.onProcExit = (pid, res) => post("exit", { pid, code: res.code });
  kernel.onListen = (port, pid) => post("listen", { port, pid });
  kernel.onFetch = (url, info) =>
    post("log", {
      line: `  [fetcher] ${info.cached ? "cache hit " : "downloaded"} ${info.size}B · ${url}`,
      cls: "muted",
    });

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

  // Phase 2 #10: real `npm install` in the browser. Resolves is-odd + its
  // transitive dep is-number live from registry.npmjs.org (via the Fetcher
  // Worker), gunzips/untars each tarball into node_modules, then a node process
  // require()s the freshly installed tree — no bundler, the real package on disk.
  kernel.mkdirp("/app");
  kernel.writeFile("/app/package.json", JSON.stringify({ name: "demo-app", version: "1.0.0" }, null, 2));
  kernel.writeFile(
    "/app/index.js",
    "const isOdd = require('is-odd');\n" +
      "console.log('[npm demo] is-odd(3) =', isOdd(3), '| is-odd(4) =', isOdd(4));\n",
  );
  post("log", { line: "$ cd /app && npm install is-odd", cls: "muted" });
  await kernel.start("npm", ["install", "is-odd"], { cwd: "/app" });
  post("log", { line: "$ node /app/index.js", cls: "muted" });
  await kernel.start("node", ["/app/index.js"], { cwd: "/app" });
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
