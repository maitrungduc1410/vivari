import Play from "~icons/lucide/play";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { DEMOS } from "@/oc/controller";
import { useIde } from "./useIde";

export function TitleBar() {
  const { c, snap } = useIde();
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b bg-sidebar px-3 text-sm">
      <div className="flex items-center gap-2 font-semibold">
        <span className="inline-block size-2.5 rounded-full bg-primary" />
        OpenContainer Studio
      </div>

      <div className="flex-1 truncate text-center text-xs text-muted-foreground">
        {snap.projectTitle ? `${snap.projectTitle} — running in this tab` : "a real dev server, in your browser"}
      </div>

      <Select
        value={snap.selectedDemo}
        onValueChange={(v) => {
          if (typeof v === "string") c.setSelectedDemo(v);
        }}
      >
        <SelectTrigger size="sm" className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DEMOS.map((d) => (
            <SelectItem key={d.id} value={d.id}>
              {d.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button size="sm" onClick={() => c.runDemo()} disabled={!snap.booted}>
        <Play className="size-4" /> Run
      </Button>
    </div>
  );
}
