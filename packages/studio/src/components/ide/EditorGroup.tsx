import { useCallback, useEffect, useRef, useState } from "react";
import X from "~icons/lucide/x";
import ChevronRight from "~icons/lucide/chevron-right";
import { cn } from "@/lib/utils";
import { VV_PATH_MIME, entriesFromDataTransfer, isDiffTabId, diffTargetOf, type WorkspaceFolder } from "@/vv/controller";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { FileIcon, FolderIcon } from "./fileIcon";
import { NotebookView } from "./NotebookView";
import { useIde } from "./useIde";

const baseName = (rel: string) => rel.split("/").pop() ?? rel;

// Drag payload for reordering tabs within the strip (kept distinct from the
// Explorer's VV_PATH_MIME so the editor-body drop zone ignores tab drags).
const VV_TAB_MIME = "application/x-vv-tab";

export function EditorGroup() {
  const { c, snap } = useIde();
  // A queue of tabs still to close, plus the file we're currently prompting to
  // save. Bulk closes (Close Others/Saved/All…) feed the queue; clean tabs close
  // straight away and each dirty one pops a Save/Don't save/Cancel dialog.
  const [queue, setQueue] = useState<string[]>([]);
  const [promptRel, setPromptRel] = useState<string | null>(null);
  // Tab reordering: the tab being dragged + the current drop target/side.
  const [dragTab, setDragTab] = useState<string | null>(null);
  const [overTab, setOverTab] = useState<{ rel: string; after: boolean } | null>(null);

  const mountRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) void c.mountEditor(el);
    },
    [c],
  );

  // Keep the active tab on screen. Past ~7 open files the strip overflows, and
  // activating a tab from anywhere but the strip itself (Explorer click, ⌘P, a
  // diff opening) leaves the selected tab scrolled out of sight — the editor
  // changes under you while no visible tab looks active.
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [snap.activeTab, snap.openTabs.length]);

  // Drop zone over the whole editor area. We use capture-phase native listeners
  // (not React props) so we intercept the drop before Monaco's own DOM handlers,
  // and read the DataTransfer synchronously (its item list dies after we yield).
  const dropZoneRef = useRef<HTMLDivElement | null>(null);
  const [dropActive, setDropActive] = useState(false);
  useEffect(() => {
    const el = dropZoneRef.current;
    if (!el) return;
    const isDrag = (e: DragEvent) =>
      !!e.dataTransfer &&
      (e.dataTransfer.types.includes(VV_PATH_MIME) || e.dataTransfer.types.includes("Files"));
    const onOver = (e: DragEvent) => {
      if (!isDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      setDropActive(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!el.contains(e.relatedTarget as Node)) setDropActive(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer || !isDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropActive(false);
      const raw = e.dataTransfer.getData(VV_PATH_MIME);
      const paths = raw ? raw.split("\n").filter(Boolean) : [];
      const entries = paths.length ? [] : entriesFromDataTransfer(e.dataTransfer);
      void c.dropOnEditor({ paths, entries });
    };
    el.addEventListener("dragover", onOver, true);
    el.addEventListener("dragleave", onLeave, true);
    el.addEventListener("drop", onDrop, true);
    return () => {
      el.removeEventListener("dragover", onOver, true);
      el.removeEventListener("dragleave", onLeave, true);
      el.removeEventListener("drop", onDrop, true);
    };
  }, [c]);

  const activeKind = snap.activeTab ? snap.tabKinds[snap.activeTab] ?? "text" : "text";

  const processQueue = (rels: string[]) => {
    let rest = rels;
    while (rest.length) {
      const rel = rest[0];
      if (snap.dirty.includes(rel)) {
        setQueue(rest.slice(1));
        setPromptRel(rel);
        return;
      }
      c.closeTab(rel);
      rest = rest.slice(1);
    }
    setQueue([]);
    setPromptRel(null);
  };

  const cancelClose = () => { setPromptRel(null); setQueue([]); };

  return (
    <div className="flex h-full flex-col bg-white dark:bg-[#1e1e1e]">
      {/* tab strip */}
      <div className="vv-tabs-scroll flex h-9 shrink-0 items-stretch overflow-x-auto border-b bg-[#f3f3f3] dark:bg-[#181818]">
        {snap.openTabs.map((rel, i) => {
          const active = rel === snap.activeTab;
          const isDirty = snap.dirty.includes(rel);
          const isPreview = rel === snap.previewTab;
          const dropSide = overTab?.rel === rel && dragTab && dragTab !== rel
            ? overTab.after
              ? "shadow-[inset_-2px_0_0_0_var(--primary)]"
              : "shadow-[inset_2px_0_0_0_var(--primary)]"
            : "";
          const isDiff = isDiffTabId(rel);
          return (
            <ContextMenu key={rel}>
              <ContextMenuTrigger className="contents">
                <div
                  ref={active ? activeTabRef : undefined}
                  title={isDiff ? diffTargetOf(rel) : rel}
                  draggable
                  onClick={() => c.openFile(rel, { preview: isPreview })}
                  onDoubleClick={() => c.pinTab(rel)}
                  // Middle-click closes the tab, as it does in VS Code. Goes through
                  // the same queue as the ✕ so a dirty file still gets its prompt.
                  onAuxClick={(e) => {
                    if (e.button !== 1) return;
                    e.preventDefault();
                    processQueue([rel]);
                  }}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(VV_TAB_MIME, rel);
                    e.dataTransfer.effectAllowed = "move";
                    setDragTab(rel);
                  }}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes(VV_TAB_MIME)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    const rect = e.currentTarget.getBoundingClientRect();
                    setOverTab({ rel, after: e.clientX - rect.left > rect.width / 2 });
                  }}
                  onDrop={(e) => {
                    if (!e.dataTransfer.types.includes(VV_TAB_MIME)) return;
                    e.preventDefault();
                    const from = e.dataTransfer.getData(VV_TAB_MIME);
                    if (from) c.reorderTab(from, rel, e.clientX - e.currentTarget.getBoundingClientRect().left > e.currentTarget.getBoundingClientRect().width / 2);
                    setDragTab(null);
                    setOverTab(null);
                  }}
                  onDragEnd={() => { setDragTab(null); setOverTab(null); }}
                  className={cn(
                    "group flex cursor-pointer items-center gap-1.5 border-r px-3 text-xs",
                    active ? "bg-white text-foreground shadow-[inset_0_2px_0_0_#007acc] dark:bg-[#1e1e1e]" : "bg-[#f3f3f3] text-muted-foreground hover:text-foreground dark:bg-[#181818]",
                    dragTab === rel && "opacity-50",
                    dropSide,
                  )}
                >
                  {snap.tabKinds[rel] === "directory" ? (
                    <FolderIcon className="size-3.5 shrink-0" />
                  ) : (
                    <FileIcon name={baseName(rel)} className="size-3.5 shrink-0" />
                  )}
                  <span className={cn(isPreview && "italic")}>
                    {baseName(rel)}
                    {isDiff && <span className="ml-1 opacity-60">(Working Tree)</span>}
                  </span>
                  <button
                    className="flex size-4 items-center justify-center rounded hover:bg-accent"
                    onClick={(e) => { e.stopPropagation(); processQueue([rel]); }}
                    title="Close"
                  >
                    {isDirty ? (
                      <>
                        <span className="size-2 rounded-full bg-foreground group-hover:hidden" />
                        <X className="hidden size-3 group-hover:block" />
                      </>
                    ) : (
                      <X className={cn("size-3", active ? "block" : "hidden group-hover:block")} />
                    )}
                  </button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-48">
                <ContextMenuItem onClick={() => processQueue([rel])}>Close</ContextMenuItem>
                <ContextMenuItem
                  disabled={snap.openTabs.length <= 1}
                  onClick={() => processQueue(snap.openTabs.filter((t) => t !== rel))}
                >
                  Close Others
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={i >= snap.openTabs.length - 1}
                  onClick={() => processQueue(snap.openTabs.slice(i + 1))}
                >
                  Close to the Right
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={snap.openTabs.every((t) => snap.dirty.includes(t))}
                  onClick={() => processQueue(snap.openTabs.filter((t) => !snap.dirty.includes(t)))}
                >
                  Close Saved
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => processQueue([...snap.openTabs])}>Close All</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>

      {/* breadcrumb: Workspace-relative path of the active file (or diff target) */}
      {snap.activeTab && (
        <Breadcrumb
          abs={isDiffTabId(snap.activeTab) ? diffTargetOf(snap.activeTab) : snap.activeTab}
          folders={snap.workspaceFolders}
        />
      )}

      {/* editor host (Monaco mounts here once) */}
      <div ref={dropZoneRef} className="relative flex-1">
        {/* Monaco stays mounted; it's hidden behind the image/directory panes so
            its models + language services survive tab switches. */}
        <div ref={mountRef} className={cn("vv-editor-host absolute inset-0", activeKind !== "text" && "invisible")} />
        {activeKind === "image" && snap.activeTab && <ImageView key={snap.activeTab} abs={snap.activeTab} />}
        {activeKind === "directory" && snap.activeTab && <DirectoryView />}
        {activeKind === "diff" && snap.activeTab && <DiffView key={snap.activeTab} id={snap.activeTab} />}
        {activeKind === "notebook" && snap.activeTab && <NotebookView key={snap.activeTab} abs={snap.activeTab} />}
        {!snap.activeTab && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            {snap.projectTitle ? "Open a file from the Workspace" : "Press Run to start a project"}
          </div>
        )}
        {dropActive && (
          <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-md border-2 border-dashed border-primary bg-primary/10 text-sm font-medium text-foreground">
            Drop to open in the editor
          </div>
        )}
      </div>

      {/* unsaved-changes prompt on close */}
      <AlertDialog open={promptRel != null} onOpenChange={(o) => { if (!o) cancelClose(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Do you want to save the changes you made to {promptRel ? baseName(promptRel) : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>Your changes will be lost if you don't save them.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="secondary"
              onClick={() => {
                if (promptRel) { c.discardFile(promptRel); c.closeTab(promptRel); }
                setPromptRel(null);
                processQueue(queue);
              }}
            >
              Don't Save
            </Button>
            <AlertDialogAction
              onClick={() => {
                if (promptRel) { c.saveFile(promptRel); c.closeTab(promptRel); }
                setPromptRel(null);
                processQueue(queue);
              }}
            >
              Save
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// Image preview pane (raster + svg). The object URL is created/owned by the
// controller (revoked when the tab closes), so we just render it.
function ImageView({ abs }: { abs: string }) {
  const { c } = useIde();
  const url = c.imageUrlFor(abs);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 overflow-auto bg-white p-6 dark:bg-[#1e1e1e]">
      <div
        className="max-h-full max-w-full"
        style={{
          backgroundImage:
            "linear-gradient(45deg,#2a2a2a 25%,transparent 25%),linear-gradient(-45deg,#2a2a2a 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#2a2a2a 75%),linear-gradient(-45deg,transparent 75%,#2a2a2a 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0,0 8px,8px -8px,-8px 0",
        }}
      >
        {url ? (
          <img
            src={url}
            alt={baseName(abs)}
            className="max-h-[calc(100vh-12rem)] max-w-full object-contain"
            onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          />
        ) : (
          <div className="p-8 text-sm text-muted-foreground">Loading image…</div>
        )}
      </div>
      <div className="text-xs text-muted-foreground">
        {baseName(abs)}
        {dims ? ` · ${dims.w}×${dims.h}` : ""}
      </div>
    </div>
  );
}

// Split an active file's absolute path into breadcrumb segments, led by a
// literal "Workspace" root and the containing project's name (e.g.
// "Workspace > my-app > src > components > App.tsx"). Files outside any open
// folder fall back to their full path under "Workspace".
function crumbsFor(abs: string, folders: WorkspaceFolder[]): string[] {
  const folder = folders.find(
    (f) => abs === f.rootPath || abs.startsWith(f.rootPath + "/"),
  );
  if (folder) {
    const rel = abs.slice(folder.rootPath.length);
    return ["Workspace", folder.name, ...rel.split("/").filter(Boolean)];
  }
  return ["Workspace", ...abs.split("/").filter(Boolean)];
}

// VS Code-style breadcrumb strip above the editor body.
function Breadcrumb({ abs, folders }: { abs: string; folders: WorkspaceFolder[] }) {
  const crumbs = crumbsFor(abs, folders);
  return (
    <div className="vv-tabs-scroll flex h-6 shrink-0 items-center gap-0.5 overflow-x-auto whitespace-nowrap border-b bg-white px-3 text-xs text-muted-foreground dark:bg-[#1e1e1e]">
      {crumbs.map((seg, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <span key={i} className="flex shrink-0 items-center gap-0.5">
            {i > 0 && <ChevronRight className="size-3 opacity-60" />}
            {isLast && crumbs.length > 1 ? (
              <span className="flex items-center gap-1 text-foreground">
                <FileIcon name={seg} className="size-3.5 shrink-0" />
                {seg}
              </span>
            ) : (
              <span>{seg}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}

// Source Control diff tab: a read-only Monaco diff editor (HEAD ↔ working tree).
// Keyed by tab id in the parent, so it remounts per diff tab and the controller
// rebinds fresh original/modified models.
function DiffView({ id }: { id: string }) {
  const { c } = useIde();
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) void c.mountDiffEditor(el, id);
    },
    [c, id],
  );
  return <div ref={ref} className="absolute inset-0" />;
}

// Shown when a directory is opened in the editor (dragged onto Monaco).
function DirectoryView() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-white p-6 text-center text-sm text-muted-foreground dark:bg-[#1e1e1e]">
      The file is not displayed in the text editor because it is a directory.
    </div>
  );
}