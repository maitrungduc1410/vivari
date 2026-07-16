// internal/fs/streams — pragmatic fs.ReadStream / fs.WriteStream for Vivari.
//
// Node's real internal/fs/streams drives ReadStream/WriteStream through a pool of
// libuv FSReqCallbacks with a shared read buffer. We implement the same public
// surface on top of our stream module (Readable/Writable) and the callback fs API
// (fs.open/read/write/close) — enough for the things that actually use it:
// static file serving (Vite's dev server / sirv / send use
// `createReadStream(path,{start,end})` and pipe to the response, incl. HTTP range
// requests), log writers, tar/zip streaming, etc.
//
// Supported options: path | fd (number or FileHandle), flags, mode, start, end
// (inclusive), highWaterMark, encoding, autoClose, emitClose, signal, and a
// custom `fs` override. Emits 'open'/'ready'/'close'/'error' like Node.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const { Readable, Writable } = require("stream");
  const realFs = require("fs");
  const { Buffer } = require("buffer");

  const DEFAULT_HWM = 64 * 1024;

  function pathFromURL(p) {
    if (p && typeof p === "object" && typeof p.href === "string" && p.protocol === "file:") {
      return decodeURIComponent(p.pathname);
    }
    return p;
  }

  function normalizeOptions(options, defaults) {
    if (typeof options === "string") options = { encoding: options };
    return { ...defaults, ...(options || {}) };
  }

  function fdFromOption(fd) {
    if (typeof fd === "number") return fd;
    if (fd && typeof fd === "object" && typeof fd.fd === "number") return fd.fd; // FileHandle
    return null;
  }

  // Node keeps fs.ReadStream / fs.WriteStream as ES5 function constructors (NOT
  // `class`) on purpose: graceful-fs (bundled by yarn, fs-extra, …) subclasses
  // them by doing `fs$WriteStream.apply(this, arguments)` on a plain object —
  // which throws "Class constructor cannot be invoked without 'new'" against an
  // ES6 class. So these are functions that (a) auto-`new` when called bare and
  // (b) run their init via `Readable.call(this)` / `Writable.call(this)`, so
  // `.apply()` onto a graceful-fs instance works.

  function ReadStream(path, options) {
    if (!(this instanceof ReadStream)) return new ReadStream(path, options);
    options = normalizeOptions(options, {
      flags: "r",
      mode: 0o666,
      autoClose: true,
      emitClose: true,
    });
    Readable.call(this, {
      highWaterMark: options.highWaterMark || DEFAULT_HWM,
      encoding: options.encoding || null,
      emitClose: options.emitClose !== false,
      signal: options.signal || undefined,
    });

    this.fs = options.fs || realFs;
    this.path = path === undefined ? null : pathFromURL(path);
    this.flags = options.flags;
    this.mode = options.mode;
    this.autoClose = options.autoClose !== false;
    this.start = options.start;
    this.end = options.end === undefined ? Infinity : options.end;
    this.pos = this.start !== undefined ? this.start : undefined;
    this.bytesRead = 0;
    this.fd = fdFromOption(options.fd);

    if (this.start !== undefined && this.end !== Infinity && this.end < this.start) {
      throw new RangeError('"end" is less than "start"');
    }

    if (this.fd !== null) {
      process.nextTick(() => {
        if (this.destroyed) return;
        this.emit("open", this.fd);
        this.emit("ready");
      });
    } else {
      this._openFd();
    }
  }
  Object.setPrototypeOf(ReadStream.prototype, Readable.prototype);
  Object.setPrototypeOf(ReadStream, Readable);
  Object.defineProperty(ReadStream.prototype, "pending", {
    configurable: true,
    get() {
      return this.fd === null;
    },
  });

  ReadStream.prototype._openFd = function _openFd() {
    this.fs.open(this.path, this.flags, this.mode, (err, fd) => {
      if (err) {
        this.destroy(err);
        return;
      }
      if (this.destroyed) {
        this.fs.close(fd, () => {});
        return;
      }
      this.fd = fd;
      this.emit("open", fd);
      this.emit("ready");
    });
  };

  ReadStream.prototype._read = function _read(n) {
    if (typeof this.fd !== "number") {
      this.once("open", () => this._read(n));
      return;
    }
    if (this.destroyed) return;

    let toRead = n || DEFAULT_HWM;
    if (this.end !== Infinity) {
      const remaining = this.end - (this.pos === undefined ? 0 : this.pos) + 1;
      if (remaining <= 0) {
        this.push(null);
        return;
      }
      toRead = Math.min(toRead, remaining);
    }

    const buf = Buffer.allocUnsafe(toRead);
    this.fs.read(this.fd, buf, 0, toRead, this.pos === undefined ? -1 : this.pos, (err, bytesRead) => {
      if (err) {
        this.destroy(err);
        return;
      }
      if (bytesRead > 0) {
        this.bytesRead += bytesRead;
        if (this.pos !== undefined) this.pos += bytesRead;
        this.push(buf.length === bytesRead ? buf : buf.subarray(0, bytesRead));
      } else {
        this.push(null);
      }
    });
  };

  ReadStream.prototype._destroy = function _destroy(err, cb) {
    if (typeof this.fd === "number" && this.autoClose) {
      const fd = this.fd;
      this.fd = null;
      this.fs.close(fd, (e) => cb(err || e));
    } else {
      cb(err);
    }
  };

  ReadStream.prototype.close = function close(cb) {
    if (typeof cb === "function") this.once("close", cb);
    this.destroy();
  };

  function WriteStream(path, options) {
    if (!(this instanceof WriteStream)) return new WriteStream(path, options);
    options = normalizeOptions(options, {
      flags: "w",
      mode: 0o666,
      autoClose: true,
      emitClose: true,
    });
    Writable.call(this, {
      highWaterMark: options.highWaterMark || DEFAULT_HWM,
      emitClose: options.emitClose !== false,
      signal: options.signal || undefined,
    });

    this.fs = options.fs || realFs;
    this.path = path === undefined ? null : pathFromURL(path);
    this.flags = options.flags;
    this.mode = options.mode;
    this.autoClose = options.autoClose !== false;
    this.start = options.start;
    this.pos = this.start !== undefined ? this.start : undefined;
    this.bytesWritten = 0;
    this.fd = fdFromOption(options.fd);
    if (options.encoding) this.setDefaultEncoding(options.encoding);

    if (this.fd !== null) {
      process.nextTick(() => {
        if (this.destroyed) return;
        this.emit("open", this.fd);
        this.emit("ready");
      });
    } else {
      this._openFd();
    }
  }
  Object.setPrototypeOf(WriteStream.prototype, Writable.prototype);
  Object.setPrototypeOf(WriteStream, Writable);
  Object.defineProperty(WriteStream.prototype, "pending", {
    configurable: true,
    get() {
      return this.fd === null;
    },
  });

  WriteStream.prototype._openFd = function _openFd() {
    this.fs.open(this.path, this.flags, this.mode, (err, fd) => {
      if (err) {
        this.destroy(err);
        return;
      }
      if (this.destroyed) {
        this.fs.close(fd, () => {});
        return;
      }
      this.fd = fd;
      this.emit("open", fd);
      this.emit("ready");
    });
  };

  WriteStream.prototype._write = function _write(data, encoding, cb) {
    if (typeof this.fd !== "number") {
      this.once("open", () => this._write(data, encoding, cb));
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, encoding);
    this.fs.write(this.fd, buf, 0, buf.length, this.pos === undefined ? -1 : this.pos, (err, bytes) => {
      if (err) {
        cb(err);
        return;
      }
      this.bytesWritten += bytes;
      if (this.pos !== undefined) this.pos += bytes;
      cb();
    });
  };

  WriteStream.prototype._writev = function _writev(chunks, cb) {
    const buf = Buffer.concat(
      chunks.map(({ chunk, encoding }) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding))),
    );
    this._write(buf, undefined, cb);
  };

  WriteStream.prototype._destroy = function _destroy(err, cb) {
    if (typeof this.fd === "number" && this.autoClose) {
      const fd = this.fd;
      this.fd = null;
      this.fs.close(fd, (e) => cb(err || e));
    } else {
      cb(err);
    }
  };

  WriteStream.prototype.close = function close(cb) {
    if (typeof cb === "function") this.once("close", cb);
    this.end();
  };

  module.exports = { ReadStream, WriteStream };
}
