// https — a fetch-backed client (package-managers phase 1).
//
// Real TLS/sockets don't exist in-VM, so instead of a socket-level https we
// implement https.request/get on top of the Fetcher Worker (globalThis.__ocfetch,
// the same blocking egress the kernel services). This is enough for the real npm
// (npm-registry-fetch -> make-fetch-happen -> minipass-fetch), which drives a
// standard http.ClientRequest and reads a standard http.IncomingMessage.
//
// The transport itself now lives in internal/fetch-transport.js: `http` needs the
// same fetch-backed client for the destinations its loopback `net` cannot serve
// (see internal/http-egress.js), and one implementation shared by both protocols
// beats two copies that drift. This module is the https-shaped shell around it —
// the scheme/port defaults, the no-op Agent, and the absent https *server*.
//
// Unlike http, egress here is unconditional: there is no in-VM TLS socket at all,
// so even https://localhost has nothing to talk to on the loopback path.
export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";
  const EventEmitter = require("events");
  const { createFetchClient, makeDummySocket } = require("internal/fetch-transport");

  const { ClientRequest, request, get } = createFetchClient({
    protocol: "https:",
    defaultPort: 443,
    encrypted: true,
  });

  // A no-op Agent that is safe to extend (agentkeepalive's HttpsAgent does
  // `class HttpsAgent extends require('https').Agent`) and safe to pass as the
  // `agent` request option (we ignore it — there are no real sockets to pool).
  class Agent extends EventEmitter {
    constructor(options) {
      super();
      this.options = options || {};
      this.defaultPort = 443;
      this.protocol = "https:";
      this.requests = {};
      this.sockets = {};
      this.freeSockets = {};
      this.maxSockets = Infinity;
      this.maxFreeSockets = 256;
      this.maxTotalSockets = Infinity;
      this.keepAlive = !!this.options.keepAlive;
    }
    createConnection() {
      return makeDummySocket(443, true);
    }
    addRequest() {}
    keepSocketAlive() {
      return true;
    }
    reuseSocket() {}
    destroy() {}
    getName() {
      return "";
    }
  }

  const globalAgent = new Agent({ keepAlive: false });

  const notImpl = () => {
    const err = new Error("Vivari: in-VM https servers are not supported");
    err.code = "ERR_METHOD_NOT_IMPLEMENTED";
    throw err;
  };

  module.exports = {
    Agent,
    globalAgent,
    ClientRequest,
    request,
    get,
    Server: class Server {
      constructor() {
        notImpl();
      }
    },
    createServer: notImpl,
  };
}