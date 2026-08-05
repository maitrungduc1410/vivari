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
// (platform), and receiveMessageOnPort (synchronous manual-polling drain).
// MessagePorts embedded in `workerData` (the `createSyncFn`/synckit pattern:
// `new Worker(f, { workerData: { port }, transferList: [port] })`) ARE now handed
// across to the child — see collectTransferables + host.spawn. Deferred:
// resourceLimits and the Atomics worker-pool fast path (kept off via
// PISCINA_DISABLE_ATOMICS=1 — a browser MessagePort can't be drained
// synchronously across a worker boundary).

export default function (exports, require, module, process) {
  const g = globalThis;
  const EventEmitter = require("events");
  const host = process.__wtHost || null;

  // Node's MessagePort is an EventEmitter — `port.on('message', (value) => ...)`
  // with the posted value delivered directly. The platform MessagePort is an
  // EventTarget — `addEventListener('message', (e) => e.data)`. Worker pools
  // (Piscina, which backs Angular's compiler and vitest) call `port.on(...)`
  // straight on ports returned by `new MessageChannel()`, so bridge the
  // EventEmitter surface onto the platform prototype. The ports stay real (and
  // therefore transferable in a transferList); we only add methods.
  // Both assigned by patchMessagePortPrototype, which owns the port bookkeeping.
  let duringInternalSetup = false;
  let internalPortSetup = (fn) => fn();
  patchMessagePortPrototype(g.MessagePort);

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
    internalPortSetup(() => {
      raw.onmessage = (e) => enqueue(ee, "message", [e.data]);
      try { raw.start && raw.start(); } catch { /* onmessage auto-starts */ }
    });
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
      const id = "/tmp/.vv-worker-" + process.pid + "-" + seq + ".js";
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
      this.on("newListener", (name) => { if (name === "message") this._msgRetain(); });
      this.on("removeListener", (name) => { if (name === "message") this._msgRelease(); });

      const { port1, port2 } = new g.MessageChannel();
      this._port = port1;
      internalPortSetup(() => {
        port1.onmessage = (e) => enqueue(this, "message", [e.data]);
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
    // listeners remain and a later listener can take back.
    _portRef() {
      if (!this._portHeld && !this._exited && host) { this._portHeld = true; host.retain(); }
    }
    _portRelease() {
      if (this._portHeld && host) { this._portHeld = false; host.release(); }
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

  exports.MessageChannel = g.MessageChannel;
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
  // and never blocks waiting for new ones.
  const RX_INBOX = Symbol("vvPortRxInbox");
  function armInbox(port) {
    let inbox = port[RX_INBOX];
    if (inbox) return inbox;
    inbox = port[RX_INBOX] = [];
    try {
      port.addEventListener("message", (e) => inbox.push(e.data));
      port.start && port.start();
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

  // Add Node's EventEmitter-style methods to the platform MessagePort prototype,
  // mapping onto addEventListener/removeEventListener. Idempotent (guarded by a
  // marker) and additive, so platform `onmessage`/`addEventListener` users are
  // unaffected. A first `on('message')` call auto-starts the port (Node
  // semantics). Ports remain real MessagePort instances, so `instanceof` and
  // transfer still work.
  function patchMessagePortPrototype(MessagePort) {
    const proto = MessagePort && MessagePort.prototype;
    if (!proto || proto.__ocNodeEvents) return;
    proto.__ocNodeEvents = true;
    const LISTENERS = Symbol("vvPortListeners");
    const bag = (port) => port[LISTENERS] || (port[LISTENERS] = new Map());
    const dataEvents = new Set(["message", "messageerror"]);

    // A listening port keeps the process alive, which is the whole reason a
    // channel handed to someone else is usable: you listen, they reply later,
    // and Node is still running when they do. The platform MessagePort has no
    // such notion — the host worker's loop is not ours — so the hold is ours to
    // model, on the same counter every other handle uses.
    //
    // Without it, `const { port1, port2 } = new MessageChannel()` plus
    // `port1.on('message', …)` was a promise waiting on an event loop that had
    // already decided it had nothing to do. That is how `vitest run` exited 0
    // having run nothing: rolldown's wasm binding (@napi-rs/wasm-runtime, via
    // Vite 8) spawns its wasi worker, hands it a channel, and awaits the reply.
    // The reply was on its way; the process was not there to receive it.
    //
    // ref()/unref() move the hold without touching the listener count, so the
    // Node ordering holds: unref() then on('message') listens and waits,
    // on('message') then unref() lets the process go.
    const HELD = Symbol("vvPortHeld");
    const MSG_REFS = Symbol("vvPortMsgRefs");
    // Which ports are the GUEST's. A port becomes one by being created through
    // the guest's MessageChannel or by the guest listening on it; the runtime's
    // own plumbing ports never are, so their ref() stays purely the platform's.
    // Assigning `port.onmessage` refs the port — Node's own EventTarget
    // bookkeeping calls ref() from the newListener hook — and the runtime does
    // that on its OWN ports: the Worker's half of the parent<->child channel, and
    // the raw port behind parentPort. Those are plumbing, not the guest's loop, so
    // the ref that comes back through here during our setup must not hold the
    // guest open. Held it once and every worker spawn hung: the parent waited on a
    // child whose own runtime port was keeping it alive for ever.
    internalPortSetup = (fn) => {
      const prev = duringInternalSetup;
      duringInternalSetup = true;
      try {
        return fn();
      } finally {
        duringInternalSetup = prev;
      }
    };
    const portRef = (port) => {
      if (!port[HELD] && host) {
        port[HELD] = true;
        host.retain();
      }
    };
    const portRelease = (port) => {
      if (port[HELD] && host) {
        port[HELD] = false;
        host.release();
      }
    };
    proto.addListener = proto.on = function on(type, listener) {
      const wrapped = dataEvents.has(type) ? (e) => listener(e.data) : (e) => listener(e);
      const b = bag(this);
      let byType = b.get(type);
      if (!byType) b.set(type, (byType = new Map()));
      byType.set(listener, wrapped);
      this.addEventListener(type, wrapped);
      if (type === "message") {
        try {
          this.start();
        } catch {
          /* onmessage/addEventListener already auto-started it */
        }
        this[MSG_REFS] = (this[MSG_REFS] || 0) + 1;
        portRef(this);
      }
      return this;
    };
    proto.once = function once(type, listener) {
      const self = this;
      const one = function (value) {
        self.removeListener(type, one);
        listener(value);
      };
      return this.on(type, one);
    };
    proto.removeListener = proto.off = function off(type, listener) {
      const byType = bag(this).get(type);
      const wrapped = byType && byType.get(listener);
      if (wrapped) {
        this.removeEventListener(type, wrapped);
        byType.delete(listener);
        if (type === "message" && this[MSG_REFS] > 0 && --this[MSG_REFS] === 0) portRelease(this);
      }
      return this;
    };
    proto.removeAllListeners = function removeAllListeners(type) {
      const b = bag(this);
      for (const t of type ? [type] : [...b.keys()]) {
        const byType = b.get(t);
        if (byType) for (const w of byType.values()) this.removeEventListener(t, w);
        b.delete(t);
        if (t === "message") {
          this[MSG_REFS] = 0;
          portRelease(this);
        }
      }
      return this;
    };
    proto.emit = function emit(type, arg) {
      try {
        this.dispatchEvent(dataEvents.has(type) ? new MessageEvent(type, { data: arg }) : new Event(type));
      } catch {
        /* best effort */
      }
      return true;
    };
    proto.listeners = function listeners(type) {
      const byType = bag(this).get(type);
      return byType ? [...byType.keys()] : [];
    };
    proto.listenerCount = function listenerCount(type) {
      const byType = bag(this).get(type);
      return byType ? byType.size : 0;
    };
    // ref() takes the hold with no listener required, and that is not a detail:
    // it is the whole mechanism @emnapi/runtime uses to keep Node alive while a
    // native async request is outstanding — `new MessageChannel().port1`, ref()
    // on the way in, unref() on the way out, nothing ever listening. rolldown's
    // wasm binding is built on it, so a ref() that quietly required a listener
    // was a process exiting in the middle of napi work it had been asked to wait
    // for.
    //
    // These WRAP the platform's ref/unref/close rather than replacing them, and
    // only add the guest hold for a port the guest owns (GUEST below). Headless,
    // the platform MessagePort is the host's own Node MessagePort and the runtime
    // shares its realm, so this prototype is also the one the process worker's fs
    // and thread plumbing runs on — and Node's internal listener bookkeeping
    // calls port.ref() itself. Replacing ref() outright pointed those internal
    // calls at OUR counter, which held a guest loop open on a port the guest had
    // never heard of: every worker spawn hung, one layer below anything a guest
    // could see.
    const rawRef = proto.ref;
    const rawUnref = proto.unref;
    const rawClose = proto.close;
    proto.ref = function ref() {
      if (!duringInternalSetup) portRef(this);
      if (rawRef) rawRef.call(this);
      return this;
    };
    proto.unref = function unref() {
      portRelease(this);
      if (rawUnref) rawUnref.call(this);
      return this;
    };
    // A closed port can deliver nothing, so it must stop holding the loop —
    // otherwise close() on the last channel would hang the process instead of
    // ending it.
    proto.close = function close(...args) {
      this[MSG_REFS] = 0;
      portRelease(this);
      return rawClose ? rawClose.apply(this, args) : undefined;
    };
    if (!proto.setMaxListeners) proto.setMaxListeners = function setMaxListeners() { return this; };
    if (!proto.getMaxListeners) proto.getMaxListeners = function getMaxListeners() { return 0; };
  }
}