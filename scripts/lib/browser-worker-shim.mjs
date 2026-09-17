// Headless shims that let the REAL browser-side SDK sources run under Node, so a
// spike can exercise packages/core/src/* (and the kernel worker) instead of a
// re-implementation of them. Used by scripts/kernel-worker.mjs and the spikes
// that drive the SDK surface directly (scripts/spike-large-fs-payloads.mjs).
//
// Two gaps have to be closed:
//
//   1. Specifier resolution. The SDK's TypeScript sources import siblings by
//      their EMITTED name (`./errors.js`), which is correct for the bundler and
//      unresolvable for Node, whose loader looks for a file that does not exist.
//      A resolve hook maps `X.js` -> `X.ts` only when the .ts is there and the
//      .js is not, so packages/core/terminal-feedback.js and every other real
//      .js still resolves to itself.
//
//   2. `Worker`. Both the SDK bridge and the kernel worker construct nested
//      workers as `new Worker(new URL("./x.ts", import.meta.url), { type: "module" })`.
//      The class below is the browser shape (onmessage/onerror, postMessage with
//      a transfer list) over node:worker_threads, with each browser module URL
//      routed to its headless twin by file name.
//
// The buffering matters and is not incidental. In a page, a worker's messages are
// delivered as tasks, so a handler assigned later in the SAME task still sees
// them. node:worker_threads delivers to whatever listener exists at the time, and
// both the kernel worker (which posts `ready` at module scope) and the SDK bridge
// assign `.onmessage` after construction — so without a queue the readiness
// message is simply lost and boot hangs.

import fs from "node:fs";
import module from "node:module";
import { Worker as NodeWorker } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";

let tsResolveInstalled = false;

/** Resolve the TS sources' emitted-name imports (`./errors.js` -> `./errors.ts`). */
export function installTsResolve() {
  if (tsResolveInstalled) return;
  tsResolveInstalled = true;
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
        const asJs = new URL(specifier, context.parentURL);
        const asTs = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
        if (!fs.existsSync(fileURLToPath(asJs)) && fs.existsSync(fileURLToPath(asTs))) {
          return { url: asTs.href, shortCircuit: true };
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

/**
 * Install a browser-shaped `Worker` global.
 *
 * `routes` maps the file name a browser URL ends with (e.g. "fs-worker.ts") to
 * the headless module URL to run instead. An unmapped worker throws rather than
 * silently doing nothing, so a repro can never quietly test less than it thinks.
 */
export function installWorkerShim(routes) {
  class BrowserishWorker {
    #worker;
    #queue = [];
    #onmessage = null;

    constructor(url, _options) {
      const name = String(url).split("/").pop();
      const target = routes[name];
      if (!target) throw new Error(`repro shim: no headless twin registered for worker "${name}"`);
      this.#worker = new NodeWorker(new URL(target));
      this.onerror = null;
      this.onmessageerror = null;
      this.#worker.on("message", (data) => {
        if (this.#onmessage) this.#onmessage({ data });
        else this.#queue.push(data);
      });
      this.#worker.on("error", (err) => {
        if (this.onerror) this.onerror({ message: (err && err.message) || String(err), error: err });
      });
    }

    get onmessage() {
      return this.#onmessage;
    }

    set onmessage(fn) {
      this.#onmessage = fn;
      if (!fn) return;
      const queued = this.#queue;
      this.#queue = [];
      for (const data of queued) fn({ data });
    }

    postMessage(message, transfer) {
      this.#worker.postMessage(message, transfer && transfer.length ? transfer : undefined);
    }

    terminate() {
      void this.#worker.terminate();
    }
  }
  globalThis.Worker = BrowserishWorker;
}

/**
 * Install the `self` a worker script expects, bridged to `parentPort`. Returns
 * the shim; the caller imports the real worker module afterwards. Messages that
 * arrive before the module assigns `self.onmessage` are queued for the same
 * reason as above.
 */
export function installWorkerSelf(parentPort) {
  const queue = [];
  let handler = null;
  const self = {
    name: "repro",
    location: { origin: "" },
    crossOriginIsolated: true,
    postMessage: (message, transfer) =>
      parentPort.postMessage(message, transfer && transfer.length ? transfer : undefined),
    addEventListener() {},
    removeEventListener() {},
    get onmessage() {
      return handler;
    },
    set onmessage(fn) {
      handler = fn;
      if (!fn) return;
      const queued = queue.splice(0);
      for (const data of queued) fn({ data });
    },
  };
  parentPort.on("message", (data) => {
    if (handler) handler({ data });
    else queue.push(data);
  });
  globalThis.self = self;
  return self;
}

/** Absolute module URL for a script in this repo's scripts/ directory. */
const scriptsDir = new URL("../", import.meta.url);
export const scriptUrl = (rel) => pathToFileURL(fileURLToPath(new URL(rel, scriptsDir))).href;