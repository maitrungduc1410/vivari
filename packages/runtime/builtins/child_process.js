// Node's `child_process`, built on the kernel's process syscalls.
//
//   - spawnSync / execSync / execFileSync (bricks 4): block the caller via
//     OP_SPAWN — the kernel parks us on Atomics.wait and wakes us with the
//     child's exit code and captured output.
//   - spawn / exec / execFile (Phase 2 #15): DO NOT block. OP_SPAWN_ASYNC returns
//     a pid immediately; the child's stdout/stderr stream back as postMessages the
//     kernel sends to this worker, which the runtime routes here via `_dispatch`.
//     `_drain` (called once per event-loop turn) replays them onto a real
//     ChildProcess (an EventEmitter with Readable stdout/stderr and 'exit'/'close'
//     events), so a long-running child (a dev server) streams live instead of
//     freezing the parent until it exits.
//
// stdin (parent -> child): `child.stdin` is a binary-safe Writable-ish sink that
// relays bytes to the kernel, which pushes them into the child's process.stdin.

export function createChildProcess({ sys, process, Buffer, EventEmitter, Readable, childLiveness, wake, postRaw }) {
  // ---- synchronous subset (unchanged) --------------------------------------
  function spawnSync(command, args = [], opts = {}) {
    if (!Array.isArray(args)) {
      opts = args;
      args = [];
    }
    const sh = withShell(command, args, opts);
    const spec = {
      command: sh.command,
      args: sh.args,
      cwd: opts.cwd || process.cwd(),
      env: opts.env || process.env,
      capture: true,
    };
    // `input` travels WITH the spawn, because there is no later. The caller is
    // parked on Atomics.wait from here until the child exits, so it can never
    // write to a pipe; the kernel hands these bytes to the child's stdin and then
    // closes it (see handleSpawn). base64 because the spec crosses as JSON and
    // input is often binary — a tarball piped into a checker, an image into a
    // converter.
    if (opts.input != null) spec.input = toBytes(opts.input, opts.encoding).toString("base64");
    let r;
    try {
      r = sys.spawn(spec);
    } catch (e) {
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

  // ---- async spawn (#15) ----------------------------------------------------
  const registry = new Map(); // childPid -> ChildProcess
  const inbox = []; // queued { type, childPid, chunk?, code?, signal? } events

  // child.stdin: a Writable-ish sink that actually delivers to the child. write()
  // relays the bytes to the kernel ({type:'child-stdin', childPid, chunk}); the
  // kernel pushes them into the child process' own process.stdin (see
  // kernel.handleChildStdin). end() sends EOF (null chunk). It also answers to the
  // whole stream-ish surface tools poke at — NestJS's watch-restart, for one,
  // calls `child.stdin.pause()` before recompiling, and chokidar/others cork or
  // set encodings — so the rest are chainable no-ops rather than undefined.
  const makeStdin = (childPid) => ({
    writable: true,
    readable: false,
    destroyed: false,
    write(chunk, encoding, cb) {
      if (typeof encoding === "function") {
        cb = encoding;
        encoding = undefined;
      }
      if (childPid >= 0 && postRaw && chunk != null) {
        // Preserve bytes exactly: strings honor their encoding; Buffer/TypedArray
        // pass through untouched so binary stdin (tar streams, zips, protobuf,
        // image bytes) reaches the child intact rather than mangled through utf8.
        let bytes;
        if (typeof chunk === "string") bytes = Buffer.from(chunk, encoding || "utf8");
        else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) bytes = chunk;
        else bytes = Buffer.from(String(chunk));
        try {
          postRaw({ type: "child-stdin", childPid, chunk: bytes });
        } catch {
          /* kernel/child gone */
        }
      }
      if (typeof cb === "function") {
        try {
          cb();
        } catch {
          /* listener threw */
        }
      }
      return true;
    },
    end(chunk, encoding, cb) {
      if (typeof chunk === "function") {
        cb = chunk;
        chunk = undefined;
      } else if (typeof encoding === "function") {
        cb = encoding;
        encoding = undefined;
      }
      if (chunk != null) this.write(chunk, encoding);
      if (childPid >= 0 && postRaw) {
        try {
          postRaw({ type: "child-stdin", childPid, chunk: null });
        } catch {
          /* kernel/child gone */
        }
      }
      if (typeof cb === "function") {
        try {
          cb();
        } catch {
          /* listener threw */
        }
      }
      return this;
    },
    pause() {
      return this;
    },
    resume() {
      return this;
    },
    cork() {},
    uncork() {},
    setEncoding() {
      return this;
    },
    setDefaultEncoding() {
      return this;
    },
    pipe(dest) {
      return dest;
    },
    unpipe() {
      return this;
    },
    read() {
      return null;
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    off() {
      return this;
    },
    addListener() {
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
    ref() {
      return this;
    },
    unref() {
      return this;
    },
    destroy() {
      this.destroyed = true;
      return this;
    },
  });

  class ChildProcess extends EventEmitter {
    constructor(pid) {
      super();
      this.pid = pid;
      this.exitCode = null;
      this.signalCode = null;
      this.killed = false;
      // read()=noop: we push data as it arrives from the kernel (flowing on a
      // 'data' listener), exactly like a real child's piped stdio.
      this.stdout = new Readable({ read() {} });
      this.stderr = new Readable({ read() {} });
      this.stdin = makeStdin(pid);
      this.stdio = [this.stdin, this.stdout, this.stderr];
    }
    kill(signal = "SIGTERM") {
      if (this.pid < 0) return false;
      try {
        sys.kill(this.pid, signal);
        this.killed = true;
        return true;
      } catch {
        return false; // ESRCH: already gone
      }
    }
    ref() {
      return this;
    }
    unref() {
      return this;
    }
  }

  function normalizeArgs(command, args, opts) {
    if (!Array.isArray(args)) {
      opts = args || {};
      args = [];
    }
    return { command, args: args || [], opts: opts || {} };
  }

  // Node's `shell` option: when set, the command (+args) is run through a shell as
  // a single line — `sh -c "<command> <args...>"`. Tools rely on this (Nest's
  // `nest start` spawns `spawn('node --enable-source-maps dist/main', {shell})`);
  // without it we'd try to exec a program literally named "node --enable...".
  // Everything Node accepts as `input`, as bytes. A string honors the call's
  // encoding (that is what Node does with it); a view is read at its own offset
  // and length, so a subarray of a larger buffer sends only its own slice.
  function toBytes(value, encoding) {
    if (typeof value === "string") return Buffer.from(value, Buffer.isEncoding(encoding) ? encoding : "utf8");
    if (Buffer.isBuffer(value)) return value;
    if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    return Buffer.from(String(value));
  }

  function withShell(command, args, opts) {
    if (!opts || !opts.shell) return { command, args };
    const shell = typeof opts.shell === "string" ? opts.shell : "sh";
    const line = args && args.length ? [command, ...args].join(" ") : command;
    return { command: shell, args: ["-c", line] };
  }

  function spawn(command, args, opts) {
    const n = normalizeArgs(command, args, opts);
    const sh = withShell(n.command, n.args, n.opts);
    const spec = {
      command: sh.command,
      args: sh.args,
      cwd: n.opts.cwd || process.cwd(),
      env: n.opts.env || process.env,
    };
    let pid;
    try {
      pid = sys.spawnAsync(spec).pid | 0;
    } catch (e) {
      // Node reports a spawn failure asynchronously via an 'error' event on the
      // returned ChildProcess, not by throwing.
      const cp = new ChildProcess(-1);
      process.nextTick(() => {
        const err = e instanceof Error ? e : new Error(String(e));
        err.code = e && e.code ? e.code : "ENOENT";
        err.errno = err.code;
        err.syscall = "spawn " + n.command;
        err.path = n.command;
        cp.emit("error", err);
        cp.stdout.push(null);
        cp.stderr.push(null);
        cp.emit("close", null, null);
      });
      return cp;
    }
    const cp = new ChildProcess(pid);
    registry.set(pid, cp);
    childLiveness.active++;
    // stdio: 'inherit' (or ['...','inherit','inherit']) means the child shares the
    // parent's stdout/stderr — forward each streamed chunk to our own std streams.
    // Tools rely on this to surface a nested process's logs (Nest spawns the app
    // with {stdio:'inherit'}; without this its bootstrap logs never appear).
    const stdio = n.opts.stdio;
    const inheritOut = stdio === "inherit" || (Array.isArray(stdio) && stdio[1] === "inherit");
    const inheritErr = stdio === "inherit" || (Array.isArray(stdio) && stdio[2] === "inherit");
    if (inheritOut) cp.stdout.on("data", (d) => process.stdout.write(d));
    if (inheritErr) cp.stderr.on("data", (d) => process.stderr.write(d));
    process.nextTick(() => cp.emit("spawn"));
    return cp;
  }

  // Route a kernel-delivered child event into the loop's queue and nudge it.
  function _dispatch(msg) {
    inbox.push(msg);
    if (typeof wake === "function") wake();
  }

  // Drained once per event-loop turn (see loop.doChildren): replays queued events
  // onto the matching ChildProcess. Runs inside a controlled turn so 'exit'
  // handlers' microtasks are flushed by the loop right after.
  function _drain() {
    while (inbox.length) {
      const m = inbox.shift();
      const cp = registry.get(m.childPid);
      if (!cp) continue;
      if (m.type === "child-stdout") {
        cp.stdout.push(m.chunk == null ? null : Buffer.from(String(m.chunk), "utf8"));
      } else if (m.type === "child-stderr") {
        cp.stderr.push(m.chunk == null ? null : Buffer.from(String(m.chunk), "utf8"));
      } else if (m.type === "child-exit") {
        registry.delete(m.childPid);
        if (childLiveness.active > 0) childLiveness.active--;
        cp.exitCode = m.signal ? null : m.code | 0;
        cp.signalCode = m.signal || null;
        // Node fires 'exit' as soon as the child is gone (stdio may still be
        // flushing), but 'close' only after the stdio streams end. We honour that
        // ordering so a listener reading stdout then exiting on 'close' has already
        // seen every chunk — pushing data is async, so emitting 'close' eagerly
        // would race ahead of the last 'data'.
        cp.emit("exit", cp.exitCode, cp.signalCode);
        let pending = 2;
        const done = () => {
          if (--pending === 0) cp.emit("close", cp.exitCode, cp.signalCode);
        };
        // If nobody is consuming a stream, resume it so its 'end' still fires.
        for (const s of [cp.stdout, cp.stderr]) {
          s.once("end", done);
          if (s.listenerCount("data") === 0) s.resume();
        }
        cp.stdout.push(null);
        cp.stderr.push(null);
      }
    }
  }

  // exec/execFile: spawn + collect the full output, then a Node-style callback.
  function collect(child, command, opts, cb) {
    const encoding = opts && opts.encoding !== undefined ? opts.encoding : "utf8";
    const outChunks = [];
    const errChunks = [];
    child.stdout.on("data", (d) => outChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    child.stderr.on("data", (d) => errChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    child.on("error", (err) => {
      if (cb) cb(err, "", "");
      cb = null;
    });
    child.on("close", (code, signal) => {
      if (!cb) return;
      const out = Buffer.concat(outChunks);
      const errB = Buffer.concat(errChunks);
      const stdout = encoding === "buffer" || encoding === null ? out : out.toString(encoding);
      const stderr = encoding === "buffer" || encoding === null ? errB : errB.toString(encoding);
      if (code !== 0) {
        const err = new Error("Command failed: " + command);
        err.code = code;
        err.signal = signal;
        cb(err, stdout, stderr);
      } else {
        cb(null, stdout, stderr);
      }
    });
    return child;
  }

  function exec(command, opts, cb) {
    if (typeof opts === "function") {
      cb = opts;
      opts = {};
    }
    opts = opts || {};
    return collect(spawn("sh", ["-c", command], { cwd: opts.cwd, env: opts.env }), command, opts, cb);
  }

  function execFile(file, args, opts, cb) {
    if (typeof args === "function") {
      cb = args;
      args = [];
      opts = {};
    } else if (typeof opts === "function") {
      cb = opts;
      opts = {};
    }
    opts = opts || {};
    return collect(spawn(file, args || [], { cwd: opts.cwd, env: opts.env }), file, opts, cb);
  }

  const notImplemented = (name) => () => {
    throw new Error("child_process." + name + " is not implemented yet");
  };

  return {
    spawnSync,
    execSync,
    execFileSync: (file, args, opts) => spawnSync(file, args || [], opts).stdout,
    spawn,
    exec,
    execFile,
    fork: notImplemented("fork"),
    // Internal wiring for the runtime (not part of Node's public API).
    _dispatch,
    _drain,
  };
}
