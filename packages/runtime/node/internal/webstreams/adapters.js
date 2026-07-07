// internal/webstreams/adapters — deferred stub (Phase 2 #6).
//
// The vendored stream core (readable/writable/duplex) only require this LAZILY,
// inside Readable.fromWeb/toWeb, Writable.fromWeb/toWeb and Duplex.fromWeb/toWeb.
// WHATWG <-> Node stream interop isn't implemented yet, so those adapters throw
// if actually used; everything else in `stream` works without them.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const notImplemented = (name) => () => {
    const err = new Error(
      `OpenContainer: Web Streams interop (${name}) is not implemented yet`,
    );
    err.code = "ERR_METHOD_NOT_IMPLEMENTED";
    throw err;
  };

  module.exports = {
    newStreamReadableFromReadableStream: notImplemented("Readable.fromWeb"),
    newReadableStreamFromStreamReadable: notImplemented("Readable.toWeb"),
    newStreamWritableFromWritableStream: notImplemented("Writable.fromWeb"),
    newWritableStreamFromStreamWritable: notImplemented("Writable.toWeb"),
    newStreamDuplexFromReadableWritablePair: notImplemented("Duplex.fromWeb"),
    newReadableWritablePairFromDuplex: notImplemented("Duplex.toWeb"),
  };
}
