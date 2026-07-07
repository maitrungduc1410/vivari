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
import internalBufferFactory from "./internal/buffer.js";
import startupSnapshotFactory from "./internal/v8/startup_snapshot.js";
import optionsFactory from "./internal/options.js";
import fsUtilsFactory from "./internal/fs/utils.js";
import fsReadContextFactory from "./internal/fs/read/context.js";
import urlFactory from "./internal/url.js";
import blobFactory from "./internal/blob.js";
import permissionFactory from "./internal/process/permission.js";
import assertFactory from "./internal/assert.js";
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
  "internal/buffer": internalBufferFactory,
  "internal/v8/startup_snapshot": startupSnapshotFactory,
  "internal/options": optionsFactory,
  "internal/fs/utils": fsUtilsFactory,
  "internal/fs/read/context": fsReadContextFactory,
  "internal/url": urlFactory,
  "internal/blob": blobFactory,
  "internal/process/permission": permissionFactory,
  "internal/assert": assertFactory,
  "internal/events/abort_listener": abortListenerFactory,
  "internal/event_target": eventTargetFactory,
  "internal/process/task_queues": taskQueuesFactory,
  "internal/streams/utils": streamsUtilsFactory,
  "internal/abort_controller": abortControllerFactory,
  "internal/encoding": encodingFactory,
  stream: streamFactory,
  "stream/promises": streamPromisesFactory,
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
};

const strip = (name) => (name.startsWith("node:") ? name.slice(5) : name);

export function createNodeModules({ process, syscalls }) {
  const internalBinding = createInternalBinding({ syscalls, process });
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
  };
}
