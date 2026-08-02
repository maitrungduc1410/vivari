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

`Vivari.boot()` rejects early (with code `ERR_NOT_ISOLATED`) if the page is not
isolated. You can check yourself with the exported `isCrossOriginIsolated()`.

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
for await (const chunk of proc.output) console.log(chunk);
console.log("exit code:", await proc.exit);
```

### Run a dev server and preview it

```ts
const iframe = document.querySelector("iframe")!;

// Routes the dev server's HMR/SSE frames into the frame — without this, Vite HMR
// never gets past "connecting…".
vivari.attachPreview(iframe);

await (await vivari.spawn("npm", ["install"])).exit;
void vivari.spawn("npm", ["run", "dev"]); // long-running; don't await exit

// Resolves only once the server has actually answered a request, so the iframe
// never loads into a port that is still rebinding.
const [, url] = await vivari.once("server-ready");
iframe.src = url;
```

## API

### `Vivari.boot(options?): Promise<Vivari>`

Boots the kernel + workers + VFS and (unless disabled) registers the preview
Service Worker.

| option             | type                | default           | notes                                                              |
| ------------------ | ------------------- | ----------------- | ------------------------------------------------------------------ |
| `compress`         | `boolean`           | `true`            | VFS whole-file compression (~70 % less RAM for a big node_modules) |
| `serviceWorkerUrl` | `string \| false`   | `"/sw.js"`        | where you host the SDK's `sw.js`; `false` disables previews        |
| `workerName`       | `string`            | `"Vivari Kernel"` | DevTools label for the kernel Worker                               |
| `devtools`         | `boolean`           | `false`           | inject Vivari's in-preview DevTools backend (see below)            |
| `timeout`          | `number`            | `60000`           | reject with `ERR_BOOT_TIMEOUT` if the kernel never reports ready   |
| `signal`           | `AbortSignal`       | —                 | cancel the boot; rejects with `ERR_ABORTED`                        |

Plus the preview-isolation options `previewOrigin`, `previewWildcardDomain`,
`previewWildcardTag` and `previewPopout` — see the JSDoc on `BootOptions`.

`boot()` always settles. It rejects with a `VivariError` if the page isn't
isolated, the kernel worker fails to load, the kernel reports a boot failure, the
timeout expires, or the signal aborts — and tears down the half-built instance on
the way out.

> **Preview DevTools.** By default the SDK does **not** inject Vivari's in-preview
> DevTools backend into your preview pages. That backend needs a same-origin
> `/vv-devtools/chobitsu.js`, so enabling it without hosting that file would make
> every preview 404 on it. Pass `devtools: true` **and** serve `chobitsu.js` from
> your origin to turn it on.

### `vivari.mount(tree, { mountPoint?, signal? })`

Write a declarative `FileSystemTree` (WebContainer-compatible shape) into the VFS.
The whole tree goes over in one batched round-trip.

### `vivari.export(path?, { exclude?, signal? })`

Read a directory tree back out — a project snapshot for download, a share link, or
a hand-off to another instance. Returns `{ files: { path, contents }[], truncated }`
with paths relative to `path` (default `"/"`). `node_modules` and `.git` are always
skipped; `exclude` adds more directory names. `truncated` is `true` if the walk hit
the kernel's file-count / byte cap.

### `vivari.spawn(command, args?, { cwd?, env?, signal? }): Promise<VivariProcess>`

Run a command. Package managers (`npm`/`yarn`/`pnpm`/`corepack`) work out of the
box with persisted, content-addressed caches. Rejects with `ERR_COMMAND_NOT_FOUND`
if the command can't be launched, instead of handing back a process that silently
exits 127 with no output. A `VivariProcess` has:

- `output: OutputStream` — merged stdout + stderr, interleaved (ANSI intact)
- `stdout: OutputStream` / `stderr: OutputStream` — the same chunks, split by stream
- `input: WritableStream<string>` — stdin (close the stream to send EOF)
- `exit: Promise<number>` — the exit code (`-1` if the instance was torn down first)
- `exitCode: number | null` — synchronous; `null` while still running
- `pid: number` — the in-VM process id
- `kill(): void`

An `OutputStream` is a `ReadableStream<string>` plus `[Symbol.asyncIterator]` and
`text()`, so all three of these work:

```ts
for await (const chunk of proc.output) term.write(chunk);
const errors = await proc.stderr.text();
await proc.output.pipeTo(someWritable);
```

Reading `stdout` does not consume `output` — they are separate views of the same
chunks, not copies.

### `vivari.fs`

An async `fs/promises`-style facade. Every method takes an optional trailing
options object with a `signal`.

| method | notes |
| ------ | ----- |
| `readFile(path)` / `readFile(path, "utf-8")` | bytes, or a string with an encoding (`"utf8"` also accepted) |
| `writeFile(path, contents)` | parent directories are created as needed |
| `readdir(path, { withFileTypes? })` | names, or `DirEnt`s |
| `mkdir(path, { recursive? })` | `recursive` defaults to `true` (`mkdir -p`); `false` gives POSIX semantics — `ENOENT` on a missing parent, `EEXIST` if it already exists |
| `rm(path, { recursive?, force? })` | both default to `true`; `recursive: false` gives `ENOTEMPTY` on a non-empty directory, `force: false` gives `ENOENT` on a missing path |
| `rename(from, to)` | |
| `exists(path)` | never throws for a missing path |
| `stat(path)` | `{ size, mtimeMs, mode, ino, isFile(), isDirectory() }`; throws `ENOENT` if missing |
| `watch(path, options?, listener?)` | see below |

```ts
// Both forms work; close the watcher (or abort its signal) when you're done.
const watcher = vivari.fs.watch("/src", (event) => render(event.path));
for await (const event of vivari.fs.watch("/src")) console.log(event.kind, event.path);
watcher.close();
```

`watch` reports the exact path that changed with no coalescing — an `npm install`
fires thousands of events, so debounce before touching the DOM. `event.kind` is
`"rename"` (an entry appeared, disappeared or moved) or `"change"` (contents
edited in place), matching Node's `fs.watch` vocabulary.

### Errors

Everything the SDK throws is a `VivariError` with a machine-readable `code`, so you
never have to match on message text:

```ts
import { VivariError } from "@vivari/core";

try {
  await vivari.fs.readFile("/missing.txt", "utf-8");
} catch (err) {
  if (err instanceof VivariError && err.code === "ENOENT") { /* … */ }
}
```

Filesystem failures are `VivariFsError` (a `VivariError` that also carries `path`
and `syscall`) and use the errno spellings Node uses — `ENOENT`, `EEXIST`,
`ENOTDIR`, `EISDIR`, `ENOTEMPTY`, `ELOOP`, `EINVAL`, `EBADF`, `EIO` — forwarded
from the VFS that raised them. Everything else uses an `ERR_`-prefixed code:
`ERR_NOT_ISOLATED`, `ERR_BOOT_FAILED`, `ERR_BOOT_TIMEOUT`, `ERR_WORKER`,
`ERR_NOT_READY`, `ERR_COMMAND_NOT_FOUND`, `ERR_ABORTED`, `ERR_TIMEOUT`,
`ERR_TORN_DOWN`, `ERR_UNKNOWN`. The exported `VivariErrorCode` union is exhaustive,
so a `switch` over `err.code` type-checks with no `default`.

### Events

```ts
const off = vivari.on("server-ready", (port, url) => (iframe.src = url));
off();                                            // or vivari.off("server-ready", fn)
vivari.on("fs-change", onChange, { signal });      // unsubscribe when signal aborts
const [port, url] = await vivari.once("server-ready");
```

| event          | listener args                                | fires when |
| -------------- | -------------------------------------------- | ---------- |
| `server-ready` | `(port, url)`                                | a server is listening **and has answered a request** — safe to point an iframe at |
| `port`         | `(port, "open" \| "close", url)`             | the raw bind/unbind, with no serving check |
| `fs-change`    | `({ kind, path })`                           | something under the VFS changed |
| `error`        | `(error: VivariError)`                       | an unrecoverable kernel error |

A dev server binds, closes and rebinds its port several times while starting, so
`port` fires repeatedly with `"open"` before the app is loadable. `server-ready` is
the one to build on.

### `vivari.previewUrl(port, pathAndQuery?)` · `vivari.attachPreview(iframe)`

Build the preview URL for an in-VM port (correct in all three preview-isolation
modes), and route HMR/SSE frames into a preview iframe. `attachPreview` returns a
detach function.

### `vivari.teardown()` · `vivari.destroyed`

Free the workers/VFS. Idempotent, and everything in flight settles rather than
hanging: pending `fs` calls reject with `ERR_TORN_DOWN`, running processes close
their output streams and resolve `exit` with `-1`, watchers close, and every
listener the SDK attached to `window` / `navigator.serviceWorker` is detached.

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

## Advanced: `vivari.internal`

`Vivari` is a thin facade over `KernelBridge`, the raw pub/sub transport to the
kernel worker (`on`/`onAny`/`post`/`request`, SW registration, keep-prefix ports).
It is reachable as `vivari.internal` — this is what the Vivari studio IDE is built
on.

**It is not covered by semver.** The kernel message vocabulary (`vv-mkdirp`,
`proc-out`, …) changes with the runtime and nothing there is typed beyond
`KernelMessage`. Reach in only for something the facade can't express yet, and
expect to fix up call sites on any release. If you find yourself needing it for
something ordinary, that's a gap in the public API — please open an issue.

## Stability

Pre-1.0 (`0.x`): the surface above is still moving and minor versions may break.
See the repository README for the road to a 1.0 freeze.

## License

MIT © Duc Trung Mai