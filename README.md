# Vivari

An open-source **WebContainer** — the goal is to run Node-style projects (Vite,
Express, etc.) **100% inside the browser**, StackBlitz-style: a virtual filesystem,
a Node-compatible runtime, and virtual networking, with no server doing the work.

This repo is being built brick by brick (see `roadmap.md`). **Bricks #1–#5 are
done**: the synchronous FS bridge (the load-bearing primitive everything else
stands on), a real POSIX-ish VFS core (directory tree, stat/lstat, symlinks,
rename, errno errors), a Node runtime shim (synchronous CommonJS `require` with
node_modules resolution + core builtins like `fs`, `path`, `process`), a process
model with a kernel + PID table + a shell (each command is its own worker/process,
parents block on children via `execSync`), and virtual networking — a real
`http.createServer().listen()` runs inside a worker and a Service Worker previews
it in an iframe with no network involved.

## Why brick #1 matters

Node's APIs (`fs.readFileSync`, `require()`, ...) are *synchronous*. Browsers
don't let you block on async work — **except on a Web Worker thread**, where
`Atomics.wait()` can genuinely park execution. So:

```
user code (Web Worker)
   │  fs.readFileSync("/x")   ← looks synchronous
   ▼
SharedArrayBuffer  ── request ──▶  Host (main thread)
   ▲                                  │  Rust/Wasm VFS lookup
   └────── Atomics.notify ◀───────────┘
   ▼
returns bytes, still synchronous
```

`Atomics` (and thus `SharedArrayBuffer`) only work under **cross-origin
isolation**, so the dev server sends `COOP: same-origin` + `COEP: require-corp`.

## Layout

```
packages/
  vfs/               Rust crate → Wasm. The in-RAM Virtual File System (VFS).
    src/lib.rs
    pkg/             generated (web target)     — `npm run build:vfs`
    pkg-node/        generated (nodejs target)  — `npm run build:vfs:node`
  protocol/
    syscall.js       the shared worker↔host ABI over SharedArrayBuffer
  kernel-host/       the supervisor (owns the VFS + process/PID table)
    kernel.js        Kernel: services syscalls, spawns processes (waitpid)
    coreutils.js     echo/cat/ls/pwd/mkdir/rm/node/true/false + the `sh` shell
  runtime/           the Node runtime shim (runs inside each process worker)
    fs-client.js     env-agnostic Atomics syscall client (fs + spawn)
    module.js        synchronous CommonJS loader (require + resolution)
    index.js         createRuntime(): wires builtins + globals + run(entry)
    boot.js          process bootstrap used by both env worker entries
    builtins/        fs, path, process, os, events, util, buffer, assert,
                     child_process, http
  core/              @vivari/core — the embeddable SDK (framework-agnostic)
    src/workers/     browser worker entries: kernel / fs / fetcher / process
    src/              Vivari (boot/mount/spawn), fs facade, process streams,
                     preview + the low-level KernelBridge transport
  react/             @vivari/react — <Vivari> component + useVivari() hook
  studio/            the React IDE (the app) — Vite + React + Tailwind
    src/vv/          IdeController + built-in templates (consumes @vivari/core)
    public/sw.js     preview Service Worker (fetch → kernel → virtual server)
scripts/
  process-worker.mjs Node worker entry for one process
  verify-node.mjs    headless end-to-end check (no browser needed)
  fixtures/          test fixtures (e.g. the napi-crc32 N-API addon)
```

## Run it

Prereqs: Rust + `wasm-pack`, and Node.

```bash
npm run build      # compile the Rust VFS to Wasm (web + node targets)
npm run verify     # headless proof the sync-bridge works end-to-end
npm run dev        # start the studio IDE (Vite dev server)
```

In the studio you'll see a shell script run where each command (`echo`,
`ls`, `node app.js`, ...) is its own worker/process with a PID, coordinated by the
kernel over a shared Rust VFS. A `node` process even spawns its own child via
`execSync` — the parent blocks on the child through the same Atomics bridge. Then
a `node /srv/server.js` process starts an HTTP server that stays alive, and the
right-hand pane previews it live through the Service Worker.

Projects persist across reloads (the VFS is mirrored to OPFS), and dependencies
are cached: `node_modules` is snapshotted **keyed by the lockfile**, so opening a
template you've built before (or a second project with the same deps) restores
`node_modules` from disk instead of re-running `npm install`.

Projects can also leave the browser and come back — all client-side: **export** any
project as a `.zip`, **import** a local folder as a new project (folder picker or
drag-and-drop onto Home), **import a public GitHub repo or an npm package** (fetched
directly in the browser via CORS), and **share** a project as a self-contained
compressed link (source is gzipped into the URL; opening it recreates the project).

## Embed it (SDK)

The same runtime that powers the studio is published as an embeddable SDK:

- **`@vivari/core`** — a clean, framework-agnostic API ([docs](packages/core/README.md)).
- **`@vivari/react`** — a `<Vivari>` component + `useVivari()` hook ([docs](packages/react/README.md)).

```ts
import { Vivari } from "@vivari/core";

const vivari = await Vivari.boot();
await vivari.mount({
  "package.json": { file: { contents: '{ "type": "module" }' } },
  "index.js": { file: { contents: "console.log('hello from the browser')" } },
});

const proc = await vivari.spawn("node", ["index.js"]);
proc.output.pipeTo(new WritableStream({ write: (c) => console.log(c) }));
await proc.exit;

// Run a dev server and preview it in an <iframe>:
vivari.on("server-ready", (port, url) => (iframe.src = url));
await vivari.spawn("npm", ["install"]);
await vivari.spawn("npm", ["run", "dev"]);
```

```tsx
import { Vivari } from "@vivari/react";

<Vivari files={tree} run="npm run dev" style={{ width: "100%", height: 480 }} />;
```

> Vivari needs a **cross-origin isolated** page (`COOP: same-origin` +
> `COEP: require-corp`) so `SharedArrayBuffer` is available. See the
> [core README](packages/core/README.md) for host + asset self-hosting notes.

A runnable, end-to-end example lives in [`examples/basic`](examples/basic) (boot →
mount → run a script → preview an in-VM server). `npm run smoke` guards the SDK's
public API + packaging offline.

Releases are cut from the manual **Publish SDK** GitHub Actions workflow
(`.github/workflows/publish.yml`).

## Roadmap

See `roadmap.md` for full status. Next up:

6. Migrate builtins to Node's real `lib/` on an `internalBinding` layer (Path B),
   ESM support, and real `npm install`.
