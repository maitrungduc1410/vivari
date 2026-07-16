// Studio's bridge to the Vivari kernel worker.
//
// The transport, the worker (and its nested fs/fetcher/process workers), the
// Rust/Wasm VFS, and the preview Service Worker relay all live in `@vivari/core`
// now — Studio is just the first (and richest) consumer of that SDK. This file is
// a thin extension: it re-exports the core bridge and layers on the two
// studio-specific URL conventions (`?compress=0` and `?reset`).

import {
  KernelBridge as CoreKernelBridge,
  isCrossOriginIsolated,
  resetVfs,
} from "@vivari/core";

export { isCrossOriginIsolated };
export type { KernelMessage } from "@vivari/core";

/** The core bridge, with Studio's `?compress=0` boot toggle wired in. */
export class KernelBridge extends CoreKernelBridge {
  boot() {
    // VFS whole-file lazy compression is ON by default; `?compress=0` is the
    // escape hatch to disable it for A/B comparison or debugging.
    const compress = new URLSearchParams(location.search).get("compress") !== "0";
    super.boot(compress);
  }
}

/** `?reset` wipes the OPFS-mirrored VFS before boot (clean slate). */
export async function maybeResetVfs(): Promise<boolean> {
  if (!new URLSearchParams(location.search).has("reset")) return false;
  return resetVfs();
}
