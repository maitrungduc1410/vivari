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
//   for await (const chunk of proc.output) console.log(chunk);
//   await proc.exit;
//
// The page must be cross-origin isolated (COOP + COEP) — see the README.
//
// Relative specifiers carry their `.js` extension throughout this package so the
// emitted declarations resolve under `moduleResolution: node16`/`nodenext`, not
// only under `bundler`.

export { Vivari } from "./vivari.js";
export { VivariError, VivariFsError } from "./errors.js";
export { KernelBridge, isCrossOriginIsolated, resetVfs } from "./bridge.js";

// Classes a consumer receives but never constructs. Exported as types only: their
// constructors take internal transport objects and, in VivariProcess's case, an
// `execId` that must come from the owning Vivari instance's sequence.
export type { FileSystemAPI, FSWatcher } from "./fs.js";
export type { OutputStream, VivariProcess } from "./process.js";
export type { PreviewMode, RequestOptions } from "./bridge.js";

export type {
  VivariErrorCode,
  VivariFsErrorCode,
  VivariRuntimeErrorCode,
} from "./errors.js";

export type {
  BootOptions,
  DirectoryNode,
  DirEnt,
  Encoding,
  ErrorListener,
  ExportedFile,
  ExportOptions,
  ExportResult,
  FileNode,
  FileSystemTree,
  FsChangeEvent,
  FsChangeKind,
  FsChangeListener,
  FsOperationOptions,
  KernelMessage,
  ListenerOptions,
  MountOptions,
  PortKind,
  PortListener,
  ServerReadyListener,
  SpawnOptions,
  Stats,
  Unsubscribe,
  VivariEventMap,
  VivariListener,
  WatchOptions,
} from "./types.js";