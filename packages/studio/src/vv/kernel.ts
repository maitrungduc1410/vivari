// Studio's bridge to the Vivari kernel worker.
//
// The transport, the worker (and its nested fs/fetcher/process workers), the
// Rust/Wasm VFS, and the preview Service Worker relay all live in `@vivari/core`
// now — Studio is just the first (and richest) consumer of that SDK. This file
// is a thin re-export of the core surface Studio needs. VFS whole-file lazy
// compression is always on (the core boot default); the "reset everything" flow
// calls `resetVfs()` directly from the Home screen instead of a URL flag.

export { KernelBridge, isCrossOriginIsolated, resetVfs } from "@vivari/core";
export type { KernelMessage } from "@vivari/core";