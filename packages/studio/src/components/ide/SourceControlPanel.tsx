import { useState, useSyncExternalStore } from "react";
import GitBranch from "~icons/lucide/git-branch";
import GitCommitHorizontal from "~icons/lucide/git-commit-horizontal";
import RefreshCw from "~icons/lucide/refresh-cw";
import Check from "~icons/lucide/check";
import Plus from "~icons/lucide/plus";
import Minus from "~icons/lucide/minus";
import RotateCcw from "~icons/lucide/rotate-ccw";
import ChevronDown from "~icons/lucide/chevron-down";
import History from "~icons/lucide/history";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { FileIcon } from "./fileIcon";
import { useIde } from "./useIde";
import type { GitChange, ChangeLetter, RepoState, ScmSession } from "@/vv/scm-session";
import { hasGitIdentity, loadGitIdentity, saveGitIdentity } from "@/vv/git-config";

const LETTER_TITLE: Record<ChangeLetter, string> = { A: "Added", M: "Modified", D: "Deleted", U: "Untracked" };
const LETTER_CLASS: Record<ChangeLetter, string> = {
  A: "text-green-600 dark:text-green-400",
  M: "text-amber-600 dark:text-amber-400",
  D: "text-red-600 dark:text-red-400",
  U: "text-green-600 dark:text-green-400",
};

const baseName = (p: string) => p.split("/").pop() || p;
const dirName = (p: string) => {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
};

export function SourceControlPanel() {
  const { c } = useIde();
  const scm = c.scm;
  const snap = useSyncExternalStore(scm.subscribe, scm.getSnapshot);

  // Dialog + collapse state is keyed by repo root so it works across sections.
  const [identityRoot, setIdentityRoot] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [branchRoot, setBranchRoot] = useState<string | null>(null);
  const [branchName, setBranchName] = useState("");
  const [discardTarget, setDiscardTarget] = useState<{ root: string; change: GitChange } | null>(null);
  const [discardAllRoot, setDiscardAllRoot] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const openChange = (ch: GitChange) => {
    if (ch.letter === "U") void c.openEntry(ch.abs);
    else c.openDiff(ch.abs);
  };

  const doCommit = async (repo: RepoState) => {
    const message = repo.commitMessage.trim();
    if (!message) return;
    if (!hasGitIdentity()) {
      const id = loadGitIdentity();
      setName(id?.name ?? "");
      setEmail(id?.email ?? "");
      setIdentityRoot(repo.root);
      return;
    }
    if (repo.staged.length === 0 && repo.changes.length > 0) await scm.stageAll(repo.root);
    await scm.commit(repo.root, message);
  };

  const saveIdentityAndCommit = async () => {
    if (!name.trim() || !email.trim() || !identityRoot) return;
    const root = identityRoot;
    saveGitIdentity({ name, email });
    setIdentityRoot(null);
    const repo = scm.getSnapshot().repos.find((r) => r.root === root);
    const message = repo?.commitMessage.trim();
    if (!repo || !message) return;
    if (repo.staged.length === 0 && repo.changes.length > 0) await scm.stageAll(root);
    await scm.commit(root, message, { name, email });
  };

  const toggleCollapse = (root: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });

  if (snap.repos.length === 0) {
    return (
      <Panel>
        <div className="p-3 text-xs leading-relaxed text-muted-foreground">
          Open a project to use Source Control.
        </div>
      </Panel>
    );
  }

  // Single repo → skip the outer collapse chrome and show it expanded, so the
  // common case stays as compact as before.
  const single = snap.repos.length === 1;

  return (
    <Panel>
      <ScrollArea className="min-h-0 flex-1">
        {snap.repos.map((repo) => (
          <RepoSection
            key={repo.root}
            repo={repo}
            scm={scm}
            collapsible={!single}
            collapsed={collapsed.has(repo.root)}
            onToggle={() => toggleCollapse(repo.root)}
            onOpenChange={openChange}
            onCommit={() => void doCommit(repo)}
            onNewBranch={() => { setBranchRoot(repo.root); setBranchName(""); }}
            onDiscard={(change) => setDiscardTarget({ root: repo.root, change })}
            onDiscardAll={() => setDiscardAllRoot(repo.root)}
          />
        ))}
      </ScrollArea>

      {/* create-branch dialog */}
      <Dialog open={branchRoot != null} onOpenChange={(o) => { if (!o) setBranchRoot(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Create branch</DialogTitle>
            <DialogDescription>Branch off the current HEAD and switch to it.</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && branchName.trim() && branchRoot) {
                void scm.createBranch(branchRoot, branchName.trim());
                setBranchRoot(null);
              }
            }}
            placeholder="feature/my-branch"
          />
          <DialogFooter>
            <Button variant="secondary" onClick={() => setBranchRoot(null)}>Cancel</Button>
            <Button
              disabled={!branchName.trim()}
              onClick={() => {
                if (branchRoot) void scm.createBranch(branchRoot, branchName.trim());
                setBranchRoot(null);
              }}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* git identity dialog (first commit) */}
      <Dialog open={identityRoot != null} onOpenChange={(o) => { if (!o) setIdentityRoot(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Set your git identity</DialogTitle>
            <DialogDescription>Used as the author of your commits. Stored locally in this browser.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setIdentityRoot(null)}>Cancel</Button>
            <Button disabled={!name.trim() || !email.trim()} onClick={() => void saveIdentityAndCommit()}>
              Save &amp; commit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* discard single */}
      <AlertDialog open={discardTarget != null} onOpenChange={(o) => { if (!o) setDiscardTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Discard changes to {discardTarget ? baseName(discardTarget.change.path) : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>This is irreversible — the file is restored to its last committed state.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (discardTarget) void scm.discard(discardTarget.root, discardTarget.change);
                setDiscardTarget(null);
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* discard all */}
      <AlertDialog open={discardAllRoot != null} onOpenChange={(o) => { if (!o) setDiscardAllRoot(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Discard all {discardAllRoot ? scm.getSnapshot().repos.find((r) => r.root === discardAllRoot)?.changes.length ?? 0 : 0} changes?
            </AlertDialogTitle>
            <AlertDialogDescription>This is irreversible — all unstaged changes are reverted.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const root = discardAllRoot;
                setDiscardAllRoot(null);
                if (!root) return;
                const items = scm.getSnapshot().repos.find((r) => r.root === root)?.changes.slice() ?? [];
                void (async () => {
                  for (const ch of items) await scm.discard(root, ch);
                })();
              }}
            >
              Discard All
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}

function RepoSection({
  repo, scm, collapsible, collapsed, onToggle, onOpenChange, onCommit, onNewBranch, onDiscard, onDiscardAll,
}: {
  repo: RepoState;
  scm: ScmSession;
  collapsible: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onOpenChange: (ch: GitChange) => void;
  onCommit: () => void;
  onNewBranch: () => void;
  onDiscard: (ch: GitChange) => void;
  onDiscardAll: () => void;
}) {
  const changedCount = repo.staged.length + repo.changes.length;
  const canCommit = !!repo.commitMessage.trim() && !repo.busy && changedCount > 0;
  const showBody = !collapsible || !collapsed;

  return (
    <div className="border-b">
      {/* repo header: name + branch + refresh */}
      <div className="group flex h-8 items-center gap-1 px-2">
        {collapsible ? (
          <button
            className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-accent"
            onClick={onToggle}
            title={collapsed ? "Expand" : "Collapse"}
          >
            <ChevronDown className={cn("size-4 transition-transform", collapsed && "-rotate-90")} />
          </button>
        ) : (
          <GitBranch className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-semibold" title={repo.root}>
          {repo.name}
        </span>

        {repo.isRepo && (
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <DropdownMenuTrigger className="flex min-w-0 max-w-[45%] items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-accent" />
                }
              >
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate">{repo.currentBranch ?? "(detached)"}</span>
                <ChevronDown className="size-3 shrink-0 opacity-60" />
              </TooltipTrigger>
              <TooltipContent side="bottom">Switch / create branch</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="min-w-52">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Branches</DropdownMenuLabel>
                {repo.branches.map((b) => (
                  <DropdownMenuItem key={b} onClick={() => b !== repo.currentBranch && void scm.checkoutBranch(repo.root, b)}>
                    <GitBranch className="size-4" />
                    <span className="flex-1 truncate">{b}</span>
                    {b === repo.currentBranch && <Check className="size-4" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onNewBranch}>
                <Plus className="size-4" /> Create new branch…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <IconBtn label="Refresh" onClick={() => void scm.refresh()} disabled={repo.busy}>
          <RefreshCw className={cn("size-3.5", repo.busy && "animate-spin")} />
        </IconBtn>
        {changedCount > 0 && (
          <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] font-medium">{changedCount}</span>
        )}
      </div>

      {showBody && (
        <div className="border-t">
          {repo.checking && !repo.isRepo ? (
            <div className="p-3 text-xs text-muted-foreground">Checking for a repository…</div>
          ) : !repo.isRepo ? (
            <div className="flex flex-col gap-3 p-3 text-xs leading-relaxed text-muted-foreground">
              <p>
                This project is not a git repository. Initialize one to track changes, commit, and
                branch — all locally in your browser.
              </p>
              <Button size="sm" disabled={repo.busy} onClick={() => void scm.init(repo.root)}>
                <GitBranch className="size-4" /> Initialize Repository
              </Button>
            </div>
          ) : (
            <>
              {/* commit box */}
              <div className="flex flex-col gap-1.5 p-2">
                <Textarea
                  value={repo.commitMessage}
                  onChange={(e) => scm.setCommitMessage(repo.root, e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canCommit) onCommit();
                  }}
                  placeholder={`Message (⌘Enter to commit on "${repo.currentBranch ?? "HEAD"}")`}
                  className="min-h-16 resize-none text-xs"
                />
                <Button size="sm" disabled={!canCommit} onClick={onCommit}>
                  <Check className="size-4" /> Commit
                </Button>
              </div>

              {repo.error && (
                <div className="border-t bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
                  {repo.error}
                </div>
              )}

              <Section
                title="Staged Changes"
                count={repo.staged.length}
                actions={
                  repo.staged.length > 0 && (
                    <IconBtn label="Unstage all" onClick={() => void scm.unstageAll(repo.root)} disabled={repo.busy}>
                      <Minus className="size-3.5" />
                    </IconBtn>
                  )
                }
              >
                {repo.staged.map((ch) => (
                  <Row key={"s:" + ch.path} ch={ch} onOpen={() => onOpenChange(ch)}>
                    <IconBtn label="Unstage" onClick={() => void scm.unstage(repo.root, ch)} disabled={repo.busy}>
                      <Minus className="size-3.5" />
                    </IconBtn>
                  </Row>
                ))}
              </Section>

              <Section
                title="Changes"
                count={repo.changes.length}
                actions={
                  repo.changes.length > 0 && (
                    <>
                      <IconBtn label="Discard all changes" onClick={onDiscardAll} disabled={repo.busy}>
                        <RotateCcw className="size-3.5" />
                      </IconBtn>
                      <IconBtn label="Stage all changes" onClick={() => void scm.stageAll(repo.root)} disabled={repo.busy}>
                        <Plus className="size-3.5" />
                      </IconBtn>
                    </>
                  )
                }
              >
                {repo.changes.map((ch) => (
                  <Row key={"c:" + ch.path} ch={ch} onOpen={() => onOpenChange(ch)}>
                    <IconBtn label="Discard changes" onClick={() => onDiscard(ch)} disabled={repo.busy}>
                      <RotateCcw className="size-3.5" />
                    </IconBtn>
                    <IconBtn label="Stage changes" onClick={() => void scm.stage(repo.root, ch)} disabled={repo.busy}>
                      <Plus className="size-3.5" />
                    </IconBtn>
                  </Row>
                ))}
              </Section>

              {repo.staged.length === 0 && repo.changes.length === 0 && (
                <div className="p-3 text-xs text-muted-foreground">No changes.</div>
              )}

              {repo.history.length > 0 && (
                <Section title="History" count={repo.history.length} icon={<History className="size-3.5" />}>
                  {repo.history.map((cm) => (
                    <div key={cm.oid} className="flex items-start gap-2 px-3 py-1 text-xs">
                      <GitCommitHorizontal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-foreground" title={cm.message}>{cm.message}</div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {cm.oid.slice(0, 7)} · {cm.author} · {relTime(cm.timestamp)}
                        </div>
                      </div>
                    </div>
                  ))}
                </Section>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-sidebar text-sm">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <GitBranch className="size-4" />
        <span className="flex-1">Source Control</span>
      </div>
      {children}
    </div>
  );
}

function Section({
  title, count, actions, icon, children,
}: {
  title: string; count: number; actions?: React.ReactNode; icon?: React.ReactNode; children?: React.ReactNode;
}) {
  return (
    <div className="border-t py-1">
      <div className="group flex h-6 items-center gap-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        <span className="flex-1">{title}</span>
        <span className="inline-flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {actions}
        </span>
        {count > 0 && (
          <span className="ml-1 rounded-full bg-muted px-1.5 text-[10px] font-medium">{count}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function Row({ ch, onOpen, children }: { ch: GitChange; onOpen: () => void; children?: React.ReactNode }) {
  const dir = dirName(ch.path);
  return (
    <div
      className="group flex h-6 cursor-pointer items-center gap-1.5 px-2 hover:bg-accent"
      onClick={onOpen}
      title={ch.path}
    >
      <FileIcon name={baseName(ch.path)} className="size-3.5 shrink-0" />
      <span className="truncate text-xs text-foreground">{baseName(ch.path)}</span>
      {dir && <span className="truncate text-[11px] text-muted-foreground">{dir}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        <span
          className="hidden items-center gap-0.5 group-hover:flex"
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </span>
        <span className={cn("w-3 text-center text-xs font-semibold", LETTER_CLASS[ch.letter])} title={LETTER_TITLE[ch.letter]}>
          {ch.letter}
        </span>
      </span>
    </div>
  );
}

function IconBtn({
  label, onClick, disabled, children,
}: {
  label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        disabled={disabled}
        aria-label={label}
        className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function relTime(seconds: number): string {
  if (!seconds) return "";
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(seconds * 1000).toLocaleDateString();
}