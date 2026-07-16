// The File System Worker (Phase 2 #14), browser side.
//
// It owns the single Rust/Wasm VirtualFileSystem and nothing else. The kernel
// used to hold the VFS and service every fs syscall on its own thread; now that
// work happens here, off the kernel's critical path. Each client (the kernel and
// every process) shares its SAB with us; a doorbell tells us which one has a
// request pending and FsServer runs it against the VFS and wakes the caller.
//
// Spawned as a *nested* worker from the kernel worker, like the Fetcher Worker.
//
// Persistence (OPFS): this worker is also where the VFS is mirrored to the
// Origin Private File System so a project survives reload. OPFS sync access
// handles are only available inside a Worker — this one — which is exactly why
// the adapter lives here. On boot we restore the manifest into the VFS BEFORE
// serving any syscall; afterwards FsServer forwards mutations to the adapter.

import initKernel, { VirtualFileSystem } from "../../../vfs/pkg/vivari_vfs.js";
import { FsServer } from "../../../kernel-host/fs-server.js";
import { createOpfsPersistence } from "../../../kernel-host/opfs-persistence.js";

const post = (type, extra) => self.postMessage({ type, ...extra });

let server = null;
let vfsRef = null; // the live VFS, set as soon as it's constructed (pre-restore)
let compressionOn = false; // whole-file lazy compression gate (URL ?compress=1)
const queue = []; // messages that arrive before the VFS finishes booting

// Apply the current compression gate to the VFS. Guarded so an older wasm build
// without set_compression simply ignores the flag instead of throwing.
function applyCompression() {
  if (vfsRef && typeof vfsRef.set_compression === "function") {
    try {
      vfsRef.set_compression(compressionOn);
    } catch {
      /* older build — no-op */
    }
  }
}

function handle(msg) {
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
        post("fs-write-large-ok", { id: msg.id });
      } catch (err) {
        post("fs-write-large-err", { id: msg.id, error: String(err?.message || err) });
      }
      break;
    case "fs-write-batch":
      try {
        const n = server.writeBatch(msg.entries, msg.buffer);
        post("fs-write-batch-ok", { id: msg.id, count: n });
      } catch (err) {
        post("fs-write-batch-err", { id: msg.id, error: String(err?.message || err) });
      }
      break;
    case "fs-flush": // page is hiding — best-effort force the mirror to disk
      if (server && server.persistence) server.persistence.flush();
      break;
    case "fs-mem": {
      // Diagnostic: report the VFS's in-RAM content footprint (see the studio's
      // memory readout). Guarded so an older wasm build without mem_bytes/
      // file_count still answers (with -1) instead of throwing.
      const vfs = server && server.vfs;
      const bytes = vfs && typeof vfs.mem_bytes === "function" ? vfs.mem_bytes() : -1;
      const files = vfs && typeof vfs.file_count === "function" ? vfs.file_count() : -1;
      // Logical (uncompressed) footprint, so the readout can show the ratio.
      const logical =
        vfs && typeof vfs.logical_mem_bytes === "function" ? vfs.logical_mem_bytes() : -1;
      post("fs-mem", { id: msg.id, bytes, files, logical });
      break;
    }
    case "fs-set-compression":
      compressionOn = !!msg.on;
      applyCompression();
      break;
  }
}

self.onmessage = (event) => {
  const d = event.data;
  // The compression gate can arrive before the VFS finishes booting; honor it
  // immediately (and again once the VFS exists) so it takes effect before the
  // OPFS restore, letting restored files compress on write.
  if (d && d.type === "fs-set-compression") {
    compressionOn = !!d.on;
    applyCompression();
    return;
  }
  if (server) handle(d);
  else queue.push(d);
};

// A small vfs-bound facade the OPFS adapter uses to read current state and to
// replay a restore. Keeps the adapter free of any wasm-VFS dependency.
function buildAccess(vfs) {
  return {
    // Current truth for one path (following nothing: lstat, so symlinks report
    // as symlinks). Returns null if the path is gone.
    read(path) {
      let m;
      try {
        m = JSON.parse(vfs.lstat(path));
      } catch {
        return null;
      }
      if (m.kind === "dir") return { kind: "dir", mode: m.mode };
      if (m.kind === "symlink") return { kind: "symlink", mode: m.mode, target: vfs.readlink(path) };
      return { kind: "file", mode: m.mode, bytes: vfs.read_file(path) };
    },
    // Every path under `path` (inclusive), used to re-mirror a renamed subtree.
    walk(path) {
      const out = [];
      const rec = (p) => {
        let m;
        try {
          m = JSON.parse(vfs.lstat(p));
        } catch {
          return;
        }
        out.push(p);
        if (m.kind === "dir") {
          let kids = [];
          try {
            kids = vfs.readdir(p);
          } catch {
            /* not a dir anymore */
          }
          for (const k of kids) rec(p === "/" ? "/" + k : p + "/" + k);
        }
      };
      rec(path);
      return out;
    },
    mkdirp(path) {
      try {
        vfs.mkdir(path, true);
      } catch {
        /* exists */
      }
    },
    writeFile(path, bytes) {
      try {
        vfs.write_file(path, bytes);
      } catch {
        /* parent missing / restore race — skip */
      }
    },
    symlink(target, path) {
      try {
        vfs.symlink(target, path);
      } catch {
        /* exists */
      }
    },
  };
}

// System/volatile dirs we never persist: coreutils are re-installed each boot,
// and /tmp, /proc, /dev are ephemeral by definition. Everything else (your
// /app, node_modules, /data, the package-manager caches under /home/user/.cache,
// …) is mirrored.
// /etc and /usr are re-seeded by the VFS constructor every boot (os-release, ldd),
// so persisting them is redundant and would let a stale copy shadow a changed seed.
// /var/cache holds the kernel's transient outbound-fetch buffer (vv-fetch): its
// in-memory index is rebuilt per session and never read back across reloads, so
// persisting those tarball bodies is pure dead weight — the durable, reusable copy
// is npm/yarn/pnpm's own content-addressed cache under /home/user/.cache.
const IGNORE = ["/bin", "/tmp", "/proc", "/dev", "/etc", "/usr", "/var/cache"];
const shouldPersist = (p) => {
  for (const pre of IGNORE) if (p === pre || p.startsWith(pre + "/")) return false;
  return true;
};

(async () => {
  // Pass the wasm URL explicitly instead of relying on the glue's default
  // `new URL('..._bg.wasm', import.meta.url)`. When this worker is bundled the
  // glue is inlined here, so its default would resolve next to the bundle
  // and 404. The sibling-dir "../../../vfs/pkg/" form is correct both in the
  // Vite dev server and in the studio build.
  post("log", { line: "  [boot] initializing virtual file system…", cls: "muted" });
  await initKernel(new URL("../../../vfs/pkg/vivari_vfs_bg.wasm", import.meta.url));
  const vfs = new VirtualFileSystem();
  // Honor a compression flag that may have arrived before the VFS existed, so it
  // is in force before the OPFS restore below.
  vfsRef = vfs;
  applyCompression();

  // Best-effort OPFS persistence. If the API is missing or throws (private
  // mode, quota, older engine), we run exactly like before — purely in RAM.
  let persistence = null;
  try {
    if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.getDirectory) {
      persistence = await createOpfsPersistence({ access: buildAccess(vfs), shouldPersist });
      // Restoring a saved project (esp. its node_modules) can take a while — the
      // VFS is re-hydrated entry-by-entry. Report progress so the user knows the
      // "stall" is real work, not a hang. Only chatter when there's a lot to do.
      const t0 = Date.now();
      let announced = false;
      const n = await persistence.restore((done, total) => {
        if (total < 400) return; // small project: restore is instant, stay quiet
        if (!announced) {
          post("log", { line: `  [opfs] restoring saved project (${total} entries)…`, cls: "muted" });
          announced = true;
        } else if (done && done < total) {
          post("log", { line: `  [opfs] restoring… ${done}/${total}`, cls: "muted" });
        }
      });
      if (n > 0)
        post("log", {
          line: `  [opfs] restored ${n} entries from a previous session (${Date.now() - t0}ms)`,
          cls: "muted",
        });
    }
  } catch (err) {
    post("log", { line: "  [opfs] persistence unavailable: " + (err?.message || err), cls: "muted" });
    persistence = null;
  }

  server = new FsServer(vfs, persistence);
  post("ready");
  for (const msg of queue.splice(0)) handle(msg);
})();
