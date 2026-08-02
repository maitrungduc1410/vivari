---
sidebar_position: 3
title: Core API
---

# `@vivari/core`

The framework-agnostic SDK. Everything below hangs off a booted `Vivari`
instance.

:::caution Upgrading from an earlier `0.0.x`
Vivari is pre-1.0 and the API was recently hardened. If you wrote against an
earlier `0.0.x`, several things moved:

| Before | Now |
| --- | --- |
| `import { previewUrl } from "@vivari/core"` | `vivari.previewUrl(port, pathAndQuery?)` — the module-level helper is gone; it couldn't know your preview mode |
| `vivari.bridge` | [`vivari.internal`](#advanced-vivariinternal), and explicitly outside semver |
| `catch (e) { if (e.message.includes("ENOENT")) }` | `catch (e) { if (e instanceof VivariError && e.code === "ENOENT") }` |
| `const s = await fs.stat(p); if (s.exists)` | `await fs.exists(p)` — `stat()` now throws `ENOENT` and has no `exists` field |
| `new VivariProcess(...)` | not constructible; `VivariProcess` and `FileSystemAPI` are type-only exports |
| `VivariEventMap` mapping events to listener *functions* | events map to listener *argument tuples* |

Also worth knowing: `server-ready` now fires **once**, after the port really
answers; `fs.writeFile()` now rejects on failure instead of always resolving; and
`fs.mkdir` / `fs.rm` now honour their options instead of ignoring them.
:::

## `Vivari.boot(options?): Promise<Vivari>`

Boots the kernel + workers + VFS and (unless disabled) registers the preview
Service Worker.

| option | type | default | notes |
| --- | --- | --- | --- |
| `compress` | `boolean` | `true` | VFS whole-file compression (~70% less RAM for a big `node_modules`) |
| `serviceWorkerUrl` | `string \| false` | `"/sw.js"` | where you host the SDK's `sw.js`; `false` disables previews |
| `workerName` | `string` | `"Vivari Kernel"` | DevTools label for the kernel Worker |
| `devtools` | `boolean` | `false` | inject Vivari's in-preview DevTools backend |
| `timeout` | `number` | `60000` | reject with `ERR_BOOT_TIMEOUT` if the kernel never reports ready |
| `signal` | `AbortSignal` | — | cancel the boot; rejects with `ERR_ABORTED` |
| `previewOrigin` | `string` | — | serve previews from a separate origin (mode B) |
| `previewWildcardDomain` | `string` | — | serve each in-VM port from its own origin, `<token>--<port>.<domain>` (mode C) |
| `previewWildcardTag` | `string` | — | hostname suffix for mode C when the domain also serves other apps |
| `previewPopout` | `"same-origin" \| "isolated"` | `"same-origin"` | where "Open in new tab" lands, in mode B |

`boot()` always settles. It **rejects** with a [`VivariError`](#errors) if the page
isn't cross-origin isolated (`ERR_NOT_ISOLATED`), the kernel worker fails to load
(`ERR_WORKER`), the kernel reports a boot failure (`ERR_BOOT_FAILED`), the timeout
expires (`ERR_BOOT_TIMEOUT`), or the signal aborts (`ERR_ABORTED`) — and tears down
the half-built instance on the way out.

```ts
const controller = new AbortController();
const vivari = await Vivari.boot({ timeout: 30_000, signal: controller.signal });
```

The `preview*` options control how far previews are isolated from your page. The
default (mode A) runs them same-origin with no extra infrastructure; modes B and C
move previews onto their own origin and need assets hosted there. See
[Deployment](./deployment#preview-isolation-modes-optional) for the comparison and
what each mode requires you to host.

:::note Preview DevTools
By default the SDK does **not** inject Vivari's in-preview DevTools backend. That
backend needs a same-origin `/vv-devtools/chobitsu.js`, so enabling it without
hosting that file would make every preview 404. Pass `devtools: true` **and**
serve `chobitsu.js` from your origin to turn it on.
:::

## `vivari.mount(tree, { mountPoint?, signal? })`

Write a declarative `FileSystemTree` (WebContainer-compatible shape) into the VFS.
The whole tree goes over in one batched round-trip, so it applies atomically
rather than leaving a half-written project behind on failure.

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

## `vivari.export(path?, { exclude?, signal? })`

Read a directory tree back out — a project snapshot for download, a share link, or
a hand-off to another instance. Paths are relative to `path` (default `"/"`).
`node_modules` and `.git` are always skipped; `exclude` adds more directory names.

```ts
const { files, truncated } = await vivari.export("/app", { exclude: ["dist"] });
for (const f of files) console.log(f.path, f.contents.byteLength);
```

`truncated` is `true` if the walk hit the kernel's file-count / total-byte cap, in
which case `files` is a prefix of the tree rather than all of it.

## `vivari.spawn(command, args?, { cwd?, env?, signal? }): Promise<VivariProcess>`

Run a command. Package managers (`npm` / `yarn` / `pnpm` / `corepack`) work out
of the box with persisted, content-addressed caches. Rejects with
`ERR_COMMAND_NOT_FOUND` if the command can't be launched, instead of handing back a
process that silently exits 127 with no output. A `VivariProcess` has:

- `output: OutputStream`, the merged stdout + stderr, interleaved (ANSI intact)
- `stdout: OutputStream` · `stderr: OutputStream`, the same chunks split by stream
- `input: WritableStream<string>`, stdin (close the stream to send EOF)
- `exit: Promise<number>`, the exit code (`-1` if the instance was torn down first)
- `exitCode: number | null`, synchronous; `null` while still running
- `pid: number`, the in-VM process id
- `kill(): void`

An `OutputStream` is a `ReadableStream<string>` plus `[Symbol.asyncIterator]` and
`text()`, so all three of these work:

```ts
const proc = await vivari.spawn("node", ["-e", "console.log(2 + 2)"]);

for await (const chunk of proc.output) console.log(chunk);
// …or: const errors = await proc.stderr.text();
// …or: await proc.output.pipeTo(someWritable);

console.log("exit code:", await proc.exit);
```

Reading `stdout` does not consume `output` — they are separate views of the same
chunks, not copies.

## `vivari.fs`

An async `fs/promises`-style facade for reaching the VM's filesystem **from your
page**. Every method takes an optional trailing options object carrying an
`AbortSignal`.

:::note Two filesystem APIs, one filesystem
`vivari.fs` is the host-side control plane — the subset your page needs to put a
project in and read results back out. Code running *inside* the VM uses Node's own
`fs` / `fs/promises` via `require("fs")`, which is a much larger surface (globs,
`cp`, recursive watch, …) provided by the in-VM runtime.

Both act on the same VFS, so a file written with `vivari.fs.writeFile()` is
immediately visible to `readFileSync()` in a spawned process. But they are
different APIs: don't expect the table below to track Node's `fs`.
:::

| method | notes |
| --- | --- |
| `readFile(path)` · `readFile(path, "utf-8")` | bytes, or a string with an encoding |
| `writeFile(path, data)` | parents are created as needed; **rejects** if the write fails |
| `readdir(path, { withFileTypes? })` | names, or `DirEnt`s |
| `mkdir(path, { recursive? })` | `recursive` defaults to `true` (`mkdir -p`); `false` gives POSIX semantics — `ENOENT` on a missing parent, `EEXIST` if it exists |
| `rm(path, { recursive?, force? })` | both default to `true` (`rm -rf`); `recursive: false` gives `ENOTEMPTY` on a non-empty directory, `force: false` gives `ENOENT` on a missing path |
| `rename(from, to)` | |
| `exists(path)` | `boolean`; never throws for a missing path |
| `stat(path)` | `{ size, mtimeMs, mode, ino, isFile(), isDirectory() }`; **throws `ENOENT`** if missing |
| `watch(path, options?, listener?)` | see below |

```ts
await vivari.fs.writeFile("/tmp/hello.txt", "hi");
console.log(await vivari.fs.readFile("/tmp/hello.txt", "utf-8"));

const { size, mtimeMs } = await vivari.fs.stat("/tmp/hello.txt");
```

### `fs.watch(path, options?, listener?): FSWatcher`

The returned handle is both a callback subscription and an async iterable. Close
it (or abort its `signal`) when you're done.

```ts
const watcher = vivari.fs.watch("/src", (event) => render(event.path));
watcher.close();

for await (const event of vivari.fs.watch("/src", { recursive: true })) {
  console.log(event.kind, event.path);
}
```

`event.kind` follows Node's `fs.watch` vocabulary: `"rename"` when an entry
appears, disappears or moves, `"change"` when contents are edited in place.

:::caution Debounce
The kernel reports the exact path that changed with no coalescing, so a single
`npm install` fires thousands of events. Debounce before touching the DOM.
:::

## Errors

Everything the SDK throws is a `VivariError` carrying a machine-readable `code`,
so you never have to match on message text:

```ts
import { VivariError } from "@vivari/core";

try {
  await vivari.fs.readFile("/missing.txt", "utf-8");
} catch (err) {
  if (err instanceof VivariError && err.code === "ENOENT") {
    // …
  }
}
```

Filesystem failures are `VivariFsError` — a `VivariError` that also carries `path`
and `syscall` — and use the errno spellings Node uses, forwarded from the VFS that
raised them: `ENOENT`, `EEXIST`, `ENOTDIR`, `EISDIR`, `ENOTEMPTY`, `ELOOP`,
`EINVAL`, `EBADF`, `EIO`.

Everything that isn't a syscall gets an `ERR_`-prefixed code: `ERR_NOT_ISOLATED`,
`ERR_BOOT_FAILED`, `ERR_BOOT_TIMEOUT`, `ERR_WORKER`, `ERR_NOT_READY`,
`ERR_COMMAND_NOT_FOUND`, `ERR_ABORTED`, `ERR_TIMEOUT`, `ERR_TORN_DOWN`,
`ERR_UNKNOWN`.

The exported `VivariErrorCode` union is exhaustive, so a `switch` over `err.code`
type-checks with no `default`. `VivariFsErrorCode` and `VivariRuntimeErrorCode` are
exported too if you want the halves separately.

## `vivari.on(event, listener, options?)`

Returns an unsubscribe function. `off(event, listener)` and `once(event, options?)`
are also available, and both `on` and `once` accept an `AbortSignal`.

| event | listener args | when |
| --- | --- | --- |
| `"server-ready"` | `(port, url)` | a server is listening **and has answered a request** — safe to point an iframe at |
| `"port"` | `(port, "open" \| "close", url)` | the raw bind/unbind, with no serving check |
| `"fs-change"` | `({ kind, path })` | something under the VFS changed |
| `"error"` | `(error: VivariError)` | an unrecoverable kernel error |

```ts
const off = vivari.on("server-ready", (port, url) => console.log(port, url));
off();

vivari.on("fs-change", onChange, { signal: controller.signal });

const [port, url] = await vivari.once("server-ready");
```

:::note Which port event to use
A dev server binds, closes and rebinds its port several times while starting, so
`"port"` fires repeatedly with `"open"` before the app is actually loadable.
`"server-ready"` waits until the port answers a real request and fires once.
Build on it unless you specifically want the raw bind.
:::

## Previews

`vivari.previewUrl(port, pathAndQuery?)` builds the preview URL for an in-VM port,
correctly in all three preview modes. `pathAndQuery` addresses a path inside that
server and defaults to `/`.

`vivari.attachPreview(iframe)` routes the dev server's HMR / SSE frames into a
preview `<iframe>` and returns a detach function. Without it, Vite HMR never gets
past "connecting…".

```ts
const detach = vivari.attachPreview(iframe);
iframe.src = vivari.previewUrl(5173);
// later: detach();
```

## `vivari.teardown()` · `vivari.destroyed`

Free the workers and VFS. Idempotent, and everything in flight settles rather than
hanging: pending `fs` calls reject with `ERR_TORN_DOWN`, running processes close
their output streams and resolve `exit` with `-1`, watchers close, and every
listener the SDK attached to `window` / `navigator.serviceWorker` is detached.
`vivari.destroyed` tells you whether that has happened.

## Advanced: `vivari.internal`

`Vivari` is a thin facade over `KernelBridge`, the raw pub/sub transport to the
kernel worker (`on` / `onAny` / `post` / `request`, SW registration, keep-prefix
ports). It's reachable as `vivari.internal`, and it's what the
[Studio](https://vivari.run/studio/) is built on.

:::danger Not covered by semver
The kernel message vocabulary (`vv-mkdirp`, `proc-out`, …) changes with the runtime
and nothing there is typed beyond `KernelMessage`. Reach in only for something the
facade can't express yet, and expect to fix up call sites on any release. If you
need it for something ordinary, that's a gap in the public API — please
[open an issue](https://github.com/maitrungduc1410/vivari/issues).
:::