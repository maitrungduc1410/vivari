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

import { newProgress, onFetch, onOutput, idleClear, stallVerdict, servingPids, shouldReportStall, stallReportChunk } from "../../terminal-feedback.js";
import { Kernel } from "../../../kernel-host/kernel.js";
import { createKernelFs } from "../../../kernel-host/kernel-fs.js";
import { initTransferList } from "../../../kernel-host/worker-transfer.js";
import { ensureRealNpm } from "../../../kernel-host/load-real-npm.js";
import { ensureRealYarn } from "../../../kernel-host/load-real-yarn.js";
import { ensureRealPnpm } from "../../../kernel-host/load-real-pnpm.js";
import { ensureRealCorepack } from "../../../kernel-host/load-real-corepack.js";
import { ensureRealTsgo } from "../../../kernel-host/load-real-tsgo.js";
import { hashDepKey } from "../../../kernel-host/dep-cache.js";

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

// The vendored delivery assets (built by `npm run vendor:*`, served from
// packages/studio/public/vendor → the app's `<base>vendor/`). Each is fetched
// once and unpacked into the VFS so the shell's `npm`/`yarn`/`pnpm`/`corepack`/
// `tsc` are the REAL CLIs (North Star), not analogs. Names are RELATIVE to the
// app base (see vendorUrl): the studio is served under /studio/ and the docs
// playground under /embed/, so an origin-absolute "/vendor/…" would 404 — it must
// resolve against import.meta.env.BASE_URL. The files are gzip-compressed but NOT
// named `.gz` on purpose — see scripts/vendor-npm.mjs (a `.gz` name makes static
// servers set Content-Encoding: gzip, which the browser auto-decompresses,
// breaking our own gunzip).
const REAL_NPM_ASSET = "vendor/npm-pack.bin";
// The real-yarn (classic) delivery asset, same shape/rationale as npm's (built by
// `npm run vendor:yarn`). Unpacked into the VFS so `yarn` on PATH is the real CLI.
const REAL_YARN_ASSET = "vendor/yarn-pack.bin";
// The real-pnpm delivery asset, same shape/rationale as npm/yarn's (built by
// `npm run vendor:pnpm`). Unpacked into the VFS so `pnpm` on PATH is the real CLI.
const REAL_PNPM_ASSET = "vendor/pnpm-pack.bin";
// The real-corepack delivery asset (built by `npm run vendor:corepack`). Unpacked
// into the VFS so `corepack` on PATH can DOWNLOAD + run project-pinned yarn/pnpm/
// npm versions (`packageManager` field), on top of the direct vendored defaults.
const REAL_COREPACK_ASSET = "vendor/corepack-pack.bin";
// The real-TypeScript-7 (tsgo, Go/wasm) delivery asset (built by `npm run
// vendor:tsgo`). ~11 MB gz, so it's loaded LAZILY in the background after boot;
// unpacked into the VFS so `tsc`/`tsgo` on PATH are the real Go compiler.
const REAL_TSGO_ASSET = "vendor/tsgo-pack.bin";
// Prebuilt node_modules snapshots for the templates, produced by running each
// install once at build time. A first run on a fresh origin can then RESTORE the
// tree (~0.1s, zero network) instead of installing it (~11.5s here, and the phase
// where heavy templates have repeatedly appeared to hang). The manifest maps a
// dep-cache key to its asset, and is the feature's on/off switch: if it is not
// served, nothing is fetched and every project installs normally, so an origin that
// doesn't ship snapshots pays nothing — not even a 404 per project.
const DEPCACHE_MANIFEST = "vendor/depcache/index.json";

// Resolve a vendored asset name to a full URL against the app's configured base
// (Vite's import.meta.env.BASE_URL — "/studio/", "/embed/", or "/"). The vendor
// files ship inside each app's output, so they must be fetched from the base
// path, not the origin root (which is only used by the root-scoped Service
// Worker). Falls back to "/" when the env is absent (non-Vite consumers).
function vendorUrl(name: string): string {
  const origin = (self.location && self.location.origin) || "";
  const base =
    (typeof import.meta !== "undefined" &&
      import.meta.env &&
      import.meta.env.BASE_URL) ||
    "/";
  return origin + base + name;
}

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

// Breakpoint debugger: when on, run/demo terminals launch their process tree with
// env VV_DEBUG=1, so the in-guest CDP Debugger backend attaches and the user's own
// source is instrumented for breakpoints. Toggled from the studio (vv-debug-mode).
let debugMode = false;

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

// Announce a port as genuinely serving, for the SDK's `server-ready` event. The
// project/demo paths below do the same probe plus studio-specific orchestration;
// this one is the framework-agnostic version every listened port gets.
async function announceServing(port) {
  const ok = await waitServing(port, 60000);
  // Never answered, or it went away while we were probing — leave the port
  // un-announced and re-arm so a later listen probes again.
  if (!ok || !listening.has(port)) {
    servingProbed.delete(port);
    return;
  }
  post("serving", { port });
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
async function demoRunCommand(d) {
  const run = d.runArgs && d.runArgs.length ? `${d.runCmd} ${d.runArgs.join(" ")}` : d.runCmd;
  if (kernel.exists(d.dir + "/node_modules")) return run;
  // Deps not present yet — try the persistent cache before falling back to a real
  // install. The demos install with npm.
  if (await tryRestoreDeps(d.dir, "npm")) return run;
  post("log", { line: "  [depcache] no snapshot for npm — installing…", dim: true });
  return `npm install && ${run}`;
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
// The kernel-fs client (createKernelFs return), kept module-scoped so the
// dependency-cache round-trips (depCacheHas/Save/Restore) are reachable from the
// project/demo run helpers and the process-exit snapshot hook. Set in boot().
let kernelFsRef = null;
const listening = new Set();
// Ports already probed for the SDK's `serving` announcement. A dev server binds,
// closes and rebinds several times while starting, so each of those emits a
// `listen`; probe a port once and re-arm only when it genuinely goes away.
const servingProbed = new Set();

// ── Persistent dependency cache (P1) ─────────────────────────────────────────
// Cache the RESULT of an install (node_modules) keyed by the lockfile, so a
// project whose deps were installed before (this project after a reset, or a
// different project with the same lockfile) skips `npm/yarn/pnpm install` and
// restores node_modules from an OPFS snapshot instead. The snapshot store lives
// in the FS Worker (dep-cache.js); here we decide WHEN to restore/snapshot and
// compute the lockfile-derived cache key.
const LOCKFILES = {
  // Bun's shim delegates installs to npm (so a package-lock.json is ALSO written),
  // but a bun.lock/bun.lockb marks the project as Bun-managed — probed first below.
  bun: ["bun.lock", "bun.lockb"],
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  yarn: ["yarn.lock"],
  pnpm: ["pnpm-lock.yaml"],
};

// Map a command / install string ("npm", "npm install", "pnpm i", "yarn", "bun")
// to a package-manager name. Defaults to npm.
function pmName(hint) {
  const first = String(hint || "").trim().split(/\s+/)[0] || "";
  if (/^bunx?$/.test(first) || /\bbun\b/.test(first)) return "bun";
  if (/pnpm/.test(first)) return "pnpm";
  if (/yarn/.test(first)) return "yarn";
  return "npm";
}

// Detect a project's package manager from the lockfile on disk (npm is the
// default when only a package.json exists). Used by vv-ensure-deps to pick the
// right snapshot key when reopening a project we didn't just install. bun is
// probed first: its lockfile coexists with npm's (installs delegate to npm), so
// its presence is the strongest signal the project is intended to run under Bun.
function detectPm(dir) {
  const base = String(dir).replace(/\/+$/, "");
  for (const pm of ["bun", "pnpm", "yarn", "npm"]) {
    for (const lf of LOCKFILES[pm] || []) {
      try {
        if (kernel.exists(base + "/" + lf)) return pm;
      } catch {
        /* unreadable — keep probing */
      }
    }
  }
  return "npm";
}

// The bytes we hash into a cache key for `dir`: the PM's lockfile if present,
// else package.json (so a brand-new template still gets a key before its first
// lockfile is generated). Returns { bytes, src } or null.
function depKeyInput(dir, pm) {
  const base = String(dir).replace(/\/+$/, "");
  for (const lf of LOCKFILES[pm] || []) {
    const p = base + "/" + lf;
    try {
      if (kernel.exists(p)) return { bytes: kernel.readFileBytes(p), src: lf };
    } catch {
      /* unreadable — fall through */
    }
  }
  const pj = base + "/package.json";
  try {
    if (kernel.exists(pj)) return { bytes: kernel.readFileBytes(pj), src: "package.json" };
  } catch {
    /* none */
  }
  return null;
}

// The key used to LOOK UP a snapshot before install: lockfile if present, else
// package.json. Returns null when there's nothing to key on.
async function computeDepKey(dir, pm) {
  const inp = depKeyInput(dir, pm);
  if (!inp) return null;
  return await hashDepKey(pm, inp.bytes, inp.src);
}

// The keys used to SAVE a snapshot after install: the primary (lockfile if it
// now exists, else package.json) plus, when a lockfile exists, an ALIAS on the
// package.json hash — so a future fresh project of the same template (which has
// no lockfile yet) still hits this snapshot on its pre-install lookup.
async function computeDepSaveKeys(dir, pm) {
  const base = String(dir).replace(/\/+$/, "");
  let lock = null;
  for (const lf of LOCKFILES[pm] || []) {
    const p = base + "/" + lf;
    try {
      if (kernel.exists(p)) { lock = { bytes: kernel.readFileBytes(p), src: lf }; break; }
    } catch { /* skip */ }
  }
  let pj = null;
  try {
    const p = base + "/package.json";
    if (kernel.exists(p)) pj = { bytes: kernel.readFileBytes(p), src: "package.json" };
  } catch { /* none */ }
  const primaryInput = lock || pj;
  if (!primaryInput) return null;
  const primary = await hashDepKey(pm, primaryInput.bytes, primaryInput.src);
  const aliases = [];
  if (lock && pj) {
    const pjKey = await hashDepKey(pm, pj.bytes, "package.json");
    if (pjKey !== primary) aliases.push(pjKey);
  }
  return { primary, aliases };
}

// ---- shipped snapshots ------------------------------------------------------
// The manifest, fetched at most once per session. `undefined` = not looked at yet,
// `null` = not served (feature off, remembered so we never ask twice).
let depCacheManifest: Record<string, { asset: string; bytes?: number; entries?: number }> | null | undefined;
let depCacheManifestPromise: Promise<typeof depCacheManifest> | null = null;
// Keys already attempted this session, so a corrupt or missing asset costs one
// fetch rather than one per project run.
const depCacheAssetTried = new Set<string>();

function loadDepCacheManifest() {
  if (depCacheManifest !== undefined) return Promise.resolve(depCacheManifest);
  if (!depCacheManifestPromise) {
    depCacheManifestPromise = (async () => {
      try {
        const r = await fetch(vendorUrl(DEPCACHE_MANIFEST));
        // Not served, or served as an SPA index.html fallback (which is why the
        // parse below is inside the try): the feature is simply off.
        depCacheManifest = r.ok ? await r.json() : null;
      } catch {
        depCacheManifest = null;
      }
      return depCacheManifest;
    })();
  }
  return depCacheManifestPromise;
}

// A dep-cache lookup missed, but the app may SHIP a snapshot for this exact key.
// Fetch it and hand it to the store, so the caller's `depCacheRestore` then hits.
// Returns true only if the snapshot is now in the store. Every failure path —
// no manifest, no entry for this key, a fetch error, a malformed archive — returns
// false and leaves the caller to install normally.
async function tryFetchShippedSnapshot(key: string, pm: string): Promise<boolean> {
  if (depCacheAssetTried.has(key)) return false;
  const manifest = await loadDepCacheManifest();
  const entry = manifest && manifest[key];
  if (!entry || !entry.asset) return false;
  depCacheAssetTried.add(key);
  const mb = entry.bytes ? ` ${(entry.bytes / 1048576).toFixed(1)} MB` : "";
  // Announce BEFORE the download: this is the one moment where a working restore
  // and a wedged VM look identical, and the download is the slow part.
  post("log", { line: `  [depcache] fetching prebuilt node_modules for ${pm}${mb}…`, dim: true });
  const t0 = Date.now();
  try {
    const r = await fetch(vendorUrl(entry.asset));
    if (!r.ok) {
      post("log", { line: `  [depcache] prebuilt snapshot unavailable (HTTP ${r.status}) — installing normally.`, dim: true });
      return false;
    }
    const bytes = new Uint8Array(await r.arrayBuffer());
    const res = await kernelFsRef.fs.depCacheImport(key, bytes);
    if (!res) {
      // The store validated the archive and rejected it (truncated download, wrong
      // asset, an error page served with a 200). Not fatal — just install.
      post("log", { line: "  [depcache] prebuilt snapshot was not usable — installing normally.", dim: true });
      return false;
    }
    post("log", {
      line:
        `  [depcache] prebuilt snapshot ready (${res.entries.toLocaleString()} entries, ` +
        `${(res.bytes / 1048576).toFixed(1)} MB, ${Date.now() - t0}ms).`,
      dim: true,
    });
    return true;
  } catch (err) {
    post("log", {
      line: `  [depcache] prebuilt snapshot fetch failed (${(err && err.message) || err}) — installing normally.`,
      dim: true,
    });
    return false;
  }
}

// Try to restore node_modules for `dir` from the dependency cache. Returns true
// (and the shell can skip install) only on a real restore. Best-effort: any
// failure just falls back to a normal install.
async function tryRestoreDeps(dir, pmHint) {
  try {
    if (!kernelFsRef || !kernel) return false;
    const pm = pmName(pmHint);
    const key = await computeDepKey(dir, pm);
    if (!key) return false;
    if (!(await kernelFsRef.fs.depCacheHas(key))) {
      // Nothing installed this tree before — but the app may ship it prebuilt,
      // which is the whole first-run cost for a template.
      if (!(await tryFetchShippedSnapshot(key, pm))) return false;
    }
    // Restoring ~13k entries is fast but not instant, and until it finishes the
    // terminal says nothing. Say what is happening first.
    post("log", { line: `  [depcache] restoring node_modules for ${pm}…`, dim: true });
    const t0 = Date.now();
    const count = await kernelFsRef.fs.depCacheRestore(key, dir);
    if (count > 0) {
      post("log", {
        line: `  [depcache] restored node_modules for ${pm} (${count} entries, ${Date.now() - t0}ms) — skipping install.`,
        dim: true,
      });
      return true;
    }
    post("log", { line: `  [depcache] snapshot restored nothing for ${pm} — installing normally.`, dim: true });
  } catch {
    /* best effort — fall back to install */
  }
  return false;
}

// Dirs with an in-flight snapshot, so two install exits racing on the same
// project don't both pack node_modules.
const snapshotInFlight = new Set();

// Snapshot node_modules for `dir` into the dependency cache after a successful
// install. Best-effort, and a no-op if a snapshot for the current lockfile
// already exists (an unchanged re-install), so it never re-packs needlessly.
async function maybeSnapshotDeps(dir, pmHint) {
  if (snapshotInFlight.has(dir)) return;
  snapshotInFlight.add(dir);
  try {
    if (!kernelFsRef || !kernel) return;
    const base = String(dir).replace(/\/+$/, "");
    if (!kernel.exists(base + "/node_modules")) {
      post("log", { line: `  [depcache] skip snapshot: no node_modules at ${base}`, dim: true });
      return;
    }
    const pm = pmName(pmHint);
    const keys = await computeDepSaveKeys(base, pm);
    if (!keys) {
      post("log", { line: `  [depcache] skip snapshot: no lockfile/package.json at ${base}`, dim: true });
      return;
    }
    if (await kernelFsRef.fs.depCacheHas(keys.primary)) return; // already cached
    const res = await kernelFsRef.fs.depCacheSave(keys.primary, base, keys.aliases);
    if (res) {
      post("log", {
        line: `  [depcache] cached node_modules for ${pm} (${res.files} files, ${(res.bytes / 1048576).toFixed(1)} MB).`,
        dim: true,
      });
    } else {
      post("log", { line: `  [depcache] snapshot returned no result for ${base}`, dim: true });
    }
  } catch (err) {
    post("log", { line: `  [depcache] snapshot failed: ${(err && err.message) || err}`, dim: true });
  } finally {
    snapshotInFlight.delete(dir);
  }
}

// Does this invocation install dependencies (so its exit-0 should snapshot)?
// Returns the PM name or null. Covers npm/pnpm install|ci|i|add and bare `yarn`.
function installInvocation(command, args) {
  const pm = pmName(command);
  const positional = (args || []).map(String).filter((a) => !a.startsWith("-"));
  const sub = positional[0];
  if (pm === "yarn") {
    // bare `yarn` (no subcommand) = install; `yarn install`/`yarn add` too.
    if (sub === undefined || sub === "install" || sub === "add") return "yarn";
    return null;
  }
  if (pm === "bun") {
    // `bun install|i|add|remove|update|ci` mutate node_modules (via npm delegation);
    // `bun run`/`bun test`/`bun x`/bare-file do not. Snapshot only the installers.
    return ["install", "i", "add", "remove", "rm", "uninstall", "update", "upgrade", "ci"].includes(sub)
      ? "bun"
      : null;
  }
  const installSubs = pm === "pnpm"
    ? ["install", "i", "add", "update"]
    : ["install", "i", "ci", "add", "update"];
  return installSubs.includes(sub) ? pm : null;
}
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
const fetchProg = new Map(); // terminalId -> progress state (terminal-feedback.js)
// Returns whether it actually erased a line, because a caller that wants to write
// where the spinner was needs to know whether there WAS one. Without that answer
// the only safe assumption is that the current line belongs to somebody else.
function clearProgress(tid) {
  const s = fetchProg.get(tid);
  if (!s) return false;
  const chunk = onOutput(s);
  if (chunk) post("term-out", { terminalId: tid, chunk });
  return !!chunk;
}
// A spinner nobody is feeding is just a line that looks stuck. Sweep the idle ones
// so the indicator ends when the traffic does, rather than freezing on its last
// frame for as long as the process lives.
setInterval(() => {
  const now = Date.now();
  for (const [tid, s] of fetchProg) {
    const chunk = idleClear(s, now);
    if (chunk) post("term-out", { terminalId: tid, chunk });
  }
}, 500);

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
    // .venv/bin is where a pip-installed package's console script lands, the
    // same as any other venv — so `pip install rich` is followed by `rich`
    // working, not by "command not found" for the thing that just installed.
    PATH: dir + "/node_modules/.bin:" + dir + "/.venv/bin:/bin",
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
    // Same-origin base URL of the vendored Pyodide distribution. Read by the
    // /bin/python.js launcher (only when a `python` process runs) to lazily boot
    // Pyodide — nothing here is fetched at boot. See packages/runtime/builtins/python.js.
    VV_PYODIDE_INDEX_URL: vendorUrl("vendor/pyodide/"),
    // Same-origin URL of the vendored SQLite engine. Read by bun:sqlite on the FIRST
    // `new Database()` and never before — a process that does not open a database
    // fetches nothing (see packages/runtime/builtins/bun-sqlite.js). Unlike Pyodide
    // this is not gated on a launcher, because bun:sqlite is a builtin any process can
    // require; the laziness lives in the module instead.
    VV_SQLITE_WASM_URL: vendorUrl("vendor/sqlite/sqlite3.wasm"),
    // Same-origin base URL of the vendored ruff. Read by /bin/ruff.js when a
    // `ruff` process runs. Gated on the launcher like Pyodide, and unlike
    // Pyodide it stays out of the interpreter entirely: linting a project never
    // boots CPython. See packages/kernel-host/programs/ruff.js.
    VV_RUFF_URL: vendorUrl("vendor/ruff/"),
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

async function openTerminal(terminalId, cwd, demoId, run) {
  if (!kernel) return;
  const d = demoId ? DEMOS[demoId] : null;
  if (d) scaffoldDemo(demoId);
  const dir = (d ? d.dir : cwd) || defaultTermCwd();
  const env = baseProcEnv(dir);
  // Breakpoint debugger: when debug mode is on, mark this process tree as a debug
  // target. The shell passes env to its children, so any `node …` the user runs —
  // whether via Run/demo or typed by hand in an interactive terminal — inherits
  // VV_DEBUG and attaches the debugger. The shell + package managers themselves are
  // skipped as targets in the kernel, so auto-attach lands on the real program.
  if (debugMode) env.VV_DEBUG = "1";
  if (d) env.VV_RUN = await demoRunCommand(d);
  // A created/opened project's "Run" (or auto-run after create) hands us an
  // explicit command; install is skipped once node_modules exists, or restored
  // from the persistent dependency cache when a matching lockfile snapshot exists.
  else if (run) {
    const p = projects.get(dir);
    const install = p && p.install ? p.install : "npm install";
    const devCmd = run;
    let vvRun;
    if (kernel.exists(dir + "/node_modules")) vvRun = devCmd;
    else if (await tryRestoreDeps(dir, install)) vvRun = devCmd;
    else {
      post("log", { line: `  [depcache] no snapshot for ${pmName(install)} — installing…`, dim: true });
      vvRun = `${install} && ${devCmd}`;
    }
    env.VV_RUN = vvRun;
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
// (init.compress, the BootOptions.compress SDK flag) and relayed to the File
// System Worker. On by default; a consumer sets it false only to trade memory
// for a little less CPU.
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
// cold `.vite` cache — which is exactly why a fresh session / reset triggers it). So we prime
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
              alive: data.alive ?? null,
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
  post("boot-progress", { phase: "init" });

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
      // Structured boot progress (OPFS restore done/total) — relay for the UI.
      else if (event.data.type === "boot-progress")
        post("boot-progress", {
          phase: event.data.phase,
          done: event.data.done,
          total: event.data.total,
        });
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
  kernelFsRef = kernelFs;
  onKernelFsMessage = kernelFs.onMessage;
  post("log", { line: `  [boot] file system ready (+${Date.now() - t0}ms).`, dim: true });
  // OPFS restore (the long pole) is done; the remaining steps before the UI
  // unlocks (codec compile + kernel construction) are quick and indeterminate.
  post("boot-progress", { phase: "finalize" });

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
    // Proof the worker's module graph evaluated — see reportWorkerError below.
    let sawMessage = false;
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
      sawMessage = true;
      const handler = info.on[event.data.type];
      if (!handler) return;
      // These payloads are only as trustworthy as the process that sent them, which
      // in a browser means the GUEST: `globalThis.postMessage` inside a Process
      // Worker posts straight here, so guest code could aim any entry in this
      // handler table at a payload of its choosing. Five of these handlers threw on
      // a malformed message (measured; `thread-spawn` died on a bare `{}`), and an
      // unguarded throw here escapes into onmessage and kills the kernel — every
      // process, the VFS session and the preview, over one bad message.
      //
      // The guest's access to this channel is removed at the other end too (see
      // packages/runtime/index.js); this is the half that does not depend on
      // getting that right.
      try {
        handler(event.data);
      } catch (err) {
        console.error(`[kernel] message '${event.data.type}' from pid ${info.pid} failed:`, err);
      }
    };
    // A worker that fails to BOOT never sends 'exit', so without these handlers the
    // kernel never finalizes it and every waiter hangs forever — the terminal keeps
    // its last line, start()'s promise never settles, a parent parked on OP_SPAWN is
    // stuck. What the platform gives us, and what it actually means:
    //   onerror        — either the worker failed to load/evaluate its module graph
    //                    (fatal: it never ran), or an uncaught exception propagated
    //                    out of a RUNNING worker's event loop. The second case is
    //                    NOT death: per spec the error is merely reported and the
    //                    worker keeps servicing tasks. The kernel distinguishes them
    //                    by whether the worker has ever posted a message; killing on
    //                    the second case broke `astro dev`, which throws ~113 times
    //                    per run and had always survived it.
    //   onmessageerror — a message failed to deserialize (an untransferable value in
    //                    workerData, say); the worker is alive.
    // Neither is how an OOM kill arrives: Chrome reclaims a worker without firing
    // anything at all, which is why the liveness watchdog exists. ErrorEvent.message
    // is often empty for cross-origin errors, hence the fallback text.
    // Whether the worker ever came up is decided HERE, where the platform detail
    // lives: a worker that has posted even one message evaluated its module graph and
    // is running, so an `error` from it is an uncaught exception, not a death. The
    // 5s floor covers the one shape the message test misses — a process that boots and
    // does only filesystem work, which the kernel never hears from (fs traffic goes
    // direct to the FS worker) — because a worker still alive after 5s plainly booted.
    // Erring towards NOT fatal is deliberate: wrongly killing a live process is the
    // regression that broke `astro dev`, whereas a genuinely dead worker that is not
    // finalized is caught by the liveness watchdog seconds later.
    const spawnedAt = Date.now();
    const reportWorkerError = (error: string) => {
      const handler = info.on["worker-error"];
      if (handler) handler({ type: "worker-error", error, fatal: !sawMessage && Date.now() - spawnedAt < 5000 });
    };
    worker.onerror = (event) => {
      const e = event as ErrorEvent;
      reportWorkerError(
        (e && (e.message || (e.error && e.error.message))) || "worker terminated without an error message",
      );
    };
    // Never fatal: the worker is alive, it just could not read one message.
    worker.onmessageerror = () => reportWorkerError("worker could not deserialize a message");
    procWorkers.set(info.pid, { worker, name: "PID " + info.pid });
    const { port1, port2 } = new MessageChannel();
    fsWorker.postMessage({ type: "fs-register", client: info.pid, sab: info.sab, port: port2 }, [port2]);
    // #16 stage 2b: a spawned thread also receives its parentPort (a MessagePort
    // transferred from its creator through us) alongside its fs doorbell.
    // [optimize] Hand over the pre-compiled codec Modules (cloned, not
    // transferred — a Module stays usable here and in every process).
    const init = { type: "init", sab: info.sab, spec: info.spec, fsPort: port1, codecModule, cryptoModule };
    // Breakpoint debugger: a debug target also receives its debug-command SAB. A
    // SharedArrayBuffer is shared by reference (never transferred), so it just rides
    // along in the init payload.
    if (info.debugSab) {
      init.debugSab = info.debugSab;
      // …and which of the two backends is meant to read it.
      init.debugLang = info.debugLang || "js";
    }
    if (info.threadPort) init.threadPort = info.threadPort;
    // #16 stage 2b: a spawned thread's workerData may embed MessagePort(s) — the
    // tinypool/piscina/createSyncFn pattern. They were transferred to us on the
    // thread-spawn message and have to be transferred ON to the child, else
    // structuredClone rejects the whole init message. initTransferList is shared with
    // every other host that builds this message, so they cannot disagree about it.
    worker.postMessage(init, initTransferList(info, port1));
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
      // Direct hit first (the common case: a shell's own output). Falling back to the
      // parent chain matters for a CHILD that died — its stderr normally relays through
      // the parent worker, which is exactly what is unavailable when the parent is gone
      // too, and that text is the diagnosis. Without this it goes to the studio console
      // where the user never sees it.
      const tid = termByPid.get(pid) ?? terminalForPid(pid);
      if (tid !== undefined) {
        clearProgress(tid);
        post("term-out", { terminalId: tid, chunk });
      } else post("stderr", { chunk });
    },
  });
  // Liveness watchdog: a process has gone quiet for a long time. This is the only
  // thing the user can see when the VM stops making progress — previously a wedged
  // install left the terminal on its last line with no indication whether it was
  // working or dead, which cost two rounds of misdiagnosis. Purely informational:
  // a slow-but-healthy install prints one line and carries on.
  // "Is it working or wedged?" cannot be answered from the kernel: a process's file
  // writes bypass it entirely (they go straight to the FS worker over a SAB), so a
  // process extracting 12,000 packages registers zero kernel syscalls. The VFS file
  // count is the signal that actually tracks reify progress, and only this side can
  // ask for it. Remembered per process so each report is a comparison, not a snapshot.
  const stallVfsSeen = new Map<number, number>();
  kernel.onProcStall = async (pid, info) => {
    // A process that has bound a port got where it was going. It prints nothing
    // between requests and makes no syscalls while idle, so every signal this
    // watchdog reads says "silent" — and every report it produces is noise about
    // a server doing exactly what a server does. Its shell is blocked waiting on
    // it and is just as quiet, hence the ancestors too.
    const parentOf = new Map<number, number>();
    for (const [cpid, proc] of kernel.procs) parentOf.set(cpid, proc.parentPid ?? 0);
    const serving = servingPids(kernel.listeners, parentOf).has(pid);
    // …unless requests are waiting on it, which is the one case where a silent
    // server is worth interrupting somebody about.
    let pendingRequests = 0;
    for (const [, pend] of kernel.pendingHttp) if (pend.pid === pid) pendingRequests++;
    // A shell that is waiting on a child is silent because it is waiting. Its child
    // is watched too, so the report that matters still arrives — under the name of
    // the program that is actually quiet.
    let hasLiveChild = false;
    for (const [, parent] of parentOf) if (parent === pid) hasLiveChild = true;
    // …and a shell sitting at its prompt is silent for the same reason, one step
    // further out again: it is waiting for a person. That one is not visible from
    // here, so the process announces it (kernel.handleAwaitingInput).
    const awaitingInput = !!kernel.procs.get(pid)?.awaitingInput;
    if (!shouldReportStall({ serving, pendingRequests, hasLiveChild, awaitingInput })) return;

    const secs = Math.round(info.silentMs / 1000);
    const what = [info.command, ...(info.args || [])].join(" ").slice(0, 80);
    const vfs = await queryVfsMem(1500);
    const files = vfs && vfs.files >= 0 ? vfs.files : null;
    const before = stallVfsSeen.get(pid);
    if (files !== null) stallVfsSeen.set(pid, files);
    const grew = files !== null && before !== undefined ? files - before : null;

    // Which ports this pid holds: a listening process that is quiet is usually a
    // server between requests, not a slow install.
    const ports: number[] = [];
    for (const [port, owner] of kernel.listeners) if (owner === pid) ports.push(port);
    const verdict = stallVerdict({ grew, files, idleMs: info.idleMs, ports, pendingRequests });
    const line =
      `  [runtime] PID ${pid} (${what}) has printed nothing for ${secs}s. ${verdict}` +
      (info.workerErrors ? ` (${info.workerErrors} uncaught worker errors so far.)` : "") +
      " Run `await __vv.diag()` in the DevTools console for live detail.";
    const tid = terminalForPid(pid);
    if (tid === undefined) {
      post("log", { line, dim: true });
      return;
    }
    const progressCleared = clearProgress(tid);
    post("term-out", { terminalId: tid, chunk: stallReportChunk(line, { progressCleared }) });
  };

  kernel.onProcExit = (pid, res) => {
    stallVfsSeen.delete(pid);
    // Persistent dependency cache (P1): a package-manager install that just
    // finished cleanly is our signal to snapshot node_modules. Keying off the
    // process invocation covers every install path uniformly — the auto-run
    // `install && dev` shell's npm child, a manually typed `npm install`, and the
    // SDK `vivari.spawn('npm', ['install'])` path. Fire-and-forget; no-op if the
    // current lockfile is already cached.
    const installPm = res && res.code === 0 ? installInvocation(res.command, res.args) : null;
    if (installPm && res.cwd) void maybeSnapshotDeps(res.cwd, installPm);

    const eid = execByPid.get(pid);
    if (eid !== undefined) {
      execByPid.delete(pid);
      pidByExec.delete(eid);
      // `error` is set only when the process died of a worker fault rather than
      // exiting, so an SDK consumer can tell "the program failed" from "the VM lost
      // the program". The other proc-exit sites already carry this field.
      post("proc-exit", { execId: eid, code: res.code, ...(res.error ? { error: res.error } : {}) });
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
    // `listen` is the raw bind; it is NOT safe to point a preview at yet. Drive
    // real GET /'s through the kernel until one is answered and announce THAT as
    // `serving`, so an SDK consumer's iframe never loads into a momentarily-closed
    // port (which the preview proxy answers with 502).
    if (!servingProbed.has(port)) {
      servingProbed.add(port);
      announceServing(port);
    }
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
  // The mirror of onListen: a server closed its port, or the process holding it
  // died. Fires before onProcExit, so `listening` is still populated here.
  kernel.onClose = (port) => {
    if (!listening.delete(port)) return;
    servingProbed.delete(port);
    post("port-close", { port });
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
    const s = fetchProg.get(tid) || newProgress();
    const chunk = onFetch(s, info.size, Date.now());
    if (chunk) post("term-out", { terminalId: tid, chunk });
    fetchProg.set(tid, s);
  };
  // roadmap #19 stage C: a ws frame a process relayed OUT of the VM (Vite's HMR
  // server) — forward it to the main thread, which delivers it to the preview
  // iframe's WebSocket polyfill.
  // Breakpoint debugger: relay CDP events/responses from a target's in-guest
  // backend out to the main thread (→ studio DebugPanel / chii), and announce debug
  // targets appearing/disappearing so the UI can attach/detach.
  kernel.onDebugEvent = (pid, data) => post("dbg-event", { pid, data });
  kernel.onDebugTarget = (pid, added, info) => post("dbg-target", { pid, added, info });
  // Carry over a debug-mode toggle that arrived before the kernel booted.
  kernel.debugMode = debugMode;
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
      const r = await fetch(vendorUrl(REAL_NPM_ASSET));
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

// Fetch a vendor asset (npm/yarn/pnpm/corepack/tsgo pack) by base-relative name
// (resolved against the app base via vendorUrl). Returns its bytes, or null if
// the asset isn't served (in which case the tool simply isn't installed — same as
// a missing npm).
async function fetchVendorAsset(assetPath: string): Promise<Uint8Array | null> {
  const r = await fetch(vendorUrl(assetPath));
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
    // One-line, terminal-visible notice shown the moment a first-use download
    // starts (so the command isn't a silent multi-second frozen prompt).
    notice: string,
  ) => {
    kernel.registerLazyProgram(
      names,
      async () => {
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
      },
      notice,
    );
  };

  // Real TypeScript 7 (tsgo, Go/wasm) — ~47 MB wasm, nothing at boot needs it.
  lazyTool(["tsc", "tsgo"], "tsgo", ensureRealTsgo, REAL_TSGO_ASSET,
    "Downloading TypeScript 7 (tsgo) on first use — this can take a few seconds…");
  // Real yarn (classic).
  lazyTool(["yarn"], "yarn", ensureRealYarn, REAL_YARN_ASSET,
    "Downloading yarn on first use…");
  // Real pnpm (also exposes pnpx).
  lazyTool(["pnpm", "pnpx"], "pnpm", ensureRealPnpm, REAL_PNPM_ASSET,
    "Downloading pnpm on first use…");
  // Real corepack (Node's PM version manager).
  lazyTool(["corepack"], "corepack", ensureRealCorepack, REAL_COREPACK_ASSET,
    "Downloading corepack on first use…");
}

// ── File-operation helpers (host Explorer: delete / copy / cut-paste) ────────
const errMsg = (err) => (err && err.message) || String(err);

// The sync fs bridge tags every VFS failure with the errno the Rust VFS raised
// ("ENOENT", "EEXIST", …; see packages/kernel-host/kernel-fs.js). Forward it so the
// SDK can throw a VivariError the caller can discriminate on instead of a bare
// message string.
const errCode = (err) => (err && err.code) || undefined;
// Raise the errno the VFS would have raised, for the strict-mode checks the VFS
// itself can't make (it only implements the recursive/forgiving variants).
function fsError(code, syscall, path) {
  const err = new Error(`${code}: ${syscall} '${path}'`);
  err.code = code;
  return err;
}
const replyErr = (reqId, err) =>
  post("vv-reply", { reqId, ok: false, error: errMsg(err), code: errCode(err) });
const replyNotReady = (reqId) =>
  post("vv-reply", { reqId, ok: false, error: "kernel not ready", code: "ERR_NOT_READY" });
// `kind` follows Node's fs.watch vocabulary: "rename" when an entry appears,
// disappears or moves, "change" when existing contents are edited in place.
const postFsChanged = (path, kind) => post("vv-fs-changed", { path, kind });

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

// ── Python language service (jedi/black) ─────────────────────────────────────
// A long-lived interpreter for the editor, in the same category as the FS and
// fetcher workers: a nested Worker created here, NEVER through createProcess, so
// it is absent from kernel.procs and therefore from `ps` and diagnostics(). See
// workers/python-lsp-worker.ts for why it cannot be a process.
//
// Created on the FIRST request rather than at boot. Pyodide is ~30 MB and the
// overwhelming majority of sessions never open a .py file; the worker module
// itself is a dynamic import so its bundle is not in the boot path either.

// jedi reads .py and .pyi; nothing else in a project or a wheel affects what it
// can answer. Skipping the rest is not an optimisation so much as the difference
// between shipping a package's source and shipping its compiled artifacts.
const PY_SOURCE_RE = /\.pyi?$/;
const PY_SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".pytest_cache", "dist", "build", ".mypy_cache"]);
// A project plus its installed packages. numpy alone is ~400 files; a scientific
// stack with a few libraries is the case this has to hold without becoming the
// reason the editor is slow.
const PY_MAX_FILES = 20_000;
const PY_MAX_BYTES = 40_000_000;
// The store's path inside the project, and where the interpreter expects to find
// it. Kept in step with builtins/python-lsp.js, which maps definitions back the
// other way; the offline spike holds the two together.
const PY_STORE_REL = ".venv/lib/python3.14/site-packages";
const PY_INTERP_SITE = "/lib/python3.14/site-packages";

let pyLspWorker = null;
let pyLspSeq = 1;
const pyLspPending = new Map();
// path -> length, so a re-send only carries what changed. Length rather than a
// hash because reading the file to hash it is the cost being avoided.
const pyLspSent = new Map();

function pythonLspWorker() {
  if (pyLspWorker) return pyLspWorker;
  pyLspWorker = new Worker(new URL("./python-lsp-worker.ts", import.meta.url), {
    type: "module",
    name: "Python Language Service",
  });
  pyLspWorker.onmessage = (event) => {
    const m = event.data;
    if (m.type === "state") {
      // Not a reply to anything — the editor subscribes to this so the status bar
      // can say "starting…" during a boot nobody explicitly asked for.
      post("py-lsp-state", { state: m.state, detail: m.detail || "" });
      return;
    }
    if (m.type !== "py-lsp-reply") return;
    const pending = pyLspPending.get(m.id);
    if (!pending) return;
    pyLspPending.delete(m.id);
    pending(m);
  };
  pyLspWorker.onerror = (e) => {
    // A worker that died takes its interpreter with it. Say so, and let the next
    // request build a new one rather than hanging on a worker that is gone.
    post("py-lsp-state", { state: "failed", detail: (e && e.message) || "the language service worker stopped" });
    for (const [, pending] of pyLspPending) pending({ ok: false, error: "the language service worker stopped" });
    pyLspPending.clear();
    pyLspWorker = null;
    pyLspSent.clear();
  };
  return pyLspWorker;
}

/**
 * The project's Python sources, plus the .py/.pyi inside its package store,
 * addressed as the INTERPRETER will see them. Only what changed since the last
 * call is returned: re-sending a tree per keystroke costs the same as no cache.
 *
 * The store is remapped to the interpreter's own site-packages, which is where
 * an import looks — the same move builtins/python-store.js makes for a process,
 * and the inverse of hostPathFor() in builtins/python-lsp.js, which turns a
 * definition back into a file the editor can open.
 */
function collectPython(root) {
  const files = [];
  const seen = new Set();
  let bytes = 0;
  let truncated = false;
  const rootClean = String(root || "").replace(/\/+$/, "");
  if (!kernel || !rootClean) return { files, removed: [], truncated };

  const take = (hostPath, interpPath) => {
    if (truncated || seen.has(interpPath)) return;
    let size = 0;
    try { size = kernel.stat(hostPath).size | 0; } catch { return; }
    seen.add(interpPath);
    if (pyLspSent.get(interpPath) === size) return; // unchanged — do not read it
    let content;
    try { content = kernel.readFile(hostPath); } catch { return; }
    if (typeof content !== "string") return;
    files.push([interpPath, content]);
    pyLspSent.set(interpPath, size);
    bytes += content.length;
    if (files.length >= PY_MAX_FILES || bytes >= PY_MAX_BYTES) truncated = true;
  };

  const walk = (hostDir, interpDir, depth) => {
    if (truncated || depth > 24) return;
    let names;
    try { names = kernel.readdir(hostDir); } catch { return; }
    for (const name of names) {
      if (PY_SKIP_DIRS.has(name)) continue;
      const host = hostDir + "/" + name;
      const interp = interpDir + "/" + name;
      let kind;
      try { kind = kernel.stat(host).kind; } catch { continue; }
      if (kind === "dir") {
        // .venv is walked SEPARATELY, remapped onto site-packages. Walking it
        // here as well would put every wheel at a path no import resolves, and
        // pay for the bytes twice.
        if (depth === 0 && name === ".venv") continue;
        walk(host, interp, depth + 1);
      } else if (PY_SOURCE_RE.test(name)) {
        take(host, interp);
      }
    }
  };

  walk(rootClean, rootClean, 0);
  try {
    if (kernel.exists(rootClean + "/" + PY_STORE_REL)) {
      walk(rootClean + "/" + PY_STORE_REL, PY_INTERP_SITE, 1);
    }
  } catch { /* no store yet — the common case before a first pip install */ }

  // Anything previously sent that is no longer there. Without this, deleting a
  // module leaves jedi completing against a file the user has removed.
  const removed = [];
  for (const interpPath of pyLspSent.keys()) {
    if (!seen.has(interpPath)) {
      removed.push(interpPath);
      pyLspSent.delete(interpPath);
    }
  }
  return { files, removed, truncated };
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
    // Default on: only an explicit `compress: false` (BootOptions.compress) disables it.
    vfsCompression = m.compress !== false;
    // `error` (not just `log`) so the SDK's boot() has something to reject on —
    // otherwise a kernel that dies here never posts `ready` and the caller waits
    // out its whole timeout with no idea why.
    boot().catch((err) => {
      post("log", { line: "kernel worker boot failed: " + err, stream: "stderr" });
      post("error", { message: "kernel worker boot failed: " + errMsg(err), fatal: true });
    });
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

  // Breakpoint debugger: a CDP command (JSON string) from the studio for a target
  // process. The kernel routes it over postMessage (running) or the debug SAB
  // (paused).
  if (m.type === "dbg-cmd") {
    if (kernel) kernel.debugCommand(m.pid | 0, m.data);
    return;
  }

  // Breakpoint debugger: toggle debug mode. The kernel flag makes every debuggable
  // process a target immediately (even in shells opened before the toggle); the
  // local flag still seeds VV_DEBUG into newly opened terminals' env for guests
  // that read it.
  if (m.type === "vv-debug-mode") {
    debugMode = !!m.enabled;
    if (kernel) kernel.debugMode = debugMode;
    return;
  }

  // ── Interactive terminals ──────────────────────────────────────────────────
  // Open a new shell for a terminal tab. `demo` set = the "Run" button: scaffold
  // the project and auto-run its dev command in this shell (VV_RUN), so the server
  // lives in this tab.
  if (m.type === "term-open") {
    await openTerminal(m.terminalId, m.cwd, m.demo, m.run);
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
    if (!kernel) {
      if (m.reqId != null) replyNotReady(m.reqId);
      return;
    }
    try {
      const slash = m.path.lastIndexOf("/");
      if (slash > 0) kernel.mkdirp(m.path.slice(0, slash));
      const existed = kernel.exists(m.path);
      // `bytes` (a Uint8Array) is used for binary imports (dropped images /
      // files); `contents` (a string) for text edits. writeFile accepts either.
      kernel.writeFile(m.path, m.bytes ?? m.contents ?? "");
      if (m.reqId != null) post("vv-reply", { reqId: m.reqId, ok: true });
      postFsChanged(m.path, existed ? "change" : "rename");
    } catch (err) {
      post("log", { line: "[edit] write failed: " + errMsg(err), stream: "stderr" });
      if (m.reqId != null) replyErr(m.reqId, err);
    }
    return;
  }

  // ── live runtime diagnostics (the page exposes this as __vv.diag()) ──
  // Deliberately cheap and side-effect free, so it is safe to call repeatedly while
  // something is stuck. Combines the kernel's per-process liveness with the VFS size
  // and per-worker heaps, which is enough to tell "slow" from "wedged" from "out of
  // memory" without access to the machine.
  if (m.type === "vv-diag") {
    if (!kernel) { post("vv-reply", { reqId: m.reqId, ok: false, error: "kernel not ready" }); return; }
    const diag = kernel.diagnostics();
    Promise.all([queryVfsMem(), queryAllProcMem()])
      .then(([vfs, procMem]) => {
        const byPid = new Map((procMem || []).map((r) => [r.pid, r]));
        for (const p of diag.procs) {
          const mem = byPid.get(p.pid);
          if (mem) {
            p.heapBytes = mem.heap;
            p.modules = mem.modules;
            // What is keeping this process's event loop alive, handle by handle —
            // the difference between "wedged on a syscall" and "finished, but still
            // ref'd by an open handle it never closed".
            if (mem.alive) p.alive = mem.alive;
          }
          p.terminalId = terminalForPid(p.pid) ?? null;
        }
        post("vv-reply", { reqId: m.reqId, ok: true, diag: { ...diag, vfs } });
      })
      .catch((err) => post("vv-reply", { reqId: m.reqId, ok: false, error: errMsg(err) }));
    return;
  }

  // ── VFS queries for the multi-root Explorer (request/response via vv-reply) ──
  if (m.type === "vv-readdir") {
    if (!kernel) { replyNotReady(m.reqId); return; }
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
      replyErr(m.reqId, err);
    }
    return;
  }
  if (m.type === "vv-read") {
    if (!kernel) { replyNotReady(m.reqId); return; }
    try {
      post("vv-reply", { reqId: m.reqId, ok: true, path: m.path, contents: kernel.readFile(m.path) });
    } catch (err) {
      replyErr(m.reqId, err);
    }
    return;
  }
  // Raw bytes for binary files (images) so the editor's image viewer gets an
  // uncorrupted buffer — readFile decodes to a JS string, which mangles binary.
  if (m.type === "vv-read-bytes") {
    if (!kernel) { replyNotReady(m.reqId); return; }
    try {
      const bytes = kernel.readFileBytes(m.path);
      post("vv-reply", { reqId: m.reqId, ok: true, path: m.path, bytes });
    } catch (err) {
      replyErr(m.reqId, err);
    }
    return;
  }
  // Existence + kind check used to validate a new project's target directory, and
  // the backing call for the SDK's fs.stat/fs.exists. `exists: false` is a normal
  // answer (not an error) so `exists()` needn't catch; the VFS metadata rides along
  // so `stat()` can report size/mtime without a second round-trip.
  if (m.type === "vv-stat") {
    if (!kernel) { post("vv-reply", { reqId: m.reqId, ok: true, exists: false, isDir: false }); return; }
    try {
      if (!kernel.exists(m.path)) { post("vv-reply", { reqId: m.reqId, ok: true, exists: false, isDir: false }); return; }
      const st = kernel.stat(m.path);
      post("vv-reply", {
        reqId: m.reqId, ok: true, exists: true, isDir: st.kind === "dir",
        size: st.size, mtimeMs: st.mtimeMs, mode: st.mode, ino: st.ino,
      });
    } catch (err) {
      replyErr(m.reqId, err);
    }
    return;
  }
  // `recursive: false` asks for POSIX mkdir semantics (parents must exist, EEXIST if
  // the target already does). The VFS only implements mkdirp, so enforce the strict
  // variant here rather than accepting the option and quietly ignoring it.
  if (m.type === "vv-mkdirp") {
    if (!kernel) { replyNotReady(m.reqId); return; }
    try {
      if (m.recursive === false) {
        const slash = m.path.replace(/\/+$/, "").lastIndexOf("/");
        const parent = slash > 0 ? m.path.slice(0, slash) : "/";
        if (!kernel.exists(parent)) throw fsError("ENOENT", "mkdir", m.path);
        if (kernel.stat(parent).kind !== "dir") throw fsError("ENOTDIR", "mkdir", m.path);
        if (kernel.exists(m.path)) throw fsError("EEXIST", "mkdir", m.path);
      }
      kernel.mkdirp(m.path);
      post("vv-reply", { reqId: m.reqId, ok: true });
      postFsChanged(m.path, "rename");
    } catch (err) {
      replyErr(m.reqId, err);
    }
    return;
  }

  // Silent fs RPC for main-thread git (isomorphic-git via studio/src/vv/git-fs.ts).
  // One message dispatched by `op`, mapping straight onto the kernel's sync fs
  // (SAB → FS worker). It deliberately does NOT broadcast `vv-fs-changed`: a single
  // commit writes hundreds of `.git/objects` entries, and storming the Explorer /
  // watchers on each would jank the UI. The SCM session refreshes the working tree
  // explicitly after a checkout/discard, which is the only time the workdir changes.
  if (m.type === "vv-git-fs") {
    if (!kernel) { post("vv-reply", { reqId: m.reqId, ok: false, error: "kernel not ready", code: "ENOENT" }); return; }
    const fs = kernel.fs;
    const a = m.args || {};
    try {
      let result: unknown = null;
      switch (m.op) {
        case "readFile": result = fs.readFileBytes(a.path); break;
        case "writeFile": {
          const slash = a.path.lastIndexOf("/");
          if (slash > 0) fs.mkdirp(a.path.slice(0, slash));
          fs.writeFile(a.path, a.bytes ?? a.contents ?? "");
          break;
        }
        case "unlink": fs.unlink(a.path); break;
        case "readdir": result = fs.readdir(a.path); break;
        case "mkdir": fs.mkdirp(a.path); break;
        case "rmdir": fs.rmdir(a.path); break;
        case "stat": result = fs.stat(a.path); break;
        case "lstat": result = fs.lstat(a.path); break;
        case "readlink": result = fs.readlink(a.path); break;
        case "symlink": fs.symlink(a.target, a.path); break;
        default:
          post("vv-reply", { reqId: m.reqId, ok: false, error: "unknown git-fs op: " + m.op });
          return;
      }
      post("vv-reply", { reqId: m.reqId, ok: true, result });
    } catch (err) {
      post("vv-reply", { reqId: m.reqId, ok: false, error: errMsg(err), code: (err && err.code) || "" });
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
      postFsChanged(dir, "rename");
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
  // Ensure a reopened project's node_modules is present. It's no longer mirrored
  // file-by-file (fs-worker shouldPersist), so on reopen it's restored from the
  // dependency-cache snapshot (one blob) instead — no re-install. No-op if deps
  // are already on disk or there's no matching snapshot (the run flow then installs).
  if (m.type === "vv-ensure-deps") {
    if (!kernel) { post("vv-reply", { reqId: m.reqId, ok: false, error: "kernel not ready" }); return; }
    (async () => {
      const dir = String(m.dir || "").replace(/\/+$/, "");
      try {
        if (!dir || kernel.exists(dir + "/node_modules")) {
          post("vv-reply", { reqId: m.reqId, ok: true, restored: false });
          return;
        }
        const restored = await tryRestoreDeps(dir, detectPm(dir));
        post("vv-reply", { reqId: m.reqId, ok: true, restored });
      } catch (err) {
        post("vv-reply", { reqId: m.reqId, ok: false, error: errMsg(err) });
      }
    })();
    return;
  }

  // Bulk-read a project's source tree (export as zip / shareable URL). Walks the
  // root in-worker — one reply instead of thousands of per-file vv-read-bytes
  // round-trips — excluding node_modules/.git and bounded by file count + bytes.
  // Returns [{ path (relative to root), bytes }] plus a `truncated` flag.
  if (m.type === "vv-read-tree") {
    if (!kernel) { replyNotReady(m.reqId); return; }
    try {
      const root = String(m.root || "").replace(/\/+$/, "");
      // `strict` is the SDK's export(): a missing root is an error, not an empty
      // archive. The studio's own export tolerates it (it walks what it can).
      if (m.strict && !kernel.exists(root || "/")) throw fsError("ENOENT", "export", m.root);
      const skip = new Set(["node_modules", ".git", ...(Array.isArray(m.exclude) ? m.exclude : [])]);
      const MAX_FILES = 20000;
      const MAX_BYTES = 64 * 1024 * 1024;
      const files: { path: string; bytes: Uint8Array }[] = [];
      let bytes = 0;
      let truncated = false;
      // `dir` is "" at the VFS root so the joins below produce "/name", not "//name".
      const walk = (dir: string, rel: string) => {
        if (truncated) return;
        let names: string[];
        try { names = kernel.readdir(dir || "/"); } catch { return; }
        for (const name of names) {
          if (truncated) return;
          if (skip.has(name)) continue;
          const abs = dir + "/" + name;
          const relPath = rel ? rel + "/" + name : name;
          let st;
          try { st = kernel.stat(abs); } catch { continue; }
          if (st.kind === "dir") {
            walk(abs, relPath);
          } else if (st.kind === "file") {
            let b: Uint8Array;
            try { b = kernel.readFileBytes(abs); } catch { continue; }
            files.push({ path: relPath, bytes: b });
            bytes += b.byteLength;
            if (files.length >= MAX_FILES || bytes >= MAX_BYTES) { truncated = true; return; }
          }
        }
      };
      if (kernel.exists(root || "/")) walk(root, "");
      post("vv-reply", { reqId: m.reqId, ok: true, files, truncated });
    } catch (err) {
      replyErr(m.reqId, err);
    }
    return;
  }

  // Bulk-write an imported tree (folder import / shared-project load) into `dir`
  // in one batch. `files` is [{ path (relative to dir), bytes }].
  if (m.type === "vv-import-tree") {
    if (!kernel) { replyNotReady(m.reqId); return; }
    try {
      const dir = String(m.dir || "").replace(/\/+$/, "");
      if (dir) kernel.mkdirp(dir);
      // Empty directories carry meaning in a mounted tree (and writeFilesBatch only
      // creates the parents its files need), so materialise them explicitly first.
      for (const d of Array.isArray(m.dirs) ? m.dirs : []) {
        kernel.mkdirp(dir + "/" + String(d).replace(/^\/+/, ""));
      }
      const incoming = Array.isArray(m.files) ? m.files : [];
      const batch = incoming
        .filter((f) => f && typeof f.path === "string")
        .map((f) => ({ path: dir + "/" + String(f.path).replace(/^\/+/, ""), bytes: f.bytes ?? f.contents ?? "" }));
      if (batch.length) await kernel.writeFilesBatch(batch);
      post("vv-reply", { reqId: m.reqId, ok: true, count: batch.length });
      postFsChanged(dir || "/", "rename");
    } catch (err) {
      replyErr(m.reqId, err);
    }
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

  // ── Python language service ────────────────────────────────────────────────
  // One request, one reply. The worker is created on the first of these and then
  // kept — see pythonLspWorker(). Superseded requests are dropped on the STUDIO
  // side (builtins/python-lsp.js createRequestQueue): Pyodide cannot be
  // interrupted mid-call, so cancellation here would only mean discarding an
  // answer, which is exactly what the queue already does closer to the keystroke.
  if (m.type === "vv-py-lsp") {
    if (!kernel) { replyNotReady(m.reqId); return; }
    try {
      const worker = pythonLspWorker();
      const id = pyLspSeq++;
      pyLspPending.set(id, (reply) => {
        post("vv-reply", {
          reqId: m.reqId,
          ok: !!reply.ok,
          result: reply.result ?? null,
          error: reply.error || "",
        });
      });
      // Fresh project state rides along with the request. The editor sends the
      // ACTIVE buffer's text inside req.code, so unsaved edits to the file being
      // typed in are always seen; this is for its siblings and its packages.
      const { files, removed, truncated } = collectPython(m.root || "");
      worker.postMessage({
        type: "py-lsp-request",
        id,
        req: m.req,
        indexUrl: vendorUrl("vendor/pyodide/"),
        // For the `lint` op, which is answered by ruff's wasm and never reaches
        // the interpreter the indexUrl above points at.
        ruffUrl: vendorUrl("vendor/ruff/"),
        files,
        removed,
      });
      if (truncated) {
        post("py-lsp-state", {
          state: "ready",
          detail: "project too large to index fully; completions may be incomplete",
        });
      }
    } catch (err) {
      post("vv-reply", { reqId: m.reqId, ok: false, error: errMsg(err) });
    }
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
          postFsChanged(file, "change");
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
            postFsChanged(file, "change");
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
      if (m.reqId != null) replyNotReady(m.reqId);
      return;
    }
    try {
      if (m.type === "vv-rename") kernel.rename(m.from, m.to);
      // `force`/`recursive` default to the forgiving behaviour the Explorer wants;
      // the SDK passes them explicitly to get Node's stricter `fs.rm` contract.
      else if (m.type === "vv-rm") {
        const exists = kernel.exists(m.path);
        if (!exists) {
          if (m.force === false) throw fsError("ENOENT", "rm", m.path);
        } else if (m.recursive === false && kernel.stat(m.path).kind === "dir") {
          if (kernel.readdir(m.path).length) throw fsError("ENOTEMPTY", "rm", m.path);
          kernel.rmdir(m.path);
        } else {
          rmRecursive(m.path);
        }
      }
      else copyRecursive(m.from, m.to);
      post("vv-fs-result", { op, ok: true, from: m.from, to: m.to, path: m.path });
      postFsChanged(m.to || m.path, "rename");
      // The SDK fs facade correlates by reqId; the studio Explorer keys off the
      // vv-fs-result above. Both are emitted so neither path is disturbed.
      if (m.reqId != null) post("vv-reply", { reqId: m.reqId, ok: true });
    } catch (err) {
      post("vv-fs-result", { op, ok: false, error: errMsg(err), from: m.from, to: m.to, path: m.path });
      if (m.reqId != null) replyErr(m.reqId, err);
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