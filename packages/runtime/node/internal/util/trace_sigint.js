// internal/util/trace_sigint — explicit "not implemented" stub (NOT vendored).
//
// Upstream (https://github.com/nodejs/node/blob/v24.18.0/lib/internal/util/trace_sigint.js)
// is ~20 lines that hand `util.setTraceSigInt` to `internal/watchdog`'s
// SigintWatchdog, which is a thin wrapper over internalBinding('watchdog') — a
// native SIGINT handler that dumps a JS stack when Ctrl-C arrives. This runtime
// has no such binding and no SIGINT at all (a guest process is a Web/worker
// thread; the kernel signals it out of band), so there is nothing faithful to
// vendor: any implementation would be a no-op pretending to arm a handler.
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
        "SIGINT watchdog (internalBinding('watchdog')), and this sandbox delivers " +
        "no POSIX signals to a guest process.",
    );
    err.code = "ERR_METHOD_NOT_IMPLEMENTED";
    throw err;
  }

  module.exports = { setTraceSigInt };
}