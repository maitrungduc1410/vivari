// NetRelay — the kernel's client for an OPTIONAL, deployer-controlled network relay.
//
// Vivari's virtual network is loopback-only: `net.connect()` to a host that is not
// this machine is refused, and an in-VM `listen()` is reachable only through the
// preview Service Worker. A relay changes both, when (and only when) one is
// configured (`BootOptions.netRelay`):
//
//   outbound — an external dial becomes a Wisp v1 stream (CONNECT/DATA/CONTINUE/
//              CLOSE over one WebSocket) that the relay terminates as a real TCP
//              connection. Spec: github.com/MercuryWorkshop/wisp-protocol (v1).
//   inbound  — `listen(port)` asks the relay to bind the same port on the relay's
//              host (127.0.0.1 for the local agent). Each accepted TCP connection
//              arrives as a relay-initiated stream, which the kernel turns into a
//              `pipe-open` on the owning process — the same path a cross-process
//              `connect()` takes, so the guest sees an ordinary net.Socket.
//
// Inbound is not part of Wisp v1 (which has no listen/accept). It rides four
// extension packet types in a range Wisp does not use; relay-initiated stream ids
// carry the high bit so they can never collide with the client-chosen ids Wisp
// mandates. `scripts/net-relay.mjs` is the reference relay for this dialect.
//
// Wire format (all little-endian, one packet per binary WebSocket message):
//   [type:u8][stream_id:u32][payload...]
//   0x01 CONNECT   c→r  [stream_type:u8 (1=tcp)][port:u16][host:utf8]
//   0x02 DATA      both [bytes]
//   0x03 CONTINUE  r→c  [buffer_remaining:u32]   (stream 0 = initial per-stream budget)
//   0x04 CLOSE     both [reason:u8]
//   0x10 LISTEN    c→r  [port:u16][proto:u8 (1=tcp)]         stream_id = 0
//   0x11 UNLISTEN  c→r  [port:u16]                           stream_id = 0
//   0x12 LISTENING r→c  [port:u16][ok:u8][bound_port:u16]    stream_id = 0
//   0x13 ACCEPT    r→c  [port:u16][remote:utf8]              stream_id = 0x80000000 | n
//   0x14 SHUTDOWN  both []  half-close: no more bytes in this direction (TCP FIN)
//
// The class is environment-agnostic: it only needs a global `WebSocket` (browser
// worker or Node >= 22). Everything the kernel does with streams is via the hooks.

export const WISP_CONNECT = 0x01;
export const WISP_DATA = 0x02;
export const WISP_CONTINUE = 0x03;
export const WISP_CLOSE = 0x04;
export const VV_LISTEN = 0x10;
export const VV_UNLISTEN = 0x11;
export const VV_LISTENING = 0x12;
export const VV_ACCEPT = 0x13;
export const VV_SHUTDOWN = 0x14;

export const ACCEPT_ID_FLAG = 0x80000000;

// Wisp CLOSE reasons we produce or interpret (protocol.md "close reasons").
export const CLOSE_VOLUNTARY = 0x02;
export const CLOSE_NETWORK = 0x03;
export const CLOSE_INVALID = 0x41;
export const CLOSE_UNREACHABLE = 0x42;
export const CLOSE_REFUSED = 0x47;

// Largest DATA payload we put in one packet. The relay has no limit; this keeps a
// single message well inside anything a WebSocket implementation buffers eagerly.
const DATA_CHUNK = 64 * 1024;
// Budget assumed until the relay's initial CONTINUE arrives.
const DEFAULT_CREDIT = 32;

const enc = new TextEncoder();
const dec = new TextDecoder();

function u16(view, off) {
  return view.getUint16(off, true);
}

export class NetRelay {
  /**
   * @param {string} url  ws:// or wss:// URL of the relay (token in the path).
   * @param {object} hooks
   * @param {(streamId:number, port:number, remote:string)=>void} hooks.onAccept
   * @param {(streamId:number, chunk:Uint8Array)=>void} hooks.onData
   * @param {(streamId:number)=>void} hooks.onShutdown   remote half-closed (EOF)
   * @param {(streamId:number, reason:number)=>void} hooks.onClose
   * @param {(port:number, ok:boolean, boundPort:number)=>void} [hooks.onListening]
   * @param {(err:string)=>void} [hooks.onDown]  the WebSocket dropped; every stream is gone
   * @param {(line:string)=>void} [hooks.log]
   */
  constructor(url, hooks) {
    this.url = String(url);
    this.hooks = hooks || {};
    this.ws = null;
    this.open = false;
    this.disposed = false;
    this.queue = []; // packets waiting for the socket to open
    this.nextId = 1; // client-chosen stream ids (Wisp: start at 1, increment)
    this.defaultCredit = DEFAULT_CREDIT;
    this.streams = new Map(); // id -> { credit, sendq: Uint8Array[], shutdownPending }
    this.listening = new Set(); // ports we asked the relay to bind (re-sent on reconnect)
  }

  // ---- public API used by the kernel ---------------------------------------

  /** Open an outbound TCP stream. Returns the stream id immediately; failure arrives as onClose. */
  connect(host, port) {
    const id = this.nextId++;
    this.streams.set(id, { credit: this.defaultCredit, sendq: [], shutdownPending: false });
    const h = enc.encode(String(host));
    const payload = new Uint8Array(3 + h.length);
    payload[0] = 1; // TCP
    payload[1] = port & 0xff;
    payload[2] = (port >>> 8) & 0xff;
    payload.set(h, 3);
    this._send(WISP_CONNECT, id, payload);
    return id;
  }

  /** Queue bytes on a stream; flow control (CONTINUE credits) is handled here. */
  send(id, chunk) {
    const st = this.streams.get(id);
    if (!st) return false;
    let bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    // Copy: the caller's buffer may be reused (a SAB view, a pooled Buffer).
    bytes = new Uint8Array(bytes);
    for (let off = 0; off < bytes.length; off += DATA_CHUNK) {
      st.sendq.push(bytes.subarray(off, Math.min(off + DATA_CHUNK, bytes.length)));
    }
    this._drain(id, st);
    return true;
  }

  /** Half-close our side of a stream after everything queued has gone out. */
  shutdown(id) {
    const st = this.streams.get(id);
    if (!st) return;
    st.shutdownPending = true;
    this._drain(id, st);
  }

  /** Tear a stream down (both directions). Safe to call twice. */
  close(id, reason = CLOSE_VOLUNTARY) {
    if (!this.streams.has(id)) return;
    this.streams.delete(id);
    this._send(WISP_CLOSE, id, new Uint8Array([reason & 0xff]));
  }

  /** Ask the relay to bind `port` on its host and hand us every connection. */
  listen(port) {
    this.listening.add(port);
    this._send(VV_LISTEN, 0, new Uint8Array([port & 0xff, (port >>> 8) & 0xff, 1]));
  }

  unlisten(port) {
    this.listening.delete(port);
    this._send(VV_UNLISTEN, 0, new Uint8Array([port & 0xff, (port >>> 8) & 0xff]));
  }

  dispose() {
    this.disposed = true;
    this.streams.clear();
    this.listening.clear();
    this.queue.length = 0;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closing */
      }
      this.ws = null;
    }
    this.open = false;
  }

  // ---- socket lifecycle ------------------------------------------------------

  _ensure() {
    if (this.ws || this.disposed) return;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this._down("cannot open relay socket: " + (e && e.message ? e.message : e));
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.open = true;
      this._log("connected " + this.url.replace(/\/[^/]*$/, "/…"));
      // Re-announce listeners that predate this socket (first open or a reconnect).
      for (const port of this.listening) {
        this._sendNow(VV_LISTEN, 0, new Uint8Array([port & 0xff, (port >>> 8) & 0xff, 1]));
      }
      const q = this.queue;
      this.queue = [];
      for (const frame of q) this._sendNow(frame.type, frame.id, frame.payload);
    };
    ws.onmessage = (ev) => this._onPacket(ev.data);
    ws.onerror = () => {
      /* the close event that follows carries the useful state */
    };
    ws.onclose = (ev) => {
      const wasOpen = this.open;
      this.ws = null;
      this.open = false;
      this._down(wasOpen ? "relay socket closed (" + (ev && ev.code) + ")" : "relay unreachable at " + this.url);
    };
  }

  _down(why) {
    this._log(why);
    // Every stream died with the socket. Tell the kernel once per stream, then
    // forget them; `listening` is kept so a later `_ensure()` re-announces.
    const ids = [...this.streams.keys()];
    this.streams.clear();
    this.queue.length = 0;
    for (const id of ids) this._emit("onClose", id, CLOSE_UNREACHABLE);
    this._emit("onDown", why);
  }

  // ---- framing -----------------------------------------------------------------

  _send(type, id, payload) {
    if (this.disposed) return;
    if (!this.ws) this._ensure();
    if (this.open) this._sendNow(type, id, payload);
    else this.queue.push({ type, id, payload });
  }

  _sendNow(type, id, payload) {
    const p = payload || new Uint8Array(0);
    const buf = new Uint8Array(5 + p.length);
    buf[0] = type;
    new DataView(buf.buffer).setUint32(1, id >>> 0, true);
    buf.set(p, 5);
    try {
      this.ws.send(buf);
    } catch (e) {
      this._down("relay send failed: " + (e && e.message ? e.message : e));
    }
  }

  _drain(id, st) {
    while (st.sendq.length && st.credit > 0) {
      st.credit--;
      this._send(WISP_DATA, id, st.sendq.shift());
    }
    if (!st.sendq.length && st.shutdownPending) {
      st.shutdownPending = false;
      this._send(VV_SHUTDOWN, id, new Uint8Array(0));
    }
  }

  _onPacket(data) {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 5) return;
    const view = new DataView(data);
    const type = view.getUint8(0);
    const id = view.getUint32(1, true);
    const payload = new Uint8Array(data, 5);
    switch (type) {
      case WISP_CONTINUE: {
        if (payload.length < 4) return;
        const remaining = view.getUint32(5, true);
        if (id === 0) {
          this.defaultCredit = remaining || DEFAULT_CREDIT;
          return;
        }
        const st = this.streams.get(id);
        if (st) {
          st.credit = remaining;
          this._drain(id, st);
        }
        return;
      }
      case WISP_DATA: {
        if (this.streams.has(id)) this._emit("onData", id, payload);
        return;
      }
      case VV_SHUTDOWN: {
        if (this.streams.has(id)) this._emit("onShutdown", id);
        return;
      }
      case WISP_CLOSE: {
        const reason = payload.length ? payload[0] : CLOSE_VOLUNTARY;
        if (this.streams.delete(id)) this._emit("onClose", id, reason);
        return;
      }
      case VV_ACCEPT: {
        if (payload.length < 2 || !(id & ACCEPT_ID_FLAG)) return;
        const port = u16(view, 5);
        const remote = dec.decode(payload.subarray(2));
        this.streams.set(id, { credit: this.defaultCredit, sendq: [], shutdownPending: false });
        this._emit("onAccept", id, port, remote);
        return;
      }
      case VV_LISTENING: {
        if (payload.length < 5) return;
        const port = u16(view, 5);
        const ok = payload[2] === 1;
        const bound = u16(view, 8);
        this._log(ok ? "listening on relay host :" + bound : "could not bind :" + port + " on relay host");
        this._emit("onListening", port, ok, bound);
        return;
      }
      default:
        return; // unknown type: ignore (forward-compatible)
    }
  }

  _emit(name, ...args) {
    const fn = this.hooks[name];
    if (typeof fn === "function") {
      try {
        fn(...args);
      } catch (e) {
        this._log("hook " + name + " threw: " + (e && e.stack ? e.stack : e));
      }
    }
  }

  _log(line) {
    const fn = this.hooks.log;
    if (typeof fn === "function") fn("[net-relay] " + line);
  }
}
