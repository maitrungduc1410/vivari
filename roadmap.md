# OpenContainer — Roadmap

Built on the principle **de-risk the hardest part first**: prove the riskiest
primitive (synchronous cross-thread access to a shared kernel) before expanding.

Status: ✅ done · 🚧 in progress · ⏳ next · 🧊 later

---

## 🧱 Brick 1 — Synchronous FS Bridge ✅

The load-bearing primitive of the whole system: user code in a Web Worker calls a
**synchronous** `fs` API that actually crosses into the kernel via
`SharedArrayBuffer` + `Atomics`.

**Done:**
- `packages/kernel` — VFS written in Rust (`HashMap<path, bytes>`), compiled to
  Wasm (`wasm-pack`, two targets: `web` for the browser, `nodejs` for headless
  tests).
- `packages/demo/syscall.js` — shared worker↔host ABI over one SAB
  (control Int32 with STATE/OPCODE/REQ_LEN/RES_LEN + 1 MiB data region).
- `packages/demo/worker.js` — "user code" + synchronous `fs` facade
  (`readFileSync`, `writeFileSync`, `existsSync`, `readdirSync`) parking on
  `Atomics.wait`.
- `packages/demo/host.js` — loads the VFS Wasm, services syscalls,
  `Atomics.notify`.
- `server.mjs` — dev server sending COOP/COEP headers (enables SharedArrayBuffer).
- `scripts/verify-node.mjs` — headless end-to-end check (5/5 PASS).

**Current limitations (known, addressed in cross-cutting work):**
- One request at a time, a single worker.
- Kernel/VFS currently lives on the main thread (PoC), not yet a dedicated worker.
- VFS is a flat path→bytes map, no real directories/stat/symlinks.

---

## 🧱 Brick 2 — Real VFS Core ✅

Upgraded the VFS from a flat map to a POSIX-like filesystem.

**Done:**
- Inode table in Rust (`HashMap<u64, Inode>`); directories map names → inode ids
  via `BTreeMap` (readdir is sorted for free); symlinks store a target path.
- Path resolution walks from root with an inode stack (so `..` works), follows
  symlinks with an `ELOOP` guard (max depth 40); `stat` follows a trailing
  symlink, `lstat` does not.
- Syscalls: `read_file`, `write_file`, `mkdir` (+ recursive), `readdir`, `stat`,
  `lstat`, `unlink`, `rmdir`, `rename`, `symlink`, `readlink`, `exists`.
- `errno`-style errors (ENOENT, ENOTDIR, EISDIR, EEXIST, ENOTEMPTY, ELOOP,
  EINVAL) surfaced as thrown strings → JS `fs` facade builds Node-style errors
  with `err.code`.
- ABI grew to a multi-opcode table with a self-describing request frame
  (flags + length-prefixed fields) supporting multi-arg calls (rename, symlink).
- `fs` facade gained `mkdirSync`, `statSync`/`lstatSync` (with
  `isFile`/`isDirectory`/`isSymbolicLink`), `unlinkSync`, `rmdirSync`,
  `renameSync`, `symlinkSync`, `readlinkSync`.
- `scripts/verify-node.mjs`: 17/17 PASS (nested dirs, symlink follow, rename,
  errno behaviour).

**Deferred:** IndexedDB persistence across reloads (later).

---

## 🧱 Brick 3 — Node Runtime Shim ✅

Runs a user's JS project like real Node, synchronously, inside a worker.

**Done:**
- New `packages/runtime` (and ABI extracted to `packages/protocol`).
- CommonJS module system (`packages/runtime/module.js`): synchronous `require()`
  with a singleton cache, Node-style resolution (core builtins, relative/absolute
  with `.js`/`.json`, directory `index` + `package.json` "main", bare specifiers
  walked up through `node_modules`), the classic function wrapper via
  `new Function`, BOM/shebang stripping, `MODULE_NOT_FOUND`.
- Core builtins routed to the VFS via the sync bridge: `fs` (sync subset +
  Stats + Buffer/encoding semantics), `path` (POSIX), `process` (argv/env/cwd/
  chdir/exit/nextTick/hrtime/std streams), `os`, `events` (EventEmitter),
  `util` (format/inspect/inherits/promisify), `buffer` (minimal Buffer polyfill),
  `assert`, `module` (createRequire). `node:`-prefixed aliases supported.
- `createRuntime()` wires globals (`process`, `Buffer`, `console`, `global`,
  `setImmediate`) and exposes `run(entry)` returning the exit code.
- Env-agnostic syscall client (`fs-client.js`): host is nudged via an injected
  `notify` (postMessage in browser, parentPort in Node).
- Demo now seeds a multi-file project and runs `node /project/index.js`.
- `scripts/verify-node.mjs`: 14/14 PASS (relative/node_modules/JSON require,
  cache singleton, path/fs/Buffer, `process.exit` codes, MODULE_NOT_FOUND).

**Deferred:** ESM (`import`/`export`) — needs async loading (browser native ESM
via the Service Worker, or a CJS transform); tackled in a later brick.

---

## 🧱 Brick 4 — Process Model + Shell ✅

Each command runs as its own worker/process with a PID, coordinated by a kernel
over a shared VFS — mirroring StackBlitz's per-PID Node workers.

**Done:**
- New `packages/kernel-host/kernel.js`: an environment-agnostic `Kernel` owning
  the single Wasm VFS + a process table (PID → record). It services every
  process's syscalls and can spawn new processes. Worker creation is injected
  (`spawnWorker`) so the same kernel runs in the browser (Web Workers) and Node
  (worker_threads).
- Each process = one worker with its **own** SharedArrayBuffer channel; the
  kernel services all of them from its event loop.
- `OP_SPAWN` syscall = real **waitpid**: a parent calling `spawnSync`/`execSync`
  parks on `Atomics.wait` while the kernel drives the child to exit (servicing the
  child's syscalls meanwhile), then wakes the parent with `{code,stdout,stderr}`.
  Nesting works (shell → node → execSync → echo), each parked in its own thread.
- `child_process` builtin: `spawnSync`, `execSync`, `execFileSync` (async
  `spawn`/`exec`/`fork` throw for now). `fs` now resolves relative paths against
  `process.cwd()`.
- Coreutils as real Node programs installed at `/bin` (on PATH): `echo`, `cat`,
  `ls`, `pwd`, `mkdir`, `rm`, `node`, `true`, `false`, and a `sh` shell.
- `sh`: sequencing `;`, `&&`, `||`, comments, quotes, builtins (`cd`, `pwd`,
  `export`, `:`), everything else spawned as a child inheriting cwd/env.
- Generic `runtime/boot.js` process bootstrap + env worker entries
  (`demo/process-worker.js`, `scripts/process-worker.mjs`).
- Demo runs a shell session; `scripts/verify-node.mjs`: 16/16 PASS (shell logic,
  cwd inheritance, nested execSync, exit codes 0/1/127, 15 PIDs spawned).

**Deferred:** async `spawn`/streaming stdio, `kill`/signals, pre-warmed worker
pool (StackBlitz idle ~8.1 MB), pipes (`|`) and redirects.

---

## 🧱 Brick 5 — Virtual Network + Preview ✅

A real HTTP server runs inside a worker process; a Service Worker turns the
preview iframe's `fetch`es into kernel calls that reach that server — no socket,
no network.

**Done:**
- Virtual routing table in the kernel (`listeners: port → pid`). New syscalls
  `OP_LISTEN` / `OP_ACCEPT` / `OP_RESPOND` / `OP_CLOSE_SERVER`.
- `OP_ACCEPT` is a **deferred** syscall: the server process parks on
  `Atomics.wait` until the kernel has a request for it — this blocking accept
  loop is the process's synchronous "event loop", reusing the brick-1 bridge.
- `kernel.handleHttpRequest(port, req)` → `Promise<{status,headers,body}>`: queues
  the request into the server's inbox, wakes it if it's waiting, and resolves when
  the server calls `OP_RESPOND`. One request at a time per server (sequential).
- `http` builtin (`runtime/builtins/http.js`): `createServer(fn)`, a `Server`
  (EventEmitter) with non-blocking `listen()`/`close()`/`address()`, plus
  `IncomingMessage`/`ServerResponse` (`writeHead`, `setHeader`, `write`, `end`).
- Runtime accept loop: after top-level runs, if any server is open, `run()` loops
  `accept → dispatch handler → respond` until all servers close. A shared task
  queue drains `nextTick`/`listen` callbacks even while parked.
- Service Worker (`demo/sw.js`): intercepts `<scope>/preview/<port>/<path>`,
  forwards to the controlling page over a `MessageChannel`; the page calls the
  kernel and posts the response back. Demo shows the served page in an iframe.
- `scripts/verify-node.mjs`: 21/21 PASS (200, url routing, second request via the
  loop, header propagation + JSON route, 502 for an unbound port).

**Deferred:** async handlers / streaming bodies, keep-alive, concurrent in-flight
requests per server, `net`/`tls` sockets, timers firing while parked in accept,
preview on a **separate origin** for stronger isolation (currently same-origin
under `/preview/`).

---

## 🧭 Big directional decision — builtins strategy (see research.md §12)

StackBlitz's `builtins.js` (~2.1 MB) is Node's REAL `lib/` source running on top of
a replaced `internalBinding` layer, NOT hand-written fakes.

- **Production target = Path B:** vendor Node's real `lib/` and build the
  `internalBinding` layer on our Rust VFS + sync bridge + process model. This is
  the only realistic way to get correct `http`/`stream`/`crypto`/`zlib`.
- **Current bricks stay on Path A** (hand-written builtins) to keep momentum; the
  syscall/binding contract we're shaping is exactly what Path B will formalize.
- **When we switch:** only the runtime/builtins layer changes — kernel, VFS, and
  process model carry over. Hard modules to watch: `stream`, `http`, `zlib`
  (Wasm codec), `crypto` (WebCrypto), `net`/`tls` (needs Brick 5 networking).

# Phase 2 — Road to T2 (Path B)

Path A (Bricks 1–5) proved the machine with hand-written builtins — architecturally
that is still **T1** (a light shim). **Phase 2 crosses from T1 to T2
(WebContainer-class): vendor Node's REAL `lib/` on an `internalBinding` layer built on
our Rust VFS + sync bridge + process model.** This is the cell no open-source project
occupies today, and the only thing that separates us from the crowded T1 niche.

**Architecture principle (fixed).** A thin, hot **Rust core BELOW the
`internalBinding` line** (VFS, codecs, parsers, buffers); **JS everywhere else** — the
sync bridge, kernel orchestration, transport (fetch/WS/Service Worker), and Node's own
`lib/`. Reuse V8, reuse Node's `lib/`; don't reimplement either. (Pushing the runtime
into Rust would slide us back to T3.)

**Sequencing rule.** De-risk the pivot on the cheapest modules first; do the
architecture decomposition early (so later work sits on the target topology); then
climb the hard modules (`stream` → `net`/`http` → `zlib`/`crypto`).

## Recommended order (implement one at a time)

Effort: [S]mall · [M]edium · [L]arge. Worker names per the Target architecture map.

1. ✅ **Kernel worker** [M] — *decomp.* Move `Kernel` + Wasm VFS off the main thread into
   a dedicated worker (our `kernel-worker.js`, named "Kernel Worker"). Main thread
   = UI + boot only. Do this
   FIRST: everything below then sits on the real topology; retrofitting later hurts.
2. ✅ **`internalBinding` seam + `primordials` + builtin loader** [S–M] — the Path B
   foundation. Wrap modules as `(exports, require, module, process, internalBinding,
   primordials)`. **Proven by running Node's REAL `lib/path.js`, `lib/events.js`,
   `lib/util.js` verbatim** (near-zero bindings), and their Path A hand-written twins
   deleted. Smallest step that validates the whole thesis.
   - ✅ Loader + `primordials` + `internalBinding` seam live in `packages/runtime/node/`.
     `require('path')` now runs Node v24.18.0's (current LTS) **real, unmodified** `lib/path.js`
     (vendored verbatim) — win32 + posix semantics — over a minimal, growable
     `internal/{errors,validators,constants}` layer. Hand-written `builtins/path.js` deleted.
   - ✅ `require('events')` / `require('util')` are now Node v24.18.0's **real, unmodified**
     `lib/events.js` (full `EventEmitter` + statics) and `lib/util.js` (`format`/`inherits`/
     `promisify`/`callbackify`/`types`/`isDeepStrictEqual`/`debuglog`) over the same layer.
     `console` + `assert` now sit on the real `util`; `http` extends the real `EventEmitter`.
     Path A `builtins/{events,util}.js` deleted.
     - `internal/util/inspect` is the one deliberate **bridge** in Path B: Node's real
       inspect is ~2800 lines wired to native V8 introspection (`getPromiseDetails`,
       `getProxyDetails`, `previewEntries`…), so we implement its public contract
       (`inspect`/`format`/`formatWithOptions`/`stripVTControlCharacters`/
       `identicalSequenceRange`) ourselves. Everything above it is Node's real source.
     - Grew the shared layer: vendored `internal/events/abort_listener`; shimmed
       `internal/{event_target,abort_controller,encoding}`, `internal/process/task_queues`,
       `internal/streams/utils`, `internal/util/{debuglog,colors,comparisons}`; `primordials`
       gained `AsyncIteratorPrototype` + `Symbol{Dispose,AsyncDispose}`; `internal/util` gained
       a real `promisify` + `spliceOne`/`getSystemError*`; more `internal/errors` symbols
       (`ERR_UNHANDLED_ERROR`, `ErrnoException`, `isErrorStackTraceLimitWritable`…) and
       `internal/util/types` predicates (`isNativeError`/`isRegExp`/…).
3. ✅ **`buffer` binding + real `lib/buffer.js`** [S–M] — Buffer is used by fs/stream/http;
   get the real one in early. Backed by Wasm memory / `Uint8Array`.
   - ✅ `require('buffer').Buffer` (and the global) is now Node v24.18.0's **real,
     unmodified** `lib/buffer.js` + `internal/buffer.js`, running over a hand-written
     `internalBinding('buffer')` (`node/bindings/buffer.js`) that maps utf8/base64/hex/
     ucs2 codecs, indexOf, compare/copy/fill, byteswap and atob/btoa onto
     `TextEncoder`/`TextDecoder` + typed-array loops. The numeric read/write methods
     are Node's pure-JS ones. Hand-written `builtins/buffer.js` deleted.
   - This grew the shared internal layer that everything downstream reuses:
     `primordials` is now a self-generating Proxy; added `internal/util/{types,inspect}`,
     `internal/v8/startup_snapshot`, `internal/options`, `internalBinding('util'/'config')`,
     and more error codes / validators.
4. ✅ **`internalBinding('fs')` + real `lib/fs.js` + `internal/fs/*`** [M] — `require('fs')`
   is now Node v24.18.0's **real, unmodified** `lib/fs.js` (+ `internal/fs/utils.js`,
   `internal/fs/read/context.js`) over a hand-written `internalBinding('fs')`
   (`node/bindings/fs.js`). Scope delivered: the **sync + callback** API. Streams,
   promises and watch are deferred (they lazy-require and want the event loop of #5/#6).
   - **Real file descriptors, down to Rust.** `lib/fs.js` routes even `readFileSync`
     through `open → fstat → read → close`, so the Rust VFS grew a real fd layer
     (`open/close/fd_read/fd_write/fstat/ftruncate`, positional + cursor I/O, O_* flags,
     zero-fill, `EBADF`; `stat` now carries `ino`). New syscall opcodes
     (`OP_OPEN/CLOSE/FD_READ/FD_WRITE/FSTAT/FTRUNCATE`) thread through
     `protocol/syscall.js` → `kernel-host` → `fs-client.js`, chunked to the 1 MiB
     shared window (lib/fs.js loops on short reads/writes). Wasm rebuilt (web + node).
   - **The binding maps Node's native contract onto the sync bridge:** `stat/lstat/fstat`
     fill the shared `statValues` Float64Array (18 fields, s+ns time pairs) in place;
     async calls carry an `FSReqCallback` whose `oncomplete` we deliver on
     `process.nextTick` (syscalls are synchronous, only the callback is deferred);
     relative paths are resolved against `process.cwd()` at the boundary (as libuv does).
   - Grew the shared internal layer again: vendored `internal/fs/utils`, `read/context`;
     shimmed `internal/{url,blob,assert}`, `internal/process/permission`;
     `internalBinding('constants').fs` (O_*/S_*/UV_DIRENT_*/COPYFILE_*); `primordials`
     gained `uncurryThis` + `Safe{Map,Set}`; more `internal/{errors,util,validators,
     util/types}` symbols. Hand-written `builtins/fs.js` deleted.
5. **Event loop v2** [M] — real microtask/macrotask ordering: `queueMicrotask` +
   `process.nextTick` + `setImmediate` + timers, **firing even while a server is parked
   in `accept`** (fixes the Brick 5 deferral). Foundation for async stream/http.
6. **`stream` — real `lib/stream.js` + `internal/streams/*`** [M–L] — mostly pure JS;
   once the loader + event loop exist, correct backpressure / duplex / `pipe` come
   almost for free. **The flagship Path B win** (hand-writing this correctly is
   infeasible — the whole reason we pivot).
7. **`net` + `tcp_wrap` binding** [L] — the socket layer under http. Loopback virtual
   net for preview (replaces Brick 5's routing table) + a fetch/WebSocket bridge for
   outbound (CORS-limited — stay honest about it).
8. **`http`/`http2` — real `lib/http.js` + `_http_*`** [L] — on `stream` + `net` + a
   Wasm **`http_parser`** (compile **llhttp** to Wasm). Replaces Brick 5's hand-written
   http with real semantics: async handlers, streaming bodies, keep-alive.
9. **Network/registry worker** [M] — *decomp.* Dedicated fetch worker (our
   `Fetcher Worker`) for the npm registry + tarballs (+ later the outbound fetch
   bridge). Land it just before npm needs it.
10. **Real `npm install`** [L] — registry proxy (via the Network worker), semver
    resolution, **tar extraction** into the VFS (use the browser-native
    `DecompressionStream('gzip')` for `.tgz` → no zlib dependency yet), `node_modules`
    layout, bin stubs, basic lifecycle scripts. Highest "real project" value; depends
    only on fs + network, so it can proceed in parallel with steps 6–8.
11. **`zlib` — Wasm codec + real `lib/zlib.js`** [M] — compile zlib to Wasm; needed for
    http gzip and general compat.
12. **`crypto` — WebCrypto + Wasm + real `lib/crypto` (partial)** [L] — map to
    WebCrypto where possible, Wasm for the rest. Partial first (hashes, hmac,
    `randomBytes`) — enough for npm integrity + common libs.
13. **ESM (`import`/`export`)** [L] — native browser ESM served from the VFS via the
    Service Worker, or Node's esm loader. Unblocks modern packages.
14. **VFS worker split** [M] — *decomp, deliberately LATE.* Split the Wasm VFS into its
    own worker (our `File System Worker`) as the single source of truth once the fs
    binding contract is stable; fs opcodes serviced directly over the SAB. (Doing this
    before the contract settles = double churn — that's why it isn't first.)
15. **Extras (ongoing)** — nested `worker_threads` (our `[worker n]`), heavy toolchains
    (`esbuild`/`vite`/`tsserver` as Wasm), IndexedDB persistence, pre-warm worker pool.

## Why this order (the tradeoffs)

- **Decomp is split in two on purpose:** Kernel worker is first (pure win, everything
  benefits); the VFS-worker split is last (needs a stable fs contract or it churns
  twice); the Network worker lands just-in-time for npm. This honours "decompose early"
  without paying for premature splits. (Concurrent multi-process itself is already done
  in Brick 4 — each process owns its SAB channel.)
- **Cheapest-proof-first:** steps 2–4 (path/events/util → buffer → fs) prove the
  `internalBinding` pivot with modules that need almost no bindings, or whose backend we
  already have. If the seam works there, the thesis holds.
- **`stream` before `net`/`http`:** http depends on stream; stream is the module that
  most justifies Path B and is mostly pure JS → highest value per unit effort.
- **npm is parallelizable:** it needs only fs + network + native gzip (not stream/http),
  so it can run alongside the hard-module climb for faster "real project" wins.
- **Rust sinks come after the contract stabilizes:** only hot paths proven in JS get
  pushed down (llhttp parser, zlib codec, buffer ops) — never the orchestration or
  Node's `lib/`.

## Packaging & delivery (deferred to productionization)

Today the browser loads the runtime as **individual, unbundled ES modules** (`os.js`,
`process.js`, the vendored `node/lib/*` + `node/internal/*`, …) — one network request
each. This is a **deliberate DEV choice**, not the shipping shape: it keeps the vendored
Node source readable, debuggable in DevTools, and trivially diffable against upstream.
The architecture is already bundle-ready (everything is ESM behind `loader.js`), so this
is purely a build-pipeline step to add near the end — doing it early would only hurt DX.

When we productionize, the plan is **not** "one giant file" but bundle-by-role:

- **Bundle per worker role** (esbuild/rollup/vite), never dump worker code into main:
  a *runtime* bundle (runs in the Process Worker), a *kernel* bundle (Kernel Worker),
  and the UI (main). Minify + tree-shake each.
- **Runtime stdlib loaded once, shared by every process:** the real spawn-latency lever
  is caching, not file count. Ship the runtime as one cacheable artifact and
  **precache it in the Service Worker** (we already have `sw.js`) so every Process Worker
  spawn and every reload is instant (this is why StackBlitz caches so aggressively).
- **Lazy-load heavy/rare modules** (`zlib`, `crypto`, full `stream` variants) as split
  chunks fetched on first `require` — small core bundle + on-demand tail.
- **Wasm stays a separate binary** (`WebAssembly.instantiateStreaming`), never inlined
  into JS — the VFS/kernel Wasm is streamed and compiled on its own.
- **Brotli/gzip on the minified JS** — on already-minified code this is the biggest
  actual "resource saved" win, bigger than minification alone.
- **Source maps in dev only**, stripped for prod.

## Definition of done for T2

`npm install` a real dependency, then `node`-run an Express/Vite app whose HTTP server
is driven by Node's REAL `lib/http` + `lib/stream` over the `internalBinding` layer and
previewed live in the iframe — with the Path A hand-written builtins deleted.

---

## 🎯 Target architecture map (StackBlitz reference)

| StackBlitz (observed via DevTools) | OpenContainer |
|---|---|
| `Main` | Main thread — UI, orchestration |
| `engineworker.js` | Kernel worker — `kernel-worker.js` (orchestrator) |
| `File System Worker` | VFS worker (Rust/Wasm) |
| `Fetcher Worker` | Network/registry worker |
| `Node.js Worker PID n` | Process = 1 worker + Node shim |
| `[worker n]` | Nested `worker_threads` (much later) |
| `sw.js` | Service Worker preview |
