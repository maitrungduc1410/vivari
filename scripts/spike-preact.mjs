// Spike (NETWORK): prove the Preact template's Vite dev server boots + serves
// in-VM. Mirrors the shipped `preact` template in packages/studio/src/oc/templates.ts.
// Run (Node 22+):  node scripts/spike-preact.mjs   (see spike-vite-lib.mjs for setup)

import { runViteSpike } from "./spike-vite-lib.mjs";

const INDEX_CSS = `:root { font-family: system-ui, sans-serif; }
body { margin: 0; display: grid; place-items: center; min-height: 100vh; }
.card { padding: 2em; }
button { border-radius: 8px; border: 1px solid transparent; padding: 0.6em 1.2em; cursor: pointer; }
`;

const ok = await runViteSpike({
  name: "Preact",
  dir: "/preact",
  entryModule: "/src/main.tsx",
  titleMarker: /Vite \+ Preact/,
  files: {
    "package.json": `{
  "name": "preact-app",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview" },
  "dependencies": { "preact": "^10.25.0" },
  "devDependencies": { "@preact/preset-vite": "^2.9.0", "typescript": "^5.7.0", "vite": "^8.0.0" }
}
`,
    "vite.config.ts": `import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

export default defineConfig({
  plugins: [preact()],
})
`,
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + Preact</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    "src/index.css": INDEX_CSS,
    "src/main.tsx": `import { render } from 'preact'
import { App } from './app'
import './index.css'

render(<App />, document.getElementById('app')!)
`,
    "src/app.tsx": `import { useState } from 'preact/hooks'

export function App() {
  const [count, setCount] = useState(0)
  return (
    <>
      <h1>Vite + Preact</h1>
      <div class="card">
        <button onClick={() => setCount((c) => c + 1)}>count is {count}</button>
      </div>
      <p>Running inside OpenContainer.</p>
    </>
  )
}
`,
    "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "jsxImportSource": "preact",
    "skipLibCheck": true,
    "noEmit": true,
    "strict": true
  },
  "include": ["src"]
}
`,
  },
});

process.exit(ok ? 0 : 1);
