import { Files, TerminalIcon, Play, Search } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useIde } from "./useIde";

function ActBtn({
  label, active, onClick, children,
}: {
  label: string; active?: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        onClick={onClick}
        className={cn(
          "flex h-12 w-12 items-center justify-center border-l-2 border-transparent text-muted-foreground transition-colors hover:text-foreground",
          active && "border-l-primary text-foreground",
        )}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

export function ActivityBar() {
  const { c, snap } = useIde();
  return (
    <div className="flex w-12 shrink-0 flex-col items-center border-r bg-sidebar py-1">
      <ActBtn label="Explorer" active={!snap.sidebarCollapsed} onClick={() => c.toggleSidebar()}>
        <Files className="size-5" />
      </ActBtn>
      <ActBtn label="Run project" onClick={() => c.runDemo()}>
        <Play className="size-5" />
      </ActBtn>
      <ActBtn label="Quick open (⌘P)" onClick={() => c.openPalette("file")}>
        <Search className="size-5" />
      </ActBtn>
      <ActBtn label="Terminal (⌃`)" active={!snap.panelCollapsed} onClick={() => c.togglePanel()}>
        <TerminalIcon className="size-5" />
      </ActBtn>
    </div>
  );
}
