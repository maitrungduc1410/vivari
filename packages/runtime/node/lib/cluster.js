// cluster — minimal stub (Phase 2 #7).
//
// OpenContainer runs a single VM per process; there is no cluster primary/worker
// split. net.js's listenInCluster only consults cluster.isWorker (false here) so
// it always takes the primary path and binds the handle directly.
export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const EventEmitter = require("events");
  const cluster = new EventEmitter();
  cluster.isWorker = false;
  cluster.isMaster = true; // legacy alias
  cluster.isPrimary = true;
  cluster.worker = undefined;
  cluster.workers = {};
  cluster.settings = {};
  cluster.SCHED_NONE = 1;
  cluster.SCHED_RR = 2;
  cluster.schedulingPolicy = cluster.SCHED_RR;
  cluster.setupPrimary = () => {};
  cluster.setupMaster = () => {};
  cluster.fork = () => {
    throw new Error("OpenContainer: cluster.fork() is not supported");
  };
  cluster.disconnect = (cb) => {
    if (typeof cb === "function") process.nextTick(cb);
  };

  module.exports = cluster;
}
