// Spike: run the REAL vitest test runner in-VM (Phase 7 — test runner + module ctor).
//
// Vitest is Vite-based (rolldown) and drives test files through Vite's transform +
// a worker pool. We have worker_threads (not fork), so we force pool=threads. This
// proves the browser-shaped path: real npm installs vitest (selecting the wasm
// rolldown build, like the studio Vite demo), then `vitest run` executes a trivial
// test suite to green.
//
// Prereq: `npm run vendor:npm` (the npm delivery asset). Network required.
//   node scripts/spike-vitest.mjs        (OC_LIVE=1 streams output)

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { ensureRealNpm } from "../packages/kernel-host/load-real-npm.js";
import { Worker, MessageChannel } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const NPM_ASSET = path.join(ROOT, "packages", "studio", "public", "vendor", "npm-pack.bin");
if (!fs.existsSync(NPM_ASSET)) {
  console.error(`No npm asset at ${path.relative(ROOT, NPM_ASSET)} — run \`npm run vendor:npm\` first.`);
  process.exit(2);
}

// ── kernel setup (same shape as spike-npm.mjs) ───────────────────────────────
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
const fetcher = async (url, init) => {
  const r = await fetch(url, { redirect: "follow", ...(init || {}) });
  const body = new Uint8Array(await r.arrayBuffer());
  const headers = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  return { ok: r.ok, status: r.status, statusText: r.statusText, headers, body };
};

const LIVE = process.env.OC_LIVE === "1";
const kernel = new Kernel({
  fs: kernelFs.fs,
  spawnWorker,
  fetcher,
  stdout: LIVE ? (s) => process.stderr.write(s) : undefined,
  stderr: LIVE ? (s) => process.stderr.write(s) : undefined,
});
kernel.installCoreutils();
let fetchN = 0;
kernel.onFetch = (url, info) => {
  fetchN++;
  if (LIVE || fetchN % 25 === 0) process.stderr.write(`  [net ${fetchN}] ${((info.size / 1024) | 0)}k  ${url}\n`);
};

kernel.mkdirp("/home/user");
kernel.mkdirp("/tmp/.npm/_logs");
kernel.mkdirp("/app");
await ensureRealNpm(kernel, async () => new Uint8Array(fs.readFileSync(NPM_ASSET)));
console.log("real npm ready\n");

// ── scaffold a trivial test project ──────────────────────────────────────────
kernel.writeFile("/app/package.json", JSON.stringify({ name: "app", version: "1.0.0", private: true, type: "module" }, null, 2));
kernel.writeFile("/app/sum.js", "export function sum(a, b) { return a + b; }\n");
kernel.writeFile(
  "/app/sum.test.js",
  `import { describe, it, expect } from "vitest";
import { sum } from "./sum.js";
describe("sum", () => {
  it("adds", () => { expect(sum(1, 2)).toBe(3); });
  it("adds negatives", () => { expect(sum(-1, -2)).toBe(-3); });
});
`,
);
// We have worker_threads (not fork) — force pool=threads, single worker, no
// isolation churn. Passed as CLI flags (below) rather than a config file so we
// don't depend on rolldown bundling a vitest.config.* first.

const env = {
  HOME: "/home/user",
  PATH: "/app/node_modules/.bin:/bin",
  npm_config_cache: "/tmp/.npm",
  CI: "1",
  OC_LIVE: LIVE ? "1" : "",
  OC_TRACE_MODULES: process.env.OC_TRACE_MODULES || "",
};

// ── install vitest (real registry via Fetcher Worker) ────────────────────────
console.log("── npm install vitest (in-VM; pulls vite + wasm rolldown) ──");
const TIMEOUT_INSTALL = Number(process.env.OC_INSTALL_TIMEOUT || 600000);
const ti = Date.now();
let instTimedOut = false;
const inst = await Promise.race([
  kernel.start("npm", ["install", "vitest", "--no-audit", "--no-fund", "--loglevel=http"], { cwd: "/app", env, capture: !LIVE }),
  new Promise((r) => setTimeout(() => { instTimedOut = true; r({ code: 124, stdout: "", stderr: "TIMEOUT" }); }, TIMEOUT_INSTALL)),
]);
console.log(`install exit=${inst.code}${instTimedOut ? " (TIMED OUT)" : ""}  (${((Date.now() - ti) / 1000).toFixed(1)}s, ${fetchN} fetches)`);
if (!LIVE && inst.stderr && inst.stderr.trim()) console.log("install stderr (tail):\n" + inst.stderr.trim().split("\n").slice(-20).join("\n"));
const vitestInstalled = kernel.exists("/app/node_modules/vitest/vitest.mjs");
console.log(`vitest installed: ${vitestInstalled}\n`);
if (!vitestInstalled) {
  console.log("RESULT: FAIL — vitest did not install");
  process.exit(1);
}

// ── the gate: `vitest run` goes green on the trivial suite ───────────────────
console.log("── vitest run ──");
const TIMEOUT_RUN = Number(process.env.OC_RUN_TIMEOUT || 240000);
const tr = Date.now();
let runTimedOut = false;
const RUN_ARGS = [
  "/app/node_modules/vitest/vitest.mjs",
  "run",
  "--pool=threads",
  "--no-file-parallelism",
  "--no-isolate",
];
const run = await Promise.race([
  kernel.start("node", RUN_ARGS, { cwd: "/app", env, capture: !LIVE }),
  new Promise((r) => setTimeout(() => { runTimedOut = true; r({ code: 124, stdout: "", stderr: "TIMEOUT" }); }, TIMEOUT_RUN)),
]);
console.log(`vitest exit=${run.code}${runTimedOut ? " (TIMED OUT)" : ""}  (${((Date.now() - tr) / 1000).toFixed(1)}s)`);
const out = (run.stdout || "") + "\n" + (run.stderr || "");
if (out.trim()) console.log("── vitest output ──\n" + out.trim());

const passed = run.code === 0 && /(2 passed|Tests\s+2 passed)/.test(out) && !/(1 failed|failed \()/.test(out);

// Negative control: a deliberately failing assertion must be REPORTED as a
// failure (non-zero exit) — otherwise "green" could be a false positive from
// tests that never actually execute.
console.log("\n── vitest run (negative control: 1 failing test) ──");
kernel.writeFile(
  "/app/fail.test.js",
  `import { it, expect } from "vitest";
it("is supposed to fail", () => { expect(1 + 1).toBe(3); });
`,
);
const neg = await Promise.race([
  kernel.start("node", [...RUN_ARGS, "fail.test.js"], { cwd: "/app", env, capture: !LIVE }),
  new Promise((r) => setTimeout(() => r({ code: 124, stdout: "", stderr: "TIMEOUT" }), TIMEOUT_RUN)),
]);
const negOut = (neg.stdout || "") + "\n" + (neg.stderr || "");
const detectsFailure = neg.code !== 0 && /(1 failed|❯|expected|AssertionError|toBe)/i.test(negOut);
console.log(`negative control exit=${neg.code} → detects failure: ${detectsFailure ? "PASS" : "FAIL"}`);

const ok = passed && detectsFailure;
console.log("\nRESULT: " + (ok ? "PASS — real vitest runs a suite to green AND flags failures in-VM" : "FAIL — see logs above"));
process.exit(ok ? 0 : 1);
