import { useMemo, useState } from "react";
import ChevronDown from "~icons/lucide/chevron-down";
import ChevronRight from "~icons/lucide/chevron-right";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  ContextMenuShortcut, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { FileIcon, FolderIcon } from "./fileIcon";
import { useIde } from "./useIde";

interface DirNode {
  dirs: Map<string, DirNode>;
  files: { name: string; rel: string }[];
}

function buildTree(paths: string[]): DirNode {
  const root: DirNode = { dirs: new Map(), files: [] };
  for (const rel of paths) {
    const parts = rel.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        node.files.push({ name: part, rel });
      } else {
        let child = node.dirs.get(part);
        if (!child) node.dirs.set(part, (child = { dirs: new Map(), files: [] }));
        node = child;
      }
    }
  }
  return root;
}

const parentDir = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const modKey = (e: React.KeyboardEvent) => e.metaKey || e.ctrlKey;

interface RowCtx {
  activeTab: string | null;
  selected: string | null;
  renaming: string | null;
  renameValue: string;
  canPaste: boolean;
  expanded: Set<string>;
  setRenameValue: (v: string) => void;
  select: (rel: string, isDir: boolean) => void;
  toggle: (path: string) => void;
  openFile: (rel: string, preview: boolean) => void;
  startRename: (rel: string) => void;
  commitRename: () => void;
  cancelRename: () => void;
  copy: (rel: string) => void;
  cut: (rel: string) => void;
  paste: (destDir: string) => void;
  requestDelete: (rel: string) => void;
}

function RenameInput({ ctx }: { ctx: RowCtx }) {
  return (
    <input
      autoFocus
      value={ctx.renameValue}
      onChange={(e) => ctx.setRenameValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") ctx.commitRename();
        else if (e.key === "Escape") ctx.cancelRename();
      }}
      onBlur={() => ctx.commitRename()}
      ref={(el) => {
        if (!el) return;
        const dot = el.value.indexOf(".");
        el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
      }}
      className="min-w-0 flex-1 rounded-sm bg-background px-1 text-sm text-foreground outline outline-1 outline-primary"
    />
  );
}

function RowMenu({
  rel, isDir, destDir, ctx, children,
}: {
  rel: string; isDir: boolean; destDir: string; ctx: RowCtx; children: React.ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger
        className="block w-full"
        onContextMenu={() => ctx.select(rel, isDir)}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onClick={() => (isDir ? ctx.toggle(rel) : ctx.openFile(rel, false))}>
          Open
        </ContextMenuItem>
        <ContextMenuItem onClick={() => ctx.startRename(rel)}>
          Rename<ContextMenuShortcut>↵</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => ctx.copy(rel)}>
          Copy<ContextMenuShortcut>⌘C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => ctx.cut(rel)}>
          Cut<ContextMenuShortcut>⌘X</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!ctx.canPaste} onClick={() => ctx.paste(destDir)}>
          Paste<ContextMenuShortcut>⌘V</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => ctx.requestDelete(rel)}>
          Delete permanently
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function TreeLevel({ node, prefix, depth, ctx }: {
  node: DirNode; prefix: string; depth: number; ctx: RowCtx;
}) {
  const dirs = [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      {dirs.map(([name, child]) => {
        const path = prefix + name;
        const open = ctx.expanded.has(path);
        const isRenaming = ctx.renaming === path;
        return (
          <div key={path}>
            <RowMenu rel={path} isDir destDir={path} ctx={ctx}>
              <div
                className={cn(
                  "flex w-full items-center gap-1 py-0.5 text-left text-sm",
                  ctx.selected === path ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
                style={{ paddingLeft: 8 + depth * 12 }}
                onClick={() => { ctx.select(path, true); ctx.toggle(path); }}
              >
                {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
                <FolderIcon open={open} className="size-4 shrink-0" />
                {isRenaming ? <RenameInput ctx={ctx} /> : <span className="truncate">{name}</span>}
              </div>
            </RowMenu>
            {open && <TreeLevel node={child} prefix={path + "/"} depth={depth + 1} ctx={ctx} />}
          </div>
        );
      })}
      {files.map((f) => {
        const isRenaming = ctx.renaming === f.rel;
        const isSelected = ctx.selected === f.rel;
        return (
          <RowMenu key={f.rel} rel={f.rel} isDir={false} destDir={parentDir(f.rel)} ctx={ctx}>
            <div
              className={cn(
                "flex w-full items-center gap-1.5 py-0.5 text-left text-sm",
                isSelected || ctx.activeTab === f.rel
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50",
              )}
              style={{ paddingLeft: 8 + depth * 12 + 16 }}
              onClick={() => { ctx.select(f.rel, false); ctx.openFile(f.rel, true); }}
              onDoubleClick={() => ctx.openFile(f.rel, false)}
            >
              <FileIcon name={f.name} className="size-4 shrink-0" />
              {isRenaming ? <RenameInput ctx={ctx} /> : <span className="truncate">{f.name}</span>}
            </div>
          </RowMenu>
        );
      })}
    </>
  );
}

export function Explorer() {
  const { c, snap } = useIde();
  const tree = useMemo(() => buildTree(snap.files), [snap.files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<{ rel: string; isDir: boolean } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Directories are open by default; `collapsed` tracks the ones the user closed.
  const allDirs = useMemo(() => {
    const acc = new Set<string>();
    const walk = (n: DirNode, prefix: string) => {
      for (const [name, child] of n.dirs) {
        acc.add(prefix + name);
        walk(child, prefix + name + "/");
      }
    };
    walk(tree, "");
    return acc;
  }, [tree]);
  const expanded = useMemo(() => {
    const s = new Set(allDirs);
    for (const p of collapsed) s.delete(p);
    return s;
  }, [allDirs, collapsed]);

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const startRename = (rel: string) => {
    setRenaming(rel);
    setRenameValue(rel.split("/").pop() ?? rel);
  };
  const commitRename = () => {
    if (!renaming) return;
    const name = renameValue.trim();
    const parent = parentDir(renaming);
    if (name && name !== renaming.split("/").pop()) c.renameEntry(renaming, parent ? parent + "/" + name : name);
    setRenaming(null);
  };
  const cancelRename = () => setRenaming(null);

  const pasteDestFor = (sel: { rel: string; isDir: boolean }) => (sel.isDir ? sel.rel : parentDir(sel.rel));

  const ctx: RowCtx = {
    activeTab: snap.activeTab,
    selected: selected?.rel ?? null,
    renaming,
    renameValue,
    canPaste: snap.clipboard != null,
    expanded,
    setRenameValue,
    select: (rel, isDir) => setSelected({ rel, isDir }),
    toggle,
    openFile: (rel, preview) => c.openFile(rel, { preview }),
    startRename,
    commitRename,
    cancelRename,
    copy: (rel) => c.copyEntry(rel),
    cut: (rel) => c.cutEntry(rel),
    paste: (destDir) => c.pasteInto(destDir),
    requestDelete: (rel) => setConfirmDelete(rel),
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (renaming || !selected) return;
    if (e.key === "Enter") { e.preventDefault(); startRename(selected.rel); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); setConfirmDelete(selected.rel); }
    else if (modKey(e) && e.key.toLowerCase() === "c") { e.preventDefault(); c.copyEntry(selected.rel); }
    else if (modKey(e) && e.key.toLowerCase() === "x") { e.preventDefault(); c.cutEntry(selected.rel); }
    else if (modKey(e) && e.key.toLowerCase() === "v") { e.preventDefault(); c.pasteInto(pasteDestFor(selected)); }
  };

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex h-8 shrink-0 items-center px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Explorer
      </div>
      <ScrollArea className="flex-1">
        {/* Right-clicking empty space pastes into the project root. */}
        <ContextMenu>
          <ContextMenuTrigger className="block min-h-full">
            <div className="pb-4 outline-none" tabIndex={0} onKeyDown={onKeyDown}>
              {snap.files.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  Press <span className="text-foreground">Run</span> to scaffold a project.
                </div>
              ) : (
                <TreeLevel node={tree} prefix="" depth={0} ctx={ctx} />
              )}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-44">
            <ContextMenuItem disabled={snap.clipboard == null} onClick={() => c.pasteInto("")}>
              Paste<ContextMenuShortcut>⌘V</ContextMenuShortcut>
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </ScrollArea>

      <AlertDialog open={confirmDelete != null} onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono text-foreground">{confirmDelete}</span> will be permanently
              removed from the project. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (confirmDelete) c.deleteEntry(confirmDelete);
                setConfirmDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
