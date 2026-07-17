---
sidebar_position: 8
title: Deployment
---

# Deploying on Cloudflare Pages

This project ships three surfaces on a **single origin** so cross-links stay
root-relative:

| Path | App | Cross-origin isolated? |
| --- | --- | --- |
| `/` | Landing (Vite + React) | No |
| `/docs/` | Docs (this site — Docusaurus) | No |
| `/studio/` | Studio (the IDE) | **Yes** |

The studio needs COOP/COEP; the landing and docs do not. Cross-origin isolation
is scoped to just the paths that need it, so the marketing pages are free of CORP
constraints.

## Unified build

A single command builds all three and assembles them into `dist/`:

```bash
npm run build:site
```

Under the hood it builds the Rust→Wasm crates, then the studio (with Vite
`base: "/studio/"`), the landing, and the docs, then assembles the output. The
preview Service Worker and its runtime asset tree stay at the origin root
(`/sw.js`, `/preview/*`, `/vv-devtools/*`, `/devtools/*`) because the SW claims
root scope; only the studio UI is namespaced under `/studio/`.

## Cloudflare Pages settings

| Setting | Value |
| --- | --- |
| Build command | `bash scripts/cloudflare-build.sh` |
| Build output directory | `dist` |
| Node version | `22` (via `.nvmrc`) |

The build script provisions the Rust toolchain + `wasm-pack` in the build
container, so no extra configuration is needed.

## Headers (`_headers`)

The assembler emits a `dist/_headers` file that scopes cross-origin isolation to
the studio and the Service Worker only:

```
/studio/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp

/sw.js
  Service-Worker-Allowed: /
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

Preview responses (`/preview/<port>/…`) are synthesized by the Service Worker,
which stamps their isolation headers itself — so they don't need an entry here.

## Local preview

```bash
npm run build:site
npx serve dist   # or any static server that honors _headers
```

Because `_headers` is a Cloudflare Pages convention, a plain static server won't
apply it — use `wrangler pages dev dist` to preview headers locally.
