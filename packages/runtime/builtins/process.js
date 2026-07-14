// The global `process` object. `stdout`/`stderr` writes are forwarded to
// injected callbacks; `exit()` throws a sentinel that the runner turns into an
// exit code.

export function createProcess({ pid = 1, ppid = 0, argv = [], env = {}, cwd = "/", stdout, stderr, nextTick, onExit }) {
  let _cwd = cwd || "/";
  // nextTick is owned by the event loop (loop.js): its queue drains ahead of
  // Promise microtasks each turn. Fall back to a microtask if no loop is wired.
  const scheduleTick =
    typeof nextTick === "function"
      ? (fn, ...args) => nextTick(fn, ...args)
      : (fn, ...args) => queueMicrotask(() => fn(...args));

  // A write chunk is either a string or bytes (Buffer/Uint8Array/ArrayBuffer).
  // `Uint8Array.prototype.toString()` yields "72,105" (decimal CSV), not text —
  // so byte writes (e.g. Go's wasm_exec writing to fd 1) must be decoded, not
  // stringified. Honour a string encoding arg (Node's write(chunk, encoding)).
  const decodeChunk = (chunk, encoding) => {
    if (typeof chunk === "string") return chunk;
    const enc = typeof encoding === "string" ? encoding : "utf8";
    const B = globalThis.Buffer;
    try {
      if (B) return (B.isBuffer(chunk) ? chunk : B.from(chunk.buffer || chunk)).toString(enc);
      return new TextDecoder().decode(chunk.buffer ? chunk : new Uint8Array(chunk));
    } catch {
      return String(chunk);
    }
  };

  const makeStream = (sink, fd) => ({
    // Node's std streams carry their integer fd (stdout=1, stderr=2). Go's
    // wasm_exec_node fast-path (`fd === process.stdout.fd`) routes the wasm's
    // fd-1/fd-2 writes through here; without a real `.fd` those writes are lost
    // (that's why `esbuild --version`, and the whole esbuild service, went silent).
    fd,
    // Node's Writable.write(chunk[, encoding][, callback]) invokes the callback
    // once the chunk is handled. Real tools rely on it: npm's exit-handler does
    // `stdout.write('', () => process.exit())`, so a dropped callback would hang
    // the exit (or, before the loop went idle, lose the flush). Fire it on the
    // next tick, like Node.
    write(chunk, encoding, cb) {
      const done = typeof encoding === "function" ? encoding : cb;
      sink(decodeChunk(chunk, encoding));
      if (typeof done === "function") scheduleTick(done);
      return true;
    },
    end(chunk, encoding, cb) {
      const done = typeof chunk === "function" ? chunk : typeof encoding === "function" ? encoding : cb;
      if (chunk != null && typeof chunk !== "function") sink(decodeChunk(chunk, encoding));
      if (typeof done === "function") scheduleTick(done);
    },
    isTTY: false,
    columns: 80,
    rows: 24,
    writable: true,
    destroyed: false,
    // Writes go straight to the sink (never backpressured), so the EventEmitter /
    // Writable surface is a no-op — but it must EXIST: real tools register
    // listeners on stdout/stderr (e.g. yarn does `process.stdout.prependListener`
    // during bootstrap). Missing methods throw "is not a function" and abort.
    on() {
      return this;
    },
    once() {
      return this;
    },
    addListener() {
      return this;
    },
    prependListener() {
      return this;
    },
    prependOnceListener() {
      return this;
    },
    removeListener() {
      return this;
    },
    removeAllListeners() {
      return this;
    },
    emit() {
      return false;
    },
    listeners() {
      return [];
    },
    listenerCount() {
      return 0;
    },
    setMaxListeners() {
      return this;
    },
    // vitest's pool bumps the stream's max-listener count around each worker
    // (`setMaxListeners(1 + getMaxListeners())`), so this must return a number.
    getMaxListeners() {
      return 10;
    },
    setDefaultEncoding() {
      return this;
    },
    cork() {},
    uncork() {},
    destroy() {
      return this;
    },
  });

  const nowNs = () =>
    BigInt(Math.round((globalThis.performance?.now?.() ?? Date.now()) * 1e6));

  const hrtime = (prev) => {
    const ns = nowNs();
    let s = Number(ns / 1000000000n);
    let n = Number(ns % 1000000000n);
    if (prev) {
      s -= prev[0];
      n -= prev[1];
      if (n < 0) {
        s -= 1;
        n += 1e9;
      }
    }
    return [s, n];
  };
  hrtime.bigint = () => nowNs();

  const MB = 1024 * 1024;
  const memoryUsage = () => ({
    rss: 64 * MB,
    heapTotal: 32 * MB,
    heapUsed: 20 * MB,
    external: 2 * MB,
    arrayBuffers: MB,
  });
  memoryUsage.rss = () => 64 * MB;

  const process = {
    argv: ["node", ...argv],
    argv0: "node",
    // Node-level flags passed before the script (e.g. `--enable-source-maps`).
    // We never inject any, but real code reads/maps it unconditionally — vitest's
    // bundled cac chunk does `process.execArgv.map(...)` at module top level.
    execArgv: [],
    execPath: "/usr/bin/node",
    env,
    platform: "linux",
    arch: "wasm32",
    version: "v24.18.0",
    // `webcontainer` marks this as a WebContainer-class runtime (no native
    // binaries). Tools that special-case browser sandboxes read it — notably
    // Next.js's SWC loader, which then prefers the `@next/swc-wasm-nodejs` wasm
    // build over the (unloadable) native `@next/swc-<platform>` addon.
    versions: { node: "24.18.0", opencontainer: "0.0.1", webcontainer: "1.0.0", v8: "0.0.0" },
    // Real tools read process.release.name (e.g. to branch node vs electron) and
    // process.exitCode as the default exit code. Keep them Node-shaped.
    release: { name: "node", sourceUrl: "", headersUrl: "", libUrl: "" },
    config: { target_defaults: {}, variables: {} },
    exitCode: undefined,
    pid,
    ppid,
    title: "node",
    cwd: () => _cwd,
    // Resolve `dir` against the current cwd and normalize (., ..) — Node's chdir
    // accepts relative paths (`cd sub`, `cd ../x`), not just absolute ones.
    chdir: (dir) => {
      if (!dir) return;
      const base = dir.startsWith("/") ? dir : (_cwd === "/" ? "" : _cwd) + "/" + dir;
      const parts = [];
      for (const c of base.split("/")) {
        if (!c || c === ".") continue;
        if (c === "..") parts.pop();
        else parts.push(c);
      }
      _cwd = "/" + parts.join("/");
    },
    exit: (code = 0) => {
      const c = code | 0;
      // Proactively flag the loop to stop so drive() returns `c` even if the
      // throw below escapes the loop (e.g. exit() called from a Promise
      // microtask, outside the loop's runCallback try/catch). The throw still
      // unwinds the current synchronous stack, matching Node's "stop now".
      if (typeof onExit === "function") {
        try {
          onExit(c);
        } catch {
          /* ignore */
        }
      }
      const err = new Error("process.exit called");
      err.__processExit = c;
      throw err;
    },
    nextTick: (fn, ...args) => scheduleTick(fn, ...args),
    hrtime,
    umask: () => 0,
    uptime: () => (globalThis.performance?.now?.() ?? 0) / 1000,
    // No V8 heap introspection in a Wasm/Worker sandbox — return plausible,
    // stable numbers. Real tools only read these for reporting (e.g. yarn's
    // ConsoleReporter peak-memory counter), not correctness.
    memoryUsage,
    stdout: makeStream(stdout, 1),
    stderr: makeStream(stderr, 2),
    stdin: { fd: 0, on() {}, once() {}, read: () => null, isTTY: false },
    // No-op event surface so libraries calling process.on(...) don't crash.
    on() {
      return process;
    },
    once() {
      return process;
    },
    off() {
      return process;
    },
    emit: () => false,
    features: {},
  };
  return process;
}
