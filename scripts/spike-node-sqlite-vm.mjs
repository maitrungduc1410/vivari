// Spike (OFFLINE, needs the Wasm VFS): node:sqlite inside real guest processes, and the
// FS worker's lock table between them.
//
// spike-node-sqlite.mjs proves the binding against real Node over node:fs, and proves the
// lock table with two engines in one host process. Neither touches the things this one
// does: the SharedArrayBuffer syscall bridge carrying OP_FILE_LOCK to the File System
// Worker, a database that is a real file in the Rust VFS, the module loader resolving
// `node:sqlite` (and NOT `sqlite`), and, the reason the lock table exists, several guest
// processes writing one database at once the way pnpm 11's CLI and its workers do.
//
// The engine is supplied by VV_SQLITE_WASM_PATH, the same embedder override spike-bun
// uses; in the browser the kernel sets VV_SQLITE_WASM_URL instead.
//
//   run:  node scripts/spike-node-sqlite-vm.mjs

import fs from "node:fs";
import { bootSpikeKernel, writeProject } from "./lib/spike-harness.mjs";

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};

const { kernel } = await bootSpikeKernel();
const APP = "/app";
kernel.mkdirp(APP);

const ENGINE_VFS_PATH = "/usr/lib/vivari/sqlite3.wasm";
kernel.mkdirp("/usr/lib/vivari");
await kernel.fs.writeLarge(
  ENGINE_VFS_PATH,
  new Uint8Array(fs.readFileSync(new URL("../packages/runtime/vendor/sqlite/sqlite3.wasm", import.meta.url))),
);
const ENV = { HOME: "/home/user", PATH: "/bin", VV_SQLITE_WASM_PATH: ENGINE_VFS_PATH };

// launch() hands back the pid, which start() does not; the kill test needs it.
function run(script, { env = ENV } = {}) {
  const pid = kernel.launch("node", [script], { cwd: APP, env, capture: true });
  const done = new Promise((resolve) => {
    kernel.procs.get(pid).onExit = resolve;
  });
  return { pid, done };
}
const waitFor = async (pred, ms = 20000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
};

writeProject(kernel, APP, {
  // Resolution: the scheme-only rule, the builtin lists, and both module systems.
  "resolve.js": [
    "const Module = require('module');",
    "const out = {};",
    "out.cjs = typeof require('node:sqlite').DatabaseSync;",
    "try { require('sqlite'); out.bare = 'loaded'; } catch (e) { out.bare = e.code; }",
    "out.isBuiltin = [Module.isBuiltin('node:sqlite'), Module.isBuiltin('sqlite')];",
    "out.listed = Module.builtinModules.filter((m) => m.includes('sqlite'));",
    "import('node:sqlite').then((m) => {",
    "  out.esm = typeof m.DatabaseSync;",
    "  const db = new m.DatabaseSync(':memory:');",
    "  out.version = db.prepare('SELECT sqlite_version() AS v').get().v;",
    "  console.log('RESOLVE:' + JSON.stringify(out));",
    "});",
  ].join("\n"),
  // A file database that outlives its process.
  "write.mjs": [
    "import { DatabaseSync } from 'node:sqlite';",
    "const db = new DatabaseSync('./store.db');",
    "db.exec('CREATE TABLE kv(k TEXT PRIMARY KEY, v BLOB)');",
    "const put = db.prepare('INSERT INTO kv VALUES (?, ?)');",
    "db.exec('BEGIN IMMEDIATE');",
    "for (let i = 0; i < 100; i++) put.run('k' + i, new Uint8Array([i, i]));",
    "db.exec('COMMIT');",
    "console.log('WROTE:' + JSON.stringify({ location: db.location(), n: db.prepare('SELECT count(*) AS n FROM kv').get().n }));",
    "db.close();",
  ].join("\n"),
  "read.js": [
    "const { DatabaseSync } = require('node:sqlite');",
    "const db = new DatabaseSync('/app/store.db', { readOnly: true });",
    "const row = db.prepare('SELECT v FROM kv WHERE k = ?').get('k42');",
    "console.log('READ:' + JSON.stringify({ v: [...row.v], n: db.prepare('SELECT count(*) AS n FROM kv').get().n }));",
  ].join("\n"),
  // Holds a write lock until told to let go, so another process has to wait for it.
  "holder.js": [
    "const fs = require('fs');",
    "const { DatabaseSync } = require('node:sqlite');",
    "const db = new DatabaseSync('/app/shared.db');",
    "db.exec('CREATE TABLE IF NOT EXISTS log(who TEXT, at INTEGER)');",
    "db.exec('BEGIN IMMEDIATE');",
    "db.prepare('INSERT INTO log VALUES (?, ?)').run('holder', Date.now());",
    "fs.writeFileSync('/app/holding', '1');",
    "const park = new Int32Array(new SharedArrayBuffer(4));",
    "while (!fs.existsSync('/app/release')) Atomics.wait(park, 0, 0, 20);",
    "db.exec('COMMIT');",
    "console.log('HOLDER:committed');",
  ].join("\n"),
  "waiter.js": [
    "const { DatabaseSync } = require('node:sqlite');",
    "const db = new DatabaseSync('/app/shared.db', { timeout: 10000 });",
    "require('fs').writeFileSync('/app/waiting', '1');",
    "const t0 = Date.now();",
    "db.exec('BEGIN IMMEDIATE');",
    "const waited = Date.now() - t0;",
    "db.prepare('INSERT INTO log VALUES (?, ?)').run('waiter', Date.now());",
    "db.exec('COMMIT');",
    "console.log('WAITER:' + JSON.stringify({ waited, rows: db.prepare('SELECT who FROM log ORDER BY at').all().map((r) => r.who) }));",
  ].join("\n"),
  "impatient.js": [
    "const { DatabaseSync } = require('node:sqlite');",
    "const db = new DatabaseSync('/app/shared.db');",
    "try { db.exec('BEGIN IMMEDIATE'); console.log('IMPATIENT:granted'); }",
    "catch (e) { console.log('IMPATIENT:' + JSON.stringify({ code: e.code, errcode: e.errcode, message: e.message })); }",
  ].join("\n"),
  // Takes a write lock and never lets go: the kill test.
  "wedge.js": [
    "const fs = require('fs');",
    "const { DatabaseSync } = require('node:sqlite');",
    "const db = new DatabaseSync('/app/wedged.db');",
    "db.exec('CREATE TABLE IF NOT EXISTS t(x)');",
    "db.exec('BEGIN IMMEDIATE');",
    "db.exec('INSERT INTO t VALUES (1)');",
    "fs.writeFileSync('/app/wedged', '1');",
    "setInterval(() => {}, 1000);",
  ].join("\n"),
  "after-wedge.js": [
    "const { DatabaseSync } = require('node:sqlite');",
    "const db = new DatabaseSync('/app/wedged.db');",
    "db.exec('BEGIN IMMEDIATE'); db.exec('INSERT INTO t VALUES (2)'); db.exec('COMMIT');",
    "console.log('AFTER:' + JSON.stringify(db.prepare('SELECT x FROM t').all().map((r) => r.x)));",
  ].join("\n"),
  // Several writers at once, each in small transactions, the pnpm store index's shape.
  "writer.js": [
    "const { DatabaseSync } = require('node:sqlite');",
    "const id = process.argv[2];",
    "const db = new DatabaseSync('/app/stress.db', { timeout: 20000 });",
    "db.exec('PRAGMA journal_mode=WAL');",
    "db.exec('CREATE TABLE IF NOT EXISTS package_index (key TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID');",
    "const set = db.prepare('INSERT OR REPLACE INTO package_index (key, data) VALUES (?, ?)');",
    "for (let batch = 0; batch < 20; batch++) {",
    "  db.exec('BEGIN IMMEDIATE');",
    "  for (let i = 0; i < 10; i++) set.run(id + ':' + batch + ':' + i, new Uint8Array(64).fill(batch));",
    "  db.exec('COMMIT');",
    "}",
    "console.log('WRITER:' + id);",
  ].join("\n"),
  "check.js": [
    "const { DatabaseSync } = require('node:sqlite');",
    "const db = new DatabaseSync('/app/stress.db');",
    "console.log('CHECK:' + JSON.stringify({",
    "  n: db.prepare('SELECT count(*) AS n FROM package_index').get().n,",
    "  integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,",
    "  journal: db.prepare('PRAGMA journal_mode').get().journal_mode,",
    "}));",
  ].join("\n"),
});

const grab = (r, tag) => {
  const m = (r.stdout || "").match(new RegExp(tag + ":(.*)"));
  if (!m) {
    if (r.stderr) console.log("    stderr:", r.stderr.trim().split("\n").slice(-6).join("\n    "));
    return null;
  }
  try {
    return JSON.parse(m[1]);
  } catch {
    return m[1];
  }
};

console.log("resolution:");
{
  const r = await run("resolve.js").done;
  const got = grab(r, "RESOLVE");
  console.log("  ->", JSON.stringify(got));
  ok(r.code === 0 && got && got.cjs === "function" && got.esm === "function",
    "require('node:sqlite') and import('node:sqlite') both reach DatabaseSync");
  ok(got && got.bare === "MODULE_NOT_FOUND", "the bare 'sqlite' is NOT the builtin (it is an npm package's name)");
  ok(got && JSON.stringify(got.isBuiltin) === "[true,false]", "Module.isBuiltin agrees: node:sqlite yes, sqlite no");
  ok(got && JSON.stringify(got.listed) === '["node:sqlite"]', "Module.builtinModules lists it with its scheme, as Node does");
  ok(got && /^3\.\d+\.\d+$/.test(got.version), `the engine boots in a guest (${got && got.version})`);
}

console.log("a database that outlives its process:");
{
  const w = await run("write.mjs").done;
  const wrote = grab(w, "WROTE");
  ok(w.code === 0 && wrote && wrote.n === 100 && wrote.location === "/app/store.db",
    `an ESM guest writes 100 rows to /app/store.db (${JSON.stringify(wrote)})`);
  const bytes = kernel.readFileBytes(APP + "/store.db");
  ok(Buffer.from(bytes.subarray(0, 16)).toString("latin1") === "SQLite format 3\0" && bytes[16] === 0x10 && bytes[17] === 0x00,
    "the file in the VFS is a SQLite database with Node's 4096-byte pages");
  const r = await run("read.js").done;
  const read = grab(r, "READ");
  ok(r.code === 0 && read && read.n === 100 && JSON.stringify(read.v) === "[42,42]", "a second process reads it back, read-only");
}

console.log("two processes, one database:");
{
  const holder = run("holder.js");
  ok(await waitFor(() => kernel.exists(APP + "/holding")), "the holder process has a write transaction open");
  const impatient = await run("impatient.js").done;
  const busy = grab(impatient, "IMPATIENT");
  ok(busy && busy.code === "ERR_SQLITE_ERROR" && (busy.errcode & 0xff) === 5,
    `a second writer with no timeout is refused with SQLITE_BUSY (${JSON.stringify(busy)}), not granted a lock someone holds`);
  const waiter = run("waiter.js");
  // Count from the waiter being ready, not from its spawn: booting a process takes
  // a few hundred ms on a CI runner, and that used to come out of the wait measured.
  ok(await waitFor(() => kernel.exists(APP + "/waiting")), "the waiter has opened the database");
  await new Promise((r) => setTimeout(r, 400));
  kernel.writeFile(APP + "/release", "1");
  const [h, wres] = await Promise.all([holder.done, waiter.done]);
  const waited = grab(wres, "WAITER");
  ok(h.code === 0 && /HOLDER:committed/.test(h.stdout || ""), "the holder commits");
  ok(wres.code === 0 && waited && waited.waited >= 300,
    `a writer with busy_timeout WAITS for it in its own thread (${waited && waited.waited} ms) and then commits`);
  ok(waited && JSON.stringify(waited.rows) === '["holder","waiter"]', "both rows are there, in commit order");
}

console.log("a killed process does not leave its database locked:");
{
  const wedge = run("wedge.js");
  ok(await waitFor(() => kernel.exists(APP + "/wedged")), "a process takes a write lock and sits on it");
  kernel.stop(wedge.pid);
  await wedge.done;
  await new Promise((r) => setTimeout(r, 100)); // fs-unregister is a message to the FS worker
  const after = await run("after-wedge.js").done;
  const rows = grab(after, "AFTER");
  ok(after.code === 0 && JSON.stringify(rows) === "[2]",
    `once it is killed, the next writer gets the lock, and the dead one's uncommitted row is gone (${JSON.stringify(rows)})`);
}

console.log("four writers at once:");
{
  const t0 = Date.now();
  const writers = ["a", "b", "c", "d"].map((id) => {
    const pid = kernel.launch("node", ["writer.js", id], { cwd: APP, env: ENV, capture: true });
    return new Promise((resolve) => {
      kernel.procs.get(pid).onExit = resolve;
    });
  });
  const results = await Promise.all(writers);
  ok(results.every((r) => r.code === 0), `all four exit 0 (${Date.now() - t0} ms)`);
  if (!results.every((r) => r.code === 0)) for (const r of results) if (r.stderr) console.log("    ", r.stderr.trim().slice(-400));
  const c = await run("check.js").done;
  const check = grab(c, "CHECK");
  ok(check && check.n === 800, `every committed row is there (${check && check.n} of 800)`);
  ok(check && check.integrity === "ok", "PRAGMA integrity_check says ok");
  ok(check && check.journal === "delete", "WAL was asked for and SQLite truthfully reports DELETE mode");
}

console.log(failed === 0 ? "\nnode:sqlite (VM): all checks passed" : `\nnode:sqlite (VM): ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
