// The File System Worker (Phase 2 #14), browser side.
//
// It owns the single Rust/Wasm VirtualFileSystem and nothing else. The kernel
// used to hold the VFS and service every fs syscall on its own thread; now that
// work happens here, off the kernel's critical path. Each client (the kernel and
// every process) shares its SAB with us; a doorbell tells us which one has a
// request pending and FsServer runs it against the VFS and wakes the caller.
//
// Spawned as a *nested* worker from the kernel worker, like the Fetcher Worker.

import initKernel, { VirtualFileSystem } from "../kernel/pkg/open_webcontainer_kernel.js";
import { FsServer } from "../kernel-host/fs-server.js";

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
  }
}

self.onmessage = (event) => {
  if (server) handle(event.data);
  else queue.push(event.data);
};

(async () => {
  await initKernel();
  server = new FsServer(new VirtualFileSystem());
  post("ready");
  for (const msg of queue.splice(0)) handle(msg);
})();
