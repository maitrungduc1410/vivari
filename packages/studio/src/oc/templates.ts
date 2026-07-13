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

export type Framework = "react" | "vue" | "svelte" | "express" | "nest" | "next";
export type Language = "TypeScript" | "JavaScript";

export interface TemplateManifest {
  /** Stable id, e.g. "react-ts". */
  id: string;
  framework: Framework;
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
    "@vitejs/plugin-vue": "^5.2.0",
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
    "@sveltejs/vite-plugin-svelte": "^5.0.0",
    "svelte": "^5.0.0",
    "vite": "^8.0.0"${ts ? `,
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

function nestTemplate(ts: boolean): TemplateDef {
  if (ts) {
    return {
      manifest: {
        id: "nest-ts",
        framework: "nest",
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
  // Nest with plain JS: compiled with Babel (legacy decorators + metadata) so DI
  // works without TypeScript. Experimental — decorator metadata in-VM is less
  // battle-tested than the tsc path.
  return {
    manifest: {
      id: "nest-js",
      framework: "nest",
      name: "NestJS",
      language: "JavaScript",
      description: "NestJS + Babel (experimental)",
      port: 3000,
      openPath: "/",
      entry: "src/app.service.js",
      hmr: false,
      reload: false,
      install: "npm install",
      dev: "npm run build && node dist/main.js",
      experimental: true,
    },
    files: {
      "package.json": `{
  "name": "nest-js",
  "version": "0.0.1",
  "private": true,
  "license": "UNLICENSED",
  "type": "commonjs",
  "scripts": {
    "build": "babel src --out-dir dist --extensions .js",
    "start": "node dist/main.js",
    "dev": "npm run build && node dist/main.js"
  },
  "dependencies": {
    "@nestjs/common": "^11.0.1",
    "@nestjs/core": "^11.0.1",
    "@nestjs/platform-express": "^11.0.1",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1"
  },
  "devDependencies": {
    "@babel/cli": "^7.25.0",
    "@babel/core": "^7.25.0",
    "@babel/plugin-proposal-decorators": "^7.25.0",
    "babel-plugin-transform-typescript-metadata": "^0.3.2"
  }
}
`,
      "babel.config.json": `{
  "plugins": [
    "babel-plugin-transform-typescript-metadata",
    ["@babel/plugin-proposal-decorators", { "version": "legacy" }]
  ]
}
`,
      "src/main.js": `require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('./app.module');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
`,
      "src/app.module.js": `const { Module } = require('@nestjs/common');
const { AppController } = require('./app.controller');
const { AppService } = require('./app.service');

@Module({
  controllers: [AppController],
  providers: [AppService],
})
class AppModule {}

module.exports = { AppModule };
`,
      "src/app.controller.js": `const { Controller, Get } = require('@nestjs/common');
const { AppService } = require('./app.service');

@Controller()
class AppController {
  constructor(appService) {
    this.appService = appService;
  }

  @Get()
  getHello() {
    return this.appService.getHello();
  }
}

module.exports = { AppController };
`,
      "src/app.service.js": `const { Injectable } = require('@nestjs/common');

@Injectable()
class AppService {
  getHello() {
    return 'Hello World!';
  }
}

module.exports = { AppService };
`,
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
      // Newly proven in-VM (Next 16 webpack + wasm SWC); keep flagged until it has
      // more mileage in the studio.
      experimental: true,
    },
    files,
  };
}

// The full matrix, in picker order (matches the reference create-vite layout:
// framework first, then language variants side by side).
export const TEMPLATES: TemplateDef[] = [
  reactTemplate(false),
  reactTemplate(true),
  vueTemplate(false),
  vueTemplate(true),
  svelteTemplate(false),
  svelteTemplate(true),
  expressTemplate(false),
  expressTemplate(true),
  nestTemplate(true),
  nestTemplate(false),
  nextTemplate(true),
  nextTemplate(false),
  wsDemoTemplate(),
];

export function getTemplate(id: string): TemplateDef | undefined {
  return TEMPLATES.find((t) => t.manifest.id === id);
}
