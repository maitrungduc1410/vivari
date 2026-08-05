// Spike: run the REAL vitest test runner in-VM (Phase 7 — test runner + module ctor).
//
// Vitest is Vite-based (rolldown) and drives test files through Vite's transform +
// a worker pool. We have worker_threads (not fork), so we force pool=threads. This
// proves the browser-shaped path: real npm installs vitest (selecting the wasm
// esbuild/rolldown builds via the shared native->wasm aliasing, like the studio
// Vite demo), then `vitest run` executes a trivial test suite to green.
//
// Uses the shared spike harness (scripts/lib/spike-harness.mjs), so it boots the
// SAME kernel + aliased fetcher + real-npm shims as every other network spike and
// needs only the vendored npm at /tmp/vv-vendor (auto-provisioned by
// scripts/run-spikes.mjs). Network required.
//   node scripts/spike-vitest.mjs        (VV_LIVE=1 streams output)

import { bootSpikeKernel, writeProject, defaultEnv, LIVE } from "./lib/spike-harness.mjs";

// { npm: true }: this spike runs `npm install vitest` itself rather than through
// the harness's npmInstall(), so it needs the real CLI on PATH from the start.
const h = await bootSpikeKernel({ npm: true });
const kernel = h.kernel;
kernel.mkdirp("/app");

// ── scaffold a trivial test project ──────────────────────────────────────────
writeProject(kernel, "/app", {
  "package.json": JSON.stringify({ name: "app", version: "1.0.0", private: true, type: "module" }, null, 2),
  "sum.js": "export function sum(a, b) { return a + b; }\n",
  "sum.test.js": `import { describe, it, expect } from "vitest";
import { sum } from "./sum.js";
describe("sum", () => {
  it("adds", () => { expect(sum(1, 2)).toBe(3); });
  it("adds negatives", () => { expect(sum(-1, -2)).toBe(-3); });
});
`,
});
// We have worker_threads (not fork) — force pool=threads, single worker, no
// isolation churn. Passed as CLI flags (below) rather than a config file so we
// don't depend on rolldown bundling a vitest.config.* first.

const env = {
  ...defaultEnv("/app"),
  CI: "1",
  VV_TRACE_MODULES: process.env.VV_TRACE_MODULES || "",
};

// ── install vitest (real registry via the aliased Fetcher) ───────────────────
console.log("── npm install vitest (in-VM; pulls vite + wasm esbuild/rolldown) ──");
const TIMEOUT_INSTALL = Number(process.env.VV_INSTALL_TIMEOUT || 600000);
const ti = Date.now();
let instTimedOut = false;
const inst = await Promise.race([
  // @rolldown/binding-wasm32-wasi comes along by name because vitest 4 pulls Vite 8,
  // and rolldown 1.2.2 dropped the wasm32 binding from its optionalDependencies —
  // without it the run dies at startup with "Cannot find native binding". This spike
  // declares its dependencies on the install line rather than in a package.json, so
  // that is where the binding goes.
  kernel.start("npm", ["install", "vitest", "@rolldown/binding-wasm32-wasi@~1.2.0", "--no-audit", "--no-fund", "--loglevel=http"], { cwd: "/app", env, capture: !LIVE }),
  new Promise((r) => setTimeout(() => { instTimedOut = true; r({ code: 124, stdout: "", stderr: "TIMEOUT" }); }, TIMEOUT_INSTALL)),
]);
console.log(`install exit=${inst.code}${instTimedOut ? " (TIMED OUT)" : ""}  (${((Date.now() - ti) / 1000).toFixed(1)}s)`);
if (!LIVE && inst.stderr && inst.stderr.trim()) console.log("install stderr (tail):\n" + inst.stderr.trim().split("\n").slice(-20).join("\n"));
const vitestInstalled = kernel.exists("/app/node_modules/vitest/vitest.mjs");
console.log(`vitest installed: ${vitestInstalled}\n`);
if (!vitestInstalled) {
  console.log("RESULT: FAIL — vitest did not install");
  process.exit(1);
}

// ── the gate: `vitest run` goes green on the trivial suite ───────────────────
console.log("── vitest run ──");
const TIMEOUT_RUN = Number(process.env.VV_RUN_TIMEOUT || 240000);
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