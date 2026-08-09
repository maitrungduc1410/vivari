# Vivari

<div align="center">
  <img src="./icon.svg" width="128" height="128" />
</div>

<div align="center">

**Node, Bun and Python, actually running in your browser tab.**

Not a shim: Vivari runs Node's real `lib/`, the real `npm`, `yarn` and `pnpm`,
and real CPython. No server does the work.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue.svg)](https://www.typescriptlang.org/)

[Website](https://vivari.run) ·
[Docs](https://vivari.run/docs) ·
[Blog](https://vivari.run/blog/) ·
**[Studio (live demo)](https://vivari.run/studio/)** ·
[npm](https://www.npmjs.com/package/@vivari/core)

</div>

<!-- DEMO MEDIA goes here: a GIF via ![alt](url), or a bare GitHub-hosted video URL
     on its own line (.mp4/.mov/.webm, H.264). Limits: 10 MB for images/GIFs, and
     10 MB for video on a free plan / 100 MB on a paid one. Upload by dragging the
     file into a GitHub issue comment and copying the generated CDN link. Do not
     commit the binary, or every clone pays for it forever. -->

**[Open the Studio](https://vivari.run/studio/)** to try it without installing
anything: pick a template, run `npm install && npm run dev`, and watch a real dev
server boot in the tab.

## Yes, it really runs this

A browser Node runtime is easy to demo and hard to finish. This is the part that
only works once the runtime is deep enough. Every row is something you can go and
try in the [Studio](https://vivari.run/studio/) right now.

| Area | What actually runs | Status |
| --- | --- | --- |
| **Node** | Node's own `lib/` JavaScript: `fs`, `stream`, `http`, `crypto`, `zlib`, `net` and the rest, not hand-written imitations. Synchronous `require`, `node_modules` resolution, a PID table, pipes, signals, `execSync`, and an interactive REPL. | Stable |
| **Package managers** | `npm`, `yarn`, `pnpm` and `corepack`: the actual CLIs, resolving and linking a real lockfile against the registry, with content-addressed caches that survive a reload. | Stable |
| **Next.js 16** | `next dev` on the App Router with the Wasm SWC, compiling and server-rendering React Server Components in the tab. Real Next.js from npm, real webpack, real SWC, no server anywhere. Caveats are real too: Turbopack cannot work (native Rust, no Wasm build), the `AsyncLocalStorage` polyfill is correct for one request at a time rather than general-purpose, and the first compile is heavy. [The full teardown](https://vivari.run/blog/nextjs-rsc-in-a-tab). | Stable |
| **Vite frameworks** | React 19, Vue, Svelte 5, Preact, Solid, Qwik and Lit, with HMR. | Stable |
| **Meta-frameworks & tooling** | Astro, React Router, Angular, Slidev, Tailwind, webpack, Vitest, and the doc generators (Docusaurus, VitePress, Rspress, Starlight). | Stable |
| ↳ | Nuxt, SvelteKit, TanStack Router. | Experimental |
| **Servers** | Express, NestJS, Fastify, Koa, Hono, H3, Nitro, tRPC, GraphQL, Socket.IO, Feathers, raw WebSocket and SSE. `listen()` runs in-VM and is previewed live. | Stable |
| **Bun** | `bun install`, `bun run`, `Bun.serve`, `Bun.build`, `Bun.plugin`, `Bun.Transpiler`, Bun Shell, `bun:test` (all 87 of Bun's matchers), `bun:sqlite`, and `bun repl` with TypeScript at the prompt. This one is an **API-compatible shim**, and says so: nothing can execute the native Zig binary in a page, so the ~20 APIs that need a real OS refuse explicitly instead of approximating. [Details](https://vivari.run/docs/bun). | Stable |
| **Python** | Real CPython 3.14 via Pyodide (the reference implementation, with its standard library and its C extension modules), plus `pip` and a REPL. The first interpreter of a session costs ~1.8 s; later ones resume from a snapshot in ~0.2 s. | Stable |
| ↳ | Everything built on top of it: every Python template except the bare `python` starter. That is `pytest`, the notebook, the scientific stack (NumPy, pandas, Matplotlib, SciPy and scikit-learn, vendored and working offline), the web frameworks (FastAPI, Flask, Django), `sqlite3` and the SQLAlchemy ORM. | Experimental |
| **SQLite** | `bun:sqlite`. | Stable |
| ↳ | The standalone sql.js template, and Python's `sqlite3` / SQLAlchemy templates. | Experimental |
| **Postgres** | PGlite (real Postgres compiled to Wasm) over the virtual filesystem, with no Docker and no native dependency. | Experimental |
| **Step debugger** | Breakpoints, stepping, call stack, scopes and expression evaluation in guest Node processes, over the Chrome DevTools Protocol. | Studio feature |
| **Git** | Stage, unstage, commit, branch, diff, history and discard, via isomorphic-git over the VFS. **Local-only by design**: there is no remote, so no `clone`, `push` or `pull`. | Studio feature |
| **Previews** | An in-VM server is reachable through a Service Worker, in three isolation modes up to a wildcard per-port origin, so each preview gets real `localhost` semantics. | Stable |

**Experimental** does not mean a sketch: it runs, and you can go and try it. It
means the thing is not yet held in place by a check that would catch it breaking,
so treat it as movable. These rows carry the repository's own per-template
flag, whose bar for graduation is specific: a green spike of the template's own
(`scripts/spike-<name>.mjs`, see [`AGENTS.md`](AGENTS.md)). **Studio feature**
means it is built into the [Studio](https://vivari.run/studio/) IDE rather than
exposed as an SDK API.

## Requirements

Vivari's synchronous filesystem and process bridge is built on
`SharedArrayBuffer` and `Atomics.wait()`, which browsers only expose on a
**cross-origin isolated** page. Whatever serves your app (and the preview
Service Worker) has to send:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

This is the real integration cost, and it is worth knowing before you start:
cross-origin isolation also constrains what else that page may embed. The
[cross-origin isolation guide](https://vivari.run/docs/cross-origin-isolation)
covers the consequences and the ways around them. `Vivari.boot()` rejects early
with `ERR_NOT_ISOLATED` rather than failing somewhere confusing later.

Node **>= 22** (see `.nvmrc`) is needed to build the project, not to run it.

## Install

```bash
npm install @vivari/core                 # framework-agnostic SDK
npm install @vivari/react @vivari/core   # React bindings (core is a peer dep)
```

```ts
import { Vivari } from "@vivari/core";

const vivari = await Vivari.boot();
await vivari.mount({
  "package.json": { file: { contents: '{ "type": "module" }' } },
  "index.js": { file: { contents: "console.log('hello from the browser')" } },
});

const proc = await vivari.spawn("node", ["index.js"]);
for await (const chunk of proc.output) console.log(chunk);
await proc.exit;
```

Full guides, the API reference, and interactive examples live in the
[documentation](https://vivari.run/docs).

## How it works (in one breath)

Node's APIs are **synchronous**. Browsers won't let you block on async work,
*except on a Web Worker thread*, where `Atomics.wait()` can genuinely park
execution. So `fs.readFileSync` parks the worker until the host answers over a
`SharedArrayBuffer`; a kernel over a Rust/Wasm VFS services the syscalls, and a
Service Worker previews an in-VM HTTP server live in an iframe. See
[How it works](https://vivari.run/docs/how-it-works) for the full story.

## How Vivari compares

Against the **proprietary WebContainer**: Vivari runs the same class of project,
and the difference is the terms. Vivari is MIT: no commercial license to
negotiate, no per-seat or usage fee, and every asset can be self-hosted on a
domain you control. It is **not an API-compatible drop-in**, though: the
`FileSystemTree` shape `mount()` accepts is deliberately WebContainer-shaped,
but the rest of the surface is its own, so moving an existing integration across
is a port rather than an import swap.

Against the **lightweight shim libraries**: those hand-write Node's core modules,
which keeps them small and lets them skip cross-origin isolation. Vivari ships
Node's real `lib/` instead, which is what makes `stream`, `http` and `crypto`
behave the way fifteen years of npm packages expect, and it is why Vivari is
the heavier dependency and does require the COOP/COEP headers above. Which
trade you want depends on whether you are embedding a snippet playground or a
real project.

## Repository layout

```
packages/
  core/      @vivari/core   — the framework-agnostic SDK
  react/     @vivari/react  — React components + hooks
  vfs/ codec/ crypto/       — Rust crates compiled to Wasm
  runtime/ kernel-host/ protocol/  — the Node runtime shim + kernel
  studio/    the studio IDE (Vite + React)
sites/
  landing/   the marketing site (Vite + React)
  docs/      the documentation site (Docusaurus)
  blog/      the engineering teardowns (Docusaurus)
  embed/     the runnable examples the docs and blog iframe
examples/
  basic/     a minimal, runnable SDK example
scripts/     verify / smoke / spike harnesses + the site build
worker/      the Cloudflare Worker for wildcard per-port preview origins
```

## Develop

Prereqs: **Node `>=22`** (see `.nvmrc`), plus Rust + `wasm-pack` for the Wasm crates.

```bash
npm install
npm run build      # compile the Rust VFS/codec/crypto to Wasm
npm run verify     # headless proof the sync-bridge works end-to-end
npm run dev        # start the studio IDE
```

Build the full site (landing + docs + studio) for a static deploy:

```bash
npm run build:site   # assembles everything into dist/ (see sites/docs deployment guide)
```

## How it was built

Six teardowns of the problems that had to be solved, with the dead ends left in:

- [The one browser API that makes a Node runtime possible](https://vivari.run/blog/blocking-in-a-browser): `Atomics.wait()`, and why every other approach to synchronous I/O fails.
- [Running Node's real `lib/` in a browser tab](https://vivari.run/blog/nodes-real-lib-in-the-browser): months spent hand-writing core modules, then taking apart a 2.1 MB StackBlitz bundle and throwing the approach away.
- [Real npm, yarn and pnpm in the browser, and how each one broke the runtime](https://vivari.run/blog/real-package-managers-in-the-browser)
- [Three ways to isolate a preview, and the Cloudflare wildcard trick](https://vivari.run/blog/three-ways-to-isolate-a-preview)
- [llhttp in Wasm, and a real Postgres in the tab](https://vivari.run/blog/databases-and-the-http-parser)
- [Next.js 16 renders React Server Components in a browser tab, and the AsyncLocalStorage trap](https://vivari.run/blog/nextjs-rsc-in-a-tab)

## Contributing & security

- [Contributing guide](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md)
- Found a vulnerability? See [SECURITY.md](SECURITY.md).

Releases are cut from the manual **Publish SDK** GitHub Actions workflow
(`.github/workflows/publish.yml`).

## License

[MIT](LICENSE). Free for any use, commercial or otherwise. There is no
commercial license and no usage fee: embed it, fork it, ship it.

> **Vivari** *(vih-VAH-ree)* takes its name from the Latin *vivarium*, a self-contained enclosure for living things. That's exactly what it is for a running Node app: a sealed, self-contained environment in the browser where a whole project lives and runs.