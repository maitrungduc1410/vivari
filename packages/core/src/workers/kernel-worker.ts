// @ts-nocheck — authored in TS for Vite's native worker bundling, but not strictly
// type-checked: this bridges to a large body of untyped JS (packages/kernel-host,
// packages/runtime) + generated wasm, and uses non-standard worker globals. esbuild
// (via Vite) is the compiler; strict typing is a separate, larger effort.
// The kernel worker — Vivari's kernel host, off the main thread.
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

import { Kernel } from "../../../kernel-host/kernel.js";
import { createKernelFs } from "../../../kernel-host/kernel-fs.js";
import { ensureRealNpm } from "../../../kernel-host/load-real-npm.js";
import { ensureRealYarn } from "../../../kernel-host/load-real-yarn.js";
import { ensureRealPnpm } from "../../../kernel-host/load-real-pnpm.js";
import { ensureRealCorepack } from "../../../kernel-host/load-real-corepack.js";
import { ensureRealTsgo } from "../../../kernel-host/load-real-tsgo.js";

const post = (type, extra) => self.postMessage({ type, ...extra });

// Diagnostic: this worker's own memory, via the cross-origin-isolation-gated
// performance.measureUserAgentSpecificMemory(). Best-effort — returns null if the
// API is absent or the call is rejected (it can throw if measurement is rate-
// limited). Used by the studio's memory readout (vv-mem, below).
async function safeMeasureMemory() {
  try {
    if (typeof performance !== "undefined" && performance.measureUserAgentSpecificMemory) {
      const r = await performance.measureUserAgentSpecificMemory();
      return r && typeof r.bytes === "number" ? r.bytes : null;
    }
  } catch {
    /* not allowed / rate-limited */
  }
  return null;
}

// Diagnostic mem-query correlation for the File System Worker (a plain async
// message, off the sync SAB path). The kernel asks the FS worker for the VFS's
// in-RAM content footprint; the reply is matched back here by id.
let memReqSeq = 1;
const memPending = new Map();

// Live Process Workers by PID, for the per-PID "Measure Memory" breakdown. Each
// worker answers a `proc-mem` query with its own JS heap + module-cache stats;
// replies are matched back by id here. Populated/pruned in spawnWorker.
const procWorkers = new Map();
let procMemSeq = 1;
const procMemPending = new Map();

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
        Running inside Vivari — a real Vite dev server in your browser.
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

// The command a demo's shell auto-runs (VV_RUN) — exactly what you'd type locally.
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

// The registered project a directory belongs to: the deepest project dir that is
// `cwd` itself or an ancestor of it (so a server started in a nested subfolder
// still maps to its project).
function projectDirForCwd(cwd) {
  if (!cwd) return undefined;
  let best;
  for (const dir of projects.keys()) {
    if (cwd === dir || cwd.startsWith(dir + "/")) {
      if (best === undefined || dir.length > best.length) best = dir;
    }
  }
  return best;
}

// Attribute a listening pid to a registered project by the LAUNCH CWD of the
// server process (or any ancestor up to its shell). This is what ties a manually
// started server — e.g. `npm start` typed in a plain terminal, which has no
// VV_RUN / projectDirByTerm wiring — back to its project, instead of letting it
// fall through to a legacy DEMO that merely happens to share the same port (e.g.
// Express and the NestJS demo both default to :3000).
function projectDirForPid(pid) {
  let p = pid;
  const seen = new Set();
  while (p != null && !seen.has(p)) {
    const proc = kernel && kernel.procs ? kernel.procs.get(p) : null;
    const dir = proc ? projectDirForCwd(proc.cwd) : undefined;
    if (dir) return dir;
    seen.add(p);
    p = proc ? proc.parentPid : null;
  }
  return undefined;
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
// VV_RUN, so the dev server lives *inside this tab* (closing it kills the server,
// running it twice EADDRINUSEs — exactly like local dev). PATH includes the
// project's node_modules/.bin so `vite`, `nest`, etc. resolve like a real shell.
// The environment a fresh process/shell starts with. Package managers need
// writable, PERSISTED caches (see the per-key notes) and a PATH that includes the
// project's node_modules/.bin so `vite`, `nest`, `tsc`, etc. resolve like a real
// shell. Shared by interactive terminals (openTerminal) and the generic SDK
// `spawn` path (proc-spawn) so `vivari.spawn('npm', ['install'])` behaves exactly
// like typing it in a studio terminal.
function baseProcEnv(dir) {
  return {
    PATH: dir + "/node_modules/.bin:/bin",
    HOME: "/",
    // Real npm needs a writable cache (+ _logs) dir; created at boot. Without
    // this it defaults to $HOME/.npm and can trip on the read-only-ish root.
    //
    // PERSISTED content-addressed cache: this lives under /home/user/.cache
    // (NOT /tmp, which the OPFS mirror excludes), so npm's own integrity-keyed
    // _cacache survives reloads AND is shared across projects — install a package
    // once and every later project/boot reuses the tarball with no re-download.
    // This is the durable "package cache in OPFS"; the kernel's transient
    // /var/cache/vv-fetch buffer is intentionally NOT persisted (see fs-worker).
    npm_config_cache: "/home/user/.cache/npm",
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
    // Real yarn likewise needs a writable cache; persisted (see npm_config_cache)
    // so yarn's tarball cache is reused across projects/reloads.
    YARN_CACHE_FOLDER: "/home/user/.cache/yarn",
    // Real pnpm: use its default HARD-LINK import method so node_modules entries
    // share the store's inode instead of duplicating every package's bytes in the
    // VFS's Wasm RAM (the store + a full copy per project was the biggest single
    // memory sink). The VFS now supports link(2) (see OP_LINK); on a wasm build
    // that predates it, the runtime's fs.link transparently falls back to a copy,
    // so this is safe either way. The content-addressed store is persisted so it
    // is shared across projects/reloads too. (npm_config_* is how pnpm reads
    // config from env.)
    npm_config_package_import_method: "hardlink",
    npm_config_store_dir: "/home/user/.local/share/pnpm/store",
    XDG_DATA_HOME: "/home/user/.local/share",
    XDG_CACHE_HOME: "/home/user/.cache",
    XDG_STATE_HOME: "/home/user/.local/state",
    XDG_CONFIG_HOME: "/home/user/.config",
    // Real corepack: it caches the PM versions it downloads here (created at boot);
    // persisted so a downloaded yarn/pnpm binary is reused across reloads.
    COREPACK_HOME: "/home/user/.cache/corepack",
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
}

// ── Generic process spawn (SDK `vivari.spawn`) ──────────────────────────────
// A clean, framework-agnostic counterpart to the interactive terminal path: run
// ONE command directly (no wrapping shell), streaming its stdout/stderr and exit
// code back over a per-process `execId`. stdin + kill are relayed the same way.
// Output/exit routing keys off execByPid in the kernel's stdout/stderr/onProcExit
// hooks (below), so this coexists with the terminal (termByPid) routing.
const execByPid = new Map(); // pid -> execId
const pidByExec = new Map(); // execId -> pid

async function spawnProcess(execId, command, args, cwd, extraEnv) {
  if (!kernel) {
    post("proc-exit", { execId, code: 127, error: "kernel not ready" });
    return;
  }
  const dir = cwd || defaultTermCwd();
  const env = baseProcEnv(dir);
  if (extraEnv && typeof extraEnv === "object") Object.assign(env, extraEnv);
  // On-demand: materialize a lazily-registered heavy tool (tsc/tsgo/yarn/pnpm/
  // corepack) before launching, so `vivari.spawn('tsc', …)` works on first use.
  // `launch` goes straight to resolveProgram (unlike the shell's OP_SPAWN path,
  // which the kernel gates itself), so the gate has to run here.
  await kernel.ensureCommandLoaded(command);
  if (!kernel) return;
  const pid = kernel.launch(command, Array.isArray(args) ? args : [], { cwd: dir, env });
  if (pid < 0) {
    post("proc-exit", { execId, code: 127, error: command + ": not found" });
    return;
  }
  execByPid.set(pid, execId);
  pidByExec.set(execId, pid);
  post("proc-started", { execId, pid });
}

function openTerminal(terminalId, cwd, demoId, run) {
  if (!kernel) return;
  const d = demoId ? DEMOS[demoId] : null;
  if (d) scaffoldDemo(demoId);
  const dir = (d ? d.dir : cwd) || defaultTermCwd();
  const env = baseProcEnv(dir);
  if (d) env.VV_RUN = demoRunCommand(d);
  // A created/opened project's "Run" (or auto-run after create) hands us an
  // explicit command; install is skipped automatically once node_modules exists.
  else if (run) {
    const p = projects.get(dir);
    const install = p && p.install ? p.install : "npm install";
    const devCmd = run;
    env.VV_RUN = kernel.exists(dir + "/node_modules") ? devCmd : `${install} && ${devCmd}`;
    // Merge any template-declared environment (memory/telemetry levers the
    // framework honors — e.g. NUXT_TELEMETRY_DISABLED). Applied last so a
    // template can override a default if it must.
    if (p && p.env && typeof p.env === "object") Object.assign(env, p.env);
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
// Whole-file lazy compression gate for the VFS, sourced from the page at boot
// (init.compress) and relayed to the File System Worker. On by default; the page
// sets it false only for ?compress=0.
let vfsCompression = true;

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

// Ask the File System Worker for the VFS's in-RAM content size (bytes + file
// count). Resolves { bytes, files } (or a -1 sentinel if the wasm build predates
// the mem_bytes diagnostic), or null if the FS worker isn't up yet.
function queryVfsMem(timeoutMs = 2000) {
  if (!fsWorkerRef) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = memReqSeq++;
    const done = (data) =>
      resolve(data ? { bytes: data.bytes, files: data.files, logical: data.logical } : null);
    memPending.set(id, done);
    setTimeout(() => {
      if (memPending.delete(id)) resolve(null);
    }, timeoutMs);
    fsWorkerRef.postMessage({ type: "fs-mem", id });
  });
}

// Ask every live Process Worker for its own JS heap + retention stats, in
// parallel. Resolves an array of { pid, heap, modules, esbuildInproc, name }
// (a worker that doesn't answer within the timeout is simply omitted). This is
// what turns the flat "1.87 GB on process-worker.js" figure into a per-PID
// breakdown so we can see which process holds the dev-server heap.
function queryAllProcMem(timeoutMs = 2000) {
  const workers = [...procWorkers.entries()];
  if (workers.length === 0) return Promise.resolve([]);
  return Promise.all(
    workers.map(
      ([pid, w]) =>
        new Promise((resolve) => {
          const id = procMemSeq++;
          procMemPending.set(id, (data) =>
            resolve({
              pid,
              name: w.name || `PID ${pid}`,
              heap: data.heap,
              modules: data.modules,
              esbuildInproc: !!data.esbuildInproc,
              esbuildBytes: Number(data.esbuildBytes) || 0,
            }),
          );
          setTimeout(() => {
            if (procMemPending.delete(id)) resolve(null);
          }, timeoutMs);
          try {
            w.worker.postMessage({ type: "proc-mem", id });
          } catch {
            if (procMemPending.delete(id)) resolve(null);
          }
        }),
    ),
  ).then((rows) => rows.filter(Boolean).sort((a, b) => (b.heap || 0) - (a.heap || 0)));
}

async function boot() {
  // The Rust/Wasm VFS now lives in its own nested File System Worker (#14). We
  // wait for it to boot, then talk to it: the kernel over its own sync SAB
  // channel (createKernelFs), and each process directly over a MessagePort
  // doorbell wired at spawn.
  const t0 = Date.now();
  post("log", { line: "Booting Vivari…", dim: true });

  // Kick off the one-time codec compile up front; it runs concurrently with the
  // workers below (we only need the Modules before the first process is spawned).
  const codecsReady = Promise.all([
    compileWasmModule(new URL("../../../codec/pkg/vivari_codec_bg.wasm", import.meta.url)),
    compileWasmModule(new URL("../../../crypto/pkg/vivari_crypto_bg.wasm", import.meta.url)),
  ]);

  // Two independent nested workers, kicked off IN PARALLEL so their scripts load +
  // boot concurrently instead of one-after-another: the File System Worker (Rust/
  // Wasm VFS + OPFS restore — the kernel waits on this) and the Fetcher Worker
  // (outbound npm; depends on neither the VFS nor the codecs, so there's no reason
  // to create it later — overlapping its load shaves a step off cold boot).
  post("log", { line: "  [boot] starting file-system + fetcher workers…", dim: true });
  const fsWorker = new Worker(new URL("./fs-worker.ts", import.meta.url), {
    type: "module",
    name: "File System Worker",
  });
  fsWorkerRef = fsWorker;
  // Relay the compression gate now, before the FS worker's OPFS restore runs, so
  // it's in force as early as possible (the FS worker queues it until the VFS is
  // constructed). No-op on wasm builds that predate set_compression.
  fsWorker.postMessage({ type: "fs-set-compression", on: vfsCompression });
  let onKernelFsMessage = () => {};
  const fsReady = new Promise((resolve) => {
    fsWorker.onmessage = (event) => {
      if (event.data.type === "ready") resolve();
      // The FS worker logs OPFS restore status; relay it to the host UI.
      else if (event.data.type === "log") post("log", event.data);
      // Diagnostic VFS-memory reply (off the sync SAB path) — resolve its waiter.
      else if (event.data.type === "fs-mem") {
        const p = memPending.get(event.data.id);
        if (p) {
          memPending.delete(event.data.id);
          p(event.data);
        }
      } else onKernelFsMessage(event.data);
    };
  });

  // Fetcher Worker (Phase 2 #9): all outbound network goes through it, so
  // downloading/decompressing large npm payloads never stalls syscall servicing.
  // Created here (in parallel with the VFS); the kernel calls `fetcher(url)`.
  const fetcherWorker = new Worker(new URL("./fetcher-worker.ts", import.meta.url), {
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
    const worker = new Worker(new URL("./process-worker.ts", import.meta.url), {
      type: "module",
      name: "Process Worker PID " + info.pid,
    });
    worker.onmessage = (event) => {
      // Diagnostic reply path (per-PID Measure Memory) — resolve its waiter
      // instead of routing through the kernel's per-process handler table.
      if (event.data && event.data.type === "proc-mem-reply") {
        const p = procMemPending.get(event.data.id);
        if (p) {
          procMemPending.delete(event.data.id);
          p(event.data);
        }
        return;
      }
      const handler = info.on[event.data.type];
      if (handler) handler(event.data);
    };
    procWorkers.set(info.pid, { worker, name: "PID " + info.pid });
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
        procWorkers.delete(info.pid);
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
      const eid = execByPid.get(pid);
      if (eid !== undefined) { post("proc-out", { execId: eid, stream: "stdout", chunk }); return; }
      const tid = termByPid.get(pid);
      if (tid !== undefined) {
        clearProgress(tid); // wipe any live fetch spinner before real output lands
        post("term-out", { terminalId: tid, chunk });
      } else post("stdout", { chunk });
    },
    stderr: (chunk, pid) => {
      const eid = execByPid.get(pid);
      if (eid !== undefined) { post("proc-out", { execId: eid, stream: "stderr", chunk }); return; }
      const tid = termByPid.get(pid);
      if (tid !== undefined) {
        clearProgress(tid);
        post("term-out", { terminalId: tid, chunk });
      } else post("stderr", { chunk });
    },
  });
  kernel.onProcExit = (pid, res) => {
    const eid = execByPid.get(pid);
    if (eid !== undefined) {
      execByPid.delete(pid);
      pidByExec.delete(eid);
      post("proc-exit", { execId: eid, code: res.code });
      return;
    }
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
    // Prefer the explicit run-shell mapping; otherwise attribute by the server's
    // launch cwd so a *manually* started server (`npm start` with no VV_RUN) is
    // still tied to its project rather than a same-port legacy DEMO.
    const pdir = (tid !== undefined ? projectDirByTerm.get(tid) : undefined) ?? projectDirForPid(pid);
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
        } else if (p.multiPreview) {
          // A template that INTENTIONALLY runs multiple user-facing servers (e.g.
          // a backend API alongside the frontend) → open an ADDITIONAL preview
          // tab per extra server. Opt-in only (manifest.multiPreview).
          announceProjectExtra(pdir, port);
        }
        // Otherwise this is an INTERNAL port of a single dev server — Vite's HMR
        // WebSocket (:24678, answers "Upgrade Required" to a browser), a
        // framework's SSR/render worker (Nuxt/Nitro's ephemeral port, reached via
        // the main server's proxy), etc. It's not a browsable app on its own, so
        // we do NOT open a preview tab for it. It's still tracked in p.ports above
        // so a server restart reloads the real tab and project cleanup releases it.
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
  kernel.onWsSend = (msg) => post("vv-ws", { msg });
  // An SSE stream chunk a process relayed OUT of the VM — forward it to the main
  // thread, which delivers it to the preview iframe's EventSource polyfill.
  kernel.onSseSend = (msg) => post("vv-sse", { msg });

  kernel.installCoreutils();

  // North Star: the shell's `npm`/`npx` IS the REAL npm CLI. The Turbo-analog is
  // retired (no longer in COREUTILS), so this is the only npm — the tree persists
  // in OPFS, so after the first boot ensureRealNpm only re-applies the cheap
  // shims; a fresh origin fetches + unpacks the ~12 MB asset once (one batched
  // VFS transfer). A missing asset simply means no `npm` on PATH, like yarn/pnpm.
  kernel.mkdirp("/home/user");
  // os.tmpdir() is "/tmp", so it MUST exist: tools call mkdtempSync(join(tmpdir(),
  // "x-")) at startup (e.g. Nuxt/vite-node's generateSocketPath), which mkdir's a
  // random child of /tmp and throws ENOENT if /tmp is missing. It used to be
  // created implicitly by the /tmp/.npm cache dirs — those moved to
  // /home/user/.cache, so create /tmp explicitly now.
  kernel.mkdirp("/tmp");
  // Package-manager caches live under /home/user/.cache (persisted in OPFS), so
  // downloaded tarballs/binaries are reused across projects and page reloads.
  kernel.mkdirp("/home/user/.cache/npm/_logs");
  kernel.mkdirp("/home/user/.cache/yarn");
  kernel.mkdirp("/home/user/.local/share/pnpm/store");
  kernel.mkdirp("/home/user/.cache/corepack");

  // The kernel + VFS can now service filesystem RPCs (vv-stat / vv-readdir /
  // vv-create-project), so the studio can create/open projects immediately —
  // WITHOUT waiting for the (multi-second) real npm/yarn/pnpm/corepack loads
  // below, which only matter once you actually run install/dev.
  post("kernel-online", {});

  // Register the heavy, rarely-universal toolchains as ON-DEMAND programs (see
  // below, after the eager npm load): tsc/tsgo, yarn, pnpm, corepack are only
  // fetched + unpacked the first time their command is actually spawned, instead
  // of paying for them on every boot. npm stays eager (below) — nearly every
  // session installs, and `npx` shells out to it.
  registerLazyTools();
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

  post("ready", {});
  post("log", { line: `  [boot] kernel ready in ${Date.now() - t0}ms.`, dim: true });
  post("log", { line: "Kernel ready — pick a project and press Run." });
}

// Fetch a vendor asset (npm/yarn/pnpm/corepack/tsgo pack) by absolute path from
// the app origin. Returns its bytes, or null if the asset isn't served (in which
// case the tool simply isn't installed — same as a missing npm).
async function fetchVendorAsset(assetPath: string): Promise<Uint8Array | null> {
  const base = (self.location && self.location.origin) || "";
  const r = await fetch(base + assetPath);
  if (!r.ok) return null;
  return new Uint8Array(await r.arrayBuffer());
}

// Register the heavy toolchains as ON-DEMAND programs: the first time one of the
// listed commands is spawned, the kernel awaits the matching loader, which
// fetches + unpacks the vendor asset into the VFS and writes the real /bin shims.
// Nothing is paid at boot; a returning visitor's OPFS-restored tree makes the
// first use near-instant (the loader just re-applies the shims). tsc + tsgo share
// one asset (so loading via either satisfies both), as do pnpm + pnpx.
function registerLazyTools() {
  const lazyTool = (
    names: string[],
    label: string,
    ensure: (k: typeof kernel, fetchBytes: () => Promise<Uint8Array | null>) => Promise<unknown>,
    asset: string,
  ) => {
    kernel.registerLazyProgram(names, async () => {
      const t0 = Date.now();
      try {
        const res = (await ensure(kernel, () => fetchVendorAsset(asset))) as
          | { restored?: boolean; version?: string | null; fileCount?: number }
          | null;
        if (res && res.restored) {
          post("log", { line: `  [${label}] ready on first use (restored from OPFS, +${Date.now() - t0}ms).`, dim: true });
        } else if (res) {
          post("log", {
            line: `  [${label}] loaded on first use (${res.fileCount} files, +${Date.now() - t0}ms).`,
            dim: true,
          });
        } else {
          post("log", { line: `  [${label}] asset unavailable — \`${names[0]}\` not installed.`, dim: true });
        }
        return res;
      } catch (e) {
        post("log", { line: `  [${label}] load failed (${(e && (e as Error).message) || e}).`, dim: true });
        throw e; // let the kernel keep the registration so a later spawn can retry
      }
    });
  };

  // Real TypeScript 7 (tsgo, Go/wasm) — ~47 MB wasm, nothing at boot needs it.
  lazyTool(["tsc", "tsgo"], "tsgo", ensureRealTsgo, REAL_TSGO_ASSET);
  // Real yarn (classic).
  lazyTool(["yarn"], "yarn", ensureRealYarn, REAL_YARN_ASSET);
  // Real pnpm (also exposes pnpx).
  lazyTool(["pnpm", "pnpx"], "pnpm", ensureRealPnpm, REAL_PNPM_ASSET);
  // Real corepack (Node's PM version manager).
  lazyTool(["corepack"], "corepack", ensureRealCorepack, REAL_COREPACK_ASSET);
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

// ── Full-text search / replace (VS Code-style) ───────────────────────────────
// The search runs HERE, in the kernel worker, because it is the sole holder of
// the (synchronous) Wasm VFS — doing it on the main thread would mean thousands
// of postMessage round-trips per query. To keep the worker responsive (it also
// serves preview HTTP + terminal I/O) the walk yields to the event loop between
// chunks and streams results back in batches. A monotonic `currentSearchToken`
// makes a newer query cancel any still-running older one.
const SEARCH_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", ".vite", ".next", "build", ".cache",
]);
let currentSearchToken = -1;

// Convert one glob pattern into a regex source string. Supports *, **, **/, ?,
// and {a,b} brace groups; everything else is escaped literally.
function globPartToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      let j = i + 1, body = "";
      while (j < glob.length && glob[j] !== "}") { body += glob[j]; j++; }
      re += "(?:" + body.split(",").map((p) => globPartToRegex(p)).join("|") + ")";
      i = j;
    } else if ("\\^$+.|()[]/".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return re;
}

// Build a matcher fn from a comma-separated glob list (VS Code "files to
// include/exclude" semantics). Returns null when the list is empty.
function makeGlobMatcher(list) {
  const patterns = (list || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!patterns.length) return null;
  const res = patterns.map((raw) => {
    let p = raw;
    if (!/[*?{}/]/.test(p)) {
      // A bare word: a filename (has an extension) matches by basename, else it
      // is treated as a folder name and matches everything beneath it.
      p = /\.[^.]+$/.test(p) ? "**/" + p : "**/" + p + "/**";
    } else if (!p.includes("/")) {
      p = "**/" + p; // e.g. "*.ts" → any depth
    }
    if (p.endsWith("/")) p += "**";
    return new RegExp("^" + globPartToRegex(p) + "$");
  });
  return (rel) => res.some((re) => re.test(rel));
}

// Compile the search needle into a global RegExp honouring the toggles.
function buildSearchRegex({ query, matchCase, wholeWord, regex }) {
  let pattern = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (wholeWord) pattern = "\\b" + pattern + "\\b";
  return new RegExp(pattern, "g" + (matchCase ? "" : "i"));
}

// Expand $1/$2/$&/$$ style refs in a replacement template against a match.
function expandReplacement(template, matched, groups) {
  return template.replace(/\$(\d{1,2}|[$&])/g, (_, d) => {
    if (d === "$") return "$";
    if (d === "&") return matched;
    const g = groups[parseInt(d, 10) - 1];
    return g != null ? g : "";
  });
}

// VS Code "preserve case": ALLCAPS → upper, Capitalized → capitalized, else raw.
function applyPreserveCase(matched, out) {
  if (matched && matched === matched.toUpperCase() && matched !== matched.toLowerCase()) {
    return out.toUpperCase();
  }
  if (matched && matched[0] === matched[0].toUpperCase() && matched.slice(1) === matched.slice(1).toLowerCase()) {
    return out.charAt(0).toUpperCase() + out.slice(1);
  }
  return out;
}

function replaceInContent(content, re, template, preserveCase) {
  re.lastIndex = 0;
  return content.replace(re, (...args) => {
    const matched = args[0];
    const groups = args.slice(1, -2); // drop offset + whole-string tail args
    let out = expandReplacement(template, matched, groups);
    return preserveCase ? applyPreserveCase(matched, out) : out;
  });
}

// Read + grep a single file, pushing a per-file result into the batch.
function searchFile(abs, root, ctx) {
  let content;
  try { content = kernel.readFile(abs); } catch { return; }
  if (typeof content !== "string" || content.length > ctx.maxFileBytes) return;
  if (content.indexOf("\u0000") !== -1) return; // looks binary — skip
  const lines = content.split("\n");
  const matches = [];
  for (let i = 0; i < lines.length && !ctx.limitHit; i++) {
    const line = lines[i];
    ctx.re.lastIndex = 0;
    let m;
    while ((m = ctx.re.exec(line)) !== null) {
      matches.push({
        line: i + 1,
        column: m.index + 1,
        length: m[0].length,
        preview: line.length > 500 ? line.slice(0, 500) : line,
      });
      ctx.matchCount++;
      if (m[0].length === 0) ctx.re.lastIndex++; // guard against empty-match loops
      if (ctx.matchCount >= ctx.maxResults) { ctx.limitHit = true; break; }
    }
  }
  if (matches.length) {
    ctx.fileCount++;
    ctx.batch.push({ file: abs, root, matches });
  }
}

async function searchWalk(dir, root, ctx) {
  if (ctx.token !== currentSearchToken || ctx.limitHit) return;
  let names;
  try { names = kernel.readdir(dir); } catch { return; }
  names.sort();
  for (const name of names) {
    if (ctx.token !== currentSearchToken || ctx.limitHit) return;
    const abs = dir + "/" + name;
    let st;
    try { st = kernel.stat(abs); } catch { continue; }
    if (st.kind === "dir") {
      if (!SEARCH_SKIP_DIRS.has(name)) await searchWalk(abs, root, ctx);
      continue;
    }
    const rel = abs.startsWith(root + "/") ? abs.slice(root.length + 1) : name;
    if (ctx.include && !ctx.include(rel)) continue;
    if (ctx.exclude && ctx.exclude(rel)) continue;
    searchFile(abs, root, ctx);
    // Yield to the event loop periodically so preview/terminal messages still
    // get serviced, flushing partial results so the UI fills in progressively.
    if (++ctx.scanned % 40 === 0) {
      if (ctx.batch.length) { post("vv-search-result", { token: ctx.token, files: ctx.batch }); ctx.batch = []; }
      await new Promise((r) => setTimeout(r));
    }
  }
}

// ── IntelliSense dependency-type collection ──────────────────────────────────
// Gather a project's node_modules .d.ts + package.json for Monaco's TS language
// service. The ORDER matters: a blind walk can blow the budget on some giant
// package and drop the ones the project actually imports (e.g. react). So we
// harvest the project's DECLARED dependencies (+ their @types) FIRST — those are
// guaranteed in — then @types (ambient globals), then whatever fits. The
// `typescript` package's own lib.*.d.ts are skipped (Monaco ships its own).
const DTS_MAX_FILES = 12_000;
const DTS_MAX_BYTES = 32_000_000;
const DTS_SKIP_DIRS = new Set(["@types", "typescript", ".bin", ".cache", ".vite"]);

// A cheap "did node_modules change?" fingerprint: the sorted top-level package
// list (+ @types), no file reads. Lets a re-harvest after every process exit
// short-circuit unless an install actually added/removed packages.
function depsSignature(nm) {
  let names;
  try { names = kernel.readdir(nm); } catch { return ""; }
  names = names.slice().sort();
  const parts = [names.length + ":" + names.join(",")];
  try {
    let t = kernel.readdir(nm + "/@types");
    t = t.slice().sort();
    parts.push("@types=" + t.length + ":" + t.join(","));
  } catch { /* no @types */ }
  return parts.join("|");
}

// The declared dependency names from a project's package.json (all buckets).
function projectDepNames(root) {
  const names = new Set();
  try {
    const pkg = JSON.parse(kernel.readFile(root.replace(/\/+$/, "") + "/package.json"));
    for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const bucket = pkg[key];
      if (bucket && typeof bucket === "object") for (const n of Object.keys(bucket)) names.add(n);
    }
  } catch { /* no/invalid package.json */ }
  return names;
}

// `react` → `react`; `@scope/pkg` → `scope__pkg` (the @types package naming).
function typesPackageName(dep) {
  return dep[0] === "@" ? dep.slice(1).replace("/", "__") : dep;
}

async function collectDts(root, prevSig) {
  const out = [];
  const seen = new Set();
  const ctx = { bytes: 0, scanned: 0, truncated: false };
  if (!kernel) return { files: out, truncated: false, sig: "", unchanged: false };
  const rootClean = String(root || "").replace(/\/+$/, "");
  const nm = rootClean + "/node_modules";
  // sig === "" signals "no node_modules yet" to the caller.
  const noNm = (unchanged) => ({ files: out, truncated: false, sig: "", unchanged });
  try { if (!kernel.exists(nm)) return noNm(prevSig === ""); } catch { return noNm(false); }
  const sig = depsSignature(nm);
  // Unchanged since the caller's last harvest — skip the (expensive) file reads.
  if (sig && sig === prevSig) return { files: out, truncated: false, sig, unchanged: true };

  const collectFile = (abs, name) => {
    if (seen.has(abs)) return;
    if (!(name.endsWith(".d.ts") || name === "package.json")) return;
    let content;
    try { content = kernel.readFile(abs); } catch { return; }
    if (typeof content !== "string") return;
    seen.add(abs);
    out.push({ path: abs, content });
    ctx.bytes += content.length;
    if (out.length >= DTS_MAX_FILES || ctx.bytes >= DTS_MAX_BYTES) ctx.truncated = true;
  };

  const walk = async (dir, depth) => {
    if (ctx.truncated || depth > 12) return;
    let names;
    try { names = kernel.readdir(dir); } catch { return; }
    for (const name of names) {
      if (ctx.truncated) return;
      if (depth === 0 && DTS_SKIP_DIRS.has(name)) continue;
      const abs = dir + "/" + name;
      let st;
      try { st = kernel.stat(abs); } catch { continue; }
      if (st.kind === "dir") {
        await walk(abs, depth + 1);
      } else {
        collectFile(abs, name);
      }
      if (++ctx.scanned % 200 === 0) await new Promise((r) => setTimeout(r));
    }
  };

  // Walk a single package dir if it exists (used for the priority pass).
  const walkPkg = async (dir) => {
    let st;
    try { if (!kernel.exists(dir)) return; st = kernel.stat(dir); } catch { return; }
    if (st.kind === "dir") await walk(dir, 1);
  };

  // 1) Declared deps + their @types FIRST, so imported packages are never dropped.
  for (const dep of projectDepNames(root)) {
    if (ctx.truncated) break;
    await walkPkg(nm + "/" + dep);
    await walkPkg(nm + "/@types/" + typesPackageName(dep));
  }
  // 2) All @types (ambient globals), then 3) the rest of node_modules, budget permitting.
  try { if (kernel.exists(nm + "/@types")) await walk(nm + "/@types", 1); } catch { /* ignore */ }
  await walk(nm, 0);
  return { files: out, truncated: ctx.truncated, sig, unchanged: false };
}

async function runSearch(m) {
  const token = m.token;
  currentSearchToken = token;
  let re;
  try {
    re = buildSearchRegex(m);
  } catch (err) {
    post("vv-search-done", { token, error: errMsg(err) });
    return;
  }
  const ctx = {
    token, re,
    include: makeGlobMatcher(m.includeGlob),
    exclude: makeGlobMatcher(m.excludeGlob),
    maxResults: m.maxResults || 2000,
    maxFileBytes: m.maxFileBytes || 5_000_000,
    matchCount: 0, fileCount: 0, scanned: 0, limitHit: false,
    batch: [],
  };
  for (const root of m.roots || []) {
    if (ctx.token !== currentSearchToken) break;
    await searchWalk(root.replace(/\/+$/, ""), root.replace(/\/+$/, ""), ctx);
  }
  if (ctx.batch.length && ctx.token === currentSearchToken) {
    post("vv-search-result", { token, files: ctx.batch });
  }
  if (ctx.token === currentSearchToken) {
    post("vv-search-done", {
      token, matchCount: ctx.matchCount, fileCount: ctx.fileCount, limitHit: ctx.limitHit,
    });
  }
}

self.onmessage = async (event) => {
  const m = event.data;

  if (m.type === "init") {
    // Default on: only an explicit `compress: false` (?compress=0) disables it.
    vfsCompression = m.compress !== false;
    boot().catch((err) => post("log", { line: "kernel worker boot failed: " + err, stream: "stderr" }));
    return;
  }

  // The page is hiding — relay a best-effort flush to the FS worker so the OPFS
  // mirror catches any writes still queued in the write-behind buffer.
  if (m.type === "fs-flush") {
    if (fsWorkerRef) fsWorkerRef.postMessage({ type: "fs-flush" });
    return;
  }

  // Diagnostic memory readout (studio "Measure Memory"): report the kernel
  // worker's own measured memory + the VFS's in-RAM content footprint. The main
  // thread measures the page (which covers dedicated workers) separately and
  // combines the two.
  if (m.type === "vv-mem") {
    const [kernelBytes, vfsMem, procs] = await Promise.all([
      safeMeasureMemory(),
      queryVfsMem(),
      queryAllProcMem(),
    ]);
    post("vv-reply", {
      reqId: m.reqId,
      ok: true,
      kernelBytes,
      vfsBytes: vfsMem ? vfsMem.bytes : -1,
      vfsFiles: vfsMem ? vfsMem.files : -1,
      vfsLogicalBytes: vfsMem ? vfsMem.logical : -1,
      procs,
    });
    return;
  }

  // roadmap #19 stage C: a ws connection event from the preview iframe (relayed
  // by the main thread). Route it to the process owning the preview port.
  if (m.type === "vv-ws") {
    if (kernel) kernel.handleWsClient(m.msg);
    return;
  }

  // An SSE connection event from the preview iframe's EventSource polyfill
  // (relayed by the main thread). Route it to the process owning the preview port.
  if (m.type === "vv-sse") {
    if (kernel) kernel.handleSseClient(m.msg);
    return;
  }

  // ── Interactive terminals ──────────────────────────────────────────────────
  // Open a new shell for a terminal tab. `demo` set = the "Run" button: scaffold
  // the project and auto-run its dev command in this shell (VV_RUN), so the server
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

  // ── Generic process spawn (SDK `vivari.spawn`) ─────────────────────────────
  // Run one command directly (no wrapping shell) and stream its output/exit back
  // by `execId`. See spawnProcess + the execByPid routing in boot().
  if (m.type === "proc-spawn") {
    void spawnProcess(m.execId, m.command, m.args, m.cwd, m.env).catch((err) =>
      post("proc-exit", { execId: m.execId, code: 127, error: (err && err.message) || String(err) }),
    );
    return;
  }
  // Feed a chunk to a spawned process's stdin. `chunk == null` signals EOF.
  if (m.type === "proc-input") {
    const pid = pidByExec.get(m.execId);
    if (pid != null && kernel) kernel.sendStdin(pid, m.chunk == null ? null : m.chunk);
    return;
  }
  // Kill a spawned process (its exit is still reported via onProcExit → proc-exit).
  if (m.type === "proc-kill") {
    const pid = pidByExec.get(m.execId);
    if (pid != null && kernel) kernel.stop(pid);
    return;
  }

  // The user saved an edit in the host editor — write it to the VFS. The in-VM
  // dev server's watcher does the rest: Vite pushes an HMR update over the tunnel
  // to the preview iframe; Nest --watch recompiles + restarts (its re-listen then
  // triggers a preview reload via kernel.onListen above). No orchestration here.
  if (m.type === "vv-write") {
    if (kernel) {
      try {
        const slash = m.path.lastIndexOf("/");
        if (slash > 0) kernel.mkdirp(m.path.slice(0, slash));
        // `bytes` (a Uint8Array) is used for binary imports (dropped images /
        // files); `contents` (a string) for text edits. writeFile accepts either.
        kernel.writeFile(m.path, m.bytes ?? m.contents ?? "");
        post("vv-fs-changed", { path: m.path });
      } catch (err) {
        post("log", { line: "[edit] write failed: " + ((err && err.message) || err), stream: "stderr" });
      }
    }
    if (m.reqId != null) post("vv-reply", { reqId: m.reqId, ok: true });
    return;
  }

  // ── VFS queries for the multi-root Explorer (request/response via vv-reply) ──
  if (m.type === "vv-readdir") {
    if (!kernel) { post("vv-reply", { reqId: m.reqId, ok: false, error: "kernel not ready" }); return; }
    try {
      const base = m.path.replace(/\/+$/, "");
      const names = kernel.readdir(m.path);
      const entries = names.map((name) => {
        let dir = false;
        try { dir = kernel.stat(base + "/" + name).kind === "dir"; } catch { /* race: gone */ }
        return { name, dir };
      });
      post("vv-reply", { reqId: m.reqId, ok: true, path: m.path, entries });
    } catch (err) {
      post("vv-reply", { reqId: m.reqId, ok: false, error: errMsg(err) });
    }
    return;
  }
  if (m.type === "vv-read") {
    if (!kernel) { post("vv-reply", { reqId: m.reqId, ok: false, error: "kernel not ready" }); return; }
    try {
      post("vv-reply", { reqId: m.reqId, ok: true, path: m.path, contents: kernel.readFile(m.path) });
    } catch (err) {
      post("vv-reply", { reqId: m.reqId, ok: false, error: errMsg(err) });
    }
    return;
  }
  // Raw bytes for binary files (images) so the editor's image viewer gets an
  // uncorrupted buffer — readFile decodes to a JS string, which mangles binary.
  if (m.type === "vv-read-bytes") {
    if (!kernel) { post("vv-reply", { reqId: m.reqId, ok: false, error: "kernel not ready" }); return; }
    try {
      const bytes = kernel.readFileBytes(m.path);
      post("vv-reply", { reqId: m.reqId, ok: true, path: m.path, bytes });
    } catch (err) {
      post("vv-reply", { reqId: m.reqId, ok: false, error: errMsg(err) });
    }
    return;
  }
  // Existence + kind check used to validate a new project's target directory.
  if (m.type === "vv-stat") {
    if (!kernel) { post("vv-reply", { reqId: m.reqId, ok: true, exists: false, isDir: false }); return; }
    try {
      if (!kernel.exists(m.path)) { post("vv-reply", { reqId: m.reqId, ok: true, exists: false, isDir: false }); return; }
      const st = kernel.stat(m.path);
      post("vv-reply", { reqId: m.reqId, ok: true, exists: true, isDir: st.kind === "dir" });
    } catch {
      post("vv-reply", { reqId: m.reqId, ok: true, exists: false, isDir: false });
    }
    return;
  }
  if (m.type === "vv-mkdirp") {
    if (!kernel) { post("vv-reply", { reqId: m.reqId, ok: false, error: "kernel not ready" }); return; }
    try {
      kernel.mkdirp(m.path);
      post("vv-reply", { reqId: m.reqId, ok: true });
      post("vv-fs-changed", { path: m.path });
    } catch (err) {
      post("vv-reply", { reqId: m.reqId, ok: false, error: errMsg(err) });
    }
    return;
  }

  // Create a project: write its files in one batch and register its run manifest
  // so a later listen on its dev-server port points the preview at it.
  if (m.type === "vv-create-project") {
    if (!kernel) { post("vv-reply", { reqId: m.reqId, ok: false, error: "kernel not ready" }); return; }
    try {
      const dir = m.dir;
      kernel.mkdirp(dir);
      const files = m.files || {};
      const batch = Object.entries(files).map(([rel, contents]) => ({ path: dir + "/" + rel, contents }));
      if (batch.length) await kernel.writeFilesBatch(batch);
      if (m.manifest) registerProject(dir, m.manifest, m.title);
      post("vv-reply", { reqId: m.reqId, ok: true });
      post("vv-fs-changed", { path: dir });
    } catch (err) {
      post("vv-reply", { reqId: m.reqId, ok: false, error: errMsg(err) });
    }
    return;
  }
  // Re-attach a run manifest to an already-existing project dir (Open Folder /
  // "Run" on a reopened project), without rewriting its files.
  if (m.type === "vv-register-project") {
    if (kernel && m.manifest) registerProject(m.dir, m.manifest, m.title);
    if (m.reqId != null) post("vv-reply", { reqId: m.reqId, ok: true });
    return;
  }

  // ── IntelliSense: bulk-collect dependency type declarations ─────────────────
  // Harvest a project's node_modules **/*.d.ts (+ package.json, needed for
  // "types"/"exports" resolution) so the studio can feed them to Monaco's TS
  // language service as extra libs. Done HERE — the worker is the sole holder of
  // the sync Wasm VFS, so this is one bulk reply instead of thousands of per-file
  // read round-trips. Bounded (file count + total bytes) and yields periodically.
  if (m.type === "vv-collect-dts") {
    if (!kernel) { post("vv-reply", { reqId: m.reqId, ok: false, error: "kernel not ready" }); return; }
    collectDts(m.root, m.sig || "")
      .then((r) => post("vv-reply", { reqId: m.reqId, ok: true, files: r.files, truncated: r.truncated, sig: r.sig, unchanged: r.unchanged }))
      .catch((err) => post("vv-reply", { reqId: m.reqId, ok: false, error: errMsg(err) }));
    return;
  }

  // ── Full-text search / replace ─────────────────────────────────────────────
  // Kick off a streaming search (results arrive as vv-search-result batches, then
  // a final vv-search-done). Runs async so the worker keeps servicing messages.
  if (m.type === "vv-search") {
    if (!kernel) { post("vv-search-done", { token: m.token, error: "kernel not ready" }); return; }
    runSearch(m).catch((err) => post("vv-search-done", { token: m.token, error: errMsg(err) }));
    return;
  }
  // Supersede any in-flight search (query cleared / pane closed).
  if (m.type === "vv-search-cancel") {
    currentSearchToken = -1;
    return;
  }
  // Apply a replacement. Scope: a single {match}, an explicit list of {files}
  // (Replace All / per-file), all recomputed against the same matcher options.
  if (m.type === "vv-replace") {
    if (!kernel) { post("vv-reply", { reqId: m.reqId, ok: false, error: "kernel not ready" }); return; }
    try {
      const re = buildSearchRegex(m);
      let filesChanged = 0, replaced = 0;
      if (m.match) {
        const { file, line, column, length } = m.match;
        const content = kernel.readFile(file);
        const lines = content.split("\n");
        const li = line - 1;
        if (lines[li] != null) {
          const start = column - 1;
          const matched = lines[li].slice(start, start + length);
          re.lastIndex = 0;
          const mm = re.exec(matched);
          const groups = mm ? mm.slice(1) : [];
          let out = expandReplacement(m.replacement || "", matched, groups);
          if (m.preserveCase) out = applyPreserveCase(matched, out);
          lines[li] = lines[li].slice(0, start) + out + lines[li].slice(start + length);
          kernel.writeFile(file, lines.join("\n"));
          filesChanged = 1; replaced = 1;
          post("vv-fs-changed", { path: file });
        }
      } else {
        for (const file of m.files || []) {
          let content;
          try { content = kernel.readFile(file); } catch { continue; }
          re.lastIndex = 0;
          const count = (content.match(re) || []).length;
          if (!count) continue;
          const next = replaceInContent(content, re, m.replacement || "", m.preserveCase);
          if (next !== content) {
            kernel.writeFile(file, next);
            filesChanged++; replaced += count;
            post("vv-fs-changed", { path: file });
          }
        }
      }
      post("vv-reply", { reqId: m.reqId, ok: true, filesChanged, replaced });
    } catch (err) {
      post("vv-reply", { reqId: m.reqId, ok: false, error: errMsg(err) });
    }
    return;
  }

  // Explorer file operations. The VFS ops go through the FS Worker which calls
  // notifyWatch, so a running dev server picks the changes up (HMR / restart) on
  // its own. Each replies with `vv-fs-result` so the host can surface errors.
  if (m.type === "vv-rename" || m.type === "vv-rm" || m.type === "vv-copy") {
    const op = m.type.slice(3); // rename | rm | copy
    if (!kernel) {
      post("vv-fs-result", { op, ok: false, error: "kernel not ready", ...m });
      if (m.reqId != null) post("vv-reply", { reqId: m.reqId, ok: false, error: "kernel not ready" });
      return;
    }
    try {
      if (m.type === "vv-rename") kernel.rename(m.from, m.to);
      else if (m.type === "vv-rm") rmRecursive(m.path);
      else copyRecursive(m.from, m.to);
      post("vv-fs-result", { op, ok: true, from: m.from, to: m.to, path: m.path });
      post("vv-fs-changed", { path: m.to || m.path });
      // The SDK fs facade correlates by reqId; the studio Explorer keys off the
      // vv-fs-result above. Both are emitted so neither path is disturbed.
      if (m.reqId != null) post("vv-reply", { reqId: m.reqId, ok: true });
    } catch (err) {
      post("vv-fs-result", { op, ok: false, error: errMsg(err), from: m.from, to: m.to, path: m.path });
      if (m.reqId != null) post("vv-reply", { reqId: m.reqId, ok: false, error: errMsg(err) });
    }
    return;
  }

  // A preview request relayed from the main thread. The Service Worker's reply
  // port was transferred to us, so we answer it directly.
  if (m.type === "vv-http") {
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
