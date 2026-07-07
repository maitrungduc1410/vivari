// internal/process/task_queues — minimal bridge.
//
// internal/events/abort_listener lazily pulls queueMicrotask from here. We map
// it to the host microtask queue; nextTick defers onto our runtime process.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const queueMicrotask =
    typeof globalThis.queueMicrotask === "function"
      ? (cb) => globalThis.queueMicrotask(cb)
      : (cb) => Promise.resolve().then(cb);

  module.exports = {
    queueMicrotask,
    nextTick: (cb, ...args) => process.nextTick(cb, ...args),
  };
}
