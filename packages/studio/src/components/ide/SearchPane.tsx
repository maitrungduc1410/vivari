import { useMemo, useState } from "react";
import Search from "~icons/lucide/search";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileIcon } from "./fileIcon";
import { useIde } from "./useIde";

const baseName = (rel: string) => rel.split("/").pop() ?? rel;

// A lightweight filename filter (not full-text search) over the project files.
export function SearchPane() {
  const { c, snap } = useIde();
  const [q, setQ] = useState("");

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [] as string[];
    return snap.files.filter((rel) => rel.toLowerCase().includes(needle)).slice(0, 200);
  }, [q, snap.files]);

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex h-8 shrink-0 items-center px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Search
      </div>
      <div className="px-2 pb-2">
        <div className="flex items-center gap-1.5 rounded border bg-background px-2 py-1">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search files by name"
            className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="pb-4">
          {q.trim() === "" ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">Type to filter files by name.</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">No matching files.</div>
          ) : (
            results.map((rel) => (
              <button
                key={rel}
                onClick={() => c.openFile(rel)}
                className="flex w-full items-center gap-1.5 px-3 py-0.5 text-left text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              >
                <FileIcon name={baseName(rel)} className="size-3.5 shrink-0" />
                <span className="truncate">{baseName(rel)}</span>
                <span className="ml-auto truncate pl-2 text-[10px] text-muted-foreground/70">{rel}</span>
              </button>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
