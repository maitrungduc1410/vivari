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
import { ensureRealNpm } from "../kernel-host/load-real-npm.js";
import { ensureRealYarn } from "../kernel-host/load-real-yarn.js";
import { ensureRealPnpm } from "../kernel-host/load-real-pnpm.js";
import { ensureRealCorepack } from "../kernel-host/load-real-corepack.js";
import { ensureRealTsgo, applyTsgoLoadingShims } from "../kernel-host/load-real-tsgo.js";

const post = (type, extra) => self.postMessage({ type, ...extra });

// The real-npm delivery asset (built by `npm run vendor:npm`, served from
// packages/studio/public/vendor). Fetched once and unpacked into the VFS so the
// shell's `npm` is the real CLI, not the Turbo-analog (North Star). Absolute
// path so it resolves against the app origin from inside this worker. The file
// is gzip-compressed but NOT named `.gz` on purpose — see scripts/vendor-npm.mjs
// (a `.gz` name makes static servers set Content-Encoding: gzip, which the
// browser auto-decompresses, breaking our own gunzip).
const REAL_NPM_ASSET = "/vendor/npm-pack.bin";
// The real-yarn (classic) delivery asset, same shape/rationale as npm's (built by
// `npm run vendor:yarn`). Unpacked into the VFS so `yarn` on PATH is the real CLI.
const REAL_YARN_ASSET = "/vendor/yarn-pack.bin";
// The real-pnpm delivery asset, same shape/rationale as npm/yarn's (built by
// `npm run vendor:pnpm`). Unpacked into the VFS so `pnpm` on PATH is the real CLI.
const REAL_PNPM_ASSET = "/vendor/pnpm-pack.bin";
// The real-corepack delivery asset (built by `npm run vendor:corepack`). Unpacked
// into the VFS so `corepack` on PATH can DOWNLOAD + run project-pinned yarn/pnpm/
// npm versions (`packageManager` field), on top of the direct vendored defaults.
const REAL_COREPACK_ASSET = "/vendor/corepack-pack.bin";
// The real-TypeScript-7 (tsgo, Go/wasm) delivery asset (built by `npm run
// vendor:tsgo`). ~11 MB gz, so it's loaded LAZILY in the background after boot;
// unpacked into the VFS so `tsc`/`tsgo` on PATH are the real Go compiler.
const REAL_TSGO_ASSET = "/vendor/tsgo-pack.bin";

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

// Per-demo state. `scaffolded` = starter files written once (never re-written, so
// browser edits survive a re-run). `demoServing` = a demo's dev server on its port
// has answered and the preview is pointed at it — a later listen on that port is
// then a restart (Nest --watch) → reload, not a fresh boot. `demoReadyPending`
// guards the single async readiness probe per port. `termDemo` maps a demo's shell
// terminal back to its demo so closing that tab resets the demo's state.
const scaffolded = new Set();
const demoServing = new Set();
const demoReadyPending = new Set();
const termDemo = new Map(); // terminalId -> demo id

// Dynamically created / opened projects (Home → New / Template, or Open Folder).
// Unlike the two hard-coded DEMOS these have user-chosen dirs and are attributed
// to a listened port by the pid chain of the run-shell that spawned the server
// (see kernel.onListen), so their ports don't need to be known in advance.
const projects = new Map(); // dir -> { id, dir, port, entry, title, hmr, reload, install, dev, serving, pending }
const projectDirByTerm = new Map(); // terminalId -> project dir (a "Run" shell)

// Register (or refresh) a project's run manifest so a listen on its dev-server
// port can be attributed back to it.
function registerProject(dir, manifest, title) {
  const prev = projects.get(dir);
  projects.set(dir, {
    ...(prev || {}),
    ...manifest,
    dir,
    title: title || manifest.name || dir,
    serving: prev ? prev.serving : false,
    pending: prev ? prev.pending : false,
    port: manifest.port,
  });
}

// Drive the preview once a created project's dev server actually answers — the
// generic sibling of announceDemoReady (which is bound to the fixed DEMOS ports).
async function announceProjectReady(dir, port) {
  const p = projects.get(dir);
  if (!p) return;
  try {
    const ok = await waitServing(port, 60000);
    if (!ok) return;
    if (p.hmr) {
      post("demo-status", { line: "optimizing dependencies — first run only…" });
      await warmDevServer(port);
    }
    p.serving = true;
    post("project-ready", { dir, port, entry: p.entry, title: p.title, hmr: !!p.hmr, reload: !!p.reload });
  } finally {
    p.pending = false;
  }
}

// A project's run started ANOTHER server (a second/third port from the same run
// shell — e.g. a backend alongside the frontend) — surface it as an EXTRA preview
// tab once it answers, without re-opening the folder/entry (the primary did that).
async function announceProjectExtra(dir, port) {
  const p = projects.get(dir);
  if (!p) return;
  const ok = await waitServing(port, 60000);
  if (!ok) return;
  post("project-ready", { dir, port, title: p.title, hmr: !!p.hmr, reload: !!p.reload, extra: true });
}

// Write a demo's starter files into the VFS — once. Re-running or opening another
// shell must NOT clobber edits the user made after the first scaffold.
function scaffoldDemo(id) {
  if (scaffolded.has(id)) return;
  const d = DEMOS[id];
  for (const [rel, contents] of Object.entries(d.files)) {
    const abs = d.dir + "/" + rel;
    kernel.mkdirp(abs.slice(0, abs.lastIndexOf("/")));
    kernel.writeFile(abs, contents);
  }
  scaffolded.add(id);
}

// The command a demo's shell auto-runs (OC_RUN) — exactly what you'd type locally.
// Install only if node_modules isn't there yet, so a re-run with deps present goes
// straight to the dev server (and EADDRINUSEs naturally if one is already bound —
// we deliberately don't paper over that).
function demoRunCommand(d) {
  const run = d.runArgs && d.runArgs.length ? `${d.runCmd} ${d.runArgs.join(" ")}` : d.runCmd;
  return kernel.exists(d.dir + "/node_modules") ? run : `npm install && ${run}`;
}

// Drive the preview once a demo's server actually answers: wait until it serves
// (Vite rebinds during boot), prime the cold dep-optimize off the SW clock (Vite
// only), then point the preview + open the project. At most once per port until
// the demo's shell is closed (which clears demoServing so a re-run starts fresh).
async function announceDemoReady(id, port) {
  const d = DEMOS[id];
  try {
    const ok = await waitServing(port, 60000);
    if (!ok) return; // never answered; a later listen event can retry
    if (d.hmr) {
      post("demo-status", { line: "optimizing dependencies — first run only…" });
      await warmDevServer(port);
    }
    demoServing.add(port);
    post("demo-ready", {
      id, dir: d.dir, port, files: d.files, entry: d.entry, title: d.title, hmr: !!d.hmr, reload: !!d.reload,
    });
  } finally {
    demoReadyPending.delete(port);
  }
}

// Which demo listens on this port (for restart → preview-reload detection)?
function demoForPort(port) {
  for (const [id, d] of Object.entries(DEMOS)) if (d.port === port) return id;
  return null;
}

let kernel = null;
const listening = new Set();
// Interactive terminals: each xterm in the UI is backed by a long-lived `sh`
// process. Map both ways so a shell's output goes to the right terminal and the
// terminal's keystrokes go back to its pid. Demo/build output (npm, dev servers)
// is NOT in these maps and streams to the host's console instead.
const termByPid = new Map(); // shell pid -> terminalId
const pidByTerm = new Map(); // terminalId -> shell pid

// Walk a pid up its parent chain to the interactive shell that owns it, so a
// fetch made by a shell's CHILD (npm/yarn/pnpm/corepack) can be attributed to
// that shell's terminal. Returns the terminalId, or undefined for non-terminal
// processes (demo dev servers, builds) — those keep the plain console log.
function terminalForPid(pid) {
  let p = pid;
  const seen = new Set();
  while (p != null && !seen.has(p)) {
    const tid = termByPid.get(p);
    if (tid !== undefined) return tid;
    seen.add(p);
    const proc = kernel && kernel.procs ? kernel.procs.get(p) : null;
    p = proc ? proc.parentPid : null;
  }
  return undefined;
}

// Live download progress per terminal. Package managers make hundreds of fetches
// with little stdout in between, so an install looks frozen without feedback. We
// coalesce fetch events into ONE in-place (\r) spinner line per terminal,
// throttled, and clear it the instant the shell prints real output (below).
const SPINNER = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
const fetchProg = new Map(); // terminalId -> { count, bytes, last, frame, active }
function clearProgress(tid) {
  const s = fetchProg.get(tid);
  if (s && s.active) {
    s.active = false;
    post("term-out", { terminalId: tid, chunk: "\r\x1b[2K" });
  }
}

// Open a new interactive shell for a terminal tab. A plain shell opens in a
// running demo's dir (or "/"). A DEMO shell (`demoId` set — the "Run" button)
// scaffolds the project, opens in its dir, and auto-runs the dev command via
// OC_RUN, so the dev server lives *inside this tab* (closing it kills the server,
// running it twice EADDRINUSEs — exactly like local dev). PATH includes the
// project's node_modules/.bin so `vite`, `nest`, etc. resolve like a real shell.
function openTerminal(terminalId, cwd, demoId, run) {
  if (!kernel) return;
  const d = demoId ? DEMOS[demoId] : null;
  if (d) scaffoldDemo(demoId);
  const dir = (d ? d.dir : cwd) || defaultTermCwd();
  const env = {
    PATH: dir + "/node_modules/.bin:/bin",
    HOME: "/",
    // Real npm needs a writable cache (+ _logs) dir; created at boot. Without
    // this it defaults to $HOME/.npm and can trip on the read-only-ish root.
    npm_config_cache: "/tmp/.npm",
    // npm's audit + funding steps POST to registry endpoints that don't send
    // Access-Control-Allow-Origin, so from the browser they fail CORS preflight
    // (noisy console errors + a wasted round-trip) with no benefit here. Turn
    // both off by default; a user can still run `npm audit` explicitly.
    npm_config_audit: "false",
    npm_config_fund: "false",
    // Update checks are pointless in the VM (you can't `npm i -g` a new global),
    // and the `update-notifier` package (used by many CLIs, incl. Docusaurus)
    // spawns a *detached* background child to run the check — which fails ENOENT
    // in-VM and, since callers attach no 'error' listener, surfaces as an ugly
    // (harmless) uncaught error in the terminal. Disable both npm's own notice and
    // the update-notifier package outright.
    npm_config_update_notifier: "false",
    NO_UPDATE_NOTIFIER: "1",
    // Real yarn likewise needs a writable cache; created at boot (its global
    // config/cache default under $HOME would land on the read-only-ish root).
    YARN_CACHE_FOLDER: "/tmp/.yarn-cache",
    // Real pnpm: our VFS has no hardlink/reflink CoW, so packages must be COPIED
    // into node_modules from the store (npm_config_* is how pnpm reads config from
    // env). Give it a writable store + state/cache dirs off the root, too.
    npm_config_package_import_method: "copy",
    npm_config_store_dir: "/tmp/.pnpm-store",
    XDG_DATA_HOME: "/home/user/.local/share",
    XDG_CACHE_HOME: "/home/user/.cache",
    XDG_STATE_HOME: "/home/user/.local/state",
    XDG_CONFIG_HOME: "/home/user/.config",
    // Real corepack: it caches the PM versions it downloads here (created at boot).
    COREPACK_HOME: "/tmp/.corepack",
    // corepack verifies the registry's ECDSA signature, which our crypto layer
    // can't do (no crypto.verify). "0" is corepack's official escape hatch — it
    // skips that signature check; the sha512 tarball integrity check still runs.
    COREPACK_INTEGRITY_KEYS: "0",
    // A user typing bare `corepack yarn …` can't answer an interactive prompt.
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    TERM: "xterm-256color",
    FORCE_COLOR: "3",
    PWD: dir,
  };
  if (d) env.OC_RUN = demoRunCommand(d);
  // A created/opened project's "Run" (or auto-run after create) hands us an
  // explicit command; install is skipped automatically once node_modules exists.
  else if (run) {
    const p = projects.get(dir);
    const install = p && p.install ? p.install : "npm install";
    const devCmd = run;
    env.OC_RUN = kernel.exists(dir + "/node_modules") ? devCmd : `${install} && ${devCmd}`;
    projectDirByTerm.set(terminalId, dir);
  }
  const pid = kernel.launch("sh", [], { cwd: dir, env });
  if (pid < 0) {
    post("term-exit", { terminalId, code: 127 });
    return;
  }
  termByPid.set(pid, terminalId);
  pidByTerm.set(terminalId, pid);
  if (d) termDemo.set(terminalId, demoId);
  post("term-ready", { terminalId, pid, cwd: dir });
}

// Where a fresh (non-demo) terminal starts: inside a scaffolded demo project if
// there is one, else the root.
function defaultTermCwd() {
  for (const id of scaffolded) if (DEMOS[id]) return DEMOS[id].dir;
  return "/";
}
// The File System Worker handle, kept module-scoped so the page-hide flush relay
// (host -> here -> FS worker) can reach it. Set in boot().
let fsWorkerRef = null;

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
  const t0 = Date.now();
  post("log", { line: "Booting OpenContainer…", dim: true });

  // Kick off the one-time codec compile up front; it runs concurrently with the
  // workers below (we only need the Modules before the first process is spawned).
  const codecsReady = Promise.all([
    compileWasmModule(new URL("../codec/pkg/open_webcontainer_codec_bg.wasm", import.meta.url)),
    compileWasmModule(new URL("../crypto/pkg/open_webcontainer_crypto_bg.wasm", import.meta.url)),
  ]);

  // Two independent nested workers, kicked off IN PARALLEL so their scripts load +
  // boot concurrently instead of one-after-another: the File System Worker (Rust/
  // Wasm VFS + OPFS restore — the kernel waits on this) and the Fetcher Worker
  // (outbound npm; depends on neither the VFS nor the codecs, so there's no reason
  // to create it later — overlapping its load shaves a step off cold boot).
  post("log", { line: "  [boot] starting file-system + fetcher workers…", dim: true });
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

  // Fetcher Worker (Phase 2 #9): all outbound network goes through it, so
  // downloading/decompressing large npm payloads never stalls syscall servicing.
  // Created here (in parallel with the VFS); the kernel calls `fetcher(url)`.
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
    else
      p.resolve({
        ok: m.ok,
        status: m.status,
        statusText: m.statusText,
        headers: m.headers,
        body: new Uint8Array(m.body),
      });
  };
  // `init` (from the http/https client shim: {method, headers, body}) lets a real
  // ClientRequest egress; a bare fetcher(url) still does a GET.
  const fetcher = (url, init) =>
    new Promise((resolve, reject) => {
      const id = fetchSeq++;
      fetchPending.set(id, { resolve, reject });
      const msg = { type: "fetch", id, url, init: init || null };
      // Transfer the request body's buffer when present (avoids a copy).
      const transfer = init && init.body && init.body.buffer ? [init.body.buffer] : [];
      fetcherWorker.postMessage(msg, transfer);
    });

  await fsReady;
  const kernelFs = createKernelFs(fsWorker);
  onKernelFsMessage = kernelFs.onMessage;
  post("log", { line: `  [boot] file system ready (+${Date.now() - t0}ms).`, dim: true });

  // [optimize] The pre-compiled codec Modules every Process Worker instantiates
  // from (compiled once above; may be null if the build/fetch failed).
  const [codecModule, cryptoModule] = await codecsReady;
  post("log", { line: `  [boot] codecs compiled (+${Date.now() - t0}ms).`, dim: true });

  // Spawn a process as a *nested* worker under this kernel worker. Each gets a
  // human-readable name (shown in DevTools' JS VM instance list) with its PID —
  // a Worker's name is fixed at creation, so naming it here (not from a pre-warmed
  // pool) is what keeps the DevTools list legible: every worker maps to its PID.
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

  kernel = new Kernel({
    fs: kernelFs.fs,
    spawnWorker,
    fetcher,
    // Route by pid: an interactive shell's output goes to its terminal; anything
    // else (npm install, dev servers) is demo/console output.
    stdout: (chunk, pid) => {
      const tid = termByPid.get(pid);
      if (tid !== undefined) {
        clearProgress(tid); // wipe any live fetch spinner before real output lands
        post("term-out", { terminalId: tid, chunk });
      } else post("stdout", { chunk });
    },
    stderr: (chunk, pid) => {
      const tid = termByPid.get(pid);
      if (tid !== undefined) {
        clearProgress(tid);
        post("term-out", { terminalId: tid, chunk });
      } else post("stderr", { chunk });
    },
  });
  kernel.onProcExit = (pid, res) => {
    const tid = termByPid.get(pid);
    if (tid !== undefined) {
      termByPid.delete(pid);
      pidByTerm.delete(tid);
      fetchProg.delete(tid);
      // If this was a demo's shell (its dev server was a child), the server just
      // died with it: forget the demo's port state so the preview 502s and a later
      // Run starts fresh (rather than being treated as a restart → reload).
      const demoId = termDemo.get(tid);
      if (demoId) {
        termDemo.delete(tid);
        const port = DEMOS[demoId].port;
        demoServing.delete(port);
        demoReadyPending.delete(port);
        listening.delete(port);
      }
      // A created/opened project's "Run" shell died → its dev server went with
      // it. Reset the project's readiness so a re-run starts fresh (and the
      // preview 502s rather than being treated as a live restart → reload).
      const pdir = projectDirByTerm.get(tid);
      if (pdir) {
        projectDirByTerm.delete(tid);
        const p = projects.get(pdir);
        if (p) {
          p.serving = false;
          p.pending = false;
          // Drop every port this project surfaced so a re-run re-announces them
          // (and each server's tab reopens) instead of being treated as restarts.
          if (p.ports) {
            for (const pt of p.ports) listening.delete(pt);
            p.ports.clear();
          }
          if (p.port != null) listening.delete(p.port);
        }
      }
      post("term-exit", { terminalId: tid, code: res.code });
    } else {
      post("exit", { pid, code: res.code });
    }
  };
  kernel.onListen = (port, pid) => {
    listening.add(port);
    post("listen", { port, pid });
    // Created/opened project attribution FIRST (by pid chain), so a project's
    // dev server is matched to *its* run-shell regardless of the port it picked
    // (and never confused with a hard-coded DEMO that shares e.g. 5173/3000).
    const tid = terminalForPid(pid);
    const pdir = tid !== undefined ? projectDirByTerm.get(tid) : undefined;
    if (pdir && projects.has(pdir)) {
      const p = projects.get(pdir);
      if (!p.ports) p.ports = new Set();
      if (p.ports.has(port)) {
        // A re-listen on a port we already surfaced → the server restarted →
        // reload the preview tab(s) bound to it.
        post("project-reload", { dir: pdir, port, title: p.title });
      } else {
        p.ports.add(port);
        p.port = port;
        if (!p.serving && !p.pending) {
          // First server of this project → primary preview (opens folder + entry).
          p.pending = true;
          announceProjectReady(pdir, port);
        } else {
          // A second/third server started by the SAME run (e.g. a backend API or
          // ws server alongside the frontend) → open an ADDITIONAL preview tab.
          announceProjectExtra(pdir, port);
        }
      }
      return;
    }
    const id = demoForPort(port);
    if (!id) return; // a non-demo server (a user-launched app); nothing to wire
    if (demoServing.has(port)) {
      // Already serving on this port and it (re-)listened → a dev-server restart
      // (Nest --watch recompiled + relaunched the app). Refresh the preview iframe.
      post("demo-reload", { id, port, title: DEMOS[id].title });
    } else if (!demoReadyPending.has(port)) {
      // First real listen for this demo → probe until it serves, then point the
      // preview. (Vite emits several transient listens during boot; the pending
      // guard keeps this to a single probe.)
      demoReadyPending.add(port);
      announceDemoReady(id, port);
    }
  };
  kernel.onFetch = (url, info) => {
    const tid = terminalForPid(info.pid);
    if (tid === undefined) {
      // Non-terminal fetch (a demo/build) — keep the plain console log.
      post("log", {
        line: `  [fetcher] ${info.cached ? "cache hit " : "downloaded"} ${info.size}B · ${url}`,
        dim: true,
      });
      return;
    }
    const s = fetchProg.get(tid) || { count: 0, bytes: 0, last: 0, frame: 0, active: false };
    s.count++;
    s.bytes += info.size || 0;
    const now = Date.now();
    if (now - s.last >= 80) {
      s.last = now;
      s.frame = (s.frame + 1) % SPINNER.length;
      s.active = true;
      const mb = (s.bytes / 1048576).toFixed(1);
      post("term-out", {
        terminalId: tid,
        chunk: `\r\x1b[2K\x1b[2m${SPINNER[s.frame]} fetching \u00b7 ${s.count} requests \u00b7 ${mb} MB\x1b[0m`,
      });
    }
    fetchProg.set(tid, s);
  };
  // roadmap #19 stage C: a ws frame a process relayed OUT of the VM (Vite's HMR
  // server) — forward it to the main thread, which delivers it to the preview
  // iframe's WebSocket polyfill.
  kernel.onWsSend = (msg) => post("oc-ws", { msg });

  kernel.installCoreutils();

  // North Star: the shell's `npm`/`npx` IS the REAL npm CLI. The Turbo-analog is
  // retired (no longer in COREUTILS), so this is the only npm — the tree persists
  // in OPFS, so after the first boot ensureRealNpm only re-applies the cheap
  // shims; a fresh origin fetches + unpacks the ~12 MB asset once (one batched
  // VFS transfer). A missing asset simply means no `npm` on PATH, like yarn/pnpm.
  kernel.mkdirp("/home/user");
  kernel.mkdirp("/tmp/.npm/_logs");
  kernel.mkdirp("/tmp/.yarn-cache");
  kernel.mkdirp("/tmp/.pnpm-store");
  kernel.mkdirp("/tmp/.corepack");

  // The kernel + VFS can now service filesystem RPCs (oc-stat / oc-readdir /
  // oc-create-project), so the studio can create/open projects immediately —
  // WITHOUT waiting for the (multi-second) real npm/yarn/pnpm/corepack loads
  // below, which only matter once you actually run install/dev.
  post("kernel-online", {});

  // `tsc`/`tsgo` exist immediately as a "still downloading" placeholder; the real
  // TypeScript 7 (tsgo, ~11 MB) is loaded lazily in the background after `ready`
  // (loadTsgoInBackground), then these shims are overwritten with the real runner.
  // (When the tree is OPFS-restored the background load re-applies the real shims
  // almost instantly, so the placeholder window is negligible.)
  applyTsgoLoadingShims(kernel);
  try {
    const npmT0 = Date.now();
    const res = await ensureRealNpm(kernel, async () => {
      const base = (self.location && self.location.origin) || "";
      const r = await fetch(base + REAL_NPM_ASSET);
      if (!r.ok) return null;
      return new Uint8Array(await r.arrayBuffer());
    });
    if (res && res.restored) {
      post("log", { line: `  [boot] real npm ready (restored from OPFS, +${Date.now() - npmT0}ms).`, dim: true });
    } else if (res) {
      post("log", {
        line: `  [boot] real npm ${res.version} loaded (${res.fileCount} files, +${Date.now() - npmT0}ms).`,
        dim: true,
      });
    } else {
      post("log", { line: "  [boot] real npm asset unavailable — `npm` not installed.", dim: true });
    }
  } catch (e) {
    post("log", { line: `  [boot] real npm load failed (${(e && e.message) || e}) — 'npm' not installed.`, dim: true });
  }

  // Same delivery/shim path for real yarn (classic). No fallback CLI exists, so a
  // missing asset just means `yarn` isn't on PATH (npm still is).
  try {
    const yarnT0 = Date.now();
    const res = await ensureRealYarn(kernel, async () => {
      const base = (self.location && self.location.origin) || "";
      const r = await fetch(base + REAL_YARN_ASSET);
      if (!r.ok) return null;
      return new Uint8Array(await r.arrayBuffer());
    });
    if (res && res.restored) {
      post("log", { line: `  [boot] real yarn ready (restored from OPFS, +${Date.now() - yarnT0}ms).`, dim: true });
    } else if (res) {
      post("log", {
        line: `  [boot] real yarn ${res.version} loaded (${res.fileCount} files, +${Date.now() - yarnT0}ms).`,
        dim: true,
      });
    } else {
      post("log", { line: "  [boot] real yarn asset unavailable — `yarn` not installed.", dim: true });
    }
  } catch (e) {
    post("log", { line: `  [boot] real yarn load failed (${(e && e.message) || e}).`, dim: true });
  }

  // Same delivery/shim path for real pnpm. pnpm drives worker_threads and a
  // symlinked node_modules (both supported); the shell forces copy import method.
  try {
    const pnpmT0 = Date.now();
    const res = await ensureRealPnpm(kernel, async () => {
      const base = (self.location && self.location.origin) || "";
      const r = await fetch(base + REAL_PNPM_ASSET);
      if (!r.ok) return null;
      return new Uint8Array(await r.arrayBuffer());
    });
    if (res && res.restored) {
      post("log", { line: `  [boot] real pnpm ready (restored from OPFS, +${Date.now() - pnpmT0}ms).`, dim: true });
    } else if (res) {
      post("log", {
        line: `  [boot] real pnpm ${res.version} loaded (${res.fileCount} files, +${Date.now() - pnpmT0}ms).`,
        dim: true,
      });
    } else {
      post("log", { line: "  [boot] real pnpm asset unavailable — `pnpm` not installed.", dim: true });
    }
  } catch (e) {
    post("log", { line: `  [boot] real pnpm load failed (${(e && e.message) || e}).`, dim: true });
  }

  // Same delivery/shim path for real corepack (Node's PM version manager). It only
  // adds `/bin/corepack.js`; the direct npm/yarn/pnpm shims above stay the
  // defaults. `corepack yarn|pnpm|npm …` (or a project `packageManager` field)
  // downloads + runs the pinned version. A missing asset just means no `corepack`.
  try {
    const cpT0 = Date.now();
    const res = await ensureRealCorepack(kernel, async () => {
      const base = (self.location && self.location.origin) || "";
      const r = await fetch(base + REAL_COREPACK_ASSET);
      if (!r.ok) return null;
      return new Uint8Array(await r.arrayBuffer());
    });
    if (res && res.restored) {
      post("log", { line: `  [boot] real corepack ready (restored from OPFS, +${Date.now() - cpT0}ms).`, dim: true });
    } else if (res) {
      post("log", {
        line: `  [boot] real corepack ${res.version} loaded (${res.fileCount} files, +${Date.now() - cpT0}ms).`,
        dim: true,
      });
    } else {
      post("log", { line: "  [boot] real corepack asset unavailable — `corepack` not installed.", dim: true });
    }
  } catch (e) {
    post("log", { line: `  [boot] real corepack load failed (${(e && e.message) || e}).`, dim: true });
  }

  post("ready", {});
  post("log", { line: `  [boot] kernel ready in ${Date.now() - t0}ms.`, dim: true });
  post("log", { line: "Kernel ready — pick a project and press Run." });

  // Real TypeScript 7 (tsgo, Go/wasm) is ~11 MB, and nothing at boot needs it, so
  // load it AFTER ready without blocking — `tsc`/`tsgo` flip from the "still
  // downloading" placeholder to the real compiler when this settles. Persists in
  // OPFS, so only the first origin visit pays the download.
  void loadTsgoInBackground();
}

// Lazy, non-blocking loader for the real TypeScript 7 compiler (see above).
async function loadTsgoInBackground() {
  try {
    const t0 = Date.now();
    const res = await ensureRealTsgo(kernel, async () => {
      const base = (self.location && self.location.origin) || "";
      const r = await fetch(base + REAL_TSGO_ASSET);
      if (!r.ok) return null;
      return new Uint8Array(await r.arrayBuffer());
    });
    if (res && res.restored) {
      post("log", { line: `  [tsgo] TypeScript 7 ready (restored from OPFS, +${Date.now() - t0}ms).`, dim: true });
    } else if (res) {
      post("log", {
        line: `  [tsgo] TypeScript 7 (tsgo ${res.version}) loaded (${res.fileCount} files, +${Date.now() - t0}ms) — 'tsc'/'tsgo' ready.`,
        dim: true,
      });
    } else {
      post("log", { line: "  [tsgo] TypeScript 7 asset unavailable — `tsc`/`tsgo` not installed.", dim: true });
    }
  } catch (e) {
    post("log", { line: `  [tsgo] TypeScript 7 load failed (${(e && e.message) || e}) — 'tsc'/'tsgo' not installed.`, dim: true });
  }
}

// ── File-operation helpers (host Explorer: delete / copy / cut-paste) ────────
const errMsg = (err) => (err && err.message) || String(err);

// Recursively remove a path (file, or directory + contents).
function rmRecursive(path) {
  let st;
  try {
    st = kernel.stat(path);
  } catch {
    return; // already gone
  }
  if (st.kind === "dir") {
    for (const name of kernel.readdir(path)) rmRecursive(path + "/" + name);
    kernel.rmdir(path);
  } else {
    kernel.unlink(path);
  }
}

// Recursively copy `from` → `to` (bytes for files, mkdir + walk for dirs).
function copyRecursive(from, to) {
  const st = kernel.stat(from);
  if (st.kind === "dir") {
    kernel.mkdirp(to);
    for (const name of kernel.readdir(from)) copyRecursive(from + "/" + name, to + "/" + name);
  } else {
    kernel.writeFile(to, kernel.readFileBytes(from));
  }
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

  // ── Interactive terminals ──────────────────────────────────────────────────
  // Open a new shell for a terminal tab. `demo` set = the "Run" button: scaffold
  // the project and auto-run its dev command in this shell (OC_RUN), so the server
  // lives in this tab.
  if (m.type === "term-open") {
    openTerminal(m.terminalId, m.cwd, m.demo, m.run);
    return;
  }
  // Keystrokes from an xterm — feed them to that terminal's shell stdin.
  if (m.type === "term-input") {
    const pid = pidByTerm.get(m.terminalId);
    if (pid != null && kernel) kernel.sendStdin(pid, m.chunk);
    return;
  }
  // The user closed a terminal tab — kill its shell (and any foreground child).
  if (m.type === "term-close") {
    const pid = pidByTerm.get(m.terminalId);
    if (pid != null && kernel) kernel.stop(pid);
    return;
  }

  // The user saved an edit in the host editor — write it to the VFS. The in-VM
  // dev server's watcher does the rest: Vite pushes an HMR update over the tunnel
  // to the preview iframe; Nest --watch recompiles + restarts (its re-listen then
  // triggers a preview reload via kernel.onListen above). No orchestration here.
  if (m.type === "oc-write") {
    if (kernel) {
      try {
        const slash = m.path.lastIndexOf("/");
        if (slash > 0) kernel.mkdirp(m.path.slice(0, slash));
        kernel.writeFile(m.path, m.contents ?? "");
        post("oc-fs-changed", { path: m.path });
      } catch (err) {
        post("log", { line: "[edit] write failed: " + ((err && err.message) || err), stream: "stderr" });
      }
    }
    if (m.reqId != null) post("oc-reply", { reqId: m.reqId, ok: true });
    return;
  }

  // ── VFS queries for the multi-root Explorer (request/response via oc-reply) ──
  if (m.type === "oc-readdir") {
    if (!kernel) { post("oc-reply", { reqId: m.reqId, ok: false, error: "kernel not ready" }); return; }
    try {
      const base = m.path.replace(/\/+$/, "");
      const names = kernel.readdir(m.path);
      const entries = names.map((name) => {
        let dir = false;
        try { dir = kernel.stat(base + "/" + name).kind === "dir"; } catch { /* race: gone */ }
        return { name, dir };
      });
      post("oc-reply", { reqId: m.reqId, ok: true, path: m.path, entries });
    } catch (err) {
      post("oc-reply", { reqId: m.reqId, ok: false, error: errMsg(err) });
    }
    return;
  }
  if (m.type === "oc-read") {
    if (!kernel) { post("oc-reply", { reqId: m.reqId, ok: false, error: "kernel not ready" }); return; }
    try {
      post("oc-reply", { reqId: m.reqId, ok: true, path: m.path, contents: kernel.readFile(m.path) });
    } catch (err) {
      post("oc-reply", { reqId: m.reqId, ok: false, error: errMsg(err) });
    }
    return;
  }
  // Existence + kind check used to validate a new project's target directory.
  if (m.type === "oc-stat") {
    if (!kernel) { post("oc-reply", { reqId: m.reqId, ok: true, exists: false, isDir: false }); return; }
    try {
      if (!kernel.exists(m.path)) { post("oc-reply", { reqId: m.reqId, ok: true, exists: false, isDir: false }); return; }
      const st = kernel.stat(m.path);
      post("oc-reply", { reqId: m.reqId, ok: true, exists: true, isDir: st.kind === "dir" });
    } catch {
      post("oc-reply", { reqId: m.reqId, ok: true, exists: false, isDir: false });
    }
    return;
  }
  if (m.type === "oc-mkdirp") {
    if (!kernel) { post("oc-reply", { reqId: m.reqId, ok: false, error: "kernel not ready" }); return; }
    try {
      kernel.mkdirp(m.path);
      post("oc-reply", { reqId: m.reqId, ok: true });
      post("oc-fs-changed", { path: m.path });
    } catch (err) {
      post("oc-reply", { reqId: m.reqId, ok: false, error: errMsg(err) });
    }
    return;
  }

  // Create a project: write its files in one batch and register its run manifest
  // so a later listen on its dev-server port points the preview at it.
  if (m.type === "oc-create-project") {
    if (!kernel) { post("oc-reply", { reqId: m.reqId, ok: false, error: "kernel not ready" }); return; }
    try {
      const dir = m.dir;
      kernel.mkdirp(dir);
      const files = m.files || {};
      const batch = Object.entries(files).map(([rel, contents]) => ({ path: dir + "/" + rel, contents }));
      if (batch.length) await kernel.writeFilesBatch(batch);
      if (m.manifest) registerProject(dir, m.manifest, m.title);
      post("oc-reply", { reqId: m.reqId, ok: true });
      post("oc-fs-changed", { path: dir });
    } catch (err) {
      post("oc-reply", { reqId: m.reqId, ok: false, error: errMsg(err) });
    }
    return;
  }
  // Re-attach a run manifest to an already-existing project dir (Open Folder /
  // "Run" on a reopened project), without rewriting its files.
  if (m.type === "oc-register-project") {
    if (kernel && m.manifest) registerProject(m.dir, m.manifest, m.title);
    if (m.reqId != null) post("oc-reply", { reqId: m.reqId, ok: true });
    return;
  }

  // Explorer file operations. The VFS ops go through the FS Worker which calls
  // notifyWatch, so a running dev server picks the changes up (HMR / restart) on
  // its own. Each replies with `oc-fs-result` so the host can surface errors.
  if (m.type === "oc-rename" || m.type === "oc-rm" || m.type === "oc-copy") {
    const op = m.type.slice(3); // rename | rm | copy
    if (!kernel) {
      post("oc-fs-result", { op, ok: false, error: "kernel not ready", ...m });
      return;
    }
    try {
      if (m.type === "oc-rename") kernel.rename(m.from, m.to);
      else if (m.type === "oc-rm") rmRecursive(m.path);
      else copyRecursive(m.from, m.to);
      post("oc-fs-result", { op, ok: true, from: m.from, to: m.to, path: m.path });
      post("oc-fs-changed", { path: m.to || m.path });
    } catch (err) {
      post("oc-fs-result", { op, ok: false, error: errMsg(err), from: m.from, to: m.to, path: m.path });
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
