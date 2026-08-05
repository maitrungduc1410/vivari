// The POSIX / libuv / OpenSSL constant tables, in one place.
//
// Node builds every public constants surface from a single internal table:
// `os.constants`, `fs.constants`, `crypto.constants` and the deprecated
// `constants` module are all views over `internalBinding('constants')`. We had
// four hand-written partial copies instead — one per consumer — and they had
// drifted from each other and from Node:
//
//   os.constants.signals   was `{}`, so `child.kill(os.constants.signals.SIGKILL)`
//                          killed with `undefined` rather than with 9
//   os.constants.priority  was `{}`, os.constants.dlopen did not exist
//   fs.constants           had the owner permission bits but not group or other,
//                          so a mode built from S_IRWXG came out NaN
//   crypto.constants       had 7 of 56 — enough for the RSA padding the signer
//                          used, and nothing a caller might read
//   constants (deprecated) carried its own second copy of errno and signals, plus
//                          two Windows-only names (WSAEINTR/WSAEBADF) on Linux
//
// None of that could announce itself: reading a missing constant is `undefined`,
// not an error, and `undefined` in a bitmask is a silently wrong number.
//
// The values are the HOST's, dumped from a real Linux Node rather than typed from
// memory — the OpenSSL SSL_OP_* bits in particular are not derivable from
// anything we run (our crypto is Rust), so they exist to be read and compared by
// callers, and the only thing that makes them right is that they match Node's.
// `spike-constants.mjs` compares all five surfaces against the host, key by key
// and value by value, which is also how to regenerate this file after a Node
// upgrade moves one.

// signal name -> number. SIGABRT/SIGIOT and SIGIO/SIGPOLL share a number, as on
// Linux; the duplicates are aliases, not mistakes.
export const OS_SIGNALS = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6,
  SIGIOT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11,
  SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGSTKFLT: 16,
  SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23,
  SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29,
  SIGPOLL: 29, SIGPWR: 30, SIGSYS: 31,
};

export const OS_PRIORITY = {
  PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0,
  PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20,
};

export const OS_DLOPEN = {
  RTLD_LAZY: 1, RTLD_NOW: 2, RTLD_GLOBAL: 256,
  RTLD_LOCAL: 0, RTLD_DEEPBIND: 8,
};

// os.constants.UV_UDP_REUSEADDR — the one flag that sits on os.constants itself.
export const UV_UDP_REUSEADDR = 4;

// The OpenSSL surface. We do not run OpenSSL, so nothing here is honoured by our
// own crypto beyond the RSA padding/salt values (which lib/crypto.js reads to
// select PSS); the rest is what callers read, feature-detect and OR together.
export const CRYPTO_CONSTANTS = {
  RSA_PKCS1_PADDING: 1, RSA_NO_PADDING: 3, RSA_PKCS1_OAEP_PADDING: 4,
  RSA_PKCS1_PSS_PADDING: 6, RSA_PSS_SALTLEN_DIGEST: -1, RSA_PSS_SALTLEN_AUTO: -2,
  RSA_PSS_SALTLEN_MAX_SIGN: -2,
  OPENSSL_VERSION_NUMBER: 810549360, SSL_OP_ALL: 2147485776, SSL_OP_ALLOW_NO_DHE_KEX: 1024,
  SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION: 262144, SSL_OP_CIPHER_SERVER_PREFERENCE: 4194304, SSL_OP_CISCO_ANYCONNECT: 32768,
  SSL_OP_COOKIE_EXCHANGE: 8192, SSL_OP_CRYPTOPRO_TLSEXT_BUG: 2147483648, SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS: 2048,
  SSL_OP_LEGACY_SERVER_CONNECT: 4, SSL_OP_NO_COMPRESSION: 131072, SSL_OP_NO_ENCRYPT_THEN_MAC: 524288,
  SSL_OP_NO_QUERY_MTU: 4096, SSL_OP_NO_RENEGOTIATION: 1073741824, SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION: 65536,
  SSL_OP_NO_SSLv2: 0, SSL_OP_NO_SSLv3: 33554432, SSL_OP_NO_TICKET: 16384,
  SSL_OP_NO_TLSv1: 67108864, SSL_OP_NO_TLSv1_1: 268435456, SSL_OP_NO_TLSv1_2: 134217728,
  SSL_OP_NO_TLSv1_3: 536870912, SSL_OP_PRIORITIZE_CHACHA: 2097152, SSL_OP_TLS_ROLLBACK_BUG: 8388608,
  ENGINE_METHOD_RSA: 1, ENGINE_METHOD_DSA: 2, ENGINE_METHOD_DH: 4,
  ENGINE_METHOD_RAND: 8, ENGINE_METHOD_EC: 2048, ENGINE_METHOD_CIPHERS: 64,
  ENGINE_METHOD_DIGESTS: 128, ENGINE_METHOD_PKEY_METHS: 512, ENGINE_METHOD_PKEY_ASN1_METHS: 1024,
  ENGINE_METHOD_ALL: 65535, ENGINE_METHOD_NONE: 0, DH_CHECK_P_NOT_SAFE_PRIME: 2,
  DH_CHECK_P_NOT_PRIME: 1, DH_UNABLE_TO_CHECK_GENERATOR: 4, DH_NOT_SUITABLE_GENERATOR: 8,
  RSA_X931_PADDING: 5, TLS1_VERSION: 769, TLS1_1_VERSION: 770,
  TLS1_2_VERSION: 771, TLS1_3_VERSION: 772, POINT_CONVERSION_COMPRESSED: 2,
  POINT_CONVERSION_UNCOMPRESSED: 4, POINT_CONVERSION_HYBRID: 6,
  // One long line on purpose: a value, not a table — wrapping it invites an edit
  // that changes it.
  defaultCoreCipherList:
    "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA",
};

// POSIX errno numbers. The vendored lib/ reads them from here (as
// `internalBinding('constants').os.errno`), and this held a single entry
// (`EISDIR`) for as long as only one caller was known: every other name a vendored
// module destructured came out `undefined`, so `fs.cp` threw its ERR_FS_CP_* errors
// with `errno: undefined` and nobody noticed, because the `code` was right and
// nothing asserts the number. `spike-fs-cp.mjs` compares a thrown errno against the
// host's for the same failure; `spike-constants.mjs` compares the whole table.
export const OS_ERRNO = {
  E2BIG: 7, EACCES: 13, EADDRINUSE: 98, EADDRNOTAVAIL: 99, EAFNOSUPPORT: 97,
  EAGAIN: 11, EALREADY: 114, EBADF: 9, EBADMSG: 74, EBUSY: 16,
  ECANCELED: 125, ECHILD: 10, ECONNABORTED: 103, ECONNREFUSED: 111, ECONNRESET: 104,
  EDEADLK: 35, EDESTADDRREQ: 89, EDOM: 33, EDQUOT: 122, EEXIST: 17,
  EFAULT: 14, EFBIG: 27, EHOSTUNREACH: 113, EIDRM: 43, EILSEQ: 84,
  EINPROGRESS: 115, EINTR: 4, EINVAL: 22, EIO: 5, EISCONN: 106,
  EISDIR: 21, ELOOP: 40, EMFILE: 24, EMLINK: 31, EMSGSIZE: 90,
  EMULTIHOP: 72, ENAMETOOLONG: 36, ENETDOWN: 100, ENETRESET: 102, ENETUNREACH: 101,
  ENFILE: 23, ENOBUFS: 105, ENODATA: 61, ENODEV: 19, ENOENT: 2,
  ENOEXEC: 8, ENOLCK: 37, ENOLINK: 67, ENOMEM: 12, ENOMSG: 42,
  ENOPROTOOPT: 92, ENOSPC: 28, ENOSR: 63, ENOSTR: 60, ENOSYS: 38,
  ENOTCONN: 107, ENOTDIR: 20, ENOTEMPTY: 39, ENOTSOCK: 88, ENOTSUP: 95,
  ENOTTY: 25, ENXIO: 6, EOPNOTSUPP: 95, EOVERFLOW: 75, EPERM: 1,
  EPIPE: 32, EPROTO: 71, EPROTONOSUPPORT: 93, EPROTOTYPE: 91, ERANGE: 34,
  EROFS: 30, ESPIPE: 29, ESRCH: 3, ESTALE: 116, ETIME: 62,
  ETIMEDOUT: 110, ETXTBSY: 26, EWOULDBLOCK: 11, EXDEV: 18,
};

// The fs surface: `lib/fs.js` and `internal/fs/utils.js` destructure these, and the
// O_* values MUST match the flag bits the Rust VFS decodes in open(2) (Linux's).
export const FS_CONSTANTS = {
  O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 0o100,
  O_EXCL: 0o200, O_NOCTTY: 0o400, O_TRUNC: 0o1000, O_APPEND: 0o2000,
  O_DIRECTORY: 0o200000, O_NOFOLLOW: 0o400000, O_SYNC: 0o4010000, O_DSYNC: 0o10000,
  O_DIRECT: 0o40000, O_NONBLOCK: 0o4000, S_IFMT: 0o170000, S_IFREG: 0o100000,
  S_IFDIR: 0o040000, S_IFCHR: 0o020000, S_IFBLK: 0o060000, S_IFIFO: 0o010000,
  S_IFLNK: 0o120000, S_IFSOCK: 0o140000, S_IRWXU: 0o700, S_IRUSR: 0o400,
  S_IWUSR: 0o200, S_IXUSR: 0o100, S_IRWXG: 0o070, S_IRGRP: 0o040,
  S_IWGRP: 0o020, S_IXGRP: 0o010, S_IRWXO: 0o007, S_IROTH: 0o004,
  S_IWOTH: 0o002, S_IXOTH: 0o001, O_NOATIME: 0o1000000, F_OK: 0,
  R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1,
  COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4, UV_FS_COPYFILE_EXCL: 1, UV_FS_COPYFILE_FICLONE: 2,
  UV_FS_COPYFILE_FICLONE_FORCE: 4, UV_FS_O_FILEMAP: 0, UV_FS_SYMLINK_DIR: 1, UV_FS_SYMLINK_JUNCTION: 2,
  UV_DIRENT_UNKNOWN: 0, UV_DIRENT_FILE: 1, UV_DIRENT_DIR: 2, UV_DIRENT_LINK: 3,
  UV_DIRENT_FIFO: 4, UV_DIRENT_SOCKET: 5, UV_DIRENT_CHAR: 6, UV_DIRENT_BLOCK: 7,
};
