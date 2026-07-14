// internal/util/parse_args/utils — helpers for util.parseArgs.
//
// Logic copied faithfully from Node's lib/internal/util/parse_args/utils.js,
// written in plain JS (the primordial-uncurried form is unnecessary here) and
// wrapped as a builtin factory so the loader treats it like any other module.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const { validateObject } = require("internal/validators");

  // Determines if the argument may be used as an option value.
  function isOptionValue(value) {
    if (value == null) return false;
    // Open Group Utility Conventions are that an option-argument may start with
    // a dash; parseArgs is greedy and accepts anything here.
    return true;
  }

  // Detect whether there is possible confusion and require further protection.
  function isOptionLikeValue(value) {
    if (value == null) return false;
    return value.length > 1 && value.charAt(0) === "-";
  }

  // Determines if `arg` is just a short option, e.g. '-f'.
  function isLoneShortOption(arg) {
    return arg.length === 2 && arg.charAt(0) === "-" && arg.charAt(1) !== "-";
  }

  // Determines if `arg` is a lone long option, e.g. '--foo' (not '--foo=bar').
  function isLoneLongOption(arg) {
    return arg.length > 2 && arg.startsWith("--") && !arg.includes("=", 3);
  }

  // Determines if `arg` is a long option and value, e.g. '--foo=bar'.
  function isLongOptionAndValue(arg) {
    return arg.length > 2 && arg.startsWith("--") && arg.includes("=", 3);
  }

  // Determines if `arg` is a short option group, e.g. '-ab'.
  function isShortOptionGroup(arg, options) {
    if (arg.length <= 2) return false;
    if (arg.charAt(0) !== "-") return false;
    if (arg.charAt(1) === "-") return false;

    const firstShort = arg.charAt(1);
    const longOption = findLongOptionForShort(firstShort, options);
    return optionsGetOwn(options, longOption, "type") !== "string";
  }

  // Determine if arg is a short string option followed by its value, e.g. '-fFILE'.
  function isShortOptionAndValue(arg, options) {
    validateObject(options, "options");

    if (arg.length <= 2) return false;
    if (arg.charAt(0) !== "-") return false;
    if (arg.charAt(1) === "-") return false;

    const shortOption = arg.charAt(1);
    const longOption = findLongOptionForShort(shortOption, options);
    return optionsGetOwn(options, longOption, "type") === "string";
  }

  // Find the long option associated with a short option, or the short option
  // itself if no long option is configured with that `short`.
  function findLongOptionForShort(shortOption, options) {
    validateObject(options, "options");
    const longOptionEntry = Object.entries(options).find(
      ([, optionConfig]) => objectGetOwn(optionConfig, "short") === shortOption,
    );
    return longOptionEntry?.[0] ?? shortOption;
  }

  // Whether a default value should be applied for an option not set by args.
  function useDefaultValueOption(longOption, optionConfig, values) {
    return objectGetOwn(optionConfig, "default") !== undefined && values[longOption] === undefined;
  }

  // Own-property reads that ignore __proto__ etc. (prototype-pollution safe).
  function objectGetOwn(obj, prop) {
    if (Object.prototype.hasOwnProperty.call(obj, prop)) return obj[prop];
  }

  function optionsGetOwn(options, longOption, prop) {
    if (Object.prototype.hasOwnProperty.call(options, longOption))
      return objectGetOwn(options[longOption], prop);
  }

  module.exports = {
    findLongOptionForShort,
    isLoneLongOption,
    isLoneShortOption,
    isLongOptionAndValue,
    isOptionValue,
    isOptionLikeValue,
    isShortOptionAndValue,
    isShortOptionGroup,
    useDefaultValueOption,
    objectGetOwn,
    optionsGetOwn,
  };
}
