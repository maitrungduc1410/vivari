// libuv's error numbers and their descriptions, shared by the bindings that have to
// report failures the way Node does: `uv` (bindings/net.js) and `fs`
// (bindings/fs.js, where every syscall error carries one).
//
// This lived in bindings/net.js and covered the codes the socket layer could
// produce. `fs` needs a wider set — EEXIST, ENOTDIR, EISDIR, ENOTEMPTY and the rest
// — and a second table would have meant two answers for the same code, so it moved
// here instead.
//
// Values are Linux's errno, negated, which is what libuv reports and what Node's
// `err.errno` carries. They are NOT the positive numbers in
// `internalBinding('constants').os.errno`; both are correct in their own place, and
// the two are used for different things.

export const UV_MESSAGES = {
  [-4095]: ["EOF", "end of file"],
  [-1]: ["EPERM", "operation not permitted"],
  [-2]: ["ENOENT", "no such file or directory"],
  [-5]: ["EIO", "i/o error"],
  [-9]: ["EBADF", "bad file descriptor"],
  [-11]: ["EAGAIN", "resource temporarily unavailable"],
  [-12]: ["ENOMEM", "not enough memory"],
  [-13]: ["EACCES", "permission denied"],
  [-16]: ["EBUSY", "resource busy or locked"],
  [-17]: ["EEXIST", "file already exists"],
  [-18]: ["EXDEV", "cross-device link not permitted"],
  [-20]: ["ENOTDIR", "not a directory"],
  [-21]: ["EISDIR", "illegal operation on a directory"],
  [-22]: ["EINVAL", "invalid argument"],
  [-23]: ["ENFILE", "file table overflow"],
  [-24]: ["EMFILE", "too many open files"],
  [-27]: ["EFBIG", "file too large"],
  [-28]: ["ENOSPC", "no space left on device"],
  [-29]: ["ESPIPE", "invalid seek"],
  [-30]: ["EROFS", "read-only file system"],
  [-31]: ["EMLINK", "too many links"],
  [-32]: ["EPIPE", "broken pipe"],
  [-36]: ["ENAMETOOLONG", "name too long"],
  [-38]: ["ENOSYS", "function not implemented"],
  [-39]: ["ENOTEMPTY", "directory not empty"],
  [-40]: ["ELOOP", "too many symbolic links encountered"],
  [-75]: ["EOVERFLOW", "value too large for defined data type"],
  [-98]: ["EADDRINUSE", "address already in use"],
  [-99]: ["EADDRNOTAVAIL", "address not available"],
  [-103]: ["ECONNABORTED", "software caused connection abort"],
  [-104]: ["ECONNRESET", "connection reset by peer"],
  [-107]: ["ENOTCONN", "socket is not connected"],
  [-110]: ["ETIMEDOUT", "connection timed out"],
  [-111]: ["ECONNREFUSED", "connection refused"],
  [-113]: ["EHOSTUNREACH", "host is unreachable"],
  [-125]: ["ECANCELED", "operation canceled"],
  // libuv's UV_EAI_NONAME. Node's own errmap spells this one 'EAI_NONAME' and lets
  // the dns layer translate it, but nothing here goes through that layer, and
  // 'ENOTFOUND' is both what callers match on and what our lib/dns.js already
  // returns for a name it cannot resolve. Keep the two consistent.
  [-3008]: ["ENOTFOUND", "name not resolved"],
};

// UV_<NAME>: <errno>, derived from the table above so the two cannot drift.
export const UV_CODES = (() => {
  const out = {};
  for (const errno of Object.keys(UV_MESSAGES)) {
    out["UV_" + UV_MESSAGES[errno][0]] = Number(errno);
  }
  return out;
})();

const ERRNO_BY_NAME = (() => {
  const out = {};
  for (const errno of Object.keys(UV_MESSAGES)) out[UV_MESSAGES[errno][0]] = Number(errno);
  return out;
})();

// The negative errno for a code name, or undefined for one we do not model — the
// caller decides what to do about that, because inventing a number would be worse
// than leaving it off.
export const errnoFor = (code) => ERRNO_BY_NAME[code];

// The phrase Node puts in the message: "ENOENT: no such file or directory, open …".
export const describeCode = (code) => {
  const errno = ERRNO_BY_NAME[code];
  return errno === undefined ? undefined : UV_MESSAGES[errno][1];
};

export const errname = (errno) =>
  UV_MESSAGES[errno] ? UV_MESSAGES[errno][0] : `Unknown system error ${errno}`;

export const getErrorMap = () => {
  const m = new Map();
  for (const errno of Object.keys(UV_MESSAGES)) {
    const [name, msg] = UV_MESSAGES[errno];
    m.set(Number(errno), [name, msg]);
  }
  return m;
};
