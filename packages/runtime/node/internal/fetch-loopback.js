// internal/fetch-loopback — the guest's global fetch() for destinations INSIDE the VM.
//
// The guest's `fetch` is the host realm's own (runtime/index.js wraps it only to
// rewrite host.vivari.internal and to explain opaque failures). That is right for
// the internet and wrong for loopback: `fetch('http://localhost:3000')` asked the
// BROWSER TAB, which has never heard of a server listening inside the VM, while
// `http.get` to the same URL reached it through the virtual network. Same URL, two
// different machines.
//
// This module is the loopback half. A plain-http URL whose host the virtual
// network itself calls local is sent through the vendored `http` client — the
// same path `http.get` takes, so same-process and cross-process in-VM servers are
// both reachable and a port nobody serves is an honest ECONNREFUSED — and the
// answer comes back as a real WHATWG `Response`.
//
// WHERE THE SPLIT IS. On the destination HOST, by
// `internalBinding('tcp_wrap').isLocalDestination` — the same function object
// bindings/net.js's connect() judges a dial with, and the same one
// internal/http-egress.js splits `http.request` on, so fetch, http and net cannot
// disagree about what "local" means. Never on the port registry: see the header of
// internal/http-egress.js for why that table cannot answer this question in either
// direction.
//
// WHAT IT IS NOT. A second fetch-backed client. The non-local direction is the host
// realm's fetch, untouched; this file only ever talks to the in-VM network.
export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";
  const { Buffer } = require("buffer");

  // Lazily: this module is required when the runtime installs its fetch wrapper,
  // long before any guest fetches loopback, and `http` pulls in the whole client.
  let httpMod = null;
  const getHttp = () => (httpMod ??= require("http"));

  // Absent on a binding that predates it → claim nothing (today's behaviour).
  let isLocalDestination = null;
  try {
    const tcp = internalBinding("tcp_wrap");
    if (tcp && typeof tcp.isLocalDestination === "function") isLocalDestination = tcp.isLocalDestination;
  } catch {
    /* no tcp_wrap in this runtime — every fetch keeps going to the host */
  }

  const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
  const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
  const MAX_REDIRECTS = 20; // the fetch spec's, and undici's
  // Headers a spec-conforming client drops when a redirect turns the request into
  // a body-less GET ("request-body-header names").
  const REQUEST_BODY_HEADERS = ["content-encoding", "content-language", "content-location", "content-type"];
  // What undici strips when a redirect crosses origins.
  const CROSS_ORIGIN_STRIP = ["authorization", "proxy-authorization", "cookie", "host"];
  const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  const NORMALIZED_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"]);
  const FORBIDDEN_METHODS = new Set(["CONNECT", "TRACE", "TRACK"]);
  const BODY_HIGH_WATER_MARK = 1 << 20;

  const isRequest = (v) => typeof globalThis.Request === "function" && v instanceof globalThis.Request;
  const isReadableStream = (v) => v != null && typeof v === "object" && typeof v.getReader === "function";

  // What fetch() itself would resolve the input to: a Request's url, else String().
  const parseInput = (input) => {
    try {
      return new URL(isRequest(input) ? input.url : String(input));
    } catch {
      return null;
    }
  };
  const bareHost = (u) => u.hostname.replace(/^\[(.*)\]$/, "$1");

  /**
   * Which path does this fetch take? "loopback" (plain http to an in-VM
   * destination), "tls" (https to one — unservable), or null (the host's fetch,
   * exactly as before). Never throws: anything unclear is null.
   */
  function route(input) {
    if (!isLocalDestination) return null;
    const u = parseInput(input);
    if (!u) return null;
    const host = bareHost(u);
    // isLocalDestination('') is true (net's 'localhost' default); a URL with no
    // host is not a request for this machine.
    if (!host) return null;
    let local = false;
    try {
      local = isLocalDestination(host) === true;
    } catch {
      return null;
    }
    if (!local) return null;
    if (u.protocol === "http:") return "loopback";
    if (u.protocol === "https:") return "tls";
    return null;
  }

  const fetchFailed = (cause) => new TypeError("fetch failed", { cause });
  const networkError = (message) => fetchFailed(new Error(message));
  const abortReason = (signal) =>
    signal.reason !== undefined ? signal.reason : new DOMException("This operation was aborted", "AbortError");

  function tlsError(u) {
    const plain = new URL(u.href);
    plain.protocol = "http:";
    const e = new TypeError(
      `fetch to ${u.href} cannot be served: ${bareHost(u)} is inside the VM, and the virtual network has no ` +
        `TLS, so there is no in-VM HTTPS server to reach. It is not sent to the host machine either — that ` +
        `would be an answer from a different computer. In-VM servers speak plain HTTP: use ${plain.href}.`,
    );
    e.code = "ERR_VIVARI_LOOPBACK_TLS";
    return e;
  }

  function normalizeMethod(m) {
    const s = String(m);
    if (!TOKEN.test(s)) throw new TypeError(`'${s}' is not a valid HTTP method.`);
    const upper = s.toUpperCase();
    if (FORBIDDEN_METHODS.has(upper)) throw new TypeError(`'${s}' HTTP method is unsupported.`);
    return NORMALIZED_METHODS.has(upper) ? upper : s;
  }

  // The request body as { bytes } (replayable across a redirect), { stream }
  // (not), or null, plus the Content-Type its type implies. The host's own
  // Response does the BodyInit extraction, so string / BufferSource / Blob /
  // URLSearchParams / FormData get exactly the bytes and type fetch would give.
  async function extractBody(input, init) {
    if (init.body !== undefined && init.body !== null) {
      const b = init.body;
      if (isReadableStream(b)) {
        if (init.duplex !== "half") throw new TypeError("RequestInit: duplex option is required when sending a body.");
        return { body: { stream: b }, type: null };
      }
      const tmp = new globalThis.Response(b);
      return { body: { bytes: new Uint8Array(await tmp.arrayBuffer()) }, type: tmp.headers.get("content-type") };
    }
    if (init.body === undefined && isRequest(input) && input.body !== null) {
      // The Request already carries its Content-Type in input.headers.
      return { body: { bytes: new Uint8Array(await input.arrayBuffer()) }, type: null };
    }
    return { body: null, type: null };
  }

  // undici's defaults, so an in-VM server sees what it would under real Node.
  // Per hop, never on the guest's Headers: a redirect that leaves the VM hands
  // those to the host's fetch, and in a browser these are headers the guest never
  // set — a non-safelisted one turns a plain GET into a CORS preflight.
  const IN_VM_DEFAULTS = [
    ["accept", "*/*"],
    ["accept-language", "*"],
    ["sec-fetch-mode", "cors"],
    ["user-agent", "node"],
  ];

  function headersToObject(headers) {
    const out = {};
    for (const [k, v] of headers) out[k] = v;
    for (const [k, v] of IN_VM_DEFAULTS) if (!(k in out)) out[k] = v;
    return out;
  }

  // One HTTP exchange over the in-VM network. Resolves on the response head.
  function exchange(state, u, method, headers, body) {
    return new Promise((resolve, reject) => {
      const req = getHttp().request({
        protocol: "http:",
        hostname: bareHost(u),
        port: u.port || 80,
        path: u.pathname + u.search,
        method,
        headers: headersToObject(headers),
        // A fresh connection per fetch, closed after the response: nothing pooled
        // is left behind to hold (or not hold) the guest's loop open.
        agent: false,
      });
      state.req = req;
      state.rejectHead = reject;
      req.on("response", (res) => {
        state.rejectHead = null;
        resolve(res);
      });
      req.on("upgrade", (res, socket) => {
        socket.destroy();
        reject(networkError("unexpected protocol upgrade"));
      });
      req.on("error", (err) => {
        // After the head, the promise is settled and the failure belongs to the body.
        if (state.bodyError) state.bodyError(new TypeError("terminated", { cause: err }));
        reject(err);
      });
      if (!body) {
        req.end();
      } else if (body.bytes) {
        req.end(Buffer.from(body.bytes.buffer, body.bytes.byteOffset, body.bytes.byteLength));
      } else {
        pumpRequestBody(req, body.stream).catch((err) => req.destroy(err));
      }
    });
  }

  async function pumpRequestBody(req, stream) {
    const reader = stream.getReader();
    try {
      for (;;) {
        if (req.destroyed) {
          await reader.cancel().catch(() => {});
          return;
        }
        const { value, done } = await reader.read();
        if (done) break;
        let chunk = value;
        if (typeof chunk === "string") chunk = Buffer.from(chunk);
        else if (ArrayBuffer.isView(chunk)) chunk = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        else if (chunk instanceof ArrayBuffer) chunk = Buffer.from(chunk);
        else throw new TypeError("Received non-Uint8Array chunk");
        if (!req.write(chunk)) await new Promise((r) => req.once("drain", r));
      }
      req.end();
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* a pending read at destroy time keeps the lock; the stream is dead anyway */
      }
    }
  }

  // Content-Coding the way undici decodes it: only the codings it knows, and never
  // on a response that has no body to decode.
  function decoderFor(res) {
    const enc = String(res.headers["content-encoding"] || "")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (enc.length !== 1) return null;
    const zlib = require("zlib");
    switch (enc[0]) {
      case "gzip":
      case "x-gzip":
        return zlib.createGunzip({ flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH });
      case "deflate":
        return zlib.createInflate({ flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH });
      case "br":
        return zlib.createBrotliDecompress();
      default:
        return null;
    }
  }

  // The IncomingMessage as a WHATWG body. Push-based with a byte high-water mark:
  // a small response drains completely (so its socket closes and an unread body
  // cannot pin the process), a large one gets backpressure.
  function toWebBody(state, req, res, method) {
    const decoder = method !== "HEAD" ? decoderFor(res) : null;
    const src = decoder ? res.pipe(decoder) : res;
    if (decoder) res.on("error", (err) => decoder.destroy(err));
    let controller = null;
    let finished = false;
    const finish = () => {
      finished = true;
      state.bodyError = null;
      state.done();
    };
    state.bodyError = (err) => {
      if (finished) return;
      finish();
      try {
        controller.error(err);
      } catch {
        /* already errored */
      }
    };
    const terminated = (cause) => new TypeError("terminated", { cause });
    return new globalThis.ReadableStream(
      {
        start(c) {
          controller = c;
          src.on("data", (chunk) => {
            if (finished) return;
            c.enqueue(new Uint8Array(chunk));
            if (c.desiredSize <= 0) src.pause();
          });
          src.on("end", () => {
            if (finished) return;
            finish();
            c.close();
          });
          src.on("error", (err) => state.bodyError && state.bodyError(terminated(err)));
          // A connection that dies mid-body closes the message without 'end'.
          res.on("close", () => {
            if (!res.complete && state.bodyError) state.bodyError(terminated(new Error("other side closed")));
          });
        },
        pull() {
          if (!finished) src.resume();
        },
        cancel() {
          finish();
          req.destroy();
        },
      },
      { highWaterMark: BODY_HIGH_WATER_MARK, size: (chunk) => chunk.byteLength },
    );
  }

  function buildResponse(state, req, res, method, u, redirected) {
    const R = globalThis.Response;
    const status = res.statusCode;
    const headers = new globalThis.Headers();
    const raw = res.rawHeaders || [];
    for (let i = 0; i + 1 < raw.length; i += 2) headers.append(raw[i], raw[i + 1]);
    let body = null;
    if (method === "HEAD" || NULL_BODY_STATUSES.has(status)) {
      res.resume();
      res.once("end", () => state.done());
    } else {
      body = toWebBody(state, req, res, method);
    }
    const response = new R(body, { status, statusText: res.statusMessage || "", headers });
    // A browser Response drops Set-Cookie (a "forbidden response-header name"
    // under the response guard); a bare Headers has no guard, and a Node program
    // reading getSetCookie() off its own server's answer expects to see it.
    if (headers.has("set-cookie") && !response.headers.has("set-cookie")) {
      Object.defineProperty(response, "headers", { value: headers, configurable: true });
    }
    // `url`, `redirected` and `type` are what a network fetch sets and a
    // constructed Response cannot; own properties shadow the prototype getters.
    Object.defineProperty(response, "url", { value: u.href, configurable: true });
    Object.defineProperty(response, "redirected", { value: redirected, configurable: true });
    Object.defineProperty(response, "type", { value: "basic", configurable: true });
    return response;
  }

  /**
   * fetch() over the in-VM network. `input`/`init` are fetch's own arguments;
   * `viaHost(url, init)` is the host path, used only when a redirect leaves the VM.
   */
  async function loopbackFetch(input, init, viaHost) {
    init = init == null ? {} : init;
    const req0 = isRequest(input) ? input : null;
    let u = parseInput(input);
    if (!u) throw new TypeError("Failed to parse URL from " + String(input));
    u.hash = "";
    if (u.protocol === "https:") throw tlsError(u);

    let method = normalizeMethod(init.method !== undefined ? init.method : req0 ? req0.method : "GET");
    const headers = new globalThis.Headers(init.headers !== undefined ? init.headers : req0 ? req0.headers : undefined);
    const signal = init.signal !== undefined ? init.signal : req0 ? req0.signal : null;
    const redirectMode = init.redirect !== undefined ? String(init.redirect) : req0 ? req0.redirect : "follow";
    if (!["follow", "manual", "error"].includes(redirectMode)) {
      throw new TypeError(`'${redirectMode}' is not a valid value for RequestInit.redirect.`);
    }
    const hasBody = (init.body !== undefined && init.body !== null) || (init.body === undefined && req0 && req0.body);
    if (hasBody && (method === "GET" || method === "HEAD")) {
      throw new TypeError("Request with GET/HEAD method cannot have body.");
    }
    if (signal && signal.aborted) throw abortReason(signal);

    let { body, type } = await extractBody(input, init);
    if (type && !headers.has("content-type")) headers.set("content-type", type);

    const state = { req: null, rejectHead: null, bodyError: null, done: () => {} };
    let onAbort = null;
    if (signal) {
      onAbort = () => {
        const reason = abortReason(signal);
        if (state.rejectHead) state.rejectHead(reason);
        else if (state.bodyError) state.bodyError(reason);
        if (state.req) state.req.destroy();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      state.done = () => signal.removeEventListener("abort", onAbort);
    }

    let redirects = 0;
    try {
      for (;;) {
        if (signal && signal.aborted) throw abortReason(signal);
        let res;
        try {
          res = await exchange(state, u, method, headers, body);
        } catch (err) {
          if (signal && signal.aborted) throw abortReason(signal);
          throw err instanceof TypeError && err.message === "fetch failed" ? err : fetchFailed(err);
        }
        const status = res.statusCode;
        const location = res.headers.location;
        if (!REDIRECT_STATUSES.has(status) || location === undefined || redirectMode === "manual") {
          try {
            return buildResponse(state, state.req, res, method, u, redirects > 0);
          } catch (err) {
            state.req.destroy();
            throw fetchFailed(err);
          }
        }
        res.resume();
        state.req.destroy();
        if (redirectMode === "error") throw networkError("unexpected redirect");
        let next;
        try {
          next = new URL(location, u);
        } catch {
          throw networkError("invalid redirect location");
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          throw networkError("URL scheme must be a HTTP(S) scheme");
        }
        if (redirects === MAX_REDIRECTS) throw networkError("redirect count exceeded");
        redirects++;
        if (status !== 303 && body && body.stream) {
          throw networkError("cannot follow a redirect with a streamed request body");
        }
        if (((status === 301 || status === 302) && method === "POST") || (status === 303 && method !== "GET" && method !== "HEAD")) {
          method = "GET";
          body = null;
          for (const h of REQUEST_BODY_HEADERS) headers.delete(h);
        }
        if (next.origin !== u.origin) for (const h of CROSS_ORIGIN_STRIP) headers.delete(h);
        next.hash = "";
        u = next;
        const where = route(u.href);
        if (where === "tls") throw tlsError(u);
        if (where !== "loopback") {
          // The redirect left the VM: the rest of the chain is the host's.
          state.done();
          const r = await viaHost(u.href, {
            method,
            headers,
            body: body ? body.bytes : undefined,
            redirect: redirectMode,
            signal: signal || undefined,
          });
          Object.defineProperty(r, "redirected", { value: true, configurable: true });
          return r;
        }
      }
    } catch (err) {
      state.done();
      throw err;
    }
  }

  module.exports = { route, fetch: loopbackFetch };
}