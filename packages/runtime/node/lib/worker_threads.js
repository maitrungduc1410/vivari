// node:worker_threads — a real (if lean) implementation (Phase 2 #16 stage 2b).
//
// A `new Worker(entry)` spawns a *nested* worker under the same kernel: the
// kernel allocates it a fresh syscall SAB + File System Worker registration
// (so the thread can do real fs/net syscalls) and brokers its lifecycle. But
// the parent<->child *data* channel is a plain MessageChannel wired end to end
// (port1 stays with the Worker, port2 is transferred through the kernel to the
// child as its parentPort), so postMessage() traffic — including SharedArrayBuffer
// — flows directly, never through the kernel. Messages are pumped into the event
// loop (host.registerDrain) exactly like async child_process events (#15), and a
// running Worker (parent) / an active parentPort listener (child) keeps the loop
// alive via host.retain/release.
//
// This is the general worker_threads capability (piscina, tinypool, workerpool,
// jest workers, user code). NOTE: it does NOT by itself make multi-threaded
// N-API (napi-rs async-work) addons run — that path (emnapi AWMT) is blocked
// upstream regardless of this layer; see roadmap #16 stage 2b.
//
// Scope: Worker(entry, {workerData, argv, env, cwd, eval, transferList}),
// postMessage/on('message'|'online'|'exit'|'error')/terminate/ref/unref,
// parentPort, workerData, threadId, isMainThread, MessageChannel/MessagePort
// (platform ports with Node's semantics — see ../../message-port.js), and
// receiveMessageOnPort (synchronous manual-polling drain).
// MessagePorts embedded in `workerData` (the `createSyncFn`/synckit pattern:
// `new Worker(f, { workerData: { port }, transferList: [port] })`) ARE now handed
// across to the child — see collectTransferables + host.spawn. Deferred:
// resourceLimits and the Atomics worker-pool fast path (kept off via
// PISCINA_DISABLE_ATOMICS=1 — a browser MessagePort can't be drained
// synchronously across a worker boundary).

import { installMessagePort } from "../../message-port.js";
import { fileUrlSpecifierToPath } from "../../file-url.js";

export default function (exports, require, module, process) {
  const g = globalThis;
  const EventEmitter = require("events");
  const host = process.__wtHost || null;

  // createRuntime installed this at boot; the call only hands back the handle.
  const ports = installMessagePort(g, host);
  const internalPortSetup = ports ? ports.internalPortSetup : (fn) => fn();
  const NativeMessageChannel = ports ? ports.NativeMessageChannel : g.MessageChannel;
  const isCloseSignal = ports ? ports.isCloseSignal : () => false;
  const markEventPorts = ports ? ports.markEventPorts : () => {};

  // ---- a single event queue drained inside a loop turn (like #15) -----------
  // Emitting 'message'/'exit' directly from a raw port's onmessage would run user
  // code outside the loop's runCallback (a process.exit() there would leak). So we
  // queue and let the loop drain us; host.wake() breaks the idle wait.
  const eventQueue = [];
  const enqueue = (emitter, type, args, after) => {
    eventQueue.push({ emitter, type, args, after });
    if (host) host.wake();
  };
  const enqueueRun = (run) => {
    eventQueue.push({ run });
    if (host) host.wake();
  };
  const drain = () => {
    while (eventQueue.length) {
      const { emitter, type, args, after, run } = eventQueue.shift();
      if (run) {
        run();
        continue;
      }
      emitter.emit(type, ...args);
      // Post-emit hook: release liveness only *after* the event is delivered, so
      // the loop doesn't decide it's idle (and skip this very drain) between the
      // liveness drop and the emit. See dispatchLifecycle('thread-exit').
      if (after) after();
    }
  };

  const isMainThread = host ? host.isMainThread : true;
  const threadId = host ? host.threadId : 0;
  const workerData = host ? (host.workerData ?? null) : null;

  // ---- parentPort (child side): the transferred MessagePort itself ----------
  // A real MessagePort, as on Node — so `onmessage`, `addEventListener` and
  // `instanceof MessagePort` work, and listening holds the thread exactly like any
  // other guest port. What it keeps from the old wrapper is delivery inside a
  // loop turn: its listeners run from the drain, not from the platform's event.
  function adoptParentPort(port) {
    if (!ports) return port;
    ports.markGuest(port);
    ports.setDelivery(port, enqueueRun);
    return port;
  }
  const parentPort = host && host.parentPort ? adoptParentPort(host.parentPort) : null;

  // ---- Worker (parent side) -------------------------------------------------
  const workers = new Map(); // reqId -> Worker
  let seq = 1;

  function resolveEntry(filename, options) {
    if (options && options.eval) {
      // Materialize the code string as a temp module so the child boots it like a
      // file (our runtime runs files, not eval strings, at boot).
      const fs = require("fs");
      const id = "/tmp/.vv-worker-" + process.pid + "-" + seq + ".js";
      try { fs.mkdirSync("/tmp", { recursive: true }); } catch { /* exists */ }
      fs.writeFileSync(id, String(filename));
      return id;
    }
    let p = filename;
    // `new Worker(new URL(...))` is a documented Node form, so take the whole href —
    // `pathname` alone would drop a segment a parser promoted into the host — and map
    // it through the runtime's ONE file: URL rule (../../file-url.js). A naive strip
    // turns the hostful form Chrome/Windows produces into a RELATIVE path.
    if (p && typeof p === "object" && typeof p.href === "string") p = p.href; // URL
    p = String(p);
    if (p.startsWith("file:")) p = fileUrlSpecifierToPath(p);
    return p;
  }

  function buildEnv(optEnv) {
    if (!optEnv || optEnv === exports.SHARE_ENV) return { ...process.env };
    return { ...optEnv };
  }

  // Gather the transferables that must ride the spawn message's transfer list so
  // the browser's structuredClone doesn't reject them. Two sources:
  //   - the caller's explicit `transferList` (Node's contract for `new Worker`), and
  //   - any MessagePort *embedded* in `workerData` — the createSyncFn/synckit shape
  //     `new Worker(f, { workerData: { port }, transferList: [port] })`. A port
  //     cannot be cloned, so if it isn't transferred the very first postMessage of
  //     the spawn (process-worker -> kernel) throws "A MessagePort could not be
  //     cloned because it was not transferred", which manifested as a silent hang
  //     (VitePress importing a synckit-backed dep).
  // `exclude` is the parentPort end (host.spawn transfers it separately). Cyclic /
  // deep graphs are guarded (WeakSet + depth cap).
  function collectTransferables(workerData, transferList, exclude) {
    const MP = g.MessagePort;
    const out = [];
    const seen = new Set();
    const push = (v) => {
      if (v && v !== exclude && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    };
    if (Array.isArray(transferList)) for (const t of transferList) push(t);
    if (MP) {
      const visited = new WeakSet();
      const scan = (v, depth) => {
        if (!v || typeof v !== "object" || depth > 6) return;
        if (v instanceof MP) return push(v);
        if (visited.has(v)) return;
        visited.add(v);
        if (Array.isArray(v)) {
          for (const x of v) scan(x, depth + 1);
          return;
        }
        for (const k of Object.keys(v)) {
          let child;
          try {
            child = v[k];
          } catch {
            continue; // a throwing getter — skip it
          }
          scan(child, depth + 1);
        }
      };
      scan(workerData, 0);
    }
    return out;
  }

  // A minimal, inert Readable-shaped stub for Worker.stdout/stderr. It never
  // emits data (the child's output is forwarded by the kernel), but supports the
  // pipe/unpipe/listener surface pool libraries poke at.
  function makeInertReadable() {
    const s = new EventEmitter();
    s.readable = true;
    s.readableEnded = false;
    s.destroyed = false;
    s.pipe = (dest) => dest;
    s.unpipe = () => s;
    s.read = () => null;
    s.pause = () => s;
    s.resume = () => s;
    s.isPaused = () => false;
    s.setEncoding = () => s;
    s.destroy = () => { s.destroyed = true; return s; };
    return s;
  }

  class Worker extends EventEmitter {
    constructor(filename, options = {}) {
      super();
      if (!host || !host.spawn) {
        throw new Error(
          "worker_threads.Worker is unavailable in this context (no thread host)",
        );
      }
      options = options || {};
      const reqId = seq++;
      this.threadId = -1;
      this._reqId = reqId;
      this._exited = false;
      this._exitCode = null;
      this._refed = true;
      this._msgRefs = 0;
      this._portHeld = false;
      this._portClosed = false;
      this.on("newListener", (name) => { if (name === "message") this._msgRetain(); });
      this.on("removeListener", (name) => { if (name === "message") this._msgRelease(); });

      // The runtime's own channel: the Worker accounts for its port itself
      // (_msgRetain/_portRef below), so it must not also hold as a guest port.
      const { port1, port2 } = new NativeMessageChannel();
      this._port = port1;
      internalPortSetup(() => {
        port1.onmessage = (e) => {
          // The child closed parentPort. Queued behind the messages it posted
          // first, so those are still delivered.
          if (isCloseSignal(e.data)) return enqueueRun(() => this._closePort());
          markEventPorts(e);
          enqueue(this, "message", [e.data]);
        };
      });
      try { port1.start && port1.start(); } catch { /* auto-starts */ }

      workers.set(reqId, this);
      if (host) host.retain(); // a running Worker keeps the parent's loop alive

      const spec = {
        programPath: resolveEntry(filename, options),
        argv: options.argv || [],
        env: buildEnv(options.env),
        cwd: options.cwd || process.cwd(),
        workerData: options.workerData,
        isThread: true,
        // child_process.fork rides the same spawn plumbing but boots the child in
        // *fork mode*: a normal (main-thread) process whose transferred port is an
        // IPC channel (process.send / 'message'), not a worker parentPort.
        isFork: !!options._ocFork,
      };
      // Hand the child's end of the channel to the kernel, which transfers it on
      // to the new worker as its parentPort. Data traffic then flows port1<->port2
      // directly; the kernel only brokers online/exit/terminate. Any MessagePort
      // the caller stashed in workerData/transferList rides along in the transfer
      // list (else the browser throws "could not be cloned" on the spawn message).
      const extraTransfer = collectTransferables(options.workerData, options.transferList, port2);
      host.spawn(reqId, spec, port2, extraTransfer);
    }

    postMessage(value, transferList) {
      this._port.postMessage(value, transferList || []);
    }

    terminate() {
      if (!this._exited && host) host.terminate(this._reqId);
      return Promise.resolve(this._exitCode | 0);
    }

    // A Worker holds the parent's loop open TWICE: once for the thread handle,
    // and once for the public MessagePort underneath `worker.on('message')`.
    // ref()/unref() move both, and the port can be re-taken afterwards, which
    // makes the observable behaviour depend on the ORDER of the two calls. On
    // real Node:
    //
    //   w.unref(); w.on('message', …)   → parent waits, and hears the reply
    //   w.on('message', …); w.unref()   → parent exits, reply never arrives
    //
    // because listening on a port start()s it, and starting refs it — so a
    // listener added AFTER unref() takes a fresh hold, while one added before is
    // dropped along with everything else. (Both were measured on Node 22, at a
    // 1.5s reply, after an earlier version of this modelled only the first line
    // and broke the second.)
    //
    // Neither line is a curiosity. The first is @napi-rs/wasm-runtime (rolldown's
    // wasm32-wasi binding, which vitest 4 pulls in through Vite 8): it unrefs each
    // pool worker the moment it spawns one and then awaits the reply. Modelling
    // unref() as the only hold, our loop went idle between "spawn" and "reply" and
    // the process exited — no error, no output, exit 0, which is the worst way to
    // fail a test run. The second is what unref() is FOR: a parent that should not
    // be held open by a listener it left attached to a background worker.
    ref() {
      if (!this._refed && !this._exited) { this._refed = true; host && host.retain(); }
      if (this._msgRefs > 0) this._portRef();
    }
    unref() {
      if (this._refed && !this._exited) { this._refed = false; host && host.release(); }
      this._portRelease();
    }

    // The port half. `_msgRefs` counts 'message' listeners; `_portHeld` is whether
    // the port is currently holding the loop, which unref() can drop while
    // listeners remain and a later listener can take back — unless the port is
    // closed. The child closing parentPort closes it, as on Node: an unref'd
    // Worker then stops holding the parent even if the thread keeps running.
    _portRef() {
      if (!this._portHeld && !this._exited && !this._portClosed && host) { this._portHeld = true; host.retain(); }
    }
    _portRelease() {
      if (this._portHeld && host) { this._portHeld = false; host.release(); }
    }
    _closePort() {
      this._portClosed = true;
      this._portRelease();
      try { this._port.close(); } catch { /* already closed */ }
    }
    _msgRetain() {
      this._msgRefs++;
      this._portRef();
    }
    _msgRelease() {
      if (this._msgRefs > 0 && --this._msgRefs === 0) this._portRelease();
    }

    // The child's real stdout/stderr already flow through the kernel to the
    // parent, so we don't re-pipe bytes here. But pool libraries (vitest/tinypool
    // with `{ stdout: true, stderr: true }`) do `worker.stdout.pipe(dest)` and
    // `.unpipe()` around each run — so these must be pipe-able Readable-shaped
    // objects, not null. They're inert (never emit data); test results travel
    // over the message channel, not stdout.
    get stdout() { return (this._stdout ||= makeInertReadable()); }
    get stderr() { return (this._stderr ||= makeInertReadable()); }
    get stdin() { return null; }
  }

  // Lifecycle messages relayed by the kernel (via the worker shell -> runtime
  // dispatchThread -> here): { type:'thread-started'|'thread-exit', reqId, ... }.
  function dispatchLifecycle(msg) {
    const w = workers.get(msg.reqId);
    if (!w) return;
    if (msg.type === "thread-started") {
      w.threadId = msg.threadId | 0;
      enqueue(w, "online", []);
    } else if (msg.type === "thread-exit") {
      if (w._exited) return;
      w._exited = true;
      w._exitCode = msg.code | 0;
      workers.delete(msg.reqId);
      // Release AFTER 'exit' is emitted (drain's `after` hook) so liveness stays
      // up until the event is delivered — otherwise the loop goes idle first and
      // never drains this event.
      enqueue(w, "exit", [msg.code | 0], () => {
        if (w._refed && host) host.release();
        // The port's hold ends with the thread: there is nothing left that could
        // send a message, so listeners still attached must not pin the loop.
        w._msgRefs = 0;
        w._portRelease();
      });
    }
  }

  if (host) {
    host.registerDrain(drain);
    host.registerDispatch(dispatchLifecycle);
  }

  const environmentData = new Map();

  exports.isMainThread = isMainThread;
  exports.threadId = threadId;
  exports.parentPort = parentPort;
  exports.workerData = workerData;
  exports.resourceLimits = {};
  exports.SHARE_ENV = Symbol.for("nodejs.worker_threads.SHARE_ENV");
  exports.Worker = Worker;

  exports.MessageChannel = ports ? ports.MessageChannel : g.MessageChannel;
  exports.MessagePort = g.MessagePort;
  exports.BroadcastChannel = g.BroadcastChannel;

  exports.setEnvironmentData = (key, value) => {
    if (value === undefined) environmentData.delete(key);
    else environmentData.set(key, value);
  };
  exports.getEnvironmentData = (key) => environmentData.get(key);

  // ---- receiveMessageOnPort (Node's synchronous port drain) -----------------
  // Node lets a consumer pull a queued message off a MessagePort WITHOUT going
  // through the event loop, returning { message } or undefined when empty. Worker
  // pools (Piscina/tinypool) use it after Atomics.wait as a fast path; our runtime
  // defaults pools to the async message path (PISCINA_DISABLE_ATOMICS=1) because a
  // browser MessagePort can't be drained synchronously across a worker boundary.
  // But libraries that use receiveMessageOnPort directly (manual polling mode)
  // still need correct semantics. We attach a lazy per-port inbox the first time a
  // port is polled: every message the JS side receives from then on is buffered
  // and shifted out here. Lazy (not eager on every port) so ports used purely with
  // the event API never grow an undrained buffer — that would be a memory leak on a
  // long-running dev server. Like Node, it returns only messages already delivered
  // and never blocks waiting for new ones. Nor does polling hold the loop: Node's
  // receiveMessageOnPort adds no listener, so the inbox is runtime plumbing.
  const RX_INBOX = Symbol("vvPortRxInbox");
  function armInbox(port) {
    let inbox = port[RX_INBOX];
    if (inbox) return inbox;
    inbox = port[RX_INBOX] = [];
    try {
      internalPortSetup(() => {
        port.addEventListener("message", (e) => {
          if (isCloseSignal(e.data)) return;
          markEventPorts(e);
          inbox.push(e.data);
        });
        port.start && port.start();
      });
    } catch {
      /* not a real MessagePort — leave the (empty) inbox */
    }
    return inbox;
  }
  exports.receiveMessageOnPort = (port) => {
    if (!port || typeof port.addEventListener !== "function") return undefined;
    const inbox = armInbox(port);
    return inbox.length ? { message: inbox.shift() } : undefined;
  };
  exports.markAsUntransferable = (obj) => obj;
  exports.isMarkedAsUntransferable = () => false;
  exports.moveMessagePortToContext = () => {
    throw new Error("worker_threads.moveMessagePortToContext is not supported");
  };
}
