// The File System Worker (Phase 2 #14), headless side — the Node worker_threads
// twin of packages/demo/fs-worker.js. Owns the Rust/Wasm VFS (nodejs target,
// loaded synchronously) and services fs syscalls for the kernel and every
// process over their SABs, off the kernel's thread.

import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
import { FsServer } from "../packages/kernel-host/fs-server.js";

const require = createRequire(import.meta.url);
const wasm = require("../packages/vfs/pkg-node/open_webcontainer_vfs.js");

const server = new FsServer(new wasm.VirtualFileSystem());

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
  }
});

parentPort.postMessage({ type: "ready" });
