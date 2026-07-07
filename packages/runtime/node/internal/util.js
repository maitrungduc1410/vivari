// internal/util — minimal, compatible subset.
//
// NOT vendored verbatim: Node's real internal/util.js is large and pulls
// internal/util/types, internalBinding('util'), the encodings table, etc. We
// provide only what the currently-vendored lib/ modules destructure at load
// time. v24's lib/path.js needs `{ isWindows, getLazy }`. This grows / is
// replaced by the real file as we adopt events + util (which need much more).
//
// Authored as a builtin factory so the loader treats it like any other module.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const isWindows = process.platform === "win32";

  // Memoize a value on first access. Matches Node's internal getLazy: returns a
  // getter function so the (possibly expensive) initializer runs at most once,
  // and only when actually needed (e.g. path.matchesGlob → internal/fs/glob).
  function getLazy(initializer) {
    let value;
    let initialized = false;
    return () => {
      if (initialized === false) {
        value = initializer();
        initialized = true;
      }
      return value;
    };
  }

  module.exports = { isWindows, getLazy };
}
