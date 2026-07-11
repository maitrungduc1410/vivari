import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { IdeProvider } from "@/components/ide/IdeProvider";
import { AppShell } from "@/components/ide/AppShell";
import { isCrossOriginIsolated } from "@/oc/kernel";

export default function App() {
  if (!isCrossOriginIsolated()) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm">
        <div className="max-w-md space-y-2">
          <h1 className="text-lg font-semibold">Not cross-origin isolated</h1>
          <p className="text-muted-foreground">
            <code>SharedArrayBuffer</code> is unavailable, so the runtime can't start.
            Serve this page with <code>Cross-Origin-Opener-Policy: same-origin</code> and{" "}
            <code>Cross-Origin-Embedder-Policy: require-corp</code>.
          </p>
        </div>
      </div>
    );
  }
  return (
    <TooltipProvider delay={300}>
      <IdeProvider>
        <AppShell />
      </IdeProvider>
      <Toaster />
    </TooltipProvider>
  );
}
