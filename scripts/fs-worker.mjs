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

function createMemoryStorage() {
  const map = new Map();
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
