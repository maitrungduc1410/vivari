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
    **S3 — scrypt + elliptic asymmetric — DONE (phase 1).** `scrypt`/`scryptSync`, and the
    ELLIPTIC asymmetric surface: `createPrivateKey`/`createPublicKey` (PKCS#8 `PRIVATE KEY` +
    SPKI `PUBLIC KEY`, PEM or DER), asymmetric `KeyObject`s (`ec`/`ed25519`), `createSign`/
    `createVerify` + one-shot `sign`/`verify`, and `generateKeyPair(Sync)` for `ec`
    (prime256v1/secp384r1) + `ed25519`. This unlocks **ES256/ES384 + EdDSA JWTs**
    (jsonwebtoken/jose native path). The Rust codec (`packages/crypto`) grew RustCrypto
    `scrypt` + `p256`/`p384`/`ed25519-dalek` (keygen via getrandom's `js` backend, sign via
    ECDSA prehash / PureEdDSA, DER or IEEE-P1363 `dsaEncoding`); keys cross the boundary as
    PKCS#8/SPKI DER with kind+curve auto-detected by trial-parse, and `lib/crypto.js` handles
    PEM<->DER + the streaming Sign/Verify shape. `createPrivateKey` still THROWS on a raw
    secret (unparseable as PEM/DER), so jsonwebtoken's HS* fallback to `createSecretKey` is
    intact. Verified in `verify-node` mutually against the host `node:crypto`: scrypt byte-
    for-byte; Ed25519 signature byte-for-byte (RFC 8032 determinism) + our-verify-OpenSSL and
    OpenSSL-verify-ours; ECDSA P-256/P-384 by mutual verify (DER + IEEE-P1363) + tamper-reject;
    createSign/createVerify streaming; generateKeyPair round-trips. (Wasm is CI/browser-built.)
    **S3 — RSA — DONE (phase 2).** `createSign`/`createVerify` + one-shot `sign`/`verify` now
    dispatch RSA vs EC/Ed25519 on the key's type: **RS256/384/512** (RSASSA-PKCS1-v1_5) and
    **PS256/384/512** (RSA-PSS, salt = digest via `RSA_PKCS1_PSS_PADDING` +
    `RSA_PSS_SALTLEN_DIGEST` on `crypto.constants`), plus **`publicEncrypt`/`privateDecrypt`**
    (RSA-OAEP with `oaepHash`, and RSAES-PKCS1-v1_5 via `RSA_PKCS1_PADDING`) and
    `generateKeyPair(Sync)` for `rsa` (`modulusLength`). Keys parse from PKCS#8/SPKI **and**
    traditional PKCS#1 (`RSA PRIVATE/PUBLIC KEY`), normalized to PKCS#8/SPKI so `export()` is
    uniform; `asymmetricKeyDetails.modulusLength` is surfaced (jsonwebtoken@9 reads it during
    key validation). The Rust codec grew RustCrypto `rsa` (prehash sign like ECDSA;
    `Pkcs1v15Sign`/`Pss`/`Oaep`/`Pkcs1v15Encrypt` low-level schemes; keygen via getrandom).
    Verified in `verify-node` mutually against host `node:crypto`: RS256 signature byte-for-byte
    (PKCS1v15 deterministic) + tamper-reject; PS256 by mutual verify; RSA-OAEP decrypt of the
    host's ciphertext + our round-trip; generated-key round-trip; and OpenSSL verifies our
    RS256/PS256 signatures. This unlocks **RS256/384/512 + PS256/384/512 JWTs**. (Wasm is
    CI/browser-built.)
    **S3 — X.509 + SEC1 — DONE (phase 3).** `new crypto.X509Certificate(pem|der)` parses a
    certificate via the RustCrypto `x509-cert` codec: `subject`/`issuer`, `serialNumber`,
    `validFrom`/`validTo` (+`validFromDate`/`validToDate`), `subjectAltName`, `keyUsage`
    (extKeyUsage OIDs), `ca`, `fingerprint`/`fingerprint256`/`fingerprint512`, `raw`,
    `publicKey` (a real asymmetric `KeyObject`), `toString()`, plus `verify(publicKey)` and
    `checkIssued(cert)` (signatureAlgorithm-OID dispatch to the RSA/ECDSA/Ed25519 verify math).
    Key parsing also gained SEC1 `EC PRIVATE KEY` (normalized to PKCS#8). Verified in
    `verify-node` against host `node:crypto`: every parsed field matches the host
    `X509Certificate` for the same fixture, self-signed `verify`/`checkIssued` pass, a foreign
    key is rejected, and OpenSSL verifies an ECDSA signature made by a SEC1-parsed key. This
    unlocks **jose's `importX509`** (proven by `scripts/spike-jose.mjs`). (Wasm is CI/browser-built.)
    **Deferred (S3 later phases):** encrypted/passphrase keys, `privateEncrypt`/`publicDecrypt`,
    DH/ECDH, JWK — they throw loudly. (corepack's
    registry ECDSA check now *could* use `verify`, but its exact key path is un-revalidated, so
    it stays skipped via `COREPACK_INTEGRITY_KEYS=0`, keeping the sha512 tarball-integrity check
    that only needs `createHash`.)

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
    and a `KeyObject`-as-secret input. **ES256/ES384 + EdDSA are now supported** via the S3
    `createSign`/`createVerify` + EC/Ed25519 codec work above; **RS256/384/512 + PS256/384/512
    are now supported** via the S3 phase-2 RSA codec work (RSASSA-PKCS1-v1_5 + RSA-PSS, keys read
    from PKCS#8/SPKI/PKCS#1, `modulusLength` surfaced for jsonwebtoken's key validation).
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
      **emnapi 2 exception (added later).** The vendored host shadows the project's copy, which
      breaks once an addon ships emnapi 2: its `NodeEnv` calls `bridge.setLastError`/`deleteEnv`,
      absent from the 0.2.x bundle, so instantiate throws and the addon looks "not installed".
      That took out every Vite 8 project when `rolldown` 1.2.1 moved to `@emnapi/core`
      2.0.0-alpha.3. `module.js` now prefers the project's `@napi-rs/wasm-runtime` when its tree
      has `@emnapi/runtime` major >= 2, and keeps the vendored (liveness-patched) host otherwise —
      emnapi-1 addons hang on their own newer hosts. Re-vendoring at 1.2.x instead does NOT work:
      the installed `@emnapi/*` halves still cross with the bundled ones.
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
  - `crypto` **S3**: ✅ scrypt + elliptic sign/verify + EC/Ed25519 keygen (phase 1, #12);
    ✅ RSA — RS/PS sign/verify + publicEncrypt/privateDecrypt (OAEP/PKCS1v15) + keygen +
    PKCS#1 parsing (phase 2); ✅ X509Certificate parse/verify + SEC1 `EC PRIVATE KEY`
    parsing (phase 3, drives jose importX509); ✅ `timingSafeEqual` — remaining: DH/ECDH, JWK.
  - `child_process`: parent→child **stdin** pipe (#15). (`fork` is now implemented — an IPC
    channel over the worker-thread spawn path — which unblocked `next dev`.)
  - WASI: **stdin**, `poll_oneoff` (event-driven) (#16 s1).
  - `worker_threads`: transferring more complex objects (#16 s2b).
  - Stubbed / partial builtins: `http2` (load-safe stub), `readline` (partial), `tls`/`https`,
    `perf_hooks`, `cluster`. **Absent rather than stubbed** — they hard-throw
    `no vendored Node builtin '…'` on require, and are no longer advertised by
    `Module.builtinModules` / `process.binding('natives')`: `dgram`, `domain`, `repl`, `sys`,
    `sqlite`, `test`, `test/reporters`, `stream/consumers`, `trace_events`. (`dgram` was listed
    here as "stubbed" and never was.)
  - ✅ **Lazily-required `internal/*` ids: 13 unregistered → 3.** These are the ones the vendored
    `lib/` only reaches from inside a function, so they imported cleanly and threw on first *use*
    — `fs.cp`/`cpSync`, `fs.rm` recursive, `fs.glob`/`globSync`, `path.matchesGlob`,
    `fs.watch(dir, {recursive:true})`, `util.MIMEType`, `util.diff`, `events.on()` and
    `util.setTraceSigInt` (an honest not-implemented stub) all resolve now, and spreading `util`
    no longer throws. The 3 left out are deliberate, each for a stated reason:
    `internal/blocklist` and `internal/socketaddress` (need the C++ `block_list` CIDR matcher +
    `internal/worker/js_transferable`; a hand-rolled v4/v6 subnet matcher is worse than useless
    for a primitive callers use to *accept* connections) and `internal/source_map/source_map_cache`
    (~1500 lines of further vendoring that would change nothing observable — see `getCallSites`
    below). Consequence still standing: `net.BlockList`/`net.SocketAddress` are getters, so
    **enumerating `net`** (`{...net}`, promisify-all helpers) throws. That's the last instance of
    the trap AGENTS.md documents for `fs`, and the natural follow-up.
  - ✅ **Web Streams ⇄ Node interop** (`internal/webstreams/adapters.js`): all six
    `Readable`/`Writable`/`Duplex` `toWeb`/`fromWeb` converters are real; only
    `newWritableStreamFromStreamBase`/`newReadableStreamFromStreamBase` still throw
    (`ERR_METHOD_NOT_IMPLEMENTED`, deliberately — they need a libuv StreamBase handle our
    `stream_wrap` shim doesn't implement, and nothing in the runtime calls them). The file is a
    hand-written **adaptation**, not a verbatim vendor — reasons in the entry below. Read this
    bullet with its correction: as merged the six were real but **the three `toWeb` directions
    still threw in the VM**, on an upstream import line that this tree's vendored
    `internal/streams/end-of-stream` does not fit (`TypeError: finished is not a function`, no
    `code`). Host-Node checks could not see it; the `bun` kernel spike could. Fixed in "Web
    Streams `toWeb` was dead in the VM" at the end of this file.
  - ✅ **One `assert`.** The eager `builtins/assert.js` shim is gone, so `assert`, `node:assert`
    and `assert/strict` all resolve to the vendored `node/lib/assert.js`. Expect guest suites to
    get stricter: `throws(fn, ExpectedError)` used to ignore its second argument.
  - ✅ **One builtin list.** `Module.builtinModules` and `process.binding('natives')` are both
    derived from `listPublicBuiltins()` — 48 ids that `require()` can genuinely serve, replacing a
    41-entry `natives` array with 4 phantoms and a 19-name `builtinModules` snapshot that
    disagreed with `Module.isBuiltin`.
  - Known-throwing, each for one identified reason (not general gaps): `fsPromises.cp` — async
    `fs.cp` works, but `lib/fs/promises.js` wires `cp: wrap("cpSync")` and so routes into the
    deliberately-unimplemented sync path; a one-line fix in `node/lib/**`. `util.getCallSites()` —
    needs `internalBinding('util').getCallSites`, one layer below the source-map cache.
  - ✅ `module` builtin is now a real **constructor** (`Module.prototype.{require,load,_compile}`,
    `_resolveFilename`, `_load`, `_cache`, `_extensions`, `wrap`, `isBuiltin`, `createRequire`) and
    `require` routes through `Module._load`, so require-patching tools (`ts-node`, `tsconfig-paths`,
    jest, proxyquire, module-alias) can monkeypatch it. (Next's `require-hook` no longer trips on
    this — and Next 16 now boots in-VM on webpack + wasm SWC; see the framework matrix below.)
- **Network (browser-platform limits, not just unimplemented):**
  - Outbound raw TCP is impossible in a browser — only the fetch/WebSocket bridge exists.
  - ✅ And it now **says so**: `net.connect` rejects a non-loopback destination (`ENOTFOUND` for a
    hostname, `EHOSTUNREACH` for an IP literal) instead of silently retargeting it onto whatever
    in-VM server happens to own that port. `dns.lookup` still maps every name to `127.0.0.1` — on
    purpose — which is exactly what made that guard necessary rather than redundant.
  - HTTP: streaming request/response bodies, keep-alive, more concurrent in-flight (#8).
- **Persistence:** exact `mode`/`chmod` restore (needs a VFS `chmod`; files get default mode).
  Concretely: `OP_CHMOD`/`OP_UTIMES` in `packages/protocol/syscall.js` + `set_mode`/`set_mtime` on
  `VirtualFileSystem`, then `fs-client.js`/`fs-server.js` and `bindings/fs.js` against them (~30
  lines across five files). Until that lands, `chmod`/`chown`/`utimes` accept the call and discard
  it — see the entry below for why `ENOSYS` is not the answer — and they now at least throw `ENOENT`
  on a missing path. **The coupling worth knowing:** `access()` enforces `X_OK` now, so
  `chmod(f, 0o755)` followed by `access(f, X_OK)` **throws** instead of falsely passing. Passing the
  mode at creation (`writeFileSync(p, s, { mode: 0o755 })` → `open(O_CREAT, mode)`) is the only way
  to get an executable file today. This item retires that caveat with it.
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
  - ✅ **Rspack + Rsbuild** — the Rust/webpack-compatible bundler **builds and serves in-VM**
    (`scripts/spike-rspack.mjs`: `rspack build` emits a bundle + `rspack serve` → `GET / → 200`;
    `scripts/spike-rsbuild.mjs`: `rsbuild dev` → `GET / → 200`). Same wasm32 auto-select as Vite's
    rolldown: `@rspack/binding-wasm32-wasi` (a `wasm32-wasip1-threads` build) is the only binding
    installed on arch `wasm32`, and it runs on our emnapi/WASI host without hitting the Stage-2b
    async-work block. Surfaced & fixed one general runtime bug: the global `Function` wrapper broke
    `class extends Function` subclassing (`Reflect.construct` + `new.target`), which `@rsbuild/core`'s
    rspack-chain config depends on; and a browser-only crash where `Buffer.toString('utf8')` on a
    SAB-backed view (the threaded wasm binding's shared memory) threw in `TextDecoder` — fixed by
    copying the range before decoding. Shipped as the **Rsbuild (React)** template (TS + JS, `Tooling`).
    Both spikes (`spike-rspack.mjs` + `spike-rsbuild.mjs`) are registered in the CI net tier and HMR is
    studio-confirmed, so the template is **graduated** (no longer `experimental`).
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
- ✅ **Phase 4 (cont.) — Rspack + Rsbuild proven headless AND shipped.** The Rust/webpack-
  compatible bundler now runs in-VM with **zero new install plumbing**: `@rspack/core →
  @rspack/binding` publishes `@rspack/binding-wasm32-wasi` (a `wasm32-wasip1-threads` build,
  `cpu: wasm32`) as an optionalDependency, and because the runtime reports `process.arch ===
  'wasm32'` real npm auto-selects it — the exact Stage-2c path that already brings in
  `@rolldown/binding-wasm32-wasi` (Vite) and `@node-rs/*`. Crucially the `wasm32-wasip1-threads`
  binding runs on our emnapi/`@napi-rs/wasm-runtime` + WASI host **out of the box** — it does NOT
  hit the Stage-2b async-work (AWMT) block; the Rust bundler compiles guest code in the browser.
  - **Rspack** (`scripts/spike-rspack.mjs`) — `npm install @rspack/core @rspack/cli` pulls the wasm
    binding (never a native `@rspack/binding-<platform>`); `rspack build --mode production` emits
    `dist/main.js` + `dist/index.html` (~0.6s), and `rspack serve` binds `:8081` and serves `GET /
    → 200`.
  - **Rsbuild** (`scripts/spike-rsbuild.mjs`, shipped as the **Rsbuild (React)** template in TS + JS,
    `Tooling`, **graduated** — non-experimental) — `@rsbuild/core` + `@rsbuild/plugin-react` + React 19;
    `rsbuild dev` binds `:3000`, builds in ~0.6s, and serves `GET / → 200` with the real Rsbuild HTML.
    Both spikes are registered in the CI net tier (`scripts/run-spikes.mjs`); HMR studio-confirmed.

  This needed **one general runtime fix** (kept regardless of the templates):
  - **`class extends Function` subclassing (`packages/runtime/index.js`).** The global `Function`
    wrapper (which redirects escape-hatch `new Function('s','return import(s)')` bodies to the
    loader-backed dynamic import) forwarded construction with `NativeFunction.apply(this, args)`,
    which ignores `new.target` — so a `super()` from `class X extends Function` produced a bare
    function with `Function.prototype`, dropping the whole subclass prototype chain. `@rsbuild/core`'s
    config chain (rspack-chain) bottoms out at exactly that shape (`class extends Function` returning
    a `Proxy`), so every chained mixin method vanished (`this.extend is not a function`) and `rsbuild
    dev` died. Fixed by constructing via `Reflect.construct(NativeFunction, args, new.target ||
    OcFunction)` (+ `Object.setPrototypeOf(OcFunction, NativeFunction)` for statics). Reproduced and
    regression-gated minimally; `verify-node` stays 100% green (no ESM/interop regression).

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
- ✅ **Python (CPython via Pyodide) — landed** as the first **Native** template tab. `python` /
  `python3` are eager tiny launchers on PATH (`packages/kernel-host/programs/python.js`), but the
  heavy Pyodide (CPython/WASM) bundle is fetched from a same-origin vendored index
  (`packages/studio/public/vendor/pyodide/`, built by `npm run vendor:pyodide`) and booted **lazily**
  the first time a `python` process runs — via `globalThis.__ocInstallPython`
  (`packages/runtime/builtins/python.js`), exactly like the Bun shim's `__ocInstallBun`. So a plain
  `node`/`bun` process pays nothing at boot. v1 scope is terminal-first (scripts, `-c`, a REPL,
  `python -m pip install`); the project dir is mirrored into Pyodide's FS and prebuilt wheels
  (NumPy/pandas) auto-load from imports. Pyodide has no real sockets, so there is no dev-server /
  preview bridge yet (a future step could virtualize one). To pick the vendored wheel set, set
  `VV_PYODIDE_PACKAGES` before `vendor:pyodide`.
- ⏳ **Phase 5 — documented drops (won't build):** all **NativeScript** (Mobile & XR — need a
  device/emulator runtime), **WordPress/PHP** (php-wasm),
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

**Non-lockstep drop-in aliasing — `bcrypt -> bcryptjs` — DONE.** Extended the registry aliasing
seam with a second table `NATIVE_DROPIN_ALIASES` (`packages/runtime/toolchain-shims.js`) for
API-compatible drop-ins whose versions are NOT published in lockstep (so the packument can't be
served verbatim). `synthesizeRemappedPackument()` keeps the SOURCE's version list + dist-tags — so
any `bcrypt@<range>` still `semver.maxSatisfying`-resolves — while pointing every entry at the
TARGET's (bcryptjs) latest tarball + deps and stripping native-install metadata
(scripts/optionalDependencies/cpu/os). The Fetcher Worker's remap branch fetches both packuments and
falls back to the plain fetch on error. `bcryptjs` is a zero-dependency pure-JS reimplementation with
an API-compatible surface (`hash/hashSync/compare/compareSync/genSalt/getRounds`), so `require('bcrypt')`
Just Works — unblocking the many auth libs that pull native `bcrypt` (which has no wasm build).
Guarded offline by `scripts/spike-toolchain.mjs` (table + synth structural assertions) and proven
live in the browser (`npm install bcrypt`; `hashSync`/`compareSync` round-trip).

- **Deferred (documented, not shipped):**
  - **`@swc/core -> @swc/wasm`** — versions ARE lockstep, but `@swc/wasm` is a wasm-bindgen web build
    with a *different* loader/API surface (it isn't a registry rename): it would need **sidecar
    dependency injection** (install the wasm variant alongside and route `@swc/core`'s own fallback to
    it), not a packument swap. Tractable next, but a distinct mechanism.
  - **`sharp -> @img/sharp-wasm32`** — uses the Stage 2c optionalDependency/`wasm32-wasi` path, but the
    wasm build requires **multi-threaded Wasm**, currently blocked upstream in-VM. Revisit when MT-Wasm lands.
  - **`sqlite3`** — no API-compatible pure-JS/wasm drop-in exists (`better-sqlite3`/`sql.js`/`node:sqlite`
    all differ in surface), so no safe rename or remap is possible. Out of scope for this mechanism.

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

## VitePress — graduated (Docs template)

VitePress was dropped once and has now been **re-added** — the fundamental blocker was fixed
upstream. The history, kept for context:

1. **Vite 5 config bundler** — VitePress 1.x runs **Vite 5**, whose config loader esbuild-bundles
   `.vitepress/config.*` (`loadConfigFromFile` → `loadConfigFromBundledFile`). It has two branches:
   for an **ESM** config it `await import(file://…temp.mjs)`s the bundle; for a **CommonJS** config
   it takes a synchronous path (`require.extensions` override + `module._compile`). The ESM branch's
   async `file://` dynamic import does **not** settle in-VM — VitePress boot hangs right after Vite's
   "CJS build … deprecated" line (an offline module-system probe of the *synchronous* `require` path
   passed and was misleading; the real `await import()` path is what stalls). **Fix:** ship a
   **CommonJS** `.vitepress/config.js` and a package **without** `"type": "module"`, so Vite takes
   its synchronous CJS branch — no `file://` async import, no hang. (A config is still required so we
   can set Vite `base` to the preview prefix for the history-mode router.)
2. **worker_threads transferList** — importing VitePress spins up a `synckit`-backed worker via
   `new Worker(f, { workerData: { port }, transferList: [port] })`. The runtime's nested-Worker
   spawn relays `workerData` across two `postMessage` hops (process-worker → kernel-worker → child)
   but originally transferred only the parentPort, so the embedded `MessagePort` threw "could not be
   cloned" at import (a silent hang). **Fixed here:** the spawn path now collects MessagePorts
   embedded in `workerData`/`transferList` and adds them to both hops' transfer lists (see
   `packages/runtime/node/lib/worker_threads.js`, `index.js` `host.spawn`, `kernel-worker.ts`
   `spawnWorker`).
3. **synckit (still present — worked around, not removed)** — VitePress's Shiki highlighter
   (`highlight.ts`) pre-loads only the languages in `markdown.languages`; for any *other* code-block
   language it calls `resolveLangSync(lang) = createSyncFn('worker_shikiResolveLang.js')` — synckit,
   which blocks on `Atomics.wait` then `receiveMessageOnPort`. A browser worker can't receive a port
   message while blocked (delivery needs the event loop), so an on-demand language load throws
   mid-render ("Cannot read properties of undefined (reading 'message')"). Upstream did NOT remove
   this synckit path (the 1.6.0 `markdown-it-async` change was elsewhere). **Workaround:** the
   template pre-loads a broad set of common languages in `markdown.languages` (loaded async at
   `createHighlighter`, which works), so the synckit path is never taken for those. Trade-off: a
   code block in a language *not* pre-loaded still throws — add it to the config list.

Shipped as `vitepressTemplate()` (Docs category) in `packages/studio/src/vv/templates.ts` with a
CommonJS config + pre-loaded languages. `scripts/spike-vitepress.mjs` proves the dev server boots and
serves headlessly, but note it runs under Node's real `worker_threads` where synckit works, so it
CANNOT catch a missing language — the synckit language path is validated only in a real browser.
**Docusaurus** (Prism) remains for the React-docs showcase.

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

## Import / export & share — zip export, folder import, shareable URL (this change)

A playground spreads when a project can leave it and come back. This change ships the
**pure client-side** subset of "import/export & share" — no backend, no CORS, no gist
service — so it works entirely in the browser (and offline):

- **Export as `.zip`.** Any workspace folder downloads as a real PKZIP archive
  (Explorer root context-menu "Export as Zip…", the command palette, source-only —
  `node_modules`/`.git` excluded).
- **Import a folder as a new project.** The Home "Import a folder" card opens the OS
  folder picker (`<input webkitdirectory>`); a folder can also be **drag-dropped**
  onto Home. Both create a fresh project from the chosen tree.
- **Shareable URL.** A workspace folder serializes to a **self-contained compressed
  link** (`#share=…`): source gzipped + base64url'd into the URL hash, copied to the
  clipboard. Opening such a link imports it as a new project. Source-only and
  **size-capped** — beyond the cap you get a clear "too big to share" message rather
  than a broken link.

- **Codecs (`packages/kernel-host/archive.js`).** Environment-agnostic like
  `dep-cache.js`: it uses only web primitives present in both a browser and modern Node
  (`CompressionStream`/`DecompressionStream`, `DataView`, `btoa`/`atob`), so there is
  **no npm zip/gzip dependency**. ZIP entries are DEFLATE-compressed with the platform's
  own `CompressionStream('deflate-raw')` (STORE fallback when DEFLATE wouldn't shrink),
  with a hand-written CRC-32 + local/central-directory/EOCD records; the share payload
  is a gzipped JSON manifest (text files inline UTF-8, binary as base64) encoded
  base64url. A `.d.ts` gives the studio real types.
- **Bulk RPCs (`packages/core/src/workers/kernel-worker.ts`).** `vv-read-tree` walks a
  project in the worker (the sole VFS holder) and returns the whole source tree in one
  reply — `node_modules`/`.git` excluded, bounded by file count + bytes — instead of
  thousands of per-file `vv-read-bytes` round-trips; it backs both export and share.
  `vv-import-tree` bulk-writes an imported tree via `writeFilesBatch`; it backs both
  folder import and shared-link load.
- **Controller (`packages/studio/src/vv/controller.ts`).** `readProjectTree` /
  `exportProjectZip` / `importFilesAsProject` / `shareProject`, the OS folder-picker and
  drop entry points, and a boot hook (`loadSharedFromUrl`, run once the kernel is ready)
  that decodes a `#share=` payload and clears the hash so a reload doesn't re-import. An
  imported/shared project with a runnable `package.json` script gets a **synthesized run
  manifest** so the Run button auto-installs + starts its dev server (otherwise Run drops
  into a shell).
- **Gate.** `scripts/spike-zip-share.mjs` (offline, in `run-spikes.mjs`) proves the ZIP
  writer by re-decoding its output with Node's own `zlib` (bytes + CRC per entry) and
  round-trips the share codec over a mixed text+binary tree — pure web primitives, no
  kernel/wasm needed.
- **Follow-up (now shipped).** GitHub-repo and npm-package import (both need network /
  CORS) land in the next section; the share model stays intentionally backend-free (no
  gist/paste service), trading a size cap for zero infrastructure.

## Import from GitHub repo / npm package (this change)

The remote half of "import/export & share", still **fully client-side** — no backend, no
proxy. The studio page is cross-origin-isolated (COEP `require-corp`), and every source
here sends `Access-Control-Allow-Origin: *`, so a plain `cors` `fetch()` from the main
thread both reads the bytes and satisfies COEP. The Fetcher Worker isn't involved.

- **GitHub (public repos).** Paste `owner/repo`, `owner/repo@ref`, or a `github.com`
  URL. Resolves the default branch via `api.github.com/repos/…` (unless a ref is given),
  lists files with `git/trees/<ref>?recursive=1`, then downloads each blob from
  `raw.githubusercontent.com` with bounded concurrency. 404 → "not found (may be
  private)"; API rate-limit (403, `x-ratelimit-remaining: 0`) → a clear "try again
  later". Public repos only (no token/auth in this pass).
- **npm.** Paste `name`, `name@version`, or `name@tag` (scoped ok). Fetches the packument
  from `registry.npmjs.org`, resolves a dist-tag/exact version (unknown/range → `latest`;
  no semver-range resolution), downloads `dist.tarball`, gunzips + untars it. The package
  contents become the project (its dependencies are **not** vendored — Run reinstalls).
- **Tar reader (`packages/kernel-host/tar.js`).** Env-agnostic ustar reader (only
  `TextDecoder` + typed arrays) handling the `prefix` field, GNU `L` long names, and pax
  `path`; `stripFirstSegment` drops the archive's single root dir (`package/` for npm,
  `<repo>-<ref>/` for GitHub). A `.d.ts` gives the studio types. (An equivalent in-VM
  copy lives in `programs/npm.js`; the small duplication is intentional — it can't be
  imported here.)
- **Fetch logic (`packages/studio/src/vv/import-remote.ts`).** `parseGithubSpec` /
  `fetchGithubRepo` and `parseNpmSpec` / `fetchNpmPackage` return the same `ImportTree`
  shape the folder importer produces, so both land through the existing spine
  (`importFilesAsProject` → `vv-import-tree` → synthesized run manifest). `node_modules` /
  `.git` are excluded and the tree is file-count + byte capped (a "truncated" warning if
  hit), reusing gunzip from `archive.js`.
- **Controller + UI.** `openImportRemote` / `importGithubRepo` / `importNpmPackage` on the
  controller; a snapshot-driven `ImportRemoteDialog` (tabbed GitHub / npm, live progress)
  opened from a Home "Import from GitHub or npm" card and a command-palette entry.
- **Gate.** `scripts/spike-tar.mjs` (offline, in `run-spikes.mjs`) hand-builds a real
  ustar archive (incl. a deep path via the `prefix` field + a full-range binary blob),
  gzips it with Node's `zlib`, then decodes it with `archive.js` gunzip + `tar.js`
  `parseTar` and checks every entry byte-for-byte, plus `stripFirstSegment`.

## Bun support — a Node-backed shim, no native binary (this change)

Bun has no `wasm32` build, so instead of vendoring a real binary (npm/yarn/pnpm/corepack/tsgo
are vendored packs unpacked into the VFS) Bun is **emulated on top of our Node runtime**. All
of its pieces are always on PATH (in `COREUTILS`), nothing is lazily unpacked.

- **Runtime shim** (`packages/runtime/builtins/bun.js`): a `Bun` global — `version`/`main`/`env`,
  `escapeHTML`/`deepEquals`, `hash`/`crc32`, `gzip`/`gunzip`, password `hash`/`verify`,
  `CryptoHasher`, `Transpiler`, `$` — plus **`Bun.serve`** (fetch handler; `routes` with static
  paths, `:params`, `*` wildcards, `BunRequest.params`, static Response caching, method-specific
  handlers; server-side **WebSockets** — RFC 6455 handshake, frame codec, `ServerWebSocket`
  send/close/subscribe/publish/cork + pub/sub topics) and **`bun:*` modules** (`bun:test` +
  `expect`).
- **Zero-config `.ts`/`.tsx`** (`packages/runtime/typescript-transform.js`): a synchronous,
  dependency-free type-strip + JSX lowering invoked by `module.js`, gated so plain JS is
  untouched. It handles the awkward spots — return-type annotations inside object literals (the
  `Bun.serve` shape), typed/destructured params, inline object/function type annotations.
- **CLI** (`packages/kernel-host/programs/bun.js`): `bun run`, `bunx` (delegates to `npx`),
  install delegation, and require/unhandled-rejection errors surfaced instead of a silent exit.
  `kernel-worker.ts` `pmFromCmd` maps `bun`/`bunx` to the `bun` PM so a Bun template's Run
  auto-installs with `bun`.
- **Templates**: a new **"Bun" category** (serve / routes / websocket / react) with the official
  Bun logo.
- **Gate**: `scripts/spike-bun*.mjs` (offline + kernel) cover the transform, the route matcher,
  the WebSocket frame codec, and the Bun global API.

## More studio templates — Tailwind v4, TanStack Router, Vitest (this change)

Three commonly-requested templates, each made to boot in the in-VM runtime (bringing the
catalog to ~49 across 8 categories):

- **Tailwind + shadcn/ui** (React + Vite + Tailwind CSS **v4**, `Frontend`, graduated). Runs v4
  in-VM by aliasing the native lightningcss addon to its official WASM build
  (`lightningcss → lightningcss-wasm` in `NATIVE_WASM_ALIASES`); `@tailwindcss/oxide` resolves
  via its own `wasm32-wasi` optional dep. Gated by `scripts/spike-tailwind.mjs`.
- **TanStack Router** (type-safe, file-based routing for a React SPA on Vite, `Frontend`,
  experimental). Ships the SPA rather than TanStack Start, whose Nitro SSR Vite plugin fails to
  initialize in the WebContainer at config-load time.
- **Vitest** with the `@vitest/ui` dashboard as its preview (`Tooling`, graduated). Uses the
  `worker_threads` pool (the default fork IPC mangles Vitest's collected task tree in-VM →
  "Entity must be found for task") and disables the browser auto-open (ENOENT in a headless VM).
  Gated by `scripts/spike-vitest.mjs`.

## Terminal shell polish — Tab completion, history, colored `ls` (this change)

The browser terminal's built-in `sh` (`packages/kernel-host/coreutils.js`) grew three
interactive niceties:

- **Tab completion**: the first token completes against builtins + PATH programs, later tokens
  against the VFS (directories suffixed `/`). A unique match inserts + a trailing space; an
  ambiguous one fills the longest common prefix; otherwise it lists candidates and redraws.
- **`history`**: a new `sh` builtin printing the interactive command history (bash-style,
  1-indexed), backed by the same module-scoped array the ↑/↓ line-editor recall uses.
- **Colored `ls`**: directories render bold-blue (GNU `di=01;34`). Crucially it's **TTY-gated**
  via GNU-style `--color=auto|always|never` (default `auto`): color only when an interactive
  terminal is attached, signaled by a `VV_TTY=1` env var the interactive shell sets at startup
  (children inherit it). Batch mode (`sh script`/`sh -c`, used by CI) never sets it, so
  captured/piped output stays plain — this fixed a `verify-node` regression where the `ls`
  assertion saw ANSI escapes instead of a bare `a`.

Also fixed two multi-root Explorer/editor sync bugs: switching to a tab whose file sits in a
collapsed folder now expands its ancestors + scrolls the row into view, and selecting a tab now
makes that file the sole tree selection (no stale highlight from another project).

## Studio UI polish — theme switcher, reset, status bar, breadcrumb (this change)

A batch of IDE-shell improvements:

- **Light/Dark/System theme switcher.** `next-themes` `ThemeProvider` at the root + a no-flash
  inline script; a bottom-of-ActivityBar toggle (Follow system / Light / Dark). The editor
  (Monaco `vs`/`vs-dark`) and terminals (xterm light/dark palette) follow the resolved theme via
  a new `controller.applyUiTheme()`, driven by an `AppShell` effect; the hardcoded panel colors
  gained light + dark variants.
- **"Reset everything"** now also clears the recent-projects registry (`vv-workspace-projects`),
  and its confirm dialog can no longer be dismissed (backdrop/Escape/X) while the wipe runs.
- **Status bar** is VS Code blue (`#007acc`) with white text.
- **Editor breadcrumb** shows the active file's path as `Workspace > <project> > …`, and the
  active tab carries a 2px `#007acc` top accent.
- The file-tree panel (and its ActivityBar tooltip) is renamed **"Explorer" → "Workspace"**
  (internal view keys unchanged).

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

---

## ✅ SHIPPED — Preview origin isolation (three configurable modes)

Status: **all three modes shipped.** Mode A (same-origin) is the default; mode B (shared preview
origin) is selected with `VITE_PREVIEW_ORIGIN` (+ optional `VITE_PREVIEW_POPOUT`); mode C
(wildcard per-port origin) is selected with `VITE_PREVIEW_WILDCARD_DOMAIN`. The design essay below
records the rationale; the boxed **"As shipped"** notes reconcile it with the final surface.

> **As shipped — the mode-C surface.** Preview hostnames are `<token>--<port>-vv.<domain>`
> (single random per-boot `<token>`; `-vv` is a **suffix** tag so the Worker and `sw.js` can tell
> Vivari previews apart from other apps on the same base domain). The tag is a suffix — not a prefix
> — because Cloudflare routes only allow the `*` wildcard at the **start** of the hostname, so the
> valid, narrow route is `*-vv.<domain>/*` (`vv-*.<domain>/*` is rejected as an infix wildcard, and
> `*.<domain>/*` would be too broad). Config is a single env
> `VITE_PREVIEW_WILDCARD_DOMAIN=<base-domain>` (SDK: `BootOptions.previewWildcardDomain`); it takes
> precedence over `VITE_PREVIEW_ORIGIN`. Infra is one **proxied wildcard DNS record** + a
> **Cloudflare Worker** on route `*-vv.<domain>/*` (`worker/`, `npm run build:worker` /
> `deploy:worker`) that serves the static SW runtime. Because the preview hosts are subdomains of
> the IDE's own base domain they are **same-site**, so the isolated pop-out is **gate-free**.

**Design decision: don't pick one topology — make it a deploy-time config knob.** All three
options below are the *same core* (an SW that proxies preview fetches to the kernel running in
the editor tab); they differ only along two axes — **transport** (how the SW reaches the kernel)
and **routing** (where the port is encoded). A single `preview` option selects the mode, so each
self-hoster picks what their infra allows:

- **Mode A — `same-origin`** (today's behavior, the default): preview at
  `vivari.pages.dev/preview/<port>/`. Zero extra infra, **no isolation** (preview shares the IDE
  origin). SW reaches the kernel via `findKernelClient()` (same-origin).
- **Mode B — `shared`**: a second Pages project → `vivari-preview.pages.dev/preview/<port>/`.
  Isolates **IDE ↔ preview**. No custom domain, no DNS. SW reaches the kernel via a hidden bridge
  iframe + persistent `MessagePort` (cross-origin).
- **Mode C — `wildcard`**: one origin per port → `<token>--<port>-vv.jamesisme.com`
  (StackBlitz/CodeSandbox model). Isolates **IDE ↔ preview AND preview ↔ preview**, and matches
  real `localhost:<port>` web-platform semantics. Same bridge transport as B (one bridge iframe +
  `MessagePort` **per port**); port is read from the **hostname**; keep-prefix templates get their
  base auto-rewritten to `/` at creation (apps are served at the origin root). Requires a base domain
  + proxied wildcard DNS + a Cloudflare Worker route (`*-vv.<domain>/*`).

Modes B and C share ~95% of the code (bridge + `MessagePort` + dual-mode SW). C only adds
hostname-based routing on top of B. A already exists. So "support all three" = keep path A +
build the cross-origin bridge once (B & C) + a path|hostname routing switch (C).

### Why (the isolation problem this solves)
- Today previews run **same-origin** with the IDE (`/preview/<port>/`). Code in a preview
  (incl. AI-generated code) therefore shares the studio's origin: it can read/write
  `document.cookie`, `localStorage`, IndexedDB, **OPFS**, and call same-origin app APIs —
  i.e. it can steal auth/session state and corrupt persistence, and previews aren't isolated
  from each other. Moving previews to a **separate origin** puts the browser's Same-Origin
  Policy between preview code and the IDE (this is exactly what StackBlitz does with
  `*.webcontainer.io` / `*.staticblitz.com` and CodeSandbox with `csb.app`).
- Blocker to open up for **untrusted code / public embeds / an AI panel** — do this first.

### How we deploy today (context for the change)
- **One unified Cloudflare Pages project** → `https://vivari.pages.dev`. Build command
  `bash scripts/cloudflare-build.sh`, output dir `dist/`.
  - `scripts/cloudflare-build.sh`: provisions Rust + wasm-pack + bun, builds the Wasm crates
    (`build:vfs`/`codec`/`crypto`), vendors the real package managers
    (`vendor:npm`/`yarn`/`pnpm`/`corepack`/`tsgo`), then builds each surface with
    `VV_BASE=/studio/` (studio), `VV_BASE=/embed/` (embed), landing, docs.
  - `scripts/assemble-site.mjs` composes `dist/`: landing at `/`, docs at `/docs/`,
    studio at `/studio/`, embed at `/embed/`; and **hoists** the SW runtime tree
    (`sw.js`, `vv-devtools/`, `devtools/`, `devtools-host.html`) to the **origin root**
    because the SW claims root scope and hard-codes those absolute paths. It also emits
    `_headers` (COOP/COEP `require-corp` scoped to `/studio/*`, `/embed/*`, `/docs/*`,
    `/sw.js` + `Service-Worker-Allowed: /`) and `_redirects` (SPA fallback
    `/studio/* → /studio/index.html`).
  - Studio itself is served at `https://vivari.pages.dev/studio` (repo name → project name
    `vivari` → `vivari.pages.dev`). No custom domain (pure `*.pages.dev`).
- Cross-origin isolation: the studio page is `COOP: same-origin` + `COEP: require-corp`
  (needed for `SharedArrayBuffer`); dev/preview headers come from `packages/studio/vite.config.ts`
  (`swScope()` middleware) and prod from the generated `_headers`.

### The three modes at a glance

| | **A. same-origin** (default) | **B. shared** | **C. wildcard** |
|---|---|---|---|
| Preview URL | `vivari.pages.dev/preview/5173/` | `vivari-preview.pages.dev/preview/5173/` | `<token>--5173-vv.jamesisme.com/` |
| SW → kernel transport | `findKernelClient()` (same-origin) | bridge iframe + `MessagePort` | bridge iframe + `MessagePort` |
| Port encoded in | **path** | **path** | **hostname** |
| keep-prefix hack | needed | needed | **removed** |
| Headers | studio `require-corp` (today) | preview origin `credentialless` + `CORP: cross-origin` | same as B |
| Extra infra | **none** | +1 Pages project (0 DNS) | custom domain + wildcard DNS + Worker |
| Isolates IDE ↔ preview | ❌ | ✅ | ✅ |
| Isolates preview ↔ preview + per-port fidelity | ❌ | ❌ | ✅ |

Note: **a shared origin (A or B) still runs many ports/projects at once** — they're multiplexed
by **path** (`/preview/5173/`, `/preview/3000/`), one kernel serving all. What a shared origin
gives up is *isolation between previews* + per-port fidelity, not the number of previews. Mode C
exists precisely to restore that per-port fidelity.

### Config surface (how a deploy picks a mode)

A discriminated union on `BootOptions.preview`, defaulting to A (so today's behavior is
unchanged):

```ts
// As shipped, BootOptions carries flat, optional fields (the mode is INFERRED):
interface BootOptions {
  previewOrigin?: string;          // B — 'https://vivari-preview.pages.dev'
  previewWildcardDomain?: string;  // C — 'jamesisme.com' (takes precedence over previewOrigin)
  previewWildcardPrefix?: string;  // C — default 'vv-'
  previewPopout?: 'same-origin' | 'isolated'; // B pop-out behavior; C is always isolated
}
// none set → mode A (same-origin, today's behavior, byte-for-byte).
```

Two abstractions keep the modes decoupled:
- **IDE side** — `resolvePreviewUrl(port)`: A/B join a path; C fills the template.
- **SW side** — `parsePort(request)`: A/B regex the path `/preview/(\d+)/`; C reads
  `location.hostname`.
- **Transport** — A calls `findKernelClient()`; B/C read `kernelPort` from the bridge. The bridge
  iframe is **only mounted when `mode !== 'same-origin'`**, so mode A carries **zero added cost**
  (byte-for-byte today's path).

Selected at deploy time via env (studio reads these in `controller.ts`; the mode is inferred, no
separate `VITE_PREVIEW_MODE`):
```
# A — default: set nothing
VITE_PREVIEW_ORIGIN=https://vivari-preview.pages.dev            # B (+ optional VITE_PREVIEW_POPOUT=isolated)
VITE_PREVIEW_WILDCARD_DOMAIN=jamesisme.com                      # C (precedence over B)
```
This is a per-deploy choice, not a per-user runtime toggle (simpler; a UI toggle can wrap it later
without touching the core).

### Domain options + the `*.pages.dev` constraint
- A Pages **project** only gets `<project>.pages.dev` (preview deploys are
  `<hash>.<project>.pages.dev`); you **cannot** mint `preview.vivari.pages.dev`. So a separate
  preview origin = a **second Pages project** → `vivari-preview.pages.dev`.
- **Mode B: two `*.pages.dev` projects.** Zero DNS, and — because `pages.dev` is on the
  **Public Suffix List** — `vivari.pages.dev` and `vivari-preview.pages.dev` are treated as
  **different sites (cross-site)**, i.e. a *cleaner* isolation boundary than same-TLD subdomains
  (cookies can't be shared even deliberately). **⚠️ But cross-site is exactly what breaks the
  `isolated` pop-out** (see the validated note below): a standalone preview tab is storage-partitioned
  away from the editor, and Chrome's Storage-Access gate can't un-partition a Service Worker → the
  "connect this tab" gate never grants. So on two `*.pages.dev` projects, `isolated` pop-out does **not**
  work; use `same-origin` pop-out, or go same-site (below), or mode C.
- **Custom domain — same-site subdomains (RECOMMENDED for `isolated`, validated live).** We own
  `jamesisme.com` (a Cloudflare zone). Map **both** projects to subdomains of it: IDE
  `vivari.jamesisme.com` → CNAME `vivari.pages.dev`; preview `vivari-preview.jamesisme.com` → CNAME
  `vivari-preview.pages.dev`, set `VITE_PREVIEW_ORIGIN=https://vivari-preview.jamesisme.com`, and
  **open the editor at `vivari.jamesisme.com`** (not the `.pages.dev` URL). Because both are subdomains
  of the same registrable domain they are **same-site** → browsers do **not** storage-partition them →
  the `isolated` pop-out reaches the kernel **with no gate at all** (verified: `vivari-preview.jamesisme.com/preview/5173/`
  opens straight into the preview). You still get full **origin isolation** (localStorage/OPFS/IndexedDB/DOM
  are per-origin), so preview code (incl. your npm deps) can't touch IDE storage. The only residual
  same-site leak is **domain-wide cookies** (`Domain=jamesisme.com`) — so **don't set domain-wide
  cookies on the IDE**. This is the sweet spot for trusted-own-code; for untrusted code at scale you
  want cross-site + gate (mode C, StackBlitz-style).
- **Mode C requires a custom domain.** `*.pages.dev` can't do wildcard; Cloudflare **Pages custom
  domains are exact hostnames only (no `*.`)**, so wildcard needs a **Cloudflare Worker route**
  (`*.jamesisme.com/*`) serving the static SW + bridge (or Cloudflare for SaaS).
- **Free-TLS gotcha (single-level wildcard):** Cloudflare's free Universal SSL auto-issues a cert
  covering the apex + a **single-level** wildcard (`jamesisme.com` + `*.jamesisme.com`). A wildcard
  cert covers exactly **one label**: `*.jamesisme.com` matches `abc.jamesisme.com` but **not**
  `abc.def.jamesisme.com`. So `*.preview.jamesisme.com` (two levels) is **not** covered by the
  free cert → TLS error → needs paid **Advanced Certificate Manager** (~$10/mo) or Total TLS. To
  stay free, keep preview hostnames **one level** under the apex and pack the port into the single
  label: `{id}--{port}--{hash}.jamesisme.com` (matches `*.jamesisme.com`). This is exactly why
  StackBlitz uses `--5173--` in the hostname instead of a nested subdomain.

### Running the wildcard next to existing subdomains (real `jamesisme.com` zone)

The zone already hosts ~18 subdomains (`chat`, `todo`, `k8s`, `learnk8s`, `www`, `a`, `hayin`,
`pui`, `db-realtime-chat`, …), all currently **DNS-only (grey cloud)**. Adding a `*.jamesisme.com`
wildcard for previews **does not touch any of them**, for two independent reasons:

1. **DNS: an explicit record always beats a wildcard** (RFC 4592). A `*` record only answers for
   names that have **no** record of their own; the mere *existence* of a name (any type) suppresses
   wildcard synthesis for it. Every existing subdomain has an explicit `A`/`CNAME`, so the wildcard
   never applies to them — it only fills the empty names (`{id}--{port}--{hash}`). The wildcard also
   never matches the apex or any two-label name.
2. **A Worker route only runs on proxied traffic.** A route `*.jamesisme.com/*` executes **only**
   for hostnames that go through Cloudflare's edge, i.e. **proxied (orange-cloud)**. All existing
   records are **DNS-only (grey)** → their traffic bypasses the edge entirely → the Worker never
   runs on them, even though the pattern would textually match.

Setup that keeps them safe:
- Add **one** DNS record `A * → 192.0.2.1` (or `AAAA * → 100::`) set to **Proxied (orange)** — a
  placeholder IP the Worker never actually forwards to (it responds directly). Proxied wildcard
  records are now allowed on **all plans** (free included), so no upgrade is needed.
- Bind the preview Worker to route `*.jamesisme.com/*`, and make the Worker **defensive**: act only
  on hostnames matching the preview pattern (e.g. `/^[a-z0-9]+--\d+--/`); for anything else
  `return fetch(request)` (pass-through) or 404. This future-proofs the setup if a *new* subdomain
  is ever proxied.
- Leave the free Universal SSL as-is; it already covers `*.jamesisme.com`, so single-level preview
  hosts get a valid cert automatically.

**Cleaner-but-paid alternative:** put previews under a dedicated label `*.preview.jamesisme.com`.
This can never collide with apex-level subdomains and reads better, but it's a **two-level**
wildcard → requires ACM (~$10/mo) for the cert. Trade-off: pay for namespace isolation vs. the
free single-level scheme + defensive Worker.

### Why wildcard = one origin per (project, port) — the mode C rationale
The main driver is **web-platform fidelity, not just security**: on a real machine each port is
its own origin (`localhost:5173` ≠ `localhost:3000`). Cramming ports into one origin via a
`/preview/<port>/` path breaks anything keyed on origin:

| Keyed on origin | Breaks under shared-origin path routing |
|---|---|
| Cookie jar (session, CSRF, `SameSite`) | frontend + backend cookies collide at `/` |
| localStorage / IndexedDB / OPFS / Cache | services share one store → state bleed |
| CORS / `fetch` credentials | cross-service calls look same-origin (wrong) |
| Service Worker scope | an app's own SW registrations collide |
| Absolute paths `/` | router basename, `/asset.png`, `<base>` all break |

Wildcard-per-port fixes all of it *and* lets us delete Vivari's keep-prefix hack + SW
prefix-stripping + shim URL rewriting. Secondary benefit: previews are isolated from each other
(multi-tenant shared links).

**Decoding a StackBlitz preview URL** (the model to emulate):
```
https://vitejsvitelqrjey5b-c0kn--5173--87cf54cd.local-credentialless.webcontainer.io/
        └────── instance / project id ────┘  └port┘ └session hash┘ └ COEP mode ┘ └ base ┘
```
- port is encoded in the **hostname** (`--5173--`) so the SW routes by subdomain, no path prefix.
- `local-credentialless` selects **COEP credentialless** (there is also a require-corp variant).
- `*.webcontainer.io` is **wildcard DNS** → a new preview origin costs nothing to provision.

**Fundamental limitation (confirmed empirically):** the preview is a Service-Worker proxy to the
kernel running in the editor tab — it is **not a server**. The SW is a persistent per-origin
proxy *in your browser*; its live link to the kernel (a `MessagePort`, held in SW memory) is
shared by every tab/iframe it controls in that browser. Consequences observed on StackBlitz,
which we'll inherit:
- **Paste the preview URL into a new tab (same browser, editor tab open) → works**, without
  clicking "Open in new tab": any tab on the preview origin is claimed by the SW, which already
  holds the kernel port. It "works" because the SW serves it, not because a server exists.
- **"Open in new tab" sometimes needs a popup + reload** ("You're almost there / connect this tab
  to its project"): that happens only when the SW's in-memory kernel port has lapsed (SW was
  killed while idle) — the popup provides a `window.opener` channel to re-handshake. Once the SW
  is warm/connected, a plain paste is enough.
- **Open on another machine → fails**, even if the project is still open elsewhere: the kernel
  lives in the *first* machine's tab RAM; the second machine's browser has its own SW and no
  kernel to reach (postMessage/MessagePort/opener never cross the network).
- **Close the editor tab → the preview dies** ("Could not find project").

So the URL is a **capability ticket valid only inside the browser holding a kernel-connected SW**,
not a network address. This is inherent to every client-side container (Vivari included); a truly
persistent/shareable preview would require a server (i.e. leaving the no-server model) — position
that as a separate, future server-backed feature, not part of this work.

### Pop-out behavior: `same-origin` vs `isolated` (shipped, mode B)

"Open in new tab" opens a preview as its **own top-level tab**, which is where the capability-ticket
limitation bites: a standalone cross-site tab lives in a **different browser storage partition** than
the editor tab, and the editor's `COOP: same-origin` (needed for `SharedArrayBuffer`) severs
`window.opener` — so there is **no pure-code channel** from the standalone tab to the kernel. Two
honest choices, exposed as a per-deploy axis `BootOptions.previewPopout` (env `VITE_PREVIEW_POPOUT`),
default `same-origin`. The **embedded** preview stays isolated on the preview origin in both cases;
only the explicit pop-out differs.

| `previewPopout` | Pop-out origin | Isolated from IDE? | Friction |
|---|---|---|---|
| `same-origin` (default) | IDE origin (`vivari.pages.dev`) | No | None — proxies through the same-origin SW in the kernel's partition |
| `isolated` | preview origin (`vivari-preview.pages.dev`) | Yes | One-time "connect this tab" gate when storage is partitioned |

- **same-origin** trades the pop-out's isolation for zero friction. Because it runs on the IDE origin,
  a pop-out CAN read/clear IDE storage (localStorage, the OPFS-persisted VFS, caches) — fine when you
  run your own trusted code; not fine for untrusted code. Implemented by opening `/preview/<port>/` on
  the studio origin and registering the same-origin SW **in addition to** the mode-B bridge (see
  [`packages/core/src/bridge.ts`](packages/core/src/bridge.ts) `registerSameOriginServiceWorker`).
- **isolated** keeps the pop-out off the IDE origin. It only **auto-connects when storage is
  unpartitioned**; otherwise the preview SW serves a "connect this tab" gate
  ([`previewConnectingHtml`](packages/studio/public/sw.js)) that best-effort calls
  `document.requestStorageAccess()` in the click gesture and reloads, falling back to "allow
  third-party data" instructions. This is exactly StackBlitz's "You're almost there" trade-off and is
  browser-dependent — validate on the live preview origin.
- Inbound ws/SSE for a pop-out is relayed to **both** SWs (same-origin controller + bridge port) via
  `KernelBridge.broadcastToPreviewSWs`, so it works whichever pop-out kind is configured.
- `same-origin-allow-popups` (keep `window.opener`) is **not** an option: it forfeits
  `crossOriginIsolated` → no `SharedArrayBuffer` → the kernel breaks. So there is no "isolated AND
  zero-friction" standalone pop-out; that's a hard browser constraint, not a missing feature.

#### The deciding factor for `isolated`: **same-site vs cross-site** (validated live)

Whether the `isolated` pop-out shows a gate — or "just works" — is decided entirely by whether the
IDE origin and the preview origin are the **same site** (same registrable domain) or not. Browsers
storage-partition **only cross-site** contexts; a same-site iframe is first-party and unpartitioned.
The kernel reaches the preview origin via a hidden bridge iframe *inside the editor tab*; for a
standalone pop-out tab to share that bridge's Service Worker registration + `MessagePort`, both must
land in the **same storage partition**.

| Deploy | IDE site | Preview site | Same-site? | Partitioned? | `isolated` pop-out |
|---|---|---|---|---|---|
| Two `*.pages.dev` projects | `vivari.pages.dev` | `vivari-preview.pages.dev` | **No** (PSL cuts `pages.dev`) | Yes | ❌ gate appears, **can't grant on Chrome** |
| Two subdomains of one domain | `jamesisme.com` | `jamesisme.com` | **Yes** | No | ✅ **no gate, connects straight** |
| StackBlitz | `stackblitz.com` | `webcontainer.io` | **No** (different domains) | Yes | ⚠️ gate ("You're almost there") — accepted for max isolation |

- **Why `*.pages.dev` fails:** `pages.dev` is on the **Public Suffix List**, so `vivari.pages.dev`
  and `vivari-preview.pages.dev` are *different sites* → cross-site → partitioned. Chrome's
  `requestStorageAccess()` reliably un-partitions **cookies only**, not Service Worker registrations,
  so the "connect this tab" gate can never bridge the two partitions. Result: the gate loops.
- **Why same-site works with no gate:** `vivari.jamesisme.com` and `vivari-preview.jamesisme.com`
  are both under registrable domain `jamesisme.com` → **same-site** → no partition wall exists in the
  first place → the pop-out tab shares the bridge's SW/port → reaches the kernel immediately. Storage
  is still **origin-scoped**, so isolation holds. **Verified live** (2026-07): `isolated` pop-out to
  `vivari-preview.jamesisme.com/preview/5173/` opens with no gate. Requires opening the editor at the
  `jamesisme.com` host — loading it via `.pages.dev` re-introduces cross-site and the gate returns.
- **Why StackBlitz still shows a gate:** they deliberately run *untrusted* code at scale, so they
  chose maximum isolation — `stackblitz.com` (editor) vs `webcontainer.io` (preview) are different
  registrable domains (cross-site, even stronger than same-TLD). The gate is the accepted cost of that
  choice, not a bug. Vivari's `isolated`-same-site is the right trade-off for **trusted-own-code**;
  the StackBlitz-style cross-site gate (and eventually mode C wildcard) is for **untrusted code**.
- **Practical guidance:** for `VITE_PREVIEW_POPOUT=isolated` without friction, deploy IDE + preview as
  **two subdomains of the same domain** and open the IDE at that domain. Two `*.pages.dev` projects
  can't do gate-free `isolated` — use `same-origin` pop-out there instead.

### What actually couples the SW to the IDE origin (and why splitting is safe)

A common misread is "the SW runs the editor, so we can't move it." Not so — in
[`packages/studio/public/sw.js`](packages/studio/public/sw.js) the SW is **preview-only**:
- Editor navigations pass straight through (`if (event.request.mode === "navigate") return;`), and
  editor assets/bundles/wasm/vendor/devtools all `return` to the network (the precache is gated on
  `CACHE_ON`, which is **off** in the studio build). The editor's `SharedArrayBuffer` capability
  comes from real **COOP/COEP HTTP headers** (`_headers` + `vite.config.ts` `swScope()`), **not**
  from the SW. So the editor does **not** need the SW to load or run.
- The **only** same-origin coupling is *reaching the kernel*: `findKernelClient()` uses
  `self.clients`, which sees same-origin windows only. That's the single thing to replace.

Therefore splitting the origin is safe: swap `findKernelClient()` (same-origin) for a **bridge
iframe + persistent `MessagePort`** (cross-origin). After the split the **IDE origin needs no SW
at all** — the SW lives entirely on the preview origin.

- **1 SW ⇔ 1 origin (+ scope).** Registered at `scope: "/"` (see
  [`packages/core/src/bridge.ts`](packages/core/src/bridge.ts)); every tab/iframe of an origin
  shares that one SW instance (this is why a pasted preview tab reuses the live kernel link).
- **Mode C = N service workers, 1 kernel.** Each `{id}--{port}--{hash}.jamesisme.com` is a distinct
  origin → its **own** SW registration (same `sw.js` code). All of them relay back to the **single**
  kernel in the editor tab over their own bridge/`MessagePort`. Multiple tabs of the *same* preview
  host still share one SW.

### Design (client-side only, no server compute)
- Kernel/VFS stay on the IDE origin. Preview origin is **static hosting only** (an SW +
  a tiny bridge doc). Data crosses via `postMessage` + a persistent `MessagePort`.

```
IDE window (vivari.pages.dev)               preview origin (vivari-preview.pages.dev)
  ├─ kernel worker (VFS/process)              ├─ /__vv-bridge.html  (hidden iframe)
  └─ KernelBridge                             ├─ /sw.js             (preview SW)
        │  1. load hidden bridge iframe ──────┤
        │  2. bridge registers SW + claims    │
        │  3. bridge → parent: vv-bridge-ready│
        │  4. IDE → bridge: vv-connect + port2 (transfer, cross-origin postMessage)
        │  5. bridge → SW: controller.postMessage(vv-connect, [port2])  (same-origin)
        │                                      └─ preview iframe /preview/<port>/ → SW
        └─ 6. SW routes each preview fetch over the persistent port → kernel → reply
```

- Preview iframe subresources hit the **preview SW** (same-origin to it), which relays to the
  IDE over the persistent port instead of `findKernelClient()`.
- The WS/SSE/title/CDP shims already use `parent.postMessage(..., '*')`, so HMR + DevTools
  keep working across origins (the preview iframe's `parent` is the IDE); only the HTTP proxy
  path needs the new port. `chobitsu.js` must also be served on the preview origin (the CDP
  bootstrap injects an absolute `/vv-devtools/chobitsu.js`).

### Concrete plan (files) — build once, gated by mode

Shared plumbing (needed by B and C; inert in A):
- `packages/core/src/types.ts` — add the `preview?: PreviewConfig` union to `BootOptions`
  (default `{ mode: 'same-origin' }`).
- `packages/core/src/preview.ts` — a `resolvePreviewUrl(port, cfg)` helper: A/B join
  `<origin>/preview/<port>/`, C fills the `template` (`{id}`/`{port}`/`{hash}`). Central place so
  the IDE + SW agree on the scheme.
- `packages/core/src/bridge.ts` — when `mode !== 'same-origin'`: create the hidden bridge iframe
  (on the preview origin) + persistent `MessagePort`; wire `vv-http` (transfer per-request reply
  port); forward `vv-keep-prefix-ports` over the port **for A/B only** (C drops it); origin-guard
  the `window` message relay (`vv-ws`/`vv-sse`). Expose the resolver to callers. In `same-origin`
  mode this whole block is skipped → no behavior/perf change vs today.
- `packages/core/src/vivari.ts` — thread `preview` config through to the bridge + `previewUrl()`.
- `packages/studio/public/sw.js` — dual-transport: on `vv-connect` store `kernelPort` and route
  `handlePreview` through it; else keep `findKernelClient()` (mode A). `parsePort(request)`
  switches path (A/B) vs hostname (C). Set `CORP: cross-origin` + `COEP: credentialless` on
  cross-origin responses; reconnect handshake for SW revival (detect the `/__vv-bridge.html`
  client, ask it to re-handshake); nav-command shim for back/forward on cross-origin frames.
- `packages/studio/public/__vv-bridge.html` — new (B/C); registers SW, relays the port,
  re-notifies the IDE on `vv-need-connect`. Reads the IDE origin from `?ide=<origin>` for
  `postMessage` targeting + origin validation.
- `packages/studio/src/vv/controller.ts` — build `PreviewConfig` from
  `import.meta.env.VITE_PREVIEW_MODE` / `VITE_PREVIEW_ORIGIN` / `VITE_PREVIEW_TEMPLATE`; pass to
  `KernelBridge`; `previewSrc()` uses the resolver; origin-guard `wirePreviewMessages`.

Deploy (only for B/C) — **as shipped**:
- **Mode B**: a second Pages project `vivari-preview` serving `sw.js` + `__vv-bridge.html` +
  `__vv-preview-boot.html` + `vv-devtools/chobitsu.js` + a `_headers` (`COEP: credentialless`,
  `CORP: cross-origin`, `Service-Worker-Allowed: /`). `scripts/assemble-preview.mjs` +
  `npm run build:preview`; IDE build sets `VITE_PREVIEW_ORIGIN=https://vivari-preview.pages.dev`
  (+ optional `VITE_PREVIEW_POPOUT=isolated`).
- **Mode C**: a Cloudflare **Worker** (`worker/`) on route `*-vv.<domain>/*` (single-level
  wildcard, free Universal SSL) serving the same static SW runtime for every subdomain — the
  Worker stamps the isolation headers + serves the boot fallback itself (no `_headers`/`_redirects`).
  Requires one **proxied** wildcard DNS record `*.<domain>`. `scripts/assemble-worker.mjs` +
  `npm run build:worker` / `npm run deploy:worker`; IDE build sets
  `VITE_PREVIEW_WILDCARD_DOMAIN=jamesisme.com`. See `sites/docs/docs/deployment.md`.

Ship order (no wasted work — the core is shared): A exists → add the bridge + dual-transport SW
and ship **B** (de-risks handshake/SW-revival/COEP with the least infra) → add hostname routing +
delete keep-prefix and ship **C**.

### Headers decision (validate on implementation)
- Keep the studio `require-corp` (lower risk). The preview iframe + bridge iframe carry their
  own `COEP: credentialless` (+ `CORP: cross-origin`), which a `require-corp` parent accepts as
  a COEP-bearing child. Preview docs use **credentialless** (not require-corp) so user apps can
  load cross-origin CDN assets. If a browser blocks the embed, fall back to flipping the studio
  to `COEP: credentialless` too (StackBlitz-style). Preview origin does **not** need
  cross-origin isolation (it never runs SAB).

### Edge cases / limitations
- **SW revival** loses the in-memory port → SW asks the bridge client to re-handshake; wait
  briefly before 503.
- **Open in new tab** — **as shipped**: works only while the editor tab is open (the kernel lives
  there), reached via the shared per-origin SW — same as StackBlitz (see the "fundamental
  limitation" above). A standalone tab can't reach the in-tab kernel via `window.opener` (COOP
  severs it), so it relays ws/SSE through the SW and HTTP through the bridge port. Behavior by mode:
  mode A opens same-origin (frictionless, not isolated); mode B opens same-origin by default or on
  the isolated preview origin with `VITE_PREVIEW_POPOUT=isolated` (a cross-site preview origin then
  shows a one-time Storage-Access **gate** — `previewConnectingHtml` in `sw.js`); mode C always
  opens on the per-port origin, which is **same-site** with the IDE, so it connects **gate-free**.
- **Multi-tab IDE**: assumes one kernel; multi-tab would need a `?k=<kernelId>` client→port map.
- **Back/forward** on a cross-origin frame needs the nav-command shim (can't touch its
  `history` from the parent); reload already falls back to a `src` cache-bust.

### Competitive positioning (why this matters beyond isolation)
- StackBlitz's polished preview infra (`*.webcontainer.io`, wildcard-per-port, credentialless,
  open-in-tab) is **first-party only**: their own error page states *"previews are not currently
  supported for `@webcontainer/api` consumers."* Third parties who license the API (Bolt et al.)
  must **build their own preview** (SW proxy, origins, cross-origin plumbing) — the exact hard
  part StackBlitz withholds.
- Vivari **ships an open, production-grade preview** (SW proxy + DevTools + WS/SSE/HMR tunnel)
  and, in **mode C**, can give **self-hosters/embedders** the wildcard-per-port experience
  StackBlitz reserves for itself — MIT, no license fee, no lock-in. This is a concrete
  marketing + technical differentiator, not just a security fix.

---

## 🐞 Breakpoint debugger (chii/chobitsu CDP, extended)

A source-level breakpoint debugger for guest code, speaking the **Chrome DevTools
Protocol** (`Debugger`/`Runtime` domains) so the same backend can drive both a
VS Code-style Monaco UI and (later) the chii Sources panel.

### Phase 1–2 — Node guest processes ✅ (this change)

Full **pause / step (over·into·out) / inspect / evaluate** for Node processes run
under debug mode, implemented by **source instrumentation** (no native inspector
in the browser). Zero cost when no session is attached.

**How it works**
- **Instrumentation** (`packages/runtime/instrument.js`) — `acorn` parses the
  guest's own source (node_modules excluded) on plain, line-preserving ECMAScript
  (after the TS/JSX strip, before the ESM rewrite in `packages/runtime/module.js`).
  It weaves in probes — `__vvdbg.line/brk/push/pop` — and a per-lexical-block
  `__vv_ev` eval closure so `evaluateOnCallFrame` and Variables see the *exact*
  block scope (incl. TDZ correctness). Self-heals to the original source on any
  parse failure, so debugging never breaks a run.
- **In-guest CDP backend** (`packages/runtime/debugger.js`) — script registry,
  breakpoint binding (`setBreakpointByUrl`, conditional), call-stack frames,
  RemoteObject/objectId table, and a synchronous pause loop. Emits
  `Debugger.scriptParsed/paused/resumed`.
- **Pause channel** (`packages/protocol/debug.js`) — a `SharedArrayBuffer` ABI
  separate from the syscall SAB. A paused worker blocks on `Atomics.wait`; the
  kernel writes CDP commands into the SAB and `Atomics.notify`s. Running (not yet
  paused) processes receive commands via `postMessage` instead.
- **Kernel routing** (`packages/kernel-host/kernel.js`) — allocates the debug SAB
  per target, announces targets (`onDebugTarget`), relays events (`onDebugEvent`),
  and routes commands (postMessage while running, SAB while paused). The run
  shell + package managers (`sh`/`npm`/`npx`/`yarn`/`pnpm`/…) — and `python`/
  `python3` — are skipped as targets so auto-attach lands on the user's actual
  program (the child inherits `VV_DEBUG`).
- **Language reach** — JS/TS only. **Bun is debuggable** (`bun <file>` runs the
  entry through the JS module loader, so its breakpoints bind like `node`).
  **Python is not**: `python` is a Node shim that runs the real `.py` inside
  Pyodide (CPython/Wasm), which never passes through the loader — so it is skipped
  above rather than surfaced as a dead debug target.
- **Studio UI** — `packages/studio/src/vv/debug-session.ts` is the CDP *client*
  (multiplexes into Monaco); `DebugPanel.tsx` + the **Run and Debug** activity-bar
  entry give a VS Code-style panel (Call Stack / Variables / Watch / Breakpoints)
  with gutter-click breakpoints and a paused-line highlight (`index.css`
  decorations). Enabling "Debug mode" sets `VV_DEBUG=1` for subsequent runs.

**Verified:** `node scripts/spike-debugger.mjs` — 27 assertions covering
instrumentation, breakpoint binding (incl. conditional), pause/step, scope +
`evaluateOnCallFrame` (with TDZ), top-level `debugger;`, the real SAB channel, and
an end-to-end `worker_threads` pause→evaluate→resume over the SAB. (`verify-node`
needs the Rust/Wasm VFS build and so isn't runnable in a toolchain-less env.)

### Phase 3 — preview browser JS ⏳ (planned)

The preview iframe already ships a full in-browser CDP backend (chobitsu) for
console/network/`scriptParsed`, bridged to the chii frontend by the host relay in
`controller.ts`. What's missing is **real breakpoint pausing** of the app's own
browser JS. Because DOM code runs on the main thread it cannot block on
`Atomics.wait`, so this needs a **CPS / resumable transform** of the served source
(a generator-style rewrite) plus a Debugger backend inside the preview page that
multiplexes with chobitsu over the same `vv-cdp` channel — reusing the Phase 1–2
CDP shapes so both UIs stay on one protocol. This is a substantial, browser-only
piece best landed and verified with a real preview, so it is deliberately deferred
rather than shipped unverified.

## 🔀 Git Source Control panel (isomorphic-git, local-only) — **shipped**

A VS Code-style **Source Control** panel that runs [`isomorphic-git`](https://isomorphic-git.org)
directly against the in-tab VFS. **Local-only by design**: `init`, stage/unstage,
commit, branch/checkout/delete, per-file diff (HEAD ↔ working tree), history, and
discard — no network, no remote, no server. (Remotes/clone/push over the git wire
protocol need an authenticated CORS proxy and are intentionally out of scope here;
GitHub *import* already exists via the REST API.)

**How it's wired**

- **`git-fs.ts`** — an isomorphic-git `fs` adapter. isomorphic-git runs on the
  studio **main thread**, but the VFS lives in the File System Worker, so every
  call becomes a `KernelBridge` round-trip.
- **`vv-git-fs` RPC** (`kernel-worker.ts`) — one silent message dispatched by `op`
  onto the kernel's synchronous fs (SAB → FS worker). **Silent** = it does *not*
  broadcast `vv-fs-changed`; a single commit writes hundreds of `.git/objects`
  entries and storming the Explorer/watchers on each would jank the UI. The SCM
  session instead refreshes the working tree explicitly after checkout/discard.
- **kernel fs surface** — `kernel-fs.js` gained sync `lstat`/`symlink`/`readlink`
  (mirroring `runtime/fs-client.js`) so git has full POSIX metadata; the adapter
  reconstructs `st_mode` (type | perm) from the VFS `kind` so blob filemodes
  (100644 / 100755 / 120000 / 040000) are correct.
- **`scm-session.ts`** — a `useSyncExternalStore` store (mirrors `DebugSession`).
  It is **multi-repo**: it owns a `RepoState[]` with one entry per open workspace
  folder (like VS Code), each carrying its own branch/status/history, staged/unstaged
  lists (from `git.statusMatrix`) and commit message. Every operation targets a
  `root`. isomorphic-git is **lazy-imported** (a ~1 MB chunk) only when a repo is
  present or the user clicks *Initialize Repository*.
- **`controller.ts`** — owns the `ScmSession`, keeps its repo list in sync with the
  open workspace folders via `syncScmRoots()` (called on folder open/close), adds the
  `scm` activity view, a `"diff"` tab kind rendered by a read-only Monaco **diff
  editor** (`openDiff` / `mountDiffEditor`), and reloads open editors after a
  checkout/discard rewrites files under them.
- **UI** — `SourceControlPanel.tsx` renders **one collapsible section per repo**
  (branch menu, commit box, staged/changes sections, history, discard confirms,
  first-commit identity dialog — or an *Initialize Repository* button when a folder
  isn't a repo). The activity-bar badge sums changed files across all repos, and
  `Cmd/Ctrl+Shift+G` focuses the view.

**Performance notes** — status walks hard-filter heavy dirs (`node_modules`,
`dist`, …); refresh walks repos **sequentially**, is **coalesced** (no overlapping
walks) and gated to when the panel is open, so it never floods the single-threaded
kernel worker that also drives the terminal. `git init` seeds a sensible
`.gitignore` so untracked build output never floods the list. If a very large repo
ever makes main-thread status walks jank, the upgrade path is to move isomorphic-git
behind a dedicated worker (the git-fs adapter already isolates all fs access behind
the bridge, so only the call site moves).

**Scope** — one repo per open workspace folder. Nested/sub-directory repos are not
auto-discovered (VS Code does; out of scope for now).

## Python support — Pyodide (CPython→WASM), lazily loaded + Flask/FastAPI (this change)

A "Native" template category and a `python`/`python3` runtime. Unlike Bun (a
Node-backed shim), Python is **real CPython compiled to WASM (Pyodide)**, booted the
FIRST time a python process runs — nothing is paid at studio boot, and a `node`/`bun`
process never touches it (the plug-in shape: a `globalThis.__ocInstallPython` invoked
only by the launcher, mirroring Bun's `__ocInstallBun`).

- **Runtime** (`packages/runtime/builtins/python.js`): boots Pyodide, mirrors the
  project dir into its FS, runs scripts / `-c` / a REPL (stdout/stderr → terminal), and
  auto-loads prebuilt wheels the code imports (`loadPackagesFromImports`). Boot masks
  **both** Node probes — `process.browser=true` (pyodide.mjs) and `process.type=
  "renderer"` (Emscripten's pyodide.asm.mjs) — or Pyodide `import("node:module")` (404s
  in a Worker); both held across the whole boot, then restored.
- **CLI** (`packages/kernel-host/programs/python.js`) + `uvicorn`/`flask` PATH shims
  (`coreutils.js`). `process.exit`'s control-flow throw is detected and returned quietly.
- **Delivery** (`scripts/vendor-pyodide.mjs`): vendors the Pyodide core + selected wheels
  (incl. fastapi and its deps — package names are normalized across `-`/`_`) into
  `packages/studio/public/vendor/pyodide/`, and writes a **hybrid `pyodide-lock.json`**
  (vendored packages → relative paths; the rest → absolute CDN URLs, fetched at runtime).
  Wheel downloads are **best-effort** — a corporate-proxy TLS failure warns instead of
  aborting `predev`. A `LOCK_FORMAT` marker forces a rebuild when the lock shape changes.
- **Web servers (Flask / FastAPI) with a live preview.** Pyodide has no sockets, so the
  launcher (itself a guest Node program) stands up a guest
  `http.createServer().listen(port)` that registers the port like Express (opening a
  preview tab), and converts each tunnelled request to a **WSGI `environ`** (Flask) or
  **ASGI `scope`/`receive`/`send`** (FastAPI), driven through Pyodide. `python -m uvicorn`
  / `python -m flask` are wired. Two Pyodide-specific fixes: (1) `anyio.to_thread.run_sync`
  is patched to run inline — the single-threaded WASM VM has no OS threads, so FastAPI's
  sync-route threadpool otherwise raises "can't start new thread"; (2) the SW forwards
  **`X-Forwarded-Prefix: /preview/<port>`** when it strips the prefix, and the bridge maps
  it to the ASGI `root_path` / WSGI `SCRIPT_NAME` so absolute URLs (Swagger's `openapi.json`
  link + "Try it out" request URLs) carry the prefix and route back through the tunnel.
  Works across preview modes A/B (prefix) and C (origin root, no prefix); verified against
  FastAPI 0.140 / Starlette 1.3.
- **Editor**: `.py`/`.pyi` map to Monaco's `python` mode; `.py` gets the
  `vscode-icons:file-type-python` icon (`.txt` → `file-type-text`).
- **Templates** (the **"Native"** category, bringing the catalog to ~55 across 9
  categories): Python (stdout), Python data science (NumPy + pandas), Python plotting
  (Matplotlib), FastAPI, and Flask (both with a live preview). Icons for fastapi/flask.
- **Deployment**: `scripts/cloudflare-build.sh` now runs `npm run vendor:pyodide`
  explicitly — the studio's `bun run build` skips the root `prebuild:studio` hook, so
  without it the deployed studio would ship no `python`. The mode-B/C static
  SW-only builds need nothing (the kernel — and thus Pyodide — lives on the IDE origin).

See ARCHITECTURE.md §9.3 (the plug-in + HTTP bridge) and §8.3 (the `X-Forwarded-Prefix`
seam), and the AGENTS.md "Python is Pyodide" gotcha.
## Status bar — VS Code parity (Ln/Col, indentation, language mode) (this change)

The status bar carried an ad-hoc mix (a free-form status string, the shell cwd, `kernel:
ready`) and none of the things you actually reach for. It now mirrors VS Code.

- **Left**: the active repository's **git branch** + the live **error/warning** counts.
  "Active repository" resolves like VS Code — the repo owning the active file, else the
  focused workspace folder, else the only repo there is. Clicking the branch opens the
  Source Control panel.
- **Right**: **`Ln x, Col y`** (with ` (n selected)` / `n selections` for selections and
  multi-cursor), the **indentation** (`Spaces: 2` / `Tab Size: 4`) and the **language
  mode**. Each cell is a button that opens a quick pick, built on the same
  `CommandDialog` primitives as ⌘P so they look and keyboard-drive identically:
  - **Go to Line** — `line` or `line:col`, validated against the model's line count, with
    VS Code's "Current Line: …, Character: …" hint when the input is empty.
  - **Indentation** — the full VS Code action list, two-level: Indent Using Spaces /
    Indent Using Tabs / Change Tab Display Size drill into a size list (1-8, current one
    checked); Detect Indentation from Content, Convert Indentation to Spaces/Tabs and Trim
    Trailing Whitespace run Monaco's own `editor.action.*`.
  - **Select Language Mode** — Auto Detect plus the 20 grammars Monaco already bundles and
    `languageFor` can auto-detect. A hand-picked mode is remembered per file so it survives
    closing and reopening the tab. Deliberately **no JavaScript entry**: `.js` is served by
    the `typescript` mode on purpose (one language service, not two ~310 MB `ts.worker`s),
    so offering it would quietly double IntelliSense memory. See the AGENTS.md IntelliSense
    gotcha #3.
- **`languageFor` learned twelve more extensions** (scss/less, yaml, shell, sql, xml,
  Dockerfile, go, rust, java, php, ruby, ini/toml), all Monarch highlighting only — no
  worker, no language service.
- **Removed**: the cwd path, `kernel: ready/booting`, and the free-form status text
  (`"React · TypeScript running — edits hot-reload"`). `IdeSnapshot.status` and
  `IdeSnapshot.cwd` are gone; the ~20 messages that fed `status` are now **sonner toasts**
  (transient by nature, so they never needed a permanent slot), and the pure boot-lifecycle
  ones were dropped as redundant — Home already renders `bootPhase` progress and the share
  overlay its own `shareMessage`. (Superseded — see "Status bar — the message slot comes
  back" below: the toasts turned out to be too noisy on save.)

Two implementation notes worth keeping in mind:

- **`src/vv/editor-status.ts` is its own external store**, not part of `IdeSnapshot`. The
  cursor moves on every keystroke; on the main snapshot that would notify every `useIde()`
  consumer in the IDE per keypress. Same pattern as `DebugSession` / `ScmSession`.
- **The branch readout must not trigger a status walk.** `ScmSession.refreshBranches()` is
  a new branch-only path (a `.git` stat + `git.currentBranch()`); the full `statusMatrix`
  walk stays gated to when the Source Control panel is shown, because it floods the
  single-threaded kernel worker that also drives the terminal. Non-repo folders
  short-circuit on the stat, so a git-less workspace still never pays the lazy ~1 MB
  isomorphic-git import.

See ARCHITECTURE.md §8.12, and the AGENTS.md gotchas "The status bar's git branch must NOT
trigger a status walk" and IntelliSense gotcha #3.

## Status bar — the message slot comes back (this change)

Routing every status message to a sonner toast (previous entry) was wrong for one message in
particular: `saveFile` fires on every Ctrl+S, so a toast popped over the editor on each save.
Toasts are for things you must not miss; a save is the opposite of that.

All the non-error messages move back to the status bar, into a **message slot** between the
diagnostics and the right-hand `Ln/Col` group — VS Code's `setStatusBarMessage` position. That
is the 14 messages the previous change converted (save, created, installing, imported, copied
path, dev-server stopped/running/restarted, `demo-status`, service ready) plus the 5 it dropped
as redundant (opening shared project, exported, imported-as, share link, boot ready), restored
verbatim in their original lowercase wording. Only genuine **failures** stay toasts, alongside
the handful of pre-existing successes that carry a second line of detail (export, import,
share) — those need to survive longer than a glance and be dismissed deliberately.

Two things are deliberately different from the pre-VS-Code status bar:

- **Messages auto-hide after 4s.** The old slot left the last message sitting there forever, so
  the bar routinely showed something that had stopped being true minutes ago. A stale readout is
  worse than an empty one.
- **`src/vv/status-message.ts` is its own external store**, not a field back on `IdeSnapshot`.
  The `demo-status` bridge event carries one message per line of dev-server output, so an npm
  install used to re-render every `useIde()` consumer in the IDE a few hundred times. Same
  reasoning — and same `DebugSession` / `ScmSession` / `EditorStatus` pattern — as the previous
  entry's `editor-status.ts`. The store owns a single reset-able hide timer, so a burst of build
  output leaves one pending hide rather than hundreds.

The controller writes through a private `status(text)` helper, which keeps the choice of channel
(status bar vs. toast) a one-word decision at each call site.

See ARCHITECTURE.md §8.12.

## Bun shim — make the covered surface honest, and gate it (this change)

The Bun shim's problem was never only its size. A handful of APIs were listed as covered and
were quietly wrong, which is strictly worse than missing: code written against them passes
in the sandbox and breaks under real Bun, and nothing in the run tells you. This change fixes
those and closes the CI hole that let them survive. **No new API surface.**

- **`bun:test` semantics.** `test.only` registered an ordinary test and filtered nothing, so an
  `only` run executed the entire suite — the most dangerous divergence in the shim. It now
  narrows the run globally (Bun/Jest semantics: one `only` anywhere focuses everything), and a
  suite with nothing selected does not run its `beforeAll`/`afterAll`. Separately, root-level
  `beforeEach`/`afterEach` were collected and never executed, and a nested `describe` did not
  inherit its parents' each-hooks; both now work, in Jest order (`beforeEach` outermost-first,
  `afterEach` innermost-first). A skipped test used to run `beforeEach` and then `continue` past
  `afterEach`, leaving them unpaired — it now runs neither.
- **`Bun.serve` honors `opts.error`.** The documented hook was never read; every handler throw
  rendered a hard-coded 500 with the message inlined in the body. The handler's `Response` is now
  served, and the old 500 is kept verbatim as the fallback when the option is absent, returns
  nothing, or throws in turn. The precedence lives in an exported `resolveServeError` so it is
  testable without binding a port.
- **Loud instead of placeholder.** `Bun.file(3)` used to `String()` the fd into the relative path
  `"3"`; our fd numbers are VFS handles, not OS descriptors, so there is nothing to open and it
  throws. `Bun.Transpiler.scan()`/`scanImports()` returned empty arrays, indistinguishable from a
  file with no imports — the transform is a type-stripper and builds no import graph, so they
  throw. The `bun:jsc` memory helpers returned `0`/zeros, which a memory-budget check reads as
  "nothing is allocated"; no engine exposes heap introspection to page code, so they throw. All
  three follow the existing `bun:ffi` tier: import-safe, call-loud, message names the API and why.
- **CLI verb dispatch.** `bun upgrade` was an alias for `npm update`. Real `bun upgrade` replaces
  the Bun binary, which does not exist here, so it is now not-implemented and points at
  `bun update` (which, with `bun up`, still delegates to npm). Unrecognised verbs fell through to
  the run path and reported `file not found: publish`; they now say not-implemented. The genuine
  run paths are preserved by classifying the argument: path-shaped, a known script extension, an
  entry that resolves on disk, or a `package.json` script name still runs.
- **One version definition.** `Bun.version` was hard-coded in two files and `Bun.revision`
  (`"vivari-shim"`) disagreed with what `bun --revision` printed (`"1.1.34-vivari"`). `BUN_VERSION`
  and a derived `BUN_REVISION` now live in `builtins/bun.js`; the CLI installs the Bun global and
  reads them. `BUN_PROGRAM` is a no-interpolation template literal and cannot import, so it keeps
  a fallback literal for a non-Vivari host — and the offline spike asserts that literal equals
  `BUN_VERSION`, which is what makes it a single source rather than a third copy.
- **The gate.** `scripts/spike-bun.mjs` ran in **no CI job at all**: `toolchain-gate` runs
  `run-spikes --offline` without the Wasm crates, so `run-spikes.mjs` auto-skips `needsWasm`
  spikes with a `(skip …)` note that reads as green, and the `verify` job — the one that does
  build them — filtered to `dep-cache`. The filter is now `dep-cache bun`. Everything above is
  only as durable as this line.

Every fix has a regression check in `scripts/spike-bun-offline.mjs`, the only Bun tier CI enforces
per-PR. The CLI ones execute `BUN_PROGRAM` as a real Node subprocess in a temp dir, which is
possible because it is an ordinary CommonJS program and `installBun()` is a guarded no-op off
Vivari — that covers verb dispatch, the version output, and the preserved run-a-file/run-a-script
paths without a kernel. The spike also asserts that `ci.yml` still names the bun spike, so the
gate cannot be quietly dropped again.

See ARCHITECTURE.md §9.2.

## Bun data formats — YAML, TOML, JSON5, JSONL and semver (this change)

Phase 1 batch A of the Bun coverage plan: five `Bun.*` namespaces that were entirely absent,
all of them pure computation with no sandbox constraint. Being pure computation is what makes
them worth doing properly — there is no capability excuse for an approximation here, so the
target is not "parses my test file" but "returns what real Bun returns", including where real
Bun disagrees with the obvious npm library.

That distinction is the whole point of the batch. A parser that is 95% right is the worst
outcome available: the code runs green in the sandbox and hands production a different value,
with nothing in the run to say so. So each format is backed by a real vendored library chosen
for the behaviour Bun documents, and every documented divergence has a named regression check.

- **`Bun.YAML.parse`** — vendored **js-yaml@4.3.1**, because anchors/aliases, merge keys, the
  block-scalar chomping modes and implicit type resolution are exactly where a small hand-rolled
  YAML parser returns the wrong shape rather than an error. The schema is the deliberate part:
  js-yaml's default is YAML **1.1**, where `expires: 2030-01-01` resolves to a `Date` and
  `debug: yes` to `true`; Bun parses **1.2 core**, where both stay strings. It is instantiated
  with `CORE_SCHEMA` plus the merge type (`<<: *defaults` is not in 1.2 core, but Bun's own docs
  demonstrate it). Multi-document input returns an **array**, single-document input does not —
  a shape change, not a formatting detail, and pinned in both directions.
- **`Bun.TOML.parse`/`.stringify`** — vendored **smol-toml@1.7.1**, picked over `@iarna/toml` at
  a tenth the size and, decisively, because it already **throws** on an integer outside
  ±(2^53 − 1) instead of silently rounding it to a lossy float. Most TOML libraries round, which
  makes a snowflake id in a config file "parse successfully" as the wrong number. One patch marks
  the other documented divergence: date/times come back as their **source text**, not `Date`s,
  because reconstructing the source from a `Date` loses the offset form and sub-second precision.
  `stringify` normalises its input first — smol-toml drops `null` and emits `BigInt` where Bun
  throws, and throws on function/symbol values where Bun skips them.
- **`Bun.JSON5.parse`/`.stringify`** — vendored **json5@2.2.3**, the reference implementation,
  used unwrapped: it passes the same official suite Bun documents passing 100% of, and its
  `stringify` already emits Bun's exact output (unquoted identifier keys, single-quoted strings,
  a trailing comma per line under `space`, and `Infinity`/`NaN` literal where `JSON.stringify`
  writes `null`).
- **`Bun.JSONL.parse`/`.parseChunk`** — **hand-written**, the one format not vendored. Its whole
  surface is one JSON value per line, so the parsing is `JSON.parse` in a loop and all of the
  design is in an error contract that is **deliberately asymmetric** and that no npm JSONL
  library reproduces: `parse` throws only if **zero** values parsed (line 900 of 1000 being
  corrupt gets you 899 values and no exception), while `parseChunk` **never** throws and reports
  through `{values, read, done, error}`, because a chunk boundary mid-value is normal for a
  stream and must not be fatal. Both run on one scanner that differs only in whether
  end-of-input terminates the last value. Bun's documented worked offsets (`read` of 7, 17 and
  23) are asserted, since `read` is what a streaming caller slices on.
- **`Bun.semver.satisfies`/`.order`** — **no new vendoring**: it reuses the real node-semver
  already bundled for the npm program. Bun documents this as node-semver-compatible, and ranges
  are precisely where a subset matcher goes wrong quietly — `>=1 <2`, `1 || 2`, hyphen ranges,
  and the rule that a prerelease only satisfies a range that itself names one. `satisfies`
  returns `false` for an invalid version or range, as documented. `order` is left to surface
  node-semver's `TypeError` on an unparseable version, which Bun's docs do not specify: guessing
  `0` would make an unsortable array look sorted, which is the silent-wrong failure this shim
  forbids.

The implementations live in a **new file**, `packages/runtime/builtins/bun-formats.js`, wired
into the `Bun` literal by `bun.js` with one import and five lines. That deviates from the
convention that a `Bun.*` member goes in `bun.js`, deliberately: `bun.js` is ~1100 lines, the
formats share no state with anything in it, and three coverage batches are landing against that
one object literal at once. The vendored bundles follow the `node/vendor/semver.js` precedent
exactly — an esbuild CJS bundle wrapped in a factory, with `package@version`, the license and
the regenerate command in the header. They are factories, so a process that never parses YAML
never runs js-yaml's bundle body.

Gated by `scripts/spike-bun-offline.mjs`, the only Bun tier CI enforces per-PR, which goes from
124 checks to 201 (215 with the generic-arrow fix below) — every one of them through the real
`Bun` global, so the wiring in `bun.js` is
gated alongside the implementations. The checks that matter most are the ones a plausible future
refactor would silently undo: the TOML integer-overflow throw, TOML date/times staying strings,
YAML 1.2 core not coercing a bare date or `yes`, multi-document YAML returning an array, and the
two JSONL error contracts being different from each other.

See ARCHITECTURE.md §9.2.

## Generic arrow functions were never type-stripped (this change)

The first CI run of `scripts/spike-bun.mjs` — newly wired into the `verify` job by the Phase 0
gate — failed exactly four checks, all in block 2 (`bun run index.ts`), with an empty stdout and
exit 1. **This is a pre-existing bug, not a Phase 0 regression.** Verified by running the spike
at `1305e2e` (pre-Phase-0) and at `1f412d0` (master): byte-identical failures at both. Phase 0
never touched `packages/runtime/typescript-transform.js`; it only built the gate that could see
the bug. Before it, this spike ran in **no** CI job and needed the Wasm crates to run locally,
which is precisely why a hard `SyntaxError` in the zero-config TS path survived unnoticed.

**Root cause.** The type parameters of a generic **arrow** were never stripped, so

```ts
const add = <T extends number>(a: T, b: T): T => (a + b) as T;
```

emitted `const add = <T extends number>(a, b)=> (a + b) ;` — the annotations and the `as` cast
went, the type parameter list stayed — and the entry died at compile with `bun: SyntaxError:
Unexpected token '<' (while compiling /app/index.ts [cjs])`.

`isGenericOpen` decides whether a `<` opens a generic by looking at the **previous** significant
token, and accepts only an identifier, `)` or `>`. That covers every declaration and call site
(`function f<T>`, `class Box<T>`, `f<number>(1)`, `new C<T>()`), which is why blocks 3–5 and the
whole existing offline suite passed. But an arrow is an *expression*, so what precedes its `<` is
`=`, `(`, `,`, `return`, … and none of those match. The single case that did work, `async <T>(x)`,
worked by accident: `async` is an identifier. Block 2 is the only spike file with a generic arrow,
so it was the only one that failed — and the `interface`/`enum` it also uses, the other suspects,
were both handled correctly all along.

**Fix.** A companion predicate, `isGenericArrowOpen`, handles the expression position. It is
deliberately narrow: the previous token must be one that can precede an expression, the `<…>` must
balance and contain nothing obviously non-type, it must be followed by a parameter list, and that
list's matching `)` must be followed by `=>` or by a `: T` return annotation. Plain JS cannot begin
an expression with `<`, and `.tsx`/`.jsx` sources have JSX lowered *before* `stripTypes` runs, so
no JSX ambiguity remains at that point. `a < b > (c)` is untouched and still transpiles to `a(c)` —
correct, because TypeScript itself parses that as the generic call `a<b>(c)`.

**Why the failure was mute.** `kernel.start(…, { capture: true })` buffers stderr into `r.stderr`
and skips the kernel's stderr callback entirely, so `VV_LIVE=1` could not surface it either; block
2 asserted on `r.stdout` alone and threw the diagnosis away. It now prints `r.stderr`, which turns
"exit 1, no output" into the one-line answer. Recorded in AGENTS.md "Critical gotchas".

Fourteen regression checks land in `scripts/spike-bun-offline.mjs` (201 → 215) rather than in the
kernel spike, because the transform is pure JS and the offline tier is the one CI enforces on every
PR. Ten of them fail without the fix. Two of the fourteen guard the other direction — that real `<`
comparisons and shift operators still survive — since the failure mode of a loosened heuristic is
eating operators, not leaving types behind.

See ARCHITECTURE.md §7.
## Bun text, terminal and byte-stream utilities (this change)

Phase 1 batch B of the Bun coverage plan: the `Bun.*` members that are pure computation over
strings and standard web primitives. Like batch A, being pure computation is exactly what
removes the excuse for an approximation — there is no missing capability to hide behind, so the
target is "returns what real Bun returns", and every place we cannot reach that is named.

- **`Bun.stringWidth`, `Bun.stripANSI`, `Bun.wrapAnsi`** — **vendored**, as one bundle
  (`node/vendor/ansi-text.js`: string-width@7.2.0 + strip-ansi@7.1.0 + wrap-ansi@9.0.0 and their
  transitive deps, 34 KB). This is the `string-width` problem, where the correctness lives in
  data rather than logic: the Unicode East_Asian_Width ranges and the full emoji-sequence
  grammar. A hand-rolled table is the classic 95%-right artifact that then miscounts one CJK
  block forever, and Bun's own docs say `Bun.stringWidth` "passes `string-width`'s tests" and
  that `Bun.wrapAnsi` is a drop-in for `wrap-ansi` — so these packages *are* the specification of
  the behaviour being shimmed. One shared bundle because wrap-ansi depends on the other two;
  bundling separately would ship the Unicode tables twice. The only divergence is speed: Bun's is
  SIMD native code documented at ~6,756x the npm package, and this *is* the npm package.
- **`Bun.color`** — **hand-rolled**, deliberately. It covers the sRGB grammar (148 named colours,
  3/4/6/8-digit hex, `rgb`/`rgba`/`hsl`/`hsla`/`hwb` in both the legacy comma and modern
  slash-alpha syntaxes, numbers, `{r,g,b,a}` objects and `[r,g,b,a]` arrays) and all fifteen
  documented output formats, with the tmux `colour_find_rgb` cube/greyscale snap for `ansi-256`
  and the standard two-step reduction to `ansi-16`. Not vendored because every library that
  parses the full CSS Color 4 function space is larger than this entire file, and this ships into
  every process worker. The consequence is handled rather than ignored: `Bun.color` returns
  `null` for input that is not a colour, which is a contract callers branch on, so the spaces we
  do **not** implement — `lab()`, `lch()`, `oklab()`, `oklch()`, `color()`, `color-mix()` —
  **throw** instead. Returning `null` there would be indistinguishable from "not a colour" and
  would send a caller down the wrong path forever.
- **`Bun.color(…, "ansi")`** — the one member whose answer is a *policy*. Bun detects stdout's
  colour depth from the environment and returns `""` when there is no colour support; Vivari's
  terminal is virtual, so anything claimed here is a choice, not an observation. The runtime had
  already made that choice once, in `node/internal/util/colors.js`, which is the hook
  `util.styleText` consults, so this reuses that precedence value-for-value rather than inventing
  a second one — otherwise `Bun.color` and `util.styleText` could disagree about whether colour
  is on in the same terminal. Under Studio the kernel exports `FORCE_COLOR=3`/`TERM=xterm-256color`
  and xterm.js genuinely renders truecolor, so 24-bit is the right claim; a headless kernel sets
  nothing and writes to a non-TTY, so it returns the documented `""`. Both ends, the precedence
  order (`NO_COLOR` beats `FORCE_COLOR`), and the fact that `""` is not `null` are all pinned.
- **`Bun.indexOfLine`** — hand-rolled, ten lines. It scans **bytes**, not code points, which is
  the entire point: it is documented for "potentially ill-formed UTF-8", and `0x0A` can never be
  a UTF-8 continuation byte, so it stays correct on a buffer cut mid-sequence.
- **`Bun.inspect.table` / `.custom`** — `Bun.inspect` already existed as a delegate to
  `util.inspect`; it becomes a function object carrying both members. `.custom` is
  `Symbol.for("nodejs.util.inspect.custom")`, the registry symbol, so it is literally the same
  symbol the runtime's own `util` honours. `.table` reproduces Bun's documented frame byte for
  byte, including the **empty** header cell above the index column where Node prints `(index)`,
  and measures columns with `stringWidth` so a table of CJK or emoji cells still lines up.
- **`Bun.ArrayBufferSink`** — hand-rolled. The whole risk is `flush()`, whose return **type**
  depends on what `start()` was given: an `ArrayBuffer` under `{stream: true}`, a `Uint8Array`
  when `asUint8Array` is added, and otherwise the **number** of bytes written since the last
  flush. A caller that expects bytes and gets a number fails somewhere far from the mistake, so
  all three configurations have explicit checks, as does the asymmetry that stream mode *drains*
  the buffer while buffer mode does not (`end()` still owes the caller everything). `write()`
  returns bytes and not characters, `write()` after `end()` throws rather than dropping data, and
  a non-buffer chunk throws rather than being `String()`-ed into bytes — the coerce-and-hope
  pattern Phase 0 removed elsewhere.
- **`Bun.readableStreamTo*`** — all seven consumers. `Text` concatenates before decoding once, so
  a multi-byte character split across two chunks survives; `FormData` hands the bytes to
  `Response` rather than growing a second, worse multipart parser; and all of them accept a plain
  async iterable, because `BunFile.stream()` can fall back to a Node `Readable` that has no
  `getReader()`.
- **`Bun.concatArrayBuffers` / `Bun.allocUnsafe`** — hand-rolled. `allocUnsafe` is the honest
  compromise of the batch: Bun's returns genuinely uninitialised memory, and JavaScript has no
  such primitive, since `new Uint8Array(n)` is *specified* to be zero-filled. So this is safer
  than Bun's and slower — a performance-contract difference with no behavioural one, which makes
  it worth an inline comment and a check that pins the zero-fill, not a throw.
- **Async-generator response bodies** — **no code**, on purpose. Checking first showed both forms
  Bun documents (a called `async function*` and an object with `[Symbol.asyncIterator]`) already
  work through the existing `Bun.serve` path: that path hands the handler's `Response` to Node's
  http server untouched, and the platform `Response` accepts any async iterable. They are pinned
  anyway, because "works today by inheritance" is exactly what a future `Response` polyfill would
  silently take away. The one form that does not work — passing the generator *function* instead
  of calling it, which stringifies, and which Bun does not document either — is pinned as a known
  divergence, since it is unfixable from `Bun.serve` once the body is already encoded.

The implementations live in **two new files**, `packages/runtime/builtins/bun-text.js` and
`bun-bytes.js`, wired into the `Bun` literal by `bun.js` with one import each plus a few literal
lines. That deviates from the convention that a `Bun.*` member goes in `bun.js`, deliberately and
for the same reason as batch A: `bun.js` is ~1100 lines, both groups are self-contained pure
computation sharing no state with it, and three coverage batches are landing against that one
object literal at once. The vendored bundle follows the `node/vendor/semver.js` precedent — an
esbuild CJS bundle wrapped in a factory, with `package@version`, the license and the exact
regenerate command in the header — and is instantiated on first use, so a process that never
measures a string never runs the Unicode tables.

Gated by `scripts/spike-bun-offline.mjs`, the only Bun tier CI enforces per-PR, which goes from
215 checks to 356 — all of them through the real `Bun` global, so the wiring in `bun.js` is gated
alongside the implementations, and the `Bun.color` depth policy is driven through a fake
`process.env`/`stdout` because a spike has no terminal of its own. The checks that matter most
are the ones a plausible refactor would silently undo: the three `ArrayBufferSink.flush()` return
types, `""`-not-`null` for unsupported ANSI, the throw-not-`null` on unimplemented colour spaces,
`allocUnsafe` being zero-filled, and a UTF-8 character split across stream chunks.
## Bun exactness — `Bun.Glob`, and making hash / deepEquals / randomUUIDv7 real (this change)

Phase 0 dealt with shim APIs that returned obvious placeholders. This batch deals with the
harder version of the same problem: three APIs that returned *plausible* answers. Each one had
the right type, the right shape and perfect run-to-run stability, and each disagreed with real
Bun on essentially every input. Nothing in a passing test run could tell you, because the only
thing the existing checks asserted was that the shim agreed with itself — which is exactly the
property a wrong implementation already has. **One new API, three replacements.**

- **`Bun.hash` is now really wyhash.** It was a bespoke 53-bit multiply-xor hash with an inline
  comment admitting as much, and `Bun.hash.wyhash` was aliased straight back to it, so the two
  agreed with each other and with nothing else. `Bun.hash` is a *stable* API — its digests end up
  in cache keys, shard ids and bloom filters — so "stable within this process" is not the
  contract. It is now wyhash final v3 (the variant Zig's `std.hash.Wyhash` implements, which is
  where Bun gets it), and the family alongside it is real too: `xxHash32`/`xxHash64`,
  `murmur32v2`/`murmur32v3`/`murmur64v2`, `cityHash32`/`cityHash64`. The documented return typing
  is preserved exactly — `number` for the 32-bit members, `bigint` for the 64-bit ones — which is
  load-bearing rather than cosmetic, since `Bun.hash("x") + 1` is a `TypeError` under real Bun and
  a shim returning a Number makes that line work here and fail in production. `crc32` and
  `adler32` were already correct and are untouched (now pinned, so they stay that way).
  `xxHash3` and `rapidhash` are documented members left unported and throw naming themselves:
  XXH3 is a larger construction than the rest of the file combined and rapidhash is not in Zig's
  standard library, so for neither do we have a reference to verify a port against — and an
  unverified hash is the precise bug being removed here.
- **`Bun.deepEquals` implements `strict`.** The third argument was accepted and ignored, so
  `expect().toStrictEqual()` — which is *defined* as strict deepEquals — behaved identically to
  `expect().toEqual()` and accepted input real Bun rejects. For a test-runner shim that is the
  worst available direction to be wrong in: the suite goes green in the sandbox and red in CI,
  the exact failure a sandbox exists to prevent. Strict now diverges where the docs say it does
  (properties explicitly set to `undefined`, `undefined` padding in arrays, a sparse hole vs an
  explicit `undefined`, and prototype identity). Beyond the loose/strict split, the comparison
  itself was thin: it handled no `Map`, `Set`, `Date`, `RegExp`, `TypedArray` or `ArrayBuffer`,
  reported `NaN !== NaN`, and counted keys — so it called `[1, 2]` equal to `{0: 1, 1: 2}`. All
  fixed, and `Bun.deepMatch` is added alongside, backing a new `expect().toMatchObject()`.
- **`Bun.randomUUIDv7` emits a v7.** It called `crypto.randomUUID()`, which is a **v4**: 122 bits
  of randomness and nothing else. Time-ordered sortability is the entire reason to reach for v7,
  so this returned a string of exactly the right shape that failed at the one job it was picked
  for — and neither its type nor its format tells you, so you find out when the index it was
  supposed to keep tidy fragments. It is now RFC 9562 §5.7: a 48-bit big-endian millisecond
  prefix, version and variant nibbles, and a 12-bit counter that makes a burst inside a single
  millisecond strictly increasing (on rollover the emitted timestamp is bumped rather than the
  counter wrapped). An explicit `timestamp` is encoded verbatim against its own counter, so
  backfilling ids for historical rows works and does not disturb the default path's clock.
- **`Bun.Glob` is new, `.match()` only, and hand-rolled.** The obvious move is to vendor
  picomatch or minimatch, and it is the wrong one: Bun's dialect differs in three documented ways
  that each change *which files a build includes*, and in each case the other libraries' default
  is the plausible-looking answer. `*` does not cross `/` or `\`; `!` negates only at the very
  start of a pattern (there is no mid-pattern extglob negation, so `a!b` is a literal `!`); and
  braces nest at most 10 deep, deeper being an error rather than a silently truncated pattern or
  an eagerly expanded cross-product. The compiler targets a `RegExp` — globs are a regular
  language and the translation is mechanical. `.scan()`/`.scanSync()` need a VFS directory walk,
  which is a different problem and is scheduled for **Phase 2**; they throw, because an empty
  iterator would read as "no files matched", which is the category of bug this whole change is
  about.

Testing is the point of the change, so it is worth being specific about what counts. Every claim
above is pinned in `scripts/spike-bun-offline.mjs` by a value from **outside this repository**:
the two wyhash digests Bun's own docs print, the SMHasher verification codes that Zig's
`std.hash` test suite asserts (hash the keys `{0}`…`{0..254}`, fold the digests, keep 32 bits —
one mistyped constant anywhere in a port moves the code), the worked examples in Bun's glob docs
plus a direct assertion of each of the three divergences, the documented loose-vs-strict
deepEquals cases verbatim, and a 5,000-id v7 burst checked for strict ordering. A
self-consistency check would have passed against every one of the old implementations. The gate
goes from 356 checks to 463.

One deliberate test change: the spike asserted `typeof Bun.hash("hello") === "number"`, which was
only true because the hash was wrong. Real `Bun.hash` is 64-bit and returns a `bigint`, so that
assertion was pinning the bug; it now asserts `bigint`, and the number-vs-bigint split is
exercised properly across the whole family.

See ARCHITECTURE.md §9.2.

## Python, broadened — 7 more templates, a gunicorn seam, and an ASGI spec fix (this change)

The previous Python entry shipped the runtime and five templates. Those five are one
hello-world, two "import a library and print", and two web servers that return a
string — enough to prove Pyodide works, not enough to build anything with. This
change takes the **Native** category from 5 Python templates to 12 and fixes what got
in the way of writing them.

Everything below was **executed against real Pyodide 314.0.3** — the exact vendored
version — before it was written down. Where a claim could not be tested headlessly,
it says so.

- **Preview templates.** `django` (full-stack MVC: ORM, migrations, template engine,
  URL routing), `flask-app` (Jinja + static files + SQLite CRUD + JSON API),
  `fastapi-crud` (Pydantic models, SQLite, real status codes, Swagger), and
  `fastapi-dashboard` (pandas + Matplotlib rendered *into* the preview as a PNG —
  the Matplotlib starter makes you open a file by hand).
- **Terminal templates.** `python-pytest` (fixtures, parametrize, `raises`, real exit
  codes), `python-sqlite` (stdlib only — the one Python starter that needs no wheel
  and no network at all), and `python-imaging` (Pillow, already inside the vendored
  closure).
- **No `vendor-pyodide.mjs` change.** Pillow and Jinja2 are already in the vendored
  wheel closure at 0.00 MB marginal cost, so the ship size stays at 19.02 MB. Django
  and Flask are micropip-only by nature; pytest resolves from the CDN through the
  hybrid lock. Vendoring pytest was considered and rejected: +2.53 MB (+13%) on every
  user for one non-offline-critical template.

**A real bug in the shipped ASGI bridge.** `scope["path"]` was set to the
SW-stripped path while `root_path` was also set — but ASGI defines `path` as the full
path *including* `root_path`, and Starlette recovers the route path by subtracting one
from the other. The subtraction that bites is the one *inside* a mount, not the top-level
one: `get_route_path` strips only when `path` starts with `root_path`, so a pre-stripped
path sails past it, while `Mount.matches` hands the sub-app `root_path + matched_path`
(`/preview/8000` + `/static`) — a prefix a stripped path certainly does not carry. So
**every `Mount()` — `StaticFiles` above all — 404'd behind the preview proxy** while
top-level routes stayed fine, which is why nobody noticed. Measured 404-before/200-after
on the same app, with preview mode C (no prefix) unaffected. `ARCHITECTURE.md` §9.3
asserted the opposite ("route matching is unaffected") and is corrected.

**A `gunicorn` seam rather than a Django one.** Django needs a WSGI entrypoint.
`gunicorn` is *the* canonical one, it mirrors how `doUvicorn` already works (parse
argv → `serve()`, never import the package), and one ~30-line seam unlocks every WSGI
framework instead of one shim per framework. `python -m django runserver` was
rejected: the real command binds a socket, so the shim would diverge confusingly —
and it does, loudly, if you try it (`emscripten does not support processes`).

**`python -m pytest`, with no new runtime API.** It synthesises
`sys.exit(int(pytest.main([...])))` and runs it down the ordinary script path, which
gets wheel auto-loading and exit-code propagation for free. That exposed a fidelity
bug worth fixing: CPython prints **no** traceback when `SystemExit` reaches the top
level, but we dumped the whole WASM traceback, so a green test run would have ended
looking like a crash. `terminationFromError` now reports the way CPython does.

**Four Django-specific constraints**, each documented in the template that hits it:
it runs on **WSGI only** (its ASGI path goes through `asgiref`, which starts a
`ThreadPoolExecutor` per request even for `async def` views); it needs
`DJANGO_ALLOW_ASYNC_UNSAFE=1` (Pyodide always has an event loop, so the `async_unsafe`
guard rejects every ORM call — and the race it guards against cannot happen in a
single-threaded VM); it needs `tzdata` (the WASM stdlib ships no timezone database,
not even UTC); and `{% static %}` cannot work behind the preview proxy at all, because
`STATIC_URL` is resolved once and cached at import time, before any request has set
the script prefix. `{% url %}` and `reverse()` are per-request and *are* correct.

**`scripts/spike-python-bridge.mjs`** (network tier, 8 cases, ~40 s). It is
kernel-free by necessity, not by choice: `bootPyodide` does
`import(indexUrl + "pyodide.mjs")`, and from Node there is no way to reach the
vendored bundle — `import('http://…')` is `ERR_UNSUPPORTED_ESM_URL_SCHEME` since
network imports were removed in Node 22, and a `file://` indexURL imports fine but
then makes the browser-masked boot `fetch()` file URLs. Both were tested. So it
follows `spike-bun-offline.mjs`. It drives the exported `setupSource` against template
files read out of `templates.ts`, so neither the bridge nor the templates can drift
away from what is tested, and each case runs in its own process because sharing one
interpreter makes `sys.modules` serve an earlier template's `main` to a later one.

**What is genuinely impossible**, as opposed to merely hard: Streamlit, Jupyter and
Gradio (no installable wheels, and each needs sockets, threads or streaming);
anything using `requests`/`socket`/`threading`/`multiprocessing`/`subprocess`;
`asyncio.run()` (needs WebAssembly stack switching); and any streaming/SSE/WebSocket
Python app (the bridge is buffered end to end, and the `vv-sse` tunnel would deadlock
against it). Nine further candidates — sympy, scipy, scikit-learn, duckdb, polars and
friends — all *passed* their probes and were still cut: they demonstrate Pyodide,
which `python-data` already does, at 4–18 MB of wheels each.

**Verification is bounded, and the templates are labelled accordingly.** The spike
proves Python semantics and the bridge's protocol conversion. It does not prove port
registration, preview-tab opening, the service-worker tunnel, wheel delivery from
`public/vendor/pyodide/`, terminal rendering, or `mirrorBack` surfacing files in the
editor — all of which need a browser. Per AGENTS.md, all seven ship `experimental`
until someone runs that pass.

**User-facing docs.** The docs site had no Python page at all. `sites/docs/docs/python.md`
now covers what works and — since this is a pure client-side environment — an explicit
list of what cannot, so the limits are somewhere a user will actually find them. Every
limit quotes the error a user actually sees, taken from a probe rather than from memory.

**The same CI hole the Bun entry above closed, closed for Python.** That entry found
`spike-bun.mjs` running in no job at all; this one would have shipped the identical gap.
`spike-python-bridge.mjs` has to be `net: true`, because Pyodide is ~30 MB that is neither
committed (`public/vendor` is gitignored) nor installed by CI, and the network tier is
schedule/dispatch-only *and* `continue-on-error` — so on its own it gates nothing. It stays
where it is, and everything provable without an interpreter moved into a second spike,
`scripts/spike-python-offline.mjs` (`net: false`, no `needsWasm`), which `toolchain-gate`
runs on every push and PR via its unfiltered `run-spikes.mjs --offline`: the argv contract
of all four CLI seams as real Node subprocesses, CPython-faithful `SystemExit`, the
generated dispatch source including the ASGI `root_path` regression, and template-registry
integrity. It asserts its own registration, so the gate cannot be dropped quietly. Both
spikes read `templates.ts` through one parser (`scripts/lib/python-templates.mjs`).

**Audited against that entry's other finding — "a shim stub that lies is worse than a
missing API".** The seams themselves come out clean: `gunicorn`/`uvicorn` never import the
package they are named after, but they are honest *entrypoints*, not stubs, because the
contract they advertise is the one they keep; `pytest` hands its whole argv to real pytest,
so there are no dropped flags to lie about; `-m <unknown>` already refused by name. The
violations were in argv. Flags we could not honour were silently swallowed, which is the
same lie in a different spelling — `gunicorn -w 4` said nothing while serving one worker.
Now `--worker-class`/`-k` (other than `sync`, which is exactly what the bridge is) and
uvicorn's `--factory` **refuse**, since they change what gets served; `--workers`,
`--threads`, `--reload`, `-D` and flask's `--debug` **warn** and carry on. The uvicorn and
flask seams predate this change and had the same defect; fixing only gunicorn would have
left the two entrypoints disagreeing about what honesty means.

**Audited again, against the Glob entry's "test against a value from OUTSIDE this repo".**
Three of these suites were measuring us against ourselves, and each one was hiding a bug.

- **`SystemExit`.** The table of expected exit codes was written from what we assumed
  CPython does, and the traceback strings it fed in were invented too. Two rows were
  wrong. `sys.exit(None)` never produces `SystemExit: None` — real Pyodide raises a bare
  `SystemExit` — so that row tested a shape that cannot occur. And bools are ints in
  Python: `sys.exit(False)` exits **0** printing nothing, where the shim exited 1 and
  printed `False`, so `sys.exit(not ok)` — the idiom — **reported failure on a successful
  run**. The vectors now live in `scripts/lib/cpython-exit.mjs`, captured from a real
  interpreter; the offline tier re-derives them from the `python3` on the machine so they
  cannot rot, and the bridge tier raises each `sys.exit()` in real Pyodide and feeds what
  it genuinely throws to `terminationFromError`, so there is no fixture left to be wrong.
  One deliberate divergence is recorded rather than papered over: CPython reports
  `sys.exit(-1)` as 255 because a POSIX exit status is 8 bits, but that truncation is the
  OS's, and Vivari's kernel carries exit codes as plain integers for every program — so
  the shim passes `-1` through, and truncating in Python alone would be the inconsistency.
- **The ASGI scope.** The sharpest case, since the bug being guarded was a spec-conformance
  bug. The 404-before/200-after comparison was already grounded — it runs real Starlette —
  but a status code is a coarse oracle, and nothing stated the rule. The scope our dispatch
  builds is now read by Starlette's own `Mount.matches` and `get_route_path`. Doing that
  corrected our account of the mechanism: top-level `get_route_path` is *guarded*, so the
  pre-fix scope passes it happily — the failure is one level down, where `Mount` extends
  `root_path` to `root_path + "/static"`. The write-ups above said Starlette subtracts
  `root_path` from `path` and left it there, which is true and not where the bug lived.
  The WSGI half had no outside check at all and now runs behind `wsgiref.validate`,
  CPython's own PEP 3333 validator, plus the spec's `SCRIPT_NAME + PATH_INFO` invariant.
- **The CLI flags.** Which flags exist and which take a value belongs to gunicorn,
  uvicorn and Flask, not to us, and reading their `--help` output turned up three we had
  wrong. `gunicorn -t 30 wsgi:app` served an app called `30` — `-t` is the short spelling
  of `--timeout`, and an unconsumed value silently becomes the app spec. Enumerating the
  ~56 value-taking flags was the wrong shape; the ~12 `store_true` ones are the short,
  stable list, so everything else consumes a value and the failure mode flips from
  "silently serves the wrong app" to a visible "no app specified". Same fix for uvicorn.
  Flask spells its host flag `-h`, not `--help`, and `flask run -h 0.0.0.0` was being
  dropped on the floor. Django's `DJANGO_ALLOW_ASYNC_UNSAFE` is now checked against
  Django's own source, because a misspelling there is a settings file that imports fine,
  reviews fine and does nothing.

**A rendering bug the user found by running the template.** `python-pytest` printed one
progress dot per line where real pytest prints `...........`. The results were right; the
terminal was not. Cause: Pyodide's `batched` stdout handler fires once per *flush* with the
trailing newline stripped, and the runtime appended one back — correct when the flush ended
a line, wrong when it did not, and pytest flushes after every dot. Thirteen handler calls,
eleven of them a single `.`. The fix is the byte `Writer`, which passes Python's bytes
through verbatim; a heuristic like "append a newline unless the chunk looks partial" would
have been the same class of bug. Moving off the batched handler exposed that it was also
*discarding* any final partial chunk — `print("x", end="")` produced no output at all, and
an explicit flush did not bring it back — so the runtime now flushes Python's own buffer
wherever control returns to us: end of a script (before the error report, so ordering
holds), each REPL line so a result precedes the next `>>> `, and each served request so a
`print()` in a view is not held until 8 KB accumulate. Verified against real pytest under
real Pyodide, byte for byte against what real pytest pipes; the REPL's partial-line case
matches CPython's own `>>> hello>>> ` shape. The bridge spike was itself rendering through
a batched handler and joining on `\n`, so it could not have caught this; it now renders
through the shipped writer. Interpreter-free parts of the guard (no newline added,
consecutive partial writes stay on one line, the buffer is copied) live in the offline
tier; that real pytest renders as one line needs an interpreter and stays in the bridge
tier. Left alone deliberately: the `Loading …/Loaded …` package lists are Pyodide's
`loadPackage` progress, and they appear twice because each `python` is a fresh interpreter,
which is correct and documented. They are ugly, but they are the only feedback during a
multi-megabyte first fetch, and reshaping them into pip's `Collecting`/`Successfully
installed` would be claiming an install that does not persist.

Reported as already sound, rather than churned: the template-registry checks are
self-referential by nature — "the entry file this manifest names is one it ships" has no
outside authority — and the `setupSource` string assertions are a drift guard and say so.
The stub-runtime driver both tiers use moved to `scripts/lib/python-drive.mjs`, which also
pulled the serve-option parsing into the PR-gated tier where the argv bugs actually were.

See ARCHITECTURE.md §9.3 and the AGENTS.md "Python is Pyodide" gotchas.

## Bun runtime environment — `import.meta`, automatic `.env`, and a real `sleepSync` (this change)

Three things a Bun project does before it does anything else: read `import.meta.dir` to find a
file next to itself, read `process.env.DATABASE_URL` and expect the `.env` file to already be in
it, and — occasionally — block. Vivari did the first partially, the second **not at all**, and
the third by burning a core. None of the three announced itself: a project that works under Bun
started here with `import.meta.dir === undefined`, an `undefined` connection string, and a sleep
that pinned the CPU for its whole duration. **Phase 2, batch A.**

- **`import.meta` gets Bun's members, and only under Bun.** The ESM prelude in
  `packages/runtime/esm.js` already carried `url`, `resolve`, `filename` and `dirname` (Node's
  set); it now also carries `path`, `dir`, `file`, `env`, `main` and `resolveSync`. The gate is
  the interesting part: those six are installed **only when the `Bun` global is present**, i.e.
  only in a process started by `/bin/bun.js`. That is not tidiness. `import.meta.env` is not a
  Node member, and a Vite SSR file that reads `import.meta.env.MODE` under plain `node` is
  *supposed* to get a `TypeError` on `undefined` — a failure the caller can see and act on.
  Aliasing `import.meta.env` to `process.env` for every module would turn that into a quiet
  `undefined` flowing onward as a mode string, which is the precise class of bug this shim exists
  to avoid. Bun draws the same line from the other side: invoked as `node` (`bun --bun`, a `node`
  symlink) it turns its own `import.meta.env` and `.env` behaviour off. The prelude reads
  `globalThis.Bun`, never a bare `Bun`, because a module may declare its own top-level
  `const Bun` and the prelude shares that scope — a bare reference would hit the TDZ and throw
  before the module body started.
- **`import.meta.main` is an identity check, never a path compare.** It answers
  `require.main === module` against the loader's *live* entry-module link (`module.js` publishes
  the entry in `runMain` before its body runs, and `require.main` is a getter onto it). The
  tempting implementation — compare `import.meta.path` to `process.argv[1]` — is confidently
  wrong the moment a bin shim, a symlink or a realpath rewrite makes argv[1] name something other
  than the file that was actually loaded, and `if (import.meta.main)` guards silently doing
  nothing is a bad way to find that out. When the seam is genuinely absent (a `require` with no
  entry-module link) the getter **throws and names itself** rather than returning the plausible
  `false`.
- **The `bun` launcher runs the entry through `runMain`, not `require`.** This was the bug behind
  the previous point rather than a refinement of it: `bun app.ts` used a bare `require(abs)`, so
  the process entry module stayed `/bin/bun.js` — the launcher — and inside the file the user
  actually asked to run, both `require.main === module` and `import.meta.main` were `false`. Going
  through the loader's `runMain` also picks up cmd-shim unwrapping and the top-level-await entry
  handling that `runMain` already owns; a TLA entry's rejection is caught and reported instead of
  exiting silently.
- **Automatic `.env` loading (`packages/runtime/builtins/bun-env.js`), and the precedence is the
  whole risk.** Bun reads `.env` files with no opt-in, which is why Bun projects do not depend on
  `dotenv`. Files are read `.env.{mode}.local` → `.env.local` → `.env.{mode}` → `.env` and each is
  applied **without overriding a key that is already set**, so the *first* file to define a key
  wins and a variable exported by the shell beats every file. Reverse that list and nothing looks
  broken — every file still "loads", the values are just quietly the wrong ones — which is why the
  order is asserted directly rather than inferred from a single end-to-end value. `.env.local` is
  skipped under `NODE_ENV=test` (it is machine-local developer state; a suite that reads it passes
  on the laptop that has one and fails everywhere else — oven-sh/bun#9877, and Bun's own docs call
  the exception out). `{mode}` is one of exactly three values derived from `BUN_ENV ?? NODE_ENV`,
  matched exactly, everything else falling to `development` — so `NODE_ENV=staging` reads
  `.env.development` and never a `.env.staging`. That surprises people; it is still what Bun does,
  and inventing `.env.staging` here would make a file load in the sandbox that is ignored in
  production.
- **The parser is a port of Bun's, not a fresh reading of "dotenv format".** There is no dotenv
  specification — only implementations that disagree — and Bun's (`src/env_loader.zig`) disagrees
  with the popular JS ones in ways that change values, not just style: backtick quotes, the
  `KEY: value` form, `#` ending an unquoted value with no whitespace in front of it (`A=a#b` is
  `a`, where dotenv keeps `a#b`), multi-line double-quoted values with `\n` unescaping, a later
  assignment winning *within* one file, and `$VAR` / `${VAR}` / `${VAR:-default}` expansion that
  applies inside single quotes too and treats a trailing `$` as literal. It is deliberately **not**
  shared with the `--env-file` reader in `kernel-host/coreutils.js`: that one implements *Node's*
  smaller `--env-file` language, which is Node's to define and not ours to widen, and it lives
  inside the template literal that is the `node` program's source, so there is no module to import
  anyway.
- **`bun test` is Bun's test *mode*, in two steps and in that order.** The `.env` file set is the
  test set — `.env.test.local`, `.env.test`, `.env`, no `.env.local` — and `NODE_ENV` is *then*
  defaulted to `"test"`, "unless it is already set in the environment or in `.env` files". The
  order matters and is why the mode cannot simply be read back off `NODE_ENV`: derive it there and
  a plain `bun test` with no `NODE_ENV` picks the *development* set and reads the `.env.local` Bun
  deliberately skips. An in-progress version of this change asserted the NODE_ENV default was
  undocumented and left it out; it is documented (bun.com/docs/test/runtime-behavior), it is now
  implemented, and the kernel spike runs a real `bun test` against the `.env.local` written by the
  block before it to prove the file is not read.
- **Where `.env` loading happens is a decision, not a default.** It is triggered from
  `__ocInstallBun({dotenv:true})`, which only a `bun` process ever reaches, and only on the paths
  where Bun itself loads: running a file, `-e`, `test`, `build`. Not `bun run <script>` — real Bun
  skips the default files for the script *runner* and leaves them to the `bun` the script starts,
  so that `"build": "NODE_ENV=production bun app.ts"` is not handed the runner's development
  environment (oven-sh/bun#9635). Not `bun install`/`bun x` either: those delegate to npm/npx, and
  quietly rewriting npm's environment from a project file is a surprise nobody asked for.
- **`Bun.sleepSync` parks instead of spinning.** It was `while (Date.now() < end);` — the right
  elapsed time and nothing else that is right, holding a core at 100% for the duration, which on a
  one-worker-per-process kernel is a whole CPU spent waiting. Real Bun calls `nanosleep(2)`; the
  browser's nearest equivalent is `Atomics.wait` on a word nobody ever notifies, which parks the
  thread for real and ends by timing out. That is the same primitive the entire synchronous
  syscall bridge already stands on, so it is exported from `packages/protocol/syscall.js` as
  `parkFor`/`canPark` — next to the ABI it belongs to — rather than re-derived here. `Atomics.wait`
  is **illegal on a browser main thread** (it throws), so `parkFor` reports its capability instead
  of throwing and the old spin stays as an explicit, documented fallback: slow, never wrong, and a
  sleep that used to work does not start failing. Argument handling is Bun's own, including the
  i32 coercion (`1.9` sleeps 1ms) and the throws on a missing argument, a `Date` (that overload
  belongs to the async `Bun.sleep`) and a negative duration — those are Bun's errors, not sandbox
  limitations, so they are reproduced rather than softened.
- **`Bun.resolveSync` stopped dropping its second argument** (found while pinning down
  `import.meta.resolveSync`, and fixed here because it is the same question asked twice).
  `Bun.resolveSync(specifier, root)` takes a **directory** to resolve from — the docs' own example
  passes `import.meta.dir` — while `import.meta.resolveSync(specifier, parent)` takes the importing
  **file**, and Bun's typings define the latter as `Bun.resolveSync(moduleId, path.dirname(parent))`.
  Ours accepted `root` and ignored it, so every call resolved from the runtime's own base: a real,
  absolute, plausible path to a *different file*. Both overloads are now correct and distinct, and
  with no resolver attached at all they throw rather than echoing the specifier back.

Divergences worth stating plainly. `bun test` under this shim runs the test *files* through our
`bun:test` runner rather than Bun's, so "test mode" here means the environment semantics above and
not Bun's runner internals. `import.meta.resolve` still returns a path where Bun (and Node) return
a `file://` URL — pre-existing, unchanged by this batch, and called out here so it is not
rediscovered as new. And `--env-file` / `--no-env-file` / `bunfig.toml`'s `env = false` are not
wired up: the automatic set is all there is today.

The offline tier goes from 463 checks to **557**, and it earns them: the `import.meta` prelude is
evaluated as *source* against a stub `require`/`module` (which is why `importMetaSource` is
exported at all — the members are decided by generated text, and a kernel run can only tell you
that *something* about it is wrong), the file list is asserted as a list rather than inferred from
one value, and each parser quirk is a separate check naming the library it disagrees with. The
kernel tier adds two blocks that cannot be faked offline — `.env` read off the real VFS from the
process cwd with all four files present, `import.meta.main` true in the entry and false in the
module it imports, a `Bun.sleepSync(60)` that really blocks the worker, a plain `node` run next to
the same `.env` files proving it reads none of them, and a `bun test` proving the test-mode file
set.
## Bun VFS scanning — `Bun.Glob.scan()`/`.scanSync()` and `Bun.FileSystemRouter` (this change)

The previous Bun batch shipped `Bun.Glob` as a matcher and stopped there: `.scan()` and
`.scanSync()` threw, naming themselves and naming Phase 2, because a directory walk is a
different problem from a pattern compiler and an empty iterator would have read as "no files
matched". This change is that walk, plus the one other Bun API that is mostly a directory walk
with a grammar on top — `Bun.FileSystemRouter`. **Two APIs, one traversal.**

- **`.scan()` is an `AsyncIterable`, `.scanSync()` an `Iterable`, and the asymmetry is the API.**
  Bun types them that way, so a `for await` over `scanSync()` and a bare `for` over `scan()` both
  have to be wrong here exactly as they are wrong there; the spike asserts the presence of one
  iterator protocol and the *absence* of the other on each. It is not a difference in how much
  work happens up front — our syscalls are synchronous in both cases, since the calling worker
  parks in `Atomics.wait` until the fs worker answers — so `scan()` is the same lazy generator
  surfaced through an async one, which at least lets the consumer's loop body interleave with the
  traversal. Both are generators rather than materialised arrays, which is what makes breaking out
  of a scan early stop the syscalls too, and that is pinned by counting directory reads.
- **The walk prunes; it does not walk everything and filter.** This is the part that looks like a
  micro-optimisation in a Node program and is not one here. Every `readdir` is a synchronous
  round trip across the SharedArrayBuffer bridge, and `readdirSync(dir, { withFileTypes: true })`
  costs one MORE round trip *per entry*, because our binding fills the dirent types with a
  per-name `lstat` (`node/bindings/fs.js`). So the walker reads names only, `lstat`s an entry
  lazily and only when the answer can still change the result, and skips whole subtrees using a
  small NFA over the pattern's path segments: `**` is a state that absorbs any number of path
  components, and every other segment compiles to a one-component `RegExp` through the SAME
  `globToRegExpSource` the matcher uses, so the two cannot drift apart. `src/*.ts` reads two
  directories instead of every directory in the project, `node_modules` included.
  The safety argument matters more than the saving: **the pruner never decides membership.**
  `.match()` does, through the same compiled `RegExp`, so a pruning bug can only ever cost us a
  file, never invent one — and a segment whose shape is ambiguous about how many directory levels
  it spans (a `**` glued to other characters, a brace group containing a `/`) is deliberately
  widened to a `**` state, which errs toward descending into more places. The offline spike pins
  this directly by running each of ten patterns twice, once pruned and once as a full walk
  filtered by `.match()`, and asserting the two lists are identical. That check is the whole
  reason the pruner is allowed to exist: the failure it guards against is a build that silently
  omits a file nobody thought to look for, which no ordinary test notices.
- **Symlinks are honoured, not flattened.** The Rust VFS stores real symlink inodes, so `lstat`
  and `stat` genuinely disagree and the walker has to make choices rather than inherit them.
  `followSymlinks` defaults to false, so a symlinked directory is not traversed — but it is still
  `stat`ed, because `onlyFiles` needs to know whether it *names* a directory, and reporting a link
  to a directory as a file merely because we declined to look through it would be the plausible
  wrong answer this codebase forbids. With `followSymlinks: true` a cycle (`a/link -> a`) is an
  infinite walk that the VFS's own `ELOOP` guard does not catch, since every individual
  resolution is perfectly valid and it is the traversal that never terminates; the walker tracks
  the resolved directories it reached *through* a link and refuses to re-enter an ancestor. A
  broken link is skipped by default and throws naming the path under
  `throwErrorOnBrokenSymlink: true`. `onlyFiles` defaults to **true**, which is the option people
  get wrong, and a `cwd` that does not exist throws rather than yielding nothing — "no such
  directory" and "no files matched" are different answers and only one of them is actionable.
- **`Bun.FileSystemRouter` is a sibling of `Bun.serve`'s matcher, deliberately not a
  generalisation of it.** `bun.js` already has a compiled route table with parameters and
  precedence (`compileRoutes`/`matchRoute`, serving `Bun.serve`'s `routes`), so reusing it is the
  obvious first move, and it is the wrong one — not because of syntax but because the two are
  different languages with different precedence rules that happen to describe the same shape of
  thing. `Bun.serve` routes are `/blog/:slug`, `/files/*`, `/*`, and a single specificity number
  per route is enough for them because a serve route has one wildcard and it is always last.
  Next.js-style routing has `[param]`, `[...catchAll]`, `[[...optional]]`, `index` collapsing and
  extension stripping, and its precedence is **per-segment and left to right**, because two routes
  can disagree at any position: `/acme/[page]` beats `/[org]/settings` for the path
  `/acme/settings` even though both hold exactly one dynamic segment. A scalar score cannot
  express that, so generalising `matchRoute` would mean teaching it that specificity is a vector,
  and `Bun.serve`'s routing — load-bearing for every previewed Bun app — would then inherit the
  risk of every edit made for the router. The two matchers are about forty lines each. They do
  share the directory scan, which is `Bun.Glob`'s walker, so there is exactly one traversal
  implementation and one place where symlinks, hidden files and the syscall budget are handled.
  Precedence is the silently-wrong-if-approximated half, so it is pinned as behaviour and not
  just as a rank table: static beats dynamic, dynamic beats a catch-all, a catch-all beats an
  optional one, a required `[...page]` does not match its bare parent path while `[[...page]]`
  does, and `/` resolves to `index.tsx` rather than to the optional catch-all that also matches it.

Documented divergences, all pinned rather than "fixed" into what a reader might expect: catch-all
params are the remaining segments joined with `/`, because Bun types `MatchedRoute.params` as
`Record<string, string>` and not as Next.js's array; `pathname` echoes the input **including its
query string**, which is what the documented example prints; and `fileExtensions` defaults to the
four Next.js `pageExtensions` values, since Bun does not publish its own list and guessing wider
invents routes while guessing narrower loses them.

Four things throw where a quieter shim would guess. A `style` other than `"nextjs"` — the whole
point of the option is which grammar the brackets are in, so falling back to Next.js semantics
would answer a question the caller did not ask. A page file whose brackets do not parse (`[slug`),
which is not a static segment named `[slug` in any useful sense but a route no request can reach.
Two files resolving to the same route name (`blog.tsx` and `blog/index.tsx`), which Next.js also
calls a project error and where the alternative is letting directory-iteration order decide which
file serves `/blog`. And `.match()` on a Request or Response whose `url` is the empty string —
only a *fetched* Response carries a URL, so every locally constructed one would otherwise parse
as the root path and resolve to the index route.

The kernel tier is where these two APIs are actually proved. `scripts/spike-bun-offline.mjs`
drives the walker against an in-memory tree — which it can only do because `scanGlobSync(fs,
options)` takes its filesystem as an argument — and that is enough for the option matrix, the
prune-equals-full-walk invariant and the iterator-protocol split, but an in-memory object is not
evidence about the VFS. So `scripts/spike-bun.mjs` builds a tree in the real Wasm VFS from inside
a running Bun process, symlinks and dangling links included, and re-checks the same surface end
to end: sorted relative results, pruning, `absolute`, `dot`, `onlyFiles: false`, the default
`cwd`, both symlink options, and a `FileSystemRouter` over a scanned `pages/` directory down to
its `src`, `params` and `query`. The offline gate goes from 463 checks to 579.
## Bun cookies and the rest of `BunFile` (this change)

Phase 2 batch C: `Bun.Cookie`/`Bun.CookieMap` (new), and the parts of `BunFile` the shim had
been getting by without. Both are APIs where the plausible implementation and the correct one
differ in ways nothing in a passing test run would tell you — a cookie with the wrong scope is
a session that silently does not come back, and a writer that buffers is indistinguishable
from one that streams right up until the process dies.

- **`Bun.Cookie` / `Bun.CookieMap` are hand-rolled, not vendored.** The obvious move is
  `cookie` or `set-cookie-parser`, and it is wrong for the same reason it was wrong for
  `Bun.Glob`: at every point where a choice exists, those libraries made a defensible one and
  Bun made a *different* defensible one, and each such point changes the **scope or lifetime**
  of a cookie a browser actually stores. Five carry the risk and each is pinned. (1) The
  defaults are `path: "/"` and `sameSite: "lax"` and **both are always emitted** —
  `new Cookie("a","b").toString()` is `a=b; Path=/; SameSite=Lax`, where the npm `cookie`
  package emits neither. A shim that omits Path writes the cookie against the *request
  directory* (`/admin/login`, not `/`), so it reads back on the page that set it and vanishes
  everywhere else. (2) `Max-Age` beats `Expires` (RFC 6265 §5.3), and the precedence is about
  the **computed expiry**, not about which attribute survives: both are parsed, both are
  re-serialised, `isExpired()` consults Max-Age first, and the answer does not depend on which
  attribute came first in the header. `Max-Age=0` beats even a *future* `Expires`. (3) Values
  are percent-encoded on the way **out** and **not** decoded by `Cookie.parse` on the way in
  — `Cookie.parse("a=%20").value` is the three characters `%20` — which is Bun's asymmetry,
  not ours, and means a Set-Cookie round trip through `parse()` is deliberately not
  value-preserving. (4) A `Cookie:` *request* header follows a different rule again: values
  are decoded, names never are, because browsers enforce the `__Host-`/`__Secure-` prefix
  rules on the **literal** name and letting `__%48ost-session` answer to `__Host-session`
  would let an unprotected cookie shadow a protected one. (5) `sameSite: "none"` gets **no
  implicit `Secure`**. Every browser refuses to store such a cookie (RFC 6265bis §4.1.2.7),
  and it is still the wrong thing for us to add: writing an attribute the caller never asked
  for makes the shim disagree with Bun while being invisible in the caller's own source. The
  sandbox has no excuse to differ here either — cross-origin isolation is mandatory for
  SharedArrayBuffer, so Vivari is always a secure context and `secure: true` works in a
  preview.
- **`CookieMap` keeps two lists, not one map**, because the semantics need it: the cookies
  that *arrived* and the cookies that *changed*. Only the second become `Set-Cookie` headers,
  which is what stops every plain GET from rewriting every cookie the browser already had. A
  deletion is a tombstone (empty value, 1970 expiry) — invisible to `get`/`has`/`size`/
  iteration, still serialised — and it carries `Secure` for a `__Host-`/`__Secure-` name and
  whatever path/domain it was given, since a browser only drops a cookie whose scope matches.
- **The `Bun.serve` hook is deliberately narrow.** `cookies` is attached to `BunRequest` — the
  object a `routes` handler receives — and *not* to the plain `Request` a `fetch` handler
  gets, which is where Bun draws the line. Offering it in `fetch` would be more convenient and
  would make code that works here fail under real Bun, the one direction of divergence that is
  not allowed. On the way out, the response writer pulls Set-Cookie with
  `Headers.getSetCookie()` and hands Node the **array**: `Headers.forEach` flattens repeated
  headers into a single comma-joined value, and an `Expires=Thu, 01 Jan 1970 …` carries a
  comma of its own, so a flattened pair cannot be split apart again by anything downstream.
  Cookies are applied to the response rather than to the `Response` object because
  `Response.redirect()` has immutable headers and Bun still sets cookies on a redirect.
- **`BunFile.slice()` is a lazy window.** Bun documents it as not copying, opening or
  modifying the file; the entire point is handing the last 4 KB of a 4 GB log to something. A
  slice that materialises bytes has the right type and the right contents and turns a
  constant-memory program into an out-of-memory one, which no assertion about its *contents*
  can catch. Ours carries an absolute byte range and resolves it at **read** time, so slices
  compose, an open-ended slice follows a file that is still growing, and — the check that
  proves it — a slice taken *before the file exists* reads correctly once it does.
- **The `FileSink` from `.writer()` flushes incrementally.** It used to push every chunk into
  an array and write the lot in `end()`. That holds the whole file in memory, defeating the
  only reason to reach for an incremental writer, and loses everything if anything stops the
  process first — a crash, a `process.exit`, a killed preview — silently. It now opens the fd
  on the first write and drains whenever the buffer passes the high-water mark. `end()` also
  materialises the file when nothing was written, because a loop that produced no rows should
  leave an empty file rather than a missing one.
- **Every write is chunked to the syscall window**, which is the part that does not announce
  itself: `fs-client.js` caps an fd write at `FD_CHUNK` = 512 KiB (half of `DATA_BYTES`) and
  returns a **short write** for anything larger, so a sink that hands over 1.5 MB and assumes
  it all landed produces a truncated file, not an error. Both `Bun.write` and the sink loop on
  the returned count; the kernel spike writes 1.5 MB through the real Atomics bridge and reads
  the tail back.
- **`Bun.stdout`/`Bun.stderr` are BunFiles now**, because being a `Bun.write()` destination is
  their whole job in Bun's API (`Bun.write(Bun.stdout, Bun.file(p))` is Bun's three-line
  `cat`). Their read half throws rather than answering `""`. `Bun.stdin` stays the Node
  Readable it has always been — a known divergence kept on purpose, since guest code reads it
  with `.on("data")` off the SAB-backed stream and a BunFile wrapper would take that away to
  add a `.text()` we cannot make block.
- **Two more silent-wrong-value paths closed**, both the same shape as the `Bun.file(3)` fix in
  Phase 0: `Bun.write(1, data)` used to `String()` the fd and *create a file named `1`* in the
  cwd, reporting success, and `Bun.file()` with no argument handed back a handle on the path
  `"undefined"`. Both throw naming the API and the reason. `Bun.file(fd)` stays a throw.

**The kernel tier earned its keep.** `BunFile.stream()` had been inherited from the old
implementation as `Readable.toWeb(fs.createReadStream(...))` behind a
`Readable.toWeb ? … : …` guard, and it never worked in the VM: our vendored stream core
implements only `Readable.fromWeb` and leaves the other interop directions as functions that
throw `ERR_METHOD_NOT_IMPLEMENTED`. A function that *exists* and throws sails straight past a
presence check, and on the host Node the offline spike runs on, `toWeb` works — so the API was
green in the tier CI enforces and broken in the product. `.stream()` now builds a
`ReadableStream` out of bounded fd reads (64 KiB per `pull()`), which also stops it from
materialising a file it was asked to stream. Added to AGENTS.md as its own gotcha, because the
guard idiom is everywhere and `Bun.spawn().stdout` still has it. (Historical, and true when
written — but read it in the past tense on two counts: `Bun.spawn().stdout` lost the guard in
"`Bun.serve` hardening" below, and `Readable.toWeb` is implemented and no longer throws, see
"Web Streams `toWeb` was dead in the VM" at the end of this file. `.stream()` is still
hand-built, now for the laziness and the 64 KiB pull bound rather than to avoid a throw.)

One divergence is documented rather than fixed: a `BunFile` here is not a platform `Blob`
instance (Bun's extends `Blob`), so `new Response(Bun.file(p))` stringifies instead of
streaming the file. Both fixes are non-portable in opposite directions — duck-typing
(`Symbol.toStringTag = "Blob"`) satisfies Node's undici and not a browser Worker's native
`Response`, and `extends Blob` makes Node stream the file while the **browser** serves an
empty body out of the empty internal blob state. Being silently right on the tier we test and
silently wrong on the tier that ships is worse than a visible gap, so it is pinned in the
offline spike with the working spellings (`new Response(Bun.file(p).stream())`,
`await Bun.file(p).bytes()`) named next to it.

Cookie parsing and serialisation are pure, so they are covered essentially completely in the
tier that gates every PR: the offline spike goes from 463 checks to 626. The kernel spike adds
two blocks that only it can prove — a `Bun.serve({ routes })` server whose handlers read
`req.cookies` and set, delete and combine cookies with ones already on the `Response` (asserted
on the real header array coming back through the bridge), and a script that drives `BunFile`,
the `FileSink` and `Bun.write` against the real Wasm VFS, including the 1.5 MB chunked write
and reading the sink's output back out of the VFS *before* `end()` is called.
## Bun cryptography — `Bun.CryptoHasher` and real argon2id/bcrypt for `Bun.password` (this change)

The previous Bun batches were about APIs that returned plausible wrong answers. This one is about
the two members where a plausible wrong answer is a **security bug** rather than a correctness bug,
and where the failure is not just silent but *delayed*: it does not surface in the sandbox at all,
it surfaces in production, months later, as "nobody can log in".

`Bun.password` was the worse of the two. It ran node's `scryptSync` and emitted
`$vv-argon2id$<salt>$<key>` — a string that is not argon2, not bcrypt, not PHC, not modular crypt,
and readable by nothing on earth except the twelve lines that produced it — while reporting
`algorithm: "argon2id"` to the caller. It verified its own output perfectly, which is exactly why
the existing check ("hash it, verify it, they match") passed for as long as it did. That check was
not testing the property anyone cares about. The property anyone cares about is that a hash written
here verifies **elsewhere**, and only a vector from elsewhere can demonstrate it.

- **`Bun.password` is real argon2id and real bcrypt**, over the RustCrypto `argon2` and `bcrypt`
  crates in `packages/crypto`, emitting and accepting the standard encodings — PHC
  (`$argon2id$v=19$m=65536,t=2,p=1$…`) and modular crypt (`$2b$10$…`). The parameters are Bun's
  documented defaults, read out of Bun's `PasswordObject.zig` rather than guessed: argon2id at
  m=65536 KiB, t=2, p=1 with a 32-byte salt and a 32-byte tag; bcrypt at cost 10 with the `$2b$`
  prefix. It is pinned by hashes **real Bun printed** — the two argon2id samples in Bun's own docs
  and the bcrypt sample beside them all verify here, plus the `phc-winner-argon2` reference vector
  and the canonical Openwall bcrypt vectors.
- **bcrypt inputs longer than 72 bytes are SHA-512 pre-hashed**, because bcrypt's Blowfish key
  schedule consumes at most 72 bytes and silently ignores the rest. Bun does this; skipping it
  means a long password hashed in the sandbox does not verify in production, which is the exact
  shape of failure this whole effort exists to remove. Three details had to be exactly right and
  each of them is independently wrong-able: the test is `> 72` and **not** `>= 72` (a password of
  exactly 72 bytes is passed through untouched), what bcrypt receives is the **raw 64-byte digest**
  and not its hex or base64 form (base64 is the *better* engineering choice — it cannot contain a
  NUL — and it is the wrong answer here, because interop is the requirement, not taste), and the
  same transform has to happen on the verify path too. Bun's own test suite carries a bcrypt hash
  written by Bun 1.2.4 for a 500-byte password, kept specifically so this construction cannot
  drift; that hash verifies here, and it fails against the hex form, the base64 form and the
  un-pre-hashed password, so the check discriminates rather than merely passing.
- **Migration: `verify` still accepts the old `$vv-…` strings; nothing emits them again.** Silently
  rejecting them was never on the table — returning `false` means "wrong password", which is the
  unexplainable delayed failure in miniature. Between the two defensible answers (accept, or throw
  something explanatory) accepting wins because the divergence it creates is *unobservable*: real
  Bun throws `UnsupportedAlgorithm` on a `$vv-` string, and no real Bun deployment can ever hold
  one, since only this shim ever wrote that prefix. So we accept a string Bun would reject, in a
  namespace Bun can never encounter, and every string Bun **can** encounter behaves identically.
- **Cost, measured, not assumed.** argon2id at Bun's default cost is a real 64 MiB allocation and
  two passes over it. In wasm under Node it is **~97 ms to hash and ~97 ms to verify**, stable
  across runs. That is slower than native (tens of ms) but nowhere near the "a spike takes minutes"
  regime, so the default is Bun's default and stays there. Deliberately noted because the tempting
  fix — quietly lowering `memoryCost` so the tests feel snappier — would be the worst possible
  version of this change: a password KDF weakened invisibly, in code whose entire purpose is to
  behave like the real thing. Only the one check that exercises the default runs at the default;
  the rest use `memoryCost: 8` to stay cheap, exactly as Bun's own suite does.
- **`Bun.CryptoHasher` is complete**: Bun's whole documented 19-algorithm family (md4, md5, sha1,
  the sha2 family including sha512-224/256, the sha3 family, shake128/256, ripemd160, blake2b256/
  blake2b512/blake2s256) with Bun's case-insensitive alias table, plus `.copy()`, `.byteLength`,
  `.algorithm`, static `.hash()` and static `.algorithms`, `digest()` into a supplied `TypedArray`,
  and HMAC keying via `new CryptoHasher(algo, key)`. The sha3/shake/ripemd160/md4/blake2 halves of
  the crate are new; every one is pinned against OpenSSL or a published vector.
- **The consumed-HMAC rule is reproduced on purpose.** In real Bun a keyed hasher is *not* reset by
  `.digest()` — its context is released, and `.digest()`, `.update()`, `.copy()`, `.byteLength` and
  `.algorithm` all throw `HMAC has been consumed and is no longer usable` afterwards — while an
  unkeyed hasher *is* reset and is reusable from empty. The natural implementation resets both and
  cheerfully keeps hashing. That is self-consistent and produces digests real Bun refuses to
  produce at all, so it is invisible until the code leaves the sandbox. Both halves are pinned
  separately, since they differ.
- **HMAC is rejected at construction for shake128/shake256**, as in Bun: an extendable-output
  function has no fixed digest length to key. `blake3` is rejected too — not an omission, Bun has
  no blake3 in `EVP.Algorithm` or `CryptoHasherZig`, and accepting it would be the *more* dangerous
  divergence, since sandbox code would then break on its first real `bun` run.
- **Without the wasm crypto codec, `Bun.password` throws** and names the API and the reason.
  There is deliberately no pure-JS fallback: argon2id and bcrypt have no stand-in, and a hash that
  is not really one of them can be verified nowhere, which is strictly worse than not running.

Two implementation notes worth recording because they look like shortcuts and are not. BLAKE2
cannot go through RustCrypto's `hmac` (its core uses a lazy block buffer; `hmac` needs an eager
one, and RustCrypto's position is that BLAKE2 has a native keyed mode so it deliberately does not
wrap), so the HMAC construction is spelled out by hand against BLAKE2b's 128-byte block — and is
therefore pinned against Bun's own published HMAC-blake2b512 vector rather than trusted. And
`CryptoHasher` is a **buffering** hasher, not a streaming one, because the crate exposes one-shot
digests across the wasm boundary; `.copy()` clones the buffered input rather than a mid-state
context. That is observationally identical for every documented operation — a hash is a pure
function of its concatenated input, so a copy that diverges produces the same bytes either way,
and there is still only one hash computation per digest — and it differs only in memory held until
`.digest()`. Said plainly here rather than left for someone to discover.

The offline gate goes from 463 checks to 564. The new checks are split deliberately: the ones that
can run without the wasm codec do (algorithm tables, the alias map, `.copy()`, the consumed-HMAC
rule, the bcrypt pre-hash decision as a pure function, digests cross-checked against the host's
OpenSSL), and the ones that genuinely need the Rust crate — argon2id, bcrypt, hand-written
HMAC-BLAKE2b, and the two algorithms OpenSSL's default provider does not carry — announce
themselves as skipped in the Wasm-free tier and run in CI's `verify` job, which builds the crate.
`scripts/spike-bun.mjs` additionally drives the whole thing through a real guest process on the
kernel, because the offline spike hands the shim a hand-built `internalBinding('crypto')` and a
password hash that only works when the test rigs the binding is not a feature.

See ARCHITECTURE.md §9.2.

## `bun:sqlite` — real SQLite, on a VFS-backed store (this change)

`bun:sqlite` was registered and unusable. `makeBunSqlite` probed for
`@sqlite.org/sqlite-wasm` or `sql.js` and, if it found neither, threw an install message — and
if it found one, every query path still landed in a `runBackend()` whose entire body was
`throw new Error("bun:sqlite backend integration is experimental; wire your installed wasm
SQLite here.")`. There was no path through it. The install advice was also **unreachable by
construction**: the `require` handed to the Bun shim was rooted at `/`, and
`nodeModulesPaths` walks *parent* directories, so from `/` the only candidate was
`/node_modules` — a package installed into `<project>/node_modules` could never be found, no
matter what the user did. That second bug is fixed independently of SQLite: `createBunRuntime`
now also receives a CWD-rooted `require`, mirroring what `__ocImport` already did for bare
specifiers.

**The engine is the official `@sqlite.org/sqlite-wasm` build**, 3.53.0-build1 — the same C
source the SQLite authors test, compiled by them. What was rejected: `sql.js` (a fork of the
same C, but older, unmaintained relative to upstream, and its Emscripten glue is the part we
cannot use anyway, so the "smaller ecosystem" argument buys nothing); `node:sqlite`/
`better-sqlite3` (native N-API, no wasm32 build — the reason `libsql` is not a template
either); and compiling SQLite ourselves against the existing Rust toolchain (a fourth crate to
build, a fourth thing CI must have a toolchain for, to arrive at a binary the SQLite project
already publishes and signs).

**844 KiB, or 0.86 MB, committed** at `packages/runtime/vendor/sqlite/sqlite3.wasm`, not
generated at build time. That is the interesting decision, and it goes against the surface
reading of the repo's convention (small artifacts committed, large vendored runtimes under the
gitignored `packages/studio/public/vendor/`). The reason is the trap AGENTS.md documents: a
spike that SKIPS because its artifact is absent looks green. The `toolchain-gate` job runs the
offline tier with no Rust and no vendor step, and `verify` builds only the Rust crates; an
engine fetched at build time would mean `bun:sqlite` is either untested on every PR or CI grows
a network dependency on npm. 0.86 MB in git — about what `packages/crypto` compiles to, and it
changes only when SQLite cuts a release — buys a spike that cannot silently skip. `scripts/vendor-sqlite.mjs` copies it into the studio's public tree
for the browser (that copy is gitignored, and `predev`/`prebuild:studio` run it); `--refresh`
re-pulls from npm and **validates** the result — magic bytes, the required export set, that the
imports are a subset of what our loader supplies, and that the declared memory minimum still
fits — so an upstream ABI change fails the refresh rather than a user's first query.

**Emscripten's shipped JS glue is not used.** It cannot be: it is async-init, and `bun:sqlite`
is synchronous by definition — `db.query(sql).all()` returns rows, so there is nowhere to await
a boot. `bun-sqlite.js` supplies its 36 imports itself and instantiates with a bare
`new WebAssembly.Module(bytes)` + `new WebAssembly.Instance(...)`, which are synchronous
operations and legal in a Worker, where all guest code runs. That is the `llhttp-wasm.js`
precedent applied to something 16× larger; compiling 844 KiB measures at ~2 ms. Two details the
earlier investigation had left open are now settled: this build **imports** `env.memory` rather
than exporting it, so the loader creates it (128 pages initial — the binary's own declared
minimum, read back out of the import section by the vendor script — 2 GiB max, unshared); and
the Emscripten stack helpers are not exported and are not needed, because nothing here calls a
varargs C function.

**Storage is a real `sqlite3_vfs`, not a shim over one.** `xOpen`/`xRead`/`xWrite`/`xTruncate`/
`xFileSize`/`xDelete`/`xAccess`/`xFullPathname`/`xRandomness` call the runtime's own `fs`,
i.e. the SharedArrayBuffer syscall bridge, and `fdRead`/`fdWrite` take explicit offsets — which
is exactly the `pread`/`pwrite` a VFS wants, so no per-fd cursor emulation is needed after all
(the earlier note that the build imports no `__syscall_pread64` is true and turns out not to
matter, because we are not implementing Emscripten's syscall layer at all — we are replacing
the VFS above it, and once our VFS is the default **zero** Emscripten syscall stubs are
reached). The C function pointers SQLite needs are genuine ones: each JS callback is wrapped in
a hand-assembled 40-byte Wasm trampoline module and installed into
`__indirect_function_table`. The result is that a `.sqlite` file is an ordinary file in the
tree — it shows up in the Explorer, it survives the process, and the next process reads it.

**Three limits are stated rather than papered over.** `xSync` is a no-op, because the runtime's
`fsync`/`fdatasync` are: the rollback journal is still written and replayed, so a crash
mid-transaction recovers, but nothing is forced to durable storage and power loss is not
survivable the way SQLite promises. There is no file locking, so two processes writing the SAME
database concurrently can corrupt it — and this one is worth being precise about, because it is
**not** a Vivari compromise: the official Emscripten build's default VFS is literally
`unix-none`, SQLite's lock-free VFS, and its POSIX lock stubs report every file unlocked. Code
that would corrupt data here would corrupt it in the browser under real sqlite-wasm too. And
`journal_mode = WAL` needs mmap'd shared memory across processes, so it is declined with a
one-time warning and SQLite stays in `delete` mode — which is SQLite's own behaviour when a VFS
cannot do WAL, and means an ORM that sets WAL opportunistically keeps working instead of
failing to open.

**The two semantics that corrupt data when approximated are implemented.** `safeIntegers` is a
constructor option *and* a per-`Database`/per-`Statement` toggle, with statements inheriting the
database's setting at prepare time; it governs reads (`true` → exact `BigInt`, `false` →
`Number`, lossy above 2^53, which is Bun's documented behaviour and the reason the switch
exists) and the type of `lastInsertRowid`. Binding is exact either way — a `bigint` goes in via
`sqlite3_bind_int64`, and one outside int64 throws `RangeError` naming the value rather than
wrapping. `db.transaction()` nests via **SAVEPOINT**: top level is `BEGIN`/`COMMIT` with
`.deferred`/`.immediate`/`.exclusive` choosing the BEGIN flavour, nested is
`SAVEPOINT`/`RELEASE`, so an inner rollback discards only inner work. Nesting is decided by
`sqlite3_get_autocommit` rather than a counter we keep, so a hand-written `BEGIN` is seen too;
rollback is skipped when SQLite already rolled back for us (an `ON CONFLICT ROLLBACK`); and a
transaction function that returns a Promise throws, because committing before the async work
finishes is the failure this API invites. `loadExtension` (wants a `.so`), `fileControl` (a raw
pointer ABI) and `setCustomSQLite` (wants a system libsqlite3) throw naming the reason. Errors
are `SQLiteError` carrying SQLite's `code` (`SQLITE_CONSTRAINT_UNIQUE`, …), `errno` (the
extended result code) and `byteOffset`, as Bun's do.

**Nothing is paid for until it is used.** No fetch, no compile, no instantiation until the first
`new Database()`; then one engine cached per realm. Bytes come from `VV_SQLITE_WASM_PATH` (a VFS
path — the embedder escape hatch, and what the kernel spike uses), else the project's own
`@sqlite.org/sqlite-wasm` if it happens to be installed, else `VV_SQLITE_WASM_URL`, which the
kernel points at the same-origin `vendor/sqlite/sqlite3.wasm` and the guest pulls through the
blocking `OP_FETCH` syscall. There is no CDN in any branch.

**Verification: 937 → 1077 offline checks, 88 → 110 kernel checks.** The offline spike imports
`createBunSqlite` and hands it a `node:fs` host, so it drives the code that ships rather than a
parallel copy: types round-tripping, `.get()` returning `null` (not `undefined`) for no rows,
`.run()`'s `{changes, lastInsertRowid}`, all three named-parameter sigils, strict vs non-strict
binding, `SQLITE_CONSTRAINT_UNIQUE` on the error, SAVEPOINT nesting where an inner rollback
leaves outer work intact, `safeIntegers` above 2^53 in both directions, `serialize`/
`deserialize`, and heap growth under a multi-megabyte blob. The kernel spike is the part the
offline tier cannot claim: it writes a database in one process and reads it back in a
**different** one, asserts the file is in the VFS and begins with SQLite's documented
`"SQLite format 3\0"` header, and checks a relative filename resolves against the process's cwd
rather than the VFS root. Both fail loudly if the engine is missing; neither can skip. The
assertions are pinned to things outside this repo — SQLite's file format, SQLite's result-code
names, Bun's documented return shapes — rather than to our own output.

## `Bun.serve` hardening — honored options, WebSocket parity, and an honest streaming verdict (this change)

`Bun.serve` was already the best part of the Bun shim — a real Node `http.Server`, which is why
it previews through the same Service-Worker path as any Node server, with a genuine RFC 6455
handshake and frame codec. This change closes the gaps in it. Nothing here is a rescue; it is the
one Bun API people actually build on, so the bar was fidelity, not coverage.

**Eight options were accepted and silently ignored.** That is the failure mode this project cares
most about: code passes in the sandbox and breaks in production, and nothing tells the author.
Each now has a written-down answer (`builtins/bun-serve.js`), chosen by one rule — implement where
the sandbox genuinely can, degrade *loudly* where production is a superset we cannot reach but
serving without it is still faithful, throw where running without it means serving something that
is not the protocol the caller asked for.

- **Implemented.** `idleTimeout` — the nastiest of the eight, because ignoring it means a
  long-lived SSE endpoint works forever in the sandbox and gets silently cut off in production,
  and the symptom (a stream that just stops) points nowhere near the cause. It is real:
  `runtime/node/lib/net.js` is Node's vendored file, so `socket.setTimeout()` genuinely fires, and
  the kernel spike proves an idle connection is closed after ~1s with `idleTimeout: 1`. Validated
  at Bun's own u8 boundary, so a value real Bun rejects (256) is rejected here too rather than
  quietly working. `maxRequestBodySize` — enforced *as the body arrives*, with a 413; buffering
  it first and then complaining would defeat the point of the limit. `static` — a real Bun
  feature, so it is implemented properly (an exact-path map of pre-built `Response`s, matched
  before `routes`, cloned per request) rather than stubbed. `unix` — a genuine UNIX-domain
  socket; the net layer's `Pipe` binding works and an in-VM client fetches through it. The catch
  is discovery, not the socket: the preview finds servers by TCP port and a path has no port, so
  that is warned about explicitly. `id` is simply kept and exposed as `server.id` — nothing is
  being approximated, so it does not warn.
- **Degraded, announced once per process.** `tls` accepts the config and serves plaintext.
  Throwing was rejected deliberately: it would refuse to boot every app that merely *has* a
  production certificate configured, which is most of them, and there is no network hop inside
  the VM to protect. `server.url` reports `http:`, honestly. `reusePort` cannot load-balance one
  port across processes when the port registry binds it to exactly one. `ipv6Only` has no
  dual-stack socket to restrict on an IPv4-only loopback.
- **Threw.** `http3`. HTTP/3 is QUIC over UDP, a browser tab has no UDP socket, and answering
  HTTP/1.1 to code written for HTTP/3 is the silent-approximation failure in its purest form.

**`requestIP()` now returns `null`.** It used to fabricate `127.0.0.1` for every caller. That is
not a harmless placeholder — Bun's own types say `SocketAddress | null`, rate limiters and audit
logs branch on it, and a fabricated address makes a rate limiter silently treat every visitor on
Earth as one client while looking like it works. Peer addresses do not survive the Service-Worker
hop (the kernel forwards a request object, not a socket), so there is nothing true to report.

**WebSocket parity.** `ws.ping()`/`ws.pong()` were `ping() {} pong() {}` — literally empty, so a
keepalive loop sent nothing while looking healthy and the peer dropped the connection as idle.
They are now real control frames, with RFC 6455 §5.5's 125-byte limit enforced (a 126-byte
payload throws), and inbound ping/pong are surfaced to the `websocket.ping`/`pong` handlers.
`cork()` used to just invoke its callback, which is why it "worked" and saved nothing; it now
batches every frame written inside into **one** socket write — proven, not asserted, by a raw
socket that does its own handshake and counts inbound chunks: 3 sends arrive as 1 chunk corked
and 3 uncorked. Added `sendText`/`sendBinary`/`publishText`/`publishBinary`, `terminate()`, and
`getBufferedAmount()`. `publish()` now returns the byte count Bun documents rather than a
recipient count (`subscriberCount()` is the API for that).

**`drain` is wired to real backpressure — and will not fire, which is worth more than a
half-truth.** It is driven by the socket's actual `'drain'` event and the actual return value of
`write()`, not called unconditionally. But `node/bindings/net.js` `doWrite` hands every write
straight to the peer's inbox and reports it complete synchronously, so a loopback socket has no
send queue to overflow: measured at **25 MB written into an unread socket with
`getBufferedAmount()` never leaving 0**. So the handler is correct code with nothing to react to
here, and `Bun.serve` says so once if you register one. The kernel spike pins that measurement,
so if the net binding ever grows a queue, the check fails and tells whoever changed it that
`drain` has become live.

**Three real handshake defects, found and fixed.** The server echoed the client's *first* offered
subprotocol unconditionally — both an RFC 6455 §4.2.2 violation (it can name a protocol the
server does not speak) and a divergence from Bun, where you select one explicitly via
`server.upgrade(req, {headers})`; the sandbox therefore accepted a subprotocol that real Bun
would refuse. An earlier investigation flagged this fix as delicate because changing it might
break the in-VM client — **that turned out to be false, and was checked rather than assumed**: a
probe against a server that deliberately omits the echo shows the client opens normally with
`ws.protocol === ""`, which is what §4.2.2 permits. Second, a **duplicate**
`Sec-WebSocket-Protocol` header was emitted whenever both the caller's `headers` and the client's
request named one. Third, `Sec-WebSocket-Version` and the key were never validated — a missing
key was hashed as the empty string and the handshake "succeeded". Now: 426 (advertising 13) for a
bad version, 400 for a missing/malformed key.

**Frame validation.** The reader parsed the mask bit and the RSV bits and threw them away, so it
could not tell a legal frame from an illegal one. They are now surfaced, and a separate pure
function applies the rules a *server* must enforce: §5.1 (an unmasked client frame is a protocol
error — the shim used to accept them), §5.2 (RSV bits set with no negotiated extension; reserved
opcodes), §5.4 (a continuation with nothing to continue; a new data frame mid-fragment), §5.5
(control frames ≤125 bytes and never fragmented), plus `maxPayloadLength` → 1009. Validation is
deliberately *not* inside the reader: the reader is shared with the client-role codec in
`runtime/websocket.js`, and only a server may reject an unmasked frame. A 64-bit length whose
high word is non-zero is now reported instead of being silently truncated to its low 32 bits.

**A latent defect confirmed and fixed: `Bun.spawn()` threw on every call.** `Bun.spawn` adapted
its stdio with `Readable.toWeb ? Readable.toWeb(s) : s`. In the VM `typeof Readable.toWeb` is
`"function"` and calling it throws `ERR_METHOD_NOT_IMPLEMENTED` — our
`internal/webstreams/adapters.js` implements only `fromWeb`. So the guard passed and then
exploded, and **`Bun.spawn` was completely broken in the VM** (not merely its `.stdout`), while
the offline tier stayed green because host Node's `toWeb` works. `.stdout`/`.stderr` are now built
as `ReadableStream`s by hand. This is the third place this exact trap has bitten, so it is written
up in AGENTS.md "Critical gotchas" with the rule that follows: Web-Streams interop must be proven
in the kernel tier, because an offline check that passes for a host-Node reason is not evidence.
(Historical, and true when written. `Readable.toWeb` is real now and no longer raises
`ERR_METHOD_NOT_IMPLEMENTED` — see "Web Streams `toWeb` was dead in the VM" at the end of this
file, where it turns out the trap survived the implementation in a nastier form. `Bun.spawn()`
keeps its hand-built `.stdout`/`.stderr`, deliberately.)

**Streaming responses: assessed and deliberately not started.** A `Response` whose body is a
`ReadableStream` is still buffered in full. This is not a `Bun.serve` bug and cannot be fixed in
`bun.js`: `OP_RESPOND` carries a `total` byte count that the kernel reassembles against before
resolving a **one-shot** Promise per `reqId`, and `sw.js` builds a buffered `Response` from the
one object it receives. The `vv-sse` tunnel does **not** show the path exists — it is a dedicated
`postMessage` side channel feeding an injected `EventSource` polyfill, bypassing Service-Worker
`fetch` interception entirely (as `vv-ws` does for WebSockets), so an app doing `fetch()` +
`body.getReader()` buffers today even though SSE "works". Lifting it means changing the protocol,
kernel, host bridge and Service Worker together (golden rule 4) *and* designing flow control from
scratch, since the loopback has none (see `drain` above). Half-implementing it would produce a
response that streams in the sandbox and buffers in production, which is worse than one that
honestly buffers — so it is left buffered and written up for a follow-up. Worth noting that
`idleTimeout`, the option most likely to silently kill a long-lived stream in production, is now
enforced, so that particular divergence is closed even though streaming is not.

The offline gate goes from **866 checks to 938**, the kernel gate from **88 to 123**. The split is
deliberate. The offline tier gets the pure policy and the RFC rules, pinned to values from
**outside this repo** — RFC 6455 §1.3's worked handshake example
(`dGhlIHNhbXBsZSBub25jZQ==` → `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`) and the six §5.7 wire frames, byte
for byte — rather than to our own encoder's output, which would pass against a codec that was
wrong symmetrically on both sides. The kernel tier gets everything that only real sockets and real
timers can prove: the idle timeout firing, the 413, `static`, the unix socket, ping/pong round
trips, cork's write coalescing, the absence of backpressure, and the `Bun.spawn` stream fix.

## Bun — failing loudly and usefully on the APIs a browser cannot provide (this change)

Phase 6 of the Bun coverage plan, and the one that adds no capability at all. It converts
confusing failures into actionable ones, which is the cheapest trust win available: roughly
twenty of Bun's APIs genuinely cannot work in a browser tab, and until now most of them were
simply `undefined` on the `Bun` global. A dependency called one and the user got
`TypeError: Bun.udpSocket is not a function` from six frames down, with nothing explaining that
a browser cannot open a UDP socket and no hint about what to do instead.

The pattern is not new — `bun:ffi` has had it since the beginning — it is now applied to the
whole surface. **Export the symbol so an `import { dlopen } from "bun:ffi"`, a destructure or a
property read still LOADS, and throw when it is CALLED.** A load-time throw is strictly worse:
one unused import at the top of a transitive dependency would take down a project that never
touches the API. Everything lives in a new sibling, `packages/runtime/builtins/bun-unsupported.js`,
which is the only file in the Bun shim with no implementation to read — it *is* the catalogue of
what is impossible here and what to use instead.

- **Now loud, and previously `undefined`:** `Bun.listen`/`Bun.connect` (raw TCP),
  `Bun.udpSocket`, `Bun.RedisClient`/`Bun.redis`, `Bun.SQL` (per adapter), `Bun.WebView`,
  `Bun.mmap`, `Bun.peek`/`Bun.peek.status`, `Bun.secrets`, and `bun build --compile` in the CLI.
  `bun:ffi` gained the members it never had: `CFunction`, `linkSymbols` and `JSCallback` were
  absent entirely, and `CString` was an EMPTY CLASS — `new CString(ptr)` succeeded and returned
  an object with no string in it, which is the silently-wrong tier this project keeps deleting.
- **Each message names the API, the specific missing capability, and the alternative.** Not "not
  available in the browser" but "a page cannot open a raw TCP socket, so no protocol built on one
  (Postgres, MySQL, Redis, SMTP, AMQP) can reach a server from inside the tab", and then where to
  go: `Bun.serve` for a listener, `fetch` for outbound traffic, `bun:sqlite` for the TCP-bound
  database and cache clients. `Bun.SQL` picks its message from the connection string, because a
  Postgres user and a SQLite user need different next steps.
- **Two message shapes, and the difference is the deliverable.** "is not supported in Vivari
  (browser sandbox)" means *cannot ever work here* — stop and redesign. "is not implemented in the
  Vivari shim" means *possible, unwritten* — send a patch. Conflating them is its own dishonesty,
  so the split is asserted per API in the spike, and only two things are in the second group:
  `terminal: true` on `Bun.spawn`/`spawnSync` (a pty is a tty device we have no equivalent of, but
  a JavaScript pty emulation is perfectly possible here; pipes are substituted for nobody, because
  an interactive CLI on a pipe takes its non-interactive branch or hangs waiting for a prompt) and
  `Bun.SQL`'s SQLite adapter, which points at `bun:sqlite`.
- **`Bun.peek` was the debatable one, and it is in the FIRST group.** Nothing about the sandbox
  forbids it; what forbids it is that reading whether a promise has settled, synchronously,
  requires the engine's internal promise state, and no JavaScript engine exposes that to page code
  — the same wall as the `bun:jsc` heap helpers, in any host, browser or not. Nor is there an
  honest partial answer: returning the argument unchanged is exactly what real Bun does for a
  *pending* promise, so a shim that did it would be right by accident and silently wrong precisely
  when the API is being used for its purpose. It throws for every input, including non-promises,
  so the failure lands at the first call rather than the first call with real data in it.

### The native `.node` addon message

Application code almost never calls Node-API directly. `bcrypt`, `sharp`, `better-sqlite3`,
`canvas`, `node-sass` and most database drivers ship prebuilt binaries and hit it transitively at
`require()` time, which makes it the most common hard failure a real project meets in the browser.

**The symptom was `SyntaxError: Invalid or unexpected token`.** `compile()` read the `.node` file
as UTF-8 and handed the bytes to the module wrapper, so the user got a parse error about a file
that was never source. `Module._extensions['.node']` did carry a one-line message, and it was
never reached: `load()` calls `compile()` directly and never consults the extension table. The
check therefore sits at the TOP of `compile()`, with the extension entry pointing at the same
compiler so a tool that calls it directly gets the identical text. `process.dlopen` did not exist
at all and now throws the same error, because `node-gyp-build`, `bindings` and `node-pre-gyp`
resolve the path themselves instead of going through `require`. The error carries Node's
`ERR_DLOPEN_FAILED` code, so packages that branch on it take their pure-JS fallback. `.node` is
deliberately NOT added to the resolver's `EXTS`: a package that probes with `require.resolve`
before falling back to pure JS would otherwise conclude a native build exists and take the branch
that cannot work.

The message names the package and, where we have PROOF, its substitute. The map is evidence-gated
and each entry carries its evidence in a comment: `bcrypt`→`bcryptjs` (the registry alias in
`toolchain-shims.js`, gated by `spike-toolchain.mjs`, and applied automatically at install time),
`better-sqlite3`/`sqlite3`→`sql.js` (`spike-sqlite.mjs` + the shipped SQLite template),
`pg-native`→`@electric-sql/pglite` (`spike-pglite.mjs` + its template), `esbuild`→`esbuild-wasm`,
`rollup`/`@rollup/rollup-*`→`@rollup/wasm-node`, `lightningcss`→`lightningcss-wasm`,
`@next/swc-*`→`@next/swc-wasm-nodejs`, `@tailwindcss/oxide`→`@tailwindcss/oxide-wasm32-wasi`,
`@rspack/binding-*`→`@rspack/binding-wasm32-wasi`, and `argon2`→`Bun.password`'s real argon2id.
Packages with **no verified answer say so**: `sharp`, `canvas` and `node-sass` are listed with the
honest "no substitute is verified in Vivari" rather than a plausible guess, because a wrong
recommendation sends someone off to rewrite working code against something that fails the same
way. Being short is the point.

### Bookkeeping and docs

The hand-maintained COVERED / NOT SUPPORTED header in `bun.js` was audited against the code. Its
real drift: it claimed native addons and `bun:ffi` "fail loudly" while lumping **Bun macros and
`Bun.build` plugins** into the same sentence — those are absent rather than stubbed, and they need
no capability the sandbox lacks, so calling them impossible was wrong on both counts; `Bun.gc()`
appeared nowhere at all despite being a no-op that returns `undefined` where real Bun returns the
heap size; and `Bun.revision` and `Bun.Transpiler.transformSync` were missing from the covered
list. The header now separates *cannot ever work* from *not written yet* explicitly. (The
`bun:sqlite` entry is untouched here — it is being replaced by real work in a parallel change.)

`sites/docs` mentioned Bun **nowhere**, so this change adds `sites/docs/docs/bun.md`: what Bun is
here and why it is a shim, the table of what cannot work with the alternative for each, the
native-package substitution table, and what does work. It is the same information the error
messages carry, which is deliberate — someone who hits the error should find the same answer when
they search, and the page is the one place a user can read the list BEFORE choosing a dependency.

The offline gate goes from **937 checks to 1083**, the kernel-tier spike from **88 to 104**. The
offline checks assert all three halves of the contract per API — reading the symbol does not
throw, calling it does, and the message names the API and the right tier — because any one alone
is worthless and a regression to a load-time throw would otherwise be silent. They also drive the
real module loader with no kernel (`createModuleSystem` over host Node's `fs`), which is what
proves `require('bcrypt')` produces the addon message and not a `SyntaxError`. `scripts/spike-bun.mjs`
proves the same thing where it actually matters: a real `require()` of a real ELF-headed `.node`
inside a guest process on the Wasm VFS.

See ARCHITECTURE.md §9.2.

## Node APIs that failed silently, or lied (this change)

One theme, five slices: find the places where a Node API returned instead of failing. Not
missing APIs — those announce themselves — but the ones that imported cleanly and threw only
on first use, or accepted a call and discarded it, or answered a question with something
plausible and wrong. Every one of these had already been paid for once, in a debugging
session that started far from the cause.

**A — thirteen builtin ids were registered nowhere.** The vendored `lib/` reaches a fair
number of `internal/*` modules only from *inside* a function: `defineLazyProperties`,
`defineReplaceableLazyAttribute`, `getLazy(() => require('id'))`, or a plain `require` in a
cold branch. None of those run at import time, so `loader.js`'s `FACTORIES` table could be
missing an id for as long as nobody exercised the feature — and then `fs.cp`, `fs.rm(dir,
{recursive:true})`, `fs.glob`, `path.matchesGlob`, `fs.watch(dir, {recursive:true})`,
`util.MIMEType`, `util.diff` and `events.on()` each threw `Vivari: no vendored Node builtin
'…'` from a stack that named none of them. A static sweep of `node/lib/**` +
`node/internal/**` for every id reachable through those patterns found 13; there are
now **3**, and each of the three is a decision rather than a gap (see the coverage list
above). Twelve new `internal/*` files close it: eleven vendored bodies, plus one honest
not-implemented stub (`internal/util/trace_sigint`, 34 lines, correctly argued). With the
`ERR_*` constructors they need, **all 195 `ERR_*` names destructured anywhere in the tree now
resolve**, where
`ERR_ILLEGAL_CONSTRUCTOR` had been missing and turned `new readable.map()` into
"ERR_ILLEGAL_CONSTRUCTOR is not a constructor".

Two things about those vendored bodies are worth writing down rather than discovering later.
**Their provenance is v22.23.2, not the v24.18.0 the repo pins** — there is no network here,
so each body was taken from the host's own `process.binding('natives')`; the headers say so
and ask for a re-diff on a network-capable checkout. Each was checked against its *v24
caller* rather than assumed compatible, and the one genuine v22→v24 move was found that way:
v24 relocated `path.matchesGlob`'s matcher into `internal/fs/glob`, so `matchGlobPattern` is
re-exported there (the body is v22 `lib/path.js`'s own `glob()` helper, verbatim). The other
two deltas are forced by our substrate, not by taste: `rimraf` reads directories in string
mode because `bindings/fs.js` ignores `readdir`'s `encoding` and always returns strings, so
the verbatim `'buffer'` body would throw on the first non-empty directory — i.e. on exactly
the case the file exists for; and `cp-sync` throws explicitly when the `cpSyncCheckPaths` /
`cpSyncOverrideFile` / `cpSyncCopyDir` native helpers are absent, which they are, because
otherwise it dies as `TypeError: fsBinding.cpSyncCheckPaths is not a function` and reads like
a bug in user code. It still has to *load*: `lib/fs.js`'s `lazyLoadCp()` pulls `cp` and
`cp-sync` together, so without it the fully-working async `fs.cp` would be unreachable too.
The riskiest residue is `internal/deps/minimatch/index` — 1913 lines of Node's own bundled
third-party build, from a different Node minor, unreviewable by hand and exercised only
through the glob tests.

**And the registration table was only half of it.** `loader.js` inserted a module into the
cache *before* running its factory — it has to, or a cyclic `internal/*` require recurses
forever — and never rolled back on a throw. So a builtin whose factory failed was cached as
`{}`: the first `require` threw the real error, **every later one silently returned an empty
object**. That is this change set's own theme sitting in the loader itself, and it had been
hiding three failures — the moment the eviction went in, three tests that had been "passing"
started failing honestly, because the poisoned cache had been handing back `{}` instead of
re-throwing. Related, same file: `makeSystemError` set `err.code` to the libuv name
(`EISDIR`) where real Node sets the `ERR_*` key (`ERR_FS_EISDIR`) and keeps the libuv name on
`err.info`. Every ecosystem `err.code === 'ERR_FS_CP_*'` check missed. Checked against the
host Node's real output for both `ERR_FS_EISDIR` call sites; the only in-tree readers of a
raw `'EISDIR'` are in `rimraf.js`, and they inspect errors from the fs *binding*, not
SystemErrors.

**B — shims that lied.** `require('assert')` resolved to a 51-line hand-written shim, because
`module.js` consults the eager `builtins` table before the loader, while
`require('assert/strict')` went through to the real vendored module. Two structurally
different objects under two ids that Node guarantees are two halves of one module — and the
shim's `throws(fn, ExpectedError)` **ignored its second argument**, so a test asserting one
specific error passed on any throw at all. Deleted. Expect in-VM suites to get stricter: an
assertion that was vacuous now actually asserts, and a guest suite that was green can
legitimately go red.

`chmod`/`chown`/`utimes` were silent no-ops; they now at least require the target to exist,
throwing `ENOENT` labelled with the caller's own syscall name. They still cannot *persist* —
the VFS assigns `mode` only at creation and models neither uid/gid nor atime/ctime, and
there is no `OP_CHMOD` in the protocol — and `ENOSYS` was considered and rejected rather than
skipped: npm's `bin-links` does an unconditional `chmod` per installed bin and propagates the
rejection, and node-tar errors an extracted entry when `futimes` *and* `utimes` both fail, so
`ENOSYS` trades a quiet wrong-metadata problem for "no package manager works". Both were read
out of the real npm tree on disk, not from memory. The fd variants keep skipping the
equivalent `EBADF` check, deliberately, and that is the one residual dishonesty left knowingly
in place: node-tar calls all three on every extracted file, and the write that just went
through that fd already proves it is live.

`access()` ignored its `mode` and now enforces `X_OK`. `R_OK`/`W_OK` stay passing because
every process here is uid 0 and POSIX lets root bypass those checks — that is the correct
answer, not a shortcut — but `X_OK` is the one root does not get free, and the execute bit is
real and already reported by `stat`. This is the highest-risk item in the set and its risk is
worth stating rather than burying: **because `chmod` cannot persist, `chmod(f, 0o755)` then
`access(f, X_OK)` now throws where it used to falsely pass.** That is the loud wrong answer
chosen over the quiet one — it surfaces the missing `OP_CHMOD` at the point of use, and it
agrees with `stat`, which has always reported those files as non-executable, and with `isexe`,
which npm's `which` uses. No in-repo caller of `fs.access` exists; if a bundled tool trips on
it, the revert is one `if` block.

`net.connect` dispatched on the port alone. `lib/dns.js` maps every hostname to `127.0.0.1`
on purpose, so `net.connect(3000, 'api.example.com')` arrived at the binding as
`("127.0.0.1", 3000)` and was served by whatever in-VM dev server owned `:3000` — a 200 from
the wrong service, which is the worst available outcome. The destination is now judged before
the port lookup: non-loopback hostname → `ENOTFOUND`, non-loopback IP literal →
`EHOSTUNREACH`. Loopback preservation is the actual work here and it was verified by test
rather than asserted — the guard sits before both the `listeners` lookup and the cross-process
`pipeConnect` fallback, and the HMR/WebSocket relay, the Service Worker preview replay and a
stubbed Nitro/Nuxt-shaped cross-process proxy were each driven through it. A sweep of every
`host:`/`hostname:`/`connect(port, '…')` literal in `scripts/`, `packages/runtime/*.js`,
`packages/kernel-host/` and `packages/core/` found only `127.0.0.1`, `localhost`, `0.0.0.0`
and `''`.

`process.binding('natives')` and `Module.builtinModules` were two hardcoded lists, wrong in
opposite directions — `natives` vouched for `dgram`/`domain`/`repl`/`sys`, which hard-throw
on require, so `is-core-module` sent callers into that throw instead of letting them reach a
browser polyfill; `builtinModules` listed only the eager table (19 names) and so disagreed
with `Module.isBuiltin`, which had always consulted the loader too. Both now read one derived
list: Node v24's public core ids ∩ what `require()` can actually serve, 48 names, using the
same predicate `module.js` uses to answer `builtin: true`, so the list is resolvability by
construction. Second-highest-risk item: bundlers read `builtinModules` to decide what not to
bundle, and it went from 19 names to 48.

And `crypto.timingSafeEqual` did not exist. The reason that one matters more than a missing
API usually does is the shape of its call sites: auth code writes
`crypto.timingSafeEqual ? crypto.timingSafeEqual(a, b) : a === b`, so its absence silently
degraded every such comparison to `===` and reintroduced the exact timing leak the call was
there to prevent. Nothing threw. Implemented to Node's contract and checked differentially
against the host's real implementation across 9 cases, return value and error code.

**C — the Web Streams adapters were six functions, five of which threw.**
`internal/webstreams/adapters.js` went 80 → 797 lines; all six `Readable`/`Writable`/`Duplex`
`toWeb`/`fromWeb` converters are real, and the previous `Readable.fromWeb` "pragmatic pump"
(no `reader.closed` wiring, no `signal`, no `objectMode`/`encoding` validation, every chunk
force-wrapped in a `Buffer`) is gone. **It is a hand-written adaptation, not a verbatim
vendor, and that distinction has to stay recorded** or someone will "restore" it from
upstream and break it: upstream builds on Node's own bundled WHATWG implementation, which we
do not have — `stream/web` re-exports whichever globals the host realm provides, the browser
Worker's classes in the studio and Node's in the headless twin — and upstream reads two
`Safe*` primordials that our Proxy cannot resolve, where merely *destructuring* them throws.
So the classes resolve from `globalThis` per call (a realm-capability problem must not make
`require` of the module fail), `isReadableStream`/`isWritableStream` duck-type instead of
brand-checking (a browser-realm `ReadableStream` fails a Node brand check), and the file uses
plain intrinsics like the other hand-written `internal/*` modules. Control flow is otherwise
one-for-one with upstream, including behaviours that look wrong and are not (`Writable.toWeb`
using count semantics even in byte mode; `Readable.toWeb` producing a non-byte stream, so
`getReader({mode:'byob'})` throws) — those are pinned by tests so nobody "fixes" them.

One divergence is a real upstream bug rather than an adaptation. Upstream's `writev` installs
one handler as both the fulfilled and the rejected callback and starts it with
`error.filter(…)`; on the rejection path the reason is an `Error`, so it throws
`TypeError: error.filter is not a function` inside the promise chain. Reproduced against the
host's own `Writable.fromWeb`. Upstream gets away with it because the real error still
arrives via `writer.closed` — here it would be fatal, because `runtime/index.js` escalates
any non-sentinel unhandled rejection to `uncaughtException` and kills the guest. The handlers
are split, in `Writable.fromWeb` and `Duplex.fromWeb` both.

Still throwing on purpose: `newWritableStreamFromStreamBase` / `newReadableStreamFromStreamBase`.
They drive a libuv StreamBase handle directly, which our JS `stream_wrap` shim does not
implement, so any version would be a partially-correct conversion that silently drops
writes — precisely what this change set is about. Nothing in the runtime calls them; net and
http reach Web Streams through `toWeb` on the socket. They are exported so that a future
caller gets `ERR_METHOD_NOT_IMPLEMENTED` naming StreamBase and the alternative, rather than
`undefined is not a function`.

**Correction to C, and it is the important one: this shipped broken in the VM.** All six
converters were real and the 39/39 recorded under "Verification" below was honest, but the
rewrite also carried upstream's
`const finished = require("internal/streams/end-of-stream")` in verbatim. That is right
upstream, whose copy of that module is callable; **ours exports the pair `{ eos, finished }`**,
so the name bound an object and the first `finished(stream, cb)` inside a converter threw
`TypeError: finished is not a function` — no `code`. The three `toWeb` directions were dead in
the VM from the moment this merged; the three `fromWeb` directions, including the one corepack
streams its tarball through, were untouched. The `bun` kernel spike caught it as
`toWeb-throws:undefined`. Fixed one line and one entry later: "Web Streams `toWeb` was dead in
the VM", at the end of this file, which also explains why a host-Node harness of any size was
structurally unable to see it. The pinned behaviours named earlier in C stay pinned and are now
load-bearing for a second reason — `Readable.toWeb` producing a **non-byte** stream is what
makes "byte semantics" a wrong argument for keeping the hand-rolled Bun streams, since none of
those is a `type: "bytes"` stream either.

**D — and then the event loop could exit out from under them.** The adapters await host-realm
promises, which settle off our loop; `runtime/index.js` already wrapped the *reader*'s
`read()`/`cancel()` in `trackHost` for exactly this reason (the comment there cites corepack's
tarball download by name). The new writer paths were not covered: `Writable.fromWeb`'s pump is
`writer.ready.then(() => writer.write(chunk).then(…))`, both halves host promises, and under
backpressure `hostLiveness.active` stayed at 0 for the whole transfer — so a stream transfer
with no socket or timer alongside it could have the loop decide the process was idle mid-write.
`write`/`close`/`abort` now go through `wrapHostAsync`, and `writer.ready`, `writer.closed` and
the readers' `closed` through a new `wrapHostAsyncGetter`, because `wrapHostAsync` early-returns
on anything that is not a function and these are **getters**. Two details are load-bearing and
easy to get wrong in the obvious way: the wrapper must stay an accessor (`ready` hands out a
different promise each time the queue fills and drains, so collapsing it to a data property
pins the first one forever, and reading the original getter at patch time would force a promise
into existence before any stream is in play); and accessors need at-most-once tracking via a
`WeakSet`, because per spec `closed` is created once per reader/writer and returned on every
read, so refing each access stacks up refs its single settlement can never balance — a
permanently alive loop, i.e. a hung guest instead of an exited one.

Tracking the `closed` accessors is a change of liveness *semantics*, not just a bug fix, and
is flagged rather than smuggled: `closed` stays pending for the stream's whole lifetime and the
adapters read it eagerly at construction, so a guest that builds an adapter and then neither
consumes nor destroys it now hangs where it used to exit. Every adapter path does drive its
stream to a terminal state, so within the adapters the ref always clears, and it is arguably
the correct emulation — in real Node the underlying handle refs the loop. The mid-transfer fix
does not depend on it either way (between chunks there is always a tracked `ready` or `write`
pending); what `closed` buys is delivery of the premature-close and stream-error notifications.
The retreat is one line: drop `"closed"` from the two lists.

**E — `primordials` handed out four `Promise` statics that could not be called.** `resolve()`
returned `Promise.resolve` itself, so a destructured `PromiseResolve(x)` ran with
`this === undefined` and threw "is not a constructor" — `PromiseResolve`, `PromiseReject`,
`PromiseAll` and `PromiseWithResolvers`, which is what kept `events.on()` from working at all.
Node binds exactly one namespace for this reason and now so do we, through a `BIND_STATICS`
set. **Only `Promise` is in it, deliberately**, and the narrow choice is the point: binding
every namespace reached through the `<Ns><Member>` scheme rewrites ~100 working intrinsics to
fix 4, and `%TypedArray%`'s statics are the counter-example that makes it concrete — they do
need a receiver, but they need a *concrete subclass*, never the abstract base, so a bound
`TypedArrayFrom` would look resolved and never work, where unbound it keeps throwing honestly.
Under the narrow version `p.ArrayIsArray === Array.isArray` still holds. Both variants produce
identical harness output, so the narrowing costs nothing measurable. `BIND_STATICS` is an
**exception to the naming scheme documented in that file's own header**, which makes it look
like something to tidy away; it is now written into AGENTS.md for that reason.

The same file could not resolve `SafePromiseAll` or `SafeStringPrototypeSearch` at all — they
match no `<Ns>` prefix, so the Proxy threw on read, and since a vendored module *destructures*
its primordials at load, `internal/fs/cp/cp` and `internal/mime` died on require rather than on
use. Both are hand-written into `SPECIALS` now, using the file's own `uncurryThis` rather than
raw `.call`/`.map` (a file whose entire purpose is monkeypatch-proofing should not route through
a live `Array.prototype.map`), and verified with those two prototypes replaced by throwing
stubs. `SafeStringPrototypeSearch` mutates the regex it is handed by resetting `lastIndex` —
that is upstream's exact implementation and it is what makes `internal/mime.js`'s module-level
`/g` regexes behave like `.search`, verified across repeated calls. After this, **0 of the 123
primordial names the vendored tree destructures are unresolvable.** One audit finding was
rejected on inspection rather than acted on: `ObjectDefineProperty`/`ObjectDefineProperties`
appear broken to a probe that pattern-matches error text, but `Object.defineProperty` ignores
`this` entirely and reports "called on non-object" about its *target argument*. That was the
only evidence that could have justified binding beyond `Promise`.

### Verification — what actually ran, and what did not

**`npm run verify` could not run at all, and nothing here claims it did.** It dies at startup
in `scripts/fs-worker.mjs` with `Cannot find module '../packages/vfs/pkg-node/vivari_vfs.js'`:
`packages/vfs/pkg-node` is gitignored `wasm-pack` output, this machine has no
`cargo`/`rustc`/`wasm-pack`, and there is no network to fetch them, so the Rust→Wasm VFS
cannot be built. **The runtime-behaviour leg of this change set is therefore unverified
end-to-end and needs a run on a machine with the Rust toolchain before this is trusted in the
browser.** `npm run smoke` does pass (0 failed, 1 skipped — the pre-existing
`packages/core/dist not built` skip), but it is a source-level check of the SDK surface that
never loads the runtime, so it says nothing about any of this. Host Node here is v22.23.2.

What was run instead: per-slice harnesses on plain Node that import the **real, modified**
modules — no re-typed logic — with stubbed syscalls or a host-fs-backed `syscalls` shim
standing in for the VFS. They lived outside the repo and are the obvious thing to promote into
`scripts/` if we want them kept.

- **Loader + builtins exercise matrix (not `npm run smoke`): 37 pass / 2 fail**, and **all 120
  registered builtin ids instantiate**. Without the primordials fix it is 24 / 15. Newly green:
  `events.on()`, `fs.cp` tree copy, `ERR_FS_EISDIR`, `ERR_FS_CP_EEXIST`, the `cpSync` honest
  throw, `util.MIMEType` + `ERR_INVALID_MIME_SYNTAX`, and enumerating `util` (34 lazy keys).
  Already green and kept: `fs.rm` recursive/ENOENT/force, `fs.glob` ×5, `path.matchesGlob`,
  `fs.watch` recursive, `util.diff`, enumerating `fs`. The **2 remaining failures are the
  documented omissions**: enumerating `net` (`BlockList`/`SocketAddress`) and
  `util.getCallSites()` — the latter *not* the source-map-cache omission, as had been assumed;
  it fails one layer lower on a missing `internalBinding('util').getCallSites` and would still
  fail if that module were registered.
- **Web Streams adapters: 39/39**, against the realm's real `ReadableStream`/`WritableStream`/
  `TransformStream`, with a primordials Proxy that throws on *any* read (so the tests passing is
  itself the proof that the file reads none). The backpressure cases are real assertions, not
  smoke: they hold a chunk in flight and assert the next one never reaches the far side until a
  drain, in both directions. Last case is the realistic shape — a web `ReadableStream` through
  `zlib.createGzip()` into a web `WritableStream`, gunzipped back and compared.
- **`trackHost` coverage: 69/69**, driving real host streams with deferred-gated sinks so each
  promise is observed while genuinely pending, and with descriptors snapshotted *before*
  patching so the shape assertions compare against ground truth. The direct regression proof is
  a 5-chunk transfer through a HWM=1 sink: peak `active=2` where it was `0` before, `active=0`
  after, chunks in order.
- **fs + net bindings: 37/37** (including the async `FSReqCallback` variants and the
  cross-process pipe relay). **`assert` identity/behaviour: 21/21** against the real
  `loader.js`. **`timingSafeEqual`: 9/9 identical** to the host's own implementation.
- **Static audits:** every builtin id reachable from `node/lib/**` + `node/internal/**` (read
  two independent ways — a brace-depth-aware scrape of the table, so it can be pointed at
  `git show HEAD:…/loader.js` for the before-run, plus the live `has()` — and cross-checked by
  a dumber grep for every bare `'internal/…'` literal); all 195 `ERR_*` names; all 123
  primordial names. The one cross-check disagreement is `internal/watchdog`, which is prose
  inside a comment rather than a `require` — the two scans disagreeing on exactly that string
  is the expected signature of a mention.

Vendored bodies were diffed against the same builtin id out of the host's own
`process.binding('natives')`, which is how the three necessary deltas were separated from
accidental drift — but the host is v22.23.2, so **byte-level parity with the pinned v24.18.0
is not claimed** for any of the eleven vendored bodies or for `adapters.js`.

Also not verified, and worth naming: anything realm-specific to the browser Worker. The
adapters and the `trackHost` patch were exercised against Node's bundled Web Streams; Chromium
and Firefox differ in queue accounting and in how `writer.ready` settles relative to `write()`,
and the interaction with our own `loop.js` is precisely the thing no Node-side test can see.

### Follow-ups this leaves behind

- ⏳ `OP_CHMOD`/`OP_UTIMES` + `set_mode`/`set_mtime` on the VFS, which is what makes
  `chmod`/`chown`/`utimes` real and retires the `access(f, X_OK)` caveat. See "Persistence"
  in the deferred list above.
- ✅ `fsPromises.cp` routed into the deliberately-unimplemented sync path
  (`lib/fs/promises.js` wires `cp: wrap("cpSync")`) even though async `fs.cp` worked. Filed here
  as a one-line fix, which was wrong: re-routing the promise API would have left `fs.cpSync`
  itself dead. `cpSync` is implemented instead — see "`fs.cpSync` was missing" below, and the
  self-copy bug the gate found while proving it.
- ✅ Enumerating `net` threw on the `BlockList`/`SocketAddress` getters — the last instance of
  the trap AGENTS.md documents for `fs`. Not papered over with a stub class on purpose: a subtly
  wrong CIDR matcher is worse than an honest throw for a primitive callers use to decide whether
  to *accept* a connection. The objection was the missing test suite rather than the matcher, and
  real Node turned out to be the suite — see "`net.BlockList` was refused for want of a test
  suite" below.
- ⏳ Promote the per-slice harnesses into `scripts/` (or fold their cases into
  `verify-node.mjs`) so none of the above can silently regress — per the standing rule that a
  new Node API gets a probe.
- 🧊 Re-diff the eleven vendored bodies and `adapters.js` against genuine v24.18.0 sources on a
  network-capable checkout.
- 🧊 `internalBinding('icu')` is referenced by `lib/buffer.js` and does not exist. Pre-existing
  and dormant — `config.hasIntl` is `false`, which is what keeps `Buffer.transcode` from
  reaching it — but it is the same class of latent throw and it is now the only one the sweep
  can see.

See the AGENTS.md gotchas added with this change: the loader cache eviction, `primordials`
`BIND_STATICS`, the Web Streams adapters and their loop-liveness contract, the eager-shim
shadowing rule, the `chmod`/`X_OK` coupling, and the loopback-only `connect()`.
---

## `bun:test` — runner parity, and the two guards that stop a suite lying (this change)

Phase 5A of the Bun coverage plan. Teams evaluate a sandbox by running their test suite, so this
is a disproportionate share of first impressions — and it is also the one corner of the shim
where being *approximately* right is worse than being absent. Every other API fails visibly; a
wrong matcher reports success. So the whole of `bun:test` moved into a new
`packages/runtime/builtins/bun-test.js` with a stricter rule than the rest of the shim: **every
behaviour was checked against a real `bun test` (1.3.6, d530ed99), and the surprising ones are
reproduced with the observation written at the call site.**

### The written plan was stale; the audit came first

Two of its claims were already false on master: `toStrictEqual` is *not* identical to `toEqual`
(the loose/strict split was fixed when `Bun.deepEquals` became real), and `toMatchObject` exists
and is backed by `Bun.deepMatch`. Both were left alone. What was actually missing is below.

### What the runner gained

- **The modifier family, on both `describe` and `test`.** `describe` was a plain function with no
  properties at all: `.skip`/`.only`/`.todo`/`.each`/`.if`/`.skipIf`/`.todoIf` all died at load
  with "is not a function". `test` had `.skip`/`.todo`/`.only` and nothing else. Both are now
  complete, plus `test.failing` — which inverts the verdict and, when the test *passes*, fails it
  with Bun's own "remove `.failing` if tested behavior now works". A skipped or todo `describe`
  propagates its mode to everything inside it at registration time.
- **Per-test timeouts.** The options bag read only `{skip, only}` — which were never Bun's public
  options anyway. Bun's third argument is `number | {timeout, retry, repeats}`, all three of which
  now work, with `--timeout` setting the default (Bun's is 5000ms). Note what a timeout can and
  cannot do: an async body is genuinely abandoned at the deadline, a **synchronous** one cannot be
  interrupted by anything in JavaScript and is reported as timed out after it finishes. Real Bun
  behaves identically (a 200ms sync loop under `--timeout 50` runs to completion and is then
  marked timed out), so this is faithful rather than a shortcut.
- **`.each` on both, with Bun's title formatter reproduced bug-for-bug** — see the quirks below.
- **The `toHaveBeenCalled*` / `toHaveReturned*` family**, and a mock surface that records what it
  should: `mock.results` now records `{type: "throw"}` for a throwing call (it used to record
  nothing, so `toHaveReturnedTimes` would have counted a throw as a return), plus `contexts`,
  `instances`, `invocationCallOrder`, `lastCall` and the `*Once` variants.
- **`spyOn` that can actually be undone.** `mock.restore()` did not exist, and `mockRestore()`
  assigned the original back — which is wrong for an **inherited** method, because the object
  keeps an own-property copy that shadows the prototype forever. Restoring now deletes it. And
  `spyOn(obj, "notAMethod")` throws instead of installing a spy nothing will ever call.
- **`mock.module()`**, over the loader's require cache, resolved relative to the **test file**
  (the CLI tells the runner which file it is loading). Resolving against the process cwd would
  silently mock the wrong module for any test outside the project root, which is most of them.
- **The asymmetric matchers** — `expect.any`/`anything`/`objectContaining`/`arrayContaining`/
  `stringContaining`/`stringMatching`/`closeTo`, `expect.not.*` and `expect.extend` — honoured
  **recursively** inside `toEqual`/`toStrictEqual`/`toMatchObject`/`toContainEqual`/
  `toHaveBeenCalledWith` and inside a Map. They do **not** replace `Bun.deepEquals`: a cheap
  pre-pass checks whether the expected tree contains a matcher at all, and only then walks it by
  hand, so the loose-vs-strict split stays the single implementation for every ordinary compare.
- **Matcher breadth, chosen rather than padded:** `toBeCloseTo` (with Jest's non-obvious
  `10^-digits / 2` tolerance and its default of 2 digits), `toHaveProperty` (dotted *and* array
  path — the array form is the only way to reach a key containing a dot), `toContainEqual`,
  `toBeEmpty`, `toBeArray`/`toBeArrayOfSize`, `toBeString`/`toBeNumber`/`toBeBoolean`/
  `toBeFunction`/`toBeObject`/`toBeNil`/`toBeTypeOf`/`toBeInteger`/`toBeFinite`/`toBeDate`,
  `toStartWith`/`toEndWith`/`toInclude`, `toBeOneOf`, `toSatisfy`, `toThrowError`. A matcher that
  is absent fails loudly on its own (`… is not a function`), so restraint here is cheap.

### Two matchers that could not fail

- **`toThrow(/regex/) always passed.** The old matcher did
  `String(err.message).includes(typeof msg === "string" ? msg : "")`, so a RegExp argument became
  `includes("")` — true for every error. `expect(fn).toThrow(/anything at all/)` was an assertion
  with no failing case. All four argument forms are now distinct, including the one that
  surprises people: a **string** is a substring match, but an **Error instance** compares the
  message for **equality**.
- **`rejects.toThrow(msg)` ignored both its message and negation.** It ran
  `assert(false, threw, …)` with the negate flag hard-coded, so any rejection satisfied any
  expected message and `.rejects.not` did not exist. `.resolves` had exactly two matchers
  (`toBe`, `toEqual`). Both now expose the **full** matcher set with negation, running against
  the resolved value or the rejection reason.

### Snapshots: the judgement call, and why file-backed won

The brief left this open — file-backed, inline-only, or a loud not-implemented. **File-backed,
in Bun's own `.snap` format, byte-for-byte.** Two things made that the right answer rather than a
guess: the VFS is a real filesystem, so `__snapshots__/x.test.ts.snap` is a real file that
outlives the process; and a real `bun` binary was available to capture the exact format from,
which turns "resembles Bun" into a testable claim. It was tested the obvious way — a `.snap` file
written by this shim was handed to a real `bun test`, which read it and passed.

The serializer reproduces the details a from-scratch version gets wrong: object keys are
**sorted**, a getter prints as `[native code]` and is **not invoked** (which is also the safe
choice — a snapshot must not run side effects), `-0` survives, a function prints its **declared**
name only (`{f: () => {}}` is `[Function]` even though `.name` is `"f"`), a cycle is `[Circular]`,
a sparse hole is `undefined`, and the snapshot **key** joins describe blocks with a space
(`outer inner nested 1`) while the reporter joins them with `" > "`.

Two shapes **throw** instead of being serialized: a `Map` or a `Set` **nested inside** a
container. Bun's own output for those is malformed and not even self-consistent — a nested `Set`
gains padding the width of the current indent, a nested `Map` at the same depth gains none — so
there is no rule to encode, and writing tidier bytes would produce a `.snap` file that fails
under a real `bun test`. Both are fine at the top level, and the error says so.

`toMatchInlineSnapshot(…)` **compares** (with the call-site indentation stripped, as Jest does);
`toMatchInlineSnapshot()` with no argument **throws**. Creating one means rewriting the user's
source file at a position we would have to take from a stack frame pointing at
loader-transformed code (`typescript-transform.js` strips types before compiling), and an
insertion landing in the wrong place corrupts a test file. The error prints the value to paste.

### The two guards worth reproducing exactly

Both are Bun behaviours that exist for the same reason this file exists, and both were verified
against the real binary:

- **`.only` throws when `$CI` is truthy** — "disabled in CI environments to prevent accidentally
  skipping tests" — at *registration*, so the file fails to load rather than reporting a
  suspiciously small green run. `CI=false`, `CI=0` and an empty `CI` are not CI. This shim's own
  history is the argument for it: `test.only` used to register an ordinary test and filter
  nothing, so an `only` run executed the whole suite.
- **Snapshot creation is refused under CI** unless `--update-snapshots`. A first green build that
  wrote its own expectations proves nothing.

### One deliberate divergence, in the safe direction

`expect(alreadySettledPromise).rejects.toThrow()` returns **`undefined`** in real Bun: it peeks
the settled promise synchronously and throws. Nothing in a browser engine exposes that peek —
it is why `Bun.peek` is in `bun-unsupported.js` — so reproducing it would mean
`await expect(p).rejects.toThrow()` silently asserting nothing. Ours always returns a real
Promise, **and** the runner drains outstanding async assertions after each test body, so a
*forgotten* `await` still fails the test. That is stricter than Bun, and it is the only direction
worth erring in here.

### The CLI stopped dropping its flags

`doTest` did `rest.filter(a => a[0] !== '-')`. Every flag was discarded, so `bun test -t auth`
ran the entire suite and exited 0 — the exact silent approximation this project keeps deleting.
Now parsed: `-t`/`--test-name-pattern` (a regex over the full `describe > test` label),
`--bail[=N]`, `--timeout=<ms>`, `-u`/`--update-snapshots`, `--todo`, `--only`,
`--pass-with-no-tests`, `--reporter=junit|dots` with `--reporter-outfile`, and `--dots`.
**Anything else is refused by name** with the supported set listed. `--only` is honoured rather
than accepted-and-ignored: with nothing marked `.only` it runs **nothing** and exits 0 (checked
against the binary), because a flag asking for a narrower run must not produce a wider one. A
positional argument is a
**filename filter**, not a path — Bun documents `bun test foo bar` as "all test files with foo or
bar in the file name" — with an existing path still honoured. A `-t` that matches nothing exits 1
rather than reporting an empty green run, and a file that fails to *load* now fails the run
(it used to register no tests and report "0 fail").

The JUnit reporter omits the `line` and `hostname` attributes real Bun writes: there are no
source positions through the loader's transform and no OS hostname in a tab. Omitted rather than
filled with something plausible.

### The Bun quirks encoded, with their evidence

Every one of these was observed by running the real binary, not read off a doc page:

- **`.each` titles: `%s` substitutes only STRINGS, `%d`/`%i`/`%f` only NUMBERS.** A `%s` handed a
  number leaves the literal `"%s"` in the title *and still consumes the argument*, so
  `test.each([[1,"z"]])("A %s|%s")` is named `A %s|z`. `%i` additionally rejects `1.7` **and
  `-0`**, which is a JSC representation detail leaking out: `%i` wants an int32 and `-0` is
  stored as a double. `%j` and `%o` are both `JSON.stringify` (so a Map renders as `{}`), `%p` is
  pretty-format, `%#` is the row index, and a token with no argument left stays literal.
- **`.each` `$property` titles swallow one extra character on a miss.** `"$ end"` → `"$end"`,
  `"$a-b"` → `"$ab"`, `"pre$n.x post"` → `"pre$n.xpost"`. An off-by-one in the upstream scanner.
  `$` is an identifier character there, so `"$n$n"` parses as the single path `n$n`. `$`
  substitution is inert for an array row — no character is eaten. Reproduced because the title
  *is* the identity of a test: `-t` matches it and a snapshot is keyed by it.
- **`.rejects` refuses a function** (`Expected promise / Received: [Function]`), unlike Jest.
- **`.only` and snapshot creation are CI-gated**, above.
- **Snapshot keys join describe blocks with a space**, the reporter with `" > "`.

### Gating

The offline gate goes from **1295 checks to 1455**, the kernel-tier spike from **161 to 182**.
The new offline sections are ten, and the ones that matter are
**byte-exact fixtures captured from the real binary** rather than round-trips against our own
output — the rule AGENTS.md already sets for `Bun.hash` and `Bun.Glob`, and the only kind of test
that can catch a formatter that is self-consistently wrong. `scripts/spike-bun.mjs` adds four
kernel-tier sections for the parts where the VM is the point: the CLI flags reaching the runner
through a real process, `mock.module()` against the real module loader (its resolution rules,
`.ts` extensions and ESM→CJS compile are not Node's), snapshots written to and re-read from the
**Wasm VFS across two processes**, and the CI guards firing inside a guest. That last group found
a VM-only failure the offline tier could not: in an ESM test file `require` is undefined (as in
real Node), so `mock.module` has to be exercised through `await import()`.

See ARCHITECTURE.md §9.2 and the Bun section of AGENTS.md.

## `Bun.build` — a real bundler, and `Bun.plugin` (this change)

Phase 5B of the Bun coverage plan. `bun build` was a **single-file transpile wearing a
bundler's name**: it type-stripped the entry, rewrote that one file's imports, and followed no
dependency at all, so any project with two files produced an output that could not run — and
reported success doing it. `Bun.build`, the programmatic API every Bun build script actually
calls, and `Bun.plugin` were absent from the `Bun` global entirely.

Both now exist, in a new sibling `packages/runtime/builtins/bun-build.js`, with `bun build`
rewired onto the same engine so the CLI and the API cannot drift apart.

### The bundler is ours, not esbuild — and that was the decision to get right

The plan recommended delegating to esbuild-wasm, which already runs in-VM (Bundler Stage 1) and
is aliased in lockstep by `runtime/toolchain-shims.js`. It is a far better bundler than the one
in this change. It was rejected anyway, for four reasons in descending weight:

1. **`Bun.build` takes no dependency.** A Bun project that bundles has no bundler in its
   `package.json` — that is the entire pitch of a batteries-included runtime. The alias only
   rewrites `esbuild` for a project that already declares it, so an esbuild-backed `Bun.build`
   would throw on essentially every real Bun project until the author installed something Bun
   never asked for. Throwing loudly beats lying, but it loses badly to working.
2. **Vivari cannot hand esbuild-wasm over for free.** It is ~10 MB of Go/wasm, not in the
   runtime tree; shipping it means committing 10 MB or fetching from the network the first time
   somebody calls `Bun.build` in a tab. Neither is something a sandbox should do unasked.
3. **Resolution would stop matching the runtime's.** The graph here is walked with the module
   loader's own `resolveFilename` (injected as `resolveFrom` from `packages/runtime/index.js`) —
   same conditions, same `exports` handling, same `node_modules` walk, same TS/JSX transform —
   so a bundle contains exactly what `require` would have loaded in this VM. esbuild's resolver
   is excellent and it is not ours, and a bundle that resolves differently from the runtime it
   was built in is a debugging trap.
4. **Testability.** The kernel spike tier is offline, so an esbuild-backed `Bun.build` could
   only be proven in the network tier — moving the load-bearing proof to the least-run job.

The cost is paid honestly in the option policy below. A project that wants a production bundler
should still run esbuild, Rollup, Rspack or Vite; all of them work in-VM and the docs page says
so, next to `Bun.build`.

### The output is NOT byte-identical to real Bun's

Stated in the file header, in `sites/docs/docs/bun.md`, and in `bun build --help`, so nobody
files diff-noise bugs. Bun's bundler is a Zig program with its own parser, scope hoister, tree
shaker and printer. This one emits a registry of CommonJS-shaped module factories behind a small
prelude: different wrapping, different ordering, **no tree shaking, no renaming, no minifier**,
and output that is bigger than Bun's and never smaller. What it promises is that the bundle
*runs and computes the same answer* — every test asserts behaviour, never bytes and never a
hash. Two semantic divergences follow from the design and are documented at the call sites: the
CJS-shaped wrapping is how the Vivari runtime executes ESM anyway (`esm.js` rewrites
import/export down to `require` at load time), so a bundle behaves like the same project run
with `bun <entry>` *here*; and the export getters give the observable behaviour of live
bindings without Bun's single-scope hoisting.

### Implemented, degraded, refused

`entrypoints`, `outdir`, `target`, `format`, `external`, `define`, `naming` and `root` are
implemented. `target: "browser"` **refuses a Node builtin by name** rather than emitting a bundle
that dies on first run; `target: "bun"`/`"node"` leave builtins external. `format` covers
`esm`/`cjs`/`iife`, with `iife` warning once that a bundle with no module system has nowhere to
put exports. `external` matches exact, prefix and glob. `naming` expands `[dir]`/`[name]`/
`[ext]`/`[hash]`, the hash being a wyhash of the content (`bun-hash.js`, already there).

`minify`, `splitting`, `sourcemap` and `bytecode` **throw**, naming the option and pointing at
esbuild/rolldown. This is the strictest reading of the project's rule and it is deliberate:
`bun-serve.js` may degrade loudly because serving without `tls` is still serving, but a build
artifact is not something one can produce approximately. A bundler that returns `success: true`
having quietly dropped `minify` ships an unminified bundle to production and says nothing. So
does one that drops `sourcemap` and leaves a team debugging unmapped stack traces. Refusing is
the only answer that cannot be discovered in production.

`--compile`'s existing refusal is intact — it is now that same engine throw rather than a
separate check in the CLI, which is a small honesty win: the CLI can no longer accept a flag the
API rejects, or the reverse, because there is one code path.

### `Bun.plugin`, in two lifetimes

Build plugins (`Bun.build({plugins})`) get async `onResolve`/`onLoad` and affect one build.
Runtime plugins (`Bun.plugin({setup})` from a running program) are per-realm registry state that
`module.js` consults inside `resolveFilename` and `compile`, behind a `bunPluginsActive()` guard
so a process with no plugins pays one boolean per require. Runtime hooks must be **synchronous**
and a thenable throws rather than being handed back as the module's exports: the loader is sync
all the way down to `Atomics.wait` (golden rule 3), so there is nowhere to await. That is a real
divergence from Bun, where a runtime `onLoad` may be async — but the alternative is a module
whose exports are a pending promise, which is the silently-wrong tier this project keeps
deleting.

### Gating

The offline gate goes from **1295 checks to 1391**, the kernel tier from **161 to 186**. The
split follows the usual rule. Offline gets the pure, fast parts: the option policy (every
refusal asserted for its *specific* reason, not merely for throwing), naming-template expansion,
`external` matching, the dependency scanner's tokenizer — a `require` inside a string, a
comment, a template literal or after a regex literal is not a dependency, and a naive regex
passes every other test in the file — and a full multi-file bundle evaluated in a `new
Function`.

The kernel tier is where the load-bearing proof lives, because bundling needs real fs, real
resolution and real `node_modules`: a four-module TS/JSX/JSON graph plus an npm package, built
inside a guest process on the Wasm VFS, **with the sources deleted afterwards** and then the
bundle executed — which is the only way to prove the graph really was inlined rather than
re-read at run time — asserting the computed answer. Alongside it: `format: "esm"` output run as
a real ESM entry, the CLI's refusals, a build plugin's virtual module landing in the output, and
a runtime plugin rewiring `require` inside the running process.

Every new check was verified to fail against a deliberately broken implementation (graph walk
truncated to the entry, tokenizer swapped for a naive regex, the `minify` refusal disabled, the
`module.js` plugin seam short-circuited, build plugins never consulted, the browser-target
builtin check removed, the ESM re-export dropped) — eight mutations, each breaking between one
and ten checks, in both tiers.

See ARCHITECTURE.md §9.2.

## Web Streams `toWeb` was dead in the VM — one import line (this change)

The previous change set made all six `Readable`/`Writable`/`Duplex` `toWeb`/`fromWeb` converters
real (entry C above). **Three of them never worked in the VM.** The rewritten
`internal/webstreams/adapters.js` kept upstream's own import line verbatim —
`const finished = require("internal/streams/end-of-stream")` — which is correct upstream, where
that module is callable (`module.exports = eos`, with `finished` hung off it). Our copy exports
the plain pair `{ eos, finished }` (`internal/streams/end-of-stream.js:344`), so `finished` bound
the module *object* and the first `finished(stream, cb)` inside a converter threw
`TypeError: finished is not a function` — a bare `TypeError` with **no `code`**, which is exactly
how CI printed it: `toWeb-throws:undefined`. The fix is one line,
`const { eos: finished } = require("internal/streams/end-of-stream")`.

**That one line is not this entry's contribution.** Two changes diagnosed this regression from the
same CI failure in parallel, reached the same conclusion, and wrote the same fix; the `bun:test`
change (!125) landed first and carries it, along with a spike that now asserts `toWeb` *works*
rather than that it throws. This entry keeps the write-up because that change fixed the code and
left the story untold: nothing in this file recorded the regression, and the docs still taught the
opposite — see the last paragraph. What is genuinely added here is the reasoning below, the
`end-of-stream` divergence note that stops the next re-vendor from reintroducing it, and a spike
that reads the bytes back instead of only checking that the call returned.

**Blast radius, measured rather than reasoned.** `finished` is called from
`newWritableStreamFromStreamWritable` and `newReadableStreamFromStreamReadable`, and
`newReadableWritablePairFromDuplex` calls both — so precisely the three `toWeb` directions were
dead and the three `fromWeb` directions were fine throughout. **Corepack was never affected**: it
streams its tarball through `Readable.fromWeb` (`packages/kernel-host/load-real-corepack.js:25`,
`packages/runtime/index.js:1053`). Nothing else in `packages/` calls `toWeb` at all; the only
callers are guest programs, which is why the product symptom was confined to the VM's guest
surface. `packages/runtime/index.js` needed no change — the working hypothesis going in was that
the guest realm lacked `CountQueuingStrategy`/`ByteLengthQueuingStrategy`, and that was checked
and disproven: all 23 globals, classes and helpers the three converters touch resolve in the
guest, all four Web Streams globals included, and deleting both queuing-strategy classes still
yields working conversions through the plain-object fallbacks in `adapters.js`'s
`countStrategy`/`byteLengthStrategy` (L92-102).

**Why 39/39 host-Node checks could not see it, and why only the kernel tier could.** The defect
is not in `adapters.js` and not in `end-of-stream.js`; it is in the **seam between them**, and it
is a difference in *export shape*, not in resolvability. Any harness that lets
`require("internal/streams/end-of-stream")` reach host Node's own copy — callable — is testing a
module graph the VM never runs, and will pass no matter how many cases it has. The offline spike
tier has the same blind spot for the same reason: it runs on host Node, whose `toWeb` genuinely
works. `scripts/probe-node-registry.mjs` is blind here **by design**, and its "what it does not
catch" header says so in as many words: *"An id that is registered but whose factory throws at
load, or whose exports are missing the member the caller destructures, passes here."* The id
resolves; only its shape is wrong. That leaves the kernel tier — the one that executes the real
vendored graph inside the real VM — as the only place this class of bug is visible, which is the
standing rule from the previous change set doing its job.

**The fix is aliased, not renamed, and `eos` is the only correct binding.**
`const { eos: finished }` keeps the six converter bodies character-identical to upstream
v24.18.0, which is what makes re-vendoring diffable. The near-miss matters enough to be written
down: `const { finished }` *is*
a function, so it looks right and would move the failure one frame later — it is the
**promise-returning** variant (`end-of-stream.js:321`) and would hand the adapters a `Promise`
where they call the returned value as `cleanup()`, i.e. a stream that silently never cleans up.
`eos` is the callback form that returns the cleanup function, and it is what every other file in
`internal/streams/**` already imports (`readable.js:57`, `writable.js:54`, `pipeline.js:18`, …).
Both the call site and the file header's "deliberate divergences" list now record why, so
restoring upstream's line is a visible mistake rather than an invisible one. No defensive
machinery was added on purpose — a load-time member-shape assertion duplicates the import list
and rots into cover, and a wrapper that re-codes escaping `TypeError`s would mislabel genuine
user errors (a bad `options.strategy` legitimately throws a code-less `TypeError` out of the
WHATWG constructor) as internal gaps. The durable protection is the spike.

**`scripts/spike-bun.mjs` asserted the *broken* behaviour, which is how the throw survived the
rewrite meant to remove it.** The old block pinned `toWeb-throws:ERR_METHOD_NOT_IMPLEMENTED`, so
when the stub became a real implementation that failed in a new way, the assertion did not stop
it — it simply stopped matching. !125 flipped it to assert `toWeb-works:true` and to report
`e.code || e.message`, which is what makes a code-less throw nameable from the CI log without a
second run. This change adds the part that check still misses: it converts a real `Readable` in
the guest and **reads the bytes back** (`toWeb-reads:toweb-bytes`), because "did not throw" passes
equally for a converter that hands out an empty stream — and an empty stream is exactly what a
half-wired adapter produces. The throw is also quoted into the failing check's own line. The
`Bun.spawn().stdout` assertions in the same block are untouched.

**The mirror note, on the other side of the seam.** `internal/streams/end-of-stream.js` is headed
`VENDORED VERBATIM … Do not edit the body` with no mention of its export divergence, which is
precisely what made copying upstream's import line look safe. Its header now names the shape
(`{ eos, finished }` here versus a callable module upstream), the symptom it produced, and which
binding to reach for. The importing side already carries the same note, so the next re-vendor
has to walk past two of them.

**The three hand-rolled Bun streams stay hand-built — and the usual justification for that is
wrong.** It is *not* byte semantics. None of them is a `type: "bytes"` stream; they are ordinary
default `ReadableStream`s enqueuing `Uint8Array`s, exactly like `Readable.toWeb`, and
`getReader({mode:'byob'})` fails on both (see the pinned behaviour in entry C). Do not repeat that
argument. The real reasons are per site. `bun-file.js`'s `.stream()` is not an implementation of
the same behaviour at all: it opens **no fd until the consumer pulls**, so `.stream()` on a lazy
`.slice()` stays as lazy as the slice, and it enqueues exactly one ≤64 KiB chunk per pull, where
`Readable.toWeb(fs.createReadStream(…))` would chunk by the Readable's `highWaterMark` and the
adapter would run ahead of the reader (it pushes from `'data'` and pauses only when
`desiredSize <= 0`). `spike-bun-offline.mjs` asserts that bound directly (`widest <= 64 * 1024`),
so switching would be a behaviour change against a live assertion inside a regression fix.
`bun.js`'s `Bun.spawn().stdout`/`.stderr` is the more marginal call — `toWeb` would actually be
*better* on backpressure — but it degrades worse: the hand-built helper returns the Node stream
unchanged in a realm with no global `ReadableStream`, and `bun-bytes.js`'s
`Bun.readableStreamTo*` consumers accept either, where `toWeb` would put
`ERR_METHOD_NOT_IMPLEMENTED` inside `Bun.spawn()` itself. Switching is a behaviour change with no
bug behind it and belongs in its own change with its own kernel-tier gate. All four comments
(`bun.js:~970`, `bun-file.js` header and `.stream()`, `bun-bytes.js:~143`) now say the code
*predates* a working `toWeb` and what the standing reason to stay hand-built is, instead of
asserting that `toWeb` throws.

**Verification — and the honest gap.** The `bun` kernel spike, the one that failed, **was not
run**: `packages/vfs/pkg-node` is absent, there is no `cargo`/`rustc`/`wasm-pack` and no network,
so the Rust→Wasm VFS cannot be built here and `scripts/run-spikes.mjs` skips the tier outright
(`skip dep-cache: Wasm VFS not built`). What was run instead is the strongest substitute
available: a harness that drives **the same guest module graph the VM uses** — `loader.js`'s own
`FACTORIES` table, so the `Readable` under test is the vendored guest one and not host Node's —
against the pre-fix and post-fix files. Pre-fix it reproduces the CI symptom bit for bit
(`code=undefined`, `finished is not a function`); post-fix all 16 checks pass, covering the three
`toWeb` directions reading their bytes back, multi-chunk pull-and-close, source-error
propagation, the round trip through `Duplex`, the two StreamBase converters still throwing
`ERR_METHOD_NOT_IMPLEMENTED`, and argument validation keeping its `ERR_INVALID_ARG_TYPE`s. A
degraded realm with the queuing strategies deleted also passes, and one with `ReadableStream`
deleted still produces the coded, message-bearing honest failure the previous change set promised.
Alongside: `node --check` on all seven JS files touched, `probe-node-registry.mjs` PASS, and the
offline tier 9/9. **None of that is an in-VM run.** The in-VM behaviour of this fix is argued and
reproduced against the identical vendored module graph on host Node, not confirmed by a real
kernel run — **CI is the first one.** Also still unverified: whether the rewritten
`spawn-stream.ts` guest snippet transpiles and runs under the kernel's TS transform, and
`Readable.toWeb` against the browser Worker's WHATWG classes rather than Node's.

**Docs corrected with this change**, because several of them taught the opposite — and after
!125 landed the code fix they contradicted the repository's own spike: `AGENTS.md` still said
"`scripts/spike-bun.mjs` now asserts … that calling it throws" while that spike asserted
`toWeb-works:true`. Specifically: AGENTS.md's
`typeof`-guard gotcha is re-based on the real two-act story (the stub, then the code-less
`TypeError`) and now absorbs the near-duplicate `Readable.toWeb` THROWS section that followed the
Bun shim; the "ADAPTED, not vendored" gotcha gains the lesson this cost us — an upstream *import
line* is no safer to copy wholesale than an upstream body; ARCHITECTURE.md's `.stream()`
justification is now laziness and the pull bound rather than a broken `toWeb`; and the two
historical write-ups above (`BunFile.stream()`, `Bun.spawn()`) are marked as history so nobody
reads them as the present.

## Plain `http://` egress — the loopback/outside split, and the browser's ceiling (this change)

`https://` to the outside world worked; `http://` did not. `lib/https.js` is hand-written on the
Fetcher Worker (`__ocfetchAsync` / `__ocfetch`) and battle-tested carrying the real npm.
`lib/http.js` is Node v24.18.0 verbatim, and its client path ends at
`Agent.prototype.createConnection` → `net.createConnection`, i.e. at a loopback-only virtual
network. Until recently that failed *dishonestly* — `dns.js` flattens every name to `127.0.0.1`,
so `net.connect(3000, "api.example.com")` was quietly served by whatever in-VM dev server owned
`:3000`, returning a wrong 200 from a different service. That was fixed (non-local destinations
now fail `EHOSTUNREACH`/`ENOTFOUND`, and **that must not be undone**), which is what turned
plain-HTTP egress from invisibly wrong into visibly broken. Real code paths need it:
self-hosted/corporate registries and mirrors, local-network APIs, older SDKs.

### The routing predicate is the whole change

Everything else here is plumbing. The decision — loopback or egress — is made on the
**destination host only**, and by asking the virtual network rather than re-deriving its rules:
`bindings/net.js` now exports `isLocalDestination` on the `tcp_wrap` binding, **the same function
object** `connect()` accepts or refuses a dial with (`isLocalHostname`, which delegates to
`isLoopbackAddress` for a bare literal, so one entry point covers both shapes). A request
therefore egresses exactly when `connect()` would have refused it, and the two decisions cannot
drift apart in a later edit.

**It is deliberately not made on the port**, which is the tempting answer because `listen()` does
register ports (in-process `listeners`, mirrored to the kernel). That table answers a different
question and is wrong in both directions: "we serve `:3000`" would send
`http://api.example.com:3000` to the in-VM server — reinventing the bug that was just fixed — and
"we do not serve `:9999`" would send `http://127.0.0.1:9999` out to the internet, where a
stranger's server may answer 200, instead of the `ECONNREFUSED` every
wait-for-the-dev-server-to-start loop depends on. A cross-process in-VM port (Nitro's SSR worker)
is not in this process's registry at all; only the kernel's pipe table knows, and asking it opens
a connection as a side effect. Host is the only axis that answers the question. Every remaining
ambiguity resolves *away* from egress — an unparseable URL, `socketPath`, a caller-supplied
`createConnection`, an agent that overrides it (proxy agents), an agent carrying `kProxyConfig`
(`HTTP_PROXY`; inert by default here since `getOptionValue('--use-env-proxy')` is undefined) — all
keep the vendored path, because being wrong in the permissive direction sends a request meant for
the preview server out to the internet, while being wrong the other way only reproduces today's
honest `EHOSTUNREACH`.

### The seam, and the two seams rejected

`http.js` stays byte-identical. `internal/http-egress.js` wraps `request`/`get` **in place** where
the loader builds the module (`loader.js`'s `httpWithEgressFactory`) — in place because
`module.exports` carries accessors (`globalAgent`, `maxHeaderSize`, `WebSocket`) a copied object
would flatten, and because the vendored `request` stays reachable and unmodified for every
loopback call. An `Agent`/`createConnection` seam was the obvious candidate and is the one to
avoid: `createConnection` is *on the loopback path* (it is how every in-VM client socket is made),
so patching it puts new code in front of the case that must not break, and a socket-level seam
would need an HTTP request *parser* plus a response *serializer* — a second, byte-level
translation of what the object-level transport already does. Sharing one transport was the third
option and is the one taken: `internal/fetch-transport.js` now holds the client extracted from
`https.js` (which becomes the https-shaped shell around it: scheme/port defaults, the no-op
`Agent`, the absent server), so the protocols cannot grow two divergent copies.

### The ceiling is the browser, not the runtime

Plain `http://` egress is issued by a page, so **mixed content** applies and no runtime work can
change it. Per the spec the block is on URLs that are not *potentially trustworthy*, and
`http://localhost`, `127.0.0.0/8` and `::1` are — so an `https://`-served studio can reach an
`http://localhost:*` target but a LAN or public `http://` host is blocked outright (Chrome's
Private Network Access adds further conditions on the localhost case, and COEP `require-corp`
still demands CORP/CORS on the response, as it does for `https`). From a locally served
(`http://localhost:5173`) studio the scheme matches and it simply works — which is also the case
`http://host.vivari.internal:<port>/` was built for: the Fetcher Worker rewrites that host to the
studio's own hostname, and the alias is documented in `http://` form. So the feature ships *and*
the constraint is named: an `http://` failure now carries the mixed-content explanation and the
alias, instead of a bare `ECONNREFUSED`. A protocol **upgrade** cannot ride a fetch at all — no
socket comes back, so `ws`'s handshake would wait forever on a request that "succeeded" — so an
`Upgrade` header or a `CONNECT` method fails with `ERR_VIVARI_UPGRADE_UNSUPPORTED` (this also
closes the same latent hang on the `https`/`wss` side). `ws://` to an in-VM server is untouched:
that is loopback.

### Two bugs the harness found in the extracted transport

Both were latent in `https.js` and only harmless because it served registry hostnames. Its
`buildUrl` stripped a trailing port with `/:\d+$/`, which turns the IPv6 literal `::1` into `:` —
the routing table caught it immediately as `::1` egressing while `net.connect()` happily
connected. `hostOf` now unwraps `[::1]:80`, `::1`, `example.com:80` and `example.com` to the same
bare host, and `buildUrl` re-brackets a literal. Separately, `options.headers` may be a raw list
(flat `[k, v, …]` or pairs, `_http_client.js:354`), and `Object.keys()` over an array yields its
indices — the request would have gone out with headers named `"0"`, `"1"`, `"2"`.

### Gating, and what is unprovable here

`scripts/probe-http-egress.mjs` (new, `npm run probe:http-egress`) drives the real vendored module
graph through `loader.js` over an in-memory syscall stub and a stubbed `__ocfetch`, with a
hand-drained tick queue for the loop: 46 checks, all green. Its centrepiece is the routing table
over 14 destinations — loopback IP/name with a listening and a non-listening port, `127.0.0.0/8`,
`::1`, `0.0.0.0`, `vivari`, `.localhost`, a LAN address, a private-range address, a corporate
mirror by name, a public host, the `host.vivari.internal` alias — where each branch is
cross-checked against an **independent oracle**: a real `net.connect()` to the same destination
through the same binding. The contract asserted is exact agreement, not a hand-written expectation
per row. Alongside: a real `http.createServer()` served over the real net path with the fetcher
asserted untouched (0 calls), the request/`IncomingMessage` translation, the honest failures, and
`https` still working through the refactored transport. `probe-node-registry.mjs` PASS and the
offline tier 9/9 both before and after.

**No kernel-tier run, and no real request.** `packages/vfs/pkg-node` is absent with no
`cargo`/`rustc`/`wasm-pack` and no network, so the Rust→Wasm VFS cannot be built and neither
`npm run verify` nor the Wasm spike tiers can run here. Everything above is host Node driving the
same guest module graph the VM uses. Specifically unverified: whether a real browser blocks or
allows any given `http://` target (the mixed-content and Private Network Access behaviour is
argued from the specs, not observed), the async `__ocfetchAsync` path against the real kernel
scheduler rather than a resolved promise, and a real outbound plain-HTTP request end to end.

## `Bun.Transpiler.scan()` — and the three module clauses the type stripper ate (this change)

The last item the Bun plan left open. `scan()`/`scanImports()` had been made to throw in the
first correctness pass, on grounds that were true when written: they had returned hard-coded
empty arrays, which reads as "this file imports nothing" and is a wrong answer a caller cannot
detect, and the transform behind them is a type stripper, not a parser. The note said "make
real in Phase 5". Phase 5 shipped `Bun.build` and did not come back to it — but it built the
missing half on the way past, so this is mostly wiring: the bundler's dependency walk already
lexes ESM with the vendored `es-module-lexer`, and already finds `require()` with a real JS
lexer that skips strings, comments and regex. Run both over the same type-stripped source,
merge by offset, and source order falls out.

**The interesting part was not the implementation; it was discovering what Bun actually
answers.** Every case was captured from a real binary (1.3.6, d530ed99) rather than read out
of the docs, and the docs would not have got there. `scan()` and `scanImports()` are not the
same scanner with different return shapes — they report *different sets*:

| | `import-statement` | `dynamic-import` | `require-call` | `require-resolve` |
| --- | --- | --- | --- | --- |
| `scan()` | ✅ | ✅ | ❌ | ✅ |
| `scanImports()` | ✅ | ✅ | ✅ | ❌ |

So a CommonJS file whose only dependency is `require("x")` scans as importing **nothing**, and
a file whose only dependency is `require.resolve("x")` scanImports as importing nothing. That
is reproduced rather than smoothed over, for the usual reason: a caller who picked the wrong
method under real Bun should get the same empty answer here, not a sandbox that is quietly
more helpful than production. Also captured and pinned: results are **not** deduplicated, they
are in source order, `exports` **is** sorted by code unit (so `["A","B","a","b"]`, not the
source's order), `import type` contributes nothing while an inline `{ type T, v }` still
reports its module, and a dynamic `import(x)` with a non-literal specifier reports nothing
rather than guessing. 47 cases, byte-for-byte.

Two divergences are written down instead of faked. Real Bun's automatic JSX runtime injects
`react/jsx-runtime` and `react` require-calls into `scanImports()` for a file that uses JSX;
ours emits classic `React.createElement`, which introduces no specifier at all, so they are
absent — emitting them would name a module Vivari would never load. And the scanner is a lexer,
not a parser, so genuinely invalid source can still scan cleanly where Bun raises a
`BuildMessage`.

### The part that was not planned

Pinning `scan()` against a real binary meant the type stripper's output had to parse, and it
turned out that for three ordinary TypeScript constructs it did not. All three are in
`typescript-transform.js`, all three are the same mistake — a rule written for *expressions*
reaching into an `import`/`export` **clause**, which looks like one and is not:

- `import type { T } from "m";` became ` from "m";`. `dropStatement()`'s rule is "a balanced
  `{…}` ends the statement", which is right for an `interface` or `enum` body and wrong for a
  specifier list, which the statement continues past. **`SyntaxError` at load.**
- `import * as ns from "m";` became `import * ;`. The `as`/`satisfies` cast rule ate the
  namespace binding. **`SyntaxError` at load** — every `import * as fs from "fs"` in a `.ts`
  file, one of the most ordinary lines in TypeScript.
- `export { a, b as c };` became `export { a, b };`. Same rule, and the worst outcome of the
  three: the rename is silently dropped, the importer receives `undefined`, and the process
  **exits 0**. Nothing anywhere says a thing.

An `import` declaration, and an `export` before `{` or `*`, are now copied through verbatim —
nothing inside a module clause is ever a type. `export default …` and `export const x = y as T`
are ordinary code and still get stripped.

**Why this survived.** These only bite files the loader itself compiles: in a Vite or Next
project the bundler transpiles TS, so the templates never exercised it. And the check that
covered type-only imports had asserted the *type names were absent* with a regex — a statement
stripped down to a dangling ` from "./foo";` satisfies that perfectly. It passed for as long as
it existed. The replacement asserts the output **parses**, and the kernel tier runs the file:
the namespace import loads, and the renamed export arrives as `2` rather than `undefined`.
That is the general rule now in AGENTS.md — a string assertion cannot see a load failure.

## The package-manager gate was green because it was not running (this change)

The `pm-gate` job landed with the 15 spike registrations, on the argument that the North Star
deserved a tier that could go red. It never had. On its first real execution — a nightly that
had not yet fired, so nobody had watched one — it fails four of eight, and the four that pass
are worse news than the four that fail.

**The four failures are the job's own build step.** It built only the VFS, under a comment
asserting that was all the PM spikes need: "they drive the kernel, not codec/crypto." A package
manager is a crypto and compression workload before it is a filesystem one. npm checks every
tarball against its `sha512` integrity, and `bindings/crypto.js` only has JS cores for
md5/sha1/sha256, so the first dependency dies with `FETCH_ERROR … digest 'sha512' needs the
wasm codec`. Drop the codec crate instead and pnpm gets one step further before
`ERR_PNPM_TARBALL_EXTRACT … zlib wasm codec is not available` — a registry tarball is a `.tgz`.
The job now builds all three, same as `verify`.

**The four passes are the real defect.** Each `-studio` spike finished in under a second. They
were written to be hand-run, so the install is opt-in behind `VV_NET=1` — and `installOk` is
initialised to `true`, so skipping the gate does not skip it, it **passes** it. `spike-npm.mjs`
hides its whole PHASE 2 (lifecycle scripts, the node-gyp stub, `.bin` shims, `npm exec`, an
`npm ci` reinstall) behind `VV_PHASE2=1` the same way — ground the registration comment already
claimed the spike covered. The runner prints a spike's stdout only when it fails, so the
`(install gate skipped)` line was never once displayed. A tier had been built that checked
`npm --version` and reported the North Star healthy.

Registry entries take an `env` now, and the tier sets the flags. Nothing in the product needed
fixing: with the crates built and the gates switched on, all eight pass, PHASE 2 included. That
is the point — the capability worked the whole time, and the gate could not have told us.

**The lesson, and it is the third time.** A skipped assertion that leaves its flag `true` is not
a gap in coverage, it is a false report, and it is indistinguishable from a pass at the tier
above. `toWeb` shipped twice behind a test pinned to the broken behaviour; this shipped behind a
test that did not run. AGENTS.md already says a string assertion cannot see a load failure. The
companion: an ok-flag must start `false`, or a skip must be reported as a skip.

## Authenticated egress went out anonymous — the header strip was never scoped (this change)

The Fetcher Worker dropped every non-CORS-safelisted request header before calling the
browser's `fetch()`. That is the right move for `registry.npmjs.org`, which answers the GET
with `Access-Control-Allow-Origin: *` but does not answer a preflight, so npm's
`npm-session`/`pacote-*`/`authorization` headers would have blocked every install. It was
applied to **every host**, and there the cost was not a blocked request — it was a wrong one.

A SigV4-signed S3 request loses `Authorization` and every `x-amz-*` on that path, which does not
fail: it goes out **anonymous**. Against a public bucket AWS answers `200`, and since `Range` is
not safelisted either, it answers with the *whole object* instead of the hundred bytes asked for.
The caller gets success and the wrong bytes. Every `Bearer` API had the same shape.

`scripts/probe-s3-cors.mjs` is the demonstration, and it needs no credentials: sign with a bogus
key against a public bucket and let AWS say which happened. Headless, the full header set
survives and AWS rejects the key — `InvalidAccessKeyId`. Under the browser's policy the same
request returns `200` and 2,159,575 bytes.

The strip is now scoped to the package registries (`packages/runtime/egress-header-policy.js`);
everything else keeps its headers, pays for a preflight, and either works — an S3 bucket with a
CORS policy allowing `authorization` and `x-amz-*` — or fails loudly.

**The part worth remembering is why this survived.** Node has no CORS, and the headless fetchers
under `scripts/spike-*.mjs` deliberately forward every header, so the browser path and the tested
path were never the same path. A green spike said nothing about a tab, and the divergence was
documented as a footnote rather than treated as a hole. The policy is now one shared module
asserted as pure logic by `npm run probe:egress-headers` in `toolchain-gate` — because the only
test that can catch this is one that does not need a browser to run.
## Nine Bun templates — and the seven gaps that writing them exposed (this change)

The studio's Bun tab had four templates, and all four were the same program: a
`Bun.serve` HTTP server, varied by routing, WebSockets or React. Everything the shim
had gained over the previous phases — `bun:test`, `bun:sqlite`, `Bun.build`, `Bun.$`,
the hashes, the config parsers, `Bun.Transpiler` — was invisible from the picker. So
five templates were added: **test** (the `bun:test` runner), **SQLite** (a CRUD API
over a real database file on the VFS), **shell** (`Bun.$`), **bundler** (`Bun.build`)
and **API tour**.

Writing them was the point. A few hundred lines of ordinary TypeScript, of the kind a
user would actually type, found **seven** defects that every existing spike was green
through — because the spikes were written against the code paths their authors already
had in mind:

1. **`import { $ } from "bun"` did not resolve.** The bare specifier was never
   registered, only `bun:test`/`bun:jsc`/`bun:ffi`/`bun:sqlite` — so the form Bun's own
   documentation uses failed with `Cannot find module 'bun'` while the identical `Bun.$`
   global worked. Checked against a real binary, that module is the `Bun` global itself:
   same key set, same object per key, no default export. It is now assigned, not curated,
   so it cannot drift as members are added.
2. **Annotations inside arrow bodies were never stripped.** A `{` following `=>` was
   classified as an object literal, so `describe("x", () => { let c: Cart; })` kept its
   `: Cart` and failed to parse. Inside a `function` body or a bare block it worked
   perfectly — the broken case was the one modern code is written in.
3. **Object types nested in angle brackets broke two different ways.**
   `as Array<{ detail: string }>` left the tail `}>;` behind as live code, and
   `new Map<string, { v: number }>()` was not recognised as type arguments at all.
4. **`semver.satisfies(…)` was eaten.** `as`/`satisfies` were treated as cast keywords
   after any token including a `.`, so a method with either name lost its call — and
   `satisfies` is the name of an API this runtime ships.
5. **Top-level `await` failed in a file with no import or export.** ESM-ness is decided
   by syntax, so such a file took the CJS path, got a non-async wrapper, and died with
   "await is only valid in async functions and the top level bodies of modules". The ESM
   path had had an AsyncFunction retry for exactly this since forever; CJS just never got
   one. A genuine syntax error still reports as itself.
6. **`Bun.stdin.text()` did not exist**, so the one-liner every piped Bun script opens
   with was unavailable. The old note said `.text()` could not be made to block — it
   never had to; Bun's returns a Promise too. The readers are attached to the existing
   Node stream, so `.on("data")` is untouched.
7. **`Bun.$` ran eagerly.** It called `exec()` and *then* attached `.quiet()`/`.nothrow()`,
   which worked only because both flags happen to be read later. `.env()`/`.cwd()` are read
   at spawn time, so under that design they could not have worked at all — which is why
   they were simply missing. The ShellPromise is lazy now, and `.throws()`, `.lines()`,
   `.bytes()`, `.blob()` and `.arrayBuffer()` came with it.
8. **Reading the output did not stop it being echoed.** Found by running the finished
   templates in a browser rather than in the spike: every `.text()` in a script printed
   the raw output and then printed whatever the script made of it, so the shell template
   said `package.json / script.ts / …` and then `files here: package.json, script.ts, …`.
   Bun treats reading as capturing — `await $`ls`.text()` prints nothing — and the
   passthrough is what `.quiet()` is for on a command you are NOT reading. The spike was
   structurally unable to see this: it greps the whole of captured stdout for the
   PROCESSED line, and an extra copy of the raw one is invisible to that. The check now
   asserts the raw form is ABSENT, and was confirmed to go red with the fix reverted.

**The templates are now gated on running.** `scripts/spike-bun-templates.mjs` reads each
Bun template's real file map and manifest out of `templates.ts` and runs the manifest's
own `dev` command in the kernel — servers get their routes fetched, terminal templates get
their output asserted. Nothing like it existed, which is why all four original templates
had sat at `experimental: true` with no mechanism able to graduate them; all nine are now
stable. The Bun *category* is the input rather than a list inside the spike, so a template
added to that tab cannot skip the gate, and one with no expectation fails rather than
passing untested.

That spike also replaced `scripts/lib/python-templates.mjs` (a misnomer — it was never
Python-specific) with `shipped-templates.mjs`, which simply `import`s `templates.ts` and
lets Node 22 strip the types. The 160 lines of scanner it deletes could only see inline
string literals, so any file built by a helper came back skipped or still holding its
unevaluated `${…}` source.

---

## Update: a Vite dev-server ping was holding every guest's event loop open

The hang that three Bun templates showed — print everything, then never return the
prompt — was never about Bun. It was the studio's own dev server.

A Process Worker's globals are shared with whatever else the host page put in that
worker, and the runtime installs the guest's timers on exactly those globals
(`globalThis.setInterval = loop.setInterval`). Vite's HMR client runs in that worker
and, from its async `connect`, arms a 30s keepalive ping. That ping became a **ref'd
handle in the guest's event loop**, `hasRefWork()` was true forever, and no guest
that merely finished could exit. Servers were unaffected (they stay up anyway), and
so was anything calling `process.exit()` — npm does — which is why only the plain
scripts hung, and why production, with no HMR client, never showed it.

**The fix.** An interval whose creation stack names `/@vite/client` is created
unref'd. Matching a frame is narrow on purpose: the general rule — only the guest, or
the runtime acting for it, may hold the loop — cannot be read off a stack safely,
because a production bundle has no distinguishable paths and a path-based rule would
unref handles that must stay ref'd, the esbuild keepalive among them. Defaulting to
ref'd and naming the one known host frame keeps the failure mode conservative.
Alongside it, `loop.disownExistingHandles()` runs immediately before the guest's
entry: nothing registered before the guest's first line can belong to the guest.

**Three rounds, and what each cost.** This is worth recording, because the pattern
was the same each time: a theory outran the evidence.

1. *The dropped pre-ready delivery.* Diagnosed from the first `__vv.diag()` paste,
   and a real latent bug — a one-shot kernel delivery arriving before `control`
   exists was silently discarded, stranding any pipeline whose writer finished before
   the reader booted. Fixed and kept. It was not this hang; `stdin: 0` on the parked
   reader ruled it out as soon as the liveness breakdown existed.
2. *Vite's ping, guessed then wrongly retracted.* The breakdown showed one ref'd
   `30000ms` interval in every process, including an idle root shell. Vite's client
   pings at `3e4`, which matched — but reading Vite's source seemed to exonerate it,
   since Vite prepends `/@vite/env` to module workers and that file arms no timer.
   The client is loaded there regardless. A fix built on the guess (disown before the
   entry) also missed, because the ping is armed *after* the entry starts.
3. *The creation stack.* `timerDetail.createdAt` named `Object.connect` at
   `/@vite/client:435` and ended the argument in one paste.

The count named a category, the period named a suspect, and only the stack named the
culprit. Each round the diagnostic got more specific and the theory got less
confident — that is the right direction, and it should have been taken sooner.

**Testing this one honestly.** `spike-diag-liveness.mjs` arms the ping **mid-run,
from a `/@vite/client` frame** (via `sourceURL`) under
`VV_SIMULATE_DEV_HMR_PING=1`. Both details are load-bearing: an earlier seam armed it
in `onReady`, and the before-entry fix passed against that while the browser stayed
broken. The check now fails without the fix. Note what this means about our tiers —
no Node harness has a Vite dev server, so this class of bug is invisible to all of
them until the browser is simulated deliberately.

**A trap found on the way.** Reading `process.env` inside a Process Worker after boot
reads the **guest's** env, because `bootProcess` replaces `globalThis.process`. Three
test seams in a row silently did nothing before that was spotted. Snapshot the real
env at module load instead.

## An upload could not reach an in-VM server: the request body had no binary path (this change)

Every request body that entered the VM went through `JSON.stringify`. Nothing was written down
about bytes, so bytes were whatever survived the encoding — and two different things went wrong,
neither of which produced an error message.

The Service Worker read the incoming request with `.text()`. That UTF-8-decodes, so a PNG, a zip
or a tarball arrived as replacement characters: the wrong bytes, the right length, no complaint. It
now reads the bytes and hands them over untouched — transferred rather than copied, so a large
upload is not duplicated on its way to the kernel worker.
Driving the kernel directly with a `Buffer` was worse. The inbox crosses to the process worker as
JSON, the Buffer serialised to `{type:'Buffer',data:[…]}`, the guest handed that to `creq.end()`,
and the request never completed. Not a rejection, not a 500 — a hang, forever.

Past 1 MiB it stopped being silent and became fatal. The inbox rides the syscall window, and
`respondOk` did `proc.data.set(bytes, 0)` with no bounds check, so an upload larger than the frame
took the whole kernel down with `RangeError: offset is out of bounds` thrown from inside
`Uint8Array.set` — a stack naming neither the syscall nor the size. Uploading an ordinary phone
photo was enough to do it.

The fix is that the request direction now says what the response direction has said all along:
small bodies cross inline as `{body, bodyEncoding:'base64'}`, and anything that will not fit the
frame spills through the VFS — the same escape hatch fetch bodies already use — for the guest to
read back with plain `fs`. `respondOk` now refuses an oversized payload with a message that names
the size and the limit, so the next thing to forget this fails legibly instead of crashing.

**Why it lasted.** Every HTTP spike drove the kernel with `body: ""`. The preview was exercised by
loading pages, never by uploading a file, so the direction that carried bytes into the VM was the
one direction nothing tested. `spike-http-binary-body` now runs offline on every push: PNG and
JPEG magic, deliberately invalid UTF-8, 64 KB of random, and 2 MB / 3 MB / 12 MB past the window —
each checked by SHA-256 against what was sent, with a deadline on every request so a regression to
the hang shows up as a failure rather than a hung job.

## An S3 template that makes you type your own keys (this change)

A backend template for Amazon S3: connect with an access key and secret, list a bucket, upload
(multipart past 5 MB), download, presign and delete. `packages/studio/src/vv/s3-app-source.js`,
registered as the `s3` template and gated by `scripts/spike-s3.mjs`.

The credentials are typed into the page and held in the Node process's memory — never written to
the VFS, never echoed back (the session endpoint returns a masked key, and the spike asserts the
secret appears nowhere in the response). They live as long as the process does. That is the honest
shape for something running entirely on the user's machine: there is no server to keep a secret
on, so the app does not pretend to keep one.

**What the gate is actually worth.** The spike does not mock the SDK — it boots an in-VM S3 that
recomputes the SigV4 signature from the request it received and answers 403 `SignatureDoesNotMatch`
on a mismatch, so a wrong secret is a gated negative control rather than an untested path. The
12 MB upload really does cross `lib-storage`'s part boundary and get reassembled server-side, and
the download is compared byte for byte against what went up.

**Two defects surfaced while building it**, both fixed ahead of this change rather than papered
over in the app: signed requests lost `Authorization` and every `x-amz-*` header in a browser tab
(the CORS strip was never scoped), and a binary upload could not reach an in-VM server at all —
it hung under 1 MiB and killed the kernel above it. An example app is a good way to find these
because it is the first thing to use the platform the way a user does, end to end, instead of one
subsystem at a time.

**Where this genuinely runs, and where it does not.** Reaching real S3 from a tab needs a CORS
policy on the bucket that allows the origin plus the `authorization` and `x-amz-*` headers; the
page says so and the README repeats it, because it is the first thing everyone hits. And like
every other template spike, `s3` sits in the `spikes-net` tier — scheduled, and
`continue-on-error: true` — so it is a signal, not a merge blocker. The parts that could regress
silently are gated where it counts: the header policy by `probe:egress-headers` in
`toolchain-gate`, and binary request bodies by `spike-http-binary-body` in `verify`.
## The terminal called a working server a stuck download (this change)

An S3 app finished installing, bound :3000 and started serving. The terminal showed
`⠴ fetching · 222 requests · 38.7 MB`, climbing, forever — and then reported that the process
"has printed nothing for 75s. It may just be slow — a first install downloads and writes a lot."
The install had finished a minute earlier in ten seconds. Nothing was wrong, and everything on
screen said something was.

Two separate guesses, both wrong about the same thing: a program that goes quiet because it is
healthy.

The fetch spinner kept one counter per terminal for the terminal's whole life. It was written for
an install — hundreds of fetches, almost no stdout — and it cleared when the shell printed. But
clearing only hid the line; the totals stayed. So every request the app itself made afterwards was
added to the install's numbers and redrawn under the word "fetching". The 222 requests and 38.7 MB
were the user's own S3 traffic, presented as dependencies still coming down. Worse, the line is
drawn with `\r` and only ever removed by the next print — and a server has nothing left to print,
so the last frame sat there looking frozen. The counters now reset when the spinner clears, and an
idle sweep removes the line once the traffic stops, so the indicator ends when the activity does.

That left a smaller version of the same mistake: a single click in the preview made one request and
flashed a spinner for a second and a half. The line answers "is this frozen?", and one request never
raises the question, so it is only drawn once a burst reaches three requests AND has run for 800ms —
an install crosses both immediately, a button does not. Bursts that stay under the bar reset when
they go quiet, or six clicks a few seconds apart would eventually add up to a spinner for a click
that fetched once.

The stall reporter had three verdicts: growing filesystem ("still working"), no syscalls at all
("looks stuck"), and everything else. A serving process fits none of them, so it fell to the
catch-all, which talks about first installs.

The first attempt at this only half worked: it described a port-holder as a server *if it was still
making syscalls*, which an idle one is not. The report came back unchanged. The honest position is
that an idle server and a wedged server are indistinguishable from the kernel — both hold a port,
print nothing and make no syscalls — and the only thing that separates them is whether anyone is
waiting. So a serving process (and the shell blocked waiting on it, hence its ancestors) is not
reported at all, unless requests are pending against it, and then the report is the useful one:
"listening on :3000 with 3 requests waiting and no syscall for 30s — it looks stuck inside a
handler."

"It IS still working" also got a floor. It fired on any growth at all, so a server that touched one
file was told the filesystem gained 1 file and that "a first install writes tens of thousands".

**This half of the kernel worker only runs in a browser**, which is why it drifted this far without
anyone noticing. The judgements are now pure functions in `packages/core/terminal-feedback.js`,
asserted by `npm run probe:terminal-feedback` in `toolchain-gate` — including the exact sequence
that produced the bad output: install 104 packages, print, then serve, and check the app's first
request reports one request rather than a hundred and five.

## `pip install` that survives the process that ran it (this change)

`pip install X` printed `Installed: X`, and by the next command X was gone. Every `python`
command is a fresh Pyodide boot, so the install was true of an interpreter that had already
exited. The last change could only make that honest — it added a paragraph of stderr
explaining that the thing you just did had not happened. This one makes it true instead, and
deletes the paragraph.

**A store, not a warm interpreter.** The tempting fix is to keep one interpreter alive across
commands, and it is the wrong one twice over: measured, a second `loadPyodide()` in the same
realm is no cheaper than the first (1406 ms vs 1550 ms), so it would buy nothing without also
keeping a *process* alive across commands — a change to the process model, for one language of
several. The cheap fix is to move the bytes, not the interpreter. `pip` walks site-packages
before and after the install and writes the **delta** to
`<project>/.venv/lib/python3.14/site-packages`; every later interpreter copies it back before
user code runs. Measured against real wheels: **4 ms out, 37 ms in for 357 KB, against a
~1400 ms boot**. The alternative — record the install list and replay it — costs ~300 ms per
process even with the wheel already cached, so the byte snapshot is both simpler and faster.

And it gives `.venv` a meaning. `python -m venv .venv` was `No module named venv`; it is now
the command that creates the store, which is the one `-m` module that would be meaningless
without it. `pip list`/`freeze`/`show`/`uninstall`/`check` read `importlib.metadata` out of the
restored store.

**Three ways this could have been 95% right, and what stops each.**

*Half a store is worse than none.* A store built by an older Pyodide, restored into a newer
one, gives a site-packages where some of a package is the old build and the rest is missing —
which fails at an unrelated import, far from the cause. So the store carries a stamp (Python
version, Pyodide version, format number) and a mismatch discards it **entirely**, with a
message naming both versions and the one command that rebuilds it. The same reasoning drove
the size cap inside `persistDelta()` rather than beside it: over the cap it returns having
written nothing, so "too big changes nothing" is a property of one function instead of the
order two callers happen to do things in. And it exits non-zero — the packages are in an
interpreter about to exit, so `pip install X && python main.py` must not walk into an
ImportError with a success message above it.

*`.venv` is not a virtualenv, and saying so is part of the feature.* There is one interpreter
per process and no isolation available. `pyvenv.cfg` therefore says
`include-system-site-packages = true`, because that is simply true, and both the file and the
docs say in prose that this is a package store with no `bin/activate` and nothing to
deactivate. Two projects get two stores — the part of a virtualenv people actually want — and
there is no second Python to switch between. `.venv` also stays in `SKIP_DIRS`: the store has
to land at the *interpreter's* site-packages path, not at `<cwd>/.venv` where no import would
look. That looks like the bug and is the fix, so it is commented as such in three places.

*`pip freeze` that is almost `name==version` is worse than no `pip freeze`* — it fails later,
somewhere else, in a file someone committed. So the formatters are pure functions over dist
metadata, and `spike-python-offline.mjs` asserts them byte-for-byte against **real pip run on
the machine doing the check** — dist-info directories synthesised on disk, `pip list --path`
over them, no network. That is not ceremony: it caught a real bug that reading the code did
not. An install escapes the project name before naming the directory (PEP 427), so
`charset-normalizer` lands in `charset_normalizer-3.4.7.dist-info`. The store decided
membership by rebuilding `${name}-${version}.dist-info`, which matches nothing for a dashed
name — a `pip freeze` that silently omitted four of `requests`' five dependencies. The
interpreter now reports the directory it actually found. The bridge tier installs a dashed
package on purpose so the regression cannot come back.

**The gate.** The offline tier runs the shipped store functions against a stubbed interpreter —
Pyodide's FS is a handful of calls — so restore, discard-on-mismatch and the transactional cap
gate every PR. The bridge tier boots **six real interpreters in one run** and keeps the stub
honest: install into A, restore into B, and an unrestored C that still has nothing; a stamp
rewritten to an older Python that copies in zero files; a real install refused by a
deliberately 1 KB cap with the store byte-for-byte unchanged afterwards; and `pip freeze`
checked against the store's own directory listing as the oracle rather than against itself.
## 59 template files, and nothing checked that any of them parsed (this change)

The S3 template shipped a `SyntaxError`. Not a subtle one — the app died on boot, on the
first line the user would ever run, with `Unexpected token 'const'` pointing at a statement
that was perfectly fine. Its own spike was green the whole time.

The bug is a property of *how* templates are stored rather than of anything in the template.
Template source lives inside template literals in `templates.ts`, and a backslash there
belongs to the outer literal first. `/^https?:\/\//i` is a correct regex in the file you are
reading and arrives in the generated project as `/^https?:///i`, where `//` opens a comment,
the `if` never closes its paren, and the error surfaces two lines later. Nothing warns: the
TypeScript compiles, the file is valid, and the damage happens at string-interpolation time.

*The gate that existed was in the tier that gates nothing.* `spike-s3.mjs` drives the real app
against an in-VM S3 with byte-exact SigV4 — a genuinely strong proof — and it lives in
`spikes-net`, which is schedule-only and `continue-on-error: true`. Strength of a check and
whether the check can block a merge are unrelated properties, and it is easy to buy the first
and assume the second. Meanwhile 75 templates carried 59 JavaScript files and 98 JSON files,
and no job anywhere asked whether they parsed.

`spike-template-syntax.mjs` asks only that. It writes each template to a temp dir — whole,
including its `package.json`, so `node --check` resolves the module goal the same way the
guest will, ESM or CJS by `"type"` and extension rather than by guess — and checks every
`.js`/`.mjs`/`.cjs` file, `JSON.parse`s every `.json`, and verifies each manifest's `entry`
is a file the template actually ships. No kernel, no Wasm, no network, about a second for
all 75, so it sits in the unfiltered offline tier and runs on every push. It is deliberately
not a linter or a type-checker: it answers the cheapest question, the one that is most
embarrassing to get wrong.

*Both directions were verified, not assumed.* Re-introducing the original regex turns the gate
red with the exact production error (`s3 src/server.js — SyntaxError: Unexpected token
'const'`); pointing a manifest at a file that does not exist turns it red too; the tree as
shipped is 75/75 green. TypeScript and JSX are explicitly out of scope, and the code says so
where a future reader would otherwise "fix" it — `node --check` does not strip types, so it
rejects every valid `.ts` file, and checking those needs a real parser and a heavier gate.

The spike also asserts its own registration with `net: false`. That guard is not paranoia:
this repo has now shipped three separate checks that ran in no job at all — a `needsWasm`
offline spike skipped in the only job that selected it, `probe:node-registry` written and
never wired, and the PM gate building one crate of the three it needed. A gate that can fall
out of the pipeline silently is a gate that eventually will.

## Four Bun APIs, and the one that turned out not to exist at all (this change)

An audit of the `Bun` global against Bun's own API index — rather than against our plan, which
is the mistake the last few rounds kept making — found nine entries missing outright. Four
looked cheap. This change ships three of them for real, and the fourth is the interesting one.

**`Bun.sha` is SHA-2 512/256, not SHA-512.** Working from the name, or from memory, gives a
digest that is wrong in the way that costs the most: it *looks* right — 32 bytes, hex, stable —
and disagrees with every other Bun runtime and with `openssl sha512-256`. The algorithm was
read off Bun's reference before a line was written, and it is pinned in both tiers to NIST FIPS
180-4's worked example rather than to our own output, which would pass against any
self-consistent wrong answer. `sha512-256` was already in the Rust crate and the hasher's
algorithm table, so the implementation is one call; the research was the work.

**`Bun.CSRF` signs with HMAC over primitives we already had.** Two decisions are written into
the code rather than left implicit. The session binding goes through the MAC, not the payload,
so a token cannot be re-pointed at another principal, and — because `""` is a distinct input —
a token minted without a `sessionId` fails when one is supplied, which is what Bun documents
and what a security test would check. And the token format is OURS: Bun does not document its
wire layout, so a token minted here will not verify on a real Bun server. Invisible in one
runtime, fatal across two, therefore stated in the docs instead of discovered in production.

Two bugs came out of writing the tests, both of which self-verify and so survive any test that
only round-trips a token against itself:

- **The defaults were the head of each allowed list** — `blake2b256` and `base64`, where Bun
  specifies `sha256` and `base64url`. `generate` and `verify` agreed with each other perfectly.
  Only naming the expected default explicitly catches this, so the gate now does.
- **The expiry windows were inclusive.** `expiresIn: 0` produced a token that verified for
  exactly as long as the clock took to tick, making "an expired token is rejected" a test that
  passes or fails on machine speed. Both windows are half-open now, so 0 means 0.

**`Bun.dns` is deliberately not all-or-nothing.** `lookup` cannot work — the browser resolves
names inside `fetch()` and never hands the answer back, which is a platform privacy boundary
rather than a missing shim — so it throws and points at DNS-over-HTTPS. But `prefetch` is
ADVISORY: Bun's own example is a database driver warming a host at startup, it returns `void`,
and callers do not guard it. Throwing there would take an app down over a hint it never needed,
so it is an honest no-op and `getCacheStats` reports a cache that genuinely holds nothing.
Warming DNS with a speculative `fetch` was considered and rejected — it sends real traffic to a
host the caller only said they might contact.

**The fourth was not cheap, and the reason is a defect we had shipped.** `Bun.zstd*` was
supposed to be a thin re-export, because `node:zlib` already exports the whole zstd family.
Probing it in the VM instead of reading the exports showed why that was wrong:

```
zstd   THREW: binding.ZstdCompress is not a constructor
brotli THREW: binding.BrotliEncoder is not a constructor
gzip   OK -> 28 bytes
```

There is no zstd engine, and no brotli engine either: `packages/codec` is built on flate2,
which does deflate and gzip. The binding's own comment claimed "brotli/zstd are present so
lib/zlib.js's module-level range asserts pass, but their handles throw" — the handles did not
exist, so the throw was a `TypeError` from inside Node's own source, naming a class the caller
never heard of. Meanwhile `zlib.brotliCompressSync` is a real exported function, so every
`typeof zlib.brotliCompressSync === "function"` guard in the ecosystem takes the brotli branch
and dies there. The comment described the intent; nothing implemented it.

So the fourth item ships as honesty rather than capability, which is Phase 6's pattern applied
one layer down: `Bun.zstd*` and the four zlib handles now throw a sentence naming the missing
engine, the file it would live in, and the codec that does work. "Not implemented" rather than
"not supported", deliberately — neither format is browser-hostile, and closing the gap means
adding a crate to `packages/codec` and rebuilding the Wasm, not writing JavaScript.

**The gate.** The offline tier gets the semantics (the NIST vector, every CSRF rejection path,
the dns shape, both message wordings) plus the zlib handles, which are pure JS and throw before
touching wasm. The kernel tier gets the two things offline structurally cannot: digests from
the Rust/Wasm codec rather than the host's OpenSSL, and `blake2b256` — which Bun allows for
CSRF and which OpenSSL does not know under that name, so the offline tier cannot exercise it at
all.

**Still uncovered, and now written down:** `HTMLRewriter`, `new Worker()`, `Bun.markdown`,
`Bun.Image`, the `Bun.SQL` SQLite adapter, and real zstd/brotli engines. `new Worker()` is the
one to look at next and is not merely absent: the runtime replaces `WebSocket` and `fetch` on
the worker's shared `globalThis` but never touches `Worker`, so guest code calling
`new Worker("./w.ts")` gets the HOST page's constructor, resolves the specifier against the
Studio's origin instead of the VFS, and builds a worker with no kernel and no filesystem. Node
has no global `Worker`, so no Node-tier spike can see it — the same blind spot that hid the
Vite timer.
## `python -m` stops being an allowlist, and served apps stop losing their files (this change)

Two defects, both of which read to a user as "Python here is a toy".

**`python -m` knew six modules.** Anything else got *"running arbitrary modules is not
supported in the Vivari shim yet"* — a sentence that describes a `switch` statement, not an
interpreter. The interpreter had `unittest` loaded the whole time. That is the worst shape a
limitation can take: a dispatch gap wearing a capability gap's clothes, so the honest-sounding
message is the lie. `runModule()` now hands the name to CPython's `runpy._run_module_as_main`,
which means module resolution, the `sys.argv` contract and the failure text are CPython's
rather than ours. `python -m unittest discover` runs the tests in a mirrored project and exits
non-zero when they fail; `python -m json.tool`, `python -m calendar`, `python -m base64` work
because nothing is stopping them any more.

A module is intercepted only where runpy cannot reach what it needs — the package store
(`pip`, `venv`), the WSGI/ASGI bridge (`uvicorn`, `flask`, `gunicorn`), the exit-code seam
(`pytest`), a socket (`http.server`). Seven more are refused by name, and the reason is worth
stating because the trap is not the obvious one: Pyodide **has** a `socket` module, and
`connect()`, `bind()` and `listen()` on it all succeed. `smtplib` would print its banner, look
like it had started, and wait forever. A refusal that says "this is an SMTP client, and sending
mail needs a TCP socket" costs a user a minute; a hang costs an afternoon. The bridge spike
proves the premise rather than asserting it — it connects to a real host, sends, and times out
on the `recv`.

Missing modules now get CPython's own error, which turned up a detail worth keeping: runpy
formats failures as `"%s: %s" % (sys.executable, exc)`, and `sys.executable` in Pyodide is the
host path of whatever booted the interpreter. `python -m nosuchthing` would have reported
`/app/node_modules/…/kernel.mjs: No module named nosuchthing`, which is both wrong and a leak.
Setting it to `python` at boot makes the message the one CPython prints, and both spikes hold
it against the CPython on the machine running them.

**`python -m http.server` runs the stdlib's own handler.** Writing a static server is an
afternoon; getting its directory listings, MIME table, 301-on-missing-slash and `Range`
handling to match CPython's is not, and every divergence is a bug report. `SimpleHTTPRequestHandler`
only ever touches its socket through `makefile()` and `sendall()`, so it is given a `BytesIO`
of the request and a `bytearray` to write into, and the guest-Node bridge that already serves
Flask carries the bytes. What is shipped is CPython's server, not an impression of it.

**A served app's writes went nowhere.** `serve()` mirrored the project in and never back, so a
Flask app's uploads and its SQLite database died with the process — silently, which is the
part that makes it a data-loss bug rather than a missing feature. Shutdown-only persistence
would not have fixed it: closing the tab *is* how a preview normally ends. Writes land at the
end of each request instead. That boundary is not a compromise, it is the only complete one —
the handler has returned, and Pyodide has no threads, so nothing is mid-write. It is off the
response path and free when a request wrote nothing. `mirrorBack()` still runs on close as a
reconciling pass, so a tracking miss costs a delay rather than the data.

Getting there meant replacing the change detector. The old walk skipped any file whose size
matched the snapshot, which drops every same-size rewrite — a fixed-width record, a counter
that did not change digits — and there is no mtime resolution that rescues it inside one
millisecond. Emscripten's `FS.trackingDelegate` reports the writes instead, and the deletes
matter as much as the writes: sqlite3 removes its journal on commit, so copying the journal
out and never removing it leaves a hot journal beside a committed database and the next
process rolls the committed work back. Mid-transaction is the case that looks alarming and is
not — an open transaction has its journal on disk, so a copy taken then carries its own
rollback and recovers. `.venv` is excluded in both directions, and the exclusion is re-checked
against the tracker rather than only the walk, since the tracker reports paths the inbound walk
never descended into: the package store owns that directory, and a second writer would copy
every wheel out again and could leave a half-written store looking valid to the next boot.

**The gate.** The offline tier is where this has to bite, since it is what runs per PR: the
dispatch table, the argv contract, the refusal reasons scraped from the shipped table rather
than copied, and the mirroring driven against a stand-in FS — including a served app whose
file is asserted present on the host *while the server is still running*, which is the bug
stated as a test. `-m` failures are held against the real CPython on the host, the way
`lib/cpython-exit.mjs` already does. The bridge tier supplies what a stand-in cannot: real
`unittest` discovery over a mirrored tree, the stdlib's real 404 and real listing, a real
SQLite commit, and the tracking hooks firing in real Pyodide — that last one being what stops
the offline mirror gate from being a test of a fiction. Every new assertion was mutation-tested,
which is how the `Connection: close` header turned out to be defended by a comment claiming it
prevented a hang it does not prevent; the header stays, the claim is now what is true.

## Python language support in the editor (jedi + black)

**The gap.** TypeScript files got Monaco's real language service — compiler options,
semantic diagnostics, `setExtraLibs` fed from the VFS. Python files got a file icon.
What a user saw was Monaco's default word-based suggestions: strings scraped out of the
open buffer, which will offer a word from a comment and has never heard of
`requests.get`. In a product whose Python story now includes a package store and a
served-app preview, the editor was the part that had not moved.

**What shipped.** jedi for completion, hover, signature help and go-to-definition; black
for formatting. **Not mypy** — diagnostics are a different problem, needing scheduling
care and third-party stubs before they say anything useful, and the docs are explicit
that type errors have not arrived so nobody reads this as more than it is.

**The lifecycle was the design question, not the libraries.** Pyodide boots per process
and dies with it, which is wrong twice over for an editor feature: a REPL exiting would
take completion down, and a boot would show up in `ps` as a process nobody started. So
the service gets its own interpreter, in a worker the kernel owns and deliberately keeps
out of the process table — no PID, absent from `ps` and `diagnostics()`, unkillable by
the user. It boots on the first language request and not before, and the studio's import
of the provider module is dynamic, so a TypeScript session pays nothing. The status bar
says `Python: starting…` while it happens, because a popup that does nothing for eight
seconds is worse than one that admits it is not ready.

**Completions see what the user thinks they see.** The buffer's unsaved text, the
project's own modules — including a file in a subdirectory importing something top-level,
which is what an explicit project root buys and what jedi's inferred root would miss —
and the per-project `.venv` package store, remapped onto the interpreter's site-packages
the same way `restoreStore()` does it. Someone who runs `pip install tabulate` and gets
no completions for it concludes the feature is broken, so that case is a test.

**Staleness, not queueing.** One interpreter, no threads, and keystrokes outrun it. At
most one in-flight and one waiting request per kind; a newer keystroke replaces the
waiting one and the replaced caller resolves rather than being left pending. Monaco's
token is re-checked when the answer arrives, since it can fire mid-flight.

**Two things had to be found out rather than assumed.** jedi is in Pyodide's lock; black
is not, so it and its closure are vendored from PyPI and pinned — an editor feature that
only works when the network does is not the same feature. And jedi's default environment
discovery *runs* `sys.executable` in a subprocess, which Pyodide refuses with
`OSError(138)`; because the `-m` work sets `sys.executable = "python"`, every request
would have failed at jedi's own entry point. `InterpreterEnvironment` fixes it, and the
bridge tier asserts the default path still fails so the reason stays visible.

**The gate, and the oracle.** Interpreter-free checks run per PR: provider registration,
the request contract, cancellation and supersession, the path mapping, and every failure
path. Those queue assertions are bounded, because the first mutation run revealed that a
queue which stops resolving superseded work would **hang** the spike rather than fail it,
and a CI job that never finishes is worse than one that goes red. The bridge tier runs the
*shipped driver* under real Pyodide and under the host's own CPython with jedi and black
pinned to the same versions, and requires them to agree — two interpreters, one program,
no expectation table written by the same person who wrote the feature. Formatting is
byte-exact on both. Where the two interpreters legitimately differ (CPython 3.11 here
against Pyodide's 3.14) the comparison is scoped to buffer-local and project code, and
stdlib checks assert presence instead. One blind spot needed closing deliberately: since
both sides run the same driver, a change to black's Mode moves both answers together and
they still agree — so the samples are *also* compared against black's own command line,
with no driver in the way, which is the promise the feature actually makes. Every
assertion was mutation-tested; that is how the missing project-root case turned up, since
jedi infers a root from the file path and a fixture with the file at the top level cannot
tell the two apart.

## The Content-Type was believed, so latin-1 came back as question marks (this change)

Fixing the upload direction made the download direction worth reading, and it was the
broken one. Bodies cross the kernel seam as JSON, so binary is base64-encoded and flagged
`bodyEncoding:'base64'`. Deciding *which* bodies were binary is where it went wrong: the
runtime asked the Content-Type, and kept a "fast path" that decoded any declared-textual
response as utf8 without checking whether it was.

A Content-Type is a claim about how to *interpret* bytes. It is not a promise that they are
utf8, and `text/html; charset=iso-8859-1` is explicitly a promise that they are not. Decoding
it as utf8 anyway replaces every high byte with U+FFFD. A latin-1 page, a CSV a spreadsheet
exported, `text/plain` carrying arbitrary bytes — all corrupted, all with a 200 and a body
that looks plausible until someone reads it. The gate now measures the damage: 1,572,864
bytes of latin-1 come back as 4,620,292 bytes of replacement characters, almost three times
the size, which is a useful reminder that "lossy" is not a small word here.

*The second bug was in the decoder nobody was looking at.* `decodeBytes` in
`protocol/syscall.js` ran a stock `TextDecoder`, whose default `ignoreBOM: false` does not
ignore the BOM — it **strips** it. Any body from a BOM-prefixed file, which is whatever
Windows wrote, crossed three bytes shorter than it left. Nothing could have caught it
downstream: every byte was valid utf8, the round-trip check the binary path already ran
passed, and the loss happened after it.

Both are now one rule, in one place: the bytes decide. `bridgeHttp` decodes with `fatal:
true, ignoreBOM: true` and base64s only when that throws. It is a single pass that returns
the string it just validated — cheaper than the round-trip encode-and-compare it replaces,
and it deletes the content-type table entirely rather than fixing it.

*The gate asserts the encoding, not just the bytes.* Byte-exactness alone would be satisfied
by base64-ing everything, which is a silent 33% inflation on every dev-server response, so
`spike-http-response-bytes.mjs` pins the choice per case: 20 bodies across declared-text,
declared-binary, BOM, invalid utf8, lone surrogates, empty, and three payloads over the 1 MiB
window so the multi-frame reassembly has a seam to lose a byte at. Two cases exist to state
the principle in both directions — `application/wasm` whose magic bytes happen to be valid
utf8 crosses as text and skips base64, while the same body with one high byte in it does not.
Reverting each fix separately turns exactly the expected cases red: the BOM pair for one, and
seven latin-1/invalid-utf8 cases for the other.

## `new Worker()`: closing a leak, not filling a gap (this change)

The previous entry ended by naming `new Worker()` as the next thing to look at and predicting
what was wrong with it. That prediction was checked before anything was built, by planting a
sentinel constructor on the process worker's `globalThis` ahead of boot and having guest code
call `new Worker("./w.ts")`: the guest got the sentinel, holding the raw specifier. So the
starting position was confirmed — guest code was reaching the HOST's constructor, which in a
browser resolves against the Studio's origin over HTTP rather than against the VFS. Not a
missing feature; a wrong one.

**The fix has two halves, and they disagree on purpose.** The runtime now deletes the inherited
`Worker` before running the entry, so a `node` guest sees `undefined` exactly as real Node does.
The `bun` launcher then installs Bun's own, because Bun *does* define one. It sits on
node:worker_threads, which was already real here, and each worker boots `/bin/bun.js run <entry>`
rather than the file directly — one indirection that buys the Bun global, Bun's script semantics
and zero-config TypeScript inside the thread without a second implementation to keep in step.

**A message listener is what keeps a worker alive.** Both Bun and Node document it, and the
first version of the worker-side globals attached one eagerly at install so that `onmessage`
would work. Every worker was therefore immortal, and so was every parent waiting on one: a
one-line worker that only printed hung the process. The listener is now wired on first use of
`onmessage` or `addEventListener("message")`. Nothing in the API surface hints at this, which is
why the laziness carries a comment rather than looking like an optimisation.

**Two things that could not be honoured, refused differently.** `preload` throws: the launcher
has no `--preload`, and faking it with a generated wrapper would make the wrapper the entry
module, so `import.meta.main` would be wrong inside the worker — a wrong answer about which file
is running is worse than no answer, and the workaround is one import line. `smol` is ignored: it
sets a JavaScriptCore heap size and nothing observable depends on it. The rule is the same one
`Bun.build` follows for `minify` — refuse what changes behaviour, ignore what cannot.

**A gap found on the way, and left open deliberately.** Bun emits `error` on the Worker when the
worker's own code throws. A relay for that was written first — post the crash over the channel
from a `process.on('uncaughtException')` handler — and it never fired. Measuring rather than
assuming showed why: the guest's `uncaughtException` is never dispatched at all in this runtime,
for any program (an async throw does not even set a non-zero exit code). That is a real defect
worth its own change; it is not this one. The dead relay was removed rather than left looking
load-bearing, and a worker that throws arrives as `close` with a non-zero code, which the docs
now say.

**A flaky assertion from the previous change — fixed on master, not here.** This branch also caught the CSRF spike's tamper check failing about a quarter of the time: it flipped the token's LAST base64url character, whose low bits are surplus in an 86-character token, so the "tampered" value was often byte-identical and verified correctly. A fix landed independently on master (`fe6b042`) while this was open, and it is the better one — it decodes, flips a byte, and then asserts the tamper reached the bytes the MAC covers, so the check can no longer pass for the wrong reason. This branch defers to it; the lesson is in AGENTS.md.

**Still uncovered:** `HTMLRewriter`, `Bun.markdown`, `Bun.Image`, the `Bun.SQL` SQLite adapter,
real zstd/brotli engines, and — newly — the guest's `uncaughtException`, which nothing dispatches.

## Two ways a failing program said it had succeeded (this change)

Both of these were found by measuring, while auditing what was left to do for Bun, and neither
is Bun-specific: they sat in the event loop and the kernel, under every guest.

**An uncaught error exited 0.** `setTimeout(() => { throw new Error("boom") })` printed its stack
and the process reported SUCCESS. The stack was never the problem — it was always there, which is
why this survived so long. The exit code was. A test script, a build step or a CI command that
died in a callback told the shell it had passed, and the shell believed it. The cause was one
line: the loop's `runCallback` caught the error, called `reportError`, and carried on. Nothing
ever emitted `uncaughtException` either, so `process.on('uncaughtException')` was dead for every
program in the VM — which is how a crash relay written against that hook for `new Worker()` came
to be written and never fire.

**An unhandled rejection HUNG.** Worse than a wrong code: `Promise.reject(new Error("x"))` never
exited at all. Guest promises are host promises, so the rejection surfaced on the host realm,
where the handler rethrew it "for default reporting" — into the host's `uncaughtException`
handler, which rethrew again. The guest's loop then had nothing to do, the kernel waited for an
exit that was never coming, and the process sat there for ever.

Both now follow Node's contract, which is not "always exit": a hook, if the guest set one, gets
the error and the process KEEPS RUNNING — that is the point of the hook, and a server that logs
and stays up depends on it. With no hook, the stack is printed and the process exits 1. A
rejection with no `unhandledRejection` hook falls through to `uncaughtException` carrying
`origin: 'unhandledRejection'`, as Node's default `--unhandled-rejections=throw` mode does. The
`process.exit()` sentinel travels the same path and still means "exit with this code", not
"fail" — pinned by a check, because that is the regression this change could most easily cause.

**A guest could kill the kernel.** `Bun.spawn()` with no arguments sent `undefined` as the
command; `resolveProgram` called `.includes()` on it; the TypeError was thrown INSIDE the kernel
and escaped through the worker's message handler. In a browser that is not one process failing,
it is the whole VM — every process, the VFS session, the preview — gone because a guest script
had a typo. Fixed at both layers, deliberately:

- The kernel no longer trusts the field (a non-string command is an ENOENT), and the whole
  syscall dispatch is wrapped so any unanticipated throw becomes an errno to the caller instead
  of a dead kernel. Releasing the caller matters as much as surviving: the guest is parked in
  `Atomics.wait`, so a handler that dies without answering leaves it hung for ever. The guard
  also covers rejections, because the three async handlers (`handleSpawn`, `handleSpawnAsync`,
  `handleFetch`) fail after an `await` — which is exactly how the original crash arrived, as an
  unhandled rejection rather than a catchable throw.
- `Bun.spawn`/`spawnSync` validate the command and throw a `TypeError` synchronously, as real
  Bun does. Before, all four shapes of "no command" appeared to SUCCEED and surfaced an ENOENT
  later, asynchronously, from a child that never existed.

**The gate.** A new offline spike, `scripts/spike-fatal-errors.mjs`, asserts exit codes and
kernel survival rather than stderr text — a check on the stack would have passed against every
one of these bugs. It bounds every case with a timeout and reports a hang as a failure, because a
hang was one of the bugs. Both `bun` and `node` guests are covered, since the loop is shared and
a fix reaching only one of them would be a coincidence.

**A spike that had stopped running, fixed on master instead.** While measuring here, `ci-tiers` turned out to be red on master: `796ed0a` deleted the `http-response-bytes` registration from run-spikes.mjs while adding `studio-types`, so that spike stopped running everywhere while ci.yml still named it — exactly the drift `spike-ci-tiers.mjs` exists to catch. This branch restored the line, and a separate MR (`b6f92a7`) landed the same restoration first, together with a wasm-pack pin; this defers to it. Worth noting for its own sake: the sync that dropped the line changed no behaviour anyone would notice, and the only thing that noticed was the tier-drift check.
## Every login was broken, and nothing reported it (this change)

`express-session`, Passport, a CSRF token, "remember me" — none of it worked, ever. Login
returned 200. The next request arrived with no `Cookie` header at all, the app answered 401,
and no log line anywhere said anything, because from each component's point of view nothing
had gone wrong: the server set a cookie, and the client simply never sent one back.

The client is the problem. On a real machine the browser keeps the jar; here the "client" is a
preview iframe whose requests a Service Worker answers from a server that exists only in
memory, and that seam drops cookies in **both** directions for reasons that are correct in
isolation. Outbound, a `Set-Cookie` on a Response the SW synthesises never enters the cookie
store — the store is filled by network fetches, and this response never touched the network.
Inbound, the browser appends `Cookie` during the network step, which is *after* the Service
Worker, so the SW cannot read the header and cannot forward it. Two reasonable behaviours,
one dead feature.

*The break is provable without a browser, which is why it is now gated.* I expected to need a
real page to confirm any of this and did not: the client side of the seam is whoever calls
`kernel.handleHttpRequest`, so a plain Node script sees exactly what the iframe sees. Two
requests — `/login` then `/me` — reproduce it in a second, and that is the shape the gate took.

**The jar lives in the kernel, one per port.** Per port because that is the granularity the
platform emulates: `localhost:3000` and `localhost:5173` are separate origins with separate
jars on a real machine, and a single shared jar would hand an API's session to a frontend.
The RFC 6265 parts that matter are the ones where being *nearly* right is worse than being
absent — a cookie's identity is (name, path) rather than name, a `Path`-less cookie is scoped
to the *directory* of the request that set it (so `POST /api/login` does not scope a session
to `/`), path-match needs its boundary check or `/foo` leaks to `/foobar`, `Max-Age` beats
`Expires`, and `Max-Age=0` is a delete because that is what `res.clearCookie()` sends. None
of those failures would look like a bug; they would look like someone else's bug.
`Domain`, `Secure`, `SameSite` and `HttpOnly` are parsed and deliberately ignored: one host,
no scheme, no cross-site request, and nothing in this jar is reachable from page JavaScript.

*A second, smaller bug in the same area.* `sw.js` built its response headers with
`new Headers(resp.headers)`, and `Headers` stringifies an array while Node keeps `set-cookie`
as one — so two cookies became a single comma-joined header, and because an
`Expires=Wed, 21 Oct 2026 ...` contains a comma itself, no layer downstream could ever split
them back. It appends entries one at a time now.

**Three gates, because they catch different things.** `probe-cookie-jar.mjs` pins the
semantics as pure functions, and it is the only one that catches `/foo` matching `/foobar` —
mutating path-match to a naive `startsWith` leaves the end-to-end spike green.
`spike-cookie-session.mjs` drives a real in-VM server offline on every push: login, logout,
path scoping, per-port isolation, a base64 value with `=` in it, and cookies alongside a
request body. `spike-session-studio.mjs` installs real `express-session` in the net tier,
because that signs and url-encodes the cookie (`sid=s%3A<id>.<hmac>`) and reads it back
through its own parser — if the jar mangled a `%` or dropped the signature, a hand-written
server would never notice and every real app would.

*One of the gates immediately earned its keep.* The jar's first version merged its cookies
into a `Cookie` header the caller had already set, on the theory that a real browser cookie is
the more authoritative copy and jar-only names should still flow. `spike-bun.mjs` went red:
its `Bun.CookieMap` check hands the server an explicit `Cookie: a=1; b=2` and expects the
handler to see exactly two, and the jar was quietly adding a session left over from an earlier
request in the same run. That is not a test being fussy — it is two simulated clients
contaminating each other. A request that carries its own `Cookie` now owns it and the jar
stays out, which is simpler, predictable for anything driving the kernel, and free on the real
path, where a preview request never arrives with a `Cookie` header at all.

**And a template, so the capability is visible**: "Login & sessions", on real
`express-session`, with `regenerate()` on login against session fixation and a view counter
that proves the same session came back rather than a fresh one per request. Writing it turned
up a bug in itself that no gate would have caught: the counter middleware was mounted *after*
`GET /`, and Express matches in registration order, so it counted nothing. Fixed before it
shipped, and it is a reminder that a template parsing is not a template working — the syntax
gate says nothing about semantics, which is exactly why the studio spike drives the shipped
bytes rather than a copy.

### The first click still 404'd: absolute URLs escape a path-routed preview

The template worked in every gate and failed on the first click in the studio. `POST /login`
went to `http://localhost:5173/login` — the studio's own origin — and 404'd.

Nothing to do with cookies. A preview under path routing lives at `<origin>/preview/<port>/`,
and `action="/login"` is root-absolute, so it resolves against the origin root and never enters
the preview. What makes it a trap rather than an obvious mistake is that the *same* absolute
path works from JavaScript: `fetch('/api/session')` is a subresource, and the SW resolves it
via `routeByClient` from the iframe that issued it. That is why the S3 template, which is all
`fetch`, never hit this. A form POST, a link and a redirect are top-level **navigations**, and
`sw.js` returns early for `mode === "navigate"` deliberately — proxying the studio's own
document once left the page loading forever. So navigations are precisely the URLs a guest must
get right itself, and the platform already hands it what it needs in `x-forwarded-prefix`, the
header the Python bridge reads as `SCRIPT_NAME`/`root_path`.

*Every gate passed because every gate drove the kernel directly*, which puts the app at the
root, where an absolute `/login` happens to be correct. The fix is not only the template's
`base(req)` — it is that `spike-session-studio.mjs` now drives it the way the Service Worker
does, with the prefix header set, and asserts the emitted form actions and redirect
`Location`s stay inside the preview. Reverting the template turns exactly three of those red.
It also checks the no-header case, since a wildcard per-port origin serves at the root and the
empty prefix is right there — a "fix" that hardcoded the prefix would break mode C silently.

*And the syntax gate paid for itself again on the way.* The comment explaining all this went
inside the template's source, which lives in a template literal, and it contained a backtick.
That ends the literal. `spike-template-syntax.mjs` refused the tree immediately, at the parse,
with the line in hand — the same class of failure as the backslash it was written for, on the
first day it could have shipped one.

## The Explorer's sticky headers — and the flex child that was never a scrollport (this change)

VS Code parity for the file tree, in three parts. The first arrived as a cosmetic request and
turned out to be a real layout bug underneath it.

**What was actually being seen.** The complaint was that the Workspace header scrolls away and the
tree is cut off. The header was never the problem — it lives outside the scroll area. The cut-off
half was `<ScrollArea className="flex-1">` in `Explorer.tsx`: a flex item's automatic minimum size
is its CONTENT size, so the ScrollArea grew to the height of the whole expanded tree rather than
being capped by the sidebar. Nothing overflowed, so Radix's viewport was not a scrollport at all —
there was no scrollbar to reach the rows past the bottom of the sidebar, and `position: sticky` had
nowhere to travel. `min-h-0` is the entire fix, and it had to land first, because until it did no
sticky behaviour could even be observed.

**Ancestor rows now park in a stack.** Each folder row sticks at `top: depth * ROW_H` with a
`zIndex` that *decreases* with depth, so as a subtree scrolls out the shallower ancestor stays on
top of the deeper one. Two constraints fell out of that: the offsets only sum correctly while every
row is exactly `ROW_H` (24px) tall, so the root row (11px uppercase) and the folder rows (`text-sm`)
now SET their height instead of inheriting whatever their font metrics give; and the sticky style
has to live on the `ContextMenuTrigger` rather than the row `<div>` inside it, because a sticky box
can only travel within its own containing block and only the trigger's wrapper — which also holds
the subtree — is taller than one row. Parked rows carry an opaque `bg-sidebar` so the rows sliding
underneath don't bleed through.

**One file type, one icon.** `fileIcon.tsx` makes the extension the source of truth and drops the
per-name special cases: `.d.ts` reads as TypeScript, `package.json`/`tsconfig.json` read as JSON,
and a name only earns a `BY_NAME` entry when its extension says nothing useful (`bun.lock` is JSON;
`.eslintrc`, `LICENSE` and `.npmrc`/`.npmignore` have no extension to read). Filling the extension
table out is most of the change — yaml/toml/ini/xml/sql, scss/sass/less as themselves instead of
all three as CSS, java/php/go/rust/wasm/shell, text/svg/image — because an unmapped extension
falling through to the generic document icon is what made the tree look unfinished.

**Verified in a real studio page**, on a Starlight project deepened to five nested levels from the
integrated terminal: seven ancestor rows parked at the top of the viewport while their files scrolled
under them, the bottom of the tree reachable (it was not, before `min-h-0`), and the context menu and
click-to-collapse still working on a PARKED row under injected clicks — sticky takes a row out of
normal flow, which is exactly where a hit-testing regression would hide. The drag-over ring reaches a
parked row too, though that one rests on a synthetic `DragEvent`, which bypasses hit-testing: it shows
the handlers and the ring class are still wired, not that a real drag would land there. Injected
element clicks work in this sandbox, but the low-level mouse-drag stage does not — it dies on a CDP
`Input.dispatchMouseEvent` protocol error — so nothing here ever grabbed the scrollbar thumb or
performed an OS-level drag, and every claim about where such a gesture *would* land is
`elementFromPoint`. Row height was measured at exactly 24.00 px for all 88 rows of an expanded 6-level
tree, so the offset ladder is arithmetically sound rather than merely plausible.

**Review caught two consequences of "positioned" that the implementation never looked at**, both
measured rather than argued, and both belonging to the same blind spot: a sticky row is a *positioned*
row, and positioning has effects far away from the row.

*It outranked the scrollbar.* `ScrollArea.Root` is `position: relative; z-index: auto` — not a
stacking context — and Base UI's scrollbar inside it is `position: absolute; z-index: auto`, so a row
carrying `z-index: 1…20` simply paints over it. This was never limited to parked rows, because a
sticky box is positioned whether or not it is currently stuck. Measured at `scrollTop 30`,
`elementFromPoint` down the scrollbar's centre-x returned Explorer rows for the top 139 px of the
264 px track, burying ~116 px of the thumb; a `mousedown` in that band would reach the project-root
row, whose handler collapses the project. The fix belongs to the component, not the call site — the
scrollbar overlays the content it scrolls, for every consumer — so `scroll-area.tsx` now pins it at
`z-30`, above any content ramp and below the app's z-40/z-50 overlays. After: the first hit-test
sample, 1 px into the track, is the scrollbar.

*And nothing that reveals a row knew the stack existed.* `scrollIntoView({block: "nearest"})` and
`focus()` both align their target with the scrollport's top edge — precisely the band the ancestors
occupy — and browsers do not account for sticky boxes. So clicking the editor tab for a file above the
current scroll position scrolled its row to `y = 0` and left it 100% behind the parked root row:
revealing the active file reliably revealed nothing. The same mechanism hid the inline New File /
New Folder input, which the review flagged as unmeasured and which turned out to be real — an A/B on
the same mounted input put it at `y = 0` under `starlight-ts-app` with the old unpadded scroll, and at
`y = 168` (its own depth × `ROW_H`, clear of a 7-row stack) with the new one. Both now go through
`revealRow`, which sets `scroll-padding-top` to the stack height above the target before scrolling;
`NameInput` additionally focuses with `preventScroll` so the browser cannot do its own unpadded scroll
first. `scroll-padding-top` is set per call rather than once on the viewport because the reserved
height depends on the target's depth.

**The area drag-over tint became an overlay.** The opaque `bg-sidebar` that parked rows require was
punching the `bg-accent/30` empty-area highlight into stripes, so the tint now paints *above* the rows
(`z-[25]`, `pointer-events-none`) instead of behind them. Confirmed by diffing the sidebar before and
after a synthetic area `dragover`: every one of the 14 row bands changes, where previously only the
gaps between rows could.

## Everything clickable stopped saying so (this change)

**Tailwind v4's Preflight dropped `button { cursor: pointer }`, and nobody put it back.** v3 shipped
that rule; v4 removed it deliberately, reverting buttons to the UA default `cursor: default`. There
is no deprecation and no error — the app simply stops signalling that its buttons are buttons, and it
does so everywhere at once, which is why the report ("files, buttons, and …") had no pattern to it.
Confirmed rather than assumed: `node_modules/tailwindcss/preflight.css` at v4.3.2 contains no
`cursor` declaration at all, its only occurrence of the word being a comment about Safari's spin
buttons, and `index.css`'s `@layer base` never re-added it. So the fix is one base-layer rule, not
`cursor-pointer` sprinkled across forty components: it covers components nobody has written yet, and
it cannot drift out of sync. Disabled controls are excluded via `:not(:disabled, [aria-disabled])`,
and because the rule lives in `@layer base`, every existing `cursor-not-allowed`, `cursor-text` and
`cursor-col-resize` utility still outranks it.

**The audit was run, not eyeballed.** Walking every laid-out element, reading its handlers off the
React fiber (`__reactProps$…`) and flagging anything with a click handler or an interactive role whose
computed cursor was non-interactive, across 21 stages from the Home template picker through the
context menu, command palette, dialogs and toasts: **34 kinds of control before, 2 after** (768 and
23 occurrences respectively — the same control is re-counted on every stage it appears on, so the
raw totals overstate how many distinct things were broken). The 2 are both correct to leave: the
status bar's diagnostics readout, which renders a `<span>`
precisely because it has no `onClick` (its handlers are Base UI's tooltip internals), and cmdk's
1×1 px clipped screen-reader `<label>` for the palette input. A static JSX pass covered what the
driver could not reach — Search and Source Control render no rows without data — and confirmed every
clickable element in those panels is already a `<button>`.

**What a base rule cannot reach got it explicitly.** The Explorer's file, folder and workspace-root
rows are `<div>`s with `onClick`, never buttons, and accounted for 194 of the flagged elements on
their own; the editor, terminal and preview tabs and the Source Control rows already had
`cursor-pointer` and were left alone. The resize handles needed measuring directly rather than
trusting the handler sweep, since they are dragged rather than clicked and react-resizable-panels
binds native listeners instead of React props: all four sat at `cursor: auto`, and now declare
`col-resize` (vertical) and `row-resize` (horizontal). Note the declaration covers the wider
`::after` grab strip but the pointer does not always reach it — on the two vertical handles the
neighbouring panel (Monaco's margin overlays, the preview's `inset-0` layer) paints over the outer
half, so about 3 px of the 4 px strip actually hit-tests to the handle. That was equally true before
this change; widening the grab area is a separate fix.

**Menu items now use the pointer, against the shadcn default.** `dropdown-menu`, `context-menu`,
`select` and `command` all ship `cursor-default` on their items, which is the native-menu convention.
This app imitates VS Code, so the question is what VS Code does — and VS Code is in `node_modules`:
`monaco-editor`'s own stylesheets say `.monaco-menu .monaco-action-bar .action-item { cursor: pointer }`,
`.action-item.disabled { cursor: default }`, and `.monaco-list.mouse-support .monaco-list-row
{ cursor: pointer }`. Menu items, toolbar items and tree rows are all pointer there, so all four
primitives were changed together. Two exceptions kept `cursor-default` deliberately: `select`'s
scroll-up/down buttons, which auto-scroll on hover rather than invoking anything, and a debug
variable row that is only expandable sometimes — it now mirrors its own `toggle` guard, pointer when
there is something to expand and default when clicking is a no-op.

## Three layout toggles, and the panel that could not be closed (this change)

**VS Code's three corner buttons, added to the title bar.** Sidebar, bottom panel and preview, as
icon-only toggles at the far right edge. Two of them only needed wiring: `toggleSidebar` and
`togglePanel` already existed on the controller behind ⌘B and ⌘J. The third did not exist at all —
`AppShell` rendered `<PreviewPanel/>` unconditionally, so the preview was the one region of the
workspace with no way to get rid of it. It now has `previewCollapsed` and a `togglePreview(force?)`
built to the same shape as its two siblings, `force` meaning *visible* exactly as it does there, so
all three answer to the same three routes: the button, the keybinding, and the command palette.

**⌥⌘B for the preview**, which is what VS Code binds its secondary side bar to, and nothing else in
the app claimed it — the only other `altKey` in the codebase is an xterm handler that explicitly
requires `!altKey`. The new branch is matched on `e.code === "KeyB"` as well as `e.key`, because
holding Option on macOS can compose the character (⌥B → "∫"); had it matched on `key` alone it would
have missed and fallen through to the plain ⌘B branch, toggling the sidebar instead of the preview.
That is a precaution rather than a repair: this is a Linux sandbox and the composing case was never
reproduced here.

**The trap was the resize handle, not the panel.** The sidebar and the bottom panel each wrap their
`ResizableHandle` and `ResizablePanel` in one fragment, so the handle leaves with the panel. The
preview's handle was a bare sibling, and hiding only the panel would have left a live 4 px draggable
divider pinned to the right edge of the window with nothing on the other side of it. Moving it into
the fragment fixes it; verified structurally in all eight visible/hidden combinations — every handle
present has a `resizable-panel` immediately either side of it, and a hit-test down the last 8 px of
the window returns no handle whenever the preview is hidden. Handle counts read 0/1/2/3/4 across
those combinations rather than the 0/1/1/2 you might expect, because the terminal panel contains a
nested split of its own (`term-content | term-list`) that arrives with it.

**The icons carry the state.** lucide ships a solid-divider and a dashed-divider glyph for each edge
and aliases the dashed one `-inactive`, which is the pack's own answer to this and closer to hand
than inventing a filled variant: `panel-left` when the sidebar is showing, `panel-left-dashed` when
it is not. VS Code distinguishes the two states by filling the sub-panel region instead, and no
lucide glyph does that — every body in the pack is `fill="none"`. The dashed rule is a fine
distinction at 16 px, so the foreground carries it too, muted when hidden and full contrast when
shown, matching what the activity bar already does for the selected view. `aria-pressed` carries it
for anything not looking at pixels.

**`New` is gone, and it never made anything.** `Home` and `New` sat side by side in the corner both
calling `c.goHome()`, which only sets `view: "home"` — so `New`'s `title="New project"` promised a
creation step that did not exist, and the two buttons were the same navigation under different
labels. `Home` is the accurate one and it stays; the Home screen is still where a project gets
created, exactly one click away as it always was. The brand button on the left also goes home, so
that route survives twice over.

**Verified by driving it.** All three toggles round-trip in both directions through all three routes
and agree with each other; the bottom panel's own "Hide panel" chevron moves the title-bar toggle
with it, since everything reads the snapshot rather than local state. Panel sizes survive a
collapse/restore round trip, including a preview dragged 120 px wider beforehand. The bar stays a
single 40 px row with no overflow from 1400 px down to 420 px, the layout cluster holding 186 px
while the centred project title truncates from 1067 px to 87 px. And the new buttons take
`cursor: pointer` from the base rule added in this branch's first commit, without needing a class.
## A UI review that mostly said "already right" (this change)

**An open-ended survey, driven rather than read.** The ask was whether anything in the Studio's UI
could be better. Eight areas were walked in the running app — tabs, empty states, keyboard, focus,
overflow, feedback, consistency, the status and title bars — and most came back clean, which is the
result rather than a failure to look hard enough. The editor tab strip already has italic preview
tabs that replace rather than accumulate, a dirty dot that swaps to an ✕ on hover, drag-to-reorder
with a drop-side indicator, and a five-item context menu with the inapplicable entries disabled. All
five empty states are written, not blank, and SCM's offers an `Initialize Repository` button.
Deleting a file confirms with "This cannot be undone". Nothing overflows between 1400 px and 500 px.
Light/dark parity holds. Seven things were worth fixing; the ranked list, including what was left
and why, is in the review document.

**The active tab was never scrolled into view.** Past roughly seven open files the strip overflows,
and activating a tab from anywhere but the strip itself — an Explorer click, ⌘P, a diff opening —
left it off-screen: measured `scrollLeft` stayed at 0 with `scrollWidth` 1950 against a 702 px
viewport, both for a tab created at x=1854 and for one activated 1700 px to the left. The editor
content changed while no visible tab looked active, which reads as the file not having opened. A ref
on the active tab plus `scrollIntoView({ block: "nearest", inline: "nearest" })` keyed on
`snap.activeTab` — the same thing the Explorer's `revealRow` already does. The scroll chevrons and
tab-list dropdown VS Code also has when overflowing are deliberately not part of this; they need
scroll-position state and belong in their own change.

**Middle-click closes a tab**, as it does in VS Code, where before it did nothing at all. It goes
through the same `processQueue` as the ✕ and the context menu, so a dirty file still gets its
Save/Don't save/Cancel prompt — verified on a dirty tab, not just a clean one.

**A truncated filename could not be read at all.** Tree rows ellipsize and the Explorer viewport
does not scroll sideways (`scrollWidth === clientWidth`), so a long name — or any name at depth 8,
where `paddingLeft: 8 + depth * 12 + 16` eats 120 px of a 216 px sidebar — was simply unreachable:
no tooltip, no horizontal scroll, nothing but widening the sidebar. The three row types now carry a
`title`, which the editor tabs already did. Real horizontal scrolling in the tree is the better fix
and is not attempted here — it lands directly on the sticky headers and the `revealRow` scroll
padding, and deserves its own verification pass.

**Five helpers had no accessible name between them, covering 25 icon-only buttons.** `ActBtn` (4
call sites), `HeaderBtn` (4), `IconBtn` (7), `ToolButton` (5) and `CtrlBtn` (5) each pass their label
to a `TooltipContent` and nothing else, so the activity bar announced as four anonymous buttons and
the preview and debug toolbars as five each. `aria-label={label}` on all five, plus two one-offs: the
inline New-browser-tab trigger, and the debug enable switch, whose "Debug mode on/off" text is a
sibling rather than a child so the switch itself had no name at all (`aria-checked` already carries
the on/off part). `LayoutToggle` in this branch's previous commit already did this, so the change
makes the codebase agree with itself rather than introducing a convention. Side effect worth having:
`getByRole("button", { name: "Search" })` now resolves, where it used to time out.

**The count came from enumerating statically, after a driven audit under-reported it.** Walking the
live DOM found nine buttons across three helpers, and missed `ToolButton` and `CtrlBtn` completely:
the preview toolbar renders only once a preview tab is active and the debug controls only once debug
mode is on, and the audit ran with "No preview open" and no session, so ten of those buttons did not
exist to be counted. A scan of every `TooltipTrigger`, `<button>` and `role=button|switch|tab|menuitem` in
`src` is state-independent by construction; it was validated against the two earlier commits, where
the answer was already known, before its zero was believed here. Then driven for real — a preview tab
opened and debug mode switched on — to confirm the ten previously unreachable controls resolve
through the accessibility tree. One trap worth knowing if you write that scan: JSX attributes here
carry `//` comments containing apostrophes, and a quote-tracking parser that does not skip comments
opens a string on one and swallows the rest of the file. `PreviewPanel`'s `<iframe>` ate 8.4 kB that
way and hid all five `ToolButton` call sites behind a clean-looking result.

**`StatusBar` cells deliberately get no `aria-label`.** They were never part of the problem: every
clickable cell wraps a *value* in an action label, so `label="Select Indentation"` over `Spaces: 2`
would replace the value with the action and announce "Select Indentation, button" — the number the
user wanted becomes unreachable, and WCAG 2.5.3 Label in Name breaks, so "click Spaces" stops
matching for voice control. The tooltip is the right home for the action and the visible text is the
right accessible name. `SourceControlPanel`'s branch picker has the identical shape and is left
alone for the identical reason.

**The command palette taught no shortcuts.** Zero of fourteen rows showed a key, while the
Explorer's *context* menu has shown ⌘C/⌘X/⌘V all along — so the palette was inconsistent with the
app, not merely spare. The four commands that genuinely have a global binding now show it
(⇧⌘C, ⌘J, ⌘B, ⌥⌘B), right-aligned in the same `ml-auto text-xs text-muted-foreground` the file rows
already use for their path. Only those four: a key printed beside a command that does not answer to
it is worse than no key, so `keys` is optional and the ten unbound commands stay bare.

**⇧⌘E opens the Explorer.** ⇧⌘F and ⇧⌘G were already wired to Search and Source Control, which made
the missing third the conspicuous one rather than an absent feature. `setActiveView` un-collapses the
sidebar on its own, so the branch is three lines beside its two siblings and needed no new state.

**The splitters were 3 px wide and grabbable from one side only.** Documented in the previous commit,
measured properly here: hit-testing across each handle at 1 px steps returned the handle at offsets
−3, −2 and −1 and nothing at 0 or beyond, because the separator is a 1 px element whose 4 px `::after`
overhangs its neighbours, and at `z-index: auto` it loses to Monaco's `margin-view-overlays` on one
handle and the preview's `absolute inset-0` on the other. `relative z-10` restores the full strip on
both sides. The number is bounded on both ends: it has to beat sibling panel content but stay under
the ScrollArea scrollbar's `z-30` from this branch's first commit, and both were checked by
hit-test — the scrollbar still wins, and the editor body still takes its own clicks.

**Verified by driving all of it**, 29 assertions: the active tab revealed from both the left and the
right of an overflowing strip; middle-click closing exactly one tab and still prompting on a dirty
one; no unlabelled icon-only button left, and each new name resolving by role; a title on all three
row types; exactly four palette keys and the right four; ⇧⌘E working without breaking ⇧⌘F or ⇧⌘G; and
every on-screen handle dragging from its neighbour's side at +1 px, re-measured between drags because
the handle moves with the pointer. Nothing here adds controller state or changes an interaction
model; the items that would — the Explorer's keyboard accessibility above all — are listed in the
review document instead.
## The Explorer revealed the active file, and parked it at the bottom (this change)

**"Nhiều lúc nó ở mãi bên dưới."** Switching between open files did scroll the Explorer to the
active one — a `revealRow` helper added in MR !158 — but it kept landing flush against the bottom
edge of the list, with nothing visible below it. The cause is one word: `revealRow` ended in
`el.scrollIntoView({ block: "nearest" })`, and `nearest` is specified as the *minimum* scrolling
that puts the element inside the scrollport. Revealing a row from below therefore parks it on the
bottom edge by definition — not a bug, and not one that presents as a bug either, which is why it
survived the original change and its review. `block: "center"` is now used for the active-file
reveal.

**Centring composes with the sticky stack rather than fighting it, and both claims were measured.**
`scroll-padding-top` (the band reserved for the parked ancestor rows) shrinks the *optimal viewing
region* per CSSOM-View, and `center` centres within the reduced band: with `padTop` at 48 the row
landed on the band centre and therefore exactly 24px — `padTop / 2` — below the raw viewport
centre, which is the arithmetic proof that the padding was honoured rather than ignored. The browser
also clamps the resulting offset, so "càng gần giữa càng tốt" at the ends of the list needs no
arithmetic here: a target near the top settles at `scrollTop: 0` and 198px above centre, one near
the bottom at `maxScroll` and 86px below it, each off-centre by exactly what the scroll range
denies. All three routes — clicking a tab, ⌘P, clicking a file — agree to the pixel.

**One row of clearance decides "already in view", and the threshold is the point.** Centring
unconditionally would lurch the tree on every tab switch, including when the file was already
sitting in plain sight. So the reveal is skipped when the row has `ROW_H` of clearance inside the
usable band on both sides, and fires otherwise. The clearance cannot be zero: a strictly-visible
test passes a row one pixel inside the bottom edge, which is precisely the case reported, so the
complaint would have survived the fix. One row is the smallest defensible value that also means
something — there is always a sibling visible on whichever side the row is nearest, so its place in
the tree is readable. Verified both ways: a row parked one pixel inside the bottom edge is
re-centred, and switching to an adjacent file already comfortably in view does not move the list at
all.

**The deep-row case at the top of the scroll range is safe, and structurally so.** This is where
clamping and the sticky band could collide — clamping prevents centring, so the row could come to
rest inside the band where the ancestors are parked. Driven at five starting scroll offsets against
a 7-deep chain, the row landed exactly at the band's top edge (`topInBand: 0`) every time, fully
visible, with nothing painted over it. It holds by construction rather than by luck: the clamp only
bites when the row is near the top of the *content*, which means few rows precede it, which means
the parked stack cannot be taller than the row's own ancestor chain — and that is exactly the height
`scroll-padding-top` reserves.

**The rename / new-file input deliberately keeps `nearest`.** It is the second `revealRow` call site
and it was not allowed to inherit the change. That input has just been spawned beside a row the user
clicked, so it is already where they are looking; the job there is only to get it out from behind
the parked ancestors, and moving the list the minimum amount to do that is less disorienting than
yanking it to the middle under a pointer that has not moved. Confirmed by driving it with the list
964px scrollable — so centring would visibly have moved it — where `nearest` moved it 0px and left
it 114px off centre, still fully inside the usable band.

**Also verified unchanged:** the reveal still fires once per tab, so scrolling away deliberately
survives re-renders and a `flatVisible` change from expanding another folder; the ancestor rows
still park at `depth * ROW_H` with the shallowest winning; the drag-over tint still fires; and the
new-file input still lands 2px inside the band, which is the MR !158 fix it was written for.

## Filling the cheap gaps, with the binary open beside us

Eight per-algorithm hashers (`Bun.MD4` through `Bun.SHA512_256`), `Bun.randomUUIDv5`,
`Bun.embeddedFiles`, `Bun.enableANSIColors`, `Bun.unsafe`, and loud refusals for
`Bun.generateHeapSnapshot` and `Bun.openInEditor`. Individually small; the reason they
are worth writing down is how they were checked.

**A real `bun` binary is an oracle, and it changed two answers.** Everything here was
run against bun-1.3.14 on linux-x64 before it was implemented, and twice the measured
behaviour contradicted the reasonable guess:

- The per-algorithm classes are **consumed** by `digest()` — `SHA256 hasher already
  digested, create a new instance to update` — where `Bun.CryptoHasher` resets and is
  reusable. Implementing them as CryptoHasher subclasses, the obvious move, would have
  made reuse work in the sandbox and throw on the first real `bun` run. That is the
  worst direction for a shim to be wrong in, and no amount of reading the published
  types would have caught it: the types describe neither lifecycle.
- `Bun.SHA256.hash(Bun.file(x))` **throws** in real Bun (`File blob cannot be used
  here`), so the sync-VFS read that was half-written to support it was deleted. A
  memory `Blob` does work there and cannot here — a Blob only yields bytes through a
  promise in this realm — so that one is refused with a message that says how to get
  the bytes. Strictness in the safe direction: what runs here runs there.

Every digest and UUID in the spikes is a value that binary printed, and the UUID
vectors agree with Python's `uuid.uuid5` as well — an implementation nobody here wrote.
Round-tripping our own output would have proved nothing: a wrong-but-consistent hash
input is self-consistent too, and only stops matching when it meets a system that did
it right.

**One algorithm has to be tested in the kernel tier.** A modern host OpenSSL refuses
md4 (`digital envelope routines::unsupported`), so the offline tier says so out loud
and skips that vector; Vivari's own Rust/Wasm codec does implement md4, and the kernel
spike pins it there. Skipping in silence is how an algorithm ends up tested nowhere.
## HTMLRewriter: 10,200 documents that had to come out identical

Bun's `HTMLRewriter` is lol-html, the Rust engine Cloudflare Workers run, and the
property people depend on is not the handler API — it is that a document you did not
rewrite comes back **byte for byte**. Rewrite one attribute in a 200 KB page and the
other 199 KB are unchanged: comments, odd quoting, stray whitespace, all of it.

That single sentence rules out the obvious implementation. Parse to a tree, mutate,
serialize, and every page you touch is silently reformatted — quotes normalized,
whitespace collapsed, `<P CLASS='a'   data-x=1 >` returned as `<p class="a" data-x="1">`.
It passes any test you would think to write and corrupts every real document. So this
is a rewriter over the source text: tokens carry `[start, end)` offsets, untouched
tokens are re-emitted as the original slice, and only a tag someone actually modified
is rebuilt — keeping the other attributes' original spelling and quote style.

**Verification is the interesting part.** An HTML rewriter that agrees with itself is
trivial to write and impossible to trust, because its output always looks like
plausible HTML. So the whole thing was built against a real bun-1.3.14 binary:

- 136 hand-written cases (a realistic page, malformed markup, raw-text elements,
  foreign content, every mutation, every selector form, every error string).
- A deterministic fuzz cross-product: generated documents × rewrite recipes. Locally
  **10,200 of 10,200** outputs are byte-identical to Bun's; 204 of them are committed
  as a fixture so CI checks the same thing without the binary.

The fuzz half paid for itself in one run. It found that a `<td>` at the top level of a
document still has a sibling position, so `td:first-of-type` matched it in Bun and not
here — every hand-written case had its elements nested inside something. The recorded
corpus also settled a dozen questions no amount of reading would have: `<SPAN>` keeps
its case when you add an attribute, `</p   >` is never reformatted, a self-closing tag
is rebuilt as `<br a="1" />` with the space, `:nth-of-type` is supported but
`:last-child` is not, `[data-x=1]` is a syntax error while `[data-x=b]` is not, and
`transform(Blob)` throws despite being in the published types.

**The one deliberate divergence** is `async` handlers on the string path. Bun drains
them; JavaScript cannot, and silently dropping everything a handler does after its
first `await` is the worst possible failure. That path throws and names the fix
(`transform(new Response(html))`), which is awaited properly.

## A full-stack Bun app with no client-side JavaScript (this change)

The Bun tab could show you `Bun.serve`, `bun:sqlite` and (as of the change above)
`HTMLRewriter`, one per template. What it could not show you was the three of them
being an application, which is the only form in which anyone actually meets them. So
the tenth template is a small issue board: `Bun.serve` routes it, `bun:sqlite` answers
it out of three tables and a `LEFT JOIN`, and `HTMLRewriter` pours the rows into
`public/index.html` on the way out.

**There is no template language in it, and no client-side JavaScript at all.**
`public/index.html` is a file you can open straight from the explorer and it renders —
nothing in it is `{{ }}` or `<% %>`, just `data-slot` attributes on ordinary elements.
That is the argument for a rewriter over a string template, and it is only worth
anything because of the property the previous change was built around: everything the
handlers were not pointed at comes back byte for byte. A designer can keep editing the
`.html` file without knowing the server exists.

**The second rewriter pass is the interesting one, and it is not about rendering.**
Vivari serves a preview under `/preview/<port>/` and the Service Worker strips that
prefix before the guest sees it. Subresources survive a missing prefix; a *navigation*
does not, so `<a href="/issue/3">` leaves the preview and 404s against the Studio —
the failure that shipped the session template broken on its first click. Every
server-rendered app hits this, and the fix has always been "remember to concatenate
`x-forwarded-prefix` onto every URL you emit", which is a thing to forget in one place
out of nine. Here it is twelve lines of `HTMLRewriter` that run over the finished page
and know nothing about issues: `a[href], link[href], form[action]`, skip anything that
already resolves, prefix the rest. It is the same rewrite Cloudflare's own examples use
the engine for, and it is what makes a multi-page server-rendered app clickable in the
preview pane at all. `sites/docs/docs/bun.md` now says so, with the snippet, because
this is sandbox-specific knowledge nobody can derive from Bun's documentation.

**The tests ship inside the app rather than beside it.** 48 of them across three files
— the SQL layer against `:memory:`, the rewriter against the real shells, the routes
against real `Request` objects — using all four lifecycle hooks, the asymmetric
matchers, `test.each`, `mock()` and `spyOn()`. Every route is a plain function of its
inputs and `createApp` is the only thing that knows `Bun.serve` exists, so the suite
never binds a port. That is deliberate: a test that starts a server is a test that can
hang, and this repo has been hung by exactly that before. A second toy `bun test`
template was considered and dropped — the existing one already covers the runner, and
what was missing was tests against code worth testing.

**Verified against the binary, not against itself.** Every page the template serves was
captured from bun-1.3.14 on linux-x64 and then from Vivari, and diffed: the board, the
filtered board, an issue page, and both of those again behind the preview prefix are
**byte for byte identical**, modulo the `created_at` wall clock. `bun test` reports
48 pass / 0 fail in both runtimes. `spike-bun-templates.mjs` now gates all of it from
the shipped bytes — 26 assertions for this template, including the post/redirect/get
flow and the prefix rewrite in both directions, because "no header means no rewrite" is
half the contract and the half that would rot silently.

**What writing it found.** `new Response(Bun.file(path))` — the first line anyone writes
to serve a static asset — returns a `200` whose body is the string `[object Object]`.
It is a *known* divergence (a `BunFile` here implements the Blob read protocol but is
not a `Blob` instance, and neither available fix is portable across both tiers), it was
pinned in the offline spike, and it was written down in the header of `bun-file.js` — in
other words it was known everywhere except the one place a user looks. It is in the Bun
docs page now, with the two spellings that work. Nothing about it changed in the
runtime; the only new thing is that you can find out before it happens to you.

The spike grew two capabilities on the way, both of which the next template gets for
free: an `also` probe can now be a whole request (`method`, `headers`, `send`, expected
`status` and `Location`) rather than a GET expecting 200, and a template can declare
`tests`, which runs its own `bun test` from the shipped bytes and refuses a suite that
discovered nothing — a floor on the pass count, and a separate assertion that the fail
count is zero, because `0 pass, 0 fail` exits 0 too.

## The realm a guest wakes up in: 228 globals that were never Bun's

`new Worker("./w.ts")` reaching the *studio's* origin instead of the VFS was fixed by removing one
name. The question that fix did not ask was how many other names were sitting there. The answer,
measured rather than guessed: a Chrome 143 `DedicatedWorkerGlobalScope` has 332 own properties and
35 more on its prototype chain, and **228 of them exist in neither a real `node` (141 globals) nor
a real `bun` (168)**. All 228 were visible to guest code.

Most were merely false — `WebGLRenderingContext` in a Node process is a lie a feature detection
will believe, and believing it sends a library down its browser path inside a Bun program. A dozen
were worse, because they were *capabilities that route around the kernel*: `importScripts`,
IndexedDB and Cache Storage on the studio's origin, `FileSystemSyncAccessHandle` (the OPFS a
persisted VFS lives in), `XMLHttpRequest`/`EventSource`/`WebTransport` — egress that never passes
the Fetcher Worker, so no alias rewrite, no cookie jar, no record — plus `USB`, `HID`, `Serial`,
`Notification`, and a `close()` that ends the worker under the kernel's feet.

And one that was a channel rather than a capability. `process-worker.ts` does `self.onmessage = …`;
that is the kernel's link to this process. A guest `addEventListener("message")` reads it: every
stdin chunk, every fetch result, every signal the kernel delivers. The write half of that door was
closed when the guest's `postMessage` was removed; this is the read half.

**Shadowing, not deleting — and the difference is the fix.** 35 of the names are inherited, where
`delete globalThis.x` finds no own property, removes nothing, and returns `true`; 17 of those are
accessors, where assigning `undefined` throws instead. An own, writable, non-enumerable data
property is the only form that works on all of them. It also happens to be exactly what the message
channel needs: driven through a real headless Chrome, a message sent *after* the sweep still reached
the ORIGINAL `onmessage` handler, while a guest assignment to `onmessage` landed in the shadow
property and was never called. The kernel keeps its channel; the guest cannot see it, take it over,
or listen on it.

**The list is an allowlist, and it is a recording.** `packages/runtime/realm.js` keeps what a real
node has and hides everything else, so a global Chrome ships next year is hidden by default instead
of leaking until someone notices. `scripts/record-realm-globals.mjs` produces all three lists —
`--node` and `--bun` from the binaries, `--browser` by driving a headless Chrome that loads a page,
spawns a Worker, and has the worker report its own property table back. A spike asserts the copy
embedded in the runtime still matches the recording, because the two can drift and only one of them
runs.

Two things had to be kept back from the sweep, and both are named at the point they are used rather
than left as exceptions in a list. `os.hostname()` and the `host.vivari.internal` alias read
`location.hostname` lazily — that is, after the sweep — so the value is captured at boot. Pyodide's
`urllib` bridge feature-detects `XMLHttpRequest` and uses synchronous XHR, so `__ocInstallPython`
hands it back to the realm a python guest runs in, and only there.

The Bun side is not just absence. Bun's main thread *has* `postMessage`, `onmessage`,
`addEventListener` and friends even with nobody on the other end, so those shapes exist for a bun
guest — as a guest-local `EventTarget` nothing dispatches to, and a `postMessage` that takes
anything and returns `undefined` (measured against the binary, along with `navigator.userAgent`
being `Bun/x.y.z` and `reportError` printing without exiting). `alert`/`confirm`/`prompt` are the
one honest gap: all three block on a line of stdin, and stdin arrives as kernel messages that cannot
be delivered while a synchronous call is parked. They throw, naming the reason and the async
alternative. Making them real needs a deferred stdin syscall — the kernel already parks `OP_ACCEPT`
that way — which is a change to the protocol and belongs in its own pass.

**Testing it needed the hazard to exist.** Node's global object has none of these names, so a sweep
that never ran would have passed every check. `scripts/process-worker.mjs` therefore plants a
browser-shaped realm under `VV_PLANT_BROWSER_REALM` — own and inherited, data and accessor — before
the runtime is imported, and `scripts/spike-bun.mjs` asserts from inside a running bun and node
guest that none of it survived, while `scripts/spike-realm.mjs` rebuilds the entire recorded worker
global offline and sweeps that. Reverting `realm.js` turns both red.

## `bun:jsc.serialize` was JSON, and JSON is a different problem

`serialize`/`deserialize` are supposed to be structured clone. What was here was
`JSON.stringify`/`JSON.parse`, which is not a weaker version of that — it is an encoding of a
different value space. A `Map` came back `{}`. A `Date` came back a string. `{a: undefined}` came
back `{}`. `-0` came back `0`. A BigInt and any cycle threw. Only the last two were loud; the rest
handed back something that looked like the value and was not, which is the failure mode this
codebase treats as the worst one.

The bytes could not be matched — JSC's format is engine-internal and Bun's own documentation says
the output is not portable — so the format here is Vivari's own, and everything *observable* is
matched instead, recorded from bun 1.3.14: 35 round-trip cases, 4 refusals, 4 corrupt-input cases.
Map, Set, Date, RegExp, BigInt, boxed primitives, TypedArrays, DataView, ArrayBuffer, Errors
(name, message, stack) all survive; cycles survive; `{x: o, y: o}` comes back with `x === y`; two
views onto one buffer come back as two views onto one buffer; a hole in a sparse array stays a
hole; `-0` stays `-0`.

Four details came out of the binary rather than out of the docs, and all four are now pinned:
`serialize` returns a **SharedArrayBuffer** (not a Uint8Array); Error `cause` is **dropped** by
real Bun, so it is dropped here rather than "improved"; `deserialize(new ArrayBuffer(0))` returns
**null** rather than throwing; and a non-buffer argument gets a different sentence from corrupt
bytes — `First argument must be an ArrayBuffer` versus `Unable to deserialize data.` The first run
of the comparison matched 41 of 43 cases; those last two were the misses.

Functions, symbols, WeakMaps and Promises are refused with a `DOMException` — the same type and
sentence Bun and the browser both use — instead of being turned into `{}`.

## `Bun.listen` was refused for a wall it never hit

`Bun.listen` and `Bun.connect` threw "there is no raw TCP in a browser". Half of that is true — a
tab cannot open a socket to the internet, and nothing here changes it — and the half that is false
had been false for a long time: the VM has its own kernel-routed loopback network, `node:net` has
been using it since `Bun.serve` worked, and two processes in the sandbox talking over TCP was never
the impossible part. A Bun program that starts a server and connects to it was being refused for a
limitation it never reached.

The refusal moved from the API to the destination. Loopback works; an outside host throws a message
that names the host you asked for and points at `fetch()`; binding a non-loopback interface throws
one that points at `Bun.serve()`. TLS is refused rather than faked — there is no certificate
authority on a virtual network, and a socket answering `authorized: true` about a plaintext link is
a lie with security consequences, which is exactly the kind of comforting default this codebase
treats as a bug.

The surface came from the binary: `listen()` is synchronous and its listener has a real `.port`
immediately, handlers get `(socket, Uint8Array)`, the socket carries a writable `.data`, and a
refused connection **both** rejects the promise and calls `connectError` — code in the wild
registers only one of the two, so doing only one would strand it.

One thing did not survive the first run, and it is worth writing down: `server.listen(port, host)`
leaves `address()` reporting port 0 for `port: 0` in this net stack, so the listener came back with
a port nobody could connect to. Passing the port alone fixes it — the VM has exactly one loopback
interface, and the hostname's real job is deciding whether the bind is allowed at all.

`scripts/spike-bun-socket.mjs` proves it with two real processes on one socket, not just a server
and client in the same program: the cross-process case is the one that exercises the kernel's
routing rather than a loopback shortcut.

## `bun init` printed "not implemented" — which is the first command in Bun's docs

Five verbs — `init`, `create`, `pm`, `link`, `unlink` — shared one line in the CLI that printed
"not implemented in the Vivari shim yet" and exited 1. The first of them is the first command on
Bun's own getting-started page, so the shim's answer to "start a Bun project" was a refusal.

`bun init` now writes Bun's template: `package.json` (name from the folder, `module`, `type`,
`private`, `@types/bun` as a devDependency and `typescript` as a peer), `index.ts`,
`tsconfig.json` **with its comments**, `README.md` and `.gitignore`, then installs. The files are
byte-for-byte the binary's, recorded from a real `bun init -y`, including the two typos in Bun's
own `.gitignore` (`_.log`, `report.[0-9]_...`). Matching a template people copy from is the whole
job; "fixing" it here would be the drift, and the spike asserts the typo on purpose. Running init
twice leaves existing files alone and does not report them as created.

`bun pm` turned out to be mostly a question about the project on disk rather than about Bun, and
the installs here are npm's, so the answers were already in the VFS: `ls` (direct by default,
`--all` for the tree), `bin`, `pkg get|set|delete` by dotted path — with `set` parsing a JSON
value, so `private=true` is a boolean and not the string — `why` through `npm explain`, `cache`
and `pack`. The three that need a registry session (`whoami`, `view`, `scan`) are refused by name:
there is no credential store in a sandbox and no way to prompt for a login.

`bun create vite my-app` is `bunx create-vite my-app`, which already worked — the verb just never
reached it. `bun create <user/repo>` clones over git and says so.

The two `--react` templates are refused rather than approximated: they scaffold from a generator
rather than from files in the binary, and pointing at `bun x create-vite` is more honest than
writing a different React project and calling it Bun's.

## 34 matchers that were a TypeError, not a failure

`bun:test` had 53 of the 87 matchers real Bun's `expect()` exposes. The missing
34 were not an inconvenience: a suite written against Bun that calls
`expect(n).toBeOdd()` did not fail here, it crashed with "toBeOdd is not a
function" — which sends the reader to their own code rather than to the runner.
Ten of them were the Jest spellings (`toBeCalledWith`, `lastCalledWith`,
`nthReturnedWith`) that any suite ported from Jest uses on its first line.

The table is now recorded from the binary (`scripts/record-bun-test-api.mjs` →
`scripts/fixtures/bun-test-api.json`) and a spike compares the two, so the next
matcher Bun adds arrives as a failing check instead of as a crash in somebody's
suite.

Probing beat guessing twice. `toBeWithin` is half-open — `expect(2).toBeWithin(1, 2)`
fails — and `toBeEmptyObject` accepts an empty ARRAY, a class instance, a
null-prototype object and a function, while refusing `new Set()`, `new Date()`
and `""`. What separates those is the internal slot rather than the key count, so
the implementation checks the tag; a from-first-principles version gets the array
wrong in both directions.

`expect.assertions(n)` needed a counter, and the obvious place for it was wrong.
Counting inside the matcher counts each assertion several times, because one
`expect(x)` builds `.not`, `.resolves` and `.rejects` tables alongside the plain
one. Bun's own report says "N expect() calls", which is the hint: the count
belongs at `expect()`. It is verified by running four real tests through the
runner and reading the report, since a counter checked by calling the function
that sets it proves nothing.

One refusal is a copy of Bun's: `expect.addSnapshotSerializer()` throws
`Not implemented` in Bun 1.3 too. Accepting a serializer and then ignoring it
would quietly change what snapshots contain, which is worse than saying no.

## The kernel's other door: a message table a guest could post to

Hardening the syscall path invited the obvious next question — is that the only way in? It is not.
A Process Worker also posts messages to a handler table in the kernel, and in a browser
`globalThis.postMessage` inside that worker posts *straight to the kernel*, because the kernel is
the worker's creator. Guest code could therefore aim any entry in that table at a payload of its
choosing, and fuzzing the nine handlers showed five that threw on a malformed one (`thread-spawn`
died on a bare `{}`). Neither dispatch had a guard, so that throw escaped into `onmessage` and took
the VM with it: every process, the VFS session, the preview.

- **The handlers validate and drop.** A message with nothing to act on is ignored. Unlike a syscall
  there is no caller parked on a reply, so silence is the whole correct response — what a handler
  must never do is answer with an exception.
- **Both dispatches are guarded**, the browser's and the Node harness's, so the next handler that
  forgets a check costs a log line instead of a session.
- **The capability is gone as well.** The runtime removes `postMessage` from the guest's global,
  next to `Worker`. This is the same shape of bug as that leak — a host global visible to the guest
  because they share one realm — except `Worker` was merely *wrong* while this one was *reachable*.

**What made this awkward to prove.** The Node tier has no global `postMessage` for a guest to
reach, which is precisely why it went unnoticed for so long, and it means the obvious assertion
("a guest sees none") passes with the fix reverted. The worker entry now plants a browser-shaped
one under an env flag so the spike watches it actually get removed; both new checks were run
against reverted fixes to confirm they fail. The removal also forced the browser worker to capture
`self.postMessage` at load: read it lazily and taking the global away would have silently killed
every stdout byte and exit code, in the browser only, where no spike would have seen it. The
vendored napi/wasm runtime turned out to select a transport by `typeof postMessage === "function"`
— which rules out shadowing it with a throwing stub, and is why deletion (the value Node itself
has) is the only safe form.

## Reading the whole surface, instead of adding APIs one request at a time

Every previous batch answered a question someone had already asked. This one
enumerated `Bun`, `bun:jsc`, `bun:ffi` and `bun:test` from a real binary and
diffed the lists, which found things nobody had thought to ask about.

**Thirteen `Bun.*` names were absent, not refused.** That is the failure this
project has a whole file (`bun-unsupported.js`) devoted to preventing: an absent
property reads as `undefined`, which is a VALUE, so the read succeeds and the
mistake surfaces later and elsewhere. Six were cheap and real — `cwd`, `origin`,
`version_with_sha`, `fetch` (with `preconnect`), `jest`, `shrink` — and the rest
joined the catalogue with a tier and a reason. The tier is the part worth
getting right: `Bun.postgres` needs a raw TCP socket and never will work, while
`Bun.S3Client` is HTTPS plus an unwritten SigV4 signer, so telling someone the
wrong one costs them an afternoon.

Two of the six looked obvious and were not. `Bun.origin` is `""` even while
`Bun.serve` is running, and `Bun.fetch !== globalThis.fetch` in real Bun too, so
the faithful shape is a wrapper rather than an alias. Both were read off the
binary.

**`Bun.JSONC` is not JSON5 with a different name.** The cheap implementation was
right there — the vendored JSON5 parser handles comments, trailing commas,
single quotes and hex — and it would have been wrong in the dangerous direction:
JSON5 also accepts `NaN`, `Infinity`, a leading `+` and unquoted keys, all of
which real Bun rejects. A config parser that accepts more than the real one is
how a file works locally and fails in CI. Hand-written instead, and stricter
than Bun in exactly two places, both refusals: an unquoted key (Bun returns
`{"": 1}`, silently dropping the name) and a second root (Bun returns the first
value and ignores the rest of the file).

**`bun exec` was running the wrong thing entirely.** `bun x <package>` runs a
package binary and `bun exec <command>` runs a shell command; both were wired to
npx, so `bun exec 'echo hi && pwd'` searched the registry for a package named
after the line. Fixing it surfaced a second gap one layer down: the VM's `sh`
had no `exit` builtin, so `sh -c 'exit 3'` reported 127 — "not found", for
something that is not a program — and everything through `Bun.$` saw the same
wrong code.

**`bun:jsc` had two members hiding in a list of impossible ones.** Most of it is
a hatch into JavaScriptCore — the collector, the JIT tiers, the sampling
profiler — and none of that is reachable from page code. But `setTimeZone` is
just `process.env.TZ`, which Node re-reads, so it really does move `Date`; and
draining the microtask queue needs no privilege at all. Refusing the family
wholesale would have thrown those away.

## The clock seam that was refused for the wrong reason

`vi.useFakeTimers()` and `setSystemTime()` were refused here with a stated
reason: the runtime's timers are the event loop's own, and there is no clock
seam to swap out. That was a true sentence about `loop.js` and the wrong
sentence about a test. The code under test does not call the loop; it calls the
global `setTimeout`, and swapping the global IS the seam. Nothing in the loop
changed — it keeps its own timers — and both features fell out of about a
hundred lines. A refusal is a claim, and this one had never been re-read after
the thing it described stopped being the obstacle.

The binary decided the semantics, and two of them are not what you would guess.
`setSystemTime` FREEZES the clock rather than offsetting it, so a duration
measured across it is zero. And fake timers leave `Date` completely alone: the
two features share a namespace and nothing else, so a test can use either
without the other.

One deliberate divergence, found by running it: `runAllTimers()` with a live
`setInterval` never returns in real Bun — the probe had to be killed. Draining a
queue that refills itself has no end. Ours stops after 100,000 firings and names
the call that did it, because a hung test run reports nothing at all.

## `Subprocess` was 6 of 19 members, and the missing one was `exitCode`

Enumerating the prototypes of Bun's live objects — `Server`, `Subprocess`,
`BunFile`, `Database`, `$` — turned up a gap that no refusal covered, because
nothing had refused: `Bun.spawn()` returned an object with six properties, and
`exitCode` was not among them. The idiom in Bun's own docs is `await p.exited;
if (p.exitCode !== 0)`, which here compared `undefined !== 0` and took the
failure branch after every SUCCESSFUL run. A missing API throws and you find it;
a missing property reads as `undefined` and quietly inverts a branch.

Two of the semantics are worth writing down, since guessing them wrong is what
this class of bug is made of. `exitCode` stays `null` when a signal killed the
process — the code lives in `signalCode` then — so treating it as a number is
wrong exactly in the case you are checking for. And `killed` is true after ANY
exit, not only after `kill()`.

The same pass gave `$` its seven missing names — `cwd`/`env`/`nothrow`/`throws`
set defaults for every command after them, and `ShellError` is what makes the
`instanceof` check in Bun's docs work at all rather than silently taking the
other branch — and `Bun.file().formData()`, which refuses a body with no
content-type in Bun's own words rather than returning an empty `FormData`.

## `Bun.spawn({ ipc })`: a channel the kernel had already built

Three of `Subprocess`'s nineteen members were refusals: `send()` threw, `connected`
was permanently false, and `disconnect()` did nothing. The refusal text said the
VM's `child_process` has no `ipc` stdio, which was true and was also the wrong
thing to be looking at. Nothing about this needed an fd.

The kernel has had a full cross-process pipe for as long as `node:net`'s UNIX
sockets have worked: `OP_PIPE_LISTEN` registers a socket path, `OP_PIPE_CONNECT`
resolves it to a connection, and `pipe-data`/`pipe-shutdown`/`pipe-close` are
relayed verbatim between the two ends by connId. `Bun.listen`/`Bun.connect` and
Nuxt's dev worker both already run on it. So an IPC channel is a socket on a
generated path: the parent listens before it spawns — `net.Server.listen` on a
pipe path is synchronous all the way down to the syscall, so the listener is in
the kernel's table by the time `Bun.spawn` returns — and the child dials it while
it boots. No new opcode, no protocol change, no kernel edit at all.

What the binary taught us was the shape, and most of it was not guessable. The
child gets **Node's** fork surface, not a Bun one: `process.send`,
`process.on("message")`, `process.connected`, `process.channel`,
`process.disconnect()`, and nothing on the `Bun` global. The parent passes
`NODE_CHANNEL_FD=3` — an AF_UNIX socket, not a FIFO — alongside
`NODE_CHANNEL_SERIALIZATION_MODE`, and **both are already gone from
`process.env` when the child's first line runs**. That deletion is not tidiness.
`env` is what a process passes on when it spawns something itself, so an
inherited channel address would send a grandchild dialling its grandparent's
server, where it would be accepted as the child and interleave its frames into
someone else's stream. We cannot inherit a descriptor — a Worker has none — so
the socket path travels under a name of our own and is deleted just as early.

The serialization was the part most likely to be got wrong by reading the docs.
Bun's default mode is `"advanced"`, and advanced is a structured clone: a Map, a
Set, a Date, a RegExp, a BigInt, a TypedArray and a cycle all survive it. This
repo already had a structured clone, written for `bun:jsc.serialize` after that
one turned out to be `JSON.stringify` wearing the wrong name, so the channel
reuses it — including the `DataCloneError: The object can not be cloned.` it
already threw, which is the exact sentence the binary throws for a function.

Three surprises, in the order they arrived.

The first: a child holding a `message` listener **does not exit**. The very first
probe hung for twenty seconds, and the reason was not a bug in the probe — under
real bun, an attached listener holds the child open until somebody disconnects,
and a child that never attaches one exits the moment its script ends. That is the
same rule as the `message`-listener gotcha this project has already been bitten
by, arriving from the opposite direction, and it is implemented the same way: the
socket is `unref()`d at boot and `ref()`d on the first `message` listener.

The second: `Bun.spawn(["node", …], { ipc })` does not work under real bun unless
you pass `serialization: "json"`. Node's advanced mode is `v8.serialize` and
Bun's is a JSC structured clone, so the node child's messages simply never
arrive — no error, no warning, nothing. Here both processes run the same runtime,
so `"advanced"` works with a node child too, which makes the sandbox **looser**
than production in a direction that costs someone a green suite and a red CI. It
cannot be made stricter without faking a failure, so it warns once instead.

The third came from trying to break the framing on purpose. A byte stream needs
length-prefixed frames, so the frames were written; then the prefix was deleted
and every chunk treated as a whole message, and `scripts/spike-bun.mjs` stayed
completely green — two hundred messages in one tick, a 400 KB payload and all.
In this VM one `socket.write()` becomes one `pipe-data` message, is relayed
verbatim, and is handed to the reader as exactly one `data` event, so the kernel
tier cannot tell a framed stream from an unframed one. A `net.Socket` is a byte
stream regardless and promises none of that, so the framing stays — but it is now
pinned where it can actually fail, in `scripts/spike-bun-offline.mjs`, by feeding
the reader the splits and coalesces a stream is allowed to produce: five frames in
one chunk, one frame across forty thousand chunks, a length prefix split down the
middle, and a length past the cap. Reverting the framing fails that block on its
first assertion. The kernel-tier claims were reworded to say only what they show.

One thing was found and deliberately not fixed here, because it is older than this
change and not about IPC: `Bun.spawn(["no-such-program"])` kills the calling guest.
`child_process.spawn` correctly declines to throw and reports the failure as an
`error` event instead — which is Node's contract — but nothing listens for it, and
an `error` emitted on an EventEmitter with no listener is rethrown. Real Bun throws
synchronously from `Bun.spawn` instead. It is an open item; the case was dropped
from the ipc spike rather than left there testing somebody else's bug. It did leave
one thing behind: the spike's "ran to completion" check used to be `!result.fatal`,
which passes when the guest dies before reaching its own catch. It asserts a
positive marker now, which is the same lesson as the ok-flag rule in AGENTS.md.

## `Bun.Archive`: the name promises more than the binary does (this change)

`Bun.Archive` was a SHIM-tier refusal whose message said the obvious thing — tar,
zip, and the compression around them are bytes in and bytes out, nothing about
them is browser-hostile. That was right about the capability and wrong about the
scope, which only running the binary showed.

**Reading a zip throws `Unrecognized archive format` in real Bun.** Not a
subset-of-zip limitation: no zip at all, from a class named `Archive`. This is the
kind of finding that changes what "done" means. Adding zip here was maybe fifty
lines with the inflate the runtime already has, and it would have made every
project that used it work in Vivari and fail on the deployment target — a shim
that is a superset is a trap laid for the guest, not a favour. So a zip is refused
in Bun's words, and the reason is written down where someone will look for it
rather than left as a puzzle.

**The writer ignores the extension.** `Bun.Archive.write("dist.zip", files)`
produces 10240 bytes of tar named `dist.zip`. Only `{ compress: "gzip" }` changes
anything. Matched, because a guest that reads those bytes back with the same API
never notices and one that shells out to `unzip` fails identically on both
runtimes — but documented in both places, since it is the sort of thing that gets
diagnosed as a Vivari bug.

**The Map quirk is real data loss.** `Bun.Archive.write(path, new Map([...]))`
writes a valid, empty, 10240-byte tar and returns without complaint. A `Map` keeps
its entries in internal slots, not enumerable own properties, so the object walk
finds nothing and there is no error anywhere in the path. `new Map` is also
exactly what you reach for after `files()` handed you one — the round trip
`write(p, await archive.files())` loses every file. That is refused here with a
message naming the shape, on the `Bun.JSONC` precedent: strictness is only safe in
a refusal, and this one turns a silent empty archive into a stack trace on the
guilty line. Three more shapes fail the same way and are refused with it — a
`Set`, another `Archive` instance, and `Bun.file()` used as a value (which writes
the entry with zero bytes, so the name survives and the contents do not).

**What the tar format cost.** The reader was the easy half — the repo already had
two copies of a ustar reader in kernel-host, and runtime builtins cannot import
from there, so a third minimal one lives in the builtin. The writer had no prior
art anywhere in the repo, and matching libarchive's header layout took more
probing than expected. `ustar` splits a long path across `prefix` and `name` at a
`/`; when it cannot, libarchive emits a pax extension header, and the rules for
what goes in the pax record versus the real header (the basename truncated to 87
bytes in one and 98 in the other) are not something to guess at. They were read
off archives the binary produced. Verification runs both directions: entries the
binary wrote are read here, and GNU `tar -tf` lists what this writes, pax long
name included.

Four tar variations turned up that a hand-built fixture would never have
contained: GNU `L` long-name entries, pax `x` records overriding the path, a v7
header whose typeflag is NUL rather than `'0'`, and typeflag `'7'` (contiguous
file). The last two are regular files that an exact-match `=== "0"` check drops on
the floor, so the archive reads as valid and short — which is how they were found.

Verification is `node scripts/spike-bun-offline.mjs`, against fixtures recorded
from bun 1.3.6 by `scripts/record-bun-archive.mjs` and archives generated by the
host's `tar` and `zip`. The negative cases are the ones worth keeping honest: the
first draft of them was every non-archive shorter than one 512-byte block, all of
which the length check alone rejects. Deleting the header checksum validation
entirely still passed the whole suite. The suite now feeds it a 4 KB non-tar, a
1 KB text file and a real multi-entry deflated zip, and that same deletion breaks
ten assertions.
## `Bun.S3Client` from a browser tab — a signer, and a client that is not Bun's (this change)

`Bun.S3Client` and `Bun.s3` were SHIM-tier refusals whose message named the two missing
pieces: a SigV4 signer, and a bucket CORS policy. The first was work. The second turned out
not to be a reason to refuse the API at all — it is a failure mode the API has to explain,
which is a different job and the more interesting half of this change.

**What the binary taught.** Reading `bun` 1.3.6 rather than AWS's documentation changed six
decisions, and every one of them would have been wrong the other way:

1. **Bun signs `x-amz-content-sha256: UNSIGNED-PAYLOAD` on every request, including `PUT`.**
   The body is never hashed into the signature. Hashing it — the thing the AWS docs describe —
   produces a request AWS rejects with `SignatureDoesNotMatch`, which reads as bad credentials.
2. **Only `host` and the `x-amz-*` headers are signed.** `Range` and `Content-Type` go on the
   wire outside the signature. That is legal (SigV4 requires only `host`) and it is the safer
   choice: a signature covering headers a proxy may rewrite is a signature that breaks in
   transit. A local HTTP server recording what the binary actually sent is what showed this;
   the SignedHeaders list is `host;x-amz-content-sha256;x-amz-date` even for a ranged GET.
3. **`Content-Type` defaults to `application/octet-stream` for everything** — including a
   string body, and including a `Blob` that carries its own type, which Bun ignores. The
   plausible guess (`text/plain;charset=utf-8` for strings) puts a different type on the
   object than the binary does.
4. **Missing credentials outrank a missing bucket.** With an empty environment,
   `Bun.s3.presign("k")` is `ERR_S3_MISSING_CREDENTIALS`; the bucket complaint only appears
   once the keys are there. Two things are wrong and the error names the first.
5. **`presign` accepts `POST`** despite every one of its error messages listing four methods,
   and it has *two* rejection paths: a real HTTP method S3 has no use for (`PATCH`) is
   `ERR_S3_INVALID_METHOD` with a capitalised message, while a token that is not a method at
   all (`GETX`, a number) is `ERR_INVALID_ARG_TYPE` with a lowercase one.
6. **Two of the names callers destructure are misspelled in Bun.** `list()` returns
   `checksumAlgorithme`, and a bad expiry says `expiresIn must be greather than 0`. Both are
   copied. An error message is API surface — someone will paste it into a search box — and a
   corrected field name is a silent `undefined` at the call site.

`list()` also returns `lastModified` as the raw ISO string while `stat()` returns a `Date`.
That inconsistency is Bun's, measured both ways. Tidying it up would give `list()` results
`Date` methods they do not have on a real Bun run.

**Why a client-side S3 client is a different object.** In the binary, `S3Client` owns its
socket. Here the request is issued by the browser on the page's behalf, and the browser has
three rules Bun does not:

- **The request may never be made.** A signed request carries `authorization` and two
  `x-amz-*` headers, none of them CORS-safelisted, so every call is preceded by a preflight
  `OPTIONS` the bucket has to answer. When it does not, `fetch()` rejects with
  `TypeError: Failed to fetch` — no status, no body, nothing to log, and it reads as a bug in
  the caller's own code. That rejection is now caught and rethrown as
  `ERR_S3_REQUEST_BLOCKED`, whose message says the request came from a browser tab, that the
  bucket needs a policy allowing this origin and these named headers, that `x-amz-*` triggers
  a preflight, and — the part that matters most — that this is **not** what a bucket refusing
  you looks like. A refusal has an HTTP status and an S3 code; this has neither, and the
  message says so in those words.
- **The response may be unreadable.** Cross-origin JavaScript only sees the response headers
  a bucket lists in `ExposeHeaders`. `stat()` therefore reports what it can see and `null`
  for what it cannot, but `size()` — whose entire contract is a number — throws
  `ERR_S3_HEADER_NOT_EXPOSED` naming the setting, because a `null` size becomes `0` in
  arithmetic and an object looks empty.
- **A request body cannot be streamed.** Browser `fetch()` has no duplex request stream on
  the paths available here, so a `ReadableStream` body is drained and sent as one `PUT`.

This only works at all because of the earlier egress fix: while the Fetcher Worker stripped
non-safelisted headers from every host, a signed request went out **anonymous** and a public
bucket answered `200` with the wrong bytes. That strip is scoped to the package registries
now, which is what makes header-signed S3 possible from a tab. `presign()` is the one part of
the surface that needs no policy whatsoever — the credential material is in the query string,
no headers are sent, and an `<img src>` or a download link is not a page reading a response.

**Validating the signer.** The `Bun.hash` lesson applies here more sharply than anywhere else:
a wrong signature comes back as `403 SignatureDoesNotMatch`, indistinguishable from a wrong
key, and there are no keys here to be right or wrong. A self-consistent signer would look
exactly like a working one. So the signer is pinned to AWS's published **Signature Version 4
Test Suite** (the fixture set mirrored in `awslabs/aws-c-auth` under
`tests/aws-signing-test-suite/v4`): five cases — `get-vanilla`, `get-header-value-trim`,
`get-utf8`, `get-vanilla-query-order-key-case`, `post-vanilla-query` — asserted as full
canonical-request, string-to-sign and signature triples, in both the header and query-string
flavours. On top of that, the requests the client builds are frozen against `Authorization`
headers and presigned URLs captured off the binary with the clock injected, and the spike
recomputes one presigned URL's signature with a SigV4 chain written out longhand over
`node:crypto`, sharing no code with the implementation.

**What is refused, and at which tier.** Multipart upload is **SHIM** — possible here,
unwritten. `S3File.writer()` buffers and flushes a single `PUT`, which is what Bun does below
its part size, and past 5 MiB it throws instead of starting an upload it cannot finish: a
half-done multipart leaves an incomplete object and a bill, and completing one from a page
needs `ExposeHeaders: ["ETag"]` so each part's tag is readable by script. Writing that against
a policy nobody has tested would fail deep inside an upload rather than at the first call.
Incremental request streaming is **SANDBOX**. And one refusal is aimed at the binary rather
than the browser: a key containing `?` throws, because Bun truncates the key there and
operates on a *different object* without a word — `presign("report?v=2.csv")` signs
`/bucket/report`. Bun 1.3.6 has the matching bug for stream bodies, uploading the string
`[object ReadableStream]`; that one is not reproduced either. Copying a data-loss bug for
fidelity's sake is fidelity to the wrong thing.

The credentials live in a `WeakMap` rather than on the instance, which is also what the binary
looks like — `Object.getOwnPropertyNames(client)` is empty on both. An enumerable field
holding a secret access key means `console.log(client)` prints it, and a file handle is the
thing a debugging session logs.

## Two failures that pointed at the wrong file (this change)

Both of these were found while merging the work above, and neither is an API gap.
They are the same bug in two costumes: a failure reported in a way that blames the
caller's code.

**A missing command killed the calling guest.** `Bun.spawn(["no-such-cmd"])` went
to `child_process.spawn`, which correctly declines to throw — Node's contract is
an asynchronous `error` event — and nothing listened for it. An `error` emitted on
an EventEmitter with no listener is rethrown, so a typo in a command name ended
the program that typed it, with a stack pointing into the runtime rather than at
the typo. Real Bun throws from `Bun.spawn` synchronously, so fidelity and the fix
turned out to be the same change: look the executable up before spawning and throw
the binary's own `Executable not found in $PATH: "…"` with its `ENOENT`. An
absolute path is still checked where it points rather than on PATH, because that
is not a PATH lookup.

**A CORS-blocked fetch said `TypeError: Failed to fetch` and nothing else.** A
guest's `fetch` IS the tab's own, so a request to an origin with no CORS policy
fails in the browser and never reaches the kernel. The message a browser gives
page code is deliberately contentless — the difference between "no such host" and
"that host refused your origin" is information about a network the page is not
allowed to see — and read literally it looks like a bug in the guest. This is
probably the single most common way a program that works under a real `bun` looks
broken in Vivari, and it had no explanation anywhere: `bun.md` did not mention CORS
once, despite `fetch` being listed as working.

The rejection is now rewritten to name who made the decision, the URL, the
`Access-Control-Allow-Origin` the target would need, and the preflight that a
custom header triggers — while explicitly naming the unreachable-host case too,
because the runtime cannot tell which of the two it was and inventing a diagnosis
would be worse than the silence. It stays a `TypeError` with the browser's error as
`cause`, since that is what callers branch on. The test for it is in the kernel
tier and refuses a connection to prove it, since a refused connection produces the
same opaque failure as a CORS block — which is exactly why one can stand in for
the other.

---

## Python: the two checkers, and the Django command that pretended to work

Three gaps, all found by asking rather than assuming, and all in the same category: things a
Python user types on day one that Vivari either did not answer or answered dishonestly.

**Type checking, which the docs had been admitting was missing.** The editor gives completion,
hover and signatures from jedi, and `python.md` said outright that nothing tells you a file is
wrong before you run it. mypy turns out to be entirely available: it is in Pyodide's distribution,
it loads in about four seconds, and it produced the same diagnostics — error codes included — as
the mypy on this machine. So `mypy` is now a command, pinned to the version the lock names, and
the bridge spike compares its output to the host's rather than to a table written here.

**mypy needed a seam, and black did not — which was worth finding out before writing either.**
The obvious implementation is plain `runpy`, the way every other module goes. black works that
way and needed nothing but a line in `PYTHON_DELEGATES`; it reuses the wheel the editor already
vendors for Format Document. mypy through `runpy` printed its diagnostics correctly and then
killed the interpreter: its command line ends in `os._exit()` to skip teardown, which under
Emscripten takes the whole runtime with it, so the output lands and the exit code does not.
`mypy && deploy` would have deployed on a failed check. `mypy.api.run()` is upstream's own way in
for embedders and runs `main()` with `clean_exit=True`, the flag that skips exactly that path.

**A vendored wheel is not a working wheel.** Pyodide's lockfile declares mypy as depending on
`librt` and nothing else, but a checked file raises `ModuleNotFoundError` for `typing_extensions`,
then `mypy_extensions`, then `pathspec` — each surfacing only once the previous is satisfied. The
failure mode is nasty because `loadPackage()` succeeds either way: the wheel is there, and the
import fails later, in front of the user. `DEPENDS_FIXUPS` names the missing deps once, and the
vendor script uses it twice — to pull their wheels into the download closure, and to amend the
lock the browser reads. Two of the three cost nothing; black already pinned them. The bridge spike
asserts the under-declaration is still real, so if upstream ever fixes the metadata the fixup is
reported as dead weight instead of quietly staying forever.

**`python manage.py runserver`, which hung.** The socket refusals are keyed on `-m` module names,
and runserver arrives as a script path, so it went straight past all of them — and Vivari ships a
Django template, which makes it the single most likely command on the whole surface. Measured
rather than assumed: in Pyodide `bind()` and `listen()` both return without error, `TCPServer`
constructs even with Django's `allow_reuse_address`, `select()` never reports the socket readable,
and `handle_request()` times out with nothing arriving. So it prints its banner and answers
nothing, forever — the exact outcome `SOCKET_MODULES` calls the worst one. It now refuses and
names the `gunicorn` line the template already uses. The refusal is deliberately narrow: `migrate`,
`makemigrations`, `shell`, `createsuperuser` and `collectstatic` are checked to still run, and so
is `runserver --help`, which binds nothing and is more useful as Django's own help.

**Still uncovered:** ruff (a Rust binary, not in Pyodide's index at all), notebooks, and editor
squiggles for the type errors `mypy` now finds — the checker runs at a prompt, not as you type.

## Python: squiggles, the commands packages bring, and two libraries that only half-worked (this change)

Five things people expect from Python, done together because they kept turning out to be the same
question: what does the metadata claim, and is it true?

**Type errors as you edit.** The previous change left `mypy` as a command and said so in the docs;
this wires the same checker into the editor. It is not a Monaco provider — there is nothing to
register, diagnostics are pushed — so the `check` op writes the buffer down, runs mypy through the
API and the answer goes out with `setModelMarkers`.

The design question was when to run it, and it was settled by measuring rather than picking a
number. One interpreter serves both completion and checking, so a check that is running is a
completion that is waiting: ~2.1s the first time a project is seen, ~0.35s per edit after that with
an incremental cache. That makes a pause affordable and a keystroke not, so it runs 700ms after
typing stops, under its own queue kind, and mypy loads on the first check rather than at boot.

Two details are the difference between a marker and a wrong marker. mypy's end column is inclusive
and Monaco's is not, so `--show-error-end` needs a +1 or every squiggle stops one character short.
And mypy reports paths *relative to the working directory*, not as the absolute path it was handed
— so the filter that keeps other files' diagnostics out dropped all of them instead, and the
feature returned a confident, permanent "no errors". The offline tier could not have caught that:
it drives the marker code against a reply we wrote, and a reply we wrote has the paths we expect.
The bridge tier runs real mypy and compares against the host's, which is what found it.

**`pip install <thing>` now leaves you with `<thing>`.** Every wheel that declares a command ships
`entry_points.txt`, and the store already held it; nothing read it, so the command a package's
README tells you to run answered "not found". Shims are generated into `.venv/bin` — where a real
venv puts them — and regenerated from the store each time, so an uninstall removes the command
instead of leaving one that spawns an interpreter to fail at an import.

The part worth arguing about is what a shim must NOT take over. `.venv/bin` sits ahead of `/bin`,
which is right, but `/bin/pytest` is not merely another way to reach the module: it is the seam
that turns pytest's exit code into the process's. Installing pytest would have silently undone it
and made `pytest && deploy` a lie again. `RESERVED_COMMANDS` protects the seams, and the offline
tier checks that set against `PYTHON_DELEGATES`, so adding a seam without protecting it fails.

**`pip install -e .`** was parsed as a request to install a package named `.`. It is now an
editable install: a `.pth`, a `dist-info`, and `[project.scripts]` written as `console_scripts` so
the generator above turns them into commands. What it will not do is guess. There is no PEP 660
backend here and running one needs a subprocess, so the metadata has to be *read*: a static
`[project]` name and version is enough, and a dynamic version, a `setup.py`, or a Poetry-only table
is refused with the reason and the fix rather than installed under an invented name. Dependencies
are listed and explicitly not installed, because resolving half of them silently leaves an
`ImportError` for later.

**httpx works, aiohttp cannot, and neither was documented.** Measured, not assumed. Pyodide's httpx
defaults to a `JavascriptFetchTransport` and its no-JSPI fallback is a synchronous
`XMLHttpRequest` — the same browser capability that makes `requests` work — and, unlike urllib3, it
has no `is_in_node` branch to be wrong about, so it needed no patch, only vendoring. aiohttp goes
to a real connector and dies at DNS. Being in Pyodide's index reads like being supported, so the
spike asserts both outcomes and the docs name the failure.

**Two templates, and a library that was half-broken in a way nobody would have reported.** rich's
lock entry declares *no* dependencies, and rich imports pygments and markdown-it-py lazily — so
`import rich` succeeds and `rich.syntax` raises `ModuleNotFoundError` at the one line that
highlights something. markdown-it-py is not in Pyodide's index at all and is now vendored from
PyPI. This is the same class of bug as mypy's under-declared deps, found the same way: import the
submodules, not the package. The rich template also has to pass `auto_refresh=False`, because
rich's progress bars animate from a background thread and there are none — the default raises
`RuntimeError: can't start new thread` the moment the bar starts. The SQLAlchemy template needed no
such caveat: the 2.0 ORM over the built-in SQLite works exactly as written.

**Still uncovered:** ruff (a Rust binary, not in Pyodide's index at all — see batch three, where
this turned out to be the wrong conclusion from a true premise), notebooks, and
scikit-learn as a template — it and SciPy would add ~25 MB to a 45 MB vendored distribution, which
is a size decision rather than a technical one, and it still works from the CDN today.

## Python, batch three: the first five minutes, and a linter that is not a Python package

The previous batches made real projects work. This one is about what happens before anyone has a
project — the lines people type first, which turned out to be the lines least well served.

**`plt.show()` drew nothing and said nothing.** Pyodide's matplotlib defaults to Agg, whose `show()`
is a documented no-op, so the last line of every matplotlib tutorial ran, exited 0, and produced
silence. Of all the ways this runtime can disappoint someone, a successful no-op is the worst: there
is no error to search for and nothing to suspect. There is no window to give them, but there is a
file, and files written under the project already mirror back out — so `show()` now saves each open
figure and says where it went, through a `module://` backend, which is matplotlib's own extension
point rather than a monkeypatch. Two attempts at naming: keying the file by figure *number* is the
obvious choice and quietly destroys work, because a script that plots, shows, plots, shows gets
figure 1 twice and the second chart overwrites the first with no indication. The name is assigned
once per figure and remembered on it. `figure.show()` needed separate wiring — it reaches the
manager, not the module, and left alone it warns that an Agg canvas cannot be shown.

**`asyncio.run()` answered with a WebAssembly proposal.** `RuntimeError: WebAssembly stack switching
not supported in this JavaScript runtime` is accurate and useless: it names a Wasm feature and no
way forward. There is a way forward — files here run under `runPythonAsync`, so top-level `await` is
valid — and now the error says so. The real `asyncio.run` is tried first and only its specific
failure is rewritten, so a browser with JSPI (Chrome 137+, Firefox 139+) is left entirely alone;
every other `RuntimeError` is still the user's. The bridge case asserts the advice *runs*, because
advice that rots is worse than none.

**`input()` was a bare `EOFError`,** which reads as "your input ended" rather than "this was never
possible". It still raises `EOFError`, so `except EOFError` keeps working, but now says that Python
is on the worker's only thread and a keystroke can only arrive after the call has returned. This one
is a genuine shim rather than a fix: making `input()` block needs a stdin syscall in the kernel —
the current syscall layer is strictly request/immediate-response, and stdin arrives as async
messages, so there is nothing to park on. Named here as the honest gap it is.

**`zoneinfo` could not find a single timezone,** including UTC, because the WASM build ships no
system tz database. tzdata is now vendored. The interesting part is the loading: it is *data*, so no
`import` statement names it, and `loadPackagesFromImports` — which works by reading imports — was
structurally unable to find it. Any source mentioning `zoneinfo` now pulls it in. That is text
matching rather than parsing, deliberately: by the time `zoneinfo` is imported there is no async
left to fetch a wheel in.

**ruff, which this file wrote off two batches ago.** "A Rust binary, not in Pyodide's index at all"
was true and irrelevant: Astral publish it compiled to WebAssembly, so it is a module this runtime
loads directly and it never enters the interpreter. That is the point rather than a detail — `ruff
check` on a cold project pays no Pyodide start and loads no wheels. It is vendored same-origin
(11 MB, fetched only when something asks for it) and pinned, and the bridge tier holds it to the
*real* ruff CLI at the same version: every finding matched by line and column, the exit code
matched, and formatting compared byte for byte.

Two things it will not do, both refusals rather than gaps:

- **`--fix` is refused, after being implemented and taken back out.** It worked, in the sense that
  it ran and reported success — and turned a valid file into `n a+b`, because several fixes for one
  file are computed against the same original text, so an unused-import deletion and an import-sort
  rewrite overlap and shred each other. The real CLI applies one, re-lints, and repeats. That is
  fixable; the other half is not. The wasm build reports a fix as a message and a list of edits and
  does *not* say whether it is safe, so applying them is real ruff's `--unsafe-fixes` — allowed to
  change what the code does — under a flag the user did not type.
- **`[tool.ruff]` is not read.** Parsing TOML well enough to be trusted with someone's lint config is
  a bigger thing than this, and misreading it silently is the same failure as above. When config is
  present, ruff says on stderr that it is running with defaults. `--select`, `--ignore` and
  `--line-length` on the command line do work, and go through as ruff's own settings keys.

The offline tier caught the bug that mattered most here, and it was in the plumbing rather than the
linter: the runtime's `process.exit()` throws the event loop's exit sentinel, so calling it inside an
async program lands in that program's own `catch` — every clean `ruff check` printed `ruff: exit` on
stderr and could have exited 1. Status now travels as a thrown value of our own that the catch can
tell apart. A stub linter was enough to find it, which is the argument for the tier: what a linter
gets dangerous about — which files it reads, what it refuses, whether a refusal writes anyway — is
all outside the wasm.

## Python, batch four — the interpreter itself

Three of these are about the two things a person notices first (how long a command takes, and
whether the editor is telling them something useful), and the fourth is the one that had been on
the "still uncovered" list since the beginning.

**Stubs, so the first squiggle is about your code.** `import requests` used to make mypy's first
message `Library stubs not installed for "requests"` on line 1 — a complaint about packaging,
naming a `pip install` that needs a network, on a line nobody wrote. And it is worse than noise:
the untyped import makes the module `Any`, so `r.jsonn()` two lines down goes unreported. Which
libraries need this was measured rather than guessed — a probe checked every vendored package for
a `py.typed`, and exactly two lack one. `types-requests` and `pandas-stubs` are now vendored and
loaded with mypy, and that same typo becomes `"Response" has no attribute "jsonn"; maybe "json"?`.

**ruff in the editor, at 150ms.** The wasm was already vendored for the CLI, so this was the
wiring the last entry predicted. The one decision worth recording is that the `lint` handler sits
*above* the worker's `if (!pyodide) await boot(...)` — ruff is not a Python package, so a lint
costs 2ms and no interpreter, and markers land on a freshly opened file while the 30 MB CPython
behind completion is still starting. Its findings publish under their own marker owner, so mypy
arriving 550ms later does not erase them and neither tool being down blanks the other.

The judgement call: **ruff's `invalid-syntax` findings are dropped.** ruff reports an unparseable
file as ordinary diagnostics rather than by failing, so `x = ` — a line anyone is in the middle of
writing — comes back as "Expected an expression". At 150ms that is a red squiggle appearing under
the cursor during a pause for thought, which is the classic reason people turn linting off. mypy
still reports a file it cannot parse, on its longer pause.

**The interpreter is snapshotted, and every command after the first resumes from it.** This was the
biggest thing wrong with Python here and it was never a Python problem: a fresh process is a fresh
interpreter, ~1.8s of CPython initialising itself to produce the same bytes it produced last time.
Pyodide can serialise a booted interpreter's memory and start another from it. Measured end to end
through the real kernel: 1673ms cold, 176ms to restore, 61ms to write the 31 MB into the VFS and
49ms to read it back — about 0.25s per command instead of 1.8s, for the REPL, pytest, pip and
everything else.

The assumption worth being nervous about is that a snapshot made in one process can be restored by
another, which is a different JS realm. That is not provable with a stub and getting it wrong ships
a broken CPython to everyone, so the bridge tier makes one in a worker_thread and restores it in two
others, then imports, loads a package, writes a file and raises a traceback in each. The cache lives
in `/var/cache` — the kernel's existing place for transient caches, and on the OPFS ignore list,
because 31 MB that is only valid for one interpreter build has no business surviving a reload — with
a sidecar written after the bytes and read before them, so a half-written cache is one that disagrees
with its own record and is ignored.

**And stdin got a syscall, so `input()` waits.** The old refusal was honest and correct about the
mechanism: stdin arrived as a postMessage, receiving one needs a loop turn, and there is no loop turn
to be had inside CPython's read — so a keystroke could only arrive after `input()` had given up. What
was wrong was the conclusion. Blocking on shared memory is what every fs call here already does; stdin
just did not have an opcode. `OP_READ_STDIN` is shaped like `OP_FETCH`: the process parks on
`Atomics.wait`, the kernel registers it as the waiter, and a keystroke wakes it with the bytes in the
SAB. `input()`, `breakpoint()`, `pdb`, `getpass`, anything that asks a question.

Three things fell out of building it that were not in the plan:

- **Making the call has to switch that process's stdin routing**, or type-ahead is lost — a line typed
  between two reads would be posted to a flowing stream the synchronous reader never looks at.
- **A process nobody can type at must not park.** `capture: true` is the shape `spawnSync` uses, where
  the only party who could send stdin is itself parked waiting for this process to exit; it reads end
  of input at once, which is what `python x.py < /dev/null` does.
- **The REPL had to move to the same door.** It read the flowing stream, which was fine until stdin had
  two readers in one process: the first `input()` typed at a `>>>` prompt would have taken stdin away
  from the REPL permanently. One reader per process. The cost is that the process's event loop does not
  turn while a prompt waits, which is what CPython does at a `>>>` anyway.

The kernel half is proven in `verify-node.mjs` rather than the Python spikes, because that is the tier
that can run the real kernel: a real process really parks, stays parked through 150ms of silence, takes
a line through shared memory, keeps what was typed early, and a process that never makes the syscall
still gets stdin exactly as it did.

**Still uncovered:** notebooks, and scikit-learn as a template — still a size decision rather than a
technical one.

## Python, batch five — the other 4.7 seconds

The last batch cached the interpreter and called the start-up problem solved. It was not solved;
it was measured wrong. Booting CPython is 1.8s of a data-science script's wait, and the wait is
about six seconds. Where the rest goes, measured rather than assumed: `loadPackage` for numpy,
pandas and Matplotlib is 1283ms, and **importing** those three is 4691ms — `import pandas` alone
is 2349ms.

Almost none of that is pandas doing anything. It is CPython compiling about a thousand `.py`
files to bytecode, which is exactly the problem `__pycache__` has solved since 1994. The reason
it was not solving it here turned out to be one line in Pyodide: `sys.dont_write_bytecode`. There
were 0 `.pyc` files next to numpy after importing numpy.

So this feature has **no compile step in it**. Unsetting that flag costs an import nothing
measurable — 423ms against 420ms for numpy, which is noise — and the bytecode falls out as a side
effect of the import that was happening anyway. All that is left is keeping it and putting it
back. Across two real worker realms: 2550ms of importing cold, 639ms warm, 114ms to harvest, and
13ms for a run that adds nothing new.

Two things were load-bearing and neither was obvious:

- **A `.pyc` names its source's mtime, and every run gets new mtimes.** `loadPackage` unpacks the
  wheel afresh into each interpreter, so cached bytecode is stale on arrival — the first version
  of this cached 12 MB that CPython then ignored, at full price. PEP 552 hash-based `.pyc` is the
  format installers use for this exact reason, and converting one is 16 bytes of header surgery,
  not a recompile: the marshalled code object is byte-identical. `check_source=0`, because
  re-hashing every source on import is most of the I/O being avoided, and the claim that replaces
  it — a wheel's files do not change while its version does not — is the claim pip already makes.
- **`sys.pycache_prefix` needs its root to exist before the first import.** Without it the
  bytecode lands next to the source, and `__pycache__` directories appear in the user's file
  explorer and get mirrored back into the VFS as the script's own work. With it, and without the
  directory, CPython writes *nothing at all*: it builds the tree by walking up from the `.pyc`
  until it finds a directory that exists, and when that walk runs off the top it starts creating
  directories relative to the cwd instead. No error, no bytecode, and a probe that reports the
  feature simply not working.

Only packages are persisted, keyed on `name-version` and the interpreter's magic number. The
user's own modules are compiled too, but their bytecode stays in the per-process prefix under
CPython's ordinary mtime checking — their files change, and a file edited a second ago must never
run as a stale copy. Entries record a file count so that a package imported more deeply than last
time replaces a thinner entry rather than being skipped for the rest of the session.

The bridge tier harvests in one worker realm and restores in another, and then does it a third
time with the bytecode deliberately unreadable: that realm has to produce the same answers by the
slow path (2480ms against 639ms), because a cache test that only measures the fast case is
measuring whether the machinery ran, not whether it did anything.

**What was ruled out:** snapshotting an interpreter that already has pandas loaded, which would
skip the imports rather than speed them up. Pyodide validates the JS reference table against the
one it had at boot, and a single `loadPackage` is enough to fail it with `Unexpected hiwire entry
at index 6`. That is upstream's design, not a bug to work around.

**Still uncovered:** notebooks, and scikit-learn as a template.

## Python, batch six — breakpoints, in the panel that already existed

Every batch so far made Python *run* better. This one is about the part of the day spent
finding out why it did not: until now, debugging a `.py` file here meant `print()` or
`pdb` at a terminal, while the JavaScript next to it had gutter breakpoints, a call
stack, a variables tree and an expression box.

The interesting finding was how little needed building. The studio's debugger
(`debug-session.ts`, `DebugPanel.tsx`) speaks CDP, stores breakpoints per VFS path, and
has no opinion about language — **it did not change at all**. Neither did the transport:
the debug SAB and the park-the-worker-on-`Atomics.wait` trick were already there. What
was missing was a second backend on the other end of it.

And the Node backend's hardest part does not apply. It exists because a Web Worker has
no V8 inspector, so it parses the guest with acorn and weaves probes into every
statement to fake a call stack. CPython has had a debugging interface for thirty years
and the frames are real, so `python-debugger.js` is the protocol and the bookkeeping,
with the interpreter answering the questions only it can answer.

**`sys.settrace` is the obvious way to do this and it is the wrong one.** It is what
`pdb` uses, and it is called on every line of every function: 22ms → 217ms on a
300k-iteration loop, a debugger that changes the program it is measuring. PEP 669
monitoring (3.12+; this interpreter is 3.14) lets the callback answer `DISABLE`, which
retires that bytecode location for good — so a line that is not a breakpoint is asked
about exactly once, and the same loop is **23ms against a 22ms baseline**. A breakpoint
on the hot line itself is 83ms, on a line you are about to stop on anyway. Code outside
the project is dropped on first sight, so `import numpy` under a live breakpoint is
461ms — unchanged.

Three things were load-bearing and none was obvious:

- **`DISABLE` is permanent, and stepping needs those lines back.** A location that
  retired never fires again until `sys.monitoring.restart_events()`. Without that call,
  the first Step Over after a pause runs to the end of the program instead of moving one
  line — the breakpoint works, the debugger looks broken.
- **A module frame's locals open with three kilobytes of `__builtins__`.** `f_locals` at
  module level contains the entire builtins dict, whose `repr` is the whole thing. A
  Variables panel that shows it is unreadable, so the module dunders are filtered and
  every value is capped and expanded on demand rather than described up front.
- **`python` was on the kernel's debug skip-list, for a good reason that stopped being
  true.** `python` is a Node shim, so instrumenting it debugs our launcher rather than
  the user's script. Deleting the skip would have done exactly that. The fix is that the
  kernel now labels the target `debugLang: "python"` and the runtime attaches one backend
  or the other — never both, and never the wrong one.

The bridge tier runs a real interpreter through a scripted frontend: stop at a
breakpoint inside a function, read the locals, evaluate `acc + rows[2]['n']` in that
frame, Step Into, Step Over, Step Out, expand a dict two round trips deep, resume, and
confirm the program still printed its answer. That also exercises the one thing that
cannot be faked — JS calling back **into** the interpreter while the interpreter is
inside a call out to JS, the same re-entrancy the blocking stdin syscall relies on.

**Ruled out for now:** pausing on uncaught exceptions, and conditional breakpoints.
Both are small additions to this backend, but neither is worth shipping untested, and
the honest version of each needs its own bridge case.

**Still uncovered:** notebooks, `Ctrl-C` raising `KeyboardInterrupt` rather than killing
the process (Pyodide's `setInterruptBuffer` is not wired up), and scikit-learn as a
template.

## Python, batch seven — Ctrl-C (this change)

The debugger can stop Python on a line you chose. This is the other half: stopping it
on a line you did not choose, because it is in a loop that is never coming back.

Until now Ctrl-C killed a python process outright, and it had to: the kernel terminates
a guest that has no handler for a catchable signal, and this guest could not have one
that worked. While CPython runs, the worker thread is inside the interpreter, so the
pending-signal bitmask nobody is looking at stays unlooked-at, and no JS handler is
reachable. The process was not ignoring Ctrl-C; it could not hear it.

CPython solves its half already — its Emscripten build polls a byte of shared memory
and raises `KeyboardInterrupt` at the next bytecode boundary. So SIGINT is mirrored
into a byte of the process's **existing** syscall SAB (`control[5]`, until now reserved
padding), which needed no new channel and no new plumbing. Measured across a real
thread boundary: the interrupt lands **5ms** after the signal is sent, the interpreter
clears the byte itself, and it is still a working interpreter afterwards.

The two hard parts were both about honesty rather than mechanism:

- **The handler is registered only while the interpreter is running user code.** That
  looks like an optimisation and is not. Registering a SIGINT handler is what tells the
  kernel not to kill this process — a promise that can only be kept while there is an
  interpreter running to take the interrupt. At an idle REPL prompt the process is
  parked in the blocking stdin syscall and cannot run any handler at all, so Ctrl-C
  keeps its old meaning there. A Ctrl-C that is quietly swallowed would be worse than
  one that kills.
- **A process that handles a signal and carries on was force-killed five seconds
  later.** A REPL taking a KeyboardInterrupt back to its prompt is alive on purpose,
  and the kernel had no way to be told that. It does now — but *opt-in*. The one-line
  version, standing the window down whenever a handler ran, passed everything and
  would have removed the only thing stopping a guest that catches SIGTERM and ignores
  it from wedging the kernel; `scripts/spike-signals.mjs` has a scenario for exactly
  that guest, and it is the reason the automatic version did not survive. Escalation is
  now keyed on whether the guest **answered**, not on whether the signal repeated, so
  hammering Ctrl-C at something unresponsive still kills it while two deliberate
  Ctrl-Cs at a live prompt are two interrupts.

Tested where each claim lives: the interpreter half in the bridge tier, with a real
Pyodide in a real worker signalled by the real `postSignal` — including the negative
control that SIGTERM does **not** interrupt it, so the test cannot pass on a byte that
means nothing. The kernel half in `spike-signals.mjs`, against the real `Kernel` and
real worker threads: a guest that stands down outlives its grace window, its timer is
really cleared, and a second Ctrl-C is delivered rather than escalated.

**Two bugs this shook out, found by running it rather than by testing it.** Both were
invisible in the tiers above because both spikes named their own files absolutely and
drove the backend directly:

- **`python main.py` compiled the script as `main.py`.** That relative name becomes
  `co_filename` on every code object, and it is the only name a breakpoint can be
  matched against — while the editor's breakpoints are VFS paths, which are absolute.
  So nothing ever matched. It did not present as broken: the target appeared, the
  script ran, the target went away. The script is now resolved against the process cwd
  before it is compiled, and `sys.argv` is left as typed, which is what CPython does.
- **The start gate never told the kernel it had opened.** A debug target starts in
  SAB-routing mode, because until the gate opens the SAB is the only channel with a
  reader, and the kernel flips back to postMessage when it sees `Debugger.resumed` —
  which the Node backend emits and this one did not. Anything sent after the program
  started therefore queued where nothing would drain it until the next pause.

Both are now covered where they would have been caught: the offline tier drives the
real runtime through `runFile("main.py")` against the stand-in interpreter and asserts
the name it compiles under, and the gate is asserted to announce itself on both routes
out of it — the frontend saying run, and the timeout for a frontend that never came.
The stand-in transport was also made to honour its timeout, since one that answered
instantly made a bounded wait look instant.

**Still uncovered:** Ctrl-C at an idle prompt, which needs the blocking stdin read to
return EINTR and the kernel to cancel a parked reader — a change to the syscall channel
that deserves its own batch rather than a rushed corner of this one. Also notebooks,
scikit-learn as a template, and the debugger's pause-on-exception and conditional
breakpoints, which stay deferred: the studio sends neither `setPauseOnExceptions` nor a
condition today, so both would be backend code no UI can reach.

---

## A refused request reported the wrong error, twice (this change)

CI's `verify` job failed on one check: real Node's `lib/http.js` on llhttp-Wasm, at the
last of its assertions — a request to a port nobody serves should surface `ECONNREFUSED`.
It reported `ECONNRESET: socket hang up`. The check two lines above it, real `lib/net.js`
dialling a dead port, passed, and so did every HTTP spike. The failure predates the Bun
work; checking out the commit before it fails identically.

The cause was ordering, in the TCP binding rather than in http or net. libuv runs a
handle's close callback in the loop's close phase, and `Socket.prototype._destroy` is
written against that: it calls `handle.close(cb2)` — `cb2` emits `close` — and then
`cb(exception)` synchronously, leaving the stream to emit `error` on a tick of its own.
Our `close(cb)` used `process.nextTick`, which queued the close *ahead* of that tick. So
a failed socket emitted `close` and then `error`, the reverse of every other Node.

For a bare `net.connect` that inversion is invisible, which is why that check passed: the
test listens for both events and only reads the code. lib/http.js could not absorb it.
`socketCloseListener` treats a close with no error yet recorded as the server hanging up,
so the request got `ECONNRESET: socket hang up` first and the real `ECONNREFUSED` a phase
later — two `error` events on one request, the first one wrong, the second one arriving
after any caller had already handled and destroyed it. The event log, side by side with
real Node's on the same program, was the whole diagnosis:

```
before   net:close, net:error:ECONNREFUSED, http:socket,
         http:req-error:ECONNRESET:socket hang up, http:sock-close,
         http:req-error:ECONNREFUSED, http:sock-error:ECONNREFUSED
after    net:error:ECONNREFUSED, net:close, http:socket,
         http:req-error:ECONNREFUSED, http:sock-error:ECONNREFUSED, http:sock-close
real     net:error:ECONNREFUSED, net:close, http:socket,
         http:req-error:ECONNREFUSED, http:sock-error:ECONNREFUSED, http:sock-close
```

The fix is one scheduling change in both handles, TCP and Pipe: the close callback goes
through `setImmediate` instead of `nextTick`. That is the check phase, not quite libuv's
close phase — libuv runs close callbacks just after it — but the property lib/net.js
depends on is only that the tick queue drains first, and matching it exactly would mean
adding a loop phase for one callback.

What was missing was not coverage but a named invariant. The http check caught this, and
its message says nothing about ordering; the net check, which is where the bug lived, was
happy. Both now assert the sequence directly (`deepStrictEqual` on the event names) and
the http one counts its `error` events, since one error with the right code and two errors
starting with the wrong one are the same test if you resolve on the first one you like.
Reverting the fix now fails both, and the net check names the cause.

## A red check that was older than the commit that turned it red (this change)

*(Same defect as the entry above, found independently on this branch. That one schedules
the close callback with `setImmediate`; this one gives the loop the close phase libuv
actually has, and keeps `setImmediate` only as the fallback for the two probes that build
the module graph with no loop to hand it. The reading below is why it was worth writing
down twice: the check it turned red was older than the commit blamed for it.)*

`npm run verify` went red on master immediately after "a failing guest now fails", on a
single check: `Path B: real Node lib/http.js`. The obvious reading — a regression in the
change that preceded it — was wrong, and worth writing down because the correct reading
took a bisect to reach and the wrong one would have been reverted.

That change made an uncaught error in a callback fatal, which it had never been. The check
asserts `ECONNREFUSED` inside an `'error'` handler. What it had been receiving all along
was `ECONNRESET "socket hang up"` first, failing the assertion, having the throw silently
swallowed — and then receiving a **second** `'error'`, the real `ECONNREFUSED`, which
satisfied the assertion and let the test print its success marker. Two bugs, the newer one
holding the older one out of sight. Making uncaught errors fatal did not break the check;
it stopped the check from lying.

**The real defect is one line, and it is about which loop phase a close callback belongs
to.** `Socket._destroy` queues the `'close'` emit through `handle.close(cb)` and only then
calls `cb(exception)`, which is where the stream emits `'error'`. Our TCP binding scheduled
that close callback with `process.nextTick`, so it was queued *first* and won; libuv runs
close callbacks in their own phase, after the nextTick queue, so in Node the error wins.
Every failed socket in the VM therefore announced `'close'` before `'error'`.

*Nothing would have made that ordering look like the cause.* The component that reads it is
`_http_client.socketCloseListener`, which sees a close with no error recorded, concludes the
peer hung up, and synthesises a reset. So the visible symptoms were a wrong error code and a
duplicate event, two layers above the scheduling decision that produced them. And the
consequences reach past CI: an in-VM app calling a service that has not finished starting —
a dev proxy, a health check, anything with a retry — got a vague "socket hang up" instead of
`ECONNREFUSED`, plus a second `'error'` on a request Node guarantees emits exactly one,
which is enough to crash a handler that assumes otherwise.

The fix gives the loop a real close phase (`queueClose`, drained after `runImmediates()`,
counted in `hasRefWork()` so the loop cannot exit still owing a `'close'`) and moves both
binding close paths onto it. `verify` is green at 158 checks, and all 22 offline spikes pass.

**The gate runs Node instead of describing it.** `spike-net-close-order.mjs` executes six
scenarios — a refused `http.request`, a refused `net.connect`, nextTick/setImmediate against
close, a destroyed live socket, `server.close(cb)`, a clean close — on the HOST's real Node
*and* in the VM, and requires the two transcripts to be identical. Hand-written expectations
would only have pinned what I believed about Node, and I was wrong about one of them while
writing it: I asserted a `server.close(cb)` callback lands after a nextTick queued beside it,
and real Node does the opposite, because `Server.close` registers the callback with
`once('close', cb)` rather than passing it to the handle. The comparison caught my error
against Node in the same run it confirmed the VM was right. Explicit invariants follow the
comparison anyway, so a future Node that changes its own ordering fails loudly here rather
than quietly redefining "correct". Reverting the one-line change turns 9 of these red.

*Also folded in, both small.* The cookie jar shipped without bounds; it now refuses a cookie
over 4096 bytes and evicts the oldest past 180 per port, as browsers do — an unbounded jar is
a guest setting cookies in a loop, and an oversized cookie is dropped rather than truncated
because half a signed session id verifies as nothing rather than looking corrupt. And the six
files the last GitHub→GitLab sync left without a trailing newline have one again.
---

## `fs.cpSync` was missing, and `fs.cp(a, a)` quietly copied a file onto itself (this change)

`fs.cp` worked. `fs.cpSync` threw `ERR_METHOD_NOT_IMPLEMENTED`, and `fsPromises.cp` threw with
it, because `lib/fs/promises.js` wires `cp: wrap("cpSync")` — so the promise API inherited a gap
the callback API did not have. That is the wrong way round: `fs/promises` is the surface modern
code reaches for first, and `cpSync` is everywhere in build scripts. The roadmap had this filed
as "a one-line fix", which turned out to be wrong in an instructive way: re-routing
`fsPromises.cp` to the async implementation would have made the promise API work and left
`fs.cpSync` dead, so the one-liner fixes the symptom that was noticed rather than the gap.

*Upstream's `cp-sync.js` needs three helpers that are native in Node, and two of them we already
had.* The vendored body calls `cpSyncCheckPaths`, `cpSyncOverrideFile` and `cpSyncCopyDir` on the
fs binding. But `cpSyncCopyDir` is only a no-filter **fast path** — the file already walks the
tree in JS for the filter case — and `cpSyncOverrideFile` is its own `copyFile` with a stat. So
only the validation was genuinely missing, and it is now JS in `cp-sync.js`, above the binding
line because the errors it must throw are `ERR_FS_CP_*` classes that live there.

### Real Node as the oracle, because this is a thicket

The validation is a dozen `ERR_FS_CP_*` codes with specific precedence, and a hand-written
expectation would have pinned what I believed Node does. `scripts/spike-fs-cp.mjs` runs twenty
cases on the host's real Node and in the VM and requires identical transcripts — file, tree,
merge into an existing directory, `force: false` as a silent skip, `errorOnExist`, `filter`
(including a promise-returning one), symlinks, and the six ways it should refuse. Transcripts
carry no absolute paths, so the two sides are comparable. It answered questions I would have got
wrong by reasoning: `cpSync` **does** create a missing destination parent, and a directory
without `recursive` is `ERR_FS_EISDIR` rather than one of the `CP` codes.

*One deliberate divergence, and both sides of it are pinned.* Node 22's native
`cpSyncCheckPaths` reports `ERR_FS_EISDIR` for `cpSync(symlinkToAFile, dest,
{ dereference: true })` — its message even names the source with a trailing slash. The same
Node's async `fs.cp` copies the file, and so does its own `cpSync` once `recursive: true` is
added. Identical operation, three answers, so the sync refusal is an upstream bug and not a
contract worth reproducing. We copy the file. The spike asserts the host still misbehaves *and*
that we do not, so a fixed Node reports the divergence as obsolete instead of leaving a stale
exception in the tree for ever.

### The bug the spike found on its way past, which was worse than the gap

`src-equals-dest` came back `ok` from the VM while the host raised `ERR_FS_CP_EINVAL`. Node
decides "src and dest are the same file" with
`destStat.ino && destStat.dev && ino === ino && dev === dev`, and `writeStatsInto` reported
`dev` as **0** — so the conjunction was falsy, the check never ran, and `fs.cp(a, a)` walked on
into copying a file onto itself. This was never about `cpSync`: the **async** path had it too,
and that one has been reachable all along. `dev` is now `1` — one virtual filesystem, one device
id — which repairs both paths with a single value. The AGENTS.md gotcha is the general form: a
zero in a stat field is not a neutral default when a vendored module reads it as a truthiness
test, and `ino` being non-zero already is the only reason this was a silent wrong answer rather
than a crash.

*A second silent gap fell out of the same investigation.* `internalBinding('constants').os.errno`
held exactly one entry, `EISDIR`, so every other name the cp modules destructure was `undefined`
and every `ERR_FS_CP_*` error `fs.cp` has ever thrown carried `errno: undefined`. Destructuring
a missing constant is not an error in JS, which is why this never announced itself. It now
carries the POSIX table. The host is no oracle for that one — Node leaves `errno` off these
errors too — so the spike checks the numbers against POSIX directly, which is also what keeps
the table honest against `lib/constants.js`.

### Gating

`spike-fs-cp.mjs` joins the offline, Wasm-VFS group in `ci.yml`, so it runs on every push.
Reverting the `cp-sync.js` change turns 24 checks red; reverting `dev` alone turns exactly the
two that describe a self-copy red, which is the point of asserting it separately from the
transcript. `npm run verify` stays at 158 ✓ and the full offline tier at 23/23 — worth stating,
because `dev` and the errno table are read by everything that stats a file.

---

## `net.BlockList` was refused for want of a test suite, and the host was the suite (this change)

`{ ...net }` threw. Not "returned something odd" — threw, with
`Vivari: no vendored Node builtin 'internal/blocklist'`, because `net.BlockList` and
`net.SocketAddress` are lazy getters and neither module was vendored. Anything that enumerates
the module goes down with it, which is a promisify-all helper away from being a real user's
problem, and it was the last instance of the trap AGENTS.md documents for `fs`.

*It had been refused deliberately, and the refusal was right at the time.* A `BlockList` decides
whether to **accept** a connection, so a CIDR matcher that is subtly wrong is worse than an
honest throw — it beats the throw only in appearance. The recorded objection was
"reimplementing v4/v6 subnet matching in JS **with no test suite**", and that is the part worth
re-reading: the blocker was never the fifty lines of masking, it was having nothing to check
them against.

### Real Node is the test suite

`scripts/spike-net-blocklist.mjs` runs 45 cases through the host's own `BlockList` and through
ours and requires identical answers: every rule kind in both families, ranges that cross an
octet boundary, `/25` and `/33` prefixes that split a byte, `/0`, `/32`, the IPv4-mapped bridge
in both directions, the ten ways each API refuses, and `util.inspect` output. That is a stronger
oracle than any table I would have written, and it earned its keep on the first run by catching
a case I had already got wrong: RFC 5952 keeps the dotted-quad tail on an IPv4-mapped address,
so `::ffff:1.2.3.4` must not print as `::ffff:102:304`. Nothing else I had would have noticed.

*The bodies are the real ones.* `internal/blocklist.js` and `internal/socketaddress.js` are the
genuine v22.23.2 builtins, read out of a local Node via `process.binding('natives')` the way the
other vendored bodies here were, so the only code that is ours is
`internalBinding('block_list')` in `bindings/block-list.js` — which is where Node's is native
too. That split is the point: the JS above the binding line stays upstream's, and our substitute
sits exactly where the C++ was.

### Three smaller things it needed on the way

- **`internalBinding('symbols')` did not exist.** `internal/async_hooks` minted
  `owner_symbol`/`async_id_symbol` itself, which was fine while it was the only source — but the
  vendored blocklist reads them from the binding, and two mints mean two identities, so a handle
  stamped by one lookup is invisible to the other. The symbols are minted per realm in
  `internal-binding.js` now and `internal/async_hooks` reads them from there, so everything that
  already keyed on them (`lib/zlib.js`, `bindings/net.js`) keeps the same ones.
- **`internal/worker/js_transferable` is a shim, and says so.** The real one marks an object for
  Node's structured serializer through two more bindings. Nothing here goes through that
  serializer, so there is nothing to mark; the honest limit — a `BlockList` cannot be
  `postMessage`d to a Worker — is written down rather than faked.
- **`internal/url` gained `URLParse`**, the non-throwing parse `SocketAddress.parse()` needs to
  return `undefined` instead of throwing on rubbish.

*And one small consolidation.* The IPv6 literal parser written for `cares_wrap` moved out of
`bindings/net.js` into `bindings/ip.js`, because the block list needs the same one and two IPv6
parsers that disagree about an edge case would be worse than either of them being wrong.

### Gating

`spike-net-blocklist.mjs` is Wasm-free, so it joins the offline group that runs on every push
with no registration needed beyond `run-spikes.mjs`. `npm run verify` stays at 158 ✓ and the
offline tier is 24/24 — worth stating because moving where `async_hooks` gets its symbols from
touches every handle in the runtime.

---

## Sixteen templates stopped starting, and the tier that knew said nothing (this change)

`vite: "^8.0.0"` floated onto Vite 8.2.0, which depends on rolldown `~1.2.0`, which resolved to
**rolldown 1.2.2** — the release that dropped `@rolldown/binding-wasm32-wasi` from its
`optionalDependencies`. Up to 1.2.1 npm's platform auto-select installed that package on
`wasm32` and rolldown's loader found it with a plain `require`. After 1.2.2 nothing installs it,
so the loader falls through to its last route: a WebContainer fallback that
`execFileSync`s `pnpm i @rolldown/binding-wasm32-wasi@<version>` into `/tmp`. We advertise
`process.versions.webcontainer` on purpose — it is what makes Next pick its wasm SWC — so that
branch is ours to satisfy, and with only npm on the guest's PATH the spawn fails, the loader
swallows the error, and the dev server dies reporting `Cannot find native binding. npm has a bug
related to optional dependencies`. Which names the wrong cause: npm did nothing wrong, and there
was no optional dependency left to install.

Nothing in this repository changed. The templates broke on the day rolldown published 1.2.2.

*The fix is to declare the dependency*, in all sixteen `vite: ^8` templates and the four spikes
that cover them — the same move already documented for Next's `@next/swc-wasm-nodejs`, and better
than the fallback on its own merits: no registry fetch at dev-server start, and no dependence on
which package managers a particular guest happens to have. `spike-preact` goes from failing after
251s, having waited out the full 240s dev-server timeout, to passing in **15s**. All four Vite 8
spikes pass, in 11-16s each.

### The part worth more than the fix

Four spikes had been red for as long as it took someone to look, and nobody looked, because
`spikes-net` is `continue-on-error: true` and scheduled-only. The tolerance was justified when it
was written — 40-plus template installs against a live registry, and the tier would have been
noise — but its effect is that the job reports success whatever happens inside it. That is the
pm-gate lesson again, in its third form: **a report that cannot be negative is not a report.**
The first was a gate that did not run; the second an ok-flag initialised `true`; this one is a
job whose result is discarded.

So the six framework-template spikes get `template-gate`, a job that **can** go red, on the same
argument pm-gate was given. They are separable from the tier's tolerance on their own merits:
11-16s each rather than the 40-plus installs that made it noisy, one small tree apiece, and a
failure here is not registry weather but the product's headline surface refusing to start.
Registry drift is precisely what the job exists to catch, so tolerating it would defeat it.

*And the new job needed one guard of its own.* `run-spikes.mjs` exits 0 on an empty selection, so
a filter naming no registered spike would turn a red-capable job into one that proves nothing
while reporting success — the same defect, one level up. `spike-ci-tiers.mjs` already checked
that for the offline step; it checks every `--net` step now too, and mistyping `qwik` as `qwikk`
turns it red.

### What this does not fix

The binding's version range has to stay in step with rolldown's by hand. The check that would
reject a mismatched pair only runs under `NAPI_RS_ENFORCE_VERSION_CHECK`, so a drifting range
gets *used* rather than rejected, and the failure would be an ABI error rather than a missing
module. `template-gate` is what turns that from a silent outage into a red run, which is the
honest limit of a fix that pins a version by hand.

Two open questions left deliberately: whether the studio's own guests reach the pnpm fallback
successfully (they may, since `load-real-pnpm.js` can put a real pnpm on PATH — this change makes
the answer not matter for startup), and the Starlight note's older observation that rolldown
"does not load here" at all, whose reported symptom is a different one
(`Class extends value undefined`) and which is still why `astro` pins to 5.

---

## Every `fs` error said `ENOENT` and nothing else (this change)

`fs.readFileSync('/app/config.json')` on a missing file threw an error whose `code` was
`ENOENT`, whose message was the five characters `ENOENT`, and whose `errno`, `syscall` and
`path` were all absent. Real Node throws:

```
ENOENT: no such file or directory, open '/app/config.json'
```

Both errors are the same failure. Only one of them can be acted on.

### Why it was that way, and why nobody noticed

The syscall bridge has one string to spend. A VFS failure crosses the shared-memory window as
an errno name — that is the whole payload the Rust side sends — so `fs-client.js` does the only
thing it can with it, `new Error(code)`, and for a long time nothing added anything. The code
was right, so `err.code === 'ENOENT'` worked, which is the check almost everyone writes and the
only one most tests make. The four facts that were missing are missing *quietly*: reading an
absent property is not an error in JavaScript, so there is no failure to trace back — the same
shape of gap as the single-entry errno table two changes ago, and it went unseen for the same
reason.

What that costs is not evenly spread:

- **`err.syscall` is control flow, not decoration.** `rimraf` retries on `EBUSY`/`EPERM` only
  for the syscalls it recognises; `graceful-fs` queues and re-runs `EMFILE` failures the same
  way. An absent `syscall` reads as "some other error", so the recovery path silently does not
  run, and the resulting bug surfaces somewhere else entirely, usually as flakiness.
- **`err.path` is the difference between a log and a riddle.** "ENOENT" in a build log with a
  thousand file reads in it identifies nothing.
- **`err.errno`** still has a long tail of numeric comparisons behind it.
- **And the message is what a person actually reads**, which makes it the part that decides
  whether the runtime feels like Node when something goes wrong. Getting the properties right
  while leaving the message as a bare code would have fixed the libraries and left every human
  where they started.

### Where the fix goes

Not in the bridge, which cannot know more than it is told. In `bindings/fs.js`, the layer that
knows the operation *and* its arguments — which is exactly where Node builds these errors too
(`uvException`, `src/node_errors.cc`, not libuv). `SYSCALL_LABELS` maps each binding method to
the libuv syscall name and the argument indices its path and dest live at, and a wrapper
relabels bare codes on the way out. 48 failing calls now produce byte-identical errors to the
host's, message included.

Four things it had to get right that guessing would have got wrong:

- **The libuv name is frequently not the method name.** `readdir` reports `scandir`, `copyFile`
  reports `copyfile`, `utimes` reports `utime`, `realpath` reports `lstat` (Node walks the path
  with it), `truncate` and `readFileSync` both report `open`. `symlink` is the one call whose
  two paths are not in (from, to) order. `mkdtemp` reports the *template* — `x-XXXXXX`, six X's
  and all — because Node's native layer appends them before libuv substitutes them.
- **`readFileSync` on a directory is `EISDIR` from `read`, with no path at all**, while writing
  to one is `EISDIR` from `open` *with* a path. The reason is that opening a directory
  read-only succeeds on Linux and the failure lands on the next call; our VFS refuses the open
  in both cases, so the read-only variant is relabelled to the call the error would have come
  from. The mechanism differs from Linux's, everything observable does not.
- **The async path cannot be labelled by the wrapper**, because an async call hands its error to
  `oncomplete` instead of throwing it. `dispatch` labels that one, reading the in-flight call
  from a single-slot `callContext` — sufficient only because a syscall here is synchronous start
  to finish, the same property the `Atomics.wait` bridge is built on.
- **Only bare POSIX codes get labelled.** The `ERR_FS_*` errors the vendored `lib/` throws are
  Node's own, with their own shapes, and must pass through untouched.

### The gate, and the one thing it does not demand

`spike-fs-errors.mjs` runs every case on the host's real Node and in the VM and requires
identical transcripts — `code`, `errno`, `syscall`, `path`, `dest`, and the full message with
the scratch root scrubbed. A written table of expectations would have pinned what I believed
libuv's wording and numbers are; nine of the syscall names above are ones I would have gotten
wrong, and the host knew all of them.

One case is pinned as a deliberate divergence rather than fixed: `fsync` on a bad descriptor
throws `EBADF` on the host and succeeds here. `fsync` is a documented no-op — the VFS *is* the
storage, so a returned write is already as durable as it gets — and it deliberately skips fd
validation because `write-file-atomic` calls it after every write npm makes, and the check is
another synchronous round-trip on that path. A bad fd is a caller bug either way; catching it
would be paid for by every correct call. Both sides of the divergence are pinned, so if either
ever changes the spike says so instead of quietly allowing it.

---

## The rolldown binding, for the two spikes the last pass missed (this change)

`tailwind` and `vitest` were failing on the same "Cannot find native binding" that took out the
Vite 8 templates: rolldown 1.2.2 stopped declaring `@rolldown/binding-wasm32-wasi` as an
optionalDependency, so it has to be asked for by name. The templates and four spikes were fixed;
these two were not, because `tailwind` declares `vite: ^8` in a spike-local `package.json` and
`vitest` declares its dependencies on an `npm install` command line — neither of which the earlier
sweep looked at. `tailwind` goes from a 250s timeout to passing in 14s.

`vitest` clears the binding error and is still red, for a reason that turned out to be worth
more than the fix: it prints its banner and then exits **0, silently, having run no tests**. Four
plausible explanations were ruled out by probe before the real one turned up — an unref'd worker
failing to hold the loop open (workers hold it fine), unhandled rejections being swallowed (they
are reported, with the right exit code), output lost to `process.exit` (it is not, and the code
survives too), and `fork`/`spawn` being no-ops (both work). Pinning `vitest@^3` produces the same
silence one line later, so it is not a vitest 4 regression either.

The cause is that **a `MessagePort` cannot be transferred into a worker** — see the next entry.
`tinypool`, which is vitest's worker pool, gives every worker a port that way, and `vitepress`
fails on the same call with a visible `DataCloneError`. Both red spikes are one bug.

---

## A worker could not be handed a MessagePort, and a hung program reported success (this change)

Four fixes that turned up by pulling on one thread: why did `vitest` print its banner
and exit **0** having run no tests?

### The port that could not be transferred

`new Worker(f, { workerData: { port }, transferList: [port] })` threw DataCloneError,
and threw it in the *host*, inside the kernel's `spawnWorker`, where a guest cannot
catch it. That call is the handshake tinypool, piscina and synckit's `createSyncFn`
each use to give a worker its own channel, so it is every worker pool. `vitepress`
died on it outright.

The cause was duplication rather than logic: each environment that hosts processes
builds the process-worker `init` message itself — each opens its own channel to the
File System Worker — and there were **36 hand-written copies** of the transfer list.
The browser kernel's copy scanned `workerData` for embedded ports. The 35 in
`scripts/` did not, so those ports were left to be cloned, which a MessagePort cannot
be. `packages/kernel-host/worker-transfer.js` now owns the decision and all 36 call
sites use it; `spike-worker-pool.mjs` holds five shapes of the handshake to the host's
behaviour. `vitepress` goes from killing its host to serving 200s.

### `require.main === module` was false

`node` in the VM is a shim, and it ran the entry with `require(abs)` — which makes the
entry an ordinary child of the shim, leaving `require.main` at `/bin/node.js`. The
`if (require.main === module)` guard that a large share of npm's CLIs are built around
was therefore **false**, and those programs loaded their imports and quietly did
nothing. `Module.runMain(abs)` is the fix, and it pays for itself twice: it also hands
back the module's top-level-await promise, which the next fix needs.

### `-r` could not see the project's own dependencies

`node -r dotenv/config app.js` reported `Cannot find module 'dotenv/config' from
'/bin'`: preloads were resolved with the shim's own `require`, which lives at `/bin`,
rather than as if required from the working directory. A `createRequire` anchored at
the cwd fixes it, and `-e`'s injected `require` needed the same anchor. While there: a
preload that fails is **fatal** on Node, and warning-and-continuing had been running
programs without the instrumentation they asked for.

### An empty loop is an event, and a suspended program is not a success

Two things Node does when the loop runs dry that we did not. The first is emit
`beforeExit`, whose whole purpose is to let a listener schedule more work — so the loop
emits, drains, and looks again, and only a still-empty loop ends the process. The
second matters more: a main module still suspended on a top-level await exits **13**
with a warning naming the file, where we exited **0**, in silence, having done none of
the work. Zero is the one answer that cannot be debugged, because it is
indistinguishable from success.

`module.js` tracks the main module's evaluation promise for this. Note the nesting:
`runMain` is called twice for `node app.mjs` — the shim, then the user's file — and the
shim's call returns *last*, so the tracker must not let the outer call clear the inner
one's state. That bug cost an hour and would cost it again.

### What is still red, and what it is not

`vitest` is unfixed. It does not hang on a top-level await; it hangs on a floating
promise inside its pool — an await on something that never arrives, with nothing ref'd
holding the loop open. Node has no detection for that either, so nothing here can make
it loud; the difference is that on Node the message arrives. The four probes that ruled
out the easy explanations are recorded in the previous entry.

`next` is also red, and **was already red before any of this**: the same spike fails at
the commit before this stack, so it is drift under us (next@16 or the registry), not a
regression from these changes. Worth its own look — the failing check is the
workStore/workUnit invariant on an RSC refresh render, not startup.

## `vitest run` exited 0 having run nothing, and a port with no listener was why (this change)

The previous entry left `vitest` red and said so: "it hangs on a floating promise
inside its pool — an await on something that never arrives". That was the right
symptom and the wrong cause, and the two guesses that followed it were both aimed at
`Worker.unref()`, which is where the trace draws your eye.

`vitest run` printed **nothing**, exited **0**, and took 1.1 seconds. The negative
control — a suite with a deliberately failing assertion — also exited 0. So the
runner reported success for a test that would have failed, which is the worst
available answer, and it did it without a line of output to read.

**What it actually was.** Instrumenting the host with `getActiveResourcesInfo()` (and
writing the trace to a FILE, because logging to stderr creates the very pipe handle
that then shows up as the thing keeping the loop alive) leaves a window where the
only thing holding Node open is a single `MessagePort`. Both wasi workers report
`kHandle:false kPort:false kPublicPort:false` — every worker is unref'd. An
`async_hooks` init stack names the owner:

```
MESSAGEPORT init
    at new NodejsWaitingRequestCounter (@emnapi/runtime/dist/emnapi.js:2008)
    at new Context (@emnapi/runtime)
    at Object.<anonymous> (@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs)
```

which is:

```js
this.refHandle = new MessageChannel().port1
increase() { if (this.count === 0) this.refHandle.ref(); this.count++ }
decrease() { if (this.count === 1) this.refHandle.unref(); this.count-- }
```

Nothing is posted to that port. Nothing listens on it. It is a **handle**, ref'd for
the duration of a native async request and released after, and Node's loop counts it.
Ours had `if (!proto.ref) proto.ref = function () { return this; }` — so the counter
counted nothing, the loop went idle in the middle of rolldown's load, and the process
left while vitest was still waiting for it. `worker_threads` was in the trace because
that is where the work was, not because unref() was the mechanism.

**The rule, now measured rather than assumed.** A port holds the loop while it is
ref'd: by `ref()`, or by having a `'message'` listener (listening start()s a port, and
starting refs it). It stops on `unref()` or `close()`. The consequence that reads like
a contradiction until you see the mechanism:

```js
w.unref(); w.on('message', …)   // waits, and hears the reply
w.on('message', …); w.unref()   // exits, reply never arrives
```

`spike-port-liveness.mjs` runs eleven such cases against the host's real Node, one
process each, comparing transcripts.

Two things had to be got right underneath it. **Wrap, don't replace**: headless, the
platform `MessagePort` IS the host's Node `MessagePort` and the runtime shares its
realm, so that prototype also carries the runtime's own plumbing. Assigning
`port.onmessage` refs a port — Node's bookkeeping calls `ref()` from its newListener
hook — and the runtime does that on the Worker's half of the parent↔child channel and
on the raw port behind `parentPort`. Replacing `ref()` outright pointed those internal
calls at our counter and hung **every worker spawn**, a layer below anything a guest
could see; those two assignments now run inside `internalPortSetup(…)`, which
suppresses the guest hold while the runtime wires up its own ports. (Marking guest
ports at construction instead was tried and is not enough: `@emnapi/runtime` takes
`MessageChannel` off the global, not off `require('worker_threads')`, so the one port
that mattered would have gone unmarked — and vitest went straight back to exit 0.)
And **release has to wake the loop**:
`retain()` woke it, `release()` did not, so a release from inside a host callback — a
port delivery that closes its own port — left the loop parked in `waitForNext` with
nothing to look at. Retaining without waking misses work; releasing without waking
hangs a process that has just finished.

One deliberate divergence, recorded because it is a divergence: removing the last
`'message'` listener releases the port on Node, but `removeAllListeners('message')`
does not — same listener gone, same port state, and Node hangs. We release in both.
That can only turn a hang into an exit; the reverse is the direction that breaks
programs.

### Brotli is real now

`node:zlib`'s `brotliCompressSync` and friends threw a sentence naming the missing
engine. `packages/codec` now carries the pure-Rust `brotli` crate behind the same
binding shape as the zlib family, and `spike-zlib-brotli.mjs` cross-checks both
directions against the host's libbrotli — bytes we produce must decode there, bytes
it produces must decode here, because a codec that only agrees with itself proves
nothing about the wire format.

Two costs to know about. The constants table turned out to be load-bearing beyond
lookup: `lib/zlib.js` sizes its params array by the largest `BROTLI_PARAM_*` value in
`constants`, so with none defined the array was length 1 and every
`{ params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }` died as
`ERR_BROTLI_INVALID_PARAM: undefined is not a valid Brotli parameter` — naming the
caller's option instead of the missing constant. And the codec wasm went from ~50KB
to ~1MB (~485KB gzipped) for the encoder's tables and static dictionary, paid at
kernel boot. Zstandard stays absent for a *different* reason than brotli was: every
Rust zstd compressor binds the C library, which does not build for
`wasm32-unknown-unknown`.

### The rest of the sweep

`process.cpuUsage`/`resourceUsage` report elapsed time rather than throwing (callers
diff them across a span of work, and in a single-threaded worker over a busy span
elapsed time is roughly the CPU time — the same trade `memoryUsage` has always made).
`util.getCallSites()` is built on `Error.prepareStackTrace`. `sys` is `util`, as it
has been since 0.x. `trace_events` loads with tracing genuinely off, and
`getEnabledCategories()` answers `undefined`, which is what Node answers when nothing
is enabled. `dgram`, `domain` and `repl` deliberately stay `MODULE_NOT_FOUND`: they
are the modules callers feature-detect with `try { require(…) } catch {}`, and a stub
that loads and then throws on use turns a working fallback into a failure further
from its cause.

One bug fixed on the way past, from the crypto spike going red on a key it had
generated: RSA JWK members were fixed-width, so `d` kept a leading zero byte whenever
it happened to be under 2040 bits. RFC 7518 wants the minimum number of octets and
OpenSSL emits that, so ours differed from Node's for the same key — about one key in
256, which is exactly often enough to look like a flake.

## Two gates that were lying, and four constant tables that had drifted (this change)

### `next` was red for a redirect, and said "invariant REGRESSED"

The RSC-refresh gate re-issues the request the App Router makes after
`serverComponentChanges` and requires a clean render. It had been failing 0/8 — and
printing `← workStore/workUnit invariant REGRESSED`, which names a cause it had not
observed. The actual response:

```
[rsc 0] status=307  location=/?_rsc=f2VoNpDTu3vL93O1
```

Next 16 answers a bare `RSC: 1` GET with a 307 to its cache-buster URL and renders
Flight only there. The client follows it; the gate did not, counted eight redirects
as eight failures, and blamed the one thing it knows how to blame. A report that
names the wrong layer is worse than a bare failure — it sends the next person to
read `AsyncLocalStorage` code for a bug that is a missing hop. The gate follows the
redirect now, and counts "did not render (status)" separately from "the invariant
fired", so the next drift cannot borrow the invariant's name.

Worse, the gate had never tested what it was written for. Its own comment said to run
it with `VV_NO_HOST_ALS=1` — the flag that forces the best-effort
`AsyncLocalStorage` polyfill, the studio's browser-worker path, which is the *only*
configuration the workStore invariant reproduces in — and nothing set it, in CI or
out. It had been guarding the host's real ALS, which is not the thing at risk. The
runner sets it for this spike now, and the gate passes 8/8 with the polyfill forced.

### `vitepress` was reading the wrong response

`GET /guide/getting-started` returns a 415-byte app shell with no Shiki markup, so
the gate failed on `shiki=false`. Measured against a real host dev server, the host
returns *the same* 417-byte shell for `/` and for the guide route: `vitepress dev` is
a Vite SPA, and its markdown is a module the browser imports, not HTML the server
renders. The highlighting lives at `?import`:

```
GET /guide/getting-started.md          -> 132 bytes, text/markdown
GET /guide/getting-started.md?import   -> 8147 bytes, text/javascript, class=\"shiki …
```

So the route gate proves routing and the module gate proves highlighting — and
transform is still where a synckit deadlock would strand the request, which is what
this spike exists to catch. The assertion also requires `shiki` by name now:
`language-ts` alone matches the class Shiki is *asked* for, so it cannot tell
"highlighted" from "handed back untouched".

### The constant tables: four hand-written copies, all partial

Node builds every constants surface from one internal table. We had four copies, one
per consumer, and they had drifted from Node and from each other:

| surface | had | Node has |
|---|---|---|
| `os.constants.signals` | `{}` | 33 names |
| `os.constants.priority` | `{}` | 6 |
| `os.constants.dlopen` | absent | 5 |
| `fs.constants` | owner bits only | + group, other, `UV_FS_COPYFILE_*` |
| `crypto.constants` | 7 | 56 |
| `constants` (deprecated) | its own second copy of errno/signals, plus `WSAEINTR`/`WSAEBADF` on Linux | an aggregate of the table |

`os.constants.signals.SIGKILL` was therefore `undefined`, and
`child.kill(os.constants.signals.SIGKILL)` killed with `undefined`; a mode built from
`S_IRWXG | S_IROTH` came out `NaN`. Neither can announce itself, because reading a
missing constant is not an error — it is a number-shaped hole that only shows up in
whatever the caller does next.

There is now one table (`node/bindings/constants.js`) and the four surfaces are views
over it, as in Node. The values are the host's, dumped from a real Linux Node: the
OpenSSL `SSL_OP_*` bits are not derivable from anything we run — our crypto is Rust —
so they exist to be read and compared, and the only thing that makes them right is
matching Node's. `spike-constants.mjs` compares all five surfaces key by key and
value by value (`Infinity` is tagged, because `JSON.stringify(Infinity)` is `null`
and would have made `Z_MAX_CHUNK` "equal" to a host `null`), then checks the four
behaviours the gaps broke: a signal number that reaches kill(2), a computed mode that
round-trips through chmod, the deprecated aggregate agreeing with the modern views,
and zstd failing because the codec is missing rather than inside a parameter lookup.

Two deliberate subtractions. `zlib.constants` no longer carries `Z_TREES`,
`Z_BINARY`, `Z_TEXT`, `Z_ASCII`, `Z_UNKNOWN`, `Z_DEFLATED`: they are real zlib values
and Node does not expose them, and being a superset is the direction that makes code
work here and fail there. And `defaultCipherList` stays in `lib/crypto.js` rather than
in the table, because on Node it is a lib-level value (what `--tls-cipher-list`
replaces) — putting it in the table would have left the deprecated `constants` module
with one key more than Node's.

The ZSTD parameter names ARE there despite zstd being unimplemented, for the reason
the brotli round found the hard way: `lib/zlib.js` sizes its params array by the
largest `ZSTD_c_*` value, so without them a plain `zstdCompressSync(buf)` fails as
`ERR_ZSTD_INVALID_PARAM` naming the caller's option instead of the missing codec.

### `jwk-widths-rsa` was a coin flip, and had been for two rounds

It compared the byte widths of the host's RSA key to ours — two keys generated
independently, one per side. EC coordinates are fixed-width, so those cases were
sound; an RSA private exponent is minimally encoded, so its length is 256 bytes for
most 2048-bit keys and 255 for the ~1 in 256 whose top byte is zero. The two sides
therefore disagreed at that rate, and the failure looked exactly like the real bug
that had been fixed earlier in this branch (we exported fixed-width, Node exports
minimal), which is what made it worth chasing twice.

The case now uses a fixed 2048-bit key, checked into the spike, picked so that `d`
is one of the short ones: both runs export the same key, the comparison is exact, and
it is exact on the encoding the bug gets wrong. The transcript prints the widths
rather than only comparing them — `d=255` is the value that says the trimming is
live, and a silent ✓ is also what a fixed-width exporter looks like on the other 255
keys in 256.

One process note, since it cost a tier run: the earlier net tier reported
`rspack TIMED OUT (600s)` and it was not flaky. Files were being edited while the
tier ran, and rspack's worker loaded `constants.js` during the seconds it had a
syntax error — `SyntaxError: Unexpected token ','` is in that log above the timeout.
Re-run on a stable tree: 51/51.
---

## Two spikes that ran in no job they could survive (this change)

`toolchain-gate` went red on master right after the Node-fidelity pass, on two of
the nineteen offline spikes: `net-close-order` and `net-blocklist`, both with
`Cannot find module '../packages/vfs/pkg-node/vivari_vfs.js'` out of
`scripts/fs-worker.mjs`. Neither had failed anywhere else, and neither could:
that job is the Wasm-free one, and it is the only place in CI without the crates.

The registry entries said why, in their own comments. `net-blocklist` was
registered "Wasm-free: no filesystem is touched", and `net-close-order` "Wasm-free:
real Kernel and Workers, but the guests are three-line node:net scripts". Both
statements are true about the guests and neither is the question. Booting a kernel
starts the fs worker unconditionally, and the fs worker loads the VFS crate before
any guest gets to run — so a spike that touches no file still cannot start without
the crate that serves files. `needsWasm` is a claim about the boot, not the test.

The fix is the flag on both entries, their names added to ci.yml's Wasm-VFS step
(a `needsWasm` spike missing from that list runs in no job at all), and the
comments corrected, since the wrong ones are what made the omission look
deliberate to the next reader.

What is worth more than the fix is that `spike-ci-tiers.mjs` already existed to
prevent exactly this class — "a spike registered in a job that cannot run it" —
and it held the implication in one direction only: every `needsWasm` offline spike
must be named in CI. Nothing asserted that a spike which boots a kernel is one of
them. That gate is now there, scoped to the offline tier (the flag changes nothing
for a net spike, which only ever runs where the crates are built) and one-
directional on purpose: a dozen spikes mark `needsWasm` without calling
`bootSpikeKernel`, because they hand-roll a boot or load a crate directly, so
booting implies the flag and not the reverse.

The reason this needed a CI round-trip to find is worth naming: a developer's tree
has `packages/vfs/pkg-node` built, so the tier is green locally no matter how the
spike is registered. Reproducing it is one command — move that directory aside and
run the offline tier. Before: 17/19, the two failures above. After: 17/17, both
skipped with the note the other twenty get, and 39/39 with the crates present.