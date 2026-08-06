// The shared watch kit — restart-on-change, as guest source, so that `node --watch`
// and `bun --watch` are one supervisor rather than two.
//
// WHY THIS IS A STRING AND NOT A MODULE: the same reason programs/repl-kit.js is one.
// Everything in programs/ is embedded into a program's source (coreutils.js installs
// each as /bin/<name>.js), and a guest program cannot `import` from packages/runtime,
// so a shared piece is shared as text the consumer concatenates. Append it, don't
// prepend it: `createWatcher` is a function DECLARATION, so it hoists, and appending
// keeps the consumer's own 'use strict' first in the file where a directive prologue
// has to be.
//
// WHAT A SUPERVISOR IS HERE. It respawns the program as a CHILD and watches files;
// it does not try to reload modules inside its own process. That is the difference
// between --watch and Bun's --hot, and it is why --hot is honest about being the
// former (see the note in bun.js): a soft reload has to keep globals and open
// sockets alive across the swap, and doing it by restart while calling it --hot would
// be a lie about the one property that distinguishes them.
//
// WHAT IT WATCHES. Node watches every file the program LOADED, which we cannot know
// from outside it. So it watches directories instead: the entry's own directory,
// recursively, plus anything --watch-path asked for. Recursive fs.watch is real here
// (Vite's chokidar depends on it), so this is not aspirational. node_modules and .git
// are ignored on the change side rather than the watch side, because a recursive
// watch cannot exclude a subtree and an install would otherwise restart the program
// once per extracted file.
//
// WHY THE DEBOUNCE IS NOT OPTIONAL. One save is several fs events — a write, a
// truncate, a rename from an editor's atomic-save temp file — and a build tool
// touching a directory produces dozens. Without a debounce the program is killed
// mid-boot by the next event and never reaches a running state at all.

export const WATCH_KIT_SRC = `
// ---- shared watch kit (packages/kernel-host/programs/watch-kit.js) ------------
//
// createWatcher(config) takes over the process: it never returns. Config:
//   argv     [command, ...args] to respawn on every run
//   label    what the banners name, e.g. 'app.js' (node quotes it; bun does not)
//   paths    files or directories to watch
//   explicitPaths  true when the user NAMED them (--watch-path), which turns off the
//                  source-extension filter — see isNoise
//   onRunEnd (code) => void   banner after a run finishes, or null for silence
//   onRestart () => void      banner before a restart, or null for silence
//   clear    true to clear the screen before each rerun
function createWatcher(config) {
  const fs = require('fs');
  const path = require('path');
  const cp = require('child_process');

  const argv = config.argv;
  const paths = config.paths || [];
  const onRunEnd = config.onRunEnd || null;
  const onRestart = config.onRestart || null;

  let child = null;
  let restartTimer = null;
  let restarting = false;
  let killTimer = null;
  // For the loop breaker (see isNoise): when the current child started, and how many
  // restarts in a row have been triggered by a child that barely got going.
  let childStartedAt = 0;
  let rapidRestarts = 0;
  let changedDuringRun = false;
  let warnedAboutLoop = false;
  let stopped = false;
  const KILL_GRACE_MS = 2000;
  // A change that arrives while the program is still in its first RAPID_MS is correlated
  // with the program having written it. RAPID_LIMIT of those in a row is enough to start
  // spacing restarts out; MAX_BACKOFF_MS is where the spacing stops growing.
  const RAPID_MS = 1500;
  const RAPID_LIMIT = 5;
  const MAX_BACKOFF_MS = 30000;
  // A run that has already ended must not be announced twice, and a restart that
  // kills a live child must not announce that child's death as a completed run.
  let announced = false;

  // THE PROGRAM'S OWN OUTPUT IS IN THE WATCHED TREE. That is the price of watching
  // directories instead of the set of files the program actually loaded, and it is not
  // a small one: a script that writes a file — a codegen step, a log, a build writing
  // dist/ — retriggers itself, and each retrigger is a fresh Web Worker. Measured
  // before this filter: 17 runs and 16 restarts in six seconds, not converging.
  //
  // Three defences, because no one of them is enough on its own:
  //
  //   1. only SOURCE extensions restart. Fixes the ordinary case (out.txt, a log, a
  //      .map, a snapshot) and costs nothing, since a change to a file the runtime
  //      cannot load is not a change to the program.
  //   2. build-output directories are ignored, the way every watcher ships with such
  //      a list. Fixes the case extension cannot: dist/bundle.js IS a source
  //      extension, and reacting to your own bundle is a loop with no fixed point.
  //   3. BACKOFF, below, for what 1 and 2 let through — they are heuristics about names,
  //      and a program can always write something they allow. It bounds the cost of a
  //      loop rather than ending it; nothing here can promise convergence, and the
  //      comment there says why.
  //
  // The extension half applies ONLY to the tree we inferred. --watch-path is the user
  // telling us what to watch, and second-guessing an explicit instruction is worse than
  // the loop it would prevent: '--watch-path ./locales' on a tree of .json, or ./src on
  // a tree with .graphql or .css in it, is a legitimate thing to ask for. The directory
  // and temp-file halves still apply either way — nobody means node_modules.
  const SOURCE_EXTS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.json', '.node'];
  const OUTPUT_DIRS = ['node_modules', '.git', '.cache', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache'];
  const filterByExtension = !config.explicitPaths;
  function isNoise(rel) {
    if (!rel) return false;
    const parts = String(rel).split('/');
    // An install writes thousands of files and a git command rewrites refs on every
    // operation, so these cannot be reacted to. They are filtered on the CHANGE side
    // because a recursive watch cannot exclude a subtree.
    for (const p of parts) {
      for (const d of OUTPUT_DIRS) if (p === d) return true;
    }
    const base = parts[parts.length - 1] || '';
    // Editors save through a temp file and rename it, so the temp write must not be a
    // restart of its own.
    if (base.charAt(base.length - 1) === '~') return true;
    if (base.slice(0, 2) === '.#') return true;
    if (!filterByExtension) return false;
    const dot = base.lastIndexOf('.');
    if (dot <= 0) return true; // no extension: not something the runtime can load
    const ext = base.slice(dot);
    for (const e of SOURCE_EXTS) if (ext === e) return false;
    return true;
  }

  function spawnChild() {
    announced = false;
    childStartedAt = Date.now();
    if (config.clear) process.stdout.write('\\x1b[2J\\x1b[H');
    // 'inherit' on stdin declares that the child HAS a terminal, and the forwarding
    // below is what makes that true. Declaring it alone was a lie of exactly the kind
    // the pipe-on-fd-0 fix went and removed one layer up: 'inherit' sets isTTY, it does
    // not connect a data path, and terminal input goes to the shell's foreground job —
    // which is the supervisor, not the child. So a watched program with a prompt said
    // it had a terminal and then never received a keystroke.
    child = cp.spawn(argv[0], argv.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    const mine = child;
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('exit', (code) => {
      if (mine !== child) return; // a child we already replaced
      child = null;
      // A child killed BY us is a restart, not a run that finished, so it gets no
      // completion banner. Node draws the same distinction.
      if (restarting || announced) return;
      announced = true;
      if (onRunEnd) onRunEnd(code == null ? 0 : code);
    });
  }

  // WAIT FOR IT TO ACTUALLY BE DEAD. This used to respawn after a flat 30ms, which is
  // fine only for a program that does not handle SIGTERM — the kernel finalizes those
  // synchronously. A graceful shutdown is how servers are normally written:
  //
  //   process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
  //
  // and for those the new child raced the old one for the port and lost, EVERY time:
  // 'Error: listen EADDRINUSE'. Which means --watch failed completely for exactly the
  // class of program people watch most.
  //
  // So the old child's 'exit' is the signal to proceed, with SIGKILL as the escalation
  // for one that will not go. A dead child cannot hold a port.
  function killChild(then) {
    if (!child) { if (then) then(); return; }
    const dying = child;
    child = null;
    let done = false;
    const proceed = () => {
      if (done) return;
      done = true;
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      if (then) then();
    };
    dying.on('exit', proceed);
    try { dying.kill('SIGTERM'); } catch (e) { proceed(); return; }
    // A program that traps SIGTERM and takes its time still has to lose the port
    // eventually, or one slow shutdown wedges the watcher for good.
    killTimer = setTimeout(() => {
      try { dying.kill('SIGKILL'); } catch (e) {}
      // SIGKILL cannot be trapped, so 'exit' follows; this is only the backstop for a
      // child whose exit never reaches us at all.
      killTimer = setTimeout(proceed, 250);
    }, KILL_GRACE_MS);
  }

  function restart() {
    // A kill is already in flight, so DO NOT START A SECOND ONE. killChild sets 'child'
    // to null the moment it takes ownership of the dying child, which means a restart
    // arriving during the wait — two saves inside a couple of seconds, on a program that
    // handles SIGTERM — took killChild's 'if (!child)' exit, fired its callback at once,
    // and spawned a replacement while the old child was still alive. One logical restart
    // became two spawns: EADDRINUSE for a server, two copies running for anything else.
    //
    // Dropping the second restart loses nothing. The kill already in flight will
    // spawnChild() when the old child is gone, and that reads the file at THAT moment,
    // so the run it starts is of the newest content either way.
    if (restarting) return;
    restarting = true;
    if (onRestart) onRestart();
    killChild(() => { restarting = false; spawnChild(); });
  }

  // One save is several fs events, and a build tool touching a directory is dozens.
  // Without this the program is killed mid-boot by the next event and never reaches
  // a running state at all.
  function onChange(rel) {
    if (stopped || isNoise(rel)) return;
    // ASKED NOW, NOT LATER. Whether the run was still going when the change arrived is
    // the best available evidence about who wrote it, and it has to be read here: the
    // debounce below outlives a fast child, so a program that writes on boot and exits
    // looks long dead by the time the restart is decided. Measured: alive at arrival for
    // 7 of 7 self-written changes, and for 2 of 6 changes a person made.
    if (child && Date.now() - childStartedAt < RAPID_MS) changedDuringRun = true;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => { restartTimer = null; guardedRestart(); }, 120);
  }

  // BACKS THE LOOP OFF; it does not break it. This used to stop watching outright, and
  // that was wrong twice over: it killed sessions that were perfectly healthy (six saves
  // 600ms apart, to a program that wrote nothing at all) and it told the user the program
  // had written into its own tree — a diagnosis this code is in no position to make.
  // Nothing here knows who wrote a file. All it has is a correlation.
  //
  // So the response is proportional to the evidence. The harm of a self-feeding loop is
  // COST: a fresh Web Worker per iteration, unbounded, in a browser tab. Cost is bounded
  // by spacing the restarts out, doubling to a cap. A real loop decays to one run every
  // 30 seconds instead of seventeen in six; a healthy session misread as a loop loses a
  // second or two and recovers on its own, because the count resets as soon as a change
  // arrives with the program not running.
  //
  // What this deliberately does NOT claim is convergence. There is no fixed point to
  // reach — a self-writing program writes again on every run, so neither stopping the
  // watch nor slowing it down makes the loop finite, and one that writes two seconds in
  // never trips this at all. The three name-based defences narrow the ordinary shapes
  // (out.txt, dist/, a fast codegen step); this keeps the worst case cheap.
  function guardedRestart() {
    if (changedDuringRun) rapidRestarts++;
    else rapidRestarts = 0;
    changedDuringRun = false;
    const over = rapidRestarts - RAPID_LIMIT;
    if (over >= 0) {
      if (!warnedAboutLoop) {
        warnedAboutLoop = true;
        // Reports what was observed and leaves the cause to the reader, rather than
        // accusing the program of something it may not have done.
        process.stderr.write(
          'watch: ' + rapidRestarts + ' restarts triggered while the program was still' +
          ' running, so restarts are being spaced out. If it writes into the tree it is' +
          ' watched in, point --watch-path at your sources or send output to an ignored' +
          ' directory (dist, build, out).\\n');
      }
      restartTimer = setTimeout(() => { restartTimer = null; restart(); },
        Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, over)));
      return;
    }
    restart();
  }

  for (const p of paths) {
    let target = p;
    let recursive = true;
    try {
      // Watch a file's DIRECTORY rather than the file: an editor that saves through
      // a temp file and renames it replaces the inode, and a watch on the old one
      // then reports nothing ever again.
      const st = fs.statSync(p);
      if (!st.isDirectory()) { target = path.dirname(p); }
    } catch (e) {
      target = path.dirname(p);
    }
    try {
      fs.watch(target, { recursive: recursive }, (_event, filename) => onChange(filename));
    } catch (e) {
      process.stderr.write('watch: cannot watch ' + target + ': ' + ((e && e.code) || (e && e.message) || e) + '\\n');
    }
  }

  // Keystrokes reach the SUPERVISOR, because it is the shell's foreground job. Relay
  // them to whichever child is current, so the 'inherit' declared above is true and a
  // watched program that prompts can be answered. Attached once, not per child: the
  // relay reads 'child' at delivery time, so a restart does not need to rewire it.
  try {
    process.stdin.on('data', (d) => {
      if (child && child.stdin && child.stdin.write) {
        try { child.stdin.write(d); } catch (e) {}
      }
    });
    process.stdin.resume();
    // The supervisor's own stdin must not be what keeps the process alive — the child
    // and the watches do that — or a --watch session could not end on its own.
    if (process.stdin.unref) process.stdin.unref();
  } catch (e) {}

  // Ctrl+C ends the SUPERVISOR, and takes the child with it. Without this the
  // kernel kills us and leaves the child running with nothing reading its output.
  try {
    process.on('SIGINT', () => {
      stopped = true;
      killChild(() => process.exit(130));
      if (globalThis.__ocSignalHandled) globalThis.__ocSignalHandled('SIGINT');
      // Do not wait forever for a child that traps SIGTERM: the user asked to stop.
      setTimeout(() => process.exit(130), KILL_GRACE_MS + 300);
    });
  } catch (e) {}

  spawnChild();
}
`;
