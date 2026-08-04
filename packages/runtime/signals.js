// Signal delivery, guest side.
//
// The kernel used to carry a signal name the whole way from `process.kill()` to
// `finalize()` and then drop it: the target was `Worker.terminate()`d, which is
// abrupt and unobservable, so `process.on('SIGTERM')` could never run. This
// module is the receiving half of the fix — the kernel now *posts* a catchable
// signal to the process instead of applying it (see Kernel#signal).
//
// Two inbound paths, one queue:
//   - `dispatch(msg)` — the kernel's postMessage. The normal case: an idle
//     server parks in the event loop's async wait, not in Atomics.wait, so this
//     arrives within a turn.
//   - `onPending(names)` — harvested from the syscall SAB by the park loop in
//     fs-client.js. This is the case postMessage cannot serve: a guest blocked
//     mid-syscall is not draining its message queue at all.
//
// Both only ENQUEUE. Delivery happens in `drain()`, which the event loop calls
// on a turn (loop.js `doSignal`), for the same reason worker_threads messages,
// fork IPC and stdin are delivered that way: a handler that calls
// process.exit() must be honoured as an exit, and its microtasks must flush
// after it. Running a handler from the syscall park — the one place a signal
// can arrive while guest JS is on the stack — would also re-enter the shared
// window mid-request.
//
// The pending set is a Set, not a queue, because that is what Unix pending
// signals are: two SIGTERMs that arrive before the process gets a turn collapse
// into one delivery. It also makes the two inbound paths idempotent, so the
// kernel can safely use both for the same signal.

import { isCatchableSignal, defaultSignalExitCode } from "../protocol/syscall.js";

export function createSignalDelivery({ process, loop, postRaw = null }) {
  const pending = new Set();

  const enqueue = (name) => {
    if (!isCatchableSignal(name)) return;
    pending.add(name);
    loop.wakeNet();
  };

  // Which signals this process has a listener for. The kernel needs to know:
  // with no listener the default action is to terminate the process *now*, with
  // the exit code it has always used, and that is done host-side so it stays
  // exactly as immediate as it is today (a dev-server restart that kills and
  // respawns must not start racing a lingering process for its port).
  const announced = new Set();
  const announce = (name, active) => {
    if (!postRaw) return; // no channel to the kernel: default action, as before
    try {
      postRaw({ type: "signal-listen", signal: name, active });
    } catch {
      /* kernel gone */
    }
  };

  // "I took that signal, dealt with it, and I am staying" — which is a different
  // claim from "my handler ran", and only the guest can make it.
  //
  // Running a handler is NOT enough to earn this: the force-kill window exists
  // precisely for the process that catches a signal and then never gets around
  // to leaving, and standing it down automatically would remove the only thing
  // stopping such a process wedging the kernel. So it is opt-in, and the one
  // caller is the Python runtime, where a KeyboardInterrupt legitimately returns
  // the interpreter to its prompt with the process still alive and wanted.
  const standDown = (name) => {
    if (!postRaw || !isCatchableSignal(name)) return;
    try {
      postRaw({ type: "signal-handled", signal: name });
    } catch {
      /* kernel gone */
    }
  };

  // 'newListener' fires BEFORE the listener is added (so count 0 = this is the
  // first one); 'removeListener' fires after (count 0 = that was the last).
  process.on("newListener", (name) => {
    if (!isCatchableSignal(name) || announced.has(name)) return;
    if (process.listenerCount(name) === 0) {
      announced.add(name);
      announce(name, true);
    }
  });
  process.on("removeListener", (name) => {
    if (!isCatchableSignal(name) || !announced.has(name)) return;
    if (process.listenerCount(name) === 0) {
      announced.delete(name);
      announce(name, false);
    }
  });

  return {
    standDown,
    /** Kernel postMessage: { type:'signal', signal }. */
    dispatch: (msg) => {
      if (msg && msg.signal) enqueue(msg.signal);
    },
    /** Signal bits harvested from the SAB while parked in a syscall. */
    onPending: (names) => {
      for (const name of names) enqueue(name);
    },
    /** One event-loop turn's worth of signal delivery. */
    drain: () => {
      if (!pending.size) return;
      const names = [...pending];
      pending.clear();
      for (const name of names) {
        // A listener means the process decides: it runs its handler and exits
        // when and how it likes. No listener means the default action — the
        // kernel normally applies that itself, so reaching here is the narrow
        // race where the last listener was removed after the kernel checked.
        if (process.listenerCount(name) > 0) process.emit(name, name);
        else loop.requestExit(defaultSignalExitCode(name));
      }
    },
  };
}