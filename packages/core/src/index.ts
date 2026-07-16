// @vivari/core — run Node.js projects fully client-side in the browser.
//
// Quick start:
//
//   import { Vivari } from "@vivari/core";
//
//   const vivari = await Vivari.boot();
//   await vivari.mount({
//     "package.json": { file: { contents: '{"type":"module"}' } },
//     "index.js": { file: { contents: "console.log('hello from the browser')" } },
//   });
//   const proc = await vivari.spawn("node", ["index.js"]);
//   proc.output.pipeTo(new WritableStream({ write: (c) => console.log(c) }));
//   await proc.exit;
//
// The page must be cross-origin isolated (COOP + COEP) — see the README.

export { Vivari } from "./vivari";
export { FileSystemAPI } from "./fs";
export { VivariProcess } from "./process";
export { previewUrl } from "./preview";
export { KernelBridge, isCrossOriginIsolated, resetVfs } from "./bridge";

export type {
  BootOptions,
  DirectoryNode,
  DirEnt,
  ErrorListener,
  FileNode,
  FileSystemTree,
  KernelMessage,
  PortListener,
  ServerReadyListener,
  SpawnOptions,
  VivariEventMap,
} from "./types";
