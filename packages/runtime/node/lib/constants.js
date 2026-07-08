// The deprecated public `constants` module — a flat aggregate of fs, signal, and
// errno constants. Modern code should use `fs.constants` / `os.constants`, but
// some older packages still `require('constants')`. We build it from the real
// (vendored) fs.constants plus the common signal/errno numbers.

export default function (exports, require, module, process, internalBinding, primordials) {
  const fs = require("fs");

  const signals = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6,
    SIGIOT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11,
    SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17,
    SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22,
    SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27,
    SIGWINCH: 28, SIGIO: 29, SIGSYS: 31,
  };

  const errno = {
    E2BIG: 7, EACCES: 13, EADDRINUSE: 98, EADDRNOTAVAIL: 99, EAGAIN: 11,
    EALREADY: 114, EBADF: 9, EBUSY: 16, ECANCELED: 125, ECONNABORTED: 103,
    ECONNREFUSED: 111, ECONNRESET: 104, EEXIST: 17, EFAULT: 14, EFBIG: 27,
    EHOSTUNREACH: 113, EINPROGRESS: 115, EINTR: 4, EINVAL: 22, EIO: 5,
    EISCONN: 106, EISDIR: 21, ELOOP: 40, EMFILE: 24, EMLINK: 31,
    EMSGSIZE: 90, ENAMETOOLONG: 36, ENETDOWN: 100, ENETRESET: 102,
    ENETUNREACH: 101, ENFILE: 23, ENOBUFS: 105, ENODEV: 19, ENOENT: 2,
    ENOMEM: 12, ENOPROTOOPT: 92, ENOSPC: 28, ENOSYS: 38, ENOTCONN: 107,
    ENOTDIR: 20, ENOTEMPTY: 39, ENOTSOCK: 88, ENOTSUP: 95, ENOTTY: 25,
    ENXIO: 6, EOPNOTSUPP: 95, EPERM: 1, EPIPE: 32, EPROTO: 71,
    EPROTONOSUPPORT: 93, EPROTOTYPE: 91, ERANGE: 34, EROFS: 30, ESPIPE: 29,
    ESRCH: 3, ETIMEDOUT: 110, EXDEV: 18, WSAEINTR: 10004, WSAEBADF: 10009,
  };

  module.exports = Object.assign({}, fs.constants || {}, signals, errno);
}
