// The transport: how the notebook's kernel actually gets to be a running process
// inside the VM, and how a Ctrl-C reaches it.
//
// This is the browser-only half, and it is deliberately thin — everything that
// can be wrong quietly (queueing, counts, what interrupt means) is in
// `session.js`, which the spike drives. What is here is message plumbing.
//
// WHY A TERMINAL AND NOT `proc-spawn`. `vivari.spawn`'s channel would be the
// tidier fit: clean stdin, stdout and stderr split, no shell in the middle. It
// has no way to send a signal. `kernel-worker.ts` routes `proc-kill` to
// `kernel.stop(pid)`, which ends the process — so on that channel "interrupt"
// could only ever mean "throw the interpreter away", taking every name the
// notebook has defined with it. That is not an interrupt, it is a restart with a
// misleading label.
//
// The shell has the signal. `coreutils.js` gives a foreground child stdin
// verbatim — "no line-edit/echo — the program drives the display" — and turns a
// `\x03` in that stream into `SIGINT` for the child, which is what sets the byte
// CPython polls (`Py_EmscriptenSignalBuffer`, via `pyodide.setInterruptBuffer`).
// It is the same path a person pressing Ctrl-C in a terminal takes, which is the
// argument for it: it is the one interrupt route this project has already proven.
//
// The cost is that the kernel's stdout is shared with the shell — its echo of the
// launch line, and anything Pyodide's package loader prints. That is what the
// record separator on every frame is for, and `FrameReader` splits the two.

import type { KernelBridge } from "../kernel";
import { NB_KERNEL_PATH, NB_KERNEL_PY } from "./kernel-source.js";
import type { KernelIO } from "./session.js";

/** Ctrl-C. The shell reads this out of a foreground child's stdin and turns it
 *  into SIGINT — see the header. */
export const INTERRUPT_CHAR = "\x03";

/**
 * What is typed into the kernel's shell.
 *
 * `--vv-notebook-kernel` rather than `python <path>`: the runtime drives this
 * program a cell at a time so that a cell's imports can be fetched before it is
 * exec'd (notebookKernel in packages/runtime/builtins/python.js). `python <path>`
 * still runs the same file, with its own read loop and no await anywhere — which
 * is why `import pandas` in a cell failed on a wheel that was already on disk.
 *
 * `; exit` is how a dead kernel becomes visible. The terminal belongs to the
 * SHELL, so `term-exit` fires when the shell ends, not when python does: a kernel
 * that crashed left the shell sitting at a fresh prompt, the session waiting for a
 * frame that was never coming, and the notebook showing nothing at all. Sequencing
 * `exit` after it makes the shell follow its child out, which is the signal the
 * front end already knows how to report. The kernel's own `dead` frame covers the
 * same ground from the other side and carries the reason; this covers the deaths
 * Python never got to describe — a failed Pyodide boot, an OOM, a SIGKILL.
 */
export const KERNEL_COMMAND = `python --vv-notebook-kernel ${NB_KERNEL_PATH}; exit`;

let seq = 0;

/**
 * One notebook's kernel process. Implements the `KernelIO` the session drives,
 * and owns the terminal it runs in.
 */
export class NotebookKernel implements KernelIO {
  private currentId: string;
  private readonly bridge: KernelBridge;
  private readonly cwd: string;
  private readonly onOutput: (chunk: string) => void;
  private readonly onExit: (code: number) => void;
  private ready = false;
  private launched = false;
  private queuedInput: string[] = [];

  constructor(opts: {
    bridge: KernelBridge;
    cwd: string;
    onOutput: (chunk: string) => void;
    onExit: (code: number) => void;
  }) {
    this.bridge = opts.bridge;
    this.cwd = opts.cwd;
    this.onOutput = opts.onOutput;
    this.onExit = opts.onExit;
    this.currentId = "nb" + ++seq;
  }

  /** The terminal this kernel is running in — a NEW one for each launch.
   *
   *  Per launch rather than per notebook because a restart's `term-close` and its
   *  `term-open` cross: the dying kernel's `term-exit` can arrive after the new one
   *  has started, and on a shared id it would report the live kernel as dead. A new
   *  id makes that message route to nobody, which is what it is worth. */
  get terminalId(): string {
    return this.currentId;
  }

  launch() {
    if (this.launched) return;
    this.launched = true;
    this.currentId = "nb" + ++seq;
    // The kernel program lives outside any project: it is ours, not the user's,
    // and a file called vv-notebook-kernel.py in their tree would be both
    // confusing and committed.
    this.bridge.post("vv-write", { path: NB_KERNEL_PATH, contents: NB_KERNEL_PY });
    // A plain shell, with no `run`. `run` is the project Run button's path and it
    // would prepend `npm install` for a directory with no node_modules — which
    // every Python project is.
    this.bridge.post("term-open", { terminalId: this.terminalId, cwd: this.cwd });
  }

  /** The kernel's shell is up: type the command, as a user would. */
  onTerminalReady() {
    if (this.ready) return;
    this.ready = true;
    this.bridge.post("term-input", { terminalId: this.terminalId, chunk: KERNEL_COMMAND + "\n" });
    for (const chunk of this.queuedInput) this.bridge.post("term-input", { terminalId: this.terminalId, chunk });
    this.queuedInput.length = 0;
  }

  send(line: string) {
    const chunk = line + "\n";
    // Before the shell exists there is nothing to write to. Held rather than
    // dropped: the session sends the first cell the moment the kernel says ready,
    // and "ready" cannot arrive before the shell does.
    if (!this.ready) {
      this.queuedInput.push(chunk);
      return;
    }
    this.bridge.post("term-input", { terminalId: this.terminalId, chunk });
  }

  interrupt() {
    this.bridge.post("term-input", { terminalId: this.terminalId, chunk: INTERRUPT_CHAR });
  }

  stop() {
    if (!this.launched) return;
    this.bridge.post("term-close", { terminalId: this.terminalId });
    this.launched = false;
    this.ready = false;
    this.queuedInput.length = 0;
  }

  /** Routed here by the controller's `term-out` handler. */
  handleOutput(chunk: string) {
    this.onOutput(chunk);
  }

  handleExit(code: number) {
    this.ready = false;
    this.launched = false;
    this.onExit(code);
  }
}

/** Terminal ids this module owns, so the controller can route without guessing. */
export function isNotebookTerminal(id: string): boolean {
  return /^nb\d+$/.test(id);
}
