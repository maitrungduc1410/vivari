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

  // Real vm.runInNewContext makes the sandbox THE global object: bare and
  // `globalThis.`/`self.`/`global.` assignments become own properties of the
  // sandbox, and free identifiers resolve against it (falling back to real
  // globals for Object/JSON/etc.). We approximate that with a `with`-scoped
  // Proxy whose `has` claims every name so the `with` block intercepts all free
  // identifier reads/writes. This matters for e.g. Next.js manifest files that
  // do `globalThis.__RSC_MANIFEST = …` and expect it back on the context object.
  function runWithSandbox(code, sandbox, options) {
    const ctx = sandbox && typeof sandbox === "object" ? sandbox : {};
    const realGlobal = globalThis;
    let proxyRef;
    proxyRef = new Proxy(ctx, {
      has() {
        return true;
      },
      get(target, key) {
        if (key === "globalThis" || key === "global" || key === "self") return proxyRef;
        if (key === Symbol.unscopables) return undefined;
        if (key in target) return target[key];
        return realGlobal[key];
      },
      set(target, key, value) {
        target[key] = value;
        return true;
      },
      deleteProperty(target, key) {
        delete target[key];
        return true;
      },
    });
    const src = String(code);
    const filename = filenameOf(options);
    // Real vm returns the script's *completion value* (the value of a trailing
    // expression statement), which a `new Function` body can't yield for a
    // multi-statement program — wrapping it as `return (…)` is a SyntaxError, and
    // a bare `with(ctx){ … }` returns undefined. A *direct* eval inside the
    // `with` block gives us both: free identifiers still resolve against the
    // sandbox (through the proxy), and eval returns the completion value.
    // html-webpack-plugin depends on this — its child-compilation template bundle
    // ends in a bare `HTML_WEBPACK_PLUGIN_RESULT` expression it reads back.
    const evalArg = JSON.stringify(`${src}\n//# sourceURL=${filename}`);
    // eslint-disable-next-line no-new-func
    const fn = new Function("__oc_ctx__", `with(__oc_ctx__){ return eval(${evalArg}); }`);
    return fn.call(proxyRef, proxyRef);
  }

  // Indirect eval: runs in the GLOBAL scope (sees real globals — the defining
  // property of runInThisContext) AND yields the script's completion value, like
  // real vm. `new Function(body)` can't do the latter: a script whose last
  // statement is an expression (e.g. vitest wraps modules as
  // `'use strict';async (…)=>{…}` and calls the returned function) has no
  // `return`, so a Function body would evaluate to undefined → "is not a
  // function". Indirect eval returns that trailing arrow function verbatim.
  const indirectEval = eval;

  function runInThisContext(code, options) {
    const src = `${String(code)}\n//# sourceURL=${filenameOf(options)}`;
    return indirectEval(src);
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
