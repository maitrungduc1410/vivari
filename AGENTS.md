# AGENTS.md

Guidance for AI agents (and humans) working in this repo. Read this first, then
read [`ARCHITECTURE.md`](./ARCHITECTURE.md) before touching the runtime, the
protocol, or networking. [`roadmap.md`](./roadmap.md) is the chronological log of
what was built and *why* — search it before assuming something is missing.

---

## What this project is

OpenContainer is an open-source **WebContainer**: it runs Node-style projects
(Vite + HMR, React, NestJS, Express, `npm install`, `tsc`) **entirely in the
browser tab**, with no backend doing the work. The filesystem, a Node-compatible
runtime, a process/PID model, and TCP-style networking are all emulated across
Web Workers.

The guiding philosophy is **run the real thing**: we vendor Node's actual
`lib/*.js` on a small binding layer, run unmodified npm packages from disk, and
drive real tools (rolldown/Vite, `tsc`, Babel) in-VM. When something breaks, the
fix is almost always "make our emulation match real Node," not "special-case the
tool."

For the full mental model (worker topology, syscall protocol, networking seams,
event loop, native Wasm), read **[`ARCHITECTURE.md`](./ARCHITECTURE.md)**.

---

## Folder structure

```
packages/
  kernel/          Rust → Wasm VFS (inode tree, stat/symlink/rename, errno).
  codec/           Rust → Wasm zlib/deflate core (beneath lib/zlib.js).
  crypto/          Rust → Wasm crypto core (beneath lib/crypto.js).
  wasi-demo/       Rust → wasm32-wasip1 CLI to exercise the WASI layer.

  protocol/
    syscall.js     THE worker↔host ABI over one SharedArrayBuffer. 1 MiB window.
                   Single source of truth for the wire format + opcodes.

  kernel-host/     The supervisor (environment-agnostic).
    kernel.js      PID table, spawn/kill/waitpid, net port registry,
                   HTTP request routing, OP_RESPOND reassembly.
    fs-server.js   FsServer: owns the one VFS, services fs opcodes over each SAB.
    kernel-fs.js   kernel-side sync fs helper.
    coreutils.js   echo/cat/ls/pwd/... + a small `sh`.
    opfs-persistence.js  write-behind mirror of the VFS to OPFS (survives reload).
    programs/npm.js      from-scratch npm installer (resolve, tarball, hoist).

  runtime/         The Node runtime that runs INSIDE each process worker.
    index.js       createRuntime(): wires builtins/globals/http-bridge/ws + run().
    module.js      synchronous CommonJS loader (require + resolution).
    esm.js         ESM→CJS transpiler (import/export → sync CJS).
    loop.js        the per-process event loop (nextTick→micro→timers→immediate).
    boot.js        process bootstrap shared by browser + Node worker entries.
    fs-client.js   env-agnostic Atomics syscall client (the caller side).
    websocket.js   in-VM WebSocket client (used by the HMR tunnel).
    builtins/      hand-written: process, os, assert, child_process.
    node/
      lib/         Node's REAL vendored lib/*.js (fs, net, http, stream, ...).
      internal/    Node's REAL internal/* (streams, errors, validators, ...).
      bindings/    our internalBinding shims (fs, tcp_wrap, zlib, crypto, ...).
      internal-binding.js / primordials.js / loader.js   glue for the above.

  demo/            Browser wiring (dev, loaded as raw ES modules).
    host.js            main thread: UI, SW registration, request relay.
    kernel-worker.js   hosts the Kernel; DEMOS registry + startDemo().
    fs-worker.js       hosts the File System Worker (VFS + OPFS).
    fetcher-worker.js  outbound fetch() (npm downloads).
    process-worker.js  one process = one worker (boots the runtime).
    sw.js              preview Service Worker (fetch → kernel → in-VM server).
    index.html         terminal / preview / editor layout + demo selector.
  demo-dist/       GITIGNORED esbuild bundle of demo/ (one file per worker role).

scripts/
  verify-node.mjs      headless end-to-end proof (no browser).
  verify-express.mjs   installs+runs real Express/Vite/ws (needs network).
  probe-*.mjs          framework discovery/regression probes (react/nest/next).
  process-worker.mjs / fs-worker.mjs   Node worker_threads entries for headless.
  build-demo.mjs       bundles demo/ → demo-dist/ with esbuild.

server.mjs             static dev server that sends the COOP/COEP headers.
README.md · roadmap.md · research.md · ARCHITECTURE.md · AGENTS.md
```

---

## Golden rules

1. **Cross-origin isolation is mandatory.** `SharedArrayBuffer`/`Atomics` need
   `COOP: same-origin` + `COEP: require-corp`. `server.mjs` sends them; don't
   serve the demo another way and expect it to work.
2. **Prefer matching real Node over special-casing.** We vendor Node's `lib/`. If
   a framework crashes, the usual root cause is a missing/incorrect
   `internalBinding` shim or `internal/*` export — fix that, not the framework.
3. **Sync all the way down.** The runtime is synchronous because the fs under it
   is synchronous (Atomics.wait). Don't introduce `await` into the require/resolve
   path.
4. **The protocol is the contract.** `packages/protocol/syscall.js` is shared by
   the caller (`fs-client.js`), the FS worker (`fs-server.js`), and the kernel
   (`kernel.js`). Change all sides together and update the format comment.
5. **Keep the main thread empty.** No kernel/user work runs on the main thread —
   it only does UI + message relay. Put work in the right worker.
6. **`demo-dist/` is generated.** Never hand-edit it; edit `demo/` and rebuild.
7. **Keep the docs in sync.** These four files are the project's memory — update
   the relevant one(s) in the *same* change, never in a "later" pass:
   - `AGENTS.md` — when a workflow, folder, rule, or gotcha changes (especially:
     hit a new recurring bug class → add it to "Critical gotchas").
   - `ARCHITECTURE.md` — when you change the protocol, worker topology, runtime,
     networking, filesystem, or any structural behavior.
   - `roadmap.md` — when a feature's status changes or you make a notable
     decision/finding (it's the chronological "why" log).
   - `research.md` — when you gather new background research.
   If a change touches several areas, update several docs. Out-of-date docs are
   worse than none, because agents trust them.
8. **Only commit when asked.** And never commit build artifacts (`demo-dist/`,
   `pkg/`, `pkg-node/` are gitignored) or secrets.

---

## Critical gotchas (these have bitten us repeatedly)

### The 1 MiB SAB window — internalize this one
`DATA_BYTES = 1 << 20`. **Every syscall request AND response must fit in 1 MiB.**
`fs-client.call()` throws `"syscall request too large"` past it. Symptoms of
violating it: a request that **hangs** and eventually 504s, or a "too large"
throw that gets swallowed. Rules:
- **Never** put an unbounded payload (a whole file, a whole HTTP body) in one
  syscall field.
- Large **files** transfer in `FD_CHUNK` (512 KiB) pieces via the fd loop in
  `lib/fs.js`; `writeLarge` uses a transferred `ArrayBuffer` instead.
- Large **HTTP responses** cross as a **raw** length-prefixed body field (NOT
  JSON-stringified — escaping overflows) and are chunked into frames the kernel
  reassembles by `reqId` (`fs-client.respond` + `kernel.handleRespond`).
- **Downloads** (`OP_FETCH`) stream straight into the VFS, bypassing the window.
- If you add a syscall that can carry big data, chunk it from day one.

### Never silently swallow a syscall throw
`bridgeHttp`'s `reply()` once wrapped `respond()` in a bare `try/catch`, so a
"too large" throw turned into a silent hang. Any catch around a syscall must
**fail the pending operation**, not drop it.

### Missing error constructors → "X is not a constructor"
Node's `lib/` destructures error classes from `internal/errors` eagerly but only
*constructs* them on error paths (socket close, `EADDRINUSE`, stream destroyed).
If a class is undefined you get a cryptic minified `TypeError: Je is not a
constructor` the first time that path runs. When you add a `lib/` module, make
sure every `ERR_*` / `*Exception*` it references is exported from
`node/internal/errors.js` (stream, http, and net families are all there now).

### ESM ↔ CJS interop
`esm.js` transpiles ESM to our sync CJS. Two traps already handled — respect them:
- Generated identifiers are namespaced `__oc_*` (`__oc_exports`, `__oc_module`,
  `__oc_require`, …) so user code declaring `module`/`exports`/`require` doesn't
  collide (`import module from "node:module"` used to throw "Identifier already
  declared"). Don't reintroduce bare names into the wrapper.
- Bundler CJS-interop conventions matter: `export { X as "module.exports" }` means
  `require()` returns `X` directly; `export { X as default }` sets
  `exports.default`. Getting these wrong yields `TypeError: x is not a function`
  on a plugin's default export.

### `self` is a getter in a real Worker
Third-party bundles (Vite/rolldown workers) do `Object.assign(globalThis, {self})`,
which throws in a real Worker where `self` is a getter-only accessor. `process-
worker.js` shadows it with a writable own property. Keep that shim.

### Node version-gated APIs
Tools call newish Node APIs. We've had to add e.g. `crypto.hash()` (Node 20.12+).
When a tool fails with `X is not a function`, check whether it's a recent Node
addition and implement it in the matching `lib/`/binding.

### TypeScript / native-binary walls
- Pin `typescript@5` for in-VM `tsc`: **`typescript@7` is the native Go compiler**
  and won't run.
- **Next.js is a hard wall** (documented in roadmap): Next 16 requires native SWC
  (no wasm fallback) + native Turbopack. Vite (rolldown, wasm) is the supported
  bundler path.

### Ports & long-lived servers
Each demo binds a port; a leftover long-lived server squatting a port causes
`EADDRINUSE` for the next demo. The kernel worker's `boot()` deliberately does
**not** auto-run any server — demos are started on demand via the `DEMOS` registry
/ `startDemo(id)`. Don't reintroduce a background server into `boot()`.

### OPFS persistence
The VFS mirrors to OPFS and **survives reload**. If a demo behaves as if old files
linger, that's why — use `?reset` on the demo URL to wipe it. Restore happens
before any syscall is served.

---

## Testing & verification

The runtime runs headless under Node `worker_threads`, so validate without a
browser first.

- `npm run verify` — `scripts/verify-node.mjs`, headless end-to-end (fs, process,
  shell, http, timers, watch). **Run this after any runtime/protocol change.** No
  network needed.
- `node scripts/verify-express.mjs` — installs + runs real Express, esbuild-wasm,
  a Vite build, Vite dev+HMR, and a real `ws` server. **Needs network** (npm).
- `node scripts/probe-react.mjs` / `probe-nest.mjs` — regression probes for the
  React+Vite+Compiler and NestJS demos (need network for install).
- Browser smoke test: `npm run dev`, open
  `http://localhost:8080/packages/demo/index.html`, run a demo from the selector,
  check the terminal log + preview iframe. For the bundled path, `npm run
  build:demo` and open `packages/demo-dist/index.html`.

When you add a Node API or a binding, add/extend a probe or a `verify-*` case so
the gap can't silently regress.

---

## Common workflows

- **Fix a framework crash**: reproduce headless with a `probe-*.mjs` (copy an
  existing one), read the minified stack to the offending `lib/`/binding, implement
  the missing piece in `runtime/node/`, re-run the probe + `npm run verify`.
- **Add a demo**: extend the `DEMOS` registry in `demo/kernel-worker.js` (files,
  deps, optional build step, run command, `hmr` flag) and add it to the selector in
  `index.html`/`host.js`.
- **Change the syscall ABI**: edit `protocol/syscall.js` (+ its format comment) and
  update all three sides (`fs-client.js`, `fs-server.js`, `kernel.js`) together.
- **Ship a bundle**: `npm run build:demo` (regenerates `demo-dist/`, stamps a new
  `BUILD_ID` so the SW precache re-versions).

---

## Where to look next

- **How it works** → [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- **Why it was built this way / status per feature** → [`roadmap.md`](./roadmap.md)
- **Background research** → `research.md`
