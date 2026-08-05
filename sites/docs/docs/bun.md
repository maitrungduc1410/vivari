---
sidebar_position: 8
title: Bun
---

# Bun

Vivari runs `bun` — `bun run app.ts`, `bun test`, `bun install`, `Bun.serve`,
`Bun.file`, `Bun.password` and the rest — inside the browser tab.

It is a **shim, and says so**. Real Bun is a native Zig/JavaScriptCore binary;
nothing can execute one in a page. So Vivari reproduces Bun's API on top of its
Node-compatible runtime, the same way npm, yarn and pnpm run here as the pure-JS
CLIs they already are. `Bun.version` reports the version of Bun whose behaviour
the shim targets, and `Bun.revision` ends in `-vivari` so a program can tell.

That decision has a consequence worth stating up front, because it is the whole
subject of this page: **about twenty of Bun's APIs cannot work in a browser at
all**, and code written against Bun is meant to run under real Bun later. An API
that quietly did something *approximate* here would pass in the sandbox and fail
in production, which is the worst outcome available. So each of them throws, and
the error names the API, the capability the browser does not have, and what to
use instead.

## What cannot work, and what to use instead

| Instead of | Use | Why it cannot work here |
| --- | --- | --- |
| `Bun.udpSocket` | — | There is no UDP in a browser at all. WebRTC data channels are peer-negotiated, not addressed by host and port |
| `Bun.SQL` (Postgres, MySQL) | `bun:sqlite`, or [`@electric-sql/pglite`] for the Postgres dialect | Both speak binary wire protocols over TCP |
| `Bun.RedisClient` / `Bun.redis` | A `Map` for in-process caching; `bun:sqlite` to persist | RESP3 runs over TCP |
| `bun:ffi` (`dlopen`, `cc`, `JSCallback`, `ptr`, …) | WebAssembly (`WebAssembly.instantiate`) | Loading a shared library needs `dlopen(3)` and executing native machine code |
| Native `.node` addons | see the table below | Same wall: compiled machine code for one OS and CPU |
| `Bun.mmap` | `Bun.file(p).bytes()` + `Bun.write` | No `mmap(2)`. Note that is a copy, so two views no longer alias |
| `Bun.secrets` | A server you reach over HTTPS; `.env` for non-secret config | It stores credentials in the OS keychain. `localStorage` would satisfy the signature and void the encryption-at-rest guarantee that is the entire point |
| `Bun.peek` / `Bun.peek.status` | `await`, `.then()` | A settled promise's value lives in engine-internal state that no JavaScript engine exposes synchronously to page code |
| `Bun.WebView` | Drive Vivari's preview `<iframe>` from your host page | It launches a real browser process, or talks to one over the Chrome DevTools Protocol on a TCP port |
| `Bun.dns.lookup` | A DNS-over-HTTPS endpoint via `fetch()` | A page has no resolver. The browser resolves names inside `fetch()` and never hands the address back — a platform privacy boundary, not a missing shim. `Bun.dns.prefetch` and `getCacheStats` do **not** throw: see below |
| `bun build --compile` | `bun build <entry> --outfile=<file>` | It emits a standalone native executable with the Bun runtime embedded |

A few things are **not implemented rather than impossible**, and the error says
so in different words, because "stop and redesign" and "send a patch" are not the
same advice: `Bun.spawn({ terminal: true })` (a pty could be emulated in
JavaScript; the kernel gives a child plain pipes today), `Bun.SQL`'s SQLite
adapter (use the `bun:sqlite` module), `Bun.build`'s `minify` / `splitting` /
`sourcemap` options (see [Bundling](#bundling-with-bunbuild) below), and Bun
macros, which need no capability the sandbox lacks.

**Zstandard** is in that second group. `Bun.zstdCompressSync` and its three
siblings throw, and so does `node:zlib`'s `zstd*` family: every Rust zstd
compressor is a binding to the C library, which does not build for the Wasm
target Vivari's codec compiles to. Nothing about the format is browser-hostile —
closing this means putting a pure-Rust engine in the crate. Brotli used to be
listed here and no longer is: `node:zlib`'s `brotli*` functions compress and
decompress for real, interoperably with libbrotli. `gzipSync` / `gunzipSync` /
`deflateSync` / `inflateSync` are real and unaffected, on both the `Bun` global
and `node:zlib`.

### Two members that stay quiet on purpose

`Bun.dns.prefetch` and `Bun.dns.getCacheStats` are the deliberate exception to
"everything unsupported throws". `prefetch` is advisory — Bun's own example is a
database driver warming a hostname at startup — it returns `void`, and code that
calls it does not guard it. Throwing would take an app down over a hint it never
needed, so `prefetch` does nothing and `getCacheStats` reports a cache that
really is empty. Warming DNS with a speculative `fetch` was considered and
rejected: it would send real traffic to a host you only said you *might* contact.

Every one of these is **safe to import**. The symbol exists, so
`import { dlopen } from "bun:ffi"` at the top of a dependency you never call does
not take your project down; the throw happens when the function is actually
called.

## Native addons, and the packages that replace them

This is the failure a real project hits first, and usually not through its own
code: `bcrypt`, `sharp`, `better-sqlite3`, `canvas` and most database drivers
ship prebuilt `.node` binaries and are pulled in transitively. A `.node` file is
compiled machine code for one operating system and CPU. There is no `dlopen(3)`
in a browser tab and no way to execute it.

`require()` of one gives you the reason and, where Vivari knows a substitute that
genuinely works in the VM, the substitute:

| Package | Use instead | Notes |
| --- | --- | --- |
| `bcrypt` | [`bcryptjs`] | Applied **automatically**: Vivari's registry layer installs it under the name `bcrypt`. Under `bun`, `Bun.password` is also real bcrypt here |
| `argon2` | `Bun.password.hash(pw, "argon2id")` | Real argon2id, via Vivari's Rust/Wasm crypto, emitting a standard PHC string. No pure-JS `argon2` package is verified |
| `better-sqlite3`, `sqlite3` | [`sql.js`] | Real SQLite compiled to WebAssembly. Not a drop-in — the API differs — but it is the engine, and it is what Vivari's SQLite template uses |
| `pg-native` | [`@electric-sql/pglite`] | Real PostgreSQL compiled to WebAssembly. Plain `pg` does not help: it is pure JavaScript but still needs a TCP connection |
| `esbuild` | `esbuild-wasm` | Automatic, and patched to run in-thread so it cannot deadlock under a worker pool |
| `lightningcss` | `lightningcss-wasm` | Automatic (published in lockstep) |
| `rollup`, `@rollup/rollup-*` | `@rollup/wasm-node` | Automatic (published in lockstep) |
| `@next/swc-*` | `@next/swc-wasm-nodejs` | Next.js selects it because Vivari sets `process.versions.webcontainer` |
| `@tailwindcss/oxide`, `@rspack/binding-*` | their `-wasm32-wasi` builds | Selected automatically by the in-VM npm, because `process.arch` is `wasm32` |

Packages Vivari has **no verified answer for** say so rather than guessing, and
`sharp`, `canvas` and `node-sass` are the common ones. A wrong recommendation
costs more than a missing one: it sends you off to rewrite working code against
something that fails the same way. If you find a WebAssembly or pure-JS
replacement that works, that is a very welcome pull request.

## What does work

The shim is not a stub list. `Bun.serve` (with `routes`, `fetch`, an `error`
handler and server-side WebSockets), `Bun.file`/`Bun.write` and the incremental
`FileSink`, `Bun.$`, `Bun.spawn`, `Bun.Glob`, `Bun.FileSystemRouter`,
`Bun.CryptoHasher` and `Bun.password`, `Bun.hash`, `Bun.sha`, `Bun.CSRF`,
the per-algorithm hashers (`Bun.MD4`/`MD5`/`SHA1`/`SHA224`/`SHA256`/`SHA384`/`SHA512`/`SHA512_256`),
`Bun.randomUUIDv7` and `Bun.randomUUIDv5`,
`Bun.YAML`/`TOML`/`JSON5`, `HTMLRewriter`, `Bun.Archive`, `new Worker()` on real threads,
`Bun.S3Client`/`Bun.s3` over real AWS SigV4 (the bucket needs a CORS policy — see below),
`Bun.build` and `Bun.plugin` (see below), `Bun.Transpiler`, zero-config TypeScript, automatic
`.env` loading with Bun's precedence rules, and
the `bun:test` runner all behave as documented — and where they diverge, the
divergence is written down rather than discovered.

Where an API has one exact right answer, it is pinned to a value produced by real
Bun rather than to itself: `Bun.hash` is checked against Bun's own published
wyhash digests, and a `Bun.password` hash written in the sandbox verifies under
real Bun and vice versa.

The per-algorithm classes carry a lifecycle trap that is easy to miss: like real
Bun, a `new Bun.SHA256()` is **consumed** by `digest()`, and using it again throws
`SHA256 hasher already digested`. A plain `Bun.CryptoHasher` resets instead and can
be reused. Making both behave the same would be the comfortable choice and the
wrong one — reuse would work here and throw on the first real `bun` run.

`Bun.sha` is worth a sentence of its own, because the name is a trap: it is
**SHA-2 512/256**, not SHA-512 truncated, and the two produce completely
different digests for the same input. Ours is pinned to NIST FIPS 180-4's worked
example, so it agrees with real Bun and with `openssl sha512-256`.

### Every request you make is a request from a browser tab

This one is worth internalising before you debug anything network-shaped, because
it applies to `fetch`, to `Bun.S3Client`, to `npm install`, and to any library that
reaches out over HTTP.

Vivari has no socket. Outbound HTTP is the **page's own `fetch`**, issued from the
tab your code is running in, which means the target has to allow that origin with
CORS headers. A URL that answers `curl` happily, and answers a real `bun` process
happily, can be unreachable here for that reason alone — nothing about your code is
wrong, and nothing in the runtime can fix it. What you can do is put a CORS-enabled
endpoint or a small proxy of your own in front of it.

The browser makes this harder than it needs to be: when it blocks a request, it
tells page code only `TypeError: Failed to fetch` (Chrome), `Load failed`
(Safari), or `NetworkError …` (Firefox) — deliberately contentless, because the
difference between "no such host" and "that host refused your origin" is itself
information about a network the page is not allowed to see. Read literally, it
looks like a bug in your program.

So the runtime rewrites that rejection into a sentence that says what happened:
who made the decision, the URL, the `Access-Control-Allow-Origin` the target would
need, the fact that any custom header triggers a preflight `OPTIONS` first, and
the reminder that the very same failure is what an unreachable host looks like.
It is still a `TypeError`, and the browser's original error is kept as `cause`.
The runtime does not guess which of the two causes it was, because it cannot —
that is the whole point of the restriction.

### `new Response(Bun.file(path))` does not stream the file

The first thing anyone writes when serving a static asset from `Bun.serve`, and
the one divergence here that is **silently wrong rather than loud**: you get a
`200` whose body is the literal text `[object Object]`.

Bun's `BunFile` extends the platform `Blob`, so a `Response` knows how to stream
it. Vivari's implements the Blob *read protocol* — `.text()`, `.bytes()`,
`.arrayBuffer()`, `.stream()`, `.slice()`, `.size`, `.type` — but is not a `Blob`
instance, and neither available fix is portable across both tiers Vivari runs on
(the details are in the header of `packages/runtime/builtins/bun-file.js`). So
the gap is left visible instead of being papered over on the tier that is easiest
to test.

Two spellings work, and both are valid under real Bun too:

```ts
const css = Bun.file("./public/app.css");
return new Response(css.stream(), { headers: { "content-type": css.type } });
// …or, for something small:
return new Response(await css.bytes(), { headers: { "content-type": css.type } });
```

`.stream()` keeps the laziness that makes `Bun.file` worth using: no file is
opened until the response body is pulled, and it is read one bounded chunk at a
time rather than into memory whole.

### `HTMLRewriter`

The streaming HTML transformer, with the property people actually rely on: a
document you did not rewrite comes back **byte for byte** — odd quoting, stray
whitespace, comments and all. It is a rewriter over the source text, not a
parse-and-serialize, so `<P CLASS='a'   data-x=1 >` survives untouched and only
the tag you modified is rebuilt (keeping the other attributes' original spelling,
as Bun does).

```ts
const out = new HTMLRewriter()
  .on("a[href]", { element(e) { e.setAttribute("href", "https://cdn" + e.getAttribute("href")); } })
  .on("title", { text(t) { if (t.text) t.replace("New title"); } })
  .onDocument({ comments(c) { c.remove() } })
  .transform(html);                       // a string in, a string out
```

Element, text, comment, doctype and document-end handlers are all here, along
with `before`/`after`/`prepend`/`append`/`replace`/`remove`/`removeAndKeepContent`/
`setInnerContent` and `onEndTag`. The selector subset is lol-html's:
tag, `*`, `#id`, `.class`, `[attr]` with the five operators, descendant and `>`,
`:not()`, `:first-child`, `:nth-child()`, `:first-of-type`, `:nth-of-type()` and
comma lists. An **unsupported selector throws at `.on()`** rather than matching
nothing — a rewrite that silently does nothing looks exactly like a page that had
nothing to rewrite.

Two things differ from real Bun, both deliberate:

- **It is not streaming.** The whole input is read before rewriting. The output is
  identical (including the chunk boundaries Bun's tokenizer produces inside a
  `<script>`, which a text handler can see), but there is no time-to-first-byte
  benefit and a huge document is held in memory.
- **An `async` handler only works on the `transform(Response)` path.** Bun somehow
  drains one on the string path; JavaScript cannot, so rather than silently
  dropping whatever the handler did after its first `await`, the string path
  throws and points at `new Response(html)`.

Everything else is pinned to answers recorded from a real `bun` binary — 136
cases plus a fuzz cross-product of generated documents and rewrite recipes, all
reproduced byte for byte (`scripts/spike-html-rewriter.mjs`).

### `Bun.CSRF`

`Bun.CSRF.generate` and `Bun.CSRF.verify` work with all of Bun's documented
options — `expiresIn`, `maxAge`, `encoding`, `algorithm`, `sessionId` — and the
same defaults (24 hours, `base64url`, `sha256`).

One difference matters if your app spans two runtimes: **the token format is
Vivari's, not Bun's.** Bun does not document its wire layout, so a token minted
here will not verify on a real Bun server, or the reverse. Within one runtime
this is invisible; across two it rejects every request, which is why it is stated
here rather than left to be discovered. What is portable is the contract — same
options, same defaults, same `true`/`false`.

As in Bun, pass a `sessionId` to both calls. Without one the token is bound only
to the secret, so any token you have ever issued verifies for every user:

```ts
const token = Bun.CSRF.generate(SECRET, { sessionId });
// ...later, on the POST:
if (!Bun.CSRF.verify(submitted, { secret: SECRET, sessionId })) return new Response("no", { status: 403 });
```

A malformed or tampered token is `false`, never a throw — it arrives from the
network. A *misconfigured* one (an algorithm Bun does not offer) does throw, on
both calls: that is your bug, and returning `false` would disguise a broken
deployment as a flood of invalid tokens.

### `Bun.Archive`

Reading and writing archives, with the same four methods as Bun. Pass bytes (a
`Blob`, `TypedArray` or `ArrayBuffer`) to read one, or a plain object to build
one:

```ts
const bytes = await new Bun.Archive({ "README.md": "# hi", "src/i.ts": src }).bytes();

const files = await new Bun.Archive(bytes).files();   // Map<string, Blob>
await files.get("README.md").text();                  // "# hi"

await new Bun.Archive(tarGz).extract("./out");        // returns the entry count
await Bun.Archive.write("out.tar", { "a.txt": "a" }, { compress: "gzip" });
```

`files()` hands back a **`Map`**, not an object, so a name containing a `/` or a
`__proto__` needs no escaping. `bytes()`, `blob()` and `files()` are all promises
over the same archive and can be called in any order.

Three things about the surface are Bun's own, and are matched rather than
improved on:

- **Reading is tar and tar.gz only.** A `.zip` throws
  `Unrecognized archive format` — so does real Bun, despite the generic name.
  Gzip is detected by its `1f 8b` magic, not by the filename, so a `.tar` that is
  really gzipped still reads.
- **Writing always emits an uncompressed tar, whatever the path says.**
  `Bun.Archive.write("dist.zip", files)` writes a *tar* named `dist.zip`. The
  extension is not consulted; only `{ compress: "gzip" }` changes the bytes.
  Matching this beats diverging, but it will surprise you, so: name the file
  `.tar`.
- Directory and symlink entries are dropped by `files()`, which only reports
  regular files. `extract()` creates both.

One case is deliberately **stricter than Bun**, on the same grounds as
`Bun.JSONC` above. `Bun.Archive.write(path, new Map([["a.txt", "a"]]))` writes an
*empty* archive in real Bun — a `Map` has no enumerable own properties, so the
files silently vanish and you get a valid 10 KB tar containing nothing. Here a
`Map`, a `Set`, another `Archive`, or a `Bun.file()` handle used as a value throws
and names the shape it found. Losing a file quietly is worse than being told the
call was wrong.

Both spellings of the import work — the `Bun` global, and the bare module Bun's
own documentation tends to use:

```ts
import { $, file, write, semver } from "bun";
```

That module *is* the global (same objects, not re-exports), so anything reachable
one way is reachable the other.

### `Bun.S3Client` and `Bun.s3`

Read this part first, because it is not optional and it is not a Vivari
limitation: **your code runs in a browser tab, so the request to S3 is issued by
the browser, and the bucket must send CORS headers or the request never reaches
S3 at all.** Real `bun` on a server has no such rule. Nothing about the API
below changes; what changes is that the bucket now has to agree.

Put this on the bucket (S3 console → Permissions → CORS), with
`AllowedOrigins` set to the origin the page is served from:

```json
[
  {
    "AllowedHeaders": ["authorization", "x-amz-*", "content-type", "range"],
    "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
    "AllowedOrigins": ["https://your-origin.example"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Type", "Last-Modified", "x-amz-request-id"],
    "MaxAgeSeconds": 3000
  }
]
```

Three parts of that policy earn their place:

- **`AllowedHeaders`.** A signed request carries `authorization`,
  `x-amz-content-sha256` and `x-amz-date`. None of those is CORS-safelisted, so
  the browser sends a **preflight `OPTIONS`** before every call and the bucket has
  to answer it with a matching `Access-Control-Allow-Headers`. A policy that
  allows your origin but not those headers fails exactly like no policy at all.
- **`AllowedMethods`.** `PUT` for `write`, `DELETE` for `delete`, `HEAD` for
  `exists`/`stat`/`size`. Listing only `GET` gives you a client that can read and
  nothing else.
- **`ExposeHeaders`.** Cross-origin JavaScript can only read the response headers
  the bucket names here. Without `Content-Length` and `ETag`, `stat()` still
  succeeds but reports `size: null` and no `etag` — and `size()` throws
  `ERR_S3_HEADER_NOT_EXPOSED` rather than handing back a `null` that becomes `0`
  in arithmetic.

When something is blocked anyway, the error says so instead of surfacing as the
browser's bare `TypeError: Failed to fetch`:

```
S3Error [ERR_S3_REQUEST_BLOCKED]: The GET request to https://s3.us-east-1.amazonaws.com
never left the browser, so S3 never answered it — there is no HTTP status to report. …
The likely cause is CORS: the bucket needs a CORS policy allowing https://your-origin.example,
the method GET, and the request headers this client sends (authorization,
x-amz-content-sha256, x-amz-date). …
```

That is a **different failure from a bucket that refused you**, and telling them
apart is most of debugging this:

| What you see | What happened |
| --- | --- |
| `ERR_S3_REQUEST_BLOCKED`, no HTTP status | The browser stopped the request. Almost always the CORS policy — nothing reached S3, so your credentials were never tested |
| `AccessDenied`, `SignatureDoesNotMatch`, `NoSuchBucket`, `NoSuchKey` with a `status` | S3 answered. The network path works; this is the key, the secret, the region or the bucket policy |

A presigned URL is the exception to all of it. `presign()` signs into the query
string and sends no headers, so a plain `<img src>`, a download link or a
`<video>` needs **no CORS policy at all** — the page is not reading the response
with script. Reaching the same URL with `fetch()` does need one.

#### What works

Everything is signed with AWS Signature Version 4, computed in the sandbox from
your secret key. The key itself never leaves the tab; what goes on the wire is the
signature. The signer is pinned to AWS's published SigV4 test vectors, and the
requests it builds are pinned to bytes captured from real `bun` 1.3.6.

```ts
const client = new Bun.S3Client({
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  bucket: "my-bucket",
  region: "us-east-1",
});

const file = client.file("notes/today.md");
await file.text();                       // GET
await file.write("# today\n");           // PUT
await file.slice(0, 1024).bytes();       // GET with Range: bytes=0-1023
await client.exists("notes/today.md");   // HEAD -> boolean
await client.stat("notes/today.md");     // HEAD -> { size, etag, type, lastModified }
await client.delete("notes/today.md");   // DELETE
await client.list({ prefix: "notes/", maxKeys: 100 });
client.presign("notes/today.md", { expiresIn: 3600 });
```

- `file`, `write`, `delete`, `unlink`, `exists`, `size`, `stat`, `list` and
  `presign`, as instance methods and as statics that take the credentials as their
  last argument (`Bun.S3Client.presign(key, credentials)`).
- `Bun.s3` is the default client, built from the environment:
  `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_BUCKET`,
  `S3_ENDPOINT`, `S3_SESSION_TOKEN`, and the `AWS_*` spellings of each. `S3_*`
  wins where both are set. `AWS_DEFAULT_REGION` is **not** read, matching the
  binary. With nothing configured, `Bun.s3` still exists and each call throws
  `ERR_S3_MISSING_CREDENTIALS`.
- `Bun.file("s3://bucket/key")` and `Bun.write("s3://bucket/key", data)` route to
  the default client, as they do in Bun.
- `S3File` is Blob-like: `text`, `json`, `bytes`, `arrayBuffer`, `blob`,
  `formData`, `stream`, `slice`, `write`, `exists`, `stat`, `delete`, `presign`,
  `writer`. `slice` is lazy — it sends a `Range` header when something finally
  reads, so a window out of a large object transfers the window.
- S3-compatible servers work through `endpoint` (MinIO, R2, DigitalOcean Spaces).
  Path-style addressing is the default; `virtualHostedStyle: true` moves the
  bucket into the hostname. With an `endpoint` and no `region`, the signing region
  is `auto`, as in Bun.
- `acl`, `storageClass` and `sessionToken` are signed into the request; `acl` and
  `storageClass` also work on `presign`.

#### What does not

- **Multipart upload — SHIM tier** (possible here, unwritten). `S3File.writer()`
  buffers and flushes a single `PUT`, which is what Bun does below its part size.
  Past 5 MiB it throws instead of starting a multipart upload, because a partial
  multipart leaves an incomplete object and a bill behind. It also needs
  `ExposeHeaders: ["ETag"]` — each part's ETag has to be readable by script to
  complete the upload — so writing it blind against a policy nobody has tested
  would produce failures deep inside an upload rather than at the first call.
  For large objects, `presign(key, { method: "PUT" })` and let the browser upload
  directly.
- **Incremental request streaming — SANDBOX tier** (impossible here). A browser
  `fetch()` cannot stream a request body without HTTP/2 and a duplex-capable
  connection, so a `ReadableStream` passed to `write()` is drained into memory
  first and sent as one `PUT`. Real Bun 1.3.6 does something worse — it stringifies
  the stream and uploads `[object ReadableStream]` — and that bug is deliberately
  not reproduced.
- **A key containing `?`** throws. Bun truncates the key at the `?` and operates on
  a *different object* without saying so; percent-encode it yourself if an object
  really is named that. Every other key rule is Bun's, including the surprising
  one: **any** `scheme://` prefix is stripped, so `client.file("https://host/x")`
  is the key `host/x`, not a URL fetch. Keys are not normalised either — `a/../b`
  stays `a/../b`, because that is a legal S3 key.
- **`Content-Type` guessing.** An explicit `{ type }` is sent verbatim; without
  one, everything is `application/octet-stream`, which is what the binary sends
  even for a string. Bun additionally appends `;charset=utf-8` to a few types from
  an internal MIME table; that table is not reproduced here.
- **`list()` returns `lastModified` as the ISO string** while `stat()` returns a
  `Date`. That inconsistency is Bun's, measured both ways, and copying it is
  cheaper than a surprise for code that moves between runtimes.

### Ten templates in the Bun tab

Every one of them boots in CI from the exact bytes the studio writes into your
project, so none is marked experimental:

| Template | What it shows |
| --- | --- |
| serve / routes / websocket / react | `Bun.serve` — plain `fetch`, the `routes` table, server-side WebSockets, and on-the-fly TSX |
| full-stack | all three headline APIs in one app: `Bun.serve` routes it, `bun:sqlite` answers it across three tables, `HTMLRewriter` renders it into plain `.html` files. No client-side JavaScript, and its own `bun test` suite |
| test | the `bun:test` runner: matchers, `mock`/`spyOn`, `test.each`, snapshots |
| SQLite | `bun:sqlite` — a CRUD API over a real database file that survives a reload |
| shell | `Bun.$` — pipes, redirects, exit codes, per-command `env` and `cwd` |
| bundler | `Bun.build` — a multi-module bundle, a plugin, `define`, `external` |
| API tour | hashing, `Bun.password`, YAML/TOML, `Glob`, `semver`, `stringWidth`, `Bun.Transpiler`, and a `Worker` on a second thread |

#### Links and form posts inside the preview

Worth knowing before you write a multi-page app here, because it is the one thing
about this sandbox a server-rendered app has to know. A preview is served at
`<origin>/preview/<port>/`, and the Service Worker strips that prefix before your
app sees the request — handing it back as `x-forwarded-prefix`. Subresources are
fine without it, but a **navigation** is not: a plain `<a href="/issue/3">`, a
`<form action="/api/…">` and a redirect `Location` all leave the preview and 404
against the Studio.

So rebase them. The full-stack template does it as a second `HTMLRewriter` pass,
which is a dozen lines and knows nothing about the app:

```ts
const prefix = req.headers.get("x-forwarded-prefix") ?? "";   // "" when served at the root

const rebased = prefix
  ? new HTMLRewriter()
      .on("a[href], link[href], form[action]", {
        element(e) {
          const attr = e.tagName === "form" ? "action" : "href";
          const value = e.getAttribute(attr);
          if (value?.startsWith("/") && !value.startsWith("//")) e.setAttribute(attr, prefix + value);
        },
      })
      .transform(page)
  : page;
```

Redirects need the same treatment by hand: `Location: prefix + "/"`.
### The API surface, checked name by name against the binary

Rather than adding APIs as they came up, the whole of `Bun`, `bun:jsc`, `bun:ffi`
and `bun:test` was enumerated from a real binary and diffed against this shim.
Thirteen `Bun.*` names were missing outright, which is worse than refusing them:
a read gives `undefined`, which is a value, so nothing fails until something
else does, somewhere else. They are now either real (`Bun.cwd`, `Bun.origin`,
`Bun.version_with_sha`, `Bun.fetch` with `preconnect`, `Bun.jest`, `Bun.shrink`,
`Bun.JSONC`, `Bun.Archive`) or loud on call with the reason and the tier —
`Bun.postgres` and `Bun.Terminal` can never work here, while `Bun.registerMacro`,
`Bun.S3Client` and `Bun.s3` are simply unwritten, and the message says which.
`Bun.JSONC`) or loud on call with the reason and the tier — `Bun.postgres` and
`Bun.Terminal` can never work here, while `Bun.Archive` and `Bun.registerMacro`
are simply unwritten, and the message says which. `Bun.S3Client` and `Bun.s3`
were on that second list and are now real: see
[`Bun.S3Client` and `Bun.s3`](#buns3client-and-buns3) above, and read the CORS
part of it before the API part.

`Bun.JSONC.parse` is JSON with comments — tsconfig.json's real format. It is not
the JSON5 parser wearing a different name: Bun rejects `NaN`, `Infinity`, a
leading `+` and unquoted keys, all of which JSON5 accepts, so reusing JSON5 here
would have accepted files Bun calls invalid. Two cases are deliberately stricter
than Bun: an unquoted key throws (Bun returns `{"": 1}`, dropping the name), and
a second root throws (Bun returns the first value and ignores the rest of the
file). Both reject input rather than accepting more of it.

`bun:jsc` gained the two members that are possible — `setTimeZone` (which really
does move `Date`, so a date-dependent test can be pinned without a container) and
`drainMicrotasks` — and an honest refusal for the twenty-eight that drive
JavaScriptCore's collector, JIT tiers and sampling profiler.

### `bun exec` and `bun x` are different commands

`bun x <package>` runs a package binary; `bun exec <command>` runs a command
through Bun Shell. This shim used to send both to `npx`, so
`bun exec 'echo hi && pwd'` went looking for a package named after the whole
line. They are separate now, and `sh` grew the `exit` builtin it was missing —
`exit 3` used to report 127, "not found", for something that is not a program.

`bun why`, `bun outdated`, `bun info` and `bun audit` delegate to npm, which is
already the install path here. `bun publish`, `bun patch` and `bun repl` refuse
with the specific missing piece: an authenticated registry session, a git
transport, and a tty.

### `bun:test` has Bun's whole matcher table

All 87 matchers real Bun's `expect()` exposes are here, including the ones a Bun
suite reaches for that Jest never had — `toBeOdd`, `toBeWithin`,
`toContainAllKeys`, `toEqualIgnoringWhitespace`, `toIncludeRepeated` — and the
older Jest spellings Bun keeps as aliases (`toBeCalledWith`, `lastCalledWith`,
`nthReturnedWith`). A missing matcher is not a failing test, it is a `TypeError`
in the middle of one, which reads as a bug in your code rather than a gap in the
runner; the list is recorded from the binary and a check compares the two, so a
matcher Bun adds later shows up as a failing build here rather than as a crash in
your suite.

The module's other exports are complete too: `xit`/`xtest`/`xdescribe`,
`setDefaultTimeout`, `onTestFinished` (which runs after the body and before
`afterEach`, as Bun's does), `expectTypeOf` (a type-level assertion that
evaporates at run time, in Bun as well), and Vitest's `vi` namespace so a Vitest
suite runs unchanged. `vi`'s mocking half is wired to the same functions as
`mock`/`spyOn`, and its timer half is the same clock as `jest`'s, described
next.

### `Bun.$`, `Bun.spawn` and `Bun.file`, filled in

`$` has the four shell-level defaults — `$.cwd(dir)`, `$.env(vars)`,
`$.nothrow()`, `$.throws(bool)` — which apply to every command after them, while
a per-command modifier still wins. `new $.Shell()` is a fresh shell with its own
defaults, which is what lets a library set `$.cwd()` without moving yours, and
`$.ShellError` is the class a failed command throws, so the `catch (e) { if (e
instanceof $.ShellError) }` from Bun's docs works.

`Bun.spawn()`'s `Subprocess` now carries `exitCode`, `signalCode`, `killed`,
`stdio`, `terminal` and `ref`/`unref`. `exitCode` is the one to know: it is
`null` while the process runs **and** when a signal killed it (the name is in
`signalCode` then), and it is a number after a normal exit. `killed` becomes
true after any exit, not only after `kill()` — both of those are Bun's
behaviour, not ours. `resourceUsage()` refuses, since `getrusage(2)` is a
measurement only a kernel can take.

### Talking to a child process: `Bun.spawn({ ipc })`

Pass an `ipc` handler and the child gets a message channel. The parent side is
`subprocess.send()`, `subprocess.connected` and `subprocess.disconnect()`; the
handler is called with each message and the subprocess itself, so a handler can
reply.

```ts
const child = Bun.spawn(["bun", "run", "worker.ts"], {
  ipc(message, subprocess) {
    if (message.kind === "ready") subprocess.send({ kind: "work", items: [1, 2, 3] });
    if (message.kind === "done") console.log(message.results);
  },
});
child.send({ kind: "hello" });
```

The child does not get a Bun-specific API. It gets Node's fork surface, which is
what a real `bun` hands it too:

```ts
// worker.ts
process.on("message", (message) => {
  if (message.kind === "work") process.send({ kind: "done", results: message.items.map((n) => n * 2) });
});
process.send({ kind: "ready" });
```

`process.connected`, `process.channel` and `process.disconnect()` are there as
well, and the child gets a `disconnect` event when the parent hangs up.

**What survives.** By default messages go through a structured clone, not JSON,
so a `Map`, a `Set`, a `Date`, a `RegExp`, a `BigInt`, a `TypedArray` and a
circular reference all arrive as themselves — including shared identity, so
`{x: o, y: o}` still has `x === y` on the other side. A function or a symbol is
refused at the `send()` call with `DataCloneError: The object can not be
cloned.`, and `send(undefined)` throws `TypeError: The "message" argument must
be specified`. Passing `serialization: "json"` switches to JSON instead, which
loses every one of those conversions — a `Map` arrives as `{}` and a `Date` as a
string.

**Lifecycle.** `connected` is true from the moment `Bun.spawn` returns, and
messages sent before the child has finished booting are delivered once it does.
`disconnect()` closes both ends and is safe to call twice. Once the channel is
closed, `send()` throws `Subprocess.send() can only be used if an IPC channel is
open.`; once the child has exited, it throws `Subprocess.send() cannot be used
after the process has exited.` instead. Holding a `message` listener in the
child keeps that child alive, exactly as it does under Bun — a child that never
attaches one exits as soon as its script ends.

**Limits.** The channel is a UNIX socket on the VM's own network, so both
processes must be in this VM; there is no way to reach a process outside the tab.
A message is capped at 128 MiB. `serialization: "json"` is worth passing anyway
if the same code also runs on a real `bun` with a `node` child: there, the
default `"advanced"` mode silently loses the child's messages, because node's
advanced mode is `v8.serialize` while Bun's is a structured clone. Both modes
work with either child here, and Vivari warns once if it spots that difference.

`Bun.file(path).formData()` parses the file as a form body. It needs the type
from the file — `Bun.file(path, { type })` — because nothing in the bytes says
whether they are urlencoded or multipart, and Bun throws `Invalid encoding`
rather than hand back an empty `FormData`.

### Fake timers and `setSystemTime`

`jest.useFakeTimers()`, `vi.useFakeTimers()` and `setSystemTime()` all work, and
both namespaces drive one clock, so a Vitest suite and a Jest-style suite behave
the same.

The two halves are independent, as they are in Bun. `setSystemTime(date)`
**freezes** what `Date` reports — it does not offset it, so a duration measured
across real time comes out as zero — and leaves timers alone;
`setSystemTime()` with no argument restores the real clock. `useFakeTimers()`
stops `setTimeout`/`setInterval` from firing on their own and leaves `Date`
alone. Advance the queue with `advanceTimersByTime(ms)`,
`advanceTimersToNextTimer()`, `runAllTimers()` or `runOnlyPendingTimers()`;
`getTimerCount()`, `clearAllTimers()` and `useRealTimers()` round it out.
Callbacks fire in due order, and for a tie in the order they were scheduled — so
an interval at 30ms fires three times before a timeout at 100ms that was
registered first, which is what Bun does.

Two things are worth knowing. A test that installs fake timers and never
restores them cannot freeze the next file: the clock is reset between files, and
the runner's own per-test timeout deliberately uses a real timer, so a frozen
suite still times out instead of hanging. And `runAllTimers()` with a live
`setInterval` stops after 100,000 firings with an error naming the call — real
Bun spins there forever, and a test runner that hangs tells you nothing.

`expect.assertions(n)` and `expect.hasAssertions()` count what the test actually
asserted and report in Bun's own words. `expect.unreachable()` throws.
`expect.addSnapshotSerializer()` throws `Not implemented` — which is what real
Bun 1.3 does, and better than accepting a serializer and then ignoring it.
`expect.resolvesTo` / `expect.rejectsTo` are async asymmetric matchers whose
comparison would have to be awaited from inside a synchronous `deepEquals`; they
exist so the name is not a bare `TypeError`, and they tell you to write
`await expect(promise).resolves.toEqual(value)` instead.

### Workers are real threads

`new Worker("./worker.ts")` runs on an actual thread, not a simulated one: a
second JavaScript realm with its own event loop, its own `Bun` global, and
zero-config TypeScript, talking over a structured-clone message channel. The
worker-side surface is Bun's — `self`, `postMessage`, `onmessage`,
`addEventListener` — and `Bun.isMainThread` tells the two sides apart. Those names
exist **inside a worker only**, as they do in Bun: a bare `postMessage` in your main
module is `undefined`, not a channel to somewhere.

```ts
const worker = new Worker("./hash.worker.ts");
worker.postMessage({ n: 21 });          // queued if the worker is not up yet
worker.onmessage = event => console.log(event.data);
worker.addEventListener("close", event => console.log("exit", event.code));
await worker.terminate();
```

The specifier resolves against **your project**, which is the whole point of the
distinction below. `postMessage`, `terminate()`, `ref()`/`unref()`, `threadId`,
the `open` / `message` / `error` / `close` events and the `env`, `argv` and `ref`
options all behave as documented, and messages sent before the worker is ready
are queued rather than dropped.

Three differences are worth knowing:

- **A worker that throws reaches you as `close` with a non-zero code, not as an
  `error` event.** Bun gives you the `Error` itself; the thread plumbing here
  carries only start and exit, so the stack prints to the terminal and the code
  comes back through `close`. `error` *does* fire when the script fails to
  resolve. If a crash must not pass silently, listen for both.
- **`blob:` URLs and `preload` are refused, by name.** A worker here is started
  by the kernel from a file, and the constructor is synchronous, so a `blob:`
  URL's bytes have nowhere to land on the way past; `preload` would require
  booting a generated wrapper, which would then claim to be the entry module and
  make `import.meta.main` lie. Import the module at the top of the worker file
  instead.
- **`smol` is accepted and ignored.** It sets a JavaScriptCore heap size, and
  nothing a program can observe depends on it — unlike `preload`, ignoring it
  changes no behaviour, so it does not throw.

A worker's `console.log` goes to the terminal, like any other process output, not
into the parent's captured stdout.

#### If you are used to the browser's `Worker`

They are not the same constructor, and the difference is deliberate. Inside
Vivari, the page's own `Worker` used to be visible to your code, which meant
`new Worker("./worker.ts")` resolved that path against the *studio's* origin and
fetched it over HTTP — producing a worker with no filesystem, no kernel and no
relation to your project, or a 404. Guest code now gets a `Worker` that resolves
against the VM's filesystem. Under `node` there is no global `Worker` at all,
exactly as in real Node; use `node:worker_threads` there.

### Your code runs in a Bun realm, not a browser one

A process here is a Worker in a browser tab, and a Worker's global object comes
with 367 names — 228 of which no `bun` or `node` process has. They are all
hidden before your entry module runs, so what you can see is what Bun gives you:

```ts
typeof importScripts     // "undefined"
typeof indexedDB         // "undefined"
typeof XMLHttpRequest    // "undefined"
typeof location          // "undefined"
navigator.userAgent      // "Bun/1.1.34"  (never a Chrome UA string)
typeof postMessage       // "function"    — Bun has one on the main thread too
```

This is a correctness fix before it is a security one: a library that
feature-detects `indexedDB` or `XMLHttpRequest` would take its browser path
inside what is supposed to be a Bun process, and then fail somewhere far away
from the detection. It is also the reason network calls cannot leave without
passing the sandbox's own egress — `XMLHttpRequest` and `EventSource` are gone,
so `fetch` is the way out, and `fetch` is ours.

`alert()`, `confirm()` and `prompt()` exist in Bun and **throw here**, naming the
reason: each one blocks until you type a line, and the terminal delivers
keystrokes as messages that cannot arrive while a synchronous call is waiting.
Read a line asynchronously instead — `for await (const line of console)`, or
`node:readline`.

The one exception is deliberate: `python` processes get `XMLHttpRequest` back,
because Pyodide's `urllib` bridge needs synchronous HTTP. A `bun` or `node`
process never does.
### `bun:jsc` serialize/deserialize

`serialize(value)` returns a `SharedArrayBuffer` and `deserialize` takes it back,
exactly as in Bun. It is a real structured clone, not JSON: `Map`, `Set`, `Date`,
`RegExp`, `BigInt`, typed arrays, `DataView`, `ArrayBuffer`, boxed primitives and
`Error` (name, message, stack) all survive, cycles survive, `{x: o, y: o}` comes
back with `x === y`, two views onto one buffer stay two views onto one buffer, and
a hole in a sparse array stays a hole.

```ts
import { serialize, deserialize } from "bun:jsc";

const graph = { seen: new Set([1, 2]), at: new Date() };
graph.self = graph;                       // a cycle is fine
const copy = deserialize(serialize(graph));
copy.self === copy;                       // true
```

The **bytes are not Bun's** and are not meant to be: JSC's format is internal to
the engine and Bun documents its output as non-portable, so what is matched is the
behaviour, case by case, against a real binary. Do not write these bytes to disk
and expect another runtime — or another version — to read them.

Functions, symbols, `WeakMap`s and promises are refused with a `DOMException`, as
they are in Bun and in the browser.
### TCP inside the VM: `Bun.listen` and `Bun.connect`

Both work, for destinations inside the VM. The sandbox has its own
kernel-routed loopback network — the one `node:net` and `Bun.serve` already use —
so a Bun TCP server and the process that connects to it are ordinary programs
here:

```ts
const server = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,                               // a real port, synchronously
  socket: {
    data(socket, chunk) { socket.write("echo:" + Buffer.from(chunk).toString()); },
  },
});

const client = await Bun.connect({
  hostname: "127.0.0.1",
  port: server.port,
  socket: { data(_s, chunk) { console.log(Buffer.from(chunk).toString()); } },
});
client.write("hello");
```

Handlers get `(socket, data)` with `data` as a `Uint8Array`, the socket carries a
writable `.data` slot, and `Bun.connect` both rejects and calls `connectError`
when nothing is listening — all as in Bun.

What is refused, by name:

- **A host outside the VM.** `Bun.connect({ hostname: "example.com" })` throws:
  a tab cannot open a raw socket to the internet. Outbound traffic is `fetch()`,
  which the sandbox proxies.
- **Binding anything but loopback.** A listener can only be reached by other
  processes in this VM. To expose an HTTP server to the page, use `Bun.serve()`,
  whose ports the preview proxy can see.
- **TLS** (`tls: true`, `upgradeTLS()`, the certificate accessors). There is no
  certificate authority and no real transport to encrypt, and a socket reporting
  `authorized: true` about a plaintext link would be a lie with consequences.
### The `bun` CLI: `init`, `pm`, `create`

`bun init` scaffolds Bun's own template — `package.json`, `index.ts`,
`tsconfig.json`, `README.md` and `.gitignore`, byte-identical to what the binary
writes, down to the two typos in Bun's `.gitignore` — and then installs, which
here means npm doing the install (as every `bun install` does in Vivari). Running
it in a project that already has those files leaves them alone.

`bun pm ls` (`--all`), `bun pm bin`, `bun pm pkg get|set|delete`, `bun pm why`,
`bun pm cache` and `bun pm pack` all work, over the same `node_modules` the
install wrote. `bun pm whoami`, `bun pm view` and `bun pm scan` are refused: they
need an authenticated registry session, and the sandbox has no credential store
to hold one.

`bun create vite my-app` runs the generator package (`create-vite`) the way
`bunx` does. `bun create <user/repo>` is refused — it clones over git, and the
sandbox has no git transport.

`bun link` and `bun unlink` map to npm's, and `bun upgrade` is still refused: it
replaces the Bun binary, and there is no binary here.

### Scripting with `Bun.$`

The shell is lazy, exactly as in Bun: nothing runs until you `await`, which is
what lets the modifiers mean anything.

```ts
import { $ } from "bun";

const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
const { exitCode } = await $`test -f missing.txt`.nothrow().quiet();
await $`npm run build`.env({ ...process.env, NODE_ENV: "production" }).cwd("./app");

for await (const line of $`cat access.log`.lines()) {
  if (line.includes(" 500 ")) console.log(line);
}
```

`.text()`, `.json()`, `.bytes()`, `.blob()`, `.arrayBuffer()` and `.lines()` read
the output — and reading it means capturing it, so none of them also echo to the
terminal. `.quiet()` suppresses the passthrough for a command you are *not*
reading, `.nothrow()` returns a non-zero exit instead of throwing, and
`.throws(false)` is the same thing spelled the other way.

Piped input reads the same as it does in Bun:

```ts
const input = await Bun.stdin.text();
```

`Bun.stdin` also remains a Node `Readable`, so `.on("data")` and `for await`
still work on it.

### `bun test`

The runner covers the surface a real suite uses: `describe`/`test` with the whole
`.skip`/`.only`/`.todo`/`.each`/`.if`/`.failing` family, per-test `timeout`,
`retry` and `repeats`, `mock`/`spyOn`/`mock.module()`, the asymmetric matchers
(`expect.any`, `expect.objectContaining`, `expect.extend`, …), `.resolves`/
`.rejects` with the full matcher set, and file-backed `toMatchSnapshot()` writing
Bun's own `.snap` format. On the CLI: `-t`/`--test-name-pattern`, `--bail`,
`--timeout`, `-u`, `--todo`, `--only` and `--reporter=junit`.

Four divergences, all deliberate:

- **`toMatchInlineSnapshot()` with no argument throws.** Creating one means
  rewriting your source file, and the position would come from a stack frame
  pointing at loader-transformed code. The error prints the value to paste in.
- **A `Map` or `Set` nested inside an object or array cannot be snapshotted.**
  Real Bun's own bytes for that shape are malformed, so any file written here
  would fail under a real `bun test`. Snapshot it on its own, or use `toEqual`.
- **`mock.module()` on a builtin throws.** Real Bun silently leaves the builtin
  unmocked, which means your test asserts against the real module while believing
  it is mocked.
- **`await expect(p).rejects.toThrow()` always returns a promise.** Real Bun
  returns `undefined` for an already-settled promise, which no browser engine can
  do. Forgetting the `await` still fails the test here, rather than passing.

`.only` throwing under `$CI`, and a missing snapshot being an error under `$CI`
rather than something created, are real Bun behaviours and are reproduced.

Start from any template in the Studio's **Bun** category.

### `Bun.Transpiler` and the scan family

`transformSync`/`transform` strip types with the same transform the loader uses.
`scan()` and `scanImports()` report what a file imports and exports, without
resolving or running anything:

```ts
const t = new Bun.Transpiler({ loader: "ts" });

t.scan(`import { a } from "./a"; export const b = 1;`);
// { exports: ["b"], imports: [{ kind: "import-statement", path: "./a" }] }
```

**The two methods do not report the same set.** This surprises people, so it is
worth stating plainly — it is Bun's behaviour, reproduced deliberately:

| kind | `scan()` | `scanImports()` |
| --- | :---: | :---: |
| `import-statement` (including `export … from`) | ✅ | ✅ |
| `dynamic-import` | ✅ | ✅ |
| `require-call` | ❌ | ✅ |
| `require-resolve` | ✅ | ❌ |

So a CommonJS file whose only dependency is `require("x")` **scans as importing
nothing**. If you are crawling dependencies, `scanImports()` is almost always the
one you want.

Other behaviour worth knowing, all of it matching real Bun: results are in source
order and are **not** deduplicated, so a module imported twice appears twice;
`exports` **is** sorted (by code unit, so `["A", "B", "a", "b"]`); `import type`
contributes nothing; and a dynamic `import(someVariable)` reports nothing rather
than guessing at the specifier.

Two things differ from real Bun. A `.jsx`/`.tsx` file that uses JSX gets two extra
`require-call` entries from Bun — `react/jsx-runtime` and `react`, injected by its
automatic JSX runtime — which are absent here, because Vivari's JSX transform emits
classic `React.createElement` and introduces no new specifier at all. And the
scanner is a lexer rather than a full parser, so source that is genuinely invalid
may scan cleanly instead of raising.

## Bundling with `Bun.build`

`Bun.build()` and `bun build` really bundle: a dependency graph across `.ts`,
`.tsx`, `.js`, `.jsx`, `.json` and `.txt`, including packages from
`node_modules`, with ESM and CommonJS mixed freely and import cycles handled.

```ts
const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "browser",
  format: "esm",
  external: ["react"],
  define: { "process.env.NODE_ENV": '"production"' },
});

if (!result.success) for (const log of result.logs) console.error(log.message);
for (const artifact of result.outputs) console.log(artifact.path, artifact.hash);
```

Outputs are Bun's `BuildArtifact`: Blob-like, with `path`, `kind`, `loader`,
`hash`, `.text()`, `.arrayBuffer()` and `.bytes()`.

:::warning The output bytes are not identical to real Bun's

This is a different bundler, not a port of Bun's. Bun's is a Zig program with its
own parser, scope hoister, tree shaker and printer; Vivari's emits a registry of
CommonJS-shaped module factories behind a small prelude. For the same input you
get a **different file** — different wrapping, different ordering, no tree
shaking, no renaming, and a larger bundle.

What is promised is that the bundle **runs and computes the same thing**. Please
do not file a bug about the bytes; please do file one about behaviour.
:::

Vivari's bundler is written against the runtime's own module resolver rather than
delegating to esbuild, so that `Bun.build` works in a project with nothing
installed — as it does under real Bun — and so that a bundle contains exactly
what `require` would have loaded here. The trade is capability: **`minify`,
`splitting`, `sourcemap` and `bytecode` throw** rather than being silently
dropped from a build that then reports success. When you need them, run a real
bundler; `esbuild`, Rollup, Rspack and Vite all work in-VM, and `esbuild` is
aliased to `esbuild-wasm` for you.

`target: "browser"` refuses a Node builtin by name instead of emitting a bundle
that fails on first run — list it in `external` if you are supplying it yourself.
`bun build --compile` is refused for the reason in the table above.

## Plugins

`Bun.plugin` works in both of its lifetimes.

```ts
Bun.plugin({
  name: "build-info",
  setup(build) {
    build.onResolve({ filter: /^app:info$/ }, ({ path }) => ({
      path,
      namespace: "app",
    }));
    build.onLoad({ filter: /.*/, namespace: "app" }, () => ({
      loader: "json",
      contents: JSON.stringify({ builtAt: Date.now() }),
    }));
  },
});

import info from "app:info"; // { builtAt: … }
```

A plugin registered with `Bun.plugin()` is a **runtime** plugin: it changes what
`require`/`import` see in the process that registered it. One passed as
`Bun.build({ plugins: [...] })` affects that build only. Both get `onResolve` and
`onLoad`.

`onLoad` returns `contents` plus a `loader`, one of `js`, `jsx`, `ts`, `tsx`,
`json`, `text` or `toml`. Bun's `loader: "object"` — which hands back a live
JavaScript value rather than source text — throws here, naming itself: this
module system compiles source, so return `contents` with loader `js` instead.

One further divergence: **runtime hooks must be synchronous here.** Vivari's
module loader is synchronous all the way down, so there is nowhere to await, and
an async hook throws rather than handing your module a pending promise as its
exports. Build-time hooks may be async.

[`bcryptjs`]: https://www.npmjs.com/package/bcryptjs
[`sql.js`]: https://sql.js.org
[`@electric-sql/pglite`]: https://pglite.dev