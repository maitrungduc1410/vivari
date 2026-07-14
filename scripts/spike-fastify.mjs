// Spike (NETWORK): prove the Fastify backend template boots + serves in-VM.
// Gates: install ok, `node src/index.js` binds :3000, GET / -> 200 with the marker.
//   run (Node 22+):  node scripts/spike-fastify.mjs   (needs vendored npm — see spike-harness)
import { bootSpikeKernel, writeProject, npmInstall, waitListen, httpGet } from "./lib/spike-harness.mjs";

const DIR = "/fastify";
const PORT = Number(process.env.OC_PORT || 3000);
const h = await bootSpikeKernel();

writeProject(h.kernel, DIR, {
  "package.json": `{
  "name": "fastify-app",
  "private": true,
  "version": "1.0.0",
  "type": "commonjs",
  "scripts": { "start": "node src/index.js", "dev": "node src/index.js" },
  "dependencies": { "fastify": "^5.1.0" }
}
`,
  "src/index.js": `const Fastify = require('fastify');
const app = Fastify({ logger: true });
const port = Number(process.env.PORT ?? ${PORT});
app.get('/', async () => 'Hello from Fastify, running inside OpenContainer!');
app.get('/api/hello', async () => ({ message: 'Hello, world!' }));
app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
`,
});

const inst = await npmInstall(h, { dir: DIR });
if (inst.code !== 0) process.exit(1);
if (process.env.OC_INSTALL_ONLY === "1") process.exit(0);

const bound = await waitListen(h, { dir: DIR, port: PORT, argv: ["src/index.js"] });
let getOk = false;
if (bound) {
  const r = await httpGet(h.kernel, PORT, "/");
  getOk = r.status === 200 && /Hello from Fastify/.test(r.body);
  console.log(`  GET / -> ${r.status}  ${r.body.slice(0, 80)}`);
}
const ok = inst.code === 0 && bound && getOk;
console.log("\nRESULT: " + (ok ? "PASS — Fastify boots and serves / with 200" : "FAIL — see logs above"));
process.exit(ok ? 0 : 1);
