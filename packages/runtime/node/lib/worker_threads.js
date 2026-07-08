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
// Scope: Worker(entry, {workerData, argv, env, cwd, eval}), postMessage/on(
// 'message'|'online'|'exit'|'error')/terminate/ref/unref, parentPort, workerData,
// threadId, isMainThread, MessageChannel/MessagePort (platform). Deferred:
// transferring MessagePorts in a transferList across threads, resourceLimits.

export default function (exports, require, module, process) {
  const g = globalThis;
  const EventEmitter = require("events");
  const host = process.__wtHost || null;

  // ---- a single event queue drained inside a loop turn (like #15) -----------
  // Emitting 'message'/'exit' directly from a raw port's onmessage would run user
  // code outside the loop's runCallback (a process.exit() there would leak). So we
  // queue and let the loop drain us; host.wake() breaks the idle wait.
  const eventQueue = [];
  const enqueue = (emitter, type, args, after) => {
    eventQueue.push({ emitter, type, args, after });
    if (host) host.wake();
  };
  const drain = () => {
    while (eventQueue.length) {
      const { emitter, type, args, after } = eventQueue.shift();
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

  // ---- parentPort (child side): wrap the raw transferred MessagePort ---------
  // Node's parentPort is an EventEmitter-flavoured MessagePort. We expose on(
  // 'message')/postMessage/close/ref/unref and keep the worker alive while it has
  // a 'message' listener (Node semantics: a listening parentPort refs the loop).
  function wrapParentPort(raw) {
    const ee = new EventEmitter();
    let refs = 0;
    const retain = () => { if (refs++ === 0 && host) host.retain(); };
    const release = () => { if (refs > 0 && --refs === 0 && host) host.release(); };
    raw.onmessage = (e) => enqueue(ee, "message", [e.data]);
    try { raw.start && raw.start(); } catch { /* onmessage auto-starts */ }
    ee.postMessage = (value, transferList) => raw.postMessage(value, transferList || []);
    ee.start = () => {};
    ee.close = () => { try { raw.close(); } catch { /* ignore */ } if (refs > 0) { refs = 0; host && host.release(); } };
    ee.ref = () => retain();
    ee.unref = () => { if (refs > 0) { refs = 0; host && host.release(); } };
    ee.on("newListener", (name) => { if (name === "message") retain(); });
    ee.on("removeListener", (name) => { if (name === "message") release(); });
    return ee;
  }
  const parentPort = host && host.parentPort ? wrapParentPort(host.parentPort) : null;

  // ---- Worker (parent side) -------------------------------------------------
  const workers = new Map(); // reqId -> Worker
  let seq = 1;

  function resolveEntry(filename, options) {
    if (options && options.eval) {
      // Materialize the code string as a temp module so the child boots it like a
      // file (our runtime runs files, not eval strings, at boot).
      const fs = require("fs");
      const id = "/tmp/.oc-worker-" + process.pid + "-" + seq + ".js";
      try { fs.mkdirSync("/tmp", { recursive: true }); } catch { /* exists */ }
      fs.writeFileSync(id, String(filename));
      return id;
    }
    let p = filename;
    if (p && typeof p === "object" && p.href) p = p.pathname || p.href; // URL
    p = String(p);
    if (p.startsWith("file://")) p = p.slice(7);
    return p;
  }

  function buildEnv(optEnv) {
    if (!optEnv || optEnv === exports.SHARE_ENV) return { ...process.env };
    return { ...optEnv };
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

      const { port1, port2 } = new g.MessageChannel();
      this._port = port1;
      port1.onmessage = (e) => enqueue(this, "message", [e.data]);
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
      };
      // Hand the child's end of the channel to the kernel, which transfers it on
      // to the new worker as its parentPort. Data traffic then flows port1<->port2
      // directly; the kernel only brokers online/exit/terminate.
      host.spawn(reqId, spec, port2);
    }

    postMessage(value, transferList) {
      this._port.postMessage(value, transferList || []);
    }

    terminate() {
      if (!this._exited && host) host.terminate(this._reqId);
      return Promise.resolve(this._exitCode | 0);
    }

    ref() { if (!this._refed && !this._exited) { this._refed = true; host && host.retain(); } }
    unref() { if (this._refed && !this._exited) { this._refed = false; host && host.release(); } }

    // stdio piping to the parent is not modelled (Node defaults to inheriting the
    // parent's stdout/stderr, which our kernel already does for the child worker).
    get stdout() { return null; }
    get stderr() { return null; }
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

  exports.MessageChannel = g.MessageChannel;
  exports.MessagePort = g.MessagePort;
  exports.BroadcastChannel = g.BroadcastChannel;

  exports.setEnvironmentData = (key, value) => {
    if (value === undefined) environmentData.delete(key);
    else environmentData.set(key, value);
  };
  exports.getEnvironmentData = (key) => environmentData.get(key);

  exports.receiveMessageOnPort = () => undefined;
  exports.markAsUntransferable = (obj) => obj;
  exports.isMarkedAsUntransferable = () => false;
  exports.moveMessagePortToContext = () => {
    throw new Error("worker_threads.moveMessagePortToContext is not supported");
  };
}
