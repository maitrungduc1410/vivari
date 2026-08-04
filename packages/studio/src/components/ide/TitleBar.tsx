import Home from "~icons/lucide/house";
import PanelLeft from "~icons/lucide/panel-left";
import PanelLeftOff from "~icons/lucide/panel-left-dashed";
import PanelBottom from "~icons/lucide/panel-bottom";
import PanelBottomOff from "~icons/lucide/panel-bottom-dashed";
import PanelRight from "~icons/lucide/panel-right";
import PanelRightOff from "~icons/lucide/panel-right-dashed";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useIde } from "./useIde";

/** One layout toggle, in the cluster at the far right. lucide ships a solid-divider
 * and a dashed-divider glyph per edge (the dashed one is aliased `-inactive` in the
 * pack), so the icon itself says whether that panel is showing — VS Code reads its
 * layout the same way, by drawing the sub-panel region differently. The dimmed
 * foreground when hidden is the second, coarser channel: at 16px a dashed rule is
 * easy to miss on its own. */
function LayoutToggle({
  label, keys, shown, onClick, On, Off,
}: {
  label: string;
  keys: string;
  shown: boolean;
  onClick: () => void;
  On: React.ComponentType<{ className?: string }>;
  Off: React.ComponentType<{ className?: string }>;
}) {
  const Icon = shown ? On : Off;
  return (
    <Tooltip>
      <TooltipTrigger
        onClick={onClick}
        aria-pressed={shown}
        aria-label={label}
        className={cn(
          "flex size-7 items-center justify-center rounded transition-colors hover:bg-accent",
          shown ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Icon className="size-4" />
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label}
        <span className="text-background/60">{keys}</span>
      </TooltipContent>
    </Tooltip>
  );
}

export function TitleBar() {
  const { c, snap } = useIde();
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b bg-sidebar pr-2 pl-3 text-sm">
      <button
        className="flex shrink-0 items-center gap-2 font-semibold"
        onClick={() => c.goHome()}
        title="Home"
      >
        <span className="inline-block size-2.5 rounded-full bg-primary" />
        Vivari Studio
      </button>

      <div className="flex-1 truncate text-center text-xs text-muted-foreground">
        {snap.projectTitle ? snap.projectTitle : "a real dev server, in your browser"}
      </div>

      {/* App actions, then the layout cluster hugging the corner — VS Code keeps its
          layout controls at the far edge, apart from whatever sits beside them. */}
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" onClick={() => c.goHome()}>
          <Home className="size-4" /> Home
        </Button>
        <div aria-hidden className="mx-1 h-5 w-px bg-border" />
        <LayoutToggle
          label="Toggle Sidebar" keys="⌘B"
          shown={!snap.sidebarCollapsed} onClick={() => c.toggleSidebar()}
          On={PanelLeft} Off={PanelLeftOff}
        />
        <LayoutToggle
          label="Toggle Panel" keys="⌘J"
          shown={!snap.panelCollapsed} onClick={() => c.togglePanel()}
          On={PanelBottom} Off={PanelBottomOff}
        />
        <LayoutToggle
          label="Toggle Preview" keys="⌥⌘B"
          shown={!snap.previewCollapsed} onClick={() => c.togglePreview()}
          On={PanelRight} Off={PanelRightOff}
        />
      </div>
    </div>
  );
}