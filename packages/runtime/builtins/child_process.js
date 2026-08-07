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
// stdin (parent -> child): a binary-safe Writable-ish sink that relays bytes to the
// kernel, which pushes them into the child's process.stdin. WHETHER THE CALLER GETS
// IT is node's rule, not ours: `child.stdin` is that sink only when fd 0 is a pipe,
// and null for 'inherit'/'ignore', because then fd 0 is somebody else's and the
// parent holds no end of it. It is reachable regardless as `_vvStdin`, for the two
// programs that stand in for the kernel's fd table (`sh` and the --watch
// supervisor) — see the ChildProcess constructor for why that distinction is load
// bearing rather than pedantry.

export function createChildProcess({ sys, process, Buffer, EventEmitter, Readable, childLiveness, wake, postRaw }) {
  // ---- synchronous subset (unchanged) --------------------------------------
  function spawnSync(command, args = [], opts = {}) {
    if (!Array.isArray(args)) {
      opts = args;
      args = [];
    }
    const sh = withShell(command, args, opts);
    // stdio:'inherit' means the child writes to OUR streams, and Node reports
    // `stdout`/`stderr` as null on the result because it never held them. The
    // kernel's `capture` flag is the same distinction: false lets the child's
    // output go straight to the terminal as it is produced, which is the only way
    // to see a slow child's progress — captured output cannot arrive before the
    // exit that delivers it. Python's `subprocess.run` without `capture_output`
    // wants exactly this, and so does every `spawnSync(..., {stdio:'inherit'})`
    // that used to be silently captured and dropped on the floor.
    const stdio = opts.stdio;
    const inherit = stdio === "inherit" || (Array.isArray(stdio) && stdio[1] === "inherit" && stdio[2] === "inherit");
    const spec = {
      command: sh.command,
      args: sh.args,
      cwd: opts.cwd || process.cwd(),
      env: opts.env || process.env,
      capture: !inherit,
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
    if (inherit) {
      // Nothing was captured, so there is nothing to report — reporting an empty
      // Buffer instead would read as "the child printed nothing".
      return { status: r.code, signal: null, pid: r.pid, stdout: null, stderr: null, output: [null, null, null] };
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

  // The sink itself: it actually delivers to the child. write() relays the bytes to
  // the kernel ({type:'child-stdin', childPid, chunk}); the kernel pushes them into
  // the child process' own process.stdin (see kernel.handleChildStdin). end() sends
  // EOF (null chunk). Handed to the caller as `child.stdin` only for a piped fd 0,
  // and kept as `_vvStdin` otherwise — the constructor has the argument.
  //
  // The rest of the stream-ish surface (pause/cork/setEncoding…) is chainable no-ops
  // rather than undefined, because a caller holding a real pipe may poke at any of
  // it. This used to be justified by NestJS's watch-restart calling
  // `child.stdin.pause()` before recompiling, and that example is now WRONG in an
  // instructive way: `@nestjs/cli`'s start.action.js spawns with `stdio: 'inherit'`
  // and writes `childProcessRef.stdin && childProcessRef.stdin.pause()`, so on real
  // node the guard is false and pause() never runs. We used to answer that guard
  // with an object, so nest took a branch node never takes — it worked, for a reason
  // that was not the reason. Nest is a caller this change makes CORRECT, not one
  // that needs the surface; the surface stays for genuinely piped children.
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
    constructor(pid, stdinIsPiped = true) {
      super();
      this.pid = pid;
      this.exitCode = null;
      this.signalCode = null;
      this.killed = false;
      // read()=noop: we push data as it arrives from the kernel (flowing on a
      // 'data' listener), exactly like a real child's piped stdio.
      this.stdout = new Readable({ read() {} });
      this.stderr = new Readable({ read() {} });
      // The sink always exists, because the kernel can always deliver bytes to a
      // child's fd 0. What varies is whether NODE would have handed it to the
      // caller: `child.stdin` is a stream only when fd 0 is a pipe, and null for
      // 'inherit'/'ignore'/a fd, because with those the child's fd 0 is somebody
      // else's and the parent has no end of it to write to.
      //
      // `if (child.stdin)` is how a caller ASKS which of those it got, and real
      // programs ask: npm's run-script does `if (p.stdin) p.stdin.end()`, correct
      // on node because a script run with stdio:'inherit' answers null. Answering
      // an object made that end() fire on a child that had inherited the terminal,
      // and EOF on fd 0 is a shutdown signal to anything watching for its parent to
      // go away — vite closes the dev server on it. So this is null when node says
      // null, and the sink stays reachable under a name that is visibly not node's,
      // for the one caller that needs it: our own `sh`, which forwards terminal
      // keystrokes to a foreground job because in here 'inherit' is a routing
      // decision rather than a shared file descriptor.
      this._vvStdin = makeStdin(pid);
      this.stdin = stdinIsPiped ? this._vvStdin : null;
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

  // 'pipe'/'ignore' -> the child has no terminal on fd 0. 'inherit' -> it gets what WE
  // have, which is the whole meaning of the word: a shell running `node` from inside a
  // captured `sh -c` must not hand the child a terminal the shell itself has not got.
  //
  // ABSENT MEANS 'pipe', which is node's own default and now ours. It used to mean
  // "leave the kernel's guess alone", justified by the interactive `sh` spawning its
  // foreground job without saying anything — but `sh` says so at both of its spawn
  // sites now, as do the watch supervisor and the two transparent wrappers (`npx`, the
  // `python -m` shims), so nothing is relying on the guess any more. And the guess was
  // demonstrably wrong one level down: a grandchild spawned without a stdio, inside an
  // already-captured `sh -c`, claimed isTTY=true when there was no terminal anywhere in
  // the chain — the same false claim that made bare `node` open a prompt nobody could
  // type at.
  function stdinIsPipeFrom(stdio) {
    const fd0 = Array.isArray(stdio) ? stdio[0] : stdio;
    if (fd0 === "inherit") return !process.stdin.isTTY;
    return true;
  }

  // Does the PARENT hold the write end of the child's fd 0 — i.e. is `child.stdin`
  // a stream or null? Node's rule, and note it is not the same question as
  // stdinIsPipeFrom above: that one is about what the CHILD sees on fd 0 (terminal
  // or not, which sets its isTTY), this one is about what the parent gets back.
  // Absent stdio means 'pipe', which is node's default.
  function parentHoldsStdin(stdio) {
    const fd0 = Array.isArray(stdio) ? stdio[0] : stdio;
    return fd0 == null || fd0 === "pipe" || fd0 === "overlapped";
  }

  function spawn(command, args, opts) {
    const n = normalizeArgs(command, args, opts);
    const sh = withShell(n.command, n.args, n.opts);
    const spec = {
      command: sh.command,
      args: sh.args,
      cwd: n.opts.cwd || process.cwd(),
      env: n.opts.env || process.env,
      // Does the child's stdin come from a PIPE or from the terminal? It decides the
      // child's process.stdin.isTTY, and programs branch hard on that — `node` with no
      // script has to answer "REPL" to a terminal and "read the script from stdin" to
      // a pipe, which is how `echo 'console.log(1)' | node` works at all. A caller who
      // wants the terminal passed through says `stdio: ['inherit', …]`, as node's own
      // callers do; see stdinIsPipeFrom.
      stdinIsPipe: stdinIsPipeFrom(n.opts.stdio),
    };
    let pid;
    try {
      pid = sys.spawnAsync(spec).pid | 0;
    } catch (e) {
      // Node reports a spawn failure asynchronously via an 'error' event on the
      // returned ChildProcess, not by throwing.
      const cp = new ChildProcess(-1, parentHoldsStdin(n.opts.stdio));
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
    const cp = new ChildProcess(pid, parentHoldsStdin(n.opts.stdio));
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