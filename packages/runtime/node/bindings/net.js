// internalBinding('tcp_wrap' | 'stream_wrap' | 'uv' | 'pipe_wrap' | 'cares_wrap')
// — the socket layer beneath Node's real lib/net.js (Phase 2 #7).
//
// Node's net sits on native libuv handles (TCP) that expose the "StreamBase"
// contract consumed by internal/stream_base_commons: writeBuffer/write*String/
// writev + readStart/readStop + an `onread` callback driven through a shared
// `streamBaseState` array, plus listen/connect/onconnection for servers.
//
// We implement that contract as an **in-process loopback**: a module-level
// `port -> serverHandle` registry lets a TCP handle `connect()` to a `listen()`ing
// handle in the SAME VM, producing a linked pair of endpoints whose writes appear
// as the peer's reads. This is exactly what a preview/loopback server needs; it
// runs Node's unmodified lib/net.js end-to-end. Cross-VM loopback (wiring the
// kernel + Service Worker) and outbound sockets are deferred (see roadmap #7).
//
// One process === one worker, so a per-binding registry is correctly per-process.

export function createNetBindings({ process }) {
  const nextTick = (fn, ...args) => process.nextTick(fn, ...args);
  const buf = () => globalThis.Buffer; // real Buffer is installed before sockets run

  // ---- uv: error constants (Linux errno-negated, matching libuv) ------------
  const UV_CODES = {
    UV_EOF: -4095,
    UV_ECONNREFUSED: -111,
    UV_ECONNRESET: -104,
    UV_ECONNABORTED: -103,
    UV_EADDRINUSE: -98,
    UV_EADDRNOTAVAIL: -99,
    UV_EBADF: -9,
    UV_EINVAL: -22,
    UV_ENOTCONN: -107,
    UV_EPIPE: -32,
    UV_ECANCELED: -125,
    UV_ETIMEDOUT: -110,
    UV_EAGAIN: -11,
    UV_ENOENT: -2,
  };
  const UV_MESSAGES = {
    [-4095]: ["EOF", "end of file"],
    [-111]: ["ECONNREFUSED", "connection refused"],
    [-104]: ["ECONNRESET", "connection reset by peer"],
    [-103]: ["ECONNABORTED", "software caused connection abort"],
    [-98]: ["EADDRINUSE", "address already in use"],
    [-99]: ["EADDRNOTAVAIL", "address not available"],
    [-9]: ["EBADF", "bad file descriptor"],
    [-22]: ["EINVAL", "invalid argument"],
    [-107]: ["ENOTCONN", "socket is not connected"],
    [-32]: ["EPIPE", "broken pipe"],
    [-125]: ["ECANCELED", "operation canceled"],
    [-110]: ["ETIMEDOUT", "connection timed out"],
    [-11]: ["EAGAIN", "resource temporarily unavailable"],
    [-2]: ["ENOENT", "no such file or directory"],
  };
  const uv = {
    ...UV_CODES,
    errname: (code) => (UV_MESSAGES[code] ? UV_MESSAGES[code][0] : `Unknown system error ${code}`),
    getErrorMap: () => {
      const m = new Map();
      for (const code of Object.keys(UV_MESSAGES)) {
        const [name, msg] = UV_MESSAGES[code];
        m.set(Number(code), [name, msg]);
      }
      return m;
    },
  };

  // ---- stream_wrap: the shared read/write scratch state ----------------------
  const kReadBytesOrError = 0;
  const kArrayBufferOffset = 1;
  const kBytesWritten = 2;
  const kLastWriteWasAsync = 3;
  const streamBaseState = [0, 0, 0, 0]; // indexable like Node's AliasedArray

  // Request wrappers: plain carriers whose props net/stream_base_commons set.
  class WriteWrap {}
  class ShutdownWrap {}

  const stream_wrap = {
    WriteWrap,
    ShutdownWrap,
    streamBaseState,
    kReadBytesOrError,
    kArrayBufferOffset,
    kBytesWritten,
    kLastWriteWasAsync,
  };

  // ---- tcp_wrap: the loopback TCP handle ------------------------------------
  const TCPConstants = { SOCKET: 0, SERVER: 1, UV_TCP_IPV6ONLY: 1, UV_TCP_REUSEPORT: 2 };
  const listeners = new Map(); // port -> server TCP handle
  let ephemeral = 49152;
  const allocPort = () => {
    do {
      ephemeral = ephemeral >= 65535 ? 49152 : ephemeral + 1;
    } while (listeners.has(ephemeral));
    return ephemeral;
  };

  const EOF = Symbol("EOF");

  const deliver = (handle) => {
    // Pump queued inbound chunks into the stream while it wants to read.
    while (handle.reading && handle._inbox.length && !handle._closed) {
      const item = handle._inbox[0];
      if (item === EOF) {
        handle._inbox.shift();
        streamBaseState[kReadBytesOrError] = UV_CODES.UV_EOF;
        if (handle.onread) handle.onread.call(handle, undefined);
        return; // no more data after EOF
      }
      handle._inbox.shift();
      handle.bytesRead += item.byteLength;
      streamBaseState[kReadBytesOrError] = item.byteLength;
      streamBaseState[kArrayBufferOffset] = item.byteOffset;
      // onStreamRead builds new FastBuffer(arrayBuffer, offset, nread); it may
      // set handle.reading = false (backpressure) which stops this loop.
      if (handle.onread) handle.onread.call(handle, item.buffer);
    }
  };

  const schedulePump = (handle) => {
    if (handle._pumpScheduled || handle._closed) return;
    handle._pumpScheduled = true;
    nextTick(() => {
      handle._pumpScheduled = false;
      deliver(handle);
    });
  };

  const enqueueToPeer = (peer, chunk) => {
    if (!peer || peer._closed) return;
    peer._inbox.push(chunk);
    schedulePump(peer);
  };

  const doWrite = (handle, req, bytes) => {
    // bytes: Uint8Array/Buffer view. Copy (caller may reuse it) and hand to peer.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    streamBaseState[kBytesWritten] = copy.byteLength;
    streamBaseState[kLastWriteWasAsync] = 0; // loopback writes complete sync
    if (handle._peer && !handle._peer._closed) enqueueToPeer(handle._peer, copy);
    return 0;
  };

  class TCP {
    constructor(type) {
      this.type = type;
      this.reading = false;
      this.onread = null;
      this.onconnection = null;
      this._peer = null;
      this._inbox = [];
      this._closed = false;
      this._pumpScheduled = false;
      this._localAddress = "0.0.0.0";
      this._localPort = 0;
      this._remoteAddress = "";
      this._remotePort = 0;
      this._family = "IPv4";
      this.bytesRead = 0;
      this.writeQueueSize = 0;
    }

    bind(address, port) {
      this._localAddress = address;
      this._localPort = port >>> 0;
      return 0;
    }
    bind6(address, port /*, flags */) {
      this._family = "IPv6";
      return this.bind(address, port);
    }

    listen(/* backlog */) {
      if (this._localPort !== 0 && listeners.has(this._localPort)) return UV_CODES.UV_EADDRINUSE;
      if (this._localPort === 0) this._localPort = allocPort();
      listeners.set(this._localPort, this);
      return 0;
    }

    connect(req, address, port) {
      const server = listeners.get(port >>> 0);
      this._remoteAddress = address;
      this._remotePort = port >>> 0;
      this._localAddress = "127.0.0.1";
      this._localPort = allocPort();
      if (!server || server._closed) {
        nextTick(() => req.oncomplete(UV_CODES.UV_ECONNREFUSED, this, req, false, false));
        return 0;
      }
      // Build the server-side peer endpoint and link the two.
      const peer = new TCP(TCPConstants.SOCKET);
      peer._localAddress = address;
      peer._localPort = port >>> 0;
      peer._remoteAddress = "127.0.0.1";
      peer._remotePort = this._localPort;
      this._peer = peer;
      peer._peer = this;
      nextTick(() => {
        if (server._closed) {
          req.oncomplete(UV_CODES.UV_ECONNREFUSED, this, req, false, false);
          return;
        }
        server.onconnection(0, peer); // server wraps peer in a net.Socket
        req.oncomplete(0, this, req, true, true); // client is connected
      });
      return 0;
    }
    connect6(req, address, port) {
      return this.connect(req, address, port);
    }

    readStart() {
      this.reading = true;
      schedulePump(this);
      return 0;
    }
    readStop() {
      this.reading = false;
      return 0;
    }

    writeBuffer(req, data) {
      return doWrite(this, req, data);
    }
    writeLatin1String(req, str) {
      return doWrite(this, req, buf().from(str, "latin1"));
    }
    writeUtf8String(req, str) {
      return doWrite(this, req, buf().from(str, "utf8"));
    }
    writeAsciiString(req, str) {
      return doWrite(this, req, buf().from(str, "ascii"));
    }
    writeUcs2String(req, str) {
      return doWrite(this, req, buf().from(str, "ucs2"));
    }
    writev(req, chunks, allBuffers) {
      const parts = [];
      if (allBuffers) {
        for (let i = 0; i < chunks.length; i++) parts.push(chunks[i]);
      } else {
        for (let i = 0; i < chunks.length; i += 2) {
          const chunk = chunks[i];
          const enc = chunks[i + 1];
          parts.push(typeof chunk === "string" ? buf().from(chunk, enc) : chunk);
        }
      }
      const merged = buf().concat(parts.map((p) => (buf().isBuffer(p) ? p : buf().from(p))));
      return doWrite(this, req, merged);
    }

    shutdown(req) {
      // Half-close: signal EOF to the peer's read side.
      if (this._peer && !this._peer._closed) enqueueToPeer(this._peer, EOF);
      nextTick(() => req.oncomplete(0));
      return 0;
    }

    close(cb) {
      if (!this._closed) {
        this._closed = true;
        if (this.type === TCPConstants.SERVER) listeners.delete(this._localPort);
        if (this._peer && !this._peer._closed) enqueueToPeer(this._peer, EOF);
      }
      if (typeof cb === "function") nextTick(cb);
    }

    getsockname(out) {
      out.address = this._localAddress;
      out.port = this._localPort;
      out.family = this._family;
      return 0;
    }
    getpeername(out) {
      if (!this._remotePort) return UV_CODES.UV_ENOTCONN;
      out.address = this._remoteAddress;
      out.port = this._remotePort;
      out.family = this._family;
      return 0;
    }

    setNoDelay() {
      return 0;
    }
    setKeepAlive() {
      return 0;
    }
    ref() {}
    unref() {}
    hasRef() {
      return true;
    }
    getAsyncId() {
      return 1;
    }
  }

  class TCPConnectWrap {}

  const tcp_wrap = { TCP, TCPConnectWrap, constants: TCPConstants };

  // ---- pipe_wrap: deferred stub (unix domain sockets / IPC not implemented) --
  class Pipe {
    constructor() {
      const err = new Error("OpenContainer: named pipes / IPC are not implemented yet");
      err.code = "ERR_METHOD_NOT_IMPLEMENTED";
      throw err;
    }
  }
  class PipeConnectWrap {}
  const pipe_wrap = {
    Pipe,
    PipeConnectWrap,
    constants: { SOCKET: 0, SERVER: 1, IPC: 2 },
  };

  // ---- cares_wrap: DNS binding — only convertIpv6StringToBuffer is used by
  // net.js at load; real DNS is deferred (loopback connects by IPv4 literal).
  const cares_wrap = {
    convertIpv6StringToBuffer: (addr) => {
      const err = new Error("OpenContainer: IPv6 address parsing is not implemented yet");
      err.code = "ERR_METHOD_NOT_IMPLEMENTED";
      err.addr = addr;
      throw err;
    },
    isIP: () => 0,
    isIPv4: () => false,
    isIPv6: () => false,
  };

  return { tcp_wrap, stream_wrap, uv, pipe_wrap, cares_wrap };
}
