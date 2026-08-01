// Bun support spike (OFFLINE) — proves the Bun analog end-to-end on the SAME
// kernel the browser runs (Rust/Wasm VFS + process workers + syscalls), with no
// network and no vendored npm. Boots the kernel directly like spike-dep-cache.mjs.
//
//   node scripts/spike-bun.mjs   (needs the Node Wasm VFS build: `npm run build`)
//
// Proves: `bun --version`, zero-config `bun run app.ts` (TS strip + generics +
// enum + the Bun global), `Bun.serve` previewing through the http bridge, and the
// `bun:test` runner. The `bun install` delegation (network) is a separate spike:
// scripts/spike-bun-install.mjs. The pure-JS transform + Bun API are additionally
// gated with no kernel at all by scripts/spike-bun-offline.mjs.

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { httpGet } from "./lib/spike-harness.mjs";
import { Worker, MessageChannel } from "node:worker_threads";

const LIVE = process.env.VV_LIVE === "1";
let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  \u2713 " : "  \u2717 ") + msg);
  if (!cond) failed++;
};

// ── kernel setup (same shape as spike-dep-cache.mjs) ─────────────────────────
const fsWorker = new Worker(new URL("./fs-worker.mjs", import.meta.url));
let onKernelFsMessage = () => {};
await new Promise((resolve) => {
  fsWorker.on("message", (m) => {
    if (m.type === "ready") resolve();
    else onKernelFsMessage(m);
  });
});
const kernelFs = createKernelFs(fsWorker);
onKernelFsMessage = kernelFs.onMessage;

const spawnWorker = (info) => {
  const w = new Worker(new URL("./process-worker.mjs", import.meta.url));
  w.on("message", (m) => { const h = info.on[m.type]; if (h) h(m); });
  w.on("error", (e) => process.stderr.write(`\n[worker-error pid ${info.pid}] ${(e && e.stack) || e}\n`));
  const { port1, port2 } = new MessageChannel();
  fsWorker.postMessage({ type: "fs-register", client: info.pid, sab: info.sab, port: port2 }, [port2]);
  const init = { type: "init", sab: info.sab, spec: info.spec, fsPort: port1 };
  const transfer = [port1];
  if (info.threadPort) { init.threadPort = info.threadPort; transfer.push(info.threadPort); }
  w.postMessage(init, transfer);
  return {
    terminate: () => { w.terminate(); fsWorker.postMessage({ type: "fs-unregister", client: info.pid }); },
    postMessage: (m) => w.postMessage(m),
  };
};

const out = [];
const cap = (s) => { out.push(s); if (LIVE) process.stderr.write(s); };
const listening = new Set();
const kernel = new Kernel({ fs: kernelFs.fs, spawnWorker, stdout: cap, stderr: cap });
kernel.onListen = (port) => listening.add(port);
kernel.installCoreutils();

const APP = "/app";
kernel.mkdirp(APP);
const ENV = { HOME: "/home/user", PATH: APP + "/node_modules/.bin:/bin", PWD: APP };
const write = (rel, contents) => {
  const p = APP + "/" + rel;
  const slash = p.lastIndexOf("/");
  if (slash > 0) kernel.mkdirp(p.slice(0, slash));
  kernel.writeFile(p, contents);
};

// 1) bun --version
console.log("\n== bun --version ==");
{
  const r = await kernel.start("bun", ["--version"], { cwd: "/", env: ENV, capture: true });
  const v = (r.stdout || "").trim();
  console.log("  ->", JSON.stringify(v), "exit", r.code);
  ok(r.code === 0 && /^\d+\.\d+\.\d+/.test(v), "bun --version prints a semver, exit 0");
}

// 2) bun run index.ts — zero-config TypeScript + the Bun global
console.log("\n== bun run index.ts (TS + Bun global) ==");
{
  write("package.json", JSON.stringify({ name: "bun-demo", type: "module" }));
  write("index.ts", [
    "interface Point { x: number; y: number }",
    "enum Kind { A, B }",
    "const add = <T extends number>(a: T, b: T): T => (a + b) as T;",
    "const p: Point = { x: 1, y: 2 };",
    "const sum: number = add(p.x, p.y);",
    "console.log('sum=' + sum + ' kind=' + Kind.B + ' bun=' + (typeof Bun !== 'undefined') + ' v=' + Bun.version);",
  ].join("\n"));
  const r = await kernel.start("bun", ["run", "index.ts"], { cwd: APP, env: ENV, capture: true });
  const o = (r.stdout || "").trim();
  console.log("  ->", JSON.stringify(o), "exit", r.code);
  // `capture: true` routes the child's stderr into r.stderr, NOT to the kernel's
  // stderr callback — so VV_LIVE=1 cannot show it either. Printing it here is the
  // difference between "exit 1, no output" and the actual error: this block failed
  // its first CI run with an empty stdout and no clue, hiding a plain SyntaxError.
  if (r.stderr) console.log("  stderr:", r.stderr.trim());
  ok(r.code === 0, "bun run index.ts exits 0");
  ok(/sum=3/.test(o), "TS stripped + generic ran (sum=3)");
  ok(/kind=1/.test(o), "enum lowered (Kind.B === 1)");
  ok(/bun=true/.test(o) && /v=\d+\./.test(o), "Bun global installed for the run");
}

// 3) bun run server.ts — Bun.serve previews through the http bridge
console.log("\n== bun run server.ts (Bun.serve preview) ==");
{
  const PORT = 3939;
  write("server.ts", [
    "const server = Bun.serve({",
    "  port: " + PORT + ",",
    "  fetch(req: Request): Response {",
    "    const url = new URL(req.url);",
    "    if (url.pathname === '/json') return Response.json({ ok: true, framework: 'bun' });",
    "    return new Response('hello from Bun.serve', { headers: { 'content-type': 'text/plain' } });",
    "  },",
    "});",
    "console.log('listening on ' + server.port);",
  ].join("\n"));
  kernel.start("bun", ["run", "server.ts"], { cwd: APP, env: ENV });
  for (let i = 0; i < 150 && !listening.has(PORT); i++) await new Promise((r) => setTimeout(r, 100));
  ok(listening.has(PORT), "Bun.serve bound port " + PORT);
  const res = await httpGet(kernel, PORT, "/");
  console.log("  GET / ->", res.status, JSON.stringify(res.body.slice(0, 60)));
  ok(res.status === 200 && /hello from Bun.serve/.test(res.body), "GET / served by Bun.serve");
  const j = await httpGet(kernel, PORT, "/json");
  ok(j.status === 200 && /"framework":"bun"/.test(j.body), "Response.json route works");
}

// 4) bun run routes.ts — Bun.serve({ routes }) matching + fetch fallback
console.log("\n== bun run routes.ts (Bun.serve routing) ==");
{
  const PORT = 3941;
  write("routes.ts", [
    "const server = Bun.serve({",
    "  port: " + PORT + ",",
    "  routes: {",
    "    '/api/status': Response.json({ ok: true, runtime: 'bun' }),",
    "    '/api/users/me': () => Response.json({ id: 'me' }),",
    "    '/api/users/:id': (req: any) => Response.json({ id: req.params.id }),",
    "    '/files/*': (req: any) => new Response('file:' + new URL(req.url).pathname.replace(/^\\/files\\//, '')),",
    "    '/': () => new Response('home'),",
    "  },",
    "  fetch(req: Request): Response { return new Response('nf:' + new URL(req.url).pathname, { status: 404 }); },",
    "});",
    "console.log('listening on ' + server.port);",
  ].join("\n"));
  kernel.start("bun", ["run", "routes.ts"], { cwd: APP, env: ENV });
  for (let i = 0; i < 150 && !listening.has(PORT); i++) await new Promise((r) => setTimeout(r, 100));
  ok(listening.has(PORT), "Bun.serve(routes) bound port " + PORT);
  const status = await httpGet(kernel, PORT, "/api/status");
  ok(status.status === 200 && /"ok":true/.test(status.body), "static Response route /api/status");
  const me = await httpGet(kernel, PORT, "/api/users/me");
  ok(me.status === 200 && /"id":"me"/.test(me.body), "exact route beats :id param");
  const user = await httpGet(kernel, PORT, "/api/users/42");
  ok(user.status === 200 && /"id":"42"/.test(user.body), "param route captures :id");
  const file = await httpGet(kernel, PORT, "/files/docs/readme.txt");
  ok(file.status === 200 && /file:docs\/readme\.txt/.test(file.body), "wildcard route /files/*");
  const nf = await httpGet(kernel, PORT, "/nope");
  ok(nf.status === 404 && /nf:\/nope/.test(nf.body), "unmatched request hits the fetch fallback (404)");
}

// 5) bun run ws-server.ts — Bun.serve server-side WebSocket + pub/sub, exercised
// by the in-VM WebSocket client (the same client the browser preview tunnel uses).
console.log("\n== bun run ws-server.ts (Bun.serve websocket) ==");
{
  const PORT = 3942;
  write("ws-server.ts", [
    "const PORT = " + PORT + ";",
    "const server = Bun.serve({",
    "  port: PORT,",
    "  fetch(req: Request, server: any): any {",
    "    if (new URL(req.url).pathname === '/ws') { if (server.upgrade(req)) return; return new Response('no', { status: 400 }); }",
    "    return new Response('home');",
    "  },",
    "  websocket: {",
    "    open(ws: any) { ws.subscribe('room'); ws.send('welcome'); },",
    "    message(ws: any, msg: any) { server.publish('room', 'echo:' + msg); },",
    "    close() {},",
    "  },",
    "});",
    "const got: string[] = [];",
    "const sock = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');",
    "sock.onopen = () => { sock.send('hi'); };",
    "sock.onmessage = (ev: any) => {",
    "  got.push(String(ev.data));",
    "  if (got.length >= 2) { console.log('WSRESULT:' + JSON.stringify(got)); try { sock.close(); } catch (e) {} try { server.stop(); } catch (e) {} setTimeout(() => process.exit(0), 50); }",
    "};",
    "setTimeout(() => { console.log('WSRESULT:' + JSON.stringify(got)); process.exit(0); }, 4000);",
  ].join("\n"));
  const r = await kernel.start("bun", ["run", "ws-server.ts"], { cwd: APP, env: ENV, capture: true });
  const o = (r.stdout || "") + (r.stderr || "");
  if (LIVE) console.log(o);
  const m = o.match(/WSRESULT:(\[.*\])/);
  const got = m ? JSON.parse(m[1]) : [];
  console.log("  ->", JSON.stringify(got), "exit", r.code);
  ok(r.code === 0, "ws-server.ts exits 0");
  ok(got.includes("welcome"), "websocket open handler delivered 'welcome' to the client");
  ok(got.includes("echo:hi"), "message -> server.publish broadcast reached the subscriber");
}

// 6) bun test — the bun:test runner
console.log("\n== bun test ==");
{
  write("sum.test.ts", [
    "import { test, expect, describe } from 'bun:test';",
    "describe('sum', () => {",
    "  test('adds', () => { expect(1 + 2).toBe(3); });",
    "  test('objects', () => { expect({ a: 1 }).toEqual({ a: 1 }); });",
    "});",
  ].join("\n"));
  const r = await kernel.start("bun", ["test", "sum.test.ts"], { cwd: APP, env: ENV, capture: true });
  const o = (r.stdout || "") + (r.stderr || "");
  if (LIVE) console.log(o);
  ok(r.code === 0, "bun test exits 0");
  ok(/2 pass/.test(o) && /0 fail/.test(o), "bun:test reports 2 pass / 0 fail");
}

// 7) .env auto-loading + import.meta, through the real VFS and module loader.
// These two are the reason this batch cannot be gated by the offline tier alone:
// the file set has to be READ off the VFS from the process's cwd, and
// `import.meta.main` is an identity check against the module the loader published
// as the entry — neither exists without a kernel.
console.log("\n== bun run env-app.ts (.env precedence + import.meta) ==");
{
  // Load order is decreasing precedence, so SHARED must come from the FIRST file
  // here and nowhere else. NODE_ENV is unset, which is Bun's `development` mode.
  write(".env", "SHARED=from-env\nONLY_BASE=base\nMODE_FILE=env\nGREETING=hello $WHO\nWHO=world\n");
  write(".env.local", "SHARED=from-local\nLOCAL_ONLY=yes\n");
  write(".env.development", "SHARED=from-dev\nMODE_FILE=dev\n");
  write(".env.development.local", "SHARED=from-dev-local\n");
  write("child.ts", "export const childIsMain: boolean = import.meta.main;\n");
  write("env-app.ts", [
    "import { childIsMain } from './child';",
    "const e = process.env;",
    "const t0 = Date.now();",
    "Bun.sleepSync(60);",
    "console.log('ENVRESULT:' + JSON.stringify({",
    "  shared: e.SHARED, base: e.ONLY_BASE, mode: e.MODE_FILE, local: e.LOCAL_ONLY,",
    "  expanded: e.GREETING,",
    "  bunEnvAlias: Bun.env.SHARED === e.SHARED,",
    "  metaEnvAlias: import.meta.env === process.env,",
    "  main: import.meta.main, childMain: childIsMain,",
    "  dir: import.meta.dir, file: import.meta.file, path: import.meta.path,",
    "  resolved: import.meta.resolveSync('./child'),",
    "  slept: Date.now() - t0,",
    "}));",
  ].join("\n"));
  const r = await kernel.start("bun", ["run", "env-app.ts"], { cwd: APP, env: ENV, capture: true });
  if (r.stderr) console.log("  stderr:", r.stderr.trim());
  const m = (r.stdout || "").match(/ENVRESULT:(\{.*\})/);
  const got = m ? JSON.parse(m[1]) : {};
  console.log("  ->", JSON.stringify(got), "exit", r.code);
  ok(r.code === 0, "env-app.ts exits 0");
  ok(got.shared === "from-dev-local", ".env.development.local beats .env.local, .env.development and .env");
  ok(got.base === "base" && got.mode === "dev", "lower-precedence files still supply the keys nobody else set");
  ok(got.local === "yes", ".env.local is loaded (NODE_ENV is not test here)");
  ok(got.expanded === "hello world", "$VAR expansion happened against a variable defined later in the same file");
  ok(got.bunEnvAlias === true && got.metaEnvAlias === true, "Bun.env and import.meta.env are the same object as process.env");
  ok(got.main === true, "import.meta.main is true in the entry the loader ran");
  ok(got.childMain === false, "…and false in the module it imported");
  ok(got.dir === APP && got.file === "env-app.ts" && got.path === APP + "/env-app.ts", "import.meta.dir/file/path describe the module");
  ok(got.resolved === APP + "/child.ts", "import.meta.resolveSync went through the real resolver (.ts extension included)");
  ok(got.slept >= 50, "Bun.sleepSync(60) really blocked the worker (parked on Atomics.wait): " + got.slept + "ms");
}

// The other half of the .env decision: a plain `node` process must be unchanged.
// Automatic loading is Bun's behaviour — Node requires an explicit --env-file —
// and Bun itself disables it when invoked as node.
console.log("\n== node env-check.mjs (no .env loading, no Bun import.meta members) ==");
{
  write("env-check.mjs", [
    "export const x = 1;",
    "console.log('NODERESULT:' + JSON.stringify({",
    "  shared: process.env.SHARED === undefined,",
    "  metaEnv: import.meta.env === undefined,",
    "  metaDir: import.meta.dir === undefined,",
    "  dirname: import.meta.dirname,",
    "}));",
  ].join("\n"));
  const r = await kernel.start("node", ["env-check.mjs"], { cwd: APP, env: ENV, capture: true });
  if (r.stderr) console.log("  stderr:", r.stderr.trim());
  const m = (r.stdout || "").match(/NODERESULT:(\{.*\})/);
  const got = m ? JSON.parse(m[1]) : {};
  console.log("  ->", JSON.stringify(got), "exit", r.code);
  ok(r.code === 0, "env-check.mjs exits 0");
  ok(got.shared === true, "node did NOT read the .env files sitting right next to it");
  ok(got.metaEnv === true && got.metaDir === true, "node's import.meta has no Bun members");
  ok(got.dirname === APP, "…while Node's own import.meta.dirname still works");
}

// 9) `bun test` is Bun's test MODE, and the .env files from block 7 are still on
// disk — including the .env.local that a test run must NOT see. Getting this wrong
// is invisible locally and only shows up as a suite that passes on the machine with
// an uncommitted .env.local and fails everywhere else (oven-sh/bun#9877).
console.log("\n== bun test (test mode: .env.test, no .env.local, NODE_ENV defaulted) ==");
{
  write(".env.test", "SHARED=from-test\nTEST_ONLY=yes\n");
  write("envmode.test.ts", [
    "import { test, expect } from 'bun:test';",
    "test('test mode env', () => {",
    "  expect(process.env.NODE_ENV).toBe('test');",
    "  expect(process.env.SHARED).toBe('from-test');",
    "  expect(process.env.TEST_ONLY).toBe('yes');",
    "  expect(process.env.LOCAL_ONLY).toBe(undefined);",
    "  expect(process.env.ONLY_BASE).toBe('base');",
    "});",
  ].join("\n"));
  const r = await kernel.start("bun", ["test", "envmode.test.ts"], { cwd: APP, env: ENV, capture: true });
  const o = (r.stdout || "") + (r.stderr || "");
  if (LIVE || r.code !== 0) console.log(o);
  ok(r.code === 0 && /1 pass/.test(o) && /0 fail/.test(o), "bun test reads .env.test, skips .env.local, and defaults NODE_ENV to 'test'");
}

console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: all bun spike checks passed");
process.exit(failed ? 1 : 0);