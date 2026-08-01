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
import { importMetaSource, transpileEsm } from "../packages/runtime/esm.js";
import {
  bunEnvMode,
  bunEnvFiles,
  parseDotenv,
  expandDotenvValue,
  applyDotenv,
  loadBunEnvFiles,
} from "../packages/runtime/builtins/bun-env.js";
import { createSleepSync } from "../packages/runtime/builtins/bun-sleep.js";
import { canPark, parkFor } from "../packages/protocol/syscall.js";

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

console.log("== generic arrow functions ==");
{
  // Regression: the type parameters of a generic ARROW were never stripped, so
  // `const add = <T extends number>(a: T, b: T): T => ...` emitted `<T extends
  // number>(a, b)=>` — a hard SyntaxError. isGenericOpen only fires when the
  // token before `<` is an identifier / `)` / `>`, but an arrow starts an
  // EXPRESSION, so what precedes it is `=`, `(`, `,`, `return`, … Only
  // `async <T>(…)` worked, by accident: `async` is an identifier.
  //
  // This is what made block 2 of scripts/spike-bun.mjs fail on its first CI run
  // ("bun: SyntaxError: Unexpected token '<' (while compiling /app/index.ts)").
  // The bug predates the Phase 0 CI wiring; that wiring is only what revealed it.
  const cases = [
    ["extends bound", "const add = <T extends number>(a: T, b: T): T => (a + b) as T; __r = add(1, 2);", 3],
    ["bare parameter", "const id = <T>(x: T): T => x; __r = id(7);", 7],
    ["two parameters", "const pair = <A, B>(a: A, b: B) => [a, b]; __r = pair(1, 2).join(',');", "1,2"],
    ["default parameter", "const d = <T = string>(x: T) => x; __r = d('z');", "z"],
    ["nested type argument", "const f = <T extends Array<number>>(x: T): T => x; __r = f([1, 2]).length;", 2],
    ["block body", "const b = <T>(x: T): T => { return x; }; __r = b(6);", 6],
    ["no return annotation", "const n = <T>(x: T) => x; __r = n(5);", 5],
    ["as a call argument", "const call = (f: any) => f(5); __r = call(<T>(x: T): T => x);", 5],
    ["in an object literal", "const o = { m: <T>(x: T): T => x }; __r = o.m(4);", 4],
    ["in an array literal", "const a = [<T>(x: T) => x]; __r = a[0](9);", 9],
    ["after return", "function w() { return <T>(x: T): T => x; } __r = w()(8);", 8],
    ["async (already worked)", "const g = async <T>(x: T): T => x; __r = typeof g;", "function"],
  ];
  for (const [name, src, want] of cases) {
    const out = transpileTypeScript(src, "t.ts");
    let got, err = null;
    try { got = evalJs("let __r; " + out + "\nmodule.exports = __r;"); }
    catch (e) { err = e.constructor.name + ": " + e.message; }
    ok(err === null && got === want, "generic arrow: " + name + (err ? " -> " + err : " -> " + JSON.stringify(got)));
  }
  // The heuristic must not start eating real comparisons. `a < b > (c)` is left
  // alone here on purpose: TypeScript itself parses that as the generic call
  // `a<b>(c)`, so treating it as one is correct, not a regression.
  const cmp = transpileTypeScript("const a = 1, b = 2; __r = (a < b) && !(b > 3); module.exports = __r;", "t.ts");
  ok(evalJs(cmp) === true, "plain `<` / `>` comparisons still survive the transform");
  const shift = transpileTypeScript("const n = 8; module.exports = (n >> 1) + (n << 1);", "t.ts");
  ok(evalJs(shift) === 20, "shift operators still survive the transform");
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
  // INTENTIONAL CHANGE: this used to assert `typeof Bun.hash("hello") === "number"`,
  // which was only true because the shim's hash was a bespoke 53-bit thing. Real
  // Bun.hash is a 64-bit wyhash and returns a bigint; the old assertion was
  // pinning the bug. The number-vs-bigint split is exercised properly below.
  ok(typeof Bun.hash("hello") === "bigint", "Bun.hash returns a bigint (64-bit wyhash)");
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

// A Bun global with no kernel, for the pure-function checks below.
function freshBun() {
  const proc = { env: {}, argv: ["bun"], cwd: () => "/", stdout: process.stdout, stderr: process.stderr, stdin: process.stdin };
  return createBunRuntime({ process: proc, Buffer, require: nodeRequire }).Bun;
}

console.log("== Bun.hash is really wyhash (published known-answer vectors) ==");
{
  // These two digests are printed in https://bun.com/docs/runtime/hashing. They are
  // the entire point of the change: the hash this replaced was perfectly
  // self-consistent — same input, same output, every time — and disagreed with real
  // Bun on every input there is. Only a vector from outside our own code can tell
  // those two situations apart, which is why "stable" was never evidence of anything.
  const Bun = freshBun();
  ok(Bun.hash("some data here") === 11562320457524636935n, "Bun.hash('some data here') == 11562320457524636935n (documented)");
  ok(Bun.hash("some data here", 1234) === 15724820720172937558n, "Bun.hash('some data here', 1234) == 15724820720172937558n (documented)");
  ok(Bun.hash.wyhash("some data here") === 11562320457524636935n, "Bun.hash.wyhash agrees with the bare Bun.hash");

  // Documented return typing: 32-bit hashes give a number, 64-bit hashes a bigint.
  // This is load-bearing, not cosmetic — `Bun.hash("x") + 1` is a TypeError under
  // real Bun, so a shim handing back a Number makes that line work here and fail
  // in production.
  for (const name of ["wyhash", "xxHash64", "murmur64v2", "cityHash64"]) {
    ok(typeof Bun.hash[name]("hello", 1) === "bigint", `Bun.hash.${name} returns a bigint (64-bit)`);
  }
  for (const name of ["xxHash32", "murmur32v2", "murmur32v3", "cityHash32", "crc32", "adler32"]) {
    ok(typeof Bun.hash[name]("hello", 1) === "number", `Bun.hash.${name} returns a number (32-bit)`);
  }

  // Seeds: the docs pass a plain number even to the 64-bit hashes, and say to use a
  // BigInt above Number.MAX_SAFE_INTEGER. Both spellings must mean the same seed.
  ok(Bun.hash("some data here", 1234n) === Bun.hash("some data here", 1234), "a bigint seed and a number seed agree");
  ok(Bun.hash("some data here") !== Bun.hash("some data here", 1234), "the seed actually reaches the algorithm");

  // Every documented input type must hash to the same bytes.
  const u8 = new Uint8Array([1, 2, 3, 4]);
  const viaBytes = Bun.hash(u8);
  ok(Bun.hash(u8.buffer) === viaBytes, "Bun.hash(ArrayBuffer) == Bun.hash(TypedArray)");
  ok(Bun.hash(new DataView(u8.buffer)) === viaBytes, "Bun.hash(DataView) == Bun.hash(TypedArray)");
  ok(typeof Bun.hash("") === "bigint", "Bun.hash of the empty string does not throw");

  // xxHash3 and rapidhash are documented members we did not port. Loud, not guessed.
  for (const name of ["xxHash3", "rapidhash"]) {
    let threw = "";
    try { Bun.hash[name]("x"); } catch (e) { threw = e.message; }
    ok(threw.indexOf(name) !== -1, `Bun.hash.${name} throws naming itself instead of returning a plausible number`);
  }
}

console.log("== Bun.hash family: SMHasher verification codes ==");
{
  // SMHasher's standard known-answer procedure: hash the keys {0}, {0,1}, … {0..254}
  // with seed 256-N, concatenate the little-endian digests, hash THAT with seed 0 and
  // keep the low 32 bits. One transcribed constant or a mis-ordered tail anywhere in a
  // port changes the code, so a single number per algorithm pins the whole function.
  // The expected values are the ones Zig's own std.hash test suite asserts, Zig being
  // where Bun gets these implementations.
  const Bun = freshBun();
  const verification = (fn, bits) => {
    const size = bits / 8;
    const key = new Uint8Array(256);
    const digests = new Uint8Array(256 * size);
    for (let i = 0; i < 256; i++) {
      key[i] = i;
      let v = BigInt(fn(key.subarray(0, i), 256 - i));
      for (let k = 0; k < size; k++) digests[i * size + k] = Number((v >> BigInt(k * 8)) & 0xffn);
    }
    return Number(BigInt.asUintN(32, BigInt(fn(digests, 0))));
  };
  const cases = [
    ["murmur32v2", 32, 0x27864c1e],
    ["murmur32v3", 32, 0xb0f57ee3],
    ["murmur64v2", 64, 0x1f0d3804],
    ["cityHash32", 32, 0x68254f81],
    ["cityHash64", 64, 0x5fabc5c5],
    ["xxHash32", 32, 0xba88b743],
    ["xxHash64", 64, 0x024b7cf4],
  ];
  for (const [name, bits, want] of cases) {
    const got = verification((data, seed) => Bun.hash[name](data, seed), bits);
    ok(got === want, `Bun.hash.${name} SMHasher code 0x${got.toString(16).toUpperCase().padStart(8, "0")} == 0x${want.toString(16).toUpperCase().padStart(8, "0")}`);
  }

  // crc32/adler32 were already correct and are deliberately untouched; pin them so a
  // future edit to this file cannot quietly take them with it.
  ok(Bun.hash.crc32("hello") === 907060870, "Bun.hash.crc32('hello') == 907060870 (unchanged)");
  ok(Bun.hash.adler32("hello") === 103547413, "Bun.hash.adler32('hello') == 103547413 (unchanged)");
}

console.log("== Bun.Glob .match() — documented examples ==");
{
  const Bun = freshBun();
  const m = (pattern, path) => new Bun.Glob(pattern).match(path);
  // Verbatim from https://bun.com/docs/runtime/glob.
  ok(m("*.ts", "index.ts") && !m("*.ts", "index.js"), "`*` matches within a segment");
  ok(m("???.ts", "foo.ts") && !m("???.ts", "foobar.ts"), "`?` is exactly one character");
  ok(m("**/*.ts", "index.ts") && m("**/*.ts", "src/index.ts") && !m("**/*.ts", "src/index.js"), "`**/` matches zero or more directories");
  ok(m("ba[rz].ts", "bar.ts") && m("ba[rz].ts", "baz.ts") && !m("ba[rz].ts", "bat.ts"), "character classes");
  ok(m("ba[a-z][0-9][^4-9].ts", "bar01.ts") && m("ba[a-z][0-9][^4-9].ts", "baz83.ts") && m("ba[a-z][0-9][^4-9].ts", "bat22.ts"),
    "ranges and negated classes match the documented positives");
  ok(!m("ba[a-z][0-9][^4-9].ts", "bat24.ts") && !m("ba[a-z][0-9][^4-9].ts", "ba0a8.ts"),
    "ranges and negated classes reject the documented negatives");
  ok(m("{a,b,c}.ts", "a.ts") && m("{a,b,c}.ts", "c.ts") && !m("{a,b,c}.ts", "d.ts"), "brace alternation");
  ok(m("\\!index.ts", "!index.ts") && !m("\\!index.ts", "index.ts"), "`\\` escapes a leading `!`");
}

console.log("== Bun.Glob — the three ways Bun differs from minimatch/picomatch ==");
{
  // These are the reason this matcher is hand-rolled instead of vendored. Each one
  // changes which files a build includes, and in each case the other libraries'
  // default answer looks perfectly reasonable, so a drop-in replacement would pass
  // review and quietly ship a different file set.
  const Bun = freshBun();
  const m = (pattern, path) => new Bun.Glob(pattern).match(path);

  // 1. `*` does not cross a path separator — either flavour.
  ok(!m("*.ts", "src/index.ts"), "`*` does not match across `/` (documented)");
  ok(!m("src/*/x.ts", "src/a/b/x.ts"), "`*` matches exactly one segment, not a subtree");
  ok(!m("*.ts", "src\\index.ts"), "`*` does not match across `\\` either");
  ok(m("src/**", "src/a/b/c.ts"), "`**` does cross separators");

  // 2. `!` negates ONLY at the start of a pattern; elsewhere it is an ordinary
  //    character. Matchers with extglob treat `a!(b)` as negation mid-pattern.
  ok(!m("!index.ts", "index.ts") && m("!index.ts", "foo.ts"), "a leading `!` inverts the match (documented)");
  ok(m("a!b.ts", "a!b.ts"), "a `!` in the middle of a pattern is a literal `!`");
  ok(!m("a!b.ts", "ab.ts"), "a mid-pattern `!` does not introduce a negation group");

  // 3. Braces nest at most 10 deep. Deeper is a pattern bug, and erroring beats
  //    either expanding a cross-product into memory or silently truncating.
  const nest = (n) => "{a,".repeat(n) + "z" + "}".repeat(n) + ".ts";
  ok(m("{a,{b,{c,d}}}.ts", "d.ts"), "nested braces match through every level");
  let accepted10 = true;
  try { new Bun.Glob(nest(10)); } catch { accepted10 = false; }
  ok(accepted10, "braces nested 10 deep are accepted (the documented limit)");
  let depthMsg = "";
  try { new Bun.Glob(nest(11)); } catch (e) { depthMsg = e.message; }
  ok(depthMsg.indexOf("10") !== -1, "braces nested 11 deep throw naming the limit");

  // scan()/scanSync() used to throw here (they needed a VFS directory walk). They
  // are implemented now — the walk, its pruning and its option matrix are checked
  // at the end of this file against an in-memory tree, and against the real Wasm
  // VFS in scripts/spike-bun.mjs.
  ok(typeof new Bun.Glob("**/*.ts").scan === "function", "Bun.Glob.scan() exists");
  ok(new Bun.Glob("*.ts").match("index.ts"), "constructing a Glob is still safe after touching scan");
}

console.log("== Bun.deepEquals: loose vs strict ==");
{
  // `strict` used to be accepted and ignored, which made expect().toStrictEqual()
  // identical to expect().toEqual(). For a test-runner shim that is the worst
  // available direction to be wrong in: the suite goes green here and red under real
  // Bun. Every case below is from https://bun.com/docs/runtime/utils#bun-deepequals.
  const Bun = freshBun();
  const eq = Bun.deepEquals;

  const a = { entries: [1, 2] };
  const b = { entries: [1, 2], extra: undefined };
  ok(eq(a, b) === true, "loose: an explicitly-undefined property is ignored (documented)");
  ok(eq(a, b, true) === false, "strict: an explicitly-undefined property makes them unequal (documented)");
  ok(eq({}, { a: undefined }, true) === false, "strict: {} != {a: undefined} (documented)");
  ok(eq(["asdf"], ["asdf", undefined], true) === false, "strict: undefined padding in an array counts (documented)");
  ok(eq([, 1], [undefined, 1], true) === false, "strict: a sparse hole != an explicit undefined (documented)");
  class Foo { constructor() { this.a = 1; } }
  ok(eq(new Foo(), { a: 1 }) === true, "loose: a class instance equals a literal with the same properties");
  ok(eq(new Foo(), { a: 1 }, true) === false, "strict: prototype identity is checked (documented)");

  // Everything below applies in BOTH modes and was simply absent before.
  ok(eq(NaN, NaN) === true, "NaN equals itself");
  ok(eq({ x: NaN }, { x: NaN }) === true, "NaN equals itself inside a structure");
  ok(eq([1, 2], { 0: 1, 1: 2 }) === false, "an array is never equal to an object with the same numeric keys");
  ok(eq(new Date(5), new Date(5)) === true && eq(new Date(5), new Date(6)) === false, "Date compares by time value");
  ok(eq(/a/gi, /a/gi) === true && eq(/a/g, /a/i) === false, "RegExp compares source and flags");
  ok(eq(new Map([["a", 1]]), new Map([["a", 1]])) === true, "Map compares by entries");
  ok(eq(new Map([["a", 1]]), new Map([["a", 2]])) === false, "Map notices a differing value");
  ok(eq(new Set([1, 2]), new Set([2, 1])) === true, "Set compares by membership, not order");
  ok(eq(new Set([1, 2]), new Set([1, 3])) === false, "Set notices a differing member");
  ok(eq(new Uint8Array([1, 2]), new Uint8Array([1, 2])) === true, "TypedArray compares by contents");
  ok(eq(new Uint8Array([1, 2]), new Uint8Array([1, 3])) === false, "TypedArray notices a differing byte");
  ok(eq(new Uint8Array([1, 2]), new Int8Array([1, 2])) === false, "TypedArrays of different types are unequal");
  ok(eq(new Map(), new Set()) === false, "a Map is not a Set");

  // Regression guard for the two checks that predate this change.
  ok(eq({ a: [1, 2] }, { a: [1, 2] }) === true, "the original deep-equal case still holds");
  ok(eq({ a: 1 }, { a: 2 }) === false, "the original unequal case still holds");
}

console.log("== Bun.deepMatch ==");
{
  const Bun = freshBun();
  // Argument order is (subset, object) — the reverse of how the matcher reads, and
  // getting it backwards inverts the assertion without changing its type.
  ok(Bun.deepMatch({ a: 1 }, { a: 1, b: 2 }) === true, "a subset of properties matches");
  ok(Bun.deepMatch({ a: 1, b: 2 }, { a: 1 }) === false, "a superset does not match");
  ok(Bun.deepMatch({ c: { d: 3 } }, { c: { d: 3, e: 4 }, f: 5 }) === true, "matching recurses into nested objects");
  ok(Bun.deepMatch({ c: { d: 9 } }, { c: { d: 3 } }) === false, "a differing nested value fails");
  ok(Bun.deepMatch({ a: [1, 2] }, { a: [1, 2] }) === true, "arrays match element-wise");
  ok(Bun.deepMatch({ a: [1] }, { a: [1, 2] }) === false, "arrays are compared whole, not as a prefix");
}

console.log("== Bun.randomUUIDv7 is a real v7, not crypto.randomUUID ==");
{
  // This used to call crypto.randomUUID(), a v4: the right shape, none of the point.
  // v7 exists so ids sort in creation order and stay friendly to a B-tree index, and
  // nothing in a v4's type or format tells you that you did not get it.
  const Bun = freshBun();
  const id = Bun.randomUUIDv7();
  ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id), "the default encoding is a canonical hex UUID string");
  ok(id[14] === "7", "the version nibble is 7 (a v4 would read 4 here)");
  ok("89ab".indexOf(id[19]) !== -1, "the variant bits are RFC 9562's 0b10");

  // The first 48 bits are a big-endian unix millisecond timestamp. A v4 would have
  // random bits here, so this single check is what separates the two.
  const before = Date.now();
  const now = Bun.randomUUIDv7();
  const after = Date.now();
  const stamp = parseInt(now.slice(0, 8) + now.slice(9, 13), 16);
  ok(stamp >= before && stamp <= after, `the leading 48 bits are the current time in ms (${stamp})`);

  // An explicit timestamp is encoded verbatim, per the documented signature.
  const at = 1730000000000;
  const fixed = Bun.randomUUIDv7("hex", at);
  ok(parseInt(fixed.slice(0, 8) + fixed.slice(9, 13), 16) === at, "an explicit timestamp is encoded verbatim");
  // ...and a DIFFERENT explicit timestamp reseeds rather than being clamped forward
  // to the last one — including a timestamp that moves backwards, which is the whole
  // reason to be able to pass one (backfilling ids for historical rows).
  const earlier = Bun.randomUUIDv7("hex", at - 86400000);
  ok(parseInt(earlier.slice(0, 8) + earlier.slice(9, 13), 16) === at - 86400000, "an earlier explicit timestamp is honoured, not clamped to the previous one");
  ok(earlier < fixed, "ids ordered by their explicit timestamps sort in that order");

  // Monotonicity is the property naive v7 implementations skip, and a burst inside a
  // single millisecond is where they break: the timestamp cannot separate the ids, so
  // the counter has to. 5000 calls also overruns the counter's 12-bit space at least
  // once, exercising the documented "bump the timestamp rather than wrap" rollover.
  const ids = [];
  for (let i = 0; i < 5000; i++) ids.push(Bun.randomUUIDv7());
  let strictlyIncreasing = true;
  for (let i = 1; i < ids.length; i++) if (!(ids[i] > ids[i - 1])) { strictlyIncreasing = false; break; }
  ok(strictlyIncreasing, "5000 ids generated back-to-back are strictly increasing as strings");
  ok(new Set(ids).size === ids.length, "no duplicates across the burst");
  ok(ids.every((s) => s[14] === "7"), "every id in the burst is still version 7");
  // Deliberately not "the FIRST id's millisecond is shared by another": whether the
  // clock ticks between call 1 and call 2 is a coin flip, so that spelling flakes.
  // What the burst has to demonstrate is that SOME millisecond ordered many ids by
  // counter, and 5000 v7 generations cannot span 500 distinct milliseconds.
  const msPrefixes = new Set(ids.map((s) => s.slice(0, 13)));
  ok(msPrefixes.size < ids.length / 10, "the burst really did share milliseconds (so the counter, not the clock, ordered it)");

  // The documented encodings.
  const buf = Bun.randomUUIDv7("buffer");
  ok(Buffer.isBuffer(buf) && buf.length === 16, "'buffer' returns a 16-byte Buffer");
  ok((buf[6] & 0xf0) === 0x70 && (buf[8] & 0xc0) === 0x80, "the buffer form carries the same version and variant bits");
  ok(Buffer.from(Bun.randomUUIDv7("base64"), "base64").length === 16, "'base64' round-trips to 16 bytes");
  ok(Buffer.from(Bun.randomUUIDv7("base64url"), "base64url").length === 16, "'base64url' round-trips to 16 bytes");
  // randomUUIDv7(timestamp) with no encoding is a documented overload.
  const overload = Bun.randomUUIDv7(at + 1);
  ok(typeof overload === "string" && parseInt(overload.slice(0, 8) + overload.slice(9, 13), 16) === at + 1, "randomUUIDv7(timestamp) overload returns a hex string at that time");
  let encMsg = "";
  try { Bun.randomUUIDv7("uuencode"); } catch (e) { encMsg = e.message; }
  ok(encMsg.indexOf("uuencode") !== -1, "an unknown encoding throws instead of silently returning hex");
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

console.log("== bun:test expect matchers are backed by Bun.deepEquals ==");
{
  // toEqual is documented as loose deepEquals and toStrictEqual as strict. Both used
  // to call the same private key-count compare, so toStrictEqual accepted input real
  // Bun rejects — a shim that makes a suite pass here and fail in CI. Now that they
  // route through the real thing, assert the split directly.
  const { modules } = createBunRuntime({
    process: { env: {}, argv: ["bun"], cwd: () => "/", stdout: process.stdout, stderr: process.stderr, stdin: process.stdin },
    Buffer,
    require: nodeRequire,
  });
  const { expect } = modules["bun:test"];
  const passes = (fn) => { try { fn(); return true; } catch { return false; } };

  ok(passes(() => expect({ a: 1 }).toEqual({ a: 1, b: undefined })), "toEqual ignores an undefined-valued property (loose)");
  ok(!passes(() => expect({ a: 1 }).toStrictEqual({ a: 1, b: undefined })), "toStrictEqual does NOT (this is the behaviour change)");
  class Point { constructor() { this.x = 1; } }
  ok(passes(() => expect(new Point()).toEqual({ x: 1 })), "toEqual ignores prototype identity");
  ok(!passes(() => expect(new Point()).toStrictEqual({ x: 1 })), "toStrictEqual checks prototype identity");
  ok(passes(() => expect(NaN).toEqual(NaN)), "toEqual treats NaN as equal to itself");
  ok(passes(() => expect(new Map([["k", 1]])).toEqual(new Map([["k", 1]]))), "toEqual understands a Map");
  ok(!passes(() => expect([1, 2]).toEqual({ 0: 1, 1: 2 })), "toEqual no longer equates an array with a same-keyed object");
  ok(passes(() => expect({ a: 1, b: 2 }).toMatchObject({ a: 1 })), "toMatchObject accepts a subset");
  ok(!passes(() => expect({ a: 1 }).toMatchObject({ a: 1, b: 2 })), "toMatchObject rejects a missing property");
  ok(passes(() => expect({ a: 1 }).not.toStrictEqual({ a: 1, b: undefined })), "negation still composes with the strict matcher");
  // Regression guard: the matchers Phase 0 left alone must be untouched.
  ok(passes(() => expect(1 + 1).toBe(2)) && !passes(() => expect(1).toBe(2)), "toBe still compares by identity");
  ok(passes(() => expect({ a: 1 }).toEqual({ a: 1 })), "the original toEqual case still passes");
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

// ---------------------------------------------------------------------------
// Phase 1 batch A — the data-format APIs (Bun.YAML/TOML/JSON5/JSONL/semver).
// Everything below goes through the real Bun global, so it gates the wiring in
// bun.js as well as the implementations in bun-formats.js. Each block ends with
// the divergences that a stock npm parser gets differently from Bun; those are
// the checks a future refactor would silently undo.
const formatsProc = { env: { PATH: "/bin" }, argv: ["bun", "/app/x.ts"], cwd: () => "/app", stdout: process.stdout, stderr: process.stderr, stdin: process.stdin };
const { Bun: FBun } = createBunRuntime({ process: formatsProc, Buffer, require: nodeRequire });
const jsonEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };

console.log("== Bun.YAML.parse ==");
{
  ok(jsonEq(FBun.YAML.parse("name: John\nage: 30\nhobbies:\n  - a\n  - b\n"), { name: "John", age: 30, hobbies: ["a", "b"] }), "parses a mapping with a nested sequence");

  // Documented shape change: multi-document input returns an ARRAY, single
  // document input returns the document. A caller that assumes one breaks on
  // the other, so both directions are pinned.
  const multi = FBun.YAML.parse("\n---\nname: Document 1\n---\nname: Document 2\n---\nname: Document 3\n");
  ok(Array.isArray(multi) && multi.length === 3 && multi[2].name === "Document 3", "multi-document input returns an array of documents");
  const single = FBun.YAML.parse("---\nname: Document 1\n");
  ok(!Array.isArray(single) && single.name === "Document 1", "a single document (even with an explicit ---) is NOT wrapped in an array");
  // Bun's docs do not pin the no-document case; what matters for a caller is
  // that it is never an array, because that is the branch multi-document input
  // takes. Empty input follows js-yaml's load("") (undefined); a comment-only
  // document keeps YAML's own answer for an empty node (null).
  ok(FBun.YAML.parse("") === undefined && FBun.YAML.parse("# just a comment\n") === null, "empty and comment-only input yield a single value, never an array");

  ok(jsonEq(FBun.YAML.parse("base: &b\n  t: 5\nuse:\n  <<: *b\n  x: 1\n"), { base: { t: 5 }, use: { t: 5, x: 1 } }), "anchors, aliases and the << merge key");
  ok(jsonEq(FBun.YAML.parse("lit: |\n  l1\n  l2\nfold: >\n  f1\n  f2\n"), { lit: "l1\nl2\n", fold: "f1 f2\n" }), "literal and folded block scalars");
  ok(FBun.YAML.parse("a: !!str 123").a === "123", "an explicit !!str tag");

  // Bun parses YAML 1.2; js-yaml's DEFAULT_SCHEMA is 1.1 and would resolve both
  // of these to non-strings (a Date and `true`). bun-formats.js picks
  // CORE_SCHEMA for exactly this reason — a config value silently changing type
  // between the sandbox and production is the whole failure mode of a shim.
  ok(FBun.YAML.parse("expires: 2001-12-14").expires === "2001-12-14", "YAML 1.2 core: a bare date stays a string, it is not a Date");
  ok(FBun.YAML.parse("debug: yes\nprod: no").debug === "yes", "YAML 1.2 core: `yes` stays a string, it is not a boolean");
  ok(FBun.YAML.parse("a: true\nb: 0x1F\nc: ~").a === true, "YAML 1.2 core still resolves true/hex/null");

  ok(threw(() => FBun.YAML.parse("invalid: yaml: content:")) instanceof SyntaxError, "invalid YAML throws a SyntaxError (js-yaml's YAMLException is not one)");
}

console.log("== Bun.TOML.parse ==");
{
  ok(jsonEq(FBun.TOML.parse('name = "my-app"\n[database]\nport = 5432\n'), { name: "my-app", database: { port: 5432 } }), "scalars and a [table]");
  ok(jsonEq(FBun.TOML.parse("a.b.c = 1\n[[x]]\ny = 1\n[[x]]\ny = 2\n"), { a: { b: { c: 1 } }, x: [{ y: 1 }, { y: 2 }] }), "dotted keys and an array of tables");
  ok(jsonEq(FBun.TOML.parse("h = 0xDEADBEEF\no = 0o14\nb = 0b101\n"), { h: 3735928559, o: 12, b: 5 }), "hex, octal and binary integers");
  ok(FBun.TOML.parse("a = inf\nb = -inf").a === Infinity, "inf floats");
  ok(Number.isNaN(FBun.TOML.parse("n = nan").n), "nan floats");
  ok(jsonEq(FBun.TOML.parse('a = [1, "x", true, [2]]').a, [1, "x", true, [2]]), "mixed-type and nested arrays");
  ok(FBun.TOML.parse("a = 'C:\\x'").a === "C:\\x", "a literal string does not process escapes");
  ok(FBun.TOML.parse("b = \"\"\"\nml\n\"\"\"\n").b === "ml\n", "a multi-line basic string drops the newline after the opening delimiter");

  // The TOML 1.1 syntax Bun's docs list as supported. This is the claim the
  // smol-toml vendor header makes to justify choosing that library, so it is
  // pinned here rather than left as prose: a regenerate that quietly dropped 1.1
  // would otherwise surface as a parse failure in someone's config file.
  ok(jsonEq(FBun.TOML.parse("a = {\n  b = 1,\n  c = 2,\n}\n").a, { b: 1, c: 2 }), "TOML 1.1 multi-line inline tables");
  ok(FBun.TOML.parse('s = "\\x41"').s === "A" && FBun.TOML.parse('s = "\\e"').s === "\u001b", "TOML 1.1 \\xHH and \\e escapes");
  ok(FBun.TOML.parse('s = "\\U0001F600"').s === "\u{1F600}", "\\UHHHHHHHH escapes outside the BMP");

  // THE one that a stock TOML library gets wrong. Most silently return a lossy
  // float, so a snowflake id in a config file "parses successfully" as the wrong
  // number. Bun throws, and so must this.
  ok(threw(() => FBun.TOML.parse("id = 9223372036854775807")) instanceof SyntaxError, "an integer above 2^53-1 THROWS rather than becoming a lossy float");
  ok(threw(() => FBun.TOML.parse("id = -9223372036854775808")) instanceof SyntaxError, "the same below -(2^53-1)");
  ok(threw(() => FBun.TOML.parse("id = 9007199254740992")) instanceof SyntaxError, "2^53 exactly is already unrepresentable, so it throws");
  ok(FBun.TOML.parse("id = 9007199254740991").id === 9007199254740991, "2^53-1 is the largest integer that still parses");

  // Also documented: date/times come back as their SOURCE TEXT, not as Date
  // objects. Round-tripping through a Date loses the offset form and the case.
  const dt = FBun.TOML.parse("odt = 1979-05-27T07:32:00Z\nldt = 1979-05-27T07:32:00\nld = 1979-05-27\nlt = 07:32:00.5\noff = 1979-05-27T00:32:00-07:00\n");
  ok(jsonEq(dt, { odt: "1979-05-27T07:32:00Z", ldt: "1979-05-27T07:32:00", ld: "1979-05-27", lt: "07:32:00.5", off: "1979-05-27T00:32:00-07:00" }), "all four date/time kinds are returned as their source strings, verbatim");
  ok(typeof dt.odt === "string" && !(dt.odt instanceof Date), "a TOML datetime is a string, not a Date");

  ok(threw(() => FBun.TOML.parse("invalid = = =")) instanceof SyntaxError, "invalid TOML throws a SyntaxError (smol-toml's TomlError is not one)");
}

console.log("== Bun.TOML.stringify ==");
{
  // Bun's documented layout: scalars first, then [table], then [[array-of-tables]].
  const doc = FBun.TOML.stringify({ name: "app", server: { host: "localhost", port: 8080 }, points: [{ x: 1 }, { x: 2 }] });
  ok(doc === 'name = "app"\n\n[server]\nhost = "localhost"\nport = 8080\n\n[[points]]\nx = 1\n\n[[points]]\nx = 2\n', "matches Bun's documented output exactly");
  ok(FBun.TOML.parse(doc).points[1].x === 2, "and round-trips through parse");

  // The value rules TOML cannot express. smol-toml disagrees with Bun on all
  // four of these in both directions, which is why stringify normalises first.
  ok(threw(() => FBun.TOML.stringify({ a: null })) instanceof TypeError, "null throws (TOML has no null) rather than being dropped");
  ok(threw(() => FBun.TOML.stringify({ a: 1n })) instanceof TypeError, "a BigInt throws rather than being written as an integer");
  ok(FBun.TOML.stringify({ a: 1, b: undefined, c: () => {}, d: Symbol("s") }) === "a = 1\n", "undefined, function and symbol properties are skipped");
  ok(threw(() => FBun.TOML.stringify({ a: [1, undefined] })) instanceof TypeError, "...but inside an array they throw (TOML arrays cannot have holes)");
  ok(threw(() => FBun.TOML.stringify({ a: [1, , 2] })) instanceof TypeError, "an array hole throws for the same reason");
  const circular = { a: 1 };
  circular.self = circular;
  ok(/circular/.test(String(threw(() => FBun.TOML.stringify(circular)))), "a circular structure throws, and says so");
  const shared = { x: 1 };
  ok(FBun.TOML.stringify({ a: shared, b: shared }).indexOf("[b]") !== -1, "a repeated sibling is not mistaken for a cycle");
  ok(threw(() => FBun.TOML.stringify([1, 2])) instanceof TypeError, "the top-level value must be an object (a TOML document is a table)");
  ok(FBun.TOML.stringify({ at: new Date(Date.UTC(1979, 4, 27, 7, 32, 0)) }) === "at = 1979-05-27T07:32:00.000Z\n", "a Date becomes a TOML offset date-time");
}

console.log("== Bun.JSON5 ==");
{
  const v = FBun.JSON5.parse("{\n  // comment\n  unquoted: 'single',\n  /* block */ hex: 0xDEADbeef,\n  half: .5,\n  plus: +42,\n  to: Infinity,\n  nan: NaN,\n  trailing: [1, 2,],\n}");
  ok(v.unquoted === "single" && v.hex === 3735928559 && v.half === 0.5 && v.plus === 42, "comments, unquoted keys, single quotes, hex, leading-dot and +42");
  ok(v.to === Infinity && Number.isNaN(v.nan) && jsonEq(v.trailing, [1, 2]), "Infinity, NaN and trailing commas");
  ok(FBun.JSON5.parse("{multi: 'line 1 \\\nline 2'}").multi === "line 1 line 2", "backslash line continuations in strings");
  const edges = FBun.JSON5.parse("{trail: 5., neg: -Infinity, signed: +.5}");
  ok(edges.trail === 5 && edges.neg === -Infinity && edges.signed === 0.5, "a trailing decimal point, -Infinity and a signed leading dot");

  ok(FBun.JSON5.stringify({ name: "my-app", version: "1.0.0" }) === "{name:'my-app',version:'1.0.0'}", "stringify matches Bun's compact output (unquoted keys, single quotes)");
  ok(FBun.JSON5.stringify({ name: "my-app", debug: true, tags: ["web", "api"] }, null, 2) === "{\n  name: 'my-app',\n  debug: true,\n  tags: [\n    'web',\n    'api',\n  ],\n}", "stringify with a space argument matches Bun's pretty output, trailing commas included");
  ok(FBun.JSON5.stringify({ inf: Infinity, ninf: -Infinity, nan: NaN }) === "{inf:Infinity,ninf:-Infinity,nan:NaN}", "stringify keeps Infinity/NaN literal where JSON.stringify writes null");
  ok(FBun.JSON5.stringify({ a: 1 }, null, "\t") === "{\n\ta: 1,\n}", "a string `space` argument is used as the indent verbatim, not coerced to a width");

  ok(threw(() => FBun.JSON5.parse("{invalid}")) instanceof SyntaxError, "invalid JSON5 throws a SyntaxError");
}

console.log("== Bun.JSONL ==");
{
  ok(jsonEq(FBun.JSONL.parse('{"id":1}\n{"id":2}\n{"id":3}\n'), [{ id: 1 }, { id: 2 }, { id: 3 }]), "parse returns every value");
  ok(jsonEq(FBun.JSONL.parse('42\n"hello"\ntrue\nnull\n[1,2,3]\n{"k":"v"}\n'), [42, "hello", true, null, [1, 2, 3], { k: "v" }]), "each line may be any JSON value, not just an object");
  ok(jsonEq(FBun.JSONL.parse('{"a":1}'), [{ a: 1 }]), "parse treats end-of-input as terminating the last value");
  ok(jsonEq(FBun.JSONL.parse('{"a":1}\n\n\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]), "blank lines are skipped, not errors");

  // THE asymmetry. These two contracts are deliberately different and one error
  // strategy cannot serve both; implementing them together is how a refactor
  // silently breaks the streaming side.
  ok(threw(() => FBun.JSONL.parse("{invalid}\n")) instanceof SyntaxError, "parse throws when ZERO values parsed");
  const partial = FBun.JSONL.parse('{"a":1}\n{invalid}\n{"b":2}\n');
  ok(jsonEq(partial, [{ a: 1 }]), "parse returns the partial result SILENTLY once at least one value parsed");

  const bad = FBun.JSONL.parseChunk('{"a":1}\n{invalid}\n{"b":2}\n');
  ok(bad.error instanceof SyntaxError && jsonEq(bad.values, [{ a: 1 }]), "parseChunk NEVER throws: the error comes back in .error, with the values parsed before it");
  ok(bad.read === 7 && bad.done === false, "parseChunk reports read=7 (Bun's documented value) and done=false");

  const cut = FBun.JSONL.parseChunk('{"id":1}\n{"id":2}\n{"id":3');
  ok(jsonEq(cut.values, [{ id: 1 }, { id: 2 }]) && cut.read === 17 && cut.done === false && cut.error === null, "an incomplete trailing value is left unconsumed: read=17, done=false, error=null");
  ok(FBun.JSONL.parseChunk('{"a":1}\n').done === true, "a fully consumed chunk reports done");

  // Streaming: slice at `read` and the remainder must parse on the next pass.
  const stream = '{"id":1}\n{"id":2}\n{"id":3';
  const rest = stream.slice(cut.read) + '}\n';
  ok(jsonEq(FBun.JSONL.parseChunk(rest).values, [{ id: 3 }]), "slicing at read and appending the rest resumes correctly");

  const buf = new TextEncoder().encode('{"a":1}\n{"b":2}\n{"c":3}\n');
  ok(jsonEq(FBun.JSONL.parse(buf), [{ a: 1 }, { b: 2 }, { c: 3 }]), "Uint8Array input");
  const fromByte8 = FBun.JSONL.parseChunk(buf, 8);
  ok(jsonEq(fromByte8.values, [{ b: 2 }, { c: 3 }]) && fromByte8.read === 23, "a start byte offset, with read absolute into the original buffer (Bun's documented 23)");
  ok(jsonEq(FBun.JSONL.parseChunk(buf, 0, 8).values, [{ a: 1 }]), "an end byte offset bounds the range");
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"a":1}\n')]);
  ok(jsonEq(FBun.JSONL.parse(bom), [{ a: 1 }]), "a UTF-8 BOM at the head of a buffer is skipped");
  ok(threw(() => FBun.JSONL.parse(42)) instanceof TypeError, "a non string/Uint8Array input is an argument error, not a parse error");
}

console.log("== Bun.semver ==");
{
  const s = FBun.semver;
  ok(s.satisfies("1.0.0", "^1.0.0") === true && s.satisfies("1.0.0", "^1.0.1") === false, "caret ranges");
  ok(s.satisfies("1.0.0", "~1.0.0") === true && s.satisfies("1.0.0", "~1.0.1") === false, "tilde ranges");
  ok(s.satisfies("1.0.0", "1.0.x") === true && s.satisfies("1.0.0", "x.x.x") === true, "x-ranges");
  ok(s.satisfies("1.0.0", "1.0.0 - 2.0.0") === true, "hyphen ranges");
  // Compound and union ranges are where a hand-rolled matcher goes quietly wrong,
  // which is why this reuses the vendored real node-semver.
  ok(s.satisfies("1.5.0", ">=1 <2") === true && s.satisfies("2.5.0", ">=1 <2") === false, "compound ranges");
  ok(s.satisfies("2.1.0", "1 || 2") === true, "union ranges");
  ok(s.satisfies("1.0.0", "nonsense") === false && s.satisfies("not-a-version", "^1.0.0") === false, "an invalid version OR range returns false rather than throwing");

  // node-semver's prerelease rule: a prerelease satisfies a range only if the range
  // itself names a prerelease of the same major.minor.patch. It is the one rule a
  // hand-rolled matcher is most likely to get backwards, and getting it backwards
  // means an alpha build quietly passes a production dependency check.
  ok(s.satisfies("1.0.0-alpha", "^1.0.0") === false, "a prerelease does NOT satisfy a range that names no prerelease");
  ok(s.satisfies("1.0.0-alpha.2", ">=1.0.0-alpha.1") === true, "...but does satisfy one that does");

  ok(s.order("1.0.0", "1.0.0") === 0 && s.order("1.0.0", "1.0.1") === -1 && s.order("1.0.1", "1.0.0") === 1, "order returns 0 / -1 / 1");
  // Deliberately NOT symmetric with satisfies. Bun documents "returns false" for
  // satisfies and says nothing about order, so an unparseable version throws
  // instead of being reported equal — reporting 0 would make an unsortable array
  // come back looking sorted, which is the silent-wrong failure the shim forbids.
  ok(threw(() => s.order("nonsense", "1.0.0")) instanceof TypeError, "order throws on an unparseable version rather than inventing an ordering");
  const unsorted = ["1.0.0", "1.0.1", "1.0.0-alpha", "1.0.0-beta", "1.0.0-rc"];
  ok(jsonEq(unsorted.slice().sort(s.order), ["1.0.0-alpha", "1.0.0-beta", "1.0.0-rc", "1.0.0", "1.0.1"]), "usable directly as Array#sort's comparator, prereleases first");
}

// Phase 1 batch B: text/terminal (bun-text.js) and bytes/streams (bun-bytes.js).
// Every check below goes through the real `Bun` global rather than importing the
// two modules directly, so the wiring in bun.js is gated with the implementations.
// ---------------------------------------------------------------------------

// Build a Bun global over a fake process. `env`/`stdout` are what Bun.color's
// "ansi" depth policy reads, and faking them is the only way to pin that policy
// from a spike that has no terminal of its own.
const bunWith = (env = {}, stdout = { isTTY: false }) =>
  createBunRuntime({
    process: { env, argv: ["bun"], cwd: () => "/", stdout, stderr: process.stderr, stdin: process.stdin },
    Buffer,
    require: nodeRequire,
  }).Bun;

console.log("== Bun.stringWidth / stripANSI / wrapAnsi ==");
{
  // These are the `string-width` problem: the answer is Unicode data, not logic,
  // which is why node/vendor/ansi-text.js bundles the real packages. The checks
  // are the ones a hand-rolled table gets wrong.
  const B = bunWith();

  ok(B.stringWidth("hello") === 5, "stringWidth counts plain ASCII");
  ok(B.stringWidth("") === 0, "stringWidth('') is 0");
  ok(B.stringWidth("\u001b[31mhello\u001b[0m") === 5, "stringWidth ignores ANSI escapes by default");
  ok(
    B.stringWidth("\u001b[31mhello\u001b[0m", { countAnsiEscapeCodes: true }) === 12,
    "stringWidth counts ANSI escapes with countAnsiEscapeCodes (Bun's documented 12)"
  );
  // Full-width and emoji are 2 columns each; a ZWJ family sequence is ONE glyph,
  // so 2 and not 8. This is the check a naive per-code-point counter fails.
  ok(B.stringWidth("古池や") === 6, "stringWidth counts East Asian Wide characters as 2 columns");
  ok(B.stringWidth("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}") === 2, "stringWidth counts a ZWJ emoji family as one 2-column glyph");
  ok(B.stringWidth("a\u0301") === 1, "stringWidth counts a combining mark as 0 columns");

  ok(B.stripANSI("\u001b[1mBold\u001b[0m") === "Bold", "stripANSI removes SGR styling");
  ok(B.stripANSI("plain") === "plain", "stripANSI leaves un-styled text alone");
  ok(
    B.stripANSI("\u001b]8;;https://bun.com\u0007link\u001b]8;;\u0007") === "link",
    "stripANSI removes OSC 8 hyperlinks, not just colours"
  );

  const wrapped = B.wrapAnsi("The quick brown fox jumps over the lazy dog", 20);
  ok(wrapped === "The quick brown fox\njumps over the lazy\ndog", "wrapAnsi word-wraps at the column width");
  ok(wrapped.split("\n").every((l) => B.stringWidth(l) <= 20), "no wrapAnsi row exceeds the requested width");
  // The point of wrap-ansi over a plain split: an open style is closed at the end
  // of each row and re-opened on the next, so every row renders on its own.
  const wrappedAnsi = B.wrapAnsi("\u001b[31mThe quick brown fox jumps over the lazy dog\u001b[39m", 20);
  ok(wrappedAnsi.split("\n").every((l) => l.indexOf("\u001b[31m") !== -1), "wrapAnsi re-opens the active style on every row");
  ok(B.stripANSI(wrappedAnsi) === wrapped, "wrapAnsi wraps styled text at the same points as plain text");
}

console.log("== Bun.color: parsing and the output formats ==");
{
  const B = bunWith();

  // Every input shape Bun documents has to reach the same colour.
  for (const input of ["red", "#f00", "#ff0000", "rgb(255, 0, 0)", "rgba(255, 0, 0, 1)", "hsl(0, 100%, 50%)", "hsla(0, 100%, 50%, 1)"]) {
    ok(B.color(input, "number") === 0xff0000, "color parses " + JSON.stringify(input));
  }
  ok(B.color(0xff0000, "number") === 0xff0000, "color parses a number");
  ok(B.color({ r: 255, g: 0, b: 0 }, "number") === 0xff0000, "color parses an {r,g,b} object");
  ok(B.color([255, 0, 0], "number") === 0xff0000, "color parses an [r,g,b] array");
  ok(B.color("rgb(255 0 0 / 50%)", "rgba") === "rgba(255, 0, 0, 0.5)", "color parses the modern slash-alpha syntax");
  ok(B.color("hwb(0 0% 0%)", "hex") === "#ff0000", "color parses hwb()");

  // Each documented output format, on Bun's own worked example.
  ok(B.color("red", "css") === "red", "css picks the most compact form (the colour name)");
  ok(B.color(0xff0000, "css") === "red", "css normalises a number back to the name");
  ok(B.color("red", "hex") === "#ff0000" && B.color("red", "HEX") === "#FF0000", "hex is lowercase and HEX uppercase");
  ok(B.color("red", "rgb") === "rgb(255, 0, 0)", "rgb format");
  ok(B.color("red", "hsl") === "hsl(0, 100%, 50%)", "hsl format");
  ok(B.color("red", "ansi-16m") === "\u001b[38;2;255;0;0m", "ansi-16m emits a 24-bit escape");
  // tmux's cube/greyscale snap, then the ansi-styles reduction to the base 16.
  ok(B.color("red", "ansi-256") === "\u001b[38;5;196m", "ansi-256 snaps to the tmux 6x6x6 cube (196)");
  ok(B.color("red", "ansi-16") === "\u001b[91m", "ansi-16 reduces via ansi-256 to bright red (91)");
  ok(B.color("hsl(0, 0%, 50%)", "{rgba}").r === 128, "a mid grey rounds to 128, matching Bun's worked example");

  // The object/array asymmetry is in Bun's docs and is the easiest thing here to
  // get backwards: {rgba}.a is 0-1, [rgba][3] is 0-255.
  const objHalf = B.color("rgba(255, 0, 0, 0.5)", "{rgba}");
  const arrHalf = B.color("rgba(255, 0, 0, 0.5)", "[rgba]");
  ok(objHalf.a === 0.5, "{rgba} carries alpha as a 0-1 float");
  ok(arrHalf[3] === 128, "[rgba] carries alpha as a 0-255 integer");
  ok(B.color("red", "{rgb}").a === undefined, "{rgb} omits alpha entirely");
  ok(B.color("red", "[rgb]").length === 3, "[rgb] omits alpha entirely");

  // Unparseable input is `null`, NOT a throw — callers branch on it.
  for (const bad of ["not-a-color", "", "#12345", "rgb(1, 2)", {}, [1, 2], null, undefined, NaN]) {
    ok(B.color(bad, "css") === null, "color returns null for " + JSON.stringify(bad === undefined ? "undefined" : bad));
  }

  // ...which is exactly why the colour spaces we did not implement must THROW:
  // returning null would be indistinguishable from "that is not a colour", and
  // real Bun parses these fine, so a caller would be silently wrong.
  const throwsWith = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };
  for (const fn of ["lab", "lch", "oklab", "oklch", "color", "color-mix"]) {
    const msg = throwsWith(() => B.color(fn + "(50% 50 50)", "hex"));
    ok(/not implemented in the Vivari shim/.test(msg), "color throws (never null) for the unimplemented " + fn + "()");
  }
  ok(/unknown output format/.test(throwsWith(() => B.color("red", "bogus"))), "an unknown output format throws rather than returning null");
}

console.log('== Bun.color(…, "ansi") depth detection ==');
{
  // Bun's "ansi" format detects stdout's colour depth from the environment and
  // returns "" when there is no colour support. Vivari's terminal is virtual, so
  // what this claims is a deliberate policy: reuse the precedence already in
  // node/internal/util/colors.js, the hook util.styleText consults, so the two
  // cannot disagree about whether colour is on.
  const ansi = (env, stdout) => bunWith(env, stdout).color("red", "ansi");
  const RED16M = "\u001b[38;2;255;0;0m";

  ok(ansi({}, { isTTY: false }) === "", "headless (no env, non-TTY stdout) returns the documented empty string");
  ok(ansi({}, { isTTY: false }) !== null, 'no-colour is "" and not null — null means "not a colour"');

  // The Studio case: kernel-worker.ts exports TERM=xterm-256color + FORCE_COLOR=3,
  // and xterm.js really does render truecolor, so claiming 24-bit is correct.
  ok(ansi({ TERM: "xterm-256color", FORCE_COLOR: "3" }, { isTTY: false }) === RED16M, "the Studio kernel env (FORCE_COLOR=3) claims 24-bit colour");
  ok(ansi({ FORCE_COLOR: "1" }, {}) === "\u001b[91m", "FORCE_COLOR=1 selects the 16-colour depth");
  ok(ansi({ FORCE_COLOR: "2" }, {}) === "\u001b[38;5;196m", "FORCE_COLOR=2 selects the 256-colour depth");
  ok(ansi({ FORCE_COLOR: "" }, {}) === RED16M, "FORCE_COLOR= (empty) is on, as in colors.js");

  // Off switches, in precedence order. NO_COLOR must beat FORCE_COLOR.
  ok(ansi({ FORCE_COLOR: "0" }, { isTTY: true }) === "", "FORCE_COLOR=0 forces colour off even on a TTY");
  ok(ansi({ NO_COLOR: "1", FORCE_COLOR: "3" }, { isTTY: true }) === "", "NO_COLOR wins over FORCE_COLOR");
  ok(ansi({ NODE_DISABLE_COLORS: "1" }, { isTTY: true }) === "", "NODE_DISABLE_COLORS forces colour off");
  ok(ansi({ TERM: "dumb" }, { isTTY: true }) === "", "TERM=dumb forces colour off");
  ok(ansi({ FORCE_COLOR: "nonsense" }, { isTTY: true }) === "", "an unrecognised FORCE_COLOR is off, exactly as colors.js treats it");

  // With nothing forced, follow the stream and then COLORTERM/TERM for the depth.
  ok(ansi({ COLORTERM: "truecolor" }, { isTTY: true }) === RED16M, "a TTY with COLORTERM=truecolor gets 24-bit");
  ok(ansi({ TERM: "xterm-256color" }, { isTTY: true }) === "\u001b[38;5;196m", "a TTY with a -256color TERM gets 256");
  ok(ansi({ TERM: "xterm" }, { isTTY: true }) === "\u001b[91m", "a plain TTY falls back to the base 16");
  ok(ansi({ COLORTERM: "truecolor" }, { isTTY: false }) === "", "COLORTERM alone does not turn colour on for a non-TTY");

  // The depth policy must not leak into the explicit formats: those are what a
  // caller reaches for precisely to bypass detection.
  ok(bunWith({ NO_COLOR: "1" }).color("red", "ansi-16m") === RED16M, "an explicit ansi-16m ignores NO_COLOR");
  ok(bunWith({}).color("nope", "ansi") === null, "an unparseable colour is still null in ansi mode, not \"\"");
}

console.log("== Bun.indexOfLine ==");
{
  // "readline() without the IO", over possibly ill-formed UTF-8. It scans BYTES,
  // which is the whole point: 0x0A can never be a UTF-8 continuation byte, so this
  // is safe on a buffer that was cut mid-sequence.
  const B = bunWith();
  const buf = Buffer.from("ab\ncd\nef");

  ok(B.indexOfLine(buf) === 2, "finds the first newline");
  ok(B.indexOfLine(buf, 0) === 2, "an explicit offset of 0 matches the default");
  ok(B.indexOfLine(buf, 3) === 5, "finds the next newline at or after an offset");
  ok(B.indexOfLine(buf, 2) === 2, "the offset is inclusive");
  ok(B.indexOfLine(buf, 6) === -1, "returns -1 when there is no newline left");
  ok(B.indexOfLine(Buffer.from("no newline here")) === -1, "returns -1 for a buffer with no newline");
  ok(B.indexOfLine(Buffer.from("")) === -1, "returns -1 for an empty buffer");

  // A multi-byte character truncated mid-sequence must not derail the scan.
  const illFormed = Buffer.concat([Buffer.from([0xe5, 0x8f]), Buffer.from("\nrest")]);
  ok(B.indexOfLine(illFormed) === 2, "scans bytes, so ill-formed UTF-8 does not hide the newline");
  ok(B.indexOfLine(new Uint8Array([0x61, 0x0a])) === 1, "accepts a bare Uint8Array");
  ok(B.indexOfLine(new Uint8Array([0x61, 0x0a]).buffer) === 1, "accepts an ArrayBuffer");
  // A view's byteOffset must be respected, not ignored.
  ok(B.indexOfLine(Buffer.from("xx\nyy").subarray(3)) === -1, "respects a view's byteOffset instead of scanning the whole backing store");

  let msg = "";
  try { B.indexOfLine("a string"); } catch (e) { msg = e.message; }
  ok(/expects an ArrayBuffer/.test(msg), "a non-buffer argument throws instead of being coerced");
}

console.log("== Bun.inspect.table / Bun.inspect.custom ==");
{
  const B = bunWith();

  // Bun's documented frame, byte for byte — including the EMPTY header cell above
  // the index column, where Node's console.table prints "(index)".
  const table = B.inspect.table([{ a: 1, b: 2, c: 3 }, { a: 4, b: 5, c: 6 }, { a: 7, b: 8, c: 9 }]);
  ok(
    table ===
      ["┌───┬───┬───┬───┐", "│   │ a │ b │ c │", "├───┼───┼───┼───┤", "│ 0 │ 1 │ 2 │ 3 │", "│ 1 │ 4 │ 5 │ 6 │", "│ 2 │ 7 │ 8 │ 9 │", "└───┴───┴───┴───┘"].join("\n"),
    "inspect.table reproduces Bun's documented frame exactly"
  );
  ok(table.indexOf("(index)") === -1, "the index column header is blank, as in Bun (not Node's \"(index)\")");
  ok(typeof table === "string" && table.indexOf("\n") !== -1, "inspect.table returns a string rather than printing");

  const filtered = B.inspect.table([{ a: 1, b: 2, c: 3 }, { a: 4, b: 5, c: 6 }], ["a", "c"]);
  ok(
    filtered === ["┌───┬───┬───┐", "│   │ a │ c │", "├───┼───┼───┤", "│ 0 │ 1 │ 3 │", "│ 1 │ 4 │ 6 │", "└───┴───┴───┘"].join("\n"),
    "a properties array selects and orders the columns"
  );
  ok(B.inspect.table([{ a: 1, b: 2 }], { colors: true }).indexOf("\u001b[") !== -1, "options in the second position still enable colours");

  // Columns are measured in display columns, not code units, so a CJK or emoji
  // cell still lines up. This is why inspect.table uses stringWidth.
  const wide = B.inspect.table([{ k: "古池や" }, { k: "ab" }]).split("\n");
  ok(new Set(wide.map((l) => B.stringWidth(l))).size === 1, "every row is the same display width with full-width cells");

  ok(B.inspect.custom === nodeRequire("node:util").inspect.custom, "inspect.custom is the same registry symbol as util.inspect.custom");
  class Foo { [B.inspect.custom]() { return "foo"; } }
  ok(nodeRequire("node:util").inspect(new Foo()) === "foo", "an object using Bun.inspect.custom is honoured by the runtime's own inspect");
  // Bun.inspect became a function object; it must still be the plain delegate.
  ok(B.inspect({ x: 1 }) === "{ x: 1 }", "Bun.inspect still delegates to util.inspect");
  ok(typeof B.inspect === "function", "Bun.inspect is still callable, not replaced by a namespace object");
}

console.log("== Bun.ArrayBufferSink: the polymorphic flush() ==");
{
  const B = bunWith();

  // THE regression check for this batch. flush()'s return TYPE depends on what
  // start() was given, and a caller that expects bytes and gets a number (or the
  // reverse) fails far away from the mistake:
  //   no start()/no stream            -> a NUMBER, bytes written since last flush
  //   start({stream:true})            -> an ArrayBuffer
  //   start({stream:true, asUint8Array:true}) -> a Uint8Array
  const buffered = new B.ArrayBufferSink();
  buffered.start({});
  buffered.write("hel");
  const bufferedFlush = buffered.flush();
  ok(typeof bufferedFlush === "number", "flush() without stream:true returns a NUMBER, not bytes");
  ok(bufferedFlush === 3, "that number is the bytes written since the last flush");
  ok(buffered.flush() === 0, "a second flush() reports 0, the counter having reset");
  // Buffer mode must NOT drain: end() still owes the caller everything written.
  ok(new TextDecoder().decode(buffered.end()) === "hel", "flush() in buffer mode does not drain — end() still returns everything");

  const defaulted = new B.ArrayBufferSink();
  defaulted.write("hi");
  ok(typeof defaulted.flush() === "number", "a sink that was never start()ed also flushes to a number");

  const streamed = new B.ArrayBufferSink();
  streamed.start({ stream: true });
  streamed.write("h"); streamed.write("e"); streamed.write("l");
  const first = streamed.flush();
  ok(first instanceof ArrayBuffer, "flush() with stream:true returns an ArrayBuffer");
  ok(new TextDecoder().decode(first) === "hel", "...containing everything written so far");
  streamed.write("l"); streamed.write("o");
  ok(new TextDecoder().decode(streamed.flush()) === "lo", "stream mode DRAINS: the next flush only sees later writes");

  const streamedU8 = new B.ArrayBufferSink();
  streamedU8.start({ stream: true, asUint8Array: true });
  streamedU8.write("hi");
  const u8 = streamedU8.flush();
  ok(u8 instanceof Uint8Array, "flush() with stream:true + asUint8Array returns a Uint8Array");
  ok(new TextDecoder().decode(u8) === "hi", "...with the same bytes");

  // end() is the simpler polymorphism: ArrayBuffer, or Uint8Array on request.
  const plain = new B.ArrayBufferSink();
  // Note: an ArrayBuffer chunk is taken WHOLE, so this cannot be spelled
  // `Buffer.from("lo").buffer` the way Bun's doc example does — that is a view
  // into Node's shared 8 KB pool and would write all 8192 bytes.
  plain.write("h"); plain.write(new Uint8Array([101, 108])); plain.write(new Uint8Array([108, 111]).buffer);
  const ended = plain.end();
  ok(ended instanceof ArrayBuffer, "end() returns an ArrayBuffer by default");
  ok(new TextDecoder().decode(ended) === "hello", "write() accepts strings, typed arrays and ArrayBuffers alike");

  const asU8 = new B.ArrayBufferSink();
  asU8.start({ asUint8Array: true });
  asU8.write("hello");
  ok(asU8.end() instanceof Uint8Array, "end() returns a Uint8Array with asUint8Array");

  // highWaterMark is a preallocation hint; accepting and ignoring it is a
  // performance difference with no observable behaviour change.
  const hwm = new B.ArrayBufferSink();
  hwm.start({ highWaterMark: 1024 * 1024, asUint8Array: true });
  hwm.write("ok");
  ok(hwm.end().length === 2, "highWaterMark is accepted and does not change the result");

  ok(new B.ArrayBufferSink().write("héllo") === 5 + 1, "write() returns BYTES written, not characters");

  const throwsWith = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };
  const closed = new B.ArrayBufferSink();
  closed.write("x"); closed.end();
  ok(/after end\(\)/.test(throwsWith(() => closed.write("y"))), "write() after end() throws instead of silently dropping data");
  ok(/expects a string/.test(throwsWith(() => new B.ArrayBufferSink().write(42))), "write(number) throws instead of String()-ing it into bytes");
  // The returned buffer must be standalone: Buffer.from(string) is a slice of an
  // 8 KB pool, so handing back `.buffer` would leak neighbouring writes.
  const detached = new B.ArrayBufferSink();
  detached.write("abc");
  ok(detached.end().byteLength === 3, "end() returns a right-sized buffer, not a view onto Node's shared pool");
}

console.log("== Bun.readableStreamTo* ==");
{
  const B = bunWith();
  const enc = (s) => new TextEncoder().encode(s);
  const streamOf = (chunks) => new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(x); c.close(); } });

  ok((await B.readableStreamToText(streamOf([enc("hel"), enc("lo")]))) === "hello", "readableStreamToText concatenates byte chunks");
  ok((await B.readableStreamToText(streamOf(["a", "b"]))) === "ab", "readableStreamToText joins string chunks");
  // A multi-byte character split across two chunks must survive: decode once over
  // the joined bytes, never per chunk.
  ok((await B.readableStreamToText(streamOf([new Uint8Array([0xe5, 0x8f]), new Uint8Array([0xa4])]))) === "古", "a UTF-8 character split across chunks decodes correctly");

  const json = await B.readableStreamToJSON(streamOf([enc('{"a":'), enc("1}")]));
  ok(json.a === 1, "readableStreamToJSON parses across a chunk boundary");

  const arr = await B.readableStreamToArray(streamOf(["a", "b"]));
  ok(Array.isArray(arr) && arr.length === 2 && arr[0] === "a", "readableStreamToArray returns the chunks untouched");

  const bytes = await B.readableStreamToBytes(streamOf([enc("hi")]));
  ok(bytes instanceof Uint8Array && bytes.length === 2, "readableStreamToBytes returns a Uint8Array");
  const ab = await B.readableStreamToArrayBuffer(streamOf([enc("hi")]));
  ok(ab instanceof ArrayBuffer && ab.byteLength === 2, "readableStreamToArrayBuffer returns an ArrayBuffer");
  const blob = await B.readableStreamToBlob(streamOf([enc("hi")]));
  ok(blob instanceof Blob && (await blob.text()) === "hi", "readableStreamToBlob returns a Blob");

  // No boundary -> x-www-form-urlencoded; a boundary -> multipart/form-data.
  const urlencoded = await B.readableStreamToFormData(streamOf([enc("a=1&b=2")]));
  ok(urlencoded.get("a") === "1" && urlencoded.get("b") === "2", "readableStreamToFormData parses urlencoded bodies with no boundary");
  const multipart = '--X\r\nContent-Disposition: form-data; name="q"\r\n\r\nhi\r\n--X--\r\n';
  ok((await B.readableStreamToFormData(streamOf([enc(multipart)]), "X")).get("q") === "hi", "a boundary argument switches to multipart/form-data");

  // BunFile.stream() can fall back to a Node Readable when Readable.toWeb is
  // unavailable, and a Node Readable is async-iterable but has no getReader().
  ok((await B.readableStreamToText((async function* () { yield enc("ab"); })())) === "ab", "the consumers also accept a plain async iterable");
  ok((await B.readableStreamToText(streamOf([]))) === "", "an empty stream reads as empty, not as a hang or a throw");

  let msg = "";
  try { await B.readableStreamToText(42); } catch (e) { msg = e.message; }
  ok(/expects a ReadableStream/.test(msg), "a non-stream argument throws naming the API");
}

console.log("== Bun.concatArrayBuffers / Bun.allocUnsafe ==");
{
  const B = bunWith();
  const enc = (s) => new TextEncoder().encode(s);
  const text = (b) => new TextDecoder().decode(b);

  const joined = B.concatArrayBuffers([enc("ab"), enc("cd")]);
  ok(joined instanceof ArrayBuffer, "concatArrayBuffers returns an ArrayBuffer by default");
  ok(text(joined) === "abcd", "...with the inputs in order");
  ok(B.concatArrayBuffers([enc("ab")], undefined, true) instanceof Uint8Array, "the third argument returns a Uint8Array instead");
  ok(text(B.concatArrayBuffers([enc("ab"), enc("cd")], 3)) === "abc", "maxLength truncates the result");
  ok(B.concatArrayBuffers([]).byteLength === 0, "concatenating nothing gives an empty buffer");
  ok(text(B.concatArrayBuffers([enc("ab").buffer, enc("cd")])) === "abcd", "ArrayBuffers and typed arrays can be mixed");

  let msg = "";
  try { B.concatArrayBuffers(enc("ab")); } catch (e) { msg = e.message; }
  ok(/expects an array/.test(msg), "concatArrayBuffers(non-array) throws instead of guessing");

  // Bun's allocUnsafe hands back genuinely uninitialised memory. There is no such
  // primitive in JavaScript — `new Uint8Array(n)` is SPECIFIED to be zero-filled —
  // so this is safer than Bun's and slower. A performance-contract difference, not
  // a behavioural one, and pinned here so nobody "fixes" it into a throw.
  const unsafe = B.allocUnsafe(8);
  ok(unsafe instanceof Uint8Array && unsafe.length === 8, "allocUnsafe returns a Uint8Array of the requested size");
  ok(unsafe.every((b) => b === 0), "allocUnsafe is zero-filled here (safer and slower than real Bun, never wrong)");
  ok(B.allocUnsafe(0).length === 0, "allocUnsafe(0) is an empty array, not an error");
  try { msg = ""; B.allocUnsafe(-1); } catch (e) { msg = e.message; }
  ok(/non-negative/.test(msg), "allocUnsafe(-1) throws");
}

console.log("== async-generator Response bodies (inherited, not shimmed) ==");
{
  // Bun documents async generators as a body source for Response/Request. This
  // ALREADY works through the existing Bun.serve path — that path hands the
  // handler's Response to Node's http server untouched, and the Response ctor is
  // the platform's, which accepts any async iterable. So batch B added no code
  // here; these checks exist because "works today by inheritance" is exactly what
  // a future Response polyfill would silently take away.
  ok((await new Response((async function* () { yield "hello"; yield "world"; })()).text()) === "helloworld", "a called async generator is accepted as a Response body");
  ok(
    (await new Response({ [Symbol.asyncIterator]: async function* () { yield "hello"; yield "world"; } }).text()) === "helloworld",
    "an object with [Symbol.asyncIterator] is accepted too"
  );
  ok((await new Response((async function* () { yield new TextEncoder().encode("hi"); })()).text()) === "hi", "a generator yielding bytes is accepted");

  // Known divergence: the generator FUNCTION itself is not a body source (it
  // stringifies). Bun does not document that form either, and it is unfixable from
  // Bun.serve — by then the body is already encoded. Pinned so it stays known.
  ok((await new Response(async function* () { yield "x"; }).text()).indexOf("yield") !== -1, "passing the generator FUNCTION (not calling it) still stringifies — a known divergence");

  // And the round trip a Bun.serve handler actually performs.
  const B = bunWith();
  ok((await B.readableStreamToText(new Response((async function* () { yield "str"; yield "eam"; })()).body)) === "stream", "Bun.readableStreamToText consumes an async-generator Response body");
}

console.log("== import.meta: the Node members are unconditional, Bun's are gated ==");
{
  // The prelude esm.js prepends to every ESM module. Evaluated here against a stub
  // require/module, which is the whole reason importMetaSource is exported: the
  // members below are decided by generated source, and a kernel run can only tell
  // you that SOMETHING is wrong with it.
  const src = importMetaSource("file:///app/src/index.ts", "/app/src/index.ts");
  ok(src.indexOf("\n") === -1, "the prelude stays on one line (user line numbers are preserved)");

  const entry = { id: "entry" };
  const stubRequire = () => ({});
  stubRequire.resolve = (s, o) => "R:" + s + ":" + ((o && o.paths && o.paths[0]) || "-");
  Object.defineProperty(stubRequire, "main", { configurable: true, get: () => entry });
  const evalMeta = (source, req, mod) =>
    new Function("__oc_require", "__oc_module", source + "return __oc_meta;")(req, mod);

  delete globalThis.Bun;
  const nodeMeta = evalMeta(src, stubRequire, entry);
  ok(nodeMeta.url === "file:///app/src/index.ts" && nodeMeta.filename === "/app/src/index.ts", "url + filename unchanged for a plain node process");
  ok(nodeMeta.dirname === "/app/src" && typeof nodeMeta.resolve === "function", "dirname + resolve unchanged too");
  // The gate, stated as a behaviour: `import.meta.env` must NOT exist under node.
  // Vite SSR code reads `import.meta.env.MODE`; today that throws a TypeError it
  // can act on, and an always-on alias of process.env would make it read
  // `undefined` instead — a wrong answer wearing the right type.
  ok(!("env" in nodeMeta), "import.meta.env is absent under node (it is not a Node member)");
  ok(!("main" in nodeMeta) && !("dir" in nodeMeta) && !("file" in nodeMeta) && !("path" in nodeMeta), "dir/file/path/main are absent under node too");

  globalThis.Bun = { version: BUN_VERSION };
  try {
    const meta = evalMeta(src, stubRequire, entry);
    ok(meta.path === "/app/src/index.ts", "Bun: import.meta.path is the absolute path to the module");
    ok(meta.dir === "/app/src", "Bun: import.meta.dir is its directory (no trailing slash)");
    ok(meta.file === "index.ts", "Bun: import.meta.file is the basename WITH extension");
    ok(meta.env === process.env, "Bun: import.meta.env is an alias of process.env, not a copy");
    ok(meta.main === true, "Bun: import.meta.main is true for the module the loader published as the entry");
    ok(evalMeta(src, stubRequire, { id: "other" }).main === false, "Bun: import.meta.main is false for any other module");

    // Identity, not string comparison: a bin shim / symlink / realpath rewrite
    // routinely makes argv[1] differ from the file that was actually loaded, so a
    // path compare would answer confidently and wrongly.
    const shimmed = { id: "entry-realpath" };
    const shimRequire = () => ({});
    Object.defineProperty(shimRequire, "main", { configurable: true, get: () => shimmed });
    ok(evalMeta(src, shimRequire, shimmed).main === true, "main follows the loader's entry module even when the path would disagree");

    // Loud when unanswerable: a require with no entry-module seam cannot say
    // whether this file is the entrypoint, and `false` would be a plausible lie.
    let mainMsg = "";
    try { evalMeta(src, () => ({}), entry).main; } catch (e) { mainMsg = e.message; }
    ok(/import\.meta\.main cannot be determined/.test(mainMsg), "main throws (naming itself) when the loader link is missing: " + mainMsg.slice(0, 40) + "…");

    ok(meta.resolveSync("./sibling.ts") === "R:./sibling.ts:-", "resolveSync(specifier) resolves through the loader");
    ok(meta.resolveSync("./sibling.ts", "file:///other/mod.js") === "R:./sibling.ts:/other", "resolveSync(specifier, parent) resolves from the parent module's directory");
    ok(meta.resolveSync("./s.ts", "/other/mod.js") === "R:./s.ts:/other", "a plain path parent works as well as a file: URL");
    ok(meta.resolveSync("./s.ts", "mod.js") === "R:./s.ts:.", "a parent with no directory part resolves from '.', the same answer path.dirname gives");
    let resMsg = "";
    try { evalMeta(src, () => ({}), entry).resolveSync("x"); } catch (e) { resMsg = e.message; }
    ok(/resolveSync is unavailable/.test(resMsg), "resolveSync throws rather than echoing the specifier back when there is no resolver");

    // Path edge cases the dir/file split has to get right.
    const rootMeta = evalMeta(importMetaSource("file:///x.ts", "/x.ts"), stubRequire, entry);
    ok(rootMeta.dir === "/" && rootMeta.file === "x.ts", "a file at the VFS root has dir '/' (not '')");
    const bareMeta = evalMeta(importMetaSource("file://mod.js", "mod.js"), stubRequire, entry);
    ok(bareMeta.dir === "." && bareMeta.file === "mod.js", "a bare filename has dir '.'");

    // And the wiring: the transpiler must actually point `import.meta` at it.
    const out = transpileEsm("export const d = import.meta.dir;\n", "/app/a.js");
    ok(/__oc_meta\.dir/.test(out) && /__oc_meta\.path/.test(out), "transpileEsm rewrites import.meta.dir to the object built above");
  } finally {
    delete globalThis.Bun;
  }
}

console.log("== Bun.resolveSync resolves from the root it is given ==");
{
  // Pinning `Bun.resolveSync` alongside import.meta.resolveSync because the two
  // take DIFFERENT second arguments and used to be confusable: Bun.resolveSync's
  // is a directory ("pass import.meta.dir"), import.meta.resolveSync's is the
  // importing file (Bun's typings define it as
  // `Bun.resolveSync(moduleId, path.dirname(parent))`). Bun.resolveSync accepted
  // the root and then dropped it, which is not a resolution failure anyone can
  // see — it is a real absolute path to the wrong file.
  const bunWith = (resolve) => {
    const proc = { env: {}, argv: ["bun"], cwd: () => "/", stdout: process.stdout, stderr: process.stderr, stdin: process.stdin };
    const req = (id) => nodeRequire(id);
    if (resolve) req.resolve = resolve;
    return createBunRuntime({ process: proc, Buffer, require: req }).Bun;
  };
  const B = bunWith((id, o) => "R:" + id + ":" + ((o && o.paths && o.paths[0]) || "-"));
  ok(B.resolveSync("./target.ts", "/path/to/project") === "R:./target.ts:/path/to/project", "Bun.resolveSync(specifier, root) resolves from that root DIRECTORY (not its parent)");
  ok(B.resolveSync("zod") === "R:zod:-", "one argument resolves from the runtime's own base, as before");
  ok((await B.resolve("./target.ts", "/root/dir")) === "R:./target.ts:/root/dir", "the async Bun.resolve honours the root too");

  let msg = "";
  try { bunWith(null).resolveSync("zod"); } catch (e) { msg = e.message; }
  ok(/Bun\.resolveSync is unavailable/.test(msg), "with no resolver at all it throws instead of echoing the specifier back: " + msg.slice(0, 40) + "…");
}

console.log("== .env auto-loading: the file set and its precedence ==");
{
  // Bun's three modes, from BUN_ENV ?? NODE_ENV. Anything that is not an exact
  // 'production' or 'test' is development — INCLUDING a real value like
  // 'staging', which therefore reads .env.development and never .env.staging.
  ok(bunEnvMode({}) === "development", "unset NODE_ENV means development");
  ok(bunEnvMode({ NODE_ENV: "production" }) === "production", "NODE_ENV=production");
  ok(bunEnvMode({ NODE_ENV: "test" }) === "test", "NODE_ENV=test");
  ok(bunEnvMode({ NODE_ENV: "staging" }) === "development", "NODE_ENV=staging is development (Bun has only three modes)");
  ok(bunEnvMode({ NODE_ENV: "production", BUN_ENV: "test" }) === "test", "BUN_ENV wins over NODE_ENV");

  // Load order IS decreasing precedence: each file is applied without overriding a
  // key that is already set. Reversing this list is the silent failure mode — every
  // file still "loads", the values are just wrong.
  ok(
    bunEnvFiles({}).join(",") === ".env.development.local,.env.local,.env.development,.env",
    "development load order: .env.development.local > .env.local > .env.development > .env"
  );
  ok(
    bunEnvFiles({ NODE_ENV: "production" }).join(",") === ".env.production.local,.env.local,.env.production,.env",
    "production load order"
  );
  // Documented in Bun's own docs: .env.local is machine-local developer state, so a
  // test run must not inherit it.
  ok(bunEnvFiles({ NODE_ENV: "test" }).indexOf(".env.local") === -1, "NODE_ENV=test does NOT read .env.local");
  ok(
    bunEnvFiles({ NODE_ENV: "test" }).join(",") === ".env.test.local,.env.test,.env",
    "test load order keeps .env.test.local, which is not the same file"
  );

  // `bun test` is Bun's test MODE even with NODE_ENV unset: it picks the test file
  // set first and only defaults NODE_ENV to 'test' afterwards ("unless it is
  // already set in the environment or in .env files" —
  // https://bun.com/docs/test/runtime-behavior). Deriving the mode from NODE_ENV
  // at that point would read .env.local, and a suite would then pass on the laptop
  // that has one and fail in CI (oven-sh/bun#9877). Hence the explicit override.
  ok(
    bunEnvFiles({}, "test").join(",") === ".env.test.local,.env.test,.env",
    "an explicit test mode selects the test set even though NODE_ENV is unset"
  );
  ok(bunEnvFiles({ NODE_ENV: "production" }, "test").indexOf(".env.local") === -1, "the explicit mode wins over NODE_ENV");

  const files = {
    ".env": "SHARED=from-env\nONLY_BASE=base\nMODE_FILE=env\n",
    ".env.development": "SHARED=from-dev\nMODE_FILE=dev\n",
    ".env.local": "SHARED=from-local\n",
    ".env.development.local": "SHARED=from-dev-local\n",
  };
  const reader = (p) => (Object.prototype.hasOwnProperty.call(files, p.replace("/app/", "")) ? files[p.replace("/app/", "")] : null);

  const env = { PRESET: "from-shell", SHARED: undefined };
  delete env.SHARED;
  const loaded = loadBunEnvFiles({ env, cwd: "/app", readFile: reader });
  ok(loaded.map((l) => l.file).join(",") === ".env.development.local,.env.local,.env.development,.env", "all four files were read, in load order");
  ok(env.SHARED === "from-dev-local", "the highest-precedence file that defines a key wins");
  ok(env.ONLY_BASE === "base" && env.MODE_FILE === "dev", "lower-precedence files still contribute the keys nobody else set");

  const shellEnv = { SHARED: "from-shell" };
  loadBunEnvFiles({ env: shellEnv, cwd: "/app", readFile: reader });
  ok(shellEnv.SHARED === "from-shell", "a variable already in the environment beats every .env file");

  const testEnv = { NODE_ENV: "test" };
  loadBunEnvFiles({ env: testEnv, cwd: "/app", readFile: (p) => (p === "/app/.env.local" ? "SHARED=leaked\n" : p === "/app/.env" ? "SHARED=from-env\n" : null) });
  ok(testEnv.SHARED === "from-env", "under NODE_ENV=test the .env.local value really is not applied");

  const forcedTest = {};
  loadBunEnvFiles({
    env: forcedTest,
    cwd: "/app",
    mode: "test",
    readFile: (p) => (p === "/app/.env.local" ? "SHARED=leaked\n" : p === "/app/.env" ? "SHARED=from-env\n" : null),
  });
  ok(forcedTest.SHARED === "from-env", "a forced test mode skips .env.local without needing NODE_ENV set first");

  ok(loadBunEnvFiles({ env: {}, cwd: "/app", readFile: () => null }).length === 0, "no .env files present is not an error");
  ok(loadBunEnvFiles({ env: {}, cwd: "/app", readFile: () => { throw new Error("EIO"); } }).length === 0, "an unreadable .env file is skipped, not fatal");
}

console.log("== .env parsing: Bun's dialect, not 'some dotenv' ==");
{
  const p = (s) => Object.fromEntries(parseDotenv(s));
  ok(p("A=1\nB=2\n").A === "1" && p("A=1\nB=2\n").B === "2", "plain KEY=VALUE lines");
  ok(p("# c\n\n  A=1\n").A === "1", "comments and blank lines are skipped");
  ok(p("export A=1\n").A === "1", "a leading `export ` is stripped");
  ok(p("A: 1\n").A === "1", "the `KEY: value` form (colon + whitespace) is accepted");
  ok(p("A:1\n").A === undefined, "`KEY:value` without the space is NOT a key (so host:port survives on the right of an =)");
  ok(p("A=host:1234\n").A === "host:1234", "a colon inside a value is untouched");
  ok(p("A=  spaced  \n").A === "spaced", "an unquoted value is trimmed");
  ok(p('A="  spaced  "\n').A === "  spaced  ", "a quoted value keeps its whitespace");
  ok(p("A='v'\nB=`v`\nC=\"v\"\n").A === "v" && p("A='v'\nB=`v`\nC=\"v\"\n").B === "v", "single, double and BACKTICK quotes all work (Bun accepts all three)");
  ok(p("A=x # trailing\n").A === "x", "an inline comment is stripped from an unquoted value");
  ok(p("A=a#b\n").A === "a", "`#` needs no leading space — Bun cuts at it, dotenv would keep a#b");
  ok(p('A="a#b"\n').A === "a#b", "…but not inside quotes");
  ok(p('A="l1\nl2"\n').A === "l1\nl2", "a double-quoted value may span lines");
  ok(p('A="a\\nb"\n').A === "a\nb", "\\n is unescaped inside double quotes");
  ok(p("A='a\\nb'\n").A === "a\\nb", "…and stays literal inside single quotes");
  ok(p('A="a\\qb"\n').A === "a\\qb", "an unknown escape is kept verbatim");
  ok(p("A=1\nA=2\n").A === "2", "within ONE file the later assignment wins (oven-sh/bun#1262)");
  ok(p("A.B-C=1\n")["A.B-C"] === "1", "`.` and `-` are legal key characters");
  ok(p("=novalue\nA=1\n").A === "1", "a malformed line is skipped without derailing the rest of the file");
  ok(p("A=\n").A === "", "an empty value is an empty string");
}

console.log("== .env expansion: $VAR, ${VAR}, ${VAR:-default}, \\$ ==");
{
  const look = { FOO: "world", EMPTY: "" };
  const x = (v) => expandDotenvValue(v, (k) => look[k]);
  ok(x("hello$FOO") === "helloworld", "$VAR is expanded (the documented example)");
  ok(x("hello${FOO}!") === "helloworld!", "${VAR} is expanded");
  ok(x("$FOO-$FOO") === "world-world", "several references in one value");
  ok(x("a$MISSING b") === "a b", "an unset variable expands to nothing");
  ok(x("${MISSING:-fallback}") === "fallback", "${VAR:-default} supplies a default");
  ok(x("${FOO:-fallback}") === "world", "…and is ignored when the variable is set");
  ok(x("hello\\$FOO") === "hello$FOO", "\\$ suppresses expansion and the backslash is dropped");
  ok(x("costs 5$") === "costs 5$", "a trailing $ is literal (Bun's scan starts one character in)");
  ok(x("$FOO") === "world", "a value that is nothing but a reference");
  ok(x("$") === "$", "a lone $ is left alone");
  // postgres://$DB_USER:$DB_PASSWORD@$DB_HOST — the docs' own worked example.
  const env = {};
  applyDotenv(env, "DB_USER=postgres\nDB_PASSWORD=secret\nDB_HOST=localhost\nDB_URL=postgres://$DB_USER:$DB_PASSWORD@$DB_HOST/db\n");
  ok(env.DB_URL === "postgres://postgres:secret@localhost/db", "the docs' connection-string example composes");

  // Expansion runs in file order, so a reference to a key defined EARLIER sees the
  // expanded value and one defined LATER sees the raw text. Bun's order; pinned so
  // a "tidier" two-pass rewrite cannot silently change it.
  const ordered = {};
  applyDotenv(ordered, "A=1\nB=$A/2\n");
  ok(ordered.B === "1/2", "a backward reference resolves");
  const backwards = {};
  applyDotenv(backwards, "B=$A/2\nA=1\n");
  ok(backwards.B === "1/2", "a forward reference resolves against the raw value parsed from the same file");

  // Expansion looks at the whole environment, and single quotes do NOT stop it.
  const withShell = { SHELL_VAR: "s" };
  applyDotenv(withShell, "A=$SHELL_VAR\nB='$SHELL_VAR'\n");
  ok(withShell.A === "s", "a .env value can reference a variable from the environment");
  ok(withShell.B === "s", "Bun expands inside single quotes too (dotenv-expand does not)");

  // applyDotenv must not touch a key that is already set, and must not expand it.
  const preset = { KEEP: "$FOO" };
  applyDotenv(preset, "KEEP=overwritten\nNEW=$KEEP\n");
  ok(preset.KEEP === "$FOO", "an existing key is neither overwritten nor re-expanded");
  ok(preset.NEW === "$FOO", "…and a reference to it reads what the environment actually holds");
}

console.log("== Bun.sleepSync parks instead of spinning ==");
{
  // In Node (and in a Web Worker) Atomics.wait is permitted, so the real park is
  // exercised here rather than mocked.
  ok(canPark() === true, "Atomics.wait parking is available on this thread");
  const t0 = Date.now();
  ok(parkFor(30) === true, "parkFor reports that it really parked");
  ok(Date.now() - t0 >= 25, "…and the wall clock advanced by roughly the requested time");
  ok(parkFor(0) === true, "parkFor(0) is a no-op that still reports the capability");

  const calls = [];
  const parked = createSleepSync({ park: (ms) => { calls.push(ms); return true; } });
  parked(5);
  ok(calls.length === 1 && calls[0] === 5, "sleepSync delegates to the park primitive");
  parked(1.9);
  ok(calls[1] === 1, "the duration is coerced to i32 exactly as Bun does (1.9 -> 1ms)");
  calls.length = 0;
  parked(0);
  ok(calls.length === 0, "sleepSync(0) returns immediately without parking");

  // The fallback matters as much as the fast path: on a browser MAIN thread
  // Atomics.wait throws, and a sleep that has always worked must not start failing.
  let spun = 0;
  const spinning = createSleepSync({ park: () => false, now: () => (spun += 4) });
  spinning(12);
  ok(spun > 12, "when parking is unavailable it falls back to the spin (slow, never wrong)");

  // Bun's own argument validation (src/bun.js/api/BunObject.zig), reproduced
  // because these throws are Bun's, not sandbox limitations.
  const throws = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };
  ok(/requires 1 argument/.test(throws(() => parked())), "no argument throws");
  ok(/must be of type number/.test(throws(() => parked("10"))), "a string throws (it is not coerced)");
  ok(/must be of type number/.test(throws(() => parked(new Date(Date.now() + 10)))), "a Date throws — that overload belongs to the async Bun.sleep");
  ok(/must not be negative/.test(throws(() => parked(-1))), "a negative duration throws rather than sleeping for 0");

  // And through the Bun global, which is what guest code actually calls.
  const B = freshBun();
  const t1 = Date.now();
  B.sleepSync(25);
  ok(Date.now() - t1 >= 20, "Bun.sleepSync(25) blocks for about 25ms");
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 batch B: Bun.Glob.scan()/scanSync() and Bun.FileSystemRouter.
//
// The walk itself is a VFS thing and scripts/spike-bun.mjs runs it against the
// real Wasm VFS. Everything below runs here anyway because the walker takes its
// filesystem as an argument: an in-memory tree is enough to pin the option
// defaults, the symlink rules, the AsyncIterable/Iterable split, and — the part
// that cannot be checked end-to-end without counting syscalls — that directory
// PRUNING never changes which files come back.
//
// Imported dynamically so this whole batch is one appended block.
// ─────────────────────────────────────────────────────────────────────────────
const {
  splitGlobSegments,
  compileGlobPrefix,
  prefixStart,
  prefixStep,
  prefixCanDescend,
  createBunGlob,
  scanGlobSync,
} = await import("../packages/runtime/builtins/bun-glob.js");
const {
  parseRouteSegment,
  compileFileSystemRoutes,
  matchFileSystemRoute,
  splitPathAndQuery,
  createBunFileSystemRouter,
  SEGMENT_RANK,
} = await import("../packages/runtime/builtins/bun-fsrouter.js");
const nodePath = await import("node:path");

// A tiny in-memory filesystem with exactly the four calls the walker uses, plus
// counters. `spec` maps an absolute path to "file", "dir" or { link: target }.
function makeFakeFs(spec) {
  const nodes = new Map([["/", "dir"]]);
  for (const [p, kind] of Object.entries(spec)) {
    const parts = p.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const dir = "/" + parts.slice(0, i).join("/");
      if (!nodes.has(dir)) nodes.set(dir, "dir");
    }
    nodes.set(p, kind);
  }
  const counts = { readdir: 0, lstat: 0, stat: 0 };
  const enoent = (p) => Object.assign(new Error("ENOENT: no such file or directory, '" + p + "'"), { code: "ENOENT" });
  const stats = (kind) => ({
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => typeof kind === "object" && kind !== null,
    isFile: () => kind === "file",
  });
  const resolve = (p, depth) => {
    if (depth > 20) throw enoent(p);
    const kind = nodes.get(p);
    if (kind === undefined) throw enoent(p);
    if (typeof kind === "object") return resolve(kind.link, depth + 1);
    return p;
  };
  // Every component EXCEPT the last is resolved, which is what lstat does and what
  // makes a path through a symlinked directory (linkdir/index.ts) resolve at all.
  const resolveParent = (p) => {
    const i = p.lastIndexOf("/");
    if (i <= 0) return p;
    return resolve(p.slice(0, i), 0) + "/" + p.slice(i + 1);
  };
  return {
    counts,
    readdirSync(dirPath) {
      counts.readdir++;
      // readdir follows a trailing symlink, like the real one does — which is why
      // the walker's refusal to traverse links has to be the walker's own decision.
      const dir = resolve(dirPath, 0);
      if (nodes.get(dir) !== "dir") throw enoent(dirPath);
      const prefix = dir === "/" ? "/" : dir + "/";
      const out = [];
      for (const p of nodes.keys()) {
        if (!p.startsWith(prefix) || p === dir) continue;
        const rest = p.slice(prefix.length);
        if (rest.indexOf("/") === -1) out.push(rest);
      }
      // Deliberately reversed: the walker is supposed to sort, and a fake fs that
      // hands back sorted names would hide it if it stopped.
      return out.reverse();
    },
    lstatSync(p) {
      counts.lstat++;
      const kind = nodes.get(resolveParent(p));
      if (kind === undefined) throw enoent(p);
      return stats(kind);
    },
    statSync(p) {
      counts.stat++;
      return stats(nodes.get(resolve(resolveParent(p), 0)));
    },
    realpathSync(p) {
      return resolve(resolveParent(p), 0);
    },
  };
}

const TREE = {
  "/app/index.ts": "file",
  "/app/README.md": "file",
  "/app/.hidden.ts": "file",
  "/app/src/index.ts": "file",
  "/app/src/util.ts": "file",
  "/app/src/nested/deep.ts": "file",
  "/app/src/nested/notes.md": "file",
  "/app/test/a.test.ts": "file",
  "/app/node_modules/pkg/index.ts": "file",
  "/app/empty": "dir",
  "/app/linkdir": { link: "/app/src" },
  "/app/broken": { link: "/app/nope" },
};

// A Bun global's Glob, but with the fake filesystem injected where lazy("fs")
// would hand back the runtime's VFS-backed one.
function globWith(fs, cwd = "/app") {
  const lazy = (name) => (name === "fs" ? fs : name === "path" ? nodePath.default : nodeRequire(name));
  return createBunGlob({ lazy, process: { cwd: () => cwd } }).Glob;
}

console.log("== Bun.Glob.scan: pattern segmentation + the prune automaton (pure) ==");
{
  // Splitting happens at top-level `/` only. A `/` inside a brace group or a
  // character class is part of that group — cutting there would build an automaton
  // for a different pattern and silently skip a subtree.
  ok(JSON.stringify(splitGlobSegments("src/**/*.ts")) === '["src","**","*.ts"]', "splitGlobSegments splits on path separators");
  ok(JSON.stringify(splitGlobSegments("{src,test/deep}/**")) === '["{src,test/deep}","**"]', "a `/` inside braces does not split");
  ok(JSON.stringify(splitGlobSegments("[a/b]x/y")) === '["[a/b]x","y"]', "a `/` inside a character class does not split");
  ok(JSON.stringify(splitGlobSegments("a\\/b/c")) === '["a\\\\/b","c"]', "an escaped `/` stays with its segment");

  const plan = compileGlobPrefix("src/*.ts");
  ok(plan.segments.length === 2 && !plan.segments[0].globstar, "a plain segment compiles to a one-component RegExp");
  ok(compileGlobPrefix("**/*.ts").segments[0].globstar === true, "`**` compiles to a globstar state");
  // Ambiguous segments are WIDENED to a globstar. That can only make us look in
  // more places, never fewer, which is the direction a pruner is allowed to be
  // wrong in.
  ok(compileGlobPrefix("{src,test/deep}/**").segments[0].widened === true, "a brace group spanning a `/` widens to a globstar");
  ok(compileGlobPrefix("a**b/c").segments[0].widened === true, "a `**` glued to other characters widens to a globstar");

  // The automaton answers one question: could anything under this directory match?
  const p = compileGlobPrefix("src/*.ts");
  ok(prefixCanDescend(p, prefixStep(p, prefixStart(p), "src")) === true, "src/*.ts: descend into src");
  ok(prefixCanDescend(p, prefixStep(p, prefixStart(p), "docs")) === false, "src/*.ts: do NOT descend into docs");
  const inSrc = prefixStep(p, prefixStart(p), "src");
  ok(prefixCanDescend(p, prefixStep(p, inSrc, "nested")) === false, "src/*.ts: do NOT descend into src/nested (`*` stops at `/`)");
  const gs = compileGlobPrefix("**/*.ts");
  ok(prefixCanDescend(gs, prefixStep(gs, prefixStart(gs), "anything")) === true, "**/*.ts: descend everywhere");
  ok(prefixStart(null) === null && prefixCanDescend(null, null) === true, "a null plan (negated pattern) means descend into everything");
}

console.log("== Bun.Glob.scanSync: results, and pruning that cannot change them ==");
{
  const fs = makeFakeFs(TREE);
  const Glob = globWith(fs);
  const scan = (pattern, opts) => Array.from(new Glob(pattern).scanSync(opts));

  ok(
    JSON.stringify(scan("**/*.ts")) ===
      JSON.stringify(["index.ts", "node_modules/pkg/index.ts", "src/index.ts", "src/nested/deep.ts", "src/util.ts", "test/a.test.ts"]),
    "**/*.ts walks the tree (sorted, relative to cwd, no dotfiles, symlinked dir not traversed)",
  );
  ok(JSON.stringify(scan("*.ts")) === '["index.ts"]', "`*` does not cross a directory boundary during a scan either");
  ok(JSON.stringify(scan("src/*.ts")) === '["src/index.ts","src/util.ts"]', "a rooted pattern returns only that directory");
  ok(JSON.stringify(scan("**/{README,notes}.md")) === '["README.md","src/nested/notes.md"]', "brace alternation works through the walk");

  // Pruning. `src/*.ts` cannot match anything outside src, so the walker must read
  // /app and /app/src and nothing else. In the browser each of those reads is a
  // synchronous syscall across the Atomics bridge, so this is the difference
  // between two round trips and one per directory in the project.
  {
    const counted = makeFakeFs(TREE);
    Array.from(new (globWith(counted))("src/*.ts").scanSync());
    ok(counted.counts.readdir === 2, `src/*.ts reads exactly 2 directories (got ${counted.counts.readdir})`);
    const unpruned = makeFakeFs(TREE);
    Array.from(new (globWith(unpruned))("**/*.ts").scanSync());
    ok(unpruned.counts.readdir > counted.counts.readdir, "an unprunable pattern reads more directories, so the saving is real");
    // Entries that can neither match nor lead to a match are never even lstat-ed.
    ok(counted.counts.lstat <= 3, `src/*.ts lstats at most the entries it might return (got ${counted.counts.lstat})`);
  }

  // The invariant that makes the pruner safe to have at all: for every pattern,
  // scanning equals walking the whole tree and filtering with .match(). If those
  // ever disagree, the pruner is dropping files — the exact failure that would be
  // invisible in a project where the missing file was not the one you looked at.
  {
    const all = Array.from(new Glob("**").scanSync({ onlyFiles: false }));
    const files = new Set(Array.from(new Glob("**").scanSync()));
    for (const pattern of [
      "**/*.ts",
      "src/*.ts",
      "src/**/*.ts",
      "*.ts",
      "**/index.ts",
      "{src,test}/**",
      "**/*.{ts,md}",
      "src/nested/*",
      "!**/*.ts",
      "**/[a-z]*.md",
    ]) {
      const g = new Glob(pattern);
      const expected = all.filter((p) => g.match(p) && files.has(p));
      const got = Array.from(g.scanSync());
      ok(
        JSON.stringify(got) === JSON.stringify(expected),
        `pruned scan(${pattern}) == walk-everything-then-match (${got.length} entries)`,
      );
    }
  }
}

console.log("== Bun.Glob.scan: the documented options ==");
{
  const fs = makeFakeFs(TREE);
  const Glob = globWith(fs);
  const scan = (pattern, opts) => Array.from(new Glob(pattern).scanSync(opts));

  // onlyFiles defaults to TRUE, which is the option people are surprised by.
  ok(JSON.stringify(scan("src/*")) === '["src/index.ts","src/util.ts"]', "onlyFiles defaults to true: src/nested is not returned");
  ok(
    JSON.stringify(scan("src/*", { onlyFiles: false })) === '["src/index.ts","src/nested","src/util.ts"]',
    "onlyFiles: false adds matching directories",
  );

  ok(scan("**/*.ts").indexOf(".hidden.ts") === -1, "dot defaults to false: dotfiles are skipped");
  ok(scan("**/*.ts", { dot: true }).indexOf(".hidden.ts") !== -1, "dot: true includes them");
  // Documented as "allow patterns to match entries that begin with a period", so
  // the filter is on the entry, not on the pattern: spelling the name out does not
  // opt you in. Pinned because it is the kind of rule a later edit would "fix".
  ok(scan(".hidden.ts").length === 0, "a literal dotfile pattern still needs dot: true");

  ok(JSON.stringify(scan("*.ts", { absolute: true })) === '["/app/index.ts"]', "absolute: true returns absolute paths");
  ok(JSON.stringify(scan("*.ts", "/app/src")) === '["index.ts","util.ts"]', "scanSync(root) takes a cwd string, not just an options object");
  ok(JSON.stringify(scan("*.ts", { cwd: "/app/src" })) === '["index.ts","util.ts"]', "...and {cwd} means the same thing");
  ok(JSON.stringify(scan("*.ts", { cwd: "src" })) === '["index.ts","util.ts"]', "a relative cwd resolves against process.cwd()");

  // A cwd that does not exist has to be loud: an empty iterator here reads as "no
  // files matched", which is the wrong answer to a typo'd directory.
  let msg = "";
  try { Array.from(new Glob("*").scanSync("/nope")); } catch (e) { msg = e.message; }
  ok(/ENOENT|no such file/.test(msg), "scanning a nonexistent cwd throws rather than returning nothing");
}

console.log("== Bun.Glob.scan: symlinks ==");
{
  const fs = makeFakeFs(TREE);
  const Glob = globWith(fs);
  const scan = (pattern, opts) => Array.from(new Glob(pattern).scanSync(opts));

  ok(scan("**/*.ts").every((p) => p.indexOf("linkdir/") !== 0), "followSymlinks defaults to false: a symlinked directory is not traversed");
  ok(scan("linkdir/*.ts", { followSymlinks: true }).length === 2, "followSymlinks: true traverses it");
  // A symlink to a directory is a DIRECTORY for onlyFiles purposes even when we
  // refuse to follow it. Calling it a file because we declined to look would be a
  // plausible-looking wrong answer, which is the one thing this shim may not do.
  ok(scan("linkdir").length === 0, "an unfollowed symlink to a directory is not returned as a file");
  ok(JSON.stringify(scan("linkdir", { onlyFiles: false })) === '["linkdir"]', "...it is returned as a directory when onlyFiles is off");

  // Broken symlink: silently skipped by default (that IS the documented default),
  // loud on request, and the message names the path.
  ok(scan("**", { onlyFiles: false }).indexOf("broken") === -1, "a broken symlink is skipped by default");
  let msg = "";
  try { scan("**", { onlyFiles: false, throwErrorOnBrokenSymlink: true }); } catch (e) { msg = e.message; }
  ok(/broken symbolic link/.test(msg) && msg.indexOf("/app/broken") !== -1, "throwErrorOnBrokenSymlink: true throws naming the path");

  // A symlink loop is an infinite walk, and the VFS's own ELOOP guard does not
  // catch it: every single resolution is valid, it is the traversal that never
  // ends. Without the ancestor check this check hangs rather than fails.
  const looped = makeFakeFs({ ...TREE, "/app/loop": { link: "/app" } });
  const found = Array.from(new (globWith(looped))("**/index.ts").scanSync({ followSymlinks: true }));
  ok(found.indexOf("loop/index.ts") !== -1, "a self-referential symlink is entered once");
  ok(found.filter((p) => p.indexOf("loop/loop") === 0).length === 0, "...and not a second time (the cycle terminates)");

  // The cycle guard is realpath-shaped, so a filesystem without realpathSync cannot
  // have one. The failure mode there is not a wrong answer but a walk that never
  // returns — a parked worker and a tab that looks hung — so it is loud.
  const noRealpath = makeFakeFs(TREE);
  delete noRealpath.realpathSync;
  let loopMsg = "";
  try { Array.from(new (globWith(noRealpath))("**/*.ts").scanSync({ followSymlinks: true })); } catch (e) { loopMsg = e.message; }
  ok(/needs fs\.realpathSync/.test(loopMsg), "followSymlinks with no realpathSync throws instead of walking forever");
  ok(Array.from(new (globWith(noRealpath))("**/*.ts").scanSync()).length > 0, "...and the default (unfollowed) walk is unaffected");
}

console.log("== Bun.Glob.scan() is async, scanSync() is sync — the asymmetry is the API ==");
{
  const fs = makeFakeFs(TREE);
  const Glob = globWith(fs);
  const g = new Glob("**/*.ts");

  const sync = g.scanSync();
  ok(typeof sync[Symbol.iterator] === "function", "scanSync() returns an Iterable");
  ok(sync[Symbol.asyncIterator] === undefined, "...and NOT an AsyncIterable");
  const async_ = g.scan();
  ok(typeof async_[Symbol.asyncIterator] === "function", "scan() returns an AsyncIterable");
  ok(async_[Symbol.iterator] === undefined, "...and NOT a plain Iterable");
  ok(typeof async_.next === "function" && typeof async_.next().then === "function", "scan()'s next() is a promise (for await works)");

  const collected = [];
  for await (const file of g.scan()) collected.push(file);
  ok(JSON.stringify(collected) === JSON.stringify(Array.from(g.scanSync())), "scan() and scanSync() return the same entries");

  // Laziness: both are generators, so a consumer that stops early stops the
  // syscalls too. With the walk eagerly materialised this reads the whole tree.
  const lazyFs = makeFakeFs(TREE);
  for (const _first of new (globWith(lazyFs))("**/*.ts").scanSync()) break;
  const fullFs = makeFakeFs(TREE);
  Array.from(new (globWith(fullFs))("**/*.ts").scanSync());
  ok(
    lazyFs.counts.readdir < fullFs.counts.readdir,
    `breaking out of a scan stops the walk (${lazyFs.counts.readdir} of ${fullFs.counts.readdir} directory reads)`,
  );
}

console.log("== scanGlobSync: the walker itself takes its filesystem as an argument ==");
{
  // The point of the injected fs is that the walk is testable with no kernel at
  // all; this is the shape spike-bun.mjs exercises against the real VFS.
  const fs = makeFakeFs(TREE);
  const out = Array.from(
    scanGlobSync(fs, {
      root: "/app/src",
      match: (p) => p.endsWith(".ts"),
      prefix: compileGlobPrefix("**/*.ts"),
    }),
  );
  ok(JSON.stringify(out) === '["index.ts","nested/deep.ts","util.ts"]', "scanGlobSync(fs, options) walks a plain object filesystem");
}

console.log("== Bun.FileSystemRouter: the Next.js grammar (pure) ==");
{
  ok(parseRouteSegment("blog", "x").kind === "static", "a bare name is a static segment");
  ok(parseRouteSegment("[slug]", "x").kind === "dynamic" && parseRouteSegment("[slug]", "x").param === "slug", "[slug] is dynamic");
  ok(parseRouteSegment("[...rest]", "x").kind === "catch-all", "[...rest] is a catch-all");
  ok(parseRouteSegment("[[...rest]]", "x").kind === "optional-catch-all", "[[...rest]] is an optional catch-all");
  // A typo'd bracket is not a static segment called "[slug" — it is a route no
  // request can reach, so it throws at construction instead of at 404 time.
  let msg = "";
  try { parseRouteSegment("[slug", "pages/[slug.tsx"); } catch (e) { msg = e.message; }
  ok(/cannot parse the route segment/.test(msg) && msg.indexOf("[slug.tsx") !== -1, "a malformed bracket segment throws naming the file");

  ok(SEGMENT_RANK.static < SEGMENT_RANK.dynamic, "a static segment outranks a dynamic one");
  ok(SEGMENT_RANK.dynamic < SEGMENT_RANK["catch-all"], "a dynamic segment outranks a catch-all");
  ok(SEGMENT_RANK["catch-all"] < SEGMENT_RANK["optional-catch-all"], "a catch-all outranks an optional catch-all");

  const q = splitPathAndQuery("/settings?foo=bar&foo=baz&n=1");
  ok(q.path === "/settings" && q.query.n === "1", "splitPathAndQuery separates the query string");
  ok(q.query.foo === "baz", "a repeated key keeps the last value (params are Record<string, string>)");
}

console.log("== Bun.FileSystemRouter: route precedence ==");
{
  // The documented pages directory, verbatim from the Bun docs.
  const routes = compileFileSystemRoutes(
    ["index.tsx", "settings.tsx", "blog/[slug].tsx", "blog/index.tsx", "[[...catchall]].tsx"],
    {},
  );
  const match = (p) => matchFileSystemRoute(routes, p);
  ok(match("/").route.name === "/" && match("/").route.kind === "exact", "/ resolves to index.tsx, not to the optional catch-all");
  ok(match("/settings").route.name === "/settings", "/settings resolves to settings.tsx");
  ok(match("/blog").route.name === "/blog", "blog/index.tsx collapses to /blog");
  ok(match("/blog/my-cool-post").route.name === "/blog/[slug]", "/blog/my-cool-post resolves to the dynamic route");
  ok(match("/blog/my-cool-post").params.slug === "my-cool-post", "...and captures the parameter");
  ok(match("/a/b/c").route.name === "/[[...catchall]]", "an unmatched path falls through to the catch-all");
  ok(match("/a/b/c").params.catchall === "a/b/c", "a catch-all captures the rest as a STRING (Bun types params as Record<string,string>)");

  // Precedence is per-segment and left-to-right. This is the pair that a single
  // "how dynamic is this route" score gets wrong: both routes have exactly one
  // dynamic segment, and the answer is decided at position 0.
  const mixed = compileFileSystemRoutes(["[org]/settings.tsx", "acme/[page].tsx"], {});
  const hit = matchFileSystemRoute(mixed, "/acme/settings");
  ok(hit.route.name === "/acme/[page]", "a static segment beats a dynamic one at the same position");
  ok(hit.params.page === "settings", "...and the winning route's parameter is the one captured");
  ok(matchFileSystemRoute(mixed, "/other/settings").route.name === "/[org]/settings", "the dynamic route still serves everything else");

  const all = compileFileSystemRoutes(["static.tsx", "[x].tsx", "[...rest].tsx"], {});
  ok(matchFileSystemRoute(all, "/static").route.kind === "exact", "static beats both");
  ok(matchFileSystemRoute(all, "/other").route.kind === "dynamic", "dynamic beats the catch-all for a single segment");
  ok(matchFileSystemRoute(all, "/a/b").route.kind === "catch-all", "the catch-all takes the multi-segment path");
  ok(matchFileSystemRoute(all, "/a/b").params.rest === "a/b", "the catch-all parameter is the remaining path");

  // A required catch-all must NOT match zero segments; an optional one must.
  const req = compileFileSystemRoutes(["docs/[...page].tsx"], {});
  ok(matchFileSystemRoute(req, "/docs") === null, "[...page] does not match the bare parent path");
  const opt = compileFileSystemRoutes(["docs/[[...page]].tsx"], {});
  ok(matchFileSystemRoute(opt, "/docs") !== null, "[[...page]] does match it");
  ok(Object.keys(matchFileSystemRoute(opt, "/docs").params).length === 0, "...with no parameter set");

  ok(matchFileSystemRoute(compileFileSystemRoutes(["blog/[slug].tsx"], {}), "/blog/a%20b").params.slug === "a b", "parameters are percent-decoded");
  ok(matchFileSystemRoute(routes, "/nope/deep/deeper").route.kind === "optional-catch-all", "kind reports optional-catch-all");
  ok(compileFileSystemRoutes(["index.tsx", "styles.css", "README.md"], {}).length === 1, "non-page extensions are not routes");
  ok(compileFileSystemRoutes(["page.mjs"], {}).length === 0, "…and .mjs is not a page extension by default");
  ok(compileFileSystemRoutes(["page.mjs"], { fileExtensions: [".mjs"] }).length === 1, "fileExtensions overrides the default set");

  // Two files claiming one route is a project error. Next.js says so too, and
  // "whichever the directory walk saw first" is not an answer.
  let dup = "";
  try { compileFileSystemRoutes(["blog.tsx", "blog/index.tsx"], {}); } catch (e) { dup = e.message; }
  ok(/two files resolve to the route/.test(dup) && dup.indexOf("blog/index.tsx") !== -1, "a duplicate route name throws naming both files");
  let late = "";
  try { compileFileSystemRoutes(["[...all]/tail.tsx"], {}); } catch (e) { late = e.message; }
  ok(/catch-all segment must be last/.test(late), "a catch-all that is not the last segment throws");
}

console.log("== Bun.FileSystemRouter: the class, over a scanned directory ==");
{
  const fs = makeFakeFs({
    "/proj/pages/index.tsx": "file",
    "/proj/pages/settings.tsx": "file",
    "/proj/pages/blog/[slug].tsx": "file",
    "/proj/pages/blog/index.tsx": "file",
    "/proj/pages/[[...catchall]].tsx": "file",
    "/proj/pages/styles.css": "file",
    "/proj/pages/.hidden.tsx": "file",
  });
  const lazy = (name) => (name === "fs" ? fs : name === "path" ? nodePath.default : nodeRequire(name));
  const FileSystemRouter = createBunFileSystemRouter({ lazy, process: { cwd: () => "/proj" } });
  const router = new FileSystemRouter({
    style: "nextjs",
    dir: "./pages",
    origin: "https://mydomain.com",
    assetPrefix: "_next/static/",
  });

  // The documented example output, field by field.
  const home = router.match("/");
  ok(home.filePath === "/proj/pages/index.tsx", "filePath is absolute");
  ok(home.kind === "exact" && home.name === "/", "kind/name match the docs");
  ok(home.src === "https://mydomain.com/_next/static/index.tsx", "src is origin + assetPrefix + the path relative to dir");

  const settings = router.match("/settings?foo=bar");
  ok(settings.query.foo === "bar", "query parameters are parsed");
  // Surprising but documented: pathname is the path AS PASSED, query included.
  ok(settings.pathname === "/settings?foo=bar", "pathname keeps the query string (as the documented example prints it)");
  ok(settings.filePath === "/proj/pages/settings.tsx", "…and the query does not affect matching");

  const post = router.match("/blog/my-cool-post");
  ok(post.kind === "dynamic" && post.params.slug === "my-cool-post", "dynamic route + params");
  ok(post.name === "/blog/[slug]" && post.filePath === "/proj/pages/blog/[slug].tsx", "name keeps the bracket syntax");

  ok(router.match(new Request("https://example.com/blog/my-cool-post")).params.slug === "my-cool-post", "match() accepts a Request");
  ok(router.match("https://example.com/settings?foo=bar").query.foo === "bar", "…and a full URL string");
  ok(router.match("/blog/deep/deeper").route === undefined, "a MatchedRoute exposes no internals");
  ok(router.match("/blog/deep/deeper").kind === "optional-catch-all", "everything else falls through to the catch-all");

  ok(router.routes["/"] === "/proj/pages/index.tsx", ".routes maps a route name to its file");
  ok(Object.keys(router.routes).length === 5, "the .css and the dotfile are not routes");

  // The directory is read at construction; .reload() re-reads it.
  ok(router.match("/about").kind === "optional-catch-all", "/about is not a route yet");
  const grown = makeFakeFs({
    "/proj/pages/index.tsx": "file",
    "/proj/pages/settings.tsx": "file",
    "/proj/pages/blog/[slug].tsx": "file",
    "/proj/pages/blog/index.tsx": "file",
    "/proj/pages/[[...catchall]].tsx": "file",
    "/proj/pages/about.tsx": "file",
  });
  const lazy2 = (name) => (name === "fs" ? grown : name === "path" ? nodePath.default : nodeRequire(name));
  const r2 = new (createBunFileSystemRouter({ lazy: lazy2, process: { cwd: () => "/proj" } }))({ style: "nextjs", dir: "/proj/pages" });
  r2.reload();
  ok(r2.match("/about").kind === "exact", "reload() picks up a new page file");
  ok(r2.match("/about").src === "/about.tsx", "with no origin/assetPrefix, src is just the relative path");

  // Loud failures: an unsupported style must not quietly mean "nextjs", and a
  // missing dir must not read as "a router with no routes".
  let styleMsg = "";
  try { new FileSystemRouter({ style: "sveltekit", dir: "./pages" }); } catch (e) { styleMsg = e.message; }
  ok(/style must be "nextjs"/.test(styleMsg), "an unsupported style throws naming the supported one");
  let dirMsg = "";
  try { new FileSystemRouter({ style: "nextjs" }); } catch (e) { dirMsg = e.message; }
  ok(/`dir` is required/.test(dirMsg), "a missing dir throws");
  let missing = "";
  try { new FileSystemRouter({ style: "nextjs", dir: "/proj/nope" }); } catch (e) { missing = e.message; }
  ok(/ENOENT|no such file/.test(missing), "a dir that does not exist throws instead of matching nothing");
  // A Response only carries a `url` when it came from fetch; one you constructed
  // has "", which parses as the root path and would quietly return the index route.
  let emptyUrl = "";
  try { router.match(new Response("body")); } catch (e) { emptyUrl = e.message; }
  ok(/`url` is the empty string/.test(emptyUrl), "a Request/Response with no URL throws rather than matching the index route");
  ok(router.match(new Request("https://x.dev/settings")).name === "/settings", "...while a Request that has one still matches");
}

console.log("== Bun.Glob / Bun.FileSystemRouter are on the Bun global ==");
{
  const B = freshBun();
  ok(typeof B.FileSystemRouter === "function", "Bun.FileSystemRouter is wired into the Bun object");
  ok(typeof new B.Glob("*.ts").scan === "function" && typeof new B.Glob("*.ts").scanSync === "function", "Bun.Glob has both scan entry points");
  ok(new B.Glob("*.ts").match("index.ts") === true, "…and still matches");
}

console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: all offline Bun checks passed");
process.exit(failed ? 1 : 0);