// The Bun runtime shim — a `Bun` global + `bun:*` builtin modules implemented on
// top of Vivari's Node-compatible runtime (fs/http/child_process/crypto/zlib).
//
// Bun cannot be run "for real" in the browser the way npm/yarn/pnpm are (those are
// pure-JS CLIs Vivari vendors and executes; Bun is a native Zig/JavaScriptCore
// binary). So Bun support is necessarily a SHIM: we reproduce the commonly used
// slice of Bun's documented API surface. This is the same "API-compatible drop-in"
// philosophy the toolchain aliases use, applied to a runtime instead of a package.
//
// COVERED (see below): Bun.file/write — a BunFile with the Blob read protocol
// (.text/.json/.bytes/.arrayBuffer/.stream/.slice/.size/.type), a LAZY .slice()
// that is a window rather than a copy, .delete()/.unlink(), and an incrementally
// flushing FileSink from .writer(), plus Bun.stdout/Bun.stderr as write targets
// (see bun-file.js),
// Bun.Cookie/Bun.CookieMap and the `req.cookies` hook on Bun.serve routes (see
// bun-cookie.js), Bun.serve (bridged onto Node http so it
// previews — with `routes`, `fetch`, an `error` handler, `static` route maps, a
// genuinely enforced `idleTimeout` and `maxRequestBodySize`, a real `unix`
// socket, and server-side `websocket` + pub/sub whose ping/pong are real RFC 6455
// control frames, whose cork() batches into one socket write, and whose
// handshake validates the version/key and negotiates a subprotocol instead of
// echoing the client's (see bun-serve.js), Bun.env/argv/main/version/revision,
// Bun.spawn/spawnSync/which,
// Bun.$ (shell), Bun.sleep/Bun.sleepSync (a real Atomics.wait park, see
// bun-sleep.js)/nanoseconds, automatic .env/.env.local/.env.{mode}(.local)
// loading with Bun's precedence and $VAR expansion (bun-env.js; `bun` processes
// only, never plain `node`; `bun test` uses the test file set and then defaults
// NODE_ENV), import.meta.dir/file/path/env/main/resolveSync
// (packages/runtime/esm.js, also gated on the Bun global),
// Bun.resolveSync/resolve (the `root` argument is a DIRECTORY and is honoured;
// import.meta.resolveSync's is the importing FILE), Bun.hash (real wyhash, plus
// xxHash32/64, murmur32v2/v3, murmur64v2, cityHash32/64, crc32, adler32 —
// byte-exact, with the documented number-vs-bigint return typing), Bun.CryptoHasher
// (Bun's whole 19-algorithm family, .copy()/.byteLength/static .hash()/.algorithms
// and HMAC keying — including Bun's rule that a digested HMAC is dead, not reset)
// and Bun.password (real argon2id/bcrypt emitting standard PHC / modular-crypt
// strings that round-trip with real Bun, SHA-512 pre-hashing bcrypt inputs over 72
// bytes as Bun does — see bun-crypto.js), Bun.Glob (.match(); `*` stops at `/`, `!`
// negates only at pattern start, braces nest 10 deep — plus .scan()/.scanSync(), a
// real pruning VFS walk with the documented cwd/dot/absolute/onlyFiles/
// followSymlinks/throwErrorOnBrokenSymlink options), Bun.FileSystemRouter
// (Next.js-style [param]/[...catchAll]/[[...optional]] with per-segment precedence
// — see bun-fsrouter.js), Bun.randomUUIDv7 (a real time-ordered v7, monotonic
// within a millisecond), Bun.gzipSync/…,
// Bun.inspect (incl. .table and .custom)/deepEquals (loose AND strict)/deepMatch/
// escapeHTML, Bun.pathToFileURL/fileURLToPath,
// Bun.stringWidth/stripANSI/wrapAnsi/color/indexOfLine (see bun-text.js),
// Bun.ArrayBufferSink/readableStreamTo*/concatArrayBuffers/allocUnsafe (see
// bun-bytes.js), async-generator Response bodies (inherited from the platform
// Response, no shim code — see bun-bytes.js), the data formats Bun.YAML.parse,
// Bun.TOML.parse/stringify, Bun.JSON5.parse/stringify, Bun.JSONL.parse/parseChunk
// and Bun.semver.satisfies/order (vendored real parsers — see ./bun-formats.js),
// Bun.Transpiler.transformSync/transform (the loader's own type-stripper),
// Bun.build — a REAL dependency-graph bundler (multi-file, npm deps, JSON, TS/JSX,
// ESM+CJS mixed, cycles) written against the loader's own resolver so no bundler
// need be installed, returning Bun's {success, outputs: BuildArtifact[], logs} with
// entrypoints/outdir/target/format/external/define/naming/root honoured and
// minify/splitting/sourcemap refused OUT LOUD; its OUTPUT BYTES ARE NOT IDENTICAL
// to real Bun's (no tree shaking, no minifier, CJS-shaped wrappers) — assert on
// behaviour, never on bytes — and Bun.plugin, both build-time (async) and runtime
// (sync onResolve/onLoad wired into module.js) — see bun-build.js,
// and the modules bun:test (a runner +
// expect, with Bun/Jest `test.only` filtering and beforeEach/afterEach that
// inherit into nested describes, and toEqual/toStrictEqual/toMatchObject backed
// by deepEquals/deepMatch), bun:jsc (serialize/deserialize), and bun:sqlite —
// REAL SQLite (the official sqlite.org Wasm build, driven by our own glue so it
// instantiates synchronously) over a purpose-written VFS on Vivari's positional
// fdRead/fdWrite, so a .sqlite file is an ordinary file in the tree that outlives
// the process: Database (query/prepare/run/exec/transaction with SAVEPOINT
// nesting and .deferred/.immediate/.exclusive, serialize/deserialize, WAL/readonly
// /create/strict options, `filename`, `inTransaction`), Statement (all/get/run/
// values/iterate/as/finalize/columnNames/columnTypes/paramsCount, `$foo`/`:foo`/
// `@foo` named and positional binding) and safeIntegers as BOTH a constructor
// option and a per-Database/per-Statement toggle, so 64-bit ids survive as BigInt
// instead of silently rounding past 2^53 — see bun-sqlite.js.
//
// bun:test in full (./bun-test.js, which the clause above now understates): the
// modifier family on both describe and test (.skip/.only/.todo/.each/.if/.skipIf/
// .todoIf, plus test.failing), per-test timeouts from Bun's `number | {timeout,
// retry, repeats}` third argument, `mock` with the whole jest surface
// (mockReturnValueOnce/mockResolvedValue/…, results recording THROWS, restorable
// spies and a working mock.restore()), `mock.module()` over the loader's require
// cache, the toHaveBeenCalled* / toHaveReturned* matchers, the asymmetric matchers
// (expect.any/anything/objectContaining/arrayContaining/stringContaining/
// stringMatching/closeTo, expect.not.*, expect.extend) honoured recursively inside
// toEqual/toStrictEqual/toMatchObject/toHaveBeenCalledWith, `.resolves`/`.rejects`
// carrying the FULL matcher set with negation (and tracked by the runner, so a
// forgotten `await` fails the test instead of passing), file-backed
// toMatchSnapshot() writing Bun's own .snap format byte-for-byte, and the
// `bun test` flags -t/--test-name-pattern, --bail, --timeout, --todo, -u and
// --reporter=junit|dots. Two Bun behaviours are reproduced because they exist to
// stop a suite lying: `.only` THROWS when $CI is truthy, and a MISSING snapshot is
// a failure under CI rather than something quietly created.
//
// NOT SUPPORTED — cannot ever work in a browser tab, so every one of these is
// LOUD ON CALL rather than silently wrong or silently missing. They live in
// ./bun-unsupported.js, whose header explains the pattern: the symbol EXISTS (so
// an `import { dlopen } from "bun:ffi"` or a property read still loads — a
// load-time throw would take down a project over one unused import in a
// dependency) and throws when CALLED, naming the API, the specific capability the
// sandbox lacks, and the alternative where one exists. The list: bun:ffi
// (dlopen/CFunction/linkSymbols/JSCallback/CString/ptr/toArrayBuffer/read.*/cc)
// and Bun.dlopen — no dlopen(3), no native machine code; native `.node` addons,
// which the module loader (packages/runtime/module.js) and process.dlopen now
// reject with a message naming the package and, for the popular ones, a substitute
// proven to run in-VM (NATIVE_ADDON_SUBSTITUTES) — it used to read the binary as
// UTF-8 and report `SyntaxError: Invalid or unexpected token`, on what is the most
// common hard failure a real Node project meets here; Bun.listen/Bun.connect (raw
// TCP), Bun.udpSocket (no UDP exists in a page at all) and Bun.RedisClient/
// Bun.redis (RESP3 over TCP) — a page cannot open a raw socket, and traffic that
// leaves the tab has to be HTTP(S) through fetch; Bun.SQL's Postgres and MySQL
// adapters, for the same reason, pointing at bun:sqlite; Bun.WebView (drives a
// native browser process or a CDP socket); Bun.mmap (no mmap(2) — and a
// read-into-memory copy does not alias like a mapping, which is the reason to call
// it); Bun.secrets (an OS keychain; localStorage would satisfy the signature while
// voiding the encryption-at-rest guarantee that IS the API); Bun.peek/
// Bun.peek.status (a settled promise's value lives in engine-internal state that
// no engine exposes synchronously to page code — the same wall as the bun:jsc heap
// helpers, and returning the argument unchanged is right only for a PENDING
// promise, so there is no honest partial answer); and `bun build --compile`, which
// emits a native single-file executable (packages/kernel-host/programs/bun.js).
//
// NOT IMPLEMENTED — possible here, simply not written, and worded differently on
// purpose: "stop and redesign" and "send a patch" are not the same advice, and
// conflating them wastes someone's afternoon. Bun.spawn/spawnSync with
// `terminal: true` (a pty is a tty device the kernel has no equivalent of, but a
// JavaScript pty emulation is perfectly possible; pipes are substituted for
// nobody, because an interactive CLI on a pipe takes its non-interactive branch or
// hangs); Bun.SQL's SQLite adapter (use the bun:sqlite module); Bun.build's
// minify / splitting / sourcemap / bytecode options and Bun macros (`with {type:
// "macro"}`), which THROW naming themselves rather than being dropped from a build
// that then reports success — see bun-build.js. Loud for the same narrower reason
// that the shim has not implemented them: Bun.file(fd) and
// Bun.write(fd, …) (our fd numbers are VFS handles, not OS fds — and anything
// else that is not a string or a file: URL throws too, rather than being
// String()-ed into a path like "undefined"), reading
// Bun.stdout/Bun.stderr (write-only sinks here — the process's output is
// delivered to the kernel by message, not backed by a readable file),
// Bun.Transpiler.scan/scanImports (the
// transform builds no import/export graph), Bun.hash.xxHash3/rapidhash (not
// ported, and we have no reference vector to verify a port against), and the bun:jsc
// heap-introspection helpers (no engine hook exists in a page). Bun.password
// throws without the Rust/Wasm crypto codec rather than falling back: argon2id and
// bcrypt have no JavaScript stand-in, and a hash that is not really one of them
// verifies nowhere. Note Bun.CryptoHasher rejects "blake3" — that is not a gap,
// real Bun has no blake3 either, and accepting it here would break sandbox code on
// the first real `bun` run. In bun:sqlite, Database.loadExtension and
// Database.fileControl throw (both need a native SQLite: loadable extensions are
// .so/.dylib files, and fileControl is a raw pointer ABI), and so does
// Database.setCustomSQLite (there is no system libsqlite3 to point at). Also loud:
// the CSS Color 4 function space in Bun.color — lab()/lch()/oklab()/oklch()/
// color() throw rather than returning the `null` that means "not a colour"
// (bun-text.js); a Bun.FileSystemRouter `style` other than "nextjs", a page file
// whose brackets do not parse, two page files resolving to the SAME route (Next.js
// calls that a project error, and picking a winner by directory-iteration order is
// not a shim's call), and .match() on a Request/Response whose `url` is "" (which
// would otherwise quietly resolve to the index route) — bun-fsrouter.js. Likewise
// Bun.Glob.scan({followSymlinks: true}) against a filesystem with no realpathSync:
// there is no cycle guard without it, and the failure is a walk that never returns
// rather than a wrong answer — bun-glob.js. And four in bun:test (bun-test.js):
// toMatchInlineSnapshot() with NO argument, which would have to rewrite the user's
// source and has no trustworthy call-site position to do it from (the loader
// transpiles TS before compiling); snapshotting a Map or a Set NESTED in a
// container, where Bun's own bytes are malformed and not self-consistent between
// the two, so writing tidier ones would produce a .snap that fails under real Bun;
// `setSystemTime()`, which has no clock seam to hook; and mock.module() against a
// BUILTIN — real Bun leaves the builtin silently unmocked there, and asserting
// against the real module while believing it is mocked is the one outcome this
// shim will not produce.
//
// Bun.serve({ http3 }) throws: HTTP/3 is QUIC over UDP, a browser tab has no UDP
// socket, and answering HTTP/1.1 to code written for HTTP/3 would be a silent
// approximation of a wire protocol (bun-serve.js).
//
// COVERED BUT SLOWER, not wrong: Bun.allocUnsafe returns zero-filled memory,
// because `new Uint8Array(n)` is specified to be — see bun-bytes.js.
//
// ACCEPTED BUT DEGRADED, announced once per process on the console rather than
// ignored (bun-serve.js): Bun.serve({ tls }) serves plaintext — there is no
// network hop inside the VM and the preview rides the page's own origin, and
// throwing would refuse to boot every app that merely HAS a production
// certificate configured; `reusePort` cannot load-balance one port across
// processes when there is only one; `ipv6Only` has no dual-stack socket to
// restrict on an IPv4-only loopback; `websocket.perMessageDeflate` and the
// `compress` argument to send()/publish() do nothing, because no
// Sec-WebSocket-Extensions is negotiated; and a `websocket.drain` handler is
// wired to real backpressure but will not fire, because the in-VM loopback
// completes every write synchronously and so never builds any (measured: 25 MB
// into an unread socket, getBufferedAmount() never left 0). Bun.serve({ unix })
// binds a REAL socket that in-VM clients can reach, but the browser preview
// cannot see it — the Service Worker finds servers by TCP port.
//
// NOT SUPPORTED, and the largest remaining gap: STREAMING responses. A Response
// whose body is a ReadableStream is fully buffered before anything is written.
// This is not fixable in this file — the kernel's OP_RESPOND carries a `total`
// byte count that the kernel reassembles against before resolving a
// one-shot Promise, and the Service Worker builds a buffered Response from it.
// SSE and WebSockets reach the browser only through dedicated postMessage side
// channels (vv-sse / vv-ws) that bypass Service-Worker fetch entirely. Said here
// because a half-streaming implementation — one that streams in the sandbox and
// buffers in production — would be worse than this honest buffering. Note that
// `idleTimeout` IS enforced, so a long-lived endpoint no longer runs forever
// here and gets cut off in production.
//
// A documented divergence in the WebSocket write path: Bun's send()/publish()
// return 0 to mean "dropped for backpressure". We never return 0 on a live
// connection, because a Node socket QUEUES rather than drops — the message
// really is going to be sent, and reporting it as dropped would be a lie in the
// other direction. -1 (closed) and the byte count are as documented.
//
// COVERED WITH A DOCUMENTED DIVERGENCE: Bun.gc() is a no-op returning undefined
// (page JavaScript has no GC control; real Bun collects and returns the heap size
// after). It stays a no-op rather than joining the loud tier above because
// forcing a collection is advisory by nature — code calls it to be tidy, and
// failing the call would break a program that is otherwise fine — but a caller
// that USES the return value gets undefined, so it is recorded here.
// Bun.stdin is a Node Readable, not a
// BunFile (see the Bun literal below); Bun.file(…).type omits the
// `;charset=utf-8` suffix real Bun appends to textual types (bun-file.js); a
// BunFile is not a platform Blob INSTANCE (Bun's extends Blob), so
// `new Response(Bun.file(p))` stringifies instead of streaming — use
// `new Response(Bun.file(p).stream())`, and see bun-file.js for why neither
// duck-typing nor `extends Blob` is portable between Node and the browser Worker;
// `sameSite: "none"` is serialised without an implicit `Secure`, exactly as Bun
// does, so the browser is what rejects it (bun-cookie.js); and `req.cookies`
// exists only on the BunRequest a `routes` handler receives, which is where Bun
// documents it — a `fetch` handler builds its own
// `new Bun.CookieMap(req.headers.get("cookie"))`. And three in bun:sqlite, all
// consequences of the sandbox rather than of the shim (bun-sqlite.js documents
// each at its call site): xSync is a no-op because Vivari's fsync/fdatasync are
// (fs.js:314) — a rollback journal is still written and replayed, so a crash
// mid-transaction recovers, but nothing is forced to durable storage, so power
// loss is not survivable the way real SQLite promises; there is no file locking,
// which is what the upstream Emscripten build ships too (its default VFS is
// literally `unix-none`, and its POSIX lock stubs report every file unlocked), so
// two processes writing the SAME database concurrently can corrupt it — one
// writer is safe, many readers are safe; and `journal_mode = WAL` cannot be
// honoured (WAL needs mmap'd shared memory across processes), so it warns once and
// SQLite stays in its `delete` journal mode, which is what SQLite itself does when
// a VFS declines WAL.

import { transpileTypeScript } from "../typescript-transform.js";
// The data-format, text/terminal, bytes/streams, hash and glob members live in
// their own files: this one is already long, and each group is self-contained
// pure computation pinned by its own checks. See the header of each for why they
// are not inline here, and bun-formats.js in particular for the vendoring
// rationale per format.
import { createBunFormats } from "./bun-formats.js";
import { createBunText } from "./bun-text.js";
import { createBunBytes } from "./bun-bytes.js";
import * as hashes from "./bun-hash.js";
import { createBunGlob } from "./bun-glob.js";
import { createBunFileSystemRouter } from "./bun-fsrouter.js";
import { createSleepSync } from "./bun-sleep.js";
import { loadBunEnvFiles } from "./bun-env.js";
import { Cookie, CookieMap, attachRequestCookies, pendingSetCookies } from "./bun-cookie.js";
import { createBunFile } from "./bun-file.js";
import { createBunCrypto } from "./bun-crypto.js";
import { createBunSqlite, createVivariSqliteHost } from "./bun-sqlite.js";
import { createBunTest } from "./bun-test.js";
import {
  normalizeServeOptions,
  compileStaticRoutes,
  validateUpgradeRequest,
  negotiateSubprotocol,
  buildHandshakeResponse,
  wsFrameProtocolError,
  WS_GUID,
} from "./bun-serve.js";
// The APIs a browser tab cannot provide, plus the `.node` native-addon message.
// They live in a sibling for the usual reason (this file is long), but also
// because they are the one group with no implementation to read: the file is the
// catalogue of what is impossible here and what to use instead, and it is worth
// being readable as exactly that. See its header for the import-safe/call-loud
// pattern and for why "not supported" and "not implemented" are worded apart.
import { createBunUnsupported, createBunFfi, assertNoPty } from "./bun-unsupported.js";
// Bun.build (a real dependency-graph bundler) + Bun.plugin. See its header for
// why the bundler is ours rather than esbuild-wasm, and for the standing caveat
// that the output bytes are NOT identical to real Bun's.
import { createBunBuild } from "./bun-build.js";

// The two documented Bun.hash members we did not port. The message names the
// algorithm and says why, in the same spirit as the bun:ffi one: a caller who hits
// this needs to know it is absent, not that "something went wrong".
const HASH_UNSUPPORTED = (name) =>
  `Bun.hash.${name}() is not implemented in the Vivari shim. The other members ` +
  `(wyhash, crc32, adler32, xxHash32/64, murmur32v2/v3, murmur64v2, cityHash32/64) ` +
  `are byte-exact; ${name} is omitted rather than approximated because we have no ` +
  `reference vector to verify a port against.`;

// ---- version identity -------------------------------------------------------
// The single definition of what this shim claims to be. `Bun.revision` is derived
// from the version rather than being its own literal: `bun --revision` prints the
// same string (packages/kernel-host/programs/bun.js), and the two used to disagree
// ("vivari-shim" here vs "1.1.34-vivari" there). Real Bun prints a git SHA; we
// cannot, so we print something that is at least self-consistent and obviously a
// shim. The CLI program cannot import this (it is embedded as a template literal
// with no interpolation), so it carries a fallback literal that
// scripts/spike-bun-offline.mjs asserts against BUN_VERSION.
export const BUN_VERSION = "1.1.34";
export const BUN_REVISION = BUN_VERSION + "-vivari";

const TRANSPILER_SCAN_UNSUPPORTED = (method) =>
  "Bun.Transpiler." +
  method +
  "() is not implemented in the Vivari shim: it is backed by the loader's " +
  "type-stripping transform, which does not parse an import/export graph. It " +
  "used to return an empty result, which was indistinguishable from a file with " +
  "no imports.";

// `require` is rooted at "/" (packages/runtime/index.js). `makeCwdRequire()` builds one
// rooted at the running process's working directory, so a bare specifier finds the
// PROJECT's node_modules rather than only /node_modules — see the note at the bun:sqlite
// entry in the modules object below. It is a factory rather than a require so it is built
// at the moment of use and therefore honours a `process.chdir()`, and it is optional so a
// caller that has only the root require (tests, older embedders) still works.
export function createBunRuntime({ process, Buffer, require, makeCwdRequire, resolveFrom }) {
  const lazy = (name) => require(name);

  // Bun.build / Bun.plugin (./bun-build.js). `resolveFrom` is the module loader's
  // own resolveFilename: the bundler walks the graph with it so a bundle contains
  // exactly what `require` would have loaded here.
  const builder = createBunBuild({ lazy, process, warn: (key, message) => serveWarnOnce("build:" + key, message), resolveFrom });

  // Text/terminal and bytes/streams member groups (packages/runtime/builtins/
  // bun-text.js, bun-bytes.js). Constructing these is cheap — the vendored Unicode
  // tables inside bun-text.js are instantiated on first use, not here.
  const text = createBunText({ lazy, process });
  const bytes = createBunBytes({ Buffer });
  // Glob and FileSystemRouter take `lazy`/`process` because their scan half walks
  // the VFS (one synchronous syscall per directory) — the matcher halves stay pure
  // and are unit-tested with no kernel. FileSystemRouter's scan IS Glob's walker.
  const { Glob } = createBunGlob({ lazy, process });
  const FileSystemRouter = createBunFileSystemRouter({ lazy, process });

  // ---- BunFile ---------------------------------------------------------------
  // `Bun.file()`, `Bun.write()`, the incremental `FileSink` from `.writer()` and
  // the `Bun.stdout`/`Bun.stderr` write targets all live in ./bun-file.js — bulk
  // implementation in a sibling, the same shape as the format/text/bytes/hash
  // groups above. Read its header for the three contracts that file exists to
  // keep: `.slice()` stays a lazy view, the FileSink flushes as it goes rather
  // than buffering the whole file until `end()`, and every write is chunked to
  // the 1 MiB syscall window.
  //
  // `Bun.file(fd)` still throws (Phase 0): our fd numbers are VFS handles owned
  // by the runtime, not OS file descriptors, so there is no file to wrap.
  const files = createBunFile({ lazy, Buffer, process });
  const bunFile = files.bunFile;
  const bunWrite = files.bunWrite;

  // ---- Bun.serve -------------------------------------------------------------
  // Bun.serve is Bun's HTTP entry point. We back it with Node's real http.Server so
  // an in-VM Bun app is previewed by the SAME Service-Worker proxy that previews
  // Node servers (runtime/index.js `bridgeHttp`). We adapt each Node req/res to a
  // WHATWG Request/Response, which Bun's handlers expect. Supported:
  //   - `fetch(req, server)`              catch-all request handler
  //   - `routes`                          static/param/wildcard route map (BunRequest.params)
  //   - `websocket` + `server.upgrade()`  server-side WebSockets (real RFC-6455 over the
  //                                        Node http `upgrade` event) + pub/sub topics
  // The browser preview reaches an in-VM ws server through a postMessage tunnel that
  // ends in a genuine loopback WebSocket client (runtime/websocket.js), so the server
  // side has to do the real 101 handshake + framing here.
  function bunServe(options) {
    const http = lazy("http");
    const opts = options || {};
    let fetchHandler = typeof opts.fetch === "function" ? opts.fetch : null;
    let routes = compileRoutes(opts.routes);
    let wsHandlers = opts.websocket && typeof opts.websocket === "object" ? opts.websocket : null;
    // Bun's documented `error(err)` hook. It gets the throw from `fetch`/a route
    // handler and returns the Response to render; returning nothing (or throwing)
    // falls back to the plain 500 below, which is what this always did before.
    let errorHandler = typeof opts.error === "function" ? opts.error : null;
    if (!fetchHandler && !routes && !wsHandlers) {
      throw new TypeError("Bun.serve requires a `fetch` handler or `routes`");
    }
    // Every documented option gets a deliberate answer here — implemented,
    // degraded loudly, or thrown. See ./bun-serve.js for which and why. This
    // throws for `http3` and for out-of-range `idleTimeout`/`maxRequestBodySize`,
    // so a bad value fails at Bun.serve() rather than at the first request.
    const { config, warnings } = normalizeServeOptions(opts);
    for (const w of warnings) serveWarnOnce(w.key, w.message);
    const hostname = config.hostname;
    const port = config.port;
    let staticRoutes = config.staticRoutes;
    const maxRequestBodySize = config.maxRequestBodySize;
    // Bun's idleTimeout is in seconds; Node's socket.setTimeout is milliseconds,
    // and 0 means "no timeout" in both.
    const idleTimeoutMs = config.idleTimeout * 1000;
    // `websocket.perMessageDeflate` and `send(msg, compress)` both ask for
    // permessage-deflate (RFC 7692). We never offer Sec-WebSocket-Extensions in
    // the handshake, so no extension is negotiated and compression is simply not
    // happening. Warning once here is the difference between "my frames are
    // smaller in production" and a silent 3x bandwidth surprise.
    // `drain` is wired to the socket's real 'drain' event and the real return
    // value of write() — it does NOT fire unconditionally, which is what it used
    // to do (never, in fact: it was never called at all). But it also will not
    // fire in practice here, and that is worth saying rather than leaving an
    // author to discover it: Vivari's loopback (node/bindings/net.js `doWrite`)
    // hands every write straight to the peer's inbox and reports it complete
    // synchronously, so there is no send queue to overflow, write() never returns
    // false, and getBufferedAmount() stays 0. Verified by writing 25 MB into an
    // unread socket. Under real Bun this handler carries real load-shedding
    // logic, so code that depends on it must be exercised there.
    if (wsHandlers && typeof wsHandlers.drain === "function") {
      serveWarnOnce(
        "drain",
        "Bun.serve({ websocket: { drain } }) is wired up correctly but will not fire in Vivari: " +
          "the in-VM loopback completes every socket write synchronously, so a WebSocket never " +
          "builds backpressure and getBufferedAmount() stays 0. Your handler is not dead code " +
          "under real Bun — it just has nothing to react to here.",
      );
    }
    if (wsHandlers && wsHandlers.perMessageDeflate) {
      serveWarnOnce(
        "perMessageDeflate",
        "Bun.serve({ websocket: { perMessageDeflate } }) is accepted but ignored: this shim " +
          "negotiates no Sec-WebSocket-Extensions, so frames are sent uncompressed. The " +
          "`compress` argument to ws.send()/publish() is ignored for the same reason.",
      );
    }

    // Pub/sub topic registry: topic -> Set<ServerWebSocket>.
    const topics = new Map();
    const allSockets = new Set();
    const publishToSelf = !!(wsHandlers && wsHandlers.publishToSelf);
    // Bun documents publish() as returning the number of BYTES published (0 when
    // nothing was delivered), not the number of recipients — `subscriberCount()`
    // is the API for that. `opcode` forces text/binary for publishText/Binary;
    // undefined lets toWsPayload pick from the JS type, as plain publish() does.
    function topicPublish(topic, message, exclude, opcode) {
      const set = topics.get(topic);
      if (!set || !set.size) return 0;
      const framed = opcode === undefined ? toWsPayload(message, Buffer) : { opcode, payload: toBuf(message, Buffer) };
      let delivered = 0;
      for (const ws of set) {
        if (ws === exclude || ws.readyState !== 1) continue;
        ws._sendFrame(framed.opcode, framed.payload);
        delivered++;
      }
      return delivered ? framed.payload.length : 0;
    }

    function cloneResponse(r) { try { return r.clone(); } catch { return r; } }

    async function writeResponse(res, response, request) {
      res.statusCode = response.status || 200;
      // Set-Cookie is the one header that is legitimately repeated, and
      // Headers.forEach FLATTENS repeats into a single comma-joined value — which
      // silently corrupts cookies, because an `Expires=Thu, 01 Jan 1970 …` value
      // contains a comma of its own and cannot be split back apart. Pull the
      // set-cookie list out with getSetCookie() (the API that exists for exactly
      // this) and hand Node the array, which emits one header line each.
      const setCookies = [];
      try {
        if (typeof response.headers.getSetCookie === "function") {
          setCookies.push(...response.headers.getSetCookie());
          response.headers.forEach((v, k) => {
            if (String(k).toLowerCase() !== "set-cookie") res.setHeader(k, v);
          });
        } else {
          response.headers.forEach((v, k) => res.setHeader(k, v));
        }
      } catch {}
      // Cookies the handler changed on `req.cookies` become Set-Cookie headers on
      // the way out, appended to (never replacing) whatever the Response carried.
      // Applying them here rather than on the Response object is deliberate: a
      // Response.redirect() has immutable headers, and Bun still sets cookies on
      // a redirect.
      try { setCookies.push(...pendingSetCookies(request)); } catch {}
      if (setCookies.length) res.setHeader("Set-Cookie", setCookies);
      const ab = await response.arrayBuffer();
      res.end(Buffer.from(new Uint8Array(ab)));
    }

    // Route + fetch dispatch. Returns a Promise<Response|undefined>.
    function dispatch(request, method) {
      return Promise.resolve().then(() => {
        const pathname = new URL(request.url).pathname;
        // `static` is checked before `routes`, on an exact pathname only, which
        // is Bun's precedence. The stored Response is cloned per request because
        // a Response body can only be consumed once.
        if (staticRoutes) {
          const hit = staticRoutes.get(pathname);
          if (hit !== undefined) return cloneResponse(hit);
        }
        if (routes) {
          const m = matchRoute(routes, pathname, method);
          if (m) {
            if (m.response !== undefined) return cloneResponse(m.response);
            request.params = m.params;
            // `cookies` belongs to BunRequest — the object a `routes` handler
            // gets — and NOT to the plain Request a `fetch` handler gets. That
            // split is Bun's, and reproducing it matters more than convenience:
            // attaching `req.cookies` inside `fetch` would make code that works
            // here fail under real Bun. In a `fetch` handler the documented route
            // is `new Bun.CookieMap(req.headers.get("cookie"))` plus
            // `toSetCookieHeaders()`, the same as for any non-Bun server.
            attachRequestCookies(request, request.headers.get("cookie"));
            return m.handler(request, inst);
          }
        }
        if (fetchHandler) return fetchHandler(request, inst);
        return undefined;
      });
    }

    const server = http.createServer((req, res) => {
      const host = req.headers.host || hostname + ":" + port;
      const urlStr = "http://" + host + (req.url || "/");
      const method = (req.method || "GET").toUpperCase();
      const collect = (cb) => {
        if (method === "GET" || method === "HEAD") return cb(null);
        const parts = [];
        let received = 0;
        let aborted = false;
        req.on("data", (c) => {
          if (aborted) return;
          const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
          received += chunk.length;
          // `maxRequestBodySize` enforced as the body arrives, not after: the
          // point of the limit is to NOT hold an oversized body in the VM's
          // heap, so buffering it first and then complaining would defeat it.
          // 413 is the documented answer; the socket is torn down because the
          // client is still sending and there is nothing left to read it into.
          if (received > maxRequestBodySize) {
            aborted = true;
            try {
              res.statusCode = 413;
              res.setHeader("content-type", "text/plain");
              res.end("Request body exceeds maxRequestBodySize of " + maxRequestBodySize + " bytes");
            } catch {}
            try { req.destroy(); } catch {}
            return;
          }
          parts.push(chunk);
        });
        req.on("end", () => { if (!aborted) cb(Buffer.concat(parts)); });
        req.on("error", () => { if (!aborted) cb(null); });
      };
      collect((body) => {
        let request;
        try {
          request = new Request(urlStr, { method, headers: req.headers, body: body && body.length ? body : undefined });
        } catch {
          // Some runtimes forbid a body on a GET Request even when undefined; retry bare.
          request = new Request(urlStr, { method, headers: req.headers });
        }
        dispatch(request, method)
          .then(async (response) => {
            if (!response) { res.statusCode = 404; res.end("Not Found"); return; }
            await writeResponse(res, response, request);
          })
          .catch((err) =>
            resolveServeError(errorHandler, err)
              .then((response) => (res.headersSent ? res.end() : writeResponse(res, response, request)))
              .catch(() => { try { res.statusCode = 500; res.end("Bun.serve handler error"); } catch {} })
          );
      });
    });

    // ---- server-side WebSocket ----------------------------------------------
    // Node's http server emits `upgrade` (req, socket, head) for `Connection:
    // Upgrade` requests. Bun's model performs the upgrade decision inside `fetch`
    // via `server.upgrade(req)`, so we run the fetch handler here and complete the
    // 101 handshake + framing if it opted in.
    const upgradeCtx = new Map(); // request -> { req, socket, head, done }

    // Bun's documented default cap on an inbound message. Enforced with close
    // code 1009 rather than by growing the buffer until the VM runs out of heap.
    const maxPayloadLength = (wsHandlers && wsHandlers.maxPayloadLength) || 16 * 1024 * 1024;

    class ServerWebSocket {
      constructor(socket, data) {
        this._socket = socket;
        this.data = data;
        this.readyState = 1; // OPEN
        // The genuine peer address of the loopback socket. Unlike requestIP()
        // this is not fabricated — an in-VM client really did connect from
        // 127.0.0.1 — so it is reported as-is.
        this.remoteAddress = (socket && socket.remoteAddress) || "127.0.0.1";
        this.binaryType = "arraybuffer";
        this._subs = new Set();
        this._buf = Buffer.alloc(0);
        this._fragOpcode = 0;
        this._fragChunks = [];
        this._fragActive = false;
        this._fragLen = 0;
        // cork() batching state and the backpressure flag that drives `drain`.
        this._corkDepth = 0;
        this._corkBuf = null;
        this._backpressure = false;
      }
      get subscriptions() { return Array.from(this._subs); }

      // ---- the write path ----------------------------------------------------
      // All frames go through here so that cork() can batch them and so that one
      // place decides what backpressure means.
      _enqueue(buf) {
        if (this._corkDepth > 0) { this._corkBuf.push(buf); return true; }
        return this._flushWrite(buf);
      }
      _flushWrite(buf) {
        try {
          // Node's write() returns false once the socket's buffer is over its
          // high-water mark. That is the ONLY honest backpressure signal we have,
          // and it is what makes `drain` meaningful rather than unconditional.
          if (this._socket.write(buf) === false) this._backpressure = true;
          return true;
        } catch { return false; }
      }
      // Bun documents send() as: -1 if the connection is closed, 0 if the message
      // was dropped for backpressure, otherwise the byte count. We never return 0:
      // a Node socket QUEUES rather than drops, so the message really is going to
      // be sent and reporting it as dropped would be a lie in the other direction.
      // Backpressure is observable via getBufferedAmount() and the `drain` handler.
      _sendFrame(opcode, payload) {
        if (this.readyState !== 1) return -1;
        return this._enqueue(encodeWsFrame(Buffer, opcode, payload, false)) ? payload.length : 0;
      }
      send(message, _compress) {
        const { opcode, payload } = toWsPayload(message, Buffer);
        return this._sendFrame(opcode, payload);
      }
      // Bun's explicit-opcode variants. They exist because toWsPayload() picks the
      // opcode from the JS type, and callers sometimes need to force it — a string
      // sent as binary, or bytes sent as text.
      sendText(message, _compress) {
        return this._sendFrame(0x1, Buffer.from(String(message), "utf8"));
      }
      sendBinary(message, _compress) {
        return this._sendFrame(0x2, toBuf(message, Buffer));
      }
      // ---- control frames ----------------------------------------------------
      // These were empty no-ops, so a keepalive loop looked healthy and sent
      // nothing: the peer saw an idle connection and dropped it. RFC 6455 §5.5
      // caps a control-frame payload at 125 bytes and forbids fragmenting it.
      _controlFrame(opcode, data, name) {
        if (this.readyState !== 1) return -1;
        const payload = data === undefined || data === null ? Buffer.alloc(0) : toBuf(data, Buffer);
        if (payload.length > 125) {
          throw new RangeError(
            "ws." + name + "() payload cannot exceed 125 bytes (RFC 6455 §5.5), got " + payload.length,
          );
        }
        return this._enqueue(encodeWsFrame(Buffer, opcode, payload, false)) ? payload.length : 0;
      }
      ping(data) { return this._controlFrame(0x9, data, "ping"); }
      pong(data) { return this._controlFrame(0xa, data, "pong"); }

      close(code, reason) {
        if (this.readyState === 3 || this.readyState === 2) return;
        this.readyState = 2;
        let payload = Buffer.alloc(0);
        if (typeof code === "number") {
          const r = reason ? Buffer.from(String(reason), "utf8") : Buffer.alloc(0);
          payload = Buffer.alloc(2 + r.length); payload.writeUInt16BE(code, 0); r.copy(payload, 2);
        }
        try { this._socket.write(encodeWsFrame(Buffer, 0x8, payload, false)); } catch {}
        try { this._socket.end(); } catch {}
        this._closed(typeof code === "number" ? code : 1000, reason || "", true);
      }
      // Bun's abrupt counterpart to close(): drop the connection without the
      // closing handshake. 1006 is the code RFC 6455 §7.4.1 reserves for exactly
      // this "connection closed abnormally, no close frame" case.
      terminate() {
        if (this.readyState === 3) return;
        try { this._socket.destroy(); } catch {}
        this._closed(1006, "", false);
      }

      subscribe(topic) { if (!topics.has(topic)) topics.set(topic, new Set()); topics.get(topic).add(this); this._subs.add(topic); return true; }
      unsubscribe(topic) { this._subs.delete(topic); const s = topics.get(topic); if (s) { s.delete(this); if (!s.size) topics.delete(topic); } return true; }
      isSubscribed(topic) { return this._subs.has(topic); }
      publish(topic, message, _compress) { return topicPublish(topic, message, publishToSelf ? null : this); }
      publishText(topic, message, _compress) { return topicPublish(topic, String(message), publishToSelf ? null : this, 0x1); }
      publishBinary(topic, message, _compress) { return topicPublish(topic, message, publishToSelf ? null : this, 0x2); }

      // How many bytes are queued in the socket but not yet flushed. Real Node
      // state, not a guess, so `while (ws.getBufferedAmount() > N) await drain`
      // actually terminates.
      getBufferedAmount() {
        try { return this._socket.writableLength | 0; } catch { return 0; }
      }
      // cork() batches every frame written inside the callback into ONE socket
      // write. It used to just invoke the callback, which is why it "worked" and
      // saved nothing. Nesting is tracked so only the outermost cork flushes.
      cork(cb) {
        if (this._corkDepth === 0) this._corkBuf = [];
        this._corkDepth++;
        try {
          return cb(this);
        } finally {
          this._corkDepth--;
          if (this._corkDepth === 0) {
            const chunks = this._corkBuf;
            this._corkBuf = null;
            if (chunks && chunks.length) this._flushWrite(Buffer.concat(chunks));
          }
        }
      }
      // Called from the socket's own 'drain' event — i.e. when the kernel buffer
      // has genuinely emptied, not on a timer and not unconditionally.
      _onDrain() {
        if (!this._backpressure) return;
        this._backpressure = false;
        if (wsHandlers && wsHandlers.drain) {
          try { wsHandlers.drain(this); } catch (e) { if (wsHandlers.error) wsHandlers.error(this, e); }
        }
      }

      // ---- the read path -----------------------------------------------------
      _onData(chunk) {
        this._buf = Buffer.concat([this._buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        for (;;) {
          const r = readWsFrame(Buffer, this._buf);
          if (!r) break;
          if (r.oversized) {
            this._failProtocol({ code: 1009, reason: "frame length exceeds 2^32 bytes" });
            return;
          }
          this._buf = r.rest;
          if (this._handleFrame(r.frame) === false) return;
        }
      }
      // Fail the connection per RFC 6455 §7.1.7: send a Close with the status
      // code, then drop it. Returns false so _onData stops parsing the rest of a
      // buffer we have already decided is untrustworthy.
      _failProtocol(err) {
        const r = Buffer.from(err.reason || "", "utf8");
        const payload = Buffer.alloc(2 + r.length);
        payload.writeUInt16BE(err.code, 0);
        r.copy(payload, 2);
        try { this._socket.write(encodeWsFrame(Buffer, 0x8, payload, false)); } catch {}
        try { this._socket.end(); } catch {}
        this._closed(err.code, err.reason || "", false);
        return false;
      }
      _handleFrame(frame) {
        // Every inbound frame is checked against the rules a SERVER has to
        // enforce before it is acted on: masking, RSV bits, control-frame size,
        // fragmentation order, and maxPayloadLength. See ./bun-serve.js.
        const err = wsFrameProtocolError(frame, {
          fragmented: this._fragActive,
          maxPayloadLength,
          receivedLength: this._fragLen,
        });
        if (err) return this._failProtocol(err);

        const { fin, opcode, payload } = frame;
        if (opcode === 0x8) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
          try { this._socket.write(encodeWsFrame(Buffer, 0x8, payload.length >= 2 ? payload : Buffer.alloc(0), false)); } catch {}
          try { this._socket.end(); } catch {}
          this._closed(code, reason, true); return false;
        }
        if (opcode === 0x9) {
          // RFC 6455 §5.5.2: a pong MUST carry the ping's payload. Bun also
          // surfaces the ping to the app, which we now do too.
          try { this._socket.write(encodeWsFrame(Buffer, 0xa, payload, false)); } catch {}
          this._invoke("ping", payload);
          return true;
        }
        if (opcode === 0xa) { this._invoke("pong", payload); return true; }

        if (opcode === 0x1 || opcode === 0x2) { this._fragOpcode = opcode; this._fragChunks = [payload]; this._fragLen = payload.length; }
        else { this._fragChunks.push(payload); this._fragLen += payload.length; }
        this._fragActive = !fin;
        if (!fin) return true;
        const full = this._fragChunks.length === 1 ? this._fragChunks[0] : Buffer.concat(this._fragChunks);
        this._fragChunks = [];
        this._fragLen = 0;
        const isText = this._fragOpcode === 0x1;
        const msg = isText ? full.toString("utf8") : full.buffer.slice(full.byteOffset, full.byteOffset + full.byteLength);
        if (wsHandlers && wsHandlers.message) { try { wsHandlers.message(this, msg); } catch (e) { if (wsHandlers.error) wsHandlers.error(this, e); else throw e; } }
        return true;
      }
      // A handler that is optional in Bun: absent means the frame is simply not
      // surfaced, which is not an error.
      _invoke(name, payload) {
        if (!wsHandlers || typeof wsHandlers[name] !== "function") return;
        try { wsHandlers[name](this, payload); } catch (e) { if (wsHandlers.error) wsHandlers.error(this, e); }
      }
      _closed(code, reason, clean) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        for (const t of Array.from(this._subs)) this.unsubscribe(t);
        allSockets.delete(this);
        inst.pendingWebSockets = allSockets.size;
        if (wsHandlers && wsHandlers.close) { try { wsHandlers.close(this, code, reason); } catch (e) { if (wsHandlers.error) wsHandlers.error(this, e); } }
      }
    }

    function finishUpgrade(ctx, extraHeaders, data) {
      const crypto = lazy("crypto");
      // RFC 6455 §4.2.1: reject a version we do not speak (426, advertising 13)
      // and a missing/malformed key (400) BEFORE computing an Accept the client
      // would reject anyway. This used to accept anything and hash whatever was
      // there, including the empty string.
      const refusal = validateUpgradeRequest(ctx.req.headers);
      if (refusal) {
        let head = "HTTP/1.1 " + refusal.status + " " + refusal.statusText + "\r\nConnection: close\r\n";
        for (const k of Object.keys(refusal.headers)) head += k + ": " + refusal.headers[k] + "\r\n";
        try { ctx.socket.write(head + "\r\n" + refusal.reason); } catch {}
        try { ctx.socket.destroy(); } catch {}
        return null;
      }
      const key = String(ctx.req.headers["sec-websocket-key"] || "").trim();
      const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");

      // Collect the caller's upgrade headers once, so the subprotocol they asked
      // for can be negotiated against what the CLIENT offered and then emitted
      // exactly once. Previously the client's first offer was echoed blindly AND
      // the caller's header was appended, producing two Sec-WebSocket-Protocol
      // lines whenever both were present.
      const extraPairs = [];
      let offered = null;
      if (extraHeaders) {
        try {
          const h = extraHeaders instanceof Headers ? extraHeaders : new Headers(extraHeaders);
          h.forEach((v, k) => {
            if (String(k).toLowerCase() === "sec-websocket-protocol") offered = v;
            else extraPairs.push([k, v]);
          });
        } catch {}
      }
      const protocol = negotiateSubprotocol(ctx.req.headers["sec-websocket-protocol"], offered);
      try { ctx.socket.write(buildHandshakeResponse(accept, protocol, extraPairs)); } catch {}

      const ws = new ServerWebSocket(ctx.socket, data);
      ws.protocol = protocol || "";
      allSockets.add(ws);
      inst.pendingWebSockets = allSockets.size;
      // A WebSocket is long-lived by design, so the HTTP idle timeout must not
      // apply to it. Bun has a separate `websocket.idleTimeout`; when it is not
      // set the connection is left alone rather than being killed by the request
      // timeout, which is what an app expects from a socket it is holding open.
      const wsIdle = wsHandlers && wsHandlers.idleTimeout;
      try { ctx.socket.setTimeout(typeof wsIdle === "number" ? wsIdle * 1000 : 0); } catch {}
      if (typeof wsIdle === "number" && wsIdle > 0) {
        ctx.socket.on("timeout", () => { try { ws.close(1001, "idle timeout"); } catch {} });
      }
      ctx.socket.on("data", (chunk) => ws._onData(chunk));
      ctx.socket.on("drain", () => ws._onDrain());
      ctx.socket.on("close", () => ws._closed(1006, "", false));
      ctx.socket.on("error", () => ws._closed(1006, "", false));
      if (ctx.head && ctx.head.length) ws._onData(ctx.head);
      if (wsHandlers && wsHandlers.open) { try { wsHandlers.open(ws); } catch (e) { if (wsHandlers.error) wsHandlers.error(ws, e); } }
      return ws;
    }

    const inst = {
      port,
      hostname,
      development: !!opts.development,
      url: safeUrl("http://localhost:" + port + "/"),
      stop() {
        for (const ws of Array.from(allSockets)) { try { ws.close(1001); } catch {} }
        try { server.close(); } catch {}
      },
      reload(next) {
        next = next || {};
        if (typeof next.fetch === "function") fetchHandler = next.fetch;
        if (next.routes) routes = compileRoutes(next.routes);
        if (next.static) staticRoutes = compileStaticRoutes(next.static);
        if (next.websocket) wsHandlers = next.websocket;
        if (typeof next.error === "function") errorHandler = next.error;
      },
      // Called synchronously inside `fetch` to hand a request off to the websocket
      // handler. Returns true if this request is being upgraded.
      upgrade(request, upOpts) {
        const ctx = upgradeCtx.get(request);
        if (!ctx || ctx.done) return false;
        ctx.done = true;
        // A handshake we refused (bad version/key) is not an upgrade. Returning
        // true there would make the caller `return` from `fetch` with nothing to
        // serve on a socket that is already gone.
        return finishUpgrade(ctx, upOpts && upOpts.headers, upOpts && upOpts.data) !== null;
      },
      publish(topic, message, _compress) { return topicPublish(topic, message, null); },
      publishText(topic, message, _compress) { return topicPublish(topic, String(message), null, 0x1); },
      publishBinary(topic, message, _compress) { return topicPublish(topic, message, null, 0x2); },
      subscriberCount(topic) { const s = topics.get(topic); return s ? s.size : 0; },
      // Bun's own types make this `SocketAddress | null`, and null is the honest
      // answer here. It used to return a hard-coded 127.0.0.1 for every caller,
      // which is not a harmless placeholder: a rate limiter or an audit log keyed
      // on requestIP() silently treats every visitor on Earth as one client, and
      // it does so while looking like it works. Real peer addresses do not
      // survive the Service-Worker preview hop — the kernel forwards a request
      // object, not a socket — so there is nothing true to report.
      requestIP() { return null; },
      get pendingRequests() { return 0; },
      pendingWebSockets: 0,
    };
    if (config.id !== undefined) inst.id = config.id;

    if (wsHandlers || fetchHandler) {
      server.on("upgrade", (req, socket, head) => {
        const host = req.headers.host || hostname + ":" + port;
        const urlStr = "http://" + host + (req.url || "/");
        let request;
        try { request = new Request(urlStr, { method: "GET", headers: req.headers }); }
        catch { try { socket.destroy(); } catch {} return; }
        const ctx = { req, socket, head, request, done: false };
        upgradeCtx.set(request, ctx);
        const decide = fetchHandler
          ? Promise.resolve().then(() => fetchHandler(request, inst))
          : Promise.resolve().then(() => { inst.upgrade(request); });
        decide
          .then(() => {
            if (!ctx.done) {
              try { socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nWebSocket upgrade failed"); } catch {}
              try { socket.destroy(); } catch {}
            }
          })
          .catch(() => { try { socket.destroy(); } catch {} })
          .finally(() => upgradeCtx.delete(request));
      });
    }

    // idleTimeout, genuinely enforced. This matters more than it looks: an
    // ignored idleTimeout means a long-lived endpoint (SSE, a slow upload) runs
    // fine in the sandbox and is silently cut off in production, and the symptom
    // — a stream that just stops — points nowhere near the cause. Vivari's net.js
    // is Node's real one, so setTimeout() on the accepted socket genuinely fires.
    if (idleTimeoutMs > 0) {
      server.on("connection", (socket) => {
        socket.setTimeout(idleTimeoutMs, () => {
          // An idle HTTP connection is closed, not reset: anything already
          // written still reaches the client.
          try { socket.end(); } catch {}
        });
      });
    }

    // `unix` binds a real UNIX-domain socket (Vivari's net layer has a working
    // Pipe binding). normalizeServeOptions has already warned that this is not
    // reachable from the browser preview, which finds servers by port.
    if (config.unix) {
      inst.unix = config.unix;
      inst.url = safeUrl("unix://" + config.unix);
      server.listen({ path: config.unix });
    } else {
      server.listen(port, hostname);
    }
    return inst;
  }

  // ---- Bun.$ (shell) ---------------------------------------------------------
  // A small tagged-template shell. Interpolations are shell-escaped. The returned
  // value is a thenable resolving to { exitCode, stdout, stderr } with Bun's
  // .text()/.json()/.quiet()/.nothrow() helpers.
  function makeShell() {
    const run = (strings, exprs, opts) => {
      const cp = lazy("child_process");
      let cmd = "";
      for (let i = 0; i < strings.length; i++) {
        cmd += strings[i];
        if (i < exprs.length) cmd += shellEscape(exprs[i]);
      }
      let nothrow = !!(opts && opts.nothrow);
      let quiet = !!(opts && opts.quiet);
      const exec = () =>
        new Promise((resolve, reject) => {
          const child = cp.spawn("sh", ["-c", cmd], { cwd: process.cwd(), env: process.env });
          const outParts = [];
          const errParts = [];
          if (child.stdout) child.stdout.on("data", (d) => { outParts.push(toBuf(d, Buffer)); if (!quiet) process.stdout.write(d); });
          if (child.stderr) child.stderr.on("data", (d) => { errParts.push(toBuf(d, Buffer)); if (!quiet) process.stderr.write(d); });
          child.on("error", reject);
          child.on("close", (code) => {
            const stdout = Buffer.concat(outParts);
            const stderr = Buffer.concat(errParts);
            const result = {
              exitCode: code | 0,
              stdout,
              stderr,
              text: () => stdout.toString("utf8"),
              json: () => JSON.parse(stdout.toString("utf8")),
            };
            if (code !== 0 && !nothrow) {
              const e = new Error("Command failed with exit code " + code + ": " + cmd);
              Object.assign(e, result);
              reject(e);
            } else resolve(result);
          });
        });
      const promise = exec();
      promise.quiet = () => { quiet = true; return promise; };
      promise.nothrow = () => { nothrow = true; return promise; };
      promise.text = async () => (await promise).text();
      promise.json = async () => (await promise).json();
      return promise;
    };
    const $ = (strings, ...exprs) => run(strings, exprs, {});
    $.braces = (s) => [s];
    $.escape = shellEscape;
    return $;
  }

  // ---- Bun.spawn / spawnSync / which ----------------------------------------
  function bunSpawn(cmdOrOpts, maybeOpts) {
    const cp = lazy("child_process");
    let cmd, opts;
    if (Array.isArray(cmdOrOpts)) { cmd = cmdOrOpts; opts = maybeOpts || {}; }
    else { opts = cmdOrOpts || {}; cmd = opts.cmd || []; }
    // `terminal: true` asks for a pty. We have none, and quietly giving the child
    // pipes instead is the failure that hangs an interactive CLI — see
    // ./bun-unsupported.js.
    assertNoPty("Bun.spawn()", opts);
    const [file, ...args] = cmd;
    const child = cp.spawn(file, args, {
      cwd: opts.cwd || process.cwd(),
      env: opts.env || process.env,
    });
    // Bun types `.stdout`/`.stderr` as ReadableStream, so we do have to adapt the
    // Node stream — but NOT with `Readable.toWeb`. That is the obvious one-liner
    // and it is a trap, the same one documented at length in bun-file.js:
    // node/internal/webstreams/adapters.js implements only `fromWeb` and leaves
    // `toWeb` as a function that raises ERR_METHOD_NOT_IMPLEMENTED. So the
    // natural `Readable.toWeb ? … : …` guard is TRUE and then throws — and it
    // throws from Bun.spawn() itself, meaning every Bun.spawn call failed in the
    // VM while the offline tier (host Node, where toWeb works) stayed green.
    // Feature-detecting by presence is the bug; we adapt by hand instead.
    const web = (nodeStream) => {
      if (!nodeStream) return nodeStream;
      if (typeof ReadableStream !== "function") return nodeStream;
      return new ReadableStream({
        start(controller) {
          nodeStream.on("data", (c) => {
            try { controller.enqueue(c instanceof Uint8Array ? c : new Uint8Array(toBuf(c, Buffer))); } catch {}
          });
          nodeStream.on("end", () => { try { controller.close(); } catch {} });
          nodeStream.on("error", (e) => { try { controller.error(e); } catch {} });
        },
        cancel() { try { nodeStream.destroy(); } catch {} },
      });
    };
    return {
      pid: child.pid,
      stdout: web(child.stdout),
      stderr: web(child.stderr),
      stdin: child.stdin,
      kill: (sig) => child.kill(sig),
      exited: new Promise((resolve) => child.on("close", (code) => resolve(code | 0))),
    };
  }
  function bunSpawnSync(cmdOrOpts, maybeOpts) {
    const cp = lazy("child_process");
    let cmd, opts;
    if (Array.isArray(cmdOrOpts)) { cmd = cmdOrOpts; opts = maybeOpts || {}; }
    else { opts = cmdOrOpts || {}; cmd = opts.cmd || []; }
    assertNoPty("Bun.spawnSync()", opts);
    const [file, ...args] = cmd;
    const r = cp.spawnSync(file, args, { cwd: opts.cwd || process.cwd(), env: opts.env || process.env });
    return {
      pid: 0,
      exitCode: r.status | 0,
      success: r.status === 0,
      stdout: r.stdout ? toBuf(r.stdout, Buffer) : Buffer.alloc(0),
      stderr: r.stderr ? toBuf(r.stderr, Buffer) : Buffer.alloc(0),
    };
  }
  function bunWhich(cmd, opts) {
    const fs = lazy("fs");
    const dirs = String((opts && opts.PATH) || process.env.PATH || "/bin").split(":").filter(Boolean);
    for (const d of dirs) {
      for (const suffix of ["", ".js"]) {
        const p = d + "/" + cmd + suffix;
        try { if (fs.statSync(p).isFile()) return p; } catch {}
      }
    }
    return null;
  }

  // ---- hashing / crypto ------------------------------------------------------
  // Bun.hash is wyhash, and the digests are part of its contract: people put them
  // in cache keys and shard ids, so "stable within this process" is not good
  // enough. The algorithms live in bun-hash.js (they are bulk, and each one has to
  // be byte-exact); this block is just the wiring, and its job is to get the two
  // things the digest cannot tell you about right — the return TYPE and the seed.
  //
  // Documented typing, which we reproduce exactly: 32-bit hashes return a
  // `number`, 64-bit hashes return a `bigint`. That distinction is load-bearing.
  // `Bun.hash("x") + 1` throws a TypeError under real Bun (you cannot mix BigInt
  // and Number) and a shim that hands back a Number instead makes that line
  // "work" here and fail in production — the same class of bug as everything else
  // in this file's history. A bare Bun.hash() is wyhash, so it is a bigint too.
  function bunHash(data, seed) {
    return hashes.wyhash(toBuf(data, Buffer), seed);
  }
  bunHash.wyhash = (data, seed) => hashes.wyhash(toBuf(data, Buffer), seed);
  bunHash.xxHash32 = (data, seed) => hashes.xxHash32(toBuf(data, Buffer), seed);
  bunHash.xxHash64 = (data, seed) => hashes.xxHash64(toBuf(data, Buffer), seed);
  bunHash.murmur32v2 = (data, seed) => hashes.murmur32v2(toBuf(data, Buffer), seed);
  bunHash.murmur32v3 = (data, seed) => hashes.murmur32v3(toBuf(data, Buffer), seed);
  bunHash.murmur64v2 = (data, seed) => hashes.murmur64v2(toBuf(data, Buffer), seed);
  // cityHash32 takes no seed at all in Bun's typings — `(data) => number`. We
  // accept one and ignore it (the reference implementation has no seeded form)
  // rather than inventing a seeded variant nothing else would agree with.
  bunHash.cityHash32 = (data) => hashes.cityHash32(toBuf(data, Buffer));
  bunHash.cityHash64 = (data, seed) => hashes.cityHash64(toBuf(data, Buffer), seed);
  // xxHash3 and rapidhash are documented members we have NOT ported. XXH3 is a
  // much bigger construction than everything else here combined, and rapidhash is
  // not in Zig's standard library, so there is no reference we can pin a
  // known-answer test against — and an unverified hash is exactly the bug this
  // change removes. Loud beats plausible-looking; same tier as bun:ffi.
  bunHash.xxHash3 = () => { throw new Error(HASH_UNSUPPORTED("xxHash3")); };
  bunHash.rapidhash = () => { throw new Error(HASH_UNSUPPORTED("rapidhash")); };
  bunHash.crc32 = (data) => {
    const buf = toBuf(data, Buffer);
    let crc = ~0;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (~crc) >>> 0;
  };
  bunHash.adler32 = (data) => {
    const buf = toBuf(data, Buffer);
    let a = 1, b = 0;
    for (let i = 0; i < buf.length; i++) { a = (a + buf[i]) % 65521; b = (b + a) % 65521; }
    return ((b << 16) | a) >>> 0;
  };

  // Bun.CryptoHasher and Bun.password (bun-crypto.js). Both are real: the hasher
  // covers Bun's whole documented algorithm family with HMAC keying and Bun's
  // consumed-HMAC semantics, and the password functions are genuine argon2id and
  // bcrypt emitting PHC / modular-crypt strings that round-trip with real Bun.
  const { CryptoHasher, password } = createBunCrypto({ lazy, Buffer, process });

  // ---- misc helpers ----------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms instanceof Date ? Math.max(0, ms - Date.now()) : ms));
  // A real park on Atomics.wait (see ./bun-sleep.js), not the spin this used to
  // be: same elapsed time, without holding a core at 100% for the duration.
  const sleepSync = createSleepSync();
  const startNs = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  const nanoseconds = () => Math.round(((typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) - startNs) * 1e6);

  // Bun.resolveSync(specifier, root) / Bun.resolve(...) — `root` is the DIRECTORY
  // to resolve from ("To resolve relative to the directory containing the current
  // file, pass import.meta.dir"), not the importing file; import.meta.resolveSync
  // takes the importing file instead and is documented as
  // `Bun.resolveSync(id, path.dirname(parent))`, which is why esm.js takes a
  // dirname and this does not. `root` used to be accepted and then dropped, so
  // every call resolved from the runtime's own base instead: a real-looking
  // absolute path to a different file, which is the exact failure mode this shim
  // is not allowed to have. With no resolver at all we throw rather than echo the
  // specifier back, for the same reason — Bun throws when it cannot resolve.
  const bunResolveSync = (id, root) => {
    if (!require.resolve) {
      throw new Error(
        "Bun.resolveSync is unavailable: the Bun global was created on a require with no " +
          "resolver attached, so module specifiers cannot be resolved in this process"
      );
    }
    if (root === undefined || root === null) return require.resolve(id);
    return require.resolve(id, { paths: [String(root)] });
  };

  const deepEquals = (a, b, strict) => bunDeepEquals(a, b, !!strict);
  const deepMatch = (subset, object) => bunDeepMatch(subset, object);
  const escapeHTML = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

  const zlibSync = (name) => (data, opts) => {
    const zlib = lazy("zlib");
    return new Uint8Array(zlib[name](toBuf(data, Buffer), opts || {}));
  };

  function fileURLToPath(url) {
    const u = typeof url === "string" ? url : url.href;
    let p = u.replace(/^file:\/\//, "");
    try { p = decodeURIComponent(p); } catch {}
    return p || "/";
  }
  function pathToFileURL(p) { return safeUrl("file://" + p); }

  // ---- the Bun global --------------------------------------------------------
  const formats = createBunFormats({ process });
  const unsupported = createBunUnsupported();
  const Bun = {
    version: BUN_VERSION,
    revision: BUN_REVISION,
    get env() { return process.env; },
    get argv() { return process.argv; },
    get main() { return process.argv && process.argv[1] ? process.argv[1] : ""; },
    file: bunFile,
    write: bunWrite,
    serve: bunServe,
    $: makeShell(),
    spawn: bunSpawn,
    spawnSync: bunSpawnSync,
    which: bunWhich,
    sleep,
    sleepSync,
    nanoseconds,
    hash: bunHash,
    CryptoHasher,
    password,
    deepEquals,
    deepMatch,
    Glob,
    FileSystemRouter,
    // Cookies (./bun-cookie.js). Defaults are path "/" + SameSite=Lax, both
    // always emitted; `Bun.serve` routes get `req.cookies`.
    Cookie,
    CookieMap,
    escapeHTML,
    // Data formats (see ./bun-formats.js). Real parsers, not approximations:
    // Bun.TOML.parse throws on an integer it cannot hold losslessly, Bun.YAML.parse
    // returns an array for multi-document input, and Bun.JSONL's two entry points
    // report errors differently on purpose.
    YAML: formats.YAML,
    TOML: formats.TOML,
    JSON5: formats.JSON5,
    JSONL: formats.JSONL,
    semver: formats.semver,
    // Bun.inspect keeps delegating to util.inspect, but is now a function object
    // carrying .table and .custom (see bun-text.js).
    inspect: text.inspect,
    // Text / terminal (bun-text.js).
    stringWidth: text.stringWidth,
    stripANSI: text.stripANSI,
    wrapAnsi: text.wrapAnsi,
    indexOfLine: text.indexOfLine,
    color: text.color,
    // Bytes / streams (bun-bytes.js).
    ArrayBufferSink: bytes.ArrayBufferSink,
    readableStreamToArray: bytes.readableStreamToArray,
    readableStreamToArrayBuffer: bytes.readableStreamToArrayBuffer,
    readableStreamToBytes: bytes.readableStreamToBytes,
    readableStreamToBlob: bytes.readableStreamToBlob,
    readableStreamToText: bytes.readableStreamToText,
    readableStreamToJSON: bytes.readableStreamToJSON,
    readableStreamToFormData: bytes.readableStreamToFormData,
    concatArrayBuffers: bytes.concatArrayBuffers,
    allocUnsafe: bytes.allocUnsafe,
    gzipSync: zlibSync("gzipSync"),
    gunzipSync: zlibSync("gunzipSync"),
    deflateSync: zlibSync("deflateSync"),
    inflateSync: zlibSync("inflateSync"),
    fileURLToPath,
    pathToFileURL,
    resolveSync: (id, root) => bunResolveSync(id, root),
    resolve: async (id, root) => bunResolveSync(id, root),
    randomUUIDv7: (encoding, timestamp) => randomUUIDv7(lazy("crypto"), Buffer, encoding, timestamp),
    // Bun.stdin stays the Node stream this shim has always returned, which is a
    // known divergence (Bun's is a BunFile) kept on purpose: guest code here
    // reads stdin with .on("data")/async iteration off the SAB-backed stream, and
    // a BunFile wrapper would take that away to add a .text() we cannot make
    // block. Bun.stdout/Bun.stderr ARE BunFiles, because their whole job in Bun's
    // API is being a Bun.write() destination (`Bun.write(Bun.stdout, file)`) — see
    // ./bun-file.js. Their read half throws rather than answering "".
    get stdin() { return process.stdin; },
    get stdout() { return files.stdout; },
    get stderr() { return files.stderr; },
    // GC / memory introspection: no-ops (no manual GC exposed in the sandbox).
    gc: () => {},
    // A thin Transpiler shim over the same TS transform the loader uses.
    Transpiler: makeTranspilerClass(),
    // Bundling + plugins (./bun-build.js). Output is NOT byte-identical to Bun's.
    build: builder.build,
    plugin: builder.plugin,
    // ---- the surface a browser cannot provide (./bun-unsupported.js) ---------
    // Present as real values so a property read, a destructure or an
    // `import { x } from` still works, and loud on CALL with a message that names
    // the API, the specific missing capability, and the alternative. These were
    // all simply `undefined` before, which produced "Bun.udpSocket is not a
    // function" from deep inside a dependency and explained nothing.
    listen: unsupported.listen,
    connect: unsupported.connect,
    udpSocket: unsupported.udpSocket,
    RedisClient: unsupported.RedisClient,
    redis: unsupported.redis,
    SQL: unsupported.SQL,
    sql: unsupported.sql,
    WebView: unsupported.WebView,
    mmap: unsupported.mmap,
    peek: unsupported.peek,
    secrets: unsupported.secrets,
    dlopen: unsupported.dlopen,
  };

  // ---- bun:* modules ---------------------------------------------------------
  const modules = {
    "bun:test": createBunTest({ process, lazy, deepEquals: bunDeepEquals, deepMatch: bunDeepMatch }),
    "bun:jsc": makeBunJsc(),
    "bun:ffi": createBunFfi(),
    // Real SQLite on the vendored sqlite3.wasm, over a custom VFS backed by Vivari's
    // synchronous fs — see ./bun-sqlite.js for the whole design, including what is
    // honestly missing (fsync, locking, WAL). Nothing is loaded until the first
    // `new Database()`: this call only builds the host descriptor.
    "bun:sqlite": createBunSqlite(createVivariSqliteHost({ require, makeCwdRequire, process })),
  };

  // ---- automatic .env loading (see ./bun-env.js) ------------------------------
  // Bun reads `.env`, `.env.{mode}`, `.env.local` and `.env.{mode}.local` at
  // startup; our "startup" is the moment the Bun runtime is installed into a
  // process (index.js's __ocInstallBun), which only ever happens for a `bun`
  // process. It is deliberately NOT done for `node`: automatic loading is Bun's
  // behaviour, not Node's — Node requires an explicit `--env-file` — and Bun
  // itself turns it off when invoked AS node (`bun --bun`, a `node` symlink), for
  // the same reason we do. Once per process; a second install is a no-op.
  //
  // `mode` forces the file set instead of deriving it from NODE_ENV; `bun test` is
  // the one caller that needs it, because Bun picks the `test` set before NODE_ENV
  // is defaulted to "test" (see kernel-host/programs/bun.js).
  let dotenvLoaded = null;
  function loadDotenv(mode) {
    if (dotenvLoaded) return dotenvLoaded;
    const fs = lazy("fs");
    dotenvLoaded = loadBunEnvFiles({
      env: process.env,
      cwd: process.cwd(),
      mode,
      readFile: (p) => {
        try { return fs.readFileSync(p, "utf8"); } catch { return null; }
      },
    });
    return dotenvLoaded;
  }

  return { Bun, modules, loadDotenv };

  function makeTranspilerClass() {
    return class Transpiler {
      constructor(opts) { this._opts = opts || {}; }
      transformSync(code, loaderOrOpts) {
        const loader = typeof loaderOrOpts === "string" ? loaderOrOpts : (this._opts.loader || "tsx");
        const ext = loader === "ts" ? ".ts" : loader === "jsx" ? ".jsx" : loader === "js" ? ".js" : ".tsx";
        return transpileTypeScript(code, "input" + ext);
      }
      async transform(code, loader) { return this.transformSync(code, loader); }
      // scan()/scanImports() used to return hard-coded empties, which reads as "this
      // file imports nothing" — a wrong answer a caller cannot detect. The transform
      // in typescript-transform.js is a type-stripper, not a parser: it never builds
      // an import/export graph, so there is nothing honest to return. Fail loudly.
      scan() { throw new Error(TRANSPILER_SCAN_UNSUPPORTED("scan")); }
      scanImports() { throw new Error(TRANSPILER_SCAN_UNSUPPORTED("scanImports")); }
    };
  }
}

// ---- bun:test ---------------------------------------------------------------
// The runner, expect(), the mock/spy family and snapshots live in ./bun-test.js.
// They moved out of this file when they grew past a "minimal but functional"
// runner: a test framework is the one part of the shim where a subtly wrong
// answer makes a whole suite lie, so it carries its own rules (every behaviour
// checked against a real bun test, the surprising ones reproduced with the
// observation written down) and its own pure, spike-pinned halves.

// bun:jsc — a couple of the introspection helpers, backed by web primitives.
//
// The memory helpers follow the bun:ffi pattern below: exported so an
// `import { heapSize } from "bun:jsc"` still loads, loud on call. They used to
// answer 0 / {current: 0, peak: 0}, which a memory-budget check reads as "nothing
// is allocated" and happily passes. No engine exposes heap introspection to page
// JavaScript, so there is no number we could return honestly.
function makeBunJsc() {
  const noHeapIntrospection = (name) => () => {
    throw new Error(
      "bun:jsc." + name + "() is not supported in Vivari (browser sandbox): the " +
        "JavaScript engine exposes no heap-introspection hook to page code."
    );
  };
  return {
    serialize: (v) => new Uint8Array(Buffer.from(JSON.stringify(v), "utf8")),
    deserialize: (b) => JSON.parse(Buffer.from(b).toString("utf8")),
    estimateShallowMemoryUsageOf: noHeapIntrospection("estimateShallowMemoryUsageOf"),
    heapSize: noHeapIntrospection("heapSize"),
    memoryUsage: noHeapIntrospection("memoryUsage"),
  };
}

// bun:ffi lives in ./bun-unsupported.js (createBunFfi) alongside the rest of the
// impossible surface it set the pattern for — import-safe, call-loud. It gained
// the three members that were missing entirely (CFunction, linkSymbols,
// JSCallback), a CString that throws instead of constructing an empty object, and
// a populated `read` table; see that file.

// ---- Bun.randomUUIDv7 -------------------------------------------------------
// This used to be `crypto.randomUUID()`, which is a v4 — 122 bits of randomness
// and nothing else. The entire reason to reach for v7 is that the first 48 bits
// are a big-endian millisecond timestamp, so the ids sort in creation order and
// stay friendly to a B-tree primary key. Aliasing v4 gives you a string of the
// right shape that fails at the one job you picked it for, and nothing in the
// type or the format tells you: you find out when your index fragments.
//
// Layout is RFC 9562 §5.7: 48-bit unix_ts_ms, version nibble 7, a 12-bit
// counter, the 2-bit variant, then 62 bits of CSPRNG.
//
//   0                   1                   2                   3
//   |         unix_ts_ms (48)          |ver|  rand_a (12)  |var| rand_b (62) |
//
// Monotonicity within a millisecond is the part naive implementations skip.
// Bun's documented rule: when the clock advances, reseed the counter to a random
// value with the high bit CLEAR (so at least 2048 increments remain before it
// rolls); when it has not advanced, reuse the last timestamp and increment; if
// the counter would roll over, bump the emitted timestamp rather than wrapping,
// so output is strictly increasing even under a burst.
const uuidState = { ts: 0, counter: 0 };
// An explicit `timestamp` argument tracks its own counter and neither reads nor
// disturbs the default path's state — otherwise passing a historical timestamp
// would drag the monotonic clock backwards for every subsequent default call.
const uuidExplicitState = { ts: -1, counter: 0 };

// Seed a fresh counter: 12 bits with the high bit clear, so at least 2048
// increments remain before it can roll.
const uuidSeedCounter = (crypto) => crypto.randomBytes(2).readUInt16BE(0) & 0x7ff;

function randomUUIDv7(crypto, Buffer, encoding, timestamp) {
  // Overload: randomUUIDv7(timestamp) with no encoding.
  if (typeof encoding === "number") { timestamp = encoding; encoding = undefined; }
  const enc = encoding == null ? "hex" : encoding;

  const explicit = timestamp != null;
  const state = explicit ? uuidExplicitState : uuidState;
  let ts = explicit ? Number(timestamp) : Date.now();

  // The two paths run the same counter machinery but differ on what counts as
  // "new", and the difference is documented rather than incidental. The default
  // path is driven by a clock that only moves forward, so anything that is not
  // strictly later is treated as the same instant and clamped to the last emitted
  // timestamp — that clamp is what makes the default sequence strictly increasing
  // even when Date.now() stalls or steps back. An explicit timestamp is instead
  // encoded VERBATIM and any change to it reseeds: the caller asked for that exact
  // instant, so clamping it forward would hand back an id for a different one.
  const fresh = explicit ? ts !== state.ts : ts > state.ts;

  if (fresh) {
    state.ts = ts;
    state.counter = uuidSeedCounter(crypto);
  } else {
    ts = state.ts;
    state.counter++;
    if (state.counter > 0xfff) {
      // Rolling the counter would emit a smaller id than the previous one, so
      // move the timestamp forward instead. Sortability wins over clock accuracy.
      state.ts = ts = ts + 1;
      state.counter = uuidSeedCounter(crypto);
    }
  }

  const bytes = Buffer.alloc(16);
  // 48-bit big-endian millisecond timestamp. writeUIntBE tops out at 6 bytes,
  // which is exactly what we need.
  bytes.writeUIntBE(ts, 0, 6);
  bytes[6] = 0x70 | ((state.counter >> 8) & 0x0f); // version 7 + counter high nibble
  bytes[7] = state.counter & 0xff;
  const rand = crypto.randomBytes(8);
  rand.copy(bytes, 8);
  bytes[8] = 0x80 | (bytes[8] & 0x3f); // variant 0b10

  if (enc === "buffer") return bytes;
  if (enc === "base64") return bytes.toString("base64");
  if (enc === "base64url") return bytes.toString("base64url");
  if (enc !== "hex") {
    throw new TypeError(`Bun.randomUUIDv7: unknown encoding ${JSON.stringify(enc)} (expected "hex", "base64", "base64url" or "buffer")`);
  }
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---- Bun.deepEquals / Bun.deepMatch -----------------------------------------
// This used to be a key-count plus recursive compare that ACCEPTED the `strict`
// argument and ignored it. That is worse than it sounds, because `strict` is not
// a nicety here: `expect().toEqual()` is documented as loose deepEquals and
// `expect().toStrictEqual()` as strict, so a shim where the two are identical
// makes toStrictEqual pass on input real Bun rejects. For a test-runner shim that
// is the worst possible direction to be wrong in — the suite goes green here and
// red in CI, which is precisely the failure mode a sandbox is supposed to prevent.
//
// The documented loose-vs-strict difference is narrow and specific
// (https://bun.com/docs/runtime/utils#bun-deepequals). Strict additionally treats
// as UNEQUAL: properties explicitly set to `undefined` (`{}` vs `{a: undefined}`),
// `undefined` padding in arrays (`["asdf"]` vs `["asdf", undefined]`), a sparse
// hole vs an explicit `undefined` (`[, 1]` vs `[undefined, 1]`), and a class
// instance vs an object literal with the same properties (prototype identity).
// Everything else below applies in both modes and was simply missing before: the
// old version had no Map/Set/Date/RegExp/TypedArray handling, said NaN !== NaN,
// and compared `[1, 2]` equal to `{0: 1, 1: 2}` because it only counted keys.
export function bunDeepEquals(a, b, strict) {
  if (a === b) return true;
  // NaN is the one primitive where === is not the right answer: Bun.deepEquals
  // and every toEqual-style matcher treat NaN as equal to itself.
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;

  // An array is never equal to a plain object, however similar their keys look.
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const ta = Object.prototype.toString.call(a);
  if (ta !== Object.prototype.toString.call(b)) return false;

  if (ta === "[object Date]") {
    const x = a.getTime(), y = b.getTime();
    return x === y || (Number.isNaN(x) && Number.isNaN(y));
  }
  if (ta === "[object RegExp]") return a.source === b.source && a.flags === b.flags;
  if (ta === "[object Error]" || a instanceof Error) return a.name === b.name && a.message === b.message;

  if (ArrayBuffer.isView(a) && !(a instanceof DataView)) {
    if (a.constructor !== b.constructor || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  if (a instanceof ArrayBuffer || a instanceof DataView) {
    const x = new Uint8Array(a instanceof DataView ? a.buffer : a, a.byteOffset || 0, a.byteLength);
    const y = new Uint8Array(b instanceof DataView ? b.buffer : b, b.byteOffset || 0, b.byteLength);
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }

  if (a instanceof Map) {
    if (a.size !== b.size) return false;
    // Keys may themselves be structures, so a .get() lookup is not sufficient in
    // general; fall back to a pairwise search only when the fast path misses.
    outer: for (const [k, v] of a) {
      if (b.has(k)) { if (bunDeepEquals(v, b.get(k), strict)) continue; return false; }
      for (const [k2, v2] of b) {
        if (bunDeepEquals(k, k2, strict) && bunDeepEquals(v, v2, strict)) continue outer;
      }
      return false;
    }
    return true;
  }
  if (a instanceof Set) {
    if (a.size !== b.size) return false;
    outer: for (const v of a) {
      if (b.has(v)) continue;
      for (const v2 of b) if (bunDeepEquals(v, v2, strict)) continue outer;
      return false;
    }
    return true;
  }

  if (Array.isArray(a)) {
    if (strict) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        // A hole and an explicit undefined are different values in strict mode.
        if ((i in a) !== (i in b)) return false;
        if (!bunDeepEquals(a[i], b[i], strict)) return false;
      }
      return true;
    }
    // Loose mode ignores trailing/undefined padding, so reading past the end
    // (which yields undefined) is the behaviour we want, not a bug.
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) if (!bunDeepEquals(a[i], b[i], strict)) return false;
    return true;
  }

  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;

  // In loose mode an own property whose value is undefined is indistinguishable
  // from an absent one; in strict mode it is not.
  const keys = (o) => (strict ? Object.keys(o) : Object.keys(o).filter((k) => o[k] !== undefined));
  const ka = keys(a), kb = keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) && strict) return false;
    if (!bunDeepEquals(a[k], b[k], strict)) return false;
  }
  return true;
}

// Bun.deepMatch(subset, object) — true when every property in `subset` exists in
// `object` with an equal value. This is what powers expect().toMatchObject().
// Note the argument order is (subset, object), which is the reverse of how the
// matcher reads; getting it backwards silently inverts the assertion.
export function bunDeepMatch(subset, object) {
  if (subset === null || typeof subset !== "object") return bunDeepEquals(subset, object, false);
  if (object === null || typeof object !== "object") return false;

  if (Array.isArray(subset)) {
    if (!Array.isArray(object) || subset.length !== object.length) return false;
    return subset.every((v, i) => bunDeepMatch(v, object[i]));
  }
  // Only plain objects are treated as "subsets"; a Date/Map/Set/TypedArray on the
  // subset side is compared whole, because a partial Date is meaningless.
  if (Object.prototype.toString.call(subset) !== "[object Object]") {
    return bunDeepEquals(subset, object, false);
  }
  for (const k of Object.keys(subset)) {
    if (!(k in object)) return false;
    if (!bunDeepMatch(subset[k], object[k])) return false;
  }
  return true;
}

// ---- Bun.serve degradation warnings -----------------------------------------
// An option we accept but cannot honour has to say so — once. Once per process
// per option, not per request and not per server: a warning that repeats on every
// request is scrolled past and becomes as invisible as the silence it replaced.
// Module scope (not per-runtime) is deliberate, so two Bun.serve() calls in one
// process do not each re-announce the same limitation.
const serveWarned = new Set();
export function serveWarnOnce(key, message) {
  if (serveWarned.has(key)) return false;
  serveWarned.add(key);
  try { console.warn("[vivari] " + message); } catch {}
  return true;
}

// ---- Bun.serve error rendering ----------------------------------------------
// What Bun.serve renders when a `fetch`/route handler throws. Bun hands the error
// to the server's `error(err)` option and serves whatever Response it returns; if
// there is no handler, or it declines by returning nothing, or it throws in turn,
// we fall back to the shim's original hard-coded 500 (so the pre-`error` behaviour
// is exactly preserved). Exported because this precedence is pure logic and
// spike-bun-offline.mjs must be able to test it without binding a port.
export async function resolveServeError(errorHandler, err) {
  if (typeof errorHandler === "function") {
    try {
      const response = await errorHandler(err);
      if (response) return response;
    } catch (handlerErr) {
      err = handlerErr;
    }
  }
  return new Response("Bun.serve handler error: " + ((err && err.message) || err), { status: 500 });
}

// ---- Bun.serve routing ------------------------------------------------------
// Compile a `routes` map into a specificity-ordered list. Bun precedence:
// exact (0) > `:param` (1) > `*` wildcard (2) > global `/*` (3).
export function compileRoutes(routes) {
  if (!routes || typeof routes !== "object") return null;
  const compiled = [];
  for (const pattern of Object.keys(routes)) {
    const parts = pattern.split("/").filter((s) => s.length > 0).map((s) =>
      s[0] === ":" ? { param: s.slice(1) } : s === "*" ? { wildcard: true } : { lit: s },
    );
    let spec = 0;
    if (pattern === "/*") spec = 3;
    else if (parts.some((p) => p.wildcard)) spec = 2;
    else if (parts.some((p) => p.param)) spec = 1;
    compiled.push({ pattern, parts, value: routes[pattern], spec });
  }
  compiled.sort((a, b) => a.spec - b.spec || b.parts.length - a.parts.length);
  return compiled;
}

function matchParts(parts, path) {
  const params = {};
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.wildcard) return { params }; // matches the remaining segments (incl. none)
    if (i >= path.length) return null;
    if (p.param) { try { params[p.param] = decodeURIComponent(path[i]); } catch { params[p.param] = path[i]; } }
    else if (p.lit !== path[i]) return null;
  }
  if (parts.length !== path.length) return null; // exact/param routes require equal length
  return { params };
}

// Match a pathname against compiled routes. A route value is a `Response`, a
// handler `(req) => Response`, or a per-method map `{ GET, POST, ... }`.
export function matchRoute(compiled, pathname, method) {
  const path = pathname.split("/").filter((s) => s.length > 0);
  const RES = typeof Response !== "undefined" ? Response : null;
  for (const route of compiled) {
    const m = matchParts(route.parts, path);
    if (!m) continue;
    let value = route.value;
    if (value && typeof value === "object" && !(RES && value instanceof RES) && typeof value.arrayBuffer !== "function") {
      const mm = value[(method || "GET").toUpperCase()];
      if (!mm) continue; // method not handled by this route -> keep looking
      value = mm;
    }
    if (typeof value === "function") return { handler: value, params: m.params };
    return { response: value, params: m.params };
  }
  return null;
}

// ---- Bun.serve WebSocket frame codec (RFC 6455) -----------------------------
// Server role: send unmasked frames, accept masked client frames. Mirrors the
// client-only codec in ../websocket.js.
export function toWsPayload(data, Buffer) {
  if (typeof data === "string") return { opcode: 0x1, payload: Buffer.from(data, "utf8") };
  if (data instanceof ArrayBuffer) return { opcode: 0x2, payload: Buffer.from(new Uint8Array(data)) };
  if (ArrayBuffer.isView(data)) return { opcode: 0x2, payload: Buffer.from(data.buffer, data.byteOffset, data.byteLength) };
  if (Buffer.isBuffer(data)) return { opcode: 0x2, payload: data };
  return { opcode: 0x1, payload: Buffer.from(String(data), "utf8") };
}

export function encodeWsFrame(Buffer, opcode, payload, masked) {
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeUInt32BE(Math.floor(len / 0x100000000), 2); header.writeUInt32BE(len >>> 0, 6); }
  header[0] = 0x80 | (opcode & 0x0f);
  if (!masked) return Buffer.concat([header, payload]);
  header[1] |= 0x80;
  const mask = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) mask[i] = (Math.random() * 256) | 0;
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, out]);
}

// Parse one frame off the head of `buf`; returns { frame, rest } or null if the
// buffer does not yet hold a complete frame.
// The returned frame also carries `masked` and the three RSV bits. They used to
// be parsed and dropped, which is precisely why the reader could not tell a
// legal frame from an illegal one: RFC 6455 §5.1 requires a server to reject an
// UNMASKED client frame, and §5.2 requires it to reject a set RSV bit when no
// extension was negotiated (we negotiate none). The parser stays permissive and
// role-agnostic — it is shared with the client-role codec in ../websocket.js —
// and wsFrameProtocolError() in ./bun-serve.js is what applies the server rules.
export function readWsFrame(Buffer, buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const rsv1 = (buf[0] & 0x40) !== 0;
  const rsv2 = (buf[0] & 0x20) !== 0;
  const rsv3 = (buf[0] & 0x10) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) {
    if (buf.length < 10) return null;
    // 64-bit length. The high word used to be skipped silently, so a frame
    // claiming >4 GiB was read as its low 32 bits — a length confusion rather
    // than an error. We cannot buffer such a frame anyway, so report it.
    const high = buf.readUInt32BE(2);
    if (high !== 0) return { frame: null, rest: buf, oversized: true };
    len = buf.readUInt32BE(6);
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;
  let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
  if (masked) {
    const mask = buf.subarray(offset, offset + 4);
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
    payload = out;
  } else {
    payload = Buffer.from(payload);
  }
  return { frame: { fin, rsv1, rsv2, rsv3, opcode, masked, payload }, rest: buf.subarray(offset + maskLen + len) };
}

// ---- small shared helpers ---------------------------------------------------
function toBuf(x, Buffer) {
  if (Buffer.isBuffer(x)) return x;
  if (typeof x === "string") return Buffer.from(x, "utf8");
  if (x instanceof ArrayBuffer) return Buffer.from(new Uint8Array(x));
  if (ArrayBuffer.isView(x)) return Buffer.from(x.buffer, x.byteOffset, x.byteLength);
  return Buffer.from(String(x), "utf8");
}
function shellEscape(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(shellEscape).join(" ");
  const s = String(v);
  if (/^[A-Za-z0-9_\-./:=@]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
function safeUrl(s) {
  try { return new URL(s); } catch { return { href: s, toString: () => s }; }
}