// Bun.listen / Bun.connect — TCP inside the VM, over the loopback network that
// `node:net` already runs on.
//
// These threw before, with the message for something impossible: "there is no raw
// TCP in a browser". Half of that is true. A page cannot open a socket to the
// internet, and nothing here changes that. But the sandbox has had its own
// network for as long as `Bun.serve` has worked — the kernel routes loopback
// connections between processes — and a Bun program that starts a TCP server and
// talks to it, or two processes in the VM that talk to each other, was refused for
// a limitation it never hit.
//
// So the refusal moves from the API to the destination: a loopback host works, an
// outside host does not, and the message says which of the two you asked for. That
// is the same line `node:net` already draws (see the loopback-only note in
// AGENTS.md), reached through Bun's API instead of Node's.
//
// The surface is Bun's, measured against the binary: `listen` is synchronous and
// its listener has a real `.port` immediately (which works here because the
// kernel's listen syscall is synchronous, so `server.address()` is populated the
// moment `listen()` returns); `connect` returns a promise that both rejects AND
// calls `connectError` when the port is closed; handlers get `(socket, data)` with
// data as a Uint8Array; and the socket carries a user-settable `.data`.
//
// TLS is refused rather than faked. `upgradeTLS`, `tls: true` and the certificate
// accessors have no meaning on a virtual network with no certificate authority,
// and a socket that reports `authorized: true` for a plaintext link would be a lie
// with security consequences.

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "::", ""]);

const NO_TLS =
  "the VM's network is a kernel-routed loopback with no certificate authority " +
  "and no real transport to encrypt, so a TLS handshake has nothing to negotiate " +
  "with. Use a plaintext socket in-VM, or make outbound requests with fetch(), " +
  "which the sandbox proxies over the page's own HTTPS.";

const outsideMessage = (host) =>
  "Bun.connect() cannot reach " +
  JSON.stringify(host) +
  ": a browser tab has no raw TCP to the outside world, only the VM's own " +
  "loopback network. Connecting to a server inside the VM (localhost/127.0.0.1) " +
  "works; reaching a host on the internet has to go through fetch(), which the " +
  "sandbox proxies for you.";

const listenOutsideMessage = (host) =>
  "Bun.listen() cannot bind " +
  JSON.stringify(host) +
  ": the VM's network is loopback-only, so a socket can only be reachable from " +
  "other processes in this VM. Bind localhost/127.0.0.1 (or leave hostname " +
  "unset). To expose an HTTP server to the page, use Bun.serve(), whose ports " +
  "the preview proxy can see.";

export function createBunSockets({ require, Buffer, shimMessage }) {
  let netModule = null;
  const net = () => netModule || (netModule = require("net"));

  const toBytes = (chunk) => {
    if (typeof chunk === "string") return new Uint8Array(Buffer.from(chunk, "utf8"));
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    return new Uint8Array(Buffer.from(String(chunk), "utf8"));
  };

  const tlsRefusal = (name) => () => {
    throw new Error(shimMessage("Socket." + name + "()", NO_TLS));
  };

  /**
   * Bun's socket over a node:net Socket. Bun's handlers live on the LISTENER (or
   * on the connect options), not on the socket, so the same handler object serves
   * every connection and the socket is passed in as the first argument.
   */
  function makeSocket(raw, handlers, listener) {
    let closed = false;
    const socket = {
      // Bun's per-connection user slot. Assigning to it is the documented way to
      // attach state, so it must be a plain writable property.
      data: undefined,
      listener,
      get readyState() {
        // Bun reports 1 while open; node's `readyState` is a string.
        if (closed || raw.destroyed) return 0;
        return raw.connecting ? 0 : 1;
      },
      get remoteAddress() {
        return raw.remoteAddress;
      },
      get remotePort() {
        return raw.remotePort;
      },
      get remoteFamily() {
        return raw.remoteFamily;
      },
      get localAddress() {
        return raw.localAddress;
      },
      get localPort() {
        return raw.localPort;
      },
      get localFamily() {
        return raw.localFamily;
      },
      get bytesWritten() {
        return raw.bytesWritten || 0;
      },
      get fd() {
        return raw.fd == null ? -1 : raw.fd;
      },
      write(chunk, byteOffset, byteLength) {
        if (closed) return 0;
        let bytes = toBytes(chunk);
        if (byteOffset !== undefined || byteLength !== undefined) {
          const start = byteOffset || 0;
          const end = byteLength === undefined ? bytes.length : start + byteLength;
          bytes = bytes.subarray(start, end);
        }
        raw.write(Buffer.from(bytes));
        // Bun returns the number of bytes accepted; a node write() queues
        // everything, so everything was accepted.
        return bytes.length;
      },
      end(chunk) {
        if (chunk !== undefined) socket.write(chunk);
        raw.end();
        return 0;
      },
      // Bun distinguishes an orderly close from a hard one: `end`/`shutdown` send
      // FIN, `terminate` drops the connection. node:net has both.
      shutdown(halfClose) {
        if (halfClose) raw.end();
        else raw.end();
      },
      close() {
        raw.end();
      },
      terminate() {
        raw.destroy();
      },
      flush() {
        /* node buffers and flushes on its own; nothing to force */
      },
      ref() {
        if (typeof raw.ref === "function") raw.ref();
        return socket;
      },
      unref() {
        if (typeof raw.unref === "function") raw.unref();
        return socket;
      },
      pause() {
        raw.pause();
        return socket;
      },
      resume() {
        raw.resume();
        return socket;
      },
      setKeepAlive(enable, initialDelay) {
        if (typeof raw.setKeepAlive === "function") raw.setKeepAlive(enable, initialDelay);
        return socket;
      },
      setNoDelay(enable) {
        if (typeof raw.setNoDelay === "function") raw.setNoDelay(enable);
        return socket;
      },
      timeout(seconds) {
        if (typeof raw.setTimeout === "function") raw.setTimeout((seconds || 0) * 1000);
      },
      reload(next) {
        if (next && next.socket) Object.assign(handlers, next.socket);
        else if (next) Object.assign(handlers, next);
      },
      // TLS: refused by name rather than answered with a comforting default. A
      // socket that says `authorized: true` about a plaintext link is worse than
      // one that says it cannot tell you.
      get authorized() {
        return false;
      },
      get alpnProtocol() {
        return null;
      },
      upgradeTLS: tlsRefusal("upgradeTLS"),
      getPeerCertificate: tlsRefusal("getPeerCertificate"),
      getCertificate: tlsRefusal("getCertificate"),
      getCipher: tlsRefusal("getCipher"),
      getTLSVersion: tlsRefusal("getTLSVersion"),
      setServername: tlsRefusal("setServername"),
      exportKeyingMaterial: tlsRefusal("exportKeyingMaterial"),
    };

    const call = (name, ...args) => {
      const fn = handlers && handlers[name];
      if (typeof fn === "function") fn(socket, ...args);
    };

    raw.on("data", (chunk) => call("data", toBytes(chunk)));
    raw.on("drain", () => call("drain"));
    raw.on("timeout", () => call("timeout"));
    raw.on("error", (err) => {
      if (closed) return;
      call("error", err);
    });
    raw.on("close", () => {
      if (closed) return;
      closed = true;
      call("close");
    });
    raw.on("end", () => call("end"));
    return socket;
  }

  function listen(options) {
    if (!options || typeof options !== "object") {
      throw new TypeError("Bun.listen() expects an options object with a `socket` handler map");
    }
    if (options.tls) throw new Error(shimMessage("Bun.listen({ tls })", NO_TLS));
    const handlers = { ...(options.socket || {}) };
    const server = net().createServer();
    const unix = options.unix;
    const hostname = options.hostname === undefined ? "localhost" : String(options.hostname);
    if (!unix && !LOOPBACK.has(hostname)) throw new Error(listenOutsideMessage(hostname));

    server.on("connection", (raw) => {
      const socket = makeSocket(raw, handlers, listener);
      const open = handlers.open;
      if (typeof open === "function") open(socket);
    });
    server.on("error", (err) => {
      const onError = handlers.error;
      if (typeof onError === "function") onError(undefined, err);
      else throw err;
    });

    // Synchronous, like Bun's: the kernel's listen syscall blocks, so the address
    // is already assigned when this returns — which is what lets `.port` be a real
    // port even for `port: 0`.
    // Port only, no host: the VM's network has exactly one loopback interface, and
    // passing a host here leaves `address()` reporting port 0 for `port: 0` — which
    // would hand back a listener nobody can connect to. The hostname has already
    // done its job above, deciding whether this bind is allowed at all.
    if (unix) server.listen(unix);
    else server.listen(options.port === undefined ? 0 : options.port | 0);
    const address = server.address();

    const listener = {
      data: options.data,
      hostname: unix ? undefined : hostname,
      port: unix ? undefined : (address && address.port) || 0,
      unix: unix || undefined,
      get fd() {
        return -1;
      },
      getsockname() {
        return server.address();
      },
      stop(closeActiveConnections) {
        server.close();
        if (closeActiveConnections && typeof server.closeAllConnections === "function") {
          server.closeAllConnections();
        }
      },
      ref() {
        if (typeof server.ref === "function") server.ref();
        return listener;
      },
      unref() {
        if (typeof server.unref === "function") server.unref();
        return listener;
      },
      reload(next) {
        if (next && next.socket) Object.assign(handlers, next.socket);
      },
    };
    return listener;
  }

  function connect(options) {
    if (!options || typeof options !== "object") {
      return Promise.reject(new TypeError("Bun.connect() expects an options object with a `socket` handler map"));
    }
    if (options.tls) return Promise.reject(new Error(shimMessage("Bun.connect({ tls })", NO_TLS)));
    const handlers = { ...(options.socket || {}) };
    const unix = options.unix;
    const hostname = options.hostname === undefined ? "localhost" : String(options.hostname);
    if (!unix && !LOOPBACK.has(hostname)) return Promise.reject(new Error(outsideMessage(hostname)));

    return new Promise((resolve, reject) => {
      const raw = unix ? net().connect(unix) : net().connect(options.port | 0, hostname);
      let settled = false;
      // Before the connection is up, a failure is a CONNECT failure — Bun reports
      // those to `connectError` and rejects the promise, and reports later ones to
      // `error` on a socket that exists. Wiring them the same way would swallow a
      // refused connection into a handler most callers do not register.
      const onConnectError = (err) => {
        if (settled) return;
        settled = true;
        raw.destroy();
        const onFail = handlers.connectError;
        if (typeof onFail === "function") onFail(undefined, err);
        reject(err);
      };
      raw.once("error", onConnectError);
      raw.once("connect", () => {
        if (settled) return;
        settled = true;
        raw.removeListener("error", onConnectError);
        const socket = makeSocket(raw, handlers, undefined);
        socket.data = options.data;
        const open = handlers.open;
        if (typeof open === "function") open(socket);
        resolve(socket);
      });
    });
  }

  return { listen, connect };
}
