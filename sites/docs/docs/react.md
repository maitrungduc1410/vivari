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
      style={{ width: "100%", height: 480, border: 0 }}
      fallback={<p>Booting Vivari…</p>}
    />
  );
}
```

### Props

Extends `BootOptions` (`compress`, `serviceWorkerUrl`, `workerName`), plus:

| prop | type | default |
| --- | --- | --- |
| `files` | `FileSystemTree` | – |
| `install` | `string \| string[] \| false` | `["npm", "install"]` |
| `run` | `string \| string[]` | – |
| `onReady` | `(vivari) => void` | – |
| `onServerReady` | `(port, url) => void` | – |
| `onOutput` | `(chunk) => void` | – |
| `showPreview` | `boolean` | `true` |
| `className` | `string` | – |
| `style` | `CSSProperties` | – |
| `fallback` | `ReactNode` | `null` |

## Live example

The `<Vivari>` component below boots a real Vite + React dev server inside your
browser and renders its preview. Edit `src/App.jsx` on the left and the preview
hot-reloads, with no server involved.

<Playground scenario="react" title="Live React dev server" height={520} />

## `useVivari()` hook

For full control, boot an instance and drive it yourself:

```tsx
import { useEffect } from "react";
import { useVivari } from "@vivari/react";

function Terminal() {
  const { vivari, status, error } = useVivari();

  useEffect(() => {
    if (status !== "ready" || !vivari) return;
    (async () => {
      const proc = await vivari.spawn("node", ["-e", "console.log(2 + 2)"]);
      await proc.output.pipeTo(new WritableStream({ write: console.log }));
    })();
  }, [status, vivari]);

  if (status === "error") return <p>Failed: {error?.message}</p>;
  return <p>{status}</p>;
}
```

The instance is torn down on unmount. Options are read once; change them by
remounting (e.g. with a React `key`).