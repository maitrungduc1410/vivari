// A vfs-shaped `access` facade over the HOST filesystem.
//
// dep-cache.js is deliberately environment-agnostic: it takes an `access`
// (read/walk/mkdirp/writeFile/symlink) and a `storage`, so the browser can bind
// it to the Wasm VFS + OPFS and a build script can bind it to node:fs. This is
// the node:fs binding, and it exists so scripts/gen-depcache.mjs produces its
// archive with the SHIPPED `pack()` rather than with a second implementation of
// the byte layout — a format with two writers is two formats, and this one is
// validated on the consumer side by `inspect()`, which would reject the drift
// only after the asset had been downloaded.
//
// Shared with scripts/spike-depcache-shipped.mjs for the same reason in reverse:
// a gate that packs its fixture differently from the producer is not a gate on
// the producer.

import fs from "node:fs";

const readOnly = (op) => () => {
  throw new Error(`host-vfs-access: ${op} is not available — this facade only reads`);
};

/**
 * `access` over the real filesystem, rooted nowhere in particular: every method
 * takes an absolute host path.
 *
 * The write half throws rather than no-opping. A silent no-op would let a caller
 * that meant to restore produce an empty tree and report success.
 */
export const hostAccess = {
  read(p) {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return null;
    }
    if (st.isDirectory()) return { kind: "dir", mode: st.mode & 0o7777 };
    if (st.isSymbolicLink()) return { kind: "symlink", mode: st.mode & 0o7777, target: fs.readlinkSync(p) };
    return { kind: "file", mode: st.mode & 0o7777, bytes: new Uint8Array(fs.readFileSync(p)) };
  },
  // Parents before children, which is the order `pack()` relies on to emit a
  // directory before anything inside it.
  walk(root) {
    const out = [];
    const rec = (p) => {
      let st;
      try {
        st = fs.lstatSync(p);
      } catch {
        return;
      }
      out.push(p);
      if (!st.isDirectory()) return;
      for (const name of fs.readdirSync(p)) rec(p + "/" + name);
    };
    rec(root);
    return out;
  },
  mkdirp: readOnly("mkdirp"),
  writeFile: readOnly("writeFile"),
  symlink: readOnly("symlink"),
};

/** An in-memory `storage` backend: what a producer packs INTO before writing it out. */
export function memoryStorage() {
  const blobs = new Map();
  return {
    blobs,
    get: async (k) => blobs.get(k) || null,
    put: async (k, v) => void blobs.set(k, v),
    delete: async (k) => void blobs.delete(k),
  };
}
