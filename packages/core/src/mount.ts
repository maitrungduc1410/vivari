// Write a declarative FileSystemTree into the VFS.
//
// The tree shape mirrors the WebContainer `mount()` convention so existing
// project fixtures port over unchanged:
//
//   {
//     "package.json": { file: { contents: "…" } },
//     src: { directory: { "index.js": { file: { contents: "…" } } } },
//   }
//
// The whole tree goes over in ONE `vv-import-tree` round-trip. Writing it file by
// file meant a postMessage + reply per entry, strictly sequential, which is a few
// hundred round-trips for an ordinary starter template.

import type { KernelBridge } from "./bridge.js";
import { VivariFsError, toErrorCode } from "./errors.js";
import type { DirectoryNode, FileNode, FileSystemTree, KernelMessage } from "./types.js";

function isFileNode(node: FileNode | DirectoryNode): node is FileNode {
  return (node as FileNode).file !== undefined;
}

function joinPath(base: string, name: string): string {
  if (base === "/" || base === "") return "/" + name;
  return base.replace(/\/+$/, "") + "/" + name;
}

/** Flatten a tree into explicit dir + file operations, then apply them in one batch. */
export async function mountTree(
  bridge: KernelBridge,
  tree: FileSystemTree,
  mountPoint = "/",
  signal?: AbortSignal,
): Promise<void> {
  const dirs: string[] = [];
  const files: Array<{ path: string; bytes: string | Uint8Array }> = [];

  // Paths are relative to the mount point: the kernel prefixes them, so the batch
  // stays valid whatever `mountPoint` is.
  const walk = (node: FileSystemTree, base: string) => {
    for (const [name, child] of Object.entries(node)) {
      const path = joinPath(base, name);
      if (isFileNode(child)) {
        files.push({ path, bytes: child.file.contents });
      } else {
        dirs.push(path);
        walk(child.directory, path);
      }
    }
  };
  walk(tree, "");

  const dir = mountPoint === "/" ? "" : mountPoint.replace(/\/+$/, "");
  const reply = (await bridge.request(
    "vv-import-tree",
    // Directories are listed separately so empty ones survive the mount — a batch
    // write only creates the parents its files need.
    { dir, dirs, files },
    { signal },
  )) as KernelMessage;
  if (reply.ok === false) {
    throw new VivariFsError(
      toErrorCode(reply.code),
      "mount",
      mountPoint,
      (reply.error as string) || undefined,
    );
  }
}