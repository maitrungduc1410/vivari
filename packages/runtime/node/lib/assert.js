// Public `assert` module (and `assert/strict`). Node exposes lib/assert.js as a
// callable (`assert(value)` === `assert.ok`) carrying the comparison helpers plus
// a strict-mode variant on `.strict`. This is a compact but faithful reimpl on
// top of the vendored isDeepStrictEqual — enough for real tooling that pulls
// `node:assert` / `node:assert/strict` (e.g. the Angular CLI package-managers).

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const { isDeepStrictEqual } = require("internal/util/comparisons");
  const inspect = (v) => {
    try {
      return require("util").inspect(v, { depth: 2, breakLength: Infinity });
    } catch {
      return String(v);
    }
  };

  class AssertionError extends Error {
    constructor(options = {}) {
      const { actual, expected, operator, stackStartFn } = options;
      const message =
        options.message != null
          ? String(options.message)
          : `${inspect(actual)} ${operator} ${inspect(expected)}`;
      super(message);
      this.name = "AssertionError";
      this.code = "ERR_ASSERTION";
      this.actual = actual;
      this.expected = expected;
      this.operator = operator;
      this.generatedMessage = options.message == null;
      if (Error.captureStackTrace) Error.captureStackTrace(this, stackStartFn || AssertionError);
    }
  }

  // fail(message) | fail(actual, expected, message, operator) [legacy]
  function fail(actual, expected, message, operator, stackStartFn) {
    const argsLen = arguments.length;
    if (argsLen === 0) {
      throw new AssertionError({ message: "Failed", operator: "fail", stackStartFn: fail });
    }
    if (argsLen === 1) {
      if (actual instanceof Error) throw actual;
      throw new AssertionError({ message: actual == null ? "Failed" : actual, operator: "fail", stackStartFn: fail });
    }
    if (message instanceof Error) throw message;
    throw new AssertionError({
      actual,
      expected,
      message,
      operator: operator || "fail",
      stackStartFn: stackStartFn || fail,
    });
  }

  // Shared throw path — honors `message instanceof Error` (rethrows it verbatim).
  function raise(fn, actual, expected, message, operator) {
    if (message instanceof Error) throw message;
    throw new AssertionError({ actual, expected, message, operator, stackStartFn: fn });
  }

  function ok(value, message) {
    if (!value) raise(ok, value, true, message, "==");
  }

  function equal(actual, expected, message) {
    // eslint-disable-next-line eqeqeq
    if (actual != expected) raise(equal, actual, expected, message, "==");
  }
  function notEqual(actual, expected, message) {
    // eslint-disable-next-line eqeqeq
    if (actual == expected) raise(notEqual, actual, expected, message, "!=");
  }
  function strictEqual(actual, expected, message) {
    if (!Object.is(actual, expected)) raise(strictEqual, actual, expected, message, "strictEqual");
  }
  function notStrictEqual(actual, expected, message) {
    if (Object.is(actual, expected)) raise(notStrictEqual, actual, expected, message, "notStrictEqual");
  }
  function deepEqual(actual, expected, message) {
    if (!isDeepStrictEqual(actual, expected)) raise(deepEqual, actual, expected, message, "deepEqual");
  }
  function notDeepEqual(actual, expected, message) {
    if (isDeepStrictEqual(actual, expected)) raise(notDeepEqual, actual, expected, message, "notDeepEqual");
  }
  function deepStrictEqual(actual, expected, message) {
    if (!isDeepStrictEqual(actual, expected)) raise(deepStrictEqual, actual, expected, message, "deepStrictEqual");
  }
  function notDeepStrictEqual(actual, expected, message) {
    if (isDeepStrictEqual(actual, expected)) raise(notDeepStrictEqual, actual, expected, message, "notDeepStrictEqual");
  }

  function ifError(value) {
    if (value !== null && value !== undefined) {
      let message = "ifError got unwanted exception: ";
      if (value instanceof Error) message += value.message;
      else message += inspect(value);
      throw new AssertionError({ actual: value, expected: null, message, operator: "ifError", stackStartFn: ifError });
    }
  }

  function match(str, regexp, message) {
    if (!(regexp instanceof RegExp)) {
      throw new TypeError('The "regexp" argument must be an instance of RegExp.');
    }
    if (!regexp.test(String(str))) raise(match, str, regexp, message, "match");
  }
  function doesNotMatch(str, regexp, message) {
    if (!(regexp instanceof RegExp)) {
      throw new TypeError('The "regexp" argument must be an instance of RegExp.');
    }
    if (regexp.test(String(str))) raise(doesNotMatch, str, regexp, message, "doesNotMatch");
  }

  // Does `actual` (an error) satisfy the `expected` matcher (class / regexp /
  // validation fn / shape object)? Mirrors Node's expectedException logic.
  function errorMatches(actual, expected) {
    if (expected == null) return true;
    if (expected instanceof RegExp) return expected.test(String(actual));
    if (typeof expected === "function") {
      if (expected.prototype !== undefined && actual instanceof expected) return true;
      if (Error.isPrototypeOf(expected) || expected === Error) return false;
      return expected.call({}, actual) === true;
    }
    if (typeof expected === "object") {
      for (const key of Object.keys(expected)) {
        const a = actual == null ? undefined : actual[key];
        if (!(isDeepStrictEqual(a, expected[key]) || a === expected[key])) return false;
      }
      return true;
    }
    return false;
  }

  function throws(fn, error, message) {
    let threw = false;
    let caught;
    try {
      fn();
    } catch (e) {
      threw = true;
      caught = e;
    }
    if (!threw) {
      const msg = (typeof error === "string" ? error : message) || "Missing expected exception.";
      throw new AssertionError({ message: msg, operator: "throws", stackStartFn: throws });
    }
    if (typeof error === "string") {
      // error is actually the message; nothing else to validate
      return;
    }
    if (error && !errorMatches(caught, error)) throw caught;
  }

  function doesNotThrow(fn, error, message) {
    let caught;
    try {
      fn();
    } catch (e) {
      caught = e;
    }
    if (caught === undefined) return;
    if (error && typeof error !== "string" && !errorMatches(caught, error)) throw caught;
    const detail = typeof error === "string" ? error : message;
    throw new AssertionError({
      message: `Got unwanted exception.${detail ? " " + detail : ""}`,
      operator: "doesNotThrow",
      stackStartFn: doesNotThrow,
    });
  }

  async function rejects(promiseFn, error, message) {
    let threw = false;
    let caught;
    try {
      await (typeof promiseFn === "function" ? promiseFn() : promiseFn);
    } catch (e) {
      threw = true;
      caught = e;
    }
    if (!threw) {
      const msg = (typeof error === "string" ? error : message) || "Missing expected rejection.";
      throw new AssertionError({ message: msg, operator: "rejects", stackStartFn: rejects });
    }
    if (typeof error === "string") return;
    if (error && !errorMatches(caught, error)) throw caught;
  }

  async function doesNotReject(promiseFn, error, message) {
    let caught;
    try {
      await (typeof promiseFn === "function" ? promiseFn() : promiseFn);
    } catch (e) {
      caught = e;
    }
    if (caught === undefined) return;
    if (error && typeof error !== "string" && !errorMatches(caught, error)) throw caught;
    const detail = typeof error === "string" ? error : message;
    throw new AssertionError({
      message: `Got unwanted rejection.${detail ? " " + detail : ""}`,
      operator: "doesNotReject",
      stackStartFn: doesNotReject,
    });
  }

  // The module is callable: assert(value[, message]) === assert.ok(...).
  const assert = function assert(value, message) {
    ok(value, message);
  };
  Object.assign(assert, {
    AssertionError,
    ok,
    equal,
    notEqual,
    strictEqual,
    notStrictEqual,
    deepEqual,
    notDeepEqual,
    deepStrictEqual,
    notDeepStrictEqual,
    ifError,
    match,
    doesNotMatch,
    throws,
    doesNotThrow,
    rejects,
    doesNotReject,
    fail,
  });

  // Strict mode: loose comparisons become strict; everything else is shared.
  const strict = function strict(value, message) {
    ok(value, message);
  };
  Object.assign(strict, assert, {
    equal: strictEqual,
    notEqual: notStrictEqual,
    deepEqual: deepStrictEqual,
    notDeepEqual: notDeepStrictEqual,
  });
  strict.strict = strict;
  assert.strict = strict;

  module.exports = assert;
}
