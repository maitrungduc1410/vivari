// Spike (NETWORK): prove the Nitro (unjs) Backend template boots its dev server and
// serves routes in-VM. Mirrors the shipped `nitro` template in
// packages/studio/src/vv/templates.ts.
//
// Unlike the plain-node backends, this drives a real CLI dev server: `nitro dev`
// (node_modules/nitropack/dist/cli/index.mjs dev) builds with rollup + auto-imports
// (defineNitroConfig / defineEventHandler) and binds via listhen. We pass PORT so it
// binds the template's :3000.
//
// Gates: install ok, `nitro dev` binds :3000, GET / returns the index route, and
// GET /api/hello returns the JSON handler's body.
//   run (Node 22+):  node scripts/spike-nitro.mjs   (needs vendored npm — see spike-harness)
import { bootSpikeKernel, writeProject, npmInstall, waitListen, httpGet, defaultEnv } from "./lib/spike-harness.mjs";

const DIR = "/nitro";
const PORT = Number(process.env.VV_PORT || 3000);
const h = await bootSpikeKernel();

writeProject(h.kernel, DIR, {
  "package.json": `{
  "name": "nitro-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "nitro dev",
    "build": "nitro build",
    "preview": "node .output/server/index.mjs"
  },
  "devDependencies": { "nitropack": "^2.10.0" }
}
`,
  "nitro.config.ts": `export default defineNitroConfig({
  compatibilityDate: 'latest',
})
`,
  "routes/index.ts": `export default defineEventHandler(() => 'Hello from Nitro, running inside Vivari!')
`,
  "routes/api/hello.ts": `export default defineEventHandler(() => ({ message: 'Hello, world!' }))
`,
});

const inst = await npmInstall(h, { dir: DIR });
if (inst.code !== 0) process.exit(1);
if (process.env.VV_INSTALL_ONLY === "1") process.exit(0);

// nitro dev reads PORT (via listhen) — pin it to the template's port.
const env = { ...defaultEnv(DIR), PORT: String(PORT) };
const bound = await waitListen(h, {
  dir: DIR,
  port: PORT,
  argv: ["node_modules/nitropack/dist/cli/index.mjs", "dev"],
  env,
});

let rootOk = false;
let apiOk = false;

if (bound) {
  const root = await httpGet(h.kernel, PORT, "/");
  rootOk = root.status === 200 && /Hello from Nitro/.test(root.body);
  console.log(`  GET / -> ${root.status}  ${root.body.slice(0, 80).replace(/\n/g, " ")}`);

  const api = await httpGet(h.kernel, PORT, "/api/hello");
  apiOk = api.status === 200 && /"message"\s*:\s*"Hello, world!"/.test(api.body);
  console.log(`  GET /api/hello -> ${api.status}  ${api.body.slice(0, 80).replace(/\n/g, " ")}`);
}

const ok = inst.code === 0 && bound && rootOk && apiOk;
console.log(
  "\nRESULT: " +
    (ok
      ? "PASS — Nitro dev server builds + serves the index route and a JSON API route in-VM"
      : "FAIL — see logs above"),
);
process.exit(ok ? 0 : 1);
