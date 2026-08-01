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

// 8) `bun test` is Bun's test MODE, and the .env files from block 7 are still on
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

// 9) bun run scan.ts — Bun.Glob.scan()/scanSync() + Bun.FileSystemRouter over the
// REAL Wasm VFS. This is the tier that matters for these two APIs: every readdir
// and every lstat below is a synchronous syscall from the process worker across
// the SharedArrayBuffer bridge to the fs worker, and none of that exists in
// scripts/spike-bun-offline.mjs (which drives the same walker against an
// in-memory tree). Symlinks in particular can only be proven here — the walk has
// to agree with what the VFS actually stores.
console.log("\n== bun run scan.ts (Bun.Glob.scan + Bun.FileSystemRouter over the VFS) ==");
{
  // No type annotations on purpose: this block is about the VFS walk, and the TS
  // transform is already covered by the blocks above.
  write("scan.ts", [
    "const fs = require('fs');",
    "const ROOT = '/app/scanroot';",
    "fs.mkdirSync(ROOT + '/src/nested', { recursive: true });",
    "fs.mkdirSync(ROOT + '/empty', { recursive: true });",
    "fs.mkdirSync(ROOT + '/pages/blog', { recursive: true });",
    "for (const f of ['index.ts', 'README.md', '.hidden.ts', 'src/index.ts', 'src/util.ts', 'src/nested/deep.ts']) fs.writeFileSync(ROOT + '/' + f, '');",
    "for (const f of ['pages/index.tsx', 'pages/settings.tsx', 'pages/blog/index.tsx', 'pages/blog/[slug].tsx']) fs.writeFileSync(ROOT + '/' + f, '');",
    // A symlink to a directory and a deliberately broken one. The VFS stores both
    // as real symlink inodes, so lstat/stat disagree exactly like on a real fs.
    "fs.symlinkSync(ROOT + '/src', ROOT + '/linkdir');",
    "fs.symlinkSync(ROOT + '/nope', ROOT + '/broken');",
    "const r = {};",
    "const list = (pattern, opts) => Array.from(new Bun.Glob(pattern).scanSync(opts));",
    "r.syncAll = list('**/*.ts', ROOT);",
    "r.rooted = list('src/*.ts', { cwd: ROOT });",
    "r.absolute = list('*.ts', { cwd: ROOT, absolute: true });",
    "r.dot = list('*.ts', { cwd: ROOT, dot: true });",
    "r.dirs = list('src/*', { cwd: ROOT, onlyFiles: false });",
    "r.notFollowed = list('linkdir/*.ts', { cwd: ROOT });",
    "r.followed = list('linkdir/*.ts', { cwd: ROOT, followSymlinks: true });",
    // The default cwd is process.cwd(), which is /app here.
    "r.defaultCwd = list('scanroot/src/*.ts');",
    "try { list('**', { cwd: ROOT, onlyFiles: false, throwErrorOnBrokenSymlink: true }); r.broken = 'did not throw'; }",
    "catch (e) { r.broken = String((e && e.message) || e); }",
    "const router = new Bun.FileSystemRouter({ style: 'nextjs', dir: ROOT + '/pages', origin: 'https://x.dev', assetPrefix: '_next/static/' });",
    "r.routes = Object.keys(router.routes).sort();",
    "r.home = router.match('/');",
    "r.post = router.match('/blog/hi?x=1');",
    "r.miss = router.match('/nope');",
    "async function main() {",
    "  const out = [];",
    "  for await (const f of new Bun.Glob('**/*.ts').scan(ROOT)) out.push(f);",
    "  r.asyncAll = out;",
    "  console.log('SCANRESULT:' + JSON.stringify(r));",
    "}",
    "main();",
  ].join("\n"));
  const run = await kernel.start("bun", ["run", "scan.ts"], { cwd: APP, env: ENV, capture: true });
  if (run.stderr) console.log("  stderr:", run.stderr.trim());
  const m = (run.stdout || "").match(/SCANRESULT:(\{.*\})/);
  const r = m ? JSON.parse(m[1]) : null;
  console.log("  ->", m ? JSON.stringify(r).slice(0, 160) + "…" : "(no result)", "exit", run.code);
  ok(run.code === 0 && !!r, "scan.ts exits 0 and reports a result");
  if (r) {
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    ok(eq(r.syncAll, ["index.ts", "src/index.ts", "src/nested/deep.ts", "src/util.ts"]),
      "scanSync('**/*.ts') walks the real VFS (sorted, relative, no dotfiles, .tsx not matched)");
    ok(eq(r.asyncAll, r.syncAll), "scan() (AsyncIterable) returns the same entries as scanSync() (Iterable)");
    ok(eq(r.rooted, ["src/index.ts", "src/util.ts"]), "a rooted pattern prunes to the one directory it can match");
    ok(eq(r.absolute, ["/app/scanroot/index.ts"]), "absolute: true returns VFS-absolute paths");
    ok(r.dot.indexOf(".hidden.ts") !== -1, "dot: true includes dotfiles (they are absent by default above)");
    ok(eq(r.dirs, ["src/index.ts", "src/nested", "src/util.ts"]), "onlyFiles: false adds the matching directory");
    ok(eq(r.defaultCwd, ["scanroot/src/index.ts", "scanroot/src/util.ts"]), "the default cwd is process.cwd()");
    // Symlinks: the VFS stores them as their own inode kind, so this is the real
    // behaviour and not an emulation of it.
    ok(eq(r.notFollowed, []), "followSymlinks defaults to false: a symlinked directory in the VFS is not traversed");
    ok(eq(r.followed, ["linkdir/index.ts", "linkdir/util.ts"]), "followSymlinks: true traverses it");
    ok(/broken symbolic link/.test(r.broken) && r.broken.indexOf("/app/scanroot/broken") !== -1,
      "throwErrorOnBrokenSymlink: true throws naming the dangling link");
    // FileSystemRouter, over a directory it scanned through the same walker.
    ok(eq(r.routes, ["/", "/blog", "/blog/[slug]", "/settings"]), "FileSystemRouter scanned the pages directory (index collapsed)");
    ok(r.home && r.home.kind === "exact" && r.home.filePath === "/app/scanroot/pages/index.tsx", "match('/') resolves to index.tsx");
    ok(r.home && r.home.src === "https://x.dev/_next/static/index.tsx", "src is origin + assetPrefix + the path relative to dir");
    ok(r.post && r.post.name === "/blog/[slug]" && r.post.params.slug === "hi", "a dynamic route matches and captures its parameter");
    ok(r.post && r.post.query.x === "1", "the query string is parsed");
    ok(r.miss === null, "an unmatched path returns null (there is no catch-all in this tree)");
  }
}

// 10) bun run cookies.ts — Bun.Cookie / Bun.CookieMap over a real request/response
// through the http bridge. The offline spike covers the parsing and serialisation
// (it is pure); what only THIS tier can prove is the hook: that `req.cookies` sees
// the header the bridge delivered, and that the Set-Cookie headers a handler
// produced come back out as SEPARATE header lines. That second one is the
// dangerous half — `Headers.forEach` flattens repeats into one comma-joined value,
// and an `Expires=Thu, 01 Jan 1970 …` value contains a comma of its own, so a
// flattened pair cannot be split apart again by anything downstream.
console.log("\n== bun run cookies.ts (Bun.Cookie + Bun.CookieMap over Bun.serve) ==");
{
  const PORT = 3943;
  write("cookies.ts", [
    "const server = Bun.serve({",
    "  port: " + PORT + ",",
    "  routes: {",
    // Reading cookies must emit NO Set-Cookie at all — otherwise every plain GET
    // rewrites every cookie the browser already had.
    "    '/read': (req: any) => new Response('session=' + req.cookies.get('session') + ' theme=' + req.cookies.get('theme') + ' missing=' + req.cookies.get('nope') + ' size=' + req.cookies.size),",
    "    '/login': (req: any) => {",
    "      req.cookies.set('session', 'abc123', { httpOnly: true, maxAge: 3600 });",
    "      req.cookies.set('stamp', 's', { expires: new Date(0) });",
    "      return new Response('ok', { headers: { 'set-cookie': 'from=response; Path=/' } });",
    "    },",
    "    '/logout': (req: any) => { req.cookies.delete('session'); return new Response('bye'); },",
    "  },",
    "  fetch(req: Request): Response { return new Response('cookies=' + new Bun.CookieMap(req.headers.get('cookie') || '').size); },",
    "});",
    "console.log('listening on ' + server.port);",
  ].join("\n"));
  kernel.start("bun", ["run", "cookies.ts"], { cwd: APP, env: ENV });
  for (let i = 0; i < 150 && !listening.has(PORT); i++) await new Promise((r) => setTimeout(r, 100));
  ok(listening.has(PORT), "Bun.serve(cookies) bound port " + PORT);

  // The shared httpGet harness drops the response headers, and the headers are
  // exactly what this block is about, so go at the bridge directly.
  const httpRaw = async (url, headers = {}) => {
    const r = await kernel.handleHttpRequest(PORT, {
      port: PORT, method: "GET", url,
      headers: { host: "127.0.0.1:" + PORT, ...headers },
      body: "",
    });
    return {
      status: r.status,
      headers: r.headers || {},
      body: typeof r.body === "string" ? r.body : Buffer.from(r.body || "").toString(),
    };
  };
  const setCookiesOf = (res) => {
    const v = res.headers["set-cookie"] || res.headers["Set-Cookie"];
    return v === undefined ? [] : Array.isArray(v) ? v : [v];
  };

  const read = await httpRaw("/read", { cookie: "session=abc; theme=dark" });
  console.log("  GET /read ->", read.status, JSON.stringify(read.body));
  ok(read.status === 200 && /session=abc/.test(read.body), "req.cookies reads the Cookie header the bridge delivered");
  ok(/theme=dark/.test(read.body) && /size=2/.test(read.body), "...both of them, and size counts them");
  ok(/missing=null/.test(read.body), "a cookie that is not there reads as null");
  ok(setCookiesOf(read).length === 0, "a handler that only READ cookies sends no Set-Cookie back");

  const login = await httpRaw("/login");
  const cookies = setCookiesOf(login);
  console.log("  GET /login -> set-cookie", JSON.stringify(cookies));
  ok(cookies.length === 3, "three Set-Cookie headers arrive as three SEPARATE header lines, not one comma-joined value");
  ok(cookies.some((c) => c === "session=abc123; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax"), "req.cookies.set() serialises with the documented Path=/ + SameSite=Lax defaults");
  ok(cookies.some((c) => c === "stamp=s; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax"), "an Expires value keeps the comma inside its own date — proof the headers were never flattened and re-split");
  ok(cookies.some((c) => c === "from=response; Path=/"), "a Set-Cookie the handler put on the Response survives alongside the ones from req.cookies");

  const logout = await httpRaw("/logout", { cookie: "session=abc" });
  ok(setCookiesOf(logout)[0] === "session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax", "delete() emits the empty-value + past-expiry tombstone that makes the browser drop the cookie");

  const viaFetch = await httpRaw("/other", { cookie: "a=1; b=2" });
  ok(/cookies=2/.test(viaFetch.body), "a `fetch` handler builds its own new Bun.CookieMap(req.headers.get('cookie')) — the documented path there, since `cookies` is BunRequest-only");
}

// 11) bun run files.ts — BunFile against the REAL Wasm VFS across the Atomics
// bridge. The offline tier runs these against host Node's fs; only here do the
// writes go through fs-client's 512 KiB fd window, which is the one part of this
// batch whose failure mode (a silently truncated file, or a syscall that hangs
// and 504s much later) looks nothing like its cause.
console.log("\n== bun run files.ts (BunFile, FileSink and Bun.write over the VFS) ==");
{
  write("files.ts", [
    "const dir = '/app/filetest';",
    "async function main() {",
    "  const r: any = {};",
    "  r.written = await Bun.write(dir + '/hello.txt', 'hello world');",
    "  const f = Bun.file(dir + '/hello.txt');",
    "  r.size = f.size; r.type = f.type; r.text = await f.text(); r.bytes = (await f.bytes()).length;",
    "  r.slice = await f.slice(6).text();",
    // Laziness, proven the only way that cannot be faked: slice a file that does
    // not exist yet, then create it.
    "  const ghost = Bun.file(dir + '/later.txt').slice(0, 3);",
    "  await Bun.write(dir + '/later.txt', 'abcdef');",
    "  r.lazySlice = await ghost.text();",
    "  r.stream = await Bun.readableStreamToText(f.slice(0, 5).stream());",
    "  await Bun.write(dir + '/j.json', '{\"a\":7}');",
    "  r.json = (await Bun.file(dir + '/j.json').json()).a;",
    // Incremental flush, read back THROUGH THE VFS before end() is called.
    "  const sink = Bun.file(dir + '/app.log').writer({ highWaterMark: 8 });",
    "  sink.write('0123456789');",
    "  r.midWrite = await Bun.file(dir + '/app.log').text();",
    "  sink.write('ab');",
    "  r.buffered = await Bun.file(dir + '/app.log').text();",
    "  sink.flush();",
    "  r.flushed = await Bun.file(dir + '/app.log').text();",
    "  r.endTotal = sink.end();",
    // Larger than the 1 MiB SAB window and than the 512 KiB fd chunk.
    "  const big = 'x'.repeat(1500000);",
    "  r.bigWrite = await Bun.write(dir + '/big.bin', big);",
    "  r.bigSize = Bun.file(dir + '/big.bin').size;",
    "  const bigSink = Bun.file(dir + '/big2.bin').writer();",
    "  bigSink.write(big);",
    "  r.bigSinkEnd = bigSink.end();",
    "  r.bigSinkSize = Bun.file(dir + '/big2.bin').size;",
    "  r.bigTail = await Bun.file(dir + '/big.bin').slice(1499997).text();",
    "  await Bun.file(dir + '/hello.txt').delete();",
    "  r.deleted = await Bun.file(dir + '/hello.txt').exists();",
    "  await Bun.write(dir + '/u.txt', 'u');",
    "  await Bun.file(dir + '/u.txt').unlink();",
    "  r.unlinked = await Bun.file(dir + '/u.txt').exists();",
    "  try { Bun.file(3); r.fdThrew = false; } catch (e) { r.fdThrew = /VFS handles/.test(String(e && e.message)); }",
    "  try { await Bun.write(4, 'x'); r.fdWriteThrew = false; } catch (e) { r.fdWriteThrew = /VFS handles/.test(String(e && e.message)); }",
    "  console.log('FILERESULT:' + JSON.stringify(r));",
    // Bun's three-line cat, through the kernel's stdout rather than a file.
    "  await Bun.write(Bun.stdout, Bun.file(dir + '/j.json'));",
    "}",
    "main().then(() => process.exit(0)).catch((e) => { console.log('FILEERROR:' + ((e && e.stack) || e)); process.exit(1); });",
  ].join("\n"));
  const run = await kernel.start("bun", ["run", "files.ts"], { cwd: APP, env: ENV, capture: true });
  const o = (run.stdout || "") + (run.stderr || "");
  if (LIVE) console.log(o);
  const m = o.match(/FILERESULT:(\{.*\})/);
  const r = m ? JSON.parse(m[1]) : {};
  if (!m) console.log("  no FILERESULT; output:", o.slice(-2000));
  console.log("  ->", JSON.stringify({ size: r.size, midWrite: r.midWrite, bigSize: r.bigSize }), "exit", run.code);
  ok(run.code === 0, "files.ts exits 0");
  ok(r.written === 11 && r.size === 11 && r.text === "hello world", "Bun.write + Bun.file round-trip through the Wasm VFS");
  ok(r.type === "text/plain" && r.bytes === 11, ".type and .bytes()");
  ok(r.slice === "world" && r.stream === "hello", ".slice() reads its window, and .stream() honours it");
  ok(r.lazySlice === "abc", ".slice() taken before the file existed still reads — the window resolves at read time, nothing was copied");
  ok(r.json === 7, ".json() parses a file out of the VFS");
  ok(r.midWrite === "0123456789", "the FileSink drained to the VFS on crossing the high-water mark — with no end(), a crash here loses nothing");
  ok(r.buffered === "0123456789" && r.flushed === "0123456789ab", "a write under the mark stays buffered until flush()");
  ok(r.endTotal === 12, "end() reports the sink's lifetime total");
  ok(r.bigWrite === 1500000 && r.bigSize === 1500000, "Bun.write chunks a 1.5 MB payload across the 512 KiB fd window instead of truncating at it");
  ok(r.bigSinkEnd === 1500000 && r.bigSinkSize === 1500000, "one FileSink.write() larger than the window is chunked the same way");
  ok(r.bigTail === "xxx", "...and the bytes past the window boundary read back");
  ok(r.deleted === false && r.unlinked === false, ".delete() and its .unlink() alias really remove the file");
  ok(r.fdThrew === true && r.fdWriteThrew === true, "Bun.file(fd) and Bun.write(fd, …) still throw naming VFS handles (Phase 0 stays fixed)");
  ok(/\{"a":7\}/.test(o), "Bun.write(Bun.stdout, Bun.file(p)) — Bun's cat — reaches the kernel's stdout");
}

// 12) bun run crypto.ts — Bun.CryptoHasher + Bun.password on the real runtime.
//
// scripts/spike-bun-offline.mjs already pins these against Bun's own vectors, but
// it hands the shim a hand-built internalBinding('crypto'). This block is the one
// that proves the production wiring: a real guest process reaching the Rust/Wasm
// crypto codec through the real process.binding('crypto'), inside the kernel. A
// password hash that only works when the test rigs the binding is not a feature.
console.log("\n== bun run crypto.ts (CryptoHasher + password on the real runtime) ==");
{
  write("crypto.ts", [
    "const out: string[] = [];",
    // Digest and HMAC vectors published by Bun (docs + its own test suite).
    "out.push('sha256=' + new Bun.CryptoHasher('sha256').update('hello world').digest('hex'));",
    "out.push('hmac=' + new Bun.CryptoHasher('sha256', 'key').update('data\\n').digest('hex'));",
    "out.push('blake2b512hmac=' + new Bun.CryptoHasher('blake2b512', 'key').update('data\\n').digest('hex'));",
    // .copy() diverging from a shared prefix.
    "const base = new Bun.CryptoHasher('sha256').update('hello ');",
    "out.push('copy=' + base.copy().update('world').digest('hex'));",
    // A consumed HMAC must be dead, not silently reusable.
    "const h = new Bun.CryptoHasher('sha256', 'key'); h.update('x'); h.digest();",
    "try { h.digest(); out.push('hmacreuse=nothrow'); } catch (e: any) { out.push('hmacreuse=' + e.message); }",
    // A hash real Bun wrote, verified here; then one we write, round-tripped.
    "out.push('bundoc=' + Bun.password.verifySync('hello', '$2b$10$Lyj9kHYZtiyfxh2G60TEfeqs7xkkGiEFFDi3iJGc50ZG/XJ1sxIFi'));",
    "out.push('bunlong=' + Bun.password.verifySync('hello'.repeat(100), '$2b$10$PsJ3/W82mzNJoP0rSblfvet2ab9jZg2aH7tIxr1B8uFLJwuWk/jTi'));",
    "const mine = Bun.password.hashSync('s3cret', { algorithm: 'argon2id', memoryCost: 8, timeCost: 1 });",
    "out.push('phc=' + mine.slice(0, 27));",
    "out.push('rt=' + Bun.password.verifySync('s3cret', mine) + ',' + Bun.password.verifySync('nope', mine));",
    "console.log('CRYPTORESULT:' + JSON.stringify(out));",
  ].join("\n"));
  const r = await kernel.start("bun", ["run", "crypto.ts"], { cwd: APP, env: ENV, capture: true });
  const o = (r.stdout || "") + (r.stderr || "");
  if (LIVE) console.log(o);
  const m = o.match(/CRYPTORESULT:(\[.*\])/);
  const got = m ? JSON.parse(m[1]) : [];
  if (!m && r.stderr) console.log("  stderr:", r.stderr.trim());
  console.log("  ->", JSON.stringify(got.slice(4)));
  ok(r.code === 0, "crypto.ts exits 0");
  ok(got.includes("sha256=b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"), "CryptoHasher sha256 matches Bun's documented digest");
  ok(got.includes("hmac=c7a7c96c73af32ea6e5b1ca6768b1d822249eb88f85160433d7b09bb2b21e170"), "HMAC-sha256 matches Bun's own test vector");
  ok(got.includes("blake2b512hmac=9e66ba10f4d7e80abc2584150fc5f9a246634118280fd9ae086794d37cb9919d681ee285b68f9cec2eda9f878d157125cc465c8b0e3c023a7040ed0be7f25023"), "the crate's hand-written HMAC-BLAKE2b-512 matches Bun's vector through the kernel");
  ok(got.includes("copy=b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"), "CryptoHasher.copy() continues the shared prefix");
  ok(got.includes("hmacreuse=HMAC has been consumed and is no longer usable"), "reusing a digested HMAC throws Bun's message, in a real process");
  ok(got.includes("bundoc=true"), "a bcrypt hash from Bun's docs verifies inside the VM");
  ok(got.includes("bunlong=true"), "…and so does Bun 1.2.4's hash of a 500-byte password (the SHA-512 pre-hash)");
  ok(got.includes("phc=$argon2id$v=19$m=8,t=1,p=1$"), "Bun.password.hash emits a real argon2id PHC string");
  ok(got.includes("rt=true,false"), "…which verifies the right password and rejects the wrong one");
}

console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: all bun spike checks passed");
process.exit(failed ? 1 : 0);