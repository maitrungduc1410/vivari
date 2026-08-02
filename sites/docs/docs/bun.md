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
| `Bun.connect` (raw TCP client) | `fetch()`, or `bun:sqlite` for data | A page cannot open a raw socket. Traffic that leaves the tab is HTTP(S) through `fetch`, gated by the remote origin's CORS policy |
| `Bun.listen` (raw TCP server) | `Bun.serve()` | A page cannot bind or accept a socket; a port here is a kernel routing entry the Service Worker turns into a preview |
| `Bun.udpSocket` | — | There is no UDP in a browser at all. WebRTC data channels are peer-negotiated, not addressed by host and port |
| `Bun.SQL` (Postgres, MySQL) | `bun:sqlite`, or [`@electric-sql/pglite`] for the Postgres dialect | Both speak binary wire protocols over TCP |
| `Bun.RedisClient` / `Bun.redis` | A `Map` for in-process caching; `bun:sqlite` to persist | RESP3 runs over TCP |
| `bun:ffi` (`dlopen`, `cc`, `JSCallback`, `ptr`, …) | WebAssembly (`WebAssembly.instantiate`) | Loading a shared library needs `dlopen(3)` and executing native machine code |
| Native `.node` addons | see the table below | Same wall: compiled machine code for one OS and CPU |
| `Bun.mmap` | `Bun.file(p).bytes()` + `Bun.write` | No `mmap(2)`. Note that is a copy, so two views no longer alias |
| `Bun.secrets` | A server you reach over HTTPS; `.env` for non-secret config | It stores credentials in the OS keychain. `localStorage` would satisfy the signature and void the encryption-at-rest guarantee that is the entire point |
| `Bun.peek` / `Bun.peek.status` | `await`, `.then()` | A settled promise's value lives in engine-internal state that no JavaScript engine exposes synchronously to page code |
| `Bun.WebView` | Drive Vivari's preview `<iframe>` from your host page | It launches a real browser process, or talks to one over the Chrome DevTools Protocol on a TCP port |
| `bun build --compile` | `bun build <entry> --outfile=<file>` | It emits a standalone native executable with the Bun runtime embedded |

A few things are **not implemented rather than impossible**, and the error says
so in different words, because "stop and redesign" and "send a patch" are not the
same advice: `Bun.spawn({ terminal: true })` (a pty could be emulated in
JavaScript; the kernel gives a child plain pipes today), `Bun.SQL`'s SQLite
adapter (use the `bun:sqlite` module), `Bun.build`'s `minify` / `splitting` /
`sourcemap` options (see [Bundling](#bundling-with-bunbuild) below), and Bun
macros, which need no capability the sandbox lacks.

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
`Bun.CryptoHasher` and `Bun.password`, `Bun.hash`, `Bun.YAML`/`TOML`/`JSON5`,
`Bun.build` and `Bun.plugin` (see below), `Bun.Transpiler`, zero-config TypeScript, automatic
`.env` loading with Bun's precedence rules, and
the `bun:test` runner all behave as documented — and where they diverge, the
divergence is written down rather than discovered.

Where an API has one exact right answer, it is pinned to a value produced by real
Bun rather than to itself: `Bun.hash` is checked against Bun's own published
wyhash digests, and a `Bun.password` hash written in the sandbox verifies under
real Bun and vice versa.

Both spellings of the import work — the `Bun` global, and the bare module Bun's
own documentation tends to use:

```ts
import { $, file, write, semver } from "bun";
```

That module *is* the global (same objects, not re-exports), so anything reachable
one way is reachable the other.

### Nine templates in the Bun tab

Every one of them boots in CI from the exact bytes the studio writes into your
project, so none is marked experimental:

| Template | What it shows |
| --- | --- |
| serve / routes / websocket / react | `Bun.serve` — plain `fetch`, the `routes` table, server-side WebSockets, and on-the-fly TSX |
| test | the `bun:test` runner: matchers, `mock`/`spyOn`, `test.each`, snapshots |
| SQLite | `bun:sqlite` — a CRUD API over a real database file that survives a reload |
| shell | `Bun.$` — pipes, redirects, exit codes, per-command `env` and `cwd` |
| bundler | `Bun.build` — a multi-module bundle, a plugin, `define`, `external` |
| API tour | hashing, `Bun.password`, YAML/TOML, `Glob`, `semver`, `stringWidth`, `Bun.Transpiler` |

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