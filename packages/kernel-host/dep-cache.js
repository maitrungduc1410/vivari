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

// ---- shipped-snapshot transport container -----------------------------------
// A snapshot built at BUILD time is downloaded before it is imported, and the
// archive `pack()` emits is raw bytes — react-ts is 59.8 MiB of them. Shipping
// that uncompressed costs more to download than the install it replaces, so a
// shipped asset is wrapped in a second, outer frame that names a codec:
//
//   [u32le headerLen][headerJSON {v:2, c}][compressed archive]
//
// deliberately the SAME shape as the archive itself, because a v1 archive's own
// header is `{v:1, entries:[…]}` — so one parse tells the two apart and a
// snapshot produced before this existed still imports. Only the transport is
// compressed: what lands in `storage` is always the plain archive, so `restore()`
// and the LRU are untouched by this.
//
// The codec is NAMED rather than assumed because the right answer may change:
// measured on next-ts, gzip is 57.2 MiB and brotli q9 is 35.5 MiB.
//
// Decoding lives HERE rather than at the callers, and the reason is a bug rather
// than tidiness: the input is a download, so a corrupt one is expected, and
// Node's `DecompressionStream` faults both halves of the stream at once. A
// caller that awaited only the read side left the write side rejected and
// unhandled, which Node treats as fatal — the try/catch saw a clean null and the
// process died a few ticks later somewhere else. `inflateGzip` below awaits both
// in one `Promise.all` so that cannot recur, and there is one copy of it.
//
// `DecompressionStream` is a global, not a dependency, and is present wherever
// this module already runs (Node ≥ 18, and any browser that can give Vivari
// COOP/COEP + SharedArrayBuffer) — the same standing this module's existing use
// of `TextEncoder` and `crypto.subtle` has. What it must NOT acquire is a
// BUNDLED decoder: brotli would mean importing packages/codec here, and hence
// into every worker that touches the dep cache. That is the real cost behind
// choosing gzip, and the reason `c` exists is so revisiting it is a header
// field rather than a format break.
export const SNAPSHOT_CONTAINER_VERSION = 2;

/**
 * Wrap a compressed `body` for shipping. `codec` is the name the reader will
 * dispatch on ("gz"); `meta` is merged into the header for humans and tooling.
 */
export function writeSnapshotContainer(codec, body, meta = {}) {
  const header = enc.encode(JSON.stringify({ v: SNAPSHOT_CONTAINER_VERSION, c: codec, ...meta }));
  const out = new Uint8Array(4 + header.length + body.length);
  new DataView(out.buffer).setUint32(0, header.length, true);
  out.set(header, 4);
  out.set(body, 4 + header.length);
  return out;
}

/**
 * Read the transport frame off a downloaded snapshot. Returns
 * `{ codec, body }` — `codec: null` means `raw` is already a plain archive
 * (a v1 asset, or one produced with no compression), so `body` is `raw` itself.
 * Returns null only for bytes that are neither, which is the case that matters:
 * an SPA index.html served with a 200 in place of a missing asset.
 */
export function readSnapshotContainer(raw) {
  if (!(raw instanceof Uint8Array) || raw.length < 4) return null;
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const headerLen = dv.getUint32(0, true);
  if (!headerLen || headerLen > raw.length - 4) return null;
  let header;
  try {
    header = JSON.parse(dec.decode(raw.subarray(4, 4 + headerLen)));
  } catch {
    return null;
  }
  if (!header || typeof header !== "object") return null;
  if (header.v === SNAPSHOT_CONTAINER_VERSION && typeof header.c === "string") {
    return { codec: header.c, body: raw.subarray(4 + headerLen) };
  }
  // Anything else with a parseable header is a plain archive; `inspect()` is
  // what decides whether it is a VALID one.
  return { codec: null, body: raw };
}

/**
 * A downloaded snapshot's bytes → the plain archive `importArchive` takes, or
 * null. Null for anything this build cannot turn into an archive: bytes that are
 * neither a container nor an archive (the SPA index.html a missing asset answers
 * with), a truncated download, or a codec named in the header that is not
 * implemented here. Never "unpack it anyway" — the caller installs normally.
 *
 * gzip only. `DecompressionStream` is the one decoder every worker already has;
 * brotli would be ~30% smaller (react-ts: 8.6 MB against 12.5 MB) but browsers
 * expose no brotli DecompressionStream, so it would mean instantiating
 * packages/codec in whichever worker calls this. `c` is the seam where that gets
 * revisited if hosting bytes argue louder than they do today.
 */
export async function decodeShippedSnapshot(raw) {
  const framed = readSnapshotContainer(raw);
  if (!framed) return null;
  if (!framed.codec) return framed.body;
  if (framed.codec !== "gz") return null;
  try {
    return await inflateGzip(framed.body);
  } catch {
    return null;
  }
}

// Read and write concurrently — awaiting the write before reading deadlocks once
// the stream's internal buffer fills, which for a 60 MB snapshot is immediately.
//
// Both promises are awaited in the same `Promise.all`, and that is load-bearing
// rather than tidy: the input here is a DOWNLOAD, so a corrupt one is expected,
// and it fails on both halves at once. Handling only the read side leaves the
// write side rejected and unhandled, which a browser reports as an unhandled
// rejection and Node treats as fatal — the caller's try/catch sees a clean null
// and the process dies anyway, a few ticks later, somewhere else.
async function inflateGzip(bytes) {
  const stream = new DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  const writing = (async () => {
    await writer.write(bytes);
    await writer.close();
  })();
  const reading = (async () => {
    const reader = stream.readable.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    return { chunks, total };
  })();
  const [, { chunks, total }] = await Promise.all([writing, reading]);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
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
  // The archive format and its walk live in packTree() below the factory, shared
  // with the SDK's whole-tree snapshot.
  const pack = (nodeModulesDir) => packTree(access, nodeModulesDir);

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

  // ---- import an externally produced archive --------------------------------
  // Validation is inspectArchive() below the factory (shared with the SDK's
  // restore, which takes bytes from an embedder just as untrusted as a download).
  const inspect = inspectArchive;

  /**
   * Store an archive produced ELSEWHERE (a snapshot shipped with the app, built by
   * running the install once at build time) under `key` plus `aliasKeys`, so the
   * very next `restore(key, …)` hits. Returns the same shape as `save()`, or null
   * if the archive is not well formed — see `inspect`.
   *
   * `shipped` marks the entry as re-fetchable, which changes only one thing: LRU
   * eviction drops it before a user's own snapshot. A shipped snapshot can be
   * downloaded again for the cost of a request, whereas a user snapshot can only be
   * rebuilt by re-running the install it was made to avoid.
   */
  async function importArchive(key, archive, aliasKeys = [], { shipped = false } = {}) {
    const info = inspect(archive);
    if (!info) return null;
    await storage.put(key, archive);
    index.entries[key] = { blob: true, size: archive.length, atime: Date.now(), shipped: !!shipped };
    for (const a of aliasKeys) {
      if (a && a !== key) index.entries[a] = { alias: key, atime: Date.now() };
    }
    await evict(key);
    await persistIndex();
    return { key, bytes: archive.length, files: info.fileCount, entries: info.entryCount };
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
    const count = unpackArchive(access, raw, dir.replace(/\/+$/, "") + "/node_modules", onPath);
    if (!count) return 0;

    // LRU touch so a just-used snapshot isn't the next evicted.
    const ent = index.entries[real];
    if (ent) ent.atime = Date.now();
    await persistIndex();
    return count;
  }

  // Evict least-recently-used snapshots until under the cap. `protectKey` (the
  // one we just wrote) is never evicted. Drops each snapshot's blob AND any
  // aliases pointing at it.
  //
  // Shipped snapshots go first, regardless of age: re-acquiring one costs a request,
  // while re-acquiring a user's own snapshot costs the whole install it was created
  // to skip. Cheapest-to-rebuild is the right thing to discard.
  async function evict(protectKey) {
    if (totalBytes() <= maxBytes) return;
    const blobKeys = Object.keys(index.entries)
      .filter((k) => index.entries[k] && index.entries[k].blob && k !== protectKey)
      .sort(
        (a, b) =>
          (index.entries[a].shipped ? 0 : 1) - (index.entries[b].shipped ? 0 : 1) ||
          (index.entries[a].atime | 0) - (index.entries[b].atime | 0),
      );
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

  return { has, save, importArchive, restore, clear, hashDepKey };
}
// ---- the archive format, shared by the dep cache and the SDK snapshot --------
//
//   [u32le headerLen][headerJSON][bytes]
//   header = { v: 1, entries: [{ p, k: 'd'|'f'|'l', m, o?, l?, t? }] }
//
// `p` is relative to the archived root ("" is the root itself). Dirs and symlinks
// carry no bytes; files carry an (offset, length) slice into the trailing blob.
// Walk order is parents before children.

/**
 * Pack the tree at `root`. `skip(name)` returning true leaves out that entry and
 * everything under it (matched on the entry's own name, at any depth).
 */
export function packTree(access, root, skip) {
  const paths = access.walk(root);
  const metaEntries = [];
  const blobs = [];
  let offset = 0;
  const skipped = [];
  for (const p of paths) {
    const rel = p === root ? "" : p.slice(root === "/" ? 1 : root.length + 1);
    if (rel && skip) {
      if (skipped.some((s) => rel === s || rel.startsWith(s + "/"))) continue;
      if (skip(rel.slice(rel.lastIndexOf("/") + 1))) {
        skipped.push(rel);
        continue;
      }
    }
    const e = access.read(p);
    if (!e) continue;
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
 * Is `raw` a well-formed archive whose every entry stays inside the tree? An
 * archive that arrives from outside (a shipped asset, bytes an embedder hands to
 * restore()) is checked BEFORE anything is written: a truncated download or an
 * HTML error page served with a 200 must be refused, not half-unpacked, and a
 * `..` or absolute path would write outside the destination. Returns counts, or
 * null on anything suspect.
 */
export function inspectArchive(raw) {
  if (!(raw instanceof Uint8Array) || raw.length < 4) return null;
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const headerLen = dv.getUint32(0, true);
  if (!headerLen || headerLen > raw.length - 4) return null;
  let header;
  try {
    header = JSON.parse(dec.decode(raw.subarray(4, 4 + headerLen)));
  } catch {
    return null;
  }
  if (!header || !Array.isArray(header.entries) || header.entries.length === 0) return null;
  const blobLen = raw.length - (4 + headerLen);
  let fileCount = 0;
  for (const e of header.entries) {
    if (!e || typeof e.p !== "string") return null;
    if (e.p.startsWith("/") || e.p.split("/").some((seg) => seg === ".." || seg === ".")) return null;
    if (e.k === "f") {
      if (!Number.isInteger(e.o) || !Number.isInteger(e.l) || e.o < 0 || e.l < 0 || e.o + e.l > blobLen) {
        return null;
      }
      fileCount++;
    } else if (e.k === "l") {
      if (typeof e.t !== "string") return null;
    } else if (e.k !== "d") {
      return null;
    }
  }
  return { fileCount, entryCount: header.entries.length };
}

/**
 * Unpack `raw` under `dest`. `onPath(absPath)` is called for every path created
 * (the FS worker mirrors them to OPFS). Returns the number of entries, 0 if `raw`
 * does not parse. Callers holding untrusted bytes run inspectArchive() first.
 */
export function unpackArchive(access, raw, dest, onPath) {
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
  const base = dest === "/" ? "" : dest.replace(/\/+$/, "");
  const abs = (rel) => (rel ? base + "/" + rel : base || "/");
  const notify = typeof onPath === "function" ? onPath : null;
  const parent = (p) => {
    const slash = p.lastIndexOf("/");
    if (slash > 0) access.mkdirp(p.slice(0, slash));
  };

  access.mkdirp(abs(""));
  if (notify) notify(abs(""));
  // Dirs first (the walk order is already shallow to deep), then files, then
  // symlinks, since a symlink's target may live anywhere in the tree.
  for (const e of header.entries) {
    if (e.k !== "d" || !e.p) continue;
    access.mkdirp(abs(e.p));
    if (notify) notify(abs(e.p));
  }
  for (const e of header.entries) {
    if (e.k !== "f") continue;
    const p = abs(e.p);
    parent(p);
    access.writeFile(p, raw.subarray(blobStart + e.o, blobStart + e.o + e.l));
    if (notify) notify(p);
  }
  for (const e of header.entries) {
    if (e.k !== "l") continue;
    const p = abs(e.p);
    parent(p);
    access.symlink(e.t, p);
    if (notify) notify(p);
  }
  return header.entries.length;
}

// ---- the SDK snapshot: a whole tree, gzipped, in the shipped-asset frame ------
//
// Vivari.snapshot() returns this and Vivari.restore() takes it. It is the same
// container a shipped dep-cache asset uses ({v:2, c:"gz"}), with `kind: "tree"`
// so a node_modules-only asset and a whole-project snapshot cannot be mistaken
// for each other by a reader that cares. Nothing outside this file should need
// to know the layout; embedders treat the bytes as opaque.
export const TREE_SNAPSHOT_KIND = "tree";

export async function encodeTreeSnapshot(archive) {
  const body = await gzipBytes(archive);
  return writeSnapshotContainer("gz", body, { kind: TREE_SNAPSHOT_KIND });
}

/**
 * Snapshot bytes → a validated plain archive, or null. Accepts the gzipped
 * container encodeTreeSnapshot() writes and a bare archive; refuses anything that
 * does not decode or does not pass inspectArchive().
 */
export async function decodeTreeSnapshot(bytes) {
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  const archive = await decodeShippedSnapshot(raw);
  if (!archive || !inspectArchive(archive)) return null;
  return archive;
}

// Same concurrency rule as inflateGzip: read and write together, await both.
async function gzipBytes(bytes) {
  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  const writing = (async () => {
    await writer.write(bytes);
    await writer.close();
  })();
  const reading = (async () => {
    const reader = stream.readable.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    return { chunks, total };
  })();
  const [, { chunks, total }] = await Promise.all([writing, reading]);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// The two FS-worker operations behind Vivari.snapshot()/restore(), in one place so
// the browser fs-worker and its headless twin (scripts/fs-worker.mjs) cannot drift.
// Errors carry a POSIX-shaped `code` the SDK maps onto its own.
function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Pack `root` (minus `exclude` names) into snapshot bytes. */
export async function snapshotTreeOp(access, { root, exclude } = {}) {
  const dir = root && root !== "/" ? String(root).replace(/\/+$/, "") : "/";
  const top = access.read(dir);
  if (!top) throw codedError("ENOENT", "snapshot: no such file or directory, " + dir);
  if (top.kind !== "dir") throw codedError("ENOTDIR", "snapshot: not a directory, " + dir);
  const names = new Set(Array.isArray(exclude) ? exclude.map(String) : []);
  const { archive, fileCount, entryCount } = packTree(access, dir, names.size ? (n) => names.has(n) : null);
  const bytes = await encodeTreeSnapshot(archive);
  return { bytes, files: fileCount, entries: entryCount, rawBytes: archive.length };
}

/** Validate snapshot bytes, then unpack them under `dir`. */
export async function restoreTreeOp(access, bytes, dir, onPath) {
  const archive = await decodeTreeSnapshot(bytes);
  if (!archive) throw codedError("EINVAL", "restore: not a Vivari snapshot, or a damaged one");
  const info = inspectArchive(archive);
  const dest = dir && dir !== "/" ? String(dir).replace(/\/+$/, "") : "/";
  const target = access.read(dest);
  if (target && target.kind !== "dir") throw codedError("ENOTDIR", "restore: not a directory, " + dest);
  const entries = unpackArchive(access, archive, dest, onPath);
  return { entries, files: info.fileCount };
}
