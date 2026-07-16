// internal/deps/undici/undici — deferred stub (Phase 2 #8).
//
// Node bundles undici to power global fetch/WebSocket and env-proxy dispatchers.
// lib/http.js only require()s this lazily (WebSocket getters, proxy-from-env), so
// importing http is unaffected; touching these throws until we bridge fetch (#9).
export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";
  const notImpl = () => {
    const err = new Error("Vivari: undici (fetch/WebSocket) is not implemented yet");
    err.code = "ERR_METHOD_NOT_IMPLEMENTED";
    throw err;
  };
  module.exports = {
    fetch: notImpl,
    WebSocket: class WebSocket {
      constructor() {
        notImpl();
      }
    },
    CloseEvent: class CloseEvent {},
    MessageEvent: class MessageEvent {},
    setGlobalDispatcher: notImpl,
    getGlobalDispatcher: notImpl,
    EnvHttpProxyAgent: class EnvHttpProxyAgent {
      constructor() {
        notImpl();
      }
    },
  };
}
