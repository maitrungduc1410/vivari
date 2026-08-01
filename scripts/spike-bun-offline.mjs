// Offline spike (no kernel / no Wasm VFS / no network) for the pure-JS pieces of
// Bun support: the synchronous TS/JSX transform and the Bun global shim. Runs in
// plain Node so it can gate in the Wasm-free tier of scripts/run-spikes.mjs.
//
//   node scripts/spike-bun-offline.mjs

import { createRequire } from "node:module";
import { transpileTypeScript, maybeTranspileTypeScript } from "../packages/runtime/typescript-transform.js";
import {
  createBunRuntime,
  compileRoutes,
  matchRoute,
  encodeWsFrame,
  readWsFrame,
  toWsPayload,
  resolveServeError,
  BUN_VERSION,
  BUN_REVISION,
} from "../packages/runtime/builtins/bun.js";
import {
  BUN_PROGRAM,
  BUNX_PROGRAM,
  BUN_CLI_VERSION_FALLBACK,
} from "../packages/kernel-host/programs/bun.js";

const nodeRequire = createRequire(import.meta.url);

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  \u2713 " : "  \u2717 ") + msg);
  if (!cond) failed++;
};

// Compile a transpiled snippet in a sandbox and return the value it assigns to
// `globalThis.__r` (so we assert on runtime behaviour, not on exact output text).
function evalJs(code, setup = "") {
  const fn = new Function("exports", "module", "require", setup + "\n" + code);
  const module = { exports: {} };
  fn(module.exports, module, () => ({}));
  return module.exports;
}

console.log("== TS type-stripping ==");
{
  const src = `
    interface User { id: number; name: string }
    type ID = string | number;
    const greet = (u: User): string => "hi " + u.name;
    const n: number = 41;
    let arr: Array<number> = [1, 2, 3];
    function add<T extends number>(a: T, b: T): T { return (a + b) as T; }
    class Box<T> { readonly value!: T; constructor(public label: string, private v: T) { this.value = v; } get(): T { return this.v; } }
    const x = add(1, n);
    module.exports = { greet, x, arr, Box };
  `;
  const out = transpileTypeScript(src, "t.ts");
  ok(!/interface|:\s*User|Array<number>|extends number/.test(out), "types/interfaces/generics removed");
  const m = evalJs(out);
  ok(m.x === 42, "add<T>(1,41) === 42 after strip");
  ok(m.greet({ id: 1, name: "Bo" }) === "hi Bo", "arrow with return type runs");
  ok(Array.isArray(m.arr) && m.arr.length === 3, "annotated array literal preserved");
  const b = new m.Box("L", 7);
  ok(b.label === "L" && b.get() === 7, "class param properties + non-null field work");
}

console.log("== object literals & ternaries are NOT stripped ==");
{
  const src = `
    const cfg = { port: 3000, host: "localhost", nested: { a: 1 } };
    const pick = (f) => f ? cfg.port : cfg.host;
    module.exports = { cfg, pick };
  `;
  const out = transpileTypeScript(src, "t.ts");
  const m = evalJs(out);
  ok(m.cfg.port === 3000 && m.cfg.nested.a === 1, "object literal colons preserved");
  ok(m.pick(true) === 3000 && m.pick(false) === "localhost", "ternary colon preserved");
}

console.log("== import type / inline type specifiers ==");
{
  const src = `
    import type { Foo } from "./foo";
    import { type Bar, baz } from "./bar";
    export type { Qux } from "./qux";
    const y = 1;
    module.exports = { y };
  `;
  const out = transpileTypeScript(src, "t.ts");
  ok(!/import\s+type|export\s+type|Foo|Qux/.test(out), "type-only imports/exports removed");
  ok(/baz/.test(out), "value import kept");
}

console.log("== enum lowering ==");
{
  const src = `
    enum Color { Red, Green, Blue }
    enum Dir { Up = "UP", Down = "DOWN" }
    module.exports = { Color, Dir };
  `;
  const out = transpileTypeScript(src, "t.ts");
  const m = evalJs(out);
  ok(m.Color.Red === 0 && m.Color.Blue === 2, "numeric enum values");
  ok(m.Color[0] === "Red", "numeric enum reverse mapping");
  ok(m.Dir.Up === "UP" && m.Dir.Down === "DOWN", "string enum values");
}

console.log("== as / satisfies / non-null ==");
{
  const src = `
    const a = (JSON.parse("{}") as Record<string, number>);
    const b = ({ x: 1 } satisfies { x: number });
    const c = (globalThis as any);
    const d = a!.foo!;
    module.exports = { a, b };
  `;
  const out = transpileTypeScript(src, "t.ts");
  ok(!/\bas\b|satisfies|Record<|!\.|!;/.test(out), "casts and non-null assertions removed");
  const m = evalJs(out);
  ok(typeof m.a === "object" && m.b.x === 1, "runtime values intact after casts stripped");
}

console.log("== JSX / TSX lowering ==");
{
  const src = `
    const el = <div className="box" id={"x"}>hello <b>world</b></div>;
    const frag = <>{items.map((i) => <li key={i}>{i}</li>)}</>;
    module.exports = { el, frag };
  `;
  const items = [1, 2];
  const calls = [];
  const React = {
    Fragment: "FRAG",
    createElement: (type, props, ...kids) => { calls.push({ type, props, kids }); return { type, props, kids }; },
  };
  const out = transpileTypeScript(src, "c.tsx");
  ok(/React\.createElement/.test(out), "JSX lowered to React.createElement");
  const mod = (function () { const module = { exports: {} }; const f = new Function("React", "items", "module", out + "\n"); f(React, items, module); return module.exports; })();
  ok(mod.el && mod.el.type === "div", "element type is the string tag");
  ok(mod.el.props && mod.el.props.className === "box" && mod.el.props.id === "x", "string + expr attributes");
  ok(mod.frag && mod.frag.type === "FRAG", "fragment lowered to React.Fragment");
}

console.log("== return-type annotations inside object literals (Bun.serve shape) ==");
{
  // Regression: a method/arrow return type inside an object literal must be
  // stripped. Previously `fetch(req): Response {` kept `: Response`, so the whole
  // module failed to parse and `bun run index.ts` exited silently.
  const src = [
    "const server = makeServer({",
    "  port: 3000,",
    "  fetch(req: Request): Response {",
    "    const url = new URL(req.url);",
    "    return new Response('ok ' + url.pathname);",
    "  },",
    "  handler: (x: number): string => 'n' + x,",
    "  pick: (f: boolean) => f ? 1 : 2,",
    "});",
    "module.exports = { server };",
  ].join("\n");
  const out = transpileTypeScript(src, "server.ts");
  ok(!/:\s*Response\b/.test(out), "method return type `: Response` stripped inside object literal");
  ok(!/:\s*string\b/.test(out), "arrow property return type `: string` stripped inside object literal");
  let parses = true, perr = "";
  try { new Function(out); } catch (e) { parses = false; perr = e.message; }
  ok(parses, "object-literal-with-return-types transpiles to parseable JS" + (parses ? "" : " (" + perr + ")"));
  const mod = (function () { const m = { exports: {} }; new Function("makeServer", "Request", "Response", "URL", "module", out)((o) => o, class {}, class {}, class { constructor(u) { this.pathname = u; } }, m); return m.exports; })();
  ok(mod.server && typeof mod.server.fetch === "function" && mod.server.pick(true) === 1, "ternary colon preserved while return types stripped");
}

console.log("== Bun template index.ts parses ==");
{
  // The exact server shape the studio Bun template ships. Must transpile + parse.
  const templateEntry = [
    "const html: string = \"<h1>hi</h1>\";",
    "const port = Number(process.env.PORT ?? 3000);",
    "const server = Bun.serve({",
    "  port,",
    "  fetch(req: Request): Response {",
    "    const url = new URL(req.url);",
    "    if (url.pathname === '/api/hello') {",
    "      return Response.json({ message: 'Hello, world!', runtime: 'bun', version: Bun.version });",
    "    }",
    "    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });",
    "  },",
    "});",
    "console.log('Bun listening on http://localhost:' + server.port);",
  ].join("\n");
  const out = transpileTypeScript(templateEntry, "index.ts");
  let parses = true, perr = "";
  try { new Function(out); } catch (e) { parses = false; perr = e.message; }
  ok(parses, "Bun template index.ts transpiles to parseable JS" + (parses ? "" : " (" + perr + ")"));
}

console.log("== destructured + generic params (React prop shape) ==");
{
  // Regression: a type annotation on a DESTRUCTURED parameter (`({ a }: T)`) and on
  // a `const { a }: T = …` binding must be stripped — the idiomatic typed-props
  // React pattern. Previously the `: T` survived and the module failed to parse.
  const src = [
    "type Props = { start: number };",
    "function Counter({ start }: Props) { return start + 1; }",
    "const { start }: Props = { start: 5 };",
    "module.exports = { Counter, start };",
  ].join("\n");
  const out = transpileTypeScript(src, "c.tsx");
  ok(!/:\s*Props\b/.test(out), "annotation on destructured param + binding stripped");
  let parses = true, perr = "";
  try { new Function(out); } catch (e) { parses = false; perr = e.message; }
  ok(parses, "destructured-typed source transpiles to parseable JS" + (parses ? "" : " (" + perr + ")"));
  const m = evalJs(out);
  ok(m.Counter({ start: 41 }) === 42, "destructured param runs after strip");
  ok(m.start === 5, "typed destructured binding runs");
}

console.log("== inline object-type & function-type annotations ==");
{
  // Regression: `skipType` must treat `{` and `=>` as part of a type expression,
  // not as unconditional depth-0 terminators. Previously `props: {a: number}`
  // transpiled to `props{a}` and `cb: () => void` swallowed the initializer.
  const cases = [
    ["inline object param", "function f(p: {a: number}) { return p.a; }", /function f\(p\)/],
    ["inline object var", "const x: {a: number} = { a: 1 };", /const x= \{ a: 1 \};/],
    ["union object param", "function f(p: {a: number} | {b: string}) { return p; }", /function f\(p\)/],
    ["object type w/ fn member", "function f(props: { onClick: () => void }) { return props; }", /function f\(props\)/],
    ["top-level function type", "const cb: () => void = () => {};", /const cb= \(\) => \{\};/],
    ["arrow returning object type", "const g = (): {a: number} => ({ a: 1 });", /const g = \(\)=> \(\{ a: 1 \}\);/],
    ["return object type", "function h(): {a: number} { return { a: 1 }; }", /function h\(\)\{ return \{ a: 1 \}; \}/],
    ["return primitive + body", "function j(): number { return 1; }", /function j\(\)\{ return 1; \}/],
  ];
  for (const [name, src, re] of cases) {
    const out = transpileTypeScript(src, "t.ts");
    let parses = true, perr = "";
    try { new Function(out); } catch (e) { parses = false; perr = e.message; }
    ok(parses && re.test(out), name + " -> " + JSON.stringify(out) + (parses ? "" : " (" + perr + ")"));
  }
}

console.log("== reported react.tsx inline prop type ==");
{
  // The exact snippet the user reported crashing with `SyntaxError: Unexpected token '{'`.
  const src = [
    "function Component(props: {message: string}) {",
    "  return (",
    "    React.createElement('h1', null, props.message)",
    "  );",
    "}",
    "module.exports = { Component };",
  ].join("\n");
  const out = transpileTypeScript(src, "react.tsx");
  ok(!/:\s*string\b/.test(out) && /function Component\(props\)/.test(out), "inline prop object type stripped");
  let parses = true, perr = "";
  try { new Function("React", out); } catch (e) { parses = false; perr = e.message; }
  ok(parses, "reported react.tsx transpiles to parseable JS" + (parses ? "" : " (" + perr + ")"));
  const m = evalJs(out, "const React = { createElement: (t, p, c) => ({ t, c }) };");
  ok(m.Component({ message: "hi" }).c === "hi", "component runs after inline prop-type strip");
}

console.log("== Bun.serve route matcher ==");
{
  const RES = (tag) => ({ __tag: tag, arrayBuffer() {} }); // stand-in for a static Response
  const routes = {
    "/api/users/me": () => "ME",
    "/api/users/:id": (r) => "USER:" + r.params.id,
    "/api/*": () => "APICATCH",
    "/health": RES("OK"),
    "/orgs/:orgId/repos/:repoId": (r) => r.params.orgId + "/" + r.params.repoId,
    "/": () => "HOME",
  };
  const c = compileRoutes(routes);
  const hit = (p, method = "GET") => {
    const m = matchRoute(c, p, method);
    if (!m) return "MISS";
    if (m.response !== undefined) return "RES:" + m.response.__tag;
    return m.handler({ params: m.params });
  };
  ok(hit("/") === "HOME", "root exact route");
  ok(hit("/health") === "RES:OK", "static Response route");
  ok(hit("/api/users/me") === "ME", "exact beats param (precedence)");
  ok(hit("/api/users/42") === "USER:42", "param route captures :id");
  ok(hit("/api/users/a%2Fb") === "USER:a/b", "param is percent-decoded");
  ok(hit("/api/anything/else") === "APICATCH", "wildcard route");
  ok(hit("/orgs/acme/repos/vivari") === "acme/vivari", "multi-param route");
  ok(hit("/nope") === "MISS", "unmatched -> null (fetch fallback)");
}

console.log("== Bun.serve WebSocket frame codec ==");
{
  // The server sends UNMASKED frames and must decode the client's MASKED frames.
  const clientFrame = encodeWsFrame(Buffer, 0x1, Buffer.from("hello", "utf8"), true);
  ok((clientFrame[1] & 0x80) !== 0, "client frame is masked");
  const dec = readWsFrame(Buffer, clientFrame);
  ok(dec && dec.frame.opcode === 0x1 && dec.frame.payload.toString("utf8") === "hello", "server decodes masked client text");

  const serverFrame = encodeWsFrame(Buffer, 0x1, Buffer.from("world", "utf8"), false);
  ok((serverFrame[1] & 0x80) === 0, "server frame is unmasked");
  const dec2 = readWsFrame(Buffer, serverFrame);
  ok(dec2 && dec2.frame.payload.toString("utf8") === "world", "unmasked server frame round-trips");

  // Two frames back-to-back: the reader consumes one and leaves the rest.
  const two = Buffer.concat([
    encodeWsFrame(Buffer, 0x1, Buffer.from("a"), true),
    encodeWsFrame(Buffer, 0x1, Buffer.from("bc"), true),
  ]);
  const r1 = readWsFrame(Buffer, two);
  const r2 = readWsFrame(Buffer, r1.rest);
  ok(r1.frame.payload.toString() === "a" && r2.frame.payload.toString() === "bc", "streamed frames parsed one at a time");

  // Incomplete buffer yields null (needs more bytes).
  ok(readWsFrame(Buffer, clientFrame.subarray(0, 3)) === null, "partial frame returns null");

  // A 200-byte payload exercises the 16-bit extended length path.
  const big = Buffer.alloc(200, 0x61);
  const bigDec = readWsFrame(Buffer, encodeWsFrame(Buffer, 0x2, big, false));
  ok(bigDec && bigDec.frame.payload.length === 200, "extended-length (126) frame round-trips");

  // Payload typing: binary vs text opcode selection.
  ok(toWsPayload("hi", Buffer).opcode === 0x1, "string -> text opcode");
  ok(toWsPayload(new Uint8Array([1, 2, 3]), Buffer).opcode === 0x2, "typed array -> binary opcode");
}

console.log("== React (Bun) app.tsx transpiles + parses ==");
{
  // The exact client component the bun-react template ships. It must lower JSX to
  // React.createElement, strip the typed destructured prop + useState<number>, and
  // keep the bare ESM imports (resolved by the importmap in the browser).
  const appTsx = [
    'import React, { useState } from "react";',
    'import { createRoot } from "react-dom/client";',
    "",
    "type CounterProps = { start: number };",
    "",
    "function Counter({ start }: CounterProps) {",
    "  const [count, setCount] = useState<number>(start);",
    "  return (",
    '    <button onClick={() => setCount((c) => c + 1)}>count is {count}</button>',
    "  );",
    "}",
    "",
    "function App() {",
    "  return (",
    '    <main><h1>React + Bun</h1><Counter start={0} /></main>',
    "  );",
    "}",
    "",
    'const root = document.getElementById("root");',
    "if (root) createRoot(root).render(<App />);",
  ].join("\n");
  const out = new (createBunRuntime({ process: { env: {}, argv: [], cwd: () => "/" }, Buffer, require: nodeRequire }).Bun.Transpiler)({ loader: "tsx" }).transformSync(appTsx);
  ok(/React\.createElement/.test(out), "JSX lowered to React.createElement");
  ok(!/:\s*CounterProps\b/.test(out) && !/useState<number>/.test(out), "typed prop + generic stripped");
  ok(/import React, \{ useState \} from "react"/.test(out), "bare ESM react import preserved for importmap");
  // Parse as a module (ESM imports) by stripping the import lines for new Function.
  const body = out.replace(/^\s*import[^\n]*\n/gm, "");
  let parses = true, perr = "";
  try { new Function("React", "useState", "createRoot", "document", body); } catch (e) { parses = false; perr = e.message; }
  ok(parses, "app.tsx transpiles to parseable module body" + (parses ? "" : " (" + perr + ")"));
}

console.log("== maybeTranspileTypeScript gating ==");
{
  ok(maybeTranspileTypeScript("const x = 1;", "plain.js") === null, ".js returns null (untouched)");
  ok(maybeTranspileTypeScript("const x: number = 1;", "a.ts") !== null, ".ts with types transpiles");
  ok(maybeTranspileTypeScript("module.exports = 1;", "a.ts") === null, "plain-JS .ts (no types) returns null");
  ok(typeof maybeTranspileTypeScript("const e = <a/>;", "a.tsx") === "string", ".tsx always transpiles");
}

console.log("== bun program parses ==");
{
  const parse = (src, name) => { try { new Function(src); return true; } catch (e) { console.log("    " + name + " parse error: " + e.message); return false; } };
  ok(parse(BUN_PROGRAM, "BUN_PROGRAM"), "/bin/bun.js source is syntactically valid");
  ok(parse(BUNX_PROGRAM, "BUNX_PROGRAM"), "/bin/bunx.js source is syntactically valid");
}

console.log("== Bun global API (node-backed) ==");
{
  const proc = { env: { PATH: "/bin" }, argv: ["bun", "/app/x.ts"], cwd: () => "/app", stdout: process.stdout, stderr: process.stderr, stdin: process.stdin };
  const { Bun, modules } = createBunRuntime({ process: proc, Buffer, require: nodeRequire });
  ok(typeof Bun.version === "string", "Bun.version present: " + Bun.version);
  ok(Bun.main === "/app/x.ts", "Bun.main reflects argv[1]");
  ok(Bun.escapeHTML("<a>&'\"") === "&lt;a&gt;&amp;&#x27;&quot;", "Bun.escapeHTML");
  ok(Bun.deepEquals({ a: [1, 2] }, { a: [1, 2] }) === true, "Bun.deepEquals deep");
  ok(Bun.deepEquals({ a: 1 }, { a: 2 }) === false, "Bun.deepEquals unequal");
  ok(typeof Bun.hash("hello") === "number", "Bun.hash returns a number");
  ok(Bun.hash.crc32("hello") === Bun.hash.crc32("hello"), "Bun.hash.crc32 stable");
  const gz = Bun.gzipSync("hello vivari");
  ok(Buffer.from(Bun.gunzipSync(gz)).toString() === "hello vivari", "Bun.gzipSync/gunzipSync round-trip");
  const h = Bun.password.hashSync("s3cret");
  ok(Bun.password.verifySync("s3cret", h) === true && Bun.password.verifySync("nope", h) === false, "Bun.password hash/verify");
  ok(new Bun.CryptoHasher("sha256").update("abc").digest("hex").length === 64, "Bun.CryptoHasher sha256");
  ok(typeof Bun.serve === "function" && typeof Bun.$ === "function", "Bun.serve + Bun.$ present");
  ok(new Bun.Transpiler({ loader: "ts" }).transformSync("const x: number = 1;").indexOf(": number") === -1, "Bun.Transpiler strips types");
  ok(modules["bun:test"] && modules["bun:ffi"] && modules["bun:sqlite"] && modules["bun:jsc"], "bun:* modules registered");
  let ffiThrew = false; try { modules["bun:ffi"].dlopen(); } catch { ffiThrew = true; }
  ok(ffiThrew, "bun:ffi.dlopen throws (documented unsupported)");
}

console.log("== bun:test runner + expect ==");
{
  const logs = [];
  const proc = { env: {}, argv: ["bun"], cwd: () => "/", stdout: { write: (s) => logs.push(s) }, stderr: { write: (s) => logs.push(s) }, stdin: process.stdin };
  const { modules } = createBunRuntime({ process: proc, Buffer, require: nodeRequire });
  const t = modules["bun:test"];
  const { describe, test, expect, beforeEach } = t;
  let seen = 0;
  describe("math", () => {
    beforeEach(() => { seen++; });
    test("adds", () => { expect(1 + 1).toBe(2); });
    test("deep", () => { expect({ a: 1 }).toEqual({ a: 1 }); });
    test("not", () => { expect(3).not.toBe(4); });
    test("throws", () => { expect(() => { throw new Error("boom"); }).toThrow("boom"); });
  });
  const code = await t.__run();
  ok(code === 0, "all bun:test cases pass -> exit 0");
  ok(seen === 4, "beforeEach ran for each test");
  const mock = t.mock((x) => x * 2);
  ok(mock(21) === 42 && mock.mock.calls.length === 1, "bun:test mock records calls");
}

// A bun:test runner is per-runtime state (registered suites + the `only` flag), so
// each scenario below builds its own, capturing the reporter output.
function freshBunTest() {
  const logs = [];
  const proc = { env: {}, argv: ["bun"], cwd: () => "/", stdout: { write: (s) => logs.push(s) }, stderr: { write: (s) => logs.push(s) }, stdin: process.stdin };
  const { modules } = createBunRuntime({ process: proc, Buffer, require: nodeRequire });
  return { t: modules["bun:test"], logs, report: () => logs.join("") };
}

console.log("== bun:test test.only filters the run ==");
{
  // Regression: test.only used to register an ordinary test and filter nothing, so
  // an `only` run executed the whole suite — code "passed" here and failed in Bun.
  const { t, report } = freshBunTest();
  const { describe, test, beforeAll } = t;
  const ran = [];
  describe("outer", () => {
    test("plain", () => ran.push("plain"));
    test.only("focused", () => ran.push("focused"));
    describe("inner", () => {
      test("nested plain", () => ran.push("nested plain"));
      test.only("nested focused", () => ran.push("nested focused"));
    });
  });
  describe("untouched", () => {
    beforeAll(() => ran.push("untouched:beforeAll"));
    test("also plain", () => ran.push("also plain"));
  });
  const code = await t.__run();
  ok(ran.join(",") === "focused,nested focused", "only the test.only cases run (ran: " + ran.join(",") + ")");
  ok(ran.indexOf("untouched:beforeAll") === -1, "a suite with no only test does not run its beforeAll");
  ok(report().indexOf("plain") === -1, "filtered-out tests are not reported");
  ok(code === 0 && report().indexOf("2 pass, 0 fail") !== -1, "only run reports just the focused tests");
}

console.log("== bun:test only is inert when nothing is focused ==");
{
  const { t } = freshBunTest();
  const ran = [];
  t.describe("s", () => {
    t.test("a", () => ran.push("a"));
    t.test("b", () => ran.push("b"));
  });
  await t.__run();
  ok(ran.join(",") === "a,b", "with no test.only registered every test still runs");
}

console.log("== bun:test hooks: root execution + describe inheritance ==");
{
  // Regression: root beforeEach/afterEach were collected and never executed, and a
  // nested describe did not inherit its parents' each-hooks.
  const { t } = freshBunTest();
  const { describe, test, beforeEach, afterEach } = t;
  const order = [];
  beforeEach(() => order.push("root:before"));
  afterEach(() => order.push("root:after"));
  test("root test", () => order.push("root:test"));
  describe("outer", () => {
    beforeEach(() => order.push("outer:before"));
    afterEach(() => order.push("outer:after"));
    test("outer test", () => order.push("outer:test"));
    describe("inner", () => {
      beforeEach(() => order.push("inner:before"));
      afterEach(() => order.push("inner:after"));
      test("inner test", () => order.push("inner:test"));
      test.skip("skipped", () => order.push("SKIPPED BODY RAN"));
    });
  });
  await t.__run();
  const expected = [
    "root:before", "root:test", "root:after",
    "root:before", "outer:before", "outer:test", "outer:after", "root:after",
    "root:before", "outer:before", "inner:before", "inner:test", "inner:after", "outer:after", "root:after",
  ].join("|");
  ok(order.indexOf("root:before") !== -1 && order.indexOf("root:after") !== -1, "root beforeEach/afterEach run at all");
  ok(order.join("|") === expected, "each-hooks inherit outermost-first / innermost-last" + (order.join("|") === expected ? "" : " (got " + order.join("|") + ")"));
  ok(order.indexOf("SKIPPED BODY RAN") === -1, "a skipped test body does not run");
  ok(order.filter((s) => s === "root:before").length === order.filter((s) => s === "root:after").length, "beforeEach/afterEach stay paired across a skipped test");
}

console.log("== Bun.file(fd) is loud, not silently a path ==");
{
  // Regression: Bun.file(3) used to String() the fd into the relative path "3".
  const proc = { env: {}, argv: ["bun"], cwd: () => "/app", stdout: process.stdout, stderr: process.stderr, stdin: process.stdin };
  const { Bun } = createBunRuntime({ process: proc, Buffer, require: nodeRequire });
  let msg = "";
  try { Bun.file(3); } catch (e) { msg = e.message; }
  ok(/file descriptors/.test(msg), "Bun.file(fd) throws a fd-specific error: " + JSON.stringify(msg.slice(0, 48)));
  ok(Bun.file("/app/data.json").name === "/app/data.json", "Bun.file(path) is unaffected");
  ok(Bun.file("/app/data.json").type === "application/json", "Bun.file(path) still guesses the mime type");
}

console.log("== Bun.serve honors opts.error ==");
{
  // Regression: the documented `error` option was never read, so every handler
  // failure rendered the same hard-coded 500 with the message inlined in the body.
  const boom = new Error("kaboom");
  const fallback = await resolveServeError(null, boom);
  ok(fallback.status === 500, "no error handler -> 500");
  ok((await fallback.text()) === "Bun.serve handler error: kaboom", "the pre-existing 500 body is preserved verbatim");

  const served = await resolveServeError((e) => new Response("handled: " + e.message, { status: 503 }), boom);
  ok(served.status === 503 && (await served.text()) === "handled: kaboom", "opts.error response is served instead");

  const asyncServed = await resolveServeError(async (e) => new Response("async " + e.message), boom);
  ok((await asyncServed.text()) === "async kaboom", "an async error handler is awaited");

  const declined = await resolveServeError(() => undefined, boom);
  ok(declined.status === 500 && (await declined.text()).indexOf("kaboom") !== -1, "a handler that returns nothing falls back to the original error");

  const broken = await resolveServeError(() => { throw new Error("handler broke"); }, boom);
  ok(broken.status === 500 && (await broken.text()).indexOf("handler broke") !== -1, "a throwing error handler falls back and reports its own failure");
}

console.log("== silently-wrong stubs now throw ==");
{
  const proc = { env: {}, argv: ["bun"], cwd: () => "/", stdout: process.stdout, stderr: process.stderr, stdin: process.stdin };
  const { Bun, modules } = createBunRuntime({ process: proc, Buffer, require: nodeRequire });

  const tr = new Bun.Transpiler({ loader: "ts" });
  const throws = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };
  ok(/Bun\.Transpiler\.scan\(\) is not implemented/.test(throws(() => tr.scan("import a from 'b';"))), "Transpiler.scan() throws instead of returning empty arrays");
  ok(/Bun\.Transpiler\.scanImports\(\) is not implemented/.test(throws(() => tr.scanImports("import a from 'b';"))), "Transpiler.scanImports() throws instead of returning []");
  ok(tr.transformSync("const x: number = 1;").indexOf(": number") === -1, "Transpiler.transformSync still works");

  const jsc = modules["bun:jsc"];
  ok(jsc.deserialize(jsc.serialize({ a: 1 })).a === 1, "bun:jsc serialize/deserialize still round-trips");
  for (const name of ["heapSize", "memoryUsage", "estimateShallowMemoryUsageOf"]) {
    ok(/not supported in Vivari/.test(throws(() => jsc[name]({}))), "bun:jsc." + name + "() throws instead of answering 0");
  }
}

console.log("== version identity has one source ==");
{
  // `BUN_PROGRAM` is a no-interpolation template literal, so the CLI cannot import
  // BUN_VERSION. It reads the version off the installed Bun global at runtime and
  // only falls back to a literal; these checks are what stop that literal drifting.
  ok(BUN_CLI_VERSION_FALLBACK === BUN_VERSION, "the CLI fallback matches the runtime BUN_VERSION (" + BUN_VERSION + ")");
  ok(BUN_PROGRAM.indexOf("VERSION_FALLBACK = '" + BUN_VERSION + "'") !== -1, "the literal embedded in BUN_PROGRAM is that same version");
  ok(BUN_REVISION === BUN_VERSION + "-vivari", "Bun.revision is derived from the version: " + BUN_REVISION);
  const proc = { env: {}, argv: ["bun"], cwd: () => "/", stdout: process.stdout, stderr: process.stderr, stdin: process.stdin };
  const { Bun } = createBunRuntime({ process: proc, Buffer, require: nodeRequire });
  ok(Bun.version === BUN_VERSION && Bun.revision === BUN_REVISION, "the Bun global reports both from that one definition");
}

console.log("== bun CLI dispatch (BUN_PROGRAM run as a real process) ==");
{
  // BUN_PROGRAM is an ordinary CommonJS program, so plain Node can execute it: no
  // kernel, no VFS, no Bun global (installBun() is a guarded no-op off-Vivari).
  // That is enough to gate verb dispatch, which is where the bugs were.
  const os = nodeRequire("node:os");
  const fsMod = nodeRequire("node:fs");
  const pathMod = nodeRequire("node:path");
  const { spawnSync } = nodeRequire("node:child_process");

  const dir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), "vv-bun-cli-"));
  try {
    const binBun = pathMod.join(dir, "bun-shim.js");
    fsMod.writeFileSync(binBun, BUN_PROGRAM);
    fsMod.writeFileSync(pathMod.join(dir, "hello.js"), "console.log('ran ' + process.argv[2]);\n");
    fsMod.writeFileSync(pathMod.join(dir, "package.json"), JSON.stringify({ name: "t", scripts: { greet: "echo greeted" } }));
    const bun = (...args) => {
      const r = spawnSync(process.execPath, [binBun, ...args], { cwd: dir, encoding: "utf8" });
      return { code: r.status, text: (r.stdout || "") + (r.stderr || "") };
    };

    const version = bun("--version");
    ok(version.code === 0 && version.text.trim() === BUN_VERSION, "bun --version prints " + BUN_VERSION);
    const revision = bun("--revision");
    ok(revision.code === 0 && revision.text.trim() === BUN_VERSION + "-vivari", "bun --revision agrees with Bun.revision");

    // Regression: `upgrade` used to be an alias for `npm update`.
    const upgrade = bun("upgrade");
    ok(upgrade.code === 1 && /upgrades the Bun binary itself/.test(upgrade.text), "bun upgrade reports not-implemented");
    ok(upgrade.text.indexOf("npm update") === -1, "bun upgrade does not delegate to npm");

    // Regression: unknown verbs fell through to doRun and said "file not found".
    const publish = bun("publish");
    ok(publish.code === 1 && /bun publish is not implemented/.test(publish.text), "unknown verb reports not-implemented");
    ok(publish.text.indexOf("file not found") === -1, "unknown verb no longer claims a missing file");
    const watch = bun("--watch", "index.ts");
    ok(watch.code === 1 && /bun --watch is not implemented/.test(watch.text), "an unsupported flag reports not-implemented too");

    // The genuine run-a-file and run-a-script paths must survive that change.
    const relFile = bun("./hello.js", "world");
    ok(relFile.code === 0 && /ran world/.test(relFile.text), "bun ./hello.js still runs the file with its args");
    const bareFile = bun("hello.js");
    ok(bareFile.code === 0 && /ran undefined/.test(bareFile.text), "bun hello.js (bare filename) still runs the file");
    const script = bun("greet");
    ok(script.code === 0 && /greeted/.test(script.text), "bun <package.json script> shorthand still runs");
    const missing = bun("missing.ts");
    ok(missing.code === 1 && /file not found: missing\.ts/.test(missing.text), "a file-shaped argument that does not exist still reports file not found");
  } finally {
    fsMod.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("== CI actually gates the Bun spikes ==");
{
  // The verify job builds the Wasm crates and then filters run-spikes to a name
  // list; `bun` was missing from it, so scripts/spike-bun.mjs ran in no job at all
  // (the Wasm-free gate auto-skips it). Keep it in the filter.
  const fsMod = nodeRequire("node:fs");
  const ci = fsMod.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const spikeLines = ci.split("\n").filter((l) => l.indexOf("run-spikes.mjs") !== -1);
  ok(spikeLines.some((l) => /run-spikes\.mjs --offline\s.*\bbun\b/.test(l)), "a CI job runs the Wasm-backed bun spike");
  ok(spikeLines.some((l) => /run-spikes\.mjs --offline\s.*\bdep-cache\b/.test(l)), "that job still runs the dep-cache spike");
}

console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: all offline Bun checks passed");
process.exit(failed ? 1 : 0);