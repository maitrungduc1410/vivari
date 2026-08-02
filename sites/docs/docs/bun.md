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
adapter (use the `bun:sqlite` module), and `Bun.build` / `Bun.plugin` / Bun
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
zero-config TypeScript, automatic `.env` loading with Bun's precedence rules, and
the `bun:test` runner all behave as documented — and where they diverge, the
divergence is written down rather than discovered.

Where an API has one exact right answer, it is pinned to a value produced by real
Bun rather than to itself: `Bun.hash` is checked against Bun's own published
wyhash digests, and a `Bun.password` hash written in the sandbox verifies under
real Bun and vice versa.

Start from any template in the Studio's **Bun** category.

[`bcryptjs`]: https://www.npmjs.com/package/bcryptjs
[`sql.js`]: https://sql.js.org
[`@electric-sql/pglite`]: https://pglite.dev