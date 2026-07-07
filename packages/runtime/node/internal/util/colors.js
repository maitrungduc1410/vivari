// internal/util/colors — stub.
//
// We render to a virtual, color-less stream, so util.styleText et al. never
// colorize. shouldColorize() short-circuits the whole ANSI path.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  module.exports = {
    __proto__: null,
    shouldColorize: () => false,
    hasColors: () => false,
    refresh() {},
    blue: "",
    green: "",
    white: "",
    red: "",
    gray: "",
    clear: "",
    reset: "",
    hasColorsSupport: false,
  };
}
