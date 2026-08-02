// VENDORED from Node.js — lib/internal/events/symbols.js
// Source: https://github.com/nodejs/node/blob/v24.18.0/lib/internal/events/symbols.js
// PROVENANCE (honest): the repo pins v24.18.0, but this sandbox has no network.
// The body below is the v22.23.2 builtin source (read out of a local Node via
// process.binding('natives')) — the newest tree reachable here. Re-diff against
// v24.18.0 when a network-capable checkout is available.
// Interface check: our vendored v24 lib/events.js reads only 'kFirstEventParam'.
// Wrapped as a builtin factory. Runs unmodified over our internalBinding layer (Path B).
// Do not edit the body.
export default function (exports, require, module, process, internalBinding, primordials) {
'use strict';

const {
  Symbol,
} = primordials;

const kFirstEventParam = Symbol('kFirstEventParam');

module.exports = {
  kFirstEventParam,
};
}