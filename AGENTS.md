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
    programs/npm.js       from-scratch npm installer — LEGACY fallback (see real npm below).

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
                          oc-http relay, typed pub/sub over the worker protocol.
    src/oc/controller.ts  IdeController: the imperative core ported from demo/host.js
                          (Monaco, xterm terminals, demo Run via OC_RUN, preview, Explorer
                          file ops via oc-rename/oc-rm/oc-copy) as an external store React
                          reads via useSyncExternalStore. Also hosts the DevTools relay:
                          a window-message bridge routing CDP between each preview tab's
                          chobitsu and the shared chii frontend, plus local-only address-bar
                          navigation (navigatePreview) + in-app nav sync (oc-nav).
    src/components/ide/   AppShell · ActivityBar (Explorer/Search) · Explorer (context-menu
                          file ops) · SearchPane · EditorGroup (preview/permanent tabs) ·
                          TerminalPanel (Console/Terminal/Ports) · PreviewPanel (multi-tab
                          mini-browser: local address bar, back/forward, reload, chii
                          DevTools in a resizable bottom split) · StatusBar ·
                          CommandPalette · fileIcon (vscode-icons). Icons are Iconify via
                          unplugin-icons (`~icons/lucide/*`, `~icons/vscode-icons/*`; needs
                          @svgr/core) — do NOT reintroduce lucide-react.

  demo/            LEGACY raw-ESM UI (still runnable via `npm run dev:legacy` on
                   server.mjs). Its WORKER files are the shared runtime host and are
                   bundled by studio — do NOT delete them:
    host.js            legacy main thread: UI, SW registration, request relay.
    kernel-worker.js   hosts the Kernel; DEMOS registry + demo shell tabs (OC_RUN). [shared]
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

### Real npm is the studio shell's `npm` (delivery + shims)
The North Star is running the real npm/yarn/pnpm CLIs, not our from-scratch
`programs/npm.js`. In the studio that is now live: real npm@10.9.2 is vendored
and packed into one gzipped asset (`scripts/vendor-npm.mjs` →
`packages/studio/public/vendor/npm-pack.bin`, gitignored, built by
`npm run vendor:npm`, auto-run as `predev`/`prebuild:studio`). At boot the kernel
worker calls `ensureRealNpm()` (`packages/kernel-host/load-real-npm.js`) right
AFTER `installCoreutils()` — order matters, since `installCoreutils()` rewrites
the Turbo-analog to `/bin/npm.js` on every boot, so the real-npm shim must be
applied last to win. The loader unpacks the tree to `/usr/lib/node_modules/npm`,
runs `stubNodeGyp`, and overwrites `/bin/npm.js` + `/bin/npx.js` with shims that
`require()` the real CLI. Gotchas:
- The npm tree persists in OPFS, so `ensureRealNpm` skips re-unpacking on later
  boots and only re-applies the shims (`hasRealNpm` guard). If you change the
  vendored version, bump/clear it or reset OPFS (`?reset`).
- `programs/npm.js` is now only the FALLBACK (asset missing, e.g. legacy
  `server.mjs`). Don't invest in analog-specific behavior; fix things in real npm.
- Real npm needs `npm_config_cache` writable — the shell env sets `/tmp/.npm`
  (created at boot). Keep that when editing `openTerminal` env.
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
- yarn's `lib/cli.js` is a single ~5 MB webpack bundle — TOO big for the 1 MiB SAB
  `writeFile`, so the loader routes files ≥ 512 KB through `kernel.fs.writeLarge`
  (the transferred path). Any new large-asset loader must do the same.
- No Turbo-analog fallback: a missing asset just means `yarn` isn't on PATH (npm
  still is). There's nothing to "win" over, but the shim is still applied last.
- yarn needs a writable cache: the shell env sets `YARN_CACHE_FOLDER=/tmp/.yarn-cache`
  (created at boot), mirroring `npm_config_cache`.
- Headless browser-shape gate: `scripts/spike-yarn-studio.mjs` (`OC_NET=1` for the
  real `yarn add`). The off-disk Path B proof is `scripts/spike-yarn.mjs`.

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
- **Next.js is a hard wall** (documented in roadmap): Next 16 requires native SWC
  (no wasm fallback) + native Turbopack. Vite (rolldown, wasm) is the supported
  bundler path.

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
  shell, http, timers, watch). **Run this after any runtime/protocol change.** No
  network needed.
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
