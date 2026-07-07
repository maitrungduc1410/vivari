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

> ## ⭐ North Star — package managers (never forget the vision)
>
> The end state is running the **REAL `npm` / `yarn` / `pnpm` in the browser**, exactly
> like WebContainer — **and better**: lazy-loaded from the registry, version-pinned, on a
> Node runtime deep enough to host them (`crypto` #12, `zlib` #11, `tls`, `child_process`,
> `worker_threads`, full `fs`). The real CLIs then behave *bit-for-bit* like local.
>
> **Our current `programs/npm.js` is a deliberately TEMPORARY "Turbo-analog"** — a small
> hand-written installer engine to bootstrap real-project workflows while Node-compat is
> still too thin to run the real thing. This mirrors StackBlitz's own history exactly:
> they shipped **Turbo** (their custom npm client, 2018–2024), then — after a year of
> deepening Node-compat — **deprecated Turbo (Apr 2024) and switched to native
> npm/yarn/pnpm**. We follow the same arc: Turbo-analog now → real PMs later.
>
> **Rule:** never let the Turbo-analog become the destination, and never over-polish it
> (anything installer-specific — lifecycle nuance, dedup, `npm ci` — gets thrown away when
> the real CLIs land). Invest only in what survives the switch (e.g. real `semver`) or in
> what is *not* installer logic (running scripts: `npm run`/`npx`). Known real-PM caveats
> to inherit: one pinned version per PM, Wasm packages only (no native add-ons), PM chosen
> by lockfile.

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
5. ✅ **Event loop v2** [M] — each process now has a real, async event loop
   (`packages/runtime/loop.js`) with Node ordering **nextTick > Promise microtasks >
   timers > setImmediate**, and **timers/microtasks fire even while a server is
   running** (fixes the Brick 5 deferral). Foundation for async stream/http.
   - `run()` is async: it runs `main` synchronously (sync syscalls still block via
     `Atomics.wait`), then `drive()`s the loop until quiescent (no ref'd timers/
     immediates/nextTicks and no open servers). Microtasks are flushed by yielding a
     `MessageChannel` macrotask each turn (a synchronous loop can't drain them).
   - Full timer API on `globalThis`: `setTimeout`/`setInterval`/`setImmediate` (+
     `clear*`) with `Timeout`/`Immediate` handles (`ref`/`unref`/`refresh`/
     `[Symbol.toPrimitive]`); real host-backed delays; `process.nextTick` owned by
     the loop; `process.exit()` from any callback stops the loop with its code.
   - Serving is now **message-driven**, not a blocking accept: the kernel
     `postMessage({type:'net'})` nudges the worker (`handleHttpRequest`); the loop
     wakes and drains the inbox via a **non-blocking `tryAccept`** (kernel replies
     empty when drained), so the SAB channel stays free for sync syscalls inside
     timer callbacks. `boot.js` is async; `spawnWorker` handles expose `postMessage`.
6. ✅ **`stream` — real `lib/stream.js` + `internal/streams/*`** [M–L] — `require('stream')`
   is now Node v24.18.0's **real, unmodified** `lib/stream.js` + the full
   `internal/streams/*` tree (legacy, utils, destroy, state, from, end-of-stream,
   add-abort-signal, readable, writable, duplex, duplexify, transform, passthrough,
   pipeline, compose, operators, duplexpair) + `stream/promises`, all vendored
   verbatim. Correct backpressure / duplex / `pipe` / async iteration come for
   free on Event loop v2 — **the flagship Path B win** (hand-writing this correctly
   is infeasible, the whole reason we pivot). Runs on the existing shared internal
   layer with a few small additions:
   - **`string_decoder`**: Node's `lib/string_decoder.js` wraps a native decoder;
     instead we ship the canonical **pure-JS** StringDecoder (the algorithm
     readable-stream uses in browsers) over our real Buffer — correct multibyte
     boundary handling for utf8/utf16le/base64. `Readable.setEncoding` works.
   - **`async_hooks`**: minimal shim (`AsyncResource.runInAsyncScope`/`bind`, inert
     `createHook`, synchronous-scope `AsyncLocalStorage`) — enough for
     `internal/streams/end-of-stream`; real async-context tracking deferred.
   - **`internal/webstreams/adapters`**: deferred stub — only required lazily by
     `Readable/Writable/Duplex.{from,to}Web`, which throw until Web Streams land.
   - Fixed `internal/util/debuglog` to defer its lazy callback (callers assign it
     into a `let debug` still in its TDZ). Proven by `streamb.js`:
     Readable.from + async iteration, setEncoding across a split multibyte char,
     Writable + `finished`, `pipeline` (Readable→Transform→PassThrough→Writable),
     callback `pipeline`+`finished`, Duplex. verify: 35/35 PASS.
7. ✅ **`net` — real `lib/net.js` on a `tcp_wrap`/`stream_wrap` loopback binding** [L] —
   `require('net')` is now Node v24.18.0's **real, unmodified** `lib/net.js` +
   `internal/net` + `internal/stream_base_commons`, running over a hand-written
   `internalBinding` socket layer. `net.Server`/`net.Socket` are genuine Duplex
   streams (on the #6 stream stack + Event loop v2) — the socket foundation #8's
   real `lib/http` will extend.
   - **The binding** (`node/bindings/net.js` → `tcp_wrap`, `stream_wrap`, `uv`,
     `pipe_wrap`, `cares_wrap`): implements the libuv **StreamBase contract**
     `internal/stream_base_commons` speaks — `writeBuffer`/`write*String`/`writev`
     + `readStart`/`readStop` + an `onread` callback driven through a shared
     `streamBaseState`, plus `listen`/`connect`/`onconnection`, `getsockname`/
     `getpeername`, `shutdown` (half-close) and `close` (EOF to peer).
   - **In-process loopback**: a per-process `port → serverHandle` registry links a
     `connect()`ing handle to a `listen()`ing one in the same VM, producing a
     linked endpoint pair whose writes surface as the peer's reads (backpressure
     via `readStop` honored, FIFO delivery, `ECONNREFUSED` for unbound ports).
     This is exactly what a preview/loopback server needs and runs unmodified
     `lib/net.js` end-to-end.
   - **Support shims added** to the shared layer: `internal/timers` (maps
     `setUnrefTimeout`/`getTimerDuration`/`kTimeout` onto our loop), `timers`
     (public, delegates to the loop's globals), extended `internal/async_hooks`
     (owner/async-id symbols, `newAsyncId`, `defaultTriggerAsyncIdScope`) with
     `async_hooks` re-exporting it (shared symbols), `diagnostics_channel` +
     `internal/perf/observe` + `cluster` + `pipe_wrap` stubs, and `validatePort`/
     `validateStringWithoutNullBytes`/`guessHandleType` + `ExceptionWithHostPort`/
     `ErrnoException` now resolving `.code` via `uv.errname`.
   - **Deferred (honestly)**: outbound raw TCP is impossible in a browser — real
     `net.connect(host)` to the internet needs the fetch/WebSocket bridge (#9,
     CORS-limited); DNS (`cares_wrap`), Unix pipes (`pipe_wrap`), `BlockList`/
     `SocketAddress`, and socket timeouts beyond the shim are stubbed. Cross-VM
     loopback (wiring the kernel + Service Worker to replace Brick 5's routing) is
     folded into #8, where real `http` and the preview path land together.
   - Proven by `netb.js`: echo server + client roundtrip, ephemeral `listen(0)` +
     `address()`, a second independent connection, 3-write reassembly, and
     `ECONNREFUSED`. Demo gains **`/api/net`** (in-process TCP echo over 127.0.0.1
     in the browser). verify: 37/37 PASS.
8. **`http` — real `lib/http.js` + `_http_*`** [L] — on `stream` + `net`.
   - ✅ **Stage 1 (in-VM real http) — DONE.** Vendored Node v24.18.0 `lib/http.js` +
     `_http_common`/`_http_incoming`/`_http_outgoing`/`_http_server`/`_http_client`/
     `_http_agent` **verbatim**, running over a new **pure-JS `internalBinding('http_parser')`**
     (`node/bindings/http_parser.js`) — a self-contained HTTP/1.1 parser (request &
     response, Content-Length + **chunked** + EOF-delimited bodies, keep-alive/close,
     header pairs, trailers). We intentionally don't advertise `isStreamBase` on the TCP
     handle, so `_http_server` uses the slow `socket.on('data') → parser.execute(buf)`
     path (no native `consume()`/StreamBase glue needed). Real `ClientRequest`/
     `ServerResponse`/`IncomingMessage` work end-to-end over the #7 net loopback:
     POST/GET, streaming/chunked bodies, response headers, and **keep-alive socket
     reuse** all proven headless (`verify-node.mjs`) + in the browser demo (`/api/http`).
     Also added: net-handle **event-loop liveness** ref-counting (a listening
     `net.Server`/open socket now keeps the loop alive like libuv active handles),
     `internal/http`/`internal/options`/`internal/url`/`internal/freelist` shims,
     `assignFunctionName`/`getOrSetAsyncId` helpers, and lazy `https`/`tls`/`undici`
     stubs.
   - ✅ **Stage 2 (cross-VM preview swap) — DONE.** `require('http')` **is** the real
     `lib/http.js` now; **Brick 5 is deleted** (`builtins/http.js` gone). The seam is
     pure JS and keeps the kernel/SW protocol unchanged (`{port,method,url,headers,body}`
     in → `{status,headers,body}` out): `net.Server.listen(P)` now also registers `P`
     with the kernel (`tcp_wrap.listen` → `syscalls.listen`, ephemeral ports retry on a
     cross-process clash) so the Service Worker / `kernel.handleHttpRequest` route to the
     right process. On a `net` wake the runtime's `doNet` drains each queued request and
     **replays it through a real http *client* into the in-VM real http *server* over the
     #7 loopback** (`bridgeHttp` in `index.js`), then `respond()`s with the collected
     reply — so the browser preview is served by Node's own `http`. Request/response
     hop-by-hop + framing headers are stripped at the bridge; bodies cross as utf8
     strings (same limitation as the old path; binary preview payloads out of scope).
     The whole event-loop liveness now rides on the net ref-count (no more Brick 5
     `servers` map). The pre-existing `http: server responds 200` / accept-loop /
     two-concurrent-async verify cases now exercise this full path end-to-end. verify:
     38/38 PASS.
   - ⏳ **Deferred:** compile **llhttp → Wasm** as a drop-in `http_parser` (perf, after
     the contract is stable), **raw byte-tunnel** streaming (true request/response
     streaming + binary bodies across the SW seam, replacing the buffered replay), and
     **`http2`** (needs `internalBinding('http2')`/nghttp2).
9. **Network/registry worker** [M] — *decomp.* ✅ **DONE.** A dedicated
   **`Fetcher Worker`** (`packages/demo/fetcher-worker.js`) owns all outbound
   network so downloading/decompressing large payloads never stalls syscall
   servicing; it holds no SAB and transfers bodies back as `ArrayBuffer`. New
   **deferred syscall `OP_FETCH`** (like `OP_SPAWN`): a process calls the blocking
   `__ocfetch(url)` (`syscalls.fetch`), parks on `Atomics.wait`, and the kernel
   delegates to the Fetcher, **streams the body straight into the VFS** (bypassing
   the 1 MiB SAB window), then wakes the caller with small JSON
   `{status,ok,contentType,size,path,cached}`; the caller reads `path` with `fs`, so
   arbitrary-size downloads work. Kernel keeps a **content cache** keyed by URL (a
   repeated fetch skips the network). Direct-to-origin today (npm registry sends
   `ACAO:*`, verified) with a single **`rewrite(url)` seam** in the Fetcher for
   slotting a caching/rewriting proxy in later. Demo gains **`/api/fetch`** (pulls
   `left-pad` metadata + tarball from `registry.npmjs.org` live in the browser,
   lists versions, proves the cache); headless verify uses a mocked offline Fetcher.
   verify: 40/40 PASS.
10. **Real `npm install`** [L] — **stage 1 DONE.** A real `npm` program (`programs/npm.js`,
    installed to `/bin/npm.js` as an ordinary process) does: minimal **semver**
    (caret/tilde/exact/x-range/dist-tag), transitive **dependency-graph** resolution from
    registry packuments, **tarball download** via the blocking `__ocfetch` (Fetcher Worker
    + kernel cache, #9), **gunzip** with the platform-native `DecompressionStream('gzip')`
    (no bundled zlib) + a from-scratch **ustar tar parser** (GNU long-name + pax `path`),
    files written into **`node_modules`** with **npm-v3 hoisting** (first-seen version to the
    project root, conflicting versions nested under the dependent), **`.bin` symlinks**, and
    explicit installs recorded in `package.json`. The event loop can't see native async
    (`DecompressionStream`) work, so the program holds a ref'd keep-alive interval while it
    runs and exits from that (loop-run) callback so the exit sentinel is caught.
    Demo boot runs `npm install is-odd` live in the browser (resolves is-odd → is-number
    from `registry.npmjs.org`) then `require()`s the freshly installed tree. Headless verify
    builds real gzipped tarballs offline and proves resolve + hoist + `.bin` + require +
    `package.json`. verify: 45/45 PASS.
    **Stage 2 (lean) — DONE.** Just enough to drive a real install→run workflow:
    (a) vendored **real `semver`** (`node/vendor/semver.js`, bundled from `semver@7` with
    esbuild, lazy loader builtin) replaces the hand-rolled range logic — now compound
    ranges (`>=1.2 <2`), unions (`1 || 2`) and hyphen ranges resolve exactly like npm, and
    it survives the switch to real npm (North Star); (b) **`npm run <script>`** (+ `start`/
    `test`) and **`npx`** run local executables, backed by **PATH-aware program resolution**
    in the kernel (`node_modules/.bin` on PATH shadows `/bin`, `.bin` symlinks followed) so
    a script's bare bin name (e.g. `vite`) resolves to the locally installed tool; also
    fixed the `node` launcher to drop its own path from `argv` (scripts see Node's
    `argv[1] = script` semantics). Demo boot now `npm run start`s the installed app. verify:
    50/50 PASS. Note: a long-running dev server via `npm run` blocks (spawnSync) until
    async `spawn`/streaming exists; launch servers directly (`node server.js`) meanwhile.
    Full **Vite** additionally needs ESM (#13) + a Wasm bundler (esbuild-wasm). Deliberately
    **still deferred** (thrown away when real npm lands): `package-lock.json`, lifecycle
    scripts, peer/optional deps, dedup nuance, `npm ci`.
    - **✅ Express runs for real (verified).** `npm install express` pulls the full ~70-package
      tree from registry.npmjs.org and the unmodified framework boots + serves on our vendored
      Node stack — router, params, and `express.json()` body parsing all work. Demo boot now
      installs + runs it and calls three routes; `scripts/verify-express.mjs` is a
      network-gated e2e smoke test (kept out of the hermetic `verify-node.mjs`). Getting there
      added several builtins the dependency tree needs: **`tty`** (stub — `isatty()=false` for
      `debug`), **`url`** (legacy `parse`/`format`/`resolve` over WHATWG URL, for `parseurl`),
      **`querystring`** (now **vendored verbatim** from Node v24.18.0 — `lib/querystring.js` +
      `internal/querystring`, output byte-for-byte identical to Node), **`internal/file`**
      (`buffer.File`), plus partial **`crypto`** (#12) and **`zlib`** (#11). Also added
      `decodeURIComponent`/`encodeURIComponent`/`decodeURI`/`encodeURI` + `ERR_INVALID_URI` to
      primordials/errors so the verbatim source links. Also fixed a real CommonJS bug: the module wrapper injected
      `Buffer`/`process`/… as *parameters*, so a userland `const Buffer = require('buffer').Buffer`
      threw "Identifier already declared" — now they're true globals (as in Node) and only
      `exports/require/module/__filename/__dirname` are wrapper params.
11. **`zlib` — Wasm codec + real `lib/zlib.js`** [M] — **PARTIAL DONE.** `node/lib/zlib.js`
    wraps the browser `Compression/DecompressionStream` as Node Transform streams, so
    `createGzip/Gunzip/Deflate/Inflate(+Raw)` and `createUnzip` work for real (gzip/deflate);
    brotli and the `*Sync` one-shots throw loudly (no Web equivalent). Enough for
    `body-parser`/`compression` to load and handle encoded bodies. TODO: real `lib/zlib.js`
    + a Wasm codec for brotli + sync APIs.
12. **`crypto` — WebCrypto + Wasm + real `lib/crypto` (partial)** [L] — **PARTIAL DONE.**
    `node/lib/crypto.js` ships synchronous pure-JS `createHash` (MD5/SHA-1/SHA-256) +
    `createHmac`, plus WebCrypto-backed `randomBytes`/`randomFill`/`randomInt`/`randomUUID`.
    Enough for the userland happy path (ETag/session libs hash synchronously) — this is what
    unblocked **Express** (its `etag` dep requires `crypto` at load). Ciphers/sign/verify/KDFs
    throw loudly. TODO: more digests, ciphers, and a Wasm/`lib/crypto` backing for the rest.
13. **ESM (`import`/`export`)** [L] — native browser ESM served from the VFS via the
    Service Worker, or Node's esm loader. Unblocks modern packages.
14. **VFS worker split** [M] — *decomp, deliberately LATE.* Split the Wasm VFS into its
    own worker (our `File System Worker`) as the single source of truth once the fs
    binding contract is stable; fs opcodes serviced directly over the SAB. (Doing this
    before the contract settles = double churn — that's why it isn't first.)
15. **Extras (ongoing)** — nested `worker_threads` (our `[worker n]`), heavy toolchains
    (`esbuild`/`vite`/`tsserver` as Wasm), IndexedDB persistence, pre-warm worker pool.
16. **WASI + napi-rs Wasm runtime (native→wasm packages)** [XL] — *future goal.* Many
    modern toolchains ship a `wasm32-wasi` build of their native `.node` addon and switch to
    it when they detect a WebContainer-class host (e.g. Vite's `rolldown` downloads
    `@rolldown/binding-wasm32-wasi`; also esbuild-wasm, `@swc/wasm`, `@napi-rs/*`). To run
    them we need (a) a **WASI preview1 shim** bridged to our VFS + a fake clock/argv/env, and
    (b) **napi-on-wasm** (`emnapi`) so N-API addons compiled via napi-rs load. This is the
    real unlock for "install Vite and it just builds" without us hand-porting each tool.
    Depends on: stable fs/VFS contract (#14), ESM (#13). Pairs with the "detect env → fetch
    the wasm variant" logic real npm/pnpm already have (see North Star).

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
