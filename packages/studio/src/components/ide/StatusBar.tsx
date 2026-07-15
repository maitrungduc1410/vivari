import { useIde } from "./useIde";
import { fmtBytes } from "../../oc/controller";

export function StatusBar() {
  const { c, snap } = useIde();
  const mem = snap.memInfo;
  const memLabel = mem
    ? `mem ${fmtBytes(mem.total ?? -1)}${mem.vfsBytes >= 0 ? ` · vfs ${fmtBytes(mem.vfsBytes)}` : ""}`
    : "measure memory";
  return (
    <div className="flex h-6 shrink-0 items-center gap-4 bg-primary/90 px-3 text-xs text-primary-foreground">
      <span className="truncate">{snap.status}</span>
      <span className="flex-1" />
      <button
        type="button"
        onClick={() => void c.measureMemory()}
        title="Measure this tab's memory (page + workers + VFS) and log a breakdown to the Console"
        className="truncate opacity-90 hover:opacity-100 hover:underline"
      >
        {memLabel}
      </button>
      {snap.cwd && <span className="truncate opacity-90">{snap.cwd}</span>}
      <span className="opacity-90">{snap.booted ? "kernel: ready" : "kernel: booting…"}</span>
    </div>
  );
}
