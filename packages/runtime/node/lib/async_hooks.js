// async_hooks — minimal shim (Phase 2 #6).
//
// NOT verbatim: Node's async_hooks is built on native async-context tracking
// (the async id stack maintained by the C++ layer). OpenContainer has no such
// tracking, so we provide the surface the vendored lib/ actually uses:
// AsyncResource (only runInAsyncScope/bind matter — for internal/streams/
// end-of-stream), inert createHook, and a synchronous-scope AsyncLocalStorage.
// Async-context propagation across awaits is best-effort (not tracked).
export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  let nextId = 1;

  class AsyncResource {
    constructor(type, opts) {
      this.type = type;
      this[Symbol.for("kAsyncId")] = nextId++;
    }
    runInAsyncScope(fn, thisArg, ...args) {
      return fn.apply(thisArg, args);
    }
    bind(fn, thisArg) {
      const self = this;
      const bound = function (...args) {
        return self.runInAsyncScope(fn, thisArg ?? this, ...args);
      };
      return bound;
    }
    emitBefore() {}
    emitAfter() {}
    emitDestroy() {
      return this;
    }
    asyncId() {
      return this[Symbol.for("kAsyncId")];
    }
    triggerAsyncId() {
      return 0;
    }
    static bind(fn, type, thisArg) {
      return new AsyncResource(type || fn.name || "bound-anonymous").bind(fn, thisArg);
    }
  }

  // A synchronous-scope store. Correct for `run()` bodies that finish before
  // yielding; context is not propagated across awaits (we have no async tracking).
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
    executionAsyncId: () => 0,
    triggerAsyncId: () => 0,
    executionAsyncResource: () => ({}),
    createHook: () => ({ enable() { return this; }, disable() { return this; } }),
  };
}
