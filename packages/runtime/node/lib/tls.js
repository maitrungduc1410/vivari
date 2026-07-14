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
export default function (exports, require, module) {
  "use strict";
  const net = require("net");
  const Socket = (net && net.Socket) || class {};

  const notImpl = (what) => {
    const err = new Error("OpenContainer: TLS is not implemented yet" + (what ? " (" + what + ")" : ""));
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

  module.exports = {
    // Actual outbound TLS I/O is unsupported.
    connect: () => notImpl("tls.connect"),
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
