// The Node runtime shim. Given a shared-memory channel to the kernel, it wires
// up core builtins, globals, and a CommonJS module system, then runs a program
// exactly like `node <entry>` would — synchronously, inside a worker.

import { createSyscalls } from "./fs-client.js";
import { createEventLoop } from "./loop.js";
import { createNodeModules } from "./node/loader.js";
import { createOs } from "./builtins/os.js";
import { createProcess } from "./builtins/process.js";
import { createAssert } from "./builtins/assert.js";
import { createChildProcess } from "./builtins/child_process.js";
import { createModuleSystem } from "./module.js";
import { createWebSocket } from "./websocket.js";
import { rewriteDynamicImportToGlobal } from "./esm.js";

function createConsole(process, util) {
  const toOut = (...a) => process.stdout.write(util.format(...a) + "\n");
  const toErr = (...a) => process.stderr.write(util.format(...a) + "\n");
  return {
    log: toOut,
    info: toOut,
    debug: toOut,
    warn: toErr,
    error: toErr,
    trace: toErr,
    dir: (o) => toOut(util.inspect(o)),
    assert: (cond, ...a) => {
      if (!cond) toErr("Assertion failed:", ...a);
    },
    // no-op timing/grouping/counting helpers. Kept complete (matching Node's
    // Console surface) because some libraries bind every method up front — e.g.
    // @edge-runtime/primitives (pulled by Next.js) does
    // `console.count.bind(console)`, `console.timeLog.bind(console)`, … at load,
    // which throws "reading 'bind' of undefined" if any method is missing.
    time() {},
    timeEnd() {},
    timeLog() {},
    timeStamp() {},
    count() {},
    countReset() {},
    group() {},
    groupCollapsed() {},
    groupEnd() {},
    clear() {},
    dirxml(...a) {
      toOut(...a);
    },
    table(o) {
      toOut(util.inspect(o));
    },
  };
}

export function createRuntime({
  ctrl,
  data,
  notify,
  pid = 1,
  ppid = 0,
  argv = [],
  env = {},
  cwd = "/",
  stdout = () => {},
  stderr = () => {},
  codec = null,
  cryptoCodec = null,
  // Host async_hooks (real AsyncLocalStorage) when running on a Node worker; null
  // in the browser. Delegated to by internal/async_hooks for cross-await context
  // propagation (Next.js App Router / RSC). See internal-binding.js.
  hostAsyncHooks = null,
  // Host worker_threads.markAsUntransferable (Node worker only) — used to protect the
  // Buffer pool's ArrayBuffer from being detached by a guest transferList. Null in
  // the browser (where the buffer.js detached-pool guard is the fallback).
  hostMarkUntransferable = null,
  // Worker threads (#16 stage 2b). `postRaw(msg, transfer)` sends a message to the
  // kernel with transferables (MessagePorts) — the shell provides it. `thread`
  // carries this worker's identity when it *is* a spawned thread.
  postRaw = null,
  thread = null,
  // child_process.fork child side: a dedicated IPC MessagePort to the parent.
  // When set, `process.send` / 'message' / connected / channel / disconnect are
  // bridged onto it (see below). Null for normal processes and worker threads.
  ipcPort = null,
}) {
  const syscalls = createSyscalls({ ctrl, data, notify });

  // Liveness counter for real net handles (Phase 2 #8): a listening net.Server or
  // an open socket keeps the loop alive, exactly like libuv's active handles.
  const netLiveness = { active: 0 };
  // Liveness counter for async children (#15): a running child keeps the parent's
  // loop alive so it can stream the child's output and see its exit.
  const childLiveness = { active: 0 };
  // Liveness counter for worker_threads (2b): a running Worker (parent side) or an
  // active parentPort 'message' listener (child side) keeps the loop alive.
  const threadLiveness = { active: 0 };
  // Liveness counter for host-backed async (WebAssembly.compile / fetch /
  // DecompressionStream via Response body readers). Their promises settle on the
  // HOST's queues, invisible to our loop, so a bare `node script.js` that only
  // `await`s one would otherwise exit before it resolves. Each in-flight op refs
  // the loop (like a libuv handle) and wakes the idle wait when it settles.
  const hostLiveness = { active: 0 };
  // Liveness counter for fs.watch (roadmap #19 stage B): a persistent FSWatcher
  // keeps the loop alive (like libuv's fs_event handle), so a bare `fs.watch`
  // script stays up until the watcher is closed.
  const watchLiveness = { active: 0 };
  // Liveness counter for WebSocket tunnels (roadmap #19 stage C): each live
  // browser<->in-VM ws relay connection keeps the loop turning so it can pump
  // frames (like an open socket handle).
  const wsLiveness = { active: 0 };
  // Liveness counter for interactive stdin: while a consumer is actively reading
  // process.stdin (flowing / has a 'data' listener), it refs the loop like an
  // open TTY handle so an idle REPL/shell waits for the next keystroke instead of
  // exiting. Toggled by stdin.resume()/pause() below.
  const stdinLiveness = { active: 0 };
  // Interactive stdin delivery: keystrokes the kernel pushes (host terminal ->
  // process worker -> here) are queued and drained inside a loop turn (doStdin),
  // like doNet/doChildren. Wired just below once `stream` exists.
  let drainStdin = () => {};
  let dispatchStdin = () => {};
  // Assigned once child_process is built; the loop drains child events through it.
  let drainChildEvents = () => {};
  // Assigned once worker_threads is required; the loop drains its queued events.
  let drainThreadEvents = () => {};
  let dispatchThreadEvent = () => {};
  // fs.watch delivery: change events pushed by the File System Worker are queued
  // and drained inside a loop turn (like doNet/doChildren). Wired just below.
  let drainWatchEvents = () => {};
  let dispatchWatchEvent = () => {};
  // How many ports this process has registered with the kernel (each real
  // net.Server.listen calls syscalls.listen). While non-zero, `doNet` drains
  // inbound requests on every `net` wake.
  const netServers = { count: 0 };

  // Bridges one external request (Service Worker / kernel.handleHttpRequest) into
  // this process's real http server. Wired below once the real http module exists.
  let bridgeHttp = null;

  // The process event loop (Phase 2 #5): real nextTick > microtask > timers >
  // immediate ordering, timers firing even while a server is idle. On a `net`
  // wake it drains queued requests and replays each through the real http stack
  // (Phase 2 #8 stage 2) so the server that answers is Node's own lib/http.js.
  const loop = createEventLoop({
    isAlive: () =>
      netLiveness.active > 0 ||
      childLiveness.active > 0 ||
      threadLiveness.active > 0 ||
      hostLiveness.active > 0 ||
      watchLiveness.active > 0 ||
      wsLiveness.active > 0 ||
      stdinLiveness.active > 0,
    doNet: () => {
      if (netServers.count === 0 || !bridgeHttp) return;
      for (;;) {
        const ev = syscalls.tryAccept();
        if (!ev) break;
        bridgeHttp(ev);
      }
    },
    doChildren: () => drainChildEvents(),
    doThreads: () => drainThreadEvents(),
    doWatch: () => drainWatchEvents(),
    doStdin: () => drainStdin(),
  });

  const os = createOs();
  const process = createProcess({
    pid,
    ppid,
    argv,
    env,
    cwd,
    stdout,
    stderr,
    nextTick: loop.nextTick,
    // process.exit() flags the loop so drive() returns the right code even when
    // exit() is called from a raw Promise microtask (its throw would escape).
    onExit: (code) => loop.requestExit(code),
  });

  // process.kill(pid, signal): send a signal to another process via the kernel,
  // the same path child.kill() takes. Tools that manage their own children by pid
  // rely on this — NestJS's watch mode kills the app child with process.kill()
  // before respawning it on each recompile. signal 0 is an existence probe.
  process.kill = (targetPid, signal = "SIGTERM") => {
    syscalls.kill(targetPid | 0, signal);
    return true;
  };

  // Wire the fs.watch host onto `process` (roadmap #19 stage B). The vendored
  // internal/fs/watchers builtin reaches this to register a watch with the File
  // System Worker and to receive the change events it pushes back. Each watchId is
  // unique per process; a persistent watcher refs the loop like a real fs handle.
  const watchHandlers = new Map(); // watchId -> (event, filename) => void
  const watchQueue = [];
  dispatchWatchEvent = (msg) => {
    watchQueue.push(msg);
    loop.wakeNet();
  };
  drainWatchEvents = () => {
    while (watchQueue.length) {
      const m = watchQueue.shift();
      const h = watchHandlers.get(m.watchId);
      if (h) h(m.event, m.filename);
    }
  };
  process.__fsWatch = {
    add: (watchId, path, recursive, persistent) => {
      syscalls.watch(watchId, path, !!recursive);
      if (persistent) {
        watchLiveness.active++;
        loop.wakeNet();
      }
    },
    remove: (watchId, persistent) => {
      try {
        syscalls.unwatch(watchId);
      } catch {
        /* FS worker gone */
      }
      if (persistent && watchLiveness.active > 0) watchLiveness.active--;
    },
    register: (watchId, handler) => watchHandlers.set(watchId, handler),
    unregister: (watchId) => watchHandlers.delete(watchId),
  };

  // Wire the worker_threads host onto `process` so the lazily-required
  // node:worker_threads builtin (2b) can read this thread's identity, spawn nested
  // workers (brokered by the kernel), and pump its events through our loop.
  process.__wtHost = {
    isMainThread: thread ? !!thread.isMainThread : true,
    threadId: thread ? thread.threadId | 0 : 0,
    workerData: thread ? thread.workerData : null,
    parentPort: thread ? thread.parentPort || null : null,
    wake: () => loop.wakeNet(),
    retain: () => {
      threadLiveness.active++;
      loop.wakeNet();
    },
    release: () => {
      if (threadLiveness.active > 0) threadLiveness.active--;
    },
    registerDrain: (fn) => {
      drainThreadEvents = fn;
    },
    registerDispatch: (fn) => {
      dispatchThreadEvent = fn;
    },
    spawn: (reqId, spec, port) => {
      if (postRaw) postRaw({ type: "thread-spawn", reqId, spec, port }, [port]);
    },
    terminate: (reqId) => {
      if (postRaw) postRaw({ type: "thread-terminate", reqId });
    },
  };

  // Expose the host's real markAsUntransferable so buffer.js's createPool() can mark
  // the shared pool untransferable to the platform's postMessage. Must be set BEFORE
  // the buffer module is first required (its top-level createPool runs on load).
  if (typeof hostMarkUntransferable === "function") {
    globalThis.__ocHostMarkUntransferable = hostMarkUntransferable;
  }

  // Path B: Node's REAL lib/ modules run on top of our internalBinding layer.
  // `path`, `buffer`, `fs`, `events` and `util` are vendored, unmodified Node
  // v24.18.0 source; `Buffer` is the real Buffer (Uint8Array subclass) over
  // internalBinding('buffer'), `fs` is Node's real lib/fs.js over
  // internalBinding('fs') (node/bindings/fs.js -> Rust VFS via the sync bridge),
  // and `events`/`util` run on our shared internal layer (util.inspect bridged).
  const nodeModules = createNodeModules({ process, syscalls, netLiveness, netServers, codec, cryptoCodec, hostAsyncHooks });
  const bufferModule = nodeModules.require("buffer");
  const Buffer = bufferModule.Buffer;
  const path = nodeModules.require("path");
  const EventEmitter = nodeModules.require("events");
  const util = nodeModules.require("util");
  const fs = nodeModules.require("fs");
  const stream = nodeModules.require("stream");
  const streamPromises = nodeModules.require("stream/promises");
  const stringDecoder = nodeModules.require("string_decoder");
  const asyncHooks = nodeModules.require("async_hooks");
  const net = nodeModules.require("net");
  const timers = nodeModules.require("timers");
  const diagnosticsChannel = nodeModules.require("diagnostics_channel");
  const cluster = nodeModules.require("cluster");
  // Phase 2 #8 stage 2: `http` IS Node's real lib/http.js now (Brick 5 is gone).
  // The browser preview reaches it through the bridge wired below.
  const http = nodeModules.require("http");
  const assert = createAssert(util);

  // ---- real event surface on `process` --------------------------------------
  // Node's `process` IS an EventEmitter, and real tools depend on it: npm's
  // logging/output (`proc-log`) is literally `process.emit('output'|'log', ...)`
  // consumed by a `process.on('output', ...)` handler, and libraries register
  // `process.on('exit'|'uncaughtException'|...)`. The boot stub's no-op on/emit
  // silently dropped every event (npm ran but printed nothing). Mix a genuine
  // EventEmitter's methods onto the existing process object (keeping its own
  // props like exit/stdout/cwd) and give it an unlimited listener budget.
  {
    const ee = new EventEmitter();
    ee.setMaxListeners(0);
    const chainable = new Set([
      "on", "addListener", "once", "prependListener", "prependOnceListener",
      "off", "removeListener", "removeAllListeners", "setMaxListeners",
    ]);
    const methods = [
      ...chainable,
      "getMaxListeners", "listeners", "rawListeners", "listenerCount", "eventNames", "emit",
    ];
    for (const m of methods) {
      process[m] = (...args) => {
        const r = ee[m](...args);
        return chainable.has(m) ? process : r; // Node returns the emitter (→ process) for chainable ops
      };
    }
  }
  // Node's process.exit([code]) defaults to process.exitCode when code is omitted
  // (npm's exit-handler sets process.exitCode then calls process.exit()). The stub
  // exit() throws the loop's exit sentinel; wrap it to resolve the default here.
  {
    const rawExit = process.exit;
    process.exit = (code) =>
      rawExit(code == null ? (process.exitCode == null ? 0 : process.exitCode | 0) : code | 0);
  }

  // ---- fork IPC (child side): process.send / 'message' / disconnect ----------
  // A forked child (child_process.fork) runs as a normal main-thread process, but
  // gets a dedicated IPC MessagePort to its parent. Expose Node's fork surface —
  // process.send(), 'message' events, process.connected / process.channel /
  // process.disconnect() — bridged onto that port. Next.js's `next dev` forks its
  // dev server and gates the whole boot on `process.send` existing, then hands
  // over start options across this channel, so this is what unlocks Next dev.
  if (ipcPort) {
    process.connected = true;
    let msgListeners = 0;
    let ipcRefed = false;
    const ipcRetain = () => {
      if (!ipcRefed) { ipcRefed = true; threadLiveness.active++; loop.wakeNet(); }
    };
    const ipcRelease = () => {
      if (ipcRefed) { ipcRefed = false; if (threadLiveness.active > 0) threadLiveness.active--; loop.wakeNet(); }
    };
    const doDisconnect = () => {
      if (!process.connected) return;
      process.connected = false;
      process.channel = null;
      ipcRelease();
      try { ipcPort.close && ipcPort.close(); } catch { /* ignore */ }
      loop.nextTick(() => process.emit("disconnect"));
      loop.wakeNet();
    };
    // process.channel is a truthy object in a fork child; ref/unref toggle liveness.
    process.channel = { ref: ipcRetain, unref: ipcRelease, hasRef: () => ipcRefed };
    ipcPort.onmessage = (e) => {
      const data = e && e.data;
      if (data && data.__ocIpcDisconnect) { doDisconnect(); return; }
      // Deliver inside a loop turn (like worker_threads / stdin), so a process.exit()
      // from the handler is honoured and microtasks flush after it.
      loop.nextTick(() => process.emit("message", data));
      loop.wakeNet();
    };
    try { ipcPort.start && ipcPort.start(); } catch { /* auto-starts */ }
    // A live IPC channel with a 'message' consumer refs the loop (Node semantics),
    // so a fork child doesn't exit between boot and binding its server port.
    process.on("newListener", (name) => { if (name === "message" && msgListeners++ === 0) ipcRetain(); });
    process.on("removeListener", (name) => { if (name === "message" && msgListeners > 0 && --msgListeners === 0) ipcRelease(); });
    process.send = (msg, sendHandle, options, cb) => {
      if (typeof sendHandle === "function") cb = sendHandle;
      else if (typeof options === "function") cb = options;
      if (!process.connected) {
        const err = new Error("Channel closed");
        err.code = "ERR_IPC_CHANNEL_CLOSED";
        if (cb) loop.nextTick(() => cb(err));
        else loop.nextTick(() => process.emit("error", err));
        return false;
      }
      try {
        ipcPort.postMessage(msg);
      } catch (e) {
        if (cb) loop.nextTick(() => cb(e));
        return false;
      }
      if (cb) loop.nextTick(() => cb(null));
      return true;
    };
    process.disconnect = doDisconnect;
  }

  // ---- legacy process.binding(name) shim ------------------------------------
  // Deprecated in real Node but still called by bundled deps: yarn's vendored
  // `safer-buffer` (`process.binding('buffer').kStringMaxLength`), `builtin-modules`
  // (`Object.keys(process.binding('natives'))`), a `constants` polyfill
  // (`process.binding('constants')`), and a `util` legacy path. Delegate to the
  // same internalBinding seam the vendored Node lib uses; `natives` (source
  // strings — we have none) becomes a name→'' map so `Object.keys` yields the
  // core module list. Unknown names return {} rather than throwing.
  {
    const NATIVE_MODULE_NAMES = [
      "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
      "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
      "events", "fs", "http", "http2", "https", "inspector", "module", "net",
      "os", "path", "perf_hooks", "process", "punycode", "querystring",
      "readline", "repl", "stream", "string_decoder", "sys", "timers", "tls",
      "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
    ];
    process.binding = (name) => {
      if (name === "natives") {
        const out = {};
        for (const n of NATIVE_MODULE_NAMES) out[n] = "";
        return out;
      }
      let b = {};
      try {
        b = nodeModules.internalBinding(name) || {};
      } catch {
        b = {};
      }
      // safer-buffer reads .kStringMaxLength off the buffer binding.
      if (name === "buffer" && b.kStringMaxLength == null) {
        return { ...b, kStringMaxLength: (1 << 29) - 1 };
      }
      return b;
    };
  }

  // ---- interactive stdin (real, flowing TTY) --------------------------------
  // Replace the boot-time no-op stdin with a genuine flowing Readable so a REPL,
  // readline, or our shell's line editor can read keystrokes the kernel pushes in
  // (host terminal -> process worker -> dispatchStdin). It presents as a TTY
  // (isTTY:true, setRawMode) since interactive tools branch on that. While a
  // consumer is actively reading (flowing / has a 'data' listener) it refs the
  // loop like an open handle so an idle shell waits for input instead of exiting.
  const stdin = new stream.Readable({ read() {} });
  stdin.fd = 0;
  stdin.isTTY = true;
  stdin.isRaw = false;
  let stdinRefed = false;
  const setStdinRef = (on) => {
    if (on === stdinRefed) return;
    stdinRefed = on;
    if (on) stdinLiveness.active++;
    else if (stdinLiveness.active > 0) stdinLiveness.active--;
    loop.wakeNet();
  };
  const origResume = stdin.resume.bind(stdin);
  const origPause = stdin.pause.bind(stdin);
  stdin.resume = () => {
    setStdinRef(true);
    return origResume();
  };
  stdin.pause = () => {
    setStdinRef(false);
    return origPause();
  };
  stdin.ref = () => {
    setStdinRef(true);
    return stdin;
  };
  stdin.unref = () => {
    setStdinRef(false);
    return stdin;
  };
  // Node's TTY exposes setRawMode(bool); we only record it (there's no cooked-mode
  // line discipline below us — the terminal/line editor lives in guest code).
  stdin.setRawMode = (mode) => {
    stdin.isRaw = !!mode;
    return stdin;
  };
  process.stdin = stdin;
  // Queue + drain: dispatchStdin (called from the worker's onmessage, off-turn)
  // enqueues; drainStdin (a loop turn) pushes into the Readable so 'data' fires in
  // a controlled turn. A null chunk is stdin EOF (Ctrl+D / closed terminal).
  const stdinQueue = [];
  drainStdin = () => {
    while (stdinQueue.length) {
      const chunk = stdinQueue.shift();
      if (chunk === null) stdin.push(null);
      else stdin.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
    }
  };
  dispatchStdin = (msg) => {
    stdinQueue.push(msg && msg.chunk != null ? msg.chunk : null);
    loop.wakeNet();
  };

  const child_process = createChildProcess({
    sys: syscalls,
    process,
    Buffer,
    EventEmitter,
    Readable: stream.Readable,
    childLiveness,
    wake: loop.wakeNet,
    // Parent -> child stdin: child.stdin.write() relays here to the kernel, which
    // delivers it to the child process' own stdin (see kernel.handleChildStdin).
    postRaw,
  });
  // The loop drains queued child events (stdout/stderr/exit) each turn (#15).
  drainChildEvents = child_process._drain;

  // Fork children stream their stdout/stderr to us (kernel `stream: true`), keyed
  // by child pid. We route those chunks here rather than through the async-spawn
  // ChildProcess registry (fork rides the worker_threads path, not spawnAsync).
  const forkChildren = new Map(); // childPid -> { onOut(chunk), onErr(chunk) }

  // child_process.fork(modulePath[, args][, options]) — a forked child is a
  // separate process running <modulePath> with a bidirectional IPC channel. We
  // build it on the worker_threads spawn plumbing (same kernel spawn + lifecycle
  // + MessageChannel), but boot the child in fork mode so it gets process.send /
  // 'message' rather than a worker parentPort. This is what makes `next dev`
  // (which forks its dev server and talks to it over IPC) run.
  child_process.fork = (modulePath, args, options) => {
    if (args && !Array.isArray(args)) { options = args; args = undefined; }
    args = args || [];
    options = options || {};
    const wt = nodeModules.require("worker_threads");
    const child = new EventEmitter();
    child.connected = true;
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    // fork stdio: default (silent:false) is 'inherit' — the child's output shows on
    // OUR std streams (which bubble to the terminal). silent:true (or stdio 'pipe')
    // pipes it onto child.stdout/child.stderr Readables instead.
    const stdio = options.stdio;
    const silent = options.silent === true || stdio === "pipe" || (Array.isArray(stdio) && stdio[1] === "pipe");
    const outStream = silent ? new stream.Readable({ read() {} }) : null;
    const errStream = silent ? new stream.Readable({ read() {} }) : null;
    child.stdout = outStream;
    child.stderr = errStream;
    child.stdin = null;
    child.stdio = [null, outStream, errStream, null];
    const pushOut = (s, chunk) => {
      if (s) s.push(chunk == null ? null : Buffer.from(String(chunk), "utf8"));
    };
    const handlers = {
      onOut: (chunk) => (silent ? pushOut(outStream, chunk) : process.stdout.write(chunk)),
      onErr: (chunk) => (silent ? pushOut(errStream, chunk) : process.stderr.write(chunk)),
    };
    let worker;
    try {
      worker = new wt.Worker(String(modulePath), {
        argv: (args || []).map(String),
        env: options.env || process.env,
        cwd: options.cwd || process.cwd(),
        _ocFork: true,
      });
    } catch (e) {
      child.pid = -1;
      loop.nextTick(() => { child.emit("error", e); child.emit("exit", 1, null); });
      return child;
    }
    child.pid = 0; // real pid arrives with 'online' (the kernel-assigned threadId)
    child.channel = { ref: () => worker.ref(), unref: () => worker.unref() };
    child.send = (msg, sendHandle, sendOpts, cb) => {
      if (typeof sendHandle === "function") cb = sendHandle;
      else if (typeof sendOpts === "function") cb = sendOpts;
      if (!child.connected) {
        const err = new Error("Channel closed");
        err.code = "ERR_IPC_CHANNEL_CLOSED";
        if (cb) loop.nextTick(() => cb(err));
        return false;
      }
      try { worker.postMessage(msg); } catch (e) { if (cb) loop.nextTick(() => cb(e)); return false; }
      if (cb) loop.nextTick(() => cb(null));
      return true;
    };
    child.disconnect = () => {
      if (!child.connected) return;
      child.connected = false;
      try { worker.postMessage({ __ocIpcDisconnect: true }); } catch { /* ignore */ }
      loop.nextTick(() => child.emit("disconnect"));
    };
    child.kill = (signal) => {
      child.killed = true;
      worker.terminate();
      return true;
    };
    child.ref = () => { worker.ref(); return child; };
    child.unref = () => { worker.unref(); return child; };
    worker.on("online", () => { child.pid = worker.threadId; forkChildren.set(child.pid, handlers); child.emit("spawn"); });
    worker.on("message", (m) => child.emit("message", m));
    worker.on("error", (e) => child.emit("error", e));
    worker.on("exit", (code) => {
      child.connected = false;
      child.exitCode = code | 0;
      if (child.pid > 0) forkChildren.delete(child.pid);
      pushOut(outStream, null);
      pushOut(errStream, null);
      loop.nextTick(() => { child.emit("exit", code | 0, null); child.emit("close", code | 0, null); });
    });
    return child;
  };

  // Replay an external request through the real http *client* into the in-VM real
  // http *server* over the net loopback, then send the collected response back to
  // the kernel. This is the cross-VM seam: the kernel/SW protocol is unchanged
  // ({port,method,url,headers,body} in -> {status,headers,body} out), but Node's
  // own http parses/serves it. Bodies cross through the kernel as JSON strings, so
  // textual responses go as utf8 and *binary* responses (images, fonts, wasm — the
  // Vite dev server serves these) go base64-encoded with `bodyEncoding:'base64'`
  // so the Service Worker can reconstruct the exact bytes (roadmap #19 stage A).
  const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"];
  // Content types we can safely carry as a utf8 string. Everything else is
  // treated as binary and base64-encoded. `charset=utf-8` types are textual.
  const isTextualContentType = (ct) => {
    if (!ct) return false;
    const t = String(ct).toLowerCase();
    if (t.startsWith("text/")) return true;
    if (t.includes("charset=utf-8") || t.includes("charset=utf8")) return true;
    return (
      t.includes("javascript") ||
      t.includes("json") ||
      t.includes("xml") ||
      t.includes("+json") ||
      t.includes("ecmascript") ||
      t.includes("image/svg") ||
      t.includes("application/manifest")
    );
  };
  const pickHeaders = (src, drop) => {
    const out = {};
    for (const k of Object.keys(src || {})) {
      const lk = k.toLowerCase();
      if (drop.includes(lk) || HOP_BY_HOP.includes(lk)) continue;
      out[k] = src[k];
    }
    return out;
  };
  bridgeHttp = (ev) => {
    const { reqId, port, req } = ev;
    let done = false;
    const reply = (resp) => {
      if (done) return;
      done = true;
      try {
        syscalls.respond(reqId, resp);
      } catch {
        /* kernel gone */
      }
    };
    const fail = (e) =>
      reply({
        status: 502,
        headers: { "content-type": "text/plain" },
        body: "Bad Gateway: " + (e && e.message ? e.message : String(e)) + "\n",
      });
    let creq;
    try {
      creq = http.request(
        {
          host: "127.0.0.1",
          port,
          method: req.method || "GET",
          path: req.url || "/",
          headers: pickHeaders(req.headers, ["host", "content-length"]),
        },
        (cres) => {
          const chunks = [];
          cres.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          cres.on("end", () => {
            const buf = Buffer.concat(chunks);
            const headers = pickHeaders(cres.headers, ["content-length"]);
            const ct = cres.headers && (cres.headers["content-type"] || cres.headers["Content-Type"]);
            const resp = { status: cres.statusCode || 200, headers };
            if (isTextualContentType(ct)) {
              // Fast path: a declared-textual type crosses as utf8.
              resp.body = buf.toString("utf8");
            } else {
              // Unknown/omitted type (e.g. res.end('...') with no content-type) or a
              // binary type: only base64 when the bytes aren't losslessly utf8, so
              // plain-text responses stay strings and real binary is preserved.
              const asUtf8 = buf.toString("utf8");
              if (Buffer.from(asUtf8, "utf8").equals(buf)) {
                resp.body = asUtf8;
              } else {
                resp.body = buf.toString("base64");
                resp.bodyEncoding = "base64";
              }
            }
            reply(resp);
          });
          cres.on("error", fail);
        },
      );
    } catch (e) {
      fail(e);
      return;
    }
    creq.on("error", fail);
    const body = req.body;
    if (body != null && body !== "" && req.method !== "GET" && req.method !== "HEAD") creq.end(body);
    else creq.end();
  };

  // A real in-VM WebSocket *client* (roadmap #19 stage C), over Node's own http
  // upgrade + the net loopback. Exposed as the `WebSocket` global so guest code
  // can use it, and used by the HMR relay below to reach an in-VM ws server (e.g.
  // Vite's dev-server HMR socket) on behalf of the browser preview.
  const WebSocketClient = createWebSocket({ http, Buffer });
  // Override any host `WebSocket` (Node's undici one, or a browser Worker's
  // native one): those reach the REAL network and can't see an in-VM ws server,
  // so guest code (and our HMR relay) must use the in-VM client instead.
  globalThis.WebSocket = WebSocketClient;

  // ---- WebSocket tunnel relay (roadmap #19 stage C) -------------------------
  // The browser preview can't reach an in-VM ws server directly (the Service
  // Worker can't intercept a real WebSocket upgrade). Instead a `WebSocket`
  // polyfill in the preview iframe tunnels each logical connection to us as
  // messages (kernel -> this process): ws-open / ws-in (client->server data) /
  // ws-close. We open a genuine in-VM WebSocket to 127.0.0.1:<port> for each and
  // relay decoded messages back out (postRaw -> kernel -> host -> iframe) as
  // ws-out {sub:'open'|'msg'|'close'}. Framing lives entirely here, in one place.
  const wsConns = new Map(); // connId -> WebSocket
  const wsOut = (connId, sub, extra) => {
    if (postRaw) postRaw({ type: "ws-out", connId, sub, ...extra });
  };
  const wsRelay = {
    open(connId, port, path, protocols, attempt = 0) {
      if (wsConns.has(connId)) return;
      let sock;
      try {
        sock = new WebSocketClient("ws://127.0.0.1:" + (port | 0) + (path || "/"), protocols || undefined);
      } catch {
        wsOut(connId, "close", { code: 1006 });
        return;
      }
      wsConns.set(connId, sock);
      wsLiveness.active++;
      loop.wakeNet();
      sock.binaryType = "arraybuffer";
      let opened = false;
      sock.onopen = () => {
        opened = true;
        wsOut(connId, "open", { protocol: sock.protocol });
      };
      sock.onmessage = (ev) => {
        const binary = typeof ev.data !== "string";
        wsOut(connId, "msg", { data: ev.data, binary });
      };
      sock.onclose = (ev) => {
        if (wsConns.delete(connId) && wsLiveness.active > 0) wsLiveness.active--;
        // Racing the dev server's readiness on the loopback can close a brand-new
        // socket before it ever opened; retry a few times (the in-VM server is
        // right here, so this settles fast) before giving up on the browser end.
        if (!opened && attempt < 5) {
          loop.setTimeout(() => this.open(connId, port, path, protocols, attempt + 1), 120);
          return;
        }
        wsOut(connId, "close", { code: ev.code, reason: ev.reason });
      };
      sock.onerror = () => {
        /* a following close event carries the teardown (and any retry) */
      };
    },
    inbound(connId, data) {
      const sock = wsConns.get(connId);
      if (sock && sock.readyState === 1) {
        try {
          sock.send(data);
        } catch {
          /* closing */
        }
      }
    },
    close(connId, code, reason) {
      const sock = wsConns.get(connId);
      if (sock) {
        try {
          sock.close(code, reason);
        } catch {
          /* already gone */
        }
      }
    },
  };
  const dispatchWs = (msg) => {
    if (!msg) return;
    if (msg.type === "ws-open") wsRelay.open(msg.connId, msg.port, msg.path, msg.protocols);
    else if (msg.type === "ws-in") wsRelay.inbound(msg.connId, msg.data);
    else if (msg.type === "ws-close") wsRelay.close(msg.connId, msg.code, msg.reason);
    loop.wakeNet();
  };

  const consoleObj = createConsole(process, util);

  // Globals visible to user code (both as wrapper params and on globalThis).
  const globals = {
    process,
    Buffer,
    console: consoleObj,
    global: globalThis,
  };
  // Capture the *host realm* process before we shadow it: in a Node worker_threads
  // runtime this is the real Node process (used for the exit-sentinel safety net
  // below); in a browser Worker it's undefined and we fall back to event listeners.
  const hostRealmProcess = globalThis.process;
  globalThis.process = process;
  globalThis.Buffer = Buffer;
  globalThis.console = consoleObj;
  globalThis.global = globalThis;
  // Worker-global alias: browser Workers already have `self`, but the headless
  // Node worker_threads runtime does not. Some libraries (e.g. esbuild-wasm's
  // browser build, which mirrors globals off `self`) rely on it existing.
  if (typeof globalThis.self === "undefined") globalThis.self = globalThis;

  // Keep the loop alive while host-backed async work is pending (see hostLiveness
  // above). We monkey-patch the few entry points whose promises resolve off our
  // loop so `await`-ing them from a bare script no longer races the loop to exit.
  const trackHost = (p) => {
    if (!p || typeof p.then !== "function") return p;
    hostLiveness.active++;
    const done = () => {
      if (hostLiveness.active > 0) hostLiveness.active--;
      loop.wakeNet(); // break an idle waitForNext so the loop re-evaluates
    };
    p.then(done, done); // consumes settlement only for liveness; original p is returned
    return p;
  };
  const wrapHostAsync = (obj, name) => {
    const orig = obj && obj[name];
    if (typeof orig !== "function" || orig.__ocHostWrapped) return;
    const wrapped = function (...args) {
      return trackHost(orig.apply(this, args));
    };
    wrapped.__ocHostWrapped = true;
    obj[name] = wrapped;
  };
  if (typeof WebAssembly !== "undefined") {
    for (const m of ["compile", "instantiate", "compileStreaming", "instantiateStreaming"]) {
      wrapHostAsync(WebAssembly, m);
    }
  }
  // Host alias for the *global* fetch(). Unlike http/https (which egress via
  // __ocfetch -> the Fetcher Worker, where rewrite() already maps the alias), the
  // global fetch is the host realm's real fetch used directly, so it needs its own
  // rewrite. Map `http://host.opencontainer.internal:<port>/…` to the studio's own
  // hostname (this realm is a Worker on the studio origin, so location.hostname IS
  // the host) — reaching a service on the HOST machine when the studio is served
  // locally. Headless (no browser realm) has no location and no-ops.
  const HOST_ALIAS = "host.opencontainer.internal";
  const rewriteHostAlias = (input) => {
    const host = globalThis.location && globalThis.location.hostname;
    if (!host) return input;
    const rewriteStr = (s) => {
      try {
        const u = new URL(String(s));
        if (u.hostname === HOST_ALIAS) {
          u.hostname = host;
          return u.toString();
        }
      } catch {
        /* not an absolute URL — leave untouched */
      }
      return s;
    };
    if (typeof input === "string") return rewriteStr(input);
    if (typeof URL !== "undefined" && input instanceof URL) return new URL(rewriteStr(input.href));
    // Request: rebuild only if the URL actually changed (preserves method/headers/body).
    if (typeof Request !== "undefined" && input instanceof Request) {
      const next = rewriteStr(input.url);
      return next === input.url ? input : new Request(next, input);
    }
    return input;
  };
  if (typeof globalThis.fetch === "function") {
    const hostFetch = globalThis.fetch;
    if (!hostFetch.__ocHostWrapped) {
      const wrappedFetch = function (input, init) {
        return trackHost(hostFetch.call(this, rewriteHostAlias(input), init));
      };
      wrappedFetch.__ocHostWrapped = true;
      globalThis.fetch = wrappedFetch;
    }
  }
  // DecompressionStream/Blob consumers land here: new Response(stream).arrayBuffer().
  if (typeof Response !== "undefined" && Response.prototype) {
    for (const m of ["arrayBuffer", "text", "json", "blob", "formData"]) wrapHostAsync(Response.prototype, m);
  }
  if (typeof Blob !== "undefined" && Blob.prototype) {
    for (const m of ["arrayBuffer", "text"]) wrapHostAsync(Blob.prototype, m);
  }
  // A WHATWG ReadableStream reader's read()/cancel() promises also settle off our
  // loop. Consuming a `fetch()` response body incrementally (rather than
  // buffering it whole via Response.arrayBuffer) drives these — e.g. corepack
  // streams a package-manager tarball through Readable.fromWeb (see
  // internal/webstreams/adapters.js), which pumps one reader.read() per chunk.
  // Without refing the loop it would exit mid-download.
  for (const ctor of ["ReadableStreamDefaultReader", "ReadableStreamBYOBReader"]) {
    const C = globalThis[ctor];
    if (typeof C === "function" && C.prototype) {
      wrapHostAsync(C.prototype, "read");
      wrapHostAsync(C.prototype, "cancel");
    }
  }

  // Exit-sentinel safety net. process.exit() throws a sentinel that the loop's
  // runCallback catches — but when exit() is called from a raw Promise microtask
  // (async continuation / .then / .catch / queueMicrotask) the throw escapes the
  // loop and would crash the worker realm (Node aborts on an unhandled rejection;
  // browsers fire 'error'/'unhandledrejection'). exit() already flagged the loop
  // (onExit -> requestExit) so drive() will still return the right code; here we
  // just keep the escaped sentinel from taking the whole worker down. Genuine
  // errors are left untouched.
  const isExitSentinel = (v) => v && typeof v === "object" && v.__processExit !== undefined;
  if (hostRealmProcess && typeof hostRealmProcess.on === "function") {
    hostRealmProcess.on("unhandledRejection", (reason) => {
      if (isExitSentinel(reason)) loop.requestExit(reason.__processExit);
      else throw reason; // escalate a genuine rejection to uncaughtException (default reporting)
    });
    hostRealmProcess.on("uncaughtException", (err) => {
      if (isExitSentinel(err)) loop.requestExit(err.__processExit);
      else throw err; // preserve normal crash reporting for real errors
    });
  } else if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("unhandledrejection", (ev) => {
      const r = ev && ev.reason;
      if (isExitSentinel(r)) {
        ev.preventDefault?.();
        loop.requestExit(r.__processExit);
      }
    });
    globalThis.addEventListener("error", (ev) => {
      const r = ev && (ev.error ?? ev.reason);
      if (isExitSentinel(r)) {
        ev.preventDefault?.();
        loop.requestExit(r.__processExit);
      }
    });
  }
  // Route user-facing timers through our event loop so ordering is Node-correct
  // and callbacks fire even while a server is running (the old host timers never
  // fired — the synchronous accept loop starved them).
  globalThis.setTimeout = loop.setTimeout;
  globalThis.clearTimeout = loop.clearTimeout;
  globalThis.setInterval = loop.setInterval;
  globalThis.clearInterval = loop.clearInterval;
  globalThis.setImmediate = loop.setImmediate;
  globalThis.clearImmediate = loop.clearImmediate;
  // Browser (no host async_hooks) only: now that our timer globals are in place,
  // let AsyncLocalStorage propagate context across the scheduling primitives React's
  // App Router uses (then/queueMicrotask/setImmediate/setTimeout). Must run AFTER the
  // reassignments above and BEFORE any framework code so React captures the wrapped
  // primitives (it caches `scheduleMicrotask = queueMicrotask` at module eval).
  asyncHooks.__ocInstallContextPropagation?.();
  // Phase 2 #9 (internal, temporary): a blocking fetch into the VFS, serviced by
  // the kernel's Fetcher Worker. Returns { status, ok, contentType, size, path,
  // cached }; read `path` with fs for the bytes. This is the low-level primitive
  // the npm client (#10) will build on; it'll get a proper wrapper then.
  globalThis.__ocfetch = (url, opts) => syscalls.fetch(String(url), opts);

  const builtins = {
    fs,
    path,
    os,
    process,
    util,
    assert,
    child_process,
    http,
    events: EventEmitter,
    buffer: bufferModule,
    stream,
    "stream/promises": streamPromises,
    string_decoder: stringDecoder,
    async_hooks: asyncHooks,
    net,
    timers,
    diagnostics_channel: diagnosticsChannel,
    cluster,
  };

  // Node exposes the posix/win32 path flavors as their own subpath builtins
  // (`require('node:path/posix')`). We're posix, so `path` already IS posix;
  // map both to what `path` carries (vitest's mocker requires `node:path/posix`).
  builtins["path/posix"] = path.posix || path;
  builtins["path/win32"] = path.win32 || path;

  const moduleSystem = createModuleSystem({ fs, path, builtins, process, globals, nodeModules });

  // Dynamic-import escape hatch. Libraries that ship dual ESM/CJS sometimes build
  // a dynamic import at runtime to dodge transpiler rewrites — piscina & tinypool
  // (Angular's parallel compiler, vitest's worker pool) do
  // `new Function('s', 'return import(s)')`. The Function constructor compiles that
  // in the host realm, so the inner import() escapes the sandbox and can't see our
  // VFS (it throws ERR_MODULE_NOT_FOUND against the host FS). We (a) expose a
  // loader-backed dynamic import as a global, and (b) wrap the Function
  // constructor so such bodies' import() is redirected to it.
  const ocRootRequire = moduleSystem.makeRequire("/");
  globalThis.__ocImport = (spec) =>
    Promise.resolve().then(() => {
      const m = ocRootRequire(String(spec));
      if (m && m.__esModule) return m;
      const ns = Object.create(null);
      if (m && typeof m === "object") for (const k of Object.keys(m)) ns[k] = m[k];
      ns.default = m;
      return ns;
    });
  {
    const NativeFunction = globalThis.Function;
    const OcFunction = function Function(...args) {
      if (args.length) {
        const body = args[args.length - 1];
        // Only touch bodies that actually contain a dynamic import (cheap guard —
        // virtually every `new Function` body doesn't), then rewrite precisely.
        if (typeof body === "string" && body.includes("import(")) {
          const rewritten = rewriteDynamicImportToGlobal(body);
          if (rewritten != null) args = args.slice(0, -1).concat(rewritten);
        }
      }
      return NativeFunction.apply(this, args);
    };
    // Preserve prototype identity so `x instanceof Function` and the shared
    // Function.prototype methods (call/apply/bind) keep working.
    OcFunction.prototype = NativeFunction.prototype;
    globalThis.Function = OcFunction;
  }

  // Node's `module` builtin default export IS the Module class, with the
  // namespace helpers hung off it as statics (createRequire, builtinModules,
  // isBuiltin, runMain, …) and a self-reference `Module.Module`. Attaching them
  // to the constructor — rather than returning a separate plain object — is what
  // lets `const { Module } = require('module')`, `require('module') === Module`,
  // and monkey-patching `Module.prototype`/`_load`/`_extensions` all behave.
  const Module = moduleSystem.Module;
  // `builtinModules` must be the public list only (no `node:`-prefixed dupes and
  // no internal names). Snapshot before the node: aliases are added below.
  Module.builtinModules = Object.keys(builtins).filter((n) => !n.startsWith("node:") && !n.startsWith("_"));
  Module.Module = Module;
  Module.createRequire = Module.createRequire || ((from) => moduleSystem.makeRequire(path.dirname(typeof from === "string" ? from : "/")));
  // Node exposes `runMain` on the `module` builtin (=== Module.runMain); real
  // tools call it to hand control to another entry in-process. corepack does
  // exactly this to exec the package-manager version it just downloaded
  // (`require('module').runMain(binPath)`).
  Module.runMain = (entry) => moduleSystem.runMain(entry);
  // V8 compile-cache hooks: no-ops here (no persistent code cache in the
  // sandbox). Callers guard with `?.`/`if`, but expose them so they don't throw.
  Module.enableCompileCache = () => ({ status: 0 });
  Module.flushCompileCache = () => {};
  Module.getCompileCacheDir = () => null;
  // registerHooks/register (ESM loader hooks) — accept & ignore so tools that
  // call them at startup (tsx, ts-node/esm) don't crash; our loader is CJS-based.
  Module.register = () => undefined;
  Module.registerHooks = () => ({ deregister() {} });
  // Source-map lookups: no source-map registry in the sandbox. Return undefined
  // (Node's contract for "no map found") so callers that probe error stacks — e.g.
  // Next.js's dev overlay — get a clean miss instead of a TypeError.
  Module.findSourceMap = () => undefined;
  Module.SourceMap = class SourceMap {
    constructor(payload) { this.payload = payload; }
    findEntry() { return {}; }
  };
  builtins.module = Module;

  // Support both `require('fs')` and `require('node:fs')`.
  for (const name of Object.keys(builtins)) builtins["node:" + name] = builtins[name];

  return {
    fs,
    process,
    require: moduleSystem.makeRequire(cwd),
    /** External nudge from the kernel: a network request is queued for us. */
    wake: loop.wakeNet,
    /** External delivery from the kernel: an async child's stdout/stderr/exit
     * ({type:'child-stdout'|'child-stderr'|'child-exit', childPid, ...}). #15.
     * Fork children (child_process.fork) stream through here too; route their
     * output to the fork handlers (exit arrives separately as a thread-exit). */
    dispatchChild: (msg) => {
      const h = msg && msg.childPid != null ? forkChildren.get(msg.childPid) : undefined;
      if (h) {
        if (msg.type === "child-stdout") h.onOut(msg.chunk);
        else if (msg.type === "child-stderr") h.onErr(msg.chunk);
        return;
      }
      child_process._dispatch(msg);
    },
    /** External delivery from the kernel: a worker_thread's online/exit
     * ({type:'thread-started'|'thread-exit', reqId, ...}). #16 stage 2b. */
    dispatchThread: (msg) => dispatchThreadEvent(msg),
    /** External delivery from the File System Worker: an fs.watch change event
     * ({type:'fs-watch', watchId, event, filename}). roadmap #19 stage B. */
    dispatchWatch: (msg) => dispatchWatchEvent(msg),
    /** External delivery from the kernel: a browser preview ws tunnel message
     * ({type:'ws-open'|'ws-in'|'ws-close', connId, ...}). roadmap #19 stage C. */
    dispatchWs: (msg) => dispatchWs(msg),
    /** External delivery from the kernel: an interactive stdin chunk for THIS
     * process ({type:'stdin', chunk} — chunk null = EOF). Feeds process.stdin. */
    dispatchStdin: (msg) => dispatchStdin(msg),
    /**
     * Run an entry file like `node <entry>`, then drive the event loop until it
     * is quiescent (no pending timers/immediates/nextTicks and no open servers).
     * Async: it yields to the host so Promise microtasks and timers actually
     * fire. Resolves with the process exit code.
     */
    async run(entry) {
      // Node fires a single synchronous 'exit' event with the final code right
      // before the process goes away — tools flush buffered output/logs there
      // (npm's exit-handler). Emit it once across every exit path below. A
      // listener may itself call process.exit() (→ throws the sentinel); we're
      // already exiting, so swallow it.
      let exitEmitted = false;
      const finish = (code) => {
        if (!exitEmitted) {
          exitEmitted = true;
          if (process.exitCode == null) process.exitCode = code;
          try {
            process.emit("exit", code);
          } catch {
            /* a listener called process.exit() — the sentinel is expected */
          }
        }
        return code;
      };
      let started;
      try {
        // Runs the entry's synchronous body now (may throw the process.exit
        // sentinel). Returns a Promise if the entry used top-level await.
        started = moduleSystem.runMain(entry);
      } catch (err) {
        if (err && err.__processExit !== undefined) return finish(err.__processExit);
        throw err;
      }
      // A top-level-await entry evaluates to a Promise. Do NOT block on it before
      // driving the loop — its awaits may depend on timers/microtasks the loop
      // pumps, so awaiting here would deadlock. Let it settle inside drive() and
      // just surface a process.exit() sentinel or an uncaught error from it.
      if (started && typeof started.then === "function") {
        started.then(undefined, (err) => {
          if (err && err.__processExit !== undefined) {
            loop.requestExit(err.__processExit);
          } else {
            try {
              process.stderr.write(String((err && err.stack) || err) + "\n");
            } catch {
              /* ignore */
            }
            loop.requestExit(1);
          }
        });
      }
      await loop.drive();
      const code = loop.exiting ? loop.exitCode : process.exitCode == null ? 0 : process.exitCode | 0;
      return finish(code);
    },
  };
}
