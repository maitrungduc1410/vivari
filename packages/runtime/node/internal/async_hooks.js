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

  // Synchronous-scope store: correct for run() bodies that finish before
  // yielding; context is not propagated across awaits (no async tracking).
  class AsyncLocalStorage {
    constructor() {
      this._stack = [];
    }
    run(store, callback, ...args) {
      this._stack.push(store);
      try {
        return callback(...args);
      } finally {
        this._stack.pop();
      }
    }
    exit(callback, ...args) {
      const saved = this._stack;
      this._stack = [];
      try {
        return callback(...args);
      } finally {
        this._stack = saved;
      }
    }
    getStore() {
      return this._stack.length ? this._stack[this._stack.length - 1] : undefined;
    }
    enterWith(store) {
      this._stack.push(store);
    }
    disable() {
      this._stack = [];
    }
  }

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
