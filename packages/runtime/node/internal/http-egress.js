// internal/http-egress — outbound plain-http for destinations the virtual
// network cannot serve.
//
// lib/http.js is vendored verbatim from Node and its client path ends at
// `Agent.prototype.createConnection` -> `net.createConnection`. Our `net` is a
// loopback-only virtual network (bindings/net.js): `listen()` registers a port
// in-VM, and a connect() to anything else fails with EHOSTUNREACH/ENOTFOUND (it
// used to be silently retargeted onto whatever in-VM server owned the port —
// that was fixed, and must stay fixed). So `http://` to a real outside host had
// no route at all, while `https://` had one all along via the Fetcher Worker.
//
// This module closes that gap by wrapping `http.request` / `http.get` where the
// loader builds the module: a request whose destination the loopback net cannot
// serve is handed to the same fetch-backed transport `https` uses
// (internal/fetch-transport.js); everything else calls the vendored function,
// unmodified and unaware.
//
// WHERE THE SPLIT IS, AND WHY IT IS THIS SHAPE
//
// The decision is made on the DESTINATION HOST, by the virtual network's own
// judgement — `internalBinding('tcp_wrap').isLocalDestination` is literally the
// same function bindings/net.js's connect() uses to accept or reject a dial, so
// the two cannot drift: every destination that egresses here is exactly one that
// connect() would have refused, and vice versa.
//
// It is deliberately NOT made on the port. The binding does know which ports it
// serves (the `listeners` registry, mirrored to the kernel by listen()), but that
// table cannot answer this question in either direction:
//   • "port is served in-VM" does not mean the destination is local —
//     http://api.example.com:3000 must not be answered by the in-VM :3000 dev
//     server. That equivalence IS the bug that was just fixed.
//   • "port is not served in-VM" does not mean the destination is external —
//     http://127.0.0.1:9999 must keep failing with ECONNREFUSED (every
//     wait-for-the-dev-server-to-come-up loop depends on it), and must never be
//     sent out to the internet where a stranger's server may answer 200.
// A cross-process in-VM port is not in this process's registry at all (only the
// kernel's pipe table knows), so a port-based rule would misjudge Nitro's SSR
// worker too. Host is the only axis that answers the question; the port table is
// a routing table for loopback, not a reachability oracle.
//
// Every other guard below resolves the same way: when in doubt, do NOT egress.
// Getting it wrong in the permissive direction sends a request meant for the
// in-VM preview server out to the internet; getting it wrong the other way only
// reproduces today's honest EHOSTUNREACH.
export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";
  const { createFetchClient, parseArgs, hostOf } = require("internal/fetch-transport");
  const { kProxyConfig } = require("internal/http");

  /**
   * Wrap `http`'s exports in place, after the vendored factory has populated them.
   * In place, because module.exports carries accessors (globalAgent, maxHeaderSize,
   * WebSocket) that a copy would flatten — and because the vendored `request`
   * stays reachable, byte-identical, for every loopback call. The binding set is
   * this module instance's own: createNodeModules() builds exactly one, so it is
   * the same one `http` and `net` were given.
   */
  function install(http) {
    // The virtual network's own accept/reject predicate. Absent on a binding that
    // predates it → never egress (today's behaviour), never guess.
    let isLocalDestination = null;
    try {
      const tcp = internalBinding("tcp_wrap");
      if (tcp && typeof tcp.isLocalDestination === "function") isLocalDestination = tcp.isLocalDestination;
    } catch {
      /* no tcp_wrap in this runtime — leave http entirely alone */
    }
    if (!isLocalDestination) return http;

    const vendoredRequest = http.request;
    const vendoredGet = http.get;
    const agentCreateConnection = http.Agent && http.Agent.prototype && http.Agent.prototype.createConnection;
    const fetchClient = createFetchClient({ protocol: "http:", defaultPort: 80, encrypted: false });

    // Does this request need the fetch-backed egress? Anything unclear answers
    // false, which is the vendored net path — the one that cannot be wrong about
    // an in-VM server.
    const needsEgress = (url, options) => {
      let opts;
      try {
        opts = parseArgs(url, options).opts;
      } catch {
        // A malformed URL: let the vendored request throw its own canonical
        // ERR_INVALID_URL rather than a lookalike from here.
        return false;
      }

      // A UNIX socket / named pipe is in-VM by construction (docker.sock,
      // vite-node's module socket) and has no hostname to judge.
      if (opts.socketPath) return false;
      // The caller brought its own transport; honour it.
      if (typeof opts.createConnection === "function") return false;
      // Only plain http. A string 'https://…' or an explicit protocol option must
      // still reach the vendored client so it throws ERR_INVALID_PROTOCOL.
      if ((opts.protocol || "http:") !== "http:") return false;

      const agent = opts.agent === undefined || opts.agent === null ? http.globalAgent : opts.agent;
      if (agent && typeof agent === "object") {
        // A proxy-aware agent (http-proxy-agent, socks-proxy-agent, …) overrides
        // createConnection to dial the proxy instead. Bypassing it would send the
        // request somewhere the caller explicitly routed it away from, so defer:
        // an in-VM proxy then works over loopback, an external one fails loudly.
        if (typeof agent.createConnection === "function" && agent.createConnection !== agentCreateConnection) {
          return false;
        }
        // Same for an agent configured from HTTP_PROXY/http_proxy (Node's
        // setGlobalProxyFromEnv / --use-env-proxy). The Fetcher Worker has no
        // proxy seam, and quietly ignoring a configured proxy is exactly the kind
        // of silent wrong answer this split exists to prevent.
        if (agent[kProxyConfig]) return false;
      }

      // The one real question, answered by the virtual network itself.
      return !isLocalDestination(hostOf(opts));
    };

    http.request = function request(url, options, cb) {
      return needsEgress(url, options)
        ? fetchClient.request(url, options, cb)
        : vendoredRequest(url, options, cb);
    };
    http.get = function get(url, options, cb) {
      return needsEgress(url, options) ? fetchClient.get(url, options, cb) : vendoredGet(url, options, cb);
    };

    return http;
  }

  module.exports = { install };
}