// Persisted git author identity (name + email) for commits.
//
// This lives in `localStorage` (like the recent-projects registry and the UI
// theme), NOT in the VFS: it's per-user, not per-project, and must be known
// before the first commit. The SCM panel prompts for it on first commit when
// unset. Local-only SCM has no remote auth, so there is no token stored here.

const KEY = "vv-git-config";

export interface GitIdentity {
  name: string;
  email: string;
}

export function loadGitIdentity(): GitIdentity | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<GitIdentity>;
    if (v && typeof v.name === "string" && typeof v.email === "string" && v.name && v.email) {
      return { name: v.name, email: v.email };
    }
  } catch {
    /* ignore malformed */
  }
  return null;
}

export function saveGitIdentity(id: GitIdentity): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ name: id.name.trim(), email: id.email.trim() }));
  } catch {
    /* storage full / disabled — non-fatal */
  }
}

export function hasGitIdentity(): boolean {
  return loadGitIdentity() != null;
}