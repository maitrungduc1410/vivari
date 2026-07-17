import { useEffect, useState } from "react";
import Github from "~icons/lucide/github";
import Package from "~icons/lucide/package";
import Loader from "~icons/lucide/loader-circle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIde } from "./useIde";

type Source = "github" | "npm";

// Import a project from a public GitHub repo or an npm package. Snapshot-driven
// (c.openImportRemote / c.closeImportRemote) so it works from Home and the
// command palette alike.
export function ImportRemoteDialog() {
  const { c, snap } = useIde();
  const open = snap.importRemoteOpen;
  const [tab, setTab] = useState<Source>("github");
  const [gh, setGh] = useState("");
  const [npm, setNpm] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");

  useEffect(() => {
    if (open) { setBusy(false); setProgress(""); }
  }, [open]);

  const value = tab === "github" ? gh : npm;
  const canSubmit = !!value.trim() && !busy && snap.kernelReady;

  const onProgress = (done: number, total: number, phase: string) => {
    setProgress(total > 0 ? `${phase} (${done}/${total})` : phase);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setProgress("Starting…");
    try {
      const ok = tab === "github"
        ? await c.importGithubRepo(gh.trim(), onProgress)
        : await c.importNpmPackage(npm.trim(), onProgress);
      if (ok) c.closeImportRemote();
    } catch (err) {
      setProgress(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) c.closeImportRemote(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import from GitHub or npm</DialogTitle>
          <DialogDescription>
            Fetch a public repo or an npm package as a new project. Downloaded in your
            browser — no server involved.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as Source)}>
          <TabsList variant="line">
            <TabsTrigger value="github"><Github className="size-4" /> GitHub</TabsTrigger>
            <TabsTrigger value="npm"><Package className="size-4" /> npm</TabsTrigger>
          </TabsList>

          <TabsContent value="github" className="mt-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Repository</span>
              <Input
                autoFocus
                value={gh}
                onChange={(e) => setGh(e.target.value)}
                placeholder="owner/repo, owner/repo@branch, or a github.com URL"
                disabled={busy}
                onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
              />
              <span className="text-xs text-muted-foreground">Public repositories only. Default branch unless a ref is given.</span>
            </label>
          </TabsContent>

          <TabsContent value="npm" className="mt-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Package</span>
              <Input
                autoFocus
                value={npm}
                onChange={(e) => setNpm(e.target.value)}
                placeholder="left-pad, react@18, or @scope/pkg@1.2.3"
                disabled={busy}
                onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
              />
              <span className="text-xs text-muted-foreground">Unpacks the published tarball (the package contents, not its deps).</span>
            </label>
          </TabsContent>
        </Tabs>

        {progress && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {busy && <Loader className="size-3.5 animate-spin" />}
            <span className="truncate">{progress}</span>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => c.closeImportRemote()} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {busy && <Loader className="size-4 animate-spin" />} Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
