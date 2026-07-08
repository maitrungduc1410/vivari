# Research — WebContainer teardown & technical notes

Living document, updated throughout. Key-points, not prose.
Sources: real StackBlitz analysis (network logs + DevTools VM instances, 2026)
plus things verified while implementing.

---

## 1. Two schools of Cloud IDE

- **CodeSandbox — server-side / micro-VM:** small Linux VMs (Firecracker) in the
  cloud, browser is a thin client over WebSocket. Runs anything (Docker, DBs) but
  costs server resources, no offline.
- **StackBlitz — client-side / WebContainer:** turns the browser into a "mini OS".
  Code runs 100% client-side via Web Workers + Service Worker + Wasm.
  Millisecond boot, secure, works offline. ← **the direction this project takes.**
- StackBlitz tiers tech by project type:
  - "Turbo" engine (100% JS): old React projects → mini bundler in pure JS, no
    Node/Wasm.
  - WebContainer engine (Rust+Wasm): modern/fullstack projects (Express, Vite,
    Next) → `.wasm` core + POSIX emulation.

---

## 2. StackBlitz architecture (confirmed via DevTools "JS VM instances")

Each worker/iframe is a separate JS realm. Real observations:

**Infrastructure (kernel + shared services):**
- `Main` — main thread, UI + orchestration only, does NOT run user code.
- `engineworker.js` — kernel/orchestrator (the "brain").
- `File System Worker` — the VFS lives in **its own worker** = single source of
  truth (not on the main thread).
- `Fetcher Worker` — dedicated to network fetching (npm packages); many workers
  show `↓ kB/s`.
- `sw.js` / `.localservice@service.worker...` — Service Worker intercepting
  network for the preview.

**Userspace (each is a process):**
- `Node.js Worker PID 1..15` — **each process = one worker WITH a PID** → a real
  OS-style process table. Idle ~8.1 MB (likely a **pre-warm pool** for fast
  spawn); grows under heavy work.
- `typescript` (~53–57 MB each) — `tsserver` processes, the heaviest on RAM.
- `prettier`, … — small CLI processes.
- `[worker 1/2/3]` — Node's **`worker_threads` nested inside** an emulated Node
  process (worker-in-worker).

**Preview:** iframe runs on a **separate origin** (`*.staticblitz.com`,
`*.webcontainer.io`) for security isolation.

**Numbers:** total heap ~**394 MB** (WebContainer is not RAM-light; `tsserver`
dominates). ⇒ the cost of running a real toolchain in the browser.

---

## 3. Core principle — the synchronous bridge (load-bearing primitive)

- Node is full of **synchronous** APIs (`fs.readFileSync`, `require()`,
  `execSync`…). The browser forbids blocking on async — **except on a Web
  Worker**, where `Atomics.wait()` can genuinely park the thread.
- Mechanism: user code (worker) writes a request into a `SharedArrayBuffer` →
  `Atomics.wait` (park) → kernel services it → writes result into the SAB →
  `Atomics.notify` → worker wakes, reads bytes from RAM, returns
  **synchronously**.
- **Key asymmetry:** `Atomics.wait` is **forbidden on the main thread**. ⇒ user
  code MUST live in a worker; the kernel responds via `Atomics.notify` from its
  event loop.
- **The only async part is `postMessage` between threads.** The Wasm call itself
  is **sync** (Rust sync → sync JS binding; `read_file()` returns a `Uint8Array`,
  no Promise). The sync bridge only hides the thread boundary, not the Wasm call.
- **Hard requirement:** `SharedArrayBuffer`/`Atomics` only work when the page is
  **cross-origin isolated** → needs `COOP: same-origin` + `COEP: require-corp`.
  StackBlitz uses the **`COEP: credentialless`** variant (embeds third-party
  resources without requiring CORP headers).

---

## 4. Why the kernel/userspace architecture (not merged)

- Don't do everything on the **main thread**: `Atomics.wait` is forbidden, heavy
  user code would freeze the UI, and there's no isolation.
- Don't give each worker its **own VFS**: multiple processes must share one
  filesystem, one network/port table ⇒ need a centralized source of truth.
- ⇒ Model: host/kernel holds shared state ; worker(s) = processes requesting
  services via "syscall" ; SAB = the syscall boundary.
- (Current demo note: VFS sits on the main thread to demo the primitive clearly;
  the proper architecture moves kernel/VFS into a dedicated worker like
  StackBlitz.)

---

## 5. Module system: `require` vs `import`

- `require` (CJS): synchronous + `require.cache` (singleton). Implement a sync
  `virtualRequire()` calling down to the VFS; keep the module cache in JS. Inject
  it as a global before executing user code via `new Function()`.
- `import` (ESM): async, natively supported by browsers → let the browser load
  from the VFS via the Service Worker.
- StackBlitz uses a mini transformer to transpile CJS↔ESM, unifying the project
  into one entity before running.

---

## 6. Known limitations (accepted from the start)

- Low-level TCP/UDP sockets are not truly emulated → native `curl` fails with
  `socket hang up`. Networking is only in-RAM virtual routing for HTTP preview.
- Native addons (`.node`) can't run (can't be recompiled to Wasm).
- `cat /etc/os-release` → **hardcoded** data in the VFS to fool OS-sniffing libs
  (this project masquerades as Ubuntu 22.04 / glibc, and seeds a glibc `/usr/bin/ldd`,
  so distro/libc sniffers land on the common well-supported path).

---

## 7. Build notes (Rust → Wasm)

- Distinguish: the **`wasm-bindgen` crate** (declared in `Cargo.toml`, fetched by
  cargo) ≠ the **`wasm-bindgen-cli`** binary (post-processes into `.js` glue +
  `pkg/`).
- **`wasm-pack` auto-downloads & manages `wasm-bindgen-cli`** matching the crate
  version + `wasm-opt` → no manual `cargo install wasm-bindgen-cli`. (Avoids the
  classic version-mismatch error.)
- Two build targets:
  - `--target web` (`pkg/`): ESM, needs `await init()` (async fetch+instantiate) →
    for the browser/demo.
  - `--target nodejs` (`pkg-node/`): CommonJS, loads wasm synchronously on
    `require` → for headless `node` tests.
  - Same `.wasm` (32.4 KB), only the JS wrapper differs. (Later: `--target
    bundler` when integrating Vite.)

---

## 8. Corrections to the original research

- **The Rust VFS is NOT the hardest part** (a path→bytes map in TS works too).
  Rust/Wasm's value: compact, shareable sync memory and performance for large
  file trees.
- **The real load-bearing primitive is the sync bridge** (Atomics+SAB+COOP/COEP)
  — the original didn't mention it; this must be de-risked FIRST.
- **The "scary" parts were underestimated:** `npm install`, process/`spawn`,
  native addons — not plain networking.
- `require.cache` belongs in **JS**, no need to push it into the Rust core.
- The right ordering is **de-risk → expand**, not a linear easy→hard march.

---

## 9. VFS core implementation notes (Brick 2)

- **Inode model:** `HashMap<id, Inode>`; a dir is a `BTreeMap<name, id>` (⇒
  `readdir` sorted for free), a symlink stores its target string. Root id = 1.
- **Resolution with a stack:** walk components keeping an ancestry stack so `..`
  = pop. Symlinks resolved recursively with a depth cap (`ELOOP` at 40). `stat`
  follows a trailing symlink; `lstat` does not (this is the whole stat/lstat
  distinction).
- **Errors cross as strings:** Rust returns `Result<T, String>` where the string
  is the errno code; wasm-bindgen throws it verbatim into JS. The JS `fs` facade
  wraps it into a Node-style `Error` with `.code` (so libs checking
  `err.code === "ENOENT"` work).
- **stat payload = tiny JSON string** (`{kind,size,mode,mtimeMs}`) — avoids a
  serde dependency; the facade turns it into a Stats-like object with
  `isFile()/isDirectory()/isSymbolicLink()`.
- **mtime via `js_sys::Date::now()`** — works in both browser and Node targets
  (no Rust `std::time` in Wasm).
- **Self-describing request frame:** `[flags u32][count u32]([len u32][bytes])*`
  lets one ABI carry single-path calls and multi-arg calls (rename, symlink)
  uniformly.
- **Node semantics matched on purpose:** `writeFileSync` does NOT create parent
  dirs (ENOENT); `readdir` on a file = ENOTDIR; read a dir = EISDIR; `rmdir` on a
  non-empty dir = ENOTEMPTY; `mkdir` existing = EEXIST.
- **Dependency note:** added `js-sys` crate (for `Date::now()`); still no serde.

---

## 10. Node runtime shim notes (Brick 3)

- **CommonJS is the natural fit for the sync bridge:** `require()` is synchronous
  by definition (read file → compile → return `module.exports`). It only works in
  the browser because reads block via `Atomics.wait`. This is exactly why brick #1
  had to come first.
- **User code runs via `new Function(...wrapperArgs, source)`** — the classic
  CommonJS wrapper. `require/module/exports/__filename/__dirname` plus globals
  (`process`, `Buffer`, `console`, `global`) are passed as parameters. `eval`/
  `new Function` are NOT blocked by cross-origin isolation.
- **Resolution mirrors Node:** builtins → relative/absolute (`.js`/`.json`,
  dir `index`, `package.json` "main") → bare specifiers walked up `node_modules`.
  `require.cache` keyed by resolved absolute filename gives singleton semantics.
- **`process.exit()` via a sentinel:** it throws an error carrying `__processExit`
  that `run()` catches and turns into the exit code (no real process to kill).
- **Builtins are pure JS on top of the VFS;** only `fs` actually crosses the sync
  bridge. `path`/`util`/`events`/`buffer` are self-contained. This matches how
  StackBlitz keeps Node core (`builtins.js`) in plain JS over the Wasm kernel.
- **`Buffer` polyfill = subclass of `Uint8Array`** (utf8/hex/base64/latin1 via
  `TextEncoder`/`atob`/`btoa`, which exist in both browser workers and Node).
- **Runtime is environment-agnostic:** the host nudge is an injected `notify`
  callback (postMessage in a browser Worker, `parentPort` in Node worker_threads),
  so the identical runtime powers both the demo and the headless test.
- **ABI moved to `packages/protocol`** as the single source of truth shared by
  the kernel host and the runtime (runtime must not depend on the demo).
- **ESM is the hard part, deferred:** `import` is async and needs either browser
  native module loading from the VFS (Service Worker) or a CJS transform. Left for
  a later brick; CommonJS + JSON covers a lot first.

---

## 11. Process model + shell notes (Brick 4)

- **A process = a worker + its own SAB.** The kernel owns the single VFS and a PID
  table, and services every process's syscalls from one event loop. This is the
  kernel/userspace split made concrete, and matches StackBlitz's per-PID
  `Node.js Worker` instances seen in DevTools.
- **`spawnSync`/`execSync` = waitpid over the sync bridge.** `OP_SPAWN` parks the
  parent on `Atomics.wait`; the kernel spawns the child, and only responds (wakes
  the parent) when the child exits, carrying `{code,stdout,stderr}`. No new
  primitive needed — it reuses brick 1.
- **Deep nesting just works** because each waiter is parked in its OWN thread while
  the single kernel thread stays free: shell → `node` → `execSync` → `echo` are
  four stacked parked processes, all coordinated by the kernel. Spawning is always
  done BY the kernel (main thread), so no nested-worker creation is required in the
  browser.
- **Everything is "just a Node process", including the shell.** Coreutils and `sh`
  are ordinary CommonJS programs installed at `/bin` and run via the runtime.
  Uniform, and it dogfoods the whole runtime. (StackBlitz likewise implements the
  userland in JS over the Wasm kernel.)
- **cwd is per-process** and inherited on spawn (kernel passes `cwd` in the spec).
  `cd` in the shell mutates only the shell's `process.cwd()`; children inherit it.
  Bug found + fixed: the `fs` builtin must resolve relative paths against
  `process.cwd()` before hitting the VFS (the VFS only speaks absolute paths).
- **Worker creation is injected** (`spawnWorker`) so the identical `Kernel` runs
  in the browser (Web Workers) and headless Node (worker_threads). Memory cost is
  real: one SAB (~1 MiB) per live process — StackBlitz's idle ~8.1 MB workers hint
  at a pre-warm pool, deferred here.
- **Package boundaries now:** `protocol` (ABI) ← `kernel-host` (supervisor) and
  `runtime` (userspace) both depend on it; `kernel-host` also depends on nothing
  from `runtime` except that programs happen to run on it.

---

## 12. StackBlitz `builtins.js` teardown — MAJOR finding

Analyzed StackBlitz's real `builtins.2896b7f3.js` (~2.1 MB). Game-changer:

- **They do NOT hand-write fake builtins. They ship Node.js's actual `lib/`
  JavaScript source.** The object `exports.builtins = { ... }` has ~300 keys that
  are exactly Node's module tree: public (`fs`, `http`, `stream`, `crypto`,
  `zlib`, `net`, `tls`, `worker_threads`, ...) AND internals
  (`internal/streams/readable`, `_http_agent`, `internal/crypto/*`,
  `internal/bootstrap/realm`, ...).
- **Proof:** the bundle contains `internalBinding`, `primordials`, and
  `internal/bootstrap/realm` — internal-only Node machinery. Each module is a
  wrapper `function(exports, require, module, process, internalBinding,
  primordials)`.
- **How it works — the `internalBinding` seam.** Real Node = JS `lib/` on top of
  C++ core, bridged by `internalBinding('fs')` / `process.binding(...)`.
  StackBlitz keeps the JS layer verbatim and REPLACES the C++ layer with their own
  JS/Wasm shims. When `lib/fs.js` calls `internalBinding('fs')`, it gets
  StackBlitz's impl backed by the Rust VFS (`fs_bg.wasm`).
- **The true "syscall surface" is small.** `internal/bootstrap/realm` lists the
  bindings they must provide: `buffer, cares_wrap, config, constants, contextify,
  fs, fs_event_wrap, icu, inspector, js_stream, os, pipe_wrap, process_wrap,
  spawn_sync, stream_wrap, tcp_wrap, tls_wrap, tty_wrap, udp_wrap, uv, zlib`
  (+ async_wrap, crypto, http_parser, signal_wrap, url, v8). ~20-30 bindings vs
  hundreds of JS modules. Everything above the binding line is Node's own code.
- **Why this matters:** `http`/`stream`/`crypto` are brutal to reimplement
  correctly. Using Node's real source gives near-100% compat "for free"; the cost
  moves to implementing the internalBinding layer.

### Strategic implication (two paths)

- **Path A — Reimplement (our current Brick 3 approach):** hand-write builtins.
  Fast for `fs`/`path`; hits a wall at `stream`/`http` (correct backpressure,
  agents, parsers = months, still low fidelity).
- **Path B — Real Node lib (StackBlitz style):** vendor Node's `lib/` and pour
  effort into an `internalBinding` layer on top of our Rust VFS + sync bridge +
  process model. Harder in a different place (must satisfy Node's internal ABI),
  but unlocks huge compatibility at once.
- **Key realization:** our existing foundation (Rust VFS + Atomics sync bridge +
  PID/process model) is exactly what an `internalBinding('fs'/'tcp_wrap'/...)`
  layer needs to plug into. `fs-client.js` is essentially a hand-rolled
  `internalBinding('fs')`. So Path B is a pivot in the upper layers, not a rewrite
  of the foundation.

### DECISION (2026-07): production = Path B

- **For production we will adopt Path B** (vendor Node's real `lib/` + build the
  `internalBinding` layer), because hand-writing `http`/`stream`/`crypto`/`zlib`
  correctly is infeasible and StackBlitz clearly reached this conclusion after
  heavy research.
- **For now we keep building on Path A** (hand-written builtins) to keep momentum
  and flesh out the rest of the architecture (networking, preview). Path A is not
  wasted: it validates the syscall/binding contract that Path B will formalize.
- **Migration note for future us:** the hard modules to watch when switching are
  `stream` (backpressure), `http`/`http2` (parser + agent), `zlib` (needs a Wasm
  codec), `crypto` (map to WebCrypto/Wasm), `net`/`tls` (need the virtual network
  from Brick 5). The switch touches only the runtime/builtins layer; kernel + VFS
  + process model stay.

---

## 13. Virtual network + preview notes (Brick 5)

- **A server is a process that never exits; its accept loop IS the event loop.**
  `listen()` only registers the port (`OP_LISTEN`) and returns. After top-level
  code runs, the runtime enters a blocking loop: `accept → run handler → respond`.
  `OP_ACCEPT` is a **deferred** syscall — the kernel leaves the process parked on
  `Atomics.wait` until a request arrives, then wakes it with the request. Same
  sync bridge as brick 1; no new primitive. This also solves "keep the process
  alive": the worker is genuinely parked, not spinning.
- **Kernel routing table:** `listeners: port → pid`, plus a per-process
  `serverInbox` and `pendingHttp: reqId → resolve`. `handleHttpRequest(port, req)`
  returns a Promise, queues the request, wakes the server if it's waiting, and
  resolves when the server issues `OP_RESPOND`. One request at a time per server
  (sequential) — enough for preview; concurrency would need multiple in-flight
  request ids per process.
- **The Service Worker is the bridge from the real browser fetch to the virtual
  server.** It can't touch the kernel (which lives on the page + workers), so on a
  `/preview/<port>/...` request it `postMessage`s the controlling window client
  over a `MessageChannel`; the page calls `kernel.handleHttpRequest` and posts the
  response back, which the SW wraps in a real `Response`. This is exactly the
  StackBlitz `*.webcontainer.io` preview trick, minus the separate origin (we use
  same-origin `/preview/` for now; a separate origin is stronger isolation later).
- **COEP + preview:** the top page is `require-corp`; same-origin iframe docs are
  allowed, but the SW responses set `Cross-Origin-Resource-Policy: same-origin`
  (and `COEP: require-corp`) explicitly so nested subresources embed cleanly.
- **SW scope matters.** `sw.js` lives at `/packages/demo/` so its default scope
  covers `/packages/demo/preview/...`. Server-relative URLs in served pages
  resolve back under `/preview/<port>/` and get intercepted too; absolute `/foo`
  would escape scope (self-contained pages avoid this for the PoC).
- **Limitations (Path A):** handlers must call `res.end()` synchronously (no async
  handlers / streaming bodies yet), no keep-alive, and timers don't fire while
  parked in accept. Real correctness (async `http`, `net` sockets, `tls`) comes
  with Path B (Node's real `lib/` on the `internalBinding` layer).
