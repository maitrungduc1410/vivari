// The kernel worker — OpenContainer's kernel host, off the main thread.
//
// Phase 2, item #1 (Kernel worker). Everything heavy lives here: the Rust/Wasm
// VFS, the Kernel (process table + syscall servicing + virtual network), and the
// process workers it spawns. The main thread (host.js) is left free for UI +
// orchestration only.
//
// The demo is a StackBlitz-style IDE: pick a project (React+Vite+Compiler or
// NestJS), which is scaffolded from a REAL project structure, `npm install`ed,
// and run with its REAL dev script (`npm run dev` / `npm run start:dev`). All
// process output (the Vite banner, Nest's colored logs, npm install) streams to
// the editor's terminal verbatim; editing a file in Monaco writes it to the VFS,
// where the real in-VM file watcher drives HMR (Vite) or a recompile+restart
// (Nest --watch) exactly like local development.

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

// ─────────────────────────────────────────────────────────────────────────────
// Demo 1 — React + Vite + the React Compiler.
//
// The exact file layout `npm create vite@latest` emits for the React template,
// plus the React Compiler wired into @vitejs/plugin-react's Babel pass. Run with
// the real `npm run dev` (the vite CLI). One in-VM caveat: rolldown's config
// BUNDLER throws "Invalid URL", so we load vite.config.js via `--configLoader
// native` (passed after `--`); the project files themselves are 100% authentic.
// ─────────────────────────────────────────────────────────────────────────────
const REACT_DIR = "/react-app";
const REACT_PORT = 5173;
const REACT_FILES = {
  "package.json": `{
  "name": "vite-react",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^5.0.0",
    "babel-plugin-react-compiler": "latest",
    "vite": "^8.0.0"
  }
}
`,
  "vite.config.js": `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react({
      babel: {
        // The React Compiler — auto-memoizes components at build time.
        plugins: [['babel-plugin-react-compiler', {}]],
      },
    }),
  ],
})
`,
  "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + React</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
  "src/main.jsx": `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`,
  "src/App.jsx": `import { useState } from 'react'
import './App.css'

function App() {
  const [count, setCount] = useState(0)

  return (
    <>
      <h1>Vite + React + Compiler</h1>
      <div className="card">
        <button onClick={() => setCount((count) => count + 1)}>
          count is {count}
        </button>
        <p>
          Edit <code>src/App.jsx</code> and save to test HMR
        </p>
      </div>
      <p className="read-the-docs">
        Running inside OpenContainer — a real Vite dev server in your browser.
      </p>
    </>
  )
}

export default App
`,
  "src/App.css": `#root {
  max-width: 1280px;
  margin: 0 auto;
  padding: 2rem;
  text-align: center;
}

.card {
  padding: 2em;
}

.read-the-docs {
  color: #888;
}
`,
  "src/index.css": `:root {
  font-family: system-ui, Avenir, Helvetica, Arial, sans-serif;
  line-height: 1.5;
  font-weight: 400;
  color-scheme: light dark;
  color: rgba(255, 255, 255, 0.87);
  background-color: #242424;
}

body {
  margin: 0;
  display: flex;
  place-items: center;
  min-width: 320px;
  min-height: 100vh;
}

h1 {
  font-size: 3.2em;
  line-height: 1.1;
}

button {
  border-radius: 8px;
  border: 1px solid transparent;
  padding: 0.6em 1.2em;
  font-size: 1em;
  font-weight: 500;
  font-family: inherit;
  background-color: #1a1a1a;
  color: white;
  cursor: pointer;
  transition: border-color 0.25s;
}

button:hover {
  border-color: #646cff;
}
`,
};
const REACT_ENTRY = "src/App.jsx";

// ─────────────────────────────────────────────────────────────────────────────
// Demo 2 — NestJS.
//
// The file layout `nest new` emits (trimmed to the deps needed to boot — no
// jest/eslint/prettier). Run with the real `npm run start:dev` = `nest start
// --watch`: the @nestjs/cli compiles the TS with `tsc` in watch mode and forks
// the emitted app; on save it recompiles and restarts, all in-VM. `emitDecorator
// Metadata` is what makes DI + reflect-metadata work.
// ─────────────────────────────────────────────────────────────────────────────
const NEST_DIR = "/nest-app";
const NEST_PORT = 3000;
const NEST_FILES = {
  "package.json": `{
  "name": "nest-app",
  "version": "0.0.1",
  "description": "",
  "private": true,
  "license": "UNLICENSED",
  "scripts": {
    "build": "nest build",
    "start": "nest start",
    "start:dev": "nest start --watch",
    "start:prod": "node dist/main"
  },
  "dependencies": {
    "@nestjs/common": "^11.0.1",
    "@nestjs/core": "^11.0.1",
    "@nestjs/platform-express": "^11.0.1",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1"
  },
  "devDependencies": {
    "@nestjs/cli": "^11.0.0",
    "@nestjs/schematics": "^11.0.0",
    "@types/node": "^22.10.7",
    "source-map-support": "^0.5.21",
    "typescript": "^5.7.3"
  }
}
`,
  "nest-cli.json": `{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true
  }
}
`,
  "tsconfig.json": `{
  "compilerOptions": {
    "module": "commonjs",
    "declaration": true,
    "removeComments": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "allowSyntheticDefaultImports": true,
    "target": "ES2023",
    "sourceMap": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "incremental": true,
    "skipLibCheck": true,
    "strictNullChecks": true,
    "forceConsistentCasingInFileNames": true,
    "noImplicitAny": false,
    "strictBindCallApply": false,
    "noFallthroughCasesInSwitch": false
  }
}
`,
  "tsconfig.build.json": `{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "test", "dist", "**/*spec.ts"]
}
`,
  "src/main.ts": `import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
`,
  "src/app.module.ts": `import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
`,
  "src/app.controller.ts": `import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
`,
  "src/app.service.ts": `import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World!';
  }
}
`,
};
const NEST_ENTRY = "src/app.service.ts";

// The selectable demo matrix. Each entry scaffolds its real project files, runs
// `npm install` (from package.json), then launches its real dev script and waits
// for the port to listen. `hmr` = live module replacement (Vite); `reload` = the
// server restarts on change (Nest --watch) and we refresh the preview when it
// re-listens. `files`/`entry` drive the host's file tree + Monaco editor.
const DEMOS = {
  react: {
    title: "React + Vite + React Compiler",
    dir: REACT_DIR,
    port: REACT_PORT,
    files: REACT_FILES,
    entry: REACT_ENTRY,
    runCmd: "npm",
    // Real `npm run dev`; --configLoader native avoids rolldown's in-VM config
    // bundler ("Invalid URL"). npm drops the first `--` before forwarding.
    runArgs: ["run", "dev", "--", "--configLoader", "native"],
    hmr: true,
  },
  nest: {
    title: "NestJS",
    dir: NEST_DIR,
    port: NEST_PORT,
    files: NEST_FILES,
    entry: NEST_ENTRY,
    runCmd: "npm",
    runArgs: ["run", "start:dev"], // nest start --watch (recompile + restart)
    hmr: false,
    reload: true,
  },
};

const demoStarted = new Set();
const demoReadyPorts = new Set(); // ports that reached "ready" once — a later
// listen on the same port is a dev-server restart (Nest --watch), not a boot.

async function startDemo(id) {
  const d = DEMOS[id];
  if (!d) {
    post("demo-status", { line: "unknown demo: " + id });
    return;
  }
  // Already running: just re-point the preview + editor at it.
  if (demoStarted.has(id)) {
    post("demo-ready", {
      id, dir: d.dir, port: d.port, files: d.files, entry: d.entry, title: d.title, hmr: !!d.hmr, reload: !!d.reload,
    });
    return;
  }
  demoStarted.add(id);
  try {
    for (const [rel, contents] of Object.entries(d.files)) {
      const abs = d.dir + "/" + rel;
      kernel.mkdirp(abs.slice(0, abs.lastIndexOf("/")));
      kernel.writeFile(abs, contents);
    }
    post("demo-status", { line: "npm install — resolving " + d.title + " from the registry…" });
    // Stream install output to the terminal (no capture); resolves with the code.
    const inst = await kernel.start("npm", ["install"], { cwd: d.dir, env: { FORCE_COLOR: "3" } });
    if (inst.code !== 0) {
      post("demo-status", { line: "npm install failed — see the terminal" });
      demoStarted.delete(id);
      return;
    }
    post("demo-status", { line: "starting the dev server…" });
    // FORCE_COLOR=3 makes Vite/Nest/tsc emit truecolor ANSI so the terminal looks
    // exactly like a local run. Long-running: launch() returns immediately.
    kernel.launch(d.runCmd, d.runArgs, { cwd: d.dir, env: { FORCE_COLOR: "3" } });
    await waitListen(d.port, 120000);
    // Wait for the server to actually answer — not just bind — before pointing
    // the preview at it (see waitServing: Vite rebinds during startup).
    await waitServing(d.port, 60000);
    // Prime the dev server so the cold dependency-optimize happens now, off the
    // Service Worker's request clock (see warmDevServer). Vite only.
    if (d.hmr) {
      post("demo-status", { line: "optimizing dependencies — first run only…" });
      await warmDevServer(d.port);
    }
    demoReadyPorts.add(d.port);
    post("demo-ready", {
      id, dir: d.dir, port: d.port, files: d.files, entry: d.entry, title: d.title, hmr: !!d.hmr, reload: !!d.reload,
    });
  } catch (err) {
    post("log", { line: "[" + id + "] " + ((err && err.message) || err) + "\n", stream: "stderr" });
    post("demo-status", { line: "failed to start — see the terminal" });
    demoStarted.delete(id);
  }
}

// Which demo listens on this port (for restart → preview-reload detection)?
function demoForPort(port) {
  for (const [id, d] of Object.entries(DEMOS)) if (d.port === port) return id;
  return null;
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

// A bound port isn't the same as a *serving* one: Vite 8 (rolldown) binds :port
// a few times during startup (bind → close → rebind), so the first `listen`
// event is transient. If we announced `demo-ready` then, the host's preview
// iframe can hit the port while it's momentarily closed → 502. So after the port
// listens we drive real HTTP GET /'s through the kernel until one comes back with
// a non-5xx-gateway status — i.e. an in-VM server actually answered — and only
// then is the preview safe to load.
async function waitServing(port, timeoutMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const resp = await kernel.handleHttpRequest(port, { method: "GET", url: "/", headers: {}, body: "" });
      if (resp && resp.status !== 502 && resp.status !== 503) return true;
    } catch {
      /* not answering yet */
    }
    if (Date.now() - t0 > timeoutMs) return false; // give up; host will still try
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Cold-start warm-up. On the first load Vite **holds every module request** until
// its dependency optimizer (rolldown) finishes — the browser shows a blank page
// with "optimizing dependencies". If we announced the preview ready right away,
// the iframe's subresource fetches would race that cold optimize against the
// Service Worker's 60 s timeout → a wall of `504 (Gateway Timeout)` on `/@vite/
// client`, `/src/*`, and `/node_modules/.vite/deps/*` (only reproducible on a
// cold `.vite` cache — which is exactly why `?reset` triggers it). So we prime
// the server HERE, inside the kernel worker (no SW deadline): fetch the HTML, then
// request its module entry, which forces the optimize to complete and `.vite/deps`
// to be written. By the time the preview loads everything is warm and instant.
async function warmDevServer(port, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  const get = (url) =>
    kernel.handleHttpRequest(port, { method: "GET", url, headers: { accept: "*/*" }, body: "" });
  let html;
  try {
    const r = await get("/");
    html = typeof r.body === "string" ? r.body : new TextDecoder().decode(r.body || new Uint8Array());
  } catch {
    return; // couldn't fetch the entry; let the browser try anyway
  }
  // The module entry scripts (+ Vite's own client) are what pull in — and
  // therefore optimize — the dependency graph. Requesting the entry blocks until
  // the optimizer is done, which is the whole point.
  const mods = new Set(["/@vite/client"]);
  const re = /<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/gi;
  for (let m; (m = re.exec(html)); ) if (m[1].startsWith("/")) mods.add(m[1]);
  for (const url of mods) {
    if (Date.now() > deadline) break;
    try {
      await get(url);
    } catch {
      /* best effort — a single failed warm request shouldn't block readiness */
    }
  }
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
  post("log", { line: "Rust VFS booted (wasm) in the File System Worker." });

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
    const restart = demoReadyPorts.has(port); // seen before => a dev-server restart
    listening.add(port);
    post("listen", { port, pid });
    if (restart) {
      const id = demoForPort(port);
      // Nest --watch recompiled + restarted the app; refresh the preview iframe.
      if (id) post("demo-reload", { id, port, title: DEMOS[id].title });
    }
  };
  kernel.onFetch = (url, info) =>
    post("log", {
      line: `  [fetcher] ${info.cached ? "cache hit " : "downloaded"} ${info.size}B · ${url}`,
      dim: true,
    });
  // roadmap #19 stage C: a ws frame a process relayed OUT of the VM (Vite's HMR
  // server) — forward it to the main thread, which delivers it to the preview
  // iframe's WebSocket polyfill.
  kernel.onWsSend = (msg) => post("oc-ws", { msg });

  kernel.installCoreutils();
  post("ready", {});
  post("log", { line: "Kernel ready — pick a project and press Run." });
}

self.onmessage = async (event) => {
  const m = event.data;

  if (m.type === "init") {
    boot().catch((err) => post("log", { line: "kernel worker boot failed: " + err, stream: "stderr" }));
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

  // The user picked a demo and clicked "Run" in the host UI.
  if (m.type === "start-demo") {
    if (kernel) startDemo(m.demo);
    return;
  }

  // The user saved an edit in the host editor — write it to the VFS. The in-VM
  // dev server's watcher does the rest: Vite pushes an HMR update over the tunnel
  // to the preview iframe; Nest --watch recompiles + restarts (its re-listen then
  // triggers a preview reload via kernel.onListen above). No orchestration here.
  if (m.type === "oc-write") {
    if (kernel) {
      try {
        kernel.writeFile(m.path, m.contents);
      } catch (err) {
        post("log", { line: "[edit] write failed: " + ((err && err.message) || err), stream: "stderr" });
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
    // Diagnostic: a 502/503 on a preview request means the kernel has no live
    // server on that port — usually the dev server process exited after listening.
    // Surface it in the terminal with the current port registry so it's not silent.
    if (resp && (resp.status === 502 || resp.status === 503)) {
      post("log", {
        line:
          `[preview] ${m.req.method || "GET"} :${m.req.port}${m.req.url || ""} → ${resp.status} ` +
          `(live ports: ${[...kernel.listeners.keys()].join(", ") || "none"})`,
        stream: "stderr",
      });
    }
    port.postMessage(resp);
    return;
  }
};
