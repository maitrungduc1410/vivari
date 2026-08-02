---
sidebar_position: 4
title: React
---

import Playground from '@site/src/components/Playground';

# `@vivari/react`

React bindings for Vivari. Like all of Vivari, this needs a **cross-origin
isolated** page (see [Cross-origin isolation](./cross-origin-isolation)).

```bash
npm install @vivari/react @vivari/core react
```

`@vivari/core` is a **peer** dependency, not a bundled one: two copies of the
kernel in one page means two `SharedArrayBuffer` worlds and a preview Service
Worker registered twice. Install it yourself so there is exactly one.

:::note
Every module in this package carries `"use client"`. In the Next.js App Router
you can import it from a Server Component without the build failing, but the
kernel only ever runs in the browser — there is no server-side rendering of a
VM. On the server, `useVivari()` reports `status: "idle"` and renders nothing.
:::

## `<Vivari>` component

Boots an instance, mounts `files`, runs `install` then `run`, and renders the
resulting dev-server preview in an `<iframe>`.

```tsx
import { Vivari } from "@vivari/react";

const files = {
  "package.json": {
    file: { contents: JSON.stringify({ name: "app", scripts: { dev: "vite" } }) },
  },
  "index.html": { file: { contents: "<h1>Hello from Vivari</h1>" } },
};

export function Playground() {
  return (
    <Vivari
      files={files}
      run="npm run dev"
      onServerReady={(port, url) => console.log("ready", port, url)}
      onOutput={(chunk) => console.log(chunk)}
      onError={({ phase, error }) => console.error(phase, error)}
      style={{ width: "100%", height: 480, border: 0 }}
      fallback={<p>Booting Vivari…</p>}
    />
  );
}
```

### Props

| prop | type | default |
| --- | --- | --- |
| `boot` | `BootOptions` | – |
| `files` | `FileSystemTree` | – |
| `install` | `string \| string[] \| false` | `["npm", "install"]` |
| `run` | `string \| string[]` | – |
| `instanceKey` | `string` | enclosing provider's, else `"default"` |
| `autoBoot` | `boolean` | `true` |
| `onReady` | `(vivari: VivariInstance) => void` | – |
| `onServerReady` | `(port, url) => void` | – |
| `onOutput` | `(chunk) => void` | – |
| `onError` | `(failure: VivariFailure) => void` | – |
| `showPreview` | `boolean` | `true` |
| `previewPort` | `number` | first server that serves |
| `previewPath` | `string` | `"/"` |
| `fallback` | `ReactNode` | `null` |
| `renderError` | `(failure: VivariFailure) => ReactNode` | built-in notice |
| `children` | `ReactNode \| (state) => ReactNode` | – |

Boot options go in the `boot` prop. Every other unrecognised prop is a real
iframe attribute (`className`, `style`, `title`, `allow`, `sandbox`, `loading`,
…) and reaches the frame, and `ref` forwards to the `<iframe>` element.

### Errors

`fallback` is the **pending** slot only — booting, installing, waiting for a
server. Failures do not go through it. Instead `onError` fires and a failure
notice renders, which you can replace with `renderError`.

`VivariFailure` is `{ phase, error }`. The phase is one of
`"unsupported" | "boot" | "mount" | "install" | "run"`, so you can tell "this
browser can't do this" apart from "your install script is broken". An
`"unsupported"` failure also carries a `reason`, either
`"not-cross-origin-isolated"` or `"no-web-workers"`.

## Live example

The `<Vivari>` component below boots a real Vite + React dev server inside your
browser and renders its preview. Edit `src/App.jsx` on the left and the preview
hot-reloads, with no server involved.

<Playground scenario="react" title="Live React dev server" height={520} />

## Composing the pieces

`<Vivari>` is a thin composition of a boot hook and a preview component, and it
joins an enclosing `<VivariProvider>` rather than booting a second kernel. So
you can keep its install/run orchestration and still drive the same VM from the
rest of your tree:

```tsx
import { Vivari, VivariProvider, useVivariFile } from "@vivari/react";

function Editor() {
  const [source, setSource, { save }] = useVivariFile("/src/App.jsx");
  return (
    <textarea
      value={source}
      onChange={(e) => setSource(e.target.value)}   // debounced write-behind
      onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "s" && save()}
    />
  );
}

export function App() {
  return (
    <VivariProvider>
      <Editor />
      <Vivari files={files} run="npm run dev" style={{ height: 480 }} />
    </VivariProvider>
  );
}
```

For full control, drop `<Vivari>` and use `useSpawn()` + `<VivariPreview>`
directly inside the provider.

## `useVivari(options?)`

```tsx
const { status, vivari, error, boot, restart } = useVivari();
```

`status` is a discriminated union that narrows `vivari`:
`"idle" | "booting" | "ready" | "error" | "unsupported"`. Only `"ready"` gives
you a non-null `vivari`, and `"unsupported"` adds a `reason`, so an un-isolated
page gets an actionable message instead of a spinner that never stops.

Instances are **shared and ref-counted per `instanceKey`** (default
`"default"`). Two components that both call `useVivari()` get the same kernel,
and it is torn down when the last one unmounts — booting a second kernel costs
an entire worker tree, so it should be deliberate. Pass a different
`instanceKey` when you genuinely want one.

Pass `autoBoot: false` to defer the boot until you call `boot()` — a playground
below the fold should not cost a kernel to a visitor who never scrolls.
`restart()` tears the instance down and boots a fresh one.

## `<VivariPreview>`

The preview `<iframe>` on its own, for your own layout. It renders `fallback`
until a server is genuinely serving, then points the frame at it and calls
`vivari.attachPreview(frame)` to run the inbound HMR/SSE tunnel — without that,
Vite HMR never gets past `[vite] connecting…`.

```tsx
<VivariPreview port={5173} reloadKey={n} style={{ width: "100%", height: 480 }} />
```

Props: `port`, `path`, `vivari`, `reloadKey`, `onServerReady`, `fallback`, plus
any iframe attribute. Every `server-ready` re-points the frame, so a dev server
that restarts reconnects. Bump `reloadKey` to reload without remounting —
remounting would drop the HMR socket.

## `useSpawn(command, args?, options?)`

```tsx
const { run, kill, write, status, output, process } = useSpawn("node", ["index.js"], {
  onOutput: (chunk) => term.write(chunk),
  onExit: (code) => term.writeln(`[exited ${code}]`),
});
```

Any running process is killed on unmount. `command`/`args` are read when a run
starts, so an inline array is fine. `collect: true` accumulates into `output`
for a `<pre>` — it is off by default because `npm install` emits thousands of
chunks and a re-render per chunk is a perf disaster; use `onOutput` for a
terminal. `write()` feeds stdin. `auto: true` runs once the instance is ready.

## `useVivariFile(path, options?)`

```tsx
const [source, setSource, { status, error, save, reload }] = useVivariFile(
  "/src/App.jsx",
  { debounce: 250 },
);
```

A file in the VFS as React state, with debounced write-behind. `save()` cancels
the pending debounce and writes immediately (the Cmd+S path), and a pending
write is flushed on unmount and before switching paths, so the last edit before
navigating away is not lost. Text only; for binary use `vivari.fs.readFile()`.

:::note Two filesystem APIs, one filesystem
These hooks read and write through `vivari.fs`, the host-side control plane —
the subset your page needs to put a project in and read results back out (see
the [Core API](./core-api)). Code running *inside* the VM uses Node's own `fs`
via `require("fs")`, a much larger surface provided by the in-VM runtime.

Both act on the same VFS, so a file written by `useVivariFile` is immediately
visible to a spawned process. But they are different APIs: don't expect these
hooks to track Node's `fs`.
:::

## `useVivariDir(path, options?)`

```tsx
const { entries, status, refresh } = useVivariDir("/src");
// entries: DirEnt[] — name, isFile(), isDirectory()
```

A directory listing that stays current as the VFS changes. The watch is
non-recursive and re-reads are debounced (default 100 ms), because the kernel
reports every change with no coalescing and one `npm install` fires thousands.
Use one hook per expanded directory rather than one watch over the root. There
is no glob option: pattern matching lives in the in-VM `fs`, so do it in a
spawned script and read the result back.

## Next.js App Router

Set the isolation headers in `next.config.js` — without them
`SharedArrayBuffer` is undefined and `useVivari()` reports
`status: "unsupported"`:

```js
module.exports = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
};
```

:::warning
`require-corp` makes every cross-origin subresource — images, fonts, analytics,
embeds — fail unless it sends `Cross-Origin-Resource-Policy` or you load it with
`crossorigin`. Scope the headers to the route that hosts Vivari if that is a
problem. The SDK's `sw.js` must also be served from the origin root (or with
`Service-Worker-Allowed`) so its scope covers the preview URLs.
:::

## The name `Vivari`

`Vivari` from `@vivari/react` is the **component**; the core class is re-exported
as the type **`VivariInstance`**, the name a React consumer only meets in type
position because the hooks construct it for you. To call `Vivari.boot()`
yourself, import the class from `@vivari/core` — it is a peer dependency, so it
is the same single copy.

Every type on this surface is re-exported (`BootOptions`, `FileSystemTree`,
`SpawnOptions`, `VivariProcess`, `DirEnt`, `Stats`, …), along with
`isCrossOriginIsolated()`, `resetVfs()` and the `VivariError` / `VivariFsError`
classes, so you never need a second import from `@vivari/core`.

## Upgrading

- **Boot options moved to the `boot` prop.** `<Vivari>` used to spread
  `BootOptions` at the top level; it now spreads iframe attributes instead, so
  `<Vivari compress={false}>` becomes `<Vivari boot={{ compress: false }}>`.
- **`fallback` no longer covers failures.** It used to render for every
  non-preview state, which is what made an un-isolated page show "Booting…"
  forever with the actionable message discarded. Handle failures with `onError`
  or `renderError`.
- **`useVivari()` instances are shared.** Two components that each call it now
  share one kernel instead of booting two, and teardown waits for the last
  consumer. Pass distinct `instanceKey`s for the old behaviour.
- **`VivariStatus` gained `"idle"` and `"unsupported"`,** and moved from
  `./Vivari` to `./useVivari`. Exhaustive `switch`es need the new arms. The
  first render is now `"idle"`, not `"booting"`.
- **`@vivari/core` is a peer dependency.** Add it to your own `package.json`.