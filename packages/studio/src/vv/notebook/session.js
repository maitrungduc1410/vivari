// The execution half of the notebook: the frame protocol, the queue, and the
// rules about what "interrupt" and "restart" mean when there is exactly one
// interpreter and no threads.
//
// Plain JS (not TS) so `scripts/spike-notebook.mjs` drives this exact code. It is
// deliberately transport-free — it is handed a `send`/`interrupt`/`launch` trio
// and reports through a sink — because the transport is the one part that needs a
// browser, and everything interesting is on this side of that line.
//
// QUEUEING. Pyodide has no threads and this is one interpreter, so cells run
// strictly one at a time; there is no version of this where a second Run happens
// concurrently. The queue is therefore not an optimisation, it is the only honest
// model of the machine: pressing Run four times means four cells in the order
// pressed. An execution count is handed out when a cell STARTS, not when it is
// queued, so the numbers say what the interpreter actually saw — which is the
// only thing they are good for when the alternative is reading the cells top to
// bottom and getting a different answer.
//
// INTERRUPT ABORTS THE QUEUE. Interrupting is the user saying "stop", and the
// pending cells were queued on the assumption that the running one finished. This
// is what Jupyter does, and the alternative — interrupt cell 3, watch cells 4-6
// run anyway against half-built state — is worse than either.

/** Record separator: the byte that marks a line as a protocol frame rather than
 *  as anything else that reached this stream (shell echo, Pyodide's loader). */
export const RS = "\x1e";

/** How much non-frame kernel output to keep for the "kernel log" disclosure. */
const LOG_LIMIT = 200;

/**
 * Split a raw kernel stdout chunk into frames and log lines. Stateful across
 * chunks — a frame arrives in as many pieces as the transport feels like.
 */
export class FrameReader {
  constructor() {
    this.buf = "";
  }

  /** @returns {{frames: object[], log: string[]}} */
  push(chunk) {
    this.buf += chunk;
    const frames = [];
    const log = [];
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      // LAST, not first. Everything before the separator is unrelated output that
      // did not end in a newline, and unrelated output is exactly the thing that
      // can contain anything — including an `\x1e` of its own, from a file being
      // catted or a progress bar. Splitting at the FIRST separator hands that
      // junk's tail to `JSON.parse`, which throws, and the complete frame sitting
      // after it on the same line is logged as garbage instead of being executed:
      // one dropped `done` frame is a cell that never finishes, which is this
      // feature's own most-reported symptom.
      //
      // Correct only because a frame's own bytes cannot contain a separator, which
      // `emit` in kernel-source.js now GUARANTEES rather than inherits: JSON's
      // escaping of control characters made it true by default, and a default is
      // not an invariant. If that ever stops holding, this line silently splits a
      // good frame in half — worse than the bug it fixes, since it corrupts rather
      // than loses — so the property is asserted at the writer, in
      // spike-notebook-transport.mjs, and not left as a comment here.
      const at = line.lastIndexOf(RS);
      if (at < 0) {
        if (line.trim()) log.push(line);
        continue;
      }
      if (line.slice(0, at).trim()) log.push(line.slice(0, at));
      try {
        frames.push(JSON.parse(line.slice(at + 1)));
      } catch {
        log.push(line.slice(at + 1));
      }
    }
    return { frames, log };
  }
}

/** `off` before launch, `dead` after the kernel exits — they are not the same
 *  thing and the UI should not say "start the kernel" about a crash. */
export const KERNEL_STATES = ["off", "starting", "idle", "busy", "dead"];

export class NotebookSession {
  /**
   * @param {object} io
   * @param {(line: string) => void} io.send        one JSON request line to the kernel's stdin
   * @param {() => void} io.interrupt               deliver SIGINT to the running cell
   * @param {() => void} io.launch                  start the kernel process
   * @param {() => void} io.stop                    kill it
   * @param {object} sink                           where results are applied
   */
  constructor(io, sink) {
    this.io = io;
    this.sink = sink;
    this.reader = new FrameReader();
    this.status = "off";
    this.execCount = 0;
    this.queue = [];
    this.running = null; // { id, source }
    this.log = [];
    this.info = null; // { python, platform } once the kernel says hello
    /** Why the kernel is gone, when it managed to say so on the way out: a `dead`
     *  frame from the kernel program itself. The exit that follows reports THIS
     *  rather than "the kernel exited", because a reason is the whole difference
     *  between a bug report and a shrug. */
    this.crash = null;
    /** `{ code, ename, evalue }` for the last exit, for a front end that has to
     *  tell somebody. Null while the kernel is alive. */
    this.exit = null;
    /** Cell source is read at DISPATCH, not at queue time: a cell edited while it
     *  waits should run as it now reads. Held here so the queue stays a list of ids. */
    this.pending = new Map();
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  start() {
    if (this.status === "starting" || this.status === "idle" || this.status === "busy") return;
    this.status = "starting";
    this.reader = new FrameReader();
    this.crash = null;
    this.exit = null;
    this.emitStatus();
    this.io.launch();
  }

  /**
   * Restart: a new interpreter, so every name the notebook defined is gone.
   * Outputs are LEFT ALONE — they are a record of what happened, and blanking
   * them would destroy the evidence of the run the user is restarting because of.
   * The execution counters go, because they now describe a dead interpreter.
   */
  restart() {
    this.abortAll("kernel restarted before this cell ran");
    this.io.stop();
    this.status = "off";
    this.execCount = 0;
    this.info = null;
    this.sink.onRestart?.();
    this.start();
  }

  shutdown() {
    this.abortAll("kernel stopped before this cell ran");
    if (this.status === "idle" || this.status === "busy") this.io.send(JSON.stringify({ op: "shutdown" }));
    this.io.stop();
    this.status = "off";
    this.info = null;
    this.emitStatus();
  }

  /**
   * The kernel process exited. Anything in flight died with it.
   *
   * This must always run for a kernel that goes away, and for a long time it never
   * ran at all: the terminal belongs to the shell, so `term-exit` arrived when the
   * SHELL ended — and a crashed kernel left the shell alive at a fresh prompt. The
   * transport now sequences `exit` after the kernel (studio-kernel.ts) so that this
   * is reached; a kernel that dies must be a visible error, not an absence.
   */
  onExit(code) {
    // A kernel we stopped on purpose already reported itself as "off". Its exit is
    // the thing we asked for, not news.
    if (this.status === "off") return;
    const wasRunning = this.running || this.queue.length;
    this.exit = { code: code | 0, ename: this.crash?.ename ?? "", evalue: this.crash?.evalue ?? "" };
    this.abortAll(
      this.crash
        ? `the kernel died before this cell ran (${this.crash.ename}${this.crash.evalue ? ": " + this.crash.evalue : ""})`
        : "the kernel exited before this cell ran",
    );
    this.running = null;
    this.status = "dead";
    this.info = null;
    this.emitStatus();
    this.sink.onKernelExit?.(code, !!wasRunning);
  }

  // ── running cells ──────────────────────────────────────────────────────────

  /**
   * Queue a cell. Starts the kernel if it is not up — a user pressing Run means
   * "run this", not "run this once I have separately started something".
   */
  run(cellId, source) {
    this.pending.set(cellId, source);
    // Re-queueing a cell that is already waiting is a no-op rather than a second
    // entry: clicking Run twice on the same cell means "I want this run", not
    // "run it twice".
    if (!this.queue.includes(cellId)) this.queue.push(cellId);
    this.sink.onQueued?.(cellId);
    if (this.status === "off" || this.status === "dead") this.start();
    else this.dispatch();
  }

  runMany(cells) {
    for (const c of cells) this.run(c.id, c.source);
  }

  /**
   * Interrupt the running cell and abandon the queue. Only meaningful while a
   * cell is running: at an idle prompt the interpreter is parked in the stdin
   * syscall, and a signal there takes the process down instead of raising
   * KeyboardInterrupt (the same rough edge the REPL has, python.md). So this
   * refuses rather than killing the user's session by accident.
   */
  interrupt() {
    if (this.status !== "busy" || !this.running) return false;
    this.abortQueue("interrupted before this cell ran");
    this.io.interrupt();
    return true;
  }

  dispatch() {
    if (this.status !== "idle" || this.running || this.queue.length === 0) return;
    const id = this.queue.shift();
    const source = this.pending.get(id) ?? "";
    this.pending.delete(id);
    this.execCount++;
    this.running = { id, count: this.execCount };
    this.status = "busy";
    this.sink.onStart(id, this.execCount);
    this.emitStatus();
    this.io.send(JSON.stringify({ op: "run", id, source }));
  }

  /**
   * Drop everything waiting. `started` is false for all of them by definition,
   * which is what tells the document to take their execution counts back: a
   * number next to a cell that never reached the interpreter is a lie.
   */
  abortQueue(reason) {
    const dropped = this.queue.splice(0, this.queue.length);
    for (const id of dropped) {
      this.pending.delete(id);
      this.sink.onAborted?.(id, reason, false);
    }
    return dropped;
  }

  /** …and the running one too, which is a different case: it DID start, so it
   *  keeps the count it was given. It just never finished. */
  abortAll(reason) {
    this.abortQueue(reason);
    if (this.running) this.sink.onAborted?.(this.running.id, reason.replace("before this cell ran", "while this cell was running"), true);
    this.running = null;
  }

  // ── the kernel talking back ────────────────────────────────────────────────

  /** Feed raw kernel stdout. */
  feed(chunk) {
    const { frames, log } = this.reader.push(chunk);
    if (log.length) {
      this.log.push(...log);
      if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
      this.sink.onLog?.(log);
    }
    for (const f of frames) this.onFrame(f);
  }

  onFrame(f) {
    const id = this.running ? this.running.id : null;
    // A frame that NAMES a cell other than the one running is stale, and the reason
    // one can exist is a decision this design made deliberately: an interrupt is
    // reported from two places (the kernel's own guard and the driver's catch — see
    // `interrupted` in kernel-source.js), and there is a window where both fire for
    // one request. The second `done` is the damaging half. It is unconditional, so
    // it cleared `running`, called `dispatch()` — which sends the next cell
    // SYNCHRONOUSLY, in this same frame loop — and then the duplicate pair landed on
    // that cell: its error under it, and its `done` marking it finished while the
    // kernel was still executing it, freeing a third. The kernel was fine
    // throughout; what broke was the session's model of which cell is running,
    // which is worse than a reported death, because nothing on screen says so.
    //
    // The frames already carry what is needed to refuse this, so refusing is one
    // condition rather than a protocol change, and it closes the class rather than
    // the instance: any duplicate or late frame that NAMES a cell is dropped, not
    // just this one's. Every frame that can currently be late does name one — `busy`,
    // `done`, and the interrupt report, which is stamped precisely so that it can be
    // recognised twice — so today that is the whole class. It is worth knowing which
    // of those two sentences is the guarantee: a future frame type that arrives late
    // without an id would pass, and the fix would be to give it an id rather than to
    // widen this. Logged, because a dropped frame that leaves no trace is how the
    // next version of this is diagnosed by guesswork.
    if (f.id && id && f.id !== id) {
      this.log.push(`ignored a "${f.t}" frame for ${f.id}: ${id} is the cell running now`);
      return;
    }
    switch (f.t) {
      case "ready":
        this.info = { python: f.python, platform: f.platform };
        this.status = "idle";
        this.emitStatus();
        this.dispatch();
        return;
      case "busy":
        return; // the host already knows: it is what sent the cell
      case "loading":
        // Wheels are being fetched for the cell that is about to run — the first
        // `import pandas` in a session is ~20 MB and several seconds. Transient by
        // contract: it says what is happening NOW, so it is not an output and is
        // never written into the .ipynb.
        if (id) this.sink.onLoading?.(id, String(f.text ?? ""));
        return;
      case "dead":
        // The kernel is going away and got a word in first. Reported on the cell
        // that was running, because that is where the user is looking, and kept for
        // the exit that follows so it can say why rather than that.
        this.crash = { ename: String(f.ename ?? "KernelError"), evalue: String(f.evalue ?? "") };
        if (id) {
          this.sink.onError(
            id,
            this.crash.ename,
            this.crash.evalue,
            Array.isArray(f.traceback) && f.traceback.length
              ? ["The notebook kernel stopped. This is its own error, not your cell's:", ...f.traceback]
              : ["The notebook kernel stopped: " + this.crash.ename],
          );
        }
        return;
      case "stream":
        if (id) this.sink.onStream(id, f.name === "stderr" ? "stderr" : "stdout", String(f.text ?? ""));
        return;
      case "display":
        if (id) this.sink.onDisplay(id, f.data ?? {});
        return;
      case "result":
        if (id) this.sink.onResult(id, f.data ?? {}, this.running.count);
        return;
      case "error":
        if (id) {
          this.sink.onError(id, String(f.ename ?? ""), String(f.evalue ?? ""), Array.isArray(f.traceback) ? f.traceback : []);
        }
        return;
      case "done": {
        const done = this.running;
        this.running = null;
        this.status = "idle";
        if (done) this.sink.onDone(done.id, f.status === "error" ? "error" : "ok");
        this.emitStatus();
        this.dispatch();
        return;
      }
      default:
        // A frame from a newer kernel than this front end. Logged, not dropped
        // silently — the same argument the .ipynb reader makes about fields.
        this.log.push("unrecognised kernel frame: " + JSON.stringify(f));
        return;
    }
  }

  emitStatus() {
    this.sink.onStatus?.(this.status, this.queue.length, this.running ? this.running.id : null);
  }
}
