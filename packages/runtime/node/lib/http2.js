// A load-safe `http2` stub. A faithful HTTP/2 stack is a large undertaking; Vite
// (and most servers) only reach for http2 when explicitly configured, while the
// module is often required at the top of a file for its constants/types. This
// exposes the public surface so the module loads; the server/client factories
// throw only if actually used, so the http1 path keeps working.

export default function (exports, require, module) {
  const nope = (name) => () => {
    throw new Error("http2." + name + " is not supported in Vivari (use http/https)");
  };

  // The subset of HTTP/2 header/settings constants most code destructures.
  const constants = {
    HTTP2_HEADER_STATUS: ":status",
    HTTP2_HEADER_METHOD: ":method",
    HTTP2_HEADER_AUTHORITY: ":authority",
    HTTP2_HEADER_SCHEME: ":scheme",
    HTTP2_HEADER_PATH: ":path",
    HTTP2_HEADER_CONTENT_TYPE: "content-type",
    HTTP2_HEADER_CONTENT_LENGTH: "content-length",
    HTTP2_METHOD_GET: "GET",
    HTTP2_METHOD_POST: "POST",
    NGHTTP2_NO_ERROR: 0,
    NGHTTP2_PROTOCOL_ERROR: 1,
    NGHTTP2_INTERNAL_ERROR: 2,
    NGHTTP2_CANCEL: 8,
  };

  exports.constants = constants;
  exports.createServer = nope("createServer");
  exports.createSecureServer = nope("createSecureServer");
  exports.connect = nope("connect");
  exports.getDefaultSettings = () => ({});
  exports.getPackedSettings = () => globalThis.Buffer.alloc(0);
  exports.getUnpackedSettings = () => ({});
  exports.performServerHandshake = nope("performServerHandshake");
  exports.sensitiveHeaders = Symbol.for("nodejs.http2.sensitiveHeaders");
  exports.Http2ServerRequest = class Http2ServerRequest {};
  exports.Http2ServerResponse = class Http2ServerResponse {};
  exports.Http2Session = class Http2Session {};
  exports.ServerHttp2Session = class ServerHttp2Session {};
  exports.ClientHttp2Session = class ClientHttp2Session {};
  exports.Http2Stream = class Http2Stream {};
}
