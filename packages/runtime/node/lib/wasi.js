// node:wasi — a WASI preview1 runtime (Phase 2 #16 stage 1).
//
// This is the JS half of "run a wasm32-wasi module": it implements the
// `wasi_snapshot_preview1` import surface a command needs and bridges it to
// OpenContainer's world — file descriptors and paths go through our real `fs`
// (and thus the VFS in the File System Worker), argv/environ come from the
// constructor, the clock from Date/performance, randomness from WebCrypto, and
// stdout/stderr through `process`. A guest built for `wasm32-wasip1` (Rust std,
// clang/wasi-sdk, TinyGo, …) runs unmodified.
//
// API mirrors Node's own `require('wasi').WASI`:
//   const wasi = new WASI({ version:'preview1', args, env, preopens, returnOnExit });
//   const { instance } = await WebAssembly.instantiate(bytes, wasi.getImportObject());
//   const code = wasi.start(instance);           // runs _start, returns exit code
//
// This is a faithful subset, not the full spec: the CLI-critical calls are real,
// rarely-used ones (sockets, most path_* variants) are stubbed to sensible errnos.
// napi-on-wasm addons (rolldown et al.) are the separate stage 2.

export default function (exports, require, module, process) {
  const fs = require("fs");
  const O = fs.constants;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // ---- WASI preview1 constants -------------------------------------------
  const ESUCCESS = 0;
  const EBADF = 8;
  const EEXIST = 20;
  const EINVAL = 28;
  const EIO = 29;
  const EISDIR = 31;
  const ENOENT = 44;
  const ENOSYS = 52;
  const ENOTDIR = 54;
  const ENOTEMPTY = 55;
  const EPERM = 63;
  const ENOTCAPABLE = 76;

  const FILETYPE_UNKNOWN = 0;
  const FILETYPE_DIRECTORY = 3;
  const FILETYPE_REGULAR_FILE = 4;
  const FILETYPE_SYMBOLIC_LINK = 7;

  const CLOCK_REALTIME = 0;

  // oflags (path_open)
  const OFLAGS_CREAT = 1;
  const OFLAGS_DIRECTORY = 2;
  const OFLAGS_EXCL = 4;
  const OFLAGS_TRUNC = 8;
  // fdflags
  const FDFLAGS_APPEND = 1;
  // rights (only the two we branch on)
  const RIGHT_FD_READ = 1n << 1n;
  const RIGHT_FD_WRITE = 1n << 6n;
  // whence
  const WHENCE_SET = 0;
  const WHENCE_CUR = 1;
  const WHENCE_END = 2;

  // Generous rights advertised back for opened handles (real tools only check a
  // few; being permissive avoids spurious ENOTCAPABLE).
  const RIGHTS_ALL = 0xffffffffffffffffn;

  // Map a Node fs error code to a WASI errno.
  function errnoFor(err) {
    switch (err && err.code) {
      case "ENOENT":
        return ENOENT;
      case "EEXIST":
        return EEXIST;
      case "EISDIR":
        return EISDIR;
      case "ENOTDIR":
        return ENOTDIR;
      case "ENOTEMPTY":
        return ENOTEMPTY;
      case "EACCES":
      case "EPERM":
        return EPERM;
      case "EBADF":
        return EBADF;
      case "EINVAL":
        return EINVAL;
      default:
        return EIO;
    }
  }

  function normalize(p) {
    const abs = p.startsWith("/");
    const st = [];
    for (const c of p.split("/")) {
      if (!c || c === ".") continue;
      if (c === "..") st.pop();
      else st.push(c);
    }
    return (abs ? "/" : "") + st.join("/") || (abs ? "/" : ".");
  }

  class ExitError extends Error {
    constructor(code) {
      super("WASI exit " + code);
      this.code = code;
    }
  }

  class WASI {
    constructor(options = {}) {
      const version = options.version || "preview1";
      if (version !== "preview1" && version !== "snapshot1") {
        throw new TypeError(`Unsupported WASI version "${version}"`);
      }
      this.returnOnExit = options.returnOnExit !== false;
      this._args = options.args || [];
      const envObj = options.env || {};
      this._env = Object.keys(envObj).map((k) => `${k}=${envObj[k]}`);
      this._memory = null;
      this._exitCode = 0;

      // File-descriptor table. 0/1/2 are stdio; 3+ are preopens then opened files.
      this._fds = new Map();
      this._fds.set(0, { type: "stdin" });
      this._fds.set(1, { type: "stdout" });
      this._fds.set(2, { type: "stderr" });
      this._nextFd = 3;
      const preopens = options.preopens || {};
      for (const guest of Object.keys(preopens)) {
        this._fds.set(this._nextFd++, {
          type: "dir",
          guestPath: guest,
          hostPath: preopens[guest],
          preopen: true,
        });
      }

      this.wasiImport = this._buildImports();
    }

    getImportObject() {
      return { wasi_snapshot_preview1: this.wasiImport };
    }

    // Run a command (_start). Returns the exit code when returnOnExit is set.
    start(instance) {
      const exp = instance.exports;
      if (!exp || typeof exp._start !== "function" || !(exp.memory instanceof WebAssembly.Memory)) {
        throw new TypeError("WASI.start: instance must export a memory and _start");
      }
      this._memory = exp.memory;
      try {
        exp._start();
      } catch (err) {
        if (err instanceof ExitError) {
          if (this.returnOnExit) return err.code;
          if (err.code !== 0) throw err;
          return undefined;
        }
        throw err;
      }
      if (this.returnOnExit) return 0;
    }

    // Run a reactor (_initialize), for libraries with no _start.
    initialize(instance) {
      const exp = instance.exports;
      if (!(exp.memory instanceof WebAssembly.Memory)) {
        throw new TypeError("WASI.initialize: instance must export a memory");
      }
      this._memory = exp.memory;
      if (typeof exp._initialize === "function") exp._initialize();
    }

    // ---- memory helpers ---------------------------------------------------
    _view() {
      return new DataView(this._memory.buffer);
    }
    _bytes() {
      return new Uint8Array(this._memory.buffer);
    }

    _buildImports() {
      const self = this;
      const view = () => self._view();
      const bytes = () => self._bytes();

      // Resolve a *file* fd to its record or throw EBADF-as-value.
      const getFd = (fd) => self._fds.get(fd);

      function args_sizes_get(argcPtr, argvBufSizePtr) {
        const dv = view();
        dv.setUint32(argcPtr, self._args.length, true);
        let size = 0;
        for (const a of self._args) size += encoder.encode(a).length + 1;
        dv.setUint32(argvBufSizePtr, size, true);
        return ESUCCESS;
      }
      function args_get(argvPtr, argvBufPtr) {
        const dv = view();
        const mem = bytes();
        let bufPtr = argvBufPtr;
        for (const a of self._args) {
          dv.setUint32(argvPtr, bufPtr, true);
          argvPtr += 4;
          const enc = encoder.encode(a);
          mem.set(enc, bufPtr);
          mem[bufPtr + enc.length] = 0;
          bufPtr += enc.length + 1;
        }
        return ESUCCESS;
      }
      function environ_sizes_get(countPtr, bufSizePtr) {
        const dv = view();
        dv.setUint32(countPtr, self._env.length, true);
        let size = 0;
        for (const e of self._env) size += encoder.encode(e).length + 1;
        dv.setUint32(bufSizePtr, size, true);
        return ESUCCESS;
      }
      function environ_get(environPtr, environBufPtr) {
        const dv = view();
        const mem = bytes();
        let bufPtr = environBufPtr;
        for (const e of self._env) {
          dv.setUint32(environPtr, bufPtr, true);
          environPtr += 4;
          const enc = encoder.encode(e);
          mem.set(enc, bufPtr);
          mem[bufPtr + enc.length] = 0;
          bufPtr += enc.length + 1;
        }
        return ESUCCESS;
      }

      function clock_time_get(id, _precision, resultPtr) {
        let ns;
        if (id === CLOCK_REALTIME) ns = BigInt(Date.now()) * 1000000n;
        else ns = BigInt(Math.round((globalThis.performance ? performance.now() : Date.now()) * 1e6));
        view().setBigUint64(resultPtr, ns, true);
        return ESUCCESS;
      }
      function clock_res_get(_id, resultPtr) {
        view().setBigUint64(resultPtr, 1000n, true); // 1 microsecond
        return ESUCCESS;
      }
      function random_get(ptr, len) {
        const buf = new Uint8Array(self._memory.buffer, ptr, len);
        if (globalThis.crypto && globalThis.crypto.getRandomValues) {
          // getRandomValues caps at 65536 bytes per call.
          for (let off = 0; off < len; off += 65536) {
            globalThis.crypto.getRandomValues(buf.subarray(off, Math.min(off + 65536, len)));
          }
        } else {
          for (let i = 0; i < len; i++) buf[i] = (Math.random() * 256) | 0;
        }
        return ESUCCESS;
      }

      function proc_exit(code) {
        throw new ExitError(code | 0);
      }
      function sched_yield() {
        return ESUCCESS;
      }
      function proc_raise() {
        return ENOSYS;
      }
      function poll_oneoff() {
        return ENOSYS;
      }

      // ---- descriptors ----------------------------------------------------
      function fd_close(fd) {
        const rec = getFd(fd);
        if (!rec) return EBADF;
        if (rec.type === "file") {
          try {
            fs.closeSync(rec.hostFd);
          } catch {
            /* ignore */
          }
        }
        self._fds.delete(fd);
        return ESUCCESS;
      }

      function writeStdio(rec, iovs, iovsLen, nwrittenPtr) {
        const dv = view();
        const mem = bytes();
        let written = 0;
        const chunks = [];
        for (let i = 0; i < iovsLen; i++) {
          const p = dv.getUint32(iovs + i * 8, true);
          const l = dv.getUint32(iovs + i * 8 + 4, true);
          chunks.push(mem.slice(p, p + l));
          written += l;
        }
        const total = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        if (rec.type === "stderr") process.stderr.write(total);
        else process.stdout.write(total);
        dv.setUint32(nwrittenPtr, written, true);
        return ESUCCESS;
      }

      function fd_write(fd, iovs, iovsLen, nwrittenPtr) {
        const rec = getFd(fd);
        if (!rec) return EBADF;
        if (rec.type === "stdout" || rec.type === "stderr") {
          return writeStdio(rec, iovs, iovsLen, nwrittenPtr);
        }
        if (rec.type !== "file") return EBADF;
        const dv = view();
        const mem = bytes();
        let written = 0;
        try {
          for (let i = 0; i < iovsLen; i++) {
            const p = dv.getUint32(iovs + i * 8, true);
            const l = dv.getUint32(iovs + i * 8 + 4, true);
            if (l === 0) continue;
            const buf = Buffer.from(mem.slice(p, p + l));
            const pos = rec.append ? null : rec.offset;
            const n = fs.writeSync(rec.hostFd, buf, 0, l, pos);
            if (!rec.append) rec.offset += n;
            written += n;
          }
        } catch (err) {
          return errnoFor(err);
        }
        dv.setUint32(nwrittenPtr, written, true);
        return ESUCCESS;
      }

      function fd_read(fd, iovs, iovsLen, nreadPtr) {
        const rec = getFd(fd);
        if (!rec) return EBADF;
        const dv = view();
        const mem = bytes();
        if (rec.type === "stdin") {
          dv.setUint32(nreadPtr, 0, true); // no stdin in stage 1 → EOF
          return ESUCCESS;
        }
        if (rec.type !== "file") return EBADF;
        let read = 0;
        try {
          for (let i = 0; i < iovsLen; i++) {
            const p = dv.getUint32(iovs + i * 8, true);
            const l = dv.getUint32(iovs + i * 8 + 4, true);
            if (l === 0) continue;
            const tmp = Buffer.allocUnsafe(l);
            const n = fs.readSync(rec.hostFd, tmp, 0, l, rec.offset);
            if (n > 0) {
              mem.set(tmp.subarray(0, n), p);
              rec.offset += n;
              read += n;
            }
            if (n < l) break; // short read → EOF, stop
          }
        } catch (err) {
          return errnoFor(err);
        }
        dv.setUint32(nreadPtr, read, true);
        return ESUCCESS;
      }

      function fd_seek(fd, offset, whence, newOffsetPtr) {
        const rec = getFd(fd);
        if (!rec || rec.type !== "file") return EBADF;
        const off = Number(offset);
        let base = 0;
        if (whence === WHENCE_SET) base = 0;
        else if (whence === WHENCE_CUR) base = rec.offset;
        else if (whence === WHENCE_END) {
          try {
            base = fs.fstatSync(rec.hostFd).size;
          } catch (err) {
            return errnoFor(err);
          }
        } else return EINVAL;
        rec.offset = base + off;
        view().setBigUint64(newOffsetPtr, BigInt(rec.offset), true);
        return ESUCCESS;
      }
      function fd_tell(fd, resultPtr) {
        const rec = getFd(fd);
        if (!rec || rec.type !== "file") return EBADF;
        view().setBigUint64(resultPtr, BigInt(rec.offset), true);
        return ESUCCESS;
      }

      function filetypeOf(st) {
        if (st.isDirectory()) return FILETYPE_DIRECTORY;
        if (st.isSymbolicLink && st.isSymbolicLink()) return FILETYPE_SYMBOLIC_LINK;
        if (st.isFile()) return FILETYPE_REGULAR_FILE;
        return FILETYPE_UNKNOWN;
      }

      function fd_fdstat_get(fd, resultPtr) {
        const rec = getFd(fd);
        if (!rec) return EBADF;
        const dv = view();
        let ft = FILETYPE_UNKNOWN;
        if (rec.type === "dir") ft = FILETYPE_DIRECTORY;
        else if (rec.type === "file") ft = rec.filetype;
        else if (rec.type === "stdout" || rec.type === "stderr" || rec.type === "stdin") ft = 2; // char device
        dv.setUint8(resultPtr, ft);
        dv.setUint16(resultPtr + 2, rec.fdflags || 0, true);
        dv.setBigUint64(resultPtr + 8, RIGHTS_ALL, true);
        dv.setBigUint64(resultPtr + 16, RIGHTS_ALL, true);
        return ESUCCESS;
      }
      function fd_fdstat_set_flags(fd, flags) {
        const rec = getFd(fd);
        if (!rec) return EBADF;
        rec.fdflags = flags;
        rec.append = !!(flags & FDFLAGS_APPEND);
        return ESUCCESS;
      }

      function writeFilestat(ptr, st, filetype) {
        const dv = view();
        dv.setBigUint64(ptr, BigInt(st.dev >>> 0), true); // dev
        dv.setBigUint64(ptr + 8, BigInt(st.ino >>> 0), true); // ino
        dv.setUint8(ptr + 16, filetype); // filetype
        dv.setBigUint64(ptr + 24, BigInt(st.nlink || 1), true); // nlink
        dv.setBigUint64(ptr + 32, BigInt(st.size || 0), true); // size
        const atim = BigInt(Math.floor((st.atimeMs || 0) * 1e6));
        const mtim = BigInt(Math.floor((st.mtimeMs || 0) * 1e6));
        const ctim = BigInt(Math.floor((st.ctimeMs || 0) * 1e6));
        dv.setBigUint64(ptr + 40, atim, true);
        dv.setBigUint64(ptr + 48, mtim, true);
        dv.setBigUint64(ptr + 56, ctim, true);
      }

      function fd_filestat_get(fd, resultPtr) {
        const rec = getFd(fd);
        if (!rec) return EBADF;
        try {
          if (rec.type === "file") {
            const st = fs.fstatSync(rec.hostFd);
            writeFilestat(resultPtr, st, filetypeOf(st));
          } else if (rec.type === "dir") {
            const st = fs.statSync(rec.hostPath);
            writeFilestat(resultPtr, st, FILETYPE_DIRECTORY);
          } else {
            writeFilestat(resultPtr, { size: 0 }, 2);
          }
        } catch (err) {
          return errnoFor(err);
        }
        return ESUCCESS;
      }

      function fd_prestat_get(fd, resultPtr) {
        const rec = getFd(fd);
        if (!rec || rec.type !== "dir" || !rec.preopen) return EBADF;
        const dv = view();
        dv.setUint8(resultPtr, 0); // __wasi_preopentype_t: dir
        dv.setUint32(resultPtr + 4, encoder.encode(rec.guestPath).length, true);
        return ESUCCESS;
      }
      function fd_prestat_dir_name(fd, pathPtr, pathLen) {
        const rec = getFd(fd);
        if (!rec || rec.type !== "dir" || !rec.preopen) return EBADF;
        const enc = encoder.encode(rec.guestPath);
        if (enc.length > pathLen) return ENOTCAPABLE;
        bytes().set(enc, pathPtr);
        return ESUCCESS;
      }

      function readString(ptr, len) {
        return decoder.decode(bytes().slice(ptr, ptr + len));
      }
      function resolveAt(dirfd, relPath) {
        const rec = getFd(dirfd);
        if (!rec || rec.type !== "dir") return null;
        return normalize(rec.hostPath + "/" + relPath);
      }

      function path_open(dirfd, _dirflags, pathPtr, pathLen, oflags, rightsBase, _rightsInh, fdflags, resultFdPtr) {
        const relPath = readString(pathPtr, pathLen);
        const hostPath = resolveAt(dirfd, relPath);
        if (hostPath == null) return EBADF;

        const rights = typeof rightsBase === "bigint" ? rightsBase : BigInt(rightsBase);
        const wantWrite = (rights & RIGHT_FD_WRITE) !== 0n || (oflags & (OFLAGS_CREAT | OFLAGS_TRUNC)) !== 0;
        const wantRead = (rights & RIGHT_FD_READ) !== 0n || !wantWrite;

        // A directory open (no file rights / O_DIRECTORY): register a dir fd.
        if (oflags & OFLAGS_DIRECTORY) {
          let st;
          try {
            st = fs.statSync(hostPath);
          } catch (err) {
            return errnoFor(err);
          }
          if (!st.isDirectory()) return ENOTDIR;
          const fd = self._nextFd++;
          self._fds.set(fd, { type: "dir", guestPath: relPath, hostPath, preopen: false });
          view().setUint32(resultFdPtr, fd, true);
          return ESUCCESS;
        }

        let flags = 0;
        if (wantRead && wantWrite) flags |= O.O_RDWR;
        else if (wantWrite) flags |= O.O_WRONLY;
        else flags |= O.O_RDONLY;
        if (oflags & OFLAGS_CREAT) flags |= O.O_CREAT;
        if (oflags & OFLAGS_TRUNC) flags |= O.O_TRUNC;
        if (oflags & OFLAGS_EXCL) flags |= O.O_EXCL;
        if (fdflags & FDFLAGS_APPEND) flags |= O.O_APPEND;

        let hostFd;
        try {
          hostFd = fs.openSync(hostPath, flags, 0o666);
        } catch (err) {
          // Opening a directory as a file → surface as a dir handle so callers
          // that stat it still work.
          if (err && err.code === "EISDIR") {
            const fd = self._nextFd++;
            self._fds.set(fd, { type: "dir", guestPath: relPath, hostPath, preopen: false });
            view().setUint32(resultFdPtr, fd, true);
            return ESUCCESS;
          }
          return errnoFor(err);
        }
        let filetype = FILETYPE_REGULAR_FILE;
        try {
          filetype = filetypeOf(fs.fstatSync(hostFd));
        } catch {
          /* keep default */
        }
        const fd = self._nextFd++;
        self._fds.set(fd, {
          type: "file",
          hostFd,
          hostPath,
          offset: fdflags & FDFLAGS_APPEND ? 0 : 0,
          append: !!(fdflags & FDFLAGS_APPEND),
          fdflags,
          filetype,
        });
        view().setUint32(resultFdPtr, fd, true);
        return ESUCCESS;
      }

      function path_filestat_get(dirfd, _flags, pathPtr, pathLen, resultPtr) {
        const hostPath = resolveAt(dirfd, readString(pathPtr, pathLen));
        if (hostPath == null) return EBADF;
        try {
          const st = fs.statSync(hostPath);
          writeFilestat(resultPtr, st, filetypeOf(st));
        } catch (err) {
          return errnoFor(err);
        }
        return ESUCCESS;
      }
      function path_create_directory(dirfd, pathPtr, pathLen) {
        const hostPath = resolveAt(dirfd, readString(pathPtr, pathLen));
        if (hostPath == null) return EBADF;
        try {
          fs.mkdirSync(hostPath);
        } catch (err) {
          return errnoFor(err);
        }
        return ESUCCESS;
      }
      function path_unlink_file(dirfd, pathPtr, pathLen) {
        const hostPath = resolveAt(dirfd, readString(pathPtr, pathLen));
        if (hostPath == null) return EBADF;
        try {
          fs.unlinkSync(hostPath);
        } catch (err) {
          return errnoFor(err);
        }
        return ESUCCESS;
      }
      function path_remove_directory(dirfd, pathPtr, pathLen) {
        const hostPath = resolveAt(dirfd, readString(pathPtr, pathLen));
        if (hostPath == null) return EBADF;
        try {
          fs.rmdirSync(hostPath);
        } catch (err) {
          return errnoFor(err);
        }
        return ESUCCESS;
      }
      function path_rename(dirfd, oldPtr, oldLen, newDirfd, newPtr, newLen) {
        const from = resolveAt(dirfd, readString(oldPtr, oldLen));
        const to = resolveAt(newDirfd, readString(newPtr, newLen));
        if (from == null || to == null) return EBADF;
        try {
          fs.renameSync(from, to);
        } catch (err) {
          return errnoFor(err);
        }
        return ESUCCESS;
      }
      function path_symlink(targetPtr, targetLen, dirfd, pathPtr, pathLen) {
        const target = readString(targetPtr, targetLen);
        const linkPath = resolveAt(dirfd, readString(pathPtr, pathLen));
        if (linkPath == null) return EBADF;
        try {
          fs.symlinkSync(target, linkPath);
        } catch (err) {
          return errnoFor(err);
        }
        return ESUCCESS;
      }
      function path_readlink(dirfd, pathPtr, pathLen, bufPtr, bufLen, resultPtr) {
        const hostPath = resolveAt(dirfd, readString(pathPtr, pathLen));
        if (hostPath == null) return EBADF;
        try {
          const target = encoder.encode(fs.readlinkSync(hostPath));
          const n = Math.min(target.length, bufLen);
          bytes().set(target.subarray(0, n), bufPtr);
          view().setUint32(resultPtr, n, true);
        } catch (err) {
          return errnoFor(err);
        }
        return ESUCCESS;
      }

      function fd_readdir(fd, bufPtr, bufLen, cookie, resultPtr) {
        const rec = getFd(fd);
        if (!rec || rec.type !== "dir") return EBADF;
        let names;
        try {
          names = fs.readdirSync(rec.hostPath);
        } catch (err) {
          return errnoFor(err);
        }
        const dv = view();
        const mem = bytes();
        let offset = 0;
        let idx = Number(cookie);
        for (; idx < names.length; idx++) {
          const nameBytes = encoder.encode(names[idx]);
          const entrySize = 24 + nameBytes.length; // dirent header (24) + name
          if (offset + entrySize > bufLen) break;
          let ft = FILETYPE_UNKNOWN;
          try {
            ft = filetypeOf(fs.lstatSync(normalize(rec.hostPath + "/" + names[idx])));
          } catch {
            /* unknown */
          }
          dv.setBigUint64(bufPtr + offset, BigInt(idx + 1), true); // d_next
          dv.setBigUint64(bufPtr + offset + 8, 0n, true); // d_ino
          dv.setUint32(bufPtr + offset + 16, nameBytes.length, true); // d_namlen
          dv.setUint8(bufPtr + offset + 20, ft); // d_type
          mem.set(nameBytes, bufPtr + offset + 24);
          offset += entrySize;
        }
        dv.setUint32(resultPtr, offset, true);
        return ESUCCESS;
      }

      // No-op / benign syscalls used by some runtimes.
      const ok = () => ESUCCESS;
      const notsup = () => ENOSYS;

      return {
        args_sizes_get,
        args_get,
        environ_sizes_get,
        environ_get,
        clock_time_get,
        clock_res_get,
        random_get,
        proc_exit,
        sched_yield,
        proc_raise,
        poll_oneoff,
        fd_close,
        fd_write,
        fd_read,
        fd_seek,
        fd_tell,
        fd_fdstat_get,
        fd_fdstat_set_flags,
        fd_filestat_get,
        fd_prestat_get,
        fd_prestat_dir_name,
        fd_readdir,
        fd_sync: ok,
        fd_datasync: ok,
        fd_advise: ok,
        fd_allocate: ok,
        fd_fdstat_set_rights: ok,
        fd_filestat_set_size: notsup,
        fd_filestat_set_times: ok,
        fd_pread: notsup,
        fd_pwrite: notsup,
        fd_renumber: notsup,
        path_open,
        path_filestat_get,
        path_filestat_set_times: ok,
        path_create_directory,
        path_unlink_file,
        path_remove_directory,
        path_rename,
        path_symlink,
        path_readlink,
        path_link: notsup,
        sock_accept: notsup,
        sock_recv: notsup,
        sock_send: notsup,
        sock_shutdown: notsup,
      };
    }
  }

  exports.WASI = WASI;
}
