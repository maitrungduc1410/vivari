import { useCallback, useState } from "react";
import X from "~icons/lucide/x";
import { cn } from "@/lib/utils";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { FileIcon } from "./fileIcon";
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
                  <FileIcon name={baseName(rel)} className="size-3.5 shrink-0" />
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
      <div className="relative flex-1">
        <div ref={mountRef} className="oc-editor-host absolute inset-0" />
        {!snap.activeTab && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            {snap.projectTitle ? "Open a file from the Explorer" : "Press Run to start a project"}
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
