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
} from "../protocol/syscall.js";
import { DBG_SAB_BYTES, makeDebugViews, writeDebugCommand } from "../protocol/debug.js";
import { COREUTILS } from "./coreutils.js";

const EMPTY = new Uint8Array(0);

// Decode a base64 request body (from the http/https client shim) to bytes,
// working in both the Node kernel host (Buffer) and a browser main thread (atob).
function b64ToBytes(b64) {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class Kernel {
  constructor({ fs, spawnWorker, stdout, stderr, fetcher }) {
    this.fs = fs;
    this.spawnWorker = spawnWorker;
    this.stdout = stdout || (() => {});
    this.stderr = stderr || (() => {});
    this.procs = new Map(); // pid -> process record
    this.nextPid = 1;
    this.onProcExit = null; // optional observer (pid, result)

    // ---- virtual network (brick 5) ----
    this.listeners = new Map(); // port -> pid of the server process
    this.pendingHttp = new Map(); // reqId -> { resolve, pid }
    this.nextReqId = 1;
    this.onListen = null; // optional observer (port, pid) — e.g. wire a preview

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
    // fetchCache entry AND its VFS file — once we exceed the cap. Because meta and
    // body file are evicted together, "meta present ⟺ body present" stays true, so
    // a cache hit never points at a missing file.
    this.fetchCacheMaxBytes = 128 * 1024 * 1024; // 128 MiB scratch ceiling
    this._fetchCacheBytes = 0; // running total of cached body sizes

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
      finalized: false,
      handle: null,
      command: spec.command,
      // The launch args, kept so process exit can report the full invocation (e.g.
      // detecting an `npm install` completing, to snapshot the dependency cache).
      args: spec.args || [],
      // Launch cwd (absolute). Used to attribute a server's `listen()` back to the
      // project it was started in — even for a manually run `npm start` that has no
      // VV_RUN wiring (see kernel-worker's projectDirForPid).
      cwd: spec.cwd,
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
    // `python`/`python3` are also skipped: our `python` is a Node shim that runs the
    // real program inside Pyodide (CPython/Wasm), so the `.py` source never passes
    // through the JS module loader and can't be instrumented — treating it as a debug
    // target only yields a bogus target + start-gate latency + a needlessly
    // instrumented shim. (Bun is deliberately NOT skipped: `bun <file>` runs the entry
    // through the JS module loader, so its breakpoints bind like `node`.)
    const env = spec.env || {};
    const wantsDebug = this.debugMode || env.VV_DEBUG === "1" || env.VV_DEBUG === "true";
    const cmd = String(spec.command || "");
    const skipDebug = /^(sh|bash|dash|zsh|npm|npx|yarn|pnpm|corepack|node-gyp|tsc|tsgo|python|python3)$/.test(cmd);
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
      spec: { ...spec, pid, ppid: parentPid ?? 0 },
      // #16 stage 2b: a spawned thread gets its creator's MessageChannel end as a
      // transferable, delivered to the worker as parentPort at init.
      threadPort,
      on: {
        syscall: () => this.serviceSyscall(pid),
        stdout: (m) => this.onOutput(pid, m.chunk, false),
        stderr: (m) => this.onOutput(pid, m.chunk, true),
        exit: (m) => this.finalize(pid, m.code | 0),
        // #16 stage 2b: this process' worker_threads asks the kernel to spawn /
        // terminate a nested thread worker.
        "thread-spawn": (m) => this.handleThreadSpawn(pid, m),
        "thread-terminate": (m) => this.handleThreadTerminate(pid, m),
        // Interactive stdin: this process wrote to a child's stdin — deliver the
        // bytes to that child's own process.stdin.
        "child-stdin": (m) => this.handleChildStdin(pid, m),
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

  finalize(pid, code, signal = null) {
    const proc = this.procs.get(pid);
    if (!proc || proc.finalized) return;
    proc.finalized = true;
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
    // Drop any ports this process was serving and fail its in-flight requests,
    // so a fetch that was waiting on a now-dead server does not hang forever.
    for (const [port, owner] of this.listeners) {
      if (owner === pid) this.listeners.delete(port);
    }
    for (const [reqId, pend] of this.pendingHttp) {
      if (pend.pid === pid) {
        pend.resolve({
          status: 502,
          headers: { "content-type": "text/plain" },
          body: "server process exited\n",
        });
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
      stdout: proc.outBuf.join(""),
      stderr: proc.errBuf.join(""),
      // The invocation, so an observer (kernel-worker's onProcExit) can tell that
      // e.g. an `npm install` in a given cwd just finished and snapshot its deps.
      command: proc.command,
      args: proc.args || [],
      cwd: proc.cwd,
    };
    if (proc.onExit) proc.onExit(result);
    if (this.onProcExit) this.onProcExit(pid, result);
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
    return new Promise((resolve) => {
      if (!programPath) {
        resolve({ pid: -1, code: 127, stdout: "", stderr: command + ": not found\n" });
        return;
      }
      const pid = this.createProcess(
        { command, programPath, args, cwd, env: opts.env || {} },
        { capture: !!opts.capture },
      );
      this.procs.get(pid).onExit = resolve;
    });
  }

  // ---- syscall servicing ----------------------------------------------------
  respondOk(proc, bytes) {
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
    const opcode = Atomics.load(proc.ctrl, I_OPCODE);
    const { fields } = decodeRequest(
      proc.data.slice(0, Atomics.load(proc.ctrl, I_REQ_LEN)),
    );
    if (opcode === OP_SPAWN) {
      this.handleSpawn(proc, JSON.parse(decodeBytes(fields[0])));
      return; // response is deferred until the child exits
    }
    if (opcode === OP_SPAWN_ASYNC) {
      this.handleSpawnAsync(proc, JSON.parse(decodeBytes(fields[0])));
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
      this.handleFetch(proc, JSON.parse(decodeBytes(fields[0])));
      return; // deferred until the network fetch resolves
    }
    if (opcode === OP_FETCH_ASYNC) {
      this.handleFetchAsync(proc, JSON.parse(decodeBytes(fields[0])));
      return; // acks immediately; the result streams back via postMessage
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
    if (this.listeners.get(port) === proc.pid) this.listeners.delete(port);
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

  /**
   * Route an inbound HTTP request to the process listening on `port`.
   * Returns a Promise<{status,headers,body}>. This is the kernel's public
   * entry point for the Service Worker (browser) or tests (node).
   */
  handleHttpRequest(port, req) {
    const pid = this.listeners.get(port | 0);
    if (pid == null || !this.procs.has(pid)) {
      return Promise.resolve({
        status: 502,
        headers: { "content-type": "text/plain" },
        body: `No server listening on port ${port}\n`,
      });
    }
    const proc = this.procs.get(pid);
    const reqId = this.nextReqId++;
    return new Promise((resolve) => {
      this.pendingHttp.set(reqId, { resolve, pid });
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
    if (m.sub === "close") this.sseConns.delete(m.connId);
    if (this.onSseSend) this.onSseSend(m);
  }

  async handleSpawn(parent, spec) {
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

  // Push a stdin chunk into a running process' own process.stdin. `chunk` is a
  // string (host terminal / a live shell) OR a Uint8Array/Buffer (binary-safe
  // parent -> child piping via handleChildStdin), or null for EOF. Bytes pass
  // through unchanged — the runtime's drainStdin normalizes to a Buffer — so we
  // must NOT stringify, or binary stdin would be mangled. No-op if the process
  // is gone.
  sendStdin(pid, chunk) {
    return this.postToProc(pid | 0, { type: "stdin", chunk: chunk == null ? null : chunk });
  }

  // A process wrote to one of its children's stdin (child.stdin.write): relay the
  // bytes to that child's own process.stdin, unchanged (string or Uint8Array). We
  // don't verify parentage — the pid came from a ChildProcess this parent holds —
  // but only deliver to live procs.
  handleChildStdin(parentPid, m) {
    const childPid = m.childPid | 0;
    if (this.procs.has(childPid)) this.sendStdin(childPid, m.chunk == null ? null : m.chunk);
  }

  // Deliver a signal to a running process. We ack the killer first (it called
  // sys.kill synchronously and is parked), then finalize the target — which
  // terminates its worker and posts child-exit to its parent (possibly the killer).
  handleKill(proc, msg) {
    const pid = msg.pid | 0;
    if (!this.procs.has(pid)) {
      this.respondErr(proc, "ESRCH");
      return;
    }
    const signal = msg.signal || "SIGTERM";
    this.respondOk(proc, EMPTY);
    this.finalize(pid, signal === "SIGKILL" ? 137 : 143, signal);
  }

  // ---- worker_threads brokering (#16 stage 2b) ------------------------------
  // A process' worker_threads asks us to spawn a nested thread worker. Unlike a
  // child process (#15) the thread talks to its creator directly over a
  // MessageChannel (data.port -> the child's parentPort); we only allocate its
  // syscall SAB + FS registration and relay online/exit back to the creator.
  handleThreadSpawn(parentPid, data) {
    const parent = this.procs.get(parentPid);
    if (!parent) return;
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
  _fetchCachePath(cacheKey) {
    return "/var/cache/vv-fetch/" + encodeURIComponent(cacheKey);
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
  _evictFetchCacheIfNeeded(protectKey) {
    if (this._fetchCacheBytes <= this.fetchCacheMaxBytes) return;
    for (const [key, meta] of this.fetchCache) {
      if (this._fetchCacheBytes <= this.fetchCacheMaxBytes) break;
      if (key === protectKey) continue;
      this.fetchCache.delete(key);
      this._fetchCacheBytes -= meta.size | 0;
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