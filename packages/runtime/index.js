// The Node runtime shim. Given a shared-memory channel to the kernel, it wires
// up core builtins, globals, and a CommonJS module system, then runs a program
// exactly like `node <entry>` would - synchronously, inside a worker.

import { createSyscalls } from "./fs-client.js";
import { createEventLoop } from "./loop.js";
import { createSignalDelivery } from "./signals.js";
import { createNodeModules } from "./node/loader.js";
import { createOs } from "./builtins/os.js";
import { createProcess } from "./builtins/process.js";
import { createChildProcess } from "./builtins/child_process.js";
import { createModuleSystem } from "./module.js";
import { createWebSocket } from "./websocket.js";
import { rewriteDynamicImportToGlobal } from "./esm.js";
import { isEsbuildInprocActive, esbuildWasmBytes } from "./esbuild-inproc-patch.js";
import { createBunRuntime } from "./builtins/bun.js";
import { createPythonRuntime } from "./builtins/python.js";

function createConsole(process, util, passthrough) {
  // In dev, Vite injects @vite/client into every module worker; its HMR banners
  // ("[vite] connecting...", "[vite] connected.", "[vite] server connection
  // lost. …", …) reach this console (which pipes to the guest terminal) once the
  // client's WebSocket opens after we've replaced globalThis.console. Keep that
  // dev-only noise in the real DevTools console instead of the guest terminal.
  // (No-op in production builds, which ship no @vite/client.)
  const relay =
    passthrough && typeof passthrough.debug === "function" ? passthrough : null;
  const isViteBanner = (a) => typeof a[0] === "string" && a[0].startsWith("[vite]");
  const toOut = (...a) => {
    if (relay && isViteBanner(a)) return void relay.debug(...a);
    process.stdout.write(util.format(...a) + "\n");
  };
  const toErr = (...a) => {
    if (relay && isViteBanner(a)) return void relay.debug(...a);
    process.stderr.write(util.format(...a) + "\n");
  };
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
    // Console surface) because some libraries bind every method up front - e.g.
    // @edge-runtime/primitives (pulled by Next.js) does
    // `console.count.bind(console)`, `console.timeLog.bind(console)`, ... at load,
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
  // Host worker_threads.markAsUntransferable (Node worker only) - used to protect the
  // Buffer pool's ArrayBuffer from being detached by a guest transferList. Null in
  // the browser (where the buffer.js detached-pool guard is the fallback).
  hostMarkUntransferable = null,
  // Worker threads (#16 stage 2b). `postRaw(msg, transfer)` sends a message to the
  // kernel with transferables (MessagePorts) - the shell provides it. `thread`
  // carries this worker's identity when it *is* a spawned thread.
  postRaw = null,
  thread = null,
  // child_process.fork child side: a dedicated IPC MessagePort to the parent.
  // When set, `process.send` / 'message' / connected / channel / disconnect are
  // bridged onto it (see below). Null for normal processes and worker threads.
  ipcPort = null,
  // Breakpoint debugger channel. `{ sab, send }`: `sab` is the debug-command
  // SharedArrayBuffer (kernel writes commands, this worker reads them while paused);
  // `send(jsonString)` posts a CDP event/response toward the frontend. Present only
  // when the process was spawned under a debug session (env VV_DEBUG=1). Null
  // otherwise → the debugger + instrumentation stay completely dormant.
  debug = null,
}) {
  // Signal delivery (packages/runtime/signals.js). Built after `process` is a
  // real EventEmitter (it needs newListener/emit), so the syscall park loop and
  // the event loop reach it through these forward declarations.
  let onPendingSignals = () => {};
  let drainSignals = () => {};
  let dispatchSignalEvent = () => {};

  const syscalls = createSyscalls({
    ctrl,
    data,
    notify,
    // Called while parked mid-syscall: queue only, never run guest code here.
    onSignal: (names) => onPendingSignals(names),
  });

  // Breakpoint debugger (packages/runtime/debugger.js). Created lazily in run() so
  // the parser (acorn) + backend code-split out of every non-debug process. Held
  // here so the returned `dispatchDebugCommand` can forward running-state commands.
  let __dbg = null;
  // The kernel is the authority on what gets debugged: it only wires a debug SAB
  // for a process it decided is a target (debug mode on / VV_DEBUG, minus the
  // shell + package-manager skip-list). So attaching on the SAB's presence alone
  // avoids depending on env propagation timing.
  const debugEnabled = !!(debug && debug.sab);

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
  // Liveness counter for Server-Sent Events tunnels: each live browser<->in-VM SSE
  // relay (a loopback GET holding an open text/event-stream response) keeps the loop
  // turning so it can pump chunks, like an open socket handle.
  const sseLiveness = { active: 0 };
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
      sseLiveness.active > 0 ||
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
    doSignal: () => drainSignals(),
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
  // rely on this - NestJS's watch mode kills the app child with process.kill()
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
    spawn: (reqId, spec, port, extraTransfer) => {
      // `port` is the child's parentPort end; `extraTransfer` are MessagePorts (and
      // other transferables) embedded in spec.workerData — both must be in the
      // transfer list or structuredClone rejects the ports ("could not be cloned").
      if (postRaw) {
        const transfer = extraTransfer && extraTransfer.length ? [port, ...extraTransfer] : [port];
        postRaw({ type: "thread-spawn", reqId, spec, port }, transfer);
      }
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
  // Cross-process pipe (UNIX socket) bridge. The net binding uses `postRaw` to
  // relay socket bytes to the kernel (which forwards them to the peer process) and
  // `wake` to nudge the loop when inbound bytes arrive; it publishes `dispatch` so
  // kernel-delivered pipe messages route back into the binding. See bindings/net.js.
  const pipeBridge = { postRaw, wake: loop.wakeNet, dispatch: null };
  const nodeModules = createNodeModules({ process, syscalls, netLiveness, netServers, codec, cryptoCodec, hostAsyncHooks, pipeBridge });
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
  // NOTE: `assert` is deliberately NOT in the eager table below. It is served
  // lazily by the vendored `node/lib/assert.js`, so `require('assert')` and
  // `require('assert/strict')` return the two halves of ONE module. An eager
  // shim used to win here (module.js consults `builtins` before the loader),
  // which made the two ids structurally different objects.

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

  // ---- signals ---------------------------------------------------------------
  // `process.on('SIGTERM'|'SIGINT', …)` is now real: the kernel posts the signal
  // to us (SAB bits + a message) and we emit it on a loop turn. Registering a
  // listener is also what tells the kernel to POST rather than APPLY the signal,
  // so a process with no handler keeps today's immediate termination. Deliberately
  // no loop-liveness ref, matching Node: a signal handler does not keep a
  // process alive on its own.
  {
    const signals = createSignalDelivery({ process, loop, postRaw });
    onPendingSignals = signals.onPending;
    drainSignals = signals.drain;
    dispatchSignalEvent = signals.dispatch;
  }

  // ---- fork IPC (child side): process.send / 'message' / disconnect ----------
  // A forked child (child_process.fork) runs as a normal main-thread process, but
  // gets a dedicated IPC MessagePort to its parent. Expose Node's fork surface -
  // process.send(), 'message' events, process.connected / process.channel /
  // process.disconnect() - bridged onto that port. Next.js's `next dev` forks its
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
  // strings - we have none) becomes a name→'' map so `Object.keys` yields the
  // core module list - drawn from listPublicBuiltins(), the SAME truthful source
  // Module.builtinModules uses. Unknown names return {} rather than throwing.
  {
    process.binding = (name) => {
      if (name === "natives") {
        const out = {};
        // Called long after boot (only by user bundles), so `builtins` - which
        // listPublicBuiltins() reads - is fully wired by now.
        for (const n of listPublicBuiltins()) out[n] = "";
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
  // line discipline below us - the terminal/line editor lives in guest code).
  stdin.setRawMode = (mode) => {
    stdin.isRaw = !!mode;
    return stdin;
  };
  process.stdin = stdin;
  // At EOF, release stdin's loop-ref. Attaching a 'data' listener resumes the
  // stream (setStdinRef(true)), which keeps the loop alive like an open TTY so an
  // idle shell/REPL waits for input. But once stdin ends (Ctrl+D, a closed pipe),
  // a process that only consumes stdin - e.g. a pipeline stage `... | node x.js`
  // that reads to 'end' and produces its output - must be free to go quiescent and
  // exit instead of hanging forever. Node unrefs the stdin handle at EOF; we mirror
  // that here. Other liveness (timers, servers, children) still keeps it alive.
  stdin.on("end", () => setStdinRef(false));
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

  // child_process.fork(modulePath[, args][, options]) - a forked child is a
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
    // fork stdio: default (silent:false) is 'inherit' - the child's output shows on
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
  // textual responses go as utf8 and *binary* responses (images, fonts, wasm - the
  // Vite dev server serves these) go base64-encoded with `bodyEncoding:'base64'`
  // so the Service Worker can reconstruct the exact bytes (roadmap #19 stage A).
  const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"];
  // Can these bytes cross as a utf8 string and come back identical? That is the
  // only question that matters, and the bytes answer it — the Content-Type does
  // not. A header saying `text/html; charset=iso-8859-1` is a promise about how
  // to *interpret* the bytes, not a promise that they are utf8, and decoding
  // them as utf8 anyway replaces every high byte with U+FFFD. `fatal` makes the
  // decoder throw instead of substituting; `ignoreBOM` keeps a leading U+FEFF in
  // the string instead of eating it (a stripped BOM is three lost bytes).
  // One pass, and it hands back the string it just validated.
  const asLosslessUtf8 = (buf) => {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
    } catch {
      return null;
    }
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
            const resp = { status: cres.statusCode || 200, headers };
            // Every response takes the same test, whatever it calls itself: utf8 if
            // the bytes survive the trip, base64 if they don't. There used to be a
            // "fast path" here that trusted a textual Content-Type and skipped the
            // check — it silently corrupted every latin-1 page and CSV an in-VM
            // server produced.
            const text = asLosslessUtf8(buf);
            if (text !== null) {
              resp.body = text;
            } else {
              resp.body = buf.toString("base64");
              resp.bodyEncoding = "base64";
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
    // A binary body (a file upload) crossed the JSON boundary base64-encoded,
    // exactly as binary responses do in the other direction; rebuild the bytes so
    // the guest handler sees what the client actually sent.
    let body;
    if (req.bodyPath) {
      // A body too big for the 1 MiB syscall window came through the VFS.
      try {
        body = fs.readFileSync(req.bodyPath);
      } catch (e) {
        fail(e);
        return;
      }
      try { fs.unlinkSync(req.bodyPath); } catch { /* best effort: it is scratch */ }
    } else if (req.bodyEncoding === "base64" && typeof req.body === "string") {
      body = Buffer.from(req.body, "base64");
    } else {
      body = req.body;
    }
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

  // ---- Server-Sent Events tunnel relay --------------------------------------
  // The browser preview can't stream a `text/event-stream` response through the
  // buffered HTTP preview proxy (the Service Worker resolves one complete body,
  // so a never-ending SSE response just times out). So an `EventSource` polyfill
  // in the preview iframe tunnels each logical connection to us as messages
  // (kernel -> this process): sse-open / sse-close. We open a genuine in-VM
  // loopback GET to 127.0.0.1:<port><path> for each, forward the raw event-stream
  // bytes back out (postRaw -> kernel -> host -> iframe) as sse-out
  // {sub:'open'|'chunk'|'close'}, and the iframe polyfill parses the SSE frames.
  // Mirrors the WebSocket tunnel above; SSE is one-way (server -> client) so
  // there's no inbound leg.
  const sseConns = new Map(); // connId -> ClientRequest
  const sseOut = (connId, sub, extra) => {
    if (postRaw) postRaw({ type: "sse-out", connId, sub, ...extra });
  };
  const sseDrop = (connId) => {
    if (sseConns.delete(connId) && sseLiveness.active > 0) sseLiveness.active--;
  };
  const sseRelay = {
    open(connId, port, path) {
      if (sseConns.has(connId)) return;
      let creq;
      try {
        creq = http.request(
          {
            host: "127.0.0.1",
            port: port | 0,
            method: "GET",
            path: path || "/",
            headers: { accept: "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
          },
          (cres) => {
            sseOut(connId, "open", { status: cres.statusCode | 0 });
            cres.on("data", (chunk) => {
              const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
              sseOut(connId, "chunk", { data: text });
            });
            cres.on("end", () => {
              sseDrop(connId);
              sseOut(connId, "close", {});
            });
            cres.on("error", () => {
              sseDrop(connId);
              sseOut(connId, "close", {});
            });
          },
        );
      } catch {
        sseOut(connId, "close", {});
        return;
      }
      creq.on("error", () => {
        sseDrop(connId);
        sseOut(connId, "close", {});
      });
      sseConns.set(connId, creq);
      sseLiveness.active++;
      loop.wakeNet();
      try {
        creq.end();
      } catch {
        /* closing */
      }
    },
    close(connId) {
      const creq = sseConns.get(connId);
      sseDrop(connId);
      if (creq) {
        try {
          creq.destroy();
        } catch {
          /* already gone */
        }
      }
    },
  };
  const dispatchSse = (msg) => {
    if (!msg) return;
    if (msg.type === "sse-open") sseRelay.open(msg.connId, msg.port, msg.path);
    else if (msg.type === "sse-close") sseRelay.close(msg.connId);
    loop.wakeNet();
  };

  // Pass the still-native console (Vite's HMR client logs through it) so
  // createConsole can relay [vite] banners there instead of the guest terminal.
  const consoleObj = createConsole(process, util, globalThis.console);

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
  // Accessors need at-most-once tracking where methods do not: a method mints a
  // fresh promise per call, but `closed` is created once per reader/writer and
  // handed back on every read, so refing each access would stack up refs that its
  // single settlement can never balance - a permanently alive loop, i.e. a hung
  // guest.
  const trackedHostPromises = new WeakSet();
  const trackHostOnce = (p) => {
    if (!p || typeof p.then !== "function" || trackedHostPromises.has(p)) return p;
    trackedHostPromises.add(p);
    return trackHost(p);
  };
  // Getter variant of wrapHostAsync, for host promises exposed as accessors
  // rather than methods (writer.ready, writer.closed, reader.closed) -
  // wrapHostAsync bails on those because the property is not a function. The
  // replacement stays an accessor: `ready` hands out a *different* promise each
  // time the queue fills and drains, so collapsing it to a data property would
  // pin the first one forever, and reading the original getter here at patch
  // time would force the promise into existence before any stream is in play.
  const wrapHostAsyncGetter = (obj, name) => {
    const desc = obj && Object.getOwnPropertyDescriptor(obj, name);
    if (!desc || typeof desc.get !== "function" || desc.get.__ocHostWrapped || !desc.configurable) return;
    const origGet = desc.get;
    const get = function () {
      return trackHostOnce(origGet.call(this));
    };
    get.__ocHostWrapped = true;
    Object.defineProperty(obj, name, { ...desc, get });
  };
  if (typeof WebAssembly !== "undefined") {
    for (const m of ["compile", "instantiate", "compileStreaming", "instantiateStreaming"]) {
      wrapHostAsync(WebAssembly, m);
    }
  }
  // Host alias for the *global* fetch(). Unlike http/https (which egress via
  // __ocfetch -> the Fetcher Worker, where rewrite() already maps the alias), the
  // global fetch is the host realm's real fetch used directly, so it needs its own
  // rewrite. Map `http://host.vivari.internal:<port>/...` to the studio's own
  // hostname (this realm is a Worker on the studio origin, so location.hostname IS
  // the host) - reaching a service on the HOST machine when the studio is served
  // locally. Headless (no browser realm) has no location and no-ops.
  const HOST_ALIAS = "host.vivari.internal";
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
        /* not an absolute URL - leave untouched */
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
  // buffering it whole via Response.arrayBuffer) drives these - e.g. corepack
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
  // The writer side of the same story. Writable.fromWeb / Duplex.fromWeb pump a
  // `writer.ready` -> `writer.write(chunk)` pair per chunk and finish with
  // close()/abort(), all settling on the host's queues; unrefed, the loop can
  // exit out from under a half-written transfer exactly as it could mid-download
  // before. The `closed` accessors matter too: the adapters hang the stream's
  // premature-close and error reporting off them (adapters.js), so a loop that
  // exits while one is pending drops the failure on the floor. Realms without
  // Web Streams (the headless worker_threads runtime) simply skip this.
  {
    const C = globalThis.WritableStreamDefaultWriter;
    if (typeof C === "function" && C.prototype) {
      for (const m of ["write", "close", "abort"]) wrapHostAsync(C.prototype, m);
      for (const g of ["ready", "closed"]) wrapHostAsyncGetter(C.prototype, g);
    }
  }
  for (const ctor of ["ReadableStreamDefaultReader", "ReadableStreamBYOBReader"]) {
    const C = globalThis[ctor];
    if (typeof C === "function" && C.prototype) wrapHostAsyncGetter(C.prototype, "closed");
  }

  // Exit-sentinel safety net. process.exit() throws a sentinel that the loop's
  // runCallback catches - but when exit() is called from a raw Promise microtask
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
  // fired - the synchronous accept loop starved them).
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

  // Async, non-blocking outbound fetch (parallel downloads). Unlike __ocfetch -
  // which parks the whole worker on Atomics.wait, forcing a single process's
  // registry requests to run one-at-a-time - this hands the request to the kernel
  // and returns a Promise that resolves when the kernel posts the result back
  // ({type:'fetch-done'} -> dispatchFetch). The npm/yarn/pnpm http client
  // (lib/https.js) uses this so many packuments/tarballs download concurrently.
  // Each in-flight request refs the loop (like a libuv handle) so the process
  // stays alive until it settles. Resolves with the same metadata __ocfetch
  // returns ({ status, ok, headers, contentType, size, path, cached }).
  let fetchSeq = 1;
  const pendingFetches = new Map(); // fetchId -> { resolve, reject }
  globalThis.__ocfetchAsync = (url, opts) =>
    new Promise((resolve, reject) => {
      const fetchId = fetchSeq++;
      pendingFetches.set(fetchId, { resolve, reject });
      hostLiveness.active++;
      try {
        syscalls.fetchAsync(fetchId, String(url), opts);
      } catch (e) {
        pendingFetches.delete(fetchId);
        if (hostLiveness.active > 0) hostLiveness.active--;
        reject(e);
      }
    });
  // External delivery from the kernel: a { type:'fetch-done', fetchId, ... }
  // reply. Settle the matching pending promise inside a loop turn (nextTick), so
  // a process.exit() from the continuation is honoured and microtasks flush in a
  // controlled order - the same discipline the fork IPC / stdin deliveries use.
  const dispatchFetch = (msg) => {
    const p = msg && msg.fetchId != null ? pendingFetches.get(msg.fetchId) : undefined;
    if (!p) return;
    pendingFetches.delete(msg.fetchId);
    if (hostLiveness.active > 0) hostLiveness.active--;
    loop.nextTick(() => {
      if (msg.ok) {
        p.resolve(msg.meta);
      } else {
        const err = new Error(msg.error || "EFETCH");
        err.code = msg.error || "EFETCH";
        p.reject(err);
      }
    });
    loop.wakeNet();
  };

  // Node v24's PUBLIC core module ids - the candidate set, not the answer. It is
  // intersected with what we can actually serve (see listPublicBuiltins), so an
  // id we don't implement never reaches a caller. Internal (`internal/*`),
  // underscore-legacy (`_http_*`) and our non-core vendored extras (`semver`,
  // `@napi-rs/wasm-runtime`) are deliberately absent: neither surface below is
  // supposed to advertise them.
  const NODE_PUBLIC_CORE_IDS = [
    "assert", "assert/strict", "async_hooks", "buffer", "child_process", "cluster",
    "console", "constants", "crypto", "dgram", "diagnostics_channel", "dns",
    "dns/promises", "domain", "events", "fs", "fs/promises", "http", "http2",
    "https", "inspector", "inspector/promises", "module", "net", "os", "path",
    "path/posix", "path/win32", "perf_hooks", "process", "punycode", "querystring",
    "readline", "readline/promises", "repl", "sqlite", "stream", "stream/consumers",
    "stream/promises", "stream/web", "string_decoder", "sys", "test",
    "test/reporters", "timers", "timers/promises", "tls", "trace_events", "tty",
    "url", "util", "util/types", "v8", "vm", "wasi", "worker_threads", "zlib",
  ];
  let publicBuiltinIds = null;
  // The ONE truthful builtin list. Both public "what can I require?" surfaces -
  // `process.binding('natives')` (read by is-core-module / builtin-modules) and
  // `Module.builtinModules` - answer from this, so they can't disagree, and it is
  // derived from what require() can genuinely serve: the eager `builtins` table
  // UNION the vendored loader's public ids. Previously the two were hardcoded
  // separately and both wrong in opposite directions - `natives` vouched for
  // dgram/domain/repl/sys (which hard-throw on require, so is-core-module sent
  // callers straight into that throw), while builtinModules listed only the eager
  // table (~20 names) and so disagreed with Module.isBuiltin, which has always
  // consulted the loader too.
  // Declared as a hoisted `function` on purpose: the process.binding shim above
  // closes over it long before this point in the file.
  function listPublicBuiltins() {
    if (publicBuiltinIds) return publicBuiltinIds;
    publicBuiltinIds = NODE_PUBLIC_CORE_IDS.filter(
      (id) => Object.prototype.hasOwnProperty.call(builtins, id) || nodeModules.has(id),
    );
    return publicBuiltinIds;
  }

  const builtins = {
    fs,
    path,
    os,
    process,
    util,
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
  // a dynamic import at runtime to dodge transpiler rewrites - piscina & tinypool
  // (Angular's parallel compiler, vitest's worker pool) do
  // `new Function('s', 'return import(s)')`. The Function constructor compiles that
  // in the host realm, so the inner import() escapes the sandbox and can't see our
  // VFS (it throws ERR_MODULE_NOT_FOUND against the host FS). We (a) expose a
  // loader-backed dynamic import as a global, and (b) wrap the Function
  // constructor so such bodies' import() is redirected to it.
  const vvRootRequire = moduleSystem.makeRequire("/");

  // Pre-seat `globalThis.fs` as a WRITABLE, CONFIGURABLE property pointing at the real
  // fs, BEFORE any Go/wasm toolchain loads. Multiple Go tools drive their wasm through
  // the global Go glue (`wasm_exec`), which installs an fs shim like:
  //   globalThis.fs || Object.defineProperty(globalThis, "fs", { value: nodeFs })
  // That defineProperty defaults to writable:false, configurable:false - so the FIRST
  // such tool LOCKS globalThis.fs. @astrojs/compiler (Go wasm that compiles .astro
  // files) does exactly this at import time; if it wins the race, esbuild-wasm's
  // in-process patch (esbuild-inproc-patch.js) can no longer do `globalThis.fs = __ocFs`
  // to multiplex its stdio fds - it throws "Cannot assign to read only property 'fs'"
  // and Vite's dep optimize dies. Seating a writable value here makes every tool's
  // `globalThis.fs || ...` short-circuit (never locking it) while esbuild/tsgo can still
  // reassign it for the duration of their own run. A plain assignment gives a
  // writable+configurable own data property, which is exactly what we want.
  try {
    if (!Object.getOwnPropertyDescriptor(globalThis, "fs")) {
      globalThis.fs = vvRootRequire("fs");
    }
  } catch {
    /* fs unavailable this early - tools will still install their own */
  }

  globalThis.__ocImport = (spec) =>
    Promise.resolve().then(() => {
      const s = String(spec);
      // Resolve bare specifiers from the running process's cwd (the project dir),
      // NOT '/', so an escape-hatch `import('pkg')` — built via `new Function('m',
      // 'return import(m)')` to dodge transpilation, e.g. @preact/preset-vite's
      // `import('zimmerframe')` in transform-hook-names — finds the project's
      // node_modules. Absolute/relative/builtin specifiers are base-agnostic. Fall
      // back to the '/'-rooted require on a miss to preserve the original behavior.
      let m;
      try {
        m = moduleSystem.makeRequire(process.cwd() || "/")(s);
      } catch (e) {
        if (e && e.code === "MODULE_NOT_FOUND") m = vvRootRequire(s);
        else throw e;
      }
      if (m && m.__esModule) return m;
      const ns = Object.create(null);
      // Mirror Node's CJS→ESM interop: named exports are the module.exports' own
      // enumerable keys, PLUS a `default`. Crucially this must also apply when the
      // export is a FUNCTION with statics hung off it - e.g. the `module` builtin
      // is the `Module` class carrying `createRequire`/`builtinModules`/... as
      // statics, and PGlite's Emscripten glue does
      // `const { createRequire } = await import('module')` (was undefined here,
      // surfacing as "e is not a function" deep in PGlite.create()).
      if (m && (typeof m === "object" || typeof m === "function")) {
        for (const k of Object.keys(m)) ns[k] = m[k];
      }
      ns.default = m;
      return ns;
    });
  {
    const NativeFunction = globalThis.Function;
    const OcFunction = function Function(...args) {
      if (args.length) {
        const body = args[args.length - 1];
        // Only touch bodies that actually contain a dynamic import (cheap guard -
        // virtually every `new Function` body doesn't), then rewrite precisely.
        if (typeof body === "string" && body.includes("import(")) {
          const rewritten = rewriteDynamicImportToGlobal(body);
          if (rewritten != null) args = args.slice(0, -1).concat(rewritten);
        }
      }
      // Build via Reflect.construct so the caller's new.target is honored. This is
      // what keeps `class X extends Function {}` working: super() must produce a
      // function object whose [[Prototype]] is X.prototype (not a bare
      // Function.prototype). A plain `NativeFunction.apply(this, args)` invokes the
      // real Function as an ORDINARY function, which ignores new.target and returns a
      // fresh function with Function.prototype — so a subclass instance loses its
      // whole prototype chain. @rsbuild/core's config chain (rspack-chain) bottoms
      // out at `class extends Function` returning a Proxy; without this, every mixin
      // method vanished ("this.extend is not a function") and `rsbuild dev` died.
      return Reflect.construct(NativeFunction, args, new.target || OcFunction);
    };
    // Preserve prototype identity so `x instanceof Function` and the shared
    // Function.prototype methods (call/apply/bind) keep working. Subclassing also
    // needs OcFunction to inherit statics from the real Function (via its proto).
    OcFunction.prototype = NativeFunction.prototype;
    Object.setPrototypeOf(OcFunction, NativeFunction);
    globalThis.Function = OcFunction;
  }

  // Node's `module` builtin default export IS the Module class, with the
  // namespace helpers hung off it as statics (createRequire, builtinModules,
  // isBuiltin, runMain, ...) and a self-reference `Module.Module`. Attaching them
  // to the constructor - rather than returning a separate plain object - is what
  // lets `const { Module } = require('module')`, `require('module') === Module`,
  // and monkey-patching `Module.prototype`/`_load`/`_extensions` all behave.
  const Module = moduleSystem.Module;
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
  // registerHooks/register (ESM loader hooks) - accept & ignore so tools that
  // call them at startup (tsx, ts-node/esm) don't crash; our loader is CJS-based.
  Module.register = () => undefined;
  Module.registerHooks = () => ({ deregister() {} });
  // Source-map lookups: no source-map registry in the sandbox. Return undefined
  // (Node's contract for "no map found") so callers that probe error stacks - e.g.
  // Next.js's dev overlay - get a clean miss instead of a TypeError.
  Module.findSourceMap = () => undefined;
  Module.SourceMap = class SourceMap {
    constructor(payload) { this.payload = payload; }
    findEntry() { return {}; }
  };
  builtins.module = Module;

  // `builtinModules` is the public list only (no `node:`-prefixed dupes and no
  // internal names) and comes from listPublicBuiltins() - the same truthful
  // source `process.binding('natives')` uses, so the two can never drift apart
  // and both agree with `Module.isBuiltin`.
  // Placement is load-bearing in BOTH directions: it must come AFTER
  // `builtins.module = Module` (or `module` itself is missing from the list -
  // the old snapshot sat above this line and did omit it) and BEFORE the `node:`
  // alias loop below. listPublicBuiltins() memoizes on first call, and this is
  // that call, so this is also what `process.binding('natives')` will report.
  Module.builtinModules = listPublicBuiltins().slice();

  // Support both `require('fs')` and `require('node:fs')`.
  for (const name of Object.keys(builtins)) builtins["node:" + name] = builtins[name];

  // ---- Bun runtime shim -----------------------------------------------------
  // Build the `Bun` global + `bun:*` builtin modules on top of the Node runtime.
  // The bun:* modules are registered unconditionally (only reachable via an
  // explicit `require('bun:sqlite')` etc.), added AFTER the node: alias loop so
  // they don't get spurious `node:bun:*` aliases. The `Bun` GLOBAL, however, is
  // installed lazily by the /bin/bun.js launcher through __ocInstallBun — so a
  // plain `node` process is never mistaken for Bun by libraries that branch on
  // `typeof Bun !== 'undefined'`. See packages/runtime/builtins/bun.js.
  //
  // TWO requires, deliberately. `vvRootRequire` is rooted at "/" and is right for
  // builtins, which are base-agnostic. It is WRONG for a project package: resolution
  // walks parent directories collecting node_modules (module.js nodeModulesPaths), so
  // from "/" the only candidate is /node_modules and a dependency installed into
  // <project>/node_modules is never on the path. bun:sqlite's old backend probe hit
  // exactly this — its own error message told users to `bun add @sqlite.org/sqlite-wasm`,
  // which installs somewhere the probe could not look. The second one resolves from the
  // running process's directory, the same precedent __ocImport already sets above. It is
  // a factory so it is built at the moment of use and a `process.chdir()` is honoured.
  const bunRuntime = createBunRuntime({
    process,
    Buffer,
    require: vvRootRequire,
    makeCwdRequire: () => moduleSystem.makeRequire(process.cwd() || cwd || "/"),
    // The loader's own resolver, for Bun.build's graph walk — so a bundle contains
    // what require() would have loaded here (see builtins/bun-build.js).
    resolveFrom: (specifier, fromDir) => moduleSystem.resolveFilename(specifier, fromDir),
  });
  for (const [name, mod] of Object.entries(bunRuntime.modules)) builtins[name] = mod;
  // `{ dotenv: true }` additionally performs Bun's automatic `.env` loading into
  // process.env (see builtins/bun-env.js). It is a parameter rather than part of
  // installing the global because the CLI installs Bun for reasons that are not
  // "run the user's code" — `bun --version` reads Bun.version off the global —
  // and because real Bun skips the default files for `bun run <script>` too,
  // leaving that to the `bun` the script itself starts (oven-sh/bun#9635).
  // `{ mode }` pins the file set instead of deriving it from NODE_ENV, which only
  // `bun test` needs (it chooses the `test` set before NODE_ENV is defaulted).
  globalThis.__ocInstallBun = (options) => {
    globalThis.Bun = bunRuntime.Bun;
    if (options && options.dotenv) bunRuntime.loadDotenv(options.mode);
    return bunRuntime.Bun;
  };

  // ---- Python runtime shim (lazy Pyodide) -----------------------------------
  // Like Bun, this is installed on demand — the /bin/python.js launcher calls
  // __ocInstallPython(indexURL) to boot Pyodide (CPython/WASM) from a same-origin
  // vendored index only when a `python` process actually runs, so a plain node
  // process pays nothing. See packages/runtime/builtins/python.js.
  const pythonRuntime = createPythonRuntime({ process, require: vvRootRequire, trackHost });
  globalThis.__ocInstallPython = (indexUrl) => pythonRuntime.install(indexUrl);

  return {
    fs,
    process,
    require: moduleSystem.makeRequire(cwd),
    /** External nudge from the kernel: a network request is queued for us. */
    wake: loop.wakeNet,
    /** Diagnostic: this process's own retention stats for the "Measure Memory"
     * per-PID breakdown. `modules` is how many files the guest module cache
     * holds (our load-once/retain-forever cache - the main runtime-side term);
     * `esbuildInproc` flags a resident esbuild Go wasm service. */
    memStats: () => ({
      modules: Object.keys(moduleSystem.cache).length,
      esbuildInproc: isEsbuildInprocActive(),
      // Bytes of the in-process esbuild Go wasm heap (0 if esbuild isn't here) -
      // attributes a concrete slice of this process's footprint.
      esbuildBytes: esbuildWasmBytes(),
      // WHY this process's loop is still alive, named handle by handle. A guest
      // that printed everything it was going to print and then never exited is
      // being ref'd by one of these, and from outside the worker every cause looks
      // identical: a pid that stays in the table. Reported alongside the memory
      // stats because they ride the same request, so `__vv.diag()` gains it for
      // free. Only the non-zero entries mean anything; all-zero means the loop is
      // NOT what is holding the process (look at a parent waiting on a child, or a
      // syscall that never got its reply).
      alive: {
        net: netLiveness.active,
        child: childLiveness.active,
        thread: threadLiveness.active,
        host: hostLiveness.active,
        watch: watchLiveness.active,
        ws: wsLiveness.active,
        sse: sseLiveness.active,
        stdin: stdinLiveness.active,
        ...loop.handleStats(),
      },
    }),
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
    /** External delivery from the kernel: a browser preview SSE tunnel message
     * ({type:'sse-open'|'sse-close', connId, ...}). Streams text/event-stream. */
    dispatchSse: (msg) => dispatchSse(msg),
    /** External delivery from the kernel: a cross-process pipe (UNIX socket)
     * message ({type:'pipe-open'|'pipe-data'|'pipe-shutdown'|'pipe-close',
     * connId, ...}) for a connection this process is an endpoint of. */
    dispatchPipe: (msg) => pipeBridge.dispatch && pipeBridge.dispatch(msg),
    /** External delivery from the kernel: an async fetch result
     * ({type:'fetch-done', fetchId, ok, meta|error}). Parallel downloads. */
    dispatchFetch: (msg) => dispatchFetch(msg),
    /** External delivery from the kernel: an interactive stdin chunk for THIS
     * process ({type:'stdin', chunk} - chunk null = EOF). Feeds process.stdin. */
    dispatchStdin: (msg) => dispatchStdin(msg),
    /** External delivery from the kernel: a catchable signal for THIS process
     * ({type:'signal', signal:'SIGTERM'|'SIGINT'|…}). Emitted on a loop turn. */
    dispatchSignal: (msg) => dispatchSignalEvent(msg),
    /** External delivery from the kernel: a CDP debugger command (JSON string) for
     * THIS process, delivered while it is RUNNING (paused commands ride the debug
     * SAB instead). No-op until a debug session is attached. */
    dispatchDebugCommand: (json) => {
      if (!__dbg) return;
      try {
        __dbg.onCommand(typeof json === "string" ? JSON.parse(json) : json);
      } catch {
        /* malformed command — ignore */
      }
    },
    /**
     * Run an entry file like `node <entry>`, then drive the event loop until it
     * is quiescent (no pending timers/immediates/nextTicks and no open servers).
     * Async: it yields to the host so Promise microtasks and timers actually
     * fire. Resolves with the process exit code.
     */
    async run(entry) {
      // Node fires a single synchronous 'exit' event with the final code right
      // before the process goes away - tools flush buffered output/logs there
      // (npm's exit-handler). Emit it once across every exit path below. A
      // listener may itself call process.exit() (→ throws the sentinel); we're
      // already exiting, so swallow it.
      // Attach the breakpoint debugger BEFORE the entry compiles (compile() reads
      // globalThis.__vvDebugHook to weave in probes). Lazy import keeps acorn + the
      // backend out of every ordinary process.
      if (debugEnabled && !__dbg) {
        try {
          const { createDebugger } = await import("./debugger.js");
          const { makeDebugViews, readDebugCommandBlocking } = await import("../protocol/debug.js");
          const views = makeDebugViews(debug.sab);
          __dbg = createDebugger({
            send: (msg) => {
              try {
                debug.send(JSON.stringify(msg));
              } catch {
                /* transport gone */
              }
            },
            // Blocks the worker thread on the debug SAB until the kernel posts a
            // command (while paused) or `timeoutMs` elapses (the start gate).
            waitForCommand: (timeoutMs) => {
              try {
                const s = readDebugCommandBlocking(views, timeoutMs);
                return s == null ? null : JSON.parse(s);
              } catch {
                return null;
              }
            },
          });
          globalThis.__vvdbg = __dbg.__vvdbg;
          globalThis.__vvDebugHook = __dbg;
          // --inspect-brk-style gate: block until the frontend has attached and sent
          // its breakpoints, so short synchronous entries still pause. Bounded so an
          // unattended debug run proceeds after a short delay.
          try {
            __dbg.waitForStart();
          } catch {}
        } catch (e) {
          try {
            process.stderr.write("[vv-debug] failed to attach debugger: " + ((e && e.message) || e) + "\n");
          } catch {}
          __dbg = null;
        }
      }
      let exitEmitted = false;
      const finish = (code) => {
        if (!exitEmitted) {
          exitEmitted = true;
          if (process.exitCode == null) process.exitCode = code;
          try {
            process.emit("exit", code);
          } catch {
            /* a listener called process.exit() - the sentinel is expected */
          }
        }
        return code;
      };
      // Anything already holding the loop at this point is not the guest's, because
      // the guest has not run a line yet — so it must not keep the guest alive.
      //
      // We install our timers ON globalThis (setInterval above), and a Process
      // Worker's globals are shared with whatever else the host put in that worker.
      // Any of it that registers a handle registers it in the GUEST's loop, where it
      // votes on whether the guest is done. Nothing host-side has that right.
      //
      // Disowning rather than clearing: those callbacks belong to the host and should
      // keep firing, they just have no business keeping a finished guest alive.
      //
      // This is not sufficient on its own. The dev server's HMR ping — the hang this
      // was written for — is armed from an async connect AFTER the entry starts, so
      // it slips past this entirely; loop.js unrefs that one by its creation frame.
      loop.disownExistingHandles();
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
      // driving the loop - its awaits may depend on timers/microtasks the loop
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