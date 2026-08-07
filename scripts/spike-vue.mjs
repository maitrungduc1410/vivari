// Spike (NETWORK): prove the Vue template's Vite dev server boots + serves in-VM.
// Mirrors the shipped `vue-ts` template in packages/studio/src/vv/templates.ts,
// including the @vitejs/plugin-vue@^6 bump (v5 peers vite <=6, so it ERESOLVEs
// against the pinned Vite 8). The entry gate hits /src/App.vue so the SFC compiler
// actually runs. Run (Node 22+):  node scripts/spike-vue.mjs

import { runViteSpike } from "./spike-vite-lib.mjs";

const INDEX_CSS = `:root { font-family: system-ui, sans-serif; }
body { margin: 0; display: grid; place-items: center; min-height: 100vh; }
.card { padding: 2em; }
button { border-radius: 8px; border: 1px solid transparent; padding: 0.6em 1.2em; cursor: pointer; }
`;

const ok = await runViteSpike({
  name: "Vue",
  dir: "/vue",
  templateId: "vue-ts",
  entryModule: "/src/App.vue",
  titleMarker: /Vite \+ Vue/,
  files: {
    "package.json": `{
  "name": "vite-vue-ts",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "vue": "^3.5.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^6.0.0",
    "@rolldown/binding-wasm32-wasi": "~1.2.0",
    "vite": "^8.0.0",
    "typescript": "^5.7.0",
    "vue-tsc": "^2.2.0"
  }
}
`,
    "vite.config.js": `import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
})
`,
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + Vue</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
    "src/index.css": INDEX_CSS,
    "src/main.ts": `import { createApp } from 'vue'
import './index.css'
import App from './App.vue'

createApp(App).mount('#app')
`,
    "src/App.vue": `<script setup lang="ts">
import { ref } from 'vue'

const count = ref(0)
</script>

<template>
  <h1>Vite + Vue + TS</h1>
  <div class="card">
    <button type="button" @click="count++">count is {{ count }}</button>
    <p>Edit <code>src/App.vue</code> and save to test HMR</p>
  </div>
  <p>Running inside Vivari — a real Vite dev server in your browser.</p>
</template>
`,
    "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "module": "ESNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "jsx": "preserve",
    "strict": true
  },
  "include": ["src"]
}
`,
    "src/vue-shim.d.ts": `declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
`,
  },
});

process.exit(ok ? 0 : 1);