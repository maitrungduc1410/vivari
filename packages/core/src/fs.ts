// Async filesystem facade over the kernel worker's VFS message protocol.
//
// The VFS itself is synchronous Rust/Wasm living in the file-system worker; every
// method here is a request/response round-trip through the kernel worker, so the
// API is Promise-based and deliberately mirrors a familiar `fs/promises` subset.

import type { KernelBridge } from "./bridge";
import type { DirEnt, KernelMessage } from "./types";

function unwrap(m: KernelMessage): KernelMessage {
  if (m.ok === false) throw new Error((m.error as string) || "vivari fs error");
  return m;
}

export class FileSystemAPI {
  private readonly bridge: KernelBridge;

  constructor(bridge: KernelBridge) {
    this.bridge = bridge;
  }

  /** Read a file. Pass `"utf-8"` for a string, omit it for raw bytes. */
  async readFile(path: string, encoding: "utf-8"): Promise<string>;
  async readFile(path: string): Promise<Uint8Array>;
  async readFile(path: string, encoding?: "utf-8"): Promise<string | Uint8Array> {
    if (encoding === "utf-8") {
      const m = unwrap(await this.bridge.request("vv-read", { path }));
      return m.contents as string;
    }
    const m = unwrap(await this.bridge.request("vv-read-bytes", { path }));
    return m.bytes as Uint8Array;
  }

  /** Write a file (parent directories are created as needed). */
  async writeFile(path: string, contents: string | Uint8Array): Promise<void> {
    const payload =
      typeof contents === "string" ? { path, contents } : { path, bytes: contents };
    unwrap(await this.bridge.request("vv-write", payload));
  }

  /** List a directory. With `{ withFileTypes: true }` you get {@link DirEnt}s. */
  async readdir(path: string): Promise<string[]>;
  async readdir(path: string, options: { withFileTypes: true }): Promise<DirEnt[]>;
  async readdir(
    path: string,
    options?: { withFileTypes?: boolean },
  ): Promise<string[] | DirEnt[]> {
    const m = unwrap(await this.bridge.request("vv-readdir", { path }));
    const entries = (m.entries as Array<{ name: string; dir: boolean }>) || [];
    if (options?.withFileTypes) {
      return entries.map((e) => ({
        name: e.name,
        isDirectory: () => e.dir,
        isFile: () => !e.dir,
      }));
    }
    return entries.map((e) => e.name);
  }

  /** Create a directory. `recursive` (default true) creates parents like `mkdir -p`. */
  async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
    // The VFS only exposes a recursive mkdirp; a non-recursive request still
    // succeeds, which is a harmless superset for the common case.
    unwrap(await this.bridge.request("vv-mkdirp", { path }));
  }

  /** Remove a file or directory (recursively). */
  async rm(path: string, _options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    unwrap(await this.bridge.request("vv-rm", { path }));
  }

  /** Rename/move a file or directory. */
  async rename(from: string, to: string): Promise<void> {
    unwrap(await this.bridge.request("vv-rename", { from, to }));
  }

  /** Does the path exist? */
  async exists(path: string): Promise<boolean> {
    const m = unwrap(await this.bridge.request("vv-stat", { path }));
    return !!m.exists;
  }

  /** Lightweight stat: `{ exists, isDirectory, isFile }`. */
  async stat(path: string): Promise<{ exists: boolean; isDirectory: boolean; isFile: boolean }> {
    const m = unwrap(await this.bridge.request("vv-stat", { path }));
    const exists = !!m.exists;
    const isDir = !!m.isDir;
    return { exists, isDirectory: exists && isDir, isFile: exists && !isDir };
  }
}
