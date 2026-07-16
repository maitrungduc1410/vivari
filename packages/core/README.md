# @vivari/core

Run **Node.js projects fully client-side in the browser** — a virtual filesystem,
a Node-compatible runtime, a process model, and virtual networking, all in Web
Workers with no server doing the work. This is the framework-agnostic Vivari
WebContainer SDK; see [`@vivari/react`](../react) for React bindings.

```bash
npm install @vivari/core
```

## Requirements

Vivari's synchronous FS/process bridge is built on `SharedArrayBuffer` +
`Atomics.wait()`, which browsers only expose on a **cross-origin isolated** page.
Serve your app (and the preview Service Worker) with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`Vivari.boot()` throws early if the page is not isolated. You can check yourself
with the exported `isCrossOriginIsolated()`.

## Quick start

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

### Run a dev server and preview it

```ts
const iframe = document.querySelector("iframe")!;
vivari.on("server-ready", (port, url) => (iframe.src = url));

await (await vivari.spawn("npm", ["install"])).exit;
await vivari.spawn("npm", ["run", "dev"]); // long-running; don't await exit
```

## API

### `Vivari.boot(options?): Promise<Vivari>`

Boots the kernel + workers + VFS and (unless disabled) registers the preview
Service Worker.

| option             | type                | default        | notes                                                              |
| ------------------ | ------------------- | -------------- | ------------------------------------------------------------------ |
| `compress`         | `boolean`           | `true`         | VFS whole-file compression (~70 % less RAM for a big node_modules) |
| `serviceWorkerUrl` | `string \| false`   | `"/sw.js"`     | where you host the SDK's `sw.js`; `false` disables previews        |
| `workerName`       | `string`            | `"Vivari Kernel"` | DevTools label for the kernel Worker                            |

### `vivari.mount(tree, { mountPoint? })`

Write a declarative `FileSystemTree` (WebContainer-compatible shape) into the VFS.

### `vivari.spawn(command, args?, { cwd?, env? }): Promise<VivariProcess>`

Run a command. Package managers (`npm`/`yarn`/`pnpm`/`corepack`) work out of the
box with persisted, content-addressed caches. A `VivariProcess` has:

- `output: ReadableStream<string>` — merged stdout + stderr (ANSI intact)
- `input: WritableStream<string>` — stdin (close the stream to send EOF)
- `exit: Promise<number>` — the exit code
- `kill(): void`

### `vivari.fs`

An async `fs/promises`-style facade: `readFile(path, "utf-8")` / `readFile(path)`
(bytes), `writeFile`, `readdir(path, { withFileTypes? })`, `mkdir`, `rm`,
`rename`, `exists`, `stat`.

### `vivari.on(event, listener): () => void`

- `"server-ready"` → `(port, url)` — a server started listening; `url` is its preview URL
- `"port"` → `(port, "open" | "close", url)`
- `"error"` → `({ message })`

### `vivari.previewUrl(port)` · `vivari.teardown()`

Build the same-origin preview URL for a port, and free the workers/VFS.

## Bundlers & self-hosting assets

The heavy machinery (kernel worker, its nested fs/fetcher/process workers, and the
Rust/Wasm VFS + codec + crypto artifacts) is reached via
`new Worker(new URL(..., import.meta.url))` and `new URL('*.wasm', import.meta.url)`.
The published `dist/` is self-contained: modern bundlers (Vite, webpack 5, Rollup,
esbuild) resolve those relative to the installed package and emit them same-origin.

Two assets must be served **same-origin** (COEP forbids cross-origin loads):

1. **The preview Service Worker.** Copy `@vivari/core/dist/assets/sw.js` to your
   served root as `/sw.js` (or point `serviceWorkerUrl` at your chosen path). It
   must be served with `Service-Worker-Allowed: /`.
2. **Package-manager tarballs** (only if you use `npm`/`yarn`/`pnpm` in-VM). Vivari
   fetches vendored PM deliveries from `/vendor/...` on your origin; host that
   directory too, or skip installs.

## Advanced: `KernelBridge`

`Vivari` is a thin facade over `KernelBridge`, the raw pub/sub transport to the
kernel worker (`on`/`onAny`/`post`/`request`, SW registration, keep-prefix ports).
Use it directly if you need the full message vocabulary (this is what the Vivari
studio IDE is built on).

## License

MIT © Duc Trung Mai
