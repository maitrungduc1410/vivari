// internal/util/colors — color-support detection for util.styleText / inspect.
//
// This is the single hook Node's `util.styleText` consults (util.js:
// `skipColorize = !lazyUtilColors().shouldColorize(stream)`), and rslog v2 — the
// logger used by Rsbuild v2, Rspack, and friends — routes ALL of its coloring
// through `util.styleText`. A blanket `shouldColorize: () => false` therefore
// strips every color from those tools (Rsbuild v1 emitted ANSI directly via
// picocolors, so it was unaffected — hence "v1 had highlight, v2 is all white").
//
// The studio terminal (xterm.js) renders ANSI, and the kernel exports
// FORCE_COLOR=3 / TERM=xterm-256color for exactly this reason, so we honor the
// standard Node/`NO_COLOR`/`FORCE_COLOR` precedence instead of forcing off:
//   1. NO_COLOR present (any value) or TERM=dumb / NODE_DISABLE_COLORS → off
//   2. FORCE_COLOR set → on unless it's "0" (the force-color.org kill switch)
//   3. otherwise follow the stream's TTY-ness
// Headless kernels (spikes / verify-node) don't set FORCE_COLOR and write to a
// non-TTY stdout, so they still get plain output — no regression there.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const shouldColorize = (stream) => {
    const env = process.env || {};
    if (
      env.NODE_DISABLE_COLORS !== undefined ||
      env.NO_COLOR !== undefined ||
      env.TERM === "dumb"
    ) {
      return false;
    }
    if (env.FORCE_COLOR !== undefined) {
      return env.FORCE_COLOR === "" || ["1", "2", "3", "true"].includes(env.FORCE_COLOR);
    }
    return !!(stream && stream.isTTY);
  };

  module.exports = {
    __proto__: null,
    shouldColorize,
    hasColors: false,
    // Color strings used by util.inspect / internal error formatting; refreshed
    // from the live env below so they track FORCE_COLOR/NO_COLOR like Node's.
    blue: "",
    green: "",
    white: "",
    yellow: "",
    red: "",
    gray: "",
    clear: "",
    reset: "",
    refresh() {
      if (shouldColorize(process.stderr)) {
        module.exports.blue = "\u001b[34m";
        module.exports.green = "\u001b[32m";
        module.exports.white = "\u001b[39m";
        module.exports.yellow = "\u001b[33m";
        module.exports.red = "\u001b[31m";
        module.exports.gray = "\u001b[90m";
        module.exports.clear = "\u001bc";
        module.exports.reset = "\u001b[0m";
        module.exports.hasColors = true;
      } else {
        module.exports.blue = "";
        module.exports.green = "";
        module.exports.white = "";
        module.exports.yellow = "";
        module.exports.red = "";
        module.exports.gray = "";
        module.exports.clear = "";
        module.exports.reset = "";
        module.exports.hasColors = false;
      }
    },
  };

  module.exports.refresh();
}