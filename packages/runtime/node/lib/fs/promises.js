// A pragmatic `fs/promises` (and `fs.promises`) implementation.
//
// Node's real internal/fs/promises.js is a large module built on libuv's async
// FS ops. OpenContainer's filesystem syscalls are synchronous under the hood (a
// blocking SAB round-trip to the File System Worker), so the honest and simplest
// implementation is a thin promise wrapper over the vendored sync fs API: each
// call runs the corresponding *Sync function and resolves/rejects a Promise. This
// is behaviourally faithful (same errors, same results) and is what most
// libraries — including Vite — actually consume.
//
// FileHandle wraps an fd with the promise-based descriptor methods.

export default function (exports, require, module) {
  const fs = require("fs");
  const { Buffer } = require("buffer");

  // Look the sync fn up by NAME at call time. Many fs.*Sync are lazy getters
  // (internal/util) that pull extra modules on first access; resolving them only
  // when the method is actually called keeps building this api side-effect-free
  // (and avoids dragging in yet-unvendored internals unless truly used).
  const wrap =
    (name, fallback) =>
    (...args) =>
      new Promise((resolve, reject) => {
        try {
          const fn = fs[name] || (fallback ? fs[fallback] : undefined);
          if (typeof fn !== "function") throw new Error("fs." + name + " is not available");
          resolve(fn(...args));
        } catch (e) {
          reject(e);
        }
      });

  class FileHandle {
    constructor(fd, path) {
      this.fd = fd;
      this._path = path;
    }
    getAsyncId() {
      return this.fd;
    }
    async read(bufferOrOpts, offset, length, position) {
      let buffer = bufferOrOpts;
      if (bufferOrOpts && !ArrayBuffer.isView(bufferOrOpts)) {
        const o = bufferOrOpts || {};
        buffer = o.buffer || Buffer.alloc(o.length || 16384);
        offset = o.offset ?? 0;
        length = o.length ?? buffer.length - offset;
        position = o.position ?? null;
      } else {
        if (offset == null) offset = 0;
        if (length == null) length = buffer.length - offset;
        if (position === undefined) position = null;
      }
      const bytesRead = fs.readSync(this.fd, buffer, offset, length, position);
      return { bytesRead, buffer };
    }
    async write(bufferOrString, offset, length, position) {
      if (typeof bufferOrString === "string") {
        const bytesWritten = fs.writeSync(this.fd, bufferOrString, offset, length /* encoding */);
        return { bytesWritten, buffer: bufferOrString };
      }
      let buffer = bufferOrString;
      if (buffer && !ArrayBuffer.isView(buffer)) {
        const o = buffer || {};
        buffer = o.buffer;
        offset = o.offset ?? 0;
        length = o.length ?? buffer.length - offset;
        position = o.position ?? null;
      } else {
        if (offset == null) offset = 0;
        if (length == null) length = buffer.length - offset;
        if (position === undefined) position = null;
      }
      const bytesWritten = fs.writeSync(this.fd, buffer, offset, length, position);
      return { bytesWritten, buffer };
    }
    async writeFile(data, options) {
      return fs.writeFileSync(this.fd, data, options);
    }
    async appendFile(data, options) {
      return fs.appendFileSync(this.fd, data, options);
    }
    async readFile(options) {
      return fs.readFileSync(this.fd, options);
    }
    async stat(options) {
      return fs.fstatSync(this.fd, options);
    }
    async sync() {
      return fs.fsyncSync(this.fd);
    }
    async datasync() {
      return fs.fdatasyncSync(this.fd);
    }
    async truncate(len) {
      return fs.ftruncateSync(this.fd, len);
    }
    async chmod(mode) {
      return fs.fchmodSync(this.fd, mode);
    }
    async chown(uid, gid) {
      return fs.fchownSync(this.fd, uid, gid);
    }
    async utimes(atime, mtime) {
      return fs.futimesSync ? fs.futimesSync(this.fd, atime, mtime) : undefined;
    }
    async close() {
      return fs.closeSync(this.fd);
    }
    createReadStream(options) {
      return fs.createReadStream(this._path, { ...options, fd: this.fd });
    }
    createWriteStream(options) {
      return fs.createWriteStream(this._path, { ...options, fd: this.fd });
    }
    [Symbol.asyncDispose]() {
      return this.close();
    }
  }

  const open = (path, flags, mode) =>
    new Promise((resolve, reject) => {
      try {
        resolve(new FileHandle(fs.openSync(path, flags ?? "r", mode), path));
      } catch (e) {
        reject(e);
      }
    });

  // Map every fooSync onto an async foo, plus a few whose names differ.
  const api = {
    FileHandle,
    open,
    get constants() {
      return fs.constants;
    },
    access: wrap("accessSync"),
    appendFile: wrap("appendFileSync"),
    chmod: wrap("chmodSync"),
    chown: wrap("chownSync"),
    copyFile: wrap("copyFileSync"),
    cp: wrap("cpSync"),
    lchmod: wrap("lchmodSync", "chmodSync"),
    lchown: wrap("lchownSync", "chownSync"),
    lutimes: wrap("lutimesSync", "utimesSync"),
    link: wrap("linkSync"),
    lstat: wrap("lstatSync"),
    mkdir: wrap("mkdirSync"),
    mkdtemp: wrap("mkdtempSync"),
    readFile: wrap("readFileSync"),
    readdir: wrap("readdirSync"),
    readlink: wrap("readlinkSync"),
    realpath: wrap("realpathSync"),
    rename: wrap("renameSync"),
    rmdir: wrap("rmdirSync"),
    rm: wrap("rmSync"),
    stat: wrap("statSync"),
    statfs: wrap("statfsSync"),
    symlink: wrap("symlinkSync"),
    truncate: wrap("truncateSync"),
    unlink: wrap("unlinkSync"),
    utimes: wrap("utimesSync"),
    writeFile: wrap("writeFileSync"),
    glob: wrap("globSync"),
    watch: (...a) => fs.watch(...a),
    opendir: wrap("opendirSync"),
  };

  module.exports = api;
}
