// Persistent dependency cache (P1 — node_modules keyed by lockfile).
//
// The OPFS write-behind mirror (opfs-persistence.js) already keeps a project's
// node_modules across a reload, and the package managers' own content-addressed
// caches under /home/user/.cache are persisted too — so a re-install rarely
// re-DOWNLOADS. But it still pays the full CPU cost of a real install every time
// node_modules is absent (a brand-new project, a `?reset`, a second project with
// the same deps): Arborist resolution + extracting thousands of files + running
// lifecycle scripts. This cache removes that: it stores the RESULT of an install
// (the whole node_modules tree) keyed by the lockfile, and restores it in one
// pass instead of re-running npm/yarn/pnpm.
//
// Model — CONTENT-ADDRESSED SNAPSHOT STORE (keyed by lockfile):
//   * `save(key, dir)` walks `dir/node_modules`, packs the tree (dirs + files +
//     symlinks) into ONE archive and hands it to the injected `storage` backend.
//   * `restore(key, dir)` reads that archive back and recreates the tree in the
//     VFS via the same `access` facade the OPFS mirror uses.
//   * A small index (persisted through `storage`) tracks size + last-use per key
//     for a bounded LRU: the oldest snapshots are evicted once the total exceeds
//     the byte cap, so the cache can't grow without limit.
//   * ALIASES: after an install, the durable key is the LOCKFILE hash, but a
//     brand-new project of the same template has no lockfile yet — only a
//     package.json. So a save can register extra alias keys (e.g. the
//     package.json hash) that point at the same snapshot, so the pre-install
//     lookup (which only has package.json) still hits.
//
// This module is environment-agnostic — like opfs-persistence.js it takes an
// `access` (a vfs-bound facade: read/walk/mkdirp/writeFile/symlink) and a
// `storage` (a blob backend: get/put/delete). The browser wires `storage` to
// OPFS (sync access handles, in the File System Worker); a headless spike wires
// it to an in-memory Map. Neither imports the wasm VFS directly.

const enc = new TextEncoder();
const dec = new TextDecoder();

// Reserved storage key for the index blob (real keys are `<pm>:<src>:<hex>`, so
// this can never collide with a snapshot key).
const INDEX_KEY = "__index__";
// Default LRU ceiling. node_modules snapshots are large; 512 MiB holds several
// typical projects while still bounding OPFS growth. Overridable via options.
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/**
 * Hash a lockfile (or package.json) into a stable cache key. `pm` namespaces the
 * key by package manager and `src` by which file it came from, so an npm
 * package-lock and a pnpm-lock can never alias each other, and a lockfile-keyed
 * snapshot is distinct from a package.json-keyed one.
 */
export async function hashDepKey(pm, input, src = "lock") {
  const bytes = input instanceof Uint8Array ? input : enc.encode(String(input));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, "0");
  return `${pm}:${src}:${hex}`;
}

export async function createDepCache({ access, storage, maxBytes = DEFAULT_MAX_BYTES }) {
  // index: key -> { size, atime } (a real snapshot) | { alias, atime } (a pointer).
  let index = { entries: {} };
  try {
    const raw = await storage.get(INDEX_KEY);
    if (raw && raw.length) {
      const parsed = JSON.parse(dec.decode(raw));
      if (parsed && parsed.entries) index = parsed;
    }
  } catch {
    /* first run / corrupt index → start empty */
  }

  const entries = () => index.entries;
  const totalBytes = () => {
    let n = 0;
    for (const e of Object.values(index.entries)) if (e && e.blob) n += e.size | 0;
    return n;
  };

  async function persistIndex() {
    try {
      await storage.put(INDEX_KEY, enc.encode(JSON.stringify(index)));
    } catch {
      /* best effort — a lost index just means a cold cache next boot */
    }
  }

  // Resolve an alias chain to the underlying snapshot key (or null if missing).
  function resolve(key) {
    const seen = new Set();
    let k = key;
    while (k && !seen.has(k)) {
      const e = entries()[k];
      if (!e) return null;
      if (e.blob) return k;
      seen.add(k);
      k = e.alias;
    }
    return null;
  }

  /** Is there a snapshot for `key` (following aliases)? */
  async function has(key) {
    return resolve(key) != null;
  }

  // ---- pack ----------------------------------------------------------------
  // Walk dir/node_modules and serialize it as [u32le headerLen][headerJSON][bytes].
  // header = { v, entries: [{ p, k:'d'|'f'|'l', m, o?, l?, t? }] }, `p` relative
  // to node_modules. Dirs/symlinks carry no bytes; files carry an (offset,len)
  // slice into the trailing blob. Mirrors the vendor-asset pack format.
  function pack(nodeModulesDir) {
    const paths = access.walk(nodeModulesDir); // parents before children
    const metaEntries = [];
    const blobs = [];
    let offset = 0;
    for (const p of paths) {
      const e = access.read(p);
      if (!e) continue;
      const rel = p === nodeModulesDir ? "" : p.slice(nodeModulesDir.length + 1);
      if (e.kind === "dir") {
        metaEntries.push({ p: rel, k: "d", m: e.mode | 0 });
      } else if (e.kind === "symlink") {
        metaEntries.push({ p: rel, k: "l", m: e.mode | 0, t: e.target });
      } else {
        const bytes = e.bytes || new Uint8Array(0);
        metaEntries.push({ p: rel, k: "f", m: e.mode | 0, o: offset, l: bytes.length });
        blobs.push(bytes);
        offset += bytes.length;
      }
    }
    const header = enc.encode(JSON.stringify({ v: 1, entries: metaEntries }));
    const out = new Uint8Array(4 + header.length + offset);
    new DataView(out.buffer).setUint32(0, header.length, true);
    out.set(header, 4);
    let o = 4 + header.length;
    for (const b of blobs) {
      out.set(b, o);
      o += b.length;
    }
    return { archive: out, fileCount: blobs.length, entryCount: metaEntries.length };
  }

  /**
   * Snapshot `dir/node_modules` under `key`, plus any `aliasKeys` (extra keys —
   * e.g. the package.json hash — that point at the same snapshot). No-op (returns
   * null) if node_modules is absent. Enforces the LRU cap afterwards.
   */
  async function save(key, dir, aliasKeys = []) {
    const nm = dir.replace(/\/+$/, "") + "/node_modules";
    let probe;
    try {
      probe = access.read(nm);
    } catch {
      probe = null;
    }
    if (!probe || probe.kind !== "dir") return null;

    const { archive, fileCount, entryCount } = pack(nm);
    await storage.put(key, archive);
    index.entries[key] = { blob: true, size: archive.length, atime: Date.now() };
    for (const a of aliasKeys) {
      if (a && a !== key) index.entries[a] = { alias: key, atime: Date.now() };
    }
    await evict(key);
    await persistIndex();
    return { key, bytes: archive.length, files: fileCount, entries: entryCount };
  }

  // ---- unpack --------------------------------------------------------------
  /**
   * Restore the snapshot for `key` into `dir/node_modules`. `onPath(absPath)` is
   * invoked for every created path (the FS worker uses it to also mirror the
   * restored tree to the OPFS write-behind store, so it survives a reload like a
   * normally-installed node_modules). Returns the number of entries restored, or
   * 0 on a miss.
   */
  async function restore(key, dir, onPath) {
    const real = resolve(key);
    if (!real) return 0;
    const raw = await storage.get(real);
    if (!raw || raw.length < 4) return 0;
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const headerLen = dv.getUint32(0, true);
    let header;
    try {
      header = JSON.parse(dec.decode(raw.subarray(4, 4 + headerLen)));
    } catch {
      return 0;
    }
    if (!header || !Array.isArray(header.entries)) return 0;
    const blobStart = 4 + headerLen;
    const nm = dir.replace(/\/+$/, "") + "/node_modules";
    const abs = (rel) => (rel ? nm + "/" + rel : nm);
    const notify = typeof onPath === "function" ? onPath : null;

    access.mkdirp(nm);
    if (notify) notify(nm);
    // Dirs first (shallow → deep is already the walk order), then files, then
    // symlinks (a symlink target may live anywhere in the tree).
    for (const e of header.entries) {
      if (e.k !== "d") continue;
      access.mkdirp(abs(e.p));
      if (notify) notify(abs(e.p));
    }
    for (const e of header.entries) {
      if (e.k !== "f") continue;
      const p = abs(e.p);
      const slash = p.lastIndexOf("/");
      if (slash > 0) access.mkdirp(p.slice(0, slash));
      access.writeFile(p, raw.subarray(blobStart + e.o, blobStart + e.o + e.l));
      if (notify) notify(p);
    }
    for (const e of header.entries) {
      if (e.k !== "l") continue;
      const p = abs(e.p);
      const slash = p.lastIndexOf("/");
      if (slash > 0) access.mkdirp(p.slice(0, slash));
      access.symlink(e.t, p);
      if (notify) notify(p);
    }

    // LRU touch so a just-used snapshot isn't the next evicted.
    const ent = index.entries[real];
    if (ent) ent.atime = Date.now();
    await persistIndex();
    return header.entries.length;
  }

  // Evict least-recently-used snapshots until under the cap. `protectKey` (the
  // one we just wrote) is never evicted. Drops each snapshot's blob AND any
  // aliases pointing at it.
  async function evict(protectKey) {
    if (totalBytes() <= maxBytes) return;
    const blobKeys = Object.keys(index.entries)
      .filter((k) => index.entries[k] && index.entries[k].blob && k !== protectKey)
      .sort((a, b) => (index.entries[a].atime | 0) - (index.entries[b].atime | 0));
    for (const k of blobKeys) {
      if (totalBytes() <= maxBytes) break;
      try {
        await storage.delete(k);
      } catch {
        /* already gone */
      }
      delete index.entries[k];
      // Drop aliases that pointed at the evicted snapshot.
      for (const [ak, ae] of Object.entries(index.entries)) {
        if (ae && ae.alias === k) delete index.entries[ak];
      }
    }
  }

  /** Drop everything (used by resetVfs). */
  async function clear() {
    for (const k of Object.keys(index.entries)) {
      if (index.entries[k] && index.entries[k].blob) {
        try {
          await storage.delete(k);
        } catch {
          /* ignore */
        }
      }
    }
    index = { entries: {} };
    await persistIndex();
  }

  return { has, save, restore, clear, hashDepKey };
}
