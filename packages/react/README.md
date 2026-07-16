# @vivari/react

React bindings for [Vivari](../core) — run Node.js projects fully client-side in
the browser, embedded in your React app.

```bash
npm install @vivari/react @vivari/core react
```

> Like all of Vivari, this needs a **cross-origin isolated** page
> (`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
> require-corp`). See the [core README](../core/README.md).

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

| prop            | type                                | default              |
| --------------- | ----------------------------------- | -------------------- |
| `files`         | `FileSystemTree`                    | –                    |
| `install`       | `string \| string[] \| false`       | `["npm", "install"]` |
| `run`           | `string \| string[]`                | –                    |
| `onReady`       | `(vivari) => void`                  | –                    |
| `onServerReady` | `(port, url) => void`               | –                    |
| `onOutput`      | `(chunk) => void`                   | –                    |
| `showPreview`   | `boolean`                           | `true`               |
| `className`     | `string`                            | –                    |
| `style`         | `CSSProperties`                     | –                    |
| `fallback`      | `ReactNode`                         | `null`               |

## `useVivari()` hook

For full control, boot an instance and drive it yourself:

```tsx
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

The instance is torn down on unmount. Options are read once — change them by
remounting (e.g. with a React `key`).

## License

MIT © Duc Trung Mai
