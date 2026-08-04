// The part of Bun's API a browser tab cannot provide — made to fail LOUDLY and
// USEFULLY instead of failing confusingly.
//
// Nothing here adds capability. Everything here converts one kind of failure into
// another: `TypeError: Bun.udpSocket is not a function`, thrown from six frames
// inside a dependency, becomes a sentence that names the API, says why a browser
// cannot do it, and points at what to use instead. That is the entire job.
//
// THE PATTERN (established by `bun:ffi`, and the reason this file exists at all):
// export the symbol so `import { dlopen } from "bun:ffi"` — or a property read
// during a dependency's module-level feature detection — still LOADS, and throw
// when it is CALLED. A load-time throw is strictly worse: one unused import at the
// top of a transitive dependency takes down a project that never touches the API.
//
// TWO MESSAGE SHAPES, AND THE DIFFERENCE IS LOAD-BEARING:
//
//   "<api> is not supported in Vivari (browser sandbox): <reason>"
//        Cannot ever work here. The capability does not exist in a page — a raw
//        socket, dlopen(3), an OS keychain, engine internals. No amount of shim
//        work changes it; the code has to run somewhere else.
//
//   "<api> is not implemented in the Vivari shim: <reason>"
//        COULD work here and does not yet. A gap, not a limit.
//
// Conflating the two is its own dishonesty. "Not supported" tells someone to stop
// and redesign; "not implemented" tells them to file an issue or send a patch, and
// telling them the wrong one wastes real time. Where an API is half of each — a
// TCP client can reach another in-VM process forever but can never reach the
// internet — the message says both, in that order.
//
// The `.node` native-addon half at the bottom is not Bun-specific: `module.js`
// imports it, because `require("bcrypt")` hits exactly the same wall from plain
// Node code, and one catalogue of "impossible in a browser, and what to do about
// it" beats two that drift. This file imports nothing, so that dependency costs
// the loader nothing.

// ---- message shapes ---------------------------------------------------------

/** Cannot ever work in a browser tab. */
export function sandboxMessage(api, reason) {
  return api + " is not supported in Vivari (browser sandbox): " + reason;
}

/** Could work here; nobody has written it. */
export function shimMessage(api, reason) {
  return api + " is not implemented in the Vivari shim: " + reason;
}

const sandboxThrow = (api, reason) => {
  const fn = () => {
    throw new Error(sandboxMessage(api, reason));
  };
  return fn;
};

const shimThrow = (api, reason) => {
  const fn = () => {
    throw new Error(shimMessage(api, reason));
  };
  return fn;
};

// A constructor-shaped stub: `new Bun.RedisClient(url)` must throw the same way
// `Bun.udpSocket()` does. The class is NAMED so a stack trace and an `instanceof`
// check read sensibly rather than showing an anonymous class.
const sandboxClass = (name, api, reason) => {
  const C = class {
    constructor() {
      throw new Error(sandboxMessage(api, reason));
    }
  };
  Object.defineProperty(C, "name", { value: name, configurable: true });
  return C;
};

// The SHIM-tier twin of sandboxClass: a gap, not a wall.
const shimClass = (name, api, reason) => {
  const C = class {
    constructor() {
      throw new Error(shimMessage(api, reason));
    }
  };
  Object.defineProperty(C, "name", { value: name, configurable: true });
  return C;
};

// ---- the reasons ------------------------------------------------------------
// Written out once each, because several APIs share one and the wording is the
// part under review. Every one names the specific missing capability — "no raw
// TCP socket", "no dlopen(3)" — rather than a generic "not available in the
// browser", which tells a reader nothing they could act on.

const NO_TCP_OUT =
  "a page cannot open a raw TCP socket, so no protocol built on one (Postgres, " +
  "MySQL, Redis, SMTP, AMQP, SSH) can reach a server from inside the tab. " +
  "Outbound traffic has to be HTTP(S) through fetch(), which the Fetcher Worker " +
  "performs and the remote origin's CORS policy gates. A connection to another " +
  "process INSIDE the VM is possible over Vivari's loopback net (node:net works " +
  "for that today) and is simply not wired up to this API.";

const NO_TCP_LISTEN =
  "a page cannot bind or accept a TCP socket; a port here is a kernel routing " +
  "entry that the Service Worker turns into a preview, not a socket the OS owns. " +
  "Use Bun.serve() for HTTP and WebSocket servers — that is the listener the " +
  "preview can actually reach. A VM-internal raw-TCP listener is possible over " +
  "Vivari's loopback net and is not wired up to this API; nothing outside the " +
  "browser tab could ever connect to it either way.";

const NO_DLOPEN =
  "loading a shared library requires dlopen(3) and executing native machine code " +
  "for the host CPU, and a browser tab can do neither. Ship the library as " +
  "WebAssembly and call it through WebAssembly.instantiate(), or use a package " +
  "that publishes a .wasm build.";

const NO_POINTERS =
  "it manipulates raw memory addresses, which have no meaning in a Wasm sandbox — " +
  "there is no process address space to point into. Pass data as ArrayBuffers " +
  "between JavaScript and WebAssembly instead.";

// Several bun:ffi members are "<what this one does>. <shared reason>". The shared
// reasons above start mid-sentence (they follow a colon when used alone), so
// capitalise when one becomes the second sentence.
const andThen = (lead, reason) => lead + " " + reason.charAt(0).toUpperCase() + reason.slice(1);

// ---- the Bun.* members ------------------------------------------------------

/**
 * The infeasible slice of the `Bun` global. Each member is a real value (so
 * reading it, destructuring it or feature-detecting it works) that throws when
 * used. Wired into the Bun object literal in ./bun.js.
 */
export function createBunUnsupported() {
  // --- raw sockets ----------------------------------------------------------
  const listen = sandboxThrow("Bun.listen()", NO_TCP_LISTEN);
  const connect = sandboxThrow("Bun.connect()", NO_TCP_OUT);
  const udpSocket = sandboxThrow(
    "Bun.udpSocket()",
    "there is no UDP in a browser at all — no datagram API is exposed to page " +
      "JavaScript, and WebRTC data channels are peer-negotiated rather than " +
      "addressed by host and port, so they cannot stand in for send(data, port, " +
      "address). Code that needs UDP has to run outside the sandbox."
  );

  // --- Redis / Valkey -------------------------------------------------------
  const REDIS_REASON =
    "the Redis/Valkey protocol (RESP3) runs over a raw TCP socket, which a page " +
    "cannot open. An HTTP gateway (Upstash-style REST) is a different protocol " +
    "with different guarantees — no pipelining, no SUBSCRIBE — so it is not " +
    "substituted silently here. For a cache inside one process use a Map; for " +
    "anything that must survive a reload, use bun:sqlite.";
  const RedisClient = sandboxClass("RedisClient", "new Bun.RedisClient()", REDIS_REASON);
  // `Bun.redis` is Bun's lazily-connected default client. Every use is one
  // property away from a call, so the commands are spelled out as throwing
  // methods rather than left undefined. The list is Bun's documented command
  // surface; a command NOT in it is `undefined` and fails as it does today —
  // acceptable, since the point of this file is the common path, and a Proxy that
  // manufactured a method for every name would make `Bun.redis` un-inspectable.
  const REDIS_COMMANDS = [
    "connect", "close", "send", "ping", "get", "getset", "getdel", "set", "del",
    "exists", "expire", "ttl", "incr", "decr", "incrby", "decrby", "mget", "mset",
    "keys", "type", "dump", "hget", "hset", "hmget", "hmset", "hgetall", "hdel",
    "hincrby", "sadd", "srem", "smembers", "sismember", "spop", "srandmember",
    "scard", "llen", "lpush", "rpush", "lpop", "rpop", "lrange", "zadd", "zrem",
    "zscore", "zrange", "publish", "subscribe", "unsubscribe", "psubscribe",
    "punsubscribe", "duplicate",
  ];
  const redis = {};
  for (const cmd of REDIS_COMMANDS) {
    redis[cmd] = sandboxThrow("Bun.redis." + cmd + "()", REDIS_REASON);
  }

  // --- Bun.SQL --------------------------------------------------------------
  // Bun's unified SQL client picks an adapter from the connection string, and the
  // right answer differs per adapter: Postgres and MySQL are wire protocols over
  // TCP (impossible), SQLite is perfectly possible and just is not this module's
  // job. So the message is chosen from the argument rather than being one blanket
  // sentence — a Postgres user and a SQLite user need different next steps.
  const SQL_PG =
    "the PostgreSQL wire protocol runs over a raw TCP socket, which a page cannot " +
    "open. Use bun:sqlite for SQL inside the VM; if you specifically need the " +
    "Postgres dialect, @electric-sql/pglite is a real Postgres compiled to " +
    "WebAssembly and runs in-VM (it ships as a Vivari template).";
  const SQL_MYSQL =
    "the MySQL wire protocol runs over a raw TCP socket, which a page cannot open. " +
    "Use bun:sqlite for SQL inside the VM — Vivari has no verified in-browser " +
    "MySQL engine to point you at.";
  const SQL_SQLITE =
    "only the Postgres and MySQL adapters are stubbed here, and neither can ever " +
    "work in a browser. SQLite itself can: use the bun:sqlite module directly.";

  const sqlAdapter = (input, options) => {
    const explicit = options && typeof options === "object" && options.adapter;
    const s = String(explicit || (typeof input === "string" ? input : (input && input.url) || "")).toLowerCase();
    if (s.indexOf("mysql") === 0 || s.indexOf("mariadb") === 0) return "mysql";
    if (s.indexOf("sqlite") === 0 || s.indexOf("file:") === 0 || s === ":memory:" ||
        /\.(sqlite3?|db)$/.test(s)) return "sqlite";
    if (s.indexOf("postgres") === 0) return "postgres";
    return "";
  };

  function SQL(input, options) {
    const adapter = sqlAdapter(input, options);
    if (adapter === "sqlite") throw new Error(shimMessage("Bun.SQL (SQLite adapter)", SQL_SQLITE));
    if (adapter === "mysql") throw new Error(sandboxMessage("Bun.SQL (MySQL adapter)", SQL_MYSQL));
    if (adapter === "postgres") throw new Error(sandboxMessage("Bun.SQL (Postgres adapter)", SQL_PG));
    throw new Error(
      sandboxMessage(
        "Bun.SQL",
        "its Postgres and MySQL adapters speak wire protocols over a raw TCP " +
          "socket, which a page cannot open, and the SQLite adapter is not " +
          "implemented here. Use bun:sqlite for SQL inside the VM."
      )
    );
  }
  // `Bun.sql` is the default tagged-template client. It is a function, so the
  // natural use — sql`select 1` — throws directly, which is the earliest possible
  // point; the helpers hanging off it throw the same way.
  const sql = sandboxThrow(
    "Bun.sql",
    "the default SQL client connects to Postgres or MySQL over a raw TCP socket, " +
      "which a page cannot open. Use bun:sqlite for SQL inside the VM, or " +
      "@electric-sql/pglite for a real Postgres compiled to WebAssembly."
  );
  for (const m of ["begin", "connect", "close", "end", "reserve", "unsafe", "file", "transaction"]) {
    sql[m] = sandboxThrow("Bun.sql." + m + "()", SQL_PG);
  }

  // --- named, so the failure is not `undefined is not a function` -----------
  // These seven were absent entirely, which is the failure mode this whole file
  // exists to prevent: a property read gives `undefined`, the call reports
  // "Bun.postgres is not a function" from inside a dependency, and nothing says
  // whether the sandbox forbids it or nobody has written it yet.
  const postgres = sandboxThrow(
    "Bun.postgres",
    "the Postgres wire protocol runs over a raw TCP socket, which a page cannot " +
      "open. Use bun:sqlite for SQL inside the VM, or @electric-sql/pglite for a " +
      "real Postgres compiled to WebAssembly."
  );
  const Terminal = sandboxClass(
    "Terminal",
    "new Bun.Terminal()",
    "it allocates a pseudo-terminal with openpty(3) and drives a child process " +
      "through it. There is no pty device in a browser — the same wall as " +
      "Bun.spawn({ terminal: true }). Pipe stdio instead: the streams are real, " +
      "only the tty is not."
  );
  // SHIM-tier: nothing about a page prevents it, it is simply unwritten. Saying
  // "not supported" would send someone off to redesign around a wall that is not
  // there. `Bun.Archive` used to be here and has graduated — it is real now, in
  // builtins/bun-archive.js, for the reason this comment gives.
  const registerMacro = shimThrow(
    "Bun.registerMacro()",
    "macros run at BUNDLE time inside the bundler's own module graph, and this " +
      "shim's Bun.build does not host one. Import the function and call it at " +
      "runtime, or precompute the value into your source."
  );
  // `Bun.S3Client`/`Bun.s3` used to live here, refused for "a SigV4 signer plus a
  // CORS policy". Both are now real (./bun-s3.js): the signer is written and
  // pinned to AWS's published vectors, and CORS moved from a reason to refuse the
  // API into the error path, where a blocked request is explained instead of
  // surfacing as `TypeError: Failed to fetch`. What is still refused there is
  // multipart, and it is refused in that file, next to the code that would do it.
  // Bun.FFI is the same module bun:ffi exports, reachable off the global. It is
  // built by createBunFfi(); this is only the name.
  const FFI = createBunFfi();

  // --- everything else ------------------------------------------------------
  const WebView = sandboxClass(
    "WebView",
    "new Bun.WebView()",
    "it drives a real browser — native WebKit on macOS, otherwise a browser " +
      "process spoken to over the Chrome DevTools Protocol on a TCP port. A page " +
      "can neither spawn a process nor open that socket. An <iframe> is not a " +
      "substitute (cross-origin, no CDP, no screenshots) — drive Vivari's preview " +
      "iframe from your host page instead."
  );

  const mmap = sandboxThrow(
    "Bun.mmap()",
    "mmap(2) is a kernel call, and Vivari's filesystem is a Rust/Wasm VFS with no " +
      "shared page mapping to hand out. Read the file with Bun.file(path).bytes() " +
      "and write it back with Bun.write() — but that is a COPY, and two copies do " +
      "not alias each other the way two mappings of one file do, which is usually " +
      "the reason to call mmap in the first place."
  );

  // Bun.peek is the debatable one, so the reason says exactly which wall it hits.
  // It is NOT a sandbox permission we could be granted: reading whether a promise
  // has settled, synchronously, requires the engine's internal promise state, and
  // no JavaScript engine exposes it to page code — the same wall as the bun:jsc
  // heap helpers. Nor is there an honest partial answer: for a PENDING promise
  // real Bun returns the promise itself, so a shim that always returned its
  // argument would be right for pending promises and silently wrong for settled
  // ones, which is the failure this whole phase exists to remove.
  const PEEK_REASON =
    "it reads a promise's already-settled value out of the engine's internal " +
    "state, and no JavaScript engine exposes promise state synchronously to page " +
    "code (the same limit as the bun:jsc heap helpers). There is no honest " +
    "fallback: returning the argument unchanged is what real Bun does only for a " +
    "PENDING promise, so a shim that did it would silently hand back a Promise " +
    "where your code expects the value. Use await or .then().";
  const peek = sandboxThrow("Bun.peek()", PEEK_REASON);
  peek.status = sandboxThrow("Bun.peek.status()", PEEK_REASON);

  const SECRETS_REASON =
    "it stores credentials in the operating system's keychain (macOS Keychain, " +
    "libsecret on Linux, Windows Credential Manager), and a browser tab has no " +
    "equivalent. localStorage or IndexedDB would satisfy the signature while " +
    "voiding the encryption-at-rest guarantee that is the entire point of the " +
    "API, so nothing is substituted. Keep real secrets on a server and reach them " +
    "over HTTPS; use .env / Bun.env for local, non-secret configuration.";
  const secrets = {
    get: sandboxThrow("Bun.secrets.get()", SECRETS_REASON),
    set: sandboxThrow("Bun.secrets.set()", SECRETS_REASON),
    delete: sandboxThrow("Bun.secrets.delete()", SECRETS_REASON),
  };

  // Bun.dlopen is bun:ffi's dlopen re-exported on the global; one message.
  const dlopen = sandboxThrow("Bun.dlopen()", NO_DLOPEN);

  // --- Bun.dns --------------------------------------------------------------
  // The one member here that is deliberately NOT all-or-nothing, because the
  // three members fail differently and pretending otherwise would be its own lie.
  //
  // `lookup` cannot work: a page has no resolver. The browser resolves names
  // inside fetch() and never hands back the answer — there is no API that returns
  // an address for a hostname, which is a privacy decision rather than a gap.
  //
  // `prefetch` and `getCacheStats` are the opposite case: they are ADVISORY, and
  // throwing would be the wrong answer. Bun's own example is a database driver
  // warming a host at startup; that call is opportunistic, its return value is
  // `void`, and code that makes it does not expect to have to guard it. Throwing
  // there would take down an app over a hint it never needed. So `prefetch` is an
  // honest no-op, and `getCacheStats` reports a cache that genuinely holds
  // nothing rather than inventing plausible numbers. Warming DNS by firing a
  // speculative fetch was considered and rejected: it sends real traffic the
  // caller did not ask for, to a host they only said they MIGHT contact.
  const dns = {
    lookup: sandboxThrow(
      "Bun.dns.lookup()",
      "a page has no DNS resolver. The browser resolves hostnames inside fetch() " +
        "and deliberately never exposes the result to JavaScript, so there is no " +
        "address to return — this is a privacy boundary in the platform, not a " +
        "missing shim. If you need the IP, ask a DNS-over-HTTPS endpoint with " +
        "fetch() (Cloudflare and Google both serve one with CORS enabled)."
    ),
    // Signature-compatible and intentionally inert: `void` in, `void` out.
    prefetch: () => {},
    getCacheStats: () => ({
      cacheHitsCompleted: 0,
      cacheHitsInflight: 0,
      cacheMisses: 0,
      size: 0,
      errors: 0,
      totalCount: 0,
    }),
  };

  // --- Zstandard ------------------------------------------------------------
  // A gap, not a limit — hence shimMessage. Nothing about zstd is browser-hostile;
  // it is missing because Vivari's codec crate (packages/codec) builds on flate2,
  // which covers deflate/gzip and nothing else. The same hole is why node:zlib's
  // brotli and zstd families throw (see packages/runtime/node/bindings/zlib.js),
  // and it closes in one place: add the engine to the Rust crate.
  const ZSTD_REASON =
    "Vivari's compression codec (packages/codec) is built on flate2, which " +
    "implements deflate and gzip only — there is no Zstandard engine behind it, " +
    "and node:zlib's zstd family is unimplemented here for the same reason. " +
    "Bun.gzipSync/gunzipSync/deflateSync/inflateSync are real and work today. " +
    "Closing this means adding a zstd crate to packages/codec and rebuilding the " +
    "Wasm, not writing JavaScript.";
  const zstd = {
    zstdCompressSync: shimThrow("Bun.zstdCompressSync()", ZSTD_REASON),
    zstdDecompressSync: shimThrow("Bun.zstdDecompressSync()", ZSTD_REASON),
    zstdCompress: shimThrow("Bun.zstdCompress()", ZSTD_REASON),
    zstdDecompress: shimThrow("Bun.zstdDecompress()", ZSTD_REASON),
  };

  // Two engine/host hooks that are present in every Bun program's namespace and
  // do something real there, so being absent here reads as "old Bun" rather than
  // "different host". Both are call-loud for the same reason as the rest.
  const generateHeapSnapshot = sandboxThrow(
    "Bun.generateHeapSnapshot()",
    "it walks JavaScriptCore's heap through an engine hook that no browser exposes " +
      "to page code — the same wall as bun:jsc's heapSize() and memoryUsage(). The " +
      "studio's own \"Measure Memory\" reports a process's heap from the outside, " +
      "which is as close as this sandbox gets."
  );
  const openInEditor = sandboxThrow(
    "Bun.openInEditor()",
    "it launches your editor as a child process (code/subl and friends), and a page " +
      "cannot start one. Vivari's editor is the studio around this VM, not a program " +
      "the guest can reach; there is no channel from guest code to it."
  );

  return {
    listen, connect, udpSocket,
    RedisClient, redis,
    SQL, sql, postgres,
    WebView, mmap, peek, secrets, dlopen,
    dns, zstd,
    generateHeapSnapshot, openInEditor,
    Terminal, registerMacro, FFI,
  };
}

// ---- bun:ffi ----------------------------------------------------------------
// The module Vivari has documented as unsupported since the beginning, now
// COMPLETE. `CFunction`, `linkSymbols` and `JSCallback` were absent entirely, so
// `import { JSCallback } from "bun:ffi"` bound `undefined` and failed at the call
// site as "JSCallback is not a constructor" — which says nothing about FFI, the
// sandbox, or what to do. `CString` was worse than absent: it was an empty class,
// so `new CString(ptr)` succeeded and produced an object with no string in it.
export function createBunFfi() {
  const read = {};
  for (const t of ["u8", "i8", "u16", "i16", "u32", "i32", "u64", "i64", "f32", "f64", "ptr", "intptr"]) {
    read[t] = sandboxThrow("bun:ffi read." + t + "()", NO_POINTERS);
  }
  const CString = sandboxClass(
    "CString",
    "new CString() (bun:ffi)",
    andThen("it decodes a NUL-terminated string at a pointer.", NO_POINTERS)
  );
  const JSCallback = sandboxClass(
    "JSCallback",
    "new JSCallback() (bun:ffi)",
    andThen("it hands a JavaScript function to native code as a C function pointer.", NO_DLOPEN)
  );
  return {
    dlopen: sandboxThrow("bun:ffi dlopen()", NO_DLOPEN),
    CFunction: sandboxThrow(
      "bun:ffi CFunction()",
      andThen("it wraps a function pointer obtained from a native library.", NO_DLOPEN)
    ),
    linkSymbols: sandboxThrow(
      "bun:ffi linkSymbols()",
      andThen("it turns already-resolved native symbol pointers into callable functions.", NO_POINTERS)
    ),
    JSCallback,
    CString,
    ptr: sandboxThrow("bun:ffi ptr()", NO_POINTERS),
    toArrayBuffer: sandboxThrow("bun:ffi toArrayBuffer()", NO_POINTERS),
    cc: sandboxThrow(
      "bun:ffi cc()",
      andThen(
        "it compiles C source with an embedded TinyCC and links the machine code into the running process.",
        NO_DLOPEN
      )
    ),
    read,
    // Kept as data, not throws: FFIType is a plain enum table and `suffix` is a
    // string. Code reads them while BUILDING a call that then throws at dlopen,
    // which is the right place to fail — making the table itself throw would move
    // the error away from the API that cannot work.
    FFIType: {},
    suffix: "so",
  };
}

// ---- PTY --------------------------------------------------------------------

/**
 * `Bun.spawn({ terminal: true })` — throw rather than quietly substituting pipes.
 *
 * This one is a GAP, not a limit, and the message says so: a pty is a kernel tty
 * device Vivari does not have, but nothing about a browser forbids emulating the
 * line discipline in JavaScript (the runtime already carries raw-mode stdin for
 * the in-VM terminal). Until that exists, silently handing the child a pipe is the
 * dangerous option: an interactive CLI checks isatty() and switches to a
 * non-interactive path, or waits forever for a prompt it will never render.
 */
export function assertNoPty(api, options) {
  if (!options || !options.terminal) return;
  throw new Error(
    shimMessage(
      api + " with `terminal: true`",
      "a pty needs openpty(3) and a tty device, and Vivari's kernel gives a child " +
        "plain pipes for stdio. A JavaScript pty emulation is possible here and " +
        "does not exist yet; until it does, drop `terminal` and read the child's " +
        "stdout/stderr as pipes — silently substituting them would make an " +
        "interactive CLI take its non-interactive branch, or hang waiting for a " +
        "prompt."
    )
  );
}

// ---- native .node addons ----------------------------------------------------
// The single highest-value message in the shim. Application code almost never
// calls Node-API directly, but bcrypt, sharp, better-sqlite3, canvas and most
// database drivers ship prebuilt `.node` binaries and hit this transitively at
// require() time, which makes it the most common hard failure a real project
// meets here. Until this change the symptom was a SyntaxError about an invalid
// token — the loader read the binary as UTF-8 text and tried to compile it — and
// that is about as unhelpful as an error can be.
//
// THE SUBSTITUTION MAP BELOW IS EVIDENCE-GATED. An entry exists only if the
// replacement is proven to run inside Vivari, and each carries the proof in a
// comment. A wrong recommendation is worse than no recommendation: it sends
// someone to rewrite working code against a package that fails the same way.
// Where we do not know, the entry says we do not know — that is also information,
// and it is why `sharp`, `canvas` and `node-sass` appear with `use: null` rather
// than with a plausible guess.

/**
 * npm package name -> what to use instead inside Vivari.
 *   use:  the replacement package, or null when none is verified.
 *   why:  what the reader needs to know to act, including how it was verified.
 * @type {Record<string, { use: string|null, why: string }>}
 */
export const NATIVE_ADDON_SUBSTITUTES = {
  // Proven: NATIVE_DROPIN_ALIASES in packages/runtime/toolchain-shims.js, whose
  // packument version-remapping is gated by scripts/spike-toolchain.mjs. Installs
  // that go through Vivari's Fetcher Worker already receive bcryptjs under the
  // name `bcrypt`, so reaching this message means the install did not.
  bcrypt: {
    use: "bcryptjs",
    why:
      "a zero-dependency pure-JS reimplementation with the same surface " +
      "(hash/hashSync/compare/compareSync/genSalt/getRounds). Vivari normally " +
      "installs it in place of bcrypt automatically; seeing this means the " +
      "install bypassed that. Under `bun`, Bun.password.hash(pw, 'bcrypt') is " +
      "also real bcrypt here, via Vivari's Rust/Wasm crypto codec.",
  },
  // Proven: packages/crypto (RustCrypto argon2) reached through
  // internalBinding('crypto'), exercised in a real guest process by
  // scripts/spike-bun.mjs ("bun run crypto.ts"). There is deliberately no
  // pure-JS `argon2` package recommended — none is verified here.
  argon2: {
    use: null,
    why:
      "no pure-JS `argon2` package is verified in Vivari. If you are running " +
      "under `bun`, Bun.password.hash(pw, 'argon2id') IS real argon2id here " +
      "(Vivari's Rust/Wasm crypto codec) and emits a standard PHC string.",
  },
  // Proven: scripts/spike-sqlite.mjs installs sql.js and runs real SQL in-VM, and
  // it is the `sqlite` template shipped in packages/studio/src/vv/templates.ts.
  "better-sqlite3": {
    use: "sql.js",
    why:
      "SQLite compiled to WebAssembly. Not a drop-in — the API is initSqlJs() + " +
      "db.prepare()/db.run() rather than better-sqlite3's — but it is real SQLite " +
      "in the VM, and it is what Vivari's own SQLite template uses.",
  },
  sqlite3: {
    use: "sql.js",
    why:
      "SQLite compiled to WebAssembly, used by Vivari's SQLite template. The API " +
      "differs from node-sqlite3's callback style; the engine is genuine SQLite.",
  },
  // Proven: scripts/spike-pglite.mjs boots @electric-sql/pglite in-VM and serves
  // queries; it is also the `pglite` template.
  "pg-native": {
    use: "@electric-sql/pglite",
    why:
      "a real PostgreSQL compiled to WebAssembly that runs inside the VM. Note " +
      "that plain `pg` will not help: it is pure JavaScript, but it still needs a " +
      "TCP connection to a server, and a page cannot open one.",
  },
  // Proven: NATIVE_WASM_ALIASES + packages/runtime/esbuild-inproc-patch.js, gated
  // by scripts/spike-toolchain.mjs and relied on by the Vite/Astro/Angular spikes.
  esbuild: {
    use: "esbuild-wasm",
    why:
      "esbuild's official WebAssembly build, published in lockstep. Vivari aliases " +
      "it automatically at install time and patches its service to run in-thread.",
  },
  // Proven: NATIVE_WASM_ALIASES (lockstep rename), gated by
  // scripts/spike-tailwind.mjs, which generates CSS in-VM through it.
  lightningcss: {
    use: "lightningcss-wasm",
    why:
      "Parcel's official WebAssembly build of lightningcss, published in lockstep " +
      "and aliased automatically by Vivari at install time.",
  },
  // Proven: NATIVE_WASM_ALIASES (lockstep rename); every Vite-based network spike
  // installs through it.
  rollup: {
    use: "@rollup/wasm-node",
    why: "Rollup's official WebAssembly build, published in lockstep and aliased automatically.",
  },
  // Not verified. Said plainly rather than guessed at.
  sharp: {
    use: null,
    why:
      "no substitute is verified in Vivari. sharp is libvips; nothing here " +
      "provides it, and the pure-JS image libraries have not been proven in-VM. " +
      "Do the image work in your host page (createImageBitmap/OffscreenCanvas) or " +
      "on a server.",
  },
  canvas: {
    use: null,
    why:
      "no substitute is verified in Vivari. node-canvas is Cairo. The browser's " +
      "own OffscreenCanvas exists in a worker but is not an API-compatible " +
      "drop-in, and Vivari has no check proving it works for this.",
  },
  "node-sass": {
    use: null,
    why:
      "no substitute is verified in Vivari. The ecosystem's replacement is `sass` " +
      "(dart-sass), which is pure JavaScript and therefore plausible here, but no " +
      "Vivari check proves it runs in-VM, so it is not a recommendation.",
  },
};

// Platform-specific sibling packages: the `.node` usually lives in a per-CPU
// package (@rollup/rollup-linux-x64-gnu, @next/swc-darwin-arm64, …), never in the
// package the user typed. Match those by prefix so the message is still useful.
// Each pairing is proven by the spike named in its comment.
const NATIVE_ADDON_PREFIXES = [
  // scripts/spike-next.mjs + the `next` template's dependency list.
  { test: (p) => /^@next\/swc-/.test(p) && p !== "@next/swc-wasm-nodejs",
    use: "@next/swc-wasm-nodejs",
    why: "Next.js's WebAssembly SWC build. Add it as a dependency; Next selects it because process.versions.webcontainer is set." },
  // scripts/spike-tailwind.mjs (Tailwind v4 generating CSS in-VM).
  { test: (p) => /^@tailwindcss\/oxide/.test(p) && !/wasm32-wasi$/.test(p),
    use: "@tailwindcss/oxide-wasm32-wasi",
    why: "Tailwind's own wasm32-wasi build, normally selected automatically by the in-VM npm because process.arch is 'wasm32'." },
  // scripts/spike-rspack.mjs and scripts/spike-rsbuild.mjs.
  { test: (p) => /^@rspack\/binding-/.test(p) && !/wasm32-wasi$/.test(p),
    use: "@rspack/binding-wasm32-wasi",
    why: "Rspack's wasm32-wasip1-threads build, normally selected automatically by the in-VM npm." },
  // Same lockstep rename as `rollup` above.
  { test: (p) => /^@rollup\/rollup-/.test(p),
    use: "@rollup/wasm-node",
    why: "Rollup's official WebAssembly build; Vivari aliases `rollup` to it automatically." },
  { test: (p) => /^lightningcss-/.test(p) && p !== "lightningcss-wasm",
    use: "lightningcss-wasm",
    why: "Parcel's official WebAssembly build; Vivari aliases `lightningcss` to it automatically." },
];

/**
 * The npm package a file belongs to, or "" if it is not inside node_modules.
 * Uses the LAST node_modules segment, so a nested copy
 * (a/node_modules/b/node_modules/c/x.node) is attributed to `c`, and keeps the
 * scope on a scoped package.
 */
export function packageNameFromPath(filename) {
  const parts = String(filename || "").split("/");
  const i = parts.lastIndexOf("node_modules");
  if (i < 0 || i + 1 >= parts.length) return "";
  const first = parts[i + 1];
  if (first && first[0] === "@" && i + 2 < parts.length) return first + "/" + parts[i + 2];
  return first || "";
}

/** The substitution advice for a package name, or "" when we have nothing to say. */
export function substituteAdvice(pkg) {
  if (!pkg) return "";
  const entry = NATIVE_ADDON_SUBSTITUTES[pkg];
  if (entry) {
    return entry.use
      ? "`" + pkg + "` has a substitute that works here: `" + entry.use + "` — " + entry.why
      : "`" + pkg + "`: " + entry.why;
  }
  for (const rule of NATIVE_ADDON_PREFIXES) {
    if (rule.test(pkg)) {
      return "`" + pkg + "` has a substitute that works here: `" + rule.use + "` — " + rule.why;
    }
  }
  return (
    "Vivari has no verified substitute for `" + pkg + "`. Look for a WebAssembly " +
    "or pure-JavaScript build of the same library (often published as `<name>-wasm` " +
    "or `<name>-js`), or move this work to a server."
  );
}

/**
 * The message for a native addon that cannot be loaded. Shared by the CommonJS
 * loader (module.js compile()/Module._extensions['.node']) and process.dlopen, so
 * every route to a `.node` file produces the same explanation.
 */
export function nativeAddonMessage(filename) {
  const pkg = packageNameFromPath(filename);
  return (
    "Cannot load the native addon " + filename + ": it is compiled machine code " +
    "for one operating system and CPU, and Vivari runs your project inside a " +
    "browser tab — there is no dlopen(3) and no way to execute a native binary " +
    "here. This is a limit of the sandbox, not a missing feature.\n" +
    (pkg ? substituteAdvice(pkg) + "\n" : "") +
    "Native addons are the most common reason a real Node project does not run in " +
    "the browser; see the Bun page in Vivari's docs for the current list of " +
    "substitutes that are known to work."
  );
}

/** The Error the loader throws for a `.node` file. `code` matches Node's. */
export function nativeAddonError(filename) {
  const err = new Error(nativeAddonMessage(filename));
  // Node uses ERR_DLOPEN_FAILED for a failed addon load. Real code branches on
  // `err.code` to fall back to a pure-JS path (node-gyp-build and several
  // optional-native packages do exactly that), so keeping it means those packages
  // take their fallback instead of crashing.
  err.code = "ERR_DLOPEN_FAILED";
  return err;
}