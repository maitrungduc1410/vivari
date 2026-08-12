// What to say while a project installs, and how to know which thing to say.
//
// A run goes: scaffold → install → dev server binds a port → the preview paints.
// On a plain React+TS project that is ~24 seconds, and the studio used to spend
// all of it showing one static status string and a preview panel that said "No
// preview open." — which reads as *nothing is happening*, the exact opposite of
// the truth. The terminal has the real story, but it is one tab of a collapsible
// bottom panel and the user is looking at the preview.
//
// The phase itself comes from events the studio already receives structurally
// (a run starting, a `[depcache]` log line, a port binding, an iframe load), so
// it cannot drift out of sync with what the kernel is doing. The COUNTS are a
// bonus read off the terminal's own progress line and are deliberately optional
// — see `readFetchProgress`.
//
// Pure module: no React, no controller. The phase machine is the part most
// likely to be wrong, and keeping it free of both makes it readable in one page.

/**
 * Ordered coarsely. A run moves forward through these, with exactly one
 * exception: a restore that fails falls back to a cold install — see
 * `fallBackToInstall`.
 */
export type RunPhaseName = "installing" | "restoring" | "starting";

export interface RunPhase {
  /** The project this describes, so a second run replaces rather than stacks. */
  rootPath: string;
  name: string;
  phase: RunPhaseName;
  /** e.g. "47 requests · 12.4 MB". Empty when no burst is in flight. */
  detail: string;
  /** ms since epoch, for an elapsed readout the user can sanity-check. */
  startedAt: number;
}

// `restoring` outranks `installing` because a restore replaces an install, and
// `starting` outranks both because a bound port means the dependency work is
// over however it got there.
const RANK: Record<RunPhaseName, number> = { installing: 0, restoring: 1, starting: 2 };

/** Never go backwards: a late log line must not un-start a running dev server. */
export function advance(prev: RunPhase, phase: RunPhaseName): RunPhase {
  return RANK[phase] > RANK[prev.phase] ? { ...prev, phase, detail: "" } : prev;
}

/**
 * The one legitimate retreat: `restoring` → `installing`.
 *
 * A snapshot restore is announced before it can be known to work, because the
 * announcement is the point — a 13 MB download and a wedged VM look identical
 * from outside. When it then fails, the run continues as a full registry install
 * that is an order of magnitude longer, and a monotonic phase machine would keep
 * saying "Restoring prebuilt dependencies" over all of it. This panel exists to
 * stop the UI misdescribing what is happening, so the fallback path is precisely
 * where it must not.
 *
 * Not a general retreat, and not folded into `advance`: only from `restoring`,
 * so a stray late line cannot un-start a dev server that has already bound a
 * port. Today this is also the COMMON path rather than an edge case — shipped
 * snapshot coverage is `react-ts` alone, so every other template takes it.
 */
export function fallBackToInstall(prev: RunPhase): RunPhase {
  return prev.phase === "restoring" ? { ...prev, phase: "installing", detail: "" } : prev;
}

export function phaseLabel(phase: RunPhaseName): string {
  switch (phase) {
    case "restoring":
      return "Restoring prebuilt dependencies";
    case "starting":
      return "Starting the dev server";
    default:
      return "Installing dependencies";
  }
}

/**
 * The kernel's fetch counters, recovered from the terminal.
 *
 * `packages/core/terminal-feedback.js` folds every outbound request into one
 * repainted line — `⠧ fetching · 47 requests · 12.4 MB` — and writes it to the
 * terminal as ANSI. That number is the only live measure of install progress
 * that exists, but it reaches the studio as screen bytes rather than as data,
 * and the kernel→main message vocabulary is not ours to extend here.
 *
 * So: match the human-readable part and ignore everything else. If that text
 * ever changes shape this returns null, the UI drops the counts, and the phase
 * label carries on unaffected — a wrong number would be worse than no number.
 */
export function readFetchProgress(chunk: string): { requests: number; mb: number } | null {
  const m = /(\d+) requests? · ([\d.]+) MB/.exec(chunk);
  if (!m) return null;
  return { requests: Number(m[1]), mb: Number(m[2]) };
}

export function formatProgress(p: { requests: number; mb: number }): string {
  return `${p.requests.toLocaleString()} request${p.requests === 1 ? "" : "s"} · ${p.mb.toFixed(1)} MB`;
}

/**
 * Open the TCP+TLS connection to the registry before npm needs it.
 *
 * A `<link rel="preconnect">` in the document would be the obvious home for
 * this, but the registry is not touched until somebody creates a project, which
 * may be minutes after load — and Chrome closes an unused preconnected socket
 * after ~10 seconds and warns about it. Doing it here instead ties the handshake
 * to the moment it is certain to be used, with the ~2.5 s of npm CLI boot to
 * cover it. Measured cost of not doing it: DNS+TCP+TLS landing at 4,886 ms,
 * squarely on the critical path.
 */
export function warmRegistryConnection(): void {
  if (typeof document === "undefined") return;
  const href = "https://registry.npmjs.org";
  if (document.head.querySelector(`link[rel="preconnect"][href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "preconnect";
  link.href = href;
  // The registry is fetched with CORS, and a preconnect without `crossorigin`
  // opens a socket in the wrong credentials pool — the anonymous request then
  // opens a second one and the hint buys nothing.
  link.crossOrigin = "anonymous";
  document.head.appendChild(link);
}

/**
 * Does this kernel log line mean a snapshot is being restored rather than a
 * registry install? Matches the `[depcache]` announcement the kernel prints
 * before the work starts, which is the one moment a working restore and a wedged
 * VM look identical from outside.
 *
 * Two announcements, because there are two sources. `fetching` is the shipped
 * asset coming down over the network; `restoring node_modules` is a snapshot
 * already in OPFS, which is the common case for a returning visitor reopening a
 * project and takes well under a second. Matching only the first narrated that
 * fast path as "Installing dependencies" — the same mislabel `fallBackToInstall`
 * exists to prevent, pointing the other way.
 *
 * `restoring` and not `restored`: the completion line ("restored node_modules …
 * — skipping install.") is a different event, and by then the phase has moved on.
 */
export function isRestoreLine(line: string): boolean {
  return line.includes("[depcache]") && (line.includes("fetching") || line.includes("restoring node_modules"));
}

/**
 * Does this kernel log line mean the restore did NOT happen, and the run is a
 * cold install after all?
 *
 * Every giving-up branch in the kernel's snapshot path ends the same sentence —
 * "— installing normally." — whether the asset 404'd, failed to decode, or
 * restored nothing (kernel-worker.ts around :866-923). Matching that clause
 * rather than each reason means a new failure branch is covered by default,
 * which is the right bias for a phase label: the cost of missing one is the UI
 * narrating the wrong thing for a minute.
 *
 * Same fail-closed posture as `readFetchProgress`: no match simply leaves the
 * phase alone.
 */
export function isInstallFallbackLine(line: string): boolean {
  return line.includes("[depcache]") && line.includes("installing normally");
}
