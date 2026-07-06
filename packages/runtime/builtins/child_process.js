// The synchronous subset of Node's `child_process`, built on the OP_SPAWN
// syscall. `spawnSync`/`execSync` block the calling process until the child
// exits — the kernel parks us on Atomics.wait and wakes us with the result.
//
// Async `spawn`/`exec` are not implemented yet (they need an event-driven
// process handle); they throw so callers fail loudly rather than silently.

export function createChildProcess({ sys, process, Buffer }) {
  function spawnSync(command, args = [], opts = {}) {
    if (!Array.isArray(args)) {
      opts = args;
      args = [];
    }
    const spec = {
      command,
      args,
      cwd: opts.cwd || process.cwd(),
      env: opts.env || process.env,
      capture: true,
    };
    let r;
    try {
      r = sys.spawn(spec);
    } catch (e) {
      // e.g. ENOENT when the program is not found. Node reports status null +
      // error; we also set 127 so a shell testing the status treats it as
      // "command not found" without inspecting `.error`.
      return {
        status: 127,
        signal: null,
        pid: -1,
        stdout: opts.encoding ? "" : Buffer.alloc(0),
        stderr: opts.encoding ? String(e.code || e.message) : Buffer.from(String(e.code || e.message)),
        output: [null, null, null],
        error: e,
      };
    }
    const wrap = (s) => (opts.encoding ? s : Buffer.from(s || ""));
    const stdout = wrap(r.stdout);
    const stderr = wrap(r.stderr);
    return {
      status: r.code,
      signal: null,
      pid: r.pid,
      stdout,
      stderr,
      output: [null, stdout, stderr],
    };
  }

  function execSync(command, opts = {}) {
    const r = spawnSync("sh", ["-c", command], opts);
    if (r.error) throw r.error;
    if (r.status !== 0) {
      const err = new Error("Command failed: " + command);
      err.status = r.status;
      err.stdout = r.stdout;
      err.stderr = r.stderr;
      throw err;
    }
    return r.stdout;
  }

  const notImplemented = (name) => () => {
    throw new Error("child_process." + name + " (async) is not implemented yet");
  };

  return {
    spawnSync,
    execSync,
    execFileSync: (file, args, opts) => spawnSync(file, args || [], opts).stdout,
    spawn: notImplemented("spawn"),
    exec: notImplemented("exec"),
    fork: notImplemented("fork"),
  };
}
