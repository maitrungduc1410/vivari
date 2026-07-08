// Make `require('console')` work. In Node the module export IS the global
// console instance with a `Console` class attached; user code does
// `const { Console } = require('console')` to build loggers over custom streams.
// Our global console lives in index.js (createConsole); here we expose it plus a
// stream-backed Console class formatted with util.format.

export default function (exports, require, module, process, internalBinding, primordials) {
  const util = require("util");

  const write = (stream, str) => {
    if (stream && typeof stream.write === "function") stream.write(str + "\n");
  };

  class Console {
    constructor(options, maybeStderr) {
      let stdout;
      let stderr;
      if (options && typeof options.write === "function") {
        stdout = options; // new Console(stdoutStream[, stderrStream])
        stderr = maybeStderr || options;
      } else if (options && (options.stdout || options.stderr)) {
        stdout = options.stdout; // new Console({ stdout, stderr })
        stderr = options.stderr || options.stdout;
      } else {
        stdout = options;
        stderr = maybeStderr || options;
      }
      const self = this;
      const toOut = (...a) => write(stdout, util.format(...a));
      const toErr = (...a) => write(stderr, util.format(...a));
      this.log = toOut;
      this.info = toOut;
      this.debug = toOut;
      this.dir = (obj, opts) => write(stdout, util.inspect(obj, opts));
      this.error = toErr;
      this.warn = toErr;
      this.trace = (...a) => toErr("Trace:", ...a);
      this.assert = (cond, ...a) => {
        if (!cond) toErr("Assertion failed" + (a.length ? ":" : ""), ...a);
      };
      this.table = toOut;
      const noop = () => {};
      this.group = noop;
      this.groupCollapsed = noop;
      this.groupEnd = noop;
      this.time = noop;
      this.timeEnd = noop;
      this.timeLog = noop;
      this.count = noop;
      this.countReset = noop;
      this.clear = noop;
      void self;
    }
  }

  const globalConsole = globalThis.console || {};
  globalConsole.Console = Console;
  module.exports = globalConsole;
  module.exports.Console = Console;
}
