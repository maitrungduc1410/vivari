// Bridge to the OpenContainer kernel worker.
//
// This is the studio's single point of contact with the runtime. It boots the
// kernel worker (which itself spawns the fs / fetcher / process workers and the
// Rust/Wasm VFS), registers the preview Service Worker and relays its HTTP
// requests into the VM, and exposes a tiny typed pub/sub over the worker's
// message protocol. All of the message shapes below mirror packages/demo's
// kernel-worker.js — the source of truth we bundle here via Vite.
//
// Vite bundles the worker + its nested `new Worker(new URL('./fs-worker.js' |
// './process-worker.js', import.meta.url))` and every `new URL('../*/pkg/*_bg
// .wasm', import.meta.url)` asset, all served same-origin so COEP is satisfied.

// Messages the kernel worker posts back to us. Loosely typed on purpose — the
// consumer switches on `type`; extra fields ride along per message.
export interface KernelMessage {
  type: string;
  [key: string]: unknown;
}

type Handler = (m: KernelMessage) => void;

export class KernelBridge {
  readonly worker: Worker;
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly anyHandlers = new Set<Handler>();
  private swRegistered = false;
  // Correlation table for request()/oc-reply round-trips (readdir, read, etc.).
  private readonly pending = new Map<number, (m: KernelMessage) => void>();
  private reqSeq = 1;

  constructor() {
    this.worker = new Worker(
      new URL("../../../demo/kernel-worker.js", import.meta.url),
      { type: "module", name: "Kernel Worker" },
    );
    this.worker.onmessage = (event: MessageEvent<KernelMessage>) => {
      const m = event.data;
      if (m.type === "oc-reply") {
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
    addEventListener("pagehide", () =>
      this.worker.postMessage({ type: "fs-flush" }),
    );

    // Reverse HMR tunnel: the preview iframe's WebSocket shim posts connection
    // events UP to this window; relay them down to the kernel worker.
    addEventListener("message", (event: MessageEvent) => {
      const d = event.data;
      if (!d || d.type !== "oc-ws" || d.dir !== "out") return;
      this.worker.postMessage({ type: "oc-ws", msg: d });
    });
  }

  /** Subscribe to one message `type`. Returns an unsubscribe fn. */
  on(type: string, handler: Handler): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  /** Subscribe to every message (used for the read-only Console + debugging). */
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
   * when the worker answers with `{type:"oc-reply", reqId, ...}`. Used for VFS
   * queries (readdir/read/stat) and project creation.
   */
  request(type: string, extra?: Record<string, unknown>): Promise<KernelMessage> {
    const reqId = this.reqSeq++;
    return new Promise((resolve) => {
      this.pending.set(reqId, resolve);
      this.worker.postMessage({ type, reqId, ...extra });
    });
  }

  /** Register the preview Service Worker and wire its HTTP relay into the VM. */
  async registerServiceWorker(): Promise<boolean> {
    if (this.swRegistered) return true;
    if (!("serviceWorker" in navigator)) return false;
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    // The SW posts each preview request here; forward it to the kernel worker,
    // transferring the reply port so the worker answers the SW directly.
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type !== "oc-http") return;
      this.worker.postMessage({ type: "oc-http", req: event.data.req }, [
        event.ports[0],
      ]);
    });
    this.swRegistered = true;
    return true;
  }

  /**
   * Tell the preview Service Worker which in-VM ports serve UNDER the
   * `/preview/<port>/` proxy prefix (keep-prefix templates like Docusaurus) so it
   * doesn't strip the prefix for them. Safe to call before the SW is active — it
   * resolves against the ready registration.
   */
  setKeepPrefixPorts(ports: number[]): void {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready
      .then((reg) => {
        const sw = reg.active || navigator.serviceWorker.controller;
        sw?.postMessage({ type: "oc-keep-prefix-ports", ports });
      })
      .catch(() => {});
  }

  /** Start the kernel (spawns fs/fetcher workers + VFS, then posts `ready`). */
  boot() {
    this.worker.postMessage({ type: "init" });
  }
}

/** Is the page cross-origin isolated (SharedArrayBuffer available)? */
export function isCrossOriginIsolated(): boolean {
  return typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated;
}

/** `?reset` wipes the OPFS-mirrored VFS before boot (clean slate). */
export async function maybeResetVfs(): Promise<boolean> {
  if (!new URLSearchParams(location.search).has("reset")) return false;
  try {
    const dir = await navigator.storage.getDirectory();
    await dir.removeEntry("oc-vfs", { recursive: true });
    return true;
  } catch {
    return false; // nothing persisted yet
  }
}
