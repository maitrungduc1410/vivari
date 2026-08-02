// Async filesystem facade over the kernel worker's VFS message protocol.
//
// The VFS itself is synchronous Rust/Wasm living in the file-system worker; every
// method here is a request/response round-trip through the kernel worker, so the
// API is Promise-based and deliberately mirrors a familiar `fs/promises` subset.
//
// Failures throw {@link VivariFsError} carrying the errno the VFS raised, so the
// `err.code === "ENOENT"` idiom ports over from Node unchanged.

import type { KernelBridge } from "./bridge.js";
import { TEARDOWN_MESSAGE } from "./bridge.js";
import { VivariFsError, toErrorCode } from "./errors.js";
import type {
  DirEnt,
  Encoding,
  FsChangeEvent,
  FsChangeKind,
  FsChangeListener,
  FsOperationOptions,
  KernelMessage,
  Stats,
  WatchOptions,
} from "./types.js";

function unwrap(m: KernelMessage, syscall: string, path: string): KernelMessage {
  if (m.ok === false) {
    throw new VivariFsError(
      toErrorCode(m.code),
      syscall,
      path,
      (m.error as string) || undefined,
    );
  }
  return m;
}

function isEncoding(value: unknown): value is Encoding {
  return value === "utf-8" || value === "utf8";
}

/** Does `path` sit at, or below, `base`? Used to scope a watch to a subtree. */
function isUnder(path: string, base: string): boolean {
  if (base === "/" || base === "") return true;
  const root = base.replace(/\/+$/, "");
  return path === root || path.startsWith(root + "/");
}

/**
 * A live subscription to VFS changes, from {@link FileSystemAPI.watch}. Consume it
 * with a callback, by async iteration, or both:
 *
 *   for await (const event of vivari.fs.watch("/src")) console.log(event.path);
 */
export interface FSWatcher extends AsyncIterable<FsChangeEvent> {
  /** Stop watching. Idempotent; ends any in-progress iteration. */
  close(): void;
  readonly closed: boolean;
}

export class FileSystemAPI {
  private readonly bridge: KernelBridge;

  constructor(bridge: KernelBridge) {
    this.bridge = bridge;
  }

  /**
   * Read a file. Pass an encoding for a string, omit it for raw bytes.
   *
   *   await fs.readFile("/app/index.js", "utf-8");   // string
   *   await fs.readFile("/app/logo.png");            // Uint8Array
   */
  async readFile(path: string, encoding: Encoding): Promise<string>;
  async readFile(path: string, options: FsOperationOptions & { encoding: Encoding }): Promise<string>;
  async readFile(path: string, options?: FsOperationOptions & { encoding?: null }): Promise<Uint8Array>;
  async readFile(
    path: string,
    options?: Encoding | (FsOperationOptions & { encoding?: Encoding | null }),
  ): Promise<string | Uint8Array> {
    const opts = isEncoding(options) ? { encoding: options } : (options ?? {});
    const signal = "signal" in opts ? opts.signal : undefined;
    if (isEncoding(opts.encoding)) {
      const m = unwrap(await this.bridge.request("vv-read", { path }, { signal }), "read", path);
      return m.contents as string;
    }
    const m = unwrap(await this.bridge.request("vv-read-bytes", { path }, { signal }), "read", path);
    return m.bytes as Uint8Array;
  }

  /** Write a file (parent directories are created as needed). */
  async writeFile(
    path: string,
    contents: string | Uint8Array,
    options: FsOperationOptions = {},
  ): Promise<void> {
    const payload =
      typeof contents === "string" ? { path, contents } : { path, bytes: contents };
    unwrap(await this.bridge.request("vv-write", payload, { signal: options.signal }), "write", path);
  }

  /** List a directory. With `{ withFileTypes: true }` you get {@link DirEnt}s. */
  async readdir(path: string, options?: FsOperationOptions): Promise<string[]>;
  async readdir(
    path: string,
    options: FsOperationOptions & { withFileTypes: true },
  ): Promise<DirEnt[]>;
  async readdir(
    path: string,
    options: FsOperationOptions & { withFileTypes?: boolean } = {},
  ): Promise<string[] | DirEnt[]> {
    const m = unwrap(
      await this.bridge.request("vv-readdir", { path }, { signal: options.signal }),
      "readdir",
      path,
    );
    const entries = (m.entries as Array<{ name: string; dir: boolean }>) || [];
    if (options.withFileTypes) {
      return entries.map((e) => ({
        name: e.name,
        isDirectory: () => e.dir,
        isFile: () => !e.dir,
      }));
    }
    return entries.map((e) => e.name);
  }

  /**
   * Create a directory. `recursive` (default `true`) creates parents like
   * `mkdir -p`; pass `false` for POSIX semantics — `ENOENT` if a parent is
   * missing, `EEXIST` if the target already exists.
   */
  async mkdir(
    path: string,
    options: FsOperationOptions & { recursive?: boolean } = {},
  ): Promise<void> {
    unwrap(
      await this.bridge.request(
        "vv-mkdirp",
        { path, recursive: options.recursive !== false },
        { signal: options.signal },
      ),
      "mkdir",
      path,
    );
  }

  /**
   * Remove a file or directory. Defaults to `rm -rf`; pass `recursive: false` to
   * get `ENOTEMPTY` on a non-empty directory, or `force: false` to get `ENOENT`
   * on a missing path.
   */
  async rm(
    path: string,
    options: FsOperationOptions & { recursive?: boolean; force?: boolean } = {},
  ): Promise<void> {
    unwrap(
      await this.bridge.request(
        "vv-rm",
        { path, recursive: options.recursive !== false, force: options.force !== false },
        { signal: options.signal },
      ),
      "rm",
      path,
    );
  }

  /** Rename/move a file or directory. */
  async rename(from: string, to: string, options: FsOperationOptions = {}): Promise<void> {
    unwrap(
      await this.bridge.request("vv-rename", { from, to }, { signal: options.signal }),
      "rename",
      from,
    );
  }

  /** Does the path exist? Never throws for a missing path — that's the question. */
  async exists(path: string, options: FsOperationOptions = {}): Promise<boolean> {
    const m = unwrap(
      await this.bridge.request("vv-stat", { path }, { signal: options.signal }),
      "stat",
      path,
    );
    return !!m.exists;
  }

  /** Metadata for one entry. Throws `ENOENT` if it doesn't exist (like Node). */
  async stat(path: string, options: FsOperationOptions = {}): Promise<Stats> {
    const m = unwrap(
      await this.bridge.request("vv-stat", { path }, { signal: options.signal }),
      "stat",
      path,
    );
    if (!m.exists) throw new VivariFsError("ENOENT", "stat", path);
    const isDir = !!m.isDir;
    return {
      size: (m.size as number) ?? 0,
      mtimeMs: (m.mtimeMs as number) ?? 0,
      mode: (m.mode as number) ?? 0,
      ino: (m.ino as number) ?? 0,
      isDirectory: () => isDir,
      isFile: () => !isDir,
    };
  }

  /**
   * Watch `path` for changes. Returns a handle that is both a callback
   * subscription and an async iterable; close it (or abort its signal) when done.
   *
   * The kernel reports the exact path that changed, with no coalescing — an
   * `npm install` fires thousands of events. Debounce before touching the DOM.
   */
  watch(path: string, listener?: FsChangeListener): FSWatcher;
  watch(path: string, options: WatchOptions, listener?: FsChangeListener): FSWatcher;
  watch(
    path: string,
    optionsOrListener?: WatchOptions | FsChangeListener,
    maybeListener?: FsChangeListener,
  ): FSWatcher {
    const options = typeof optionsOrListener === "function" ? {} : (optionsOrListener ?? {});
    const listener = typeof optionsOrListener === "function" ? optionsOrListener : maybeListener;
    const recursive = options.recursive !== false;
    const base = path.replace(/\/+$/, "") || "/";

    // Buffered hand-off between the kernel's push and a `for await` pull. Either
    // side may run ahead of the other, so both a value queue and a waiter queue
    // are needed.
    const queue: FsChangeEvent[] = [];
    const waiters: Array<(result: IteratorResult<FsChangeEvent>) => void> = [];
    let closed = false;

    const emit = (event: FsChangeEvent) => {
      listener?.(event);
      const waiter = waiters.shift();
      if (waiter) waiter({ value: event, done: false });
      else queue.push(event);
    };

    const offChange = this.bridge.on("vv-fs-changed", (m: KernelMessage) => {
      const changed = m.path as string;
      if (typeof changed !== "string") return;
      const match = recursive ? isUnder(changed, base) : parentOf(changed) === base || changed === base;
      if (!match) return;
      emit({ kind: (m.kind as FsChangeKind) ?? "change", path: changed });
    });

    const close = () => {
      if (closed) return;
      closed = true;
      offChange();
      offTeardown();
      options.signal?.removeEventListener("abort", close);
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    };
    const offTeardown = this.bridge.on(TEARDOWN_MESSAGE, close);
    options.signal?.addEventListener("abort", close, { once: true });
    if (options.signal?.aborted) close();

    return {
      get closed() {
        return closed;
      },
      close,
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<FsChangeEvent>> {
            const buffered = queue.shift();
            if (buffered) return Promise.resolve({ value: buffered, done: false });
            if (closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => waiters.push(resolve));
          },
          return(): Promise<IteratorResult<FsChangeEvent>> {
            close();
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }
}

/** The directory holding `path`, or `"/"` for a top-level entry. */
function parentOf(path: string): string {
  const slash = path.replace(/\/+$/, "").lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : "/";
}