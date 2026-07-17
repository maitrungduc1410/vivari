# AGENTS.md

Guidance for AI agents (and humans) working in this repo. Read this first, then
read [`ARCHITECTURE.md`](./ARCHITECTURE.md) before touching the runtime, the
protocol, or networking. [`roadmap.md`](./roadmap.md) is the chronological log of
what was built and *why* — search it before assuming something is missing.

---

## What this project is

Vivari is an open-source **WebContainer**: it runs Node-style projects
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
                        pure-JS fallback. Force with VV_HTTP_PARSER=js|wasm.
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
                     `/vv-devtools/chobitsu.js` = chobitsu UMD, `/devtools/**` = the chii
                     Chrome-DevTools frontend; streamed from node_modules in dev, copied
                     into dist on build).
    public/sw.js     the preview Service Worker, served at root scope (preview proxy).
                     Injects, into every preview HTML: the WS shim (HMR) + chobitsu (CDP
                     backend) + a CDP/nav bridge; passes /vv-devtools/* straight through.
    public/devtools-host.html  host page for the chii DevTools frontend iframe (loaded
                     with `#?embedded=<origin>` → chii's postMessage transport).
    src/vv/kernel.ts      thin studio extension of @vivari/core's KernelBridge (which spawns
                          packages/core/src/workers/kernel-worker.ts, does SW register +
                          vv-http relay, typed pub/sub, and request()/vv-reply reqId round-trips
                          for VFS queries). Adds only the studio `?compress=0` / `?reset` toggles.
    src/vv/controller.ts  IdeController: the imperative core (Monaco, xterm terminals,
                          preview, DevTools relay) as an external store React reads via
                          useSyncExternalStore. Since the multi-root rewrite: workspace =
                          workspaceFolders[] + activeFolderId; EVERY tab/model/dirty flag is
                          keyed by ABSOLUTE path; project create/open/run flows + a
                          localStorage recent-projects registry (vv-workspace-projects). Also
                          drives full-text search (runSearch/replace over the worker) +
                          openFileAt (reveal + select a match/line in Monaco). Wires Monaco's
                          real language service (TS/JS workers, diagnostics, cross-file models +
                          node_modules .d.ts extra libs) for IntelliSense — see gotcha below.
    src/vv/templates.ts   10 project templates (React/Vue/Svelte/Express/Nest × TS/JS) —
                          manifest (install/dev/port/entry) + full source, inline.
  (../core/src/workers/)  the shared runtime host now lives in the @vivari/core SDK
                          (packages/core/src/workers/); studio bundles it via the
                          @vivari/core alias. Browser worker entries:
      kernel-worker.ts    hosts the Kernel; DEMOS registry + demo shell tabs (VV_RUN); the
                          multi-root VFS protocol (vv-readdir/read/stat/mkdirp/create-project,
                          vv-fs-changed; streaming vv-search + vv-replace; vv-collect-dts bulk
                          node_modules .d.ts harvest for IntelliSense) + dynamic project
                          run/attribution (projectDirByTerm, project-ready/-reload). Also the
                          generic SDK spawn protocol (proc-spawn/-input/-kill → proc-out/-exit).
      fs-worker.ts        hosts the File System Worker (VFS + OPFS).
      fetcher-worker.ts   outbound fetch() (npm downloads).
      process-worker.ts   one process = one worker (boots the runtime).
      (TS + `// @ts-nocheck`; bundled by Vite/esbuild, not the strict API build —
       see packages/core/tsconfig.workers.json.)
    src/components/ide/   AppShell (+ Home overlay) · Home (Start blank / from template,
                          recents) · ActivityBar (Explorer/Search) · Explorer (VFS-backed
                          multi-root tree; context menu incl. Open in Integrated Terminal,
                          Copy Path) · SearchPane (VS Code-style full-text search & replace
                          across all roots: case/word/regex, include/exclude globs, Replace
                          All/per-file/per-match + preserve case) · EditorGroup
                          (preview/permanent tabs) · TerminalPanel (Console/Terminal/Ports) ·
                          PreviewPanel (multi-tab mini-browser: local address bar,
                          back/forward, reload, chii DevTools in a resizable bottom split) ·
                          StatusBar (status + live diagnostics count) · CommandPalette (⌘P
                          quick-open by name; append :line[:col]
                          to jump) · fileIcon (vscode-icons). Icons are Iconify via
                          unplugin-icons (`~icons/lucide/*`, `~icons/vscode-icons/*`; needs
                          @svgr/core) — do NOT reintroduce lucide-react.

scripts/
  verify-node.mjs      headless end-to-end proof (no browser).
  verify-express.mjs   installs+runs real Express/Vite/ws (needs network).
  probe-*.mjs          framework discovery/regression probes (react/nest/realdev).
  spike-*.mjs          per-template/subsystem "does it boot + serve in-VM" proofs.
  lib/spike-harness.mjs   shared kernel-boot/install/waitListen/httpGet helper for spikes.
  run-spikes.mjs       CI runner over the spikes (tiers: --offline / --net / --all).
  process-worker.mjs / fs-worker.mjs   Node worker_threads entries for headless.
  fixtures/napi-crc32/   vendored @node-rs/crc32 wasm32-wasi N-API addon (verify-node fixture).

README.md · roadmap.md · research.md · ARCHITECTURE.md · AGENTS.md
```

---

## Golden rules

1. **Cross-origin isolation is mandatory.** `SharedArrayBuffer`/`Atomics` need
   `COOP: same-origin` + `COEP: require-corp`. Studio sends them from
   `packages/studio/vite.config.ts` (`server.headers` + `preview.headers` + a plugin
   that also stamps `Service-Worker-Allowed: /` on `/sw.js`). Serve it any other way
   and nothing works. All assets stay same-origin (no CDN) so COEP is satisfied —
   that's why Monaco/xterm are bundled from npm.
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
6. **Generated Wasm is built, not edited.** Never hand-edit `pkg/`/`pkg-node/`;
   edit the Rust crate and rebuild.
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
8. **Only commit when asked.** And never commit build artifacts (`pkg/`,
   `pkg-node/` are gitignored) or secrets.

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
`packages/core/src/workers/fetcher-worker.ts` (`corsSafeHeaders`) keeps ONLY the CORS-safelisted
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
  **Both** process-worker entries — `packages/core/src/workers/process-worker.ts` (browser)
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
- **Registry aliasing** (`packages/core/src/workers/fetcher-worker.ts` imports `NATIVE_WASM_ALIASES`): a
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
- **`globalThis.fs` is pre-seated writable at boot** (`runtime/index.js`, next to the
  `process`/`Buffer` globals). Go/wasm toolchains drive their wasm through the Go glue
  (`wasm_exec`), which installs an fs shim with `globalThis.fs || Object.defineProperty(
  globalThis, "fs", { value: nodeFs })`. That `defineProperty` defaults to
  `writable:false, configurable:false`, so whichever Go tool loads FIRST **locks**
  `globalThis.fs` — and then esbuild-wasm's in-process patch can't do `globalThis.fs =
  __ocFs` to multiplex its stdio fds ("Cannot assign to read only property 'fs'"). This
  bit Astro: `@astrojs/compiler` (Go wasm for `.astro`) locked it before Vite's esbuild
  dep-optimize ran. Fix = prevention: seat a writable+configurable `globalThis.fs` at
  boot so every tool's `globalThis.fs || …` short-circuits (never locks), while
  esbuild/tsgo can still reassign it for their own run. A non-configurable lock can NOT
  be undone (defineProperty throws "Cannot redefine property"), so the patch's own
  try/catch fallback is only a backstop — the boot pre-seat is the real fix.
- **Worker-pool default** (`runtime/builtins/process.js`): `PISCINA_DISABLE_ATOMICS`
  defaults to `1` so pools use async message passing (a browser `MessagePort`
  can't be drained synchronously across a worker boundary, so the Atomics fast-path
  can't work). `worker_threads.receiveMessageOnPort` IS implemented (lazy per-port
  inbox) for libraries that poll it directly; just keep the Atomics path off. This
  is why the Angular template is now plain `ng serve`/`ng build` with no `scripts/vv-ng.mjs`.

### HTTP parser is real llhttp-in-Wasm, with a pure-JS fallback
`internalBinding('http_parser')` (`bindings/http_parser.js`) prefers **real llhttp
compiled to Wasm** (`bindings/llhttp/`, the binary vendored from undici via
`scripts/vendor-llhttp.mjs`) and transparently falls back to the pure-JS parser.
Gotchas:
- **Selection is automatic.** The Wasm module is compiled *synchronously* at
  binding time; that's allowed in Workers (where guest processes run) but throws on
  the main thread (4KB sync-compile cap), which is exactly what triggers the JS
  fallback. Force either side with `VV_HTTP_PARSER=js|wasm` (wasm = fail loud).
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
  `module` builtin's export is the `Module` *function* with statics hung off it, so the
  dynamic-import→namespace interop must copy own-enumerable keys for FUNCTION exports too,
  not only objects — otherwise the named import is `undefined` and PGlite dies deep in
  `create()` with a minified "e is not a function". Dynamic `import()` must ALWAYS resolve
  to a module NAMESPACE (Node wraps a CJS target as `{ default: module.exports, ...ownKeys }`),
  never the bare `require()` value. This lives in THREE helpers, keep them consistent:
  the ESM path (`esm.js` `helpers`' `__oc_import`, which wraps via `__oc_ns`), the CJS path
  (`esm.js` `rewriteCjsDynamicImport`'s injected `__oc_import`, used by `.cjs` files like
  PGlite's bundle), and the `new Function` path (`index.js` `__ocImport`). The ESM path
  originally returned the bare exports — harmless for static default imports (they go
  through `__oc_def`) but it broke Vite's SSR module runner, which asserts `'default' in mod`
  for externalized CJS deps (`analyzeImportedModDifference`) → "Named export 'default' not
  found. The requested module 'cssesc' is a CommonJS module…" on astro.
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
  dir via `controller.readdir(abs)` (→ `vv-readdir` → `vv-reply`) and re-reads on a
  `treeVersion` bump. Any code that mutates the VFS from the worker MUST `post("vv-fs-changed")`
  so the tree/quick-open index refresh (writes, rename/rm/copy, create, installs).
- **Request/response goes through `KernelBridge.request(type)`** (reqId → `vv-reply`), used
  by vv-readdir/vv-read/vv-stat/vv-mkdirp/vv-create-project. Fire-and-forget `post()` stays
  for streaming stuff (term I/O, vv-write on save).
- **Created/opened projects are attributed to a dev-server port by pid chain**, not a port
  table: the run shell records `projectDirByTerm[terminalId]`, and `kernel.onListen` walks
  the listening pid up to that shell (`terminalForPid`) → project → `project-ready`. The two
  legacy DEMOS still use the fixed-port `demoForPort` path; keep them separate.
- **Templates live in `src/vv/templates.ts`** (manifest + full source, inline) — not a
  scaffolder run in-VM. Creation writes them in ONE `writeFilesBatch` via `vv-create-project`.

### Full-text search runs in the kernel worker — keep it non-blocking
The VFS is synchronous ONLY inside the kernel worker (the sole VFS holder), so full-text
search/replace lives there (`vv-search`/`vv-replace` in `packages/core/src/workers/kernel-worker.ts`), NOT on the
main thread — reading every file over `vv-read` round-trips would be death by a thousand
messages. But that same worker also serves preview HTTP + terminal I/O, so the walk MUST
stay cooperative: it `await`s a macrotask every N files and streams partial results back as
`vv-search-result` batches (final `vv-search-done`). Don't turn it into one big synchronous
loop or a preview/terminal will stall mid-search. A monotonic `currentSearchToken` cancels
an in-flight search when a newer query (or `vv-search-cancel`) arrives — always check the
token in the loop. After a replace writes files, the controller re-reads affected open
models from disk so the Monaco buffer + dirty state don't drift.

### IntelliSense: real Monaco workers + who-holds-which-file
Monaco's language workers are ENABLED (they used to be a no-op `MonacoEnvironment`): `mountEditor`
imports the `?worker` entries (Vite bundles them same-origin → COEP-safe) and `configureLanguageService`
turns on semantic+syntax diagnostics with `setEagerModelSync(true)`. **One TS language service, not two
(memory):** Monaco otherwise runs a full language service for EACH of the `typescript` and `javascript`
modes — two `ts.worker`s that each parse the entire dependency `.d.ts` payload into ~310 MB (≈621 MB
total, measured). We run a single one: `languageFor` maps `.js/.jsx/.mjs/.cjs` to the `typescript`
language too (the TS service handles JS via `allowJs`), and `javascriptDefaults` is kept inert
(diagnostics off, no eager sync, no extra libs) so its worker — created lazily on first JS-model use —
never spawns. Extra libs + compiler options go to `typescriptDefaults` only. The worker only "sees"
two kinds of file: **Monaco models** and **extra libs** — so the split MUST stay clean or you get
phantom "Duplicate identifier" errors. Rule: the project's OWN source files are seeded as models
(`ensureBackgroundModels`, so cross-file completion/go-to-def works before a file is opened); installed
dependency types (`node_modules/**/*.d.ts` + `package.json`) are the extra libs, harvested in bulk by
the kernel worker (`vv-collect-dts`, sole VFS holder → one reply, not thousands of reads) and pushed
via `setExtraLibs`. Never register a file as BOTH. The dts harvest collects the project's DECLARED
deps (+ their `@types`) FIRST so a budget cap can't drop the packages you actually import (a blind
walk did exactly that — react types got evicted before they were read). It's bounded (file-count +
byte budget) and debounced; it re-runs on folder open, fs changes, AND after any process exits — because
in-VM writes (a `npm/yarn/pnpm install`) do NOT emit `vv-fs-changed`, so process exit is the signal
that `node_modules` may have appeared. A cheap `node_modules` fingerprint (top-level package list) in
`vv-collect-dts` short-circuits the file reads when nothing actually changed, so triggering on every
process exit is nearly free. `checkJs` stays off so plain-JS projects aren't flooded with semantic
errors. **Gotcha #1 (register extra libs with `Uri.toString(TRUE)`):** Monaco's `Uri.toString()`
percent-encodes `@` → `%40`, but TS's module resolver looks up `@types/…` / `@scope/…` with a
LITERAL `@`. If extra-lib keys are encoded (`%40types`), the resolver's `fileExists` never matches
and EVERY `@types`-backed import fails (`react`, `react-dom/client`, `react/jsx-runtime`) even though
the `.d.ts` was harvested and loaded. `loadDependencyTypes` therefore keys extra libs with
`monaco.Uri.file(f.path).toString(true)` (skip-encoding) so `@` stays literal. **Gotcha #2 (timing):**
the worker validates open files at mount, BEFORE the types exist; after `setExtraLibs` we re-apply
`setCompilerOptions(...)` to fire Monaco's `onDidChange`, tearing the worker down so the next
validation spins up a fresh LanguageService that already sees every dependency `.d.ts`.

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
  kernel's transient `/var/cache/vv-fetch` buffer is deliberately in the OPFS
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
`/usr/lib/node_modules/yarn` and writes `/bin/yarn.js` + `/bin/yarnpkg.js` shims.
Unlike npm (loaded eagerly at boot), yarn is loaded **on demand** — the kernel
worker registers it as a lazy program (`registerLazyTools`) and the first `yarn`
spawn triggers the unpack (`kernel.ensureCommandLoaded`). Differences from npm
worth knowing:
- yarn's `lib/cli.js` is a single ~5 MB webpack bundle — far bigger than the 1 MiB
  SAB `writeFile` window, but that's a non-issue now: the loader delivers the whole
  tree via `kernel.writeFilesBatch` (one transferable `ArrayBuffer`), which carries
  the big bundle inline. No `writeLarge` per-file path needed.
- No fallback CLI: a missing asset just means `yarn` isn't on PATH (like npm now,
  since the Turbo-analog is retired). The shim is just applied after unpack.
- yarn needs a writable cache: the shell env sets `YARN_CACHE_FOLDER=/tmp/.yarn-cache`
  (created at boot), mirroring `npm_config_cache`.
- Headless browser-shape gate: `scripts/spike-yarn-studio.mjs` (`VV_NET=1` for the
  real `yarn add`). The off-disk Path B proof is `scripts/spike-yarn.mjs`.

### Real pnpm is the studio shell's `pnpm` — worker_threads + symlinked store
pnpm is wired like npm/yarn (`scripts/vendor-pnpm.mjs` → `pnpm-pack.bin`;
`packages/kernel-host/load-real-pnpm.js` `ensureRealPnpm` → `/bin/pnpm.js` +
`/bin/pnpx.js`; loaded **on demand** on the first `pnpm`/`pnpx` spawn, like yarn).
What makes pnpm special:
- It drives real `worker_threads` (`dist/worker.js`) and a SYMLINKED `node_modules`
  (`node_modules/<pkg>` → `.pnpm/<pkg>@<ver>/…`). Both work because the
  Process-Worker model runs nested threads and the Rust VFS backs
  `symlink`/`readlink`/`lstat`. If either regresses, pnpm installs break where
  npm/yarn still pass — the canary is `scripts/spike-pnpm.mjs`.
- The VFS now supports real hard links (`link(2)`, `nlink` refcount), so pnpm can
  hard-link from its store instead of copying — several names share ONE inode's
  bytes in RAM. A user types bare `pnpm add` (no room for flags), so the shell env
  carries the config the npm way: `npm_config_package_import_method=hardlink` +
  `npm_config_store_dir=/home/user/.local/share/pnpm/store` (PERSISTED, so the store
  is shared across projects/reloads) + `XDG_*` under `/home/user` (see `openTerminal`).
  Keep these when editing the env.
- `vendor-pnpm.mjs` DROPS `*.node` files: pnpm ships prebuilt reflink addons only
  for darwin/win; Linux uses the JS fallback, so they're ~1.3 MB of dead weight.
- `dist/pnpm.cjs` (~8.8 MB) exceeds the 1 MiB SAB window → loader uses writeLarge.
- Headless browser-shape gate: `scripts/spike-pnpm-studio.mjs` (`VV_NET=1`), which
  uses the SAME env (not CLI flags) so it verifies studio's actual config.
- **pnpm bins are `#!/bin/sh` cmd-shims, NOT symlinks.** npm makes `node_modules/.bin/vite`
  a POSIX symlink to the real `vite.js`; pnpm writes a `#!/bin/sh` wrapper that
  `exec node "$basedir/../vite/bin/vite.js" "$@"`. Our loader can't run shell, so
  `module.js` `runMain` unwraps a shell shim to the `.js` it execs
  (`resolveCmdShim` → the pure, unit-tested `parseShellShimTarget`; guard:
  `scripts/spike-cmd-shim.mjs`). Without it, a `pnpm`-installed bin is compiled as
  JS → `SyntaxError: missing ) after argument list`. A real `#!/usr/bin/env node`
  bin is left alone. No NODE_PATH shim needed: pnpm puts the real bin next to its
  deps in the `.pnpm/<pkg>@<ver>/node_modules/` store, so the normal node_modules
  walk resolves them.
- **`pnpm run` does NOT eat a leading `--` like `npm run` does.** `npm run dev --
  --flag` strips the first `--` and forwards `--flag`; `pnpm … dev -- --flag`
  forwards the literal `--` too, and vite's cac parser then treats everything after
  `--` as pass-through positionals (the flag is silently ignored). For pnpm, drop
  the `--`: `pnpm --filter web dev --configLoader native`. (See the `monorepo`
  template's dev command.)
- **pnpm's default isolated store hides transitive deps from Vite's in-VM dep
  optimizer.** react-dom's `scheduler` lives behind nested `.pnpm/` symlinks, and
  rolldown externalised it → the preview crashed with `Calling require for
  "scheduler" …`. The `monorepo` template ships an `.npmrc` with
  `node-linker=hoisted` — a FLAT node_modules of real dirs (npm-like); the
  `workspace:*` package stays symlinked (the showcase) but external transitives
  become bundlable. Reach for this whenever a pnpm project's Vite preview is blank
  with an externalised-`require` error.

### Vite config bundling is broken in-VM — avoid it
Vite loads `vite.config`/`vitest.config`/`.vitepress/config` by esbuild/rolldown-
**bundling** the file and importing the temp bundle via a `file://` URL — a path that
fails ("Invalid URL") or hangs in-VM (`__ocImport` doesn't resolve `file://` temp
bundles). Workarounds, by tool:
- **Vite 6+/8** templates: pass `--configLoader native` (skips bundling, native
  import). This is why every Vite `dev` command carries that flag.
- **Vitest**: no `vitest.config` — pass options as CLI flags.
- **VitePress** (runs **Vite 5**, which has NO `--configLoader native`): the
  config-less trick (ship no `.vitepress/config.*`) DID get past this — but VitePress
  was ultimately **dropped** for a deeper reason (synckit; see below). Don't re-add it
  without solving that.

### VitePress is dropped — synckit's blocking sync port drain is incompatible
VitePress's Shiki markdown highlighter resolves languages **synchronously** via
**`synckit`**: `resolveLangSync = createSyncFn(...)` runs **eagerly at module load** and
spawns a `worker_threads` Worker with a `MessagePort` in `workerData`, then at call time
does `Atomics.wait` (block the thread) → `receiveMessageOnPort(port)` (read the reply
synchronously). Two problems in-VM: (1) our `worker_threads` doesn't transfer MessagePorts
across threads yet → `DataCloneError` on spawn; and (2) — the fundamental one — a **blocked
worker can't receive a MessagePort message** (delivery needs the event loop, which
`Atomics.wait` freezes), so `receiveMessageOnPort` returns nothing. This is the same limit
that forces `PISCINA_DISABLE_ATOMICS=1`, and synckit has no async fallback. **Docusaurus**
covers the docs showcase instead (Prism, no synckit). Revisit if the worker model gains a
synchronous cross-worker port drain (SAB-backed), or Shiki/VitePress drops synckit.

### Real corepack is the studio's PM version manager — DOWNLOADS + runs pinned PMs
corepack is wired like the PMs but is a *version manager*, not a package manager
(`scripts/vendor-corepack.mjs` → `corepack-pack.bin`;
`packages/kernel-host/load-real-corepack.js` `ensureRealCorepack` → installs ONLY
`/bin/corepack.js`; loaded **on demand** on the first `corepack` spawn). It reads a project's
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
- Headless browser-shape gate: `scripts/spike-corepack-studio.mjs` (`VV_NET=1`
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
- It's ~11 MB gz (a ~47 MB wasm), so the kernel worker loads it **on demand — the first time
  `tsc`/`tsgo` is actually spawned** (registered via `kernel.registerLazyProgram`; the spawn
  paths `await kernel.ensureCommandLoaded(command)` before resolving — see `registerLazyTools`
  in `packages/core/src/workers/kernel-worker.ts`). Boot pays nothing; the tree persists in
  OPFS, so a returning visitor's first use just re-applies the shims. Don't move it back into
  the awaited boot block or a boot-time background prefetch.
- Headless proofs: `scripts/spike-tsgo.mjs` (off-disk Path B) + `scripts/spike-tsgo-studio.mjs`
  (shipped shim + shared loader). NOTE these need host **Node ≥ 22** — the vendored `fs.js`
  uses `Array.fromAsync`, which the browser's V8 has but Node 20 lacks (a headless-only quirk;
  in the browser it just works).

### Cross-service WebSockets + host↔preview bridge

- **`/preview/<port>/` ws routing.** The preview ws shim (in `packages/studio/public/sw.js`)
  parses a `/preview/<port>/…` ws URL and tunnels to THAT in-VM
  port (stripping the prefix); prefix-less URLs keep the iframe's own port, so **Vite HMR is
  untouched**. The kernel already routes ws `open` by port, so this is a shim-only change.
  Keep the two `sw.js` shims in sync. Regex lives in a template literal → backslashes are
  DOUBLED (`\\/preview\\/(\\d+)…`).
- **SSE goes through its OWN tunnel — NOT the HTTP proxy.** A `text/event-stream` response
  can't cross `handleHttpRequest`/`OP_RESPOND` (buffered end-to-end: the SW waits for ONE
  complete body, so a never-ending SSE stream 504s at 60s). So an **`EventSource` polyfill**
  (in BOTH `sw.js` shims, injected next to the ws shim — keep them in sync, same DOUBLED
  regex escaping) tunnels each connection as `vv-sse` (`sub:'open'|'close'`); `handleSseClient`
  binds it to the port's process, which opens an in-VM loopback GET to `/events` and relays
  each raw chunk out as `sse-out {sub:'open'|'chunk'|'close'}` (`onSseSend`). The polyfill
  parses the raw bytes into `message`/named events (SSE spec: `data:`/`event:`/`id:`, dispatch
  on a blank line) — so BOTH `es.onmessage` and `es.addEventListener('name', …)` work. It's
  one-way (no client→server `send`), otherwise it mirrors the ws tunnel exactly:
  `packages/runtime/index.js` (`sseRelay`/`dispatchSse`/`sseLiveness`), `kernel.js`
  (`handleSseClient`/`handleSseOut`/`sseConns`, torn down on process exit), `process-worker.js`
  (`sse-open`/`sse-close` → `dispatchSse`), `kernel-worker.js` (`vv-sse` ↔ `onSseSend`),
  `host.js` + studio `kernel.ts`/`controller.ts` (`vv-sse` relay both directions). Gated by
  `scripts/spike-sse.mjs`, which drives that exact tunnel headlessly (no browser) via
  `handleSseClient` + `onSseSend`. That spike is green, so the `sse` template is graduated
  (no longer `experimental`); a regression there means the tunnel or forwarding broke.
- **In-VM cross-process TCP/pipe (`net.js`).** `connect()` links same-process via an in-memory
  registry; when the port/path isn't served locally it falls back to the kernel byte-relay
  (`OP_PIPE_LISTEN`/`OP_PIPE_CONNECT`; bytes flow out of band as `pipe-*` postMessages keyed by
  `connId`), so a process can dial a server ANOTHER process owns. This is what makes Nuxt/Nitro
  dev work: `:3000` (one process) reverse-proxies SSR to its render worker's ephemeral port (a
  DIFFERENT process); `vite-node`/Nitro also talk over `*.sock` UNIX sockets. TCP servers
  advertise a synthetic per-port key so TCP and UNIX sockets share ONE relay. Keep the fallback
  AFTER the local miss (never before) so single-process loopback + external (SW) routing stay
  untouched. Probes: `scripts/probe-xtcp.mjs` (the Nitro shape), `scripts/probe-xpipe.mjs`.
- **Which ports open a preview tab.** `kernel.onListen` (in `kernel-worker.js`) makes a run
  shell's **first** listening port the primary preview (`project-ready`). A single dev server's
  other ports are internal — Vite's HMR ws (`:24678`, answers "Upgrade Required" to a browser),
  a framework's SSR/render worker (Nuxt/Nitro's ephemeral port, reached via the main server's
  proxy) — and do **not** each open a tab. A template that truly runs multiple user-facing
  servers opts in with `manifest.multiPreview`, and each extra then gets a tab
  (`project-ready {extra:true}`; the controller only adds a tab for extras). Only `ws-demo`,
  `fullstack`, and `trpc` set it today (Express/`ws`/tRPC backend `:3001` + Vite frontend
  `:5173` from one `dev.js`). All bound ports are still tracked so a restart reloads the real
  tab; the set is cleared when the run shell exits so a re-run re-announces. **Don't** revert to
  a tab-per-port default — HMR/SSR-worker ports would spawn junk tabs.
- **`host.vivari.internal`.** Maps to the studio's own hostname so in-VM code can reach a
  service on the HOST machine (only when the studio is served locally). Two egress paths both
  honor it: `http`/`https` (and npm) go through `packages/core/src/workers/fetcher-worker.ts` `rewrite()`;
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
(symptom: "Run React template → preview shows the Vivari Studio page, not
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

### Client-routed frameworks need `keepPreviewPrefix` + a matching base
The preview SW serves every app under `/preview/<port>/` and by default **strips**
that prefix so `/`-based servers (Next, Vite, Express) see clean paths. But a
framework whose **client** router re-matches routes against the iframe's own
`location.pathname` (which IS `/preview/<port>/…`) lands on its NotFound page even
when SSR rendered `/` fine. Fix: set `manifest.keepPreviewPrefix: true` (SW keeps the
prefix) **and** point the app's base at `/preview/<port>/` so SSR and the hydrated
client agree. Templates doing this: **Docusaurus** (`baseUrl`), **React Router 7**
(`react-router.config.ts` `basename` + Vite `base`, both `/preview/5173/`, trailing
slash required). Symptom if you forget: "not found" on first load / `No route matches
URL "/preview/<port>/"`.

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
- `VV_TRACE_MODULES=1` (propagate via the process env) names the module whose
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
- **Top-level await → compile as AsyncFunction on ANY parse failure.** Our CJS wrapper
  is a plain (non-async) function, so an ESM module with top-level `await` fails
  `new Function`. You can't sniff this from the error message: `await import('x')`
  becomes `await __oc_import('x')`, and the parser reads `await` as an identifier and
  blames the *next* token → `SyntaxError: Unexpected identifier '__oc_import'`, not the
  tidy "await is only valid…" string. So `module.js` **retries any failed ESM compile
  as an `AsyncFunction`** — real TLA then compiles; a genuine syntax error fails again
  and is reported. (@sveltejs/kit's `core/sync/ts.js` — `ts = (await import('typescript'))
  .default` — hits this when a SvelteKit `vite.config.js` loads.) A non-entry TLA module
  still can't truly block its importer (the "only the ENTRY can block on TLA" rule
  above), but it now at least *compiles* instead of throwing at load. Proven by
  `scripts/spike-esm.mjs`.
- **`esm.js` does NOT strip TypeScript types** — it only rewrites `import`/`export`.
  A raw `.ts` run through OC's loader (`node --experimental-strip-types x.ts`) is
  *not* type-stripped: `esm.js` removes the leading `export `/`import ` and leaves
  the rest verbatim, so `export type Foo = …` becomes `type Foo = …` → **`SyntaxError:
  Unexpected identifier 'Foo'`**. Everything else (Angular/Vite/Nitro/…) only ever
  sees `.ts` *after* esbuild/Vite has stripped types, so this bites only files run
  directly by the loader. Rule for templates: keep any raw-executed `.ts` free of
  type syntax (no `export type`, no annotations). Share types with the bundler-
  processed side via a type-only `typeof import('./server')` instead of a runtime
  `export type` — see the **tRPC** template (`server/index.ts` has zero type syntax;
  `src/App.tsx` derives `AppRouter` via `typeof import('../server/index').appRouter`).
  Proven by `scripts/spike-trpc.mjs`.
- **Named imports are eager snapshots, NOT live bindings — but re-exported names are
  now lazy.** `esm.js` compiles a *used* `import { X } from './m'` to
  `const X = __oc_m['X']` (an eager read). That's fine for hoisted functions (reachable
  early) but breaks a *circular* import of a `const`/`class`: if module A's body requires
  B before A's `const X` initialises and B eager-reads `A.X`, the getter throws
  **"Cannot access 'X' before initialization"** (real ESM reads its live binding lazily,
  at use). A full fix needs scope-aware reference rewriting; until then two mitigations
  live in `transpileEsm`:
  1. **An imported name that is only re-exported** (`import { X } from './m'; export { X }`
     — the barrel-file shape) is compiled *without* the eager `const X` and re-exported
     via a **lazy getter to the source module**, exactly like `export { X } from './m'`.
     The read is deferred until after the cycle resolves. This is what unblocks the
     **Astro** template: `astro/dist/runtime/server/render/index.js` does
     `import { Fragment } from './common.js'; export { …Fragment… }` while `common.js`
     (`const Fragment = Symbol.for('astro:fragment')`) is mid-cycle.

     **The re-export getter must be emitted EARLY and re-resolve the source lazily.** It's
     defined in `exportGetters` (before the prelude requires) and reads
     `get: () => __oc_require('./m')['X']` — NOT `get: () => __oc_m['X']` closing over the
     later-declared prelude var `m`. Reason: a circular importer can read `barrel['X']`
     *while the barrel is mid-prelude* (its requires re-enter the importer). If the getter
     hasn't been defined yet, that read returns **`undefined`** — and because `undefined`
     is not a TDZ throw, the live-binding fallback below never fires and the importer
     silently snapshots `undefined` forever. astro's `middleware/index.js` re-exports
     `sequence` while `render-context.js` eagerly imports AND spread-calls it
     (`sequence(...mw)`); the stale `undefined` snapshot surfaced only later as V8's
     **"Function.prototype.apply was called on undefined"** (a spread call `undefined(...x)`
     compiles to `.apply`). `__oc_require` is cached, so re-resolving in the getter returns
     the same (possibly mid-cycle, but hoisted) module.
  2. The eager `const X` is only emitted when `X` is actually **referenced in the module
     body** — a name that appears solely in `import`/`export {}` statements never gets a
     snapshot. The "is it used" check is deliberately over-inclusive: it blanks only
     import/`export {}` ranges and counts ANY identifier-boundaried occurrence elsewhere
     (including in strings/comments, and NOT discounting `obj.X` member access — because
     `.X` is ambiguous with spread `...X`). Dropping a snapshot for a name used only via
     spread (`[...SVELTE_DEDUPED_IMPORTS]`, `[...SUPPORTED_MARKDOWN_FILE_EXTENSIONS]`)
     was the bug that made this too aggressive → "X is not defined". So it now only
     removes a snapshot when the name is provably absent from executable code; keeping an
     occasional truly-unused const is harmless.
  A name USED in code (not just re-exported) across a `const`/`class`/singleton cycle
  isn't covered by those two — it's handled by a **runtime fallback**:
- **Live-binding fallback (`transpileEsmLive` + module.js retry).** When an ESM module's
  eager evaluation throws a `ReferenceError` matching `before initialization` / `is not
  defined`, `module.js` recompiles THAT module with `transpileEsmLive` and re-runs it
  once. The live variant binds every import onto an `__oc_live` object as a getter and
  runs the whole body inside `with (__oc_live) { … }`, so a bare reference to an import
  resolves lazily (at use), while a local that shadows it wins natively — scope-correct
  WITHOUT reference rewriting. This is what makes **astro** boot: its runtime is full of
  circular singletons read inside functions (`apiContextRoutesSymbol`, `AstroConfigSchema`,
  `globalContentLayer`, `telemetry`, …) — 16 modules recover via the fallback. It's a
  FALLBACK (not the default) because `with` deopts + needs sloppy mode: normal modules
  keep the fast eager path and never pay for it. The eager attempt throws in the prelude
  (before the body), so re-running only re-defines the configurable export getters + hits
  cached requires — no double body side effects. Caveats: assigning to an imported binding
  is a silent no-op (real ESM throws), and an import used at TOP-LEVEL init inside a cycle
  still can't be satisfied (the source genuinely isn't ready — real ESM would deadlock).
  A leading `"use strict"` is stripped (it would make `with` a SyntaxError). Proven by
  `scripts/spike-esm.mjs`.

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
that auto-runs its dev command (`VV_RUN`, via `openTerminal`). Closing that tab
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
`child.stdin` is a real binary-safe Writable sink — `write()`/`end()` accept an
encoding + callback and pass Buffers/Uint8Arrays through byte-for-byte — plus the
chainable stream surface (`pause`/`resume`/`cork`/…) tools poke at (NestJS's watch
restart calls `child.stdin.pause()` before killing).

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
stdin, unchanged (`sendStdin` never stringifies, so binary bytes survive; the
runtime's `drainStdin` normalizes strings vs bytes to a Buffer). The host terminal
→ shell path is `term-input` → `kernel.sendStdin(pid)`.
The interactive line editor (echo, backspace, Ctrl+C→SIGINT the whole foreground
job — every stage of a pipeline via `currentKill`, with keystrokes forwarded to
the pipeline's first stage) lives in the `sh` coreutil, not in a TTY line
discipline — there's nothing cooked below it. Terminals use xterm `convertEol:true`, so guest code should emit `\n`
(don't double it to `\r\n`).

### OPFS persistence
The VFS mirrors to OPFS and **survives reload**. If a demo behaves as if old files
linger, that's why — use `?reset` on the demo URL to wipe it. Restore happens
before any syscall is served.

### VFS memory: whole-file lazy compression (on by default)
The FS worker's Wasm linear memory (all file bodies) is the largest addressable term
in the tab. File bodies are a `FileBody { Raw | Zip{data,len} }`: cold files are stored
zlib-compressed and inflate transparently (whole-file reads on demand; chunked `fd_read`
once into a bounded 48 MiB hot-read cache). A file inflates in place on the first write
and (re)compresses only when its last writable fd closes (`wopen` refcount) or after
`write_file`, skipping files < 4 KiB or that don't beat a 95% ratio. Measured ~70% VFS
shrink on a Nuxt `node_modules` (929 MB → 274 MB), dropping the real Chrome tab 2.9 → 2.1 GB.
- **On by default**; `?compress=0` disables it. The flag is plumbed page (`init.compress`,
  default true) → kernel worker (`vfsCompression`) → FS worker (`fs-set-compression`), applied
  BEFORE the OPFS restore so restored files compress on write too.
- Rust: `set_compression()` gate; `mem_bytes()` = physical (compressed) + hot cache;
  `logical_mem_bytes()` = uncompressed, so "Measure Memory" prints the ratio. `flate2`
  (miniz_oxide) keeps the wasm32 build toolchain-free.
- With the gate off the code path is behaviorally identical, so `verify-node` is unaffected.
  `scripts/spike-compress.mjs` estimates the win over a real `node_modules` offline. Any
  change here needs `npm run build:vfs && npm run build:vfs:node` to rebuild the wasm.

### Measure Memory: per-PID Process Worker breakdown
Post-compression, the tab's largest term is the **Process Worker JS heap** (dev servers), but
`performance.measureUserAgentSpecificMemory()` only attributes it to the shared
`process-worker.js` URL — not to a PID. "Measure Memory" adds a per-process breakdown:
- Each worker answers a `proc-mem` message with `runtime.memStats()`: its own heap
  (`performance.memory.usedJSHeapSize` — **unavailable in Chrome Workers**, so this reads `-1` in
  practice; the main-thread `measureUserAgentSpecificMemory()` per-URL breakdown is the real heap
  figure), guest **module-cache** entry count (`moduleSystem.cache` — the load-once/retain-forever
  CJS/ESM cache), whether it hosts the resident **esbuild-wasm** service (`isEsbuildInprocActive()`),
  and the **esbuild Go wasm heap size** (`esbuildWasmBytes()` — the byteLength of the Go service's
  `WebAssembly.Memory`, captured to `globalThis.__ocEsbuildMemory` by the in-process patch). Exposed
  via `boot.js`'s `onReady` control object.
- The kernel worker keeps a `pid → worker` registry (in `spawnWorker`), queries all live processes
  in parallel (2 s timeout), and relays sorted rows on the existing `vv-mem` round-trip;
  `controller.ts` prints the table. Threads/`fork` children go through `spawnWorker` too, so they
  appear. The query is **read-only** — `verify-node` is unaffected.
- Note: the compiled CJS/ESM wrapper is not retained after evaluation (GC-eligible), so there's no
  stray "module source" to free — the reducible heap is the `Module._cache` graph (risky to prune),
  the by-design esbuild Go heap (now quantified per-PID, but Go wasm can't shrink — only worker
  `terminate()` frees it), and the guest framework's own working set. Use this readout to decide
  before touching any of them.

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
  templates from the registry; auto-vendors npm to `/tmp/vv-vendor`). Wired into
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
- **Add a demo**: extend the `DEMOS` registry in `packages/core/src/workers/kernel-worker.ts` with a
  REAL project layout (`files` = relative path → contents, exactly what `npm create
  …` emits), plus `dir`, `port`, `entry`, and a `runCmd`/`runArgs` that is the
  project's own dev script (e.g. `npm run dev`). Add the option to the `DEMOS` array
  in `studio/src/vv/controller.ts` (id + title + run label) — and, for the legacy UI,
  the `<select>` in `demo/index.html`. "Run" opens a dedicated shell tab whose `sh` auto-runs
  `VV_RUN="npm install && <runCmd runArgs>"` (`scaffoldDemo()` writes the files once;
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
- **Ship the studio**: `npm run build:studio` (Vite build → `packages/studio/dist/`).

---

## Where to look next

- **How it works** → [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- **Why it was built this way / status per feature** → [`roadmap.md`](./roadmap.md)
- **Background research** → `research.md`
