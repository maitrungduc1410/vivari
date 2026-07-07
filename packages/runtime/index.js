// The Node runtime shim. Given a shared-memory channel to the kernel, it wires
// up core builtins, globals, and a CommonJS module system, then runs a program
// exactly like `node <entry>` would — synchronously, inside a worker.

import { createSyscalls } from "./fs-client.js";
import { createEventLoop } from "./loop.js";
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

  // Open HTTP servers keyed by port. The event loop stays alive while this is
  // non-empty; when woken (kernel `net` message) it drains queued requests here.
  const servers = new Map();

  // The process event loop (Phase 2 #5): real nextTick > microtask > timers >
  // immediate ordering, timers firing even while a server is running. `doNet`
  // drains the server inbox one request at a time (sync dispatch for now).
  const loop = createEventLoop({
    isAlive: () => servers.size > 0,
    doNet: () => {
      while (servers.size > 0) {
        const ev = syscalls.tryAccept();
        if (!ev) break;
        // Fire the handler; respond when it finishes (possibly after await/timers).
        http._serve(ev, (resp) => syscalls.respond(ev.reqId, resp));
      }
    },
  });

  const os = createOs();
  const process = createProcess({ pid, ppid, argv, env, cwd, stdout, stderr, nextTick: loop.nextTick });

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
  const http = createHttp({
    syscalls,
    servers,
    enqueueTask: (fn) => loop.setImmediate(fn),
    EventEmitter,
    Buffer,
  });
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
  // Route user-facing timers through our event loop so ordering is Node-correct
  // and callbacks fire even while a server is running (the old host timers never
  // fired — the synchronous accept loop starved them).
  globalThis.setTimeout = loop.setTimeout;
  globalThis.clearTimeout = loop.clearTimeout;
  globalThis.setInterval = loop.setInterval;
  globalThis.clearInterval = loop.clearInterval;
  globalThis.setImmediate = loop.setImmediate;
  globalThis.clearImmediate = loop.clearImmediate;

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
    /** External nudge from the kernel: a network request is queued for us. */
    wake: loop.wakeNet,
    /**
     * Run an entry file like `node <entry>`, then drive the event loop until it
     * is quiescent (no pending timers/immediates/nextTicks and no open servers).
     * Async: it yields to the host so Promise microtasks and timers actually
     * fire. Resolves with the process exit code.
     */
    async run(entry) {
      try {
        moduleSystem.runMain(entry); // synchronous; may throw process.exit sentinel
      } catch (err) {
        if (err && err.__processExit !== undefined) return err.__processExit;
        throw err;
      }
      await loop.drive();
      return loop.exiting ? loop.exitCode : 0;
    },
  };
}
