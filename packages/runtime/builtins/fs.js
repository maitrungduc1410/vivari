// The Node `fs` builtin (sync subset), layered over the low-level syscalls.
// Adds Node semantics: Buffer results, encodings, and Stats objects.

export function createFs(sys, Buffer, path) {
  const encodingOf = (opts) =>
    typeof opts === "string" ? opts : opts && opts.encoding ? opts.encoding : null;

  // Node resolves relative paths against process.cwd(); the VFS only speaks
  // absolute paths, so normalize at the boundary. `path.resolve` uses the
  // process cwd injected when `path` was created.
  const R = (p) => path.resolve(p);

  const makeStats = (s) => ({
    size: s.size,
    mode: s.mode,
    mtimeMs: s.mtimeMs,
    atimeMs: s.mtimeMs,
    ctimeMs: s.mtimeMs,
    birthtimeMs: s.mtimeMs,
    mtime: new Date(s.mtimeMs),
    atime: new Date(s.mtimeMs),
    ctime: new Date(s.mtimeMs),
    birthtime: new Date(s.mtimeMs),
    isFile: () => s.kind === "file",
    isDirectory: () => s.kind === "dir",
    isSymbolicLink: () => s.kind === "symlink",
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  });

  const fs = {
    readFileSync(p, opts) {
      const bytes = sys.readFile(R(p));
      const enc = encodingOf(opts);
      return enc ? Buffer.from(bytes).toString(enc) : Buffer.from(bytes);
    },
    writeFileSync(p, data, opts) {
      const enc = encodingOf(opts) || "utf8";
      const bytes = typeof data === "string" ? Buffer.from(data, enc) : Buffer.from(data);
      sys.writeFile(R(p), bytes);
    },
    appendFileSync(p, data, opts) {
      const abs = R(p);
      let cur;
      try {
        cur = sys.readFile(abs);
      } catch {
        cur = new Uint8Array(0);
      }
      const enc = encodingOf(opts) || "utf8";
      const add = typeof data === "string" ? Buffer.from(data, enc) : Buffer.from(data);
      sys.writeFile(abs, Buffer.concat([Buffer.from(cur), add]));
    },
    existsSync(p) {
      return sys.exists(R(p));
    },
    mkdirSync(p, opts) {
      sys.mkdir(R(p), !!(opts && opts.recursive));
    },
    readdirSync(p) {
      return sys.readdir(R(p));
    },
    statSync(p) {
      return makeStats(sys.stat(R(p)));
    },
    lstatSync(p) {
      return makeStats(sys.lstat(R(p)));
    },
    unlinkSync(p) {
      sys.unlink(R(p));
    },
    rmdirSync(p) {
      sys.rmdir(R(p));
    },
    rmSync(p, opts = {}) {
      const abs = R(p);
      try {
        const st = sys.lstat(abs);
        if (st.kind === "dir") {
          if (opts.recursive) {
            for (const name of sys.readdir(abs)) fs.rmSync(path.join(abs, name), opts);
          }
          sys.rmdir(abs);
        } else {
          sys.unlink(abs);
        }
      } catch (err) {
        if (!opts.force) throw err;
      }
    },
    renameSync(from, to) {
      sys.rename(R(from), R(to));
    },
    symlinkSync(target, p) {
      sys.symlink(target, R(p));
    },
    readlinkSync(p) {
      return sys.readlink(R(p));
    },
    realpathSync(p) {
      return R(p);
    },
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
  };
  return fs;
}
