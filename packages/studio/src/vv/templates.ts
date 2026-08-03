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

// The S3 template's source is a separate module so its gate (scripts/spike-s3.mjs)
// can import the very same bytes this ships.
import { s3AppFiles } from "./s3-app-source.js";

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

// ── Amazon S3 explorer (Node) ────────────────────────────────────────────────
// The app source lives in ./s3-app-source.js so the template and its gate
// (scripts/spike-s3.mjs) ship the same bytes — a copy here would drift, and the
// spike would keep passing against code nobody runs.
function s3Template(): TemplateDef {
  return {
    manifest: {
      id: "s3",
      framework: "express",
      icon: "s3",
      category: "Backend",
      name: "Amazon S3",
      language: "JavaScript",
      description: "Browse, upload and download an S3 bucket with your own keys",
      port: 3000,
      openPath: "/",
      entry: "src/server.js",
      hmr: false,
      reload: false,
      install: "npm install",
      dev: "node src/server.js",
      // Gated by scripts/spike-s3.mjs, which drives the app against an in-VM S3
      // that verifies SigV4 byte for byte — including a 12 MB multipart upload
      // and a wrong secret it must reject.
    },
    files: s3AppFiles(),
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
function bunBuildTemplate(): TemplateDef {
  return {
    manifest: {
      id: "bun-build",
      framework: "bun",
      icon: "bun",
      category: "Bun",
      name: "bundler",
      language: "TypeScript",
      description: "Bun.build — bundle a multi-module TypeScript project, with plugins, in the terminal",
      // No server: this one bundles, reports, runs the output and exits.
      port: 3000,
      openPath: "/",
      entry: "build.ts",
      hmr: false,
      reload: false,
      install: "bun install",
      dev: "bun run build.ts",
      // The bundler is proven by scripts/spike-bun-offline.mjs and
      // scripts/spike-bun.mjs; these exact bytes by scripts/spike-bun-templates.mjs.
    },
    files: {
      "package.json": `{
  "name": "bun-build-app",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "module": "build.ts",
  "scripts": { "build": "bun run build.ts", "dev": "bun run build.ts" },
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
      "src/greet.ts": `export const greet = (name: string): string => "Hello, " + name + "!";
`,
      "src/inventory.ts": `// A second module, so the bundle has a real (if small) dependency graph.
export interface Part {
  name: string;
  qty: number;
}

export const PARTS: Part[] = [
  { name: "flux capacitor", qty: 1 },
  { name: "sprocket", qty: 12 },
  { name: "grommet", qty: 40 },
];

export function totalUnits(parts: Part[]): number {
  return parts.reduce((sum, p) => sum + p.qty, 0);
}
`,
      "src/index.ts": `import { greet } from "./greet";
import { PARTS, totalUnits } from "./inventory";

// Replaced at build time by \`define\` — see build.ts.
declare const BUILD_STAMP: string;

export function main(): void {
  console.log(greet("Vivari"));
  console.log("parts: " + PARTS.length + ", units: " + totalUnits(PARTS));
  console.log("built at: " + BUILD_STAMP);
}

main();
`,
      "build.ts": `// Bun.build — a real dependency-graph bundler, running in your browser. It reads
// the TypeScript in src/, follows the imports, strips the types and emits one
// JavaScript file. Docs: https://bun.com/docs/bundler
import { build, file } from "bun";

const stamp = new Date().toISOString();

// A plugin: intercept and rewrite modules as they are loaded. This one is a
// no-op that just reports what the bundler asked for, which is the easiest way
// to see the graph being walked.
const seen: string[] = [];
const auditPlugin = {
  name: "audit",
  setup(builder: any) {
    builder.onLoad({ filter: /\\.ts$/ }, async (args: { path: string }) => {
      seen.push(args.path.split("/").pop() ?? args.path);
      return { contents: await file(args.path).text(), loader: "ts" };
    });
  },
};

console.log("── bundling ────────────────────────────────────────────────────");
const result = await build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "browser",
  // Compile-time constants. BUILD_STAMP is declared in src/index.ts and only
  // exists because of this line.
  define: { BUILD_STAMP: JSON.stringify(stamp) },
  plugins: [auditPlugin],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("build failed");
}

console.log("success: " + result.success);
console.log("modules the plugin saw: " + seen.join(", "));
for (const out of result.outputs) {
  console.log("  " + out.path + "  (" + out.size + " bytes, kind=" + out.kind + ")");
}

console.log("\\n── a second entry point, with a dependency left external ─────");
// \`external\` tells the bundler to leave an import alone rather than following
// it — the usual way to keep a runtime dependency out of a library bundle.
const lib = await build({
  entrypoints: ["./src/greet.ts", "./src/inventory.ts"],
  outdir: "./dist-lib",
  target: "bun",
  external: ["node:fs"],
});
for (const out of lib.outputs) {
  console.log("  " + out.path + "  (" + out.size + " bytes)");
}

console.log("\\n── options this bundler refuses ─────────────────────────────────");
// Vivari's bundler THROWS on these rather than ignoring them, because a build that
// reported success without honouring them would hand you an artifact that is wrong
// in a way nothing tells you about. Real Bun implements all three, so this same
// script prints the other line there — which is the point: the script tells you
// which runtime you are on instead of guessing. Need them here? esbuild-wasm,
// rolldown and rspack all install and run in Vivari.
for (const option of ["minify", "splitting", "sourcemap"] as const) {
  try {
    await build({ entrypoints: ["./src/index.ts"], outdir: "./dist-x", [option]: true });
    console.log("  " + option + ": implemented by this runtime");
  } catch {
    console.log("  " + option + ": refused here, deliberately — not silently ignored");
  }
}

console.log("\\n── running the bundle ──────────────────────────────────────────");
// The output is ordinary JavaScript, so just run it. Everything it prints below
// came out of the bundle, not out of src/.
await import("./dist/index.js");

console.log("\\nBUILD DEMO COMPLETE — bundled and executed inside your browser.");
`,
    },
  };
}

function bunApisTemplate(): TemplateDef {
  return {
    manifest: {
      id: "bun-apis",
      framework: "bun",
      icon: "bun",
      category: "Bun",
      name: "API tour",
      language: "TypeScript",
      description: "A tour of Bun's standard library: files, hashing, passwords, YAML/TOML, Glob, semver, Transpiler, Workers",
      // No server: this one prints a tour and exits.
      port: 3000,
      openPath: "/",
      entry: "tour.ts",
      hmr: false,
      reload: false,
      install: "bun install",
      dev: "bun run tour.ts",
      // Every API below has unit coverage in scripts/spike-bun-offline.mjs; these
      // exact bytes are run by scripts/spike-bun-templates.mjs.
    },
    files: {
      "package.json": `{
  "name": "bun-apis-app",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "module": "tour.ts",
  "scripts": { "start": "bun run tour.ts", "dev": "bun run tour.ts" },
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
      // A second entry point, run on a REAL thread by section 10 of the tour. It is
      // a plain TypeScript file with no build step: the thread boots it through the
      // same `bun run` path the main script took, so it has its own Bun global.
      "hash.worker.ts": `declare var self: any;

// Deliberately slow work - the kind that would freeze a UI if it ran on the main
// thread. Here it runs beside it.
function expensiveDigest(text: string): string {
  let digest = text;
  for (let i = 0; i < 500; i++) digest = Bun.sha(digest, "hex");
  return digest;
}

self.onmessage = (event: MessageEvent) => {
  const job = event.data;
  postMessage({
    id: job.id,
    digest: expensiveDigest(job.text).slice(0, 16),
    thread: require("worker_threads").threadId,
  });
};
`,
      "config.yaml": `service: checkout
replicas: 3
features:
  - fast-path
  - retries
limits:
  cpu: 500m
  memory: 256Mi
`,
      "config.toml": `title = "Checkout"

[owner]
name = "Platform"
oncall = true

[limits]
rps = 250
`,
      "tour.ts": `// A tour of Bun's standard library, running on Vivari's Bun shim in your
// browser. Every line below does real work — nothing here is stubbed.
import { file, write, hash, password, semver, Glob, stringWidth, stripANSI, color, CryptoHasher, Transpiler, nanoseconds, inspect } from "bun";

const rule = (title: string) => console.log("\\n── " + title + " " + "─".repeat(Math.max(0, 60 - title.length)));

rule("1. files");
// Bun.file() is lazy — nothing is read until you ask for the contents.
await write("notes/hello.txt", "written by Bun.write\\n");
const f = file("notes/hello.txt");
console.log("size:", f.size, "bytes, type:", f.type);
console.log("text:", JSON.stringify(await f.text()));
console.log("exists (missing file):", await file("notes/nope.txt").exists());

rule("2. hashing");
// Bun.hash is a fast NON-cryptographic hash (wyhash) for cache keys and the like.
console.log("Bun.hash:", hash("the quick brown fox").toString());
console.log("wyhash  :", Bun.hash.wyhash("the quick brown fox").toString());
console.log("crc32   :", Bun.hash.crc32("the quick brown fox"));
// CryptoHasher is the cryptographic one.
console.log("sha256  :", new CryptoHasher("sha256").update("the quick brown fox").digest("hex"));
console.log("blake2b :", new CryptoHasher("blake2b256").update("the quick brown fox").digest("hex").slice(0, 32) + "…");

rule("3. passwords");
// Real argon2id, with cost parameters kept low so the demo stays snappy.
const hashed = await password.hash("correct horse battery staple", {
  algorithm: "argon2id",
  memoryCost: 1024,
  timeCost: 2,
});
console.log("stored :", hashed.slice(0, 48) + "…");
console.log("verify (right password):", await password.verify("correct horse battery staple", hashed));
console.log("verify (wrong password):", await password.verify("hunter2", hashed));

rule("4. config formats");
// YAML, TOML, JSON5 and JSONC parse with no dependency to install.
const yaml = Bun.YAML.parse(await file("config.yaml").text()) as Record<string, unknown>;
console.log("YAML :", JSON.stringify(yaml));
const toml = Bun.TOML.parse(await file("config.toml").text()) as Record<string, unknown>;
console.log("TOML :", JSON.stringify(toml));

rule("5. semver");
console.log("1.2.3 satisfies ^1.0.0 :", semver.satisfies("1.2.3", "^1.0.0"));
console.log("2.0.0 satisfies ^1.0.0 :", semver.satisfies("2.0.0", "^1.0.0"));
console.log("sorted                 :", ["1.10.0", "1.2.0", "1.9.9"].sort(semver.order).join(" < "));

rule("6. globs");
// Glob.scan walks the real filesystem; .match() is a pure string test.
const glob = new Glob("**/*.{ts,yaml}");
const matches: string[] = [];
for await (const path of glob.scan(".")) matches.push(path);
console.log("scan('.') :", matches.sort().join(", "));
console.log("match     :", glob.match("tour.ts"), glob.match("notes/hello.txt"));

rule("7. terminal text");
// stringWidth counts DISPLAY columns, not code units — wide CJK glyphs are 2.
console.log("width of 'hello'   :", stringWidth("hello"));
console.log("width of '日本語'  :", stringWidth("日本語"));
const painted = color("#f472b6", "ansi") + "pink text" + "\\u001b[0m";
console.log("coloured           :", painted);
console.log("stripANSI          :", JSON.stringify(stripANSI(painted)));
console.log(inspect.table([
  { api: "Bun.file", sync: false },
  { api: "Bun.hash", sync: true },
]));

rule("8. the transpiler");
// Bun.Transpiler answers "what does this file import and export" without
// resolving or running any of it.
const t = new Transpiler({ loader: "ts" });
const source = 'import { readFile } from "node:fs/promises";\\nexport const ready = true;\\nexport default 42;';
const scanned = t.scan(source);
console.log("imports:", JSON.stringify(scanned.imports));
console.log("exports:", JSON.stringify(scanned.exports));
console.log("stripped:", JSON.stringify(t.transformSync("const x: number = 1;")));

rule("9. timing");
// A monotonic nanosecond clock, measured from process start.
const t0 = nanoseconds();
for (let i = 0; i < 1e5; i++) Math.sqrt(i);
console.log("100k sqrt took", ((nanoseconds() - t0) / 1e6).toFixed(2), "ms");

rule("10. threads");
// Bun's Worker, not the browser's. The specifier resolves against THIS project's
// files rather than the page's origin, and the thread is a real one: it runs
// TypeScript, gets its own Bun global, and hashes on a second core while the main
// thread stays free.
const worker = new Worker("./hash.worker.ts");
const pending = new Map();
worker.onmessage = (event: MessageEvent) => {
  const reply = event.data;
  const resolve = pending.get(reply.id);
  if (resolve) resolve(reply);
};
const hashOn = (id: number, text: string) =>
  new Promise((resolve) => {
    pending.set(id, resolve);
    // Sent before the worker reports "open" - messages are queued, not dropped.
    worker.postMessage({ id, text });
  });

const replies: any[] = await Promise.all([hashOn(1, "alpha"), hashOn(2, "beta"), hashOn(3, "gamma")]);
for (const reply of replies) {
  console.log("job " + reply.id + " -> " + reply.digest + " (thread " + reply.thread + ")");
}
console.log("this thread is the main one:", Bun.isMainThread);
// A worker holding a message listener stays alive until it is told otherwise.
const closeCode = await new Promise((resolve) => {
  worker.addEventListener("close", (event: any) => resolve(event.code));
  worker.terminate();
});
console.log("worker closed with code:", closeCode);

console.log("\\nTOUR COMPLETE — every API above ran inside your browser.");
`,
    },
  };
}

function bunShellTemplate(): TemplateDef {
  return {
    manifest: {
      id: "bun-shell",
      framework: "bun",
      icon: "bun",
      category: "Bun",
      name: "shell",
      language: "TypeScript",
      description: "Bun.$ — cross-platform shell scripting with pipes, redirects and typed output, in the terminal",
      // No server: this one runs a script and exits. The port is unused.
      port: 3000,
      openPath: "/",
      entry: "script.ts",
      hmr: false,
      reload: false,
      install: "bun install",
      dev: "bun run script.ts",
      // Bun.$ is proven by scripts/spike-bun.mjs; these exact bytes by
      // scripts/spike-bun-templates.mjs.
    },
    files: {
      "package.json": `{
  "name": "bun-shell-app",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "module": "script.ts",
  "scripts": { "start": "bun run script.ts", "dev": "bun run script.ts" },
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
      "script.ts": `// Bun.$ — shell scripting without leaving TypeScript. The commands below are
// real processes in Vivari's process table, not string parsing.
// Docs: https://bun.com/docs/runtime/shell
//
// One honest note before you start: a browser has no /usr/bin. Vivari ships a
// small set of commands — cat, echo, ls, mkdir, pwd, rm, sh, true, false, plus
// bun/bunx/node/npx and the Python family — and nothing else resolves. That is
// less of a limit than it sounds, because the Bun answer to "I need sort/uniq/awk"
// is to do it in TypeScript, which is exactly what the pipeline in step 4 does.
import { $, file, write } from "bun";

// \`import { $ } from "bun"\` and the \`Bun.$\` global are the same function; the
// import is what Bun's own docs use, so that is what this template uses.

console.log("── 1. running a command ─────────────────────────────────────────");
// Awaiting the template tag runs it and streams its output straight through.
await $\`echo Hello from a real subprocess\`;

console.log("\\n── 2. capturing output instead of printing it ───────────────────");
// .text() captures stdout as a string; .quiet() keeps it off your terminal.
const listing = await $\`ls -1\`.text();
console.log("files here: " + listing.trim().split("\\n").join(", "));

console.log("\\n── 3. interpolation is ESCAPED, not concatenated ────────────────");
// An interpolated value is passed as ONE argument even with spaces in it, so
// there is no quoting to get wrong and nothing to inject.
const awkward = "a file with spaces.txt";
await write(awkward, "written by Bun.write\\n");
console.log((await $\`cat \${awkward}\`.text()).trim());

console.log("\\n── 4. pipes ────────────────────────────────────────────────────");
// The right-hand side of a pipe can be another Bun script. Text processing in
// TypeScript beats remembering awk syntax, and it is the same everywhere.
await write("fruit.txt", "banana\\napple\\ncherry\\napple\\nbanana\\n");
const unique = await $\`cat fruit.txt | bun run tools/uniq.ts\`.text();
console.log("unique, sorted: " + unique.trim().split("\\n").join(" "));

console.log("\\n── 5. redirects ────────────────────────────────────────────────");
// Redirect into a file, then read it back through Bun.file.
await $\`echo written by a redirect > out.txt\`;
console.log("out.txt says: " + (await file("out.txt").text()).trim());

console.log("\\n── 6. exit codes ───────────────────────────────────────────────");
// A non-zero exit THROWS by default — the thing every hand-rolled exec wrapper
// forgets. .nothrow() opts out and hands you the code instead.
try {
  await $\`false\`.quiet();
  console.log("unreachable");
} catch {
  console.log("a failing command threw, as it should");
}
const probe = await $\`false\`.nothrow().quiet();
console.log("with .nothrow() the exit code is " + probe.exitCode);

console.log("\\n── 7. environment and working directory ────────────────────────");
const greeting = await $\`bun run tools/env.ts\`.env({ ...process.env, GREETING: "set for one command" }).text();
console.log("GREETING = " + greeting.trim());

await $\`mkdir -p workspace/nested\`;
const where = await $\`pwd\`.cwd("workspace/nested").text();
console.log("pwd inside .cwd() = " + where.trim());

console.log("\\n── 8. a real task ──────────────────────────────────────────────");
// Line-count every TypeScript file in this project.
const names = (await $\`ls -1\`.text()).trim().split("\\n").filter((f) => f.endsWith(".ts"));
for (const name of names.sort()) {
  const lines = (await file(name).text()).split("\\n").length;
  console.log("  " + String(lines).padStart(4) + "  " + name);
}

console.log("\\nSHELL DEMO COMPLETE — every command above ran inside your browser.");
`,
      "tools/uniq.ts": `// The right-hand side of the pipe in step 4. Reads stdin, dedupes, sorts —
// the job you would hand to \\\`sort | uniq\\\` on a machine that had them.
const input: string = await Bun.stdin.text();
const lines = input.split("\\n").map((l) => l.trim()).filter(Boolean);
for (const line of [...new Set(lines)].sort()) console.log(line);
`,
      "tools/env.ts": `// Prints one variable, to show that .env() applies to that command only.
console.log(process.env.GREETING ?? "(unset)");
`,
    },
  };
}

function bunSqliteTemplate(): TemplateDef {
  const HOME = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>bun:sqlite · Vivari</title>
    <style>${bunPageStyles()}</style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Vivari · bun:sqlite</p>
      <h1>Real SQLite</h1>
      <p class="sub">
        This is not an in-memory fake. It is SQLite compiled to WebAssembly, writing a
        <code>notes.sqlite</code> file to the virtual filesystem — so your rows survive a reload,
        and a page refresh re-reads them with <code>SELECT</code>.
      </p>
      <div class="card">
        <h2>Add a note</h2>
        <label for="title">Title</label>
        <input id="title" placeholder="Something worth remembering" />
        <label for="body">Body</label>
        <input id="body" placeholder="…" />
        <button id="add">INSERT</button>
        <p class="status" id="status"></p>
      </div>
      <div class="card">
        <h2>Rows <code>SELECT * FROM notes ORDER BY id DESC</code></h2>
        <pre id="rows">Loading…</pre>
        <button id="refresh">Re-run the query</button>
        <button id="clear">DELETE FROM notes</button>
      </div>
      <div class="card">
        <h2>Query plan <code>EXPLAIN QUERY PLAN</code></h2>
        <pre id="plan">…</pre>
      </div>
    </main>
    <script>
      (function () {
        // In the Vivari preview the page lives under /preview/<port>/, so every
        // request is prefixed with that explicit proxy path.
        var pm = location.pathname.match(/^(\\/preview\\/\\d+)\\//);
        var base = pm ? pm[1] : '';
        var statusEl = document.getElementById('status');

        function j(path, opts) {
          return fetch(base + path, opts).then(function (r) {
            return r.json().then(function (b) { return { ok: r.ok, body: b }; });
          });
        }
        function refresh() {
          j('/api/notes').then(function (o) {
            document.getElementById('rows').textContent = JSON.stringify(o.body.rows, null, 2);
            document.getElementById('plan').textContent = o.body.plan.join('\\n');
          });
        }
        document.getElementById('add').addEventListener('click', function () {
          var title = document.getElementById('title').value;
          var body = document.getElementById('body').value;
          if (!title) { statusEl.textContent = 'A title is required (NOT NULL).'; statusEl.className = 'status err'; return; }
          j('/api/notes', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: title, body: body }),
          }).then(function (o) {
            statusEl.textContent = o.ok ? 'Inserted row id ' + o.body.id : 'Failed: ' + o.body.error;
            statusEl.className = 'status ' + (o.ok ? 'ok' : 'err');
            document.getElementById('title').value = '';
            document.getElementById('body').value = '';
            refresh();
          });
        });
        document.getElementById('refresh').addEventListener('click', refresh);
        document.getElementById('clear').addEventListener('click', function () {
          j('/api/notes', { method: 'DELETE' }).then(function () {
            statusEl.textContent = 'Table emptied.';
            statusEl.className = 'status';
            refresh();
          });
        });
        refresh();
      })();
    </script>
  </body>
</html>
`;
  return {
    manifest: {
      id: "bun-sqlite",
      framework: "bun",
      icon: "bun",
      category: "Bun",
      name: "SQLite",
      language: "TypeScript",
      description: "bun:sqlite — a real SQLite database on the virtual filesystem, behind a Bun.serve CRUD API",
      port: 3000,
      openPath: "/",
      entry: "db.ts",
      hmr: false,
      reload: false,
      install: "bun install",
      dev: "bun run index.ts",
      // The engine, the custom VFS and the statement API are proven by
      // scripts/spike-bun.mjs; these exact files by scripts/spike-bun-templates.mjs.
    },
    files: {
      "package.json": `{
  "name": "bun-sqlite-app",
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
      "db.ts": `// The data layer. \`bun:sqlite\` is real SQLite compiled to WebAssembly, talking
// to a VFS backed by Vivari's synchronous filesystem — so \`notes.sqlite\` below is
// an actual file you can see in the explorer, and it is still there after a
// reload. Docs: https://bun.com/docs/api/sqlite
import { Database } from "bun:sqlite";

export interface Note {
  id: number;
  title: string;
  body: string;
  created_at: string;
}

export const db = new Database("notes.sqlite");

// WAL is the usual advice for concurrent readers. Vivari has no file locking, so
// it is a no-op here rather than a lie — left in because it is what you would
// write against real Bun, and it does not fail.
db.run("PRAGMA journal_mode = WAL");

db.run(\`CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)\`);
db.run("CREATE INDEX IF NOT EXISTS notes_created_at ON notes (created_at)");

// Prepared once, reused for every request — the statement is compiled by SQLite
// a single time and only the bound parameters change.
const insertNote = db.prepare("INSERT INTO notes (title, body) VALUES (?, ?) RETURNING id");
const selectAll = db.query<Note, []>("SELECT id, title, body, created_at FROM notes ORDER BY id DESC");
const deleteAll = db.prepare("DELETE FROM notes");

export function listNotes(): Note[] {
  return selectAll.all();
}

export function addNote(title: string, body: string): number {
  const row = insertNote.get(title, body) as { id: number };
  return row.id;
}

export function clearNotes(): void {
  deleteAll.run();
}

/** Proof the index above is really used, straight from SQLite's planner. */
export function queryPlan(): string[] {
  const rows = db
    .query("EXPLAIN QUERY PLAN SELECT id, title FROM notes ORDER BY created_at DESC")
    .all() as Array<{ detail: string }>;
  return rows.map((r) => r.detail);
}

// A transaction is all-or-nothing: if the callback throws, every statement in it
// is rolled back. Seeding an empty table is the natural place to show it.
const seed = db.transaction((rows: Array<[string, string]>) => {
  for (const [title, body] of rows) insertNote.get(title, body);
  return rows.length;
});

export function seedIfEmpty(): number {
  const { n } = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM notes").get()!;
  if (n > 0) return 0;
  return seed([
    ["Rows survive a reload", "This file lives in the VFS, not in memory."],
    ["Prepared statements", "Compiled once by SQLite, re-bound per call."],
    ["Transactions roll back", "Throw inside db.transaction() and nothing lands."],
  ]);
}
`,
      "index.ts": `// A CRUD API over bun:sqlite, served by Bun.serve. Every route below runs a
// real SQL statement; nothing is faked or held in a JS array.
import { addNote, clearNotes, listNotes, queryPlan, seedIfEmpty } from "./db";

const HOME: string = ${JSON.stringify(HOME)};

const seeded = seedIfEmpty();
if (seeded > 0) console.log("Seeded " + seeded + " notes (the table was empty).");

const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  routes: {
    "/api/notes": {
      GET: () => Response.json({ rows: listNotes(), plan: queryPlan() }),

      POST: async (req: Request) => {
        const { title, body } = (await req.json()) as { title?: string; body?: string };
        // The NOT NULL constraint is SQLite's, so let it be the one to complain.
        if (!title) return Response.json({ error: "title is required" }, { status: 400 });
        return Response.json({ id: addNote(title, body ?? "") }, { status: 201 });
      },

      DELETE: () => {
        clearNotes();
        return new Response(null, { status: 204 });
      },
    },
  },
  fetch() {
    return new Response(HOME, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

console.log("bun:sqlite demo on http://localhost:" + server.port);
console.log("Rows are in notes.sqlite — open the file explorer, or reload and watch them persist.");
`,
    },
  };
}

function bunTestTemplate(): TemplateDef {
  return {
    manifest: {
      id: "bun-test",
      framework: "bun",
      icon: "bun",
      category: "Bun",
      name: "test",
      language: "TypeScript",
      description: "bun:test — describe/expect, mocks, spies, parameterised cases and snapshots, in the terminal",
      // No server: this one runs a test suite and exits. The port is unused
      // (nothing binds it), same as the Python templates.
      port: 3000,
      openPath: "/",
      entry: "src/cart.test.ts",
      hmr: false,
      reload: false,
      install: "bun install",
      dev: "bun test",
      // The runner itself is proven by scripts/spike-bun-offline.mjs (matchers,
      // mocks, lifecycle) and scripts/spike-bun.mjs (in-VM discovery + exit
      // code); THIS file's exact bytes are run by scripts/spike-bun-templates.mjs.
    },
    files: {
      "package.json": `{
  "name": "bun-test-app",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "bun test", "dev": "bun test" },
  "devDependencies": { "@types/bun": "latest" }
}
`,
      "tsconfig.json": `{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "types": ["bun-types"],
    "skipLibCheck": true
  }
}
`,
      "src/cart.ts": `// The code under test. Nothing Bun-specific — the point is that the RUNNER is
// Bun's, running in your browser.
export interface Item {
  sku: string;
  price: number;
  qty: number;
}

export class Cart {
  private items: Item[] = [];

  add(sku: string, price: number, qty = 1): this {
    if (qty < 1) throw new RangeError("qty must be at least 1");
    const existing = this.items.find((i) => i.sku === sku);
    if (existing) existing.qty += qty;
    else this.items.push({ sku, price, qty });
    return this;
  }

  remove(sku: string): this {
    this.items = this.items.filter((i) => i.sku !== sku);
    return this;
  }

  get lines(): Item[] {
    return [...this.items];
  }

  subtotal(): number {
    return this.items.reduce((sum, i) => sum + i.price * i.qty, 0);
  }

  /** Rounded to cents so floating point never leaks into an assertion. */
  total(taxRate = 0): number {
    return Math.round(this.subtotal() * (1 + taxRate) * 100) / 100;
  }
}

/** Deliberately async, to show off awaiting inside a test. */
export async function fetchPrice(sku: string, lookup: (sku: string) => Promise<number>): Promise<number> {
  const price = await lookup(sku);
  if (!Number.isFinite(price)) throw new Error("no price for " + sku);
  return price;
}
`,
      "src/cart.test.ts": `// bun:test, running on Vivari's Bun shim. \`bun test\` discovers *.test.ts,
// transpiles the types away and runs them — no jest, no ts-node, no config.
//
//   bun test                     run everything
//   bun test -t "applies tax"    only tests whose name matches
//   bun test --bail              stop at the first failure
//
// Docs: https://bun.com/docs/cli/test
import { describe, expect, test, beforeEach, afterAll, mock, spyOn } from "bun:test";
import { Cart, fetchPrice } from "./cart";

describe("Cart", () => {
  let cart: Cart;

  // Runs before each test in this block, so no test can be polluted by another.
  beforeEach(() => {
    cart = new Cart();
  });

  test("starts empty", () => {
    expect(cart.lines).toEqual([]);
    expect(cart.subtotal()).toBe(0);
  });

  test("adds a line and totals it", () => {
    cart.add("KEYBOARD", 79.5).add("MOUSE", 25);
    expect(cart.lines).toHaveLength(2);
    expect(cart.subtotal()).toBeCloseTo(104.5);
  });

  test("merges a repeated sku instead of duplicating it", () => {
    cart.add("CABLE", 9, 2).add("CABLE", 9, 3);
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]).toMatchObject({ sku: "CABLE", qty: 5 });
  });

  test("chaining returns the cart itself", () => {
    expect(cart.add("A", 1)).toBe(cart);
  });

  test("rejects a nonsense quantity", () => {
    expect(() => cart.add("A", 1, 0)).toThrow(RangeError);
    expect(() => cart.add("A", 1, 0)).toThrow("qty must be at least 1");
  });

  // One case per row — the name is filled in from the arguments.
  test.each([
    [0, 100],
    [0.1, 110],
    [0.2, 120],
  ])("applies tax of %p to give %p", (rate, expected) => {
    cart.add("WIDGET", 100);
    expect(cart.total(rate)).toBe(expected);
  });

  test("remove() drops only the matching sku", () => {
    cart.add("A", 1).add("B", 2).remove("A");
    expect(cart.lines.map((l) => l.sku)).toEqual(["B"]);
  });
});

describe("mocks and spies", () => {
  test("mock() records how it was called", async () => {
    const lookup = mock(async (_sku: string) => 42);
    await expect(fetchPrice("WIDGET", lookup)).resolves.toBe(42);

    expect(lookup).toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("WIDGET");
  });

  test("a rejecting dependency surfaces as a rejection", async () => {
    const lookup = mock(async () => NaN);
    await expect(fetchPrice("GHOST", lookup)).rejects.toThrow("no price for GHOST");
  });

  test("spyOn() wraps a real method, leaving it working", () => {
    const cart = new Cart().add("A", 10);
    const spy = spyOn(cart, "subtotal");
    expect(cart.total()).toBe(10); // total() calls subtotal() internally
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("snapshots", () => {
  // The first run writes __snapshots__/cart.test.ts.snap; later runs compare
  // against it. \`bun test -u\` accepts a deliberate change.
  test("a cart serialises the way we expect", () => {
    const cart = new Cart().add("KEYBOARD", 79.5).add("MOUSE", 25, 2);
    expect(cart.lines).toMatchSnapshot();
  });
});

afterAll(() => {
  console.log("\\nEvery one of these ran inside your browser — no Node, no CI runner.");
});
`,
    },
  };
}

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
      install: "pip install -r requirements.txt",
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
pip install -r requirements.txt   # loads the vendored wheels
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
      install: "pip install -r requirements.txt",
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
pip install -r requirements.txt   # loads the vendored wheels
python main.py                    # renders plot.png
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
      install: "pip install -r requirements.txt",
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
pip install -r requirements.txt   # loads FastAPI (vendored/CDN wheels)
uvicorn main:app --port 8000      # serves the app + opens the preview
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
      install: "pip install -r requirements.txt",
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
pip install -r requirements.txt    # installs Flask from PyPI (micropip)
flask --app main run --port 8000   # serves the app + opens the preview
\`\`\`

Flask is not part of Pyodide's prebuilt wheel set, so it is installed from PyPI
via **micropip** the first time it runs — this needs network access in the
browser. Pyodide has no real sockets, so \`flask run\` is a Vivari shim that
bridges each preview request through the WSGI protocol (buffered, no streaming).
`,
    },
  };
}

// ── Native: Django (full-stack MVC on Pyodide) ───────────────────────────────
// Django's ORM, migrations, template engine and URL router, all in the tab. It is
// served over WSGI, not ASGI: Django's ASGI path goes through asgiref, which
// starts a ThreadPoolExecutor per request even for `async def` views, and the
// WASM VM has no OS threads. `gunicorn` is the Vivari shim for that (the generic
// WSGI entrypoint — see packages/kernel-host/programs/python.js).
function djangoTemplate(): TemplateDef {
  return {
    manifest: {
      id: "django",
      framework: "django",
      icon: "django",
      category: "Native",
      name: "Django",
      language: "Python",
      description: "A full-stack Django app (ORM, migrations, templates) on CPython/WASM with a live preview",
      port: 8000,
      openPath: "/",
      entry: "notes/views.py",
      hmr: false,
      reload: false,
      install: "pip install -r requirements.txt",
      dev: "gunicorn wsgi:application --bind 0.0.0.0:8000",
      experimental: true,
    },
    files: {
      "requirements.txt": `django>=5.0,<6.0
tzdata
`,
      "settings.py": `"""Django settings for the Vivari starter — one file, no project package."""

import os
from pathlib import Path

# Pyodide always has an asyncio event loop running (its WebLoop), so Django's
# async_unsafe() guard thinks every ORM call is happening inside async context
# and raises SynchronousOnlyOperation. This is Django's own documented escape
# hatch, and it is safe here for a reason specific to this environment: the WASM
# VM is single-threaded and has no OS threads, so the data race the guard exists
# to prevent cannot occur. Set before django.setup() so every entrypoint —
# wsgi.py, manage.py, the shell — inherits it.
os.environ.setdefault("DJANGO_ALLOW_ASYNC_UNSAFE", "1")

BASE_DIR = Path(__file__).resolve().parent

# Demo-only key. Generate a real one for anything you deploy.
SECRET_KEY = "django-insecure-vivari-starter-do-not-use-in-production"
DEBUG = True

# The preview is served from a Vivari-generated hostname, so accept any host.
ALLOWED_HOSTS = ["*"]
CSRF_TRUSTED_ORIGINS = ["http://localhost:8000", "https://*.vivari.run"]

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "notes",
]

# No session/auth/messages middleware: this starter has no login, and every
# middleware costs boot time on a cold Pyodide start.
MIDDLEWARE = [
    "django.middleware.common.CommonMiddleware",
]

ROOT_URLCONF = "urls"
WSGI_APPLICATION = "wsgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
            ],
        },
    },
]

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",
    }
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# Django 5 stores aware datetimes, and rendering one in a template converts it
# into TIME_ZONE via zoneinfo. The WASM build of CPython ships no timezone
# database at all — not even UTC — so zoneinfo raises unless the \`tzdata\`
# package is loaded. That is why tzdata is in requirements.txt.
USE_TZ = True
TIME_ZONE = "UTC"
`,
      "urls.py": `from django.urls import path

from notes import views

urlpatterns = [
    path("", views.index, name="index"),
    path("notes/<int:note_id>/", views.detail, name="detail"),
    path("notes/create/", views.create, name="create"),
    path("notes/<int:note_id>/pin/", views.toggle_pin, name="toggle-pin"),
    path("api/notes/", views.api_notes, name="api-notes"),
]
`,
      "wsgi.py": `"""WSGI entrypoint — what \`gunicorn wsgi:application\` imports.

Django normally expects \`manage.py migrate\` to have been run first. Every
\`python\` command in Vivari is a *fresh* Pyodide interpreter with a fresh
filesystem view, so this module brings the schema up to date itself: it is
cheap, idempotent, and it means the preview works on a single command.
"""

import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "settings")

import django
from django.core.management import call_command
from django.core.wsgi import get_wsgi_application

django.setup()

# run_syncdb creates tables for the apps that ship no migrations, so the starter
# needs no migrations/ directory checked in. Add your own with
# \`python manage.py makemigrations\` once the model settles.
call_command("migrate", run_syncdb=True, verbosity=0)

from notes.models import Note  # noqa: E402  (must follow django.setup())

if not Note.objects.exists():
    Note.objects.create(
        title="Welcome to Django on Pyodide",
        body="This whole app — ORM, templates, routing — runs in your browser tab.",
        pinned=True,
    )
    Note.objects.create(title="Add a note below", body="It is written to db.sqlite3.")

application = get_wsgi_application()
`,
      "manage.py": `#!/usr/bin/env python
"""Django's command-line utility. \`python manage.py <command>\` works in Vivari
for anything that does not need a socket or a subprocess — migrate, makemigrations,
showmigrations, shell, check. \`runserver\` does NOT: it binds a real socket, which
Pyodide has no way to do. Use \`gunicorn wsgi:application --bind 0.0.0.0:8000\`
instead — Vivari bridges that to the preview.
"""

import os
import sys


def main() -> None:
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "settings")
    from django.core.management import execute_from_command_line

    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()
`,
      "notes/__init__.py": ``,
      "notes/apps.py": `from django.apps import AppConfig


class NotesConfig(AppConfig):
    name = "notes"
`,
      "notes/models.py": `from django.db import models


class Note(models.Model):
    """A note. Django derives the table, the admin form and the migration from this."""

    title = models.CharField(max_length=120)
    body = models.TextField(blank=True)
    pinned = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-pinned", "-created_at"]

    def __str__(self) -> str:
        return self.title
`,
      "notes/views.py": `from django.http import Http404, JsonResponse
from django.shortcuts import redirect, render
from django.urls import reverse
from django.views.decorators.http import require_POST

from .models import Note


def index(request):
    notes = Note.objects.all()
    return render(request, "notes/index.html", {"notes": notes})


def detail(request, note_id: int):
    try:
        note = Note.objects.get(pk=note_id)
    except Note.DoesNotExist as exc:
        raise Http404(f"no note {note_id}") from exc
    return render(request, "notes/detail.html", {"note": note})


@require_POST
def create(request):
    title = (request.POST.get("title") or "").strip()
    if title:
        Note.objects.create(title=title, body=request.POST.get("body", ""))
    # reverse() returns a path that already carries the preview prefix, because
    # the bridge hands Vivari's X-Forwarded-Prefix to Django as SCRIPT_NAME.
    return redirect(reverse("index"))


@require_POST
def toggle_pin(request, note_id: int):
    note = Note.objects.filter(pk=note_id).first()
    if note is not None:
        note.pinned = not note.pinned
        note.save(update_fields=["pinned"])
    return redirect(reverse("index"))


def api_notes(request):
    """The ORM's .values() straight to JSON."""
    rows = list(Note.objects.values("id", "title", "body", "pinned"))
    return JsonResponse({"count": len(rows), "notes": rows})
`,
      "templates/base.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{% block title %}Django on Pyodide{% endblock %}</title>
    {% comment %}
      CSS is inline on purpose. Django resolves STATIC_URL once and then caches
      it, and that first read happens at import time — before any request has
      told Django it is mounted under /preview/<port> — so the {% templatetag
      openblock %} static {% templatetag closeblock %} tag would emit a link that
      escapes the preview. URL reversing has no such problem: it runs per
      request. See the README, and the flask-app / fastapi-dashboard templates
      for static-file serving that does work here.
    {% endcomment %}
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0; padding: 3rem 1rem; background: #0e1120; color: #eef1ff;
        font: 16px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      main {
        width: min(36rem, 100%); margin: 0 auto; background: #191e35;
        border-radius: 14px; padding: 2rem; box-shadow: 0 18px 40px rgb(0 0 0 / .35);
      }
      h1 { margin: 0 0 .25rem; font-size: 1.6rem; }
      .sub { color: #99a1c7; font-size: .9rem; }
      a { color: #7fa8ff; }
      ul.notes { list-style: none; margin: 1.5rem 0; padding: 0; display: grid; gap: .5rem; }
      ul.notes li {
        display: flex; align-items: center; gap: .7rem; padding: .6rem .8rem;
        background: rgb(255 255 255 / .04); border-radius: 9px;
      }
      ul.notes li.empty { color: #99a1c7; justify-content: center; }
      form { margin: 0; }
      form.add { display: grid; grid-template-columns: 1fr 1fr auto; gap: .5rem; }
      input {
        border: 1px solid rgb(255 255 255 / .14); border-radius: 8px; padding: .55rem .75rem;
        background: rgb(0 0 0 / .25); color: inherit;
      }
      button {
        cursor: pointer; border: 0; border-radius: 8px; padding: .45rem .9rem;
        background: #7fa8ff; color: #10132a; font-weight: 700;
      }
      ul.notes button { background: transparent; color: #ffd166; font-size: 1.1rem; padding: 0 .2rem; }
    </style>
  </head>
  <body>
    <main>{% block content %}{% endblock %}</main>
  </body>
</html>
`,
      "notes/templates/notes/index.html": `{% extends "base.html" %}

{% block title %}Notes — Django on Pyodide{% endblock %}

{% block content %}
  <h1>Notes</h1>
  <p class="sub">Django's ORM, template engine and URL router — all in your browser tab.</p>

  <ul class="notes">
    {% for note in notes %}
      <li>
        <form method="post" action="{% url 'toggle-pin' note.id %}">
          <button type="submit" title="Pin">{% if note.pinned %}★{% else %}☆{% endif %}</button>
        </form>
        {# {% url %} emits the preview-prefixed path, so links stay in the preview. #}
        <a href="{% url 'detail' note.id %}">{{ note.title }}</a>
      </li>
    {% empty %}
      <li class="empty">No notes yet.</li>
    {% endfor %}
  </ul>

  <form class="add" method="post" action="{% url 'create' %}">
    <input name="title" placeholder="Note title…" autocomplete="off" required />
    <input name="body" placeholder="Body (optional)" autocomplete="off" />
    <button type="submit">Add</button>
  </form>

  <p class="sub">JSON: <a href="{% url 'api-notes' %}">/api/notes/</a></p>
{% endblock %}
`,
      "notes/templates/notes/detail.html": `{% extends "base.html" %}

{% block title %}{{ note.title }}{% endblock %}

{% block content %}
  <h1>{{ note.title }}</h1>
  <p class="sub">
    {% if note.pinned %}Pinned · {% endif %}created {{ note.created_at }}
  </p>
  <p>{{ note.body|default:"(no body)" }}</p>
  <p><a href="{% url 'index' %}">&larr; All notes</a></p>
{% endblock %}
`,
      "README.md": `# Django starter (Pyodide)

A real **Django** project — ORM, migrations, the template engine and URL routing —
running on **CPython compiled to WebAssembly** (Pyodide), entirely in your browser.

\`\`\`bash
pip install -r requirements.txt   # installs Django from PyPI (micropip)
gunicorn wsgi:application --bind 0.0.0.0:8000
\`\`\`

\`gunicorn\` is a Vivari shim. Pyodide has no real sockets, so it boots Pyodide,
imports \`wsgi:application\`, and bridges each preview request through WSGI. It is
the generic WSGI entrypoint, so the same command works for Flask, Bottle or
Pyramid.

## Layout

| File | Role |
| --- | --- |
| \`settings.py\` | one-file settings — no project package |
| \`urls.py\` | URL routing |
| \`notes/\` | the app: model, views, templates |
| \`wsgi.py\` | entrypoint; runs \`migrate\` so one command is enough |
| \`manage.py\` | Django's CLI |

\`python manage.py <command>\` works for anything that needs no socket or
subprocess — \`check\`, \`migrate\`, \`makemigrations\`, \`showmigrations\`, \`shell\`.
**\`runserver\` does not**: it binds a real socket, which Pyodide cannot do. It
fails with \`emscripten does not support processes\`. Use \`gunicorn\` instead.

## Things that are specific to running Django in a browser

**WSGI only — not ASGI.** Django's ASGI path goes through \`asgiref\`, which starts
a \`ThreadPoolExecutor\` for every request even when your views are \`async def\`.
The WASM VM has no OS threads, so that raises \`can't start new thread\`. The WSGI
path skips \`asgiref\` entirely, which is why this starter uses \`gunicorn\` rather
than \`uvicorn\`.

**\`DJANGO_ALLOW_ASYNC_UNSAFE=1\`** is set at the top of \`settings.py\`. Pyodide
always has an asyncio event loop running, so Django's \`async_unsafe()\` guard
believes every ORM call is happening inside async context and raises
\`SynchronousOnlyOperation\`. The guard exists to prevent a data race that cannot
happen here: the VM is single-threaded.

**\`tzdata\` is in \`requirements.txt\`.** The WASM build of CPython ships no
timezone database — not even UTC — so rendering an aware datetime raises
\`ZoneInfoNotFoundError\` without it.

**CSS is inline in \`templates/base.html\`.** Django reads \`STATIC_URL\` once and
caches it, and that first read happens at import time, before any request has
told Django it is mounted under \`/preview/<port>\`. So \`{% static %}\` emits a link
that escapes the preview. URL reversing — \`{% url %}\` and \`reverse()\` — is
resolved per request and *is* prefix-correct, which is why every link and form
action here uses it. For static-file serving that works, see the \`flask-app\` and
\`fastapi-dashboard\` templates.

**\`db.sqlite3\` lives inside the VM.** Files written by a *served* app are not
mirrored back into the editor (only files written by \`python script.py\` are), so
the database will not appear in the file explorer.

Django is not part of Pyodide's prebuilt wheel set, so it is installed from PyPI
via **micropip** on first run — that needs network access in the browser.
`,
    },
  };
}

// ── Native: Flask app (Jinja + static + SQLite on Pyodide) ───────────────────
// The step up from the `flask` starter: templates, a stylesheet, a database and a
// JSON API rather than a single string response.
function flaskAppTemplate(): TemplateDef {
  return {
    manifest: {
      id: "flask-app",
      framework: "flask",
      icon: "flask",
      category: "Native",
      name: "Flask App",
      language: "Python",
      description: "A Flask app with Jinja templates, static files and SQLite on CPython/WASM",
      port: 8000,
      openPath: "/",
      entry: "main.py",
      hmr: false,
      reload: false,
      install: "pip install -r requirements.txt",
      dev: "flask --app main run --port 8000",
      experimental: true,
    },
    files: {
      "requirements.txt": `flask
`,
      "main.py": `# A realistic Flask app on CPython/WASM (Pyodide): Jinja templates, a static
# stylesheet, SQLite persistence and a JSON API — served straight into Vivari's
# preview pane.
#
# Pyodide has no real sockets, so \`flask run\` is a Vivari shim: it boots Pyodide,
# imports this module, and bridges each preview request through WSGI.
import sqlite3
from pathlib import Path

from flask import Flask, g, jsonify, redirect, render_template, request, url_for

DB = Path(__file__).with_name("tasks.db")

app = Flask(__name__)


# ---- database ---------------------------------------------------------------
# One connection per request, closed on teardown — the standard Flask pattern.
def get_db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = sqlite3.connect(DB)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_exc: object) -> None:
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db() -> None:
    with sqlite3.connect(DB) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tasks (
                id    INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT    NOT NULL,
                done  INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        (count,) = conn.execute("SELECT COUNT(*) FROM tasks").fetchone()
        if count == 0:
            conn.executemany(
                "INSERT INTO tasks (title, done) VALUES (?, ?)",
                [("Read the Flask template", 1), ("Add a task below", 0)],
            )


init_db()


# ---- pages ------------------------------------------------------------------
@app.get("/")
def index() -> str:
    tasks = get_db().execute("SELECT * FROM tasks ORDER BY id").fetchall()
    return render_template("index.html", tasks=tasks)


@app.post("/tasks")
def create_task():
    title = (request.form.get("title") or "").strip()
    if title:
        db = get_db()
        db.execute("INSERT INTO tasks (title) VALUES (?)", (title,))
        db.commit()
    # url_for() generates a path that includes the preview prefix, because the
    # bridge passes Vivari's X-Forwarded-Prefix through as WSGI SCRIPT_NAME.
    return redirect(url_for("index"))


@app.post("/tasks/<int:task_id>/toggle")
def toggle_task(task_id: int):
    db = get_db()
    db.execute("UPDATE tasks SET done = 1 - done WHERE id = ?", (task_id,))
    db.commit()
    return redirect(url_for("index"))


# ---- JSON API ---------------------------------------------------------------
@app.get("/api/tasks")
def list_tasks():
    rows = get_db().execute("SELECT * FROM tasks ORDER BY id").fetchall()
    return jsonify([dict(row) for row in rows])


@app.post("/api/tasks")
def add_task():
    payload = request.get_json(silent=True) or {}
    title = (payload.get("title") or "").strip()
    if not title:
        return jsonify(error="title is required"), 400
    db = get_db()
    cur = db.execute("INSERT INTO tasks (title) VALUES (?)", (title,))
    db.commit()
    return jsonify(id=cur.lastrowid, title=title, done=0), 201
`,
      "templates/index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Flask tasks on Pyodide</title>
    <!-- url_for() emits the preview-prefixed path, so this resolves inside the preview. -->
    <link rel="stylesheet" href="{{ url_for('static', filename='app.css') }}" />
  </head>
  <body>
    <main>
      <h1>Tasks</h1>
      <p class="sub">Flask + Jinja + SQLite, running on CPython compiled to WebAssembly.</p>

      <ul class="tasks">
        {% for task in tasks %}
          <li class="{{ 'done' if task['done'] else '' }}">
            <form method="post" action="{{ url_for('toggle_task', task_id=task['id']) }}">
              <button type="submit" aria-label="Toggle">{{ '✓' if task['done'] else '○' }}</button>
            </form>
            <span>{{ task['title'] }}</span>
          </li>
        {% else %}
          <li class="empty">Nothing here yet.</li>
        {% endfor %}
      </ul>

      <form class="add" method="post" action="{{ url_for('create_task') }}">
        <input name="title" placeholder="Add a task…" autocomplete="off" required />
        <button type="submit">Add</button>
      </form>

      <p class="sub">
        JSON API: <a href="{{ url_for('list_tasks') }}">/api/tasks</a>
      </p>
    </main>
  </body>
</html>
`,
      "static/app.css": `:root {
  color-scheme: light dark;
  --bg: #0f1225;
  --card: #191d38;
  --text: #eef0ff;
  --muted: #9aa0c9;
  --accent: #7c9cff;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: start center;
  padding: 3rem 1rem;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
}

main {
  width: min(34rem, 100%);
  background: var(--card);
  border-radius: 14px;
  padding: 2rem;
  box-shadow: 0 18px 40px rgb(0 0 0 / 0.35);
}

h1 {
  margin: 0;
  font-size: 1.6rem;
}

.sub {
  color: var(--muted);
  font-size: 0.9rem;
}

.tasks {
  list-style: none;
  margin: 1.5rem 0;
  padding: 0;
  display: grid;
  gap: 0.5rem;
}

.tasks li {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.6rem 0.8rem;
  background: rgb(255 255 255 / 0.04);
  border-radius: 9px;
}

.tasks li.done span {
  color: var(--muted);
  text-decoration: line-through;
}

.tasks li.empty {
  color: var(--muted);
  justify-content: center;
}

form {
  margin: 0;
}

button {
  cursor: pointer;
  border: 0;
  border-radius: 8px;
  padding: 0.45rem 0.9rem;
  background: var(--accent);
  color: #10132a;
  font-weight: 700;
}

.tasks button {
  background: transparent;
  color: var(--accent);
  padding: 0.1rem 0.35rem;
  font-size: 1.1rem;
}

.add {
  display: flex;
  gap: 0.5rem;
}

.add input {
  flex: 1;
  border: 1px solid rgb(255 255 255 / 0.14);
  border-radius: 8px;
  padding: 0.55rem 0.75rem;
  background: rgb(0 0 0 / 0.25);
  color: inherit;
}

a {
  color: var(--accent);
}
`,
      "README.md": `# Flask app starter (Pyodide)

A realistic **Flask** app — Jinja templates, a static stylesheet, SQLite
persistence and a JSON API — running on **CPython compiled to WebAssembly**
(Pyodide), entirely in your browser.

\`\`\`bash
pip install -r requirements.txt    # installs Flask from PyPI (micropip)
flask --app main run --port 8000   # serves the app + opens the preview
\`\`\`

Pyodide has no real sockets, so \`flask run\` is a Vivari shim: it boots Pyodide,
imports \`main:app\`, and bridges each preview request through WSGI.

## What it shows

- **Jinja templates** — \`templates/index.html\`, rendered with \`render_template\`.
- **Static files** — \`static/app.css\`, served through Flask's own static route.
- **SQLite** — a real \`tasks.db\`, one connection per request via \`g\`, closed on
  teardown.
- **Forms and a JSON API** on the same routes, with \`url_for\` for every link.

\`url_for()\` generates paths that include the preview prefix, because the bridge
passes Vivari's \`X-Forwarded-Prefix\` to Flask as the WSGI \`SCRIPT_NAME\`. Always
use it rather than hardcoding \`/…\`, or links will escape the preview frame back
to the studio.

## Limits worth knowing

Flask is not part of Pyodide's prebuilt wheel set, so it is installed from PyPI
via **micropip** on first run — that needs network access in the browser.

Requests and responses are buffered end to end: no streaming, no Server-Sent
Events, no WebSocket. \`tasks.db\` lives inside the VM and is not mirrored back
into the editor, because only files written by \`python script.py\` are.
`,
    },
  };
}

// ── Native: FastAPI CRUD (Pydantic + SQLite on Pyodide) ──────────────────────
// The step up from the `fastapi` starter: a validated CRUD resource with real
// status codes, backed by SQLite, with Swagger at /docs. Keeps one deliberately
// sync endpoint so the anyio threadpool patch stays exercised.
function fastapiCrudTemplate(): TemplateDef {
  return {
    manifest: {
      id: "fastapi-crud",
      framework: "fastapi",
      icon: "fastapi",
      category: "Native",
      name: "FastAPI CRUD",
      language: "Python",
      description: "A FastAPI CRUD service with Pydantic models, SQLite and Swagger docs on CPython/WASM",
      port: 8000,
      openPath: "/",
      entry: "main.py",
      hmr: false,
      reload: false,
      install: "pip install -r requirements.txt",
      dev: "uvicorn main:app --port 8000",
      experimental: true,
    },
    files: {
      "requirements.txt": `fastapi
`,
      "main.py": `# A FastAPI CRUD service on CPython/WASM (Pyodide): Pydantic request/response
# models, SQLite persistence, proper status codes, and the auto-generated Swagger
# UI at /docs.
#
# Pyodide has no real sockets, so \`uvicorn\` is a Vivari shim: it boots Pyodide,
# imports this module, and bridges each preview request through ASGI.
import sqlite3
from contextlib import closing
from pathlib import Path

from fastapi import FastAPI, HTTPException, status
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

DB = Path(__file__).with_name("notes.db")

app = FastAPI(
    title="Notes API",
    description="A small CRUD service running entirely in your browser.",
    version="1.0.0",
)


# ---- schema -----------------------------------------------------------------
# Pydantic models are the contract: FastAPI validates requests against them,
# serialises responses through them, and derives the OpenAPI schema from them.
class NoteIn(BaseModel):
    title: str = Field(min_length=1, max_length=120, examples=["Buy milk"])
    body: str = Field(default="", max_length=2000)


class Note(NoteIn):
    id: int


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with closing(connect()) as conn, conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS notes (
                id    INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                body  TEXT NOT NULL DEFAULT ''
            )
            """
        )
        (count,) = conn.execute("SELECT COUNT(*) FROM notes").fetchone()
        if count == 0:
            conn.execute(
                "INSERT INTO notes (title, body) VALUES (?, ?)",
                ("Welcome", "Edit main.py and the preview reloads on the next request."),
            )


init_db()


# ---- routes -----------------------------------------------------------------
# Endpoints are \`async def\` so they run directly on the event loop. A plain \`def\`
# also works — Vivari patches Starlette's threadpool to run inline, because the
# WASM VM has no OS threads — but async is the idiomatic choice.
@app.get("/", response_class=HTMLResponse, include_in_schema=False)
async def index() -> str:
    # Relative links keep navigation inside the preview (/preview/<port>/…).
    return """
    <!doctype html>
    <html>
      <head><title>Notes API</title></head>
      <body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; line-height: 1.7;">
        <h1>Notes API</h1>
        <p>A FastAPI CRUD service on CPython compiled to WebAssembly.</p>
        <ul>
          <li><a href="docs">Swagger UI</a> — try every endpoint from the browser</li>
          <li><a href="redoc">ReDoc</a></li>
          <li><a href="notes">GET /notes</a></li>
        </ul>
      </body>
    </html>
    """


@app.get("/notes", response_model=list[Note], tags=["notes"])
async def list_notes() -> list[Note]:
    with closing(connect()) as conn:
        rows = conn.execute("SELECT * FROM notes ORDER BY id").fetchall()
    return [Note(**dict(row)) for row in rows]


@app.get("/notes/{note_id}", response_model=Note, tags=["notes"])
async def read_note(note_id: int) -> Note:
    with closing(connect()) as conn:
        row = conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"no note {note_id}")
    return Note(**dict(row))


@app.post("/notes", response_model=Note, status_code=status.HTTP_201_CREATED, tags=["notes"])
async def create_note(payload: NoteIn) -> Note:
    with closing(connect()) as conn, conn:
        cur = conn.execute(
            "INSERT INTO notes (title, body) VALUES (?, ?)", (payload.title, payload.body)
        )
    return Note(id=cur.lastrowid, **payload.model_dump())


@app.put("/notes/{note_id}", response_model=Note, tags=["notes"])
async def update_note(note_id: int, payload: NoteIn) -> Note:
    with closing(connect()) as conn, conn:
        cur = conn.execute(
            "UPDATE notes SET title = ?, body = ? WHERE id = ?",
            (payload.title, payload.body, note_id),
        )
    if cur.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"no note {note_id}")
    return Note(id=note_id, **payload.model_dump())


@app.delete("/notes/{note_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["notes"])
async def delete_note(note_id: int) -> None:
    with closing(connect()) as conn, conn:
        cur = conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))
    if cur.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"no note {note_id}")


# A sync endpoint, kept deliberately: it proves the threadpool patch still works.
@app.get("/health", tags=["meta"])
def health() -> dict[str, str]:
    return {"status": "ok"}
`,
      "README.md": `# FastAPI CRUD starter (Pyodide)

A **FastAPI** CRUD service — Pydantic models, SQLite persistence, real status
codes and the auto-generated Swagger UI — running on **CPython compiled to
WebAssembly** (Pyodide), entirely in your browser.

\`\`\`bash
pip install -r requirements.txt   # loads FastAPI (vendored wheels)
uvicorn main:app --port 8000      # serves the app + opens the preview
\`\`\`

Open **\`/docs\`** in the preview and use "Try it out" to exercise every endpoint
without leaving the browser.

## What it shows

| Endpoint | |
| --- | --- |
| \`GET /notes\` | list, serialised through a Pydantic response model |
| \`POST /notes\` | validated body, \`201 Created\` |
| \`GET /notes/{id}\` | \`404\` via \`HTTPException\` when missing |
| \`PUT /notes/{id}\` | update |
| \`DELETE /notes/{id}\` | \`204 No Content\` |
| \`GET /health\` | a deliberately **sync** \`def\` endpoint |

\`/health\` is sync on purpose. Starlette would normally push a sync endpoint onto
a threadpool, which the WASM VM cannot do — Vivari patches
\`anyio.to_thread.run_sync\` to run the callable inline instead. Keeping one sync
route here means that patch is exercised, not just assumed.

FastAPI, Starlette and Pydantic all ship in Vivari's vendored Pyodide bundle, so
this template loads same-origin and works offline.

## Limits worth knowing

Endpoints are \`async def\` and run directly on the event loop. Note that
\`asyncio.run()\` does **not** work under Pyodide — it needs WebAssembly stack
switching. Use module-level \`await\` if you need to run a coroutine at import
time.

Requests and responses are buffered end to end: no streaming responses, no
Server-Sent Events, no WebSocket. \`notes.db\` lives inside the VM and is not
mirrored back into the editor, because only files written by \`python script.py\`
are.
`,
    },
  };
}

// ── Native: Data dashboard (pandas + Matplotlib into the preview) ────────────
// The Matplotlib starter writes a PNG you have to open by hand; this one renders
// the figure into an HTTP response, so the chart shows up in the preview pane.
// Everything it needs is in the vendored wheel closure, so it runs offline.
function fastapiDashboardTemplate(): TemplateDef {
  return {
    manifest: {
      id: "fastapi-dashboard",
      framework: "fastapi",
      icon: "fastapi",
      category: "Native",
      name: "Data Dashboard",
      language: "Python",
      description: "pandas + Matplotlib rendered into a live preview by FastAPI, on CPython/WASM",
      port: 8000,
      openPath: "/",
      entry: "main.py",
      hmr: false,
      reload: false,
      install: "pip install -r requirements.txt",
      dev: "uvicorn main:app --port 8000",
      experimental: true,
    },
    files: {
      "requirements.txt": `fastapi
matplotlib
pandas
`,
      "main.py": `# A data dashboard on CPython/WASM (Pyodide): pandas does the aggregation,
# Matplotlib renders the chart, and FastAPI serves it straight into the preview
# pane as a PNG — no DOM, no plotting window, no server.
#
# Everything here loads from Vivari's vendored wheels, so it runs offline.
import io

import matplotlib

matplotlib.use("Agg")  # headless: draw into a buffer, never a window

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from fastapi import FastAPI
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="Sales dashboard")

REGIONS = ["North", "South", "East", "West"]
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"]


def sales_frame() -> pd.DataFrame:
    """Deterministic sample data — same numbers on every run."""
    rng = np.random.default_rng(seed=20240501)
    data = rng.integers(low=40, high=140, size=(len(MONTHS), len(REGIONS)))
    trend = np.arange(len(MONTHS)).reshape(-1, 1) * 6
    return pd.DataFrame(data + trend, index=MONTHS, columns=REGIONS)


DF = sales_frame()


@app.get("/", response_class=HTMLResponse)
async def index() -> str:
    totals = DF.sum().sort_values(ascending=False)
    best_region = str(totals.index[0])
    rows = "\\n".join(
        f"<tr><th>{month}</th>"
        + "".join(f"<td>{int(value)}</td>" for value in DF.loc[month])
        + "</tr>"
        for month in DF.index
    )
    headers = "".join(f"<th>{region}</th>" for region in DF.columns)
    # Relative URLs keep every request inside the preview (/preview/<port>/…).
    return f"""
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Sales dashboard</title>
        <link rel="stylesheet" href="static/app.css" />
      </head>
      <body>
        <main>
          <h1>Sales dashboard</h1>
          <p class="sub">
            pandas + Matplotlib, rendered server-side on CPython/WASM.
            Best region so far: <strong>{best_region}</strong> ({int(totals.iloc[0]):,} units).
          </p>
          <img src="chart.png" alt="Monthly sales by region" width="880" />
          <table>
            <thead><tr><th></th>{headers}</tr></thead>
            <tbody>{rows}</tbody>
          </table>
          <p class="sub">Raw numbers: <a href="api/summary">/api/summary</a></p>
        </main>
      </body>
    </html>
    """


@app.get("/chart.png")
async def chart() -> Response:
    """Render the figure into memory and return the PNG bytes."""
    fig, ax = plt.subplots(figsize=(11, 4.5), dpi=110)
    for region in DF.columns:
        ax.plot(DF.index, DF[region], marker="o", linewidth=2, label=region)
    ax.set_title("Monthly sales by region")
    ax.set_xlabel("Month")
    ax.set_ylabel("Units")
    ax.grid(True, alpha=0.25)
    ax.legend(ncols=len(DF.columns), loc="upper left")
    fig.tight_layout()

    buf = io.BytesIO()
    fig.savefig(buf, format="png")
    plt.close(fig)  # release the figure; the WASM heap is not infinite
    return Response(buf.getvalue(), media_type="image/png")


@app.get("/api/summary")
async def summary() -> dict[str, object]:
    totals = DF.sum()
    return {
        "months": list(DF.index),
        "regions": list(DF.columns),
        "total_units": int(totals.sum()),
        "per_region": {region: int(value) for region, value in totals.items()},
        "best_month": str(DF.sum(axis=1).idxmax()),
    }


# StaticFiles is a Mount, so it exercises the ASGI root_path handling that makes
# mounted apps resolve correctly behind Vivari's preview proxy.
app.mount("/static", StaticFiles(directory="static"), name="static")
`,
      "static/app.css": `:root {
  color-scheme: dark;
  --bg: #10131f;
  --card: #1a1f33;
  --text: #eef1ff;
  --muted: #98a0c4;
  --accent: #6ea8ff;
}

body {
  margin: 0;
  padding: 2.5rem 1rem;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
}

main {
  width: min(60rem, 100%);
  margin: 0 auto;
}

h1 {
  margin: 0 0 0.25rem;
  font-size: 1.7rem;
}

.sub {
  color: var(--muted);
  font-size: 0.92rem;
}

img {
  width: 100%;
  height: auto;
  margin: 1.5rem 0;
  border-radius: 12px;
  background: #fff;
}

table {
  width: 100%;
  border-collapse: collapse;
  background: var(--card);
  border-radius: 12px;
  overflow: hidden;
  font-variant-numeric: tabular-nums;
}

th,
td {
  padding: 0.55rem 0.85rem;
  text-align: right;
  border-bottom: 1px solid rgb(255 255 255 / 0.06);
}

thead th {
  color: var(--muted);
  font-weight: 600;
}

tbody th {
  text-align: left;
  font-weight: 600;
}

tbody tr:last-child td,
tbody tr:last-child th {
  border-bottom: 0;
}

a {
  color: var(--accent);
}
`,
      "README.md": `# Data dashboard starter (Pyodide)

**pandas** aggregates, **Matplotlib** renders, and **FastAPI** serves the chart
straight into the preview pane as a PNG — all on **CPython compiled to
WebAssembly** (Pyodide), entirely in your browser.

\`\`\`bash
pip install -r requirements.txt   # loads the vendored wheels
uvicorn main:app --port 8000      # serves the app + opens the preview
\`\`\`

Every package here — FastAPI, pandas, Matplotlib, NumPy — ships in Vivari's
vendored Pyodide bundle, so this template loads same-origin and runs **offline**.

## What it shows

- **A chart in the preview, not a file.** The Matplotlib template writes
  \`plot.png\` and asks you to open it. Here \`/chart.png\` renders the figure into
  an in-memory buffer and returns the bytes as an \`image/png\` response, so the
  browser displays it inline.
- **The headless \`Agg\` backend.** The process runs in a Web Worker with no DOM,
  so there is no interactive plot window — \`matplotlib.use("Agg")\` is required.
  \`plt.close(fig)\` afterwards matters: the WASM heap is not infinite.
- **\`StaticFiles\`.** \`app.mount("/static", ...)\` is an ASGI \`Mount\`, which
  resolves correctly behind the preview proxy.
- **Deterministic data.** The sample frame is seeded, so the numbers are the same
  on every run and the page is safe to diff.

## Limits worth knowing

Requests and responses are buffered end to end: no streaming, no Server-Sent
Events, no WebSocket. Regenerating the chart on every request is fine at this
size, but each render costs real CPU inside the tab — cache the PNG if you make
the figure much bigger.
`,
    },
  };
}

// ── Native: Python testing (pytest) ──────────────────────────────────────────
// Terminal-first. `pytest` is a Vivari shim over `python -m pytest`, which
// synthesises sys.exit(pytest.main([...])) so the real exit code propagates.
function pythonPytestTemplate(): TemplateDef {
  return {
    manifest: {
      id: "python-pytest",
      framework: "python",
      icon: "pytest",
      category: "Native",
      name: "Testing",
      language: "Python",
      description: "A pytest suite on CPython (Pyodide) — fixtures, parametrize and real exit codes",
      port: 8000,
      openPath: "/",
      entry: "tests/test_cart.py",
      hmr: false,
      reload: false,
      install: "pip install -r requirements.txt",
      dev: "pytest -q",
      experimental: true,
    },
    files: {
      "requirements.txt": `pytest
`,
      "cart.py": `"""A tiny shopping cart — the code under test."""

from dataclasses import dataclass, field


class OutOfStock(Exception):
    """Raised when a line item asks for more than the catalogue holds."""


@dataclass(frozen=True)
class Item:
    sku: str
    price_cents: int
    stock: int


@dataclass
class Cart:
    catalogue: dict[str, Item]
    lines: dict[str, int] = field(default_factory=dict)

    def add(self, sku: str, quantity: int = 1) -> None:
        if quantity < 1:
            raise ValueError("quantity must be at least 1")
        item = self.catalogue[sku]
        wanted = self.lines.get(sku, 0) + quantity
        if wanted > item.stock:
            raise OutOfStock(f"only {item.stock} x {sku} left")
        self.lines[sku] = wanted

    def subtotal_cents(self) -> int:
        return sum(self.catalogue[sku].price_cents * n for sku, n in self.lines.items())

    def total_cents(self, discount_percent: int = 0) -> int:
        if not 0 <= discount_percent <= 100:
            raise ValueError("discount must be between 0 and 100")
        subtotal = self.subtotal_cents()
        return subtotal - round(subtotal * discount_percent / 100)
`,
      "tests/test_cart.py": `"""The suite. Run it with \`pytest -q\` in the terminal."""

import pytest

from cart import Cart, Item, OutOfStock

CATALOGUE = {
    "mug": Item("mug", price_cents=1200, stock=4),
    "tee": Item("tee", price_cents=2500, stock=2),
    "cap": Item("cap", price_cents=1800, stock=0),
}


@pytest.fixture
def cart() -> Cart:
    """A fresh cart per test — fixtures keep tests independent."""
    return Cart(catalogue=dict(CATALOGUE))


def test_empty_cart_costs_nothing(cart: Cart) -> None:
    assert cart.subtotal_cents() == 0


def test_add_accumulates_quantity(cart: Cart) -> None:
    cart.add("mug")
    cart.add("mug", 2)
    assert cart.lines == {"mug": 3}
    assert cart.subtotal_cents() == 3600


@pytest.mark.parametrize(
    ("discount", "expected"),
    [(0, 3700), (10, 3330), (50, 1850), (100, 0)],
)
def test_discount_is_applied(cart: Cart, discount: int, expected: int) -> None:
    """One test body, four cases — parametrize reports them separately."""
    cart.add("mug")
    cart.add("tee")
    assert cart.total_cents(discount) == expected


def test_cannot_oversell(cart: Cart) -> None:
    with pytest.raises(OutOfStock, match="only 2 x tee left"):
        cart.add("tee", 3)


def test_out_of_stock_item_is_never_addable(cart: Cart) -> None:
    with pytest.raises(OutOfStock):
        cart.add("cap")


@pytest.mark.parametrize("bad", [0, -1])
def test_quantity_must_be_positive(cart: Cart, bad: int) -> None:
    with pytest.raises(ValueError):
        cart.add("mug", bad)


def test_unknown_sku_raises_keyerror(cart: Cart) -> None:
    with pytest.raises(KeyError):
        cart.add("hat")
`,
      "conftest.py": `# An empty conftest.py at the project root is the conventional way to make the
# root importable from tests: pytest inserts the directory holding a conftest.py
# onto sys.path, so \`from cart import Cart\` resolves without any packaging.
`,
      "README.md": `# Python testing starter (pytest)

A **pytest** suite running on **CPython compiled to WebAssembly** (Pyodide),
entirely in your browser.

\`\`\`bash
pip install -r requirements.txt   # warms the pytest wheel
pytest -q                         # run the suite
pytest -q -k discount             # run a subset
pytest tests/test_cart.py::test_cannot_oversell
\`\`\`

\`pytest\` and \`python -m pytest\` are the same thing here: Vivari's shim
synthesises \`sys.exit(pytest.main([...]))\` and runs it, so pytest's real exit
code becomes the process exit code — 0 when green, 1 when a test fails. That
means \`pytest && echo ok\` behaves the way you would expect in a shell script.

## What it shows

\`cart.py\` is the code under test; \`tests/test_cart.py\` covers it with the four
things you reach for most:

- **fixtures** — a fresh \`Cart\` per test, so tests stay independent
- **\`@pytest.mark.parametrize\`** — one body, four discount cases, reported
  separately
- **\`pytest.raises\`** — including \`match=\` to assert on the message
- **exception types** as part of the contract (\`OutOfStock\`, \`ValueError\`,
  \`KeyError\`)

The empty \`conftest.py\` at the project root is what makes \`from cart import Cart\`
resolve: pytest puts the directory containing a \`conftest.py\` on \`sys.path\`.

## Limits worth knowing

The \`pytest\` wheel is not in Vivari's vendored bundle, so it is fetched from the
Pyodide CDN on first run — that needs network access in the browser. It is cached
afterwards.

Plugins that need processes or threads do **not** work: no \`pytest-xdist\`
(\`-n auto\`), no \`--looponfail\`. The WASM VM has neither \`fork\` nor OS threads.
Plain pure-Python plugins are fine.
`,
    },
  };
}

// ── Native: Python SQLite (stdlib only) ──────────────────────────────────────
// The only Python starter with zero dependencies: sqlite3 is compiled into the
// interpreter, so this one needs no wheel fetch and no network at all.
function pythonSqliteTemplate(): TemplateDef {
  return {
    manifest: {
      id: "python-sqlite",
      framework: "python",
      icon: "sqlite",
      category: "Native",
      name: "SQLite",
      language: "Python",
      description: "Python's stdlib sqlite3 — schema, joins and aggregates, with no wheels and no network",
      port: 8000,
      openPath: "/",
      entry: "main.py",
      hmr: false,
      reload: false,
      install: "python --version",
      dev: "python main.py",
      experimental: true,
    },
    files: {
      "main.py": `# SQLite with Python's standard library, running on CPython/WASM (Pyodide).
# sqlite3 is compiled into the interpreter, so this template needs NO wheels and
# NO network — it is the one Python starter that works fully offline.
#
# The database is a real file. Vivari mirrors files a script writes back into the
# editor, so library.db shows up in the explorer when this finishes.
import sqlite3
from pathlib import Path

DB = "library.db"

SCHEMA = """
DROP TABLE IF EXISTS loans;
DROP TABLE IF EXISTS books;
DROP TABLE IF EXISTS members;

CREATE TABLE members (
    id      INTEGER PRIMARY KEY,
    name    TEXT NOT NULL
);

CREATE TABLE books (
    id      INTEGER PRIMARY KEY,
    title   TEXT NOT NULL,
    author  TEXT NOT NULL,
    year    INTEGER NOT NULL
);

CREATE TABLE loans (
    id        INTEGER PRIMARY KEY,
    book_id   INTEGER NOT NULL REFERENCES books(id),
    member_id INTEGER NOT NULL REFERENCES members(id)
);
"""

MEMBERS = [(1, "Ada"), (2, "Grace"), (3, "Alan")]

BOOKS = [
    (1, "The Left Hand of Darkness", "Le Guin", 1969),
    (2, "A Wizard of Earthsea", "Le Guin", 1968),
    (3, "Kindred", "Butler", 1979),
    (4, "Parable of the Sower", "Butler", 1993),
    (5, "Solaris", "Lem", 1961),
]

LOANS = [(1, 1, 1), (2, 2, 1), (3, 3, 2), (4, 5, 2), (5, 4, 3)]


def main() -> None:
    with sqlite3.connect(DB) as conn:
        conn.row_factory = sqlite3.Row
        conn.executescript(SCHEMA)
        conn.executemany("INSERT INTO members (id, name) VALUES (?, ?)", MEMBERS)
        conn.executemany(
            "INSERT INTO books (id, title, author, year) VALUES (?, ?, ?, ?)", BOOKS
        )
        conn.executemany(
            "INSERT INTO loans (id, book_id, member_id) VALUES (?, ?, ?)", LOANS
        )

        print("Books per author")
        print("-" * 32)
        rows = conn.execute(
            """
            SELECT author, COUNT(*) AS n, MIN(year) AS earliest
            FROM books
            GROUP BY author
            ORDER BY n DESC, author
            """
        ).fetchall()
        for row in rows:
            print(f"  {row['author']:<8} {row['n']} book(s), earliest {row['earliest']}")

        print()
        print("Who borrowed what (a join)")
        print("-" * 32)
        rows = conn.execute(
            """
            SELECT members.name AS member, books.title AS title
            FROM loans
            JOIN books   ON books.id = loans.book_id
            JOIN members ON members.id = loans.member_id
            ORDER BY members.name, books.title
            """
        ).fetchall()
        for row in rows:
            print(f"  {row['member']:<8} {row['title']}")

        print()
        # Parameterised query — never build SQL with string formatting.
        before = 1970
        (count,) = conn.execute(
            "SELECT COUNT(*) FROM books WHERE year < ?", (before,)
        ).fetchone()
        print(f"{count} of {len(BOOKS)} books were published before {before}.")

    size = Path(DB).stat().st_size
    print()
    print(f"Wrote {DB} ({size:,} bytes) — open it from the file explorer.")


if __name__ == "__main__":
    main()
`,
      "README.md": `# Python SQLite starter

A real relational database with Python's standard library, on **CPython compiled
to WebAssembly** (Pyodide).

\`\`\`bash
python main.py        # builds library.db and prints a few queries
\`\`\`

\`sqlite3\` is compiled into the interpreter, so this template needs **no wheels
and no network** — it is the one Python starter that works completely offline
with nothing to install.

## What it shows

- \`executescript\` for schema, \`executemany\` for bulk inserts
- \`sqlite3.Row\` so rows can be read by column name
- a \`GROUP BY\` aggregate and a two-table \`JOIN\`
- parameterised queries — never build SQL with string formatting

## The database is a real file

\`library.db\` is written to the project directory, and Vivari mirrors files a
script creates back into the editor, so it appears in the file explorer when the
run finishes.

One caveat: the mirror detects changes by file **size**. If a later run rewrites
the database to exactly the same byte length, the editor's copy will not be
refreshed. Deleting \`library.db\` before re-running avoids the question entirely.
`,
    },
  };
}

// ── Native: Python imaging (Pillow) ──────────────────────────────────────────
// Pillow is already inside the vendored Pyodide closure (0 MB marginal cost), so
// this runs offline. No DOM in the worker, so it writes PNGs the editor renders.
function pythonImagingTemplate(): TemplateDef {
  return {
    manifest: {
      id: "python-imaging",
      framework: "python",
      icon: "pillow",
      category: "Native",
      name: "Imaging",
      language: "Python",
      description: "Pillow image generation and filtering via Pyodide — writes PNGs you open in the editor",
      port: 8000,
      openPath: "/",
      entry: "main.py",
      hmr: false,
      reload: false,
      install: "pip install -r requirements.txt",
      dev: "python main.py",
      experimental: true,
    },
    files: {
      "requirements.txt": `pillow
`,
      "main.py": `# Image processing with Pillow on CPython/WASM (Pyodide).
#
# Pillow is already inside Vivari's vendored Pyodide bundle, so its wheel loads
# same-origin: this template runs with no network at all. Vivari auto-loads it
# from the \`from PIL import ...\` line below — the pip step just makes that
# explicit.
#
# There is no DOM in the process worker, so nothing can be displayed directly.
# Pillow writes PNGs instead, and the studio renders them inline when you open
# them from the file explorer.
from PIL import Image, ImageDraw, ImageFilter, ImageFont

WIDTH, HEIGHT = 640, 360
OUT = "art.png"
THUMB = "thumb.png"


def gradient(width: int, height: int) -> Image.Image:
    """A vertical two-colour gradient, one horizontal line at a time."""
    img = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(img)
    top, bottom = (14, 22, 46), (86, 44, 122)
    for y in range(height):
        t = y / max(height - 1, 1)
        colour = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
        draw.line([(0, y), (width, y)], fill=colour)
    return img


def main() -> None:
    img = gradient(WIDTH, HEIGHT)
    draw = ImageDraw.Draw(img)

    # Concentric circles, drawn onto the gradient.
    for i, radius in enumerate(range(40, 180, 24)):
        box = [
            WIDTH // 2 - radius,
            HEIGHT // 2 - radius,
            WIDTH // 2 + radius,
            HEIGHT // 2 + radius,
        ]
        draw.ellipse(box, outline=(255, 214, 102), width=3 - (i % 2))

    draw.rectangle([24, 24, WIDTH - 24, HEIGHT - 24], outline=(255, 255, 255), width=2)
    # load_default() always exists; no font files ship in the WASM filesystem.
    draw.text((40, 40), "Pillow on Pyodide", fill=(255, 255, 255), font=ImageFont.load_default())

    # A real filter pass — this is C code compiled to WebAssembly, not a shim.
    blurred = img.filter(ImageFilter.GaussianBlur(radius=1.2))
    blurred.save(OUT)
    print(f"Wrote {OUT} ({blurred.width}x{blurred.height})")

    thumb = blurred.copy()
    thumb.thumbnail((160, 160))
    thumb.save(THUMB)
    print(f"Wrote {THUMB} ({thumb.width}x{thumb.height})")

    print()
    print("Open either PNG from the file explorer — the studio renders it inline.")


if __name__ == "__main__":
    main()
`,
      "README.md": `# Python imaging starter (Pillow)

Image generation and processing with **Pillow**, on **CPython compiled to
WebAssembly** (Pyodide).

\`\`\`bash
pip install -r requirements.txt   # loads the vendored Pillow wheel
python main.py                    # writes art.png and thumb.png
\`\`\`

Pillow is already inside Vivari's vendored Pyodide bundle, so its wheel loads
same-origin and this template runs **offline**. It is also auto-loaded from the
\`from PIL import ...\` line, so \`python main.py\` works even without the install
step.

## What it shows

- drawing primitives — \`ImageDraw\` lines, ellipses, rectangles and text
- a per-pixel-row gradient built in pure Python
- a real filter pass (\`ImageFilter.GaussianBlur\`) — C compiled to WebAssembly,
  not a shim
- \`thumbnail()\`, which resizes in place while preserving aspect ratio

## No DOM, so no window

The Python process runs in a Web Worker with no DOM, so nothing can be displayed
directly. Pillow writes PNGs instead; Vivari mirrors them back into the project,
and the studio renders images inline when you open them from the file explorer.

\`ImageFont.load_default()\` is used deliberately — no font files ship in the WASM
filesystem, so \`truetype()\` has nothing to load unless you add a \`.ttf\` to the
project yourself.
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

// ── Rspress ──────────────────────────────────────────────────────────────────
// Rspress is the Rspack-powered docs SSG (MDX + React + Shiki). It rides the
// Rsbuild path we already prove in-VM (rsbuildTemplate + scripts/spike-rsbuild.mjs):
// @rspress/core depends on @rsbuild/core ^2.1.x -> @rspack/core -> @rspack/binding,
// whose optionalDependencies include @rspack/binding-wasm32-wasi. Our runtime reports
// `process.arch === "wasm32"`, so npm's platform auto-select picks that wasm32-wasip1-
// threads binding and NO native .node addon is ever fetched — no registry aliasing
// needed (unlike esbuild/rollup/lightningcss, which need the fetcher's native->wasm
// packument aliasing because their wasm builds live under a different package name).
//
// WHICH MAJOR: v2, and it must be v2. The v1 line (`rspress` 1.47.x) pins
// @rsbuild/core ~1.3.18 -> @rspack/core 1.3.9 -> @rspack/binding 1.3.9 exactly, and
// @rspack/binding only started publishing @rspack/binding-wasm32-wasi in 1.4.0. So
// Rspress v1's whole chain is exact-pinned to a pre-wasm Rspack: in-VM it would
// resolve no binding at all and die requiring a native addon. Rspress v2 shipped
// stable under the RENAMED package `@rspress/core` (2.x); the old `rspress` package
// stops at 2.0.0-beta and its `latest` tag still points at v1 — hence the dependency
// on `@rspress/core`, not `rspress`.
//
// THE GOTCHA — Rspack's persistent build cache panics the wasm binding. Rspress (unlike
// plain Rsbuild) turns Rspack's persistent build cache ON by default. That cache calls
// `std::process::id()`, which is unsupported on wasm32-wasip1, so the Rust core aborts
// mid-build with a hard panic — the dev server binds its port and then never compiles:
//     thread 'tokio-0' panicked at library/std/src/sys/process/unsupported.rs:
//     no pids on this platform
//     RuntimeError: unreachable
// Rspress gates that cache on RSPRESS_PERSISTENT_CACHE, so the manifest's `env` sets it
// to "false" — a framework-honored lever, no project-level config needed. This is the
// ONLY reason rsbuildTemplate works in-VM while a stock Rspress config does not; keep
// that env var or the template regresses to a blank page. (Rspress's other Rust-adjacent
// default, lazy compilation, was measured and is FINE in-VM — left at its default.)
//
// Checked against the three VitePress in-VM gotchas — none of those bite here:
//   1. Config loading. Rspress loads `rspress.config.*` via @rsbuild/core's own
//      `loadConfig`, i.e. the exact loader the green Rsbuild template already
//      exercises with an .mjs config — so we ship `rspress.config.mjs` (NOT the
//      scaffolder's .ts, which would add a transpile step, and not a `__dirname`
//      reference: `root` is omitted so it defaults to `<cwd>/docs`).
//   2. worker_threads transferList / Atomics. @rspress/core bundles Tinypool, but
//      only for SSG page rendering (`rspress build`), never the dev server; and the
//      runtime already defaults PISCINA_DISABLE_ATOMICS=1 so pools use message
//      passing (see packages/runtime/builtins/process.js).
//   3. Shiki via synckit. Rspress highlights inside the async MDX/unified pipeline
//      (@shikijs/rehype), not through synckit's Atomics.wait bridge, so there is no
//      sync-language-load path to pre-empt — no `languages` allowlist needed.
//
// Proven headless by scripts/spike-rspress.mjs (install picks the wasm binding ->
// `rspress dev` binds -> GET returns the Rspress shell), registered in the net tier of
// scripts/run-spikes.mjs; also run with VV_BASE=/preview/3000/ so the base-prefixed
// path this template actually ships is covered (shell + an asset under the prefix).
function rspressTemplate(): TemplateDef {
  return {
    manifest: {
      id: "rspress",
      framework: "rspress",
      icon: "rspress",
      category: "Docs",
      name: "Rspress",
      language: "JavaScript",
      description: "Rspress — Rspack-powered docs site (MDX + React) running the Rust bundler as WebAssembly",
      port: 3000,
      openPath: "/",
      entry: "docs/index.md",
      hmr: true,
      reload: false,
      install: "npm install",
      dev: "npm run dev",
      // Rspack's persistent build cache calls std::process::id(), which panics the
      // wasm32-wasip1 binding mid-build ("no pids on this platform"). Rspress enables
      // that cache by default and honors this env var to turn it off — see the header
      // comment. Without it the dev server binds but the site never compiles.
      env: { RSPRESS_PERSISTENT_CACHE: "false" },
      // Rspress is a client-routed SPA (react-router history mode): served at "/" its
      // router lands on 404, so `base` below matches the proxy prefix and we keep it.
      keepPreviewPrefix: true,
    },
    files: {
      "package.json": `{
  "name": "rspress-site",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "rspress dev --port 3000",
    "build": "rspress build",
    "preview": "rspress preview --port 3000"
  },
  "dependencies": {
    "@rspress/core": "^2.0.19"
  },
  "devDependencies": {
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  }
}
`,
      // An .mjs config on purpose — @rsbuild/core's loadConfig handles it on the same
      // path the Rsbuild template already proves in-VM. `root` is left out so it
      // defaults to <cwd>/docs, which avoids needing __dirname here.
      "rspress.config.mjs": `import { defineConfig } from "@rspress/core";

export default defineConfig({
  // The Vivari preview serves this dev server under /preview/3000/. Rspress is a
  // client-routed SPA, so set \`base\` to that prefix (paired with the template's
  // keepPreviewPrefix flag) — otherwise the first load resolves to a 404 page.
  // Rspress forwards this to Rsbuild as \`server.base\`.
  base: "/preview/3000/",
  lang: "en",
  title: "Rspress in Vivari",
  description: "Rspack-powered docs that build and run entirely in the browser VM",
  themeConfig: {
    socialLinks: [
      { icon: "github", mode: "link", content: "https://github.com/web-infra-dev/rspress" },
    ],
  },
});
`,
      "docs/_nav.json": `[
  { "text": "Guide", "link": "/guide/getting-started", "activeMatch": "/guide/" }
]
`,
      "docs/index.md": `---
pageType: home

hero:
  name: Rspress in Vivari
  text: Docs, in the browser VM
  tagline: An Rspack-powered docs site compiled entirely client-side
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
features:
  - title: Rust bundler as WebAssembly
    details: Rspack's core runs as a wasm32-wasip1-threads binding — no native addon.
    icon: 🦀
  - title: Markdown & MDX
    details: Write content in Markdown, drop in React components when you need them.
    icon: 📦
  - title: Instant HMR
    details: Edit a page and it hot-reloads — no full rebuild, no native dependencies.
    icon: 🔥
---
`,
      "docs/guide/_meta.json": `["getting-started"]
`,
      "docs/guide/getting-started.md": `# Getting Started

Welcome to **Rspress**, running entirely inside Vivari's in-browser VM.

Edit \`docs/guide/getting-started.md\` and this page hot-reloads. Code blocks are
highlighted by Shiki during MDX compilation, which happens in the VM:

\`\`\`ts
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

console.log(greet("Vivari"));
\`\`\`

## How this runs

Rspress builds on [Rspack](https://rspack.rs), a Rust bundler. In the browser there
is no native N-API addon to load, so npm resolves \`@rspack/binding-wasm32-wasi\`
instead — the same WebAssembly binding the Rsbuild template uses.

- Add a page by dropping a \`.md\` / \`.mdx\` file under \`docs/\`
- Order the sidebar with \`_meta.json\`
- Add nav entries in \`docs/_nav.json\`
`,
    },
  };
}
// ── Starlight ────────────────────────────────────────────────────────────────
// Astro Starlight rides the Astro path that is already proven in-VM by the shipped
// `astro` template and scripts/spike-astro.mjs: the Vite dev server, the Go/wasm
// @astrojs/compiler, and the rollup -> @rollup/wasm-node registry alias. What Starlight
// adds on top — a content-collection pipeline (docsLoader + MDX + expressive-code) and a
// themed MULTI-page site — is what needed proving, and it surfaced four in-VM gotchas:
//
//   1. Astro 5, NOT the latest. Astro >=6 moves Vite 6 -> Vite 7, whose bundler is
//      rolldown, and rolldown does not load here: `astro dev` on Astro 7 logs
//      "[rolldown] Downloading @rolldown/binding-wasm32-wasi@… on WebContainer" and dies
//      with "TypeError: Class extends value undefined is not a constructor or null"
//      before it ever binds a port. (Same family as the VITE_DEV `--configLoader native`
//      workaround above, which exists because Vite's rolldown config bundler also fails
//      in-VM.) So this pins astro ^5 and the newest Starlight line that peers on it,
//      0.37.x. Revisit both together once rolldown works in-VM.
//   2. Images go through `passthroughImageService()`, so no image binary is ever needed.
//      Astro lists `sharp` as an optionalDependency and Starlight's `astro:assets` usage
//      would otherwise construct the sharp-backed service. Measured in-VM: npm's platform
//      auto-select skips every NATIVE @img/sharp-<platform> package and installs sharp
//      0.34 plus its own wasm build, `@img/sharp-wasm32` — so a sharp-backed service is
//      not strictly unavailable here. We still don't use it: that path is unproven in-VM
//      and image transcoding in wasm is slow, and passthrough costs a docs site nothing
//      (images are served untransformed). Treat the wasm sharp as a happy accident, not a
//      dependency — the spike prints whether it landed but does not require it.
//   3. `ec.config.mjs` MUST exist. Starlight always loads astro-expressive-code, whose
//      loadEcConfigFile() dynamic-imports `<root>/ec.config.mjs` and treats the file as
//      merely ABSENT only when the failure reports the ESM code ERR_MODULE_NOT_FOUND (or
//      ERR_LOAD_URL). In-VM that import fails with the CommonJS code MODULE_NOT_FOUND, so
//      expressive-code concludes the config exists but is BROKEN and hard-exits the
//      "astro:config:setup" hook — `astro dev` never binds. Shipping the file sidesteps
//      the misread entirely, and it is a real Starlight file users want anyway.
//   4. `pagefind: false`. Starlight's built-in search shells out to Pagefind, whose
//      binaries are optional platform packages (@pagefind/linux-x64 and friends) that npm
//      also skips on wasm32 — so a production build would reach for a binary that has no
//      wasm32 equivalent. Dev never invokes it; disabling it keeps `npm run build` honest
//      too. Search is the one feature knowingly traded away to run in-VM.
//   5. `.npmrc` with legacy-peer-deps — a real but PARTIAL win, and read gotcha 6 before
//      assuming it fixed anything user-visible. Astro's `unstorage`/`db0` declare ~19
//      OPTIONAL peerDependencies naming some of the largest packages on npm (Prisma,
//      Drizzle, react-native, Azure, Xata). npm resolves a manifest for each even though it
//      installs none, and arborist's #fetchManifest always asks for FULL packuments, so a
//      cold install pulled ~420 MB of DECODED JSON through the fetcher + VFS (measured;
//      ~45 MB on the wire, ~10x that once gunzipped) — 4x Rspress, more than Docusaurus.
//      This file brings it to ~108 MB. That is worth keeping on its own merit, but it
//      addresses the RESOLVE/DOWNLOAD phase, and the failure users actually hit is later
//      (gotcha 6). Do not delete it without re-measuring;
//      scripts/spike-starlight-studio.mjs fails if the volume regresses past its budget.
//   6. THE HANG USERS ACTUALLY HIT, and why `install` carries --ignore-scripts. `astro`
//      depends on sharp, and npm runs its install script during reify — right after the
//      downloads finish, which is exactly where four separate reports said the terminal
//      stopped. It is a DEADLOCK, not slowness. Caught wedged, `__vv.diag()` says:
//        pid 3  npm install                                    idle 153s
//        pid 4  sh -c node install/check.js || npm run build    idle 152s  [node_modules/sharp]
//        pid 5  node install/check.js            28 modules, 2 syscalls, idle 152s
//      with fetch inflight/queued/active all 0, pendingHttp 0, booted true, paused false.
//      So sharp's check script loads, does almost nothing, and then never exits — nothing
//      is pending for it to wait on, and the runtime never decides it is finished. npm
//      waits on the child forever, so `npm install && npm run dev` never reaches the dev
//      server. Skipping scripts removes the mechanism outright: 4 of 4 runs wedged before,
//      2 of 2 completed after, on the same rig. Nothing is lost here — the image service is
//      passthrough so sharp is never loaded, and esbuild's postinstall is moot because the
//      registry aliases it to esbuild-wasm.
//      Reproduce it (the wedge needs a slow enough page — a production build usually wins
//      the race and installs fine, which is why this went unreproduced for so long): serve
//      the studio with `vite dev`, make sure vendor/depcache/index.json is NOT served so the
//      install path is taken, then run scripts/repro-starlight-browser.mjs.
//   7. Starlight's `astro dev` also throws 8-113 UNCAUGHT
//      `SyntaxError: "[object Object]" is not valid JSON` per run inside its process worker
//      (Rspress, same install path, throws zero). These are NOT the hang — the dev server
//      bound in 7 of 7 runs on current HEAD with all of them firing — but they are real and
//      unexplained. A browser Worker survives an uncaught error, so they only become fatal
//      if something treats `worker.onerror` as worker death: with such a change in place 0
//      of 4 runs bound, versus 9 of 9 without it. Do not add one back.
//      No stack is available for them: Runtime.exceptionThrown delivers these with an EMPTY
//      stack, and booting the worker from a module blob that shims JSON.parse (to trap the
//      call site) stops the kernel booting, so that route is a dead end too.
//      What this is NOT: not packument volume (gotcha 5), not the reify phase in general,
//      not Chrome Incognito (a cold A/B of an incognito context vs a fresh profile came out
//      indistinguishable: 53.7 s / 57.3 s vs 52.3 s / 66.2 s), and NOT the terminal
//      dropping output. That last one was tested directly by reading the text xterm painted
//      rather than counting characters: `added 364 packages`, the tsconfck warning that
//      precedes it by 0.4s, and the runtime's own watchdog line all reach the screen, in
//      order, including output following a \r-terminated progress line. Memory does set a
//      hard floor — a cold install peaks around 1.87 GB across the whole Chrome process
//      tree, and under a 1.6 GB ceiling the kernel SIGKILLs the RENDERER (errorCode 9),
//      which is Chrome's crash page, not a frozen terminal.
//
// keepPreviewPrefix is REQUIRED here, unlike the `astro` template — settled empirically,
// not assumed. Starlight renders its sidebar, prev/next pager and site-title link as
// ROOT-ABSOLUTE hrefs that follow Astro's `base`. Clicking one is a top-level navigation,
// and packages/studio/public/sw.js deliberately refuses to proxy a navigation carrying no
// /preview/<port>/ marker (it assumes such a document is the studio's own). With the
// default base those links come out as "/guides/…", so the site would load and then break
// on the first sidebar click. So `base` matches the proxy prefix and we keep it. The
// single-page `astro` template escapes this only because it has no internal links at all.
//
// Proven headless by scripts/spike-starlight.mjs (install lands no native sharp ->
// `astro dev` binds -> the Starlight shell, a deep link, every internal link and both
// asset shapes all check out under the prefix), registered in the net tier of
// scripts/run-spikes.mjs.
function starlightTemplate(): TemplateDef {
  return {
    manifest: {
      id: "starlight",
      framework: "starlight",
      icon: "starlight",
      category: "Docs",
      name: "Starlight",
      language: "TypeScript",
      description:
        "Astro Starlight — full-featured docs site (Markdown/MDX content collections) on Astro's Vite dev server",
      port: 4321,
      openPath: "/",
      entry: "src/content/docs/index.mdx",
      hmr: true,
      reload: false,
      // --ignore-scripts is LOAD-BEARING, not tidiness: astro pulls sharp, whose install
      // script (`node install/check.js`) starts, loads 28 modules, makes two syscalls and
      // then never exits — no fetch in flight, no pending HTTP, not paused, just idle
      // forever. npm waits on it, so `npm install && npm run dev` stops dead right after
      // the downloads finish. That is the hang users reported for four rounds; see gotcha 6.
      // Nothing is lost: the image service is passthrough, so sharp is never loaded, and
      // esbuild's postinstall is moot because the registry aliases it to esbuild-wasm.
      // The project's package.json stays vanilla — this is a studio-side install choice,
      // same as the Angular template.
      install: "npm install --ignore-scripts",
      dev: "npm run dev",
      // NOT experimental any more, on this evidence: the deadlock in gotcha 6 is gone by
      // construction (sharp's script is never run), the rig that wedged 4 of 4 times now
      // completes 2 of 2, spike-starlight / -studio / -depcache and rspress are all green,
      // and in a real browser first run is a dep-cache RESTORE rather than an install
      // (5.4 s for 13,459 entries, dev server listening 13 s after Create). The dev server
      // bound in 7 of 7 runs on HEAD. The uncaught JSON errors in gotcha 7 are still
      // unexplained — if you make them fatal, or if a change puts an install script back in
      // the first-run path, this template is the one that will break first.
      // Starlight's nav/sidebar links are root-absolute, and the SW won't proxy a
      // navigation without the proxy prefix — see the header comment.
      keepPreviewPrefix: true,
    },
    files: {
      "package.json": `{
  "name": "starlight-docs",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "astro dev --port 4321",
    "build": "astro build",
    "preview": "astro preview --port 4321"
  },
  "dependencies": {
    "astro": "^5.18.0",
    "@astrojs/starlight": "^0.37.7"
  }
}
`,
      "astro.config.mjs": `import { defineConfig, passthroughImageService } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  // Matches the studio's preview proxy path (manifest keepPreviewPrefix) so Starlight's
  // root-absolute sidebar links stay inside the preview.
  base: '/preview/4321/',
      // Keep image handling off the sharp path entirely — see the header comment.
      // Passthrough serves images untransformed.
      image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: 'Starlight on Vivari',
      description: 'Docs that build and run entirely in the browser VM',
      // Pagefind's search binaries have no wasm32 build — see the header comment.
      pagefind: false,
      sidebar: [
        { label: 'Guides', items: [{ label: 'Getting Started', slug: 'guides/getting-started' }] },
      ],
    }),
  ],
})
`,
      // Load-bearing for first-run install cost — see gotcha 5 in the header comment.
      ".npmrc": `# Why this exists (it is not a style preference):
#
# Astro's own \`unstorage\` (and its \`db0\` sibling) declare ~19 OPTIONAL peerDependencies
# pointing at some of the biggest packages on npm — @prisma/client, drizzle-orm, prisma,
# react-native, @azure/cosmos, @xata.io/client. npm resolves a manifest for every one of
# them even though it installs none, and npm's ideal-tree builder always asks for FULL
# packuments (arborist's #fetchManifest hardcodes fullMetadata: true). On a cold cache that
# dragged ~420 MB of DECODED JSON through the in-browser fetcher and VFS — four times the
# Rspress template and more than Docusaurus. Ignoring peer resolution cuts it to ~108 MB
# (measured), i.e. back in line with the other docs templates. This shortens the download
# phase; it is not a cure for a first install that stalls after downloading.
#
# Safe here: the only peer relationship in this tree is @astrojs/starlight -> astro, and
# astro is a direct dependency above, so nothing is left unsatisfied. If you add a package
# that genuinely needs its peers installed for you, drop this line and run npm install again.
legacy-peer-deps=true
`,
      // Required, not decorative: without this file expressive-code misreads "absent" as
      // "broken" in-VM and `astro dev` exits. See the header comment.
      "ec.config.mjs": `// Expressive Code options for Starlight's code blocks.
// Deliberately a plain object with NO imports: this file is loaded by a bare dynamic
// import from the project root (Vite never processes it), so keeping it dependency-free
// avoids an ESM re-export chain at boot. \`defineEcConfig\` from
// '@astrojs/starlight/expressive-code' is only a typing helper, so nothing is lost.
export default {
  styleOverrides: { borderRadius: '0.4rem' },
}
`,
      // Starlight's default <head> points at /favicon.svg; ship the official starter's
      // mark (withastro/starlight examples/basics) so the shell has no 404. Its embedded
      // prefers-color-scheme style adapts it to light and dark.
      "public/favicon.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path fill-rule="evenodd" d="M81 36 64 0 47 36l-1 2-9-10a6 6 0 0 0-9 9l10 10h-2L0 64l36 17h2L28 91a6 6 0 1 0 9 9l9-10 1 2 17 36 17-36v-2l9 10a6 6 0 1 0 9-9l-9-9 2-1 36-17-36-17-2-1 9-9a6 6 0 1 0-9-9l-9 10v-2Zm-17 2-2 5c-4 8-11 15-19 19l-5 2 5 2c8 4 15 11 19 19l2 5 2-5c4-8 11-15 19-19l5-2-5-2c-8-4-15-11-19-19l-2-5Z" clip-rule="evenodd"/><path d="M118 19a6 6 0 0 0-9-9l-3 3a6 6 0 1 0 9 9l3-3Zm-96 4c-2 2-6 2-9 0l-3-3a6 6 0 1 1 9-9l3 3c3 2 3 6 0 9Zm0 82c-2-2-6-2-9 0l-3 3a6 6 0 1 0 9 9l3-3c3-2 3-6 0-9Zm96 4a6 6 0 0 1-9 9l-3-3a6 6 0 1 1 9-9l3 3Z"/><style>path{fill:#000}@media (prefers-color-scheme:dark){path{fill:#fff}}</style></svg>
`,
      "src/content.config.ts": `import { defineCollection } from 'astro:content'
import { docsLoader } from '@astrojs/starlight/loaders'
import { docsSchema } from '@astrojs/starlight/schema'

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
}
`,
      "src/content/docs/index.mdx": `---
title: Starlight on Vivari
description: An Astro Starlight docs site compiled entirely in the browser VM
---

Welcome to **Starlight**, running entirely inside Vivari's in-browser VM — Astro's Vite
dev server and the WebAssembly build of Astro's compiler, no native binaries.

- Write docs in Markdown or MDX
- Live hot reload as you edit
- Zero native dependencies
`,
      "src/content/docs/guides/getting-started.md": `---
title: Getting Started
description: Add a page, order the sidebar, and watch it hot-reload
---

Add a page by dropping a \`.md\` / \`.mdx\` file under \`src/content/docs/\`,
then list it in the \`sidebar\` array in \`astro.config.mjs\`.

Code blocks are rendered by Expressive Code, configured in \`ec.config.mjs\`:

\`\`\`ts
export function greet(name: string): string {
  return \`Hello, \${name}!\`
}
\`\`\`
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
  s3Template(),
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
  bunTestTemplate(),
  bunSqliteTemplate(),
  bunShellTemplate(),
  bunBuildTemplate(),
  bunApisTemplate(),
  // Native
  pythonTemplate(),
  pythonDataScienceTemplate(),
  pythonMatplotlibTemplate(),
  fastapiTemplate(),
  flaskTemplate(),
  flaskAppTemplate(),
  fastapiCrudTemplate(),
  fastapiDashboardTemplate(),
  djangoTemplate(),
  pythonPytestTemplate(),
  pythonSqliteTemplate(),
  pythonImagingTemplate(),
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
  rspressTemplate(),
  starlightTemplate(),
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