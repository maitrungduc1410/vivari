// A small `assert` module. Enough for programs (and our own tests) that lean on
// basic assertions.

export function createAssert(util) {
  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null)
      return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }

  const fail = (message) => {
    const err = new Error(message);
    err.code = "ERR_ASSERTION";
    throw err;
  };

  function assert(value, message) {
    if (!value) fail(message || "assertion failed");
  }
  assert.ok = assert;
  assert.equal = (a, b, m) => {
    if (a != b) fail(m || `${util.inspect(a)} == ${util.inspect(b)}`);
  };
  assert.notEqual = (a, b, m) => {
    if (a == b) fail(m || `${util.inspect(a)} != ${util.inspect(b)}`);
  };
  assert.strictEqual = (a, b, m) => {
    if (a !== b) fail(m || `${util.inspect(a)} === ${util.inspect(b)}`);
  };
  assert.notStrictEqual = (a, b, m) => {
    if (a === b) fail(m || `${util.inspect(a)} !== ${util.inspect(b)}`);
  };
  assert.deepStrictEqual = (a, b, m) => {
    if (!deepEqual(a, b)) fail(m || `deepStrictEqual: ${util.inspect(a)} vs ${util.inspect(b)}`);
  };
  assert.deepEqual = assert.deepStrictEqual;
  assert.throws = (fn, m) => {
    try {
      fn();
    } catch {
      return;
    }
    fail(m || "Missing expected exception");
  };
  assert.fail = (m) => fail(m || "Failed");
  return assert;
}
