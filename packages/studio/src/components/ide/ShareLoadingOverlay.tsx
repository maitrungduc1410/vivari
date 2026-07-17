import Loader from "~icons/lucide/loader-circle";
import { useIde } from "./useIde";

// Full-screen blocking overlay shown while a #share= link bootstraps into a new
// project. Rendered over the (kept-mounted) workspace — not Home — so the user
// gets a clear, prominent signal and can't click into the IDE mid-bootstrap.
export function ShareLoadingOverlay() {
  const { snap } = useIde();
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4 rounded-xl border bg-card px-12 py-10 shadow-lg">
        <Loader className="size-10 animate-spin text-primary" />
        <div className="text-center">
          <div className="text-base font-medium">Opening shared project…</div>
          <div className="mt-1 text-sm text-muted-foreground">{snap.shareMessage}</div>
        </div>
      </div>
    </div>
  );
}
