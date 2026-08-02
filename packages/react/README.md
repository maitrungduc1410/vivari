# @vivari/react

React bindings for [Vivari](../core) — run Node.js projects fully client-side in
the browser, embedded in your React app.

```bash
npm install @vivari/react @vivari/core react
```

`@vivari/core` and `react` are **peer dependencies**: you install them, and you
get exactly one copy of each. (Two copies of core would mean two kernel worker
bundles and two Wasm asset sets in your build.) The package is ESM-only.

> Like all of Vivari, this needs a **cross-origin isolated** page. See
> [Cross-origin isolation](#cross-origin-isolation) below — it is the wall most
> people hit first.

## Quick start

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
      onOutput={(chunk) => console.log(chunk)}
      onError={({ phase, error }) => console.error(phase, error)}
      style={{ width: "100%", height: 480, border: 0 }}
      fallback={<p>Booting Vivari…</p>}
    />
  );
}
```

`fallback` is the **pending** slot only. Failures — a page that isn't
cross-origin isolated, a failed `npm install`, a spawn that throws — render a
built-in notice instead, and call `onError`. Nothing is swallowed. Use
`renderError` to replace that notice.

## Composing the pieces

`<Vivari>` is a thin composition of a boot hook and a preview component. When you
need your own layout, use them directly — one kernel is shared across the tree:

```tsx
import {
  VivariProvider,
  VivariPreview,
  useVivariFile,
  useSpawn,
} from "@vivari/react";

function Editor() {
  const [source, setSource, { status, save }] = useVivariFile("/src/App.jsx");
  return (
    <textarea
      value={source}
      onChange={(e) => setSource(e.target.value)}          // debounced write-behind
      onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "s" && save()}
      data-status={status}
    />
  );
}

function DevServer() {
  const { run, status } = useSpawn("npm", ["run", "dev"]);
  return (
    <>
      <button onClick={() => run()} disabled={status === "running"}>Start</button>
      <VivariPreview port={5173} style={{ width: "100%", height: 480, border: 0 }} />
    </>
  );
}

export function App() {
  return (
    <VivariProvider>
      <Editor />
      <DevServer />
    </VivariProvider>
  );
}
```

You can also pass `children` to `<Vivari>` to keep its install/run orchestration
while taking over rendering. A function child receives the live boot state:

```tsx
<Vivari files={files} run="npm run dev">
  {(state) =>
    state.status === "ready"
      ? <VivariPreview port={5173} style={{ height: 480 }} />
      : <p>{state.status}…</p>}
</Vivari>
```

## Cross-origin isolation

Vivari needs `SharedArrayBuffer`, which browsers only expose on a cross-origin
isolated page. Serve your HTML documents (and `sw.js`) with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Check before you render:

```tsx
import { isCrossOriginIsolated } from "@vivari/react";

if (!isCrossOriginIsolated()) {
  // Vivari cannot boot here. The hooks report this as
  // `status: "unsupported"` with `reason: "not-cross-origin-isolated"`.
}
```

### Next.js (App Router)

```js
// next.config.js
const isolation = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
];

module.exports = {
  async headers() {
    // Scope this to the playground route, NOT to /:path* — see the warning below.
    return [{ source: "/playground/:path*", headers: isolation }];
  },
};
```

Two Next-specific gotchas:

1. **`require-corp` breaks cross-origin subresources.** Under it, every
   cross-origin resource must opt in with `Cross-Origin-Resource-Policy` (or
   CORS). That means remote-loader `next/image` sources, third-party analytics,
   embedded fonts and most `<script src>` tags from other origins will fail on an
   isolated page. Scope the headers to the route that hosts Vivari rather than
   applying them site-wide.
2. **Next does not serve the Service Worker with the header Vivari needs.** Put
   `sw.js` in `public/` and add a header rule giving it
   `Service-Worker-Allowed: /`, or pass `boot={{ serviceWorkerUrl: false }}` if
   you don't need in-browser server previews. The default is `"/sw.js"`.

### Vite

```ts
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};
export default defineConfig({ server: { headers: isolation }, preview: { headers: isolation } });
```

More recipes (Cloudflare, Netlify, Nginx, Express) are in the
[core docs](../core/README.md).

## Server rendering

Every entry point carries `"use client"`, so importing this package from a
Next.js Server Component works. During SSR/prerender the hooks report
`status: "idle"` and boot nothing; the kernel starts in an effect on the client.

## API

### `<Vivari>`

Extends the standard `<iframe>` props (`className`, `style`, `id`, `allow`,
`sandbox`, `loading`, …), which reach the preview frame. `ref` forwards to it.

| prop | type | default |
| --- | --- | --- |
| `files` | `FileSystemTree` | – |
| `install` | `string \| string[] \| false` | `["npm", "install"]` |
| `run` | `string \| string[]` | – |
| `boot` | `BootOptions` | `{}` |
| `instanceKey` | `string` | enclosing provider's, else `"default"` |
| `autoBoot` | `boolean` | `true` |
| `onReady` | `(vivari: VivariInstance) => void` | – |
| `onServerReady` | `(port, url) => void` | – |
| `onOutput` | `(chunk: string) => void` | – |
| `onError` | `(failure: VivariFailure) => void` | – |
| `showPreview` | `boolean` | `true` |
| `previewPort` | `number` | first port that listens |
| `previewPath` | `string` | `"/"` |
| `fallback` | `ReactNode` | `null` |
| `renderError` | `(failure: VivariFailure) => ReactNode` | built-in notice |
| `children` | `ReactNode \| (state) => ReactNode` | – |

`VivariFailure` is `{ phase, error }` where `phase` is `"unsupported"`,
`"boot"`, `"mount"`, `"install"` or `"run"`. The `"unsupported"` variant also
carries a `reason`.

Commands given as a string are split on whitespace; use the array form for
anything containing quotes.

### `<VivariPreview>`

The preview `<iframe>` on its own. It renders `fallback` until the in-VM server
is genuinely serving, then points the frame at it and calls
`vivari.attachPreview(frame)` to run the inbound half of the HMR/SSE tunnel that
Vite's client needs — without that, Vite HMR never gets past
`[vite] connecting…`.

| prop | type | default |
| --- | --- | --- |
| `port` | `number` | first server that serves |
| `path` | `string` | `"/"` |
| `vivari` | `VivariInstance \| null` | nearest provider's |
| `reloadKey` | `string \| number` | – |
| `onServerReady` | `(port, url) => void` | – |
| `fallback` | `ReactNode` | – |

Any other prop (`className`, `style`, `title`, `allow`, `sandbox`, …) goes
straight to the `<iframe>`, and `ref` forwards to the element.

It follows core's `server-ready` event, which fires when the kernel has
confirmed the port is answering — not on the raw `listen`, which a dev server
emits several times while it rebinds. Each `server-ready` re-points the frame,
so a dev server that dies and restarts reconnects rather than being ignored.
The flip side is that a `<VivariPreview>` mounted *after* a server started
missed the event: keep it mounted, or bump `reloadKey`.

Change `reloadKey` to reload the frame without remounting it — remounting would
tear down the HMR socket.

### `useVivari(options?)`

```tsx
const { status, vivari, error, boot, restart } = useVivari();
```

`status` is a discriminated union — `"idle" | "booting" | "ready" | "error" |
"unsupported"` — so `status === "ready"` narrows `vivari` to a non-null instance
and no defensive null check is needed:

```tsx
const state = useVivari();
if (state.status === "unsupported") return <FixYourHeaders reason={state.reason} />;
if (state.status !== "ready") return <p>{state.status}…</p>;
await state.vivari.spawn("node", ["-e", "console.log(2 + 2)"]); // no `!`
```

Options are `BootOptions` plus:

| option | type | default |
| --- | --- | --- |
| `instanceKey` | `string` | `"default"` |
| `autoBoot` | `boolean` | `true` |

Instances are **shared and ref-counted per `instanceKey`**. Two components with
the same key share one kernel, and React StrictMode's double-mount boots exactly
once. Boot options are read when the boot starts; later changes apply on the
next `restart()`.

Pass `autoBoot: false` to defer the boot until a user gesture — worth doing for a
playground below the fold, so a visitor who never scrolls never pays for a
kernel:

```tsx
const { status, boot } = useVivari({ autoBoot: false });
return status === "idle" ? <button onClick={boot}>Run this example</button> : …;
```

### `<VivariProvider>` / `useVivariContext()` / `useVivariInstance()`

`<VivariProvider>` takes the same options as `useVivari` and publishes the result
to the subtree. `useVivariContext()` reads it and throws outside a provider;
`useVivariContext({ optional: true })` returns `null` instead.
`useVivariInstance(explicit?)` resolves the instance a hook should act on and is
what `useSpawn` / `useVivariFile` / `<VivariPreview>` use internally.

### `useSpawn(command, args?, options?)`

```tsx
const { run, kill, write, status, output, exitCode, process } = useSpawn("node", ["index.js"]);
```

`command` and `args` are read when a run starts, so an inline array is fine and
changing them does not restart anything — call `run()` for that. Any running
process is killed on unmount.

| option | type | default |
| --- | --- | --- |
| `auto` | `boolean` | `false` |
| `collect` | `boolean` | `false` |
| `onOutput` | `(chunk: string) => void` | – |
| `onExit` | `(code: number) => void` | – |
| `onError` | `(error: Error) => void` | – |
| `vivari` | `VivariInstance \| null` | nearest provider's |
| `cwd`, `env` | from `SpawnOptions` | – |

`collect` is off by default on purpose: `npm install` emits thousands of chunks
and a re-render per chunk is a perf disaster. Use `onOutput` (zero re-renders) to
drive a terminal, and turn `collect` on only when you want to render the log into
a `<pre>`.

`output` is the interleaved stdout+stderr stream, which is what a terminal
wants. To style them differently, read the separate `process.stdout` and
`process.stderr` streams off the returned `process` handle — reading either one
does not consume `output`.

#### xterm.js recipe

There is no `<VivariTerminal>` component, deliberately — xterm.js is a heavy,
opinionated dependency and every embedder wants different theming, addons and
fit behaviour. `useSpawn` reduces the glue to this:

```tsx
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useSpawn } from "@vivari/react";

function NodeTerminal({ file }: { file: string }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);

  const { run, write, status } = useSpawn("node", [file], {
    onOutput: (chunk) => term.current?.write(chunk),
    onExit: (code) => term.current?.writeln(`\r\n[exited with code ${code}]`),
  });

  useEffect(() => {
    const t = new Terminal({ convertEol: true, cursorBlink: true });
    const fit = new FitAddon();
    t.loadAddon(fit);
    if (host.current) t.open(host.current);
    fit.fit();
    term.current = t;
    const onData = t.onData(write);   // forward keystrokes to stdin
    return () => { onData.dispose(); t.dispose(); };
  }, [write]);

  return (
    <>
      <button onClick={() => run()} disabled={status === "running"}>Run</button>
      <div ref={host} />
    </>
  );
}
```

`run`, `kill` and `write` keep a stable identity, so they are safe in dependency
arrays.

### `useVivariFile(path, options?)`

```tsx
const [source, setSource, { status, error, save, reload }] = useVivariFile("/src/App.jsx", {
  debounce: 250,
});
```

Reads the file into React state and writes edits back with a debounce. `save()`
cancels the pending debounce and writes immediately (the Cmd+S path), and a
pending write is **flushed on unmount and before switching paths** — so the last
edit before navigating away isn't lost.

| option | type | default |
| --- | --- | --- |
| `debounce` | `number` (ms, `0` = write every change) | `250` |
| `initialContents` | `string` | – |
| `vivari` | `VivariInstance \| null` | nearest provider's |
| `onError` | `(error: Error) => void` | – |

Text only. For binary content use `vivari.fs.readFile(path)` with no encoding.

### `useVivariDir(path, options?)`

```tsx
const { entries, status, error, refresh } = useVivariDir("/src");

return (
  <ul>
    {entries.map((e) => (
      <li key={e.name}>{e.isDirectory() ? `${e.name}/` : e.name}</li>
    ))}
  </ul>
);
```

A directory listing that stays current as the VFS changes underneath it — the
file-tree half of an IDE, without hand-rolling a watcher.

| option | type | default |
| --- | --- | --- |
| `debounce` | `number` (ms, `0` = re-read on every event) | `100` |
| `vivari` | `VivariInstance \| null` | nearest provider's |
| `onError` | `(error: Error) => void` | – |

`entries` are `DirEnt`s (`name`, `isFile()`, `isDirectory()`). The watch is
non-recursive, since only changes directly inside `path` can alter its listing,
and re-reads are debounced because core reports every change with no coalescing
— one `npm install` fires thousands of events. A slow read can never overwrite a
newer one. Render one hook per expanded directory rather than one recursive
watch over the root.

### Re-exports

Every type on the wrapped surface is re-exported, so you never need a second
import from `@vivari/core` just to annotate a variable: `BootOptions`,
`DirEnt`, `DirectoryNode`, `Encoding`, `ErrorListener`, `ExportedFile`,
`ExportOptions`, `ExportResult`, `FileNode`, `FileSystemAPI`, `FileSystemTree`,
`FsChangeEvent`, `FsChangeKind`, `FsChangeListener`, `FsOperationOptions`,
`FSWatcher`, `KernelMessage`, `ListenerOptions`, `MountOptions`, `OutputStream`,
`PortKind`, `PortListener`, `ServerReadyListener`, `SpawnOptions`, `Stats`,
`Unsubscribe`, `VivariEventMap`, `VivariErrorCode`, `VivariFsErrorCode`,
`VivariListener`, `VivariProcess`, `VivariRuntimeErrorCode`, `WatchOptions`,
`VivariInstance`.

Plus four values: `isCrossOriginIsolated`, `resetVfs`, and the `VivariError` /
`VivariFsError` classes (so `instanceof` and `error.code` work without a second
import).

`KernelBridge` is deliberately not re-exported — it is core's escape hatch
(`vivari.internal`), and reaching for it should be an explicit `@vivari/core`
import rather than something these bindings normalise.

## A note on the name `Vivari`

`Vivari` in this package is the React **component**. The core **class** — what
`Vivari.boot()` returns and what every hook hands you — is re-exported as the
type `VivariInstance`, because in React you only ever see it in type position:
the hooks construct it for you.

To call `Vivari.boot()` yourself, import the class from `@vivari/core` directly.
It's a peer dependency, so you already have exactly one copy of it.

```tsx
import { Vivari } from "@vivari/react";              // the <Vivari> component
import type { VivariInstance } from "@vivari/react"; // the instance type
import { Vivari as VivariClass } from "@vivari/core"; // the class, if you need it
```

## License

MIT © Duc Trung Mai