// Spike (NETWORK): prove the Hono backend template boots + serves in-VM.
// Gates: install ok, `node src/index.js` binds :3000, GET / -> 200 with the marker.
//   run (Node 22+):  node scripts/spike-hono.mjs   (needs vendored npm — see spike-harness)
import { bootSpikeKernel, writeProject, npmInstall, waitListen, httpGet } from "./lib/spike-harness.mjs";

const DIR = "/hono";
const PORT = Number(process.env.OC_PORT || 3000);
const h = await bootSpikeKernel();

writeProject(h.kernel, DIR, {
  "package.json": `{
  "name": "hono-app",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": { "start": "node src/index.js", "dev": "node src/index.js" },
  "dependencies": { "hono": "^4.6.0", "@hono/node-server": "^1.13.0" }
}
`,
  "src/index.js": `import { serve } from '@hono/node-server'
import { Hono } from 'hono'
const app = new Hono()
app.get('/', (c) => c.text('Hello from Hono, running inside OpenContainer!'))
app.get('/api/hello', (c) => c.json({ message: 'Hello, world!' }))
const port = Number(process.env.PORT ?? ${PORT})
serve({ fetch: app.fetch, port }, (info) => {
  console.log('Hono listening on http://localhost:' + info.port)
})
`,
});

const inst = await npmInstall(h, { dir: DIR });
if (inst.code !== 0) process.exit(1);
if (process.env.OC_INSTALL_ONLY === "1") process.exit(0);

const bound = await waitListen(h, { dir: DIR, port: PORT, argv: ["src/index.js"] });
let getOk = false;
if (bound) {
  const r = await httpGet(h.kernel, PORT, "/");
  getOk = r.status === 200 && /Hello from Hono/.test(r.body);
  console.log(`  GET / -> ${r.status}  ${r.body.slice(0, 80)}`);
}
const ok = inst.code === 0 && bound && getOk;
console.log("\nRESULT: " + (ok ? "PASS — Hono boots and serves / with 200" : "FAIL — see logs above"));
process.exit(ok ? 0 : 1);
