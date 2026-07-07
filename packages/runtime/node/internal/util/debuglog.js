// internal/util/debuglog — stub.
//
// NODE_DEBUG channels are disabled in OpenContainer; debuglog() returns an inert
// logger so `const debug = debuglog('net')` at the top of a module is free.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  function debuglog(_set, _cb) {
    // NB: do NOT invoke `_cb` here. Node calls it lazily on first use; callers do
    //   let debug = debuglog('stream', (fn) => { debug = fn; });
    // so a synchronous call would assign to `debug` while it's still in its TDZ.
    // Channels are always disabled, so the inert logger is the final value.
    const logger = () => {};
    logger.enabled = false;
    return logger;
  }

  module.exports = { debuglog, debug: debuglog };
}
