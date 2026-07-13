// internal/async_hooks — minimal shim (Phase 2 #6/#7).
//
// NOT verbatim: Node's async_hooks is built on native async-context tracking.
// OpenContainer has none, so we provide the surface the vendored lib/ uses:
//   - AsyncResource (runInAsyncScope/bind) for internal/streams/end-of-stream
//   - symbols {owner_symbol, async_id_symbol, trigger_async_id_symbol} + the
//     newAsyncId / getNewAsyncId / defaultTriggerAsyncIdScope helpers for net.js
//   - inert createHook + a synchronous-scope AsyncLocalStorage
// Async-context propagation across awaits is best-effort (not tracked).
export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const owner_symbol = Symbol("owner_symbol");
  const async_id_symbol = Symbol("async_id_symbol");
  const trigger_async_id_symbol = Symbol("trigger_async_id_symbol");

  let asyncIdCounter = 1;
  const newAsyncId = () => ++asyncIdCounter;
  const getNewAsyncId = (handle) =>
    handle && typeof handle.getAsyncId === "function" ? handle.getAsyncId() : newAsyncId();

  // Node runs `fn(...args)` inside the async scope of `triggerAsyncId`. With no
  // async tracking we just invoke it directly (same call semantics).
  const defaultTriggerAsyncIdScope = (triggerAsyncId, fn, ...args) => fn(...args);

  // Lazily assigns (and caches) an async id on a handle/object. _http_server and
  // net use this to tag sockets.
  const getOrSetAsyncId = (object) => {
    if (object[async_id_symbol] !== undefined) return object[async_id_symbol];
    return (object[async_id_symbol] = newAsyncId());
  };

  class AsyncResource {
    constructor(type) {
      this.type = type;
      this[async_id_symbol] = newAsyncId();
      this[trigger_async_id_symbol] = 0;
    }
    runInAsyncScope(fn, thisArg, ...args) {
      return fn.apply(thisArg, args);
    }
    bind(fn, thisArg) {
      const self = this;
      return function (...args) {
        return self.runInAsyncScope(fn, thisArg ?? this, ...args);
      };
    }
    emitBefore() {}
    emitAfter() {}
    emitDestroy() {
      return this;
    }
    asyncId() {
      return this[async_id_symbol];
    }
    triggerAsyncId() {
      return this[trigger_async_id_symbol];
    }
    static bind(fn, type, thisArg) {
      return new AsyncResource(type || fn.name || "bound-anonymous").bind(fn, thisArg);
    }
  }

  // Prefer the host realm's real AsyncLocalStorage when this runtime runs on a
  // Node worker (headless / Node twin): it is backed by V8's PromiseHook, so
  // context propagates across `await` — which Next.js App Router (RSC) requires
  // (`workAsyncStorage`/`workUnitAsyncStorage`). In the browser there is no such
  // binding and we fall back to the synchronous-scope polyfill below.
  let hostAsyncHooks = null;
  try {
    hostAsyncHooks = internalBinding("async_hooks_host");
  } catch {
    hostAsyncHooks = null;
  }
  const HostAsyncLocalStorage =
    hostAsyncHooks && typeof hostAsyncHooks.AsyncLocalStorage === "function"
      ? hostAsyncHooks.AsyncLocalStorage
      : null;

  // ── Best-effort AsyncLocalStorage for realms without async tracking (browser) ──
  //
  // There is no PromiseHook, so we approximate cross-`await` context two ways that
  // together cover Next.js's App Router:
  //   1) `run(store, cb)` holds the store for the ENTIRE duration of cb — the sync
  //      body and, if cb returns a thenable, until it settles (covers raw `await`
  //      inside cb, e.g. workAsyncStorage wrapping the whole render).
  //   2) Context propagation across the async scheduling primitives React uses
  //      (`Promise.prototype.then`, `queueMicrotask`, timers): each captures a
  //      SNAPSHOT of every live store at schedule time and restores it while the
  //      callback runs. This covers the pattern that (1) misses — a synchronous
  //      `run(store, () => scheduleWork())` whose work runs detached later (that is
  //      exactly how Next enters workUnitAsyncStorage per render).
  //
  // Caveat: still not a real async-context boundary (a single `_current` per
  // instance), so heavy concurrent overlap can bleed — acceptable for a dev
  // preview. The Node path uses the host's real AsyncLocalStorage instead.

  // Every live polyfill instance, so a snapshot can capture/restore all stores.
  const liveStores = new Set();
  // The original Promise.prototype.then, captured before we patch it, so run()'s
  // own restore hook is never itself re-wrapped (which would clobber the restore).
  const nativeThen = Promise.prototype.then;

  function captureContext() {
    const snap = [];
    for (const inst of liveStores) snap.push([inst, inst._current]);
    return snap;
  }
  function wrapWithContext(fn) {
    if (typeof fn !== "function" || liveStores.size === 0) return fn;
    const snap = captureContext();
    return function (...args) {
      const saved = [];
      for (const [inst, val] of snap) {
        saved.push([inst, inst._current]);
        inst._current = val;
      }
      try {
        return fn.apply(this, args);
      } finally {
        for (const [inst, val] of saved) inst._current = val;
      }
    };
  }

  // Patch the worker's scheduling primitives ONCE (browser path only) so detached
  // continuations carry the context that was active when they were scheduled.
  let propagationInstalled = false;
  function installContextPropagation() {
    if (propagationInstalled) return;
    propagationInstalled = true;
    const g = globalThis;
    if (g.Promise && g.Promise.prototype && g.Promise.prototype.then === nativeThen) {
      g.Promise.prototype.then = function (onFulfilled, onRejected) {
        return nativeThen.call(this, wrapWithContext(onFulfilled), wrapWithContext(onRejected));
      };
    }
    const patchScheduler = (name) => {
      const orig = g[name];
      if (typeof orig !== "function") return;
      g[name] = function (cb, ...rest) {
        return orig.call(this, typeof cb === "function" ? wrapWithContext(cb) : cb, ...rest);
      };
    };
    patchScheduler("queueMicrotask");
    patchScheduler("setTimeout");
    patchScheduler("setInterval");
    patchScheduler("setImmediate");
  }

  class AsyncLocalStoragePolyfill {
    constructor() {
      this._current = undefined;
      this._enabled = true;
      liveStores.add(this);
    }
    run(store, callback, ...args) {
      // Two mechanisms cooperate (see installContextPropagation):
      //   • For the sync body and any raw `await` inside cb, we hold `store` as the
      //     current value until cb's returned promise settles. This is what keeps a
      //     long-lived scope (workAsyncStorage wrapping a whole render) readable
      //     across awaits that the scheduler patches can't see.
      //   • For work scheduled onto then/microtask/timers, the scheduler patches
      //     carry a per-hop snapshot, so nested/short-lived scopes stay correct even
      //     when this instance's sticky value has moved on.
      const prev = this._current;
      this._current = store;
      let result;
      try {
        result = callback(...args);
      } catch (e) {
        this._current = prev;
        throw e;
      }
      if (result && typeof result.then === "function") {
        const restore = () => {
          // Only pop if we're still the top: a nested run() that is still live may
          // have set a newer value we must not clobber (out-of-order settling).
          if (this._current === store) this._current = prev;
        };
        // Use the *native* then so this restore isn't itself context-wrapped.
        return nativeThen.call(
          result,
          (v) => {
            restore();
            return v;
          },
          (e) => {
            restore();
            throw e;
          },
        );
      }
      this._current = prev;
      return result;
    }
    exit(callback, ...args) {
      const prev = this._current;
      this._current = undefined;
      try {
        return callback(...args);
      } finally {
        this._current = prev;
      }
    }
    getStore() {
      return this._enabled ? this._current : undefined;
    }
    enterWith(store) {
      this._current = store;
    }
    disable() {
      this._enabled = false;
      this._current = undefined;
    }
    // Static context helpers (Node 19.8+). snapshot() captures every live store
    // now and restores it when the returned runner is invoked; bind() binds a fn
    // to the current context. Next.js's App Router uses both. (The Node path uses
    // the host's real AsyncLocalStorage.)
    static bind(fn) {
      return wrapWithContext(fn);
    }
    static snapshot() {
      const snap = captureContext();
      return (cb, ...args) => {
        const saved = [];
        for (const [inst, val] of snap) {
          saved.push([inst, inst._current]);
          inst._current = val;
        }
        try {
          return cb(...args);
        } finally {
          for (const [inst, val] of saved) inst._current = val;
        }
      };
    }
  }

  const AsyncLocalStorage = HostAsyncLocalStorage || AsyncLocalStoragePolyfill;

  module.exports = {
    AsyncResource,
    AsyncLocalStorage,
    newAsyncId,
    getNewAsyncId,
    getOrSetAsyncId,
    defaultTriggerAsyncIdScope,
    executionAsyncId: () => 0,
    triggerAsyncId: () => 0,
    executionAsyncResource: () => ({}),
    createHook: () => ({ enable() { return this; }, disable() { return this; } }),
    symbols: { owner_symbol, async_id_symbol, trigger_async_id_symbol },
    // Runtime-internal: on the polyfill (browser) path the runtime calls this AFTER
    // it has installed its own timer globals (loop.setTimeout/setImmediate/…) so the
    // context wrappers land on the *final* primitives, not the ones we later clobber.
    // No-op when the host's real AsyncLocalStorage is in use.
    __ocInstallContextPropagation: HostAsyncLocalStorage ? () => {} : installContextPropagation,
  };
}
