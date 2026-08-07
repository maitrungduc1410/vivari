// Spike (NETWORK): the NestJS template's real reload. `npm run start:dev` (= `nest
// start --watch`, which is the shipped `nest-ts` manifest's dev command) boots, then a
// source edit must recompile, restart the app child, and serve the new response.
//
// WHY IT IS A SPIKE NOW. It was `probe-nest-watch.mjs`, wired into nothing — not the
// registry, not CI, not package.json — and it had stopped working: it asked for `npm`
// from `installCoreutils()`, that built-in was removed, and it died on `npm: not found`
// before doing anything. Nothing noticed, because nothing ran it. It was then cited in
// review as the guard for exactly the risk this MR touches, which is the failure mode
// this MR is otherwise about: an artifact that looks like coverage while providing
// none. It loads the vendored npm the way every other in-VM spike does, and it passes
// in ~20s, which is cheap enough that leaving it unwired was the only real objection.
//
// It is also the live check on nest's side of the `child.stdin` change: `@nestjs/cli`
// spawns the app with `stdio: 'inherit'` and guards `childProcessRef.stdin &&
// childProcessRef.stdin.pause()` before killing it. On real node that guard is false;
// it is now false here too, and this is the path where that runs.
//
// The app is a minimal one rather than the shipped template's, deliberately: what is
// under test is the reload MECHANISM, and a tiny module recompiles in a second and
// fails for one reason. The shipped template's own boot is a different question.
//
//   node scripts/spike-nest-watch.mjs
import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { stubNodeGyp } from "../packages/kernel-host/node-gyp-stub.js";
import { applyRealNpmShims } from "../packages/kernel-host/load-real-npm.js";
import { initTransferList } from "../packages/kernel-host/worker-transfer.js";
import { Worker, MessageChannel } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";

const fsWorker = new Worker(new URL("./fs-worker.mjs", import.meta.url));
let onKernelFsMessage = () => {};
await new Promise((resolve) => { fsWorker.on("message", (m) => { if (m.type === "ready") resolve(); else onKernelFsMessage(m); }); });
const kernelFs = createKernelFs(fsWorker);
onKernelFsMessage = kernelFs.onMessage;
const spawnWorker = (info) => {
  const w = new Worker(new URL("./process-worker.mjs", import.meta.url));
  w.on("message", (m) => { const h = info.on[m.type]; if (h) h(m); });
  const { port1, port2 } = new MessageChannel();
  fsWorker.postMessage({ type: "fs-register", client: info.pid, sab: info.sab, port: port2 }, [port2]);
  const init = { type: "init", sab: info.sab, spec: info.spec, fsPort: port1 };
  if (info.threadPort) init.threadPort = info.threadPort;
  // A worker pool (tinypool, piscina, synckit) puts a MessagePort in workerData;
  // initTransferList is what knows those must be transferred on to the child.
  w.postMessage(init, initTransferList(info, port1));
  return { terminate: () => { w.terminate(); fsWorker.postMessage({ type: "fs-unregister", client: info.pid }); }, postMessage: (m) => w.postMessage(m) };
};
const fetcher = async (url) => {
  const r = await fetch(url, { redirect: "follow" });
  const body = new Uint8Array(await r.arrayBuffer());
  const headers = {}; r.headers.forEach((v, k) => (headers[k] = v));
  return { ok: r.ok, status: r.status, headers, body };
};
const listening = new Set();
const kernel = new Kernel({ fs: kernelFs.fs, spawnWorker, fetcher, stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) });
kernel.onListen = (p) => { listening.add(p); console.log("  [onListen] :" + p); };
kernel.installCoreutils();
const write = (p, contents) => { kernel.mkdirp(p.slice(0, p.lastIndexOf("/"))); kernel.writeFile(p, contents); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The vendored npm, into the VFS, plus the `/bin/npm` shim. This probe used to rely on
// `installCoreutils()` supplying an `npm` command; that built-in was removed, and since
// nothing runs this file, nothing noticed. It exited on `npm: not found` — an artifact
// that looked like the guard for a risk while being unable to start.
const VFS_NPM = "/usr/lib/node_modules/npm";
const VENDOR_NPM = process.argv[2] || "/tmp/vv-vendor/node_modules/npm";
if (!fs.existsSync(path.join(VENDOR_NPM, "bin/npm-cli.js"))) {
  console.error(`No vendored npm at ${VENDOR_NPM} (expected bin/npm-cli.js).`);
  console.error("Vendor it:  rm -rf /tmp/vv-vendor && mkdir -p /tmp/vv-vendor && (cd /tmp/vv-vendor && npm install npm@10.9.2 --no-save --no-audit --no-fund)");
  process.exit(2);
}
function loadDir(hostDir, vfsDir) {
  kernel.mkdirp(vfsDir);
  for (const entry of fs.readdirSync(hostDir, { withFileTypes: true })) {
    const hostPath = path.join(hostDir, entry.name);
    const vfsPath = vfsDir + "/" + entry.name;
    if (entry.isDirectory()) loadDir(hostPath, vfsPath);
    else if (entry.isFile()) kernel.writeFile(vfsPath, fs.readFileSync(hostPath));
  }
}
loadDir(VENDOR_NPM, VFS_NPM);
stubNodeGyp(kernel, VFS_NPM);
applyRealNpmShims(kernel);
kernel.mkdirp("/home/user");
kernel.mkdirp("/tmp/.npm/_logs");
const decode = (b) => (typeof b === "string" ? b : Buffer.from(b).toString());

const D = "/nest-app";
const PORT = 3000;
write(D + "/package.json", JSON.stringify({ name: "nest-app", version: "0.0.1", private: true, license: "UNLICENSED", scripts: { build: "nest build", start: "nest start", "start:dev": "nest start --watch", "start:prod": "node dist/main" }, dependencies: { "@nestjs/common": "^11.0.1", "@nestjs/core": "^11.0.1", "@nestjs/platform-express": "^11.0.1", "reflect-metadata": "^0.2.2", rxjs: "^7.8.1" }, devDependencies: { "@nestjs/cli": "^11.0.0", "@nestjs/schematics": "^11.0.0", "@types/node": "^22.10.7", "source-map-support": "^0.5.21", typescript: "^5.7.3" } }, null, 2));
write(D + "/nest-cli.json", JSON.stringify({ collection: "@nestjs/schematics", sourceRoot: "src", compilerOptions: { deleteOutDir: true } }, null, 2));
write(D + "/tsconfig.json", JSON.stringify({ compilerOptions: { module: "commonjs", declaration: true, removeComments: true, emitDecoratorMetadata: true, experimentalDecorators: true, allowSyntheticDefaultImports: true, target: "ES2023", sourceMap: true, outDir: "./dist", baseUrl: "./", incremental: true, skipLibCheck: true, strictNullChecks: true, forceConsistentCasingInFileNames: true, noImplicitAny: false, strictBindCallApply: false, noFallthroughCasesInSwitch: false } }, null, 2));
write(D + "/tsconfig.build.json", JSON.stringify({ extends: "./tsconfig.json", exclude: ["node_modules", "test", "dist", "**/*spec.ts"] }, null, 2));
write(D + "/src/main.ts", "import { NestFactory } from '@nestjs/core';\nimport { AppModule } from './app.module';\nasync function bootstrap() {\n  const app = await NestFactory.create(AppModule);\n  await app.listen(process.env.PORT ?? 3000);\n}\nbootstrap();\n");
write(D + "/src/app.module.ts", "import { Module } from '@nestjs/common';\nimport { AppController } from './app.controller';\nimport { AppService } from './app.service';\n@Module({ imports: [], controllers: [AppController], providers: [AppService] })\nexport class AppModule {}\n");
write(D + "/src/app.controller.ts", "import { Controller, Get } from '@nestjs/common';\nimport { AppService } from './app.service';\n@Controller()\nexport class AppController {\n  constructor(private readonly appService: AppService) {}\n  @Get()\n  getHello(): string { return this.appService.getHello(); }\n}\n");
write(D + "/src/app.service.ts", "import { Injectable } from '@nestjs/common';\n@Injectable()\nexport class AppService {\n  getHello(): string { return 'Hello World!'; }\n}\n");

const ENV = {
  HOME: "/home/user",
  PATH: D + "/node_modules/.bin:/bin",
  npm_config_cache: "/tmp/.npm",
  FORCE_COLOR: "0",
};

console.log("== npm install ==");
const inst = await kernel.start("npm", ["install", "--no-audit", "--no-fund"], { cwd: D, env: ENV, capture: true });
console.log("  install code=" + inst.code);
if (inst.code !== 0) { console.log((inst.stderr || "").slice(-1500)); process.exit(1); }

console.log("== npm run start:dev (nest start --watch) ==");
kernel.launch("npm", ["run", "start:dev"], { cwd: D, env: ENV });
for (let i = 0; i < 6000 && !listening.has(PORT); i++) await sleep(20);
console.log("  listening:", listening.has(PORT));
if (!listening.has(PORT)) { console.log("  never listened"); process.exit(1); }

const get = () => kernel.handleHttpRequest(PORT, { port: PORT, method: "GET", url: "/", headers: { host: "127.0.0.1" }, body: "" });
let r = await get();
for (let i = 0; i < 40 && r.status === 502; i++) { await sleep(250); r = await get(); }
console.log("  GET / -> " + r.status + " body=" + JSON.stringify(decode(r.body).slice(0, 40)));

console.log("\n== edit src/app.service.ts (Hello World! -> Reloaded!) ==");
kernel.writeFile(D + "/src/app.service.ts", "import { Injectable } from '@nestjs/common';\n@Injectable()\nexport class AppService {\n  getHello(): string { return 'Reloaded!'; }\n}\n");

// Wait for recompile + restart, then verify the NEW response is served.
let ok = false;
for (let i = 0; i < 120; i++) {
  await sleep(500);
  let rr;
  try { rr = await get(); } catch { continue; }
  const body = decode(rr.body);
  if (rr.status === 200 && body.includes("Reloaded!")) { console.log("  after " + ((i + 1) * 500) + "ms: GET / -> 200 body=" + JSON.stringify(body.slice(0, 40))); ok = true; break; }
}
console.log(ok ? "\nRESULT: PASS (nest recompiled + restarted, new response served)" : "\nRESULT: FAIL (no reload)");
process.exit(ok ? 0 : 1);