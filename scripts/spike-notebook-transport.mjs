// Spike (NET, because it needs the vendored interpreter): the notebook's
// TRANSPORT — the launch string, the shell, the read loop and the frames back —
// driven end to end instead of asserted layer by layer.
//
// WHY THIS FILE EXISTS. Three rounds of "the user pressed Run and nothing
// happened" shipped behind a green suite, and each time the suite was green for
// the same reason: everything AROUND the transport was tested and the transport
// itself was not. `spike-notebook.mjs` runs the kernel program under the host's
// CPython with `spawnSync(python3, [kernel.py], {input})` — no shell, no
// launcher, no runtime, no driver. `spike-notebook-view.mjs` renders the cells
// under jsdom — no kernel at all. `spike-python-bridge.mjs` execs a cell in real
// Pyodide from a namespace it builds itself — no launch string. Between them
// they cover both ends of a wire that nothing ran a byte down.
//
// So this one starts from the string `studio-kernel.ts` types and requires the
// answer to come back:
//
//     sh (packages/kernel-host/coreutils.js, interactive)
//       -> python --vv-notebook-kernel /tmp/vv-notebook-kernel.py; exit
//         -> PYTHON_PROGRAM (packages/kernel-host/programs/python.js)
//           -> createPythonRuntime(...).notebookKernel -> runSource -> driveNotebook
//             -> real Pyodide -> NB_KERNEL_PY (kernel-source.js)
//       <- \x1e-framed JSON on stdout
//     <- FrameReader / NotebookSession (session.js) -> NotebookDoc (doc.js)
//
// The launch string is READ OUT OF studio-kernel.ts rather than retyped, so a
// change to what the studio sends changes what this runs.
//
// WHAT IS REAL AND WHAT IS NOT — the line this file must not blur. Real: the
// shell source, the launcher, the runtime, the driver, the interpreter, the
// kernel program, the frame protocol, the session and the document. Substituted:
// the VM itself. The shell runs as a host Node process, so a foreground child is
// a host `child_process` and its stdin is an OS pipe rather than OP_SPAWN and a
// SharedArrayBuffer (see scripts/lib/notebook-python-child.mjs for the blocking
// read that keeps the shape). Not covered, therefore, and still needing a
// browser: `bridge.post("term-input")` reaching the kernel worker,
// `kernel.sendStdin` choosing between a parked sync reader and the flowing
// stream, and the click that calls `session.run`.
//
//   run:  node scripts/spike-notebook-transport.mjs
//         node scripts/spike-notebook-transport.mjs --only=cell,exit
//   needs: npm run vendor:pyodide
//
// Every case boots a real interpreter, so the whole file is minutes, not seconds
// — hence the section filter. It is a spike and not a test for exactly that
// reason; `npm run spikes` is where the slow, real-dependency checks live.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { COREUTILS } from "../packages/kernel-host/coreutils.js";
import { NB_KERNEL_PY, NB_KERNEL_PATH } from "../packages/studio/src/vv/notebook/kernel-source.js";
import { NotebookSession } from "../packages/studio/src/vv/notebook/session.js";
import { NotebookDoc } from "../packages/studio/src/vv/notebook/doc.js";
import { newCell } from "../packages/studio/src/vv/notebook/ipynb.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PYODIDE_DIR = path.join(ROOT, "packages/studio/public/vendor/pyodide");
const CHILD = path.join(ROOT, "scripts/lib/notebook-python-child.mjs");

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
};
const eq = (got, want, msg) =>
  ok(got === want, `${msg}${got === want ? "" : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);

// The command the studio types, taken from the source that types it. A template
// literal with one interpolation, which is the only thing this has to resolve —
// if it grows another, the assertion below fails rather than this guessing.
function studioLaunchCommand() {
  const src = fs.readFileSync(path.join(ROOT, "packages/studio/src/vv/notebook/studio-kernel.ts"), "utf8");
  const m = /export const KERNEL_COMMAND = `([^`]*)`/.exec(src);
  if (!m) throw new Error("studio-kernel.ts no longer declares KERNEL_COMMAND as a template literal");
  const resolved = m[1].replaceAll("${NB_KERNEL_PATH}", NB_KERNEL_PATH);
  if (resolved.includes("${")) throw new Error(`KERNEL_COMMAND has an interpolation this spike cannot resolve: ${m[1]}`);
  return resolved;
}

/**
 * Boot a kernel the way the studio does and run cells through it.
 *
 * @param {object} opts
 * @param {string} opts.command        what to type at the shell
 * @param {{id:string,source:string}[]} opts.cells  run in order, one at a time
 * @param {number} [opts.timeoutMs]
 * @param {(ctx: {session: NotebookSession, write: (s: string) => void}) => void} [opts.thenKill]
 *        run once the cells are done, INSTEAD of a clean shutdown: for the cases
 *        that ask what the shell and the session do when the interpreter goes
 *        away without the session having asked it to.
 * @param {{id:string,source:string}[]} [opts.thenRun]
 *        cells to run once the first batch has settled. Interrupting abandons the
 *        queue by design, so a case about what SURVIVES an interrupt cannot put the
 *        cell that checks it in the same batch.
 * @param {(ctx: {session: NotebookSession, write: (s: string) => void}) => void} [opts.onLoading]
 *        fired once, on the first `loading` frame — i.e. inside the window where the
 *        driver is fetching a cell's wheels and the interpreter is not running. That
 *        window is where an interrupt used to kill the kernel, and it is the only
 *        place a test can stand to see it.
 * @returns {Promise<{why:string, shellExit:number|null, info:object|null,
 *                    loading:string[], session:NotebookSession, doc:NotebookDoc,
 *                    raw:string}>}
 *   `why` is `cells-done` for a run that ended the way it meant to (including
 *   the shell following a clean shutdown out), `kernel-gone` for a shell that
 *   exited on its own after `thenKill`, `timeout` for one that never did.
 */
/**
 * `stdio: ['inherit', …]` means two different things, and this tier runs the side
 * that means the wrong one.
 *
 * The shell says `['inherit','pipe','pipe']` when it spawns a foreground job, and
 * then forwards the terminal's bytes with `currentChild.stdin.write(…)`. In the
 * VM — `packages/runtime/builtins/child_process.js` — a ChildProcess ALWAYS has a
 * writable `stdin`, whatever `stdio` says; fd 0 only decides `stdinIsPipe`, which
 * is the child's answer to `isTTY`. On host Node the same word is literal fd
 * inheritance, so `child.stdin` is null, the forwarding line throws into its own
 * `catch`, and every byte the shell was holding for its child is dropped in
 * silence. Both measured, and both asserted below rather than described.
 *
 * So this preload makes host Node answer the way the VM answers: fd 0 back to a
 * pipe, everything else untouched. It is a MODEL of the kernel's rule, not a stub
 * of the shell — `sh` runs its own shipped bytes and its own forwarding path, and
 * the substitution is one line, in one place, named on the tier's list of
 * substitutions alongside the channel itself.
 */
const VM_STDIO_MODEL = `
const cp = require("child_process");
const real = cp.spawn;
cp.spawn = function (command, args, options) {
  if (options && Array.isArray(options.stdio) && options.stdio[0] === "inherit") {
    options = Object.assign({}, options, { stdio: ["pipe"].concat(options.stdio.slice(1)) });
  }
  return real.call(this, command, args, options);
};
`;

function runKernel({ command, cells = [], timeoutMs = 180000, thenKill = null, thenRun = [], onLoading = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-nbt-"));
  fs.writeFileSync(path.join(dir, "sh.js"), COREUTILS.sh);
  fs.writeFileSync(path.join(dir, "vm-stdio-model.cjs"), VM_STDIO_MODEL);
  // The kernel program goes where the launch string says it does, which is what
  // the studio's `vv-write` does in the VM.
  fs.mkdirSync(path.dirname(NB_KERNEL_PATH), { recursive: true });
  fs.writeFileSync(NB_KERNEL_PATH, NB_KERNEL_PY);
  // `python` on PATH, so the shell resolves it by name exactly as it resolves
  // /bin/python.js in the VM.
  fs.writeFileSync(path.join(dir, "python"), `#!/bin/sh\nexec ${process.execPath} ${CHILD} "$@"\n`);
  fs.chmodSync(path.join(dir, "python"), 0o755);

  return new Promise((resolve) => {
    const sh = spawn(process.execPath, ["--require", path.join(dir, "vm-stdio-model.cjs"), path.join(dir, "sh.js")], {
      cwd: dir,
      env: { ...process.env, PATH: dir + ":" + process.env.PATH, VV_PYODIDE_INDEX_URL: PYODIDE_DIR + "/" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const doc = new NotebookDoc();
    doc.nb.cells = [...cells, ...thenRun].map((c) => {
      const cell = newCell("code", c.source);
      cell.id = c.id;
      return cell;
    });
    const sent = [];
    const io = {
      launch() {},
      stop() {
        try {
          sh.stdin.end();
        } catch {
          /* already gone */
        }
      },
      interrupt() {
        sh.stdin.write("\x03");
      },
      send(line) {
        sent.push(line);
        sh.stdin.write(line + "\n");
      },
    };
    // The document's own sink, plus a tap: `loading` is transient by contract
    // (session.js) — the document shows it and drops it — so the only way to
    // assert the driver fetched a wheel BEFORE the exec is to watch it go past.
    const loading = [];
    const base = doc.sink();
    let firedOnLoading = false;
    const sink = {
      ...base,
      onLoading: (id, text) => {
        loading.push(text);
        base.onLoading(id, text);
        if (onLoading && !firedOnLoading) {
          firedOnLoading = true;
          onLoading({ session, write: (s) => sh.stdin.write(s) });
        }
      },
    };

    const session = new NotebookSession(io, sink);
    const out = [];
    const feed = (d) => {
      out.push(String(d));
      session.feed(String(d));
    };
    sh.stdout.on("data", feed);
    // stderr is the same terminal in the VM (one stream to the tab), so the
    // session sees it here too — which is what makes a launcher's complaint show
    // up in the kernel log rather than nowhere.
    sh.stderr.on("data", feed);

    let done = false;
    let info = null;
    const finish = (why, shellExit) => {
      if (done) return;
      done = true;
      clearInterval(tick);
      clearTimeout(bomb);
      try {
        sh.kill();
      } catch {
        /* gone */
      }
      resolve({ why, shellExit, info, loading, session, doc, sent, raw: out.join(""), dir });
    };

    // `term-exit` in the studio: the SHELL's exit is what the session hears, which
    // is the whole reason `; exit` is on the launch line.
    let phase = "running"; // → "killed" once we have killed the kernel behind the
    //                          session's back, → "stopped" after a clean shutdown
    sh.on("exit", (code) => {
      session.onExit(code ?? 0);
      finish(phase === "killed" ? "kernel-gone" : "cells-done", code);
    });

    const bomb = setTimeout(() => finish("timeout", null), timeoutMs);

    // What the studio does: type the command, then run cells once the kernel says
    // it is ready. Nothing here polls the kernel — `status` is driven by frames.
    setTimeout(() => sh.stdin.write(command + "\n"), 50);
    session.status = "starting";
    let started = false;
    let ranSecondBatch = thenRun.length === 0;
    const tick = setInterval(() => {
      if (!started && session.status === "idle") {
        started = true;
        // Read at the ready frame, because `shutdown()` nulls it on the way out
        // and every run here ends in one.
        info = session.info;
        for (const c of cells) session.run(c.id, c.source);
      }
      const settled = started && !session.running && session.queue.length === 0 && session.status === "idle";
      if (!settled || phase !== "running") return;
      if (!ranSecondBatch) {
        ranSecondBatch = true;
        for (const c of thenRun) session.run(c.id, c.source);
        return;
      }
      if (thenKill) {
        phase = "killed";
        thenKill({ session, write: (s) => sh.stdin.write(s) });
        return; // the shell exits, or the timeout says it did not
      }
      phase = "stopped";
      session.shutdown();
    }, 50);
  });
}

const outputs = (doc, id) => doc.cell(id)?.outputs ?? [];
const firstOf = (doc, id, type) => outputs(doc, id).find((o) => o.output_type === type) ?? null;
const plain = (o) => (o && o.data ? o.data["text/plain"] : undefined);

/** Sections, so one case can be re-run without booting five interpreters. */
const SECTIONS = [];
const section = (name, title, body) => SECTIONS.push({ name, title, body });

// ───────────────────────────────────────────────────────────────────────────
if (!fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"))) {
  // Loud, not skipped: this is the only gate that runs the transport at all, and
  // a silent skip reads as green.
  console.log("  ! no vendored Pyodide at packages/studio/public/vendor/pyodide — run `npm run vendor:pyodide`.");
  console.log("  ✗ the notebook transport was NOT exercised");
  process.exit(1);
}

const COMMAND = studioLaunchCommand();
console.log("== the launch string the studio types ==");
console.log(`  ${COMMAND}`);
ok(COMMAND.includes("--vv-notebook-kernel"), "it drives the runtime's kernel mode, not a plain script run");
ok(COMMAND.includes(NB_KERNEL_PATH), "…on the path the studio writes the kernel program to");

// ───────────────────────────────────────────────────────────────────────────
section("fd0", "the substitution this tier makes on fd 0, asserted rather than assumed", async () => {
  /**
   * Every tier here substitutes the channel; this one substitutes a word. The
   * shell hands its foreground job `stdio: ['inherit', …]` and then has to get the
   * terminal's bytes into it, and what that takes depends on whose `spawn` is
   * underneath. Both halves are measured, because a model that silently stops
   * matching is worse than no model: when host Node's meaning arrived under this
   * tier, the symptom was every cell timing out with the kernel's banner green
   * above it.
   *
   * This section used to assert that the VM handed back a writable `child.stdin`
   * where host Node hands back null, and called the difference the substitution.
   * It was a defect, and an expensive one — `if (child.stdin)` is how a caller asks
   * which kind of fd 0 it got, npm's run-script asks exactly that before calling
   * `end()`, and the EOF that produced shut down every template's dev server. So
   * the API shapes now AGREE, and what is genuinely substituted is narrower: host
   * Node's `inherit` shares a descriptor, ours routes, so ours needs a delivery
   * path — and it is deliberately not `child.stdin`, because that name already
   * answers a different question.
   */
  const probe = spawn(process.execPath, ["-e", "setTimeout(() => {}, 50)"], { stdio: ["inherit", "pipe", "pipe"] });
  const hostStdin = probe.stdin;
  probe.kill();
  eq(hostStdin, null, "host Node reads `inherit` on fd 0 as fd inheritance, so there is no `child.stdin` to forward to");

  const { createChildProcess } = await import("../packages/runtime/builtins/child_process.js");
  const { EventEmitter } = await import("node:events");
  const { Readable } = await import("node:stream");
  const spawned = [];
  const guest = createChildProcess({
    sys: { spawnAsync: (spec) => (spawned.push(spec), { pid: 7 }), kill() {} },
    process: {
      env: {}, cwd: () => "/", nextTick: (f) => queueMicrotask(f),
      stdin: { isTTY: false }, stdout: { write() {} }, stderr: { write() {} },
    },
    Buffer, EventEmitter, Readable,
    childLiveness: { active: 0 }, wake() {}, postRaw() {},
  });
  const child = guest.spawn("python", ["kernel.py"], { stdio: ["inherit", "pipe", "pipe"] });
  eq(child.stdin, null, "…and the VM answers the same, because that is what the word means to everyone who asks");
  ok(child._vvStdin && typeof child._vvStdin.write === "function",
    "…while keeping a delivery path for the bytes, under a name that is visibly not node's API");
  eq(spawned[spawned.length - 1].stdinIsPipe, true, "…which is the only thing fd 0 decides there: what the child answers to isTTY");
});

// ───────────────────────────────────────────────────────────────────────────
section("cell", "a cell, through the whole chain", async () => {
  const r = await runKernel({
    command: COMMAND,
    cells: [
      { id: "c1", source: "x = 41\nprint('from the cell')\nx + 1" },
      { id: "c2", source: "x * 2" },
    ],
  });
  eq(r.why, "cells-done", "the run completed rather than timing out");
  ok(!!r.info, `the kernel announced itself (${JSON.stringify(r.info)})`);
  eq(r.info?.python, "3.14.2", "…as the Python the runtime documents");
  // THE ASSERTION THE LAST THREE ROUNDS DID NOT HAVE. A request typed into a
  // shell that is already running a foreground child has to reach that child.
  eq(plain(firstOf(r.doc, "c1", "execute_result")), "42", "a cell's value comes back");
  eq(firstOf(r.doc, "c1", "stream")?.text, "from the cell\n", "…and its print() output arrives as a stream");
  eq(plain(firstOf(r.doc, "c2", "execute_result")), "82", "…and the next cell sees what the first defined");
  eq(r.doc.cell("c1")?.executionCount, 1, "execution counts are handed out in the order the interpreter saw them");
  eq(r.doc.cell("c2")?.executionCount, 2, "…and the second cell is the second");
  ok(
    r.session.log.some((l) => l.includes("--vv-notebook-kernel")),
    "the shell's echo of the launch line lands in the kernel log, not in the frames",
  );
});

// ───────────────────────────────────────────────────────────────────────────
// A kernel that dies WITHOUT the session having asked it to. Sent straight down
// the pipe, behind the session's back, so the session's own bookkeeping is not
// what makes this pass — the same asymmetry a segfaulting interpreter has.
const killBehindItsBack = ({ write }) => write(JSON.stringify({ op: "shutdown" }) + "\n");
const NO_EXIT = COMMAND.replace(/;\s*exit\s*$/, "");

section("exit", "`; exit`: the trick, and the reason for it", async () => {
  ok(NO_EXIT !== COMMAND, "the control drops the `; exit` and changes nothing else");

  // The reason it is there: the terminal belongs to the SHELL, so a `term-exit`
  // only happens when the shell goes. `; exit` is what makes the shell follow.
  const withExit = await runKernel({ command: COMMAND, thenKill: killBehindItsBack, timeoutMs: 120000 });
  eq(withExit.why, "kernel-gone", "with `; exit`, the shell follows the interpreter out");
  eq(withExit.session.status, "dead", "…so the session hears about it");
  ok(withExit.session.exit != null, `…with an exit to report (${JSON.stringify(withExit.session.exit)})`);

  // …and the cost of not having it, which is the bug it was added for: a
  // notebook that thinks it has a kernel, forever. This one spends its whole
  // timeout on purpose — the assertion IS that nothing happens.
  const without = await runKernel({ command: NO_EXIT, thenKill: killBehindItsBack, timeoutMs: 60000 });
  eq(without.why, "timeout", "without it, the shell is still sitting at a fresh prompt after its kernel exited");
  eq(without.session.status, "idle", "…and the notebook still believes in a kernel that is gone");
});

section("stdin", "the cost of `; exit`: a job list still gets its stdin", async () => {
  // `;` makes the line a JOB LIST (coreutils.js parses it into two jobs), and the
  // whole design rests on the shell handing stage one of job one its stdin
  // verbatim. This was the leading hypothesis for the inert notebook, and it is
  // the same cell run under both spellings.
  const a = await runKernel({ command: COMMAND, cells: [{ id: "j", source: "'through a job list'" }] });
  const b = await runKernel({ command: NO_EXIT, cells: [{ id: "j", source: "'through a single job'" }] });
  eq(plain(firstOf(a.doc, "j", "execute_result")), "'through a job list'", "stdin reaches the foreground child of `A; exit`");
  eq(plain(firstOf(b.doc, "j", "execute_result")), "'through a single job'", "…exactly as it does with one command and no `;`");
});

// ───────────────────────────────────────────────────────────────────────────
section("framing", "a frame never contains the byte that separates frames", async () => {
  // THE INVARIANT THE READER RESTS ON. `FrameReader` splits a line at its LAST
  // separator, so that junk arriving on the same line cannot swallow the frame
  // behind it. That is correct only while a frame's own bytes cannot contain a
  // separator — and if it ever stops being true, the reader does not lose a frame,
  // it CUTS ONE IN HALF, which is worse than the bug reading-from-the-end fixed.
  //
  // It held for free: json.dumps escapes control characters. Free is the problem —
  // it is a property of this writer's default arguments, not of the protocol, and
  // `ensure_ascii=False` or a second frame writer would break framing with no
  // symptom except cells that never finish. `emit` now enforces it, and this is
  // where that is checked against a real interpreter rather than reasoned about.
  const r = await runKernel({
    command: COMMAND,
    cells: [{ id: "rs", source: `print("a" + chr(30) + "b")` }],
    timeoutMs: 120000,
  });
  const streamed = outputs(r.doc, "rs").filter((o) => o.output_type === "stream").map((o) => o.text).join("");
  eq(streamed, "a\x1eb\n", "a cell CAN put the separator byte in its output, and it arrives intact");
  const framed = r.raw.split("\n").filter((l) => l.includes("\x1e"));
  ok(framed.length > 3, `the run produced frames to check (${framed.length})`);
  const multi = framed.filter((l) => l.split("\x1e").length - 1 !== 1);
  eq(multi.length, 0, `…and every line carrying a frame carries exactly one separator${multi.length ? `: ${JSON.stringify(multi[0].slice(0, 120))}` : ""}`);
});

// ───────────────────────────────────────────────────────────────────────────
section("round2", "round 2: the wheel a cell imports is fetched before the exec", async () => {
  // A cell's imports are resolved by the DRIVER, in an `await` between reading
  // the line and exec'ing it. The kernel's own read loop has no await anywhere —
  // it cannot — so under the old launch string `import pandas` failed on a wheel
  // that was sitting on disk. That failure is the user's round-2 report.
  const good = await runKernel({
    command: COMMAND,
    cells: [{ id: "p", source: "import pandas as pd\npd.DataFrame({'a': [1, 2]}).shape" }],
    timeoutMs: 300000,
  });
  eq(plain(firstOf(good.doc, "p", "execute_result")), "(2, 1)", "`import pandas` in a cell works");
  ok(
    good.loading.some((t) => /pandas/i.test(t)),
    `…because the driver fetched the wheel first, and said so on the cell (${JSON.stringify(good.loading)})`,
  );

  const old = await runKernel({
    command: `python ${NB_KERNEL_PATH}`,
    cells: [{ id: "p", source: "import pandas as pd\npd.DataFrame({'a': [1, 2]}).shape" }],
    timeoutMs: 120000,
  });
  const err = firstOf(old.doc, "p", "error");
  eq(err?.ename, "ModuleNotFoundError", "…and fails under `python <kernel>`, the launch string this replaced");
  ok(/pandas/.test(err?.evalue ?? ""), "…naming the package, which is the user's report from that round, word for word");
});

// ───────────────────────────────────────────────────────────────────────────
section("interrupt", "an interrupt during the fetch stops the cell, not the session", async () => {
  // THE CAPABILITY THE WHOLE TRANSPORT WAS CHOSEN FOR, and until this section it
  // was exercised by nothing: `interrupt()` existed in this file's harness and no
  // case called it. The shell was picked over `vivari.spawn` because `proc-*` has
  // no way to send a signal — so an untested interrupt means the reason for the
  // design is the one thing not being checked.
  //
  // The window this aims at is the one the driver owns: a cell's imports are
  // resolved in JS, which can take seconds, and the interpreter is not running.
  // Registering a SIGINT handler is what tells the kernel not to kill the process,
  // and nothing was registered there — so pressing stop on "Loading scipy…" took
  // the interpreter down and every name the user had defined with it. The reason
  // that could ship green is that no tier delivered a signal at all: this child
  // stubbed `process.on` (scripts/lib/notebook-python-child.mjs), which now models
  // the kernel's actual rule instead.
  //
  // `sklearn` because it is the longest fetch in the vendored set (scipy,
  // scikit-learn, joblib, threadpoolctl — 17.6 MiB), so the keystroke lands well
  // inside the window rather than racing its end.
  const r = await runKernel({
    command: COMMAND,
    cells: [
      { id: "keep", source: "keepsake = 'the interpreter kept its state'" },
      { id: "fetch", source: "from sklearn.linear_model import LinearRegression\nLinearRegression" },
    ],
    thenRun: [{ id: "after", source: "keepsake" }],
    onLoading: ({ session }) => session.interrupt(),
    timeoutMs: 300000,
  });

  // `exit` is only ever set by onExit for a kernel the session did not stop on
  // purpose, so a null here is "the interpreter was never lost". Before the fix it
  // held {code:130,...}: the shell followed a SIGKILLed child out.
  ok(r.session.exit == null, `the interpreter was never lost (${JSON.stringify(r.session.exit)})`);
  const err = firstOf(r.doc, "fetch", "error");
  eq(err?.ename, "KeyboardInterrupt", "…and the cell reports the KeyboardInterrupt the user asked for");
  eq(
    plain(firstOf(r.doc, "after", "execute_result")),
    "'the interpreter kept its state'",
    "…while a name defined before it survives, which is what a killed kernel takes away",
  );
  // The promise that keeps a VM kernel alive, and the one thing about this that is
  // invisible from outside the process: the guest telling the kernel it took the
  // signal and is staying. Without it the force-kill window closes on a kernel that
  // handled the interrupt correctly.
  ok(/<vv-signal-handled SIGINT>/.test(r.raw), "…having told the kernel it took the signal, which stands the force-kill down");

  // The belt behind that, read out of the driver rather than provoked, and said
  // plainly because the distinction matters: the case above lands the interrupt
  // inside `handle_line`'s guard, which is where it lands when the driver
  // re-delivers it. What cannot be provoked on demand is a raise at the two sites
  // the guard cannot enclose — its own function entry and its own except clause —
  // so the driver's catch recognises the exception instead of predicting its
  // position. `interrupted()`'s own behaviour is driven under host CPython in
  // spike-notebook.mjs; what is asserted here is that the driver still reaches for
  // it before reporting the kernel dead.
  const driver = fs.readFileSync(path.join(ROOT, "packages/runtime/builtins/python.js"), "utf8");
  const loop = driver.slice(driver.indexOf("function driveNotebook("), driver.indexOf("async function notebookKernel("));
  ok(/terminationFromError\(e\)\.kind === "interrupt"/.test(loop), "the driver's catch asks WHAT was raised rather than where…");
  // Both positions read out FIRST and required to exist: `indexOf` answers -1 for a
  // string that is not there, and `-1 < anything` is true — so the obvious spelling
  // of this assertion passes when the belt has been deleted, which is the exact
  // failure this MR keeps producing.
  const atInterrupt = loop.indexOf("interrupted(line)");
  const atDied = loop.indexOf("died(String(");
  ok(atInterrupt >= 0 && atDied >= 0 && atInterrupt < atDied,
    `…and reports the cell's interrupt before it will report a dead kernel (at ${atInterrupt} and ${atDied})`);
  ok(/const interrupted = fn\("interrupted"\)/.test(loop), "…through the kernel's own reporting function, so one implementation serves both guards");
  // And that the name still means that where the catch uses it. A `let interrupted`
  // for the fetch-window flag lived in the try block and worked, because the two
  // scopes do not overlap — right up until somebody moved the declaration one line
  // out, at which point the catch calls a boolean, throws inside the handler and
  // reports the kernel dead, with all three strings above still present and still
  // in order. The gate for a name is the absence of a rebinding, not the presence
  // of a call.
  const bindings = [...loop.matchAll(/\b(?:let|var|const)\s+interrupted\b/g)];
  eq(bindings.length, 1, `…and that is the only thing in the loop by that name, so the catch cannot be reading a local flag instead (${bindings.length} bindings)`);
});

section("round1", "round 1: a cell that raises does not take the kernel with it", async () => {
  // The kernel is run for its DEFINITIONS by eval_code_async, where `__file__`
  // does not exist — and the traceback formatter read it while handling a cell's
  // exception, so the first cell to raise killed the kernel and the notebook
  // showed nothing. This runs in that environment, so it is a check on production
  // rather than on `python kernel.py`.
  const r = await runKernel({
    command: COMMAND,
    cells: [
      { id: "boom", source: "def inner():\n    return missing_name\ninner()" },
      { id: "after", source: "'the kernel is still here'" },
    ],
  });
  const err = firstOf(r.doc, "boom", "error");
  eq(err?.ename, "NameError", "a cell that raises comes back as an error frame");
  ok((err?.traceback ?? []).some((l) => /<cell boom>", line 3/.test(l)), "…with a traceback at the user's own line");
  ok(!(err?.traceback ?? []).some((l) => /run_cell/.test(l)), "…and none of the kernel's own frames");
  eq(
    plain(firstOf(r.doc, "after", "execute_result")),
    "'the kernel is still here'",
    "…and the interpreter survives it, which is what the __file__ read took away",
  );
});

// ───────────────────────────────────────────────────────────────────────────
section("template", "the notebook the template actually ships", async () => {
  // Read out of templates.ts, so this runs what a user gets rather than a
  // sample of it. Its plotting cell is why: `FigureCanvas = None` satisfied an
  // import and nothing else, and every assertion we had was on frames the cell
  // never reached.
  const tpl = fs.readFileSync(path.join(ROOT, "packages/studio/src/vv/templates.ts"), "utf8");
  const open = tpl.indexOf('"analysis.ipynb": notebookFile(') + '"analysis.ipynb": notebookFile('.length;
  let depth = 0;
  let i = open;
  for (; i < tpl.length; i++) {
    const ch = tpl[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    } else if (ch === '"') {
      i++;
      while (tpl[i] !== '"') {
        if (tpl[i] === "\\") i++;
        i++;
      }
    }
  }
  const templateCells = new Function("return " + tpl.slice(open, i))();
  const code = templateCells.filter((c) => c.type === "code");
  eq(code.length, 4, "the starter notebook has four code cells");

  const r = await runKernel({
    command: COMMAND,
    cells: code.map((c, n) => ({ id: "starter" + (n * 2 + 2), source: c.source })),
    timeoutMs: 300000,
  });
  const errs = r.doc.cells.flatMap((c) => c.outputs.filter((o) => o.output_type === "error"));
  ok(
    errs.length === 0,
    `every cell of the shipped notebook runs clean${errs.length ? ` (${errs.map((e) => e.ename + ": " + e.evalue).join("; ")})` : ""}`,
  );
  ok(/^3\.\d+\.\d+ /.test(firstOf(r.doc, "starter2", "stream")?.text ?? ""), "cell 1 prints the interpreter's version");
  eq(plain(firstOf(r.doc, "starter4", "execute_result")), "55", "cell 2 sees `total` from cell 1");
  ok(/<table/.test(firstOf(r.doc, "starter6", "execute_result")?.data?.["text/html"] ?? ""), "cell 3's DataFrame renders as a table");
  const png = firstOf(r.doc, "starter8", "display_data")?.data?.["image/png"];
  ok(typeof png === "string" && png.length > 1000, `cell 4's figure comes back as an inline PNG (${png ? png.length : 0} b64 chars)`);
});

// ───────────────────────────────────────────────────────────────────────────
// A flag rather than positional args: run-spikes.mjs hands every spike its
// provisioned vendor path as argv[2], and a filter that swallowed that would be
// green for the wrong reason.
const only = process.argv.slice(2).find((a) => a.startsWith("--only="));
const wanted = only ? only.slice("--only=".length).split(",").filter(Boolean) : [];
const unknown = wanted.filter((w) => !SECTIONS.some((s) => s.name === w));
if (unknown.length) {
  console.log(`  ! no section named ${unknown.join(", ")}. Known: ${SECTIONS.map((s) => s.name).join(", ")}`);
  process.exit(2);
}
for (const s of SECTIONS) {
  if (wanted.length && !wanted.includes(s.name)) continue;
  console.log(`\n== ${s.title} ==`);
  await s.body();
}

console.log(failed === 0 ? "\nnotebook transport: OK" : `\nnotebook transport: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);