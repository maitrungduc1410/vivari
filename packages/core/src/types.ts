// Public type surface for @vivari/core.

import type { VivariError } from "./errors.js";

/** A message posted between the page and the kernel worker. */
export interface KernelMessage {
  type: string;
  [key: string]: unknown;
}

/** Unsubscribe handle returned by every `on(...)`-style subscription. */
export type Unsubscribe = () => void;

/** Text encodings the VFS can decode to a string. Both spellings of UTF-8 work. */
export type Encoding = "utf-8" | "utf8";

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
  /**
   * How long to wait for the kernel to report `ready` before giving up, in ms.
   * Default 60 000. On expiry `boot()` rejects with `ERR_BOOT_TIMEOUT` and tears
   * down the half-built instance rather than leaving the caller pending forever.
   */
  timeout?: number;
  /** Abort the boot. The returned promise rejects with `ERR_ABORTED`. */
  signal?: AbortSignal;
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

/** Metadata for one VFS entry, in the shape of a Node `fs.Stats` subset. */
export interface Stats {
  /** Size in bytes for a file; the child count for a directory. */
  size: number;
  /** Last modification time, ms since the epoch. */
  mtimeMs: number;
  /** POSIX mode bits, as recorded by the VFS. */
  mode: number;
  /** Inode id. Stable across different paths to the same entry (e.g. hard links). */
  ino: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

/**
 * Why a watched path fired. Mirrors Node's `fs.watch` vocabulary: `"rename"` for a
 * directory entry appearing/disappearing/moving, `"change"` for contents edited in
 * place.
 */
export type FsChangeKind = "rename" | "change";

/** One filesystem change notification. */
export interface FsChangeEvent {
  kind: FsChangeKind;
  /** Absolute VFS path of the entry that changed. */
  path: string;
}

/** Options for {@link FileSystemAPI.watch}. */
export interface WatchOptions {
  /**
   * Also report changes below `path`. Default `true` — the kernel reports the exact
   * path that changed, so a non-recursive watch is a prefix filter on top.
   */
  recursive?: boolean;
  /** Stop watching when the signal aborts. Equivalent to calling `close()`. */
  signal?: AbortSignal;
}

/** Options accepted by the read/write methods on {@link FileSystemAPI}. */
export interface FsOperationOptions {
  signal?: AbortSignal;
}

/** Options for {@link Vivari.mount}. */
export interface MountOptions {
  /** Directory to write the tree into. Default `"/"`. */
  mountPoint?: string;
  signal?: AbortSignal;
}

/** Options for {@link Vivari.export}. */
export interface ExportOptions {
  /**
   * Directory names to skip anywhere in the tree, on top of the always-excluded
   * `node_modules` and `.git`.
   */
  exclude?: string[];
  signal?: AbortSignal;
}

/** One file in an {@link ExportResult}, with a path relative to the exported root. */
export interface ExportedFile {
  path: string;
  contents: Uint8Array;
}

/** The result of {@link Vivari.export}. */
export interface ExportResult {
  files: ExportedFile[];
  /**
   * True when the walk hit the kernel's file-count or total-byte cap and stopped
   * early, so `files` is a prefix of the tree rather than all of it.
   */
  truncated: boolean;
}

/** Options for {@link Vivari.spawn}. */
export interface SpawnOptions {
  /** Working directory for the process. Defaults to the VM root (or active project). */
  cwd?: string;
  /** Extra environment variables, merged over Vivari's package-manager-friendly defaults. */
  env?: Record<string, string>;
  /**
   * Kill the process when the signal aborts. An already-aborted signal makes
   * `spawn()` reject with `ERR_ABORTED` without launching anything.
   */
  signal?: AbortSignal;
}

/** Whether a port started or stopped being served inside the VM. */
export type PortKind = "open" | "close";

/**
 * The events {@link Vivari.on} can deliver, as listener argument tuples.
 *
 * - `server-ready` — a server is listening **and has answered a request**. Dev
 *   servers bind, close and rebind several times while starting, so this fires
 *   only once the port really serves; point an iframe at `url` here.
 * - `port` — the raw bind/unbind, with no serving check. Fires before
 *   `server-ready` for the same port, and again with `"close"` when it goes away.
 * - `fs-change` — something under the VFS changed. Coalesce these; a single
 *   install fires thousands.
 * - `error` — an unrecoverable kernel error.
 */
export interface VivariEventMap {
  "server-ready": [port: number, url: string];
  port: [port: number, kind: PortKind, url: string];
  "fs-change": [event: FsChangeEvent];
  error: [error: VivariError];
}

/** The listener signature for one {@link VivariEventMap} event. */
export type VivariListener<E extends keyof VivariEventMap> = (...args: VivariEventMap[E]) => void;

/** Fired when a server inside the VM starts listening and its preview is reachable. */
export type ServerReadyListener = VivariListener<"server-ready">;

/** Fired when a port opens/closes inside the VM. */
export type PortListener = VivariListener<"port">;

/** Fired when the VFS changes. */
export type FsChangeListener = VivariListener<"fs-change">;

/** Fired on unrecoverable kernel errors. */
export type ErrorListener = VivariListener<"error">;

/** Options accepted by {@link Vivari.on} / {@link Vivari.once}. */
export interface ListenerOptions {
  /** Unsubscribe when the signal aborts. */
  signal?: AbortSignal;
}