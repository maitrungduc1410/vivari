// bun:sqlite — real SQLite, compiled to WebAssembly, over Vivari's synchronous fs.
//
// WHY THIS FILE EXISTS AT ALL. `bun:sqlite`'s API is synchronous: `db.query(sql).all()`
// returns rows, it does not return a Promise. There is nowhere to `await` an engine
// boot, so every mainstream way of running SQLite in a browser is unavailable to us:
// they all hand back a Promise. What we do instead is drive the official sqlite.org
// `.wasm` byte artifact with OUR OWN JavaScript, and skip the Emscripten glue that
// ships beside it entirely. See §1.
//
//   1. THE ENGINE. packages/runtime/vendor/sqlite/sqlite3.wasm is the compiled SQLite
//      lifted verbatim out of the official `@sqlite.org/sqlite-wasm` npm package (see
//      scripts/vendor-sqlite.mjs for the pin + provenance + how to refresh it). We take
//      ONLY the .wasm. The package's `sqlite3.mjs` glue is 578 KB of Emscripten runtime
//      whose entry point is a `.then()` chain and whose post-init step is a genuine
//      async OPFS worker handshake — unusable here, and unnecessary: the .wasm imports
//      36 functions and one memory, and exports all 262 public C symbols unmangled.
//      Supplying those 36 imports ourselves is ~120 lines, and then `new
//      WebAssembly.Module(bytes)` + `new WebAssembly.Instance(...)` is SYNCHRONOUS.
//      Measured at 2-3 ms for the 846 KB payload under Node 22. This is the same
//      technique packages/runtime/node/bindings/llhttp/llhttp-wasm.js uses for llhttp,
//      one order of magnitude larger.
//
//      Sync compile is legal inside a Worker; the 4 KB sync-compile cap that would make
//      this throw is main-thread-only, and all guest code runs in Workers.
//
//   2. THE STORAGE. SQLite's own extension point for "where do the bytes live" is the
//      VFS (https://www.sqlite.org/vfs.html) — two structs of C function pointers. We
//      build both in wasm linear memory and fill them with pointers to JavaScript
//      functions (§ the trampoline note below), so xRead/xWrite land directly on
//      Vivari's positional, synchronous fdRead/fdWrite (packages/runtime/fs-client.js).
//      `sqlite3_vfs_register(pVfs, makeDefault=1)` then makes it the default and the
//      Emscripten filesystem layer never runs again — verified: with our VFS installed,
//      ZERO of the 27 __syscall_* / WASI import stubs are ever called.
//
//      The payoff is that a `.sqlite` file written here is a real file in the real VFS:
//      it shows up in the file tree, it survives the process that wrote it, and the next
//      process reads it back. It is not an in-memory image that has to be serialized out.
//
//   3. LAZINESS. Nothing above happens until the first `new Database()` actually runs.
//      A project that never imports bun:sqlite pays no fetch, no compile, no wasm heap —
//      only the parse cost of this file, which is ordinary JS. Same shape as the Pyodide
//      plug-in (packages/runtime/builtins/python.js): one cached boot, triggered by real
//      use. The compiled WebAssembly.Module and the single wasm instance are cached per
//      PROCESS, so a second `new Database()` in the same process is free and all
//      databases in a process share one 8 MB heap.
//
// THE ONE GENUINELY NON-OBVIOUS TRICK. WebAssembly.Table.prototype.set will not accept a
// plain JS function — a table entry has to be an exported wasm function. The standard
// workaround (Emscripten's own convertJsFunctionToWasm, which the official sqlite3.mjs
// relies on for exactly this) is to synthesize a ~40-byte wasm module that imports the JS
// function and re-exports it, compile THAT, and install the result. makeTrampoline() below
// is a 15-line implementation. It is synchronous, so it does not break §1.
//
// ---------------------------------------------------------------------------------
// WHAT IS HONESTLY NOT THERE. Three gaps, all forced by the sandbox, none of them papered
// over. Each is also a place where a shim could look fine in a demo and lose data in
// production, so they are stated here rather than buried:
//
//   * fsync. Vivari's fs.fsync/fdatasync are no-ops (packages/runtime/node/bindings/fs.js
//     :314-318) because there is nothing to flush to: the VFS is Rust/Wasm linear memory
//     and the OPFS mirror is drained on an async loop that a synchronous syscall cannot
//     await (packages/kernel-host/opfs-persistence.js:13-21). So xSync returns SQLITE_OK
//     without syncing. Within a session this is sound — the Rust VFS is the source of
//     truth and reads/writes are strictly ordered through it, so the rollback journal
//     protects a mid-transaction crash exactly as designed. What is NOT protected is a
//     hard tab kill in the window between a commit and the OPFS drain: the database file
//     and its journal are separate paths queued independently, so they can persist
//     inconsistently. Do not represent this as durable storage.
//     Correspondingly we do NOT claim SQLITE_IOCAP_SAFE_APPEND or POWERSAFE_OVERWRITE in
//     xDeviceCharacteristics: those flags let SQLite SKIP sync-ordering work, and adding a
//     second lie on top of the first one is how corruption stops being theoretical.
//
//   * File locking. There is no flock/fcntl opcode anywhere in packages/protocol/syscall.js,
//     so xLock/xUnlock/xCheckReservedLock are no-ops and two PROCESSES writing one database
//     file can corrupt it. Worth knowing before treating that as a Vivari-specific
//     compromise: the official sqlite.org wasm build's own default VFS is `unix-none` —
//     SQLite's explicitly lock-free unix VFS. Upstream already made this call for the
//     browser. We match the reference build rather than falling short of it. Same-process
//     multiple connections are fine and are a normal pattern.
//
//   * WAL. Write-ahead logging needs a shared-memory wal-index via an iVersion>=2 VFS's
//     xShmMap family (https://www.sqlite.org/wal.html#implementation_of_shared_memory_for_the_wal_index),
//     which needs the cross-process locking we do not have. We ship iVersion = 1. SQLite's
//     documented response to `PRAGMA journal_mode=WAL` on such a VFS is to SILENTLY leave
//     the mode alone and report the mode actually in effect — measured: it returns
//     "delete". Silence is the failure mode this shim exists to avoid, so we emit a
//     one-time console.warn naming the constraint. We warn rather than throw because
//     Drizzle and Prisma both set WAL opportunistically and throwing would break them.
//
// DELIBERATELY LOUD: .loadExtension() and .fileControl(). Not a shortcut — the vendored
// build does not export sqlite3_load_extension at all (extensions are native shared
// libraries and need dlopen), and file-control opcodes are meaningful only to a real
// OS-backed VFS. Both throw, naming the API and the reason, per the house pattern.
//
// TESTING SEAM. createSqliteEngine() takes its filesystem by injection, so the same
// shipped code runs (a) in a guest process against the Wasm VFS and (b) in plain Node
// against node:fs, which is what lets scripts/spike-bun-offline.mjs — the tier CI runs on
// every PR — drive the REAL engine rather than a mock. The pure helpers below
// (makeTrampoline, transactionPlan, resultCodeName, coerceBoundValue, …) are exported for
// the same reason: see AGENTS.md on exporting for the spike rather than duplicating.

// ---- result codes ------------------------------------------------------------------

export const SQLITE_OK = 0;
export const SQLITE_ERROR = 1;
export const SQLITE_BUSY = 5;
export const SQLITE_NOMEM = 7;
export const SQLITE_IOERR = 10;
export const SQLITE_NOTFOUND = 12;
export const SQLITE_CANTOPEN = 14;
export const SQLITE_MISUSE = 21;
export const SQLITE_RANGE = 25;
export const SQLITE_ROW = 100;
export const SQLITE_DONE = 101;

const SQLITE_IOERR_SHORT_READ = 522;
const SQLITE_IOERR_WRITE = 778;
const SQLITE_IOERR_TRUNCATE = 1546;
const SQLITE_IOERR_FSTAT = 1802;
const SQLITE_IOERR_DELETE = 2570;

// open flags (sqlite3_open_v2 / xOpen)
const OPEN_READONLY = 0x00000001;
const OPEN_READWRITE = 0x00000002;
const OPEN_CREATE = 0x00000004;
const OPEN_DELETEONCLOSE = 0x00000008;
const OPEN_MAIN_DB = 0x00000100;

// column types
const SQLITE_INTEGER = 1;
const SQLITE_FLOAT = 2;
const SQLITE_TEXT = 3;
const SQLITE_BLOB = 4;
const SQLITE_NULL = 5;

// sqlite3_bind_text/blob destructor sentinel: copy the bytes, we own our scratch.
const SQLITE_TRANSIENT = -1;

// sqlite3_deserialize flags. https://www.sqlite.org/c3ref/c_deserialize_freeonclose.html
const DESERIALIZE_FREEONCLOSE = 1;
const DESERIALIZE_RESIZEABLE = 2;
const DESERIALIZE_READONLY = 4;

// The primary result codes, then the extended ones built by composition. An extended
// code is `primary | (subcode << 8)`, so the table below is the subcode lists and
// resultCodeName() does the arithmetic — which is both shorter than 90 literals and
// impossible to get subtly wrong in one entry.
const PRIMARY_NAMES = {
  0: "SQLITE_OK", 1: "SQLITE_ERROR", 2: "SQLITE_INTERNAL", 3: "SQLITE_PERM",
  4: "SQLITE_ABORT", 5: "SQLITE_BUSY", 6: "SQLITE_LOCKED", 7: "SQLITE_NOMEM",
  8: "SQLITE_READONLY", 9: "SQLITE_INTERRUPT", 10: "SQLITE_IOERR", 11: "SQLITE_CORRUPT",
  12: "SQLITE_NOTFOUND", 13: "SQLITE_FULL", 14: "SQLITE_CANTOPEN", 15: "SQLITE_PROTOCOL",
  16: "SQLITE_EMPTY", 17: "SQLITE_SCHEMA", 18: "SQLITE_TOOBIG", 19: "SQLITE_CONSTRAINT",
  20: "SQLITE_MISMATCH", 21: "SQLITE_MISUSE", 22: "SQLITE_NOLFS", 23: "SQLITE_AUTH",
  24: "SQLITE_FORMAT", 25: "SQLITE_RANGE", 26: "SQLITE_NOTADB", 27: "SQLITE_NOTICE",
  28: "SQLITE_WARNING", 100: "SQLITE_ROW", 101: "SQLITE_DONE",
};

// subcode -> suffix, per primary code. From sqlite3.h's SQLITE_*_* block.
const EXTENDED_SUFFIXES = {
  1: { 1: "MISSING_COLLSEQ", 2: "RETRY", 3: "SNAPSHOT" },
  5: { 1: "RECOVERY", 2: "SNAPSHOT", 3: "TIMEOUT" },
  6: { 1: "SHAREDCACHE", 2: "VTAB" },
  8: { 1: "RECOVERY", 2: "CANTLOCK", 3: "ROLLBACK", 4: "DBMOVED", 5: "CANTINIT", 6: "DIRECTORY" },
  10: {
    1: "READ", 2: "SHORT_READ", 3: "WRITE", 4: "FSYNC", 5: "DIR_FSYNC", 6: "TRUNCATE",
    7: "FSTAT", 8: "UNLOCK", 9: "RDLOCK", 10: "DELETE", 11: "BLOCKED", 12: "NOMEM",
    13: "ACCESS", 14: "CHECKRESERVEDLOCK", 15: "LOCK", 16: "CLOSE", 17: "DIR_CLOSE",
    18: "SHMOPEN", 19: "SHMSIZE", 20: "SHMLOCK", 21: "SHMMAP", 22: "SEEK",
    23: "DELETE_NOENT", 24: "MMAP", 25: "GETTEMPPATH", 26: "CONVPATH", 27: "VNODE",
    28: "AUTH", 29: "BEGIN_ATOMIC", 30: "COMMIT_ATOMIC", 31: "ROLLBACK_ATOMIC",
    32: "DATA", 33: "CORRUPTFS", 34: "IN_PAGE",
  },
  11: { 1: "VTAB", 2: "SEQUENCE", 3: "INDEX" },
  13: { 1: "VTAB" },
  14: { 1: "NOTEMPDIR", 2: "ISDIR", 3: "FULLPATH", 4: "CONVPATH", 5: "DIRTYWAL", 6: "SYMLINK" },
  19: {
    1: "CHECK", 2: "COMMITHOOK", 3: "FOREIGNKEY", 4: "FUNCTION", 5: "NOTNULL",
    6: "PRIMARYKEY", 7: "TRIGGER", 8: "UNIQUE", 9: "VTAB", 10: "ROWID", 11: "PINNED",
    12: "DATATYPE",
  },
  20: { 1: "VTAB" },
  23: { 1: "USER" },
  27: { 1: "RECOVER_WAL", 2: "RECOVER_ROLLBACK", 3: "RBU" },
  28: { 1: "AUTOINDEX" },
};

/**
 * SQLite result code (primary or extended) -> its symbolic name, e.g.
 * 2067 -> "SQLITE_CONSTRAINT_UNIQUE". This is what lands on SQLiteError.code, which
 * is the property applications actually branch on. An unrecognised subcode degrades
 * to the primary name rather than inventing one.
 */
export function resultCodeName(code) {
  const n = code | 0;
  const primary = n & 0xff;
  const base = PRIMARY_NAMES[primary];
  if (!base) return "SQLITE_UNKNOWN";
  const sub = n >> 8;
  if (!sub) return base;
  const suffix = EXTENDED_SUFFIXES[primary] && EXTENDED_SUFFIXES[primary][sub];
  return suffix ? base + "_" + suffix : base;
}

/**
 * Bun's SQLiteError: `code` is the symbolic name, `errno` is sqlite3_extended_errcode,
 * `byteOffset` is sqlite3_error_offset (-1 when not known). Applications branch on
 * `.code`; a plain Error breaks them, which is why this is a real class.
 */
export class SQLiteError extends Error {
  constructor(message, options) {
    super(message);
    this.name = "SQLiteError";
    const o = options || {};
    this.errno = o.errno | 0;
    this.code = o.code != null ? o.code : resultCodeName(this.errno);
    this.byteOffset = o.byteOffset == null ? -1 : o.byteOffset | 0;
  }
}

// ---- the JS -> wasm function-pointer trampoline --------------------------------------

// Emscripten signature letters: v void, i i32, j i64 (BigInt), f f32, d f64, p pointer
// (i32 under wasm32). First letter is the return type.
const WASM_TYPE = { i: 0x7f, p: 0x7f, j: 0x7e, f: 0x7d, d: 0x7c };

function uleb(n) {
  const out = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
}

/**
 * The bytes of a minimal wasm module that imports one function of signature `sig` as
 * "e"."f" and re-exports it as "f". Split out from makeTrampoline so the offline spike
 * can assert the encoding directly (a wrong byte here produces a wild indirect call
 * and a crash with no usable stack, which is exactly the kind of bug a unit test is
 * cheaper than).
 */
export function trampolineModuleBytes(sig) {
  if (typeof sig !== "string" || sig.length < 1) throw new TypeError("bad wasm signature: " + sig);
  const retChar = sig[0];
  if (retChar !== "v" && !WASM_TYPE[retChar]) throw new TypeError("bad return type in signature: " + sig);
  const params = [];
  for (let i = 1; i < sig.length; i++) {
    const t = WASM_TYPE[sig[i]];
    if (!t) throw new TypeError("bad param type in signature: " + sig);
    params.push(t);
  }
  const funcType = [0x60, ...uleb(params.length), ...params,
    ...(retChar === "v" ? [0] : [1, WASM_TYPE[retChar]])];
  const section = (id, body) => [id, ...uleb(body.length), ...body];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, // \0asm, version 1
    ...section(1, [1, ...funcType]), // type section: one func type
    ...section(2, [1, 1, 0x65, 1, 0x66, 0x00, 0]), // import "e"."f" -> func type 0
    ...section(7, [1, 1, 0x66, 0x00, 0]), // export "f" = func 0
  ]);
}

/** Wrap a JS function so it can be installed in a WebAssembly.Table. Synchronous. */
export function makeTrampoline(fn, sig) {
  const mod = new WebAssembly.Module(trampolineModuleBytes(sig));
  return new WebAssembly.Instance(mod, { e: { f: fn } }).exports.f;
}

// ---- struct layouts ------------------------------------------------------------------
//
// wasm32: pointers and ints are 4 bytes. Exported so the offline spike can pin the
// offsets: SQLite reads these structs by offset, so a single wrong field is an
// unrelated function being called through a function pointer.

/** sqlite3_io_methods, iVersion 1. https://www.sqlite.org/c3ref/io_methods.html */
export const IO_METHODS_FIELDS = [
  "xClose", "xRead", "xWrite", "xTruncate", "xSync", "xFileSize",
  "xLock", "xUnlock", "xCheckReservedLock", "xFileControl",
  "xSectorSize", "xDeviceCharacteristics",
];
export const IO_METHODS_SIZE = 4 + IO_METHODS_FIELDS.length * 4; // 52

/** sqlite3_vfs, iVersion 1. https://www.sqlite.org/c3ref/vfs.html */
export const VFS_METHOD_FIELDS = [
  "xOpen", "xDelete", "xAccess", "xFullPathname",
  "xDlOpen", "xDlError", "xDlSym", "xDlClose",
  "xRandomness", "xSleep", "xCurrentTime", "xGetLastError",
];
export const VFS_HEADER_SIZE = 24; // iVersion, szOsFile, mxPathname, pNext, zName, pAppData
export const VFS_SIZE = VFS_HEADER_SIZE + VFS_METHOD_FIELDS.length * 4; // 72

// Per-file state lives in a JS Map keyed by the sqlite3_file* pointer rather than being
// packed into the struct, so szOsFile only has to cover pMethods. 8 rather than 4 keeps
// the allocation 8-byte aligned for no meaningful cost.
const SZ_OS_FILE = 8;
const MAX_PATHNAME = 1024;
const SECTOR_SIZE = 4096;

// ---- value mapping -------------------------------------------------------------------

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * Classify a JS value for binding, per Bun's documented datatype table
 * (https://bun.com/docs/runtime/sqlite#datatypes). Returns { kind, value }; throws a
 * TypeError naming the type for anything not on that table, rather than String()-ing it
 * into the database — a silently stringified object is unrecoverable once written.
 *
 * `safeIntegers` only affects BigInt RANGE VALIDATION on the way in: Bun documents that
 * with safeIntegers on it "validates that bigint values do not exceed 64 bits".
 */
export function coerceBoundValue(value, safeIntegers) {
  if (value === null || value === undefined) return { kind: "null" };
  const t = typeof value;
  if (t === "boolean") return { kind: "int", value: value ? 1n : 0n };
  if (t === "number") {
    return Number.isInteger(value)
      ? { kind: "int", value: BigInt(value) }
      : { kind: "double", value };
  }
  if (t === "bigint") {
    if (value < INT64_MIN || value > INT64_MAX) {
      // Message shape follows Bun's: "BigInt value '<n>' is out of range".
      throw new RangeError("BigInt value '" + value.toString() + "' is out of range");
    }
    return { kind: "int", value };
  }
  if (t === "string") return { kind: "text", value };
  if (value instanceof Uint8Array) return { kind: "blob", value };
  if (ArrayBuffer.isView(value)) {
    return { kind: "blob", value: new Uint8Array(value.buffer, value.byteOffset, value.byteLength) };
  }
  if (value instanceof ArrayBuffer) return { kind: "blob", value: new Uint8Array(value) };
  throw new TypeError(
    "bun:sqlite cannot bind a value of type " +
      (t === "object" ? Object.prototype.toString.call(value) : t) +
      ". Supported: string, number, bigint, boolean, null, Uint8Array/Buffer/ArrayBuffer.",
  );
}

/**
 * A 64-bit column value as Bun would return it.
 *
 * With safeIntegers off (Bun's default) Bun "returns integers as number types and
 * truncates any bits beyond 53". Number(bigint) is exactly that conversion: Bun's own
 * documented example round-trips 9007199254741093n to 9007199254741092, which is what
 * Number(9007199254741093n) produces. So this matches Bun including in the lossy case
 * — which is the point, since code written against Bun has already absorbed that loss.
 */
export function readInteger(value, safeIntegers) {
  return safeIntegers ? value : Number(value);
}

// ---- transactions --------------------------------------------------------------------

/**
 * The exact SQL a transaction at `depth` should run. Depth 0 is a real transaction;
 * deeper is a SAVEPOINT, which is what makes nesting correct — a flat BEGIN/COMMIT
 * would have an inner rollback discard the outer transaction's committed work.
 *
 * The BEGIN spellings are Bun's documented ones: a bare call uses "BEGIN", and
 * `.deferred` explicitly uses "BEGIN DEFERRED" (identical to SQLite, different text).
 *
 * ROLLBACK TO alone would leave the savepoint on the stack, so the failure path is
 * both statements. https://www.sqlite.org/lang_savepoint.html
 */
export function transactionPlan(kind, depth) {
  if (depth > 0) {
    const name = "_bun_sqlite_sp_" + depth;
    return {
      begin: "SAVEPOINT " + name,
      commit: "RELEASE " + name,
      rollback: ["ROLLBACK TO " + name, "RELEASE " + name],
    };
  }
  const begin =
    kind === "deferred" ? "BEGIN DEFERRED"
      : kind === "immediate" ? "BEGIN IMMEDIATE"
        : kind === "exclusive" ? "BEGIN EXCLUSIVE"
          : "BEGIN";
  return { begin, commit: "COMMIT", rollback: ["ROLLBACK"] };
}

// ---- parameter binding plan ----------------------------------------------------------

/**
 * Decide how a Statement's `...params` map onto SQLite's 1-based parameter slots.
 *
 * Bun's rule: a single plain-object argument is a NAMED binding, anything else is
 * positional. `names` is sqlite3_bind_parameter_name() per slot ("$foo", ":foo", "@foo",
 * or "" for a bare `?`).
 *
 * strict mode (Bun's `strict: true`) changes two things at once, and both matter:
 * keys are written WITHOUT the sigil, and a parameter the object does not supply is an
 * error. Non-strict keeps the sigil and leaves an unsupplied parameter unbound, which
 * SQLite reads as NULL — Bun documents exactly this asymmetry with a typo example.
 */
export function planBindings(params, names, strict) {
  const single = params.length === 1 ? params[0] : undefined;
  const isNamed =
    params.length === 1 &&
    single !== null &&
    typeof single === "object" &&
    !Array.isArray(single) &&
    !ArrayBuffer.isView(single) &&
    !(single instanceof ArrayBuffer);

  const plan = [];
  if (!isNamed) {
    for (let i = 0; i < params.length; i++) plan.push({ index: i + 1, value: params[i] });
    return plan;
  }

  for (let i = 0; i < names.length; i++) {
    const raw = names[i];
    if (!raw) continue; // a bare `?` cannot be addressed by name
    const bare = raw.slice(1);
    const key = strict ? bare : raw;
    if (Object.prototype.hasOwnProperty.call(single, key)) {
      plan.push({ index: i + 1, value: single[key] });
    } else if (strict) {
      throw new SQLiteError("Missing parameter \"" + bare + "\"", {
        errno: SQLITE_ERROR,
        code: "SQLITE_ERROR",
      });
    }
  }
  return plan;
}

// ---- the engine ----------------------------------------------------------------------

// What we supply in the `env` / `wasi_snapshot_preview1` import objects. Exported so
// scripts/vendor-sqlite.mjs can assert that a refreshed upstream build has not grown an
// import we do not provide — otherwise that surfaces as a LinkError at the user's first
// `new Database()`, which is a terrible place to discover it.
export const ENGINE_IMPORT_NAMES = {
  env: [
    "memory",
    "emscripten_date_now", "emscripten_get_now", "emscripten_get_heap_max",
    "emscripten_resize_heap", "_localtime_js", "_tzset_js", "_mmap_js", "_munmap_js",
    "__syscall_chmod", "__syscall_faccessat", "__syscall_fchmod", "__syscall_fchown32",
    "__syscall_fcntl64", "__syscall_fstat64", "__syscall_ftruncate64", "__syscall_getcwd",
    "__syscall_ioctl", "__syscall_lstat64", "__syscall_mkdirat", "__syscall_newfstatat",
    "__syscall_openat", "__syscall_readlinkat", "__syscall_rmdir", "__syscall_stat64",
    "__syscall_unlinkat", "__syscall_utimensat",
  ],
  wasi_snapshot_preview1: [
    "clock_time_get", "environ_get", "environ_sizes_get", "fd_close", "fd_fdstat_get",
    "fd_read", "fd_seek", "fd_sync", "fd_write",
  ],
};

/**
 * The memory the module declares it needs: 128 pages (8 MB) minimum, 32768 (2 GB)
 * maximum, unshared. We create it rather than letting the module export one, because
 * this build imports `env.memory`. Supplying a SHARED memory would be a LinkError (the
 * declared limits are unshared), and supplying a smaller initial size would be one too.
 */
export const ENGINE_MEMORY = { initial: 128, maximum: 32768 };

const ENOSYS = -38;

/**
 * Compile + instantiate the engine and install the VFS. Everything is synchronous.
 *
 * `host` is the injection seam:
 *   fs      node:fs-shaped, synchronous: openSync/readSync/writeSync/closeSync/
 *           fstatSync/ftruncateSync/existsSync/unlinkSync. Vivari's guest `fs` and
 *           Node's both satisfy it — deliberately, so the CI spike drives this code.
 *   path    posix resolve/dirname
 *   cwd()   the process working directory, so `new Database("./app.db")` lands next to
 *           the user's source and not at "/"
 *   randomBytes(n) -> Uint8Array, for xRandomness
 *   tmpDir  where SQLite's unnamed transient files go (default "/tmp")
 */
export function createSqliteEngine(bytes, host) {
  const { fs, path, cwd, randomBytes } = host;
  const tmpDir = host.tmpDir || "/tmp";

  const module = new WebAssembly.Module(bytes);
  const memory = new WebAssembly.Memory(ENGINE_MEMORY);

  // emscripten_resize_heap detaches memory.buffer, invalidating every view over it.
  // Comparing against the last-seen ArrayBuffer identity is exact and costs a pointer
  // compare; caching the views without this check is a silent-corruption bug that only
  // shows up once a database is big enough to grow the heap.
  let lastBuffer = null;
  let cachedU8 = null;
  let cachedDv = null;
  function refresh() {
    lastBuffer = memory.buffer;
    cachedU8 = new Uint8Array(lastBuffer);
    cachedDv = new DataView(lastBuffer);
  }
  function u8() {
    if (memory.buffer !== lastBuffer) refresh();
    return cachedU8;
  }
  function dv() {
    if (memory.buffer !== lastBuffer) refresh();
    return cachedDv;
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const env = {
    memory,
    emscripten_date_now: () => Date.now(),
    emscripten_get_now: () =>
      typeof performance !== "undefined" && performance.now ? performance.now() : Date.now(),
    emscripten_get_heap_max: () => ENGINE_MEMORY.maximum * 65536,
    emscripten_resize_heap: (requested) => {
      const current = memory.buffer.byteLength;
      const target = requested >>> 0;
      if (target <= current) return 1;
      try {
        memory.grow(Math.ceil((target - current) / 65536));
        return 1;
      } catch {
        return 0; // SQLite turns this into SQLITE_NOMEM
      }
    },
    _localtime_js: () => {},
    _tzset_js: () => {},
    // SQLite only reaches for mmap through an iVersion>=3 VFS's xFetch/xUnfetch, which
    // we do not provide, so these are unreachable in practice. Returning ENOSYS rather
    // than 0 keeps a future reachable path loud instead of silently mapping nothing.
    _mmap_js: () => ENOSYS,
    _munmap_js: () => ENOSYS,
  };
  // The Emscripten filesystem layer these belong to is dead code once our VFS is the
  // default (verified: none of them is called during a full create/insert/select/close
  // cycle). They exist to satisfy the import list.
  for (const name of ENGINE_IMPORT_NAMES.env) {
    if (name.startsWith("__syscall_")) env[name] = () => ENOSYS;
  }

  const wasi = {
    clock_time_get: (id, precision, pOut) => {
      dv().setBigUint64(pOut, BigInt(Date.now()) * 1000000n, true);
      return 0;
    },
    environ_get: () => 0,
    environ_sizes_get: (pCount, pSize) => {
      const view = dv();
      view.setUint32(pCount, 0, true);
      view.setUint32(pSize, 0, true);
      return 0;
    },
    fd_close: () => 0,
    fd_fdstat_get: () => ENOSYS,
    fd_read: () => ENOSYS,
    fd_seek: () => ENOSYS,
    fd_sync: () => 0,
    // SQLite writes to stderr only on an internal panic (SQLITE_MISUSE-class bugs and
    // assertion output). Surfacing it is how such a thing stops being invisible.
    fd_write: (fd, iov, cnt, pWritten) => {
      const view = dv();
      let total = 0;
      let text = "";
      for (let i = 0; i < cnt; i++) {
        const ptr = view.getUint32(iov + i * 8, true);
        const len = view.getUint32(iov + i * 8 + 4, true);
        text += decoder.decode(u8().subarray(ptr, ptr + len));
        total += len;
      }
      if (text.trim() && typeof console !== "undefined") {
        console.error("bun:sqlite [engine]: " + text.trimEnd());
      }
      view.setUint32(pWritten, total, true);
      return 0;
    },
  };

  const instance = new WebAssembly.Instance(module, { env, wasi_snapshot_preview1: wasi });
  const E = instance.exports;
  E.__wasm_call_ctors();

  const table = E.__indirect_function_table;
  function installFunction(fn, sig) {
    const index = table.length;
    table.grow(1);
    table.set(index, makeTrampoline(fn, sig));
    return index;
  }

  // ---- heap helpers ----
  function readCString(ptr) {
    if (!ptr) return null;
    const heap = u8();
    let end = ptr;
    while (heap[end]) end++;
    return decoder.decode(heap.subarray(ptr, end));
  }
  function allocCString(str) {
    const b = encoder.encode(str);
    const ptr = E.malloc(b.length + 1);
    if (!ptr) throw new SQLiteError("out of memory allocating " + (b.length + 1) + " bytes", { errno: SQLITE_NOMEM });
    const heap = u8();
    heap.set(b, ptr);
    heap[ptr + b.length] = 0;
    return ptr;
  }
  function allocBytes(bytesIn) {
    const ptr = E.malloc(Math.max(1, bytesIn.length));
    if (!ptr) throw new SQLiteError("out of memory allocating " + bytesIn.length + " bytes", { errno: SQLITE_NOMEM });
    u8().set(bytesIn, ptr);
    return ptr;
  }

  // ---- the VFS ----

  // pFile pointer -> { fd, path, deleteOnClose }
  const openFiles = new Map();
  let transientSeq = 0;

  function fileFor(pFile) {
    const handle = openFiles.get(pFile);
    if (!handle) throw new Error("bun:sqlite internal: unknown sqlite3_file " + pFile);
    return handle;
  }

  const ioImpl = {
    xClose: (pFile) => {
      const handle = openFiles.get(pFile);
      if (!handle) return SQLITE_OK;
      openFiles.delete(pFile);
      try {
        fs.closeSync(handle.fd);
      } catch {
        /* already gone */
      }
      if (handle.deleteOnClose) {
        try {
          fs.unlinkSync(handle.path);
        } catch {
          /* nothing to remove */
        }
      }
      return SQLITE_OK;
    },

    xRead: (pFile, pBuf, iAmt, iOfst) => {
      const handle = fileFor(pFile);
      const want = iAmt | 0;
      const buf = new Uint8Array(want);
      let got;
      try {
        got = fs.readSync(handle.fd, buf, 0, want, Number(iOfst));
      } catch {
        return SQLITE_IOERR;
      }
      const heap = u8();
      heap.set(got < want ? buf.subarray(0, got) : buf, pBuf);
      if (got < want) {
        // SQLite REQUIRES the tail be zeroed and SHORT_READ returned; it relies on
        // both to distinguish "file ends here" from an I/O failure.
        heap.fill(0, pBuf + got, pBuf + want);
        return SQLITE_IOERR_SHORT_READ;
      }
      return SQLITE_OK;
    },

    xWrite: (pFile, pBuf, iAmt, iOfst) => {
      const handle = fileFor(pFile);
      const want = iAmt | 0;
      try {
        // The view is taken immediately before the call: nothing between here and the
        // syscall re-enters wasm, so the heap cannot move underneath it.
        const wrote = fs.writeSync(handle.fd, u8().subarray(pBuf, pBuf + want), 0, want, Number(iOfst));
        if (wrote !== want) return SQLITE_IOERR_WRITE;
      } catch {
        return SQLITE_IOERR_WRITE;
      }
      return SQLITE_OK;
    },

    xTruncate: (pFile, size) => {
      const handle = fileFor(pFile);
      const n = Number(size);
      // Vivari's ftruncate syscall encodes its length as u32 (packages/runtime/
      // fs-client.js:137 -> packages/vfs/src/lib.rs), so a >=4 GiB truncate would
      // silently wrap to a much smaller file. Refuse instead of corrupting.
      if (n > 0xffffffff) return SQLITE_IOERR_TRUNCATE;
      try {
        fs.ftruncateSync(handle.fd, n);
      } catch {
        return SQLITE_IOERR_TRUNCATE;
      }
      return SQLITE_OK;
    },

    // No durability primitive exists — see the header. Returning SQLITE_OK is the only
    // option that is not a deadlock; the honesty lives in the docs, not in a fake sync.
    xSync: () => SQLITE_OK,

    xFileSize: (pFile, pSize) => {
      const handle = fileFor(pFile);
      let size;
      try {
        size = fs.fstatSync(handle.fd).size;
      } catch {
        return SQLITE_IOERR_FSTAT;
      }
      dv().setBigInt64(pSize, BigInt(size), true);
      return SQLITE_OK;
    },

    // No locking primitive in the runtime. Matches the upstream build's own default
    // `unix-none` VFS; see the header.
    xLock: () => SQLITE_OK,
    xUnlock: () => SQLITE_OK,
    xCheckReservedLock: (pFile, pResOut) => {
      dv().setInt32(pResOut, 0, true);
      return SQLITE_OK;
    },

    // SQLITE_NOTFOUND is the documented "this VFS does not handle that opcode" answer
    // and SQLite depends on it: returning SQLITE_OK would claim we honoured a control
    // we ignored. https://www.sqlite.org/c3ref/file_control.html
    xFileControl: () => SQLITE_NOTFOUND,

    xSectorSize: () => SECTOR_SIZE,
    // Deliberately 0: see the header on why claiming SAFE_APPEND / POWERSAFE_OVERWRITE
    // on top of a no-op xSync compounds the problem.
    xDeviceCharacteristics: () => 0,
  };

  const IO_SIGNATURES = {
    xClose: "ii", xRead: "iiiij", xWrite: "iiiij", xTruncate: "iij", xSync: "iii",
    xFileSize: "iii", xLock: "iii", xUnlock: "iii", xCheckReservedLock: "iii",
    xFileControl: "iiii", xSectorSize: "ii", xDeviceCharacteristics: "ii",
  };

  const pIoMethods = E.malloc(IO_METHODS_SIZE);
  u8().fill(0, pIoMethods, pIoMethods + IO_METHODS_SIZE);
  dv().setInt32(pIoMethods, 1, true); // iVersion
  IO_METHODS_FIELDS.forEach((name, i) => {
    dv().setInt32(pIoMethods + 4 + i * 4, installFunction(ioImpl[name], IO_SIGNATURES[name]), true);
  });

  function resolvePath(p) {
    return path.resolve(cwd() || "/", p);
  }

  const vfsImpl = {
    xOpen: (pVfs, zName, pFile, flags, pOutFlags) => {
      let target = zName ? readCString(zName) : null;
      let deleteOnClose = (flags & OPEN_DELETEONCLOSE) !== 0;
      if (target == null) {
        // A NULL name is a transient file (temp b-tree for a large sort, a statement
        // journal). SQLite deletes it on close; we own picking where it lives.
        transientSeq += 1;
        target = tmpDir + "/vv-sqlite-tmp-" + Date.now().toString(36) + "-" + transientSeq;
        deleteOnClose = true;
      } else {
        target = resolvePath(target);
      }

      const readonly = (flags & OPEN_READONLY) !== 0;
      const create = (flags & OPEN_CREATE) !== 0;
      let exists = false;
      try {
        exists = fs.existsSync(target);
      } catch {
        exists = false;
      }
      if (!exists && !create) return SQLITE_CANTOPEN;

      let fd;
      try {
        // "w+" only when creating something that is not there: it truncates, and using
        // it on an existing database is a data-loss bug that reads back as an empty but
        // byte-valid file. Everything else opens positionally read/write ("r+"); never
        // append mode, since every read and write here carries an explicit offset.
        fd = fs.openSync(target, readonly ? "r" : exists ? "r+" : "w+");
      } catch {
        return SQLITE_CANTOPEN;
      }

      openFiles.set(pFile, { fd, path: target, deleteOnClose });
      dv().setInt32(pFile, pIoMethods, true); // sqlite3_file.pMethods
      if (pOutFlags) {
        dv().setInt32(pOutFlags, readonly ? OPEN_READONLY : OPEN_READWRITE, true);
      }
      if ((flags & OPEN_MAIN_DB) !== 0 && typeof host.onOpenDatabase === "function") {
        host.onOpenDatabase(target);
      }
      return SQLITE_OK;
    },

    xDelete: (pVfs, zName) => {
      const target = resolvePath(readCString(zName));
      try {
        fs.unlinkSync(target);
      } catch (e) {
        // A missing file is success, per the VFS contract; anything else is an error.
        if (e && (e.code === "ENOENT" || e.code === "MODULE_NOT_FOUND")) return SQLITE_OK;
        try {
          if (!fs.existsSync(target)) return SQLITE_OK;
        } catch {
          /* fall through */
        }
        return SQLITE_IOERR_DELETE;
      }
      return SQLITE_OK;
    },

    // All three access modes (EXISTS / READWRITE / READ) collapse to an existence
    // check: the VFS has a mode field but no per-user permission model, so a readable
    // file is a writable file. Honest, and harmless here.
    xAccess: (pVfs, zName, flags, pResOut) => {
      let ok = false;
      try {
        ok = fs.existsSync(resolvePath(readCString(zName)));
      } catch {
        ok = false;
      }
      dv().setInt32(pResOut, ok ? 1 : 0, true);
      return SQLITE_OK;
    },

    // Resolving against the PROCESS cwd is what makes `new Database("./app.db")` create
    // the file next to the user's source rather than at the VFS root.
    xFullPathname: (pVfs, zName, nOut, zOut) => {
      const full = resolvePath(readCString(zName));
      const b = encoder.encode(full);
      if (b.length + 1 > nOut) return SQLITE_CANTOPEN;
      const heap = u8();
      heap.set(b, zOut);
      heap[zOut + b.length] = 0;
      return SQLITE_OK;
    },

    xRandomness: (pVfs, nByte, zOut) => {
      const n = nByte | 0;
      u8().set(randomBytes(n).subarray(0, n), zOut);
      return n;
    },

    // Only ever called while retrying a contended lock, which cannot happen without
    // locking. Return 0 rather than busy-waiting: burning a whole process worker inside
    // a VFS callback would be worse than not sleeping.
    xSleep: () => 0,

    xCurrentTime: (pVfs, pOut) => {
      dv().setFloat64(pOut, Date.now() / 86400000 + 2440587.5, true);
      return SQLITE_OK;
    },

    xGetLastError: () => SQLITE_OK,
  };

  const VFS_SIGNATURES = {
    xOpen: "iiiiii", xDelete: "iiii", xAccess: "iiiii", xFullPathname: "iiiii",
    xRandomness: "iiii", xSleep: "iii", xCurrentTime: "iii", xGetLastError: "iiii",
  };

  const pVfs = E.malloc(VFS_SIZE);
  u8().fill(0, pVfs, pVfs + VFS_SIZE);
  dv().setInt32(pVfs + 0, 1, true); // iVersion — 1, no xShm* (see the header on WAL)
  dv().setInt32(pVfs + 4, SZ_OS_FILE, true);
  dv().setInt32(pVfs + 8, MAX_PATHNAME, true);
  dv().setInt32(pVfs + 16, allocCString("vivari"), true); // zName
  VFS_METHOD_FIELDS.forEach((name, i) => {
    // xDlOpen/xDlError/xDlSym/xDlClose stay NULL. That is what tells SQLite extension
    // loading is unavailable, and it is why .loadExtension() cannot be made to work
    // rather than merely being unimplemented.
    const impl = vfsImpl[name];
    if (!impl) return;
    dv().setInt32(pVfs + VFS_HEADER_SIZE + i * 4, installFunction(impl, VFS_SIGNATURES[name]), true);
  });

  const initRc = E.sqlite3_initialize();
  if (initRc !== SQLITE_OK) {
    throw new SQLiteError("sqlite3_initialize() failed", { errno: initRc });
  }
  const regRc = E.sqlite3_vfs_register(pVfs, 1);
  if (regRc !== SQLITE_OK) {
    throw new SQLiteError("sqlite3_vfs_register() failed", { errno: regRc });
  }

  return {
    exports: E,
    memory,
    u8,
    dv,
    readCString,
    allocCString,
    allocBytes,
    version: readCString(E.sqlite3_libversion()),
    vfsName: "vivari",
    openFileCount: () => openFiles.size,
  };
}

// ---- resolving the engine bytes inside a Vivari guest ----------------------------------

// Where a project-installed engine would live, if the user installed one. Only the
// `.wasm` is used from either package; both ship glue we do not run.
const PROJECT_ENGINES = [
  "@sqlite.org/sqlite-wasm/sqlite-wasm/jswasm/sqlite3.wasm",
  "@sqlite.org/sqlite-wasm/dist/sqlite3.wasm",
  "sql.js/dist/sql-wasm.wasm",
];

function engineMissingError(detail) {
  return new Error(
    "bun:sqlite could not load a SQLite engine: " + detail + "\n" +
      "This build ships one at packages/runtime/vendor/sqlite/sqlite3.wasm, delivered to " +
      "the browser by `npm run vendor:sqlite` (part of predev / prebuild:studio). If you " +
      "are embedding Vivari, either run that step and rebuild, or point " +
      "VV_SQLITE_WASM_PATH at a sqlite3.wasm inside the VFS.",
  );
}

/**
 * The Vivari-side half of the bun:sqlite host: where the wasm comes from, and which fs
 * the VFS talks to. Everything here is LAZY — this function only builds the descriptor,
 * so importing bun:sqlite (or merely running a `bun` process, which registers the module
 * unconditionally) costs nothing until a Database is actually constructed.
 *
 * Engine resolution order, highest precedence first:
 *
 *   1. VV_SQLITE_WASM_PATH — an explicit path to a sqlite3.wasm in the VFS. The embedder
 *      escape hatch, and how the kernel-tier spike supplies the engine offline. If it is
 *      set and unloadable we THROW rather than falling through: a silent fallback would
 *      make an override look like it worked.
 *   2. A project-installed engine, resolved from the process's CWD. This is what the old
 *      shim's `bun add @sqlite.org/sqlite-wasm` advice was trying to do and could not —
 *      it searched from "/", where a project's node_modules is not on the path.
 *   3. VV_SQLITE_WASM_URL — the same-origin vendored artifact the kernel points at. The
 *      DEFAULT, and the one that makes `import { Database } from "bun:sqlite"` work with
 *      no install, which is the actual contract: in real Bun there is nothing to install.
 *      Fetched through the blocking OP_FETCH syscall, which parks the caller on
 *      Atomics.wait while the kernel streams the body into the VFS — so it is
 *      synchronous from the guest's point of view and bypasses the 1 MiB SAB window.
 */
export function createVivariSqliteHost({ require, makeCwdRequire, process }) {
  let cachedFs = null;
  let cachedPath = null;
  const nodeFs = () => (cachedFs || (cachedFs = require("fs")));
  const nodePath = () => (cachedPath || (cachedPath = require("path")));

  function readFromPath(p) {
    const buf = nodeFs().readFileSync(p);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  function resolveEngineBytes() {
    const env = (process && process.env) || {};

    const explicit = env.VV_SQLITE_WASM_PATH;
    if (explicit) {
      try {
        return readFromPath(explicit);
      } catch (e) {
        throw engineMissingError(
          "VV_SQLITE_WASM_PATH is set to " + JSON.stringify(explicit) +
            " but it could not be read (" + ((e && e.message) || e) + ").",
        );
      }
    }

    // A project-installed engine, found from the CWD. The CWD-rooted require is the fix
    // for the resolution bug described above; without it this branch can never match,
    // because the root require only ever sees /node_modules.
    const resolver = (makeCwdRequire && makeCwdRequire()) || require;
    if (resolver && typeof resolver.resolve === "function") {
      for (const spec of PROJECT_ENGINES) {
        let resolved = null;
        try {
          resolved = resolver.resolve(spec);
        } catch {
          continue;
        }
        try {
          return readFromPath(resolved);
        } catch {
          /* resolved but unreadable — try the next candidate */
        }
      }
    }

    const url = env.VV_SQLITE_WASM_URL;
    if (!url) {
      throw engineMissingError("VV_SQLITE_WASM_URL is not set and no engine is installed in the project.");
    }
    const fetchSync = globalThis.__ocfetch;
    if (typeof fetchSync !== "function") {
      throw engineMissingError(
        "VV_SQLITE_WASM_URL is set to " + JSON.stringify(url) +
          " but this process has no synchronous fetch syscall to retrieve it with.",
      );
    }
    let meta;
    try {
      meta = fetchSync(url);
    } catch (e) {
      throw engineMissingError(
        "fetching " + JSON.stringify(url) + " failed (" + ((e && e.message) || e) + ").",
      );
    }
    if (!meta || !meta.ok) {
      throw engineMissingError(
        "fetching " + JSON.stringify(url) + " returned HTTP " + ((meta && meta.status) || "?") +
          ". The vendor step did not run for this build.",
      );
    }
    return readFromPath(meta.path);
  }

  return {
    get fs() {
      return nodeFs();
    },
    get path() {
      return nodePath();
    },
    cwd: () => (process && process.cwd ? process.cwd() : "/"),
    randomBytes: (n) => {
      const out = new Uint8Array(n);
      const c = globalThis.crypto;
      if (c && typeof c.getRandomValues === "function") {
        // getRandomValues caps at 65536 bytes per call; SQLite asks for 8-32, but the
        // loop costs nothing and removes the cliff.
        for (let off = 0; off < n; off += 65536) {
          c.getRandomValues(out.subarray(off, Math.min(n, off + 65536)));
        }
        return out;
      }
      for (let i = 0; i < n; i++) out[i] = (Math.random() * 256) | 0;
      return out;
    },
    // /tmp is guaranteed to exist by the kernel and is excluded from OPFS persistence,
    // which is exactly right for SQLite's transient files.
    tmpDir: "/tmp",
    resolveEngineBytes,
  };
}

// ---- Database / Statement -------------------------------------------------------------

let warnedWal = false;

function warnOnceAboutWal(sql) {
  if (warnedWal) return;
  if (sql.length > 400 || !/journal_mode/i.test(sql)) return;
  if (!/journal_mode\s*=\s*'?"?wal/i.test(sql)) return;
  warnedWal = true;
  if (typeof console !== "undefined" && console.warn) {
    console.warn(
      "bun:sqlite (Vivari): WAL mode requires a shared-memory VFS (xShmMap), which the " +
        "browser sandbox does not provide — the database stays in DELETE journal mode. " +
        "SQLite reports the mode actually in effect, so `PRAGMA journal_mode` will keep " +
        "returning \"delete\". See https://www.sqlite.org/wal.html for what this costs.",
    );
  }
}

const UNSUPPORTED = (api, why) =>
  new Error(
    "Database." + api + " is not supported in Vivari (browser sandbox): " + why,
  );

/**
 * Build the `bun:sqlite` module. `resolveEngine()` is called at most once per process,
 * on the first `new Database()`, and returns the engine bytes — that is where the
 * laziness lives.
 */
export function createBunSqlite(host) {
  let engine = null;

  function getEngine() {
    if (engine) return engine;
    engine = createSqliteEngine(host.resolveEngineBytes(), host);
    return engine;
  }

  function throwSqlite(E, pDb, fallbackMessage) {
    const errno = pDb ? E.sqlite3_extended_errcode(pDb) : SQLITE_ERROR;
    const message = pDb ? engine.readCString(E.sqlite3_errmsg(pDb)) : fallbackMessage;
    const byteOffset = pDb && E.sqlite3_error_offset ? E.sqlite3_error_offset(pDb) : -1;
    throw new SQLiteError(message || fallbackMessage || "SQLite error", { errno, byteOffset });
  }

  class Statement {
    constructor(db, sql, pStmt) {
      this._db = db;
      this._pStmt = pStmt;
      this._sql = sql;
      this._safeIntegers = db._safeIntegers;
      this._strict = db._strict;
      this._class = null;
      this._finalized = false;
      this._columnTypes = null;
    }

    get _E() {
      return this._db._E;
    }

    _check() {
      if (this._finalized) {
        throw new SQLiteError("Statement has been finalized", { errno: SQLITE_MISUSE });
      }
      this._db._check();
    }

    // Bind + reset. Always reset+clear first: a cached Statement is documented to be
    // safely reusable with fresh parameters, and a leftover binding from the previous
    // call is precisely the bug that makes "it worked the first time" reports.
    _bind(params) {
      const E = this._E;
      const p = this._pStmt;
      E.sqlite3_reset(p);
      E.sqlite3_clear_bindings(p);
      if (!params.length) return;

      const count = E.sqlite3_bind_parameter_count(p);
      const names = [];
      for (let i = 1; i <= count; i++) {
        names.push(engine.readCString(E.sqlite3_bind_parameter_name(p, i)) || "");
      }
      const plan = planBindings(params, names, this._strict);
      for (const { index, value } of plan) {
        const bound = coerceBoundValue(value, this._safeIntegers);
        let rc;
        if (bound.kind === "null") {
          rc = E.sqlite3_bind_null(p, index);
        } else if (bound.kind === "int") {
          rc = E.sqlite3_bind_int64(p, index, bound.value);
        } else if (bound.kind === "double") {
          rc = E.sqlite3_bind_double(p, index, bound.value);
        } else if (bound.kind === "text") {
          const b = new TextEncoder().encode(bound.value);
          const ptr = engine.allocBytes(b);
          try {
            rc = E.sqlite3_bind_text(p, index, ptr, b.length, SQLITE_TRANSIENT);
          } finally {
            E.free(ptr);
          }
        } else {
          const ptr = engine.allocBytes(bound.value);
          try {
            rc = E.sqlite3_bind_blob(p, index, ptr, bound.value.length, SQLITE_TRANSIENT);
          } finally {
            E.free(ptr);
          }
        }
        if (rc !== SQLITE_OK) throwSqlite(E, this._db._pDb, "bind failed at parameter " + index);
      }
    }

    _readColumn(i) {
      const E = this._E;
      const p = this._pStmt;
      const type = E.sqlite3_column_type(p, i);
      if (type === SQLITE_INTEGER) return readInteger(E.sqlite3_column_int64(p, i), this._safeIntegers);
      if (type === SQLITE_FLOAT) return E.sqlite3_column_double(p, i);
      if (type === SQLITE_NULL) return null;
      if (type === SQLITE_TEXT) {
        // _text before _bytes: the docs are explicit that the conversion can change the
        // byte count, so reading the length first can truncate.
        const ptr = E.sqlite3_column_text(p, i);
        const len = E.sqlite3_column_bytes(p, i);
        return new TextDecoder().decode(engine.u8().subarray(ptr, ptr + len));
      }
      const ptr = E.sqlite3_column_blob(p, i);
      const len = E.sqlite3_column_bytes(p, i);
      // A copy, not a view: the pointer is invalidated by the next step/reset, and a
      // view would silently start reading someone else's bytes.
      return engine.u8().slice(ptr, ptr + len);
    }

    _columnNames() {
      const E = this._E;
      const n = E.sqlite3_column_count(this._pStmt);
      const names = new Array(n);
      for (let i = 0; i < n; i++) names[i] = engine.readCString(E.sqlite3_column_name(this._pStmt, i));
      return names;
    }

    _rowObject(names) {
      const row = this._class ? Object.create(this._class.prototype) : {};
      for (let i = 0; i < names.length; i++) row[names[i]] = this._readColumn(i);
      return row;
    }

    _rowArray(n) {
      const row = new Array(n);
      for (let i = 0; i < n; i++) row[i] = this._readColumn(i);
      return row;
    }

    _rememberTypes() {
      const E = this._E;
      const n = E.sqlite3_column_count(this._pStmt);
      const types = new Array(n);
      for (let i = 0; i < n; i++) {
        const t = E.sqlite3_column_type(this._pStmt, i);
        types[i] =
          t === SQLITE_INTEGER ? "INTEGER"
            : t === SQLITE_FLOAT ? "FLOAT"
              : t === SQLITE_TEXT ? "TEXT"
                : t === SQLITE_BLOB ? "BLOB"
                  : "NULL";
      }
      this._columnTypes = types;
    }

    _step() {
      const E = this._E;
      const rc = E.sqlite3_step(this._pStmt);
      if (rc !== SQLITE_ROW && rc !== SQLITE_DONE) {
        E.sqlite3_reset(this._pStmt);
        throwSqlite(E, this._db._pDb, "step failed");
      }
      return rc;
    }

    all(...params) {
      this._check();
      this._bind(params);
      const names = this._columnNames();
      const rows = [];
      let first = true;
      try {
        while (this._step() === SQLITE_ROW) {
          if (first) {
            this._rememberTypes();
            first = false;
          }
          rows.push(this._rowObject(names));
        }
      } finally {
        this._E.sqlite3_reset(this._pStmt);
      }
      return rows;
    }

    // Bun documents `.get()` as returning null (not undefined) when there are no rows.
    get(...params) {
      this._check();
      this._bind(params);
      try {
        if (this._step() !== SQLITE_ROW) return null;
        this._rememberTypes();
        return this._rowObject(this._columnNames());
      } finally {
        this._E.sqlite3_reset(this._pStmt);
      }
    }

    values(...params) {
      this._check();
      this._bind(params);
      const n = this._E.sqlite3_column_count(this._pStmt);
      const rows = [];
      let first = true;
      try {
        while (this._step() === SQLITE_ROW) {
          if (first) {
            this._rememberTypes();
            first = false;
          }
          rows.push(this._rowArray(n));
        }
      } finally {
        this._E.sqlite3_reset(this._pStmt);
      }
      return rows;
    }

    run(...params) {
      this._check();
      this._bind(params);
      try {
        while (this._step() === SQLITE_ROW) {
          /* a run() over a SELECT still has to drain it */
        }
      } finally {
        this._E.sqlite3_reset(this._pStmt);
      }
      return this._db._changes();
    }

    // A real lazy generator over sqlite3_step, not all() with an iterator bolted on:
    // the entire reason to reach for .iterate() is not materialising the result set.
    *iterate(...params) {
      this._check();
      this._bind(params);
      const names = this._columnNames();
      let first = true;
      try {
        while (this._step() === SQLITE_ROW) {
          if (first) {
            this._rememberTypes();
            first = false;
          }
          yield this._rowObject(names);
        }
      } finally {
        this._E.sqlite3_reset(this._pStmt);
      }
    }

    [Symbol.iterator]() {
      return this.iterate();
    }

    as(Class) {
      if (typeof Class !== "function") {
        throw new TypeError("Statement.as() expects a class");
      }
      this._class = Class;
      return this;
    }

    // Bun's docs do not specify these two, but its .d.ts has no safeIntegers() method
    // at all (it is a Database option). Providing them is additive — it cannot break
    // code written against Bun — and it is the only way to vary the setting per
    // statement, which the option alone cannot express. See the report.
    safeIntegers(value) {
      this._safeIntegers = value !== false;
      return this;
    }

    get columnNames() {
      this._check();
      return this._columnNames();
    }

    // Bun documents columnTypes as "types based on actual values in first row (call
    // .get()/.all() first)" — so it is null until the statement has produced a row,
    // which is exactly what _rememberTypes records.
    get columnTypes() {
      this._check();
      return this._columnTypes;
    }

    get declaredTypes() {
      this._check();
      const E = this._E;
      const n = E.sqlite3_column_count(this._pStmt);
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = engine.readCString(E.sqlite3_column_decltype(this._pStmt, i));
      return out;
    }

    get paramsCount() {
      this._check();
      return this._E.sqlite3_bind_parameter_count(this._pStmt);
    }

    get native() {
      return this._pStmt;
    }

    toString() {
      if (this._finalized) return this._sql;
      const ptr = this._E.sqlite3_expanded_sql(this._pStmt);
      if (!ptr) return this._sql;
      const text = engine.readCString(ptr);
      this._E.sqlite3_free(ptr);
      return text;
    }

    // Must really call sqlite3_finalize: without it every prepared statement leaks
    // wasm heap for the life of the process.
    finalize() {
      if (this._finalized) return;
      this._finalized = true;
      this._db._forget(this);
      this._E.sqlite3_finalize(this._pStmt);
      this._pStmt = 0;
    }

    [Symbol.dispose]() {
      this.finalize();
    }
  }

  class Database {
    constructor(filename, options) {
      const eng = getEngine();
      const E = eng.exports;
      this._E = E;

      const name = filename == null || filename === "" ? ":memory:" : String(filename);
      let opts = options;
      let flags = 0;
      if (typeof options === "number") {
        flags = options;
        opts = {};
      } else {
        opts = options || {};
      }

      this.filename = name;
      this._safeIntegers = !!opts.safeIntegers;
      this._strict = !!opts.strict;
      this._statements = new Set();
      this._cache = new Map();
      this._closed = false;
      this._txDepth = 0;

      if (!flags) {
        if (opts.readonly) flags = OPEN_READONLY;
        else if (opts.readwrite && opts.create === false) flags = OPEN_READWRITE;
        else flags = OPEN_READWRITE | OPEN_CREATE;
        // `create: false` on an otherwise-default open means "must already exist".
        if (opts.create === false && !opts.readonly) flags = OPEN_READWRITE;
      }

      const ppDb = E.malloc(4);
      const zName = eng.allocCString(name);
      let rc;
      try {
        rc = E.sqlite3_open_v2(zName, ppDb, flags, 0);
        this._pDb = eng.dv().getUint32(ppDb, true);
      } finally {
        E.free(zName);
        E.free(ppDb);
      }
      if (rc !== SQLITE_OK) {
        const message = this._pDb
          ? eng.readCString(E.sqlite3_errmsg(this._pDb))
          : "unable to open database file";
        if (this._pDb) E.sqlite3_close_v2(this._pDb);
        this._pDb = 0;
        throw new SQLiteError(message + ": " + name, { errno: rc });
      }
    }

    static open(filename, options) {
      return new Database(filename, options);
    }

    _check() {
      if (this._closed) {
        throw new SQLiteError("Database is closed", { errno: SQLITE_MISUSE });
      }
    }

    _forget(stmt) {
      this._statements.delete(stmt);
      for (const [sql, cached] of this._cache) {
        if (cached === stmt) this._cache.delete(sql);
      }
    }

    _changes() {
      const E = this._E;
      const rowid = E.sqlite3_last_insert_rowid(this._pDb);
      return {
        changes: E.sqlite3_changes(this._pDb),
        lastInsertRowid: readInteger(rowid, this._safeIntegers),
      };
    }

    _prepareOne(sql) {
      const E = this._E;
      warnOnceAboutWal(sql);
      const zSql = engine.allocCString(sql);
      const ppStmt = E.malloc(4);
      let rc;
      let pStmt = 0;
      try {
        rc = E.sqlite3_prepare_v2(this._pDb, zSql, -1, ppStmt, 0);
        pStmt = engine.dv().getUint32(ppStmt, true);
      } finally {
        E.free(zSql);
        E.free(ppStmt);
      }
      if (rc !== SQLITE_OK) throwSqlite(E, this._pDb, "failed to prepare statement");
      if (!pStmt) {
        // Whitespace or a bare comment: no statement, but not an error either.
        throw new SQLiteError("no statement to prepare: " + JSON.stringify(sql), { errno: SQLITE_ERROR });
      }
      const stmt = new Statement(this, sql, pStmt);
      this._statements.add(stmt);
      return stmt;
    }

    prepare(sql) {
      this._check();
      return this._prepareOne(String(sql));
    }

    // Bun caches by SQL text and hands back the SAME Statement object.
    query(sql) {
      this._check();
      const key = String(sql);
      const hit = this._cache.get(key);
      if (hit && !hit._finalized) return hit;
      const stmt = this._prepareOne(key);
      this._cache.set(key, stmt);
      return stmt;
    }

    /**
     * Bun defines `exec = this.run`, so both accept a SQL string and optional params.
     *
     * With no params we walk the statement tail, which is what makes `db.exec(schema)`
     * — a whole CREATE TABLE script in one string, the way every ORM applies migrations
     * — actually apply all of it rather than only the first statement. (The previous
     * shim collapsed both to prepare(sql).run(), which silently dropped everything
     * after the first semicolon.) With params there is exactly one statement to bind to.
     */
    run(sql, ...params) {
      this._check();
      const text = String(sql);
      if (params.length) {
        const stmt = this._prepareOne(text);
        try {
          return stmt.run(...params);
        } finally {
          stmt.finalize();
        }
      }
      warnOnceAboutWal(text);

      const E = this._E;
      const zSql = engine.allocCString(text);
      const ppStmt = E.malloc(4);
      const ppTail = E.malloc(4);
      try {
        let cursor = zSql;
        for (;;) {
          const rc = E.sqlite3_prepare_v2(this._pDb, cursor, -1, ppStmt, ppTail);
          if (rc !== SQLITE_OK) throwSqlite(E, this._pDb, "failed to prepare statement");
          const pStmt = engine.dv().getUint32(ppStmt, true);
          const tail = engine.dv().getUint32(ppTail, true);
          if (!pStmt) {
            // Trailing whitespace / comment after the last statement.
            if (!tail || tail === cursor) break;
            cursor = tail;
            continue;
          }
          try {
            let stepRc;
            do {
              stepRc = E.sqlite3_step(pStmt);
            } while (stepRc === SQLITE_ROW);
            if (stepRc !== SQLITE_DONE) throwSqlite(E, this._pDb, "failed to execute statement");
          } finally {
            E.sqlite3_finalize(pStmt);
          }
          if (!tail || tail === cursor) break;
          cursor = tail;
        }
      } finally {
        E.free(zSql);
        E.free(ppStmt);
        E.free(ppTail);
      }
      return this._changes();
    }

    exec(sql, ...params) {
      return this.run(sql, ...params);
    }

    get inTransaction() {
      this._check();
      return this._E.sqlite3_get_autocommit(this._pDb) === 0;
    }

    /**
     * db.transaction(fn) -> a callable that runs fn inside a transaction, with
     * .deferred / .immediate / .exclusive variants. Re-runnable: `const t =
     * db.transaction(fn); t(a); t(b)` is two separate transactions.
     *
     * Nesting depth comes from sqlite3_get_autocommit — SQLite's own answer rather than
     * a counter we keep — so a transaction opened by hand with db.exec("BEGIN") is
     * still seen, and a nested call correctly becomes a SAVEPOINT.
     */
    transaction(fn) {
      if (typeof fn !== "function") {
        throw new TypeError("Database.transaction() expects a function");
      }
      const db = this;

      const runWith = (kind, self, args) => {
        db._check();
        const depth = db.inTransaction ? db._txDepth + 1 : 0;
        const plan = transactionPlan(kind, depth);
        db.run(plan.begin);
        const previousDepth = db._txDepth;
        db._txDepth = depth;
        let result;
        try {
          result = fn.apply(self, args);
        } catch (e) {
          db._txDepth = previousDepth;
          // SQLite may already have unwound the transaction itself (an ON CONFLICT
          // ROLLBACK, say). Rolling back again would throw over the top of the real
          // error and hide it, so each step is best-effort and the original wins.
          for (const sql of plan.rollback) {
            try {
              db.run(sql);
            } catch {
              /* already unwound */
            }
          }
          throw e;
        }
        if (result && typeof result.then === "function") {
          db._txDepth = previousDepth;
          for (const sql of plan.rollback) {
            try {
              db.run(sql);
            } catch {
              /* already unwound */
            }
          }
          // Silently not awaiting would commit before the work happened — the exact
          // class of bug this file exists to refuse.
          throw new TypeError(
            "Database.transaction() cannot be used with an async function: the " +
              "transaction would commit before the promise settled.",
          );
        }
        db._txDepth = previousDepth;
        db.run(plan.commit);
        return result;
      };

      const wrapped = function (...args) {
        return runWith("default", this, args);
      };
      wrapped.deferred = function (...args) {
        return runWith("deferred", this, args);
      };
      wrapped.immediate = function (...args) {
        return runWith("immediate", this, args);
      };
      wrapped.exclusive = function (...args) {
        return runWith("exclusive", this, args);
      };
      return wrapped;
    }

    serialize(schema) {
      this._check();
      const E = this._E;
      const zSchema = engine.allocCString(schema || "main");
      const pSize = E.malloc(8);
      try {
        const ptr = E.sqlite3_serialize(this._pDb, zSchema, pSize, 0);
        if (!ptr) throw new SQLiteError("sqlite3_serialize() returned NULL", { errno: SQLITE_NOMEM });
        const size = Number(engine.dv().getBigInt64(pSize, true));
        const copy = engine.u8().slice(ptr, ptr + size);
        E.sqlite3_free(ptr);
        const B = globalThis.Buffer;
        return B && typeof B.from === "function" ? B.from(copy) : copy;
      } finally {
        E.free(zSchema);
        E.free(pSize);
      }
    }

    static deserialize(serialized, options) {
      const opts = typeof options === "boolean" ? { readonly: options } : options || {};
      // `readonly` here is about the deserialized IMAGE, not the handle: the underlying
      // :memory: database still has to be opened read/write, or sqlite3_deserialize has
      // nothing to attach to. It becomes SQLITE_DESERIALIZE_READONLY below instead.
      const db = new Database(":memory:", { strict: opts.strict, safeIntegers: opts.safeIntegers });
      const E = db._E;
      const src =
        serialized instanceof Uint8Array
          ? serialized
          : ArrayBuffer.isView(serialized)
            ? new Uint8Array(serialized.buffer, serialized.byteOffset, serialized.byteLength)
            : new Uint8Array(serialized);
      // FREEONCLOSE hands ownership to SQLite, so the buffer must come from SQLite's
      // own allocator — sqlite3_free is what it will call.
      const ptr = E.sqlite3_malloc(Math.max(1, src.length));
      if (!ptr) throw new SQLiteError("out of memory", { errno: SQLITE_NOMEM });
      engine.u8().set(src, ptr);
      const zSchema = engine.allocCString("main");
      let rc;
      try {
        const flags =
          DESERIALIZE_FREEONCLOSE |
          (opts.readonly ? DESERIALIZE_READONLY : DESERIALIZE_RESIZEABLE);
        rc = E.sqlite3_deserialize(
          db._pDb, zSchema, ptr, BigInt(src.length), BigInt(src.length), flags,
        );
      } finally {
        E.free(zSchema);
      }
      if (rc !== SQLITE_OK) {
        E.sqlite3_free(ptr);
        db.close();
        throw new SQLiteError("sqlite3_deserialize() failed", { errno: rc });
      }
      return db;
    }

    /**
     * close(false) finalizes outstanding statements and closes; close(true) refuses if
     * queries are still live.
     *
     * The natural implementation of close(true) is sqlite3_close (v1), which reports
     * SQLITE_BUSY in exactly that case — but the vendored build exports only
     * sqlite3_close_v2, which never refuses (it defers the close instead). So we make
     * the check ourselves against the statements this Database is tracking. Same
     * observable behaviour for anything prepared through this object, which is all of
     * them; it would miss a statement prepared on the raw handle, and there is no way
     * to do that from the public API.
     */
    close(throwOnError) {
      if (this._closed) return;
      const E = this._E;
      if (throwOnError) {
        const live = [...this._statements].filter((s) => !s._finalized);
        if (live.length) {
          throw new SQLiteError(
            "Database has " + live.length + " unfinalized statement(s)",
            { errno: SQLITE_BUSY },
          );
        }
      }
      for (const stmt of [...this._statements]) stmt.finalize();
      E.sqlite3_close_v2(this._pDb);
      this._closed = true;
      this._pDb = 0;
      this._cache.clear();
      this._statements.clear();
    }

    [Symbol.dispose]() {
      this.close();
    }

    // ---- deliberately loud ----
    //
    // Neither of these can be made to work here, and neither is a matter of effort.
    // The vendored build does not export sqlite3_load_extension at all — extensions are
    // native shared libraries loaded with dlopen, the same wall as Bun.dlopen and
    // bun:ffi. sqlite3_file_control's opcodes address a real OS-backed VFS. They exist
    // on the prototype so a feature check does not crash, and throw at call time.
    loadExtension() {
      throw UNSUPPORTED(
        "loadExtension",
        "SQLite extensions are native shared libraries and require dlopen. The vendored " +
          "sqlite3.wasm does not export sqlite3_load_extension, so there is nothing to call.",
      );
    }

    fileControl() {
      throw UNSUPPORTED(
        "fileControl",
        "sqlite3_file_control opcodes address a native OS-backed VFS. Vivari's VFS is " +
          "backed by the in-browser filesystem and implements none of them.",
      );
    }

    static setCustomSQLite() {
      throw UNSUPPORTED(
        "setCustomSQLite",
        "there is no native libsqlite3 to point at in a browser. To use a different " +
          "engine build, set VV_SQLITE_WASM_PATH to a sqlite3.wasm in the VFS.",
      );
    }
  }

  // Bun exports `constants` alongside Database (`import { Database, constants } from
  // "bun:sqlite"`). Populated with the open flags and the file-control opcodes, so code
  // that merely READS constants.SQLITE_FCNTL_PERSIST_WAL keeps working even though
  // passing it to fileControl() throws.
  const constants = {
    SQLITE_OPEN_READONLY: 0x00000001,
    SQLITE_OPEN_READWRITE: 0x00000002,
    SQLITE_OPEN_CREATE: 0x00000004,
    SQLITE_OPEN_DELETEONCLOSE: 0x00000008,
    SQLITE_OPEN_EXCLUSIVE: 0x00000010,
    SQLITE_OPEN_AUTOPROXY: 0x00000020,
    SQLITE_OPEN_URI: 0x00000040,
    SQLITE_OPEN_MEMORY: 0x00000080,
    SQLITE_OPEN_MAIN_DB: 0x00000100,
    SQLITE_OPEN_TEMP_DB: 0x00000200,
    SQLITE_OPEN_TRANSIENT_DB: 0x00000400,
    SQLITE_OPEN_MAIN_JOURNAL: 0x00000800,
    SQLITE_OPEN_TEMP_JOURNAL: 0x00001000,
    SQLITE_OPEN_SUBJOURNAL: 0x00002000,
    SQLITE_OPEN_SUPER_JOURNAL: 0x00004000,
    SQLITE_OPEN_NOMUTEX: 0x00008000,
    SQLITE_OPEN_FULLMUTEX: 0x00010000,
    SQLITE_OPEN_SHAREDCACHE: 0x00020000,
    SQLITE_OPEN_PRIVATECACHE: 0x00040000,
    SQLITE_OPEN_WAL: 0x00080000,
    SQLITE_OPEN_NOFOLLOW: 0x01000000,
    SQLITE_OPEN_EXRESCODE: 0x02000000,
    SQLITE_PREPARE_PERSISTENT: 0x01,
    SQLITE_PREPARE_NORMALIZE: 0x02,
    SQLITE_PREPARE_NO_VTAB: 0x04,
    SQLITE_FCNTL_LOCKSTATE: 1,
    SQLITE_FCNTL_GET_LOCKPROXYFILE: 2,
    SQLITE_FCNTL_SET_LOCKPROXYFILE: 3,
    SQLITE_FCNTL_LAST_ERRNO: 4,
    SQLITE_FCNTL_SIZE_HINT: 5,
    SQLITE_FCNTL_CHUNK_SIZE: 6,
    SQLITE_FCNTL_FILE_POINTER: 7,
    SQLITE_FCNTL_SYNC_OMITTED: 8,
    SQLITE_FCNTL_WIN32_AV_RETRY: 9,
    SQLITE_FCNTL_PERSIST_WAL: 10,
    SQLITE_FCNTL_OVERWRITE: 11,
    SQLITE_FCNTL_VFSNAME: 12,
    SQLITE_FCNTL_POWERSAFE_OVERWRITE: 13,
    SQLITE_FCNTL_PRAGMA: 14,
    SQLITE_FCNTL_BUSYHANDLER: 15,
    SQLITE_FCNTL_TEMPFILENAME: 16,
    SQLITE_FCNTL_MMAP_SIZE: 18,
    SQLITE_FCNTL_TRACE: 19,
    SQLITE_FCNTL_HAS_MOVED: 20,
    SQLITE_FCNTL_SYNC: 21,
    SQLITE_FCNTL_COMMIT_PHASETWO: 22,
    SQLITE_FCNTL_WIN32_SET_HANDLE: 23,
    SQLITE_FCNTL_WAL_BLOCK: 24,
    SQLITE_FCNTL_ZIPVFS: 25,
    SQLITE_FCNTL_RBU: 26,
    SQLITE_FCNTL_VFS_POINTER: 27,
    SQLITE_FCNTL_JOURNAL_POINTER: 28,
    SQLITE_FCNTL_WIN32_GET_HANDLE: 29,
    SQLITE_FCNTL_PDB: 30,
    SQLITE_FCNTL_BEGIN_ATOMIC_WRITE: 31,
    SQLITE_FCNTL_COMMIT_ATOMIC_WRITE: 32,
    SQLITE_FCNTL_ROLLBACK_ATOMIC_WRITE: 33,
    SQLITE_FCNTL_LOCK_TIMEOUT: 34,
    SQLITE_FCNTL_DATA_VERSION: 35,
    SQLITE_FCNTL_SIZE_LIMIT: 36,
    SQLITE_FCNTL_CKPT_DONE: 37,
    SQLITE_FCNTL_RESERVE_BYTES: 38,
    SQLITE_FCNTL_CKPT_START: 39,
    SQLITE_FCNTL_EXTERNAL_READER: 40,
    SQLITE_FCNTL_CKSM_FILE: 41,
    SQLITE_FCNTL_RESET_CACHE: 42,
  };

  return {
    Database,
    Statement,
    SQLiteError,
    constants,
    default: Database,
    // Introspection for the spikes: which engine actually loaded, without booting it.
    __engineInfo: () => (engine ? { version: engine.version, vfs: engine.vfsName } : null),
  };
}