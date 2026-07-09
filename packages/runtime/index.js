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
  codec = null,
  cryptoCodec = null,
  // Worker threads (#16 stage 2b). `postRaw(msg, transfer)` sends a message to the
  // kernel with transferables (MessagePorts) — the shell provides it. `thread`
  // carries this worker's identity when it *is* a spawned thread.
  postRaw = null,
  thread = null,
}) {
  const syscalls = createSyscalls({ ctrl, data, notify });

  // Liveness counter for real net handles (Phase 2 #8): a listening net.Server or
  // an open socket keeps the loop alive, exactly like libuv's active handles.
  const netLiveness = { active: 0 };
  // Liveness counter for async children (#15): a running child keeps the parent's
  // loop alive so it can stream the child's output and see its exit.
  const childLiveness = { active: 0 };
  // Liveness counter for worker_threads (2b): a running Worker (parent side) or an
  // active parentPort 'message' listener (child side) keeps the loop alive.
  const threadLiveness = { active: 0 };
  // Liveness counter for host-backed async (WebAssembly.compile / fetch /
  // DecompressionStream via Response body readers). Their promises settle on the
  // HOST's queues, invisible to our loop, so a bare `node script.js` that only
  // `await`s one would otherwise exit before it resolves. Each in-flight op refs
  // the loop (like a libuv handle) and wakes the idle wait when it settles.
  const hostLiveness = { active: 0 };
  // Assigned once child_process is built; the loop drains child events through it.
  let drainChildEvents = () => {};
  // Assigned once worker_threads is required; the loop drains its queued events.
  let drainThreadEvents = () => {};
  let dispatchThreadEvent = () => {};
  // How many ports this process has registered with the kernel (each real
  // net.Server.listen calls syscalls.listen). While non-zero, `doNet` drains
  // inbound requests on every `net` wake.
  const netServers = { count: 0 };

  // Bridges one external request (Service Worker / kernel.handleHttpRequest) into
  // this process's real http server. Wired below once the real http module exists.
  let bridgeHttp = null;

  // The process event loop (Phase 2 #5): real nextTick > microtask > timers >
  // immediate ordering, timers firing even while a server is idle. On a `net`
  // wake it drains queued requests and replays each through the real http stack
  // (Phase 2 #8 stage 2) so the server that answers is Node's own lib/http.js.
  const loop = createEventLoop({
    isAlive: () =>
      netLiveness.active > 0 || childLiveness.active > 0 || threadLiveness.active > 0 || hostLiveness.active > 0,
    doNet: () => {
      if (netServers.count === 0 || !bridgeHttp) return;
      for (;;) {
        const ev = syscalls.tryAccept();
        if (!ev) break;
        bridgeHttp(ev);
      }
    },
    doChildren: () => drainChildEvents(),
    doThreads: () => drainThreadEvents(),
  });

  const os = createOs();
  const process = createProcess({ pid, ppid, argv, env, cwd, stdout, stderr, nextTick: loop.nextTick });

  // Wire the worker_threads host onto `process` so the lazily-required
  // node:worker_threads builtin (2b) can read this thread's identity, spawn nested
  // workers (brokered by the kernel), and pump its events through our loop.
  process.__wtHost = {
    isMainThread: thread ? !!thread.isMainThread : true,
    threadId: thread ? thread.threadId | 0 : 0,
    workerData: thread ? thread.workerData : null,
    parentPort: thread ? thread.parentPort || null : null,
    wake: () => loop.wakeNet(),
    retain: () => {
      threadLiveness.active++;
      loop.wakeNet();
    },
    release: () => {
      if (threadLiveness.active > 0) threadLiveness.active--;
    },
    registerDrain: (fn) => {
      drainThreadEvents = fn;
    },
    registerDispatch: (fn) => {
      dispatchThreadEvent = fn;
    },
    spawn: (reqId, spec, port) => {
      if (postRaw) postRaw({ type: "thread-spawn", reqId, spec, port }, [port]);
    },
    terminate: (reqId) => {
      if (postRaw) postRaw({ type: "thread-terminate", reqId });
    },
  };

  // Path B: Node's REAL lib/ modules run on top of our internalBinding layer.
  // `path`, `buffer`, `fs`, `events` and `util` are vendored, unmodified Node
  // v24.18.0 source; `Buffer` is the real Buffer (Uint8Array subclass) over
  // internalBinding('buffer'), `fs` is Node's real lib/fs.js over
  // internalBinding('fs') (node/bindings/fs.js -> Rust VFS via the sync bridge),
  // and `events`/`util` run on our shared internal layer (util.inspect bridged).
  const nodeModules = createNodeModules({ process, syscalls, netLiveness, netServers, codec, cryptoCodec });
  const bufferModule = nodeModules.require("buffer");
  const Buffer = bufferModule.Buffer;
  const path = nodeModules.require("path");
  const EventEmitter = nodeModules.require("events");
  const util = nodeModules.require("util");
  const fs = nodeModules.require("fs");
  const stream = nodeModules.require("stream");
  const streamPromises = nodeModules.require("stream/promises");
  const stringDecoder = nodeModules.require("string_decoder");
  const asyncHooks = nodeModules.require("async_hooks");
  const net = nodeModules.require("net");
  const timers = nodeModules.require("timers");
  const diagnosticsChannel = nodeModules.require("diagnostics_channel");
  const cluster = nodeModules.require("cluster");
  // Phase 2 #8 stage 2: `http` IS Node's real lib/http.js now (Brick 5 is gone).
  // The browser preview reaches it through the bridge wired below.
  const http = nodeModules.require("http");
  const assert = createAssert(util);
  const child_process = createChildProcess({
    sys: syscalls,
    process,
    Buffer,
    EventEmitter,
    Readable: stream.Readable,
    childLiveness,
    wake: loop.wakeNet,
  });
  // The loop drains queued child events (stdout/stderr/exit) each turn (#15).
  drainChildEvents = child_process._drain;

  // Replay an external request through the real http *client* into the in-VM real
  // http *server* over the net loopback, then send the collected response back to
  // the kernel. This is the cross-VM seam: the kernel/SW protocol is unchanged
  // ({port,method,url,headers,body} in -> {status,headers,body} out), but Node's
  // own http parses/serves it. Bodies cross as utf8 strings (kernel JSON), same as
  // the old Brick 5 path; binary payloads are out of scope for the preview.
  const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"];
  const pickHeaders = (src, drop) => {
    const out = {};
    for (const k of Object.keys(src || {})) {
      const lk = k.toLowerCase();
      if (drop.includes(lk) || HOP_BY_HOP.includes(lk)) continue;
      out[k] = src[k];
    }
    return out;
  };
  bridgeHttp = (ev) => {
    const { reqId, port, req } = ev;
    let done = false;
    const reply = (resp) => {
      if (done) return;
      done = true;
      try {
        syscalls.respond(reqId, resp);
      } catch {
        /* kernel gone */
      }
    };
    const fail = (e) =>
      reply({
        status: 502,
        headers: { "content-type": "text/plain" },
        body: "Bad Gateway: " + (e && e.message ? e.message : String(e)) + "\n",
      });
    let creq;
    try {
      creq = http.request(
        {
          host: "127.0.0.1",
          port,
          method: req.method || "GET",
          path: req.url || "/",
          headers: pickHeaders(req.headers, ["host", "content-length"]),
        },
        (cres) => {
          const chunks = [];
          cres.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          cres.on("end", () =>
            reply({
              status: cres.statusCode || 200,
              headers: pickHeaders(cres.headers, ["content-length"]),
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          cres.on("error", fail);
        },
      );
    } catch (e) {
      fail(e);
      return;
    }
    creq.on("error", fail);
    const body = req.body;
    if (body != null && body !== "" && req.method !== "GET" && req.method !== "HEAD") creq.end(body);
    else creq.end();
  };

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
  // Worker-global alias: browser Workers already have `self`, but the headless
  // Node worker_threads runtime does not. Some libraries (e.g. esbuild-wasm's
  // browser build, which mirrors globals off `self`) rely on it existing.
  if (typeof globalThis.self === "undefined") globalThis.self = globalThis;

  // Keep the loop alive while host-backed async work is pending (see hostLiveness
  // above). We monkey-patch the few entry points whose promises resolve off our
  // loop so `await`-ing them from a bare script no longer races the loop to exit.
  const trackHost = (p) => {
    if (!p || typeof p.then !== "function") return p;
    hostLiveness.active++;
    const done = () => {
      if (hostLiveness.active > 0) hostLiveness.active--;
      loop.wakeNet(); // break an idle waitForNext so the loop re-evaluates
    };
    p.then(done, done); // consumes settlement only for liveness; original p is returned
    return p;
  };
  const wrapHostAsync = (obj, name) => {
    const orig = obj && obj[name];
    if (typeof orig !== "function" || orig.__ocHostWrapped) return;
    const wrapped = function (...args) {
      return trackHost(orig.apply(this, args));
    };
    wrapped.__ocHostWrapped = true;
    obj[name] = wrapped;
  };
  if (typeof WebAssembly !== "undefined") {
    for (const m of ["compile", "instantiate", "compileStreaming", "instantiateStreaming"]) {
      wrapHostAsync(WebAssembly, m);
    }
  }
  if (typeof globalThis.fetch === "function") wrapHostAsync(globalThis, "fetch");
  // DecompressionStream/Blob consumers land here: new Response(stream).arrayBuffer().
  if (typeof Response !== "undefined" && Response.prototype) {
    for (const m of ["arrayBuffer", "text", "json", "blob", "formData"]) wrapHostAsync(Response.prototype, m);
  }
  if (typeof Blob !== "undefined" && Blob.prototype) {
    for (const m of ["arrayBuffer", "text"]) wrapHostAsync(Blob.prototype, m);
  }
  // Route user-facing timers through our event loop so ordering is Node-correct
  // and callbacks fire even while a server is running (the old host timers never
  // fired — the synchronous accept loop starved them).
  globalThis.setTimeout = loop.setTimeout;
  globalThis.clearTimeout = loop.clearTimeout;
  globalThis.setInterval = loop.setInterval;
  globalThis.clearInterval = loop.clearInterval;
  globalThis.setImmediate = loop.setImmediate;
  globalThis.clearImmediate = loop.clearImmediate;
  // Phase 2 #9 (internal, temporary): a blocking fetch into the VFS, serviced by
  // the kernel's Fetcher Worker. Returns { status, ok, contentType, size, path,
  // cached }; read `path` with fs for the bytes. This is the low-level primitive
  // the npm client (#10) will build on; it'll get a proper wrapper then.
  globalThis.__ocfetch = (url) => syscalls.fetch(String(url));

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
    stream,
    "stream/promises": streamPromises,
    string_decoder: stringDecoder,
    async_hooks: asyncHooks,
    net,
    timers,
    diagnostics_channel: diagnosticsChannel,
    cluster,
  };

  const moduleSystem = createModuleSystem({ fs, path, builtins, process, globals, nodeModules });

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
    /** External delivery from the kernel: an async child's stdout/stderr/exit
     * ({type:'child-stdout'|'child-stderr'|'child-exit', childPid, ...}). #15 */
    dispatchChild: (msg) => child_process._dispatch(msg),
    /** External delivery from the kernel: a worker_thread's online/exit
     * ({type:'thread-started'|'thread-exit', reqId, ...}). #16 stage 2b. */
    dispatchThread: (msg) => dispatchThreadEvent(msg),
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
