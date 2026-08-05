---
sidebar_position: 8
title: Cross-origin isolation
---

# Cross-origin isolation

Vivari needs `SharedArrayBuffer`, which browsers only expose on a **cross-origin
isolated** page. That means serving your HTML documents (and the `sw.js` script)
with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Under `require-corp`, every **cross-origin** subresource must opt in with
`Cross-Origin-Resource-Policy` (or CORS). Same-origin subresources are fine,
which is why Vivari self-hosts all of its workers and Wasm.

**Iframes are the exception to "same-origin is fine".** A nested *document* does
not inherit its embedder's policy: it must send `require-corp` (or
`credentialless`) on its own response, even when it is same-origin. Miss it and
the browser blocks the frame and renders its "*&lt;host&gt; refused to connect*" error
page — the same page you get from `X-Frame-Options`, which sends you looking for a
CSP that isn't there. So if you scope the headers by path, make sure every
document you iframe is inside the scoped paths.

Check at runtime:

```ts
import { isCrossOriginIsolated } from "@vivari/core";
console.log(isCrossOriginIsolated()); // must be true before Vivari.boot()
```

You don't have to check first: `Vivari.boot()` performs the same test and rejects
with `VivariError("ERR_NOT_ISOLATED")` before starting any workers. Calling
`isCrossOriginIsolated()` yourself is useful when you want to render a
"headers missing" state without attempting a boot at all.

## Header recipes

### Vite (dev + preview)

```ts
import { defineConfig } from "vite";
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};
export default defineConfig({
  server: { headers: isolation },
  preview: { headers: isolation },
});
```

### Cloudflare Pages (`_headers`)

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

### Netlify (`_headers`) / Nginx / Express

```
# Netlify _headers
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

```nginx
# Nginx
add_header Cross-Origin-Opener-Policy same-origin;
add_header Cross-Origin-Embedder-Policy require-corp;
```

```ts
// Express
app.use((_req, res, next) => {
  res.set("Cross-Origin-Opener-Policy", "same-origin");
  res.set("Cross-Origin-Embedder-Policy", "require-corp");
  next();
});
```

:::caution Scope it deliberately
Cross-origin isolation is contagious: a page is only isolated if its top-level
document sends the headers. If you host a marketing page and an embed on the same
origin, you can scope the headers to just the embed's path so the rest of the
site stays free of CORP constraints. That's exactly what this project does; see
[Deployment](./deployment).
:::