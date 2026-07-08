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

import initKernel, { VirtualFileSystem } from "../kernel/pkg/open_webcontainer_kernel.js";
import { FsServer } from "../kernel-host/fs-server.js";
import { createOpfsPersistence } from "../kernel-host/opfs-persistence.js";

const post = (type, extra) => self.postMessage({ type, ...extra });

let server = null;
const queue = []; // messages that arrive before the VFS finishes booting

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
    case "fs-flush": // page is hiding — best-effort force the mirror to disk
      if (server && server.persistence) server.persistence.flush();
      break;
  }
}

self.onmessage = (event) => {
  if (server) handle(event.data);
  else queue.push(event.data);
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
// /app, node_modules, /data, …) is mirrored.
// /etc and /usr are re-seeded by the VFS constructor every boot (os-release, ldd),
// so persisting them is redundant and would let a stale copy shadow a changed seed.
const IGNORE = ["/bin", "/tmp", "/proc", "/dev", "/etc", "/usr"];
const shouldPersist = (p) => {
  for (const pre of IGNORE) if (p === pre || p.startsWith(pre + "/")) return false;
  return true;
};

(async () => {
  await initKernel();
  const vfs = new VirtualFileSystem();

  // Best-effort OPFS persistence. If the API is missing or throws (private
  // mode, quota, older engine), we run exactly like before — purely in RAM.
  let persistence = null;
  try {
    if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.getDirectory) {
      persistence = await createOpfsPersistence({ access: buildAccess(vfs), shouldPersist });
      const n = await persistence.restore();
      if (n > 0) post("log", { line: `  [opfs] restored ${n} entries from a previous session`, cls: "muted" });
    }
  } catch (err) {
    post("log", { line: "  [opfs] persistence unavailable: " + (err?.message || err), cls: "muted" });
    persistence = null;
  }

  server = new FsServer(vfs, persistence);
  post("ready");
  for (const msg of queue.splice(0)) handle(msg);
})();
