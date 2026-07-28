---
sidebar_position: 6
title: How it works
---

# How it works

## The load-bearing trick: blocking on a worker

Node's APIs (`fs.readFileSync`, `require()`, …) are **synchronous**. Browsers
don't let you block on async work, *except on a Web Worker thread*, where
`Atomics.wait()` can genuinely park execution. So a `readFileSync` call inside
the VM parks the worker until the host answers over a `SharedArrayBuffer`:

```
user code (Web Worker)
   |  fs.readFileSync("/x")   <- looks synchronous
   v
SharedArrayBuffer  -- request -->  Host (main thread)
   ^                                  |  Rust/Wasm VFS lookup
   +------ Atomics.notify <-----------+
   v
returns bytes, still synchronous
```

`Atomics` (and thus `SharedArrayBuffer`) only work under **cross-origin
isolation**, which is why Vivari requires the COOP/COEP headers.

## The pieces

1. **VFS (Rust → Wasm).** An in-RAM POSIX-ish virtual filesystem: directory
   tree, `stat`/`lstat`, symlinks, `rename`, errno errors. Mirrored to OPFS so
   projects persist across reloads.
2. **The kernel.** A supervisor that owns the VFS and a PID table. It services
   syscalls and spawns each command as its own worker/process. A parent blocks
   on a child through `execSync` over the same Atomics bridge.
3. **The runtime shim.** Runs inside each process worker: a synchronous
   CommonJS loader (`require` + `node_modules` resolution) plus core builtins
   (`fs`, `path`, `process`, `os`, `http`, `child_process`, …).
4. **Virtual networking.** A `http.createServer().listen()` runs inside a worker;
   a **Service Worker** intercepts `/preview/<port>/…` and turns each iframe
   request into an in-VM HTTP call, with no network involved.

## Dependency caching

`node_modules` is snapshotted **keyed by the lockfile**, so opening a template
you've built before (or a second project with the same deps) restores
`node_modules` from disk instead of re-running `npm install`.

## Portability

Projects can leave the browser and come back, all client-side: **export** a
project as a `.zip`, **import** a local folder, **import a public GitHub repo or
npm package** (fetched directly via CORS), and **share** a project as a
self-contained compressed link.