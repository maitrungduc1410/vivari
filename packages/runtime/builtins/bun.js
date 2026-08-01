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
// previews — with `routes`, `fetch`, an `error` handler, and server-side
// `websocket` + pub/sub), Bun.env/argv/main/version, Bun.spawn/spawnSync/which,
// Bun.$ (shell), Bun.sleep/Bun.sleepSync (a real Atomics.wait park, see
// bun-sleep.js)/nanoseconds, automatic .env/.env.local/.env.{mode}(.local)
// loading with Bun's precedence and $VAR expansion (bun-env.js; `bun` processes
// only, never plain `node`; `bun test` uses the test file set and then defaults
// NODE_ENV), import.meta.dir/file/path/env/main/resolveSync
// (packages/runtime/esm.js, also gated on the Bun global),
// Bun.resolveSync/resolve (the `root` argument is a DIRECTORY and is honoured;
// import.meta.resolveSync's is the importing FILE), Bun.hash (real wyhash, plus
// xxHash32/64, murmur32v2/v3, murmur64v2, cityHash32/64, crc32, adler32 —
// byte-exact, with the documented number-vs-bigint return typing)/CryptoHasher,
// Bun.password (crypto-backed), Bun.Glob (.match(); `*` stops at `/`, `!` negates
// only at pattern start, braces nest 10 deep — plus .scan()/.scanSync(), a real
// pruning VFS walk with the documented cwd/dot/absolute/onlyFiles/followSymlinks/
// throwErrorOnBrokenSymlink options), Bun.FileSystemRouter (Next.js-style
// [param]/[...catchAll]/[[...optional]] with per-segment precedence — see
// bun-fsrouter.js), Bun.randomUUIDv7 (a real time-ordered v7, monotonic within a
// millisecond), Bun.gzipSync/…,
// Bun.inspect (incl. .table and .custom)/deepEquals (loose AND strict)/deepMatch/
// escapeHTML, Bun.pathToFileURL/fileURLToPath,
// Bun.stringWidth/stripANSI/wrapAnsi/color/indexOfLine (see bun-text.js),
// Bun.ArrayBufferSink/readableStreamTo*/concatArrayBuffers/allocUnsafe (see
// bun-bytes.js), async-generator Response bodies (inherited from the platform
// Response, no shim code — see bun-bytes.js), the data formats Bun.YAML.parse,
// Bun.TOML.parse/stringify, Bun.JSON5.parse/stringify, Bun.JSONL.parse/parseChunk
// and Bun.semver.satisfies/order (vendored real parsers — see ./bun-formats.js),
// and the modules bun:test (a runner +
// expect, with Bun/Jest `test.only` filtering and beforeEach/afterEach that
// inherit into nested describes, and toEqual/toStrictEqual/toMatchObject backed
// by deepEquals/deepMatch) and bun:jsc (serialize/deserialize).
//
// NOT SUPPORTED (documented, fails loudly rather than silently wrong): bun:ffi /
// Bun.dlopen (native FFI), native addons, Bun macros, and Bun.build plugins —
// these require capabilities the browser sandbox does not have. Loud for the
// narrower reason that the shim has not implemented them: Bun.file(fd) (our fd
// numbers are VFS handles, not OS fds), Bun.Transpiler.scan/scanImports (the
// transform builds no import/export graph), Bun.hash.xxHash3/rapidhash (not
// ported, and we have no reference vector to verify a port against), and the bun:jsc
// heap-introspection helpers (no engine hook exists in a page). bun:sqlite is
// registered as a module but every call throws until a wasm SQLite backend is
// wired into it (see makeBunSqlite) — treat it as not usable today. Also loud:
// the CSS Color 4 function space in Bun.color — lab()/lch()/oklab()/oklch()/
// color() throw rather than returning the `null` that means "not a colour"
// (bun-text.js); a Bun.FileSystemRouter `style` other than "nextjs", a page file
// whose brackets do not parse, two page files resolving to the SAME route (Next.js
// calls that a project error, and picking a winner by directory-iteration order is
// not a shim's call), and .match() on a Request/Response whose `url` is "" (which
// would otherwise quietly resolve to the index route) — bun-fsrouter.js. Likewise
// Bun.Glob.scan({followSymlinks: true}) against a filesystem with no realpathSync:
// there is no cycle guard without it, and the failure is a walk that never returns
// rather than a wrong answer — bun-glob.js.
//
// COVERED BUT SLOWER, not wrong: Bun.allocUnsafe returns zero-filled memory,
// because `new Uint8Array(n)` is specified to be — see bun-bytes.js.

import { transpileTypeScript } from "../typescript-transform.js";
// The data-format, text/terminal, bytes/streams, hash and glob members live in
// their own files: this one is already long, and each group is self-contained
// pure computation pinned by its own checks. See the header of each for why they
// are not inline here, and bun-formats.js in particular for the vendoring
// rationale per format.
import { createBunFormats } from "./bun-formats.js";
import { createBunText } from "./bun-text.js";
import { createBunBytes } from "./bun-bytes.js";
import * as hashes from "./bun-hash.js";
import { createBunGlob } from "./bun-glob.js";
import { createBunFileSystemRouter } from "./bun-fsrouter.js";
import { createSleepSync } from "./bun-sleep.js";
import { loadBunEnvFiles } from "./bun-env.js";

// The two documented Bun.hash members we did not port. The message names the
// algorithm and says why, in the same spirit as the bun:ffi one: a caller who hits
// this needs to know it is absent, not that "something went wrong".
const HASH_UNSUPPORTED = (name) =>
  `Bun.hash.${name}() is not implemented in the Vivari shim. The other members ` +
  `(wyhash, crc32, adler32, xxHash32/64, murmur32v2/v3, murmur64v2, cityHash32/64) ` +
  `are byte-exact; ${name} is omitted rather than approximated because we have no ` +
  `reference vector to verify a port against.`;

// ---- version identity -------------------------------------------------------
// The single definition of what this shim claims to be. `Bun.revision` is derived
// from the version rather than being its own literal: `bun --revision` prints the
// same string (packages/kernel-host/programs/bun.js), and the two used to disagree
// ("vivari-shim" here vs "1.1.34-vivari" there). Real Bun prints a git SHA; we
// cannot, so we print something that is at least self-consistent and obviously a
// shim. The CLI program cannot import this (it is embedded as a template literal
// with no interpolation), so it carries a fallback literal that
// scripts/spike-bun-offline.mjs asserts against BUN_VERSION.
export const BUN_VERSION = "1.1.34";
export const BUN_REVISION = BUN_VERSION + "-vivari";

const TRANSPILER_SCAN_UNSUPPORTED = (method) =>
  "Bun.Transpiler." +
  method +
  "() is not implemented in the Vivari shim: it is backed by the loader's " +
  "type-stripping transform, which does not parse an import/export graph. It " +
  "used to return an empty result, which was indistinguishable from a file with " +
  "no imports.";

export function createBunRuntime({ process, Buffer, require }) {
  const lazy = (name) => require(name);

  // Text/terminal and bytes/streams member groups (packages/runtime/builtins/
  // bun-text.js, bun-bytes.js). Constructing these is cheap — the vendored Unicode
  // tables inside bun-text.js are instantiated on first use, not here.
  const text = createBunText({ lazy, process });
  const bytes = createBunBytes({ Buffer });
  // Glob and FileSystemRouter take `lazy`/`process` because their scan half walks
  // the VFS (one synchronous syscall per directory) — the matcher halves stay pure
  // and are unit-tested with no kernel. FileSystemRouter's scan IS Glob's walker.
  const { Glob } = createBunGlob({ lazy, process });
  const FileSystemRouter = createBunFileSystemRouter({ lazy, process });

  // ---- BunFile ---------------------------------------------------------------
  // `Bun.file(path)` is a lazy handle; reads/writes hit the VFS through `fs`.
  //
  // `Bun.file(fd)` is deliberately NOT supported. Bun's overload wraps a real OS
  // file descriptor, and there are none here: our fd numbers are indices into the
  // runtime's own VFS descriptor table, and a BunFile is defined by a path it can
  // re-open. Coercing the number to a string (what this used to do) turned
  // `Bun.file(3)` into the relative path "3" — a silent wrong answer that only
  // surfaces as a confusing ENOENT much later. Throw instead.
  class BunFile {
    constructor(pathOrFd, options) {
      if (typeof pathOrFd === "number") {
        throw new TypeError(
          "Bun.file(fd) is not supported in Vivari: file descriptors here are VFS " +
            "handles owned by the runtime, not OS file descriptors, so there is no " +
            "file to open. Use Bun.file(path) instead."
        );
      }
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
    // Bun's documented `error(err)` hook. It gets the throw from `fetch`/a route
    // handler and returns the Response to render; returning nothing (or throwing)
    // falls back to the plain 500 below, which is what this always did before.
    let errorHandler = typeof opts.error === "function" ? opts.error : null;
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

    async function writeResponse(res, response) {
      res.statusCode = response.status || 200;
      try { response.headers.forEach((v, k) => res.setHeader(k, v)); } catch {}
      const ab = await response.arrayBuffer();
      res.end(Buffer.from(new Uint8Array(ab)));
    }

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
            await writeResponse(res, response);
          })
          .catch((err) =>
            resolveServeError(errorHandler, err)
              .then((response) => (res.headersSent ? res.end() : writeResponse(res, response)))
              .catch(() => { try { res.statusCode = 500; res.end("Bun.serve handler error"); } catch {} })
          );
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
        if (typeof next.error === "function") errorHandler = next.error;
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
  // Bun.hash is wyhash, and the digests are part of its contract: people put them
  // in cache keys and shard ids, so "stable within this process" is not good
  // enough. The algorithms live in bun-hash.js (they are bulk, and each one has to
  // be byte-exact); this block is just the wiring, and its job is to get the two
  // things the digest cannot tell you about right — the return TYPE and the seed.
  //
  // Documented typing, which we reproduce exactly: 32-bit hashes return a
  // `number`, 64-bit hashes return a `bigint`. That distinction is load-bearing.
  // `Bun.hash("x") + 1` throws a TypeError under real Bun (you cannot mix BigInt
  // and Number) and a shim that hands back a Number instead makes that line
  // "work" here and fail in production — the same class of bug as everything else
  // in this file's history. A bare Bun.hash() is wyhash, so it is a bigint too.
  function bunHash(data, seed) {
    return hashes.wyhash(toBuf(data, Buffer), seed);
  }
  bunHash.wyhash = (data, seed) => hashes.wyhash(toBuf(data, Buffer), seed);
  bunHash.xxHash32 = (data, seed) => hashes.xxHash32(toBuf(data, Buffer), seed);
  bunHash.xxHash64 = (data, seed) => hashes.xxHash64(toBuf(data, Buffer), seed);
  bunHash.murmur32v2 = (data, seed) => hashes.murmur32v2(toBuf(data, Buffer), seed);
  bunHash.murmur32v3 = (data, seed) => hashes.murmur32v3(toBuf(data, Buffer), seed);
  bunHash.murmur64v2 = (data, seed) => hashes.murmur64v2(toBuf(data, Buffer), seed);
  // cityHash32 takes no seed at all in Bun's typings — `(data) => number`. We
  // accept one and ignore it (the reference implementation has no seeded form)
  // rather than inventing a seeded variant nothing else would agree with.
  bunHash.cityHash32 = (data) => hashes.cityHash32(toBuf(data, Buffer));
  bunHash.cityHash64 = (data, seed) => hashes.cityHash64(toBuf(data, Buffer), seed);
  // xxHash3 and rapidhash are documented members we have NOT ported. XXH3 is a
  // much bigger construction than everything else here combined, and rapidhash is
  // not in Zig's standard library, so there is no reference we can pin a
  // known-answer test against — and an unverified hash is exactly the bug this
  // change removes. Loud beats plausible-looking; same tier as bun:ffi.
  bunHash.xxHash3 = () => { throw new Error(HASH_UNSUPPORTED("xxHash3")); };
  bunHash.rapidhash = () => { throw new Error(HASH_UNSUPPORTED("rapidhash")); };
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
  // A real park on Atomics.wait (see ./bun-sleep.js), not the spin this used to
  // be: same elapsed time, without holding a core at 100% for the duration.
  const sleepSync = createSleepSync();
  const startNs = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  const nanoseconds = () => Math.round(((typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) - startNs) * 1e6);

  // Bun.resolveSync(specifier, root) / Bun.resolve(...) — `root` is the DIRECTORY
  // to resolve from ("To resolve relative to the directory containing the current
  // file, pass import.meta.dir"), not the importing file; import.meta.resolveSync
  // takes the importing file instead and is documented as
  // `Bun.resolveSync(id, path.dirname(parent))`, which is why esm.js takes a
  // dirname and this does not. `root` used to be accepted and then dropped, so
  // every call resolved from the runtime's own base instead: a real-looking
  // absolute path to a different file, which is the exact failure mode this shim
  // is not allowed to have. With no resolver at all we throw rather than echo the
  // specifier back, for the same reason — Bun throws when it cannot resolve.
  const bunResolveSync = (id, root) => {
    if (!require.resolve) {
      throw new Error(
        "Bun.resolveSync is unavailable: the Bun global was created on a require with no " +
          "resolver attached, so module specifiers cannot be resolved in this process"
      );
    }
    if (root === undefined || root === null) return require.resolve(id);
    return require.resolve(id, { paths: [String(root)] });
  };

  const deepEquals = (a, b, strict) => bunDeepEquals(a, b, !!strict);
  const deepMatch = (subset, object) => bunDeepMatch(subset, object);
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
  const formats = createBunFormats({ process });
  const Bun = {
    version: BUN_VERSION,
    revision: BUN_REVISION,
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
    deepMatch,
    Glob,
    FileSystemRouter,
    escapeHTML,
    // Data formats (see ./bun-formats.js). Real parsers, not approximations:
    // Bun.TOML.parse throws on an integer it cannot hold losslessly, Bun.YAML.parse
    // returns an array for multi-document input, and Bun.JSONL's two entry points
    // report errors differently on purpose.
    YAML: formats.YAML,
    TOML: formats.TOML,
    JSON5: formats.JSON5,
    JSONL: formats.JSONL,
    semver: formats.semver,
    // Bun.inspect keeps delegating to util.inspect, but is now a function object
    // carrying .table and .custom (see bun-text.js).
    inspect: text.inspect,
    // Text / terminal (bun-text.js).
    stringWidth: text.stringWidth,
    stripANSI: text.stripANSI,
    wrapAnsi: text.wrapAnsi,
    indexOfLine: text.indexOfLine,
    color: text.color,
    // Bytes / streams (bun-bytes.js).
    ArrayBufferSink: bytes.ArrayBufferSink,
    readableStreamToArray: bytes.readableStreamToArray,
    readableStreamToArrayBuffer: bytes.readableStreamToArrayBuffer,
    readableStreamToBytes: bytes.readableStreamToBytes,
    readableStreamToBlob: bytes.readableStreamToBlob,
    readableStreamToText: bytes.readableStreamToText,
    readableStreamToJSON: bytes.readableStreamToJSON,
    readableStreamToFormData: bytes.readableStreamToFormData,
    concatArrayBuffers: bytes.concatArrayBuffers,
    allocUnsafe: bytes.allocUnsafe,
    gzipSync: zlibSync("gzipSync"),
    gunzipSync: zlibSync("gunzipSync"),
    deflateSync: zlibSync("deflateSync"),
    inflateSync: zlibSync("inflateSync"),
    fileURLToPath,
    pathToFileURL,
    resolveSync: (id, root) => bunResolveSync(id, root),
    resolve: async (id, root) => bunResolveSync(id, root),
    randomUUIDv7: (encoding, timestamp) => randomUUIDv7(lazy("crypto"), Buffer, encoding, timestamp),
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

  // ---- automatic .env loading (see ./bun-env.js) ------------------------------
  // Bun reads `.env`, `.env.{mode}`, `.env.local` and `.env.{mode}.local` at
  // startup; our "startup" is the moment the Bun runtime is installed into a
  // process (index.js's __ocInstallBun), which only ever happens for a `bun`
  // process. It is deliberately NOT done for `node`: automatic loading is Bun's
  // behaviour, not Node's — Node requires an explicit `--env-file` — and Bun
  // itself turns it off when invoked AS node (`bun --bun`, a `node` symlink), for
  // the same reason we do. Once per process; a second install is a no-op.
  //
  // `mode` forces the file set instead of deriving it from NODE_ENV; `bun test` is
  // the one caller that needs it, because Bun picks the `test` set before NODE_ENV
  // is defaulted to "test" (see kernel-host/programs/bun.js).
  let dotenvLoaded = null;
  function loadDotenv(mode) {
    if (dotenvLoaded) return dotenvLoaded;
    const fs = lazy("fs");
    dotenvLoaded = loadBunEnvFiles({
      env: process.env,
      cwd: process.cwd(),
      mode,
      readFile: (p) => {
        try { return fs.readFileSync(p, "utf8"); } catch { return null; }
      },
    });
    return dotenvLoaded;
  }

  return { Bun, modules, loadDotenv };

  function makeTranspilerClass() {
    return class Transpiler {
      constructor(opts) { this._opts = opts || {}; }
      transformSync(code, loaderOrOpts) {
        const loader = typeof loaderOrOpts === "string" ? loaderOrOpts : (this._opts.loader || "tsx");
        const ext = loader === "ts" ? ".ts" : loader === "jsx" ? ".jsx" : loader === "js" ? ".js" : ".tsx";
        return transpileTypeScript(code, "input" + ext);
      }
      async transform(code, loader) { return this.transformSync(code, loader); }
      // scan()/scanImports() used to return hard-coded empties, which reads as "this
      // file imports nothing" — a wrong answer a caller cannot detect. The transform
      // in typescript-transform.js is a type-stripper, not a parser: it never builds
      // an import/export graph, so there is nothing honest to return. Fail loudly.
      scan() { throw new Error(TRANSPILER_SCAN_UNSUPPORTED("scan")); }
      scanImports() { throw new Error(TRANSPILER_SCAN_UNSUPPORTED("scanImports")); }
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
  // Bun/Jest `only` semantics are global, not per-suite: registering a single
  // test.only anywhere narrows the whole run to the `only` tests. This flag is why
  // it has to be tracked at registration time — by the time __run() walks the tree
  // the suites are already built.
  let hasOnly = false;
  const test = (name, fn, opts) => {
    const t = { name, fn, skip: !!(opts && opts.skip), only: !!(opts && opts.only) };
    if (t.only) hasOnly = true;
    if (current) current.tests.push(t);
    else suites.push({ name: "", tests: [t], hooks: emptyHooks() });
  };
  test.skip = (name, fn) => test(name, fn, { skip: true });
  test.todo = (name) => test(name, () => {}, { skip: true });
  test.only = (name, fn) => test(name, fn, { only: true });
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
      // With an `only` registered, everything else is filtered out silently rather
      // than reported as skipped: `only` is a focus tool, and printing the suite you
      // asked not to run defeats it. Suites with nothing selected are skipped whole,
      // so their beforeAll/afterAll do not run either.
      const selected = (t) => (hasOnly ? t.only : true);
      const suiteSelected = (s) => s.tests.some(selected) || (s.children || []).some(suiteSelected);

      // `each` hooks inherit down the describe tree, root hooks included. Order is
      // Jest's: beforeEach outermost-first, afterEach innermost-first.
      const runSuite = async (suite, prefix, outerBeforeEach, outerAfterEach) => {
        if (!suiteSelected(suite)) return;
        const beforeEach = outerBeforeEach.concat(suite.hooks.beforeEach);
        const afterEach = suite.hooks.afterEach.concat(outerAfterEach);
        for (const fn of suite.hooks.beforeAll) await fn();
        for (const t of suite.tests) {
          if (!selected(t)) continue;
          const label = (prefix ? prefix + " > " : "") + t.name;
          // A skipped test must not run the hooks either — this used to run
          // beforeEach and then `continue` past afterEach, leaving them unpaired.
          if (t.skip) { write("  - " + label + " (skipped)\n"); continue; }
          for (const fn of beforeEach) await fn();
          try { await t.fn(); write("  \u2713 " + label + "\n"); pass++; }
          catch (e) { write("  \u2717 " + label + "\n    " + ((e && e.message) || e) + "\n"); fail++; }
          for (const fn of afterEach) await fn();
        }
        for (const child of suite.children || []) {
          await runSuite(child, (prefix ? prefix + " > " : "") + child.name, beforeEach, afterEach);
        }
        for (const fn of suite.hooks.afterAll) await fn();
      };

      for (const fn of rootHooks.beforeAll) await fn();
      for (const s of suites) await runSuite(s, s.name, rootHooks.beforeEach, rootHooks.afterEach);
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
    // toEqual is loose deepEquals and toStrictEqual is strict — that is the
    // documented contract, and until now both called the same key-count compare,
    // so toStrictEqual accepted input real Bun rejects.
    toEqual(v) { assert(negate, bunDeepEquals(received, v, false), `expected ${fmt(received)} to equal ${fmt(v)}`); },
    toStrictEqual(v) { assert(negate, bunDeepEquals(received, v, true), `expected ${fmt(received)} to strictly equal ${fmt(v)}`); },
    toMatchObject(subset) { assert(negate, bunDeepMatch(subset, received), `expected ${fmt(received)} to match object ${fmt(subset)}`); },
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
//
// The memory helpers follow the bun:ffi pattern below: exported so an
// `import { heapSize } from "bun:jsc"` still loads, loud on call. They used to
// answer 0 / {current: 0, peak: 0}, which a memory-budget check reads as "nothing
// is allocated" and happily passes. No engine exposes heap introspection to page
// JavaScript, so there is no number we could return honestly.
function makeBunJsc() {
  const noHeapIntrospection = (name) => () => {
    throw new Error(
      "bun:jsc." + name + "() is not supported in Vivari (browser sandbox): the " +
        "JavaScript engine exposes no heap-introspection hook to page code."
    );
  };
  return {
    serialize: (v) => new Uint8Array(Buffer.from(JSON.stringify(v), "utf8")),
    deserialize: (b) => JSON.parse(Buffer.from(b).toString("utf8")),
    estimateShallowMemoryUsageOf: noHeapIntrospection("estimateShallowMemoryUsageOf"),
    heapSize: noHeapIntrospection("heapSize"),
    memoryUsage: noHeapIntrospection("memoryUsage"),
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

// ---- Bun.randomUUIDv7 -------------------------------------------------------
// This used to be `crypto.randomUUID()`, which is a v4 — 122 bits of randomness
// and nothing else. The entire reason to reach for v7 is that the first 48 bits
// are a big-endian millisecond timestamp, so the ids sort in creation order and
// stay friendly to a B-tree primary key. Aliasing v4 gives you a string of the
// right shape that fails at the one job you picked it for, and nothing in the
// type or the format tells you: you find out when your index fragments.
//
// Layout is RFC 9562 §5.7: 48-bit unix_ts_ms, version nibble 7, a 12-bit
// counter, the 2-bit variant, then 62 bits of CSPRNG.
//
//   0                   1                   2                   3
//   |         unix_ts_ms (48)          |ver|  rand_a (12)  |var| rand_b (62) |
//
// Monotonicity within a millisecond is the part naive implementations skip.
// Bun's documented rule: when the clock advances, reseed the counter to a random
// value with the high bit CLEAR (so at least 2048 increments remain before it
// rolls); when it has not advanced, reuse the last timestamp and increment; if
// the counter would roll over, bump the emitted timestamp rather than wrapping,
// so output is strictly increasing even under a burst.
const uuidState = { ts: 0, counter: 0 };
// An explicit `timestamp` argument tracks its own counter and neither reads nor
// disturbs the default path's state — otherwise passing a historical timestamp
// would drag the monotonic clock backwards for every subsequent default call.
const uuidExplicitState = { ts: -1, counter: 0 };

// Seed a fresh counter: 12 bits with the high bit clear, so at least 2048
// increments remain before it can roll.
const uuidSeedCounter = (crypto) => crypto.randomBytes(2).readUInt16BE(0) & 0x7ff;

function randomUUIDv7(crypto, Buffer, encoding, timestamp) {
  // Overload: randomUUIDv7(timestamp) with no encoding.
  if (typeof encoding === "number") { timestamp = encoding; encoding = undefined; }
  const enc = encoding == null ? "hex" : encoding;

  const explicit = timestamp != null;
  const state = explicit ? uuidExplicitState : uuidState;
  let ts = explicit ? Number(timestamp) : Date.now();

  // The two paths run the same counter machinery but differ on what counts as
  // "new", and the difference is documented rather than incidental. The default
  // path is driven by a clock that only moves forward, so anything that is not
  // strictly later is treated as the same instant and clamped to the last emitted
  // timestamp — that clamp is what makes the default sequence strictly increasing
  // even when Date.now() stalls or steps back. An explicit timestamp is instead
  // encoded VERBATIM and any change to it reseeds: the caller asked for that exact
  // instant, so clamping it forward would hand back an id for a different one.
  const fresh = explicit ? ts !== state.ts : ts > state.ts;

  if (fresh) {
    state.ts = ts;
    state.counter = uuidSeedCounter(crypto);
  } else {
    ts = state.ts;
    state.counter++;
    if (state.counter > 0xfff) {
      // Rolling the counter would emit a smaller id than the previous one, so
      // move the timestamp forward instead. Sortability wins over clock accuracy.
      state.ts = ts = ts + 1;
      state.counter = uuidSeedCounter(crypto);
    }
  }

  const bytes = Buffer.alloc(16);
  // 48-bit big-endian millisecond timestamp. writeUIntBE tops out at 6 bytes,
  // which is exactly what we need.
  bytes.writeUIntBE(ts, 0, 6);
  bytes[6] = 0x70 | ((state.counter >> 8) & 0x0f); // version 7 + counter high nibble
  bytes[7] = state.counter & 0xff;
  const rand = crypto.randomBytes(8);
  rand.copy(bytes, 8);
  bytes[8] = 0x80 | (bytes[8] & 0x3f); // variant 0b10

  if (enc === "buffer") return bytes;
  if (enc === "base64") return bytes.toString("base64");
  if (enc === "base64url") return bytes.toString("base64url");
  if (enc !== "hex") {
    throw new TypeError(`Bun.randomUUIDv7: unknown encoding ${JSON.stringify(enc)} (expected "hex", "base64", "base64url" or "buffer")`);
  }
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---- Bun.deepEquals / Bun.deepMatch -----------------------------------------
// This used to be a key-count plus recursive compare that ACCEPTED the `strict`
// argument and ignored it. That is worse than it sounds, because `strict` is not
// a nicety here: `expect().toEqual()` is documented as loose deepEquals and
// `expect().toStrictEqual()` as strict, so a shim where the two are identical
// makes toStrictEqual pass on input real Bun rejects. For a test-runner shim that
// is the worst possible direction to be wrong in — the suite goes green here and
// red in CI, which is precisely the failure mode a sandbox is supposed to prevent.
//
// The documented loose-vs-strict difference is narrow and specific
// (https://bun.com/docs/runtime/utils#bun-deepequals). Strict additionally treats
// as UNEQUAL: properties explicitly set to `undefined` (`{}` vs `{a: undefined}`),
// `undefined` padding in arrays (`["asdf"]` vs `["asdf", undefined]`), a sparse
// hole vs an explicit `undefined` (`[, 1]` vs `[undefined, 1]`), and a class
// instance vs an object literal with the same properties (prototype identity).
// Everything else below applies in both modes and was simply missing before: the
// old version had no Map/Set/Date/RegExp/TypedArray handling, said NaN !== NaN,
// and compared `[1, 2]` equal to `{0: 1, 1: 2}` because it only counted keys.
export function bunDeepEquals(a, b, strict) {
  if (a === b) return true;
  // NaN is the one primitive where === is not the right answer: Bun.deepEquals
  // and every toEqual-style matcher treat NaN as equal to itself.
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;

  // An array is never equal to a plain object, however similar their keys look.
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const ta = Object.prototype.toString.call(a);
  if (ta !== Object.prototype.toString.call(b)) return false;

  if (ta === "[object Date]") {
    const x = a.getTime(), y = b.getTime();
    return x === y || (Number.isNaN(x) && Number.isNaN(y));
  }
  if (ta === "[object RegExp]") return a.source === b.source && a.flags === b.flags;
  if (ta === "[object Error]" || a instanceof Error) return a.name === b.name && a.message === b.message;

  if (ArrayBuffer.isView(a) && !(a instanceof DataView)) {
    if (a.constructor !== b.constructor || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  if (a instanceof ArrayBuffer || a instanceof DataView) {
    const x = new Uint8Array(a instanceof DataView ? a.buffer : a, a.byteOffset || 0, a.byteLength);
    const y = new Uint8Array(b instanceof DataView ? b.buffer : b, b.byteOffset || 0, b.byteLength);
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }

  if (a instanceof Map) {
    if (a.size !== b.size) return false;
    // Keys may themselves be structures, so a .get() lookup is not sufficient in
    // general; fall back to a pairwise search only when the fast path misses.
    outer: for (const [k, v] of a) {
      if (b.has(k)) { if (bunDeepEquals(v, b.get(k), strict)) continue; return false; }
      for (const [k2, v2] of b) {
        if (bunDeepEquals(k, k2, strict) && bunDeepEquals(v, v2, strict)) continue outer;
      }
      return false;
    }
    return true;
  }
  if (a instanceof Set) {
    if (a.size !== b.size) return false;
    outer: for (const v of a) {
      if (b.has(v)) continue;
      for (const v2 of b) if (bunDeepEquals(v, v2, strict)) continue outer;
      return false;
    }
    return true;
  }

  if (Array.isArray(a)) {
    if (strict) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        // A hole and an explicit undefined are different values in strict mode.
        if ((i in a) !== (i in b)) return false;
        if (!bunDeepEquals(a[i], b[i], strict)) return false;
      }
      return true;
    }
    // Loose mode ignores trailing/undefined padding, so reading past the end
    // (which yields undefined) is the behaviour we want, not a bug.
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) if (!bunDeepEquals(a[i], b[i], strict)) return false;
    return true;
  }

  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;

  // In loose mode an own property whose value is undefined is indistinguishable
  // from an absent one; in strict mode it is not.
  const keys = (o) => (strict ? Object.keys(o) : Object.keys(o).filter((k) => o[k] !== undefined));
  const ka = keys(a), kb = keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) && strict) return false;
    if (!bunDeepEquals(a[k], b[k], strict)) return false;
  }
  return true;
}

// Bun.deepMatch(subset, object) — true when every property in `subset` exists in
// `object` with an equal value. This is what powers expect().toMatchObject().
// Note the argument order is (subset, object), which is the reverse of how the
// matcher reads; getting it backwards silently inverts the assertion.
export function bunDeepMatch(subset, object) {
  if (subset === null || typeof subset !== "object") return bunDeepEquals(subset, object, false);
  if (object === null || typeof object !== "object") return false;

  if (Array.isArray(subset)) {
    if (!Array.isArray(object) || subset.length !== object.length) return false;
    return subset.every((v, i) => bunDeepMatch(v, object[i]));
  }
  // Only plain objects are treated as "subsets"; a Date/Map/Set/TypedArray on the
  // subset side is compared whole, because a partial Date is meaningless.
  if (Object.prototype.toString.call(subset) !== "[object Object]") {
    return bunDeepEquals(subset, object, false);
  }
  for (const k of Object.keys(subset)) {
    if (!(k in object)) return false;
    if (!bunDeepMatch(subset[k], object[k])) return false;
  }
  return true;
}

// ---- Bun.serve error rendering ----------------------------------------------
// What Bun.serve renders when a `fetch`/route handler throws. Bun hands the error
// to the server's `error(err)` option and serves whatever Response it returns; if
// there is no handler, or it declines by returning nothing, or it throws in turn,
// we fall back to the shim's original hard-coded 500 (so the pre-`error` behaviour
// is exactly preserved). Exported because this precedence is pure logic and
// spike-bun-offline.mjs must be able to test it without binding a port.
export async function resolveServeError(errorHandler, err) {
  if (typeof errorHandler === "function") {
    try {
      const response = await errorHandler(err);
      if (response) return response;
    } catch (handlerErr) {
      err = handlerErr;
    }
  }
  return new Response("Bun.serve handler error: " + ((err && err.message) || err), { status: 500 });
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