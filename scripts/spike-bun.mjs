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

import { LIVE, bootSpikeKernel, httpGet, httpPost } from "./lib/spike-harness.mjs";

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  \u2713 " : "  \u2717 ") + msg);
  if (!cond) failed++;
};

const { kernel, out, listening } = await bootSpikeKernel();

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

// 12b) The per-algorithm hash classes, on the same real wiring.
//
// The offline tier checks these against bun-1.3.14's vectors, but over the HOST's
// OpenSSL — which refuses md4 outright on a modern build, so that one algorithm is
// only ever exercised here, where the digest comes from Vivari's own Rust/Wasm
// codec (packages/crypto). Two classes are enough to prove the wiring; md4 is here
// because nothing else can prove it at all.
console.log("\n== Bun.MD4 / Bun.SHA256 through the Wasm crypto codec ==");
{
  write("hashclasses.ts", [
    "const out: string[] = [];",
    "out.push('md4=' + Bun.MD4.hash('hello', 'hex'));",
    "out.push('sha256=' + Bun.SHA256.hash('hello', 'hex'));",
    "out.push('sha512_256=' + Bun.SHA512_256.hash('hello', 'hex'));",
    "const h = new Bun.SHA256(); h.update('he'); h.update('llo');",
    "out.push('split=' + h.digest('hex'));",
    "try { h.update('more'); out.push('reuse=nothrow'); } catch (e: any) { out.push('reuse=' + e.message); }",
    "out.push('uuid5=' + Bun.randomUUIDv5('www.example.com', 'dns'));",
    "console.log('HASHCLASSES:' + JSON.stringify(out));",
  ].join("\n"));
  const r = await kernel.start("bun", ["run", "hashclasses.ts"], { cwd: APP, env: ENV, capture: true });
  const o = (r.stdout || "") + (r.stderr || "");
  const m = o.match(/HASHCLASSES:(\[.*\])/);
  const got = m ? JSON.parse(m[1]) : [];
  if (!m && r.stderr) console.log("  stderr:", r.stderr.trim().split("\n")[0]);
  ok(r.code === 0, "hashclasses.ts exits 0");
  ok(got.includes("md4=866437cb7a794bce2b727acc0362ee27"),
    "Bun.MD4 matches bun-1.3.14 — the algorithm the offline tier's OpenSSL cannot do");
  ok(got.includes("sha256=2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"), "Bun.SHA256 through the codec");
  ok(got.includes("sha512_256=e30d87cfa2a75db545eac4d61baf970366a8357c7f72fa95b52d0accb698f13a"), "Bun.SHA512_256 through the codec");
  ok(got.includes("split=2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"), "two updates hash as one, in a real process");
  ok(got.some((x) => x.startsWith("reuse=SHA256 hasher already digested")), "a digested hasher is consumed, in a real process");
  ok(got.includes("uuid5=2ed6657d-e927-568b-95e1-2665a8aea6a2"), "Bun.randomUUIDv5 through the real crypto path");
}

// 12c) HTMLRewriter, in a real guest process.
//
// scripts/spike-html-rewriter.mjs pins the engine against 136 recorded answers
// from a real bun binary, but it constructs the class directly. This is the part
// that can only be proven here: that `HTMLRewriter` is a GLOBAL inside a bun
// process — no import, no `Bun.` prefix — which is how every snippet on the
// internet reaches it, and that it survives the trip through the loader.
console.log("\n== HTMLRewriter as a global in a real bun process ==");
{
  write("rewrite.ts", [
    "const page = `<!DOCTYPE html><html><head><title>old</title></head>" +
      "<body><a href='/a'>A</a><a href='/b'>B</a><!--x--></body></html>`;",
    "const out = new HTMLRewriter()",
    "  .on('a[href]', { element(e) { e.setAttribute('href', 'https://cdn' + e.getAttribute('href')); } })",
    "  .on('title', { text(t) { if (t.text) t.replace('new'); } })",
    "  .onDocument({ comments(c) { c.remove(); } })",
    "  .transform(page);",
    "console.log('REWRITTEN:' + out);",
    "const res = await new HTMLRewriter().on('p', { async element(e) { await Bun.sleep(1); e.setAttribute('async', 'ok'); } })",
    "  .transform(new Response('<p>x</p>')).text();",
    "console.log('RESPONSE:' + res);",
  ].join("\n"));
  const r = await kernel.start("bun", ["run", "rewrite.ts"], { cwd: APP, env: ENV, capture: true });
  const o = (r.stdout || "") + (r.stderr || "");
  if (!/REWRITTEN:/.test(o) && r.stderr) console.log("  stderr:", r.stderr.trim().split("\n")[0]);
  ok(r.code === 0, "rewrite.ts exits 0");
  ok(o.includes("REWRITTEN:<!DOCTYPE html><html><head><title>new</title></head>"),
    "the global rewrote the title and left the doctype and the untouched markup alone");
  ok(o.includes(`<a href="https://cdn/a">A</a><a href="https://cdn/b">B</a></body>`),
    "…rewrote both links and dropped the comment");
  ok(o.includes(`RESPONSE:<p async="ok">x</p>`), "…and awaited an async handler on the Response path, inside the VM");
}

// N) bun:sqlite on the REAL Wasm VFS, in real processes.
//
// This is the end-to-end proof the offline tier cannot give: the offline spike drives
// the same engine over node:fs, which shows the SQL and the API are right but says
// nothing about whether SQLite's VFS callbacks survive being routed through the
// SharedArrayBuffer syscall bridge into the Rust/Wasm VFS. Here they are — and the
// database is a real file in the project tree that OUTLIVES the process that wrote it.
//
// The engine is delivered by VV_SQLITE_WASM_PATH (a path inside the VFS). In the browser
// the kernel instead sets VV_SQLITE_WASM_URL and the guest pulls the same bytes through
// the blocking OP_FETCH syscall; there is no HTTP server in this harness, so the path
// override — a documented embedder escape hatch, not a test-only hook — stands in.
console.log("\n== bun:sqlite (real Wasm VFS, real processes) ==");
{
  const { readFileSync, existsSync } = await import("node:fs");
  const ENGINE_SRC = new URL("../packages/runtime/vendor/sqlite/sqlite3.wasm", import.meta.url);

  // The artifact is COMMITTED. A missing one is a broken checkout, and skipping would
  // make this spike pass while proving nothing — the trap AGENTS.md names.
  if (!existsSync(ENGINE_SRC)) {
    ok(false, "packages/runtime/vendor/sqlite/sqlite3.wasm is missing (committed artifact — restore it with git, or `node scripts/vendor-sqlite.mjs --refresh`)");
  } else {
    const engineBytes = new Uint8Array(readFileSync(ENGINE_SRC));
    const engineSize = engineBytes.length; // writeLarge transfers (and detaches) the buffer
    const ENGINE_VFS_PATH = "/usr/lib/vivari/sqlite3.wasm";
    kernel.mkdirp("/usr/lib/vivari");
    await kernel.fs.writeLarge(ENGINE_VFS_PATH, engineBytes);
    ok(kernel.exists(ENGINE_VFS_PATH), `the ${engineSize}-byte engine is in the VFS at ${ENGINE_VFS_PATH}`);
    const SQL_ENV = { ...ENV, VV_SQLITE_WASM_PATH: ENGINE_VFS_PATH };

    // --- process 1: create the database and write to it, synchronously ---
    write("db-write.ts", [
      "import { Database } from 'bun:sqlite';",
      // No `await` anywhere in this file. That is the whole premise: bun:sqlite is a
      // synchronous API and there is nowhere to await an engine boot.
      "const db = new Database('./data.db');",
      "db.run('CREATE TABLE todo(id INTEGER PRIMARY KEY, task TEXT NOT NULL, big INTEGER)');",
      "const insert = db.query('INSERT INTO todo(task, big) VALUES($task, $big)');",
      "const tx = db.transaction((rows: any[]) => { for (const r of rows) insert.run(r); });",
      "tx([{ $task: 'write it', $big: 9007199254740993n }, { $task: 'read it back', $big: 2n }]);",
      "const rows = db.query('SELECT id, task FROM todo ORDER BY id').all();",
      "const safe = new Database('./data.db', { safeIntegers: true });",
      "const big = safe.query('SELECT big FROM todo WHERE id = 1').get() as any;",
      "console.log('WROTE:' + JSON.stringify({",
      "  version: (db.query('SELECT sqlite_version() v').get() as any).v,",
      "  rows,",
      "  filename: db.filename,",
      "  big: String(big.big),",
      "  bigType: typeof big.big,",
      "}));",
      "safe.close(); db.close();",
    ].join("\n"));

    const w = await kernel.start("bun", ["run", "db-write.ts"], { cwd: APP, env: SQL_ENV, capture: true });
    if (w.stderr) console.log("  stderr:", w.stderr.trim());
    const wm = (w.stdout || "").match(/WROTE:(\{.*\})/);
    const wrote = wm ? JSON.parse(wm[1]) : null;
    console.log("  ->", JSON.stringify(wrote));
    ok(w.code === 0, "bun run db-write.ts exits 0");
    ok(!!wrote && /^3\.\d+\.\d+$/.test(wrote.version), `real SQLite booted in-process (${wrote && wrote.version})`);
    ok(!!wrote && wrote.rows.length === 2, "two rows inserted inside a transaction and read back");
    ok(!!wrote && wrote.rows[0].task === "write it", "…with the right column values");
    ok(!!wrote && wrote.big === "9007199254740993" && wrote.bigType === "bigint",
      "safeIntegers:true returns an exact BigInt for a value above 2^53, through the kernel");

    // --- the database is a real file in the VFS, visible in the project tree ---
    ok(kernel.exists(APP + "/data.db"), "the database exists in the VFS at /app/data.db");
    const onDisk = kernel.readFileBytes(APP + "/data.db");
    ok(onDisk.length >= 4096, `…and has real content (${onDisk.length} bytes)`);
    ok(Buffer.from(onDisk.subarray(0, 16)).toString("latin1") === "SQLite format 3\0",
      "…starting with SQLite's documented 16-byte file header");
    ok(kernel.readdir(APP).includes("data.db"), "…and it shows up in a directory listing (so, in the file tree)");
    ok(!kernel.exists(APP + "/data.db-journal"), "no rollback journal is left behind after a clean commit");

    // --- process 2: a DIFFERENT process reads what the first one committed ---
    write("db-read.ts", [
      "import { Database } from 'bun:sqlite';",
      "const db = new Database('./data.db', { readonly: true });",
      "const rows = db.query('SELECT task FROM todo ORDER BY id').values().flat();",
      "console.log('READ:' + JSON.stringify({ rows, pid: process.pid }));",
      "db.close();",
    ].join("\n"));
    const r2 = await kernel.start("bun", ["run", "db-read.ts"], { cwd: APP, env: SQL_ENV, capture: true });
    if (r2.stderr) console.log("  stderr:", r2.stderr.trim());
    const rm = (r2.stdout || "").match(/READ:(\{.*\})/);
    const read = rm ? JSON.parse(rm[1]) : null;
    console.log("  ->", JSON.stringify(read));
    ok(r2.code === 0, "bun run db-read.ts exits 0");
    ok(!!read && JSON.stringify(read.rows) === '["write it","read it back"]',
      "a SECOND process opens the same file and sees the committed rows");
    ok(!!read && read.pid !== undefined, "…as a genuinely separate process");

    // --- cwd resolution, :memory:, and the loud refusals, in a real process ---
    write("sub/nested.ts", [
      "import { Database } from 'bun:sqlite';",
      "import { existsSync } from 'node:fs';",
      "const out: any = { cwd: process.cwd() };",
      // A relative path must land next to the running script's cwd, not at the VFS root.
      "const db = new Database('./local.db');",
      "db.run('CREATE TABLE t(v TEXT)'); db.run(\"INSERT INTO t VALUES('here')\");",
      "out.here = (db.query('SELECT v FROM t').get() as any).v; db.close();",
      "const mem = new Database(':memory:');",
      "out.mem = (mem.query('SELECT 1+1 AS v').get() as any).v;",
      "try { mem.loadExtension('x'); out.ext = 'NO THROW'; } catch (e: any) { out.ext = e.message.slice(0, 90); }",
      "out.rootFree = !existsSync('/local.db');",
      "console.log('NESTED:' + JSON.stringify(out));",
    ].join("\n"));
    const r3 = await kernel.start("bun", ["run", "nested.ts"], { cwd: APP + "/sub", env: SQL_ENV, capture: true });
    if (r3.stderr) console.log("  stderr:", r3.stderr.trim());
    const nm = (r3.stdout || "").match(/NESTED:(\{.*\})/);
    const nested = nm ? JSON.parse(nm[1]) : null;
    console.log("  ->", JSON.stringify(nested));
    ok(r3.code === 0, "bun run sub/nested.ts exits 0");
    ok(kernel.exists(APP + "/sub/local.db"), "a relative filename resolves against the PROCESS cwd (/app/sub/local.db)");
    ok(!!nested && nested.rootFree === true, "…and not against the VFS root");
    ok(!!nested && nested.cwd === APP + "/sub" && nested.here === "here", "…and reads back what it wrote there");
    ok(!!nested && nested.mem === 2, ":memory: works and needs no file");
    ok(!!nested && /not supported in Vivari/.test(nested.ext || ""), "loadExtension() throws inside a real process");

    // --- a missing engine names the cause rather than failing mysteriously ---
    write("noengine.ts", [
      "import { Database } from 'bun:sqlite';",
      "try { new Database(':memory:'); console.log('ENGINE:NO THROW'); }",
      "catch (e: any) { console.log('ENGINE:' + e.message.split('\\n')[0]); }",
    ].join("\n"));
    const r4 = await kernel.start("bun", ["run", "noengine.ts"], {
      cwd: APP,
      env: { ...ENV, VV_SQLITE_WASM_PATH: "/usr/lib/vivari/does-not-exist.wasm" },
      capture: true,
    });
    const em = (r4.stdout || "").match(/ENGINE:(.*)/);
    console.log("  ->", em && em[1]);
    ok(!!em && /could not load a SQLite engine/.test(em[1]),
      "a bad VV_SQLITE_WASM_PATH throws an actionable error instead of a mystery");
    ok(!!em && /VV_SQLITE_WASM_PATH/.test(em[1]), "…naming the override that was set");
  }
}

// ── Bun.serve option handling, on real sockets ───────────────────────────────
// The offline tier proves normalizeServeOptions returns the right CONFIG. Only
// this tier can prove the config is actually enforced: that an idle socket is
// really closed by a real timer, that an oversized body really gets a 413, and
// that `static` really serves without a handler.
console.log("\n== bun run serve-options.ts (static, maxRequestBodySize, requestIP, tls degradation) ==");
{
  const PORT = 3951;
  write("serve-options.ts", [
    "const server = Bun.serve({",
    "  port: " + PORT + ",",
    // TLS must DEGRADE, not throw: this server has a certificate configured and
    // still has to boot and serve plaintext.
    "  tls: { cert: 'fake-cert', key: 'fake-key' },",
    "  maxRequestBodySize: 64,",
    "  id: 'options-demo',",
    "  static: {",
    "    '/health': new Response('STATIC-OK', { headers: { 'content-type': 'text/plain' } }),",
    "  },",
    "  routes: {",
    "    '/health': () => new Response('ROUTE-SHOULD-NOT-WIN'),",
    "  },",
    "  fetch(req: Request, server: any): Response {",
    "    const url = new URL(req.url);",
    "    if (url.pathname === '/ip') return new Response(JSON.stringify(server.requestIP(req)));",
    "    if (url.pathname === '/id') return new Response(String(server.id));",
    "    if (url.pathname === '/proto') return new Response(String(server.url));",
    "    if (url.pathname === '/echo') return new Response('echoed');",
    "    return new Response('home');",
    "  },",
    "});",
    "console.log('listening on ' + server.port);",
  ].join("\n"));
  kernel.start("bun", ["run", "serve-options.ts"], { cwd: APP, env: ENV });
  for (let i = 0; i < 150 && !listening.has(PORT); i++) await new Promise((r) => setTimeout(r, 100));
  ok(listening.has(PORT), "Bun.serve with a `tls` option still BOOTS and binds " + PORT + " (degrade, not throw)");

  const health = await httpGet(kernel, PORT, "/health");
  ok(health.status === 200 && /STATIC-OK/.test(health.body), "`static` serves a pre-built Response");
  ok(!/ROUTE-SHOULD-NOT-WIN/.test(health.body), "…and takes precedence over a `routes` entry on the same path, as Bun does");

  const ip = await httpGet(kernel, PORT, "/ip");
  ok(ip.body.trim() === "null", "requestIP() returns null, not a fabricated 127.0.0.1 (a rate limiter can now tell)");

  const id = await httpGet(kernel, PORT, "/id");
  ok(id.body.trim() === "options-demo", "the `id` option is exposed as server.id");

  const proto = await httpGet(kernel, PORT, "/proto");
  ok(/^http:/.test(proto.body.trim()), "server.url reports http:, honestly, even though tls was configured");

  // maxRequestBodySize is enforced as the body arrives.
  const small = await httpPost(kernel, PORT, "/echo", "x".repeat(10));
  ok(small.status === 200 && /echoed/.test(small.body), "a body under maxRequestBodySize is served normally");
  const big = await httpPost(kernel, PORT, "/echo", "x".repeat(5000));
  ok(big.status === 413, "a body over maxRequestBodySize is refused with 413, not silently accepted");
}

console.log("\n== bun run serve-idle.ts (idleTimeout is a real timer on a real socket) ==");
{
  const PORT = 3952;
  write("serve-idle.ts", [
    "const net = require('net');",
    "const PORT = " + PORT + ";",
    "const server = Bun.serve({",
    "  port: PORT,",
    // 1 second: long enough not to race the connect, short enough for CI.
    "  idleTimeout: 1,",
    "  fetch(): Response { return new Response('hi'); },",
    "});",
    "const out: string[] = [];",
    // Open a connection and deliberately send nothing. With idleTimeout ignored
    // (the old behaviour) this socket stays open forever; honoured, it is closed.
    "const idle = net.connect(PORT, '127.0.0.1', () => { out.push('connected'); });",
    "const t0 = Date.now();",
    "idle.on('close', () => {",
    "  out.push('closed-after-ms:' + (Date.now() - t0));",
    "  console.log('IDLERESULT:' + JSON.stringify(out));",
    "  try { server.stop(); } catch (e) {}",
    "  setTimeout(() => process.exit(0), 50);",
    "});",
    "setTimeout(() => { out.push('STILL-OPEN'); console.log('IDLERESULT:' + JSON.stringify(out)); process.exit(0); }, 6000);",
  ].join("\n"));
  const r = await kernel.start("bun", ["run", "serve-idle.ts"], { cwd: APP, env: ENV, capture: true });
  const o = (r.stdout || "") + (r.stderr || "");
  if (LIVE) console.log(o);
  const m = o.match(/IDLERESULT:(\[.*\])/);
  const got = m ? JSON.parse(m[1]) : [];
  console.log("  ->", JSON.stringify(got));
  if (!m && r.stderr) console.log("  stderr:", r.stderr.trim().slice(0, 600));
  ok(got.includes("connected"), "the idle client connected");
  ok(!got.includes("STILL-OPEN"), "idleTimeout genuinely closed an idle connection (it used to be ignored entirely)");
  const closedAt = (got.find((s) => typeof s === "string" && s.startsWith("closed-after-ms:")) || "").split(":")[1];
  ok(closedAt !== undefined && Number(closedAt) >= 900, "…and it waited out the full idleTimeout (" + closedAt + "ms) rather than closing immediately");
}

console.log("\n== bun run serve-unix.ts (the `unix` option binds a real socket) ==");
{
  write("serve-unix.ts", [
    "const net = require('net');",
    "const server = Bun.serve({",
    "  unix: '/tmp/bun-serve.sock',",
    "  fetch(): Response { return new Response('unix-served'); },",
    "});",
    "const out: string[] = [];",
    "out.push('url=' + String(server.url));",
    "const c = net.connect({ path: '/tmp/bun-serve.sock' }, () => {",
    "  c.write('GET / HTTP/1.1' + String.fromCharCode(13,10) + 'Host: x' + String.fromCharCode(13,10) + String.fromCharCode(13,10));",
    "});",
    "let buf = '';",
    "c.on('data', (d: any) => {",
    "  buf += String(d);",
    "  if (buf.indexOf('unix-served') !== -1) {",
    "    out.push('body-ok');",
    "    console.log('UNIXRESULT:' + JSON.stringify(out));",
    "    process.exit(0);",
    "  }",
    "});",
    "c.on('error', (e: any) => { out.push('err=' + e.message); console.log('UNIXRESULT:' + JSON.stringify(out)); process.exit(0); });",
    "setTimeout(() => { out.push('timeout'); console.log('UNIXRESULT:' + JSON.stringify(out)); process.exit(0); }, 5000);",
  ].join("\n"));
  const r = await kernel.start("bun", ["run", "serve-unix.ts"], { cwd: APP, env: ENV, capture: true });
  const o = (r.stdout || "") + (r.stderr || "");
  if (LIVE) console.log(o);
  const m = o.match(/UNIXRESULT:(\[.*\])/);
  const got = m ? JSON.parse(m[1]) : [];
  console.log("  ->", JSON.stringify(got));
  if (!m && r.stderr) console.log("  stderr:", r.stderr.trim().slice(0, 600));
  ok(got.includes("body-ok"), "Bun.serve({ unix }) binds a real UNIX socket that an in-VM client can fetch through");
  ok(got.some((s) => /^url=unix:/.test(s)), "…and server.url reports the unix: scheme rather than a fake http://localhost:0");
}

// ── WebSocket parity, against the in-VM client ───────────────────────────────
console.log("\n== bun run ws-parity.ts (ping/pong control frames, cork, sendText/Binary, publish*) ==");
{
  const PORT = 3953;
  write("ws-parity.ts", [
    "const PORT = " + PORT + ";",
    "const out: string[] = [];",
    "const server = Bun.serve({",
    "  port: PORT,",
    "  fetch(req: Request, server: any): any {",
    "    if (new URL(req.url).pathname === '/ws') { if (server.upgrade(req)) return; return new Response('no', { status: 400 }); }",
    "    return new Response('home');",
    "  },",
    "  websocket: {",
    "    open(ws: any) {",
    "      ws.subscribe('room');",
    "      out.push('buffered-is-number:' + (typeof ws.getBufferedAmount() === 'number'));",
    // cork() must batch and must propagate the callback's return value.
    "      const corkRet = ws.cork((w: any) => { w.sendText('c1'); w.sendText('c2'); w.sendText('c3'); return 'CORKRET'; });",
    "      out.push('cork-returns:' + corkRet);",
    "      ws.sendBinary(new Uint8Array([1, 2, 3]));",
    // A real RFC 6455 ping. The in-VM client auto-answers with a pong, which
    // must land in the server's `pong` handler.
    "      ws.ping('pingpayload');",
    "    },",
    "    message(ws: any, msg: any) {",
    "      if (typeof msg === 'string') out.push('text:' + msg);",
    "      else out.push('binary:' + new Uint8Array(msg).join(','));",
    "    },",
    "    pong(ws: any, data: any) {",
    "      out.push('pong:' + Buffer.from(data).toString('utf8'));",
    "      finish();",
    "    },",
    "    close() {},",
    "  },",
    "});",
    // A ping payload over 125 bytes must be refused, per RFC 6455 §5.5.
    "let sock: any = null;",
    "function finish() {",
    "  server.publishText('room', 'pub-text');",
    "  setTimeout(() => {",
    "    console.log('WSPARITY:' + JSON.stringify(out));",
    "    try { sock.close(); } catch (e) {}",
    "    try { server.stop(); } catch (e) {}",
    "    setTimeout(() => process.exit(0), 50);",
    "  }, 300);",
    "}",
    "sock = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');",
    "sock.binaryType = 'arraybuffer';",
    "sock.onmessage = (e: any) => {",
    "  if (typeof e.data === 'string') out.push('client-got:' + e.data);",
    "  else out.push('client-got-binary:' + new Uint8Array(e.data).join(','));",
    "};",
    "setTimeout(() => { out.push('TIMEOUT'); console.log('WSPARITY:' + JSON.stringify(out)); process.exit(0); }, 8000);",
  ].join("\n"));
  const r = await kernel.start("bun", ["run", "ws-parity.ts"], { cwd: APP, env: ENV, capture: true });
  const o = (r.stdout || "") + (r.stderr || "");
  if (LIVE) console.log(o);
  const m = o.match(/WSPARITY:(\[.*\])/);
  const got = m ? JSON.parse(m[1]) : [];
  console.log("  ->", JSON.stringify(got));
  if (!m && r.stderr) console.log("  stderr:", r.stderr.trim().slice(0, 800));
  ok(r.code === 0, "ws-parity.ts exits 0");
  ok(!got.includes("TIMEOUT"), "the parity run completed without hitting its watchdog");
  // ping/pong used to be `ping() {} pong() {}` — literally empty. A keepalive
  // loop therefore sent nothing while looking healthy.
  ok(got.includes("pong:pingpayload"), "ws.ping() sends a REAL control frame: the client's pong came back with the payload (RFC 6455 §5.5.2)");
  ok(got.includes("cork-returns:CORKRET"), "cork() returns the callback's value");
  ok(got.includes("client-got:c1") && got.includes("client-got:c2") && got.includes("client-got:c3"), "all three corked messages were delivered");
  ok(got.indexOf("client-got:c1") < got.indexOf("client-got:c2"), "…and cork preserves ordering");
  ok(got.includes("client-got-binary:1,2,3"), "sendBinary() delivers a binary frame");
  ok(got.includes("client-got:pub-text"), "server.publishText() reaches the subscriber as text");
  ok(got.includes("buffered-is-number:true"), "getBufferedAmount() reports real socket state");
}

console.log("\n== bun run ws-limits.ts (control-frame and payload limits are enforced) ==");
{
  const PORT = 3954;
  write("ws-limits.ts", [
    "const PORT = " + PORT + ";",
    "const out: string[] = [];",
    "const server = Bun.serve({",
    "  port: PORT,",
    "  fetch(req: Request, server: any): any {",
    "    if (new URL(req.url).pathname === '/ws') { if (server.upgrade(req)) return; return new Response('no', { status: 400 }); }",
    "    return new Response('home');",
    "  },",
    "  websocket: {",
    "    open(ws: any) {",
    // RFC 6455 §5.5: a control frame payload cannot exceed 125 bytes.
    "      try { ws.ping('x'.repeat(126)); out.push('oversized-ping-allowed'); }",
    "      catch (e: any) { out.push('oversized-ping-threw:' + /125 bytes/.test(e.message)); }",
    "      out.push('ping125-ok:' + (ws.ping('y'.repeat(125)) === 125));",
    "      out.push('send-returns-bytes:' + ws.send('hello'));",
    "      setTimeout(() => {",
    "        console.log('WSLIMITS:' + JSON.stringify(out));",
    "        try { server.stop(); } catch (e) {}",
    "        setTimeout(() => process.exit(0), 50);",
    "      }, 300);",
    "    },",
    "    message() {},",
    "    close() {},",
    "  },",
    "});",
    "const sock = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');",
    "setTimeout(() => { out.push('TIMEOUT'); console.log('WSLIMITS:' + JSON.stringify(out)); process.exit(0); }, 8000);",
  ].join("\n"));
  const r = await kernel.start("bun", ["run", "ws-limits.ts"], { cwd: APP, env: ENV, capture: true });
  const o = (r.stdout || "") + (r.stderr || "");
  if (LIVE) console.log(o);
  const m = o.match(/WSLIMITS:(\[.*\])/);
  const got = m ? JSON.parse(m[1]) : [];
  console.log("  ->", JSON.stringify(got));
  if (!m && r.stderr) console.log("  stderr:", r.stderr.trim().slice(0, 600));
  ok(got.includes("oversized-ping-threw:true"), "a 126-byte ping payload throws, naming RFC 6455's 125-byte control-frame limit");
  ok(got.includes("ping125-ok:true"), "a 125-byte ping is exactly legal and reports its byte count");
  ok(got.includes("send-returns-bytes:5"), "send() returns the byte count Bun documents");
}

// `drain` is now driven by the socket's real 'drain' event and the real return
// value of write(), rather than never being called. But it cannot actually fire
// on this loopback, and pinning that here is the point: node/bindings/net.js
// `doWrite` completes every write synchronously into the peer's inbox, so there
// is no send queue, no high-water mark, and no backpressure. If that binding ever
// grows a queue, this check fails and tells whoever changed it that `drain` and
// getBufferedAmount() have become live.
console.log("\n== bun run ws-backpressure.ts (the loopback genuinely never backpressures) ==");
{
  const PORT = 3956;
  write("ws-backpressure.ts", [
    "const PORT = " + PORT + ";",
    "const out: string[] = [];",
    "const server = Bun.serve({",
    "  port: PORT,",
    "  fetch(req: Request, server: any): any { if (server.upgrade(req)) return; return new Response('no', { status: 400 }); },",
    "  websocket: {",
    "    open(ws: any) {",
    // 400 x 64 KiB = 25 MB into a peer that is not reading.
    "      const big = 'x'.repeat(64 * 1024);",
    "      let maxBuffered = 0;",
    "      for (let i = 0; i < 400; i++) { ws.send(big); const b = ws.getBufferedAmount(); if (b > maxBuffered) maxBuffered = b; }",
    "      out.push('max-buffered:' + maxBuffered);",
    "      setTimeout(() => {",
    "        out.push('drain-fired:' + drained);",
    "        console.log('WSBP:' + JSON.stringify(out));",
    "        try { server.stop(); } catch (e) {}",
    "        setTimeout(() => process.exit(0), 50);",
    "      }, 1000);",
    "    },",
    "    drain() { drained++; },",
    "    message() {}, close() {},",
    "  },",
    "});",
    "let drained = 0;",
    "const sock = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');",
    "setTimeout(() => { out.push('TIMEOUT'); console.log('WSBP:' + JSON.stringify(out)); process.exit(0); }, 9000);",
  ].join("\n"));
  const r = await kernel.start("bun", ["run", "ws-backpressure.ts"], { cwd: APP, env: ENV, capture: true });
  const o = (r.stdout || "") + (r.stderr || "");
  if (LIVE) console.log(o);
  const m = o.match(/WSBP:(\[.*\])/);
  const got = m ? JSON.parse(m[1]) : [];
  console.log("  ->", JSON.stringify(got));
  if (!m && r.stderr) console.log("  stderr:", r.stderr.trim().slice(0, 600));
  ok(got.includes("max-buffered:0"), "25 MB written into an unread socket never buffers — the loopback completes writes synchronously");
  ok(got.includes("drain-fired:0"), "…so `drain` correctly does NOT fire (it is real backpressure, not an unconditional callback)");
  ok(/websocket: { drain } .*will not fire/.test(o) || /drain.*will not fire/.test(o), "…and Bun.serve warns once that a `drain` handler has nothing to react to here");
}

// cork()'s whole point is coalescing several frames into ONE socket write. The
// WebSocket client above reassembles frames, so it cannot see write boundaries —
// which means the parity run proves delivery and ordering but NOT batching. This
// block drives a raw socket through its own handshake and counts inbound chunks,
// which is the only place the difference is observable.
console.log("\n== bun run ws-cork.ts (cork really coalesces into one socket write) ==");
{
  const PORT = 3955;
  write("ws-cork.ts", [
    "const net = require('net');",
    "const crypto = require('crypto');",
    "const PORT = " + PORT + ";",
    "const out: string[] = [];",
    "const server = Bun.serve({",
    "  port: PORT,",
    "  fetch(req: Request, server: any): any {",
    "    const mode = new URL(req.url).pathname;",
    "    if (server.upgrade(req, { data: { mode } })) return;",
    "    return new Response('no', { status: 400 });",
    "  },",
    "  websocket: {",
    "    open(ws: any) {",
    "      const send3 = (w: any) => { w.sendText('aaaa'); w.sendText('bbbb'); w.sendText('cccc'); };",
    "      if (ws.data.mode === '/corked') ws.cork(send3);",
    "      else send3(ws);",
    "    },",
    "    message() {}, close() {},",
    "  },",
    "});",
    // A raw client: do the RFC 6455 handshake by hand, then count how many
    // distinct TCP chunks carry the three frames.
    "function probe(path: string, done: (n: number) => void) {",
    "  const key = crypto.randomBytes(16).toString('base64');",
    "  const c = net.connect(PORT, '127.0.0.1', () => {",
    "    c.write('GET ' + path + ' HTTP/1.1' + String.fromCharCode(13,10) +",
    "      'Host: 127.0.0.1' + String.fromCharCode(13,10) +",
    "      'Upgrade: websocket' + String.fromCharCode(13,10) +",
    "      'Connection: Upgrade' + String.fromCharCode(13,10) +",
    "      'Sec-WebSocket-Version: 13' + String.fromCharCode(13,10) +",
    "      'Sec-WebSocket-Key: ' + key + String.fromCharCode(13,10) + String.fromCharCode(13,10));",
    "  });",
    "  let sawHandshake = false;",
    "  let chunks = 0;",
    "  let bytes = 0;",
    "  c.on('data', (d: any) => {",
    "    const s = String(d);",
    "    if (!sawHandshake) {",
    // The 101 may arrive in the same chunk as the frames; only count what
    // follows the header terminator.
    "      const idx = s.indexOf(String.fromCharCode(13,10,13,10));",
    "      if (idx !== -1) {",
    "        sawHandshake = true;",
    "        const rest = d.subarray(idx + 4);",
    "        if (rest.length) { chunks++; bytes += rest.length; }",
    "        return;",
    "      }",
    "      return;",
    "    }",
    "    chunks++; bytes += d.length;",
    "  });",
    "  setTimeout(() => { try { c.destroy(); } catch (e) {} done(chunks); }, 600);",
    "}",
    "probe('/corked', (corked: number) => {",
    "  out.push('corked-chunks:' + corked);",
    "  probe('/plain', (plain: number) => {",
    "    out.push('plain-chunks:' + plain);",
    "    console.log('WSCORK:' + JSON.stringify(out));",
    "    try { server.stop(); } catch (e) {}",
    "    setTimeout(() => process.exit(0), 50);",
    "  });",
    "});",
    "setTimeout(() => { out.push('TIMEOUT'); console.log('WSCORK:' + JSON.stringify(out)); process.exit(0); }, 9000);",
  ].join("\n"));
  const r = await kernel.start("bun", ["run", "ws-cork.ts"], { cwd: APP, env: ENV, capture: true });
  const o = (r.stdout || "") + (r.stderr || "");
  if (LIVE) console.log(o);
  const m = o.match(/WSCORK:(\[.*\])/);
  const got = m ? JSON.parse(m[1]) : [];
  console.log("  ->", JSON.stringify(got));
  if (!m && r.stderr) console.log("  stderr:", r.stderr.trim().slice(0, 800));
  const num = (p) => Number((got.find((s) => typeof s === "string" && s.startsWith(p)) || ":").split(":")[1]);
  ok(num("corked-chunks:") === 1, "three sends inside cork() arrive as ONE socket write (got " + num("corked-chunks:") + ")");
  ok(num("plain-chunks:") > 1, "…and the same three sends WITHOUT cork arrive as several (got " + num("plain-chunks:") + ") — so cork is really batching");
}

// ── the Readable.toWeb defect, which ONLY this tier can catch ────────────────
// `typeof Readable.toWeb === "function"` was TRUE in the VM while calling it threw,
// so the natural feature-detect passed and then exploded. Under host Node (the
// offline tier) toWeb works, so the offline tier cannot see this at all — which is
// exactly how it shipped, twice: first as ERR_METHOD_NOT_IMPLEMENTED, then as a
// TypeError from an adapter that required end-of-stream's module object as if it
// were the function. So this asserts toWeb WORKS, and that Bun.spawn() streams
// whether or not it routes through it.
//
// "Did not throw" is not enough on its own — it would also pass for a converter
// that hands out an empty stream — so the check below converts a real Readable
// and READS THE BYTES BACK. Both throws report `e.code || e.message`, because the
// second bug printed `toWeb-throws:undefined`: a code-less throw is the shape a
// wrong binding takes, and it is the shape a CI log has to be able to name.
console.log("\n== bun run spawn-stream.ts (Readable.toWeb + Bun.spawn().stdout in the VM) ==");
{
  write("spawn-stream.ts", [
    "const out: string[] = [];",
    "const { Readable } = require('stream');",
    "out.push('toWeb-looks-present:' + (typeof Readable.toWeb === 'function'));",
    "try { Readable.toWeb(Readable.from([Buffer.from('x')])); out.push('toWeb-works:true'); }",
    "catch (e: any) { out.push('toWeb-throws:' + (e && (e.code || e.message))); }",
    "const proc = Bun.spawn(['echo', 'hello-from-spawn']);",
    "out.push('stdout-has-getReader:' + (typeof proc.stdout.getReader === 'function'));",
    "(async () => {",
    "  try {",
    "    const web = Readable.toWeb(Readable.from([Buffer.from('toweb-bytes')]));",
    "    const wr = web.getReader();",
    "    let s = '';",
    "    for (;;) { const c = await wr.read(); if (c.done) break; s += Buffer.from(c.value).toString('utf8'); }",
    "    out.push('toWeb-reads:' + s);",
    "  } catch (e: any) { out.push('toWeb-throws:' + (e && (e.code || e.message))); }",
    "  const reader = proc.stdout.getReader();",
    "  let text = '';",
    "  for (;;) {",
    "    const { done, value } = await reader.read();",
    "    if (done) break;",
    "    text += Buffer.from(value).toString('utf8');",
    "  }",
    "  out.push('stdout-text:' + text.trim());",
    "  out.push('exited:' + (await proc.exited));",
    "  console.log('SPAWNRESULT:' + JSON.stringify(out));",
    "  process.exit(0);",
    "})();",
    "setTimeout(() => { out.push('TIMEOUT'); console.log('SPAWNRESULT:' + JSON.stringify(out)); process.exit(0); }, 8000);",
  ].join("\n"));
  const r = await kernel.start("bun", ["run", "spawn-stream.ts"], { cwd: APP, env: ENV, capture: true });
  const o = (r.stdout || "") + (r.stderr || "");
  if (LIVE) console.log(o);
  const m = o.match(/SPAWNRESULT:(\[.*\])/);
  const got = m ? JSON.parse(m[1]) : [];
  console.log("  ->", JSON.stringify(got));
  if (!m && r.stderr) console.log("  stderr:", r.stderr.trim().slice(0, 800));
  // The throw is quoted into the failing check itself, so the CI log names the
  // failure without needing a second run.
  const toWebThrow = got.find((s) => typeof s === "string" && s.startsWith("toWeb-throws:"));
  ok(got.includes("toWeb-looks-present:true"), "Readable.toWeb IS a function in the VM — which is why the `toWeb ? …` guard passed");
  ok(got.includes("toWeb-works:true"), "…and calling it returns a stream instead of throwing, so the guard is finally safe" + (toWebThrow ? " — got " + JSON.stringify(toWebThrow) : ""));
  ok(got.includes("toWeb-reads:toweb-bytes"), "…and that stream really yields the source bytes, not an empty one");
  ok(got.includes("stdout-has-getReader:true"), "Bun.spawn().stdout is a WHATWG ReadableStream built by hand instead");
  ok(got.includes("stdout-text:hello-from-spawn"), "…and it actually streams the child's output");
  ok(got.includes("exited:0"), "proc.exited still resolves the exit code");
}

// 12d) Bun's Subprocess is 19 members and ours was 6. The one that mattered is
// `exitCode`: `await p.exited; if (p.exitCode !== 0)` read `undefined !== 0` and
// took the failure branch after every SUCCESSFUL run. Two of the semantics here
// are not what you would guess, and both were read off the 1.3 binary: exitCode
// stays null when a signal killed the process (the code is in signalCode then),
// and `killed` is true after ANY exit, not only after kill().
console.log("\n== bun run subprocess.ts (Bun.spawn's Subprocess surface) ==");
{
  write("subprocess.ts", [
    "const out: string[] = [];",
    "(async () => {",
    "  const p: any = Bun.spawn(['sh', '-c', 'exit 7']);",
    "  out.push('before-exitCode:' + JSON.stringify(p.exitCode));",
    "  out.push('before-killed:' + p.killed);",
    "  try { p.send('x'); out.push('nochannel:returned'); } catch (e: any) { out.push('nochannel:' + e.message); }",
    "  try { p.disconnect(); out.push('disconnect-nochannel:ok'); } catch (e: any) { out.push('disconnect-nochannel:' + e.message); }",
    "  await p.exited;",
    "  out.push('after-exitCode:' + p.exitCode);",
    "  out.push('after-signalCode:' + JSON.stringify(p.signalCode));",
    "  out.push('after-killed:' + p.killed);",
    "  out.push('stdio-len:' + (Array.isArray(p.stdio) ? p.stdio.length : 'none'));",
    "  out.push('terminal:' + JSON.stringify(p.terminal));",
    "  out.push('ref-callable:' + (typeof p.ref === 'function' && typeof p.unref === 'function'));",
    "  try { p.resourceUsage(); out.push('rusage:returned'); } catch (e: any) { out.push('rusage:' + String(e.message).slice(0, 130)); }",
    "  try { p.send('x'); out.push('send:returned'); } catch (e: any) { out.push('send:' + e.message); }",
    "  out.push('connected:' + p.connected);",
    "  console.log('SUBPROCRESULT:' + JSON.stringify(out));",
    "  process.exit(0);",
    "})();",
  ].join("\n"));
  const r = await kernel.start("bun", ["run", "subprocess.ts"], { cwd: APP, env: ENV, capture: true });
  const o = (r.stdout || "") + (r.stderr || "");
  if (LIVE) console.log(o);
  const m = o.match(/SUBPROCRESULT:(\[.*\])/);
  const got = m ? JSON.parse(m[1]) : [];
  console.log("  ->", JSON.stringify(got));
  if (!m && r.stderr) console.log("  stderr:", r.stderr.trim().slice(0, 800));
  ok(got.includes("before-exitCode:null"), "Subprocess.exitCode is null while the process runs");
  ok(got.includes("before-killed:false"), "…and killed is false until it is done");
  ok(got.includes("after-exitCode:7"), "…and carries the real code after exit, which is the property scripts branch on");
  ok(got.includes("after-signalCode:null"), "…with signalCode null when no signal was involved");
  ok(got.includes("after-killed:true"), "…and killed true after any exit, as in Bun");
  ok(got.includes("stdio-len:3"), "Subprocess.stdio is the three streams");
  ok(got.includes("terminal:null"), "…terminal is null, since a pty was refused rather than faked");
  ok(got.includes("ref-callable:true"), "…ref/unref exist so background-process code does not crash on them");
  const rusage = got.find((s) => typeof s === "string" && s.startsWith("rusage:")) || "";
  // The distinction the two tiers draw: this one is impossible in a page, not
  // merely unwritten, so it must read as SANDBOX rather than SHIM.
  ok(rusage.includes("not supported") && rusage.includes("getrusage"), "resourceUsage() refuses instead of inventing a zeroed getrusage: " + JSON.stringify(rusage));
  // A Subprocess spawned WITHOUT `ipc` has no channel, and the two ways of saying
  // so are different sentences in bun — the exited one wins even though the
  // channel is also closed. Both were read off the 1.3.6 binary, and both are
  // asserted verbatim because people search for an error string.
  const noChannel = got.find((s) => typeof s === "string" && s.startsWith("nochannel:")) || "";
  ok(
    noChannel === "nochannel:Subprocess.send() can only be used if an IPC channel is open.",
    "send() on a subprocess spawned without ipc refuses in Bun's words rather than dropping the message: " + JSON.stringify(noChannel),
  );
  ok(got.includes("disconnect-nochannel:ok"), "…while disconnect() on that same subprocess is a no-op, not a throw");
  const send = got.find((s) => typeof s === "string" && s.startsWith("send:")) || "";
  ok(
    send === "send:Subprocess.send() cannot be used after the process has exited.",
    "…and once it has exited, send() reports the EXIT rather than the closed channel, as bun does: " + JSON.stringify(send),
  );
  ok(got.includes("connected:false"), "…and connected reports no channel");
}

// 12e) Bun.spawn({ ipc }) — a real channel between two real processes.
//
// This one HAS to run here rather than in the offline tier: the whole subject is
// two processes, each in its own worker, and the offline tier has neither. The
// transport is the kernel's existing cross-process pipe (OP_PIPE_LISTEN /
// OP_PIPE_CONNECT + the pipe-data relay), so the parent listens on a generated
// socket path before it spawns and the child dials it while it boots.
//
// What this tier can and cannot show is worth being precise about. It shows the
// surface, the lifecycle and what survives the crossing: 200 sends in one tick
// arriving as 200 messages in order, a 400 KB message arriving whole, a Map and a
// cycle still being a Map and a cycle, and a child that never reads its channel
// still exiting instead of hanging its parent.
//
// It does NOT show that the length-prefix framing works, and it cannot: in this
// VM one socket write is delivered as exactly one `data` event, so a reader that
// ignored the prefix entirely would pass everything below. Deleting the framing
// and re-running this file was tried; it stayed green. The framing is pinned in
// scripts/spike-bun-offline.mjs instead, by feeding the reader the splits and
// coalesces a byte stream is allowed to produce.
console.log("\n== bun run ipc-parent.ts (Bun.spawn({ ipc }) across two processes) ==");
{
  write("ipc-child.ts", [
    "import { writeFileSync } from 'node:fs';",
    "const seen: any = {",
    "  connectedAtStart: process.connected,",
    "  sendType: typeof process.send,",
    "  hasChannel: !!process.channel,",
    "  disconnectType: typeof process.disconnect,",
    // If either of these survived into the child's environment, everything the
    // child spawns would inherit the parent's channel address and dial it.
    "  envChannelGone: process.env.VV_IPC_CHANNEL === undefined,",
    "  envModeGone: process.env.NODE_CHANNEL_SERIALIZATION_MODE === undefined,",
    "};",
    "process.on('message', (m: any) => {",
    "  if (m.kind === 'echo') process.send({ kind: 'echoed', text: m.text });",
    "  else if (m.kind === 'burst') { for (let i = 0; i < m.n; i++) process.send({ kind: 'n', i }); }",
    "  else if (m.kind === 'big') process.send({ kind: 'big-back', len: m.payload.length, shape: /^\\[x+\\]$/.test(m.payload) });",
    "  else if (m.kind === 'big-please') process.send({ kind: 'big-down', payload: '[' + 'y'.repeat(m.n) + ']' });",
    "  else if (m.kind === 'clone') {",
    "    process.send({ kind: 'clone-back', map: m.map, when: m.when, bytes: m.bytes, huge: m.huge, re: m.re,",
    "      cycleHeld: m.cyc.self === m.cyc, mapIsMap: m.map instanceof Map, dateIsDate: m.when instanceof Date });",
    "  }",
    "  else if (m.kind === 'quit') process.send({ kind: 'bye' });",
    "});",
    // Everything the child can only observe AFTER the parent hangs up goes to a
    // file, because by then there is no channel left to report it on.
    "process.on('disconnect', () => {",
    "  seen.connectedAfterDisconnect = process.connected;",
    "  seen.lateSendReturned = process.send({ late: true });",
    "  seen.disconnectEventFired = true;",
    "  writeFileSync('/app/child-view.json', JSON.stringify(seen));",
    "});",
    "process.send({ kind: 'ready', seen });",
  ].join("\n"));

  // A child that gets a channel and never touches it. Under real bun this exits
  // the instant its script ends; a channel wired eagerly makes it immortal and
  // hangs the parent with it.
  write("ipc-quiet.ts", [
    "process.send({ kind: 'quiet-hello', connected: process.connected });",
  ].join("\n"));

  // A NODE child, not a bun one. It works here because both processes run this
  // same runtime — under real bun it would need serialization: 'json', which is
  // the divergence the warning below exists to announce.
  write("ipc-node-child.js", [
    "process.send({ from: 'node-child', when: new Date(86400000), connected: process.connected });",
  ].join("\n"));

  write("ipc-parent.ts", [
    "const r: any = {};",
    "const BIG = 400000;", // far larger than any single relay chunk
    "const deadline = (label: string, ms: number) => new Promise((_, rej) => setTimeout(() => rej(new Error('timed out waiting for ' + label)), ms));",
    "(async () => {",
    "  // --- the main channel ---------------------------------------------------",
    "  const got: any[] = [];",
    "  const waiters = new Map<string, (m: any) => void>();",
    "  const next = (kind: string, ms = 20000) =>",
    "    Promise.race([new Promise<any>((res) => waiters.set(kind, res)), deadline(kind, ms)]);",
    "  const proc: any = Bun.spawn(['bun', 'run', 'ipc-child.ts'], {",
    "    ipc(message: any, subprocess: any) {",
    "      got.push(message);",
    "      r.handlerSecondArgIsSubprocess = subprocess === proc;",
    "      const w = waiters.get(message.kind);",
    "      if (w) { waiters.delete(message.kind); w(message); }",
    "    },",
    "  });",
    "  r.connectedImmediately = proc.connected;",
    "  const ready = await next('ready');",
    "  r.childSeen = ready.seen;",
    "",
    "  // --- parent -> child -> parent -----------------------------------------",
    "  r.sendReturned = proc.send({ kind: 'echo', text: 'ping' });",
    "  r.echoed = (await next('echoed')).text;",
    "",
    "  // --- 200 sends in one tick, in order and all present --------------------",
    "  proc.send({ kind: 'burst', n: 200 });",
    "  const numbers: number[] = [];",
    "  await Promise.race([",
    "    new Promise<void>((res) => { waiters.set('n', function push(m: any) { numbers.push(m.i); if (numbers.length === 200) res(); else waiters.set('n', push); }); }),",
    "    deadline('the 200-message burst', 30000),",
    "  ]);",
    "  r.burstCount = numbers.length;",
    "  r.burstInOrder = numbers.every((v, i) => v === i);",
    "",
    "  // --- one message bigger than a relay chunk, both directions -------------",
    "  proc.send({ kind: 'big', payload: '[' + 'x'.repeat(BIG) + ']' });",
    "  const bigBack = await next('big-back');",
    "  r.bigUpLen = bigBack.len;",
    "  r.bigUpIntact = bigBack.shape && bigBack.len === BIG + 2;",
    "  proc.send({ kind: 'big-please', n: BIG });",
    "  const bigDown = await next('big-down');",
    "  r.bigDownIntact = /^\\[y+\\]$/.test(bigDown.payload) && bigDown.payload.length === BIG + 2;",
    "",
    "  // --- what survives: the default mode is a structured clone, not JSON ----",
    "  const cyc: any = { name: 'cyc' }; cyc.self = cyc;",
    "  proc.send({ kind: 'clone', map: new Map([['a', 1]]), when: new Date(86400000), bytes: new Uint8Array([1, 2, 250]), huge: 2n ** 70n, re: /ab+c/gi, cyc });",
    "  const back = await next('clone-back');",
    "  r.mapSurvived = back.mapIsMap && back.map instanceof Map && back.map.get('a') === 1;",
    "  r.dateSurvived = back.dateIsDate && back.when instanceof Date && back.when.getTime() === 86400000;",
    "  r.bytesSurvived = back.bytes instanceof Uint8Array && back.bytes[2] === 250;",
    "  r.bigintSurvived = typeof back.huge === 'bigint' && back.huge === 2n ** 70n;",
    "  r.regexpSurvived = back.re instanceof RegExp && back.re.source === 'ab+c' && back.re.flags === 'gi';",
    "  r.cycleSurvived = back.cycleHeld;",
    "  try { proc.send({ fn: () => 1 }); r.unclonable = 'accepted'; } catch (e: any) { r.unclonable = e.name + ': ' + e.message; }",
    "  try { proc.send(undefined); r.bareUndefined = 'accepted'; } catch (e: any) { r.bareUndefined = e.name + ': ' + e.message; }",
    "",
    "  // --- disconnect() closes both ends --------------------------------------",
    "  proc.send({ kind: 'quit' });",
    "  await next('bye');",
    "  proc.disconnect();",
    "  r.connectedAfterDisconnect = proc.connected;",
    "  try { proc.send({ kind: 'echo', text: 'too late' }); r.sendAfterDisconnect = 'accepted'; } catch (e: any) { r.sendAfterDisconnect = e.message; }",
    "  proc.disconnect();", // must be idempotent
    "  r.doubleDisconnect = 'ok';",
    "  r.exitCode = await Promise.race([proc.exited, deadline('the child to exit after disconnect', 30000)]);",
    "  r.connectedAfterExit = proc.connected;",
    "  try { proc.send({ kind: 'echo' }); r.sendAfterExit = 'accepted'; } catch (e: any) { r.sendAfterExit = e.message; }",
    "  try { r.childView = JSON.parse(await Bun.file('/app/child-view.json').text()); } catch (e: any) { r.childView = 'unreadable: ' + e.message; }",
    "",
    "  // --- a child that never reads the channel must still exit ---------------",
    "  const quietSeen: any[] = [];",
    "  const quiet: any = Bun.spawn(['bun', 'run', 'ipc-quiet.ts'], { ipc(m: any) { quietSeen.push(m); } });",
    "  r.quietExit = await Promise.race([quiet.exited, deadline('a child that never reads its channel to exit', 30000)]);",
    "  r.quietGot = quietSeen.length === 1 && quietSeen[0].kind === 'quiet-hello' && quietSeen[0].connected === true;",
    "  r.quietConnectedAfterExit = quiet.connected;",
    "",
    "  // --- a node child gets the same channel, and the gap is announced -------",
    "  const nodeSeen: any[] = [];",
    "  const np: any = Bun.spawn(['node', 'ipc-node-child.js'], { ipc(m: any) { nodeSeen.push(m); } });",
    "  r.nodeExit = await Promise.race([np.exited, deadline('a node child', 30000)]);",
    "  r.nodeGot = nodeSeen.length === 1 && nodeSeen[0].from === 'node-child' && nodeSeen[0].connected === true;",
    "  r.nodeKeptDate = nodeSeen.length === 1 && nodeSeen[0].when instanceof Date;",
    "",
    "  // --- serialization: 'json' is the other mode, and it loses all of that ---",
    "  const jsonSeen: any[] = [];",
    "  const jp: any = Bun.spawn(['bun', 'run', 'ipc-child.ts'], { serialization: 'json', ipc(m: any) { jsonSeen.push(m); } });",
    "  await Promise.race([new Promise<void>((res) => { const t = setInterval(() => { if (jsonSeen.length) { clearInterval(t); res(); } }, 20); }), deadline('the json-mode child', 20000)]);",
    "  jp.send({ kind: 'clone', map: new Map([['a', 1]]), when: new Date(86400000), bytes: new Uint8Array([1, 2, 250]), huge: 7, re: /x/, cyc: { self: null } });",
    "  const jsonBack = await Promise.race([new Promise<any>((res) => { const t = setInterval(() => { const hit = jsonSeen.find((m) => m.kind === 'clone-back'); if (hit) { clearInterval(t); res(hit); } }, 20); }), deadline('the json-mode reply', 20000)]);",
    "  r.jsonMapIsPlain = !(jsonBack.map instanceof Map) && typeof jsonBack.map === 'object';",
    "  r.jsonDateIsString = typeof jsonBack.when === 'string';",
    "  jp.kill();",
    "  await jp.exited;",
    "",
    // An explicit marker, because the guest can die without reaching the catch
    // below (an uncaught 'error' emit does exactly that), and an absent `fatal`
    // would then read as success.
    "  r.completed = true;",
    "  console.log('IPCRESULT:' + JSON.stringify(r));",
    "  process.exit(0);",
    "})().catch((e) => { console.log('IPCRESULT:' + JSON.stringify({ ...r, fatal: String(e && e.message || e) })); process.exit(1); });",
  ].join("\n"));

  const run = await kernel.start("bun", ["run", "ipc-parent.ts"], { cwd: APP, env: ENV, capture: true });
  const o = (run.stdout || "") + (run.stderr || "");
  if (LIVE) console.log(o);
  const m = o.match(/IPCRESULT:(\{.*\})/);
  const r = m ? JSON.parse(m[1]) : {};
  if (!m && run.stderr) console.log("  stderr:", run.stderr.trim().slice(0, 1200));
  console.log("  ->", JSON.stringify(r).slice(0, 700));
  ok(r.completed === true, "the ipc parent ran every case to completion" + (r.fatal ? ": " + r.fatal : ""));

  const childSeen = r.childSeen || {};
  ok(r.connectedImmediately === true, "Subprocess.connected is true as soon as Bun.spawn({ipc}) returns, before the child has dialled in");
  ok(childSeen.connectedAtStart === true && childSeen.sendType === "function", "the child sees process.send and process.connected — Node's fork surface, which is what the bun binary hands a child");
  ok(childSeen.hasChannel === true && childSeen.disconnectType === "function", "…along with process.channel and process.disconnect()");
  ok(
    childSeen.envChannelGone === true && childSeen.envModeGone === true,
    "the channel address is gone from the child's env before its first line, so a GRANDCHILD cannot inherit it and dial the parent's server",
  );
  ok(r.handlerSecondArgIsSubprocess === true, "the ipc handler's second argument is the Subprocess, which is what lets a handler reply");
  ok(r.sendReturned === true && r.echoed === "ping", "a message goes parent -> child and an answer comes back child -> parent");
  ok(r.burstCount === 200, "all 200 messages sent in ONE tick cross the process boundary — none coalesced away, none dropped");
  ok(r.burstInOrder === true, "…and they arrive in the order they were sent");
  ok(r.bigUpIntact === true, "a 400002-byte message crosses parent -> child whole, well past anything the relay was built for: len=" + r.bigUpLen);
  ok(r.bigDownIntact === true, "…and child -> parent too");
  ok(r.mapSurvived === true, "a Map arrives as a Map — the default mode is a structured clone, and JSON would have delivered {}");
  ok(r.dateSurvived === true, "…a Date as a Date, not as an ISO string");
  ok(r.bytesSurvived === true, "…a Uint8Array with its bytes");
  ok(r.bigintSurvived === true, "…a BigInt, which JSON cannot even encode");
  ok(r.regexpSurvived === true, "…and a RegExp with its flags");
  ok(r.cycleSurvived === true, "a cycle survives with its identity intact, where JSON.stringify would have thrown");
  ok(
    r.unclonable === "DataCloneError: The object can not be cloned.",
    "an unclonable value is refused at the send() call in the binary's own words, not dropped: " + JSON.stringify(r.unclonable),
  );
  ok(
    r.bareUndefined === 'TypeError: The "message" argument must be specified',
    "…and send(undefined) says so, which is the mistake behind a value that turned out not to exist: " + JSON.stringify(r.bareUndefined),
  );
  ok(r.connectedAfterDisconnect === false, "disconnect() flips connected to false on the parent");
  ok(
    r.sendAfterDisconnect === "Subprocess.send() can only be used if an IPC channel is open.",
    "…and send() then refuses rather than queueing into a channel nobody will read: " + JSON.stringify(r.sendAfterDisconnect),
  );
  ok(r.doubleDisconnect === "ok", "…and calling disconnect() twice is not an error");
  const childView = r.childView || {};
  ok(childView.disconnectEventFired === true, "the CHILD gets a 'disconnect' event when the parent hangs up, instead of waiting on a dead socket");
  ok(childView.connectedAfterDisconnect === false, "…its process.connected goes false");
  ok(childView.lateSendReturned === false, "…and its process.send() returns false rather than throwing, which is what the binary does");
  ok(r.exitCode === 0, "the child exits cleanly once the channel is closed, instead of being held open by its own message listener");
  ok(r.connectedAfterExit === false, "a child that has exited reports connected === false");
  ok(
    r.sendAfterExit === "Subprocess.send() cannot be used after the process has exited.",
    "…and send() names the EXIT rather than the closed channel, as bun does: " + JSON.stringify(r.sendAfterExit),
  );
  ok(r.quietGot === true, "a child that never attaches a message listener can still send");
  ok(r.quietExit === 0, "…and still exits on its own, so an unread channel does not make every child immortal and hang the parent");
  ok(r.quietConnectedAfterExit === false, "…leaving the parent's connected false");
  ok(r.nodeGot === true && r.nodeExit === 0, "a NODE child gets the same channel and the same process.send, since both ends are this one runtime");
  ok(r.nodeKeptDate === true, "…and its Date survives, which under real bun it would not without serialization: 'json'");
  // Working where bun does not is the one direction this project treats as a bug:
  // it is a green suite here and a silent failure in production. It cannot be made
  // stricter without faking a failure, so it has to be said out loud.
  ok(
    /Bun\.spawn\(\{ ipc \}\) with a node child/.test(o) && /v8\.serialize/.test(o),
    "…and Vivari warns once that real bun needs serialization: 'json' there, rather than letting the sandbox be quietly looser than production",
  );
  ok(r.jsonMapIsPlain === true, "serialization: 'json' really is JSON: a Map arrives as a plain object");
  ok(r.jsonDateIsString === true, "…and a Date as a string, which is the cost of the mode that talks to a node child");
}

// 12e) A fetch that never reached the network. The guest's `fetch` IS the host
// realm's own (wrapped in packages/runtime/index.js), so a CORS-blocked request
// fails in the BROWSER and never reaches the kernel: what the guest saw was
// `TypeError: Failed to fetch` and nothing else. That reads as a bug in the
// guest's own code, and it is the commonest way a program that works under a real
// bun looks broken here. The runtime cannot say WHICH cause it was — the spec
// forbids the browser from telling it — so the subject of this test is that both
// causes are named and neither is claimed. A refused connection is the same
// opaque failure as a CORS block, which is exactly why it can stand in for one.
console.log("\n== bun run fetch-blocked.ts (an opaque network failure explains itself) ==");
{
  write("fetch-blocked.ts", [
    "const out: any = {};",
    "(async () => {",
    "  try { await fetch('http://127.0.0.1:1/nope'); out.threw = false; }",
    "  catch (e: any) { out.threw = true; out.name = e.constructor.name; out.msg = String(e.message); out.cause = e.cause ? String(e.cause.message || e.cause) : null; }",
    "  console.log('FETCHFAIL:' + JSON.stringify(out));",
    "  process.exit(0);",
    "})();",
  ].join("\n"));
  const r = await kernel.start("bun", ["run", "fetch-blocked.ts"], { cwd: APP, env: ENV, capture: true });
  const o = (r.stdout || "") + (r.stderr || "");
  if (LIVE) console.log(o);
  const m = o.match(/FETCHFAIL:(\{.*\})/);
  const got = m ? JSON.parse(m[1]) : {};
  console.log("  ->", JSON.stringify(got).slice(0, 300));
  if (!m && r.stderr) console.log("  stderr:", r.stderr.trim().slice(0, 800));
  ok(got.threw === true, "a fetch that cannot be sent rejects");
  ok(got.name === "TypeError", "…still as a TypeError, which is what fetch's callers branch on: " + got.name);
  ok(/browser tab/.test(got.msg || ""), "…and the message says who made the decision, rather than leaving two words of nothing");
  ok(/Access-Control-Allow-Origin/.test(got.msg || ""), "…names the CORS header the origin would have to send");
  ok(/host is unreachable/.test(got.msg || ""), "…and names the other cause too, since the browser will not say which it was");
  ok(/127\.0\.0\.1:1/.test(got.msg || ""), "…and quotes the URL, so the line is actionable without a debugger");
  ok(got.cause !== null, "…keeping the browser's own error as `cause` for anyone who wants the original");
}

// 13) The surface a browser cannot provide, inside a real process.
//
// scripts/spike-bun-offline.mjs asserts the messages and drives the loader over
// host Node's fs, but it cannot show the thing that actually matters here: that a
// real `require()` of a real prebuilt addon, inside a guest process, off the Wasm
// VFS, produces the message rather than the old `SyntaxError: Invalid or
// unexpected token`. That is the most common hard failure a Node project meets in
// the browser, so it is proven on the kernel and not only in a unit test.
console.log("\n== bun run addon.ts (.node addon + the infeasible Bun members, in-VM) ==");
{
  // A package shaped like the real thing: a JS entry that requires its prebuilt
  // binary, the way bcrypt, sharp and better-sqlite3 all do. The bytes are a
  // genuine ELF header — this is the file the loader used to read as UTF-8.
  write("node_modules/bcrypt/package.json", JSON.stringify({ name: "bcrypt", version: "5.1.1", main: "bcrypt.js" }));
  write("node_modules/bcrypt/bcrypt.js", "module.exports = require('./lib/binding/napi-v3/bcrypt_lib.node');\n");
  kernel.mkdirp(APP + "/node_modules/bcrypt/lib/binding/napi-v3");
  kernel.writeFile(
    APP + "/node_modules/bcrypt/lib/binding/napi-v3/bcrypt_lib.node",
    new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0x3e, 0]),
  );
  write("addon.ts", [
    "const r: any = {};",
    "const grab = (fn: () => unknown) => { try { fn(); return 'DID NOT THROW'; } catch (e: any) { return String((e && e.message) || e); } };",
    // The transitive path: application code requires the package, the package
    // requires its own binary.
    "r.transitive = grab(() => require('bcrypt'));",
    "r.direct = grab(() => require('./node_modules/bcrypt/lib/binding/napi-v3/bcrypt_lib.node'));",
    // node-gyp-build and friends resolve the path themselves and call this.
    "r.dlopenType = typeof (process as any).dlopen;",
    "r.dlopen = grab(() => (process as any).dlopen({ exports: {} }, '/app/node_modules/bcrypt/lib/binding/napi-v3/bcrypt_lib.node'));",
    // A few of the Bun members, through the global the kernel really installed.
    "r.udp = grab(() => (Bun as any).udpSocket({}));",
    // Bun.connect returns a promise (in Bun too), so the refusal arrives as a
    // rejection rather than a throw. No top-level await: this file requires, so it
    // compiles as CommonJS, where a TLA is a syntax error.
    "const connectRefusal = (Bun as any).connect({ hostname: 'example.com', port: 5432 }).then(() => 'DID NOT REJECT', (e: any) => String((e && e.message) || e));",
    "r.sql = grab(() => new (Bun as any).SQL('postgres://user@host/db'));",
    "r.peek = grab(() => (Bun as any).peek(Promise.resolve(1)));",
    "r.ffi = grab(() => new (require('bun:ffi').JSCallback)(() => {}));",
    "r.pty = grab(() => (Bun as any).spawn({ cmd: ['echo', 'hi'], terminal: true }));",
    "connectRefusal.then((msg: string) => { r.connect = msg; console.log('ADDONRESULT:' + JSON.stringify(r)); });",
  ].join("\n"));
  const run = await kernel.start("bun", ["run", "addon.ts"], { cwd: APP, env: ENV, capture: true });
  if (run.stderr) console.log("  stderr:", run.stderr.trim());
  const m = (run.stdout || "").match(/ADDONRESULT:(\{.*\})/);
  const r = m ? JSON.parse(m[1]) : {};
  console.log("  ->", JSON.stringify((r.transitive || "").slice(0, 120)) + "…", "exit", run.code);
  ok(run.code === 0 && !!m, "addon.ts exits 0 and reports a result");
  ok(/Cannot load the native addon/.test(r.transitive || ""), "require('bcrypt') inside a real process reports the native addon, not a parse error");
  ok(!/SyntaxError|Invalid or unexpected token/.test(r.transitive || ""), "…the binary is no longer read as UTF-8 and compiled (the old symptom)");
  ok(/bcryptjs/.test(r.transitive || ""), "…and the message names the substitute that works in Vivari");
  ok(/Cannot load the native addon/.test(r.direct || ""), "requiring the .node file directly says the same thing");
  ok(r.dlopenType === "function", "process.dlopen exists (node-gyp-build calls it directly instead of require-ing)");
  ok(/Cannot load the native addon/.test(r.dlopen || ""), "…and throws the same message rather than 'process.dlopen is not a function'");
  ok(/no UDP in a browser/.test(r.udp || ""), "Bun.udpSocket throws the sandbox message through the really-installed Bun global");
  // Bun.connect no longer refuses the API, only the destination: an outside host
  // is impossible, a host inside the VM is ordinary (spike-bun-socket covers the
  // working half with two real processes).
  ok(/no raw TCP to the outside world/.test(r.connect || ""), "Bun.connect refuses an OUTSIDE host, naming the wall: " + JSON.stringify((r.connect || "").slice(0, 60)));
  ok(/PostgreSQL wire protocol/.test(r.sql || "") && /bun:sqlite/.test(r.sql || ""), "Bun.SQL(postgres://…) points at bun:sqlite");
  ok(/engine's internal/.test(r.peek || ""), "Bun.peek explains that settled-promise state is engine-internal");
  ok(/dlopen\(3\)/.test(r.ffi || ""), "bun:ffi JSCallback (absent entirely before) throws the FFI message");
  ok(/not implemented in the Vivari shim/.test(r.pty || ""), "Bun.spawn({terminal:true}) is reported as NOT IMPLEMENTED, not as impossible");
}

// 14) `bun build --compile` in the VM: it used to write JavaScript under the name
// the user expected a native executable at, and report success.
console.log("\n== bun build --compile / bun build (in-VM) ==");
{
  write("buildme.ts", "const n: number = 7;\nconsole.log('built ' + n);\n");
  const compiled = await kernel.start("bun", ["build", "buildme.ts", "--compile", "--outfile=buildme"], { cwd: APP, env: ENV, capture: true });
  const cout = (compiled.stdout || "") + (compiled.stderr || "");
  ok(compiled.code === 1 && /--compile is not supported in Vivari/.test(cout), "bun build --compile fails loudly in the VM");
  ok(!kernel.exists(APP + "/buildme"), "…and writes nothing under the executable's name");
  const plain = await kernel.start("bun", ["build", "buildme.ts", "--outfile=buildme.js"], { cwd: APP, env: ENV, capture: true });
  ok(plain.code === 0 && kernel.exists(APP + "/buildme.js"), "an ordinary bun build still transpiles to its --outfile");
}

// 15) `bun test` CLI flags, in the VM. The offline tier proves the PARSER over a
// scratch directory with no kernel; this proves the parsed values reach the runner
// and change which tests run — the seam between /bin/bun.js and the bun:test module
// only exists inside a process, because __run() is called on the module the guest's
// own require() returned.
console.log("\n== bun test flags (-t / --bail / --timeout / --reporter=junit) ==");
{
  const TESTDIR = "flags";
  write(TESTDIR + "/api.test.ts", [
    "import { test, describe, expect } from 'bun:test';",
    "describe('auth', () => {",
    "  test('login', () => { expect(1).toBe(1); });",
    "  test('logout', () => { expect(2).toBe(2); });",
    "});",
    "test('health', () => { expect(3).toBe(3); });",
  ].join("\n"));
  write(TESTDIR + "/slow.test.ts", [
    "import { test } from 'bun:test';",
    "test('sleeps', async () => { await new Promise((r) => setTimeout(r, 400)); });",
  ].join("\n"));
  write(TESTDIR + "/failing.test.ts", [
    "import { test } from 'bun:test';",
    "test('f1', () => { throw new Error('one'); });",
    "test('f2', () => { throw new Error('two'); });",
    "test('f3', () => {});",
  ].join("\n"));
  const runIn = (dir, args) => kernel.start("bun", ["test", ...args], { cwd: APP + "/" + dir, env: ENV, capture: true });

  const filtered = await runIn(TESTDIR, ["api", "-t", "log"]);
  const fout = (filtered.stdout || "") + (filtered.stderr || "");
  if (filtered.code !== 0) console.log(fout);
  // A positional is a FILENAME filter (Bun's semantics), and -t is a regex over
  // the full "describe > test" label. Both used to be dropped on the floor.
  ok(filtered.code === 0 && /2 pass/.test(fout), "-t 'log' selects the two auth tests");
  ok(/1 filtered out/.test(fout), "…and the health test is reported as filtered out, not silently gone");
  ok(!/api\.test/.test(fout) === false && !/slow\.test/.test(fout), "the positional filtered the FILE set down to api.test.ts");

  const timedOut = await runIn(TESTDIR, ["slow", "--timeout=50"]);
  const tout = (timedOut.stdout || "") + (timedOut.stderr || "");
  ok(timedOut.code === 1 && /timed out after 50ms/.test(tout), "--timeout is enforced on a real in-VM async test");

  const bailed = await runIn(TESTDIR, ["failing", "--bail"]);
  const bout = (bailed.stdout || "") + (bailed.stderr || "");
  ok(bailed.code === 1 && /Bailed out after 1 failure/.test(bout), "--bail stops the run at the first failure");
  ok(!/f2/.test(bout), "…and the second failing test never ran");

  const junit = await runIn(TESTDIR, ["api", "--reporter=junit", "--reporter-outfile=out.xml"]);
  ok(junit.code === 0, "--reporter=junit exits 0");
  const xml = kernel.exists(APP + "/" + TESTDIR + "/out.xml") ? kernel.readFile(APP + "/" + TESTDIR + "/out.xml") : "";
  const xmlText = typeof xml === "string" ? xml : Buffer.from(xml || "").toString();
  ok(/<testsuites name="bun test" tests="3"/.test(xmlText) && /classname="auth"/.test(xmlText),
    "…and wrote a JUnit file into the VFS");

  const unknown = await runIn(TESTDIR, ["--coverage"]);
  ok(unknown.code === 1 && /--coverage is not implemented/.test((unknown.stdout || "") + (unknown.stderr || "")),
    "an unimplemented flag is refused by name rather than dropped");
}

// 16) mock.module() against the REAL module loader. This cannot be proven offline:
// it edits `Module._cache` in packages/runtime/module.js, and the thing that has to
// see the edit is a later `require()`/`import` going through that same loader with
// its own resolution rules (extensionless specifiers, .ts resolution, the ESM→CJS
// compile). Node's own loader would answer differently on every one of those.
console.log("\n== bun test: mock.module over the module loader ==");
{
  const D = "mocks";
  write(D + "/dep.ts", "export const greet = (): string => 'real';\nexport const n: number = 1;\n");
  write(D + "/uses-dep.ts", "import { greet } from './dep';\nexport const call = (): string => greet();\n");
  write(D + "/m.test.ts", [
    "import { test, expect, mock } from 'bun:test';",
    // The specifier resolves relative to THIS FILE, not the process cwd — which is
    // why the runner is told which file it is loading. A cwd-relative resolve would
    // silently mock the wrong module for any test outside the project root, and
    // `bun test` is normally run from the project root.
    "mock.module('./dep', () => ({ greet: () => 'mocked', n: 99 }));",
    "test('a dynamic import sees the mock', async () => {",
    "  const dep = await import('./dep');",
    "  expect(dep.greet()).toBe('mocked');",
    "  expect(dep.n).toBe(99);",
    "});",
    // The realistic shape: the module UNDER TEST imports the dependency, and is
    // itself loaded after the mock is registered.
    "test('a module loaded afterwards gets the mocked dependency', async () => {",
    "  const { call } = await import('./uses-dep');",
    "  expect(call()).toBe('mocked');",
    "});",
    "test('a builtin is refused loudly, not silently unmocked', async () => {",
    "  let msg = '';",
    "  try { mock.module('node:os', () => ({ platform: () => 'vivari' })); } catch (e) { msg = String(e && e.message); }",
    "  expect(msg).toContain('cannot mock a builtin');",
    "  const os = await import('node:os');",
    "  expect(os.platform()).not.toBe('vivari');",
    "});",
    "test('an unresolvable specifier throws naming the file it resolved from', () => {",
    "  let msg = '';",
    "  try { mock.module('./no-such-module', () => ({})); } catch (e) { msg = String(e && e.message); }",
    "  expect(msg).toContain('could not resolve it from');",
    "  expect(msg).toContain('m.test.ts');",
    "});",
  ].join("\n"));
  const r = await kernel.start("bun", ["test", "m.test.ts"], { cwd: APP + "/" + D, env: ENV, capture: true });
  const o = (r.stdout || "") + (r.stderr || "");
  if (r.code !== 0 || LIVE) console.log(o);
  ok(r.code === 0 && /4 pass/.test(o) && /0 fail/.test(o), "mock.module replaces a module for a later import, and is loud when it cannot");
}

// 17) File-backed snapshots against the REAL Wasm VFS. The offline tier drives the
// same code over node:fs; this is the tier that proves the __snapshots__ directory
// is created and the .snap file written and re-read through the Atomics syscall
// bridge, and that a second `bun test` process (a fresh runtime, a cold cache)
// matches what the first one wrote.
console.log("\n== bun test: file-backed snapshots through the VFS ==");
{
  const D = "snaps";
  write(D + "/s.test.ts", [
    "import { test, describe, expect } from 'bun:test';",
    "describe('outer', () => {",
    "  test('shape', () => { expect({ a: 1, b: ['x'] }).toMatchSnapshot(); });",
    "});",
    "test('scalar', () => { expect(42).toMatchSnapshot(); });",
  ].join("\n"));
  const first = await kernel.start("bun", ["test", "s.test.ts"], { cwd: APP + "/" + D, env: ENV, capture: true });
  const fo = (first.stdout || "") + (first.stderr || "");
  if (first.code !== 0) console.log(fo);
  ok(first.code === 0 && /snapshots: \+2 added/.test(fo), "the first run creates two snapshots");
  const snapPath = APP + "/" + D + "/__snapshots__/s.test.ts.snap";
  ok(kernel.exists(snapPath), "…and the __snapshots__ directory + .snap file really exist in the VFS");
  // Read defensively: if the write regressed, the whole remaining section should
  // report failed CHECKS rather than crash the spike on an ENOENT.
  let raw = null;
  try { raw = kernel.readFile(snapPath); } catch { /* reported by the checks below */ }
  const snap = typeof raw === "string" ? raw : Buffer.from(raw || "").toString();
  // Byte-for-byte what real bun 1.3.6 writes, including the header, the SPACE-joined
  // describe key and the sorted keys. A file with exactly these bytes was handed to
  // a real `bun test`, which read it and passed.
  ok(snap === '// Bun Snapshot v1, https://bun.sh/docs/test/snapshots\n\n' +
    'exports[`outer shape 1`] = `\n{\n  "a": 1,\n  "b": [\n    "x",\n  ],\n}\n`;\n\n' +
    'exports[`scalar 1`] = `42`;\n',
    "…in Bun's exact format\n     got: " + JSON.stringify(snap));
  const second = await kernel.start("bun", ["test", "s.test.ts"], { cwd: APP + "/" + D, env: ENV, capture: true });
  const so = (second.stdout || "") + (second.stderr || "");
  ok(second.code === 0 && !/added/.test(so), "a second process matches the stored snapshots without rewriting them");
  // Change the value: the stored snapshot must now fail, or a snapshot test proves
  // nothing at all.
  write(D + "/s.test.ts", [
    "import { test, describe, expect } from 'bun:test';",
    "describe('outer', () => {",
    "  test('shape', () => { expect({ a: 2, b: ['x'] }).toMatchSnapshot(); });",
    "});",
    "test('scalar', () => { expect(42).toMatchSnapshot(); });",
  ].join("\n"));
  const changed = await kernel.start("bun", ["test", "s.test.ts"], { cwd: APP + "/" + D, env: ENV, capture: true });
  const co = (changed.stdout || "") + (changed.stderr || "");
  ok(changed.code === 1 && /did not match/.test(co), "a changed value fails against the stored snapshot");
  const updated = await kernel.start("bun", ["test", "s.test.ts", "-u"], { cwd: APP + "/" + D, env: ENV, capture: true });
  ok(updated.code === 0, "-u rewrites it");
  // …and the CI guard, which is the whole reason a snapshot run can be trusted.
  const inCi = await kernel.start("bun", ["test", "s.test.ts", "-t", "scalar"], {
    cwd: APP + "/" + D, env: { ...ENV, CI: "true" }, capture: true,
  });
  ok(inCi.code === 0, "under CI, matching an EXISTING snapshot is fine");
  write(D + "/new.test.ts", "import { test, expect } from 'bun:test';\ntest('fresh', () => { expect({ q: 1 }).toMatchSnapshot(); });\n");
  const ciCreate = await kernel.start("bun", ["test", "new.test.ts"], {
    cwd: APP + "/" + D, env: { ...ENV, CI: "true" }, capture: true,
  });
  const cco = (ciCreate.stdout || "") + (ciCreate.stderr || "");
  ok(ciCreate.code === 1 && /disabled in CI environments/.test(cco), "…but CREATING one under CI fails, exactly as Bun does");
  ok(!kernel.exists(APP + "/" + D + "/__snapshots__/new.test.ts.snap"), "…and no file is written");
}

// 18) `.only` under CI, in the VM. The guard has to fire at module LOAD time (that
// is when a test file registers its cases), so it is the loader path that has to
// surface it — a throw swallowed there would leave a green run over zero tests,
// which is the exact failure the guard exists to prevent.
console.log("\n== bun test: .only is refused under CI ==");
{
  const D = "onlyci";
  write(D + "/o.test.ts", [
    "import { test } from 'bun:test';",
    "test.only('focused', () => {});",
    "test('other', () => {});",
  ].join("\n"));
  const inCi = await kernel.start("bun", ["test", "o.test.ts"], { cwd: APP + "/" + D, env: { ...ENV, CI: "true" }, capture: true });
  const co = (inCi.stdout || "") + (inCi.stderr || "");
  ok(inCi.code === 1 && /\.only is disabled in CI environments/.test(co), "test.only under CI fails the run instead of narrowing it");
  const local = await kernel.start("bun", ["test", "o.test.ts"], { cwd: APP + "/" + D, env: ENV, capture: true });
  const lo = (local.stdout || "") + (local.stderr || "");
  ok(local.code === 0 && /1 pass/.test(lo), "…and without CI it focuses the run as usual");
}

// 19) Bun.build — a REAL bundle, in the VM, that runs.
//
// This is where the load-bearing proof of Phase 5B lives, and the offline tier
// cannot stand in for it. scripts/spike-bun-offline.mjs drives the same bundler
// over HOST Node's fs with the shipped resolver, which pins the option policy and
// the codegen; what only this tier can show is the part that has burned this
// project before — the graph walk reading the real Wasm VFS across the Atomics
// bridge, resolving a real node_modules tree, and producing a file that a second
// real process then EXECUTES and gets the right answer from. A bundler that
// bundles the wrong files still "succeeds"; running the output is the only check
// that can tell the difference.
console.log("\n== bun build: a real multi-module bundle, run in-VM ==");
{
  write("bundle/src/index.ts", [
    'import { shout } from "./greet";',
    'import cfg from "./cfg.json";',
    'import { pad } from "leftpad";',
    'import { VERSION } from "./nested/deep";',
    "const line: string = pad(shout(cfg.who), 14) + VERSION;",
    "export const line2 = line;",
    "console.log('BUNDLED:' + line);",
  ].join("\n"));
  write("bundle/src/greet.ts", 'export function shout(who: string): string { return ("hi " + who).toUpperCase(); }');
  write("bundle/src/nested/deep.ts", 'export const VERSION: string = "-v1";');
  write("bundle/src/cfg.json", JSON.stringify({ who: "vivari" }));
  // A genuine npm-shaped dependency in the project's node_modules: package.json
  // "main", resolved by the runtime's own resolver, not by a special case.
  write("bundle/node_modules/leftpad/package.json", JSON.stringify({ name: "leftpad", version: "1.0.0", main: "lib/index.js" }));
  write("bundle/node_modules/leftpad/lib/index.js", 'exports.pad = function (s, n) { while (s.length < n) s = "." + s; return s; };');

  const BUNDLE = APP + "/bundle";
  const bEnv = { ...ENV, PWD: BUNDLE };
  const built = await kernel.start(
    "bun",
    ["build", "src/index.ts", "--outdir=dist", "--target=node", "--format=cjs", "--root=src"],
    { cwd: BUNDLE, env: bEnv, capture: true },
  );
  if (built.stderr) console.log("  stderr:", built.stderr.trim());
  ok(built.code === 0, "bun build over the Wasm VFS exits 0");
  ok(/wrote .*dist\/index\.js/.test(built.stdout || ""), "…reporting the file it wrote");
  ok(/not identical to real bun build/.test(built.stdout || ""), "…and saying out loud that the bytes are not Bun's");
  ok(kernel.exists(BUNDLE + "/dist/index.js"), "…and the bundle is a real file in the VFS");

  // The four modules really are in there — a bundler that quietly emitted only the
  // entry would still have written a file and exited 0.
  const bundleText = String(kernel.readFile(BUNDLE + "/dist/index.js"));
  for (const part of ["greet.ts", "cfg.json", "leftpad/lib/index.js", "nested/deep.ts"]) {
    ok(bundleText.includes(part), `the bundle contains ${part} (the graph was walked, not just the entry)`);
  }

  // THE check. Delete the sources AND the dependency first, so the run cannot
  // accidentally succeed by re-reading them: what executes has to be the bundle
  // and nothing else. (This is not paranoia — a bundler that emitted `require()`
  // calls instead of inlining the modules would pass every other check here.)
  for (const gone of [
    "/src/index.ts", "/src/greet.ts", "/src/cfg.json", "/src/nested/deep.ts",
    "/node_modules/leftpad/lib/index.js", "/node_modules/leftpad/package.json",
  ]) kernel.unlink(BUNDLE + gone);
  const ran = await kernel.start("bun", ["run", "dist/index.js"], { cwd: BUNDLE, env: bEnv, capture: true });
  if (ran.stderr) console.log("  stderr:", ran.stderr.trim());
  console.log("  ->", JSON.stringify((ran.stdout || "").trim()));
  ok(ran.code === 0, "the bundle runs as an ordinary program");
  // "HI VIVARI" is 9 characters, left-padded to 14, then the nested module's
  // suffix — a value no single module in the graph could have produced alone.
  ok(/BUNDLED:\.{5}HI VIVARI-v1/.test(ran.stdout || ""), "…and computes the answer all four modules had to agree on");
}

console.log("\n== bun build: esm output, and the loud refusals, in-VM ==");
{
  const BUNDLE = APP + "/bundle";
  const bEnv = { ...ENV, PWD: BUNDLE };
  // ESM output is importable, not merely runnable: a second module in the VM does
  // a real `import` of it and reads the re-exported binding.
  write("bundle/src2/lib.ts", 'export const twice = (n: number): number => n * 2;\nexport default "lib";');
  const esm = await kernel.start("bun", ["build", "src2/lib.ts", "--outdir=dist2", "--root=src2", "--target=node"], { cwd: BUNDLE, env: bEnv, capture: true });
  if (esm.stderr) console.log("  stderr:", esm.stderr.trim());
  ok(esm.code === 0 && kernel.exists(BUNDLE + "/dist2/lib.js"), "an esm-format build writes its output");
  write("bundle/use-esm.ts", [
    'import lib, { twice } from "./dist2/lib.js";',
    "console.log('ESM:' + twice(21) + ':' + lib);",
  ].join("\n"));
  const used = await kernel.start("bun", ["run", "use-esm.ts"], { cwd: BUNDLE, env: bEnv, capture: true });
  if (used.stderr) console.log("  stderr:", used.stderr.trim());
  ok(/ESM:42:lib/.test(used.stdout || ""), "…and another module can import its named + default exports");

  // The refusals, in the VM rather than only as unit-tested strings. `--minify` is
  // the one that matters most: a build that accepted it, ignored it and reported
  // success is the single outcome this subsystem exists to prevent.
  const minified = await kernel.start("bun", ["build", "src2/lib.ts", "--minify", "--outfile=min.js"], { cwd: BUNDLE, env: bEnv, capture: true });
  const mout = (minified.stdout || "") + (minified.stderr || "");
  ok(minified.code === 1 && /minify/.test(mout) && /not implemented in the Vivari shim/.test(mout), "bun build --minify fails loudly, naming minify");
  ok(!kernel.exists(BUNDLE + "/min.js"), "…and writes nothing at all (no half-built artifact under the name you asked for)");
  const split = await kernel.start("bun", ["build", "src2/lib.ts", "--splitting", "--outdir=d3"], { cwd: BUNDLE, env: bEnv, capture: true });
  ok(split.code === 1 && /splitting/.test((split.stdout || "") + (split.stderr || "")), "…so does --splitting");
  const smap = await kernel.start("bun", ["build", "src2/lib.ts", "--sourcemap", "--outdir=d3"], { cwd: BUNDLE, env: bEnv, capture: true });
  ok(smap.code === 1 && /sourcemap/.test((smap.stdout || "") + (smap.stderr || "")), "…and --sourcemap");

  // No destination: Bun prints the bundle. Proves the artifact's .text() works in
  // a guest process and that stdout is the fallback rather than a silent no-op.
  const printed = await kernel.start("bun", ["build", "src2/lib.ts", "--target=node"], { cwd: BUNDLE, env: bEnv, capture: true });
  ok(printed.code === 0 && /__vv_def\(/.test(printed.stdout || ""), "bun build with no --outfile/--outdir prints the bundle to stdout");
}

console.log("\n== Bun.build + Bun.plugin from inside a guest process ==");
{
  const BUNDLE = APP + "/bundle";
  const bEnv = { ...ENV, PWD: BUNDLE };
  // The programmatic API, exercised by real Bun code in a real process: the
  // artifact shape, a build plugin, and a runtime plugin changing what require()
  // returns in the very process that registered it.
  write("bundle/api.ts", [
    // `export {}` makes this an ES module, which is what licenses the top-level
    // `await` below: the loader compiles a CJS entry with a plain (non-async)
    // wrapper, so TLA is an ESM-only affordance here (see module.js).
    "export {};",
    "const r: any = {};",
    'const res = await Bun.build({ entrypoints: ["./src2/lib.ts"], target: "node", format: "cjs", root: "./src2" });',
    "r.success = res.success;",
    "r.logs = res.logs.map((l: any) => l.level + ': ' + l.message);",
    "r.count = res.outputs.length;",
    "r.path = res.outputs[0] && res.outputs[0].path;",
    "r.kind = res.outputs[0] && res.outputs[0].kind;",
    "r.hash = res.outputs[0] && res.outputs[0].hash;",
    // Blob read protocol over the real runtime (a Uint8Array from a guest realm).
    "r.text = res.outputs[0] ? (await res.outputs[0].text()).length : 0;",
    "r.bytesRoundTrip = res.outputs[0] ? new TextDecoder().decode(await res.outputs[0].bytes()) === (await res.outputs[0].text()) : false;",
    "r.bufferRoundTrip = res.outputs[0] ? new TextDecoder().decode(new Uint8Array(await res.outputs[0].arrayBuffer())) === (await res.outputs[0].text()) : false;",
    // A build plugin, awaited, inside the VM.
    "const p = await Bun.build({",
    '  entrypoints: ["./plugged.ts"], target: "node", format: "cjs",',
    "  plugins: [{ name: 'vv', setup(b: any) {",
    "    b.onResolve({ filter: /^cfg$/ }, () => ({ path: '/cfg', namespace: 'v' }));",
    "    b.onLoad({ filter: /.*/, namespace: 'v' }, async () => ({ contents: JSON.stringify({ n: 5 }), loader: 'json' }));",
    "  } }],",
    "});",
    "r.plugged = p.success;",
    "r.pluggedText = p.success ? (await p.outputs[0].text()).includes('\"n\":5') : false;",
    // A rejected option must throw here too, not just from the CLI.
    "try { await Bun.build({ entrypoints: ['./src2/lib.ts'], minify: true }); r.minify = 'DID NOT THROW'; }",
    "catch (e: any) { r.minify = String(e.message); }",
    // Runtime plugin: rewrites require() in this process.
    "Bun.plugin({ name: 'rt', setup(b: any) {",
    "  b.onResolve({ filter: /^inline:num$/ }, () => ({ path: '/n', namespace: 'inline' }));",
    "  b.onLoad({ filter: /.*/, namespace: 'inline' }, () => ({ contents: 'module.exports = 99;', loader: 'js' }));",
    "} });",
    // Through a dynamic import (this file is ESM, so it has no `require`), which
    // still lands in the same Module._load funnel the plugin seam hooks.
    "r.runtimePlugin = (await import('inline:num')).default;",
    "console.log('BUILDAPI:' + JSON.stringify(r));",
  ].join("\n"));
  write("bundle/plugged.ts", 'import cfg from "cfg"; export const n = cfg.n;');

  const run = await kernel.start("bun", ["run", "api.ts"], { cwd: BUNDLE, env: bEnv, capture: true });
  if (run.stderr) console.log("  stderr:", run.stderr.trim().slice(0, 800));
  const m = (run.stdout || "").match(/BUILDAPI:(\{.*\})/);
  const r = m ? JSON.parse(m[1]) : {};
  console.log("  ->", JSON.stringify(r).slice(0, 300));
  ok(run.code === 0 && !!m, "api.ts exits 0 and reports a result");
  ok(r.success === true, "Bun.build() succeeds inside a guest process");
  if (r.success !== true) console.log("  build logs:", (r.logs || []).join("\n              "));
  ok(r.count === 1 && r.path === "./lib.js" && r.kind === "entry-point", "…returning one entry-point artifact at the path naming produced");
  ok(/^[0-9a-f]{16}$/.test(r.hash || ""), "…with a content hash");
  ok(r.text > 0 && r.bytesRoundTrip === true && r.bufferRoundTrip === true, "…whose Blob read protocol round-trips inside the guest realm (.bytes()/.arrayBuffer() decode back to .text())");
  ok(r.plugged === true && r.pluggedText === true, "a build plugin's virtual module really lands in the output, in the VM");
  ok(/minify/.test(r.minify || "") && /not implemented/.test(r.minify || ""), "a rejected option throws from Bun.build itself, not only from the CLI");
  ok(r.runtimePlugin === 99, "Bun.plugin() rewires require() inside the running process (the module-loader seam)");
}

// 20) The module clauses the type stripper used to corrupt, and Bun.Transpiler's
// scan family running inside a real process.
//
// This is the tier that matters for the stripper fixes. The offline tier calls
// transpileTypeScript() and inspects a STRING, so it can assert the output looks
// right but never that the module system accepts it — and the two worst bugs here
// were only visible at load: `import * as fs from "fs"` was rewritten to
// `import * ;` and died with "Cannot use import statement outside a module", and
// `export { a, b as c }` lost the rename, handing the importer `undefined` while
// the process still exited 0. A green string check and a broken program.
console.log("\n== bun run clauses.ts (module clauses survive the type stripper, in-VM) ==");
{
  write("dep.ts", ["const a: number = 1;", "const b: number = 2;", "export { a, b as renamed };"].join("\n"));
  write("clauses.ts", [
    "import * as path from 'node:path';",
    "import type { Nope } from './dep';",
    "import { renamed } from './dep';",
    "const out: string[] = [];",
    "out.push('join:' + path.join('a', 'b'));",
    "out.push('renamed:' + renamed);",
    "out.push('typeof-ns:' + typeof path);",
    "console.log('CLAUSES:' + JSON.stringify(out));",
  ].join("\n"));
  const r = await kernel.start("bun", ["run", "clauses.ts"], { cwd: APP, env: ENV, capture: true });
  const o = (r.stdout || "") + (r.stderr || "");
  const m = o.match(/CLAUSES:(\[.*\])/);
  const got = m ? JSON.parse(m[1]) : [];
  console.log("  ->", JSON.stringify(got), "exit", r.code);
  if (!m && r.stderr) console.log("  stderr:", r.stderr.trim().slice(0, 400));
  ok(r.code === 0, "a .ts file using `import * as ns` LOADS (it used to be rewritten to `import * ;`)");
  ok(got.includes("join:a/b"), "…and the namespace object is the real module");
  ok(got.includes("renamed:2"), "an `export { b as renamed }` rename survives — it used to arrive as undefined, exit 0");
  ok(got.includes("typeof-ns:object"), "…and `import type` next to them removed itself without stranding its `from`");
}

console.log("\n== bun run scan.ts (Bun.Transpiler.scan over a file read from the VFS) ==");
{
  write("sample.ts", [
    "import { readFileSync } from 'node:fs';",
    "import type { Unused } from './dep';",
    "const lazy = () => import('./dep');",
    "const r = require('./dep');",
    "const p = require.resolve('./dep');",
    "export const value = 1;",
    "export default readFileSync;",
  ].join("\n"));
  write("scan.ts", [
    "const src = require('fs').readFileSync('/app/sample.ts', 'utf8');",
    "const t = new Bun.Transpiler({ loader: 'ts' });",
    "const s = t.scan(src);",
    "const i = t.scanImports(src);",
    "const kinds = (l: any[]) => l.map((x: any) => x.kind + ':' + x.path);",
    "console.log('SCAN:' + JSON.stringify({ exports: s.exports, imports: kinds(s.imports), scanImports: kinds(i) }));",
  ].join("\n"));
  const r = await kernel.start("bun", ["run", "scan.ts"], { cwd: APP, env: ENV, capture: true });
  const o = (r.stdout || "") + (r.stderr || "");
  const m = o.match(/SCAN:(\{.*\})/);
  const got = m ? JSON.parse(m[1]) : null;
  console.log("  ->", JSON.stringify(got), "exit", r.code);
  if (!m && r.stderr) console.log("  stderr:", r.stderr.trim().slice(0, 400));
  ok(r.code === 0 && got, "scan.ts exits 0 and reports a result");
  ok(got && JSON.stringify(got.exports) === '["default","value"]', "exports are the ESM ones, sorted (`default` before `value`)");
  // The require/require.resolve split, proven against a real file rather than a
  // string literal in the spike — the two methods genuinely disagree.
  ok(got && got.imports.includes("require-resolve:./dep") && !got.imports.some((x) => x.startsWith("require-call:")), "scan() carries require.resolve and NOT require()");
  ok(got && got.scanImports.includes("require-call:./dep") && !got.scanImports.some((x) => x.startsWith("require-resolve:")), "scanImports() is the exact inverse");
  ok(got && got.imports.includes("dynamic-import:./dep") && got.imports.includes("import-statement:node:fs"), "both static and dynamic imports are reported");
  ok(got && !got.imports.some((x) => x.includes("Unused")), "the type-only import contributes nothing");
}

// 21) The four things a real process shows that a string check cannot: the bare
// `bun` module specifier resolving, top-level await in a file with no import or
// export, Bun.stdin as a readable Blob, and Bun.$ being lazy enough for its own
// modifiers to mean something.
//
// All four were found by writing the studio's Bun templates rather than by
// reading the shim — see scripts/spike-bun-templates.mjs, which runs those
// templates' shipped bytes.
console.log("\n== the bare `bun` module, top-level await, Bun.stdin, lazy Bun.$ ==");
{
  // `import { $ } from "bun"` is how Bun's own docs reach most of this surface,
  // and it used to fail with "Cannot find module 'bun'" while `Bun.$` worked.
  write(
    "bare-import.ts",
    [
      'import { $, file, write, version } from "bun";',
      'import * as ns from "bun";',
      "const same = ns.file === Bun.file && ns.$ === Bun.$;",
      'console.log("BARE:" + JSON.stringify({',
      "  fns: typeof $ + typeof file + typeof write,",
      "  version: typeof version,",
      "  same,",
      "  keys: Object.keys(ns).length > 50,",
      "  defaultIsBun: ns.default === Bun,",
      "}));",
    ].join("\n"),
  );
  const r = await kernel.start("bun", ["run", "bare-import.ts"], { cwd: APP, env: ENV, capture: true });
  const m = /BARE:(\{.*\})/.exec(r.stdout || "");
  const got = m ? JSON.parse(m[1]) : null;
  if (!got) console.log("  stderr:", (r.stderr || "").split("\n").slice(0, 3).join(" | "));
  ok(r.code === 0 && !!got, '`import { $ } from "bun"` resolves and runs');
  ok(got && got.fns === "functionfunctionfunction", "$, file and write all come through as functions");
  ok(got && got.same, "they are the SAME objects as the globals, not copies");
  ok(got && got.keys, "the namespace carries the whole Bun surface, not a curated subset");
  // Real Bun has NO default export from "bun". Ours does, because the loader gives
  // every builtin namespace a `default` for CJS interop, and it is the same object
  // the namespace already is. Asserted rather than glossed over: a caller writing
  // `import Bun from "bun"` gets something workable here and a TypeError under real
  // Bun, so the divergence is in the forgiving direction, but it IS a divergence.
  ok(got && got.defaultIsBun, "…plus an interop `default` (real Bun has none) that is the same object");
}
{
  // A script whose only module-level feature is a top-level await. ESM-ness is
  // decided by SYNTAX, so with no import or export this took the CJS path, got a
  // non-async wrapper and failed with "await is only valid in async functions and
  // the top level bodies of modules" — which names nothing the author can fix.
  write("tla.ts", ['const value: number = await Promise.resolve(7);', 'console.log("TLA:" + value);'].join("\n"));
  const r = await kernel.start("bun", ["run", "tla.ts"], { cwd: APP, env: ENV, capture: true });
  if (r.code !== 0) console.log("  stderr:", (r.stderr || "").split("\n")[0]);
  ok(r.code === 0 && /TLA:7/.test(r.stdout || ""), "top-level await runs in a file with no import or export");

  // The retry must not paper over a genuine syntax error, which would turn a
  // one-line parse failure into a confusing runtime one.
  write("broken.ts", "const x = ;\n");
  const bad = await kernel.start("bun", ["run", "broken.ts"], { cwd: APP, env: ENV, capture: true });
  ok(bad.code !== 0 && /SyntaxError/.test(bad.stderr || ""), "…and a real syntax error still fails as a syntax error");
}
{
  // `const input = await Bun.stdin.text()` is how every piped Bun script starts.
  // Bun.stdin stays a Node stream here (guest code reads it with .on("data")), so
  // the Blob readers are attached to that stream rather than replacing it.
  write("pipe.ts", ['const input: string = await Bun.stdin.text();', 'console.log("PIPE:" + input.trim().split("\\n").length + ":" + input.trim().replace(/\\n/g, ","));'].join("\n"));
  write("feed.txt", "one\ntwo\nthree\n");
  const r = await kernel.start("sh", ["-c", "cat feed.txt | bun run pipe.ts"], { cwd: APP, env: ENV, capture: true });
  if (r.code !== 0) console.log("  stderr:", (r.stderr || "").split("\n").slice(0, 3).join(" | "));
  ok(r.code === 0 && /PIPE:3:one,two,three/.test(r.stdout || ""), "Bun.stdin.text() drains a real pipe");
  // The readers are attached to the existing stream rather than replacing it, so
  // code already reading stdin with .on("data") / async iteration is unaffected.
  write("stdin-shape.ts", 'console.log("SHAPE:" + JSON.stringify({ on: typeof Bun.stdin.on, same: Bun.stdin === process.stdin, text: typeof Bun.stdin.text }));\n');
  const shape = await kernel.start("bun", ["run", "stdin-shape.ts"], { cwd: APP, env: ENV, capture: true });
  ok(/"on":"function"/.test(shape.stdout || "") && /"same":true/.test(shape.stdout || "") && /"text":"function"/.test(shape.stdout || ""), "…and it is still the same Node Readable, with .on() intact");
}
{
  // Bun.$ used to call exec() immediately and then attach .quiet()/.nothrow(),
  // which worked only because both flags are read later. .env()/.cwd() are read
  // at SPAWN time, so under that design they could not work at all — and were
  // simply absent. The ShellPromise is lazy now, so all four mean something.
  write(
    "shell.ts",
    [
      'import { $ } from "bun";',
      'await $`mkdir -p sub/dir`;',
      'const cwd = (await $`pwd`.cwd("sub/dir").text()).trim();',
      // Read back through a real process rather than `sh -c "echo $MARKER"`: the
      // in-VM sh does no variable expansion, so that would prove nothing.
      'const env = (await $`bun run show-marker.ts`.env({ ...process.env, MARKER: "from-env" }).text()).trim();',
      "const failed = await $`false`.nothrow().quiet();",
      "let threw = false;",
      "try { await $`false`.quiet(); } catch { threw = true; }",
      // A reader CAPTURES, so nothing reaches the terminal. Bun prints nothing for
      // `await $`echo …`.text()`, and this script prints no marker of its own, so
      // any occurrence in stdout is an echo that should not be there.
      "const captured = (await $`echo not-on-the-terminal`.text()).trim();",
      "const lines = [];",
      'for await (const line of $`echo a\\necho b`.lines()) lines.push(line);',
      'console.log("SHELL:" + JSON.stringify({ cwd, env, code: failed.exitCode, threw, lines, captured }));',
    ].join("\n"),
  );
  write("show-marker.ts", 'console.log(process.env.MARKER ?? "(unset)");\n');
  const r = await kernel.start("bun", ["run", "shell.ts"], { cwd: APP, env: ENV, capture: true });
  const m = /SHELL:(\{.*\})/.exec(r.stdout || "");
  const got = m ? JSON.parse(m[1]) : null;
  if (!got) console.log("  stderr:", (r.stderr || "").split("\n").slice(0, 3).join(" | "));
  ok(r.code === 0 && !!got, "the Bun.$ modifier script runs");
  ok(got && /sub\/dir$/.test(got.cwd), ".cwd() actually changes the child's directory");
  ok(got && got.env === "from-env", ".env() is applied to that command only");
  ok(got && got.code !== 0 && got.threw, ".nothrow() reports the code where the default throws");
  ok(got && got.lines.length === 2 && got.lines[0] === "a", ".lines() yields lines without the trailing empty one");
  // The leak this missed for a whole review cycle: `.text()` buffered the output AND
  // echoed it, so every capturing line in a script printed the raw output and then
  // printed whatever the script made of it. Invisible to an assertion that greps the
  // whole of stdout for the processed form — so assert the RAW form is absent.
  ok(got && got.captured === "not-on-the-terminal", ".text() returns the output");
  ok(!/not-on-the-terminal/.test((r.stdout || "").replace(/"captured":"[^"]*"/, "")), "…and does NOT also echo it to the terminal");
}

// Bun.sha / Bun.CSRF / Bun.dns / zstd through a real `bun run`. The offline tier
// covers the semantics; this tier covers the two things it structurally cannot:
// the digests come from the Rust/Wasm crypto codec rather than the host's
// OpenSSL, and blake2b256 — which Bun allows for CSRF and OpenSSL does not know
// by that name — only exists on this side.
console.log("\n== bun run crypto-surface.ts (sha, CSRF, dns, zstd) ==");
{
  write(
    "crypto-surface.ts",
    [
      // NIST FIPS 180-4's SHA-512/256 example, so the wasm codec is pinned to a
      // value from outside this repo.
      'const abc = Bun.sha("abc", "hex");',
      'const blake = Bun.CSRF.generate("s", { algorithm: "blake2b256", sessionId: "u" });',
      "const out = {",
      '  sha: abc,',
      '  shaBytes: Bun.sha("abc").length,',
      '  blakeOk: Bun.CSRF.verify(blake, { secret: "s", algorithm: "blake2b256", sessionId: "u" }),',
      '  blakeWrongSession: Bun.CSRF.verify(blake, { secret: "s", algorithm: "blake2b256", sessionId: "other" }),',
      '  prefetch: Bun.dns.prefetch("example.com", 443) === undefined,',
      '  stats: Bun.dns.getCacheStats().size,',
      "  dnsThrew: (() => { try { Bun.dns.lookup('example.com'); return false; } catch { return true; } })(),",
      "  zstdThrew: (() => { try { Bun.zstdCompressSync('x'); return false; } catch (e) { return /packages\\/codec/.test(e.message); } })(),",
      // node:zlib is the other half: the function exists, a feature detect takes
      // the branch, and now the branch compresses instead of explaining itself.
      "  brotli: (() => { const z = require('zlib'); const s = 'x'.repeat(200); return z.brotliDecompressSync(z.brotliCompressSync(Buffer.from(s))).toString() === s; })(),",
      "  gzipStillWorks: require('zlib').gunzipSync(require('zlib').gzipSync(Buffer.from('hi'))).toString(),",
      "};",
      'console.log("CRYPTO:" + JSON.stringify(out));',
    ].join("\n"),
  );
  const r = await kernel.start("bun", ["run", "crypto-surface.ts"], { cwd: APP, env: ENV, capture: true });
  const m = /CRYPTO:(\{.*\})/.exec(r.stdout || "");
  const got = m ? JSON.parse(m[1]) : null;
  if (!got) console.log("  stderr:", (r.stderr || "").split("\n").slice(0, 4).join(" | "));
  ok(r.code === 0 && !!got, "the crypto-surface script runs");
  ok(got && got.sha === "53048e2681941ef99b2e29b76b4c7dabe4c2d0c634fc6d46e0e2f13107e7af23", "Bun.sha through the wasm codec matches the NIST SHA-512/256 vector");
  ok(got && got.shaBytes === 32, "…and is 32 bytes raw");
  ok(got && got.blakeOk === true && got.blakeWrongSession === false, "CSRF with blake2b256 signs and binds the session (wasm-only algorithm)");
  ok(got && got.prefetch === true && got.stats === 0, "Bun.dns.prefetch is inert and the cache reports empty");
  ok(got && got.dnsThrew === true, "Bun.dns.lookup refuses");
  ok(got && got.zstdThrew === true, "Bun.zstdCompressSync names packages/codec rather than dying on undefined");
  ok(got && got.brotli === true, "node:zlib brotli round-trips inside Bun's runtime too");
  ok(got && got.gzipStillWorks === "hi", "…and gzip still round-trips beside it");
}

// ---------------------------------------------------------------------------
// Bun's Worker. Kernel tier only, and necessarily so: this needs a real thread
// host, and — more to the point — the bug it was written for is invisible
// without one. Guest code was getting the HOST's Worker constructor, which in a
// browser resolves the specifier against the Studio's origin instead of the VFS.
// The Node tier cannot see that, because Node has no global Worker for anything
// to leak; only a check on what the GUEST sees catches it.
// ---------------------------------------------------------------------------
console.log("\n== new Worker(): threads, messages and lifetimes ==");
{
  write("echo.worker.ts", [
    // TypeScript, `self`, and a bare `postMessage` — the shape Bun's own docs use.
    "declare var self: any;",
    "self.onmessage = (event: MessageEvent) => {",
    "  const n = (event.data as { n: number }).n;",
    "  postMessage({ doubled: n * 2, inWorker: Bun.isMainThread === false });",
    "};",
  ].join("\n"));
  write("quick.worker.ts", "postMessage('bye');\n");
  write("exit3.worker.ts", "process.exit(3);\n");
  write("boom.worker.ts", "throw new Error('worker blew up');\n");

  write("worker-surface.ts", [
    "const closeCode = (spec: string) => new Promise((resolve) => {",
    "  const wk = new Worker(spec);",
    "  wk.addEventListener('close', (e: any) => resolve(e.code));",
    "});",
    "const events: string[] = [];",
    "const worker = new Worker('./echo.worker.ts');",
    "worker.addEventListener('open', () => events.push('open'));",
    "worker.addEventListener('close', () => events.push('close'));",
    // Posted before 'open'. Bun promises these are queued, not dropped.
    "worker.postMessage({ n: 21 });",
    "const reply: any = await new Promise((r) => { worker.onmessage = (e: any) => r(e.data); });",
    "const threadId = worker.threadId;",
    "await worker.terminate();",
    "await new Promise((r) => setTimeout(r, 200));",
    // The file: URL form, straight out of Bun's documentation.
    "const viaUrl = new Worker(new URL('echo.worker.ts', 'file://' + import.meta.dir + '/').href);",
    "viaUrl.postMessage({ n: 5 });",
    "const urlReply: any = await new Promise((r) => { viaUrl.onmessage = (e: any) => r(e.data); });",
    "const terminated = await new Promise((r) => { viaUrl.addEventListener('close', (e: any) => r(e.code)); viaUrl.terminate(); });",
    "const missing: any = await new Promise((r) => { const bad = new Worker('./nope.ts'); bad.addEventListener('error', r); });",
    "const refuse = (spec: string) => { try { new Worker(spec); return 'no throw'; } catch (e: any) { return e.message; } };",
    "const out = {",
    "  doubled: reply.doubled,",
    "  inWorker: reply.inWorker,",
    "  mainIsMain: Bun.isMainThread,",
    "  threadId: threadId > 0,",
    "  events: events.join(','),",
    "  urlForm: urlReply.doubled,",
    "  terminated,",
    "  natural: await closeCode('./quick.worker.ts'),",
    "  exited: await closeCode('./exit3.worker.ts'),",
    "  threw: await closeCode('./boom.worker.ts'),",
    "  missing: missing.message,",
    "  blob: refuse('blob:whatever'),",
    "  http: refuse('https://example.com/w.js'),",
    "};",
    'console.log("WORKER:" + JSON.stringify(out));',
  ].join("\n"));

  const r = await kernel.start("bun", ["run", "worker-surface.ts"], { cwd: APP, env: ENV, capture: true });
  const m = /WORKER:(\{.*\})/.exec(r.stdout || "");
  const got = m ? JSON.parse(m[1]) : null;
  if (!got) console.log("  stderr:", (r.stderr || "").split("\n").slice(0, 4).join(" | "));
  ok(r.code === 0 && !!got, "the worker-surface script runs to completion");
  // The whole point: a real thread ran a TypeScript file FROM THE VFS. If the
  // host constructor were still in play there would be no reply at all.
  ok(got && got.doubled === 42, "a worker receives a message and replies");
  ok(got && got.inWorker === true && got.mainIsMain === true, "Bun.isMainThread is false inside the worker and true outside");
  ok(got && got.threadId === true, "the worker reports a real threadId");
  ok(got && got.events === "open,close", "'open' then 'close' both fire, in that order");
  // Asserting the REPLY, not merely that nothing threw: a dropped pre-open
  // message would leave the promise pending and time out instead of failing here.
  ok(got && got.urlForm === 10, "the new URL(…, import.meta.url) form resolves against the VFS");
  ok(got && got.natural === 0, "a worker that just finishes closes with 0");
  ok(got && got.exited === 3, "process.exit(3) inside a worker arrives as close code 3");
  ok(got && got.threw === 1, "a worker that throws arrives as close code 1 (Bun would also emit 'error'; see bun-worker.js)");
  ok(got && got.terminated === 0, "terminate() reports 0, not the kernel's SIGTERM code");
  ok(got && /Worker script not found/.test(got.missing), "a script that fails to resolve emits 'error' rather than hanging");
  ok(got && /not implemented in the Vivari shim/.test(got.blob), "a blob: URL is refused by name: " + JSON.stringify((got && got.blob || "").slice(0, 60)));
  ok(got && /not supported in Vivari/.test(got.http), "an http: URL is refused as impossible, not merely missing");

  // unref() must actually release the parent: a ref'd worker with a live message
  // listener would hang this process, and the spike would time out rather than fail.
  write("unref.ts", [
    "const w = new Worker('./echo.worker.ts');",
    "w.unref();",
    'console.log("UNREF:done");',
  ].join("\n"));
  const u = await kernel.start("bun", ["run", "unref.ts"], { cwd: APP, env: ENV, capture: true });
  ok(u.code === 0 && /UNREF:done/.test(u.stdout || ""), "unref() lets the parent exit while a worker is still listening");

  // The leak this change closes, stated from the guest's side. Node has no global
  // Worker, so a `node` guest seeing one means the host's has leaked in.
  // bun:jsc through a real guest: the round-trip is proved offline against a
  // recording of the binary, but the module has to LOAD inside the VM too, and
  // the value has to survive a real Bun global rather than a test harness.
  write("jsc.ts", [
    'import { serialize, deserialize } from "bun:jsc";',
    "const cyc: any = { n: 1 }; cyc.self = cyc;",
    "const back: any = deserialize(serialize({ m: new Map([['k', new Date(1700000000000)]]), c: cyc, big: 7n }));",
    "console.log('JSC:' + [back.m instanceof Map, back.m.get('k').getTime(), back.c.self === back.c, back.big === 7n].join(','));",
    "console.log('SAB:' + Object.prototype.toString.call(serialize(1)));",
  ].join("\n"));
  const jsc = await kernel.start("bun", ["run", "jsc.ts"], { cwd: APP, env: ENV, capture: true });
  ok(/JSC:true,1700000000000,true,true/.test(jsc.stdout || ""), "bun:jsc round-trips a Map, a cycle and a BigInt inside the VM: " + ((jsc.stdout || "").match(/JSC:.*/) || [""])[0]);
  ok(/SAB:\[object SharedArrayBuffer\]/.test(jsc.stdout || ""), "and hands back a SharedArrayBuffer, as Bun does");

  write("node-side.js", 'console.log("NODEWORKER:" + typeof Worker);');
  const n = await kernel.start("node", ["node-side.js"], { cwd: APP, env: ENV, capture: true });
  ok(/NODEWORKER:undefined/.test(n.stdout || ""), "a node guest sees no global Worker, as in real Node — the host's does not leak through");
}

// ---------------------------------------------------------------------------
// 19) the realm the guest is handed, in a real process
//
// `Worker` above was one name, found by hand. This is the rest of the same
// problem — a browser Worker's global carries 228 names no Node or Bun process
// has, several of them capabilities — and it is asserted from INSIDE a running
// guest, which is the only place the answer counts.
//
// Node's global has none of those names, so this would pass on an empty sweep.
// scripts/process-worker.mjs plants them first (VV_PLANT_BROWSER_REALM), shaped
// like the browser's: some own, some inherited, some accessors. Reverting
// packages/runtime/realm.js turns every check below red.
// ---------------------------------------------------------------------------
{
  process.env.VV_PLANT_BROWSER_REALM = "1";
  const planted = ["importScripts", "indexedDB", "caches", "XMLHttpRequest", "location", "close", "OffscreenCanvas", "FileReader", "origin", "crossOriginIsolated", "addEventListener", "postMessage"];
  write("realm.ts", [
    // Bun HAS `addEventListener` and `postMessage`, so their absence is not the
    // question for a bun guest — whose they are is, and the two checks below ask
    // that directly. The planted host versions return "host:<name>".
    "const planted = " + JSON.stringify(planted.filter((n) => n !== "addEventListener" && n !== "postMessage")) + ";",
    "const seen = planted.filter((n) => typeof (globalThis as any)[n] !== 'undefined');",
    "console.log('LEAKED:' + JSON.stringify(seen));",
    "console.log('UA:' + navigator.userAgent);",
    "console.log('POST:' + typeof postMessage + ':' + JSON.stringify(postMessage('x')));",
    "console.log('LISTEN:' + typeof addEventListener + ':' + JSON.stringify(addEventListener('message', () => {})));",
    "let alerted = ''; try { alert('hi'); } catch (e) { alerted = (e as Error).message; }",
    "console.log('ALERT:' + alerted);",
    "console.log('KEPT:' + [typeof fetch, typeof crypto, typeof structuredClone, typeof self].join(','));",
  ].join("\n"));
  const r = await kernel.start("bun", ["run", "realm.ts"], { cwd: APP, env: ENV, capture: true });
  const out = r.stdout || "";
  ok(/LEAKED:\[\]/.test(out), "a bun guest sees none of the planted browser globals: " + (out.match(/LEAKED:.*/) || [""])[0]);
  ok(/UA:Bun\//.test(out), "navigator says Bun, not Chrome: " + (out.match(/UA:.*/) || [""])[0]);
  // Bun HAS these on its main thread; they must exist and do nothing, rather than
  // being the kernel's channel to this process.
  ok(/POST:function:undefined/.test(out), "postMessage is Bun's inert one, not the kernel's mailbox: " + (out.match(/POST:.*/) || [""])[0]);
  ok(/LISTEN:function:undefined/.test(out), "addEventListener is the guest's own, not the host's channel: " + (out.match(/LISTEN:.*/) || [""])[0]);
  ok(/ALERT:.*not implemented in the Vivari shim/.test(out), "alert() refuses by name instead of silently returning");
  ok(/KEPT:function,object,function,object/.test(out), "fetch/crypto/structuredClone/self survive the sweep: " + (out.match(/KEPT:.*/) || [""])[0]);

  write("realm-node.js", [
    "console.log('LEAKED:' + JSON.stringify(" + JSON.stringify(planted) + ".filter((n) => typeof globalThis[n] !== 'undefined')));",
    "console.log('UA:' + navigator.userAgent);",
    "console.log('BUNGLOBALS:' + [typeof postMessage, typeof addEventListener, typeof alert].join(','));",
  ].join("\n"));
  const rn = await kernel.start("node", ["realm-node.js"], { cwd: APP, env: ENV, capture: true });
  const outN = rn.stdout || "";
  ok(/LEAKED:\[\]/.test(outN), "a node guest sees none of them either: " + (outN.match(/LEAKED:.*/) || [""])[0]);
  ok(/UA:Node\.js\//.test(outN), "and its navigator says Node: " + (outN.match(/UA:.*/) || [""])[0]);
  ok(/BUNGLOBALS:undefined,undefined,undefined/.test(outN), "Bun's main-thread globals are Bun's alone — a node guest has none");
  delete process.env.VV_PLANT_BROWSER_REALM;
}


console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: all bun spike checks passed");
process.exit(failed ? 1 : 0);