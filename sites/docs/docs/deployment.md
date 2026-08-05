---
sidebar_position: 9
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

/blog/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp

/devtools-host.html
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp

/devtools-host
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp

/devtools/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp

/sw.js
  Service-Worker-Allowed: /
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

Preview responses (`/preview/<port>/…`) are synthesized by the Service Worker,
which stamps their isolation headers itself — so they don't need an entry here.

The DevTools entries look redundant — the frontend is same-origin, and same-origin
subresources are exempt from CORP under `require-corp`. A nested **document** is
not: an iframe must send `require-corp` (or `credentialless`) on its own response
or the browser blocks the frame and shows "*&lt;host&gt; refused to connect*". Because
`/devtools-host.html` is hoisted out of `/studio/` to the origin root, the
`/studio/*` rule doesn't reach it, so it needs its own entry. Both the `.html` and
the extensionless form are listed since Pages' clean URLs redirect `/x.html` to
`/x` and the rule has to match whichever URL answers `200`. This is invisible in
`npm run dev`, where Vite stamps isolation on every response.

## Preview isolation modes (optional)

By default previews run **same-origin** with the IDE (mode A) — zero extra infra.
Two opt-in modes move previews onto a separate origin so preview code (including
your npm dependencies) can't touch the IDE's cookies / `localStorage` / OPFS. All
three are the same client-side runtime; the mode is inferred from build-time env on
the **studio (main) project** (the preview origin needs no env of its own).

| | A. same-origin | B. shared origin | C. wildcard per-port |
| --- | --- | --- | --- |
| Preview URL | `…/preview/5173/` | `preview-origin/preview/5173/` | `<token>--5173.<domain>/` |
| Isolates IDE ↔ preview | ❌ | ✅ | ✅ |
| Isolates preview ↔ preview | ❌ | ❌ | ✅ (own origin per port) |
| Extra infra | none | +1 Pages project | wildcard DNS + a Worker |
| Env (studio project) | — | `VITE_PREVIEW_ORIGIN` | `VITE_PREVIEW_WILDCARD_DOMAIN` |

`VITE_PREVIEW_WILDCARD_DOMAIN` takes precedence over `VITE_PREVIEW_ORIGIN` when
both are set.

### Mode B — shared preview origin

1. Create a **second** Cloudflare Pages project (e.g. `vivari-preview`) with build
   command `bash scripts/cloudflare-build-preview.sh` and output dir `dist-preview`.
   It serves only the static SW runtime (`sw.js`, `__vv-bridge.html`,
   `__vv-preview-boot.html`, `vv-devtools/`) with `COEP: credentialless`,
   `CORP: cross-origin` and `Service-Worker-Allowed: /`.
2. On the **main** project set `VITE_PREVIEW_ORIGIN=https://vivari-preview.pages.dev`
   and redeploy.
3. Optional: `VITE_PREVIEW_POPOUT=isolated` opens **"Open in new tab"** on the
   preview origin instead of same-origin. On a **cross-site** preview origin (e.g.
   a `*.pages.dev` project, which the Public Suffix List makes a distinct site) the
   pop-out shows a one-time "connect this tab" Storage-Access gate. To skip the gate,
   put the IDE and preview on **subdomains of one base domain** (same-site) — see
   mode C, which does this by construction.

### Mode C — wildcard per-port preview origins

Each in-VM port gets its own origin `<token>--<port>.<domain>` (random per-boot
`<token>`), which gives every preview real `localhost:<port>` semantics and isolates
previews from each other. On a base domain **dedicated** to Vivari the route is the
plain `*.<domain>/*`. Cloudflare Pages can't attach a *wildcard* custom domain, so a
small **Worker** (`worker/`) serves the SW runtime for every matching subdomain; it
gates on the hostname and passes anything that isn't a `<token>--<port>` host
straight through, so other subdomains you add later keep working.

If the domain **also serves other apps** and you'd rather not point a broad route at
it, set `previewWildcardTag` (e.g. `"vv"`) in `BootOptions`: hosts become
`<token>--<port>-vv.<domain>` and the route narrows to `*-vv.<domain>/*`. The tag has
to be a **suffix** — Cloudflare routes only allow the `*` wildcard at the **start**
of the hostname, so a prefix `vv-*.<domain>/*` is rejected as an infix wildcard.

1. Point a base domain (e.g. `vivari.run`) at Cloudflare (nameservers on
   Cloudflare) and add **one proxied (orange-cloud) wildcard DNS record**: `A * →`
   a placeholder IP like `192.0.2.1` (the Worker responds directly, never forwards).
   Explicit records for your existing subdomains always win over the wildcard
   (RFC 4592), so they're untouched.
2. Build + deploy the Worker (from your machine — or wire up Git deploys, see
   below):
   ```bash
   npm run build:worker    # builds the studio + assembles worker/public/
   npm run deploy:worker   # wrangler deploy (from worker/)
   ```
   `worker/wrangler.toml` ships with the route `*.vivari.run/*` bound — change
   `zone_name`/`pattern` to your own zone. Binding a route on deploy needs an
   API token with **Workers Routes: Edit** on the zone; otherwise comment the
   `[[routes]]` block out and add the route under **Workers → your Worker → Domains &
   Routes**. The Worker only acts on `<token>--<port>` hosts and passes every other
   host through untouched, so the broad route doesn't disturb other subdomains.
3. On the **main** (IDE) project set `VITE_PREVIEW_WILDCARD_DOMAIN=vivari.run`
   and redeploy. Because the preview hosts are subdomains of the IDE's base domain
   they are **same-site**, so "Open in new tab" connects **gate-free**.
4. **Enable Universal SSL** (see the next paragraph) — this is the step people miss.

:::warning Turn on Universal SSL — the easy one to miss
The wildcard preview hosts need a TLS certificate covering `*.<domain>`. Cloudflare's
**Universal SSL is sometimes OFF** for a zone (and per-hostname certs that Pages
creates for your *named* custom domains — e.g. `vivari.<domain>` — mask this, since
they're separate certs). If Universal SSL is off, every preview host fails the TLS
handshake with **`ERR_SSL_VERSION_OR_CIPHER_MISMATCH`** even though the Worker and
route are correct.

Fix: **SSL/TLS → Edge Certificates** → make sure a Universal certificate is **Active**
and lists `*.<domain>` in its Hosts. If it's off, turn it on (or disable + re-enable
to re-provision); issuance is usually minutes. Also check **SSL/TLS → Overview**
isn't set to *Off*.
:::

Free Cloudflare Universal SSL covers the apex + a **single-level** wildcard
(`*.<domain>`), which is exactly what `<token>--<port>.<domain>` needs — no paid
certificate. A nested scheme like `*.preview.<domain>` would be two levels and
require Advanced Certificate Manager.

**All templates work in every mode.** Keep-prefix templates (Docusaurus, VitePress,
React Router 7, TanStack Router) hardcode a `/preview/<port>/` base for modes A/B.
Since mode C serves each port at its own origin root, the studio rewrites those
templates' base to `/` at creation time — so you don't need to change anything per
mode. Cross-service calls (a frontend hitting a backend on another port via
`/preview/<port>/…`) keep working in mode C too.

### Deploy the Worker via Git (Workers Builds)

Instead of running `build:worker` / `deploy:worker` by hand, connect the repo to
**Cloudflare → Workers & Pages → Create → Workers → Connect to Git**. Cloudflare
then runs the build + deploy on every push. Use these settings:

| Field | Value |
| --- | --- |
| Project name | `vivari-preview` *(must match `name` in `worker/wrangler.toml`)* |
| Build command | `npm run build:worker` |
| Deploy command | `cd worker && npx wrangler deploy` |
| Path (root directory) | `/` |
| Non-production branch deploy command | `cd worker && npx wrangler versions upload` |
| API token | needs **Workers Scripts: Edit** (+ **Workers Routes: Edit** to bind the route) |

Why these:

- **Path stays `/` (repo root).** `npm run build:worker` runs
  `scripts/cloudflare-build-worker.sh`, which builds the studio + Wasm crates at the
  repo root and assembles `worker/public/`. Pointing Path at `worker/` would break
  the build (there is no `package.json` there).
- **Deploy does `cd worker`** so `wrangler` finds `worker/wrangler.toml` (whose
  `main`/`[assets] directory` are relative to that file).
- The route in `[[routes]]` is bound automatically on deploy (given the token
  permission above); no separate dashboard step needed.

These are the Worker's build settings. The `VITE_PREVIEW_WILDCARD_DOMAIN` env var is a
**build-time variable of the IDE project** (the studio/Pages project), *not* the
Worker — set it there and redeploy the IDE.

## Local preview

```bash
npm run build:site
npx serve dist   # or any static server that honors _headers
```

Because `_headers` is a Cloudflare Pages convention, a plain static server won't
apply it — use `wrangler pages dev dist` to preview headers locally.