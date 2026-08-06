// What the guest can SEE — and therefore what it can reach.
//
// A process in Vivari is a browser Worker, and a Worker's global object is not a
// blank slate: it is a DedicatedWorkerGlobalScope with 332 own properties and 35
// more inherited from WorkerGlobalScope and EventTarget (measured in Chrome 143;
// scripts/fixtures/realm-globals.json). A real Node process has 141 globals and a
// real Bun process 168. 228 of the browser's names exist in NEITHER, and every
// one of them was visible to guest code.
//
// Most are only wrong: `WebGLRenderingContext` in a Node process is a lie a
// feature detection will believe. A handful are worse than wrong, because they
// are capabilities that route AROUND the kernel and the VFS —
//
//   importScripts            loads and runs code off the studio's origin
//   indexedDB, caches        persistent storage on the studio's origin
//   FileSystemSyncAccessHandle, webkitRequestFileSystem
//                            the origin's private filesystem, which is where a
//                            persisted VFS lives
//   XMLHttpRequest, EventSource, WebTransport, WebSocketStream
//                            network egress that never passes the Fetcher Worker,
//                            so no rewrite, no cookie jar, no record of it
//   USB, HID, Serial, Notification, PushManager
//                            hardware and user-facing surfaces of the HOST
//   close                    ends this worker under the kernel's feet
//
// and one that is a channel rather than a capability: `addEventListener`. In a
// Worker that is the receiving end of the kernel's own link to this process (see
// packages/core/src/workers/process-worker.ts, which does `self.onmessage = …`),
// so a guest could read every stdin chunk, fetch result and signal the kernel
// delivered to any of its processes — and, by assigning `onmessage` itself, take
// the link over entirely. !157 closed the write half of that door by removing the
// guest's `postMessage`; this is the read half.
//
// HOW THE HIDING WORKS, AND WHY IT IS NOT `delete`.
// Only 332 of those names are own properties. The other 35 — `location`,
// `navigator`, `addEventListener`, `importScripts`, `caches`, `indexedDB`,
// `origin`, `isSecureContext`, … — live on the prototype chain, where `delete
// globalThis.x` is a silent no-op: it finds no own property, removes nothing, and
// returns true. 17 of them are accessors, so assigning `undefined` throws instead.
// The only thing that works for all of them is an own, writable, non-enumerable
// data property that SHADOWS whatever is behind it, which is what `hide()` does.
//
// Shadowing has a second property that matters more than tidiness: it leaves the
// original in place for the runtime. The kernel's `onmessage` was assigned before
// any of this runs, so it keeps receiving — verified in a real Chrome worker: after
// shadowing, a fresh message still reached the ORIGINAL handler, while a guest
// assignment to `onmessage` landed in the shadow property and was never called.
// The guest is disconnected from the channel; the runtime is not.
//
// The cost of shadowing is that `"location" in globalThis` stays true while
// `typeof location` is "undefined". Every feature detection in the wild uses the
// second form, and the alternative — mutating WorkerGlobalScope.prototype — would
// change the realm for the runtime as well.
//
// WHAT IS ALLOWED IS A LIST, AND THE LIST IS THE MEASUREMENT.
// The allowlist below is the set of names a real Node 22 process has, recorded
// from the binary (scripts/record-realm-globals.mjs). Anything the host realm has
// that is not on it goes. This fails CLOSED: a browser that ships a new global
// next year hides it without anyone noticing, which is the right default for a
// name nobody has thought about yet.
//
// Only names captured BEFORE the runtime installed anything are candidates, so
// nothing the runtime itself puts on the global (`process`, `Buffer`, `__oc*`, the
// `fs` that esbuild-wasm mirrors) can be swept by accident, list or no list.

import { shimMessage } from "./builtins/bun-unsupported.js";

// The globals of a real `node` (v22.23.2), recorded from the binary itself.
// Regenerate with: node scripts/record-realm-globals.mjs --node
const NODE_GLOBALS = [
  "AbortController", "AbortSignal", "AggregateError", "Array", "ArrayBuffer", "Atomics",
  "BigInt", "BigInt64Array", "BigUint64Array", "Blob", "Boolean", "BroadcastChannel",
  "Buffer", "ByteLengthQueuingStrategy", "CompressionStream", "CountQueuingStrategy",
  "Crypto", "CryptoKey", "CustomEvent", "DOMException", "DataView", "Date",
  "DecompressionStream", "Error", "EvalError", "Event", "EventTarget", "File",
  "FinalizationRegistry", "Float32Array", "Float64Array", "FormData", "Function", "Headers",
  "Infinity", "Int16Array", "Int32Array", "Int8Array", "Intl", "Iterator", "JSON", "Map",
  "Math", "MessageChannel", "MessageEvent", "MessagePort", "NaN", "Navigator", "Number",
  "Object", "Performance", "PerformanceEntry", "PerformanceMark", "PerformanceMeasure",
  "PerformanceObserver", "PerformanceObserverEntryList", "PerformanceResourceTiming",
  "Promise", "Proxy", "RangeError", "ReadableByteStreamController", "ReadableStream",
  "ReadableStreamBYOBReader", "ReadableStreamBYOBRequest", "ReadableStreamDefaultController",
  "ReadableStreamDefaultReader", "ReferenceError", "Reflect", "RegExp", "Request", "Response",
  "Set", "SharedArrayBuffer", "String", "SubtleCrypto", "Symbol", "SyntaxError",
  "TextDecoder", "TextDecoderStream", "TextEncoder", "TextEncoderStream", "TransformStream",
  "TransformStreamDefaultController", "TypeError", "URIError", "URL", "URLSearchParams",
  "Uint16Array", "Uint32Array", "Uint8Array", "Uint8ClampedArray", "WeakMap", "WeakRef",
  "WeakSet", "WebAssembly", "WebSocket", "WritableStream", "WritableStreamDefaultController",
  "WritableStreamDefaultWriter", "__defineGetter__", "__defineSetter__", "__lookupGetter__",
  "__lookupSetter__", "__proto__", "atob", "btoa", "clearImmediate", "clearInterval",
  "clearTimeout", "console", "constructor", "crypto", "decodeURI", "decodeURIComponent",
  "encodeURI", "encodeURIComponent", "escape", "eval", "fetch", "global", "globalThis",
  "hasOwnProperty", "isFinite", "isNaN", "isPrototypeOf", "navigator", "parseFloat",
  "parseInt", "performance", "process", "propertyIsEnumerable", "queueMicrotask",
  "setImmediate", "setInterval", "setTimeout", "structuredClone", "toLocaleString",
  "toString", "undefined", "unescape", "valueOf",
];

// Names the recorded Node lacks that are kept anyway, each for one stated reason.
// Anything added here is a hole in the sweep, so the reason has to be a real one.
const KEEP = [
  // A LANGUAGE feature, not a platform one. Hiding these would make a guest
  // targeting a newer runtime fail on syntax the engine happily supports, and no
  // Node/Bun program can tell "the browser gave me this" from "my engine is new".
  "AsyncDisposableStack", "DisposableStack", "Float16Array", "SuppressedError", "URLPattern",
  // The worker shell installs `self` deliberately as a writable own property
  // (process-worker.ts explains why: third-party shims assign to it). Bun has a
  // global `self` too, so this is Bun-accurate and only Node-inaccurate.
  "self",
];

// Hidden even though Node HAS a global of that name — because the object in scope
// here is the BROWSER's, and it points somewhere the guest must not reach.
const REPLACE = [
  // The kernel's own link to this process, on both the property form and the
  // listener form. Bun gets its own back below; a node guest is meant to have none.
  "postMessage", "onmessage", "onerror", "addEventListener", "removeEventListener",
  "dispatchEvent",
  // Chrome's WorkerNavigator: a full browser user-agent string, plus a
  // `serviceWorker`/`permissions`/`usb` surface. Replaced with the small object
  // Node and Bun actually expose.
  "navigator",
];

// Held back from the sweep for exactly one subsystem, which is handed the value
// directly rather than reading it off a global the guest can also see.
const HOLD = [
  // Pyodide's urllib bridge does `hasattr(js, "XMLHttpRequest")` and uses
  // synchronous XHR for blocking HTTP (builtins/python.js). It is also the one
  // way to leave this sandbox without passing the Fetcher Worker, so the guest
  // realm does not keep it: __ocInstallPython puts it back for a python guest only.
  "XMLHttpRequest",
  // `os.hostname()` and the `host.vivari.internal` alias resolve through
  // location.hostname, read lazily — i.e. after this sweep (index.js).
  "location",
  // Only for its `hardwareConcurrency`: the replacement below reports the real
  // core count, and by the time it is built the browser's navigator is hidden.
  "navigator",
];

/** Shadow `name` on `scope` with an own, writable, non-enumerable `undefined`. */
function hide(scope, name, value = undefined) {
  try {
    Object.defineProperty(scope, name, {
      value,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    return true;
  } catch {
    // Non-configurable and non-writable: `undefined`, `NaN`, `Infinity`,
    // `globalThis`. All four are on the allowlist, so reaching this is a bug
    // rather than a hazard — leave the realm as it is.
    return false;
  }
}

/**
 * Everything the host realm had before the runtime touched it. Call this FIRST,
 * at module load: the difference between "the browser put this here" and "we did"
 * is only knowable before we start.
 */
export function captureHostRealm(scope) {
  const names = new Set(Object.getOwnPropertyNames(scope));
  // Walk to Object.prototype but not into it — `toString`, `hasOwnProperty` and
  // friends are not globals, and shadowing them would break the realm outright.
  let proto = Object.getPrototypeOf(scope);
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
    proto = Object.getPrototypeOf(proto);
  }
  const held = new Map();
  for (const name of HOLD) {
    try {
      const value = scope[name];
      if (value !== undefined) held.set(name, value);
    } catch {
      /* an accessor that throws in this realm — treat it as absent */
    }
  }
  return { names, held };
}

/**
 * Hide every host-realm global a real Node process does not have, and replace
 * `navigator` with the one Node reports. Runs once, immediately before the entry
 * module — early enough that no guest code has seen the realm, late enough that
 * the runtime has finished building itself out of it.
 *
 * A bun guest is a node guest until its launcher runs, so the Bun-only globals
 * are added afterwards by installBunRealm, through __ocInstallBun.
 *
 * Returns the names hidden, for `__vv.diag()` and for the spike to assert on.
 */
export function sealGuestRealm(scope, captured) {
  const allow = new Set(NODE_GLOBALS);
  for (const name of KEEP) allow.add(name);
  for (const name of REPLACE) allow.delete(name);

  const hidden = [];
  for (const name of captured.names) {
    // Vivari's own hooks (`__ocfetch`, `__ocInstallBun`, `__vv`) are installed by
    // the host on purpose and are not part of this question.
    if (name.startsWith("__oc") || name.startsWith("__vv")) continue;
    if (allow.has(name)) continue;
    if (hide(scope, name)) hidden.push(name);
  }
  hidden.sort();

  installNavigator(scope, captured, "node");
  return hidden;
}

/**
 * `navigator` in Node is five fields; in Bun it is three. Chrome's is a
 * WorkerNavigator carrying the browser's user-agent string — which is both a lie
 * about what is running and the single most-read fingerprint on the platform.
 *
 * `hardwareConcurrency` is passed through from the host, because it is the one
 * field whose honest answer is the machine's: a guest sizing a worker pool wants
 * the real core count, and it is what `os.cpus().length` already reports.
 */
function installNavigator(scope, captured, flavor) {
  const host = captured.held.get("navigator") || scope.navigator;
  let cores = 4;
  try {
    if (host && typeof host.hardwareConcurrency === "number") cores = host.hardwareConcurrency;
  } catch {
    /* shadowed or absent — keep the default */
  }
  const platform =
    (scope.process && scope.process.platform === "win32" && "Win32") || "Linux x86_64";
  const version = (scope.process && scope.process.version) || "v22.0.0";
  const nav =
    flavor === "bun"
      ? { userAgent: "Bun/" + bunVersion(scope), platform, hardwareConcurrency: cores }
      : {
          userAgent: "Node.js/" + String(version).replace(/^v/, "").split(".")[0],
          platform,
          hardwareConcurrency: cores,
          language: "en-US",
          languages: Object.freeze(["en-US"]),
        };
  hide(scope, "navigator", Object.freeze(nav));
}

function bunVersion(scope) {
  try {
    return (scope.Bun && scope.Bun.version) || (scope.process && scope.process.versions && scope.process.versions.bun) || "1.3.0";
  } catch {
    return "1.3.0";
  }
}

/**
 * The globals Bun has and Node does not — rebuilt so they mean what Bun means.
 *
 * Bun's main thread has `postMessage`, `onmessage`, `addEventListener` and the
 * rest even though there is nobody on the other end; they are the same names a
 * Bun WORKER uses to talk to its parent, present on both sides. So the shapes
 * have to exist, and they have to be inert: a guest-local EventTarget nothing
 * ever dispatches to, rather than the kernel's channel, which is what the browser
 * would have given them.
 *
 * A Bun worker thread gets the real versions a moment later, from
 * builtins/bun-worker.js (installWorkerGlobals), which overwrites these.
 */
export function installBunRealm(scope, captured) {
  installNavigator(scope, captured, "bun");
  const listeners = new Map();
  const guestTarget = {
    addEventListener(type, fn) {
      if (typeof fn !== "function") return;
      const key = String(type);
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(fn);
    },
    removeEventListener(type, fn) {
      const set = listeners.get(String(type));
      if (set) set.delete(fn);
    },
    dispatchEvent(event) {
      const set = listeners.get(String(event && event.type));
      if (set) for (const fn of [...set]) fn.call(scope, event);
      return true;
    },
  };
  hide(scope, "addEventListener", guestTarget.addEventListener);
  hide(scope, "removeEventListener", guestTarget.removeEventListener);
  hide(scope, "dispatchEvent", guestTarget.dispatchEvent);

  // Real Bun's main-thread postMessage takes anything and returns undefined —
  // measured, not assumed. Nothing receives it, and the same call inside a worker
  // reaches the parent, so this must not throw.
  hide(scope, "postMessage", function postMessage() {
    return undefined;
  });

  // `{value: null, writable: true, enumerable: true, configurable: true}` is the
  // descriptor real Bun has for these, so assignment works and reads see null.
  for (const name of ["onmessage", "onerror"]) {
    try {
      Object.defineProperty(scope, name, {
        value: null,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } catch {
      /* leave it hidden */
    }
  }

  // Bun's reportError prints the error the way an uncaught one prints and keeps
  // going. The browser's would post it to the studio page's error handlers.
  hide(scope, "reportError", function reportError(err) {
    try {
      const text = (err && err.stack) || String(err);
      scope.process.stderr.write("error: " + text + "\n");
    } catch {
      /* stderr is gone; there is nowhere left to report to */
    }
  });

  // alert/confirm/prompt exist in Bun and block on a line of stdin. Vivari's stdin
  // is delivered as kernel messages into a flowing stream, which cannot be read
  // from inside a synchronous call — the process would have to be parked and woken
  // the way OP_ACCEPT parks a server, and that syscall does not exist yet. Until it
  // does, refusing is the only honest answer: returning null would look like the
  // user pressed Enter on an empty prompt.
  const noSyncStdin =
    "Vivari has no synchronous stdin: the terminal delivers keystrokes as kernel " +
    "messages, which cannot arrive while a call is blocking. Read a line " +
    'asynchronously instead — `for await (const line of console)` or ' +
    "node:readline — or file for a blocking stdin syscall.";
  for (const name of ["alert", "confirm", "prompt"]) {
    hide(scope, name, function () {
      throw new Error(shimMessage(name + "()", noSyncStdin));
    });
  }
}
