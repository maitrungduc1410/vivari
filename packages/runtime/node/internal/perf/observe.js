// internal/perf/observe — stub (Phase 2 #7).
//
// net.js records connect/HTTP performance marks through this module. Performance
// observation isn't implemented, so measurement is inert (nothing observes).
export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";
  module.exports = {
    hasObserver: () => false,
    startPerf: () => {},
    stopPerf: () => {},
    enqueue: () => {},
    bufferUserTiming: () => {},
    bufferResourceTiming: () => {},
  };
}
