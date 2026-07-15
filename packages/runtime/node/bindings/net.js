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
// runs Node's unmodified lib/net.js end-to-end.
//
// Cross-VM reachability (Phase 2 #8 stage 2): `listen()` also registers the port
// with the kernel (syscalls.listen) so external requests — the browser preview
// arriving via the Service Worker, or tests calling kernel.handleHttpRequest —
// are routed to this process. The runtime's `doNet` then replays each request
// through a real http client into this same server over the in-process loopback.
// The same-process loopback `connect()` never touches the kernel; that kernel
// registration is purely the "who owns this port" routing table.
//
// Cross-PROCESS TCP loopback: when a `connect()` targets a port that ISN'T served
// in this process, another in-VM process may own it — e.g. Nuxt/Nitro's dev
// server on :3000 reverse-proxies to its SSR worker on an ephemeral port in a
// DIFFERENT process. We reach it by riding the exact same kernel byte-relay the
// Pipe class uses for cross-process UNIX sockets, keyed by a synthetic per-port
// path (`tcpXKey`). So `listen()` also registers that key with the kernel's pipe
// listener table, and a cross-process `connect()` resolves it to a relayed
// connection whose bytes flow as `pipe-*` messages by connId (see dispatchPipe).
//
// One process === one worker, so a per-binding registry is correctly per-process.

export function createNetBindings({ process, liveness, syscalls, netServers, pipeBridge } = {}) {
  const nextTick = (fn, ...args) => process.nextTick(fn, ...args);
  const buf = () => globalThis.Buffer; // real Buffer is installed before sockets run

  // Event-loop liveness: a listening server or an open connected socket keeps the
  // process alive (libuv "active handles"). We reflect that into the loop's
  // isAlive via a shared counter so a real net.Server behaves like Node's — the
  // loop stays up between requests and exits once servers/sockets close.
  const live = liveness || { active: 0 };
  const recount = (h) => {
    const on = !!h._live && h._refed && !h._closed;
    if (on === h._counted) return;
    h._counted = on;
    live.active += on ? 1 : -1;
  };

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
  // Synthetic pipe path a TCP port is advertised under for CROSS-PROCESS dials.
  // The NUL prefix keeps it out of the real socket-path namespace (tools bind
  // `/tmp/*.sock`), so it can never collide with a genuine UNIX socket.
  const tcpXKey = (port) => "\u0000oc-tcp:" + (port >>> 0);

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
    // Cross-process pipe endpoint: the peer lives in another process, so relay the
    // bytes through the kernel (postMessage) instead of the in-process inbox.
    if (handle._xproc) {
      if (pipeBridge && pipeBridge.postRaw && !handle._closed) {
        pipeBridge.postRaw({ type: "pipe-data", connId: handle._connId, chunk: copy });
      }
      return 0;
    }
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
      this._refed = true; // sockets/servers are ref'd by default (like libuv)
      this._live = false; // becomes true once listening or connected
      this._counted = false;
      this._kernelPort = null; // port registered with the kernel (servers only)
      this._kernelPipe = null; // synthetic pipe key for cross-process dials (servers)
      this._xproc = false; // true once this endpoint bridges to another process
      this._connId = 0; // kernel-assigned id of the cross-process connection
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
      const wasEphemeral = this._localPort === 0;
      if (!wasEphemeral && listeners.has(this._localPort)) return UV_CODES.UV_EADDRINUSE;
      if (wasEphemeral) this._localPort = allocPort();

      // Register the port with the kernel so external requests (Service Worker /
      // kernel.handleHttpRequest) route to this process. A cross-process conflict
      // on an ephemeral port can retry a fresh one; an explicit port fails like
      // libuv with EADDRINUSE.
      if (syscalls && syscalls.listen) {
        let attempts = 0;
        for (;;) {
          try {
            syscalls.listen(this._localPort);
            break;
          } catch {
            if (wasEphemeral && attempts++ < 64) {
              this._localPort = allocPort();
              continue;
            }
            return UV_CODES.UV_EADDRINUSE;
          }
        }
        this._kernelPort = this._localPort;
        if (netServers) netServers.count++;

        // Also advertise this port for CROSS-PROCESS in-VM dials via the pipe
        // relay (e.g. Nitro's :3000 proxying to its SSR worker's port in another
        // process). Same-process connect() still short-circuits via `listeners`;
        // this only matters when the dialer lives in a different worker. Best
        // effort — if it fails, external (browser) routing is unaffected.
        if (pipeBridge && pipeBridge.postRaw && syscalls && syscalls.pipeListen) {
          const key = tcpXKey(this._localPort);
          try {
            syscalls.pipeListen(key);
            pipeServers.set(key, this);
            this._kernelPipe = key;
          } catch {
            /* another process already relays this port; keep serving locally */
          }
        }
      }

      listeners.set(this._localPort, this);
      this._live = true;
      recount(this);
      return 0;
    }

    connect(req, address, port) {
      const p = port >>> 0;
      const server = listeners.get(p);
      this._remoteAddress = address;
      this._remotePort = p;
      this._localAddress = "127.0.0.1";
      this._localPort = allocPort();
      if (!server || server._closed) {
        // Not served in THIS process — a different in-VM process may own the
        // port. Dial it through the kernel pipe relay (same transport as UNIX
        // sockets), keyed by the port's synthetic path; bytes then flow as
        // relayed `pipe-*` messages by connId. Falls back to ECONNREFUSED when
        // nobody in the VM is listening, matching libuv.
        if (pipeBridge && pipeBridge.postRaw && syscalls && syscalls.pipeConnect) {
          let connId = 0;
          try {
            connId = syscalls.pipeConnect(tcpXKey(p)).connId | 0;
          } catch {
            connId = 0;
          }
          if (connId > 0) {
            this._xproc = true;
            this._connId = connId;
            xpipeConns.set(connId, this);
            nextTick(() => {
              this._live = true;
              recount(this);
              req.oncomplete(0, this, req, true, true);
            });
            return 0;
          }
        }
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
        // Both endpoints are now open connections → keep the loop alive.
        this._live = true;
        recount(this);
        peer._live = true;
        recount(peer);
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
      // Half-close: signal EOF to the peer's read side (cross-process or local).
      if (this._xproc) {
        if (pipeBridge && pipeBridge.postRaw) pipeBridge.postRaw({ type: "pipe-shutdown", connId: this._connId });
      } else if (this._peer && !this._peer._closed) {
        enqueueToPeer(this._peer, EOF);
      }
      nextTick(() => req.oncomplete(0));
      return 0;
    }

    close(cb) {
      if (!this._closed) {
        this._closed = true;
        recount(this); // drop from liveness
        if (this.type === TCPConstants.SERVER) {
          listeners.delete(this._localPort);
          if (this._kernelPort != null && syscalls && syscalls.closeServer) {
            try {
              syscalls.closeServer(this._kernelPort);
            } catch {
              /* kernel gone */
            }
            this._kernelPort = null;
            if (netServers) netServers.count--;
          }
          // Tear down the cross-process advertisement for this port too.
          if (this._kernelPipe != null) {
            if (pipeServers.get(this._kernelPipe) === this) pipeServers.delete(this._kernelPipe);
            if (syscalls && syscalls.pipeCloseServer) {
              try {
                syscalls.pipeCloseServer(this._kernelPipe);
              } catch {
                /* kernel gone */
              }
            }
            this._kernelPipe = null;
          }
        }
        // A cross-process client/accepted endpoint: tell the far side it closed.
        if (this._xproc) {
          if (pipeBridge && pipeBridge.postRaw) pipeBridge.postRaw({ type: "pipe-close", connId: this._connId });
          xpipeConns.delete(this._connId);
        }
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
    ref() {
      this._refed = true;
      recount(this);
    }
    unref() {
      this._refed = false;
      recount(this);
    }
    hasRef() {
      return this._refed;
    }
    getAsyncId() {
      return 1;
    }
  }

  class TCPConnectWrap {}

  const tcp_wrap = { TCP, TCPConnectWrap, constants: TCPConstants };

  // ---- pipe_wrap: in-process UNIX-domain-socket / named-pipe loopback --------
  // Node's lib/net.js drives a pipe server as `new Pipe(SERVER); bind(path);
  // listen(backlog)` and a client as `new Pipe(SOCKET); connect(req, path)`.
  // We back both with the SAME StreamBase loopback the TCP handle uses, keyed by
  // socket path instead of port. One process === one binding instance, so a
  // server and the client that dials it (both in this process) find each other
  // through `pipeServers`. This is exactly what Nuxt's dev server needs:
  // @nuxt/vite-builder runs vite-node over a UNIX socket (`*.sock` / abstract
  // `\0…`), listening and connecting within the same dev process.
  const PipeConstants = { SOCKET: 0, SERVER: 1, IPC: 2 };
  const pipeServers = new Map(); // path -> server Pipe handle
  // Cross-process pipe endpoints in THIS process, keyed by the kernel's connId.
  // Both the client (that dialed another process) and the server-side endpoint
  // (accepted from a `pipe-open`) live here; kernel-relayed pipe messages find
  // their endpoint by connId. See dispatchPipe below.
  const xpipeConns = new Map(); // connId -> local Pipe endpoint

  class Pipe {
    constructor(type) {
      this.type = type;
      this.reading = false;
      this.onread = null;
      this.onconnection = null;
      this._peer = null;
      this._inbox = [];
      this._closed = false;
      this._pumpScheduled = false;
      this._refed = true;
      this._live = false;
      this._counted = false;
      this._pipePath = null;
      this._remotePath = "";
      this._kernelPipe = null; // socket path registered with the kernel (servers)
      this._xproc = false; // true once this endpoint bridges to another process
      this._connId = 0; // kernel-assigned id of the cross-process connection
      this.bytesRead = 0;
      this.writeQueueSize = 0;
    }

    bind(path) {
      this._pipePath = String(path);
      return 0;
    }

    listen(/* backlog */) {
      if (this._pipePath == null) return UV_CODES.UV_EINVAL;
      if (pipeServers.has(this._pipePath)) return UV_CODES.UV_EADDRINUSE;
      // Also register the socket path with the kernel so a Pipe.connect() in
      // ANOTHER process can reach this server (e.g. Nuxt/Nitro's dev worker <->
      // the main process, or vite-node's module socket). A cross-process conflict
      // fails like libuv with EADDRINUSE.
      if (pipeBridge && pipeBridge.postRaw && syscalls && syscalls.pipeListen) {
        try {
          syscalls.pipeListen(this._pipePath);
          this._kernelPipe = this._pipePath;
        } catch {
          return UV_CODES.UV_EADDRINUSE;
        }
      }
      pipeServers.set(this._pipePath, this);
      this._live = true;
      recount(this);
      return 0;
    }

    connect(req, path) {
      const target = String(path);
      this._pipePath = "";
      this._remotePath = target;
      const server = pipeServers.get(target);
      if (server && !server._closed) {
        // Same-process loopback: link a fresh server-side endpoint to this one.
        const peer = new Pipe(PipeConstants.SOCKET);
        peer._pipePath = target;
        peer._remotePath = target;
        this._peer = peer;
        peer._peer = this;
        nextTick(() => {
          if (server._closed) {
            req.oncomplete(UV_CODES.UV_ECONNREFUSED, this, req, false, false);
            return;
          }
          this._live = true;
          recount(this);
          peer._live = true;
          recount(peer);
          server.onconnection(0, peer);
          req.oncomplete(0, this, req, true, true);
        });
        return 0;
      }
      // Not in this process — try a cross-process connect through the kernel. The
      // server (in another process) will get a `pipe-open` and accept; bytes then
      // flow both ways as relayed `pipe-data` messages, keyed by connId.
      if (pipeBridge && pipeBridge.postRaw && syscalls && syscalls.pipeConnect) {
        let connId = 0;
        try {
          connId = syscalls.pipeConnect(target).connId | 0;
        } catch {
          connId = 0; // ENOENT — no process listening on that path
        }
        if (connId > 0) {
          this._xproc = true;
          this._connId = connId;
          xpipeConns.set(connId, this);
          nextTick(() => {
            this._live = true;
            recount(this);
            req.oncomplete(0, this, req, true, true);
          });
          return 0;
        }
      }
      // No such socket file → libuv reports ENOENT for a missing pipe.
      nextTick(() => req.oncomplete(UV_CODES.UV_ENOENT, this, req, false, false));
      return 0;
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
      // Half-close: signal EOF to the peer's read side (cross-process or local).
      if (this._xproc) {
        if (pipeBridge && pipeBridge.postRaw) pipeBridge.postRaw({ type: "pipe-shutdown", connId: this._connId });
      } else if (this._peer && !this._peer._closed) {
        enqueueToPeer(this._peer, EOF);
      }
      nextTick(() => req.oncomplete(0));
      return 0;
    }

    close(cb) {
      if (!this._closed) {
        this._closed = true;
        recount(this);
        if (this.type === PipeConstants.SERVER && this._pipePath != null) {
          if (pipeServers.get(this._pipePath) === this) pipeServers.delete(this._pipePath);
          if (this._kernelPipe != null && syscalls && syscalls.pipeCloseServer) {
            try {
              syscalls.pipeCloseServer(this._kernelPipe);
            } catch {
              /* kernel gone */
            }
            this._kernelPipe = null;
          }
        }
        if (this._xproc) {
          if (pipeBridge && pipeBridge.postRaw) pipeBridge.postRaw({ type: "pipe-close", connId: this._connId });
          xpipeConns.delete(this._connId);
        } else if (this._peer && !this._peer._closed) {
          enqueueToPeer(this._peer, EOF);
        }
      }
      if (typeof cb === "function") nextTick(cb);
    }

    // A pipe's "name" is its filesystem path; net.Server.address() surfaces it.
    getsockname(out) {
      out.address = this._pipePath || "";
      return 0;
    }
    getpeername(out) {
      if (!this._remotePath) return UV_CODES.UV_ENOTCONN;
      out.address = this._remotePath;
      return 0;
    }

    setNoDelay() {
      return 0;
    }
    setKeepAlive() {
      return 0;
    }
    ref() {
      this._refed = true;
      recount(this);
    }
    unref() {
      this._refed = false;
      recount(this);
    }
    hasRef() {
      return this._refed;
    }
    getAsyncId() {
      return 1;
    }
    fchmod() {
      return 0;
    }
    setPendingInstances() {
      return 0;
    }
  }
  class PipeConnectWrap {}
  const pipe_wrap = {
    Pipe,
    PipeConnectWrap,
    constants: PipeConstants,
  };

  // Route a kernel-relayed cross-process pipe message into the right local
  // endpoint. `pipe-open` means a client in another process dialed a server we
  // host: build the server-side endpoint and hand it to the listening server as a
  // connection. `pipe-data`/`pipe-shutdown`/`pipe-close` feed the peer's bytes /
  // EOF into the matching endpoint's read side. Wired to the loop via pipeBridge.
  function dispatchPipe(msg) {
    if (!msg) return;
    const connId = msg.connId | 0;
    if (msg.type === "pipe-open") {
      const server = pipeServers.get(String(msg.path));
      if (!server || server._closed) {
        // Server vanished between listen and connect — tell the client it closed.
        if (pipeBridge && pipeBridge.postRaw) pipeBridge.postRaw({ type: "pipe-close", connId });
        return;
      }
      // Give the accepted endpoint the SAME handle type as its server, so a TCP
      // server (a port advertised via tcpXKey) accepts a TCP socket — identical
      // to its same-process loopback — and a Pipe server accepts a Pipe.
      const peer =
        server instanceof TCP ? new TCP(TCPConstants.SOCKET) : new Pipe(PipeConstants.SOCKET);
      peer._xproc = true;
      peer._connId = connId;
      if (peer instanceof Pipe) peer._remotePath = String(msg.path);
      else peer._remoteAddress = "127.0.0.1";
      xpipeConns.set(connId, peer);
      peer._live = true;
      recount(peer);
      // Accept on a fresh turn so onconnection runs in loop context (Node wraps
      // `peer` in a net.Socket and calls readStart, draining any buffered inbox).
      nextTick(() => {
        if (server._closed || peer._closed) return;
        server.onconnection(0, peer);
      });
      if (pipeBridge && pipeBridge.wake) pipeBridge.wake();
      return;
    }
    const ep = xpipeConns.get(connId);
    if (!ep) return;
    if (msg.type === "pipe-data") {
      let chunk = msg.chunk;
      if (chunk && !(chunk instanceof Uint8Array)) chunk = new Uint8Array(chunk);
      if (chunk && chunk.byteLength) enqueueToPeer(ep, chunk);
    } else if (msg.type === "pipe-shutdown") {
      ep._inbox.push(EOF);
      schedulePump(ep);
    } else if (msg.type === "pipe-close") {
      ep._inbox.push(EOF);
      schedulePump(ep);
      xpipeConns.delete(connId);
    }
    if (pipeBridge && pipeBridge.wake) pipeBridge.wake();
  }
  if (pipeBridge) pipeBridge.dispatch = dispatchPipe;

  // ---- cares_wrap: DNS binding. Real name resolution is deferred (loopback
  // connects by IPv4 literal), but the address helpers below must be real:
  // lib/net.js calls convertIpv6StringToBuffer() while computing a server's
  // listen address (isIpv6LinkLocal), e.g. when a name resolves to `::1` — a
  // throwing stub crashes `server.listen()` (this is on Vite's dev-server path).
  const isIPv4 = (s) =>
    typeof s === "string" &&
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) &&
    s.split(".").every((o) => +o <= 255);
  const isIPv6 = (s) => {
    if (typeof s !== "string") return false;
    const a = s.indexOf("%") === -1 ? s : s.slice(0, s.indexOf("%"));
    if (a.indexOf(":") === -1) return false;
    try {
      convertIpv6StringToBuffer(a);
      return true;
    } catch {
      return false;
    }
  };
  // Parse an IPv6 literal into its 16-byte big-endian form. Handles `::`
  // zero-compression, an optional zone id (`%eth0`), and an embedded IPv4 tail
  // (`::ffff:1.2.3.4`). Returns a Uint8Array(16); callers only index bytes.
  function convertIpv6StringToBuffer(addr) {
    if (typeof addr !== "string") throw new TypeError("invalid IPv6 address");
    const pct = addr.indexOf("%");
    if (pct !== -1) addr = addr.slice(0, pct); // drop zone id

    // Fold a trailing embedded IPv4 (e.g. ::ffff:127.0.0.1) into two hextets.
    const lastColon = addr.lastIndexOf(":");
    const tail = addr.slice(lastColon + 1);
    if (tail.indexOf(".") !== -1) {
      const p = tail.split(".");
      if (p.length !== 4) throw new Error("invalid IPv6 address: " + addr);
      const o = p.map((x) => Number(x));
      if (!o.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
        throw new Error("invalid IPv6 address: " + addr);
      }
      const hi = ((o[0] << 8) | o[1]).toString(16);
      const lo = ((o[2] << 8) | o[3]).toString(16);
      addr = addr.slice(0, lastColon + 1) + hi + ":" + lo;
    }

    const halves = addr.split("::");
    if (halves.length > 2) throw new Error("invalid IPv6 address: " + addr);
    const head = halves[0] === "" ? [] : halves[0].split(":");
    let groups;
    if (halves.length === 2) {
      const rest = halves[1] === "" ? [] : halves[1].split(":");
      const missing = 8 - head.length - rest.length;
      if (missing < 0) throw new Error("invalid IPv6 address: " + addr);
      groups = head.concat(new Array(missing).fill("0"), rest);
    } else {
      groups = head;
      if (groups.length !== 8) throw new Error("invalid IPv6 address: " + addr);
    }

    const buf = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
      const g = groups[i] || "0";
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) throw new Error("invalid IPv6 address: " + addr);
      const v = parseInt(g, 16) & 0xffff;
      buf[i * 2] = v >> 8;
      buf[i * 2 + 1] = v & 0xff;
    }
    return buf;
  }
  const cares_wrap = {
    convertIpv6StringToBuffer,
    isIP: (s) => (isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0),
    isIPv4,
    isIPv6,
  };

  return { tcp_wrap, stream_wrap, uv, pipe_wrap, cares_wrap };
}
