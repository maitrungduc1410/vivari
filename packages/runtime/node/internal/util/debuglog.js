// internal/util/debuglog — stub.
//
// NODE_DEBUG channels are disabled in OpenContainer; debuglog() returns an inert
// logger so `const debug = debuglog('net')` at the top of a module is free.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  function debuglog(_set, cb) {
    const logger = () => {};
    logger.enabled = false;
    if (typeof cb === "function") cb(logger);
    return logger;
  }

  module.exports = { debuglog, debug: debuglog };
}
