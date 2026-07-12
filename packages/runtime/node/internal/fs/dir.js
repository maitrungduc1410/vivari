// A pragmatic `internal/fs/dir` — backs `fs.Dir` / `fs.opendir` / `fs.opendirSync`.
// Node's real version wraps a per-handle directory binding that streams entries in
// batches; our vendored `lib/fs.js` exposes it via `defineLazyProperties(fs,
// 'internal/fs/dir', ['Dir','opendir','opendirSync'])`, so any code that
// ENUMERATES `fs` (yarn's `thenify-all` `promisifyAll(fs)`) trips the getter and,
// with the module missing, aborts — even though the dir API is never used.
//
// This reads the whole listing eagerly through the public `fs.readdirSync(...,
// { withFileTypes: true })` and hands it out one Dirent at a time. Correct for
// normal use (sync/async read, async iteration, close); it does not stream in
// batches or hold a live OS handle. Good enough for the runtime today; swap in a
// binding-backed handle later if a consumer needs true streaming semantics.

export default function (exports, require, module) {
  let _fs;
  const fsMod = () => (_fs ??= require("fs"));

  class Dir {
    constructor(path, options) {
      if (path == null) throw new TypeError("path is required");
      this.path = path;
      this[Symbol.for("kDirOptions")] = options || {};
      this[Symbol.for("kDirEntries")] = null;
      this[Symbol.for("kDirIndex")] = 0;
      this[Symbol.for("kDirClosed")] = false;
      // Read eagerly: real `opendir`/`opendirSync` fail at OPEN time when the
      // directory is missing (ENOENT/ENOTDIR). Deferring the readdir to the first
      // `read()` surfaced that error at the wrong place — corepack probes install
      // dirs with `opendir` and relies on catching ENOENT there to decide it must
      // download, so a late throw crashed it. Doing the listing now matches Node.
      this.#ensure();
    }

    #ensure() {
      const kEntries = Symbol.for("kDirEntries");
      if (this[kEntries] == null) {
        const opts = this[Symbol.for("kDirOptions")];
        this[kEntries] = fsMod().readdirSync(this.path, {
          withFileTypes: true,
          encoding: opts.encoding,
        });
      }
    }

    readSync() {
      if (this[Symbol.for("kDirClosed")]) {
        const err = new Error("Directory handle was closed");
        err.code = "ERR_DIR_CLOSED";
        throw err;
      }
      this.#ensure();
      const entries = this[Symbol.for("kDirEntries")];
      const kIndex = Symbol.for("kDirIndex");
      return this[kIndex] < entries.length ? entries[this[kIndex]++] : null;
    }

    read(callback) {
      if (typeof callback === "function") {
        try {
          const entry = this.readSync();
          queueMicrotask(() => callback(null, entry));
        } catch (err) {
          queueMicrotask(() => callback(err));
        }
        return undefined;
      }
      return new Promise((resolve, reject) => {
        try {
          resolve(this.readSync());
        } catch (err) {
          reject(err);
        }
      });
    }

    closeSync() {
      this[Symbol.for("kDirClosed")] = true;
    }

    close(callback) {
      this[Symbol.for("kDirClosed")] = true;
      if (typeof callback === "function") {
        queueMicrotask(() => callback(null));
        return undefined;
      }
      return Promise.resolve();
    }

    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          const entry = await this.read();
          if (entry === null) break;
          yield entry;
        }
      } finally {
        if (!this[Symbol.for("kDirClosed")]) this.closeSync();
      }
    }
  }

  function opendirSync(path, options) {
    return new Dir(path, options);
  }

  function opendir(path, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    if (typeof callback === "function") {
      try {
        const dir = new Dir(path, options);
        queueMicrotask(() => callback(null, dir));
      } catch (err) {
        queueMicrotask(() => callback(err));
      }
      return undefined;
    }
    return new Promise((resolve, reject) => {
      try {
        resolve(new Dir(path, options));
      } catch (err) {
        reject(err);
      }
    });
  }

  exports.Dir = Dir;
  exports.opendir = opendir;
  exports.opendirSync = opendirSync;
}
