// internal/abort_controller — thin bridge to the host implementation.
//
// util.js exposes transferable AbortController helpers via lazy getters. We
// don't support transfer, but AbortController/AbortSignal exist on the platform,
// so expose those and make the transfer-only helpers fail loudly if reached.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const notSupported = () => {
    throw new Error("Vivari: transferable AbortController is not supported");
  };

  module.exports = {
    AbortController: globalThis.AbortController,
    AbortSignal: globalThis.AbortSignal,
    transferableAbortController: notSupported,
    transferableAbortSignal: notSupported,
    aborted: (signal) =>
      new Promise((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  };
}
