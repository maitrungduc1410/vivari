// The Kernel — the "supervisor" side of the system, environment-agnostic.
//
// It owns the single shared VFS (Rust/Wasm) and a process table. Each process is
// a worker with its own SharedArrayBuffer channel; the kernel services every
// process's syscalls from its own event loop, and can spawn new processes.
//
// The elegant part (brick 4): a process that calls spawnSync/execSync parks on
// Atomics.wait via OP_SPAWN; the kernel drives the child to completion (servicing
// the child's own syscalls in the meantime) and only then wakes the parent with
// the child's exit code and captured output. That is a real waitpid, built on the
// same sync bridge as brick 1.
//
// Injected by the environment:
//   - fs:          the kernel's synchronous client to the File System Worker
//                  (Phase 2 #14) — { writeFile, mkdirp, isFile, exists,
//                  writeLarge }. The Wasm VFS itself now lives in that worker;
//                  the kernel no longer services fs syscalls (processes ring the
//                  FS Worker's doorbell directly).
//   - spawnWorker: (info) => handle   creates a worker (browser Worker or Node
//                  worker_threads), wires messages to info.on[type], posts
//                  {type:'init', sab, spec}; returns { terminate() }
//   - stdout/stderr(chunk, pid):  where non-captured process output goes

import {
  makeViews,
  encodeString,
  decodeBytes,
  decodeRequest,
  SAB_BYTES,
  I_STATE,
  I_OPCODE,
  I_REQ_LEN,
  I_RES_LEN,
  DATA_BYTES,
  STATE_REQUEST,
  STATE_RESPONSE_OK,
  STATE_RESPONSE_ERR,
  OP_SPAWN,
  OP_SPAWN_ASYNC,
  OP_KILL,
  OP_LISTEN,
  OP_ACCEPT,
  OP_RESPOND,
  OP_CLOSE_SERVER,
  OP_FETCH,
  OP_FETCH_ASYNC,
  OP_PIPE_LISTEN,
  OP_PIPE_CONNECT,
  OP_PIPE_CLOSE_SERVER,
  OP_READ_STDIN,
  postSignal,
  isCatchableSignal,
  defaultSignalExitCode,
} from "../protocol/syscall.js";
import { DBG_SAB_BYTES, makeDebugViews, writeDebugCommand } from "../protocol/debug.js";
import { COREUTILS } from "./coreutils.js";
import { CookieJar } from "./cookie-jar.js";

const EMPTY = new Uint8Array(0);

// A stdin chunk on its way to a parked reader. It arrives as a string from a
// terminal and as bytes from a parent writing to a child's stdin, and the reader
// gets bytes either way — the same rule the flowing path follows, for the same
// reason: stringifying here would mangle binary stdin.
function stdinBytes(chunk) {
  if (chunk == null) return EMPTY;
  if (typeof chunk === "string") return encodeString(chunk);
  return chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
}

// Decode a base64 request body (from the http/https client shim) to bytes,
// working in both the Node kernel host (Buffer) and a browser main thread (atob).
function b64ToBytes(b64) {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Encode bytes the way b64ToBytes reads them back.
function bytesToB64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// Whatever shape the caller used, reduce an inbound body to bytes: a string
// (utf8), a base64 string carrying the marker, a Buffer/TypedArray/ArrayBuffer
// from a test or a caller that read the request as bytes.
function inboundBodyBytes(req) {
  const body = req && req.body;
  if (body == null || body === "") return null;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (typeof body === "string") {
    return req.bodyEncoding === "base64" ? b64ToBytes(body) : new TextEncoder().encode(body);
  }
  return null;
}

// The inbox is handed to the process worker as JSON through the 1 MiB syscall
// window, so a body has to become a string AND has to fit. Leave headroom for
// the url, headers and framing that share the frame.
const INBOX_INLINE_MAX = DATA_BYTES - 16 * 1024;

export class Kernel {
  constructor({ fs, spawnWorker, stdout, stderr, fetcher, signalGraceMs }) {
    this.fs = fs;
    this.spawnWorker = spawnWorker;
    this.stdout = stdout || (() => {});
    this.stderr = stderr || (() => {});
    this.procs = new Map(); // pid -> process record
    this.nextPid = 1;
    this.onProcExit = null; // optional observer (pid, result)

    // ---- signals ----
    // How long a process that CAUGHT a signal gets to shut itself down before we
    // terminate it the way we always have. Every init system has this number and
    // every one of them picks it for its own workload: `docker stop` waits 10 s,
    // Kubernetes 30 s, systemd 90 s. Those budgets are sized for draining
    // in-flight requests behind a load balancer and flushing to remote storage.
    // Ours is not that: a guest's graceful shutdown is closing an in-VM listener
    // and flushing to a Wasm VFS in the same tab — microseconds of real work,
    // a handful of event-loop turns at worst. What we DO have that Docker does
    // not is a human staring at a browser tab through a dev-server restart loop,
    // where a 10 s stall per save would be intolerable. 5 s is far above any
    // legitimate in-VM shutdown and below the point where a person assumes the
    // page has hung; overridable for hosts that know better. Note this window
    // only ever opens for a process that registered a handler — everything else
    // is still terminated immediately, as before.
    this.signalGraceMs = signalGraceMs == null ? 5000 : signalGraceMs | 0;

    // ---- virtual network (brick 5) ----
    this.listeners = new Map(); // port -> pid of the server process
    this.pendingHttp = new Map(); // reqId -> { resolve, pid }
    // One cookie jar per listening port: on a real machine localhost:3000 and
    // localhost:5173 are separate origins with separate jars, and sharing one
    // would leak an API's session into a frontend.
    this.cookieJars = new Map(); // port -> CookieJar
    this.nextReqId = 1;
    this.onListen = null; // optional observer (port, pid) — e.g. wire a preview
    this.onClose = null; // optional observer (port, pid) — the mirror of onListen

    // ---- WebSocket tunnel (roadmap #19 stage C) ----
    // The browser preview tunnels each ws connection to us (it can't reach an
    // in-VM ws server directly). connId (chosen browser-side) -> pid that owns
    // the port. `onWsSend(msg)` relays a process's outbound frame back out to the
    // browser; the environment (kernel worker) wires it to the preview iframe.
    this.wsConns = new Map(); // connId -> pid
    this.onWsSend = null;

    // ---- Server-Sent Events tunnel ----
    // Same idea as the ws tunnel but one-way: the browser preview tunnels each
    // EventSource connection to us (a streaming text/event-stream response can't
    // cross the buffered HTTP preview proxy). connId (chosen browser-side) -> pid
    // that owns the port. `onSseSend(msg)` relays a process's outbound stream
    // chunk back out to the browser via the kernel worker + preview iframe.
    this.sseConns = new Map(); // connId -> pid
    this.onSseSend = null;

    // ---- cross-process UNIX sockets / named pipes ----
    // A pipe server registers its socket path here (path -> owner pid). A client
    // in another process resolves the path to a connId; from then on raw bytes are
    // relayed between the two processes out of band (postMessage), never the SAB.
    // This is the process<->process analogue of the port routing table above, and
    // is what makes Nuxt/Nitro's dev worker (which talks to the main process over a
    // `*.sock` UNIX socket) reachable in-VM. See OP_PIPE_* in protocol/syscall.js.
    this.pipeListeners = new Map(); // socketPath -> pid of the server process
    this.pipeConns = new Map(); // connId -> { clientPid, serverPid }
    this.nextPipeConnId = 1;

    // ---- network fetch (Phase 2 #9) ----
    // Injected by the environment: (url) => Promise<{ok,status,headers,body:Uint8Array}>.
    // The browser routes this to a dedicated Fetcher Worker; tests inject a mock.
    this.fetcher = fetcher || null;
    // URL -> { path, status, ok, contentType, size } — content cache so a repeated
    // fetch (npm re-resolving the same package) skips the network entirely.
    this.fetchCache = new Map();
    this.onFetch = null; // optional observer (url, {cached,size,pid}) — e.g. a UI log / per-terminal progress

    // ---- breakpoint debugger (CDP) ----
    // A process spawned with env VV_DEBUG=1 becomes a debug target: it gets a
    // second SharedArrayBuffer (the debug-command channel) and the in-guest
    // Debugger backend attaches. The kernel routes CDP between the studio and the
    // target: events flow out via `onDebugEvent(pid, json)`; commands flow in via
    // `debugCommand(pid, json)` — over postMessage while the target is running, or
    // over the debug SAB while it is paused (a parked worker isn't draining
    // postMessages). `onDebugTarget(pid, added, info)` announces targets to the UI.
    this.debugSabs = new Map(); // pid -> SharedArrayBuffer
    this.debugViews = new Map(); // pid -> { ctrl, data }
    this.debugPaused = new Set(); // pids currently parked at a breakpoint
    this.debugQueue = new Map(); // pid -> string[] of commands awaiting the SAB slot
    this.onDebugEvent = null; // (pid, jsonString)
    this.onDebugTarget = null; // (pid, added:boolean, info)

    // ---- process liveness watchdog -------------------------------------------
    // A process worker can die without saying so: it throws at boot, or the browser
    // reclaims it under memory pressure. Nothing then arrives on its 'exit' channel,
    // so finalize() never runs and every waiter (start()'s promise, a parent parked
    // on OP_SPAWN, the studio terminal awaiting term-exit) waits forever. Worker
    // 'error'/'messageerror' now route to handleWorkerError so the common cases DO
    // finalize — but a worker can also just stop making progress with no event at
    // all, which is indistinguishable from a slow install. So we also track a
    // last-activity stamp per process and report anything that has gone quiet, which
    // turns "the terminal froze" into a line of text the user can act on. Reporting
    // only, never a kill: a genuinely slow `npm install` must not be terminated.
    this.onProcStall = null; // (pid, { command, args, cwd, silentMs, reported })
    this.stallThresholdMs = 60000; // report a process that has been silent this long
    this.stallCheckMs = 15000; // how often to look
    this._stallTimer = null;
    // Live "debug mode" flag, toggled from the studio. When on, every debuggable
    // process (see skip-list in createProcess) becomes a debug target — regardless
    // of when its terminal opened, so toggling debug mode takes effect immediately
    // without needing to re-open the shell (whose env is fixed at launch).
    this.debugMode = false;

    // ---- bounded LRU over the transient fetched-body cache -------------------
    // Every fetched packument/tarball body is materialized under /var/cache/
    // vv-fetch and, until now, kept in the VFS's Wasm RAM for the WHOLE session —
    // a heavy install (Docusaurus/Nuxt) left hundreds of MB of dead `.tgz` bytes
    // resident long after the packages were extracted. Those bodies are pure
    // scratch: the durable, reusable copy is the package manager's OWN content-
    // addressed cache under /home/user/.cache (persisted in OPFS). So cap the
    // total and evict the least-recently-used bodies — dropping both the
    // fetchCache entry AND its VFS file — once we exceed the cap.
    //
    // Evicting meta and file together keeps "meta present ⟺ body present" true, so
    // a future cache HIT never points at a missing file. But that was never the
    // dangerous window. We hand a process a PATH and it reads the bytes back later,
    // in its own turn; between those two moments eviction runs on other threads'
    // downloads. Evicting there unlinks a body its reader has not read yet, and
    // https.js turns the resulting ENOENT into an empty 200 — silent corruption,
    // not an error. Measured: at a 4 MiB cap, 303 of 977 body reads failed that way
    // and the install broke; at 128 MiB eviction almost never runs, which is the
    // only reason it has never been seen in the wild.
    //
    // So bodies are REFERENCE COUNTED (_fetchBodyPins) from handoff until the FS
    // layer reports the read finished. Eviction may always drop the accounting, but
    // the file itself only goes once the last reader releases it (or its process
    // exits). That makes the cap safe to lower, which is what actually matters:
    // the VFS holds these bodies in Wasm memory that never shrinks, so the cap is a
    // direct lever on peak residency — 128 MiB of scratch was ~200 MB of peak RSS
    // to avoid 4.3 MB of re-download (44 hits in a Starlight install).
    this.fetchCacheMaxBytes = 16 * 1024 * 1024; // 16 MiB scratch ceiling
    this._fetchCacheBytes = 0; // running total of cached body sizes
    // path -> pid[]: one entry per outstanding handoff, so a body shared by an
    // in-flight de-dupe is only freed after EVERY sharer has read it. Array (not a
    // count) so a dead process's references can be dropped precisely.
    this._fetchBodyPins = new Map();
    // Bodies evicted from the accounting while still pinned: unlink on last release.
    this._fetchBodyOrphans = new Set();
    // Body paths are uniquified per fetch (see _fetchCachePath). Without this, a
    // re-fetch after eviction would reuse the evicted path and a stale pending
    // unlink would delete the NEW body.
    this._fetchBodySeq = 0;
    // The read of a fetched body happens in the FS layer, not here, so the kernel
    // has to be told when it finishes. Embedders whose fs client can report it
    // (createKernelFs) wire it automatically; one that can't simply keeps bodies
    // until the owning process exits, which is safe, just less thrifty.
    if (this.fs && typeof this.fs.setBodyConsumedHandler === "function") {
      this.fs.setBodyConsumedHandler((path) => this.releaseFetchBody(path));
    }

    // ---- async fetch: parallel downloads (OP_FETCH_ASYNC) ----
    // The real npm/yarn/pnpm issue many registry requests at once, but its Agent
    // reports maxSockets=Infinity, so without a bound it would fire hundreds
    // simultaneously and hit the browser's per-origin connection limit (and burn
    // memory buffering tarballs). Cap concurrent outbound requests, queue the
    // rest, and de-dupe identical in-flight cacheable GETs so a burst for the same
    // packument only hits the network once.
    this.fetchConcurrency = 10;
    this._fetchActive = 0;
    this._fetchQueue = [];
    this._fetchInflight = new Map(); // cacheKey -> Promise<meta> (network in flight)

    // ---- lazy (on-demand) programs -------------------------------------------
    // Some tools are HUGE (the real TypeScript 7 `tsgo` is a ~47 MB wasm; yarn/
    // pnpm/corepack are ~11 MB gz each) and most sessions never invoke them. So
    // instead of fetching + unpacking them into the VFS eagerly at boot, the
    // environment (kernel worker) registers an async loader keyed by command
    // name; the FIRST spawn of that command awaits the loader (which materializes
    // the real /bin/<cmd>.js shims) and only then resolves + runs. A returning
    // visitor's tree is OPFS-restored, so the loader just re-applies shims (cheap).
    // The Kernel stays environment-agnostic — it only holds the registry + gate;
    // the actual fetch/unpack lives in the loaders. See registerLazyProgram +
    // ensureCommandLoaded, hooked into the spawn paths (handleSpawn/handleSpawnAsync)
    // and awaited by the SDK spawn path before launch().
    this.lazyLoaders = new Map(); // command name -> async loader fn (shared per asset)
    this.lazyNotices = new Map(); // command name -> one-line "loading on first use" notice
    this.lazyInflight = new Map(); // loader fn -> Promise (dedupe concurrent first-uses)
  }

  // ---- lazy (on-demand) program registry ------------------------------------
  /**
   * Register an async `loader` under one or more command `names`. The loader is
   * invoked (at most once, unless it fails) the first time any of those commands
   * is spawned; it must materialize the program on PATH (e.g. write /bin/<cmd>.js)
   * before resolving. Passing several names that share one asset (e.g. `tsc` +
   * `tsgo`) makes them share the SAME loader, so loading via either satisfies both.
   * `notice` (optional) is a one-line message written to the INVOKING process's
   * terminal the moment the load starts, so a multi-second first-use download isn't
   * a silent frozen prompt.
   */
  registerLazyProgram(names, loader, notice = null) {
    for (const name of Array.isArray(names) ? names : [names]) {
      this.lazyLoaders.set(name, loader);
      if (notice) this.lazyNotices.set(name, notice);
    }
  }

  /**
   * Ensure a lazily-registered `command` has been loaded before it is resolved.
   * No-op when nothing is registered for it (so environments without lazy programs
   * — e.g. the Node test harness — are unaffected). Concurrent first-uses share a
   * single in-flight promise; a successful load removes the registration so later
   * spawns are a straight no-op; a FAILED load clears the in-flight entry so a
   * subsequent invocation can retry (rather than caching the failure forever).
   * `pid` (optional) is the process that issued the spawn: when this call is the
   * one that INITIATES the load, the tool's `notice` is written to that process's
   * stderr (routed to its terminal by the environment), once per load episode.
   */
  async ensureCommandLoaded(command, pid = null) {
    const loader = this.lazyLoaders.get(command);
    if (!loader) return; // not lazy (or already loaded) — nothing to do
    let inflight = this.lazyInflight.get(loader);
    if (!inflight) {
      // We're initiating the load — announce it to the invoking terminal (dim), so
      // the first `tsc`/`yarn`/… doesn't look like a frozen prompt while it downloads.
      const notice = this.lazyNotices.get(command);
      if (notice && pid != null) {
        try { this.stderr("\x1b[90m" + notice + "\x1b[0m\r\n", pid); } catch { /* sink gone */ }
      }
      inflight = (async () => loader())();
      this.lazyInflight.set(loader, inflight);
    }
    try {
      await inflight;
      // Success: drop every command name mapped to this loader so future spawns
      // skip the gate entirely.
      for (const [name, fn] of this.lazyLoaders) {
        if (fn === loader) {
          this.lazyLoaders.delete(name);
          this.lazyNotices.delete(name);
        }
      }
    } catch {
      /* loader threw — leave the registration so a later spawn can retry */
    } finally {
      this.lazyInflight.delete(loader);
    }
  }

  // ---- VFS helpers ----------------------------------------------------------
  // These proxy to the File System Worker over the kernel's own sync SAB channel
  // (#14). They stay synchronous so boot seeding and PATH resolution are unchanged.
  writeFile(path, contents) {
    this.fs.writeFile(path, contents);
  }
  // Write many files in one transfer (boot delivery of a PM tree). Falls back to
  // per-file writes if the fs client predates writeFilesBatch. Returns a Promise.
  writeFilesBatch(files) {
    if (typeof this.fs.writeFilesBatch === "function") return this.fs.writeFilesBatch(files);
    for (const f of files) {
      const slash = f.path.lastIndexOf("/");
      if (slash > 0) this.mkdirp(f.path.slice(0, slash));
      this.writeFile(f.path, f.bytes ?? f.contents);
    }
    return Promise.resolve(files.length);
  }
  readFile(path) {
    return this.fs.readFile(path);
  }
  readFileBytes(path) {
    return this.fs.readFileBytes(path);
  }
  mkdirp(path) {
    this.fs.mkdirp(path);
  }
  readdir(path) {
    return this.fs.readdir(path);
  }
  stat(path) {
    return this.fs.stat(path);
  }
  isFile(path) {
    return this.fs.isFile(path);
  }
  exists(path) {
    return this.fs.exists(path);
  }
  unlink(path) {
    this.fs.unlink(path);
  }
  rmdir(path) {
    this.fs.rmdir(path);
  }
  rename(from, to) {
    this.fs.rename(from, to);
  }

  /** Install the built-in programs into /bin so they are available on PATH. */
  installCoreutils() {
    this.mkdirp("/bin");
    for (const [name, source] of Object.entries(COREUTILS)) {
      this.writeFile("/bin/" + name + ".js", source);
    }
  }

  normalizePath(p) {
    const abs = p.startsWith("/");
    const st = [];
    for (const c of p.split("/")) {
      if (!c || c === ".") continue;
      if (c === "..") st.pop();
      else st.push(c);
    }
    return (abs ? "/" : "") + st.join("/") || (abs ? "/" : ".");
  }
  resolvePath(cwd, p) {
    return this.normalizePath(p.startsWith("/") ? p : cwd + "/" + p);
  }

  /** Resolve a command name to a program file in the VFS (PATH = /bin). */
  resolveProgram(command, cwd, env = {}) {
    // The command arrives from a guest, so it is not necessarily a string.
    // `Bun.spawn()` with no arguments sent `undefined` and this method called
    // .includes() on it — a TypeError thrown inside the KERNEL, which in the
    // browser kills the kernel worker and with it every process, the VFS session
    // and the preview. An unresolvable command is an ENOENT to the caller, which
    // is what a non-string is.
    if (typeof command !== "string" || command === "") return null;
    const candidates = [];
    if (command.includes("/")) {
      const abs = this.resolvePath(cwd, command);
      candidates.push(abs, abs + ".js");
    } else {
      // PATH order first (so a project's node_modules/.bin can shadow /bin),
      // then /bin. Entries may be relative (resolved against cwd) or absolute.
      const pathDirs = String(env.PATH || "").split(":").filter(Boolean);
      for (const dir of pathDirs) {
        const base = this.resolvePath(cwd, dir) + "/" + command;
        candidates.push(base, base + ".js");
      }
      candidates.push("/bin/" + command, "/bin/" + command + ".js");
    }
    return candidates.find((c) => this.isFile(c)) || null;
  }

  // ---- process lifecycle ----------------------------------------------------
  createProcess(spec, { parentPid = null, capture = false, stream = false, threadPort = null } = {}) {
    const pid = this.nextPid++;
    const sab = new SharedArrayBuffer(SAB_BYTES);
    const { ctrl, data } = makeViews(sab);
    const proc = {
      pid,
      parentPid,
      capture,
      // #15: async children stream their output to the *parent worker* (so its
      // event loop can react live) instead of buffering (capture) or going to the
      // host (default). See onOutput + handleSpawnAsync.
      stream,
      ctrl,
      data,
      outBuf: [],
      errBuf: [],
      onExit: null,
      // Settled instead of onExit when the process died of a WORKER fault rather
      // than running to completion (see finalize). start() wires this to its
      // promise's reject; callers that only set onExit still get the result there,
      // so every existing consumer keeps working unchanged.
      onError: null,
      finalized: false,
      // Liveness watchdog bookkeeping. Two stamps, because they answer different
      // questions and conflating them made the watchdog unable to ever fire:
      //   lastActivity — any syscall OR output. "Is this process doing anything?"
      //   lastOutput   — output only. "Has the user seen anything?"
      // The stall we actually need to report is a process that is BUSY and SILENT:
      // npm's reify phase writes ~12k files, so syscalls stream continuously and a
      // syscall-based threshold never trips, while the user stares at a dead
      // terminal. So the watchdog keys on lastOutput and reports syscall counts as
      // evidence of what the process is doing. `stallReportedAt` is the silence
      // duration at the last report, so repeats back off by doubling instead of
      // spamming a slow-but-healthy install.
      lastActivity: Date.now(),
      lastOutput: Date.now(),
      syscalls: 0,
      stallReportedAt: 0,
      // Uncaught errors reported by the worker itself (browser `error` event). NOT
      // deaths — see handleWorkerError. Counted so a process throwing in a loop is
      // visible in diagnostics without spamming the terminal 113 times.
      workerErrors: 0,
      firstWorkerError: null,
      // Set by the first syscall or byte of output. A worker whose module graph
      // evaluated always reaches one almost immediately (the runtime reads its entry
      // script through the VFS), so this is solid evidence it came up — and it is
      // derived from signals every embedder already routes, rather than needing each
      // spawnWorker to report boot separately. An `error` event while this is still
      // false means the worker never ran, which IS fatal (nothing else settles it).
      booted: false,
      handle: null,
      command: spec.command,
      // The launch args, kept so process exit can report the full invocation (e.g.
      // detecting an `npm install` completing, to snapshot the dependency cache).
      args: spec.args || [],
      // Launch cwd (absolute). Used to attribute a server's `listen()` back to the
      // project it was started in — even for a manually run `npm start` that has no
      // VV_RUN wiring (see kernel-worker's projectDirForPid).
      cwd: spec.cwd,
      // Signals this process has a live `process.on(...)` listener for. The guest
      // announces changes as they happen (signal-listen below); anything not in
      // here gets the default action — terminate now — so a process that ignores
      // SIGTERM does not accidentally start surviving it.
      sigHandlers: new Set(),
      graceTimer: null, // armed while a caught signal is being given time to work
      gracePending: null, // which signal that window belongs to
      sigUnhandled: null, // a delivered signal the guest has not answered yet
      serverInbox: [], // queued { reqId, port, req } drained by non-blocking accept
      // #16 stage 2b: reqId -> child pid for worker_threads this process spawned.
      threads: null,
    };
    this.procs.set(pid, proc);

    // Breakpoint debugger: a process launched with VV_DEBUG=1 is a debug target.
    // Allocate its debug-command SAB (kernel→worker) before spawning so the runtime
    // can attach the in-guest Debugger backend at boot. The env propagates to child
    // processes (so a dev server launched by the run shell inherits it), but the
    // shell wrapper + package managers themselves aren't interesting to debug — skip
    // them so auto-attach lands on the user's actual program, not `sh`/`npm`.
    // (Bun is deliberately NOT skipped: `bun <file>` runs the entry through the JS
    // module loader, so its breakpoints bind like `node`.)
    //
    // `python`/`python3` ARE targets, but of the other backend. Our `python` is a
    // Node shim that runs the real program inside Pyodide, so the `.py` source
    // never passes through the JS module loader and instrumenting the shim would
    // debug the wrong program. The interpreter has its own debugging interface,
    // so the language rides along with the SAB and the runtime attaches
    // builtins/python-debugger.js instead of the JS one.
    const env = spec.env || {};
    const wantsDebug = this.debugMode || env.VV_DEBUG === "1" || env.VV_DEBUG === "true";
    const cmd = String(spec.command || "");
    const skipDebug = /^(sh|bash|dash|zsh|npm|npx|yarn|pnpm|corepack|node-gyp|tsc|tsgo)$/.test(cmd);
    const debugLang = /^python3?$/.test(cmd) ? "python" : "js";
    const debugEnabled = wantsDebug && !skipDebug;
    let debugSab = null;
    if (debugEnabled) {
      debugSab = new SharedArrayBuffer(DBG_SAB_BYTES);
      this.debugSabs.set(pid, debugSab);
      this.debugViews.set(pid, makeDebugViews(debugSab));
      this.debugQueue.set(pid, []);
      // Start in SAB-routing mode: the guest blocks in an --inspect-brk-style start
      // gate (debugger.js waitForStart) before its entry runs, and only reads inbound
      // commands over the SAB there — so config (enable + breakpoints) must go over
      // the SAB, not postMessage. The guest emits `Debugger.resumed` when the gate
      // opens, which flips this back to postMessage for the running program.
      this.debugPaused.add(pid);
    }

    proc.handle = this.spawnWorker({
      pid,
      sab,
      debugSab,
      debugLang,
      spec: { ...spec, pid, ppid: parentPid ?? 0 },
      // #16 stage 2b: a spawned thread gets its creator's MessageChannel end as a
      // transferable, delivered to the worker as parentPort at init.
      threadPort,
      on: {
        syscall: () => this.serviceSyscall(pid),
        stdout: (m) => this.onOutput(pid, m.chunk, false),
        stderr: (m) => this.onOutput(pid, m.chunk, true),
        exit: (m) => this.finalize(pid, m.code | 0),
        // The worker died rather than exited: it threw at boot, its module graph
        // failed to load, or the browser reclaimed it (a V8 OOM kill). The
        // environment's spawnWorker reports it here; without this the process would
        // simply never finalize. See handleWorkerError.
        // The worker reported an `error`/`messageerror` event. This is NOT
        // necessarily death — see handleWorkerError, which only treats it as fatal
        // before the worker has come up.
        "worker-error": (m) => this.handleWorkerError(pid, m),
        // #16 stage 2b: this process' worker_threads asks the kernel to spawn /
        // terminate a nested thread worker.
        "thread-spawn": (m) => this.handleThreadSpawn(pid, m),
        "thread-terminate": (m) => this.handleThreadTerminate(pid, m),
        // Interactive stdin: this process wrote to a child's stdin — deliver the
        // bytes to that child's own process.stdin.
        "child-stdin": (m) => this.handleChildStdin(pid, m),
        // The guest gained or lost a `process.on('SIGTERM'|…)` listener, which is
        // what decides whether a signal is posted to it or applied to it.
        "signal-listen": (m) => this.handleSignalListen(pid, m),
        "signal-handled": (m) => this.handleSignalHandled(pid, m),
        // #19 stage C: this process relays a ws frame outward (in-VM ws server ->
        // browser preview) for a tunneled connection.
        "ws-out": (m) => this.handleWsOut(pid, m),
        // A process relays an SSE stream chunk outward (in-VM server -> browser
        // preview EventSource) for a tunneled connection.
        "sse-out": (m) => this.handleSseOut(pid, m),
        // Cross-process pipe (UNIX socket) traffic this process produced: bytes /
        // half-close / teardown for a connection, relayed to the peer process.
        "pipe-data": (m) => this.handlePipeRelay(pid, m),
        "pipe-shutdown": (m) => this.handlePipeRelay(pid, m),
        "pipe-close": (m) => this.handlePipeRelay(pid, m),
        // Breakpoint debugger: a CDP event/response from the in-guest backend.
        "dbg-event": (m) => this.handleDebugEvent(pid, m),
      },
    });

    if (debugEnabled && this.onDebugTarget) {
      this.onDebugTarget(pid, true, { command: spec.command, args: spec.args || [], cwd: spec.cwd });
    }
    this._startStallWatchdog();
    return pid;
  }

  // ── breakpoint debugger routing ─────────────────────────────────────────────
  // A CDP event/response from a target's in-guest backend. Track paused/resumed so
  // we know which channel to route inbound commands over, then relay to the studio.
  handleDebugEvent(pid, m) {
    const data = m && m.data;
    if (typeof data === "string") {
      if (data.indexOf('"Debugger.paused"') !== -1) this.debugPaused.add(pid);
      else if (data.indexOf('"Debugger.resumed"') !== -1) {
        this.debugPaused.delete(pid);
        this._drainDebugQueue(pid); // flush any commands queued while paused
      }
    }
    if (this.onDebugEvent) this.onDebugEvent(pid, data);
  }

  // Deliver a CDP command (JSON string) from the studio to a target process. While
  // running, postMessage is fine; while paused (the worker is parked on Atomics),
  // the command must ride the debug SAB — queued if the single slot is still full.
  debugCommand(pid, json) {
    if (!this.debugSabs.has(pid)) return; // not a debug target
    if (this.debugPaused.has(pid)) {
      const q = this.debugQueue.get(pid);
      q.push(json);
      this._drainDebugQueue(pid);
    } else {
      this.postToProc(pid, { type: "dbg-cmd", data: json });
    }
  }

  _drainDebugQueue(pid) {
    const q = this.debugQueue.get(pid);
    const views = this.debugViews.get(pid);
    if (!q || !views) return;
    while (q.length) {
      if (!writeDebugCommand(views, q[0])) {
        // Slot still occupied by an unread command — retry shortly. The parked
        // worker consumes promptly, so this is a brief, rare wait.
        setTimeout(() => this._drainDebugQueue(pid), 0);
        return;
      }
      q.shift();
    }
  }

  // Post a message to a process' worker (out of band from the SAB). Used to relay
  // async child (#15) and worker_thread (2b) lifecycle to the parent's loop.
  postToProc(pid, msg) {
    const p = this.procs.get(pid);
    if (p && p.handle && p.handle.postMessage) {
      try {
        p.handle.postMessage(msg);
        return true;
      } catch {
        /* worker gone */
      }
    }
    return false;
  }

  onOutput(pid, chunk, isErr) {
    const proc = this.procs.get(pid);
    if (!proc) return;
    // Output is the only progress the USER can see, so it gets its own stamp; the
    // watchdog keys on it. (A `capture: true` process is not user-visible, but it is
    // also not being watched by anyone staring at a terminal, so it is stamped too.)
    proc.lastOutput = proc.lastActivity = Date.now();
    proc.booted = true;
    if (proc.capture) {
      (isErr ? proc.errBuf : proc.outBuf).push(chunk);
      return;
    }
    if (proc.stream) {
      // Deliver to the parent worker out of band (it is not parked on its SAB).
      const parent = this.procs.get(proc.parentPid);
      if (parent && parent.handle && parent.handle.postMessage) {
        try {
          parent.handle.postMessage({ type: isErr ? "child-stderr" : "child-stdout", childPid: pid, chunk });
          return;
        } catch {
          /* parent worker gone — fall through to the host sink */
        }
      }
    }
    (isErr ? this.stderr : this.stdout)(chunk, pid);
  }

  /**
   * A process worker faulted instead of exiting. Surface it on the process's own
   * stderr (so it lands in the terminal the user is staring at) and then run the
   * NORMAL exit path, so every waiter is released: start()'s promise, a parent
   * parked on OP_SPAWN, a worker_threads creator awaiting 'thread-exit', the
   * studio's term-exit, and any in-flight HTTP request finalize() already 502s.
   *
   * Exit code 1 with `error` set, rather than a bespoke code, because callers
   * already branch on `code !== 0`; the `error` string is the new information.
   */
  /**
   * A process worker reported an error event.
   *
   * IMPORTANT: on the web platform a Worker's `error` event does NOT mean the worker
   * died. An uncaught exception inside a worker is *reported* to the Worker object
   * and the worker CARRIES ON servicing its event loop. Treating it as death was a
   * real regression: `astro dev` throws ~113 uncaught SyntaxErrors per run from deep
   * inside its own code, had always survived them (the dev server bound in 9 of 9
   * runs), and finalizing on the first one killed it before it could ever listen —
   * 0 of 5 runs bound. The shell returned to a prompt and the studio waited forever
   * on a server that no longer existed, which looks exactly like the hang this was
   * meant to fix.
   *
   * The one case that IS fatal is a worker that never came up — a script that failed
   * to load or threw while evaluating its module graph. Nothing else will ever settle
   * that, and it is the hang Fix A was written for. Only the environment can tell the
   * two apart (it sees whether the worker ever posted a message), so it says so with
   * `m.fatal`; absent that flag we assume NOT fatal, because wrongly killing a live
   * process is far worse than being slow to report a dead one — the liveness watchdog
   * catches the latter within seconds.
   *
   * Note this means an OOM-killed worker is NOT caught here either: Chrome reclaims a
   * worker without firing any event at all. The watchdog is the only cover for that.
   */
  handleWorkerError(pid, m) {
    const proc = this.procs.get(pid);
    if (!proc || proc.finalized) return;
    const msg = (m && (m.error || m.message)) || "process worker terminated unexpectedly";
    proc.workerErrors++;
    if (!proc.firstWorkerError) proc.firstWorkerError = msg;

    if (m && m.fatal) {
      const oom = /out of memory|OOM|allocation failed/i.test(msg);
      const detail = oom
        ? `${proc.command}: process worker ran out of memory (${msg}). The VM is out of ` +
          "room for this process — close other previews/terminals or reload the page and try again.\n"
        : `${proc.command}: process worker failed to start (${msg})\n`;
      this.onOutput(pid, detail, true);
      this.finalize(pid, 1, null, msg);
      return;
    }

    // Running worker: surface the FIRST error only. These arrive in floods (113 for
    // one `astro dev`) and 113 terminal lines would bury the output the user needs.
    // The running total is available from diagnostics (see diagnostics()).
    if (proc.workerErrors === 1) {
      this.onOutput(
        pid,
        `${proc.command}: uncaught error in process worker (${msg})` +
          " — the process is still running; further occurrences are counted, not printed\n",
        true,
      );
    }
  }

  // ---- liveness watchdog ----------------------------------------------------
  // Runs only while processes exist. Reports any process that has produced no OUTPUT
  // for `stallThresholdMs`, whether or not it is making syscalls.
  //
  // Keying this on `lastActivity` instead — as it originally did — conflated two
  // different things and made the report both unreliable and mislabelled ("has
  // produced no output" while measuring syscalls). The user's complaint is "no
  // output", so output is what must be measured.
  //
  // A vital caveat for anyone extending this: `syscalls`/`lastActivity` only count
  // KERNEL syscalls (spawn, fetch, listen, …). A process's filesystem traffic goes
  // straight to the FS worker over its own SAB and never reaches the kernel at all,
  // so a process writing 12,000 files looks completely idle from here. Do NOT
  // conclude "wedged" from a flat syscall count — measured: a guest in a tight
  // writeFileSync loop registers ZERO kernel syscalls. Progress has to be judged from
  // the VFS itself, which is what the environment's onProcStall handler does (it has
  // the FS worker to ask; the kernel does not).
  _startStallWatchdog() {
    if (this._stallTimer || typeof setInterval !== "function") return;
    this._stallTimer = setInterval(() => {
      if (!this.procs.size) {
        this._stopStallWatchdog();
        return;
      }
      const now = Date.now();
      for (const [pid, proc] of this.procs) {
        if (proc.finalized) continue;
        // A process parked at a breakpoint is *supposed* to be silent.
        if (this.debugPaused.has(pid)) continue;
        const silentMs = now - proc.lastOutput;
        // Report at the threshold, then only when the silence has DOUBLED (60s, 2m,
        // 4m, …). One line is not enough — the user who waited 30 minutes needs to
        // keep seeing that nothing is happening — but a fixed interval would spam a
        // slow-but-healthy install. Doubling is informative and self-limiting.
        if (silentMs < proc.stallReportedAt * 2 || silentMs < this.stallThresholdMs) continue;
        proc.stallReportedAt = silentMs;
        if (this.onProcStall) {
          this.onProcStall(pid, {
            command: proc.command,
            args: proc.args || [],
            cwd: proc.cwd,
            silentMs,
            // Kernel-level activity only — see the caveat above. Useful evidence, but
            // NOT sufficient to call a process wedged.
            idleMs: now - proc.lastActivity,
            syscalls: proc.syscalls,
            workerErrors: proc.workerErrors,
          });
        }
      }
    }, this.stallCheckMs);
    // Node only: don't hold the event loop open just for the watchdog (browsers
    // have no unref, hence the guard).
    if (this._stallTimer && typeof this._stallTimer.unref === "function") this._stallTimer.unref();
  }

  _stopStallWatchdog() {
    if (!this._stallTimer) return;
    clearInterval(this._stallTimer);
    this._stallTimer = null;
  }

  /**
   * A snapshot of live process state, for answering "it's just sitting there" without
   * access to the machine. Surfaced to the page as `__vv.diag()`.
   *
   * The two silence numbers are the point: `sinceOutputMs` is what the user perceives,
   * `sinceSyscallMs` is whether the process is actually doing anything. Busy and
   * silent (high output silence, low syscall silence, climbing `syscalls`) is a slow
   * install; silent on both is wedged. Call it twice a few seconds apart — the delta
   * in `syscalls` settles it immediately.
   */
  diagnostics() {
    const now = Date.now();
    return {
      now,
      procs: [...this.procs.values()].map((p) => ({
        pid: p.pid,
        ppid: p.parentPid ?? 0,
        command: [p.command, ...(p.args || [])].join(" "),
        cwd: p.cwd,
        sinceOutputMs: now - p.lastOutput,
        sinceSyscallMs: now - p.lastActivity,
        syscalls: p.syscalls,
        // Uncaught errors inside the worker: NOT deaths, but a flood of them is a
        // strong hint (see handleWorkerError).
        workerErrors: p.workerErrors,
        firstWorkerError: p.firstWorkerError,
        booted: p.booted,
        paused: this.debugPaused.has(p.pid),
      })),
      // Fetch scratch state, so a stuck install can be told from a stuck download.
      fetch: {
        inflight: this._fetchInflight ? this._fetchInflight.size : 0,
        queued: this._fetchQueue ? this._fetchQueue.length : 0,
        active: this._fetchActive || 0,
        cachedEntries: this.fetchCache.size,
        cachedBytes: this._fetchCacheBytes,
        pinnedBodies: this._fetchBodyPins.size,
      },
      listeners: [...this.listeners.keys()],
      pendingHttp: this.pendingHttp ? this.pendingHttp.size : 0,
    };
  }

  finalize(pid, code, signal = null, error = null) {
    const proc = this.procs.get(pid);
    if (!proc || proc.finalized) return;
    proc.finalized = true;
    // However we got here — the process exited on its own, a grace window ran
    // out, something killed it outright — any armed grace timer is now moot.
    if (proc.graceTimer != null) {
      clearTimeout(proc.graceTimer);
      proc.graceTimer = null;
      proc.gracePending = null;
    }
    // Cascade to the subtree: terminating a process takes down every process it
    // spawned. Tools spawn servers behind a shell wrapper (`nest start` runs the
    // app as `sh -c "node ... dist/main"`), so if we only killed the shell the
    // real server would be orphaned and keep its port bound — the next restart
    // would then hit EADDRINUSE (NestJS's watch-mode reload does exactly this).
    // Well-behaved parents await their children before exiting, so on a normal
    // exit there are no live children here; this only bites on an actual kill.
    for (const [cpid, cproc] of this.procs) {
      if (cproc.parentPid === pid && !cproc.finalized) {
        this.finalize(cpid, signal === "SIGKILL" ? 137 : 143, signal || "SIGTERM");
      }
    }
    try {
      proc.handle && proc.handle.terminate();
    } catch {
      /* ignore */
    }
    this.procs.delete(pid);
    // Breakpoint debugger: drop the target's debug channel + state and tell the UI
    // it went away (so the studio can detach the frontend).
    if (this.debugSabs.has(pid)) {
      this.debugSabs.delete(pid);
      this.debugViews.delete(pid);
      this.debugQueue.delete(pid);
      this.debugPaused.delete(pid);
      if (this.onDebugTarget) this.onDebugTarget(pid, false, {});
    }
    // Any fetched body this process was handed but never read would otherwise stay
    // pinned for the rest of the session.
    this._releaseFetchBodiesForPid(pid);
    // Drop any ports this process was serving and fail its in-flight requests,
    // so a fetch that was waiting on a now-dead server does not hang forever.
    for (const [port, owner] of this.listeners) {
      if (owner === pid) {
        this.listeners.delete(port);
        if (this.onClose) this.onClose(port, pid);
      }
    }
    for (const [reqId, pend] of this.pendingHttp) {
      if (pend.pid === pid) {
        pend.resolve({
          status: 502,
          headers: { "content-type": "text/plain" },
          body: "server process exited\n",
        });
        // A large body spilled to the VFS for this request never got read (and
        // unlinked) by the guest. The VFS lives in Wasm RAM, so an upload
        // abandoned mid-flight would hold onto it for the rest of the session.
        const spilled = `/var/run/vv-http/${reqId}.bin`;
        if (this.exists(spilled)) this.unlink(spilled);
        this.pendingHttp.delete(reqId);
      }
    }
    // Tear down any ws tunnels this process owned, telling the browser they closed.
    for (const [connId, owner] of this.wsConns) {
      if (owner === pid) {
        this.wsConns.delete(connId);
        if (this.onWsSend) this.onWsSend({ connId, sub: "close", code: 1006 });
      }
    }
    // Tear down any SSE tunnels this process owned, telling the browser they closed.
    for (const [connId, owner] of this.sseConns) {
      if (owner === pid) {
        this.sseConns.delete(connId);
        if (this.onSseSend) this.onSseSend({ connId, sub: "close" });
      }
    }
    // Drop any pipe (UNIX socket) servers this process hosted, and tear down every
    // cross-process pipe connection it was a party to — telling the surviving peer
    // the socket closed so its reads see EOF instead of hanging forever.
    for (const [path, owner] of this.pipeListeners) {
      if (owner === pid) this.pipeListeners.delete(path);
    }
    for (const [connId, conn] of this.pipeConns) {
      if (conn.clientPid === pid || conn.serverPid === pid) {
        const otherPid = conn.clientPid === pid ? conn.serverPid : conn.clientPid;
        this.postToProc(otherPid, { type: "pipe-close", connId });
        this.pipeConns.delete(connId);
      }
    }
    const result = {
      code,
      pid,
      signal,
      // Non-null only when the process died of a worker fault rather than exiting.
      // Consumers can treat it as "this code is not the program's own exit status".
      error,
      stdout: proc.outBuf.join(""),
      stderr: proc.errBuf.join(""),
      // The invocation, so an observer (kernel-worker's onProcExit) can tell that
      // e.g. an `npm install` in a given cwd just finished and snapshot its deps.
      command: proc.command,
      args: proc.args || [],
      cwd: proc.cwd,
    };
    // A worker fault goes to onError when a caller asked for one (start()), so it can
    // reject rather than look like a clean non-zero exit. Everything else — and every
    // caller that only wired onExit — settles exactly as before.
    if (error && proc.onError) proc.onError(result);
    else if (proc.onExit) proc.onExit(result);
    if (this.onProcExit) this.onProcExit(pid, result);
    if (!this.procs.size) this._stopStallWatchdog();
  }

  /**
   * Spawn a long-running background process and return its pid *immediately*
   * (unlike start(), which resolves only when the process exits). Used by the
   * demo host to launch a server it later needs to stop and restart (e.g. the
   * NestJS demo's edit → recompile → restart flow). Returns -1 if not found.
   */
  launch(command, args = [], opts = {}) {
    const cwd = opts.cwd || "/";
    const programPath = this.resolveProgram(command, cwd, opts.env || {});
    if (!programPath) return -1;
    return this.createProcess(
      // Carry `command` so downstream logic keyed on it works — notably the
      // breakpoint debugger's skip-list (`sh`/`npm`/…): without it a debug-mode
      // shell has command=undefined and is wrongly treated as a debug target, so
      // auto-attach lands on the shell instead of the `node` the user runs.
      { command, programPath, args, cwd, env: opts.env || {} },
      { capture: !!opts.capture },
    );
  }

  /** Stop a running process: terminate its worker + release its ports. */
  stop(pid) {
    if (this.procs.has(pid)) this.finalize(pid, 143, "SIGTERM");
  }

  /** Start a top-level process; resolves with { pid, code, stdout, stderr }. */
  start(command, args = [], opts = {}) {
    const cwd = opts.cwd || "/";
    const programPath = this.resolveProgram(command, cwd, opts.env || {});
    return new Promise((resolve, reject) => {
      if (!programPath) {
        resolve({ pid: -1, code: 127, stdout: "", stderr: command + ": not found\n" });
        return;
      }
      const pid = this.createProcess(
        { command, programPath, args, cwd, env: opts.env || {} },
        { capture: !!opts.capture },
      );
      const proc = this.procs.get(pid);
      proc.onExit = resolve;
      // A worker fault is not an exit status, so reject rather than hand back a
      // fabricated code the caller would read as the program's own. The result is
      // attached so stdout/stderr collected before the fault aren't lost. This
      // promise had NO reject path before: a dead worker left it pending forever.
      proc.onError = (result) => {
        const err = new Error(`${command}: ${result.error || "process worker died"}`);
        err.code = "EPROCFAIL";
        err.result = result;
        reject(err);
      };
    });
  }

  // ---- syscall servicing ----------------------------------------------------
  respondOk(proc, bytes) {
    // A payload larger than the window used to surface as `RangeError: offset is
    // out of bounds` from deep inside Uint8Array.set, which killed the kernel and
    // named neither the syscall nor the size. Anything that can grow must spill
    // out of band (see _stageInboundBody); this says so when something forgets.
    if (bytes.length > DATA_BYTES) {
      throw new Error(
        `kernel: syscall response of ${bytes.length} bytes exceeds the ${DATA_BYTES}-byte window — ` +
          "chunk it or pass it through the VFS",
      );
    }
    proc.data.set(bytes, 0);
    Atomics.store(proc.ctrl, I_RES_LEN, bytes.length);
    Atomics.store(proc.ctrl, I_STATE, STATE_RESPONSE_OK);
    Atomics.notify(proc.ctrl, I_STATE);
  }
  respondErr(proc, code) {
    const bytes = encodeString(code);
    proc.data.set(bytes, 0);
    Atomics.store(proc.ctrl, I_RES_LEN, bytes.length);
    Atomics.store(proc.ctrl, I_STATE, STATE_RESPONSE_ERR);
    Atomics.notify(proc.ctrl, I_STATE);
  }

  serviceSyscall(pid) {
    const proc = this.procs.get(pid);
    if (!proc) return;
    // A syscall proves the process is alive and doing work, but NOT that the user can
    // see anything — npm's reify writes ~12k files without printing a line. So it
    // stamps lastActivity (and counts, as evidence for diagnostics) but deliberately
    // does NOT touch lastOutput, which is what the stall watchdog keys on.
    proc.lastActivity = Date.now();
    proc.syscalls++;
    proc.booted = true;
    const opcode = Atomics.load(proc.ctrl, I_OPCODE);
    // EVERY field below was chosen by the guest. A handler that throws on a
    // malformed one used to take the kernel with it: `Bun.spawn()` with no
    // arguments reached resolveProgram as `undefined` and the TypeError escaped
    // through this method into the worker's message handler. In the browser that
    // is the whole VM — all processes, the VFS session, the preview — lost to one
    // typo in a guest script. The kernel is a trust boundary; a bad request has to
    // come back as an errno.
    try {
      const pending = this.dispatchSyscall(proc, opcode);
      // handleSpawn/handleSpawnAsync/handleFetch are async, so their failures
      // arrive as rejections and the try/catch above cannot see them. This is not
      // hypothetical: the spawn crash happened AFTER an await, which is why it
      // surfaced as an unhandled rejection rather than a caught throw.
      if (pending && typeof pending.then === "function") {
        pending.then(undefined, (err) => this.failSyscall(proc, opcode, err));
      }
    } catch (err) {
      this.failSyscall(proc, opcode, err);
    }
  }

  /**
   * Report a syscall that failed for a reason the handler did not anticipate, and
   * release the caller. Releasing matters as much as reporting: the guest is
   * parked in Atomics.wait on its own SAB, so a handler that dies without
   * answering leaves that process hung for ever.
   *
   * Only answers if nothing else has — a handler may well have responded and then
   * thrown, and a second write into the data region would be read as the answer to
   * whatever syscall the guest makes next.
   */
  failSyscall(proc, opcode, err) {
    const detail = (err && err.stack) || String(err);
    try {
      this.stderr("[kernel] syscall " + opcode + " from pid " + proc.pid + " failed: " + detail + "\n", proc.pid);
    } catch {
      /* the sink is gone; the response below still matters */
    }
    try {
      if (Atomics.load(proc.ctrl, I_STATE) === STATE_REQUEST) this.respondErr(proc, "EINVAL");
    } catch {
      /* the process is gone, so nobody is waiting */
    }
  }

  dispatchSyscall(proc, opcode) {
    const { fields } = decodeRequest(
      proc.data.slice(0, Atomics.load(proc.ctrl, I_REQ_LEN)),
    );
    if (opcode === OP_SPAWN) {
      return this.handleSpawn(proc, JSON.parse(decodeBytes(fields[0])));
      return; // response is deferred until the child exits
    }
    if (opcode === OP_SPAWN_ASYNC) {
      return this.handleSpawnAsync(proc, JSON.parse(decodeBytes(fields[0])));
      return; // responds immediately with {pid}; stdio/exit stream via postMessage
    }
    if (opcode === OP_KILL) {
      this.handleKill(proc, JSON.parse(decodeBytes(fields[0])));
      return;
    }
    if (opcode === OP_ACCEPT) {
      this.handleAccept(proc);
      return; // deferred until a request arrives for one of this proc's ports
    }
    if (opcode === OP_RESPOND) {
      this.handleRespond(proc, fields);
      return; // may span multiple frames (large bodies); resolves on the last
    }
    if (opcode === OP_LISTEN || opcode === OP_CLOSE_SERVER) {
      this.handleNet(proc, opcode, JSON.parse(decodeBytes(fields[0])));
      return;
    }
    if (opcode === OP_PIPE_LISTEN || opcode === OP_PIPE_CONNECT || opcode === OP_PIPE_CLOSE_SERVER) {
      this.handlePipe(proc, opcode, JSON.parse(decodeBytes(fields[0])));
      return;
    }
    if (opcode === OP_FETCH) {
      return this.handleFetch(proc, JSON.parse(decodeBytes(fields[0])));
      return; // deferred until the network fetch resolves
    }
    if (opcode === OP_FETCH_ASYNC) {
      this.handleFetchAsync(proc, JSON.parse(decodeBytes(fields[0])));
      return; // acks immediately; the result streams back via postMessage
    }
    if (opcode === OP_READ_STDIN) {
      this.handleReadStdin(proc);
      return; // deferred until somebody types, unless input is already waiting
    }
    // Since #14, fs opcodes are serviced by the File System Worker directly over
    // the process's SAB — they never reach the kernel. Anything else here is a bug.
    this.respondErr(proc, "ENOSYS");
  }

  // ---- virtual network servicing (brick 5) ----------------------------------
  handleNet(proc, opcode, msg) {
    if (opcode === OP_LISTEN) {
      const port = msg.port | 0;
      const owner = this.listeners.get(port);
      if (owner != null && owner !== proc.pid && this.procs.has(owner)) {
        this.respondErr(proc, "EADDRINUSE");
        return;
      }
      this.listeners.set(port, proc.pid);
      this.respondOk(proc, EMPTY);
      if (this.onListen) this.onListen(port, proc.pid);
      return;
    }
    // OP_CLOSE_SERVER
    const port = msg.port | 0;
    if (this.listeners.get(port) === proc.pid) {
      this.listeners.delete(port);
      if (this.onClose) this.onClose(port, proc.pid);
    }
    this.respondOk(proc, EMPTY);
  }

  // ---- cross-process pipe (UNIX socket) servicing --------------------------
  // The process<->process analogue of handleNet: a server registers a socket path
  // (OP_PIPE_LISTEN), a client in another process resolves it to a connId
  // (OP_PIPE_CONNECT) and the kernel tells the server to accept the connection.
  // After that, raw bytes are relayed by handlePipeRelay (out of band), never here.
  handlePipe(proc, opcode, msg) {
    const path = String(msg.path);
    if (opcode === OP_PIPE_LISTEN) {
      const owner = this.pipeListeners.get(path);
      if (owner != null && owner !== proc.pid && this.procs.has(owner)) {
        this.respondErr(proc, "EADDRINUSE");
        return;
      }
      this.pipeListeners.set(path, proc.pid);
      this.respondOk(proc, EMPTY);
      return;
    }
    if (opcode === OP_PIPE_CLOSE_SERVER) {
      if (this.pipeListeners.get(path) === proc.pid) this.pipeListeners.delete(path);
      this.respondOk(proc, EMPTY);
      return;
    }
    // OP_PIPE_CONNECT: resolve the path to a live server and open a connection.
    const serverPid = this.pipeListeners.get(path);
    if (serverPid == null || !this.procs.has(serverPid)) {
      this.respondErr(proc, "ENOENT");
      return;
    }
    const connId = this.nextPipeConnId++;
    this.pipeConns.set(connId, { clientPid: proc.pid, serverPid });
    // Tell the server to build its endpoint and accept; the client learns the
    // connId from the OK reply below and starts relaying bytes.
    this.postToProc(serverPid, { type: "pipe-open", connId, path });
    this.respondOk(proc, encodeString(JSON.stringify({ connId })));
  }

  // A process produced bytes / a half-close / a teardown for one of its
  // cross-process pipe connections. Forward the message verbatim to the OTHER end
  // (client<->server), keyed by connId. On close, drop the connection record.
  handlePipeRelay(fromPid, m) {
    if (!m || typeof m !== "object") return;
    const conn = this.pipeConns.get(m.connId);
    if (!conn) return;
    const otherPid = fromPid === conn.clientPid ? conn.serverPid : conn.clientPid;
    this.postToProc(otherPid, m);
    if (m.type === "pipe-close") this.pipeConns.delete(m.connId);
  }

  // OP_RESPOND: the server produced an HTTP response and unblocks whoever issued
  // the request. field0 = JSON metadata {reqId,status,headers,bodyEncoding,total},
  // field1 = a raw body chunk. Large bodies arrive as several sequential frames
  // (the 1 MiB SAB window can't hold them at once); we accumulate the raw bytes by
  // reqId and resolve once `total` is reached, decoding the body exactly once.
  // `bodyEncoding:'base64'` marks a binary body the runtime base64-encoded so it
  // could cross as text; the Service Worker decodes it back to bytes (#19 stage A).
  handleRespond(proc, fields) {
    const meta = JSON.parse(decodeBytes(fields[0]));
    const chunk = fields[1];
    const pend = this.pendingHttp.get(meta.reqId);
    if (pend) {
      const acc = pend.acc || (pend.acc = { parts: [], len: 0 });
      // fields are subarray views into the SAB — copy before it's reused.
      if (chunk && chunk.length) {
        acc.parts.push(chunk.slice());
        acc.len += chunk.length;
      }
      if (acc.len >= (meta.total | 0)) {
        let bytes;
        if (acc.parts.length === 1) {
          bytes = acc.parts[0];
        } else {
          bytes = new Uint8Array(acc.len);
          let o = 0;
          for (const p of acc.parts) {
            bytes.set(p, o);
            o += p.length;
          }
        }
        pend.resolve({
          status: meta.status,
          headers: meta.headers,
          body: decodeBytes(bytes),
          bodyEncoding: meta.bodyEncoding,
        });
        this.pendingHttp.delete(meta.reqId);
      }
    }
    // Unblock the server so it can loop back to accept (per frame).
    this.respondOk(proc, EMPTY);
  }

  // Non-blocking accept (Phase 2 #5): the process event loop calls this after a
  // `net` nudge and drains in a loop, so we never park. Empty reply = inbox drained.
  handleAccept(proc) {
    if (proc.serverInbox.length) {
      this.respondOk(proc, encodeString(JSON.stringify(proc.serverInbox.shift())));
    } else {
      this.respondOk(proc, EMPTY);
    }
  }

  // Prepare an inbound body for the trip to the process worker.
  //
  // Two hazards, both of which used to be silent. JSON has no bytes, so a
  // Buffer body serialised to {type:'Buffer',data:[…]} and the guest's
  // creq.end() never completed — the request HUNG. And the frame is 1 MiB, so a
  // large upload overran the window and took the kernel down with a RangeError
  // out of respondOk.
  //
  // Small bodies cross inline, in the {body, bodyEncoding:'base64'} shape the
  // response direction already uses. Anything bigger goes through the VFS
  // instead — the same escape hatch fetch bodies use — and the guest reads it
  // back with plain fs.
  async _stageInboundBody(req, reqId) {
    const bytes = inboundBodyBytes(req);
    if (!bytes) return req;
    const size = bytes.byteLength;
    if (size <= INBOX_INLINE_MAX) {
      const asUtf8 = new TextDecoder().decode(bytes);
      const roundTrip = new TextEncoder().encode(asUtf8);
      const lossless = roundTrip.length === size && roundTrip.every((b, i) => b === bytes[i]);
      // base64 inflates by 4/3, so a body that fits raw may not fit encoded.
      if (lossless) return { ...req, body: asUtf8, bodyEncoding: undefined };
      const b64 = bytesToB64(bytes);
      if (b64.length <= INBOX_INLINE_MAX) return { ...req, body: b64, bodyEncoding: "base64" };
    }
    const path = `/var/run/vv-http/${reqId}.bin`;
    this.mkdirp("/var/run/vv-http");
    // writeLarge transfers the buffer, so anything read off `bytes` must be
    // captured first (see the fetch path, which has the same footgun).
    await this.fs.writeLarge(path, bytes);
    return { ...req, body: "", bodyEncoding: undefined, bodyPath: path };
  }

  /** The jar for a port, created on first use (most ports never set a cookie). */
  _jarFor(port) {
    let jar = this.cookieJars.get(port);
    if (!jar) this.cookieJars.set(port, (jar = new CookieJar()));
    return jar;
  }

  /**
   * Put the port's cookies on an inbound request. Nothing else in the stack can:
   * the browser adds `Cookie` after the Service Worker, so the SW never sees one
   * to forward, and a `Set-Cookie` the SW synthesised never entered the browser's
   * store to begin with. Without this a login's very next request arrives with no
   * cookie at all and the app answers 401 while looking perfectly correct.
   */
  _attachCookies(port, req) {
    const jar = this.cookieJars.get(port);
    if (!jar || jar.size === 0) return req;
    // A caller that sent its own `Cookie` is the authority on that request, and the
    // jar stays out of it entirely. Merging instead was the first attempt, and
    // spike-bun.mjs caught what is wrong with it: a driver that hands over an
    // explicit `Cookie: a=1; b=2` is describing one client, and quietly adding a
    // session another client left in the jar cross-contaminates them. This costs
    // nothing on the real path — the browser attaches `Cookie` after the Service
    // Worker, so a request from the preview never arrives with one.
    const headers = req.headers || {};
    if (Object.keys(headers).some((k) => k.toLowerCase() === "cookie")) return req;
    const value = jar.header(req.url || "/");
    if (!value) return req;
    return { ...req, headers: { ...headers, cookie: value } };
  }

  /** Take the response's Set-Cookie into the port's jar. */
  _harvestCookies(port, requestUrl, resp) {
    const headers = resp && resp.headers;
    if (!headers) return;
    const key = Object.keys(headers).find((k) => k.toLowerCase() === "set-cookie");
    if (!key) return;
    const path = String(requestUrl || "/").split("?")[0] || "/";
    this._jarFor(port).store(headers[key], path);
  }

  /**
   * Route an inbound HTTP request to the process listening on `port`.
   * Returns a Promise<{status,headers,body}>. This is the kernel's public
   * entry point for the Service Worker (browser) or tests (node).
   */
  async handleHttpRequest(port, req) {
    const pid = this.listeners.get(port | 0);
    if (pid == null || !this.procs.has(pid)) {
      return {
        status: 502,
        headers: { "content-type": "text/plain" },
        body: `No server listening on port ${port}\n`,
      };
    }
    const proc = this.procs.get(pid);
    const reqId = this.nextReqId++;
    req = await this._stageInboundBody(req, reqId);
    req = this._attachCookies(port | 0, req);
    return new Promise((resolve) => {
      this.pendingHttp.set(reqId, {
        resolve: (resp) => {
          this._harvestCookies(port | 0, req.url, resp);
          resolve(resp);
        },
        pid,
      });
      proc.serverInbox.push({ reqId, port: port | 0, req });
      // Nudge the process's event loop (Phase 2 #5). It wakes, drains the inbox
      // via non-blocking accept, and replies through OP_RESPOND.
      try {
        proc.handle && proc.handle.postMessage && proc.handle.postMessage({ type: "net" });
      } catch {
        /* worker gone; finalize() will 502 the pending request */
      }
    });
  }

  // ---- WebSocket tunnel routing (roadmap #19 stage C) -----------------------
  // A message from the browser preview's ws polyfill (relayed by the environment
  // as {sub:'open'|'send'|'close', connId, ...}). 'open' binds the connId to the
  // process listening on `port`; 'send'/'close' forward to that process.
  handleWsClient(msg) {
    const { sub, connId } = msg;
    if (sub === "open") {
      let port = msg.port | 0;
      let pid = this.listeners.get(port);
      // The browser ws polyfill routes by the ws URL's explicit :port, which can
      // guess wrong (e.g. a URL that carried the studio origin's port, or an aux
      // port that isn't up yet). If nothing is listening there, fall back to the
      // iframe's own preview port so the common single-port case still connects.
      if ((pid == null || !this.procs.has(pid)) && msg.fallbackPort != null) {
        const fp = msg.fallbackPort | 0;
        const fpid = this.listeners.get(fp);
        if (fpid != null && this.procs.has(fpid)) {
          port = fp;
          pid = fpid;
        }
      }
      if (pid == null || !this.procs.has(pid)) {
        if (this.onWsSend) this.onWsSend({ connId, sub: "close", code: 1006 });
        return;
      }
      this.wsConns.set(connId, pid);
      this.postToProc(pid, {
        type: "ws-open",
        connId,
        port,
        path: msg.path || "/",
        protocols: msg.protocols || null,
      });
      return;
    }
    const pid = this.wsConns.get(connId);
    if (pid == null) return;
    if (sub === "send") {
      this.postToProc(pid, { type: "ws-in", connId, data: msg.data });
    } else if (sub === "close") {
      this.wsConns.delete(connId);
      this.postToProc(pid, { type: "ws-close", connId, code: msg.code, reason: msg.reason });
    }
  }

  // A process relayed a ws frame outward ({connId, sub:'open'|'msg'|'close', ...}).
  handleWsOut(pid, m) {
    if (!m || typeof m !== "object") return;
    if (m.sub === "close") this.wsConns.delete(m.connId);
    if (this.onWsSend) this.onWsSend(m);
  }

  // ---- Server-Sent Events tunnel routing ------------------------------------
  // A message from the browser preview's EventSource polyfill (relayed by the
  // environment as {sub:'open'|'close', connId, ...}). 'open' binds the connId to
  // the process listening on `port`; 'close' tears the relay down. Mirrors
  // handleWsClient, minus the client->server 'send' leg (SSE is one-way).
  handleSseClient(msg) {
    const { sub, connId } = msg;
    if (sub === "open") {
      let port = msg.port | 0;
      let pid = this.listeners.get(port);
      // Same fallback as ws: the polyfill routes by the URL's port, which can miss
      // (studio-origin port, or an aux port not up yet); fall back to the iframe's
      // own preview port so the common single-port case still connects.
      if ((pid == null || !this.procs.has(pid)) && msg.fallbackPort != null) {
        const fp = msg.fallbackPort | 0;
        const fpid = this.listeners.get(fp);
        if (fpid != null && this.procs.has(fpid)) {
          port = fp;
          pid = fpid;
        }
      }
      if (pid == null || !this.procs.has(pid)) {
        if (this.onSseSend) this.onSseSend({ connId, sub: "close" });
        return;
      }
      this.sseConns.set(connId, pid);
      this.postToProc(pid, { type: "sse-open", connId, port, path: msg.path || "/" });
      return;
    }
    const pid = this.sseConns.get(connId);
    if (pid == null) return;
    if (sub === "close") {
      this.sseConns.delete(connId);
      this.postToProc(pid, { type: "sse-close", connId });
    }
  }

  // A process relayed an SSE stream chunk outward ({connId, sub:'open'|'chunk'|
  // 'close', ...}).
  handleSseOut(pid, m) {
    if (!m || typeof m !== "object") return;
    if (m.sub === "close") this.sseConns.delete(m.connId);
    if (this.onSseSend) this.onSseSend(m);
  }

  async handleSpawn(parent, spec) {
    if (!spec || typeof spec !== "object") {
      this.respondErr(parent, "EINVAL");
      return;
    }
    const cwd = spec.cwd || "/";
    // On-demand: if this command is a lazily-registered heavy tool, materialize
    // it (fetch + unpack into the VFS) before resolving. The parent stays parked
    // on Atomics.wait meanwhile; the kernel loop keeps servicing other processes.
    // Pass the parent's pid so the "loading on first use" notice lands in its terminal.
    await this.ensureCommandLoaded(spec.command, parent.pid);
    // The parent may have exited (killed) while the tool was loading.
    if (!this.procs.has(parent.pid)) return;
    const programPath = this.resolveProgram(spec.command, cwd, spec.env || {});
    if (!programPath) {
      this.respondErr(parent, "ENOENT");
      return;
    }
    const childPid = this.createProcess(
      { command: spec.command, programPath, args: spec.args || [], cwd, env: spec.env || {} },
      { parentPid: parent.pid, capture: !!spec.capture },
    );
    this.procs.get(childPid).onExit = (res) => {
      this.respondOk(
        parent,
        encodeString(
          JSON.stringify({
            code: res.code,
            stdout: res.stdout,
            stderr: res.stderr,
            pid: childPid,
          }),
        ),
      );
    };
  }

  // Async spawn (#15): the caller does NOT park — it gets {pid} now and keeps
  // running its event loop. The child streams stdout/stderr to the parent worker
  // (proc.stream) and, on exit, we post {type:'child-exit'} to the parent handle.
  async handleSpawnAsync(parent, spec) {
    if (!spec || typeof spec !== "object") {
      this.respondErr(parent, "EINVAL");
      return;
    }
    const cwd = spec.cwd || "/";
    // On-demand load of heavy tools before resolving (see handleSpawn). The {pid}
    // ack simply arrives once the tool is materialized on PATH. Pass the parent's
    // pid so the "loading on first use" notice lands in its terminal.
    await this.ensureCommandLoaded(spec.command, parent.pid);
    if (!this.procs.has(parent.pid)) return; // parent killed while loading
    const programPath = this.resolveProgram(spec.command, cwd, spec.env || {});
    if (!programPath) {
      this.respondErr(parent, "ENOENT");
      return;
    }
    const parentPid = parent.pid;
    const childPid = this.createProcess(
      { command: spec.command, programPath, args: spec.args || [], cwd, env: spec.env || {} },
      { parentPid, stream: true },
    );
    this.procs.get(childPid).onExit = (res) => {
      const p = this.procs.get(parentPid);
      if (p && p.handle && p.handle.postMessage) {
        try {
          p.handle.postMessage({ type: "child-exit", childPid, code: res.code, signal: res.signal || null });
        } catch {
          /* parent gone */
        }
      }
    };
    this.respondOk(parent, encodeString(JSON.stringify({ pid: childPid })));
  }

  // ---- blocking stdin (OP_READ_STDIN) ----------------------------------------
  //
  // A process that reads stdin synchronously cannot receive a postMessage: its
  // thread is parked on Atomics.wait, so its message queue is not being drained.
  // The bytes have to arrive the same way a file's do — written into the SAB and
  // notified. That is all this is.
  //
  // Making the first such call also switches this process's stdin from "post it
  // and let the runtime deliver it on a loop turn" to "hold it here until asked".
  // Without that switch, anything typed between two reads would be delivered to
  // the flowing stream, where the synchronous reader will never look for it, and
  // a line typed a moment early would simply vanish.
  handleReadStdin(proc) {
    proc.syncStdin = true;
    if (proc.stdinQueue && proc.stdinQueue.length) {
      this.respondOk(proc, stdinBytes(proc.stdinQueue.shift()));
      return;
    }
    // Once input has ended it stays ended: a reader that parked here would never
    // be woken by anything, which is a hung tab rather than an EOFError.
    if (proc.stdinEnded) {
      this.respondOk(proc, EMPTY);
      return;
    }
    // A captured process has no way to be typed at — it is the shape used by
    // `spawnSync` and by internal `kernel.start` calls, where the only party who
    // could send stdin is itself parked waiting for this one to exit. Parking
    // would be a guaranteed deadlock, so it reads as end of input, exactly like
    // running a script with its stdin closed.
    if (proc.capture) {
      this.respondOk(proc, EMPTY);
      return;
    }
    proc.stdinWaiting = true;
  }

  // Push a stdin chunk into a running process' own process.stdin. `chunk` is a
  // string (host terminal / a live shell) OR a Uint8Array/Buffer (binary-safe
  // parent -> child piping via handleChildStdin), or null for EOF. Bytes pass
  // through unchanged — the runtime's drainStdin normalizes to a Buffer — so we
  // must NOT stringify, or binary stdin would be mangled. No-op if the process
  // is gone.
  sendStdin(pid, chunk) {
    const proc = this.procs.get(pid | 0);
    // A synchronous reader (see handleReadStdin) takes delivery through the SAB,
    // parked or not — queued if it is between reads, handed over directly if it
    // is waiting for exactly this.
    if (proc && proc.syncStdin) {
      if (chunk == null) proc.stdinEnded = true;
      if (proc.stdinWaiting) {
        proc.stdinWaiting = false;
        this.respondOk(proc, chunk == null ? EMPTY : stdinBytes(chunk));
      } else {
        (proc.stdinQueue || (proc.stdinQueue = [])).push(chunk);
      }
      return true;
    }
    return this.postToProc(pid | 0, { type: "stdin", chunk: chunk == null ? null : chunk });
  }

  // A process wrote to one of its children's stdin (child.stdin.write): relay the
  // bytes to that child's own process.stdin, unchanged (string or Uint8Array). We
  // don't verify parentage — the pid came from a ChildProcess this parent holds —
  // but only deliver to live procs.
  handleChildStdin(parentPid, m) {
    if (!m || typeof m !== "object") return;
    const childPid = m.childPid | 0;
    if (this.procs.has(childPid)) this.sendStdin(childPid, m.chunk == null ? null : m.chunk);
  }

  // ---- signals ---------------------------------------------------------------
  // The guest announces that it gained (or lost) a listener for a catchable
  // signal. This is the whole opt-in: with no listener a signal is applied to the
  // process (terminate now, as it always was), with one it is delivered to it.
  handleSignalListen(pid, m) {
    const proc = this.procs.get(pid);
    if (!proc || !m || !isCatchableSignal(m.signal)) return;
    if (m.active) proc.sigHandlers.add(m.signal);
    else proc.sigHandlers.delete(m.signal);
  }

  // The guest ran its handler and is still here on purpose. Stand the force-kill
  // window down: it exists to catch a process that took a catchable signal and
  // then did nothing, not one that answered. A Python REPL that turns Ctrl-C
  // into a KeyboardInterrupt and prints a fresh prompt is answering.
  //
  // The next same signal is therefore a NEW one rather than an escalation, which
  // is what makes two deliberate Ctrl-Cs at a live prompt two interrupts.
  handleSignalHandled(pid, m) {
    const proc = this.procs.get(pid);
    if (!proc || !m || !m.signal) return;
    if (proc.sigUnhandled === m.signal) proc.sigUnhandled = null;
    if (proc.graceTimer != null && proc.gracePending === m.signal) {
      clearTimeout(proc.graceTimer);
      proc.graceTimer = null;
      proc.gracePending = null;
    }
  }

  /**
   * Send `name` to a running process. Returns false if the pid is gone.
   *
   * Uncatchable signals, and every signal the target has no handler for, take
   * the path this has always taken: finalize() right here, synchronously, with
   * the same exit codes. That matters beyond fidelity — a caller that kills a
   * process and immediately respawns it (NestJS watch mode) depends on the port
   * being free by the time kill() returns.
   *
   * A caught signal is posted instead: bits into the target's syscall SAB (so a
   * worker parked in Atomics.wait can see it) plus a message (so an idle one
   * gets it within a turn), and a grace window after which we terminate it the
   * old way regardless. Internal teardown paths — stop(), the subtree cascade,
   * thread termination — deliberately do not come through here: they must not be
   * interceptable.
   */
  signal(pid, name = "SIGTERM") {
    const proc = this.procs.get(pid);
    if (!proc || proc.finalized) return false;
    const sig = String(name);

    if (!isCatchableSignal(sig) || !proc.sigHandlers.has(sig)) {
      this.finalize(pid, defaultSignalExitCode(sig), sig);
      return true;
    }

    // Repeating a signal the guest has not answered yet escalates to a
    // force-kill. This is not POSIX — a second SIGTERM would just run the
    // handler again — but it is what a person hammering Ctrl-C in the shell
    // means, and it cannot be worse than today, where the FIRST one already
    // killed outright.
    //
    // "Not answered yet" rather than "grace window still open", because a guest
    // that handled the signal and legitimately carried on (a Python REPL taking
    // a KeyboardInterrupt back to its prompt) stands the window down — and two
    // deliberate Ctrl-Cs at a prompt that is answering them are two interrupts,
    // not an execution.
    if (proc.sigUnhandled === sig) {
      this.finalize(pid, defaultSignalExitCode(sig), sig);
      return true;
    }

    postSignal(proc.ctrl, sig);
    this.postToProc(pid, { type: "signal", signal: sig });
    proc.sigUnhandled = sig;

    if (proc.graceTimer == null) {
      proc.gracePending = sig;
      const timer = setTimeout(() => {
        proc.graceTimer = null;
        proc.gracePending = null;
        if (!this.procs.has(pid)) return;
        // Say so. A process that vanishes some seconds after a Ctrl-C, with no
        // explanation, is exactly the kind of mystery this codebase keeps
        // having to un-mystify.
        try {
          this.stderr(
            `\x1b[33mvivari: pid ${pid} did not exit within ${this.signalGraceMs}ms of ${sig}; forcing termination.\x1b[0m\r\n`,
            pid,
          );
        } catch {
          /* sink gone */
        }
        this.finalize(pid, defaultSignalExitCode(sig), sig);
      }, this.signalGraceMs);
      // Never let a pending grace window be the reason a host stays alive.
      if (timer && typeof timer.unref === "function") timer.unref();
      proc.graceTimer = timer;
    }
    return true;
  }

  // OP_KILL. We ack the killer first (it called sys.kill synchronously and is
  // parked on it), then deliver — the target may BE the killer's parent, and the
  // signal path can post messages, so the shared window must be free first.
  handleKill(proc, msg) {
    const pid = msg.pid | 0;
    if (!this.procs.has(pid)) {
      this.respondErr(proc, "ESRCH");
      return;
    }
    const raw = msg.signal;
    this.respondOk(proc, EMPTY);
    // Signal 0 is POSIX's existence probe: no signal is sent, and the ESRCH
    // check above already IS the answer. It used to fall through to the
    // `|| "SIGTERM"` default below and kill the process it was asking about.
    if (raw === 0 || raw === "0") return;
    this.signal(pid, raw || "SIGTERM");
  }

  // ---- worker_threads brokering (#16 stage 2b) ------------------------------
  // A process' worker_threads asks us to spawn a nested thread worker. Unlike a
  // child process (#15) the thread talks to its creator directly over a
  // MessageChannel (data.port -> the child's parentPort); we only allocate its
  // syscall SAB + FS registration and relay online/exit back to the creator.
  handleThreadSpawn(parentPid, data) {
    const parent = this.procs.get(parentPid);
    if (!parent) return;
    // Every handler reached from the worker message table starts with a shape
    // check, because the message is only as trustworthy as the process it came
    // from — which, in a browser, means guest code could have posted it. A message
    // that carries nothing to act on is DROPPED rather than answered: there is no
    // caller parked on a reply here (unlike a syscall), so silence is the whole
    // correct response. This one used to throw on a bare `{}`, and the throw took
    // the kernel with it.
    if (!data || typeof data !== "object" || !data.spec || typeof data.spec !== "object") return;
    const { reqId, spec, port } = data;
    const cwd = spec.cwd || "/";
    const programPath = this.resolvePath(cwd, spec.programPath || "");
    if (!programPath || !this.isFile(programPath)) {
      // No such entry: report online then a failed exit so `new Worker()` sees
      // 'online' -> 'exit' (code 1) rather than hanging.
      this.postToProc(parentPid, { type: "thread-started", reqId, threadId: -1 });
      this.postToProc(parentPid, { type: "thread-exit", reqId, code: 1, signal: null });
      return;
    }
    const childPid = this.createProcess(
      {
        programPath,
        args: spec.argv || [],
        cwd,
        env: spec.env || {},
        workerData: spec.workerData,
        isThread: true,
        // child_process.fork rides this same path but boots in fork mode (a
        // main-thread process whose transferred port is a process IPC channel).
        isFork: !!spec.isFork,
      },
      // A fork child streams its stdout/stderr to the parent worker (like an async
      // spawn child) so `fork`'s default 'inherit' stdio surfaces on the PARENT's
      // terminal — not the kernel's global console. Plain worker threads don't.
      { parentPid, threadPort: port, stream: !!spec.isFork },
    );
    if (!parent.threads) parent.threads = new Map();
    parent.threads.set(reqId, childPid);
    const child = this.procs.get(childPid);
    child.onExit = (res) => {
      if (parent.threads) parent.threads.delete(reqId);
      this.postToProc(parentPid, { type: "thread-exit", reqId, code: res.code, signal: res.signal || null });
    };
    // 'online' ~ the worker exists and its JS is starting.
    this.postToProc(parentPid, { type: "thread-started", reqId, threadId: childPid });
  }

  handleThreadTerminate(parentPid, data) {
    const parent = this.procs.get(parentPid);
    if (!parent || !parent.threads) return;
    const childPid = parent.threads.get(data.reqId);
    if (childPid != null) this.finalize(childPid, 143, "SIGTERM");
  }

  // ---- network fetch servicing (Phase 2 #9) ---------------------------------
  // VFS path where a fetched body is materialized. The cache key (method + url +
  // accept) is encodeURIComponent'd into a single flat filename (no '/'), so
  // distinct request variants of the same URL never share a body file.
  // A generation prefix makes every materialized body a DISTINCT path, so a
  // re-fetch of an evicted URL cannot collide with a pending deferred unlink from
  // the previous generation (and two concurrent uncacheable fetches of the same URL
  // no longer clobber each other's body). The cache key stays in the name for
  // debuggability; only the stored meta.path is ever used to read it back.
  _fetchCachePath(cacheKey) {
    return "/var/cache/vv-fetch/" + ++this._fetchBodySeq + "-" + encodeURIComponent(cacheKey);
  }

  // ---- fetched-body lifetime ------------------------------------------------
  // A body must outlive its readers. `_pinFetchBody` is called for EVERY handoff of
  // a meta to a process (fresh download, cache hit, or in-flight share);
  // `releaseFetchBody` is called by the FS layer once a read of that path has
  // finished (fd closed, or a whole-file read serviced). See fs-server.js.
  _pinFetchBody(path, pid) {
    if (!path) return;
    const pins = this._fetchBodyPins.get(path);
    if (pins) pins.push(pid | 0);
    else this._fetchBodyPins.set(path, [pid | 0]);
  }

  /**
   * The FS layer observed a completed read of a fetched body. Drops one reference;
   * the file is unlinked when the last one goes IF eviction already wanted it gone.
   * Safe to call for unknown/duplicate paths — a body read twice simply releases
   * what is there and then no-ops.
   */
  releaseFetchBody(path) {
    const pins = this._fetchBodyPins.get(path);
    if (!pins) return;
    pins.pop();
    if (pins.length) return;
    this._fetchBodyPins.delete(path);
    this._reapFetchBody(path);
  }

  // Backstop: a process can die (or abort a request) without ever reading a body it
  // was handed, which would pin it forever. Its references go when it does, so a
  // missing or unwired release signal can never leak past the process's lifetime.
  _releaseFetchBodiesForPid(pid) {
    if (!this._fetchBodyPins.size) return;
    for (const [path, pins] of this._fetchBodyPins) {
      const kept = pins.filter((p) => p !== pid);
      if (kept.length === pins.length) continue;
      if (kept.length) this._fetchBodyPins.set(path, kept);
      else {
        this._fetchBodyPins.delete(path);
        this._reapFetchBody(path);
      }
    }
  }

  // Unlink a now-unpinned body, but only if eviction already dropped its accounting.
  // Still-cached bodies stay on disk for a future hit until they are evicted.
  _reapFetchBody(path) {
    if (!this._fetchBodyOrphans.delete(path)) return;
    try {
      this.fs.unlink(path);
    } catch {
      /* already gone */
    }
  }

  _fetchCacheKey(method, url, headers) {
    const accept = headers ? headers.accept || headers.Accept || "" : "";
    return method + " " + url + (accept ? " " + accept : "");
  }

  // Run at most `fetchConcurrency` outbound requests at once; queue the rest.
  // `task` is a () => Promise thunk that does one network fetch; the returned
  // promise settles with the task's result once a slot frees up and it runs.
  _scheduleFetch(task) {
    return new Promise((resolve, reject) => {
      this._fetchQueue.push({ task, resolve, reject });
      this._drainFetchQueue();
    });
  }
  _drainFetchQueue() {
    while (this._fetchActive < this.fetchConcurrency && this._fetchQueue.length) {
      const { task, resolve, reject } = this._fetchQueue.shift();
      this._fetchActive++;
      const done = () => {
        this._fetchActive--;
        this._drainFetchQueue();
      };
      task().then(
        (v) => { done(); resolve(v); },
        (e) => { done(); reject(e); },
      );
    }
  }

  // Resolve a request to a body materialized in the VFS, returning small JSON
  // metadata { status, ok, headers, contentType, size, path, cached }. Shared by
  // the blocking (OP_FETCH) and async (OP_FETCH_ASYNC) paths. Handles the content
  // cache, in-flight de-dupe of identical cacheable GETs, and the concurrency cap.
  async _fetchIntoVfs(pid, { url, method = "GET", headers = null, bodyB64 = null }) {
    method = String(method || "GET").toUpperCase();
    // Only idempotent bodyless GETs are cached (npm re-resolving the same
    // packument). Anything with a body / non-GET always hits the network.
    const cacheable = method === "GET" && !bodyB64;
    const cacheKey = this._fetchCacheKey(method, url, headers);
    const cached = cacheable ? this.fetchCache.get(cacheKey) : null;
    if (cached) {
      // LRU touch: re-insert so this entry becomes most-recently-used (Map keeps
      // insertion order), protecting a just-served body from imminent eviction.
      this.fetchCache.delete(cacheKey);
      this.fetchCache.set(cacheKey, cached);
      this._pinFetchBody(cached.path, pid);
      if (this.onFetch) this.onFetch(url, { cached: true, size: cached.size, pid });
      return { ...cached, cached: true };
    }
    if (!this.fetcher) {
      const err = new Error("ENETUNREACH");
      err.code = "ENETUNREACH";
      throw err;
    }
    // A burst of concurrent requests for the same packument (npm resolving the
    // same dep from several branches at once) shares ONE network op + one write.
    if (cacheable && this._fetchInflight.has(cacheKey)) {
      const meta = await this._fetchInflight.get(cacheKey);
      // Sharers read the SAME body file, so each needs its own reference — the last
      // one to finish is what frees it.
      this._pinFetchBody(meta.path, pid);
      if (this.onFetch) this.onFetch(url, { cached: true, size: meta.size, pid });
      return { ...meta, cached: true };
    }
    const work = this._scheduleFetch(() =>
      this._doNetworkFetch({ url, method, headers, bodyB64, cacheKey, cacheable, pid }),
    );
    if (cacheable) {
      this._fetchInflight.set(cacheKey, work);
      const clear = () => { if (this._fetchInflight.get(cacheKey) === work) this._fetchInflight.delete(cacheKey); };
      work.then(clear, clear);
    }
    const meta = await work;
    this._pinFetchBody(meta.path, pid);
    return { ...meta, cached: false };
  }

  // The actual network round-trip: fetch (off-thread, in the Fetcher Worker) and
  // stream the body into the VFS. `method`/`headers`/`bodyB64` (from the http/
  // https client shim, lib/https.js) let a real ClientRequest egress; a bare
  // `{url}` still works (GET).
  async _doNetworkFetch({ url, method, headers, bodyB64, cacheKey, cacheable, pid }) {
    const init = { method, headers: headers || undefined };
    if (bodyB64) init.body = b64ToBytes(bodyB64);
    const res = await this.fetcher(url, init);
    const body = res.body instanceof Uint8Array ? res.body : new Uint8Array(res.body || 0);
    const path = this._fetchCachePath(cacheKey);
    this.mkdirp("/var/cache/vv-fetch");
    // Normalize response headers to a lowercased plain object and drop the
    // content-* encoding hints: the Fetcher Worker's fetch() already returns a
    // DECODED body (gzip/br transfer-encoding stripped), so leaving these would
    // make the client (npm) try to gunzip an already-plain body or mismatch the
    // length. The body's own format (e.g. a .tgz) is untouched.
    const headersOut = {};
    const raw = res.headers || {};
    const put = (k, v) => {
      const lk = String(k).toLowerCase();
      if (lk === "content-encoding" || lk === "content-length") return;
      headersOut[lk] = v;
    };
    if (typeof raw.forEach === "function" && !Array.isArray(raw)) raw.forEach((v, k) => put(k, v));
    else for (const k of Object.keys(raw)) put(k, raw[k]);
    // Capture size before writeLarge: it transfers (detaches) body.buffer, after
    // which body.byteLength reads 0.
    const meta = {
      status: res.status | 0,
      statusText: res.statusText || "",
      ok: !!res.ok,
      headers: headersOut,
      contentType: headersOut["content-type"] || "",
      size: body.byteLength,
      path,
    };
    // Large body bypasses the 1 MiB SAB: hand it to the FS Worker over a
    // transferable buffer, then the process reads it back with normal fs (#14).
    await this.fs.writeLarge(path, body);
    if (cacheable) {
      this.fetchCache.set(cacheKey, meta);
      this._fetchCacheBytes += meta.size | 0;
      this._evictFetchCacheIfNeeded(cacheKey);
    }
    if (this.onFetch) this.onFetch(url, { cached: false, size: meta.size, pid });
    return meta;
  }

  // Evict least-recently-used fetched bodies until the cache is back under its
  // byte cap, freeing each body's VFS file as it goes. `protectKey` (the entry we
  // just added) is never evicted, so a fresh download is always available to the
  // process about to read it back.
  //
  // Dropping the ACCOUNTING is unconditional, so the cap is always honoured. The
  // FILE is only unlinked here when nothing holds a reference to it; a pinned body
  // becomes an orphan and is reaped by the last release (or its process's exit).
  // Without that, eviction could delete a body a process had been handed but not
  // yet read — see the constructor note.
  _evictFetchCacheIfNeeded(protectKey) {
    if (this._fetchCacheBytes <= this.fetchCacheMaxBytes) return;
    for (const [key, meta] of this.fetchCache) {
      if (this._fetchCacheBytes <= this.fetchCacheMaxBytes) break;
      if (key === protectKey) continue;
      this.fetchCache.delete(key);
      this._fetchCacheBytes -= meta.size | 0;
      if (this._fetchBodyPins.has(meta.path)) {
        this._fetchBodyOrphans.add(meta.path);
        continue;
      }
      try {
        this.fs.unlink(meta.path);
      } catch {
        /* already gone / never materialized — nothing to free */
      }
    }
  }

  // Deferred like handleSpawn: the caller stays parked on Atomics.wait while we
  // fetch and stream the body into the VFS, then wakes with the JSON metadata.
  async handleFetch(proc, req) {
    try {
      const meta = await this._fetchIntoVfs(proc.pid, req);
      // Process may have exited while the fetch was in flight.
      if (!this.procs.has(proc.pid)) return;
      this.respondOk(proc, encodeString(JSON.stringify(meta)));
    } catch (err) {
      if (!this.procs.has(proc.pid)) return;
      this.respondErr(proc, typeof err === "string" ? err : String(err?.message || "EFETCH"));
    }
  }

  // Async fetch (parallel downloads): the caller does NOT park — it gets an empty
  // ack now and keeps running its event loop, issuing more fetches. When this one
  // settles we post the outcome to the caller's worker (never over the SAB), so
  // many downloads proceed at once (bounded by fetchConcurrency). See OP_FETCH_ASYNC.
  handleFetchAsync(proc, req) {
    const pid = proc.pid;
    const fetchId = req.fetchId | 0;
    // Acknowledge receipt immediately so the caller's loop keeps going.
    this.respondOk(proc, EMPTY);
    this._fetchIntoVfs(pid, req).then(
      (meta) => {
        this.postToProc(pid, { type: "fetch-done", fetchId, ok: true, meta });
      },
      (err) => {
        this.postToProc(pid, {
          type: "fetch-done",
          fetchId,
          ok: false,
          error: typeof err === "string" ? err : String(err?.message || "EFETCH"),
        });
      },
    );
  }

}