// https — deferred stub (Phase 2 #8).
//
// TLS isn't implemented yet, so https is unavailable. lib/http.js only touches
// this lazily (proxy-from-env), so importing http stays fine; using https throws.
export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";
  const notImpl = () => {
    const err = new Error("OpenContainer: https/TLS is not implemented yet");
    err.code = "ERR_METHOD_NOT_IMPLEMENTED";
    throw err;
  };
  module.exports = {
    get globalAgent() {
      return undefined;
    },
    set globalAgent(_v) {},
    Agent: class Agent {
      constructor() {
        notImpl();
      }
    },
    Server: class Server {
      constructor() {
        notImpl();
      }
    },
    createServer: notImpl,
    request: notImpl,
    get: notImpl,
  };
}
