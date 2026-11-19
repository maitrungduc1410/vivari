// Spike (OFFLINE): /bin's programs are on PATH under their bare names, the lazy
// ones (npm, pnpm, yarn, corepack, tsc) before their first use too, so a program
// that looks a command up on PATH itself finds what the shell would run.
//
// WHY THIS EXISTS. Programs lived only at /bin/<name>.js, and a lazy tool's file
// appeared on its first spawn. The kernel's own resolver tries <name>.js, but a
// guest program searching PATH stats <name>, as `which` and Node CLIs do: Nuxt's
// CLI checks every PATH entry for `pnpm` before `nuxt module add` installs with it,
// found nothing, and stopped at "`pnpm` was not found" in a VM where `pnpm add`
// works. The lookup below is that CLI's isExecutableAvailable() on Linux.
//
//   run:  node scripts/spike-path-programs.mjs

import { bootSpikeKernel } from "./lib/spike-harness.mjs";

let failed = 0;
const ok = (cond, msg, got) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg + (got !== undefined ? `  (${JSON.stringify(got)})` : ""));
  if (!cond) failed++;
};

const h = await bootSpikeKernel();
const k = h.kernel;
k.mkdirp("/t");
const loads = { lazy: 0, lazy2: 0, broken: 0 };
const loadsTool = (name) => async () => {
  loads[name]++;
  k.writeFile(`/bin/${name}.js`, `console.log('${name} ran ' + process.argv.slice(2).join(' '));`);
};
k.registerLazyProgram(["lazy"], loadsTool("lazy"));
k.registerLazyProgram(["lazy2"], loadsTool("lazy2"));
k.registerLazyProgram(["broken"], async () => {
  loads.broken++;
  throw new Error("asset unavailable");
});

const run = async (source) => {
  k.writeFile("/t/main.js", source);
  const r = await Promise.race([
    k.start("node", ["/t/main.js"], { cwd: "/t", env: { PATH: "/t/node_modules/.bin:/bin" }, capture: true }),
    new Promise((resolve) => setTimeout(() => resolve({ code: "timeout", stdout: "" }), 15000)),
  ]);
  return { code: r.code, out: (r.stdout || "") + (r.stderr || "") };
};
const ON_PATH = `const { statSync } = require('fs');
const { resolve } = require('path');
const onPath = (c) => process.env.PATH.split(':').some((d) => { try { return statSync(resolve(d, c)).isFile(); } catch { return false; } });`;

console.log("== PATH lookups by bare name ==");
let r = await run(`${ON_PATH}
console.log(JSON.stringify(['node', 'sh', 'ls', 'lazy', 'broken', 'nope'].map(onPath)));`);
ok(r.out.trim() === "[true,true,true,true,true,false]", "node, sh, ls and the lazy tools are on PATH; an unknown command is not", r.out.trim());
ok(loads.lazy === 0, "looking a lazy tool up does not load it", loads.lazy);

console.log("== spawning what was found ==");
r = await run(`require('child_process').spawn('lazy', ['add', 'x'], { stdio: 'inherit' }).on('close', (c) => console.log('exit ' + c));`);
ok(/lazy ran add x\s+exit 0/.test(r.out), "a lazy tool spawned by name loads on first use and runs", r.out.trim());
ok(loads.lazy === 1, "its loader ran once", loads.lazy);
r = await run(`require('child_process').spawn('/bin/lazy2', ['-v'], { stdio: 'inherit' }).on('close', (c) => console.log('exit ' + c));`);
ok(/lazy2 ran -v\s+exit 0/.test(r.out), "a lazy tool spawned by its /bin path loads too", r.out.trim());
r = await run(`require('child_process').spawn('broken', [], { stdio: 'inherit' }).on('close', (c) => console.log('exit ' + c));`);
ok(/broken: not found/.test(r.out) && /exit 127/.test(r.out), "a lazy tool whose load fails exits 127, not found", r.out.trim());
r = await run(`console.log(require('child_process').execFileSync('node', ['-e', 'console.log(process.argv.length)']).toString().trim())`);
ok(r.out.trim() === "1", "node runs through its bare name as through node.js", r.out.trim());
r = await run(`console.log(require('child_process').execFileSync('ls', ['/bin']).toString())`);
ok(/\blazy\b/.test(r.out) && /\bnode\.js\b/.test(r.out), "ls lists the bare names next to the .js files", r.out.trim().slice(0, 200));

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
