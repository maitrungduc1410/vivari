// VENDORED VERBATIM from Node.js v24.18.0 — lib/stream/promises.js
// Source: https://github.com/nodejs/node/blob/v24.18.0/lib/stream/promises.js
// Wrapped as a builtin factory. Runs unmodified over our internalBinding layer (Path B).
// Do not edit the body.
export default function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  ArrayPrototypePop,
  Promise,
} = primordials;

const {
  isIterable,
  isNodeStream,
  isWebStream,
} = require('internal/streams/utils');

const { pipelineImpl: pl } = require('internal/streams/pipeline');
const { finished } = require('internal/streams/end-of-stream');

require('stream');

function pipeline(...streams) {
  return new Promise((resolve, reject) => {
    let signal;
    let end;
    const lastArg = streams[streams.length - 1];
    if (lastArg && typeof lastArg === 'object' &&
        !isNodeStream(lastArg) && !isIterable(lastArg) && !isWebStream(lastArg)) {
      const options = ArrayPrototypePop(streams);
      signal = options.signal;
      end = options.end;
    }

    pl(streams, (err, value) => {
      if (err) {
        reject(err);
      } else {
        resolve(value);
      }
    }, { signal, end });
  });
}

module.exports = {
  finished,
  pipeline,
};

}
