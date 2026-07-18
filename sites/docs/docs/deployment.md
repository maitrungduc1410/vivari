---
sidebar_position: 8
title: Deployment
---

# Deploying on Cloudflare Pages

This project ships four surfaces on a **single origin** so cross-links stay
root-relative:

| Path | App | Cross-origin isolated? |
| --- | --- | --- |
| `/` | Landing (Vite + React) | No |
| `/docs/` | Docs (this site — Docusaurus) | **Yes** |
| `/studio/` | Studio (the IDE) | **Yes** |
| `/embed/` | Live doc examples (Vite + React) | **Yes** |

The studio and the `/embed/` playground run the Vivari runtime, so they need
COOP/COEP. The docs are isolated too, because they host the `/embed/` playground
in an `<iframe>` and an iframe is only cross-origin isolated when its top-level
document is. Only the landing (`/`) stays free of COEP. Isolating the docs is safe
because they load only same-origin assets — adding a cross-origin resource (e.g.
Algolia DocSearch, external images) would need `credentialless` or CORP headers.

## Unified build

A single command builds all three and assembles them into `dist/`:

```bash
npm run build:site
```

Under the hood it builds the Rust→Wasm crates, then the studio (with Vite
`base: "/studio/"`), the `/embed/` playground (`base: "/embed/"`), the landing, and
the docs, then assembles the output. The preview Service Worker and its runtime
asset tree stay at the origin root (`/sw.js`, `/preview/*`, `/vv-devtools/*`,
`/devtools/*`) because the SW claims root scope; the studio and embed UIs are
namespaced under `/studio/` and `/embed/`.

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
every surface that runs (or hosts) the runtime, plus the Service Worker:

```
/studio/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp

/embed/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp

/docs/*
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
