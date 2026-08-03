// Bun's `Worker` — the web-flavoured one Bun puts on the global, built over
// node:worker_threads, which is real here (kernel-brokered threads, a genuine
// MessageChannel, ref/unref, terminate).
//
// WHY THIS EXISTS AT ALL, AND WHY IT IS NOT MERELY A MISSING FEATURE:
//
// The runtime replaces `fetch` and `WebSocket` on the process worker's
// globalThis, but nothing ever touched `Worker`. In a browser that global is the
// page's own nested-Worker constructor, and it was reaching guest code untouched.
// So `new Worker("./w.ts")` inside the VM did not fail — it did something worse:
// it handed "./w.ts" to the HOST, which resolved it against the Studio's origin
// as an HTTP URL, fetched whatever was (or was not) there, and produced a worker
// with no kernel, no VFS and no relation to the project. Verified rather than
// assumed: planting a sentinel constructor on the worker global before boot, the
// guest got the sentinel and the raw specifier.
//
// Node has no global `Worker`, so for a `node` guest the honest value is
// undefined and the runtime removes the host's (see index.js). Bun DOES have one,
// so under `bun` it gets this — a Worker that resolves against the VFS and runs
// on a real kernel thread.
//
// The Node tier cannot see the original bug, because Node has no global `Worker`
// for anything to leak. That is the same blind spot that hid the Vite HMR timer,
// and it is why the check that matters here asserts what the guest SEES rather
// than what this file exports.

const WORKER_LAUNCHER = "/bin/bun.js";

/**
 * A minimal DOM-ish event target: `addEventListener` plus the `on<type>`
 * property, both of which Bun's documentation uses interchangeably. Hand-rolled
 * rather than extending the platform's EventTarget so the event objects stay
 * plain — they cross no boundary that would care, and a plain object inspects
 * readably in a terminal, which a real Event does not.
 */
class BunEventEmitterish {
  constructor() {
    Object.defineProperty(this, "_listeners", { value: new Map(), enumerable: false });
  }

  addEventListener(type, fn) {
    if (typeof fn !== "function") return;
    const list = this._listeners.get(type) || [];
    list.push(fn);
    this._listeners.set(type, list);
  }

  removeEventListener(type, fn) {
    const list = this._listeners.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
  }

  _emit(type, event) {
    // The `on<type>` handler first, then listeners in registration order, which
    // is the order a browser uses. A throwing listener must not swallow the ones
    // after it, nor take down the thread that delivered the event.
    const handler = this["on" + type];
    const list = (this._listeners.get(type) || []).slice();
    if (typeof handler === "function") list.unshift(handler);
    for (const fn of list) {
      try {
        fn.call(this, event);
      } catch (err) {
        reportUncaught(err);
      }
    }
    return list.length > 0;
  }
}

function reportUncaught(err) {
  // Matches how an uncaught handler error surfaces elsewhere in the runtime:
  // loudly, on stderr, without killing the delivery of other events.
  try {
    const msg = (err && err.stack) || String(err);
    if (typeof process !== "undefined" && process.stderr) process.stderr.write(msg + "\n");
  } catch {
    /* nothing sensible left to do */
  }
}

export function createBunWorker({ lazy, process }) {
  const wt = () => lazy("worker_threads");

  /**
   * Bun resolves a Worker specifier "relative to the project root (like typing
   * `bun ./path/to/file.js`)", and also accepts the `new URL(..., import.meta.url)`
   * form its own examples use. So: absolute paths as-is, `file:` URLs by path,
   * everything else relative to cwd.
   *
   * `blob:` is Bun's third form and is refused. Not for the reason it first looks
   * like — `URL.createObjectURL` IS available to guest code here (checked, rather
   * than assumed from its absence in Node) — but because a worker is started by
   * the kernel from a FILE in the VFS, and the constructor is synchronous, so
   * there is nowhere to put the blob's bytes on the way past. It could be closed
   * by reading the blob and materialising a temp file before spawning; until then
   * it throws by name, because resolving it would produce "cannot find
   * /app/blob:…" and send someone looking for a file they never wrote.
   */
  function resolveSpecifier(specifier) {
    let spec = specifier;
    if (spec && typeof spec === "object" && typeof spec.href === "string") spec = spec.href;
    spec = String(spec);

    if (spec.startsWith("blob:")) {
      throw new Error(
        "new Worker(blob:…) is not implemented in the Vivari shim: a worker here is " +
          "started by the kernel from a file in the VM's filesystem, and this constructor " +
          "is synchronous, so there is no point at which the blob's bytes can be read and " +
          "written out. Write the source to a file and pass its path — Bun's other two " +
          "forms, a path and a file: URL, both work."
      );
    }
    if (/^https?:/.test(spec)) {
      throw new Error(
        "new Worker(" + JSON.stringify(spec) + ") is not supported in Vivari (browser sandbox): " +
          "a worker here runs a file from the VM's filesystem, not a URL fetched from the " +
          "network. Write the code to a file in your project and pass that path."
      );
    }
    if (spec.startsWith("file://")) {
      try {
        spec = decodeURIComponent(spec.slice("file://".length));
      } catch {
        spec = spec.slice("file://".length);
      }
    }
    if (spec.startsWith("/")) return spec;

    const path = lazy("path");
    return path.resolve(process.cwd() || "/", spec);
  }

  class Worker extends BunEventEmitterish {
    constructor(specifier, options) {
      super();
      const opts = options || {};
      this.onmessage = null;
      this.onerror = null;
      this.onopen = null;
      this.onclose = null;
      this.onmessageerror = null;
      this.threadId = -1;

      const entry = resolveSpecifier(specifier);

      // `preload` is refused rather than approximated. The launcher has no
      // --preload, so the only way to run modules first would be to generate a
      // wrapper file and boot THAT — which would quietly become the entry module,
      // making `import.meta.main` false and `import.meta.path` point at a file the
      // author never wrote. A wrong answer about which file is running is worse
      // than no answer, and the workaround is one import line.
      if (opts.preload != null) {
        throw new Error(
          "new Worker(…, { preload }) is not implemented in the Vivari shim: this " +
            "runtime's `bun` has no --preload, and faking it with a generated wrapper " +
            "would make the wrapper the entry module (import.meta.main would be wrong). " +
            "Import the module at the top of the worker file instead — it runs before " +
            "the rest of the file either way."
        );
      }

      // Bun: "If the worker's script fails to resolve, an 'error' event is
      // emitted on the Worker object." The kernel's own answer for a missing
      // entry is online-then-exit(1), which is indistinguishable from a worker
      // that started and failed, so the check happens here where the reason is
      // still known. Asynchronous, because a listener cannot be attached until
      // the constructor has returned.
      let exists = false;
      try {
        exists = lazy("fs").existsSync(entry);
      } catch {
        exists = false;
      }
      if (!exists) {
        this._failed = true;
        queueMicrotask(() => {
          this._emit("error", {
            type: "error",
            message: "Worker script not found: " + entry,
            filename: entry,
            error: new Error("Worker script not found: " + entry),
          });
        });
        return;
      }

      // The thread boots `/bin/bun.js run <entry>` rather than <entry> directly.
      // That single indirection is what makes the worker a BUN worker instead of
      // a bare module: the launcher installs the Bun global, applies Bun's script
      // semantics and runs the file through the loader's runMain — so TypeScript,
      // `import`, and `Bun.*` inside the worker all behave exactly as they do for
      // `bun run`, with no second implementation to keep in step.
      const argv = ["run", entry, ...(opts.argv || []).map(String)];

      const inner = new (wt().Worker)(WORKER_LAUNCHER, {
        argv,
        env: opts.env,
        workerData: opts.workerData,
      });
      this._inner = inner;

      inner.on("online", () => {
        this.threadId = inner.threadId;
        // Bun's "open" has no browser equivalent; it fires when the worker is
        // ready to receive. Messages posted before it are queued by the channel,
        // as Bun's documentation promises, so nobody has to wait for it.
        this._emit("open", { type: "open" });
      });
      inner.on("message", (data) => {
        this._emit("message", { type: "message", data });
      });
      // NOTE ON 'error': in Bun this also fires when the worker's own code throws.
      // It cannot here. The thread plumbing relays 'thread-started' and
      // 'thread-exit' and nothing between them, and the guest's
      // `process.on('uncaughtException')` is never dispatched (measured, not
      // assumed — a relay through it was written first and never fired), so there
      // is no seam to carry the Error across. A worker that throws prints its
      // stack to the terminal and arrives here as `close` with a non-zero code.
      // Listen for BOTH events if you need to fail loudly; the docs say so too.
      inner.on("error", (error) => {
        this._emit("error", {
          type: "error",
          message: (error && error.message) || String(error),
          filename: entry,
          error,
        });
      });
      inner.on("exit", (code) => {
        // Bun: the CloseEvent carries "the exit code passed to process.exit(), or
        // 0 if it closed for another reason". A worker we killed ourselves is
        // that other reason, so it reports 0 rather than the 143 the kernel uses
        // for SIGTERM — otherwise every `close` handler checking `code === 0` for
        // "ended cleanly" would see a failure it did not have.
        this._emit("close", { type: "close", code: this._terminated ? 0 : code | 0, reason: "" });
      });

      if (opts.ref === false) this.unref();
    }

    postMessage(value, transferList) {
      if (this._failed) return;
      this._inner.postMessage(value, transferList);
    }

    terminate() {
      if (this._failed) return Promise.resolve(0);
      this._terminated = true;
      return this._inner.terminate();
    }

    ref() {
      if (!this._failed) this._inner.ref();
    }

    unref() {
      if (!this._failed) this._inner.unref();
    }
  }

  /**
   * The worker SIDE of the API: inside a Bun worker, `self` is the global, and
   * `postMessage` / `onmessage` / `addEventListener` sit on it. Underneath, this
   * is the thread's `parentPort` — so a worker written against Bun's API and one
   * written against node:worker_threads talk over the same channel, and can even
   * be mixed in one file.
   *
   * Installed only in a thread (index.js gates it on isMainThread), because on
   * the main thread `self` would be a lie and `postMessage` would have nowhere
   * to go.
   */
  function installWorkerGlobals(g) {
    const parentPort = wt().parentPort;
    if (!parentPort) return false;

    // `self === globalThis` is what Bun's own `declare var self: Worker` assumes,
    // and what lets a worker call either `postMessage(x)` or `self.postMessage(x)`.
    g.self = g;

    g.postMessage = (value, transferList) => parentPort.postMessage(value, transferList);

    // One parentPort listener, fanned out here — rather than one per handler —
    // so that setting `onmessage` twice replaces the handler instead of stacking
    // a second delivery, which is what the DOM setter means.
    const target = new BunEventEmitterish();

    // Wired ON FIRST USE, never at install time. A `message` listener on the port
    // holds the thread's event loop open — that is the documented mechanism by
    // which a worker stays alive to serve requests. Attaching one here for every
    // worker therefore made EVERY worker immortal, and with it the parent that
    // waits on it: the first run of this file hung a one-line worker that only
    // printed and returned. Nothing in the API surface hints at it, so the
    // laziness below is load-bearing rather than an optimisation.
    let wired = false;
    const wire = () => {
      if (wired) return;
      wired = true;
      parentPort.on("message", (data) => {
        const event = { type: "message", data };
        if (typeof handler === "function") {
          try {
            handler.call(g, event);
          } catch (err) {
            reportUncaught(err);
          }
        }
        target._emit("message", event);
      });
    };

    let handler = null;
    Object.defineProperty(g, "onmessage", {
      configurable: true,
      get: () => handler,
      set: (fn) => {
        handler = typeof fn === "function" ? fn : null;
        if (handler) wire();
      },
    });

    g.addEventListener = (type, fn) => {
      target.addEventListener(type, fn);
      if (type === "message") wire();
    };
    g.removeEventListener = (type, fn) => target.removeEventListener(type, fn);
    return true;
  }

  return { Worker, installWorkerGlobals };
}