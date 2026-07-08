// Generic process bootstrap. A worker (browser Worker or Node worker_threads)
// receives an `init` message with its shared-memory channel and a spec, then
// calls this to build the runtime and run its program to completion. Messaging
// is injected via `send` so this stays environment-agnostic.
//
// spec = { pid, ppid, programPath, args, cwd, env }

import { makeViews } from "../protocol/syscall.js";
import { createRuntime } from "./index.js";

export function bootProcess({ sab, spec, send, onReady, codec = null }) {
  const { ctrl, data } = makeViews(sab);
  const runtime = createRuntime({
    ctrl,
    data,
    notify: () => send("syscall"),
    codec,
    // real kernel-assigned PID (so process.pid matches the worker name / DevTools)
    pid: spec.pid,
    ppid: spec.ppid,
    // process.argv becomes ['node', programPath, ...args]
    argv: [spec.programPath, ...(spec.args || [])],
    env: spec.env || {},
    cwd: spec.cwd || "/",
    stdout: (chunk) => send("stdout", { chunk }),
    stderr: (chunk) => send("stderr", { chunk }),
  });

  // Hand the runtime's network waker back to the worker shell so it can nudge the
  // event loop when the kernel posts a `net` message (a request is queued).
  if (typeof onReady === "function") onReady(runtime.wake);

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
