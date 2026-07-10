// De-risk probe (NETWORK REQUIRED): can we run the REAL dev CLIs the way a
// developer actually does — `npm run dev` (Vite) and `npm run start:dev`
// (Nest CLI watch mode) — over real project structures, with colored TTY output?
//
//   node scripts/probe-realdev.mjs
//
// This decides the browser-demo revamp: if the real CLIs boot + serve + emit
// ANSI colors in-VM, the demo can drop the synthetic createServer()/tsc scripts
// and just run npm scripts like StackBlitz.

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { Worker, MessageChannel } from "node:worker_threads";

const only = process.argv[2]; // "vite" | "nest" | undefined (both)

const fsWorker = new Worker(new URL("./fs-worker.mjs", import.meta.url));
let onKernelFsMessage = () => {};
await new Promise((resolve) => {
  fsWorker.on("message", (m) => {
    if (m.type === "ready") resolve();
    else onKernelFsMessage(m);
  });
});
const kernelFs = createKernelFs(fsWorker);
onKernelFsMessage = kernelFs.onMessage;

// Capture ALL process stdout/stderr so we can inspect the banner + color codes.
let outBuf = "";
const tap = (chunk) => {
  outBuf += chunk;
  process.stdout.write(chunk); // mirror live so we watch the real colored output
};

const spawnWorker = (info) => {
  const w = new Worker(new URL("./process-worker.mjs", import.meta.url));
  w.on("message", (m) => {
    const h = info.on[m.type];
    if (h) h(m);
  });
  const { port1, port2 } = new MessageChannel();
  fsWorker.postMessage({ type: "fs-register", client: info.pid, sab: info.sab, port: port2 }, [port2]);
  const init = { type: "init", sab: info.sab, spec: info.spec, fsPort: port1 };
  const transfer = [port1];
  if (info.threadPort) {
    init.threadPort = info.threadPort;
    transfer.push(info.threadPort);
  }
  w.postMessage(init, transfer);
  return {
    terminate: () => {
      w.terminate();
      fsWorker.postMessage({ type: "fs-unregister", client: info.pid });
    },
    postMessage: (m) => w.postMessage(m),
  };
};
const fetcher = async (url) => {
  const r = await fetch(url, { redirect: "follow" });
  const body = new Uint8Array(await r.arrayBuffer());
  const headers = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  return { ok: r.ok, status: r.status, headers, body };
};

const listening = new Set();
const kernel = new Kernel({ fs: kernelFs.fs, spawnWorker, fetcher, stdout: tap, stderr: tap });
kernel.onListen = (port) => listening.add(port);
kernel.installCoreutils();

let failures = 0;
const assert = (cond, msg) => {
  console.log(`  ${cond ? "\u2713" : "\u2717"} ${msg}`);
  if (!cond) failures++;
};
const write = (path, contents) => {
  kernel.mkdirp(path.slice(0, path.lastIndexOf("/")));
  kernel.writeFile(path, contents);
};
const waitListen = async (port, ms) => {
  for (let i = 0; i < ms / 10 && !listening.has(port); i++) await new Promise((r) => setTimeout(r, 10));
  return listening.has(port);
};
const decode = (b) => (typeof b === "string" ? b : Buffer.from(b).toString());
const hasAnsi = (s) => /\x1b\[[0-9;]*m/.test(s);
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ── Vite react (real `npm create vite` shape) via `npm run dev` ───────────────
async function probeVite() {
  console.log("\n== Vite React (real structure) · npm run dev (network) ==");
  const D = "/vite-app";
  write(D + "/package.json", JSON.stringify({
    name: "vite-react", private: true, version: "0.0.0", type: "module",
    scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
    dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
    devDependencies: { "@vitejs/plugin-react": "^5.0.0", "babel-plugin-react-compiler": "latest", vite: "^8.0.0" },
  }, null, 2));
  write(D + "/vite.config.js",
    "import { defineConfig } from 'vite'\n" +
    "import react from '@vitejs/plugin-react'\n\n" +
    "export default defineConfig({\n" +
    "  plugins: [react({ babel: { plugins: [['babel-plugin-react-compiler', {}]] } })],\n" +
    "})\n");
  write(D + "/index.html",
    "<!doctype html>\n<html lang=\"en\">\n  <head>\n    <meta charset=\"UTF-8\" />\n" +
    "    <title>Vite + React</title>\n  </head>\n  <body>\n    <div id=\"root\"></div>\n" +
    "    <script type=\"module\" src=\"/src/main.jsx\"></script>\n  </body>\n</html>\n");
  write(D + "/src/main.jsx",
    "import { StrictMode } from 'react'\nimport { createRoot } from 'react-dom/client'\nimport App from './App.jsx'\n\n" +
    "createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>)\n");
  write(D + "/src/App.jsx",
    "import { useState } from 'react'\n\nexport default function App() {\n  const [count, setCount] = useState(0)\n" +
    "  return <button onClick={() => setCount((c) => c + 1)}>count is {count}</button>\n}\n");

  const inst = await kernel.start("npm", ["install"], { cwd: D, capture: true });
  assert(inst.code === 0, "npm install (vite react) resolves");
  if (inst.code !== 0) { console.log(inst.stderr.slice(-800)); return; }

  outBuf = "";
  // Real `npm run dev` (dev script = "vite"), but pass --configLoader native so
  // Vite loads vite.config.js without rolldown's config bundler (which throws
  // "Invalid URL" in-VM). Args after `--` reach the vite CLI.
  kernel.launch("npm", ["run", "dev", "--", "--configLoader", "native"], { cwd: D, env: { FORCE_COLOR: "3" } });
  const up = await waitListen(5173, 90000);
  assert(up, "vite dev server listens on :5173 (npm run dev)");
  await new Promise((r) => setTimeout(r, 300)); // let the banner flush
  const plain = stripAnsi(outBuf);
  assert(/VITE\s+v[\d.]+\s+ready/.test(plain), "prints the 'VITE vX.Y.Z ready' banner");
  assert(/Local:\s+http/.test(plain), "prints the '➜  Local:' line");
  assert(hasAnsi(outBuf), "banner carries ANSI color codes (FORCE_COLOR honored)");
  if (up) {
    const r = await kernel.handleHttpRequest(5173, { method: "GET", url: "/", headers: {}, body: "" });
    assert(r.status === 200 && decode(r.body).includes("root"), "GET / serves the index html");
    const m = await kernel.handleHttpRequest(5173, { method: "GET", url: "/src/main.jsx", headers: {}, body: "" });
    assert(m.status === 200 && /import|createRoot/.test(decode(m.body)), "GET /src/main.jsx serves transformed JSX");
  }
}

// ── NestJS (real `nest new` shape) via `npm run start:dev` (nest CLI watch) ───
async function probeNest() {
  console.log("\n== NestJS (real structure) · npm run start:dev = nest start --watch (network) ==");
  const D = "/nest-app";
  write(D + "/package.json", JSON.stringify({
    name: "nest-app", version: "0.0.1", private: true,
    scripts: {
      build: "nest build", start: "nest start", "start:dev": "nest start --watch",
      "start:prod": "node dist/main",
    },
    dependencies: {
      "@nestjs/common": "^11.0.0", "@nestjs/core": "^11.0.0",
      "@nestjs/platform-express": "^11.0.0", "reflect-metadata": "^0.2.0", rxjs: "^7.8.0",
    },
    devDependencies: {
      "@nestjs/cli": "^11.0.0", "@nestjs/schematics": "^11.0.0",
      "@types/node": "^22.0.0", typescript: "^5.7.0", "source-map-support": "^0.5.21",
    },
  }, null, 2));
  write(D + "/nest-cli.json", JSON.stringify({
    $schema: "https://json.schemastore.org/nest-cli",
    collection: "@nestjs/schematics", sourceRoot: "src",
    compilerOptions: { deleteOutDir: true },
  }, null, 2));
  write(D + "/tsconfig.json", JSON.stringify({
    compilerOptions: {
      module: "commonjs", declaration: true, removeComments: true,
      emitDecoratorMetadata: true, experimentalDecorators: true,
      allowSyntheticDefaultImports: true, target: "ES2023", sourceMap: true,
      outDir: "./dist", baseUrl: "./", incremental: true, skipLibCheck: true,
      strictNullChecks: true, forceConsistentCasingInFileNames: true, noImplicitAny: false,
    },
  }, null, 2));
  write(D + "/tsconfig.build.json", JSON.stringify({
    extends: "./tsconfig.json", exclude: ["node_modules", "test", "dist", "**/*spec.ts"],
  }, null, 2));
  write(D + "/src/main.ts",
    "import { NestFactory } from '@nestjs/core';\nimport { AppModule } from './app.module';\n\n" +
    "async function bootstrap() {\n  const app = await NestFactory.create(AppModule);\n" +
    "  await app.listen(process.env.PORT ?? 3000);\n}\nbootstrap();\n");
  write(D + "/src/app.module.ts",
    "import { Module } from '@nestjs/common';\nimport { AppController } from './app.controller';\nimport { AppService } from './app.service';\n\n" +
    "@Module({\n  imports: [],\n  controllers: [AppController],\n  providers: [AppService],\n})\nexport class AppModule {}\n");
  write(D + "/src/app.controller.ts",
    "import { Controller, Get } from '@nestjs/common';\nimport { AppService } from './app.service';\n\n" +
    "@Controller()\nexport class AppController {\n  constructor(private readonly appService: AppService) {}\n\n" +
    "  @Get()\n  getHello(): string {\n    return this.appService.getHello();\n  }\n}\n");
  write(D + "/src/app.service.ts",
    "import { Injectable } from '@nestjs/common';\n\n@Injectable()\nexport class AppService {\n" +
    "  getHello(): string {\n    return 'Hello World!';\n  }\n}\n");

  const inst = await kernel.start("npm", ["install"], { cwd: D, capture: true });
  assert(inst.code === 0, "npm install (nest + @nestjs/cli) resolves");
  if (inst.code !== 0) { console.log(inst.stderr.slice(-1200)); return; }

  outBuf = "";
  kernel.launch("npm", ["run", "start:dev"], { cwd: D, env: { FORCE_COLOR: "3" } });
  const up = await waitListen(3000, 120000);
  assert(up, "nest app listens on :3000 (nest start --watch)");
  await new Promise((r) => setTimeout(r, 500));
  assert(/watch mode/i.test(outBuf), "tsc prints 'Starting compilation in watch mode...'");
  assert(/\[Nest\]/.test(outBuf) && /NestApplication/.test(outBuf), "Nest logger prints the bootstrap lines");
  assert(hasAnsi(outBuf), "Nest logs carry ANSI color codes");
  if (up) {
    const r = await kernel.handleHttpRequest(3000, { method: "GET", url: "/", headers: {}, body: "" });
    assert(r.status === 200 && decode(r.body).includes("Hello World"), "GET / => 'Hello World!'");
  }
}

try {
  if (only !== "nest") await probeVite();
  if (only !== "vite") await probeNest();
} catch (e) {
  console.error("PROBE ERROR:", e && e.stack || e);
  failures++;
}
console.log("\nRESULT: " + (failures === 0 ? "PASS" : failures + " FAILED"));
process.exit(failures === 0 ? 0 : 1);
