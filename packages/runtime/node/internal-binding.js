// internalBinding — the seam Node's lib/ uses to reach its C++ core.
//
// In real Node, `internalBinding('fs')` returns the native (C++) module. In
// Vivari (Path B), THIS is where we substitute our own implementations:
// JS shims, Wasm codecs, or calls down to the Rust VFS via the sync bridge. The
// JS layer above the binding line (Node's real lib/) stays unmodified.
//
// Bindings are added as each real lib/ module comes online: 'buffer' (codecs),
// with 'fs' (Rust VFS), 'zlib', etc. to follow.

import { createBufferBinding } from "./bindings/buffer.js";
import { createFsBinding } from "./bindings/fs.js";
import { createNetBindings } from "./bindings/net.js";
import { createBlockListBindings } from "./bindings/block-list.js";
import { createHttpParserBinding } from "./bindings/http_parser.js";
import { createZlibBinding, ZLIB_CONSTANTS } from "./bindings/zlib.js";
import { createCryptoBinding } from "./bindings/crypto.js";
import { OS_SIGNALS, OS_ERRNO, OS_PRIORITY, OS_DLOPEN, UV_UDP_REUSEADDR, FS_CONSTANTS, CRYPTO_CONSTANTS } from "./bindings/constants.js";

// Node's v8::PropertyFilter values used by getOwnNonIndexProperties.
const ALL_PROPERTIES = 0;
const ONLY_ENUMERABLE = 2;

function getOwnNonIndexProperties(obj, filter) {
  const isIndex = (k) => /^(?:0|[1-9]\d*)$/.test(k) && Number(k) <= 0xffffffff;
  const keep = (d) => (filter === ONLY_ENUMERABLE ? d.enumerable : true);
  const out = [];
  for (const k of Object.getOwnPropertyNames(obj)) {
    if (isIndex(k)) continue;
    if (keep(Object.getOwnPropertyDescriptor(obj, k))) out.push(k);
  }
  for (const s of Object.getOwnPropertySymbols(obj)) {
    if (keep(Object.getOwnPropertyDescriptor(obj, s))) out.push(s);
  }
  return out;
}

export function createInternalBinding({ syscalls, process, netLiveness, netServers, codec, cryptoCodec, hostAsyncHooks, pipeBridge, queueClose } = {}) {
  // net (Phase 2 #7/#8): tcp_wrap/stream_wrap/uv/pipe_wrap/cares_wrap for the
  // in-process loopback beneath Node's real lib/net.js. Needs process.nextTick.
  // `syscalls` lets listen() register the port with the kernel (external routing,
  // stage 2); `netServers` counts kernel-registered listeners for `doNet`;
  // `pipeBridge` carries cross-process UNIX-socket AND TCP traffic through the
  // kernel (Nitro's :3000 proxying to its SSR worker's port in another process).
  const net = createNetBindings({ process, liveness: netLiveness, syscalls, netServers, pipeBridge, queueClose });
  // http_parser (Phase 2 #8): real llhttp-in-Wasm with a pure-JS fallback. When
  // the Wasm backend is live, advertise it via process.versions.llhttp (as real
  // Node does), which also lets guest code / spikes confirm the backend.
  const httpParserBinding = createHttpParserBinding();
  if (
    httpParserBinding.backend === "wasm" &&
    httpParserBinding.llhttpVersion &&
    process &&
    process.versions &&
    process.versions.llhttp == null
  ) {
    process.versions.llhttp = String(httpParserBinding.llhttpVersion);
  }
  const REALM_SYMBOLS = {
    owner_symbol: Symbol("owner_symbol"),
    async_id_symbol: Symbol("async_id_symbol"),
    trigger_async_id_symbol: Symbol("trigger_async_id_symbol"),
  };

  const bindings = {
    buffer: createBufferBinding(),
    // 'fs' needs the sync-bridge syscalls (to reach the Rust VFS) and process
    // (to defer async callbacks onto nextTick).
    fs: syscalls ? createFsBinding({ sys: syscalls, process }) : undefined,
    tcp_wrap: net.tcp_wrap,
    stream_wrap: net.stream_wrap,
    uv: net.uv,
    pipe_wrap: net.pipe_wrap,
    cares_wrap: net.cares_wrap,
    // net.BlockList / net.SocketAddress. C++ in Node, so the vendored
    // internal/blocklist.js and internal/socketaddress.js are the real bodies and
    // only this half is ours.
    block_list: createBlockListBindings(),
    // http_parser (Phase 2 #8): real llhttp (Wasm) beneath lib/http, JS fallback.
    http_parser: httpParserBinding,
    // zlib (Phase 2 #11): Node's real lib/zlib.js over the Rust/Wasm codec.
    // crc32/constants work without the codec; the stream handle needs `codec`.
    zlib: createZlibBinding({ makeZStream: codec || null, process }),
    // crypto (Phase 2 #12): our lib/crypto.js over the Rust/Wasm crypto codec.
    // digest md5/sha1/sha256 fall back to pure-JS when the codec is absent.
    crypto: createCryptoBinding({ codec: cryptoCodec || null }),
    // async_hooks_host: when this runtime runs on a real Node worker (headless /
    // Node twin), the host exposes genuine async-context tracking (PromiseHook).
    // internal/async_hooks delegates AsyncLocalStorage to it so context survives
    // across awaits — required by Next.js App Router (RSC workStore). Null in the
    // browser realm, where the sync-scope polyfill is used instead.
    async_hooks_host: hostAsyncHooks || null,
    // trace_events: inert — internal/http records HTTP trace spans through it.
    trace_events: {
      getCategoryEnabledBuffer: () => new Uint8Array(1),
      trace: () => {},
    },
    util: {
      constants: { ALL_PROPERTIES, ONLY_ENUMERABLE },
      getOwnNonIndexProperties,
      isInsideNodeModules: () => false,
      // Backs util.getCallSites(). Upstream this reads V8's stack directly; the
      // same information is reachable from here through the structured-stack API
      // that Error.prepareStackTrace exposes, which is the same V8 CallSite the
      // native version formats. Callers are loggers and error reporters wanting
      // the frame that called THEM, so the answer has to be the caller's frame,
      // not ours: the capture starts above getCallSites itself.
      //
      // scriptId is V8-internal and not reachable from JS; it is reported as the
      // empty string rather than a fabricated number, because a caller keying a
      // cache on it would be keying on a lie.
      getCallSites: (frameCount) => {
        const target = {};
        const prevPrepare = Error.prepareStackTrace;
        const prevLimit = Error.stackTraceLimit;
        try {
          Error.stackTraceLimit = frameCount;
          Error.prepareStackTrace = (_err, sites) => sites;
          Error.captureStackTrace(target, bindings.util.getCallSites);
          const sites = target.stack || [];
          return sites.slice(0, frameCount).map((s) => ({
            functionName: s.getFunctionName() || "",
            scriptId: "",
            scriptName: s.getScriptNameOrSourceURL() || s.getFileName() || "",
            lineNumber: s.getLineNumber() || 0,
            columnNumber: s.getColumnNumber() || 0,
            column: s.getColumnNumber() || 0,
          }));
        } finally {
          Error.prepareStackTrace = prevPrepare;
          Error.stackTraceLimit = prevLimit;
        }
      },
      privateSymbols: {
        untransferable_object_private_symbol: Symbol("untransferable_object"),
      },
    },
    // hasIntl=false keeps Buffer.transcode / ICU paths dormant (no icu binding).
    config: { hasIntl: false },
    // Minted per realm and read by internal/async_hooks, which used to mint them
    // itself. The identity has to be shared: lib/zlib.js and bindings/net.js both
    // find a handle's owner through the same symbol, and the vendored
    // internal/blocklist.js reaches for it through this binding.
    symbols: REALM_SYMBOLS,
    constants: {
      os: { signals: OS_SIGNALS, errno: OS_ERRNO, priority: OS_PRIORITY, dlopen: OS_DLOPEN, UV_UDP_REUSEADDR },
      fs: FS_CONSTANTS,
      crypto: CRYPTO_CONSTANTS,
      zlib: ZLIB_CONSTANTS,
    },
  };

  return function internalBinding(name) {
    if (Object.prototype.hasOwnProperty.call(bindings, name)) return bindings[name];
    throw new Error(`Vivari: internalBinding('${name}') is not implemented yet`);
  };
}
