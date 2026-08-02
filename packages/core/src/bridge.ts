// Low-level transport to the Vivari kernel worker.
//
// **This is internal, unstable API.** It is reachable as `vivari.internal` and is
// NOT covered by semver: the kernel message vocabulary (`vv-mkdirp`, `proc-out`,
// …) changes whenever the runtime does, and none of it is typed beyond
// `KernelMessage`. Everything an application needs is on `Vivari`; reach in here
// only to build something the facade cannot express yet (the studio IDE does),
// and expect to fix up your call sites on any release.
//
// This is the single point of contact with the runtime: it boots the kernel
// worker (which itself spawns the fs / fetcher / process workers and the
// Rust/Wasm VFS), optionally registers the preview Service Worker and relays its
// HTTP requests into the VM, and exposes a tiny pub/sub over the worker's
// message protocol.
//
// A bundler (Vite/Rollup/webpack 5/esbuild) resolves the worker below plus its
// nested `new Worker(new URL('./fs-worker.ts' | './process-worker.ts' |
// './fetcher-worker.ts', import.meta.url))` and every `new URL('../*/pkg/*_bg
// .wasm', import.meta.url)` asset, emitting them beside the package so everything
// is served same-origin (which COEP requires).

import { VivariError } from "./errors.js";
import type { KernelMessage, Unsubscribe } from "./types.js";

type Handler = (m: KernelMessage) => void;

/** How previews are served. See BootOptions.previewOrigin / previewWildcardDomain. */
export type PreviewMode = "same-origin" | "shared" | "wildcard";

/**
 * Broadcast to every handler immediately before {@link KernelBridge.destroy} tears
 * the transport down, so long-lived subscribers (a running process's streams) can
 * settle instead of being abandoned mid-flight.
 */
export const TEARDOWN_MESSAGE = "vv-teardown";

/** Options accepted by {@link KernelBridge.request}. */
export interface RequestOptions {
  signal?: AbortSignal;
  /** Reject with `ERR_TIMEOUT` after this many ms. Unbounded when unset. */
  timeout?: number;
}

interface PendingRequest {
  resolve: (m: KernelMessage) => void;
  reject: (err: unknown) => void;
  /** Detaches the abort listener / clears the timeout, whether we settle or not. */
  dispose: () => void;
}

// One cross-origin preview bridge: the hidden iframe on a preview origin + the
// persistent MessagePort to the SW living there. Mode B has exactly one (the
// single shared preview origin); mode C has one per active port's origin.
interface PreviewConn {
  iframe?: HTMLIFrameElement;
  port?: MessagePort;
  ready?: Promise<boolean>;
}

export class KernelBridge {
  private readonly worker: Worker;
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly anyHandlers = new Set<Handler>();
  private readonly workerErrorHandlers = new Set<(message: string) => void>();
  private swRegistered = false;
  private destroyed = false;
  // Correlation table for request()/vv-reply round-trips (readdir, read, etc.).
  private readonly pending = new Map<number, PendingRequest>();
  private reqSeq = 1;
  // Every listener this bridge attached to a target it does NOT own (window,
  // navigator.serviceWorker). Without these, an instance that is torn down keeps
  // relaying preview traffic into a terminated worker for the life of the page —
  // which is exactly what happens when a component remounts.
  private readonly disposers: Array<() => void> = [];

  // Where previews are served — see PreviewMode. mode A: same-origin; mode B:
  // one shared `previewOrigin`; mode C: one origin per port under a wildcard.
  private readonly previewMode: PreviewMode;
  // Mode B (separate preview origin): the origin that hosts the preview SW +
  // bridge doc. Undefined in modes A/C.
  private readonly previewOrigin?: string;
  // Mode C (wildcard): the base domain + a random per-boot token, plus an OPTIONAL
  // hostname tag; every port gets `<token>--<port>[-<tag>].<domain>`. No tag by
  // default — on a base domain dedicated to Vivari the route is simply
  // `*.<domain>/*`. Set a tag when the domain also serves other apps: the route
  // `*-<tag>.<domain>/*` then matches only our per-port hosts. The tag is a SUFFIX
  // because Cloudflare routes only allow the `*` wildcard at the START of the host.
  private readonly wildcardDomain?: string;
  private readonly wildcardTag: string;
  private readonly previewToken: string;
  // How "Open in new tab" behaves in mode B (see BootOptions.previewPopout).
  // "isolated" opens pop-outs on the preview origin; default "same-origin" opens
  // them on the IDE origin. Ignored in mode A (pop-outs are always same-origin)
  // and mode C (pop-outs always open on the per-port origin).
  private readonly previewPopout: "same-origin" | "isolated";
  // Preview SW registration URL (remembered so mode C can set up per-port bridges
  // lazily as servers start listening).
  private swUrl = "/sw.js";
  // Cross-origin preview bridges keyed by preview origin. Mode B has one entry;
  // mode C has one per port's origin. Modes reach the kernel over these ports.
  private readonly previewConns = new Map<string, PreviewConn>();
  // Latest config to (re)send to the preview SW over the port on each connect
  // (the SW loses in-memory state when revived).
  private pendingKeepPrefix?: number[];
  private pendingDevtools?: boolean;

  constructor(
    options: {
      workerName?: string;
      previewOrigin?: string;
      previewWildcardDomain?: string;
      previewWildcardTag?: string;
      previewPopout?: "same-origin" | "isolated";
    } = {},
  ) {
    // Only treat a *different* origin as mode B; an accidental same-origin value
    // stays on the simpler same-origin path.
    const here = typeof location !== "undefined" ? location.origin : "";
    const wildcardDomain = normalizeDomain(options.previewWildcardDomain);
    this.wildcardTag = (options.previewWildcardTag ?? "").replace(/^-+|-+$/g, "");
    this.previewToken = randomToken();
    if (wildcardDomain) {
      // Mode C takes precedence: previews are per-port origins under the wildcard.
      this.previewMode = "wildcard";
      this.wildcardDomain = wildcardDomain;
    } else if (options.previewOrigin && options.previewOrigin !== here) {
      this.previewMode = "shared";
      this.previewOrigin = options.previewOrigin;
    } else {
      this.previewMode = "same-origin";
    }
    this.previewPopout = options.previewPopout === "isolated" ? "isolated" : "same-origin";
    this.worker = new Worker(
      new URL("./workers/kernel-worker.ts", import.meta.url),
      { type: "module", name: options.workerName ?? "Vivari Kernel" },
    );
    this.worker.onmessage = (event: MessageEvent<KernelMessage>) => {
      const m = event.data;
      if (m.type === "vv-reply") {
        const pending = this.pending.get(m.reqId as number);
        if (pending) {
          this.pending.delete(m.reqId as number);
          pending.dispose();
          pending.resolve(m);
        }
        return;
      }
      this.emit(m);
    };
    // A worker that fails to load (a bundler that didn't emit the chunk, a wasm
    // asset that 404s) never posts anything at all, so without this every caller
    // waiting on the kernel — `boot()` most visibly — would wait forever.
    this.worker.onerror = (event) => {
      const message =
        (typeof event === "object" && event && "message" in event
          ? String((event as ErrorEvent).message)
          : "") || "kernel worker failed to load";
      for (const h of [...this.workerErrorHandlers]) h(message);
      this.failPending(new VivariError("ERR_WORKER", message));
    };

    // Best-effort flush of the OPFS write-behind buffer as the page goes away.
    if (typeof addEventListener === "function") {
      this.listen(globalThis, "pagehide", () =>
        this.worker.postMessage({ type: "fs-flush" }),
      );

      // Reverse HMR tunnel: the preview iframe's WebSocket shim posts connection
      // events UP to this window; relay them down to the kernel worker. In modes
      // B/C the preview iframe is cross-origin, so only trust messages from a
      // recognised preview origin (its `parent` is still this window).
      this.listen(globalThis, "message", (event: Event) => {
        const msg = event as MessageEvent;
        if (this.previewMode !== "same-origin" && !this.isTrustedPreviewOrigin(msg.origin)) return;
        const d = msg.data;
        if (!d || d.dir !== "out" || (d.type !== "vv-ws" && d.type !== "vv-sse")) return;
        this.worker.postMessage({ type: d.type as string, msg: d });
      });
    }
  }

  /**
   * `target.addEventListener(...)`, remembered so {@link destroy} can detach it.
   * Everything this bridge attaches to a target it does not own goes through here.
   */
  private listen(target: EventTarget, type: string, handler: (event: Event) => void): void {
    target.addEventListener(type, handler);
    this.disposers.push(() => target.removeEventListener(type, handler));
  }

  /** Subscribe to a fatal kernel-worker load/runtime error. Returns an unsubscribe fn. */
  onWorkerError(handler: (message: string) => void): Unsubscribe {
    this.workerErrorHandlers.add(handler);
    return () => this.workerErrorHandlers.delete(handler);
  }

  /** Reject every in-flight `request()`; used on worker failure and on teardown. */
  private failPending(err: VivariError): void {
    const inFlight = [...this.pending.values()];
    this.pending.clear();
    for (const p of inFlight) {
      p.dispose();
      p.reject(err);
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
   *
   * Rejects if the signal aborts, the (optional) timeout expires, the worker dies,
   * or the bridge is destroyed — never leaves the caller pending. There is no
   * default timeout because reply latency is data-dependent (a tree export of a
   * large project is legitimately slow); bound it per call where you can.
   */
  request(
    type: string,
    extra?: Record<string, unknown>,
    options: RequestOptions = {},
  ): Promise<KernelMessage> {
    const { signal, timeout } = options;
    if (this.destroyed) {
      return Promise.reject(new VivariError("ERR_TORN_DOWN", `${type}: the Vivari instance was torn down`));
    }
    if (signal?.aborted) {
      return Promise.reject(new VivariError("ERR_ABORTED", `${type}: aborted`));
    }
    const reqId = this.reqSeq++;
    return new Promise<KernelMessage>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => settle(new VivariError("ERR_ABORTED", `${type}: aborted`));
      const dispose = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (err: VivariError) => {
        if (!this.pending.delete(reqId)) return;
        dispose();
        reject(err);
      };
      if (timeout !== undefined) {
        timer = setTimeout(
          () => settle(new VivariError("ERR_TIMEOUT", `${type}: no reply within ${timeout}ms`)),
          timeout,
        );
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(reqId, { resolve, reject, dispose });
      this.worker.postMessage({ type, reqId, ...extra });
    });
  }

  /** How previews are served (same-origin / shared / wildcard). */
  get mode(): PreviewMode {
    return this.previewMode;
  }

  /**
   * The origin prefix to build preview URLs with. Empty string in mode A (so
   * URLs stay relative/same-origin); the preview origin in mode B. Not meaningful
   * in mode C (per-port origins) — use {@link previewUrlFor} instead.
   */
  get previewBase(): string {
    return this.previewOrigin ?? "";
  }

  /**
   * Whether "Open in new tab" should open on the (isolated) preview origin. True
   * in mode B with `previewPopout: "isolated"`, and always true in mode C (each
   * pop-out opens on its per-port origin). Mode A pop-outs are same-origin.
   */
  get popoutIsolated(): boolean {
    if (this.previewMode === "wildcard") return true;
    return this.previewMode === "shared" && this.previewPopout === "isolated";
  }

  /**
   * Build the preview URL for an in-VM port. Mode A: relative `/preview/<port>/`.
   * Mode B: `<origin>/preview/<port>/`. Mode C: `<scheme>//<token>--<port>[-<tag>].<domain>/`.
   * `pathAndQuery` is the in-server path (default `/`).
   */
  previewUrlFor(port: number, pathAndQuery = "/"): string {
    const p = pathAndQuery.startsWith("/") ? pathAndQuery : "/" + pathAndQuery;
    if (this.previewMode === "wildcard") {
      const scheme = typeof location !== "undefined" ? location.protocol : "https:";
      return `${scheme}//${this.previewToken}--${port}${this.wildcardSuffix}${p}`;
    }
    return `${this.previewOrigin ?? ""}/preview/${port}${p}`;
  }

  /** Everything after the `<token>--<port>` label: `[-<tag>].<domain>` (mode C). */
  private get wildcardSuffix(): string {
    return `${this.wildcardTag ? `-${this.wildcardTag}` : ""}.${this.wildcardDomain}`;
  }

  /** The origin that serves a given port's preview (undefined in mode A). */
  private previewOriginFor(port: number): string | undefined {
    if (this.previewMode === "wildcard") {
      try {
        return new URL(this.previewUrlFor(port, "/")).origin;
      } catch {
        return undefined;
      }
    }
    return this.previewOrigin;
  }

  /**
   * Whether `origin` is one of our preview origins — the single `previewOrigin`
   * in mode B, or a `<token>--<port>[-<tag>].<domain>` host in mode C. Used to
   * gate cross-origin postMessage from preview frames. The per-boot random
   * `<token>` is what makes this tight; the tag is only a routing marker.
   */
  isTrustedPreviewOrigin(origin: string): boolean {
    if (!origin) return false;
    if (this.previewMode === "shared") return origin === this.previewOrigin;
    if (this.previewMode === "wildcard") {
      try {
        const host = new URL(origin).hostname;
        return host.startsWith(`${this.previewToken}--`) && host.endsWith(this.wildcardSuffix);
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Relay an inbound ws/SSE frame to preview tabs opened in their OWN tab. A
   * pop-out may be same-origin (served by the same-origin SW) or isolated (served
   * by the preview-origin SW over the bridge port), so post to BOTH transports;
   * each SW only reaches the clients it controls and each shim keeps only its own
   * connIds. No-op for whichever transport isn't present.
   */
  broadcastToPreviewSWs(payload: object): void {
    try {
      if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
        navigator.serviceWorker.controller?.postMessage(payload);
      }
    } catch {
      /* same-origin SW not controlling */
    }
    // Mode B: the single bridge port. Mode C: every per-port bridge port (each
    // preview-origin SW only reaches its own clients; shims keep only their connIds).
    for (const conn of this.previewConns.values()) {
      try {
        conn.port?.postMessage(payload);
      } catch {
        /* bridge port not connected */
      }
    }
  }

  /** Register the preview Service Worker and wire its HTTP relay into the VM. */
  async registerServiceWorker(url = "/sw.js"): Promise<boolean> {
    if (this.swRegistered) return true;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return false;
    this.swUrl = url;
    if (this.previewMode === "wildcard") {
      // Mode C: each port is its OWN origin, so we can't set up a bridge until a
      // port exists. Lazily stand one up per port as servers start listening. No
      // same-origin SW here — every preview (embedded and pop-out) lives on a
      // per-port origin reached over its own bridge port.
      this.on("listen", (m) => {
        const port = m.port as number;
        if (!port) return;
        const origin = this.previewOriginFor(port);
        if (origin) void this.ensurePreviewBridge(origin);
      });
      this.swRegistered = true;
      return true;
    }
    if (this.previewMode === "shared") {
      // Mode B: the *embedded* preview renders on a SEPARATE origin (isolation)
      // via a hidden bridge doc that registers the SW there and relays a port.
      const bridgeOk = await this.ensurePreviewBridge(this.previewOrigin!);
      // …but ALSO register a same-origin SW here so "Open in new tab" pop-outs
      // work. The editor opens pop-outs on THIS origin: a standalone tab on the
      // *preview* origin can't reach the kernel (browser storage partitioning
      // puts it in a different partition than the editor tab), whereas a
      // same-origin pop-out shares the kernel's partition and proxies through this
      // SW just like mode A. The untrusted *embedded* preview stays isolated on
      // the preview origin.
      try {
        await this.registerSameOriginServiceWorker(url);
      } catch {
        // Pop-outs won't work, but the embedded preview (bridge) still does.
      }
      return bridgeOk;
    }
    return this.registerSameOriginServiceWorker(url);
  }

  /** The classic same-origin SW path (mode A, and mode-B pop-outs). */
  private async registerSameOriginServiceWorker(url: string): Promise<boolean> {
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
    this.listen(navigator.serviceWorker, "message", (event: Event) => {
      const d = (event as MessageEvent).data;
      if (d?.type === "vv-http") {
        this.worker.postMessage({ type: "vv-http", req: d.req }, [(event as MessageEvent).ports[0]]);
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
    this.listen(navigator.serviceWorker, "controllerchange", () => this.announceKernelHost());
    this.swRegistered = true;
    return true;
  }

  // ── Modes B/C: separate preview origin(s) ─────────────────────────────────
  //
  // We can't register a cross-origin SW from here, so we load a hidden bridge
  // document on each preview origin. Being same-origin to `sw.js` there, it can
  // register it and relay a MessagePort we create back to that SW. Thereafter
  // every preview HTTP request the SW intercepts is posted to us over the port
  // (with a per-request reply port) and we forward it to the kernel exactly like
  // the same-origin path — no server, no network, just a different origin. Mode B
  // has one origin (all ports); mode C has one per port.

  /** Ensure a bridge (iframe + port) exists for `origin`; dedupes concurrent calls. */
  private ensurePreviewBridge(origin: string): Promise<boolean> {
    const existing = this.previewConns.get(origin);
    if (existing?.ready) return existing.ready;
    const conn: PreviewConn = {};
    this.previewConns.set(origin, conn);
    conn.ready = this.setupPreviewBridge(origin, conn);
    return conn.ready;
  }

  private async setupPreviewBridge(origin: string, conn: PreviewConn): Promise<boolean> {
    if (typeof document === "undefined" || typeof window === "undefined") return false;
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.setAttribute("tabindex", "-1");
    iframe.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden;left:-9999px";
    iframe.src =
      `${origin}/__vv-bridge.html?ide=${encodeURIComponent(location.origin)}` +
      `&sw=${encodeURIComponent(this.swUrl)}`;

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
    conn.iframe = iframe;
    if (!(await ready)) return false;

    if (this.destroyed) return false;
    this.connectPort(origin, conn);
    // The SW is evicted when idle, losing the in-memory port. The bridge doc
    // notices (its `controllerchange` / a probe) and asks us to re-hand a port.
    this.listen(window, "message", (event: Event) => {
      const msg = event as MessageEvent;
      if (msg.origin !== origin || !msg.data || msg.data.type !== "vv-need-connect") return;
      this.connectPort(origin, conn);
    });
    this.swRegistered = true;
    return true;
  }

  // Create a fresh MessageChannel, keep one end, and ship the other to the
  // preview SW via the bridge iframe. Also (re)push the current keep-prefix +
  // DevTools config, since a revived SW starts blank.
  private connectPort(origin: string, conn: PreviewConn): void {
    const win = conn.iframe?.contentWindow;
    if (!win) return;
    const mc = new MessageChannel();
    conn.port = mc.port1;
    mc.port1.onmessage = (event) => this.onKernelPortMessage(event);
    win.postMessage({ type: "vv-connect" }, origin, [mc.port2]);
    // keep-prefix only applies to path-multiplexed origins (mode B); mode C
    // serves each app at `/`, so there's no prefix to keep.
    if (this.previewMode !== "wildcard" && this.pendingKeepPrefix)
      mc.port1.postMessage({ type: "vv-keep-prefix-ports", ports: this.pendingKeepPrefix });
    if (this.pendingDevtools !== undefined)
      mc.port1.postMessage({ type: "vv-devtools", enabled: this.pendingDevtools });
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
   * Announce to the same-origin Service Worker that this page hosts the kernel, so
   * it routes `/preview/<port>/` requests here — used by mode A and by mode-B
   * same-origin pop-outs. Safe to call repeatedly; a no-op when there's no
   * controlling SW yet. (The mode-B *embedded* preview routes over the persistent
   * port instead, which doesn't need this.)
   */
  announceKernelHost(): void {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.controller?.postMessage({ type: "vv-kernel-host" });
  }

  /**
   * Tell the preview Service Worker which in-VM ports serve UNDER the
   * `/preview/<port>/` proxy prefix (keep-prefix templates like Docusaurus) so it
   * doesn't strip the prefix for them. Safe to call before the SW is active.
   */
  setKeepPrefixPorts(ports: number[]): void {
    // Mode C serves each app at `/`, so there's no proxy prefix to keep.
    if (this.previewMode === "wildcard") return;
    // Mode B: send over the persistent port (and remember it so a revived SW is
    // reconfigured on reconnect).
    if (this.previewMode === "shared") {
      this.pendingKeepPrefix = ports;
      for (const conn of this.previewConns.values())
        conn.port?.postMessage({ type: "vv-keep-prefix-ports", ports });
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
    // Modes B/C: send over every bridge port (and remember it for reconnects).
    if (this.previewMode !== "same-origin") {
      this.pendingDevtools = enabled;
      for (const conn of this.previewConns.values())
        conn.port?.postMessage({ type: "vv-devtools", enabled });
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

  /**
   * Tear down the worker and all nested workers/VFS it owns. Idempotent.
   *
   * Order matters: in-flight requests are rejected and {@link TEARDOWN_MESSAGE} is
   * broadcast BEFORE the handler tables are dropped, so anything waiting on the
   * kernel settles instead of being abandoned. Then every listener attached to a
   * target we don't own (window, `navigator.serviceWorker`) is detached — a torn
   * down bridge must stop relaying preview traffic into a terminated worker.
   */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.failPending(new VivariError("ERR_TORN_DOWN", "the Vivari instance was torn down"));
    this.emit({ type: TEARDOWN_MESSAGE });
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* target already gone */
      }
    }
    for (const conn of this.previewConns.values()) {
      try {
        conn.port?.close();
      } catch {
        /* already closed */
      }
      conn.iframe?.remove();
    }
    this.previewConns.clear();
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
    this.handlers.clear();
    this.anyHandlers.clear();
    this.workerErrorHandlers.clear();
  }
}

// A DNS label is 1-63 chars of [a-z0-9-]; a hostname's labels join with dots.
// Accept a bare base domain (strip any scheme/path a caller might pass).
function normalizeDomain(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let d = raw.trim().toLowerCase();
  try {
    if (d.includes("://")) d = new URL(d).hostname;
  } catch {
    /* fall through to the bare-string path */
  }
  d = d.replace(/^\/+|\/+$/g, "").replace(/\/.*$/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : undefined;
}

// Short, unguessable, per-boot token (base36, ~6 chars). Ties preview hostnames to
// this session so URLs aren't enumerable and rotate each boot. It's not a security
// secret (previews are already session/live-tab bound), so 6 chars keeps the host
// short while staying non-enumerable.
function randomToken(): string {
  const g = typeof crypto !== "undefined" ? crypto : undefined;
  if (g?.getRandomValues) {
    const a = new Uint8Array(4);
    g.getRandomValues(a);
    let s = "";
    for (const b of a) s += b.toString(36).padStart(2, "0");
    return s.slice(0, 6);
  }
  return Math.random().toString(36).slice(2, 8);
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