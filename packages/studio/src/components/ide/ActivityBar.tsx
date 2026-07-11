import Files from "~icons/lucide/files";
import Search from "~icons/lucide/search";
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
  // Clicking the active view toggles the sidebar (VS Code behaviour); otherwise
  // switch to it.
  const select = (view: "explorer" | "search") => {
    if (snap.activeView === view && !snap.sidebarCollapsed) c.toggleSidebar();
    else c.setActiveView(view);
  };
  const shown = (view: "explorer" | "search") => snap.activeView === view && !snap.sidebarCollapsed;
  return (
    <div className="flex w-12 shrink-0 flex-col items-center border-r bg-sidebar py-1">
      <ActBtn label="Explorer" active={shown("explorer")} onClick={() => select("explorer")}>
        <Files className="size-5" />
      </ActBtn>
      <ActBtn label="Search" active={shown("search")} onClick={() => select("search")}>
        <Search className="size-5" />
      </ActBtn>
    </div>
  );
}
