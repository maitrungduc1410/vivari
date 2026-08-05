// internal/worker/js_transferable — Vivari shim, not a vendored body.
//
// The real module marks an object cloneable/transferable for Node's structured
// serializer by setting a private symbol, and it reaches internalBinding('messaging')
// and internal/webidl to do it. Nothing here goes through Node's serializer — our
// Worker messaging is the host's postMessage — so there is no serializer to mark for,
// and vendoring it would drag in two bindings to support a path that cannot run.
//
// It exists because internal/blocklist.js and internal/socketaddress.js call
// markTransferMode() in their constructors, which is the only reason they touch this
// module at all. The honest limit, stated rather than faked: a BlockList or
// SocketAddress cannot be postMessage'd to a Worker here. kClone/kDeserialize are
// real symbols so the classes' methods keyed on them still define cleanly; nothing
// invokes them.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  module.exports = {
    markTransferMode() {},
    kClone: Symbol("kClone"),
    kDeserialize: Symbol("kDeserialize"),
    setDeserializerCreateObjectFunction() {},
  };
}
