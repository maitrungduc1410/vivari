// A stand-in Chrome DedicatedWorkerGlobalScope, rebuilt from a recording of a
// real one.
//
// The thing the realm sweep does cannot be tested by running Node: this
// harness's global object IS a Node global object, so there is nothing to sweep
// and a broken sweep would pass. That blind spot is how the host `Worker` leak
// and the guest-visible `postMessage` both survived so long. So the browser
// realm is BUILT here, from scripts/fixtures/realm-globals.json: the 332 own
// properties and 35 prototype properties of a Chrome 143 worker global,
// including which of them are accessors — the detail that decides whether
// `delete` works (it does not, for 35 of them) and whether assigning `undefined`
// throws (it does, for 17).
//
// Shared by scripts/spike-realm.mjs (does the sweep hide what it should?) and
// scripts/spike-python-offline.mjs (can Pyodide still tell what it is running in
// once it has?). The second one is why the three interface objects are real
// constructors and `self` really returns the scope: Pyodide identifies a worker
// by `self instanceof WorkerGlobalScope`, so a realm whose interface objects are
// placeholder strings would answer that question by accident.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "realm-globals.json"), "utf8"),
);

// An interface object as the browser has it: a named function that is not
// callable, whose .prototype is the object actually on the scope's chain. That
// last part is what makes `instanceof` mean anything here.
function iface(name, prototype) {
  const ctor = {
    [name]: function () {
      throw new TypeError("Illegal constructor");
    },
  }[name];
  Object.defineProperty(ctor, "prototype", { value: prototype, writable: false });
  Object.defineProperty(prototype, "constructor", {
    value: ctor,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  return ctor;
}

// Same names, same own/prototype split, same accessor/data split. Values are
// stubs; the sweep never calls them, it only has to stop the guest reaching them.
export function makeBrowserRealm() {
  const { own, proto } = FIXTURE.browserWorker;
  // Prototype chain: DedicatedWorkerGlobalScope -> WorkerGlobalScope -> EventTarget.
  const eventTarget = Object.create(Object.prototype);
  const workerScope = Object.create(eventTarget);
  const dedicated = Object.create(workerScope);
  const target = {
    EventTarget: eventTarget,
    WorkerGlobalScope: workerScope,
    DedicatedWorkerGlobalScope: dedicated,
  };
  for (const [name, info] of Object.entries(proto)) {
    const host = target[info.on] || dedicated;
    if (info.kind === "accessor") {
      // The 17 that make `scope.x = undefined` throw in a real worker.
      Object.defineProperty(host, name, {
        get: () => "host:" + name,
        configurable: true,
        enumerable: true,
      });
    } else {
      Object.defineProperty(host, name, {
        value: () => "host:" + name,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
  }
  const scope = Object.create(dedicated);
  for (const [name, kind] of Object.entries(own)) {
    if (kind === "accessor") {
      Object.defineProperty(scope, name, { get: () => "host:" + name, configurable: true });
    } else {
      Object.defineProperty(scope, name, { value: "host:" + name, writable: true, configurable: true });
    }
  }
  // The two the runtime itself needs to survive the sweep, shaped as the browser
  // has them.
  Object.defineProperty(scope, "location", { get: () => ({ hostname: "studio.example" }), configurable: true });
  Object.defineProperty(scope, "navigator", { get: () => ({ hardwareConcurrency: 384, userAgent: "Mozilla/5.0 …" }), configurable: true });
  scope.globalThis = scope;
  // `self` is a getter on WorkerGlobalScope.prototype in a real worker and it
  // returns the global — which is the whole of Pyodide's worker test, and half
  // of why the sweep leaves `self` alone (packages/core/src/workers/process-worker.ts).
  Object.defineProperty(workerScope, "self", {
    get: () => scope,
    configurable: true,
    enumerable: true,
  });
  for (const [name, prototype] of Object.entries(target)) {
    Object.defineProperty(scope, name, {
      value: iface(name, prototype),
      writable: true,
      configurable: true,
    });
  }
  return scope;
}