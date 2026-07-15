// The Node builtin loader — the heart of Path B.
//
// Node ships its standard library as JavaScript (lib/) that runs on top of a
// C++ core reached through `internalBinding`. We keep that JS layer UNMODIFIED
// and re-implement the layer beneath it. Each vendored module is a factory
//   function (exports, require, module, process, internalBinding, primordials)
// exactly like Node's own BuiltinLoader wraps its sources. This loader links
// them: it resolves `require('path')` / `require('internal/...')` against the
// vendored set, injects our `primordials` + `internalBinding` + the process,
// caches instances, and tolerates require cycles (returns the partial exports).
//
// Adding a real Node module later = drop the vendored file in and register it.

import { primordials } from "./primordials.js";
import { createInternalBinding } from "./internal-binding.js";

import pathFactory from "./lib/path.js";
import bufferFactory from "./lib/buffer.js";
import fsFactory from "./lib/fs.js";
import eventsFactory from "./lib/events.js";
import utilPublicFactory from "./lib/util.js";
import constantsFactory from "./internal/constants.js";
import validatorsFactory from "./internal/validators.js";
import errorsFactory from "./internal/errors.js";
import utilFactory from "./internal/util.js";
import utilTypesFactory from "./internal/util/types.js";
import utilInspectFactory from "./internal/util/inspect.js";
import utilDebuglogFactory from "./internal/util/debuglog.js";
import utilColorsFactory from "./internal/util/colors.js";
import utilComparisonsFactory from "./internal/util/comparisons.js";
import parseArgsFactory from "./internal/util/parse_args/parse_args.js";
import parseArgsUtilsFactory from "./internal/util/parse_args/utils.js";
import internalBufferFactory from "./internal/buffer.js";
import startupSnapshotFactory from "./internal/v8/startup_snapshot.js";
import optionsFactory from "./internal/options.js";
import fsUtilsFactory from "./internal/fs/utils.js";
import fsReadContextFactory from "./internal/fs/read/context.js";
import fsWatchersFactory from "./internal/fs/watchers.js";
import fsStreamsFactory from "./internal/fs/streams.js";
import urlFactory from "./internal/url.js";
import blobFactory from "./internal/blob.js";
import fileFactory from "./internal/file.js";
import permissionFactory from "./internal/process/permission.js";
import assertFactory from "./internal/assert.js";
import assertPublicFactory from "./lib/assert.js";
import abortListenerFactory from "./internal/events/abort_listener.js";
import eventTargetFactory from "./internal/event_target.js";
import taskQueuesFactory from "./internal/process/task_queues.js";
import streamsUtilsFactory from "./internal/streams/utils.js";
import abortControllerFactory from "./internal/abort_controller.js";
import encodingFactory from "./internal/encoding.js";

// stream (Phase 2 #6): Node's real lib/stream.js + internal/streams/* verbatim.
import streamFactory from "./lib/stream.js";
import streamPromisesFactory from "./lib/stream/promises.js";
import streamsLegacyFactory from "./internal/streams/legacy.js";
import streamsDestroyFactory from "./internal/streams/destroy.js";
import streamsStateFactory from "./internal/streams/state.js";
import streamsFromFactory from "./internal/streams/from.js";
import streamsEndOfStreamFactory from "./internal/streams/end-of-stream.js";
import streamsAddAbortSignalFactory from "./internal/streams/add-abort-signal.js";
import streamsReadableFactory from "./internal/streams/readable.js";
import streamsWritableFactory from "./internal/streams/writable.js";
import streamsDuplexFactory from "./internal/streams/duplex.js";
import streamsDuplexifyFactory from "./internal/streams/duplexify.js";
import streamsTransformFactory from "./internal/streams/transform.js";
import streamsPassthroughFactory from "./internal/streams/passthrough.js";
import streamsPipelineFactory from "./internal/streams/pipeline.js";
import streamsComposeFactory from "./internal/streams/compose.js";
import streamsOperatorsFactory from "./internal/streams/operators.js";
import streamsDuplexpairFactory from "./internal/streams/duplexpair.js";
import webstreamsAdaptersFactory from "./internal/webstreams/adapters.js";
import stringDecoderFactory from "./lib/string_decoder.js";
import asyncHooksFactory from "./lib/async_hooks.js";

// net (Phase 2 #7): Node's real lib/net.js + internal/{net,stream_base_commons}
// over the tcp_wrap/stream_wrap loopback binding, plus small support shims.
import netFactory from "./lib/net.js";
import internalNetFactory from "./internal/net.js";
import streamBaseCommonsFactory from "./internal/stream_base_commons.js";
import internalAsyncHooksFactory from "./internal/async_hooks.js";
import internalTimersFactory from "./internal/timers.js";
import perfObserveFactory from "./internal/perf/observe.js";
import timersFactory from "./lib/timers.js";
import diagnosticsChannelFactory from "./lib/diagnostics_channel.js";
import clusterFactory from "./lib/cluster.js";
import ttyFactory from "./lib/tty.js";
import cryptoFactory from "./lib/crypto.js";
import zlibFactory from "./lib/zlib.js";
import urlPublicFactory from "./lib/url.js";
import querystringFactory from "./lib/querystring.js";
import internalQuerystringFactory from "./internal/querystring.js";

// http (Phase 2 #8): Node's real lib/http.js + _http_* on stream + net + the
// pure-JS internalBinding('http_parser'), plus small support shims/stubs.
import httpFactory from "./lib/http.js";
import httpCommonFactory from "./lib/_http_common.js";
import httpIncomingFactory from "./lib/_http_incoming.js";
import httpOutgoingFactory from "./lib/_http_outgoing.js";
import httpServerFactory from "./lib/_http_server.js";
import httpClientFactory from "./lib/_http_client.js";
import httpAgentFactory from "./lib/_http_agent.js";
import internalHttpFactory from "./internal/http.js";
import freelistFactory from "./internal/freelist.js";
import httpsFactory from "./lib/https.js";
import tlsFactory from "./lib/tls.js";
import undiciFactory from "./internal/deps/undici/undici.js";

// Compatibility fill-ins (consolidation): commonly-required builtins that used to
// throw. dns is loopback-aware (unblocks vendored net.js hostname connect);
// punycode is vendored verbatim; the rest are small, faithful implementations.
import dnsFactory from "./lib/dns.js";
import punycodeFactory from "./lib/punycode.js";
import timersPromisesFactory from "./lib/timers/promises.js";
import consoleFactory from "./lib/console.js";
import constantsFactory2 from "./lib/constants.js";
import readlineFactory from "./lib/readline.js";
import fsPromisesFactory from "./lib/fs/promises.js";
import perfHooksFactory from "./lib/perf_hooks.js";
import v8Factory from "./lib/v8.js";
import vmFactory from "./lib/vm.js";
import fastUtf8StreamFactory from "./lib/fast-utf8-stream.js";
import fsDirFactory from "./internal/fs/dir.js";
import http2Factory from "./lib/http2.js";
// Bridge so the vendored fs.js `fs.promises` getter (require('internal/fs/promises')
// .exports) resolves to the same pragmatic promises API as require('fs/promises').
const internalFsPromisesFactory = (exports, require, module) => {
  module.exports = { exports: require("fs/promises") };
};

// `inspector` / `inspector/promises` — inert stub (no V8 inspector in-sandbox).
const inspectorFactory = (exports, require, module, process) => {
  const EventEmitter = require("events");
  class Session extends EventEmitter {
    connect() {}
    connectToMainThread() {}
    disconnect() {}
    post(method, params, callback) {
      const cb = typeof params === "function" ? params : callback;
      if (typeof cb === "function") {
        const err = new Error("The inspector is not available");
        err.code = "ERR_INSPECTOR_NOT_AVAILABLE";
        process.nextTick(() => cb(err));
      }
    }
  }
  module.exports = {
    Session,
    Network: { requestWillBeSent() {}, responseReceived() {}, loadingFinished() {}, loadingFailed() {}, dataReceived() {} },
    console: globalThis.console,
    open() {},
    close() {},
    url() {
      return undefined;
    },
    waitForDebugger() {},
  };
};

// WASI preview1 runtime (Phase 2 #16 stage 1): run wasm32-wasi commands over
// our VFS via require('wasi').
import wasiFactory from "./lib/wasi.js";
// worker_threads shim (Phase 2 #16 stage 2a): lets napi-rs wasm wrappers load.
import workerThreadsFactory from "./lib/worker_threads.js";

// Vendored third-party (not a Node core module): real node-semver, used by the
// npm program (Phase 2 #10 stage 2). Lazy — only instantiated when required.
import semverFactory from "./vendor/semver.js";
// Vendored @napi-rs/wasm-runtime (Phase 2 #16 stage 2a): the emnapi host that
// runs N-API addons compiled to wasm32-wasi. Lazy — only when an addon needs it.
import napiWasmRuntimeFactory from "./vendor/napi-wasm-runtime.js";

// name -> factory. Public builtins (e.g. "path") and internals ("internal/...")
// live in the same table, just like Node's builtin id space.
const FACTORIES = {
  path: pathFactory,
  buffer: bufferFactory,
  fs: fsFactory,
  events: eventsFactory,
  util: utilPublicFactory,
  "util/types": utilTypesFactory,
  "internal/constants": constantsFactory,
  "internal/validators": validatorsFactory,
  "internal/errors": errorsFactory,
  "internal/util": utilFactory,
  "internal/util/types": utilTypesFactory,
  "internal/util/inspect": utilInspectFactory,
  "internal/util/debuglog": utilDebuglogFactory,
  "internal/util/colors": utilColorsFactory,
  "internal/util/comparisons": utilComparisonsFactory,
  "internal/util/parse_args/parse_args": parseArgsFactory,
  "internal/util/parse_args/utils": parseArgsUtilsFactory,
  "internal/buffer": internalBufferFactory,
  "internal/v8/startup_snapshot": startupSnapshotFactory,
  "internal/options": optionsFactory,
  "internal/fs/utils": fsUtilsFactory,
  "internal/fs/read/context": fsReadContextFactory,
  "internal/fs/watchers": fsWatchersFactory,
  "internal/fs/streams": fsStreamsFactory,
  "internal/url": urlFactory,
  "internal/blob": blobFactory,
  "internal/file": fileFactory,
  "internal/process/permission": permissionFactory,
  "internal/assert": assertFactory,
  assert: assertPublicFactory,
  // `assert/strict` is the strict-mode variant the public module exposes as `.strict`.
  "assert/strict": (exports, require, module) => {
    module.exports = require("assert").strict;
  },
  "internal/events/abort_listener": abortListenerFactory,
  "internal/event_target": eventTargetFactory,
  "internal/process/task_queues": taskQueuesFactory,
  "internal/streams/utils": streamsUtilsFactory,
  "internal/abort_controller": abortControllerFactory,
  "internal/encoding": encodingFactory,
  stream: streamFactory,
  "stream/promises": streamPromisesFactory,
  // `stream/web` = the WHATWG streams, which the host realm provides as globals.
  // @edge-runtime/primitives (pulled by Next.js) does `require('stream/web')`.
  "stream/web": (exports, require, module) => {
    const g = globalThis;
    const pick = {};
    for (const name of [
      "ReadableStream", "ReadableStreamDefaultReader", "ReadableStreamBYOBReader",
      "ReadableStreamDefaultController", "ReadableByteStreamController", "ReadableStreamBYOBRequest",
      "WritableStream", "WritableStreamDefaultWriter", "WritableStreamDefaultController",
      "TransformStream", "TransformStreamDefaultController",
      "ByteLengthQueuingStrategy", "CountQueuingStrategy",
      "TextEncoderStream", "TextDecoderStream", "CompressionStream", "DecompressionStream",
    ]) {
      if (typeof g[name] !== "undefined") pick[name] = g[name];
    }
    module.exports = pick;
  },
  "internal/streams/legacy": streamsLegacyFactory,
  "internal/streams/destroy": streamsDestroyFactory,
  "internal/streams/state": streamsStateFactory,
  "internal/streams/from": streamsFromFactory,
  "internal/streams/end-of-stream": streamsEndOfStreamFactory,
  "internal/streams/add-abort-signal": streamsAddAbortSignalFactory,
  "internal/streams/readable": streamsReadableFactory,
  "internal/streams/writable": streamsWritableFactory,
  "internal/streams/duplex": streamsDuplexFactory,
  "internal/streams/duplexify": streamsDuplexifyFactory,
  "internal/streams/transform": streamsTransformFactory,
  "internal/streams/passthrough": streamsPassthroughFactory,
  "internal/streams/pipeline": streamsPipelineFactory,
  "internal/streams/compose": streamsComposeFactory,
  "internal/streams/operators": streamsOperatorsFactory,
  "internal/streams/duplexpair": streamsDuplexpairFactory,
  "internal/webstreams/adapters": webstreamsAdaptersFactory,
  string_decoder: stringDecoderFactory,
  async_hooks: asyncHooksFactory,
  net: netFactory,
  "internal/net": internalNetFactory,
  "internal/stream_base_commons": streamBaseCommonsFactory,
  "internal/async_hooks": internalAsyncHooksFactory,
  "internal/timers": internalTimersFactory,
  "internal/perf/observe": perfObserveFactory,
  timers: timersFactory,
  diagnostics_channel: diagnosticsChannelFactory,
  cluster: clusterFactory,
  tty: ttyFactory,
  crypto: cryptoFactory,
  zlib: zlibFactory,
  url: urlPublicFactory,
  querystring: querystringFactory,
  "internal/querystring": internalQuerystringFactory,
  http: httpFactory,
  _http_common: httpCommonFactory,
  _http_incoming: httpIncomingFactory,
  _http_outgoing: httpOutgoingFactory,
  _http_server: httpServerFactory,
  _http_client: httpClientFactory,
  _http_agent: httpAgentFactory,
  "internal/http": internalHttpFactory,
  "internal/freelist": freelistFactory,
  https: httpsFactory,
  tls: tlsFactory,
  "internal/deps/undici/undici": undiciFactory,
  dns: dnsFactory,
  // `dns/promises` is the same promise API dns.js already exposes as `.promises`.
  "dns/promises": (exports, require, module) => {
    module.exports = require("dns").promises;
  },
  // `inspector` — there is no V8 inspector in this sandbox, so this is an inert
  // stub. Real tools require it defensively (Next.js reads `inspector.url()` /
  // `inspector.console`); the debugging surface is simply unavailable.
  inspector: inspectorFactory,
  "inspector/promises": inspectorFactory,
  punycode: punycodeFactory,
  "timers/promises": timersPromisesFactory,
  console: consoleFactory,
  constants: constantsFactory2,
  readline: readlineFactory,
  "readline/promises": readlineFactory,
  "fs/promises": fsPromisesFactory,
  "internal/fs/promises": internalFsPromisesFactory,
  perf_hooks: perfHooksFactory,
  v8: v8Factory,
  vm: vmFactory,
  "internal/streams/fast-utf8-stream": fastUtf8StreamFactory,
  "internal/fs/dir": fsDirFactory,
  http2: http2Factory,
  wasi: wasiFactory,
  worker_threads: workerThreadsFactory,
  semver: semverFactory,
  "@napi-rs/wasm-runtime": napiWasmRuntimeFactory,
};

const strip = (name) => (name.startsWith("node:") ? name.slice(5) : name);

export function createNodeModules({ process, syscalls, netLiveness, netServers, codec, cryptoCodec, hostAsyncHooks, pipeBridge }) {
  const internalBinding = createInternalBinding({ syscalls, process, netLiveness, netServers, codec, cryptoCodec, hostAsyncHooks, pipeBridge });
  const modules = new Map(); // id -> module object (kept for cycle resolution)

  function nodeRequire(name) {
    const id = strip(name);
    const existing = modules.get(id);
    if (existing) return existing.exports; // done, or partial during a cycle
    const factory = FACTORIES[id];
    if (!factory) {
      throw new Error(`OpenContainer: no vendored Node builtin '${id}'`);
    }
    const module = { exports: {} };
    modules.set(id, module); // register BEFORE running so cycles see the partial
    factory(module.exports, nodeRequire, module, process, internalBinding, primordials);
    return module.exports;
  }

  return {
    require: nodeRequire,
    /** True if `name` is served by the vendored Node lib (public ids only). */
    has: (name) => Object.prototype.hasOwnProperty.call(FACTORIES, strip(name)),
    /** The internalBinding seam — exposed so the legacy `process.binding(name)`
     *  shim (index.js) can delegate to the same bindings (e.g. constants). */
    internalBinding,
  };
}
