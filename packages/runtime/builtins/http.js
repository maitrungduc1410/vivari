// A minimal `http` builtin — enough to run `http.createServer(fn).listen(port)`
// against OpenContainer's virtual network (brick 5).
//
// The model is a *synchronous, one-request-at-a-time* server: `listen()` only
// registers the port with the kernel (OP_LISTEN) and returns immediately; the
// actual serving happens in the runtime's accept loop (see index.js `run`),
// which blocks on the kernel for the next request, dispatches it here, and sends
// the response back. This maps a blocking accept loop onto the same sync bridge
// as every other syscall.
//
// Limitations (Path A PoC; the real thing arrives with Node's own `http` on the
// internalBinding layer): request handlers must finish synchronously (call
// res.end() before returning); no streaming request bodies, keep-alive, or
// concurrent in-flight requests per server; timers do not fire while the loop is
// parked in accept.

const STATUS_CODES = {
  200: "OK",
  201: "Created",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

const METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE", "CONNECT"];

export function createHttp({ syscalls, servers, enqueueTask, EventEmitter, Buffer }) {
  class IncomingMessage extends EventEmitter {
    constructor(ev) {
      super();
      const r = (ev && ev.req) || {};
      this.method = r.method || "GET";
      this.url = r.url || "/";
      this.headers = r.headers || {};
      this.httpVersion = "1.1";
      this.httpVersionMajor = 1;
      this.httpVersionMinor = 1;
      this.socket = { remoteAddress: "127.0.0.1", remotePort: 0 };
      this._body = r.body || "";
    }
    setEncoding() {}
    // Best-effort readable surface: deliver the (already buffered) body on the
    // next tick so `req.on('data')/on('end')` handlers registered synchronously
    // still fire before the accept loop reads the response.
    _drain() {
      if (this._body) this.emit("data", Buffer.from(this._body));
      this.emit("end");
    }
    resume() {}
    pause() {}
  }

  class ServerResponse extends EventEmitter {
    constructor() {
      super();
      this.statusCode = 200;
      this.statusMessage = "";
      this.headersSent = false;
      this.finished = false;
      this._headers = {};
      this._body = "";
    }
    setHeader(name, value) {
      this._headers[String(name).toLowerCase()] = value;
      return this;
    }
    getHeader(name) {
      return this._headers[String(name).toLowerCase()];
    }
    removeHeader(name) {
      delete this._headers[String(name).toLowerCase()];
    }
    writeHead(statusCode, reasonOrHeaders, maybeHeaders) {
      this.statusCode = statusCode;
      const headers =
        reasonOrHeaders && typeof reasonOrHeaders === "object" ? reasonOrHeaders : maybeHeaders;
      if (headers) for (const k of Object.keys(headers)) this.setHeader(k, headers[k]);
      this.headersSent = true;
      return this;
    }
    write(chunk) {
      if (chunk != null) {
        this._body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      }
      return true;
    }
    end(chunk) {
      if (chunk != null) this.write(chunk);
      this.finished = true;
      this.emit("finish");
      this.emit("close");
    }
  }

  class Server extends EventEmitter {
    constructor(handler) {
      super();
      this.listening = false;
      if (typeof handler === "function") this.on("request", handler);
    }
    listen(port, ...rest) {
      const cb = rest.find((a) => typeof a === "function");
      syscalls.listen(port | 0);
      servers.set(port | 0, this);
      this.listening = true;
      this._port = port | 0;
      if (cb) enqueueTask(cb);
      enqueueTask(() => this.emit("listening"));
      return this;
    }
    address() {
      return { port: this._port ?? null, family: "IPv4", address: "127.0.0.1" };
    }
    close(cb) {
      if (this._port != null && servers.get(this._port) === this) {
        servers.delete(this._port);
        try {
          syscalls.closeServer(this._port);
        } catch {
          /* ignore */
        }
      }
      this.listening = false;
      if (cb) enqueueTask(cb);
      enqueueTask(() => this.emit("close"));
      return this;
    }
  }

  function createServer(arg1, arg2) {
    // createServer([options,] [requestListener])
    const handler = typeof arg1 === "function" ? arg1 : arg2;
    return new Server(handler);
  }

  // Called by the runtime's accept loop for each inbound request. Builds the
  // req/res pair, drives the handler synchronously, and returns the response.
  function _dispatch(ev) {
    const server = servers.get(ev.port);
    if (!server) {
      return { status: 502, headers: { "content-type": "text/plain" }, body: "No server\n" };
    }
    const req = new IncomingMessage(ev);
    const res = new ServerResponse();
    try {
      server.emit("request", req, res);
      req._drain(); // let any data/end listeners run (handler was synchronous)
    } catch (err) {
      if (!res.finished) {
        res.statusCode = 500;
        res.setHeader("content-type", "text/plain");
        res.end("Internal Server Error\n");
      }
    }
    return { status: res.statusCode, headers: res._headers, body: res._body };
  }

  return {
    createServer,
    Server,
    ServerResponse,
    IncomingMessage,
    STATUS_CODES,
    METHODS,
    globalAgent: {},
    _dispatch,
  };
}
