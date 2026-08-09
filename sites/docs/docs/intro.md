---
slug: /
sidebar_position: 1
title: Introduction
---

# Vivari

**Vivari is an open-source WebContainer.** It runs **Node, Bun and Python**
projects **100% inside the browser**: a virtual filesystem, a Node-compatible
runtime, a process model, and virtual networking, all in Web Workers with no
server doing the work.

It is not a shim over hand-written core modules. Vivari runs Node's own `lib/`
JavaScript, the real `npm`, `yarn` and `pnpm`, and real CPython.

:::info The name
**Vivari** *(vih-VAH-ree)* comes from the Latin *vivarium*, a self-contained
enclosure for living things. That's exactly what it is for a running Node app: a
sealed environment in the browser where a whole project lives and runs.
:::

It ships in two forms:

- **The [Studio](https://vivari.run/studio/)**: a full in-browser IDE built on Vivari.
- **The SDK**: [`@vivari/core`](./core-api) (framework-agnostic) and
  [`@vivari/react`](./react) (components and hooks for embedding a VM, its
  preview, its files and its processes) that you can embed in your own app.

:::tip Try it now
The fastest way to understand Vivari is to [open the Studio](https://vivari.run/studio/) and run a
template: each shell command becomes its own worker/process, and an in-VM dev
server is previewed live through a Service Worker.
:::

## Why it exists

Node's APIs (`fs.readFileSync`, `require()`, …) are **synchronous**. Browsers
don't let you block on async work, *except on a Web Worker thread*, where
`Atomics.wait()` can genuinely park execution. That single primitive makes a
synchronous Node runtime possible in the browser. See
[How it works](./how-it-works) for the full story.

## What you get

| Capability | What it means |
| --- | --- |
| Virtual filesystem | A POSIX-ish VFS in Rust/Wasm, persisted to OPFS |
| Node runtime | Node's own `lib/`, synchronous `require`, `node_modules` resolution, a REPL |
| Process model | A kernel + PID table + shell; `execSync`, pipes, signals |
| Virtual networking | `http.createServer().listen()` previewed live in an iframe |
| Package managers | `npm` / `yarn` / `pnpm` / `corepack` with content-addressed caches |
| Frameworks | Next.js 16 (App Router + RSC), Vite (React, Vue, Svelte 5, Solid, Qwik, Preact, Lit), Astro, Angular, and the servers (Express, NestJS, Fastify, Hono, …) |
| [Bun](./bun) | `bun install` / `run` / `test`, `Bun.serve`, `Bun.build`, `bun:sqlite`, `bun repl`. An API-compatible shim, not the native binary |
| [Python](./python) | Real CPython 3.14 via Pyodide, with `pip` and a REPL; the templates around it (`pytest`, the notebook, the scientific stack, the web frameworks) are experimental |
| Databases | SQLite via `bun:sqlite`; the sql.js, Python `sqlite3`/SQLAlchemy and PGlite (Postgres) templates are experimental |
| Debugger | Breakpoints, stepping and evaluation in guest Node processes over the Chrome DevTools Protocol (in the Studio) |

**Experimental** does not mean a sketch: it runs, and you can go and try it. It
means the thing is not yet held in place by a check that would catch it breaking.
Most of these carry a per-template flag, whose bar for graduation is specific: a
green spike of the template's own (`scripts/spike-<name>.mjs`). Nuxt, SvelteKit,
TanStack Router, PGlite, sql.js and every Python template except the bare
`python` starter are experimental today.

## Genuinely open

Vivari is **MIT-licensed**. Unlike a proprietary WebContainer API, there is no
commercial license and no usage fee: embed it, fork it, ship it.

## Next steps

- [Getting started](./getting-started): install and boot your first instance.
- [Core API](./core-api): the `@vivari/core` reference.
- [React](./react): the `@vivari/react` components and hooks.
- [Deployment](./deployment): host the landing, docs, and studio on Cloudflare Pages.