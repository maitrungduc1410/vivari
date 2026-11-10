// internal/tls-http-egress: a `tls.connect()` socket that speaks HTTP/1.1 over fetch.
//
// There is no TLS here and no raw socket to the outside, so a client that dials a
// registry itself (undici, which pnpm 11 bundles, calls `tls.connect` and writes
// HTTP/1.1 into the socket) used to die on ERR_METHOD_NOT_IMPLEMENTED. npm never
// hit this because it goes through `https.request`, which is already fetch-backed.
//
// This socket is the other end of that conversation. It reads the request bytes
// the client writes (request line, headers, a Content-Length or chunked body),
// sends each request through internal/fetch-transport (the same transport
// `https.request` uses, so the kernel cache, the registry header policy and the
// mixed-content rules are the ones npm already gets) and writes an HTTP/1.1
// response back for the client's own parser to read.
//
// What it is not:
//   • a TLS implementation. Certificates, sessions and ciphers are reported as
//     absent; the browser's fetch did the real TLS.
//   • a general tunnel. If the first bytes written are not an HTTP/1.x request
//     line, the socket is destroyed with ERR_VIVARI_TLS_NOT_HTTP rather than
//     pretending: a Postgres or SMTP client would otherwise wait forever.
//   • HTTP/2. The connection reports ALPN `http/1.1` whatever was offered, which
//     is the answer a server that only speaks 1.1 gives.
//
// Requests on one connection are answered strictly in order (keep-alive and
// pipelining both work, because each response is written only after the
// previous one). The response body goes out chunked, with Content-Encoding and
// Content-Length dropped: fetch already decoded the body, so the original values
// describe bytes the client will never see.
export default function (exports, require, module, process) {
  "use strict";
  const { Duplex } = require("stream");
  const { Buffer } = require("buffer");
  const { createFetchClient } = require("internal/fetch-transport");

  const clients = new Map();
  function clientFor(protocol) {
    let c = clients.get(protocol);
    if (!c) {
      c = createFetchClient({ protocol, defaultPort: protocol === "http:" ? 80 : 443, encrypted: protocol === "https:" });
      clients.set(protocol, c);
    }
    return c;
  }

  const REQUEST_LINE = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/;
  const CRLF2 = Buffer.from("\r\n\r\n");
  // Response headers that describe the wire form fetch already undid, or that we
  // set ourselves.
  const DROP_RESPONSE = new Set(["content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive"]);

  function notHttp(host) {
    const err = new Error(
      "Vivari: tls.connect to " + host + " is only supported for HTTP/1.1 clients. " +
        "There is no raw TLS socket in a browser tab; HTTP requests written into the socket are " +
        "answered through fetch, anything else cannot be carried.",
    );
    err.code = "ERR_VIVARI_TLS_NOT_HTTP";
    return err;
  }

  function malformed(why) {
    const err = new Error("Vivari: malformed HTTP request written to an egress socket (" + why + ")");
    err.code = "ERR_VIVARI_TLS_NOT_HTTP";
    return err;
  }

  class HttpEgressSocket extends Duplex {
    constructor({ host, port, protocol, servername }) {
      super({ allowHalfOpen: false });
      this._host = host;
      this._port = port;
      this._protocol = protocol;
      this._buf = Buffer.alloc(0);
      this._req = null; // request being parsed past its head
      this._queue = []; // complete requests waiting for their turn
      this._busy = false;
      this._ended = false;
      this.encrypted = protocol === "https:";
      this.authorized = true;
      this.authorizationError = null;
      this.alpnProtocol = "http/1.1";
      this.servername = servername || host;
      this.remoteAddress = host;
      this.remotePort = port;
      this.remoteFamily = "IPv4";
      this.localAddress = "127.0.0.1";
      this.localPort = 0;
      this.connecting = true;
      this.pending = true;
      process.nextTick(() => {
        if (this.destroyed) return;
        this.connecting = false;
        this.pending = false;
        this.emit("connect");
        if (this.encrypted) this.emit("secureConnect");
        this.emit("ready");
      });
    }

    // ── net.Socket / tls.TLSSocket surface ─────────────────────────────────
    setKeepAlive() { return this; }
    setNoDelay() { return this; }
    setTimeout(ms, cb) {
      if (typeof cb === "function") {
        if (ms) this.once("timeout", cb);
        else this.removeListener("timeout", cb);
      }
      return this;
    }
    ref() { return this; }
    unref() { return this; }
    address() { return { address: this.localAddress, port: this.localPort, family: "IPv4" }; }
    get readyState() {
      if (this.connecting) return "opening";
      return this.destroyed ? "closed" : "open";
    }
    getPeerCertificate() { return {}; }
    getCertificate() { return null; }
    getCipher() { return {}; }
    getProtocol() { return this.encrypted ? "TLSv1.3" : null; }
    getSession() { return undefined; }
    isSessionReused() { return false; }
    setServername() {}
    setSession() {}

    _read() {}

    _write(chunk, enc, cb) {
      this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : Buffer.from(chunk);
      try {
        this._parse();
      } catch (e) {
        cb(e);
        return;
      }
      cb();
    }

    _final(cb) {
      this._ended = true;
      this._maybeFinish();
      cb();
    }

    _destroy(err, cb) {
      this._queue.length = 0;
      if (this._inflight) this._inflight.destroy();
      cb(err);
    }

    // ── request side: bytes in, requests out ───────────────────────────────
    _parse() {
      for (;;) {
        if (!this._req) {
          const end = this._buf.indexOf(CRLF2);
          if (end < 0) {
            // A request line is short; a long run of bytes with no line break is
            // not an HTTP client.
            const lead = this._buf.toString("latin1", 0, Math.min(this._buf.length, 16));
            if (this._buf.length > 64 * 1024 || !(/^[A-Z]+ /.test(lead) || /^[A-Z]*$/.test(lead))) {
              throw notHttp(this._host);
            }
            return;
          }
          const lines = this._buf.toString("latin1", 0, end).split("\r\n");
          this._buf = this._buf.subarray(end + 4);
          const m = REQUEST_LINE.exec(lines[0]);
          if (!m) throw notHttp(this._host);
          const headers = [];
          let length = 0;
          let chunked = false;
          let close = false;
          for (let i = 1; i < lines.length; i++) {
            const c = lines[i].indexOf(":");
            if (c <= 0) throw malformed("header line without a colon");
            const name = lines[i].slice(0, c).trim();
            const value = lines[i].slice(c + 1).trim();
            const lower = name.toLowerCase();
            if (lower === "content-length") length = Number(value);
            else if (lower === "transfer-encoding") chunked = /chunked/i.test(value);
            else if (lower === "connection") close = /close/i.test(value);
            headers.push(name, value);
          }
          if (!chunked && !(length >= 0 && Number.isFinite(length))) throw malformed("bad content-length");
          this._req = { method: m[1], target: m[2], headers, close, chunked, remaining: chunked ? -1 : length, body: [] };
        }
        const r = this._req;
        if (r.chunked) {
          // [size-hex][;ext]\r\n data \r\n ... 0\r\n [trailers] \r\n
          if (r.remaining > 0) {
            if (this._buf.length < r.remaining + 2) return;
            r.body.push(this._buf.subarray(0, r.remaining));
            this._buf = this._buf.subarray(r.remaining + 2);
            r.remaining = -1;
          }
          if (r.remaining === -1) {
            const nl = this._buf.indexOf("\r\n");
            if (nl < 0) return;
            const size = parseInt(this._buf.toString("latin1", 0, nl).split(";")[0], 16);
            if (!(size >= 0)) throw malformed("bad chunk size");
            this._buf = this._buf.subarray(nl + 2);
            if (size > 0) {
              r.remaining = size;
              continue;
            }
            r.remaining = -2; // last chunk seen: skip trailers to the blank line
          }
          if (r.remaining === -2) {
            const nl = this._buf.indexOf("\r\n");
            if (nl < 0) return;
            this._buf = this._buf.subarray(nl + 2);
            if (nl > 0) continue; // a trailer line; keep skipping
          }
        } else if (r.remaining > 0) {
          if (this._buf.length < r.remaining) {
            r.body.push(this._buf);
            r.remaining -= this._buf.length;
            this._buf = Buffer.alloc(0);
            return;
          }
          r.body.push(this._buf.subarray(0, r.remaining));
          this._buf = this._buf.subarray(r.remaining);
          r.remaining = 0;
        }
        this._req = null;
        this._queue.push(r);
        this._pump();
      }
    }

    // ── response side: one request at a time, in order ─────────────────────
    _pump() {
      if (this._busy || this.destroyed) return;
      const r = this._queue.shift();
      if (!r) {
        this._maybeFinish();
        return;
      }
      this._busy = true;
      const headers = [];
      for (let i = 0; i < r.headers.length; i += 2) headers.push([r.headers[i], r.headers[i + 1]]);
      const req = clientFor(this._protocol).request({
        protocol: this._protocol,
        hostname: this._host,
        port: this._port,
        path: r.target,
        method: r.method,
        headers,
      });
      this._inflight = req;
      req.on("error", (e) => {
        if (this._inflight !== req) return;
        this._inflight = null;
        this.destroy(e);
      });
      req.on("response", (res) => this._respond(r, res));
      for (const b of r.body) req.write(b);
      req.end();
    }

    _respond(r, res) {
      const status = res.statusCode | 0;
      const noBody = r.method === "HEAD" || status === 204 || status === 304 || (status >= 100 && status < 200);
      let head = "HTTP/1.1 " + status + " " + (res.statusMessage || "") + "\r\n";
      const h = res.headers || {};
      for (const k of Object.keys(h)) {
        if (DROP_RESPONSE.has(k.toLowerCase())) continue;
        const v = h[k];
        for (const one of Array.isArray(v) ? v : [v]) head += k + ": " + String(one).replace(/[\r\n]+/g, " ") + "\r\n";
      }
      head += "connection: " + (r.close ? "close" : "keep-alive") + "\r\n";
      // The kernel strips Content-Length from every fetched response (the body is
      // decoded), so a HEAD answer cannot report the size; https.request has the
      // same limit.
      if (!noBody) head += "transfer-encoding: chunked\r\n";
      this.push(Buffer.from(head + "\r\n", "latin1"));
      res.on("data", (chunk) => {
        if (noBody || !chunk.length || this.destroyed) return;
        this.push(Buffer.from(chunk.length.toString(16) + "\r\n", "latin1"));
        this.push(chunk);
        this.push(Buffer.from("\r\n", "latin1"));
      });
      res.on("end", () => {
        if (this.destroyed) return;
        if (!noBody) this.push(Buffer.from("0\r\n\r\n", "latin1"));
        this._inflight = null;
        this._busy = false;
        if (r.close) {
          this._queue.length = 0;
          this.push(null);
          return;
        }
        this._pump();
      });
    }

    _maybeFinish() {
      if (this._ended && !this._busy && this._queue.length === 0 && !this.readableEnded) this.push(null);
    }
  }

  // tls.connect(options[, cb]) | (port[, host][, options][, cb])
  function normalizeConnectArgs(args) {
    let options = {};
    let cb;
    const a = Array.from(args);
    if (typeof a[a.length - 1] === "function") cb = a.pop();
    if (a[0] !== null && typeof a[0] === "object") options = Object.assign({}, a[0]);
    else {
      if (a[0] != null) options.port = a[0];
      if (typeof a[1] === "string") options.host = a[1];
      if (a[2] && typeof a[2] === "object") options = Object.assign({}, a[2], options);
      else if (a[1] && typeof a[1] === "object") options = Object.assign({}, a[1], options);
    }
    return { options, cb };
  }

  module.exports = { HttpEgressSocket, normalizeConnectArgs };
}
