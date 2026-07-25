import Files from "~icons/lucide/files";
import Search from "~icons/lucide/search";
import Sun from "~icons/lucide/sun";
import Moon from "~icons/lucide/moon";
import Monitor from "~icons/lucide/monitor";
import Check from "~icons/lucide/check";
import { useTheme } from "next-themes";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
      <ActBtn label="Workspace" active={shown("explorer")} onClick={() => select("explorer")}>
        <Files className="size-5" />
      </ActBtn>
      <ActBtn label="Search" active={shown("search")} onClick={() => select("search")}>
        <Search className="size-5" />
      </ActBtn>
      <ThemeToggle />
    </div>
  );
}

const THEME_OPTIONS = [
  { value: "system", label: "Follow system", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
] as const;

function ThemeToggle() {
  const { theme = "system", setTheme, resolvedTheme } = useTheme();
  const CurrentIcon = resolvedTheme === "light" ? Sun : Moon;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              className="mt-auto flex h-12 w-12 items-center justify-center border-l-2 border-transparent text-muted-foreground transition-colors hover:text-foreground data-[popup-open]:text-foreground"
              aria-label="Toggle theme"
            />
          }
        >
          <CurrentIcon className="size-5" />
        </TooltipTrigger>
        <TooltipContent side="right">Theme</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="right" align="end" className="min-w-40">
        {THEME_OPTIONS.map(({ value, label, Icon }) => (
          <DropdownMenuItem key={value} onClick={() => setTheme(value)}>
            <Icon className="size-4" />
            <span className="flex-1">{label}</span>
            {theme === value && <Check className="size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}