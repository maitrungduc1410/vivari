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

  // Mode B (separate preview origin): the origin that hosts the preview SW +
  // bridge doc. Empty string / undefined = mode A (same-origin previews).
  private readonly previewOrigin?: string;
  // The hidden bridge iframe (on the preview origin) and the persistent port to
  // the SW living there. Only used in mode B.
  private bridgeFrame?: HTMLIFrameElement;
  private kernelPort?: MessagePort;
  // Latest config to (re)send to the preview SW over the port on each connect
  // (the SW loses in-memory state when revived).
  private pendingKeepPrefix?: number[];
  private pendingDevtools?: boolean;

  constructor(options: { workerName?: string; previewOrigin?: string } = {}) {
    // Only treat a *different* origin as mode B; an accidental same-origin value
    // stays on the simpler same-origin path.
    const here = typeof location !== "undefined" ? location.origin : "";
    this.previewOrigin =
      options.previewOrigin && options.previewOrigin !== here ? options.previewOrigin : undefined;
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
      // events UP to this window; relay them down to the kernel worker. In mode B
      // the preview iframe is cross-origin, so only trust messages from the
      // preview origin (its `parent` is still this window).
      addEventListener("message", (event: MessageEvent) => {
        if (this.previewOrigin && event.origin !== this.previewOrigin) return;
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

  /**
   * The origin prefix to build preview URLs with. Empty string in mode A (so
   * URLs stay relative/same-origin); the preview origin in mode B.
   */
  get previewBase(): string {
    return this.previewOrigin ?? "";
  }

  /** Register the preview Service Worker and wire its HTTP relay into the VM. */
  async registerServiceWorker(url = "/sw.js"): Promise<boolean> {
    if (this.swRegistered) return true;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return false;
    // Mode B: the SW lives on a different origin — we can't register it here.
    // Load a hidden bridge doc there that registers it and hands us a port.
    if (this.previewOrigin) return this.setupPreviewBridge(url);
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
      const d = event.data;
      if (d?.type === "vv-http") {
        this.worker.postMessage({ type: "vv-http", req: d.req }, [event.ports[0]]);
        return;
      }
      // ws/SSE from a preview opened in its OWN tab (COOP severs window.opener, so
      // it can't reach us directly): the SW relays its outbound frames here. Forward
      // to the kernel exactly like the in-app iframe path (the `window` listener
      // above). Inbound frames go back out via the SW in controller's vv-ws/vv-sse
      // handlers.
      if (d && d.dir === "out" && (d.type === "vv-ws" || d.type === "vv-sse")) {
        this.worker.postMessage({ type: d.type as string, msg: d });
      }
    });
    // Tell the SW this client hosts the kernel, so it routes preview HTTP here
    // even when Vivari runs in a nested iframe (the docs /embed/ playground): the
    // SW's "top-level window" fallback would otherwise pick the host document,
    // which has no kernel. Re-announce on controllerchange (SW update/claim).
    this.announceKernelHost();
    navigator.serviceWorker.addEventListener("controllerchange", () =>
      this.announceKernelHost(),
    );
    this.swRegistered = true;
    return true;
  }

  // ── Mode B: separate preview origin ───────────────────────────────────────
  //
  // We can't register a cross-origin SW from here, so we load a hidden bridge
  // document on the preview origin. It registers `sw.js` (same-origin to it) and
  // relays a MessagePort we create back to that SW. Thereafter every preview HTTP
  // request the SW intercepts is posted to us over the port (with a per-request
  // reply port), and we forward it to the kernel exactly like the same-origin
  // path — no server, no network, just a different origin.
  private async setupPreviewBridge(swUrl: string): Promise<boolean> {
    if (typeof document === "undefined" || typeof window === "undefined") return false;
    const origin = this.previewOrigin!;
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.setAttribute("tabindex", "-1");
    iframe.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden;left:-9999px";
    iframe.src =
      `${origin}/__vv-bridge.html?ide=${encodeURIComponent(location.origin)}` +
      `&sw=${encodeURIComponent(swUrl)}`;

    const ready = new Promise<boolean>((resolve) => {
      const onMsg = (event: MessageEvent) => {
        if (event.origin !== origin || !event.data || event.data.type !== "vv-bridge-ready") return;
        window.removeEventListener("message", onMsg);
        resolve(true);
      };
      window.addEventListener("message", onMsg);
      setTimeout(() => {
        window.removeEventListener("message", onMsg);
        resolve(false);
      }, 15000);
    });
    document.body.appendChild(iframe);
    this.bridgeFrame = iframe;
    if (!(await ready)) return false;

    this.connectPort();
    // The SW is evicted when idle, losing the in-memory port. The bridge doc
    // notices (its `controllerchange` / a probe) and asks us to re-hand a port.
    window.addEventListener("message", (event: MessageEvent) => {
      if (event.origin !== origin || !event.data || event.data.type !== "vv-need-connect") return;
      this.connectPort();
    });
    this.swRegistered = true;
    return true;
  }

  // Create a fresh MessageChannel, keep one end, and ship the other to the
  // preview SW via the bridge iframe. Also (re)push the current keep-prefix +
  // DevTools config, since a revived SW starts blank.
  private connectPort(): void {
    const origin = this.previewOrigin;
    const win = this.bridgeFrame?.contentWindow;
    if (!origin || !win) return;
    const mc = new MessageChannel();
    this.kernelPort = mc.port1;
    mc.port1.onmessage = (event) => this.onKernelPortMessage(event);
    win.postMessage({ type: "vv-connect" }, origin, [mc.port2]);
    if (this.pendingKeepPrefix) mc.port1.postMessage({ type: "vv-keep-prefix-ports", ports: this.pendingKeepPrefix });
    if (this.pendingDevtools !== undefined) mc.port1.postMessage({ type: "vv-devtools", enabled: this.pendingDevtools });
  }

  // Messages the preview SW sends us over the persistent port (mode B mirror of
  // the same-origin `navigator.serviceWorker` message handler above).
  private onKernelPortMessage(event: MessageEvent): void {
    const d = event.data;
    if (!d) return;
    if (d.type === "vv-http") {
      this.worker.postMessage({ type: "vv-http", req: d.req }, event.ports[0] ? [event.ports[0]] : []);
      return;
    }
    if (d.dir === "out" && (d.type === "vv-ws" || d.type === "vv-sse")) {
      this.worker.postMessage({ type: d.type as string, msg: d });
    }
  }

  /**
   * Relay a payload to the preview Service Worker (e.g. inbound ws/SSE frames for
   * a preview opened in its own tab). Mode B routes it over the persistent port;
   * mode A hands it to the same-origin controlling SW.
   */
  postToPreviewSW(payload: object): void {
    if (this.previewOrigin) {
      this.kernelPort?.postMessage(payload);
      return;
    }
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.controller?.postMessage(payload);
  }

  /**
   * Announce to the preview Service Worker that this page hosts the kernel, so it
   * can route `/preview/<port>/` requests to this client. Safe to call repeatedly;
   * a no-op when there's no controlling SW yet. In mode B the SW routes over the
   * persistent port instead, so this is unnecessary.
   */
  announceKernelHost(): void {
    if (this.previewOrigin) return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.controller?.postMessage({ type: "vv-kernel-host" });
  }

  /**
   * Tell the preview Service Worker which in-VM ports serve UNDER the
   * `/preview/<port>/` proxy prefix (keep-prefix templates like Docusaurus) so it
   * doesn't strip the prefix for them. Safe to call before the SW is active.
   */
  setKeepPrefixPorts(ports: number[]): void {
    // Mode B: send over the persistent port (and remember it so a revived SW is
    // reconfigured on reconnect).
    if (this.previewOrigin) {
      this.pendingKeepPrefix = ports;
      this.kernelPort?.postMessage({ type: "vv-keep-prefix-ports", ports });
      return;
    }
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
    if (this.previewOrigin) {
      this.pendingDevtools = enabled;
      this.kernelPort?.postMessage({ type: "vv-devtools", enabled });
      return;
    }
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
    this.kernelPort?.close();
    this.kernelPort = undefined;
    this.bridgeFrame?.remove();
    this.bridgeFrame = undefined;
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
 * Wipe the OPFS-mirrored VFS (clean slate). Returns whether anything was
 * removed. Studio calls this from its Home "Reset everything" button (after
 * tearing down the worker so OPFS handles are released); SDK consumers can call
 * it directly to reset persisted state. Also drops the persistent dependency
 * cache (node_modules snapshots keyed by lockfile) so a reset is a true clean
 * slate, not one that silently re-restores deps from a stale snapshot.
 */
export async function resetVfs(): Promise<boolean> {
  let removed = false;
  const dir = await navigator.storage.getDirectory().catch(() => null);
  if (!dir) return false;
  for (const name of ["vv-vfs", "vv-depcache"]) {
    try {
      await dir.removeEntry(name, { recursive: true });
      removed = true;
    } catch {
      /* nothing persisted under this root yet */
    }
  }
  return removed;
}