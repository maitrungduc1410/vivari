// internal/v8/startup_snapshot — stub.
//
// Node uses this to register callbacks for V8 startup-snapshot (de)serialization.
// We never build or restore a snapshot, so the hooks are no-ops and we report
// that we're not building one.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  module.exports = {
    namespace: {
      addSerializeCallback: () => {},
      addDeserializeCallback: () => {},
      setDeserializeMainFunction: () => {},
      isBuildingSnapshot: () => false,
    },
  };
}
