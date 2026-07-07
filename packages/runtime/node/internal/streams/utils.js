// internal/streams/utils — minimal stub.
//
// lib/util.js destructures these to special-case streams in inspect/format.
// The streams subsystem isn't vendored yet, so nothing is a stream.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const no = () => false;
  module.exports = {
    isReadableStream: no,
    isWritableStream: no,
    isNodeStream: no,
    isIterable: no,
    isDestroyed: no,
    isDisturbed: no,
  };
}
