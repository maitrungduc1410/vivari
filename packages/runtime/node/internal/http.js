// internal/http — compatible shim (Phase 2 #8).
//
// Node's real internal/http.js pulls trace_events, internal/constants and the
// WHATWG URL parser for proxy handling. The http tree only destructures a small,
// stable surface from it (symbols + utcDate + trace/proxy helpers), so we provide
// exactly that. Tracing is inert; proxy support is deferred (no env proxy).
export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const kOutHeaders = Symbol("kOutHeaders");
  const kNeedDrain = Symbol("kNeedDrain");
  const kProxyConfig = Symbol("kProxyConfig");
  const kWaitForProxyTunnel = Symbol("kWaitForProxyTunnel");

  // RFC 7231 IMF-fixdate, cached to the current second (as Node does).
  let dateCache;
  let lastTimestamp = 0;
  function utcDate() {
    const now = Date.now();
    if (now - lastTimestamp >= 1000 || dateCache === undefined) {
      lastTimestamp = now;
      dateCache = new Date(now).toUTCString();
    }
    return dateCache;
  }

  // Tracing: no observer, so spans are inert.
  let traceId = 0;
  const isTraceHTTPEnabled = () => false;
  const traceBegin = () => {};
  const traceEnd = () => {};
  const getNextTraceEventId = () => ++traceId;

  // Proxy-from-env: not supported — always "no proxy configured".
  const checkShouldUseProxy = () => false;
  const parseProxyConfigFromEnv = () => undefined;
  const parseProxyUrl = () => null;
  const filterEnvForProxies = () => ({ __proto__: null });
  const getGlobalAgent = (env, AgentCtor) => (AgentCtor ? new AgentCtor() : undefined);

  module.exports = {
    kOutHeaders,
    kNeedDrain,
    kProxyConfig,
    kWaitForProxyTunnel,
    utcDate,
    isTraceHTTPEnabled,
    traceBegin,
    traceEnd,
    getNextTraceEventId,
    checkShouldUseProxy,
    parseProxyConfigFromEnv,
    parseProxyUrl,
    filterEnvForProxies,
    getGlobalAgent,
  };
}
