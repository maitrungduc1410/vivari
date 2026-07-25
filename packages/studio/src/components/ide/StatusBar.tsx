import CircleX from "~icons/lucide/circle-x";
import TriangleAlert from "~icons/lucide/triangle-alert";
import { useIde } from "./useIde";

export function StatusBar() {
  const { snap } = useIde();
  const { errors, warnings } = snap.problems;
  return (
    <div className="flex h-6 shrink-0 items-center gap-4 bg-[#007acc] px-3 text-xs text-white">
      {/* Live TS/JS diagnostics from the language-service worker. */}
      <span
        className="flex items-center gap-2 opacity-90"
        title={`${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`}
      >
        <span className="flex items-center gap-1">
          <CircleX className="size-3.5" />
          {errors}
        </span>
        <span className="flex items-center gap-1">
          <TriangleAlert className="size-3.5" />
          {warnings}
        </span>
      </span>
      <span className="truncate">{snap.status}</span>
      <span className="flex-1" />
      {snap.cwd && <span className="truncate opacity-90">{snap.cwd}</span>}
      <span className="opacity-90">{snap.booted ? "kernel: ready" : "kernel: booting…"}</span>
    </div>
  );
}