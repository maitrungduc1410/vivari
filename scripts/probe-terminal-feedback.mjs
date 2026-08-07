// Probe (offline, no Wasm, no kernel): the terminal's two guesses about a quiet
// process.
//
// Both were wrong for the same shape of program — one that installs, binds a
// port, and then serves requests without printing. The fetch spinner kept the
// install's running totals and folded the app's own traffic into them, so a
// working S3 app read as "fetching · 222 requests · 38.7 MB" that never ended;
// and the stall reporter blamed "a first install" for a server that had finished
// installing minutes earlier.
//
// This half of the kernel worker only exists in a browser, so the judgement is
// pure functions in packages/core/terminal-feedback.js and asserted here — the
// only kind of test that can catch it without a tab.
//
// Run: node scripts/probe-terminal-feedback.mjs

import {
  newProgress,
  onFetch,
  onOutput,
  idleClear,
  stallVerdict,
  servingPids,
  shouldReportStall,
  isUnobservable,
  stallReportChunk,
} from "../packages/core/terminal-feedback.js";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};
const countIn = (line) => {
  const m = /· (\d+) requests · ([\d.]+) MB/.exec(line || "");
  return m ? { count: Number(m[1]), mb: Number(m[2]) } : null;
};

console.log("\n── the spinner only appears for something that looks like an install ──");
{
  const s = newProgress();
  let t = 0;
  let last = null;
  // An install: 104 packages, ~30 MB, fetches arriving continuously.
  for (let i = 0; i < 104; i++) last = onFetch(s, 300_000, (t += 100)) || last;
  const install = countIn(last);
  check("an install draws a line", install !== null);
  check("counting the whole burst", install && install.count === 104, `${install && install.count} requests`);

  // npm prints "added 104 packages", the server prints "listening on :3000".
  check("printing real output clears the spinner", onOutput(s) !== null);

  // The case that looked like a stuck download: the counters used to carry the
  // install's 104 requests forever.
  let appLine = null;
  for (let i = 0; i < 20; i++) appLine = onFetch(s, 1_000_000, (t += 100)) || appLine;
  const app = countIn(appLine);
  check("later traffic starts counting from zero", app && app.count === 20, `${app && app.count} requests`);
  check("and carries none of the install's bytes", app && app.mb < 21, `${app && app.mb} MB`);
}

console.log("\n── one click is not a download ──");
{
  // Clicking Connect in the preview makes a single request. Drawing a progress
  // line for it flashes a spinner at somebody who never asked whether anything
  // was frozen.
  const s = newProgress();
  let t = 5000;
  check("a single request draws nothing", onFetch(s, 4_000, t) === null);
  check("nothing to clear afterwards", idleClear(s, t + 2000) === null);

  // Six clicks, seconds apart. Each is its own burst, so they must not add up
  // into a spinner for a click that made one request.
  const clicks = newProgress();
  let drew = false;
  for (let i = 0; i < 6; i++) {
    t += 4000;
    if (onFetch(clicks, 4_000, t)) drew = true;
    idleClear(clicks, t + 2000);
  }
  check("six clicks, seconds apart, still draw nothing", !drew);
}

console.log("\n── a spinner nobody is feeding goes away ──");
{
  const s = newProgress();
  let t = 1000;
  // Build a real burst first, so there is something on screen to strand.
  let drawn = null;
  for (let i = 0; i < 12; i++) drawn = onFetch(s, 200_000, (t += 100)) || drawn;
  check("the burst is on screen", drawn !== null && s.active);

  check("stays while fetches keep arriving", idleClear(s, (t += 1400)) === null);
  onFetch(s, 200_000, t);
  check("still stays — the deadline moves with the traffic", idleClear(s, (t += 1400)) === null);
  check("clears once the traffic stops", idleClear(s, (t += 1600)) !== null);
  check("and does not clear twice", idleClear(s, (t += 5000)) === null);
}

console.log("\n── the stall verdict ──");
{
  const installing = stallVerdict({ grew: 12_000, files: 40_000, idleMs: 200, ports: [] });
  check("a growing filesystem is reported as progress", /still working/.test(installing));

  // The report the user actually got: a server that had been serving for minutes.
  const serving = stallVerdict({ grew: 0, files: 7_129, idleMs: 300, ports: [3000] });
  check("a listening, active process is called a server", /listening on :3000/.test(serving), serving.slice(0, 72) + "…");
  check("…and is not blamed on an install", !/first install/.test(serving));

  // An idle server and a wedged one look identical from the kernel — both hold a
  // port and make no syscalls. Whether anyone is waiting is the difference.
  check("an idle server is not reported at all",
    !shouldReportStall({ serving: true, pendingRequests: 0 }));
  check("a server with requests waiting is",
    shouldReportStall({ serving: true, pendingRequests: 3 }));
  check("an install is always reported",
    shouldReportStall({ serving: false, pendingRequests: 0 }));

  // The report a user got out of the notebook template: `PID 2 (sh) has printed
  // nothing for 139s … it looks stuck rather than slow`, about a shell whose python
  // was fetching wheels. A shell waiting on a child is silent because waiting is
  // what it does, and the child is watched under its own name.
  check("a shell waiting on a live child is not reported",
    !shouldReportStall({ serving: false, pendingRequests: 0, hasLiveChild: true }));
  check("…but the child itself still is",
    shouldReportStall({ serving: false, pendingRequests: 0, hasLiveChild: false }));
  check("…and a parent with requests waiting on it is not excused",
    shouldReportStall({ serving: true, pendingRequests: 2, hasLiveChild: true }));

  // The SAME report, from the same user on the same template, after the warmup
  // finished: the shell went back to its prompt and was reported for waiting on a
  // person instead of on a child. The fix above covered one kind of waiting, so the
  // class came back wearing the other.
  check("a shell parked at its prompt is not reported either",
    !shouldReportStall({ serving: false, pendingRequests: 0, awaiting: "input" }));
  // The half that a "terminal and no live child means it must be at a prompt" rule
  // could not have given us: silence alone still buys nothing.
  check("…but a silent shell that has NOT said it is waiting still is",
    shouldReportStall({ serving: false, pendingRequests: 0, awaiting: null }));
  check("…and the announcement does not excuse a process with requests waiting on it",
    shouldReportStall({ serving: true, pendingRequests: 1, awaiting: "input" }));

  // Third time, third kind of waiting: the React template's dev server spawns
  // rolldown worker threads that park on their parentPort, and a user watched four of
  // them accused of being stuck while the server was serving. The parameter carries a
  // REASON rather than being a second boolean, which is what these two checks are
  // really about — one mechanism, extended, not a parallel one.
  check("a worker parked waiting for a job is not reported",
    !shouldReportStall({ serving: false, pendingRequests: 0, awaiting: "work" }));
  check("…and a worker that has not said so still is",
    shouldReportStall({ serving: false, pendingRequests: 0, awaiting: null }));

  // The threads that cannot announce anything, because they handed themselves to a
  // synchronous native call and no JS of theirs runs. `unobservable` is where that is
  // decided; see terminal-feedback.js for why silence beats a guess, and why the
  // paired change to hasLiveChild has to move with it.
  check("a worker thread that has never printed anything is not reported",
    !shouldReportStall({ serving: false, pendingRequests: 0, unobservable: true }));
  check("…but requests waiting on a pid still beat every excuse there is",
    shouldReportStall({ serving: true, pendingRequests: 1, unobservable: true, awaiting: "work", hasLiveChild: true }));

  // The price of that rule, and the state review found it failing on. A rolldown pool
  // is MIXED — one wedged thread nobody can watch beside healthy parked siblings — and
  // every excuse in it holds at once: the wedged thread is unobservable, the siblings
  // are awaiting, and the parent has a watched child. If the parent keeps its excuse
  // there, the wedge is reported nowhere, and it WAS reported before this change.
  check("a parent holding an unwatched child loses the excuse its watched children gave it",
    shouldReportStall({ serving: false, pendingRequests: 0, hasLiveChild: true, hasUnwatchedChild: true }));
  check("…and loses its own announcement too, since that delegates the same way",
    shouldReportStall({ serving: false, pendingRequests: 0, awaiting: "work", hasUnwatchedChild: true }));
  check("…but keeps it while every child is watched, or this is just a mute switch in reverse",
    !shouldReportStall({ serving: false, pendingRequests: 0, hasLiveChild: true, hasUnwatchedChild: false }));
  // Not revoked by an unwatched child, and deliberately: a server has a louder signal
  // available than silence. If its pool is wedged, requests queue and the rule at the
  // top reports it — which is the case immediately below.
  check("a serving parent is not reported merely for holding an unwatched child",
    !shouldReportStall({ serving: true, pendingRequests: 0, hasUnwatchedChild: true }));
  check("…and IS reported once requests start queueing behind it",
    shouldReportStall({ serving: true, pendingRequests: 2, hasUnwatchedChild: true }));

  // Who the rule above actually applies to. `isUnobservable` is exported and shared
  // rather than written at each of its three call sites, because the suppression, the
  // revocation that compensates for it, and the gates all have to mean the same thing
  // by it — three copies is how production changes and the gates keep passing.
  check("a thread that has never printed is unobservable", isUnobservable({ isThread: true, everOutput: false }));
  check("…but one that has printed is not", !isUnobservable({ isThread: true, everOutput: true }));
  check("…and a plain process that has never printed is not either",
    !isUnobservable({ isThread: false, everOutput: false }));
  // This predicate does not look at `isFork` AT ALL, which is the point of the check
  // below and the reason it is worded that way. A fork child rides the thread spawn
  // path and arrives flagged `isThread` on the wire; the kernel resolves that away
  // before storing it (createProcess), the same way runtime/boot.js does. So the
  // division of labour is: the kernel decides what a fork is, this reads the decision.
  //
  // An earlier version of this check passed `isFork: true` under a name claiming forks
  // were exempt. Nothing here reads that field, so it asserted only `isThread: false`
  // and would have stayed green with the kernel-side resolution deleted — a check whose
  // name claimed more than it tested, which is the defect this whole change keeps
  // finding. What actually gates the resolution is spike-diag-liveness, with a real
  // fork; what is gated here is that a stray `isFork` cannot rescue a process this
  // predicate has already been told is a thread.
  check("isFork is not consulted here — a thread flagged as a fork is still a thread",
    isUnobservable({ isThread: true, isFork: true, everOutput: false }));
  check("…so the exemption has to arrive already resolved, as isThread: false",
    !isUnobservable({ isThread: false, isFork: true, everOutput: false }));
  check("…and nothing at all is not unobservable", !isUnobservable(undefined));

  const wedged = stallVerdict({ grew: 0, files: 7_129, idleMs: 30_000, ports: [3000], pendingRequests: 3 });
  check("and is told it is stuck inside a handler", /3 requests waiting/.test(wedged) && /stuck inside a handler/.test(wedged));

  // `grew: null` is the FIRST report about a pid — the baseline is taken when a report
  // renders, so there has never been anything to compare against. That fell through to
  // "a first install downloads and writes a lot", which reads as a finding and was
  // actually a default: the user got it about four rolldown worker threads, seventy
  // seconds after `npm install` had exited 0, about processes that had not existed
  // while it ran. The sentence a reader trusts most is the one claiming to know what
  // the process is doing, so it has to be one this function can actually support.
  const unknown = stallVerdict({ grew: null, files: 500, idleMs: 100, ports: [] });
  check("a first report does not invent an install to blame", !/install/.test(unknown), unknown);
  check("…it says there is no baseline yet", /first check/.test(unknown) && /nothing to compare/.test(unknown));
  check("…and says what would settle it", /next check/.test(unknown));

  // The other half of what that default was hiding: a baseline exists, nothing grew,
  // but the process made a syscall seconds ago. That is a different state from "no
  // syscall for 148s" and now says so instead of sharing a sentence with the unknown.
  const busyQuiet = stallVerdict({ grew: 1, files: 40_000, idleMs: 900, ports: [] });
  check("a process with a recent syscall is not called stuck", !/stuck/.test(busyQuiet) && /doing something/.test(busyQuiet));
  check("…nor blamed on an install either", !/install/.test(busyQuiet), busyQuiet);
}

console.log("\n── a stall report does not erase what it did not write ──");
{
  // The evidence for this one is the byte stream, so this applies the bytes to a
  // terminal rather than pattern-matching the escape. Enough of a VT to be honest
  // about the two sequences involved: \r homes the cursor, \x1b[2K erases the
  // current line, \n opens a new one, text overwrites from the cursor.
  const feed = (screen, chunk) => {
    let row = screen.length - 1;
    let col = screen[row].length;
    const put = (s) => {
      const l = screen[row].padEnd(col, " ");
      screen[row] = l.slice(0, col) + s + l.slice(col + s.length);
      col += s.length;
    };
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === "\r") { col = 0; continue; }
      if (chunk[i] === "\n") { screen.push(""); row = screen.length - 1; col = 0; continue; }
      if (chunk[i] === "\u001b") {
        const m = /^\u001b\[[0-9;]*[A-Za-z]/.exec(chunk.slice(i));
        if (m) { if (m[0] === "\u001b[2K") { screen[row] = ""; col = 0; } i += m[0].length - 1; continue; }
      }
      put(chunk[i]);
    }
    return screen;
  };

  const PROMPT = "notebook-py-app$ ";
  const REPORT = "  [runtime] PID 2 (sh) has printed nothing for 139s.";

  // What the user had on screen: a prompt, written with no trailing newline, so it
  // IS the current line. This is the exact report they lost it to.
  const withPrompt = feed([PROMPT], stallReportChunk(REPORT, { progressCleared: false }));
  check("a report under a prompt leaves the prompt on screen",
    withPrompt.some((l) => l.includes(PROMPT)), JSON.stringify(withPrompt));
  check("…and still shows the report", withPrompt.some((l) => l.includes(REPORT)));
  // Same guarantee, and the reason it is stated separately: the prompt is only the
  // commonest thing on that line. A half-typed command is user input, and losing it
  // is worse than losing a prompt the shell can redraw.
  const typing = feed([PROMPT + "python war"], stallReportChunk(REPORT, { progressCleared: false }));
  check("…and a half-typed command line survives it too",
    typing.some((l) => l.includes(PROMPT + "python war")), JSON.stringify(typing));

  // The case the erase was written for and is still right for: our own spinner.
  // clearProgress has already wiped it, so the report writes where it stood rather
  // than pushing a blank line in front of itself.
  const cleared = feed([""], stallReportChunk(REPORT, { progressCleared: true }));
  check("after clearing our own spinner the report needs no new line",
    cleared[0].includes(REPORT), JSON.stringify(cleared));
}

console.log("\n── a server is not a stalled process ──");
{
  // The shape on screen: `npm install && node src/server.js`. PID 1 is the
  // terminal's shell, PID 2 the sh running the command line, PID 4 the server
  // holding :3000. Reporting any of them every 75s is noise about a program
  // doing exactly what it was asked to do.
  const listeners = new Map([[3000, 4]]);
  const parentOf = new Map([[4, 2], [2, 1], [1, 0]]);
  const serving = servingPids(listeners, parentOf);
  check("the process holding the port is serving", serving.has(4));
  check("so is the shell blocked waiting on it", serving.has(2), "PID 2 (sh)");
  check("and the terminal's own shell", serving.has(1));

  // An install in another terminal is still worth reporting.
  check("an unrelated process is not", !serving.has(9));
  check("no ports means nobody is serving", servingPids(new Map(), parentOf).size === 0);

  // A parent cycle must not hang the walk.
  const cyclic = servingPids(new Map([[80, 5]]), new Map([[5, 6], [6, 5]]));
  check("a parent cycle terminates", cyclic.has(5) && cyclic.has(6));
}

console.log("\n── 'still working' has to mean something ──");
{
  // What the user was told about an idle server: one file appeared, and the
  // terminal called it an install in progress.
  const oneFile = stallVerdict({ grew: 1, files: 7_125, idleMs: 90_000, ports: [] });
  check("one new file is not 'still working'", !/still working/.test(oneFile), oneFile.slice(0, 60) + "…");
  check("…it reads as stuck instead", /looks stuck/.test(oneFile));

  const realInstall = stallVerdict({ grew: 4_000, files: 40_000, idleMs: 200, ports: [] });
  check("thousands of files still is", /still working/.test(realInstall));
}

console.log(
  failed === 0
    ? "\nRESULT: PASS — the terminal describes a serving process as serving"
    : `\nRESULT: FAIL — ${failed} check(s) failed`,
);
process.exit(failed === 0 ? 0 : 1);