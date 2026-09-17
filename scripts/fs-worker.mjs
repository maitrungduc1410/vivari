// The File System Worker (Phase 2 #14), headless side — the Node worker_threads
// twin of packages/studio/src/workers/fs-worker.js. Owns the Rust/Wasm VFS (nodejs target,
// loaded synchronously) and services fs syscalls for the kernel and every
// process over their SABs, off the kernel's thread.

import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
import { FsServer } from "../packages/kernel-host/fs-server.js";
import { createDepCache } from "../packages/kernel-host/dep-cache.js";

const require = createRequire(import.meta.url);
const wasm = require("../packages/vfs/pkg-node/vivari_vfs.js");

const vfs = new wasm.VirtualFileSystem();
const server = new FsServer(vfs);
// Mirror of the browser fs-worker: report a finished read of a kernel-fetched body
// so the kernel can free the scratch file. Kept in step so headless spikes exercise
// the same body lifetime the browser does.
server.onBodyConsumed = (path) => parentPort.postMessage({ type: "fetch-body-consumed", path });

// A vfs-bound facade for the dependency cache (mirror of buildAccess in the
// browser fs-worker). Headless has no OPFS, so the snapshot store is an in-memory
// Map — enough to prove the pack/restore + VFS integration the browser ships.
function buildAccess(v) {
  return {
    read(path) {
      let m;
      try { m = JSON.parse(v.lstat(path)); } catch { return null; }
      if (m.kind === "dir") return { kind: "dir", mode: m.mode };
      if (m.kind === "symlink") return { kind: "symlink", mode: m.mode, target: v.readlink(path) };
      return { kind: "file", mode: m.mode, bytes: v.read_file(path) };
    },
    walk(path) {
      const out = [];
      const rec = (p) => {
        let m;
        try { m = JSON.parse(v.lstat(p)); } catch { return; }
        out.push(p);
        if (m.kind === "dir") {
          let kids = [];
          try { kids = v.readdir(p); } catch { /* not a dir */ }
          for (const k of kids) rec(p === "/" ? "/" + k : p + "/" + k);
        }
      };
      rec(path);
      return out;
    },
    mkdirp(path) { try { v.mkdir(path, true); } catch { /* exists */ } },
    writeFile(path, bytes) { try { v.write_file(path, bytes); } catch { /* skip */ } },
    symlink(target, path) { try { v.symlink(target, path); } catch { /* exists */ } },
  };
}

let snapshotStore = null;
function createMemoryStorage() {
  const map = new Map();
  snapshotStore = map;
  return {
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, bytes) { map.set(key, bytes); },
    async delete(key) { map.delete(key); },
  };
}

let depCache = null;
const depCacheReady = (async () => {
  try {
    depCache = await createDepCache({ access: buildAccess(vfs), storage: createMemoryStorage() });
  } catch {
    depCache = null;
  }
})();

parentPort.on("message", (msg) => {
  switch (msg.type) {
    case "fs-register":
      server.register(msg.client, msg.sab, msg.port || null);
      break;
    case "fs-unregister":
      server.unregister(msg.client);
      break;
    case "fs": // the kernel's own doorbell (processes use their MessagePort)
      server.service(msg.client);
      break;
    case "fs-write-large":
      try {
        server.writeLarge(msg.path, new Uint8Array(msg.buffer, msg.byteOffset || 0, msg.byteLength));
        parentPort.postMessage({ type: "fs-write-large-ok", id: msg.id });
      } catch (err) {
        parentPort.postMessage({ type: "fs-write-large-err", id: msg.id, error: String(err?.message || err) });
      }
      break;
    case "fs-write-batch":
      try {
        const n = server.writeBatch(msg.entries, msg.buffer);
        parentPort.postMessage({ type: "fs-write-batch-ok", id: msg.id, count: n });
      } catch (err) {
        parentPort.postMessage({ type: "fs-write-batch-err", id: msg.id, error: String(err?.message || err) });
      }
      break;
    case "dep-cache-has":
      depCacheReady.then(async () => {
        try {
          parentPort.postMessage({ type: "dep-cache-has-ok", id: msg.id, has: depCache ? await depCache.has(msg.key) : false });
        } catch (err) {
          parentPort.postMessage({ type: "dep-cache-has-err", id: msg.id, error: String(err?.message || err) });
        }
      });
      break;
    case "dep-cache-save":
      depCacheReady.then(async () => {
        try {
          const result = depCache ? await depCache.save(msg.key, msg.dir, msg.aliases || []) : null;
          parentPort.postMessage({ type: "dep-cache-save-ok", id: msg.id, result });
        } catch (err) {
          parentPort.postMessage({ type: "dep-cache-save-err", id: msg.id, error: String(err?.message || err) });
        }
      });
      break;
    // Mirror of the browser fs-worker: take in a snapshot produced elsewhere (the app ships
    // one per template, built by running the install at build time) after the store has
    // validated it. Kept in step deliberately — the export side below is headless-only, but
    // if IMPORT were, headless tests would exercise a different first-run path than the
    // browser, which is the drift this file's twin has caused before.
    case "dep-cache-import":
      depCacheReady.then(async () => {
        try {
          const result = depCache
            ? await depCache.importArchive(msg.key, msg.archive, msg.aliases || [], { shipped: true })
            : null;
          parentPort.postMessage({ type: "dep-cache-import-ok", id: msg.id, result });
        } catch (err) {
          parentPort.postMessage({ type: "dep-cache-import-err", id: msg.id, error: String(err?.message || err) });
        }
      });
      break;
    // Headless-only: hand the packed archive back to the main thread so a build step can write
    // it to disk (see scripts/spike-starlight-depcache.mjs). The browser keeps snapshots in
    // OPFS and has no reason to export them.
    case "dep-cache-export":
      depCacheReady.then(() => {
        const bytes = snapshotStore && snapshotStore.get(msg.key);
        if (bytes) {
          const copy = new Uint8Array(bytes);
          parentPort.postMessage({ type: "dep-cache-export-ok", id: msg.id, bytes: copy }, [copy.buffer]);
        } else {
          parentPort.postMessage({ type: "dep-cache-export-err", id: msg.id, error: "no snapshot for key" });
        }
      });
      break;
    case "dep-cache-restore":
      depCacheReady.then(async () => {
        try {
          const count = depCache ? await depCache.restore(msg.key, msg.dir) : 0;
          parentPort.postMessage({ type: "dep-cache-restore-ok", id: msg.id, count });
        } catch (err) {
          parentPort.postMessage({ type: "dep-cache-restore-err", id: msg.id, error: String(err?.message || err) });
        }
      });
      break;
  }
});

parentPort.postMessage({ type: "ready" });