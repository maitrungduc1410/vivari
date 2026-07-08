// node:worker_threads — a minimal shim (Phase 2 #16 stage 2a).
//
// We are NOT (yet) a multi-threaded runtime: a process is a single Web Worker,
// and we don't spawn nested workers from inside one. This shim exists so code
// that *imports* worker_threads at module scope keeps loading — most notably the
// wrappers napi-rs generates for wasm32-wasi addons, which do
// `const { Worker } = require('node:worker_threads')` at the top and only ever
// construct a Worker inside emnapi's onCreateWorker() (the async-work / pthread
// pool). Sync addons never trigger that, so a Worker that throws-on-construct is
// enough. Real nested workers + thread pool are Phase 2 stage 2b.
//
// MessageChannel/MessagePort are the platform globals (they exist in a Worker),
// so structured-clone messaging still works for anyone who wants it.

export default function (exports, require, module, process) {
  const g = globalThis;

  class Worker {
    constructor() {
      throw new Error(
        "worker_threads.Worker is not supported yet (OpenContainer stage 2a): " +
          "processes are single-threaded and cannot spawn nested workers. " +
          "This is planned for stage 2b (napi async-work / pthreads).",
      );
    }
  }

  const environmentData = new Map();

  exports.isMainThread = true;
  exports.threadId = 0;
  exports.parentPort = null;
  exports.workerData = null;
  exports.resourceLimits = {};
  exports.SHARE_ENV = Symbol.for("nodejs.worker_threads.SHARE_ENV");
  exports.Worker = Worker;

  // Prefer the platform primitives; fall back to undefined if a host lacks them.
  exports.MessageChannel = g.MessageChannel;
  exports.MessagePort = g.MessagePort;
  exports.BroadcastChannel = g.BroadcastChannel;

  exports.setEnvironmentData = (key, value) => {
    if (value === undefined) environmentData.delete(key);
    else environmentData.set(key, value);
  };
  exports.getEnvironmentData = (key) => environmentData.get(key);

  // Not meaningful without real ports/threads — kept as harmless no-ops so
  // feature-detecting callers don't crash.
  exports.receiveMessageOnPort = () => undefined;
  exports.markAsUntransferable = (obj) => obj;
  exports.isMarkedAsUntransferable = () => false;
  exports.moveMessagePortToContext = () => {
    throw new Error("worker_threads.moveMessagePortToContext is not supported");
  };
}
