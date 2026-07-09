// A real WebSocket *client* for the in-VM runtime (roadmap #19 stage C).
//
// OpenContainer has no browser `WebSocket` reachable from a process worker, and
// undici's is a throwing stub. But everything a client needs already exists
// in-VM: Node's real lib/http.js emits an `'upgrade'` event with the raw duplex
// socket (over our net loopback) once it sees a 101 response, so we only have to
// (a) send the RFC 6455 opening handshake and (b) frame/deframe over that socket.
//
// This is the framework-agnostic half of the HMR transport (option C1): the Vite
// dev server's own ws server runs in-VM and distinguishes HMR sockets by the
// `vite-hmr` subprotocol; this client connects to it over 127.0.0.1 and relays
// decoded messages out to the browser preview (where a matching `WebSocket`
// polyfill tunnels them into `/@vite/client`). It is a genuine WebSocket client,
// so guest code can also `new WebSocket(url)` against any in-VM ws server.
//
// Scope: client role only (masks its frames, expects unmasked server frames),
// text + binary data frames, fragmentation reassembly, and the ping/close/pong
// control frames. That is everything Vite HMR (and typical app ws use) needs.

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

// A non-cryptographic random fill is fine: Sec-WebSocket-Key only needs to be
// unpredictable enough to defeat caching proxies, and this is a 127.0.0.1 hop.
function randomBytes(Buffer, n) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (Math.random() * 256) | 0;
  return b;
}

function base64(Buffer, buf) {
  return buf.toString("base64");
}

// Build one client frame (FIN set, always masked per RFC 6455 §5.3).
function encodeFrame(Buffer, opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    // 64-bit length; we never send >2^32, so the high word stays 0.
    header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  const mask = randomBytes(Buffer, 4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

export function createWebSocket({ http, Buffer }) {
  class WebSocket {
    constructor(url, protocols) {
      this.url = String(url);
      this.readyState = CONNECTING;
      this.protocol = "";
      this.binaryType = "arraybuffer";
      this._listeners = { open: [], message: [], close: [], error: [] };
      this._socket = null;
      this._buf = Buffer.alloc(0);
      // Reassembly state for fragmented data messages.
      this._fragOpcode = 0;
      this._fragChunks = [];

      let target;
      try {
        target = new URL(this.url);
      } catch {
        // Relative/garbage URL: fail asynchronously like a real WebSocket.
        queueMicrotask(() => this._fail(new Error("invalid WebSocket URL: " + this.url)));
        return;
      }
      const secure = target.protocol === "wss:";
      const port = target.port ? Number(target.port) : secure ? 443 : 80;
      const subprotocols = Array.isArray(protocols)
        ? protocols.join(", ")
        : protocols
          ? String(protocols)
          : null;

      const headers = {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": base64(Buffer, randomBytes(Buffer, 16)),
      };
      if (subprotocols) headers["Sec-WebSocket-Protocol"] = subprotocols;

      let req;
      try {
        req = http.request({
          host: target.hostname || "127.0.0.1",
          port,
          method: "GET",
          path: (target.pathname || "/") + (target.search || ""),
          headers,
        });
      } catch (e) {
        queueMicrotask(() => this._fail(e));
        return;
      }
      req.on("upgrade", (res, socket, head) => {
        this.protocol = (res.headers && res.headers["sec-websocket-protocol"]) || "";
        this._attach(socket);
        // A frame may have arrived in the same packet as the 101 response.
        if (head && head.length) this._onData(head);
      });
      // A server without an upgrade handler answers with a normal response.
      req.on("response", (res) => this._fail(new Error("WebSocket upgrade rejected: HTTP " + res.statusCode)));
      req.on("error", (e) => this._fail(e));
      req.end();
    }

    _attach(socket) {
      this._socket = socket;
      this.readyState = OPEN;
      socket.on("data", (chunk) => this._onData(chunk));
      socket.on("close", () => this._onClose(1006, "", false));
      socket.on("error", (e) => this._fail(e));
      this._emit("open", { type: "open" });
    }

    _onData(chunk) {
      this._buf = Buffer.concat([this._buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      for (;;) {
        const frame = this._readFrame();
        if (!frame) break;
        this._handleFrame(frame);
      }
    }

    // Parse a single frame off the head of the buffer, or null if incomplete.
    _readFrame() {
      const buf = this._buf;
      if (buf.length < 2) return null;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return null;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return null;
        // High word ignored (payloads never exceed 2^32 here).
        len = buf.readUInt32BE(6);
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + len) return null;
      let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = buf.subarray(offset, offset + 4);
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      } else {
        // Copy out of the shared read buffer before we advance past it.
        payload = Buffer.from(payload);
      }
      this._buf = buf.subarray(offset + maskLen + len);
      return { fin, opcode, payload };
    }

    _handleFrame(frame) {
      const { fin, opcode, payload } = frame;
      if (opcode === 0x8) {
        // Close: echo a close frame and tear down.
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
        this._sendRaw(0x8, payload.length >= 2 ? payload : Buffer.alloc(0));
        this._onClose(code, reason, true);
        return;
      }
      if (opcode === 0x9) {
        // Ping -> Pong (echo payload).
        this._sendRaw(0xa, payload);
        return;
      }
      if (opcode === 0xa) return; // Pong: ignore.

      // Data frame (0x1 text, 0x2 binary) or continuation (0x0).
      if (opcode === 0x1 || opcode === 0x2) {
        this._fragOpcode = opcode;
        this._fragChunks = [payload];
      } else if (opcode === 0x0) {
        this._fragChunks.push(payload);
      }
      if (!fin) return;
      const full = this._fragChunks.length === 1 ? this._fragChunks[0] : Buffer.concat(this._fragChunks);
      this._fragChunks = [];
      const isText = this._fragOpcode === 0x1;
      const data = isText
        ? full.toString("utf8")
        : this.binaryType === "arraybuffer"
          ? full.buffer.slice(full.byteOffset, full.byteOffset + full.byteLength)
          : full;
      this._emit("message", { type: "message", data });
    }

    _sendRaw(opcode, payload) {
      if (!this._socket) return;
      try {
        this._socket.write(encodeFrame(Buffer, opcode, payload));
      } catch (e) {
        this._fail(e);
      }
    }

    send(data) {
      if (this.readyState !== OPEN) throw new Error("WebSocket is not open");
      let opcode = 0x1;
      let payload;
      if (typeof data === "string") {
        payload = Buffer.from(data, "utf8");
      } else if (data instanceof ArrayBuffer) {
        opcode = 0x2;
        payload = Buffer.from(new Uint8Array(data));
      } else if (ArrayBuffer.isView(data)) {
        opcode = 0x2;
        payload = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      } else if (Buffer.isBuffer(data)) {
        opcode = 0x2;
        payload = data;
      } else {
        payload = Buffer.from(String(data), "utf8");
      }
      this._sendRaw(opcode, payload);
    }

    close(code, reason) {
      if (this.readyState === CLOSED || this.readyState === CLOSING) return;
      this.readyState = CLOSING;
      let payload = Buffer.alloc(0);
      if (typeof code === "number") {
        const r = reason ? Buffer.from(String(reason), "utf8") : Buffer.alloc(0);
        payload = Buffer.alloc(2 + r.length);
        payload.writeUInt16BE(code, 0);
        r.copy(payload, 2);
      }
      this._sendRaw(0x8, payload);
      try {
        this._socket && this._socket.end();
      } catch {
        /* ignore */
      }
    }

    _onClose(code, reason, clean) {
      if (this.readyState === CLOSED) return;
      this.readyState = CLOSED;
      try {
        this._socket && this._socket.destroy && this._socket.destroy();
      } catch {
        /* ignore */
      }
      this._emit("close", { type: "close", code, reason, wasClean: !!clean });
    }

    _fail(err) {
      if (this.readyState === CLOSED) return;
      this._emit("error", { type: "error", error: err, message: String((err && err.message) || err) });
      this._onClose(1006, "", false);
    }

    // ---- EventTarget-ish surface (both on<event> and addEventListener) --------
    addEventListener(type, fn) {
      if (this._listeners[type]) this._listeners[type].push(fn);
    }
    removeEventListener(type, fn) {
      const arr = this._listeners[type];
      if (arr) {
        const i = arr.indexOf(fn);
        if (i !== -1) arr.splice(i, 1);
      }
    }
    _emit(type, event) {
      const on = this["on" + type];
      if (typeof on === "function") {
        try {
          on.call(this, event);
        } catch (e) {
          if (type !== "error") this._emit("error", { type: "error", error: e });
        }
      }
      for (const fn of this._listeners[type].slice()) {
        try {
          fn.call(this, event);
        } catch {
          /* a listener throwing must not break the others */
        }
      }
    }
  }
  WebSocket.CONNECTING = CONNECTING;
  WebSocket.OPEN = OPEN;
  WebSocket.CLOSING = CLOSING;
  WebSocket.CLOSED = CLOSED;
  return WebSocket;
}
