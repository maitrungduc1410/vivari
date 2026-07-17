---
sidebar_position: 5
title: Embedding & self-hosting
---

# Embedding & self-hosting assets

The heavy machinery (the kernel worker, its nested fs/fetcher/process workers, and
the Rust/Wasm VFS + codec + crypto artifacts) is reached via
`new Worker(new URL(..., import.meta.url))` and `new URL('*.wasm',
import.meta.url)`. The published `dist/` is self-contained: modern bundlers
(Vite, webpack 5, Rollup, esbuild) resolve those relative to the installed
package and emit them same-origin.

Because the page is under `Cross-Origin-Embedder-Policy: require-corp`, **every**
asset must load same-origin (or send CORP/CORS). Two assets you must host
yourself:

## 1. The preview Service Worker

Copy `@vivari/core/dist/assets/sw.js` to your served root as `/sw.js` (or point
`serviceWorkerUrl` at your chosen path). It must be served with
`Service-Worker-Allowed: /` so it can claim the `/preview/<port>/` proxy prefix
for the whole origin.

```ts
import { Vivari } from "@vivari/core";

const vivari = await Vivari.boot({
  serviceWorkerUrl: "/sw.js", // wherever you host it
});
```

## 2. Package-manager tarballs (optional)

Only if you run `npm` / `yarn` / `pnpm` in-VM. Vivari fetches vendored PM
deliveries from `/vendor/...` on your origin; host that directory too, or skip
installs.

## Headers

Every HTML document that boots Vivari — and the `sw.js` script — needs:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

See [Cross-origin isolation](./cross-origin-isolation) for host-specific recipes,
and [Deployment](./deployment) for the Cloudflare Pages `_headers` file this site
uses.

## A minimal Vite embedder

```ts
// vite.config.ts
import { defineConfig } from "vite";

const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: "es" },
});
```

Then copy `node_modules/@vivari/core/dist/assets/sw.js` into your `public/` as
`sw.js`, and you're ready to `Vivari.boot()`.
