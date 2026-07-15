// Project templates for "Start from template".
//
// Each template is REAL, runnable project source + a manifest describing how to
// bring it to life in-VM (install command, dev command, the port its dev server
// listens on, and which file to open first). The studio reads a template, writes
// its files into the chosen workspace directory via the kernel worker
// (`oc-create-project`), and — if the user keeps "Run init script" checked —
// runs `install && dev` inside a terminal so the dev server boots exactly like
// local development. Nothing here is scaffolded by running `create-vite`/`nest
// new` in-VM: the source is vendored so creation is instant, deterministic, and
// offline.
//
// We keep the source co-located (rather than a sibling `packages/templates` dir
// globbed via import.meta.glob) so it is bundled reliably and never dragged into
// the studio's own tsc/eslint pass.

export type Language = "TypeScript" | "JavaScript";

// Picker tabs, StackBlitz-style. The order here drives the tab order in the UI.
export type TemplateCategory =
  | "Frontend"
  | "Backend"
  | "Fullstack"
  | "Docs"
  | "Creative"
  | "Tooling"
  | "Showcase";

export const TEMPLATE_CATEGORIES: TemplateCategory[] = [
  "Frontend",
  "Backend",
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
   * (Docusaurus, VitePress, Slidev…) resolves its route from the iframe's own
   * `location.pathname`, so served at `/` its router lands on NotFound. Such a
   * template instead sets its base (baseUrl / Vite `base`) to `/preview/<port>/`
   * and flags this so the SW keeps the prefix — the app then runs consistently
   * under the proxy path (deep-links + `location.reload()` work).
   */
  keepPreviewPrefix?: boolean;
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
      <p>Running inside OpenContainer — a real Vite dev server in your browser.</p>
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
  <p>Running inside OpenContainer — a real Vite dev server in your browser.</p>
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
<p>Running inside OpenContainer — a real Vite dev server in your browser.</p>
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
const expressAppJs = `Hello from Express, running inside OpenContainer!`;

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

app.get('/', (_req: Request, res: Response) => {
  res.send('${expressAppJs}');
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

app.get('/', (_req, res) => {
  res.send('${expressAppJs}');
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
  "src/app.controller.ts": `import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
`,
  "src/app.service.ts": `import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World!';
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
        Running in OpenContainer${ts ? " with TypeScript" : ""} — compiled by wasm SWC + webpack.
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
  title: "Next.js in OpenContainer",
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
  title: "Next.js in OpenContainer",
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
  <p>Running inside OpenContainer — a real Vite dev server in your browser.</p>
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
      <p>Served by a zero-dependency Node server inside OpenContainer.</p>
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
  <p class="text-muted">Running inside OpenContainer.</p>
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
      <p>GreenSock animating a React element inside OpenContainer.</p>
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

router.get('/', (ctx) => { ctx.body = 'Hello from Koa, running inside OpenContainer!'; });
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

const app = new Hono()
app.get('/', (c) => c.text('Hello from Hono, running inside OpenContainer!'))
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
import { createApp, createRouter, defineEventHandler, toNodeListener } from 'h3'

const app = createApp()
const router = createRouter()
router.get('/', defineEventHandler(() => 'Hello from H3, running inside OpenContainer!'))
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
      description: "Express streaming live updates to the browser via EventSource",
      port: 3000,
      openPath: "/",
      entry: "server/index.js",
      hmr: false,
      reload: false,
      install: "npm install",
      dev: "node server/index.js",
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

app.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  let n = 0;
  const id = setInterval(() => {
    n++;
    res.write('data: ' + JSON.stringify({ n, time: new Date().toISOString() }) + '\\n\\n');
  }, 1000);
  req.on('close', () => clearInterval(id));
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
      body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; background: #0a0a0a; color: #ededed; }
      #log { margin-top: 1rem; font-family: ui-monospace, monospace; font-size: .85rem; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <h1>Server-Sent Events</h1>
    <p>The Express server is streaming a tick every second — no polling.</p>
    <div id="log"></div>
    <script>
      const log = document.getElementById('log');
      const es = new EventSource('/events');
      es.onmessage = (e) => {
        const d = JSON.parse(e.data);
        log.textContent = 'tick #' + d.n + ' @ ' + d.time + '\\n' + log.textContent;
      };
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
    <h1>Nuxt 3 on OpenContainer</h1>
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
    "@sveltejs/vite-plugin-svelte": "^5.0.0",
    "svelte": "^5.1.0",
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
  <h1>SvelteKit on OpenContainer</h1>
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
      experimental: true,
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
} satisfies Config
`,
      "vite.config.ts": `import { reactRouter } from '@react-router/dev/vite'
import { defineConfig } from 'vite'

export default defineConfig({
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
      <h1>React Router 7 on OpenContainer</h1>
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
      experimental: true,
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
const title = 'Astro on OpenContainer'
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

// ── VitePress ────────────────────────────────────────────────────────────────
function vitepressTemplate(): TemplateDef {
  return {
    manifest: {
      id: "vitepress",
      framework: "vitepress",
      icon: "vitepress",
      category: "Docs",
      name: "VitePress",
      language: "TypeScript",
      description: "VitePress — Vite & Vue powered static site generator for docs",
      port: 5173,
      openPath: "/",
      entry: "docs/index.md",
      hmr: true,
      reload: false,
      install: "npm install",
      dev: "npm run dev",
      experimental: true,
    },
    files: {
      "package.json": `{
  "name": "vitepress-docs",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vitepress dev docs",
    "build": "vitepress build docs",
    "preview": "vitepress preview docs"
  },
  "devDependencies": { "vitepress": "^1.5.0" }
}
`,
      "docs/.vitepress/config.mjs": `import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'OpenContainer Docs',
  description: 'VitePress running inside OpenContainer',
  themeConfig: {
    nav: [{ text: 'Home', link: '/' }, { text: 'Guide', link: '/guide' }],
    sidebar: [
      { text: 'Introduction', items: [
        { text: 'Home', link: '/' },
        { text: 'Guide', link: '/guide' },
      ] },
    ],
  },
})
`,
      "docs/index.md": `---
layout: home
hero:
  name: OpenContainer
  text: VitePress in the browser
  tagline: Edit docs/index.md and save — HMR is live.
  actions:
    - theme: brand
      text: Read the guide
      link: /guide
---
`,
      "docs/guide.md": `# Guide

This VitePress site is running entirely inside OpenContainer.

- Markdown with Vue components
- Instant hot reload
- Zero native dependencies
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
      experimental: true,
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
title: Slidev on OpenContainer
---

# Slidev on OpenContainer

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
// its service in-process (see packages/demo/fetcher-worker.js +
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
      <p>A web component running inside OpenContainer.</p>
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

app.get('/', async () => 'Hello from Fastify, running inside OpenContainer!');
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
      experimental: true,
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
      "routes/index.ts": `export default defineEventHandler(() => 'Hello from Nitro, running inside OpenContainer!')
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
      description: "GraphQL Yoga server with GraphiQL, on Node",
      port: 4000,
      openPath: "/graphql",
      entry: "src/index.js",
      hmr: false,
      reload: false,
      install: "npm install",
      dev: "npm run dev",
      experimental: true,
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
const { createYoga, createSchema } = require('graphql-yoga');

const yoga = createYoga({
  schema: createSchema({
    typeDefs: \`
      type Query {
        hello: String
        greet(name: String!): String
      }
    \`,
    resolvers: {
      Query: {
        hello: () => 'Hello from GraphQL Yoga!',
        greet: (_parent, args) => 'Hello ' + args.name + '!',
      },
    },
  }),
});

const port = Number(process.env.PORT ?? 4000);
createServer(yoga).listen(port, () => {
  console.log('GraphQL ready at http://localhost:' + port + '/graphql');
});
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
      experimental: true,
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
// Phase 3 — showcases that lean into OpenContainer's strengths
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
      experimental: true,
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
      install: "npm install",
      dev: "npm run dev",
      experimental: true,
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

export type AppRouter = typeof appRouter

createHTTPServer({ router: appRouter }).listen(3001)
console.log('[trpc] server listening on :3001')
`,
      "index.html": reactIndexHtml("tsx"),
      "src/index.css": VITE_INDEX_CSS,
      "src/main.tsx": reactMain(true),
      "src/App.tsx": `import { useEffect, useState } from 'react'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '../server/index'

// The studio's preview proxy maps /preview/<port>/ to the in-VM server, so the
// browser reaches the tRPC server (:3001) with no CORS and no manual proxy.
const trpc = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: '/preview/3001' })],
})

export default function App() {
  const [msg, setMsg] = useState('loading…')
  useEffect(() => {
    trpc.greeting
      .query({ name: 'OpenContainer' })
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
      dev: "pnpm --filter web dev -- --configLoader native",
      experimental: true,
    },
    files: {
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
      <p>{greeting('OpenContainer')}</p>
      <p>
        The <code>web</code> app imports a shared <code>@repo/ui</code> workspace package —
        pnpm workspaces working inside OpenContainer.
      </p>
    </>
  )
}
`,
    },
  };
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
  const SQL = await initSqlJs({ locateFile: (f) => require.resolve('sql.js/dist/' + f) });
  const db = new SQL.Database();
  db.run('CREATE TABLE todos (id INTEGER PRIMARY KEY, task TEXT, done INTEGER);');
  db.run("INSERT INTO todos (task, done) VALUES ('Try OpenContainer', 1), ('Run SQLite in the browser', 0);");

  const app = express();
  app.get('/api/todos', (_req, res) => {
    const rows = [];
    const stmt = db.prepare('SELECT * FROM todos');
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    res.json(rows);
  });
  app.use(express.static(path.join(__dirname, 'public')));

  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => console.log('SQLite demo on http://localhost:' + port));
}

main().catch((err) => { console.error(err); process.exit(1); });
`,
      "public/index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SQLite (sql.js)</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; background: #0a0a0a; color: #ededed; }
      li { margin: .25rem 0; }
      .done { text-decoration: line-through; opacity: .6; }
    </style>
  </head>
  <body>
    <h1>SQLite in the browser</h1>
    <p>Rows queried from an in-memory SQLite database (sql.js WASM) via Express:</p>
    <ul id="list"></ul>
    <script>
      fetch('/api/todos')
        .then(function (r) { return r.json(); })
        .then(function (rows) {
          var list = document.getElementById('list');
          rows.forEach(function (row) {
            var li = document.createElement('li');
            li.textContent = row.task;
            if (row.done) li.className = 'done';
            list.appendChild(li);
          });
        });
    </script>
  </body>
</html>
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
    <title>Webpack in OpenContainer</title>
  </head>
  <body>
    <h1 id="marker">Webpack in OpenContainer</h1>
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
  title: "Docusaurus in OpenContainer",
  tagline: "Docs run in the browser VM",
  url: "http://localhost",
  // The OpenContainer preview serves this app under /preview/3000/ (see the
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
    navbar: { title: "Docusaurus in OpenContainer", items: [] },
  },
};
`,
      "sidebars.js": `module.exports = { tutorialSidebar: [{ type: "autogenerated", dirName: "." }] };
`,
      "src/css/custom.css": `:root { --ifm-color-primary: #2e8555; }
`,
      "docs/intro.md": `---
slug: /
title: Docusaurus in OpenContainer
---

# Docusaurus in OpenContainer

Hello from OpenContainer — a full Docusaurus dev server compiled in the browser VM.

- Write docs in Markdown / MDX
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
    <title>Angular in OpenContainer</title>
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
  <h1 id="marker">Angular in OpenContainer</h1>
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
  preactTemplate(),
  litTemplate(),
  solidTemplate(),
  qwikTemplate(),
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
  // Fullstack
  nextTemplate(true),
  nextTemplate(false),
  nuxtTemplate(),
  svelteKitTemplate(),
  remixTemplate(),
  astroTemplate(),
  // Docs
  vitepressTemplate(),
  slidevTemplate(),
  docusaurusTemplate(),
  // Creative
  threeTemplate(),
  gsapReactTemplate(),
  // Tooling
  nodeTemplate(),
  webpackTemplate(),
  // Showcase
  fullstackTemplate(),
  sseTemplate(),
  wsDemoTemplate(),
  socketioTemplate(),
  trpcTemplate(),
  monorepoTemplate(),
  sqliteTemplate(),
];

export function getTemplate(id: string): TemplateDef | undefined {
  return TEMPLATES.find((t) => t.manifest.id === id);
}
