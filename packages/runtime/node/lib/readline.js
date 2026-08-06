// `readline`, on the runtime's shared line editor.
//
// The header this replaced said "Vivari has no interactive TTY (process.stdin is a
// stub), so a faithful line editor would never receive input anyway", and every
// behaviour below it followed from that: createInterface returned an EventEmitter
// that never emitted 'line', `question` printed the prompt and dropped the callback,
// and the async iterator ended immediately. The premise stopped being true when
// stdin became a real flowing TTY (see the "interactive stdin" section of index.js) —
// it is the same stale refusal that kept `bun repl` from existing. The visible cost
// was that every interactive scaffolder — `npm init`, `create-vite`, `bun create` —
// printed its first question and then exited 0 without asking anything.
//
// So the Interface is real now, and it reads through line-editor.js, which is the
// same key table the shell prompt and the REPLs use.
//
// TWO MODES. With a TTY input we drive the editor: echo, in-place editing, history,
// Tab. With a pipe or a file we only split on newlines and echo nothing — a program
// reading `cat answers.txt | node ask.js` must not have the answers drawn back at it.
// The choice is made on input.isTTY rather than on the caller's `terminal`; see the
// note on that in the constructor, which is where the difference bit.
//
// The cursor/clear helpers stay non-throwing no-ops that still invoke their callback.
// Vite calls them on every rebuild to repaint its banner; a throw there would take a
// dev server down, and there is nothing for them to do when the guest's output is a
// message channel rather than a screen.

import { createLineEditor } from "../../line-editor.js";

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
        this._history = Array.isArray(o.history) ? o.history.slice() : [];
        this._historyMax = o.historySize == null ? 30 : o.historySize;
        this._prompt = o.prompt == null ? "> " : o.prompt;
      } else {
        this._history = [];
        this._historyMax = 30;
        this._prompt = "> ";
      }
      this.input = input;
      this.output = output;
      this.completer = completer;
      // Node's rule: `terminal` defaults to whether the INPUT is a tty. Ours has to
      // agree, because isTTY is now the honest answer to "can anybody type at me"
      // (a captured process gets false) rather than a constant.
      this.terminal = terminal === undefined ? !!(input && input.isTTY) : !!terminal;
      // WHO ECHOES. On a real machine the tty driver echoes what you type, so Node
      // can honour `terminal: false` by drawing nothing and still leave you able to
      // see your own answer. Here NOTHING echoes — not xterm, not the kernel — so
      // drawing nothing means typing into the void. npm's `read` computes
      // `terminal = !!(terminal || output.isTTY)` and our process.stdout reports
      // isTTY false, so `npm init` asked nine questions with every answer invisible.
      //
      // So the editor is driven whenever somebody can actually TYPE at us, which is
      // what input.isTTY now means (see the capture note in index.js), independently
      // of the `terminal` the caller asked for. `terminal` keeps reporting what Node
      // would report, because tools read it. Hiding input stays available, but through
      // the `hidden` option on question() rather than as an accident of this flag.
      this._interactive = !!(input && input.isTTY);
      this.line = "";
      this.cursor = 0;
      this.closed = false;
      // Set while question() is waiting: it owns the next line, so the 'line' event
      // is delivered to its callback instead of to listeners. Node does the same.
      this._pendingQuestion = null;
      this._paused = false;
      this._sigintInstalled = false;
      this._lineBuf = ""; // non-terminal mode's partial line

      if (!this.input) return; // a stub interface, e.g. output-only cursor helpers

      if (this._interactive) this._startEditor();
      else this._startPipe();
    }

    // ---- terminal mode ------------------------------------------------------

    _startEditor() {
      const self = this;
      this._editor = createLineEditor({
        input: this.input,
        output: this.output,
        getPrompt: () => self._prompt,
        onLine: (raw) => self._deliver(raw),
        onEOF: () => self._onEOF(),
        // A byte-level \x03, which only reaches us from a pipe. An interactive Ctrl+C
        // is a signal and is handled by the process listener installed below.
        onSigint: () => self._onSigint(),
        completer: this.completer ? (line, pos) => self._complete(line, pos) : null,
        history: this._history,
        historyMax: this._historyMax,
      });
      this._editor.attach();
      this._installSigint();
    }

    // Node's completer contract is (line, cb) or (line) -> [matches, prefix], and the
    // prefix it returns is the SUBSTRING that was completed, not the whole line.
    _complete(line, pos) {
      const upto = line.slice(0, pos);
      let res;
      try {
        res = this.completer.length > 1 ? null : this.completer(upto);
      } catch {
        return null;
      }
      if (!res) return null;
      const matches = res[0] || [];
      const prefix = res[1] == null ? upto : res[1];
      return { matches, prefix };
    }

    // ---- pipe / file mode ---------------------------------------------------

    _startPipe() {
      const self = this;
      this._onPipeData = (chunk) => {
        self._lineBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let nl;
        while ((nl = self._lineBuf.indexOf("\n")) >= 0) {
          let raw = self._lineBuf.slice(0, nl);
          self._lineBuf = self._lineBuf.slice(nl + 1);
          if (raw.endsWith("\r")) raw = raw.slice(0, -1);
          self._deliver(raw);
          if (self.closed) return;
        }
      };
      this._onPipeEnd = () => {
        // A final line with no trailing newline is still a line — `printf 'x'` counts.
        if (self._lineBuf.length) {
          const raw = self._lineBuf;
          self._lineBuf = "";
          self._deliver(raw);
        }
        if (!self.closed) self.close();
      };
      this.input.on("data", this._onPipeData);
      this.input.on("end", this._onPipeEnd);
      if (this.input.resume) this.input.resume();
    }

    // ---- shared ------------------------------------------------------------

    // Returns false when there is no reader left, which tells the editor to hold the
    // rest of the current chunk instead of feeding it on. See the carry note in
    // line-editor.js — a question is a one-line reader by definition, and the next
    // question is asked a turn later.
    _deliver(raw) {
      this.line = "";
      this.cursor = 0;
      const q = this._pendingQuestion;
      if (q) {
        this._pendingQuestion = null;
        // Restore the prompt the interface had before question() borrowed it, so a
        // later rl.prompt() shows what the program set rather than the last question.
        this._prompt = q.saved;
        if (this._editor) this._editor.setEcho(true);
        q.resolve(raw);
        return false;
      }
      this.emit("line", raw);
      return true;
    }

    _onEOF() {
      // Ctrl+D at an empty prompt. A question still waiting gets Node's answer for
      // "input ended": the interface closes and the callback never fires, so a
      // scaffolder sees 'close' and can decide for itself.
      if (this.output && this.output.write && this._interactive) this.output.write("\n");
      this.close();
    }

    _onSigint() {
      // Node: emit 'SIGINT' if anybody is listening, otherwise close. Emitting to
      // nobody would make Ctrl+C do nothing at all, which is the one outcome a user
      // reads as a hang.
      if (this.listenerCount("SIGINT") > 0) {
        this.emit("SIGINT");
        return;
      }
      this.close();
    }

    // Ctrl+C arrives as a SIGNAL, not a byte: the interactive `sh` turns \x03 into a
    // SIGINT for the foreground job and forwards nothing. Installing a listener is
    // also what tells the kernel not to apply the default action (terminate) to this
    // process, so it has to be paired with the stand-down that releases the kernel's
    // force-kill window — see the long note in repl-kit.js. A readline prompt has no
    // eval phase to be stuck in, so unlike the REPL it can stand down immediately:
    // being at a prompt is the whole of its state.
    _installSigint() {
      if (this._sigintInstalled) return;
      this._sigintInstalled = true;
      const self = this;
      this._sigintHandler = () => {
        if (self.closed) return;
        if (self.listenerCount("SIGINT") > 0) {
          if (typeof globalThis.__ocSignalHandled === "function") globalThis.__ocSignalHandled("SIGINT");
          self.emit("SIGINT");
          return;
        }
        // Nobody is handling it: close, and DO NOT stand down. The kernel's window
        // then still applies, so a program that ignores 'close' and keeps running can
        // be collected — which is the only way out a user has.
        self.close();
      };
      process.on("SIGINT", this._sigintHandler);
    }

    // ---- public surface ----------------------------------------------------

    setPrompt(p) {
      this._prompt = String(p);
    }
    getPrompt() {
      return this._prompt;
    }
    prompt(preserveCursor) {
      if (this.closed) return this;
      if (!preserveCursor) {
        this.line = "";
        this.cursor = 0;
        if (this._editor) this._editor.resetLine();
      }
      if (this._editor) this._editor.showPrompt();
      else if (this.output && this.output.write) this.output.write(this._prompt);
      return this;
    }

    // (query, cb) | (query, options, cb) | (query) -> Promise, which is what
    // readline/promises hands out. The promise form is here rather than in a wrapper
    // so both entry points share one implementation.
    question(query, options, cb) {
      if (typeof options === "function") {
        cb = options;
        options = undefined;
      }
      const saved = this._prompt;
      this._prompt = String(query);
      const hidden = !!(options && options.hidden);
      if (this._editor && hidden) this._editor.setEcho(false);

      const start = () => {
        this.prompt();
        // Answers that arrived in the same chunk as the previous Enter — a pasted
        // block of answers — are already buffered. Replay them now that a reader is
        // listening, or the first N-1 questions consume everything and the last hangs.
        if (this._editor) {
          const carry = this._editor.takeCarry();
          if (carry) this._editor.feed(carry);
        }
      };

      if (typeof cb === "function") {
        if (this.closed) return undefined;
        this._pendingQuestion = { saved, resolve: (a) => cb(a) };
        start();
        return undefined;
      }
      if (this.closed) return Promise.reject(new Error("readline was closed"));
      return new Promise((resolve, reject) => {
        this._pendingQuestion = { saved, resolve };
        const onClose = () => reject(new Error("readline was closed"));
        this.once("close", onClose);
        start();
      });
    }

    write(data, key) {
      // Node's write() injects INPUT when a key is given, and writes to the output
      // otherwise. Only the second form has a consumer here (Vite, prompts).
      if (key && this._editor) return undefined;
      if (data != null && this.output && this.output.write) this.output.write(String(data));
      return undefined;
    }

    pause() {
      if (this._paused) return this;
      this._paused = true;
      if (this._editor) this._editor.pause();
      else if (this.input && this.input.pause) this.input.pause();
      this.emit("pause");
      return this;
    }
    resume() {
      if (!this._paused) return this;
      this._paused = false;
      if (this._editor) this._editor.resume();
      else if (this.input && this.input.resume) this.input.resume();
      this.emit("resume");
      return this;
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      if (this._editor) this._editor.detach();
      if (this._onPipeData && this.input) {
        this.input.removeListener("data", this._onPipeData);
        this.input.removeListener("end", this._onPipeEnd);
      }
      if (this._sigintHandler) {
        process.removeListener("SIGINT", this._sigintHandler);
        this._sigintHandler = null;
      }
      // Nothing holds the loop open now, so a program whose only job was to ask is
      // free to exit — which is why close() has to release stdin rather than merely
      // stop listening.
      if (this.input && this.input.pause) this.input.pause();
      this.emit("close");
    }

    getCursorPos() {
      return { rows: 0, cols: this.cursor };
    }

    // `for await (const line of rl)`. Buffers lines that arrive between pulls, and
    // ends on 'close' — the shape the scaffolders and every "read stdin line by line"
    // snippet rely on.
    [Symbol.asyncIterator]() {
      const self = this;
      const queue = [];
      let waiting = null;
      let done = false;
      const onLine = (l) => {
        if (waiting) {
          const w = waiting;
          waiting = null;
          w({ value: l, done: false });
        } else queue.push(l);
      };
      const onClose = () => {
        done = true;
        if (waiting) {
          const w = waiting;
          waiting = null;
          w({ value: undefined, done: true });
        }
      };
      self.on("line", onLine);
      self.once("close", onClose);
      const stop = () => {
        self.removeListener("line", onLine);
        self.removeListener("close", onClose);
      };
      return {
        next() {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => {
            waiting = resolve;
          });
        },
        return() {
          stop();
          return Promise.resolve({ value: undefined, done: true });
        },
        throw(e) {
          stop();
          return Promise.reject(e);
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
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
  // `readline/promises` is the same Interface: question() already returns a promise
  // when it is called without a callback, which is exactly how the promises API
  // differs from the callback one.
  exports.promises = { createInterface, Interface };
}
