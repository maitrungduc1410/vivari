// Node's MessagePort semantics, on the platform's MessagePort.
//
// A Node MessagePort is a handle: a port with a 'message' listener holds the
// process open, and so does a port that was ref()'d. Which API the listener
// came through does not matter — `on('message')`, `addEventListener('message')`
// and `onmessage` are all one listener list, and the FIRST listener start()s the
// port and refs it, the LAST one going unrefs it (lib/internal/worker/io.js,
// setupPortReferencing). A port whose other end closes stops holding too: Node
// delivers what was already posted, then closes this end as well.
//
// The browser's MessagePort is an EventTarget with none of that. It has no ref,
// it holds nothing, and only `onmessage` starts it — `addEventListener` alone
// leaves the port's queue disabled, so the listener never hears anything. Every
// rule above is therefore ours to model, on the same liveness counter every other
// handle uses (host.retain/release).
//
// WHICH PORTS. Only the guest's. The runtime runs its own plumbing over the same
// prototype — the event loop's macrotask channel, the fs doorbell, the fork IPC
// port, the Worker's half of the parent<->child channel — and in a headless run
// Node's own listener bookkeeping calls ref() on those ports from inside
// addEventListener. A hold on any of them keeps the guest alive for ever: that was
// "every worker spawn hung", one layer below anything a guest could see. So a port
// counts only once it is marked GUEST, and it is marked by how the guest came to
// have it:
//   - created by the guest's MessageChannel (installed on the global and exported
//     by worker_threads; the runtime keeps the native constructor for itself),
//   - delivered to the guest: a MessagePort inside workerData, a port in a
//     received message's `ports`, a worker's parentPort,
//   - or used through a Node-only method (on/once/addListener), which nothing but
//     a guest calls on a port.
// Anything else — a port the guest never had — passes straight through to the
// platform, unchanged. An unmarked guest port fails as an early exit, which is the
// old behaviour; a marked runtime port would fail as a hang.
//
// CLOSING. The browser does not tell a port that its other end closed, so a
// listening port would hold for ever after the peer is gone — where Node exits.
// close() on a guest port posts CLOSE_SIGNAL before closing; it arrives after
// everything posted before it, and the receiving end closes too. The signal is
// stopped before any guest listener or receiveMessageOnPort inbox sees it.

const STATE = Symbol.for("vivari.messagePort");
const GUEST = Symbol("vvPortGuest");
const HELD = Symbol("vvPortHeld");
const CLOSED = Symbol("vvPortClosed");
const COUNT = Symbol("vvPortMessageListeners");
const REGISTRY = Symbol("vvPortRegistry");
const HANDLER = Symbol("vvPortOnmessage");
const HANDLER_ENTRY = Symbol("vvPortOnmessageEntry");
const CONTROL = Symbol("vvPortControl");
const DELIVER = Symbol("vvPortDeliver");

const CLOSE_TAG = "vivari:port-closed";
const CLOSE_SIGNAL = Object.freeze({ __vvPortClose: CLOSE_TAG });
const DATA_EVENTS = new Set(["message", "messageerror"]);

export const isCloseSignal = (data) =>
  !!data && typeof data === "object" && data.__vvPortClose === CLOSE_TAG;

function findAccessor(proto, name) {
  for (let p = proto; p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, name);
    if (d) return d.get || d.set ? d : null;
  }
  return null;
}

/**
 * Install the semantics on `g.MessagePort.prototype` and replace
 * `g.MessageChannel` with the guest's constructor. Idempotent per prototype; a
 * later call only updates the liveness host. Returns the runtime-side handle, or
 * null when the realm has no MessagePort.
 */
export function installMessagePort(g, host) {
  const MP = g && g.MessagePort;
  const NativeMessageChannel = g && g.MessageChannel;
  const proto = MP && MP.prototype;
  if (!proto || typeof NativeMessageChannel !== "function") return null;
  if (proto[STATE]) {
    if (host) proto[STATE].host = host;
    return proto[STATE];
  }

  const raw = {
    add: proto.addEventListener,
    remove: proto.removeEventListener,
    start: proto.start,
    close: proto.close,
    post: proto.postMessage,
    ref: proto.ref,
    unref: proto.unref,
    onmessage: findAccessor(proto, "onmessage"),
  };

  const state = {
    host: host || null,
    internal: 0,
    NativeMessageChannel,
    MessageChannel: null,
    isCloseSignal,
    // The runtime acting on a port, not the guest: nothing done inside fn holds
    // the loop, and the platform methods pass through.
    internalPortSetup(fn) {
      state.internal++;
      try {
        return fn();
      } finally {
        state.internal--;
      }
    },
    markGuest(port) {
      if (port instanceof MP) port[GUEST] = true;
      return port;
    },
    markEventPorts(e) {
      const ports = e && e.ports;
      if (ports && ports.length) for (const p of ports) state.markGuest(p);
    },
    // workerData: same walk as worker_threads' collectTransferables.
    markGuestIn(value) {
      const visited = new WeakSet();
      const scan = (v, depth) => {
        if (!v || typeof v !== "object" || depth > 6) return;
        if (v instanceof MP) return void (v[GUEST] = true);
        if (visited.has(v)) return;
        visited.add(v);
        const children = Array.isArray(v) ? v : Object.keys(v).map((k) => {
          try {
            return v[k];
          } catch {
            return undefined;
          }
        });
        for (const c of children) scan(c, depth + 1);
      };
      scan(value, 0);
    },
    // Route this port's guest listeners through `deliver(run)` instead of calling
    // them from the platform's event. Liveness is released inside `run`, so a
    // queue that is drained later never sees the hold drop before its message.
    setDelivery(port, deliver) {
      port[DELIVER] = deliver;
    },
  };
  Object.defineProperty(proto, STATE, { value: state });

  const isGuestCall = (port) => port[GUEST] === true && state.internal === 0;

  const hold = (port) => {
    if (port[HELD] || port[CLOSED] || !port[GUEST] || state.internal || !state.host) return;
    port[HELD] = true;
    state.host.retain("MessagePort");
  };
  const drop = (port) => {
    if (!port[HELD]) return;
    port[HELD] = false;
    if (state.host) state.host.release("MessagePort");
  };

  const listenerAdded = (port) => {
    port[COUNT] = (port[COUNT] || 0) + 1;
    if (port[COUNT] !== 1) return;
    try {
      raw.start.call(port);
    } catch {
      /* closed or detached */
    }
    hold(port);
  };
  const listenerRemoved = (port) => {
    if (port[COUNT] > 0 && --port[COUNT] === 0) drop(port);
  };

  const closedByPeer = (port) => {
    if (port[CLOSED]) return;
    port[CLOSED] = true;
    port[COUNT] = 0;
    drop(port);
    try {
      raw.close.call(port);
    } catch {
      /* already closed */
    }
  };

  // First in the port's listener list, so it sees every message before a guest
  // listener does. 'close' is the platform's own notice where there is one (Node,
  // headless); CLOSE_SIGNAL is ours, for the platforms that have none.
  const ensureControl = (port) => {
    if (port[CONTROL]) return;
    const control = (e) => {
      if (e.type === "message" && !isCloseSignal(e.data)) return void state.markEventPorts(e);
      if (e.type === "message") e.stopImmediatePropagation();
      const finish = () => closedByPeer(port);
      if (port[DELIVER]) port[DELIVER](finish);
      else finish();
    };
    port[CONTROL] = control;
    state.internalPortSetup(() => {
      raw.add.call(port, "message", control);
      raw.add.call(port, "close", control);
    });
  };

  const entriesOf = (port, type) => {
    let reg = port[REGISTRY];
    if (!reg) port[REGISTRY] = reg = new Map();
    let list = reg.get(type);
    if (!list) reg.set(type, (list = []));
    return list;
  };

  const invoke = (port, entry, e) => {
    if (entry.kind === "on") return entry.listener.call(port, DATA_EVENTS.has(entry.type) ? e.data : e);
    if (entry.kind === "handler") {
      const h = port[HANDLER];
      return typeof h === "function" ? h.call(port, e) : undefined;
    }
    const l = entry.listener;
    return typeof l === "function" ? l.call(port, e) : l.handleEvent(e);
  };

  const makeWrapper = (port, entry) => (e) => {
    if (!entry.active) return;
    if (entry.once) {
      if (entry.fired) return;
      entry.fired = true;
    }
    const run = () => {
      if (!entry.active) return;
      if (entry.once) unregister(port, entry);
      invoke(port, entry, e);
    };
    if (port[DELIVER]) port[DELIVER](run);
    else run();
  };

  const register = (port, entry) => {
    entriesOf(port, entry.type).push(entry);
    entry.active = true;
    if (entry.type === "message") ensureControl(port);
    raw.add.call(port, entry.type, entry.wrapper);
    if (entry.type === "message") listenerAdded(port);
    if (entry.signal) {
      entry.onAbort = () => unregister(port, entry);
      entry.signal.addEventListener("abort", entry.onAbort, { once: true });
    }
  };

  const unregister = (port, entry) => {
    if (!entry.active) return;
    entry.active = false;
    const list = port[REGISTRY] && port[REGISTRY].get(entry.type);
    const i = list ? list.indexOf(entry) : -1;
    if (i >= 0) list.splice(i, 1);
    raw.remove.call(port, entry.type, entry.wrapper);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
    if (entry.type === "message") listenerRemoved(port);
  };

  const newEntry = (port, kind, type, listener, extra) => {
    const entry = { kind, type, listener, capture: false, once: false, signal: undefined, active: false, fired: false, wrapper: null, onAbort: null, ...extra };
    entry.wrapper = makeWrapper(port, entry);
    return entry;
  };

  const captureOf = (options) => (typeof options === "boolean" ? options : !!(options && options.capture));

  // ---- the platform surface, counted for guest ports ------------------------

  proto.addEventListener = function addEventListener(type, listener, options) {
    if (!isGuestCall(this) || !DATA_EVENTS.has(type) || !listener || (typeof listener !== "function" && typeof listener !== "object")) {
      return raw.add.call(this, type, listener, options);
    }
    const capture = captureOf(options);
    if (entriesOf(this, type).some((x) => x.kind === "event" && x.listener === listener && x.capture === capture)) return;
    const opts = options && typeof options === "object" ? options : {};
    if (opts.signal && opts.signal.aborted) return;
    register(this, newEntry(this, "event", type, listener, { capture, once: !!opts.once, signal: opts.signal || undefined }));
  };

  proto.removeEventListener = function removeEventListener(type, listener, options) {
    const capture = captureOf(options);
    const list = this[REGISTRY] && this[REGISTRY].get(type);
    const entry = list && list.find((x) => x.kind === "event" && x.listener === listener && x.capture === capture);
    if (entry) return void unregister(this, entry);
    return raw.remove.call(this, type, listener, options);
  };

  // One stable entry while a handler is set, so replacing the handler keeps its
  // place and its single count; null removes it. Setting a handler starts the
  // port, as the platform's own setter does.
  Object.defineProperty(proto, "onmessage", {
    configurable: true,
    enumerable: true,
    get() {
      if (this[HANDLER_ENTRY]) return this[HANDLER];
      return raw.onmessage && raw.onmessage.get ? raw.onmessage.get.call(this) : null;
    },
    set(fn) {
      if (!this[HANDLER_ENTRY] && !isGuestCall(this)) {
        if (raw.onmessage && raw.onmessage.set) raw.onmessage.set.call(this, fn);
        return;
      }
      const next = typeof fn === "function" ? fn : null;
      if (next) {
        this[HANDLER] = next;
        if (!this[HANDLER_ENTRY]) {
          const entry = newEntry(this, "handler", "message", null);
          this[HANDLER_ENTRY] = entry;
          register(this, entry);
        }
        try {
          raw.start.call(this);
        } catch {
          /* closed or detached */
        }
      } else if (this[HANDLER_ENTRY]) {
        const entry = this[HANDLER_ENTRY];
        this[HANDLER_ENTRY] = null;
        this[HANDLER] = null;
        unregister(this, entry);
      }
    },
  });

  // ---- Node's EventEmitter-style surface ------------------------------------
  // Worker pools (Piscina, which backs Angular's compiler and vitest) call
  // port.on(...) straight on ports from `new MessageChannel()`, and expect the
  // posted value, not the event.

  proto.addListener = proto.on = function on(type, listener) {
    if (state.internal === 0) this[GUEST] = true;
    if (!entriesOf(this, type).some((x) => x.kind === "on" && x.listener === listener)) {
      register(this, newEntry(this, "on", type, listener));
    }
    return this;
  };
  proto.once = function once(type, listener) {
    if (state.internal === 0) this[GUEST] = true;
    if (!entriesOf(this, type).some((x) => x.kind === "on" && x.listener === listener)) {
      register(this, newEntry(this, "on", type, listener, { once: true }));
    }
    return this;
  };
  proto.removeListener = proto.off = function off(type, listener) {
    const list = this[REGISTRY] && this[REGISTRY].get(type);
    const entry = list && list.find((x) => x.kind === "on" && x.listener === listener);
    if (entry) unregister(this, entry);
    return this;
  };
  // Node keeps the handle after removeAllListeners('message') and hangs (measured
  // on Node 22); removing the last listener one at a time releases it. Both leave
  // the port in the same state, so this releases too — turning a hang into an
  // exit is the safe direction. spike-port-liveness pins the divergence.
  proto.removeAllListeners = function removeAllListeners(type) {
    const reg = this[REGISTRY];
    const types = type === undefined ? (reg ? [...reg.keys()] : []) : [type];
    for (const t of types) {
      const list = reg && reg.get(t);
      if (list) for (const entry of [...list]) unregister(this, entry);
      if (t === "message") {
        this[HANDLER_ENTRY] = null;
        this[HANDLER] = null;
        this[COUNT] = 0;
        drop(this);
      }
    }
    return this;
  };
  proto.emit = function emit(type, arg) {
    try {
      this.dispatchEvent(DATA_EVENTS.has(type) ? new MessageEvent(type, { data: arg }) : new Event(type));
    } catch {
      /* best effort */
    }
    return true;
  };
  proto.listeners = function listeners(type) {
    const list = this[REGISTRY] && this[REGISTRY].get(type);
    return list ? list.filter((x) => x.kind !== "handler").map((x) => x.listener) : [];
  };
  proto.listenerCount = function listenerCount(type) {
    const list = this[REGISTRY] && this[REGISTRY].get(type);
    return list ? list.length : 0;
  };
  proto.eventNames = function eventNames() {
    const reg = this[REGISTRY];
    return reg ? [...reg.keys()].filter((t) => reg.get(t).length > 0) : [];
  };
  if (!proto.setMaxListeners) proto.setMaxListeners = function setMaxListeners() { return this; };
  if (!proto.getMaxListeners) proto.getMaxListeners = function getMaxListeners() { return 0; };

  // ---- ref / unref / close --------------------------------------------------
  // ref() holds with no listener at all: @emnapi/runtime keeps Node alive across
  // a native async request with `new MessageChannel().port1` ref()'d on the way in
  // and unref()'d on the way out, nothing ever listening (rolldown's wasm binding,
  // under Vite 8, under vitest). These wrap the platform's methods rather than
  // replace them: headless, the platform port is Node's and its internals call
  // them too.
  proto.ref = function ref() {
    if (isGuestCall(this)) hold(this);
    if (raw.ref) raw.ref.call(this);
    return this;
  };
  proto.unref = function unref() {
    drop(this);
    if (raw.unref) raw.unref.call(this);
    return this;
  };
  if (!proto.hasRef) proto.hasRef = function hasRef() { return !!this[HELD]; };
  proto.close = function close(...args) {
    if (this[GUEST] && !this[CLOSED]) {
      try {
        raw.post.call(this, CLOSE_SIGNAL);
      } catch {
        /* detached */
      }
    }
    this[CLOSED] = true;
    this[COUNT] = 0;
    drop(this);
    return raw.close ? raw.close.apply(this, args) : undefined;
  };

  // ---- the guest's constructor ----------------------------------------------
  // Both ends of a channel the guest builds are the guest's. The runtime keeps
  // NativeMessageChannel for its own plumbing.
  class MessageChannel extends NativeMessageChannel {
    constructor() {
      super();
      this.port1[GUEST] = true;
      this.port2[GUEST] = true;
    }
  }
  state.MessageChannel = MessageChannel;
  Object.defineProperty(g, "MessageChannel", { value: MessageChannel, writable: true, configurable: true, enumerable: false });

  return state;
}
