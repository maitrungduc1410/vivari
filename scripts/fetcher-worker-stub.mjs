// Stand-in for the Fetcher Worker, for headless spikes that boot the real kernel
// worker (scripts/kernel-worker.mjs) but never leave the VFS. A fetch arriving
// here is a bug in the spike rather than something to service, so it answers with
// an error instead of hanging the caller on a reply that never comes.

import { parentPort } from "node:worker_threads";

parentPort.on("message", (m) => {
  if (m && m.type === "fetch") {
    parentPort.postMessage({
      type: "fetch-result",
      id: m.id,
      error: "repro stub: no network in this harness",
    });
  }
});