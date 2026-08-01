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
    debug.js       the SECOND SAB ABI: kernel→paused-worker debug (CDP) command
                   channel (EMPTY/CMD state words + Atomics.wait). Only used when
                   VV_DEBUG is set. See the breakpoint-debugger gotcha below.

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
    programs/bun.js       Node-backed `bun`/`bunx` shim (always in COREUTILS; not a vendored pack).
    programs/python.js    `python`/`python3` CLI (lazily boots Pyodide; `-m uvicorn`/`-m flask`).

  runtime/         The Node runtime that runs INSIDE each process worker.
    index.js       createRuntime(): wires builtins/globals/http-bridge/ws + run().
    module.js      synchronous CommonJS loader (require + resolution).
    toolchain-shims.js  single source of truth for native->wasm drop-ins (NATIVE_WASM_ALIASES).
    esbuild-inproc-patch.js  load-time, version-agnostic rewrite of esbuild-wasm's service to run in-process.
    esm.js         ESM→CJS transpiler (import/export → sync CJS).
    typescript-transform.js  synchronous, dependency-free TS/JSX type-strip + JSX
                   lowering for the loader (Bun's zero-config .ts/.tsx exec; gated so plain JS is untouched).
    instrument.js  breakpoint-debugger source instrumentation: acorn parses the
                   guest's own source and weaves in __vvdbg probes + per-block
                   __vv_ev eval closures (only when the debug hook is set).
    debugger.js    in-guest CDP Debugger/Runtime backend (script registry,
                   breakpoints, call frames, pause/step, evaluateOnCallFrame).
    vendor/acorn.mjs  vendored acorn parser used ONLY by instrument.js; ships in a
                   lazy import() chunk so it costs nothing when debug is off.
    loop.js        the per-process event loop (nextTick→micro→timers→immediate).
    boot.js        process bootstrap shared by browser + Node worker entries.
    fs-client.js   env-agnostic Atomics syscall client (the caller side).
    websocket.js   in-VM WebSocket client (used by the HMR tunnel).
    builtins/      hand-written: process, os, assert, child_process, bun (Bun global + bun:* modules),
                   bun-formats.js (Bun.YAML/TOML/JSON5/JSONL/semver over vendored parsers),
                   bun-text.js (Bun.stringWidth/stripANSI/wrapAnsi/color/indexOfLine + inspect.table),
                   bun-bytes.js (Bun.ArrayBufferSink/readableStreamTo*/concatArrayBuffers/allocUnsafe),
                   python (lazy Pyodide/CPython→WASM plug-in + Flask/FastAPI HTTP bridge).
      bun-hash.js  Bun.hash's algorithm family (wyhash, xxHash32/64, murmur, cityHash) —
                   byte-exact ports, each pinned by a known-answer vector in the spike.
      bun-glob.js  Bun.Glob's pattern compiler behind .match(). Hand-rolled on purpose:
                   Bun's dialect is not minimatch's (see the Bun section below). Also
                   .scan()/.scanSync(): a PRUNING VFS walk (a syscall per directory, so
                   pruning is not a micro-optimisation) with the filesystem injected,
                   which is what keeps the walk testable in the offline tier.
      bun-fsrouter.js  Bun.FileSystemRouter: Next.js-style [param]/[...catchAll]/
                   [[...optional]] with per-SEGMENT precedence. A sibling of Bun.serve's
                   compileRoutes/matchRoute, deliberately not a generalisation of it.
      bun-env.js   Bun's automatic .env loading: the file set + precedence, a port of
                   Bun's own parser, and $VAR expansion. `bun` processes only.
      bun-sleep.js Bun.sleepSync as a real Atomics.wait park (packages/protocol/
                   syscall.js `parkFor`/`canPark`), with the spin as a fallback.
    node/
      lib/         Node's REAL vendored lib/*.js (fs, net, http, stream, ...).
      internal/    Node's REAL internal/* (streams, errors, validators, ...).
      bindings/    our internalBinding shims (fs, tcp_wrap, zlib, crypto, ...).
        http_parser.js  selects the HTTP parser: real llhttp-in-Wasm (default),
                        pure-JS fallback. Force with VV_HTTP_PARSER=js|wasm.
        llhttp/      llhttp compiled to Wasm (vendored from undici) + the bridge
                     (llhttp-parser.js) folding llhttp callbacks onto Node's
                     HTTPParser contract; regen the binary via scripts/vendor-llhttp.mjs.
      vendor/      third-party bundles, each an esbuild CJS bundle wrapped in a
                   factory (semver for npm; js-yaml/json5/smol-toml for the Bun
                   data formats; ansi-text.js = string-width + strip-ansi +
                   wrap-ansi for the Bun text APIs; es-module-lexer; the napi
                   wasm runtime). Every header carries package@version, the
                   license and the exact regenerate command — keep that true.
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
    src/vv/debug-session.ts  the breakpoint-debugger CDP *client*: sends dbg-cmd /
                          receives dbg-event over the kernel bridge, tracks targets/
                          frames/scopes, and drives Monaco gutter breakpoints +
                          paused-line decorations. Feeds DebugPanel.
    src/vv/scm-session.ts    Source Control (git) store: runs isomorphic-git (lazy-
                          imported) over the VFS via git-fs.ts. MULTI-REPO: a
                          RepoState[] with one entry per open workspace folder (VS
                          Code-style), each owning its own branch/status/history +
                          staged/unstaged + commit message; ops take a `root`.
                          LOCAL-ONLY (no remote). Feeds SourceControlPanel. Also
                          `refreshBranches()` — a branch-only readout (no statusMatrix,
                          no log) cheap enough to run on every workspace change for
                          the status bar; see the gotcha below.
    src/vv/editor-status.ts  cursor / indentation / language-mode readouts for the
                          StatusBar, fed by Monaco listeners in controller
                          `wireEditorStatus`. A store of its OWN (not IdeSnapshot) —
                          the cursor changes on every keystroke, so folding it into
                          the main snapshot would re-render every useIde() consumer
                          on each keypress.
    src/vv/status-message.ts  the status bar's transient message slot ("saved page.tsx
                          — hot-updating…"), written via the controller's private
                          `status()`. Also its OWN store, for the same reason: the
                          `demo-status` bridge event carries one message per line of
                          dev-server output. Auto-hides after 4s. Routine feedback
                          goes here; FAILURES still raise a sonner toast.
    src/vv/git-fs.ts      isomorphic-git fs adapter → the silent `vv-git-fs` kernel
                          RPC (main-thread git can't touch the FS-worker VFS directly).
    src/vv/git-config.ts  persisted git author identity (localStorage; per-user).
    src/vv/templates.ts   ~55 project templates across 9 categories (Frontend/Backend/
                          Fullstack/Showcase/Bun/Tooling/Docs/Creative/Native) — each a manifest
                          (install/dev/port/entry) + full source, inline (NOT a scaffolder
                          run in-VM). Spans React/Vue/Svelte/Solid/Qwik/Preact/Lit, Express/
                          Nest/Fastify/Koa/Hono/h3/Nitro, Next/Nuxt/SvelteKit/Astro/React
                          Router, Tailwind+shadcn, TanStack Router, Vitest, the Bun family
                          (serve/routes/websocket/react), Docusaurus/VitePress/Slidev,
                          Rsbuild/webpack/Angular, the sqlite/pglite/trpc/monorepo showcases, and
                          the Native family (Python / data-science / Matplotlib / FastAPI / Flask,
                          CPython via Pyodide). The install command is inferred per PM (npm/yarn/pnpm/bun).
  (../core/src/workers/)  the shared runtime host now lives in the @vivari/core SDK
                          (packages/core/src/workers/); studio bundles it via the
                          @vivari/core alias. Browser worker entries:
      kernel-worker.ts    hosts the Kernel; DEMOS registry + demo shell tabs (VV_RUN); the
                          multi-root VFS protocol (vv-readdir/read/stat/mkdirp/create-project,
                          vv-fs-changed; streaming vv-search + vv-replace; vv-collect-dts bulk
                          node_modules .d.ts harvest for IntelliSense; the SILENT vv-git-fs RPC
                          for main-thread isomorphic-git — no vv-fs-changed storm on commits) + dynamic project
                          run/attribution (projectDirByTerm, project-ready/-reload). Also the
                          generic SDK spawn protocol (proc-spawn/-input/-kill → proc-out/-exit).
      fs-worker.ts        hosts the File System Worker (VFS + OPFS).
      fetcher-worker.ts   outbound fetch() (npm downloads).
      process-worker.ts   one process = one worker (boots the runtime).
      (TS + `// @ts-nocheck`; bundled by Vite/esbuild, not the strict API build —
       see packages/core/tsconfig.workers.json.)
    src/components/ide/   AppShell (+ Home overlay) · Home (Start blank / from template,
                          recents; "Reset everything" now also clears the recent-projects
                          registry and locks its dialog while the wipe runs) · ActivityBar
                          (Workspace/Search/Source Control + a "Run and Debug" entry that
                          opens the DebugPanel; the Source Control entry carries a
                          changed-count badge + a bottom light/dark/system theme toggle —
                          next-themes, applied to Monaco + xterm via controller.applyUiTheme) ·
                          Explorer (the "Workspace" panel: VFS-backed multi-root tree; context
                          menu incl. Open in Integrated Terminal, Copy Path) · SearchPane (VS
                          Code-style full-text search & replace across all roots: case/word/regex,
                          include/exclude globs, Replace All/per-file/per-match + preserve case) ·
                          EditorGroup (preview/permanent tabs; active tab has a #007acc top
                          accent + a "Workspace > project > …path" breadcrumb) · DebugPanel
                          (VS Code-style Call Stack / Variables / Watch / Breakpoints for the
                          breakpoint debugger — see gotcha below) · SourceControlPanel
                          (VS Code-style git, MULTI-REPO: one collapsible section per open
                          workspace folder, each with its own branch switch/create, commit
                          box, Staged/Changes with stage/unstage/discard, history, per-file
                          diff via a read-only Monaco diff tab, or an Initialize button when
                          the folder isn't a repo — local-only isomorphic-git) ·
                          TerminalPanel
                          (Console/Terminal/Ports) · PreviewPanel (multi-tab mini-browser: local
                          address bar, back/forward, reload, chii DevTools in a resizable bottom
                          split) · StatusBar (VS Code blue #007acc; LEFT: active repo's git branch
                          + live diagnostics count + the auto-hiding message slot, RIGHT:
                          "Ln x, Col y" / "Spaces: n" / language mode, each opening a quick
                          pick — see StatusBarPickers + the gotcha
                          below) · StatusBarPickers (Go to Line, the
                          two-level indentation actions, Select Language Mode — all built on the
                          CommandDialog primitives) · CommandPalette (⌘P quick-open by name;
                          append :line[:col] to jump) · fileIcon (vscode-icons). Icons are Iconify via
                          unplugin-icons (`~icons/lucide/*`, `~icons/vscode-icons/*`; needs
                          @svgr/core) — do NOT reintroduce lucide-react.

scripts/
  verify-node.mjs      headless end-to-end proof (no browser).
  verify-express.mjs   installs+runs real Express/Vite/ws (needs network).
  probe-*.mjs          framework discovery/regression probes (react/nest/realdev).
  spike-*.mjs          per-template/subsystem "does it boot + serve in-VM" proofs.
  spike-debugger.mjs   headless breakpoint-debugger proof (instrument + CDP backend +
                       real SAB channel + worker_threads pause→evaluate→resume).
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

### `capture: true` hides a process's stderr from `VV_LIVE=1`
`kernel.start(cmd, args, { capture: true })` buffers the child's output into
`r.stdout`/**`r.stderr`** and, on that path, the kernel's `stdout`/`stderr`
callbacks are **never called** (`kernel.js` `onOutput` returns early when
`proc.capture`). So the usual "stream it and look" escape hatch — `VV_LIVE=1`,
which only wires those callbacks — shows nothing for a captured process. A spike
that asserts on `r.stdout` alone therefore reports a crashed child as an empty
string and a bare non-zero exit, with the real error sitting unread in `r.stderr`.
That is exactly how a plain `SyntaxError: Unexpected token '<'` in the TS
transform reached CI as four unexplained failures. **When a captured check can
fail, print `r.stderr`** (see block 2 of `scripts/spike-bun.mjs`).

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
Two native->drop-in alias tables in `runtime/toolchain-shims.js` are the single
source of truth — add drop-ins THERE, not in the fetcher; both are guarded by
`scripts/spike-toolchain.mjs`:
  - `NATIVE_WASM_ALIASES` — LOCKSTEP renames (source+target publish identical
    versions), e.g. `esbuild -> esbuild-wasm`, `rollup -> @rollup/wasm-node`,
    `lightningcss -> lightningcss-wasm` (the last unlocks Tailwind v4 in-VM;
    `@tailwindcss/oxide` itself resolves via its own `wasm32-wasi` optional dep).
    The target's packument is served verbatim under the source name.
  - `NATIVE_DROPIN_ALIASES` — API-compatible drop-ins whose versions are NOT
    lockstep, e.g. `bcrypt -> bcryptjs`. `synthesizeRemappedPackument()` keeps the
    source's versions + dist-tags (so any `source@<range>` resolves) but points each
    entry at the target's latest tarball/deps and strips native-install metadata.
  New-entry requirements (either table): target pure-JS/wasm with no native deps,
  API-compatible, proven by the spike AND a live browser install.
- **Registry aliasing** (`packages/core/src/workers/fetcher-worker.ts` imports both
  tables): a packument request for an aliased source (`esbuild`/`rollup`/`bcrypt`) is
  served the drop-in's packument under the source name — verbatim for lockstep,
  version-remapped for non-lockstep — so npm downloads the drop-in's real tarball
  into `node_modules/<source>`. Falls back to the un-aliased fetch on error. This is
  the `REGISTRY_PROXY`/`rewrite()` seam realized.
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

### The status bar's git branch must NOT trigger a status walk
`ScmSession.refresh()` runs a `git.statusMatrix` walk, and that walk fires a pile of synchronous
kernel-fs ops onto the kernel worker thread that also serves the terminal + preview. That's why it
only runs while the Source Control panel is SHOWN. The status bar needs the branch on every
workspace change, which is far more often — so it uses `refreshBranches()` instead: a `.git` stat
plus `git.currentBranch()` (a `.git/HEAD` read) and nothing else. The controller picks between them
in `refreshScm()`: full walk when the SCM panel is open, branch-only otherwise. If you ever need
more git state in the status bar, extend `refreshBranches` with something equally cheap — do NOT
reach for `refresh()`. Non-repo folders short-circuit on the `.git` stat, so a git-less workspace
still never pays the lazy ~1 MB isomorphic-git import.

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
**Gotcha #3 (never offer a `javascript` language mode):** the status bar's Select Language Mode
picker (`LANGUAGE_MODES` in `controller.ts`) has NO JavaScript entry, on purpose. Selecting it
would put a model in the `javascript` mode and defeat the single-service rule above — Monaco would
spawn the second ~310 MB `ts.worker` the moment that model asked for completions. `.js` files
therefore report "TypeScript" in the status bar. Every OTHER id in that list is a Monarch grammar
Monaco already bundles (yaml, shell, sql, xml, dockerfile, go, rust, java, php, ruby, ini, …):
highlighting only, no worker, no language service, so listing one costs nothing.

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

### Vite's ROLLDOWN config bundler throws "Invalid URL" — avoid it (native loader)
Vite 6+/rolldown loads `vite.config` by bundling it and importing the temp bundle via a
`file://` URL, and its rolldown bundler throws "Invalid URL" in-VM. Workarounds:
- **Vite 6+/8** templates: pass `--configLoader native` (skips bundling, native
  import). This is why every Vite `dev` command carries that flag.
- **Vitest**: no `vitest.config` — pass options as CLI flags.

Note the file:// import mechanism itself works in-VM: `module.js`'s `fromFileUrl`
resolves a `file://` specifier (including a `?t=` cache-buster) to its VFS path, so the
NATIVE loader's config import and Vite's module-runner file:// imports resolve. It's the
rolldown *bundling* step that fails, not the file:// import.

### VitePress works in-VM (Docs template, graduated) — three in-VM gotchas
VitePress runs **Vite 5** (esbuild config bundler, not rolldown). Getting it to boot + render
in-VM required handling three distinct issues; all are reflected in the shipped template
(`vitepressTemplate()` in `packages/studio/src/vv/templates.ts`) and mirrored in
`scripts/spike-vitepress.mjs`:

1. **Config must be CommonJS.** VitePress loads `.vitepress/config.*` via Vite's
   `loadConfigFromFile`, whose loader has two branches. An **ESM** config (.mts/.mjs, or a .js in
   a `type: module` package) is loaded with `await import(file://…temp.mjs)` — that async `file://`
   dynamic import does NOT settle here, so boot hangs right after Vite's "CJS build … deprecated"
   line. (A synchronous `require('file://…')` resolves fine — `module.js`'s `fromFileUrl` maps it,
   incl. a `?t=` buster — so an offline probe of the *sync* path was misleading; the real stall is
   the *async* `await import()`.) A **CommonJS** config (`.vitepress/config.js`, package NOT
   `type: module`) takes Vite's synchronous branch (`require.extensions` + `module._compile`), which
   works. Takeaway: for Vite-5 configs in-VM, prefer CJS over `.mts`/`.mjs`.
2. **worker_threads must transfer ports embedded in workerData.** Importing VitePress does
   `new Worker(f, { workerData: { port }, transferList: [port] })` (synckit). The runtime now
   transfers MessagePorts found in `workerData` across both spawn hops (see
   `packages/runtime/node/lib/worker_threads.js` `collectTransferables`, `index.js` `host.spawn`,
   `kernel-worker.ts` `spawnWorker`). Before this it threw "A MessagePort could not be cloned…".
3. **synckit is still used for on-demand Shiki languages — pre-load them.** `highlight.ts`
   pre-loads only `markdown.languages`; any *other* code-block language triggers
   `resolveLangSync = createSyncFn(...)` (Atomics.wait + `receiveMessageOnPort`), which a browser
   worker can't drain synchronously → throws mid-render. So the template pre-loads a broad set of
   common languages in `markdown.languages` (loaded async at `createHighlighter`, which works). A
   language NOT in that list still throws — add it. WARNING: the spike runs under Node's real
   `worker_threads`, where synckit works, so it canNOT catch a missing language; validate the
   language path in a real browser.

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
- `crypto.Hash`/`Hmac`/`Sign`/`Verify` all extend `stream.Writable` (real Node's
  are Transform/Writable), because corepack does `stream.pipe(createHash(algo))`
  then `hash.digest()`. Don't revert them to plain objects.
- crypto **S3** (`packages/crypto` + `lib/crypto.js`): `scrypt`/`scryptSync` and the
  asymmetric surface — `createPrivateKey`/`createPublicKey` (PKCS#8/SPKI + PKCS#1
  `RSA PRIVATE/PUBLIC KEY` + SEC1 `EC PRIVATE KEY`, PEM+DER), `createSign`/`createVerify`
  + one-shot `sign`/`verify`, RSA `publicEncrypt`/`privateDecrypt` (OAEP + PKCS1v15), and
  `generateKeyPair(Sync)` for `ec` (prime256v1/secp384r1), `ed25519` + `rsa`.
  Enough for ES256/384 + EdDSA + RS256/384/512 + PS256/384/512 JWTs. RSA PSS uses
  `crypto.constants.RSA_PKCS1_PSS_PADDING` + `RSA_PSS_SALTLEN_DIGEST`;
  `asymmetricKeyDetails.modulusLength` is surfaced (jsonwebtoken@9 reads it).
  **Phase 3:** `new crypto.X509Certificate(pem|der)` (parse fields + `.publicKey`
  + fingerprints + `verify`/`checkIssued`, via `x509-cert`) — drives jose's
  `importX509` (`scripts/spike-jose.mjs`); SEC1 EC keys normalize to PKCS#8.
  Still unsupported (throw): encrypted keys,
  `privateEncrypt`/`publicDecrypt`, DH/ECDH, JWK. `createPrivateKey` still
  THROWS on a raw secret (not parseable PEM/DER), so jsonwebtoken's HS* fallback
  to `createSecretKey` is intact.
- corepack's registry integrity key check uses ECDSA (now available via S3), but we
  haven't re-validated its exact key path, so the shell still sets
  `COREPACK_INTEGRITY_KEYS=0` — corepack's official escape hatch; the sha512
  tarball-integrity check (via `createHash`) still runs.
  The env also carries `COREPACK_HOME=/tmp/.corepack` (cache) +
  `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` (see `openTerminal`). Keep these.
- Headless browser-shape gate: `scripts/spike-corepack-studio.mjs` (`VV_NET=1`
  downloads+runs yarn AND pnpm), using the SAME env (not CLI flags). The off-disk
  Path B proof is `scripts/spike-corepack.mjs`.

### Bun is a Node-backed SHIM, not a real binary — only its parsers are vendored
There is no `wasm32` build of Bun, so unlike the real npm/yarn/pnpm/corepack/tsgo
(vendored packs unpacked into the VFS) Bun is **emulated on top of our Node
runtime**, and its pieces are ALWAYS on PATH (in `COREUTILS`), never lazily
unpacked:
- **`packages/runtime/builtins/bun.js`** — a Node-backed `Bun` global (`version`,
  `main`, `env`, `escapeHTML`, `deepEquals`/`deepMatch`, `hash`/`crc32`, `Glob`,
  `FileSystemRouter`, `randomUUIDv7`, `gzip`/`gunzip`,
  password `hash`/`verify`, `CryptoHasher`, `Transpiler`, `$`) plus **`Bun.serve`**
  (fetch handler; `routes` with static paths, `:params`, `*` wildcards,
  `BunRequest.params` and **`BunRequest.cookies`**; server-side **WebSockets** — RFC
  6455 handshake, frame codec, `ServerWebSocket` send/close/subscribe/publish/cork
  + pub/sub topics) and **`bun:*` modules** (`bun:test` runner + `expect`).
  Its response writer pulls Set-Cookie out with `Headers.getSetCookie()` and hands
  Node the **array**: `Headers.forEach` flattens repeated headers into one
  comma-joined value, and an `Expires=Thu, 01 Jan 1970 …` contains a comma of its
  own, so a flattened pair can never be split back apart.
- **`packages/runtime/builtins/bun-formats.js`** — `Bun.YAML`, `Bun.TOML`,
  `Bun.JSON5`, `Bun.JSONL` and `Bun.semver`, wired into the `Bun` literal by
  `bun.js`. The **one place in the Bun shim that vendors real libraries**
  (`node/vendor/js-yaml.js`, `json5.js`, `smol-toml.js`; `Bun.semver` reuses the
  `semver.js` bundled for npm). Vendored because Bun's parsers are Rust/C++ with
  documented behaviour the stock npm libraries get differently — a TOML integer
  outside ±(2^53−1) **throws** rather than rounding, TOML date/times come back as
  their **source strings**, YAML is **1.2 core** (a bare date and `yes` stay
  strings) and multi-document YAML returns an **array**, and `Bun.JSONL.parse`
  throws only when *zero* values parsed while `parseChunk` never throws at all.
  New format work goes here, not in `bun.js`.
- **`packages/runtime/builtins/bun-text.js`** — `Bun.stringWidth`, `Bun.stripANSI`,
  `Bun.wrapAnsi`, `Bun.color`, `Bun.indexOfLine` and `Bun.inspect.table`/`.custom`,
  wired into the `Bun` literal by `bun.js`. The width/strip/wrap trio is **vendored**
  (`node/vendor/ansi-text.js` = string-width + strip-ansi + wrap-ansi) because the
  hard part is Unicode data, not logic. `Bun.color` is hand-rolled over the sRGB
  grammar; the CSS Color 4 function space (`lab()`/`oklch()`/`color()`) **throws**,
  because `null` is Bun's documented "not a colour" and must not also mean "we gave
  up". `Bun.color(…, "ansi")` reads the depth policy from the SAME precedence as
  `node/internal/util/colors.js`, so it and `util.styleText` cannot disagree.
- **`packages/runtime/builtins/bun-cookie.js`** — `Bun.Cookie`, `Bun.CookieMap` and
  the `req.cookies` hook `Bun.serve` calls, wired into the `Bun` literal by `bun.js`.
  Hand-rolled, not vendored, for the same reason as `bun-glob.js`: `cookie` /
  `set-cookie-parser` / `tough-cookie` each make a defensible choice exactly where
  Bun made a *different* defensible one, and every such point changes the **scope or
  lifetime** of a cookie a browser stores — which is a session that silently does not
  come back, not a crash. The five that carry the risk: the defaults are `path: "/"`
  and `sameSite: "lax"` and **both are always emitted** (omitting Path scopes the
  cookie to the request *directory*); `Max-Age` beats `Expires` in `isExpired()`
  (RFC 6265 §5.3) while **both attributes are kept and re-serialised**, so the answer
  cannot depend on header order; values are percent-encoded on the way **out** and
  **not** decoded by `Cookie.parse` on the way in; a `Cookie:` request header is
  decoded but its **names never are** (a cookie called `__%48ost-session` must not
  answer to `__Host-session`, since browsers apply the prefix rules to the literal
  name); and `sameSite: "none"` gets **no implicit `Secure`** — Bun serialises what
  you asked for and lets the browser reject it, and adding an attribute the caller
  never wrote is the silent divergence this shim exists to avoid.
- **`packages/runtime/builtins/bun-file.js`** — `Bun.file`, `Bun.write`, the `FileSink`
  from `.writer()` and the `Bun.stdout`/`Bun.stderr` write targets. Three contracts:
  `.slice()` is a **lazy window**, not a copy (Bun documents it as not opening the
  file — a materialising slice has the right bytes and turns a constant-memory
  program into an OOM); the `FileSink` **flushes as it goes** rather than buffering
  until `end()` (the old one lost everything on a crash and held the whole file in
  memory); and every write is chunked to `WRITE_CHUNK` = 512 KiB, mirroring `FD_CHUNK`,
  with the returned short-write count believed. `.stream()` builds its own
  `ReadableStream` from fd reads — see the `Readable.toWeb` gotcha below.
- **`packages/runtime/builtins/bun-bytes.js`** — `Bun.ArrayBufferSink`, the seven
  `Bun.readableStreamTo*` consumers, `Bun.concatArrayBuffers` and `Bun.allocUnsafe`.
  Nothing vendored. Two contracts to preserve: `ArrayBufferSink.flush()` returns an
  **ArrayBuffer/Uint8Array under `start({stream:true})` and a NUMBER otherwise**, and
  `Bun.allocUnsafe` is **zero-filled** here (`new Uint8Array(n)` is specified to be) —
  safer and slower than real Bun, a performance-contract difference, not a bug.
  Async-generator `Response` bodies need no shim code; they already work.
- **`packages/runtime/builtins/bun-env.js`** — Bun's automatic `.env` loading, which
  Vivari did not do at all. **The precedence is the whole risk**: the files are read
  `.env.{mode}.local` → `.env.local` → `.env.{mode}` → `.env` and applied WITHOUT
  override, so the first file to define a key wins and the process environment beats
  all of them. `.env.local` is skipped when `NODE_ENV=test` — and `bun test` is test
  mode even with `NODE_ENV` unset, because Bun picks the file set FIRST and only then
  defaults `NODE_ENV` to `test`; derive the mode from `NODE_ENV` at that point and a
  plain `bun test` reads the `.env.local` Bun deliberately skips. The mode is one of
  exactly three (`development`/`production`/`test` from `BUN_ENV ?? NODE_ENV`), so
  `NODE_ENV=staging` reads `.env.development`. The parser is a port of Bun's
  (`src/env_loader.zig`), not a fresh reading of "dotenv format", because the
  formats genuinely differ — backtick quotes, `KEY: value`, `#` cutting an unquoted
  value with no leading space, `$VAR`/`${VAR}`/`${VAR:-default}` expansion that also
  applies inside single quotes. It is **not** shared with the `--env-file` reader in
  `coreutils.js`: that one implements Node's smaller `--env-file` language and lives
  inside a template literal, so there is no module to import.
- **`packages/runtime/builtins/bun-sleep.js`** — `Bun.sleepSync` parks on
  `Atomics.wait` (`parkFor` in `packages/protocol/syscall.js`) instead of spinning.
  `Atomics.wait` is illegal on a browser MAIN thread, so `parkFor` reports its
  capability and the spin stays as a documented fallback — a sleep that used to work
  must not start throwing.
- **`import.meta`** lives in `packages/runtime/esm.js` (`importMetaSource`). Bun's
  `dir`/`file`/`path`/`env`/`main`/`resolveSync` are added **only when the Bun global
  is installed**; `import.meta.env` under plain node would turn a Vite SSR file's
  `import.meta.env.MODE` from a loud TypeError into a quiet `undefined`.
  `import.meta.main` is `require.main === module` through the loader's live entry
  link — never an argv[1] string compare — and throws if that link is missing.
  **The two `resolveSync`s take different second arguments** and are easy to swap:
  `Bun.resolveSync(id, root)` takes a DIRECTORY ("pass `import.meta.dir`"), while
  `import.meta.resolveSync(id, parent)` takes the importing FILE and is defined by
  Bun's own typings as `Bun.resolveSync(id, path.dirname(parent))`.
- **`packages/kernel-host/programs/bun.js`** — the `bun`/`bunx` CLI: `bun run`,
  `bunx` (delegates to `npx`), install delegation, and it surfaces require/unhandled-
  rejection errors instead of a silent exit. `bun <file>` runs the file through the
  loader's `runMain`, **not** a bare `require`, so the file becomes the process ENTRY
  module — otherwise `/bin/bun.js` stays the entry and `require.main === module` /
  `import.meta.main` are false inside the very file the user asked to run. It also
  decides where `.env` is loaded: run/eval/test/build yes, `bun run <script>` no (the
  `bun` the script itself starts loads it — oven-sh/bun#9635), install/x no (they
  delegate to npm/npx, whose environment is not ours to rewrite from a project file).
  `bun test` additionally forces the `test` file set and then defaults `NODE_ENV` to
  `test` if nothing else set it — that order is Bun's and is load-bearing.
- **Zero-config `.ts`/`.tsx`** runs through `packages/runtime/typescript-transform.js`
  (synchronous, dependency-free type-strip + JSX lowering, invoked by `module.js`;
  gated so plain JS is untouched). It strips return-type annotations inside object
  literals (the `Bun.serve` shape), typed/destructured params, inline
  object/function type annotations, and the type parameters of a generic **arrow**
  (`<T>(x: T): T => x`) — do NOT route plain `.js` through it.
- Install/run detection: `kernel-worker.ts` `pmFromCmd` maps `bun`/`bunx` to the
  `bun` PM (see the install-command builder), so a Bun template's Run auto-installs
  with `bun`.
- Templates: the **"Bun" category** in `templates.ts` (serve / routes / websocket /
  react). Gated by `scripts/spike-bun*.mjs` (offline + kernel) covering the
  transform, the route matcher, the WS frame codec, and the Bun global API.

**Gotcha — a shim stub that lies is worse than a missing API.** Bun code written
here is meant to run under real Bun, so anything that "works" in the sandbox and
diverges in production is a trap. Two rules when touching the Bun shim:
- **Never leave a placeholder return value.** `test.only` used to register an
  ordinary test (so an `only` run executed the whole suite), `Bun.file(3)` used to
  `String()` the fd into the path `"3"` (as did `Bun.write(1, …)`, which CREATED a
  file named `1` in the cwd and reported success, and `Bun.file()`, which handed
  back a handle on the path `"undefined"`), `Bun.Transpiler.scan()` returned empty
  arrays, and the `bun:jsc` memory helpers returned `0`. All of those now either
  behave correctly or throw naming the API and the reason — the `bun:ffi` tier at
  `builtins/bun.js` (import-safe, call-loud). An unknown `bun` verb likewise says
  "not implemented" rather than falling through to "file not found: publish"; only
  a file-shaped argument or a `package.json` script name still runs.
- **`bun --version`/`--revision` read the Bun global**, which is the one definition
  (`BUN_VERSION`/`BUN_REVISION` in `builtins/bun.js`). `BUN_PROGRAM` cannot import
  it (no-interpolation template literal), so it carries a fallback literal that
  `spike-bun-offline.mjs` asserts against `BUN_VERSION` — bump both or CI fails.
- **CI gate:** `spike-bun-offline.mjs` runs in `toolchain-gate`; the kernel-level
  `spike-bun.mjs` runs in the **`verify`** job, which is the only one that builds
  the Wasm crates (`run-spikes.mjs --offline dep-cache bun`). It used to run in no
  job at all, because the Wasm-free gate silently skips `needsWasm` spikes.

**Gotcha — for an API with an exact answer, test against a value from OUTSIDE this
repo.** A placeholder is at least visible once you look; an algorithm that is wrong
in the details is not. `Bun.hash` was a bespoke multiply-xor hash that satisfied
every round-trip check we had — same input, same output, always — while agreeing
with real Bun on nothing, and `Bun.randomUUIDv7` returned a well-formed v4. Neither
can be caught by a self-consistency test, because self-consistency is exactly the
property both already had. So when the shim implements something with a *defined*
answer, pin it to a published one: `bun-hash.js` is checked against Bun's own two
documented wyhash digests plus the SMHasher verification codes from Zig's test
suite, `Bun.Glob` against the examples in Bun's glob docs, and `Bun.randomUUIDv7`
against the RFC 9562 layout and its own monotonicity guarantee. Same rule for
anything added next: if a real implementation exists, a vector from it is the test.

Related: **prefer hand-rolling to vendoring when the dialect differs.** Bun's glob
is not minimatch's — `*` does not cross `/`, `!` negates only at the start of a
pattern, and braces nest at most 10 deep — and every one of those changes which
files a build includes, with the other libraries' defaults looking perfectly
reasonable in review. `bun-glob.js` is ~230 lines and its semantics are asserted
directly; a vendored matcher would need auditing against the same list anyway.

**Gotcha — a directory walk here is a syscall budget, not a loop.** `Bun.Glob.scan`/
`scanSync` and the `Bun.FileSystemRouter` scan behind it read the VFS through the
Atomics bridge: every `readdir` parks the calling worker until the fs worker
answers, and `readdirSync(dir, {withFileTypes:true})` costs one MORE round trip per
ENTRY, because our binding fills the dirent types with a per-name `lstat`
(`node/bindings/fs.js`). So the walker reads NAMES only, `lstat`s an entry lazily
and only when the answer can still change the result, and prunes whole subtrees via
a small NFA over the pattern's path segments — `src/*.ts` reads two directories, not
the project. Two rules if you touch it:
- **The pruner may not decide membership.** `.match()` does, through the same
  compiled RegExp, so a pruning bug can only ever LOSE files, never invent them; an
  ambiguous segment is widened to `**` for the same reason. `spike-bun-offline.mjs`
  asserts pruned-scan == walk-everything-then-`match()` over a list of patterns —
  keep that check, it is the only thing standing between a clever prune and a build
  that silently omits a file nobody looked for.
- **Keep the filesystem an argument.** `scanGlobSync(fs, options)` takes it, which is
  why the whole walk — options, symlinks, cycles, prune counts — is gated in the
  offline tier against an in-memory tree, with `spike-bun.mjs` proving the same code
  against the real Wasm VFS.

**Gotcha — Bun has TWO route grammars, and they are not the same language.**
`Bun.serve`'s `routes` (`compileRoutes`/`matchRoute` in `bun.js`) is `:param`/`*`
with one specificity number per route. `Bun.FileSystemRouter` (`bun-fsrouter.js`) is
Next.js-style `[param]`/`[...catchAll]`/`[[...optional]]` with `index` collapsing and
precedence that is **per-segment, left to right**: `/acme/[page]` beats
`/[org]/settings` for `/acme/settings` though both have exactly one dynamic segment.
A scalar score cannot express that, so the two matchers are siblings on purpose —
generalising one would put Bun.serve's routing (load-bearing for every previewed Bun
app) at risk for the router's sake. They do share the directory walk.
### `Readable.toWeb` THROWS — and a present-but-unimplemented function defeats a `typeof` guard
`node/internal/webstreams/adapters.js` implements only `Readable.fromWeb` (the
direction that turns a `fetch()` body into a Node stream, which is what corepack's
tarball download needs). Every other direction — `Readable.toWeb`,
`Writable.fromWeb`/`toWeb`, `Duplex.*` — is a real function that raises
`ERR_METHOD_NOT_IMPLEMENTED` when called. So the defensive idiom that looks right,

```js
return Readable.toWeb ? Readable.toWeb(nodeStream) : nodeStream;   // WRONG
```

never takes the fallback: the property is there, and the throw happens one frame
later. Worse, it only fails **in the VM** — on the host Node the offline spikes run
on, `toWeb` works — so the offline tier goes green and the product is broken. That
is exactly how `Bun.file(p).stream()` shipped un-runnable until the kernel spike ran
it (`BunFile.stream()` now builds a `ReadableStream` from bounded fd reads instead;
`Bun.spawn().stdout`/`.stderr` still use the guard and are still affected). Two
rules: **feature-detect by capability, not by presence**, when the vendored runtime
is allowed to stub a method loudly; and if a code path can only be exercised
through the VM's own `fs`/`stream`, it is not covered until `scripts/spike-bun.mjs`
(or a sibling kernel spike) exercises it.

### Python is Pyodide (CPython→WASM), lazily booted — with a Flask/FastAPI HTTP bridge
Unlike the Node-backed Bun shim, `python`/`python3` boots **real CPython compiled to
WASM (Pyodide)** the first time a python process runs (nothing at studio boot). Pieces:
`packages/runtime/builtins/python.js` (boot + FS mirror + exec + `serve`),
`packages/kernel-host/programs/python.js` (CLI + `-m uvicorn`/`-m flask`/`-m gunicorn`/
`-m pytest`), the `uvicorn`/`flask`/`gunicorn`/`pytest` PATH shims in `coreutils.js`, and
`scripts/vendor-pyodide.mjs`. Gated by **two** spikes — see the CI gate gotcha below.
Gotchas:
- **CI gate: `spike-python-offline.mjs` is the one that runs per-PR.** Pyodide is ~30 MB
  that is neither committed (`public/vendor` is gitignored) nor installed by CI (no job
  runs `npm ci`), so the interpreter-backed `spike-python-bridge.mjs` has to be `net: true`
  — and the network tier is schedule/dispatch-only *and* `continue-on-error`, i.e. it gates
  nothing. Everything provable without an interpreter therefore lives in
  `spike-python-offline.mjs` (`net: false`, no `needsWasm`), which `toolchain-gate` picks up
  because it runs `run-spikes.mjs --offline` **unfiltered**. Same hole the Bun Phase 0
  change closed; the spike asserts its own registration so it cannot be reopened quietly.
  A Python change that only the network tier covers is a Python change nothing enforces.
- **The "stub that lies" rule applies to argv, not just to APIs** (see the Bun gotcha
  above). `gunicorn`/`uvicorn` never import the package they are named after — that is an
  honest *entrypoint*, because the contract they advertise (your app is served on this
  port) is the one they keep. What they cannot keep is the process model, so those flags
  are loud: `--worker-class`/`-k` (anything but `sync`, which is what the bridge already
  is) and `--factory` **refuse**, because they change what gets served; while
  `--workers`/`--threads`/`--reload`/`-D` **warn** and carry on (the server
  still serves, just not the way the flag asked). Silently swallowing them is the argv
  spelling of a placeholder return value. Flags that take a value must consume it even
  when ignored, or it is read as the app spec — `gunicorn -t 30 wsgi:app` served an app
  called `30` until `-t` was recognised as `--timeout`'s short form. Which flags exist,
  and which of them take a value, is **read off the real tools' `--help`, not guessed**:
  the shim enumerates the ~12 `store_true` flags gunicorn and uvicorn actually have and
  consumes a value for everything else, so being wrong costs a visible "no app specified"
  instead of silently serving the wrong app. Flask is the trap — there `-h` is `--host`,
  not `--help`.
- **Two Node probes must BOTH be masked** or boot dies on `import("node:module")`:
  `process.browser = true` (pyodide.mjs) AND `process.type = "renderer"`
  (Emscripten's pyodide.asm.mjs). Hold both across the whole boot, then restore.
- **`vendor:pyodide` writes gitignored assets under `packages/studio/public/vendor/pyodide/`.**
  It's in the root `prebuild:studio` hook, but the studio's own `bun run build` does NOT
  fire that hook — so `scripts/cloudflare-build.sh` **must list `npm run vendor:pyodide`
  explicitly** (next to vendor:npm/yarn/pnpm/tsgo) or the deployed studio ships no python.
  The lockfile is **hybrid**: vendored packages get relative paths, the rest keep absolute
  CDN URLs so `loadPackagesFromImports` fetches them at runtime; wheel downloads are
  best-effort (a proxy TLS error warns, never aborts). Bump `LOCK_FORMAT` to force a rebuild.
- **Web servers bridge through a guest Node HTTP server, not sockets.** Pyodide has no
  sockets, so `serve()` stands up `http.createServer().listen(port)` (registers the port
  like Express) and converts each tunnelled request to a WSGI `environ` (Flask) or ASGI
  `scope`/`receive`/`send` (FastAPI). Two must-not-regress fixes: (1) patch
  `anyio.to_thread.run_sync` to run inline — the WASM VM has no OS threads, so FastAPI's
  sync-route threadpool otherwise throws "can't start new thread"; (2) map the SW's
  `X-Forwarded-Prefix` to the ASGI `root_path` / WSGI `SCRIPT_NAME` so absolute URLs
  (Swagger's openapi.json link + "Try it out") carry `/preview/<port>` and route back.
  Keep the `sw.js` → bridge header contract in sync. See ARCHITECTURE.md §9.3.
  (3) On ASGI, `scope["path"]` must keep the prefix — ASGI defines `path` as INCLUDING
  `root_path`. Note *where* a pre-stripped path breaks: top-level `get_route_path` is
  guarded (it strips only when `path` starts with `root_path`, so a stripped path sails
  through), but `Mount.matches` hands the sub-app `root_path + matched_path`, and THAT
  subtraction a pre-stripped path cannot survive — so every `Mount()` (`StaticFiles`
  above all) 404s while top-level routes look fine. WSGI is the opposite: `SCRIPT_NAME` +
  `PATH_INFO` is already the split form. The spike checks the scope against Starlette's
  own `Mount`/`get_route_path` and the environ against `wsgiref.validate`, rather than
  against our own idea of the shape.
- **One Pyodide per process — `pip install` does NOT persist.** Each `python` command is
  a fresh boot (`:66–68`), so `python -m pip install -r requirements.txt` is a browser
  cache warm-up, not an install. Scripts get their packages from
  `loadPackagesFromImports(source)` on the entry file; `serve()` separately reads
  `requirements.txt`. When testing several templates in one interpreter, `sys.modules`
  will serve an earlier template's `main` to a later one — boot per case instead.
- **Never wire Python's output through Pyodide's `batched` handler.** It fires once per
  *flush* with the trailing newline stripped, so "add the newline back" is right only
  when the flush ended a line — and wrong for every progress renderer, which flushes
  mid-line. A user hit this: pytest flushes after each `.`, so an 11-test run printed
  eleven lines instead of `...........`. The batched handler also *drops* a final partial
  chunk, so `print("x", end="")` never arrived and no flush could recover it. Use the byte
  `Writer` (`setStdout({ write })`, exported as `byteWriter`), copy the buffer (Pyodide
  reuses it), and return the byte count. Then `flushStreams()` wherever control comes back
  to us — end of a script, each REPL line, each served request — because Python
  block-buffers a non-tty stdout and holds the partial line until something asks. Do not
  set `isatty`; the guest's own `process.stdout` reports `isTTY: false`, and claiming
  otherwise makes pytest emit `\r` progress the terminal will not redraw.
- **`SystemExit` must not print a traceback.** CPython exits silently on an integer or
  bare `sys.exit()`, and prints only the argument for `sys.exit("text")`;
  `terminationFromError` matches that. **Bools are ints here** — `sys.exit(False)` is exit
  0 printing nothing, so reading it as a message made `sys.exit(not ok)` report failure on
  a successful run. Expected values live in `scripts/lib/cpython-exit.mjs`, captured from
  a real interpreter and re-derived from the machine's `python3` on every offline run;
  do not hand-edit them. `sys.exit(-1)` deliberately stays `-1` rather than CPython's 255,
  because that truncation is the OS's 8-bit exit status and the VM has no such boundary
  for any program. It matters because `python -m pytest` synthesises
  `sys.exit(pytest.main(...))` on every run. Note Pyodide's WebLoop *also* re-raises
  SystemExit as a second, unhandled rejection — harmless in a browser, but Node aborts on
  it, so headless harnesses must swallow it.
- **Django works, but only on WSGI**, and only with `DJANGO_ALLOW_ASYNC_UNSAFE=1` and
  `tzdata`. Its ASGI path goes through `asgiref`, which starts a `ThreadPoolExecutor` per
  request even for `async def` views — the existing `anyio` patch does not help, that is a
  different library. Pyodide always has an event loop running, so Django's `async_unsafe`
  guard rejects every ORM call. The WASM stdlib ships no timezone database, so rendering an
  aware datetime raises. And `{% static %}` cannot work behind the preview proxy at all:
  `STATIC_URL` is resolved once and cached, at import time, before any request has set the
  script prefix. `{% url %}`/`reverse()` are per-request and are prefix-correct.

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
- **ws/SSE tunnel: iframe → `parent`, standalone tab → the Service Worker.** Both shims
  `post()` their connection frames to the window that relays to the kernel — the iframe's
  `parent` in the studio. But **"Open in new tab"** (`controller.openExternalPreview`) makes the
  preview a TOP-LEVEL document, and the studio's
  **`COOP: same-origin`** (mandatory for `SharedArrayBuffer`) puts it in a *separate
  browsing-context group* with **`window.opener === null`** — so there is NO window to
  postMessage. (This is why ws/SSE — and even Vite HMR — hang at `connecting…` in a new tab
  while HTTP works: HTTP flows through the SW, ws/SSE historically didn't.) The fix routes the
  tunnel through the **Service Worker**, which is shared across browsing-context groups (the same
  channel the HTTP proxy already uses cross-tab): when `parent === window`, `post()` falls back to
  `navigator.serviceWorker.controller`; the SW forwards `dir:'out'` frames to the kernel-host
  client (`findKernelClient`) and broadcasts `dir:'in'` frames to every **top-level** preview
  client. The shim listens on BOTH `window` and `navigator.serviceWorker` for inbound. The studio
  side: `bridge.ts`'s SW `message` listener forwards `dir:'out'` ws/SSE to the kernel worker, and
  `controller` relays inbound frames to the SW(s) (`relayToExternalPreviews` →
  `bridge.broadcastToPreviewSWs`, which posts to the same-origin controller AND, in modes B/C, every
  bridge port) in addition to the in-app iframes (nested clients, excluded from the SW broadcast →
  no duplicates). Frames carry a per-page `connId`, so broadcasting is safe — each shim keeps only
  its own. (A tab opened by pasting the URL works too, since it's just another top-level preview
  client the SW can reach.)
- **Separate preview origin (modes B & C) + pop-out isolation.** Previews are same-origin by
  default (mode A); a deploy can move them off the IDE origin so preview code (incl. your npm deps)
  can't touch IDE cookies/localStorage/OPFS. It's all client-side: a preview origin is static
  hosting for `sw.js` + a hidden `__vv-bridge.html` (+ `__vv-preview-boot.html`); `KernelBridge`
  iframes the bridge, which registers the cross-origin SW and hands back a persistent `MessagePort`
  the SW routes preview HTTP over (instead of `findKernelClient`). Two flavors:
  - **Mode B — shared origin** (`VITE_PREVIEW_ORIGIN`, e.g. `vivari-preview.pages.dev`): one origin
    for all ports, multiplexed by **path** (`/preview/<port>/`). The studio ALSO registers a
    same-origin SW (`registerSameOriginServiceWorker`) so **"Open in new tab"** works: it opens
    **same-origin by default** (lands in the kernel's storage partition), or on the preview origin
    behind a one-time "connect this tab" Storage-Access gate (`previewConnectingHtml`) when
    `VITE_PREVIEW_POPOUT=isolated`.
  - **Mode C — wildcard per-port origin** (`VITE_PREVIEW_WILDCARD_DOMAIN`, e.g. `vivari.run`):
    each port is its own origin `<token>--<port>.<domain>` (random per-boot `<token>`), so the SW reads
    the port from `self.location.hostname` (`WILDCARD_MODE` in `sw.js`) and serves the app at `/` (no
    `/preview/` path, keep-prefix is auto-rewritten to base `/` at project creation). `KernelBridge`
    lazily stands up **one bridge iframe + `MessagePort` per port** (`ensurePreviewBridge`, keyed by
    origin) as servers `listen`. A Cloudflare **Worker** (`worker/`, route `*.<domain>/*`) serves
    the static SW runtime + stamps isolation headers. Pop-outs always open on the per-port origin.
    The route is broader than the hosts we serve, so the Worker gates on `PREVIEW_HOST` and passes
    every other host through untouched. **Gotcha:** on a base domain shared with other apps, set
    `previewWildcardTag` (e.g. `"vv"`) → hosts `<token>--<port>-vv.<domain>`, route
    `*-vv.<domain>/*`. The tag MUST be a suffix: Cloudflare only allows `*` at the START of the
    hostname, so the infix `vv-*` is rejected. `sw.js` + `worker/` regexes already accept any tag;
    only the route has to change.
  Env vars go on the **studio (main) project**, not the preview project; `VITE_PREVIEW_WILDCARD_DOMAIN`
  takes precedence over `VITE_PREVIEW_ORIGIN`. **`isolated` pop-outs only work gate-free when IDE and
  preview are *same-site*** (subdomains of one registrable domain, e.g. `ide.vivari.run` +
  `preview.vivari.run`, or mode C's `<token>--<port>.vivari.run`): same-site ⇒ not
  storage-partitioned ⇒ the pop-out shares the bridge SW and connects with **no gate** (verified
  live) while storage stays origin-isolated. **Mode C is same-site by construction**, so it's
  gate-free. On two `*.pages.dev` projects they're **cross-site** (PSL) ⇒ partitioned ⇒ Chrome's
  Storage-Access can't un-partition a Service Worker ⇒ the gate never grants, so use `same-origin`
  pop-out there. There is otherwise NO isolated-*and*-frictionless standalone tab on a cross-site
  origin (`same-origin-allow-popups` would drop `crossOriginIsolated` → no SAB). Deep dive:
  `roadmap.md` ("preview origin isolation" + "Pop-out behavior" → "same-site vs cross-site") +
  `sites/docs/docs/deployment.md`.
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
- **Preview must carry the studio theme explicitly.** `PreviewFrame` sets
  `style={{ colorScheme }}` (from next-themes' `resolvedTheme`) and the body wrapper
  is `bg-white dark:bg-[#1e1e1e]`. Without the explicit `color-scheme` the frame
  *inherits* `dark` from the studio `<html>`, so a template that declares
  `color-scheme: light dark` renders white UA text while the frame backdrop stayed
  light → white-on-white, invisible. Setting it on the element ties both the embedded
  doc's used scheme AND the iframe's default backdrop to the chosen theme.
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

**Mode C auto-adapts these.** In mode C each port is its own origin served at `/`, so
the hardcoded `/preview/<port>/` base would 404. `createFromTemplate` calls
`rewritePreviewBaseToRoot` when `previewMode === "wildcard"` && `keepPreviewPrefix`,
which rewrites only the `base`/`basename`/`baseUrl` config keys to `"/"` (leaving
legit cross-service URLs like `'/preview/'+PORT+'/api'` intact) and drops the flag —
so every template runs correctly in every mode. Modes A/B keep the template verbatim.

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
discipline — there's nothing cooked below it. It also does **↑/↓ history recall**
(a module-scoped `commandHistory` array shared with the `history` builtin, which
lists it bash-style 1-indexed) and **Tab completion** (first token → builtins +
PATH programs; later tokens → the VFS, dirs suffixed `/`; unique match inserts +
a trailing space, ambiguous fills the longest common prefix, else lists
candidates). Terminals use xterm `convertEol:true`, so guest code should emit `\n`
(don't double it to `\r\n`).
- **Colored `ls` is TTY-gated.** `ls` renders directories bold-blue (GNU
  `di=01;34`), but ONLY when `--color=auto` (the default) sees an interactive
  terminal — signaled by `VV_TTY=1`, which the interactive `sh` sets at startup and
  children inherit. Batch mode (`sh script` / `sh -c`, used by CI) never sets it, so
  captured/piped output stays plain (this is why `verify-node`'s `ls` assertion sees
  a bare `a`). `--color=always` forces it; `--color=never`/`NO_COLOR` disable it.
  Don't emit ANSI unconditionally again.

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

### Breakpoint debugger (source-instrumented, `VV_DEBUG`)
A full pause/step/inspect debugger for **Node guest processes** — no native V8
inspector exists in the browser, so it is built from **source instrumentation** +
a **second SAB** the paused worker parks on. Load-bearing details:
- **Instrument on the RIGHT layer.** `runtime/module.js` calls
  `globalThis.__vvDebugHook.instrument()` on plain ECMAScript **after** the TS/JSX
  strip but **before** the ESM→CJS rewrite, so line numbers survive. acorn weaves in
  `__vvdbg.line/brk/push/pop` probes + a per-lexical-block `__vv_ev` eval closure
  (so `evaluateOnCallFrame`/Variables see the exact block scope, TDZ included). On
  **any parse failure it self-heals to the original source** — debugging must never
  break a run.
- **Pause = `Atomics.wait` on the debug SAB.** A guest runs in its own Process
  Worker, so hitting a breakpoint genuinely parks the thread on `protocol/debug.js`'s
  SAB. The kernel writes CDP commands into that SAB + `Atomics.notify`s; a **running**
  (not-yet-paused) process instead receives commands via `postMessage`. Two transports,
  one CDP shape.
- **`--inspect-brk`-style start gate.** Short scripts would finish before the frontend
  attaches, so `index.js` opens a start gate (`waitForStart`) that blocks until the
  frontend sends `Runtime.runIfWaitingForDebugger`.
- **Debug mode is kernel-authoritative.** `kernel.js` owns `debugMode`; `run()` gates
  purely on `!!(debug && debug.sab)`. The **run shell + package managers**
  (`sh`/`npm`/`npx`/`yarn`/`pnpm`/…) plus **`python`/`python3`** are **skipped as debug
  targets** so auto-attach lands on the user's actual program (the child inherits
  `VV_DEBUG`). Set via the studio "Debug mode" toggle, which sets `VV_DEBUG=1` for
  subsequent runs.
- **Language reach: JS/TS only.** Instrumentation runs on the JS module loader, so
  **Bun IS debuggable** (`bun <file>` runs the entry through the loader → breakpoints
  bind like `node`). **Python is not**: our `python` is a Node shim that runs the real
  `.py` inside Pyodide (CPython/Wasm), which never passes through the loader — hence the
  skip above (otherwise you'd get a bogus target + start-gate latency + a needlessly
  instrumented shim, and `.py` breakpoints that never bind).
- **Zero cost when off.** `debugger.js` + `instrument.js` + the vendored `acorn.mjs`
  live in a lazy `import()` chunk (~195 KB) fetched only when a debug SAB is present.
  Keep it that way — never add a static top-level import of them into the always-loaded
  worker bundle.
- **Keep all CDP sides in sync.** The backend (`runtime/debugger.js`), the SAB ABI
  (`protocol/debug.js`, kernel + worker halves), the kernel routing (`kernel.js`,
  `kernel-worker.ts`, `process-worker.ts`), and the client (`studio/src/vv/debug-session.ts`)
  are one contract — change them together and re-run `scripts/spike-debugger.mjs`.
- **Not the preview DevTools.** This debugs Node guests; the chii/chobitsu Sources
  panel (`sw.js`, preview iframe) debugs preview **browser** JS and is a separate path.

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
- `node scripts/spike-debugger.mjs` — the breakpoint debugger's spike gate:
  instrumentation, breakpoint binding (incl. conditional), pause/step, scope +
  `evaluateOnCallFrame` (with TDZ), top-level `debugger;`, the real SAB channel, and an
  end-to-end `worker_threads` pause→evaluate→resume. **Run after any debugger change.**
  No network.
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
- **Work on the debugger**: edit `runtime/instrument.js` (probes), `runtime/debugger.js`
  (CDP backend), `protocol/debug.js` (SAB ABI), and/or `studio/src/vv/debug-session.ts`
  (client) — they are one CDP contract, so change the relevant sides together and
  re-run `node scripts/spike-debugger.mjs`. See the breakpoint-debugger gotcha above.
- **Work on Source Control (git)**: edit `studio/src/vv/scm-session.ts` (multi-repo
  store — `RepoState[]`, one per workspace folder; every op takes a `root`), `git-fs.ts`
  (isomorphic-git ⇄ VFS adapter), and `SourceControlPanel.tsx` (per-repo sections). The
  controller keeps the repo list in sync via `syncScmRoots()` (folder open/close). All
  fs access flows through the SILENT `vv-git-fs` RPC in `kernel-worker.ts`; if you
  add a new fs op, wire it in `kernel-fs.js` (kernel sync fs), the RPC switch, and the
  adapter together. It's LOCAL-ONLY (no remote/clone/push) — don't add network here.
- **Ship the studio**: `npm run build:studio` (Vite build → `packages/studio/dist/`).

---

## Where to look next

- **How it works** → [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- **Why it was built this way / status per feature** → [`roadmap.md`](./roadmap.md)
- **Background research** → `research.md`