import ArrowLeft from "~icons/lucide/arrow-left";
import ArrowRight from "~icons/lucide/arrow-right";
import RotateCw from "~icons/lucide/rotate-cw";
import SquareTerminal from "~icons/lucide/square-terminal";
import ExternalLink from "~icons/lucide/external-link";
import Plus from "~icons/lucide/plus";
import Globe from "~icons/lucide/globe";
import Lock from "~icons/lucide/lock";
import X from "~icons/lucide/x";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useIde } from "./useIde";
import type { PreviewTab } from "@/oc/controller";

function ToolButton({
  label, onClick, disabled, children,
}: {
  label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        onClick={onClick}
        disabled={disabled}
        className="flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function tabTitle(t: PreviewTab) {
  return t.port != null ? `Preview (${t.port})` : "New Tab";
}

export function PreviewPanel() {
  const { c, snap } = useIde();
  const tabs = snap.previewTabs;
  const active = tabs.find((t) => t.id === snap.activePreviewId) ?? null;

  return (
    <div className="flex h-full flex-col bg-sidebar">
      {/* tab strip */}
      <div className="flex h-8 shrink-0 items-stretch border-b bg-[#181818]">
        <div className="flex flex-1 items-stretch overflow-x-auto">
          {tabs.map((t) => {
            const isActive = t.id === snap.activePreviewId;
            return (
              <ContextMenu key={t.id}>
                <ContextMenuTrigger className="contents">
                  <div
                    title={tabTitle(t)}
                    onClick={() => c.activatePreviewTab(t.id)}
                    className={cn(
                      "group flex cursor-pointer items-center gap-1.5 border-r px-3 text-xs",
                      isActive ? "bg-sidebar text-foreground" : "bg-[#181818] text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Globe className="size-3.5 shrink-0 opacity-70" />
                    <span className="max-w-32 truncate">{tabTitle(t)}</span>
                    <button
                      title="Close"
                      className="flex size-4 items-center justify-center rounded hover:bg-accent"
                      onClick={(e) => { e.stopPropagation(); c.closePreviewTab(t.id); }}
                    >
                      <X className={cn("size-3", isActive ? "block" : "hidden group-hover:block")} />
                    </button>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-48">
                  <ContextMenuItem onClick={() => c.closePreviewTab(t.id)}>Close</ContextMenuItem>
                  <ContextMenuItem disabled={tabs.length <= 1} onClick={() => c.closeOtherPreviewTabs(t.id)}>
                    Close Others
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={tabs.findIndex((x) => x.id === t.id) >= tabs.length - 1}
                    onClick={() => c.closePreviewTabsToRight(t.id)}
                  >
                    Close to the Right
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => c.closeAllPreviewTabs()}>Close All</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
        <Tooltip>
          <TooltipTrigger
            onClick={() => c.addPreviewTab()}
            className="flex w-8 shrink-0 items-center justify-center border-l text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Plus className="size-4" />
          </TooltipTrigger>
          <TooltipContent>New browser tab</TooltipContent>
        </Tooltip>
      </div>

      {/* address / nav toolbar (only with an active tab) */}
      {active && (
        <div className="flex h-9 shrink-0 items-center gap-0.5 border-b px-1.5">
          <ToolButton label="Back" onClick={() => c.previewBack(active.id)}>
            <ArrowLeft className="size-4" />
          </ToolButton>
          <ToolButton label="Forward" onClick={() => c.previewForward(active.id)}>
            <ArrowRight className="size-4" />
          </ToolButton>
          <ToolButton label="Reload" onClick={() => c.reloadPreviewTab(active.id)}>
            <RotateCw className="size-4" />
          </ToolButton>
          {/* Address bar — local-only: localhost / 127.0.0.1 / a bare path loads the
              in-VM dev server; external URLs are rejected (see navigatePreview). */}
          <div className="mx-1 flex flex-1 items-center gap-1.5 rounded bg-background px-2 py-1">
            <Lock className="size-3 shrink-0 text-muted-foreground" />
            <input
              value={active.url}
              onChange={(e) => c.setPreviewUrl(active.id, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") c.navigatePreview(active.id, (e.target as HTMLInputElement).value);
              }}
              placeholder="localhost:3000"
              spellCheck={false}
              className="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <ToolButton
            label={snap.devtoolsOpen ? "Close devtools" : "Open devtools"}
            onClick={() => c.toggleDevtools()}
          >
            <SquareTerminal className={cn("size-4", snap.devtoolsOpen && "text-foreground")} />
          </ToolButton>
          <ToolButton label="Open in new tab" disabled={active.port == null} onClick={() => c.openPreviewExternal(active.id)}>
            <ExternalLink className="size-4" />
          </ToolButton>
        </div>
      )}

      {/* body — a vertical split: the preview iframes on top, the DevTools frontend
          below when open. All preview iframes stay mounted so each tab keeps its
          state + HMR socket; the DevTools iframe remounts (key) on re-attach. */}
      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel id="preview-body" className="relative overflow-hidden bg-white">
          {tabs.map((t) => (
            <iframe
              key={t.id}
              ref={(el) => c.setPreviewFrame(t.id, el)}
              title={tabTitle(t)}
              src={c.previewSrc(t)}
              className={cn(
                "absolute inset-0 h-full w-full border-0",
                t.id === snap.activePreviewId ? "block" : "hidden",
              )}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            />
          ))}
          {active && active.port == null && (
            <div className="absolute inset-0 flex items-center justify-center bg-sidebar text-sm text-muted-foreground">
              Empty tab — type a local address like localhost:3000 and press Enter.
            </div>
          )}
          {tabs.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-sidebar text-sm text-muted-foreground">
              <span>No preview open.</span>
              <button
                onClick={() => c.addPreviewTab()}
                className="flex items-center gap-1.5 rounded border px-2 py-1 text-xs hover:bg-accent hover:text-foreground"
              >
                <Plus className="size-3.5" /> New browser tab
              </button>
            </div>
          )}
        </ResizablePanel>
        {snap.devtoolsOpen && (
          <>
            <ResizableHandle />
            <ResizablePanel id="preview-devtools" defaultSize="45%" minSize="15%" className="bg-[#292a2d]">
              <iframe
                key={snap.devtoolsNonce}
                ref={(el) => c.setDevtoolsFrame(el)}
                onLoad={() => c.onDevtoolsReady()}
                title="DevTools"
                src={c.devtoolsSrc()}
                className="h-full w-full border-0"
              />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
}
