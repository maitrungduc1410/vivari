// Bun.serve support: option handling and the RFC 6455 rules the handshake and
// frame reader have to enforce. Everything here is PURE — no sockets, no Node
// builtins, no closures over a running server — so scripts/spike-bun-offline.mjs
// can drive it directly in the Wasm-free tier that CI gates on every PR. The
// stateful half (the http.Server, ServerWebSocket, pub/sub) stays in bun.js.
//
// Why this file exists at all: `Bun.serve` accepted eight documented options and
// silently ignored every one of them. That is the single failure mode this
// project cares most about — code that passes in the sandbox and breaks in
// production — and it is worse than a missing feature, because nothing tells the
// author. `normalizeServeOptions` is where each option now gets a deliberate,
// written-down answer: implement it, degrade it LOUDLY, or throw.
//
// The three answers, and the rule for choosing between them:
//   * IMPLEMENT when the sandbox can genuinely honour the option. `idleTimeout`,
//     `maxRequestBodySize`, `static` and `unix` all can (see below), so they do.
//   * DEGRADE when production behaviour is a superset the sandbox cannot reach,
//     but running without it is still a faithful-enough server. `tls` is the
//     archetype: refusing to boot would break every app that merely HAS a
//     production certificate configured, which is most of them. Degrading serves
//     plaintext and says so once.
//   * THROW when running without the option means serving something that is not
//     the protocol the caller asked for. `http3` is that: there is no QUIC in a
//     browser tab, and quietly answering HTTP/1.1 to code written for HTTP/3 is
//     the silent-approximation failure in its purest form.

// Bun's own defaults, from its documented `Bun.serve` options.
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 10;
export const MAX_IDLE_TIMEOUT_SECONDS = 255; // Bun stores this in a u8.
export const DEFAULT_MAX_REQUEST_BODY_SIZE = 128 * 1024 * 1024; // 128 MiB.

// RFC 6455 close codes we actually send. §7.4.1.
export const WS_CLOSE_PROTOCOL_ERROR = 1002;
export const WS_CLOSE_TOO_LARGE = 1009;

// RFC 6455 §1.3 — the fixed GUID concatenated with Sec-WebSocket-Key before the
// SHA-1. Exported so the spike can pin the handshake against the RFC's own
// worked example rather than against our implementation.
export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// The only version this shim speaks. RFC 6455 §4.1 fixes it at 13.
export const WS_VERSION = 13;

// ---- option normalisation ---------------------------------------------------
// Returns { config, warnings }. `warnings` is DATA, not console output, so the
// spike can assert on it; bun.js is what actually prints them, once per process
// per key. Hard failures throw from here so they surface at Bun.serve() time.
export function normalizeServeOptions(options) {
  const opts = options || {};
  const warnings = [];
  const warn = (key, message) => warnings.push({ key, message });

  // ---- THROW: no amount of degrading makes this honest ----------------------
  // HTTP/3 is QUIC over UDP. A browser tab has no UDP socket at all, and the
  // preview path is a Service Worker speaking HTTP/1.1. Serving 1.1 to an app
  // that asked for 3 would be a silent approximation of a wire protocol.
  if (opts.http3) {
    throw new Error(
      "Bun.serve({ http3: true }) is not supported in Vivari. HTTP/3 is QUIC over UDP, " +
        "and a browser tab has no UDP socket; the preview path is HTTP/1.1 end to end. " +
        "This throws rather than quietly serving HTTP/1.1, because code written for HTTP/3 " +
        "would appear to work here and behave differently in production.",
    );
  }

  // ---- DEGRADE: accept, run without it, say so once ------------------------
  // TLS terminates outside the VM. The Service-Worker preview is already served
  // over the page's own (https) origin, so an app is not actually exposed in
  // cleartext to a network — there is no network. Throwing here would refuse to
  // boot any app that merely has a production certificate in its config.
  if (opts.tls) {
    warn(
      "tls",
      "Bun.serve({ tls }) is accepted but ignored: this server speaks plaintext HTTP/1.1. " +
        "There is no network hop to protect inside the VM, and the browser preview is already " +
        "served over the page's own origin. `server.url` reports http:, not https:. Your TLS " +
        "config is untouched and will apply when you deploy.",
    );
  }
  // SO_REUSEPORT exists to load-balance one port across SEVERAL processes. Vivari
  // runs one server process per port, so honouring the flag is impossible rather
  // than merely unimplemented: there is no second acceptor to balance with.
  if (opts.reusePort) {
    warn(
      "reusePort",
      "Bun.serve({ reusePort: true }) is accepted but has no effect: it asks the OS to " +
        "load-balance one port across multiple processes (SO_REUSEPORT), and Vivari's port " +
        "registry binds a port to exactly one in-VM process. A second Bun.serve on the same " +
        "port still fails, as it would without the flag.",
    );
  }
  // The loopback stack is IPv4-shaped (127.0.0.1); there is no dual-stack socket
  // to restrict, so the flag cannot change anything either way.
  if (opts.ipv6Only) {
    warn(
      "ipv6Only",
      "Bun.serve({ ipv6Only: true }) is accepted but has no effect: Vivari's in-VM loopback " +
        "network is IPv4-only (127.0.0.1), so there is no dual-stack socket to restrict.",
    );
  }

  // ---- IMPLEMENT ----------------------------------------------------------
  // idleTimeout: seconds, integer, 0 disables. Bun keeps it in a u8 and rejects
  // anything above 255, so we reject the same inputs at the same boundary — a
  // value Bun refuses must not quietly work here. Genuinely enforced: the VM's
  // net.js is Node's real one, so socket.setTimeout() fires (verified in-VM).
  let idleTimeout = DEFAULT_IDLE_TIMEOUT_SECONDS;
  if (opts.idleTimeout !== undefined) {
    const t = opts.idleTimeout;
    if (typeof t !== "number" || !Number.isFinite(t) || Math.floor(t) !== t || t < 0) {
      throw new TypeError("Bun.serve({ idleTimeout }) must be a non-negative integer number of seconds, got " + String(t));
    }
    if (t > MAX_IDLE_TIMEOUT_SECONDS) {
      throw new RangeError("Bun.serve({ idleTimeout }) cannot exceed " + MAX_IDLE_TIMEOUT_SECONDS + " seconds, got " + t);
    }
    idleTimeout = t;
  }

  // maxRequestBodySize: enforced while the request body is collected; an
  // oversized body gets a 413 and the connection is torn down, rather than being
  // buffered into the VM's heap.
  let maxRequestBodySize = DEFAULT_MAX_REQUEST_BODY_SIZE;
  if (opts.maxRequestBodySize !== undefined) {
    const n = opts.maxRequestBodySize;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
      throw new TypeError("Bun.serve({ maxRequestBodySize }) must be a non-negative number of bytes, got " + String(n));
    }
    maxRequestBodySize = n;
  }

  // unix: a real UNIX-domain socket. Vivari's net layer has a Pipe binding and
  // server.listen({ path }) genuinely works in-VM (verified), so this is honoured
  // rather than faked. The catch is not the socket, it is discovery: the browser
  // preview finds in-VM servers by PORT through the kernel's port registry, and a
  // path has no port. So it works for in-VM clients and cannot be previewed —
  // which is exactly the kind of thing that must be said out loud.
  let unix = null;
  if (opts.unix) {
    if (typeof opts.unix !== "string") {
      throw new TypeError("Bun.serve({ unix }) must be a socket path string, got " + typeof opts.unix);
    }
    unix = opts.unix;
    warn(
      "unix",
      "Bun.serve({ unix: " + JSON.stringify(unix) + " }) binds a real UNIX-domain socket and in-VM " +
        "clients can connect to it, but it CANNOT be reached from the browser preview: the " +
        "Service-Worker proxy locates in-VM servers by TCP port through the kernel's port " +
        "registry, and a socket path has no port. Pass `port` as well if you need a preview.",
    );
  }

  // id: Bun uses this to identify a server across `--hot` reloads. There is
  // nothing to honour at bind time, but it is observable on the instance, so we
  // keep it rather than dropping it (no behaviour is being approximated).
  const id = opts.id !== undefined ? String(opts.id) : undefined;

  const port = opts.port != null ? opts.port | 0 : unix ? 0 : 3000;
  const hostname = opts.hostname || "0.0.0.0";

  return {
    config: {
      port,
      hostname,
      unix,
      id,
      idleTimeout,
      maxRequestBodySize,
      development: !!opts.development,
      tls: !!opts.tls,
      staticRoutes: compileStaticRoutes(opts.static),
    },
    warnings,
  };
}

// `static` is a documented Bun option: a map of EXACT pathnames to already-built
// Response objects, served without running any handler. Bun matches it before
// `routes`, and only on an exact pathname, so that is what this does. Returns a
// Map (or null), which the request path checks first.
export function compileStaticRoutes(staticMap) {
  if (!staticMap || typeof staticMap !== "object") return null;
  const out = new Map();
  for (const pathname of Object.keys(staticMap)) {
    const value = staticMap[pathname];
    if (!value) continue;
    // Bun's `static` takes built Responses, not handlers. A function here is
    // almost certainly a `routes` entry in the wrong option, and silently never
    // calling it would be a genuinely baffling bug to chase.
    if (typeof value === "function") {
      throw new TypeError(
        "Bun.serve({ static }) takes pre-built Response objects, not handlers — " +
          JSON.stringify(pathname) + " is a function. Put handler routes in `routes` instead.",
      );
    }
    out.set(pathname, value);
  }
  return out.size ? out : null;
}

// ---- WebSocket handshake ----------------------------------------------------
// RFC 6455 §4.2.1: the request must carry Sec-WebSocket-Version: 13 and a
// Sec-WebSocket-Key. §4.4 says a server that does not speak the offered version
// replies 426 and advertises what it does speak. Returns null when the request is
// acceptable, or { status, statusText, headers } describing the refusal.
export function validateUpgradeRequest(headers) {
  const h = headers || {};
  const version = h["sec-websocket-version"];
  if (version !== undefined && String(version).trim() !== String(WS_VERSION)) {
    return {
      status: 426,
      statusText: "Upgrade Required",
      headers: { "Sec-WebSocket-Version": String(WS_VERSION) },
      reason: "unsupported Sec-WebSocket-Version: " + String(version),
    };
  }
  const key = h["sec-websocket-key"];
  // §4.1: the key is a base64-encoded 16-byte nonce, i.e. 24 base64 characters.
  // Accepting a missing or malformed key means computing an Accept value the
  // client will reject anyway, but only after it has been told the handshake
  // succeeded — a 400 up front is the clearer failure.
  if (!key || !/^[A-Za-z0-9+/]{22}==$/.test(String(key).trim())) {
    return {
      status: 400,
      statusText: "Bad Request",
      headers: {},
      reason: key ? "malformed Sec-WebSocket-Key" : "missing Sec-WebSocket-Key",
    };
  }
  return null;
}

// RFC 6455 §4.2.2 step 4: the server echoes a subprotocol ONLY if it is one the
// server actually selected AND the client offered it. The shim used to echo the
// client's first offer unconditionally, which is both a spec violation (it can
// name a protocol the server does not speak) and a divergence from Bun, where you
// select one explicitly via `server.upgrade(req, { headers })`. Blind echoing is
// the sandbox-passes/production-breaks shape: the client sees its protocol
// accepted here and rejected by real Bun.
//
// `offered` is what the server asked for in the upgrade headers, or null when it
// asked for nothing — in which case we select nothing, which RFC 6455 §4.2.2
// explicitly allows and every client tolerates (verified against the in-VM
// client: it opens with `ws.protocol === ""`).
export function negotiateSubprotocol(requestedHeader, offered) {
  if (!offered) return null;
  const requested = String(requestedHeader || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const candidates = (Array.isArray(offered) ? offered : String(offered).split(","))
    .map((s) => String(s).trim())
    .filter(Boolean);
  for (const candidate of candidates) {
    if (requested.includes(candidate)) return candidate;
  }
  // The server named a subprotocol the client never offered. Sending it anyway
  // makes a conforming client fail the connection (§4.1), so we select none.
  return null;
}

// Build the 101 response head. `extraHeaders` is whatever the caller passed to
// server.upgrade({ headers }); Sec-WebSocket-Protocol is filtered out of it and
// re-emitted from the negotiated value, which is what stops the duplicate header
// the shim used to send when both sides named one.
export function buildHandshakeResponse(accept, protocol, extraHeaderPairs) {
  let head =
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + accept + "\r\n";
  if (protocol) head += "Sec-WebSocket-Protocol: " + protocol + "\r\n";
  for (const [k, v] of extraHeaderPairs || []) {
    const lk = String(k).toLowerCase();
    // Never let caller headers duplicate the handshake's own fields.
    if (lk === "sec-websocket-protocol" || lk === "upgrade" || lk === "connection" || lk === "sec-websocket-accept") continue;
    head += k + ": " + v + "\r\n";
  }
  return head + "\r\n";
}

// ---- WebSocket frame validation --------------------------------------------
// The reader in bun.js parses frames; this decides whether a parsed frame is
// LEGAL for a server to have received. Kept separate from the parser on purpose:
// the parser is shared with the client-role codec, and only the server is
// entitled to reject an unmasked frame.
//
// `state` carries the fragmentation context: { fragmented } is true when a
// previous data frame arrived with FIN clear.
export function wsFrameProtocolError(frame, state) {
  const st = state || {};
  const { fin, opcode, masked, rsv1, rsv2, rsv3, payload } = frame;
  const len = payload ? payload.length : 0;

  // §5.1: "The server MUST close the connection upon receiving a frame that is
  // not masked." A client that does not mask is either broken or an attacker
  // probing a proxy.
  if (st.requireMask !== false && !masked) {
    return { code: WS_CLOSE_PROTOCOL_ERROR, reason: "client frames must be masked (RFC 6455 §5.1)" };
  }
  // §5.2: RSV1-3 MUST be 0 unless an extension was negotiated. We negotiate no
  // extensions at all (see the compress note in bun.js), so any RSV bit is a
  // protocol error rather than something to ignore.
  if (rsv1 || rsv2 || rsv3) {
    return { code: WS_CLOSE_PROTOCOL_ERROR, reason: "RSV bits set but no extension was negotiated (RFC 6455 §5.2)" };
  }
  const isControl = (opcode & 0x8) !== 0;
  if (isControl) {
    // §5.5: control frames MUST have a payload of 125 bytes or less and MUST NOT
    // be fragmented.
    if (len > 125) {
      return { code: WS_CLOSE_PROTOCOL_ERROR, reason: "control frame payload exceeds 125 bytes (RFC 6455 §5.5)" };
    }
    if (!fin) {
      return { code: WS_CLOSE_PROTOCOL_ERROR, reason: "control frames must not be fragmented (RFC 6455 §5.5)" };
    }
    if (opcode !== 0x8 && opcode !== 0x9 && opcode !== 0xa) {
      return { code: WS_CLOSE_PROTOCOL_ERROR, reason: "reserved control opcode 0x" + opcode.toString(16) + " (RFC 6455 §5.2)" };
    }
    return null;
  }
  if (opcode !== 0x0 && opcode !== 0x1 && opcode !== 0x2) {
    return { code: WS_CLOSE_PROTOCOL_ERROR, reason: "reserved data opcode 0x" + opcode.toString(16) + " (RFC 6455 §5.2)" };
  }
  // §5.4: a continuation with nothing to continue, or a fresh data frame in the
  // middle of a fragmented message, are both protocol errors.
  if (opcode === 0x0 && !st.fragmented) {
    return { code: WS_CLOSE_PROTOCOL_ERROR, reason: "continuation frame with no message to continue (RFC 6455 §5.4)" };
  }
  if (opcode !== 0x0 && st.fragmented) {
    return { code: WS_CLOSE_PROTOCOL_ERROR, reason: "new data frame while a fragmented message is open (RFC 6455 §5.4)" };
  }
  // Not an RFC rule but Bun's documented `maxPayloadLength`: 1009 is the code
  // §7.4.1 reserves for "message too big to process".
  if (st.maxPayloadLength > 0 && st.receivedLength + len > st.maxPayloadLength) {
    return { code: WS_CLOSE_TOO_LARGE, reason: "message exceeds maxPayloadLength of " + st.maxPayloadLength + " bytes" };
  }
  return null;
}