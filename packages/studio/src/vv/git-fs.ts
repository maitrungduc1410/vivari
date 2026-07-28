// A filesystem adapter that lets isomorphic-git (running on the studio MAIN
// thread) operate on the in-tab Vivari VFS.
//
// isomorphic-git wants a Node-style `fs` object with a promise API. The VFS,
// however, lives in the File System Worker and is only reachable from the main
// thread via `KernelBridge` messages. So every call here becomes a
// `bridge.request("vv-git-fs", …)` round-trip to the kernel worker's silent
// git-fs RPC (silent = it does NOT broadcast `vv-fs-changed`, so a commit's
// hundreds of `.git/objects` writes don't storm the Explorer).
//
// We expose the object as `{ promises: … }` because isomorphic-git prefers an
// enumerable `promises` property and calls those methods directly.

import type { KernelBridge, KernelMessage } from "./kernel";

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

type Kind = "file" | "dir" | "symlink";
interface RawStat {
  kind: Kind;
  mode?: number;
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  ino?: number;
}

/** A Node `fs.Stats`-shaped object with the surface isomorphic-git reads. */
export interface GitStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
}

interface NodeError extends Error {
  code?: string;
}

function toStat(raw: RawStat): GitStat {
  const kind = raw.kind;
  // The VFS reports permission bits in `mode` but derives the type from `kind`
  // (see runtime/node/bindings/fs.js). git needs the full mode (type | perm) to
  // pick the right blob filemode: 100644 file, 100755 exec, 120000 symlink,
  // 040000 tree. Reconstruct it here.
  const typeBit = kind === "dir" ? S_IFDIR : kind === "symlink" ? S_IFLNK : S_IFREG;
  const perm = (raw.mode ?? 0) & 0o777 || (kind === "dir" ? 0o755 : 0o644);
  const mtimeMs = raw.mtimeMs ?? 0;
  return {
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => kind === "symlink",
    mode: typeBit | perm,
    size: raw.size ?? 0,
    ino: raw.ino ?? 0,
    mtimeMs,
    ctimeMs: raw.ctimeMs ?? mtimeMs,
    uid: 0,
    gid: 0,
    dev: 1,
  };
}

export interface GitFs {
  promises: {
    readFile(path: string, options?: { encoding?: string } | string): Promise<Uint8Array | string>;
    writeFile(path: string, data: Uint8Array | string, options?: unknown): Promise<void>;
    unlink(path: string): Promise<void>;
    readdir(path: string): Promise<string[]>;
    mkdir(path: string, options?: unknown): Promise<void>;
    rmdir(path: string): Promise<void>;
    stat(path: string): Promise<GitStat>;
    lstat(path: string): Promise<GitStat>;
    readlink(path: string): Promise<string>;
    symlink(target: string, path: string): Promise<void>;
    chmod(path: string, mode: number): Promise<void>;
  };
}

/** Build the isomorphic-git fs adapter bound to a kernel bridge. */
export function createGitFs(bridge: KernelBridge): GitFs {
  // Serialize every git-fs op into a single in-flight `vv-git-fs` request.
  // isomorphic-git's status walk otherwise fires a BURST of concurrent fs calls;
  // each becomes a synchronous kernel-fs op that parks the single-threaded kernel
  // worker on Atomics.wait. A queued burst of them starves that same worker's
  // terminal relay (process spawn/output/exit), so a streaming command like
  // `ls` appears to hang. One-in-flight lets the kernel worker drain terminal
  // messages between git ops (the gap between each reply and the next request).
  let chain: Promise<unknown> = Promise.resolve();

  function call(op: string, args: Record<string, unknown>): Promise<unknown> {
    const run = chain.then(async () => {
      const m: KernelMessage = await bridge.request("vv-git-fs", { op, args });
      if (!m.ok) {
        const msg = (m.error as string) || `${op} failed`;
        const err: NodeError = new Error(msg);
        // Normalize to a bare errno token (e.g. "ENOENT") — isomorphic-git checks
        // `err.code === 'ENOENT'` to distinguish "missing" from a real failure.
        const src = ((m.code as string) || msg).trim();
        err.code = /^[A-Z]+/.exec(src)?.[0] || "EIO";
        throw err;
      }
      return m.result;
    });
    // The chain must never reject (a rejection would stall every later op) and
    // must not leak this op's result into the next one.
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  const promises: GitFs["promises"] = {
    async readFile(path, options) {
      const bytes = (await call("readFile", { path })) as Uint8Array;
      const enc = typeof options === "string" ? options : options?.encoding;
      if (enc === "utf8" || enc === "utf-8") return new TextDecoder().decode(bytes);
      return bytes;
    },
    async writeFile(path, data) {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      await call("writeFile", { path, bytes });
    },
    async unlink(path) {
      await call("unlink", { path });
    },
    async readdir(path) {
      return (await call("readdir", { path })) as string[];
    },
    async mkdir(path) {
      await call("mkdir", { path });
    },
    async rmdir(path) {
      await call("rmdir", { path });
    },
    async stat(path) {
      return toStat((await call("stat", { path })) as RawStat);
    },
    async lstat(path) {
      return toStat((await call("lstat", { path })) as RawStat);
    },
    async readlink(path) {
      return (await call("readlink", { path })) as string;
    },
    async symlink(target, path) {
      await call("symlink", { target, path });
    },
    // The VFS has no chmod; git only uses it to toggle the exec bit, which we
    // don't persist. Make it a resolved no-op so isomorphic-git doesn't reject.
    async chmod() {
      /* no-op */
    },
  };

  return { promises };
}