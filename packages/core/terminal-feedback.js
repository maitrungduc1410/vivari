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
 * Is a stalled process worth telling anyone about?
 *
 * An idle server and a wedged one look identical from the kernel: both hold a
 * port, print nothing and make no syscalls. The difference is whether anybody is
 * waiting — a server between requests has nothing pending, a server stuck inside
 * a handler has requests piling up behind it. Reporting the first is noise;
 * reporting the second is the most useful thing this watchdog can say.
 */
export function shouldReportStall({ serving, pendingRequests = 0 }) {
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