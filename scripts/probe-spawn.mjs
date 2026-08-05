// Fast, offline repro of the Nest-CLI spawn failure: does spawn('node',
// ['--enable-source-maps', 'main.js'], {stdio:'inherit'}) work in-VM?
import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { initTransferList } from "../packages/kernel-host/worker-transfer.js";
import { Worker, MessageChannel } from "node:worker_threads";

const fsWorker = new Worker(new URL("./fs-worker.mjs", import.meta.url));
let onKernelFsMessage = () => {};
await new Promise((r) => fsWorker.on("message", (m) => (m.type === "ready" ? r() : onKernelFsMessage(m))));
const kernelFs = createKernelFs(fsWorker);
onKernelFsMessage = kernelFs.onMessage;
const spawnWorker = (info) => {
  const w = new Worker(new URL("./process-worker.mjs", import.meta.url));
  w.on("message", (m) => info.on[m.type]?.(m));
  const { port1, port2 } = new MessageChannel();
  fsWorker.postMessage({ type: "fs-register", client: info.pid, sab: info.sab, port: port2 }, [port2]);
  const init = { type: "init", sab: info.sab, spec: info.spec, fsPort: port1 };
  if (info.threadPort) init.threadPort = info.threadPort;
  // A worker pool (tinypool, piscina, synckit) puts a MessagePort in workerData;
  // initTransferList is what knows those must be transferred on to the child.
  w.postMessage(init, initTransferList(info, port1));
  return { terminate: () => { w.terminate(); fsWorker.postMessage({ type: "fs-unregister", client: info.pid }); }, postMessage: (m) => w.postMessage(m) };
};
const kernel = new Kernel({ fs: kernelFs.fs, spawnWorker, fetcher: async () => ({ ok: false, status: 404, headers: {}, body: new Uint8Array() }), stdout: (c) => process.stdout.write(c), stderr: (c) => process.stdout.write(c) });
kernel.installCoreutils();

console.log("isFile(/bin/node) =", kernel.isFile("/bin/node"));

kernel.mkdirp("/app");
kernel.writeFile("/app/package.json", JSON.stringify({ name: "app", version: "1.0.0", scripts: { start: "node parent.js" } }, null, 2));
kernel.writeFile("/app/main.js", "console.log('CHILD_OK argv=' + JSON.stringify(process.argv.slice(2)))");
kernel.writeFile(
  "/app/parent.js",
  "const { spawn } = require('child_process');\n" +
  "console.log('parent PATH=' + JSON.stringify(process.env.PATH));\n" +
  "for (const variant of [['main.js'], ['--enable-source-maps','main.js']]) {\n" +
  "  const c = spawn('node', variant, { stdio: 'inherit' });\n" +
  "  c.on('error', (e) => console.log('SPAWN_ERR', JSON.stringify(variant), e.code));\n" +
  "  c.on('exit', (code) => console.log('CHILD_EXIT', JSON.stringify(variant), code));\n" +
  "}\n" +
  "setTimeout(() => process.exit(0), 1500);\n",
);
// Faithful to Nest: run through `npm run start` so parent.js gets the binPath env.
const res = await kernel.start("npm", ["run", "start"], { cwd: "/app", capture: true });
console.log("--- parent stdout ---\n" + res.stdout);
console.log("--- parent stderr ---\n" + res.stderr);
console.log("parent exit", res.code);
process.exit(0);
