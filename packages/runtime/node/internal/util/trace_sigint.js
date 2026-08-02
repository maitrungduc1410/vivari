// internal/util/trace_sigint — explicit "not implemented" stub (NOT vendored).
//
// Upstream (https://github.com/nodejs/node/blob/v24.18.0/lib/internal/util/trace_sigint.js)
// is ~20 lines that hand `util.setTraceSigInt` to `internal/watchdog`'s
// SigintWatchdog, which is a thin wrapper over internalBinding('watchdog') — a
// native SIGINT handler that dumps a JS stack when Ctrl-C arrives. A guest DOES
// receive SIGINT now — the kernel posts it out of band and the runtime emits it
// on `process` (packages/runtime/signals.js), so `process.on('SIGINT')` works —
// but that is a JS-level handler, not the V8 watchdog this reaches for. There is
// no such binding here and nothing faithful to vendor: any implementation would
// be a no-op pretending to arm a native stack dumper.
//
// It is still REGISTERED rather than left missing, because lib/util.js publishes
// setTraceSigInt via `defineLazyProperties(module.exports, 'internal/util/
// trace_sigint', ['setTraceSigInt'])`. That is a getter, so merely ENUMERATING
// `util` (`{ ...util }`, a promisify-all helper, an inspector) used to fire it and
// throw `no vendored Node builtin` from code that never asked for SIGINT tracing
// — the same trap as the `fs` lazy getters (see AGENTS.md "Enumerating `fs` trips
// its lazy getters"). Now the property resolves, and only CALLING it fails, with
// a message that says why.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  function setTraceSigInt() {
    const err = new Error(
      "Vivari: util.setTraceSigInt is not implemented — it needs Node's native " +
        "SIGINT watchdog (internalBinding('watchdog')) to dump a JS stack from " +
        "outside the VM. Use process.on('SIGINT', …), which this runtime does " +
        "deliver, if you want to observe Ctrl-C.",
    );
    err.code = "ERR_METHOD_NOT_IMPLEMENTED";
    throw err;
  }

  module.exports = { setTraceSigInt };
}