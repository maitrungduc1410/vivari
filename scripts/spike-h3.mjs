// Spike (NETWORK): prove the H3 (unjs) backend template boots + serves in-VM.
// Gates: install ok, `node src/index.js` binds :3000, GET / -> 200 with the marker.
//   run (Node 22+):  node scripts/spike-h3.mjs   (needs vendored npm — see spike-harness)
import { bootSpikeKernel, writeProject, npmInstall, waitListen, httpGet } from "./lib/spike-harness.mjs";

const DIR = "/h3";
const PORT = Number(process.env.OC_PORT || 3000);
const h = await bootSpikeKernel();

writeProject(h.kernel, DIR, {
  "package.json": `{
  "name": "h3-app",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": { "start": "node src/index.js", "dev": "node src/index.js" },
  "dependencies": { "h3": "^1.13.0" }
}
`,
  "src/index.js": `import { createServer } from 'node:http'
import { createApp, createRouter, defineEventHandler, toNodeListener } from 'h3'
const app = createApp()
const router = createRouter()
router.get('/', defineEventHandler(() => 'Hello from H3, running inside OpenContainer!'))
router.get('/api/hello', defineEventHandler(() => ({ message: 'Hello, world!' })))
app.use(router)
const port = Number(process.env.PORT ?? ${PORT})
createServer(toNodeListener(app)).listen(port, () => {
  console.log('H3 listening on http://localhost:' + port)
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
  getOk = r.status === 200 && /Hello from H3/.test(r.body);
  console.log(`  GET / -> ${r.status}  ${r.body.slice(0, 80)}`);
}
const ok = inst.code === 0 && bound && getOk;
console.log("\nRESULT: " + (ok ? "PASS — H3 boots and serves / with 200" : "FAIL — see logs above"));
process.exit(ok ? 0 : 1);
