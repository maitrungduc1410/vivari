// `Bun.sleepSync` — a real blocking sleep, not a spin.
//
// Real Bun calls nanosleep(2): the thread is descheduled and the core is free.
// The shim's first version was `while (Date.now() < end);`, which produces the
// right elapsed time and nothing else that is right — it pins the core at 100%
// for the whole duration, and on a one-worker-per-process kernel that is an
// entire CPU burnt to wait. In the browser the closest primitive to nanosleep is
// `Atomics.wait` on a word nobody notifies: the thread genuinely parks and the
// wait ends by timing out. That primitive is the same one the whole synchronous
// syscall bridge is built on; it is exported from packages/protocol/syscall.js
// (`parkFor`) so this file, and any future blocking API, can reach it without a
// syscall attached.
//
// The catch is that `Atomics.wait` is only permitted where blocking is allowed:
// a Web Worker (every guest process here) and Node's main thread. On a browser's
// MAIN thread it throws. That case must NOT become a throw from sleepSync — a
// context where sleeping used to work would start failing — so `parkFor` reports
// its capability and we keep the spin as an explicit, documented fallback. The
// fallback is slow, never wrong: the sleep still lasts the requested time.
//
// Argument handling mirrors Bun's `sleepSync` exactly (src/bun.js/api/
// BunObject.zig): at least one argument is required, it must be a number (NOT a
// Date — that overload belongs to the async `Bun.sleep`), it is coerced to i32
// (so `1.9` sleeps 1ms and a value past 2^31 wraps, as JS `|0` does), and a
// negative duration is an error rather than a no-op. Those throws are Bun's own,
// not sandbox limitations, so they are reproduced rather than softened.

import { parkFor } from "../../protocol/syscall.js";

/**
 * Build `Bun.sleepSync`. `park(ms)` must block for `ms` and return true, or
 * return false immediately if this thread may not block; `spin(ms)` is the
 * fallback (injectable so the offline spike can drive both paths).
 */
export function createSleepSync({ park = parkFor, now = Date.now } = {}) {
  return function sleepSync(ms) {
    if (arguments.length < 1) {
      throw new TypeError("Bun.sleepSync requires 1 argument (milliseconds), but only 0 were passed");
    }
    if (typeof ms !== "number") {
      throw new TypeError(
        'The "milliseconds" argument to Bun.sleepSync must be of type number. Received type ' +
          typeof ms +
          " (Bun.sleep accepts a Date; Bun.sleepSync does not)"
      );
    }
    // JS `|0` IS the i32 coercion Bun performs, including NaN -> 0 and the wrap
    // past 2^31 its comment calls out.
    const milliseconds = ms | 0;
    if (milliseconds < 0) {
      throw new TypeError("argument to Bun.sleepSync must not be negative, got " + milliseconds);
    }
    if (milliseconds === 0) return undefined;
    if (park(milliseconds)) return undefined;
    // No parking on this thread (a browser main thread, or no SharedArrayBuffer
    // because the page is not cross-origin isolated). Burn the time instead —
    // correct duration, wrong cost — because the alternative is failing a call
    // that has always worked.
    const end = now() + milliseconds;
    while (now() < end) {
      /* spin: the only way to block a thread that may not park */
    }
    return undefined;
  };
}