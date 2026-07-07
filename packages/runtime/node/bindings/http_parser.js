// internalBinding('http_parser') — the HTTP/1.x message parser beneath Node's
// real lib/_http_common.js / _http_server.js / _http_client.js (Phase 2 #8).
//
// In Node this is llhttp behind a C++ binding (node_http_parser.cc). Here we ship
// a **pure-JS HTTP/1.1 parser** exposing the same JS-facing contract the vendored
// lib/ speaks: an HTTPParser with numeric callback slots (kOnHeadersComplete,
// kOnBody, kOnMessageComplete, …) that lib/ assigns, plus initialize()/execute().
//
// We deliberately do NOT advertise `isStreamBase` on our TCP handle, so
// _http_server takes the slow path — `socket.on('data') -> parser.execute(buf)` —
// instead of the native `parser.consume(handle)` fast path. That keeps this a
// simple, self-contained byte->event parser. Compiling llhttp to Wasm and wiring
// consume() is a later drop-in optimization (roadmap: Rust sinks after the
// contract stabilizes).
//
// Scope: HTTP/1.0 + 1.1 request & response parsing, Content-Length + chunked +
// EOF-delimited bodies, keep-alive/close detection, header pairs. Trailers and
// upgrade are detected but WebSocket framing is out of scope for now.

export function createHttpParserBinding() {
  const B = () => globalThis.Buffer;

  // Callback slot indices (lib/ does `parser[kOnHeadersComplete] = fn`).
  const kOnMessageBegin = 0;
  const kOnHeaders = 1;
  const kOnHeadersComplete = 2;
  const kOnBody = 3;
  const kOnMessageComplete = 4;
  const kOnExecute = 5;
  const kOnTimeout = 6;

  const REQUEST = 1;
  const RESPONSE = 2;

  const CR = 13;
  const LF = 10;

  // llhttp method table order — `allMethods[n]` must round-trip the number we emit.
  const allMethods = [
    "DELETE", "GET", "HEAD", "POST", "PUT", "CONNECT", "OPTIONS", "TRACE",
    "COPY", "LOCK", "MKCOL", "MOVE", "PROPFIND", "PROPPATCH", "SEARCH",
    "UNLOCK", "BIND", "REBIND", "UNBIND", "ACL", "REPORT", "MKACTIVITY",
    "CHECKOUT", "MERGE", "M-SEARCH", "NOTIFY", "SUBSCRIBE", "UNSUBSCRIBE",
    "PATCH", "PURGE", "MKCALENDAR", "LINK", "UNLINK", "SOURCE", "PRI",
    "DESCRIBE", "ANNOUNCE", "SETUP", "PLAY", "PAUSE", "TEARDOWN",
    "GET_PARAMETER", "SET_PARAMETER", "REDIRECT", "RECORD", "FLUSH", "QUERY",
  ];
  const methodToNum = new Map(allMethods.map((m, i) => [m, i]));

  // Statuses that carry no response body regardless of headers.
  const NO_BODY_STATUS = new Set([204, 205, 304]);

  const EMPTY = () => B().alloc(0);

  class HTTPParser {
    constructor() {
      this.socket = null;
      this.incoming = null;
      this.maxHeaderPairs = 2000;
      this._reset(REQUEST);
    }

    initialize(type, resource, maxHeaderSize, lenient, connectionsList) {
      this._type = type;
      this.maxHeaderSize = maxHeaderSize || 80 * 1024;
      this._resource = resource;
      this._reset(type);
      return 0;
    }

    _reset(type) {
      if (type !== undefined) this._type = type;
      this._pending = EMPTY();
      this._phase = "HEADERS"; // HEADERS | BODY_CL | BODY_CHUNK | BODY_EOF | DONE
      this._headers = [];
      this._url = "";
      this._major = 1;
      this._minor = 1;
      this._method = -1;
      this._statusCode = 0;
      this._statusMessage = "";
      this._contentLength = null;
      this._chunked = false;
      this._bodyRemaining = 0;
      this._chunkRemaining = 0;
      this._chunkState = "SIZE"; // SIZE | DATA | CRLF | TRAILER
      this._skipBody = false;
      this._connClose = false;
      this._connKeepAlive = false;
      this._upgrade = false;
      this._hasUpgradeHeader = false;
      this.incoming = null;
    }

    // Called by lib/ to attach to a StreamBase handle (fast path). We never
    // advertise isStreamBase, so this is not used — keep no-ops for the API.
    consume() {}
    unconsume() {}
    remove() {}
    free() {}
    pause() {}
    resume() {}
    getCurrentBuffer() {
      return this._pending || EMPTY();
    }

    // Signal EOF from the socket. Completes an EOF-delimited response body.
    finish() {
      if (this._phase === "BODY_EOF") {
        this._complete();
      }
      return 0;
    }

    execute(chunk) {
      // Accumulate; parse as much as possible. Returns bytes consumed (all of
      // this chunk on success) or an Error on malformed input.
      const buf = B().isBuffer(chunk) ? chunk : B().from(chunk);
      this._pending = this._pending.length ? B().concat([this._pending, buf]) : buf;
      const consumed = buf.length;

      try {
        let progress = true;
        while (progress && this._pending.length) {
          progress = false;
          if (this._phase === "HEADERS") {
            const end = this._indexOfHeaderEnd(this._pending);
            if (end === -1) break; // need more bytes
            const headerBlock = this._pending.toString("latin1", 0, end);
            this._pending = this._pending.subarray(end);
            const err = this._parseHeaderBlock(headerBlock);
            if (err) return err;
            this._afterHeaders();
            progress = true;
          } else if (this._phase === "BODY_CL") {
            progress = this._pumpContentLength();
          } else if (this._phase === "BODY_CHUNK") {
            progress = this._pumpChunked();
          } else if (this._phase === "BODY_EOF") {
            if (this._pending.length) {
              this._emitBody(this._pending);
              this._pending = EMPTY();
            }
            break; // completes only on finish()
          } else {
            break;
          }
        }
      } catch (e) {
        return e instanceof Error ? e : new Error(String(e));
      }
      return consumed;
    }

    // ---- header parsing ----------------------------------------------------

    _indexOfHeaderEnd(buf) {
      // find CRLFCRLF (also tolerate bare LFLF)
      for (let i = 3; i < buf.length; i++) {
        if (buf[i] === LF && buf[i - 1] === CR && buf[i - 2] === LF && buf[i - 3] === CR) {
          return i + 1;
        }
      }
      // lenient: LF LF
      for (let i = 1; i < buf.length; i++) {
        if (buf[i] === LF && buf[i - 1] === LF) return i + 1;
      }
      return -1;
    }

    _parseHeaderBlock(block) {
      const lines = block.split(/\r?\n/);
      // drop trailing empty segments from the CRLFCRLF terminator
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      if (!lines.length) return new Error("HPE_INVALID_CONSTANT: empty message");

      const startLine = lines[0];
      if (this._type === RESPONSE) {
        // HTTP/1.1 200 OK
        const m = /^HTTP\/(\d)\.(\d)\s+(\d{3})\s*(.*)$/.exec(startLine);
        if (!m) return new Error("HPE_INVALID_VERSION: bad status line");
        this._major = +m[1];
        this._minor = +m[2];
        this._statusCode = +m[3];
        this._statusMessage = m[4] || "";
      } else {
        // METHOD SP request-target SP HTTP/1.1
        const sp1 = startLine.indexOf(" ");
        const sp2 = startLine.lastIndexOf(" ");
        if (sp1 <= 0 || sp2 <= sp1) return new Error("HPE_INVALID_METHOD: bad request line");
        const method = startLine.slice(0, sp1);
        this._url = startLine.slice(sp1 + 1, sp2);
        const ver = /^HTTP\/(\d)\.(\d)$/.exec(startLine.slice(sp2 + 1));
        if (!ver) return new Error("HPE_INVALID_VERSION: bad request line");
        this._major = +ver[1];
        this._minor = +ver[2];
        const num = methodToNum.get(method);
        this._method = num === undefined ? allMethods.length + 0 : num;
        if (num === undefined) {
          // unknown method: register it so allMethods[n] round-trips
          allMethods.push(method);
          methodToNum.set(method, allMethods.length - 1);
          this._method = allMethods.length - 1;
        }
      }

      const headers = this._headers;
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line === "") continue;
        // obsolete line folding (leading WS) -> append to previous value
        if ((line[0] === " " || line[0] === "\t") && headers.length >= 2) {
          headers[headers.length - 1] += " " + line.trim();
          continue;
        }
        const colon = line.indexOf(":");
        if (colon <= 0) return new Error("HPE_INVALID_HEADER_TOKEN: bad header");
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        headers.push(key, value);
        this._scanSpecialHeader(key, value);
      }
      return null;
    }

    _scanSpecialHeader(key, value) {
      const k = key.toLowerCase();
      if (k === "content-length") {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) this._contentLength = n;
      } else if (k === "transfer-encoding") {
        if (/chunked/i.test(value)) this._chunked = true;
      } else if (k === "connection") {
        const v = value.toLowerCase();
        if (v.includes("close")) this._connClose = true;
        if (v.includes("keep-alive")) this._connKeepAlive = true;
        if (v.includes("upgrade")) this._upgrade = true;
      } else if (k === "upgrade") {
        this._hasUpgradeHeader = true;
      }
    }

    _afterHeaders() {
      const isHttp11 = this._major === 1 && this._minor === 1;
      const shouldKeepAlive = isHttp11 ? !this._connClose : this._connKeepAlive;
      this._shouldKeepAlive = shouldKeepAlive;
      const upgrade = !!(this._upgrade && this._hasUpgradeHeader);

      const cb = this[kOnHeadersComplete];
      let rv = 0;
      if (cb) {
        rv = cb.call(
          this,
          this._major,
          this._minor,
          this._headers, // flat [k,v,...]
          this._type === REQUEST ? this._method : undefined,
          this._type === REQUEST ? this._url : undefined,
          this._type === RESPONSE ? this._statusCode : undefined,
          this._type === RESPONSE ? this._statusMessage : undefined,
          upgrade,
          shouldKeepAlive,
        );
      }
      // rv: truthy => skip body (HEAD response / 1xx / etc.); 2 => skip + upgrade
      this._skipBody = rv === true || rv === 1 || rv === 2;
      this._headers = [];

      // Decide body framing.
      const noBodyByStatus =
        this._type === RESPONSE &&
        (this._statusCode < 200 || NO_BODY_STATUS.has(this._statusCode));

      if (this._skipBody || noBodyByStatus) {
        this._complete();
        return;
      }
      if (this._chunked) {
        this._phase = "BODY_CHUNK";
        this._chunkState = "SIZE";
        this._chunkRemaining = 0;
      } else if (this._contentLength !== null) {
        if (this._contentLength === 0) {
          this._complete();
        } else {
          this._phase = "BODY_CL";
          this._bodyRemaining = this._contentLength;
        }
      } else if (this._type === RESPONSE) {
        // No length + not chunked: body runs until the connection closes.
        this._phase = "BODY_EOF";
      } else {
        // Request without a body.
        this._complete();
      }
    }

    // ---- body pumps --------------------------------------------------------

    _pumpContentLength() {
      if (!this._pending.length) return false;
      const take = Math.min(this._bodyRemaining, this._pending.length);
      const slice = this._pending.subarray(0, take);
      this._pending = this._pending.subarray(take);
      this._bodyRemaining -= take;
      this._emitBody(slice);
      if (this._bodyRemaining === 0) {
        this._complete();
        return true;
      }
      return this._pending.length > 0;
    }

    _pumpChunked() {
      let advanced = false;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (this._chunkState === "SIZE") {
          const nl = this._indexOfCRLF(this._pending);
          if (nl === -1) break;
          const sizeLine = this._pending.toString("latin1", 0, nl).trim();
          this._pending = this._pending.subarray(nl + 2);
          const size = parseInt(sizeLine.split(";")[0], 16);
          if (Number.isNaN(size)) throw new Error("HPE_INVALID_CHUNK_SIZE");
          advanced = true;
          if (size === 0) {
            this._chunkState = "TRAILER";
          } else {
            this._chunkRemaining = size;
            this._chunkState = "DATA";
          }
        } else if (this._chunkState === "DATA") {
          if (!this._pending.length) break;
          const take = Math.min(this._chunkRemaining, this._pending.length);
          const slice = this._pending.subarray(0, take);
          this._pending = this._pending.subarray(take);
          this._chunkRemaining -= take;
          this._emitBody(slice);
          advanced = true;
          if (this._chunkRemaining === 0) this._chunkState = "CRLF";
        } else if (this._chunkState === "CRLF") {
          if (this._pending.length < 2) break;
          this._pending = this._pending.subarray(2); // skip trailing CRLF
          this._chunkState = "SIZE";
          advanced = true;
        } else if (this._chunkState === "TRAILER") {
          // Optional trailers, terminated by a blank line (CRLF).
          const nl = this._indexOfCRLF(this._pending);
          if (nl === -1) break;
          const line = this._pending.toString("latin1", 0, nl);
          this._pending = this._pending.subarray(nl + 2);
          advanced = true;
          if (line === "") {
            this._complete();
            break;
          } else {
            const colon = line.indexOf(":");
            if (colon > 0) {
              this._headers.push(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
            }
          }
        }
      }
      return advanced;
    }

    _indexOfCRLF(buf) {
      for (let i = 1; i < buf.length; i++) {
        if (buf[i] === LF && buf[i - 1] === CR) return i - 1;
      }
      return -1;
    }

    _emitBody(slice) {
      const cb = this[kOnBody];
      if (cb && slice.length) {
        // Copy: lib/ pushes this Buffer downstream and retains it.
        cb.call(this, B().from(slice));
      }
    }

    _complete() {
      const cb = this[kOnMessageComplete];
      if (cb) cb.call(this);
      // Reset for the next message on a kept-alive connection; keep leftover
      // bytes in _pending so pipelined requests parse on the next loop turn.
      const leftover = this._pending;
      this._reset(this._type);
      this._pending = leftover;
    }
  }

  HTTPParser.REQUEST = REQUEST;
  HTTPParser.RESPONSE = RESPONSE;
  HTTPParser.kOnMessageBegin = kOnMessageBegin;
  HTTPParser.kOnHeaders = kOnHeaders;
  HTTPParser.kOnHeadersComplete = kOnHeadersComplete;
  HTTPParser.kOnBody = kOnBody;
  HTTPParser.kOnMessageComplete = kOnMessageComplete;
  HTTPParser.kOnExecute = kOnExecute;
  HTTPParser.kOnTimeout = kOnTimeout;
  HTTPParser.kLenientNone = 0;
  HTTPParser.kLenientAll = 0xffff;

  // Native tracks per-connection header/request timeouts here; inert for us.
  class ConnectionsList {
    all() {
      return [];
    }
    idle() {
      return [];
    }
    active() {
      return [];
    }
    expired() {
      return [];
    }
  }

  return { methods: allMethods.slice(), allMethods, HTTPParser, ConnectionsList };
}
