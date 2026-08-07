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
 * `awaiting` is the SAME ARGUMENT AGAIN, and the reason it needs its own paragraph
 * is that the fix above was written for the instance rather than the class. "A
 * silent process is not necessarily a stuck one when something else is what it is
 * waiting for" was the finding; "a shell waiting on a child" was the only case
 * anybody enumerated. So the same user, on the same template, with the same command,
 * got the same message again once the warmup FINISHED and the shell went back to its
 * prompt — waiting on a person instead of on a child.
 *
 * IT HAPPENED A THIRD TIME, which is why this parameter carries a reason instead of
 * being a second boolean. The React template's dev server spawns a pool of rolldown
 * `wasi-worker.mjs` threads that park on their parentPort waiting for a job, and the
 * user watched every one of them accused of being stuck while the server they belong
 * to was serving. Waiting for input is not a variant of waiting for a child, and waiting for
 * work is not a variant of either; they are instances of waiting, and the list is
 * only complete when every kind is on it. Adding the third as `awaitingWork` beside
 * `awaitingInput` would have made the fourth someone else's problem again.
 *
 * It is ANNOUNCED rather than inferred, and that is the load-bearing choice here.
 * The cheap rule was available in both cases — a shell with a terminal and no live
 * child must be at a prompt; a worker thread with no syscalls must be idle — and it
 * is wrong in the one direction that matters: a shell wedged in its own dispatch also
 * has a terminal and no live child, and a worker spinning inside wasm also makes no
 * syscalls, so the rule would have suppressed the true positive along with the false
 * one, silently and for good. An announcement can only ever excuse a process that
 * made it, so the failure mode is a missing announcement (which reports a healthy
 * process, the noise this watchdog already accepts) instead of a spurious one (which
 * hides a wedge, the thing it exists to prevent).
 *
 * What backs the `work` announcement is stricter than "a worker said so", and the
 * strictness is in runtime/index.js rather than here: it is sent only when the loop
 * is parked AND every liveness counter except the thread one is zero. A process
 * waiting on something it started — a fetch, a child, a socket — holds one of those
 * counters, never announces, and is still reported. The exception is a nested worker,
 * which shares the thread counter; `hasUnwatchedChild` below is what covers it.
 *
 * The trade-off accepted, stated because it is real: a process that wedges while it
 * is genuinely parked stays unreported. That is a narrower hole than it sounds — with
 * nobody typing, an idle prompt and a prompt that would fail to respond are the same
 * thing to the user, and the moment anybody does type, a shell that cannot answer
 * stops echoing, which is a louder signal than this watchdog's. For a parked worker
 * the equivalent is that the thing which would hand it work is itself a process, and
 * that process is watched on its own terms.
 *
 * `unobservable` is the fourth case and the uncomfortable one, so here is the whole
 * argument rather than the conclusion. Some worker threads hand themselves to a
 * synchronous native call and never return to JS — a wasm pthread body, which is what
 * the rolldown pool behind every Vite 8 project does. Measured on the React template,
 * such a thread: answers no message (the worker's own message handler shares the
 * blocked thread), makes no syscall, never enters a JS Atomics.wait our runtime could
 * hook, and sits at 0% CPU in state S. Nothing inside it can announce anything,
 * because nothing inside it runs, and it is third-party code we cannot patch — the
 * installed `@napi-rs/wasm-runtime` deliberately wins over our vendored copy for
 * emnapi 2 (see module.js), which is every Vite 8 project.
 *
 * So for that thread the watchdog has no evidence at all, and what settles the
 * question is that this was ALREADY true: the old report fired whether the thread was
 * parked or wedged, identically, for as long as the process lived. A signal that does
 * not vary with the thing it claims to detect is not a detector, so switching it off
 * costs no detection. What it costs is still stated plainly: a worker thread that
 * wedges inside a native call is not reported under its own name.
 *
 * The condition is `a worker thread that has never printed anything`, and both halves
 * are doing work. "Has never printed" is not a proxy for idleness — it is the observation
 * that this process has never used the channel this watchdog measures, so "it has
 * printed nothing for 73s" is a statement about its whole existence rather than about
 * the last 73 seconds. A pool worker that logs `worker ready` at boot and then parks
 * is NOT covered by this; it is covered by `awaiting`, which is why both exist.
 * "Worker thread" is the other half because nobody launched it: its name answers no
 * question the user asked, and a main process silent inside a long synchronous call is
 * exactly what this watchdog was built for (npm's reify writes ~12k files with the
 * terminal dead) and stays reported.
 *
 * `hasUnwatchedChild` IS THE PRICE OF `unobservable`, and the two have to move
 * together or they leave a hole between them. Two of the excuses above are
 * DELEGATIONS — "do not report me, the thing that matters is watched elsewhere",
 * under the child's own name for `hasLiveChild`, by whoever will hand out the work
 * for `awaiting`. The other two claim something different and are untouched by this:
 * `serving` says this silence is a server's normal state, and `unobservable` says
 * nobody is watching this process at all, which is the opposite of delegating to
 * someone who is. Dropping a process from watching falsifies the delegating premise
 * for its parent, so a parent holding an unwatched child does not merely fail to be
 * excused by it, it LOSES the two excuses that rested on that premise.
 *
 * The first version of this required only that SOME child was watched, and review
 * found the state that breaks it — the exact state this change was written for. A
 * rolldown pool with one wasm-wedged thread beside healthy parked siblings: the wedged
 * thread excused as unobservable, the siblings excused as awaiting, the parent excused
 * because a sibling was still watched. The wedge was reported nowhere, having been
 * reported before the change. "Some child is watched" does not imply "the wedged one
 * is", and one unwatched child is one place a wedge can hide.
 *
 * It revokes `awaiting` and not just `hasLiveChild` because the same hole exists one
 * level down: a worker that spawns its own worker, parks waiting on it, and announces
 * `work` would be excused while the thing it waits on is unwatched. Both are the same
 * sentence — "somebody else is watching" — so both are void when nobody is.
 *
 * What it does NOT revoke is `serving`, and that is deliberate: revoking it would
 * report every idle dev server holding a wasm pool, which is the bug this whole change
 * started from. The price of sparing it has to be stated exactly, because it is
 * narrower than it first reads. Where the wedge is ON THE REQUEST PATH, requests queue
 * behind it and `pendingRequests` reports the server by the rule at the top of this
 * function. Where it is not — pre-bundling, a watcher-triggered rebuild, any pool work
 * with nothing waiting on it — nothing queues, and a serving parent stays quiet for as
 * long as it holds its port. That is not hypothetical: `Failed to run dependency scan`
 * is exactly pre-bundling work with no request behind it.
 *
 * So the guarantee is conditional, and saying it unconditionally would be the same
 * mistake as the "first install" sentence this change deleted. It reaches ONE LEVEL,
 * because `hasUnwatchedChild` is computed over direct children: an unwatched wedge
 * surfaces at its direct parent — as silence if that parent is idle, as a request
 * backlog if that parent is serving and the wedge blocks a request. It travels further
 * only while every process in between is itself unwatched, which is the nested-worker
 * case and not the common one.
 *
 * "The nearest non-serving ancestor" would be the comfortable thing to write here and
 * it is false, measured on the tree this paragraph is about. Under `vite` — spared by
 * `serving`, holding a pool of unwatched threads — the next process up is the shell
 * that launched it, and `vite` has printed, so it is a WATCHED child that excuses that
 * shell by `hasLiveChild`. The revocation does not travel past a watched process. So
 * under a serving parent a wedge in the pool surfaces nowhere in the silence channel
 * at all, and the request backlog is the only path left.
 *
 * The cost is not incidental, which is the other thing worth being exact about. It
 * reads like a corner case — a process that "happens to" hold an unobservable thread —
 * and measured on the shipped React template it is the norm: EVERY one of vite's
 * `wasi-worker.mjs` threads has never printed, so `hasUnwatchedChild` is true for
 * `vite` permanently, not during a wedge. `vite` itself is spared by `serving`, but a
 * NON-serving host of the same pool — `vite build`, `vitest run` — permanently loses
 * both delegating excuses and is reportable on any silent stretch past the threshold,
 * where before this change `hasLiveChild` excused it. That is a real re-admission of
 * the pre-existing false-positive shape, for a whole class of commands rather than an
 * unlucky one, and it is still the right side to fail on: the rule that avoided it was
 * silently losing wedges.
 */
export function shouldReportStall({
  serving,
  pendingRequests = 0,
  hasLiveChild = false,
  awaiting = null,
  unobservable = false,
  hasUnwatchedChild = false,
}) {
  // The two excuses that delegate to somebody else are void when there is somebody
  // this watchdog is no longer watching. Written as a revocation of the inputs rather
  // than as extra terms below, because that is what it is: the claims are unchanged
  // and the ground for believing them has gone.
  if (hasUnwatchedChild) {
    hasLiveChild = false;
    awaiting = null;
  }
  // One rule for all three excuses, so "somebody is waiting on this pid" always wins.
  // A worker thread cannot hold a port, so this can only matter for the other two —
  // it is written once rather than three times to keep that invariant visible.
  if ((hasLiveChild || awaiting || unobservable) && pendingRequests === 0) return false;
  return !serving || pendingRequests > 0;
}

/**
 * Is this a process the watchdog has stopped watching?
 *
 * Exported rather than written where it is used, because it is read in three places
 * that MUST agree — the suppression itself, the `hasLiveChild` rule that compensates
 * for it, and the gates. Three copies is how a change to the rule leaves the gates
 * green while they assert the old one, which is what review found here.
 *
 * `isThread` alone is not the condition. `child_process.fork` rides the same spawn
 * path and is marked `isThread` on the wire, but a fork child is a normal main-thread
 * process that user code launched by module path — "nobody launched it" is false for
 * one, and silencing it would hide a fork that wedges before its first write. The
 * kernel resolves that before it stores the flag (see `createProcess`), the same way
 * `runtime/boot.js` does; this predicate reads the resolved fact.
 */
export function isUnobservable(proc) {
  return !!proc && !!proc.isThread && !proc.everOutput;
}

/**
 * The decision above, computed from kernel state.
 *
 * This exists because the inputs are the hard part, not the predicate: which pids
 * count as serving, which children still count, and which flag is read from where.
 * That was written out once in the kernel worker and copied into a spike, so the
 * end-to-end gate asserted the copy and would have stayed green through a change to
 * the original. It reads only the three maps named here, so anything holding those —
 * the browser kernel worker, a spike harness — gets the same answer.
 *
 * `kernel` is `{ procs, listeners, pendingHttp }`.
 */
export function shouldReportStallFor(kernel, pid) {
  const parentOf = new Map();
  for (const [cpid, proc] of kernel.procs) parentOf.set(cpid, proc.parentPid ?? 0);

  // A process that has bound a port got where it was going, and so did the shell
  // blocked waiting on it.
  const serving = servingPids(kernel.listeners, parentOf).has(pid);

  // …unless requests are waiting on it, which is the one case where a silent server
  // is worth interrupting somebody about.
  let pendingRequests = 0;
  for (const [, pend] of kernel.pendingHttp) if (pend.pid === pid) pendingRequests++;

  // Counted separately rather than as one boolean: "somebody is watching my children"
  // and "there is a child nobody is watching" are different facts, and the second one
  // revokes rather than grants. See shouldReportStall for the pool state that proved
  // they cannot be folded together.
  let hasLiveChild = false;
  let hasUnwatchedChild = false;
  for (const [cpid, parent] of parentOf) {
    if (parent !== pid || cpid === pid) continue;
    const child = kernel.procs.get(cpid);
    if (!child || child.finalized) continue;
    if (isUnobservable(child)) hasUnwatchedChild = true;
    else hasLiveChild = true;
  }

  const proc = kernel.procs.get(pid);
  return shouldReportStall({
    serving,
    pendingRequests,
    hasLiveChild,
    hasUnwatchedChild,
    awaiting: proc?.awaiting ?? null,
    unobservable: isUnobservable(proc),
  });
}

/**
 * Why a process has printed nothing for a while.
 *
 * `ports` are the ports this pid is listening on, `grew` the VFS files added
 * since the last check (null if unknown), `idleMs` how long since its last
 * syscall.
 *
 * `grew === null` means THERE IS NO PREVIOUS SAMPLE, and it used to fall through to
 * "a first install downloads and writes a lot". That reads as a finding and is
 * actually a default: the baseline is taken when a report is rendered, so the first
 * report about any pid necessarily has nothing to compare against, and the sentence
 * was printed whether or not an install existed. A user watching four rolldown
 * worker threads was told each of them was probably a first install, seventy seconds
 * after `npm install` had exited 0 — about processes that had not been alive while
 * it ran. Wrong advice is worse than no advice, because it sends the reader to look
 * at the wrong thing, and it is the sentence a reader trusts most: it is the one
 * that claims to know what the process is doing.
 *
 * So an unknown now says it is unknown, and the two cases that were hiding inside
 * that default are separated — no baseline yet, versus a baseline that showed
 * nothing but a process still making syscalls.
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
  // A baseline exists and showed no meaningful growth, but the process made a
  // syscall in the last few seconds: it is doing something that is not writing
  // files. That is a different state from the one above and worth saying plainly,
  // rather than sharing a sentence with it.
  if (grew !== null) {
    return (
      `It is not writing files (${n(files)} in the VFS, unchanged), but it made a ` +
      `syscall ${Math.round(idleMs / 1000)}s ago, so it is doing something. Watch ` +
      `whether the next check shows progress.`
    );
  }
  // No baseline: this is the first report about this process. Say that, and say
  // what will settle it, instead of naming a cause nothing here has evidence for.
  return (
    `This is the first check on it, so there is nothing to compare against yet` +
    (files !== null ? ` (${n(files)} files in the VFS)` : "") +
    ". The next check will say whether it is making progress or standing still."
  );
}