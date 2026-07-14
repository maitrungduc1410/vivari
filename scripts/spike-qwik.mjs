// Spike (NETWORK): prove the Qwik template's Vite dev server boots + serves in-VM.
// Mirrors the shipped `qwik` template in packages/studio/src/oc/templates.ts. Qwik
// is the heaviest of the frontend variants (its optimizer plugin does more than a
// plain JSX transform), so the entry-module gate is the meaningful one here.
// Run (Node 22+):  node scripts/spike-qwik.mjs   (see spike-vite-lib.mjs for setup)

import { runViteSpike } from "./spike-vite-lib.mjs";

const ok = await runViteSpike({
  name: "Qwik",
  dir: "/qwik",
  entryModule: "/src/main.tsx",
  titleMarker: /Vite \+ Qwik/,
  files: {
    "package.json": `{
  "name": "qwik-app",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview" },
  "dependencies": { "@builder.io/qwik": "^1.12.0" },
  "devDependencies": { "typescript": "^5.7.0", "vite": "^7.0.0" }
}
`,
    "vite.config.ts": `import { defineConfig } from 'vite'
import { qwikVite } from '@builder.io/qwik/optimizer'

// csr: true = client-side-rendered SPA (no SSR). Without it qwikVite runs in SSR
// mode and demands a src/root.tsx server entry ("Qwik input src/root not found").
export default defineConfig({
  plugins: [qwikVite({ csr: true })],
})
`,
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + Qwik</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    "src/main.tsx": `import { render } from '@builder.io/qwik'
import { App } from './app'

render(document.getElementById('app')!, <App />)
`,
    "src/app.tsx": `import { component$, useSignal } from '@builder.io/qwik'

export const App = component$(() => {
  const count = useSignal(0)
  return (
    <main style="font-family: system-ui, sans-serif; text-align: center; padding: 3rem">
      <h1>Vite + Qwik</h1>
      <button onClick$={() => count.value++}>count is {count.value}</button>
      <p>Running inside OpenContainer.</p>
    </main>
  )
})
`,
    "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "jsxImportSource": "@builder.io/qwik",
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
