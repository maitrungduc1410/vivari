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

`Vivari.boot()` throws early if the page is not isolated. You can check yourself
with the exported `isCrossOriginIsolated()`. See
[Cross-origin isolation](./cross-origin-isolation) for per-host header recipes.

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
proc.output.pipeTo(new WritableStream({ write: (c) => console.log(c) }));
console.log("exit code:", await proc.exit);
```

## Run a dev server and preview it

```ts
const iframe = document.querySelector("iframe")!;
vivari.on("server-ready", (port, url) => (iframe.src = url));

await (await vivari.spawn("npm", ["install"])).exit;
await vivari.spawn("npm", ["run", "dev"]); // long-running; don't await exit
```

## Interactive example

Edit `index.js` below and press **Run**. This boots a real Node.js runtime in your
browser (inside a cross-origin isolated frame) and streams the actual `stdout`
back — try importing another `node:` built-in or changing the loop.

<Playground scenario="node" />

:::tip Run real projects
To scaffold a full project, `npm install`, and boot a dev server, [open the Studio](https://vivari.pages.dev/studio/) or
embed the [`<Vivari>` component](./react) on a cross-origin isolated page.
:::

## Next

- [Core API](./core-api) — every method and option.
- [Embedding](./embedding) — self-hosting the Service Worker and assets.
