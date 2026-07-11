import { useIde } from "./useIde";

export function StatusBar() {
  const { snap } = useIde();
  return (
    <div className="flex h-6 shrink-0 items-center gap-4 bg-primary/90 px-3 text-xs text-primary-foreground">
      <span className="truncate">{snap.status}</span>
      <span className="flex-1" />
      {snap.cwd && <span className="truncate opacity-90">{snap.cwd}</span>}
      <span className="opacity-90">{snap.booted ? "kernel: ready" : "kernel: booting…"}</span>
    </div>
  );
}
