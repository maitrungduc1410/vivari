// `timers/promises` — the promise-based timers surface modern async code uses
// (`await setTimeout(ms)`, `for await (... of setInterval(ms))`). Built directly
// on our event loop's global timers + AbortSignal, matching Node's semantics
// (resolve-with-value, `ref` option, abort -> AbortError).

export default function (exports, require, module, process, internalBinding, primordials) {
  const G = globalThis;

  function abortError(signal) {
    if (signal && signal.reason !== undefined) return signal.reason;
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    err.code = "ABORT_ERR";
    return err;
  }

  function setTimeout(after = 1, value, options = {}) {
    const { signal, ref = true } = options;
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError(signal));
      const cleanup = () => signal && signal.removeEventListener("abort", onAbort);
      const onAbort = () => {
        G.clearTimeout(timer);
        cleanup();
        reject(abortError(signal));
      };
      const timer = G.setTimeout(() => {
        cleanup();
        resolve(value);
      }, after);
      if (ref === false && timer && typeof timer.unref === "function") timer.unref();
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function setImmediate(value, options = {}) {
    const { signal, ref = true } = options;
    const set = G.setImmediate || ((fn) => G.setTimeout(fn, 0));
    const clear = G.clearImmediate || G.clearTimeout;
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError(signal));
      const cleanup = () => signal && signal.removeEventListener("abort", onAbort);
      const onAbort = () => {
        clear(timer);
        cleanup();
        reject(abortError(signal));
      };
      const timer = set(() => {
        cleanup();
        resolve(value);
      });
      if (ref === false && timer && typeof timer.unref === "function") timer.unref();
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function* setInterval(after = 1, value, options = {}) {
    const { signal } = options;
    if (signal && signal.aborted) throw abortError(signal);
    while (true) {
      await setTimeout(after, undefined, { signal });
      yield value;
    }
  }

  module.exports = { setTimeout, setImmediate, setInterval };
}
