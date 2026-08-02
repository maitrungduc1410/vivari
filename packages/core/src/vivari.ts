// The Vivari WebContainer instance — the SDK's main entry point.
//
//   import { Vivari } from "@vivari/core";
//   const vivari = await Vivari.boot();
//   await vivari.mount(tree);
//   const install = await vivari.spawn("npm", ["install"]);
//   await install.exit;
//   vivari.on("server-ready", (port, url) => (iframe.src = url));
//   await vivari.spawn("npm", ["run", "dev"]);

import { KernelBridge, TEARDOWN_MESSAGE, isCrossOriginIsolated } from "./bridge.js";
import { VivariError } from "./errors.js";
import { FileSystemAPI } from "./fs.js";
import { mountTree } from "./mount.js";
import { VivariProcess } from "./process.js";
import type {
  BootOptions,
  ExportOptions,
  ExportResult,
  ExportedFile,
  FileSystemTree,
  KernelMessage,
  ListenerOptions,
  MountOptions,
  SpawnOptions,
  Unsubscribe,
  VivariEventMap,
  VivariListener,
} from "./types.js";

const DEFAULT_BOOT_TIMEOUT = 60_000;

// Listeners are stored with their argument tuple erased. `never` as the rest type
// makes every VivariListener assignable here (contravariance), so this is the one
// place the per-event tuples are widened — the public on/off/once/emit signatures
// stay exact.
type AnyListener = (...args: never) => void;

export class Vivari {
  /** Async filesystem access to the VFS. */
  readonly fs: FileSystemAPI;
  /**
   * The low-level message bridge to the kernel worker.
   *
   * **Unstable — not covered by semver.** The kernel message vocabulary changes
   * with the runtime and nothing here is typed beyond `KernelMessage`. Use it to
   * build something this class cannot express yet (the studio IDE does), and
   * expect to fix up call sites on any release.
   */
  readonly internal: KernelBridge;

  private execSeq = 1;
  private readonly listeners = new Map<string, Set<AnyListener>>();
  private torndown = false;

  private constructor(bridge: KernelBridge) {
    this.internal = bridge;
    this.fs = new FileSystemAPI(bridge);

    bridge.on("listen", (m: KernelMessage) => {
      const port = m.port as number;
      // Re-assert kernel-host ownership with the SW right before the preview
      // iframe loads, so an embedded (iframed) Vivari — or one whose SW was
      // revived and lost its in-memory host set — still gets preview HTTP routed
      // to this client instead of the top-level host document.
      bridge.announceKernelHost();
      this.emit("port", port, "open", bridge.previewUrlFor(port));
    });
    // The kernel only sends this once the port has actually answered a request,
    // which is why it — and not `listen` — drives `server-ready`.
    bridge.on("serving", (m: KernelMessage) => {
      const port = m.port as number;
      this.emit("server-ready", port, bridge.previewUrlFor(port));
    });
    bridge.on("port-close", (m: KernelMessage) => {
      const port = m.port as number;
      this.emit("port", port, "close", bridge.previewUrlFor(port));
    });
    bridge.on("vv-fs-changed", (m: KernelMessage) => {
      const path = m.path as string;
      if (typeof path !== "string") return;
      this.emit("fs-change", { kind: m.kind === "rename" ? "rename" : "change", path });
    });
    bridge.on("error", (m: KernelMessage) => {
      this.emit("error", new VivariError("ERR_WORKER", (m.message as string) || "kernel error"));
    });
  }

  /**
   * Boot a Vivari instance: spin up the kernel + workers + VFS and (unless
   * disabled) register the preview Service Worker. Requires a cross-origin
   * isolated page (COOP + COEP) so `SharedArrayBuffer` is available.
   *
   * Rejects — rather than hanging — if the page isn't isolated
   * (`ERR_NOT_ISOLATED`), the kernel worker fails to load (`ERR_WORKER`), the
   * kernel reports a boot failure (`ERR_BOOT_FAILED`), the timeout expires
   * (`ERR_BOOT_TIMEOUT`) or `options.signal` aborts (`ERR_ABORTED`).
   */
  static async boot(options: BootOptions = {}): Promise<Vivari> {
    if (!isCrossOriginIsolated()) {
      throw new VivariError(
        "ERR_NOT_ISOLATED",
        "Vivari requires a cross-origin isolated page (SharedArrayBuffer). " +
          "Serve your page with the headers `Cross-Origin-Opener-Policy: same-origin` " +
          "and `Cross-Origin-Embedder-Policy: require-corp`.",
      );
    }
    if (options.signal?.aborted) {
      throw new VivariError("ERR_ABORTED", "Vivari.boot() was aborted");
    }
    const bridge = new KernelBridge({
      workerName: options.workerName,
      previewOrigin: options.previewOrigin,
      previewWildcardDomain: options.previewWildcardDomain,
      previewWildcardTag: options.previewWildcardTag,
      previewPopout: options.previewPopout,
    });
    const vivari = new Vivari(bridge);

    const ready = new Promise<void>((resolve, reject) => {
      const timeoutMs = options.timeout ?? DEFAULT_BOOT_TIMEOUT;
      let settled = false;
      const finish = (err?: VivariError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        offReady();
        offError();
        offWorkerError();
        offTeardown();
        options.signal?.removeEventListener("abort", onAbort);
        if (err) {
          // Nothing usable came out of the boot, so don't leave the worker, the
          // Service Worker relay and the preview iframes behind.
          vivari.teardown();
          reject(err);
        } else {
          resolve();
        }
      };
      const onAbort = () => finish(new VivariError("ERR_ABORTED", "Vivari.boot() was aborted"));
      const timer = setTimeout(
        () =>
          finish(
            new VivariError(
              "ERR_BOOT_TIMEOUT",
              `Vivari.boot() did not complete within ${timeoutMs}ms. The kernel worker ` +
                "never reported ready — check that its chunk and the Wasm assets are served same-origin.",
            ),
          ),
        timeoutMs,
      );
      const offReady = bridge.on("ready", () => finish());
      const offError = bridge.on("error", (m: KernelMessage) =>
        finish(new VivariError("ERR_BOOT_FAILED", (m.message as string) || "kernel boot failed")),
      );
      const offWorkerError = bridge.onWorkerError((message) =>
        finish(new VivariError("ERR_WORKER", message)),
      );
      const offTeardown = bridge.on(TEARDOWN_MESSAGE, () =>
        finish(new VivariError("ERR_TORN_DOWN", "the Vivari instance was torn down while booting")),
      );
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
    // Observed synchronously: the Service Worker registration below can throw
    // before we reach the await, and an unobserved boot-timeout rejection would
    // otherwise surface as an unhandled rejection a minute later.
    const outcome = ready.then(
      () => undefined,
      (err: unknown) => err,
    );

    // The Service Worker registration is awaited before `init` so the preview
    // relay is in place.
    try {
      if (options.serviceWorkerUrl !== false) {
        await bridge.registerServiceWorker(
          typeof options.serviceWorkerUrl === "string" ? options.serviceWorkerUrl : undefined,
        );
        // Preview DevTools backend is opt-in for SDK embedders (see BootOptions.devtools):
        // it needs a same-origin /vv-devtools/chobitsu.js, which the studio hosts but a
        // bare embedder won't. The SW defaults it on (for the studio), so opt out here.
        bridge.setDevtoolsEnabled(options.devtools ?? false);
      }
      bridge.boot(options.compress ?? true);
    } catch (err) {
      // teardown() settles `ready` through the TEARDOWN_MESSAGE above, so this
      // drains rather than waiting out the timeout.
      vivari.teardown();
      await outcome;
      throw err;
    }
    const failure = await outcome;
    if (failure) throw failure;
    // `__vv.diag()` is installed by KernelBridge itself, not here — the studio builds
    // a bridge directly and never calls boot(), so hooking it here made the
    // diagnostic invisible in the one place a user actually is.
    return vivari;
  }

  /** Write a declarative file tree into the VFS, in a single batched round-trip. */
  async mount(tree: FileSystemTree, options: MountOptions = {}): Promise<void> {
    await mountTree(this.internal, tree, options.mountPoint ?? "/", options.signal);
  }

  /**
   * Read a directory tree back out of the VFS — a project snapshot for download,
   * a share link, or a hand-off to another instance. `node_modules` and `.git` are
   * always skipped.
   */
  async export(path = "/", options: ExportOptions = {}): Promise<ExportResult> {
    const m = await this.internal.request(
      "vv-read-tree",
      { root: path, exclude: options.exclude, strict: true },
      { signal: options.signal },
    );
    if (m.ok === false) {
      throw new VivariError("ERR_UNKNOWN", (m.error as string) || `export failed: ${path}`);
    }
    return {
      files: (m.files as ExportedFile[]) ?? [],
      truncated: !!m.truncated,
    };
  }

  /**
   * Run a command in the VM, streaming its stdio. Rejects with
   * `ERR_COMMAND_NOT_FOUND` if the command can't be launched, rather than handing
   * back a process that silently exits 127 with no output.
   */
  async spawn(
    command: string,
    args: string[] = [],
    options: SpawnOptions = {},
  ): Promise<VivariProcess> {
    if (options.signal?.aborted) {
      throw new VivariError("ERR_ABORTED", `${command}: aborted before launch`);
    }
    const proc = new VivariProcess(this.internal, this.execSeq++, command, args, options);
    await proc.started;
    return proc;
  }

  /**
   * Preview URL for an in-VM port (see also the `server-ready` event).
   * `pathAndQuery` addresses a path inside that server; it defaults to `/`.
   */
  previewUrl(port: number, pathAndQuery = "/"): string {
    return this.internal.previewUrlFor(port, pathAndQuery);
  }

  /**
   * Route the HMR / SSE tunnel to a preview `<iframe>`. A dev server's inbound
   * WebSocket frames arrive on the kernel and have to be delivered into the frame,
   * or Vite HMR never gets past "connecting…". Returns a detach function.
   */
  attachPreview(frame: HTMLIFrameElement): Unsubscribe {
    const relay = (type: "vv-ws" | "vv-sse") =>
      this.internal.on(type, (m: KernelMessage) => {
        const win = frame.contentWindow;
        const msg = (m as { msg?: Record<string, unknown> }).msg;
        // The frame's shim ignores frames for connIds it doesn't own, so a page
        // with several previews can attach each one without cross-talk.
        if (win && msg) win.postMessage({ ...msg, type, dir: "in" }, "*");
      });
    const offWs = relay("vv-ws");
    const offSse = relay("vv-sse");
    return () => {
      offWs();
      offSse();
    };
  }

  /** Subscribe to a lifecycle event. Returns an unsubscribe function. */
  on<E extends keyof VivariEventMap>(
    event: E,
    listener: VivariListener<E>,
    options: ListenerOptions = {},
  ): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener as AnyListener);
    const off = () => {
      set.delete(listener as AnyListener);
      options.signal?.removeEventListener("abort", off);
    };
    if (options.signal?.aborted) off();
    else options.signal?.addEventListener("abort", off, { once: true });
    return off;
  }

  /** Unsubscribe a listener registered with {@link on}. */
  off<E extends keyof VivariEventMap>(event: E, listener: VivariListener<E>): void {
    this.listeners.get(event)?.delete(listener as AnyListener);
  }

  /**
   * Resolve with the next occurrence of `event`, as its listener argument tuple:
   *
   *   const [port, url] = await vivari.once("server-ready");
   *
   * Rejects with `ERR_ABORTED` if the signal aborts, and with `ERR_TORN_DOWN` if
   * the instance is torn down while waiting.
   */
  once<E extends keyof VivariEventMap>(
    event: E,
    options: ListenerOptions = {},
  ): Promise<VivariEventMap[E]> {
    return new Promise((resolve, reject) => {
      const settle = (err?: VivariError, args?: VivariEventMap[E]) => {
        off();
        offTeardown();
        options.signal?.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else resolve(args as VivariEventMap[E]);
      };
      const onAbort = () => settle(new VivariError("ERR_ABORTED", `once(${event}): aborted`));
      const off = this.on(event, ((...args: VivariEventMap[E]) =>
        settle(undefined, args)) as VivariListener<E>);
      const offTeardown = this.internal.on(TEARDOWN_MESSAGE, () =>
        settle(new VivariError("ERR_TORN_DOWN", `once(${event}): the Vivari instance was torn down`)),
      );
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Has {@link teardown} been called? */
  get destroyed(): boolean {
    return this.torndown;
  }

  /**
   * Tear down the instance and free the workers/VFS it owns. Idempotent.
   *
   * Everything in flight settles rather than hanging: pending `fs` calls reject
   * with `ERR_TORN_DOWN`, running processes close their output streams and resolve
   * `exit` with `-1`, and watchers close.
   */
  teardown(): void {
    if (this.torndown) return;
    this.torndown = true;
    this.internal.destroy();
    this.listeners.clear();
  }

  private emit<E extends keyof VivariEventMap>(event: E, ...args: VivariEventMap[E]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copied: a listener may unsubscribe itself (or others) while we iterate.
    for (const listener of [...set]) (listener as VivariListener<E>)(...args);
  }
}