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
    builtins/      hand-written: process, os, child_process, bun (Bun global + bun:* modules),
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
      bun-ipc.js   the Bun.spawn({ipc}) channel: length-prefixed framing, the two
                   serialization modes, and the socket wiring both ends share. It
                   rides the kernel's EXISTING cross-process pipe (OP_PIPE_*), so
                   there is no IPC opcode to look for. The framing half is pure on
                   purpose — see the one-write-one-read gotcha below.
      bun-sleep.js Bun.sleepSync as a real Atomics.wait park (packages/protocol/
                   syscall.js `parkFor`/`canPark`), with the spin as a fallback.
                   Bun's dialect is not minimatch's (see the Bun section below).
      bun-crypto.js  Bun.CryptoHasher (19 algorithms + HMAC) and Bun.password (real
                   argon2id/bcrypt over packages/crypto, standard PHC / modular-crypt
                   output). Unlike bun-hash.js this is the CRYPTOGRAPHIC side; the two
                   share no code and are not interchangeable.
      bun-sqlite.js  bun:sqlite on REAL SQLite: the official sqlite.org wasm build
                   (committed at packages/runtime/vendor/sqlite/, refreshed by
                   scripts/vendor-sqlite.mjs --refresh), instantiated SYNCHRONOUSLY
                   with our own glue instead of Emscripten's async one, over a
                   purpose-written sqlite3_vfs on the runtime's positional
                   fdRead/fdWrite — so a .sqlite file is a real file in the tree.
                   The host (fs/path/cwd/engine bytes) is injected, which is what
                   lets the offline tier drive the SHIPPED code over node:fs.
                   No durability (fsync is a no-op) and no locking; see the Bun
                   section below and ARCHITECTURE.md §9.2.
      bun-serve.js Bun.serve's OPTION POLICY (implement / degrade loudly / throw, one
                   written-down answer per documented option) and the RFC 6455 rules
                   its handshake and frame reader enforce. Pure — no sockets, no Node
                   builtins — so the offline tier drives it directly; the stateful
                   half (http.Server, ServerWebSocket, pub/sub) stays in bun.js.
      bun-build.js Bun.build + Bun.plugin: a real dependency-graph bundler written
                   against the runtime's own resolver, NOT esbuild — so it works
                   with no bundler in the user's node_modules, the way Bun's does
                   (rationale in that file's header). Same option policy as
                   bun-serve.js. Output is deliberately NOT byte-identical to real
                   Bun's; it is a CJS-shaped wrapper graph with no tree shaking or
                   minifier, and minify/splitting/sourcemap/bytecode THROW rather
                   than get dropped. `bun build` (the CLI, in kernel-host/programs/
                   bun.js) is a front door onto this same engine, so a flag cannot
                   be honoured in one and ignored in the other. The plugin registry
                   is module state that module.js reads on every resolve/load.
      bun-transpiler.js  Bun.Transpiler: transformSync/transform plus the scan
                   family. scan()/scanImports() reuse the vendored es-module-lexer
                   and scanRequireCalls() from bun-build.js rather than parsing
                   again. The two methods report DIFFERENT sets — scan() carries
                   require.resolve but not require(), scanImports() the inverse —
                   which is real Bun's behaviour, pinned case-by-case in the
                   offline tier. Both are pure functions of a source string.
      bun-test.js  the whole of `bun:test`: the runner (describe/test with the full
                   .skip/.only/.todo/.each/.if/.failing family, per-test timeouts,
                   retry/repeats, -t/--bail/--todo/--reporter), `expect` with the
                   asymmetric matchers and `.resolves`/`.rejects`, the mock/spy
                   family + `mock.module()`, and Bun-format snapshots. Split out of
                   bun.js because a test framework is where being APPROXIMATELY
                   right is worst: a wrong matcher makes a green suite lie. Its
                   pure halves (the `.each` title formatter, the snapshot
                   serializer, the .snap codec, the JUnit writer) are exported so
                   the offline tier can pin them BYTE-FOR-BYTE against output
                   captured from a real `bun test` — see the Bun section below.
      bun-unsupported.js  the APIs a browser tab CANNOT provide (raw TCP/UDP, Redis,
                   Bun.SQL's Postgres/MySQL, bun:ffi, WebView, mmap, peek, secrets),
                   each import-safe and loud on call, plus the native `.node` addon
                   message + its substitution map — which module.js and process.js
                   import too, since require('bcrypt') hits the same wall. It has no
                   implementation to read: it IS the catalogue of what is impossible
                   here and what to use instead.
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
                          (serve/routes/websocket/react), Docusaurus/VitePress/Rspress/Slidev
                          (Starlight installs with --ignore-scripts — see its section),
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
  spike-ci-tiers.mjs   holds the tiers honest: no `net: false` spike may need the
                       registry, every `needsWasm` one must be wired into CI, and
                       an offline spike that boots a kernel must say needsWasm.
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

### A dead process worker used to be INVISIBLE — and "no output" is still not "dead"
The single most expensive bug class in this project: a process that stops producing
output, forever, with no error anywhere. It cost two full rounds of misdiagnosis on
one Starlight install report. The cause was structural, in two halves:

- `spawnWorker` (`kernel-worker.ts`) attached only `onmessage`. A `Worker` that threw
  at boot, failed to load its module graph, or was reclaimed by the browser under
  memory pressure fired an `error` event that **nothing listened to**.
- `Kernel.start()` was `new Promise((resolve) => …)` with no reject parameter, and the
  only settle path was `proc.onExit`, which only runs from `finalize()`, which only
  runs on the worker's own `exit` message. No message, no settle, ever.

Both are fixed: worker `error`/`messageerror` route to the kernel's `worker-error`
channel → `handleWorkerError`, and a worker that **failed to boot** goes down the NORMAL
`finalize()` path so every waiter is released (`start()`'s promise, a parent parked on
`OP_SPAWN`, a `worker_threads` creator awaiting `thread-exit`, the studio's `term-exit`,
in-flight HTTP requests). A worker that is merely *throwing* is left alone — see below.
`start()` now rejects with `err.code === "EPROCFAIL"` and `err.result`; `onProcExit`
(what the studio and SDK actually use — they go through `launch()`, not `start()`)
still always fires, with a new `error` field set only on a worker fault.

**`worker.onerror` is NOT worker death — do not finalize on it.** This correction cost
a whole extra round, and shipping it made the bug worse than before the fix. On the web
platform an uncaught exception inside a Worker is *reported* to the `Worker` object and
the worker **carries on servicing its event loop**; only a failure to load or evaluate
the module graph is fatal. `astro dev` throws ~113 uncaught
`SyntaxError: "[object Object]" is not valid JSON` per run from inside its own code and
had always survived them (`bound` in 9 of 9 runs). Finalizing on the first one killed the
dev server before it could listen — 0 of 5 — leaving the shell back at a prompt and the
studio waiting forever on a server that no longer existed: *the same dead terminal the
change was written to explain.* Note the trap: this is unreachable from Node, so
`verify-node` and every spike passed while real Chrome failed. Use
`scripts/repro-starlight-browser.mjs` for anything touching worker error handling.

The fatal/not-fatal call is therefore made in `kernel-worker.ts`, where the platform
detail lives, and passed to the kernel as `m.fatal`: a worker that has posted any
message evidently booted, and one still alive 5s after spawn did too. With no evidence
either way we assume **not** fatal, because wrongly killing a live process is far worse
than being slow to finalize a dead one — the watchdog covers the latter in seconds.
Uncaught errors are counted (`workerErrors`, in `__vv.diag()`) and only the first is
printed, so a flood cannot bury the terminal.

**What is still not detectable, by construction:** a worker that vanishes with no event
at all — an OOM kill fires *nothing* in Chrome. That is what the **liveness watchdog**
is for, and it has one subtlety that made it useless in its first form:

- It keys on **`lastOutput`**, not `lastActivity`. Silence-of-output is what the user
  experiences and what the message claims to measure. Keying it on syscall activity
  (which is what it originally did) made it unable to fire in the one case it was built
  for, and nobody noticed because a watchdog that never fires looks exactly like a
  healthy system.
- **A process's filesystem traffic never reaches the kernel.** It goes straight to the FS
  worker over its own SAB. Measured: a guest in a tight `writeFileSync` loop registers
  **zero** kernel syscalls while writing 80,000 files. So `proc.syscalls` is near-zero for
  ordinary scripts, and a flat syscall count must **never** be reported as "stuck" — that
  would call every slow install dead. Progress is judged from the VFS file count, which
  only `kernel-worker.ts` can ask for (it has the FS worker; the kernel does not).

It is **report-only and never kills** — a process can legitimately be silent for minutes.

So when triaging "it hangs": check the terminal for a `[runtime] PID … has printed
nothing for …` line, which now also says whether the filesystem grew since the previous
check. Then run **`await __vv.diag()`** in the DevTools console for live per-process
state. Four rounds of one hang were spent inferring the state of a machine we could not
reach; that hook exists so one paste-back settles it.

**Reading `__vv.diag()` without falling into the trap above:** `syscalls` is **near-zero
for ordinary scripts** and a zero there does *not* mean nothing is happening. Filesystem
traffic never reaches the kernel, and stdout is a plain message rather than a syscall, so
only network/spawn-heavy work moves that counter. The fields that carry the signal are
**`sinceOutputMs`** (what the user is staring at) and the **VFS file count** (whether work
is landing); call it twice a few seconds apart and compare. `workerErrors` counts uncaught
exceptions the worker survived, and `booted` distinguishes "never started" from "started
and quiet".

It is installed by `KernelBridge`'s constructor, **not** by `Vivari.boot()` — the studio
builds a bridge directly and never calls `boot()`, so hooking it there left the diagnostic
missing from the only place a user actually is. That was caught by watching `__vv.diag()`
throw in a real studio page, which is the only way it could have been caught.

### A shipped node_modules snapshot removes the first-run install entirely
The expensive, silent, repeatedly-misdiagnosed path is a template's *first* install. It can
be skipped: the dep-cache key is a SHA-256 of `package.json` bytes, which is derivable at
BUILD time, so the app can ship a prebuilt snapshot and restore instead of installing.
Verified end to end in a real studio page — the key computed from `templates.ts` bytes
matched the one a real in-VM install produced, byte for byte.

Measured in Chrome, cold origin, Starlight: fetch 0.4s (locally served), **restore 4.0s for
13,459 entries**, dev server listening at 31.8s, and OPFS holding 112 MB instead of 246 MB
because npm's `_cacache` is never written. Note the restore figure: it is **4.0s in the
browser versus 0.1s headless**, and the difference is the OPFS mirror, which the headless
number omits. The structural claim ("restore cannot be worse than install") holds, but do
not quote 0.1s as the browser cost.

The asset is 111.4 MB raw / **26.0 MB gzipped**, which is *less* than the ~135 MB a cold
install pulls from the registry, so shipping it reduces transfer.

The consumer is `tryRestoreDeps` → `tryFetchShippedSnapshot` in `kernel-worker.ts`, keyed
off `vendor/depcache/index.json`. That manifest is the feature's on/off switch: **if it is
not served, nothing is fetched** and every project installs normally — not even a 404 per
project. Every failure (no entry, HTTP error, malformed archive) logs one line and falls
back to a normal install; none is fatal.

Two things to know before touching it:

- **Imported archives are validated, `save()`d ones are not.** An archive off the network
  can be truncated, be an HTML error page served with a 200, or carry a `../` path that
  would escape `node_modules` — so `dep-cache.js` `importArchive()` checks the header,
  every file slice's bounds, and every path *before* storing, and returns null on anything
  suspect. `verify-node` asserts all seven rejection modes.
- **The archive buffer is TRANSFERRED, not copied** (`depCacheImport`), because these are
  ~100 MB and a structured clone would double that on a memory-scarce machine. The caller's
  view is detached afterwards — do not read it again.

Shipped snapshots are marked `shipped` and are evicted **before** a user's own snapshots
despite LRU order: re-acquiring a shipped one costs a request, while re-acquiring a user's
costs the whole install it was made to avoid.

### Reify throughput is NOT the bottleneck — measured, so stop re-deriving it
A plausible and wrong theory for the 30-minute stall was that per-file cost degrades as
`node_modules` grows (quadratic directory scan, rehash, per-write tree walk), turning a
40-second install into an overnight one with no crash. Measured directly against the
Wasm VFS in the shape reify produces (12,000 files, ~1,100 packages, scoped and nested,
compression on):

| tree size          | per-file write |
| ------------------ | -------------- |
| first 1,000 files  | 6.9 us         |
| files 11,000–12,000| 3.6 us         |

Cost is **flat** — the whole 12,000-file tree lands in ~44 ms, and the first bucket is
only slower because of warmup. At full size, `stat` is 8.3 us, `readdir` of a package
dir 3.3 us, reading a leaf back 3.4 us. There is a mild superlinear effect on inserts
into a *single* directory past ~30,000 entries (2.4 us → 20.8 us at 40,000) and
`readdir` of such a directory costs 11.9 ms — so a scan that readdirs a 40k-entry
directory per entry *would* be quadratic — but nothing real gets there: `node_modules`
holds ~1,100 entries and `_cacache` is hex-sharded. Install time lives in the network,
tar extraction, npm's own JS, and the OPFS mirror, not in VFS write throughput.

### The OPFS mirror rewrites a whole file per enqueue — never mirror an APPENDED file
`opfs-persistence.js` is a write-behind mirror: `FsServer` enqueues a path on every
write syscall, and `drain()` then re-reads and rewrites **the entire file**. So a file
built up incrementally costs O(size x appends), not O(size). Two shapes under the
otherwise-persisted package-manager cache dominated an entire Starlight install
(measured on a cold run, with per-path attribution):

- `_cacache/tmp/<uuid>` — cacache writes content to a staging file then renames it.
  One of these cost **1,461 MB across 76 writes**, and it is deleted moments later.
- `_logs/*-debug-0.log` — npm appends a line at a time: **607 MB across 3,799 writes**.

Together with `writeManifest()` (the whole index serialized every time the queue
emptied — **12,847 rewrites totalling ~2.1 GB** to index ~3,000 paths), that was
**~4.7 GB of OPFS writes to persist 53 MB**. `shouldPersist` now excludes `_logs/`
and `tmp/` **inside a `.cache` directory**, and the manifest is coalesced to at most
one write per second (forced on `flush()`), which brings it to ~144 MB. Rules:

- **Do not blanket-exclude `/home/user/.cache`.** It is deliberately durable — npm's
  integrity-keyed `_cacache` surviving reloads is what makes a second project skip
  re-downloading. Exclude the volatile shapes inside it, not the cache.
- Before persisting any new path, ask whether it is appended to or renamed over. If
  so, either exclude it or snapshot it the way `dep-cache.js` handles `node_modules`.
- This is write **churn**, not residency: the live mirror was ~134 MB before and after.
  It matters for OPFS I/O time, quota, and GC pressure — and much more in Incognito,
  where Chrome backs OPFS with memory instead of disk.

### A fetched body must outlive its reader — and measure the VFS with compression ON
`OP_FETCH` does not hand a process bytes; it materializes the response body at
`/var/cache/vv-fetch/<gen>-<key>` and returns a **path**, which the process reads in
a *later* turn (`https.js` does `fs.readFileSync(meta.path)` inside a `nextTick`).
Eviction of the LRU scratch cache runs in that gap, on other downloads' completions.
It used to `unlink()` freely, so it could delete a body whose reader had not read it
yet — and `https.js` swallows the resulting ENOENT as an **empty body on a 200**.
Silent truncation, no error anywhere. Reproduced deterministically: at a 4 MiB cap,
303 of 977 body reads failed and the install broke; at the old 128 MiB cap eviction
almost never ran, which is the only reason it was never seen.

Bodies are therefore **reference counted** (`Kernel._fetchBodyPins`): pinned on every
handoff (fresh, cache hit, or in-flight de-dupe share — sharers read the SAME file),
released when `FsServer` reports the read finished, and force-released when the
owning process exits so nothing leaks. Eviction always drops the *accounting*, but a
pinned file becomes an orphan and is unlinked by the last release. Rules if you touch
this:

- **Never `unlink` a fetched body outside `_reapFetchBody`.** At a 16 MiB cap ~45
  bodies per Starlight install are evicted while still unread; each one is a
  corruption that the refcount is the only thing preventing.
- Body paths carry a generation prefix. Keep it: without it a re-fetch of an evicted
  URL reuses the path and a stale deferred unlink deletes the *new* body.
- The read happens in the FS worker, over the SAB — the kernel cannot see it. That is
  why the signal comes back via `FsServer.onBodyConsumed` →
  `createKernelFs`'s `fetch-body-consumed` → `Kernel.releaseFetchBody`. An embedder
  that doesn't wire it is still correct, just keeps bodies until the process exits.
- `scripts/fs-worker.mjs` is the headless twin of `packages/core/src/workers/fs-worker.ts`.
  Wire both or headless spikes silently test a different body lifetime than the browser.

**Measure residency with compression ON.** The browser sets `vfsCompression = true`
by default, so `vfs.mem_bytes()` (physical, post-compression) is what actually
occupies Wasm linear memory; `logical_mem_bytes()` is the uncompressed size and
**overstates residency**. A headless rig that forgets `fs-set-compression` measures
something the product never experiences — that mistake produced a "379 MB VFS peak"
figure in an earlier round when the real, browser-shaped peak was 176 MB. Cold
Starlight install, compression on, before → after the cap change: physical peak
176 → 150 MB, linear reservation 398 → 372 MB, whole-process RSS peak 1003 → 924 MB.

What remains is mostly *necessary* data — npm's `_cacache` resident alongside the
`node_modules` it was extracted into — and it is worth knowing which parts of it are
actually expensive, because compression changes the ranking completely:

| resident content        | raw     | compressed |
| ----------------------- | ------- | ---------- |
| packument JSON          | 39.1 MB | 8.2 MB     |
| tarballs (`.tgz`)       | 13.5 MB | 13.4 MB    |

So **metadata volume is not a residency problem** — it compresses ~4.8x, and the
tarballs (already gzipped) are the incompressible part. Abbreviated "corgi"
packuments cut metadata *transfer* by ~72%, but they would save single-digit MB of
resident memory, which is why they are not a lever for peak RAM. `mem_bytes` also
counts the hot-read cache of decompressed files, which is not accounted for above and
is the least-explored part of the peak.

### The type stripper must not touch an `import`/`export` CLAUSE

`typescript-transform.js` is a token rewriter, not a parser, and its rules are
written for *expressions*. A module clause looks like one and is not, so three
rules reached into a place they had no business being. All three shipped, and all
three were found at once by work that needed the stripper's output to parse:

| Source | Became | Symptom |
| --- | --- | --- |
| `import type { T } from "m";` | ` from "m";` | `SyntaxError` at load |
| `import * as ns from "m";` | `import * ;` | `SyntaxError` at load |
| `export { a, b as c };` | `export { a, b };` | importer gets `undefined`, **exit 0** |

The first is `dropStatement()`, whose rule is "a balanced `{…}` ends the
statement" — right for an `interface` or `enum` body, wrong for a specifier list,
which the statement continues past. The other two are the `as`/`satisfies` cast
rule: the `as` in a namespace import and in `{ b as c }` is a **rename**, and
eating it is how the third row happens — the worst shape a bug takes here, because
the program still runs.

**The rule: an `import` declaration, and an `export` before `{` or `*`, are copied
through verbatim.** Nothing inside them is a type. `export default …` and
`export const x = y as T` are ordinary code and still get stripped.

**When you touch this file, assert the output PARSES.** The check that covered
type-only imports had regex-matched for absent type names, so a statement stripped
down to a dangling ` from "./foo";` passed it for as long as it existed. A string
assertion cannot see a load failure; `scripts/spike-bun.mjs` runs the file.

### The stripper's context rules were tuned on snippets, not on real files

Four more bugs of the same family surfaced the first time anyone wrote a few
hundred lines of ordinary TypeScript against it (the studio's Bun templates —
`scripts/spike-bun-templates.mjs`). Every one produced a `SyntaxError` on a line
the author had no reason to suspect, and every one had a passing snippet test
sitting next to it:

- **A `{` after `=>` was classified as an object literal**, so every annotation
  inside an arrow BODY survived — `describe("x", () => { let c: Cart; })` kept its
  `: Cart`. The identical declaration inside a `function` body or a bare block was
  stripped correctly, which is exactly why it lasted: the broken case is the one
  modern code is written in. A `{` after an arrow is the body, always — returning
  an object literal requires `() => ({ … })`, which puts a `(` in the way.
- **`skipType()` counted braces only at depth 0**, so the `}` of
  `Array<{ detail: string }>` looked unbalanced, the type "ended" there, and the
  tail `}>;` was left behind as live code.
- **`isGenericOpen()` rejected any `{` between the angles**, so
  `db.query<{ n: number }>(…)` and `new Map<string, { v: number }>()` were not
  recognised as type arguments at all and stayed in as `<`/`>` operators. The
  rejection existed to avoid swallowing `if (a < b) { … }`, so the fix is
  positional: a `{` opens an object type only where a type may begin.
- **`as`/`satisfies` were treated as cast keywords after ANY token.** The comment
  said "only when it follows an expression"; the code tested `p >= 0`, which is
  true of the `.` in a member access. So a method with one of those names was
  eaten along with its arguments — including `Bun.semver.satisfies(…)`, an API
  this very runtime ships.

The pattern is the same each time: a rule that is right for the shape it was
written against, applied in a position nobody tried. When adding one, write the
counter-example too — the plain-JavaScript construct that must come through
BYTE-FOR-BYTE — not just the TypeScript one that must disappear.

### Feature-detecting a Node API by `typeof` — `Readable.toWeb` is the trap

**Do not write `X.method ? X.method(…) : fallback` against a vendored Node API.**
Our `node/lib/*` are Node's real files, so the *method exists*; what may not exist
— or may not work — is the **implementation** underneath. `Readable.toWeb` has
failed that way twice, in two different shapes, and the presence check held through
both of them:

```js
typeof Readable.toWeb === "function"                              // true in the VM, in BOTH acts
return Readable.toWeb ? Readable.toWeb(nodeStream) : nodeStream;  // so this never takes the fallback —
                                                                  // the throw lands one frame later
```

1. **It was a stub.** `node/internal/webstreams/adapters.js` used to implement only
   `fromWeb` (what consuming a `fetch()` body needs) and left the other directions
   as functions that threw `ERR_METHOD_NOT_IMPLEMENTED`. That bit three separate
   places (`BunFile.stream()`, `Bun.spawn().stdout` and `.stderr`); `Bun.spawn()`
   shipped in a state where every call threw.
2. **Then the real implementation died on an import line.** All six converters are
   genuine now — but the version that merged kept upstream's
   `const finished = require("internal/streams/end-of-stream")`, which is correct
   upstream because *upstream's* copy of that module is callable. **Ours exports
   the pair `{ eos, finished }`**, so `finished` bound the module object and every
   conversion threw `TypeError: finished is not a function` at the first
   `finished(stream, cb)` — a bare `TypeError` with **no `code`**. All three
   `toWeb` directions were dead in the VM; the three `fromWeb` directions were
   unaffected, which is why corepack never noticed. The fix is
   `const { eos: finished } = require("internal/streams/end-of-stream")`.

Act 2 is the stronger version of the lesson, not a retirement of it: a presence
guard sails past a code-less `TypeError` exactly as happily as past
`ERR_METHOD_NOT_IMPLEMENTED`, and this time there is not even an error code to
match on. Both acts were invisible outside the VM for the same structural reason:
**the offline spike tier runs on host Node, where `toWeb` genuinely works**, so the
guard passes there and the code only fails inside the real VM.
`scripts/probe-node-registry.mjs` cannot see this class either, and says so in its
own header — a registered id whose exports lack the member the caller destructures
passes the probe, because the id resolves and only its *shape* is wrong.

Two rules follow:

1. **Detect by behaviour, not by presence** — or better, don't detect: build the
   `ReadableStream` by hand from `'data'`/`'end'`/`'error'` (see the `web()` helper
   in `builtins/bun.js` and `.stream()` in `builtins/bun-file.js`). Read those two
   comments before assuming why they are hand-built, though: `toWeb` works now, and
   they stay hand-built on their own merits — `.stream()` for its laziness and its
   one-chunk-≤64-KiB-per-pull bound, `Bun.spawn()` because it returns the Node
   stream unchanged in a realm with no global `ReadableStream`, where `toWeb`
   throws `ERR_METHOD_NOT_IMPLEMENTED`.
2. **Anything touching Web-Streams interop must be proven in the kernel tier**
   (`scripts/spike-bun.mjs`), not just the offline tier. If a check would pass on
   host Node for a reason that has nothing to do with our runtime, it is not
   evidence. This is the rule that caught act 2 — CI reported it as
   `toWeb-throws:undefined`. The spike now converts a real `Readable` in the VM and
   **reads the bytes back** (present / does not throw / yields `toweb-bytes`),
   because "did not throw" would also pass for a converter that hands out an empty
   stream, and it reports `e.code || e.message` so a code-less failure is nameable
   from the CI log alone. The `toWeb-works` half of that landed with the fix
   (!125); the byte read-back was added afterwards, in an environment that could not
   build the Wasm VFS the kernel tier needs, so it shipped un-run in the VM. **It has
   now run there and passes** — `toWeb-reads:toweb-bytes`, on a tree with the Wasm
   crates built (recorded because the note above correctly flagged itself as
   unverified, and that flag should not outlive the verification).

**Act 3, the same trap one layer down: `node:zlib`'s brotli and zstd.** Both
families are exported by our vendored `lib/zlib.js` — `typeof
zlib.brotliCompressSync === "function"` is `true` — and both die on
`binding.BrotliEncoder is not a constructor`, because `packages/codec` is built on
flate2 and carries neither engine. Worth reading twice if you are about to trust a
comment: the binding's header *said* "brotli/zstd are present so lib/zlib.js's
module-level range asserts pass, but their handles throw", and the handles did not
exist, so what actually threw was a `TypeError` from inside Node's own source
naming a class the caller never heard of. The comment documented an intention
nobody had implemented, and it read as reassurance for however long it sat there.
The handles now exist and throw a sentence naming the missing engine (the
`bun-unsupported.js` pattern, applied to a Node builtin). **Two habits follow: run
the API in the VM rather than reading its export list, and treat a comment
describing behaviour as a claim to test, not a fact.** An exported function is not
an implemented one, and neither is a comment.

Brotli has since gone the rest of the way: `packages/codec` carries the pure-Rust
`brotli` crate, and `spike-zlib-brotli.mjs` round-trips it against the host's real
libbrotli in both directions. Two things that cost time there are worth keeping.
The constants table is **load-bearing beyond lookup** — `lib/zlib.js` sizes its
params array by the largest `BROTLI_PARAM_*` value it can find in
`constants`, so with none defined the array was length 1 and every
`{ params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }` failed as
`ERR_BROTLI_INVALID_PARAM: undefined is not a valid Brotli parameter`, naming the
option rather than the missing constant. And the wasm went from ~50KB to ~1MB
(~485KB gzipped) for the encoder's tables and static dictionary — real, and paid
at kernel boot, so if that budget ever matters the engine is the thing to look at
first. Zstandard stays absent for a *different* reason than brotli was: every Rust
zstd compressor binds the C library, which does not build for
`wasm32-unknown-unknown`.

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

### Booting a spike kernel must not need the network — and a hand-rolled boot is the symptom
`bootSpikeKernel()` used to copy the vendored real npm tree into the VFS at boot,
and `process.exit(2)` if it was absent. The tree comes from the live registry and
`run-spikes.mjs` only provisions it for the **`--net`** tier, so every kernel the
harness produced was quietly a registry-dependent kernel. `http-binary-body` is
registered `net: false`, tests binary request bodies and installs nothing — and
it went red on master in the PR-gating `verify` job, exiting 2 before its first
assertion.

Two things to take from it. First, **the npm load is now lazy**: `npmInstall()`
pulls it in on demand, a spike that shells out to `npm` itself asks with
`bootSpikeKernel({ npm: true })` (only `vitest` and `bun-install` do), and the
"no vendored npm" refusal is unchanged for anything that installs. Until it
loads, `/bin/npm.js` is a stub that names the missing knob rather than failing as
`npm: not found` five layers down.

Second, and more useful: **when a spike hand-rolls `new Kernel(...)` instead of
using the harness, read the comment above it as a bug report.** Three had, to get
away from this one coupling — `spike-bun-templates.mjs` even said so in a comment
— so the helper that exists to kill copy-pasted boilerplate was being routed
around by the spikes it was written for. Those three are back on the harness.
`diag-liveness` is the one that legitimately is not: it needs a pid→handle map
and a message hook ahead of the kernel's routing, which is spike-specific, and
its header says so. `spike-ci-tiers.mjs` (offline, Wasm-free, so it runs in the
earliest gate) now asserts that no `net: false` spike reaches a
registry-provisioned artifact, that the vendored path is read in exactly one
place in the harness — which is what keeps that list of ways complete — and that
every `needsWasm` offline spike is named in ci.yml's Wasm-VFS step, an invariant
that until now was a comment enforced by nothing.

It also asserts the converse, which the list above was missing: **an offline
spike that boots a kernel must be marked `needsWasm`, even when its guest never
opens a file.** `net-close-order` and `net-blocklist` were registered "Wasm-free:
no filesystem is touched", which is true of the guests and irrelevant — booting a
kernel starts the fs worker, and that worker loads the VFS crate before any guest
runs. Both crashed `toolchain-gate` with `MODULE_NOT_FOUND`, and no local run
could have caught it, because a developer's tree has the crates built.

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
- Large **inbound HTTP request bodies** (an upload to an in-VM server) spill to
  `/var/run/vv-http/<reqId>.bin` in `kernel._stageInboundBody`; the request
  carries `bodyPath` instead of `body` and the guest reads it with plain `fs`.
  Smaller bodies cross inline, binary ones as `{body, bodyEncoding:'base64'}` —
  the inbox is JSON, so a raw `Buffer` there becomes `{type:'Buffer',data:[…]}`
  and the guest's `creq.end()` HANGS rather than failing.
- `respondOk` now throws if a response exceeds the window, naming the size. It
  used to be a bare `RangeError` out of `Uint8Array.set` that killed the kernel.
- If you add a syscall that can carry big data, chunk it from day one.
- **Whether a body crosses as utf8 or base64 is decided by the BYTES, never by
  the Content-Type.** `bridgeHttp` decodes with `TextDecoder('utf-8', {fatal:
  true, ignoreBOM: true})` and falls back to base64 when that throws. A header is
  a claim about how to *interpret* bytes, not a promise that they are utf8 —
  `text/html; charset=iso-8859-1` promises the opposite. Trusting it turned every
  high byte into U+FFFD (a 1.5 MiB latin-1 page came back 4.6 MB of replacement
  characters, status 200, no error anywhere). `ignoreBOM` matters for the same
  reason in reverse: the default STRIPS a leading U+FEFF, so bodies from
  BOM-prefixed files silently lost three bytes on a path where everything was
  valid utf8. The shared `decodeBytes` in `protocol/syscall.js` sets it too.
  Gated both directions by `spike-http-binary-body.mjs` (request) and
  `spike-http-response-bytes.mjs` (response), which assert the encoding chosen as
  well as the bytes — text that starts arriving base64 is a silent 33% inflation.

### A guest that emits root-absolute NAVIGATION URLs escapes the preview
Under path routing (modes A/B) a preview lives at `<origin>/preview/<port>/`, and
the SW strips that prefix before the kernel sees the request, handing it back as
**`x-forwarded-prefix`** — Python's bridge reads it as WSGI `SCRIPT_NAME` / ASGI
`root_path`. A Node guest has to do it by hand:
`const base = (req) => req.headers['x-forwarded-prefix'] || ''`.

The distinction that catches people is **navigation vs subresource**. A
`fetch('/api/x')` from the preview page survives a missing prefix, because
`routeByClient` resolves it from the iframe that issued it. A form POST, a plain
link and a `res.redirect('/')` are top-level navigations, and `sw.js` returns
early for `mode === "navigate"` on purpose (proxying the studio's own document
left the page loading forever). So `action="/login"` does not reach the guest at
all — it goes to the network and 404s against the studio itself, which is exactly
how the session template shipped and broke on the first click.

An absent header means a wildcard per-port origin (mode C), which serves at the
root, so the empty string is the right answer there. `spike-session-studio.mjs`
drives the shipped template both ways.

**For an app that emits HTML, do it in one place with `HTMLRewriter` rather than at
every call site.** Concatenating the prefix onto each URL as you build it is a thing to
forget in one branch out of nine, and the symptom (one link out of the preview) looks
nothing like the cause. A pass over the finished page — `a[href], link[href],
form[action]`, prefix anything starting `/` but not `//` — is a dozen lines, knows
nothing about the app, and is the shape the `bun-fullstack` template ships;
`spike-bun-templates.mjs` gates both directions, since "no header means no rewrite" is
the half that rots quietly. A redirect `Location` still needs doing by hand.

### The kernel keeps the cookie jar, because the browser will not
`packages/kernel-host/cookie-jar.js`, wired into `kernel.handleHttpRequest` as
`_attachCookies` (in) and `_harvestCookies` (out). **One jar per listening port**,
because that is what a real machine gives you — `localhost:3000` and
`localhost:5173` are separate origins with separate jars, and one shared jar would
leak an API's session into a frontend.

It is not an optimisation; without it no session works at all. The preview seam
drops cookies in BOTH directions and neither is an error anyone can see:
- **out**: a `Set-Cookie` on a Response the Service Worker synthesises never
  enters the browser's cookie store — the store is filled by network fetches, and
  this response never touched the network.
- **in**: the browser appends `Cookie` during the network step, which happens
  AFTER the Service Worker, so the SW cannot read it and cannot forward it.

So `express-session`, Passport, a CSRF cookie: login returned 200, the next
request arrived with no `Cookie` header at all, the app answered 401, and nothing
logged anything, because nothing was wrong — the client simply never sent it back.

Implemented from RFC 6265 and worth knowing: a cookie's identity is
**(name, path)**, not name (a server may hold `sid` for `/admin` and another for
`/`); a `Path`-less cookie gets the **default-path** — the *directory* of the
request, so one set by `POST /api/login` must NOT reach `/`; path-match needs the
boundary check, since `/foo` must not match `/foobar`; `Max-Age` beats `Expires`,
and `Max-Age=0` is a delete (that is what `res.clearCookie()` sends). `Domain`,
`Secure`, `SameSite` and `HttpOnly` are parsed and ignored on purpose — one host,
no scheme, no cross-site request, and nothing here is reachable from page JS.

**A request that already carries a `Cookie` owns it** — the jar stays out entirely
rather than merging. Merging was the first version, and `spike-bun.mjs` caught why
it is wrong: a driver handing over an explicit `Cookie: a=1; b=2` describes one
client, and adding a session another client left in the jar cross-contaminates
them. It costs nothing on the real path, where a preview request never arrives
with a `Cookie` header at all.

Also: `new Headers({...})` **stringifies an array**, and Node keeps `set-cookie`
as an array — so `sw.js` turned two cookies into one comma-joined header, which an
`Expires=Wed, 21 Oct ...` makes unsplittable. Append entries one at a time.

Bounded like a browser's — 4096 bytes per cookie, 180 per jar, oldest evicted —
because a jar with no limit is a guest setting cookies in a loop and a `header()`
that walks all of them per request. An oversized cookie is dropped rather than
truncated: half a signed session id verifies as nothing, so truncating would look
like corruption instead of refusal. A jar deliberately **outlives** the process
that filled it: restart a dev server on the same port and a real browser still
holds its cookies, so clearing on exit would log you out on every code reload.

Gated by `probe:cookie-jar` (semantics, pure), `spike-cookie-session.mjs`
(offline, end to end through a real in-VM server) and `spike-session-studio.mjs`
(net: real `express-session`, which signs and url-encodes the cookie a
hand-written server would never notice being mangled).

### The Fetcher strips non-CORS-safelisted request headers — for the REGISTRIES only
`packages/runtime/egress-header-policy.js` decides what the browser Fetcher Worker
puts on a `fetch()`. For a package registry it keeps ONLY the CORS-safelisted
request headers (`accept`, `accept-language`, `content-language`, a simple
`content-type`). Real npm/pacote attach custom headers (`npm-command`,
`npm-session`, `npm-auth-type`, `pacote-*`, `authorization`, …); any non-safelisted
header makes the browser fire a preflight `OPTIONS`, and `registry.npmjs.org` does
not answer it with a matching `Access-Control-Allow-Headers` — so the request is
blocked even though the actual GET returns `Access-Control-Allow-Origin: *`. None
of those headers are needed to fetch public packuments/tarballs, so dropping them
turns every registry request back into a simple, preflight-free GET. (Symptom if
you regress that: "blocked by CORS policy … No 'Access-Control-Allow-Origin'
header" for every registry URL.)

**Every other host keeps its headers, and the scoping is the point.** The strip
used to apply to all of them, which made authenticated egress silently wrong
rather than broken: a SigV4-signed S3 request lost `Authorization` and every
`x-amz-*`, went out ANONYMOUS, and against a public bucket came back **200 with
the wrong bytes** (a dropped `Range` returns the whole object). Nothing errored.
The same held for any `Bearer` API.

**No spike can catch a regression here.** Node has no CORS and the headless
fetchers in `scripts/spike-*.mjs` forward the full header set, so the browser and
headless paths genuinely differ and green spikes prove nothing about the tab. The
policy is therefore pure, shared, and asserted directly:
`npm run probe:egress-headers` (offline, in `toolchain-gate`). If you need to see
the divergence end to end, `scripts/probe-s3-cors.mjs` signs with a bogus key
against a public bucket and reads AWS's answer — `InvalidAccessKeyId` means the
header survived, a 200 means it was dropped.

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
- `node/internal/fetch-transport.js` `_dispatch()` prefers `__ocfetchAsync` and
  falls back to the blocking `globalThis.__ocfetch`; keep the fallback (it's the
  compatibility path when async isn't wired). This is the transport under BOTH
  `lib/https.js` and `http`'s egress path — see the next gotcha.
- The kernel bounds fan-out: `fetchConcurrency` (10) via `_scheduleFetch` /
  `_drainFetchQueue`, dedupes identical in-flight URLs (`_fetchInflight`), and
  streams each body into the VFS (`_fetchIntoVfs` / `_doNetworkFetch`) with the
  SAME cache + dedupe as the blocking path. Don't drop the cap or the dedupe — a
  burst of npm downloads would otherwise open hundreds of sockets at once.

### `http` egress: split loopback from outside on the HOST, never on the port

`http.request` has two possible transports and picking the wrong one is expensive
in both directions. `lib/http.js` is Node verbatim and its client ends at
`net.createConnection`, which our loopback-only `net` cannot use to reach an
outside host; so `internal/http-egress.js` wraps `request`/`get` where the loader
builds the module (`loader.js`'s `httpWithEgressFactory`) and sends only the
unreachable destinations over the Fetcher Worker, via the same
`internal/fetch-transport.js` that backs `https`. **Do not grow a second
fetch-backed client** — one drifting copy per protocol is exactly what that file
exists to prevent.

The decision is made by the virtual network's own predicate,
`internalBinding('tcp_wrap').isLocalDestination` — the same function object
`bindings/net.js`'s `connect()` accepts or refuses a dial with, so the two cannot
disagree. **Do not re-derive it by pattern-matching hostnames, and do not route on
the port.** The port registry answers a different question and is wrong both ways:
"we serve `:3000`" would send `http://api.example.com:3000` to the in-VM dev
server (the silent-wrong-answer bug that was fixed by making `connect()` refuse
non-local destinations — never restore any form of it), and "we do not serve
`:9999`" would send `http://127.0.0.1:9999` to the internet instead of reporting
`ECONNREFUSED`, which every wait-for-the-dev-server-to-start loop depends on. A
cross-process in-VM port isn't in this process's registry at all.
Everything ambiguous resolves to the vendored net path: unclear URL, `socketPath`,
a caller-supplied `createConnection`, an agent that overrides it (proxy agents), an
agent carrying `kProxyConfig`. Wrong in the permissive direction sends a request
meant for the preview server out to the internet; wrong the other way only
reproduces the honest `EHOSTUNREACH`. Gate: `node scripts/probe-http-egress.mjs`,
whose routing table cross-checks every branch against a real `net.connect()`.

Two limits worth knowing before you debug a report: plain `http://` egress is
subject to the browser's **mixed-content** rules (an `https://`-served studio can
only fetch `http://localhost` / `127.0.0.0/8` / `::1`; a LAN or public `http://`
host is blocked no matter what the runtime does — the failure says so), and a
protocol **upgrade** (WebSocket, `CONNECT`) can never ride a fetch, so it fails
with `ERR_VIVARI_UPGRADE_UNSUPPORTED` rather than hanging. `ws://` to an in-VM
server is unaffected: that's loopback.

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

If a `.node` file is nevertheless `require()`d — a prebuilt binary that shipped in
the tarball, which is the usual case for `bcrypt`/`sharp`/`better-sqlite3` — the
loader throws `nativeAddonError` from `builtins/bun-unsupported.js`: it names the
package, says a browser tab has no `dlopen(3)` and cannot execute machine code,
and prints the substitute where one is VERIFIED to run in-VM. Two details are
load-bearing. The check sits at the top of `compile()`, not only on
`Module._extensions['.node']`, because `load()` calls `compile()` directly and
never consults the extension table — the binary was otherwise read as UTF-8 and
reported as `SyntaxError: Invalid or unexpected token`. And `.node` is
deliberately NOT in the resolver's `EXTS`: a package that probes
`require.resolve('./build/x')` before falling back to pure JS must keep getting
"not found", or it takes the native branch and fails. Add to
`NATIVE_ADDON_SUBSTITUTES` only what a spike or a shipped template proves runs
here — a wrong recommendation is worse than none, which is why `sharp`, `canvas`
and `node-sass` are listed as "no verified substitute" rather than guessed at.
`process.dlopen` throws the same error, because `node-gyp-build`, `bindings` and
`node-pre-gyp` resolve the path themselves and call it instead of `require`.

### The vendored napi host shadows the installed one — EXCEPT against emnapi 2
`node/loader.js` maps the bare specifier `@napi-rs/wasm-runtime` to our vendored
copy (`node/vendor/napi-wasm-runtime.js`, 0.2.12), so it shadows whatever the
project installed. That is deliberate: the copy carries a loop-liveness patch,
without which an addon that `unref`s its worker pool lets our cooperative loop go
idle and the process exits mid-build having emitted nothing (exit 0, no output).

emnapi 2 is the exception. An addon ships a matched set — binding, napi host and
`@emnapi/*` halves built together — and the bridge between host and emnapi is a
private ABI, not a public API: emnapi 2's `NodeEnv` calls `bridge.setLastError`/
`deleteEnv`, which the 0.2.x bundle has never heard of, so the addon dies in
instantiate with `this.bridge.setLastError is not a function`. `module.js`
therefore resolves `@napi-rs/wasm-runtime` from the project whenever its tree has
`@emnapi/runtime` major >= 2 (rolldown >= 1.2.1 — i.e. every Vite 8 project) and
keeps the vendored host for everyone else. Do NOT widen that to "always prefer
what's installed": the emnapi-1 bindings (rspack, Tailwind's oxide) hang on their
own newer hosts, which take a threaded path the vendored one sidesteps. Both
sides are gated by the nightly network tier — `spike-preact` for emnapi 2,
`spike-rspack`/`spike-tailwind` for emnapi 1.

### A Vite 8 template must DECLARE `@rolldown/binding-wasm32-wasi` — nothing else installs it
Vite 8's bundler is rolldown, whose wasm binding is a separate package. Up to
rolldown **1.2.1** that package was one of rolldown's `optionalDependencies`, so
npm's platform auto-select installed it on `wasm32` and rolldown's loader found it
by `require`. **1.2.2 removed it from that list**, and nothing replaced it: from
then on the loader's only remaining route was its WebContainer fallback, which
`execFileSync`s **`pnpm i @rolldown/binding-wasm32-wasi@<version>`** into
`/tmp/rolldown-<version>` — a path that needs `pnpm` on the guest's PATH and a
registry fetch at dev-server start. With npm alone the spawn fails, the loader
swallows it, and you get `Error: Cannot find native binding. npm has a bug related
to optional dependencies …`, which names the wrong cause. Every `vite: ^8` template
therefore lists the binding itself — the same move AGENTS.md already documents for
Next's `@next/swc-wasm-nodejs`, and it is better than the fallback either way: no
runtime download and no dependency on which package managers a guest happens to
have. Symptoms to recognise: the dev server never binds its port, and the log's
last useful line is `[rolldown] Downloading … on WebContainer`. The version check
that would reject a mismatched binding only runs under
`NAPI_RS_ENFORCE_VERSION_CHECK`, so a binding whose range drifts away from
rolldown's will be *used*, not rejected — keep the two ranges in step, and note that
`template-gate` is what will tell you when they part.

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
- **`bun:sqlite` is a fourth, different thing** — same idea (a wasm SQL engine over the
  VFS) but the engine ships WITH us instead of coming from the project's `node_modules`,
  and it is instantiated synchronously because Bun's API is. See the Bun section below.

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
- **A backslash inside a template's source belongs to the OUTER literal first.** Template
  source lives in template literals, so `/^https?:\/\//i` reaches the generated project as
  `/^https?:///i` — the `//` opens a comment, the statement never closes, and the app dies at
  boot with a `SyntaxError` pointing at the *next* line. Prefer string methods
  (`startsWith`) over regex literals in template source; if a regex is unavoidable, double
  the backslashes and check the emitted bytes, not the source you typed. `spike-template-syntax.mjs`
  runs `node --check` over every shipped template on every push and catches exactly this —
  it was written after the S3 template shipped the bug above with a green network-tier spike.
  If a template's source outgrows a literal, move it to a sibling `.js` module the way
  `s3-app-source.js` does, so the gate and the template read the same bytes. The same split
  is why the notebook is testable at all: its model, `.ipynb` round-trip, execution queue and
  output policy are plain `.js` with sibling `.d.ts` in `vv/notebook/`, so
  `spike-notebook.mjs` drives the exact bytes the studio ships. That is not a style
  preference — a notebook is a UI surface and there is no browser in CI, so the line between
  the `.js` modules and `NotebookView.tsx` is the line between what a spike can prove and
  what it cannot. Keep new logic on the `.js` side; leave layout in the component.

### A sticky row needs a capped scrollport, the right containing block, and a z-index budget
Four independent traps, none of them visible in the DOM, all hit while pinning the Explorer's
folder rows (`Explorer.tsx`):
- **`flex-1` alone does not make a scrollport — the flex child also needs `min-h-0`.** A flex
  item's automatic minimum size is its CONTENT size, so `<ScrollArea className="flex-1">` grew
  to the height of the whole expanded tree instead of being capped by the sidebar. Nothing
  overflowed, so Radix's viewport never scrolled, the rows past the bottom of the sidebar were
  simply unreachable, and `position: sticky` had zero distance to travel. It presents as "the
  tree is cut off", which sends you looking at the tree. Any scrollable child of a flex column
  here needs `min-h-0`.
- **The sticky style must sit on the element whose containing block is TALL.** A sticky box can
  only move within its own containing block, so putting it on the row `<div>` inside
  `ContextMenuTrigger` does nothing — that block is exactly one row high. It belongs on the
  `ContextMenuTrigger`, whose parent wrapper also holds the subtree. A parked row also needs an
  opaque background (`bg-sidebar`) or the rows sliding under it show through.
- **A positioned row outranks the ScrollArea's own scrollbar.** `ScrollArea.Root` is
  `position: relative; z-index: auto` — so NOT a stacking context — and Base UI's scrollbar
  inside it is `position: absolute; z-index: auto`. The moment any row in the viewport takes a
  z-index it paints over the scrollbar *and* becomes the hit-test target for the pointer events
  meant for the thumb: measured, `elementFromPoint` down the track's centre-x returned Explorer
  rows for the top 139 px of a 264 px track, so a `mousedown` there **would** reach the
  project-root row, whose handler collapses the project. (That last step is inferred, not
  observed: no grab of the thumb was ever dispatched, because the probe's mouse-drag stage dies
  on a CDP `Input.dispatchMouseEvent` protocol error in this sandbox. The hit-test is the
  evidence, and it is at least what the browser itself uses to pick an event target.)
  Note it hits every sticky row, not just parked ones — a sticky box is positioned whether or
  not it is currently stuck. `scroll-area.tsx` therefore pins the scrollbar at `z-30`: above any
  content ramp, below the app's z-40/z-50 overlays. Keep new z-indexes inside a ScrollArea
  under 30.
- **Nothing that scrolls a row into view knows the stack is there.** `scrollIntoView` and
  `focus()` both align their target with the scrollport's *top* edge, which is exactly where the
  parked rows live, so "reveal the active file" and the inline new-file input each revealed a row
  that was 100% behind them. Reserve the band with `scroll-padding-top` = the stack height above
  the target (`depth * ROW_H`) — that is what `revealRow` does, per call, since the height
  depends on the target's depth — and pass `preventScroll` to `focus()` so the browser doesn't
  get its own unpadded scroll in first.

The stack offsets (`top: depth * ROW_H`) only add up while every row in the stack is exactly
`ROW_H` tall, which is why the root row and the folder rows now SET their height instead of
inheriting it from their different font sizes.

### `scrollIntoView({ block: "nearest" })` is *minimum* scroll, so the row parks on the edge

Reserving the band is only half of "reveal a row"; the other half is the alignment, and `nearest`
is the wrong default for an active-file reveal. It is specified as the least scrolling that puts the
element inside the scrollport, so revealing a row from below leaves it flush against the **bottom
edge, every time** — with no context under it and nowhere to look next. It is not a bug and it will
not present as one: it reads as "the tree keeps dumping the file at the bottom", which is what the
user reported. `block: "center"` is the fix, and two things about it are worth knowing because they
save writing arithmetic (both measured here, not assumed):

- **It honours `scroll-padding-top`.** Per CSSOM-View the padding shrinks the *optimal viewing
  region*, and `center` centres within the reduced band — so it composes with the sticky-stack
  reservation above rather than fighting it. Measured with `padTop` 48: the row landed exactly on
  the band centre and therefore 24px (`padTop / 2`) below the raw viewport centre.
- **The browser clamps the result**, so "as close to the middle as possible" at the ends of the
  list is free. A target near the top settles at `scrollTop: 0`, one near the bottom at
  `maxScroll`, both off-centre by exactly the amount the scroll range denies.

Two judgement calls that are easy to get wrong. **Do not centre unconditionally** — that lurches
the tree on every tab switch, including when the row was already in plain sight. Skip the scroll
when the row has real clearance inside the band; a strict "is it visible" test is not enough,
because a row one pixel inside the bottom edge passes it and stays parked, which is the original
complaint intact. And **alignment is per-call, not global**: the active-file reveal wants centring,
but the inline rename / new-file input has just appeared next to a row the user clicked, so it
wants minimum scroll — just clear of the parked stack, without yanking the list under a pointer
that has not moved.

`monaco-editor` ships `vs/base/browser/ui/list`, whose `reveal(index, relativeTop, paddingTop)` has
both behaviours — fractional positioning clamped by `setScrollTop`, or a minimum-scroll branch when
`relativeTop` is omitted — and folds `paddingTop` into the arithmetic exactly as the sticky-scroll
controller passes it in `abstractTree.js`. Useful for the semantics. It does **not** settle policy:
`monaco-editor` ships no `vs/workbench` at all, so which alignment the Explorer should use, and when
it should reveal, cannot be confirmed from `node_modules` and has to be argued on its own merits.

### A collapsible panel must take its `ResizableHandle` with it

In `AppShell.tsx` a panel and the handle that splits it from its neighbour are two sibling
elements, and only the panel is interesting to look at — so the natural way to make one
collapsible is to wrap the `ResizablePanel` in `{!collapsed && …}` and leave the handle alone.
That leaves a **live 4 px draggable divider with nothing on the other side of it**, pinned to
the edge of the window. It is nearly invisible (1 px of border, a wider transparent `::after`
grab strip) and it still drags, so it reads as the UI being broken rather than as a stray
element. The preview panel shipped without a collapse state for exactly this reason — it was
the only one of the three whose handle was a bare sibling instead of being wrapped with its
panel in a fragment.

Put both in one fragment, which is what the sidebar and the bottom panel already do:

```tsx
{!snap.previewCollapsed && (
  <>
    <ResizableHandle />
    <ResizablePanel id="preview" defaultSize="32%"><PreviewPanel /></ResizablePanel>
  </>
)}
```

Check it structurally rather than by eye — every handle should have a `resizable-panel`
immediately before and after it in its group, in every combination of collapsed panels. Note
that the handle count will not match the number of visible panels: `TerminalPanel` brings a
nested `term-content | term-list` split of its own, so the totals run 0/1/2/3/4 across the eight
combinations, not 0/1/1/2. One of those handles also lives in a hidden `0x0` subtree whenever the
bottom panel is showing CONSOLE rather than TERMINAL, so it hit-tests to nothing — expect it, and
exclude it, instead of reading it as a regression.

### A `ResizableHandle` needs `z-index` or the neighbour eats its grab strip

The separator is a **1 px** element between two panels; the thing you actually grab is a 4 px
transparent `::after` centred on it, so half of it overhangs each neighbour. At `z-index: auto` the
separator loses to any neighbour that establishes its own stacking content, and the overhang becomes
undraggable. Measured here: only offsets **−3, −2, −1** hit-tested to the handle, so the strip was
3 px and grabbable from *one side only* — you had to approach the splitter from the correct
direction. Monaco's `margin-view-overlays` blocked one handle and the preview's `absolute inset-0`
blocked the other.

`relative z-10` on the separator fixes it (4–5 px, both sides). Pick the number deliberately: it has
to beat sibling panel content but stay under the ScrollArea scrollbar's `z-30` and the app's
`z-40`/`z-50` overlays, or the splitter starts stealing scrollbar drags. Verify by dragging from the
*neighbour's* side, at `+1 px`, not from the centre — a centre-grab passes even when the bug is
present, and remember the handle moves with the drag, so re-measure before a second one.

### A tooltip is not an accessible name

Five helpers here wrap a `TooltipTrigger` around a bare icon and pass the human-readable string to
`TooltipContent` and nowhere else: `ActBtn` (`ActivityBar.tsx`), `HeaderBtn` (`Explorer.tsx`),
`IconBtn` (`SourceControlPanel.tsx`), `ToolButton` (`PreviewPanel.tsx`) and `CtrlBtn`
(`DebugPanel.tsx`). That looks complete, and for a sighted user it is, so the omission survives
review: a Base UI tooltip is `aria-describedby` at best and only while it is open, so the button's
accessible name stays **empty**. Pass `aria-label={label}` as well as the tooltip; the string is
already in scope. Worth catching rather than filing as an a11y nicety, because it also silently
breaks the way this repo verifies its own UI — `page.getByRole("button", { name: "Search" })` times
out, which reads as a broken selector rather than a missing label, and the tempting workaround is a
class selector.

**But do not label a control whose visible text is the value.** `aria-label` *replaces* the
content, so the reflex of "add the label prop everywhere" is a regression on any control that
already reads correctly. Every clickable `StatusBar` cell wraps a value in an action label —
`label="Select Indentation"` around `Spaces: 2`, `"Current branch"` around the branch name,
`"Go to Line/Column"` around `Ln 1, Col 1` — so labelling them turns "master, button" into
"Current branch, button" and the value the user wanted becomes unreachable. It also breaks WCAG
2.5.3 Label in Name: voice control says "click Spaces" and no longer matches. The same trap sits on
`SourceControlPanel`'s branch picker. Leave both alone; the tooltip is the right home for the
action, and the text is the right accessible name. An `aria-label` on a non-interactive `<span>`
(the diagnostics readout) is not a fix either — with no role, screen readers largely ignore it.

**A rendered-DOM audit enumerates only what the current state renders.** This is the part that has
now cost two commits. Walking the live DOM found four helpers and missed `ToolButton` and `CtrlBtn`
entirely, because the preview toolbar renders only once a preview tab is active and the debug
controls only once debug mode is on — the audit ran with "No preview open" and no session, so those
buttons did not exist to be counted. The cursor pass hit the identical trap with `SearchPane` and
`SourceControlPanel` and needed a static-JSX backstop for exactly this reason. So: **drive the app
to measure behaviour, but enumerate statically.** For accessible names, scan every
`TooltipTrigger`, `<button>` and `role=button|switch|tab|menuitem` in `src` and sort them into
three buckets — carries a name attribute; renders its own text; renders `{children}`. The third is
not evidence either way and has to be resolved at the *call sites*, which is precisely where
`ToolButton`'s five icons and `StatusItem`'s six text values part company.

One booby trap if you write that scan: JSX attributes in this repo contain `//` comments, and those
comments contain apostrophes. A scanner that tracks quotes without first skipping comments opens a
string on `doesn't` and swallows the rest of the file — `PreviewPanel`'s `<iframe>` ate 8.4 kB and
hid all five `ToolButton` call sites, reporting a clean result. Validate any such scan against a
commit where you *know* the answer before trusting a zero.

### Tailwind v4's Preflight stopped giving `button` a pointer cursor

v3's Preflight set `button, [role="button"] { cursor: pointer }`. **v4 deliberately dropped it**,
so buttons fall back to the UA default `cursor: default` — silently, with no deprecation and no
error. Verify it in the installed copy rather than from memory: `node_modules/tailwindcss/preflight.css`
at v4.3.2 has no `cursor` declaration anywhere. It cost this app every button affordance in the UI
at once, which reads as a scatter of unrelated papercuts rather than one regression.

`index.css`'s `@layer base` now restores it once, and that is where it belongs — a rule per
component drifts, and a base rule also covers components that don't exist yet. Two things a blanket
rule must get right, both already handled there:

- **Exclude disabled controls** (`:not(:disabled, [aria-disabled="true"])`). This matches VS Code,
  which uses `cursor: default` — not `not-allowed` — for a disabled action item.
- **Keep it in `@layer base`.** Utilities outrank base, so a deliberate `cursor-text`,
  `cursor-not-allowed` or `cursor-col-resize` at a call site still wins. Put the same rule in
  `@layer components` or unlayered and it would start overriding them instead.

A base rule reaches only real `<button>`s and `[role="button"]`s. The clickable `<div>`s — Explorer
rows, editor/terminal/preview tabs, SCM rows — each need their own `cursor-pointer`, and drag
handles need `col-resize`/`row-resize` (they are dragged, not clicked, and react-resizable-panels
binds native listeners, so a React-props audit will not flag them as clickable — check them by
hand). And when you check, hit-test with `elementFromPoint` rather than reading
`getComputedStyle(el, "::after").cursor`: the latter reports the declaration, not what the pointer
lands on, and a neighbouring panel can paint over the outer half of a widened `::after` grab strip
— which is exactly what Monaco's margin overlays and the preview's `inset-0` layer did here, until
`resizable.tsx` got the `z-10` described below.
**When in doubt about a cursor
convention, `node_modules/monaco-editor` is VS Code's own CSS** and settles it locally:
`.monaco-menu .monaco-action-bar .action-item { cursor: pointer }` is why this repo's menu
primitives override shadcn's `cursor-default`, and `.monaco-list.mouse-support .monaco-list-row
{ cursor: pointer }` is why tree rows do.

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
- **This applies to TEMPLATES too, not just runtime changes.** The Starlight
  template shipped with a green `spike-starlight.mjs` and still hung on first run
  in the browser, because the harness's `npmInstall()` runs `node <vfs
  npm>/bin/npm-cli.js install` while the studio resolves `npm` through the
  `/bin/npm.js` shim, under `baseProcEnv` (`HOME=/`, cache in
  `/home/user/.cache/npm`), inside the **interactive** shell that auto-runs
  `<install> && <dev>` via `VV_RUN`. A heavy template needs a `*-studio.mjs` gate
  in the shape a user actually triggers — see `scripts/spike-starlight-studio.mjs`,
  which also budgets registry-metadata volume rather than wall-clock, since the
  failure there was "far too slow and memory-heavy", which no timeout catches
  reliably on fast CI.

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

### Rspress works in-VM (Docs template, graduated) — but MUST disable Rspack's persistent cache
Rspress is the Rspack-powered docs SSG, so it inherits the wasm Rspack path Rsbuild already
uses: `@rspress/core` → `@rsbuild/core` ^2.1.x → `@rspack/core` → `@rspack/binding`, whose
`optionalDependencies` include **`@rspack/binding-wasm32-wasi`**. Because the runtime reports
`process.arch === "wasm32"`, npm's platform auto-select picks that wasm32-wasip1-threads
binding and no native `.node` addon is ever fetched — **no registry aliasing needed** (unlike
esbuild/rollup/lightningcss, whose wasm builds live under a different package name).

- **Ship v2, and only v2 — `@rspress/core`, not `rspress`.** Rspress v2 shipped stable under
  the renamed package `@rspress/core` (2.x); the old `rspress` package stops at `2.0.0-beta`
  and its `latest` dist-tag still points at v1. And v1 is not merely older, it is *impossible*
  in-VM: `rspress@1.47.x` pins `@rsbuild/core ~1.3.18` → `@rspack/core 1.3.9` →
  `@rspack/binding 1.3.9` **exactly**, and `@rspack/binding` only began publishing
  `@rspack/binding-wasm32-wasi` in **1.4.0**. So v1's whole chain is exact-pinned to a
  pre-wasm Rspack and dies requiring a native addon.
- **THE GOTCHA: `RSPRESS_PERSISTENT_CACHE=false` is load-bearing.** Rspress (unlike plain
  Rsbuild) enables Rspack's **persistent build cache** by default
  (`performance.buildCache` in its Rsbuild config). That cache calls `std::process::id()`,
  which is unsupported on wasm32-wasip1, so the Rust core aborts with a hard panic — the dev
  server binds its port, prints its banner, and then never compiles:
  `thread 'tokio-0' panicked at library/std/src/sys/process/unsupported.rs: no pids on this
  platform` → `RuntimeError: unreachable`. Rspress gates it on `RSPRESS_PERSISTENT_CACHE`, so
  the template sets that in `manifest.env` (a framework-honored lever — no project config).
  Drop it and you get a blank page. This is the ONLY reason `rsbuildTemplate` boots in-VM
  while a stock Rspress config does not. Rspress's other Rust-adjacent default, **lazy
  compilation, was measured and is fine** in-VM — left at its default, do not "fix" it.
- The three VitePress gotchas do **not** apply: config goes through `@rsbuild/core`'s own
  `loadConfig` (the loader the green Rsbuild template already exercises with an `.mjs`
  config, so the template ships `rspress.config.mjs`); the bundled Tinypool is used only by
  SSG page rendering in `rspress build`, never the dev server, and the runtime already
  defaults `PISCINA_DISABLE_ATOMICS=1`; and Shiki runs inside the async MDX/unified pipeline
  (`@shikijs/rehype`), not synckit, so there is no language allowlist to maintain.
- Client-routed SPA (react-router history mode) → config `base: "/preview/3000/"` +
  `keepPreviewPrefix: true`, forwarded to Rsbuild as `server.base`.
- Gated by `scripts/spike-rspress.mjs` (net tier, 900s). Gate 1 asserts the wasm binding
  landed **and** that no native `@rspack/binding-*` did, so a regression onto a native addon
  fails loudly. Run `VV_BASE=/preview/3000/` to exercise the base-prefixed path the template
  ships (shell + an asset under the prefix); the default `/` is the fast regression run.

### Astro Starlight (Docs template) — pinned to Astro 5, `ec.config.mjs` is mandatory, and its install MUST skip lifecycle scripts
**The four-round "install hangs forever" bug was sharp's install script, and it was a deadlock.**
`astro` depends on sharp; npm runs `node install/check.js` during reify, immediately after the
downloads finish — precisely where every user report stopped. Caught in the act, `__vv.diag()`
reports:

```
pid 3  npm install                                    idle 153s
pid 4  sh -c node install/check.js || npm run build    idle 152s   [node_modules/sharp]
pid 5  node install/check.js            28 modules, 2 syscalls, idle 152s
```

with `fetch` inflight/queued/active all 0, `pendingHttp` 0, `booted: true`, `paused: false`. The
script loads, does almost nothing, and then never exits — it is not waiting on anything, and the
runtime never concludes it is finished. npm waits on the child forever. The template therefore
installs with `--ignore-scripts` (same choice as the Angular template; the project's
`package.json` stays vanilla), which removes the mechanism rather than timing it out: **4 of 4
runs wedged before, 2 of 2 completed after**, on the same rig. Nothing is lost — the image
service is passthrough so sharp is never loaded, and esbuild's postinstall is moot because the
registry aliases it to esbuild-wasm.

**Reproducing it needs a slow page, which is why it went unreproduced for three rounds.** A
production build usually wins the race and installs fine; the studio served by `vite dev` wedges
every time. Serve `vite dev`, ensure `vendor/depcache/index.json` is NOT served so the install
path is actually taken, then run `scripts/repro-starlight-browser.mjs`.

**The terminal is not dropping output — this was measured, not assumed.** The rig reads the text
xterm actually painted (`.xterm-rows`, every panel), not character counts. `added 364 packages`
reaches the screen, 0.4s after the `tsconfck` warning that precedes it, as does the runtime's
watchdog line, in order, including output that follows a `\r`-terminated progress line. Two
traps if you repeat this: the studio runs **three** xterm instances, and reading only the first
captures the boot console while a healthy project terminal looks frozen; and the DOM renderer
holds only the visible viewport, so a row that scrolls away between samples is never observed
even though it was painted — absence is not evidence of a drop.

**Still unexplained (but not the hang):** `astro dev` throws 8–113 uncaught
`SyntaxError: "[object Object]" is not valid JSON` per run inside its process worker; Rspress on
the same path throws zero. The dev server bound in 7 of 7 runs on HEAD with all of them firing,
so they are not fatal today — but they only survive because a browser Worker survives an
uncaught error. With `worker.onerror` treated as worker death, 0 of 4 runs bound versus 9 of 9
without it. No stack is obtainable: `Runtime.exceptionThrown` delivers these with an empty stack,
and booting the worker from a module blob that shims `JSON.parse` to trap the call site stops the
kernel booting, so that route is closed too.

**Ruled out, with measurements, so nobody re-derives them:**
- *Chrome Incognito / memory-backed OPFS.* A cold A/B of an incognito browser context against
  a fresh profile came out indistinguishable (53.7 s / 57.3 s vs 52.3 s / 66.2 s).
- *Registry-metadata volume.* Real (420 MB → 108 MB, see the `.npmrc` note) but it is the
  resolve/download phase, and it did not change what users hit.
- *A single worker being OOM-killed.* Memory does set a floor — a cold install peaks around
  **1.87 GB across the whole Chrome process tree**, and under a ~1.6 GB ceiling the kernel
  SIGKILLs the **renderer** (`errorCode 9`, cgroup `failcnt` climbing), not one worker. That
  is Chrome's crash page, not a frozen terminal, so it is a different failure from the report.

**No Node-based spike can gate the browser half of this.** `worker.onerror` semantics and the
timing that triggers the sharp deadlock only exist in a browser, so `spike-starlight` and
`spike-starlight-studio` passed throughout — including while real Chrome wedged. Both now pass
`--ignore-scripts` so they at least run the command the studio runs.
`scripts/repro-starlight-browser.mjs` is the only thing here that catches the browser-only
class; it is deliberately not in `run-spikes.mjs` because it needs a Chrome binary and a served
studio build.

Two process lessons worth keeping:
- **A template fix cannot reach an already-created project.** `vv-create-project` writes
  template files only at creation; reopening a project uses `vv-register-project`, which
  deliberately does not rewrite files. So a user who presses Run on a project created before
  a template change silently keeps the old files, with no indication that a fix exists.
- **A first-run install that prints nothing for minutes is indistinguishable from a hang.**
  npm's own spinner covers the fetch phase and then gets overwritten; reify is silent. The
  kernel already reports per-URL sizes to `onFetch`, so progress *can* be surfaced — worth
  doing on its own merit, in the runtime/studio layer rather than in a template.

Starlight rides the Astro path the shipped `astro` template already proves: Vite's dev server,
the Go/wasm `@astrojs/compiler`, and the `rollup → @rollup/wasm-node` registry alias. Nothing
new was needed for those. What Starlight adds — a content-collection pipeline (`docsLoader` +
MDX + expressive-code) and a themed **multi-page** site — surfaced four things:

- **Pin `astro ^5`, NOT the latest — Astro ≥6 is rolldown and does not load in-VM.** Astro 6/7
  move Vite 6 → Vite 7, whose bundler is rolldown. `astro dev` on Astro 7 logs
  `[rolldown] Downloading @rolldown/binding-wasm32-wasi@1.2.1 on WebContainer` — so rolldown
  *does* detect wasm and reach for a wasm binding — and then dies with
  `TypeError: Class extends value undefined is not a constructor or null` **before binding a
  port**. Same family as the `VITE_DEV = "npm run dev -- --configLoader native"` workaround in
  `templates.ts`, which exists because Vite's rolldown *config* bundler also fails here. So the
  template pins `astro ^5.18.0` plus the newest Starlight line that peers on astro ^5,
  `@astrojs/starlight ^0.37.7`. **Bump those two together, and only once rolldown works in-VM** —
  Starlight ≥0.38 peers on astro ^7 and will drag rolldown in.
- **THE GOTCHA: ship `ec.config.mjs` or the dev server never binds.** Starlight always loads
  `astro-expressive-code`, whose `loadEcConfigFile()` dynamic-imports `<root>/ec.config.mjs` and
  treats the file as merely *absent* only when the failure reports the **ESM** code
  `ERR_MODULE_NOT_FOUND` (or `ERR_LOAD_URL`). In-VM that import fails with the **CommonJS** code
  `MODULE_NOT_FOUND`, so expressive-code concludes the config exists but is *broken*, and
  hard-exits the `astro:config:setup` hook:
  `[astro-expressive-code] An unhandled error occurred … Your project includes an Expressive Code
  config file ("ec.config.mjs") that could not be loaded` → `Error: process.exit called`. The
  file is never reached, so no port is ever bound. Shipping the file sidesteps the misread, and
  it is a real Starlight file users want anyway. Keep it **import-free** (a plain default-export
  object): it is loaded by a bare dynamic import that Vite never processes, so avoid an ESM
  re-export chain at boot — `defineEcConfig` is only a typing helper. This is a *runtime* gap
  worth fixing generally: a failed dynamic ESM import should report `ERR_MODULE_NOT_FOUND`, and
  any library branching on that code hits the same trap.
- **`image: { service: passthroughImageService() }` — don't go near the sharp path.** Astro lists
  `sharp` as an `optionalDependency` and Starlight's `astro:assets` usage would otherwise build
  the sharp-backed image service. Worth correcting a natural assumption here: it is **not** true
  that sharp is simply unavailable in-VM. Measured on astro 5.18 (which pins `sharp ^0.34`), npm's
  platform auto-select skips every *native* `@img/sharp-<platform>` package **and installs
  `@img/sharp-wasm32` 0.34.5**, sharp's own WebAssembly build. So a sharp-backed service would
  probably work at *runtime*. **This paragraph used to claim 0.34's `install` script
  (`node install/check.js`) "is benign and exits clean, unlike sharp 0.32.6's, which is what
  killed the Gatsby investigation" — that was wrong, and it cost four rounds.** 0.34's script
  hangs exactly like 0.32.6's; it is the hang documented above, and the reason this template
  installs with `--ignore-scripts`. The lesson is narrower than "sharp is unavailable": sharp's
  *runtime* is fine in-VM, its *install script* is not, and those two facts were conflated.
  We still use passthrough: that path is unproven in-VM, wasm image transcoding is slow, and a
  docs site loses nothing by serving images untransformed. `scripts/spike-starlight.mjs` prints whether the wasm
  sharp landed but deliberately does **not** assert it — the gate that matters is that no *native*
  binary landed and that the dev log is free of image-service errors.
- **`pagefind: false` — search is the one feature traded away.** Starlight's built-in search
  shells out to Pagefind, whose binaries are optional platform packages (`@pagefind/linux-x64`
  and friends) that npm also skips on wasm32, so there is no runnable binary. Dev never invokes
  it; disabling it keeps `npm run build` honest too.
- **The template ships an `.npmrc` with `legacy-peer-deps=true`.** Worth keeping, but note what
  it does *not* fix: it shortens the resolve/download phase, while the unreproduced first-install
  stall above happens later, in reify. It was still by far the heaviest install of any template.
  **Optional peerDependencies are a first-class in-VM cost**, because npm's ideal-tree builder always
  requests **FULL** packuments (arborist's `#fetchManifest` hardcodes `fullMetadata: true`) and
  resolves a manifest for every optional peer even though it installs none. Astro's own
  `unstorage`/`db0` name ~19 of them, several among the largest packages on npm (`@prisma/client`
  65 MB, `drizzle-orm` 61 MB, `prisma` 42 MB, `react-native`, `@azure/cosmos`, `@xata.io/client`).
  Measured decoded volume through the fetcher + VFS on a cold cache: **421 MB without the
  `.npmrc`, 108 MB with it**; Rspress is 100 MB and the shipped Docusaurus 341 MB. Note the
  registry gzips packuments ~10x, so the *wire* cost is ~45 MB while the VFS/parse cost is the
  full 421 MB — always reason about the **decoded** figure in-VM. `legacy-peer-deps` is safe in
  this tree because its only peer edge (`@astrojs/starlight` → `astro`) is a direct dependency.
  `--omit=peer` does **not** help: it omits installing peers, not resolving them.

**`keepPreviewPrefix: true` is required here even though the `astro` template needs no base.**
This was settled empirically, not assumed. Starlight renders its sidebar, prev/next pager and
site-title link as **root-absolute** hrefs that follow Astro's `base`. Clicking one is a
top-level navigation, and `packages/studio/public/sw.js` deliberately refuses to proxy a
navigation carrying no `/preview/<port>/` marker (`if (event.request.mode === "navigate")
return;` — it assumes such a document is the studio's own). With the default base those links
render as `/guides/…`, so the site would load and then break on the first sidebar click. Hence
`base: "/preview/4321/"` + `keepPreviewPrefix: true`. The single-page `astro` template escapes
this only because it has no internal links at all. Note the *asset* side differs: Vite's dev URLs
(`/@id/…`, `/@vite/client`, `/@fs/…`) are **not** base-prefixed and that is correct — they are
subresources, so `routeByClient` infers the port from the issuing iframe's own prefixed URL. Do
not "fix" that by asserting every asset sits under the base.

- Gated by `scripts/spike-starlight.mjs` (net tier, 900s). It defaults to the base the template
  actually ships, so the CI run exercises the real config; `VV_BASE=/` reproduces the no-base
  control (its link check is vacuous there, since every root-absolute href trivially starts with
  `/`). Gate 1 asserts no *native* `@img/sharp-*` landed and gate 4 asserts the dev log is free of
  sharp/image-service errors, so a regression cannot hide behind a page that still renders.

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
  streams the tarball out of `response.body` through `Readable.fromWeb` — one of
  the six converters in `node/internal/webstreams/adapters.js` (see the adapters
  gotcha below; they are all real now, and that file is a hand-written adaptation,
  not a verbatim vendor). The reader's and writer's host promises settle off our
  loop, so they're wrapped to ref the event loop in `runtime/index.js` (next to
  the `fetch`/`Response` wraps); without that the process exits mid-download.
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
  password `hash`/`verify`, `CryptoHasher`, `Transpiler`, `$`, `build`, `plugin`)
  plus **`Bun.serve`**
  `randomUUIDv7`, `gzip`/`gunzip`,
  `Transpiler`, `$`) plus **`Bun.serve`**
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
  `ReadableStream` from bounded fd reads — for the laziness (no fd until the consumer
  pulls) and the one-chunk-≤64-KiB-per-pull bound, not because `Readable.toWeb` is
  broken; it works now. See the `typeof`-guard gotcha above for that history.
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
- **`packages/runtime/builtins/bun-ipc.js`** — the channel behind
  `Bun.spawn({ ipc })`. It adds **no kernel opcode**: the transport is the pipe the
  kernel already relays for UNIX sockets (`OP_PIPE_LISTEN`/`OP_PIPE_CONNECT` +
  `pipe-data`), so the parent listens on a generated path before it spawns and the
  child dials it while it boots. Four facts came off the binary and none of them
  are in the docs. The child gets **Node's** fork surface (`process.send`,
  `process.on("message")`, `process.connected`, `process.channel`,
  `process.disconnect()`) and nothing on the `Bun` global. The carrier —
  `NODE_CHANNEL_FD` there, a socket path here — is **deleted from the child's env
  before its first line**, and that is load-bearing rather than tidy: `env` is what
  a process passes on when it spawns, so an inherited address would put a
  GRANDCHILD on its grandparent's channel, accepted as the child and interleaving
  frames into someone else's stream. The default mode is `"advanced"` = a
  structured clone, so this reuses `bun-serialize.js` (including its
  `DataCloneError`, which is already Bun's exact sentence); `"json"` is JSON and
  loses Map/Date/BigInt/cycles. And a **node** child needs `serialization: "json"`
  under real bun — node's advanced mode is `v8.serialize`, Bun's is a JSC
  structured clone, so the child's messages silently never arrive. Here both ends
  are our runtime, so `"advanced"` works with a node child too: the sandbox is
  LOOSER than production, which is why `bun.js` warns once rather than pretending.
  Two behaviours to preserve if you touch it: the child's socket is `unref`'d until
  a `message` listener exists (see the listener gotcha), and `send()` refuses with
  Bun's two DIFFERENT sentences in Bun's order — an exited child is reported as
  exited, not as a closed channel.
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
- **`packages/runtime/builtins/bun-crypto.js`** — `Bun.CryptoHasher` and
  `Bun.password`, over `packages/crypto` (RustCrypto) through the same
  `internalBinding('crypto')` seam `node:crypto` uses. This is the file where being
  *approximately* right is a security bug, so two rules apply that do not elsewhere.
  (1) **Bun.password emits and accepts the STANDARD encodings** — PHC for argon2id
  (`$argon2id$v=19$m=65536,t=2,p=1$…`, Bun's defaults) and modular crypt for bcrypt
  (`$2b$10$…`) — so a hash written in the sandbox verifies in production and vice
  versa. It used to emit a bespoke `$vv-<algo>$…` string built from node scrypt while
  reporting "argon2id" to the caller; those legacy strings are still **accepted** by
  `verify` (nothing else on earth can read them, and real Bun can never hold one) but
  are never produced again. Passwords over **72 bytes are SHA-512 pre-hashed** before
  bcrypt, raw bytes, strictly `> 72` — Bun's construction exactly, or long passwords
  silently stop verifying off-sandbox. (2) **There is no fallback**: without the wasm
  codec both throw, naming the API. `Bun.CryptoHasher` covers Bun's 19 documented
  algorithms and reproduces the rule that a **digested HMAC is consumed, not reset**.
  It is a buffering hasher, so `.copy()` clones buffered input rather than a
  mid-state context — observationally identical, different only in memory.
- **`packages/runtime/builtins/bun-serve.js`** — `Bun.serve`'s option policy and its
  RFC 6455 rules, kept pure so the offline tier can drive them. The rule for adding
  an option here: **implement** it if the sandbox genuinely can (`idleTimeout` works
  because `node/lib/net.js` is Node's real one and `socket.setTimeout()` fires;
  `unix` works because the net layer has a `Pipe` binding), **degrade loudly** —
  accept it, run without it, warn ONCE per process — if production is a superset we
  cannot reach but serving without it is still faithful (`tls` is the archetype:
  throwing would refuse to boot every app that merely *has* a certificate
  configured), or **throw** if running without it means serving something that is
  not the protocol the caller asked for (`http3`). Never silently ignore one: that
  is code passing in the sandbox and breaking in production, which is the failure
  mode this project cares most about. Two things worth knowing before changing it:
  frame validation is a separate function from the frame *reader* on purpose,
  because the reader is shared with the client-role codec in `runtime/websocket.js`
  and only a **server** may reject an unmasked frame (§5.1); and `drain` /
  `getBufferedAmount()` are correct but inert here, because the in-VM loopback
  completes every write synchronously and so never builds backpressure (see the
  kernel spike, which pins that).
- **`packages/runtime/builtins/bun-build.js`** — `Bun.build` and `Bun.plugin`.
  **It is not esbuild, and that was the decision, not an accident.** `esbuild-wasm`
  bundles better than this file ever will, but `Bun.build` is part of the Bun binary:
  it works in a project with an empty `node_modules`, and a `Bun.build` that first
  demands `bun add esbuild` is a different API wearing the same name. Aliasing
  `esbuild` → `esbuild-wasm` (the toolchain-shims gotcha below) only helps a project
  that already depends on esbuild. So the graph walk is written against the runtime's
  OWN resolver (`resolveFilename`, injected from `index.js`) and its own transforms
  (`typescript-transform.js` for TS/JSX, `esm.js` for ESM→CJS) — the same code that
  resolves a `require()` at runtime, which is the only way `Bun.build` and `bun run`
  can agree about what a specifier means. A project that wants a production bundler
  should still run esbuild/rollup/Vite; those work in-VM and are the recommendation
  in the docs page.
  Consequences worth internalizing before you touch it:
  - **Output is NOT byte-identical to real Bun's, and never will be.** It is a
    registry of CJS-shaped module factories behind a tiny prelude, with **no tree
    shaking and no minifier**. Bundles are bigger and differently ordered. This is
    stated in the file header, in `sites/docs/docs/bun.md`, and in the `bun build`
    help text, so nobody opens a diff-noise bug. Assert on *behaviour* (the bundle
    runs and produces the right value) — never on bytes or on a hash.
  - **The option policy is `bun-serve.js`'s, applied harder.** `minify`, `splitting`,
    `sourcemap`, `bytecode` and `--compile` **throw**, naming the option and the
    reason, because a bundler that reports `success: true` having ignored `minify`
    ships an unminified bundle to production and says nothing. Degrading loudly is
    for options where running without them is still faithful; a build artifact is not
    that. Prefer throwing over dropping when you add one.
  - **The CLI and the programmatic API are ONE engine.** `bun build` (in
    `kernel-host/programs/bun.js`) parses flags onto `Bun.build` options and calls it,
    so a flag cannot be honoured in one door and dropped in the other. `--compile`'s
    existing refusal is now that same throw.
  - **`Bun.plugin` is module-level registry state that `module.js` reads on EVERY
    resolve and load** (`bunPluginsActive()` guards the fast path). Runtime plugins
    must therefore be **synchronous** — `module.js`'s `resolveFilename`/`compile` are
    sync all the way down to `require()`, so an async `onLoad` cannot be awaited and
    throws instead of resolving to a promise nobody unwraps. Build-time plugins
    (`Bun.build({plugins})`) are async, since that path already is.
- **`packages/runtime/builtins/bun-unsupported.js`** — the ~20 APIs a browser tab
  cannot provide, and the only file in the Bun shim with no implementation to read:
  it is the catalogue. `Bun.listen`/`connect` (raw TCP), `Bun.udpSocket`,
  `Bun.RedisClient`/`Bun.redis`, `Bun.SQL`'s Postgres/MySQL adapters, `Bun.WebView`,
  `Bun.mmap`, `Bun.peek`, `Bun.secrets`, `Bun.dlopen` and the whole of `bun:ffi`
  were all simply `undefined` before, so a dependency produced
  `TypeError: Bun.udpSocket is not a function` from six frames down and explained
  nothing. **The pattern is `bun:ffi`'s: the symbol EXISTS so importing or reading
  it cannot crash a project over an unused import, and the CALL throws** — naming
  the API, the specific missing capability (no raw socket, no `dlopen(3)`, no OS
  keychain — never a generic "unavailable"), and the alternative. **Two message
  shapes, and the difference is the point**: "is not supported in Vivari (browser
  sandbox)" means *cannot ever work here*, "is not implemented in the Vivari shim"
  means *possible, unwritten* (`terminal: true` on `Bun.spawn`, `Bun.SQL`'s SQLite
  adapter). Conflating them sends someone to redesign what a patch would fix, or
  to write a patch for what no patch can fix. The file also owns the `.node`
  native-addon message and `NATIVE_ADDON_SUBSTITUTES` (see the node-gyp gotcha
  above) — `module.js` and `process.js` import it, since `require('bcrypt')` from
  plain Node code hits the identical wall.
- **`packages/runtime/builtins/bun-test.js`** — all of `bun:test`. It is the one
  file in the shim where **an approximately-right answer is worse than a missing
  one**: everything else fails visibly, a wrong matcher makes a whole suite report
  success. So the rule here is stricter than elsewhere — every behaviour was
  checked against a real `bun test` (1.3.6) and the surprising ones are reproduced
  with the observation written at the call site. Five worth knowing before you
  touch it:
  - **`.only` THROWS when `$CI` is truthy** ("disabled in CI environments to
    prevent accidentally skipping tests"; `CI=false`/`0`/empty are not CI), and
    **snapshot CREATION is refused under CI** unless `--update-snapshots`. Both
    exist so a committed `.only` or a first green build cannot prove nothing.
    Reproduce them, do not "improve" them away.
  - **`expect(settledPromise).rejects.toThrow()` returns `undefined` in real Bun**
    — it peeks the settled promise synchronously and throws. We cannot peek (see
    `Bun.peek` in `bun-unsupported.js`), so ours always returns a real Promise
    **and** the runner drains outstanding async assertions after each test body, so
    a forgotten `await` still fails the test instead of silently passing. That is
    the one place the shim is deliberately stricter than Bun.
  - **The `.each` title formatter has two upstream bugs and both are reproduced**,
    because the title is what `-t` filters and what keys a snapshot: `%s`
    substitutes only STRINGS and `%d`/`%i`/`%f` only NUMBERS (a `%s` handed a
    number leaves the literal `%s` in the title *and* still consumes the argument),
    and the `$property` pass swallows one extra character whenever the lookup
    misses (`"$ end"` → `"$end"`, `"$a-b"` → `"$ab"`).
  - **The snapshot format is Bun's, byte-for-byte**, header included — object keys
    SORTED, getters printed as `[native code]` rather than invoked, a snapshot key
    joining describe blocks with a SPACE while the reporter joins them with `" > "`.
    A `.snap` file written here was handed to a real `bun test`, which read it and
    passed; that round-trip is what the format claim rests on. Two shapes **throw**
    instead: a Map or a Set NESTED in a container, where Bun's own bytes are
    malformed and not even self-consistent between the two (a nested Set gains
    indent-width padding, a nested Map at the same depth gains none), so there is
    no rule to encode and tidier bytes would fail under real Bun.
  - **`bun test`'s flags are parsed, and an unknown one is refused by name.** They
    used to be dropped by `rest.filter(a => a[0] !== '-')`, so `bun test -t auth`
    ran the whole suite and exited 0. A positional is a **filename filter**, not a
    path (Bun's documented semantics).
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
  `bun build` is a thin front door onto `builtins/bun-build.js`: it maps flags to
  `Bun.build` options and lets that engine own every refusal, including `--compile`.
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
  `builtins/bun-unsupported.js` (import-safe, call-loud). `bun build --compile` was
  the same bug in the CLI: it fell through to the transpile path and wrote
  JAVASCRIPT under the name the user expected a native executable at, then reported
  success. An unknown `bun` verb likewise says
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

**`bun:sqlite` is REAL SQLite, and the wasm is COMMITTED.** `bun-sqlite.js` runs the
official `@sqlite.org/sqlite-wasm` binary — the same C source SQLite tests — from
`packages/runtime/vendor/sqlite/sqlite3.wasm` (844 KiB, in git, with a
`manifest.json` recording the upstream version + SHA-256). It is committed rather
than placed under the gitignored `packages/studio/public/vendor/` because BOTH spike
tiers need it on a bare checkout, and the trap below (a spike that skips when its
artifact is missing looks green) is exactly what a build-time-only artifact would
walk into. `npm run vendor:sqlite` copies it into the studio's public tree for the
browser (that copy IS gitignored); `npm run vendor:sqlite -- --refresh` re-pulls from
npm, validates exports/imports/memory against what the loader supplies, and rewrites
the committed binary. Four things to internalize before touching it:
- **Emscripten's JS glue is not used, and must not be.** It is async-init and it
  routes I/O through MEMFS/NODEFS. `bun:sqlite` is a synchronous API — `db.query(sql)
  .all()` returns rows — so there is nowhere to await a boot. The loader supplies the
  ~40 imports itself and uses bare `new WebAssembly.Module()` + `new
  WebAssembly.Instance()`, which are synchronous and legal in a Worker (the
  `llhttp-wasm.js` precedent). It creates `env.memory` too: this build **imports**
  memory rather than exporting it.
- **Re-derive typed-array views after anything that can allocate.** Growth through
  `emscripten_resize_heap` detaches the old `ArrayBuffer`, so a cached `HEAPU8` from
  before a `malloc` reads a corpse. The loader compares `memory.buffer` identity on
  every access; keep that if you add a fast path.
- **No durability and no locking, on purpose, and it is documented that way.** `xSync`
  is a no-op because our `fsync`/`fdatasync` are — a crash mid-transaction still
  recovers from the rollback journal, but power loss is not survivable. There is no
  file locking anywhere in the fs stack, so two processes writing the same database
  can corrupt it; this is what UPSTREAM ships too (the official build's default VFS is
  literally `unix-none`), not a Vivari-specific compromise. `journal_mode = WAL` needs
  cross-process shared memory, so it warns once and stays in `delete` mode. Do not
  "fix" any of these by making them look like they work.
- **Keep the host injected.** `createBunSqlite(host)` takes `{fs, path, cwd,
  randomBytes, resolveEngineBytes}`, which is the only reason `spike-bun-offline.mjs` can drive the
  SHIPPED code over `node:fs` with no kernel. `spike-bun.mjs` then proves the same code
  against the real Wasm VFS across two processes.

**Gotcha — the Bun shim gets TWO `require`s, and reaching for the wrong one is silent.**
`createBunRuntime({require, makeCwdRequire})`: `require` is rooted at `/` and is right
for builtins, which are base-agnostic. It cannot see a PROJECT dependency, because
`nodeModulesPaths` walks *parent* directories, so from `/` the only candidate it ever
produces is `/node_modules` — a package in `<project>/node_modules` is unreachable no
matter what the user installs. This is not hypothetical: `bun:sqlite`'s old backend probe
used the root require and told users to `bun add @sqlite.org/sqlite-wasm`, i.e. to install
it somewhere the probe was structurally unable to look. Anything resolving a user package
must use `makeCwdRequire()` (a factory, so a `process.chdir()` is honoured), which is the
same thing `__ocImport` in `index.js` already does for bare specifiers.

### Python is Pyodide (CPython→WASM), lazily booted — with a Flask/FastAPI HTTP bridge
Unlike the Node-backed Bun shim, `python`/`python3` boots **real CPython compiled to
WASM (Pyodide)** the first time a python process runs (nothing at studio boot). Pieces:
`packages/runtime/builtins/python.js` (boot + FS mirror + exec + `serve`),
`packages/kernel-host/programs/python.js` (CLI + `-m` dispatch), the
`pip`/`uvicorn`/`flask`/`gunicorn`/`pytest` PATH shims in `coreutils.js`, and
`scripts/vendor-pyodide.mjs`. Gated by **two** spikes — see the CI gate gotcha below.
Gotchas:
- **`-m` is a passthrough with seven exceptions, not an allowlist.** It was an
  allowlist of six, which made a dispatch gap read as a capability gap: `python -m
  unittest` answered "arbitrary modules are not supported" for a runner sitting in
  the stdlib the interpreter had already loaded. Now `runModule()` hands the name to
  CPython's `runpy._run_module_as_main`, so the module resolution, the argv contract
  and the errors are CPython's rather than ours. Only intercept a module when runpy
  genuinely cannot reach what it needs: the package store (`pip`, `venv`), the
  WSGI/ASGI bridge (`uvicorn`, `flask`, `gunicorn`), the exit-code seam (`pytest`),
  or a socket (`http.server`). Adding a seam for anything else re-creates the bug.
- **`sys.executable` is set to `"python"` at boot, and it is not cosmetic.** runpy
  formats its own failures as `"%s: %s" % (sys.executable, exc)`. Left alone in
  Pyodide it is the host path of whatever `.mjs` booted the interpreter, so a missing
  module reports `/app/node_modules/.../kernel.mjs: No module named foo`. Both spikes
  hold the message against real CPython, which is why the prefix has to be a name.
- **Refuse a socket-bound module rather than letting it run.** Pyodide *has* a
  `socket`, and that is worse than not having one: `connect()`, `bind()` and
  `listen()` all succeed and then no bytes move (proven in the bridge spike, which
  times out on the `recv`). So `smtplib` and friends would print a banner, look
  started, and hang. `SOCKET_MODULES` in `programs/python.js` names each one and its
  reason; the offline spike scrapes that table rather than keeping a copy.
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
  `--workers`/`--threads`/`-D` **warn** and carry on (the server
  still serves, just not the way the flag asked). Silently swallowing them is the argv
  spelling of a placeholder return value. There is now a **third tier, `warnPartial`**,
  for a flag that names two things and gets one: `flask --debug` means reloader *and*
  interactive debugger, and this runtime does the first and not the second, so "ignored"
  understates it and silence overstates it. Reach for it only when the flag really is
  two features — a flag that is merely approximated belongs in `warn`. Flags that take a value must consume it even
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
- **…and a third mask, which is not a `process` field at all: the realm has to be able
  to say WHICH browser it is.** Masking IN_NODE only moves Pyodide into `IN_BROWSER`; it
  then picks a branch, and it identifies a Web Worker by **constructor identity** —
  `typeof globalThis.WorkerGlobalScope !== "undefined" && globalThis.self instanceof
  globalThis.WorkerGlobalScope` (314.0.3 `src/js/environments.ts`). The realm sweep
  (`realm.js`) hides `WorkerGlobalScope` because a real Node 22 has no such global, while
  `self` is on KEEP — so the worker branch was false, `window` made the main-thread
  branch false, the mask made IN_NODE false, and **every** `python` command died on its
  first line with `Cannot determine runtime environment: {…,"IN_BROWSER":true,
  "IN_BROWSER_WEB_WORKER":false,…}`. Emscripten asks the same question again inside
  `loadPyodide()` (`ENVIRONMENT_IS_WORKER = !!globalThis.WorkerGlobalScope`) and with
  WEB/WORKER/NODE all false settles on `ENVIRONMENT_IS_SHELL`, reaching for a d8 `read()`
  — so fixing only the first would have hit a second wall two lines later. `maskBootEnv()`
  in `builtins/python.js` owns all three masks now; the constructor comes off realm.js's
  `HOLD` list through `__ocInstallPython`, i.e. a python guest only, for the length of one
  boot. **This is a NAME, not a capability**: the sweep shadows globals and leaves the
  prototype chain alone, so `WorkerGlobalScope.prototype` (and the `importScripts` on it)
  has always been two `getPrototypeOf` hops from `self` — which is the argument for not
  putting it on KEEP and widening the realm for every guest instead.
  Two more things on that path that the sweep also touches and that must stay as they
  are: `importScripts` stays hidden, because the worker branch runs
  `isClassicWorker()` — `globalThis.importScripts("data:text/javascript,")`, a throw
  meaning "not classic" — and a shadowed `undefined` throws, which is the right answer;
  and `location` stays hidden, which Pyodide's browser paths survive **only** because
  every URL they resolve is already absolute (`new URL("/vendor/pyodide/", undefined)` is
  `Invalid URL`). The kernel builds `VV_PYODIDE_INDEX_URL` off the worker's own origin, and
  `spike-python-offline.mjs` holds it to that.
- **Why this shipped broken, and what closed it.** Every Python spike drove
  `scripts/lib/fake-pyodide.mjs`, which is handed to code that has already booted and so
  performs no environment detection at all, and the one tier that runs the real
  `pyodide.mjs` runs it in Node, where the answer is a different one. Nothing had a
  browser realm to be wrong in. `spike-python-offline.mjs` now sweeps a rebuilt Chrome
  worker global (`scripts/lib/browser-realm.mjs`, shared with `spike-realm.mjs`), applies
  the shipped `maskBootEnv()`, and runs Pyodide's own detection over the result — with
  `scripts/lib/pyodide-runtime-env.mjs` as the model and `spike-python-bridge.mjs`
  checking that model against the real `pyodide.mjs.map` / `pyodide.asm.mjs`, the same
  two-ended arrangement as `urllib3-emscripten.mjs`.
- **A THIRD Node probe, and it belongs to urllib3 — `process.release.name` is load-
  bearing for Python's HTTP.** `requests` in Pyodide does not use sockets; urllib3's
  Emscripten transport picks a door at request time — `has_jspi()`, else
  **`is_in_node()` → raise**, else a *synchronous* `XMLHttpRequest`, which is precisely
  what a Web Worker has. And it answers `is_in_node()` by reading
  `js.process.release.name`, which `builtins/process.js` deliberately sets to `"node"`
  because real tools branch on it — and `globalThis.process` is what Pyodide hands
  Python as `js.process`. So urllib3 concluded a browser Worker was Node, skipped the
  XHR, and told users to pass `--experimental-wasm-stack-switching` to a Node that is
  not there; the same expression also decided `_fetcher` at import time, so streaming
  was off too. **If you touch the masquerade, this breaks silently and only in a
  browser.** `URLLIB3_REALM_PATCH` (`builtins/python.js`) fixes it by asking the
  *realm* — `hasattr(js, "XMLHttpRequest")` — not by returning `False`: the headless
  spike tiers really are Node, and there urllib3's answer is correct and must survive,
  or the tier goes green for a reason that does not hold where the code ships. It runs
  as a `sys.meta_path` post-import hook because urllib3 is not installed at boot and
  importing it eagerly would pull a wheel into every python process, and through
  `installUrllib3RealmPatch()` into a **namespace of its own** — the same interpreter is
  the REPL, so `runPython`-ing it into `__main__` would put our plumbing in the user's
  `dir()`. Two consequences
  worth knowing: re-enabling `_fetcher` means urllib3 may print its own "streaming
  fetch worker isn't ready" notice until the nested worker reports in (its
  `wait_for_streaming_ready()` is the cure, and the buffered path is unaffected), and
  a `_StreamingFetcher()` that throws must leave `_fetcher = None` rather than break
  the import. **Unverified in a real browser**: that a Worker's synchronous XHR
  behaves as the spec says. If it does not, the patch is inert, not harmful.
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
- **One Pyodide per process, and the `.venv` store is what carries state across them.**
  Each `python` command is a fresh boot (`:66–68`), so nothing an interpreter installs
  outlives it by itself. What makes `pip install` real is `builtins/python-store.js`:
  `pip` walks site-packages before and after the install, and the **delta** is written to
  `<project>/.venv/lib/python3.14/site-packages`, which `restoreStore()` copies back into
  every later interpreter (measured: 4 ms out, 37 ms in for 357 KB, against a ~1400 ms
  boot). Four things about it are load-bearing and none are obvious:
  - **`.venv` is in `SKIP_DIRS` on purpose.** The store must land at the interpreter's
    *own* site-packages path, not at `<cwd>/.venv` where no import would look. Mirroring
    it generally would copy every byte twice, to a place nothing reads. It looks like the
    bug; it is the fix.
  - **A stamp mismatch discards the whole store, and must keep doing so.** `pyvenv.cfg`
    sits beside a `vivari-store.json` recording the Python version, the Pyodide version
    and a `STORE_FORMAT`. A half-restored site-packages imports half a package and fails
    somewhere unrelated, so `restoreStore()` copies **nothing** rather than what it can.
  - **The cap check lives inside `persistDelta()`, not beside it.** Over the cap it
    returns `{ok:false}` having written nothing, so "too big changes nothing" is a
    property of one function instead of the order two callers happen to do things in.
    `pipInstall` then exits **non-zero**: the packages are in an interpreter that is about
    to exit, so from the user's side the install did not happen, and exiting 0 would let
    `pip install X && python main.py` walk into an ImportError with a success message
    above it.
  - **Do not rebuild a dist-info directory name from `name` + `version`.** An install
    escapes the project name per PEP 427, so `charset-normalizer` lands in
    `charset_normalizer-3.4.7.dist-info`; matching on the reconstruction silently drops
    every dashed package from `pip list`/`freeze`. `DIST_QUERY` reports the directory it
    actually found. Real pip caught this; reading the code did not.

  Scripts still get their packages from `loadPackagesFromImports(source)` on the entry
  file, and `serve()` still reads `requirements.txt` — the store is additive to both.
  When testing several templates in one interpreter, `sys.modules` will serve an earlier
  template's `main` to a later one — boot per case instead.
- **A served app's writes persist at the end of each request, not on shutdown.**
  `serve()` mirrored the project IN and never back, so a Flask app's uploads and its
  SQLite database died with the process. Shutdown-only would not have fixed it —
  people close tabs, and a preview that is killed is the normal way one ends. The end
  of a request is the one boundary where "what the app has written" is a complete
  answer: the handler has returned, and Pyodide has no threads, so nothing is
  mid-write. `mirrorBack()` still runs on close as a reconciling pass, which makes a
  tracking miss cost a delay rather than the data.
- **Mirroring is driven by `FS.trackingDelegate`, because a size diff is not enough.**
  The original walk skipped a file whose size matched the snapshot, which silently
  drops every same-size rewrite — a fixed-width record, a counter that did not change
  digits. Deletes matter as much: sqlite3 removes its journal on commit, and copying
  the journal out without ever removing it leaves a hot journal beside a committed
  database, which the next process rolls back. `.venv` is excluded from mirroring in
  both directions (`mirrorable()` re-checks `SKIP_DIRS`, since the tracker reports
  paths the inbound walk never descended into) — the store owns it, and a second
  writer would copy every wheel out again and could leave a half-written store
  looking valid.
- **`--reload` re-imports, and the three things that makes load-bearing.** A Python
  server's app is imported into `serve()`'s own process, so restart-on-save is a
  re-import rather than a respawn — which is why it needs neither the thread nor the
  subprocess the docs used to say it did. Three consequences, each of which fails
  quietly rather than loudly:
  (1) **Drop the module's bytecode before re-importing it.** A `.pyc` is revalidated on
  the source's size and its mtime truncated to whole *seconds*, and save-then-reload is
  inside one second by construction — so a same-length edit is indistinguishable from no
  edit and the stale `.pyc` wins. This runtime makes it worse than upstream: Pyodide
  ships `sys.dont_write_bytecode` set and the bytecode cache above deliberately unsets
  it, so user modules get `.pyc` files here that they would not otherwise get. Use
  `importlib.util.cache_from_source`, which honours `sys.pycache_prefix`.
  (2) **A failed re-import must be a no-op, not a partial one.** The modules are popped
  into a snapshot and put back if anything raises, including a sibling the failed attempt
  had already re-imported — otherwise a syntax error leaves the server answering out of a
  module set matching neither version of the code. Catch `BaseException` (a module calling
  `sys.exit()` at import must not take the port down) but re-raise `KeyboardInterrupt`.
  (3) **The watch scope is `SKIP_DIRS`, and the trigger is `.py` only.** One
  non-recursive `fs.watch` per directory from an explicit walk — *not*
  `{ recursive: true }`, which on this platform routes to Node's vendored JS fallback
  and registers a watch per file with no way to exclude `.venv`. The `.py` filter is not
  cosmetic: a served app's writes are mirrored back to the VFS at the end of every
  request and fire this same watch, so a filter that let a SQLite commit through would
  restart the app on every request, forever.
- **`subprocess` works, and "no threads" is not why it did not.** The
  `OSError: [Errno 138] emscripten does not support processes.` a reader will find is
  CPython's, and it is about **fork** — Pyodide has no `_posixsubprocess`. It is not a
  statement that this VM has no processes: every command is a real process with its own
  worker, and guest Node has spawned them over `OP_SPAWN` since brick 4. `OP_SPAWN` is
  blocking (the caller parks on `Atomics.wait` until the child exits), which is exactly
  `subprocess.run()`'s shape and exactly *not* `Popen`'s. Four rules follow:
  (1) **Refuse `Popen`, do not approximate it.** The cheat is to run the child to
  completion in `__init__` and serve the buffered output from the pipes; then
  `communicate()` passes and `Popen(["uvicorn", …])` blocks until the heat death of the
  tab. Same for `timeout=`: with the caller parked and nothing able to interrupt it, a
  timeout can be *accepted* but never *enforced*, so accepting it silently converts the
  one argument written to bound a wait into an unbounded one. Both raise and name what
  does work.
  (2) **"Not found" must blame the missing binary, not the platform.** `git` and
  `ffmpeg` are absent because they are not in the VM — a softer and completely different
  fact from "the browser forbids processes", and the message a user sees decides which
  lesson they take away. The list of what *does* exist is read from `/bin` at error
  time; a list written into a source file starts lying the day a program is added.
  (3) **No capture means `stdio: 'inherit'`, which the Node shim had to learn.**
  Captured output cannot arrive before the exit that delivers it, so a captured
  `pytest` prints nothing for a minute and then everything. `spawnSync` hardcoded
  `capture: true`; it now honours `stdio:'inherit'` and reports `stdout`/`stderr` as
  `null`, which is both real Node behaviour and what `subprocess.run` without
  `capture_output` needs.
  (4) **Bound the nesting, in the environment.** Every level is another worker with
  another Pyodide boot, and every parent is parked — so a script that spawns itself
  cannot be Ctrl-C'd out of. `VV_SPAWN_DEPTH` rides in the child's env so it keeps
  counting through a Python → Node → Python chain, and `MAX_SPAWN_DEPTH` refuses the
  fourth level. On security: this is **parity**, not expansion. It goes through the same
  `child_process.spawnSync` a Node guest calls rather than a private path to the
  syscall, so nothing is reachable from Python that a one-line Node script could not
  already reach.
  (5) **A `stdout=`/`stderr=` you do not recognise is not a no-op.** The first version
  of this handled `PIPE`/`DEVNULL`/`STDOUT` and quietly let everything else fall
  through to the inherit branch, so `run(cmd, stdout=open(p, "w"))` put the child's
  output on the terminal and left the file empty. That is a worse failure than the
  `OSError` this feature replaced, because it looks like it worked, and it is the
  general trap in patching a stdlib module: the *unhandled* case has to be as
  deliberate as the handled ones. A file object is now captured and written (at the
  end, since the child is already gone), a descriptor is refused because nothing is
  inherited across this spawn, and anything else is a `TypeError`.
- **A notebook cell is not a script, and the channel that runs it must be able to
  signal.** Two things about `packages/studio/src/vv/notebook/` that look like free
  choices and are not. **The kernel runs in a SHELL terminal, not on `proc-spawn`, and
  the reason is `SIGINT`.** `proc-spawn`/`proc-input`/`proc-out` is the better-shaped
  channel and it is the wrong one, because `kernel-worker.ts` routes `proc-kill` to
  `kernel.stop(pid)` and there is no `proc-signal` message at all — a notebook that
  interrupts by ending the process has not interrupted anything, it has discarded every
  name the user defined and called it a stop. The shell is the only host-side route to a
  signal: it writes a foreground child's stdin through untouched and converts `\x03` to
  `SIGINT`, which reaches `Py_EmscriptenSignalBuffer` through the `setInterruptBuffer`
  wiring in `builtins/python.js`. **If you move this to `proc-spawn`, add `proc-signal`
  first** and check it reaches `kernel.signal(pid, "SIGINT")` rather than `kernel.stop`.
  The consequence is that the kernel's stdout carries shell echo and Pyodide loader
  chatter as well as protocol frames, which is what the `\x1e` prefix on every frame is
  for. And **`term-open` for the kernel must NOT pass `run`**: the `run` field is the Run
  button's path, and `openTerminal` prepends `npm install` to it when the directory has
  no `node_modules`, which every Python project is. Three smaller rules that are all the
  same rule — fail where it can be seen. A cell may not read stdin, because the protocol
  owns it and a cell calling `input()` would eat the next cell's request; `builtins.input`
  is replaced for the duration of a cell with one that raises and points at the terminal,
  where `input()` really does block on the real syscall, rather than returning `""`.
  Interrupt is refused at an *idle* kernel, because Ctrl-C at an idle prompt still ends
  the process rather than raising `KeyboardInterrupt`, so an idle interrupt would throw
  the session away to stop nothing; the button is disabled rather than hidden, since "why
  is that greyed out" is the better question. And the notebook's matplotlib backend is the
  **same extension point as the script one, aimed somewhere else** — `MPL_BACKEND` writes
  a figure into the project and prints where it went, which is right for a script and
  wrong for a cell, so the kernel registers `vv_nb_mpl` in `sys.modules` and sets
  `MPLBACKEND` before any cell runs. Do not add a second mechanism; matplotlib already
  has one. Finally, **a field you do not understand in an `.ipynb` belongs to somebody who
  does**: `ipynb.js` re-emits the parsed object with only managed fields written over it,
  writes an unedited cell back byte for byte in the shape it arrived in, never silently
  upgrades `nbformat_minor`, and writes a cell `id` only at 4.5+ (an `id` in a 4.4
  notebook fails that notebook's own schema).
- **`python --version` carries a literal, and it is pinned twice.** Same
  constraint as `BUN_PROGRAM`/`BUN_VERSION` above: `PYTHON_PROGRAM` is a
  no-interpolation template literal, so `/bin/python.js` cannot import the
  version — and `--version` answering without booting Pyodide is worth keeping,
  so the literal stays. `spike-python-offline.mjs` holds it against
  `PYODIDE_PYTHON_VERSION` in `builtins/python.js`, and the bridge spike holds
  that constant against `sys.version` in a real interpreter. Bump the vendored
  Pyodide and one of the two fails. Print the **full patch version** — it read
  `Python 3.14` while a script in the same terminal reported `3.14.2`. Note that
  `pyodide-lock.json`'s `info.python` is the ABI target (`3.14.0`) and not the
  build, so it is the wrong authority; `sys.version` is the right one.
- **`loadPackage()` writes to the interpreter's STDOUT unless you hand it a
  callback**, and that put `Loading packaging` / `Loaded packaging` in front of
  `pip freeze`'s output — so `pip freeze > requirements.txt` wrote a file whose
  first two lines pip never printed. Pyodide's package manager keeps its own
  `stdout`, defaulting to the stream `setStdout` sets, which `bootPyodide` points
  at `process.stdout`. It is **not** `console.log`: replacing `globalThis.console`
  before importing `pyodide.mjs` does not intercept it, so do not go looking in
  `node/lib/console.js`. `{messageCallback}` overrides it for one call only.
  Every call site in `builtins/python.js` therefore passes `loaderToStderr` or
  `loaderToStdout` explicitly, and the offline spike fails on any that does not —
  progress is diagnostics, and the one exception (`pip install`'s requested
  packages) is stdout because real pip prints `Collecting …` there. The general
  rule: **a command whose stdout is meant to be piped emits nothing but its
  payload**, and an assertion that compares a formatter's return value cannot
  see a second writer on the stream. Gate stdout as a subprocess — see
  `scripts/lib/pip-stdout-child.mjs`, which runs the real runtime against the
  stand-in interpreter in `scripts/lib/fake-pyodide.mjs`.
- **An entrypoint is not shipped until it is on PATH under the name people type.**
  `python -m pip list` worked for an entire MR while `pip list` said `sh: pip: not
  found`, and nothing caught it: every spike drove `python -m pip` directly, and the
  template check — which does assert a command resolves on PATH — reads only the first
  word of a manifest, which was `python`. So a whole feature was green, browser-tested
  and unreachable by its own name. Two rules came out of it:
  - **Add the `-m` handler and the PATH shim together.** `PYTHON_DELEGATES` in
    `coreutils.js` maps bare command → module and *generates* the six shims, so there is
    no hand-copied block to forget. `pip3` sits beside `pip` for the same reason
    `python3` sits beside `python`. `venv` is deliberately absent: CPython ships no
    `venv` binary, and the spike checks that excuse against the host's real Python rather
    than believing the comment.
  - **The gate derives the list, it does not restate it.** `spike-python-offline.mjs`
    scrapes `if (mod === '…')` out of the launcher itself, so a seventh entrypoint fails
    the offline tier until it is either put on PATH or excused in writing. A written-out
    list would have been written when `pip` was added and would have had the same hole.

  Putting `pip` on PATH also puts pip's *top level* in reach — nobody types `python -m
  pip frobnicate`, but they will typo `pip instal`. Keep the two unknowns apart:
  `download` is a command real pip **has** and we do not (say so, and name what we do
  have), whereas `frobnicate` gets real pip's own `ERROR: unknown command "…"`, with its
  difflib-style suggestion. Calling `download` unknown sends someone hunting for a typo
  that is not there.
- **pip's output format is not ours to invent.** `formatPipList`/`Freeze`/`Show`/`Check`
  are pure functions in `python-store.js` specifically so `spike-python-offline.mjs` can
  assert them byte-for-byte against **real pip run on this machine** (`scripts/lib/
  real-pip.mjs` synthesises dist-info directories and runs `pip list --path`, so it needs
  no network). `pip freeze > requirements.txt` is load-bearing: output that is almost
  `name==version` fails later, elsewhere, in a file someone committed. Keep the
  formatting in JS and the *data* in Python — if you move rendering into the interpreter,
  that gate disappears and the offline tier stops covering it.
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
- **The interactive REPL is a second SystemExit path, and it echoes.** `exit()` typed at a
  `>>>` comes back OUT of `code.InteractiveConsole.push` — CPython's `runcode` re-raises
  `SystemExit` for the loop above it to act on — so `repl()` ends the session there, with
  the code `terminationFromError` reads (it now names the ending: `exit`/`interrupt`/
  `error`, so there is still one parser). A `KeyboardInterrupt` must NOT end it: name
  printed, fresh top-level prompt. And the loop echoes what it reads, to **stderr** and only
  under `VV_TTY=1`, because nothing below the guest cooks a terminal (see the shell/stdin
  section). Do not move that echo into `installStdin`: it would cover `getpass()`, which
  cannot turn it off — Emscripten's tty reports ECHO already clear and ignores `tcsetattr`,
  so no warning is printed and the password is on the screen. `input()` echo is therefore
  still missing, on purpose.
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

### A same-origin iframe still needs its OWN COEP header — and only the deploy shows it
Under `COEP: require-corp`, "same-origin subresources are exempt" does NOT extend to
nested **documents**. An iframe must send `require-corp` (or `credentialless`) on its
own response or the browser blocks the frame and renders "`<host>` refused to
connect" — the identical error page `X-Frame-Options` produces, which sends you
hunting for a CSP that was never there. It bit `/devtools-host.html`: it is hoisted to
the origin ROOT by `scripts/assemble-site.mjs` (the SW claims root scope and hard-codes
those paths), which put it outside the `/studio/*` rule in the generated `_headers`, so
production served it bare while dev worked fine — Vite's `swScope()` stamps isolation on
EVERY response, so no local run can reproduce it. Rules to keep:
- **Hoisting a file out of `/studio/` means it leaves the header scope too.** Anything
  hoisted that is *iframed* (today `devtools-host.html`) needs its own `_headers` entry;
  a hoisted file only ever loaded as a *subresource* (`vv-devtools/chobitsu.js`) does not.
- **List the extensionless form as well** (`/devtools-host` next to
  `/devtools-host.html`). Cloudflare Pages' clean URLs redirect `/x.html` → `/x`, and the
  header rule must match whichever URL finally answers `200`, not just the redirect.
- **Dev/preview headers and deploy headers are two separate mechanisms**
  (`packages/studio/vite.config.ts` vs. the generated `_headers`). A header change in one
  is not a change in the other — this class of bug is production-only by construction.

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
client agree. Templates doing this: **Docusaurus** (`baseUrl`), **Rspress** (`base`, forwarded
to Rsbuild as `server.base`), **Starlight** (Astro `base` — its sidebar/pager links are
root-absolute, and the SW does not proxy a prefix-less *navigation*), **React Router 7**
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
  `prototype.{require,load,_compile}`. `builtinModules` is the public list only,
  and it is **derived, not hand-listed**: `listPublicBuiltins()` in
  `runtime/index.js` intersects Node v24's public core ids with what `require()`
  can genuinely serve (the eager `builtins` table ∪ `nodeModules.has(id)` — the
  same predicate `module.js` uses to answer `builtin: true`), so the list is
  resolvability by construction. **Its placement is load-bearing in both
  directions:** it must sit AFTER `builtins.module = Module` (the old snapshot sat
  above that line and so omitted `module` itself) and BEFORE the `node:` alias loop
  (no prefixed dupes). It is also the memoizing call, so
  `process.binding('natives')` reports the same set — see that gotcha below.

### Don't shadow a vendored `lib/` module with an eager `builtins` shim
`module.js` consults `hasBuiltin` (the eager `builtins` table in `runtime/index.js`)
**before** `hasLazyBuiltin` (the vendored `loader.js`), so an id present in both is
served by the shim and the vendored module becomes unreachable — silently, under
the same name. `assert` was the live instance: a 51-line `builtins/assert.js`
answered `require('assert')` while `require('assert/strict')` went through the
loader to the real 246-line `node/lib/assert.js`. The two ids were therefore
*structurally different objects*, ten members were missing, `deepEqual` was aliased
to `deepStrictEqual`, and worst of all `throws(fn, ExpectedError)` **ignored its
second argument** — a test asserting one specific error passed on any throw at all.
That shim is deleted; `assert`, `node:assert` and `assert/strict` all resolve
through the loader now and `assert/strict === assert.strict`. Consequence to expect:
in-VM assertions that were vacuous now genuinely assert, so a guest suite that was
green can legitimately go red. Rule: `builtins/` is for what Node's `lib/` can't
give us (`process`, `os`, `child_process`, the Bun surface); when a vendored `lib/`
module exists, route to it instead of parking a shim in front of it.

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

### Web Streams interop is ADAPTED, not vendored — and its host promises must ref the loop
`node/internal/webstreams/adapters.js` is the seam behind `Readable`/`Writable`/
`Duplex`'s `toWeb`/`fromWeb` (fetch and `Response` bodies, `Blob`/`File`, the
preview Service Worker path). All six converters are implemented; only
`newWritableStreamFromStreamBase`/`newReadableStreamFromStreamBase` throw
`ERR_METHOD_NOT_IMPLEMENTED` on purpose (they drive a libuv StreamBase handle
directly, which our `stream_wrap` JS shim doesn't implement — nothing in the
runtime calls them, and net/http reach Web Streams via `toWeb` on the socket).
Unlike everything under `internal/streams/**`, this file is a **hand-written
adaptation of upstream, not a verbatim vendor**, for two structural reasons — so
don't "restore" it from an upstream copy:
- Upstream builds on Node's own bundled WHATWG implementation
  (`internal/webstreams/{readablestream,writablestream,queuingstrategies}`). We
  bundle none: `stream/web` (`node/loader.js`) re-exports whichever WHATWG globals
  the host realm provides — the browser Worker's own classes in the studio, Node's
  in the headless twin. So the classes resolve from `globalThis`, **per call** (a
  realm-capability problem must not make `require` of the module fail), and
  `isReadableStream`/`isWritableStream` duck-type via `internal/streams/utils`
  rather than brand-check (a browser-realm `ReadableStream` fails a Node brand check).
- Upstream reads the `SafePromiseAll`/`SafePromisePrototypeFinally` primordials,
  which `node/primordials.js` cannot resolve — *destructuring* them throws. The
  file uses plain intrinsics, like the other hand-written `internal/*` modules.

The same distinction bites in the small, and cost the whole `toWeb` surface once:
**an import line copied from upstream is not safe here either.** This file shipped
with upstream's `const finished = require("internal/streams/end-of-stream")`, correct
upstream because that module is callable there. Ours exports the plain pair
`{ eos, finished }` (`node/internal/streams/end-of-stream.js:344`), so the line bound
an object and all three `toWeb` conversions died in the VM on
`TypeError: finished is not a function`, with no `code` to grep for. It reads
`const { eos: finished } = require(…)` now, aliased rather than renamed so the six
converter bodies stay character-identical to upstream and re-vendoring stays
diffable. `eos` is the callback form that returns a cleanup function; the sibling
`finished` export is the **promise-returning** variant, so the plausible-looking
`const { finished } = require(…)` is also wrong and would break the cleanup contract
one frame later instead. Check what a module in this tree actually exports before
trusting upstream's binding for it.

One deliberate divergence from upstream's logic: `writev` splits its fulfilled and
rejected handlers. Upstream installs one handler for both and calls `.filter()` on
it, which on the rejection path is an `Error` — upstream survives because the real
error also arrives via `writer.closed`, but here `runtime/index.js` escalates any
non-sentinel unhandled rejection to `uncaughtException`, which kills the guest.

**The loop-liveness contract.** Every host-realm promise these adapters await must
be wrapped in `runtime/index.js` or the per-process loop can decide the process is
idle and exit mid-transfer (`loop.isAlive()` is an OR over the liveness counters,
and a pure stream transfer has no socket/timer to hold it up). Covered: the reader's
`read()`/`cancel()`, the writer's `write()`/`close()`/`abort()`, and `writer.ready`
plus both `closed` accessors. Two traps if you extend this:
- `ready`/`closed` are **getters**, so `wrapHostAsync` skips them (it early-returns
  unless the property is a function) — use `wrapHostAsyncGetter`, which replaces
  only `get` and keeps the property an accessor. Collapsing it to a data property
  would pin the first promise forever; `ready` hands out a *different* one each time
  the queue fills and drains.
- Accessors need `trackHostOnce` (a `WeakSet`), not `trackHost`. Per spec `closed`
  is created once per reader/writer and returned on *every* read, so refing each
  access stacks up refs that its single settlement can never balance — a
  permanently-alive loop, i.e. a hung guest.

One liveness semantic came with this, deliberately: `closed` stays pending for the
stream's whole lifetime and the adapters read it eagerly at construction, so a guest
that builds an adapter and then neither consumes nor destroys it now hangs where it
used to exit. That is
arguably the correct emulation (in real Node the underlying handle refs the loop),
and the transfer-safety fix doesn't depend on it — the retreat is dropping `"closed"`
from the two lists in `runtime/index.js`.

### Enumerating `fs`/`util`/`net` trips their lazy getters — vendor every internal they name
`lib/fs.js` exposes several members as lazy getters (`get Utf8Stream` →
`internal/streams/fast-utf8-stream`, and `defineLazyProperties(fs,
'internal/fs/dir', ['Dir','opendir','opendirSync'])`, plus streams/promises).
Code that *enumerates* `fs` — yarn's `thenify-all` does `promisifyAll(fs)`, i.e.
touches EVERY key — fires those getters, and a missing target module throws
`no vendored Node builtin '…'` even though nothing uses the feature. Both
`internal/streams/fast-utf8-stream` and `internal/fs/dir` are now provided
(pragmatic, functional shims) and registered in `node/loader.js`. If you add a new
lazy `fs` getter, register its module too, or bare enumeration will crash.

**The same trap runs wider than `fs`, and lazily-required ids are the general
case.** An `internal/*` id that the vendored `lib/` only reaches from inside a
function — `defineLazyProperties`, `defineReplaceableLazyAttribute`,
`getLazy(() => require('id'))`, or a plain `require` in a cold branch — imports
cleanly however wrong the `FACTORIES` table is, and throws only on first *use*. A
static sweep of `node/lib/**` + `node/internal/**` for every id reachable that way
found **13 unregistered; the three that were left after that sweep are registered now** — what remains is deliberate and recorded in
`roadmap.md`:
- `util` is clean. `util.MIMEType`, `util.diff` and `util.setTraceSigInt` (an
  honest "not implemented" stub) resolve, so spreading `util` no longer throws;
  same for `fs.cp`/`cpSync`, `fs.rm` recursive, `fs.glob`/`globSync`,
  `path.matchesGlob`, `fs.watch(dir, {recursive:true})` and `events.on()`.
- `net` **is done now**, and how it got unblocked is the transferable part. It was
  left throwing on purpose: `net.BlockList`/`net.SocketAddress` are getters over
  `internal/blocklist` / `internal/socketaddress`, which need the C++ `block_list`
  CIDR matcher, and "reimplementing v4/v6 subnet matching in JS with no test suite
  is worse than useless for a primitive callers use to *accept* a connection" — a
  wrong `BlockList` beats an honest throw only in appearance. The objection was
  never the matcher, it was the missing suite. **Real Node is the suite**:
  `spike-net-blocklist.mjs` runs 45 cases through the host's `BlockList` and ours
  and requires identical answers, which is a stronger oracle than anything
  hand-written and caught a case on the first run (an IPv4-mapped address must print
  its dotted-quad tail, `::ffff:1.2.3.4`, not `::ffff:102:304`). Both bodies are
  vendored verbatim; only `internalBinding('block_list')` is ours, in
  `bindings/block-list.js`. When you meet the same shape of refusal — a security-ish
  primitive we decline to guess at — ask whether the host can be made to judge it
  before concluding it cannot be done.
- `util.getCallSites()` still throws, one layer lower than people expect: it needs
  `internalBinding('util').getCallSites`, so registering
  `internal/source_map/source_map_cache` would not fix it.
When you vendor a `lib/` module, sweep it for lazily-required ids and register them
in the same change — "it imports fine" proves nothing about them.

### `process.binding(name)` is a real (legacy) surface some bundles need
Deprecated in Node but still called by bundled deps (yarn's `safer-buffer` →
`process.binding('buffer').kStringMaxLength`, `builtin-modules` →
`Object.keys(process.binding('natives'))`, a `constants` polyfill, a `util`
legacy path). `runtime/index.js` wires `process.binding` to delegate to the same
`internalBinding` seam the vendored Node lib uses (`loader.js` exports it);
`'natives'` (source strings we don't have) becomes a name→'' map so `Object.keys`
still yields the core-module list, and unknown names return `{}` instead of
throwing. Don't remove it — several ecosystem packages break without it.

**`'natives'` and `Module.builtinModules` must stay ONE list.** Both now answer
from `listPublicBuiltins()` (see the `module` gotcha above), so `is-core-module` /
`builtin-modules` and `Module.isBuiltin` cannot give different answers. They used
to be hardcoded separately and were wrong in opposite directions: `natives` vouched
for `dgram`/`domain`/`repl`/`sys`, which hard-throw `no vendored Node builtin '…'`
on require — so `is-core-module` sent callers straight into that throw instead of
letting them fall back to a browser polyfill — while `builtinModules` listed only
the eager table (19 names) and so disagreed with `Module.isBuiltin`, which has
always consulted the loader too. Don't re-introduce a literal array in either
place; add the id to `NODE_PUBLIC_CORE_IDS` and let the filter decide. Note the
blast radius when you do: bundlers read `builtinModules` to mark externals.

### Never silently swallow a syscall throw
`bridgeHttp`'s `reply()` once wrapped `respond()` in a bare `try/catch`, so a
"too large" throw turned into a silent hang. Any catch around a syscall must
**fail the pending operation**, not drop it.

### A builtin whose factory throws must be EVICTED from the loader's cache
`loader.js`'s `nodeRequire` registers `{exports:{}}` in `modules` *before* running
the factory — it has to, or a cyclic `internal/*` require would recurse forever.
But it used to leave that entry behind when the factory threw, so the first
`require` reported the real error and **every later one silently returned `{}`**:
the loudest failure mode in the runtime degrading into an empty object on the
second call. What that looks like from the outside: reading `util.MIMEType` threw
once (an unresolvable primordial, at the time), returned `undefined` forever after,
and the caller died much later and somewhere else with "X is not a constructor".
The factory call is now wrapped so a throw `modules.delete(id)`s before re-throwing.
Cycle tolerance is unaffected — eviction only happens on the throw path. Known
residual: if A requires B, B captures A's partial exports and succeeds, and *then*
A throws, A is evicted while B still holds a reference to A's dead partial (better
than a permanently poisoned cache, not perfect). General rule for any cache keyed
on "in progress": the failure path has to unwind the entry the success path would
have completed.

### Missing error constructors → "X is not a constructor"
Node's `lib/` destructures error classes from `internal/errors` eagerly but only
*constructs* them on error paths (socket close, `EADDRINUSE`, stream destroyed).
If a class is undefined you get a cryptic minified `TypeError: Je is not a
constructor` the first time that path runs. When you add a `lib/` module, make
sure every `ERR_*` / `*Exception*` it references is exported from
`node/internal/errors.js` (stream, http, and net families are all there now).

Related contract in the same file: `makeSystemError` sets `err.code` to the
**`ERR_*` key** (`ERR_FS_EISDIR`) and carries the libuv name on `err.info`, with
the syscall and path in the message. That's Node's actual contract and it is what
every ecosystem `err.code === 'ERR_FS_CP_*'`-style check reads; it previously set
the libuv name (`EISDIR`) as `err.code`, so all of those checks missed. Don't
"simplify" it back — a bare libuv code is only right on errors coming straight out
of the fs *binding* (`vvError`), not on SystemErrors.

### `primordials` resolves by naming scheme — and `Promise` is the ONE bound namespace
`node/primordials.js` derives Node's "safe intrinsics" from their names through a
Proxy (`<Ns><Static>` → `Ns[static]`, `<Ns>Prototype<Method>` → uncurried, …; the
file's header has the full table) instead of hand-maintaining Node's giant literal.
Unknown names throw loudly, which is what surfaces the exact intrinsic a
newly-vendored module needs. Two things a later edit must not undo:
- **`BIND_STATICS`, the documented exception to that naming scheme.** A static that
  reads `this` as the constructor to instantiate cannot be handed out raw: a
  destructured `PromiseResolve(x)` runs with `this === undefined` and throws "is not
  a constructor". So `resolve()` binds statics whose namespace is in `BIND_STATICS`
  — which holds `Promise` and nothing else, mirroring the single
  `copyPropsRenamedBound` list in Node's own `per_context/primordials.js`. Because
  it *is* an exception to the header, it looks like something to tidy away; doing so
  re-kills `events.on()`, `internal/fs/cp/cp` and `internal/streams/duplexify`.
  Widening it to every namespace is wrong in the other direction: `%TypedArray%`'s
  statics need a **concrete subclass**, never the abstract base, so a bound
  `TypedArrayFrom` would look resolved and never work, where unbound it keeps
  throwing honestly. If a future module needs a bound static from another namespace,
  add that namespace — the symptom will be a loud throw at the call site.
  (Bound functions change `.name`: `PromiseResolve.name` is `"bound resolve"`.
  Faithful to Node, but don't add code that reflects on it.)
- **`Safe*` names are not derivable.** They match no `<Ns>` prefix, so they only
  exist if hand-listed in `SPECIALS` — and *merely destructuring* a missing one
  throws at module load, which is how `internal/mime` and `internal/fs/cp/cp` used
  to die on require. `SafePromiseAll` and `SafeStringPrototypeSearch` are there now,
  written with the file's own `uncurryThis` so they don't route through patchable
  prototypes. They are "safe" in this file's sense, not upstream's: like
  `SafeMap`/`SafeSet`, they're the plain intrinsic rather than a monkeypatch-proof
  subclass, so `SafePromiseAll` still iterates via a patchable `Symbol.iterator`.
  Fine for vendored callers; revisit all of them together if this runtime ever has
  to defend against hostile guest code.

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

### A zero in a `stat` field is not a neutral default — it can switch off logic upstream
`writeStatsInto` in `bindings/fs.js` fills the fields the VFS cannot model with
`0` (uid, gid, rdev). That is fine until a vendored module reads one as a
**truthiness test** rather than a value. `dev` was 0 for exactly that reason, and
Node's `fs.cp` decides "src and dest are the same file" with
`destStat.ino && destStat.dev && ino === ino && dev === dev` — a zero `dev` makes
the whole conjunction falsy, so the check never fired: `fs.cp(a, a)` skipped
straight past ERR_FS_CP_EINVAL and copied a file onto itself. It is now `1` (one
virtual filesystem, one device id), which repairs the async and sync copy paths at
once. Two rules follow:
- **Before filling a stat field with 0, grep the vendored lib for the field name**
  and check whether anyone tests it for truth. `ino` was already non-zero, which is
  the only reason this was a silent wrong answer instead of a crash.
- **A field we cannot model is still better given a plausible constant** than a 0
  that reads as "absent". The same applies to `nlink`, which defaults to 1 for this
  reason — pnpm keys on it.

### `node` is a shim, so "what Node does at startup and exit" is ours to get right
`node` inside the VM is `/bin/node.js` (`packages/kernel-host/coreutils.js`), a program
that parses the CLI and loads the user's. Three things it must do that are easy to get
subtly wrong, and were:
- **The entry has to BE the main module.** It used to run with `require(abs)`, which
  makes the entry an ordinary child of the shim, so `require.main` stayed
  `/bin/node.js` and `if (require.main === module)` was **false**. A large share of
  npm's CLIs are written around that guard; they loaded their imports and did nothing.
  Use `Module.runMain(abs)`, which also returns the module's top-level-await promise.
- **`-r` resolves from the CWD, not from the shim.** Node resolves a preload as if
  required from a file in the working directory. Ours used the shim's own `require`,
  at `/bin`, so a project could not preload its own dependency
  (`Cannot find module 'dotenv/config' from '/bin'`). Anchor a `createRequire` at the
  cwd — and note `-e`'s injected `require` needs the same anchor.
- **A preload that fails is fatal.** Node never starts the program. Warning and
  continuing runs it without its instrumentation, and the only trace is one line above
  output that otherwise looks normal.

### A loop that runs dry is an event, not just an exit
Two things Node does when the loop empties that we did not:
- **`beforeExit` is emitted, and a listener may schedule more work** — that is the
  whole point of it (a pool draining its last jobs, a logger flushing). So the loop
  emits, drains microtasks, and looks again; only a still-empty loop ends the process.
  A listener that always schedules keeps the process alive for ever, exactly as on
  Node. It is NOT emitted after `process.exit()`, which is an explicit end.
- **A main module still suspended on a top-level await exits 13, with a warning.** We
  exited **0**, silently, having done none of the work — and 0 is the one answer that
  cannot be debugged, because it is indistinguishable from success. `module.js` tracks
  the main module's evaluation promise (`isMainPending()`); note that `runMain` nests,
  because the `node` shim calls it again for the user's file and returns LAST, so the
  tracker must not let the outer call clear the inner one's state.

What this does *not* catch is a floating promise inside a program — an `await` on a
message that never arrives, with nothing ref'd holding the loop open. Node has no
detection for that either; the difference is that on Node the message usually arrives.
`vitest` looked like exactly that and was not: something *was* holding Node's loop,
and it was a `MessagePort` nobody was listening to (see below). The lesson is that
"floating promise, nothing ref'd" is a conclusion to verify, not one to reach —
`process.getActiveResourcesInfo()` on the host names what is holding the loop, and an
`async_hooks` `init` hook names who created it.

### The constant tables have ONE home: `node/bindings/constants.js`
`os.constants`, `fs.constants`, `crypto.constants` and the deprecated `constants`
module are views over it, as they are views over `internalBinding('constants')` on
Node. Do not add a local copy holding the names your caller needed — that is how all
four surfaces ended up partial and disagreeing:
- `os.errno` held a single entry (`EISDIR`) for as long as one caller was known, so
  `fs.cp` threw its `ERR_FS_CP_*` errors with `errno: undefined`. Invisible: the
  `code` was right and almost nothing asserts the number.
- `os.constants.signals` was `{}`, so `child.kill(os.constants.signals.SIGKILL)`
  killed with `undefined`; `.priority` was `{}` and `.dlopen` absent.
- `fs.constants` had the owner permission bits but neither group nor other, so a mode
  built from `S_IRWXG | S_IROTH` came out `NaN`.
- `crypto.constants` had 7 of 56 — the RSA padding the signer used, and nothing a
  caller might read.

None of that can announce itself: reading a missing constant is `undefined`, not an
error, and `undefined` in a bitmask is a silently wrong number. Values are the host's,
dumped rather than typed — the OpenSSL bits are not derivable from anything we run.
`spike-constants.mjs` compares all five surfaces to the host, keys and values, and is
also how you regenerate after a Node upgrade. Two rules that look like bugs and are
not: we expose FEWER zlib names than zlib defines (matching Node — a superset makes
code work here and fail there), and `defaultCipherList` lives in `lib/crypto.js`, not
the table, because on Node it is a lib-level value.

### A ref'd MessagePort holds the loop, listener or not
`port.ref()` refs a handle. It does not need a `'message'` listener, and
`@emnapi/runtime` — under rolldown's wasm binding, under Vite 8, under vitest —
depends on precisely that: `new MessageChannel().port1`, `ref()` while a native
async request is outstanding, `unref()` after, nothing ever posted or listened to.
Ours had `ref()` as `return this`, so `vitest run` exited **0** in 1.1s having run
nothing. Rules that now hold, each with a case in `spike-port-liveness.mjs` measured
against the host:
- A port holds the loop while ref'd — by `ref()`, or by having a `'message'`
  listener (listening `start()`s a port, and starting refs it). `unref()` and
  `close()` release it.
- Order therefore matters and is not a contradiction: `w.unref(); w.on('message')`
  **waits**, `w.on('message'); w.unref()` **leaves**.
- **Wrap the platform's `ref`/`unref`/`close`, never replace them.** Headless, the
  platform `MessagePort` is the host's own and the runtime shares its realm, so that
  prototype also carries the runtime's own plumbing.
- **Assigning `port.onmessage` refs the port** (Node's EventTarget bookkeeping calls
  `ref()` from its newListener hook), and the runtime does that on its own ports —
  the Worker's half of the parent↔child channel, and the raw port behind
  `parentPort`. Those two assignments go through `internalPortSetup(…)`, which
  suppresses the guest hold for the duration. Without it every worker spawn hung: the
  parent waited on a child that its own runtime port was keeping alive for ever.
- **`release()` must wake the loop, like `retain()` does.** A release can land inside
  a host callback with the loop parked in `waitForNext`; retaining without waking
  misses work, releasing without waking hangs a process that has just finished.

### An `fs` error is five facts, not one — label it in the binding
The syscall bridge can only report a **code**: a Rust VFS failure crossing the
shared-memory window has one string to spend, so `fs-client.js` throws
`new Error('ENOENT')` and nothing more. For a long time that error travelled all the
way to user code, which meant every fs failure in the VM read `ENOENT` — no path, no
syscall, no errno, and a message that could not tell you which file it was about.
Real Node says `ENOENT: no such file or directory, open '/app/config.json'`, and
that difference is not cosmetic:
- `err.syscall` is how `rimraf` and `graceful-fs` decide a failure is theirs to
  retry; an absent property reads as "some other error", so the recovery path
  silently does not run and the bug looks like flakiness somewhere else.
- `err.path` is the only thing that makes a log actionable.
- `err.errno` is still compared numerically by a long tail of libraries.

The fix belongs in `bindings/fs.js`, which is the layer that knows both the
operation and its arguments — the same place Node builds these errors (`uvException`
in `src/node_errors.cc`), for the same reason. `SYSCALL_LABELS` maps each binding
method to the libuv syscall name plus the argument INDICES of its path and dest, and
a wrapper relabels any bare code on the way out. Four things about it to know before
touching it:
- **The libuv name is often not the method name.** `readdir` reports `scandir`,
  `copyFile` reports `copyfile`, `utimes` reports `utime`, `realpath` reports
  `lstat` (Node walks the path with it), and `readFileSync` reports `open`. Do not
  infer these — the spike asks the host.
- **The async path is labelled in `dispatch`, not in the wrapper.** An async call
  hands its error to `oncomplete` instead of throwing, so the wrapper's `catch`
  never sees it. `dispatch` reads the in-flight call from `callContext`, a single
  slot, which is sufficient only because a syscall here is synchronous start to
  finish — the same property that lets the bridge block on `Atomics.wait`.
- **Only bare codes get labelled** (`isBareSyscallError`: a POSIX-shaped `code` and
  no `syscall`). The `ERR_FS_*` errors the vendored `lib/` throws are Node's own and
  must pass through untouched.
- **Paths are reported unresolved**, as the caller passed them, which is what Node
  does; the cwd resolution in `R()` is for the VFS only.

`scripts/spike-fs-errors.mjs` runs ~48 failing calls on the host and in the VM and
demands identical transcripts, message included. It carries one pinned divergence:
`fsync` on a bad fd, which we deliberately do not catch (see below).

### `chmod`/`chown`/`utimes` can't persist — and `access(f, X_OK)` now says so
The VFS keeps a per-inode `mode` (`packages/vfs/src/lib.rs`) but only ever assigns
it at **creation** — `open()` honours its `mode` argument on the `O_CREAT` branch,
`write_file`/`mkdir` hardcode `0o644`/`0o755` — and it models neither uid/gid nor
atime/ctime at all. There is no `OP_CHMOD`/`OP_CHOWN`/`OP_UTIMES` in
`protocol/syscall.js`, so none of these ops can change anything. Three rules follow:
- **They report success on purpose.** `ENOSYS` here breaks `npm install` outright:
  npm's `bin-links` does an unconditional `chmod(file, mode)` per installed bin and
  propagates the rejection, and node-tar errors an extracted entry when `futimes`
  *and* `utimes` both fail — i.e. on every tarball npm/yarn/pnpm unpacks. It is also
  not clearly the dishonest answer: this is a filesystem with no mutable permission
  model, exactly the case where real implementations accept the call and move on
  (Node on Windows, any FAT mount). Nothing fabricates a value on the way back —
  `stat` keeps reporting what the VFS actually holds, so chmod-then-stat is
  self-consistent, just unchanged. `fsync`/`fdatasync` are a different case and
  genuinely truthful: the VFS *is* the storage (Wasm linear memory), so there is no
  write-back buffer between a returned write and it.
- **They do throw `ENOENT` when the target doesn't exist.** That part was a real
  lie and costs one stat. `statFor` relabels the error with the caller's syscall
  name, so you get `ENOENT: chmod '/nope'`, not `ENOENT: stat '/nope'`. The **fd**
  variants (`fchmod`/`fchown`/`futimes`) deliberately skip the equivalent `EBADF`
  check — node-tar calls all three on every extracted file, each check would be
  another sync round-trip on npm's per-file hot path, and the write that just went
  through that fd already proves it is live. That is the one residual dishonesty
  here, and it is knowing.
- **`access()` enforces `X_OK`,** and the coupling to the above is the trap.
  Everything runs as uid 0 and POSIX lets root bypass the read/write checks, so
  `R_OK`/`W_OK` passing for anything that exists is the correct answer rather than a
  shortcut; `X_OK` is the one root does **not** get free. So
  `chmod(f, 0o755)` followed by `access(f, X_OK)` now **throws** where it used to
  falsely pass. That is the intended direction — it surfaces the missing `OP_CHMOD`
  at the point of use instead of hiding it, and it agrees with `stat`, which has
  always reported those files as non-executable (`isexe`, which npm's `which` uses,
  reads `stat.mode` and already answered "no"). The way to get an executable file
  today is to pass the mode at creation: `writeFileSync(p, s, { mode: 0o755 })` goes
  through `open(O_CREAT, mode)`, which the VFS *does* honour. If a bundled tool
  trips on it, the revert is the single `if` block in `access`.

Making these real is a Rust-side change — `OP_CHMOD`/`OP_UTIMES` in
`protocol/syscall.js` plus `set_mode`/`set_mtime` on `VirtualFileSystem`, then
`fs-client.js`/`fs-server.js` and the binding — and it retires the `access` caveat
with it. Tracked in `roadmap.md`.

### A handle's close callback belongs to the loop's CLOSE PHASE, never to nextTick
`handle.close(cb)` in `bindings/net.js` schedules `cb` through `loop.queueClose`,
which `drive()` runs after `runImmediates()` — libuv's order (timers → check →
close), and specifically **after** the nextTick drain.

This is not a nicety about phases. `Socket._destroy` queues the `'close'` emit via
`handle.close(cb)` and only THEN calls `cb(exception)`, which is where the stream
emits `'error'`. Put the close callback on nextTick and it is queued FIRST, so every
failed socket announced `'close'` before `'error'` — the reverse of Node. What made
that expensive is who reads the order: `_http_client.socketCloseListener` sees a
close with no error recorded, concludes the peer hung up, and emits a synthetic
`ECONNRESET "socket hang up"`. So `http.request` to a port nobody listens on
reported a reset instead of `ECONNREFUSED`, and then emitted the real error as a
**second** `'error'` on a request Node guarantees emits one — which can crash an app
whose handler is not idempotent.

Two lessons worth keeping:
- **`hasRefWork()` must count queued close callbacks.** The handle is already out of
  `isAlive` by then, so without it the loop can exit still owing a `'close'` event.
- **A bug can be hidden by a worse one.** This shipped for a long time behind
  uncaught-callback errors exiting 0: verify-node's assertion failed on the phantom
  error, the throw was swallowed, and the real `ECONNREFUSED` arrived next and
  satisfied the check. Making uncaught errors fatal did not break this — it revealed
  it. When a long-green check goes red right after an error-handling change, suspect
  the check, not only the change.

Gated by `spike-net-close-order.mjs`, which runs each scenario on the HOST's real
Node as well as in the VM and requires identical transcripts — Node is the oracle,
not our belief about Node. Reverting the one-line scheduling change turns 9 of its
checks red.

### The virtual network is loopback-only — `connect()` now rejects everything else
`listen()` registers a **port** and `connect()` finds a server by port; no host ever
enters the table. `lib/dns.js` also resolves every name to `127.0.0.1` (deliberately
— it's what makes `net.connect(p, 'localhost')` work), so `net.connect(3000,
'api.example.com')` used to reach the binding as `("127.0.0.1", 3000)` and be served
by whatever in-VM dev server owned `:3000`. Connecting *successfully* to the wrong
machine is the worst outcome on offer: the caller gets a 200 from the wrong service
and the mistake surfaces nowhere near its cause. `bindings/net.js` `connect()` now
judges the destination **before** the port lookup — non-loopback hostname →
`ENOTFOUND`, non-loopback IP literal → `EHOSTUNREACH` (both added to the `uv`
errmap; `ENOTFOUND` rides libuv's `EAI_NONAME` number because nothing here goes
through Node's dns translation layer and `ENOTFOUND` is what `lib/dns.js` already
returns). Allowed: `localhost`, `*.localhost`, `""`, `vivari` (mirrors
`builtins/os.js`'s `hostname()` — a program dialling its own hostname is dialling
itself), and the loopback/unspecified literals `127.0.0.0/8`, `::1`, `::`,
`0.0.0.0`, `::ffff:`-mapped v4. Three details are load-bearing:
- The requested hostname is recovered from the Socket's `_host` via
  `handle[owner_symbol]` (`lib/net.js` stashes it there *before* the lookup).
  That symbol is minted in `internal/async_hooks.js`, which the bindings layer
  cannot require, so it's located by `Symbol.description` and cached — and
  **re-probed rather than negatively cached**, since a bare TCP handle with no owner
  would otherwise blind every later connect.
- The guard sits before **both** the `listeners` lookup and the cross-process
  `pipeConnect` fallback, so the HMR/WebSocket relay, the preview replay and the
  Nitro/Nuxt-style cross-process proxy paths are all untouched.
- On the failure path `req.address` is set to the host the caller asked for, or
  `afterConnect` would build the message from `127.0.0.1` and hide the very mistake
  being reported.
Real outbound access is `globalThis.fetch` (the host fetch), which is unaffected —
this is about the in-VM TCP table only. `dns.lookup`'s `127.0.0.1` behaviour is
also unchanged.

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

A missing API doesn't always fail loudly, and the quiet case is the dangerous one:
security-sensitive code feature-detects. `crypto.timingSafeEqual ?
crypto.timingSafeEqual(a, b) : a === b` is the standard shape, so for as long as
that function was absent, every such call site silently degraded to `===` and
reintroduced the exact timing leak the call existed to prevent — nothing threw.
It's implemented now (`ArrayBuffer`/`TypedArray`/`DataView` only, strings rejected
with `ERR_INVALID_ARG_TYPE`, `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` on a length
mismatch, branch-free XOR accumulation with no early exit; the comment is honest
that JS can't promise instruction-level constant time the way the C++ original
does). When you find an API that callers feature-detect, implementing it beats
leaving the hole.

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
discipline — there's nothing cooked below it. **The consequence for any other
program that reads lines: whoever reads a line has to show it.** `sh` echoes only
what *it* reads and forwards raw keystrokes to a foreground child on purpose, and
`process.stdin.setRawMode` merely records the mode, so a child that reads and does
not echo (which is what the Python REPL did) leaves the person typing blind. Echo
belongs in that program's own read loop — see `repl()` in `builtins/python.js`,
which echoes to stderr under `VV_TTY` for the reasons in the Python section. It also does **↑/↓ history recall**
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
- **A delivery that arrives before the runtime exists must be QUEUED, not dropped.**
  The Process Worker only gets its `control` handle in `bootProcess`'s `onReady`,
  which is several async ticks after the worker starts — the runtime and its wasm
  codecs are built first. Every kernel delivery used to be guarded by
  `control && control.dispatchX(...)`, so anything landing in that window vanished.
  The case that loses is a **pipeline**: `cat fruit.txt | bun run tools/uniq.ts`
  spawns both stages up front, `cat` is a tiny coreutil that finishes at once, and
  the reader is a full runtime boot — so the kernel relays `cat`'s EOF to a worker
  with no `control`, the reader never sees end-of-input, and the pipeline hangs
  forever. Both workers now buffer pre-ready deliveries in arrival order and flush
  them on ready. Dropping is never right for any of them: they are one-shot events
  (an EOF, an exit, a signal, a fetch result), not state that can be re-read later.
  **Our Node tiers cannot catch this class of bug.** `bootProcess` reaches
  `onReady` synchronously under `worker_threads`, so the pre-ready window never
  opens and a spike passes with or without the queue — confirmed by deleting the
  queue and watching the test still pass. That is exactly how it shipped: every
  gate we own runs on the end of the race that always wins. When a hang reproduces
  only in the browser, suspect an ordering window the Node harness closes for free,
  and reach for `await __vv.diag()` rather than a spike. The tell here was a
  process with `syscalls: 0` and `booted: true` whose pipeline writer had already
  left the table — parked on input that was delivered to nobody.
- **`__vv.diag()` now names the handles holding each loop (`proc.alive`).** A pid
  that never leaves the table looks the same whatever the cause, so `alive` breaks
  it down: the runtime's liveness counters (`net`, `child`, `thread`, `host`,
  `watch`, `ws`, `sse`, `stdin`) plus the loop's own ref'd `timers`, `immediates`
  and `nextTicks`. Read only the non-zero entries. **All zero is itself a result**:
  the loop is not what's holding the process, so look at a parent waiting on a
  child, or a syscall that never got its reply. It rides the existing `proc-mem`
  round-trip, so it costs nothing extra. `spike-diag-liveness.mjs` holds a guest
  open two different ways and requires the two breakdowns to differ — a field that
  only says "something is alive" would be no better than the pid.
  `timerDetail` gives each ref'd timer's shape (`everyMs` for intervals, `delayMs`,
  `dueInMs`), because the count alone stalled an investigation once: every process
  reported exactly `timers: 1` and nothing said which. Known shapes — `1073741824`
  (`1 << 30`) is the esbuild keepalive in `esbuild-inproc-patch.js`, `120` is the
  ws reconnect in `index.js`. `30000` was the one that started it: see below.
- **A Process Worker's globals are shared with the host page, and we install the
  guest's timers on them.** `globalThis.setInterval = loop.setInterval` means ANY
  code in that worker — not just the guest — registers ref'd handles in the guest's
  event loop, where they vote on whether the guest is done. In a **Vite dev server**
  that is the HMR client, which arms a 30s keepalive ping (`setInterval(ping, 3e4)`)
  from its async `connect`. It landed in the guest's loop as a ref'd handle, so
  `hasRefWork()` was true forever and **no guest that merely finished could exit** —
  it printed its last line and hung. It looked like a Bun bug because the Bun
  templates are plain scripts that end; servers were unaffected (they stay up
  anyway) and so was anything calling `process.exit()` (npm does). Dev-only, and
  invisible to every Node tier.
  Two defences, and they are not interchangeable:
  - `loop.disownExistingHandles()`, called immediately before the entry runs —
    nothing registered before the guest's first line can belong to the guest. It
    unrefs rather than clears, since those callbacks are the host's and should keep
    firing. **This alone does not catch the HMR ping**, which is armed later, from
    an async connect, long after the entry starts. It was shipped believing it did.
  - the `HOST_TOOLING_FRAME` check in the `Timeout` constructor, which unrefs an
    interval whose creation stack names `/@vite/client`. Matching a frame is narrow
    on purpose: the general rule ("only the guest, or the runtime acting for it, may
    hold the loop") cannot be read off a stack safely, because a production bundle
    has no distinguishable paths and a path-based rule would unref things that must
    stay ref'd — the esbuild keepalive among them. Defaulting to ref'd and naming
    the one known host frame keeps the failure mode conservative.
  Both are covered by `spike-diag-liveness.mjs` (`VV_SIMULATE_DEV_HMR_PING=1`), which
  arms the ping **mid-run from a `/@vite/client` frame** via `sourceURL`. Both
  details matter: an earlier seam armed it in `onReady`, and the before-entry fix
  passed against it while the browser stayed broken.
  **How it was found, after two wrong answers.** The count said "a timer"; the period
  (`30000`) named a suspect; reading Vite's source then appeared to exonerate it,
  because Vite prepends `/@vite/env` to module workers and that file has no timer —
  the client is nonetheless loaded there. Only `timerDetail.createdAt`, the creation
  stack, settled it. Reach for the stack before the theory.

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

### The Python language service runs on its OWN interpreter, and it is not a process

jedi and black need an interpreter, and the one `python foo.py` uses is the wrong one:
it boots per process and dies with it. Completion cannot share a fate with a REPL the
user quits. So `packages/core/src/workers/python-lsp-worker.ts` is a second Pyodide,
started by the kernel worker as a plain `new Worker` and **never through
`createProcess`** — it has no PID, is absent from `ps` and `diagnostics()`, and `kill`
cannot reach it. If you find yourself giving it a PID "for consistency", you have just
made a language-service boot look like a process the user started.

It boots on the FIRST language request, not at studio start, and the studio's
`import("./python-language")` is dynamic for the same reason: someone editing
TypeScript must not download an interpreter. Both are gated in the offline tier.

### jedi needs `InterpreterEnvironment`, because we set `sys.executable`

`jedi.Script(...)` without an explicit environment runs `sys.executable` in a subprocess
to read its version. We set `sys.executable = "python"` (so `runpy`'s `-m` errors read as
CPython's), Pyodide answers the exec with `OSError(138)`, and jedi raises
`InvalidPythonEnvironment` — every request fails, at the library's own entry point.
`InterpreterEnvironment()` introspects the running interpreter and never spawns anything.
The bridge spike asserts that the *default* path still fails, so the reason this line
exists cannot quietly become untrue.

### An empty completion list must mean "nothing to suggest"

The house rule about lying stubs has a specific shape here. A provider that returns `[]`
when jedi failed to load is indistinguishable from one with no suggestions, and the user
concludes the feature is broken rather than that something went wrong. Every failure path
reports through the status bar with its reason.

Formatting has the sharper version: if black cannot parse the buffer, the driver returns
**no `text` field at all**. Returning the input unchanged would render as "already
formatted" and quietly hide a syntax error; returning partial output would mangle the
file. The bridge spike mutation-tests both.

### black is NOT in Pyodide's lock — jedi is

Check before assuming. jedi ships in Pyodide's bundled set; black does not, and neither
do `pathspec` or `pytokens`. `scripts/vendor-pyodide.mjs` downloads them from PyPI and
injects them into the lock, and it must also pull each PyPI package's **lock-resident**
dependencies into the download closure — `click` and `platformdirs` are in the lock but
were not being downloaded, because black's entry was added *after* closure resolution, so
formatting worked online and failed offline. Pin the versions to what micropip actually
resolves (`pathspec` 1.1.1, not the 0.12.1 an older pin suggested): an unpinned formatter
reformats a codebase differently the day upstream changes a default.

### A lockfile's `depends` can be thinner than what the package imports

`loadPackage("mypy")` succeeds and then `from mypy import api` raises
`ModuleNotFoundError: typing_extensions` — and once that is satisfied, `mypy_extensions`,
and then `pathspec`, one at a time. Pyodide's entry for mypy declares `librt` alone. This
class of bug survives vendoring precisely because the *load* is fine: the wheel is on
disk, and the failure lands in front of the user the first time the feature runs. Do not
trust a lock's `depends` for anything you are about to ship a command for — import it in a
real interpreter and run it once. `DEPENDS_FIXUPS` in `scripts/vendor-pyodide.mjs` is the
one place the missing names live, feeding both the download closure and the emitted lock.

### A tool that ends in `os._exit()` takes Pyodide with it

mypy's command line finishes with `os._exit()` to skip interpreter teardown. Under
Emscripten that is not an exit code, it is the runtime being torn down: the diagnostics
print, and then the process dies as a crash with the status lost — so `mypy && deploy`
deploys on a failed check. Plain `runpy` is right for almost everything (black goes that
way and needs no seam), so the way to find the exception is to run the candidate once and
look at what comes back, not to reason about it. Where a tool ships an embedding API
(`mypy.api.run()`, `pytest.main()`), prefer it: those exist for this, and they hand back a
status instead of exiting. The cost is buffered output, which is worth stating in the docs.

### A package's lazy imports are the ones the lock forgets

The same trap as mypy's, one level further in. `rich`'s Pyodide entry declares **no**
dependencies at all, and rich imports pygments and markdown-it-py *lazily* — so `import
rich` works, tables and panels work, and `rich.syntax` raises `ModuleNotFoundError` at the
one line in a program that highlights something. markdown-it-py is not in Pyodide's index
at all, so a `depends` fixup alone would point at a wheel that does not exist; it has to
come from PyPI like black's closure. When adding a library, import its **submodules** in a
real interpreter, not the package — the package importing cleanly is what hides this.

### A tool's own output positions are not the editor's

mypy reports an inclusive end column and Monaco's `endColumn` is exclusive, so a marker
built from the raw numbers underlines one character less than the error. Worse, mypy
prints paths **relative to the working directory** when the file is under it, not the
absolute path it was given — so filtering diagnostics by comparing to the requested path
drops every one of them, and the feature reports a clean file forever. Both were invisible
to the offline tier, which drives the marker code against a reply written by the test: a
stub cannot get its own paths wrong. When a feature converts another tool's coordinates,
the test that matters runs the real tool and slices the source with the numbers that come
out.

### `.venv/bin` ahead of `/bin` is correct, and dangerous

Generating console scripts from installed packages means a project's own tools shadow the
built-ins, which is what a venv is for. But several `/bin` entries here are **seams**, not
conveniences: `pytest` exists to turn pytest's exit code into the process's, `uvicorn` and
`gunicorn` are the socket-free server bridge. `pip install pytest` would have replaced the
seam with a shim that calls `console_main` directly and quietly undone it. Anything that
generates PATH entries from user-controlled metadata needs a reserved list, and that list
needs a test tying it to the real set of seams — otherwise the next seam is added
unprotected and nothing says so.

### `process.exit()` throws, so an async program must not exit through its own catch

The runtime's `process.exit()` throws the event loop's exit sentinel. In a synchronous
program that unwinds and is the end of it; in an `async main().catch(...)` it lands in
that catch, which then reports a successful exit as a crash — every clean `ruff check`
printed `ruff: exit` on stderr and could have exited 1 instead of 0. Any program built as
a promise chain has to carry its status as a value the bottom handler can recognise, or
not use `process.exit()` inside the chain at all. A drive harness that models exit as a
throw finds this; one that records a code and returns does not.

### A fix without an applicability flag is not a fix you can apply

ruff's wasm build reports a fix as a message plus edits, and — unlike the CLI — says
nothing about whether it is *safe*. Applying them anyway is the real tool's
`--unsafe-fixes`, which may change what the code does, under a flag nobody typed. The
second half is worse and easier to miss: several fixes for one file are all computed
against the same original text, so an unused-import deletion and an import-sort rewrite
overlap and shred each other. Applying edits back-to-front does not save you; the real CLI
applies one, re-lints, and repeats. This shipped as "Fixed 4 errors. All checks passed!"
over a file that no longer parsed. When porting a tool's write path, check that the port
exposes what the tool's own safety decision is made from.

### "Not in the index" is a fact about the index, not about the tool

roadmap.md recorded ruff as out of reach because it is a Rust binary that Pyodide does not
distribute. Both halves true, conclusion wrong: it is published compiled to WebAssembly,
which this runtime loads directly, and not being a Python package turned out to be the
best thing about it — a linter outside CPython costs no interpreter boot. Before writing a
capability off because the obvious delivery channel does not carry it, check whether the
thing ships in a form the host can load on its own.

### A tier at each end of a wire is not a tier on the wire — the notebook's kernel transport

The notebook has no server and no new capability behind it. `studio-kernel.ts` opens an
ordinary shell terminal with no xterm attached and types
`python --vv-notebook-kernel /tmp/vv-notebook-kernel.py; exit` into it, because the shell is
the only channel here that can deliver a **signal**: it hands a foreground child's stdin
through verbatim and turns a `\x03` in that stream into `SIGINT`, while `proc-*` has no
`proc-signal` at all (`kernel-worker.ts` routes `proc-kill` to `kernel.stop`, which for a
notebook is a restart wearing the label "interrupt"). The kernel program itself is
`packages/studio/src/vv/notebook/kernel-source.js` — stdlib-only Python, one long-lived
namespace, one request per line — but its read loop is in JS, in `driveNotebook`
(`packages/runtime/builtins/python.js`), because the packages a cell imports can only be
resolved after the cell arrives and fetching a wheel needs an `await` that Python has nowhere
to put here. Answers come back as `\x1e`-framed JSON on a stdout shared with the shell's echo,
through `FrameReader` into `NotebookSession` and `NotebookDoc`.

That is five components and two languages between a click and a value, and the lesson is
about how it was tested. **Three separate "I pressed Run and nothing happened" reports
shipped past a suite that was green at each point**, because the suite was thick at both ENDS
of that wire and had never run a byte down it: `spike-notebook.mjs` drives the kernel program
under the host's own CPython with `spawnSync(python3, [kernel.py], { input })` — no shell, no
launcher, no runtime, no driver; `spike-notebook-view.mjs` renders cells under jsdom — no
kernel; `spike-python-bridge.mjs` execs a cell in real Pyodide from a namespace it builds
itself — no launch string. Every one of the three bugs lived in a gap between two of them.

- **`__file__` exists in only one of the two ways this program runs.** `_traceback()` compared a
  frame's filename against it to drop the kernel's own frames, and it runs while HANDLING a
  user's exception. `python kernel.py` defines the name; `eval_code_async`, which is how the
  driver loads the same source, does not — so in the browser the first cell to raise died of a
  `NameError` inside the error reporter and the notebook showed nothing at all. Invisible to
  the host tier, which runs the file as a file. It is `emit.__code__.co_filename` now: a code
  object knows the name it was compiled under however it was run.
- **The import scan never ran for a cell.** `loadPackagesFromImports` decides what to fetch by
  reading import statements out of source, and a cell's source is a string the kernel `exec`s
  — so the scan read the kernel's own file, which names none of it, and `import pandas` failed
  with the wheel vendored same-origin and unloaded, while the same line in a script worked
  because a script is scanned before it runs. Third time for this class here (`__import__(name)`,
  pandas' deferred `import openpyxl`, now a cell). The fix is not a cleverer scan: what gets
  resolved is **code about to run**, not a file being started, so a script, a reloaded module
  and a cell all go through `resolveImports`.
- **The toolbar's Run hit a markdown cell and returned in silence.** `runSelected` runs
  `doc.selected`, which defaults to the notebook's FIRST cell — markdown in every template we
  ship, including the notebook the Python project opens with. So the most obvious control in
  the feature was inert on every freshly opened notebook. **A control that does nothing and
  says nothing is indistinguishable from a broken backend**: two of the three reports were
  spent chasing a transport that was healthy, and that is paid in the user's trust rather
  than in anyone's debugging time. Any handler that can decline must say that it declined.
- **A FOURTH one was found by review inside the commit that wrote this lesson down**, which is
  the part to take personally. `MIME_ORDER` ranks `image/svg+xml` above `text/html`, `DataView`
  sent it to `sanitizeHtml`, and `svg` is not an allowed tag — correctly, it carries script — so
  an SVG output was stripped to nothing and drew an empty div while the `text/plain` beside it
  went unread. **A green assertion was pinning it**: the suite asserted `svg` must not be
  allowlisted, which is true, and was read as settling what an SVG output DOES. Picking the
  richest representation and rendering it are two decisions and only the first had a gate.
  Note the shape when a fix requires changing an assertion: change it to the right thing, not
  to whatever goes green. `svg` is still banned; the figure goes through an `<img>` and a
  `data:` URL, where the image loader refuses script and external fetches. What closes the
  class is the invariant, not the branch — `chooseRender` walks a bundle richest-first and
  **never returns something it can tell draws nothing**, falling through when a renderer
  produces nothing and naming the MIME types out loud when the bundle runs out. The hedge is
  the honest limit: empty is decidable, blank is not (see the tally below).
- **And the FIFTH was inside that invariant's own gate.** `svgDataUrl("")` returned
  `"data:image/svg+xml;base64,"` — a truthy string with no payload — so an empty figure was
  still accepted as an image and still drew a blank box. `{ "image/svg+xml": "" }` was already
  a row in the gate's table, and the predicate was `if (r.kind === "image") return !r.src`:
  it asked which FIELDS were set, not what a reader would see, so it certified the one
  violation it enumerated. The guard checks the payload now, and the predicate decodes the data
  URL and measures content. **An invariant about what a user sees has to be asserted in terms of
  what a user sees**; a predicate written in the vocabulary of the implementation can only ever
  agree with it. (An earlier version of this bullet credited the neighbouring PNG branch with
  having had the right check all along. Measured, it had no check at all in the original commit
  — the contrast was true only from the commit that introduced the bug it was contrasted with.
  It is the fifth incident under *A count lives in one place, next to the thing it counts*.)
- **A SIXTH, and the first that never reached a renderer at all.** `json.dumps` writes bare
  `NaN` and `Infinity` for out-of-range floats and `JSON.parse` refuses all three, so a frame
  could serialise perfectly in Python and arrive unreadable: the reader's catch filed it in the
  collapsed kernel log, the `done` on the next line landed normally, and the cell went idle
  having shown nothing. Reachable through the ordinary door — `_repr_mimebundle_` passes its
  values through unconverted, and a missing value in a Vega-Lite or Plotly spec is routine. The
  kernel's own `<display failed:>` handler could not catch it, because `dumps` SUCCEEDS; the
  failure is on the far side of the frame boundary, which is why `allow_nan=False` belongs at
  the writer and not at either end. **Two components agreeing on a format is not the same as one
  of them emitting only what the other accepts**, and the difference is invisible from either
  side alone — see *Ask what a policy PERMITS, not only what it forbids*, which is the same
  question one layer down.

So when a feature crosses a process, a language or a worker, one gate has to run the real
string through the real components. `scripts/spike-notebook-transport.mjs` (net tier) is that
gate: the launch string is READ OUT OF `studio-kernel.ts` rather than retyped, the shell,
launcher, runtime, driver, interpreter, kernel, frame protocol, session and document are the
shipped bytes, and the only substitution is the VM — a host `child_process` on an OS pipe
instead of `OP_SPAWN` on a SharedArrayBuffer, with `scripts/lib/notebook-python-child.mjs`
keeping that read **blocking**, because Pyodide's `input()` reads an EAGAIN answered with `""`
as EOF. The first two rounds' bugs are pinned in it, the import one as an explicit
failing-then-passing pair against the launch string it replaced. What is still tab-only,
and why `python-notebook` keeps `experimental: true`: `bridge.post("term-input")` reaching the
kernel worker, `kernel.sendStdin` choosing between a parked sync reader and the flowing
stream, the guest shell forwarding a keystroke over `OP_SPAWN`, and Monaco painting. jsdom is
not a tab.

**A HARNESS MAY NOT STUB THE CAPABILITY THE DESIGN WAS CHOSEN FOR.** The shell was picked over
`proc-*` because only a shell can deliver a signal, and for three rounds no tier delivered one:
the child harness answered `process.on` with `() => proc`, a listener that is never called.
That stub hid a fatal window. A cell's imports are resolved in JS, in an `await` that can take
seconds, and the interrupt buffer was armed only around `handleLine` — so during "Loading
pandas…" nothing was registered, and in the VM **a guest with no registered SIGINT handler is
terminated rather than signalled** (`packages/runtime/signals.js`; the shell's `\x03` becomes
`kill`). Pressing stop on a download destroyed the interpreter and every name in it. What came
out of fixing it generalises:

- The harness now MODELS the kernel's rule instead of stubbing it — no handler means exit,
  a handler means the interrupt byte plus a delivery on a loop turn, and the guest's
  `signalHandled` stand-down is printed so a spike can assert the promise that keeps a real
  kernel alive. `deferInterrupts` in `python.js` holds the signal across the fetch, clears the
  byte so it cannot land inside Pyodide's own loader Python, and re-delivers it to the cell.
- **A request is the unit an interrupt belongs to.** CPython raises on whichever bytecode it is
  running when it next reads the byte, and measurement — not reasoning — showed that bytecode
  was the kernel's own `emit` of a busy frame, and then, once that was guarded, `json.loads` of
  the request line (`except Exception` does not catch `KeyboardInterrupt`). Both escapes killed
  the kernel. Guarding landing sites one at a time is a losing game: `handle_line` wraps the
  whole request and reports the cell's `KeyboardInterrupt`. But a `try` covers only the code it
  encloses — its own function-entry check and its own `except` clause are still outside — so the
  guarantee is made total one level out, where it costs nothing to be total: `driveNotebook`'s
  `catch` runs for EVERY escape, and asking `terminationFromError` what was raised closes every
  landing site at once, including the ones nobody has been able to settle by reading. **When you
  cannot predict where a failure will surface, catch it where everything surfaces and identify
  it by what it is.** The half a single host thread still cannot reproduce is a byte written by
  another thread while the interpreter is inside a cell.
- **A design that accepts duplicates owes the reader a rule for recognising one.** Two reporters
  for one request is the price of the paragraph above, knowingly paid, and the bill arrived at
  the other end of the wire. The session's `done` was unconditional, and handling a `done`
  dispatches the next cell SYNCHRONOUSLY — so a second report of the same interrupt put its
  error under the cell that had just started, marked that cell finished while the interpreter
  was still running it, and freed a third to be sent to a busy kernel. Nothing said any of this
  had happened; the model of which cell is running was simply wrong from then on, which is worse
  than the reported death the belt was added to prevent. The frames already carried the id, so
  the fix is one condition — a frame naming a cell other than the one running is dropped and
  logged — and it closes duplicates and late frames together rather than this one instance. When
  a design decides that a message may arrive twice, the receiver needs identity, not an
  assumption about order.
- **A model is a claim about someone else's code, so it needs a gate of its own.** A rebase onto
  a shell rewrite hung this tier: `sh` had begun saying `stdio: ['inherit', …]` for its
  foreground job, and that word means literal fd inheritance on host Node and a question about
  `isTTY` in the VM. So `child.stdin` was `null` on one side and a writable on the other, the
  shell's forwarding threw into its own `catch`, and every byte was dropped in silence. The
  product was never affected — nothing but that forwarding carries terminal bytes to a child
  there — but note what the tier had actually been asserting for months. Its substitutions were
  written down as the channel, the SharedArrayBuffer, the worker seam; the one that moved was a
  **word the host and the VM had always happened to agree about**, which nobody had listed
  because agreement is invisible. A model does not announce that it has stopped matching, and a
  hang is the lucky version: had the two meanings diverged in a direction that still delivered
  most bytes, the tier stays green and stops meaning anything. So the model now carries a gate
  that tests neither the notebook nor the shell — it measures both meanings of the word and goes
  red when they part company, which is the only moment worth checking. **Whatever your harness
  substitutes, assert the substitution, not just the thing it stands in for.**

### A new gate is not evidence until it has been run against the bug

Six gates written in the MR above were **green against the build they were added to fail
against**, and one of them was inside the fix for another. Each was written by someone who had
just finished understanding the bug, which is exactly when a plausible-looking assertion is
easiest to write and hardest to doubt. Two of the six were not written to fail against a
specific build at all, and that turns out to be the distinction the rest of this section rests
on, so it is drawn where it applies rather than assumed here.

So the last step of a fix is not "the suite is green". It is **stash the fix, run the new gate,
watch it fail, put the fix back** — and if it does not fail, the gate is testing something else
and the bug is still unguarded. Cheap here because production code lives in plain `.js` and
`.py` that a spike drives directly: `git show <base>:<file> > <file>`, run, restore. A minute a
gate, and it is worth reading the failure rather than just seeing red: the message names which
rows failed, and a gate that goes red for the wrong reason is the next version of this problem.

**The tally, because the procedure has to be argued for out of what happened rather than out of
the tidier version of it.** Three of the six were caught by running the gate; three were caught
by a reviewer, each after the gate had landed and been offered as evidence.

- Caught by running it: the first `<style>` gate, which used the shape the HTML parser hoists
  into `<head>` and so exercised the safe placement. The never-draws-nothing predicate's
  whitespace row, which passed because `"  \n"` encodes to eight perfectly good base64
  characters. And the transport tier's ordering assertion, where `indexOf` answers `-1` for a
  string that is not there and `-1 < anything` is true, so the obvious spelling of "reports the
  interrupt before it reports a death" passes with the whole belt deleted.
- Caught by review: the assertion that `svg` must not be allowlisted, which was true and was
  read as settling what an SVG output does. The never-draws-nothing predicate itself, which
  tested `!r.src` — the presence of a URL — against a table that already contained the
  empty-payload row. And, in the round that wrote this section, one of the five assertions
  covering the duplicate-frame guard: "the cell it belongs to says it once" stays green without
  the guard, because the misattributed error lands on the NEXT cell, so the first still has
  exactly one. Four of those five are red; that one is green for a reason other than the one
  intended, which the run reported and the author did not read.

The split is the argument, and the last member is the one that says what the procedure is
actually worth. **The procedure was run for it.** Not skipped, not intended — the fix was
stashed, the gate was run, the run went red, and the report claimed five red assertions where
four were red and the fifth was green for a reason nobody looked at. So this is not a sixth
case of not doing the step. It is the case that says doing the step is not the whole of it:
**a gate that goes green in a red run is the same problem as a gate that never goes red.** Read
the failures per assertion and count them; a colour is not a reading.

**Two of** the three the procedure did not catch were written to *characterise* something rather
than to fail against a specific broken build, and they are the ones that reached a reviewer
wearing a green tick. A gate that has never been red is a comment with a green tick next to it.

### A harness that BUILDS the code differently is not a harness for that code

The round above ends with a view tier that mounts the shipped component, drives it under
`<StrictMode>` because that is what the studio renders under, imports the real store and the
real sanitiser, and stubs only leaves. It was written carefully and it was still testing a
program this repo does not serve, because **it bundled the component with esbuild and the
studio bundles it through the React Compiler** (`packages/studio/vite.config.ts`). The compiler
memoises on identity; `NotebookDoc` mutates in place and bumps a version. So in the browser the
notebook never repainted — press Run, nothing appears, switch tabs and back and the output is
there — while a dozen assertions in the view tier said "printed output reaches the page", and
had said so through every review of the commit that introduced them.

The tell was that every link read correct. The store notified, the subscription was live, the
document had the data, and there is no `React.memo` in the file. When every line you can read
is right and the behaviour is wrong, **stop reading the source and read what is served**: the
memo caches and their dependency lists are in the compiler's output, and the bug was written
out in it in two `if ($[n] !== …)` lines.

The general form, and it is not about React. A harness substitutes an environment, and the list
of substitutions everyone checks is the interesting ones — the transport, the worker, the VM.
The build is not on that list, because a build is supposed to preserve meaning. Optimising
compilers preserve meaning **only for code that honours their assumptions**, and a mutable
store shared with a compiler that assumes immutability does not. So: whatever transforms the
shipped artefact — a compiler plugin, a minifier's property mangling, a bundler's tree shaking,
`NODE_ENV` — either runs in the harness too, or is written down as a substitution and asserted,
the same as any other. This one is now both: the view spike runs the plugin, and it asserts the
bundle came out carrying memo caches, because a plugin that silently stops applying puts the
tier straight back where it was.

Note also what it cost to notice. Two of that round's four defects were inside jsdom's reach
the whole time and were found by a user in a tab, which is the same shape as the entry above —
a suite thick at both ends of something and never run down the middle. There the middle was a
wire. Here it was the toolchain.

The list above is the ONE enumeration of these six. Anywhere else that reasons about them —
`roadmap.md` does — names this list rather than restating it, for the reason in the next
section, which this tally is the worked example of.

**And they are all in the same half of the feature, which is the most useful thing the list
says.** Every one is in the part that is modelled or reasoned about — a sanitiser policy, a
render decision, a predicate over a table, a session's bookkeeping — and not one is in the part
a real interpreter executes. That is not luck. A model agrees with the reasoning that built it,
so a gate written against a model can only disagree with its author by accident, while a gate
that runs Python either produces the value or does not. It says which claim about this feature
to distrust, and it is not a claim about the code: **it is the claim that the transport works.**
Every tier substitutes the channel — a host pipe for `OP_SPAWN` on a SharedArrayBuffer — and the
substitution sits exactly where the design's difficulty is: the synchronous syscall,
`Atomics.wait`, the worker seam, `\x03` → SIGINT → `Py_EmscriptenSignalBuffer`. "The transport
tier is green" means the framing, the launch string and the read loop are right *about a channel
that behaves as described*. Nothing here has yet been wrong about the interpreter.

**Where an invariant can honestly stop.** The one those gates guard is that `chooseRender`
never returns something *it can tell* draws nothing, and the hedge is load-bearing. Emptiness
is decidable — no bytes, no text, no elements — and it is what shipped both of the blank boxes
above: the stripped SVG and the empty payload.
Blankness is not: `{"image/svg+xml": "<svg/>"}` is a well-formed document that paints nothing,
and knowing that requires laying it out, which nothing outside a browser can do. So the code
stops at the decidable line, correctly, and the invariant should be stated at that line too.
Note also that the spike's predicate is *stricter* than the implementation — it scores
`<div></div>` as blank — so what holds the table green is the rows it chooses, not agreement
between the two. Read that as a limit on the table rather than as slack.

### Ask what a policy PERMITS, not only what it forbids

An allowlist is reviewed by attacking it: pick a thing it refuses, find a way to smuggle that
thing past. Both holes found that way in the notebook's HTML policy were real (`<style>`'s
raw-text content, `<template>`'s unwalkable fragment), and the habit is worth keeping. But it
can only ever find things the policy already has an opinion about, and twelve review passes over
that file did not turn up the third hole, which was sitting in what the policy plainly allowed:
the `style` attribute, refused for `url(` and otherwise waved through, is enough to cover the
whole IDE with a fake sign-in panel. **The policy modelled execution and egress and had no
category for layout** — so no amount of asking "can I get a script through" was going to reach
it, because painting is not script.

The question that does reach it is *what can a document do with exactly what I allow?* Run it
against each permitted thing in turn and describe the worst honest use of it, in the vocabulary
of the reader rather than of the check. The incident and the fix are in `roadmap.md`; the part
that generalises is that a policy has categories it has never named, and the ones it has never
named are not on the list you are reviewing.

Related, and the reason the fix was containment rather than another refusal: **when the answer
is a denylist of names, the category is usually the wrong size.** Refusing `position` and
`z-index` would have missed `transform`, sticky positioning and negative margins, all measured
in minutes, and would have been a regex over CSS text disagreeing with the renderer — the way
sanitisers are always defeated. Bounding the whole category with `contain: layout paint` costs
nothing for the case the attribute exists for and does not need a list to be complete.

### A count lives in one place, next to the thing it counts

Five separate corrections in that one MR were the same defect in prose, and none of them was a
typo. In order: an attribution inverted (two catches credited to a procedure that made one);
"four" written directly above a list of five; a count expanded from five to six that left a
generalisation standing over three cases when it had only ever been true of two; a count
corrected from four to five in one sentence, leaving its twin eight lines below in the same
docblock still saying "those four"; and a claim that a neighbouring branch had "the right check
the whole time", true of a later commit — the guard and the bug had arrived together — and
never true of the one it was written about, which is what the measurement behind the fourth
correction established.

Every one has the same shape: **the claim lived in more than one sentence and only one copy was
maintained.** Three clauses cover all five.

1. **A count lives in exactly one place, next to the enumeration it counts.** Every sentence
   outside that place names the enumeration instead of repeating the number. This is what makes
   "four" over a list of five impossible to write, a stale twin impossible to leave, and an
   attribution checkable — there is one list to check it against, and it is the list the reader
   is already looking at.
2. **Prefer naming the members to counting them, unless the number is doing work.** A name
   cannot go stale without the thing it names changing; a number goes stale from a distance. "It
   shipped both of the boxes above: the stripped SVG and the empty payload" survives a
   recount that "it shipped four blank boxes" does not. When a number IS doing work — the flat
   rate of one bad gate per review pass is an argument, and it needs the rate — keep it and put
   it next to its enumeration, per clause 1. When it is not, delete it: a `FrameReader` entry
   here said "this MR has now had five review passes" in a sentence arguing that a one-word fix
   deserves its own review, which is equally true at one pass or at ten. It now says "several
   review passes deep **on other subjects**", which is both unfalsifiable-by-time and the thing
   the number never said — the *reason* such a fix rides in on an unrelated approval.
3. **When a count changes, grep the number AND go looking for whatever else the correction
   invalidated, wherever it lives.** The fifth incident is what the missing half looks like:
   correcting the count required measuring the original commit, and that measurement retired a
   claim written down in two places — one of them a hundred-odd lines from the count in the same
   file, the other in a different file entirely, and the write-up of the measurement in a third
   place again. Both copies survived, because neither contained a digit and no search for the
   number would ever have surfaced either. A count is usually load-bearing for prose that never
   mentions it, and that prose is not nearby — "re-read the surrounding text" was tried twice
   here and is exactly the check that missed both times. Search for the claim, not for the
   paragraph you are standing in. What to type, since this MR answered that twice without
   writing it down: **grep the retracted fact's own idiom, repo-wide.** A restated fact reuses
   its own phrasing, so "whole time", "all along", "had that check", "known to be necessary"
   found the surviving copy in the other file in seconds, where two rounds of reading nearby
   had not. The wording is the handle; the number never was.

**And "one place" is about where the restatements live, not about how many there are.** The
section above says "six" in several sentences, which is fine: they sit inside the one section,
beside the enumeration, where a recount edits them together and a reader sees the list they
refer to. The rule is broken by a restatement in another file, not by a digit appearing twice
on a screen. Worth stating, because the obvious verification — grep the number, count the hits
— answers a different question than the one the rule asks: run that way, this material was
reported as "the count appears exactly once" while `six` was on six lines of these two sections
at `9cdb7e8`, and the rule was satisfied anyway. **Make the check match the claim**, which is
clause 3 one level up.

That figure needs its own check named, which is the joke and also the point. Its scope is this
section plus *A new gate is not evidence until it has been run against the bug* directly above,
which is where the tally and every restatement of it live. Six is `rg -ci six` over those two;
`rg -ci '\bsix\b'` says five, because one of the six lines says "sixth". Neither is wrong and
they answer different questions, so a count is only checkable when the command that produced it
is written beside it — and a count reported without one is a number
somebody will re-derive differently and then have an argument about. Run either command against
HEAD and it answers higher, because these two paragraphs are about the word and keep saying it;
that is why the figure is pinned to a commit rather than to "now". A count with a command and a
revision beside it is the only kind a reader can check without trusting whoever wrote it. The
first draft of this paragraph asserted how much higher, and writing the sentence made it wrong.

The blank-box COUNT was single-homed under this rule and has needed no correction since; the
gate tally in the section above was not, and produced two more findings before it was.

And then the fifth incident corrected itself once more, which is the strongest thing in this
section. Its diagnosis is that the claim lived in more than one sentence and only one copy was
maintained — and the commit that wrote that sentence maintained one copy. The other was in
`roadmap.md`, where the same retracted fact had been *spent*: two branches side by side, one of
them proof that the check was known to be necessary, an inference with nothing under it once
the fact went. A correction is an edit to a claim, not to a paragraph, and a claim does not
live where you happen to be reading. **Do not trust a rule's section to have applied the rule
to itself**; this one demonstrably did not, twice, and it is more useful for saying so than it
would be with a clean record.

### A handle's close callback is a loop PHASE, not a nextTick

When a binding hands lib/net.js a `close(cb)`, `cb` must not run on the tick queue.
libuv runs it in the close phase, and `Socket.prototype._destroy` is written against
that: it calls `handle.close(cb2)` — where `cb2` emits `close` — and then `cb(exception)`
synchronously, leaving the stream to emit `error` on a tick of its own. Ours scheduled
`cb2` with `process.nextTick`, which queued it *ahead* of that tick, so every failed
socket emitted `close` and then `error`, backwards from the rest of Node.

What makes this worth remembering is where it surfaced. `net.connect` to a dead port
looked perfect, because the test listens for both events and only reads `e.code`. The
only caller that could not survive the inversion was lib/http.js, two layers up:
`socketCloseListener` reads a close with no error recorded as the server hanging up, so
a refused request emitted **two** `error` events — `ECONNRESET: socket hang up`, then the
real `ECONNREFUSED` a phase later. CI failed on the http check, and the bug was in the
TCP binding's close.

So when a check fails in a vendored Node lib, suspect the ORDER of what the binding
under it emits, not just the values. Assert order explicitly — `deepStrictEqual` on an
array of event names — and assert how many times `error` fires; both facts are invisible
to a test that resolves on the first event it likes.

## Testing & verification

The runtime runs headless under Node `worker_threads`, so validate without a
browser first.

**Reading `process.env` inside a Process Worker after boot reads the GUEST's env.**
`bootProcess` replaces `globalThis.process` with the guest's, whose env is only the
spec's (`HOME`/`PATH`/`PWD`). A `process.env.VV_*` check in `onReady` or in a message
handler therefore reads the wrong object and the flag looks unset, with no error —
this silently disabled three test seams in a row before it was spotted. Snapshot the
real env at module load (`const HOST_ENV = { ...process.env }` in
`scripts/process-worker.mjs`), while `process` is still Node's.

### First: build the Wasm, or nothing runs (and the errors will lie to you)

The repo ships **no built Wasm** (`pkg/`, `pkg-node/` are gitignored), so on a fresh
clone `verify`/`spikes` cannot boot. The full recipe, including two steps that have
cost multiple sessions:

1. **Node 22+** (`engines.node`). Under Node 20 the runtime fails in ways that look
   like hangs rather than errors, so check `node -v` before believing any hang.
2. `rustup` + `cargo install wasm-pack --locked`, and `rustup target add wasm32-wasip1`
   if you plan to run `npm run verify` (it needs `build:wasi-demo`).
3. `npm run build:vfs:node && npm run build:codec:node && npm run build:crypto:node`.
   `crypto` is the slow one — `wasm-opt` can take several minutes, and wasm-pack writes
   its `package.json` **last**, so a missing `pkg-node/package.json` usually means
   "still building", not "wasm-pack didn't emit one".
4. **Add `"type": "commonjs"` to each `pkg-node/package.json` afterwards.** wasm-pack
   emits CommonJS for `--target nodejs` but no `type` field, so the repo root's
   `"type": "module"` makes Node parse it as ESM. The failure is far from the cause:
   you get `exports is not defined in ES module scope`, surfacing as a bogus
   `npm error code FETCH_ERROR … Invalid response body while trying to fetch
   <registry url>` on the first packument of a spike. Do NOT hand-write these files
   either — wasm-pack MERGES into an existing `package.json`, so a hand-written one
   comes back mangled (its keys nested under `dependencies`) on the next build.
5. If a Bun crypto spike fails on hashes/argon2id/bcrypt, your `crypto` Wasm is stale
   relative to `packages/crypto/src` — rebuild it before debugging anything else.
6. **The `:node` builds do not update the browser's Wasm.** `pkg-node/` is what the
   spikes load; `pkg/` is what the Studio loads, and each Rust crate needs both
   (`npm run build:crypto` alongside `build:crypto:node`, or `npm run build` for all
   of them). Skip the browser half after touching Rust and the two tiers disagree:
   every spike passes while the browser throws a stale-capability error naming the
   thing you just added — `unsupported digest 'blake2b256'`, with a Wasm stack — which
   reads like a code bug and is not one. Suspect the artifact before the source
   whenever the browser alone rejects a capability the Node tier exercises happily.

- `npm run verify` — `scripts/verify-node.mjs`, headless end-to-end (fs, process,
  shell, http, timers, watch, worker_threads incl. `receiveMessageOnPort`). **Run
  this after any runtime/protocol change.** No network needed.
- `npm run probe:node-registry` — `scripts/probe-node-registry.mjs`, static: asserts
  every builtin id, `internalBinding` namespace and primordial name that `lib/` +
  `internal/` reference actually resolves. Catches the lazy-`require` miss that
  imports cleanly and throws only on first use.   **Run after touching `loader.js`,
  `primordials.js` or `internal-binding.js`.** No Wasm build, no browser, no network.
- `npm run probe:http-egress` — `scripts/probe-http-egress.mjs`: the
  loopback-vs-egress routing table (each destination cross-checked against a real
  `net.connect()`), an in-VM server served over the real net path with the fetcher
  asserted untouched, and the request/`IncomingMessage` translation over a stubbed
  `__ocfetch`. **Run after touching `bindings/net.js`, `internal/http-egress.js`,
  `internal/fetch-transport.js` or `lib/https.js`.** No Wasm build, no browser, no
  network.
- `npm run spikes` (`scripts/run-spikes.mjs`) — the CI runner over the per-template/
  subsystem spikes. Tiers: `npm run spikes:offline` (Wasm-free, seconds — e.g. the
  `spike-toolchain.mjs` subsystem guard), `npm run spikes:net` (installs real
  templates from the registry; auto-vendors npm to `/tmp/vv-vendor`). Wired into
  `.gitlab-ci.yml`. **A template must have a green spike before it graduates out of
  `experimental`** — add `spike-<name>.mjs` (use `lib/spike-harness.mjs`) and list it
  in `run-spikes.mjs`.
  **An ok-flag must start `false`, or a skipped gate must be reported as a skip.**
  Spikes written to be hand-run put the expensive assertion behind an env flag and
  initialise its flag to `true`, so skipping it does not skip — it passes, and the
  runner only prints a spike's stdout when it fails, so the `(gate skipped)` line
  never reaches the log. That is how `pm-gate` shipped reporting the package
  managers healthy while doing nothing but `npm --version`. If a spike has such a
  flag, the tier turns it on: registry entries take an `env`, and owning the policy
  there beats flipping defaults in each spike.
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

### The guest shares a `globalThis` with the host, so check what leaks

The Process Worker's global object belongs to the page as much as to the guest. The runtime
replaces `fetch`, `WebSocket` and the timers for that reason, but the list was never exhaustive:
`Worker` sat there untouched for as long as it existed, so guest code calling
`new Worker("./w.ts")` got the browser's constructor and resolved the path against the Studio's
origin instead of the VFS. It did not throw. It produced a worker with no kernel.

Two things to take from it. First, when adding a global, ask what the host already put under
that name. Second, **no Node-tier spike can catch this class of bug**, because Node's worker has
no such global to leak — the same blind spot that hid Vite's HMR timer for so long. The way to
test it is to assert what the GUEST sees (`typeof Worker` from inside a guest program), and, if
you want the browser's side of it, to plant a sentinel on `globalThis` before boot and check the
guest gets yours rather than the sentinel.

`Worker` was one name found by hand, and hand-searching does not scale: a Chrome 143
DedicatedWorkerGlobalScope has 367 names, of which **228 exist in neither node nor bun**. Among
them are `importScripts`, the origin's IndexedDB / Cache Storage / OPFS, `XMLHttpRequest` and
`EventSource` (egress that never passes the Fetcher Worker, so no rewrite and no cookie jar),
`USB`/`HID`/`Serial`, and `close()`. `packages/runtime/realm.js` now sweeps the lot against a
recorded list of what a real node has, immediately before the entry module runs. Three rules
come out of building it:

- **Shadow, never `delete`.** 35 of those names live on the prototype chain, where
  `delete globalThis.x` removes nothing and returns true, and 17 of them are accessors, where
  assigning `undefined` throws. An own, writable, non-enumerable data property is the only form
  that works for all of them. It also leaves the original in place for the runtime, which is
  what makes the next point possible.
- **The kernel's channel is the guest's too, in BOTH directions.** `self.onmessage` in
  `process-worker.ts` is the kernel's link to this process, and a guest
  `addEventListener("message")` reads every stdin chunk, fetch result and signal on it.
  Shadowing the name fixes it precisely because shadowing is not removal: verified in a real
  Chrome worker, a message after the sweep still reached the ORIGINAL handler, while a guest's
  assignment to `onmessage` landed in the shadow property and was never called.
- **Allowlist, not denylist.** The sweep keeps what a real node has (recorded by
  `scripts/record-realm-globals.mjs`) and hides everything else, so a global Chrome ships next
  year is hidden by default rather than leaking until someone notices.

Testing it needs the same trick as `Worker`, scaled up: `scripts/process-worker.mjs` plants a
browser-shaped realm under `VV_PLANT_BROWSER_REALM` — own AND inherited names, accessors
included — before importing the runtime, and `scripts/spike-bun.mjs` asserts from inside a
running guest that none of them survived. `scripts/spike-realm.mjs` rebuilds the whole recorded
worker global offline and sweeps that. Plant before the import: the capture of "what was here
before us" happens at the runtime's module load, so anything planted later looks like ours.

### A `message` listener keeps a worker alive — wire it lazily

Both Bun and Node document that attaching a `message` listener on a port holds the thread's
event loop open; that is the mechanism by which a worker stays up to serve requests. So a shim
that attaches one eagerly to implement `onmessage` makes every worker immortal, and every parent
waiting on one hangs with it. `builtins/bun-worker.js` wires the `parentPort` listener on the
first use of `onmessage` or `addEventListener("message")`. If you touch that file, do not
"simplify" it back.

**The same rule governs a `Bun.spawn({ipc})` child, and the binary confirms it from the other
side.** The very first probe written against the real `bun` hung for twenty seconds, and the probe
was correct: a child holding `process.on("message")` stays up until somebody disconnects, while a
child that never attaches one exits the moment its script ends. So the child's channel socket in
`packages/runtime/index.js` is `unref()`d as soon as it connects and `ref()`d on the FIRST
`message` listener (counted via `newListener`/`removeListener`, the same way the fork path does
it). Wire it the obvious way instead and every ipc child becomes immortal — and its parent, which
is almost always sitting in `await proc.exited`, hangs behind it. The parent's listening server is
`unref()`d for the mirror-image reason: the child already refs the parent's loop for as long as it
runs, so the channel must not be a second, longer-lived reason to stay up.

### One socket write is one `data` event here — so the kernel tier cannot catch a framing bug

A `net.Socket` is a byte stream, and its contract allows the runtime to split one `write()` across
several `data` events or to coalesce several writes into one. **This VM does neither.** Each write
becomes one `pipe-data` message, the kernel relays it verbatim, and `bindings/net.js` hands the
reader exactly one chunk — so a 1:1 relationship holds that nothing has promised.

That was measured the expensive way. The `Bun.spawn({ipc})` framing was deleted on purpose — no
length prefix, every chunk treated as a whole message — and `scripts/spike-bun.mjs` stayed
completely green, including 200 messages sent in one tick and a 400 KB payload. A kernel-tier spike
cannot distinguish a framed stream from an unframed one.

Two things follow. **Do not delete framing because a spike passes without it**: the guarantee is
the transport's current implementation, not the API's contract, and anything that later makes the
relay chunk (the SAB path already chunks at 1 MiB) breaks every unframed reader at once. And when
you write something that parses a stream, **pin it where the stream can misbehave** — keep the
parser pure and feed it the splits and coalesces directly, as `scripts/spike-bun-offline.mjs` does
for `FrameReader` (five frames in one chunk, one frame across forty thousand chunks, a length
prefix split down the middle). That block fails on its first assertion with the framing reverted;
the kernel one does not fail at all.

### `process.on('uncaughtException')` never fires in a guest

Measured, not inferred: a guest that registers the handler and then throws — synchronously or
from a timer — never sees it called. The handlers in `packages/runtime/index.js` are on the
HOST realm's process (they exist to catch the exit sentinel), and nothing dispatches the guest's.
An async throw does not even produce a non-zero exit code. Anything built on that hook is dead
code; a crash relay for `Worker` was written on it before this was noticed. Fixing it properly is
an open item.

### Base64 tails: flipping the last character may change nothing

A test that "tampers" with a base64 token by changing its final character can be a no-op. Only
the bits the payload actually needs are significant, and the tail character's low bits are often
surplus, so several distinct characters decode to identical bytes — the CSRF spike failed that
way about a quarter of the time, on an assertion ostensibly about the MAC.

Decode, flip a byte, re-encode — and then assert the tamper LANDED
(`!Buffer.from(tampered, "base64url").equals(raw)`), which is what
`scripts/spike-bun-offline.mjs` now does. Without that second assertion the check can still pass
for the wrong reason: a tamper that quietly did nothing looks exactly like a MAC that quietly
accepted it.

### A failing guest must FAIL: exit codes, not stack traces

Two bugs lived here for as long as the loop did, and both were invisible to anyone reading
stderr, because the stack was always printed correctly:

- an uncaught error in a callback exited **0**, so a test or build command that died reported
  success;
- an unhandled rejection **hung for ever**, because it escaped to the host realm whose handler
  rethrew it, leaving the guest idle and the kernel waiting for an exit.

`packages/runtime/loop.js` now implements Node's contract in `raise`/`raiseRejection`, and the
host-realm hooks in `index.js` route into it instead of rethrowing. The contract is not "always
exit": if the guest registered `uncaughtException`/`unhandledRejection`, it is emitted and the
process KEEPS RUNNING; with no hook, print and exit 1. The `process.exit()` sentinel shares that
path and must keep meaning "exit with this code" — `scripts/spike-fatal-errors.mjs` pins it,
because that is the easiest thing to break here.

**When testing this class of bug, assert the exit code.** Every one of these produced perfect
stderr output. A spike that greps a stack passes against all of them.

### The kernel is a trust boundary: never let a guest field throw inside it

`Bun.spawn()` with no arguments sent `undefined` as the command, `resolveProgram` called
`.includes()` on it, and the TypeError escaped through the kernel's message handler. In a browser
that costs the whole VM — every process, the VFS session, the preview — because one guest script
had a typo. `serviceSyscall` now wraps the entire dispatch and converts an unanticipated failure
into an errno for the caller.

Two things that are easy to get wrong if you touch it:

- **Release the caller, always.** The guest is parked in `Atomics.wait` on its own SAB. A handler
  that dies without answering leaves that process hung for ever, so the guard responds — but only
  when `I_STATE` is still `STATE_REQUEST`, since a handler may have answered and *then* thrown,
  and a second write would be read as the answer to the guest's next syscall.
- **Cover rejections, not just throws.** `handleSpawn`, `handleSpawnAsync` and `handleFetch` are
  async, so a failure after their first `await` is a rejected promise that a `try`/`catch` around
  the call cannot see. That is precisely how the spawn crash arrived. `dispatchSyscall` returns
  their promises so the guard can attach to them.

### Before shimming a Bun API, run the real one

A `bun` binary is one download away and settles in seconds what the docs and the
published types leave open:

```bash
curl -fsSL https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64.zip -o /tmp/bun.zip
cd /tmp && unzip -q bun.zip && ./bun-linux-x64/bun run probe.ts
```

Check `bun --version` first — some environments already have one on `PATH`, and the
download is the fallback, not the ritual.

`npm pack bun-types` is the companion for exact signatures. Neither is a substitute for
the other, and the gap between them is where the bugs live: the types for the
per-algorithm hashers declare no lifecycle at all, while the binary shows the instance
is **consumed** by `digest()` — the opposite of `CryptoHasher`, which resets. Shipping
the reasonable guess would have made reuse work here and throw on the first real `bun`
run, and nothing in this repo could have caught it.

Two habits that come out of that:

- **Probe the edges, not the happy path.** What does it do with a `Blob`, with a number,
  with a short output buffer, after being used once, with a bad encoding name? That is
  where a shim diverges, and the error STRINGS are part of the API — someone will
  search for them.
- **When the sandbox cannot match Bun, be stricter, never looser.** Refusing something
  Bun allows costs a user a workaround; allowing something Bun refuses costs them a
  green test suite and a red CI. `Bun.file()` hashing is the current example: Bun
  refuses it, so this does too, with Bun's own words.
### The kernel has a second door, and it is wider: `postMessage`, not syscalls

Syscalls are not the only way in. A Process Worker also posts messages to a handler *table*
(`info.on`), and in a browser `globalThis.postMessage` inside that worker posts **straight to the
kernel** — so guest code could aim any entry in that table at a payload of its choosing. Fuzzing
the nine handlers with `undefined`, `{}`, `7` and friends, five of them threw (`thread-spawn` on a
bare `{}`), and neither dispatch — browser worker or Node harness — had a guard, so the throw
escaped into `onmessage` and ended the VM. Both halves are now closed:

- **Validate, then drop.** Every handler reached from that table starts with a shape check and
  ignores a message it cannot act on. Unlike a syscall there is nobody parked on a reply, so
  silence is the correct answer — the thing you must not do is answer with an exception.
- **Guard the dispatch anyway**, in `kernel-worker.ts` *and* `scripts/lib/spike-harness.mjs`. The
  per-handler checks are the fix; the guard is what keeps the next handler's oversight cheap.
- **Take the capability away too.** `packages/runtime/index.js` removes `postMessage` from the
  guest's global next to `Worker`. That means the worker shell must capture its own reference
  first (`const toKernel = self.postMessage.bind(self)` in `process-worker.ts`) — read the property
  lazily and the removal silently kills every stdout byte, exit code and syscall wake the process
  sends.

Two traps worth knowing before you touch this:

- **Nothing in the Node tier proves the removal by itself**, because a Node worker has no global
  `postMessage` to begin with — the same blind spot that hid the `Worker` leak, and an assertion
  that "a guest sees none" passes with the fix reverted. `scripts/process-worker.mjs` therefore
  plants one under `VV_PLANT_KERNEL_MAILBOX` so the spike has something to watch get removed.
  Always check a new guard fails with its fix reverted; two of these did not, at first.
- **Do not "shadow" it with a throwing stub.** `packages/runtime/node/vendor/napi-wasm-runtime.js`
  picks a transport with `typeof postMessage === "function"`, so a stub would be *selected* —
  worse than absent. `undefined` is also the faithful value for a node guest: no such global
  exists in Node. That vendored runtime only consults the global when it is instantiated with
  `childThread`, which `packages/runtime/node/loader.js` never does, and otherwise prefers
  `worker_threads.parentPort`, so emptying the name costs the napi/wasm addons nothing.
  A **bun** guest is the exception and gets a real function back (`installBunRealm` in
  `packages/runtime/realm.js`), because Bun's main thread has one — inert, bound to nothing,
  returning `undefined`, which is what Bun's does.
## "It cannot be done" is usually a fact about the mechanism you tried

Two of the Python refusals in `roadmap.md` were argued carefully, held for months, and were wrong
in the same way. `ruff` was written off because it is Rust and not in Pyodide's index — both true,
and irrelevant, because it ships as WebAssembly that this runtime can load directly. `input()` was
written off because a keystroke arrives as a postMessage and receiving one needs a loop turn that
CPython's read does not allow — also true, also irrelevant, because blocking on shared memory is
what every `fs` call here already does and stdin simply had no opcode.

Both refusals were correct about the mechanism in front of them and drew a conclusion about the
capability. When you are about to write "X is impossible here", check that the sentence names the
capability and not the one route you tried to reach it by.

Two smaller ones from the same batch, both worth knowing before you touch these files:

- **A cache that ships to a browser must be made where it is restored.** Pyodide snapshots are
  bytes of linear memory plus JS references, and a snapshot made in Node and restored in a browser
  is a claim no test here can check. Making it at runtime, in the same environment, costs one slow
  boot per session and is provable — the cross-realm part is tested with worker_threads, which is
  the same boundary two Web Workers have.
- **When a feature adds a second reader of something there was one of, the old reader is part of
  the change.** The blocking stdin syscall worked on the first try; what it broke was the REPL,
  which had been reading the flowing stream perfectly happily until an `input()` at a `>>>` prompt
  could take stdin away from it.
- **Moving a reader moves it out from under whatever was quietly serving it.** The same move cost
  the REPL its echo, and it took a user session to notice: nothing the person typed appeared, so
  the only thing on screen was the output of the `print()` calls they were typing blind. Nothing
  in this system echoes on a program's behalf — xterm does not, `process.stdin.setRawMode` only
  records the mode, and `sh` echoes what *it* reads and forwards raw bytes to a foreground child
  deliberately. Ask what the layer you are leaving was doing for you besides the thing you came
  for.
- **The layer that is easiest to echo from is the one that leaks the password.** Echoing inside
  `installStdin` — the interpreter's own stdin callback — would have covered `input()` too, and
  `getpass()` could not have switched it off: Emscripten's tty answers `tcgetattr` with ECHO
  already clear and accepts a `tcsetattr` it ignores, so getpass prints none of its "cannot
  control the terminal" warnings and reads the password onto the screen. Both facts were measured
  against the real interpreter before the layer was chosen. Echo therefore sits in the REPL loop,
  which knows its line is source meant to be seen, and `input()` echo stays an open gap.
- **A `SystemExit` that CPython re-raises is a message to the loop above it.**
  `code.InteractiveInterpreter.runcode` re-raises it instead of reporting it *because* the driving
  loop is supposed to end the session; a `catch` that treats every exception as printable text
  turns `exit()` into a traceback plus another prompt. When you find yourself parsing one, check
  whether the file already has a parser — `terminationFromError` did, and now reports which of
  `exit`/`interrupt`/`error` it found so the REPL can act without a second copy of the rules.
- **A skip-list entry is a recorded reason, not a rule.** `python` was excluded from debug targets
  because instrumenting a Node shim debugs the shim. Deleting the entry to add Python debugging
  would have done exactly the thing the comment warned about — and done it silently, offering
  breakpoints in our own launcher. The reason had not stopped being true; it had stopped being the
  only option. Read what the exclusion is protecting against before assuming it is stale.
- **A spike that supplies its own inputs cannot find the bug in how real inputs arrive.**
  The Python debugger passed an offline tier and a bridge tier against a real
  interpreter, and did nothing at all the first time a person used it: both spikes named
  their test file absolutely, and `python main.py` compiles the script as `main.py` —
  the one name an editor breakpoint can never match. The tiers proved the backend; the
  path from what the user typed to what the backend was handed had no test in it at all.
  For anything with a UI, walk the real entry point once before calling it done.
- **A safety net you are about to widen is protecting against something. Find the test
  that proves it.** Standing the kernel's force-kill window down whenever a signal
  handler ran was one line, read as obviously correct, and would have let any guest that
  catches SIGTERM and ignores it live forever. `spike-signals.mjs` already had that exact
  guest, written by someone who had thought about it — so the shortcut failed loudly
  instead of shipping. The fix was to make the stand-down opt-in and let the one caller
  that has earned it ask.
- **Check whether the standard way is the fast way before building on it.** `sys.settrace` is how
  `pdb` does this and would have worked, at 10x on any loop — slow enough that the debugger would
  need a warning in its own documentation. `sys.monitoring` was four years old, in this exact
  interpreter, and costs nothing. One probe, before any code was written, was the difference.

**Measure the whole wait, not the part you just fixed.** The interpreter snapshot was written up
here as removing "the biggest thing wrong with Python", on the strength of a real 1.8s saving. It
was 1.8s of a six-second wait: importing numpy, pandas and Matplotlib was 4691ms of the same
script's start-up, and nobody had timed it because the boot was the thing being worked on. A
speed-up that is real and a speed-up that matters are different claims, and only the second one
needs the end-to-end number.

**A cache's failure mode is doing nothing, quietly.** Two versions of the bytecode cache
"worked" — files were produced, the code ran, no errors anywhere — and saved nothing. Once
because the `.pyc` files recorded mtimes that a fresh wheel unpack invalidated, so CPython
ignored all 12 MB; once because `sys.pycache_prefix` writes nothing at all when its root
directory does not exist. Both were caught by timing the import, and neither would have been
caught by checking that the cache had contents. Test a cache by measuring the thing it is
supposed to make faster, with a control whose contents are deliberately unusable.

## Where to look next

- **How it works** → [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- **Why it was built this way / status per feature** → [`roadmap.md`](./roadmap.md)
- **Background research** → `research.md`