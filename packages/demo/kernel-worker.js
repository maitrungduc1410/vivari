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

import { Kernel } from "../kernel-host/kernel.js";
import { createKernelFs } from "../kernel-host/kernel-fs.js";

const post = (type, extra) => self.postMessage({ type, ...extra });

// [optimize] Compile the Rust/Wasm codecs (zlib #11, crypto #12) EXACTLY ONCE,
// here in the kernel worker, and hand each Process Worker the resulting
// `WebAssembly.Module`. A Module is structured-cloneable across workers and
// carries the already-compiled code, so a spawned process instantiates from it
// (cheap, sync, no network) instead of re-fetching + re-compiling the bytes on
// every spawn. Combined with lazy instantiation in the process (only on first
// real zlib/crypto use), a process that never compresses/hashes pays nothing.
async function compileWasmModule(url) {
  try {
    // Streaming compile (server sends application/wasm) — one fetch, one compile.
    return await WebAssembly.compileStreaming(fetch(url));
  } catch {
    try {
      const bytes = await (await fetch(url)).arrayBuffer();
      return await WebAssembly.compile(bytes);
    } catch {
      return null; // codec unavailable → process falls back (pure-JS hashes, no zlib)
    }
  }
}

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
  if (req.url === '/api/zlib') {
    // Real Node zlib (vendored lib/zlib.js on internalBinding('zlib'), backed by
    // the Rust/Wasm codec #11): gzip a payload, gunzip it back, deflate-raw, and
    // compute a crc32 — all synchronous, all inside this browser worker.
    const zlib = require('zlib');
    const text = 'OpenContainer '.repeat(64) + 'café € — real zlib in the browser';
    const input = Buffer.from(text, 'utf8');
    const gz = zlib.gzipSync(input);
    const roundTrip = zlib.gunzipSync(gz).toString('utf8');
    const raw = zlib.deflateRawSync(input);
    const body = Buffer.from(JSON.stringify({
      node: process.version,
      note: 'gzipSync -> gunzipSync + deflateRawSync + crc32 — Node real lib/zlib.js over the Rust/Wasm codec (#11), in the browser.',
      originalBytes: input.length,
      gzippedBytes: gz.length,
      deflateRawBytes: raw.length,
      compression: (gz.length / input.length).toFixed(3) + 'x',
      gzipMagicHex: gz.subarray(0, 3).toString('hex'),
      crc32: (zlib.crc32(input) >>> 0).toString(16),
      roundTripOk: roundTrip === text,
    }, null, 2), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }
  if (req.url === '/api/crypto') {
    // Our crypto (lib/crypto.js on internalBinding('crypto'), backed by the
    // Rust/Wasm crypto codec #12): hashes, HMAC, PBKDF2, and a full AES-256-GCM
    // encrypt -> decrypt round-trip (with AAD + auth tag), all in the browser.
    const crypto = require('crypto');
    const msg = 'OpenContainer secret · café €';
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('demo-aad'));
    const enc = Buffer.concat([cipher.update(msg, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from('demo-aad'));
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    const sha512 = crypto.createHash('sha512').update(msg).digest('hex');
    const body = Buffer.from(JSON.stringify({
      node: process.version,
      note: 'createHash/createHmac/pbkdf2Sync + AES-256-GCM encrypt->decrypt — our lib/crypto.js over the Rust/Wasm crypto codec (#12), in the browser.',
      sha256: crypto.createHash('sha256').update(msg).digest('hex'),
      sha512Preview: sha512.slice(0, 32) + '…',
      hmacSha256: crypto.createHmac('sha256', 'oc-key').update(msg).digest('hex'),
      pbkdf2: crypto.pbkdf2Sync('password', 'salt', 10000, 32, 'sha256').toString('hex'),
      aesGcm: {
        ivHex: iv.toString('hex'),
        cipherHex: enc.toString('hex'),
        authTagHex: tag.toString('hex'),
        decrypted,
        roundTripOk: decrypted === msg,
      },
      randomUUID: crypto.randomUUID(),
    }, null, 2), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }
  if (req.url === '/api/esm') {
    // Phase 2 #13: this CJS server require()s an ESM module graph. The .mjs files
    // use import/export, re-export, import.meta, and dynamic import() — all
    // transpiled to our synchronous CJS at load time (es-module-lexer), no bundler.
    const demo = require('/srv/esm-demo/index.mjs');
    const lazy = await demo.loadLazy();
    const body = Buffer.from(JSON.stringify({
      node: process.version,
      note: 'A CJS server require()d an ESM graph (import/export/re-export/import.meta/dynamic import), transpiled ESM->CJS at load time (#13), in the browser.',
      isEsModule: demo.__esModule === true,
      pi: demo.pi,
      info: demo.info,
      metaUrl: demo.metaUrl,
      dynamicImport: lazy,
    }, null, 2), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }
  if (req.url === '/api/wasi') {
    // Phase 2 #16: a real Rust CLI compiled to wasm32-wasip1 (packages/wasi-demo),
    // run unmodified via require('wasi'). It reads argv/env, opens a file in a
    // preopened dir, uppercases it, and writes an output file — every fd/path call
    // bridged to our VFS. Sync compile+instantiate is allowed here (we're a Worker).
    const fs = require('fs');
    const { WASI } = require('wasi');
    const input = 'hello from the browser · wasm32-wasi';
    fs.mkdirSync('/work', { recursive: true });
    fs.writeFileSync('/work/in.txt', input + '\\n');
    const wasi = new WASI({
      version: 'preview1',
      args: ['wasi_demo', '/work/in.txt', '/work/out.txt'],
      env: { WASI_GREETING: 'browser' },
      preopens: { '/work': '/work' },
    });
    const mod = new WebAssembly.Module(fs.readFileSync('/wasi/wasi_demo.wasm'));
    const instance = new WebAssembly.Instance(mod, wasi.getImportObject());
    const exitCode = wasi.start(instance);
    const output = fs.readFileSync('/work/out.txt', 'utf8');
    const body = Buffer.from(JSON.stringify({
      node: process.version,
      note: 'A real Rust CLI compiled to wasm32-wasip1, run via require("wasi") — argv/env/preopen + fd_read/fd_write bridged to the VFS (#16 stage 1), in the browser.',
      input,
      output,
      exitCode,
      wasmBytes: fs.statSync('/wasi/wasi_demo.wasm').size,
    }, null, 2), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }
  if (req.url === '/api/napi') {
    // Phase 2 #16 stage 2a: a REAL N-API native addon compiled to wasm32-wasi
    // (@node-rs/crc32-wasm32-wasi, a Rust crate) run unmodified via require().
    // Its napi-rs wrapper loads our vendored @napi-rs/wasm-runtime (the emnapi
    // host, pure JS, implementing the napi_* C ABI in JS) and satisfies the
    // wasm's wasi_snapshot_preview1 imports with our own require('wasi').
    try {
      const crc = require('@node-rs/crc32-wasm32-wasi');
      const text = 'OpenContainer · napi-on-wasm';
      const body = Buffer.from(JSON.stringify({
        node: process.version,
        note: 'A real N-API native addon (Rust → wasm32-wasi) run via require() over vendored emnapi + our WASI (#16 stage 2a), in the browser.',
        addon: '@node-rs/crc32-wasm32-wasi',
        crc32_hello: crc.crc32('hello'),
        crc32c_hello: crc.crc32c('hello'),
        crc32_text: crc.crc32(text),
        crc32_buffer_arg: crc.crc32(Buffer.from(text)),
      }, null, 2), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
    } catch (err) {
      console.error('[napi] route failed: ' + (err && err.stack || err));
      const body = Buffer.from(JSON.stringify({
        error: String(err && err.message || err),
        stack: String(err && err.stack || ''),
      }, null, 2), 'utf8');
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
    }
    return;
  }
  if (req.url === '/api/esbuild') {
    // Bundler Stage 1: a REAL bundler (esbuild, Go -> wasm) runs IN-VM. The Node
    // entry would child_process.spawn a helper and pipe over stdin; instead we use
    // esbuild's BROWSER build with worker:false, which runs the Go wasm on THIS
    // thread (postMessage-simulated stdio) — no child process, no stdin fd. The
    // 11MB wasm is installed on demand (first call) and the service cached after.
    try {
      const fs = require('fs');
      const cp = require('child_process');
      if (!globalThis.__esbuildSvc) {
        let present = true;
        try { require.resolve('esbuild-wasm/lib/browser.js'); } catch (e) { present = false; }
        if (!present) {
          console.log('[esbuild] npm install esbuild-wasm (~11MB, first call only)…');
          await new Promise((resolve, reject) => {
            const c = cp.spawn('npm', ['install', 'esbuild-wasm'], { cwd: '/srv' });
            c.stdout.on('data', (d) => process.stdout.write(d));
            c.stderr.on('data', (d) => process.stderr.write(d));
            c.on('close', (code) => code === 0 ? resolve() : reject(new Error('npm install esbuild-wasm exited ' + code)));
          });
        }
        const esbuild = require('esbuild-wasm/lib/browser.js');
        const wasmModule = new WebAssembly.Module(fs.readFileSync(require.resolve('esbuild-wasm/esbuild.wasm')));
        await esbuild.initialize({ wasmModule, worker: false });
        globalThis.__esbuildSvc = esbuild;
        console.log('[esbuild] service ready (esbuild ' + (esbuild.version || '?') + ')');
      }
      const esbuild = globalThis.__esbuildSvc;
      const tsInput = 'export const greet = (name: string): string => "hi " + name;';
      const t = await esbuild.transform(tsInput, { loader: 'ts' });
      const b = await esbuild.build({
        stdin: { contents: 'export const sum = (a, b) => a + b; console.log("sum", sum(2, 3));', loader: 'js' },
        bundle: true, format: 'iife', write: false,
      });
      const body = Buffer.from(JSON.stringify({
        node: process.version,
        note: 'esbuild (Go -> wasm) ran IN-VM via its browser build + worker:false — a real, unmodified bundler transpiling TS and bundling ESM to an IIFE, in the browser.',
        esbuildVersion: esbuild.version,
        tsInput: tsInput,
        jsOutput: t.code,
        bundleOutput: b.outputFiles[0].text,
      }, null, 2), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
    } catch (err) {
      console.error('[esbuild] route failed: ' + (err && err.stack || err));
      const body = Buffer.from(JSON.stringify({
        error: String(err && err.message || err),
        stack: String(err && err.stack || ''),
      }, null, 2), 'utf8');
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
    }
    return;
  }
  if (req.url === '/api/spawn') {
    // Phase 2 #15: child_process.spawn() launches a Node child WITHOUT blocking —
    // its stdout streams back to us live (several 'data' events across timers,
    // not one buffer at exit), and we await its 'close' to report the exit code.
    const cp = require('child_process');
    const result = await new Promise((resolve) => {
      const child = cp.spawn('node', ['/srv/spawn-child.js'], { cwd: '/srv' });
      const lines = [];
      let dataEvents = 0;
      child.stdout.on('data', (d) => { dataEvents++; lines.push(d.toString()); });
      child.on('close', (code) => resolve({ pid: child.pid, code, dataEvents, output: lines.join('') }));
    });
    const body = Buffer.from(JSON.stringify({
      node: process.version,
      note: 'child_process.spawn() ran a Node child; its stdout STREAMED back live over multiple data events and we awaited exit — async spawn (#15), in the browser.',
      childPid: result.pid,
      exitCode: result.code,
      dataEvents: result.dataEvents,
      output: result.output,
    }, null, 2), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }
  if (req.url === '/api/threads') {
    // Phase 2 #16 stage 2b: worker_threads.Worker spawns a REAL nested thread
    // (its own kernel-allocated syscall SAB + FS registration). It sums 1..N OFF
    // the main thread, posts the total back over the direct MessageChannel, AND
    // writes it into a SharedArrayBuffer we read via Atomics — true shared memory.
    const { Worker } = require('worker_threads');
    const sab = new SharedArrayBuffer(8);
    const shared = new Int32Array(sab);
    const N = 65535; // sum(1..N) = 2147450880, fits in an int32 for a clean proof
    const result = await new Promise((resolve) => {
      const w = new Worker('/srv/thread-worker.js', { workerData: { sab, n: N } });
      let online = false;
      w.on('online', () => { online = true; });
      w.on('message', (m) => {
        if (m === 'ready') w.postMessage('go');
        else if (m && m.done) {
          const r = { threadId: w.threadId, online, sum: m.sum, sharedSum: Atomics.load(shared, 0) };
          w.terminate();
          resolve(r);
        }
      });
    });
    const body = Buffer.from(JSON.stringify({
      node: process.version,
      note: 'worker_threads.Worker ran a real nested thread: it summed 1..N off the main thread, posted the total back, and wrote it into a SharedArrayBuffer we read via Atomics (#16 stage 2b), in the browser.',
      n: N,
      threadId: result.threadId,
      online: result.online,
      sumFromMessage: result.sum,
      sumFromSharedMemory: result.sharedSum,
      match: result.sum === result.sharedSum,
    }, null, 2), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }
  if (req.url === '/api/persist') {
    // OPFS persistence proof: read a counter file, bump it, write it back. The
    // File System Worker mirrors /data/visits.json to the Origin Private File
    // System, so this count SURVIVES a page reload (F5) — real durable fs in the
    // browser, no server. Reload the page and hit this again: it keeps climbing.
    const fs = require('fs');
    const path = require('path');
    const file = '/data/visits.json';
    let state = { visits: 0, firstSeen: new Date().toISOString() };
    let restored = false;
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
      restored = true; // the file was already there => it came back from OPFS
    } catch { /* first ever visit */ }
    state.visits = (state.visits | 0) + 1;
    state.lastSeen = new Date().toISOString();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state));
    const body = Buffer.from(JSON.stringify({
      note: 'This counter lives in the VFS at /data/visits.json and is mirrored to OPFS. Reload the page (do NOT use ?reset) and hit this again — visits keeps increasing, proving the filesystem persisted across reloads.',
      restoredFromDisk: restored,
      ...state,
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
  <p>Real Node <code>\${process.version}</code> — <code>path</code> + <code>Buffer</code> + <code>fs</code> + <code>stream</code> + <code>net</code> + <code>http</code> + <code>zlib</code> + <code>crypto</code> vendored (+ <code>ESM</code> import/export), on a real event loop, running in your browser</p>
  <p>You requested <code>\${req.url}</code></p>
  <button onclick="fetch('api/time').then(r=>r.json()).then(t=>document.getElementById('t').textContent=JSON.stringify(t))">GET /api/time</button>
  <button onclick="var el=document.getElementById('a');el.textContent='awaiting setTimeout(200ms)…';fetch('api/async').then(r=>r.json()).then(t=>el.textContent=JSON.stringify(t,null,2))">GET /api/async (awaits a timer)</button>
  <button onclick="fetch('api/stream').then(r=>r.json()).then(t=>document.getElementById('s').textContent=JSON.stringify(t,null,2))">GET /api/stream (pipeline)</button>
  <button onclick="fetch('api/net').then(r=>r.json()).then(t=>document.getElementById('n').textContent=JSON.stringify(t,null,2))">GET /api/net (TCP loopback)</button>
  <button onclick="fetch('api/http').then(r=>r.json()).then(t=>document.getElementById('h').textContent=JSON.stringify(t,null,2))">GET /api/http (real http server+client)</button>
  <button onclick="fetch('api/buffer').then(r=>r.json()).then(t=>document.getElementById('b').textContent=JSON.stringify(t,null,2))">GET /api/buffer</button>
  <button onclick="fetch('api/fs').then(r=>r.json()).then(t=>document.getElementById('f').textContent=JSON.stringify(t,null,2))">GET /api/fs</button>
  <button onclick="fetch('api/zlib').then(r=>r.json()).then(t=>document.getElementById('z').textContent=JSON.stringify(t,null,2))">GET /api/zlib (gzip + crc32)</button>
  <button onclick="fetch('api/crypto').then(r=>r.json()).then(t=>document.getElementById('c').textContent=JSON.stringify(t,null,2))">GET /api/crypto (hash + AES-GCM)</button>
  <button onclick="fetch('api/esm').then(r=>r.json()).then(t=>document.getElementById('e').textContent=JSON.stringify(t,null,2))">GET /api/esm (import/export)</button>
  <button onclick="fetch('api/wasi').then(r=>r.json()).then(t=>document.getElementById('w').textContent=JSON.stringify(t,null,2))">GET /api/wasi (wasm32-wasi CLI)</button>
  <button onclick="fetch('api/napi').then(r=>r.json()).then(t=>document.getElementById('np').textContent=JSON.stringify(t,null,2))">GET /api/napi (N-API addon on wasm)</button>
  <button onclick="var el=document.getElementById('es');el.textContent='installing esbuild-wasm (~11MB) + bundling… (first call is slow)';fetch('api/esbuild').then(r=>r.json()).then(t=>el.textContent=JSON.stringify(t,null,2)).catch(e=>el.textContent=String(e))">GET /api/esbuild (real bundler)</button>
  <button onclick="fetch('api/spawn').then(r=>r.json()).then(t=>document.getElementById('sp').textContent=JSON.stringify(t,null,2))">GET /api/spawn (async child_process)</button>
  <button onclick="fetch('api/threads').then(r=>r.json()).then(t=>document.getElementById('wt').textContent=JSON.stringify(t,null,2))">GET /api/threads (worker_threads + SAB)</button>
  <button onclick="fetch('api/persist').then(r=>r.json()).then(t=>document.getElementById('pv').textContent=JSON.stringify(t,null,2))">GET /api/persist (OPFS — survives reload)</button>
  <button onclick="var el=document.getElementById('nf');el.textContent='fetching npm registry…';fetch('api/fetch').then(r=>r.json()).then(t=>el.textContent=JSON.stringify(t,null,2)).catch(e=>el.textContent=String(e))">GET /api/fetch (npm registry)</button>
  <p style="color:#8b949e;font-size:12px">Tip: hit <code>/api/time</code> repeatedly — <code>backgroundTicks</code> keeps rising because a <code>setInterval</code> runs while the server is idle.</p>
  <pre id="t"></pre>
  <pre id="a"></pre>
  <pre id="s"></pre>
  <pre id="n"></pre>
  <pre id="h"></pre>
  <pre id="b"></pre>
  <pre id="f"></pre>
  <pre id="z"></pre>
  <pre id="c"></pre>
  <pre id="e"></pre>
  <pre id="w"></pre>
  <pre id="np"></pre>
  <pre id="es"></pre>
  <pre id="sp"></pre>
  <pre id="wt"></pre>
  <pre id="pv"></pre>
  <pre id="nf"></pre>
</div></body></html>\`);
});

server.listen(3000, () =>
  console.log('[server] listening on http://localhost:3000 (pid ' + process.pid +
    ') · Buffer check ' + Buffer.from('ok').toString('hex') + ' · node ' + process.version));
`;

// A REAL Express app — the framework installed from npm, unmodified — running on
// our vendored Node stack. express.json() exercises body-parser (needs zlib +
// crypto for ETag), the router covers params, all inside the browser worker.
const EXPRESS_SERVER_SRC = `
const express = require('express');
const app = express();
app.use(express.json());

app.get('/api/hello', (req, res) => {
  res.json({ ok: true, msg: 'hello from express', node: process.version, pid: process.pid });
});
app.get('/api/users/:id', (req, res) => {
  res.json({ id: req.params.id, name: 'user-' + req.params.id });
});
app.post('/api/echo', (req, res) => {
  res.json({ youSent: req.body, at: Date.now() });
});

app.listen(3100, () =>
  console.log('[express] listening on http://localhost:3100 (pid ' + process.pid +
    ') · express ' + require('express/package.json').version));
`;

// roadmap #19 stage C — a real Vite dev server running in-VM with live HMR
// tunneled to the preview iframe. The app self-accepts an HMR update on
// ./message.js: editing that file in the host textarea re-renders WITHOUT a
// full page reload — the classic Vite HMR boundary, proven end to end.
const VITE_PORT = 5199;
const VITE_DIR = "/vite-app";
const VITE_APP = {
  "package.json": JSON.stringify(
    { name: "hmr-demo", version: "1.0.0", private: true, type: "module" },
    null,
    2,
  ),
  "index.html":
    "<!doctype html>\n<html>\n<head><meta charset='utf-8'><title>Vite HMR · OpenContainer</title>\n" +
    "<style>body{font-family:ui-monospace,Menlo,monospace;background:#0b0e14;color:#d4d7dd;" +
    "display:grid;place-items:center;height:100vh;margin:0}" +
    ".card{border:1px solid #1c2230;border-radius:12px;padding:32px 40px;background:#0e131c;text-align:center;max-width:80%}" +
    "h1{color:#7ee787;margin:0 0 12px}" +
    ".hint{color:#6b7385;font-size:12px;margin-top:16px}</style></head>\n" +
    "<body><div class='card'><h1>Vite HMR — live in the browser VM</h1>" +
    "<div id='msg'>…</div>" +
    "<div class='hint'>Served by a real <code>vite</code> dev server running inside OpenContainer.<br>" +
    "Edit <code>src/message.js</code> (JS module HMR) or <code>src/styles.css</code> (CSS HMR) on the " +
    "left and save — both update with no page reload.</div>" +
    "</div>\n<script type='module' src='/src/main.js'></script>\n</body>\n</html>\n",
  "src/message.js":
    "export const message =\n  'Hello from Vite HMR running inside OpenContainer!\\n" +
    "Edit me on the left and hit Save — no page reload.';\n",
  "src/styles.css":
    "/* Edit me too — Vite hot-swaps CSS with no reload (watch #msg restyle live). */\n" +
    "#msg {\n" +
    "  font-size: 20px;\n" +
    "  white-space: pre-wrap;\n" +
    "  color: #7ee787;\n" +
    "  padding: 16px 20px;\n" +
    "  border: 1px solid #234;\n" +
    "  border-radius: 10px;\n" +
    "  background: #0b0e14;\n" +
    "  transition: color 0.2s, background 0.2s;\n" +
    "}\n",
  "src/main.js":
    "import './styles.css';\n" +
    "import { message } from './message.js';\n\n" +
    "const el = document.getElementById('msg');\n" +
    "function render(text) { el.textContent = text; }\n" +
    "render(message);\n\n" +
    "// JS module HMR boundary. CSS is hot-swapped automatically by Vite (the\n" +
    "// ./styles.css import is a self-accepting boundary), so no accept() needed.\n" +
    "if (import.meta.hot) {\n" +
    "  import.meta.hot.accept('./message.js', (mod) => {\n" +
    "    render(mod.message);\n" +
    "    console.log('[hmr] message.js hot-updated');\n" +
    "  });\n" +
    "}\n",
};

// The files the host editor can edit live (absolute VFS paths -> initial text).
const VITE_EDIT_FILES = [VITE_DIR + "/src/message.js", VITE_DIR + "/src/styles.css"];

// Boots the dev server (HMR enabled). Base stays '/' — the preview SW controls
// the whole origin and routes Vite's root-absolute URLs (/@vite/client, etc.)
// to this port by the requesting iframe's client URL, so no base rewrite needed.
function viteDevScript() {
  return (
    "const vite = require('vite');\n" +
    "(async () => {\n" +
    "  try {\n" +
    "    const server = await vite.createServer({\n" +
    "      root: '" + VITE_DIR + "', configFile: false, logLevel: 'silent',\n" +
    "      server: { port: " + VITE_PORT + ", host: '127.0.0.1' }, optimizeDeps: { noDiscovery: true },\n" +
    "    });\n" +
    "    await server.listen();\n" +
    "    console.log('[vite] dev server + HMR ready on :" + VITE_PORT + "');\n" +
    "    setInterval(() => {}, 1000);\n" +
    "  } catch (e) { console.error('[vite] ' + (e && e.stack || e)); process.exit(1); }\n" +
    "})();\n"
  );
}

let viteStarted = false;
async function startVite() {
  if (viteStarted) return;
  viteStarted = true;
  try {
    kernel.mkdirp(VITE_DIR + "/src");
    for (const [rel, contents] of Object.entries(VITE_APP)) {
      kernel.writeFile(VITE_DIR + "/" + rel, contents);
    }
    kernel.writeFile(VITE_DIR + "/dev.js", viteDevScript());
    post("log", { line: "$ cd " + VITE_DIR + " && npm install vite", cls: "muted" });
    post("vite-status", { line: "installing vite from npm…" });
    const inst = await kernel.start("npm", ["install", "vite"], { cwd: VITE_DIR, capture: true });
    if (inst.code !== 0) {
      post("log", { line: "  [vite] npm install failed: " + (inst.stderr || inst.code), cls: "err" });
      post("vite-status", { line: "npm install vite failed — see the log" });
      viteStarted = false;
      return;
    }
    post("log", { line: "$ node dev.js  (vite dev server, long-running)", cls: "muted" });
    kernel.start("node", ["dev.js"], { cwd: VITE_DIR }); // NOT awaited
    await waitListen(VITE_PORT);
    post("log", { line: "  [vite] dev server listening on :" + VITE_PORT, cls: "ok" });
    const files = {};
    for (const abs of VITE_EDIT_FILES) files[abs] = VITE_APP[abs.slice(VITE_DIR.length + 1)];
    post("vite-ready", { port: VITE_PORT, files });
  } catch (err) {
    post("log", { line: "  [vite] " + (err && err.message || err), cls: "err" });
    post("vite-status", { line: "failed to start vite — see the log" });
    viteStarted = false;
  }
}

let kernel = null;
const listening = new Set();
// The File System Worker handle, kept module-scoped so the page-hide flush relay
// (host -> here -> FS worker) can reach it. Set in boot().
let fsWorkerRef = null;

// Resolve once a process registers a listener on `port` (kernel.onListen fires).
function waitListen(port, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (listening.has(port)) return resolve();
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (listening.has(port)) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        reject(new Error("timed out waiting for a listener on port " + port));
      }
    }, 50);
  });
}

async function boot() {
  // The Rust/Wasm VFS now lives in its own nested File System Worker (#14). We
  // wait for it to boot, then talk to it: the kernel over its own sync SAB
  // channel (createKernelFs), and each process directly over a MessagePort
  // doorbell wired at spawn.
  // Kick off the one-time codec compile up front, concurrently with the VFS
  // boot; we only need the Modules before the first process is spawned below.
  const codecsReady = Promise.all([
    compileWasmModule(new URL("../codec/pkg/open_webcontainer_codec_bg.wasm", import.meta.url)),
    compileWasmModule(new URL("../crypto/pkg/open_webcontainer_crypto_bg.wasm", import.meta.url)),
  ]);

  const fsWorker = new Worker(new URL("./fs-worker.js", import.meta.url), {
    type: "module",
    name: "File System Worker",
  });
  fsWorkerRef = fsWorker;
  let onKernelFsMessage = () => {};
  const fsReady = new Promise((resolve) => {
    fsWorker.onmessage = (event) => {
      if (event.data.type === "ready") resolve();
      // The FS worker logs OPFS restore status; relay it to the host UI.
      else if (event.data.type === "log") post("log", event.data);
      else onKernelFsMessage(event.data);
    };
  });
  await fsReady;
  const kernelFs = createKernelFs(fsWorker);
  onKernelFsMessage = kernelFs.onMessage;
  post("log", { line: "Rust VFS booted (wasm) in the File System Worker.", cls: "ok" });

  // [optimize] The pre-compiled codec Modules every Process Worker instantiates
  // from (compiled once above; may be null if the build/fetch failed).
  const [codecModule, cryptoModule] = await codecsReady;

  // Spawn a process as a *nested* worker under this kernel worker. Each gets a
  // human-readable name (shown in DevTools' JS VM instance list) with its PID.
  // We also open a MessageChannel between the process and the File System Worker
  // so its fs syscalls ring that worker's doorbell directly (never the kernel).
  const spawnWorker = (info) => {
    const worker = new Worker(new URL("./process-worker.js", import.meta.url), {
      type: "module",
      name: "Process Worker PID " + info.pid,
    });
    worker.onmessage = (event) => {
      const handler = info.on[event.data.type];
      if (handler) handler(event.data);
    };
    const { port1, port2 } = new MessageChannel();
    fsWorker.postMessage({ type: "fs-register", client: info.pid, sab: info.sab, port: port2 }, [port2]);
    // #16 stage 2b: a spawned thread also receives its parentPort (a MessagePort
    // transferred from its creator through us) alongside its fs doorbell.
    // [optimize] Hand over the pre-compiled codec Modules (cloned, not
    // transferred — a Module stays usable here and in every process).
    const init = { type: "init", sab: info.sab, spec: info.spec, fsPort: port1, codecModule, cryptoModule };
    const transfer = [port1];
    if (info.threadPort) {
      init.threadPort = info.threadPort;
      transfer.push(info.threadPort);
    }
    worker.postMessage(init, transfer);
    return {
      terminate: () => {
        worker.terminate();
        fsWorker.postMessage({ type: "fs-unregister", client: info.pid });
      },
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
    fs: kernelFs.fs,
    spawnWorker,
    fetcher,
    stdout: (chunk) => post("stdout", { chunk }),
    stderr: (chunk) => post("stderr", { chunk }),
  });
  kernel.onProcExit = (pid, res) => post("exit", { pid, code: res.code });
  kernel.onListen = (port, pid) => {
    listening.add(port);
    post("listen", { port, pid });
  };
  kernel.onFetch = (url, info) =>
    post("log", {
      line: `  [fetcher] ${info.cached ? "cache hit " : "downloaded"} ${info.size}B · ${url}`,
      cls: "muted",
    });
  // roadmap #19 stage C: a ws frame a process relayed OUT of the VM (Vite's HMR
  // server) — forward it to the main thread, which delivers it to the preview
  // iframe's WebSocket polyfill.
  kernel.onWsSend = (msg) => post("oc-ws", { msg });

  kernel.installCoreutils();
  kernel.mkdirp("/srv");
  kernel.writeFile("/srv/server.js", SERVER_SRC);
  // #15: a short-lived child the /api/spawn route runs via child_process.spawn —
  // it prints across timers (so its output streams live) then exits with a code.
  kernel.writeFile(
    "/srv/spawn-child.js",
    "console.log('child pid ' + process.pid + ' starting');\n" +
      "let n = 0;\n" +
      "const iv = setInterval(() => {\n" +
      "  n++; console.log('tick ' + n);\n" +
      "  if (n === 3) { clearInterval(iv); console.log('child done'); process.exit(3); }\n" +
      "}, 30);\n",
  );
  // #16 stage 2b: the worker the /api/threads route runs via worker_threads. It
  // sums 1..N off the main thread, writes it into the shared SAB, and replies.
  kernel.writeFile(
    "/srv/thread-worker.js",
    "const { parentPort, workerData } = require('worker_threads');\n" +
      "parentPort.on('message', (m) => {\n" +
      "  if (m === 'go') {\n" +
      "    let sum = 0;\n" +
      "    for (let i = 1; i <= workerData.n; i++) sum += i;\n" +
      "    new Int32Array(workerData.sab)[0] = sum;\n" +
      "    parentPort.postMessage({ done: true, sum });\n" +
      "  }\n" +
      "});\n" +
      "parentPort.postMessage('ready');\n",
  );
  kernel.writeFile("/root.sh", SCRIPT);

  // Phase 2 #13: a tiny ESM graph the CJS server require()s at /api/esm. import/
  // export/import.meta/dynamic import are transpiled to our sync CJS at load time
  // (es-module-lexer). Proves real ESM syntax runs in the browser.
  kernel.mkdirp("/srv/esm-demo");
  kernel.writeFile(
    "/srv/esm-demo/math.mjs",
    "export const pi = 3.14159;\n" +
      "export function square(n){ return n * n; }\n" +
      "export default function cube(n){ return n * n * n; }\n",
  );
  kernel.writeFile("/srv/esm-demo/lazy.mjs", "export default 'esm-dynamic-import-works';\n");
  kernel.writeFile(
    "/srv/esm-demo/index.mjs",
    "import cube, { pi, square } from './math.mjs';\n" +
      "export { pi } from './math.mjs';\n" +
      "export const info = { pi, square4: square(2), cube2: cube(2) };\n" +
      "export const metaUrl = import.meta.url;\n" +
      "export async function loadLazy(){ const m = await import('./lazy.mjs'); return m.default; }\n",
  );

  // Phase 2 #16: seed the wasm32-wasip1 CLI so /api/wasi can run it via
  // require('wasi'). Fetched here (async) and materialized in the VFS.
  try {
    const wasiWasm = new Uint8Array(
      await (await fetch(new URL("../wasi-demo/pkg/wasi_demo.wasm", import.meta.url))).arrayBuffer(),
    );
    kernel.mkdirp("/wasi");
    kernel.writeFile("/wasi/wasi_demo.wasm", wasiWasm);
  } catch (err) {
    post("log", { line: "  [wasi] demo wasm unavailable: " + (err && err.message), cls: "muted" });
  }

  // Phase 2 #16 stage 2a: seed a REAL N-API native addon compiled to wasm32-wasi
  // (@node-rs/crc32-wasm32-wasi) so /api/napi can `require()` it. Its napi-rs
  // wrapper runs on our vendored @napi-rs/wasm-runtime (emnapi host) + our WASI.
  try {
    const base = new URL("./vendor/napi-crc32/", import.meta.url);
    const grab = async (f) => new Uint8Array(await (await fetch(new URL(f, base))).arrayBuffer());
    const dec = new TextDecoder();
    kernel.mkdirp("/srv/node_modules/@node-rs/crc32-wasm32-wasi");
    const d = "/srv/node_modules/@node-rs/crc32-wasm32-wasi/";
    kernel.writeFile(d + "package.json", dec.decode(await grab("package.json")));
    kernel.writeFile(d + "crc32.wasi.cjs", dec.decode(await grab("crc32.wasi.cjs")));
    kernel.writeFile(d + "crc32.wasm32-wasi.wasm", await grab("crc32.wasm32-wasi.wasm"));
  } catch (err) {
    post("log", { line: "  [napi] crc32 addon unavailable: " + (err && err.message), cls: "muted" });
  }

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
  kernel.writeFile(
    "/app/package.json",
    JSON.stringify({ name: "demo-app", version: "1.0.0", scripts: { start: "node index.js" } }, null, 2),
  );
  kernel.writeFile(
    "/app/index.js",
    "const isOdd = require('is-odd');\n" +
      "console.log('[npm demo] is-odd(3) =', isOdd(3), '| is-odd(4) =', isOdd(4));\n",
  );
  post("log", { line: "$ cd /app && npm install is-odd", cls: "muted" });
  await kernel.start("npm", ["install", "is-odd"], { cwd: "/app" });
  // Run it via `npm run start` (Phase 2 #10 stage 2): resolves the script from
  // package.json and runs it with node_modules/.bin on PATH.
  post("log", { line: "$ npm run start", cls: "muted" });
  await kernel.start("npm", ["run", "start"], { cwd: "/app" });

  // Phase 2 #16 stage 2c: real `npm install @node-rs/crc32` (the META package).
  // It lists 14 per-platform builds as optionalDependencies; npm auto-selects the
  // ONLY one that permits this wasm32 host (@node-rs/crc32-wasm32-wasi) and skips
  // the 13 native ones. The package's own generated loader then falls back to that
  // wasm binding — so `require('@node-rs/crc32')` just works, unmodified.
  try {
    kernel.mkdirp("/crc-app");
    kernel.writeFile(
      "/crc-app/package.json",
      JSON.stringify({ name: "crc-app", version: "1.0.0", scripts: { start: "node index.js" } }, null, 2),
    );
    kernel.writeFile(
      "/crc-app/index.js",
      "const { crc32 } = require('@node-rs/crc32');\n" +
        "console.log('[napi 2c] npm auto-picked wasm; crc32(\"OpenContainer\") =', crc32('OpenContainer'));\n",
    );
    post("log", { line: "$ cd /crc-app && npm install @node-rs/crc32  (auto-selects wasm32-wasi)", cls: "muted" });
    await kernel.start("npm", ["install", "@node-rs/crc32"], { cwd: "/crc-app" });
    post("log", { line: "$ npm run start", cls: "muted" });
    await kernel.start("npm", ["run", "start"], { cwd: "/crc-app" });
  } catch (err) {
    post("log", { line: "  [napi 2c] demo skipped: " + (err && err.message || err), cls: "muted" });
  }

  // Phase 2 #15: `npm run dev` launching a LONG-RUNNING server. Before async
  // spawn this froze forever (spawnSync buffered stdout and never returned);
  // now npm async-spawns the leaf node process, stays in the foreground streaming
  // its logs, and the server keeps serving. We start it non-blocking (like a real
  // terminal holding the dev server), wait for it to listen, then hit it once.
  kernel.mkdirp("/dev-app");
  kernel.writeFile(
    "/dev-app/package.json",
    JSON.stringify({ name: "dev-app", version: "1.0.0", scripts: { dev: "node dev-server.js" } }, null, 2),
  );
  kernel.writeFile(
    "/dev-app/dev-server.js",
    "const http = require('http');\n" +
      "http.createServer((req, res) => {\n" +
      "  res.writeHead(200, { 'content-type': 'application/json' });\n" +
      "  res.end(JSON.stringify({ from: 'dev-server via npm run dev', pid: process.pid, url: req.url }));\n" +
      "}).listen(3200, () => console.log('[dev-server] listening on :3200 (pid ' + process.pid + ')'));\n",
  );
  post("log", { line: "$ cd /dev-app && npm run dev  (long-running via async spawn)", cls: "muted" });
  kernel.start("npm", ["run", "dev"], { cwd: "/dev-app" }); // NOT awaited: it stays foreground
  try {
    await waitListen(3200);
    const devResp = await kernel.handleHttpRequest(3200, { method: "GET", url: "/hello", headers: {}, body: "" });
    const devText = typeof devResp.body === "string" ? devResp.body : new TextDecoder().decode(devResp.body);
    post("log", { line: "  [dev] GET :3200/hello -> " + devResp.status + " " + devText, cls: "ok" });
  } catch (err) {
    post("log", { line: "  [dev] " + (err && err.message), cls: "err" });
  }

  // A REAL Express server (Phase 2 #10 + partial #11 zlib / #12 crypto): install
  // express + its ~70-package dependency tree from the registry, boot it on
  // :3100, then call three routes through the kernel like a client would. This
  // proves express's router, params, and express.json() body parsing all run on
  // our vendored Node stack — the framework itself, unmodified, in the browser.
  // kernel.mkdirp("/express");
  // kernel.writeFile(
  //   "/express/package.json",
  //   JSON.stringify({ name: "express-demo", version: "1.0.0", scripts: { start: "node server.js" } }, null, 2),
  // );
  // kernel.writeFile("/express/server.js", EXPRESS_SERVER_SRC);
  // post("log", { line: "$ cd /express && npm install express", cls: "muted" });
  // await kernel.start("npm", ["install", "express"], { cwd: "/express" });
  // post("log", { line: "$ node server.js  (express, long-running)", cls: "muted" });
  // kernel.start("node", ["server.js"], { cwd: "/express" });
  // await waitListen(3100);

  // const callExpress = async (method, url, body) => {
  //   const resp = await kernel.handleHttpRequest(3100, {
  //     method,
  //     url,
  //     headers: body ? { "content-type": "application/json" } : {},
  //     body: body || "",
  //   });
  //   const text = typeof resp.body === "string" ? resp.body : new TextDecoder().decode(resp.body);
  //   post("log", { line: `  [express] ${method} ${url} -> ${resp.status} ${text}`, cls: "ok" });
  // };
  // await callExpress("GET", "/api/hello");
  // await callExpress("GET", "/api/users/42");
  // await callExpress("POST", "/api/echo", JSON.stringify({ hello: "world", n: 7 }));
}

self.onmessage = async (event) => {
  const m = event.data;

  if (m.type === "init") {
    boot().catch((err) => post("log", { line: "kernel worker boot failed: " + err, cls: "err" }));
    return;
  }

  // The page is hiding — relay a best-effort flush to the FS worker so the OPFS
  // mirror catches any writes still queued in the write-behind buffer.
  if (m.type === "fs-flush") {
    if (fsWorkerRef) fsWorkerRef.postMessage({ type: "fs-flush" });
    return;
  }

  // roadmap #19 stage C: a ws connection event from the preview iframe (relayed
  // by the main thread). Route it to the process owning the preview port.
  if (m.type === "oc-ws") {
    if (kernel) kernel.handleWsClient(m.msg);
    return;
  }

  // The user clicked "Start Vite dev + HMR" in the host UI.
  if (m.type === "start-vite") {
    if (kernel) startVite();
    return;
  }

  // The user saved an edit in the host editor — write it to the VFS. The in-VM
  // Vite dev server's watcher (our push-based fs.watch) fires and pushes an HMR
  // update over the tunnel to the preview iframe.
  if (m.type === "oc-write") {
    if (kernel) {
      try {
        kernel.writeFile(m.path, m.contents);
      } catch (err) {
        post("log", { line: "  [edit] write failed: " + (err && err.message || err), cls: "err" });
      }
    }
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
