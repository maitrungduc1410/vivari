// internal/timers — minimal shim (Phase 2 #7).
//
// NOT verbatim: Node's internal/timers.js (~700 lines) is a native-timer-driven
// linked-list of timeout lists. Vivari already has a real event loop
// (packages/runtime/loop.js) exposed via globalThis timers, so we map the small
// surface the vendored modules use (internal/stream_base_commons, net.js) onto
// it. Socket timeouts therefore work via our loop's setTimeout.
export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const { validateNumber } = require("internal/validators");

  // Symbol under which a stream/socket hides its active timeout handle.
  const kTimeout = Symbol("timeout");
  const kRefed = Symbol("refed");

  const TIMEOUT_MAX = 2 ** 31 - 1;

  // Mirrors timers.enroll()'s validation.
  function getTimerDuration(msecs, name) {
    validateNumber(msecs, name);
    if (msecs < 0 || !Number.isFinite(msecs)) {
      const err = new RangeError(
        `The value of "${name}" is out of range. It must be a non-negative finite number. Received ${msecs}`,
      );
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }
    if (msecs > TIMEOUT_MAX) return TIMEOUT_MAX;
    return msecs;
  }

  // An unref'd timeout: it fires, but does not by itself keep the loop alive.
  function setUnrefTimeout(callback, after, ...args) {
    const t = globalThis.setTimeout(callback, after, ...args);
    if (t && typeof t.unref === "function") t.unref();
    return t;
  }

  // The few list helpers net.js/others may touch — no-ops on our model, since
  // each Timeout is an independent handle managed by the loop.
  const insert = () => {};
  const active = (item) => {
    if (item && item[kTimeout] && typeof item[kTimeout].refresh === "function") {
      item[kTimeout].refresh();
    }
    return item;
  };
  const unrefActive = active;

  module.exports = {
    kTimeout,
    kRefed,
    TIMEOUT_MAX,
    getTimerDuration,
    setUnrefTimeout,
    insert,
    active,
    unrefActive,
  };
}
