import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpfsPersistence } from "../packages/kernel-host/opfs-persistence.js";

function fakeOpfs() {
  const directory = () => ({ dirs: new Map(), files: new Map() });
  const root = directory();
  const handle = (dir) => ({
    async getDirectoryHandle(name, { create = false } = {}) {
      if (!dir.dirs.has(name) && create) dir.dirs.set(name, directory());
      if (!dir.dirs.has(name)) throw Object.assign(new Error("Missing directory"), { name: "NotFoundError" });
      return handle(dir.dirs.get(name));
    },
    async getFileHandle(name, { create = false } = {}) {
      if (!dir.files.has(name) && create) dir.files.set(name, new Uint8Array());
      if (!dir.files.has(name)) throw Object.assign(new Error("Missing file"), { name: "NotFoundError" });
      return {
        async createSyncAccessHandle() {
          return {
            getSize: () => dir.files.get(name).length,
            read: (bytes) => bytes.set(dir.files.get(name)),
            truncate: (length) => dir.files.set(name, dir.files.get(name).slice(0, length)),
            write: (bytes) => dir.files.set(name, Uint8Array.from(bytes)),
            flush() {},
            close() {},
          };
        },
      };
    },
    async removeEntry(name, { recursive = false } = {}) {
      if (dir.files.delete(name)) return;
      const child = dir.dirs.get(name);
      if (!child) throw Object.assign(new Error("Missing entry"), { name: "NotFoundError" });
      if (!recursive && (child.dirs.size || child.files.size)) throw new Error("NotEmptyError");
      dir.dirs.delete(name);
    },
  });
  return { getDirectory: async () => handle(root) };
}

function fakeVfs() {
  const entries = new Map();
  return {
    entries,
    read: (path) => entries.get(path),
    walk: (path) => [...entries.keys()].filter((key) => key === path || key.startsWith(path + "/")),
    mkdirp: (path) => entries.set(path, { kind: "dir", mode: 0o755 }),
    writeFile: (path, bytes) => entries.set(path, { kind: "file", mode: 0o644, bytes }),
    symlink: (target, path) => entries.set(path, { kind: "symlink", mode: 0o777, target }),
  };
}

test("deleting and immediately recreating a directory does not restore its old children", async () => {
  const originalNavigator = globalThis.navigator;
  const storage = fakeOpfs();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { storage } });
  try {
    const vfs = fakeVfs();
    const persistence = await createOpfsPersistence({ access: vfs });
    vfs.mkdirp("/workspace");
    vfs.mkdirp("/workspace/old");
    vfs.writeFile("/workspace/old/file.txt", new TextEncoder().encode("old"));
    vfs.writeFile("/outside.txt", new TextEncoder().encode("keep"));
    for (const path of vfs.walk("/workspace")) persistence.onWrite(path);
    persistence.onWrite("/outside.txt");
    await persistence.flush();

    vfs.entries.delete("/workspace/old/file.txt");
    vfs.entries.delete("/workspace/old");
    vfs.entries.delete("/workspace");
    // Keep the asynchronous mirror occupied so the root delete and write coalesce
    // before its drain reaches either one.
    persistence.onWrite("/outside.txt");
    persistence.onDelete("/workspace");
    vfs.mkdirp("/workspace");
    persistence.onWrite("/workspace");
    await persistence.flush();

    const reopened = fakeVfs();
    await (await createOpfsPersistence({ access: reopened })).restore();
    assert.deepEqual([...reopened.entries.keys()].sort(), ["/outside.txt", "/workspace"]);
  } finally {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
  }
});
