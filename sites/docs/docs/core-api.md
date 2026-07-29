---
sidebar_position: 3
title: Core API
---

# `@vivari/core`

The framework-agnostic SDK. Everything below hangs off a booted `Vivari`
instance.

## `Vivari.boot(options?): Promise<Vivari>`

Boots the kernel + workers + VFS and (unless disabled) registers the preview
Service Worker. Throws if the page is not cross-origin isolated.

| option | type | default | notes |
| --- | --- | --- | --- |
| `compress` | `boolean` | `true` | VFS whole-file compression (~70% less RAM for a big `node_modules`) |
| `serviceWorkerUrl` | `string \| false` | `"/sw.js"` | where you host the SDK's `sw.js`; `false` disables previews |
| `workerName` | `string` | `"Vivari Kernel"` | DevTools label for the kernel Worker |
| `devtools` | `boolean` | `false` | inject Vivari's in-preview DevTools backend |

:::note Preview DevTools
By default the SDK does **not** inject Vivari's in-preview DevTools backend. That
backend needs a same-origin `/vv-devtools/chobitsu.js`, so enabling it without
hosting that file would make every preview 404. Pass `devtools: true` **and**
serve `chobitsu.js` from your origin to turn it on.
:::

## `vivari.mount(tree, { mountPoint? })`

Write a declarative `FileSystemTree` (WebContainer-compatible shape) into the VFS.

```ts
await vivari.mount({
  src: {
    directory: {
      "index.js": { file: { contents: "export const x = 1" } },
    },
  },
  "package.json": { file: { contents: '{ "type": "module" }' } },
});
```

## `vivari.spawn(command, args?, { cwd?, env? }): Promise<VivariProcess>`

Run a command. Package managers (`npm` / `yarn` / `pnpm` / `corepack`) work out
of the box with persisted, content-addressed caches. A `VivariProcess` has:

- `output: ReadableStream<string>`, the merged stdout + stderr (ANSI intact)
- `input: WritableStream<string>`, stdin (close the stream to send EOF)
- `exit: Promise<number>`, the exit code
- `kill(): void`

```ts
const proc = await vivari.spawn("node", ["-e", "console.log(2 + 2)"]);
await proc.output.pipeTo(new WritableStream({ write: (c) => console.log(c) }));
await proc.exit;
```

## `vivari.fs`

An async `fs/promises`-style facade:

- `readFile(path, "utf-8")` / `readFile(path)` (bytes)
- `writeFile(path, data)`
- `readdir(path, { withFileTypes? })`
- `mkdir(path)` · `rm(path)` · `rename(from, to)`
- `exists(path)` · `stat(path)`

```ts
await vivari.fs.writeFile("/tmp/hello.txt", "hi");
console.log(await vivari.fs.readFile("/tmp/hello.txt", "utf-8"));
```

## `vivari.on(event, listener): () => void`

| event | payload | when |
| --- | --- | --- |
| `"server-ready"` | `(port, url)` | a server started listening; `url` is its preview URL |
| `"port"` | `(port, "open" \| "close", url)` | a port opened or closed |
| `"error"` | `({ message })` | a kernel error |

Returns an unsubscribe function.

## `vivari.previewUrl(port)` · `vivari.teardown()`

Build the same-origin preview URL for a port, and free the workers/VFS.

## Advanced: `KernelBridge`

`Vivari` is a thin facade over `KernelBridge`, the raw pub/sub transport to the
kernel worker (`on` / `onAny` / `post` / `request`, SW registration, keep-prefix
ports). Use it directly if you need the full message vocabulary; it's what the
[Studio](https://vivari.run/studio/) is built on.