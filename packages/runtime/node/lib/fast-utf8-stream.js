// A pragmatic `internal/streams/fast-utf8-stream` — Node 24 exposes this as
// `fs.Utf8Stream` (a vendored `sonic-boom`: a fast append-only UTF-8 file
// stream). Our vendored `lib/fs.js` lazy-requires it from a `get Utf8Stream()`
// getter, so ANY code that enumerates `fs` (e.g. yarn's `thenify-all`
// `promisifyAll(fs)`) trips the getter — a missing module then throws and aborts
// the whole program, even though the stream itself is never used.
//
// The real thing is ~600 lines over internal fs bindings; this is a faithful
// SUBSET good enough for real basic use (append writes to an fd/path via the
// public `fs`) and for mere enumeration. Not the high-throughput buffered
// implementation; if a hot path ever needs true sonic-boom behavior, vendor the
// real file and register it in place of this shim.

export default function (exports, require, module) {
  const EventEmitter = require("events");

  class Utf8Stream extends EventEmitter {
    constructor(opts = {}) {
      super();
      const o = opts || {};
      this.fd = o.fd != null ? o.fd : null;
      this.file = o.dest || o.file || null;
      this.sync = !!o.sync;
      this.append = o.append !== false;
      this.mode = o.mode;
      this.writable = true;
      this.destroyed = false;
      this._bufs = [];
      this._fs = null;

      if (this.fd == null && this.file) {
        try {
          this.fd = this._lazyFs().openSync(this.file, this.append ? "a" : "w", this.mode || 0o666);
        } catch (err) {
          queueMicrotask(() => this.emit("error", err));
          return;
        }
      }
      queueMicrotask(() => this.emit("ready"));
    }

    _lazyFs() {
      return (this._fs ??= require("fs"));
    }

    write(data) {
      if (this.destroyed || !this.writable) return false;
      this._bufs.push(typeof data === "string" ? data : String(data));
      if (this.sync) this.flushSync();
      else queueMicrotask(() => this._drain());
      return true;
    }

    _drain() {
      try {
        this.flushSync();
        this.emit("drain");
      } catch (err) {
        this.emit("error", err);
      }
    }

    flushSync() {
      if (this.fd == null || this._bufs.length === 0) return;
      const data = this._bufs.join("");
      this._bufs.length = 0;
      if (data) this._lazyFs().writeSync(this.fd, data);
    }

    flush(cb) {
      try {
        this.flushSync();
        if (typeof cb === "function") queueMicrotask(() => cb(null));
        else this.emit("write");
      } catch (err) {
        if (typeof cb === "function") queueMicrotask(() => cb(err));
        else this.emit("error", err);
      }
    }

    reopen(file) {
      if (file) this.file = file;
      try {
        const fs = this._lazyFs();
        if (this.fd != null && this.file) {
          this.flushSync();
          fs.closeSync(this.fd);
          this.fd = fs.openSync(this.file, "a", this.mode || 0o666);
        }
        queueMicrotask(() => this.emit("ready"));
      } catch (err) {
        queueMicrotask(() => this.emit("error", err));
      }
    }

    end() {
      try {
        this.flushSync();
      } catch (err) {
        this.emit("error", err);
      }
      this.writable = false;
      queueMicrotask(() => {
        this.emit("finish");
        this.emit("close");
      });
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.writable = false;
      try {
        if (this.fd != null && this.file && this._fs) this._fs.closeSync(this.fd);
      } catch {
        /* ignore */
      }
      queueMicrotask(() => this.emit("close"));
    }
  }

  module.exports = Utf8Stream;
  module.exports.Utf8Stream = Utf8Stream;
  module.exports.default = Utf8Stream;
}
