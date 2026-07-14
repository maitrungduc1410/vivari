// https — a fetch-backed client (package-managers phase 1).
//
// Real TLS/sockets don't exist in-VM, so instead of a socket-level https we
// implement https.request/get on top of the Fetcher Worker (globalThis.__ocfetch,
// the same blocking egress the kernel services). This is enough for the real npm
// (npm-registry-fetch -> make-fetch-happen -> minipass-fetch), which drives a
// standard http.ClientRequest and reads a standard http.IncomingMessage.
//
// The request is buffered, sent as one fetch (method + headers + body), and the
// response is delivered as a Readable with statusCode/headers, streaming the body
// the Fetcher Worker materialized in the VFS. Redirects are followed by the
// fetcher, so callers see the final response. There is no in-VM https *server*.
export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";
  const { Readable, Writable } = require("stream");
  const EventEmitter = require("events");
  const { Buffer } = require("buffer");
  const fs = require("fs");
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

  function buildUrl(opts) {
    const protocol = opts.protocol || "https:";
    const rawHost = opts.hostname || opts.host || "localhost";
    const hostname = String(rawHost).replace(/:\d+$/, "");
    const dflt = protocol === "http:" ? "80" : "443";
    const port = opts.port != null && String(opts.port) !== "" ? String(opts.port) : dflt;
    const path = opts.path || "/";
    const authority = port === dflt ? hostname : hostname + ":" + port;
    return protocol + "//" + authority + (path[0] === "/" ? path : "/" + path);
  }

  class ClientRequest extends Writable {
    constructor(opts, cb) {
      // autoDestroy:false — a Writable auto-destroys after 'finish' (which end()
      // emits), and our destroy() marks the request aborted. Without this, every
      // request "aborts" itself the moment its body is flushed, before dispatch.
      super({ autoDestroy: false });
      this.method = String(opts.method || "GET").toUpperCase();
      this._url = buildUrl(opts);
      this._headers = Object.create(null);
      this._chunks = [];
      this._sent = false;
      this.aborted = false;
      this.reusedSocket = false;
      this.path = opts.path || "/";
      this.host = opts.hostname || opts.host || "localhost";
      if (opts.headers) for (const k of Object.keys(opts.headers)) this.setHeader(k, opts.headers[k]);
      if (opts.auth) this.setHeader("authorization", "Basic " + Buffer.from(String(opts.auth)).toString("base64"));
      if (cb) this.once("response", cb);
      // Some clients attach timeout/error handling on the 'socket' event. Give
      // them a benign, already-"connected" dummy socket on the next tick.
      this._socket = makeDummySocket();
      this.socket = this.connection = this._socket;
      process.nextTick(() => {
        if (!this.aborted) this.emit("socket", this._socket);
      });
    }

    setHeader(name, value) {
      const k = String(name).toLowerCase();
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
        const body = this._chunks.length ? Buffer.concat(this._chunks) : null;
        const init = {
          method: this.method,
          headers: this._headers,
          bodyB64: body && body.length ? toB64(body) : null,
        };
        const onError = (e) => {
          if (this.aborted) return;
          const err = new Error("request to " + this._url + " failed: " + ((e && e.message) || e));
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
        } else {
          let meta;
          try {
            meta = globalThis.__ocfetch(this._url, init);
          } catch (e) {
            onError(e);
            return;
          }
          this._deliver(meta);
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
          bytes = fs.readFileSync(meta.path);
        } catch {
          /* empty body */
        }
        if (bytes && bytes.length) res.push(Buffer.from(bytes));
        res.complete = true;
        res.push(null);
      });
    }
  }

  function rawHeaders(headers) {
    const out = [];
    for (const k of Object.keys(headers)) out.push(k, String(headers[k]));
    return out;
  }

  function makeDummySocket() {
    const s = new EventEmitter();
    s.remoteAddress = "127.0.0.1";
    s.remotePort = 443;
    s.remoteFamily = "IPv4";
    s.encrypted = true;
    s.authorized = true;
    s.setTimeout = () => s;
    s.setKeepAlive = () => s;
    s.setNoDelay = () => s;
    s.ref = () => s;
    s.unref = () => s;
    s.destroy = () => s;
    s.end = () => s;
    return s;
  }

  function request(url, options, cb) {
    return new ClientRequest(...normalizeToCtor(url, options, cb));
  }
  function normalizeToCtor(url, options, cb) {
    const { opts, cb: callback } = parseArgs(url, options, cb);
    return [opts, callback];
  }
  function get(url, options, cb) {
    const req = request(url, options, cb);
    req.end();
    return req;
  }

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
      return makeDummySocket();
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
    const err = new Error("OpenContainer: in-VM https servers are not supported");
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
