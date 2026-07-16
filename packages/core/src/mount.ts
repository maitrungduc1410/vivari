// Write a declarative FileSystemTree into the VFS.
//
// The tree shape mirrors the WebContainer `mount()` convention so existing
// project fixtures port over unchanged:
//
//   {
//     "package.json": { file: { contents: "…" } },
//     src: { directory: { "index.js": { file: { contents: "…" } } } },
//   }

import type { FileSystemAPI } from "./fs";
import type { DirectoryNode, FileNode, FileSystemTree } from "./types";

function isFileNode(node: FileNode | DirectoryNode): node is FileNode {
  return (node as FileNode).file !== undefined;
}

function joinPath(base: string, name: string): string {
  if (base === "/" || base === "") return "/" + name;
  return base.replace(/\/+$/, "") + "/" + name;
}

/** Flatten a tree into explicit dir + file operations, then apply them. */
export async function mountTree(
  fs: FileSystemAPI,
  tree: FileSystemTree,
  mountPoint = "/",
): Promise<void> {
  const dirs: string[] = [];
  const files: Array<{ path: string; contents: string | Uint8Array }> = [];

  const walk = (node: FileSystemTree, base: string) => {
    for (const [name, child] of Object.entries(node)) {
      const path = joinPath(base, name);
      if (isFileNode(child)) {
        files.push({ path, contents: child.file.contents });
      } else {
        dirs.push(path);
        walk(child.directory, path);
      }
    }
  };

  if (mountPoint && mountPoint !== "/") await fs.mkdir(mountPoint);
  walk(tree, mountPoint);

  // Directories first so empty ones survive (writeFile only auto-creates the
  // parents it needs), then the files.
  for (const dir of dirs) await fs.mkdir(dir);
  for (const f of files) await fs.writeFile(f.path, f.contents);
}
