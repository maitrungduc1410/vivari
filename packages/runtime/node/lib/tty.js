// Minimal `tty` builtin. There is no real terminal in the browser, so the only
// contract userland libraries (e.g. `debug`, `supports-color`, `chalk`) actually
// need is `tty.isatty()` returning false. The ReadStream/WriteStream classes are
// thin stubs so `instanceof` checks and `new tty.WriteStream(fd)` don't throw.
//
// Factory signature matches the vendored Node loader:
//   function (exports, require, module, process, internalBinding, primordials)

export default function (exports, require, module) {
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
      this.columns = 80;
      this.rows = 24;
      this.isTTY = false;
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
