---
slug: /
sidebar_position: 1
title: Introduction
---

# Vivari

**Vivari is an open-source WebContainer.** It runs Node-style projects (Vite,
Express, and more) **100% inside the browser** — a virtual filesystem, a
Node-compatible runtime, a process model, and virtual networking, all in Web
Workers with no server doing the work.

It ships in two forms:

- **The [Studio](https://vivari.pages.dev/studio/)** — a full in-browser IDE built on Vivari.
- **The SDK** — [`@vivari/core`](./core-api) (framework-agnostic) and
  [`@vivari/react`](./react) (a `<Vivari>` component + `useVivari()` hook) that
  you can embed in your own app.

:::tip Try it now
The fastest way to understand Vivari is to [open the Studio](https://vivari.pages.dev/studio/) and run a
template — each shell command becomes its own worker/process, and an in-VM dev
server is previewed live through a Service Worker.
:::

## Why it exists

Node's APIs (`fs.readFileSync`, `require()`, …) are **synchronous**. Browsers
don't let you block on async work — *except on a Web Worker thread*, where
`Atomics.wait()` can genuinely park execution. That single primitive makes a
synchronous Node runtime possible in the browser. See
[How it works](./how-it-works) for the full story.

## What you get

| Capability | What it means |
| --- | --- |
| Virtual filesystem | A POSIX-ish VFS in Rust/Wasm, persisted to OPFS |
| Node runtime | Synchronous `require`, `node_modules` resolution, core builtins |
| Process model | A kernel + PID table + shell; `execSync`, pipes, signals |
| Virtual networking | `http.createServer().listen()` previewed live in an iframe |
| Package managers | `npm` / `yarn` / `pnpm` with content-addressed caches |

## Genuinely open

Vivari is **MIT-licensed**. Unlike a proprietary WebContainer API, there is no
commercial license and no usage fee: embed it, fork it, ship it.

## Next steps

- [Getting started](./getting-started) — install and boot your first instance.
- [Core API](./core-api) — the `@vivari/core` reference.
- [React](./react) — `<Vivari>` and `useVivari()`.
- [Deployment](./deployment) — host the landing, docs, and studio on Cloudflare Pages.
