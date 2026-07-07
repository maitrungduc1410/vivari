// internal/process/permission — stub. OpenContainer has no permission model, so
// the Node.js Permission Model is always disabled. fs.js guards every access
// with `permission.isEnabled()`, so returning false keeps those checks inert.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  module.exports = {
    isEnabled: () => false,
    has: () => true,
  };
}
