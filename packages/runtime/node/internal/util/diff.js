// VENDORED from Node.js — lib/internal/util/diff.js
// Source: https://github.com/nodejs/node/blob/v24.18.0/lib/internal/util/diff.js
// PROVENANCE (honest): the repo pins v24.18.0, but this sandbox has no network.
// The body below is the v22.23.2 builtin source (read out of a local Node via
// process.binding('natives')) — the newest tree reachable here. Re-diff against
// v24.18.0 when a network-capable checkout is available.
// Self-contained apart from internal/assert/myers_diff (vendored alongside).
// Wrapped as a builtin factory. Runs unmodified over our internalBinding layer (Path B).
// Do not edit the body.
export default function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  ArrayIsArray,
  ArrayPrototypeReverse,
} = primordials;

const { validateStringArray, validateString } = require('internal/validators');
const { myersDiff } = require('internal/assert/myers_diff');

function validateInput(value, name) {
  if (!ArrayIsArray(value)) {
    validateString(value, name);
    return;
  }

  validateStringArray(value, name);
}

/**
 * Generate a difference report between two values
 * @param {Array | string} actual - The first value to compare
 * @param {Array | string} expected - The second value to compare
 * @returns {Array} - An array of differences between the two values.
 * The returned data is an array of arrays, where each sub-array has two elements:
 * 1. The operation to perform: -1 for delete, 0 for no-op, 1 for insert
 * 2. The value to perform the operation on
 */
function diff(actual, expected) {
  if (actual === expected) {
    return [];
  }

  validateInput(actual, 'actual');
  validateInput(expected, 'expected');

  return ArrayPrototypeReverse(myersDiff(actual, expected));
}

module.exports = {
  diff,
};
}