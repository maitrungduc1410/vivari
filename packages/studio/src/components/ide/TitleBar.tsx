import Home from "~icons/lucide/house";
import Plus from "~icons/lucide/plus";
import { Button } from "@/components/ui/button";
import { useIde } from "./useIde";

export function TitleBar() {
  const { c, snap } = useIde();
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b bg-sidebar px-3 text-sm">
      <button
        className="flex items-center gap-2 font-semibold"
        onClick={() => c.goHome()}
        title="Home"
      >
        <span className="inline-block size-2.5 rounded-full bg-primary" />
        OpenContainer Studio
      </button>

      <div className="flex-1 truncate text-center text-xs text-muted-foreground">
        {snap.projectTitle ? snap.projectTitle : "a real dev server, in your browser"}
      </div>

      <Button variant="ghost" size="sm" onClick={() => c.goHome()}>
        <Home className="size-4" /> Home
      </Button>
      <Button variant="ghost" size="sm" onClick={() => c.goHome()} title="New project">
        <Plus className="size-4" /> New
      </Button>
    </div>
  );
}
