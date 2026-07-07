// internalBinding — the seam Node's lib/ uses to reach its C++ core.
//
// In real Node, `internalBinding('fs')` returns the native (C++) module. In
// OpenContainer (Path B), THIS is where we substitute our own implementations:
// JS shims, Wasm codecs, or calls down to the Rust VFS via the sync bridge. The
// JS layer above the binding line (Node's real lib/) stays unmodified.
//
// Bindings are added as each real lib/ module comes online: 'buffer' (codecs),
// with 'fs' (Rust VFS), 'zlib', etc. to follow.

import { createBufferBinding } from "./bindings/buffer.js";
import { createFsBinding } from "./bindings/fs.js";
import { createNetBindings } from "./bindings/net.js";
import { createHttpParserBinding } from "./bindings/http_parser.js";

// POSIX/libuv constants exposed as internalBinding('constants').fs. Node's real
// lib/fs.js and internal/fs/utils.js destructure these; the O_* values MUST
// match the flag bits the Rust VFS decodes in open(2) (Linux values).
const FS_CONSTANTS = {
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 0o100,
  O_EXCL: 0o200,
  O_NOCTTY: 0o400,
  O_TRUNC: 0o1000,
  O_APPEND: 0o2000,
  O_DIRECTORY: 0o200000,
  O_NOFOLLOW: 0o400000,
  O_SYNC: 0o4010000,
  O_DSYNC: 0o10000,
  O_DIRECT: 0o40000,
  O_NONBLOCK: 0o4000,
  S_IFMT: 0o170000,
  S_IFREG: 0o100000,
  S_IFDIR: 0o040000,
  S_IFCHR: 0o020000,
  S_IFBLK: 0o060000,
  S_IFIFO: 0o010000,
  S_IFLNK: 0o120000,
  S_IFSOCK: 0o140000,
  S_IRWXU: 0o700,
  S_IRUSR: 0o400,
  S_IWUSR: 0o200,
  S_IXUSR: 0o100,
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  COPYFILE_EXCL: 1,
  COPYFILE_FICLONE: 2,
  COPYFILE_FICLONE_FORCE: 4,
  UV_FS_SYMLINK_DIR: 1,
  UV_FS_SYMLINK_JUNCTION: 2,
  UV_DIRENT_UNKNOWN: 0,
  UV_DIRENT_FILE: 1,
  UV_DIRENT_DIR: 2,
  UV_DIRENT_LINK: 3,
  UV_DIRENT_FIFO: 4,
  UV_DIRENT_SOCKET: 5,
  UV_DIRENT_CHAR: 6,
  UV_DIRENT_BLOCK: 7,
};

// Node's v8::PropertyFilter values used by getOwnNonIndexProperties.
const ALL_PROPERTIES = 0;
const ONLY_ENUMERABLE = 2;

function getOwnNonIndexProperties(obj, filter) {
  const isIndex = (k) => /^(?:0|[1-9]\d*)$/.test(k) && Number(k) <= 0xffffffff;
  const keep = (d) => (filter === ONLY_ENUMERABLE ? d.enumerable : true);
  const out = [];
  for (const k of Object.getOwnPropertyNames(obj)) {
    if (isIndex(k)) continue;
    if (keep(Object.getOwnPropertyDescriptor(obj, k))) out.push(k);
  }
  for (const s of Object.getOwnPropertySymbols(obj)) {
    if (keep(Object.getOwnPropertyDescriptor(obj, s))) out.push(s);
  }
  return out;
}

export function createInternalBinding({ syscalls, process, netLiveness, netServers } = {}) {
  // net (Phase 2 #7/#8): tcp_wrap/stream_wrap/uv/pipe_wrap/cares_wrap for the
  // in-process loopback beneath Node's real lib/net.js. Needs process.nextTick.
  // `syscalls` lets listen() register the port with the kernel (external routing,
  // stage 2); `netServers` counts kernel-registered listeners for `doNet`.
  const net = createNetBindings({ process, liveness: netLiveness, syscalls, netServers });
  const bindings = {
    buffer: createBufferBinding(),
    // 'fs' needs the sync-bridge syscalls (to reach the Rust VFS) and process
    // (to defer async callbacks onto nextTick).
    fs: syscalls ? createFsBinding({ sys: syscalls, process }) : undefined,
    tcp_wrap: net.tcp_wrap,
    stream_wrap: net.stream_wrap,
    uv: net.uv,
    pipe_wrap: net.pipe_wrap,
    cares_wrap: net.cares_wrap,
    // http_parser (Phase 2 #8): pure-JS HTTP/1.1 parser beneath real lib/http.
    http_parser: createHttpParserBinding(),
    // trace_events: inert — internal/http records HTTP trace spans through it.
    trace_events: {
      getCategoryEnabledBuffer: () => new Uint8Array(1),
      trace: () => {},
    },
    util: {
      constants: { ALL_PROPERTIES, ONLY_ENUMERABLE },
      getOwnNonIndexProperties,
      isInsideNodeModules: () => false,
      privateSymbols: {
        untransferable_object_private_symbol: Symbol("untransferable_object"),
      },
    },
    // hasIntl=false keeps Buffer.transcode / ICU paths dormant (no icu binding).
    config: { hasIntl: false },
    constants: {
      os: { signals: {}, errno: { EISDIR: 21 }, priority: {} },
      fs: FS_CONSTANTS,
    },
  };

  return function internalBinding(name) {
    if (Object.prototype.hasOwnProperty.call(bindings, name)) return bindings[name];
    throw new Error(`OpenContainer: internalBinding('${name}') is not implemented yet`);
  };
}
