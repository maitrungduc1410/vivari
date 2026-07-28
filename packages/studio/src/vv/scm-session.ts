// Studio-side Source Control (git) session.
//
// The main-thread half of the Git SCM panel. It drives isomorphic-git over the
// in-tab VFS (through the git-fs adapter → the silent `vv-git-fs` kernel RPC) and
// exposes an immutable snapshot for useSyncExternalStore, mirroring DebugSession
// and the IdeController store pattern.
//
// Everything here is LOCAL-ONLY: init, stage/unstage, commit, branch, diff,
// history, discard. There is no network, no remote, no server (by design).
//
// Multi-repo: the panel mirrors VS Code — every open workspace folder is its own
// repository entry (its own branch, commit box, status and history). State is a
// list of RepoState keyed by root; operations take the target root.
//
// Performance: isomorphic-git runs on the main thread, so status walks are kept
// cheap — the heavy directories (node_modules, dist, …) are filtered out, repos
// are walked sequentially, refresh is coalesced + gated to when the panel is
// shown, and isomorphic-git itself is lazy-imported (a ~1 MB chunk) only when a
// repo is actually present or the user initializes one.

import type { KernelBridge } from "./kernel";
import { createGitFs, type GitFs } from "./git-fs";
import { loadGitIdentity, type GitIdentity } from "./git-config";

// Directories never worth walking for status (also covered by a good .gitignore,
// but this guards repos that lack one — e.g. right after `git init`).
const IGNORE_RE = /(^|\/)(node_modules|\.git|dist|build|\.next|\.turbo|\.cache|coverage|\.vite)(\/|$)/;

const DEFAULT_GITIGNORE = `node_modules/
dist/
build/
.next/
.turbo/
.cache/
coverage/
*.log
.DS_Store
`;

export type ChangeLetter = "A" | "M" | "D" | "U";

export interface GitChange {
  path: string; // repo-relative
  abs: string; // absolute VFS path
  letter: ChangeLetter;
}

export interface GitCommit {
  oid: string;
  message: string;
  author: string;
  timestamp: number; // seconds
}

/** One repository entry — a single open workspace folder. */
export interface RepoState {
  root: string; // absolute folder root (no trailing slash)
  name: string; // display name (workspace folder name)
  isRepo: boolean;
  checking: boolean; // detecting .git / first load
  busy: boolean; // an operation is running on this repo
  currentBranch: string | null;
  branches: string[];
  staged: GitChange[];
  changes: GitChange[]; // unstaged (working tree)
  history: GitCommit[];
  commitMessage: string;
  error: string | null;
}

export interface ScmSnapshot {
  repos: RepoState[]; // ordered like workspaceFolders
}

type GitApi = any; // isomorphic-git, lazily imported

function emptyRepo(root: string, name: string): RepoState {
  return {
    root,
    name,
    isRepo: false,
    checking: false,
    busy: false,
    currentBranch: null,
    branches: [],
    staged: [],
    changes: [],
    history: [],
    commitMessage: "",
    error: null,
  };
}

export class ScmSession {
  private readonly fs: GitFs;
  private listeners = new Set<() => void>();
  private gitPromise: Promise<GitApi> | null = null;
  private refreshSeq = 0;
  // Coalesce refreshes: a status walk fires many synchronous kernel-fs ops (each
  // parks the kernel worker on Atomics.wait), and the kernel worker's message loop
  // also drives the terminal (input/spawn/output). So never let two walks overlap —
  // if one is running, remember to run exactly one more when it finishes.
  private refreshing = false;
  private refreshQueued = false;

  private snap: ScmSnapshot = { repos: [] };

  /** Fired after an operation mutates the WORKING TREE (checkout, discard) so the
   * controller can refresh the Explorer + reload open editor models. Git internal
   * writes (commit → .git/objects) go through the silent RPC and don't fire this. */
  onWorkdirChanged: (() => void) | null = null;

  constructor(bridge: KernelBridge) {
    this.fs = createGitFs(bridge);
  }

  // ── store plumbing ──
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getSnapshot = (): ScmSnapshot => this.snap;
  private emit() {
    for (const l of this.listeners) l();
  }
  private setRepos(repos: RepoState[]) {
    this.snap = { repos };
    this.emit();
  }
  private setRepo(root: string, patch: Partial<RepoState>) {
    this.snap = { repos: this.snap.repos.map((r) => (r.root === root ? { ...r, ...patch } : r)) };
    this.emit();
  }
  private repo(root: string): RepoState | undefined {
    return this.snap.repos.find((r) => r.root === root);
  }
  private repoForPath(abs: string): RepoState | undefined {
    let best: RepoState | undefined;
    for (const r of this.snap.repos) {
      if (abs === r.root || abs.startsWith(r.root + "/")) {
        if (!best || r.root.length > best.root.length) best = r;
      }
    }
    return best;
  }

  /** Total changed files across all repos (for the ActivityBar badge). */
  get changedCount(): number {
    return this.snap.repos.reduce((n, r) => n + r.staged.length + r.changes.length, 0);
  }

  setCommitMessage(root: string, message: string) {
    this.setRepo(root, { commitMessage: message });
  }

  // Lazy-load isomorphic-git (a ~1 MB chunk Vite code-splits) on first git use.
  // isomorphic-git assumes a global `Buffer` in the browser, so install the
  // `buffer` polyfill BEFORE importing it (otherwise every op throws
  // "Buffer is not defined"). Scoped here so the polyfill + chunk only load when
  // git is actually used.
  private loadGit(): Promise<GitApi> {
    if (!this.gitPromise) {
      this.gitPromise = ensureBuffer()
        .then(() => import("isomorphic-git"))
        .then((m) => (m as { default?: GitApi }).default ?? m);
    }
    return this.gitPromise;
  }

  private rel(root: string, abs: string): string {
    return abs.startsWith(root + "/") ? abs.slice(root.length + 1) : abs.replace(/^\/+/, "");
  }
  private absOf(root: string, rel: string): string {
    return root + "/" + rel;
  }

  /** Reconcile the repo list against the current workspace folders. Preserves
   * existing status + commit message for folders that persist, adds blank entries
   * for new folders, and drops removed ones. Deliberately does NOT refresh: a
   * status walk contends with the terminal on the kernel worker thread, so we only
   * walk when the panel is shown (see controller.setActiveView / bumpTree) or after
   * an explicit git action. */
  setRoots(folders: { root: string; name: string }[]) {
    const prev = new Map(this.snap.repos.map((r) => [r.root, r]));
    const repos = folders.map((f) => {
      const existing = prev.get(f.root);
      if (existing) return existing.name === f.name ? existing : { ...existing, name: f.name };
      return emptyRepo(f.root, f.name);
    });
    const same =
      repos.length === this.snap.repos.length && repos.every((r, i) => r === this.snap.repos[i]);
    if (!same) this.setRepos(repos);
  }

  private async detectRepo(root: string): Promise<boolean> {
    try {
      const st = await this.fs.promises.stat(root + "/.git");
      return st.isDirectory();
    } catch {
      return false;
    }
  }

  /** Recompute branch + status + history for every repo. Coalesced so status walks
   * never overlap (they'd otherwise pile synchronous kernel-fs ops onto the kernel
   * worker thread that also serves the terminal). While one runs, extra calls
   * schedule exactly one trailing run. */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.refreshQueued = false;
        await this.doRefresh();
      } while (this.refreshQueued);
    } finally {
      this.refreshing = false;
    }
  }

  private async doRefresh(): Promise<void> {
    const seq = ++this.refreshSeq;
    // Snapshot the roots up front; walk them sequentially to avoid flooding the
    // kernel worker with concurrent synchronous fs ops.
    const roots = this.snap.repos.map((r) => r.root);
    for (const root of roots) {
      if (seq !== this.refreshSeq) return;
      await this.refreshRepo(root, seq);
    }
  }

  private async refreshRepo(root: string, seq: number): Promise<void> {
    const cur = this.repo(root);
    if (!cur) return;
    this.setRepo(root, { checking: !cur.isRepo });
    const isRepo = await this.detectRepo(root);
    if (seq !== this.refreshSeq || !this.repo(root)) return;
    if (!isRepo) {
      this.setRepo(root, {
        isRepo: false,
        checking: false,
        currentBranch: null,
        branches: [],
        staged: [],
        changes: [],
        history: [],
      });
      return;
    }
    try {
      const git = await this.loadGit();
      if (seq !== this.refreshSeq || !this.repo(root)) return;
      const dir = root;
      const [branch, branches, matrix] = await Promise.all([
        git.currentBranch({ fs: this.fs, dir, fullname: false }).catch(() => null),
        git.listBranches({ fs: this.fs, dir }).catch(() => []),
        git.statusMatrix({ fs: this.fs, dir, filter: (f: string) => !IGNORE_RE.test(f) }),
      ]);
      if (seq !== this.refreshSeq || !this.repo(root)) return;
      const staged: GitChange[] = [];
      const changes: GitChange[] = [];
      for (const row of matrix as number[][]) {
        const filepath = row[0] as unknown as string;
        const [, head, workdir, stage] = row;
        const s = stagedLetter(head, stage);
        if (s) staged.push({ path: filepath, abs: this.absOf(root, filepath), letter: s });
        const u = unstagedLetter(workdir, stage);
        if (u) changes.push({ path: filepath, abs: this.absOf(root, filepath), letter: u });
      }
      staged.sort((a, b) => a.path.localeCompare(b.path));
      changes.sort((a, b) => a.path.localeCompare(b.path));
      const history = await this.readLog(git, dir);
      if (seq !== this.refreshSeq || !this.repo(root)) return;
      this.setRepo(root, {
        isRepo: true,
        checking: false,
        currentBranch: branch,
        branches,
        staged,
        changes,
        history,
        error: null,
      });
    } catch (err) {
      if (seq !== this.refreshSeq || !this.repo(root)) return;
      this.setRepo(root, { isRepo: true, checking: false, error: errMsg(err) });
    }
  }

  private async readLog(git: GitApi, dir: string): Promise<GitCommit[]> {
    try {
      const commits = await git.log({ fs: this.fs, dir, depth: 20 });
      return (commits as any[]).map((c) => ({
        oid: c.oid,
        message: (c.commit.message || "").split("\n")[0],
        author: c.commit.author?.name || "",
        timestamp: c.commit.author?.timestamp || 0,
      }));
    } catch {
      return [];
    }
  }

  private async withBusy<T>(root: string, fn: () => Promise<T>): Promise<T | undefined> {
    const cur = this.repo(root);
    if (!cur || cur.busy) return undefined;
    this.setRepo(root, { busy: true, error: null });
    try {
      return await fn();
    } catch (err) {
      this.setRepo(root, { error: errMsg(err) });
      return undefined;
    } finally {
      this.setRepo(root, { busy: false });
    }
  }

  // ── operations (each targets one repo root) ──
  async init(root: string): Promise<void> {
    if (!this.repo(root)) return;
    await this.withBusy(root, async () => {
      const git = await this.loadGit();
      await git.init({ fs: this.fs, dir: root, defaultBranch: "main" });
      // Seed a sensible .gitignore if the project lacks one, so `node_modules`
      // and build output never flood the status list (and never get committed).
      try {
        await this.fs.promises.stat(root + "/.gitignore");
      } catch {
        await this.fs.promises.writeFile(root + "/.gitignore", DEFAULT_GITIGNORE);
        this.onWorkdirChanged?.();
      }
    });
    await this.refresh();
  }

  async stage(root: string, change: GitChange): Promise<void> {
    await this.withBusy(root, async () => {
      const git = await this.loadGit();
      if (change.letter === "D") await git.remove({ fs: this.fs, dir: root, filepath: change.path });
      else await git.add({ fs: this.fs, dir: root, filepath: change.path });
    });
    await this.refresh();
  }

  async unstage(root: string, change: GitChange): Promise<void> {
    await this.withBusy(root, async () => {
      const git = await this.loadGit();
      await git.resetIndex({ fs: this.fs, dir: root, filepath: change.path });
    });
    await this.refresh();
  }

  async stageAll(root: string): Promise<void> {
    const cur = this.repo(root);
    if (!cur) return;
    const items = cur.changes.slice();
    await this.withBusy(root, async () => {
      const git = await this.loadGit();
      for (const c of items) {
        if (c.letter === "D") await git.remove({ fs: this.fs, dir: root, filepath: c.path });
        else await git.add({ fs: this.fs, dir: root, filepath: c.path });
      }
    });
    await this.refresh();
  }

  async unstageAll(root: string): Promise<void> {
    const cur = this.repo(root);
    if (!cur) return;
    const items = cur.staged.slice();
    await this.withBusy(root, async () => {
      const git = await this.loadGit();
      for (const c of items) await git.resetIndex({ fs: this.fs, dir: root, filepath: c.path });
    });
    await this.refresh();
  }

  /** Discard a single working-tree change: untracked → delete the file; tracked →
   * restore it from HEAD. Fires onWorkdirChanged so the editor/Explorer refresh. */
  async discard(root: string, change: GitChange): Promise<void> {
    await this.withBusy(root, async () => {
      const git = await this.loadGit();
      if (change.letter === "U") {
        await this.fs.promises.unlink(change.abs);
      } else {
        await git.checkout({ fs: this.fs, dir: root, filepaths: [change.path], force: true });
      }
    });
    this.onWorkdirChanged?.();
    await this.refresh();
  }

  async commit(root: string, message: string, identityOverride?: GitIdentity): Promise<boolean> {
    const identity = identityOverride ?? loadGitIdentity();
    if (!identity) {
      this.setRepo(root, { error: "Set your git name and email first." });
      return false;
    }
    const ok = await this.withBusy(root, async () => {
      const git = await this.loadGit();
      await git.commit({
        fs: this.fs,
        dir: root,
        message,
        author: { name: identity.name, email: identity.email },
      });
      return true;
    });
    if (ok) this.setRepo(root, { commitMessage: "" });
    await this.refresh();
    return ok === true;
  }

  async createBranch(root: string, name: string, checkout = true): Promise<void> {
    await this.withBusy(root, async () => {
      const git = await this.loadGit();
      await git.branch({ fs: this.fs, dir: root, ref: name, checkout });
    });
    if (checkout) this.onWorkdirChanged?.();
    await this.refresh();
  }

  async checkoutBranch(root: string, name: string): Promise<void> {
    await this.withBusy(root, async () => {
      const git = await this.loadGit();
      await git.checkout({ fs: this.fs, dir: root, ref: name });
    });
    this.onWorkdirChanged?.();
    await this.refresh();
  }

  async deleteBranch(root: string, name: string): Promise<void> {
    await this.withBusy(root, async () => {
      const git = await this.loadGit();
      await git.deleteBranch({ fs: this.fs, dir: root, ref: name });
    });
    await this.refresh();
  }

  /** The file's content at HEAD (for the diff view), resolving which repo owns the
   * path. Empty string if the file is new (not in HEAD) or on any error. */
  async headBlobText(abs: string): Promise<string> {
    const repo = this.repoForPath(abs);
    if (!repo || !repo.isRepo) return "";
    try {
      const git = await this.loadGit();
      const oid = await git.resolveRef({ fs: this.fs, dir: repo.root, ref: "HEAD" });
      const { blob } = await git.readBlob({
        fs: this.fs,
        dir: repo.root,
        oid,
        filepath: this.rel(repo.root, abs),
      });
      return new TextDecoder().decode(blob);
    } catch {
      return "";
    }
  }
}

// statusMatrix cell semantics (isomorphic-git):
//   head:    0 absent, 1 present
//   workdir: 0 absent, 1 == HEAD, 2 != HEAD
//   stage:   0 absent, 1 == HEAD, 2 == workdir, 3 != HEAD && != workdir

/** Index-vs-HEAD (the "Staged Changes" section). */
function stagedLetter(head: number, stage: number): ChangeLetter | null {
  if (head === 1 && stage === 0) return "D"; // staged deletion
  if (stage === 2 || stage === 3) return head === 0 ? "A" : "M"; // staged add / modify
  return null;
}

/** Working-tree-vs-index (the "Changes" section). */
function unstagedLetter(workdir: number, stage: number): ChangeLetter | null {
  if (workdir === 0 && stage !== 0) return "D"; // deleted in working tree
  if (workdir === 2 && stage !== 2) return stage === 0 ? "U" : "M"; // untracked / modified
  return null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// isomorphic-git expects a global `Buffer` in the browser. Install the `buffer`
// polyfill once, before the isomorphic-git chunk is imported. Idempotent.
let bufferReady: Promise<void> | null = null;
function ensureBuffer(): Promise<void> {
  const g = globalThis as { Buffer?: unknown };
  if (g.Buffer) return Promise.resolve();
  if (!bufferReady) {
    bufferReady = import("buffer").then(({ Buffer }) => {
      if (!g.Buffer) g.Buffer = Buffer;
    });
  }
  return bufferReady;
}