// Generic process bootstrap. A worker (browser Worker or Node worker_threads)
// receives an `init` message with its shared-memory channel and a spec, then
// calls this to build the runtime and run its program to completion. Messaging
// is injected via `send` so this stays environment-agnostic.
//
// spec = { pid, ppid, programPath, args, cwd, env }

import { makeViews, isFsOpcode } from "../protocol/syscall.js";
import { createRuntime } from "./index.js";

export function bootProcess({
  sab,
  spec,
  send,
  onReady,
  fsPort = null,
  codec = null,
  cryptoCodec = null,
  // #16 stage 2b: when this worker is a spawned thread, `threadPort` is the raw
  // MessagePort to its creator (becomes parentPort) and `postRaw` sends messages
  // to the kernel with transferables (for Worker() -> kernel port handoff).
  threadPort = null,
  postRaw = null,
}) {
  const { ctrl, data } = makeViews(sab);
  // #14: fs opcodes ring the File System Worker's doorbell directly (a
  // MessagePort handed to us at spawn); non-fs opcodes still nudge the kernel.
  // Without an fsPort (older headless paths) everything falls back to the kernel.
  const ringFs = fsPort ? () => fsPort.postMessage(0) : () => send("syscall");
  const isThread = !!spec.isThread;
  const runtime = createRuntime({
    ctrl,
    data,
    notify: (opcode) => (isFsOpcode(opcode) ? ringFs() : send("syscall")),
    codec,
    cryptoCodec,
    // real kernel-assigned PID (so process.pid matches the worker name / DevTools)
    pid: spec.pid,
    ppid: spec.ppid,
    // process.argv becomes ['node', programPath, ...args]
    argv: [spec.programPath, ...(spec.args || [])],
    env: spec.env || {},
    cwd: spec.cwd || "/",
    stdout: (chunk) => send("stdout", { chunk }),
    stderr: (chunk) => send("stderr", { chunk }),
    postRaw,
    thread: {
      isMainThread: !isThread,
      // threadId defaults to our kernel pid (unique, non-zero for threads).
      threadId: isThread ? (spec.threadId || spec.pid) | 0 : 0,
      workerData: spec.workerData ?? null,
      parentPort: threadPort,
    },
  });

  // The fs doorbell port is duplex: we ring it (process -> FS worker) for every
  // fs syscall, and the FS worker rings *us back* with file-watch change events
  // (roadmap #19 stage B). Those are the only inbound messages on this port.
  if (fsPort) {
    fsPort.onmessage = (e) => {
      const m = e && e.data;
      if (m && m.type === "fs-watch") runtime.dispatchWatch(m);
    };
    if (fsPort.start) fsPort.start();
  }

  // Hand the runtime's external-event hooks back to the worker shell: `wakeNet`
  // nudges the loop on a queued HTTP request; `dispatchChild` feeds it an async
  // child's stdout/stderr/exit (#15); `dispatchThread` feeds it a worker_thread's
  // online/exit (2b). All arrive as kernel postMessages.
  if (typeof onReady === "function")
    onReady({
      wakeNet: runtime.wake,
      dispatchChild: runtime.dispatchChild,
      dispatchThread: runtime.dispatchThread,
      dispatchWs: runtime.dispatchWs,
      dispatchStdin: runtime.dispatchStdin,
    });

  // run() is async (it drives the event loop). Report the exit code when it
  // settles; a server process simply never settles (it stays alive).
  runtime.run(spec.programPath).then(
    (code) => send("exit", { code: code | 0 }),
    (err) => {
      send("stderr", { chunk: String((err && err.stack) || err) + "\n" });
      send("exit", { code: 1 });
    },
  );
}
