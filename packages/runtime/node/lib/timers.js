// timers — public builtin (Phase 2 #7).
//
// Node's lib/timers.js is a thin facade over the native timer lists. We already
// have a real event loop (packages/runtime/loop.js) installed on globalThis, so
// this module just delegates there. Delegation is done at CALL time (not load)
// because the runtime overrides the globalThis timers AFTER the module graph is
// built, so capturing them at load would grab the host's timers instead.
export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";
  module.exports = {
    setTimeout: (...a) => globalThis.setTimeout(...a),
    clearTimeout: (...a) => globalThis.clearTimeout(...a),
    setInterval: (...a) => globalThis.setInterval(...a),
    clearInterval: (...a) => globalThis.clearInterval(...a),
    setImmediate: (...a) => globalThis.setImmediate(...a),
    clearImmediate: (...a) => globalThis.clearImmediate(...a),
    // enroll/unenroll are legacy no-ops on our model.
    enroll: () => {},
    unenroll: () => {},
  };
}
