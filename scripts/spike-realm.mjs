// Does the realm sweep hide what a browser Worker would show a guest?
//
// The thing being tested cannot be reproduced by running Node: this harness's
// global object IS a Node global object, so there is nothing to sweep and a
// broken sweep would pass. That blind spot is exactly how the host `Worker` leak
// and the guest-visible `postMessage` both survived so long.
//
// So the browser realm is BUILT here, from a recording of a real one:
// scripts/fixtures/realm-globals.json holds the 332 own properties and 35
// prototype properties of a Chrome 143 DedicatedWorkerGlobalScope, including
// which of them are accessors — the detail that decides whether `delete` works
// (it does not, for 35 of them) and whether assigning `undefined` throws (it
// does, for 17). Rebuilding the shape and sweeping THAT is a real test; asserting
// against Node's own global is not.
//
// Run: node scripts/run-spikes.mjs --offline realm

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { captureHostRealm, sealGuestRealm, installBunRealm } from "../packages/runtime/realm.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures", "realm-globals.json"), "utf8"));

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) return console.log("  ok   " + label);
  failures++;
  console.log("  FAIL " + label + (detail ? " — " + detail : ""));
};

// ---- a stand-in DedicatedWorkerGlobalScope ---------------------------------
// Same names, same own/prototype split, same accessor/data split. Values are
// stubs; the sweep never calls them, it only has to stop the guest reaching them.
function makeBrowserRealm() {
  const { own, proto } = fixture.browserWorker;
  // Prototype chain: DedicatedWorkerGlobalScope -> WorkerGlobalScope -> EventTarget.
  const eventTarget = Object.create(Object.prototype);
  const workerScope = Object.create(eventTarget);
  const dedicated = Object.create(workerScope);
  const target = { EventTarget: eventTarget, WorkerGlobalScope: workerScope, DedicatedWorkerGlobalScope: dedicated };
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
  return scope;
}

console.log("\n1) the sweep, against a rebuilt Chrome worker global");
{
  const scope = makeBrowserRealm();
  const captured = captureHostRealm(scope);
  // The runtime installs its own globals AFTER capture — they must be untouchable.
  scope.process = { platform: "linux", version: "v22.23.2", env: {} };
  scope.Buffer = "runtime:Buffer";
  scope.__ocfetch = "runtime:__ocfetch";
  scope.fs = "runtime:fs";

  const hidden = sealGuestRealm(scope, captured);

  const nodeNames = new Set(fixture.node);
  const shouldGo = [
    // capabilities that route around the kernel and the VFS
    "importScripts", "indexedDB", "caches", "XMLHttpRequest", "EventSource", "WebTransport",
    "FileSystemSyncAccessHandle", "webkitRequestFileSystem", "StorageManager", "USB", "HID",
    "Serial", "Notification", "PushManager", "close",
    // the kernel's own channel to this process
    "addEventListener", "removeEventListener", "dispatchEvent", "postMessage", "onmessage",
    // browser tells a feature detection would believe
    "location", "origin", "isSecureContext", "crossOriginIsolated", "importScripts",
    "requestAnimationFrame", "WebGLRenderingContext", "OffscreenCanvas", "DedicatedWorkerGlobalScope",
    "WorkerGlobalScope", "ImageData", "FileReader", "trustedTypes", "Worker",
  ];
  for (const name of shouldGo) {
    check("hidden: " + name, typeof scope[name] === "undefined", "still " + typeof scope[name]);
  }

  const shouldStay = [
    "fetch", "WebSocket", "crypto", "performance", "structuredClone", "atob", "btoa", "Blob",
    "File", "FormData", "Headers", "Request", "Response", "URL", "TextEncoder", "ReadableStream",
    "MessageChannel", "MessagePort", "Event", "EventTarget", "AbortController", "queueMicrotask",
    "setTimeout", "console", "WebAssembly", "Atomics", "self",
  ];
  for (const name of shouldStay) {
    check("kept: " + name, typeof scope[name] !== "undefined", "was swept");
  }
  // Not in the recording, and correctly so: the page it was taken from was not
  // cross-origin isolated, and a worker without COOP/COEP has no
  // SharedArrayBuffer. Vivari's own realm always does — the kernel is built on it
  // — which is why the sweep captures the LIVE realm rather than this fixture.
  check("SharedArrayBuffer is allowed if the realm has one", !("SharedArrayBuffer" in scope) || typeof scope.SharedArrayBuffer !== "undefined");

  check(
    "everything the runtime installed after capture survives",
    scope.Buffer === "runtime:Buffer" && scope.__ocfetch === "runtime:__ocfetch" && scope.fs === "runtime:fs" && scope.process.platform === "linux",
  );
  check("hid a realistic number of names (200+)", hidden.length >= 200, "hid " + hidden.length);
  check(
    "nothing hidden that a real node has",
    hidden.every((n) => !nodeNames.has(n) || n === "navigator" || n === "BroadcastChannel"),
    hidden.filter((n) => nodeNames.has(n)).join(","),
  );

  // The distinction the browser probe was run to settle: for 35 of these names
  // `delete` removes nothing, because the property is not the scope's own.
  const protoNames = Object.keys(fixture.browserWorker.proto);
  check("the fixture really does have prototype-only names", protoNames.length >= 30);
  const stillOnPrototype = protoNames.filter((n) => {
    const proto = Object.getPrototypeOf(scope);
    let o = proto;
    while (o) {
      if (Object.getOwnPropertyDescriptor(o, n)) return true;
      o = Object.getPrototypeOf(o);
    }
    return false;
  });
  check(
    "shadowed rather than deleted (the originals are all still on the chain)",
    stillOnPrototype.length === protoNames.length,
    stillOnPrototype.length + "/" + protoNames.length,
  );
}

console.log("\n2) navigator says node, not Chrome");
{
  const scope = makeBrowserRealm();
  const captured = captureHostRealm(scope);
  scope.process = { platform: "linux", version: "v22.23.2", env: {} };
  sealGuestRealm(scope, captured);
  check("userAgent is Node's", scope.navigator.userAgent === "Node.js/22", scope.navigator.userAgent);
  check("hardwareConcurrency passes the real core count through", scope.navigator.hardwareConcurrency === 384);
  check("no serviceWorker/permissions/usb surface", scope.navigator.serviceWorker === undefined && scope.navigator.usb === undefined);
}

console.log("\n3) a bun guest gets Bun's globals back, inert");
{
  const scope = makeBrowserRealm();
  const captured = captureHostRealm(scope);
  const written = [];
  scope.process = { platform: "linux", version: "v22.23.2", env: {}, stderr: { write: (s) => written.push(s) } };
  sealGuestRealm(scope, captured);
  scope.Bun = { version: "1.3.14" };
  installBunRealm(scope, captured);

  check("userAgent is Bun's", scope.navigator.userAgent === "Bun/1.3.14", scope.navigator.userAgent);
  check("postMessage exists and returns undefined", typeof scope.postMessage === "function" && scope.postMessage("x") === undefined);
  check("onmessage reads null and is assignable", scope.onmessage === null);
  scope.onmessage = () => "guest";
  check("assigning onmessage stays in the guest's own property", scope.onmessage() === "guest");

  let heard = null;
  scope.addEventListener("message", (e) => {
    heard = e.data;
  });
  scope.dispatchEvent({ type: "message", data: "guest-to-guest" });
  check("the listener trio is a working, guest-local EventTarget", heard === "guest-to-guest");
  // The point of it being guest-local: the host's addEventListener is the kernel's
  // receiving end, and a guest listener on THAT sees every stdin chunk, fetch
  // result and signal the kernel delivers. Verified in a real Chrome worker
  // (a guest listener saw kernel traffic) before this replacement was written.
  check(
    "and it is not the host's",
    scope.addEventListener !== Object.getPrototypeOf(Object.getPrototypeOf(Object.getPrototypeOf(scope))).addEventListener,
  );

  scope.reportError(new Error("boom"));
  check("reportError prints and returns", written.length === 1 && written[0].includes("boom"), JSON.stringify(written));

  for (const name of ["alert", "confirm", "prompt"]) {
    let msg = "";
    try {
      scope[name]("q");
    } catch (err) {
      msg = err.message;
    }
    check(
      name + "() refuses loudly, naming the missing capability",
      msg.includes("not implemented in the Vivari shim") && msg.includes("synchronous stdin"),
      msg,
    );
  }
}

console.log("\n4) the embedded allowlist still matches the recorded binaries");
{
  // realm.js carries the node list inline (the runtime cannot read fixtures), so
  // the two can drift. They must not: the fixture is the evidence, the inline copy
  // is what runs.
  const source = readFileSync(join(here, "..", "packages", "runtime", "realm.js"), "utf8");
  const block = source.slice(source.indexOf("const NODE_GLOBALS = ["), source.indexOf("];", source.indexOf("const NODE_GLOBALS = [")));
  const inline = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  const recorded = [...fixture.node].sort();
  const missing = recorded.filter((n) => !inline.includes(n));
  const extra = inline.filter((n) => !recorded.includes(n));
  check("no recorded node global is missing from realm.js", missing.length === 0, missing.join(","));
  check("realm.js invents nothing", extra.length === 0, extra.join(","));
}

console.log("");
if (failures) {
  console.log("FAIL: " + failures + " check(s) failed");
  process.exit(1);
}
console.log("PASS: the guest realm is a node realm");
