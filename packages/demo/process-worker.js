// Browser worker entry for a single process. Waits for the kernel's `init`
// message, then boots the runtime and runs the program.

import { bootProcess } from "../runtime/boot.js";

self.onmessage = (event) => {
  const { type, sab, spec } = event.data;
  if (type !== "init") return;
  bootProcess({
    sab,
    spec,
    send: (msgType, extra) => self.postMessage({ type: msgType, ...extra }),
  });
};
