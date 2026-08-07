// What the terminal says while a process is quiet.
//
// Two signals live here — the fetch spinner and the stall verdict — because both
// are guesses about a process nobody can see inside, and both were wrong in the
// same situation: a server that finished installing, bound a port, and went on
// serving requests without printing anything.
//
// Plain JS with no imports so the kernel worker and `npm run probe:terminal-feedback`
// run the same code. The worker half is browser-only and cannot be spiked, so the
// judgement calls are pure functions here and asserted offline instead.

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const CLEAR_LINE = "\r\u001b[2K";

export function newProgress() {
  return { count: 0, bytes: 0, last: 0, frame: 0, active: false, lastFetch: 0, burstStart: 0 };
}

// A burst has to look like an install before it is worth drawing. The spinner
// answers "is this frozen?", and one or two quick requests never raise that
// question — a running app fetching once per button click would just flash a
// progress line at somebody who did not ask for one.
const BURST_MIN_REQUESTS = 3;
const BURST_MIN_MS = 800;

/**
 * Fold one fetch into a terminal's progress line.
 * Returns the chunk to write, or null when throttled or the burst is too small
 * to be worth a line.
 */
export function onFetch(s, size, now, throttleMs = 80) {
  if (s.count === 0) s.burstStart = now;
  s.count++;
  s.bytes += size || 0;
  s.lastFetch = now;
  if (s.count < BURST_MIN_REQUESTS || now - s.burstStart < BURST_MIN_MS) return null;
  if (now - s.last < throttleMs) return null;
  s.last = now;
  s.frame = (s.frame + 1) % SPINNER.length;
  s.active = true;
  const mb = (s.bytes / 1048576).toFixed(1);
  return `${CLEAR_LINE}\u001b[2m${SPINNER[s.frame]} fetching · ${s.count} requests · ${mb} MB\u001b[0m`;
}

/**
 * The shell printed something real, so the spinner goes away.
 *
 * The counters reset with it. They used to run for the life of the terminal, so
 * once an install finished, every request the app itself made kept adding to the
 * install's totals — a server quietly doing its job was reported as "fetching ·
 * 222 requests · 38.7 MB", which reads as a download that will not end.
 */
export function onOutput(s) {
  const wasActive = s.active;
  resetBurst(s);
  return wasActive ? CLEAR_LINE : null;
}

function resetBurst(s) {
  s.count = 0;
  s.bytes = 0;
  s.burstStart = 0;
  s.active = false;
}

/**
 * Wipe a spinner that has stopped moving.
 *
 * Without this the last line drawn stays on screen forever. During an install
 * fetches keep arriving and keep pushing the deadline out, so the spinner only
 * disappears once the traffic actually stops — which is the moment it stops
 * meaning anything.
 */
export function idleClear(s, now, idleMs = 1500) {
  if (!s.count || now - s.lastFetch < idleMs) return null;
  const wasActive = s.active;
  // Reset even when nothing was drawn: otherwise a burst that stayed under the
  // threshold keeps its count, and one request per button click eventually adds
  // up to a spinner for a click that made a single request.
  resetBurst(s);
  return wasActive ? CLEAR_LINE : null;
}

/**
 * Every pid that is serving: one holding a listening port, plus its ancestors —
 * the shell that launched the server is blocked waiting on it and is just as
 * quiet, and just as fine.
 *
 * `listeners` is the kernel's port -> pid map, `parentOf` a pid -> ppid map.
 */
export function servingPids(listeners, parentOf) {
  const serving = new Set();
  for (const [, pid] of listeners) {
    let cur = pid;
    // Stop on a cycle or a missing parent; 0 is the "no parent" sentinel.
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      serving.add(cur);
      cur = parentOf.get(cur);
    }
  }
  return serving;
}

// A verdict of "it IS still working" has to mean something. A first install
// writes tens of thousands of files; one or two is a log line, not progress.
const MEANINGFUL_GROWTH = 25;

/**
 * The bytes a stall report writes to a terminal.
 *
 * `\r\x1b[2K` — column 0, erase the whole line — is correct for the spinner,
 * because the spinner is a line THIS module drew and is entitled to remove. It was
 * also being used to open every stall report, and there it erased whatever the
 * terminal happened to be showing. Normally that is the shell's prompt, which is
 * written with no trailing newline and so IS the current line: the report deleted
 * it, nothing redraws a prompt except a keystroke or a finished command, and the
 * user was left looking at a terminal with no prompt under a message saying their
 * shell looked stuck. A half-typed command line went the same way.
 *
 * So the rule is that a report may only erase a line it drew itself. When the
 * spinner was showing, `clearProgress` has already erased it and the cursor is at
 * column 0 of a line we own, so the report starts there. Otherwise the report
 * starts on a NEW line and leaves the old one alone. That can cost a blank line
 * when the cursor was already at column 0, which is the right way to be wrong:
 * this is asynchronous output arriving under whatever the user was doing, exactly
 * like a job-control notice, and cosmetic beats destructive.
 */
export function stallReportChunk(line, { progressCleared = false } = {}) {
  return `${progressCleared ? "" : "\r\n"}\u001b[2m${line}\u001b[0m\r\n`;
}

/**
 * Is a stalled process worth telling anyone about?
 *
 * An idle server and a wedged one look identical from the kernel: both hold a
 * port, print nothing and make no syscalls. The difference is whether anybody is
 * waiting — a server between requests has nothing pending, a server stuck inside
 * a handler has requests piling up behind it. Reporting the first is noise;
 * reporting the second is the most useful thing this watchdog can say.
 *
 * `hasLiveChild` is the same argument one step further out. A shell waiting on a
 * foreground child prints nothing and makes no syscalls BY DEFINITION — that is
 * what waiting is — so every signal read here says "silent" about the one process
 * in the tree that has nothing to say. A user running the notebook template's
 * warmup got `PID 2 (sh) has printed nothing for 139s … it looks stuck rather than
 * slow` about a shell whose python was busy fetching wheels, which is a false
 * alarm of exactly the kind this watchdog exists to avoid producing. The child is
 * watched on its own terms and reported under its own name, so nothing is lost by
 * staying quiet about the parent — and if the child really is wedged, its report
 * names the program instead of the shell that launched it.
 *
 * `awaitingInput` is the SAME ARGUMENT AGAIN, and the reason it needs its own
 * paragraph is that the fix above was written for the instance rather than the
 * class. "A silent process is not necessarily a stuck one when something else is
 * what it is waiting for" was the finding; "a shell waiting on a child" was the
 * only case anybody enumerated. So the same user, on the same template, with the
 * same command, got the same message again once the warmup FINISHED and the shell
 * went back to its prompt — waiting on a person instead of on a child. Waiting for
 * input is not a variant of waiting for a child; both are instances of waiting,
 * and the list is only complete when every kind of waiting is on it.
 *
 * It is ANNOUNCED rather than inferred, and that is the load-bearing choice here.
 * The cheap rule was available — a shell that has a terminal and no live child must
 * be at a prompt — and it is wrong in the one direction that matters: a shell
 * wedged in its own dispatch also has a terminal and no live child, so the rule
 * would have suppressed the true positive along with the false one, silently and
 * for good. An announcement can only ever excuse a process that made it, so the
 * failure mode is a missing announcement (which reports a healthy process, the
 * noise this watchdog already accepts) instead of a spurious one (which hides a
 * wedge, the thing it exists to prevent).
 *
 * The trade-off accepted, stated because it is real: a process that wedges while
 * it is genuinely parked at a prompt stays unreported. That is a narrower hole than
 * it sounds — with nobody typing, an idle prompt and a prompt that would fail to
 * respond are the same thing to the user, and the moment anybody does type, a shell
 * that cannot answer stops echoing, which is a louder signal than this watchdog's.
 */
export function shouldReportStall({ serving, pendingRequests = 0, hasLiveChild = false, awaitingInput = false }) {
  if ((hasLiveChild || awaitingInput) && pendingRequests === 0) return false;
  return !serving || pendingRequests > 0;
}

/**
 * Why a process has printed nothing for a while.
 *
 * `ports` are the ports this pid is listening on, `grew` the VFS files added
 * since the last check (null if unknown), `idleMs` how long since its last
 * syscall.
 */
export function stallVerdict({ grew, files, idleMs, ports = [], pendingRequests = 0 }) {
  const n = (v) => v.toLocaleString();
  if (grew !== null && grew >= MEANINGFUL_GROWTH) {
    return (
      `It IS still working — the filesystem gained ${n(grew)} files since the ` +
      `last check (${n(files)} total). A first install writes tens of thousands.`
    );
  }
  // A serving process is only reported when requests are waiting on it (see
  // shouldReportStall), and then the pending count is the whole story: it went
  // into a handler and has not come out.
  if (ports.length) {
    const at = ports.map((p) => `:${p}`).join(", ");
    if (pendingRequests > 0) {
      return (
        `It is listening on ${at} with ${pendingRequests} request` +
        `${pendingRequests === 1 ? "" : "s"} waiting and no syscall for ` +
        `${Math.round(idleMs / 1000)}s — it looks stuck inside a handler.`
      );
    }
    return (
      `It is listening on ${at}, so this is a server waiting for its next ` +
      `request — printing nothing is the normal state.`
    );
  }
  if (grew !== null && grew < MEANINGFUL_GROWTH && idleMs > 5000) {
    const idle = Math.round(idleMs / 1000);
    const held = ports.length ? ` It still holds ${ports.map((p) => `:${p}`).join(", ")}.` : "";
    return (
      `Nothing has changed since the last check (${n(files)} files, no syscall for ` +
      `${idle}s), so it looks stuck rather than slow.${held}`
    );
  }
  return (
    `It may just be slow — a first install downloads and writes a lot` +
    (files !== null ? ` (${n(files)} files in the VFS so far)` : "") +
    ". Watch whether the next check shows progress."
  );
}