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
} from "../protocol/syscall.js";
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

    // ---- network fetch (Phase 2 #9) ----
    // Injected by the environment: (url) => Promise<{ok,status,headers,body:Uint8Array}>.
    // The browser routes this to a dedicated Fetcher Worker; tests inject a mock.
    this.fetcher = fetcher || null;
    // URL -> { path, status, ok, contentType, size } — content cache so a repeated
    // fetch (npm re-resolving the same package) skips the network entirely.
    this.fetchCache = new Map();
    this.onFetch = null; // optional observer (url, {cached,size,pid}) — e.g. a UI log / per-terminal progress
  }

  // ---- VFS helpers ----------------------------------------------------------
  // These proxy to the File System Worker over the kernel's own sync SAB channel
  // (#14). They stay synchronous so boot seeding and PATH resolution are unchanged.
  writeFile(path, contents) {
    this.fs.writeFile(path, contents);
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
      serverInbox: [], // queued { reqId, port, req } drained by non-blocking accept
      // #16 stage 2b: reqId -> child pid for worker_threads this process spawned.
      threads: null,
    };
    this.procs.set(pid, proc);
    proc.handle = this.spawnWorker({
      pid,
      sab,
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
      },
    });
    return pid;
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
    const result = {
      code,
      pid,
      signal,
      stdout: proc.outBuf.join(""),
      stderr: proc.errBuf.join(""),
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
      { programPath, args, cwd, env: opts.env || {} },
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
        { programPath, args, cwd, env: opts.env || {} },
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
    if (opcode === OP_FETCH) {
      this.handleFetch(proc, JSON.parse(decodeBytes(fields[0])));
      return; // deferred until the network fetch resolves
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
      const pid = this.listeners.get(msg.port | 0);
      if (pid == null || !this.procs.has(pid)) {
        if (this.onWsSend) this.onWsSend({ connId, sub: "close", code: 1006 });
        return;
      }
      this.wsConns.set(connId, pid);
      this.postToProc(pid, {
        type: "ws-open",
        connId,
        port: msg.port | 0,
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

  handleSpawn(parent, spec) {
    const cwd = spec.cwd || "/";
    const programPath = this.resolveProgram(spec.command, cwd, spec.env || {});
    if (!programPath) {
      this.respondErr(parent, "ENOENT");
      return;
    }
    const childPid = this.createProcess(
      { programPath, args: spec.args || [], cwd, env: spec.env || {} },
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
  handleSpawnAsync(parent, spec) {
    const cwd = spec.cwd || "/";
    const programPath = this.resolveProgram(spec.command, cwd, spec.env || {});
    if (!programPath) {
      this.respondErr(parent, "ENOENT");
      return;
    }
    const parentPid = parent.pid;
    const childPid = this.createProcess(
      { programPath, args: spec.args || [], cwd, env: spec.env || {} },
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

  // Push an interactive stdin chunk into a running process' own process.stdin.
  // `chunk` is a string (or null for EOF). Used by the host terminal (a live
  // shell) and by handleChildStdin (parent -> child piping). No-op if the process
  // is gone.
  sendStdin(pid, chunk) {
    return this.postToProc(pid | 0, { type: "stdin", chunk: chunk == null ? null : String(chunk) });
  }

  // A process wrote to one of its children's stdin (child.stdin.write): relay the
  // bytes to that child's own process.stdin. We don't verify parentage — the pid
  // came from a ChildProcess this parent holds — but only deliver to live procs.
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
      },
      { parentPid, threadPort: port },
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
    return "/var/cache/oc-fetch/" + encodeURIComponent(cacheKey);
  }

  _fetchCacheKey(method, url, headers) {
    const accept = headers ? headers.accept || headers.Accept || "" : "";
    return method + " " + url + (accept ? " " + accept : "");
  }

  // Deferred like handleSpawn: the caller stays parked on Atomics.wait while we
  // fetch (off-thread, in the Fetcher Worker) and stream the body into the VFS.
  // `method`/`headers`/`bodyB64` (from the http/https client shim, lib/https.js)
  // let a real ClientRequest egress; a bare `{url}` still works (GET).
  async handleFetch(proc, { url, method = "GET", headers = null, bodyB64 = null }) {
    try {
      method = String(method || "GET").toUpperCase();
      // Only idempotent bodyless GETs are cached (npm re-resolving the same
      // packument). Anything with a body / non-GET always hits the network.
      const cacheable = method === "GET" && !bodyB64;
      const cacheKey = this._fetchCacheKey(method, url, headers);
      const cached = cacheable ? this.fetchCache.get(cacheKey) : null;
      if (cached) {
        if (this.onFetch) this.onFetch(url, { cached: true, size: cached.size, pid: proc.pid });
        this.respondOk(proc, encodeString(JSON.stringify({ ...cached, cached: true })));
        return;
      }
      if (!this.fetcher) {
        this.respondErr(proc, "ENETUNREACH");
        return;
      }
      const init = { method, headers: headers || undefined };
      if (bodyB64) init.body = b64ToBytes(bodyB64);
      const res = await this.fetcher(url, init);
      // Process may have exited while the fetch was in flight.
      if (!this.procs.has(proc.pid)) return;
      const body = res.body instanceof Uint8Array ? res.body : new Uint8Array(res.body || 0);
      const path = this._fetchCachePath(cacheKey);
      this.mkdirp("/var/cache/oc-fetch");
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
      if (cacheable) this.fetchCache.set(cacheKey, meta);
      if (this.onFetch) this.onFetch(url, { cached: false, size: meta.size, pid: proc.pid });
      this.respondOk(proc, encodeString(JSON.stringify({ ...meta, cached: false })));
    } catch (err) {
      if (!this.procs.has(proc.pid)) return;
      this.respondErr(proc, typeof err === "string" ? err : String(err?.message || "EFETCH"));
    }
  }

}
