// Typed errors for @vivari/core.
//
// Every rejection the SDK produces is a `VivariError` carrying a machine-readable
// `code`, so callers discriminate on that instead of matching prose:
//
//   try {
//     await vivari.fs.readFile("/missing.txt", "utf-8");
//   } catch (err) {
//     if (err instanceof VivariError && err.code === "ENOENT") { … }
//   }
//
// Filesystem failures reuse the errno spellings Node uses. That is not a
// convention we invented for the SDK: the Rust VFS already raises exactly these
// strings and the kernel's sync fs bridge already attaches them as `err.code`, so
// the SDK forwards a code that was accurate all the way down. Everything that is
// NOT a syscall error gets an `ERR_`-prefixed code, matching Node's own split
// between errno codes and `ERR_*` codes.

/** Errno-style codes raised by the VFS. Mirrors Node's `fs` error codes. */
export type VivariFsErrorCode =
  | "EBADF"
  | "EEXIST"
  | "EINVAL"
  | "EIO"
  | "EISDIR"
  | "ELOOP"
  | "ENOENT"
  | "ENOTDIR"
  | "ENOTEMPTY";

/** Codes for failures that are not filesystem syscalls. */
export type VivariRuntimeErrorCode =
  /** The operation was cancelled through an {@link AbortSignal}. */
  | "ERR_ABORTED"
  /** The kernel worker reported a fatal error while booting. */
  | "ERR_BOOT_FAILED"
  /** `Vivari.boot()` did not complete within its timeout. */
  | "ERR_BOOT_TIMEOUT"
  /** A command could not be launched (not on PATH, or the kernel refused it). */
  | "ERR_COMMAND_NOT_FOUND"
  /** The page is not cross-origin isolated, so `SharedArrayBuffer` is unavailable. */
  | "ERR_NOT_ISOLATED"
  /** The kernel has not finished booting and cannot service the request. */
  | "ERR_NOT_READY"
  /** A request exceeded its explicit timeout. */
  | "ERR_TIMEOUT"
  /** The instance was torn down while the operation was in flight. */
  | "ERR_TORN_DOWN"
  /** The kernel reported a failure with no recognisable code. */
  | "ERR_UNKNOWN"
  /** The kernel worker itself failed to load or crashed. */
  | "ERR_WORKER";

/**
 * Every code the SDK can throw. Exhaustive, so a `switch` over `err.code` with no
 * `default` type-checks.
 */
export type VivariErrorCode = VivariFsErrorCode | VivariRuntimeErrorCode;

const FS_CODES: ReadonlySet<string> = new Set<VivariFsErrorCode>([
  "EBADF",
  "EEXIST",
  "EINVAL",
  "EIO",
  "EISDIR",
  "ELOOP",
  "ENOENT",
  "ENOTDIR",
  "ENOTEMPTY",
]);

/** Base class for everything the SDK throws. */
export class VivariError extends Error {
  readonly code: VivariErrorCode;

  constructor(code: VivariErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VivariError";
    this.code = code;
  }
}

/**
 * A filesystem failure. Carries the `path` and `syscall` that failed alongside the
 * errno `code`, so it reads like a Node `ErrnoException` in a debugger and in logs.
 */
export class VivariFsError extends VivariError {
  readonly path: string;
  readonly syscall: string;

  constructor(
    code: VivariErrorCode,
    syscall: string,
    path: string,
    message?: string,
    options?: { cause?: unknown },
  ) {
    super(code, message ?? `${code}: ${syscall} '${path}'`, options);
    this.name = "VivariFsError";
    this.syscall = syscall;
    this.path = path;
  }
}

/**
 * Narrow whatever the kernel put on the wire into a known code. The kernel forwards
 * the VFS's errno string verbatim; anything unrecognised (or absent) degrades to
 * `ERR_UNKNOWN` rather than widening the public union.
 */
export function toErrorCode(raw: unknown, fallback: VivariErrorCode = "ERR_UNKNOWN"): VivariErrorCode {
  if (typeof raw !== "string") return fallback;
  const code = raw.toUpperCase();
  if (FS_CODES.has(code)) return code as VivariFsErrorCode;
  return fallback;
}

/** Is `code` an errno-style filesystem code (as opposed to an `ERR_*` code)? */
export function isFsErrorCode(code: VivariErrorCode): code is VivariFsErrorCode {
  return FS_CODES.has(code);
}