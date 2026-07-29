// Public type surface for @vivari/core.

/** A message posted between the page and the kernel worker. */
export interface KernelMessage {
  type: string;
  [key: string]: unknown;
}

/** Options for {@link Vivari.boot}. */
export interface BootOptions {
  /**
   * Whole-file lazy compression in the VFS. On by default — it cuts the file
   * system worker's memory footprint by ~70 % for a large `node_modules`. Set to
   * `false` to trade memory for a little less CPU.
   */
  compress?: boolean;
  /**
   * The preview Service Worker. It must be served **same-origin** at a scope that
   * covers the URLs you want proxied into the VM (default scope `/`). Pass a URL
   * string to override the default (`"/sw.js"`), or `false` to skip registration
   * entirely — do this if you don't need in-browser server previews.
   */
  serviceWorkerUrl?: string | false;
  /**
   * Serve previews from a **separate origin** for isolation (mode B). When set to
   * another origin (e.g. `"https://vivari-preview.pages.dev"`), the preview
   * Service Worker + a hidden bridge document are hosted there and the kernel is
   * reached over a persistent `MessagePort` instead of the same-origin
   * `findKernelClient()` path. That origin must serve `sw.js` + `__vv-bridge.html`
   * (+ `vv-devtools/chobitsu.js` if DevTools are on) with `COEP: credentialless`,
   * `CORP: cross-origin`, and `Service-Worker-Allowed: /`. Leave unset (the
   * default) to run previews same-origin with the IDE (mode A).
   */
  previewOrigin?: string;
  /**
   * Serve **each in-VM port from its own origin** (mode C, wildcard) — e.g.
   * `<token>--5173.vivari.run` and `<token>--3000.vivari.run`. Set
   * this to the **base domain** you control (e.g. `"vivari.run"`); Vivari
   * composes `<token>--<port>.<domain>` per port with a random per-boot
   * `<token>`. This isolates IDE↔preview **and** preview↔preview and matches real
   * `localhost:<port>` web-platform semantics. Because those hosts are subdomains
   * of the same base domain as the IDE, the isolated pop-out is **gate-free**
   * (same-site) — use a *different* base domain for max cross-site isolation.
   *
   * On a base domain **dedicated** to Vivari the route is simply `*.<domain>/*`.
   * If the domain also serves other apps, set {@link previewWildcardTag} so the
   * route can stay narrow.
   *
   * Requires wildcard infra: a proxied `*` DNS record and a Cloudflare Worker on
   * `*.<domain>/*` serving `sw.js` + `__vv-bridge.html` +
   * `__vv-preview-boot.html` (+ `vv-devtools/chobitsu.js`) with `COEP:
   * credentialless`, `CORP: cross-origin`, `Service-Worker-Allowed: /`. Takes
   * precedence over {@link previewOrigin} when both are set. Leave unset for mode A/B.
   */
  previewWildcardDomain?: string;
  /**
   * Optional hostname **suffix** tag for wildcard preview origins (mode C).
   * Unset by default: hosts are `<token>--<port>.<domain>` and the Cloudflare
   * route is `*.<domain>/*`, which is what you want on a base domain dedicated to
   * Vivari. Set it (e.g. `"vv"`) when the domain **also serves other apps**: hosts
   * become `<token>--<port>-vv.<domain>` and the route `*-vv.<domain>/*` matches
   * only Vivari preview hosts. It must be a SUFFIX, not a prefix, because
   * Cloudflare routes only allow the `*` wildcard at the **start** of the hostname.
   *
   * `sw.js` and `worker/src/index.js` accept any tag without changes, but the
   * Cloudflare **route** must match whatever you pick.
   */
  previewWildcardTag?: string;
  /**
   * How **"Open in new tab"** (a preview opened as its own top-level tab) behaves.
   * Only meaningful together with {@link previewOrigin} (mode B); with previews
   * running same-origin (mode A) a pop-out is always same-origin regardless. In
   * wildcard mode (C) a pop-out always opens on the per-port origin (isolated).
   *
   * - `"same-origin"` (default): the pop-out opens on the **IDE origin** and
   *   proxies through the same-origin Service Worker. It reaches the kernel with
   *   zero friction, at the cost of not being isolated from the IDE. Best when you
   *   run your own trusted code.
   * - `"isolated"`: the pop-out opens on the **preview origin** so it can't touch
   *   IDE storage/OPFS. Because a standalone cross-site tab lives in a different
   *   browser storage partition than the editor tab, it can only auto-connect when
   *   storage is unpartitioned; otherwise it shows a one-time "connect this tab"
   *   gate (Storage Access) — the same trade-off StackBlitz makes. Prefer this when
   *   previews may run untrusted code.
   *
   * The **embedded** preview stays isolated on the preview origin in both cases.
   */
  previewPopout?: "same-origin" | "isolated";
  /** Name shown for the kernel Worker in DevTools. Default: `"Vivari Kernel"`. */
  workerName?: string;
  /**
   * Inject Vivari's in-preview DevTools backend (chobitsu + CDP) into preview
   * pages. Off by default — enable only if you self-host `/vv-devtools/chobitsu.js`
   * same-origin, otherwise every preview would 404 on that script.
   */
  devtools?: boolean;
}

/** A recursive description of files/directories to write into the VFS. */
export interface FileSystemTree {
  [name: string]: FileNode | DirectoryNode;
}

export interface FileNode {
  file: {
    /** UTF-8 text or raw bytes. */
    contents: string | Uint8Array;
  };
}

export interface DirectoryNode {
  directory: FileSystemTree;
}

/** One entry returned by {@link FileSystemAPI.readdir} with `withFileTypes`. */
export interface DirEnt {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/** Options for {@link Vivari.spawn}. */
export interface SpawnOptions {
  /** Working directory for the process. Defaults to the VM root (or active project). */
  cwd?: string;
  /** Extra environment variables, merged over Vivari's package-manager-friendly defaults. */
  env?: Record<string, string>;
}

/** Fired when a server inside the VM starts listening and its preview is reachable. */
export type ServerReadyListener = (port: number, url: string) => void;

/** Fired when a port opens/closes inside the VM. */
export type PortListener = (port: number, kind: "open" | "close", url: string) => void;

/** Fired on unrecoverable kernel errors. */
export type ErrorListener = (error: { message: string }) => void;

export interface VivariEventMap {
  "server-ready": ServerReadyListener;
  port: PortListener;
  error: ErrorListener;
}