// internal/options — shim (Phase 2 #8).
//
// Node reads CLI/runtime flags through getOptionValue. We have no flag parser, so
// return Node's defaults for the options the vendored lib/ queries.
export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const DEFAULTS = {
    "--insecure-http-parser": false,
    "--max-http-header-size": 16384,
    "--http-parser": "llhttp",
    "--pending-deprecation": false,
    "--throw-deprecation": false,
    "--no-deprecation": false,
    "--trace-deprecation": false,
  };

  function getOptionValue(name) {
    return Object.prototype.hasOwnProperty.call(DEFAULTS, name) ? DEFAULTS[name] : undefined;
  }

  function getEmbedderOptions() {
    return { __proto__: null };
  }

  module.exports = { getOptionValue, getEmbedderOptions };
}
