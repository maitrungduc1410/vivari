import { useCallback } from "react";
import { RefreshCw, ExternalLink } from "lucide-react";
import { useIde } from "./useIde";

export function PreviewPanel() {
  const { c, snap } = useIde();
  const setFrame = useCallback((el: HTMLIFrameElement | null) => c.setPreviewFrame(el), [c]);

  const src =
    snap.previewPort != null
      ? `/preview/${snap.previewPort}/${snap.previewNonce > 1 ? `?t=${snap.previewNonce}` : ""}`
      : "about:blank";

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2">
        <div className="flex flex-1 items-center gap-2 truncate rounded bg-background px-2 py-1 text-xs text-muted-foreground">
          {snap.previewPort != null ? `localhost:${snap.previewPort}` : "no server running"}
        </div>
        <button
          title="Reload preview"
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => c.reloadPreview()}
        >
          <RefreshCw className="size-3.5" />
        </button>
        <button
          title="Open in new tab"
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => c.openPreviewTab()}
        >
          <ExternalLink className="size-3.5" />
        </button>
      </div>
      <div className="relative flex-1 bg-white">
        <iframe
          ref={setFrame}
          title="preview"
          src={src}
          className="absolute inset-0 h-full w-full border-0"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
        />
        {snap.previewPort == null && (
          <div className="absolute inset-0 flex items-center justify-center bg-sidebar text-sm text-muted-foreground">
            The preview appears here once a dev server is running.
          </div>
        )}
      </div>
    </div>
  );
}
