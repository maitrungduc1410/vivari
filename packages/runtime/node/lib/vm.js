// A pragmatic `vm` module. Real Node's lib/vm.js runs code in isolated V8
// contexts via internalBinding('contextify') — separate global objects with
// their own realm. There is no V8 context API reachable from a Worker/Wasm
// sandbox, so we approximate:
//
//   - runInThisContext(code): compile + run in the current (worker) global via
//     `new Function`, whose scope IS the global scope — a faithful match, since
//     runInThisContext shares the caller's global object anyway.
//   - runInNewContext / runInContext / Script: the "sandbox" becomes a set of
//     named parameters, so `code` sees the sandbox's own keys as variables and
//     object mutations flow back. This is NOT a real security boundary and does
//     not create a fresh global — enough for config/template evaluators (e.g.
//     npm's promzard, which only uses runInThisContext).
//
// Like the `tty`/`url` shims, this is intentional (browser reality), not a stub.

export default function (exports, require, module) {
  const { Buffer } = require("buffer");

  const contexts = new WeakSet();

  const filenameOf = (options) =>
    typeof options === "string" ? options : (options && options.filename) || "evalmachine.<anonymous>";

  // Compile `code` with the given parameter names. Try expression form first so
  // the completion value is returned (matches vm semantics for a single
  // expression, e.g. `runInNewContext('1 + 1')`); fall back to a statement list.
  function compile(paramNames, code, options) {
    const src = String(code);
    const filename = filenameOf(options);
    try {
      // eslint-disable-next-line no-new-func
      return new Function(...paramNames, `return (\n${src}\n);\n//# sourceURL=${filename}`);
    } catch {
      // eslint-disable-next-line no-new-func
      return new Function(...paramNames, `${src}\n//# sourceURL=${filename}`);
    }
  }

  function runWithSandbox(code, sandbox, options) {
    const ctx = sandbox && typeof sandbox === "object" ? sandbox : {};
    const keys = Object.keys(ctx);
    const fn = compile(keys, code, options);
    return fn.apply(ctx, keys.map((k) => ctx[k]));
  }

  function runInThisContext(code, options) {
    // No sandbox params: the function's lexical scope is the global scope, so the
    // script sees real globals — the defining property of runInThisContext.
    return compile([], code, options).call(globalThis);
  }

  function runInNewContext(code, sandbox, options) {
    return runWithSandbox(code, sandbox, options);
  }

  function runInContext(code, contextifiedObject, options) {
    return runWithSandbox(code, contextifiedObject, options);
  }

  function createContext(sandbox = {}) {
    const ctx = sandbox && typeof sandbox === "object" ? sandbox : {};
    contexts.add(ctx);
    return ctx;
  }

  function isContext(sandbox) {
    return contexts.has(sandbox);
  }

  function compileFunction(code, params = [], options = {}) {
    const args = Array.isArray(params) ? params.map(String) : [];
    // eslint-disable-next-line no-new-func
    return new Function(...args, `${String(code)}\n//# sourceURL=${filenameOf(options)}`);
  }

  class Script {
    constructor(code, options = {}) {
      this.code = String(code);
      this.options = options || {};
    }
    runInThisContext(options) {
      return runInThisContext(this.code, { ...this.options, ...(options || {}) });
    }
    runInNewContext(sandbox, options) {
      return runInNewContext(this.code, sandbox, { ...this.options, ...(options || {}) });
    }
    runInContext(contextifiedObject, options) {
      return runInContext(this.code, contextifiedObject, { ...this.options, ...(options || {}) });
    }
    createCachedData() {
      return Buffer.alloc(0);
    }
  }

  exports.runInThisContext = runInThisContext;
  exports.runInNewContext = runInNewContext;
  exports.runInContext = runInContext;
  exports.createContext = createContext;
  exports.isContext = isContext;
  exports.compileFunction = compileFunction;
  exports.Script = Script;
  exports.measureMemory = () =>
    Promise.resolve({ total: { jsMemoryEstimate: 0, jsMemoryRange: [0, 0] } });
  exports.constants = { DONT_CONTEXTIFY: {}, USE_MAIN_CONTEXT_DEFAULT_LOADER: 0 };
}
