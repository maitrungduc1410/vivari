import { useCallback, useEffect, useRef, useState } from "react";
import X from "~icons/lucide/x";
import { cn } from "@/lib/utils";
import { OC_PATH_MIME, entriesFromDataTransfer } from "@/oc/controller";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { FileIcon, FolderIcon } from "./fileIcon";
import { useIde } from "./useIde";

const baseName = (rel: string) => rel.split("/").pop() ?? rel;

export function EditorGroup() {
  const { c, snap } = useIde();
  // A queue of tabs still to close, plus the file we're currently prompting to
  // save. Bulk closes (Close Others/Saved/All…) feed the queue; clean tabs close
  // straight away and each dirty one pops a Save/Don't save/Cancel dialog.
  const [queue, setQueue] = useState<string[]>([]);
  const [promptRel, setPromptRel] = useState<string | null>(null);

  const mountRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) void c.mountEditor(el);
    },
    [c],
  );

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
      (e.dataTransfer.types.includes(OC_PATH_MIME) || e.dataTransfer.types.includes("Files"));
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
      const raw = e.dataTransfer.getData(OC_PATH_MIME);
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
    <div className="flex h-full flex-col bg-[#1e1e1e]">
      {/* tab strip */}
      <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b bg-[#181818]">
        {snap.openTabs.map((rel, i) => {
          const active = rel === snap.activeTab;
          const isDirty = snap.dirty.includes(rel);
          const isPreview = rel === snap.previewTab;
          return (
            <ContextMenu key={rel}>
              <ContextMenuTrigger className="contents">
                <div
                  title={rel}
                  onClick={() => c.openFile(rel, { preview: isPreview })}
                  onDoubleClick={() => c.pinTab(rel)}
                  className={cn(
                    "group flex cursor-pointer items-center gap-1.5 border-r px-3 text-xs",
                    active ? "bg-[#1e1e1e] text-foreground" : "bg-[#181818] text-muted-foreground hover:text-foreground",
                  )}
                >
                  {snap.tabKinds[rel] === "directory" ? (
                    <FolderIcon className="size-3.5 shrink-0" />
                  ) : (
                    <FileIcon name={baseName(rel)} className="size-3.5 shrink-0" />
                  )}
                  <span className={cn(isPreview && "italic")}>{baseName(rel)}</span>
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

      {/* editor host (Monaco mounts here once) */}
      <div ref={dropZoneRef} className="relative flex-1">
        {/* Monaco stays mounted; it's hidden behind the image/directory panes so
            its models + language services survive tab switches. */}
        <div ref={mountRef} className={cn("oc-editor-host absolute inset-0", activeKind !== "text" && "invisible")} />
        {activeKind === "image" && snap.activeTab && <ImageView key={snap.activeTab} abs={snap.activeTab} />}
        {activeKind === "directory" && snap.activeTab && <DirectoryView />}
        {!snap.activeTab && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            {snap.projectTitle ? "Open a file from the Explorer" : "Press Run to start a project"}
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
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 overflow-auto bg-[#1e1e1e] p-6">
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

// Shown when a directory is opened in the editor (dragged onto Monaco).
function DirectoryView() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-[#1e1e1e] p-6 text-center text-sm text-muted-foreground">
      The file is not displayed in the text editor because it is a directory.
    </div>
  );
}
