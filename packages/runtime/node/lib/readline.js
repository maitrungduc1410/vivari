// A pragmatic `readline` shim. Node's real lib/readline.js pulls a large
// internal/readline/* tree (interface, keypress decoding, callbacks) built for a
// real TTY; OpenContainer has no interactive TTY (process.stdin is a stub), so a
// faithful line editor would never receive input anyway. This provides the full
// public surface, non-throwing, so libraries that merely reach for readline (CLIs
// like Vite's) load and run — cursor/clear helpers are no-ops that still invoke
// their callback, createInterface yields an EventEmitter that simply never emits a
// 'line' (no stdin), and the async iterator ends immediately.
//
// If real interactive input is needed later, vendor Node's lib/readline.js +
// internal/readline/* over a TTY-backed stdin.

export default function (exports, require, module) {
  const EventEmitter = require("events");

  class Interface extends EventEmitter {
    constructor(input, output, completer, terminal) {
      super();
      if (input && typeof input === "object" && (input.input || input.output || input.terminal !== undefined)) {
        const o = input;
        input = o.input;
        output = o.output;
        completer = o.completer;
        terminal = o.terminal;
      }
      this.input = input;
      this.output = output;
      this.completer = completer;
      this.terminal = !!terminal;
      this.line = "";
      this.cursor = 0;
      this._prompt = "> ";
    }
    setPrompt(p) {
      this._prompt = p;
    }
    getPrompt() {
      return this._prompt;
    }
    prompt() {
      if (this.output && this.output.write) this.output.write(this._prompt);
    }
    // No stdin -> the callback never fires; matches "waiting for input forever".
    question(query, options, cb) {
      if (typeof options === "function") cb = options;
      if (this.output && this.output.write) this.output.write(String(query));
      return undefined;
    }
    write() {}
    pause() {
      this.emit("pause");
      return this;
    }
    resume() {
      this.emit("resume");
      return this;
    }
    close() {
      this.emit("close");
    }
    getCursorPos() {
      return { rows: 0, cols: this.cursor };
    }
    [Symbol.asyncIterator]() {
      return { next: () => Promise.resolve({ value: undefined, done: true }) };
    }
  }

  const createInterface = (input, output, completer, terminal) =>
    new Interface(input, output, completer, terminal);

  const emitKeypressEvents = () => {};
  const done = (cb) => {
    if (typeof cb === "function") cb();
    return true;
  };
  const clearLine = (stream, dir, cb) => done(cb);
  const clearScreenDown = (stream, cb) => done(cb);
  const cursorTo = (stream, x, y, cb) => done(typeof y === "function" ? y : cb);
  const moveCursor = (stream, dx, dy, cb) => done(cb);

  exports.Interface = Interface;
  exports.createInterface = createInterface;
  exports.emitKeypressEvents = emitKeypressEvents;
  exports.clearLine = clearLine;
  exports.clearScreenDown = clearScreenDown;
  exports.cursorTo = cursorTo;
  exports.moveCursor = moveCursor;
  exports.promises = { createInterface, Interface };
}
