import { useEffect, useState } from "react";
import FilePlus from "~icons/lucide/file-plus-2";
import LayoutTemplate from "~icons/lucide/layout-template";
import Clock from "~icons/lucide/clock";
import ArrowLeft from "~icons/lucide/arrow-left";
import Trash from "~icons/lucide/trash-2";
import FolderInput from "~icons/lucide/folder-input";
import Github from "~icons/lucide/github";
import Loader from "~icons/lucide/loader-circle";
import RotateCcw from "~icons/lucide/rotate-ccw";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TEMPLATES, TEMPLATE_CATEGORIES, type TemplateCategory, type TemplateDef } from "@/vv/templates";
import { TemplateIcon } from "./templateIcons";
import { useIde } from "./useIde";
import { entriesFromDataTransfer, type ProjectMeta } from "@/vv/controller";

function relTime(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function HomeView() {
  const { c, snap } = useIde();
  const [blankOpen, setBlankOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [dragging, setDragging] = useState(false);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const entries = entriesFromDataTransfer(e.dataTransfer);
    if (entries.length) void c.importDropAsProject(entries);
  };

  return (
    <div
      className="absolute inset-0 z-40 overflow-auto bg-background"
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-50 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/60 bg-primary/5 text-sm font-medium text-primary">
          <FolderInput className="size-8" />
          Drop a folder to import it as a new project
        </div>
      )}
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-6 py-10">
        <div className="mb-8 flex items-center gap-3">
          <span className="inline-block size-3 rounded-full bg-primary" />
          <h1 className="text-lg font-semibold">Vivari Studio</h1>
          {snap.workspaceFolders.length > 0 && (
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => c.showWorkspace()}>
              <ArrowLeft className="size-4" /> Back to workspace
            </Button>
          )}
        </div>

        {/* Boot banner: kept mounted and collapsed smoothly (height + opacity)
            once the kernel is ready, so the action grid glides into place instead
            of jumping when it disappears. */}
        <div
          className={cn(
            "grid transition-all duration-500 ease-out",
            snap.kernelReady ? "mb-0 grid-rows-[0fr] opacity-0" : "mb-6 grid-rows-[1fr] opacity-100",
          )}
        >
          <div className="overflow-hidden">
            <BootStatus />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <button
            onClick={() => setBlankOpen(true)}
            className="group flex flex-col items-start gap-3 rounded-xl border bg-card p-5 text-left transition-colors hover:border-primary/60 hover:bg-accent/40"
          >
            <div className="flex size-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FilePlus className="size-6" />
            </div>
            <div>
              <div className="font-medium">Start from blank</div>
              <div className="text-sm text-muted-foreground">An empty project with a package.json.</div>
            </div>
          </button>
          <button
            onClick={() => setTemplateOpen(true)}
            className="group flex flex-col items-start gap-3 rounded-xl border bg-card p-5 text-left transition-colors hover:border-primary/60 hover:bg-accent/40"
          >
            <div className="flex size-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <LayoutTemplate className="size-6" />
            </div>
            <div>
              <div className="font-medium">Start from template</div>
              <div className="text-sm text-muted-foreground">React, Vue, Next.js, Express, Three.js, WebSocket…</div>
            </div>
          </button>
          <ImportCard
            icon={FolderInput}
            title="Import a folder"
            desc="Open a local folder — or drop one here — as a new project."
            onClick={() => c.importFolderViaPicker()}
            disabled={!snap.kernelReady}
          />
          <ImportCard
            icon={Github}
            title="Import from GitHub or npm"
            desc="Fetch a public repo or an npm package as a new project."
            onClick={() => c.openImportRemote()}
            disabled={!snap.kernelReady}
          />
        </div>

        <div className="mt-10">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Clock className="size-3.5" /> Recent projects
            </div>
            <button
              onClick={() => setResetOpen(true)}
              className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-destructive"
            >
              <RotateCcw className="size-3.5" /> Reset everything
            </button>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            Your files and installed dependencies are saved in this browser across reloads.
          </p>
          {snap.recentProjects.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No projects yet. Create one above to get started.
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {snap.recentProjects.map((p) => (
                <RecentRow key={p.rootPath} project={p} />
              ))}
            </ul>
          )}
        </div>
      </div>

      <NewBlankDialog open={blankOpen} onOpenChange={setBlankOpen} />
      <NewTemplateDialog open={templateOpen} onOpenChange={setTemplateOpen} />
      <ResetEverythingDialog open={resetOpen} onOpenChange={setResetOpen} />
    </div>
  );
}

// An action card whose click is gated on the kernel being ready. While disabled
// it stays hoverable (aria-disabled rather than the native `disabled` attribute,
// which would swallow hover events) so a tooltip can explain WHY it's disabled —
// the project is still being restored. The tooltip is only rendered while disabled.
function ImportCard({
  icon: Icon,
  title,
  desc,
  onClick,
  disabled,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  desc: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            onClick={() => {
              if (!disabled) onClick();
            }}
            aria-disabled={disabled}
            className={cn(
              "group flex flex-col items-start gap-3 rounded-xl border bg-card p-5 text-left transition-colors",
              disabled ? "cursor-not-allowed opacity-60" : "hover:border-primary/60 hover:bg-accent/40",
            )}
          />
        }
      >
        <div className="flex size-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-6" />
        </div>
        <div>
          <div className="font-medium">{title}</div>
          <div className="text-sm text-muted-foreground">{desc}</div>
        </div>
      </TooltipTrigger>
      {disabled && (
        <TooltipContent>Available once your saved project finishes restoring.</TooltipContent>
      )}
    </Tooltip>
  );
}

// Cold-boot progress shown on Home until the kernel + VFS are ready. Restoring a
// large saved project from OPFS can take many seconds; this replaces the silent
// disabled-buttons state with a labeled, (for the restore phase) determinate bar.
function bootPhaseLabel(phase: string): string {
  switch (phase) {
    case "restore":
      return "Restoring your saved project";
    case "finalize":
      return "Finalizing runtime";
    default:
      return "Starting runtime";
  }
}

function BootStatus() {
  const { snap } = useIde();
  const determinate = snap.bootPhase === "restore" && snap.bootTotal > 0;
  const pct = determinate
    ? Math.min(100, Math.round((snap.bootDone / snap.bootTotal) * 100))
    : 0;
  return (
    <div className="mb-6 rounded-xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <Loader className="mt-0.5 size-5 shrink-0 animate-spin text-primary" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">{bootPhaseLabel(snap.bootPhase)}…</span>
            {determinate && (
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {snap.bootDone.toLocaleString()} / {snap.bootTotal.toLocaleString()} ({pct}%)
              </span>
            )}
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-accent">
            {determinate ? (
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-200"
                style={{ width: `${pct}%` }}
              />
            ) : (
              <div className="h-full w-1/3 animate-pulse rounded-full bg-primary/70" />
            )}
          </div>
          <div className="mt-1.5 text-xs text-muted-foreground">
            Setting up the in-browser runtime — import and project actions unlock in a moment.
          </div>
        </div>
      </div>
    </div>
  );
}

function ResetEverythingDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { c } = useIde();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setBusy(false);
  }, [open]);

  const confirmReset = async () => {
    setBusy(true);
    // resetEverything() tears down the worker, wipes OPFS, and reloads the page,
    // so control does not return here on success.
    await c.resetEverything();
  };

  return (
    // While the reset is running, lock the dialog: ignore open-state changes and
    // disable backdrop/Escape dismissal + the X so the destructive op can't be
    // interrupted mid-flight (the page reloads on success).
    <Dialog
      open={open}
      onOpenChange={(o) => { if (!busy) onOpenChange(o); }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Reset everything?</DialogTitle>
          <DialogDescription>
            This permanently deletes all saved files and cached dependencies from this browser,
            then reloads Studio with a clean slate. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void confirmReset()} disabled={busy}>
            {busy ? "Resetting…" : "Reset everything"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RecentRow({ project }: { project: ProjectMeta }) {
  const { c } = useIde();
  return (
    <li className="group flex items-center gap-3 rounded-lg border bg-card px-3 py-2 transition-colors hover:border-primary/50 hover:bg-accent/30">
      <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => void c.openProject(project)}>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{project.name}</div>
          <div className="truncate text-xs text-muted-foreground">{project.rootPath}</div>
        </div>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {project.template ? project.template : "blank"} · {relTime(project.lastModified)}
        </span>
      </button>
      <button
        title="Remove from list"
        className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100"
        onClick={() => c.removeProjectMeta(project.rootPath)}
      >
        <Trash className="size-3.5" />
      </button>
    </li>
  );
}

// Shared directory field with live validation against the VFS + registry.
function useDirValidation(dir: string, enabled: boolean) {
  const { c } = useIde();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || !dir.trim()) { setError(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const err = await c.validateNewDir(dir);
      if (!cancelled) setError(err);
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [dir, enabled, c]);
  return error;
}

function NewBlankDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { c, snap } = useIde();
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [dirTouched, setDirTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) { setName(""); setDir(""); setDirTouched(false); setBusy(false); }
  }, [open]);

  const effectiveDir = dirTouched ? dir : name.trim() ? c.defaultDirFor(name) : "";
  const dirError = useDirValidation(effectiveDir, open && !!name.trim() && snap.kernelReady);
  const canCreate = !!name.trim() && !!effectiveDir && !dirError && !busy && snap.kernelReady;

  const submit = async () => {
    if (!canCreate) return;
    setBusy(true);
    await c.createBlankProject({ name: name.trim(), dir: effectiveDir });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New blank project</DialogTitle>
          <DialogDescription>An empty project you can build up from scratch.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Project name</span>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="my-app"
              onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Directory</span>
            <Input
              value={effectiveDir}
              onChange={(e) => { setDirTouched(true); setDir(e.target.value); }}
              placeholder="/home/user/projects/my-app"
              aria-invalid={!!dirError}
              onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
            />
            {dirError && <span className="text-xs text-destructive">{dirError}</span>}
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={!canCreate}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Categories that actually have at least one template, in canonical tab order.
const ACTIVE_CATEGORIES = TEMPLATE_CATEGORIES.filter((cat) =>
  TEMPLATES.some((t) => t.manifest.category === cat),
);

function NewTemplateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { c, snap } = useIde();
  const [selected, setSelected] = useState<TemplateDef | null>(null);
  const [activeCat, setActiveCat] = useState<TemplateCategory>(ACTIVE_CATEGORIES[0]);
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [dirTouched, setDirTouched] = useState(false);
  const [runInit, setRunInit] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setSelected(null); setActiveCat(ACTIVE_CATEGORIES[0]);
      setName(""); setDir(""); setDirTouched(false); setRunInit(true); setBusy(false);
    }
  }, [open]);

  const pick = (t: TemplateDef) => {
    setSelected(t);
    const suggested = `${t.manifest.framework}-${t.manifest.language === "TypeScript" ? "ts" : "js"}-app`;
    setName(suggested);
    setDirTouched(false);
  };

  const effectiveDir = dirTouched ? dir : name.trim() ? c.defaultDirFor(name) : "";
  const dirError = useDirValidation(effectiveDir, open && !!selected && !!name.trim() && snap.kernelReady);
  const canCreate = !!selected && !!name.trim() && !!effectiveDir && !dirError && !busy && snap.kernelReady;

  const submit = async () => {
    if (!canCreate || !selected) return;
    setBusy(true);
    await c.createFromTemplate({
      templateId: selected.manifest.id,
      name: name.trim(),
      dir: effectiveDir,
      runInit,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Start from a template</DialogTitle>
          <DialogDescription>Pick a template — we'll scaffold it and (optionally) install + run it.</DialogDescription>
        </DialogHeader>

        <Tabs
          value={activeCat}
          onValueChange={(v) => setActiveCat(v as TemplateCategory)}
          className="border-b pb-2"
        >
          <TabsList variant="line" className="flex-wrap">
            {ACTIVE_CATEGORIES.map((cat) => (
              <TabsTrigger key={cat} value={cat}>
                {cat}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="grid max-h-64 grid-cols-2 gap-1.5 overflow-auto sm:grid-cols-3">
          {TEMPLATES.filter((t) => t.manifest.category === activeCat).map((t) => {
            const isSel = selected?.manifest.id === t.manifest.id;
            return (
              <button
                key={t.manifest.id}
                onClick={() => pick(t)}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg border p-2.5 text-left transition-colors hover:bg-accent/40",
                  isSel ? "border-primary bg-accent/50" : "border-transparent",
                )}
              >
                <TemplateIcon icon={t.manifest.icon} className="size-7 shrink-0" />
                <div className="min-w-0">
                  <div className="flex items-center gap-1">
                    <span className="truncate text-sm font-medium">{t.manifest.name}</span>
                    {t.manifest.experimental && (
                      <span className="shrink-0 rounded bg-yellow-500/15 px-1 text-[9px] font-medium text-yellow-600 dark:text-yellow-400">
                        exp
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{t.manifest.language}</div>
                </div>
              </button>
            );
          })}
        </div>

        {selected && (
          <div className="flex flex-col gap-3 border-t pt-3">
            <div className="flex items-center gap-2 text-sm">
              <TemplateIcon icon={selected.manifest.icon} className="size-5" />
              <span className="font-medium">{selected.manifest.name}</span>
              <span className="text-muted-foreground">· {selected.manifest.language}</span>
              {selected.manifest.experimental && (
                <span className="rounded bg-yellow-500/15 px-1.5 py-0.5 text-[10px] font-medium text-yellow-600 dark:text-yellow-400">experimental</span>
              )}
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Project name</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-app"
                onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Directory</span>
              <Input
                value={effectiveDir}
                onChange={(e) => { setDirTouched(true); setDir(e.target.value); }}
                aria-invalid={!!dirError}
                onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
              />
              {dirError && <span className="text-xs text-destructive">{dirError}</span>}
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={runInit}
                onChange={(e) => setRunInit(e.target.checked)}
                className="size-4 accent-primary"
              />
              <span>
                Run init script{" "}
                <span className="text-muted-foreground">
                  (<code>{selected.manifest.install}</code> then <code>{selected.manifest.dev}</code>)
                </span>
              </span>
            </label>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={!canCreate}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}