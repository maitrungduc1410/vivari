// Bun install spike (NETWORK) — proves `bun install` / `bun add` by DELEGATING to
// the real vendored npm CLI inside the VM, then synthesizing a text bun.lock. This
// is the deliberate architectural choice for Bun support: Bun's native Zig
// installer can't run in the browser, but npm's resolver already does — so the Bun
// CLI shim maps its install verbs onto npm and records a Bun-shaped lockfile.
//
//   node scripts/spike-bun-install.mjs   (needs Wasm VFS build + vendored npm + net)
//
// Uses the shared harness (which loads the real npm into the VFS). See
// scripts/spike-bun.mjs for the offline runtime proofs.

import { bootSpikeKernel, writeProject, defaultEnv, LIVE } from "./lib/spike-harness.mjs";

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  \u2713 " : "  \u2717 ") + msg);
  if (!cond) failed++;
};

// { npm: true }: `bun add` delegates to the real npm CLI via cp.spawn('npm', …),
// so the vendored tree has to be on PATH before the first bun command.
const h = await bootSpikeKernel({ npm: true });
const APP = "/app";
const readText = (p) => { try { return Buffer.from(h.kernel.readFile(p)).toString(); } catch { return null; } };
const exists = (p) => { try { h.kernel.readFile(p); return true; } catch { try { h.kernel.readdir(p); return true; } catch { return false; } } };

console.log("\n== bun add is-number (delegates to npm) ==");
{
  writeProject(h.kernel, APP, {
    "package.json": JSON.stringify({ name: "bun-install-demo", version: "1.0.0", type: "module" }, null, 2),
  });
  const t0 = Date.now();
  const r = await h.kernel.start("bun", ["add", "is-number@7.0.0"], { cwd: APP, env: defaultEnv(APP), capture: !LIVE });
  console.log("  bun add exit=" + r.code + "  (" + ((Date.now() - t0) / 1000).toFixed(1) + "s)");
  if (r.code !== 0) console.log((r.stderr || h.out.join("")).slice(-2000));
  ok(r.code === 0, "bun add exits 0");
  ok(exists(APP + "/node_modules/is-number/package.json"), "dependency installed into node_modules");

  const pkg = JSON.parse(readText(APP + "/package.json") || "{}");
  ok(pkg.dependencies && pkg.dependencies["is-number"], "package.json dependencies updated by npm");

  const lock = readText(APP + "/bun.lock");
  ok(!!lock, "bun.lock written");
  ok(lock && /is-number/.test(lock) && /lockfileVersion/.test(lock), "bun.lock records the dep + lockfileVersion");
}

console.log("\n== bun run uses the installed dep ==");
{
  writeProject(h.kernel, APP, {
    "use.ts": [
      "import isNumber from 'is-number';",
      "const check: boolean = isNumber(42) && !isNumber('x');",
      "console.log('isNumber-ok=' + check);",
    ].join("\n"),
  });
  const r = await h.kernel.start("bun", ["run", "use.ts"], { cwd: APP, env: defaultEnv(APP), capture: true });
  const o = (r.stdout || "").trim();
  console.log("  ->", JSON.stringify(o), "exit", r.code);
  ok(r.code === 0 && /isNumber-ok=true/.test(o), "TS entry imports + uses the npm-installed dep");
}

console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: all bun install spike checks passed");
process.exit(failed ? 1 : 0);