import { useCallback } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIde } from "./useIde";

const baseName = (rel: string) => rel.split("/").pop() ?? rel;

export function EditorGroup() {
  const { c, snap } = useIde();

  const mountRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) void c.mountEditor(el);
    },
    [c],
  );

  return (
    <div className="flex h-full flex-col bg-[#1e1e1e]">
      {/* tab strip */}
      <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b bg-[#181818]">
        {snap.openTabs.map((rel) => {
          const active = rel === snap.activeTab;
          const isDirty = snap.dirty.includes(rel);
          return (
            <div
              key={rel}
              title={rel}
              onClick={() => c.openFile(rel)}
              className={cn(
                "group flex cursor-pointer items-center gap-2 border-r px-3 text-xs",
                active ? "bg-[#1e1e1e] text-foreground" : "bg-[#181818] text-muted-foreground hover:text-foreground",
              )}
            >
              <span>{baseName(rel)}</span>
              <button
                className="flex size-4 items-center justify-center rounded hover:bg-accent"
                onClick={(e) => {
                  e.stopPropagation();
                  c.closeTab(rel);
                }}
              >
                {isDirty ? (
                  <span className="size-2 rounded-full bg-foreground group-hover:hidden" />
                ) : null}
                <X className={cn("size-3", isDirty && "hidden group-hover:block")} />
              </button>
            </div>
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
    </div>
  );
}
