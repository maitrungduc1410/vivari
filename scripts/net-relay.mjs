#!/usr/bin/env node
// vivari net relay — a LOCAL network agent for the Vivari runtime.
//
// Run it on the developer's machine, pass the printed URL to `Vivari.boot({ netRelay })`
// (the basic example and the studio accept `?net=<url>`), and the VM gets a network:
//
//   outbound  `net.connect(host, port)` from in-VM code opens a real TCP connection
//             from THIS machine (your localhost services, LAN, VPN, the internet).
//   inbound   an in-VM `server.listen(port)` binds the same port here on 127.0.0.1,
//             so `curl localhost:<port>`, another tool, or a browser redirected to
//             `http://localhost:<port>/callback?code=…` (the OAuth CLI flow) all
//             reach the server running in the tab.
//
// Wire protocol: Wisp v1 (github.com/MercuryWorkshop/wisp-protocol) for outbound
// streams, plus a small extension (listen/accept, half-close, a CONNECTED ack, the
// host's error code on a failed dial's CLOSE, and relay→VM flow control via ACK) —
// documented in
// packages/kernel-host/net-relay.js, which is the client this relay serves.
//
// Security posture (this is a hole punched in the browser sandbox, on purpose):
//   - binds 127.0.0.1 only; forwarded ports bind 127.0.0.1 only
//   - the WebSocket path must carry the per-launch token printed at start
//   - the Origin header must be a loopback origin or one passed with --origin;
//     a missing Origin is rejected (browsers always send one on WebSocket)
//   - no SSRF blocklist: reaching your own machine is the point of a local relay.
//     Do NOT expose this process beyond loopback; a hosted relay needs the
//     blocklists this one deliberately lacks.
//
//   node scripts/net-relay.mjs [--port 7071] [--origin http://localhost:5173]... [--token T]
//                              [--allow-no-origin]  (non-browser clients only, e.g. spikes)
//                              [--quiet] [--json]

import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";

// ---- packet types (keep in sync with packages/kernel-host/net-relay.js) ----------
const WISP_CONNECT = 0x01;
const WISP_DATA = 0x02;
const WISP_CONTINUE = 0x03;
const WISP_CLOSE = 0x04;
const VV_LISTEN = 0x10;
const VV_UNLISTEN = 0x11;
const VV_LISTENING = 0x12;
const VV_ACCEPT = 0x13;
const VV_SHUTDOWN = 0x14;
const VV_CONNECTED = 0x15;
const VV_ACK = 0x16;
const ACCEPT_ID_FLAG = 0x80000000;

const CLOSE_VOLUNTARY = 0x02;
const CLOSE_NETWORK = 0x03;
const CLOSE_INVALID = 0x41;
const CLOSE_UNREACHABLE = 0x42;
const CLOSE_TIMEOUT = 0x43;
const CLOSE_REFUSED = 0x44;

// Per-stream DATA budget granted to the client; topped up as bytes drain to TCP.
const CREDIT = 32;
// Relay→VM: DATA packets per stream the client may leave unacknowledged (VV_ACK)
// before this relay stops reading the TCP socket. Without it a fast sender and a
// slow guest meant the whole transfer buffered here and in the tab.
const RELAY_WINDOW = 32;
// Guest-side name for the machine running this relay (mirrors the Fetcher Worker).
const HOST_ALIAS = "host.vivari.internal";

// ---- CLI -----------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opts = { port: 7071, host: "127.0.0.1", origins: [], token: null, allowNoOrigin: false, quiet: false, json: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--port") opts.port = Number(argv[++i]);
  else if (a === "--origin") opts.origins.push(String(argv[++i]).replace(/\/$/, ""));
  else if (a === "--token") opts.token = String(argv[++i]);
  else if (a === "--allow-no-origin") opts.allowNoOrigin = true;
  else if (a === "--quiet") opts.quiet = true;
  else if (a === "--json") opts.json = true;
  else if (a === "-h" || a === "--help") {
    process.stdout.write(
      "usage: node scripts/net-relay.mjs [--port N] [--origin URL]... [--token T] [--allow-no-origin] [--quiet] [--json]\n",
    );
    process.exit(0);
  } else {
    process.stderr.write("unknown flag: " + a + "\n");
    process.exit(2);
  }
}
if (!opts.token) opts.token = crypto.randomBytes(16).toString("hex");

const log = (line) => {
  if (!opts.quiet) process.stderr.write("[net-relay] " + line + "\n");
};

function originAllowed(origin) {
  if (!origin) return opts.allowNoOrigin;
  let u;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  const host = u.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host.endsWith(".localhost")) return true;
  return opts.origins.includes(origin.replace(/\/$/, ""));
}

// ---- minimal RFC 6455 server framing (binary only; ping/pong/close handled) ------------
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class WsConn {
  constructor(socket, onMessage, onClose) {
    this.socket = socket;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.buf = Buffer.alloc(0);
    this.frag = null; // { opcode, chunks }
    this.closed = false;
    socket.on("data", (d) => this._feed(d));
    socket.on("close", () => this._closed());
    socket.on("error", () => this._closed());
    socket.on("end", () => this._closed());
  }

  send(payload) {
    if (this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x82, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x82;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x82;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  close(code = 1000) {
    if (this.closed) return;
    const b = Buffer.alloc(2);
    b.writeUInt16BE(code, 0);
    try {
      this.socket.write(Buffer.concat([Buffer.from([0x88, 2]), b]));
    } catch {
      /* ignore */
    }
    this.socket.end();
    this._closed();
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }

  _feed(data) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(64 * 1024 * 1024)) return this.close(1009);
        len = Number(big);
        off = 10;
      }
      if (!masked) return this.close(1002); // clients MUST mask
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      this._frame(fin, opcode, payload);
    }
  }

  _frame(fin, opcode, payload) {
    switch (opcode) {
      case 0x0: // continuation
        if (!this.frag) return this.close(1002);
        this.frag.chunks.push(payload);
        if (fin) {
          const { opcode: op, chunks } = this.frag;
          this.frag = null;
          if (op === 0x2) this.onMessage(Buffer.concat(chunks));
        }
        return;
      case 0x1: // text: not part of this protocol
      case 0x2:
        if (!fin) {
          this.frag = { opcode, chunks: [payload] };
          return;
        }
        if (opcode === 0x2) this.onMessage(payload);
        return;
      case 0x8:
        return this.close(1000);
      case 0x9: // ping -> pong
        if (!this.closed) this.socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
        return;
      case 0xa:
        return;
      default:
        return this.close(1002);
    }
  }
}

// ---- one relay session per WebSocket ------------------------------------------------
class Session {
  constructor(ws, origin) {
    this.ws = ws;
    this.origin = origin;
    this.streams = new Map(); // id -> { socket, used, needDrain }
    this.servers = new Map(); // port -> net.Server
    this.nextAcceptId = 1;
    this.packet(WISP_CONTINUE, 0, u32(CREDIT));
  }

  packet(type, id, payload = Buffer.alloc(0)) {
    const head = Buffer.alloc(5);
    head[0] = type;
    head.writeUInt32LE(id >>> 0, 1);
    this.ws.send(Buffer.concat([head, payload]));
  }

  onPacket(buf) {
    if (buf.length < 5) return;
    const type = buf[0];
    const id = buf.readUInt32LE(1);
    const p = buf.subarray(5);
    switch (type) {
      case WISP_CONNECT:
        return this.connect(id, p);
      case WISP_DATA:
        return this.data(id, p);
      case WISP_CLOSE: {
        const st = this.streams.get(id);
        if (st) {
          this.streams.delete(id);
          st.socket.destroy();
        }
        return;
      }
      case VV_SHUTDOWN: {
        const st = this.streams.get(id);
        if (st) st.socket.end();
        return;
      }
      case VV_ACK: {
        const st = this.streams.get(id);
        if (!st || p.length < 4) return;
        const consumed = p.readUInt32LE(0);
        // Cumulative, so only ever moves forward (mod 2^32).
        if (((consumed - st.acked) >>> 0) > ((st.sent - st.acked) >>> 0)) return;
        st.acked = consumed;
        if (st.paused && ((st.sent - st.acked) >>> 0) < RELAY_WINDOW) {
          st.paused = false;
          st.socket.resume();
        }
        return;
      }
      case VV_LISTEN:
        return this.listen(p.readUInt16LE(0), p[2]);
      case VV_UNLISTEN:
        return this.unlisten(p.readUInt16LE(0));
      default:
        return;
    }
  }

  connect(id, p) {
    if (p.length < 3 || this.streams.has(id) || id & ACCEPT_ID_FLAG) return this.packet(WISP_CLOSE, id, Buffer.from([CLOSE_INVALID]));
    const streamType = p[0];
    const port = p.readUInt16LE(1);
    let host = p.subarray(3).toString("utf8");
    // In-VM `127.0.0.1`/`localhost` mean the VM itself (its loopback network), so a
    // guest reaches THIS machine by name — the same alias the Fetcher Worker uses.
    if (host === HOST_ALIAS) host = "127.0.0.1";
    if (streamType !== 1) {
      log(`refused ${host}:${port} (only tcp streams)`);
      return this.packet(WISP_CLOSE, id, Buffer.from([CLOSE_INVALID]));
    }
    log(`→ connect ${host}:${port}`);
    const socket = net.connect({ host, port });
    this.attach(id, socket, false);
    // The client holds the guest's 'connect' until this arrives (Wisp has no
    // success signal); the peer address is what the guest's remoteAddress reports.
    socket.on("connect", () => {
      const st = this.streams.get(id);
      if (!st) return;
      st.connected = true;
      this.packet(VV_CONNECTED, id, Buffer.from(peerOf(socket), "utf8"));
    });
  }

  attach(id, socket, connected) {
    const st = { socket, used: 0, needDrain: false, connected, sent: 0, acked: 0, paused: false };
    this.streams.set(id, st);
    socket.on("data", (d) => {
      this.packet(WISP_DATA, id, d);
      st.sent = (st.sent + 1) >>> 0;
      if (!st.paused && ((st.sent - st.acked) >>> 0) >= RELAY_WINDOW) {
        st.paused = true;
        socket.pause();
      }
    });
    socket.on("end", () => this.packet(VV_SHUTDOWN, id));
    socket.on("drain", () => {
      st.needDrain = false;
      this.topUp(id, st);
    });
    socket.on("error", (e) => {
      if (!this.streams.has(id)) return;
      this.streams.delete(id);
      const code = (e && e.code) || "";
      // Before connect this is a failed dial and the reason says why; after it,
      // any error is the connection dying (a reset, a timeout).
      const reason = !st.connected
        ? code === "ECONNREFUSED" ? CLOSE_REFUSED
          : code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EHOSTUNREACH" || code === "ENETUNREACH" ? CLOSE_UNREACHABLE
          : code === "ETIMEDOUT" ? CLOSE_TIMEOUT
          : CLOSE_NETWORK
        : CLOSE_NETWORK;
      log(`✗ stream ${id & 0x7fffffff}: ${code || e}`);
      // Detail: the host's own error code, then the address it tried (see the
      // CLOSE row in packages/kernel-host/net-relay.js).
      const detail = code ? code + (e.address ? " " + e.address : "") : "";
      this.packet(WISP_CLOSE, id, Buffer.concat([Buffer.from([reason]), Buffer.from(detail, "utf8")]));
    });
    socket.on("close", () => {
      if (!this.streams.has(id)) return;
      this.streams.delete(id);
      this.packet(WISP_CLOSE, id, Buffer.from([CLOSE_VOLUNTARY]));
    });
  }

  data(id, p) {
    const st = this.streams.get(id);
    if (!st) return;
    st.used++;
    if (!st.socket.write(p)) st.needDrain = true;
    this.topUp(id, st);
  }

  // Grant the client more DATA budget once half is used and TCP has room.
  topUp(id, st) {
    if (st.needDrain || st.used < CREDIT / 2) return;
    st.used = 0;
    this.packet(WISP_CONTINUE, id, u32(CREDIT));
  }

  listen(port, proto) {
    if (proto !== 1 || !(port > 0 && port < 65536)) return this.packet(VV_LISTENING, 0, listening(port, false, 0));
    if (this.servers.has(port)) return this.packet(VV_LISTENING, 0, listening(port, true, port));
    const server = net.createServer((socket) => this.accept(port, socket));
    server.on("error", (e) => {
      log(`✗ cannot bind 127.0.0.1:${port}: ${(e && e.code) || e}`);
      this.servers.delete(port);
      this.packet(VV_LISTENING, 0, listening(port, false, 0));
    });
    this.servers.set(port, server);
    server.listen(port, opts.host, () => {
      log(`+ listening ${opts.host}:${port} → vm :${port}`);
      this.packet(VV_LISTENING, 0, listening(port, true, server.address().port));
    });
  }

  unlisten(port) {
    const server = this.servers.get(port);
    if (!server) return;
    this.servers.delete(port);
    server.close();
    log(`- closed ${opts.host}:${port}`);
  }

  accept(port, socket) {
    const id = (ACCEPT_ID_FLAG | this.nextAcceptId++) >>> 0;
    const remote = peerOf(socket);
    log(`← accept :${port} from ${remote}`);
    this.attach(id, socket, true);
    const r = Buffer.from(remote, "utf8");
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16LE(port, 0);
    r.copy(payload, 2);
    this.packet(VV_ACCEPT, id, payload);
    this.packet(WISP_CONTINUE, id, u32(CREDIT));
  }

  destroy() {
    for (const [, st] of this.streams) st.socket.destroy();
    this.streams.clear();
    for (const [, s] of this.servers) s.close();
    this.servers.clear();
  }
}

function peerOf(socket) {
  return `${socket.remoteAddress}:${socket.remotePort}`;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}
function listening(port, ok, bound) {
  const b = Buffer.alloc(5);
  b.writeUInt16LE(port, 0);
  b[2] = ok ? 1 : 0;
  b.writeUInt16LE(bound, 3);
  return b;
}

// ---- HTTP server: health on GET, WebSocket upgrade on /<token> -------------------------
const server = http.createServer((req, res) => {
  res.writeHead(req.url === "/" ? 200 : 404, { "content-type": "text/plain" });
  res.end(req.url === "/" ? "vivari net relay\n" : "not found\n");
});

server.on("upgrade", (req, socket) => {
  const path = (req.url || "").split("?")[0];
  const origin = req.headers.origin;
  const key = req.headers["sec-websocket-key"];
  const reject = (code, why) => {
    log(`rejected upgrade from ${origin || "(no origin)"}: ${why}`);
    socket.end(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`);
  };
  if (path !== "/" + opts.token) return reject(404, "unknown path");
  if (!originAllowed(origin)) return reject(403, "origin not allowed");
  if (!key || (req.headers.upgrade || "").toLowerCase() !== "websocket") return reject(400, "bad upgrade");
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n",
  );
  socket.setNoDelay(true);
  let session = null;
  const ws = new WsConn(
    socket,
    (msg) => session && session.onPacket(msg),
    () => {
      if (session) session.destroy();
      log(`session closed (${origin || "no origin"})`);
    },
  );
  session = new Session(ws, origin);
  log(`session opened from ${origin || "(no origin)"}`);
});

server.listen(opts.port, opts.host, () => {
  const url = `ws://${opts.host}:${server.address().port}/${opts.token}`;
  if (opts.json) process.stdout.write(JSON.stringify({ url, port: server.address().port, token: opts.token }) + "\n");
  else {
    process.stdout.write(`\nvivari net relay\n\n  relay url:  ${url}\n  origins:    loopback${opts.origins.length ? ", " + opts.origins.join(", ") : ""}\n\n  pass it as Vivari.boot({ netRelay: "<url>" }) or open the studio / example with ?net=<url>\n\n`);
  }
});
server.on("error", (e) => {
  process.stderr.write(`[net-relay] cannot listen on ${opts.host}:${opts.port}: ${(e && e.code) || e}\n`);
  process.exit(1);
});