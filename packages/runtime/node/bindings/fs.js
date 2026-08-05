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

import { describeCode, errnoFor } from "./uv-errors.js";

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

// access(2) mode bit — must match internalBinding('constants').fs.X_OK.
const X_OK = 1;

const STAT_FIELDS = 18;

// The six characters libuv substitutes with a random suffix. Node's native layer
// appends them to the caller's prefix, so they show up in mkdtemp error messages.
const MKDTEMP_TEMPLATE = "XXXXXX";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const joinPath = (dir, name) => (dir.endsWith("/") ? dir + name : dir + "/" + name);

// The error a failed syscall throws, shaped the way libuv's does — because user
// code reads all of it. `err.code` is the famous one, but `err.syscall` is how
// rimraf and graceful-fs decide whether a failure is theirs to retry, `err.path`
// is what a log needs in order to be actionable, `err.errno` is what a few
// libraries still compare numerically, and the message is what a person sees:
//
//   ENOENT: no such file or directory, open '/app/config.json'
//
// Not `${code}: ${syscall}`, which is what this used to build, and which told
// whoever read it neither what the code meant nor which file it happened to.
// Mirrors uvException() in Node's src/node_errors.cc, including the details that
// look like accidents and are not: `dest` only appears on the two-path calls, and
// an fd-based call names no path at all ("EBADF: bad file descriptor, fstat").
function vvError(code, syscall, path, dest) {
  const description = describeCode(code);
  let message = description ? `${code}: ${description}, ${syscall}` : `${code}: ${syscall}`;
  if (path !== undefined && path !== null) message += ` '${path}'`;
  if (dest !== undefined && dest !== null) message += ` -> '${dest}'`;

  const err = new Error(message);
  // libuv reports errno negated; Node puts that number straight on the error, so a
  // code we do not have a number for is left off rather than guessed at.
  const errno = errnoFor(code);
  if (errno !== undefined) err.errno = errno;
  err.code = code;
  err.syscall = syscall;
  if (path !== undefined && path !== null) err.path = path;
  if (dest !== undefined && dest !== null) err.dest = dest;
  return err;
}

// Is this a bare error from the syscall bridge — one that arrived as
// `new Error('ENOENT')` carrying a code and nothing else? Those are the ones to
// label. An error that already has a syscall has been through here (or through
// statFor), and the ERR_FS_* / ERR_INVALID_ARG_* errors the vendored lib/ throws
// are Node's own and must pass through untouched, so match the POSIX code shape
// rather than merely the presence of `code`.
const isBareSyscallError = (e) =>
  e instanceof Error &&
  e.syscall === undefined &&
  typeof e.code === "string" &&
  /^E[A-Z0-9]+$/.test(e.code);

export function createFsBinding({ sys: rawSys, process }) {
  // Node resolves relative fs paths against the process cwd down in libuv; our
  // Rust VFS only speaks absolute paths, so do it here (per-worker, honouring a
  // live process.chdir). fd-based ops carry no path and pass straight through.
  const R = (p) => {
    if (typeof p !== "string" || p.startsWith("/")) return p;
    const cwd = process.cwd() || "/";
    return (cwd.endsWith("/") ? cwd : cwd + "/") + p;
  };
  const nosys = () => {
    const e = new Error("ENOSYS");
    e.code = "ENOSYS";
    throw e;
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
    // A syscall bridge that predates these (or a test double that never had
    // them) answers ENOSYS, the same code an older wasm VFS answers, so there is
    // one degraded path to reason about rather than a TypeError from here.
    chmod: (p, mode, follow) => (rawSys.chmod ? rawSys.chmod(R(p), mode, follow) : nosys()),
    utimes: (p, a, m, follow) => (rawSys.utimes ? rawSys.utimes(R(p), a, m, follow) : nosys()),
    fchmod: (fd, mode) => (rawSys.fchmod ? rawSys.fchmod(fd, mode) : nosys()),
    futimes: (fd, a, m) => (rawSys.futimes ? rawSys.futimes(fd, a, m) : nosys()),
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

  // Which binding call is running, set by the labelling wrapper at the bottom of
  // this factory. Declared here because `dispatch` needs it: on the async path the
  // error is handed to oncomplete rather than thrown, so the wrapper's catch never
  // sees it and this is the only place left to label it.
  let callContext = null;

  // Run `work` synchronously; if a req is present, deliver via nextTick.
  const dispatch = (req, work) => {
    if (req) {
      let result;
      let err = null;
      try {
        result = work();
      } catch (e) {
        err = labelError(e, callContext);
      }
      process.nextTick(() => {
        Reflect.apply(req.oncomplete, req, [err, result]);
      });
      return undefined;
    }
    return work();
  };

  // Node's fs.js normalizes every time argument (a Date, a number, a numeric
  // string) to SECONDS before it reaches a binding method; the VFS stores ms.
  const secToMs = (sec) => Number(sec) * 1000;

  // Run a metadata write, and treat "this VFS build does not have that method"
  // as the old accept-and-discard rather than a failure. A wasm built before
  // OP_CHMOD existed answers ENOSYS, and turning that into a rejection would
  // break installs outright rather than degrade: npm's bin-links chmods every
  // installed bin unconditionally and propagates the error (fix-bin.js), and
  // node-tar fails an extracted entry when both futimes and utimes fail
  // (unpack.js) — i.e. every tarball any package manager unpacks.
  function acceptIfUnsupported(write, fallback) {
    try {
      write();
    } catch (e) {
      if (!e || e.code !== "ENOSYS") throw e;
      if (fallback) fallback();
    }
  }

  function writeStatsInto(arr, st) {
    const perm = st.mode & 0o7777;
    const type = st.kind === "dir" ? S_IFDIR : st.kind === "symlink" ? S_IFLNK : S_IFREG;
    const ms = st.mtimeMs;
    const sec = Math.floor(ms / 1000);
    const ns = Math.round((ms - sec * 1000) * 1e6);
    // atime is its own field now that utimes(2) can set it — a caller that writes
    // both times and reads them back gets both, instead of mtime answering for
    // all four. ctime and birthtime still follow mtime: the VFS keeps no separate
    // inode-change or creation stamp, and inventing one would be a number that
    // looks specific and means nothing. A wasm build predating `atimeMs` falls
    // back to mtime, which is exactly what every build did before.
    const ams = st.atimeMs === undefined ? ms : st.atimeMs;
    const asec = Math.floor(ams / 1000);
    const ans = Math.round((ams - asec * 1000) * 1e6);
    const blocks = Math.ceil(st.size / 512);
    // dev,mode,nlink,uid,gid,rdev,blksize,ino,size,blocks, a/m/c/birth (s,ns)*4
    // nlink comes from the VFS when available (hard links report >1, which pnpm
    // uses to detect already-linked store files); default 1 for older builds.
    // `dev` is 1, not 0, and that is load-bearing rather than cosmetic. Node's
    // own `fs.cp` decides "src and dest are the same file" with
    // `destStat.ino && destStat.dev && ino === ino && dev === dev` — a 0 makes the
    // whole conjunction falsy, so the check never fired and `fs.cp(a, a)` walked
    // straight into copying a file onto itself instead of raising
    // ERR_FS_CP_EINVAL. One virtual filesystem, so one device id; any non-zero
    // value restores the upstream logic on the async and sync paths at once.
    const v = [1, type | perm, st.nlink || 1, 0, 0, 0, 4096, st.ino, st.size, blocks,
      asec, ans, sec, ns, sec, ns, sec, ns];
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

  // stat/lstat a path on behalf of ANOTHER syscall, re-labelling the error with
  // the caller's name so `fs.chmodSync('/nope')` reports
  // "ENOENT: chmod '/nope'" the way Node does, not "ENOENT: stat '/nope'".
  const statFor = (syscall, path, follow) => {
    try {
      return follow ? sys.stat(path) : sys.lstat(path);
    } catch (e) {
      throw vvError((e && e.code) || "ENOENT", syscall, path);
    }
  };

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
    // Genuinely nothing to flush: the VFS IS the storage (Wasm linear memory),
    // there is no page cache or write-back buffer between us and it, so a write
    // that has returned is already as durable as this filesystem gets. Reporting
    // success is the truth here, not a shim - unlike the metadata ops below.
    // (Deliberately NOT validating `fd`: fsync sits on write-file-atomic's hot
    // path and the write that precedes it already proved the descriptor.)
    fsync(fd, ...rest) {
      return dispatch(findReq(rest), () => {});
    },
    fdatasync(fd, ...rest) {
      return dispatch(findReq(rest), () => {});
    },
    // fd-based metadata writes: accepted and discarded, see the block comment on
    // `chmod` below for why that is the right call and what the follow-up is.
    // These skip the fd-existence check their path-based twins do on purpose -
    // node-tar calls fchmod + futimes + fchown on EVERY file it extracts (i.e.
    // every file of every package npm installs), and each check would be another
    // sync round-trip on that path, while the write that just happened through
    // this same fd already proves it is live.
    fchmod(fd, mode, ...rest) {
      return dispatch(findReq(rest), () => acceptIfUnsupported(() => sys.fchmod(fd, mode & 0o7777)));
    },
    fchown(fd, uid, gid, ...rest) {
      return dispatch(findReq(rest), () => {});
    },
    futimes(fd, atime, mtime, ...rest) {
      return dispatch(findReq(rest), () => acceptIfUnsupported(() => sys.futimes(fd, secToMs(atime), secToMs(mtime))));
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
    // access(2). Follows symlinks, like the real thing.
    //
    // Every process here runs as uid 0, and POSIX lets root bypass the read and
    // write permission checks entirely - so R_OK and W_OK passing for anything
    // that exists is the correct answer, not a shortcut. X_OK is the one root
    // does NOT get for free: it still requires at least one execute bit. We have
    // that bit (the VFS stores mode and `stat` already reports it), and ignoring
    // it meant access(f, X_OK) vouched for files `stat` calls non-executable -
    // two answers to the same question. Now they agree.
    //
    // Consequence worth knowing: because chmod cannot persist a mode change
    // (see the block comment on chmod), `chmod(f, 0o755)` followed by
    // `access(f, X_OK)` now THROWS instead of falsely passing. That is the
    // intended direction - it surfaces the missing OP_CHMOD at the point of use
    // rather than hiding it - and the working way to get an executable file
    // today is to pass the mode at creation: `writeFileSync(p, s, {mode: 0o755})`
    // goes through open(O_CREAT, mode), which the VFS does honour.
    access(path, mode, ...rest) {
      const req = findReq(rest);
      return dispatch(req, () => {
        const st = statFor("access", path, true);
        if ((mode & X_OK) !== 0 && (st.mode & 0o111) === 0) {
          throw vvError("EACCES", "access", path);
        }
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
        if (mode & COPYFILE_EXCL && sys.exists(dest)) throw vvError("EEXIST", "copyfile", dest);
        sys.writeFile(dest, sys.readFile(src));
      });
    },
    // ---- metadata writes ----
    // chmod and utimes reach the inode now (OP_CHMOD/OP_UTIMES → VFS set_mode /
    // set_times). They used to be accepted and discarded, which was defensible
    // only while the VFS had nowhere to put the change, and which quietly cost
    // real behaviour: an unpacked archive lost every executable bit, and since
    // `access` started enforcing X_OK for real, `chmod(f, 0o755)` followed by
    // `access(f, X_OK)` THREW — the call said yes and the check said no.
    //
    // Node hands these binding methods a time in SECONDS (lib/fs.js runs every
    // Date/number/string through toUnixTimestamp first); the VFS stores ms.
    //
    // chown/lchown/fchown stay no-ops, and that is not the same compromise: mode
    // is state this filesystem now keeps, while uid/gid is a model it does not
    // have at all — one user, no kernel, nothing to own a file. Real filesystems
    // in that position accept the call too (Node on Windows, any FAT mount).
    // They still confirm the path exists, because an ENOENT is a fault the caller
    // wants to hear about and the old no-op swallowed it.
    chmod(path, mode, ...rest) {
      return dispatch(findReq(rest), () =>
        acceptIfUnsupported(() => sys.chmod(path, mode & 0o7777, true), () => void statFor("chmod", path, true)),
      );
    },
    chown(path, uid, gid, ...rest) {
      return dispatch(findReq(rest), () => void statFor("chown", path, true));
    },
    lchown(path, uid, gid, ...rest) {
      return dispatch(findReq(rest), () => void statFor("lchown", path, false));
    },
    utimes(path, atime, mtime, ...rest) {
      return dispatch(findReq(rest), () =>
        acceptIfUnsupported(
          () => sys.utimes(path, secToMs(atime), secToMs(mtime), true),
          () => void statFor("utime", path, true),
        ),
      );
    },
    lutimes(path, atime, mtime, ...rest) {
      return dispatch(findReq(rest), () =>
        acceptIfUnsupported(
          () => sys.utimes(path, secToMs(atime), secToMs(mtime), false),
          () => void statFor("lutime", path, false),
        ),
      );
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
        throw vvError("EEXIST", "mkdtemp", prefix + MKDTEMP_TEMPLATE);
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

  // ---- labelling every failure with the call it came from --------------------
  //
  // The syscall bridge can only hand back a code — a Rust VFS error crossing a
  // shared-memory window has nothing else to send — so the syscall name and the
  // path have to be attached here, at the entry point that knows both. Node does
  // the same thing in the same place (its native layer builds the error, not libuv).
  //
  // The name on the left is this binding's method; the name in `syscall` is what
  // libuv calls the operation, and the two differ more often than one would guess:
  // readdir reports `scandir`, copyFile reports `copyfile`, utimes reports `utime`,
  // and every path-less fd call reports the bare verb. `path`/`dest` are argument
  // INDICES, taken before any cwd resolution, because Node reports the path the
  // caller passed rather than the absolute one it resolved to.
  //
  // Entries that cannot fail (existsSync, internalModuleStat — both swallow) and
  // the ones that build their own error (statFor's callers, mkdtemp) are absent.
  const READ_ONLY = (flags) => (flags & 3) === 0;

  // Opening a directory for reading SUCCEEDS on Linux and the failure lands on the
  // following read(2) — which is why `fs.readFileSync('/some/dir')` reports
  // "EISDIR: illegal operation on a directory, read" with no path, while writing to
  // one reports `open` WITH a path. Our VFS refuses the open in both cases, so the
  // read-only variant is relabelled to the call the error would really have come
  // from. The mechanism differs from Linux's; everything the caller can observe
  // does not, which is the part that matters.
  const asReadFailure = (code) =>
    code === "EISDIR" ? { syscall: "read", path: undefined, dest: undefined } : null;

  const SYSCALL_LABELS = {
    readFileUtf8: { syscall: "open", path: 0, refine: asReadFailure },
    // The whole-file write fast path lib/fs.js takes for a utf8 string: one call
    // here, but an open(2) is what fails, and what the caller is told about.
    writeFileUtf8: { syscall: "open", path: 0 },
    open: {
      syscall: "open",
      path: 0,
      refine: (code, args) => (READ_ONLY(args[1]) ? asReadFailure(code) : null),
    },
    close: { syscall: "close" },
    read: { syscall: "read" },
    readBuffers: { syscall: "read" },
    writeBuffer: { syscall: "write" },
    writeString: { syscall: "write" },
    writeBuffers: { syscall: "write" },
    fstat: { syscall: "fstat" },
    ftruncate: { syscall: "ftruncate" },
    fsync: { syscall: "fsync" },
    fdatasync: { syscall: "fdatasync" },
    fchmod: { syscall: "fchmod" },
    fchown: { syscall: "fchown" },
    futimes: { syscall: "futime" },
    stat: { syscall: "stat", path: 0 },
    lstat: { syscall: "lstat", path: 0 },
    statfs: { syscall: "statfs", path: 0 },
    access: { syscall: "access", path: 0 },
    mkdir: { syscall: "mkdir", path: 0 },
    readdir: { syscall: "scandir", path: 0 },
    rename: { syscall: "rename", path: 0, dest: 1 },
    rmdir: { syscall: "rmdir", path: 0 },
    rmSync: { syscall: "rmdir", path: 0 },
    unlink: { syscall: "unlink", path: 0 },
    // symlink is the one call whose arguments are not in (from, to) order for the
    // error: it is symlink(target, path), and Node prints target -> path.
    symlink: { syscall: "symlink", path: 0, dest: 1 },
    link: { syscall: "link", path: 0, dest: 1 },
    readlink: { syscall: "readlink", path: 0 },
    // realpathSync in Node walks the path with lstat, so that is the syscall a
    // caller sees when it fails — not "realpath".
    realpath: { syscall: "lstat", path: 0 },
    // The metadata writes reach the VFS now, so their failures are raw syscall
    // errors that need the same labelling as everyone else's. libuv's names, not
    // Node's method names: utimes(2) reports "utime", lutimes "lutime".
    chmod: { syscall: "chmod", path: 0 },
    chown: { syscall: "chown", path: 0 },
    lchown: { syscall: "lchown", path: 0 },
    utimes: { syscall: "utime", path: 0 },
    lutimes: { syscall: "lutime", path: 0 },
    copyFile: { syscall: "copyfile", path: 0, dest: 1 },
    // mkdtemp is reported against the TEMPLATE, not the prefix: Node's native layer
    // appends the six X's that libuv replaces with the random suffix, so a caller
    // who mistypes a directory sees "mkdtemp '/no/such/dir/x-XXXXXX'". The name we
    // actually create is the substituted one, exactly as libuv would.
    mkdtemp: { syscall: "mkdtemp", path: 0, refine: (code, args) => ({
      syscall: "mkdtemp",
      path: args[0] + MKDTEMP_TEMPLATE,
      dest: undefined,
    }) },
  };

  const labelError = (e, ctx) => {
    if (!ctx || !isBareSyscallError(e)) return e;
    const refined = ctx.refine ? ctx.refine(e.code, ctx.args) : null;
    const { syscall, path, dest } = refined || ctx;
    return vvError(e.code, syscall, path, dest);
  };

  for (const name of Object.keys(SYSCALL_LABELS)) {
    const spec = SYSCALL_LABELS[name];
    const inner = binding[name];
    if (typeof inner !== "function") continue;
    binding[name] = function labelled(...args) {
      // The call in flight, for `dispatch` to read: an async call reports its error
      // through oncomplete instead of throwing, so it never passes the catch below.
      // A single slot is enough because a syscall here is synchronous start to
      // finish — the same property that lets the bridge block on Atomics.wait — and
      // it is saved/restored anyway, since fs calls do nest (rmSync, realpath).
      const previous = callContext;
      callContext = {
        syscall: spec.syscall,
        path: spec.path === undefined ? undefined : args[spec.path],
        dest: spec.dest === undefined ? undefined : args[spec.dest],
        refine: spec.refine,
        args,
      };
      try {
        return Reflect.apply(inner, this, args);
      } catch (e) {
        throw labelError(e, callContext);
      } finally {
        callContext = previous;
      }
    };
  }

  return binding;
}