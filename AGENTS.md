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
  vfs/             Rust → Wasm VFS (inode tree, stat/symlink/rename, errno).
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
    node-gyp-stub.js     node-gyp no-op stub (native builds non-fatal) for real npm.
    load-real-npm.js     unpack the vendored real-npm asset into the VFS + shim /bin/npm.
    load-real-tsgo.js     unpack the vendored TypeScript-7 (tsgo, Go/wasm) asset + shim /bin/tsc,/bin/tsgo.
    programs/npm.js       from-scratch npm installer — LEGACY fallback (see real npm below).

  runtime/         The Node runtime that runs INSIDE each process worker.
    index.js       createRuntime(): wires builtins/globals/http-bridge/ws + run().
    module.js      synchronous CommonJS loader (require + resolution).
    toolchain-shims.js  single source of truth for native->wasm drop-ins (NATIVE_WASM_ALIASES).
    esbuild-inproc-patch.js  load-time, version-agnostic rewrite of esbuild-wasm's service to run in-process.
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
        http_parser.js  selects the HTTP parser: real llhttp-in-Wasm (default),
                        pure-JS fallback. Force with OC_HTTP_PARSER=js|wasm.
        llhttp/      llhttp compiled to Wasm (vendored from undici) + the bridge
                     (llhttp-parser.js) folding llhttp callbacks onto Node's
                     HTTPParser contract; regen the binary via scripts/vendor-llhttp.mjs.
      internal-binding.js / primordials.js / loader.js   glue for the above.

  studio/          The primary UI: a Vite + React 19 (React Compiler) + Tailwind v4
                   + shadcn/ui + Iconify app. Vite is the single toolchain and also
                   BUNDLES the worker roles below + the wasm (nested module workers
                   via `new Worker(new URL(...), {type:'module'})`, wasm via
                   `new URL(..._bg.wasm, import.meta.url)`). Run with `npm run dev`.
    vite.config.ts   COOP/COEP headers (dev + preview) + `Service-Worker-Allowed:/`
                     for /sw.js + `worker.format:'es'` + `server.fs.allow` (repo root,
                     so it can read the sibling worker/wasm sources) + React Compiler
                     (plugin-react v6 is oxc-based; the compiler is wired via
                     `reactCompilerPreset()` + `@rolldown/plugin-babel`) + `serveDevtools()`
                     (vendors the in-browser DevTools locally, no CDN → COEP-safe:
                     `/oc-devtools/chobitsu.js` = chobitsu UMD, `/devtools/**` = the chii
                     Chrome-DevTools frontend; streamed from node_modules in dev, copied
                     into dist on build).
    public/sw.js     the preview Service Worker, served at root scope (copied from demo/).
                     Injects, into every preview HTML: the WS shim (HMR) + chobitsu (CDP
                     backend) + a CDP/nav bridge; passes /oc-devtools/* straight through.
    public/devtools-host.html  host page for the chii DevTools frontend iframe (loaded
                     with `#?embedded=<origin>` → chii's postMessage transport).
    src/oc/kernel.ts      KernelBridge: spawns demo/kernel-worker.js, SW register +
                          oc-http relay, typed pub/sub over the worker protocol, PLUS
                          request()/oc-reply request-response (reqId-correlated) for VFS
                          queries (oc-readdir/oc-read/oc-stat) + oc-create-project.
    src/oc/controller.ts  IdeController: the imperative core (Monaco, xterm terminals,
                          preview, DevTools relay) as an external store React reads via
                          useSyncExternalStore. Since the multi-root rewrite: workspace =
                          workspaceFolders[] + activeFolderId; EVERY tab/model/dirty flag is
                          keyed by ABSOLUTE path; project create/open/run flows + a
                          localStorage recent-projects registry (oc-workspace-projects). Also
                          drives full-text search (runSearch/replace over the worker) +
                          openFileAt (reveal + select a match/line in Monaco).
    src/oc/templates.ts   10 project templates (React/Vue/Svelte/Express/Nest × TS/JS) —
                          manifest (install/dev/port/entry) + full source, inline.
    src/components/ide/   AppShell (+ Home overlay) · Home (Start blank / from template,
                          recents) · ActivityBar (Explorer/Search) · Explorer (VFS-backed
                          multi-root tree; context menu incl. Open in Integrated Terminal,
                          Copy Path) · SearchPane (VS Code-style full-text search & replace
                          across all roots: case/word/regex, include/exclude globs, Replace
                          All/per-file/per-match + preserve case) · EditorGroup
                          (preview/permanent tabs) · TerminalPanel (Console/Terminal/Ports) ·
                          PreviewPanel (multi-tab mini-browser: local address bar,
                          back/forward, reload, chii DevTools in a resizable bottom split) ·
                          StatusBar · CommandPalette (⌘P quick-open by name; append :line[:col]
                          to jump) · fileIcon (vscode-icons). Icons are Iconify via
                          unplugin-icons (`~icons/lucide/*`, `~icons/vscode-icons/*`; needs
                          @svgr/core) — do NOT reintroduce lucide-react.

  demo/            LEGACY raw-ESM UI (still runnable via `npm run dev:legacy` on
                   server.mjs). Its WORKER files are the shared runtime host and are
                   bundled by studio — do NOT delete them:
    host.js            legacy main thread: UI, SW registration, request relay.
    kernel-worker.js   hosts the Kernel; DEMOS registry + demo shell tabs (OC_RUN); the
                       multi-root VFS protocol (oc-readdir/read/stat/mkdirp/create-project,
                       oc-fs-changed; streaming oc-search + oc-replace) + dynamic project
                       run/attribution (projectDirByTerm, project-ready/-reload). [shared]
    fs-worker.js       hosts the File System Worker (VFS + OPFS). [shared]
    fetcher-worker.js  outbound fetch() (npm downloads). [shared]
    process-worker.js  one process = one worker (boots the runtime). [shared]
    sw.js              preview Service Worker (fetch → kernel → in-VM server). [shared source]
    index.html         legacy VS Code-style IDE (activity bar · Explorer · Monaco · terminal · preview).
    vendor/editor/     COMMITTED Monaco + xterm bundle for the legacy UI (studio uses npm instead).
  demo-dist/       GITIGNORED esbuild bundle of demo/ (legacy bundled path).

scripts/
  verify-node.mjs      headless end-to-end proof (no browser).
  verify-express.mjs   installs+runs real Express/Vite/ws (needs network).
  probe-*.mjs          framework discovery/regression probes (react/nest/realdev).
  spike-*.mjs          per-template/subsystem "does it boot + serve in-VM" proofs.
  lib/spike-harness.mjs   shared kernel-boot/install/waitListen/httpGet helper for spikes.
  run-spikes.mjs       CI runner over the spikes (tiers: --offline / --net / --all).
  process-worker.mjs / fs-worker.mjs   Node worker_threads entries for headless.
  build-demo.mjs       bundles demo/ → demo-dist/ with esbuild (legacy path).
  build-editor-vendor.mjs   bundles Monaco+xterm → demo/vendor/editor/ (legacy, re-run on bump).

server.mjs             static dev server for the legacy demo (sends COOP/COEP headers).
README.md · roadmap.md · research.md · ARCHITECTURE.md · AGENTS.md
```

---

## Golden rules

1. **Cross-origin isolation is mandatory.** `SharedArrayBuffer`/`Atomics` need
   `COOP: same-origin` + `COEP: require-corp`. Studio sends them from
   `packages/studio/vite.config.ts` (`server.headers` + `preview.headers` + a plugin
   that also stamps `Service-Worker-Allowed: /` on `/sw.js`); the legacy demo uses
   `server.mjs`. Serve it any other way and nothing works. All assets stay
   same-origin (no CDN) so COEP is satisfied — that's why Monaco/xterm are bundled
   from npm (studio) or vendored (legacy).
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

### The Fetcher strips non-CORS-safelisted request headers (browser only)
`demo/fetcher-worker.js` (`corsSafeHeaders`) keeps ONLY the CORS-safelisted
request headers (`accept`, `accept-language`, `content-language`, a simple
`content-type`) before calling the browser `fetch()`. Real npm/pacote attach
custom headers (`npm-command`, `npm-session`, `npm-auth-type`, `pacote-*`,
`authorization`, …); any non-safelisted header makes the browser fire a
preflight `OPTIONS`, and `registry.npmjs.org` does not answer it with a matching
`Access-Control-Allow-Headers` — so the request is blocked even though the
actual GET returns `Access-Control-Allow-Origin: *`. None of those headers are
needed to fetch public packuments/tarballs, so dropping them turns every
registry request back into a simple, preflight-free GET. This is a browser-only
concern (Node has no CORS), so the headless fetchers in `scripts/spike-*.mjs`
deliberately keep the full header set. (Symptom if you regress it: "blocked by
CORS policy … No 'Access-Control-Allow-Origin' header" for every registry URL.)

### Package downloads run in parallel via a NON-blocking async fetch
`OP_FETCH` parks the calling worker on `Atomics.wait` until the body lands, so
back-to-back downloads from ONE process (real npm pulling many packuments +
tarballs) serialize into a slow one-at-a-time crawl. `OP_FETCH_ASYNC`
(`packages/protocol/syscall.js`) is the non-blocking twin: the kernel ACKs the
syscall immediately (empty OK) and later posts the outcome back as a
`{type:'fetch-done', fetchId, …}` message, so a single worker can keep many
downloads in flight at once. The wiring, keep every link intact:
- `fs-client.fetchAsync(fetchId, url, opts)` sends `OP_FETCH_ASYNC` WITHOUT
  blocking (modeled on `spawnAsync`); `fetchId` is caller-chosen and must be
  per-process unique so the reply matches its request.
- `runtime/index.js` exposes `globalThis.__ocfetchAsync(url, opts)` (a Promise)
  and `dispatchFetch(msg)` which settles the pending promise on `fetch-done`.
  **Both** process-worker entries — `packages/demo/process-worker.js` (browser)
  and `scripts/process-worker.mjs` (headless) — MUST route `fetch-done` →
  `control.dispatchFetch`, or downloads hang.
- `node/lib/https.js` `_dispatch()` prefers `__ocfetchAsync` and falls back to the
  blocking `globalThis.__ocfetch`; keep the fallback (it's the compatibility path
  when async isn't wired).
- The kernel bounds fan-out: `fetchConcurrency` (10) via `_scheduleFetch` /
  `_drainFetchQueue`, dedupes identical in-flight URLs (`_fetchInflight`), and
  streams each body into the VFS (`_fetchIntoVfs` / `_doNetworkFetch`) with the
  SAME cache + dedupe as the blocking path. Don't drop the cap or the dedupe — a
  burst of npm downloads would otherwise open hundreds of sockets at once.

### `writeLarge` must transfer a STANDALONE ArrayBuffer
The kernel hands a fetched tarball to the FS Worker over a *transferred* buffer
(`kernel-fs.js` `writeLarge`), to bypass the 1 MiB SAB. The trap: a `Uint8Array`
is often a **view** into a bigger buffer — a `subarray`, or (the classic) a Node
`Buffer` carved out of the shared Buffer **pool**. Transferring that backing
`ArrayBuffer` either clobbers unrelated Buffers or, for a pooled Buffer under
Node ≥ 22, throws `Cannot transfer object of unsupported type` (the pool buffer
isn't transferable). Symptom: `npm install` dies mid-download with that error.
`writeLarge` now detaches the buffer only when the view owns it whole
(`byteOffset === 0 && byteLength === buffer.byteLength`); otherwise it transfers
an exact-bytes copy. Any new code that puts a typed-array's `.buffer` in a
`postMessage` transfer list must do the same.

### Native builds (node-gyp) are a non-fatal stub
Real npm runs a native package's `install`/`rebuild` lifecycle as
`node-gyp rebuild`; there's no compiler toolchain in-browser (and a `.node`
binary couldn't load — we run wasm), and our runtime can't execute npm's POSIX
`node-gyp` shell shim (it compiles programs as JS). So a non-zero node-gyp exit
would abort the whole install. `packages/kernel-host/node-gyp-stub.js` makes it a
no-op: `stubNodeGyp(kernel, npmRoot)` overwrites npm's node-gyp entry points in
the vendored tree with a JS stub (exit 0, warns), and a `node-gyp` coreutil is
the PATH fallback. Native compilation is skipped; the package's JS or
`wasm32-wasi` build is what actually loads. Don't "fix" a node-gyp failure by
trying to compile — that path is intentionally stubbed.

### esbuild/rollup are aliased to their wasm drop-ins — DON'T add per-project overrides
esbuild and rollup ship no `wasm32` build, and their WASM drop-ins live under a
DIFFERENT package name (`esbuild-wasm`, `@rollup/wasm-node`) that npm's
platform auto-select (which handles `*-wasm32-wasi` optional deps) can't reach.
Three runtime pieces close that gap generically, so projects stay vanilla — do
NOT re-introduce a `package.json` "overrides" block or a per-project launcher:
The native->wasm alias table is the single source of truth in
`runtime/toolchain-shims.js` (`NATIVE_WASM_ALIASES`) — add drop-ins THERE, not in
the fetcher. Requirements for a new entry: source+target published in lockstep,
target pure-JS/wasm, proven by a spike. It is guarded by `scripts/spike-toolchain.mjs`.
- **Registry aliasing** (`demo/fetcher-worker.js` imports `NATIVE_WASM_ALIASES`): a
  packument request for `esbuild`/`rollup` is served the drop-in's packument
  rewritten under the source name; npm then downloads the drop-in's real tarball
  into `node_modules/<source>` (versions are published in lockstep). Falls back to
  the un-aliased fetch on error. This is the `REGISTRY_PROXY`/`rewrite()` seam realized.
- **In-process esbuild** (`runtime/esbuild-inproc-patch.js`, invoked from
  `module.js` compile): esbuild-wasm's Node build spawns a child service whose
  stdio pipe deadlocks under a Piscina/tinypool loop; we rewrite `lib/main.js` at
  load time to run the Go service in this thread. VERSION-AGNOSTIC: it matches the
  spawn block with the version literal templated, so a point/minor bump still
  patches; on block-shape drift it `console.warn`s LOUDLY (never patch-fails
  silently → a hang). Idempotent; strict no-op for a genuine native esbuild
  (guarded on the wasm assets sitting next to `main.js`).
- **Worker-pool default** (`runtime/builtins/process.js`): `PISCINA_DISABLE_ATOMICS`
  defaults to `1` so pools use async message passing (a browser `MessagePort`
  can't be drained synchronously across a worker boundary, so the Atomics fast-path
  can't work). `worker_threads.receiveMessageOnPort` IS implemented (lazy per-port
  inbox) for libraries that poll it directly; just keep the Atomics path off. This
  is why the Angular template is now plain `ng serve`/`ng build` with no `scripts/oc-ng.mjs`.

### HTTP parser is real llhttp-in-Wasm, with a pure-JS fallback
`internalBinding('http_parser')` (`bindings/http_parser.js`) prefers **real llhttp
compiled to Wasm** (`bindings/llhttp/`, the binary vendored from undici via
`scripts/vendor-llhttp.mjs`) and transparently falls back to the pure-JS parser.
Gotchas:
- **Selection is automatic.** The Wasm module is compiled *synchronously* at
  binding time; that's allowed in Workers (where guest processes run) but throws on
  the main thread (4KB sync-compile cap), which is exactly what triggers the JS
  fallback. Force either side with `OC_HTTP_PARSER=js|wasm` (wasm = fail loud).
- **Both backends expose the identical contract** (numeric kOn* slots,
  `initialize/execute/finish`, `kOnHeadersComplete(major,minor,headersFlat,method,
  url,status,statusText,upgrade,shouldKeepAlive)`, `kOnBody(singleBuffer)`). The
  bridge (`llhttp/llhttp-parser.js`) mirrors Node's `node_http_parser.cc` and
  handles BOTH requests and responses; do NOT special-case it to responses.
- **`allMethods` order must match llhttp's method enum** (`llhttp/constants.js`) so
  `allMethods[llhttp_get_method()]` round-trips; don't reorder it.
- **When Wasm is live, `process.versions.llhttp` is set** — the verify suite + the
  offline `scripts/spike-http-llhttp.mjs` assert on it. Regenerating the binary =
  `node scripts/vendor-llhttp.mjs` (re-pins the undici source).

### In-VM databases are Wasm SQL engines loaded over the VFS (no native addon)
The `sqlite` (sql.js) and `pglite` (real PostgreSQL) Showcase templates run a SQL
engine guest-side by reading its `.wasm` out of `node_modules` and instantiating it
through host `WebAssembly`. Gotchas when touching them:
- **sql.js** loads its binary via `initSqlJs({ locateFile: (f) => require.resolve('sql.js/dist/'+f) })`
  — don't hand it a bare filename or it looks on a non-existent CWD path.
- **PGlite must be required via its CJS build** (`require('@electric-sql/pglite')`).
  Only the ENTRY module can block on top-level await in-VM, so an ESM `import` of a
  TLA-bearing dep from a non-entry module can hang. Its ~16 MB `pglite.wasm`+`.data`
  load from `node_modules` (`__filename` → `new URL('./pglite.wasm',…)` → `fs.readFile`),
  so keep `fs` + `url` (`fileURLToPath`) working over the VFS.
- **Its Emscripten glue does `const { createRequire } = await import('module')`.** The
  `module` builtin's export is the `Module` *function* with statics hung off it, so
  `__ocImport` (`runtime/index.js`) must copy own-enumerable keys for FUNCTION exports
  too, not only objects — otherwise the named import is `undefined` and PGlite dies deep
  in `create()` with a minified "e is not a function". Don't regress that interop.
- **libSQL is intentionally not a template** — local `@libsql/client` is a native
  N-API addon (no wasm32) and `/web` is remote-only; neither is a self-contained in-VM DB.
- **Gated by `scripts/spike-sqlite.mjs` + `scripts/spike-pglite.mjs`** (net tier in
  `run-spikes.mjs`; PGlite gets a longer timeout). Both stay `experimental` until green.

### The studio is a multi-root workspace — absolute paths + the VFS is truth
Since the workspace rewrite there is NO single "current project" and NO static file
map. Rules that bite if ignored:
- **Tabs/models/dirty are keyed by ABSOLUTE path**, never a project-relative one.
  `controller.openFile/saveFile/renameEntry/...` all take abs; the Explorer + quick-open
  pass abs. Don't reintroduce a `currentDemo`/rel-based path anywhere.
- **The Explorer reads the live VFS**, it does NOT render a JS file map. It lazy-loads a
  dir via `controller.readdir(abs)` (→ `oc-readdir` → `oc-reply`) and re-reads on a
  `treeVersion` bump. Any code that mutates the VFS from the worker MUST `post("oc-fs-changed")`
  so the tree/quick-open index refresh (writes, rename/rm/copy, create, installs).
- **Request/response goes through `KernelBridge.request(type)`** (reqId → `oc-reply`), used
  by oc-readdir/oc-read/oc-stat/oc-mkdirp/oc-create-project. Fire-and-forget `post()` stays
  for streaming stuff (term I/O, oc-write on save).
- **Created/opened projects are attributed to a dev-server port by pid chain**, not a port
  table: the run shell records `projectDirByTerm[terminalId]`, and `kernel.onListen` walks
  the listening pid up to that shell (`terminalForPid`) → project → `project-ready`. The two
  legacy DEMOS still use the fixed-port `demoForPort` path; keep them separate.
- **Templates live in `src/oc/templates.ts`** (manifest + full source, inline) — not a
  scaffolder run in-VM. Creation writes them in ONE `writeFilesBatch` via `oc-create-project`.

### Full-text search runs in the kernel worker — keep it non-blocking
The VFS is synchronous ONLY inside the kernel worker (the sole VFS holder), so full-text
search/replace lives there (`oc-search`/`oc-replace` in `demo/kernel-worker.js`), NOT on the
main thread — reading every file over `oc-read` round-trips would be death by a thousand
messages. But that same worker also serves preview HTTP + terminal I/O, so the walk MUST
stay cooperative: it `await`s a macrotask every N files and streams partial results back as
`oc-search-result` batches (final `oc-search-done`). Don't turn it into one big synchronous
loop or a preview/terminal will stall mid-search. A monotonic `currentSearchToken` cancels
an in-flight search when a newer query (or `oc-search-cancel`) arrives — always check the
token in the loop. After a replace writes files, the controller re-reads affected open
models from disk so the Monaco buffer + dirty state don't drift.

### Real npm is the studio shell's `npm` (delivery + shims)
The North Star is running the real npm/yarn/pnpm CLIs, not our from-scratch
`programs/npm.js`. In the studio that is now live: real npm@10.9.2 is vendored
and packed into one gzipped asset (`scripts/vendor-npm.mjs` →
`packages/studio/public/vendor/npm-pack.bin`, gitignored, built by
`npm run vendor:npm`, auto-run as `predev`/`prebuild:studio`). At boot the kernel
worker calls `ensureRealNpm()` (`packages/kernel-host/load-real-npm.js`) right
AFTER `installCoreutils()`. The loader unpacks the tree to
`/usr/lib/node_modules/npm`, runs `stubNodeGyp`, and writes `/bin/npm.js` +
`/bin/npx.js` shims that `require()` the real CLI. Gotchas:
- The npm tree persists in OPFS, so `ensureRealNpm` skips re-unpacking on later
  boots and only re-applies the shims (`hasRealNpm` guard). If you change the
  vendored version, bump/clear it or reset OPFS (`?reset`).
- **The Turbo-analog `programs/npm.js` is RETIRED** — it's no longer in
  `COREUTILS`, so real npm is the ONLY npm; a missing asset means "no `npm` on
  PATH" (like yarn/pnpm), NOT a downgrade to the analog. The analog lives on only
  as an offline test fixture that `scripts/verify-node.mjs` /
  `scripts/verify-express.mjs` install to `/bin/npm.js` themselves (they import
  `NPM_PROGRAM`). Don't reintroduce it into the product; fix things in real npm.
- Delivery uses ONE batched VFS transfer: the loaders call
  `kernel.writeFilesBatch(files)` (→ `FsServer.writeBatch`), which concatenates
  all bodies into a single transferable `ArrayBuffer` and mkdirp's+writes them in
  the FS Worker in one message — replacing the old per-file `writeFile` loop and
  the per-large-file `writeLarge` path (the batch carries multi-MB bundles
  inline). Any new tree-delivery loader should use `writeFilesBatch`, not a loop.
- Real npm needs `npm_config_cache` writable — the shell env sets it (created at
  boot). It (and the yarn/pnpm/corepack caches) now live under `/home/user/.cache`
  (+ pnpm store under `/home/user/.local/share/pnpm/store`), which IS mirrored to
  OPFS, so the content-addressed package cache PERSISTS and is shared across
  projects/reloads — install a dep once, later projects reuse the tarball with no
  re-download. Do NOT move these back under `/tmp` (excluded from persistence). The
  kernel's transient `/var/cache/oc-fetch` buffer is deliberately in the OPFS
  `IGNORE` list (its in-memory index is rebuilt per session, so persisting those
  bodies is dead weight — npm's cache is the durable copy). Keep this when editing
  `openTerminal` env / `fs-worker` IGNORE.
- The delivery asset is gzip-compressed but named `npm-pack.bin`, NOT `.gz`, on
  purpose: static servers (Vite's sirv, CDNs) serve a `.gz` file with
  `Content-Encoding: gzip`, so the browser auto-decompresses it and our own
  `DecompressionStream('gzip')` then fails on the already-decompressed bytes
  (symptom: fetch 200 but "load failed"). Don't rename it back to `.gz`.
- The kernel worker's fetch of the asset is same-origin and must bypass the
  preview Service Worker (`/vendor/` early-return in `sw.js`) — routing our own
  assets through `routeByClient` fails under COEP `require-corp`.
- Verify browser-shape changes headlessly with `scripts/spike-npm-studio.mjs`
  (it drives the SAME shared loader + PATH shims), not just `spike-npm.mjs`.

### Real yarn (classic) is the studio shell's `yarn` — same pattern as npm
Yarn is wired exactly like npm, one tier up: `scripts/vendor-yarn.mjs` packs
`yarn@1.22.22` into `packages/studio/public/vendor/yarn-pack.bin` (same archive
format; gitignored; `npm run vendor:yarn`, auto-run by `predev`/`prebuild:studio`).
`packages/kernel-host/load-real-yarn.js` (`ensureRealYarn`) unpacks it into
`/usr/lib/node_modules/yarn` and writes `/bin/yarn.js` + `/bin/yarnpkg.js` shims;
the kernel worker calls it right AFTER `ensureRealNpm()` at boot. Differences from
npm worth knowing:
- yarn's `lib/cli.js` is a single ~5 MB webpack bundle — far bigger than the 1 MiB
  SAB `writeFile` window, but that's a non-issue now: the loader delivers the whole
  tree via `kernel.writeFilesBatch` (one transferable `ArrayBuffer`), which carries
  the big bundle inline. No `writeLarge` per-file path needed.
- No fallback CLI: a missing asset just means `yarn` isn't on PATH (like npm now,
  since the Turbo-analog is retired). The shim is just applied after unpack.
- yarn needs a writable cache: the shell env sets `YARN_CACHE_FOLDER=/tmp/.yarn-cache`
  (created at boot), mirroring `npm_config_cache`.
- Headless browser-shape gate: `scripts/spike-yarn-studio.mjs` (`OC_NET=1` for the
  real `yarn add`). The off-disk Path B proof is `scripts/spike-yarn.mjs`.

### Real pnpm is the studio shell's `pnpm` — worker_threads + symlinked store
pnpm is wired like npm/yarn (`scripts/vendor-pnpm.mjs` → `pnpm-pack.bin`;
`packages/kernel-host/load-real-pnpm.js` `ensureRealPnpm` → `/bin/pnpm.js` +
`/bin/pnpx.js`; called after `ensureRealYarn()` at boot). What makes pnpm special:
- It drives real `worker_threads` (`dist/worker.js`) and a SYMLINKED `node_modules`
  (`node_modules/<pkg>` → `.pnpm/<pkg>@<ver>/…`). Both work because the
  Process-Worker model runs nested threads and the Rust VFS backs
  `symlink`/`readlink`/`lstat`. If either regresses, pnpm installs break where
  npm/yarn still pass — the canary is `scripts/spike-pnpm.mjs`.
- No hardlink/reflink CoW in our VFS, so packages must be COPIED from the store.
  A user types bare `pnpm add` (no room for flags), so the shell env carries the
  config the npm way: `npm_config_package_import_method=copy` +
  `npm_config_store_dir=/tmp/.pnpm-store` + `XDG_*` under `/home/user`
  (see `openTerminal`). Keep these when editing the env.
- `vendor-pnpm.mjs` DROPS `*.node` files: pnpm ships prebuilt reflink addons only
  for darwin/win; Linux uses the JS fallback, so they're ~1.3 MB of dead weight.
- `dist/pnpm.cjs` (~8.8 MB) exceeds the 1 MiB SAB window → loader uses writeLarge.
- Headless browser-shape gate: `scripts/spike-pnpm-studio.mjs` (`OC_NET=1`), which
  uses the SAME env (not CLI flags) so it verifies studio's actual config.

### Real corepack is the studio's PM version manager — DOWNLOADS + runs pinned PMs
corepack is wired like the PMs but is a *version manager*, not a package manager
(`scripts/vendor-corepack.mjs` → `corepack-pack.bin`;
`packages/kernel-host/load-real-corepack.js` `ensureRealCorepack` → installs ONLY
`/bin/corepack.js`; called after `ensureRealPnpm()`). It reads a project's
`packageManager` field, downloads that exact yarn/pnpm/npm release (gunzip + untar +
sha512 integrity), and execs it. What's special / must-not-regress:
- It ONLY adds `/bin/corepack.js`; it deliberately does NOT overwrite the direct
  `/bin/{npm,yarn,pnpm}.js` shims — those stay the defaults. corepack is the extra
  "run a project-pinned version" path (`corepack yarn …`, `corepack use pnpm@x`).
- It downloads via the GLOBAL `fetch()` (not the http/https kernel fetcher) and
  streams the tarball out of `response.body` through `Readable.fromWeb` —
  implemented in `node/internal/webstreams/adapters.js` as a reader pump. The
  reader's `read()`/`cancel()` promises settle off our loop, so they're wrapped to
  ref the event loop in `runtime/index.js` (next to the `fetch`/`Response` wraps);
  without that the process exits mid-download.
- It execs the downloaded PM in-process via `require('module').runMain(binPath)` —
  `runMain` is exposed on the `module` builtin (`runtime/index.js`), plus no-op
  `enableCompileCache`/`flushCompileCache` (so corepack skips `v8-compile-cache`).
- `crypto.Hash`/`Hmac` extend `stream.Writable` now (real Node's Hash is a
  Transform), because corepack does `stream.pipe(createHash(algo))` then
  `hash.digest()`. Don't revert them to plain objects.
- We can't do corepack's registry ECDSA signature check (`crypto.verify` is
  unsupported), so the shell sets `COREPACK_INTEGRITY_KEYS=0` — corepack's official
  escape hatch; the sha512 tarball-integrity check (via `createHash`) still runs.
  The env also carries `COREPACK_HOME=/tmp/.corepack` (cache) +
  `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` (see `openTerminal`). Keep these.
- Headless browser-shape gate: `scripts/spike-corepack-studio.mjs` (`OC_NET=1`
  downloads+runs yarn AND pnpm), using the SAME env (not CLI flags). The off-disk
  Path B proof is `scripts/spike-corepack.mjs`.

### Real TypeScript 7 (`tsc`/`tsgo`) is Go compiled to wasm — don't try to `require` it

TS 7's compiler is Go, not JS. We ship the community `tsgo-wasm` build
(`scripts/vendor-tsgo.mjs` → `tsgo-pack.bin`; `packages/kernel-host/load-real-tsgo.js`
`ensureRealTsgo` → installs `/bin/tsc.js` + `/bin/tsgo.js`). It runs on Path B because Go's
`wasm_exec` glue drives everything through `globalThis.fs` — which IS our real Node
`lib/fs.js` over the VFS — plus `crypto.getRandomValues`/`performance.now`/`TextEncoder`/
`WebAssembly`. Must-not-regress:
- The runner (written into `/usr/lib/tsgo/tsgo-run.js`) installs an `fs` whose **fd 1/2
  writes go to `process.stdout`/`stderr`** (Go writes program output via `fs.writeSync`/
  `fs.write`, which the VFS fs otherwise drops). It decodes to a UTF-8 string — passing a raw
  `Uint8Array` to `process.stdout.write` renders as CSV byte codes.
- `go.env` MUST stay tiny: Go's `wasm_exec` caps argv+env at ~12 KB of linear memory, so the
  runner passes only `TMPDIR`/`HOME`/`PATH`, not the whole shell env.
- It's ~11 MB gz, so the kernel worker loads it **lazily in the background after `ready`**
  (`loadTsgoInBackground`), with a "still downloading" placeholder shim installed at boot; the
  tree persists in OPFS. Don't move it into the awaited boot block.
- Headless proofs: `scripts/spike-tsgo.mjs` (off-disk Path B) + `scripts/spike-tsgo-studio.mjs`
  (shipped shim + shared loader). NOTE these need host **Node ≥ 22** — the vendored `fs.js`
  uses `Array.fromAsync`, which the browser's V8 has but Node 20 lacks (a headless-only quirk;
  in the browser it just works).

### Cross-service WebSockets + host↔preview bridge

- **`/preview/<port>/` ws routing.** The preview ws shim (in both `packages/studio/public/sw.js`
  and `packages/demo/sw.js`) parses a `/preview/<port>/…` ws URL and tunnels to THAT in-VM
  port (stripping the prefix); prefix-less URLs keep the iframe's own port, so **Vite HMR is
  untouched**. The kernel already routes ws `open` by port, so this is a shim-only change.
  Keep the two `sw.js` shims in sync. Regex lives in a template literal → backslashes are
  DOUBLED (`\\/preview\\/(\\d+)…`).
- **A preview tab per server.** `kernel.onListen` (in `kernel-worker.js`) opens a preview tab
  for each distinct port a project's run shell binds — primary → `project-ready`, extras →
  `project-ready {extra:true}` (the controller only adds a tab for extras). Ports are cleared
  when the run shell exits so a re-run re-announces. The `ws-demo` template exploits this: one
  `dev.js` starts an Express+`ws` backend (:3001) and a Vite frontend (:5173).
- **`host.opencontainer.internal`.** Maps to the studio's own hostname so in-VM code can reach a
  service on the HOST machine (only when the studio is served locally). Two egress paths both
  honor it: `http`/`https` (and npm) go through `packages/demo/fetcher-worker.js` `rewrite()`;
  the **global `fetch()`** is the host realm's real fetch (used directly, not via the Fetcher
  Worker), so `packages/runtime/index.js` rewrites the alias in its own `fetch` wrapper
  (`rewriteHostAlias`). Reverse direction: the host hits `<studio-origin>/preview/<port>/…`.
  Addressing convenience only — the target still needs ACAO + a COEP-satisfying CORP. Not wired
  into the preview tab URL bar; test it from in-VM code (`node probe.mjs`), not the address bar.
- Headless proof: `scripts/spike-ws-demo.mjs` (real `ws` backend, both directions via the
  kernel tunnel).

### Preview iframes must start at about:blank, THEN navigate
On a FRESH page load the studio document is fetched before the preview Service
Worker takes control, so a brand-new iframe whose *first* navigation is a direct
`/preview/<port>/` URL is NOT intercepted by the SW — the request escapes to the
network and the studio's own SPA fallback serves its Home page INSIDE the frame
(symptom: "Run React template → preview shows the OpenContainer Studio page, not
the app"). The manual address-bar path never hit this because its iframe starts at
`about:blank` (a client the SW already controls) and only THEN navigates. The fix
lives on the client (the SW can't intercept a frame it doesn't control), and the
invariant to preserve:
- `PreviewPanel.tsx` renders every preview iframe through the `PreviewFrame`
  component, which mounts with NO in-scope `src` (about:blank) and sets the real
  `c.previewSrc(t)` imperatively in an effect (guarded by a `lastSrc` ref so
  StrictMode / re-renders don't double-navigate). Do NOT go back to
  `src={c.previewSrc(t)}` on a freshly created iframe.
- `kernel.ts` `registerServiceWorker()` also waits for the page to actually be
  controlled (`controllerchange`, with a 1 s safety timeout) when
  `navigator.serviceWorker.controller` is null, so control is established before
  boot/preview.

### `module` is a REAL constructor — route requires through `Module._load`
`require('module')` returns the `Module` **constructor** (not a plain object);
`builtins.module = Module` in `runtime/index.js`, statics/prototype wired in
`module.js`. The load-bearing rules:
- `makeRequire`'s `require` calls `Module._load(request, parent)` and
  `require.resolve` calls `Module._resolveFilename(...)`. Keep it that way — it's
  what lets ts-node/tsx/jest/proxyquire/module-alias monkeypatch requires. Don't
  "optimize" it back to calling `load()`/`resolveFilename()` directly.
- `runMain` publishes the entry as `require.main`/`process.mainModule`/`Module.main`
  **before** compiling its body (so `require.main === module` is true in the entry),
  and `require.main` is a **live getter**. Don't snapshot it.
- Exposed: `_load`, `_resolveFilename` (honors `options.paths`), `_nodeModulePaths`,
  `_cache`, `_extensions`, `wrap`/`wrapper`, `isBuiltin`, `createRequire` (accepts
  `file://` URLs), `syncBuiltinESMExports`, no-op `register`/`registerHooks`,
  `prototype.{require,load,_compile}`. `builtinModules` is the public list only
  (snapshot BEFORE the `node:` aliases are added — don't move that line after).

### vitest runs in-VM — pool=threads, and don't break these
Real `vitest@4` (Vite/rolldown) runs a suite to green in-VM — gated by
`scripts/spike-vitest.mjs` (installs it with real npm → wasm rolldown, runs a
2-test suite + a negative-control failing suite). Must-not-regress:
- `vm.runInThisContext` uses **indirect `eval`** (returns the script's completion
  value). Vitest wraps each module as `'use strict';async(…)=>{…}` and *calls* what
  `runInThisContext` returns; `new Function(body)` would return `undefined`. Don't
  revert to `new Function`.
- `esm.js` `skipBalanced` descends **regex literals** inside `` `${…}` ``
  interpolations. Without it, a `"` inside a regex desyncs the scanner and drops
  later top-level `export`s ("Unexpected token 'export'" in bundled files like
  `@vitest/pretty-format`). Keep the regex branch.
- `worker_threads` `Worker.stdout`/`.stderr` are inert but **pipe-able** Readable
  stubs (the pool does `worker.stdout.pipe(...)`); `process.stdout` has
  `getMaxListeners()`. `process.execArgv` is `[]`. `node:path/posix`/`win32` are
  registered.
- Invoke with `--pool=threads` (we have `worker_threads`, not `fork`).
  Config-file bundling (`vitest.config.*`) still fails in rolldown-wasm
  ("Invalid URL") — pass options as CLI flags for now.
- `OC_TRACE_MODULES=1` (propagate via the process env) names the module whose
  top-level eval throws — the fastest way to localize a bundled-tool bring-up bug.

### fs.ReadStream / fs.WriteStream MUST stay ES5 function-constructors
`node/internal/fs/streams.js` defines `ReadStream`/`WriteStream` as plain
`function`s (auto-`new` guard + `Readable.call(this)`/`Writable.call(this)` init),
NOT ES6 `class`es — matching real Node on purpose. graceful-fs (bundled by yarn,
fs-extra, and much of the ecosystem) subclasses them by doing
`fs$WriteStream.apply(this, arguments)` on a bare object; an ES6 class throws
"Class constructor WriteStream cannot be invoked without 'new'" there and kills
the install at the "Fetching packages" step. It also reassigns `fs.WriteStream`
via `lib/fs.js`'s `set WriteStream(val)` setter, so `createWriteStream` then runs
graceful-fs's wrapper. If you ever rewrite these as classes, yarn/fs-extra break.

### Enumerating `fs` trips its lazy getters — vendor every internal it names
`lib/fs.js` exposes several members as lazy getters (`get Utf8Stream` →
`internal/streams/fast-utf8-stream`, and `defineLazyProperties(fs,
'internal/fs/dir', ['Dir','opendir','opendirSync'])`, plus streams/promises).
Code that *enumerates* `fs` — yarn's `thenify-all` does `promisifyAll(fs)`, i.e.
touches EVERY key — fires those getters, and a missing target module throws
`no vendored Node builtin '…'` even though nothing uses the feature. Both
`internal/streams/fast-utf8-stream` and `internal/fs/dir` are now provided
(pragmatic, functional shims) and registered in `node/loader.js`. If you add a new
lazy `fs` getter, register its module too, or bare enumeration will crash.

### `process.binding(name)` is a real (legacy) surface some bundles need
Deprecated in Node but still called by bundled deps (yarn's `safer-buffer` →
`process.binding('buffer').kStringMaxLength`, `builtin-modules` →
`Object.keys(process.binding('natives'))`, a `constants` polyfill, a `util`
legacy path). `runtime/index.js` wires `process.binding` to delegate to the same
`internalBinding` seam the vendored Node lib uses (`loader.js` exports it);
`'natives'` (source strings we don't have) becomes a name→'' map so `Object.keys`
still yields the core-module list, and unknown names return `{}` instead of
throwing. Don't remove it — several ecosystem packages break without it.

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

### Async `fs.*stat` must not share the `statValues` scratch buffer
`bindings/fs.js` fills one shared `statValues` Float64Array in place (this is
Node's real `binding.statValues` contract, and it's fine for **sync** stat — the
JS reads the array in the same tick). But the **async** path (`stat`/`lstat`/
`fstat` with an `FSReqCallback`) delivers the result via `process.nextTick`, and
`makeStatsCallback` only reads the array *then*. If it hands back the shared
buffer, any stat that runs in between clobbers it, so the callback sees **another
entry's stats** — classically a directory reported as a regular file. Symptom:
chokidar/Vite watch the project root, `stat(root)` comes back `isDirectory()===
false`, so chokidar treats root as a file, never recurses, never file-watches,
and **HMR/edits silently do nothing** (no error). Fix in place: async stat calls
pass `fresh=true` to `makeStatArray` so each result is a private snapshot. Rule:
any deferred/async syscall result that references a shared scratch buffer must
snapshot it at call time, not at delivery time.

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
- **Next.js 16 (App Router) works in-VM** on `next dev --webpack` + the
  `@next/swc-wasm-nodejs` wasm SWC (the runtime reports `process.versions.webcontainer`,
  so Next's `loadBindings` prefers the wasm build; npm skips native
  `@next/swc-<platform>` on arch `wasm32`). Only **Turbopack** is out (native Rust,
  no wasm build) — use `--webpack`. Proven by `scripts/spike-next.mjs`; shipped as the
  `experimental` **Next.js** template. Vite (rolldown, wasm) is still the default
  bundler path for the other templates.

### Ports & long-lived servers
Each demo binds a port; a leftover long-lived server squatting a port causes
`EADDRINUSE` for the next run. The kernel worker's `boot()` deliberately does
**not** auto-run any server — a demo starts on demand when "Run" opens a shell tab
that auto-runs its dev command (`OC_RUN`, via `openTerminal`). Closing that tab
kills the server subtree and frees the port. Don't reintroduce a background server
into `boot()`, and don't route dev-server output anywhere but its shell tab.

### Killing a process must kill its subtree
`kernel.finalize(pid)` cascades to every process whose `parentPid === pid` (and so
on, recursively). This matters because servers are usually spawned behind a shell
wrapper: `nest start --watch` runs the app as `spawn("node ... dist/main", {shell:
true})`, which our `child_process` turns into `sh -c "node ... dist/main"`, and the
`/bin/sh` builtin then spawns `node` as its **own** child. So `childProcessRef.pid`
is the *shell's* pid, not the server's. On each recompile NestJS `process.kill()`s
that pid; without the cascade only the shell dies, the real `node` server is
orphaned, keeps its port bound, and the respawn hits `EADDRINUSE`. Well-behaved
parents `await` their children before exiting, so on a *normal* exit there are no
live children to cascade to — this only fires on an actual kill. Two enablers this
relies on: `process.kill(pid, sig)` is wired in `runtime/index.js` to
`syscalls.kill` (Node tools manage their own children by pid), and
`child.stdin` is a full no-op stream (`pause`/`resume`/`cork`/… all chainable) —
NestJS's watch restart calls `child.stdin.pause()` before killing.

### Interactive stdin is event-driven, delivered off the SAB
`process.stdin` is a real flowing **TTY Readable** (isTTY, setRawMode), NOT a
blocking `read()` syscall. Keystrokes arrive from the host as a kernel→worker
`{type:'stdin', chunk}` postMessage (same out-of-band channel as async child
stdout), get queued, and are pushed into the Readable inside a loop turn
(`doStdin`) so the 'data' handler runs with microtasks flushed after it — never
push straight from the worker's `onmessage`. While a consumer is actively reading
(flowing / has a 'data' listener) stdin refs the loop (`stdinLiveness`) like an
open TTY handle, so an idle shell waits for input instead of exiting; `resume()`/
`pause()` toggle that ref. Parent→child piping (`child.stdin.write`) relays
`{type:'child-stdin', childPid}` → `kernel.handleChildStdin` → the child's own
stdin. The host terminal → shell path is `term-input` → `kernel.sendStdin(pid)`.
The interactive line editor (echo, backspace, Ctrl+C→SIGINT the foreground child)
lives in the `sh` coreutil, not in a TTY line discipline — there's nothing cooked
below it. Terminals use xterm `convertEol:true`, so guest code should emit `\n`
(don't double it to `\r\n`).

### OPFS persistence
The VFS mirrors to OPFS and **survives reload**. If a demo behaves as if old files
linger, that's why — use `?reset` on the demo URL to wipe it. Restore happens
before any syscall is served.

---

## Testing & verification

The runtime runs headless under Node `worker_threads`, so validate without a
browser first.

- `npm run verify` — `scripts/verify-node.mjs`, headless end-to-end (fs, process,
  shell, http, timers, watch, worker_threads incl. `receiveMessageOnPort`). **Run
  this after any runtime/protocol change.** No network needed.
- `npm run spikes` (`scripts/run-spikes.mjs`) — the CI runner over the per-template/
  subsystem spikes. Tiers: `npm run spikes:offline` (Wasm-free, seconds — e.g. the
  `spike-toolchain.mjs` subsystem guard), `npm run spikes:net` (installs real
  templates from the registry; auto-vendors npm to `/tmp/oc-vendor`). Wired into
  `.gitlab-ci.yml`. **A template must have a green spike before it graduates out of
  `experimental`** — add `spike-<name>.mjs` (use `lib/spike-harness.mjs`) and list it
  in `run-spikes.mjs`.
- `node scripts/verify-express.mjs` — installs + runs real Express, esbuild-wasm,
  a Vite build, Vite dev+HMR, and a real `ws` server. **Needs network** (npm).
- `node scripts/probe-realdev.mjs [vite|nest]` — the demo's exact flow headless:
  scaffolds the real project, `npm install`s, runs `npm run dev` / `npm run
  start:dev`, and asserts the colored banner/logs + a served response. **Needs
  network.** `probe-react.mjs` / `probe-nest.mjs` are the older API-gap probes.
- `node scripts/probe-term.mjs` — interactive terminal: launches a live `sh`, feeds
  keystrokes via `kernel.sendStdin`, asserts echo + `cd`/`pwd`/backspace. No network.
  `probe-nest-watch.mjs` validates the Nest save→recompile→restart reload.
- Browser smoke test: `npm run dev` (studio, Vite — opens on `http://localhost:5173`
  by default), pick a project + Run, then check the terminal (Vite/Nest colored
  output), edit a file in Monaco (⌘S to save → HMR/restart), and the preview iframe.
  Legacy UI: `npm run dev:legacy` → `http://localhost:8080/packages/demo/index.html`
  (bundled: `npm run build:demo` → `packages/demo-dist/index.html`).
- Headless studio check (no manual browser): the studio exposes `window.__ide` (the
  IdeController) in dev, so a CDP script can drive the whole flow — boot, assert
  `crossOriginIsolated` + kernel ready, `window.__ide.setSelectedDemo('react'|'nest')`
  + `window.__ide.runDemo()`, then poll the preview iframe's src + rendered content.

When you add a Node API or a binding, add/extend a probe or a `verify-*` case so
the gap can't silently regress.

---

## Common workflows

- **Fix a framework crash**: reproduce headless with a `probe-*.mjs` (copy an
  existing one), read the minified stack to the offending `lib/`/binding, implement
  the missing piece in `runtime/node/`, re-run the probe + `npm run verify`.
- **Add a demo**: extend the `DEMOS` registry in `demo/kernel-worker.js` with a
  REAL project layout (`files` = relative path → contents, exactly what `npm create
  …` emits), plus `dir`, `port`, `entry`, and a `runCmd`/`runArgs` that is the
  project's own dev script (e.g. `npm run dev`). Add the option to the `DEMOS` array
  in `studio/src/oc/controller.ts` (id + title + run label) — and, for the legacy UI,
  the `<select>` in `demo/index.html`. "Run" opens a dedicated shell tab whose `sh` auto-runs
  `OC_RUN="npm install && <runCmd runArgs>"` (`scaffoldDemo()` writes the files once;
  install is skipped once `node_modules` exists), so the **dev server lives in that
  tab** — closing it stops the server, a double-run `EADDRINUSE`s (not intercepted).
  Preview wiring is driven by `kernel.onListen` (see `announceDemoReady`): first real
  listen → probe-until-serving (+ Vite warm) → point preview; a later listen on an
  already-serving port = a Nest `--watch` restart → reload. `hmr: true` = hot-update
  on save; `reload: true` = server restarts on change. Edits from Monaco write
  straight to the VFS — the project's own watcher does the rest; no build/restart
  orchestration in the worker.
- **Change the syscall ABI**: edit `protocol/syscall.js` (+ its format comment) and
  update all three sides (`fs-client.js`, `fs-server.js`, `kernel.js`) together.
- **Ship a bundle**: `npm run build:demo` (regenerates `demo-dist/`, stamps a new
  `BUILD_ID` so the SW precache re-versions).

---

## Where to look next

- **How it works** → [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- **Why it was built this way / status per feature** → [`roadmap.md`](./roadmap.md)
- **Background research** → `research.md`
