// internal/event_target — minimal bridge to the host EventTarget.
//
// events.js lazily requires this only on its EventTarget-interop paths
// (getEventListeners, on(EventTarget), addAbortListener). We defer the full
// vendored EventTarget and expose the few symbols/helpers those paths read,
// backed by the platform's own EventTarget/Event where present.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const kResistStopPropagation = Symbol("kResistStopPropagation");
  const kEvents = Symbol("kEvents");

  const isEventTarget = (obj) =>
    obj != null &&
    typeof obj.addEventListener === "function" &&
    typeof obj.removeEventListener === "function";

  module.exports = {
    kResistStopPropagation,
    kEvents,
    isEventTarget,
    EventTarget: globalThis.EventTarget,
    Event: globalThis.Event,
  };
}
