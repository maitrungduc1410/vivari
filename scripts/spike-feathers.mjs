// Spike (NETWORK): prove the FeathersJS (Koa transport) Backend template boots and
// serves a real REST service in-VM. Mirrors the shipped `feathers` template in
// packages/studio/src/vv/templates.ts.
// Gates: install ok, `node src/index.js` binds :3030, GET /messages returns the
// seeded message, POST /messages creates one (id increments), and GET /messages
// then shows both — proving Feathers' service + rest() transport work in-VM.
//   run (Node 22+):  node scripts/spike-feathers.mjs   (needs vendored npm — see spike-harness)
import { bootSpikeKernel, writeProject, npmInstall, waitListen, httpGet, httpPost } from "./lib/spike-harness.mjs";

const DIR = "/feathers";
const PORT = Number(process.env.VV_PORT || 3030);
const h = await bootSpikeKernel();

writeProject(h.kernel, DIR, {
  "package.json": `{
  "name": "feathers-app",
  "private": true,
  "version": "1.0.0",
  "type": "commonjs",
  "scripts": { "start": "node src/index.js", "dev": "node src/index.js" },
  "dependencies": { "@feathersjs/feathers": "^5.0.0", "@feathersjs/koa": "^5.0.0" }
}
`,
  "src/index.js": `const { feathers } = require('@feathersjs/feathers');
const { koa, rest, bodyParser, errorHandler } = require('@feathersjs/koa');

class MessageService {
  constructor() {
    this.messages = [{ id: 0, text: 'Hello from Feathers!' }];
  }
  async find() {
    return this.messages;
  }
  async create(data) {
    const message = { id: this.messages.length, text: data.text };
    this.messages.push(message);
    return message;
  }
}

const app = koa(feathers());
app.use(errorHandler());
app.use(bodyParser());
app.configure(rest());
app.use('messages', new MessageService());

const port = Number(process.env.PORT ?? ${PORT});
app.listen(port).then(() => console.log('Feathers on http://localhost:' + port + '/messages'));
`,
});

const inst = await npmInstall(h, { dir: DIR });
if (inst.code !== 0) process.exit(1);
if (process.env.VV_INSTALL_ONLY === "1") process.exit(0);

const bound = await waitListen(h, { dir: DIR, port: PORT, argv: ["src/index.js"] });

let findOk = false;
let createOk = false;
let growOk = false;

if (bound) {
  const before = await httpGet(h.kernel, PORT, "/messages");
  let n0 = -1;
  try { n0 = JSON.parse(before.body).length; } catch {}
  findOk = before.status === 200 && /Hello from Feathers/.test(before.body) && n0 === 1;
  console.log(`  GET /messages -> ${before.status}  count=${n0}`);

  const created = await httpPost(h.kernel, PORT, "/messages", { text: "spike message" });
  let createdId = -1;
  try { const j = JSON.parse(created.body); createdId = j.id; createOk = j.text === "spike message"; } catch {}
  console.log(`  POST /messages -> ${created.status}  ${created.body.slice(0, 100)}`);

  const after = await httpGet(h.kernel, PORT, "/messages");
  let n1 = -1;
  try { n1 = JSON.parse(after.body).length; } catch {}
  growOk = after.status === 200 && n1 === n0 + 1 && createdId === 1;
  console.log(`  GET /messages -> ${after.status}  count ${n0} -> ${n1}`);
}

const ok = inst.code === 0 && bound && findOk && createOk && growOk;
console.log(
  "\nRESULT: " +
    (ok
      ? "PASS — Feathers serves find() + create() over the rest() transport in-VM"
      : "FAIL — see logs above"),
);
process.exit(ok ? 0 : 1);
