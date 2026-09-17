// The headless twin of packages/core/src/workers/kernel-worker.ts — the third of
// the set, alongside fs-worker.mjs and process-worker.mjs.
//
// Unlike those two it is a HOST rather than a reimplementation: it installs the
// browser globals that module reaches for, routes its nested workers to their own
// headless twins, and then imports the real thing. That is the point — a spike
// driving this exercises the shipped `vv-write` / `vv-read` / `vv-import-tree`
// handlers, not a copy of them that can drift.
//
// The Fetcher Worker is stubbed: nothing here goes to the network. The two codec
// wasm modules are fetched by URL, which fails under Node and is already handled
// (compileWasmModule returns null; only spawned processes would notice).

import { parentPort } from "node:worker_threads";
import {
  installTsResolve,
  installWorkerSelf,
  installWorkerShim,
  scriptUrl,
} from "./lib/browser-worker-shim.mjs";

installTsResolve();
installWorkerShim({
  "fs-worker.ts": scriptUrl("./fs-worker.mjs"),
  "process-worker.ts": scriptUrl("./process-worker.mjs"),
  "fetcher-worker.ts": scriptUrl("./fetcher-worker-stub.mjs"),
  "python-lsp-worker.ts": scriptUrl("./fetcher-worker-stub.mjs"),
});
installWorkerSelf(parentPort);

await import("../packages/core/src/workers/kernel-worker.ts");