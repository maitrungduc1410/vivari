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
