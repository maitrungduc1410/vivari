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
  demo/
    process-worker.js  browser worker entry for one process
    sw.js              preview Service Worker (fetch → kernel → virtual server)
    host.js            boots the Wasm VFS + Kernel, runs a shell + http server
    index.html         split terminal / preview layout
scripts/
  process-worker.mjs Node worker entry for one process
  verify-node.mjs    headless end-to-end check (no browser needed)
server.mjs           static dev server that sends the COOP/COEP headers
```

## Run it

Prereqs: Rust + `wasm-pack`, and Node.

```bash
npm run build      # compile the Rust VFS to Wasm (web + node targets)
npm run verify     # headless proof the sync-bridge works end-to-end
npm run dev        # then open http://localhost:8080/packages/demo/index.html
```

In the browser demo you'll see a shell script run where each command (`echo`,
`ls`, `node app.js`, ...) is its own worker/process with a PID, coordinated by the
kernel over a shared Rust VFS. A `node` process even spawns its own child via
`execSync` — the parent blocks on the child through the same Atomics bridge. Then
a `node /srv/server.js` process starts an HTTP server that stays alive, and the
right-hand pane previews it live through the Service Worker.

## Roadmap

See `roadmap.md` for full status. Next up:

6. Migrate builtins to Node's real `lib/` on an `internalBinding` layer (Path B),
   ESM support, and real `npm install`.
