// internal/util/parse_args/parse_args — the util.parseArgs implementation.
//
// Logic copied faithfully from Node's lib/internal/util/parse_args/parse_args.js
// (Node 20 LTS behavior), written in plain JS and wrapped as a builtin factory.
// lib/util.js attaches this lazily as `util.parseArgs`.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const {
    validateArray,
    validateBoolean,
    validateBooleanArray,
    validateObject,
    validateString,
    validateStringArray,
    validateUnion,
  } = require("internal/validators");

  const {
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
  } = require("internal/util/parse_args/utils");

  const {
    codes: {
      ERR_INVALID_ARG_VALUE,
      ERR_PARSE_ARGS_INVALID_OPTION_VALUE,
      ERR_PARSE_ARGS_UNKNOWN_OPTION,
      ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL,
    },
  } = require("internal/errors");

  const kEmptyObject = Object.freeze({ __proto__: null });

  // Work out where to slice process.argv for user-supplied arguments.
  function getMainArgs() {
    const argv = Array.isArray(process.argv) ? process.argv : [];
    const execArgv = Array.isArray(process.execArgv) ? process.execArgv : [];

    // Scenarios where user CLI args follow the executable directly.
    if (
      execArgv.includes("-e") ||
      execArgv.includes("--eval") ||
      execArgv.includes("-p") ||
      execArgv.includes("--print")
    ) {
      return argv.slice(1);
    }

    // Normally the first two arguments are executable and script.
    return argv.slice(2);
  }

  // In strict mode, throw for usage errors.
  function checkOptionUsage(config, token) {
    if (!Object.prototype.hasOwnProperty.call(config.options, token.name)) {
      throw new ERR_PARSE_ARGS_UNKNOWN_OPTION(token.rawName, config.allowPositionals);
    }

    const short = optionsGetOwn(config.options, token.name, "short");
    const shortAndLong = `${short ? `-${short}, ` : ""}--${token.name}`;
    const type = optionsGetOwn(config.options, token.name, "type");
    if (type === "string" && typeof token.value !== "string") {
      throw new ERR_PARSE_ARGS_INVALID_OPTION_VALUE(`Option '${shortAndLong} <value>' argument missing`);
    }
    // (Idiomatic test for boolean option with value done in phase 2 below.)
    if (type === "boolean" && token.value !== undefined) {
      throw new ERR_PARSE_ARGS_INVALID_OPTION_VALUE(`Option '${shortAndLong}' does not take an argument`);
    }
  }

  // Guard against an ambiguous value that looks like another option.
  function checkOptionLikeValue(token) {
    if (!token.inlineValue && isOptionLikeValue(token.value)) {
      const errorMessage =
        `Option '${token.rawName}' argument is ambiguous.\n` +
        `Did you forget to specify the option argument for '${token.rawName}'?\n` +
        `To specify an option argument starting with a dash use ` +
        `'${token.rawName}=-XYZ' or '${token.rawName} -- -XYZ'.`;
      throw new ERR_PARSE_ARGS_INVALID_OPTION_VALUE(errorMessage);
    }
  }

  // Store the option value in `values`.
  function storeOption(longOption, optionValue, options, values) {
    if (longOption === "__proto__") {
      return; // No. Just no.
    }

    // We store based on the option value rather than option type, preserving the
    // user's intent for the author to deal with.
    const newValue = optionValue ?? true;
    if (optionsGetOwn(options, longOption, "multiple")) {
      // Always store value in an array, including for boolean.
      if (values[longOption]) {
        values[longOption].push(newValue);
      } else {
        values[longOption] = [newValue];
      }
    } else {
      values[longOption] = newValue;
    }
  }

  // Store the default option value in `values`.
  function storeDefaultOption(longOption, optionValue, values) {
    if (longOption === "__proto__") {
      return; // No. Just no.
    }
    values[longOption] = optionValue;
  }

  // Phase 1: tokenize the raw args into a stream of tokens.
  function argsToTokens(args, options) {
    const tokens = [];
    let index = -1;
    let groupCount = 0;

    const remainingArgs = args.slice();
    while (remainingArgs.length > 0) {
      const arg = remainingArgs.shift();
      const nextArg = remainingArgs[0];
      if (groupCount > 0) {
        groupCount--;
      } else {
        index++;
      }

      // An options terminator: everything after a bare '--' is positional.
      if (arg === "--") {
        tokens.push({ kind: "option-terminator", index });
        for (const arg2 of remainingArgs) {
          tokens.push({ kind: "positional", index: ++index, value: arg2 });
        }
        break;
      }

      if (isLoneShortOption(arg)) {
        // e.g. '-f'
        const shortOption = arg.charAt(1);
        const longOption = findLongOptionForShort(shortOption, options);
        let value;
        let inlineValue;
        if (optionsGetOwn(options, longOption, "type") === "string" && isOptionValue(nextArg)) {
          // e.g. '-f', 'bar'
          value = remainingArgs.shift();
          inlineValue = false;
        }
        tokens.push({ kind: "option", name: longOption, rawName: arg, index, value, inlineValue });
        if (value != null) ++index;
        continue;
      }

      if (isShortOptionGroup(arg, options)) {
        // Expand -fXzy to -f -X -z -y
        const expanded = [];
        for (let i = 1; i < arg.length; i++) {
          const shortOption = arg.charAt(i);
          const longOption = findLongOptionForShort(shortOption, options);
          if (optionsGetOwn(options, longOption, "type") !== "string" || i === arg.length - 1) {
            // Boolean option, or last short in group. Well formed.
            expanded.push(`-${shortOption}`);
          } else {
            // String option in the middle: expand -abfFILE to -a -b -fFILE.
            expanded.push(`-${arg.slice(i)}`);
            break;
          }
        }
        remainingArgs.unshift(...expanded);
        groupCount = expanded.length;
        continue;
      }

      if (isShortOptionAndValue(arg, options)) {
        // e.g. '-fFILE'
        const shortOption = arg.charAt(1);
        const longOption = findLongOptionForShort(shortOption, options);
        const value = arg.slice(2);
        tokens.push({
          kind: "option",
          name: longOption,
          rawName: `-${shortOption}`,
          index,
          value,
          inlineValue: true,
        });
        continue;
      }

      if (isLoneLongOption(arg)) {
        // e.g. '--foo'
        const longOption = arg.slice(2);
        let value;
        let inlineValue;
        if (optionsGetOwn(options, longOption, "type") === "string" && isOptionValue(nextArg)) {
          // e.g. '--foo', 'bar'
          value = remainingArgs.shift();
          inlineValue = false;
        }
        tokens.push({ kind: "option", name: longOption, rawName: arg, index, value, inlineValue });
        if (value != null) ++index;
        continue;
      }

      if (isLongOptionAndValue(arg)) {
        // e.g. '--foo=bar'
        const equalIndex = arg.indexOf("=");
        const longOption = arg.slice(2, equalIndex);
        const value = arg.slice(equalIndex + 1);
        tokens.push({
          kind: "option",
          name: longOption,
          rawName: `--${longOption}`,
          index,
          value,
          inlineValue: true,
        });
        continue;
      }

      tokens.push({ kind: "positional", index, value: arg });
    }
    return tokens;
  }

  const parseArgs = (config = kEmptyObject) => {
    const args = objectGetOwn(config, "args") ?? getMainArgs();
    const strict = objectGetOwn(config, "strict") ?? true;
    const allowPositionals = objectGetOwn(config, "allowPositionals") ?? !strict;
    const returnTokens = objectGetOwn(config, "tokens") ?? false;
    const options = objectGetOwn(config, "options") ?? { __proto__: null };
    // Bundle these up for passing to strict-mode checks.
    const parseConfig = { args, strict, options, allowPositionals };

    // Validate input configuration.
    validateArray(args, "args");
    validateBoolean(strict, "strict");
    validateBoolean(allowPositionals, "allowPositionals");
    validateBoolean(returnTokens, "tokens");
    validateObject(options, "options");

    Object.entries(options).forEach(([longOption, optionConfig]) => {
      validateObject(optionConfig, `options.${longOption}`);

      // type is required.
      const optionType = objectGetOwn(optionConfig, "type");
      validateUnion(optionType, `options.${longOption}.type`, ["string", "boolean"]);

      if (Object.prototype.hasOwnProperty.call(optionConfig, "short")) {
        const shortOption = optionConfig.short;
        validateString(shortOption, `options.${longOption}.short`);
        if (shortOption.length !== 1) {
          throw new ERR_INVALID_ARG_VALUE(
            `options.${longOption}.short`,
            shortOption,
            "must be a single character",
          );
        }
      }

      const multipleOption = objectGetOwn(optionConfig, "multiple");
      if (Object.prototype.hasOwnProperty.call(optionConfig, "multiple")) {
        validateBoolean(multipleOption, `options.${longOption}.multiple`);
      }

      const defaultValue = objectGetOwn(optionConfig, "default");
      if (defaultValue !== undefined) {
        let validator;
        switch (optionType) {
          case "string":
            validator = multipleOption ? validateStringArray : validateString;
            break;
          case "boolean":
            validator = multipleOption ? validateBooleanArray : validateBoolean;
            break;
        }
        validator(defaultValue, `options.${longOption}.default`);
      }
    });

    // Phase 1: identify tokens. The tokenizer needs the options map (not the
    // whole parse config) to resolve short options and string-vs-boolean types.
    const tokens = argsToTokens(args, options);

    // Phase 2: process tokens into parsed option values and positionals.
    const result = {
      values: { __proto__: null },
      positionals: [],
    };
    if (returnTokens) {
      result.tokens = tokens;
    }
    tokens.forEach((token) => {
      if (token.kind === "option") {
        if (strict) {
          checkOptionUsage(parseConfig, token);
          checkOptionLikeValue(token);
        }
        storeOption(token.name, token.value, options, result.values);
      } else if (token.kind === "positional") {
        if (!allowPositionals) {
          throw new ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL(token.value);
        }
        result.positionals.push(token.value);
      }
    });

    // Phase 3: fill in default values for missing args.
    Object.entries(options).forEach(([longOption, optionConfig]) => {
      const mustSetDefault = useDefaultValueOption(longOption, optionConfig, result.values);
      if (mustSetDefault) {
        storeDefaultOption(longOption, objectGetOwn(optionConfig, "default"), result.values);
      }
    });

    return result;
  };

  module.exports = { parseArgs };
}
