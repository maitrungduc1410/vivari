// A compact EventEmitter, API-compatible with the common subset of Node's.

export class EventEmitter {
  constructor() {
    this._events = Object.create(null);
    this._maxListeners = 10;
  }
  on(type, fn) {
    (this._events[type] ||= []).push(fn);
    return this;
  }
  addListener(type, fn) {
    return this.on(type, fn);
  }
  prependListener(type, fn) {
    (this._events[type] ||= []).unshift(fn);
    return this;
  }
  once(type, fn) {
    const wrap = (...args) => {
      this.off(type, wrap);
      fn.apply(this, args);
    };
    wrap.listener = fn;
    return this.on(type, wrap);
  }
  off(type, fn) {
    const list = this._events[type];
    if (list) {
      const i = list.findIndex((x) => x === fn || x.listener === fn);
      if (i >= 0) list.splice(i, 1);
    }
    return this;
  }
  removeListener(type, fn) {
    return this.off(type, fn);
  }
  removeAllListeners(type) {
    if (type) delete this._events[type];
    else this._events = Object.create(null);
    return this;
  }
  emit(type, ...args) {
    const list = this._events[type];
    if (!list || !list.length) {
      if (type === "error") throw args[0] instanceof Error ? args[0] : new Error("Unhandled 'error' event");
      return false;
    }
    for (const fn of [...list]) fn.apply(this, args);
    return true;
  }
  listeners(type) {
    return (this._events[type] || []).slice();
  }
  listenerCount(type) {
    return (this._events[type] || []).length;
  }
  eventNames() {
    return Object.keys(this._events);
  }
  setMaxListeners(n) {
    this._maxListeners = n;
    return this;
  }
  getMaxListeners() {
    return this._maxListeners;
  }
}

// Node: `require('events')` returns the EventEmitter constructor itself, with a
// `.EventEmitter` self-reference and a couple of statics.
EventEmitter.EventEmitter = EventEmitter;
EventEmitter.once = (emitter, name) =>
  new Promise((resolve, reject) => {
    const ok = (...args) => {
      emitter.off("error", err);
      resolve(args);
    };
    const err = (e) => {
      emitter.off(name, ok);
      reject(e);
    };
    emitter.once(name, ok);
    emitter.once("error", err);
  });
