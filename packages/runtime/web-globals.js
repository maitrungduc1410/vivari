// The parts of Node's web globals that a browser Worker's own are missing, which
// libraries written for Node read off them.
//
// A process's ReadableStream, WritableStream and performance are the Worker's, not
// Node's. Two differences broke undici's fetch, which pnpm 11 reaches the registry
// with (dist/pnpm.mjs bundles it), and so every `pnpm add`:
//
//   • stream.finished() on a web stream waits on
//     stream[Symbol.for('nodejs.webstream.isClosedPromise')], a deferred that Node's
//     own web streams carry and settle when they close or error (end-of-stream.js
//     eosWeb, vendored verbatim). A browser's do not, so finished() threw "Cannot read
//     properties of undefined (reading 'promise')". undici calls it on every response
//     body, caught the TypeError and aborted the request, and pnpm waited out its
//     retries on each package's metadata, minutes for an add.
//   • undici then reports the response's timing with performance.markResourceTiming,
//     which Node's global performance has and a browser's does not.
//   • Safari's ReadableStream is not async iterable (no values(), no
//     Symbol.asyncIterator; Chrome and Firefox have both). pnpm reads every tarball
//     with `for await (const chunk of response.body)`, so each download failed with
//     "undefined is not a function" and pnpm waited out its retries.
//
// Streams this process constructs get the deferred here. Ones the platform makes
// itself (a Response's body) are still without it; nothing in them can be hooked.
// Under Node (the headless harness) the native classes already carry it, and this
// leaves them alone.

const kIsClosedPromise = Symbol.for("nodejs.webstream.isClosedPromise");

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  // An errored stream nobody waits on is not an unhandled rejection.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

// `fn` called on its own object, with whatever it throws or rejects with also
// settling `closed`: the stream errors with it.
function guarded(closed, owner, fn) {
  if (typeof fn !== "function") return undefined;
  return function (...args) {
    try {
      const r = fn.apply(owner, args);
      if (r && typeof r.then === "function") r.then(undefined, closed.reject);
      return r;
    } catch (e) {
      closed.reject(e);
      throw e;
    }
  };
}

function withClosedPromise(Native, wrapCallbacks) {
  if (typeof Native !== "function" || new Native()[kIsClosedPromise] !== undefined) return Native;
  class Stream extends Native {
    constructor(callbacks = {}, strategy) {
      const closed = deferred();
      super(wrapCallbacks(callbacks ?? {}, closed), strategy);
      Object.defineProperty(this, kIsClosedPromise, { value: closed, configurable: true });
    }
    // A platform-made stream is still a ReadableStream to `instanceof`.
    static [Symbol.hasInstance](value) {
      return value instanceof Native;
    }
  }
  Object.defineProperty(Stream, "name", { value: Native.name });
  return Stream;
}

// The callbacks object stays the prototype of the one the stream gets, so the
// options read off it (`type`, `autoAllocateChunkSize`) are the caller's.
function readableSource(source, closed) {
  return Object.create(source, {
    start: {
      value(controller) {
        const { close, error } = controller;
        controller.close = function () {
          close.call(this);
          closed.resolve();
        };
        controller.error = function (e) {
          error.call(this, e);
          closed.reject(e);
        };
        return guarded(closed, source, source.start)?.(controller);
      },
    },
    pull: { value: guarded(closed, source, source.pull) },
    cancel: {
      value(reason) {
        closed.resolve();
        return typeof source.cancel === "function" ? source.cancel(reason) : undefined;
      },
    },
  });
}

function writableSink(sink, closed) {
  return Object.create(sink, {
    start: {
      value(controller) {
        const { error } = controller;
        controller.error = function (e) {
          error.call(this, e);
          closed.reject(e);
        };
        return guarded(closed, sink, sink.start)?.(controller);
      },
    },
    write: { value: guarded(closed, sink, sink.write) },
    close: {
      value() {
        return Promise.resolve(typeof sink.close === "function" ? sink.close() : undefined).then(closed.resolve, (e) => {
          closed.reject(e);
          throw e;
        });
      },
    },
    abort: {
      value(reason) {
        closed.reject(reason);
        return typeof sink.abort === "function" ? sink.abort(reason) : undefined;
      },
    },
  });
}

// The Streams spec's async iterator, on the platform class's own prototype, so a
// Response's body has it too: it holds a reader, releases it when the stream ends,
// errors, or the loop leaves early, and cancels the stream on an early exit unless
// values({ preventCancel: true }).
function withAsyncIteration(Native) {
  const proto = typeof Native === "function" ? Native.prototype : undefined;
  if (!proto || typeof proto[Symbol.asyncIterator] === "function") return;
  const AsyncIteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf(async function* () {}).prototype);
  function values({ preventCancel = false } = {}) {
    const reader = this.getReader();
    let finished = false;
    const finish = () => {
      finished = true;
      reader.releaseLock();
    };
    return Object.create(AsyncIteratorPrototype, {
      next: {
        value() {
          if (finished) return Promise.resolve({ done: true, value: undefined });
          return reader.read().then(
            (result) => {
              if (result.done) finish();
              return result.done ? { done: true, value: undefined } : result;
            },
            (e) => {
              finish();
              throw e;
            },
          );
        },
      },
      return: {
        value(value) {
          if (finished) return Promise.resolve({ done: true, value });
          const cancelled = preventCancel ? Promise.resolve() : reader.cancel(value);
          finish();
          return cancelled.then(() => ({ done: true, value }));
        },
      },
    });
  }
  const method = { value: values, writable: true, configurable: true };
  Object.defineProperty(proto, "values", method);
  Object.defineProperty(proto, Symbol.asyncIterator, method);
}

/** Gives `g`'s web streams and performance what Node's have and libraries read. */
export function installWebGlobals(g) {
  withAsyncIteration(g.ReadableStream);
  g.ReadableStream = withClosedPromise(g.ReadableStream, readableSource);
  g.WritableStream = withClosedPromise(g.WritableStream, writableSink);
  // Node's adds a PerformanceResourceTiming entry; nothing in a process reads them back.
  if (g.performance && typeof g.performance.markResourceTiming !== "function") {
    g.performance.markResourceTiming = function markResourceTiming() {};
  }
}
