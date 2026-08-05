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

import { isIPv4, isIPv6, parseIPv6 } from "./ip.js";
import { UV_CODES, errname, getErrorMap } from "./uv-errors.js";

export function createNetBindings({ process, liveness, syscalls, netServers, pipeBridge, queueClose } = {}) {
  const nextTick = (fn, ...args) => process.nextTick(fn, ...args);
  // A handle's close callback must NOT run on the nextTick queue.
  //
  // In libuv it is a close-phase callback, which is a later phase of the loop, and
  // lib/net.js depends on that gap: `Socket.prototype._destroy` calls
  // `handle.close(cb2)` and then `cb(exception)` synchronously, leaving the stream
  // to emit `error` on a tick of its own. Scheduling cb2 with nextTick queued it
  // BEFORE that one, so a socket emitted `close` and then `error` — the reverse of
  // every other Node.
  //
  // For a plain `net.connect` that inversion is invisible: the test listens for
  // both events and only reads the code. It is `lib/http.js` that cannot survive
  // it. `socketCloseListener` treats a close with no error yet recorded as the
  // server hanging up, so a refused connection reported `ECONNRESET: socket hang
  // up` and then, a phase later, the real `ECONNREFUSED` — two `error` events on
  // one request, the first one wrong.
  //
  // The loop now HAS a close phase (see queueClose in runtime/loop.js), so that is
  // the first choice. setImmediate is the fallback and remains correct: it is the
  // check phase rather than the close phase (libuv runs close callbacks just after
  // it), but the property lib/net.js relies on is only that the tick queue drains
  // first. It matters that the last resort is not nextTick — two probes build the
  // module graph with no loop to hand us, and a fallback that reinstated the tick
  // would bring the bug back silently in the one configuration nothing gates.
  const closePhase =
    typeof queueClose === "function"
      ? queueClose
      : typeof setImmediate === "function"
        ? (fn) => setImmediate(fn)
        : (fn) => nextTick(fn);
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
  // The table itself lives in ./uv-errors.js, shared with the fs binding.
  const uv = { ...UV_CODES, errname, getErrorMap };

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

  // ---- who is a legitimate connect() destination? ---------------------------
  // The virtual network is loopback-only: `listen()` registers a PORT, and
  // connect() finds a server by port. That is correct for every in-VM dial, but
  // it used to be the ONLY thing connect() looked at — and lib/dns.js resolves
  // every hostname to 127.0.0.1 (deliberately, so `net.connect(p,'localhost')`
  // works), so `net.connect(3000, 'api.example.com')` arrived here as
  // "127.0.0.1":3000 and was quietly served by whatever in-VM dev server owned
  // :3000. Connecting successfully to the WRONG machine is the worst outcome
  // available: the caller gets a 200 from the wrong service and the mistake
  // surfaces nowhere near its cause. So the destination is now checked, and
  // anything genuinely external fails instead of being retargeted.
  const isLoopbackAddress = (addr) => {
    if (!addr) return true; // no address → lib/net.js's 'localhost' default
    const a = String(addr).toLowerCase();
    if (a.startsWith("::ffff:")) return isLoopbackAddress(a.slice(7)); // v4-mapped
    // 0.0.0.0 / :: are the unspecified addresses; connecting to them means
    // "this host" (and servers commonly bind there, then dial themselves).
    return a === "::1" || a === "::" || a === "0.0.0.0" || /^127\./.test(a);
  };
  const isLocalHostname = (host) => {
    const h = String(host).toLowerCase().replace(/\.$/, "");
    // "vivari" mirrors builtins/os.js's hostname() — a program that dials
    // os.hostname() is dialling itself.
    if (h === "" || h === "localhost" || h.endsWith(".localhost") || h === "vivari") return true;
    // lib/net.js only populates `_host` when the host wasn't already an IP, so
    // this shouldn't trigger — but a caller reaching the binding directly can
    // still put a literal here, and a loopback literal is a loopback literal.
    return isLoopbackAddress(h);
  };
  // The hostname the caller actually asked for, or null when it dialled an IP.
  // lib/net.js runs dns.lookup FIRST and hands connect() the resolved address,
  // stashing the original on the Socket as `_host` (null for an IP literal) and
  // the Socket on the handle under `owner_symbol`. That symbol is minted in
  // internal/async_hooks.js, which the bindings layer has no way to require, so
  // it is found by description — once, then cached.
  let ownerSymbol = null;
  const requestedHost = (handle) => {
    let sym = ownerSymbol;
    // Re-probe (rather than caching a miss) when the cached symbol isn't on this
    // handle: a bare TCP handle driven without a net.Socket has no owner at all,
    // and caching that miss would blind every later connect().
    if (!sym || handle[sym] === undefined) {
      sym = Object.getOwnPropertySymbols(handle).find((s) => s.description === "owner_symbol");
      if (!sym) return null;
      ownerSymbol = sym;
    }
    const socket = handle[sym];
    const host = socket && socket._host;
    return typeof host === "string" && host ? host : null;
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
      // Reject a destination that isn't this machine BEFORE looking at the port,
      // so an external target can never be retargeted onto an in-VM server that
      // happens to share the port number. Judged on the hostname when there was
      // one (dns.lookup has already flattened it to 127.0.0.1 by now) and on the
      // literal address otherwise.
      const host = requestedHost(this);
      const unreachable = host === null
        ? (isLoopbackAddress(address) ? 0 : UV_CODES.UV_EHOSTUNREACH)
        : (isLocalHostname(host) ? 0 : UV_CODES.UV_ENOTFOUND);
      if (unreachable) {
        this._remoteAddress = address;
        this._remotePort = p;
        // afterConnect builds the error from req.address; point it at what the
        // caller actually asked for, or the message would name 127.0.0.1 and
        // hide the very mistake we're reporting.
        if (host !== null) req.address = host;
        nextTick(() => req.oncomplete(unreachable, this, req, false, false));
        return 0;
      }
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
      if (typeof cb === "function") closePhase(cb);
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

  // `isLocalDestination` is the SAME function object connect() judges a dial with
  // (isLocalHostname handles a bare IP literal by delegating to
  // isLoopbackAddress, so one entry point covers both shapes). It is exported so
  // internal/http-egress.js can ask the virtual network "would you serve this
  // destination?" instead of pattern-matching hostnames of its own: a request
  // that egresses over the Fetcher Worker is then exactly one connect() would
  // have refused, and the two decisions cannot drift apart.
  //
  // Note what is deliberately NOT exported: the `listeners` port registry. Which
  // ports we serve is a routing table for loopback dials, not an answer to "is
  // this destination this machine" — a public host on a port we happen to serve
  // is still a public host (retargeting it onto the in-VM server is the bug this
  // predicate exists to prevent), and a loopback port nobody serves is still
  // loopback and must still get ECONNREFUSED.
  const tcp_wrap = { TCP, TCPConnectWrap, constants: TCPConstants, isLocalDestination: isLocalHostname };

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
      if (typeof cb === "function") closePhase(cb);
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
  // The parsers live in ./ip.js because internalBinding('block_list') needs the same
  // ones, and two IPv6 parsers that disagree about an edge case would be worse than
  // either being wrong.
  const convertIpv6StringToBuffer = parseIPv6;

  const cares_wrap = {
    convertIpv6StringToBuffer,
    isIP: (s) => (isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0),
    isIPv4,
    isIPv6,
  };

  return { tcp_wrap, stream_wrap, uv, pipe_wrap, cares_wrap };
}