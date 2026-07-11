import { useEffect, useRef } from "react";
import { Plus, X, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIde } from "./useIde";

export function TerminalPanel() {
  const { c, snap } = useIde();
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Fit the active terminal whenever the panel resizes or the active tab changes.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => c.fitTerminal(snap.activeTermId));
    ro.observe(el);
    return () => ro.disconnect();
  }, [c, snap.activeTermId]);

  useEffect(() => {
    c.fitTerminal(snap.activeTermId);
  }, [c, snap.activeTermId]);

  return (
    <div className="flex h-full flex-col bg-[#181818]">
      <div className="flex h-8 shrink-0 items-center border-b pr-2">
        <div className="flex flex-1 items-stretch overflow-x-auto">
          {snap.terminals.map((t) => {
            const active = t.id === snap.activeTermId;
            return (
              <div
                key={t.id}
                onClick={() => c.switchTerminal(t.id)}
                className={cn(
                  "group flex cursor-pointer items-center gap-2 border-r px-3 text-xs",
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  !t.alive && "italic opacity-60",
                )}
              >
                <span>{t.label}</span>
                {t.kind !== "console" && (
                  <button
                    className="flex size-4 items-center justify-center rounded hover:bg-accent"
                    onClick={(e) => {
                      e.stopPropagation();
                      c.closeTerminal(t.id);
                    }}
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <button
          title="New Terminal"
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => c.newShellTerminal()}
        >
          <Plus className="size-4" />
        </button>
        <button
          title="Hide panel"
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => c.togglePanel(false)}
        >
          <ChevronDown className="size-4" />
        </button>
      </div>

      <div ref={bodyRef} className="relative flex-1 overflow-hidden">
        {snap.terminals.map((t) => (
          <div
            key={t.id}
            className={cn("oc-term-host absolute inset-0", t.id === snap.activeTermId ? "block" : "hidden")}
            ref={(el) => c.mountTerminal(t.id, el)}
          />
        ))}
      </div>
    </div>
  );
}
