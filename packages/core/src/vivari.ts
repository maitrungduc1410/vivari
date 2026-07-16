// The Vivari WebContainer instance — the SDK's main entry point.
//
//   import { Vivari } from "@vivari/core";
//   const vivari = await Vivari.boot();
//   await vivari.mount(tree);
//   const install = await vivari.spawn("npm", ["install"]);
//   await install.exit;
//   vivari.on("server-ready", (port, url) => (iframe.src = url));
//   await vivari.spawn("npm", ["run", "dev"]);

import { KernelBridge, isCrossOriginIsolated } from "./bridge";
import { FileSystemAPI } from "./fs";
import { mountTree } from "./mount";
import { previewUrl } from "./preview";
import { VivariProcess } from "./process";
import type {
  BootOptions,
  ErrorListener,
  FileSystemTree,
  KernelMessage,
  PortListener,
  ServerReadyListener,
  SpawnOptions,
  VivariEventMap,
} from "./types";

export class Vivari {
  /** Async filesystem access to the VFS. */
  readonly fs: FileSystemAPI;
  /**
   * The low-level message bridge to the kernel worker. Escape hatch for advanced
   * use (custom messages, the full studio protocol); most apps only need the
   * methods on this class.
   */
  readonly bridge: KernelBridge;

  private execSeq = 1;
  private readonly serverReady = new Set<ServerReadyListener>();
  private readonly portListeners = new Set<PortListener>();
  private readonly errorListeners = new Set<ErrorListener>();

  private constructor(bridge: KernelBridge) {
    this.bridge = bridge;
    this.fs = new FileSystemAPI(bridge);

    bridge.on("listen", (m: KernelMessage) => {
      const port = m.port as number;
      const url = previewUrl(port);
      for (const l of this.serverReady) l(port, url);
      for (const l of this.portListeners) l(port, "open", url);
    });
    bridge.on("error", (m: KernelMessage) => {
      const err = { message: (m.message as string) || "kernel error" };
      for (const l of this.errorListeners) l(err);
    });
  }

  /**
   * Boot a Vivari instance: spin up the kernel + workers + VFS and (unless
   * disabled) register the preview Service Worker. Requires a cross-origin
   * isolated page (COOP + COEP) so `SharedArrayBuffer` is available.
   */
  static async boot(options: BootOptions = {}): Promise<Vivari> {
    if (!isCrossOriginIsolated()) {
      throw new Error(
        "Vivari requires a cross-origin isolated page (SharedArrayBuffer). " +
          "Serve your page with the headers `Cross-Origin-Opener-Policy: same-origin` " +
          "and `Cross-Origin-Embedder-Policy: require-corp`.",
      );
    }
    const bridge = new KernelBridge({ workerName: options.workerName });
    const vivari = new Vivari(bridge);

    if (options.serviceWorkerUrl !== false) {
      await bridge.registerServiceWorker(
        typeof options.serviceWorkerUrl === "string" ? options.serviceWorkerUrl : undefined,
      );
      // Preview DevTools backend is opt-in for SDK embedders (see BootOptions.devtools):
      // it needs a same-origin /vv-devtools/chobitsu.js, which the studio hosts but a
      // bare embedder won't. The SW defaults it on (for the studio), so opt out here.
      bridge.setDevtoolsEnabled(options.devtools ?? false);
    }

    const ready = new Promise<void>((resolve) => {
      const off = bridge.on("ready", () => {
        off();
        resolve();
      });
    });
    bridge.boot(options.compress ?? true);
    await ready;
    return vivari;
  }

  /** Write a declarative file tree into the VFS. */
  async mount(tree: FileSystemTree, options: { mountPoint?: string } = {}): Promise<void> {
    await mountTree(this.fs, tree, options.mountPoint ?? "/");
  }

  /** Run a command in the VM, streaming its stdio. */
  async spawn(command: string, args: string[] = [], options: SpawnOptions = {}): Promise<VivariProcess> {
    return new VivariProcess(this.bridge, this.execSeq++, command, args, options);
  }

  /** Same-origin preview URL for an in-VM port (see also the `server-ready` event). */
  previewUrl(port: number): string {
    return previewUrl(port);
  }

  /** Subscribe to a lifecycle event. Returns an unsubscribe function. */
  on<E extends keyof VivariEventMap>(event: E, listener: VivariEventMap[E]): () => void {
    const set = this.setFor(event);
    set.add(listener as never);
    return () => set.delete(listener as never);
  }

  private setFor(event: keyof VivariEventMap): Set<never> {
    if (event === "server-ready") return this.serverReady as unknown as Set<never>;
    if (event === "port") return this.portListeners as unknown as Set<never>;
    return this.errorListeners as unknown as Set<never>;
  }

  /** Tear down the instance and free the workers/VFS it owns. */
  teardown(): void {
    this.serverReady.clear();
    this.portListeners.clear();
    this.errorListeners.clear();
    this.bridge.destroy();
  }
}
