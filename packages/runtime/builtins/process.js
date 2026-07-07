// The global `process` object. `stdout`/`stderr` writes are forwarded to
// injected callbacks; `exit()` throws a sentinel that the runner turns into an
// exit code.

export function createProcess({ pid = 1, ppid = 0, argv = [], env = {}, cwd = "/", stdout, stderr, enqueueTask }) {
  let _cwd = cwd || "/";
  // If the runtime has an accept loop (a server is running), route nextTick
  // through its task queue so callbacks drain deterministically even while the
  // loop is parked on Atomics.wait. Otherwise fall back to microtasks.
  const scheduleTick =
    typeof enqueueTask === "function"
      ? (fn, ...args) => enqueueTask(() => fn(...args))
      : (fn, ...args) => queueMicrotask(() => fn(...args));

  const makeStream = (sink) => ({
    write(chunk) {
      sink(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    },
    end() {},
    isTTY: false,
    columns: 80,
    rows: 24,
    on() {},
    once() {},
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

  const process = {
    argv: ["node", ...argv],
    argv0: "node",
    execPath: "/usr/bin/node",
    env,
    platform: "linux",
    arch: "wasm32",
    version: "v24.18.0",
    versions: { node: "24.18.0", opencontainer: "0.0.1", v8: "0.0.0" },
    pid,
    ppid,
    title: "node",
    cwd: () => _cwd,
    chdir: (dir) => {
      _cwd = dir;
    },
    exit: (code = 0) => {
      const err = new Error("process.exit called");
      err.__processExit = code;
      throw err;
    },
    nextTick: (fn, ...args) => scheduleTick(fn, ...args),
    hrtime,
    umask: () => 0,
    uptime: () => (globalThis.performance?.now?.() ?? 0) / 1000,
    stdout: makeStream(stdout),
    stderr: makeStream(stderr),
    stdin: { on() {}, once() {}, read: () => null, isTTY: false },
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
