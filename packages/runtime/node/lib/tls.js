// tls — deferred stub (Phase 2 #8).
//
// No TLS backend yet. _http_agent loads this lazily (getLazy) only for https
// agents, so http works without it; any actual TLS use throws.
export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";
  const notImpl = () => {
    const err = new Error("OpenContainer: TLS is not implemented yet");
    err.code = "ERR_METHOD_NOT_IMPLEMENTED";
    throw err;
  };
  module.exports = {
    connect: notImpl,
    createSecureContext: notImpl,
    TLSSocket: class TLSSocket {
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
    rootCertificates: [],
  };
}
