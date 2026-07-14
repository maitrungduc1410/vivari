// Spike (NETWORK): prove the Koa backend template boots + serves in-VM.
// Gates: install ok, `node src/index.js` binds :3000, GET / -> 200 with the marker.
//   run (Node 22+):  node scripts/spike-koa.mjs   (needs vendored npm — see spike-harness)
import { bootSpikeKernel, writeProject, npmInstall, waitListen, httpGet } from "./lib/spike-harness.mjs";

const DIR = "/koa";
const PORT = Number(process.env.OC_PORT || 3000);
const h = await bootSpikeKernel();

writeProject(h.kernel, DIR, {
  "package.json": `{
  "name": "koa-app",
  "private": true,
  "version": "1.0.0",
  "type": "commonjs",
  "scripts": { "start": "node src/index.js", "dev": "node src/index.js" },
  "dependencies": { "koa": "^2.15.3", "@koa/router": "^13.1.0" }
}
`,
  "src/index.js": `const Koa = require('koa');
const Router = require('@koa/router');
const app = new Koa();
const router = new Router();
const port = Number(process.env.PORT ?? ${PORT});
router.get('/', (ctx) => { ctx.body = 'Hello from Koa, running inside OpenContainer!'; });
router.get('/api/hello', (ctx) => { ctx.body = { message: 'Hello, world!' }; });
app.use(router.routes()).use(router.allowedMethods());
app.listen(port, () => console.log('Koa listening on http://localhost:' + port));
`,
});

const inst = await npmInstall(h, { dir: DIR });
if (inst.code !== 0) process.exit(1);
if (process.env.OC_INSTALL_ONLY === "1") process.exit(0);

const bound = await waitListen(h, { dir: DIR, port: PORT, argv: ["src/index.js"] });
let getOk = false;
if (bound) {
  const r = await httpGet(h.kernel, PORT, "/");
  getOk = r.status === 200 && /Hello from Koa/.test(r.body);
  console.log(`  GET / -> ${r.status}  ${r.body.slice(0, 80)}`);
}
const ok = inst.code === 0 && bound && getOk;
console.log("\nRESULT: " + (ok ? "PASS — Koa boots and serves / with 200" : "FAIL — see logs above"));
process.exit(ok ? 0 : 1);
