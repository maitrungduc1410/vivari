// VENDORED VERBATIM from Node.js v24.18.0 — lib/internal/streams/state.js
// Source: https://github.com/nodejs/node/blob/v24.18.0/lib/internal/streams/state.js
// Wrapped as a builtin factory. Runs unmodified over our internalBinding layer (Path B).
// Do not edit the body.
export default function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  MathFloor,
  NumberIsInteger,
} = primordials;
const { validateInteger } = require('internal/validators');

const { ERR_INVALID_ARG_VALUE } = require('internal/errors').codes;

// TODO (fix): For some reason Windows CI fails with bigger hwm.
let defaultHighWaterMarkBytes = process.platform === 'win32' ? 16 * 1024 : 64 * 1024;
let defaultHighWaterMarkObjectMode = 16;

function highWaterMarkFrom(options, isDuplex, duplexKey) {
  return options.highWaterMark != null ? options.highWaterMark :
    isDuplex ? options[duplexKey] : null;
}

function getDefaultHighWaterMark(objectMode) {
  return objectMode ? defaultHighWaterMarkObjectMode : defaultHighWaterMarkBytes;
}

function setDefaultHighWaterMark(objectMode, value) {
  validateInteger(value, 'value', 0);
  if (objectMode) {
    defaultHighWaterMarkObjectMode = value;
  } else {
    defaultHighWaterMarkBytes = value;
  }
}

function getHighWaterMark(state, options, duplexKey, isDuplex) {
  const hwm = highWaterMarkFrom(options, isDuplex, duplexKey);
  if (hwm != null) {
    if (!NumberIsInteger(hwm) || hwm < 0) {
      const name = isDuplex ? `options.${duplexKey}` : 'options.highWaterMark';
      throw new ERR_INVALID_ARG_VALUE(name, hwm);
    }
    return MathFloor(hwm);
  }

  // Default value
  return getDefaultHighWaterMark(state.objectMode);
}

module.exports = {
  getHighWaterMark,
  getDefaultHighWaterMark,
  setDefaultHighWaterMark,
};

}
