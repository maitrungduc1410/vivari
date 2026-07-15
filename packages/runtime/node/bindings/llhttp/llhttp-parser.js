// internalBinding('http_parser'), Wasm edition — real llhttp behind the exact
// JS-facing contract Node's lib/_http_common.js speaks (numeric kOn* callback
// slots, initialize()/execute()/finish(), method round-trip via allMethods).
//
// This mirrors what Node's C++ node_http_parser.cc does: it drives llhttp's
// low-level span callbacks (on_url/on_status/on_header_field/on_header_value/
// on_body/on_headers_complete/on_message_complete) and folds them into the
// high-level events the pure-JS lib/ expects — for BOTH requests (server) and
// responses (client). undici only parses responses; we handle both.
//
// The Wasm module + its callbacks are shared per binding: llhttp_execute() runs
// synchronously and fires its callbacks re-entrantly, so a single `currentParser`
// pointer routes them to the active HTTPParser (same trick undici uses).

import { instantiate, LLHTTP_WASM_VERSION } from "./llhttp-wasm.js";
import {
  TYPE,
  ERROR,
  ERROR_OK,
  ERROR_PAUSED,
  ERROR_PAUSED_UPGRADE,
  METHODS,
} from "./constants.js";

export function createLlhttpBinding() {
  const B = () => globalThis.Buffer;

  // Callback slot indices (lib/ does `parser[kOnHeadersComplete] = fn`).
  const kOnMessageBegin = 0;
  const kOnHeaders = 1;
  const kOnHeadersComplete = 2;
  const kOnBody = 3;
  const kOnMessageComplete = 4;
  const kOnExecute = 5;
  const kOnTimeout = 6;

  const REQUEST = TYPE.REQUEST; // 1
  const RESPONSE = TYPE.RESPONSE; // 2

  // ---- shared Wasm instance + one growable input buffer in wasm memory ------
  let currentParser = null;
  let bufRef = null; // the JS Buffer currently being parsed (bytes mirror wasm)
  let bufPtr = 0; // wasm heap pointer of the copied input
  let bufSize = 0; // allocated wasm heap size

  // Slice a latin1 string out of the current input at wasm pointer `at`.
  function inputString(at, len) {
    const s = at - bufPtr;
    return bufRef.toString("latin1", s, s + len);
  }
  // Copy body bytes out of the current input (lib/ retains them downstream).
  function inputCopy(at, len) {
    const s = at - bufPtr;
    return B().from(bufRef.subarray(s, s + len));
  }

  const wasm = instantiate({
    env: {
      /* eslint-disable camelcase */
      wasm_on_message_begin(_p) {
        return currentParser ? currentParser._onMessageBegin() : 0;
      },
      wasm_on_url(_p, at, len) {
        return currentParser ? currentParser._onUrl(inputString(at, len)) : 0;
      },
      wasm_on_status(_p, at, len) {
        return currentParser ? currentParser._onStatus(inputString(at, len)) : 0;
      },
      wasm_on_header_field(_p, at, len) {
        return currentParser ? currentParser._onHeaderField(inputString(at, len)) : 0;
      },
      wasm_on_header_value(_p, at, len) {
        return currentParser ? currentParser._onHeaderValue(inputString(at, len)) : 0;
      },
      wasm_on_headers_complete(_p, statusCode, upgrade, shouldKeepAlive) {
        return currentParser
          ? currentParser._onHeadersComplete(statusCode, !!upgrade, !!shouldKeepAlive)
          : 0;
      },
      wasm_on_body(_p, at, len) {
        return currentParser ? currentParser._onBody(at, len) : 0;
      },
      wasm_on_message_complete(_p) {
        return currentParser ? currentParser._onMessageComplete() : 0;
      },
      /* eslint-enable camelcase */
    },
  });

  const EMPTY = () => B().alloc(0);

  function errnoName(ret) {
    return ERROR[ret] || "ERRNO_" + ret;
  }

  class HTTPParser {
    constructor() {
      this.ptr = 0;
      this._type = REQUEST;
      this.socket = null;
      this.incoming = null;
      this.maxHeaderPairs = 2000;
      this._alloc(REQUEST);
      this._resetState();
    }

    _alloc(type) {
      if (this.ptr) {
        wasm.llhttp_free(this.ptr);
        this.ptr = 0;
      }
      this.ptr = wasm.llhttp_alloc(type);
    }

    _resetState() {
      this._url = "";
      this._status = "";
      this._pairs = []; // flat [field, value, ...] for the current header block
      this._field = "";
      this._value = "";
      this._lastCB = 0; // 0 none, 1 field, 2 value
      this._gotHeaders = false;
      this._upgradePaused = false;
    }

    initialize(type, resource, maxHeaderSize, lenient, connectionsList) {
      this._type = type;
      this._alloc(type);
      this._resetState();
      this._resource = resource;
      if (lenient) {
        // --insecure-http-parser: relax the strict RFC checks, matching the
        // pure-JS fallback's tolerance.
        try {
          wasm.llhttp_set_lenient_headers(this.ptr, 1);
          wasm.llhttp_set_lenient_chunked_length(this.ptr, 1);
          wasm.llhttp_set_lenient_keep_alive(this.ptr, 1);
          wasm.llhttp_set_lenient_transfer_encoding(this.ptr, 1);
        } catch {
          /* older builds may lack a setter — best effort */
        }
      }
      return 0;
    }

    // ---- llhttp span callbacks (called re-entrantly during execute) --------

    _onMessageBegin() {
      return 0;
    }
    _onUrl(s) {
      this._url += s;
      return 0;
    }
    _onStatus(s) {
      this._status += s;
      return 0;
    }
    _onHeaderField(s) {
      if (this._lastCB === 2) {
        // value → field transition: the previous pair is complete.
        this._pairs.push(this._field, this._value);
        this._field = "";
        this._value = "";
      }
      this._field += s;
      this._lastCB = 1;
      return 0;
    }
    _onHeaderValue(s) {
      this._value += s;
      this._lastCB = 2;
      return 0;
    }

    _pushPending() {
      if (this._lastCB !== 0) {
        this._pairs.push(this._field, this._value);
        this._field = "";
        this._value = "";
        this._lastCB = 0;
      }
    }

    _onHeadersComplete(statusCode, upgrade, shouldKeepAlive) {
      this._pushPending();
      const headers = this._pairs;
      this._pairs = [];

      const major = wasm.llhttp_get_http_major(this.ptr);
      const minor = wasm.llhttp_get_http_minor(this.ptr);

      let method, url, sc, sm;
      if (this._type === REQUEST) {
        method = wasm.llhttp_get_method(this.ptr);
        url = this._url;
        this._url = "";
      } else {
        sc = statusCode;
        sm = this._status;
        this._status = "";
      }
      this._gotHeaders = true;

      const cb = this[kOnHeadersComplete];
      let rv = 0;
      if (cb) {
        rv = cb.call(
          this,
          major,
          minor,
          headers,
          method,
          url,
          sc,
          sm,
          upgrade,
          shouldKeepAlive,
        );
      }
      // Translate lib/'s return into llhttp's on_headers_complete contract:
      //   true / 1 → skip body (HEAD response, 1xx, etc.)
      //   2        → Upgrade/CONNECT: no body + make execute() return
      //              HPE_PAUSED_UPGRADE so the raw socket can be handed off.
      if (rv === true) return 1;
      if (rv === 2) {
        this._upgradePaused = true;
        return 2;
      }
      return typeof rv === "number" && rv ? rv : 0;
    }

    _onBody(at, len) {
      const cb = this[kOnBody];
      if (cb && len) cb.call(this, inputCopy(at, len));
      return 0;
    }

    _onMessageComplete() {
      // Trailers: header pairs seen after headers-complete belong to the trailer
      // block. lib/_http_common's parserOnMessageComplete drains parser._headers.
      this._pushPending();
      if (this._pairs.length) {
        if (!this._headers) this._headers = [];
        for (let i = 0; i < this._pairs.length; i++) this._headers.push(this._pairs[i]);
        this._pairs = [];
      }
      const cb = this[kOnMessageComplete];
      if (cb) cb.call(this);
      // Ready the accumulators for the next message on a kept-alive connection
      // (llhttp resets its own state after message-complete).
      this._url = "";
      this._status = "";
      this._field = "";
      this._value = "";
      this._lastCB = 0;
      this._gotHeaders = false;
      return 0;
    }

    // ---- the contract lib/ drives ------------------------------------------

    execute(chunk) {
      if (!this.ptr) return new Error("HPE_INVALID_STATE: parser freed");
      const buf = B().isBuffer(chunk) ? chunk : B().from(chunk);

      if (buf.length > bufSize) {
        if (bufPtr) wasm.free(bufPtr);
        bufSize = Math.ceil((buf.length || 1) / 4096) * 4096;
        bufPtr = wasm.malloc(bufSize);
      }
      if (buf.length) {
        new Uint8Array(wasm.memory.buffer, bufPtr, buf.length).set(buf);
      }

      const prevParser = currentParser;
      const prevRef = bufRef;
      currentParser = this;
      bufRef = buf;
      let ret;
      try {
        ret = wasm.llhttp_execute(this.ptr, bufPtr, buf.length);
      } catch (e) {
        return e instanceof Error ? e : new Error(String(e));
      } finally {
        currentParser = prevParser;
        bufRef = prevRef;
      }

      if (ret === ERROR_OK) return buf.length;

      const offset = wasm.llhttp_get_error_pos(this.ptr) - bufPtr;
      if (ret === ERROR_PAUSED_UPGRADE) {
        // Upgrade/CONNECT boundary: return the byte count consumed as headers so
        // _http_server/_http_client can slice the leftover as the `head` arg.
        // Resume so the parser is reusable if the handler keeps the connection.
        try {
          wasm.llhttp_resume_after_upgrade(this.ptr);
        } catch {
          /* ignore */
        }
        return offset;
      }
      if (ret === ERROR_PAUSED) {
        return offset;
      }
      return this._error(ret);
    }

    // Signal EOF from the socket. Completes an EOF-delimited (no length, not
    // chunked) response body via llhttp's on_message_complete.
    finish() {
      if (!this.ptr) return 0;
      const prevParser = currentParser;
      const prevRef = bufRef;
      currentParser = this;
      bufRef = EMPTY();
      let ret;
      try {
        ret = wasm.llhttp_finish(this.ptr);
      } catch (e) {
        return e instanceof Error ? e : new Error(String(e));
      } finally {
        currentParser = prevParser;
        bufRef = prevRef;
      }
      return ret === ERROR_OK ? 0 : this._error(ret);
    }

    _error(ret) {
      const code = "HPE_" + errnoName(ret);
      let reason = "";
      try {
        const ptr = wasm.llhttp_get_error_reason(this.ptr);
        if (ptr) {
          const mem = new Uint8Array(wasm.memory.buffer, ptr);
          let end = 0;
          while (mem[end] !== 0) end++;
          reason = B().from(wasm.memory.buffer, ptr, end).toString("latin1");
        }
      } catch {
        /* ignore */
      }
      const err = new Error(code + (reason ? ": " + reason : ""));
      err.code = code;
      return err;
    }

    // We never advertise isStreamBase, so the consume() fast path is unused.
    consume() {}
    unconsume() {}
    remove() {}
    pause() {}
    resume() {}
    getCurrentBuffer() {
      return EMPTY();
    }
    free() {
      if (this.ptr) {
        wasm.llhttp_free(this.ptr);
        this.ptr = 0;
      }
    }
    close() {
      this.free();
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

  const allMethods = METHODS.slice();
  return {
    methods: allMethods.slice(),
    allMethods,
    HTTPParser,
    ConnectionsList,
    backend: "wasm",
    llhttpVersion: LLHTTP_WASM_VERSION,
  };
}
