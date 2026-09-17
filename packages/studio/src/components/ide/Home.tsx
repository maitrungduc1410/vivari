import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import FilePlus from "~icons/lucide/file-plus-2";
import LayoutTemplate from "~icons/lucide/layout-template";
import Clock from "~icons/lucide/clock";
import ArrowLeft from "~icons/lucide/arrow-left";
import Trash from "~icons/lucide/trash-2";
import FolderInput from "~icons/lucide/folder-input";
import Github from "~icons/lucide/github";
import Loader from "~icons/lucide/loader-circle";
import RotateCcw from "~icons/lucide/rotate-ccw";
import TriangleAlert from "~icons/lucide/triangle-alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { TemplateCategory, TemplateDef } from "@/vv/templates";
import { loadTemplates, prefetchTemplates } from "@/vv/templates-lazy";
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
            // The catalog is its own chunk now, so start it on the first sign of
            // intent — a pointer arriving here is ~200ms of head start, which is
            // about what the chunk costs.
            onPointerEnter={prefetchTemplates}
            onFocus={prefetchTemplates}
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
  // A runtime that is never coming up must not keep animating a progress bar:
  // the two states were indistinguishable, so a dead kernel worker read as a slow
  // one for as long as the user was willing to wait.
  if (snap.bootError) {
    return (
      <div className="mb-6 rounded-xl border border-destructive/40 bg-destructive/5 p-4">
        <div className="flex items-start gap-3">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="text-sm font-medium">The runtime failed to start</div>
            <div className="break-words text-xs text-muted-foreground">{snap.bootError}</div>
            <div className="text-xs text-muted-foreground">
              Reloading the page usually clears it. If it keeps happening, the browser console
              has the underlying error.
            </div>
          </div>
          <Button size="sm" variant="outline" className="shrink-0" onClick={() => location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    );
  }
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

/**
 * Far above any legitimate create, so that reaching it means the runtime is
 * wedged rather than merely slow.
 *
 * Sized against the one component that is genuinely unbounded. The kernel gives
 * the whole template-lock acquisition a single 8s deadline, but that deadline
 * covers response HEADERS only: `fetchByDeadline` clears its abort timer when the
 * fetch promise settles, so the `await r.text()` after it is unbounded, and an
 * edge that answers 200 and then stalls the body wedges `vv-create-project` with
 * a perfectly healthy worker. Nothing else in the span is long — the boot wait is
 * awaited before the `try`, and the install and the dev-server start are not
 * awaited at all — so the lawful worst case is well inside 15s.
 *
 * No copy of the kernel's constant lives here deliberately: it is in another
 * package, and a duplicate that drifted could silently tighten this to below a
 * working create. Which makes this comment the only record of the relationship,
 * so it is worth keeping true.
 *
 * An escape hatch, not a cancellation. Nothing on this side can cancel a kernel
 * request, so if the wedge later clears, the create still resolves and the
 * project still opens — a while after a toast said it had not.
 */
const CREATE_DEADLINE_MS = 45_000;

/** Reject if `work` has not settled within `ms`. Clears its timer either way. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the runtime did not respond within ${Math.round(ms / 1000)}s`)),
      ms,
    );
  });
  // race() attaches handlers to both, so a late rejection from `work` after the
  // deadline has already fired is handled rather than becoming an unhandled one.
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Create-on-submit that tolerates a kernel that has not booted yet.
 *
 * Naming a project is client-side work over a static array; it needs no runtime.
 * These dialogs used to disable Create until `kernelReady` anyway, so a visitor
 * spent the boot staring at a dead button and only *then* started deciding —
 * two waits in series that could have been one. Now the form is live from the
 * first paint and a submit made too early queues.
 *
 * Validation still waits for the kernel, because it genuinely needs the VFS:
 * `useDirValidation` is inert until then, so a queued submit re-validates once
 * the runtime is up and surfaces anything the live check could not see.
 *
 * The queue introduces a window that could not exist before — submitted, not yet
 * started — so it has to be closable. `cancel()` is what `guardClose` calls when
 * a dialog closes by any route (button, Escape, click-outside), and `run`
 * re-checks it after every await: without that, dismissing a dialog that says
 * *Waiting for the runtime…* still scaffolds the project and navigates to it a
 * moment later.
 *
 * Once `create()` has been entered the dialog stops being dismissable, because
 * from there the create genuinely cannot be undone: `vv-create-project` is one
 * kernel request with no cancellation, and it now resolves a template lockfile
 * over the network before it writes, so it is seconds long rather than instant.
 * Letting Escape through during those seconds is the same bug in a smaller
 * window — the project lands anyway — and "cancel" that leaves a scaffolded
 * project behind would be worse than not offering it. So the button reads
 * *Creating…* and is disabled, which is what the "Reset everything?" dialog
 * already does for its own irreversible span.
 *
 * That refusal is only defensible while the create is still going to finish, so
 * `run` guarantees it finishes. Refusing to close is a strictly worse failure
 * than a stuck button — a stuck button is recoverable, an undismissable modal
 * needs a page reload — and it is unjustified precisely when the create failed,
 * since nothing was scaffolded and there is nothing a cancel could leave behind.
 * Two ways it could not finish, and one deadline covers both: `bridge.request`
 * REJECTS when the worker dies (`bridge.ts` `failPending(ERR_WORKER)`) or when
 * post-reply work throws, and it never settles at all if the worker is wedged
 * but alive, since these calls pass no timeout of their own. Either way the
 * catch below toasts, clears `busy`, and hands every close route back.
 */
function useQueuedCreate(effectiveDir: string) {
  const { c, snap } = useIde();
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const [lateError, setLateError] = useState<string | null>(null);
  const aborted = useRef(false);

  // Stable so the dialogs can list them in an effect's deps without the effect
  // re-running (and wiping the form) on every render.
  const reset = useCallback(() => {
    aborted.current = false;
    setBusy(false); setQueued(false); setLateError(null);
  }, []);
  const cancel = useCallback(() => { aborted.current = true; }, []);

  const run = async (create: () => Promise<void>) => {
    aborted.current = false;
    setBusy(true);
    setLateError(null);
    if (!snap.kernelReady) {
      setQueued(true);
      await c.whenKernelReady();
      setQueued(false);
      if (aborted.current) { setBusy(false); return false; }
      const err = await c.validateNewDir(effectiveDir);
      if (aborted.current) { setBusy(false); return false; }
      if (err) { setLateError(err); setBusy(false); return false; }
    }
    try {
      await withDeadline(create(), CREATE_DEADLINE_MS);
      return true;
    } catch (err) {
      toast.error(`Couldn't create the project: ${err instanceof Error ? err.message : String(err)}`);
      setBusy(false);
      return false;
    }
  };

  // In flight: submitted to the kernel, past the point of cancelling.
  const inFlight = busy && !queued;

  /**
   * Wrap a dialog's `onOpenChange` so every close route obeys one policy:
   * cancellable while queued, refused while the create is in flight.
   */
  const guardClose = (onOpenChange: (o: boolean) => void) => (o: boolean) => {
    if (!o) {
      if (inFlight) return;
      cancel();
    }
    onOpenChange(o);
  };

  const label = queued ? "Waiting for the runtime…" : inFlight ? "Creating…" : "Create";
  return { busy, queued, inFlight, lateError, label, reset, guardClose, run };
}

function NewBlankDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { c, snap } = useIde();
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [dirTouched, setDirTouched] = useState(false);

  const effectiveDir = dirTouched ? dir : name.trim() ? c.defaultDirFor(name) : "";
  const { busy, inFlight, lateError, label, reset, guardClose, run } = useQueuedCreate(effectiveDir);
  // Every close route funnels through Dialog's onOpenChange — the Cancel button,
  // Escape and click-outside — so the cancel policy belongs here rather than on
  // the button alone.
  const close = guardClose(onOpenChange);

  useEffect(() => {
    if (open) { setName(""); setDir(""); setDirTouched(false); reset(); }
  }, [open, reset]);

  const liveError = useDirValidation(effectiveDir, open && !!name.trim() && snap.kernelReady);
  const dirError = lateError ?? liveError;
  const canCreate = !!name.trim() && !!effectiveDir && !dirError && !busy;

  const submit = async () => {
    if (!canCreate) return;
    if (await run(() => c.createBlankProject({ name: name.trim(), dir: effectiveDir }))) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
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
          <Button variant="outline" onClick={() => close(false)} disabled={inFlight}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={!canCreate}>{label}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// The catalog, fetched on first open and kept for the tab's lifetime. `catalog`
// is null only while the chunk is in flight — a first-open cost of ~99 KB that
// buys the same amount off every visitor's entry chunk, including the ones who
// never open this dialog.
type Catalog = { templates: TemplateDef[]; categories: TemplateCategory[] };
let cached: Catalog | null = null;

function useTemplateCatalog(open: boolean): Catalog | null {
  const [catalog, setCatalog] = useState<Catalog | null>(cached);
  useEffect(() => {
    if (!open || catalog) return;
    let live = true;
    void loadTemplates().then(
      ({ TEMPLATES, TEMPLATE_CATEGORIES }) => {
        // Only categories that actually have a template, in canonical tab order.
        cached = {
          templates: TEMPLATES,
          categories: TEMPLATE_CATEGORIES.filter((cat) => TEMPLATES.some((t) => t.manifest.category === cat)),
        };
        if (live) setCatalog(cached);
      },
      () => {
        if (live) toast.error("Couldn't load the template catalog — check your connection and try again.");
      },
    );
    return () => { live = false; };
  }, [open, catalog]);
  return catalog;
}

function NewTemplateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { c, snap } = useIde();
  const catalog = useTemplateCatalog(open);
  const [selected, setSelected] = useState<TemplateDef | null>(null);
  const [activeCat, setActiveCat] = useState<TemplateCategory | null>(null);
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [dirTouched, setDirTouched] = useState(false);
  const [runInit, setRunInit] = useState(true);

  const effectiveDir = dirTouched ? dir : name.trim() ? c.defaultDirFor(name) : "";
  const { busy, inFlight, lateError, label, reset, guardClose, run } = useQueuedCreate(effectiveDir);
  const close = guardClose(onOpenChange);

  useEffect(() => {
    if (open) {
      setSelected(null); setActiveCat(null);
      setName(""); setDir(""); setDirTouched(false); setRunInit(true); reset();
    }
  }, [open, reset]);

  // Default to the first populated category once the catalog lands. Kept out of
  // the reset above because the reset runs before the chunk resolves.
  useEffect(() => {
    if (catalog && !activeCat) setActiveCat(catalog.categories[0]);
  }, [catalog, activeCat]);

  const pick = (t: TemplateDef) => {
    setSelected(t);
    const langSlug =
      t.manifest.language === "TypeScript" ? "ts" : t.manifest.language === "Python" ? "py" : "js";
    const suggested = `${t.manifest.framework}-${langSlug}-app`;
    setName(suggested);
    setDirTouched(false);
  };

  const liveError = useDirValidation(effectiveDir, open && !!selected && !!name.trim() && snap.kernelReady);
  const dirError = lateError ?? liveError;
  const canCreate = !!selected && !!name.trim() && !!effectiveDir && !dirError && !busy;

  const submit = async () => {
    if (!canCreate || !selected) return;
    const ok = await run(() => c.createFromTemplate({
      templateId: selected.manifest.id,
      name: name.trim(),
      dir: effectiveDir,
      runInit,
    }));
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Start from a template</DialogTitle>
          <DialogDescription>Pick a template — we'll scaffold it and (optionally) install + run it.</DialogDescription>
        </DialogHeader>

        {!catalog ? (
          <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader className="size-4 animate-spin" /> Loading templates…
          </div>
        ) : (
        <>
        <Tabs
          value={activeCat ?? catalog.categories[0]}
          onValueChange={(v) => setActiveCat(v as TemplateCategory)}
          className="border-b pb-2"
        >
          <TabsList variant="line" className="flex-wrap">
            {catalog.categories.map((cat) => (
              <TabsTrigger key={cat} value={cat}>
                {cat}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="grid max-h-64 grid-cols-2 gap-1.5 overflow-auto sm:grid-cols-3">
          {catalog.templates.filter((t) => t.manifest.category === activeCat).map((t) => {
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
        </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={inFlight}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={!canCreate}>{label}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}