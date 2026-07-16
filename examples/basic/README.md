# `@vivari/core` — basic example

A minimal [Vite](https://vite.dev) app that boots a browser-native Node.js VM with
[`@vivari/core`](../../packages/core), runs a script, and previews an in-VM HTTP
server in an `<iframe>`.

It demonstrates the whole SDK loop:

1. `Vivari.boot()` — spin up the kernel + workers + Wasm VFS
2. `vivari.mount(tree)` — write a declarative file tree into the VM
3. `vivari.spawn("node", ["hello.js"])` — run a command and stream its stdout
4. `vivari.on("server-ready", …)` — preview an in-VM server by port

## Run it

From the repo root (the example consumes `@vivari/core` from source, so no build
step is required):

```bash
npm install
npm --prefix examples/basic run dev
```

Then open the printed URL. To try the production build + static preview:

```bash
npm --prefix examples/basic run build
npm --prefix examples/basic run preview
```

## What to copy into your own app

- **Cross-origin isolation is mandatory.** Serve every page with
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` (see [`vite.config.ts`](./vite.config.ts)).
  Without them `SharedArrayBuffer` is unavailable and `Vivari.boot()` throws.
- **Host the Service Worker same-origin.** Copy
  `node_modules/@vivari/core/dist/assets/sw.js` to your origin root (`/sw.js`) with
  `Service-Worker-Allowed: /`, or pass `serviceWorkerUrl` to `Vivari.boot()`. This
  example serves it from the package via a small dev plugin.
- The in-preview **DevTools backend is off by default** for embedders. Pass
  `Vivari.boot({ devtools: true })` only if you also host `/vv-devtools/chobitsu.js`.

For a React drop-in embed, see [`@vivari/react`](../../packages/react).
