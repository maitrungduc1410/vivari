// Studio-wiring spike (#1 — wire REAL TypeScript 7 (tsgo) into the shell).
//
// spike-tsgo.mjs proved the Go/wasm compiler boots + type-checks when loaded off
// the host disk. This proves the BROWSER path studio ships:
//
//   1) the vendor asset (packages/studio/public/vendor/tsgo-pack.bin, built by
//      `npm run vendor:tsgo`) decodes + unpacks into the VFS via the SHARED loader
//      packages/kernel-host/load-real-tsgo.js (same code studio's kernel worker
//      calls), which also writes the runner + the fd-1/2-routing fs shim, and
//   2) typing `tsc` / `tsgo` on PATH resolves to the real compiler via the
//      /bin/tsc.js + /bin/tsgo.js shims.
//
// Prereq: run `npm run vendor:tsgo` first. Requires Node >= 22 on the host (the
// runtime's vendored fs.js uses Array.fromAsync, which V8/Node 22+ provide).

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { ensureRealTsgo, TSGO_VFS_ROOT } from "../packages/kernel-host/load-real-tsgo.js";
import { initTransferList } from "../packages/kernel-host/worker-transfer.js";
import { Worker, MessageChannel } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const ASSET = path.join(ROOT, "packages", "studio", "public", "vendor", "tsgo-pack.bin");

if (!fs.existsSync(ASSET)) {
  console.error(`No vendor asset at ${path.relative(ROOT, ASSET)} — run \`npm run vendor:tsgo\` first.`);
  process.exit(2);
}

// ── kernel setup (same shape as spike-corepack-studio.mjs) ───────────────────
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
  if (info.threadPort) init.threadPort = info.threadPort;
  // A worker pool (tinypool, piscina, synckit) puts a MessagePort in workerData;
  // initTransferList is what knows those must be transferred on to the child.
  w.postMessage(init, initTransferList(info, port1));
  return {
    terminate: () => {
      w.terminate();
      fsWorker.postMessage({ type: "fs-unregister", client: info.pid });
    },
    postMessage: (m) => w.postMessage(m),
  };
};

const kernel = new Kernel({ fs: kernelFs.fs, spawnWorker });
kernel.installCoreutils();

// ── the wiring under test: the SHARED loader, fed the vendor asset ───────────
kernel.mkdirp("/home/user");
kernel.mkdirp("/app/src");
const t0 = Date.now();
const loaded = await ensureRealTsgo(kernel, async () => new Uint8Array(fs.readFileSync(ASSET)));
console.log(`ensureRealTsgo: version=${loaded && loaded.version} files=${loaded && loaded.fileCount} (${Date.now() - t0}ms)`);

// Gate A: /bin/tsc.js + /bin/tsgo.js are now the real runner shims.
const shimTsc = kernel.readFile("/bin/tsc.js") || "";
const shimTsgo = kernel.readFile("/bin/tsgo.js") || "";
const runnerPresent = kernel.isFile(TSGO_VFS_ROOT + "/tsgo-run.js") && kernel.isFile(TSGO_VFS_ROOT + "/wasm_exec.cjs");
const shimOk = shimTsc.includes(TSGO_VFS_ROOT + "/tsgo-run.js") && shimTsgo.includes(TSGO_VFS_ROOT + "/tsgo-run.js") && runnerPresent;
console.log(`shim gate: ${shimOk ? "PASS" : "FAIL"}  (/bin/tsc.js + /bin/tsgo.js -> real runner + engine)`);

const env = { HOME: "/home/user", PATH: "/bin", TMPDIR: "/tmp" };

// Gate B: `tsc --version` resolved via PATH -> /bin/tsc.js -> real Go compiler.
const v = await kernel.start("tsc", ["--version"], { cwd: "/app", env, capture: true });
const versionOk = v.code === 0 && /Version\s+7\./.test(v.stdout || "");
console.log(`version gate: ${versionOk ? "PASS" : "FAIL"}  tsc --version -> ${JSON.stringify((v.stdout || "").trim())}`);
if (!versionOk && v.stderr) console.log("stderr:\n" + v.stderr.trim());

// Gate C: type-check a clean project (exit 0) then a broken one (exit != 0).
kernel.writeFile(
  "/app/tsconfig.json",
  JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2020", module: "ESNext", moduleResolution: "bundler" }, include: ["src"] }, null, 2),
);
kernel.writeFile("/app/src/index.ts", `export const add = (a: number, b: number): number => a + b;\nexport default add(1, 2);\n`);
const good = await kernel.start("tsgo", ["-p", "/app/tsconfig.json"], { cwd: "/app", env, capture: true });
console.log(`clean type-check: exit=${good.code}`);
if (good.code !== 0) console.log("stdout:\n" + (good.stdout || "").trim() + "\nstderr:\n" + (good.stderr || "").trim());

kernel.writeFile("/app/src/index.ts", `export const add = (a: number, b: number): number => a + b;\nconst r: string = add(1, 2);\nexport default r;\n`);
const bad = await kernel.start("tsgo", ["-p", "/app/tsconfig.json"], { cwd: "/app", env, capture: true });
const diag = ((bad.stdout || "") + (bad.stderr || "")).trim();
const checkOk = good.code === 0 && bad.code !== 0 && /TS\d+|not assignable/i.test(diag);
console.log(`type-check gate: ${checkOk ? "PASS" : "FAIL"}  (clean=exit 0, broken=exit ${bad.code})`);
if (diag) console.log("diagnostics:\n" + diag);

const ok = shimOk && versionOk && checkOk;
console.log(`\nRESULT: ${ok ? "PASS — studio ships real TypeScript 7 (shim + shared loader + VFS type-check)" : "FAIL — see logs above"}`);
process.exit(ok ? 0 : 1);
