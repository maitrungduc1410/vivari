// Spike - persistent dependency cache (P1: node_modules keyed by lockfile).
//
// Proves the SHIPPED code path: the kernel-fs client's depCache* round-trips, the
// FS Worker's dep-cache handlers, and packages/kernel-host/dep-cache.js's
// pack/restore against the real Rust/Wasm VFS. Fully OFFLINE + deterministic (no
// registry) - it fabricates a small node_modules (files + a symlink), snapshots
// it, wipes it, restores it, and require()s the result inside the VM.
//
// The browser stores snapshots in OPFS; headless (no OPFS) wires an in-memory
// store in scripts/fs-worker.mjs - the pack/restore + VFS logic under test is the
// same. Run: `node scripts/spike-dep-cache.mjs` (needs the Wasm VFS build).

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { hashDepKey } from "../packages/kernel-host/dep-cache.js";
import { Worker, MessageChannel } from "node:worker_threads";

const DIR = "/app";

// kernel setup (same shape as the other studio spikes)
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

const kernel = new Kernel({ fs: kernelFs.fs, spawnWorker });
kernel.installCoreutils();
kernel.mkdirp(DIR);

const ENV = { HOME: "/home/user", PATH: "/bin", PWD: DIR };
const runNode = (src, name) => {
  const p = `${DIR}/${name}`;
  kernel.writeFile(p, src);
  return kernel.start("node", [p], { cwd: DIR, env: ENV, capture: true });
};

let ok = true;
const gate = (label, pass, extra = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${extra ? "  - " + extra : ""}`);
  if (!pass) ok = false;
};

// A realistic project: package.json + a lockfile + a fabricated node_modules with
// a package and a symlink (pnpm-style), so pack/restore fidelity is exercised.
kernel.writeFile(
  `${DIR}/package.json`,
  JSON.stringify({ name: "app", version: "1.0.0", private: true, dependencies: { leftpad: "1.0.0" } }, null, 2),
);
kernel.writeFile(
  `${DIR}/package-lock.json`,
  JSON.stringify({ name: "app", lockfileVersion: 3, packages: { "node_modules/leftpad": { version: "1.0.0" } } }, null, 2),
);

const setup = await runNode(
  `const fs = require('fs');
   fs.mkdirSync('${DIR}/node_modules/leftpad', { recursive: true });
   fs.writeFileSync('${DIR}/node_modules/leftpad/package.json', JSON.stringify({ name: 'leftpad', version: '1.0.0', main: 'index.js' }));
   fs.writeFileSync('${DIR}/node_modules/leftpad/index.js', "module.exports = (s, n) => String(s).padStart(n);");
   fs.symlinkSync('leftpad', '${DIR}/node_modules/aliaspkg');
   console.log('SETUP_OK');`,
  "setup.js",
);
gate("scaffold node_modules (file + symlink)", setup.code === 0 && /SETUP_OK/.test(setup.stdout || ""), setup.stderr.trim());

// the cache mechanics under test
const lockBytes = kernelFs.fs.readFileBytes(`${DIR}/package-lock.json`);
const pjBytes = kernelFs.fs.readFileBytes(`${DIR}/package.json`);
const lockKey = await hashDepKey("npm", lockBytes, "package-lock.json");
const pjKey = await hashDepKey("npm", pjBytes, "package.json");

gate("has() miss before save", (await kernelFs.fs.depCacheHas(lockKey)) === false);

const saved = await kernelFs.fs.depCacheSave(lockKey, DIR, [pjKey]);
gate("save() packs node_modules", !!saved && saved.files >= 2, saved ? `${saved.files} files, ${saved.bytes}B` : "null");
gate("has() hit after save (lockfile key)", (await kernelFs.fs.depCacheHas(lockKey)) === true);
gate("has() hit via package.json alias", (await kernelFs.fs.depCacheHas(pjKey)) === true);
gate("has() miss for an unknown key", (await kernelFs.fs.depCacheHas(lockKey + "x")) === false);

// Wipe node_modules, then restore from the lockfile-keyed snapshot.
await runNode(`require('fs').rmSync('${DIR}/node_modules', { recursive: true, force: true }); console.log('WIPED');`, "wipe.js");
gate("node_modules removed before restore", kernel.exists(`${DIR}/node_modules`) === false);

const restored = await kernelFs.fs.depCacheRestore(lockKey, DIR);
gate("restore() rebuilds the tree", restored > 0, `${restored} entries`);

const verify = await runNode(
  `const fs = require('fs');
   const lp = require('leftpad');
   const al = require('aliaspkg');
   const link = fs.readlinkSync('${DIR}/node_modules/aliaspkg');
   console.log('VERIFY ' + JSON.stringify(lp('x', 3)) + ' ' + (typeof al === 'function') + ' ' + link);`,
  "verify.js",
);
const vOk = verify.code === 0 && /VERIFY "  x" true leftpad/.test(verify.stdout || "");
gate("require() restored pkg + symlink intact", vOk, (verify.stdout || verify.stderr || "").trim());

// The alias path: wipe again and restore via the package.json key (what a
// brand-new project of the same template hits before it has a lockfile).
await runNode(`require('fs').rmSync('${DIR}/node_modules', { recursive: true, force: true });`, "wipe2.js");
const restoredAlias = await kernelFs.fs.depCacheRestore(pjKey, DIR);
gate("restore() via package.json alias", restoredAlias > 0 && kernel.exists(`${DIR}/node_modules/leftpad/index.js`), `${restoredAlias} entries`);

await fsWorker.terminate();
console.log(`\nRESULT: ${ok ? "PASS - persistent dependency cache save/restore verified" : "FAIL - see gates above"}`);
process.exit(ok ? 0 : 1);