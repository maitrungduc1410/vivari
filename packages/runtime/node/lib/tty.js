// Minimal `tty` builtin. There is no real terminal in the browser, so the only
// contract userland libraries (e.g. `debug`, `supports-color`, `chalk`) actually
// need is `tty.isatty()` returning false. The ReadStream/WriteStream classes are
// thin stubs so `instanceof` checks and `new tty.WriteStream(fd)` don't throw.
//
// Factory signature matches the vendored Node loader:
//   function (exports, require, module, process, internalBinding, primordials)

export default function (exports, require, module, process) {
  function isatty(fd) {
    return false;
  }

  class ReadStream {
    constructor(fd) {
      this.fd = fd;
      this.isRaw = false;
      this.isTTY = false;
    }
    setRawMode() {
      return this;
    }
  }

  class WriteStream {
    constructor(fd) {
      this.fd = fd;
      this.isTTY = false;
    }
    // The size the process's own std stream carries (the terminal it was spawned
    // into, kept current by a resize), so `new tty.WriteStream(1).columns` and
    // `process.stdout.columns` cannot disagree.
    get columns() {
      const s = process && (this.fd === 2 ? process.stderr : process.stdout);
      return (s && s.columns) || 80;
    }
    get rows() {
      const s = process && (this.fd === 2 ? process.stderr : process.stdout);
      return (s && s.rows) || 24;
    }
    getColorDepth() {
      return 1; // no color
    }
    hasColors() {
      return false;
    }
    getWindowSize() {
      return [this.columns, this.rows];
    }
    clearLine() {
      return true;
    }
    cursorTo() {
      return true;
    }
    moveCursor() {
      return true;
    }
  }

  module.exports = { isatty, ReadStream, WriteStream };
}
