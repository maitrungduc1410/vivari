// Generic process bootstrap. A worker (browser Worker or Node worker_threads)
// receives an `init` message with its shared-memory channel and a spec, then
// calls this to build the runtime and run its program to completion. Messaging
// is injected via `send` so this stays environment-agnostic.
//
// spec = { pid, programPath, args, cwd, env }

import { makeViews } from "../protocol/syscall.js";
import { createRuntime } from "./index.js";

export function bootProcess({ sab, spec, send }) {
  const { ctrl, data } = makeViews(sab);
  const runtime = createRuntime({
    ctrl,
    data,
    notify: () => send("syscall"),
    // process.argv becomes ['node', programPath, ...args]
    argv: [spec.programPath, ...(spec.args || [])],
    env: spec.env || {},
    cwd: spec.cwd || "/",
    stdout: (chunk) => send("stdout", { chunk }),
    stderr: (chunk) => send("stderr", { chunk }),
  });

  let code = 0;
  try {
    code = runtime.run(spec.programPath);
  } catch (err) {
    send("stderr", { chunk: String((err && err.stack) || err) + "\n" });
    code = 1;
  }
  send("exit", { code });
}
