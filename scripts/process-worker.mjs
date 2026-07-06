// Node worker_threads entry for a single process (used by the headless test and
// as the Node-side twin of the browser's demo/process-worker.js).

import { parentPort } from "node:worker_threads";
import { bootProcess } from "../packages/runtime/boot.js";

parentPort.on("message", (msg) => {
  if (msg.type !== "init") return;
  bootProcess({
    sab: msg.sab,
    spec: msg.spec,
    send: (type, extra) => parentPort.postMessage({ type, ...extra }),
  });
});
