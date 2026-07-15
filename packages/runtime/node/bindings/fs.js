// internalBinding('fs') — Node's native fs surface, implemented on our syscalls.
//
// Node's real lib/fs.js (vendored verbatim) is written against this binding: a
// file-descriptor API (open/read/write/close/fstat/ftruncate) plus path ops
// (stat/lstat/mkdir/readdir/rename/unlink/...). We map each onto the sync-bridge
// syscalls (fs-client.js), which the kernel services against the Rust VFS.
//
// Two Node conventions we honour exactly:
//   • stat/lstat/fstat fill a shared `statValues` Float64Array in place (for the
//     non-bigint case) and return it; getStatsFromBinding reads 18 fields per
//     stat (dev,mode,nlink,uid,gid,rdev,blksize,ino,size,blocks, then
//     atime/mtime/ctime/birthtime as second+nanosecond pairs).
//   • async calls pass an FSReqCallback whose `oncomplete(err, result)` we invoke
//     on process.nextTick (our syscalls are synchronous, so the "async" work runs
//     inline and only the callback is deferred). Sync calls omit it and we
//     return the value / throw.
//
// Scope (Phase 2 #4): sync + callback API. Streams/promises/watch are deferred.

// File type bits (Linux) — must match internalBinding('constants').fs.
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

// libuv dirent kinds — must match internalBinding('constants').fs.
const UV_DIRENT_UNKNOWN = 0;
const UV_DIRENT_FILE = 1;
const UV_DIRENT_DIR = 2;
const UV_DIRENT_LINK = 3;

// COPYFILE_EXCL bit.
const COPYFILE_EXCL = 1;

const STAT_FIELDS = 18;

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const joinPath = (dir, name) => (dir.endsWith("/") ? dir + name : dir + "/" + name);

function ocError(code, syscall, path) {
  const err = new Error(`${code}: ${syscall}${path ? ` '${path}'` : ""}`);
  err.code = code;
  err.syscall = syscall;
  if (path) err.path = path;
  return err;
}

export function createFsBinding({ sys: rawSys, process }) {
  // Node resolves relative fs paths against the process cwd down in libuv; our
  // Rust VFS only speaks absolute paths, so do it here (per-worker, honouring a
  // live process.chdir). fd-based ops carry no path and pass straight through.
  const R = (p) => {
    if (typeof p !== "string" || p.startsWith("/")) return p;
    const cwd = process.cwd() || "/";
    return (cwd.endsWith("/") ? cwd : cwd + "/") + p;
  };
  const sys = {
    ...rawSys,
    open: (p, f, m) => rawSys.open(R(p), f, m),
    readFile: (p) => rawSys.readFile(R(p)),
    writeFile: (p, d) => rawSys.writeFile(R(p), d),
    exists: (p) => rawSys.exists(R(p)),
    readdir: (p) => rawSys.readdir(R(p)),
    mkdir: (p, r) => rawSys.mkdir(R(p), r),
    stat: (p) => rawSys.stat(R(p)),
    lstat: (p) => rawSys.lstat(R(p)),
    unlink: (p) => rawSys.unlink(R(p)),
    rmdir: (p) => rawSys.rmdir(R(p)),
    rename: (a, b) => rawSys.rename(R(a), R(b)),
    symlink: (t, p) => rawSys.symlink(t, R(p)),
    readlink: (p) => rawSys.readlink(R(p)),
  };

  // Read a whole file through the chunked fd layer (open + read loop + close),
  // used when a file is too large for the single-shot whole-file window (EFBIG).
  const readWholeViaFd = (path) => {
    const fd = sys.open(path, 0 /* O_RDONLY */, 0);
    try {
      const size = sys.fstat(fd).size >>> 0;
      const out = new Uint8Array(size);
      let total = 0;
      for (;;) {
        const chunk = sys.fdRead(fd, Math.max(1, size - total), -1);
        if (chunk.length === 0) break;
        out.set(chunk, total);
        total += chunk.length;
        if (total >= size) break;
      }
      return total === size ? out : out.subarray(0, total);
    } finally {
      sys.close(fd);
    }
  };

  // The shared, in-place stat scratch buffer (Node's binding.statValues).
  const statValues = new Float64Array(STAT_FIELDS);

  // A real class so `x instanceof FSReqCallback` distinguishes async from sync.
  class FSReqCallback {
    constructor(bigint = false) {
      this.bigint = bigint;
      this.oncomplete = undefined;
      this.context = undefined;
    }
  }

  const findReq = (args) => {
    for (const a of args) if (a instanceof FSReqCallback) return a;
    return null;
  };

  // Run `work` synchronously; if a req is present, deliver via nextTick.
  const dispatch = (req, work) => {
    if (req) {
      let result;
      let err = null;
      try {
        result = work();
      } catch (e) {
        err = e;
      }
      process.nextTick(() => {
        Reflect.apply(req.oncomplete, req, [err, result]);
      });
      return undefined;
    }
    return work();
  };

  function writeStatsInto(arr, st) {
    const perm = st.mode & 0o7777;
    const type = st.kind === "dir" ? S_IFDIR : st.kind === "symlink" ? S_IFLNK : S_IFREG;
    const ms = st.mtimeMs;
    const sec = Math.floor(ms / 1000);
    const ns = Math.round((ms - sec * 1000) * 1e6);
    const blocks = Math.ceil(st.size / 512);
    // dev,mode,nlink,uid,gid,rdev,blksize,ino,size,blocks, a/m/c/birth (s,ns)*4
    // nlink comes from the VFS when available (hard links report >1, which pnpm
    // uses to detect already-linked store files); default 1 for older builds.
    const v = [0, type | perm, st.nlink || 1, 0, 0, 0, 4096, st.ino, st.size, blocks,
      sec, ns, sec, ns, sec, ns, sec, ns];
    const big = arr instanceof BigInt64Array;
    for (let i = 0; i < STAT_FIELDS; i++) arr[i] = big ? BigInt(Math.trunc(v[i])) : v[i];
    return arr;
  }

  // `fresh` forces a private buffer. Async (*stat with a req) MUST use one: its
  // result is read later, in oncomplete's nextTick, by which time a concurrent
  // stat/lstat would have clobbered the shared `statValues` scratch buffer —
  // handing the callback another entry's stats (e.g. a directory seen as a file,
  // which breaks chokidar/Vite's recursive watch). Sync reads the array in the
  // same tick, so it can keep using the shared buffer.
  const makeStatArray = (st, bigint, fresh) =>
    writeStatsInto(
      bigint ? new BigInt64Array(STAT_FIELDS) : fresh ? new Float64Array(STAT_FIELDS) : statValues,
      st,
    );

  const kindToDirent = (kind) =>
    kind === "dir" ? UV_DIRENT_DIR : kind === "symlink" ? UV_DIRENT_LINK : UV_DIRENT_FILE;

  // ---- the binding object ---------------------------------------------------
  const binding = {
    FSReqCallback,
    statValues,

    // -- whole-file fast paths (used by readFileSync/writeFileSync utf8) --
    readFileUtf8(path /* , flags */) {
      try {
        // Fast path: one syscall, whole file through the shared window.
        return textDecoder.decode(sys.readFile(path));
      } catch (e) {
        // File exceeds the 1 MiB shared window (EFBIG): fall back to the chunked
        // fd loop, exactly like the buffer readFileSync path. Any other error
        // (ENOENT/EISDIR/...) re-throws unchanged.
        if (String(e && (e.code || e.message)).includes("EFBIG")) {
          return textDecoder.decode(readWholeViaFd(path));
        }
        throw e;
      }
    },
    writeFileUtf8(path, data, flags, mode) {
      const fd = sys.open(path, flags, mode);
      try {
        const bytes = textEncoder.encode(data);
        let off = 0;
        while (off < bytes.length) off += sys.fdWrite(fd, bytes.subarray(off), -1);
      } finally {
        sys.close(fd);
      }
      return undefined;
    },
    existsSync(path) {
      try {
        return sys.exists(path);
      } catch {
        return false;
      }
    },

    // -- descriptors --
    open(path, flags, mode, ...rest) {
      const req = findReq(rest);
      return dispatch(req, () => sys.open(path, flags, mode));
    },
    close(fd, ...rest) {
      const req = findReq(rest);
      return dispatch(req, () => {
        sys.close(fd);
      });
    },
    read(fd, buffer, offset, length, position, ...rest) {
      const req = findReq(rest);
      return dispatch(req, () => {
        const positional = position != null && position >= 0;
        let total = 0;
        while (total < length) {
          const at = positional ? position + total : -1;
          const chunk = sys.fdRead(fd, length - total, at);
          if (chunk.length === 0) break;
          buffer.set(chunk, offset + total);
          total += chunk.length;
        }
        return total;
      });
    },
    writeBuffer(fd, buffer, offset, length, position, ...rest) {
      const req = findReq(rest);
      return dispatch(req, () => {
        const data = buffer.subarray(offset, offset + length);
        const positional = position != null && position >= 0;
        let total = 0;
        while (total < length) {
          const at = positional ? position + total : -1;
          const n = sys.fdWrite(fd, data.subarray(total), at);
          if (n <= 0) break;
          total += n;
        }
        return total;
      });
    },
    writeString(fd, string, position, encoding, ...rest) {
      const req = findReq(rest);
      return dispatch(req, () => {
        const enc = encoding || "utf8";
        const data =
          enc === "utf8" || enc === "utf-8"
            ? textEncoder.encode(string)
            : globalThis.Buffer.from(string, enc);
        const positional = position != null && position >= 0;
        let total = 0;
        while (total < data.length) {
          const at = positional ? position + total : -1;
          const n = sys.fdWrite(fd, data.subarray(total), at);
          if (n <= 0) break;
          total += n;
        }
        return total;
      });
    },
    writeBuffers(fd, buffers, position, ...rest) {
      const req = findReq(rest);
      return dispatch(req, () => {
        const positional = position != null && position >= 0;
        let total = 0;
        for (const buf of buffers) {
          let off = 0;
          while (off < buf.length) {
            const at = positional ? position + total : -1;
            const n = sys.fdWrite(fd, buf.subarray(off), at);
            if (n <= 0) break;
            off += n;
            total += n;
          }
        }
        return total;
      });
    },
    readBuffers(fd, buffers, position, ...rest) {
      const req = findReq(rest);
      return dispatch(req, () => {
        const positional = position != null && position >= 0;
        let total = 0;
        for (const buf of buffers) {
          const at = positional ? position + total : -1;
          const chunk = sys.fdRead(fd, buf.length, at);
          if (chunk.length === 0) break;
          buf.set(chunk, 0);
          total += chunk.length;
          if (chunk.length < buf.length) break;
        }
        return total;
      });
    },
    fstat(fd, bigint, ...rest) {
      const req = findReq(rest);
      // sync: (fd, bigint, undefined, shouldNotThrow)
      const shouldNotThrow = rest[1] === true;
      if (req) return dispatch(req, () => makeStatArray(sys.fstat(fd), bigint, true));
      try {
        return makeStatArray(sys.fstat(fd), bigint);
      } catch (e) {
        if (shouldNotThrow) return undefined;
        throw e;
      }
    },
    ftruncate(fd, len, ...rest) {
      const req = findReq(rest);
      return dispatch(req, () => {
        sys.ftruncate(fd, len < 0 ? 0 : len);
      });
    },
    fsync(fd, ...rest) {
      return dispatch(findReq(rest), () => {});
    },
    fdatasync(fd, ...rest) {
      return dispatch(findReq(rest), () => {});
    },
    fchmod(fd, mode, ...rest) {
      return dispatch(findReq(rest), () => {});
    },
    fchown(fd, uid, gid, ...rest) {
      return dispatch(findReq(rest), () => {});
    },
    futimes(fd, atime, mtime, ...rest) {
      return dispatch(findReq(rest), () => {});
    },

    // -- path ops --
    stat(path, bigint, ...rest) {
      const req = findReq(rest);
      const throwIfNoEntry = rest[1];
      if (req) return dispatch(req, () => makeStatArray(sys.stat(path), bigint, true));
      try {
        return makeStatArray(sys.stat(path), bigint);
      } catch (e) {
        if (e.code === "ENOENT" && throwIfNoEntry === false) return undefined;
        throw e;
      }
    },
    lstat(path, bigint, ...rest) {
      const req = findReq(rest);
      const throwIfNoEntry = rest[1];
      if (req) return dispatch(req, () => makeStatArray(sys.lstat(path), bigint, true));
      try {
        return makeStatArray(sys.lstat(path), bigint);
      } catch (e) {
        if (e.code === "ENOENT" && throwIfNoEntry === false) return undefined;
        throw e;
      }
    },
    statfs(path, bigint) {
      const v = [0, 4096, 4096, 1 << 20, 1 << 19, 1 << 19, 1 << 16, 1 << 15];
      const arr = bigint ? new BigInt64Array(8) : new Float64Array(8);
      for (let i = 0; i < 8; i++) arr[i] = bigint ? BigInt(v[i]) : v[i];
      return arr;
    },
    access(path, mode, ...rest) {
      const req = findReq(rest);
      return dispatch(req, () => {
        if (!sys.exists(path)) throw ocError("ENOENT", "access", path);
      });
    },
    mkdir(path, mode, recursive, ...rest) {
      const req = findReq(rest);
      return dispatch(req, () => {
        sys.mkdir(path, recursive);
        return recursive ? path : undefined;
      });
    },
    readdir(path, encoding, withFileTypes, ...rest) {
      const req = findReq(rest);
      return dispatch(req, () => {
        const names = sys.readdir(path);
        if (!withFileTypes) return names;
        const types = names.map((n) => {
          try {
            return kindToDirent(sys.lstat(joinPath(path, n)).kind);
          } catch {
            return UV_DIRENT_UNKNOWN;
          }
        });
        return [names, types];
      });
    },
    rename(oldPath, newPath, ...rest) {
      const req = findReq(rest);
      return dispatch(req, () => {
        sys.rename(oldPath, newPath);
      });
    },
    rmdir(path, ...rest) {
      const req = findReq(rest);
      return dispatch(req, () => {
        sys.rmdir(path);
      });
    },
    rmSync(path, maxRetries, recursive /* , retryDelay */) {
      const rm = (p) => {
        let st;
        try {
          st = sys.lstat(p);
        } catch (e) {
          if (e.code === "ENOENT") return;
          throw e;
        }
        if (st.kind === "dir") {
          if (recursive) for (const n of sys.readdir(p)) rm(joinPath(p, n));
          sys.rmdir(p);
        } else {
          sys.unlink(p);
        }
      };
      rm(path);
      return undefined;
    },
    unlink(path, ...rest) {
      const req = findReq(rest);
      return dispatch(req, () => {
        sys.unlink(path);
      });
    },
    symlink(target, path, type, ...rest) {
      const req = findReq(rest);
      return dispatch(req, () => {
        sys.symlink(target, path);
      });
    },
    link(existingPath, newPath, ...rest) {
      const req = findReq(rest);
      return dispatch(req, () => {
        // Prefer a real hard link — the new name shares the existing inode with
        // no byte copy, which is what lets pnpm's store↔node_modules linking stop
        // doubling node_modules in the VFS's Wasm RAM. Fall back to a content copy
        // when the VFS build predates OP_LINK (ENOSYS) or refuses the op (EINVAL,
        // e.g. a directory), so behaviour is unchanged there. `link` isn't in the
        // cwd-rewrapped `sys`, so resolve both paths against cwd here.
        if (typeof sys.link === "function") {
          try {
            sys.link(R(existingPath), R(newPath));
            return;
          } catch (e) {
            const code = e && e.code;
            if (code !== "ENOSYS" && code !== "EINVAL") throw e;
          }
        }
        sys.writeFile(R(newPath), sys.readFile(R(existingPath)));
      });
    },
    readlink(path, encoding, ...rest) {
      const req = findReq(rest);
      return dispatch(req, () => sys.readlink(path));
    },
    realpath(path, encoding, ...rest) {
      const req = findReq(rest);
      // VFS paths are already absolute & normalized; symlink resolution for the
      // default realpath is done by fs.js itself via lstat/readlink.
      return dispatch(req, () => path);
    },
    copyFile(src, dest, mode, ...rest) {
      const req = findReq(rest);
      return dispatch(req, () => {
        if (mode & COPYFILE_EXCL && sys.exists(dest)) throw ocError("EEXIST", "copyfile", dest);
        sys.writeFile(dest, sys.readFile(src));
      });
    },
    chmod(path, mode, ...rest) {
      return dispatch(findReq(rest), () => {});
    },
    chown(path, uid, gid, ...rest) {
      return dispatch(findReq(rest), () => {});
    },
    lchown(path, uid, gid, ...rest) {
      return dispatch(findReq(rest), () => {});
    },
    utimes(path, atime, mtime, ...rest) {
      return dispatch(findReq(rest), () => {});
    },
    lutimes(path, atime, mtime, ...rest) {
      return dispatch(findReq(rest), () => {});
    },
    mkdtemp(prefix, encoding, ...rest) {
      const req = findReq(rest);
      return dispatch(req, () => {
        for (let i = 0; i < 100; i++) {
          const dir = prefix + Math.random().toString(36).slice(2, 8);
          if (!sys.exists(dir)) {
            sys.mkdir(dir, false);
            return dir;
          }
        }
        throw ocError("EEXIST", "mkdtemp", prefix);
      });
    },
    // require()/module loader hot path: 0 = file, 1 = dir, <0 = error.
    internalModuleStat(path) {
      try {
        return sys.stat(path).kind === "dir" ? 1 : 0;
      } catch {
        return -2;
      }
    },
  };

  return binding;
}
