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
