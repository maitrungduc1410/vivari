// Scratch probe (NETWORK): compile + boot a real NestJS app in-VM to surface
// missing Node APIs. Nest needs decorator metadata (reflect-metadata +
// emitDecoratorMetadata), so we compile with the real `tsc` in-VM, then run it.
//
//   node scripts/probe-nest.mjs

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { Worker, MessageChannel } from "node:worker_threads";

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
const kernel = new Kernel({
  fs: kernelFs.fs,
  spawnWorker,
  fetcher,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
});
kernel.onListen = (port) => listening.add(port);
kernel.installCoreutils();

const DIR = "/nest";
const PORT = 3011;
const log = (...a) => console.log(...a);
const decode = (b) => (typeof b === "string" ? b : Buffer.from(b).toString());
kernel.mkdirp(DIR + "/src");

kernel.writeFile(
  DIR + "/package.json",
  JSON.stringify({ name: "nest-demo", version: "1.0.0", private: true }, null, 2),
);
kernel.writeFile(
  DIR + "/tsconfig.json",
  JSON.stringify(
    {
      compilerOptions: {
        module: "commonjs",
        target: "es2021",
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        esModuleInterop: true,
        skipLibCheck: true,
        outDir: "dist",
        sourceMap: false,
        declaration: false,
      },
      include: ["src/**/*.ts"],
    },
    null,
    2,
  ),
);
kernel.writeFile(
  DIR + "/src/app.service.ts",
  `
import { Injectable } from '@nestjs/common';
@Injectable()
export class AppService {
  hello(): string { return 'Hello from NestJS in Vivari'; }
}
`,
);
kernel.writeFile(
  DIR + "/src/app.controller.ts",
  `
import { Controller, Get, Header } from '@nestjs/common';
import { AppService } from './app.service';
@Controller()
export class AppController {
  constructor(private readonly svc: AppService) {}
  @Get()
  @Header('Content-Type', 'text/html')
  root(): string {
    return \`<!doctype html><h1>NestJS</h1><p>\${this.svc.hello()}</p>\`;
  }
  @Get('api/hello')
  hello(): { ok: boolean; msg: string; node: string } {
    return { ok: true, msg: this.svc.hello(), node: process.version };
  }
}
`,
);
kernel.writeFile(
  DIR + "/src/app.module.ts",
  `
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
@Module({ controllers: [AppController], providers: [AppService] })
export class AppModule {}
`,
);
kernel.writeFile(
  DIR + "/src/main.ts",
  `
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  await app.listen(${PORT}, '127.0.0.1');
  console.log('NEST_READY');
}
bootstrap().catch((e) => { console.log('NEST_ERR ' + (e && e.stack || e)); process.exit(1); });
`,
);

log("== npm install (nest core/common/platform-express + tsc) ==");
const inst = await kernel.start(
  "npm",
  [
    "install",
    "@nestjs/core",
    "@nestjs/common",
    "@nestjs/platform-express",
    "reflect-metadata",
    "rxjs",
    "typescript@5",
    "@types/node",
  ],
  { cwd: DIR, capture: true },
);
log("  install code=" + inst.code);
if (inst.code !== 0) {
  log("  STDERR:", (inst.stderr || "").slice(-2000));
  process.exit(1);
}

log("== tsc compile ==");
const tsc = await kernel.start("node", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], {
  cwd: DIR,
  capture: true,
});
log("  tsc code=" + tsc.code);
if (tsc.stdout && tsc.stdout.trim()) log("  tsc stdout:\n" + tsc.stdout.trim().slice(0, 2000));
if (tsc.stderr && tsc.stderr.trim()) log("  tsc stderr:\n" + tsc.stderr.trim().slice(0, 2000));
log("  dist/main.js exists: " + kernel.exists(DIR + "/dist/main.js"));
if (tsc.code !== 0) process.exit(1);

log("== boot nest ==");
kernel.start("node", ["dist/main.js"], { cwd: DIR });
for (let i = 0; i < 3000 && !listening.has(PORT); i++) await new Promise((r) => setTimeout(r, 20));
log("  listening on " + PORT + ": " + listening.has(PORT));
if (!listening.has(PORT)) process.exit(1);

const get = (url) =>
  kernel.handleHttpRequest(PORT, { port: PORT, method: "GET", url, headers: { host: "127.0.0.1:" + PORT }, body: "" });
let root = await get("/");
for (let i = 0; i < 40 && root.status === 502; i++) {
  await new Promise((r) => setTimeout(r, 250));
  root = await get("/");
}
log("  GET / -> " + root.status + " (html: " + decode(root.body).includes("<h1>NestJS</h1>") + ")");
log("  body: " + decode(root.body).slice(0, 120));
const api = await get("/api/hello");
log("  GET /api/hello -> " + api.status);
log("  api body: " + decode(api.body).slice(0, 200));
process.exit(0);
