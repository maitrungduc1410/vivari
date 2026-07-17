import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChevronDown from "~icons/lucide/chevron-down";
import ChevronRight from "~icons/lucide/chevron-right";
import ChevronsDownUp from "~icons/lucide/chevrons-down-up";
import FilePlus from "~icons/lucide/file-plus";
import FolderPlus from "~icons/lucide/folder-plus";
import RefreshCw from "~icons/lucide/refresh-cw";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  ContextMenuShortcut, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { FileIcon, FolderIcon } from "./fileIcon";
import { useIde } from "./useIde";
import { VV_PATH_MIME, entriesFromDataTransfer } from "@/vv/controller";

interface Entry {
  name: string;
  dir: boolean;
}

const baseName = (abs: string) => abs.split("/").filter(Boolean).pop() ?? abs;
const parentDir = (abs: string) => abs.slice(0, abs.lastIndexOf("/")) || "/";
const modKey = (e: React.KeyboardEvent) => e.metaKey || e.ctrlKey;

// A pending inline "new file" / "new folder" input.
interface Creating {
  dir: string;
  kind: "file" | "folder";
}

export function Explorer() {
  const { c, snap } = useIde();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Record<string, Entry[]>>({});
  // Multi-selection: the set of selected absolute paths + the range "anchor"
  // (last plain/Cmd-clicked row) that Shift-click extends from.
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [creating, setCreating] = useState<Creating | null>(null);
  const [createValue, setCreateValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const loading = useRef<Set<string>>(new Set());
  // The focusable tree container. Clicking a row focuses it so Explorer
  // shortcuts (Cmd/Ctrl+A to select all, Esc to clear) work even when the
  // editor had focus — matching VSCode (a single click doesn't focus the editor).
  const treeRef = useRef<HTMLDivElement>(null);

  // ── drag & drop ────────────────────────────────────────────────────────────
  // Make a row a drag source. Dragging a row that's part of a multi-selection
  // carries the whole selection (newline-joined) in the VV_PATH_MIME slot.
  const dragProps = (abs: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.stopPropagation(); // don't let an ancestor row overwrite the payload
      const paths = selection.has(abs) && selection.size > 1 ? [...selection] : [abs];
      const payload = paths.join("\n");
      e.dataTransfer.setData(VV_PATH_MIME, payload);
      e.dataTransfer.setData("text/plain", payload);
      e.dataTransfer.effectAllowed = "copyMove";
    },
    onDragEnd: () => setDragOver(null),
  });

  // Make a row/area a drop target that reorganizes (internal) or imports (OS).
  // `destDir` receives the drop; `key` drives the hover highlight.
  const dropProps = (destDir: string | null, key: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!destDir) return;
      e.preventDefault();
      e.stopPropagation();
      const internal = e.dataTransfer.types.includes(VV_PATH_MIME);
      e.dataTransfer.dropEffect = internal ? (e.ctrlKey || e.metaKey ? "copy" : "move") : "copy";
      if (dragOver !== key) setDragOver(key);
    },
    onDragLeave: () => setDragOver((cur) => (cur === key ? null : cur)),
    onDrop: (e: React.DragEvent) => {
      if (!destDir) return;
      e.preventDefault();
      e.stopPropagation();
      setDragOver(null);
      const raw = e.dataTransfer.getData(VV_PATH_MIME);
      if (raw) {
        const paths = raw.split("\n").filter(Boolean);
        if (e.ctrlKey || e.metaKey) void c.copyEntriesTo(paths, destDir);
        else void c.moveEntries(paths, destDir);
        return;
      }
      const entries = entriesFromDataTransfer(e.dataTransfer);
      if (entries.length) void c.importInto(destDir, entries);
    },
  });

  // Load a directory's children from the live VFS (once, unless refreshed).
  const load = useCallback(
    async (dir: string) => {
      if (loading.current.has(dir)) return;
      loading.current.add(dir);
      const entries = await c.readdir(dir);
      loading.current.delete(dir);
      entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
      setChildren((prev) => ({ ...prev, [dir]: entries }));
    },
    [c],
  );

  // Auto-expand roots as they open.
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const f of snap.workspaceFolders) next.add(f.rootPath);
      return next;
    });
  }, [snap.workspaceFolders]);

  // Fetch the children of every expanded dir that we haven't loaded yet.
  useEffect(() => {
    for (const dir of expanded) if (!(dir in children)) void load(dir);
  }, [expanded, children, load]);

  // A VFS change (file op / install / create) bumps treeVersion → re-read every
  // directory we currently have loaded, so the tree reflects reality.
  useEffect(() => {
    if (!snap.treeVersion) return;
    for (const dir of Object.keys(children)) void load(dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.treeVersion]);

  const toggle = (dir: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else { next.add(dir); if (!(dir in children)) void load(dir); }
      return next;
    });

  const startRename = (abs: string) => {
    setCreating(null);
    setRenaming(abs);
    setRenameValue(baseName(abs));
  };
  const commitRename = () => {
    if (!renaming) return;
    const name = renameValue.trim();
    if (name && name !== baseName(renaming)) c.renameEntry(renaming, name);
    setRenaming(null);
  };

  const startCreate = (dir: string, kind: "file" | "folder") => {
    setRenaming(null);
    if (!expanded.has(dir)) toggle(dir);
    setCreating({ dir, kind });
    setCreateValue("");
  };
  const commitCreate = () => {
    if (!creating) return;
    const name = createValue.trim();
    if (name) {
      if (creating.kind === "file") void c.newFile(creating.dir, name);
      else void c.newFolder(creating.dir, name);
    }
    setCreating(null);
  };

  // The visible rows in render order (respecting expansion), used for Shift-range
  // selection and Select All.
  const flatVisible = useMemo(() => {
    const rows: { abs: string; isDir: boolean }[] = [];
    const walk = (dir: string) => {
      for (const e of children[dir] ?? []) {
        const abs = dir + "/" + e.name;
        rows.push({ abs, isDir: e.dir });
        if (e.dir && expanded.has(abs)) walk(abs);
      }
    };
    for (const f of snap.workspaceFolders) if (expanded.has(f.rootPath)) walk(f.rootPath);
    return rows;
  }, [children, expanded, snap.workspaceFolders]);
  const isDirOf = (abs: string) => flatVisible.find((r) => r.abs === abs)?.isDir ?? false;

  // Apply a click to the selection: Shift extends a range from the anchor,
  // Cmd/Ctrl toggles one row, a plain click selects just that row.
  const applySelect = (e: React.MouseEvent, abs: string) => {
    if (e.shiftKey && anchor) {
      const ai = flatVisible.findIndex((r) => r.abs === anchor);
      const bi = flatVisible.findIndex((r) => r.abs === abs);
      if (ai !== -1 && bi !== -1) {
        const [lo, hi] = ai <= bi ? [ai, bi] : [bi, ai];
        setSelection(new Set(flatVisible.slice(lo, hi + 1).map((r) => r.abs)));
        return;
      }
      setSelection(new Set([abs]));
      setAnchor(abs);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      setSelection((prev) => {
        const next = new Set(prev);
        if (next.has(abs)) next.delete(abs);
        else next.add(abs);
        return next;
      });
      setAnchor(abs);
      return;
    }
    setSelection(new Set([abs]));
    setAnchor(abs);
  };

  // A row was clicked: update selection, and (only for a plain click) open a
  // file or toggle a folder. Modifier-clicks just change the selection.
  const handleRowClick = (e: React.MouseEvent, abs: string, isDir: boolean, folderId: string) => {
    treeRef.current?.focus({ preventScroll: true });
    c.setActiveFolder(folderId);
    applySelect(e, abs);
    if (e.shiftKey || e.metaKey || e.ctrlKey) return;
    if (isDir) toggle(abs);
    else void c.openEntry(abs, { preview: true, focus: false }); // keep focus in the tree
  };

  // When a context menu opens on an unselected row, make it the sole selection
  // (so menu actions target it); keep an existing multi-selection intact.
  const selectForContext = (abs: string) => {
    if (!selection.has(abs)) { setSelection(new Set([abs])); setAnchor(abs); }
  };
  // The paths a context-menu action should affect: the whole selection if the
  // clicked row is part of it, else just that row.
  const effective = (abs: string) => (selection.has(abs) && selection.size > 1 ? [...selection] : [abs]);

  // Where a paste lands: into the anchor if it's a folder, else its parent.
  const pasteDest = () => {
    if (anchor) return isDirOf(anchor) ? anchor : parentDir(anchor);
    return c.activeFolder?.rootPath ?? "/";
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (renaming || creating) return;
    const k = e.key.toLowerCase();
    if (e.key === "Escape") { setSelection(new Set()); setAnchor(null); return; }
    if (modKey(e) && k === "a") { e.preventDefault(); setSelection(new Set(flatVisible.map((r) => r.abs))); return; }
    const sel = [...selection];
    if (!sel.length) return;
    if (e.key === "Enter") { e.preventDefault(); if (sel.length === 1) startRename(sel[0]); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); setConfirmDelete(sel); }
    else if (modKey(e) && k === "c") { e.preventDefault(); c.copyEntries(sel); }
    else if (modKey(e) && k === "x") { e.preventDefault(); c.cutEntries(sel); }
    else if (modKey(e) && k === "v") { e.preventDefault(); void c.pasteInto(pasteDest()); }
  };

  const nameInput = (value: string, onChange: (v: string) => void, commit: () => void, cancel: () => void) => (
    <NameInput value={value} onChange={onChange} commit={commit} cancel={cancel} />
  );

  // Render the children of `dir` (must be expanded). `folderId` = owning root.
  const renderChildren = (dir: string, depth: number, folderId: string): React.ReactNode => {
    const entries = children[dir];
    return (
      <>
        {creating?.dir === dir && (
          <div className="flex items-center gap-1.5 py-0.5" style={{ paddingLeft: 8 + depth * 12 + 4 }}>
            {creating.kind === "folder" ? <FolderIcon open={false} className="size-4 shrink-0" /> : <FileIcon name={createValue || "x"} className="size-4 shrink-0" />}
            {nameInput(createValue, setCreateValue, commitCreate, () => setCreating(null))}
          </div>
        )}
        {entries === undefined ? (
          <div className="py-0.5 text-xs text-muted-foreground" style={{ paddingLeft: 8 + depth * 12 + 16 }}>…</div>
        ) : entries.length === 0 && creating?.dir !== dir ? null : (
          entries.map((e) => {
            const abs = dir + "/" + e.name;
            return e.dir
              ? renderDir(abs, e.name, depth, folderId)
              : renderFile(abs, e.name, depth, folderId);
          })
        )}
      </>
    );
  };

  const renderDir = (abs: string, name: string, depth: number, folderId: string): React.ReactNode => {
    const open = expanded.has(abs);
    const isRenaming = renaming === abs;
    return (
      <div key={abs}>
        <RowMenu abs={abs} isDir destDir={abs} folderId={folderId} c={c} canPaste={snap.clipboard != null}
          onContextMenuOpen={() => { c.setActiveFolder(folderId); selectForContext(abs); }}
          onCopy={() => c.copyEntries(effective(abs))} onCut={() => c.cutEntries(effective(abs))}
          onOpen={() => toggle(abs)} onRename={() => startRename(abs)} onDelete={() => setConfirmDelete(effective(abs))}
          onNewFile={() => startCreate(abs, "file")} onNewFolder={() => startCreate(abs, "folder")}>
          <div
            {...dragProps(abs)}
            {...dropProps(abs, abs)}
            className={cn(
              "flex w-full items-center gap-1 py-0.5 text-left text-sm",
              dragOver === abs
                ? "bg-accent/80 text-foreground ring-1 ring-inset ring-primary"
                : selection.has(abs) ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={(e) => handleRowClick(e, abs, true, folderId)}
          >
            {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
            <FolderIcon open={open} className="size-4 shrink-0" />
            {isRenaming ? nameInput(renameValue, setRenameValue, commitRename, () => setRenaming(null)) : <span className="truncate">{name}</span>}
          </div>
        </RowMenu>
        {open && renderChildren(abs, depth + 1, folderId)}
      </div>
    );
  };

  const renderFile = (abs: string, name: string, depth: number, folderId: string): React.ReactNode => {
    const isRenaming = renaming === abs;
    return (
      <RowMenu key={abs} abs={abs} isDir={false} destDir={parentDir(abs)} folderId={folderId} c={c} canPaste={snap.clipboard != null}
        onContextMenuOpen={() => { c.setActiveFolder(folderId); selectForContext(abs); }}
        onCopy={() => c.copyEntries(effective(abs))} onCut={() => c.cutEntries(effective(abs))}
        onOpen={() => c.openEntry(abs, { preview: false })} onRename={() => startRename(abs)} onDelete={() => setConfirmDelete(effective(abs))}
        onNewFile={() => startCreate(parentDir(abs), "file")} onNewFolder={() => startCreate(parentDir(abs), "folder")}>
        <div
          {...dragProps(abs)}
          {...dropProps(parentDir(abs), abs)}
          className={cn(
            "flex w-full items-center gap-1.5 py-0.5 text-left text-sm",
            dragOver === abs
              ? "bg-accent/80 text-foreground ring-1 ring-inset ring-primary"
              : selection.has(abs) || snap.activeTab === abs ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50",
          )}
          style={{ paddingLeft: 8 + depth * 12 + 16 }}
          onClick={(e) => handleRowClick(e, abs, false, folderId)}
          onDoubleClick={() => void c.openEntry(abs, { preview: false })}
        >
          <FileIcon name={name} className="size-4 shrink-0" />
          {isRenaming ? nameInput(renameValue, setRenameValue, commitRename, () => setRenaming(null)) : <span className="truncate">{name}</span>}
        </div>
      </RowMenu>
    );
  };

  const active = c.activeFolder;

  return (
    <div className="flex h-full flex-col bg-sidebar" onKeyDown={onKeyDown}>
      <div className="flex h-8 shrink-0 items-center gap-1 pl-3 pr-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span className="flex-1 truncate">Explorer</span>
        <HeaderBtn label="New File" onClick={() => active && startCreate(active.rootPath, "file")} disabled={!active}>
          <FilePlus className="size-3.5" />
        </HeaderBtn>
        <HeaderBtn label="New Folder" onClick={() => active && startCreate(active.rootPath, "folder")} disabled={!active}>
          <FolderPlus className="size-3.5" />
        </HeaderBtn>
        <HeaderBtn label="Refresh" onClick={() => setChildren({})}>
          <RefreshCw className="size-3.5" />
        </HeaderBtn>
        <HeaderBtn
          label="Collapse Folders in Workspace"
          onClick={() => setExpanded(new Set())}
          disabled={snap.workspaceFolders.length === 0}
        >
          <ChevronsDownUp className="size-3.5" />
        </HeaderBtn>
      </div>
      <ScrollArea className="flex-1">
        <div
          ref={treeRef}
          className={cn("min-h-full pb-4 outline-none", dragOver === "__area__" && "bg-accent/30")}
          tabIndex={0}
          {...dropProps(active?.rootPath ?? null, "__area__")}
        >
          {snap.workspaceFolders.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              No folder open. Go <button className="text-foreground underline" onClick={() => c.goHome()}>Home</button> to create or open a project.
            </div>
          ) : (
            snap.workspaceFolders.map((f) => {
              const open = expanded.has(f.rootPath);
              return (
                <div key={f.id}>
                  <RowMenu abs={f.rootPath} isDir destDir={f.rootPath} folderId={f.id} c={c} canPaste={snap.clipboard != null} isRoot
                    onContextMenuOpen={() => c.setActiveFolder(f.id)}
                    onCopy={() => c.copyEntry(f.rootPath)} onCut={() => c.cutEntry(f.rootPath)}
                    onOpen={() => toggle(f.rootPath)} onRename={() => { /* roots aren't renamed */ }} onDelete={() => c.closeFolder(f.id)}
                    onNewFile={() => startCreate(f.rootPath, "file")} onNewFolder={() => startCreate(f.rootPath, "folder")}>
                    <div
                      {...dropProps(f.rootPath, f.id)}
                      className={cn(
                        "flex w-full items-center gap-1 py-1 pl-2 text-left text-[11px] font-semibold uppercase tracking-wide",
                        dragOver === f.id
                          ? "bg-accent/80 text-foreground ring-1 ring-inset ring-primary"
                          : snap.activeFolderId === f.id ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => { treeRef.current?.focus({ preventScroll: true }); c.setActiveFolder(f.id); toggle(f.rootPath); }}
                    >
                      {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
                      <span className="truncate">{f.name}</span>
                    </div>
                  </RowMenu>
                  {open && renderChildren(f.rootPath, 1, f.id)}
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>

      <AlertDialog open={confirmDelete != null} onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete && confirmDelete.length === 1 ? (
                <><span className="font-mono text-foreground">{confirmDelete[0]}</span> will be permanently removed. This cannot be undone.</>
              ) : (
                <><span className="font-mono text-foreground">{confirmDelete?.length ?? 0} items</span> will be permanently removed. This cannot be undone.</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (confirmDelete) c.deleteEntries(confirmDelete);
                setSelection(new Set());
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

// Inline rename / create field. The initial selection must happen exactly once
// (on mount) — doing it in an inline `ref` re-selects the whole value on every
// keystroke's re-render, which makes typed characters replace the selection so
// only the last character survives.
function NameInput({ value, onChange, commit, cancel }: {
  value: string; onChange: (v: string) => void; commit: () => void; cancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = el.value.indexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
    // Run once on mount only — never re-select on subsequent renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") cancel();
      }}
      onBlur={commit}
      className="min-w-0 flex-1 rounded-sm bg-background px-1 text-sm text-foreground outline outline-1 outline-primary"
    />
  );
}

function HeaderBtn({ label, onClick, disabled, children }: {
  label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        onClick={onClick}
        disabled={disabled}
        className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function RowMenu({
  abs, isDir, destDir, c, canPaste, isRoot, children,
  onContextMenuOpen, onCopy, onCut, onOpen, onRename, onDelete, onNewFile, onNewFolder,
}: {
  abs: string; isDir: boolean; destDir: string; folderId: string;
  c: ReturnType<typeof useIde>["c"]; canPaste: boolean; isRoot?: boolean; children: React.ReactNode;
  onContextMenuOpen: () => void; onCopy: () => void; onCut: () => void;
  onOpen: () => void; onRename: () => void; onDelete: () => void; onNewFile: () => void; onNewFolder: () => void;
}) {
  const termDir = isDir ? abs : destDir;
  return (
    <ContextMenu>
      <ContextMenuTrigger className="block w-full" onContextMenu={onContextMenuOpen}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onClick={onOpen}>Open</ContextMenuItem>
        {isDir && (
          <>
            <ContextMenuItem onClick={onNewFile}>New File…</ContextMenuItem>
            <ContextMenuItem onClick={onNewFolder}>New Folder…</ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => c.openTerminalIn(termDir)}>Open in Integrated Terminal</ContextMenuItem>
        <ContextMenuItem onClick={() => c.copyPath(abs)}>Copy Path</ContextMenuItem>
        {isRoot && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => void c.exportProjectZip(abs)}>Export as Zip…</ContextMenuItem>
            <ContextMenuItem onClick={() => void c.shareProject(abs)}>Share (copy link)</ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        {!isRoot && (
          <ContextMenuItem onClick={onRename}>
            Rename<ContextMenuShortcut>↵</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={onCopy}>
          Copy<ContextMenuShortcut>⌘C</ContextMenuShortcut>
        </ContextMenuItem>
        {!isRoot && (
          <ContextMenuItem onClick={onCut}>
            Cut<ContextMenuShortcut>⌘X</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        <ContextMenuItem disabled={!canPaste} onClick={() => void c.pasteInto(destDir)}>
          Paste<ContextMenuShortcut>⌘V</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        {isRoot ? (
          <ContextMenuItem onClick={onDelete}>Close Folder</ContextMenuItem>
        ) : (
          <ContextMenuItem variant="destructive" onClick={onDelete}>Delete permanently</ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
