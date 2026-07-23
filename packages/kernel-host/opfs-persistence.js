// OPFS write-behind persistence for the Rust/Wasm VFS (Phase 2 — persistence).
//
// The VFS lives entirely in the File System Worker's wasm linear memory, so a
// reload wipes it. This adapter mirrors the VFS to the Origin Private File
// System (OPFS) so a project + its node_modules survive F5.
//
// Why OPFS: it is a real per-origin filesystem with SYNCHRONOUS access handles
// **inside a Worker** (createSyncAccessHandle) — the same primitive SQLite-wasm
// uses — which matches our worker-based, Atomics-blocking VFS far better than
// IndexedDB's async-only API. It draws from the large per-origin storage quota
// (shared with Cache API), so hundreds of MB of node_modules is fine.
//
// Model — WRITE-BEHIND MIRROR (not a backing store):
//   * The Rust VFS stays the source of truth in RAM (reads never touch OPFS →
//     no latency regression).
//   * FsServer forwards every successful *mutation* here (onWrite/onDelete/
//     onRename). We can't await OPFS from the synchronous syscall path, so we
//     only enqueue a dirty path and drain it on an async loop. Durability is
//     therefore eventual (a few ms behind); flush() forces a drain (page hide).
//   * On boot restore() replays a small manifest back into the VFS BEFORE the
//     worker serves any syscall.
//
// Layout under the origin's OPFS:
//   vv-vfs/
//     files/…            one real OPFS file per VFS file (bytes only)
//     manifest.json      [ [path, {k,m,t}], … ] — the index: kind, mode, and
//                        (for symlinks) target. Dirs/symlinks have no `files/`
//                        entry, so the manifest is what recreates them.
//
// `access` is a small vfs-bound facade injected by the File System Worker
// (read/walk/mkdirp/writeFile/symlink); this module never imports the wasm VFS
// directly, so it stays environment-agnostic and headless never loads it.

const ROOT_DIR = "vv-vfs";
const FILES_DIR = "files";
const MANIFEST = "manifest.json";

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function createOpfsPersistence({ access, shouldPersist = () => true }) {
  const origin = await navigator.storage.getDirectory();
  const base = await origin.getDirectoryHandle(ROOT_DIR, { create: true });
  const filesBase = await base.getDirectoryHandle(FILES_DIR, { create: true });

  // path (VFS absolute) -> { k:'file'|'dir'|'symlink', m:mode, t:target? }
  const meta = new Map();
  // path -> 'w' (write/create) | 'd' (delete). Insertion order = drain order.
  const pending = new Map();
  let draining = false;
  let manifestDirty = false;

  const parts = (p) => p.split("/").filter(Boolean);

  // ---- low-level OPFS helpers (all async: handle acquisition is async) -------
  async function dirFor(path, create) {
    let h = filesBase;
    for (const part of parts(path)) h = await h.getDirectoryHandle(part, { create });
    return h;
  }
  async function parentFor(path, create) {
    const ps = parts(path);
    const name = ps.pop();
    let h = filesBase;
    for (const part of ps) h = await h.getDirectoryHandle(part, { create });
    return [h, name];
  }
  async function writeBytes(path, bytes) {
    const [dir, name] = await parentFor(path, true);
    const fh = await dir.getFileHandle(name, { create: true });
    const ah = await fh.createSyncAccessHandle();
    try {
      ah.truncate(0);
      if (bytes && bytes.length) ah.write(bytes, { at: 0 });
      ah.flush();
    } finally {
      ah.close();
    }
  }
  async function readBytes(path) {
    const [dir, name] = await parentFor(path, false);
    const fh = await dir.getFileHandle(name);
    const ah = await fh.createSyncAccessHandle();
    try {
      const size = ah.getSize();
      const buf = new Uint8Array(size);
      if (size) ah.read(buf, { at: 0 });
      return buf;
    } finally {
      ah.close();
    }
  }
  async function removePath(path) {
    try {
      const [dir, name] = await parentFor(path, false);
      await dir.removeEntry(name, { recursive: true });
    } catch {
      /* already gone / never written */
    }
  }
  async function writeManifest() {
    const arr = [...meta.entries()];
    const fh = await base.getFileHandle(MANIFEST, { create: true });
    const ah = await fh.createSyncAccessHandle();
    try {
      const bytes = enc.encode(JSON.stringify(arr));
      ah.truncate(0);
      ah.write(bytes, { at: 0 });
      ah.flush();
    } finally {
      ah.close();
    }
  }

  // ---- the write-behind queue ----------------------------------------------
  function onWrite(path) {
    if (!shouldPersist(path)) return;
    pending.set(path, "w");
    kick();
  }
  function onDelete(path) {
    if (!shouldPersist(path)) return;
    // Drop any queued writes under this subtree — they're moot now.
    const pre = path + "/";
    for (const k of [...pending.keys()]) if (k === path || k.startsWith(pre)) pending.delete(k);
    pending.set(path, "d");
    kick();
  }
  function onRename(from, to) {
    // rename already moved the subtree in the VFS. Mirror it as: delete the old
    // path (recursive on disk) + re-enqueue every path now living under `to`.
    if (shouldPersist(from)) onDelete(from);
    if (shouldPersist(to)) for (const p of access.walk(to)) onWrite(p);
  }

  function kick() {
    if (!draining) drain();
  }

  async function drain() {
    draining = true;
    try {
      while (pending.size) {
        const path = pending.keys().next().value;
        const op = pending.get(path);
        pending.delete(path);
        try {
          if (op === "d") {
            await removePath(path);
            meta.delete(path);
            const pre = path + "/";
            for (const k of [...meta.keys()]) if (k.startsWith(pre)) meta.delete(k);
            manifestDirty = true;
          } else {
            const e = access.read(path); // current truth from the VFS
            if (!e) continue; // vanished between enqueue and drain
            if (e.kind === "file") await writeBytes(path, e.bytes);
            else if (e.kind === "dir") await dirFor(path, true);
            // symlink: nothing on disk, manifest carries the target
            meta.set(path, { k: e.kind, m: e.mode | 0, t: e.target });
            manifestDirty = true;
          }
        } catch {
          /* keep draining; a single bad entry shouldn't wedge the queue */
        }
      }
      if (manifestDirty) {
        // Best-effort: a transient OPFS hiccup here must not escape as an
        // unhandled rejection. Leave manifestDirty set so the next drain retries.
        try {
          await writeManifest();
          manifestDirty = false;
        } catch {
          /* retry on the next drain */
        }
      }
    } finally {
      draining = false;
      if (pending.size) drain(); // work arrived while we were finishing
    }
  }

  // Force everything queued to hit disk (best-effort; used on page hide).
  async function flush() {
    if (draining) {
      // wait for the in-flight drain to settle, then ensure a final pass
      while (draining) await new Promise((r) => setTimeout(r, 0));
    }
    if (pending.size || manifestDirty) await drain();
  }

  // ---- boot restore --------------------------------------------------------
  // Replay the manifest into the VFS. Returns the number of entries restored (0
  // = nothing persisted yet). Runs BEFORE the FS worker serves any syscall, and
  // calls the VFS directly (via `access`), so it never re-enters the queue.
  async function restore(onProgress) {
    let arr;
    try {
      arr = JSON.parse(dec.decode(await (async () => {
        const fh = await base.getFileHandle(MANIFEST);
        const ah = await fh.createSyncAccessHandle();
        try {
          const size = ah.getSize();
          const buf = new Uint8Array(size);
          if (size) ah.read(buf, { at: 0 });
          return buf;
        } finally {
          ah.close();
        }
      })()));
    } catch {
      return 0; // no manifest → first run
    }
    if (!Array.isArray(arr) || arr.length === 0) return 0;

    // Seed our in-memory index so future drains diff against it.
    for (const [path, m] of arr) meta.set(path, m);

    // Recreate in a safe order: dirs (shallow → deep), then files, then symlinks
    // (a symlink's target may live anywhere in the tree).
    const order = { dir: 0, file: 1, symlink: 2 };
    const sorted = [...arr].sort((a, b) => {
      const ka = order[a[1].k] ?? 1;
      const kb = order[b[1].k] ?? 1;
      if (ka !== kb) return ka - kb;
      return parts(a[0]).length - parts(b[0]).length; // shallower first
    });

    const total = sorted.length;
    let n = 0;
    if (typeof onProgress === "function") onProgress(0, total);
    // Sequential replay. An earlier attempt to overlap the per-file OPFS reads
    // with bounded concurrency stalled near the end of a large restore: opening
    // many `createSyncAccessHandle`s at once runs into OPFS's exclusive-lock /
    // handle-count limits and some acquisitions never settle, wedging boot. The
    // durable speed-up for a big node_modules is the lockfile-keyed dependency
    // cache (restore a single snapshot), not parallelizing this per-file loop.
    for (const [path, m] of sorted) {
      try {
        if (m.k === "dir") {
          access.mkdirp(path);
        } else if (m.k === "file") {
          const slash = path.lastIndexOf("/");
          if (slash > 0) access.mkdirp(path.slice(0, slash));
          access.writeFile(path, await readBytes(path));
        } else if (m.k === "symlink") {
          const slash = path.lastIndexOf("/");
          if (slash > 0) access.mkdirp(path.slice(0, slash));
          access.symlink(m.t, path);
        }
        n++;
        // Report roughly every 5% (min every 200 entries) so a big node_modules
        // restore shows a moving count instead of a long silent stall.
        if (typeof onProgress === "function" && n % Math.max(200, Math.ceil(total / 20)) === 0)
          onProgress(n, total);
      } catch {
        /* skip a corrupt entry, keep restoring the rest */
      }
    }
    if (typeof onProgress === "function") onProgress(n, total);
    return n;
  }

  return { onWrite, onDelete, onRename, flush, restore };
}