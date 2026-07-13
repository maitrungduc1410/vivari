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

  // Best-effort store for realms without async tracking (the browser). There is
  // no PromiseHook, so we can't follow context across *unrelated* async hops the
  // way Node does. Instead we hold `run(store, cb)`'s store as the current value
  // for the ENTIRE duration of cb — synchronously AND, when cb returns a thenable,
  // until that promise settles. This makes `getStore()` after an `await` inside
  // the same run() chain return the store (enough for Next.js App Router's
  // workStore in the common single-render case). Caveat: with a single `_current`
  // per instance, truly concurrent run() calls that overlap across an await can
  // observe each other's store — acceptable for a low-concurrency dev preview,
  // and the Node path uses the host's real AsyncLocalStorage anyway.
  class AsyncLocalStoragePolyfill {
    constructor() {
      this._current = undefined;
      this._enabled = true;
    }
    run(store, callback, ...args) {
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
          this._current = prev;
        };
        return result.then(
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
    // Static context helpers (Node 19.8+). Without real async tracking a snapshot
    // can't restore *all* stores, so it captures nothing and just runs the fn;
    // bind() returns it unchanged. Next.js's App Router calls both. (On the Node
    // path the host's real AsyncLocalStorage provides these.)
    static bind(fn) {
      return fn;
    }
    static snapshot() {
      return (cb, ...args) => cb(...args);
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
  };
}
