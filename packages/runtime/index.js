// The Node runtime shim. Given a shared-memory channel to the kernel, it wires
// up core builtins, globals, and a CommonJS module system, then runs a program
// exactly like `node <entry>` would — synchronously, inside a worker.

import { createSyscalls } from "./fs-client.js";
import { createNodeModules } from "./node/loader.js";
import { createOs } from "./builtins/os.js";
import { createProcess } from "./builtins/process.js";
import { createAssert } from "./builtins/assert.js";
import { createChildProcess } from "./builtins/child_process.js";
import { createHttp } from "./builtins/http.js";
import { createModuleSystem } from "./module.js";

function createConsole(process, util) {
  const toOut = (...a) => process.stdout.write(util.format(...a) + "\n");
  const toErr = (...a) => process.stderr.write(util.format(...a) + "\n");
  return {
    log: toOut,
    info: toOut,
    debug: toOut,
    warn: toErr,
    error: toErr,
    trace: toErr,
    dir: (o) => toOut(util.inspect(o)),
    assert: (cond, ...a) => {
      if (!cond) toErr("Assertion failed:", ...a);
    },
    // no-op timing/grouping helpers
    time() {},
    timeEnd() {},
    group() {},
    groupEnd() {},
    table(o) {
      toOut(util.inspect(o));
    },
  };
}

export function createRuntime({
  ctrl,
  data,
  notify,
  pid = 1,
  ppid = 0,
  argv = [],
  env = {},
  cwd = "/",
  stdout = () => {},
  stderr = () => {},
}) {
  const syscalls = createSyscalls({ ctrl, data, notify });

  // Runtime task queue: nextTick/listen callbacks land here and are drained by
  // the accept loop (below) so they run deterministically even when the worker
  // is parked on Atomics.wait serving a server.
  const taskQueue = [];
  const enqueueTask = (fn) => taskQueue.push(fn);
  const drainTasks = () => {
    while (taskQueue.length) taskQueue.shift()();
  };

  // Open HTTP servers keyed by port. `run()` stays alive while this is non-empty.
  const servers = new Map();

  const os = createOs();
  const process = createProcess({ pid, ppid, argv, env, cwd, stdout, stderr, enqueueTask });

  // Path B: Node's REAL lib/ modules run on top of our internalBinding layer.
  // `path`, `buffer`, `fs`, `events` and `util` are vendored, unmodified Node
  // v24.18.0 source; `Buffer` is the real Buffer (Uint8Array subclass) over
  // internalBinding('buffer'), `fs` is Node's real lib/fs.js over
  // internalBinding('fs') (node/bindings/fs.js -> Rust VFS via the sync bridge),
  // and `events`/`util` run on our shared internal layer (util.inspect bridged).
  const nodeModules = createNodeModules({ process, syscalls });
  const bufferModule = nodeModules.require("buffer");
  const Buffer = bufferModule.Buffer;
  const path = nodeModules.require("path");
  const EventEmitter = nodeModules.require("events");
  const util = nodeModules.require("util");
  const fs = nodeModules.require("fs");
  const assert = createAssert(util);
  const child_process = createChildProcess({ sys: syscalls, process, Buffer });
  const http = createHttp({ syscalls, servers, enqueueTask, EventEmitter, Buffer });
  const consoleObj = createConsole(process, util);

  // Globals visible to user code (both as wrapper params and on globalThis).
  const globals = {
    process,
    Buffer,
    console: consoleObj,
    global: globalThis,
  };
  globalThis.process = process;
  globalThis.Buffer = Buffer;
  globalThis.console = consoleObj;
  globalThis.global = globalThis;
  if (typeof globalThis.setImmediate !== "function") {
    globalThis.setImmediate = (fn, ...a) => setTimeout(fn, 0, ...a);
    globalThis.clearImmediate = (id) => clearTimeout(id);
  }

  const builtins = {
    fs,
    path,
    os,
    process,
    util,
    assert,
    child_process,
    http,
    events: EventEmitter,
    buffer: bufferModule,
  };

  const moduleSystem = createModuleSystem({ fs, path, builtins, process, globals });

  builtins.module = {
    createRequire: (from) =>
      moduleSystem.makeRequire(path.dirname(typeof from === "string" ? from : "/")),
    builtinModules: Object.keys(builtins),
    Module: moduleSystem.Module,
  };

  // Support both `require('fs')` and `require('node:fs')`.
  for (const name of Object.keys(builtins)) builtins["node:" + name] = builtins[name];

  return {
    fs,
    process,
    require: moduleSystem.makeRequire(cwd),
    /** Run an entry file like `node <entry>`; returns the process exit code. */
    run(entry) {
      try {
        moduleSystem.runMain(entry);
        drainTasks();
        // If the program opened servers, it does not exit: enter the accept loop
        // and serve requests one at a time until every server is closed. This
        // blocking loop is the process's synchronous event loop.
        while (servers.size > 0) {
          const ev = syscalls.accept(); // parks on Atomics.wait until a request
          const resp = http._dispatch(ev);
          syscalls.respond(ev.reqId, resp);
          drainTasks();
        }
        return 0;
      } catch (err) {
        if (err && err.__processExit !== undefined) return err.__processExit;
        throw err;
      }
    },
  };
}
