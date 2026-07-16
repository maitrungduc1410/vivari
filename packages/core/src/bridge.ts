// Low-level transport to the Vivari kernel worker.
//
// This is the single point of contact with the runtime: it boots the kernel
// worker (which itself spawns the fs / fetcher / process workers and the
// Rust/Wasm VFS), optionally registers the preview Service Worker and relays its
// HTTP requests into the VM, and exposes a tiny typed pub/sub over the worker's
// message protocol. It is framework-agnostic — the higher-level `Vivari` facade
// (and the `@vivari/react` bindings) are built on top of it, but you can also use
// it directly for full control over the message vocabulary.
//
// A bundler (Vite/Rollup/webpack 5/esbuild) resolves the worker below plus its
// nested `new Worker(new URL('./fs-worker.ts' | './process-worker.ts' |
// './fetcher-worker.ts', import.meta.url))` and every `new URL('../*/pkg/*_bg
// .wasm', import.meta.url)` asset, emitting them beside the package so everything
// is served same-origin (which COEP requires).

import type { KernelMessage } from "./types";

type Handler = (m: KernelMessage) => void;

export class KernelBridge {
  readonly worker: Worker;
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly anyHandlers = new Set<Handler>();
  private swRegistered = false;
  // Correlation table for request()/vv-reply round-trips (readdir, read, etc.).
  private readonly pending = new Map<number, (m: KernelMessage) => void>();
  private reqSeq = 1;

  constructor(options: { workerName?: string } = {}) {
    this.worker = new Worker(
      new URL("./workers/kernel-worker.ts", import.meta.url),
      { type: "module", name: options.workerName ?? "Vivari Kernel" },
    );
    this.worker.onmessage = (event: MessageEvent<KernelMessage>) => {
      const m = event.data;
      if (m.type === "vv-reply") {
        const resolve = this.pending.get(m.reqId as number);
        if (resolve) {
          this.pending.delete(m.reqId as number);
          resolve(m);
        }
        return;
      }
      this.emit(m);
    };

    // Best-effort flush of the OPFS write-behind buffer as the page goes away.
    if (typeof addEventListener === "function") {
      addEventListener("pagehide", () =>
        this.worker.postMessage({ type: "fs-flush" }),
      );

      // Reverse HMR tunnel: the preview iframe's WebSocket shim posts connection
      // events UP to this window; relay them down to the kernel worker.
      addEventListener("message", (event: MessageEvent) => {
        const d = event.data;
        if (!d || d.dir !== "out" || (d.type !== "vv-ws" && d.type !== "vv-sse")) return;
        this.worker.postMessage({ type: d.type as string, msg: d });
      });
    }
  }

  /** Subscribe to one message `type`. Returns an unsubscribe fn. */
  on(type: string, handler: Handler): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  /** Subscribe to every message (used for a read-only Console + debugging). */
  onAny(handler: Handler): () => void {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  private emit(m: KernelMessage) {
    const set = this.handlers.get(m.type);
    if (set) for (const h of set) h(m);
    for (const h of this.anyHandlers) h(m);
  }

  /** Post a message to the kernel worker (optionally transferring objects). */
  post(type: string, extra?: Record<string, unknown>, transfer?: Transferable[]) {
    this.worker.postMessage({ type, ...extra }, transfer ?? []);
  }

  /**
   * Request/response round-trip: post `type` with a correlation id and resolve
   * when the worker answers with `{type:"vv-reply", reqId, ...}`. Used for VFS
   * queries (readdir/read/stat), writes, and file operations.
   */
  request(type: string, extra?: Record<string, unknown>): Promise<KernelMessage> {
    const reqId = this.reqSeq++;
    return new Promise((resolve) => {
      this.pending.set(reqId, resolve);
      this.worker.postMessage({ type, reqId, ...extra });
    });
  }

  /** Register the preview Service Worker and wire its HTTP relay into the VM. */
  async registerServiceWorker(url = "/sw.js"): Promise<boolean> {
    if (this.swRegistered) return true;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return false;
    await navigator.serviceWorker.register(url, { scope: "/" });
    await navigator.serviceWorker.ready;
    // On a fresh load the document was fetched before the SW existed, so the page
    // isn't controlled yet even though the SW is active. Wait for `clients.claim()`
    // to take effect (controllerchange) so that preview iframes created afterwards
    // are actually intercepted by the SW instead of escaping to the network.
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        navigator.serviceWorker.addEventListener("controllerchange", done, { once: true });
        setTimeout(done, 1000); // safety net: claim may already be in flight
      });
    }
    // The SW posts each preview request here; forward it to the kernel worker,
    // transferring the reply port so the worker answers the SW directly.
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type !== "vv-http") return;
      this.worker.postMessage({ type: "vv-http", req: event.data.req }, [
        event.ports[0],
      ]);
    });
    this.swRegistered = true;
    return true;
  }

  /**
   * Tell the preview Service Worker which in-VM ports serve UNDER the
   * `/preview/<port>/` proxy prefix (keep-prefix templates like Docusaurus) so it
   * doesn't strip the prefix for them. Safe to call before the SW is active.
   */
  setKeepPrefixPorts(ports: number[]): void {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready
      .then((reg) => {
        const sw = reg.active || navigator.serviceWorker.controller;
        sw?.postMessage({ type: "vv-keep-prefix-ports", ports });
      })
      .catch(() => {});
  }

  /**
   * Toggle whether the preview Service Worker injects Vivari's in-preview DevTools
   * backend (chobitsu + CDP) into preview pages. Off is the right default for
   * embedders that don't self-host `/vv-devtools/chobitsu.js` (avoids a per-preview
   * 404); the studio IDE leaves it on. Safe to call before the SW is active.
   */
  setDevtoolsEnabled(enabled: boolean): void {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready
      .then((reg) => {
        const sw = reg.active || navigator.serviceWorker.controller;
        sw?.postMessage({ type: "vv-devtools", enabled });
      })
      .catch(() => {});
  }

  /** Start the kernel (spawns fs/fetcher workers + VFS, then posts `ready`). */
  boot(compress = true) {
    this.worker.postMessage({ type: "init", compress });
  }

  /** Tear down the worker and all nested workers/VFS it owns. */
  destroy() {
    this.worker.terminate();
    this.handlers.clear();
    this.anyHandlers.clear();
    this.pending.clear();
  }
}

/** Is the page cross-origin isolated (SharedArrayBuffer available)? */
export function isCrossOriginIsolated(): boolean {
  return typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated;
}

/**
 * Wipe the OPFS-mirrored VFS before boot (clean slate). Returns whether anything
 * was removed. Studio calls this when the URL has `?reset`; SDK consumers can
 * call it directly to reset persisted state.
 */
export async function resetVfs(): Promise<boolean> {
  try {
    const dir = await navigator.storage.getDirectory();
    await dir.removeEntry("vv-vfs", { recursive: true });
    return true;
  } catch {
    return false; // nothing persisted yet
  }
}
