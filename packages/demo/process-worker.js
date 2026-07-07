// Browser worker entry for a single process. Waits for the kernel's `init`
// message, then boots the runtime and runs the program. Later `net` messages
// from the kernel nudge the process event loop when a request is queued.

import { bootProcess } from "../runtime/boot.js";

let wake = null;

self.onmessage = (event) => {
  const { type, sab, spec } = event.data;
  if (type === "init") {
    bootProcess({
      sab,
      spec,
      send: (msgType, extra) => self.postMessage({ type: msgType, ...extra }),
      onReady: (w) => {
        wake = w;
      },
    });
    return;
  }
  // Kernel nudge: a network request is queued for us — wake the event loop.
  if (type === "net") wake && wake();
};
