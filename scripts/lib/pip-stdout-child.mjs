// Runs one pip verb through the REAL runtime, in a REAL process, so its parent
// can look at the actual bytes on fd 1. Driven by spike-python-offline.mjs.
//
// The point is the process boundary. Assertions that call formatPipFreeze() and
// compare strings pass whether or not something else also wrote to stdout, and
// that is precisely how `Loading packaging` ended up inside a user's
// requirements.txt. Here the only thing the parent trusts is the pipe.
//
// The interpreter is scripts/lib/fake-pyodide.mjs — the offline tier has none,
// and the bug never needed one: it lives in whether a call passes a callback.
//
//   argv: <verb> <projectDir> <fakeIndexDir>

import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { createPythonRuntime } from "../../packages/runtime/builtins/python.js";

const [verb, projectDir, indexDir] = process.argv.slice(2);
const require = createRequire(import.meta.url);

// The runtime asks for "fs" and "path"; hand it Node's, and let it use the real
// process, whose stdout and stderr are the pipes the parent is reading.
const runtime = createPythonRuntime({
  process,
  require: (name) => require("node:" + name),
  trackHost: () => {},
});

process.chdir(projectDir);
const py = runtime.install(pathToFileURL(path.join(indexDir, "/")).href);

const verbs = {
  freeze: () => py.pipFreeze(),
  list: () => py.pipList(),
  show: () => py.pipShow(["tabulate"]),
  check: () => py.pipCheck(),
  install: () => py.pipInstall(["tabulate"]),
};
if (!verbs[verb]) {
  process.stderr.write(`pip-stdout-child: no such verb ${verb}\n`);
  process.exitCode = 2;
} else {
  // exitCode, not exit(). When stdout is a pipe — which is the whole point of
  // this child — writes are asynchronous, and process.exit() throws away
  // whatever is still buffered. Exiting here truncated the payload to nothing
  // while the earlier loader lines survived, which reads exactly like the bug
  // being tested and is not.
  process.exitCode = (await verbs[verb]()) | 0;
}