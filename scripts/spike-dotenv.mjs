// Spike (NETWORK): prove environment-variable ergonomics work in-VM, end to end:
//   1. an inline `NAME=value command` prefix inside a package.json script run via
//      the REAL npm (`npm run start` -> `sh -c "GREETING=hello node ..."`),
//   2. `node --env-file=.env` loading a KEY=VALUE file into process.env, and
//   3. the `dotenv` package (`require('dotenv').config()` and `-r dotenv/config`)
//      reading a real .env from the VFS.
// Guards packages/kernel-host/coreutils.js (sh assignment prefix + node launcher
// --env-file loader) and the runtime's mutable process.env.
//   run (Node 22+):  node scripts/spike-dotenv.mjs   (needs vendored npm — see spike-harness)
import { bootSpikeKernel, writeProject, npmInstall, defaultEnv, LIVE } from "./lib/spike-harness.mjs";

const DIR = "/dotenv";
const h = await bootSpikeKernel();
const env = defaultEnv(DIR);

writeProject(h.kernel, DIR, {
  "package.json": `{
  "name": "dotenv-app",
  "private": true,
  "version": "0.0.0",
  "type": "commonjs",
  "scripts": { "start": "GREETING=hello node print-greeting.js" },
  "dependencies": { "dotenv": "^16.4.0" }
}
`,
  // Reads only what each check sets, so the printed line is unambiguous.
  "print-greeting.js": `process.stdout.write('GREETING=' + (process.env.GREETING || '-') + '\\n');\n`,
  "envfile-app.js": `process.stdout.write('ENVFILE SECRET=' + (process.env.SECRET || '-') + '\\n');\n`,
  "dotenv-app.js": `require('dotenv').config();\nprocess.stdout.write('DOTENV SECRET=' + (process.env.SECRET || '-') + '\\n');\n`,
  "preload-app.js": `process.stdout.write('PRELOAD SECRET=' + (process.env.SECRET || '-') + '\\n');\n`,
  ".env": `# in-VM .env\nSECRET=fromdotenv\nGREETING="from file"\n`,
});

const inst = await npmInstall(h, { dir: DIR, env });
const dotenvInstalled = h.kernel.exists(DIR + "/node_modules/dotenv/package.json");
console.log(`dotenv installed: ${dotenvInstalled}`);
if (inst.code !== 0 || !dotenvInstalled) {
  console.log("RESULT: FAIL — dotenv did not install");
  process.exit(1);
}
if (process.env.VV_INSTALL_ONLY === "1") process.exit(0);

const run = async (label, cmd, args) => {
  const r = await h.kernel.start(cmd, args, { cwd: DIR, env, capture: !LIVE });
  const out = ((r.stdout || "") + "\n" + (r.stderr || "")).trim();
  console.log(`  $ ${cmd} ${args.join(" ")}  -> exit ${r.code}\n    ${out.split("\n").join("\n    ")}`);
  return { code: r.code, out };
};

// 1. Inline NAME=value prefix inside a package.json script, through the real npm.
const start = await run("npm run start", "npm", ["run", "start"]);
const prefixOk = start.code === 0 && /GREETING=hello/.test(start.out);

// 2. node --env-file loads the .env into process.env (quotes stripped).
const envfile = await run("node --env-file", "node", ["--env-file=.env", "envfile-app.js"]);
const envFileOk = envfile.code === 0 && /ENVFILE SECRET=fromdotenv/.test(envfile.out);

// 3a. dotenv.config() reads .env relative to cwd.
const dot = await run("dotenv.config()", "node", ["dotenv-app.js"]);
const dotenvOk = dot.code === 0 && /DOTENV SECRET=fromdotenv/.test(dot.out);

// 3b. `-r dotenv/config` preload path.
const preload = await run("-r dotenv/config", "node", ["-r", "dotenv/config", "preload-app.js"]);
const preloadOk = preload.code === 0 && /PRELOAD SECRET=fromdotenv/.test(preload.out);

console.log(
  `\n  inline prefix (npm run): ${prefixOk}\n  node --env-file:         ${envFileOk}\n  dotenv.config():         ${dotenvOk}\n  -r dotenv/config:        ${preloadOk}`,
);

const ok = prefixOk && envFileOk && dotenvOk && preloadOk;
console.log(
  "\nRESULT: " +
    (ok
      ? "PASS — inline env prefix, node --env-file, and dotenv all work in-VM"
      : "FAIL — see logs above"),
);
process.exit(ok ? 0 : 1);