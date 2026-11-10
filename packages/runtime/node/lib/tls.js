// tls — partial shim (Phase 2 #8).
//
// There is no TLS backend yet, so an actual handshake / secure connection can't
// work. But real code (and its deep deps) routinely *construct* a `tls.TLSSocket`
// or call `tls.createSecureContext()` at module-load time for feature detection
// or prototype access — a real TLSSocket extends net.Socket and does NO I/O until
// a handshake starts. So construction must be benign; only operations that truly
// need the missing backend (connect / listen / a real secure server) throw.
// This lets http-only tooling (webpack-dev-server, Docusaurus) that transitively
// pulls `tls` load and run over plain http.
export default function (exports, require, module, process, internalBinding) {
  "use strict";
  const net = require("net");
  const Socket = (net && net.Socket) || class {};

  const notImpl = (what) => {
    const err = new Error("Vivari: TLS is not implemented yet" + (what ? " (" + what + ")" : ""));
    err.code = "ERR_METHOD_NOT_IMPLEMENTED";
    throw err;
  };

  // When a real TLSSocket wraps a JS stream, its internal handle exposes a
  // `_parentWrap` back-reference whose `.constructor` is Node's internal
  // JSStreamSocket class. `http2-wrapper` reads exactly that at module-load time
  // ("Really awesome hack": `new tls.TLSSocket(new PassThrough())._handle
  // ._parentWrap.constructor`) — a common transitive dep (got/docusaurus). Give
  // the benign socket a synthetic handle so that lookup yields a harmless class
  // instead of throwing on null (http/2-over-TLS is unused anyway).
  class JSStreamSocket {}

  // Benign: behaves like a net.Socket, never performs a handshake.
  class TLSSocket extends Socket {
    constructor(socket, options) {
      super(options && typeof options === "object" ? options : undefined);
      this.encrypted = true;
      this.authorized = false;
      this.authorizationError = null;
      this._handle = { _parentWrap: new JSStreamSocket() };
    }
    getPeerCertificate() {
      return {};
    }
    getCertificate() {
      return null;
    }
    getCipher() {
      return {};
    }
    getProtocol() {
      return null;
    }
    getSession() {
      return undefined;
    }
    getSharedSigalgs() {
      return [];
    }
    setServername() {}
    setSession() {}
    setMaxSendFragment() {
      return true;
    }
    // A genuine handshake needs the missing backend.
    renegotiate() {
      notImpl("tls.TLSSocket.renegotiate");
    }
  }

  class Server extends ((net && net.Server) || class {}) {
    setSecureContext() {}
    addContext() {}
    // Starting a real TLS server needs the backend.
    listen() {
      notImpl("tls.Server.listen");
    }
  }

  // tls.connect to an outside host: an HTTP/1.1 client (undici, which pnpm 11
  // bundles) gets a socket whose requests are answered through fetch. See
  // internal/tls-http-egress.js for what that socket will and will not carry.
  function connect(...args) {
    const { HttpEgressSocket, normalizeConnectArgs } = require("internal/tls-http-egress");
    const { options, cb } = normalizeConnectArgs(args);
    if (options.socket) notImpl("tls.connect over an existing socket (proxy tunnels)");
    if (options.path) notImpl("tls.connect to a UNIX socket");
    const host = String(options.host || options.servername || "localhost").replace(/^\[|\]$/g, "");
    let local = false;
    try {
      local = internalBinding("tcp_wrap").isLocalDestination(host);
    } catch {}
    if (local) {
      // No in-VM TLS server exists, and going out to the network would reach the
      // user's real machine instead (same rule as fetch('https://localhost')).
      const err = new Error("Vivari: there is no TLS inside the VM, so " + host + " cannot be reached over tls.connect");
      err.code = "ERR_VIVARI_LOOPBACK_TLS";
      throw err;
    }
    const socket = new HttpEgressSocket({
      host,
      port: Number(options.port) || 443,
      protocol: "https:",
      servername: options.servername,
    });
    if (cb) socket.once("secureConnect", cb);
    return socket;
  }

  module.exports = {
    connect,
    createServer: () => notImpl("tls.createServer"),
    createSecurePair: () => notImpl("tls.createSecurePair"),
    // Benign at setup time; libs create these eagerly and only fail if they
    // actually attempt a handshake (which routes through connect/listen above).
    createSecureContext: (opts) => ({ context: {}, options: opts || {} }),
    checkServerIdentity: () => undefined,
    getCiphers: () => [],
    TLSSocket,
    Server,
    rootCertificates: [],
    DEFAULT_ECDH_CURVE: "auto",
    DEFAULT_MIN_VERSION: "TLSv1.2",
    DEFAULT_MAX_VERSION: "TLSv1.3",
    CLIENT_RENEG_LIMIT: 3,
    CLIENT_RENEG_WINDOW: 600,
    constants: {},
  };
}
