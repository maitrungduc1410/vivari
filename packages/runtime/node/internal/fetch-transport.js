// internal/fetch-transport — the fetch-backed HTTP client transport.
//
// There are no real sockets in-VM, so a request to a destination the virtual
// network cannot serve has to ride the Fetcher Worker (globalThis.__ocfetch /
// __ocfetchAsync, the same blocking egress the kernel services). This module is
// that transport, extracted from lib/https.js so `http` and `https` share ONE
// implementation instead of growing a second copy of it:
//
//   • lib/https.js               — every https request (there are no in-VM TLS
//                                  sockets, so egress is unconditional).
//   • internal/http-egress.js    — only those http requests whose destination
//                                  the loopback `net` cannot serve; loopback
//                                  http keeps going through the real net path.
//
// The request is buffered, sent as one fetch (method + headers + body), and the
// response is delivered as a standard http.IncomingMessage-shaped Readable with
// statusCode/headers, streaming the body the Fetcher Worker materialized in the
// VFS. Redirects are followed by the fetcher, so callers see the final response.
// This is what carries the real npm (npm-registry-fetch -> make-fetch-happen ->
// minipass-fetch), which drives a ClientRequest and reads an IncomingMessage.
export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";
  const { Readable, Writable } = require("stream");
  const EventEmitter = require("events");
  const { Buffer } = require("buffer");

  // `fs` is loaded lazily. This module is pulled in when `http` loads (for the
  // egress seam) and only a *delivered response body* ever touches the VFS, so
  // requiring it eagerly would add a load-time edge to `http` that never existed.
  let fsMod = null;
  const getFs = () => (fsMod ??= require("fs"));

  let STATUS = null;
  const statusText = (code) => {
    if (!STATUS) {
      try {
        STATUS = require("http").STATUS_CODES;
      } catch {
        STATUS = {};
      }
    }
    return STATUS[code] || "";
  };

  // Headers fetch() manages itself / forbids a caller from setting. We drop
  // accept-encoding too so the fetch layer negotiates + decodes transfer
  // compression and hands us a plain body (the kernel also strips the hint).
  const FORBIDDEN = new Set([
    "host", "connection", "content-length", "transfer-encoding",
    "accept-encoding", "keep-alive", "upgrade", "proxy-connection",
  ]);

  const toB64 = (buf) => buf.toString("base64");

  function urlToOptions(u) {
    const opts = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port,
      path: (u.pathname || "/") + (u.search || ""),
    };
    if (u.username) {
      opts.auth = decodeURIComponent(u.username) + ":" + decodeURIComponent(u.password || "");
    }
    return opts;
  }

  // Node's (url[, options][, cb]) | (options[, cb]) argument shapes.
  function parseArgs(url, options, cb) {
    let opts = {};
    if (typeof url === "string") {
      opts = urlToOptions(new URL(url));
    } else if (url && (typeof url.href === "string" || url instanceof URL)) {
      opts = urlToOptions(url instanceof URL ? url : new URL(url.href));
    } else {
      // first arg is the options object
      cb = options;
      options = url;
    }
    if (typeof options === "function") {
      cb = options;
      options = null;
    }
    if (options && typeof options === "object") opts = Object.assign(opts, options);
    return { opts, cb };
  }

  // The hostname as the caller asked for it, unwrapped to the bare host: `[::1]:80`,
  // `::1`, `example.com:80` and `example.com` all name a destination, and the routing
  // predicate has to see the same string whichever spelling arrives. Note that
  // naively stripping /:\d+$/ (as this did while it only served https, where every
  // destination is a registry hostname) turns the IPv6 literal `::1` into `:`.
  function hostOf(opts) {
    const h = String(opts.hostname || opts.host || "localhost");
    // The bracketed form is unambiguous: `[host]` or `[host]:port`.
    const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(h);
    if (bracketed) return bracketed[1];
    // More than one colon means a bare IPv6 literal, which has no port suffix to
    // strip. One colon (or none) is host[:port].
    if (h.indexOf(":") !== h.lastIndexOf(":")) return h;
    return h.replace(/:\d+$/, "");
  }

  function buildUrl(opts, dfltProtocol) {
    const protocol = opts.protocol || dfltProtocol;
    const hostname = hostOf(opts);
    const dflt = protocol === "http:" ? "80" : "443";
    const port = opts.port != null && String(opts.port) !== "" ? String(opts.port) : dflt;
    const path = opts.path || "/";
    // An IPv6 literal has to go back into the URL bracketed.
    const authority = (hostname.includes(":") ? "[" + hostname + "]" : hostname) + (port === dflt ? "" : ":" + port);
    return protocol + "//" + authority + (path[0] === "/" ? path : "/" + path);
  }

  // `options.headers` is a plain object OR a raw list — either flat
  // ['a', '1', 'b', '2'] or pairs [['a', '1'], ['b', '2']] (_http_client.js:354
  // hands the array straight to _storeHeader). Object.keys() on an array yields
  // its INDICES, so a raw list has to be walked as one or the request goes out
  // with headers named "0", "1", "2".
  function eachHeader(headers, set) {
    if (!headers) return;
    if (Array.isArray(headers)) {
      if (headers.length && Array.isArray(headers[0])) {
        for (const pair of headers) if (pair && pair.length) set(pair[0], pair[1]);
      } else {
        for (let i = 0; i + 1 < headers.length; i += 2) set(headers[i], headers[i + 1]);
      }
      return;
    }
    for (const k of Object.keys(headers)) set(k, headers[k]);
  }

  function rawHeaders(headers) {
    const out = [];
    for (const k of Object.keys(headers)) out.push(k, String(headers[k]));
    return out;
  }

  function makeDummySocket(port, encrypted) {
    const s = new EventEmitter();
    s.remoteAddress = "127.0.0.1";
    s.remotePort = port;
    s.remoteFamily = "IPv4";
    s.encrypted = !!encrypted;
    if (encrypted) s.authorized = true;
    s.setTimeout = () => s;
    s.setKeepAlive = () => s;
    s.setNoDelay = () => s;
    s.ref = () => s;
    s.unref = () => s;
    s.destroy = () => s;
    s.end = () => s;
    return s;
  }

  // A fetch cannot carry a protocol upgrade: there is no socket to hand back, so
  // an 'upgrade' event can never fire and the caller (ws, a CONNECT tunnel) would
  // wait forever on a request that "succeeded". Fail loudly instead — a hang with
  // no error is the one outcome worse than an unsupported-feature error.
  function upgradeError(url, what) {
    const err = new Error(
      "Vivari: " + what + " cannot use the fetch-backed egress (" + url + "). " +
        "The Fetcher Worker performs one request/response fetch; there is no socket to upgrade. " +
        "Only an in-VM server (loopback) can be reached with a real socket.",
    );
    err.code = "ERR_VIVARI_UPGRADE_UNSUPPORTED";
    return err;
  }

  // Plain http:// egress additionally depends on the browser's mixed-content
  // rules, which we cannot probe ahead of the request — so name the constraint
  // in the failure rather than leaving a bare ECONNREFUSED.
  const MIXED_CONTENT_HINT =
    " (plain http:// egress rides the browser's fetch: a studio served over https:// may only fetch " +
    "http:// URLs whose host is potentially trustworthy — localhost / 127.0.0.0/8 / ::1 — so a LAN or " +
    "public http:// host is blocked as mixed content. Use https://, or address the host machine as " +
    "http://host.vivari.internal:<port>/ from a locally served studio.)";

  /**
   * Build the client half of a protocol (request/get/ClientRequest) on top of the
   * Fetcher Worker. `protocol` is the scheme assumed when the caller passes bare
   * options; `defaultPort`/`encrypted` only shape the stand-in socket.
   */
  function createFetchClient({ protocol: dfltProtocol, defaultPort, encrypted }) {
    class ClientRequest extends Writable {
      constructor(opts, cb) {
        // autoDestroy:false — a Writable auto-destroys after 'finish' (which end()
        // emits), and our destroy() marks the request aborted. Without this, every
        // request "aborts" itself the moment its body is flushed, before dispatch.
        super({ autoDestroy: false });
        this.method = String(opts.method || "GET").toUpperCase();
        this._url = buildUrl(opts, dfltProtocol);
        this._headers = Object.create(null);
        this._chunks = [];
        this._sent = false;
        this.aborted = false;
        this.reusedSocket = false;
        this.path = opts.path || "/";
        this.host = opts.hostname || opts.host || "localhost";
        this.protocol = opts.protocol || dfltProtocol;
        // A protocol upgrade this transport cannot honour. Recorded rather than
        // rejected here because 'upgrade'/'connection' are FORBIDDEN headers the
        // setter drops; _dispatch turns it into an error the caller can see.
        this._upgrade = this.method === "CONNECT" ? "a CONNECT tunnel" : null;
        eachHeader(opts.headers, (k, v) => this.setHeader(k, v));
        if (opts.auth) this.setHeader("authorization", "Basic " + Buffer.from(String(opts.auth)).toString("base64"));
        if (cb) this.once("response", cb);
        // Some clients attach timeout/error handling on the 'socket' event. Give
        // them a benign, already-"connected" dummy socket on the next tick.
        this._socket = makeDummySocket(defaultPort, encrypted);
        this.socket = this.connection = this._socket;
        process.nextTick(() => {
          if (!this.aborted) this.emit("socket", this._socket);
        });
      }

      setHeader(name, value) {
        const k = String(name).toLowerCase();
        if (k === "upgrade" || (k === "connection" && /upgrade/i.test(String(value)))) {
          this._upgrade = "a protocol upgrade";
        }
        if (!FORBIDDEN.has(k)) this._headers[k] = value;
        return this;
      }
      getHeader(name) {
        return this._headers[String(name).toLowerCase()];
      }
      removeHeader(name) {
        delete this._headers[String(name).toLowerCase()];
      }
      getHeaders() {
        return Object.assign(Object.create(null), this._headers);
      }
      hasHeader(name) {
        return String(name).toLowerCase() in this._headers;
      }
      flushHeaders() {}
      setNoDelay() {}
      setSocketKeepAlive() {}
      setTimeout(_ms, cb) {
        if (typeof cb === "function") this.once("timeout", cb);
        return this;
      }

      _write(chunk, enc, cb) {
        this._chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc));
        cb();
      }

      end(chunk, enc, cb) {
        if (typeof chunk === "function") {
          cb = chunk;
          chunk = null;
        } else if (typeof enc === "function") {
          cb = enc;
          enc = null;
        }
        if (chunk != null) this._chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc));
        super.end(cb);
        this._dispatch();
        return this;
      }

      abort() {
        this.destroy();
      }
      destroy(err) {
        if (this.aborted) return this;
        this.aborted = true;
        if (err) process.nextTick(() => this.emit("error", err));
        process.nextTick(() => this.emit("close"));
        return this;
      }

      _dispatch() {
        if (this._sent) return;
        this._sent = true;
        process.nextTick(() => {
          if (this.aborted) return;
          if (this._upgrade) {
            this.emit("error", upgradeError(this._url, this._upgrade));
            return;
          }
          const body = this._chunks.length ? Buffer.concat(this._chunks) : null;
          const init = {
            method: this.method,
            headers: this._headers,
            bodyB64: body && body.length ? toB64(body) : null,
          };
          const onError = (e) => {
            if (this.aborted) return;
            const hint = this._url.startsWith("http://") ? MIXED_CONTENT_HINT : "";
            const err = new Error("request to " + this._url + " failed: " + ((e && e.message) || e) + hint);
            err.code = (e && e.code) || "ECONNREFUSED";
            this.emit("error", err);
          };
          // Prefer the non-blocking async egress so a single process (e.g. npm) can
          // keep many registry requests in flight at once — the blocking __ocfetch
          // path would park the whole worker on each request, serializing all
          // downloads. Fall back to the blocking primitive if the async global is
          // unavailable (older/host runtimes), preserving the previous behavior.
          const asyncFetch = globalThis.__ocfetchAsync;
          if (typeof asyncFetch === "function") {
            asyncFetch(this._url, init).then((meta) => this._deliver(meta), onError);
          } else if (typeof globalThis.__ocfetch === "function") {
            let meta;
            try {
              meta = globalThis.__ocfetch(this._url, init);
            } catch (e) {
              onError(e);
              return;
            }
            this._deliver(meta);
          } else {
            // No Fetcher Worker at all (a bare runtime with no kernel egress).
            const err = new Error("request to " + this._url + " failed: no outbound network in this runtime");
            err.code = "ENETUNREACH";
            this.emit("error", err);
          }
        });
      }

      // Build the http.IncomingMessage from the fetch metadata and stream the body
      // (materialized by the kernel in the VFS at meta.path) into it. Shared by the
      // async and blocking dispatch paths above.
      _deliver(meta) {
        if (this.aborted) return;

        const res = new Readable({ read() {} });
        res.statusCode = meta.status | 0;
        res.statusMessage = meta.statusText || statusText(res.statusCode);
        res.headers = meta.headers || {};
        res.rawHeaders = rawHeaders(res.headers);
        res.trailers = {};
        res.rawTrailers = [];
        res.httpVersion = "1.1";
        res.httpVersionMajor = 1;
        res.httpVersionMinor = 1;
        res.complete = false;
        res.url = this._url;
        res.method = this.method;
        res.req = this;
        res.socket = res.connection = this._socket;
        res.setTimeout = (_ms, fn) => {
          if (typeof fn === "function") res.once("timeout", fn);
          return res;
        };

        this.emit("response", res);

        // Push the body a tick later so the consumer's 'data' listeners (attached
        // synchronously inside the 'response' handler) are in place.
        process.nextTick(() => {
          if (this.aborted) {
            res.destroy();
            return;
          }
          let bytes = null;
          try {
            bytes = getFs().readFileSync(meta.path);
          } catch {
            /* empty body */
          }
          if (bytes && bytes.length) res.push(Buffer.from(bytes));
          res.complete = true;
          res.push(null);
        });
      }
    }

    function request(url, options, cb) {
      const { opts, cb: callback } = parseArgs(url, options, cb);
      return new ClientRequest(opts, callback);
    }
    function get(url, options, cb) {
      const req = request(url, options, cb);
      req.end();
      return req;
    }

    return { ClientRequest, request, get };
  }

  module.exports = {
    createFetchClient,
    // Shared with lib/https.js's no-op Agent and internal/http-egress.js's router.
    makeDummySocket,
    parseArgs,
    hostOf,
    buildUrl,
  };
}