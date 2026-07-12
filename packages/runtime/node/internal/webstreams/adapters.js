// internal/webstreams/adapters — WHATWG <-> Node stream interop.
//
// The vendored stream core (readable/writable/duplex) only require this LAZILY,
// inside Readable.fromWeb/toWeb, Writable.fromWeb/toWeb and Duplex.fromWeb/toWeb.
// Only `Readable.fromWeb` is implemented (a pragmatic reader pump) — it's what
// consumers of the global `fetch()` need to turn `response.body` (a WHATWG
// ReadableStream) into a Node Readable. corepack downloads a package-manager
// tarball exactly this way. The remaining directions still throw if used.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const notImplemented = (name) => () => {
    const err = new Error(
      `OpenContainer: Web Streams interop (${name}) is not implemented yet`,
    );
    err.code = "ERR_METHOD_NOT_IMPLEMENTED";
    throw err;
  };

  // Readable.fromWeb(readableStream[, options]).
  // Real Node's adapter mirrors the web ReadableStream controller with full
  // BYOB/backpressure fidelity; this pumps one `reader.read()` per `_read()`,
  // pushes the chunk (or null when done), and cancels the reader on destroy —
  // enough for the "pipe/collect the bytes" use (fetch -> file/gunzip).
  function newStreamReadableFromReadableStream(readableStream, options = {}) {
    const { Readable } = require("stream");
    if (readableStream == null || typeof readableStream.getReader !== "function") {
      const err = new TypeError(
        'The "readableStream" argument must be an instance of ReadableStream',
      );
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
    const reader = readableStream.getReader();
    let reading = false;
    const readable = new Readable({
      objectMode: false,
      ...options,
      read() {
        if (reading) return;
        reading = true;
        reader.read().then(
          ({ done, value }) => {
            reading = false;
            if (done) {
              this.push(null);
              return;
            }
            const buf =
              typeof Buffer !== "undefined" && Buffer.isBuffer(value)
                ? value
                : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
            this.push(buf);
          },
          (err) => {
            reading = false;
            this.destroy(err);
          },
        );
      },
      destroy(err, cb) {
        reader.cancel(err).then(
          () => cb(err),
          () => cb(err),
        );
      },
    });
    return readable;
  }

  module.exports = {
    newStreamReadableFromReadableStream,
    newReadableStreamFromStreamReadable: notImplemented("Readable.toWeb"),
    newStreamWritableFromWritableStream: notImplemented("Writable.fromWeb"),
    newWritableStreamFromStreamWritable: notImplemented("Writable.toWeb"),
    newStreamDuplexFromReadableWritablePair: notImplemented("Duplex.fromWeb"),
    newReadableWritablePairFromDuplex: notImplemented("Duplex.toWeb"),
  };
}
