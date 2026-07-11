import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileCode } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useIde } from "./useIde";

interface DirNode {
  dirs: Map<string, DirNode>;
  files: { name: string; rel: string }[];
}

function buildTree(paths: string[]): DirNode {
  const root: DirNode = { dirs: new Map(), files: [] };
  for (const rel of paths) {
    const parts = rel.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        node.files.push({ name: part, rel });
      } else {
        let child = node.dirs.get(part);
        if (!child) node.dirs.set(part, (child = { dirs: new Map(), files: [] }));
        node = child;
      }
    }
  }
  return root;
}

function TreeLevel({
  node, prefix, depth, activeTab, onOpen, expanded, toggle,
}: {
  node: DirNode;
  prefix: string;
  depth: number;
  activeTab: string | null;
  onOpen: (rel: string) => void;
  expanded: Set<string>;
  toggle: (path: string) => void;
}) {
  const dirs = [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      {dirs.map(([name, child]) => {
        const path = prefix + name;
        const open = expanded.has(path);
        return (
          <div key={path}>
            <button
              className="flex w-full items-center gap-1 py-0.5 text-left text-sm text-muted-foreground hover:text-foreground"
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => toggle(path)}
            >
              {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
              <span className="truncate">{name}</span>
            </button>
            {open && (
              <TreeLevel
                node={child}
                prefix={path + "/"}
                depth={depth + 1}
                activeTab={activeTab}
                onOpen={onOpen}
                expanded={expanded}
                toggle={toggle}
              />
            )}
          </div>
        );
      })}
      {files.map((f) => (
        <button
          key={f.rel}
          className={cn(
            "flex w-full items-center gap-1.5 py-0.5 text-left text-sm hover:bg-accent/50",
            activeTab === f.rel ? "bg-accent text-foreground" : "text-muted-foreground",
          )}
          style={{ paddingLeft: 8 + depth * 12 + 16 }}
          onClick={() => onOpen(f.rel)}
        >
          <FileCode className="size-3.5 shrink-0 opacity-70" />
          <span className="truncate">{f.name}</span>
        </button>
      ))}
    </>
  );
}

export function Explorer() {
  const { c, snap } = useIde();
  const tree = useMemo(() => buildTree(snap.files), [snap.files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Directories are open by default; `collapsed` tracks the ones the user closed.
  const allDirs = useMemo(() => {
    const acc = new Set<string>();
    const walk = (n: DirNode, prefix: string) => {
      for (const [name, child] of n.dirs) {
        acc.add(prefix + name);
        walk(child, prefix + name + "/");
      }
    };
    walk(tree, "");
    return acc;
  }, [tree]);
  const expanded = useMemo(() => {
    const s = new Set(allDirs);
    for (const c of collapsed) s.delete(c);
    return s;
  }, [allDirs, collapsed]);

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex h-8 shrink-0 items-center px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Explorer
      </div>
      <ScrollArea className="flex-1">
        <div className="pb-4">
          {snap.files.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              Press <span className="text-foreground">Run</span> to scaffold a project.
            </div>
          ) : (
            <TreeLevel
              node={tree}
              prefix=""
              depth={0}
              activeTab={snap.activeTab}
              onOpen={(rel) => c.openFile(rel)}
              expanded={expanded}
              toggle={toggle}
            />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
