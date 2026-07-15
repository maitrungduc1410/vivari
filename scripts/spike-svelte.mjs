// Spike (NETWORK): prove the Svelte template's Vite dev server boots + serves
// in-VM. Mirrors the shipped `svelte-ts` template in
// packages/studio/src/oc/templates.ts, pinned to Vite 7 + @sveltejs/vite-plugin-svelte@^6.
// Vite 8 is avoided on purpose: its rolldown-wasm dep optimizer, combined with the
// SSR optimize pass vite-plugin-svelte forces on boot, panics in-VM with "Access
// tokio runtime failed in spawn" (the napi-rs tokio runtime is shut down after the
// first/client bundle and never re-inits under wasi — a known upstream rolldown wasi
// bug, rolldown#8747/#9134, that also hits StackBlitz). Vite 7 uses the esbuild
// optimizer instead, which runs in-process via esbuild-inproc-patch.js. The entry
// gate hits /src/App.svelte so the Svelte compiler runs. Run (Node 22+):
//   node scripts/spike-svelte.mjs

import { runViteSpike } from "./spike-vite-lib.mjs";

const INDEX_CSS = `:root { font-family: system-ui, sans-serif; }
body { margin: 0; display: grid; place-items: center; min-height: 100vh; }
.card { padding: 2em; }
button { border-radius: 8px; border: 1px solid transparent; padding: 0.6em 1.2em; cursor: pointer; }
`;

const ok = await runViteSpike({
  name: "Svelte",
  dir: "/svelte",
  entryModule: "/src/App.svelte",
  titleMarker: /Vite \+ Svelte/,
  files: {
    "package.json": `{
  "name": "vite-svelte-ts",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "devDependencies": {
    "@sveltejs/vite-plugin-svelte": "^6.0.0",
    "svelte": "^5.0.0",
    "vite": "^7.0.0",
    "svelte-check": "^4.0.0",
    "typescript": "^5.7.0"
  }
}
`,
    "vite.config.js": `import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte()],
})
`,
    "svelte.config.js": `import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

export default {
  preprocess: vitePreprocess(),
}
`,
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + Svelte</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
    "src/index.css": INDEX_CSS,
    "src/main.ts": `import './index.css'
import App from './App.svelte'
import { mount } from 'svelte'

const app = mount(App, { target: document.getElementById('app') })

export default app
`,
    "src/App.svelte": `<script lang="ts">
  let count = $state(0)
</script>

<h1>Vite + Svelte + TS</h1>
<div class="card">
  <button onclick={() => count++}>count is {count}</button>
  <p>Edit <code>src/App.svelte</code> and save to test HMR</p>
</div>
<p>Running inside OpenContainer — a real Vite dev server in your browser.</p>
`,
    "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "moduleResolution": "bundler",
    "skipLibCheck": true,
    "noEmit": true,
    "strict": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src"]
}
`,
  },
});

process.exit(ok ? 0 : 1);
