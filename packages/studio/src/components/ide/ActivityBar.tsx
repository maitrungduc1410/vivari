import { useSyncExternalStore } from "react";
import Files from "~icons/lucide/files";
import Search from "~icons/lucide/search";
import Bug from "~icons/lucide/bug";
import GitBranch from "~icons/lucide/git-branch";
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
        // A tooltip is not an accessible name: without this the activity bar is four
        // buttons that announce as "button".
        aria-label={label}
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

type View = "explorer" | "search" | "debug" | "scm";

export function ActivityBar() {
  const { c, snap } = useIde();
  // The Source Control changed-file count badge, driven by the SCM session store.
  const scm = useSyncExternalStore(c.scm.subscribe, c.scm.getSnapshot);
  const scmCount = scm.repos.reduce((n, r) => n + r.staged.length + r.changes.length, 0);
  // Clicking the active view toggles the sidebar (VS Code behaviour); otherwise
  // switch to it.
  const select = (view: View) => {
    if (snap.activeView === view && !snap.sidebarCollapsed) c.toggleSidebar();
    else c.setActiveView(view);
  };
  const shown = (view: View) => snap.activeView === view && !snap.sidebarCollapsed;
  return (
    <div className="flex w-12 shrink-0 flex-col items-center border-r bg-sidebar py-1">
      <ActBtn label="Workspace" active={shown("explorer")} onClick={() => select("explorer")}>
        <Files className="size-5" />
      </ActBtn>
      <ActBtn label="Search" active={shown("search")} onClick={() => select("search")}>
        <Search className="size-5" />
      </ActBtn>
      <ActBtn label="Source Control" active={shown("scm")} onClick={() => select("scm")}>
        <span className="relative">
          <GitBranch className="size-5" />
          {scmCount > 0 && (
            <span className="absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none text-primary-foreground">
              {scmCount > 99 ? "99+" : scmCount}
            </span>
          )}
        </span>
      </ActBtn>
      <ActBtn label="Run and Debug" active={shown("debug")} onClick={() => select("debug")}>
        <Bug className="size-5" />
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