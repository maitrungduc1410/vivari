// Spike (NETWORK): prove the SQLite (sql.js) showcase template boots + serves
// a real WASM SQLite database in-VM. Mirrors the shipped `sqlite` template in
// packages/studio/src/oc/templates.ts.
// Gates: install ok, `node server.js` binds :3000, GET /api/info reports SQLite +
// a version, GET /api/todos returns the seeded rows.
//   run (Node 22+):  node scripts/spike-sqlite.mjs   (needs vendored npm — see spike-harness)
import { bootSpikeKernel, writeProject, npmInstall, waitListen, httpGet } from "./lib/spike-harness.mjs";

const DIR = "/sqlite";
const PORT = Number(process.env.OC_PORT || 3000);
const h = await bootSpikeKernel();

writeProject(h.kernel, DIR, {
  "package.json": `{
  "name": "sqlite-demo",
  "private": true,
  "version": "0.0.0",
  "type": "commonjs",
  "scripts": { "start": "node server.js", "dev": "node server.js" },
  "dependencies": { "express": "^4.21.0", "sql.js": "^1.12.0" }
}
`,
  "server.js": `const express = require('express');
const initSqlJs = require('sql.js');

async function main() {
  const SQL = await initSqlJs({ locateFile: (f) => require.resolve('sql.js/dist/' + f) });
  const db = new SQL.Database();
  db.run('CREATE TABLE todos (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0);');
  db.run("INSERT INTO todos (task, done) VALUES ('Try OpenContainer', 1), ('Run SQLite in the browser', 0);");

  const app = express();
  app.get('/api/info', (_req, res) => {
    const stmt = db.prepare('SELECT sqlite_version() AS version');
    stmt.step();
    const version = stmt.getAsObject().version;
    stmt.free();
    res.json({ engine: 'SQLite', version: version, driver: 'sql.js (WASM)' });
  });
  app.get('/api/todos', (_req, res) => {
    const rows = [];
    const stmt = db.prepare('SELECT id, task, done FROM todos ORDER BY id');
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    res.json(rows);
  });

  const port = Number(process.env.PORT ?? ${PORT});
  app.listen(port, () => console.log('SQLite demo on http://localhost:' + port));
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
  infoOk = info.status === 200 && /SQLite/.test(info.body) && /"version"\s*:\s*"\d/.test(info.body);
  console.log(`  GET /api/info -> ${info.status}  ${info.body.slice(0, 120)}`);

  const todos = await httpGet(h.kernel, PORT, "/api/todos");
  let rows = [];
  try { rows = JSON.parse(todos.body); } catch {}
  todosOk = todos.status === 200 && Array.isArray(rows) && rows.length === 2 && /OpenContainer/.test(todos.body);
  console.log(`  GET /api/todos -> ${todos.status}  rows=${Array.isArray(rows) ? rows.length : "?"}`);
}

const ok = inst.code === 0 && bound && infoOk && todosOk;
console.log("\nRESULT: " + (ok ? "PASS — sql.js SQLite boots and serves live queries" : "FAIL — see logs above"));
process.exit(ok ? 0 : 1);
