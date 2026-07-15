// Spike (NETWORK): prove the PostgreSQL (PGlite) showcase template boots + serves
// a real WASM Postgres server in-VM. Mirrors the shipped `pglite` template in
// packages/studio/src/oc/templates.ts.
// Gates: install ok, `node server.js` binds :3000, GET /api/info reports
// PostgreSQL + a version, GET /api/todos returns the seeded rows.
// NOTE: PGlite ships ~16 MB of WASM + data, so install/boot are slower than other
// backends — the bind timeout is bumped and run-spikes gives it a long budget.
//   run (Node 22+):  node scripts/spike-pglite.mjs   (needs vendored npm — see spike-harness)
import { bootSpikeKernel, writeProject, npmInstall, waitListen, httpGet } from "./lib/spike-harness.mjs";

const DIR = "/pglite";
const PORT = Number(process.env.OC_PORT || 3000);
// PGlite compiles a large WASM at first boot; give it room unless overridden.
if (!process.env.OC_BIND_TIMEOUT) process.env.OC_BIND_TIMEOUT = "300000";
const h = await bootSpikeKernel();

writeProject(h.kernel, DIR, {
  "package.json": `{
  "name": "pglite-demo",
  "private": true,
  "version": "0.0.0",
  "type": "commonjs",
  "scripts": { "start": "node server.js", "dev": "node server.js" },
  "dependencies": { "express": "^4.21.0", "@electric-sql/pglite": "^0.5.4" }
}
`,
  "server.js": `const express = require('express');
const { PGlite } = require('@electric-sql/pglite');

async function main() {
  const db = await PGlite.create();
  await db.exec('CREATE TABLE IF NOT EXISTS todos (id SERIAL PRIMARY KEY, task TEXT NOT NULL, done BOOLEAN NOT NULL DEFAULT false);');
  await db.exec("INSERT INTO todos (task, done) VALUES ('Try OpenContainer', true), ('Run Postgres in the browser', false);");

  const app = express();
  app.get('/api/info', async (_req, res) => {
    const r = await db.query('SELECT version() AS version');
    res.json({ engine: 'PostgreSQL', version: r.rows[0].version.split(' ').slice(0, 2).join(' '), driver: 'PGlite (WASM)' });
  });
  app.get('/api/todos', async (_req, res) => {
    const r = await db.query('SELECT id, task, done FROM todos ORDER BY id');
    res.json(r.rows);
  });

  const port = Number(process.env.PORT ?? ${PORT});
  app.listen(port, () => console.log('Postgres (PGlite) demo on http://localhost:' + port));
}

main().catch((err) => { console.error(err); process.exit(1); });
`,
});

const inst = await npmInstall(h, { dir: DIR });
if (inst.code !== 0) process.exit(1);
if (process.env.OC_INSTALL_ONLY === "1") process.exit(0);

const bound = await waitListen(h, { dir: DIR, port: PORT, argv: ["server.js"] });
let infoOk = false;
let todosOk = false;
if (bound) {
  const info = await httpGet(h.kernel, PORT, "/api/info");
  infoOk = info.status === 200 && /PostgreSQL/.test(info.body) && /"version"\s*:\s*"PostgreSQL/.test(info.body);
  console.log(`  GET /api/info -> ${info.status}  ${info.body.slice(0, 120)}`);

  const todos = await httpGet(h.kernel, PORT, "/api/todos");
  let rows = [];
  try { rows = JSON.parse(todos.body); } catch {}
  todosOk = todos.status === 200 && Array.isArray(rows) && rows.length === 2 && /OpenContainer/.test(todos.body);
  console.log(`  GET /api/todos -> ${todos.status}  rows=${Array.isArray(rows) ? rows.length : "?"}`);
}

const ok = inst.code === 0 && bound && infoOk && todosOk;
console.log("\nRESULT: " + (ok ? "PASS — PGlite Postgres boots and serves live queries" : "FAIL — see logs above"));
process.exit(ok ? 0 : 1);
