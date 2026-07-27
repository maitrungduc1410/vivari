// Project templates for "Start from template".
//
// Each template is REAL, runnable project source + a manifest describing how to
// bring it to life in-VM (install command, dev command, the port its dev server
// listens on, and which file to open first). The studio reads a template, writes
// its files into the chosen workspace directory via the kernel worker
// (`vv-create-project`), and — if the user keeps "Run init script" checked —
// runs `install && dev` inside a terminal so the dev server boots exactly like
// local development. Nothing here is scaffolded by running `create-vite`/`nest
// new` in-VM: the source is vendored so creation is instant, deterministic, and
// offline.
//
// We keep the source co-located (rather than a sibling `packages/templates` dir
// globbed via import.meta.glob) so it is bundled reliably and never dragged into
// the studio's own tsc/eslint pass.

export type Language = "TypeScript" | "JavaScript" | "Python";

// Picker tabs, StackBlitz-style. The order here drives the tab order in the UI.
export type TemplateCategory =
  | "Frontend"
  | "Backend"
  | "Bun"
  | "Native"
  | "Fullstack"
  | "Docs"
  | "Creative"
  | "Tooling"
  | "Showcase";

export const TEMPLATE_CATEGORIES: TemplateCategory[] = [
  "Frontend",
  "Backend",
  "Bun",
  "Native",
  "Fullstack",
  "Docs",
  "Creative",
  "Tooling",
  "Showcase",
];

export interface TemplateManifest {
  /** Stable id, e.g. "react-ts". */
  id: string;
  /** Short slug used only to suggest a project name, e.g. "react". */
  framework: string;
  /** Icon key for the picker (see templateIcons.tsx); falls back to a generic mark. */
  icon: string;
  /** Which picker tab this template appears under. */
  category: TemplateCategory;
  /** Human label for the picker, e.g. "React". */
  name: string;
  language: Language;
  description: string;
  /** The dev-server port to point the preview at (backends included). */
  port: number;
  /** Path within the dev server to open first. */
  openPath: string;
  /** File (relative to the project root) to open in the editor after creation. */
  entry: string;
  /** Vite-style hot module replacement (vs a full restart on change). */
  hmr: boolean;
  /** Server restarts on change (Nest --watch, tsc) and the preview reloads. */
  reload: boolean;
  /** Install step (skipped automatically if node_modules already exists). */
  install: string;
  /** Dev command run after install. */
  dev: string;
  /** Marks templates whose in-VM dev server is not yet fully proven. */
  experimental?: boolean;
  /**
   * Extra environment variables for this template's install/dev shell, merged on
   * top of the shell defaults. Use for memory- and telemetry-relevant levers the
   * framework itself honors (e.g. disabling a background telemetry reporter).
   * NOTE: do NOT put V8 heap flags here (NODE_OPTIONS=--max-old-space-size): the
   * in-VM runtime's process workers are browser Workers, so v8.setFlagsFromString
   * is a no-op and a heap-size flag string has no effect.
   */
  env?: Record<string, string>;
  /**
   * The preview proxy serves every app under `/preview/<port>/` and, by default,
   * strips that prefix before hitting the dev server. A *client-routed* SPA
   * (Docusaurus, Slidev…) resolves its route from the iframe's own
   * `location.pathname`, so served at `/` its router lands on NotFound. Such a
   * template instead sets its base (baseUrl / Vite `base`) to `/preview/<port>/`
   * and flags this so the SW keeps the prefix — the app then runs consistently
   * under the proxy path (deep-links + `location.reload()` work).
   */
  keepPreviewPrefix?: boolean;
  /**
   * A template whose dev run INTENTIONALLY exposes more than one user-facing
   * server (e.g. a backend API alongside the frontend) sets this so each extra
   * port that binds opens its own preview tab. Off by default: a single dev
   * server's other ports — Vite's HMR WebSocket (:24678), a framework's
   * SSR/render worker (Nuxt/Nitro's ephemeral port), etc. — are internal
   * infrastructure, not browsable apps, so they must NOT each spawn a tab.
   */
  multiPreview?: boolean;
}

export interface TemplateDef {
  manifest: TemplateManifest;
  /** relPath -> file contents. */
  files: Record<string, string>;
}

// Vite's rolldown config bundler throws "Invalid URL" in-VM, so every Vite dev
// command loads its config with `--configLoader native` (npm eats the first --).
const VITE_DEV = "npm run dev -- --configLoader native";

// ── Shared Vite bits ─────────────────────────────────────────────────────────
const VITE_INDEX_CSS = `:root {
  font-family: system-ui, Avenir, Helvetica, Arial, sans-serif;
  line-height: 1.5;
  color-scheme: light dark;
  color: rgba(255, 255, 255, 0.87);
  background-color: #242424;
}
body { margin: 0; display: flex; place-items: center; min-width: 320px; min-height: 100vh; }
#app, #root { max-width: 1280px; margin: 0 auto; padding: 2rem; text-align: center; }
button {
  border-radius: 8px; border: 1px solid transparent; padding: 0.6em 1.2em;
  font-size: 1em; font-weight: 500; font-family: inherit;
  background-color: #1a1a1a; color: white; cursor: pointer; transition: border-color 0.25s;
}
button:hover { border-color: #646cff; }
`;

// ── React ────────────────────────────────────────────────────────────────────
const reactPkg = (ts: boolean) => `{
  "name": "vite-react${ts ? "-ts" : ""}",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^5.0.0",
    "vite": "^8.0.0"${ts ? `,
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "^5.7.0"` : ""}
  }
}
`;

const reactViteConfig = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
})
`;

const reactIndexHtml = (ext: "jsx" | "tsx") => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + React</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.${ext}"></script>
  </body>
</html>
`;

const reactMain = (ts: boolean) => `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.${ts ? "tsx" : "jsx"}'

createRoot(document.getElementById('root')${ts ? "!" : ""}).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`;

const reactApp = (ts: boolean) => `import { useState } from 'react'

function App() {
  const [count, setCount] = useState(0)

  return (
    <>
      <h1>Vite + React${ts ? " + TS" : ""}</h1>
      <div className="card">
        <button onClick={() => setCount((c${ts ? ": number" : ""}) => c + 1)}>
          count is {count}
        </button>
        <p>
          Edit <code>src/App.${ts ? "tsx" : "jsx"}</code> and save to test HMR
        </p>
      </div>
      <p>Running inside Vivari — a real Vite dev server in your browser.</p>
    </>
  )
}

export default App
`;

const reactTsconfig = `{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true
  },
  "include": ["src"]
}
`;

const reactViteEnv = `/// <reference types="vite/client" />
`;

function reactTemplate(ts: boolean): TemplateDef {
  const ext = ts ? "tsx" : "jsx";
  const files: Record<string, string> = {
    "package.json": reactPkg(ts),
    "vite.config.js": reactViteConfig,
    "index.html": reactIndexHtml(ext),
    "src/index.css": VITE_INDEX_CSS,
    [`src/main.${ext}`]: reactMain(ts),
    [`src/App.${ext}`]: reactApp(ts),
  };
  if (ts) {
    files["tsconfig.json"] = reactTsconfig;
    files["src/vite-env.d.ts"] = reactViteEnv;
  }
  return {
    manifest: {
      id: ts ? "react-ts" : "react-js",
      framework: "react",
      icon: "react",
      category: "Frontend",
      name: "React",
      language: ts ? "TypeScript" : "JavaScript",
      description: "React + Vite" + (ts ? " + TypeScript" : ""),
      port: 5173,
      openPath: "/",
      entry: `src/App.${ext}`,
      hmr: true,
      reload: false,
      install: "npm install",
      dev: VITE_DEV,
    },
    files,
  };
}

// ── Vue ──────────────────────────────────────────────────────────────────────
const vuePkg = (ts: boolean) => `{
  "name": "vite-vue${ts ? "-ts" : ""}",
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
    "vite": "^8.0.0"${ts ? `,
    "typescript": "^5.7.0",
    "vue-tsc": "^2.2.0"` : ""}
  }
}
`;

const vueViteConfig = `import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
})
`;

const vueIndexHtml = (ts: boolean) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + Vue</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.${ts ? "ts" : "js"}"></script>
  </body>
</html>
`;

const vueMain = `import { createApp } from 'vue'
import './index.css'
import App from './App.vue'

createApp(App).mount('#app')
`;

const vueApp = (ts: boolean) => `<script setup${ts ? ' lang="ts"' : ""}>
import { ref } from 'vue'

const count = ref(0)
</script>

<template>
  <h1>Vite + Vue${ts ? " + TS" : ""}</h1>
  <div class="card">
    <button type="button" @click="count++">count is {{ count }}</button>
    <p>Edit <code>src/App.vue</code> and save to test HMR</p>
  </div>
  <p>Running inside Vivari — a real Vite dev server in your browser.</p>
</template>
`;

const vueTsconfig = `{
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
`;

const vueShim = `declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
`;

function vueTemplate(ts: boolean): TemplateDef {
  const ext = ts ? "ts" : "js";
  const files: Record<string, string> = {
    "package.json": vuePkg(ts),
    "vite.config.js": vueViteConfig,
    "index.html": vueIndexHtml(ts),
    "src/index.css": VITE_INDEX_CSS,
    [`src/main.${ext}`]: vueMain,
    "src/App.vue": vueApp(ts),
  };
  if (ts) {
    files["tsconfig.json"] = vueTsconfig;
    files["src/vue-shim.d.ts"] = vueShim;
  }
  return {
    manifest: {
      id: ts ? "vue-ts" : "vue-js",
      framework: "vue",
      icon: "vue",
      category: "Frontend",
      name: "Vue",
      language: ts ? "TypeScript" : "JavaScript",
      description: "Vue 3 + Vite" + (ts ? " + TypeScript" : ""),
      port: 5173,
      openPath: "/",
      entry: "src/App.vue",
      hmr: true,
      reload: false,
      install: "npm install",
      dev: VITE_DEV,
    },
    files,
  };
}

// ── Svelte ─────────────────────────────────────────────────────────────────
const sveltePkg = (ts: boolean) => `{
  "name": "vite-svelte${ts ? "-ts" : ""}",
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
    "vite": "^7.0.0"${ts ? `,
    "svelte-check": "^4.0.0",
    "typescript": "^5.7.0"` : ""}
  }
}
`;

const svelteViteConfig = `import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
})
`;

const svelteConfig = `import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

export default {
  preprocess: vitePreprocess(),
}
`;

const svelteIndexHtml = (ts: boolean) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + Svelte</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.${ts ? "ts" : "js"}"></script>
  </body>
</html>
`;

const svelteMain = `import './index.css'
import App from './App.svelte'
import { mount } from 'svelte'

const app = mount(App, { target: document.getElementById('app') })

export default app
`;

const svelteApp = (ts: boolean) => `<script${ts ? ' lang="ts"' : ""}>
  let count = $state(0)
</script>

<h1>Vite + Svelte${ts ? " + TS" : ""}</h1>
<div class="card">
  <button onclick={() => count++}>count is {count}</button>
  <p>Edit <code>src/App.svelte</code> and save to test HMR</p>
</div>
<p>Running inside Vivari — a real Vite dev server in your browser.</p>
`;

const svelteTsconfig = `{
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
`;

function svelteTemplate(ts: boolean): TemplateDef {
  const ext = ts ? "ts" : "js";
  const files: Record<string, string> = {
    "package.json": sveltePkg(ts),
    "vite.config.js": svelteViteConfig,
    "svelte.config.js": svelteConfig,
    "index.html": svelteIndexHtml(ts),
    "src/index.css": VITE_INDEX_CSS,
    [`src/main.${ext}`]: svelteMain,
    "src/App.svelte": svelteApp(ts),
  };
  if (ts) files["tsconfig.json"] = svelteTsconfig;
  return {
    manifest: {
      id: ts ? "svelte-ts" : "svelte-js",
      framework: "svelte",
      icon: "svelte",
      category: "Frontend",
      name: "Svelte",
      language: ts ? "TypeScript" : "JavaScript",
      description: "Svelte 5 + Vite" + (ts ? " + TypeScript" : ""),
      port: 5173,
      openPath: "/",
      entry: "src/App.svelte",
      hmr: true,
      reload: false,
      install: "npm install",
      dev: VITE_DEV,
      // Pinned to Vite 7 + @sveltejs/vite-plugin-svelte@^6 (proven green by
      // scripts/spike-svelte.mjs). Vite 8 is deliberately avoided here: its default
      // dep optimizer is rolldown-wasm, and vite-plugin-svelte forces a SECOND (ssr)
      // optimize pass on boot that can't be disabled from user config. In-VM that
      // second rolldown bundle panics — "Access tokio runtime failed in spawn"
      // (napi-rs tokio runtime is shut down after the first/client bundle and never
      // re-inits under wasi) — which crashes the dev server. This is a known upstream
      // rolldown-on-wasi bug that also hits StackBlitz/WebContainer (rolldown#8747,
      // #9134; napi-rs#2847). Vite 7 sidesteps it entirely by using the esbuild
      // optimizer, which runs in-process via esbuild-inproc-patch.js (same path that
      // graduated Qwik). Revisit Vite 8 once the rolldown wasi tokio lifecycle is fixed.
    },
    files,
  };
}

// ── Express ────────────────────────────────────────────────────────────────
// Shared demo page for the (otherwise headless) backend templates: a small,
// good-looking UI whose button fires a `fetch()` at the server's JSON endpoint
// and renders the status + response. Gives every backend a visible, interactive
// front door — and something to watch in the preview DevTools Network panel.
// Inlined into each server via JSON.stringify (see below) so there are no extra
// files or static-middleware dependencies to manage per framework.
function backendDemoHtml(name: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name} · Vivari</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        background: radial-gradient(1200px 600px at 50% -10%, #1b2333, #0a0a0a); color: #e5e7eb; padding: 2rem; }
      main { width: 100%; max-width: 560px; }
      .eyebrow { color: #7c9cff; font-size: .78rem; letter-spacing: .08em; text-transform: uppercase; margin: 0 0 .4rem; }
      h1 { margin: 0 0 .3rem; font-size: 1.85rem; }
      .sub { color: #9ca3af; margin: 0 0 1.5rem; line-height: 1.5; }
      .card { background: #10131a; border: 1px solid #232a36; border-radius: 14px; padding: 1.25rem; }
      .endpoint { display: flex; align-items: center; gap: .5rem; font-size: .82rem; color: #9ca3af; margin-bottom: 1rem; }
      code { background: #1b212c; padding: .15rem .45rem; border-radius: 6px; color: #cbd5e1; }
      button { appearance: none; border: 0; cursor: pointer; width: 100%; padding: .75rem 1rem; font-size: .95rem; font-weight: 600;
        border-radius: 10px; color: #fff; background: linear-gradient(180deg, #4f7cff, #3b5cf0); transition: filter .15s, transform .05s; }
      button:hover { filter: brightness(1.08); }
      button:active { transform: translateY(1px); }
      button:disabled { opacity: .6; cursor: progress; }
      .status { margin: 1rem 0 .5rem; font-size: .82rem; font-weight: 600; min-height: 1.1rem; }
      .status.ok { color: #4ade80; }
      .status.err { color: #f87171; }
      pre { margin: 0; background: #0b0e14; border: 1px solid #232a36; border-radius: 10px; padding: .85rem;
        overflow: auto; font-size: .82rem; line-height: 1.5; color: #d1d5db; }
      .hint { color: #6b7280; font-size: .76rem; margin: 1rem 0 0; }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Vivari</p>
      <h1>${name}</h1>
      <p class="sub">This backend is running fully in your browser. Click the button to call its API.</p>
      <div class="card">
        <div class="endpoint">Endpoint <code>GET /api/hello</code></div>
        <button id="call">Call GET /api/hello</button>
        <p class="status" id="status"></p>
        <pre id="out">Response will appear here.</pre>
        <p class="hint">Tip: open DevTools &rarr; Network to watch the request.</p>
      </div>
    </main>
    <script>
      (function () {
        var btn = document.getElementById('call');
        var out = document.getElementById('out');
        var statusEl = document.getElementById('status');
        // In the Vivari preview the page lives under /preview/<port>/. Address
        // the in-VM server through that explicit proxy prefix so the request hits the
        // Service Worker's deterministic preview route (the same one that served this
        // page) instead of relying on client-port inference, which is racy right after
        // a preview reload. Standalone (no prefix) it stays a plain /api/hello.
        var pm = location.pathname.match(/^(\\/preview\\/\\d+)\\//);
        var endpoint = (pm ? pm[1] : '') + '/api/hello';
        function setBusy(b) { btn.disabled = b; btn.textContent = b ? 'Calling\\u2026' : 'Call GET /api/hello'; }
        btn.addEventListener('click', function () {
          setBusy(true);
          statusEl.textContent = '';
          statusEl.className = 'status';
          var t0 = performance.now();
          fetch(endpoint, { headers: { accept: 'application/json' } })
            .then(function (r) { return r.text().then(function (body) { return { res: r, body: body }; }); })
            .then(function (o) {
              var ms = Math.round(performance.now() - t0);
              statusEl.textContent = o.res.status + ' ' + o.res.statusText + ' \\u00b7 ' + ms + ' ms';
              statusEl.className = 'status ' + (o.res.ok ? 'ok' : 'err');
              var pretty = o.body;
              try { pretty = JSON.stringify(JSON.parse(o.body), null, 2); } catch (e) {}
              out.textContent = pretty;
            })
            .catch(function (err) {
              statusEl.textContent = 'Request failed';
              statusEl.className = 'status err';
              out.textContent = String((err && err.message) || err);
            })
            .finally(function () { setBusy(false); });
        });
      })();
    </script>
  </body>
</html>
`;
}

function expressTemplate(ts: boolean): TemplateDef {
  if (ts) {
    return {
      manifest: {
        id: "express-ts",
        framework: "express",
        icon: "express",
        category: "Backend",
        name: "Express",
        language: "TypeScript",
        description: "Express + TypeScript (tsc build)",
        port: 3000,
        openPath: "/",
        entry: "src/index.ts",
        hmr: false,
        reload: false,
        install: "npm install",
        // No esbuild/tsx native binary in-VM — compile with tsc, then run node.
        dev: "npm run build && node dist/index.js",
      },
      files: {
        "package.json": `{
  "name": "express-ts",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsc && node dist/index.js"
  },
  "dependencies": {
    "express": "^4.21.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^22.10.0",
    "typescript": "^5.7.0"
  }
}
`,
        "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "outDir": "./dist",
    "rootDir": "./src",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "strict": true
  },
  "include": ["src"]
}
`,
        "src/index.ts": `import express, { Request, Response } from 'express';

const app = express();
const port = Number(process.env.PORT ?? 3000);

const html = ${JSON.stringify(backendDemoHtml("Express"))};

app.get('/', (_req: Request, res: Response) => {
  res.type('html').send(html);
});

app.get('/api/hello', (_req: Request, res: Response) => {
  res.json({ message: 'Hello, world!' });
});

app.listen(port, () => {
  console.log(\`Express listening on http://localhost:\${port}\`);
});
`,
      },
    };
  }
  return {
    manifest: {
      id: "express-js",
      framework: "express",
      icon: "express",
      category: "Backend",
      name: "Express",
      language: "JavaScript",
      description: "Express + Node",
      port: 3000,
      openPath: "/",
      entry: "src/index.js",
      hmr: false,
      reload: false,
      install: "npm install",
      dev: "node src/index.js",
    },
    files: {
      "package.json": `{
  "name": "express-js",
  "version": "1.0.0",
  "private": true,
  "type": "commonjs",
  "scripts": {
    "start": "node src/index.js",
    "dev": "node src/index.js"
  },
  "dependencies": {
    "express": "^4.21.0"
  }
}
`,
      "src/index.js": `const express = require('express');

const app = express();
const port = Number(process.env.PORT ?? 3000);

const html = ${JSON.stringify(backendDemoHtml("Express"))};

app.get('/', (_req, res) => {
  res.type('html').send(html);
});

app.get('/api/hello', (_req, res) => {
  res.json({ message: 'Hello, world!' });
});

app.listen(port, () => {
  console.log(\`Express listening on http://localhost:\${port}\`);
});
`,
    },
  };
}

// ── NestJS ───────────────────────────────────────────────────────────────────
const nestSharedTs = {
  "src/main.ts": `import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
`,
  "src/app.module.ts": `import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
`,
  "src/app.controller.ts": `import { Controller, Get, Header } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @Header('Content-Type', 'text/html')
  getHome(): string {
    return this.appService.getHome();
  }

  @Get('api/hello')
  getHello(): { message: string } {
    return { message: 'Hello, world!' };
  }
}
`,
  "src/app.service.ts": `import { Injectable } from '@nestjs/common';

const html = ${JSON.stringify(backendDemoHtml("NestJS"))};

@Injectable()
export class AppService {
  getHome(): string {
    return html;
  }
}
`,
};

function nestTemplate(): TemplateDef {
  return {
      manifest: {
        id: "nest-ts",
        framework: "nest",
        icon: "nest",
        category: "Backend",
        name: "NestJS",
        language: "TypeScript",
        description: "NestJS (tsc --watch)",
        port: 3000,
        openPath: "/",
        entry: "src/app.service.ts",
        hmr: false,
        reload: true,
        install: "npm install",
        dev: "npm run start:dev",
      },
      files: {
        "package.json": `{
  "name": "nest-ts",
  "version": "0.0.1",
  "private": true,
  "license": "UNLICENSED",
  "scripts": {
    "build": "nest build",
    "start": "nest start",
    "start:dev": "nest start --watch",
    "start:prod": "node dist/main"
  },
  "dependencies": {
    "@nestjs/common": "^11.0.1",
    "@nestjs/core": "^11.0.1",
    "@nestjs/platform-express": "^11.0.1",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1"
  },
  "devDependencies": {
    "@nestjs/cli": "^11.0.0",
    "@nestjs/schematics": "^11.0.0",
    "@types/node": "^22.10.7",
    "source-map-support": "^0.5.21",
    "typescript": "^5.7.3"
  }
}
`,
        "nest-cli.json": `{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true
  }
}
`,
        "tsconfig.json": `{
  "compilerOptions": {
    "module": "commonjs",
    "declaration": true,
    "removeComments": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "allowSyntheticDefaultImports": true,
    "target": "ES2023",
    "sourceMap": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "incremental": true,
    "skipLibCheck": true,
    "strictNullChecks": true,
    "forceConsistentCasingInFileNames": true,
    "noImplicitAny": false,
    "strictBindCallApply": false,
    "noFallthroughCasesInSwitch": false
  }
}
`,
        "tsconfig.build.json": `{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "test", "dist", "**/*spec.ts"]
}
`,
        ...nestSharedTs,
      },
    };
}

// ── WebSocket demo (Express + ws backend + Vite frontend, TWO preview tabs) ──
// One project that starts TWO in-VM servers from a single `dev` run: a backend
// (Express + `ws`) on :3001 and a Vite frontend on :5173. The studio's port
// attribution opens a preview tab for each (see kernel.onListen). The frontend
// reaches the backend's WebSocket cross-service via `/preview/3001/ws` — the SW's
// ws shim routes that prefix to the backend port (the same convention the HTTP
// preview proxy uses). It exercises BOTH directions: the backend pushes a tick
// every second (server→client) and echoes anything the client sends (client→
// server→client).
function wsDemoTemplate(): TemplateDef {
  return {
    manifest: {
      id: "ws-demo",
      framework: "express",
      icon: "ws",
      category: "Showcase",
      name: "WebSocket",
      language: "JavaScript",
      description: "Express + ws backend & Vite frontend talking over a WebSocket — two live preview tabs",
      port: 5173,
      openPath: "/",
      entry: "src/main.js",
      hmr: true,
      reload: false,
      // Two intentional user-facing servers (backend :3001 + frontend :5173), so
      // surface a preview tab for each — the frontend is primary, the backend extra.
      multiPreview: true,
      install: "npm install",
      // sh has no job control (&), so a tiny CJS orchestrator starts both servers.
      dev: "node dev.js",
    },
    files: {
      "package.json": `{
  "name": "ws-demo",
  "private": true,
  "version": "0.0.0",
  "scripts": {
    "dev": "node dev.js",
    "server": "node server/index.js",
    "client": "vite --configLoader native --port 5173 --strictPort"
  },
  "dependencies": {
    "express": "^4.21.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "vite": "^8.0.0"
  }
}
`,
      // Start the backend AND the Vite frontend together, tearing both down if
      // either exits. Both are descendants of this run shell, so each server's
      // listen is attributed to this project and gets its own preview tab.
      "dev.js": `const { spawn } = require('child_process');

const procs = [];
let exiting = false;
function run(label, cmd, args) {
  const child = spawn(cmd, args, { stdio: 'inherit' });
  procs.push(child);
  child.on('exit', (code) => {
    if (exiting) return;
    exiting = true;
    console.log('[dev] ' + label + ' exited (' + code + ') — stopping the other server.');
    for (const p of procs) { if (p !== child) { try { p.kill(); } catch (e) {} } }
    process.exit(code || 0);
  });
  return child;
}

console.log('[dev] starting backend (:3001) and frontend (:5173)…');
run('backend', 'node', ['server/index.js']);
run('frontend', 'npm', ['run', 'client']);
`,
      "vite.config.js": `import { defineConfig } from 'vite'

// The frontend runs on 5173; it reaches the backend WebSocket cross-service via
// /preview/3001/ws (the studio's ws shim routes that to the in-VM :3001 server).
export default defineConfig({
  server: { port: 5173, strictPort: true },
})
`,
      "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>WebSocket demo — frontend</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`,
      "src/style.css": `:root { font-family: system-ui, sans-serif; color-scheme: light dark; }
body { margin: 0; padding: 2rem; }
#app { max-width: 640px; margin: 0 auto; }
h1 { font-size: 1.4rem; }
.status { font-size: .9rem; padding: .25rem .6rem; border-radius: 999px; display: inline-block; }
.status.on { background: #16a34a22; color: #16a34a; }
.status.off { background: #dc262622; color: #dc2626; }
#log { background: #0b0b0c; color: #d1d5db; border-radius: 8px; padding: .75rem; height: 260px;
  overflow: auto; white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: .82rem; margin-top: 1rem; }
.row { display: flex; gap: .5rem; margin-top: .75rem; }
input { flex: 1; padding: .5rem .6rem; border-radius: 6px; border: 1px solid #8884; background: transparent; color: inherit; }
button { padding: .5rem .9rem; border-radius: 6px; border: 1px solid #646cff; background: #646cff; color: #fff; cursor: pointer; }
`,
      // Frontend: connect to the backend ws cross-service, render both directions.
      "src/main.js": `import './style.css'

const BACKEND_PORT = 3001
const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
// Cross-service address: the studio's ws shim maps /preview/<port>/ to that
// in-VM server, exactly like the HTTP preview proxy.
const WS_URL = scheme + '://' + location.host + '/preview/' + BACKEND_PORT + '/ws'

document.querySelector('#app').innerHTML = \`
  <h1>WebSocket demo — frontend (:5173)</h1>
  <p>Talking to the backend on <code>:\${BACKEND_PORT}</code> via <code>/preview/\${BACKEND_PORT}/ws</code>.</p>
  <p><span id="status" class="status off">connecting…</span></p>
  <div class="row">
    <input id="msg" placeholder="Type a message and press Send" />
    <button id="send">Send</button>
  </div>
  <div id="log"></div>
\`

const logEl = document.querySelector('#log')
const statusEl = document.querySelector('#status')
const log = (line) => {
  const t = new Date().toLocaleTimeString()
  logEl.textContent += '[' + t + '] ' + line + '\\n'
  logEl.scrollTop = logEl.scrollHeight
}

log('connecting to ' + WS_URL)
const ws = new WebSocket(WS_URL)
ws.onopen = () => { statusEl.textContent = 'connected'; statusEl.className = 'status on'; log('open — connected to backend') }
ws.onclose = () => { statusEl.textContent = 'disconnected'; statusEl.className = 'status off'; log('close') }
ws.onerror = () => log('error')
ws.onmessage = (e) => {
  try {
    const m = JSON.parse(e.data)
    if (m.type === 'tick') log('server tick → ' + m.time)
    else if (m.type === 'echo') log('echo ← "' + m.msg + '"')
    else log('recv ← ' + e.data)
  } catch { log('recv ← ' + e.data) }
}

const send = () => {
  const input = document.querySelector('#msg')
  const v = input.value.trim()
  if (!v || ws.readyState !== WebSocket.OPEN) return
  ws.send(v)
  log('sent → "' + v + '"')
  input.value = ''
}
document.querySelector('#send').onclick = send
document.querySelector('#msg').addEventListener('keydown', (e) => { if (e.key === 'Enter') send() })
`,
      // Backend: Express status page on / + a ws server on /ws. Pushes a tick each
      // second (server→client) and echoes client messages (client→server→client).
      "server/index.js": `const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = 3001;
const app = express();
let clients = 0;

app.get('/', (_req, res) => {
  res.type('html').send(
    '<!doctype html><meta charset="utf-8">' +
    '<title>WebSocket demo — backend</title>' +
    '<body style="font-family:system-ui;padding:2rem;max-width:640px;margin:auto">' +
    '<h1>WebSocket demo — backend (:' + PORT + ')</h1>' +
    '<p>This Express server also hosts a WebSocket at <code>/ws</code>.</p>' +
    '<p>Open the <b>frontend</b> preview tab (:5173) to see live two-way messages.</p>' +
    '<p>Connected ws clients: <b>' + clients + '</b> (reload to refresh).</p>'
  );
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  clients++;
  console.log('[backend] client connected (' + clients + ' total)');
  ws.send(JSON.stringify({ type: 'echo', msg: 'welcome — you are connected to the backend' }));
  const tick = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'tick', time: new Date().toLocaleTimeString() }));
  }, 1000);
  ws.on('message', (data) => {
    const msg = String(data);
    console.log('[backend] recv: ' + msg);
    ws.send(JSON.stringify({ type: 'echo', msg }));
  });
  ws.on('close', () => { clients--; clearInterval(tick); console.log('[backend] client disconnected'); });
});

server.listen(PORT, () => console.log('[backend] listening on :' + PORT + ' (http + ws /ws)'));
`,
    },
  };
}

// ── Next.js (App Router) ─────────────────────────────────────────────────────
// Next 16 runs in-VM on `next dev --webpack` (Turbopack has no wasm build) with
// the `@next/swc-wasm-nodejs` wasm SWC compiler — selected because the runtime
// reports `process.versions.webcontainer` and npm skips the native
// `@next/swc-<platform>` addon on arch wasm32. See scripts/spike-next.mjs.
//
// postinstall seeds Next's wasm cache from the installed package so first compile
// is offline; if it is skipped, Next downloads the wasm on demand (also works).
const nextSeedSwc = `// Best-effort: copy the installed @next/swc-wasm-nodejs into Next's wasm cache
// dir so \`next dev\` loads the wasm SWC locally instead of downloading it at
// first compile. Safe to fail — Next falls back to its own on-demand download.
import fs from "node:fs";
import path from "node:path";

try {
  const src = path.resolve("node_modules/@next/swc-wasm-nodejs");
  const dst = path.resolve("node_modules/next/wasm/@next/swc-wasm-nodejs");
  if (fs.existsSync(src) && !fs.existsSync(dst)) {
    const cp = (s, d) => {
      fs.mkdirSync(d, { recursive: true });
      for (const e of fs.readdirSync(s, { withFileTypes: true })) {
        const sp = path.join(s, e.name);
        const dp = path.join(d, e.name);
        if (e.isDirectory()) cp(sp, dp);
        else fs.writeFileSync(dp, fs.readFileSync(sp));
      }
    };
    cp(src, dst);
    console.log("[seed-swc] seeded wasm SWC cache");
  }
} catch (e) {
  console.warn("[seed-swc] skipped:", e && e.message);
}
`;

const nextConfigMjs = `/** @type {import('next').NextConfig} */
const nextConfig = {};

export default nextConfig;
`;

const nextPageBody = (ts: boolean) => `export default function Home() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1rem",
        fontFamily: "system-ui, sans-serif",
        background: "#0a0a0a",
        color: "#ededed",
        textAlign: "center",
        padding: "2rem",
      }}
    >
      <h1 id="marker" style={{ fontSize: "2.25rem", margin: 0 }}>
        Next.js App Router
      </h1>
      <p style={{ opacity: 0.7, margin: 0 }}>
        Running in Vivari${ts ? " with TypeScript" : ""} — compiled by wasm SWC + webpack.
      </p>
      <p style={{ opacity: 0.5, margin: 0, fontSize: "0.9rem" }}>
        Edit <code>app/page.${ts ? "tsx" : "js"}</code> and save to see changes.
      </p>
    </main>
  );
}
`;

function nextTemplate(ts: boolean): TemplateDef {
  const ext = ts ? "tsx" : "js";
  const files: Record<string, string> = {
    "package.json": `{
  "name": "next-app${ts ? "-ts" : ""}",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev --webpack -p 3000",
    "build": "next build --webpack",
    "start": "next start -p 3000",
    "postinstall": "node scripts/seed-swc.mjs"
  },
  "dependencies": {
    "next": "^16.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "@next/swc-wasm-nodejs": "^16.0.0"
  }${
    ts
      ? `,
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "^5.7.0"
  }`
      : ""
  }
}
`,
    "next.config.mjs": nextConfigMjs,
    "scripts/seed-swc.mjs": nextSeedSwc,
    [`app/layout.${ext}`]: ts
      ? `import type { ReactNode } from "react";

export const metadata = {
  title: "Next.js in Vivari",
  description: "Next.js 16 App Router (webpack + wasm SWC)",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
`
      : `export const metadata = {
  title: "Next.js in Vivari",
  description: "Next.js 16 App Router (webpack + wasm SWC)",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
`,
    [`app/page.${ext}`]: nextPageBody(ts),
  };
  if (ts) {
    files["tsconfig.json"] = `{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
`;
    files["next-env.d.ts"] = `/// <reference types="next" />
/// <reference types="next/image-types/global" />

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
`;
  }
  return {
    manifest: {
      id: ts ? "next-ts" : "next-js",
      framework: "next",
      icon: "next",
      category: "Fullstack",
      name: "Next.js",
      language: ts ? "TypeScript" : "JavaScript",
      description: "Next.js 16 App Router (webpack + wasm SWC)",
      port: 3000,
      openPath: "/",
      entry: `app/page.${ext}`,
      // Next drives its own Fast Refresh over the preview websocket tunnel; the
      // dev server neither restarts on change nor uses Vite-style dep pre-bundling.
      hmr: false,
      reload: false,
      install: "npm install",
      dev: "npm run dev",
      // Graduated: Next 16 (webpack + wasm SWC) boots + serves in-VM, gated by
      // scripts/spike-next.mjs (incl. the RSC-refresh invariant check).
    },
    files,
  };
}

// ── Vanilla (Vite) ───────────────────────────────────────────────────────────
function vanillaTemplate(ts: boolean): TemplateDef {
  const ext = ts ? "ts" : "js";
  const q = ts ? "!" : "";
  const files: Record<string, string> = {
    "package.json": `{
  "name": "vanilla${ts ? "-ts" : ""}",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "devDependencies": {
    "vite": "^8.0.0"${ts ? `,
    "typescript": "^5.7.0"` : ""}
  }
}
`,
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + Vanilla${ts ? " TS" : ""}</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.${ext}"></script>
  </body>
</html>
`,
    "src/index.css": VITE_INDEX_CSS,
    [`src/main.${ext}`]: `import './index.css'

const app = document.querySelector${ts ? "<HTMLDivElement>" : ""}('#app')${q}
let count = 0
app.innerHTML = \`
  <h1>Vite + Vanilla${ts ? " + TS" : ""}</h1>
  <div class="card"><button id="counter" type="button"></button></div>
  <p>Running inside Vivari — a real Vite dev server in your browser.</p>
\`
const btn = document.querySelector${ts ? "<HTMLButtonElement>" : ""}('#counter')${q}
const render = () => (btn.textContent = \`count is \${count}\`)
btn.addEventListener('click', () => { count++; render() })
render()
`,
  };
  if (ts) {
    files["tsconfig.json"] = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "noEmit": true,
    "strict": true
  },
  "include": ["src"]
}
`;
  }
  return {
    manifest: {
      id: ts ? "vanilla-ts" : "vanilla-js",
      framework: "vanilla",
      icon: ts ? "ts" : "vanilla",
      category: "Frontend",
      name: "Vanilla",
      language: ts ? "TypeScript" : "JavaScript",
      description: "Vanilla" + (ts ? " TypeScript" : " JavaScript") + " + Vite",
      port: 5173,
      openPath: "/",
      entry: `src/main.${ext}`,
      hmr: true,
      reload: false,
      install: "npm install",
      dev: VITE_DEV,
    },
    files,
  };
}

// ── Static (zero-dependency Node static server) ──────────────────────────────
function staticTemplate(): TemplateDef {
  return {
    manifest: {
      id: "static",
      framework: "static",
      icon: "html",
      category: "Frontend",
      name: "Static",
      language: "JavaScript",
      description: "Plain HTML/CSS/JS served by a zero-dependency Node server",
      port: 3000,
      openPath: "/",
      entry: "public/index.html",
      hmr: false,
      reload: false,
      install: "npm install",
      dev: "node server.js",
    },
    files: {
      "package.json": `{
  "name": "static-site",
  "private": true,
  "version": "0.0.0",
  "type": "commonjs",
  "scripts": { "dev": "node server.js", "start": "node server.js" }
}
`,
      "server.js": `// A tiny static file server — no dependencies, nothing to install.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT ?? 3000);
const TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.join(ROOT, path.normalize(urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>404</h1>'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log('Static server on http://localhost:' + PORT));
`,
      "public/index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Static site</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main>
      <h1>Static HTML/CSS/JS</h1>
      <p>Served by a zero-dependency Node server inside Vivari.</p>
      <button id="btn" type="button">Click me</button>
    </main>
    <script src="/main.js"></script>
  </body>
</html>
`,
      "public/styles.css": `body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0a0a0a; color: #ededed; }
main { text-align: center; padding: 2rem; }
button { padding: .6rem 1.2rem; border-radius: 8px; border: 1px solid #646cff; background: #646cff; color: #fff; font-size: 1rem; cursor: pointer; }
`,
      "public/main.js": `let n = 0;
const btn = document.getElementById('btn');
btn.addEventListener('click', () => { n++; btn.textContent = 'Clicked ' + n + '\\u00d7'; });
`,
    },
  };
}

// ── Bootstrap 5 (Vite) ───────────────────────────────────────────────────────
function bootstrapTemplate(): TemplateDef {
  return {
    manifest: {
      id: "bootstrap",
      framework: "bootstrap",
      icon: "bootstrap",
      category: "Frontend",
      name: "Bootstrap 5",
      language: "TypeScript",
      description: "Bootstrap 5 + Vite + TypeScript",
      port: 5173,
      openPath: "/",
      entry: "src/main.ts",
      hmr: true,
      reload: false,
      install: "npm install",
      dev: VITE_DEV,
    },
    files: {
      "package.json": `{
  "name": "bootstrap-app",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview" },
  "dependencies": { "bootstrap": "^5.3.3" },
  "devDependencies": { "typescript": "^5.7.0", "vite": "^8.0.0" }
}
`,
      "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + Bootstrap 5</title>
  </head>
  <body>
    <div id="app" class="container py-5"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
      "src/main.ts": `import 'bootstrap/dist/css/bootstrap.min.css'
import { Modal } from 'bootstrap'

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = \`
  <h1 class="mb-3">Vite + Bootstrap 5</h1>
  <p class="text-muted">Running inside Vivari.</p>
  <button class="btn btn-primary" id="open" type="button">Open modal</button>
  <div class="modal fade" id="demo" tabindex="-1">
    <div class="modal-dialog"><div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">Hello</h5></div>
      <div class="modal-body">Bootstrap's JS works too.</div>
      <div class="modal-footer"><button class="btn btn-secondary" data-bs-dismiss="modal" type="button">Close</button></div>
    </div></div>
  </div>
\`
const modal = new Modal('#demo')
document.querySelector('#open')!.addEventListener('click', () => modal.show())
`,
      "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "noEmit": true,
    "strict": true
  },
  "include": ["src"]
}
`,
    },
  };
}

// ── Three.js (Vite) ──────────────────────────────────────────────────────────
function threeTemplate(): TemplateDef {
  return {
    manifest: {
      id: "three",
      framework: "three",
      icon: "three",
      category: "Creative",
      name: "Three.js",
      language: "TypeScript",
      description: "Three.js + Vite — a spinning cube in WebGL",
      port: 5173,
      openPath: "/",
      entry: "src/main.ts",
      hmr: true,
      reload: false,
      install: "npm install",
      dev: VITE_DEV,
    },
    files: {
      "package.json": `{
  "name": "three-app",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview" },
  "dependencies": { "three": "^0.171.0" },
  "devDependencies": { "@types/three": "^0.171.0", "typescript": "^5.7.0", "vite": "^8.0.0" }
}
`,
      "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + Three.js</title>
    <style>body { margin: 0; overflow: hidden; background: #0a0a0a; }</style>
  </head>
  <body>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
      "src/main.ts": `import * as THREE from 'three'

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 100)
camera.position.z = 3

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(innerWidth, innerHeight)
renderer.setPixelRatio(devicePixelRatio)
document.body.appendChild(renderer.domElement)

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(),
  new THREE.MeshStandardMaterial({ color: 0x646cff }),
)
scene.add(cube)
scene.add(new THREE.HemisphereLight(0xffffff, 0x222233, 1.5))

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

renderer.setAnimationLoop((t) => {
  cube.rotation.x = t / 2000
  cube.rotation.y = t / 1000
  renderer.render(scene, camera)
})
`,
      "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "noEmit": true,
    "strict": true
  },
  "include": ["src"]
}
`,
    },
  };
}

// ── GreenSock (GSAP) + React (Vite) ──────────────────────────────────────────
function gsapReactTemplate(): TemplateDef {
  return {
    manifest: {
      id: "gsap-react",
      framework: "gsap",
      icon: "gsap",
      category: "Creative",
      name: "GSAP + React",
      language: "JavaScript",
      description: "GreenSock (GSAP) animation with React + Vite",
      port: 5173,
      openPath: "/",
      entry: "src/App.jsx",
      hmr: true,
      reload: false,
      install: "npm install",
      dev: VITE_DEV,
    },
    files: {
      "package.json": `{
  "name": "gsap-react",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview" },
  "dependencies": { "gsap": "^3.12.5", "react": "^19.0.0", "react-dom": "^19.0.0" },
  "devDependencies": { "@vitejs/plugin-react": "^5.0.0", "vite": "^8.0.0" }
}
`,
      "vite.config.js": reactViteConfig,
      "index.html": reactIndexHtml("jsx"),
      "src/index.css": VITE_INDEX_CSS,
      "src/main.jsx": reactMain(false),
      "src/App.jsx": `import { useRef, useEffect } from 'react'
import gsap from 'gsap'

export default function App() {
  const boxRef = useRef(null)
  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.to(boxRef.current, {
        rotation: 360, x: 120, borderRadius: '50%',
        repeat: -1, yoyo: true, duration: 1.5, ease: 'power1.inOut',
      })
    })
    return () => ctx.revert()
  }, [])
  return (
    <>
      <h1>GSAP + React</h1>
      <p>GreenSock animating a React element inside Vivari.</p>
      <div ref={boxRef} style={{ width: 80, height: 80, margin: '3rem auto', background: '#646cff' }} />
    </>
  )
}
`,
    },
  };
}

// ── Koa ──────────────────────────────────────────────────────────────────────
function koaTemplate(): TemplateDef {
  return {
    manifest: {
      id: "koa",
      framework: "koa",
      icon: "koa",
      category: "Backend",
      name: "Koa",
      language: "JavaScript",
      description: "Koa + @koa/router HTTP server on Node",
      port: 3000,
      openPath: "/",
      entry: "src/index.js",
      hmr: false,
      reload: false,
      install: "npm install",
      dev: "node src/index.js",
      // Graduated: plain Node HTTP server on the proven Express/Nest substrate,
      // gated by scripts/spike-koa.mjs.
    },
    files: {
      "package.json": `{
  "name": "koa-app",
  "private": true,
  "version": "1.0.0",
  "type": "commonjs",
  "scripts": { "start": "node src/index.js", "dev": "node src/index.js" },
  "dependencies": { "koa": "^2.15.3", "@koa/router": "^13.1.0" }
}
`,
      "src/index.js": `const Koa = require('koa');
const Router = require('@koa/router');

const app = new Koa();
const router = new Router();
const port = Number(process.env.PORT ?? 3000);

const html = ${JSON.stringify(backendDemoHtml("Koa"))};

router.get('/', (ctx) => { ctx.type = 'html'; ctx.body = html; });
router.get('/api/hello', (ctx) => { ctx.body = { message: 'Hello, world!' }; });

app.use(router.routes()).use(router.allowedMethods());
app.listen(port, () => console.log('Koa listening on http://localhost:' + port));
`,
    },
  };
}

// ── Hono (Node) ──────────────────────────────────────────────────────────────
function honoTemplate(): TemplateDef {
  return {
    manifest: {
      id: "hono",
      framework: "hono",
      icon: "hono",
      category: "Backend",
      name: "Hono",
      language: "JavaScript",
      description: "Hono on Node (@hono/node-server)",
      port: 3000,
      openPath: "/",
      entry: "src/index.js",
      hmr: false,
      reload: false,
      install: "npm install",
      dev: "node src/index.js",
      // Graduated: plain Node HTTP server on the proven Express/Nest substrate,
      // gated by scripts/spike-hono.mjs.
    },
    files: {
      "package.json": `{
  "name": "hono-app",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": { "start": "node src/index.js", "dev": "node src/index.js" },
  "dependencies": { "hono": "^4.6.0", "@hono/node-server": "^1.13.0" }
}
`,
      "src/index.js": `import { serve } from '@hono/node-server'
import { Hono } from 'hono'

const html = ${JSON.stringify(backendDemoHtml("Hono"))}

const app = new Hono()
app.get('/', (c) => c.html(html))
app.get('/api/hello', (c) => c.json({ message: 'Hello, world!' }))

const port = Number(process.env.PORT ?? 3000)
serve({ fetch: app.fetch, port }, (info) => {
  console.log('Hono listening on http://localhost:' + info.port)
})
`,
    },
  };
}

// ── H3 (unjs) ────────────────────────────────────────────────────────────────
function h3Template(): TemplateDef {
  return {
    manifest: {
      id: "h3",
      framework: "h3",
      icon: "h3",
      category: "Backend",
      name: "H3",
      language: "JavaScript",
      description: "H3 (unjs) HTTP server on Node",
      port: 3000,
      openPath: "/",
      entry: "src/index.js",
      hmr: false,
      reload: false,
      install: "npm install",
      dev: "node src/index.js",
      // Graduated: plain Node HTTP server on the proven Express/Nest substrate,
      // gated by scripts/spike-h3.mjs.
    },
    files: {
      "package.json": `{
  "name": "h3-app",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": { "start": "node src/index.js", "dev": "node src/index.js" },
  "dependencies": { "h3": "^1.13.0" }
}
`,
      "src/index.js": `import { createServer } from 'node:http'
import { createApp, createRouter, defineEventHandler, setResponseHeader, toNodeListener } from 'h3'

const html = ${JSON.stringify(backendDemoHtml("H3"))}

const app = createApp()
const router = createRouter()
router.get('/', defineEventHandler((event) => {
  setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
  return html
}))
router.get('/api/hello', defineEventHandler(() => ({ message: 'Hello, world!' })))
app.use(router)

const port = Number(process.env.PORT ?? 3000)
createServer(toNodeListener(app)).listen(port, () => {
  console.log('H3 listening on http://localhost:' + port)
})
`,
    },
  };
}

// ── Bun (Bun.serve + zero-config TypeScript) ─────────────────────────────────
// Runs on Vivari's Bun shim (packages/runtime/builtins/bun.js + programs/bun.js):
// the `bun` CLI runs the `.ts` entry with types stripped on the fly and the `Bun`
// global installed, and Bun.serve is bridged onto the same Node http preview path.
// `bun install` delegates to the real npm CLI (and writes a text bun.lock), so the
// init script (`bun install && bun run index.ts`) works even with no dependencies.
// Marked experimental: it is an API-compatible shim, not the native Bun binary.
function bunTemplate(): TemplateDef {
  return {
    manifest: {
      id: "bun",
      framework: "bun",
      icon: "bun",
      category: "Bun",
      name: "serve",
      language: "TypeScript",
      description: "Bun.serve HTTP server with zero-config TypeScript (Vivari Bun shim)",
      port: 3000,
      openPath: "/",
      entry: "index.ts",
      hmr: false,
      reload: false,
      install: "bun install",
      dev: "bun run index.ts",
      experimental: true,
      // Proven in-VM by scripts/spike-bun.mjs (bun run + Bun.serve + bun:test) and
      // scripts/spike-bun-offline.mjs (transform + Bun API), with `bun install`
      // delegation covered by scripts/spike-bun-install.mjs.
    },
    files: {
      "package.json": `{
  "name": "bun-app",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "module": "index.ts",
  "scripts": { "start": "bun run index.ts", "dev": "bun run index.ts" },
  "devDependencies": { "@types/bun": "latest" }
}
`,
      "tsconfig.json": `{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "react-jsx",
    "skipLibCheck": true
  }
}
`,
      "index.ts": `// A Bun starter running on Vivari's Bun shim. \`bun run\` strips the TS types
// on the fly and installs the \`Bun\` global; \`Bun.serve\` is previewed through the
// same proxy as any Node server. Edit away.
const html: string = ${JSON.stringify(backendDemoHtml("Bun"))};

const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  fetch(req: Request): Response {
    const url = new URL(req.url);
    if (url.pathname === "/api/hello") {
      return Response.json({ message: "Hello, world!", runtime: "bun", version: Bun.version });
    }
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

console.log("Bun listening on http://localhost:" + server.port);
`,
    },
  };
}

// Shared dark-theme page chrome for the Bun routing/websocket demos.
function bunPageStyles(): string {
  return `:root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        background: radial-gradient(1200px 600px at 50% -10%, #1b2333, #0a0a0a); color: #e5e7eb; padding: 2rem; }
      main { width: 100%; max-width: 620px; }
      .eyebrow { color: #7c9cff; font-size: .78rem; letter-spacing: .08em; text-transform: uppercase; margin: 0 0 .4rem; }
      h1 { margin: 0 0 .3rem; font-size: 1.85rem; }
      .sub { color: #9ca3af; margin: 0 0 1.5rem; line-height: 1.5; }
      .card { background: #10131a; border: 1px solid #232a36; border-radius: 14px; padding: 1.1rem 1.2rem; margin-bottom: 1rem; }
      .card h2 { margin: 0 0 .6rem; font-size: .95rem; }
      code { background: #1b212c; padding: .15rem .45rem; border-radius: 6px; color: #cbd5e1; font-size: .82rem; }
      label { display: block; color: #9ca3af; font-size: .78rem; margin: .5rem 0 .25rem; }
      input { width: 100%; padding: .5rem .6rem; border-radius: 8px; border: 1px solid #333; background: #0d0d0d; color: #ededed; }
      button { appearance: none; border: 0; cursor: pointer; margin-top: .7rem; padding: .55rem 1rem; font-size: .9rem; font-weight: 600;
        border-radius: 9px; color: #fff; background: linear-gradient(180deg, #4f7cff, #3b5cf0); transition: filter .15s; }
      button:hover { filter: brightness(1.08); }
      pre { margin: .6rem 0 0; background: #0b0e14; border: 1px solid #232a36; border-radius: 10px; padding: .75rem;
        overflow: auto; font-size: .8rem; line-height: 1.5; color: #d1d5db; max-height: 220px; }`;
}

// ── Bun (routing) ────────────────────────────────────────────────────────────
// Bun.serve({ routes }) on the Vivari Bun shim: static Response routes, :params,
// and * wildcards, matched by specificity; unmatched requests fall through to
// `fetch`. See https://bun.com/docs/runtime/http/routing
function bunRoutesTemplate(): TemplateDef {
  const HOME = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Bun routing · Vivari</title>
    <style>${bunPageStyles()}</style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Vivari · Bun.serve routes</p>
      <h1>Routing</h1>
      <p class="sub">Static, <code>:param</code>, and <code>*</code> wildcard routes, matched by specificity. Try them below.</p>
      <div class="card">
        <h2>Static · <code>GET /api/status</code></h2>
        <button data-get="/api/status">Call /api/status</button>
        <pre id="out-status">Response will appear here.</pre>
      </div>
      <div class="card">
        <h2>Param · <code>GET /api/users/:id</code></h2>
        <label for="uid">User id</label>
        <input id="uid" value="42" />
        <button id="btn-user">Call /api/users/&lt;id&gt;</button>
        <pre id="out-user">Response will appear here.</pre>
      </div>
      <div class="card">
        <h2>Wildcard · <code>GET /files/*</code></h2>
        <label for="fpath">File path</label>
        <input id="fpath" value="docs/readme.txt" />
        <button id="btn-file">Call /files/&lt;path&gt;</button>
        <pre id="out-file">Response will appear here.</pre>
      </div>
    </main>
    <script>
      (function () {
        // In the Vivari preview the page lives under /preview/<port>/. Prefix each
        // request with that explicit proxy path so it hits the SW's preview route.
        var pm = location.pathname.match(/^(\\/preview\\/\\d+)\\//);
        var base = pm ? pm[1] : '';
        function show(el, promise) {
          el.textContent = 'Loading…';
          promise
            .then(function (r) { return r.text().then(function (b) { return { r: r, b: b }; }); })
            .then(function (o) {
              var pretty = o.b;
              try { pretty = JSON.stringify(JSON.parse(o.b), null, 2); } catch (e) {}
              el.textContent = o.r.status + ' ' + o.r.statusText + '\\n\\n' + pretty;
            })
            .catch(function (e) { el.textContent = 'Request failed: ' + ((e && e.message) || e); });
        }
        document.querySelector('[data-get="/api/status"]').addEventListener('click', function () {
          show(document.getElementById('out-status'), fetch(base + '/api/status', { headers: { accept: 'application/json' } }));
        });
        document.getElementById('btn-user').addEventListener('click', function () {
          var id = encodeURIComponent(document.getElementById('uid').value || '');
          show(document.getElementById('out-user'), fetch(base + '/api/users/' + id, { headers: { accept: 'application/json' } }));
        });
        document.getElementById('btn-file').addEventListener('click', function () {
          var p = (document.getElementById('fpath').value || '').replace(/^\\/+/, '');
          show(document.getElementById('out-file'), fetch(base + '/files/' + p));
        });
      })();
    </script>
  </body>
</html>
`;
  return {
    manifest: {
      id: "bun-routes",
      framework: "bun",
      icon: "bun",
      category: "Bun",
      name: "routing",
      language: "TypeScript",
      description: "Bun.serve routes: static, :params, and * wildcards with a fetch fallback",
      port: 3000,
      openPath: "/",
      entry: "index.ts",
      hmr: false,
      reload: false,
      install: "bun install",
      dev: "bun run index.ts",
      experimental: true,
      // Route matching proven by scripts/spike-bun-offline.mjs (matcher unit) and
      // scripts/spike-bun.mjs (in-VM Bun.serve routing round-trip).
    },
    files: {
      "package.json": `{
  "name": "bun-routes-app",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "module": "index.ts",
  "scripts": { "start": "bun run index.ts", "dev": "bun run index.ts" },
  "devDependencies": { "@types/bun": "latest" }
}
`,
      "tsconfig.json": `{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true
  }
}
`,
      "index.ts": `// Bun.serve routing on Vivari's Bun shim. Routes are matched by specificity:
// exact > :param > * wildcard > global /*. Anything unmatched falls through to
// the \`fetch\` handler. Docs: https://bun.com/docs/runtime/http/routing
const HOME: string = ${JSON.stringify(HOME)};

const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  routes: {
    // A static Response (in native Bun these are optimized for zero-alloc dispatch).
    "/api/status": Response.json({ ok: true, runtime: "bun", version: Bun.version }),

    // Exact route wins over the :id param route below.
    "/api/users/me": () => Response.json({ id: "me", name: "Ada Lovelace" }),

    // Param route — req.params.id is percent-decoded for you.
    "/api/users/:id": (req) => Response.json({ id: req.params.id, name: "User " + req.params.id }),

    // Wildcard — matches /files/anything/here.
    "/files/*": (req) => {
      const rest = new URL(req.url).pathname.replace(/^\\/files\\//, "");
      return new Response("You requested file: " + rest + "\\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    },

    // The demo UI.
    "/": () => new Response(HOME, { headers: { "content-type": "text/html; charset=utf-8" } }),
  },
  // Runs only for requests no route matched.
  fetch(req) {
    return new Response("404 Not Found: " + new URL(req.url).pathname + "\\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
});

console.log("Bun routing demo on http://localhost:" + server.port);
`,
    },
  };
}

// ── Bun (websocket) ──────────────────────────────────────────────────────────
// Bun.serve({ websocket }) on the Vivari Bun shim: the fetch handler upgrades via
// server.upgrade(req); the server does a real RFC-6455 handshake + framing over
// the Node http `upgrade` event, and pub/sub broadcasts reach every subscriber.
// The browser preview reaches the in-VM ws server through Vivari's WebSocket
// tunnel. See https://bun.com/docs/runtime/http/websockets
function bunWebSocketTemplate(): TemplateDef {
  const HOME = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Bun WebSocket · Vivari</title>
    <style>${bunPageStyles()}
      .log { list-style: none; padding: 0; margin: .6rem 0 0; max-height: 240px; overflow: auto; }
      .log li { padding: .35rem .5rem; border-radius: 8px; margin: .25rem 0; font-size: .84rem; }
      .log li.system { color: #93c5fd; background: #0b1220; }
      .log li.chat { color: #e5e7eb; background: #0e1520; }
      .row { display: flex; gap: .5rem; align-items: flex-end; }
      .row input { flex: 1; }
      .dot { display: inline-block; width: .55rem; height: .55rem; border-radius: 50%; background: #ef4444; margin-right: .4rem; }
      .dot.on { background: #22c55e; }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Vivari · Bun.serve websocket</p>
      <h1>WebSocket chat</h1>
      <p class="sub"><span id="dot" class="dot"></span><span id="status">connecting…</span> — messages are broadcast to every connected client via <code>server.publish</code>.</p>
      <div class="card">
        <div class="row">
          <div style="flex:1">
            <label for="msg">Message</label>
            <input id="msg" placeholder="Type and press Enter" />
          </div>
          <button id="send">Send</button>
        </div>
        <ul id="log" class="log"></ul>
      </div>
    </main>
    <script>
      (function () {
        var pm = location.pathname.match(/^(\\/preview\\/\\d+)\\//);
        var base = pm ? pm[1] : '';
        var scheme = location.protocol === 'https:' ? 'wss' : 'ws';
        var ws = new WebSocket(scheme + '://' + location.host + base + '/ws');
        var log = document.getElementById('log');
        var statusEl = document.getElementById('status');
        var dot = document.getElementById('dot');
        function add(kind, text) {
          var li = document.createElement('li');
          li.className = kind;
          li.textContent = text;
          log.appendChild(li);
          log.scrollTop = log.scrollHeight;
        }
        ws.onopen = function () { statusEl.textContent = 'connected'; dot.className = 'dot on'; };
        ws.onclose = function () { statusEl.textContent = 'disconnected'; dot.className = 'dot'; };
        ws.onerror = function () { statusEl.textContent = 'error'; };
        ws.onmessage = function (ev) {
          var m; try { m = JSON.parse(ev.data); } catch (e) { m = { type: 'chat', text: String(ev.data) }; }
          add(m.type === 'system' ? 'system' : 'chat', (m.type === 'chat' ? '› ' : '') + m.text);
        };
        function send() {
          var input = document.getElementById('msg');
          var v = (input.value || '').trim();
          if (!v || ws.readyState !== WebSocket.OPEN) return;
          ws.send(v);
          input.value = '';
        }
        document.getElementById('send').addEventListener('click', send);
        document.getElementById('msg').addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });
      })();
    </script>
  </body>
</html>
`;
  return {
    manifest: {
      id: "bun-ws",
      framework: "bun",
      icon: "bun",
      category: "Bun",
      name: "websocket",
      language: "TypeScript",
      description: "Bun.serve WebSocket chat with server.upgrade + pub/sub broadcast",
      port: 3000,
      openPath: "/",
      entry: "index.ts",
      hmr: false,
      reload: false,
      install: "bun install",
      dev: "bun run index.ts",
      experimental: true,
      // Proven by scripts/spike-bun.mjs (in-VM WebSocket client vs the shim's
      // Bun.serve ws server: open, echo, server.publish broadcast, close).
    },
    files: {
      "package.json": `{
  "name": "bun-ws-app",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "module": "index.ts",
  "scripts": { "start": "bun run index.ts", "dev": "bun run index.ts" },
  "devDependencies": { "@types/bun": "latest" }
}
`,
      "tsconfig.json": `{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true
  }
}
`,
      "index.ts": `// Bun.serve WebSockets on Vivari's Bun shim. The \`fetch\` handler upgrades the
// request via server.upgrade(req); socket lifecycle + messages are handled once
// in the \`websocket\` object, and server.publish broadcasts to every subscriber
// of a topic. Docs: https://bun.com/docs/runtime/http/websockets
const HOME: string = ${JSON.stringify(HOME)};

const port = Number(process.env.PORT ?? 3000);
let online = 0;

const server = Bun.serve({
  port,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      // Upgrade to a WebSocket; on success return nothing (no Response).
      if (server.upgrade(req)) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    return new Response(HOME, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
  websocket: {
    open(ws) {
      online++;
      ws.subscribe("chat");
      ws.send(JSON.stringify({ type: "system", text: "welcome — connected to the Bun server" }));
      server.publish("chat", JSON.stringify({ type: "system", text: "a client joined (" + online + " online)" }));
    },
    message(ws, message) {
      const text = typeof message === "string" ? message : "(binary message)";
      // Broadcast to every subscriber of "chat" (including the sender).
      server.publish("chat", JSON.stringify({ type: "chat", text }));
    },
    close() {
      online = Math.max(0, online - 1);
      server.publish("chat", JSON.stringify({ type: "system", text: "a client left (" + online + " online)" }));
    },
  },
});

console.log("Bun websocket demo on http://localhost:" + server.port);
`,
    },
  };
}

// ── React (Bun) ──────────────────────────────────────────────────────────────
// A client-rendered React SPA served by Bun.serve on the Vivari Bun shim. There
// is no client bundler in the shim, so: index.html pulls React from a CDN via an
// importmap, and the server transpiles app.tsx on the fly (Bun.Transpiler / the
// shim's zero-config TS+JSX transform) and serves it as an ES module at /app.js.
// Needs internet in the preview for esm.sh (same assumption as `bun install`).
function bunReactTemplate(): TemplateDef {
  const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>React + Bun · Vivari</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        background: radial-gradient(1200px 600px at 50% -10%, #1b2333, #0a0a0a); color: #e5e7eb; }
    </style>
    <script type="importmap">
      {
        "imports": {
          "react": "https://esm.sh/react@18.3.1",
          "react/jsx-runtime": "https://esm.sh/react@18.3.1/jsx-runtime",
          "react-dom": "https://esm.sh/react-dom@18.3.1?external=react",
          "react-dom/client": "https://esm.sh/react-dom@18.3.1/client?external=react"
        }
      }
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./app.js"></script>
  </body>
</html>
`;
  return {
    manifest: {
      id: "bun-react",
      framework: "bun",
      icon: "bun",
      category: "Bun",
      name: "React",
      language: "TypeScript",
      description: "Client-rendered React + TS SPA served by Bun.serve; app.tsx transpiled on the fly",
      port: 3000,
      openPath: "/",
      entry: "app.tsx",
      hmr: false,
      reload: false,
      install: "bun install",
      dev: "bun run index.ts",
      experimental: true,
      // app.tsx transpile + parse is covered by scripts/spike-bun-offline.mjs; the
      // Bun.serve host path is the same one proven by scripts/spike-bun.mjs.
    },
    files: {
      "package.json": `{
  "name": "bun-react-app",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "module": "index.ts",
  "scripts": { "start": "bun run index.ts", "dev": "bun run index.ts" },
  "devDependencies": { "@types/bun": "latest", "@types/react": "^18", "@types/react-dom": "^18" }
}
`,
      "tsconfig.json": `{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "react",
    "skipLibCheck": true
  }
}
`,
      "index.ts": `// Bun.serve host for the React SPA. The shim has no client bundler, so the server
// transpiles app.tsx on the fly (Bun.Transpiler) and serves it as an ES module;
// React itself is loaded in the browser from a CDN via the importmap in index.html.
const INDEX_HTML: string = ${JSON.stringify(INDEX_HTML)};

const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  routes: {
    // Transpile TSX -> JS on demand and serve as an ES module (types stripped,
    // JSX lowered to React.createElement). Imports stay bare for the importmap.
    "/app.js": () => {
      const src = require("fs").readFileSync("app.tsx", "utf8");
      const js = new Bun.Transpiler({ loader: "tsx" }).transformSync(src);
      return new Response(js, { headers: { "content-type": "application/javascript; charset=utf-8" } });
    },
    "/": () => new Response(INDEX_HTML, { headers: { "content-type": "text/html; charset=utf-8" } }),
  },
});

console.log("React + Bun on http://localhost:" + server.port);
`,
      "app.tsx": `import React, { useState } from "react";
import { createRoot } from "react-dom/client";

type CounterProps = { start: number };

function Counter({ start }: CounterProps) {
  const [count, setCount] = useState<number>(start);
  return (
    <button
      onClick={() => setCount((c) => c + 1)}
      style={{
        appearance: "none",
        border: 0,
        cursor: "pointer",
        padding: "0.6rem 1.2rem",
        fontSize: "1rem",
        fontWeight: 600,
        borderRadius: 10,
        color: "#fff",
        background: "linear-gradient(180deg, #4f7cff, #3b5cf0)",
      }}
    >
      count is {count}
    </button>
  );
}

function App() {
  return (
    <main style={{ textAlign: "center", padding: "2rem", maxWidth: 640 }}>
      <h1 style={{ margin: "0 0 0.4rem", fontSize: "2rem" }}>React + Bun</h1>
      <p style={{ color: "#9ca3af", margin: "0 0 1.5rem", lineHeight: 1.5 }}>
        Client-rendered React written in TypeScript. Vivari's Bun shim transpiles this
        file on the fly; React is loaded from a CDN via an importmap. Edit and reload.
      </p>
      <Counter start={0} />
    </main>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
`,
    },
  };
}

// ── Node.js (blank) ──────────────────────────────────────────────────────────
function nodeTemplate(): TemplateDef {
  return {
    manifest: {
      id: "node",
      framework: "node",
      icon: "node",
      category: "Tooling",
      name: "Node.js",
      language: "JavaScript",
      description: "A blank Node.js project with a minimal HTTP server",
      port: 3000,
      openPath: "/",
      entry: "index.js",
      hmr: false,
      reload: false,
      install: "npm install",
      dev: "node index.js",
    },
    files: {
      "package.json": `{
  "name": "node-app",
  "private": true,
  "version": "1.0.0",
  "type": "commonjs",
  "scripts": { "start": "node index.js", "dev": "node index.js" }
}
`,
      "index.js": `// A blank Node.js starter — no dependencies. Edit away.
const http = require('http');

const port = Number(process.env.PORT ?? 3000);
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ hello: 'world', url: req.url, node: process.version }));
});
server.listen(port, () => console.log('Node server on http://localhost:' + port));
`,
    },
  };
}

// ── Native: Python (CPython via Pyodide) ─────────────────────────────────────
// Python runs on CPython compiled to WebAssembly (Pyodide), booted lazily by the
// in-VM `python` program the first time it runs — nothing Python-related loads at
// studio boot. These are terminal-first (stdout) templates: Pyodide has no real
// sockets, so there is no dev server / preview. See packages/runtime/builtins/python.js.
function pythonTemplate(): TemplateDef {
  return {
    manifest: {
      id: "python",
      framework: "python",
      icon: "python",
      category: "Native",
      name: "Python",
      language: "Python",
      description: "A Python script on CPython (Pyodide) — runs in the terminal",
      // No server: Pyodide can't listen. The port is unused (nothing binds it).
      port: 8000,
      openPath: "/",
      entry: "main.py",
      hmr: false,
      reload: false,
      // `python --version` is instant and does NOT boot Pyodide; the dev command
      // boots it on first run. (No npm/pip dependencies for this starter.)
      install: "python --version",
      dev: "python main.py",
    },
    files: {
      "main.py": `# A blank Python starter running on CPython (Pyodide) in your browser.
# Edit away — output prints to the terminal.
import sys


def main() -> None:
    print("Hello from Python!")
    print(f"Running {sys.version.split()[0]} on {sys.platform} (Pyodide)")


if __name__ == "__main__":
    main()
`,
      "README.md": `# Python starter

Runs on **CPython compiled to WebAssembly** (Pyodide), entirely in your browser.

\`\`\`bash
python main.py        # run the script
python -c "print(1+1)"  # run an inline program
python                # start a REPL
\`\`\`

The Pyodide runtime is loaded lazily the first time you run \`python\`, so it
never slows down the rest of the studio.
`,
    },
  };
}

// ── Native: Python data science (NumPy + pandas via Pyodide) ─────────────────
function pythonDataScienceTemplate(): TemplateDef {
  return {
    manifest: {
      id: "python-data",
      framework: "python",
      icon: "python",
      category: "Native",
      name: "Data Science",
      language: "Python",
      description: "NumPy + pandas in the browser via Pyodide — prebuilt wheels, no server",
      port: 8000,
      openPath: "/",
      entry: "main.py",
      hmr: false,
      reload: false,
      // Prebuilt NumPy/pandas wheels ship with the vendored Pyodide and also
      // auto-load from the script's imports; this makes the install step explicit.
      install: "python -m pip install -r requirements.txt",
      dev: "python main.py",
      experimental: true,
    },
    files: {
      "requirements.txt": `numpy
pandas
`,
      "main.py": `# NumPy + pandas running on Pyodide (prebuilt WASM wheels).
# The vendored wheels load automatically from your imports.
import numpy as np
import pandas as pd


def main() -> None:
    arr = np.arange(1, 11)
    print("numpy array:", arr)
    print("mean:", arr.mean(), "std:", round(float(arr.std()), 3))

    df = pd.DataFrame({"x": arr, "x_squared": arr ** 2})
    print()
    print(df.to_string(index=False))


if __name__ == "__main__":
    main()
`,
      "README.md": `# Python data science starter

NumPy and pandas run on **Pyodide** (prebuilt WebAssembly wheels), entirely in
your browser — no server, no native build.

\`\`\`bash
python -m pip install -r requirements.txt   # loads the vendored wheels
python main.py
\`\`\`

Packages are also auto-loaded from your \`import\` statements, so \`python main.py\`
works even without the install step.
`,
    },
  };
}

// ── Native: Python plotting (Matplotlib via Pyodide) ─────────────────────────
function pythonMatplotlibTemplate(): TemplateDef {
  return {
    manifest: {
      id: "python-matplotlib",
      framework: "python",
      icon: "python",
      category: "Native",
      name: "Matplotlib",
      language: "Python",
      description: "Matplotlib plotting via Pyodide — renders a PNG you open in the editor (no server)",
      port: 8000,
      openPath: "/",
      // plot.png doesn't exist until the script runs, so open the source; the
      // README explains opening the generated image.
      entry: "main.py",
      hmr: false,
      reload: false,
      install: "python -m pip install -r requirements.txt",
      dev: "python main.py",
      experimental: true,
    },
    files: {
      "requirements.txt": `matplotlib
numpy
`,
      "main.py": `# Matplotlib running on Pyodide (prebuilt WASM wheels).
# The runtime is a Web Worker with no DOM, so we use the file-based "Agg"
# backend and render the figure to a PNG — then open it in the editor.
import matplotlib

matplotlib.use("Agg")  # headless: draw to an image file, not a window

import matplotlib.pyplot as plt
import numpy as np

OUT = "plot.png"


def main() -> None:
    x = np.linspace(0, 2 * np.pi, 400)

    fig, ax = plt.subplots(figsize=(8, 4.5), dpi=120)
    ax.plot(x, np.sin(x), label="sin(x)")
    ax.plot(x, np.cos(x), label="cos(x)")
    ax.set_title("Matplotlib on Pyodide")
    ax.set_xlabel("x")
    ax.set_ylabel("y")
    ax.legend()
    ax.grid(True, alpha=0.3)

    fig.savefig(OUT, bbox_inches="tight")
    print(f"Saved {OUT} — open it in the editor to view the chart.")


if __name__ == "__main__":
    main()
`,
      "README.md": `# Python plotting starter (Matplotlib)

Matplotlib runs on **Pyodide** (prebuilt WebAssembly wheels), entirely in your
browser — no server, no native build.

\`\`\`bash
python -m pip install -r requirements.txt   # loads the vendored wheels
python main.py                              # renders plot.png
\`\`\`

The Python process runs in a Web Worker with **no DOM**, so there is no
interactive plot window. Instead the script uses Matplotlib's headless \`Agg\`
backend and saves the figure to \`plot.png\`, which you can open in the editor
(the studio renders images inline).
`,
    },
  };
}

// ── Native: FastAPI (ASGI on Pyodide) ────────────────────────────────────────
// A real Python web server running on CPython/WASM. Pyodide has no sockets, so
// `uvicorn` here is a Vivari shim: the `python` launcher boots Pyodide, imports
// the ASGI app, and bridges it to a guest Node http server on the port — which
// registers with the kernel exactly like an Express app, so the preview opens.
// See packages/runtime/builtins/python.js + packages/kernel-host/programs/python.js.
function fastapiTemplate(): TemplateDef {
  return {
    manifest: {
      id: "fastapi",
      framework: "fastapi",
      icon: "fastapi",
      category: "Native",
      name: "FastAPI",
      language: "Python",
      description: "A FastAPI (ASGI) app on CPython/WASM (Pyodide) with a live browser preview",
      port: 8000,
      openPath: "/",
      entry: "main.py",
      hmr: false,
      reload: false,
      install: "python -m pip install -r requirements.txt",
      dev: "uvicorn main:app --port 8000",
      experimental: true,
    },
    files: {
      "requirements.txt": `fastapi
`,
      "main.py": `# FastAPI running on CPython compiled to WebAssembly (Pyodide), served entirely
# in your browser. Vivari bridges this ASGI app to the preview — no real server.
from fastapi import FastAPI
from fastapi.responses import HTMLResponse

app = FastAPI()


# Endpoints are async so they run directly on the event loop. Pyodide has no OS
# threads, so a *sync* def would otherwise be dispatched to a threadpool (Vivari
# already patches that to run inline, but async is the idiomatic choice here).
# Links are relative so navigating stays inside the preview (/preview/<port>/…).
@app.get("/", response_class=HTMLResponse)
async def index() -> str:
    return """
    <!doctype html>
    <html>
      <head><title>FastAPI on Pyodide</title></head>
      <body style="font-family: system-ui, sans-serif; padding: 2rem; line-height: 1.6;">
        <h1>FastAPI running on Pyodide</h1>
        <p>This ASGI app runs entirely in your browser.</p>
        <p>Try the JSON API: <a href="api/hello?name=Vivari">/api/hello</a></p>
        <p>Interactive docs: <a href="docs">/docs</a></p>
      </body>
    </html>
    """


@app.get("/api/hello")
async def hello(name: str = "world"):
    return {"message": f"Hello, {name}!", "framework": "FastAPI"}
`,
      "README.md": `# FastAPI starter (Pyodide)

A real **FastAPI** (ASGI) app running on **CPython compiled to WebAssembly**
(Pyodide), entirely in your browser.

\`\`\`bash
python -m pip install -r requirements.txt   # loads FastAPI (vendored/CDN wheels)
uvicorn main:app --port 8000                # serves the app + opens the preview
\`\`\`

Pyodide has no real sockets, so \`uvicorn\` here is a Vivari shim: it boots
Pyodide, imports \`main:app\`, and bridges each preview request through the ASGI
protocol. Requests and responses are buffered (no streaming/WebSocket yet).
`,
    },
  };
}

// ── Native: Flask (WSGI on Pyodide) ──────────────────────────────────────────
// Like the FastAPI template, but WSGI. Flask is not in Pyodide's prebuilt wheel
// set, so it installs from PyPI via micropip at runtime (needs network in the
// browser). `flask run` is a Vivari shim over the same guest-http bridge.
function flaskTemplate(): TemplateDef {
  return {
    manifest: {
      id: "flask",
      framework: "flask",
      icon: "flask",
      category: "Native",
      name: "Flask",
      language: "Python",
      description: "A Flask (WSGI) app on CPython/WASM (Pyodide) with a live browser preview",
      port: 8000,
      openPath: "/",
      entry: "main.py",
      hmr: false,
      reload: false,
      install: "python -m pip install -r requirements.txt",
      dev: "flask --app main run --port 8000",
      experimental: true,
    },
    files: {
      "requirements.txt": `flask
`,
      "main.py": `# Flask running on CPython compiled to WebAssembly (Pyodide), served entirely in
# your browser. Vivari bridges this WSGI app to the preview — no real server.
from flask import Flask, jsonify, request

app = Flask(__name__)


# The link is relative ("api/hello", not "/api/hello") so clicking it navigates
# WITHIN the preview (/preview/<port>/api/hello). A root-absolute link would
# escape the preview frame back to the studio.
@app.get("/")
def index() -> str:
    return """
    <!doctype html>
    <html>
      <head><title>Flask on Pyodide</title></head>
      <body style="font-family: system-ui, sans-serif; padding: 2rem; line-height: 1.6;">
        <h1>Flask running on Pyodide</h1>
        <p>This WSGI app runs entirely in your browser.</p>
        <p>Try the JSON API: <a href="api/hello?name=Vivari">/api/hello</a></p>
      </body>
    </html>
    """


@app.get("/api/hello")
def hello():
    name = request.args.get("name", "world")
    return jsonify(message=f"Hello, {name}!", framework="Flask")
`,
      "README.md": `# Flask starter (Pyodide)

A real **Flask** (WSGI) app running on **CPython compiled to WebAssembly**
(Pyodide), entirely in your browser.

\`\`\`bash
python -m pip install -r requirements.txt   # installs Flask from PyPI (micropip)
flask --app main run --port 8000            # serves the app + opens the preview
\`\`\`

Flask is not part of Pyodide's prebuilt wheel set, so it is installed from PyPI
via **micropip** the first time it runs — this needs network access in the
browser. Pyodide has no real sockets, so \`flask run\` is a Vivari shim that
bridges each preview request through the WSGI protocol (buffered, no streaming).
`,
    },
  };
}

// ── Server-Sent Events (Express) ─────────────────────────────────────────────
function sseTemplate(): TemplateDef {
  return {
    manifest: {
      id: "sse",
      framework: "sse",
      icon: "sse",
      category: "Showcase",
      name: "Server-Sent Events",
      language: "JavaScript",
      description: "Express streaming live updates to the browser via EventSource (multiplexed named events + live chart)",
      port: 3000,
      openPath: "/",
      entry: "server/index.js",
      hmr: false,
      reload: false,
      install: "npm install",
      dev: "node server/index.js",
      // Proven in-VM by scripts/spike-sse.mjs (green in CI): SSE streams over the
      // vv-sse tunnel + EventSource polyfill (the buffered HTTP preview proxy can't
      // carry a never-ending text/event-stream body). No longer experimental.
    },
    files: {
      "package.json": `{
  "name": "sse-demo",
  "private": true,
  "version": "0.0.0",
  "type": "commonjs",
  "scripts": { "start": "node server/index.js", "dev": "node server/index.js" },
  "dependencies": { "express": "^4.21.0" }
}
`,
      "server/index.js": `const express = require('express');
const path = require('path');

const app = express();
const port = Number(process.env.PORT ?? 3000);

// One SSE endpoint multiplexing several named event types onto a single stream:
//   (default) message -> a per-second tick { n, time }
//   metric            -> a random gauge value { value } for the live chart
//   notice            -> occasional log lines { level, text }
app.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  // Tell EventSource clients how long to wait before reconnecting after a drop.
  res.write('retry: 2000\\n\\n');

  let n = 0;
  const send = (event, data) => {
    if (event) res.write('event: ' + event + '\\n');
    res.write('id: ' + Date.now() + '\\n');
    res.write('data: ' + JSON.stringify(data) + '\\n\\n');
  };

  // Prime the client immediately so nothing looks idle on connect.
  send('notice', { level: 'info', text: 'stream opened' });
  send(null, { n: n, time: new Date().toISOString() });
  send('metric', { value: 50 });

  const tick = setInterval(() => {
    n++;
    send(null, { n: n, time: new Date().toISOString() });
    send('metric', { value: Math.round(20 + Math.random() * 80) });
    if (n % 5 === 0) send('notice', { level: 'ok', text: 'processed batch #' + n / 5 });
  }, 1000);

  // A comment line keeps intermediaries from idling the connection out.
  const beat = setInterval(() => res.write(': keep-alive\\n\\n'), 15000);

  req.on('close', () => { clearInterval(tick); clearInterval(beat); });
});

app.use(express.static(path.join(__dirname, '..', 'public')));
app.listen(port, () => console.log('SSE demo on http://localhost:' + port));
`,
      "public/index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Server-Sent Events</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body { font-family: system-ui, sans-serif; margin: 0; padding: 2.5rem; background: #0a0a0a; color: #ededed; }
      main { max-width: 720px; margin: 0 auto; }
      header { display: flex; align-items: center; gap: .75rem; }
      h1 { margin: 0; font-size: 1.5rem; }
      .sub { color: #9ca3af; margin: .35rem 0 1.25rem; }
      .pill { display: inline-flex; align-items: center; gap: .4rem; font-size: .75rem; padding: .25rem .6rem; border-radius: 999px; background: #1f2937; color: #9ca3af; }
      .pill .dot { width: .5rem; height: .5rem; border-radius: 999px; background: #6b7280; }
      .pill.live { background: #052e1a; color: #4ade80; } .pill.live .dot { background: #22c55e; }
      .pill.off { background: #3f1d1d; color: #f87171; } .pill.off .dot { background: #ef4444; }
      .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem; }
      .card { background: #111; border: 1px solid #1f2937; border-radius: 12px; padding: 1rem 1.1rem; }
      .card .k { color: #9ca3af; font-size: .78rem; } .card .v { font-size: 1.7rem; font-weight: 600; margin-top: .2rem; }
      .chart { display: flex; align-items: flex-end; gap: 3px; height: 90px; margin-top: .6rem; }
      .chart .bar { flex: 1; min-width: 2px; background: linear-gradient(#60a5fa, #2563eb); border-radius: 2px 2px 0 0; transition: height .3s ease; }
      .bar-wrap { background: #111; border: 1px solid #1f2937; border-radius: 12px; padding: 1rem 1.1rem; margin-bottom: 1rem; }
      .controls { display: flex; gap: .5rem; margin-bottom: 1rem; }
      button { padding: .5rem .9rem; border-radius: 8px; border: 1px solid #333; background: #1a1a1a; color: #ededed; cursor: pointer; }
      button:hover { border-color: #555; }
      #log { font-family: ui-monospace, monospace; font-size: .8rem; background: #0d0d0d; border: 1px solid #1f2937; border-radius: 12px; padding: .8rem 1rem; height: 180px; overflow: auto; }
      #log div { padding: .1rem 0; color: #cbd5e1; }
      #log .ok { color: #4ade80; } #log .info { color: #93c5fd; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>Server-Sent Events</h1>
        <span class="pill" id="status"><span class="dot"></span><span id="statusText">connecting…</span></span>
      </header>
      <p class="sub">One Express endpoint streams three multiplexed event types over a single connection — no polling.</p>

      <div class="cards">
        <div class="card"><div class="k">Ticks received (default event)</div><div class="v" id="count">0</div></div>
        <div class="card"><div class="k">Server time</div><div class="v" id="clock" style="font-size:1.15rem">—</div></div>
      </div>

      <div class="bar-wrap">
        <div class="k" style="color:#9ca3af;font-size:.78rem">Live metric (named "metric" event)</div>
        <div class="chart" id="chart"></div>
      </div>

      <div class="controls">
        <button id="toggle">Pause</button>
        <button id="clear">Clear log</button>
      </div>

      <div id="log"></div>
    </main>
    <script>
      var countEl = document.getElementById('count');
      var clockEl = document.getElementById('clock');
      var chartEl = document.getElementById('chart');
      var logEl = document.getElementById('log');
      var statusEl = document.getElementById('status');
      var statusText = document.getElementById('statusText');
      var toggleBtn = document.getElementById('toggle');
      var clearBtn = document.getElementById('clear');

      var BARS = 40;
      var values = [];
      for (var i = 0; i < BARS; i++) { var b = document.createElement('div'); b.className = 'bar'; b.style.height = '0%'; chartEl.appendChild(b); values.push(0); }

      function setStatus(state, text) {
        statusEl.className = 'pill' + (state ? ' ' + state : '');
        statusText.textContent = text;
      }
      function log(cls, text) {
        var d = document.createElement('div');
        if (cls) d.className = cls;
        d.textContent = new Date().toLocaleTimeString() + '  ' + text;
        logEl.insertBefore(d, logEl.firstChild);
        while (logEl.childElementCount > 200) logEl.removeChild(logEl.lastChild);
      }
      function pushMetric(v) {
        values.push(v); values.shift();
        var bars = chartEl.children;
        for (var i = 0; i < bars.length; i++) bars[i].style.height = values[i] + '%';
      }

      var es = null;
      function connect() {
        es = new EventSource('/events');
        setStatus('', 'connecting…');
        es.onopen = function () { setStatus('live', 'live'); };
        es.onerror = function () { setStatus('off', 'reconnecting…'); };
        // Default (unnamed) event → the per-second tick.
        es.onmessage = function (e) {
          var d = JSON.parse(e.data);
          countEl.textContent = d.n;
          clockEl.textContent = new Date(d.time).toLocaleTimeString();
        };
        // Named "metric" event → the live chart.
        es.addEventListener('metric', function (e) { pushMetric(JSON.parse(e.data).value); });
        // Named "notice" event → the log.
        es.addEventListener('notice', function (e) { var d = JSON.parse(e.data); log(d.level, d.text); });
      }
      function disconnect() { if (es) { es.close(); es = null; } setStatus('off', 'paused'); }

      toggleBtn.addEventListener('click', function () {
        if (es) { disconnect(); toggleBtn.textContent = 'Resume'; }
        else { connect(); toggleBtn.textContent = 'Pause'; }
      });
      clearBtn.addEventListener('click', function () { logEl.innerHTML = ''; });

      connect();
    </script>
  </body>
</html>
`,
    },
  };
}

// ── Fullstack: React (Vite) + Express API (two preview tabs) ─────────────────
// Mirrors the WebSocket demo's process model: one `dev` run starts BOTH an
// Express JSON API (:3001) and the Vite frontend (:5173); each listening port
// gets its own preview tab. The frontend reaches the API cross-service through
// the studio's preview proxy at /preview/3001/ (no CORS, no manual proxy).
function fullstackTemplate(): TemplateDef {
  return {
    manifest: {
      id: "fullstack",
      framework: "fullstack",
      icon: "fullstack",
      category: "Showcase",
      name: "Vite + Express",
      language: "JavaScript",
      description: "React (Vite :5173) calling an Express JSON API (:3001) — two live preview tabs",
      port: 5173,
      openPath: "/",
      entry: "src/App.jsx",
      hmr: true,
      reload: false,
      // Two intentional user-facing servers (API :3001 + frontend :5173) → a tab each.
      multiPreview: true,
      install: "npm install",
      dev: "node dev.js",
    },
    files: {
      "package.json": `{
  "name": "fullstack-vite-express",
  "private": true,
  "version": "0.0.0",
  "scripts": {
    "dev": "node dev.js",
    "server": "node server/index.js",
    "client": "vite --configLoader native --port 5173 --strictPort"
  },
  "dependencies": { "express": "^4.21.0", "react": "^19.0.0", "react-dom": "^19.0.0" },
  "devDependencies": { "@vitejs/plugin-react": "^5.0.0", "vite": "^8.0.0" }
}
`,
      "dev.js": `const { spawn } = require('child_process');

const procs = [];
let exiting = false;
function run(label, cmd, args) {
  const child = spawn(cmd, args, { stdio: 'inherit' });
  procs.push(child);
  child.on('exit', (code) => {
    if (exiting) return;
    exiting = true;
    console.log('[dev] ' + label + ' exited (' + code + ') — stopping the other server.');
    for (const p of procs) { if (p !== child) { try { p.kill(); } catch (e) {} } }
    process.exit(code || 0);
  });
}

console.log('[dev] starting API (:3001) and frontend (:5173)…');
run('api', 'node', ['server/index.js']);
run('frontend', 'npm', ['run', 'client']);
`,
      "vite.config.js": `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
})
`,
      "index.html": reactIndexHtml("jsx"),
      "src/index.css": VITE_INDEX_CSS,
      "src/main.jsx": reactMain(false),
      "src/App.jsx": `import { useEffect, useState } from 'react'

const API_PORT = 3001
// Cross-service: the studio's preview proxy maps /preview/<port>/ to that in-VM
// server, so the frontend reaches the Express API with no CORS and no proxy.
const API = '/preview/' + API_PORT + '/api'

export default function App() {
  const [msg, setMsg] = useState('loading…')
  useEffect(() => {
    fetch(API + '/hello')
      .then((r) => r.json())
      .then((d) => setMsg(d.message))
      .catch((e) => setMsg('error: ' + e))
  }, [])
  return (
    <>
      <h1>Vite + Express fullstack</h1>
      <p>Frontend (:5173) fetched from the Express API (:{API_PORT}):</p>
      <pre>{msg}</pre>
      <p>Two servers, two preview tabs — one <code>npm run dev</code>.</p>
    </>
  )
}
`,
      "server/index.js": `const express = require('express');

const app = express();
const PORT = 3001;

app.get('/api/hello', (_req, res) => res.json({ message: 'Hello from the Express API!' }));
app.get('/', (_req, res) =>
  res.type('html').send(
    '<h1>Express API (:3001)</h1><p>Try <a href="/api/hello">/api/hello</a>. Open the frontend tab (:5173).</p>',
  ),
);

app.listen(PORT, () => console.log('[api] listening on :' + PORT));
`,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2 — meta-frameworks (experimental until each has a green headless spike)
// ═══════════════════════════════════════════════════════════════════════════

// ── Nuxt 3 ───────────────────────────────────────────────────────────────────
function nuxtTemplate(): TemplateDef {
  return {
    manifest: {
      id: "nuxt",
      framework: "nuxt",
      icon: "nuxt",
      category: "Fullstack",
      name: "Nuxt",
      language: "TypeScript",
      description: "Nuxt 3 — Vue meta-framework (Vite + Nitro dev server)",
      port: 3000,
      openPath: "/",
      entry: "app.vue",
      hmr: true,
      reload: false,
      install: "npm install",
      dev: "npm run dev",
      experimental: true,
      // Nuxt spins up a background telemetry reporter that buffers events in the
      // dev-server process; disabling it drops that retained state (and a bit of
      // work) with no effect on the app.
      env: { NUXT_TELEMETRY_DISABLED: "1" },
    },
    files: {
      "package.json": `{
  "name": "nuxt-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "nuxt dev",
    "build": "nuxt build",
    "generate": "nuxt generate",
    "preview": "nuxt preview"
  },
  "devDependencies": { "nuxt": "^3.14.0", "vue": "^3.5.0" }
}
`,
      "nuxt.config.ts": `export default defineNuxtConfig({
  devtools: { enabled: false },
})
`,
      "app.vue": `<template>
  <div class="page">
    <h1>Nuxt 3 on Vivari</h1>
    <p>Edit <code>app.vue</code> and save — HMR is live.</p>
    <button @click="count++">count is {{ count }}</button>
  </div>
</template>

<script setup>
import { ref } from 'vue'
const count = ref(0)
</script>

<style>
.page { font-family: system-ui, sans-serif; text-align: center; padding: 3rem; }
button { padding: .6rem 1.2rem; border-radius: 8px; border: 1px solid #00dc82; background: #00dc82; color: #05240f; cursor: pointer; }
</style>
`,
    },
  };
}

// ── SvelteKit ────────────────────────────────────────────────────────────────
function svelteKitTemplate(): TemplateDef {
  return {
    manifest: {
      id: "sveltekit",
      framework: "sveltekit",
      icon: "sveltekit",
      category: "Fullstack",
      name: "SvelteKit",
      language: "TypeScript",
      description: "SvelteKit — the official Svelte app framework (Vite dev server)",
      port: 5173,
      openPath: "/",
      entry: "src/routes/+page.svelte",
      hmr: true,
      reload: false,
      install: "npm install",
      dev: VITE_DEV,
      experimental: true,
    },
    files: {
      "package.json": `{
  "name": "sveltekit-app",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview"
  },
  "devDependencies": {
    "@sveltejs/adapter-auto": "^3.3.0",
    "@sveltejs/kit": "^2.8.0",
    "@sveltejs/vite-plugin-svelte": "^7.0.0",
    "svelte": "^5.46.4",
    "vite": "^8.0.0"
  }
}
`,
      "svelte.config.js": `import adapter from '@sveltejs/adapter-auto'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

export default {
  preprocess: vitePreprocess(),
  kit: { adapter: adapter() },
}
`,
      "vite.config.js": `import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [sveltekit()],
})
`,
      "src/app.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    %sveltekit.head%
  </head>
  <body data-sveltekit-preload-data="hover">
    <div style="display: contents">%sveltekit.body%</div>
  </body>
</html>
`,
      "src/routes/+page.svelte": `<script>
  let count = $state(0)
</script>

<main style="font-family: system-ui, sans-serif; text-align: center; padding: 3rem">
  <h1>SvelteKit on Vivari</h1>
  <p>Edit <code>src/routes/+page.svelte</code> and save.</p>
  <button onclick={() => count++}>count is {count}</button>
</main>
`,
    },
  };
}

// ── React Router 7 (Remix) ───────────────────────────────────────────────────
function remixTemplate(): TemplateDef {
  return {
    manifest: {
      id: "react-router",
      framework: "react-router",
      icon: "remix",
      category: "Fullstack",
      name: "React Router 7",
      language: "TypeScript",
      description: "React Router 7 framework mode (formerly Remix) — SSR + Vite",
      port: 5173,
      openPath: "/",
      entry: "app/routes/home.tsx",
      hmr: true,
      reload: false,
      install: "npm install",
      dev: "npm run dev",
      // React Router 7 (framework mode) is client-routed: it re-matches the route
      // against the iframe's own location (`/preview/5173/…`) during hydration, so
      // served at `/` (prefix stripped) the client router lands on NotFound even
      // though SSR rendered `/` fine. Keep the proxy prefix and set the app's
      // basename + Vite `base` to `/preview/5173/` so SSR and the client agree.
      keepPreviewPrefix: true,
    },
    files: {
      "package.json": `{
  "name": "react-router-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "react-router dev",
    "build": "react-router build",
    "start": "react-router-serve ./build/server/index.js",
    "typecheck": "react-router typegen && tsc"
  },
  "dependencies": {
    "@react-router/node": "^7.1.0",
    "@react-router/serve": "^7.1.0",
    "isbot": "^5.1.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router": "^7.1.0"
  },
  "devDependencies": {
    "@react-router/dev": "^7.1.0",
    "vite": "^8.0.0"
  }
}
`,
      "react-router.config.ts": `import type { Config } from '@react-router/dev/config'

export default {
  ssr: true,
  // The Vivari preview serves this app under /preview/5173/ (keepPreviewPrefix).
  // The basename must match Vite's \`base\` (below) and end with a slash so both the
  // server and the hydrated client router resolve routes under the proxy prefix.
  basename: '/preview/5173/',
} satisfies Config
`,
      "vite.config.ts": `import { reactRouter } from '@react-router/dev/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  // Match react-router.config.ts \`basename\`; leading AND trailing slash required so
  // asset URLs and the router base line up under the Vivari preview prefix.
  base: '/preview/5173/',
  plugins: [reactRouter()],
})
`,
      "app/root.tsx": `import { Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router'

export default function Root() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}
`,
      "app/routes.ts": `import { type RouteConfig, index } from '@react-router/dev/routes'

export default [index('routes/home.tsx')] satisfies RouteConfig
`,
      "app/routes/home.tsx": `export default function Home() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', textAlign: 'center', padding: '3rem' }}>
      <h1>React Router 7 on Vivari</h1>
      <p>Edit <code>app/routes/home.tsx</code> and save.</p>
    </main>
  )
}
`,
    },
  };
}

// ── Astro ────────────────────────────────────────────────────────────────────
function astroTemplate(): TemplateDef {
  return {
    manifest: {
      id: "astro",
      framework: "astro",
      icon: "astro",
      category: "Fullstack",
      name: "Astro",
      language: "TypeScript",
      description: "Astro — content-driven web framework (Vite dev server)",
      port: 4321,
      openPath: "/",
      entry: "src/pages/index.astro",
      hmr: true,
      reload: false,
      install: "npm install",
      dev: "npm run dev",
      // Proven in-VM by scripts/spike-astro.mjs (dev server boots Vite + @astrojs/compiler
      // wasm and SSRs the index page). No longer experimental.
    },
    files: {
      "package.json": `{
  "name": "astro-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview"
  },
  "dependencies": { "astro": "^5.1.0" }
}
`,
      "astro.config.mjs": `import { defineConfig } from 'astro/config'

export default defineConfig({})
`,
      "src/pages/index.astro": `---
const title = 'Astro on Vivari'
---

<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
  </head>
  <body style="font-family: system-ui, sans-serif; text-align: center; padding: 3rem">
    <h1>{title}</h1>
    <p>Edit <code>src/pages/index.astro</code> and save.</p>
  </body>
</html>
`,
    },
  };
}

// ── Slidev ───────────────────────────────────────────────────────────────────
function slidevTemplate(): TemplateDef {
  return {
    manifest: {
      id: "slidev",
      framework: "slidev",
      icon: "slidev",
      category: "Docs",
      name: "Slidev",
      language: "JavaScript",
      description: "Slidev — presentation slides for developers (Vite + Vue)",
      port: 3030,
      openPath: "/",
      entry: "slides.md",
      hmr: true,
      reload: false,
      install: "npm install",
      dev: "npm run dev",
      // Proven in-VM by scripts/spike-slidev.mjs (dev server builds + serves the
      // slide deck). No longer experimental.
    },
    files: {
      "package.json": `{
  "name": "slidev-deck",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "slidev --port 3030",
    "build": "slidev build",
    "export": "slidev export"
  },
  "dependencies": {
    "@slidev/cli": "^0.50.0",
    "@slidev/theme-default": "^0.25.0",
    "vue": "^3.5.0"
  }
}
`,
      "slides.md": `---
theme: default
title: Slidev on Vivari
---

# Slidev on Vivari

Presentation slides for developers — running in the browser

---

## Powered by Vite + Vue

- Write slides in Markdown
- Live hot reload as you edit \`slides.md\`
- Code highlighting, embedded components, and more
`,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3 — frontend variants. Preact, Lit, and Solid (Vite 8 / rolldown) and now
// Qwik are all proven in-VM by headless spikes (scripts/spike-{preact,lit,solid,qwik}.mjs)
// and are no longer experimental. Qwik is special: @builder.io/qwik@1.x declares
// `peer vite ">=5 <8"`, so it can't use Vite 8 and is pinned to Vite 7, whose dep
// optimizer wants esbuild's native binary (no wasm32 build). That now Just Works
// because the runtime aliases esbuild -> esbuild-wasm at the registry layer and runs
// its service in-process (see packages/studio/src/workers/fetcher-worker.js +
// packages/runtime/esbuild-inproc-patch.js), and qwikVite runs in `csr: true` mode
// so it doesn't demand an SSR src/root.tsx entry.
// ═══════════════════════════════════════════════════════════════════════════

// ── Preact ───────────────────────────────────────────────────────────────────
function preactTemplate(): TemplateDef {
  return {
    manifest: {
      id: "preact",
      framework: "preact",
      icon: "preact",
      category: "Frontend",
      name: "Preact",
      language: "TypeScript",
      description: "Preact + Vite — a fast 3kB alternative to React",
      port: 5173,
      openPath: "/",
      entry: "src/app.tsx",
      hmr: true,
      reload: false,
      install: "npm install",
      dev: VITE_DEV,
    },
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
      "src/index.css": VITE_INDEX_CSS,
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
      <p>Running inside Vivari.</p>
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
  };
}

// ── Lit ──────────────────────────────────────────────────────────────────────
function litTemplate(): TemplateDef {
  return {
    manifest: {
      id: "lit",
      framework: "lit",
      icon: "lit",
      category: "Frontend",
      name: "Lit",
      language: "TypeScript",
      description: "Lit + Vite — fast, lightweight web components",
      port: 5173,
      openPath: "/",
      entry: "src/my-element.ts",
      hmr: true,
      reload: false,
      install: "npm install",
      dev: VITE_DEV,
    },
    files: {
      "package.json": `{
  "name": "lit-app",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview" },
  "dependencies": { "lit": "^3.2.0" },
  "devDependencies": { "typescript": "^5.7.0", "vite": "^8.0.0" }
}
`,
      "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + Lit</title>
  </head>
  <body>
    <my-element></my-element>
    <script type="module" src="/src/my-element.ts"></script>
  </body>
</html>
`,
      "src/my-element.ts": `import { LitElement, html, css } from 'lit'

export class MyElement extends LitElement {
  static properties = { count: { type: Number } }

  static styles = css\`
    :host { display: block; font-family: system-ui, sans-serif; text-align: center; padding: 3rem; }
    button { padding: .6rem 1.2rem; border-radius: 8px; border: 1px solid #324fff; background: #324fff; color: #fff; cursor: pointer; }
  \`

  declare count: number
  constructor() {
    super()
    this.count = 0
  }

  render() {
    return html\`
      <h1>Vite + Lit</h1>
      <button @click=\${() => this.count++}>count is \${this.count}</button>
      <p>A web component running inside Vivari.</p>
    \`
  }
}

customElements.define('my-element', MyElement)
`,
      "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "noEmit": true,
    "strict": true,
    "useDefineForClassFields": false
  },
  "include": ["src"]
}
`,
    },
  };
}

// ── Solid ────────────────────────────────────────────────────────────────────
function solidTemplate(): TemplateDef {
  return {
    manifest: {
      id: "solid",
      framework: "solid",
      icon: "solid",
      category: "Frontend",
      name: "Solid",
      language: "TypeScript",
      description: "SolidJS + Vite — fine-grained reactive UI",
      port: 5173,
      openPath: "/",
      entry: "src/App.tsx",
      hmr: true,
      reload: false,
      install: "npm install",
      dev: VITE_DEV,
    },
    files: {
      "package.json": `{
  "name": "solid-app",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview" },
  "dependencies": { "solid-js": "^1.9.0" },
  "devDependencies": { "typescript": "^5.7.0", "vite": "^8.0.0", "vite-plugin-solid": "^2.11.0" }
}
`,
      "vite.config.ts": `import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solid()],
})
`,
      "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + Solid</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/index.tsx"></script>
  </body>
</html>
`,
      "src/index.css": VITE_INDEX_CSS,
      "src/index.tsx": `import { render } from 'solid-js/web'
import App from './App'
import './index.css'

render(() => <App />, document.getElementById('root')!)
`,
      "src/App.tsx": `import { createSignal } from 'solid-js'

export default function App() {
  const [count, setCount] = createSignal(0)
  return (
    <>
      <h1>Vite + Solid</h1>
      <div class="card">
        <button onClick={() => setCount(count() + 1)}>count is {count()}</button>
      </div>
      <p>Running inside Vivari.</p>
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
    "jsx": "preserve",
    "jsxImportSource": "solid-js",
    "skipLibCheck": true,
    "noEmit": true,
    "strict": true
  },
  "include": ["src"]
}
`,
    },
  };
}

// ── Qwik ─────────────────────────────────────────────────────────────────────
function qwikTemplate(): TemplateDef {
  return {
    manifest: {
      id: "qwik",
      framework: "qwik",
      icon: "qwik",
      category: "Frontend",
      name: "Qwik",
      language: "TypeScript",
      description: "Qwik + Vite — resumable, O(1) loading UI",
      port: 5173,
      openPath: "/",
      entry: "src/app.tsx",
      hmr: true,
      reload: false,
      install: "npm install",
      dev: VITE_DEV,
    },
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
      "src/main.tsx": `// The qwikloader is the tiny global listener that intercepts DOM events and
// lazy-loads their onXxx$ handlers. SSR normally inlines it; a CSR app must import
// it explicitly or nothing is interactive (buttons render but clicks do nothing).
import '@builder.io/qwik/qwikloader.js'
import { render } from '@builder.io/qwik'
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
      <p>Running inside Vivari.</p>
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
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3 — backends (experimental until spiked)
// ═══════════════════════════════════════════════════════════════════════════

// ── Fastify ──────────────────────────────────────────────────────────────────
function fastifyTemplate(): TemplateDef {
  return {
    manifest: {
      id: "fastify",
      framework: "fastify",
      icon: "fastify",
      category: "Backend",
      name: "Fastify",
      language: "JavaScript",
      description: "Fastify — fast and low-overhead Node web framework",
      port: 3000,
      openPath: "/",
      entry: "src/index.js",
      hmr: false,
      reload: false,
      install: "npm install",
      dev: "npm run dev",
      // Graduated: plain Node HTTP server on the proven Express/Nest substrate,
      // gated by scripts/spike-fastify.mjs.
    },
    files: {
      "package.json": `{
  "name": "fastify-app",
  "private": true,
  "version": "1.0.0",
  "type": "commonjs",
  "scripts": { "start": "node src/index.js", "dev": "node src/index.js" },
  "dependencies": { "fastify": "^5.1.0" }
}
`,
      "src/index.js": `const Fastify = require('fastify');

const app = Fastify({ logger: true });
const port = Number(process.env.PORT ?? 3000);

const html = ${JSON.stringify(backendDemoHtml("Fastify"))};

app.get('/', (_req, reply) => reply.type('text/html').send(html));
app.get('/api/hello', async () => ({ message: 'Hello, world!' }));

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
`,
    },
  };
}

// ── Nitro ────────────────────────────────────────────────────────────────────
function nitroTemplate(): TemplateDef {
  return {
    manifest: {
      id: "nitro",
      framework: "nitro",
      icon: "nitro",
      category: "Backend",
      name: "Nitro",
      language: "TypeScript",
      description: "Nitro (unjs) — universal server framework",
      port: 3000,
      openPath: "/",
      entry: "routes/index.ts",
      hmr: true,
      reload: false,
      install: "npm install",
      dev: "npm run dev",
      // Proven in-VM by scripts/spike-nitro.mjs (nitro dev builds + serves the
      // index route and a JSON API route). No longer experimental.
    },
    files: {
      "package.json": `{
  "name": "nitro-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "nitro dev",
    "build": "nitro build",
    "preview": "node .output/server/index.mjs"
  },
  "devDependencies": { "nitropack": "^2.10.0" }
}
`,
      "nitro.config.ts": `export default defineNitroConfig({
  compatibilityDate: 'latest',
})
`,
      "routes/index.ts": `const html = ${JSON.stringify(backendDemoHtml("Nitro"))}

export default defineEventHandler((event) => {
  setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
  return html
})
`,
      "routes/api/hello.ts": `export default defineEventHandler(() => ({ message: 'Hello, world!' }))
`,
    },
  };
}

// ── GraphQL (Yoga) ───────────────────────────────────────────────────────────
function graphqlTemplate(): TemplateDef {
  return {
    manifest: {
      id: "graphql",
      framework: "graphql",
      icon: "graphql",
      category: "Backend",
      name: "GraphQL",
      language: "JavaScript",
      description: "GraphQL Yoga API (queries + a mutation) with a demo UI + GraphiQL, on Node",
      port: 4000,
      openPath: "/",
      entry: "src/index.js",
      hmr: false,
      reload: false,
      install: "npm install",
      dev: "npm run dev",
      // Proven in-VM by scripts/spike-graphql.mjs (queries + the addBook mutation
      // over the real Yoga server). No longer experimental.
    },
    files: {
      "package.json": `{
  "name": "graphql-app",
  "private": true,
  "version": "1.0.0",
  "type": "commonjs",
  "scripts": { "start": "node src/index.js", "dev": "node src/index.js" },
  "dependencies": { "graphql": "^16.10.0", "graphql-yoga": "^5.10.0" }
}
`,
      "src/index.js": `const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createYoga, createSchema } = require('graphql-yoga');

// In-memory data so the addBook mutation has something to change.
let nextId = 3;
const books = [
  { id: '1', title: 'The Pragmatic Programmer', author: 'Hunt & Thomas' },
  { id: '2', title: 'Refactoring', author: 'Martin Fowler' },
];

const yoga = createYoga({
  graphqlEndpoint: '/graphql',
  schema: createSchema({
    typeDefs: \`
      type Book { id: ID!, title: String!, author: String! }
      type Query {
        hello: String
        greet(name: String!): String
        books: [Book!]!
      }
      type Mutation {
        addBook(title: String!, author: String!): Book!
      }
    \`,
    resolvers: {
      Query: {
        hello: () => 'Hello from GraphQL Yoga!',
        greet: (_parent, args) => 'Hello ' + args.name + '!',
        books: () => books,
      },
      Mutation: {
        addBook: (_parent, args) => {
          const book = { id: String(nextId++), title: args.title, author: args.author };
          books.push(book);
          return book;
        },
      },
    },
  }),
});

// Serve a tiny demo UI at / and let GraphQL Yoga (with GraphiQL) own /graphql.
const indexHtml = readFileSync(path.join(__dirname, '..', 'public', 'index.html'));
const port = Number(process.env.PORT ?? 4000);
createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(indexHtml);
    return;
  }
  return yoga(req, res);
}).listen(port, () => {
  console.log('GraphQL demo UI at http://localhost:' + port + '/  (GraphiQL at /graphql)');
});
`,
      "public/index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>GraphQL (Yoga) demo</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body { font-family: system-ui, sans-serif; margin: 0; padding: 2.5rem; background: #0a0a0a; color: #ededed; }
      main { max-width: 680px; margin: 0 auto; }
      header { display: flex; align-items: baseline; gap: .75rem; flex-wrap: wrap; }
      h1 { margin: 0; font-size: 1.5rem; }
      a { color: #a78bfa; }
      .sub { color: #9ca3af; margin: .35rem 0 1.5rem; }
      code { background: #1f2937; padding: .1rem .35rem; border-radius: 5px; }
      .card { background: #111; border: 1px solid #1f2937; border-radius: 12px; padding: 1.1rem 1.2rem; margin-bottom: 1rem; }
      .card h2 { margin: 0 0 .6rem; font-size: 1rem; }
      label { display: block; color: #9ca3af; font-size: .78rem; margin: .4rem 0 .2rem; }
      input { width: 100%; padding: .5rem .6rem; border-radius: 8px; border: 1px solid #333; background: #0d0d0d; color: #ededed; }
      .row { display: flex; gap: .5rem; }
      .row > div { flex: 1; }
      button { margin-top: .7rem; padding: .5rem 1rem; border-radius: 8px; border: 1px solid transparent; background: #7c3aed; color: #fff; cursor: pointer; }
      button.ghost { background: #1f2937; }
      button:hover { filter: brightness(1.1); }
      ul { list-style: none; padding: 0; margin: .5rem 0 0; }
      li { padding: .5rem .7rem; border: 1px solid #1f2937; border-radius: 8px; margin: .35rem 0; }
      li .by { color: #9ca3af; font-size: .8rem; }
      .out { color: #4ade80; font-weight: 600; min-height: 1.2rem; margin: .6rem 0 0; }
      pre { background: #0d0d0d; border: 1px solid #1f2937; border-radius: 8px; padding: .7rem; overflow: auto; font-size: .78rem; color: #cbd5e1; margin: 0; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>GraphQL (Yoga)</h1>
        <a id="giql" href="/graphql" target="_blank" rel="noopener">Open GraphiQL &rarr;</a>
      </header>
      <p class="sub">Each button calls the GraphQL API at <code>/graphql</code> with <code>fetch()</code> and renders the result.</p>

      <div class="card">
        <h2>Query with an argument</h2>
        <label for="name">name</label>
        <input id="name" value="Duc" />
        <button id="greetBtn">Run greet(name)</button>
        <p class="out" id="greetOut"></p>
      </div>

      <div class="card">
        <h2>Query a list + run a mutation</h2>
        <div class="row">
          <div><label for="title">title</label><input id="title" placeholder="Book title" /></div>
          <div><label for="author">author</label><input id="author" placeholder="Author" /></div>
        </div>
        <button id="addBtn">Add book (mutation)</button>
        <button id="refreshBtn" class="ghost">Refresh list</button>
        <ul id="books"></ul>
      </div>

      <div class="card">
        <h2>Last GraphQL response</h2>
        <pre id="raw">Click a button above.</pre>
      </div>
    </main>
    <script>
      // In the Vivari preview the page lives under /preview/<port>/, so point
      // the GraphiQL link at the same prefix; standalone it's just /graphql.
      var pm = location.pathname.match(/^(.*\\/preview\\/\\d+)\\//);
      document.getElementById('giql').href = (pm ? pm[1] : '') + '/graphql';

      function gql(query, variables) {
        return fetch((pm ? pm[1] : '') + '/graphql', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'accept': 'application/json' },
          body: JSON.stringify({ query: query, variables: variables || {} })
        }).then(function (r) { return r.json(); });
      }
      function showRaw(obj) { document.getElementById('raw').textContent = JSON.stringify(obj, null, 2); }

      document.getElementById('greetBtn').addEventListener('click', function () {
        var name = document.getElementById('name').value || 'world';
        gql('query($name:String!){ greet(name:$name) }', { name: name }).then(function (res) {
          showRaw(res);
          document.getElementById('greetOut').textContent = (res.data && res.data.greet) || '';
        });
      });

      function loadBooks() {
        return gql('{ books { id title author } }').then(function (res) {
          showRaw(res);
          var list = document.getElementById('books');
          list.innerHTML = '';
          (res.data && res.data.books ? res.data.books : []).forEach(function (b) {
            var li = document.createElement('li');
            var t = document.createElement('span'); t.textContent = b.title;
            var by = document.createElement('span'); by.className = 'by'; by.textContent = '  \u2014 ' + b.author;
            li.appendChild(t); li.appendChild(by);
            list.appendChild(li);
          });
        });
      }
      document.getElementById('addBtn').addEventListener('click', function () {
        var title = document.getElementById('title').value.trim();
        var author = document.getElementById('author').value.trim();
        if (!title || !author) { document.getElementById('raw').textContent = 'Enter a title and author first.'; return; }
        gql('mutation($t:String!,$a:String!){ addBook(title:$t, author:$a){ id title author } }', { t: title, a: author }).then(function (res) {
          showRaw(res);
          document.getElementById('title').value = '';
          document.getElementById('author').value = '';
          loadBooks();
        });
      });
      document.getElementById('refreshBtn').addEventListener('click', loadBooks);

      loadBooks();
    </script>
  </body>
</html>
`,
      "README.md": `# GraphQL (Yoga)

A GraphQL Yoga server on Node with a tiny demo UI.

## Files
- src/index.js — the Yoga server. GraphQL (and GraphiQL) live at /graphql; a small
  static demo page is served at /.
- public/index.html — the demo UI: buttons that call /graphql via fetch() and render
  the result (a query with an argument, a list query, and a mutation).

## Run
- npm install
- npm run dev   (opens http://localhost:4000)

## Try it
- Open the page and click the buttons, OR open GraphiQL at /graphql and run:

  { hello }
  query { greet(name: "Duc") }
  { books { id title author } }
  mutation { addBook(title: "Dune", author: "Herbert") { id title } }

## API
- POST /graphql with JSON { "query": "...", "variables": { ... } }

Learn more: https://the-guild.dev/graphql/yoga-server
`,
    },
  };
}

// ── Feathers ─────────────────────────────────────────────────────────────────
function feathersTemplate(): TemplateDef {
  return {
    manifest: {
      id: "feathers",
      framework: "feathers",
      icon: "feathers",
      category: "Backend",
      name: "Feathers",
      language: "JavaScript",
      description: "FeathersJS — real-time APIs and services (Koa transport)",
      port: 3030,
      openPath: "/messages",
      entry: "src/index.js",
      hmr: false,
      reload: false,
      install: "npm install",
      dev: "npm run dev",
      // Proven in-VM by scripts/spike-feathers.mjs (find() + create() over the
      // rest() transport). No longer experimental.
    },
    files: {
      "package.json": `{
  "name": "feathers-app",
  "private": true,
  "version": "1.0.0",
  "type": "commonjs",
  "scripts": { "start": "node src/index.js", "dev": "node src/index.js" },
  "dependencies": { "@feathersjs/feathers": "^5.0.0", "@feathersjs/koa": "^5.0.0" }
}
`,
      "src/index.js": `const { feathers } = require('@feathersjs/feathers');
const { koa, rest, bodyParser, errorHandler } = require('@feathersjs/koa');

class MessageService {
  constructor() {
    this.messages = [{ id: 0, text: 'Hello from Feathers!' }];
  }
  async find() {
    return this.messages;
  }
  async create(data) {
    const message = { id: this.messages.length, text: data.text };
    this.messages.push(message);
    return message;
  }
}

const app = koa(feathers());
app.use(errorHandler());
app.use(bodyParser());
app.configure(rest());
app.use('messages', new MessageService());

const port = Number(process.env.PORT ?? 3030);
app.listen(port).then(() => console.log('Feathers on http://localhost:' + port + '/messages'));
`,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3 — showcases that lean into Vivari's strengths
// ═══════════════════════════════════════════════════════════════════════════

// ── Socket.IO ────────────────────────────────────────────────────────────────
function socketioTemplate(): TemplateDef {
  return {
    manifest: {
      id: "socketio",
      framework: "socketio",
      icon: "socketio",
      category: "Showcase",
      name: "Socket.IO",
      language: "JavaScript",
      description: "Real-time chat over Socket.IO — WebSockets tunneled through the preview",
      port: 3000,
      openPath: "/",
      entry: "server.js",
      hmr: false,
      reload: false,
      install: "npm install",
      dev: "npm run dev",
      // Proven in-VM by scripts/spike-socketio.mjs (UI + client script + engine.io
      // handshake); the ws chat rides the proven preview ws tunnel. Not experimental.
    },
    files: {
      "package.json": `{
  "name": "socketio-chat",
  "private": true,
  "version": "0.0.0",
  "type": "commonjs",
  "scripts": { "start": "node server.js", "dev": "node server.js" },
  "dependencies": { "express": "^4.21.0", "socket.io": "^4.8.0" }
}
`,
      "server.js": `const express = require('express');
const { createServer } = require('node:http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

io.on('connection', (socket) => {
  console.log('client connected:', socket.id);
  socket.on('chat', (msg) => io.emit('chat', msg));
  socket.on('disconnect', () => console.log('client left:', socket.id));
});

app.use(express.static(path.join(__dirname, 'public')));

const port = Number(process.env.PORT ?? 3000);
httpServer.listen(port, () => console.log('Socket.IO chat on http://localhost:' + port));
`,
      "public/index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Socket.IO chat</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; background: #0a0a0a; color: #ededed; }
      #log { margin: 1rem 0; height: 240px; overflow: auto; border: 1px solid #333; border-radius: 8px; padding: .75rem; }
      form { display: flex; gap: .5rem; }
      input { flex: 1; padding: .5rem; border-radius: 6px; border: 1px solid #333; background: #111; color: #ededed; }
      button { padding: .5rem 1rem; border-radius: 6px; border: 0; background: #646cff; color: #fff; cursor: pointer; }
    </style>
  </head>
  <body>
    <h1>Socket.IO chat</h1>
    <p>Open this preview in two tabs and watch messages sync in real time.</p>
    <div id="log"></div>
    <form id="form">
      <input id="input" autocomplete="off" placeholder="Type a message…" />
      <button type="submit">Send</button>
    </form>
    <script src="/socket.io/socket.io.js"></script>
    <script>
      var socket = io();
      var log = document.getElementById('log');
      var form = document.getElementById('form');
      var input = document.getElementById('input');
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (input.value) { socket.emit('chat', input.value); input.value = ''; }
      });
      socket.on('chat', function (msg) {
        var line = document.createElement('div');
        line.textContent = msg;
        log.appendChild(line);
        log.scrollTop = log.scrollHeight;
      });
    </script>
  </body>
</html>
`,
    },
  };
}

// ── tRPC (React + Node) ──────────────────────────────────────────────────────
// Proven in-VM by scripts/spike-trpc.mjs (the raw .ts server runs through the
// loader and answers typed queries) + browser-confirmed end to end.
function trpcTemplate(): TemplateDef {
  return {
    manifest: {
      id: "trpc",
      framework: "trpc",
      icon: "trpc",
      category: "Showcase",
      name: "tRPC",
      language: "TypeScript",
      description: "tRPC end-to-end typed API: React (Vite :5173) calling a Node server (:3001)",
      port: 5173,
      openPath: "/",
      entry: "src/App.tsx",
      hmr: true,
      reload: false,
      // Two intentional user-facing servers (tRPC :3001 + frontend :5173) → a tab each.
      multiPreview: true,
      install: "npm install",
      dev: "npm run dev",
    },
    files: {
      "package.json": `{
  "name": "trpc-app",
  "private": true,
  "version": "0.0.0",
  "scripts": {
    "dev": "node dev.js",
    "server": "node --experimental-strip-types server/index.ts",
    "client": "vite --configLoader native --port 5173 --strictPort"
  },
  "dependencies": {
    "@trpc/client": "^11.0.0",
    "@trpc/server": "^11.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zod": "^3.24.0"
  },
  "devDependencies": { "@vitejs/plugin-react": "^5.0.0", "typescript": "^5.7.0", "vite": "^8.0.0" }
}
`,
      "dev.js": `const { spawn } = require('child_process');

const procs = [];
let exiting = false;
function run(label, cmd, args) {
  const child = spawn(cmd, args, { stdio: 'inherit' });
  procs.push(child);
  child.on('exit', (code) => {
    if (exiting) return;
    exiting = true;
    console.log('[dev] ' + label + ' exited (' + code + ') — stopping the other process.');
    for (const p of procs) { if (p !== child) { try { p.kill(); } catch (e) {} } }
    process.exit(code || 0);
  });
}

console.log('[dev] starting tRPC server (:3001) and frontend (:5173)…');
run('server', 'npm', ['run', 'server']);
run('frontend', 'npm', ['run', 'client']);
`,
      "vite.config.js": `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
})
`,
      "server/index.ts": `import { initTRPC } from '@trpc/server'
import { createHTTPServer } from '@trpc/server/adapters/standalone'
import { z } from 'zod'

const t = initTRPC.create()

export const appRouter = t.router({
  greeting: t.procedure
    .input(z.object({ name: z.string() }).optional())
    .query(({ input }) => 'Hello ' + (input?.name ?? 'world') + ' from tRPC!'),
})

createHTTPServer({ router: appRouter }).listen(3001)
console.log('[trpc] server listening on :3001')
`,
      "index.html": reactIndexHtml("tsx"),
      "src/index.css": VITE_INDEX_CSS,
      "src/main.tsx": reactMain(true),
      "src/App.tsx": `import { useEffect, useState } from 'react'
import { createTRPCClient, httpBatchLink } from '@trpc/client'

// End-to-end typing without a runtime \`export type\` in the server entry: a
// type-only \`typeof import()\` is fully erased by the bundler, so the server
// file (run raw via node --experimental-strip-types) stays free of type syntax.
type AppRouter = typeof import('../server/index').appRouter

// The studio's preview proxy maps /preview/<port>/ to the in-VM server, so the
// browser reaches the tRPC server (:3001) with no CORS and no manual proxy.
const trpc = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: '/preview/3001' })],
})

export default function App() {
  const [msg, setMsg] = useState('loading…')
  useEffect(() => {
    trpc.greeting
      .query({ name: 'Vivari' })
      .then(setMsg)
      .catch((e) => setMsg('error: ' + e))
  }, [])
  return (
    <>
      <h1>tRPC + React</h1>
      <p>Fully-typed call from the frontend (:5173) to the tRPC server (:3001):</p>
      <pre>{msg}</pre>
    </>
  )
}
`,
    },
  };
}

// ── pnpm monorepo ────────────────────────────────────────────────────────────
function monorepoTemplate(): TemplateDef {
  return {
    manifest: {
      id: "monorepo",
      framework: "monorepo",
      icon: "monorepo",
      category: "Showcase",
      name: "pnpm monorepo",
      language: "JavaScript",
      description: "pnpm workspaces: a Vite React app importing a shared workspace package",
      port: 5173,
      openPath: "/",
      entry: "apps/web/src/App.jsx",
      hmr: true,
      reload: false,
      install: "pnpm install",
      // pnpm does NOT eat a leading `--` like npm does — `pnpm … dev -- --configLoader
      // native` forwards the literal `--` too, and vite's cac parser then treats
      // `--configLoader native` as pass-through positionals (flag ignored). Drop the
      // `--`: pnpm forwards everything after the script name straight to vite.
      dev: "pnpm --filter web dev --configLoader native",
      // Graduated: browser-confirmed (pnpm install + workspace symlink + Vite dev +
      // live preview all work). The cmd-shim bin unwrap it depends on is guarded by
      // scripts/spike-cmd-shim.mjs, and real pnpm is exercised by the pnpm spikes.
    },
    files: {
      // A FLAT node_modules (pnpm's "hoisted" linker, like npm/yarn) instead of the
      // default isolated symlink store. The `workspace:*` package (@repo/ui) is still
      // symlinked — that's the actual showcase — but external deps (and their
      // transitives, e.g. react-dom's `scheduler`) become real top-level dirs. Vite's
      // in-VM rolldown dep-optimizer can then bundle those transitive CJS deps; under
      // the isolated store it externalised `scheduler` → the preview crashed with
      // "Calling require for scheduler in an environment that doesn't expose require".
      ".npmrc": `node-linker=hoisted
`,
      "package.json": `{
  "name": "monorepo",
  "private": true,
  "scripts": { "dev": "pnpm --filter web dev" }
}
`,
      "pnpm-workspace.yaml": `packages:
  - 'apps/*'
  - 'packages/*'
`,
      "packages/ui/package.json": `{
  "name": "@repo/ui",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.js",
  "exports": { ".": "./src/index.js" }
}
`,
      "packages/ui/src/index.js": `export function greeting(name) {
  return 'Hello ' + name + ' from the shared @repo/ui package!'
}
`,
      "apps/web/package.json": `{
  "name": "web",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview" },
  "dependencies": { "@repo/ui": "workspace:*", "react": "^19.0.0", "react-dom": "^19.0.0" },
  "devDependencies": { "@vitejs/plugin-react": "^5.0.0", "vite": "^8.0.0" }
}
`,
      "apps/web/vite.config.js": reactViteConfig,
      "apps/web/index.html": reactIndexHtml("jsx"),
      "apps/web/src/index.css": VITE_INDEX_CSS,
      "apps/web/src/main.jsx": reactMain(false),
      "apps/web/src/App.jsx": `import { greeting } from '@repo/ui'

export default function App() {
  return (
    <>
      <h1>pnpm monorepo</h1>
      <p>{greeting('Vivari')}</p>
      <p>
        The <code>web</code> app imports a shared <code>@repo/ui</code> workspace package —
        pnpm workspaces working inside Vivari.
      </p>
    </>
  )
}
`,
    },
  };
}

// ── In-VM databases (SQLite via sql.js, Postgres via PGlite) ─────────────────
// Both ship a real SQL engine compiled to WebAssembly — no native addons, no
// external server. They run 100% in-VM: the .wasm binaries land in node_modules
// from npm and are read back over the virtual filesystem + instantiated in-worker.
// Shared UI so both templates present the same read/write todo demo.
function dbDemoHtml(title: string, subtitle: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>
      :root { color-scheme: dark; }
      body { font-family: system-ui, sans-serif; margin: 0; padding: 2.5rem; background: #0a0a0a; color: #ededed; }
      main { max-width: 640px; margin: 0 auto; }
      h1 { margin: 0 0 .25rem; font-size: 1.6rem; }
      .sub { color: #9ca3af; margin: 0 0 .5rem; }
      .badge { display: inline-block; font-size: .75rem; padding: .2rem .55rem; border-radius: 999px; background: #1f2937; color: #93c5fd; }
      form { display: flex; gap: .5rem; margin: 1.5rem 0 1rem; }
      input { flex: 1; padding: .55rem .7rem; border-radius: 8px; border: 1px solid #333; background: #111; color: #ededed; }
      button { padding: .55rem 1rem; border-radius: 8px; border: 1px solid transparent; background: #2563eb; color: #fff; cursor: pointer; }
      ul { list-style: none; padding: 0; }
      li { padding: .5rem .75rem; border: 1px solid #1f2937; border-radius: 8px; margin: .4rem 0; display: flex; gap: .55rem; align-items: center; }
      li.done span.task { text-decoration: line-through; opacity: .55; }
      .dot { width: .5rem; height: .5rem; border-radius: 999px; background: #f59e0b; flex: none; }
      li.done .dot { background: #22c55e; }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p class="sub">${subtitle}</p>
      <p><span class="badge" id="engine">connecting…</span></p>
      <form id="add">
        <input id="task" placeholder="Add a todo and press Enter" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <ul id="list"></ul>
    </main>
    <script>
      // Address the in-VM server through the explicit /preview/<port>/ proxy prefix
      // (present when running inside Vivari) so requests hit the Service
      // Worker's deterministic preview route rather than relying on client-port
      // inference. Standalone it's just /api.
      var pm = location.pathname.match(/^(\\/preview\\/\\d+)\\//);
      var API = (pm ? pm[1] : '') + '/api';
      function load() {
        fetch(API + '/info').then(function (r) { return r.json(); }).then(function (info) {
          document.getElementById('engine').textContent = info.engine + ' ' + info.version + ' · ' + info.driver;
        }).catch(function () {});
        fetch(API + '/todos').then(function (r) { return r.json(); }).then(function (rows) {
          var list = document.getElementById('list');
          list.innerHTML = '';
          rows.forEach(function (row) {
            var li = document.createElement('li');
            li.className = row.done ? 'done' : '';
            var dot = document.createElement('span'); dot.className = 'dot';
            var text = document.createElement('span'); text.className = 'task'; text.textContent = row.task;
            li.appendChild(dot); li.appendChild(text);
            list.appendChild(li);
          });
        });
      }
      document.getElementById('add').addEventListener('submit', function (e) {
        e.preventDefault();
        var input = document.getElementById('task');
        var task = input.value.trim();
        if (!task) return;
        fetch(API + '/todos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task: task })
        }).then(function () { input.value = ''; load(); });
      });
      load();
    </script>
  </body>
</html>
`;
}

// ── SQLite (sql.js) ──────────────────────────────────────────────────────────
function sqliteTemplate(): TemplateDef {
  return {
    manifest: {
      id: "sqlite",
      framework: "sqlite",
      icon: "sqlite",
      category: "Showcase",
      name: "SQLite (sql.js)",
      language: "JavaScript",
      description: "A real SQLite database in the browser via sql.js (WASM) + Express — zero native deps",
      port: 3000,
      openPath: "/",
      entry: "server.js",
      hmr: false,
      reload: false,
      install: "npm install",
      dev: "npm run dev",
      // Experimental until scripts/spike-sqlite.mjs is green in CI.
      experimental: true,
    },
    files: {
      "package.json": `{
  "name": "sqlite-demo",
  "private": true,
  "version": "0.0.0",
  "type": "commonjs",
  "scripts": { "start": "node server.js", "dev": "node server.js" },
  "dependencies": { "express": "^4.21.0", "sql.js": "^1.12.0" }
}
`,
      "server.js": `const express = require('express');
const path = require('path');
const initSqlJs = require('sql.js');

async function main() {
  // sql.js loads its .wasm from node_modules over the virtual filesystem.
  const SQL = await initSqlJs({ locateFile: (f) => require.resolve('sql.js/dist/' + f) });
  const db = new SQL.Database();
  db.run('CREATE TABLE todos (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0);');
  db.run("INSERT INTO todos (task, done) VALUES ('Try Vivari', 1), ('Run SQLite in the browser', 0);");

  const app = express();
  app.use(express.json());

  app.get('/api/info', (_req, res) => {
    const stmt = db.prepare('SELECT sqlite_version() AS version');
    stmt.step();
    const version = stmt.getAsObject().version;
    stmt.free();
    res.json({ engine: 'SQLite', version: version, driver: 'sql.js (WASM)' });
  });

  app.get('/api/todos', (_req, res) => {
    const rows = [];
    const stmt = db.prepare('SELECT id, task, done FROM todos ORDER BY id');
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    res.json(rows);
  });

  app.post('/api/todos', (req, res) => {
    const task = (req.body && req.body.task ? String(req.body.task) : '').trim();
    if (!task) return res.status(400).json({ error: 'task is required' });
    const stmt = db.prepare('INSERT INTO todos (task, done) VALUES (?, 0)');
    stmt.run([task]);
    stmt.free();
    res.status(201).json({ ok: true });
  });

  app.use(express.static(path.join(__dirname, 'public')));

  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => console.log('SQLite demo on http://localhost:' + port));
}

main().catch((err) => { console.error(err); process.exit(1); });
`,
      "public/index.html": dbDemoHtml(
        "SQLite in the browser",
        "A real SQLite database (sql.js compiled to WebAssembly) running entirely in-VM.",
      ),
      "README.md": `# SQLite in the browser (sql.js)

A real SQLite database running 100% in-VM via sql.js (SQLite compiled to
WebAssembly) — no native addons, no better-sqlite3, no build step.

## Files
- server.js — Express API. initSqlJs() loads the WASM from node_modules over the
  virtual filesystem (locateFile -> require.resolve('sql.js/dist/...')).
- public/index.html — a tiny UI that reads and writes the DB through the API.

## Run
- npm install
- npm run dev   (opens http://localhost:3000)

## Endpoints
- GET  /api/info   engine + version
- GET  /api/todos  list rows
- POST /api/todos  body: { "task": "..." }

## Persistence
sql.js is in-memory. Export with db.export() (a Uint8Array) and write it to disk
with fs; reload later with new SQL.Database(bytes).

Learn more: https://sql.js.org
`,
    },
  };
}

// ── PostgreSQL (PGlite) ──────────────────────────────────────────────────────
function pgliteTemplate(): TemplateDef {
  return {
    manifest: {
      id: "pglite",
      framework: "pglite",
      icon: "postgres",
      category: "Showcase",
      name: "PostgreSQL (PGlite)",
      language: "JavaScript",
      description: "A real PostgreSQL server in the browser via PGlite (WASM) + Express — no Docker, no native deps",
      port: 3000,
      openPath: "/",
      entry: "server.js",
      hmr: false,
      reload: false,
      install: "npm install",
      dev: "npm run dev",
      // Experimental until scripts/spike-pglite.mjs is green in CI. First boot
      // compiles ~16 MB of WASM + data, so give it a few seconds in-VM.
      experimental: true,
    },
    files: {
      "package.json": `{
  "name": "pglite-demo",
  "private": true,
  "version": "0.0.0",
  "type": "commonjs",
  "scripts": { "start": "node server.js", "dev": "node server.js" },
  "dependencies": { "express": "^4.21.0", "@electric-sql/pglite": "^0.5.4" }
}
`,
      "server.js": `const express = require('express');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

async function main() {
  // In-memory Postgres. Pass a directory to persist: PGlite.create('./pgdata').
  // The ~16 MB of WASM + data are read from node_modules over the virtual FS.
  const db = await PGlite.create();
  await db.exec(
    'CREATE TABLE IF NOT EXISTS todos (' +
      'id SERIAL PRIMARY KEY, task TEXT NOT NULL, done BOOLEAN NOT NULL DEFAULT false);'
  );
  await db.exec(
    "INSERT INTO todos (task, done) VALUES ('Try Vivari', true), ('Run Postgres in the browser', false);"
  );

  const app = express();
  app.use(express.json());

  app.get('/api/info', async (_req, res) => {
    const r = await db.query('SELECT version() AS version');
    res.json({ engine: 'PostgreSQL', version: r.rows[0].version.split(' ').slice(0, 2).join(' '), driver: 'PGlite (WASM)' });
  });

  app.get('/api/todos', async (_req, res) => {
    const r = await db.query('SELECT id, task, done FROM todos ORDER BY id');
    res.json(r.rows);
  });

  app.post('/api/todos', async (req, res) => {
    const task = (req.body && req.body.task ? String(req.body.task) : '').trim();
    if (!task) return res.status(400).json({ error: 'task is required' });
    await db.query('INSERT INTO todos (task, done) VALUES ($1, false)', [task]);
    res.status(201).json({ ok: true });
  });

  app.use(express.static(path.join(__dirname, 'public')));

  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => console.log('Postgres (PGlite) demo on http://localhost:' + port));
}

main().catch((err) => { console.error(err); process.exit(1); });
`,
      "public/index.html": dbDemoHtml(
        "PostgreSQL in the browser",
        "A real PostgreSQL server (PGlite compiled to WebAssembly) running entirely in-VM.",
      ),
      "README.md": `# PostgreSQL in the browser (PGlite)

A real, full PostgreSQL server running 100% in-VM via PGlite (Postgres compiled
to WebAssembly) — no native addons, no Docker, no external server.

## Files
- server.js — Express API. PGlite.create() boots an in-memory Postgres; its
  ~16 MB of WASM + data are loaded from node_modules over the virtual filesystem.
- public/index.html — a tiny UI that reads and writes the DB through the API.

## Run
- npm install
- npm run dev   (opens http://localhost:3000 — first boot compiles the WASM, so
  give it a few seconds)

## Endpoints
- GET  /api/info   SELECT version()
- GET  /api/todos  list rows
- POST /api/todos  body: { "task": "..." }

## Persistence & extensions
PGlite.create() is in-memory. Pass a directory to persist
(PGlite.create('./pgdata')). PGlite also supports pgvector and other extensions.

Learn more: https://pglite.dev
`,
    },
  };
}

// ── Webpack (standalone) ─────────────────────────────────────────────────────
// Not Vite: webpack 5 + webpack-dev-server (connect + `ws` HMR + chokidar) +
// html-webpack-plugin. Proven headless (scripts/spike-webpack.mjs) — binds :8080
// and serves the app with live HMR.
function webpackTemplate(): TemplateDef {
  return {
    manifest: {
      id: "webpack",
      framework: "webpack",
      icon: "webpack",
      category: "Tooling",
      name: "Webpack",
      language: "JavaScript",
      description: "Webpack 5 + webpack-dev-server with hot module replacement",
      port: 8080,
      openPath: "/",
      entry: "src/index.js",
      hmr: true,
      reload: false,
      install: "npm install",
      dev: "npm run dev",
    },
    files: {
      "package.json": `{
  "name": "webpack-app",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "webpack serve --mode development",
    "build": "webpack --mode production"
  },
  "devDependencies": {
    "webpack": "^5.97.1",
    "webpack-cli": "^5.1.4",
    "webpack-dev-server": "^5.2.0",
    "html-webpack-plugin": "^5.6.3",
    "css-loader": "^7.1.2",
    "style-loader": "^4.0.0"
  }
}
`,
      "webpack.config.js": `const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");

module.exports = {
  mode: "development",
  entry: "./src/index.js",
  output: { path: path.resolve(__dirname, "dist"), filename: "main.js", clean: true },
  module: { rules: [{ test: /\\.css$/i, use: ["style-loader", "css-loader"] }] },
  plugins: [new HtmlWebpackPlugin({ template: "./src/index.html" })],
  devServer: {
    port: 8080,
    host: "127.0.0.1",
    hot: true,
    open: false,
    allowedHosts: "all",
    client: { overlay: false },
  },
};
`,
      "src/index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Webpack in Vivari</title>
  </head>
  <body>
    <h1 id="marker">Webpack in Vivari</h1>
    <p>webpack 5 + webpack-dev-server with hot module replacement</p>
    <div id="app"></div>
  </body>
</html>
`,
      "src/styles.css": `body { font-family: system-ui, sans-serif; padding: 2rem; line-height: 1.5; }
button { padding: 0.5rem 1rem; font-size: 1rem; cursor: pointer; }
`,
      "src/index.js": `import "./styles.css";

let count = 0;
const app = document.getElementById("app");
const btn = document.createElement("button");
const render = () => (btn.textContent = "count is " + count);
btn.addEventListener("click", () => { count++; render(); });
render();
app.appendChild(btn);

// Edit this file and save — webpack HMR swaps the module without a full reload.
if (module.hot) module.hot.accept();
`,
    },
  };
}

// ── Rsbuild (Rspack) ─────────────────────────────────────────────────────────
// Rsbuild is the Rust-powered (Rspack) build tool. Its Rspack core is a native
// N-API addon; on our wasm32 host in-VM npm auto-selects @rspack/binding-wasm32-
// wasi (like Vite's rolldown), and the wasm32-wasip1-threads binding runs the
// Rust bundler in the browser. Proven in-VM by scripts/spike-rspack.mjs (build +
// serve) and scripts/spike-rsbuild.mjs (`rsbuild dev` binds + serves the React app
// with a 200), both green in the CI network tier (scripts/run-spikes.mjs); HMR is
// confirmed in the studio (rides the same ws tunnel as Vite). No longer experimental.
function rsbuildTemplate(ts: boolean): TemplateDef {
  const ext = ts ? "tsx" : "jsx";
  return {
    manifest: {
      id: ts ? "rsbuild-ts" : "rsbuild",
      framework: "rsbuild",
      icon: "rsbuild",
      category: "Tooling",
      name: "Rsbuild (React)",
      language: ts ? "TypeScript" : "JavaScript",
      description: "Rspack-powered Rsbuild dev server (React) running the Rust bundler as WebAssembly",
      port: 3000,
      openPath: "/",
      entry: `src/App.${ext}`,
      hmr: true,
      reload: false,
      install: "npm install",
      dev: "npm run dev",
    },
    files: {
      "package.json": `{
  "name": "rsbuild-react${ts ? "-ts" : ""}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "rsbuild dev",
    "build": "rsbuild build",
    "preview": "rsbuild preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@rsbuild/core": "^2.1.0",
    "@rsbuild/plugin-react": "^2.1.0"${ts ? `,
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "^5.7.0"` : ""}
  }
}
`,
      // A plain .mjs config works for both variants (the app source is what's TS).
      // Rsbuild auto-detects src/index.{jsx,tsx} as the entry and injects the HTML.
      "rsbuild.config.mjs": `import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

export default defineConfig({
  plugins: [pluginReact()],
  server: { port: 3000, host: "127.0.0.1" },
  html: { title: "Rsbuild + React" },
});
`,
      [`src/index.${ext}`]: `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.${ext}";
import "./index.css";

createRoot(document.getElementById("root")${ts ? "!" : ""}).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
      [`src/App.${ext}`]: `import { useState } from "react";

export function App() {
  const [count, setCount] = useState(0);

  return (
    <main className="app">
      <h1>Rsbuild + React${ts ? " + TS" : ""}</h1>
      <div className="card">
        <button onClick={() => setCount((c${ts ? ": number" : ""}) => c + 1)}>
          count is {count}
        </button>
        <p>
          Edit <code>src/App.${ext}</code> and save to test HMR
        </p>
      </div>
      <p>Running inside Vivari — a real Rspack (Rust/Wasm) bundler in your browser.</p>
    </main>
  );
}
`,
      "src/index.css": `:root {
  font-family: system-ui, Avenir, Helvetica, Arial, sans-serif;
  line-height: 1.5;
  color-scheme: light dark;
  color: rgba(255, 255, 255, 0.87);
  background-color: #242424;
}
body { margin: 0; display: flex; place-items: center; min-height: 100vh; }
.app { max-width: 1280px; margin: 0 auto; padding: 2rem; text-align: center; }
button {
  border-radius: 8px; border: 1px solid transparent; padding: 0.6em 1.2em;
  font-size: 1em; font-weight: 500; font-family: inherit;
  background-color: #1a1a1a; color: white; cursor: pointer; transition: border-color 0.25s;
}
button:hover { border-color: #ff5d1b; }
`,
      ...(ts
        ? {
            "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src"]
}
`,
          }
        : {}),
    },
  };
}

// ── Docusaurus (standalone webpack) ──────────────────────────────────────────
// Docusaurus 3's dev server is webpack + webpack-dev-server + MDX/React. Proven
// headless (scripts/spike-docusaurus.mjs) — binds :3000 and serves the site.
// Graduated (spike green); note the install is heavy (100s+).
function docusaurusTemplate(): TemplateDef {
  return {
    manifest: {
      id: "docusaurus",
      framework: "docusaurus",
      icon: "docusaurus",
      category: "Docs",
      name: "Docusaurus",
      language: "JavaScript",
      description: "Docusaurus 3 — React docs site (webpack + MDX) with hot reload",
      port: 3000,
      openPath: "/",
      entry: "docs/intro.md",
      hmr: true,
      reload: false,
      install: "npm install",
      dev: "npm run dev",
      // Docusaurus is a client-routed SPA: it reads its route from the iframe's
      // location, which is /preview/3000/. Serve it under that base (baseUrl below)
      // and keep the proxy prefix so its router matches — otherwise the first load
      // lands on Docusaurus's NotFound page until you click a link.
      keepPreviewPrefix: true,
    },
    files: {
      "package.json": `{
  "name": "docusaurus-site",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "docusaurus start --no-open",
    "build": "docusaurus build",
    "serve": "docusaurus serve"
  },
  "dependencies": {
    "@docusaurus/core": "^3.6.0",
    "@docusaurus/preset-classic": "^3.6.0",
    "@mdx-js/react": "^3.0.0",
    "clsx": "^2.0.0",
    "prism-react-renderer": "^2.3.0",
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  }
}
`,
      "docusaurus.config.js": `module.exports = {
  title: "Docusaurus in Vivari",
  tagline: "Docs run in the browser VM",
  url: "http://localhost",
  // The Vivari preview serves this app under /preview/3000/ (see the
  // template's keepPreviewPrefix flag). Match that base so Docusaurus's client
  // router resolves routes correctly on first load and deep-links work.
  baseUrl: "/preview/3000/",
  onBrokenLinks: "ignore",
  onBrokenMarkdownLinks: "ignore",
  presets: [
    [
      "@docusaurus/preset-classic",
      {
        docs: { sidebarPath: require.resolve("./sidebars.js"), routeBasePath: "/" },
        blog: false,
        theme: { customCss: require.resolve("./src/css/custom.css") },
      },
    ],
  ],
  themeConfig: {
    navbar: { title: "Docusaurus in Vivari", items: [] },
  },
};
`,
      "sidebars.js": `module.exports = { tutorialSidebar: [{ type: "autogenerated", dirName: "." }] };
`,
      "src/css/custom.css": `:root { --ifm-color-primary: #2e8555; }
`,
      "docs/intro.md": `---
slug: /
title: Docusaurus in Vivari
---

# Docusaurus in Vivari

Hello from Vivari — a full Docusaurus dev server compiled in the browser VM.

- Write docs in Markdown / MDX
- Live hot reload as you edit
- Zero native dependencies
`,
    },
  };
}

// ── VitePress ────────────────────────────────────────────────────────────────
// VitePress (Vue-powered docs SSG on Vite) runs in-VM on the stock toolchain, but
// only after three separate in-VM gotchas are handled — all reflected in the files
// this template ships:
//
// 1. Config loading (CommonJS, not ESM). VitePress (Vite 5) loads
//    `.vitepress/config.*` via Vite's `loadConfigFromFile`, which esbuild-bundles
//    it. For an ESM config (.mts/.mjs, or a .js in a `type: module` package) Vite
//    loads the bundle with `await import(file://…temp.mjs)` — that async dynamic
//    import does NOT settle in-VM and hangs boot right after Vite's "CJS build
//    deprecated" line. So we ship a **CommonJS** `.vitepress/config.js` and a
//    package that is NOT `type: module`: Vite takes its synchronous CJS config
//    branch (`require.extensions` override + `module._compile`) — no hang.
//
// 2. worker_threads transferList. Importing VitePress spins up a synckit-backed
//    worker (`new Worker(f, { workerData: { port }, transferList: [port] })`); the
//    runtime now transfers MessagePorts embedded in workerData (see
//    packages/runtime/node/lib/worker_threads.js), so that no longer throws.
//
// 3. Shiki language pre-loading (synckit). VitePress lazily loads any not-yet-
//    registered code-block language via synckit (Atomics.wait + a worker
//    MessagePort) — which a browser worker can't drain synchronously, so an
//    on-demand load throws mid-render. The config pre-loads common languages
//    (loaded async at highlighter init, which works) so that path is never taken.
//    NOTE: the headless spike runs under Node's real worker_threads where synckit
//    works, so it canNOT catch a missing language — keep the config list in sync
//    with the languages the docs actually use.
//
// Proven headless by scripts/spike-vitepress.mjs (dev server boots + serves); the
// synckit language path is verified only in a real browser.
function vitepressTemplate(): TemplateDef {
  return {
    manifest: {
      id: "vitepress",
      framework: "vitepress",
      icon: "vitepress",
      category: "Docs",
      name: "VitePress",
      language: "JavaScript",
      description: "VitePress — Vue-powered static site generator for docs (Vite + Shiki)",
      port: 5173,
      openPath: "/",
      entry: "index.md",
      hmr: true,
      reload: false,
      install: "npm install",
      dev: "npm run dev",
      // VitePress is a client-routed SPA (history-mode router): served at "/" its
      // router lands on 404, so set Vite `base` to the preview prefix and keep it.
      keepPreviewPrefix: true,
    },
    files: {
      // NOTE: intentionally NOT "type": "module" — see the header comment. A
      // CommonJS package makes Vite load .vitepress/config.js via its synchronous
      // CJS branch (no file:// async import), which is what boots in-VM.
      "package.json": `{
  "name": "vitepress-site",
  "private": true,
  "scripts": {
    "dev": "vitepress dev --port 5173 --strictPort",
    "build": "vitepress build",
    "preview": "vitepress preview --port 5173 --strictPort"
  },
  "devDependencies": {
    "vitepress": "^1.6.0",
    "vue": "^3.5.0"
  }
}
`,
      ".vitepress/config.js": `// CommonJS config on purpose: Vite then loads it via its synchronous CJS branch
// (require.extensions + module._compile) instead of \`await import(file://…)\`,
// which hangs in-VM. See the template header comment in templates.ts.
//
// The Vivari preview serves this dev server under /preview/5173/. VitePress is a
// history-mode SPA, so set \`base\` to that prefix (paired with the template's
// keepPreviewPrefix flag) — otherwise the first load resolves to a 404 page.
module.exports = {
  base: "/preview/5173/",
  title: "VitePress in Vivari",
  description: "Docs that build and run entirely in the browser VM",
  markdown: {
    // PRE-LOAD the languages used in code blocks. VitePress lazily loads any
    // not-yet-registered language via synckit (Atomics.wait + a worker MessagePort),
    // which a browser worker can't drain synchronously — so an on-demand load throws
    // mid-render ("Cannot read properties of undefined (reading 'message')"). Listing
    // languages here loads them up front at highlighter init (async, which works in
    // the VM), so that synckit path is never taken. Add any language your docs use.
    languages: [
      "js", "ts", "jsx", "tsx", "json", "jsonc", "yaml", "bash", "shell", "sh",
      "html", "css", "scss", "vue", "python", "go", "rust", "java", "c", "cpp",
      "sql", "diff", "dockerfile", "toml", "xml", "md",
    ],
  },
  themeConfig: {
    nav: [
      { text: "Home", link: "/" },
      { text: "Guide", link: "/guide/getting-started" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [{ text: "Getting Started", link: "/guide/getting-started" }],
      },
    ],
  },
};
`,
      "index.md": `---
layout: home
hero:
  name: VitePress in Vivari
  text: Docs, in the browser VM
  tagline: Vue-powered static site generator running fully client-side
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
features:
  - title: Markdown-first
    details: Write content in Markdown with Vue components when you need them.
  - title: Instant HMR
    details: Edit a page and see it update live — no native dependencies.
  - title: Syntax highlighting
    details: Shiki highlights code blocks, compiled entirely in-VM.
---
`,
      "guide/getting-started.md": `# Getting Started

Welcome to **VitePress**, running entirely inside Vivari's in-browser VM.

Edit \`guide/getting-started.md\` and this page hot-reloads. Code blocks are
highlighted by Shiki, compiled in the VM:

\`\`\`ts
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

console.log(greet("Vivari"));
\`\`\`

- Write docs in Markdown
- Live hot reload as you edit
- Zero native dependencies
`,
    },
  };
}

// ── Angular ──────────────────────────────────────────────────────────────────
// Angular 21 runs in-VM on its stock `@angular/build` toolchain (esbuild + Vite
// dev server) from a completely vanilla project — same package.json / angular.json
// you'd get from `ng new`, so it exports and runs locally unchanged. Everything
// that makes esbuild/Rollup work in-browser lives in the runtime now, not the
// project: the fetcher aliases esbuild -> esbuild-wasm and rollup -> @rollup/
// wasm-node at the registry layer (fetcher-worker.js), the module loader runs
// esbuild-wasm's service in-process (esbuild-inproc-patch.js), and the runtime
// defaults PISCINA_DISABLE_ATOMICS so the worker pools use message passing.
function angularTemplate(): TemplateDef {
  const NG = "^21.1.0";
  const files: Record<string, string> = {
    "package.json": `{
  "name": "angular-app",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "ng": "ng",
    "start": "ng serve",
    "build": "ng build",
    "watch": "ng build --watch --configuration development"
  },
  "dependencies": {
    "@angular/common": "${NG}",
    "@angular/compiler": "${NG}",
    "@angular/core": "${NG}",
    "@angular/forms": "${NG}",
    "@angular/platform-browser": "${NG}",
    "@angular/router": "${NG}",
    "rxjs": "^7.8.1",
    "tslib": "^2.5.0"
  },
  "devDependencies": {
    "@angular/build": "${NG}",
    "@angular/cli": "${NG}",
    "@angular/compiler-cli": "${NG}",
    "typescript": "~5.9.2"
  }
}
`,
    "angular.json": `{
  "$schema": "./node_modules/@angular/cli/lib/config/schema.json",
  "version": 1,
  "cli": { "packageManager": "npm", "analytics": false },
  "newProjectRoot": "projects",
  "projects": {
    "angular-app": {
      "projectType": "application",
      "schematics": {},
      "root": "",
      "sourceRoot": "src",
      "prefix": "app",
      "architect": {
        "build": {
          "builder": "@angular/build:application",
          "options": {
            "browser": "src/main.ts",
            "tsConfig": "tsconfig.app.json",
            "index": "src/index.html",
            "styles": ["src/styles.css"]
          },
          "configurations": {
            "production": { "outputHashing": "all" },
            "development": { "optimization": false, "extractLicenses": false, "sourceMap": true }
          },
          "defaultConfiguration": "development"
        },
        "serve": {
          "builder": "@angular/build:dev-server",
          "options": { "host": "127.0.0.1", "port": 4200 },
          "configurations": {
            "production": { "buildTarget": "angular-app:build:production" },
            "development": { "buildTarget": "angular-app:build:development" }
          },
          "defaultConfiguration": "development"
        }
      }
    }
  }
}
`,
    "tsconfig.json": `{
  "compileOnSave": false,
  "compilerOptions": {
    "outDir": "./dist/out-tsc",
    "strict": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "experimentalDecorators": true,
    "moduleResolution": "bundler",
    "importHelpers": true,
    "target": "ES2022",
    "module": "preserve"
  },
  "angularCompilerOptions": { "strictTemplates": true }
}
`,
    "tsconfig.app.json": `{
  "extends": "./tsconfig.json",
  "compilerOptions": { "outDir": "./out-tsc/app", "types": [] },
  "files": ["src/main.ts"]
}
`,
    "src/index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Angular in Vivari</title>
    <base href="/" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <app-root></app-root>
  </body>
</html>
`,
    "src/main.ts": `import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';

bootstrapApplication(App).catch((err) => console.error(err));
`,
    "src/styles.css": `:root {
  color-scheme: dark;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  background: radial-gradient(1200px 600px at 50% -10%, #1a1030, #0a0a0f 60%);
  color: #ededed;
}
`,
    "src/app/app.ts": `import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-root',
  standalone: true,
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly count = signal(0);

  increment(): void {
    this.count.update((c) => c + 1);
  }
}
`,
    "src/app/app.html": `<main class="app">
  <div class="badge">Angular 21</div>
  <h1 id="marker">Angular in Vivari</h1>
  <p class="subtitle">
    esbuild-wasm + Vite dev server — compiled and served entirely in your browser.
  </p>

  <button class="counter" type="button" (click)="increment()">
    count is {{ count() }}
  </button>

  <p class="hint">
    Edit <code>src/app/app.html</code> and save — hot module replacement updates the
    page instantly.
  </p>
</main>
`,
    "src/app/app.css": `.app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  padding: 2rem;
  text-align: center;
}

.badge {
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 0.35rem 0.75rem;
  border-radius: 999px;
  background: linear-gradient(135deg, #dd0031, #c3002f);
  color: #fff;
}

h1 {
  font-size: clamp(1.8rem, 5vw, 2.75rem);
  margin: 0;
}

.subtitle {
  max-width: 34rem;
  margin: 0;
  opacity: 0.7;
  line-height: 1.5;
}

.counter {
  margin-top: 0.5rem;
  font: inherit;
  font-weight: 600;
  padding: 0.7rem 1.4rem;
  border: 1px solid #3a3a4a;
  border-radius: 0.6rem;
  background: #16161f;
  color: inherit;
  cursor: pointer;
  transition: border-color 0.15s ease, transform 0.05s ease;
}

.counter:hover {
  border-color: #dd0031;
}

.counter:active {
  transform: translateY(1px);
}

.hint {
  margin: 0;
  font-size: 0.9rem;
  opacity: 0.5;
}

code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: #ffffff14;
  padding: 0.1rem 0.35rem;
  border-radius: 0.3rem;
}
`,
  };
  return {
    manifest: {
      id: "angular",
      framework: "angular",
      icon: "angular",
      category: "Frontend",
      name: "Angular",
      language: "TypeScript",
      description: "Angular 21 (@angular/build + Vite) with hot reload",
      port: 4200,
      openPath: "/",
      entry: "src/app/app.ts",
      // Vite drives Angular's HMR over the preview websocket tunnel.
      hmr: true,
      reload: false,
      // --ignore-scripts skips any transitive native postinstall (esbuild's is
      // moot: the registry aliases it to esbuild-wasm, which has none). This is a
      // studio-side install choice; the project's package.json stays vanilla.
      install: "npm install --ignore-scripts",
      dev: "npm start",
    },
    files,
  };
}

// ── Tailwind CSS + shadcn/ui (React) ─────────────────────────────────────────
// React + Vite + Tailwind CSS v4 via the first-class `@tailwindcss/vite` plugin,
// plus a shadcn/ui-style Button: the `cn()` helper (clsx + tailwind-merge) and a
// `class-variance-authority` variant recipe. This is the flavor `npx shadcn add`
// produces, vendored so creation is instant and offline.
//
// Tailwind v4 runs in-VM because the runtime aliases the two native addons it
// reaches for: `lightningcss` -> `lightningcss-wasm` (NATIVE_WASM_ALIASES in
// packages/runtime/toolchain-shims.js — its node/require build sync-inits the
// wasm and exposes the native surface), and `@tailwindcss/oxide` resolves via its
// own `@tailwindcss/oxide-wasm32-wasi` optional dep (auto-selected by the in-VM
// npm's wasm32 platform gating). No tailwind.config / postcss.config needed: v4
// puts theme + content in src/index.css via @import/@theme.
function tailwindTemplate(): TemplateDef {
  return {
    manifest: {
      id: "tailwind",
      framework: "tailwind",
      icon: "tailwind",
      category: "Frontend",
      name: "Tailwind + shadcn/ui",
      language: "TypeScript",
      description: "React + Vite + Tailwind CSS v4 with shadcn/ui-style components",
      port: 5173,
      openPath: "/",
      entry: "src/App.tsx",
      hmr: true,
      reload: false,
      install: "npm install",
      // vite.config.js is loaded natively like every other Vite template; the
      // Tailwind plugin does its CSS work through lightningcss-wasm (aliased).
      dev: VITE_DEV,
      // Graduated: proven in-VM by scripts/spike-tailwind.mjs (lightningcss-wasm
      // alias + @tailwindcss/oxide-wasm32-wasi CSS generation, green in CI).
    },
    files: {
      "package.json": `{
  "name": "tailwind-shadcn",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "lucide-react": "^0.475.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "tailwind-merge": "^3.0.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.7.0",
    "vite": "^8.0.0"
  }
}
`,
      "vite.config.js": `import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Tailwind v4 is a first-class Vite plugin — no postcss.config / tailwind.config
// file needed; theme + content live in src/index.css via @import/@theme.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // shadcn/ui uses the "@/..." alias; mirror the tsconfig paths for Vite.
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
})
`,
      "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Tailwind + shadcn/ui</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
      "src/index.css": `@import "tailwindcss";

/* shadcn/ui design tokens (a trimmed slate theme). Reference them from Tailwind
   utilities like bg-background / text-foreground / border-border. */
@theme {
  --color-background: #ffffff;
  --color-foreground: #0f172a;
  --color-primary: #0f172a;
  --color-primary-foreground: #f8fafc;
  --color-muted: #f1f5f9;
  --color-muted-foreground: #64748b;
  --color-border: #e2e8f0;
}
`,
      "src/lib/utils.ts": `import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

// The shadcn/ui class-merge helper: dedupe/override conflicting Tailwind classes.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
`,
      "src/components/ui/button.tsx": `import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:opacity-90',
        outline: 'border border-border bg-background hover:bg-muted',
        ghost: 'hover:bg-muted',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 px-3',
        lg: 'h-11 px-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
  ),
)
Button.displayName = 'Button'
`,
      "src/App.tsx": `import { useState } from 'react'
import { Rocket } from 'lucide-react'
import { Button } from '@/components/ui/button'

export default function App() {
  const [count, setCount] = useState(0)
  return (
    <main className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-3xl font-bold tracking-tight">Tailwind + shadcn/ui on Vivari</h1>
      <p className="text-muted-foreground">Utility-first CSS with a real Vite dev server in your browser.</p>
      <div className="flex gap-3">
        <Button onClick={() => setCount((c) => c + 1)}>
          <Rocket className="size-4" /> Clicked {count} times
        </Button>
        <Button variant="outline" onClick={() => setCount(0)}>Reset</Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Edit <code className="rounded bg-muted px-1 py-0.5">src/App.tsx</code> and save to test HMR.
      </p>
    </main>
  )
}
`,
      "src/main.tsx": `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`,
      "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src"]
}
`,
      "src/vite-env.d.ts": `/// <reference types="vite/client" />
`,
    },
  };
}

// ── TanStack Router ──────────────────────────────────────────────────────────
// TanStack Router (v1) — type-safe, file-based routing for a client-side React
// SPA on plain Vite (the @tanstack/router-plugin code-gens routeTree.gen.ts).
// We ship the SPA, not TanStack Start (full-stack SSR): Start's Vite plugin
// boots a nitro server toolchain that fails to initialize in the WebContainer at
// config-load time, whereas the Router SPA is just a Vite app and runs in-VM.
//
// It is client-routed, so like React Router 7 it re-matches the route against
// the iframe's own /preview/5173/ location — keep the proxy prefix and set both
// Vite `base` and the router `basepath` (from import.meta.env.BASE_URL) to that
// prefix so asset URLs and route matching line up.
function tanstackRouterTemplate(): TemplateDef {
  return {
    manifest: {
      id: "tanstack-router",
      framework: "tanstack-router",
      icon: "tanstack",
      category: "Frontend",
      name: "TanStack Router",
      language: "TypeScript",
      description: "TanStack Router — type-safe, file-based routing for a React SPA on Vite",
      port: 5173,
      openPath: "/",
      entry: "src/routes/index.tsx",
      hmr: true,
      reload: false,
      install: "npm install",
      dev: VITE_DEV,
      keepPreviewPrefix: true,
      // Not yet gated by a scripts/spike-tanstack-router.mjs run, so shipped experimental.
      experimental: true,
    },
    files: {
      "package.json": `{
  "name": "tanstack-router-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@tanstack/react-router": "^1.130.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@tanstack/router-plugin": "^1.130.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "typescript": "^5.7.0",
    "vite": "^7.0.0"
  }
}
`,
      "vite.config.js": `import { defineConfig } from 'vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import viteReact from '@vitejs/plugin-react'

export default defineConfig({
  // The Vivari preview serves this SPA under /preview/5173/ (keepPreviewPrefix);
  // the router basepath below reads this same value from import.meta.env.BASE_URL.
  base: '/preview/5173/',
  plugins: [
    // The router plugin MUST come before React's so routeTree.gen.ts is generated
    // before the React transform runs.
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    viteReact(),
  ],
})
`,
      "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>TanStack Router</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
      "src/main.tsx": `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

// The @tanstack/router-plugin Vite plugin generates ./routeTree.gen.ts on dev start.
const router = createRouter({
  routeTree,
  // Match Vite \`base\` so client routing works under the Vivari preview prefix.
  basepath: import.meta.env.BASE_URL,
  defaultPreload: 'intent',
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
`,
      "src/routes/__root.tsx": `import { Link, Outlet, createRootRoute } from '@tanstack/react-router'

export const Route = createRootRoute({
  component: RootComponent,
})

function RootComponent() {
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif' }}>
      <nav style={{ display: 'flex', gap: '1rem', padding: '1rem' }}>
        <Link to="/">Home</Link>
        <Link to="/about">About</Link>
      </nav>
      <hr />
      <Outlet />
    </div>
  )
}
`,
      "src/routes/index.tsx": `import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  return (
    <main style={{ padding: '2rem' }}>
      <h1>TanStack Router</h1>
      <p>Type-safe, file-based routing for React — a client-side SPA on Vite.</p>
      <p>Edit <code>src/routes/index.tsx</code> and save, or add a file under <code>src/routes/</code>.</p>
    </main>
  )
}
`,
      "src/routes/about.tsx": `import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/about')({
  component: About,
})

function About() {
  return (
    <main style={{ padding: '2rem' }}>
      <h1>About</h1>
      <p>This route lives in <code>src/routes/about.tsx</code>.</p>
    </main>
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
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
`,
      "src/vite-env.d.ts": `/// <reference types="vite/client" />
`,
    },
  };
}

// ── Vitest (with UI) ─────────────────────────────────────────────────────────
// A testing starter that opens the @vitest/ui dashboard as its "preview": watch
// mode re-runs on save and the browser UI (served at /__vitest__/) shows the
// live suite. No app server — the value is the test setup itself.
//
// Two VM-specific knobs live in vitest.config.ts so this boots cleanly in-VM:
//   1. open:false — `--ui` otherwise auto-opens a browser via the `open` package,
//      which spawns xdg-open/open and dies with ENOENT in the headless VM. The
//      preview tab points at the bound UI server (:51204) instead.
//   2. pool:'threads' (singleThread) — Vitest's default `forks` pool ships its
//      "collected" task tree over the fork IPC channel, which the VM mangles, so
//      the reporter's task map comes up empty and every task-update asserts
//      "Entity must be found for task …". The worker_threads pool uses a real
//      MessageChannel (structured clone, so the circular task graph survives) —
//      the path the runtime exercises for pool libraries — and one thread keeps
//      the collected/updated events ordered.
function vitestTemplate(): TemplateDef {
  return {
    manifest: {
      id: "vitest",
      framework: "vitest",
      icon: "vitest",
      category: "Tooling",
      name: "Vitest",
      language: "TypeScript",
      description: "Unit testing with Vitest + the @vitest/ui dashboard (watch mode)",
      port: 51204,
      openPath: "/__vitest__/",
      entry: "src/sum.test.ts",
      hmr: false,
      // Watch mode re-runs the suite and the UI live-updates on every save.
      reload: true,
      install: "npm install",
      dev: "npm run test:ui",
      // Graduated: proven in-VM by scripts/spike-vitest.mjs (worker_threads pool
      // runs a suite to green and flags failures, green in CI).
    },
    files: {
      "package.json": `{
  "name": "vitest-starter",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "test": "vitest",
    "test:ui": "vitest --ui",
    "test:run": "vitest run"
  },
  "devDependencies": {
    "@vitest/ui": "^3.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
`,
      "vitest.config.ts": `import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Serve the @vitest/ui dashboard on a fixed port so the Vivari preview can
    // point at it (was --api.port on the CLI).
    api: { port: 51204 },
    // Headless VM: never auto-open a system browser. \`vitest --ui\` otherwise
    // shells out through the \`open\` package (xdg-open/open) and throws ENOENT.
    open: false,
    // Run tests on the worker_threads pool, not the default \`forks\` pool: under
    // the VM the fork IPC channel mangles Vitest's nested "collected" task tree,
    // so the reporter's task map comes up empty and every task update asserts
    // "Entity must be found for task …". worker_threads uses a real MessageChannel
    // (structured clone handles the circular task graph); one thread keeps the
    // collected/updated events ordered.
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
  },
})
`,
      "src/sum.ts": `export function sum(...values: number[]): number {
  return values.reduce((total, n) => total + n, 0)
}
`,
      "src/sum.test.ts": `import { describe, expect, it } from 'vitest'
import { sum } from './sum'

describe('sum', () => {
  it('adds two numbers', () => {
    expect(sum(1, 2)).toBe(3)
  })

  it('returns 0 for no arguments', () => {
    expect(sum()).toBe(0)
  })

  it('adds a list of numbers', () => {
    expect(sum(1, 2, 3, 4)).toBe(10)
  })
})
`,
      "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vitest/globals"]
  },
  "include": ["src"]
}
`,
    },
  };
}

// The full catalog, grouped by picker category (see TEMPLATE_CATEGORIES). The
// picker renders one tab per category; order within a category follows this list.
export const TEMPLATES: TemplateDef[] = [
  // Frontend
  reactTemplate(false),
  reactTemplate(true),
  angularTemplate(),
  vueTemplate(false),
  vueTemplate(true),
  svelteTemplate(false),
  svelteTemplate(true),
  vanillaTemplate(false),
  vanillaTemplate(true),
  staticTemplate(),
  bootstrapTemplate(),
  tailwindTemplate(),
  preactTemplate(),
  litTemplate(),
  solidTemplate(),
  qwikTemplate(),
  tanstackRouterTemplate(),
  // Backend
  expressTemplate(false),
  expressTemplate(true),
  nestTemplate(),
  koaTemplate(),
  honoTemplate(),
  h3Template(),
  fastifyTemplate(),
  nitroTemplate(),
  graphqlTemplate(),
  feathersTemplate(),
  // Bun
  bunTemplate(),
  bunRoutesTemplate(),
  bunWebSocketTemplate(),
  bunReactTemplate(),
  // Native
  pythonTemplate(),
  pythonDataScienceTemplate(),
  pythonMatplotlibTemplate(),
  fastapiTemplate(),
  flaskTemplate(),
  // Fullstack
  nextTemplate(true),
  nextTemplate(false),
  nuxtTemplate(),
  svelteKitTemplate(),
  remixTemplate(),
  astroTemplate(),
  // Docs
  slidevTemplate(),
  docusaurusTemplate(),
  vitepressTemplate(),
  // Creative
  threeTemplate(),
  gsapReactTemplate(),
  // Tooling
  nodeTemplate(),
  vitestTemplate(),
  webpackTemplate(),
  rsbuildTemplate(false),
  rsbuildTemplate(true),
  // Showcase
  fullstackTemplate(),
  sseTemplate(),
  wsDemoTemplate(),
  socketioTemplate(),
  trpcTemplate(),
  monorepoTemplate(),
  sqliteTemplate(),
  pgliteTemplate(),
];

export function getTemplate(id: string): TemplateDef | undefined {
  return TEMPLATES.find((t) => t.manifest.id === id);
}