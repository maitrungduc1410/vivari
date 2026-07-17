# Vivari — Roadmap

Built on the principle **de-risk the hardest part first**: prove the riskiest
primitive (synchronous cross-thread access to a shared kernel) before expanding.

Status: ✅ done · 🚧 in progress · ⏳ next · 🧊 later

---

## 🧱 Brick 1 — Synchronous FS Bridge ✅

The load-bearing primitive of the whole system: user code in a Web Worker calls a
**synchronous** `fs` API that actually crosses into the kernel via
`SharedArrayBuffer` + `Atomics`.

**Done:**
- `packages/vfs` — VFS written in Rust (`HashMap<path, bytes>`), compiled to
  Wasm (`wasm-pack`, two targets: `web` for the browser, `nodejs` for headless
  tests). (Formerly `packages/kernel`; renamed since it holds only the filesystem —
  the actual kernel/process supervisor is JS in `packages/kernel-host`.)
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

**Persistence across reloads — DONE (OPFS write-behind mirror).** The VFS (Rust/Wasm,
in RAM) is now mirrored to the **Origin Private File System** so a project + its
`node_modules` survive F5. We picked OPFS over IndexedDB because it exposes **synchronous
access handles inside a Worker** (`createSyncAccessHandle`, the SQLite-wasm primitive),
matching our worker-based, `Atomics`-blocking VFS, and draws from the large per-origin
quota (shared with Cache API). Design — **write-behind mirror**, not a backing store:
- The Rust VFS stays the source of truth in RAM (reads never touch OPFS → no regression).
- `FsServer` forwards every successful mutation (`onWrite`/`onDelete`/`onRename`) to
  `packages/kernel-host/opfs-persistence.js`. The syscall path is synchronous and OPFS
  handle acquisition is async, so we only **enqueue a dirty path** and drain it on an async
  loop (coalesced per path). Durability is eventual (~ms); `flush()` on `pagehide` forces it.
- fd writes (`fd_write`/`ftruncate`/`close`) resolve their path via an fd→path map kept in
  `FsServer`; on drain we re-read the file's current bytes from the VFS and write one OPFS file.
- Layout `vv-vfs/{files/…, manifest.json}`: one OPFS file per VFS file (bytes), plus a small
  manifest `[path,{kind,mode,target}]` that recreates dirs + symlinks (OPFS has neither).
- Boot `restore()` replays the manifest into the VFS **before** the FS worker serves any
  syscall (calls the VFS directly, so it never re-enters the queue).
- Only the browser wires it (`packages/core/src/workers/fs-worker.ts`); **headless injects no adapter**
  (`new FsServer(vfs)`), so `verify-node`/`verify-express` are unchanged and still green.
- System/volatile dirs are skipped (`/bin` coreutils re-install each boot, `/tmp`,`/proc`,
  `/dev`). `?reset` (host.js) wipes `vv-vfs` before boot. Demo: `GET /api/persist` bumps a
  counter in `/data/visits.json` that keeps climbing across reloads.
**Deferred:** exact `mode` restore (needs a VFS `chmod`; today files get the default mode on
restore — fine for our spawn/PATH resolution which doesn't gate on the exec bit); quota-pressure
eviction UX (`navigator.storage.persist()` opt-in); a true OPFS-backed store (contents on disk,
only metadata in RAM) to cap memory for very large trees.

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

**Deferred → DONE (Phase 2 #13):** ESM (`import`/`export`) — shipped as a load-time
ESM→CJS transpile over `es-module-lexer` (see Phase 2 #13 below).

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
  `spawn`/`exec`/`execFile` added in #15, below). `fs` now resolves relative paths
  against `process.cwd()`.
- Coreutils as real Node programs installed at `/bin` (on PATH): `echo`, `cat`,
  `ls`, `pwd`, `mkdir`, `rm`, `node`, `true`, `false`, and a `sh` shell.
- `sh`: sequencing `;`, `&&`, `||`, pipes (`|`), redirects (`<` `>` `>>` `2>`
  `2>>` `2>&1`, with `/dev/null` as a discard sink), comments, quotes, builtins
  (`cd`, `pwd`, `export`, `:`), everything else spawned as a child inheriting cwd/env.
- Generic `runtime/boot.js` process bootstrap + env worker entries
  (`demo/process-worker.js`, `scripts/process-worker.mjs`).
- Demo runs a shell session; `scripts/verify-node.mjs`: 16/16 PASS (shell logic,
  cwd inheritance, nested execSync, exit codes 0/1/127, 15 PIDs spawned).

**Deferred:** ~~async `spawn`/streaming stdio, `kill`/signals~~ (DONE in #15),
~~parent→child stdin pipe~~ (DONE — now binary-safe), pre-warmed worker pool
(StackBlitz idle ~8.1 MB), ~~pipes (`|`) and redirects~~ (DONE).

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

### Real package managers — progress (the North Star, in motion)

De-risked with a throwaway harness (`scripts/spike-npm.mjs`) that loads a vendored,
unmodified **npm@10.9.2** into the VFS and runs its real `bin/npm-cli.js` on Path B, gated
end to end. Run it with `node scripts/spike-npm.mjs` (add `VV_PHASE2=1` for the lifecycle
gate; needs network — hits `registry.npmjs.org`).

- **Phase 0 — real npm BOOTS (`baeacbf`).** `npm -v` → `10.9.2`, exit 0. Fixed three
  Node-fidelity gaps the real CLI exposed: `process` is a genuine `EventEmitter` (npm's
  `proc-log`), dynamic `import()` inside CJS routes through our loader (npm's
  `await import('chalk')`), and `stdout.write(cb)` / `process.exitCode` / a single `'exit'`
  event behave like Node (npm's exit-handler).
- **Phase 1 — real `npm install <pkg>` (`2299c62`).** Resolves, downloads, and extracts from
  the live registry. `lib/https.js` is now a fetch-backed client (npm's
  `npm-registry-fetch → make-fetch-happen → minipass-fetch` stack runs unmodified); the fetch
  syscall carries `{method, headers, body}` + full response headers; the Fetcher Worker +
  kernel-worker forward the request init so it works in the browser too. Verified:
  `npm install is-number` → `added 1 package`, `npm install debug` → `added 2 packages`
  (transitive `ms`), tree require-able.
- **Phase 2 — lifecycle scripts + `.bin` + non-fatal native (this change).** A root project
  with `preinstall`/`install`/`postinstall`, a dep that ships a JS `postinstall` (`core-js`),
  and a dep with a bin (`semver`) all install cleanly; `.bin/semver` is linked and runnable
  via `npm exec`. The one missing piece was **native builds**: a package whose `install` is
  `node-gyp rebuild` aborted the whole install (no compiler toolchain in-browser, and our
  runtime can't execute npm's POSIX `node-gyp` shell shim — it compiles programs as JS). Fix
  = a **node-gyp stub** (`packages/kernel-host/node-gyp-stub.js`): `stubNodeGyp()` overwrites
  npm's node-gyp entry points in the vendored tree with a JS no-op (exit 0, warns), and a
  `node-gyp` coreutil is the PATH fallback. Native compilation is now a non-fatal skip — the
  package's JS/`wasm32-wasi` fallback is what loads at runtime — so `preinstall`→`install`→
  `postinstall` completes. Also fixed a latent `writeLarge` bug this surfaced under Node ≥ 22:
  a fetched/mock body backed by a pooled/offset `ArrayBuffer` (Node's Buffer pool) is not
  transferable ("Cannot transfer object of unsupported type") — `writeLarge` now transfers a
  standalone buffer (own buffer, or an exact-bytes copy). `npm run verify` is green (92/92).
- **Phase 3 — real npm IS the shell's `npm` in the studio (this change).** The first two
  phases proved real npm headless (off the host disk); this makes it the actual `npm`/`npx`
  the interactive studio terminal runs, retiring the Turbo-analog in that UI. The hard part
  is **delivery**: the browser can't `fs.readdirSync` the host, so `scripts/vendor-npm.mjs`
  installs pinned npm@10.9.2 and packs its whole tree (~2400 files) into one gzipped asset
  (`packages/studio/public/vendor/npm-pack.bin`, ~2.8 MB gzipped but named `.bin`
  so static servers don't Content-Encoding it; gitignored, built by
  `npm run vendor:npm`, wired as `predev`/`prebuild:studio`). A shared loader
  (`packages/kernel-host/load-real-npm.js`) decodes that asset with the platform-native
  `DecompressionStream` and unpacks it into the VFS at `/usr/lib/node_modules/npm`, applies
  `stubNodeGyp`, and overwrites `/bin/npm.js` + `/bin/npx.js` with thin shims that
  `require()` the real CLI. The kernel worker calls `ensureRealNpm()` right after
  `installCoreutils()` at boot (fetches the asset once; on later boots the tree is already
  OPFS-persisted, so it only re-applies the cheap shims); it falls back to the Turbo-analog
  if the asset is missing. The **same shared loader + shim path** is gated headlessly by
  `scripts/spike-npm-studio.mjs` (`npm --version`/`npx --version` → `10.9.2` via the PATH
  shim, `VV_NET=1` adds a real `npm install`). Fixes the reported `npm -v`/`node -v` oddity:
  `npm -v` now answers `10.9.2` (real npm), and the `node` coreutil learned `-v`/`--version`.
  (Phase-3 deferrals — `npm ci`, retiring `programs/npm.js`, and batching the first-load write
  storm — are all closed in the "PM capstone" entry below; yarn/pnpm/corepack are Phases 4-6.)
- **Phase 4 — yarn (classic) proven headless (spike only, this change).** Same arc as npm's
  Phase 0-1: load the unmodified `yarn@1.22.22` package into the VFS and run its REAL CLI on
  Path B — a go/no-go gate before any studio delivery/wiring. Yarn classic is tiny to deliver
  (just `bin/yarn.js` + a ~5 MB `lib/cli.js` webpack bundle + `lib/v8-compile-cache.js`), so
  `scripts/spike-yarn.mjs` loads it (large `cli.js` via the transferred `writeLarge` path, not
  the 1 MiB SAB window) and gates three things: **A** `yarn --version` → `1.22.22`, **B** an
  `https.get` egress self-test, **C** a real `yarn add is-number` (resolve → fetch tarball via
  the Fetcher Worker → link → build → `yarn.lock`), then `require()`s the installed package.
  **All three PASS.** Getting there filled five real Node-compat gaps that yarn exercises but
  npm didn't (fixed in `packages/runtime/`, so they benefit the whole runtime): (1)
  `process.stdout`/`stderr` grew the EventEmitter/Writable surface (`prependListener` et al.)
  yarn registers during bootstrap; (2) `process.memoryUsage()` (yarn's reporter tracks peak
  RSS); (3) a legacy `process.binding(name)` shim delegating to `internalBinding` (+ a
  `natives` name-map) for yarn's bundled `safer-buffer`/`builtin-modules`/`constants`; (4) two
  missing lazy `fs` internals — `internal/streams/fast-utf8-stream` (`fs.Utf8Stream`) and
  `internal/fs/dir` (`fs.opendir`) — which yarn's `thenify-all` `promisifyAll(fs)` trips by
  merely *enumerating* every `fs` getter; (5) **the important one:** `internal/fs/streams`
  now defines `ReadStream`/`WriteStream` as ES5 function-constructors (callable without `new`,
  `Readable.call(this)` init) instead of ES6 `class`, exactly like real Node — graceful-fs
  (bundled by yarn/fs-extra) subclasses them via `fs$WriteStream.apply(this, …)`, which throws
  against a `class`. Known cosmetic-only finding: yarn prints "You don't appear to have an
  internet connection" (its DNS-based connectivity probe isn't satisfied by our fetch-backed
  net), yet the install still succeeds over the Fetcher Worker.
- **Phase 4 (cont.) — real yarn IS the studio shell's `yarn` (this change).** With the spike
  green, yarn is now wired into the interactive studio exactly like npm: `scripts/vendor-yarn.mjs`
  packs pinned `yarn@1.22.22` into one gzipped asset
  (`packages/studio/public/vendor/yarn-pack.bin`, ~1.2 MB gz / 5.3 MB raw, 11 files; gitignored,
  built by `npm run vendor:yarn`, wired as `predev`/`prebuild:studio`). A shared loader
  (`packages/kernel-host/load-real-yarn.js`) decodes it with the platform-native
  `DecompressionStream`, unpacks into the VFS at `/usr/lib/node_modules/yarn` (the ~5 MB
  `lib/cli.js` goes through the transferred `writeLarge` path, not the 1 MiB SAB window), and
  installs `/bin/yarn.js` + `/bin/yarnpkg.js` shims that `require()` the real entry. The kernel
  worker calls `ensureRealYarn()` right after `ensureRealNpm()` at boot (OPFS-persisted, so later
  boots only re-apply the cheap shims); the shell env gains `YARN_CACHE_FOLDER=/tmp/.yarn-cache`
  (created at boot). The SAME shared loader + shim path is gated headlessly by
  `scripts/spike-yarn-studio.mjs` (`yarn --version` → `1.22.22` via the PATH shim; `VV_NET=1` adds
  a real `yarn add is-number` through the shim). Deferred: the cosmetic DNS-probe "no internet"
  warning.
- **Phase 5 — pnpm proven AND wired (this change).** The riskiest PM: pnpm drives real
  `worker_threads` (`dist/worker.js` for fetch/extract) and builds a **symlinked** `node_modules`
  (`node_modules/<pkg>` → `.pnpm/<pkg>@<ver>/node_modules/<pkg>`). Both work as-is — the
  Process-Worker model runs the nested threads, and the Rust VFS's `symlink`/`readlink`/`lstat`
  back the virtual store, so `require()` resolves through the links. `scripts/spike-pnpm.mjs`
  (off-disk Path B) passes A `pnpm --version` → `9.15.9`, B https egress, C real `pnpm add
  is-number` (`.pnpm` store + `pnpm-lock.yaml`, require-able via the symlink). The ONLY runtime
  gap was `util.types.isBoxedPrimitive` (pnpm's registry/JSON path) — added with the rest of the
  boxed-primitive + typed-array predicates in `node/internal/util/types.js`. Then wired into the
  studio exactly like npm/yarn: `scripts/vendor-pnpm.mjs` packs `pnpm@9.15.9` into
  `packages/studio/public/vendor/pnpm-pack.bin` (~3.7 MB gz / 16 MB raw, 898 files — the 4
  darwin/win `*.node` reflink addons are dropped since Linux uses the JS fallback);
  `packages/kernel-host/load-real-pnpm.js` (`ensureRealPnpm`) unpacks to `/usr/lib/node_modules/
  pnpm` (the ~8.8 MB `dist/pnpm.cjs` via `writeLarge`) and installs `/bin/pnpm.js` + `/bin/pnpx.js`
  shims; the kernel worker calls it after `ensureRealYarn()`. Since a user types bare `pnpm add`
  (no room for flags), the shell env supplies pnpm's config the npm way: `npm_config_
  package_import_method=copy` (no hardlink/reflink CoW in our VFS) + `npm_config_store_dir=
  /tmp/.pnpm-store` + `XDG_*` under `/home/user`. Gated headlessly by
  `scripts/spike-pnpm-studio.mjs`, which uses that SAME env (not CLI flags) so it verifies the
  studio config. Deferred: corepack version management (Phase 6).

- **Phase 6 — corepack proven AND wired (this change).** corepack is Node's PM *version
  manager*: it reads a project's `packageManager` field, **downloads that exact yarn/pnpm/npm
  release** (gunzip + untar + sha512 integrity), and execs it — so a project can pin any version,
  not just our hard-vendored one. `scripts/spike-corepack.mjs` (off-disk Path B) passes A
  `corepack --version` → `0.35.0`, B https egress, C real `corepack yarn --version` in a project
  pinned to `yarn@1.22.22` → downloads from `registry.yarnpkg.com`, extracts, and prints
  `1.22.22`. Five runtime gaps surfaced along the download→extract→exec path, all fixed
  generically (each helps the wider ecosystem, not just corepack):
  1. `require('module').runMain` — corepack execs the downloaded PM in-process via it
     (added to the `module` builtin in `runtime/index.js`, plus no-op `enableCompileCache`/
     `flushCompileCache` so corepack skips bundling `v8-compile-cache`).
  2. `internal/fs/dir` now reads **eagerly** in the `Dir` constructor, so `opendir` on a missing
     dir fails at OPEN time (ENOENT) like real Node — corepack probes install dirs that way and
     relies on catching ENOENT to decide it must download.
  3. `Readable.fromWeb` is implemented (a reader pump) in `internal/webstreams/adapters.js` —
     corepack streams the tarball out of the global `fetch()` response body through it.
  4. A WHATWG stream reader's `read()`/`cancel()` promises now **ref the event loop**
     (`ReadableStreamDefaultReader`/`BYOBReader` wrapped in `runtime/index.js`, like `fetch`),
     so consuming a `fetch` body incrementally doesn't race the loop to exit mid-download.
  5. `crypto.Hash`/`Hmac` now extend `stream.Writable`, so idiomatic
     `stream.pipe(createHash(algo))` + `hash.digest()` works (real Node's Hash *is* a Transform).
  The one thing our crypto layer *can't* do is corepack's registry ECDSA **signature** check
  (no `crypto.verify`), so the shell sets `COREPACK_INTEGRITY_KEYS=0` — corepack's official
  escape hatch that skips the signature check while KEEPING the sha512 tarball-integrity check
  (which uses `createHash`). Then wired into the studio like the others:
  `scripts/vendor-corepack.mjs` packs `corepack@0.35.0` into
  `packages/studio/public/vendor/corepack-pack.bin` (~0.12 MB gz / 0.6 MB raw, 54 files);
  `packages/kernel-host/load-real-corepack.js` (`ensureRealCorepack`) unpacks to
  `/usr/lib/node_modules/corepack` and installs **only** `/bin/corepack.js` (the direct
  npm/yarn/pnpm shims stay the defaults — corepack is the extra "run a project-pinned version"
  path); the kernel worker calls it after `ensureRealPnpm()`. The shell env adds
  `COREPACK_HOME=/tmp/.corepack` + `COREPACK_INTEGRITY_KEYS=0` +
  `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`. Gated headlessly by `scripts/spike-corepack-studio.mjs`
  (`VV_NET=1` downloads+runs `yarn@1.22.22` AND `pnpm@9.15.9` via the shim, env config only).
  This completes the package-manager North Star: npm, yarn, pnpm all run for real, and corepack
  manages their versions.

### A real test runner in-VM — Vitest 4 (this change)

Proof that the runtime runs a **full modern test runner**, not just package managers.
`scripts/spike-vitest.mjs` installs `vitest@4.1.10` in-VM with the real npm (which selects the
**wasm** rolldown/lightningcss builds, same as the studio Vite demo), then runs a two-test suite to
green AND a negative-control suite that must be REPORTED as failing (guards against false-positive
green from tests that never execute). Vitest is Vite/rolldown-based and drives tests through a
worker pool; our process model has `worker_threads` but not `fork`, so the runner is invoked with
`--pool=threads --no-file-parallelism --no-isolate`. Six runtime gaps surfaced along
boot→transform→collect→execute, each fixed **generically** (all help the wider ecosystem):

1. **`process.execArgv`** was missing — vitest's bundled `cac` chunk does
   `process.execArgv.map(...)` at module top level. Added as `[]` (`builtins/process.js`).
2. **ESM→CJS transpiler desync on regex-in-template-interpolation.** `skipBalanced` (used when the
   scanner descends into `` `${…}` ``) didn't handle regex literals, so a `"` inside a regex (e.g.
   `` `"${v.replaceAll(/"|\\/g, "\\$&")}"` `` in `@vitest/pretty-format`) was misread as a string,
   swallowing the matching `}` and losing later top-level `export`s → "Unexpected token 'export'".
   `skipBalanced` now descends regex literals with the same `canRegex` heuristic as the top-level
   scanner (`esm.js`).
3. **`node:path/posix` / `node:path/win32`** subpath builtins weren't registered (vitest's mocker
   requires `node:path/posix`). We're posix, so both map to what `path` carries (`runtime/index.js`).
4. **`worker_threads` `Worker.stdout`/`.stderr` were `null`** — the pool does
   `new Worker(entry, { stdout: true, stderr: true })` then `worker.stdout.pipe(logger.outputStream)`.
   They're now inert but pipe-able `Readable`-shaped stubs (the child's real output already flows
   through the kernel; test results travel over the message channel). Also added
   `process.stdout.getMaxListeners()` (the pool bumps `setMaxListeners(1 + getMaxListeners())`).
5. **`module.isBuiltin`** was missing — vitest's module runner classifies specifiers with it. Added
   as part of the `module`-constructor work below.
6. **`vm.runInThisContext` must return the script's completion value.** Vitest wraps each module as
   `'use strict';async (…)=>{…}` and *calls* what `runInThisContext` returns. Our shim used
   `new Function(body)` which returns `undefined` for a body with no `return` → "is not a function".
   It now uses **indirect `eval`** (runs in the global scope AND yields the trailing expression's
   value — the arrow function), matching real `vm` (`node/lib/vm.js`).

Known follow-up: **vitest.config / vite.config file bundling** fails with "Invalid URL" deep inside
rolldown-wasm's config bundler, so options are passed as CLI flags for now (config-less run). And
the default `--pool=forks` needs `child_process.fork` (unsupported) — `--pool=threads` is the
supported path.

### `module` builtin is a real, patchable constructor (this change)

Node's `module` builtin default export **is** the `Module` class; tools reach for its seams
directly. Previously `require('module')` returned a plain object. Now `builtins.module` **is** the
`Module` constructor (`runtime/index.js` + `module.js`), with:
- `Module.Module === Module` (self-ref), `createRequire` (now also accepts `file://` URLs, e.g.
  `createRequire(import.meta.url)`), `builtinModules` (public list, no `node:`/`_` names),
  `isBuiltin`, `runMain`, `syncBuiltinESMExports`, no-op `register`/`registerHooks`,
  `enableCompileCache`/`flushCompileCache`.
- Static resolver/loader seams: `_cache`, `_extensions`, `globalPaths`, `wrapper`/`wrap`,
  `_nodeModulePaths`, `_resolveFilename(request, parent, isMain, options)` (honors `options.paths`),
  and **`_load(request, parent, isMain)`** — the central require funnel. `makeRequire`'s `require`
  now routes through `Module._load`/`Module._resolveFilename`, so monkey-patching those (ts-node,
  tsx, jest, proxyquire, module-alias) actually intercepts every require, exactly like Node.
- Instance methods: `prototype.require` (→ `_load`), `prototype.load(filename)`, and
  `prototype._compile(content, filename)` (ts-node/tsx build a Module then `_compile` transpiled
  source). `compile()` gained an optional pre-supplied source for this.
- `require.main` is a **live getter** and `runMain` publishes the entry as `require.main` /
  `process.mainModule` / `Module.main` **before** the entry body runs, so the ubiquitous
  `if (require.main === module)` guard is true inside the entry itself.

Debug aid also added: `VV_TRACE_MODULES=1` names the module whose top-level evaluation throws (a
runtime throw in a module body is otherwise anonymous in the stack) — invaluable for bringing up
big bundled tools.

- **PM capstone — retire the Turbo-analog, `npm ci`, and batch the boot write-storm (this
  change).** Three loose ends from Phase 3's "Still deferred" list, now closed:
  1. **Turbo-analog retired from the shipped product.** `programs/npm.js` is no longer in
     `COREUTILS`, so `installCoreutils()` no longer writes a fake `/bin/npm.js` — studio boots the
     REAL npm CLI (`ensureRealNpm`) as the *only* npm, and a missing asset now means "no `npm` on
     PATH" (like yarn/pnpm), not a silent downgrade to the analog. The analog survives ONLY as an
     **offline test fixture**: `scripts/verify-node.mjs` and `scripts/verify-express.mjs` import
     `NPM_PROGRAM` and write it to `/bin/npm.js` themselves, so `verify-node`'s deterministic,
     network-free install/tar/hoist/`.bin`/napi coverage (#9–#11) keeps running without vendoring
     the ~12 MB real-npm asset into that fast unit gate. `npm run verify` stays green.
  2. **`npm ci` proven.** `scripts/spike-npm.mjs` gained a gate: after a real `npm install`
     produces `package-lock.json`, `npm ci` does a clean, lockfile-driven reinstall (Arborist's
     `loadVirtual` path + a recursive `node_modules` wipe + re-extract into the VFS) and the tree is
     still present — **PASS**.
  3. **Boot write-storm batched.** Delivering a PM tree used to be one SAB round-trip per file
     (~2400 for npm), each a separate cross-worker hop. New `kernel.writeFilesBatch(files)` →
     `kernel-fs.writeFilesBatch` concatenates every body into ONE transferable `ArrayBuffer` and
     sends a single `fs-write-batch` message; the FS Worker's `FsServer.writeBatch` mkdirp's parents
     and `write_file`s each slice in one pass. All four loaders (`load-real-{npm,yarn,pnpm,corepack}
     .js`) now use it, replacing both the per-file `writeFile` loop AND the per-large-file
     `writeLarge` path (the batch transfer carries yarn's 5 MB `cli.js` / pnpm's 8.8 MB `pnpm.cjs`
     inline). Headless load of npm's 2408 files is ~135 ms; the real win is in the browser, where
     ~2400 worker hops collapse to one. Gated by the existing `spike-*-studio.mjs` (all green).

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
   - ✅ **llhttp → Wasm — DONE.** `internalBinding('http_parser')` is now **real llhttp
     compiled to Wasm** (`node/bindings/llhttp/`, reusing undici's prebuilt binary,
     base64-embedded and instantiated synchronously in-worker; regen via
     `scripts/vendor-llhttp.mjs`). The bridge (`llhttp/llhttp-parser.js`) mirrors Node's
     `node_http_parser.cc` for both requests and responses; the original pure-JS parser
     stays as an automatic fallback (main-thread sync-compile cap, or `VV_HTTP_PARSER=js`).
     Live Wasm advertises `process.versions.llhttp`. Guarded by the offline
     `scripts/spike-http-llhttp.mjs` and the extended `verify-node.mjs` http case (HEAD,
     204, chunked req+res, trailers, keep-alive). Same slow-path contract (no
     `isStreamBase`), so it's a true drop-in.
   - ⏳ **Deferred:** **raw byte-tunnel** streaming (true request/response streaming +
     binary bodies across the SW seam, replacing the buffered replay), and **`http2`**
     (needs `internalBinding('http2')`/nghttp2).
9. **Network/registry worker** [M] — *decomp.* ✅ **DONE.** A dedicated
   **`Fetcher Worker`** (`packages/core/src/workers/fetcher-worker.ts`) owns all outbound
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
    Full **Vite** additionally needs a Wasm bundler (esbuild-wasm / rolldown-wasi); ESM
    (#13) is now done. Deliberately
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
11. **`zlib` — Wasm codec + real `lib/zlib.js`** [M] — **DONE.** Node's **real `lib/zlib.js`
    runs verbatim** over `internalBinding('zlib')`, which is a thin JS adapter
    (`node/bindings/zlib.js`) on top of a **new Rust/Wasm codec** (`packages/codec`,
    flate2/miniz_oxide, ~53KB). The codec exposes a z_stream-accurate streaming API
    (`process(input, flush, outLen)` honouring avail_in/avail_out) so Node's chunk loop
    drives it unchanged; gzip framing (10-byte header + CRC32/ISIZE trailer, header parsing
    + zlib/gzip auto-detect on decode) is handled in Rust. This replaces the old Web-Streams
    shim and adds what it couldn't do: the **`*Sync` one-shots** (`gzipSync`, `inflateSync`, …)
    and a real `crc32`. Covers the whole zlib family — `deflate/inflate`, `deflateRaw/inflateRaw`,
    `gzip/gunzip`, `unzip` — sync AND async (`createGzip` etc. drive the async `binding.write`
    over `nextTick`), verified byte-for-byte against `node:zlib` (hermetic `verify-node`).
    The codec runs **in-process** (per process worker): the browser worker `initCodec()`s the
    web-target wasm, the headless worker `require`s the node target; both pass a `makeZStream`
    factory down through `bootProcess → createRuntime → internalBinding`. `memLevel`/`strategy`/
    preset dictionaries and `params()` retuning are accepted-but-inert (miniz_oxide limitation);
    **brotli/zstd** handles throw loudly (the codec is zlib-family only) — a follow-up can add
    the `brotli`/`zstd` Rust crates to the same codec. Wired into `npm run build` (`build:codec`).
12. **`crypto` — Wasm + WebCrypto (S2)** [L] — **DONE (S2).** `node/lib/crypto.js` now runs
    on `internalBinding('crypto')` backed by a second Rust/Wasm codec (`packages/crypto`,
    RustCrypto: md-5/sha1/sha2/hmac/pbkdf2/aes/cbc/aes-gcm, ~105KB). Node's crypto API is
    *synchronous* and SubtleCrypto is async-only, so — exactly like zlib (#11) — the sync
    primitives live in Wasm; `lib/crypto` buffers streamed input and calls them one-shot.
    Covers **createHash** (md5/sha1/sha224/256/384/512/512-256), **createHmac**, **pbkdf2/
    pbkdf2Sync**, and **createCipheriv/createDecipheriv** for **AES-CBC** (128/192/256, PKCS#7)
    and **AES-GCM** (128/256, incl. `setAAD`/`getAuthTag`/`setAuthTag`), plus WebCrypto-backed
    `randomBytes`/`randomFill`/`randomInt`/`randomUUID`. Verified byte-for-byte against the host
    `node:crypto` in `verify-node` (digests/HMAC/PBKDF2, AES-GCM tag + cross-decrypt of OpenSSL
    ciphertext + tamper-reject, AES-CBC). Robustness: md5/sha1/sha256 keep a pure-JS fallback so
    `createHash` (e.g. Express's `etag` at load) works even if the codec is missing. Threaded as
    `cryptoCodec` through `bootProcess → createRuntime → internalBinding`, instantiated per
    process worker (browser `initCrypto()`, headless `require`); wired into `npm run build`
    (`build:crypto`). `Hash`/`Hmac` extend `stream.Writable` (Phase 6), so idiomatic
    `stream.pipe(createHash(algo))` + `digest()` works — real Node's Hash is a Transform.
    Also covers a **symmetric-only `KeyObject`** (`KeyObject` + `createSecretKey`) so key-material
    APIs like `jsonwebtoken@9` HS\* work (see below).
    **Deferred (S3):** asymmetric sign/verify, RSA/EC keygen, createPrivate/PublicKey, DH, scrypt,
    X.509 — they throw loudly; these
    want a bigger codec + vendoring Node's real `lib/crypto` internals. (corepack's registry
    ECDSA signature check needs `verify`; it's skipped via corepack's `COREPACK_INTEGRITY_KEYS=0`
    escape hatch, keeping the sha512 tarball-integrity check that only needs `createHash`.)

    **`jsonwebtoken` (auth0/node-jsonwebtoken) HS256/384/512 — DONE, proven by
    `scripts/spike-jwt.mjs`.** `jsonwebtoken@9` is pure JS (jws/jwa/ms/lodash.*/semver, no native
    binding) so support hinged purely on crypto. The blocker was **key material**, not the HMAC
    primitive: `sign()`/`verify()` destructure `crypto.{KeyObject,createSecretKey,createPrivateKey,
    createPublicKey}`, run `secret instanceof KeyObject`, convert raw secrets via `createSecretKey()`
    (only after `createPrivateKey`/`createPublicKey` *throw*), require `key.type === 'secret'`, and
    then feed the `KeyObject` to `crypto.createHmac`. jwa additionally gates KeyObject support on
    `typeof crypto.createPublicKey === 'function'`. Fix = a **symmetric-only `KeyObject`** in
    `lib/crypto.js`: a branded `KeyObject` class + `SecretKeyObject` (`.type === 'secret'`,
    `.export()`, `.symmetricKeySize`), `createSecretKey(key[,enc])`, `createPrivateKey`/
    `createPublicKey` as **callable-but-throwing** stubs (load-bearing: their throw drives
    jsonwebtoken's fallback to `createSecretKey`, and their mere presence flips jwa's
    `supportsKeyObjects`), `createHmac` taught to unwrap a secret `KeyObject`, and
    `util.types.isKeyObject` wired to the brand. Zero Wasm changes — the RustCrypto HMAC codec was
    already there. The spike round-trips HS256/384/512 sign+verify, wrong-secret + expiry rejection,
    and a `KeyObject`-as-secret input. **Asymmetric RS256/ES256/PS256 remain unsupported** (they need
    the S3 `createSign`/`createVerify` + RSA/EC codec work above); jsonwebtoken now fails them with a
    clean `secretOrPrivateKey must be an asymmetric key when using RS256` rather than an `instanceof`
    crash.
13. **ESM (`import`/`export`)** — **DONE (S1: transpile ESM→CJS at load time).** Our
    module system is synchronous CJS, so instead of a spec ESM loader we rewrite import/
    export down to `require`/`exports` in `compile()`, exactly like a bundler's interop
    layer. `es-module-lexer` (vendored `dist/lexer.asm.js` — pure-JS asm build, **sync, no
    wasm/init**, so no extra per-worker artifact and nothing to thread through boot) locates
    every import/re-export statement, dynamic `import()`, `import.meta`, and export name;
    `packages/runtime/esm.js` does the rewrite. Covered: static import (default/named/
    namespace/side-effect), re-export (`export {x} from`, `export *`, `export * as ns from`,
    `export {default as}`), local exports (const/let/var/function/class + `export {}` +
    `export default`), dynamic `import()` (→ Promise, relative to the module), and
    `import.meta.url`/`resolve`. Interop with CJS uses standard `__esModule` rules; live
    bindings modeled with getters. Resolver upgraded: `.mjs`/`.cjs` extensions + `index.*`,
    and package.json **`exports`** conditions (`require`→`import`→`default`, subpaths +
    `./*` wildcards). Detection: `.cjs` is always CJS; everything else is transpiled only if
    it actually uses module syntax (pure CJS files are returned untouched — real `express`'s
    ~70-pkg CJS tree still passes). Verified headless (13 assertions: named/default/ns/
    re-export/live-binding/`.js`-as-ESM/`exports`-field/CJS↔ESM interop/import.meta/dynamic
    import) + a browser `/api/esm` route. **Deferred (documented casualties):** top-level
    await (our wrapper is a sync function) and exact circular-eval binding order.
**Compatibility consolidation (ongoing, between features):** fill builtins that
previously threw `no vendored Node builtin`, so more real packages load. Done so far:
`punycode` (vendored verbatim from punycode.js@2.3.1 — the exact module Node bundles),
`dns` (loopback-aware shim: every name → 127.0.0.1/::1 since the virtual net is
in-process loopback — this **unblocks the vendored `net.js` hostname path**, so
`net.connect(port, 'localhost')` and hostname `listen` now work; callback + promises
APIs), `timers/promises` (`setTimeout`/`setImmediate`/`setInterval` on the event loop +
`AbortSignal`), `console` (require-able `Console` class over custom streams via
`util.format`), and `constants` (deprecated flat aggregate of fs + signal + errno).
Verified in `verify-node` (7 assertions). Note (honest): `tty`/`url` stay **shims by
design**, not temporary hacks — there is no real TTY in the browser, and the platform's
WHATWG `URL` already backs the legacy `url` API; vendoring Node's native-bound versions
would add no fidelity. `vm` is likewise a **pragmatic shim** (`node/lib/vm.js`): a Worker/Wasm
sandbox has no reachable V8 `contextify`, so `runInThisContext` runs via **indirect `eval`** in the
real global scope (faithful — it shares the caller's global AND returns the script's completion
value, which vitest's module evaluator relies on), while `runInNewContext`/`Script`/`createContext`
approximate a sandbox by binding its keys as parameters (not a true realm/boundary). Enough for
config/template evaluators (npm's `promzard`) and vitest's per-module wrapper. The `module` builtin
is now a **real, patchable `Module` constructor** (see "`module` builtin is a real, patchable
constructor" above): `_load`/`_resolveFilename`/`_nodeModulePaths`/`_cache`/`_extensions`/`wrap`/
`isBuiltin`/`createRequire`/`prototype.{require,load,_compile}` — so npm's `promzard`, ts-node/tsx
(`_compile`), and require-interceptors (jest/proxyquire patching `_load`) all work. Still missing
(throw): `dgram`; `tls`/`https` remain fetch-backed shims (no real TLS sockets).

14. **VFS worker split** [M] — **DONE.** The Rust/Wasm VFS now lives in its own dedicated
    `File System Worker` (browser `packages/core/src/workers/fs-worker.ts`, headless `scripts/fs-worker.mjs`),
    off the kernel's thread. **Routing (A1, direct-SAB):** a process's fs opcodes are
    serviced by that worker **directly over the process's own SAB** — the kernel is never
    on the fs path. At spawn the kernel opens a `MessageChannel` between each process and
    the FS Worker; `fs-client.js` routes by opcode (`isFsOpcode`) — fs ops ring the FS
    Worker's port doorbell, everything else (spawn/net/http/fetch) still nudges the kernel.
    No extra hops vs. the old inline path, so no latency regression. **Kernel's own fs**
    (boot seeding, PATH `isFile`, fetch-cache) stays synchronous via its own SAB channel to
    the FS Worker (`kernel-fs.js`, blocking `Atomics.wait` on the kernel thread — a Web
    Worker in the browser, Node's main thread headless). Fetched tarballs bypass the 1 MiB
    SAB entirely: the kernel hands the body to the FS Worker over a transferable
    `ArrayBuffer` (`writeLarge`). `Kernel` now takes an injected `fs` (not the raw `vfs`);
    `fsDispatch` moved into the env-agnostic `FsServer` (`packages/kernel-host/fs-server.js`).
    Verified headless (B1 — real split: `verify-node` 72/72 + `verify-express` full tree),
    exercising every fs opcode, `execSync` children, `npm install`, and the deferred
    `__ocfetch` path over the new worker boundary.
15. **Async spawn + streaming stdio** [M] — **DONE.** `child_process.spawn`/`exec`/`execFile`
    are now real and **non-blocking** (the sync `spawnSync`/`execSync` path is untouched).
    New opcodes: **`OP_SPAWN_ASYNC`** returns `{pid}` immediately (no `Atomics.wait`), and
    **`OP_KILL`** signals a child. The child's stdout/stderr and its exit are delivered to the
    **parent worker out of band** — kernel `postMessage`s (`child-stdout`/`child-stderr`/
    `child-exit`) since the parent isn't parked on its SAB — and the runtime replays them onto
    a real `ChildProcess` (EventEmitter with `Readable` `stdout`/`stderr`, `'exit'`/`'close'`,
    `.kill()`). Liveness mirrors `net`: a `childLiveness` counter keeps the parent's event loop
    alive while a child runs, a `doChildren()` drain step (like `doNet()`) delivers events in a
    controlled turn, and `'close'` waits for the stdio streams to end so a last chunk never
    races the exit. **Rewired to it:** `npm run <script>` and `npx` now async-spawn the leaf
    command (going through `sh` only when the script uses shell operators), so a **long-running
    dev server** (`npm run dev`) streams live and holds the foreground instead of freezing on a
    buffered `spawnSync` that never returns. Verified headless (`verify-node`: live streaming
    across timers + exit code + `kill('SIGTERM')` → null code/`SIGTERM`) and in the browser
    (`/api/spawn`, plus a boot `npm run dev` that boots a real `:3200` server via async spawn).
    **Deferred:** ~~parent→child **stdin** pipe~~ (DONE, now binary-safe), ~~`fork`~~ (DONE),
    ~~pipes (`|`)/redirects in `sh`~~ (DONE), `detached`/process groups.
    **Extras (ongoing, unrelated):** nested `worker_threads` (our `[worker n]`, #16 2b), heavy
    toolchains (`esbuild`/`vite`/`tsserver` as Wasm), IndexedDB persistence, pre-warm worker pool.
16. **WASI + napi-rs Wasm runtime (native→wasm packages)** [XL] — **stage 1 + 2a + 2b core + 2c DONE.**
    Many modern toolchains ship a `wasm32-wasi` build of their native `.node` addon and
    switch to it on a WebContainer-class host (e.g. Vite's `rolldown` downloads
    `@rolldown/binding-wasm32-wasi`; also `@napi-rs/*`). Two halves: (a) a **WASI preview1
    shim** bridged to our VFS, and (b) **napi-on-wasm** (`emnapi`) for N-API addons.
    - **Stage 1 (WASI preview1) — DONE.** `require('wasi')` (`packages/runtime/node/lib/wasi.js`)
      implements Node's `WASI` class over our world: fd/path calls → real `fs` (→ VFS in the
      File System Worker), argv/environ from the constructor, clock from Date/perf, randomness
      from WebCrypto, stdio through `process`. `.start()` runs `_start` and returns the exit
      code (proc_exit unwinds). Proven by a **real Rust CLI compiled to `wasm32-wasip1`**
      (`packages/wasi-demo`, vendored `.wasm`, `npm run build:wasi-demo`) run unmodified via
      sync `WebAssembly.Module`/`Instance` (allowed in a Worker for any size). It reads
      argv/env, opens a preopened dir, reads+uppercases a file, writes an output file +
      stdout — output matches the **host's own `node:wasi`** byte-for-byte (real interop, not
      a self-check). Verified headless (`verify-node`, 3 assertions) + a browser `/api/wasi`
      route. CLI-critical calls are real (args/environ/clock/random/fd_read/fd_write/fd_seek/
      fd_close/fd_fdstat/fd_filestat/fd_prestat/fd_readdir/path_open/path_filestat/path_create_
      directory/unlink/rmdir/rename/symlink/readlink); sockets + a few rare `path_*`/`fd_p*`
      variants are stubbed to sensible errnos. **Deferred:** stdin, `poll_oneoff` (event-driven
      guests), thread/`sock_*` support.
    - **Stage 2a (napi-on-wasm, sync addons) — DONE.** A **real N-API native addon**
      (`@node-rs/crc32-wasm32-wasi`, a Rust crate → `wasm32-wasi`) now runs **unmodified via
      `require()`**. Key finding: the whole napi host is **pure JS** — we vendor
      `@napi-rs/wasm-runtime` (esbuild-bundled to one self-contained CJS: emnapi
      `@emnapi/core`+`runtime`+`wasi-threads`, `@tybys/wasm-util`, tslib) as a lazy builtin
      (`packages/runtime/node/vendor/napi-wasm-runtime.js`). It implements the ~150 `napi_*` C
      ABI functions in JS over a handle table; the addon's `wasi_snapshot_preview1` imports are
      satisfied by **our own `require('wasi')`** (compatible because reactor addons take the
      `wasi.initialize()` path — no `_start`, no `node:wasi` internals). Three runtime enablers:
      (1) `require()` export-condition order now prefers CJS `default` over ESM `import` (Node's
      require() semantics — fixed dual packages like tslib); (2) a minimal `worker_threads` shim
      so napi wrappers load (`Worker` throws until 2b, but sync addons never construct it —
      emnapi's async-work pool is lazy); (3) `wasi.initialize()` reactor path. Verified headless
      (`verify-node`: crc32/crc32c + a `Buffer` arg via `napi_get_buffer_info`, matching host
      Node byte-for-byte) + a browser `/api/napi` route. Addon vendored at
      `scripts/fixtures/napi-crc32/` (prebuilt `.wasm`, can't be rebuilt locally without
      wasi-sdk/@napi-rs/cli).
    - **Stage 2b (real `worker_threads`) — core DONE.** `new Worker(entry)` now spawns a **real
      nested thread**: a process worker asks the kernel to spawn a worker (its own syscall SAB +
      File System Worker registration, so the thread does real fs/net syscalls), and the kernel
      brokers only its lifecycle. Parent↔child *data* flows over a plain `MessageChannel` wired end
      to end — `port1` stays with the `Worker`, `port2` is transferred **through the kernel** to the
      child as its `parentPort` — so `postMessage()` (incl. `SharedArrayBuffer`) never touches the
      kernel. Messages pump into the event loop via a new `doThreads` drain step (like #15 child
      events), and a running `Worker` (parent) / an active `parentPort` 'message' listener (child)
      keeps the loop alive via a `threadLiveness` counter. Implemented: `Worker(entry,{workerData,
      argv,env,cwd,eval})`, `postMessage`/`on('message'|'online'|'exit'|'error')`/`terminate`/`ref`/
      `unref`, `parentPort`, `workerData`, `threadId`, `isMainThread`, `MessageChannel`/`MessagePort`.
      Wiring: `process.__wtHost` (index.js) → lazy `node:worker_threads` builtin; `boot.js` carries
      `threadPort`/`postRaw`; `kernel.handleThreadSpawn`/`handleThreadTerminate`; both `spawnWorker`s
      transfer the port. Verified headless (`verify-node`: workerData incl. a `SharedArrayBuffer`,
      `isMainThread=false`/`threadId>0` in the child, message roundtrip, Atomics-visible shared
      memory, child `process.exit(5)` → Worker `'exit'`) + a browser `/api/threads` route (sums
      1..N off-thread, result matches via message *and* shared memory). Deferred: transferring
      `MessagePort`s in a `transferList` across threads; `resourceLimits`.
    - **Stage 2b — napi-rs *async-work* addons: BLOCKED UPSTREAM.** A spike (`@node-rs/bcrypt`,
      `@node-rs/argon2`, both `wasm32-wasi`) showed emnapi's async-work model (**AWMT**) throws
      `TypeError: reading 'whenLoaded'` in `initWorkers` **before `onCreateWorker` is ever called** —
      and it reproduces on **stock Node 22** with `@napi-rs/wasm-runtime` **0.2.12 *and* 1.1.6**
      (`@emnapi/core` 1.11.2). Root cause: AWMT expects `emnapi_async_worker_create` to spawn the
      pthread *synchronously*, but web/Node worker load (`load`→`loaded`) is async, so
      `PThread.pthreads[tid]` is undefined. So real `worker_threads` (above) does **not** unblock
      async napi addons — the gap is in emnapi, not our layer. Sync napi addons (crc32, 2a) are
      unaffected. Revisit when napi-rs/emnapi fix the async path, or when we tackle a wasi-threads
      (rayon/pthreads) workload directly (the likely `rolldown` path).
    - **Stage 2c (npm auto-selects the wasm build) — DONE.** `npm install @node-rs/crc32`
      now installs **only** the `*-wasm32-wasi` variant. napi-rs publishes one package per
      platform as `optionalDependencies` (14 for crc32) each gated by a `cpu`/`os` allow-list;
      the installer (`packages/kernel-host/programs/npm.js`) walks `optionalDependencies` as
      **non-fatal, platform-gated** jobs: a cheap name pre-filter skips the ~13 native builds
      with no network round, and `platformOk` (checks the manifest `cpu` allows `wasm32`,
      honouring `!neg` entries) drops any that slip through. The package's own generated
      loader then falls back to that wasm binding, so `require('@node-rs/crc32')` works
      unmodified — no runtime change needed (we already report `process.arch === 'wasm32'`,
      and `@napi-rs/wasm-runtime` resolves to our vendored builtin). Verified headless
      (`verify-node`: an offline 3-variant napi fixture — wasm installs, darwin name-skipped,
      neutral-named x64 fetched-then-cpu-skipped, meta re-export require-able) + a browser boot
      step doing the real `npm install @node-rs/crc32` live from the registry. Like StackBlitz
      auto-downloading `rolldown-wasm`; pairs with the North-Star "detect env → fetch wasm".
      Deferred: `os`/`libc` gating (cpu is the definitive signal for wasm) and skipping deps
      already provided as builtins (currently re-installed but harmlessly shadowed).
    - *Note:* esbuild-wasm is **Go/js** (uses `wasm_exec.js`, not WASI) and `@swc/wasm` is
      **wasm-bindgen web** (not WASI) — those are separate loaders, not covered by this item.
    Depends on: stable fs/VFS contract (#14 ✓), ESM (#13 ✓).

17. **Real bundler in-VM — Bundler Stage 1 (esbuild-wasm) — DONE.** A real, unmodified
    bundler (esbuild, Go→wasm) now runs inside Vivari. esbuild's Node entry
    (`lib/main.js`) `child_process.spawn`s a helper `node bin/esbuild` and talks to the Go
    runtime over **stdin/stdout pipes** (needs a real readable stdin fd + Go's
    `wasm_exec_node.js` — the hard path we skip). Instead we load its **browser build**
    (`esbuild-wasm/lib/browser.js`) with **`worker:false`**, which runs the Go wasm on the
    current thread with postMessage-simulated stdio — no child process, no stdin fd. The
    only runtime gap was the `self` global (browser Workers have it; the headless Node
    worker did not) → aliased to `globalThis` in `packages/runtime/index.js`; everything
    else (crypto.getRandomValues / performance / TextEncoder / WebAssembly / subpath require
    / `require.resolve` of a `.wasm`) already existed. Verified headless (`verify-express`:
    `transform` TS→JS + `build` bundle ESM→IIFE) and a browser `/api/esbuild` route
    (installs the ~11MB wasm on demand, caches the service). Two learnings: use synchronous
    `new WebAssembly.Module` (the async `WebAssembly.compile` promise resolves off our event
    loop, which then exits early on a bare `node script.js` — the same liveness gap npm.js
    works around with a ref'd keep-alive; long-running server processes are unaffected).
    Stretch (later): full **Vite** (rollup + dozens of deps + a dev server) is much larger.
    - **Loop-liveness for host-backed promises — DONE.** A new `hostLiveness` counter
      (`packages/runtime/index.js`) refs the loop while a host-backed async op is pending and
      wakes the idle wait when it settles, so a bare `node script.js` that only `await`s
      `WebAssembly.compile` / `fetch` / a `DecompressionStream` (via `Response`/`Blob` body
      readers) no longer races the loop to exit — no manual keep-alive needed. The few entry
      points are monkey-patched to track their returned promise (idempotent, per-process
      realm). Verified headless (`verify-node`: a bare `await WebAssembly.compile` prints and
      exits 0).
    - **`process.exit()` from any context — DONE.** exit() used to throw a sentinel that only
      the loop's `runCallback` caught, so calling it from a raw Promise microtask (async
      continuation / `.then` / `.catch` / `queueMicrotask`) escaped the loop and crashed the
      worker (Node aborts on the unhandled rejection). Now exit() also flags the loop
      (`onExit -> loop.requestExit(code)`, `packages/runtime/{index,loop,builtins/process}.js`)
      so `drive()` returns the right code, and a host-realm safety net swallows the escaped
      sentinel (Node: `process.on('unhandledRejection'|'uncaughtException')`, re-throwing
      genuine errors; browser: `unhandledrejection`/`error` listeners, only preventing the
      default for our sentinel). Verified headless (exit from an async continuation → code 3;
      exit from a `.catch` → code 7). The esbuild test now runs in its clean form — no
      keep-alive timer, `process.exit(0)` straight from the async body.

18. **Real Vite — `vite build` runs the rolldown wasm bundler in-VM — DONE.**
    `npm install vite` (Vite 8 / rolldown-vite, ~21 pkgs) succeeds, `require('vite')` returns
    the full public API (`build`, `createServer`, `defineConfig`, `transformWithEsbuild`, …),
    and **`vite.build()` completes a real production build** — the actual `@rolldown/binding-
    wasm32-wasi` bundler (napi-on-wasm) transforms the module graph over nested worker threads
    and writes `dist/` (verified end-to-end: `dist/index.html` + a hashed `dist/assets/*.js`
    that contains the app code). npm auto-selects `@rolldown/binding-wasm32-wasi` +
    `@napi-rs/wasm-runtime` (stage 2c path). Getting the whole graph to resolve — and then to
    *run* — surfaced (and fixed) a batch of general capabilities, each a real feature, not a
    Vite hack:
    - **fs whole-file > 1 MiB (EFBIG) — fixed.** `readFileSync(path,'utf8')` took a single-shot
      whole-file path that overflowed the 1 MiB shared window on big files (this is what blocked
      installing packages with large packuments). FS server now returns a clear `EFBIG` for any
      oversized response; the binding falls back to the chunked fd loop. (`fs-server.js`,
      `node/bindings/fs.js`).
    - **ESM `__dirname` collision — fixed.** Transpiled ESM modules no longer get
      `__filename`/`__dirname` wrapper params (real ESM has none; they use `import.meta.url`).
      Vite's chunks self-declare `const __dirname = fileURLToPath(...)`, which used to throw
      "already declared". (`module.js`).
    - **Namespace-import lazy getters — fixed.** `import * as fs` no longer force-evaluates every
      lazy getter on the source (which eagerly dragged in `internal/fs/streams` via `fs.ReadStream`);
      `__oc_ns` now defines forwarding getters (also more correct for ESM live bindings). (`esm.js`).
    - **package.json `imports` (`#…`) field — added.** Subpath imports resolve against the nearest
      package scope with the same conditions as `exports` (e.g. Vite's `#module-sync-enabled`).
      (`module.js`).
    - **New builtins:** `fs/promises` (+`fs.promises`, a faithful promise wrapper over the sync
      API + a `FileHandle`), `perf_hooks` (over global `performance`), `readline` (non-throwing
      shim — no real TTY), `v8` (heap stats + JSON-based serialize/deserialize), `http2`
      (load-safe stub; factories throw only if used — http1 path unaffected).
    - **ESM `require` collision — fixed.** ES modules routinely reintroduce require via
      `import { createRequire } from 'module'; const require = createRequire(import.meta.url)`
      (rolldown's chunks do exactly this). The transpiler's generated code now uses `__oc_require`
      (import rewrites, `__oc_import`, `__oc_meta.resolve`) and we inject the require under that
      name, so ESM code can freely declare its own `require`/`__filename`/`__dirname` without a
      "already declared" throw. (`esm.js`, `module.js`).
    - **Loop drains microtasks before checking handles — fixed.** `drive()` used to gate its whole
      body on `while (hasRefWork())`, so an **async `main`** (`await vite.build()`) whose top-level
      promise is still pending with no handle yet made the loop see "nothing to do" and exit before
      the chain could even start. It now drains microtasks first each turn (Node drains after main,
      then consults handles), letting the async entry run and create its first handle. (`loop.js`).
    - **emnapi async-work keeps the loop alive — fixed.** rolldown's wasi worker pool is
      **unref'd** (`t && w.unref()`), and emnapi tracks outstanding async requests with a
      `NodejsWaitingRequestCounter` that ref/unref's a `MessagePort` — a no-op for our cooperative
      loop, so the parent went idle mid-build. We mirror that counter into our loop liveness
      (`process.__wtHost.retain/release`) in the vendored `@napi-rs/wasm-runtime`, so
      `await rolldown.bundle()` (and any napi async call) holds the process open until it settles.
      This is the general unblock for the #16 stage-2b AWMT concern along the rolldown path.
    - **`verify-express` thread wiring — fixed.** Its `spawnWorker` predated stage 2b and never
      forwarded `info.threadPort`, so nested workers booted with no `parentPort` and `vite build`
      hung forever. Now mirrors `verify-node` (threadPort in the init payload + transfer list).
    - Regression guard: `verify-express` installs vite, asserts `require('vite')` exposes
      `build`/`createServer`/`defineConfig`, **and runs `vite.build()` to completion** (no
      keep-alive — the process exits naturally), asserting `dist/` is written with the app code.
    Not yet: the **dev server** (`vite dev` / `createServer`) — needs a long-lived HTTP server plus
    a websocket HMR channel and file watching. Build (the hard bundler path) is done. See #19.

19. **Real Vite dev server (`vite dev` / `createServer`) — IN PROGRESS.**
    Goal: `vite dev` boots in-VM, serves the app in the preview iframe, and does live HMR.

    **How StackBlitz/WebContainer does it (reference we're mirroring):**
    - **rolldown's wasm binding** is downloaded *on demand at runtime* when it detects a
      WebContainer (rolldown prints `[rolldown] Downloading @rolldown/binding-wasm32-wasi@… on
      WebContainer…`; detection via `@webcontainer/env` / env heuristics). **We already do this
      one step earlier** — our npm auto-selects the `wasm32-wasi` build at install time (#16 stage
      2c) — so we never hit the runtime download.
    - **Preview** is a *credentialless iframe on a separate origin* (`*.webcontainer.io`); HTTP is
      served by a Service Worker intercepting the iframe's `fetch` and routing to the in-VM server
      (no TCP). We do the same today but *same-origin* under `/preview/<port>/` (`demo/sw.js`).
    - **HMR has no real WebSocket** (confirmed: DevTools ▸ Network ▸ Socket is empty). A native
      `WebSocket` from the iframe can't reach an in-process `WebSocketServer` — no TCP, and a
      **Service Worker cannot intercept the WS upgrade**. Two known patterns: (C1) *polyfill the
      `WebSocket` global* in the runtime so it tunnels over postMessage/loopback instead of the
      network (StackBlitz's approach — framework-agnostic, needs RFC-6455 framing + a 2-way
      iframe↔kernel byte tunnel); (C2) a *custom Vite HMR transport* that ships an inlined iframe
      client speaking `BroadcastChannel` (rifty's approach — no WS framing, but Vite-specific and
      needs config/inject). Both need a durable 2-way channel across the page↔iframe↔worker realm
      boundary, likely a separate preview origin + `BroadcastChannel`/`postMessage` (not the SW).
    - Their worker layout maps ~1:1 to ours (process workers, Fetcher Worker, File System Worker,
      nested rolldown wasi `[worker N]`, `sw.js`); the rest (`typescript`, `editorWorkerService`,
      `prettier`, `engineworker.js`) are just the StackBlitz IDE (Monaco + tsserver), not runtime.

    **Current state in Vivari:** long-lived in-VM HTTP server ✅ (`http.createServer().listen`
    + event loop v2 + `netLiveness`). `vite build` ✅. **`vite dev` boots + serves static + watches
    + live HMR ✅** (Stages A/B/C below, all done): the preview bridge carries binary bodies
    (base64), `fs.watch`/`fs.createReadStream` are real, the listen path handles IPv6, push-based
    `fs.watch` drives Vite's watcher, and a `WebSocket` tunnel (in-VM RFC6455 client + iframe
    polyfill) pushes HMR updates to the preview with no reload. There is a genuine in-VM
    `WebSocket` over the http-upgrade + net loopback (the parser no longer drops `'upgrade'`).

    **Plan (staged, each with a demo):**
    - **Stage A — boot & serve static — DONE.** `vite.createServer().listen()` now boots a
      long-lived dev server in-VM and serves the app (HTML + on-demand-transformed JS + binary
      `/public` assets) through the same preview bridge as the demo. Fixes that got it there:
      - **`fs.watch` shim (`internal/fs/watchers`).** Vite's dev server always creates a chokidar
        watcher (`NodeFsHandler` → `fs.watch` per dir); with the binding unvendored that threw and
        crashed the boot. Added a load-safe, currently *inert* `FSWatcher`/`StatWatcher` (full
        EventEmitter/close/ref/unref surface, the shape Stage B needs) so the watcher builds and
        chokidar reaches 'ready'. It just doesn't emit changes yet — that's Stage B.
      - **IPv6 listen-address parsing (`cares_wrap.convertIpv6StringToBuffer`).** `server.listen()`
        runs `isIpv6LinkLocal()` over the resolved address (a name can resolve to `::1`); the old
        throwing stub crashed listen. Implemented a real parser (16-byte form, `::` compression,
        zone id, embedded IPv4) plus correct `isIP/isIPv4/isIPv6`.
      - **`fs.createReadStream` (`internal/fs/streams`).** Vite serves static `/public` files by
        piping `createReadStream(path,{start,end})` to the response; the binding was unvendored so
        it 500'd. Added a pragmatic `ReadStream`/`WriteStream` on `Readable`/`Writable` + the
        callback fs API (path|fd, flags, start/end range, hwm, encoding, autoClose, `open`/`ready`/
        `close`/`error`) — enough for static serving, range requests, log/tar writers.
      - **Binary body across the bridge (base64).** The kernel HTTP boundary is JSON, so bodies
        crossed as utf8 and corrupted images/fonts/wasm. `bridgeHttp` now sends a `bodyEncoding:
        'base64'` body whenever the bytes aren't losslessly utf8 (declared-textual types keep the
        utf8 fast path; a plain `res.end('...')` without a content-type stays a string), the kernel
        forwards the flag, and the Service Worker rebuilds exact bytes via `atob`.
      - **SW dev timeout.** Raised the preview Service Worker's per-request timeout 15 s → 60 s
        (dev does slow first-hit work: optimizeDeps / on-demand transform).
      - Regression guard: `verify-express` boots `vite.createServer().listen()` and asserts it
        serves index.html (with the injected `/@vite/client`), the transformed `/src/main.js`, and
        a binary `/public/pixel.png` byte-for-byte. (No HMR yet.)
    - **Stage B — real file watching — DONE.** `fs.watch` is now push-based, driven from the one
      place that sees every mutation: the **File System Worker**. Registration is an ordinary
      fs-routed SAB syscall (`OP_WATCH`/`OP_UNWATCH`) so the worker records `{clientId, watchId,
      path, recursive}` against the client's doorbell port; then on **every** VFS mutation
      (write/mkdir/unlink/rmdir/rename/symlink/open-create/fd_write/ftruncate/writeLarge) it fans
      out `{type:'fs-watch', watchId, event, filename}` back over that same duplex port to any
      watcher covering the path (Node semantics: `'rename'` on create/remove/rename, `'change'` on
      contents; `filename` relative to the watched dir). `boot.js` receives those on the fs port and
      hands them to the runtime, which drains them in a loop turn (`doWatch`) and emits Node's
      `('change', eventType, filename)` from the vendored `internal/fs/watchers` `FSWatcher`
      (`StatWatcher`/`watchFile` ride the same channel). A persistent watcher refs the loop
      (`watchLiveness`) like a real fs handle. Crucially this is **cross-client**: a host editor
      write, an in-VM terminal write, or another process all notify the watching dev server — no
      polling. Fan-out is zero-cost when nobody is watching (guarded on an empty registry).
      Regression guards: `verify-node` asserts a host write fires a guest process's `fs.watch`
      callback (`'rename'` then `'change'`); `verify-express` asserts editing `/vt/src/main.js`
      invalidates Vite's module graph so the dev server re-transforms it on the next request.
      - *Optimization — DONE.* Fan-out used to loop **every** registered watch on **every**
        mutation and run a `vfs.exists()` per write (to pick `rename` vs `change`), even for churn in
        unwatched subtrees like `node_modules` (`npm install` next to a dev server). Now watches are
        **bucketed by their path's top-level segment** (`FsServer.watchesByTop`): a mutation can only
        be *within* a watch dir if they share a first segment (or the watch is on `/`, bucket `""`,
        which covers all). `couldNotify(path)` is the ~O(1) gate — it short-circuits both the
        `exists()` probe and the fan-out when no bucket matches, and `notifyWatch` scans only the
        path's own bucket (+ the root bucket) instead of the whole registry. Correctness is exact
        (the coarse bucket only *narrows*; `relWithin` still does the precise check), so a hardcoded
        ignore list is unnecessary. Guard: `verify-node` asserts churn in an unwatched top-level tree
        never fires a watcher, while an in-tree write still does.
    - **Stage C — HMR transport — DONE (C1: polyfill `WebSocket` + real RFC6455 framing).** Live
      HMR now pushes to the preview iframe with no reload/poll. Chose C1 (framework-agnostic) over
      C2 (Vite-specific JSON transport): the *frames* are tunnelled, not Vite payloads, so any
      library using `WebSocket` works. Data path (both directions):
      `iframe WebSocket polyfill ⇄ host page (postMessage) ⇄ kernel worker ⇄ kernel (route by
      preview port) ⇄ the process owning that port ⇄ a genuine in-VM `WebSocket` client ⇄ Vite's
      `ws` HMR server` — all over the in-VM net loopback + http upgrade, no network.
      - **In-VM `WebSocket` client (`runtime/websocket.js`).** A real RFC6455 client: does the
        `Sec-WebSocket-Key`/`Accept` handshake over `http.request`'s `'upgrade'` event, then
        masks/encodes + parses frames (text/binary/ping/pong/close, continuation, all length forms)
        on the `net` loopback socket. `runtime/index.js` installs it *unconditionally* as
        `globalThis.WebSocket` (so guest code — and the relay — never picks up a host `WebSocket`).
      - **HTTP-parser upgrade fix (`bindings/http_parser.js`).** The parser reset `incoming` on
        detecting an upgrade (rv===2), so `onParserExecuteCommon` never saw `upgrade` and the
        `'upgrade'` event never fired. Added an `_upgradePaused` state that preserves `incoming` and
        stops after headers; `_http_server.js`/the client then complete the upgrade (incl. any
        first-frame `head` bytes that arrived with the 101).
      - **VM relay (`runtime/index.js`).** The kernel posts `ws-open`/`ws-in`/`ws-close` to the
        process owning the port; the relay opens one in-VM `WebSocket` per `connId` to
        `127.0.0.1:<port><path>` and relays decoded frames back out as `ws-out {sub:open|msg|close}`
        via `postRaw`. A `wsLiveness` counter refs the loop while tunnels are open; a brand-new
        socket that loses the loopback race before opening retries a few times.
      - **Kernel routing (`kernel-host/kernel.js`).** `handleWsClient` maps `connId → pid` (open
        routes by listening port), forwards frames, and `finalize` closes a process's tunnels on
        exit. `onWsSend` hands outbound frames to the environment.
      - **Browser wiring.** The preview Service Worker injects a classic (pre-`/@vite/client`)
        `WebSocket` polyfill into every served HTML page; it tunnels each connection to the host
        page, which relays to the kernel worker and back. `host.js`/`kernel-worker.js` bridge both
        directions (`vv-ws`).
      - **Demo.** A "Start real Vite dev + HMR" button `npm install vite` + boots `vite dev`
        (HMR on) in-VM on :5199, swaps the preview to it, and opens a multi-file editor. Editing
        `src/message.js` (a `import.meta.hot.accept` JS boundary) re-renders, and editing
        `src/styles.css` triggers Vite **CSS HMR** — both update the running preview **with no page
        reload**, showing the transport is content-agnostic.
      - **Root-scope preview SW.** Vite serves subresources at root-absolute URLs
        (`/@vite/client`, `/src/main.js`, `/node_modules/...`) that escape a `/packages/demo/`
        scope, so the preview Service Worker now controls the whole origin (registered with
        `scope: '/'`, allowed by a `Service-Worker-Allowed: /` header from `server.mjs`) and routes
        each root-absolute request to the right in-VM port by the **requesting iframe's client URL**
        (which carries `/preview/<port>/`). This keeps Vite at `base: '/'` and is framework-agnostic.
      - Regression guards: `verify-express` "vite HMR tunnel" boots a hmr-enabled dev server, plays
        the browser (`handleWsClient` + collect `onWsSend`), asserts the open ack + Vite's
        `{type:'connected'}`, then a live `update`/`full-reload` on edit. A second "ws tunnel"
        section installs the **real `ws` package** (a third-party ws *server*, unmodified, in-VM —
        proving the http-upgrade path both ways) and round-trips a text frame, a **binary** frame
        (byte-for-byte, exercising masking + `binaryType`), and a close through the tunnel.
    Order: A → B → C (HMR is meaningless before static serving + change detection work). **All three
    stages are DONE — `vite dev` boots, serves, watches, and hot-reloads in-VM.**

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

## Packaging & delivery (bundle-by-role — Stages 1 & 2 DONE)

In dev the browser loads the runtime as **individual, unbundled ES modules** (`os.js`,
`process.js`, the vendored `node/lib/*` + `node/internal/*`, …) — one network request
each (~120 modules, re-fetched per Worker role on first load). This is a **deliberate DEV
choice**: it keeps the vendored Node source readable, debuggable in DevTools, and trivially
diffable against upstream. The shipping shape is produced by a build step instead.

- **Bundle per worker role — DONE.** `npm run build:demo` (`scripts/build-demo.mjs`,
  esbuild) emits one minified bundle per role into **`packages/demo-dist/`** —
  `host.js` (main), `kernel-worker.js`, `process-worker.js` (the whole vendored Node
  runtime, ~120 files → 1), `fs-worker.js`, `fetcher-worker.js`, `sw.js`. Result: the
  process runtime collapses from ~120 requests to **1**. Serve it at
  `/packages/demo-dist/index.html`; dev (`packages/demo/`) stays unbundled and unchanged.
  - *Key trick — sibling output dir.* esbuild leaves `new URL(x, import.meta.url)`
    expressions **verbatim** (it does not bundle workers or copy url-token assets). Emitting
    to `packages/demo-dist/` (a sibling of `packages/demo/`, same depth under `packages/`)
    means the cross-worker refs (`new URL('./process-worker.js', import.meta.url)`) and the
    wasm refs (`../codec|crypto|wasi-demo/pkg/...`) resolve to the exact same files with
    **zero URL rewriting**; only `./vendor/` (relative to the demo dir) is copied alongside.
  - Static asset imports (`../codec/pkg/*.js`, `../crypto/pkg/*.js`, `../kernel-host/*`)
    are inlined into their role bundle; the `.wasm` binaries stay separate (fetched +
    compiled once in the kernel worker, the `Module` cloned to each process).

- **Precache the role bundles in the Service Worker — DONE (Stage 2).** `sw.js` now
  precaches the six role bundles + `index.html` on `install` and serves them (plus the
  runtime `.wasm` binaries and `vendor/`, cache-first + lazily populated) from Cache
  Storage. So every **Process Worker spawn** (which re-fetches `process-worker.js`, ~900 KB)
  and every reload is served from disk — instant, and the app works **offline**. Cache
  correctness across redeploys: `scripts/build-demo.mjs` stamps a per-build id into `sw.js`
  (esbuild `define: { __VV_BUILD_ID__ }`) that names the cache (`vv-precache-<id>`); a new
  build changes `sw.js` → the browser installs the new SW, whose `activate` deletes every
  older `vv-precache-*`. All of this is **gated on that build id**, so dev (`packages/demo/`,
  loaded unbundled) never caches — edits keep hot-reloading unchanged.

Further packaging work (deferred, lower value now that request count + spawn cost are solved):

- **Lazy-load heavy/rare modules** (`zlib`, `crypto`, full `stream` variants) as split
  chunks fetched on first `require` — small core bundle + on-demand tail.
- **Wasm stays a separate binary** (`WebAssembly.instantiateStreaming`), never inlined —
  already the case.
- **Transport compression (gzip/brotli): NOT app-level.** In deployment we sit behind
  nginx/CDN, which negotiates `Content-Encoding` per `Accept-Encoding` for free — doing it
  in-app would just duplicate that. Two infra notes for whoever deploys: (1) nginx's default
  `gzip_types` omits `application/wasm`, so add it (+ `application/javascript`); (2) prefer
  `gzip_static`/`brotli_static` over on-the-fly if pre-compressing at build time. COOP/COEP
  headers (needed for SharedArrayBuffer) must be re-set at the proxy — they don't propagate.
- **Source maps in dev only**, stripped for prod.

### Per-worker Wasm codec (zlib #11, crypto #12) — load strategy — DONE

Symptom (DevTools): `open_webcontainer_codec_bg.wasm` was fetched **many times** on load —
once per Process Worker. That was correct-but-unoptimized: the kernel Wasm loads once (one
kernel worker), but the codec runs **in-process**, and `process-worker.js` used to call
`initCodec()`/`initCrypto()` eagerly on every spawn — even for processes that never touch
zlib/crypto (`echo`, `sh`, most npm steps). The `ZStream` instance is stateful and can't be
shared cross-thread, so each worker DOES need its own *instance*; what was wasteful is
re-fetching + re-compiling the *bytes*. All three fixes landed:

1. **Lazy codec — DONE.** `process-worker.js` no longer inits at boot. `makeZStream` (zlib)
   instantiates the module on the first `makeZStream()` (i.e. first gzip/deflate stream), and
   the crypto binding gets a `Proxy` over the wasm namespace that instantiates on the first
   `digest`/`hmac`/`pbkdf2`/`aes*` call. Processes that never compress/hash → **0 compile**.
   `require('zlib')` still works (crc32 is pure-JS + constants). `initSync` from a pre-compiled
   `Module` is sync and allowed in a Worker (it already blocks on `Atomics.wait`), so
   `gzipSync`/`createHash` keep working. Headless (`scripts/process-worker.mjs`) defers the
   wasm-compiling `require(...pkg-node...)` to first use the same way (`require.resolve` still
   detects an unbuilt codec up front, no compile).
2. **Compile-once, share the `Module` — DONE.** `kernel-worker.js` `compileWasmModule()`
   fetches + `WebAssembly.compileStreaming` each codec **exactly once** at boot (concurrently
   with the VFS boot) and hands each Process Worker the resulting `WebAssembly.Module` in its
   `init` message (a Module is structured-cloneable across workers — cloned, not transferred,
   so it stays usable everywhere). Workers only `initSync({ module })` — no fetch, no recompile
   per spawn.
3. **`Cache-Control` for `.wasm` in `server.mjs` — DONE.** `.wasm` now serves `no-cache` +
   `Last-Modified` and answers `304` to `If-Modified-Since`, so page reloads revalidate cheaply
   (no re-download) while staying correct across `wasm-pack` rebuilds (mtime bump → fresh
   bytes). Everything else stays `no-store` so edited JS/HTML always reloads in dev.

NB: **lazy-`require` for the JS builtins (`fs`/`net`/`http`/…) is NOT worth it** — they have
no Wasm and are pulled in by *static* `import`s at the top of `loader.js`, so they're already
fetched before any `require()` runs. The real fix for the "rain of JS files" is bundling
(above), not lazy require.

## Open items / deferred (consolidated)

All bricks (1–5) and Phase 2 items (#1–19) are ✅. What remains is intentionally deferred —
none blocks the T2 goal; each is a coverage/perf/polish increment. Grouped by kind:

- **Perf / build:**
  - ✅ Compile **llhttp → Wasm** as a drop-in `http_parser` — DONE (see #8; real llhttp
    vendored from undici, pure-JS fallback, `node/bindings/llhttp/`).
  - ✅ Packaging Stage 2 (**SW-precache the role bundles**) — DONE. Remaining packaging
    polish (split-chunk rare modules, dev-only source maps) deferred; transport gzip/brotli
    is left to the deploy proxy, not app-level (see "Packaging & delivery").
- **Node API coverage (stubs/partials to fill on demand):**
  - `crypto` **S3**: sign/verify, RSA/EC keygen, DH, scrypt, X.509 (#12).
  - `child_process`: parent→child **stdin** pipe (#15). (`fork` is now implemented — an IPC
    channel over the worker-thread spawn path — which unblocked `next dev`.)
  - WASI: **stdin**, `poll_oneoff` (event-driven) (#16 s1).
  - `worker_threads`: transferring more complex objects (#16 s2b).
  - Stubbed builtins: `http2` (load-safe stub), `readline` (partial), `tls`/`https`,
    `dgram`, `perf_hooks`, `cluster`.
  - ✅ `module` builtin is now a real **constructor** (`Module.prototype.{require,load,_compile}`,
    `_resolveFilename`, `_load`, `_cache`, `_extensions`, `wrap`, `isBuiltin`, `createRequire`) and
    `require` routes through `Module._load`, so require-patching tools (`ts-node`, `tsconfig-paths`,
    jest, proxyquire, module-alias) can monkeypatch it. (Next's `require-hook` no longer trips on
    this — and Next 16 now boots in-VM on webpack + wasm SWC; see the framework matrix below.)
- **Network (browser-platform limits, not just unimplemented):**
  - Outbound raw TCP is impossible in a browser — only the fetch/WebSocket bridge exists.
  - HTTP: streaming request/response bodies, keep-alive, more concurrent in-flight (#8).
- **Persistence:** exact `mode`/`chmod` restore (needs a VFS `chmod`; files get default mode).
- **npm:** `package-lock.json`, `os`/`libc` optional-dep gating (#10/#16 s2c). (Real npm now
  BOOTS/installs/runs lifecycle scripts AND is the studio shell's `npm`/`npx` via a vendored
  delivery asset — see "Real package managers — progress" above. Remaining: `npm ci`, deleting
  the Turbo-analog `programs/npm.js`, batching the first-load write storm, and yarn/pnpm.)
- **Validation (framework matrix):** ran three popular stacks in-VM headlessly
  (`scripts/probe-react.mjs`, `scripts/probe-nest.mjs`, `scripts/probe-next.mjs`) to surface
  the next missing Node APIs. The architecture held up — every gap was "add API X", not a
  design change:
  - ✅ **React + Vite (rolldown) + React Compiler** — dev server serves transformed JSX,
    Fast Refresh wired, and the compiler emits its `_c(n)` memo cache + `react/compiler-runtime`
    import (real `@babel/core` running in-VM via `@rolldown/plugin-babel`). Surfaced & fixed:
    (a) ESM→CJS interop for `export { X as "module.exports" }` (rolldown/tsdown CJS-interop
    override) and `export { X as default }` brace form; (b) `crypto.hash` (one-shot, Node
    20.12+) used by Vite's dep optimizer.
  - ✅ **NestJS** — real `tsc` (TypeScript **5**) compiles the decorated TS app in-VM
    (`emitDecoratorMetadata`), then Nest boots with DI + `reflect-metadata` over
    `@nestjs/platform-express` and answers `GET / → 200`. Surfaced & fixed: the ESM wrapper
    injected `module`/`exports` as params, colliding with ES modules that legally bind those
    names (TS7's `getExePath.js` does `import module from "node:module"`) — the transpiler now
    emits `__oc_exports`/`__oc_module` so user bindings never clash. Also: `typescript@7` is the
    native Go port (`tsgo`, resolves a native `@typescript/*` binary) — pin `typescript@5`.
  - ✅ **Next.js (16, App Router)** — **boots in-VM and serves `GET / → 200`** on
    `next dev --webpack` + the `@next/swc-wasm-nodejs` wasm SWC compiler
    (`scripts/spike-next.mjs`). The old "hard native wall" verdict was wrong: Next 16 did **not**
    drop the wasm SWC fallback, and webpack is still selectable (only Turbopack — native Rust with
    no wasm build — is unavailable). Next's `loadBindings` prefers the wasm SWC when
    `process.versions.webcontainer` is set (now reported by the runtime), and npm skips the native
    `@next/swc-<platform>` optionalDeps on arch `wasm32`, so the wasm build is the only binding
    present. Surfaced & fixed to get RSC rendering working: (a) `vm.runInNewContext` now makes the
    sandbox the real global (`globalThis.__RSC_MANIFEST=…` lands on the context) so the client-
    reference manifest loads; (b) **real cross-`await` `AsyncLocalStorage`** — on a Node worker the
    runtime delegates to the host's async_hooks (V8 PromiseHook), without which the App Router
    `workStore`/`workUnitAsyncStorage` invariants fail. The browser has no PromiseHook, so the
    polyfill can't follow a native `await`; on a single-request-at-a-time dev preview it instead (i)
    holds a thenable-returning `run(store, cb)`'s store until it settles then pops "only if still
    top" **and never back to `undefined`** — a streaming RSC render returns its promise EARLY (when
    the stream is created) while React keeps rendering components detached across native awaits, so
    zeroing the store on settle throws `Expected workStore/workUnitStore to be initialized`;
    restoring a *defined* parent store is still safe (keeps nested scopes correct), (ii) does NOT
    restore on a plain (non-thenable) return — Next's `renderToFlightStream`
    returns a stream synchronously and renders later across raw awaits, so leaving `store` current
    keeps `getStore()` correct for that detached work until the next `run()` overwrites it, and (iii)
    propagates a per-hop context snapshot through the scheduling primitives React uses
    (`then`/`queueMicrotask`/`setImmediate`/`setTimeout`). Together these make the invariant
    deterministic (not timing-dependent). Validated headlessly with `VV_NO_HOST_ALS=1` (forces the
    polyfill): the RSC refresh render (the App Router's HMR "on save" re-render, `RSC: 1`) returns
    200 with 0 invariant errors across repeats — the same path that threw `workStore` in the studio —
    plus GET / 200, output byte-identical to the host-async_hooks path; (c) `child_process.fork`
    (Next forks its dev server over IPC) — its stdio streams to the parent (default `inherit`
    surfaces on the terminal, not the kernel console); (d)
    `pathToFileURL` relative→absolute; (e) `dns/promises`, `stream/web`, `inspector` stub, and the
    full `Console` method surface for `@edge-runtime/primitives`; (f) `module.findSourceMap`. The
    wasm SWC is seeded into Next's cache on `postinstall` (offline first compile; Next's own
    on-demand download is the fallback). Shipped as the **Next.js** template (TS + JS,
    `experimental`). The earlier `require('module')` monkeypatch gap (Next's `require-hook`) is also
    fixed — `module` is a real constructor.
  - The two working stacks are wired into a **VS Code-style IDE** (revamped —
    see below): a project picker (**React + Vite + React Compiler**, **NestJS**),
    an activity bar + Explorer, a Monaco editor with **multiple file tabs**, a
    bottom **terminal panel with tabs** (a read-only Console for demo output plus
    fully **interactive shells**), a command palette / quick-open, and a status
    bar, next to the live preview. Driven by the `DEMOS` registry + `startDemo()`
    and the `term-*` messages in `kernel-worker.js`.
  - ✅ **Interactive terminal (real stdin, VS Code-style workbench).** The demo is
    now a VS Code-like IDE: `index.html`/`host.js` render an activity bar, Explorer,
    tabbed Monaco editor, a tabbed terminal panel, a command palette (`Ctrl/Cmd+
    Shift+P`) + quick-open (`Ctrl/Cmd+P`), and a status bar. Each interactive
    terminal is backed by a **long-lived in-VM `sh`** — type a command, Enter runs
    it, cwd/env persist across commands, `+` opens more. This needed a real stdin
    path the runtime never had (it was a no-op sink): `process.stdin` is now a
    genuine **flowing TTY Readable** (`isTTY`, `setRawMode`, refs the loop while a
    consumer reads) fed by a kernel→worker `{type:'stdin'}` message drained in a
    loop turn (`doStdin`); `child.stdin.write()` relays parent→child via
    `{type:'child-stdin'}` → `kernel.handleChildStdin` → the child's own stdin; the
    kernel gained `sendStdin(pid)`; the `sh` coreutil gained a **REPL** (prompt,
    local echo, backspace, Ctrl+C→SIGINT the foreground child, Ctrl+D exit) that
    forwards raw input to a foreground child while one runs; `kernel-worker.js`
    maps each xterm ↔ a shell pid and routes output per-pid (`term-out` vs the
    Console). Also fixed `process.chdir()` to **resolve relative paths** (`cd sub`).
    Validated headlessly by `scripts/probe-term.mjs` (echo/cd/pwd/backspace over
    real stdin).
  - ✅ **Demo revamp — run the REAL dev flow, not a synthetic one.** Previously the
    demos hand-wrote `vite.createServer()`/`tsc` scripts and pre-built Nest. Now each
    demo scaffolds the **exact project layout `npm create vite@latest` / `nest new`
    emits** (`DEMOS[id].files`, checked into `kernel-worker.js`), runs `npm install`,
    and launches the project's **own dev script** — `npm run dev` (Vite) and `npm run
    start:dev` = `nest start --watch` (Nest) — via `kernel.launch()`, exactly like
    local dev. The vanilla-Vite demo was dropped (React+Compiler covers Vite). The UI
    (`index.html` + `host.js`) is now a two-pane workbench: **file tree | Monaco +
    xterm terminal** on the left, **preview** on the right. ALL process/kernel output
    streams to the terminal verbatim with `FORCE_COLOR=3`, so the Vite banner and
    Nest's colored logs render **byte-for-byte** like a real terminal (validated by
    `scripts/probe-realdev.mjs`). Monaco + xterm are bundled once into a committed,
    same-origin `demo/vendor/editor/editor.{js,css}` (`scripts/build-editor-vendor.mjs`)
    — a CDN can't be used because the page is cross-origin isolated (COEP). Editing a
    file auto-saves to the VFS; the project's own watcher does HMR (Vite) or restart
    (Nest). Enabling the real CLIs required: **top-level await** in the module system,
    **symlink realpath** for `.bin/*`, **`file://` import** normalization, `module.paths`
    + `require.resolve(paths)`, Node CLI flag-skipping in the `node` coreutil,
    `child_process` `shell: true` + `stdio: 'inherit'`, a **streaming `sh`**, and a
    robust ESM export scanner (all in this cycle).
  - ✅ **Fixed (NestJS in the browser — port collision + missing net errors):** the
    demo page's legacy auto-showcase booted a `dev-app` server on **:3200** (never
    torn down), the same port the NestJS demo uses. Nest's real `listen(3200)` then
    got EADDRINUSE from the kernel, and net.js's `new UVExceptionWithHostPort(...)`
    threw *"not a constructor"* because `internal/errors` didn't export it (nor
    `NodeAggregateError` / the net `codes`). Two fixes: (a) `errors.js` now defines
    the net error set (`UVExceptionWithHostPort` aliased to `ExceptionWithHostPort`,
    `NodeAggregateError`, `ERR_SERVER_ALREADY_LISTEN`, `ERR_SOCKET_*`, …), so a port
    clash surfaces as a real EADDRINUSE; (b) `boot()` no longer runs the fixed
    auto-showcase (the /srv server + is-odd/@node-rs/crc32 installs + the :3200 dev
    server) — the page is a demo *selector* now, so boot just stands up the kernel
    and reports ready. This also removes the **10-30s cold-load stall** (those npm
    installs ran on every load, over the Fetcher Worker/SAB — invisible in the XHR
    panel) before the selected demo could even start.
  - ✅ **Fixed (large HTTP responses, surfaced by React demo):** the whole HTTP
    response (headers **and** body) crossed the process→kernel SAB as one
    `JSON.stringify`'d `OP_RESPOND` field. Vite serves its pre-bundled deps
    uninlined — `react-dom_client.js` is **~2.8 MB** transformed — and JSON-escaping
    that text (every `"`, `\`, newline doubles) overflowed the **1 MiB** window, so
    `call()` threw *"request too large"*; the throw was silently swallowed in
    `bridgeHttp`'s `reply()` → the request never resolved → 60 s → **504 / blank
    iframe** (small deps like `react.js` fit, so they worked). Fix: `OP_RESPOND` now
    carries the body as a **raw length-prefixed field** (no JSON escaping) and
    **chunks** bodies larger than the window into sequential frames the kernel
    reassembles by `reqId` (`fs-client.respond` + `kernel.handleRespond`), mirroring
    the fd read/write chunk loop. Regression-checked in `probe-react.mjs` (asserts
    the multi-MB `.vite/deps` bundle serves 200).
  - ✅ **Fixed (edits didn't hot-reload — async `fs.stat` shared-buffer aliasing):**
    `bindings/fs.js` fills one shared `statValues` array in place. Sync stat reads it
    the same tick (fine), but the **async** path (`stat`/`lstat`/`fstat` + an
    `FSReqCallback`) returned that shared reference and only read it later in
    `oncomplete`'s `nextTick` — so a concurrent stat clobbered it and the callback got
    another entry's stats (a **directory reported as a regular file**). Vite 8 bundles
    chokidar 3, which stats the project root via `promisify(fs.stat)`; it saw the root
    as a file (`getWatched()` → `{"/":["app"]}`), never recursed, never file-watched
    `src/*`, so edits silently produced **no HMR** (no error). Fix: async stat snapshots
    into a private buffer (`makeStatArray(..., fresh=true)`). Added to AGENTS.md gotchas.
  - ✅ **Fixed (preview flaky 502 on start — Vite rebinds during boot):** Vite 8
    (rolldown) binds `:5173` several times while starting (bind → close → rebind), so
    the first `listen` event is transient. `startDemo` announced `demo-ready` on that
    first listen, and the preview iframe could hit the port while momentarily closed →
    **502 (live ports: none)**. Fix: `startDemo` now `waitServing()`s after
    `waitListen()` — it drives real `GET /`s through the kernel until one returns a
    non-5xx-gateway status (an in-VM server actually answered) before pointing the
    preview at it. Reproduced headlessly: probe#0 right after first listen = 502, then
    stable 200.
  - ✅ **Fixed (cold-start `504 (Gateway Timeout)` wall on the modules):** on a cold
    `.vite` cache Vite **holds every module request** until its dependency optimizer
    (rolldown) finishes — the HTML serves but `/@vite/client`, `/src/*`, and
    `/node_modules/.vite/deps/*` block. Announcing the preview ready immediately let
    the iframe's subresource fetches race that optimize against the Service Worker's
    60 s timeout → all 504 (only on a cold cache, so `?reset` reliably reproduced it; a
    plain reload worked because `.vite/deps` was cached). Fix: `startDemo` now
    `warmDevServer()`s Vite demos after `waitServing()` — it fetches the HTML, parses
    the module entry scripts, and requests them (which forces the optimize to complete
    and `.vite/deps` to be written) **inside the kernel worker, off the SW clock** —
    before signalling `demo-ready`. The preview then loads against a warm cache
    (validated headlessly: post-warm subresource GETs all 200 in <130 ms).
  - ✅ **Fixed (NestJS demo — edits crashed then hit `EADDRINUSE` on restart):** the
    Nest demo runs `npm run start:dev` = `nest start --watch`; on every save the CLI
    recompiles and restarts the app child. Three gaps in the restart path, fixed in
    order: (1) `child.stdin` was a bare sink missing `pause()` — Nest calls
    `childProcessRef.stdin.pause()` before killing → `TypeError: …stdin.pause is not a
    function`. `child.stdin` is now a full chainable no-op stream. (2) Nest kills the
    old child with `process.kill(pid, sig)`, which didn't exist → `TypeError:
    process.kill is not a function`. Wired `process.kill` → `syscalls.kill` in
    `runtime/index.js`. (3) With both wired, restart threw `EADDRINUSE :::3000`:
    `nest start` spawns the app as `spawn("node ... dist/main", {shell:true})`, so
    `childProcessRef.pid` is the `sh -c "node ..."` wrapper, and `/bin/sh` spawns the
    real `node` server as *its* child. Killing the shell orphaned `node`, which kept
    `:3000` bound. Fix: `kernel.finalize()` now cascades to the whole subtree
    (`parentPid === pid`, recursively), so killing the shell takes the server with it.
    Validated headlessly (`scripts/probe-nest-watch.mjs`): boot → `GET / → Hello
    World!`, edit `app.service.ts`, ~1 s later `GET / → Reloaded!`.
  - ✅ **Fixed (browser-only, surfaced by React demo):** `internal/errors` was missing
    most stream + http error *constructors* (`ERR_STREAM_DESTROYED`,
    `ERR_STREAM_ALREADY_FINISHED`, `ERR_HTTP_HEADERS_SENT`, …). The vendored modules
    destructure them from `codes` at load (silently `undefined`) and only build them on
    **error paths**, so headless tests (clean request/response) never tripped it. In the
    browser the preview iframe closes sockets mid-response → `socketOnEnd`/`socketOnClose`
    call `writable.end()` on a destroyed stream → `new ERR_STREAM_DESTROYED('end')` →
    `"Je is not a constructor"` → crashed response → **502**. All the stream/http codes the
    vendored modules reference are now defined in `internal/errors.js`.
  - ✅ **Edit-from-browser (server reload, not HMR) — now via the real watcher.** The
    Vite/React demo hot-updates through the in-VM dev server's own file watcher. Nest
    has no HMR (true Nest HMR needs webpack's `module.hot`), so `npm run start:dev` =
    `nest start --watch` does the **recompile + restart** itself: saving a `.ts` file
    in Monaco writes it to the VFS, `nest`'s watcher recompiles and restarts the app,
    and when the fresh process re-`listen`s the kernel worker detects the repeat listen
    on a known demo port (`demoReadyPorts`) and posts `demo-reload`, so the host
    reloads the preview iframe. The worker no longer orchestrates the rebuild (the old
    `reloadDemo()`/`tsc`/`stop`+`launch` dance is gone) — it just writes the file and
    lets the project's tooling react, exactly like local dev.
  - ✅ **Dev servers now run *inside a shell tab* (real local-dev lifecycle).** "Run"
    no longer orchestrates `npm install` + `launch()` behind the scenes and streams to
    the Console. Instead it opens a dedicated terminal tab whose interactive `sh`
    auto-runs `VV_RUN` = `npm install && npm run dev …` (install skipped once
    `node_modules` exists). Consequences, all intentional and matching local dev: the
    dev server is a child of that tab's shell, so **closing the tab kills the server**
    (the preview then 502s on refresh — the process is genuinely gone); **running the
    same server twice** (Run again, or typing the command in a second shell) fails with
    `EADDRINUSE` and we **don't intercept it** (Vite may pick another port; its call).
    Preview wiring moved to `kernel.onListen`: the first real listen on a demo port
    probes-until-serving + warms (Vite) then points the preview; a later listen on an
    already-serving port is a Nest `--watch` restart → reload. Closing the demo shell
    clears that port's state so a later Run is a clean boot. Scaffolding writes the
    starter files **once** (`scaffolded` set) so browser edits survive a re-run.
    Validated headlessly by `scripts/probe-term.mjs` (VV_RUN auto-runs with no stdin).
  - ✅ **Cold-boot latency work (perceived startup).** The nested workers used to load
    one-after-another. Now (1) the **Fetcher Worker is created in parallel** with the
    File System Worker (it needs neither the VFS nor the codecs); (2) the demo's
    **first shell defers its Process Worker spawn** off the boot burst (starts on
    focus/keystroke/idle). Boot also **narrates its phases** to the Console with
    timings (`[boot] file system ready (+Xms)`, `codecs compiled`, `kernel ready in
    Nms`, and per-shell `Process Worker booted in Nms` — measured at the shell's first
    output, i.e. real spawn→prompt, not the PID round-trip), and OPFS restore reports
    progress (`restoring N entries…`) so a big `node_modules` re-hydrate reads as work,
    not a hang. `opfs-persistence.restore()` took an optional `onProgress(done,total)`.
    - **Tried & dropped: a warm Process Worker pool.** Pre-parsing the ~900KB process
      bundle in spare workers *sounds* like the spawn win, but the boot numbers showed
      cold start is dominated by the FS worker + VFS wasm init (~1s), not process-worker
      parse; and because a `Worker`'s name is fixed at creation, pooled spares stayed
      mislabelled ("warm") after becoming a real PID, hurting DevTools legibility.
      Reverted to per-PID naming. Deeper wins (snapshotting the runtime, a smaller
      process bundle) remain open if the numbers ever justify them.

  - ✅ **Studio — the React/shadcn UI (`packages/studio`).** The demo front-end was
    rebuilt as a modern app: **Vite 8 + React 19 (React Compiler) + Tailwind v4 +
    shadcn/ui + lucide**, scaffolded with Bun. Vite is now the **single toolchain and
    also bundles the runtime**: `new Worker(new URL('../../../demo/kernel-worker.js',
    import.meta.url), {type:'module'})` and, recursively, its nested module workers
    (`fs`/`fetcher`/`process`) and every `new URL('../*/pkg/*_bg.wasm', import.meta.url)`
    — all emitted same-origin so COEP holds. The accepted risk (nested module workers +
    wasm + SAB under Vite) was validated first on a bare page (headless Chrome/CDP:
    `crossOriginIsolated===true`, kernel ready ~33ms), before any UI.
    - **Layout**: the imperative core of `demo/host.js` was ported verbatim into an
      `IdeController` (`src/vv/controller.ts`) that owns Monaco, the xterm terminals
      (read-only Console + interactive shells), the demo "Run" lifecycle (`VV_RUN`), and
      the preview; React reads an immutable snapshot via `useSyncExternalStore` and
      renders the chrome (AppShell/ActivityBar/Explorer/EditorGroup/TerminalPanel/
      PreviewPanel/StatusBar/CommandPalette). The **kernel-worker.js protocol is
      unchanged** — studio speaks the exact same messages, so both UIs share one runtime.
    - **Isolation plumbing** lives in `vite.config.ts` (COOP/COEP on dev + preview, a
      plugin that stamps `Service-Worker-Allowed:/` on `/sw.js`, `worker.format:'es'`,
      and `server.fs.allow` widened to the repo root). `public/sw.js` is the same preview
      SW at root scope. Monaco/xterm come from npm (no vendored bundle). (Monaco's language
      workers were initially left disabled here; they are now wired for real IntelliSense —
      see "Real IntelliSense" below.)
    - **Gotchas hit**: `@vitejs/plugin-react` v6 is oxc-based (no `babel` option) — the
      React Compiler is wired via the exported `reactCompilerPreset()` + `@rolldown/plugin-
      babel`; TS 6 removed `baseUrl` (paths are tsconfig-relative); shadcn's `base-nova`
      style is built on **Base UI**, not Radix (`delay` not `delayDuration`, trigger
      composition via `render`/no `asChild`); `react-resizable-panels` v4 uses `Group/
      Panel/Separator` + `orientation` (no `direction`/`order`). Monaco's async import +
      StrictMode double-mount needed a create guard.
    - **Parity verified** (headless Chrome/CDP driving `window.__ide`): both React (`:5173`,
      renders "Vite + React + Compiler") and Nest (`:3000`, renders "Hello World!") run
      end-to-end through the preview proxy with zero console errors. **Default `npm run dev`
      is now studio**; the legacy demo stays runnable via `npm run dev:legacy` and its
      worker files remain the shared runtime source (not deleted — studio bundles them).

  - ✅ **Studio — the VS Code experience pass.** Pushed the UI closer to a real editor:
    - **Icons → Iconify.** Dropped `lucide-react` for **`unplugin-icons`** (build-time
      inlined SVG components, offline → COEP-safe, tree-shaken): `~icons/vscode-icons/*`
      for the file hierarchy (`src/components/ide/fileIcon.tsx` maps ext/filename →
      `file-type-*`) and `~icons/lucide/*` for chrome. Needs `@svgr/core` for the JSX
      compiler; every generated shadcn `ui/*` that imported lucide was rewired too.
    - **Bottom panel → Console | Terminal | Ports.** `IdeController` gained
      `panelTab` and a `ports[]` view (a `port→pid` map fed by the kernel `listen`/`exit`
      events, plus demo-shell exit cleanup). Console is its own tab; shells live under
      Terminal with a right-hand list (trash-on-hover to kill); Ports lists `{port, pid,
      address}` with open-in-new-tab. All xterm hosts stay mounted (hidden) so scrollback
      survives tab switches.
    - **Activity bar → Explorer + Search** (`activeView`); a lightweight `SearchPane`
      does a filename filter over the snapshot (full-text is out of scope).
    - **Editor tabs → preview vs permanent.** `previewTab` + `openFile(rel, {preview})`:
      single-click reuses one italic preview slot, double-click (or the first edit) pins
      it. Close `X` shows on hover / when active; a `beforeunload` guard warns before the
      tab (VFS + dev server) is torn down (browsers reserve ⌘W, so it can't close only an
      editor tab).
    - **Explorer file operations.** Right-click context menu + keyboard (Enter rename,
      ⌘/Ctrl C/X/V, Delete) for Open/Rename/Copy/Cut/Paste/Delete, inline rename, and an
      `AlertDialog` delete confirmation (shadcn base `context-menu`/`alert-dialog`). Wired
      through the kernel: new sync fs verbs in `kernel-fs.js`/`kernel.js` (`readFile[Bytes]`,
      `readdir`, `stat`, `unlink`, `rmdir`, `rename`) and `vv-rename`/`vv-rm`/`vv-copy`
      handlers in `kernel-worker.js` (recursive rm/copy) that ack via `vv-fs-result`
      (errors surfaced with sonner). VFS mutations already `notifyWatch`, so a running dev
      server HMRs/restarts on rename/delete/paste automatically. The controller updates the
      tree, Monaco models, tabs, dirty set, and clipboard optimistically.
    - **Verified** (headless Chrome/CDP): boot + Run react demo, file-type icons render,
      preview→permanent tabs, copy/paste/rename/delete reflected in the tree, second shell
      + Ports tab lists the dev-server port/pid, preview serves HTML, zero page exceptions.
    - **Follow-up — explicit save + editor UX.** Dropped the debounced auto-save: an edit
      now just marks the tab dirty (a filled dot in the close-button slot, swapping to `X`
      on hover; reverting to the saved text clears it). `⌘S` (`saveActiveFile`) persists;
      closing a dirty tab pops a VS Code-style prompt ("Do you want to save the changes you
      made to X?" → Save / Don't Save / Cancel). Editor tab context menu adds Close / Close
      Others / Close to the Right / Close Saved / Close All (bulk closes run through a queue
      that prompts per dirty file). Shortcuts: `⌘B` toggles the sidebar, `⌘J` the bottom
      panel.

  - ✅ **Studio — preview mini-browser: local address bar + in-browser DevTools.**
    - **Local-only address bar.** `PreviewTab` gained a `path`; `navigatePreview` parses a
      typed address (`localhost`/`127.0.0.1`/bare path/port), loads the in-VM dev server via
      the SW proxy (bump nonce → reload), and rejects external URLs with a toast. Reload now
      natively reloads the iframe (keeps the SPA route). An injected **nav notifier** (in
      `sw.js`, next to the WS shim) posts `vv-nav` on `pushState`/`replaceState`/`popstate`/
      `load`; the controller syncs the address bar display without re-driving the src.
    - **Full chii DevTools, vendored locally (no CDN → COEP-safe).** The SW injects
      **chobitsu** (`/vv-devtools/chobitsu.js`, a JS CDP backend) into every preview page
      plus a CDP bridge; `/vv-devtools/*` is passed straight through (never proxied into the
      VM). A new `serveDevtools()` Vite plugin streams chobitsu + the chii **Chrome DevTools
      frontend** (`/devtools/**`, from `node_modules/chii/public`) same-origin in dev and
      copies both into `dist` on build. The frontend runs in a resizable bottom split of the
      preview (`public/devtools-host.html` loaded with `#?embedded=<origin>` → chii's
      postMessage transport). The controller's `window`-message relay bridges raw CDP strings
      between the shared frontend and the **active** tab's chobitsu (per-tab backend; the
      frontend reloads to re-attach when you switch tabs).
    - **Fix — blank/hanging DevTools panel.** Two bugs made the frontend load forever (and
      cascade into `Failed to fetch` / a renderer crash): (1) `serveDevtools()` streamed
      assets with `createReadStream().pipe()`, so the frontend's burst of ~50 concurrent
      module imports left many chunked responses **pending forever** over HTTP/1.1 keep-alive
      (and a client abort could crash the dev server). Now it sends buffered bodies with an
      explicit `Content-Length`. (2) The SW routed `/devtools-host.html` + `/devtools/**`
      through `routeByClient`, whose `fetch(event.request)` on the iframe navigation could
      fail; they're now passed straight to the network like `/vv-devtools/*`.

## A real product shell — multi-root workspace + project templates (this change)

Up to here the studio was a two-demo, single-project IDE: picking a project **wiped**
the editor and re-scaffolded from a hard-coded file map. This change turns it into a
product you'd actually start a project in — a VSCode-style multi-root workspace, a Home
screen, and ten pre-authored templates that auto-install + boot their dev server.

- **Home screen (`components/ide/Home.tsx`).** On load (and via the title bar / `⌘K` →
  "Go Home") the studio shows a Home overlay: **Start from blank** and **Start from
  template** big buttons, plus a **Recent projects** list sorted by last-modified. Recents
  persist in `localStorage` (`vv-workspace-projects`) — content itself lives in the VFS/OPFS,
  so the registry is just names + paths + timestamps. Home overlays the (kept-mounted) IDE
  so the Monaco editor and terminals survive a round-trip Home → workspace → Home.
- **Multi-root workspace (`vv/controller.ts`).** The single `currentDemo` is gone. The
  workspace is now `workspaceFolders: {id,name,rootPath}[]` with an `activeFolderId`, and
  **every open file / tab / model / dirty flag is keyed by its ABSOLUTE path** so files from
  different roots never collide. Opening a second project adds a root instead of wiping the
  first. `closeFolder` drops just that root's tabs/models/index.
- **VFS-backed Explorer (`components/ide/Explorer.tsx`).** The Explorer no longer renders a
  static file map — it reads the live VFS. New worker request/response messages
  (`vv-readdir` / `vv-read` / `vv-stat`, correlated by `reqId` → `vv-reply` via
  `KernelBridge.request()`) let it lazy-load a directory's children on expand and re-read on
  a `treeVersion` bump. The kernel worker emits `vv-fs-changed` after any write / rename / rm
  / copy / create / install, which bumps `treeVersion` — so an `npm install` or a file op
  shows up in the tree automatically. `node_modules`, `.git`, `dist`, `.vite`, `build` are
  skipped from the quick-open/search index (bounded walk).
- **Templates (`vv/templates.ts`).** Twelve real, runnable templates — **React, Vue, Svelte,
  Express, NestJS, Next.js (App Router)**, each in **TypeScript and JavaScript**. Each carries a
  manifest (`install`, `dev`, `port`, `entry`, `hmr`/`reload`) plus its full source. Creating
  writes the files in one batched VFS transfer (`vv-create-project` → `writeFilesBatch`) and
  registers the run manifest in the worker — instant, deterministic, offline (no in-VM
  `create-vite`/`nest new`). The Vite templates run with `--configLoader native` (the
  rolldown config bundler throws "Invalid URL" in-VM); `express-ts` compiles with `tsc`
  (no native esbuild/tsx in-VM); `nest-js` uses Babel legacy decorators + is marked
  **experimental**. The **Next.js** templates run `next dev --webpack` with the
  `@next/swc-wasm-nodejs` wasm SWC (a `postinstall` seeds it into Next's cache) and are marked
  **experimental**.
- **Generalised run + preview attribution.** Created/opened projects don't have fixed ports,
  so a dev-server `listen` is attributed to its project by walking the listening pid up its
  parent chain to the **run shell** (`projectDirByTerm`) rather than by a hard-coded port
  table (`demoForPort`, which the two legacy DEMOS still use). On first serve the worker
  probes + warms the server then posts `project-ready {dir,port,entry,…}`; a re-listen posts
  `project-reload`. "Run init script" (default on) opens a terminal that runs
  `install && dev` (install auto-skipped once `node_modules` exists).
- **Explorer UX.** Context menu adds **Open in Integrated Terminal** (opens a shell rooted at
  the folder / the file's parent) and **Copy Path**, alongside New File/Folder, Rename,
  Copy/Cut/Paste, Delete, and Close Folder on roots.

Deferred: drag-and-drop in the tree, an "Add existing folder" picker (paths are typed), and
hardening the `express-ts`/`nest-js` dev servers in-VM. (Full-text search shipped later — see
"VS Code-style search & replace + quick-open by line" below.)

## TypeScript 7 (tsgo), cross-service WebSockets, host↔preview bridge (this change)

Three product features shipped together (Next.js still deferred). Each is proven by a
headless spike (`scripts/spike-*.mjs`) before wiring, per the repo's spike-first rule.

- **Real TypeScript 7 — `tsc`/`tsgo` (Go/wasm).** TS 7's compiler is compiled Go, not JS,
  so it can't be `require()`d. We ship the community **`tsgo-wasm`** build: a
  `GOOS=js/GOARCH=wasm` module (`tsgo.wasm`, ~47 MB) driven by the standard Go `wasm_exec`
  glue, which routes everything through `globalThis.fs` — **which is our real Node `lib/fs.js`
  over the Rust VFS** — plus `crypto.getRandomValues`, `performance.now`, `TextEncoder`, and
  `WebAssembly`. The only shim: Go writes program output to fd 1/2 via `fs.writeSync`/`write`,
  which the VFS fs doesn't wire to the terminal, so the runner routes those two fds to
  `process.stdout`/`stderr`. Delivery mirrors npm/corepack: `scripts/vendor-tsgo.mjs` packs
  the wasm + a CJS-normalised copy of the Go engine into `public/vendor/tsgo-pack.bin`
  (~11 MB gz); `packages/kernel-host/load-real-tsgo.js` unpacks it into the VFS and installs
  `/bin/tsc.js` + `/bin/tsgo.js`. Because it's big and nothing at boot needs it, it loads
  **lazily in the background after `ready`** (a placeholder shim answers "still downloading"
  until then) and persists in OPFS. Spikes: `spike-tsgo.mjs` (boots + type-checks VFS files,
  catches `TS2322`) and `spike-tsgo-studio.mjs` (the shipped shim + shared-loader path).
- **Cross-service WebSockets (FE ↔ BE in two preview tabs).** The preview ws shim (in `sw.js`)
  now recognises a **`/preview/<port>/…` ws URL** and routes the tunneled connection to that
  in-VM port (stripping the prefix), exactly like the HTTP preview proxy. URLs without the
  prefix (Vite HMR, same-app sockets) keep the iframe's own port, so **HMR is unaffected**.
  The kernel already routes a ws `open` by port (`handleWsClient` → `listeners.get(port)`), so
  no kernel change was needed. To surface a multi-server project, port attribution
  (`kernel.onListen`) now opens a **preview tab per distinct port** a run shell binds (primary
  → full `project-ready`; extras → `project-ready {extra:true}`), and clears the port set when
  the run shell exits. New **WebSocket template** (`vv/templates.ts`): an Express + `ws`
  backend (:3001) and a Vite frontend (:5173) started together by a tiny CJS orchestrator
  (`dev.js`, since our `sh` has no `&`); the frontend talks to the backend over
  `/preview/3001/ws`, exercising both directions (server→client tick, client→server echo).
  Spike: `spike-ws-demo.mjs` drives the real `ws` backend through the kernel tunnel and
  asserts both directions.
- **Host ↔ preview bridge.** In-VM code can reach a service on the **host machine** by addressing
  `http://host.vivari.internal:<port>/…`, mapped to the studio's own hostname (only reaches
  the host when the studio is served locally). Both egress paths honor the alias: `http`/`https`
  (and npm) via the fetcher's `rewrite()` (`fetcher-worker.js`), and the global `fetch()` — which
  is the host realm's real fetch used directly — via `rewriteHostAlias` in
  `packages/runtime/index.js`. The reverse direction needs no alias — the host reaches an in-VM
  server at `<studio-origin>/preview/<port>/…` (the same SW preview proxy the iframes use). This
  is addressing convenience, **not** a CORS/auth bypass: the target must still allow the studio
  origin (ACAO + a COEP-satisfying CORP).

  Note: `host.vivari.internal` is an **outbound-fetch** alias only — it is NOT wired into
  the preview tab URL bar (which loads in-VM ports and rejects non-`localhost` hosts). Test it
  from in-VM code, not by typing it in a preview tab:

  1. On your Mac (outside the studio), run a CORS-enabled server on :3000:

     ```js
     // host-server.mjs  ->  node host-server.mjs
     import { createServer } from "node:http";
     createServer((req, res) => {
       res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
       res.end("hello from the host machine\n");
     }).listen(3000, () => console.log("host server on http://localhost:3000"));
     ```

  2. In the studio, create `probe.mjs` (a file avoids terminal quoting issues) and run
     `node probe.mjs`:

     ```js
     // probe.mjs  ->  node probe.mjs
     const res = await fetch("http://host.vivari.internal:3000/");
     console.log("status:", res.status);
     console.log("body:", await res.text());
     ```

     Expected: `status: 200` and `body: hello from the host machine`. The target MUST send
     `Access-Control-Allow-Origin` (the `*` above), else the browser blocks the cross-origin read.

Deferred (next): cross-host WebSockets from in-VM (the tunnel only dials `127.0.0.1`), and
moving Vitest's config off CLI flags. (**Next.js** is no longer deferred — it now boots in-VM;
see the next section.)

## Next.js 16 (App Router) — `next dev --webpack` + wasm SWC (this change)

Reverses the earlier "hard native wall" verdict. Proven headless first
(`scripts/spike-next.mjs`): `npm install next react react-dom @next/swc-wasm-nodejs`, then
`next dev --webpack` binds its port, compiles the App Router page with the **`@next/swc-wasm-nodejs`
wasm SWC** (no native binding on arch `wasm32`), and `GET / → 200` with the rendered HTML.

- **Why it works now.** Next 16 kept the wasm SWC fallback and webpack is still selectable (only
  Turbopack — native Rust — has no wasm build). Next's `loadBindings` prefers the wasm SWC when
  `process.versions.webcontainer` is set, which the runtime now reports.
- **Runtime gaps surfaced & fixed** (each generic, not Next-specific):
  - **`vm.runInNewContext` makes the sandbox the real global** — `globalThis`/`self`/`global`
    assignments (e.g. Next's `globalThis.__RSC_MANIFEST=…` manifest files) now land on the context
    object, via a `with`-scoped proxy. Without this the RSC client-reference manifest never loads.
  - **Cross-`await` `AsyncLocalStorage`** — the App Router `workStore`/`workUnitAsyncStorage`
    invariants need context to survive `await`. On a Node worker the runtime delegates
    `AsyncLocalStorage` to the host's async_hooks (V8 PromiseHook) through the `internalBinding` seam
    (exact). The browser has no such binding and can't hook a native `await`, so the polyfill targets
    the single-request-at-a-time dev model with three rules: (a) a thenable-returning `run(store, cb)`
    holds `store` until it settles, then pops "only if still top" (so out-of-order settling can't
    clobber a live nested scope); (b) a plain (non-thenable) return does NOT restore — Next's
    `renderToFlightStream` returns a stream synchronously and renders later across raw awaits, so
    leaving `store` current keeps `getStore()` correct for that detached work until the next `run()`
    overwrites it; (c) a per-hop snapshot of every live store is propagated through the scheduling
    primitives React uses (`Promise.prototype.then`, `queueMicrotask`, `setImmediate`, `setTimeout`).
    The primitive patches install once at boot — after the runtime's own timer globals and before any
    framework code (so React captures the wrapped primitives), polyfill path only. Result is
    deterministic (not timing-dependent): validated with `VV_NO_HOST_ALS=1` under heavy-I/O
    perturbation — 0 invariant errors, GET / 200, output byte-identical to the host path.
  - **`child_process.fork`** — an IPC channel (`process.send`/`'message'`/`disconnect`) built on the
    worker-thread spawn path; `next dev` forks its dev server and gates boot on `process.send`. The
    fork child streams its stdout/stderr to the parent (kernel `stream: true`), so `fork`'s default
    `inherit` stdio surfaces on the parent's terminal instead of the kernel's global console.
  - **`pathToFileURL`** resolves relative→absolute (Node parity); `dns/promises`, `stream/web`,
    an `inspector` stub, the full `Console` method surface (`@edge-runtime/primitives` binds them),
    and `module.findSourceMap`.
- **Offline wasm SWC.** Next resolves the wasm SWC by downloading it into its own cache on first
  compile (its intended path for wasm environments — real Node behaves the same). The template's
  `postinstall` seeds that cache from the already-installed package so the first compile is offline;
  the on-demand download remains the fallback.
- **Shipped** as the **Next.js** template (TS + JS, `experimental`) with a picker icon.

## Template catalog — StackBlitz parity + Vivari showcases (this change)

Grew the studio's "Start from template" picker from a flat 13-template grid into a
**category-tabbed catalog** (base-ui `Tabs`) modelled on StackBlitz's tabs. `TemplateManifest`
gained a `category` (the tab) and an `icon` slug; the icon is **decoupled from the framework**
(a string-keyed registry in `templateIcons.tsx` with a generic fallback) so new stacks never
force widening a TypeScript union. Templates stay inline/vendored with pinned deps; every
Vite-based `dev` uses `--configLoader native` (Vite 8 / rolldown — no esbuild).

**Phased delivery** (from the catalog plan — Parts A/B/C = what to build, Part D = how; the
"Phase" numbers below are Part D's build order):

- ✅ **Phase 1 (`[DO]`, proven substrate)** — Frontend: Vanilla JS/TS, Static (zero-dep Node
  server), Bootstrap 5. Backend: Koa, Hono, H3. Creative: Three.js, GSAP+React. Tooling:
  Node.js blank. Showcase: Vite+Express fullstack (two preview tabs), Server-Sent Events. Existing
  13 re-categorised.
- ✅ **Phase 2 (`[SPIKE]`, meta-frameworks — shipped `experimental`)** — Fullstack: Nuxt 3,
  SvelteKit, React Router 7 (Remix), Astro. Docs: Slidev. (React Router 7, Astro, and Slidev
  have since **graduated**; SvelteKit + Nuxt stay `experimental`, blocked on the rolldown
  Vite-8 SSR-optimize wasi/tokio panic.)
- ✅ **Phase 3 (`[SPIKE]`)** — Frontend variants: Preact, Lit, Solid, Qwik (now proven headless by
  `scripts/spike-{preact,lit,solid,qwik}.mjs` → **graduated to non-experimental**; Qwik rides the
  merged esbuild-wasm aliasing + in-process service and runs `qwikVite({ csr: true })`). Backends:
  Fastify, Nitro, GraphQL (Yoga),
  Feathers. Showcases: Socket.IO, tRPC, pnpm monorepo, and **in-VM databases** — SQLite
  (sql.js WASM) and PostgreSQL (PGlite WASM), each spiked (see "In-VM databases via Wasm").
- ✅ **Phase 4 (cont.) — standalone Webpack + Docusaurus proven headless AND shipped.** Two
  new templates, each gated by a green spike (validated alongside the Next.js spike, which still
  PASSes incl. the RSC-refresh gate):
  - **Webpack** (`scripts/spike-webpack.mjs`, `Tooling`, non-experimental) — webpack 5 +
    `webpack-dev-server` (connect + `ws` HMR + chokidar) + `html-webpack-plugin` + css/style
    loaders. Binds `:8080`, serves the app, HMR live.
  - **Docusaurus** (`scripts/spike-docusaurus.mjs`, `Docs`, now **non-experimental** — heavy 100s+
    install) — Docusaurus 3 (webpack + MDX + React). Binds `:3000`, serves `/` (200, real Docusaurus HTML).

  Standalone webpack (not Next's private copy) needed **three real runtime fixes** — all general
  improvements, kept regardless of the templates:
  1. **`require.extensions` populated (`module.js`).** `Module._extensions` was an empty
     null-proto object; `webpack-cli`'s config loader (`rechoir`) does
     `Object.keys(require.extensions).includes('.js')` and threw `No module loader found for '.js'`.
     Now `.js`/`.json`/`.node` handlers are registered (the `.js` one delegates to our compiler),
     so tools that both *read* and *patch* `require.extensions` (ts-node/tsx too) work.
  2. **`vm.runInContext` completion value (`node/lib/vm.js`).** A multi-statement script's
     completion value (a trailing bare expression) was lost — `html-webpack-plugin` evaluates a
     child-compilation bundle that ends in a bare `HTML_WEBPACK_PLUGIN_RESULT` and reads it back,
     so it errored `the loader didn't return html`. `runWithSandbox` now uses a *direct* `eval`
     inside the `with(sandbox)` block, which both resolves free identifiers against the sandbox
     proxy and returns the completion value.
  3. **Benign `tls.TLSSocket` + the http2-wrapper hack (`node/lib/tls.js`).** There is no TLS
     backend, but real deps *construct* a `TLSSocket` at module-load time for feature detection.
     Construction is now benign (extends `net.Socket`, no I/O; only a real handshake throws), and
     the socket carries a synthetic `_handle._parentWrap` whose `.constructor` is a harmless class
     — `http2-wrapper` (a transitive dep of `got`, pulled by Docusaurus) reads exactly that at load
     time (`new tls.TLSSocket(new PassThrough())._handle._parentWrap.constructor`) and would
     otherwise crash on `null`. http/2-over-TLS is unused, so the harmless class is fine.

  Post-ship polish (same MR):
  - **Update-notifier noise silenced (`demo/kernel-worker.js`).** Docusaurus (via the
    `update-notifier` package) spawns a *detached* child to check npm for a newer version; that
    spawn fails `ENOENT` in-VM and, since no `'error'` listener is attached, surfaced as a harmless
    (server-still-boots) uncaught error. Update checks are pointless in the VM, so the shell env now
    sets `NO_UPDATE_NOTIFIER=1` + `npm_config_update_notifier=false` (also kills npm's own "new
    version" notice).
  - **Keep-prefix preview routing (`public/sw.js` + controller + `templates.ts`).** A *client-routed*
    SPA (Docusaurus — also Slidev in future) resolves its route from the iframe's own
    `location.pathname`, which is `/preview/<port>/…`. The preview SW normally *strips* that proxy
    prefix before hitting the dev server (so `/`-based servers like Next/Vite see clean paths), so
    Docusaurus's router landed on its NotFound page until you clicked a link. Fix: the template sets
    `baseUrl: "/preview/3000/"` and a `keepPreviewPrefix` manifest flag; the controller pushes the set
    of keep-prefix ports to the SW (persisted in a Cache so a revived SW still routes right); for
    those ports the SW forwards the **un-stripped** path so the app runs consistently under the proxy
    base — first-route + deep-links resolve and `location.reload()` still targets a real preview URL.
    Default (strip) behaviour is unchanged for every other template. `scripts/spike-docusaurus.mjs`
    gained an `VV_BASEURL` knob to exercise the base-prefixed path headlessly.
- ✅ **Phase 4 (cont.) — Angular proven headless AND shipped (`scripts/spike-angular.mjs`, `Angular` template).**
  Angular 21 (`@angular/build`) now builds on esbuild-wasm + Vite and serves `/` with a 200 in-VM
  (~5s dev build). NOTE: the original ship used per-project npm `overrides` + a `scripts/vv-ng.mjs`
  launcher; both were later **generalized into the runtime** (registry aliasing + in-process esbuild +
  `PISCINA_DISABLE_ATOMICS=1` default — see "Toolchain generalization" below), so the template is now a
  vanilla `ng new` with plain `ng serve`/`ng build`. Getting here
  fixed **five earlier runtime bugs** (all validated against the Next.js spike, which still PASSes
  incl. the RSC-refresh gate):
  1. **ESM transpiler — named `export default function/class` (`esm.js`).** A named default
     declaration is a *binding* (hoisted for functions). Rewriting `export default function ui(){}`
     to `__oc_exports.default = function ui(){}` demoted it to an expression, so `ui` was no longer a
     local — a later `export { ui as 'module.exports' }` (cliui/yargs) threw `ui is not defined`. Now
     the declaration is kept intact and `exports.default` is wired via a lazy getter.
  2. **ESM transpiler — circular live bindings (`esm.js`).** Local export getters are now emitted
     **before** import `require`s, so a module read mid-cycle sees a live binding (a hoisted exported
     function) instead of `undefined`. Fixed `isYargsInstance is not a function` (yargs command.js ↔
     yargs-factory.js cycle).
  3. **`node:assert` / `assert/strict` (`node/lib/assert.js` + loader).** These public builtins were
     missing entirely; added a compact but faithful impl over the vendored `isDeepStrictEqual`.
  4. **`createRequire` trailing-slash base (`module.js`).** Node treats `createRequire(dir + '/')` as
     *inside* `dir` (so `dir/node_modules` is searched). We took `path.dirname` unconditionally, so
     the Angular CLI's `createRequire(projectRoot + '/')('@angular/core/package.json')` searched the
     parent and reported `@angular/core` "missing as a dependency". Now trailing-slash bases resolve
     to the directory itself.
  5. **std stream fds + byte-accurate writes (`builtins/process.js`, `index.js`).** `process.stdout`/
     `stderr`/`stdin` now carry their Node fds (1/2/0), and `.write(Uint8Array)` decodes bytes instead
     of stringifying them to `"48,46,…"`. Go's `wasm_exec_node` fast-paths fd-1/2 writes through these,
     so the esbuild wasm's output is no longer silently dropped.

  **The "hard path", solved by running esbuild in-process.** Angular's builder runs esbuild as a
  filesystem-backed **binary service**: `esbuild-wasm`'s Node entry `child_process.spawn`s
  `node bin/esbuild` and exchanges a length-prefixed binary protocol over a stdin/stdout pipe, with the
  child's Go runtime reading commands via `fs.read(0, …)`. Brokered through the single-threaded kernel,
  that pipe **deadlocks** against Angular's Piscina linker pool + inline AOT (all three contend for the
  one event loop). Rather than make child stdio byte-accurate, we **eliminate the child**: a string
  patch of `esbuild-wasm/lib/main.js` rewrites `ensureServiceIsRunning()` to instantiate the Go wasm
  **in this thread**, multiplexing fd 0/1/2 onto the protocol in memory and delegating every other fd
  to the VFS (now `packages/runtime/esbuild-inproc-patch.js`, applied by the module loader for ANY
  project — no per-project launcher). This surfaced **three general runtime
  fixes** (landed separately — see "worker-pool + async-bundler support"): the event-loop **wake** nudge
  (native MessagePort callbacks — Piscina — now re-arm a parked `waitForNext`), the **Buffer-pool
  untransferable guard** (Angular transfers a pooled Buffer's `.buffer`, which detached the whole pool),
  **dedicated `fs.promises.readFile` buffers**, and the **dynamic-import escape hatch** (piscina's
  `new Function('s','return import(s)')` now routes through our loader). `esbuild`→`esbuild-wasm` and
  `rollup`→`@rollup/wasm-node` are aliased **at the registry layer** (no project `overrides`) — see
  "Toolchain generalization" below.
  - **Rust → WebAssembly** starter — needs a Rust toolchain (rustc/wasm-pack) in-VM that we haven't
    proven; consider an **AssemblyScript → WASM** substitute (pure-JS `asc` compiler) as the
    "compile & run WASM in a tab" showcase.
- ⏳ **Phase 5 — documented drops (won't build):** all **NativeScript** (Mobile & XR — need a
  device/emulator runtime), **Python** (needs CPython/Pyodide WASM), **WordPress/PHP** (php-wasm),
  **jq**, **Ember** (embroider = standalone webpack + native tooling), **Egg.js** (`cluster.fork`
  throws), **Nuxt 2** (webpack), **WebContainer API** (StackBlitz-proprietary).

**On `experimental`.** Phase 2/3 templates are shipped `experimental` (the picker shows an `exp`
badge) because they haven't yet passed a headless `scripts/spike-*.mjs` gate — the risk is that a
framework's own CLI drives a Vite/esbuild path we haven't routed through rolldown. They graduate to
non-experimental once their spike is green.

**Frontend variants graduated (this change).** A shared harness `scripts/spike-vite-lib.mjs` (real
`npm install` → boot `vite` → GET `/` 200 with the title marker + `/@vite/client` 200 + the entry
module transforms through the framework plugin) backs
`scripts/spike-{preact,lit,solid,qwik,vue,svelte}.mjs`. Preact, Lit, Solid, **Vue, Qwik and Svelte**
are all green and non-experimental (Svelte via a Vite-7 pin — see below).

The harness fetcher now mirrors the browser kernel's transparent wasm drop-in aliasing
(`esbuild -> esbuild-wasm`, `rollup -> @rollup/wasm-node`; see `packages/core/src/workers/fetcher-worker.ts`) so
a headless spike installs the exact same tree the studio does — without it, Qwik's Vite-7 tree pulls
the native esbuild the browser never sees.

**Vite-8 peer-dependency sweep (this change).** All the Vite templates pin `vite ^8.0.0` (Vite 8 =
rolldown, the only optimizer proven in-VM), but several framework plugins had not yet widened their
peer range to Vite 8, so `npm install` ERESOLVEd. Findings + fixes, each checked against the registry
and a headless spike:

- **Vue** — `@vitejs/plugin-vue@^5.2.0` peers `vite ^5||^6`. Bumped to `^6.0.0` (v6.0.5+ peers
  `^8.0.0`). Fixed **and proven** by `scripts/spike-vue.mjs` (GET `/` 200, `/src/App.vue` compiles).
- **Qwik** — `@builder.io/qwik@1.x` hard-caps `peer vite ">=5 <8"` (no v2 published), so it can't use
  Vite 8 at all; pinned the template to `vite ^7.0.0`. Vite 7's dep optimizer wants esbuild's native
  binary (no wasm32 build), which now Just Works on top of the merged Angular support: the runtime
  aliases `esbuild -> esbuild-wasm` at the registry layer and runs its service in-process
  (`packages/runtime/esbuild-inproc-patch.js`). The last blocker was structural — `qwikVite()`
  defaults to SSR mode and demanded a `src/root.tsx` server entry; switching to `qwikVite({ csr: true })`
  makes it a plain client-rendered SPA. One extra CSR gotcha: the **qwikloader** (the global
  event listener that lazy-loads `onXxx$` handlers) is normally inlined by SSR, so a CSR entry must
  `import '@builder.io/qwik/qwikloader.js'` or the app renders but is dead (buttons don't respond) —
  the template's `src/main.tsx` now does. **Proven** by `scripts/spike-qwik.mjs` → graduated to
  non-experimental.
- **Svelte** — pinned to **Vite 7 + `@sveltejs/vite-plugin-svelte@^6`** and **graduated**
  (`scripts/spike-svelte.mjs` green: GET `/` 200 with marker, `/@vite/client` 200, `/src/App.svelte`
  compiles). Vite 8 is deliberately avoided: with Vite 8 (`+ vite-plugin-svelte@^7`) `npm install`
  succeeds, but the plugin forces a **second (ssr) dep-optimize** pass on boot that can't be turned off
  from user config (`ssr.optimizeDeps` / `environments.ssr.dev.optimizeDeps` with `noDiscovery` + empty
  `include` don't stop it). In-VM that second **rolldown-wasm** bundle panics —
  `Rolldown panicked ... napi-3.10.3/src/tokio_runtime.rs: Access tokio runtime failed in spawn` —
  which traps the wasm (`unreachable`) and crashes the whole dev server (server unbinds → 502). Root
  cause (see follow-up below) is a known upstream rolldown-on-wasi bug, not an Vivari-specific
  gap. Vite 7 sidesteps it by using the **esbuild** dep optimizer, which runs in-process via
  `packages/runtime/esbuild-inproc-patch.js` — the same path that graduated Qwik.
- **React** — no change needed: `@vitejs/plugin-react@^5.0.0` resolves to `5.2.0`, which already peers
  `^8.0.0`.

**Deferred / follow-up — rolldown-wasi second-bundle tokio panic (blocks Vite-8 SSR optimize).**
Root-caused while graduating Svelte (correcting the earlier "SSR optimizer hangs / drains the loop"
guess — it does **not** hang, it **panics**). When a Vite-8 project runs **two** rolldown-wasm dep
optimizes in one process (e.g. the client optimize followed by the SSR optimize that
`vite-plugin-svelte`/meta-frameworks force), the **first** bundle succeeds and the **second** panics:

```
Rolldown panicked. This is a bug in Rolldown, not your code.
thread '<unnamed>' panicked at napi-3.10.3/src/tokio_runtime.rs:113:6:
Access tokio runtime failed in spawn
```

`napi::tokio_runtime::RT` is a Rust `static Option<Runtime>` in the (shared) wasm linear memory; it is
shut down after the first bundle and never re-initialized under wasi, so the second bundle's
`tokio::spawn` unwraps `None` → panic → wasm `unreachable` → the dev-server process dies. This is a
**known upstream rolldown-on-wasi bug that also hits StackBlitz/WebContainer** (rolldown#8747,
rolldown#9134; napi-rs#2847/#2850, napi-rs#3028) — not something a template config can dodge (the
second optimize can't be disabled) and not fixable in our runtime without touching rolldown's Rust
(the runtime already keeps the loop alive via `process.__wtHost`; the shutdown is internal to the
napi tokio static). Confirmed both bundles' pool workers boot fine, so it is not a nested-worker spawn
deadlock. **Svelte is unblocked by pinning to Vite 7** (esbuild optimizer, no rolldown). The remaining
consumers of this bug are the **Vite-8 SSR meta-frameworks (SvelteKit / Nuxt / Astro)** which need a
real SSR optimize; those stay `experimental` until rolldown fixes the wasi tokio lifecycle (or we
carry a patched `@rolldown/binding-wasm32-wasi`). Reproduce the panic with the Vite-8 variant in
`scripts/spike-svelte.mjs` history, or any meta-framework spike.

## VS Code-style search & replace + quick-open by line (this change)

The Search pane was filename-only (a substring filter over the flat file index). This change
makes it a real VS Code-style full-text Search & Replace across **every open workspace root**,
and teaches quick-open to jump to a line — without ever blocking the UI.

- **Search engine in the kernel worker (`demo/kernel-worker.js`).** Full-text search runs where
  the synchronous Wasm VFS lives; doing it on the main thread would mean an `vv-read`
  round-trip per file. New messages: `vv-search {token,roots,query,matchCase,wholeWord,regex,
  includeGlob,excludeGlob}` walks each root (reusing the Explorer skip set), skips
  binary/oversized files, and **streams** results as `vv-search-result` batches → final
  `vv-search-done {matchCount,fileCount,limitHit}`. `vv-replace` recomputes matches against the
  same options and rewrites files — scoped to a single match, one file, or all files — with
  "preserve case" (ALLCAPS/Capitalized) and `$1`/`$&` expansion, posting `vv-fs-changed` per
  write. `vv-search-cancel` + a monotonic `currentSearchToken` supersede an in-flight query.
- **Non-blocking by construction.** That worker also serves preview HTTP + terminal I/O, so the
  walk yields a macrotask every ~40 files and flushes partial batches — the results list fills
  in progressively and the preview/terminal never stall mid-search. Results are delivered to the
  pane via callbacks, kept OUT of the global snapshot to avoid re-render storms.
- **Search pane rewrite (`components/ide/SearchPane.tsx`).** Search input with Match Case /
  Whole Word / Regex; an expandable Replace row with Preserve Case + **Replace All** (disabled
  until there's a match); a details toggle for `files to include` / `files to exclude` globs;
  collapsible per-file results with the match highlighted and per-file/per-match replace on
  hover; a live summary + invalid-regex inline error. Debounced; re-runs on any option change
  and after a replace (via `treeVersion`).
- **Editor integration (`vv/controller.ts`).** `runSearch(opts,{onBatch,onDone})` (returns a
  cancel fn), `replace({...,files|match})`, and `openFileAt(abs,line,col,len)` which reveals +
  selects the range in Monaco (deferred if the editor is still loading). After a replace, any
  affected open model is re-read from disk so the buffer + dirty state don't drift.
- **Quick-open by line (`components/ide/CommandPalette.tsx`, `AppShell.tsx`).** `⌘P` still
  searches files by name, now accepting a trailing `:line[:col]` (e.g. `App.tsx:42`) to jump on
  open; a bare `:line` jumps within the active editor. Added `⌘⇧F` to focus the Search pane.
  (Also wrapped the palette in cmdk's `Command` root so filtering works.)

Follow-ups: search result virtualization for very large result sets, a search-history dropdown
(the input hints at `↑↓`), and `.gitignore`-aware excludes.

## Editor TS worker dedup + esbuild-heap attribution (this change)

Building on the per-PID diagnostic below, a real Nuxt measurement showed two things worth acting on:
a pair of Monaco `ts.worker` instances at ~310 MB each (~621 MB), and a 1.87 GB dev-server Process
Worker whose esbuild slice we couldn't see. This change lands one concrete win and one measurement.

- **One TS language service, not two (studio, ~300 MB+).** Monaco runs a full language service for
  BOTH the `typescript` and `javascript` modes, and the studio was feeding each the entire ~3050-file
  dependency `.d.ts` payload → two ~310 MB `ts.worker`s doing identical work. Now `languageFor`
  (`packages/studio/src/vv/controller.ts`) maps `.js/.jsx/.mjs/.cjs` to the `typescript` language
  (`allowJs` handles JS), `configureLanguageService` leaves `javascriptDefaults` inert (diagnostics
  off, no eager sync, no extra libs) so its worker never spawns, and `loadDependencyTypes` pushes
  extra libs / re-applies compiler options to `typescriptDefaults` only. Net: one worker, one copy of
  the payload, no redundant restart — with strictly-better JS IntelliSense (TS-powered).
- **esbuild Go wasm heap, quantified per-PID (diagnostic).** The in-process esbuild service's Go
  `WebAssembly.Memory` was trapped in a closure. `esbuild-inproc-patch.js` now stashes it on
  `globalThis.__ocEsbuildMemory` and exports `esbuildWasmBytes()` (its live `.buffer.byteLength`);
  `runtime.memStats()` reports it, and "Measure Memory" prints `esbuild-wasm <N> MB` next to the
  owning PID. This finally shows how much of a dev-server's 1.87 GB is the resident esbuild service
  vs. the guest framework working set — the data needed before attempting the bigger, riskier levers.
- **Why no dev-server-heap reduction yet.** `performance.memory` is unavailable in Chrome Workers, so
  exact per-PID JS-heap bytes still come from the main-thread `measureUserAgentSpecificMemory()`
  per-URL breakdown (only the dev-server worker is huge). The esbuild Go heap grows-and-stays (Go wasm
  can't shrink; only `worker.terminate()` frees it), and the rest is guest working set. The remaining
  "ours" lever is bounded `Module._cache` pruning — still gated on these numbers because it must
  respect stateful singletons and cycles.
- **Verification.** Studio-only + a read-only diagnostic: `node --check` + studio `tsc` clean;
  `verify-node` unaffected. Browser check: "Measure Memory" shows ONE `ts.worker` and an
  `esbuild-wasm <N> MB` figure on the dev-server PID.

### Deferred — dev-server heap (revisit later)

Measured on a real Nuxt 3 project (`nuxt dev`, Chrome, after this change): tab total **3.09 GB**, down
from 3.46 GB before the Monaco dedup. Breakdown of what's left, so a future pass doesn't re-derive it:

- **PID 8 (the `nuxt dev` Process Worker): ~1.87 GB — the elephant, and mostly NOT ours.** Of that,
  the in-process **esbuild Go heap is only 22.5 MB** (measured via the new `esbuildWasmBytes()`), so
  isolating/tearing down esbuild would save ~nothing — that idea is **ruled out**. Our `Module._cache`
  holds ~1404 modules (order ~150-300 MB). The remaining ~1.5 GB is the guest **Vite + Rollup + Nitro
  + Vue** dev-server working set (module graph, transform results, sourcemaps, V8 overhead) — roughly
  the inherent cost of in-browser Nuxt dev (comparable to WebContainer/StackBlitz). Not safely
  shrinkable from the runtime while the server is live.
- **FS worker (VFS): ~580 MB, of which only 273 MB is (compressed) file content.** The other ~300 MB
  is a **wasm linear-memory high-water mark** from `npm install` plus allocator fragmentation, the
  hot-read cache, and inode structures. wasm memory can't shrink, so reclaiming it needs a VFS
  "compaction/reboot" (serialize → tear down the wasm instance → re-instantiate fresh → reload). Complex,
  and the win is transient while a dev server keeps touching the VFS. Possible future project if the
  VFS idle footprint matters.
- **~8 small Process Workers (~175 MB total, ~20-30 MB each).** Mostly V8 isolate overhead + our
  per-worker runtime baseline (codecs/crypto/builtins). Trimming the baseline (lazy-load) saves a few
  MB per worker at most — marginal.

Levers considered and **not** pursued (risk/yield too poor without more signal):
1. **Bounded/prunable `Module._cache`** — risky (the cached modules are *live* for a running dev
   server; pruning a stateful singleton or a cycle member breaks it) and low yield here.
2. **esbuild worker isolation** — ruled out by the 22.5 MB measurement above.
3. **Guest dev-config knobs** (disable dev sourcemaps, Vue devtools, etc.) — target the ~1.5 GB
   directly but change DX and have unknown yield; would need per-template experimentation.

Blocker for deeper attribution: `performance.memory` doesn't exist in Chrome Workers, so exact per-PID
JS-heap bytes can't be read programmatically (the main-thread `measureUserAgentSpecificMemory()`
per-URL figure is the only heap number). To see *what* is retained inside PID 8, the next step is a
**manual DevTools heap snapshot** of that worker — do that before investing in any of the above.

## Dev-server heap: per-PID memory attribution (this change)

After VFS compression, the single largest term in the tab is the **Process Worker JS heap**
(~1.87 GB for Nuxt), but `performance.measureUserAgentSpecificMemory()` only attributes it to a
URL (`process-worker.js`) — every process shares that URL, so you couldn't tell *which* process
holds it or *what* is retained. This change adds a per-PID breakdown to "Measure Memory" so the
next round of work can be targeted instead of guessed.

- **Per-process query.** Each Process Worker answers a new `proc-mem` message with its own JS
  heap (`performance.memory.usedJSHeapSize`, Chrome-only/coarse; `-1` when unavailable), the size
  of its guest **module cache** (`Object.keys(moduleSystem.cache).length` — our load-once /
  retain-forever CJS/ESM cache, the main runtime-side retainer), and whether it hosts the resident
  **esbuild-wasm** Go service (`isEsbuildInprocActive()`). The runtime exposes this via
  `runtime.memStats()`, surfaced through `boot.js`'s `onReady` control object.
- **Fan-out + aggregation.** The kernel worker keeps a live `pid → worker` registry (populated /
  pruned in `spawnWorker`), queries every process in parallel with a 2 s timeout, sorts by heap,
  and relays the rows on the existing `vv-mem` round-trip. The studio prints a per-PID table
  (`heap  PID N (M modules, esbuild-wasm)`), falling back to module counts when `performance.memory`
  is off. Threads and `fork` children spawn through the same path, so nested worker-pool processes
  show up too.
- **Findings that shape the next step.** Reading the module loader confirms the compiled CJS/ESM
  wrapper (and thus its source) is **not** retained after evaluation — it's GC-eligible — so there
  is *no* dangling "source string" to free. The reducible heap is therefore (a) the unbounded
  `Module._cache` graph (a real lever, but pruning it safely means respecting stateful singletons
  and cycles — opt-in/measured work), (b) the by-design resident esbuild Go heap, and (c) the guest
  framework's own working set (not ours). This diagnostic is the prerequisite for deciding between
  those; the risky bounded-cache path stays gated on the numbers it produces.
- **Verification.** Behavior is unchanged when nobody asks for memory; `proc-mem` is a pure
  read-only query, so `verify-node` is unaffected (`node --check` + studio `tsc` clean).

## VFS whole-file lazy compression — cut the tab's RAM (this change)

The File System Worker's Wasm linear memory (every file body held as raw bytes) was the
single largest *addressable* consumer of the tab — ~929 MB for a Nuxt project's
`node_modules`. This stores cold file bodies zlib-compressed in the VFS, transparently, so
that footprint drops ~70% with no change to guest behavior. **On by default**; `?compress=0`
disables it (the flag is plumbed page → kernel worker → FS worker and applied before the OPFS
restore). Builds on the prior memory MR (bounded fetch-cache LRU, VFS hard links, and the
"Measure Memory" readout via `performance.measureUserAgentSpecificMemory`).

- **`FileBody { Raw(Vec<u8>) | Zip { data, len } }`** in `packages/vfs/src/lib.rs` replaces the
  bare `Vec<u8>` in `NodeData::File`. Reads inflate transparently: whole-file `read_file`
  inflates on demand, and chunked `fd_read` inflates a cold file **once** into a bounded (48 MiB)
  FIFO hot-read cache keyed by inode, then slices from it — the stored body stays compressed.
- **Lazy, quiescent-only compression.** The first write inflates the body in place (`raw_mut`);
  a file is (re)compressed only when its **last writable fd closes** (tracked with a `wopen`
  refcount) or after `write_file`, so the write path never fights the compressor. Guards: skip
  files < 4 KiB and keep them Raw unless zlib beats 95% of the original (already-compressed
  assets like `.png`/`.woff2` stay Raw).
- **Diagnostics.** `mem_bytes()` now reports the *physical* (compressed) footprint plus the hot
  cache; new `logical_mem_bytes()` exposes the uncompressed size so "Measure Memory" prints the
  realized ratio (`compressed from X (Y% of logical, saved Z)`). `set_compression(bool)` is the
  runtime gate. `flate2` (miniz_oxide, pure-Rust `rust_backend`) keeps the wasm32 build
  toolchain-free.
- **Measured (Nuxt, Chrome).** VFS content 929.0 MB → 273.6 MB (**−71%**, 29% ratio, saved
  655 MB); the FS worker heap fell by the same ~650 MB (the VFS *is* its linear memory); the
  real Chrome tab dropped 2.9 GB → **2.1 GB**. Cost: a little install-time CPU (each file is
  deflated once on close). The next-largest consumer is now the dev-server Process Worker heap
  (~1.87 GB), which compression doesn't touch.
- **Verification.** `scripts/spike-compress.mjs` estimates the projected saving over any real
  `node_modules` using the same thresholds (no browser/wasm rebuild). With the gate off the code
  path is behaviorally identical, so `verify-node` is unaffected. Requires `npm run build:vfs &&
  npm run build:vfs:node` to rebuild the wasm.

## Real IntelliSense — Monaco's TS/JS language service, off-main-thread (this change)

The editor was syntax-coloring only: Monaco's language workers were a no-op `MonacoEnvironment`, so
there were no completions, no hover, no go-to-definition, and no diagnostics — the most visible
quality gap vs a hosted IDE. This change wires the real language service, running off the main thread,
with project-wide + dependency-aware type information.

- **Real workers, COEP-safe (`vv/controller.ts` `mountEditor`).** `MonacoEnvironment.getWorker` now
  returns Monaco's own workers per language label — the editor worker plus the `typescript` worker
  (a bundled TS compiler + language service), and json/css/html. Each is a Vite `?worker` import, so
  it's bundled into a same-origin chunk (COEP `require-corp` satisfied, no CDN). They run in Web
  Workers, so completions/hover/diagnostics never block the UI.
- **Language service config (`configureLanguageService`).** Sensible compiler options (ESNext,
  NodeJs resolution, `react-jsx`, `allowJs`, `esModuleInterop`, `resolveJsonModule`, `skipLibCheck`,
  and `allowImportingTsExtensions`+`noEmit` so Vite templates' `import "./App.tsx"` don't error),
  semantic + syntax diagnostics ON, and `setEagerModelSync(true)` so every model we create is visible
  to the worker. `checkJs` stays OFF so plain-JS projects aren't drowned in type errors.
- **Cross-file IntelliSense = the project's files as models (`ensureBackgroundModels`).** The worker
  only sees Monaco *models* and *extra libs*. So a folder's own source files (`.ts/.tsx/.js/.jsx/
  .mjs/.cjs`, node_modules excluded) are seeded as background models (bounded, created lazily, adopted
  by `ensureModel` when opened) — so imports between the user's files resolve and go-to-definition
  works before a file is even opened.
- **Dependency types = bulk `.d.ts` harvest in the kernel worker (`vv-collect-dts`).** Installed-package
  typings (`node_modules/**/*.d.ts` + `package.json` for `types`/`exports` resolution) are collected
  by the worker that holds the sync Wasm VFS — one bulk reply instead of thousands of `vv-read`
  round-trips — harvesting the project's **declared deps (+ their `@types`) first** so a budget cap
  never drops the packages you actually import, then the rest of `@types`, skipping `typescript`'s own
  libs (Monaco ships those). The controller registers them via `setExtraLibs`, keying each file with
  `monaco.Uri.file(path).toString(true)` (**skip-encoding**) — the default `toString()` percent-encodes
  `@`→`%40`, but TS's resolver looks up `@types/…`/`@scope/…` with a literal `@`, so encoded keys silently
  break every `@types`-backed import (`react`, `react-dom`, `jsx-runtime`) even after the `.d.ts` loads.
  After `setExtraLibs` we re-apply `setCompilerOptions` to force a fresh worker (the mount-time worker
  validated open files before the types existed). The load is
  debounced and re-runs on folder open, fs changes, and **after any process exits** — since an in-VM
  `npm install` doesn't emit `vv-fs-changed`, a finished process is the cue that `node_modules` may
  have appeared. A cheap `node_modules` fingerprint short-circuits the file reads when nothing changed.
- **Problems in the status bar (`StatusBar.tsx`).** `monaco.editor.onDidChangeMarkers` feeds a live
  error/warning count into the snapshot, surfaced next to the status text.

Verified: `tsc -b` + `oxlint` clean; kernel-worker `node --check` clean. (A full `vite build` needs the
Rust/Wasm VFS artifacts, which aren't built in this environment.)

Follow-ups: a full Problems *panel* (jump-to-marker list), quick-fixes/auto-imports UI, `jsconfig`/
`tsconfig` awareness (honor the project's own compiler options + `paths`), and go-to-definition into
dependency `.d.ts`.

## Toolchain generalization, install speed, worker-pool & a spike CI harness (this change)

Five improvements that make the architecture more portable and self-guarding. `llhttp → Wasm`
(replace the pure-JS `http_parser`) followed in its own MR — see the next section.

- **Persistent content-addressed package cache in OPFS.** The package-manager caches moved off the
  ephemeral `/tmp` into a PERSISTED location: `/home/user/.cache/{npm,yarn,corepack}` and the pnpm
  store at `/home/user/.local/share/pnpm/store` (`demo/kernel-worker.js`). npm's own integrity-keyed
  `_cacache` is a content-addressed store, so persisting it *is* the "package cache in OPFS": a
  dependency downloaded once is reused by every later project and after a reload — no re-download. To
  avoid double-storing tarballs, the kernel's transient outbound-fetch buffer `/var/cache/vv-fetch`
  (whose in-memory index is rebuilt per session and never read back) is now in the OPFS `IGNORE` list
  (`demo/fs-worker.js`) — npm's cache is the single durable copy. Wipe with `?reset`.
- **Toolchain generalization as a real subsystem.** The native→wasm alias table is now a single
  source of truth, `packages/runtime/toolchain-shims.js` (`NATIVE_WASM_ALIASES`), imported by the
  Fetcher Worker (registry aliasing) and documented next to the in-process esbuild patch. The esbuild
  patch (`esbuild-inproc-patch.js`) is now **version-drift resilient**: it matches the spawn block
  with the version literal templated (a point/minor esbuild-wasm bump keeps patching, threading the
  captured version through), and on a block-shape change it **warns loudly** instead of silently
  regressing to a deadlock. Guarded offline by `scripts/spike-toolchain.mjs`.
- **`worker_threads.receiveMessageOnPort`.** Implemented Node's synchronous manual-polling drain via a
  lazy per-port inbox (`node/lib/worker_threads.js`): a port polled with `receiveMessageOnPort` buffers
  each delivered message and shifts it out, returning `{ message }` or `undefined`. Lazy (not eager)
  so event-only ports never grow an undrained buffer. The Atomics worker-pool fast-path stays **off**
  (`PISCINA_DISABLE_ATOMICS=1`) — a browser `MessagePort` can't be drained synchronously across a
  worker boundary. Gated by a new case in `scripts/verify-node.mjs`.
- **Graduated templates.** Next.js (`next-ts`/`next-js`) and Docusaurus (documented-green spikes), plus
  the low-risk Node backends **Koa, Hono, H3, Fastify** (plain HTTP servers on the proven Express/Nest
  substrate) moved out of `experimental`. Each backend gained a spike:
  `scripts/spike-{koa,hono,h3,fastify}.mjs`. (Preact/Lit/Solid graduated earlier in the Vite-8 sweep.)
- **Spike CI harness.** A shared `scripts/lib/spike-harness.mjs` (boot kernel → install → waitListen →
  httpGet) removes the copy-pasted boilerplate, and `scripts/run-spikes.mjs` is a tiered runner
  (`--offline` / `--net` / `--all`) that auto-vendors npm and fails loudly on any red. Wired into
  `.gitlab-ci.yml` (fast offline gate on every push; verify + network spikes on MR/schedule) and
  exposed as `npm run spikes[:offline|:net]`. A template must have a green spike before it graduates.

## llhttp → Wasm HTTP parser (this change)

`internalBinding('http_parser')` — the parser beneath Node's real `lib/http` — is now **real
llhttp compiled to WebAssembly**, replacing the pure-JS HTTP/1.1 parser as the default while
keeping it as an automatic fallback.

- **No new toolchain.** Rather than stand up a wasi-sdk/clang build just to recompile an artifact
  identical to what Node already ships, we **vendor undici's prebuilt `llhttp.wasm`** (same upstream
  https://github.com/nodejs/llhttp, MIT). `scripts/vendor-llhttp.mjs` pins the undici version
  (currently `undici@8.7.0`) and regenerates `node/bindings/llhttp/llhttp-wasm-data.js` (the binary
  base64-embedded so there's no fetch, ~54 KB).
- **Synchronous, in-worker instantiation.** The binding is built synchronously at process bootstrap,
  so the Wasm is compiled with `new WebAssembly.Module()`. That's allowed in Workers (where guest
  processes run); on the main thread the 4 KB sync-compile cap throws — which is exactly what trips
  the pure-JS fallback. `VV_HTTP_PARSER=js|wasm` forces either side (`wasm` = fail loud).
- **Faithful bridge.** `node/bindings/llhttp/llhttp-parser.js` mirrors Node's `node_http_parser.cc`:
  it drives llhttp's span callbacks (`on_url`/`on_status`/`on_header_field`/`on_header_value`/
  `on_body`/`on_headers_complete`/`on_message_complete`) and folds them onto the exact numeric
  `kOn*` contract `lib/_http_common.js` expects — for BOTH requests (server) and responses (client),
  including Content-Length, chunked, EOF-delimited bodies, HEAD/204 skip-body, keep-alive/pipelining,
  trailers, and Upgrade/CONNECT hand-off. `allMethods` follows llhttp's method enum so
  `allMethods[llhttp_get_method()]` round-trips.
- **Observability.** When the Wasm backend is live it advertises `process.versions.llhttp` (as real
  Node does). The offline `scripts/spike-http-llhttp.mjs` (20 checks, wired into the CI offline gate)
  and the extended `scripts/verify-node.mjs` http case (HEAD, 204, chunked request + response,
  trailers, keep-alive) guard both the Wasm path and the JS fallback.

## In-VM databases via Wasm — SQLite + Postgres, first-class (this change)

"No native database" is the headline limitation every in-browser-runtime competitor lists;
their docs only suggest workarounds. Vivari's architecture (real Node `fs` + `url` +
host `WebAssembly` over the virtual filesystem) already runs Wasm-compiled SQL engines with
**zero native addons and no external server**, so this ships them as documented, first-class
**Showcase** templates.

- ✅ **SQLite (sql.js)** — `sqlite` template. SQLite compiled to Wasm; `initSqlJs()` loads its
  `.wasm` from `node_modules` via `locateFile: (f) => require.resolve('sql.js/dist/' + f)`.
  Enriched into a read/write todo demo (Express `/api/info` + `/api/todos` GET/POST + UI) and a
  `README.md`. (The template existed but was unspiked; it now has one.)
- ✅ **PostgreSQL (PGlite)** — new `pglite` template. `@electric-sql/pglite` is real Postgres
  (currently PostgreSQL 18) compiled to Wasm. We use its **CJS build** (`require('@electric-sql/
  pglite')`) so there's no top-level-await dependency (only the entry module can block on TLA
  in-VM). Its ~16 MB of `pglite.wasm` + `pglite.data` are read from `node_modules` over the
  virtual filesystem (the CJS build resolves them from `__filename` → `new URL('./pglite.wasm',
  …)` → `fs.readFile`); `PGlite.create()` is in-memory by default (pass a dir to persist, and
  pgvector/extensions are available). Same Express `/api/info` + `/api/todos` demo + `README.md`.
- **Why these two.** Both are pure Wasm and self-contained. **libSQL is intentionally not shipped
  as an in-VM template**: `@libsql/client` local mode is a native N-API addon (no wasm32 build),
  and `@libsql/client/web` only talks to a *remote* Turso server — neither is a self-contained
  in-VM database. sql.js remains the local SQLite path; libSQL is a remote/native story.
- **Verification.** Both are gated by new network spikes — `scripts/spike-sqlite.mjs` and
  `scripts/spike-pglite.mjs` (registered in `scripts/run-spikes.mjs`; PGlite gets a longer
  budget for its heavy install + first-boot Wasm compile). Each asserts install → bind :3000 →
  `GET /api/info` reports the right engine + version → `GET /api/todos` returns the seeded rows.
  Both templates stay `experimental` until their spike is green in CI.
- **Feasibility proof.** Both engines were confirmed end-to-end in vanilla Node (same `fs`/`url`/
  `WebAssembly` primitives the runtime exposes): sql.js answers queries; PGlite boots real
  PostgreSQL 18 and answers `SELECT version()`.

## Server-Sent Events over an `vv-sse` tunnel + `EventSource` polyfill (this change)

The old `sse` template rendered but showed nothing: a streaming `text/event-stream` response
can't cross the HTTP preview proxy. That path is **buffered end-to-end** — the Service Worker
resolves ONE complete body (`handleHttpRequest` → `OP_RESPOND` waits for `total`), and
`bridgeHttp` only replies on `cres.on('end')`, which never fires for an SSE stream — so the
connection just 504s at the SW's 60s timeout. SSE was, in effect, unsupported.

The fix mirrors the proven **WebSocket tunnel** (roadmap #19 stage C), minus the client→server
leg (SSE is one-way):

- **`EventSource` polyfill** injected into every preview page (both `packages/demo/sw.js` and
  `packages/studio/public/sw.js`, right next to the ws shim). It replaces the iframe's
  `EventSource` with one that tunnels each connection to the host page (`parent.postMessage`,
  `type:'vv-sse'`, `sub:'open'|'close'`) and parses the raw event-stream bytes it gets back into
  `message`/named events per the SSE spec (`data:`/`event:`/`id:`, dispatched on a blank line) —
  so both `es.onmessage` and `es.addEventListener('metric', …)` work. Port routing +
  `fallbackPort` are identical to the ws shim.
- **Kernel routing** (`packages/kernel-host/kernel.js`): `handleSseClient` binds the `connId`
  to the process listening on the port and forwards `sse-open`/`sse-close`; `handleSseOut`
  relays a process's outbound chunk back out via `onSseSend`. `sseConns` are torn down on
  process exit (the browser gets a close), same as `wsConns`.
- **Runtime relay** (`packages/runtime/index.js`): `sseRelay` opens a genuine in-VM loopback
  `GET` (`Accept: text/event-stream`) to `127.0.0.1:<port><path>` and forwards each incremental
  `res.write()` chunk out as `sse-out {sub:'open'|'chunk'|'close'}`. A live relay refs the
  event loop (`sseLiveness`) so it keeps pumping like an open socket handle.
- **Relays**: `process-worker.js` (`sse-open`/`sse-close` → `dispatchSse`), `kernel-worker.js`
  (`vv-sse` ↔ `onSseSend`), demo `host.js`, and studio `kernel.ts`/`controller.ts` — each gets
  an `vv-sse` case beside its `vv-ws` one.

**Richer template.** The `sse` Showcase template now multiplexes three event types onto ONE
connection — a per-second default `message` tick (counter + live clock), a named `metric` gauge
(a live CSS bar chart), and named `notice` log lines — with a connection-status pill and a
Pause/Resume control (the polyfill's `close()`/reconnect). It demonstrates default AND named
events, exactly what native `EventSource` gives you.

- **Verification.** New network spike `scripts/spike-sse.mjs` (in `run-spikes.mjs`) drives the
  exact tunnel **headlessly, no browser**: it installs + binds the server, then calls
  `kernel.handleSseClient({sub:'open',…})` and collects `kernel.onSseSend` chunks, asserting the
  stream opens and delivers default + `metric` + `notice` events with an advancing counter.
  Now green in CI, so the `sse` template is **graduated** (no longer `experimental`).
- **Feasibility proof.** The streaming + parsing core was confirmed in vanilla Node (an
  `http.createServer` SSE endpoint consumed by `http.request` with `cres.on('data')`): chunks
  arrive incrementally (one batch per server tick, not buffered to `end`), and the same
  blank-line frame parser the shim/spike use correctly separates default/`metric`/`notice`
  events with a progressing counter.

## GraphQL template — demo UI + a real mutation (this change)

The `graphql` (Yoga) Backend template shipped as just the server + GraphiQL, so it wasn't
obvious how to *call* it from an app. It's now a proper showcase: a tiny static demo UI at
`/` whose buttons call the API with `fetch()` and render the result, while GraphQL Yoga (and
GraphiQL) keep `/graphql`.

- **Server** (`src/index.js`): one `http.createServer` serves `public/index.html` at `/` and
  delegates everything else to Yoga (`graphqlEndpoint: '/graphql'`). Schema gains a `Book`
  type, a `books` list query, and an `addBook` **mutation** over an in-memory array — so the
  UI can demonstrate a query-with-args, a list query, and a write.
- **UI** (`public/index.html`): a greet-by-name box, a book list + add-book form, and a "last
  GraphQL response" panel showing the raw JSON. The GraphiQL link is computed from the current
  path so it works both under the Vivari preview (`/preview/<port>/graphql`) and in a
  standalone export (`/graphql`).
- **Verification.** New network spike `scripts/spike-graphql.mjs` (in `run-spikes.mjs`) asserts
  install -> bind :4000 -> `GET /` serves the UI -> `POST /graphql` answers `hello` +
  `greet(name)` + `books` -> the `addBook` mutation grows the list by one. It uses a new
  `httpPost` helper added to `scripts/lib/spike-harness.mjs`. Proven (browser + vanilla-Node),
  so the `graphql` template is **graduated** (no longer `experimental`).
- **Feasibility proof.** Confirmed end-to-end in vanilla Node with real `graphql-yoga@5`: `GET /`
  serves the page, the queries and the `addBook` mutation work (books 2 -> 3), and GraphiQL is
  still served at `/graphql`.

## Feathers + Nitro backends graduated (this change)

Two more Backend templates drop `experimental`, each now gated by a headless spike:

- **Feathers** (`scripts/spike-feathers.mjs`) — installs `@feathersjs/feathers` + `@feathersjs/koa`,
  binds `:3030`, and drives the REST transport: `GET /messages` returns the seeded message,
  `POST /messages` creates one (id increments), and `GET /messages` then shows both. Proven
  end-to-end in vanilla Node with real Feathers 5.
- **Nitro** (`scripts/spike-nitro.mjs`) — the first CLI-dev-server backend spike: it runs
  `nitro dev` (rollup build + `defineNitroConfig`/`defineEventHandler` auto-imports, bound via
  listhen with `PORT` pinned), then asserts `GET /` serves the index route and `GET /api/hello`
  returns the JSON handler body. Registered with a longer budget (nitro dev builds on boot).
  Proven end-to-end in vanilla Node with real `nitropack@2` (built in ~300ms, both routes served).

Both use the shared `scripts/lib/spike-harness.mjs` (Nitro adds `env.PORT` via `defaultEnv`; the
new `httpPost` helper from the GraphQL change carries the Feathers `create()` assertion).

## VitePress — dropped: synckit's blocking Atomics + cross-worker MessagePort (revisit later)

VitePress was **removed from the templates** after we chased three successive blockers and hit
a *fundamental* one. The story (kept as a signpost for a future revisit):

1. **Vite 5 config bundler** — `vitepress dev` hung right after Vite's "CJS build … deprecated"
   line. VitePress 1.x runs **Vite 5**, whose config loader ALWAYS esbuild-bundles
   `.vitepress/config.*` and imports the bundle via a temp `file://` URL
   (`loadConfigFromBundledFile`) — the same in-VM config-bundling path regular Vite templates
   dodge with `--configLoader native` (an option Vite 5 lacks). OC's `__ocImport` can't resolve
   `file://` temp bundles, so it never settled. **Fixed** by shipping *no* config file (VitePress
   then skips `loadConfigFromFile` and boots on defaults).
2. **`DataCloneError` on spawn** — with config-less VitePress the boot got *past* config loading
   and then crashed spawning a worker: `A MessagePort could not be cloned because it was not
   transferred`. VitePress's markdown highlighter (Shiki) resolves languages **synchronously** via
   **`synckit`** — `resolveLangSync = createSyncFn(...)` runs **eagerly at module load**, spawning
   a `worker_threads` Worker with a `MessagePort` inside `workerData`. OC's `worker_threads`
   explicitly *defers* transferring MessagePorts across threads, so the spawn throws.
3. **The fundamental wall** — even if we fixed (2), synckit's runtime pattern is `Atomics.wait`
   (block the calling thread) → `receiveMessageOnPort(port)` (read the reply synchronously). In a
   browser a **blocked worker can't receive a MessagePort message** — delivery needs the event
   loop, which `Atomics.wait` freezes. This is the exact limitation OC already documents (it's why
   Piscina runs with `PISCINA_DISABLE_ATOMICS=1`), and synckit has **no async fallback**. So any
   real (highlighted) code block would deadlock/throw regardless.

The best achievable would be a gated MessagePort-transfer fix **plus** stripping every
highlighted code block — a docs SSG that can't show highlighted code, from an unverifiable change
to core worker infra. Not worth it while **Docusaurus** (graduated, Prism-based, no synckit)
already covers the docs-site showcase fully. **Revisit if** OC's worker model gains a synchronous
cross-worker port drain (e.g. a SAB-backed transport), or Shiki/VitePress drops synckit.

## Slidev + Socket.IO graduated (this change)

Two more templates drop `experimental`, each now gated by a headless spike:

- **Socket.IO** (`scripts/spike-socketio.mjs`) — Express + `socket.io`, binds `:3000`, and
  asserts `GET /` serves the chat UI, `/socket.io/socket.io.js` serves the client script, and
  the **engine.io polling handshake** (`/socket.io/?EIO=4&transport=polling`) returns a session
  advertising the `websocket` upgrade. The live ws chat rides the already-proven preview ws
  tunnel (roadmap #19 / `spike-ws`), so the spike proves the server side in-VM. Confirmed in
  vanilla Node with real `socket.io@4`.
- **Slidev** (`scripts/spike-slidev.mjs`) — a Vite + Vue CLI dev server (`@slidev/cli`). Like
  Nitro it drives the real CLI (`slidev --port 3030` → `bin/slidev.mjs`), with a longer bind
  budget (`VV_BIND_TIMEOUT`) since the first Vite build is heavy, then asserts `GET /` returns
  the Slidev app shell. Confirmed in vanilla Node (dev server built + bound in ~6s, `/` served).

## tRPC template — raw `.ts` server through the loader, no `export type` (this change)

The **tRPC** template's server is run raw via `node --experimental-strip-types
server/index.ts`, which routes it through OC's own module loader. That loader's
`esm.js` only rewrites `import`/`export` — **it does not strip TypeScript types** —
so `export type AppRouter = typeof appRouter` had its `export ` removed and left
`type AppRouter = …`, i.e. invalid JS → `SyntaxError: Unexpected identifier
'AppRouter'`. (Every other TS template only sees `.ts` *after* esbuild/Vite has
stripped types; tRPC is the one that hands a raw `.ts` to the loader.)

Fix keeps full end-to-end typing without any runtime type syntax in the executed
file:

- `server/index.ts` drops the `export type AppRouter` line — it now contains **zero**
  TS type syntax, so `esm.js` transpiles it to valid CJS and it runs.
- `src/App.tsx` derives the router type with a **type-only `typeof import()`**:
  `type AppRouter = typeof import('../server/index').appRouter`. esbuild erases the
  whole declaration (verified: no `../server/index` import in the transform output),
  so there's no runtime coupling and the tRPC client stays fully typed.

Guarded by `scripts/spike-trpc.mjs`, which boots the exact `.ts` server through the
kernel (`node --experimental-strip-types server/index.ts`), binds `:3001`, and
asserts an `httpBatchLink`-style greeting query returns the typed payload. Server
side confirmed in vanilla Node with real `@trpc/server@11`. **Now graduated** —
browser-confirmed end to end (React frontend on :5173 calling the tRPC server on
:3001).

## pnpm monorepo — cmd-shim bin unwrap + pnpm's `--` forwarding (this change)

The **pnpm monorepo** template crashed with `SyntaxError: missing ) after argument
list` the moment `vite` started. Two pnpm-specific behaviours, both fixed:

1. **pnpm bins are `#!/bin/sh` cmd-shims, not symlinks.** npm makes
   `node_modules/.bin/vite` a POSIX symlink straight to the real `vite.js`; pnpm
   instead writes a `#!/bin/sh` wrapper that `exec node "$basedir/../vite/bin/vite.js"
   "$@"`. Our synchronous loader can't run shell — it neutralised the shebang and
   compiled the shell script as JavaScript → syntax error. Fix (runtime, general):
   `module.js` `runMain` now detects a shell cmd-shim and **unwraps it to the `.js`
   it execs** (`resolveCmdShim` → the pure `parseShellShimTarget`), mirroring Node's
   `argv[1]` = the resolved `.js`. A real `#!/usr/bin/env node` bin is left alone.
   No NODE_PATH shim is needed: pnpm places the real bin next to its deps in the
   `.pnpm/<pkg>@<ver>/node_modules/` store, so the normal node_modules walk resolves
   them. This benefits **every** pnpm-installed bin, not just this template.
2. **pnpm doesn't eat a leading `--` like npm.** The template ran `pnpm --filter web
   dev -- --configLoader native`; npm would strip the first `--` and forward
   `--configLoader native`, but pnpm forwards the literal `--` too, so vite's cac
   parser treated `--configLoader native` as pass-through positionals and ignored
   the flag (which then re-triggers vite's in-VM rolldown config bug the flag exists
   to avoid). Fix: drop the `--` → `pnpm --filter web dev --configLoader native`.

Guarded by `scripts/spike-cmd-shim.mjs` — a pure, offline unit test of the shim
parser (real pnpm shim + `.cjs`/`.mjs` targets + node-bin/non-shell negatives).
Both the shim resolution and the corrected `--`-free command were confirmed against
real pnpm@9.15.9 in vanilla Node (vite starts, serves `/`).

**Follow-up — the preview iframe was blank** (terminal fine) with `Uncaught Error:
Calling require for "scheduler" in an environment that doesn't expose the require
function` from rolldown's runtime. Under pnpm's default *isolated* store, react-dom's
transitive `scheduler` lives behind nested symlinks in `.pnpm/…`, and Vite's in-VM
rolldown dep-optimizer externalised it (a bare `require("scheduler")`) instead of
bundling it. Fix: a project `.npmrc` with `node-linker=hoisted`, giving a FLAT
node_modules of real dirs (npm-like) — the `workspace:*` package (@repo/ui) stays
symlinked (the actual showcase), but external deps and their transitives become real
top-level dirs the optimizer bundles (confirmed with real pnpm@9.15.9: `scheduler`
bundled, `main.jsx` served).

**Graduated.** Browser-confirmed end to end: `pnpm install`, the `workspace:*`
symlink, the Vite dev server, and the live preview iframe all work. The template
drops `experimental`; the cmd-shim unwrap it relies on is guarded by
`scripts/spike-cmd-shim.mjs`, and real pnpm is exercised by the pnpm spikes.

## SvelteKit / React Router 7 / Astro fixes (this change)

Started as three template fixes; two turned out to be **ESM→CJS loader** bugs that any
meta-framework can hit, so the fixes moved into `packages/runtime` (esm.js + module.js)
and are gated by a new offline `scripts/spike-esm.mjs`.

- **SvelteKit — two-stage fix.**
  1. `ERESOLVE`: the template pinned `vite@^8` but `@sveltejs/vite-plugin-svelte@^5`
     peers on `vite@^6`. Plugin vite-8 support landed in **v7** — bumped the plugin to
     `^7.0.0` and `svelte` to `^5.46.4` (`@sveltejs/kit@2.8` already peers `vite ^8`).
  2. `SyntaxError: Unexpected identifier '__oc_import'` when the config loaded:
     `@sveltejs/kit/src/core/sync/ts.js` does `ts = (await import('typescript')).default`
     — **top-level await**. Our CJS wrapper is a plain function, so `new Function` rejects
     it, and after the import-rewrite the parser blames the next token (not "await is only
     valid…"), so `module.js`'s old narrow message-match never retried as async. Fix:
     `module.js` now retries **any** failed ESM compile as an `AsyncFunction` (real TLA
     compiles; genuine syntax errors fail again and are reported).

  With both fixed, the SvelteKit config loads and `vite dev` starts — but then **hangs at
  the `(ssr) [optimizer] bundling dependencies…` pass**. That's the already-documented
  **rolldown-wasi second-bundle tokio panic** (see "Deferred / follow-up" above): a Vite-8
  project that runs two rolldown-wasm dep-optimizes (client + the SSR optimize SvelteKit
  forces) dies because napi's tokio runtime static is torn down after the first bundle.
  It can't be disabled from user config. So SvelteKit stays `experimental`, blocked on the
  same upstream rolldown bug as Nuxt — NOT on our loader. (Unlike Astro, which is on Vite 6
  + the esbuild optimizer and so dodges this.)

- **React Router 7 — "not found" on first load (GRADUATED).** RR7 framework mode is
  client-routed: it re-matches the route against the iframe's own location
  (`/preview/5173/…`) during hydration, so served at `/` (prefix stripped) the client
  router lands on NotFound even though SSR rendered `/`. Fix (the keep-prefix pattern
  Docusaurus uses): `manifest.keepPreviewPrefix: true` + both `react-router.config.ts`
  `basename` and Vite `base` at `/preview/5173/` (trailing slash required). User-confirmed
  working in-browser → **graduated** (dropped `experimental`).

- **Astro — cascade of circular-const TDZ, fixed with a live-binding fallback.** Astro's
  runtime is full of module-level singletons imported across cycles and read inside
  functions: `Fragment`, `apiContextRoutesSymbol`, `AstroConfigSchema`, `ASTRO_CONFIG_
  DEFAULTS`, `globalContentLayer`, `globalContentConfigObserver`, `telemetry`, … (17
  distinct cases enumerated). OC's eager `const X = m.X` import snapshot fires while the
  source module is mid-cycle → "Cannot access 'X' before initialization". The earlier
  `vite.ssr.noExternal: ['astro']` hack did NOT work — `astro dev`'s CLI imports these
  through OC's loader *before* any Vite SSR config applies. Two fixes:
  1. `esm.js`: an imported name that is **only re-exported** is compiled without the eager
     snapshot and re-exported via a lazy getter to the source module (fixes `Fragment` in
     `render/index.js`). The "is it used" gate that decides whether to keep the eager
     snapshot counts any identifier-boundaried occurrence (does NOT discount `.X`, which
     is ambiguous with spread `...X` — that discount had dropped `[...SVELTE_DEDUPED_
     IMPORTS]` / `[...SUPPORTED_MARKDOWN_FILE_EXTENSIONS]` → "X is not defined").
  2. **Live-binding fallback** (`transpileEsmLive` + `module.js`): the *used-in-code*
     circular cases (singletons/schemas) can't be re-export-lazied. When eager evaluation
     throws a TDZ/"not defined" `ReferenceError`, `module.js` recompiles that module with
     imports bound lazily via `with (__oc_live)` and re-runs it once. Scope-correct
     without reference rewriting; fallback-only, so normal modules keep the fast eager
     path. Verified by executing Astro's real runtime through an OC-shaped loader that
     mirrors the fallback: all 16 problematic modules recover, `Fragment` and
     `apiContextRoutesSymbol` resolve to their real Symbols, `AstroConfigSchema` is a real
     zod object. Astro is on Vite 6 + the esbuild optimizer, so it does NOT hit the
     rolldown SSR-optimize panic that blocks SvelteKit — this fallback should carry it to
     a live dev server. `astro.config.mjs` reverted to pristine.

  With the TDZ fixed Astro **boots** (`astro vX ready`, serving on :4321) but then Vite's
  esbuild dep-optimize crashed with `Cannot assign to read only property 'fs' of object
  '#<DedicatedWorkerGlobalScope>'`. Root cause: `@astrojs/compiler` (the Go/wasm `.astro`
  compiler) installs its fs shim as `globalThis.fs || Object.defineProperty(globalThis,
  "fs", { value: nodeFs })` — a value-only `defineProperty` defaults to
  `writable:false, configurable:false`, so it **locks** `globalThis.fs`
  non-configurably. When esbuild-wasm's in-process patch then does `globalThis.fs =
  __ocFs` (to multiplex its stdio fds), it throws — and the lock can't even be redefined.
  Fix in `runtime/index.js`: **pre-seat `globalThis.fs`** (writable+configurable, = real
  fs) at boot, before any Go tool loads, so every tool's `globalThis.fs || …`
  short-circuits and never locks it, while esbuild/tsgo can still reassign it.      Reproduced
     the exact conflict + verified the fix offline.

  Past dep-optimize, Astro's dev server threw `[vite] Named export 'default' not found. The
  requested module 'cssesc' is a CommonJS module…` from Vite's SSR module runner
  (`analyzeImportedModDifference`), which asserts `'default' in mod` for externalized CJS
  deps. Root cause: OC's ESM-path dynamic-import helper (`esm.js` `helpers`' `__oc_import`)
  returned the bare `require()` value instead of a module namespace, so a CJS target had no
  `default`. (The CJS-path and `new Function`-path helpers already synthesized the namespace;
  the ESM path was the odd one out — it slid by because static default imports go through
  `__oc_def`.) Fix: wrap the ESM-path `__oc_import` result in `__oc_ns` (no-op for an ESM
  target, synthesizes `{ default, ...ownKeys }` for CJS). Regression-gated in
  `scripts/spike-esm.mjs`. Left `experimental` pending final browser confirmation of a
  rendered page.

  Once routing rendered, `RenderContext.create` threw **"Function.prototype.apply was
  called on undefined"** — V8's error for a spread call `undefined(...args)`. The undefined
  was `sequence`: `render-context.js` eagerly imports it (and spread-calls `sequence(...mw)`)
  from the `middleware/index.js` **barrel**, which re-exports it (`import { sequence } from
  './sequence.js'; export { sequence }`). The barrel's re-export getter was emitted at the
  END of its prelude (after its own requires), so when the barrel's requires re-entered
  `render-context.js` mid-cycle, reading `barrel['sequence']` returned `undefined` — no TDZ
  throw, so no live-binding fallback, and the eager `const sequence` snapshotted `undefined`
  permanently. Fix in `esm.js` (both `transpileEsm` and `transpileEsmLive`): emit re-export
  getters **early** (before the prelude requires) and resolve the source module **lazily via
  `__oc_require(spec)`** (cached) instead of closing over the later-declared prelude var, so
  a circular importer reading a re-exported name mid-cycle always sees a defined getter that
  returns the (hoisted) source binding. Regression-gated in `scripts/spike-esm.mjs`.

  With all four loader fixes in place Astro **renders end to end** (dev server + SSR page),
  user-confirmed in-browser → **graduated** (dropped `experimental`). Now also gated by a
  network spike, `scripts/spike-astro.mjs`: install → `astro dev` binds :4321 → `GET /`
  SSRs the index page. (Runs in CI's net tier; needs the built VFS wasm + vendored npm,
  same as the other framework spikes.)

Loader guarantees regression-gated by `scripts/spike-esm.mjs` (offline tier): TLA →
async retry; circular re-export → lazy live binding (getter emitted early, re-requires the
source, so a mid-cycle read never snapshots `undefined`); spread-only use keeps its const;
and the live-binding fallback recovers a circular singleton used inside a function.

## Live network in the preview DevTools — WS/SSE/fetch in the Network panel (this change)

The preview's in-browser chii DevTools (roadmap §"Studio — preview mini-browser") had a
**half-empty Network panel**. `fetch`/XHR are captured natively by chobitsu, but our
`WebSocket` and `EventSource` are **polyfills that tunnel over `postMessage`** (roadmap #19
stage C for ws; the `vv-sse` tunnel for SSE) — chobitsu never sees a real socket, so live
connections and their frames were invisible. And even the `fetch`/XHR rows that did show up
displayed the **internal proxy URL** (`http://localhost:5173/preview/3000/api/hello`) rather
than the in-VM address the app actually targets. So the panel didn't reflect what the running
app was doing.

The fix injects a small **synthetic-CDP bridge** into every preview page and feeds the same
`vv-cdp` channel chobitsu already uses, so ws/SSE/fetch all land in one coherent panel:

- **`NET_SHIM` (`window.__vvNet`)** — a synthetic `Network.*` emitter injected into
  `packages/studio/public/sw.js` (ahead of the ws/SSE shims and chobitsu). It hands out CDP
  request/loader ids, `emit()`s `Network.*` events over the bridge, and **registers each live
  connection** so it can **replay** them when a fresh DevTools frontend attaches. A `gen`
  (generation) counter guards against the duplicate/stale rows that appeared when a connection
  was announced more than once across reloads.
- **`OCWebSocket` emits the full ws lifecycle** — `webSocketCreated`,
  `webSocketWillSendHandshakeRequest`, `webSocketHandshakeResponseReceived`,
  `webSocketFrameSent`, `webSocketFrameReceived`, `webSocketClosed` — so a socket opened in guest
  code shows up as one connection with live in/out frames.
- **`OCEventSource` emits `requestWillBeSent` (type `EventSource`) → `responseReceived` →
  `eventSourceMessageReceived`* → `loadingFinished`**, so an SSE stream reads as a long-lived
  request with each event as a message.
- **Attach timing** — replaying live connections is gated on **both** the preview's `init` and
  the frontend's `Network.enable` (via `maybeAttach()`), because a fresh panel that isn't yet
  listening drops early events. On a preview reload the controller **remounts** the DevTools
  frontend (`onPreviewFrameLoad` bumps `devtoolsNonce` in
  `packages/studio/src/vv/controller.ts`) so the network log starts clean and re-attaches — this
  is what killed the "4 ws connections after refresh" pile-up.
- **Fetch/XHR 504 hang when DevTools was open** — `handlePreview` in `sw.js` was picking the
  DevTools iframe as the `kernelClient` (its URL also lacks the `/preview/` marker), so HTTP
  requests were posted to a client with no kernel listener and 504'd at the SW timeout. Fixed by
  refining `kernelClient` selection to prefer the **top-level studio window** and explicitly
  exclude the preview and DevTools iframes.
- **Friendly URLs** — `cleanUrl`/`scrubNet` in the CDP bootstrap rewrite chobitsu's outgoing
  `Network.*` URLs from the proxy form (`/preview/<port>/…`) to the real in-VM address
  (`http://localhost:<port>/…`), honoring `__vvKeepPrefix`. Now fetch/XHR read exactly like the
  already-friendly ws/SSE rows (`http://localhost:3000/api/hello`, `ws://localhost:3001/ws`,
  `http://localhost:3000/events`).
- **Backend demo buttons** — `backendDemoHtml` in `packages/studio/src/vv/templates.ts` gives
  every backend template (Express TS/JS, Nest, Koa, Hono, H3, Fastify, Nitro) a "Call
  GET /api/hello" button so the panel is easy to exercise; the demo, GraphQL, and SQLite/Postgres
  fetches all use the explicit `/preview/<port>/` prefix for deterministic routing.

**Verification.** Browser-confirmed end to end for all three transports (a socket + its live
frames, an SSE stream + its events, and a fetch/XHR all appear with friendly in-VM URLs, survive
a preview refresh, and no longer hang). The CDP visualization is inherently browser-only (not
spike-able headlessly); the friendly-URL rewrite was validated with a Node harness over same-port,
cross-service, and `__vvKeepPrefix` cases.

## Persistent dependency cache — node_modules keyed by lockfile (this change)

The OPFS write-behind mirror already keeps a project's `node_modules` across a reload, and the
package managers' own content-addressed caches under `/home/user/.cache` are persisted too — so a
re-install rarely re-DOWNLOADS. But it still paid the full **CPU** cost of a real install whenever
`node_modules` was absent: a brand-new project, a `?reset`, or a second project with the same deps
all re-ran Arborist resolution + extracted thousands of files + ran lifecycle scripts. This change
caches the **result** of an install (the whole `node_modules` tree) keyed by the lockfile, and
restores it in one pass instead of re-running npm/yarn/pnpm — the biggest perceived-speed win for
the common "open a template, press Run" flow.

- **The store (`packages/kernel-host/dep-cache.js`).** A content-addressed snapshot store,
  environment-agnostic like `opfs-persistence.js`: it takes an `access` (the same vfs-bound facade —
  `read`/`walk`/`mkdirp`/`writeFile`/`symlink`) and a `storage` blob backend. `save(key, dir)` walks
  `dir/node_modules` and packs it (dirs + files + **symlinks**, so pnpm's virtual store survives) into
  one archive using the vendor-asset pack format (`[u32le headerLen][headerJSON][file bytes…]`);
  `restore(key, dir)` unpacks it back into the VFS. A small index (persisted through `storage`) tracks
  size + last-use per key for a **bounded LRU** (512 MiB default), so the cache can't grow without
  limit. `hashDepKey(pm, bytes, src)` is a SHA-256 (via `crypto.subtle`) namespaced by package
  manager + source file.
- **Keying + aliases.** The durable key is the **lockfile** hash (`package-lock.json`/
  `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`); when none exists yet it falls back to
  `package.json`. A save also registers an **alias** on the `package.json` hash pointing at the same
  snapshot, so a fresh project of the same template — which has no lockfile until its first install —
  still hits on its pre-install lookup.
- **Browser wiring (`packages/core/src/workers/fs-worker.ts`).** The cache lives in the File System
  Worker (the sole holder of the VFS + OPFS sync access handles), storing snapshots under a separate
  origin dir `vv-depcache/` (one flat file per key). New `dep-cache-{has,save,restore}` messages run
  against the in-worker VFS and answer over `postMessage`, exposed to the kernel as
  `depCacheHas/Save/Restore` on the kernel-fs client (`packages/kernel-host/kernel-fs.js`, same shape
  as `writeLarge`/`writeFilesBatch`). A restore mirrors every recreated path through the existing
  write-behind store, so cache-restored `node_modules` survives a reload exactly like a normally
  installed one.
- **Orchestration (`packages/core/src/workers/kernel-worker.ts`).** Before the auto-run install
  (`demoRunCommand` / the project-run branch of `openTerminal`), if `node_modules` is absent and a
  snapshot matches the lockfile, it is restored and the shell runs the dev command **without** the
  `install &&` prefix. After any package-manager install exits cleanly — detected generically from the
  process invocation in `kernel.onProcExit` (the `command`/`args`/`cwd` are now carried on the exit
  result), covering the auto-run `install && dev` shell, a manually typed `npm install`, and the SDK
  `vivari.spawn('npm', ['install'])` path — `node_modules` is snapshotted (skipped if the current
  lockfile is already cached). `resetVfs()` (`?reset`) now also drops `vv-depcache`.
- **Trade-off (documented).** This is **additive**: the write-behind mirror still persists
  `node_modules` per project, so a restored tree is stored both in the mirror and the dep cache. A
  cleaner, more space-efficient follow-up is to exclude `node_modules` from the mirror and let the
  dep cache own dependency persistence outright (it changes reload semantics, so it's out of scope
  here). Packing is also a single synchronous pass today; chunked/idle-time packing is a follow-up.
- **Gate.** `scripts/spike-dep-cache.mjs` (offline, in `run-spikes.mjs`) fabricates a `node_modules`
  (files + a symlink) against the real Wasm VFS, snapshots it, wipes it, restores it, and `require()`s
  the result in-VM — plus the package.json-alias restore path. Headless has no OPFS, so
  `scripts/fs-worker.mjs` wires an in-memory `storage`; the pack/restore + VFS logic under test is the
  shipped code.

## Definition of done for T2

`npm install` a real dependency, then `node`-run an Express/Vite app whose HTTP server
is driven by Node's REAL `lib/http` + `lib/stream` over the `internalBinding` layer and
previewed live in the iframe — with the Path A hand-written builtins deleted.

---

## 🎯 Target architecture map (StackBlitz reference)

| StackBlitz (observed via DevTools) | Vivari |
|---|---|
| `Main` | Main thread — UI, orchestration |
| `engineworker.js` | Kernel worker — `kernel-worker.js` (orchestrator) |
| `File System Worker` | VFS worker (Rust/Wasm) |
| `Fetcher Worker` | Network/registry worker |
| `Node.js Worker PID n` | Process = 1 worker + Node shim |
| `[worker n]` | Nested `worker_threads` — real (#16 stage 2b) |
| `sw.js` | Service Worker preview |
