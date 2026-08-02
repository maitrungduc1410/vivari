"use client";

// @vivari/react — React bindings for the Vivari WebContainer SDK.
//
// Drop-in:
//
//   import { Vivari } from "@vivari/react";
//
//   <Vivari files={tree} run="npm run dev" style={{ height: 480 }} />
//
// Or compose the pieces:
//
//   <VivariProvider>
//     <Editor />                        {/* useVivariFile("/src/App.jsx") */}
//     <VivariPreview port={5173} />
//   </VivariProvider>
//
// NAMING: `Vivari` here is the React *component*. The core *class* — what
// `Vivari.boot()` returns and what every hook hands you — is re-exported as the
// type `VivariInstance`, because a React consumer only ever sees it in type
// position (the hooks construct it for you). To call `Vivari.boot()` yourself,
// import the class from `@vivari/core` directly; it is a peer dependency, so
// you already have exactly one copy of it.

export { Vivari } from "./Vivari";
export type { VivariProps, VivariFailure, VivariPhase } from "./Vivari";
export { VivariPreview } from "./VivariPreview";
export type { VivariPreviewProps } from "./VivariPreview";
export { VivariProvider, useVivariContext, useVivariInstance } from "./context";
export type { VivariProviderProps } from "./context";
export { useVivari } from "./useVivari";
export type {
  UseVivariOptions,
  UseVivariResult,
  VivariState,
  VivariStatus,
  VivariUnsupportedReason,
} from "./useVivari";
export { useSpawn } from "./useSpawn";
export type { SpawnStatus, UseSpawnOptions, UseSpawnResult } from "./useSpawn";
export { useVivariFile } from "./useVivariFile";
export type {
  UseVivariFileHandle,
  UseVivariFileOptions,
  VivariFileStatus,
} from "./useVivariFile";
export { useVivariDir } from "./useVivariDir";
export type { UseVivariDirOptions, UseVivariDirResult, VivariDirStatus } from "./useVivariDir";

// Core values a React embedder needs at the call site. `isCrossOriginIsolated`
// is the pre-flight check every host page should run, `resetVfs` backs a "reset
// everything" button, and the error classes are re-exported as values so
// `instanceof` works without a second import.
//
// `KernelBridge` is deliberately NOT re-exported: it is core's escape hatch
// (`vivari.internal`), and reaching for it should be an explicit `@vivari/core`
// import, not something these bindings normalise.
export { isCrossOriginIsolated, resetVfs, VivariError, VivariFsError } from "@vivari/core";

// Every type on the wrapped surface, so a consumer never has to also import from
// @vivari/core just to annotate a variable. (`PreviewMode` and `RequestOptions`
// are omitted with `KernelBridge` — they only describe that escape hatch.)
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
  FileSystemAPI,
  FileSystemTree,
  FsChangeEvent,
  FsChangeKind,
  FsChangeListener,
  FsOperationOptions,
  FSWatcher,
  KernelMessage,
  ListenerOptions,
  MountOptions,
  OutputStream,
  PortKind,
  PortListener,
  ServerReadyListener,
  SpawnOptions,
  Stats,
  Unsubscribe,
  VivariEventMap,
  VivariErrorCode,
  VivariFsErrorCode,
  VivariListener,
  VivariProcess,
  VivariRuntimeErrorCode,
  WatchOptions,
  Vivari as VivariInstance,
} from "@vivari/core";