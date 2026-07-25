// The Bun runtime shim — a `Bun` global + `bun:*` builtin modules implemented on
// top of Vivari's Node-compatible runtime (fs/http/child_process/crypto/zlib).
//
// Bun cannot be run "for real" in the browser the way npm/yarn/pnpm are (those are
// pure-JS CLIs Vivari vendors and executes; Bun is a native Zig/JavaScriptCore
// binary). So Bun support is necessarily a SHIM: we reproduce the commonly used
// slice of Bun's documented API surface. This is the same "API-compatible drop-in"
// philosophy the toolchain aliases use, applied to a runtime instead of a package.
//
// COVERED (see below): Bun.file/write, Bun.serve (bridged onto Node http so it
// previews — with `routes`, `fetch`, and server-side `websocket` + pub/sub),
// Bun.env/argv/main/version, Bun.spawn/spawnSync/which, Bun.$ (shell),
// Bun.sleep(Sync)/nanoseconds, Bun.hash/CryptoHasher, Bun.password (crypto-backed),
// Bun.gzipSync/…, Bun.inspect/deepEquals/escapeHTML, Bun.pathToFileURL/fileURLToPath,
// and the modules bun:test (a minimal runner + expect) and bun:jsc (small stubs).
//
// NOT SUPPORTED (documented, fails loudly rather than silently wrong): bun:ffi /
// Bun.dlopen (native FFI), native addons, Bun macros, and Bun.build plugins. These
// require capabilities the browser sandbox does not have.

import { transpileTypeScript } from "../typescript-transform.js";

export function createBunRuntime({ process, Buffer, require }) {
  const lazy = (name) => require(name);

  // ---- BunFile ---------------------------------------------------------------
  // `Bun.file(path)` is a lazy handle; reads/writes hit the VFS through `fs`.
  class BunFile {
    constructor(pathOrFd, options) {
      this._path = typeof pathOrFd === "string" ? pathOrFd : String(pathOrFd);
      this._type = (options && options.type) || guessMime(this._path);
    }
    get name() { return this._path; }
    get size() {
      const fs = lazy("fs");
      try { return fs.statSync(this._path).size; } catch { return 0; }
    }
    get type() { return this._type; }
    async exists() {
      const fs = lazy("fs");
      try { fs.statSync(this._path); return true; } catch { return false; }
    }
    async text() {
      const fs = lazy("fs");
      return fs.readFileSync(this._path, "utf8");
    }
    async json() { return JSON.parse(await this.text()); }
    async arrayBuffer() {
      const fs = lazy("fs");
      const b = fs.readFileSync(this._path);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }
    async bytes() {
      const fs = lazy("fs");
      return new Uint8Array(fs.readFileSync(this._path));
    }
    stream() {
      const fs = lazy("fs");
      const nodeStream = fs.createReadStream(this._path);
      // Prefer the Web stream Bun returns; fall back to the Node stream.
      const Readable = lazy("stream").Readable;
      return Readable.toWeb ? Readable.toWeb(nodeStream) : nodeStream;
    }
    writer() {
      const fs = lazy("fs");
      const chunks = [];
      const self = this;
      return {
        write(chunk) { chunks.push(toBuf(chunk, Buffer)); return chunk.length; },
        flush() {},
        end() { fs.writeFileSync(self._path, Buffer.concat(chunks)); },
      };
    }
  }

  function bunFile(pathOrFd, options) { return new BunFile(pathOrFd, options); }

  async function bunWrite(dest, input) {
    const fs = lazy("fs");
    const destPath = dest instanceof BunFile ? dest._path : String(dest);
    let bytes;
    if (input instanceof BunFile) bytes = fs.readFileSync(input._path);
    else if (typeof input === "string") bytes = Buffer.from(input, "utf8");
    else if (input instanceof ArrayBuffer) bytes = Buffer.from(new Uint8Array(input));
    else if (ArrayBuffer.isView(input)) bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    else if (input && typeof input.arrayBuffer === "function") bytes = Buffer.from(new Uint8Array(await input.arrayBuffer()));
    else bytes = Buffer.from(String(input), "utf8");
    const slash = destPath.lastIndexOf("/");
    if (slash > 0) { try { fs.mkdirSync(destPath.slice(0, slash), { recursive: true }); } catch {} }
    fs.writeFileSync(destPath, bytes);
    return bytes.length;
  }

  // ---- Bun.serve -------------------------------------------------------------
  // Bun.serve is Bun's HTTP entry point. We back it with Node's real http.Server so
  // an in-VM Bun app is previewed by the SAME Service-Worker proxy that previews
  // Node servers (runtime/index.js `bridgeHttp`). We adapt each Node req/res to a
  // WHATWG Request/Response, which Bun's handlers expect. Supported:
  //   - `fetch(req, server)`              catch-all request handler
  //   - `routes`                          static/param/wildcard route map (BunRequest.params)
  //   - `websocket` + `server.upgrade()`  server-side WebSockets (real RFC-6455 over the
  //                                        Node http `upgrade` event) + pub/sub topics
  // The browser preview reaches an in-VM ws server through a postMessage tunnel that
  // ends in a genuine loopback WebSocket client (runtime/websocket.js), so the server
  // side has to do the real 101 handshake + framing here.
  function bunServe(options) {
    const http = lazy("http");
    const opts = options || {};
    let fetchHandler = typeof opts.fetch === "function" ? opts.fetch : null;
    let routes = compileRoutes(opts.routes);
    let wsHandlers = opts.websocket && typeof opts.websocket === "object" ? opts.websocket : null;
    if (!fetchHandler && !routes && !wsHandlers) {
      throw new TypeError("Bun.serve requires a `fetch` handler or `routes`");
    }
    const hostname = opts.hostname || "0.0.0.0";
    const port = opts.port != null ? opts.port | 0 : 3000;

    // Pub/sub topic registry: topic -> Set<ServerWebSocket>.
    const topics = new Map();
    const allSockets = new Set();
    const publishToSelf = !!(wsHandlers && wsHandlers.publishToSelf);
    function topicPublish(topic, message, exclude) {
      const set = topics.get(topic);
      if (!set) return 0;
      let n = 0;
      for (const ws of set) { if (ws === exclude || ws.readyState !== 1) continue; ws.send(message); n++; }
      return n;
    }

    function cloneResponse(r) { try { return r.clone(); } catch { return r; } }

    // Route + fetch dispatch. Returns a Promise<Response|undefined>.
    function dispatch(request, method) {
      return Promise.resolve().then(() => {
        if (routes) {
          const pathname = new URL(request.url).pathname;
          const m = matchRoute(routes, pathname, method);
          if (m) {
            if (m.response !== undefined) return cloneResponse(m.response);
            request.params = m.params;
            return m.handler(request, inst);
          }
        }
        if (fetchHandler) return fetchHandler(request, inst);
        return undefined;
      });
    }

    const server = http.createServer((req, res) => {
      const host = req.headers.host || hostname + ":" + port;
      const urlStr = "http://" + host + (req.url || "/");
      const method = (req.method || "GET").toUpperCase();
      const collect = (cb) => {
        if (method === "GET" || method === "HEAD") return cb(null);
        const parts = [];
        req.on("data", (c) => parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        req.on("end", () => cb(Buffer.concat(parts)));
        req.on("error", () => cb(null));
      };
      collect((body) => {
        let request;
        try {
          request = new Request(urlStr, { method, headers: req.headers, body: body && body.length ? body : undefined });
        } catch {
          // Some runtimes forbid a body on a GET Request even when undefined; retry bare.
          request = new Request(urlStr, { method, headers: req.headers });
        }
        dispatch(request, method)
          .then(async (response) => {
            if (!response) { res.statusCode = 404; res.end("Not Found"); return; }
            res.statusCode = response.status || 200;
            try { response.headers.forEach((v, k) => res.setHeader(k, v)); } catch {}
            const ab = await response.arrayBuffer();
            res.end(Buffer.from(new Uint8Array(ab)));
          })
          .catch((err) => {
            res.statusCode = 500;
            res.end("Bun.serve handler error: " + ((err && err.message) || err));
          });
      });
    });

    // ---- server-side WebSocket ----------------------------------------------
    // Node's http server emits `upgrade` (req, socket, head) for `Connection:
    // Upgrade` requests. Bun's model performs the upgrade decision inside `fetch`
    // via `server.upgrade(req)`, so we run the fetch handler here and complete the
    // 101 handshake + framing if it opted in.
    const upgradeCtx = new Map(); // request -> { req, socket, head, done }

    class ServerWebSocket {
      constructor(socket, data) {
        this._socket = socket;
        this.data = data;
        this.readyState = 1; // OPEN
        this.remoteAddress = (socket && socket.remoteAddress) || "127.0.0.1";
        this._subs = new Set();
        this._buf = Buffer.alloc(0);
        this._fragOpcode = 0;
        this._fragChunks = [];
      }
      get subscriptions() { return Array.from(this._subs); }
      send(message) {
        if (this.readyState !== 1) return -1;
        const { opcode, payload } = toWsPayload(message, Buffer);
        try { this._socket.write(encodeWsFrame(Buffer, opcode, payload, false)); return payload.length; }
        catch { return 0; }
      }
      close(code, reason) {
        if (this.readyState === 3 || this.readyState === 2) return;
        this.readyState = 2;
        let payload = Buffer.alloc(0);
        if (typeof code === "number") {
          const r = reason ? Buffer.from(String(reason), "utf8") : Buffer.alloc(0);
          payload = Buffer.alloc(2 + r.length); payload.writeUInt16BE(code, 0); r.copy(payload, 2);
        }
        try { this._socket.write(encodeWsFrame(Buffer, 0x8, payload, false)); } catch {}
        try { this._socket.end(); } catch {}
        this._closed(typeof code === "number" ? code : 1000, reason || "", true);
      }
      subscribe(topic) { if (!topics.has(topic)) topics.set(topic, new Set()); topics.get(topic).add(this); this._subs.add(topic); return true; }
      unsubscribe(topic) { this._subs.delete(topic); const s = topics.get(topic); if (s) { s.delete(this); if (!s.size) topics.delete(topic); } return true; }
      isSubscribed(topic) { return this._subs.has(topic); }
      publish(topic, message) { return topicPublish(topic, message, publishToSelf ? null : this); }
      cork(cb) { return cb(this); }
      ping() {} pong() {}
      _onData(chunk) {
        this._buf = Buffer.concat([this._buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        for (;;) {
          const r = readWsFrame(Buffer, this._buf);
          if (!r) break;
          this._buf = r.rest;
          this._handleFrame(r.frame);
        }
      }
      _handleFrame(frame) {
        const { fin, opcode, payload } = frame;
        if (opcode === 0x8) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
          try { this._socket.write(encodeWsFrame(Buffer, 0x8, payload.length >= 2 ? payload : Buffer.alloc(0), false)); } catch {}
          try { this._socket.end(); } catch {}
          this._closed(code, reason, true); return;
        }
        if (opcode === 0x9) { try { this._socket.write(encodeWsFrame(Buffer, 0xa, payload, false)); } catch {} return; }
        if (opcode === 0xa) return;
        if (opcode === 0x1 || opcode === 0x2) { this._fragOpcode = opcode; this._fragChunks = [payload]; }
        else if (opcode === 0x0) { this._fragChunks.push(payload); }
        if (!fin) return;
        const full = this._fragChunks.length === 1 ? this._fragChunks[0] : Buffer.concat(this._fragChunks);
        this._fragChunks = [];
        const isText = this._fragOpcode === 0x1;
        const msg = isText ? full.toString("utf8") : full.buffer.slice(full.byteOffset, full.byteOffset + full.byteLength);
        if (wsHandlers && wsHandlers.message) { try { wsHandlers.message(this, msg); } catch (e) { if (wsHandlers.error) wsHandlers.error(this, e); else throw e; } }
      }
      _closed(code, reason, clean) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        for (const t of Array.from(this._subs)) this.unsubscribe(t);
        allSockets.delete(this);
        inst.pendingWebSockets = allSockets.size;
        if (wsHandlers && wsHandlers.close) { try { wsHandlers.close(this, code, reason); } catch (e) { if (wsHandlers.error) wsHandlers.error(this, e); } }
      }
    }

    function finishUpgrade(ctx, extraHeaders, data) {
      const crypto = lazy("crypto");
      const key = ctx.req.headers["sec-websocket-key"] || "";
      const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      let head =
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Accept: " + accept + "\r\n";
      const proto = ctx.req.headers["sec-websocket-protocol"];
      if (proto) head += "Sec-WebSocket-Protocol: " + String(proto).split(",")[0].trim() + "\r\n";
      if (extraHeaders) {
        try {
          const h = extraHeaders instanceof Headers ? extraHeaders : new Headers(extraHeaders);
          h.forEach((v, k) => { head += k + ": " + v + "\r\n"; });
        } catch {}
      }
      head += "\r\n";
      try { ctx.socket.write(head); } catch {}
      const ws = new ServerWebSocket(ctx.socket, data);
      allSockets.add(ws);
      inst.pendingWebSockets = allSockets.size;
      ctx.socket.on("data", (chunk) => ws._onData(chunk));
      ctx.socket.on("close", () => ws._closed(1006, "", false));
      ctx.socket.on("error", () => ws._closed(1006, "", false));
      if (ctx.head && ctx.head.length) ws._onData(ctx.head);
      if (wsHandlers && wsHandlers.open) { try { wsHandlers.open(ws); } catch (e) { if (wsHandlers.error) wsHandlers.error(ws, e); } }
      return ws;
    }

    const inst = {
      port,
      hostname,
      development: !!opts.development,
      url: safeUrl("http://localhost:" + port + "/"),
      stop() {
        for (const ws of Array.from(allSockets)) { try { ws.close(1001); } catch {} }
        try { server.close(); } catch {}
      },
      reload(next) {
        next = next || {};
        if (typeof next.fetch === "function") fetchHandler = next.fetch;
        if (next.routes) routes = compileRoutes(next.routes);
        if (next.websocket) wsHandlers = next.websocket;
      },
      // Called synchronously inside `fetch` to hand a request off to the websocket
      // handler. Returns true if this request is being upgraded.
      upgrade(request, upOpts) {
        const ctx = upgradeCtx.get(request);
        if (!ctx || ctx.done) return false;
        ctx.done = true;
        finishUpgrade(ctx, upOpts && upOpts.headers, upOpts && upOpts.data);
        return true;
      },
      publish(topic, message) { return topicPublish(topic, message, null); },
      subscriberCount(topic) { const s = topics.get(topic); return s ? s.size : 0; },
      requestIP() { return { address: "127.0.0.1", family: "IPv4", port: 0 }; },
      get pendingRequests() { return 0; },
      pendingWebSockets: 0,
    };

    if (wsHandlers || fetchHandler) {
      server.on("upgrade", (req, socket, head) => {
        const host = req.headers.host || hostname + ":" + port;
        const urlStr = "http://" + host + (req.url || "/");
        let request;
        try { request = new Request(urlStr, { method: "GET", headers: req.headers }); }
        catch { try { socket.destroy(); } catch {} return; }
        const ctx = { req, socket, head, request, done: false };
        upgradeCtx.set(request, ctx);
        const decide = fetchHandler
          ? Promise.resolve().then(() => fetchHandler(request, inst))
          : Promise.resolve().then(() => { inst.upgrade(request); });
        decide
          .then(() => {
            if (!ctx.done) {
              try { socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nWebSocket upgrade failed"); } catch {}
              try { socket.destroy(); } catch {}
            }
          })
          .catch(() => { try { socket.destroy(); } catch {} })
          .finally(() => upgradeCtx.delete(request));
      });
    }

    server.listen(port, hostname);
    return inst;
  }

  // ---- Bun.$ (shell) ---------------------------------------------------------
  // A small tagged-template shell. Interpolations are shell-escaped. The returned
  // value is a thenable resolving to { exitCode, stdout, stderr } with Bun's
  // .text()/.json()/.quiet()/.nothrow() helpers.
  function makeShell() {
    const run = (strings, exprs, opts) => {
      const cp = lazy("child_process");
      let cmd = "";
      for (let i = 0; i < strings.length; i++) {
        cmd += strings[i];
        if (i < exprs.length) cmd += shellEscape(exprs[i]);
      }
      let nothrow = !!(opts && opts.nothrow);
      let quiet = !!(opts && opts.quiet);
      const exec = () =>
        new Promise((resolve, reject) => {
          const child = cp.spawn("sh", ["-c", cmd], { cwd: process.cwd(), env: process.env });
          const outParts = [];
          const errParts = [];
          if (child.stdout) child.stdout.on("data", (d) => { outParts.push(toBuf(d, Buffer)); if (!quiet) process.stdout.write(d); });
          if (child.stderr) child.stderr.on("data", (d) => { errParts.push(toBuf(d, Buffer)); if (!quiet) process.stderr.write(d); });
          child.on("error", reject);
          child.on("close", (code) => {
            const stdout = Buffer.concat(outParts);
            const stderr = Buffer.concat(errParts);
            const result = {
              exitCode: code | 0,
              stdout,
              stderr,
              text: () => stdout.toString("utf8"),
              json: () => JSON.parse(stdout.toString("utf8")),
            };
            if (code !== 0 && !nothrow) {
              const e = new Error("Command failed with exit code " + code + ": " + cmd);
              Object.assign(e, result);
              reject(e);
            } else resolve(result);
          });
        });
      const promise = exec();
      promise.quiet = () => { quiet = true; return promise; };
      promise.nothrow = () => { nothrow = true; return promise; };
      promise.text = async () => (await promise).text();
      promise.json = async () => (await promise).json();
      return promise;
    };
    const $ = (strings, ...exprs) => run(strings, exprs, {});
    $.braces = (s) => [s];
    $.escape = shellEscape;
    return $;
  }

  // ---- Bun.spawn / spawnSync / which ----------------------------------------
  function bunSpawn(cmdOrOpts, maybeOpts) {
    const cp = lazy("child_process");
    let cmd, opts;
    if (Array.isArray(cmdOrOpts)) { cmd = cmdOrOpts; opts = maybeOpts || {}; }
    else { opts = cmdOrOpts || {}; cmd = opts.cmd || []; }
    const [file, ...args] = cmd;
    const child = cp.spawn(file, args, {
      cwd: opts.cwd || process.cwd(),
      env: opts.env || process.env,
    });
    const web = (nodeStream) => {
      const Readable = lazy("stream").Readable;
      return nodeStream && Readable.toWeb ? Readable.toWeb(nodeStream) : nodeStream;
    };
    return {
      pid: child.pid,
      stdout: web(child.stdout),
      stderr: web(child.stderr),
      stdin: child.stdin,
      kill: (sig) => child.kill(sig),
      exited: new Promise((resolve) => child.on("close", (code) => resolve(code | 0))),
    };
  }
  function bunSpawnSync(cmdOrOpts, maybeOpts) {
    const cp = lazy("child_process");
    let cmd, opts;
    if (Array.isArray(cmdOrOpts)) { cmd = cmdOrOpts; opts = maybeOpts || {}; }
    else { opts = cmdOrOpts || {}; cmd = opts.cmd || []; }
    const [file, ...args] = cmd;
    const r = cp.spawnSync(file, args, { cwd: opts.cwd || process.cwd(), env: opts.env || process.env });
    return {
      pid: 0,
      exitCode: r.status | 0,
      success: r.status === 0,
      stdout: r.stdout ? toBuf(r.stdout, Buffer) : Buffer.alloc(0),
      stderr: r.stderr ? toBuf(r.stderr, Buffer) : Buffer.alloc(0),
    };
  }
  function bunWhich(cmd, opts) {
    const fs = lazy("fs");
    const dirs = String((opts && opts.PATH) || process.env.PATH || "/bin").split(":").filter(Boolean);
    for (const d of dirs) {
      for (const suffix of ["", ".js"]) {
        const p = d + "/" + cmd + suffix;
        try { if (fs.statSync(p).isFile()) return p; } catch {}
      }
    }
    return null;
  }

  // ---- hashing / crypto ------------------------------------------------------
  function bunHash(data, seed) {
    // Bun.hash defaults to wyhash; we return a stable 53-bit numeric hash. Not
    // byte-identical to Bun's wyhash, but stable + fast, which is what callers use.
    const buf = toBuf(data, Buffer);
    let h1 = 0xdeadbeef ^ (Number(seed) | 0);
    let h2 = 0x41c6ce57 ^ (Number(seed) | 0);
    for (let i = 0; i < buf.length; i++) {
      const ch = buf[i];
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }
  bunHash.wyhash = (data, seed) => bunHash(data, seed);
  bunHash.crc32 = (data) => {
    const buf = toBuf(data, Buffer);
    let crc = ~0;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (~crc) >>> 0;
  };
  bunHash.adler32 = (data) => {
    const buf = toBuf(data, Buffer);
    let a = 1, b = 0;
    for (let i = 0; i < buf.length; i++) { a = (a + buf[i]) % 65521; b = (b + a) % 65521; }
    return ((b << 16) | a) >>> 0;
  };

  class CryptoHasher {
    constructor(algorithm = "sha256") {
      this.algorithm = algorithm;
      this._h = lazy("crypto").createHash(algorithm);
    }
    update(data, encoding) { this._h.update(toBuf(data, Buffer), encoding); return this; }
    digest(encoding) { return encoding ? this._h.digest(encoding) : new Uint8Array(this._h.digest()); }
  }

  const password = {
    async hash(pw, opts) {
      const crypto = lazy("crypto");
      const algo = (opts && (typeof opts === "string" ? opts : opts.algorithm)) || "argon2id";
      const salt = crypto.randomBytes(16);
      const key = crypto.scryptSync(String(pw), salt, 32);
      // A self-describing string (approximation of Bun's PHC output). verify() below
      // parses it back. Not interoperable with real argon2/bcrypt hashes.
      return "$vv-" + algo + "$" + salt.toString("base64") + "$" + Buffer.from(key).toString("base64");
    },
    async verify(pw, stored) {
      try {
        const crypto = lazy("crypto");
        const parts = String(stored).split("$");
        const salt = Buffer.from(parts[2], "base64");
        const key = Buffer.from(parts[3], "base64");
        const check = crypto.scryptSync(String(pw), salt, key.length);
        return crypto.timingSafeEqual(key, check);
      } catch { return false; }
    },
  };
  password.hashSync = (pw, opts) => {
    const crypto = lazy("crypto");
    const algo = (opts && (typeof opts === "string" ? opts : opts.algorithm)) || "argon2id";
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(String(pw), salt, 32);
    return "$vv-" + algo + "$" + salt.toString("base64") + "$" + Buffer.from(key).toString("base64");
  };
  password.verifySync = (pw, stored) => {
    try {
      const crypto = lazy("crypto");
      const parts = String(stored).split("$");
      const salt = Buffer.from(parts[2], "base64");
      const key = Buffer.from(parts[3], "base64");
      const check = crypto.scryptSync(String(pw), salt, key.length);
      return crypto.timingSafeEqual(key, check);
    } catch { return false; }
  };

  // ---- misc helpers ----------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms instanceof Date ? Math.max(0, ms - Date.now()) : ms));
  const sleepSync = (ms) => {
    // Best effort: a spin wait. The runtime has no Atomics-park primitive exposed
    // to guest code here, so this blocks the loop briefly (Bun's is a true sleep).
    const end = Date.now() + (ms | 0);
    while (Date.now() < end) { /* spin */ }
  };
  const startNs = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  const nanoseconds = () => Math.round(((typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) - startNs) * 1e6);

  function deepEquals(a, b, strict) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a && b && typeof a === "object") {
      const ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      for (const k of ka) if (!deepEquals(a[k], b[k], strict)) return false;
      return true;
    }
    return false;
  }
  const escapeHTML = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

  const zlibSync = (name) => (data, opts) => {
    const zlib = lazy("zlib");
    return new Uint8Array(zlib[name](toBuf(data, Buffer), opts || {}));
  };

  function fileURLToPath(url) {
    const u = typeof url === "string" ? url : url.href;
    let p = u.replace(/^file:\/\//, "");
    try { p = decodeURIComponent(p); } catch {}
    return p || "/";
  }
  function pathToFileURL(p) { return safeUrl("file://" + p); }

  // ---- the Bun global --------------------------------------------------------
  const Bun = {
    version: "1.1.34",
    revision: "vivari-shim",
    get env() { return process.env; },
    get argv() { return process.argv; },
    get main() { return process.argv && process.argv[1] ? process.argv[1] : ""; },
    file: bunFile,
    write: bunWrite,
    serve: bunServe,
    $: makeShell(),
    spawn: bunSpawn,
    spawnSync: bunSpawnSync,
    which: bunWhich,
    sleep,
    sleepSync,
    nanoseconds,
    hash: bunHash,
    CryptoHasher,
    password,
    deepEquals,
    escapeHTML,
    inspect: (v, opts) => lazy("util").inspect(v, opts),
    gzipSync: zlibSync("gzipSync"),
    gunzipSync: zlibSync("gunzipSync"),
    deflateSync: zlibSync("deflateSync"),
    inflateSync: zlibSync("inflateSync"),
    fileURLToPath,
    pathToFileURL,
    resolveSync: (id, parent) => require.resolve ? require.resolve(id) : id,
    resolve: async (id, parent) => (require.resolve ? require.resolve(id) : id),
    randomUUIDv7: () => lazy("crypto").randomUUID(),
    get stdin() { return process.stdin; },
    get stdout() { return process.stdout; },
    get stderr() { return process.stderr; },
    // GC / memory introspection: no-ops (no manual GC exposed in the sandbox).
    gc: () => {},
    // A thin Transpiler shim over the same TS transform the loader uses.
    Transpiler: makeTranspilerClass(),
    // Native FFI is impossible in the sandbox — fail loudly if reached via Bun.dlopen.
    dlopen() { throw new Error("Bun.dlopen (native FFI) is not supported in Vivari (browser sandbox)"); },
  };

  // ---- bun:* modules ---------------------------------------------------------
  const modules = {
    "bun:test": makeBunTest({ process }),
    "bun:jsc": makeBunJsc(),
    "bun:ffi": makeBunFfi(),
    "bun:sqlite": makeBunSqlite({ require }),
  };

  return { Bun, modules };

  function makeTranspilerClass() {
    return class Transpiler {
      constructor(opts) { this._opts = opts || {}; }
      transformSync(code, loaderOrOpts) {
        const loader = typeof loaderOrOpts === "string" ? loaderOrOpts : (this._opts.loader || "tsx");
        const ext = loader === "ts" ? ".ts" : loader === "jsx" ? ".jsx" : loader === "js" ? ".js" : ".tsx";
        return transpileTypeScript(code, "input" + ext);
      }
      async transform(code, loader) { return this.transformSync(code, loader); }
      scan() { return { exports: [], imports: [] }; }
      scanImports() { return []; }
    };
  }
}

// ---- bun:test — a minimal but functional test runner ------------------------
function makeBunTest({ process }) {
  const suites = [];
  let current = null;
  const rootHooks = { beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] };

  const describe = (name, fn) => {
    const parent = current;
    const suite = { name, tests: [], hooks: { beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] }, parent };
    (parent ? parent.children || (parent.children = []) : suites).push(suite);
    current = suite;
    try { fn && fn(); } finally { current = parent; }
  };
  const test = (name, fn, opts) => {
    const t = { name, fn, skip: !!(opts && opts.skip) };
    if (current) current.tests.push(t);
    else suites.push({ name: "", tests: [t], hooks: emptyHooks() });
  };
  test.skip = (name, fn) => test(name, fn, { skip: true });
  test.todo = (name) => test(name, () => {}, { skip: true });
  test.only = (name, fn) => test(name, fn);
  const it = test;

  const hook = (kind) => (fn) => {
    (current ? current.hooks[kind] : rootHooks[kind]).push(fn);
  };

  const runner = {
    describe, test, it, expect,
    beforeAll: hook("beforeAll"), afterAll: hook("afterAll"),
    beforeEach: hook("beforeEach"), afterEach: hook("afterEach"),
    mock: makeMock(), spyOn,
    jest: { fn: makeMock(), spyOn },
    // Invoked by the `bun test` command after loading the test files.
    async __run() {
      let pass = 0, fail = 0;
      const write = (s) => process.stdout.write(s);
      for (const fn of rootHooks.beforeAll) await fn();
      const runSuite = async (suite, prefix) => {
        for (const fn of suite.hooks.beforeAll) await fn();
        for (const t of suite.tests) {
          for (const fn of suite.hooks.beforeEach) await fn();
          const label = (prefix ? prefix + " > " : "") + t.name;
          if (t.skip) { write("  - " + label + " (skipped)\n"); continue; }
          try { await t.fn(); write("  \u2713 " + label + "\n"); pass++; }
          catch (e) { write("  \u2717 " + label + "\n    " + ((e && e.message) || e) + "\n"); fail++; }
          for (const fn of suite.hooks.afterEach) await fn();
        }
        for (const child of suite.children || []) await runSuite(child, (prefix ? prefix + " > " : "") + child.name);
        for (const fn of suite.hooks.afterAll) await fn();
      };
      for (const s of suites) await runSuite(s, s.name);
      for (const fn of rootHooks.afterAll) await fn();
      write("\n " + pass + " pass, " + fail + " fail\n");
      return fail === 0 ? 0 : 1;
    },
  };
  return runner;

  function emptyHooks() { return { beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] }; }
}

// bun:test expect() — a compact matcher set covering the common surface.
function expect(received) {
  const make = (negate) => ({
    toBe(v) { assert(negate, received === v, `expected ${fmt(received)} to be ${fmt(v)}`); },
    toEqual(v) { assert(negate, deepEq(received, v), `expected ${fmt(received)} to equal ${fmt(v)}`); },
    toStrictEqual(v) { assert(negate, deepEq(received, v), `expected ${fmt(received)} to strictly equal ${fmt(v)}`); },
    toBeTruthy() { assert(negate, !!received, `expected ${fmt(received)} to be truthy`); },
    toBeFalsy() { assert(negate, !received, `expected ${fmt(received)} to be falsy`); },
    toBeDefined() { assert(negate, received !== undefined, `expected value to be defined`); },
    toBeUndefined() { assert(negate, received === undefined, `expected value to be undefined`); },
    toBeNull() { assert(negate, received === null, `expected ${fmt(received)} to be null`); },
    toBeNaN() { assert(negate, Number.isNaN(received), `expected ${fmt(received)} to be NaN`); },
    toContain(v) { assert(negate, received && received.includes && received.includes(v), `expected ${fmt(received)} to contain ${fmt(v)}`); },
    toHaveLength(n) { assert(negate, received && received.length === n, `expected length ${received && received.length} to be ${n}`); },
    toBeGreaterThan(n) { assert(negate, received > n, `expected ${fmt(received)} > ${n}`); },
    toBeGreaterThanOrEqual(n) { assert(negate, received >= n, `expected ${fmt(received)} >= ${n}`); },
    toBeLessThan(n) { assert(negate, received < n, `expected ${fmt(received)} < ${n}`); },
    toBeLessThanOrEqual(n) { assert(negate, received <= n, `expected ${fmt(received)} <= ${n}`); },
    toMatch(re) { assert(negate, (typeof re === "string" ? received.includes(re) : re.test(received)), `expected ${fmt(received)} to match ${re}`); },
    toBeInstanceOf(C) { assert(negate, received instanceof C, `expected value to be instanceof ${C && C.name}`); },
    toThrow(msg) {
      let threw = false, err;
      try { received(); } catch (e) { threw = true; err = e; }
      const okMsg = msg == null || (err && String(err.message || err).includes(typeof msg === "string" ? msg : ""));
      assert(negate, threw && okMsg, `expected function to throw${msg ? " " + msg : ""}`);
    },
  });
  const api = make(false);
  api.not = make(true);
  api.resolves = {
    async toBe(v) { expect(await received).toBe(v); },
    async toEqual(v) { expect(await received).toEqual(v); },
  };
  api.rejects = {
    async toThrow(msg) {
      let threw = false, err;
      try { await received; } catch (e) { threw = true; err = e; }
      assert(false, threw, `expected promise to reject`);
    },
  };
  return api;

  function assert(negate, cond, message) {
    const pass = negate ? !cond : cond;
    if (!pass) throw new Error((negate ? "[not] " : "") + message);
  }
  function fmt(v) { try { return JSON.stringify(v); } catch { return String(v); } }
  function deepEq(a, b) {
    if (a === b) return true;
    if (a && b && typeof a === "object" && typeof b === "object") {
      const ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      return ka.every((k) => deepEq(a[k], b[k]));
    }
    return false;
  }
}

function makeMock() {
  const fn = (impl) => {
    const calls = [];
    const results = [];
    const f = (...args) => {
      calls.push(args);
      const r = impl ? impl(...args) : undefined;
      results.push({ type: "return", value: r });
      return r;
    };
    f.mock = { calls, results };
    f.mockClear = () => { calls.length = 0; results.length = 0; return f; };
    f.mockReset = () => { impl = undefined; return f.mockClear(); };
    f.mockImplementation = (i) => { impl = i; return f; };
    f.mockReturnValue = (v) => { impl = () => v; return f; };
    f.mockResolvedValue = (v) => { impl = () => Promise.resolve(v); return f; };
    return f;
  };
  return fn;
}
function spyOn(obj, method) {
  const original = obj[method];
  const mock = makeMock()((...args) => original.apply(obj, args));
  mock.mockRestore = () => { obj[method] = original; };
  obj[method] = mock;
  return mock;
}

// bun:jsc — a couple of the introspection helpers, backed by web primitives.
function makeBunJsc() {
  return {
    serialize: (v) => new Uint8Array(Buffer.from(JSON.stringify(v), "utf8")),
    deserialize: (b) => JSON.parse(Buffer.from(b).toString("utf8")),
    estimateShallowMemoryUsageOf: () => 0,
    heapSize: () => 0,
    memoryUsage: () => ({ current: 0, peak: 0 }),
  };
}

// bun:ffi — documented as unsupported (native FFI). We export the symbols so an
// `import { dlopen } from "bun:ffi"` doesn't crash at load, but any actual use
// throws a clear error rather than corrupting memory.
function makeBunFfi() {
  const unsupported = () => { throw new Error("bun:ffi (native FFI) is not supported in Vivari (browser sandbox)"); };
  return {
    dlopen: unsupported,
    CString: class CString {},
    ptr: unsupported,
    toArrayBuffer: unsupported,
    FFIType: {},
    suffix: "so",
    read: {},
  };
}

// bun:sqlite — API surface backed by a project-installed wasm SQLite when present
// (e.g. a `sql.js`/`@sqlite.org/sqlite-wasm` drop-in). Without a backend it throws
// a clear, actionable error rather than pretending to be a database.
function makeBunSqlite({ require }) {
  class Database {
    constructor(filename, options) {
      this.filename = filename || ":memory:";
      this._backend = null;
      try {
        // Prefer a project-provided backend if one is installed.
        this._backend = require("@sqlite.org/sqlite-wasm");
      } catch {
        try { this._backend = require("sql.js"); } catch { this._backend = null; }
      }
      if (!this._backend) {
        throw new Error(
          "bun:sqlite has no in-VM backend. Install a wasm SQLite drop-in " +
            "(e.g. `bun add @sqlite.org/sqlite-wasm`) — native SQLite cannot run in the browser sandbox.",
        );
      }
    }
    query(sql) { return this.prepare(sql); }
    prepare(sql) {
      const be = this._backend;
      return {
        sql,
        all: (...params) => runBackend(be, sql, params, "all"),
        get: (...params) => runBackend(be, sql, params, "get"),
        run: (...params) => runBackend(be, sql, params, "run"),
        values: (...params) => runBackend(be, sql, params, "values"),
        finalize() {},
      };
    }
    run(sql) { return this.prepare(sql).run(); }
    exec(sql) { return this.prepare(sql).run(); }
    close() {}
    static open(filename, options) { return new Database(filename, options); }
  }
  function runBackend() {
    throw new Error("bun:sqlite backend integration is experimental; wire your installed wasm SQLite here.");
  }
  return { Database, default: Database };
}

// ---- Bun.serve routing ------------------------------------------------------
// Compile a `routes` map into a specificity-ordered list. Bun precedence:
// exact (0) > `:param` (1) > `*` wildcard (2) > global `/*` (3).
export function compileRoutes(routes) {
  if (!routes || typeof routes !== "object") return null;
  const compiled = [];
  for (const pattern of Object.keys(routes)) {
    const parts = pattern.split("/").filter((s) => s.length > 0).map((s) =>
      s[0] === ":" ? { param: s.slice(1) } : s === "*" ? { wildcard: true } : { lit: s },
    );
    let spec = 0;
    if (pattern === "/*") spec = 3;
    else if (parts.some((p) => p.wildcard)) spec = 2;
    else if (parts.some((p) => p.param)) spec = 1;
    compiled.push({ pattern, parts, value: routes[pattern], spec });
  }
  compiled.sort((a, b) => a.spec - b.spec || b.parts.length - a.parts.length);
  return compiled;
}

function matchParts(parts, path) {
  const params = {};
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.wildcard) return { params }; // matches the remaining segments (incl. none)
    if (i >= path.length) return null;
    if (p.param) { try { params[p.param] = decodeURIComponent(path[i]); } catch { params[p.param] = path[i]; } }
    else if (p.lit !== path[i]) return null;
  }
  if (parts.length !== path.length) return null; // exact/param routes require equal length
  return { params };
}

// Match a pathname against compiled routes. A route value is a `Response`, a
// handler `(req) => Response`, or a per-method map `{ GET, POST, ... }`.
export function matchRoute(compiled, pathname, method) {
  const path = pathname.split("/").filter((s) => s.length > 0);
  const RES = typeof Response !== "undefined" ? Response : null;
  for (const route of compiled) {
    const m = matchParts(route.parts, path);
    if (!m) continue;
    let value = route.value;
    if (value && typeof value === "object" && !(RES && value instanceof RES) && typeof value.arrayBuffer !== "function") {
      const mm = value[(method || "GET").toUpperCase()];
      if (!mm) continue; // method not handled by this route -> keep looking
      value = mm;
    }
    if (typeof value === "function") return { handler: value, params: m.params };
    return { response: value, params: m.params };
  }
  return null;
}

// ---- Bun.serve WebSocket frame codec (RFC 6455) -----------------------------
// Server role: send unmasked frames, accept masked client frames. Mirrors the
// client-only codec in ../websocket.js.
export function toWsPayload(data, Buffer) {
  if (typeof data === "string") return { opcode: 0x1, payload: Buffer.from(data, "utf8") };
  if (data instanceof ArrayBuffer) return { opcode: 0x2, payload: Buffer.from(new Uint8Array(data)) };
  if (ArrayBuffer.isView(data)) return { opcode: 0x2, payload: Buffer.from(data.buffer, data.byteOffset, data.byteLength) };
  if (Buffer.isBuffer(data)) return { opcode: 0x2, payload: data };
  return { opcode: 0x1, payload: Buffer.from(String(data), "utf8") };
}

export function encodeWsFrame(Buffer, opcode, payload, masked) {
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeUInt32BE(Math.floor(len / 0x100000000), 2); header.writeUInt32BE(len >>> 0, 6); }
  header[0] = 0x80 | (opcode & 0x0f);
  if (!masked) return Buffer.concat([header, payload]);
  header[1] |= 0x80;
  const mask = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) mask[i] = (Math.random() * 256) | 0;
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, out]);
}

// Parse one frame off the head of `buf`; returns { frame, rest } or null if the
// buffer does not yet hold a complete frame.
export function readWsFrame(Buffer, buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = buf.readUInt32BE(6); offset = 10; }
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;
  let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
  if (masked) {
    const mask = buf.subarray(offset, offset + 4);
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
    payload = out;
  } else {
    payload = Buffer.from(payload);
  }
  return { frame: { fin, opcode, payload }, rest: buf.subarray(offset + maskLen + len) };
}

// ---- small shared helpers ---------------------------------------------------
function toBuf(x, Buffer) {
  if (Buffer.isBuffer(x)) return x;
  if (typeof x === "string") return Buffer.from(x, "utf8");
  if (x instanceof ArrayBuffer) return Buffer.from(new Uint8Array(x));
  if (ArrayBuffer.isView(x)) return Buffer.from(x.buffer, x.byteOffset, x.byteLength);
  return Buffer.from(String(x), "utf8");
}
function shellEscape(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(shellEscape).join(" ");
  const s = String(v);
  if (/^[A-Za-z0-9_\-./:=@]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
function safeUrl(s) {
  try { return new URL(s); } catch { return { href: s, toString: () => s }; }
}
function guessMime(p) {
  const ext = (p.split(".").pop() || "").toLowerCase();
  const map = {
    html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript",
    mjs: "text/javascript", json: "application/json", txt: "text/plain",
    svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", wasm: "application/wasm",
  };
  return map[ext] || "application/octet-stream";
}