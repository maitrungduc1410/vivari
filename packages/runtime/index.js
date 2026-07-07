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
}) {
  const syscalls = createSyscalls({ ctrl, data, notify });

  // Liveness counter for real net handles (Phase 2 #8): a listening net.Server or
  // an open socket keeps the loop alive, exactly like libuv's active handles.
  const netLiveness = { active: 0 };
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
    isAlive: () => netLiveness.active > 0,
    doNet: () => {
      if (netServers.count === 0 || !bridgeHttp) return;
      for (;;) {
        const ev = syscalls.tryAccept();
        if (!ev) break;
        bridgeHttp(ev);
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
  const nodeModules = createNodeModules({ process, syscalls, netLiveness, netServers });
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
  const child_process = createChildProcess({ sys: syscalls, process, Buffer });

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
