---
sidebar_position: 2
title: Getting started
---

import Playground from '@site/src/components/Playground';

# Getting started

## Install

```bash
npm install @vivari/core
```

For React apps, add the bindings:

```bash
npm install @vivari/react @vivari/core react
```

## Requirement: a cross-origin isolated page

Vivari's synchronous FS/process bridge is built on `SharedArrayBuffer` +
`Atomics.wait()`, which browsers only expose on a **cross-origin isolated** page.
Serve your app (and the preview Service Worker) with these two headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`Vivari.boot()` rejects early with `VivariError("ERR_NOT_ISOLATED")` if the page is
not isolated. You can check yourself with the exported `isCrossOriginIsolated()`.
See [Cross-origin isolation](./cross-origin-isolation) for per-host header recipes.

## Boot, mount, run

```ts
import { Vivari } from "@vivari/core";

const vivari = await Vivari.boot();

await vivari.mount({
  "package.json": {
    file: { contents: JSON.stringify({ name: "app", type: "module" }) },
  },
  "index.js": {
    file: { contents: "console.log('hello from the browser')" },
  },
});

const proc = await vivari.spawn("node", ["index.js"]);
for await (const chunk of proc.output) console.log(chunk);
console.log("exit code:", await proc.exit);
```

`proc.output` is the merged stdout + stderr; `proc.stdout` and `proc.stderr` are
the same chunks split by stream. Each is a `ReadableStream<string>` you can also
`pipeTo()` or drain with `await proc.stderr.text()`.

## Run a dev server and preview it

```ts
const iframe = document.querySelector("iframe")!;

// Routes the dev server's HMR/SSE frames into the frame — without this, Vite HMR
// never gets past "connecting…".
vivari.attachPreview(iframe);

await (await vivari.spawn("npm", ["install"])).exit;
void vivari.spawn("npm", ["run", "dev"]); // long-running; don't await its exit

// Resolves once the port has actually answered a request, so the iframe never
// loads into a server that is still starting up.
const [, url] = await vivari.once("server-ready");
iframe.src = url;
```

:::note `server-ready`, not `port`
A dev server binds, closes and rebinds its port several times while booting. The
`"port"` event reports each of those; `"server-ready"` waits until the port serves
a real request and fires once. Build on `"server-ready"`.
:::

## Handling failures

Every rejection is a `VivariError` with a machine-readable `code`, so you can
branch on the cause instead of matching message text:

```ts
import { Vivari, VivariError } from "@vivari/core";

try {
  const vivari = await Vivari.boot({ timeout: 30_000 });
} catch (err) {
  if (err instanceof VivariError && err.code === "ERR_NOT_ISOLATED") {
    // The most common first-run problem: the page is missing COOP/COEP.
  }
}
```

See [Errors](./core-api#errors) for the full list of codes.

## Interactive example

Edit `index.js` below and press **Run**. This boots a real Node.js runtime in your
browser (inside a cross-origin isolated frame) and streams the actual `stdout`
back. Try importing another `node:` built-in or changing the loop.

<Playground scenario="node" title="Live Node terminal" />

:::tip Run real projects
To scaffold a full project, `npm install`, and boot a dev server, [open the Studio](https://vivari.run/studio/) or
embed the [`<Vivari>` component](./react) on a cross-origin isolated page.
:::

## Next

- [Core API](./core-api): every method and option.
- [Embedding](./embedding): self-hosting the Service Worker and assets.