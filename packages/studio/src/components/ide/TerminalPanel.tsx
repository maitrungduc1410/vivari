import { useEffect, useRef } from "react";
import Plus from "~icons/lucide/plus";
import Trash2 from "~icons/lucide/trash-2";
import ChevronDown from "~icons/lucide/chevron-down";
import ExternalLink from "~icons/lucide/external-link";
import SquareTerminal from "~icons/lucide/square-terminal";
import { cn } from "@/lib/utils";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useIde } from "./useIde";

const PANEL_TABS = [
  { id: "console", label: "Console" },
  { id: "terminal", label: "Terminal" },
  { id: "ports", label: "Ports" },
] as const;

export function TerminalPanel() {
  const { c, snap } = useIde();
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const visibleTermId =
    snap.panelTab === "console" ? "console" : snap.panelTab === "terminal" ? snap.activeTermId : null;

  // Fit the visible terminal whenever the panel resizes or the visible tab/term changes.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => c.fitTerminal(visibleTermId));
    ro.observe(el);
    return () => ro.disconnect();
  }, [c, visibleTermId]);

  useEffect(() => {
    c.fitTerminal(visibleTermId);
  }, [c, visibleTermId]);

  const shells = snap.terminals.filter((t) => t.kind === "shell");

  return (
    <div className="flex h-full flex-col bg-white dark:bg-[#181818]">
      {/* panel tab strip */}
      <div className="flex h-8 shrink-0 items-center border-b pr-2">
        <div className="flex flex-1 items-stretch">
          {PANEL_TABS.map((tab) => {
            const active = tab.id === snap.panelTab;
            return (
              <button
                key={tab.id}
                onClick={() => c.setPanelTab(tab.id)}
                className={cn(
                  "flex items-center border-b-2 px-3 text-xs font-medium uppercase tracking-wide transition-colors",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
                {tab.id === "ports" && snap.ports.length > 0 && (
                  <span className="ml-1.5 rounded bg-muted px-1 text-[10px] leading-4 text-muted-foreground">
                    {snap.ports.length}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {snap.panelTab === "terminal" && (
          <button
            title="New Terminal"
            className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => c.newShellTerminal()}
          >
            <Plus className="size-4" />
          </button>
        )}
        <button
          title="Hide panel"
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => c.togglePanel(false)}
        >
          <ChevronDown className="size-4" />
        </button>
      </div>

      {/* body — all xterm hosts stay mounted so scrollback survives tab switches */}
      <div ref={bodyRef} className="relative flex-1 overflow-hidden">
        {/* Console */}
        <div className={cn("absolute inset-0", snap.panelTab === "console" ? "block" : "hidden")}>
          <div className="vv-term-host absolute inset-0" ref={(el) => c.mountTerminal("console", el)} />
        </div>

        {/* Terminal: xterm on the left, terminal list on the right (resizable) */}
        <div className={cn("absolute inset-0", snap.panelTab === "terminal" ? "block" : "hidden")}>
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel
              id="term-content"
              defaultSize="80%"
              minSize="30%"
              // Refit the visible xterm whenever the split is dragged.
              onResize={() => c.fitTerminal(visibleTermId)}
            >
              <div className="relative h-full min-w-0">
                {shells.length === 0 && (
                  <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                    No terminals. Press <span className="mx-1 text-foreground">+</span> to create one.
                  </div>
                )}
                {shells.map((t) => (
                  <div
                    key={t.id}
                    className={cn(
                      "vv-term-host absolute inset-0",
                      snap.panelTab === "terminal" && t.id === snap.activeTermId ? "block" : "hidden",
                    )}
                    ref={(el) => c.mountTerminal(t.id, el)}
                  />
                ))}
              </div>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="term-list" defaultSize="20%" minSize="10%" maxSize="45%">
              <ul className="h-full overflow-y-auto border-l bg-sidebar py-1 text-xs">
                {shells.map((t) => {
                  const active = t.id === snap.activeTermId;
                  return (
                    <li key={t.id}>
                      <div
                        onClick={() => c.switchTerminal(t.id)}
                        className={cn(
                          "group flex cursor-pointer items-center gap-1.5 px-2 py-1",
                          active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                          !t.alive && "italic opacity-60",
                        )}
                      >
                        <SquareTerminal className="size-3.5 shrink-0 opacity-70" />
                        <span className="truncate">{t.label}</span>
                        <button
                          title="Kill terminal"
                          className="ml-auto hidden size-4 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground group-hover:flex"
                          onClick={(e) => {
                            e.stopPropagation();
                            c.closeTerminal(t.id);
                          }}
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>

        {/* Ports */}
        <div className={cn("absolute inset-0 overflow-auto", snap.panelTab === "ports" ? "block" : "hidden")}>
          {snap.ports.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              No ports are being forwarded. Run a project to start a server.
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-1.5 text-left font-medium">Port</th>
                  <th className="px-3 py-1.5 text-left font-medium">Process ID</th>
                  <th className="px-3 py-1.5 text-left font-medium">Address</th>
                  <th className="px-3 py-1.5 text-right font-medium" />
                </tr>
              </thead>
              <tbody>
                {snap.ports.map((p) => (
                  <tr key={p.port} className="border-b border-border/50 hover:bg-accent/40">
                    <td className="px-3 py-1.5 font-mono text-foreground">{p.port}</td>
                    <td className="px-3 py-1.5 font-mono text-muted-foreground">{p.pid}</td>
                    <td className="px-3 py-1.5 font-mono text-muted-foreground">localhost:{p.port}</td>
                    <td className="px-3 py-1.5 text-right">
                      <button
                        title="Open in new tab"
                        className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                        onClick={() => window.open(`/preview/${p.port}/`, "_blank")}
                      >
                        <ExternalLink className="size-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}