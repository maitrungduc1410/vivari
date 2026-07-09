// perf_hooks over the platform's global `performance` (present in Workers). We
// expose the public surface libraries reach for — performance.now/timeOrigin,
// mark/measure (no-op when unsupported), PerformanceObserver, and the histogram/
// event-loop-delay monitors as inert stubs (there is no libuv loop to sample).

export default function (exports, require, module) {
  const perf =
    globalThis.performance && typeof globalThis.performance.now === "function"
      ? globalThis.performance
      : { now: () => Date.now(), timeOrigin: Date.now() };

  class PerformanceObserver {
    constructor(callback) {
      this._callback = callback;
    }
    observe() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  PerformanceObserver.supportedEntryTypes = [];

  class PerformanceObserverEntryList {
    getEntries() {
      return [];
    }
    getEntriesByName() {
      return [];
    }
    getEntriesByType() {
      return [];
    }
  }

  class PerformanceEntry {}

  const histogram = () => ({
    enable() {},
    disable() {},
    reset() {},
    percentile() {
      return 0;
    },
    percentiles: new Map(),
    get min() {
      return 0;
    },
    get max() {
      return 0;
    },
    get mean() {
      return 0;
    },
    get stddev() {
      return 0;
    },
    get exceeds() {
      return 0;
    },
    get count() {
      return 0;
    },
    record() {},
    recordDelta() {},
  });

  exports.performance = perf;
  exports.PerformanceObserver = PerformanceObserver;
  exports.PerformanceObserverEntryList = PerformanceObserverEntryList;
  exports.PerformanceEntry = PerformanceEntry;
  exports.PerformanceMeasure = class PerformanceMeasure extends PerformanceEntry {};
  exports.PerformanceMark = class PerformanceMark extends PerformanceEntry {};
  exports.monitorEventLoopDelay = histogram;
  exports.createHistogram = histogram;
  exports.constants = {};
  exports.performanceNodeTiming = perf.nodeTiming || {};
}
