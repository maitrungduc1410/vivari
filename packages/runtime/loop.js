// The per-process event loop (Phase 2 #5).
//
// The old runtime ran a purely synchronous driver: main, then a `while (servers)`
// loop parked on Atomics.wait. Because the JS call stack never emptied, Promise
// microtasks and host timers could never fire. This module replaces that with a
// real, async event loop so ordering matches Node:
//
//   process.nextTick  →  Promise microtasks  →  timers  →  setImmediate
//
// Key ideas:
//   - Sync syscalls (fs/spawn) still block via Atomics.wait — unchanged. Only the
//     top-level "wait for the next event" is async now.
//   - To flush native Promise microtasks we must YIELD to the host once per turn
//     (a synchronous loop can never drain them). We yield via a MessageChannel
//     macrotask (falls back to host setTimeout).
//   - Timers are ours (deterministic ordering + ref/unref), but the actual sleep
//     is a host setTimeout, so a 100 ms timer really waits 100 ms.
//   - Idle network waiting is message-driven: the kernel postMessages the worker
//     when a request is queued (see kernel-host handleHttpRequest); `wakeNet()`
//     resolves the idle wait. The SAB channel stays free while idle, so a timer
//     callback can freely run a sync fs syscall.

// Capture the host timer + macrotask primitives BEFORE the runtime overrides the
// globals with our own versions (this module is imported before that happens).
const hostSetTimeout = globalThis.setTimeout.bind(globalThis);
const hostClearTimeout = globalThis.clearTimeout.bind(globalThis);
const now = () =>
  typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : Date.now();

// A 0-delay macrotask used to flush the microtask queue. MessageChannel isn't
// clamped like nested setTimeout(0), so a busy loop stays responsive.
const makeMacrotask = () => {
  if (typeof MessageChannel !== "undefined") {
    const mc = new MessageChannel();
    let queue = [];
    mc.port1.onmessage = () => {
      const batch = queue;
      queue = [];
      for (const fn of batch) fn();
    };
    return (fn) => {
      queue.push(fn);
      mc.port2.postMessage(0);
    };
  }
  return (fn) => hostSetTimeout(fn, 0);
};

export function createEventLoop({ isAlive, doNet, doChildren, doThreads, doWatch, doStdin, doSignal } = {}) {
  isAlive = isAlive || (() => false);
  doNet = doNet || (() => {});
  // #15: drain async child-process events (stdout/stderr/exit delivered as
  // postMessages) inside a controlled loop turn, like doNet drains HTTP.
  doChildren = doChildren || (() => {});
  // #16 stage 2b: drain worker_threads events (a Worker's 'message'/'online'/
  // 'exit', or the child's parentPort 'message'). Same controlled-turn model.
  doThreads = doThreads || (() => {});
  // roadmap #19 stage B: drain fs.watch change events (pushed by the File System
  // Worker over the fs doorbell port). Same controlled-turn model.
  doWatch = doWatch || (() => {});
  // Interactive stdin: drain keystrokes the kernel pushed (host terminal -> here)
  // into process.stdin inside a controlled turn, so the 'data' listener (a REPL,
  // our shell's line editor) runs with microtasks flushed after it, like the rest.
  doStdin = doStdin || (() => {});
  // Catchable signals (SIGTERM/SIGINT) the kernel posted to us. Delivered on a
  // turn like everything else above, and FIRST in the turn: a process being
  // asked to shut down should hear about it before it accepts more work.
  doSignal = doSignal || (() => {});

  const scheduleMacrotask = makeMacrotask();
  const macrotaskYield = () => new Promise((resolve) => scheduleMacrotask(resolve));

  const nextTickQueue = [];
  const timers = new Map(); // id -> Timeout
  let immediates = []; // Immediate[]
  let nextTimerId = 1;
  let nextImmediateId = 1;

  let exiting = false;
  let exitCode = 0;
  let netResolve = null; // resolver of an in-flight waitForNext (net branch)
  let netPending = false; // a wake arrived while not waiting

  // Wake a parked waitForNext (or remember that a wake is due). Used both for
  // external nudges (net/worker messages) AND whenever new loop work is scheduled
  // (timers/immediates/nextTick). The latter matters because activity driven
  // entirely by native callbacks — e.g. a user MessageChannel like Piscina's task
  // port, whose 'message' fires outside our controlled turn — can schedule a
  // setImmediate or a short setTimeout while drive() is parked in waitForNext().
  // Without a nudge the loop keeps sleeping until the *previously* computed nextDue
  // (which may be ~forever if only a long-lived liveness timer exists), so that
  // freshly-scheduled work never runs. Nudging makes waitForNext resolve and the
  // loop re-evaluate due timers / recompute the nearest wait.
  const wake = () => {
    if (netResolve) netResolve();
    else netPending = true;
  };

  const loop = {
    get exiting() {
      return exiting;
    },
    get exitCode() {
      return exitCode;
    },
  };

  const reportError = (e) => {
    const msg = String((e && e.stack) || e) + "\n";
    try {
      process.stderr.write(msg);
    } catch {
      /* ignore */
    }
  };

  // An error nobody caught, handled the way Node handles one.
  //
  // WHAT THIS REPLACED, AND WHY IT MATTERED: the old code called reportError and
  // carried on. The stack reached stderr, so the failure was visible — and the
  // process still exited 0. `setTimeout(() => { throw new Error("boom") })` was a
  // SUCCESS as far as any caller could tell, which means a test script, a build
  // step or a CI command that died in a callback reported that it had passed. A
  // wrong exit code is worse than a silent one: it is a lie the shell believes.
  // It also meant `process.on('uncaughtException')` never fired for anything,
  // because nothing ever emitted it.
  //
  // Node's contract, which this implements:
  //   - listeners on the event  -> emit, and KEEP RUNNING (that is the point of
  //     the hook: a server logs the error and stays up);
  //   - no listeners            -> print the stack and exit 1.
  //
  // `origin` distinguishes the two entry points, because an unhandled rejection
  // that falls through to here must be reported as one.
  const raise = (e, origin = "uncaughtException") => {
    // process.exit() from inside a callback is not an error, it is an exit.
    if (e && e.__processExit !== undefined) {
      if (!exiting) {
        exiting = true;
        exitCode = e.__processExit;
      }
      return;
    }
    let delivered = false;
    try {
      if (typeof process.listenerCount === "function" && process.listenerCount("uncaughtException") > 0) {
        delivered = true;
        process.emit("uncaughtException", e, origin);
      }
    } catch (inner) {
      // A handler that throws is fatal in Node, and both errors are worth seeing:
      // the original explains what went wrong, the second explains why the
      // handler did not save you.
      reportError(e);
      reportError(inner);
      delivered = false;
      e = null;
    }
    if (delivered) return;
    if (e !== null) reportError(e);
    if (!exiting) {
      exiting = true;
      exitCode = 1;
    }
    wake();
  };

  // A promise that rejected with nobody to catch it. Node's default since v15 is
  // `--unhandled-rejections=throw`: emit 'unhandledRejection' if that hook is set,
  // otherwise raise it as an uncaught exception. So a process with neither hook
  // prints and exits 1 — where here it did something worse than exit 0, it HUNG.
  // The rejection escaped into the host realm, whose handler rethrew it, and the
  // guest's loop went on waiting for work that was never coming while the kernel
  // waited for an exit that never arrived.
  const raiseRejection = (reason, promise) => {
    if (reason && reason.__processExit !== undefined) {
      if (!exiting) {
        exiting = true;
        exitCode = reason.__processExit;
      }
      wake();
      return;
    }
    try {
      if (typeof process.listenerCount === "function" && process.listenerCount("unhandledRejection") > 0) {
        process.emit("unhandledRejection", reason, promise);
        return;
      }
    } catch (inner) {
      reportError(reason);
      raise(inner, "unhandledRejection");
      return;
    }
    raise(reason, "unhandledRejection");
  };

  // Run a user callback, honouring process.exit() (thrown sentinel) by stopping
  // the loop with that code, and reporting anything else as an uncaught exception.
  const runCallback = (fn, args) => {
    if (exiting) return;
    try {
      fn(...args);
    } catch (e) {
      raise(e);
    }
  };

  // ---- timers ---------------------------------------------------------------

  // Frames belonging to the host page's dev tooling rather than to this sandbox.
  // An interval created from one of these does not keep the guest alive; see the
  // Timeout constructor for why this is a named frame and not a general rule.
  const HOST_TOOLING_FRAME = /\/@vite\/client/;

  class Timeout {
    constructor(cb, delay, args, isInterval) {
      this._cb = cb;
      this._delay = Math.max(0, Number(delay) || 0);
      this._args = args;
      this._interval = isInterval;
      this._ref = true;
      this._id = nextTimerId++;
      this._due = now() + this._delay;
      // Where an INTERVAL came from, for __vv.diag(). A repeating timer is the one
      // that can hold a process open forever, and "which timer" is the question the
      // count and the period could not answer — an unexplained 30s interval in every
      // process cost several wrong guesses about its origin. Intervals are rare
      // enough that one Error per creation is not a hot path; timeouts get nothing.
      if (isInterval) {
        try {
          // Drop "Error", `new Timeout` and `setInterval` — start at the caller.
          this._origin = (new Error().stack || "").split("\n").slice(3, 7).join("\n").trim();
        } catch {
          this._origin = null;
        }
        // An interval armed by the page's dev tooling is not the guest's work.
        //
        // We install the guest's timers on globalThis, and a Process Worker's
        // globals are shared with whatever else the host put in that worker. In a
        // Vite dev server that is the HMR client, which arms a 30s keepalive ping
        // (`setInterval(ping, 3e4)`) from its async `connect`. That landed in the
        // GUEST's loop as a ref'd handle, so `hasRefWork()` was true forever and no
        // guest that merely finished could exit — it printed its last line and hung.
        // Every process in a dev studio carried exactly one, confirmed by the
        // creation stack this same block records.
        //
        // Matching the frame is narrow on purpose. The general rule ("only the guest
        // and the runtime acting for it may hold the loop") cannot be read off a
        // stack safely: a production bundle has no distinguishable paths, so a
        // path-based rule would unref things that must stay ref'd — the esbuild
        // keepalive in esbuild-inproc-patch.js among them. Defaulting to ref'd and
        // naming the one host frame we know keeps the failure mode conservative,
        // and `/@vite/client` cannot appear in a production build at all.
        if (this._origin && HOST_TOOLING_FRAME.test(this._origin)) this._ref = false;
      }
      timers.set(this._id, this);
    }
    ref() {
      this._ref = true;
      return this;
    }
    unref() {
      this._ref = false;
      return this;
    }
    hasRef() {
      return this._ref;
    }
    refresh() {
      this._due = now() + this._delay;
      timers.set(this._id, this);
      wake();
      return this;
    }
    close() {
      timers.delete(this._id);
    }
    [Symbol.toPrimitive]() {
      return this._id;
    }
  }

  const clearTimer = (t) => {
    if (t == null) return;
    const id = typeof t === "object" ? t._id : t;
    timers.delete(id);
  };

  const setTimeout = (fn, delay, ...args) => {
    const t = new Timeout(fn, delay, args, false);
    wake(); // a newly-added (possibly sooner) timer must re-arm a parked wait
    return t;
  };
  const setInterval = (fn, delay, ...args) => {
    const t = new Timeout(fn, delay, args, true);
    wake();
    return t;
  };

  const runDueTimers = () => {
    if (exiting) return;
    const t = now();
    const due = [];
    for (const timer of timers.values()) if (timer._due <= t) due.push(timer);
    // Fire in due order; ties break by insertion id (Node's registration order).
    due.sort((a, b) => a._due - b._due || a._id - b._id);
    for (const timer of due) {
      if (exiting) return;
      if (!timers.has(timer._id)) continue; // cleared mid-batch
      if (timer._interval) timer._due = now() + timer._delay;
      else timers.delete(timer._id);
      runCallback(timer._cb, timer._args);
    }
  };

  // ---- immediates -----------------------------------------------------------

  class Immediate {
    constructor(cb, args) {
      this._cb = cb;
      this._args = args;
      this._ref = true;
      this._id = nextImmediateId++;
      this._cancelled = false;
    }
    ref() {
      this._ref = true;
      return this;
    }
    unref() {
      this._ref = false;
      return this;
    }
    hasRef() {
      return this._ref;
    }
    [Symbol.toPrimitive]() {
      return this._id;
    }
  }

  const setImmediate = (fn, ...args) => {
    const im = new Immediate(fn, args);
    immediates.push(im);
    wake(); // run on the next turn even if drive() is parked in waitForNext
    return im;
  };
  const clearImmediate = (im) => {
    if (im && typeof im === "object") im._cancelled = true;
  };

  const runImmediates = () => {
    if (exiting) return;
    // Snapshot: immediates queued *during* this batch run on the next turn.
    const batch = immediates;
    immediates = [];
    for (const im of batch) {
      if (exiting) return;
      if (im._cancelled) continue;
      runCallback(im._cb, im._args);
    }
  };

  // ---- microtask / nextTick draining ----------------------------------------

  const drainMicrotasks = async () => {
    // nextTick has priority over Promise microtasks. Drain nextTick fully, then
    // yield a macrotask (which flushes the native microtask queue). Repeat until
    // no nextTick callbacks remain queued after a full flush.
    do {
      while (nextTickQueue.length) {
        if (exiting) return;
        const { fn, args } = nextTickQueue.shift();
        runCallback(fn, args);
      }
      await macrotaskYield();
    } while (nextTickQueue.length && !exiting);
  };

  // ---- liveness / idle wait -------------------------------------------------

  const hasRefWork = () => {
    if (nextTickQueue.length) return true;
    if (immediates.some((im) => im._ref && !im._cancelled)) return true;
    for (const t of timers.values()) if (t._ref) return true;
    return !!isAlive();
  };

  const waitForNext = () =>
    new Promise((resolve) => {
      if (netPending) {
        netPending = false;
        resolve();
        return;
      }
      let done = false;
      let handle = null;
      const finish = () => {
        if (done) return;
        done = true;
        netResolve = null;
        if (handle !== null) hostClearTimeout(handle);
        resolve();
      };
      netResolve = finish;
      // Sleep until the earliest timer is due (host-backed real delay).
      let nextDue = Infinity;
      for (const t of timers.values()) if (t._due < nextDue) nextDue = t._due;
      if (nextDue !== Infinity) handle = hostSetTimeout(finish, Math.max(0, nextDue - now()));
      if (immediates.length) finish(); // shouldn't happen (ran above), be safe
    });

  // Drive the loop until no ref'd work remains (or process.exit was called).
  //
  // Microtasks are drained FIRST, before checking for ref'd handles. This matters
  // when `main` is an async function: after runMain the module's top-level promise
  // chain is still pending (e.g. `await vite.build()`), and no timer/worker/handle
  // exists yet — a plain `while (hasRefWork())` would see nothing to do and exit
  // before the chain could run and create its first handle. Node likewise drains
  // the microtask queue after main and only then consults the handle count.
  const drive = async () => {
    for (;;) {
      if (exiting) break;
      await drainMicrotasks();
      runCallback(doSignal, []); // deliver pending SIGTERM/SIGINT to their handlers
      await drainMicrotasks();
      runDueTimers();
      await drainMicrotasks();
      runImmediates();
      await drainMicrotasks();
      // Run inside runCallback so a process.exit() thrown from an http handler or
      // an async child's 'exit'/'data' listener (emitted synchronously here) is
      // honoured as an exit, not leaked as an unhandled rejection out of drive().
      runCallback(doNet, []); // drain any queued HTTP requests
      await drainMicrotasks();
      runCallback(doChildren, []); // drain async child stdout/stderr/exit (#15)
      await drainMicrotasks();
      runCallback(doThreads, []); // drain worker_threads message/online/exit (2b)
      await drainMicrotasks();
      runCallback(doWatch, []); // drain fs.watch change events (#19 stage B)
      await drainMicrotasks();
      runCallback(doStdin, []); // drain interactive stdin keystrokes
      await drainMicrotasks();
      if (exiting || !hasRefWork()) break;
      await waitForNext();
    }
  };

  return Object.assign(loop, {
    nextTick: (fn, ...args) => {
      nextTickQueue.push({ fn, args });
      wake(); // drain even if scheduled while drive() is parked (native-callback ctx)
    },
    setTimeout,
    clearTimeout: clearTimer,
    setInterval,
    clearInterval: clearTimer,
    setImmediate,
    clearImmediate,
    // External nudge: a network request is queued for this process.
    wakeNet: wake,
    // Stop the loop with `code` and wake any idle wait so drive() returns promptly.
    // Used by process.exit() so it works even when its throw-sentinel escapes the
    // loop (e.g. called from a raw Promise microtask, outside runCallback).
    // The two ways a guest error arrives from outside a loop callback: the host
    // realm's uncaughtException/unhandledRejection hooks (see index.js), and a
    // rejected top-level-await entry.
    raiseUncaught: (err, origin) => raise(err, origin),
    raiseUnhandledRejection: (reason, promise) => raiseRejection(reason, promise),
    requestExit: (code) => {
      if (!exiting) {
        exiting = true;
        exitCode = code | 0;
      }
      wake();
    },
    drive,
    // Unref every handle registered so far, without cancelling any of it.
    //
    // Called once, immediately before the guest's entry runs. Nothing in the loop
    // at that moment belongs to the guest, so nothing in it should be able to keep
    // the guest alive — but the callbacks still need to fire, because they belong
    // to whatever else shares this worker's globals (in a Vite dev server, the HMR
    // client's 30s keepalive ping). See the call site in runtime/index.js.
    disownExistingHandles: () => {
      for (const t of timers.values()) t._ref = false;
      for (const im of immediates) im._ref = false;
    },
    // Diagnostic: what the loop itself is holding, for __vv.diag(). A process that
    // has finished printing but will not exit is being kept alive by SOMETHING, and
    // without this the only visible symptom is a pid that never leaves the table —
    // true of every possible cause, so it distinguishes nothing. Counts only; no
    // handle is touched, so this stays safe to call while something is stuck.
    handleStats: () => {
      const refd = [...timers.values()].filter((t) => t._ref);
      return {
        timers: refd.length,
        immediates: immediates.filter((im) => im._ref && !im._cancelled).length,
        nextTicks: nextTickQueue.length,
        // The count alone says "a timer holds this process" and stops there, which
        // is where the last hang investigation stalled — every process reported
        // exactly one and there was no way to tell WHICH. The shape identifies it:
        // a `1073741824ms` interval is the esbuild keepalive, `120ms` is the ws
        // reconnect, a long one-shot is usually a guest's own. Capped, because a
        // process legitimately holding hundreds is not a case this needs to name.
        timerDetail: refd.slice(0, 8).map((t) => ({
          everyMs: t._interval ? t._delay : null,
          delayMs: t._delay,
          dueInMs: Math.round(t._due - now()),
          createdAt: t._origin || null,
        })),
      };
    },
  });
}