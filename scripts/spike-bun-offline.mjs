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
// The infeasible surface (Phase 6) and the native-addon message it carries. The
// loader is pulled in too: `createModuleSystem` runs over host Node's fs with no
// kernel, which is what lets the `.node` checks at the end of this file prove the
// real require() path rather than just the wording of a string.
import { nativeAddonMessage, nativeAddonError, packageNameFromPath } from "../packages/runtime/builtins/bun-unsupported.js";
import { createModuleSystem } from "../packages/runtime/module.js";
// internalBinding('zlib'): pulled in directly so the brotli/zstd handles can be
// checked without a kernel — they are pure JS and throw before touching wasm.
import { createZlibBinding } from "../packages/runtime/node/bindings/zlib.js";
import {
  bunEnvMode,
  bunEnvFiles,
  parseDotenv,
  expandDotenvValue,
  applyDotenv,
  loadBunEnvFiles,
} from "../packages/runtime/builtins/bun-env.js";
import { createSleepSync } from "../packages/runtime/builtins/bun-sleep.js";
// Bun.Transpiler's scan family, exported for the same reason: the answers are
// pinned to a real Bun binary's, and both are pure functions of a source string.
import { bunScan, bunScanImports } from "../packages/runtime/builtins/bun-transpiler.js";
// The pure halves of the bun:test runner. They are exported precisely so this
// tier can pin them against bytes captured from a real `bun test` — see the
// Phase 5A sections at the end of this file.
import {
  formatEachTitle,
  prettyFormat,
  formatSnapshotFile,
  parseSnapshotFile,
  dedentInlineSnapshot,
} from "../packages/runtime/builtins/bun-test.js";
// Bun.serve option handling + the RFC 6455 rules, as pure functions so this
// Wasm-free tier can drive them without binding a port. See bun-serve.js.
import {
  normalizeServeOptions,
  compileStaticRoutes,
  validateUpgradeRequest,
  negotiateSubprotocol,
  buildHandshakeResponse,
  wsFrameProtocolError,
  WS_GUID,
} from "../packages/runtime/builtins/bun-serve.js";
import { canPark, parkFor } from "../packages/protocol/syscall.js";
// Bun.Archive's tar codec, exported because it is a pure function of bytes: the
// offline tier drives the real reader and the real writer with no kernel, against
// archives recorded from a real bun binary and archives the host `tar` produced.
import { writeTar as archiveWriteTar, parseTar as archiveParseTar, splitName as archiveSplitName } from "../packages/runtime/builtins/bun-archive.js";
// Bun.CryptoHasher / Bun.password pure helpers, plus the internalBinding('crypto')
// adapter, so the crypto checks at the end of this file can drive the real Rust
// crate without a kernel. See the header of bun-crypto.js.
import {
  BCRYPT_MAX_INPUT_BYTES,
  BUN_ARGON2_DEFAULTS,
  BUN_BCRYPT_DEFAULT_COST,
  bcryptKeyMaterial,
  detectPasswordAlgorithm,
  parsePasswordOptions,
} from "../packages/runtime/builtins/bun-crypto.js";
import { createCryptoBinding } from "../packages/runtime/node/bindings/crypto.js";
// Bun.build's pure halves: the option policy, the naming templates, the
// dependency/define tokenizer and the plugin host. See bun-build.js.
import {
  normalizeBuildOptions,
  applyNaming,
  scanAndDefine,
  isExternalSpec,
  PluginHost,
} from "../packages/runtime/builtins/bun-build.js";
// The Bun.spawn({ ipc }) channel's pure halves: the framing and the two
// serialization modes. See the framing block at the bottom of this file for why
// they are pinned here rather than only in the kernel spike.
import {
  FrameReader,
  encodeMessage,
  decodeMessage,
  normalizeMode,
  requireMessage,
} from "../packages/runtime/builtins/bun-ipc.js";
// Bun.S3Client's signer and request builder, exported as pure functions so this
// tier can pin them to AWS's published SigV4 vectors and to Authorization headers
// captured off a real bun binary — neither of which needs a bucket. See bun-s3.js.
import {
  sigv4,
  createSigv4Hashers,
  awsUriEncode,
  buildS3Request,
  presignS3Url,
  resolveS3Config,
  SHA256_EMPTY,
} from "../packages/runtime/builtins/bun-s3.js";

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

// The checks above are self-consistency: our encoder feeding our decoder. They
// would pass just as happily against a codec that was wrong in a matching way on
// both sides. RFC 6455 §5.7 prints the exact bytes for six frames, so these pin
// the codec to the specification instead.
console.log("== WebSocket codec matches the RFC 6455 §5.7 wire examples ==");
{
  const hex = (b) => Buffer.from(b).toString("hex");
  const HELLO = Buffer.from("Hello", "utf8");

  // "A single-frame unmasked text message" — 0x81 0x05 0x48 0x65 0x6c 0x6c 0x6f
  ok(hex(encodeWsFrame(Buffer, 0x1, HELLO, false)) === "810548656c6c6f", "§5.7 single-frame unmasked text 'Hello' encodes to the RFC's bytes");

  // "A single-frame masked text message" — the RFC uses masking key 0x37fa213d.
  // We cannot pin our own encoder's output (it picks a random key, as §5.3
  // requires), but we MUST decode the RFC's literal frame.
  const rfcMasked = Buffer.from([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]);
  const maskedDec = readWsFrame(Buffer, rfcMasked);
  ok(maskedDec && maskedDec.frame.payload.toString("utf8") === "Hello", "§5.7 masked text frame from the RFC unmasks to 'Hello'");
  ok(maskedDec.frame.masked === true && maskedDec.frame.fin === true, "…and is reported as masked with FIN set");

  // "A fragmented unmasked text message" — 0x01 0x03 "Hel" then 0x80 0x02 "lo".
  const frag1 = readWsFrame(Buffer, Buffer.from([0x01, 0x03, 0x48, 0x65, 0x6c]));
  const frag2 = readWsFrame(Buffer, Buffer.from([0x80, 0x02, 0x6c, 0x6f]));
  ok(frag1.frame.fin === false && frag1.frame.opcode === 0x1 && frag1.frame.payload.toString() === "Hel", "§5.7 first fragment: FIN clear, text opcode, 'Hel'");
  ok(frag2.frame.fin === true && frag2.frame.opcode === 0x0 && frag2.frame.payload.toString() === "lo", "§5.7 final fragment: FIN set, continuation opcode, 'lo'");

  // "Unmasked Ping request and masked Pong response".
  ok(hex(encodeWsFrame(Buffer, 0x9, HELLO, false)) === "890548656c6c6f", "§5.7 unmasked Ping 'Hello' encodes to the RFC's bytes");
  const rfcPong = Buffer.from([0x8a, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]);
  const pongDec = readWsFrame(Buffer, rfcPong);
  ok(pongDec && pongDec.frame.opcode === 0xa && pongDec.frame.payload.toString() === "Hello", "§5.7 masked Pong frame from the RFC decodes");

  // "256 bytes binary message in a single unmasked frame" — 0x82 0x7E 0x0100.
  const b256 = encodeWsFrame(Buffer, 0x2, Buffer.alloc(256, 0), false);
  ok(hex(b256.subarray(0, 4)) === "827e0100", "§5.7 256-byte binary uses the 16-bit length header 0x82 0x7E 0x0100");

  // "64KiB binary message in a single unmasked frame" — 0x82 0x7F 0x0000000000010000.
  const b64k = encodeWsFrame(Buffer, 0x2, Buffer.alloc(65536, 0), false);
  ok(hex(b64k.subarray(0, 10)) === "827f0000000000010000", "§5.7 65536-byte binary uses the 64-bit length header");
  ok(readWsFrame(Buffer, b64k).frame.payload.length === 65536, "…and the 64-bit length frame round-trips");

  // The RSV bits are now surfaced rather than parsed and dropped, which is what
  // lets the server enforce §5.2 at all.
  const rsvFrame = Buffer.from([0xc1, 0x00]); // FIN + RSV1 + text, empty payload
  ok(readWsFrame(Buffer, rsvFrame).frame.rsv1 === true, "RSV1 is reported by the reader (§5.2 needs it)");
}

console.log("== Bun.serve WebSocket handshake follows RFC 6455 §4 ==");
{
  // RFC 6455 §1.3 prints a complete worked example: the key `dGhlIHNhbXBsZSBub25jZQ==`
  // concatenated with the GUID and SHA-1'd must base64 to `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`.
  // This is the single best external pin available for the handshake.
  const RFC_KEY = "dGhlIHNhbXBsZSBub25jZQ==";
  const RFC_ACCEPT = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";
  const accept = nodeRequire("node:crypto").createHash("sha1").update(RFC_KEY + WS_GUID).digest("base64");
  ok(WS_GUID === "258EAFA5-E914-47DA-95CA-C5AB0DC85B11", "the handshake GUID is the one RFC 6455 §1.3 fixes");
  ok(accept === RFC_ACCEPT, "key + GUID -> SHA-1 -> base64 reproduces the RFC's worked Accept value");

  // §4.1: version 13, and a key that is a base64'd 16-byte nonce.
  ok(validateUpgradeRequest({ "sec-websocket-version": "13", "sec-websocket-key": RFC_KEY }) === null, "a well-formed v13 upgrade is accepted");
  const badVer = validateUpgradeRequest({ "sec-websocket-version": "8", "sec-websocket-key": RFC_KEY });
  ok(badVer && badVer.status === 426, "§4.4: an unsupported version is refused with 426 Upgrade Required");
  ok(badVer.headers["Sec-WebSocket-Version"] === "13", "…and advertises the version the server does speak");
  const noKey = validateUpgradeRequest({ "sec-websocket-version": "13" });
  ok(noKey && noKey.status === 400, "a missing Sec-WebSocket-Key is refused with 400 (it used to be hashed as '')");
  ok(validateUpgradeRequest({ "sec-websocket-version": "13", "sec-websocket-key": "short" }).status === 400, "a malformed key is refused too");

  // §4.2.2 step 4: echo a subprotocol ONLY if the server selected one AND the
  // client offered it. The shim used to echo the client's first offer blindly,
  // which both violates the RFC and diverges from Bun (where you select one
  // explicitly via server.upgrade(req, { headers })).
  ok(negotiateSubprotocol("chat, superchat", null) === null, "no server-offered protocol -> none selected (was: blindly echo 'chat')");
  ok(negotiateSubprotocol("chat, superchat", "superchat") === "superchat", "a server protocol the client offered is selected");
  ok(negotiateSubprotocol("chat", "graphql-ws") === null, "§4.1: a protocol the client never offered is NOT echoed back");
  ok(negotiateSubprotocol("chat, superchat", ["graphql-ws", "chat"]) === "chat", "the server's preference order wins among mutually-supported protocols");
  ok(negotiateSubprotocol("", "chat") === null, "a client offering nothing gets nothing selected");

  // The duplicate-header bug: both a negotiated protocol and caller headers.
  const head = buildHandshakeResponse(RFC_ACCEPT, "chat", [["X-Trace", "abc"], ["Sec-WebSocket-Protocol", "sneaky"]]);
  const protoLines = head.split("\r\n").filter((l) => /^sec-websocket-protocol:/i.test(l));
  ok(protoLines.length === 1, "exactly one Sec-WebSocket-Protocol line is emitted (two used to be)");
  ok(protoLines[0] === "Sec-WebSocket-Protocol: chat", "…and it is the negotiated value, not the caller's raw header");
  ok(head.startsWith("HTTP/1.1 101 Switching Protocols\r\n"), "§4.2.2: the handshake response is a 101");
  ok(/\r\nUpgrade: websocket\r\n/.test(head) && /\r\nConnection: Upgrade\r\n/.test(head), "…with the required Upgrade/Connection fields");
  ok(head.indexOf("X-Trace: abc") !== -1, "caller headers still pass through");
  ok(head.endsWith("\r\n\r\n"), "…and the head is terminated by a blank line");
  ok(buildHandshakeResponse(RFC_ACCEPT, null, []).indexOf("Sec-WebSocket-Protocol") === -1, "no protocol selected -> the header is omitted entirely");
}

console.log("== WebSocket frame validation enforces the RFC 6455 §5 server rules ==");
{
  const frame = (over) => ({ fin: true, opcode: 0x1, masked: true, rsv1: false, rsv2: false, rsv3: false, payload: Buffer.alloc(0), ...over });
  const st = (over) => ({ fragmented: false, maxPayloadLength: 0, receivedLength: 0, ...over });

  ok(wsFrameProtocolError(frame(), st()) === null, "a masked, RSV-clear text frame is legal");

  // §5.1: "The server MUST close the connection upon receiving a frame that is not masked."
  const unmasked = wsFrameProtocolError(frame({ masked: false }), st());
  ok(unmasked && unmasked.code === 1002, "§5.1: an UNMASKED client frame is a protocol error (1002)");

  // §5.2: RSV bits must be 0 when no extension was negotiated — and we negotiate none.
  ok(wsFrameProtocolError(frame({ rsv1: true }), st()).code === 1002, "§5.2: RSV1 set with no negotiated extension is 1002");
  ok(wsFrameProtocolError(frame({ rsv3: true }), st()).code === 1002, "§5.2: RSV3 set is 1002 too");

  // §5.2: unknown opcodes.
  ok(wsFrameProtocolError(frame({ opcode: 0x3 }), st()).code === 1002, "§5.2: a reserved DATA opcode (0x3) is 1002");
  ok(wsFrameProtocolError(frame({ opcode: 0xb }), st()).code === 1002, "§5.2: a reserved CONTROL opcode (0xB) is 1002");

  // §5.5: control frames are <=125 bytes and never fragmented.
  ok(wsFrameProtocolError(frame({ opcode: 0x9, payload: Buffer.alloc(126) }), st()).code === 1002, "§5.5: a 126-byte control frame is 1002");
  ok(wsFrameProtocolError(frame({ opcode: 0x9, payload: Buffer.alloc(125) }), st()) === null, "§5.5: a 125-byte control frame is exactly legal");
  ok(wsFrameProtocolError(frame({ opcode: 0x8, fin: false }), st()).code === 1002, "§5.5: a fragmented control frame is 1002");

  // §5.4: fragmentation ordering.
  ok(wsFrameProtocolError(frame({ opcode: 0x0 }), st()).code === 1002, "§5.4: a continuation with nothing to continue is 1002");
  ok(wsFrameProtocolError(frame({ opcode: 0x0 }), st({ fragmented: true })) === null, "§5.4: a continuation IS legal mid-message");
  ok(wsFrameProtocolError(frame({ opcode: 0x1 }), st({ fragmented: true })).code === 1002, "§5.4: a new data frame mid-fragment is 1002");
  // A control frame may legally interleave with a fragmented data message.
  ok(wsFrameProtocolError(frame({ opcode: 0x9 }), st({ fragmented: true })) === null, "§5.4: a control frame MAY interleave with a fragmented message");

  // maxPayloadLength -> 1009 "message too big" (§7.4.1), accumulated across fragments.
  ok(wsFrameProtocolError(frame({ payload: Buffer.alloc(200) }), st({ maxPayloadLength: 100 })).code === 1009, "maxPayloadLength exceeded closes with 1009, not 1002");
  ok(wsFrameProtocolError(frame({ opcode: 0x0, payload: Buffer.alloc(60) }), st({ fragmented: true, maxPayloadLength: 100, receivedLength: 60 })).code === 1009, "…and the limit accumulates across fragments");
}

console.log("== Bun.serve options: implemented, degraded loudly, or refused ==");
{
  const cfg = (o) => normalizeServeOptions(o).config;
  const warns = (o) => normalizeServeOptions(o).warnings.map((w) => w.key);
  const throws = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };

  // Baseline: none of these options set -> no warnings, Bun's documented defaults.
  const base = normalizeServeOptions({ fetch() {} });
  ok(base.warnings.length === 0, "a plain Bun.serve warns about nothing");
  ok(base.config.port === 3000, "the default port is 3000");
  ok(base.config.idleTimeout === 10, "Bun's documented default idleTimeout is 10 seconds");
  ok(base.config.maxRequestBodySize === 128 * 1024 * 1024, "Bun's documented default maxRequestBodySize is 128 MiB");

  // THROW: serving HTTP/1.1 to code that asked for HTTP/3 is a silent approximation.
  const h3 = throws(() => normalizeServeOptions({ http3: true }));
  ok(/http3.*not supported/i.test(h3) && /QUIC/.test(h3), "http3 throws and explains that QUIC/UDP does not exist in a tab");

  // DEGRADE: accepted, ignored, announced once.
  ok(warns({ tls: { cert: "x", key: "y" } }).includes("tls"), "tls DEGRADES (accepted + warned), it does not throw");
  ok(cfg({ tls: { cert: "x" } }).tls === true, "…and the fact that TLS was requested is recorded");
  ok(warns({ reusePort: true }).includes("reusePort"), "reusePort warns (SO_REUSEPORT needs several processes; we have one)");
  ok(warns({ ipv6Only: true }).includes("ipv6Only"), "ipv6Only warns (the in-VM loopback is IPv4-only)");
  const tlsMsg = normalizeServeOptions({ tls: {} }).warnings[0].message;
  ok(/plaintext/i.test(tlsMsg) && /deploy/i.test(tlsMsg), "the tls warning says what happens instead AND that production is unaffected");

  // IMPLEMENT: idleTimeout, validated at Bun's own u8 boundary.
  ok(cfg({ idleTimeout: 30 }).idleTimeout === 30, "idleTimeout is carried through");
  ok(cfg({ idleTimeout: 0 }).idleTimeout === 0, "idleTimeout 0 (disabled) is preserved, not treated as absent");
  ok(cfg({ idleTimeout: 255 }).idleTimeout === 255, "255 seconds is exactly allowed");
  ok(/cannot exceed 255/.test(throws(() => normalizeServeOptions({ idleTimeout: 256 }))), "256 is refused at the same boundary real Bun refuses it");
  ok(/non-negative integer/.test(throws(() => normalizeServeOptions({ idleTimeout: 1.5 }))), "a fractional idleTimeout is refused");
  ok(/non-negative integer/.test(throws(() => normalizeServeOptions({ idleTimeout: -1 }))), "a negative idleTimeout is refused");

  // IMPLEMENT: maxRequestBodySize.
  ok(cfg({ maxRequestBodySize: 1024 }).maxRequestBodySize === 1024, "maxRequestBodySize is carried through");
  ok(/non-negative number/.test(throws(() => normalizeServeOptions({ maxRequestBodySize: -5 }))), "a negative maxRequestBodySize is refused");

  // IMPLEMENT (with an honest caveat): unix.
  ok(cfg({ unix: "/tmp/x.sock" }).unix === "/tmp/x.sock", "unix is carried through and really binds a socket");
  const unixWarn = normalizeServeOptions({ unix: "/tmp/x.sock" }).warnings[0].message;
  ok(/preview/i.test(unixWarn) && /port/i.test(unixWarn), "…but warns that the browser preview finds servers by port and cannot reach it");
  ok(/must be a socket path string/.test(throws(() => normalizeServeOptions({ unix: 5 }))), "a non-string unix path is refused");

  // ACCEPT: id is observable, nothing is being approximated.
  ok(cfg({ id: "my-server" }).id === "my-server", "id is kept and exposed on the server instance");
  ok(warns({ id: "x" }).length === 0, "id does not warn — there is nothing it fails to do");

  // static: a real Bun feature, implemented rather than stubbed.
  const R = (t) => ({ __tag: t, arrayBuffer() {} });
  const s = compileStaticRoutes({ "/health": R("OK"), "/robots.txt": R("ROBOTS") });
  ok(s instanceof Map && s.size === 2, "static compiles to an exact-path map");
  ok(s.get("/health").__tag === "OK", "…keyed by the exact pathname");
  ok(compileStaticRoutes(undefined) === null && compileStaticRoutes({}) === null, "no static routes -> null (skips the lookup entirely)");
  // Putting a handler in `static` is a mistake that would otherwise never fire.
  ok(/pre-built Response/.test(throws(() => compileStaticRoutes({ "/x": () => {} }))), "a function in `static` throws instead of silently never being called");
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
  // INTENTIONAL CHANGE: this used to assert that Bun.password.hashSync round-tripped
  // against its own verifySync. It did — the hash was node scrypt wrapped in a
  // bespoke `$vv-argon2id$…` string, so it was perfectly self-consistent and
  // verifiable by absolutely nothing else, while telling the caller "argon2id".
  // Self-round-tripping is exactly the evidence that could not tell those apart.
  // Bun.password is now real argon2id/bcrypt over the Rust crate, so in THIS
  // process (no kernel, hence no wasm crypto codec) it must fail loudly instead of
  // falling back to something that looks like a password hash and is not one.
  // The real hashes are exercised against Bun's own published vectors at the end
  // of this file, where the codec is available.
  let pwErr = "";
  try { Bun.password.hashSync("s3cret"); } catch (e) { pwErr = e.message; }
  ok(/Wasm crypto codec/.test(pwErr) && /Bun\.password\.hash/.test(pwErr), "Bun.password.hash without the wasm codec throws, naming the API and the reason");
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
  // scan()/scanImports() used to throw here: they had returned hard-coded empty
  // arrays, which reads as "this file imports nothing" and is a wrong answer a
  // caller cannot detect. They are real now (see the pinned section at the end of
  // this file); these two check the WIRING — that the class reaches them and
  // carries its constructor loader — rather than the answers.
  ok(JSON.stringify(tr.scan("import a from 'b';")) === '{"exports":[],"imports":[{"kind":"import-statement","path":"b"}]}', "Transpiler.scan() answers through the class");
  ok(JSON.stringify(tr.scanImports("import a from 'b';")) === '[{"kind":"import-statement","path":"b"}]', "Transpiler.scanImports() likewise");
  ok(tr.scan("enum E { A }\nexport const a = 1;").exports.length === 1, "…using the loader the constructor was given (a `ts` source scans)");
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
    // `publish` used to be the example here, and is now a verb with a reason of its
    // own, so this needs a name Bun does not have at all.
    const unknown = bun("frobnicate");
    ok(unknown.code === 1 && /bun frobnicate is not implemented/.test(unknown.text), "unknown verb reports not-implemented");
    const publish = bun("publish");
    ok(publish.code === 1 && /authenticated npm session/.test(publish.text),
      "bun publish says which capability is missing rather than 'unknown command'");
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

  // Guest code hands these a Node Readable (fs.createReadStream, Bun.spawn's
  // stdout) as readily as a web stream, and a Node Readable is async-iterable but
  // has no getReader().
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

console.log("== Bun.Cookie: the defaults, and the attributes that change a cookie's scope ==");
{
  const B = bunWith();
  const C = B.Cookie;
  const throwsWith = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };

  // THE two defaults, and the reason this block leads with them: Bun writes
  // `Path=/` and `SameSite=Lax` even though the caller asked for neither, and a
  // shim that omits Path stores the cookie against the REQUEST DIRECTORY
  // (`/admin/login`, not `/`). It then reads back on the page that set it and
  // nowhere else — a scope bug, not a crash, and the hardest kind to see.
  ok(new C("a", "b").toString() === "a=b; Path=/; SameSite=Lax", "new Cookie(name, value) serialises Bun's documented defaults: Path=/ and SameSite=Lax");
  ok(new C("a", "b").path === "/", "the default path is \"/\" — not the request directory");
  ok(new C("a", "b").sameSite === "lax", "the default sameSite is \"lax\"");
  ok(new C("a", "b").domain === null, "an unset domain reads back as null, not undefined or \"\"");
  ok(new C("a", "b").expires === undefined, "an unset expires reads back as undefined (a session cookie)");
  ok(new C("a", "b").maxAge === undefined, "an unset maxAge reads back as undefined");
  ok(new C("a", "b").secure === false && new C("a", "b").httpOnly === false && new C("a", "b").partitioned === false, "the three boolean attributes default to false");

  // Attribute order is Bun's, byte for byte, because these strings land in HTTP
  // fixtures and snapshot tests on both sides of the sandbox boundary.
  ok(
    new C("id", "42", { domain: "example.com", path: "/app", maxAge: 3600, secure: true, httpOnly: true, partitioned: true, sameSite: "strict" }).toString() ===
      "id=42; Domain=example.com; Path=/app; Max-Age=3600; Secure; HttpOnly; Partitioned; SameSite=Strict",
    "every attribute serialises, in Bun's order"
  );
  ok(new C("a", "b", { expires: new Date(0) }).toString().indexOf("Expires=Thu, 01 Jan 1970 00:00:00 GMT") !== -1, "expires serialises as an RFC 6265 IMF-fixdate");
  ok(new C("a", "b", { expires: 1700000000 }).expires.getTime() === 1700000000 * 1000, "a NUMBER expires is SECONDS since the epoch, the same unit as Max-Age");
  ok(new C("a", "b", { maxAge: "3600" }).maxAge === undefined, "a stringly-typed maxAge is ignored rather than coerced — Bun only honours a number, and so a session cookie is what both produce");
  ok(new C({ name: "a", value: "b", path: "/x" }).toString() === "a=b; Path=/x; SameSite=Lax", "the single-CookieInit-object constructor form works");
  ok(new C("a=b; Path=/x; Secure").toString() === "a=b; Path=/x; Secure; SameSite=Lax", "the single-STRING constructor form parses a Set-Cookie");
  ok(C.from("a", "b", { httpOnly: true }).httpOnly === true, "Cookie.from is the static spelling of the constructor");

  // sameSite:"none" is the one attribute pair with a browser-level rule attached:
  // no current browser will STORE a SameSite=None cookie that is not also Secure
  // (RFC 6265bis §4.1.2.7). Bun does not add Secure for you, and neither do we —
  // adding an attribute the caller never wrote is exactly the silent divergence
  // this shim exists to avoid, and it would then behave differently here than in
  // production while being invisible in the caller's own source.
  ok(new C("a", "b", { sameSite: "none" }).toString() === "a=b; Path=/; SameSite=None", "sameSite:\"none\" does NOT gain an implicit Secure — we serialise what was asked for, as Bun does, and let the browser be the thing that rejects it");
  ok(new C("a", "b", { sameSite: "none", secure: true }).toString() === "a=b; Path=/; Secure; SameSite=None", "adding Secure explicitly is the supported way to make a SameSite=None cookie storable");

  // Percent-coding is ASYMMETRIC in Bun, and the asymmetry is load-bearing: the
  // value is encoded on the way OUT (so `;` and `=` cannot inject a second
  // attribute into a header we are about to write) and is NOT decoded on the way
  // IN by Cookie.parse.
  ok(new C("a", "hello world").toString() === "a=hello%20world; Path=/; SameSite=Lax", "serialize() percent-encodes the value");
  ok(new C("a", "x;y=z").toString().indexOf("x%3By%3Dz") !== -1, "a value containing ; and = is encoded, so it cannot inject an attribute");
  ok(new C("a", "café").toString().indexOf("caf%C3%A9") !== -1, "a non-ASCII value survives as UTF-8 percent escapes");
  ok(C.parse("a=%20").value === "%20", "Cookie.parse does NOT decode: the value is the three literal characters %20");
  ok(C.parse(new C("a", "hello world").toString()).value === "hello%20world", "the documented consequence: Set-Cookie round-tripping through parse() is not value-preserving");

  // Validation. These are allow-lists transcribed from Bun, not heuristics: every
  // excluded character is one that would let a caller inject an attribute or a
  // second cookie, so throwing is the only safe answer — silently stripping would
  // hand back a cookie under a name nobody asked for.
  ok(/Invalid cookie name/.test(throwsWith(() => new C("a b", "v"))), "a name containing a space throws");
  ok(/Invalid cookie name/.test(throwsWith(() => new C("a=b", "v"))), "a name containing = throws");
  ok(/Invalid cookie name/.test(throwsWith(() => new C("a;b", "v"))), "a name containing ; throws");
  ok(/Invalid cookie path/.test(throwsWith(() => new C("a", "v", { path: "/x;y" }))), "a path containing ; throws");
  ok(/Invalid cookie domain/.test(throwsWith(() => new C("a", "v", { domain: "ex ample.com" }))), "a domain containing a space throws");
  ok(/Invalid sameSite/.test(throwsWith(() => new C("a", "v", { sameSite: "Lax" }))), "the sameSite INIT is case-sensitive (Bun takes the lowercase spellings only)");
  ok(C.parse("a=b; SameSite=LAX").sameSite === "lax", "...while the sameSite ATTRIBUTE in a header is matched case-insensitively — two inputs, two rules, both Bun's");
  ok(/not a valid HTTP header value/.test(throwsWith(() => C.parse("a=café"))), "a Set-Cookie string that is not a valid HTTP header value throws (non-ASCII included)");
  ok(/no '='/.test(throwsWith(() => C.parse("justaname"))), "a cookie string with no = throws instead of inventing an empty value");
  ok(/Invalid cookie name/.test(throwsWith(() => C.parse(""))), "Cookie.parse(\"\") throws");

  // Accessors.
  const mutable = new C("a", "b");
  mutable.name = "renamed";
  ok(mutable.name === "a", "assigning to .name is silently ignored — Bun's accessor is getter-only with a no-op put, and throwing here would break strict-mode code that works there");
  mutable.value = "c";
  mutable.path = "/p";
  mutable.secure = true;
  ok(mutable.toString() === "a=c; Path=/p; Secure; SameSite=Lax", "value/path/secure are writable and re-serialise");
  ok(/Invalid cookie path/.test(throwsWith(() => { mutable.path = "/;"; })), "the path setter validates too, not just the constructor");
  const json = new C("a", "b", { maxAge: 60 }).toJSON();
  ok(json.name === "a" && json.value === "b" && json.path === "/" && json.maxAge === 60 && json.sameSite === "lax" && json.domain === undefined, "toJSON exposes the fields, omitting an unset domain");
}

console.log("== Bun.Cookie: Max-Age beats Expires (RFC 6265 §5.3) ==");
{
  const B = bunWith();
  const C = B.Cookie;

  // The precedence is about the COMPUTED EXPIRY, not about which attribute is
  // kept — so both survive parsing, both re-serialise, and the answer cannot
  // depend on the order they appeared in.
  const past = "Expires=Thu, 01 Jan 2015 00:00:00 GMT";
  const both = C.parse("a=b; " + past + "; Max-Age=3600");
  ok(both.isExpired() === false, "a live Max-Age beats a past Expires: the cookie is NOT expired");
  ok(both.maxAge === 3600 && both.expires instanceof Date, "both attributes survive the parse — precedence is not deletion");
  ok(C.parse("a=b; Max-Age=3600; " + past).serialize() === both.serialize(), "the result does not depend on which of the two came first in the header");
  ok(C.parse("a=b; Max-Age=0; Expires=Thu, 01 Jan 2999 00:00:00 GMT").isExpired() === true, "and the precedence is unconditional: Max-Age=0 beats a FUTURE Expires");
  ok(C.parse("a=b; Max-Age=0").isExpired() === true, "Max-Age=0 is expired now — that is the delete signal");
  ok(C.parse("a=b; Max-Age=-1").isExpired() === true, "a negative Max-Age is expired now");
  ok(C.parse("a=b; " + past).isExpired() === true, "a past Expires with no Max-Age is expired");
  ok(C.parse("a=b; Expires=Thu, 01 Jan 2999 00:00:00 GMT").isExpired() === false, "a future Expires with no Max-Age is not");
  ok(C.parse("a=b").isExpired() === false, "a session cookie (neither attribute) is never expired");

  // Parsing details that decide scope.
  ok(C.parse("a=b; path=/admin").path === "/admin", "attribute names are case-insensitive");
  ok(C.parse("a=b; Path=admin").path === "/", "a Path that does not start with / is ignored, leaving the default — not stored as a relative path");
  ok(C.parse("a=b; Domain=EXAMPLE.com").domain === "example.com", "Domain is lower-cased");
  ok(C.parse("a=b; Max-Age=60abc").maxAge === 60, "Max-Age is parsed with parseInt, so trailing junk is tolerated as Bun does");
  ok(C.parse("a=b; Unknown=1; Secure").secure === true, "an unrecognised attribute is skipped without disturbing the ones around it");
  ok(C.parse("a=b; SameSite=weird").sameSite === "lax", "an unrecognised SameSite leaves the default rather than throwing — a header we did not write is not the caller's bug");
  ok(C.parse("a=b; Path=/one; Path=/two").path === "/two", "the last occurrence of a repeated attribute wins (RFC 6265 §5.2)");
  ok(C.parse("a=").value === "", "an empty value parses to the empty string");
  ok(C.parse("a=b=c").value === "b=c", "only the FIRST = splits name from value");
}

console.log("== Bun.CookieMap ==");
{
  const B = bunWith();
  const M = B.CookieMap;

  const m = new M("session=abc; theme=dark");
  ok(m.get("session") === "abc" && m.get("theme") === "dark", "a Cookie: request header parses into name/value pairs");
  ok(m.get("nope") === null, "a missing cookie reads as null, not undefined");
  ok(m.has("session") === true && m.has("nope") === false, "has() agrees with get()");
  ok(m.size === 2, "size counts the cookies that arrived");
  ok(JSON.stringify([...m]) === '[["session","abc"],["theme","dark"]]', "the map is iterable as [name, value] pairs");
  ok([...m.keys()].join() === "session,theme" && [...m.values()].join() === "abc,dark", "keys() and values() agree with entries()");
  let seen = "";
  m.forEach((v, k) => { seen += k + "=" + v + ";"; });
  ok(seen === "session=abc;theme=dark;", "forEach yields (value, name) in Map order");
  ok(JSON.stringify(m.toJSON()) === '{"session":"abc","theme":"dark"}', "toJSON is a plain object");

  // A REQUEST header is decoded (unlike Cookie.parse), and the decision is made
  // once for the whole header — which is observationally the same as always
  // decoding, since a value with no % decodes to itself.
  ok(new M("a=hello%20world").get("a") === "hello world", "a request header's values ARE percent-decoded");
  ok(new M("a=100%").get("a") === "100%", "a malformed escape is left alone rather than throwing");
  // Names are never decoded, and that is a security property rather than an
  // oversight: browsers apply the `__Host-`/`__Secure-` prefix rules to the
  // LITERAL name, so an alias would let an unprotected cookie shadow a protected one.
  const prefixed = new M("__%48ost-session=1");
  ok(prefixed.get("__%48ost-session") === "1", "a percent-escaped NAME keeps its literal spelling");
  ok(prefixed.get("__Host-session") === null, "...and does not answer to the decoded one — the __Host- prefix rules are enforced on the literal name");
  ok(new M("a=1; ; b=2").size === 2, "an empty segment in the header is skipped");
  ok(new M("a=1; novalue; b=2").get("novalue") === null, "an attribute-shaped fragment with no = is skipped, not guessed at");
  ok(new M("").size === 0 && new M().size === 0 && new M(null).size === 0, "an empty/absent initialiser gives an empty map");
  ok(new M([["a", "1"]]).get("a") === "1", "an array-of-pairs initialiser works");
  ok(new M({ a: "1" }).get("a") === "1", "an object initialiser works");
  ok(new M([["a", "%20"]]).get("a") === "%20", "values from an ARRAY initialiser are verbatim — only a real header goes through the decoder");

  // The split that makes this useful: only cookies the handler CHANGED become
  // Set-Cookie headers. A request that merely reads must emit none, or every plain
  // GET rewrites every cookie the browser already had.
  const rw = new M("session=abc");
  ok(rw.toSetCookieHeaders().length === 0, "reading cookies produces NO Set-Cookie headers");
  rw.set("theme", "dark");
  ok(JSON.stringify(rw.toSetCookieHeaders()) === '["theme=dark; Path=/; SameSite=Lax"]', "set() produces exactly one Set-Cookie, with the same defaults as new Cookie()");
  ok(rw.get("theme") === "dark" && rw.size === 2, "a set cookie is immediately visible through get()/size");
  rw.set("session", "xyz");
  ok(rw.toSetCookieHeaders().length === 2 && rw.get("session") === "xyz", "overwriting an arrived cookie replaces it rather than duplicating it");
  ok(rw.size === 2, "...and size does not double-count it");
  rw.set(new B.Cookie("flag", "1", { httpOnly: true }));
  ok(rw.toSetCookieHeaders().some((h) => h === "flag=1; Path=/; HttpOnly; SameSite=Lax"), "set(Cookie) accepts a whole Cookie object");
  rw.set({ name: "init", value: "2", secure: true });
  ok(rw.get("init") === "2", "set(CookieInit) accepts an options object");

  // A stored Cookie is held BY REFERENCE, as in Bun: mutating it afterwards
  // changes what the map serialises. Copying would be the quieter wrong choice.
  const byRef = new B.Cookie("ref", "one");
  const refMap = new M();
  refMap.set(byRef);
  byRef.value = "two";
  ok(refMap.get("ref") === "two" && refMap.toSetCookieHeaders()[0].indexOf("ref=two") === 0, "a Cookie handed to set() is stored by reference, not copied");

  // Deletion is a tombstone: invisible to reads, but it still has to serialise.
  const del = new M("session=abc; theme=dark");
  del.delete("session");
  ok(del.get("session") === null && del.has("session") === false, "a deleted cookie is invisible to get()/has()");
  ok(del.size === 1 && [...del.keys()].join() === "theme", "...and to size and iteration");
  ok(del.toSetCookieHeaders()[0] === "session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax", "...while still emitting the empty-value + past-expiry Set-Cookie that tells the browser to drop it");
  ok(del.toJSON().session === undefined, "toJSON omits a deleted cookie");
  const scoped = new M();
  scoped.delete({ name: "s", path: "/admin", domain: "example.com" });
  ok(scoped.toSetCookieHeaders()[0].indexOf("Domain=example.com; Path=/admin") !== -1, "delete() carries the path/domain it is given — a browser only drops a cookie whose scope matches");
  const host = new M();
  host.delete("__Host-session");
  ok(host.toSetCookieHeaders()[0].indexOf("; Secure") !== -1, "deleting a __Host-/__Secure- cookie carries Secure, because the stored cookie necessarily had it and the scopes must match or the delete is a no-op");
  ok(/Cookie name is required/.test((() => { try { new M().delete(42); return ""; } catch (e) { return e.message; } })()), "delete(non-string) throws rather than deleting something named \"42\"");
}

console.log("== the Bun.serve cookie hook (req.cookies) ==");
{
  // The hook itself, without a kernel or a socket: `attachRequestCookies` is what
  // Bun.serve's route dispatch calls, and `pendingSetCookies` is what its response
  // writer calls. The kernel spike (scripts/spike-bun.mjs) proves the same pair
  // over a real request; this proves the semantics.
  const { attachRequestCookies, pendingSetCookies } = await import("../packages/runtime/builtins/bun-cookie.js");

  const req = attachRequestCookies(new Request("http://x/", { headers: { cookie: "session=abc" } }), "session=abc");
  ok(req.cookies.get("session") === "abc", "req.cookies is a CookieMap over the request's Cookie header");
  ok(req.cookies === req.cookies, "the map is memoised — two reads are the same object, so a set() through one is visible through the other");
  ok(pendingSetCookies(req).length === 0, "a handler that only READ cookies contributes no Set-Cookie headers");
  req.cookies.set("theme", "dark");
  ok(JSON.stringify(pendingSetCookies(req)) === '["theme=dark; Path=/; SameSite=Lax"]', "a handler that set one contributes exactly that header");

  const untouched = attachRequestCookies(new Request("http://x/", { headers: { cookie: "a=1" } }), "a=1");
  ok(pendingSetCookies(untouched).length === 0, "a handler that never touched req.cookies contributes nothing — the map is built lazily on first access");
  ok(pendingSetCookies(new Request("http://x/")) .length === 0, "and a plain Request that was never hooked (the `fetch` handler's) is safe to ask");
  ok(!("cookies" in new Request("http://x/", { headers: { cookie: "a=1" } })), "a plain Request has NO .cookies: Bun puts it on BunRequest (the routes handler's argument) only, and offering it in `fetch` would make code that works here fail under real Bun");
}

console.log("== BunFile: Blob conformance and the lazy slice ==");
{
  const fs = nodeRequire("node:fs");
  const os = nodeRequire("node:os");
  const path = nodeRequire("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-bunfile-"));
  const at = (rel) => path.join(dir, rel);
  const io = [];
  const B = createBunRuntime({
    process: {
      env: {}, argv: ["bun"], cwd: () => dir,
      stdout: { isTTY: false, write: (s) => io.push("out:" + s) },
      stderr: { isTTY: false, write: (s) => io.push("err:" + s) },
      stdin: process.stdin,
    },
    Buffer,
    require: nodeRequire,
  }).Bun;
  fs.writeFileSync(at("hello.txt"), "hello world");
  const f = B.file(at("hello.txt"));
  ok(f.name === at("hello.txt"), "Bun.file(path).name is the path");
  ok(f.size === 11, "Blob.size is the file's current size");
  ok(f.type === "text/plain", "Blob.type comes from the extension");
  ok(B.file(at("x.json")).type === "application/json" && B.file(at("x.bin")).type === "application/octet-stream", "the extension table falls back to application/octet-stream");
  ok(B.file(at("x.txt"), { type: "text/csv" }).type === "text/csv", "an explicit type option wins over the extension");
  ok((await f.text()) === "hello world", ".text() reads the whole file");
  ok((await f.bytes()) instanceof Uint8Array && (await f.bytes()).length === 11, ".bytes() returns a Uint8Array");
  ok((await f.arrayBuffer()).byteLength === 11, ".arrayBuffer() returns an ArrayBuffer");
  ok((await B.write(at("d.json"), '{"a":1}')) === 7 && (await B.file(at("d.json")).json()).a === 1, ".json() parses the file");
  ok((await f.blob()) instanceof Blob, ".blob() hands back a real platform Blob");
  ok(f.stream() instanceof ReadableStream, ".stream() returns a web ReadableStream, as Bun does");
  ok((await new Response(f.stream()).text()) === "hello world", "...that yields the file's bytes");
  ok((await f.exists()) === true && (await B.file(at("nope.txt")).exists()) === false, ".exists() answers for both");
  ok((await B.file(dir).exists()) === false, ".exists() is false for a DIRECTORY — Bun documents it for regular files, and answering true turns the next read into a confusing EISDIR");
  ok(B.file(at("nope.txt")).size === 0, "a missing file has size 0 rather than throwing (Bun documents this)");
  ok(f.lastModified > 0, ".lastModified is the mtime");

  // .slice() is a LAZY VIEW. Bun documents it as "does not copy the file, open the
  // file, or modify the file" — the entire point is handing the last 4 KB of a 4 GB
  // log to something, and a slice that materialises bytes has the right contents
  // while turning a constant-memory program into an out-of-memory one.
  const ghost = B.file(at("later.txt")).slice(6, 11);
  fs.writeFileSync(at("later.txt"), "hello world");
  ok((await ghost.text()) === "world", "a slice taken BEFORE the file existed reads correctly afterwards — proof nothing was opened or copied at slice() time");
  ok(ghost.constructor.name === "BunFile" && typeof ghost.slice === "function", "slice() returns another BunFile, not a materialised Blob");
  ok(ghost.name === at("later.txt"), "...over the same path");
  ok(ghost.size === 5, "the slice's size is the window, not the file");
  fs.appendFileSync(at("later.txt"), "!!!");
  ok((await B.file(at("later.txt")).slice(6).text()) === "world!!!", "an open-ended slice follows a file that grows — the window resolves at READ time");
  ok((await f.slice(0, 5).text()) === "hello", "slice(begin, end)");
  ok((await f.slice(6).text()) === "world", "slice(begin)");
  ok((await f.slice(-5).text()) === "world", "a negative begin counts back from the end");
  ok((await f.slice(0, -6).text()) === "hello", "a negative end does too");
  ok((await f.slice(0, 8).slice(6).text()) === "wo", "slices COMPOSE: the second window is resolved inside the first");
  ok((await f.slice(0, 8).slice(0, 99).text()) === "hello wo", "a child slice cannot escape its parent's window");
  ok(f.slice("text/csv").type === "text/csv" && f.slice(0, 5, "text/csv").type === "text/csv" && f.slice(0, "text/csv").type === "text/csv", "all three documented overloads read a string argument as the contentType");
  ok(f.slice(0, 5).type === "text/plain", "a slice inherits the file's type when none is given");
  ok((await new Response(f.slice(6).stream()).text()) === "world", ".stream() honours the slice window");
  ok((await new Response(f.slice(3, 3).stream()).text()) === "", "an empty window streams as empty rather than throwing on end < start");
  ok((await f.slice(3, 3).text()) === "" && f.slice(99, 200).size === 0, "a degenerate or out-of-range window reads as empty");

  // Known divergence, pinned so it stays known: a BunFile here is not a platform
  // Blob INSTANCE (Bun's extends Blob), so `new Response(Bun.file(p))` — Bun's
  // one-liner for serving a file — stringifies instead of streaming. Making it
  // work is not portable: duck-typing satisfies Node's undici and not the browser
  // Worker's native Response, and `extends Blob` would make Node stream the file
  // while the BROWSER served an empty body from the (empty) internal blob state.
  // Silently right on the tier we test and silently wrong on the tier that ships
  // is the worst of the options, so the gap stays visible. Use
  // `new Response(Bun.file(p).stream())` or `await Bun.file(p).bytes()`.
  ok(!(f instanceof Blob), "a BunFile is not a platform Blob instance here — a documented divergence; it implements the Blob READ protocol and .blob() converts");
  ok((await new Response(f).text()).indexOf("object") !== -1, "so new Response(Bun.file(p)) stringifies rather than streaming — use .stream() (pinned as a known gap)");

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("== BunFile: FileSink flushes incrementally, and every write is chunked ==");
{
  const fs = nodeRequire("node:fs");
  const os = nodeRequire("node:os");
  const path = nodeRequire("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-bunsink-"));
  const at = (rel) => path.join(dir, rel);
  const io = [];
  const B = createBunRuntime({
    process: {
      env: {}, argv: ["bun"], cwd: () => dir,
      stdout: { isTTY: false, write: (s) => io.push("out:" + s) },
      stderr: { isTTY: false, write: (s) => io.push("err:" + s) },
      stdin: process.stdin,
    },
    Buffer,
    require: nodeRequire,
  }).Bun;
  const read = (rel) => (fs.existsSync(at(rel)) ? fs.readFileSync(at(rel), "utf8") : "<missing>");
  const throwsWith = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };
  const rejectsOn = async (fn) => { try { await fn(); return ""; } catch (e) { return (e.message || "") + " " + (e.code || ""); } };

  // The behaviour this batch exists to fix. The old sink pushed every chunk into
  // an array and wrote the lot in end(), which means a long-running writer holds
  // the whole file in memory and anything that stops the process first — a crash,
  // a process.exit, a killed preview — loses everything, silently.
  const sink = B.file(at("app.log")).writer({ highWaterMark: 16 });
  ok(sink.write("0123456789abcdefgh") === 18, "write() returns the byte count");
  ok(read("app.log") === "0123456789abcdefgh", "crossing the high-water mark drains to disk with NO end() — a crash here loses nothing");
  sink.write("ij");
  ok(read("app.log") === "0123456789abcdefgh", "a write below the mark stays buffered (one syscall per mark, not one per write)");
  ok(sink.flush() === 2, "flush() returns the bytes it drained");
  ok(read("app.log") === "0123456789abcdefghij", "...which are on disk immediately afterwards");
  ok(sink.flush() === 0, "flushing an empty buffer is a no-op returning 0");
  ok(sink.end() === 20, "end() returns the total written over the sink's lifetime");
  ok(/after end\(\)/.test(throwsWith(() => sink.write("x"))), "write() after end() throws instead of silently dropping data");
  ok(/expects a string/.test(throwsWith(() => B.file(at("t.log")).writer().write(42))), "write(number) throws rather than String()-ing it into bytes");

  ok(B.file(at("empty.log")).writer().end() === 0 && read("empty.log") === "", "end() materialises the file even when nothing was written — a loop that produced no rows must leave an empty file, not a missing one");
  fs.writeFileSync(at("keep.log"), "keep");
  B.file(at("keep.log")).writer();
  ok(read("keep.log") === "keep", "creating a writer and abandoning it neither creates nor truncates — the fd opens on the first write");

  // The 1 MiB syscall window (DATA_BYTES in packages/protocol/syscall.js; fs-client
  // caps each fd write at FD_CHUNK = 512 KiB and SHORT-WRITES the rest). A write
  // bigger than that must be chunked and the returned count believed, or the
  // failure shows up as a truncated file — nothing that looks like a size problem.
  const big = "x".repeat(1500000);
  ok((await B.write(at("big.bin"), big)) === 1500000, "Bun.write reports every byte of a payload larger than the syscall window");
  ok(fs.statSync(at("big.bin")).size === 1500000, "...and the file really is that long, not truncated at the window");
  const bigSink = B.file(at("big2.bin")).writer();
  bigSink.write(big);
  ok(bigSink.end() === 1500000 && fs.statSync(at("big2.bin")).size === 1500000, "a single FileSink.write() larger than the window is chunked the same way");
  ok((await B.file(at("big.bin")).slice(1499995).text()) === "xxxxx", "and a slice past the window boundary reads back correctly");

  // Reading is bounded too. `.stream()` is built from fd reads rather than
  // Readable.toWeb — it predates a working toWeb (which threw in the VM until
  // internal/webstreams/adapters.js was fixed) and it stays hand-built for the
  // bound this very check asserts: one <= 64 KiB chunk per pull, so streaming a
  // file never materialises it. Through a Readable the chunk size would be that
  // stream's highWaterMark. See builtins/bun-file.js.
  const stream = B.file(at("big.bin")).stream();
  ok(typeof stream.getReader === "function", ".stream() is a real WHATWG ReadableStream, not a Node Readable in disguise");
  const reader = stream.getReader();
  let streamed = 0;
  let widest = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    streamed += value.length;
    if (value.length > widest) widest = value.length;
  }
  ok(streamed === 1500000, "...that delivers every byte of a 1.5 MB file");
  ok(widest <= 64 * 1024, "...in bounded chunks, so a stream of a file bigger than memory stays a stream");

  // Bun.stdout / Bun.stderr as write targets. `Bun.write(Bun.stdout, Bun.file(p))`
  // is Bun's three-line cat, which is the whole reason these are BunFiles.
  ok((await B.write(B.stdout, "to-out")) === 6 && io.indexOf("out:to-out") !== -1, "Bun.write(Bun.stdout, string) writes to stdout and returns the byte count");
  ok((await B.write(B.stderr, "to-err")) === 6 && io.indexOf("err:to-err") !== -1, "Bun.write(Bun.stderr, …) writes to stderr");
  fs.writeFileSync(at("cat.txt"), "meow");
  ok((await B.write(B.stdout, B.file(at("cat.txt")))) === 4 && io.indexOf("out:meow") !== -1, "Bun.write(Bun.stdout, Bun.file(p)) is Bun's cat");
  const outSink = B.stdout.writer();
  outSink.write("sunk");
  outSink.flush();
  ok(io.indexOf("out:sunk") !== -1, "Bun.stdout.writer() streams through the same sink type");
  ok(/write-only sink/.test(await rejectsOn(() => B.stdout.text())), "reading Bun.stdout throws naming the API and the sandbox reason, rather than answering \"\"");
  ok(/write-only sink/.test(await rejectsOn(() => B.stderr.bytes())), "the same for Bun.stderr");
  ok(B.stdin === process.stdin, "Bun.stdin stays the Node stream this runtime has always returned — a documented divergence (Bun's is a BunFile) kept because guest code reads it with .on(\"data\")");

  // delete()/unlink(), and the throws that must stay throws.
  fs.writeFileSync(at("gone.txt"), "x");
  await B.file(at("gone.txt")).delete();
  ok(!fs.existsSync(at("gone.txt")), ".delete() removes the file");
  fs.writeFileSync(at("gone.txt"), "x");
  await B.file(at("gone.txt")).unlink();
  ok(!fs.existsSync(at("gone.txt")), ".unlink() is the documented alias for it");
  ok(/ENOENT/.test(await rejectsOn(() => B.file(at("gone.txt")).delete())), "deleting a file that is not there rejects, as fs.unlink would — it does not quietly succeed");

  ok(/VFS handles/.test(throwsWith(() => B.file(3))), "Bun.file(fd) still throws: our fd numbers are VFS handles, and String(3) would have opened the relative path \"3\"");
  ok(/VFS handles/.test(await rejectsOn(() => B.write(3, "x"))), "Bun.write(fd, …) throws for the same reason — it used to CREATE a file called \"1\" in the cwd and report success");
  ok(/expects a string path/.test(throwsWith(() => B.file())), "Bun.file() with no path throws instead of handing back a handle on the path \"undefined\"");
  ok(B.file(new URL("file://" + at("cat.txt"))).name === at("cat.txt"), "Bun.file(new URL(import.meta.url)) is accepted, and is not the literal path \"file:///…\"");

  ok((await B.write(at("nested/deep/x.txt"), "deep")) === 4 && read("nested/deep/x.txt") === "deep", "Bun.write creates missing parent directories");
  ok((await B.write(B.file(at("copy.txt")), B.file(at("cat.txt")))) === 4 && read("copy.txt") === "meow", "Bun.write(BunFile, BunFile) copies");
  ok((await B.write(at("blob.txt"), new Blob(["blobby"]))) === 6 && read("blob.txt") === "blobby", "Bun.write accepts anything with the Blob read protocol");
  ok((await B.file(at("copy.txt")).write("over")) === 4 && read("copy.txt") === "over", "BunFile.write(data) is Bun.write with this file as the destination");

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("== Bun.CryptoHasher: algorithms, copy, byteLength, static hash ==");
{
  // Everything below is pinned against a source OUTSIDE this repo: Bun's docs,
  // Bun's own test suite, or OpenSSL via the host's node:crypto. Nothing here
  // round-trips our output against our output.
  //
  // This first group runs with no wasm codec, so CryptoHasher falls back to the
  // host's node:crypto (OpenSSL). That covers every algorithm except blake2b256
  // and md4, which OpenSSL 3's default provider does not carry; those two are
  // covered against the Rust crate in the codec-gated group further down.
  const B = bunWith();
  const H = B.CryptoHasher;

  ok(H.algorithms.length === 19 && H.algorithms.includes("sha3-512") && H.algorithms.includes("blake2s256"), "CryptoHasher.algorithms lists Bun's 19 documented algorithms");
  ok(!H.algorithms.includes("blake3"), "…and does NOT include blake3");

  // blake3 is not an oversight. It is absent from Bun's documented list, from
  // EVP.Algorithm and from CryptoHasherZig — real Bun throws on it. Accepting it
  // would be the more dangerous divergence: sandbox code would break on real Bun.
  let msg = "";
  try { new H("blake3"); } catch (e) { msg = e.message; }
  ok(/Unsupported algorithm blake3/.test(msg), "new CryptoHasher('blake3') throws like real Bun (blake3 is not a Bun algorithm)");
  try { msg = ""; new H("nope"); } catch (e) { msg = e.message; }
  ok(/Unsupported algorithm nope/.test(msg), "an unknown algorithm throws with Bun's wording");

  // Bun's EVP.zig alias map, matched case-insensitively; `.algorithm` reports the
  // CANONICAL name whichever spelling went in.
  ok(new H("sha-256").algorithm === "sha256", "the 'sha-256' alias resolves, and .algorithm reports the canonical name");
  ok(new H("SHA512-256").algorithm === "sha512-256", "algorithm names are case-insensitive");
  ok(new H("sha-512/224").algorithm === "sha512-224" && new H("sha-512_224").algorithm === "sha512-224", "Bun's sha-512/224 and sha-512_224 spellings both resolve");
  ok(new H("rmd160").algorithm === "ripemd160" && new H("sha128").algorithm === "sha1", "the rmd160 and sha128 aliases resolve the way Bun maps them");

  // byteLength, including the two XOFs whose length is a Bun default, not intrinsic.
  ok(new H("sha256").byteLength === 32 && new H("sha512").byteLength === 64, "byteLength reports the digest size");
  ok(new H("shake128").byteLength === 16 && new H("shake256").byteLength === 32, "shake128/shake256 use Bun's default output lengths (16/32)");
  ok(new H("sha512-224").byteLength === 28 && new H("ripemd160").byteLength === 20, "byteLength is right for the less common digests");

  // Digests agree with OpenSSL for every algorithm the host provides.
  const nodeCrypto = nodeRequire("node:crypto");
  let agreed = 0, checked = 0;
  for (const algo of H.algorithms) {
    let expected;
    try { expected = nodeCrypto.createHash(algo).update("hello world").digest("hex"); } catch { continue; }
    checked++;
    if (new H(algo).update("hello world").digest("hex") === expected) agreed++;
  }
  ok(checked >= 15 && agreed === checked, `every algorithm the host's OpenSSL provides agrees with it (${agreed}/${checked})`);

  // digest() encodings and the write-into-a-TypedArray overload.
  const sha256Hello = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
  ok(new H("sha256").update("hello world").digest("hex") === sha256Hello, "sha256('hello world') matches the digest Bun's docs print");
  ok(new H("sha256").update("hello world").digest("base64") === "uU0nuZNNPgilLlLX2n2r+sSE7+N6U4DukIj3rOLvzek=", "…and so does the base64 form Bun's docs print");
  const bytes = new H("sha256").update("hello world").digest();
  ok(bytes instanceof Uint8Array && bytes.length === 32, "digest() with no argument returns 32 bytes");
  const into = new Uint8Array(32);
  const returned = new H("sha256").update("hello world").digest(into);
  ok(returned === into && Buffer.from(into).toString("hex") === sha256Hello, "digest(typedArray) writes in place and returns that array");
  try { msg = ""; new H("sha256").update("x").digest(new Uint8Array(8)); } catch (e) { msg = e.message; }
  ok(/TypedArray must be at least 32 bytes/.test(msg), "a too-small TypedArray throws with Bun's message");

  // update() input encodings.
  ok(new H("sha256").update("68656c6c6f20776f726c64", "hex").digest("hex") === sha256Hello, "update(str, 'hex') decodes before hashing");
  ok(new H("sha256").update(Buffer.from("hello world")).digest("hex") === sha256Hello, "update(Buffer) hashes the bytes");
  ok(new H("sha256").update(new TextEncoder().encode("hello world").buffer).digest("hex") === sha256Hello, "update(ArrayBuffer) hashes the bytes");
  try { msg = ""; new H("sha256").update("abc", "hex"); } catch (e) { msg = e.message; }
  ok(/invalid for data of length 3/.test(msg), "odd-length hex is rejected rather than silently hashing the even prefix");
  try { msg = ""; new H("sha256").update(null); } catch (e) { msg = e.message; }
  ok(/expected a string/.test(msg), "update(null) throws");

  // static hash().
  ok(H.hash("sha256", "hello world", "hex") === sha256Hello, "CryptoHasher.hash(algo, input, 'hex')");
  ok(Buffer.from(H.hash("sha256", "hello world")).toString("hex") === sha256Hello, "CryptoHasher.hash returns bytes with no encoding");
  const staticInto = new Uint8Array(32);
  ok(H.hash("sha256", "hello world", staticInto) === staticInto && Buffer.from(staticInto).toString("hex") === sha256Hello, "CryptoHasher.hash writes into a TypedArray");

  // copy(): the whole point is hashing a shared prefix once, then diverging.
  const base = new H("sha256").update("hello ");
  const a = base.copy(), b = base.copy();
  a.update("world");
  b.update("there");
  ok(a.digest("hex") === sha256Hello, "a copy that continues with 'world' gives sha256('hello world')");
  ok(b.digest("hex") === nodeCrypto.createHash("sha256").update("hello there").digest("hex"), "…and the sibling copy diverges to sha256('hello there')");
  ok(base.update("world").digest("hex") === sha256Hello, "the original is untouched by either copy");

  // A plain (non-HMAC) hasher IS reset by digest() and is reusable — the exact
  // opposite of the HMAC case below, which is why they are pinned separately.
  const reusable = new H("sha256");
  reusable.update("hello world");
  ok(reusable.digest("hex") === sha256Hello, "a plain hasher digests");
  ok(reusable.digest("hex") === nodeCrypto.createHash("sha256").digest("hex"), "…and is reset to empty afterwards, not left holding the old input");
  ok(reusable.update("hello world").digest("hex") === sha256Hello, "…so the same instance can be reused from scratch");
  ok(reusable.byteLength === 32 && reusable.algorithm === "sha256", "a used plain hasher still reports byteLength/algorithm");
}

console.log("== Bun.CryptoHasher HMAC: keyed digests and the consumed-instance trap ==");
{
  const B = bunWith();
  const H = B.CryptoHasher;

  // Known-answer table lifted verbatim from Bun's own test suite
  // (test/js/bun/util/bun-cryptohasher.test.ts): key "key", data "data\n".
  // These are Bun's numbers, not ours, and they are what makes this meaningful.
  const HMAC_VECTORS = {
    "md5": "4e7eb9f9332e4eb1dc5a2d7d065ba1bf",
    "sha1": "e2e1f7f597941d9b0021978618218a9e08731426",
    "sha224": "d34c3a2647d4f82a4e6baeaa7d94379eafd931e0c16cbc44b4ba4d1e",
    "sha256": "c7a7c96c73af32ea6e5b1ca6768b1d822249eb88f85160433d7b09bb2b21e170",
    "sha384": "2483522dcb7cb65fa13f0a3c1efe867abbd79ecb19a6ba4bac45d4f4bac31de2e2463b11838b8055601fad73d0b5af4c",
    "sha512": "f82266c950db24eba03f899466fdf905494709f09f98f4b7d7db31f1443a33b4fe5ca82f74fb360609d8a05a87fb065dd77bee912c27de89cbba7897061ac735",
    "sha512-224": "af398c7f21f58e1377580227a89590d3ab8be52b31182fad9ec4d667",
    "sha512-256": "0ed15b2750a2a7281e96af006ab79e82ed54a7a2081bdb49e70a70d8c6bfeff0",
    "sha3-224": "3dd0595758af01c6a9d662326acc3bc0c7e49b94573f74f800b6c114",
    "sha3-256": "5b246f6c8b41fbd23b7aa3a73c0c93c6a35d4973bc727b24ad65f538d51ff3b6",
    "sha3-384": "f0af5d4479dc409e11c6e23014893c42a51fbd3435c93452f6154a87128174e2492a6b31994b1436ae681b3f1d838613",
    "sha3-512": "b15ed8373f1b493ccd417a7591745fdefbb4aa7b85c6937284de678e1a7b73b31e4da07561d358fefa30c6b1cf1a4b19a4c0d2f4f6e90ddfadc3a12367cb1a3c",
    "ripemd160": "5291464ec22d15e61190b00b81b87c1a9dcb966f",
    "blake2b512": "9e66ba10f4d7e80abc2584150fc5f9a246634118280fd9ae086794d37cb9919d681ee285b68f9cec2eda9f878d157125cc465c8b0e3c023a7040ed0be7f25023",
  };
  let hmacOk = 0, hmacRun = 0;
  for (const [algo, expected] of Object.entries(HMAC_VECTORS)) {
    let got;
    try { got = new H(algo, "key").update("data\n").digest("hex"); } catch { continue; }
    hmacRun++;
    if (got === expected) hmacOk++;
    else console.log("    HMAC-" + algo + " mismatch: " + got);
  }
  ok(hmacRun >= 13 && hmacOk === hmacRun, `every HMAC vector from Bun's test suite reproduces (${hmacOk}/${hmacRun})`);

  // Key types Bun accepts.
  const expectedSha256 = HMAC_VECTORS["sha256"];
  ok(new H("sha256", Buffer.from("key")).update("data\n").digest("hex") === expectedSha256, "a Buffer key gives the same digest as a string key");
  ok(new H("sha256", new TextEncoder().encode("key").buffer).update("data\n").digest("hex") === expectedSha256, "an ArrayBuffer key does too");

  // Bun rejects XOFs for HMAC at CONSTRUCTION time (there is no fixed-length
  // pairing to key), while the same algorithms are fine unkeyed.
  for (const algo of ["shake128", "shake256"]) {
    let threw = false;
    try { new H(algo, "key"); } catch { threw = true; }
    ok(threw, `new CryptoHasher('${algo}', key) throws — Bun has no HMAC for it`);
    let plainOk = false;
    try { new H(algo).update("x").digest(); plainOk = true; } catch {}
    ok(plainOk, `…while unkeyed ${algo} still works, exactly as in Bun`);
  }

  // THE TRAP. In real Bun an HMAC instance is NOT reset by .digest(); its context
  // is released and every further use throws "HMAC has been consumed and is no
  // longer usable". The natural implementation resets it and cheerfully keeps
  // hashing — self-consistent, and quietly producing digests real Bun refuses to
  // produce at all, so the divergence only surfaces once the code leaves here.
  const hmac = new H("sha256", "key");
  hmac.update("data\n");
  const copied = hmac.copy();
  ok(hmac.algorithm === "sha256" && hmac.byteLength === 32, "a live HMAC reports algorithm and byteLength");
  ok(copied instanceof H && copied.copy() instanceof H, "an HMAC can be copied before digesting, and copies can be copied");
  ok(hmac.digest("hex") === expectedSha256, "the HMAC digests");
  ok(copied.digest("hex") === expectedSha256, "and its copy independently produces the same digest");
  for (const [what, fn] of [
    ["digest", () => hmac.digest()],
    ["update", () => hmac.update("more")],
    ["copy", () => hmac.copy()],
    ["byteLength", () => hmac.byteLength],
    ["algorithm", () => hmac.algorithm],
  ]) {
    let m = "";
    try { fn(); } catch (e) { m = e.message; }
    ok(m === "HMAC has been consumed and is no longer usable", `.${what} on a consumed HMAC throws Bun's exact message`);
  }
  let m2 = "";
  try { copied.digest(); } catch (e) { m2 = e.message; }
  ok(/consumed/.test(m2), "the consumed copy is just as dead as the original");

  // The copy-then-diverge example straight out of https://bun.com/docs/api/hashing,
  // digests included. This is the documented behaviour of .copy() on an HMAC.
  const doc = new H("sha256", "secret-key");
  doc.update("hello world");
  const docCopy = doc.copy();
  docCopy.update("!");
  ok(docCopy.digest("hex") === "3840176c3d8923f59ac402b7550404b28ab11cb0ef1fa199130a5c37864b5497", "the documented copy-and-extend digest matches Bun's docs");
  ok(doc.digest("hex") === "095d5a21fe6d0646db223fdf3de6436bb8dfb2fab0b51677ecf6441fcf5f2a67", "…and the original still yields the documented digest for the shared prefix");
}

console.log("== Bun.password: pure helpers (no codec needed) ==");
{
  // The bcrypt pre-hash decision is the one piece of Bun.password that can be
  // wrong in a way nothing catches until production, so it is isolated as a pure
  // function and pinned on both sides of the boundary.
  const enc = (s) => Buffer.from(s);
  const sha512 = (b) => nodeRequire("node:crypto").createHash("sha512").update(b).digest();

  ok(BCRYPT_MAX_INPUT_BYTES === 72, "bcrypt's key-material limit is 72 bytes");
  const at71 = enc("a".repeat(71)), at72 = enc("a".repeat(72)), at73 = enc("a".repeat(73));
  ok(bcryptKeyMaterial(at71, sha512) === at71, "a 71-byte password is passed to bcrypt untouched");
  // Bun's test is `password.len > 72`, so exactly 72 is NOT pre-hashed. Off by one
  // here and exactly one password length silently stops verifying in production.
  ok(bcryptKeyMaterial(at72, sha512) === at72, "a password of exactly 72 bytes is NOT pre-hashed (Bun's test is > 72, not >= 72)");
  const over = bcryptKeyMaterial(at73, sha512);
  ok(over !== at73 && over.length === 64, "a 73-byte password IS pre-hashed, to 64 raw bytes");
  ok(Buffer.from(over).equals(sha512(at73)), "…and those bytes are the RAW SHA-512 digest, not hex and not base64");
  // Multibyte matters: 24 three-byte characters is 72 bytes, not 24.
  ok(bcryptKeyMaterial(enc("héllo".repeat(15)), sha512).length === 64, "the limit is counted in bytes, so a multibyte passphrase crosses it sooner");

  // Bun's default parameters, read out of PasswordObject.zig rather than guessed.
  ok(BUN_ARGON2_DEFAULTS.memoryCost === 65536 && BUN_ARGON2_DEFAULTS.timeCost === 2 && BUN_ARGON2_DEFAULTS.parallelism === 1, "argon2id defaults are Bun's m=65536, t=2, p=1");
  ok(BUN_BCRYPT_DEFAULT_COST === 10, "bcrypt's default cost is 10");
  ok(parsePasswordOptions(undefined).algorithm === "argon2id", "no options means argon2id");
  ok(parsePasswordOptions("bcrypt").cost === 10, "a bare 'bcrypt' string selects bcrypt at the default cost");
  ok(parsePasswordOptions({ algorithm: "argon2id", memoryCost: 8, timeCost: 1 }).memoryCost === 8, "explicit argon2 costs are honoured, not clamped");
  let optErr = "";
  try { parsePasswordOptions({ algorithm: "bcrypt", cost: 3 }); } catch (e) { optErr = e.message; }
  ok(/between 4 and 31/.test(optErr), "a bcrypt cost outside 4..31 throws with Bun's message");
  try { optErr = ""; parsePasswordOptions({ algorithm: "scrypt" }); } catch (e) { optErr = e.message; }
  ok(/unknown algorithm/.test(optErr), "an unknown algorithm throws with Bun's message");

  // Bun's Algorithm.get(): the prefix decides, and a null answer is an ERROR.
  ok(detectPasswordAlgorithm("$argon2id$v=19$m=8,t=1,p=1$aaaa$bbbb") === "argon2id", "a PHC argon2id string is detected");
  ok(detectPasswordAlgorithm("$argon2i$x") === "argon2i" && detectPasswordAlgorithm("$argon2d$x") === "argon2d", "argon2i and argon2d are detected");
  ok(detectPasswordAlgorithm("$2b$10$abc") === "bcrypt" && detectPasswordAlgorithm("$2a$10$abc") === "bcrypt" && detectPasswordAlgorithm("$2y$10$abc") === "bcrypt", "every bcrypt modular-crypt variant is detected");
  ok(detectPasswordAlgorithm("notahash") === null && detectPasswordAlgorithm("$scrypt$x") === null, "an unrecognised string detects as null, which is what makes verify throw");
  ok(detectPasswordAlgorithm("$vv-argon2id$c2FsdA==$a2V5") === "vv-legacy", "the pre-argon2 Vivari format is recognised as legacy (see the migration note in bun-crypto.js)");
}

console.log("== Bun.password / CryptoHasher against the real Rust crate ==");
{
  // The groups above deliberately run without the wasm codec. This one needs it:
  // argon2id and bcrypt have no JavaScript stand-in, and the Rust HMAC for the
  // BLAKE2 family is hand-written (RustCrypto's `hmac` will not wrap BLAKE2), so
  // it has to be pinned against Bun's vector rather than against OpenSSL.
  //
  // The codec is gitignored and built by CI. In the Wasm-free gate it is absent
  // and this group announces itself as skipped; the `verify` job builds
  // build:crypto:node and re-runs this spike, so these checks do gate every PR.
  let codec = null;
  try {
    codec = nodeRequire("../packages/crypto/pkg-node/vivari_crypto.js");
  } catch {
    codec = null;
  }
  if (!codec) {
    console.log("  (skipped: packages/crypto/pkg-node not built — run 'npm run build:crypto:node'.");
    console.log("   These run in CI's verify job, which builds the crate first.)");
  } else {
    // The same binding node:crypto uses, over the same codec, handed to the Bun
    // shim through the process.binding('crypto') seam it uses in the runtime.
    const binding = createCryptoBinding({ codec });
    const proc = { env: {}, argv: ["bun"], cwd: () => "/", stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, binding: (n) => (n === "crypto" ? binding : {}) };
    const Bun = createBunRuntime({ process: proc, Buffer, require: nodeRequire }).Bun;

    // The two algorithms the host's OpenSSL cannot provide, so they are only ever
    // checked here. Published reference vectors, not our own output.
    ok(new Bun.CryptoHasher("blake2b256").update("").digest("hex") === "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8", "blake2b256 matches the published BLAKE2b-256 vector for the empty input");
    ok(new Bun.CryptoHasher("md4").update("abc").digest("hex") === "a448017aaf21d8525fc10ae87aa6729d", "md4('abc') matches RFC 1320");
    // BLAKE2b cannot go through RustCrypto's `hmac` (it uses a lazy block buffer),
    // so packages/crypto spells the HMAC construction out by hand. This is the
    // check that says the hand-written version is right.
    ok(new Bun.CryptoHasher("blake2b512", "key").update("data\n").digest("hex") === "9e66ba10f4d7e80abc2584150fc5f9a246634118280fd9ae086794d37cb9919d681ee285b68f9cec2eda9f878d157125cc465c8b0e3c023a7040ed0be7f25023", "the hand-written HMAC-BLAKE2b-512 matches Bun's published vector");

    // ---- argon2id: hashes REAL BUN PRODUCED, taken from bun.com/docs/api/hashing.
    // This is the property that matters and the one the old shim could not have:
    // a string written by Bun verifies here, so a string written here verifies
    // under Bun. Nothing about our own output is evidence of that.
    ok(Bun.password.verifySync("super-secure-pa$$word", "$argon2id$v=19$m=65536,t=2,p=1$tFq+9AVr1bfPxQdh6E8DQRhEXg/M/SqYCNu6gVdRRNs$GzJ8PuBi+K+BVojzPfS5mjnC8OpLGtv8KJqF99eP6a4") === true, "an argon2id PHC hash printed in Bun's docs verifies");
    ok(Bun.password.verifySync("hello", "$argon2id$v=19$m=65536,t=2,p=1$xXnlSvPh4ym5KYmxKAuuHVlDvy2QGHBNuI6bJJrRDOs$2YY6M48XmHn+s5NoBaL+ficzXajq2Yj8wut3r0vnrwI") === true, "so does the second argon2id hash in Bun's docs");
    ok(Bun.password.verifySync("wrong", "$argon2id$v=19$m=65536,t=2,p=1$xXnlSvPh4ym5KYmxKAuuHVlDvy2QGHBNuI6bJJrRDOs$2YY6M48XmHn+s5NoBaL+ficzXajq2Yj8wut3r0vnrwI") === false, "…and a wrong password against it is false, not an error");
    // The phc-winner-argon2 reference implementation's own vector.
    ok(Bun.password.verifySync("password", "$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc") === true, "the phc-winner-argon2 reference vector verifies");

    // ---- bcrypt: likewise a hash real Bun printed.
    ok(Bun.password.verifySync("hello", "$2b$10$Lyj9kHYZtiyfxh2G60TEfeqs7xkkGiEFFDi3iJGc50ZG/XJ1sxIFi") === true, "the bcrypt modular-crypt hash printed in Bun's docs verifies");
    // Canonical Openwall/crypt_blowfish vectors — the primitive itself.
    ok(Bun.password.verifySync("U*U", "$2a$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW") === true, "the Openwall bcrypt vector U*U verifies");
    ok(Bun.password.verifySync("U*U*U", "$2a$05$XXXXXXXXXXXXXXXXXXXXXOAcXxm9kjPGEMsLznoKqmqw7tc8WCx4a") === true, "the Openwall bcrypt vector U*U*U verifies");

    // ---- THE >72-BYTE TRAP, pinned by Bun's own cross-version fixture.
    // Bun's test suite carries this hash (written by Bun 1.2.4) with a comment
    // saying that changing the pre-hash mechanism invalidates it. If our
    // construction were hex, or base64, or SHA-256, or applied at >= 72 instead of
    // > 72, this one line would fail and every other check here would still pass.
    const long = "hello".repeat(100); // 500 bytes
    ok(Bun.password.verifySync(long, "$2b$10$PsJ3/W82mzNJoP0rSblfvet2ab9jZg2aH7tIxr1B8uFLJwuWk/jTi") === true, "a 500-byte password verifies against the bcrypt hash Bun 1.2.4 wrote for it (SHA-512 pre-hash, raw bytes)");
    ok(Bun.password.verifySync("hello".repeat(14), "$2b$10$PsJ3/W82mzNJoP0rSblfvet2ab9jZg2aH7tIxr1B8uFLJwuWk/jTi") === false, "a different long password does not");

    // Our own hashes are parseable by the standard formats, and the boundary
    // passwords round-trip in both directions across the pre-hash threshold.
    const b72 = "a".repeat(72), b73 = "a".repeat(73);
    const h72 = Bun.password.hashSync(b72, { algorithm: "bcrypt", cost: 4 });
    const h73 = Bun.password.hashSync(b73, { algorithm: "bcrypt", cost: 4 });
    ok(/^\$2b\$04\$[./A-Za-z0-9]{53}$/.test(h72) && h72.length === 60, "bcrypt output is a 60-character $2b$ modular-crypt string");
    ok(Bun.password.verifySync(b72, h72) === true && Bun.password.verifySync(b73, h73) === true, "passwords just under and just over the 72-byte line each verify against their own hash");
    ok(Bun.password.verifySync(b73, h72) === false && Bun.password.verifySync(b72, h73) === false, "…and do not verify against each other's, so the pre-hash is not silently truncating");

    // argon2id output shape: Bun's exact PHC encoding.
    const argonHash = Bun.password.hashSync("correct horse", { algorithm: "argon2id", memoryCost: 8, timeCost: 1 });
    ok(argonHash.startsWith("$argon2id$v=19$m=8,t=1,p=1$"), "argon2id emits Bun's PHC encoding with the caller's costs, unclamped");
    const fields = argonHash.split("$");
    ok(fields[4].length === 43 && fields[5].length === 43, "…with Bun's 32-byte salt and 32-byte tag");
    ok(Bun.password.verifySync("correct horse", argonHash) === true && Bun.password.verifySync("wrong horse", argonHash) === false, "argon2id round-trips");
    ok(Bun.password.hashSync("x", { algorithm: "argon2i", memoryCost: 8, timeCost: 1 }).startsWith("$argon2i$"), "argon2i is selectable and self-identifies");
    ok(Bun.password.hashSync("x", { algorithm: "argon2d", memoryCost: 8, timeCost: 1 }).startsWith("$argon2d$"), "argon2d too");
    ok(Bun.password.hashSync("x", { algorithm: "argon2id", memoryCost: 8, timeCost: 1 }) !== Bun.password.hashSync("x", { algorithm: "argon2id", memoryCost: 8, timeCost: 1 }), "each hash gets a fresh random salt");

    // A hostile or corrupted PHC string must be rejected BEFORE its m= reaches the
    // allocator: wasm32 has a 4 GiB address space and Rust ABORTS the module on
    // allocation failure, which would poison the whole process rather than throw.
    for (const [what, tampered] of [
      ["timeCost", argonHash.replace(",t=1,", ",t=100000,")],
      ["memoryCost", argonHash.replace("$m=8,", "$m=4294967294,")],
      ["parallelism", argonHash.replace(",p=1$", ",p=65$")],
    ]) {
      let threw = false;
      try { Bun.password.verifySync("correct horse", tampered); } catch { threw = true; }
      ok(threw, `an absurd ${what} in the encoded hash is rejected before anything is allocated from it`);
    }

    // verify() dispatches on the stored string, like Bun's Algorithm.get().
    ok(Bun.password.verifySync("hello", "") === false, "an empty stored hash is false, not an error (Bun checks length first)");
    let vErr = "";
    try { Bun.password.verifySync("hello", "definitely-not-a-hash"); } catch (e) { vErr = e.message; }
    ok(/not a recognised password hash/.test(vErr), "an unparseable stored hash THROWS — 'not a hash' and 'wrong password' are different answers");

    // MIGRATION: pre-argon2 `$vv-…` hashes still verify, and nothing emits them
    // any more. See the note on LEGACY_PREFIX in bun-crypto.js for why accepting
    // beats throwing here (real Bun can never hold one of these strings).
    const crypto = nodeRequire("node:crypto");
    const legacySalt = crypto.randomBytes(16);
    const legacy = "$vv-argon2id$" + legacySalt.toString("base64") + "$" + crypto.scryptSync("old-secret", legacySalt, 32).toString("base64");
    ok(Bun.password.verifySync("old-secret", legacy) === true, "a hash written by the pre-argon2 shim still verifies");
    ok(Bun.password.verifySync("wrong", legacy) === false, "…and rejects the wrong password rather than throwing");
    ok(!Bun.password.hashSync("new-secret").startsWith("$vv-"), "but nothing produces the legacy format any more");

    // Default algorithm and the async twins. This is the only place the DEFAULT
    // argon2id cost (m=65536 KiB = 64 MiB, t=2) actually runs; see roadmap.md for
    // the measured cost. Everything else above uses m=8 to stay cheap.
    const t0 = Date.now();
    const defaultHash = Bun.password.hashSync("s3cret");
    const hashMs = Date.now() - t0;
    ok(defaultHash.startsWith("$argon2id$v=19$m=65536,t=2,p=1$"), `the default is argon2id at Bun's documented cost (took ${hashMs}ms in wasm)`);
    ok(Bun.password.verifySync("s3cret", defaultHash) === true && Bun.password.verifySync("nope", defaultHash) === false, "the default hash round-trips");
    ok((await Bun.password.verify("s3cret", await Bun.password.hash("s3cret", { algorithm: "bcrypt", cost: 4 }))) === true, "the async hash/verify twins work too");
  }
}

// ── bun:sqlite ───────────────────────────────────────────────────────────────
// The REAL engine, driven with no kernel: packages/runtime/builtins/bun-sqlite.js
// takes its filesystem by injection, so the same shipped code that runs against the
// Wasm VFS in a guest process runs here against node:fs. That is what lets the tier CI
// enforces on every PR test actual SQL rather than a mock.
//
// Assertions are pinned to facts from OUTSIDE this repo wherever possible — SQLite's
// documented result codes and file header, Bun's documented return shapes and its own
// worked examples — rather than to what this implementation happens to produce, which
// would pass just as happily against a wrong one.
{
  console.log("\n== bun:sqlite (real wasm SQLite over node:fs) ==");
  const nodeFs = nodeRequire("node:fs");
  const nodePath = nodeRequire("node:path");
  const nodeCrypto = nodeRequire("node:crypto");
  const { createBunSqlite, resultCodeName, transactionPlan, coerceBoundValue, readInteger,
    planBindings, trampolineModuleBytes, makeTrampoline, IO_METHODS_SIZE, VFS_SIZE,
    ENGINE_MEMORY } = await import("../packages/runtime/builtins/bun-sqlite.js");

  // ---- pure helpers: no engine needed ----
  //
  // The trampoline encoder and the struct sizes are the two places where a one-byte or
  // one-field mistake produces a wild indirect call and a crash with no usable stack.
  // They are cheap to pin and expensive to debug, so they are pinned.
  {
    const bytes = trampolineModuleBytes("iiiij");
    ok(bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d,
      "trampoline module starts with the wasm magic \\0asm");
    ok(WebAssembly.validate(bytes), "trampoline module for 'iiiij' validates");
    const roundTrip = makeTrampoline((a, b, c, d) => Number(d) + a + b + c, "iiiij");
    ok(roundTrip(1, 2, 3, 10n) === 16, "trampoline passes i32s and an i64 (BigInt) through");
    ok(makeTrampoline((x) => x * 2, "dd")(2.5) === 5, "trampoline handles f64");
    let threw = null;
    try { trampolineModuleBytes("zz"); } catch (e) { threw = e; }
    ok(threw instanceof TypeError, "an unknown signature letter throws rather than emitting bad bytes");
    // sqlite3_io_methods v1 = iVersion + 12 pointers; sqlite3_vfs v1 = 6 header fields
    // + 12 pointers. Both from sqlite3.h, at 4-byte wasm32 pointers.
    ok(IO_METHODS_SIZE === 52, `sqlite3_io_methods (v1) is 52 bytes, got ${IO_METHODS_SIZE}`);
    ok(VFS_SIZE === 72, `sqlite3_vfs (v1) is 72 bytes, got ${VFS_SIZE}`);
    ok(ENGINE_MEMORY.initial === 128 && ENGINE_MEMORY.maximum === 32768 ,
      "engine memory matches the limits the module declares (128..32768 pages, unshared)");
  }

  // Result-code names, pinned to sqlite3.h's own arithmetic (extended = primary |
  // subcode<<8). These are what land on SQLiteError.code, which applications branch on.
  {
    ok(resultCodeName(0) === "SQLITE_OK", "0 -> SQLITE_OK");
    ok(resultCodeName(19) === "SQLITE_CONSTRAINT", "19 -> SQLITE_CONSTRAINT");
    ok(resultCodeName(2067) === "SQLITE_CONSTRAINT_UNIQUE", "2067 -> SQLITE_CONSTRAINT_UNIQUE");
    ok(resultCodeName(1299) === "SQLITE_CONSTRAINT_NOTNULL", "1299 -> SQLITE_CONSTRAINT_NOTNULL");
    ok(resultCodeName(787) === "SQLITE_CONSTRAINT_FOREIGNKEY", "787 -> SQLITE_CONSTRAINT_FOREIGNKEY");
    ok(resultCodeName(522) === "SQLITE_IOERR_SHORT_READ", "522 -> SQLITE_IOERR_SHORT_READ");
    ok(resultCodeName(101) === "SQLITE_DONE", "101 -> SQLITE_DONE");
    ok(resultCodeName(19 | (99 << 8)) === "SQLITE_CONSTRAINT",
      "an unknown subcode degrades to the primary name instead of inventing one");
  }

  // Transaction SQL. Bun documents the exact spellings: a bare call uses "BEGIN" and
  // .deferred uses "BEGIN DEFERRED". Depth > 0 must be a SAVEPOINT, and its rollback
  // must be BOTH statements — ROLLBACK TO alone leaves the savepoint on the stack.
  {
    ok(transactionPlan("default", 0).begin === "BEGIN", "depth 0 default -> BEGIN");
    ok(transactionPlan("deferred", 0).begin === "BEGIN DEFERRED", "depth 0 deferred -> BEGIN DEFERRED");
    ok(transactionPlan("immediate", 0).begin === "BEGIN IMMEDIATE", "depth 0 immediate -> BEGIN IMMEDIATE");
    ok(transactionPlan("exclusive", 0).begin === "BEGIN EXCLUSIVE", "depth 0 exclusive -> BEGIN EXCLUSIVE");
    ok(transactionPlan("default", 0).commit === "COMMIT", "depth 0 commits with COMMIT");
    ok(JSON.stringify(transactionPlan("default", 0).rollback) === '["ROLLBACK"]', "depth 0 rolls back with ROLLBACK");
    const nested = transactionPlan("immediate", 1);
    ok(nested.begin === "SAVEPOINT _bun_sqlite_sp_1", "depth 1 -> SAVEPOINT, not BEGIN");
    ok(nested.commit === "RELEASE _bun_sqlite_sp_1", "depth 1 commits with RELEASE");
    ok(JSON.stringify(nested.rollback) === '["ROLLBACK TO _bun_sqlite_sp_1","RELEASE _bun_sqlite_sp_1"]',
      "depth 1 rollback is ROLLBACK TO *and* RELEASE");
    ok(transactionPlan("default", 2).begin === "SAVEPOINT _bun_sqlite_sp_2", "savepoint names are per-depth");
  }

  // Value coercion, per Bun's documented datatype table.
  {
    ok(coerceBoundValue(null).kind === "null" && coerceBoundValue(undefined).kind === "null",
      "null and undefined both bind NULL");
    ok(coerceBoundValue(true).value === 1n && coerceBoundValue(false).value === 0n, "boolean -> INTEGER 1/0");
    ok(coerceBoundValue(7).kind === "int" && coerceBoundValue(7).value === 7n, "an integral number binds as int64");
    ok(coerceBoundValue(1.5).kind === "double", "a non-integral number binds as double");
    ok(coerceBoundValue("x").kind === "text", "string -> TEXT");
    ok(coerceBoundValue(new Uint8Array(2)).kind === "blob", "Uint8Array -> BLOB");
    ok(coerceBoundValue(new ArrayBuffer(2)).kind === "blob", "ArrayBuffer -> BLOB");
    let threw = null;
    try { coerceBoundValue(2n ** 64n); } catch (e) { threw = e; }
    ok(threw instanceof RangeError && /out of range/.test(threw.message),
      "a bigint beyond int64 throws RangeError rather than wrapping");
    ok(coerceBoundValue(2n ** 63n - 1n).value === 2n ** 63n - 1n, "int64 max binds exactly");
    threw = null;
    try { coerceBoundValue({ a: 1 }); } catch (e) { threw = e; }
    ok(threw instanceof TypeError, "an unsupported type throws instead of being stringified into the database");
    // Bun's own documented example: 9007199254741093n comes back as 9007199254741092.
    ok(readInteger(9007199254741093n, false) === 9007199254741092,
      "safeIntegers off reproduces Bun's documented 9007199254741093 -> 9007199254741092");
    ok(readInteger(9007199254741093n, true) === 9007199254741093n, "safeIntegers on keeps the BigInt");
  }

  // Binding plans. strict changes BOTH the key spelling and the missing-key behaviour.
  {
    const names = ["$a", "$b"];
    ok(JSON.stringify(planBindings([1, 2], names, false)) === '[{"index":1,"value":1},{"index":2,"value":2}]',
      "rest arguments bind positionally");
    ok(planBindings([{ $a: 9 }], names, false).length === 1, "non-strict binds only the keys present");
    ok(planBindings([{ $a: 9 }], names, false)[0].value === 9, "non-strict matches on the prefixed name");
    ok(planBindings([{ a: 9 }], names, false).length === 0, "non-strict ignores an unprefixed key (-> NULL)");
    ok(planBindings([{ a: 9, b: 8 }], names, true).length === 2, "strict matches on the bare name");
    let threw = null;
    try { planBindings([{ a: 9 }], names, true); } catch (e) { threw = e; }
    ok(threw && /Missing parameter "b"/.test(threw.message), "strict names the missing parameter");
    ok(planBindings([new Uint8Array(2)], ["?"], false).length === 1,
      "a lone Uint8Array is a positional blob, not a named-binding object");
  }

  // ---- the real engine ----
  //
  // The artifact is COMMITTED (packages/runtime/vendor/sqlite/sqlite3.wasm), so a
  // missing one means a broken checkout, not an un-run build step. Fail loudly: a spike
  // that skips here would go green while testing nothing, which is the trap AGENTS.md
  // warns about.
  const ENGINE = nodePath.resolve("packages/runtime/vendor/sqlite/sqlite3.wasm");
  if (!nodeFs.existsSync(ENGINE)) {
    console.log("  \u2717 " + ENGINE + " is missing — it is a COMMITTED artifact, so this is a broken");
    console.log("      checkout. Restore it with git, or re-create it with:");
    console.log("      node scripts/vendor-sqlite.mjs --refresh");
    failed++;
  } else {
    const DIR = nodeFs.mkdtempSync(nodePath.join(nodeRequire("node:os").tmpdir(), "vv-spike-sqlite-"));
    const sqlite = createBunSqlite({
      fs: nodeFs,
      path: nodePath.posix,
      cwd: () => DIR,
      randomBytes: (n) => nodeCrypto.randomFillSync(new Uint8Array(n)),
      resolveEngineBytes: () => nodeFs.readFileSync(ENGINE),
    });
    const { Database, SQLiteError, constants } = sqlite;

    // The engine is the official sqlite.org build, and our VFS really is the default.
    {
      const db = new Database(":memory:");
      const version = db.query("SELECT sqlite_version() AS v").get().v;
      ok(/^3\.\d+\.\d+$/.test(version), `sqlite_version() is a real SQLite version (${version})`);
      ok(sqlite.__engineInfo().vfs === "vivari", "the registered VFS is the default one");
      db.close();
    }

    // Types round-trip, and .get()/.run() return what Bun documents.
    {
      const db = new Database(":memory:");
      db.run("CREATE TABLE t(id INTEGER PRIMARY KEY, s TEXT, f REAL, b BLOB, n INTEGER)");
      const r = db.run("INSERT INTO t(s,f,b,n) VALUES(?,?,?,?)", "hi", 1.5, new Uint8Array([1, 2, 3]), null);
      ok(r.changes === 1, "run() reports changes");
      ok(r.lastInsertRowid === 1, "run() reports lastInsertRowid");
      const row = db.query("SELECT * FROM t").get();
      ok(row.s === "hi" && row.f === 1.5, "TEXT and REAL round-trip");
      ok(row.b instanceof Uint8Array && row.b.length === 3 && row.b[2] === 3, "BLOB comes back as a Uint8Array");
      ok(row.n === null, "SQL NULL comes back as JS null");
      ok(db.query("SELECT 1 WHERE 0").get() === null, "Bun documents .get() as null (not undefined) with no rows");
      ok(JSON.stringify(db.query("SELECT id,s FROM t").values()) === '[[1,"hi"]]', ".values() is an array of arrays");
      ok(db.query("SELECT s FROM t").all().length === 1, ".all() is an array of row objects");
      // UTF-8 past the BMP: a length-in-bytes vs length-in-chars bug truncates here.
      db.run("INSERT INTO t(s) VALUES(?)", "héllo 🌍 世界");
      ok(db.query("SELECT s FROM t WHERE id=2").get().s === "héllo 🌍 世界", "multi-byte UTF-8 survives the heap round-trip");
      db.close();
    }

    // Statement metadata + caching.
    {
      const db = new Database(":memory:");
      db.run("CREATE TABLE m(a INTEGER, b TEXT)");
      db.run("INSERT INTO m VALUES(1,'x')");
      const st = db.query("SELECT a, b FROM m");
      ok(st.columnTypes === null, "columnTypes is null until a row has been produced (Bun's documented rule)");
      st.all();
      ok(JSON.stringify(st.columnNames) === '["a","b"]', "columnNames");
      ok(JSON.stringify(st.columnTypes) === '["INTEGER","TEXT"]', "columnTypes reflects the first row's actual values");
      ok(JSON.stringify(st.declaredTypes) === '["INTEGER","TEXT"]', "declaredTypes comes from the schema");
      ok(db.query("SELECT ?1, ?2, ?3").paramsCount === 3, "paramsCount");
      ok(db.query("SELECT 1") === db.query("SELECT 1"), "query() returns the SAME cached Statement (Bun)");
      ok(db.prepare("SELECT 1") !== db.prepare("SELECT 1"), "prepare() is uncached");
      const reused = db.query("SELECT ? AS v");
      ok(reused.get(1).v === 1 && reused.get(2).v === 2 && reused.get(3).v === 3,
        "a cached statement rebinds fresh parameters each call (Bun's documented example)");
      const q = db.query("SELECT $p AS p");
      q.run(42);
      ok(q.toString() === "SELECT 42 AS p", `toString() expands the bound SQL (got ${q.toString()})`);
      db.close();
    }

    // safeIntegers, both directions. This is the single most likely silent-corruption
    // bug in the whole surface, so it is checked at the 2^53 boundary specifically.
    {
      const loose = new Database(":memory:");
      ok(loose.query("SELECT 9007199254741093 AS n").get().n === 9007199254741092,
        "default (safeIntegers off) reproduces Bun's documented truncation");
      const safe = new Database(":memory:", { safeIntegers: true });
      ok(safe.query("SELECT 9007199254741093 AS n").get().n === 9007199254741093n,
        "safeIntegers:true returns an exact BigInt");
      safe.run("CREATE TABLE i(n INTEGER)");
      const max = 9223372036854775807n; // int64 max
      safe.run("INSERT INTO i VALUES(?)", max);
      ok(safe.query("SELECT n FROM i").get().n === max, "int64 max binds and reads back exactly");
      let threw = null;
      try { safe.run("INSERT INTO i VALUES(?)", 2n ** 64n); } catch (e) { threw = e; }
      ok(threw instanceof RangeError, "a bound bigint beyond 64 bits throws (Bun documents this for safeIntegers)");
      // lastInsertRowid follows the same rule, per Bun's Changes type.
      ok(typeof safe.run("INSERT INTO i VALUES(1)").lastInsertRowid === "bigint",
        "lastInsertRowid is a bigint when safeIntegers is on");
      ok(typeof loose.run("CREATE TABLE j(x)").lastInsertRowid === "number",
        "…and a number when it is off");
      const perStatement = loose.query("SELECT 9007199254741093 AS n").safeIntegers(true);
      ok(perStatement.get().n === 9007199254741093n, "safeIntegers can be varied per statement");
      loose.close(); safe.close();
    }

    // Named + strict binding against the real binder.
    {
      const loose = new Database(":memory:");
      ok(loose.query("SELECT $m AS m").get({ $m: "hi" }).m === "hi", "non-strict binds with the $ prefix");
      ok(loose.query("SELECT :a AS a").get({ ":a": 5 }).a === 5, "the : sigil");
      ok(loose.query("SELECT @b AS b").get({ "@b": 6 }).b === 6, "the @ sigil");
      // Bun's own typo example: non-strict does NOT throw, the parameter is just NULL.
      ok(loose.query("SELECT $message AS m").get({ messag: "typo" }).m === null,
        "non-strict leaves a mis-typed parameter unbound (NULL), exactly as Bun documents");
      const strict = new Database(":memory:", { strict: true });
      ok(strict.query("SELECT $message AS m").get({ message: "hi" }).m === "hi",
        "strict binds without the prefix");
      let threw = null;
      try { strict.query("SELECT $message AS m").get({ messag: "typo" }); } catch (e) { threw = e; }
      ok(threw && /Missing parameter/.test(threw.message), "…and throws on the same typo");
      loose.close(); strict.close();
    }

    // Nested transactions. The failure this guards is an inner rollback silently
    // discarding the outer transaction's committed work.
    {
      const db = new Database(":memory:");
      db.run("CREATE TABLE t(v TEXT)");
      const inner = db.transaction((v) => {
        db.run("INSERT INTO t VALUES(?)", v);
        throw new Error("inner failed");
      });
      const outer = db.transaction((v) => {
        db.run("INSERT INTO t VALUES(?)", v);
        try { inner("inner"); } catch { /* handled; the outer transaction continues */ }
      });
      outer("outer");
      const rows = db.query("SELECT v FROM t").values().flat();
      ok(JSON.stringify(rows) === '["outer"]',
        `an inner rollback discards only the inner work (got ${JSON.stringify(rows)})`);
      ok(db.inTransaction === false, "inTransaction is false outside");
      ok(db.transaction(() => db.inTransaction)() === true, "inTransaction is true inside");
      ok(db.transaction((a, b) => a + b)(2, 3) === 5, "arguments and the return value pass through");
      let threw = null;
      try { db.transaction(() => { throw new Error("boom"); })(); } catch (e) { threw = e; }
      ok(threw && threw.message === "boom", "the original exception propagates, not a rollback error");
      ok(db.inTransaction === false, "…and the transaction is rolled back, not left open");
      threw = null;
      try { db.transaction(async () => 1)(); } catch (e) { threw = e; }
      ok(threw instanceof TypeError && /async/.test(threw.message),
        "an async transaction function throws rather than committing before it settles");
      ok(db.inTransaction === false, "…and leaves no dangling transaction");
      const t = db.transaction((v) => db.run("INSERT INTO t VALUES(?)", v));
      t.deferred("d"); t.immediate("i"); t.exclusive("e");
      ok(db.query("SELECT count(*) AS c FROM t").get().c === 4, "all three variants commit");
      ok(db.transaction(() => 1)() === 1 && db.transaction(() => 2)() === 2,
        "a transaction function is re-runnable");
      db.close();
    }

    // SQLiteError carries SQLite's own codes.
    {
      const db = new Database(":memory:");
      db.run("CREATE TABLE u(x INTEGER UNIQUE, y INTEGER NOT NULL)");
      db.run("INSERT INTO u VALUES(1,1)");
      let e = null;
      try { db.run("INSERT INTO u VALUES(1,1)"); } catch (err) { e = err; }
      ok(e instanceof SQLiteError, "a constraint violation throws SQLiteError");
      ok(e.name === "SQLiteError", "…with name SQLiteError");
      ok(e.errno === 2067, `…errno is the EXTENDED code 2067 (got ${e && e.errno})`);
      ok(e.code === "SQLITE_CONSTRAINT_UNIQUE", `…code is SQLITE_CONSTRAINT_UNIQUE (got ${e && e.code})`);
      let e2 = null;
      try { db.run("INSERT INTO u(x) VALUES(2)"); } catch (err) { e2 = err; }
      ok(e2 && e2.code === "SQLITE_CONSTRAINT_NOTNULL", "a NOT NULL violation reports SQLITE_CONSTRAINT_NOTNULL");
      let e3 = null;
      try { db.query("SELECT * FROM does_not_exist"); } catch (err) { e3 = err; }
      ok(e3 && /no such table/.test(e3.message), "SQLite's own message is preserved");
      ok(e3 && typeof e3.byteOffset === "number", "byteOffset is present (sqlite3_error_offset)");
      db.close();
    }

    // iterate / as / dispose.
    {
      const db = new Database(":memory:");
      db.run("CREATE TABLE m(title TEXT, year INTEGER)");
      db.run("INSERT INTO m VALUES('Iron Man',2008),('The Avengers',2012),('Ant-Man',2023)");
      const titles = [];
      for (const row of db.query("SELECT * FROM m")) titles.push(row.title);
      ok(titles.length === 3, "@@iterator walks every row");
      const it = db.query("SELECT * FROM m").iterate();
      const one = it.next();
      ok(one.value.title === "Iron Man" && one.done === false, "iterate() yields lazily");
      it.return();
      class Movie {
        get label() { return `${this.title} (${this.year})`; }
      }
      const first = db.query("SELECT * FROM m").as(Movie).get();
      ok(first instanceof Movie, ".as(Class) produces instances of the class");
      ok(first.label === "Iron Man (2008)", "…and the class's getters see the row's columns");
      const all = db.query("SELECT * FROM m").as(Movie).all();
      ok(all.length === 3 && all.every((m) => m instanceof Movie), ".as(Class) applies to .all() too");
      db.close();
    }

    // .exec() applies a whole multi-statement script. The previous shim collapsed
    // exec() to prepare(sql).run(), which silently dropped everything after the first
    // semicolon — the shape of every ORM's migration step.
    {
      const db = new Database(":memory:");
      db.exec(`
        CREATE TABLE a(x INTEGER);
        CREATE TABLE b(y TEXT);
        INSERT INTO a VALUES(1),(2);
        -- a trailing comment, and trailing whitespace
      `);
      ok(db.query("SELECT count(*) AS c FROM sqlite_master WHERE type='table'").get().c === 2,
        "exec() creates BOTH tables, not just the first");
      ok(db.query("SELECT count(*) AS c FROM a").get().c === 2, "…and runs the insert after them");
      // sqlite3_changes is sticky — it reports the last INSERT/UPDATE/DELETE, not the
      // statement just run. That is SQLite's documented behaviour and Bun inherits it,
      // so a SELECT through run() must NOT reset it to 0.
      ok(db.run("SELECT 1").changes === 2, "run() over a SELECT leaves sqlite3_changes at the last write's count");
      db.close();
    }

    // A real file: the whole point. Bytes on disk, a valid SQLite header, and a
    // relative path resolved against the process CWD rather than "/".
    {
      const db = new Database("./app.db");
      ok(nodeFs.existsSync(nodePath.join(DIR, "app.db")),
        "a relative filename resolves against the process cwd, not the filesystem root");
      db.run("CREATE TABLE k(v TEXT)");
      db.run("INSERT INTO k VALUES('persisted')");
      db.close();
      const header = nodeFs.readFileSync(nodePath.join(DIR, "app.db")).subarray(0, 16);
      // SQLite's documented file header: "SQLite format 3\0".
      ok(header.toString("latin1") === "SQLite format 3\0", "the file starts with SQLite's documented 16-byte header");
      const again = new Database(nodePath.join(DIR, "app.db"));
      ok(again.query("SELECT v FROM k").get().v === "persisted", "a fresh connection reads back the committed row");
      again.close();
      let threw = null;
      try { new Database(nodePath.join(DIR, "nope.db"), { readonly: true }); } catch (e) { threw = e; }
      ok(threw instanceof SQLiteError, "opening a missing file readonly throws SQLiteError");
      // A rollback journal must not be left behind after a clean commit.
      ok(!nodeFs.existsSync(nodePath.join(DIR, "app.db-journal")), "no journal file is left behind after commit");
    }

    // serialize / deserialize — also the migration path for anyone on sql.js today.
    {
      const src = new Database(":memory:");
      src.run("CREATE TABLE s(v TEXT)");
      src.run("INSERT INTO s VALUES('round trip')");
      const bytes = src.serialize();
      ok(bytes.length >= 4096, `serialize() returns the database image (${bytes.length} bytes)`);
      ok(Buffer.from(bytes.subarray(0, 15)).toString("latin1") === "SQLite format 3",
        "…and the image carries SQLite's header");
      const copy = Database.deserialize(bytes);
      ok(copy.query("SELECT v FROM s").get().v === "round trip", "deserialize() restores the rows");
      copy.run("INSERT INTO s VALUES('and writable')");
      ok(copy.query("SELECT count(*) AS c FROM s").get().c === 2, "…into a writable (RESIZEABLE) database");
      src.close(); copy.close();
    }

    // The loud refusals. Each must throw, name the API, and say why.
    {
      const db = new Database(":memory:");
      ok(typeof db.loadExtension === "function", "loadExtension exists on the prototype (a feature check must not crash)");
      ok(typeof db.fileControl === "function", "fileControl exists on the prototype");
      for (const [name, call] of [
        ["loadExtension", () => db.loadExtension("myext")],
        ["fileControl", () => db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0)],
        ["setCustomSQLite", () => Database.setCustomSQLite("/path/to/libsqlite.dylib")],
      ]) {
        let threw = null;
        try { call(); } catch (e) { threw = e; }
        ok(threw && threw.message.includes("not supported in Vivari"), `${name}() throws`);
        ok(threw && threw.message.includes(name), `…and the message names ${name}()`);
      }
      ok(constants.SQLITE_FCNTL_PERSIST_WAL === 10, "constants.SQLITE_FCNTL_PERSIST_WAL is SQLite's value 10");
      ok(constants.SQLITE_OPEN_READONLY === 1 && constants.SQLITE_OPEN_CREATE === 4,
        "the open-flag constants match sqlite3.h");
      db.close();
    }

    // WAL. SQLite's documented behaviour on a VFS with no xShmMap is to leave the mode
    // alone and report the one in effect — silently. We keep the silence broken.
    {
      const db = new Database("./wal.db");
      const warnings = [];
      const realWarn = console.warn;
      console.warn = (m) => warnings.push(String(m));
      db.run("PRAGMA journal_mode = WAL;");
      db.run("PRAGMA journal_mode = WAL;");
      console.warn = realWarn;
      ok(warnings.length === 1, `the WAL warning fires exactly once per process (got ${warnings.length})`);
      ok(warnings[0] && /xShmMap/.test(warnings[0]), "…and names the missing VFS capability");
      ok(db.query("PRAGMA journal_mode").get().journal_mode === "delete",
        "…and the mode really is 'delete', which is what SQLite reports");
      db.close();
    }

    // Heap growth. emscripten_resize_heap detaches memory.buffer; a cached view over the
    // old one reads freed memory. 9 MB is comfortably past the 8 MB initial heap.
    {
      const db = new Database("./big.db");
      db.run("CREATE TABLE big(b BLOB)");
      const payload = nodeCrypto.randomFillSync(new Uint8Array(9 * 1024 * 1024));
      db.run("INSERT INTO big VALUES(?)", payload);
      const back = db.query("SELECT b FROM big").get().b;
      ok(back.length === payload.length, `a 9 MB blob round-trips (${back.length} bytes)`);
      ok(Buffer.compare(Buffer.from(back), Buffer.from(payload)) === 0,
        "…byte for byte, so the heap grew without invalidating a cached view");
      ok(db.query("SELECT length(b) AS n FROM big").get().n === payload.length,
        "…and SQLite agrees about its length");
      db.close();
    }

    // Lifecycle.
    {
      const db = new Database(":memory:");
      const q = db.query("SELECT 1 AS v");
      q.all();
      let threw = null;
      try { db.close(true); } catch (e) { threw = e; }
      ok(threw && /unfinalized/.test(threw.message), "close(true) refuses while a statement is live");
      q.finalize();
      ok(true, "finalize() succeeds");
      threw = null;
      try { q.all(); } catch (e) { threw = e; }
      ok(threw && /finalized/.test(threw.message), "a finalized statement refuses to run again");
      db.close(true);
      threw = null;
      try { db.query("SELECT 1"); } catch (e) { threw = e; }
      ok(threw && /closed/.test(threw.message), "a closed database refuses new queries");
      db.close();
      ok(true, "close() is idempotent");
    }

    nodeFs.rmSync(DIR, { recursive: true, force: true });
  }

  // The module really is registered under `bun:sqlite` in the Bun runtime, with the
  // members Bun exports beside Database.
  {
    const rt = createBunRuntime({ process, Buffer, require: nodeRequire });
    const mod = rt.modules["bun:sqlite"];
    ok(!!mod, "bun:sqlite is registered as a bun:* module");
    ok(typeof mod.Database === "function", "…exporting Database");
    ok(mod.default === mod.Database, "…with Database as the default export");
    ok(typeof mod.Statement === "function", "…plus Statement");
    ok(typeof mod.SQLiteError === "function", "…plus SQLiteError");
    ok(typeof mod.constants === "object", "…plus constants");
    ok(mod.__engineInfo() === null, "no engine is loaded until a Database is constructed (lazy)");
  }
}

// ---------------------------------------------------------------------------
// Phase 6 — the surface a browser cannot provide, failing loudly and usefully.
//
// Every check below asserts the SAME three-part contract, because any one of them
// alone is worthless:
//   1. reading the symbol does NOT throw (a load-time throw is the failure this
//      pattern exists to avoid — one unused import in a dependency would take the
//      whole project down, and a regression to it would otherwise be silent);
//   2. CALLING it DOES throw;
//   3. the message names the API and the reason, and says "not supported in
//      Vivari (browser sandbox)" for what can never work versus "not implemented
//      in the Vivari shim" for what merely is not written yet.
// That last split is the one a reader acts on, so it is asserted per API rather
// than spot-checked.
console.log("== infeasible surface: import-safe, call-loud ==");
{
  const Bun = freshBun();
  const msg = (fn) => { try { fn(); return ""; } catch (e) { return String((e && e.message) || e); } };
  const SANDBOX = "is not supported in Vivari (browser sandbox):";
  const SHIM = "is not implemented in the Vivari shim:";

  // [property path, how to call it, expected tier, a phrase from the reason that
  // proves the message is the SPECIFIC one and not a generic "unavailable"]
  const CASES = [
    ["udpSocket", () => Bun.udpSocket({}), SANDBOX, "no UDP in a browser"],
    ["RedisClient", () => new Bun.RedisClient("redis://x"), SANDBOX, "RESP3"],
    ["redis.get", () => Bun.redis.get("k"), SANDBOX, "RESP3"],
    ["redis.publish", () => Bun.redis.publish("t", "m"), SANDBOX, "RESP3"],
    ["WebView", () => new Bun.WebView(), SANDBOX, "Chrome DevTools Protocol"],
    ["mmap", () => Bun.mmap("/tmp/x"), SANDBOX, "mmap(2)"],
    ["peek", () => Bun.peek(Promise.resolve(1)), SANDBOX, "engine's internal"],
    ["peek.status", () => Bun.peek.status(Promise.resolve(1)), SANDBOX, "engine's internal"],
    ["secrets.get", () => Bun.secrets.get({ service: "s", name: "n" }), SANDBOX, "keychain"],
    ["secrets.set", () => Bun.secrets.set({ service: "s", name: "n", value: "v" }), SANDBOX, "keychain"],
    ["secrets.delete", () => Bun.secrets.delete({ service: "s", name: "n" }), SANDBOX, "keychain"],
    ["dlopen", () => Bun.dlopen("libc.so", {}), SANDBOX, "dlopen(3)"],
    // The two NOT-IMPLEMENTED members: possible here, just unwritten. Different
    // words, deliberately.
    ["spawn({terminal:true})", () => Bun.spawn({ cmd: ["ls"], terminal: true }), SHIM, "pty"],
    ["spawnSync({terminal:true})", () => Bun.spawnSync({ cmd: ["ls"], terminal: true }), SHIM, "pty"],
  ];

  for (const [name, call, tier, phrase] of CASES) {
    // (1) import-safe: every step of the property path must READ as a real value
    // without throwing. `Bun.redis.get` has to be a function you can hold before
    // you call it, the same way `import { dlopen } from "bun:ffi"` has to bind.
    let read = Bun, readThrew = false;
    try {
      for (const key of name.replace(/\(.*$/, "").split(".")) read = read[key];
    } catch { readThrew = true; }
    ok(!readThrew && typeof read === "function", "Bun." + name + " can be READ without throwing (import-safe)");
    // (2) + (3) call-loud, with the right tier and a specific reason.
    const m = msg(call);
    ok(m !== "", "Bun." + name + " throws when called");
    ok(m.indexOf(tier) !== -1, "…as " + (tier === SANDBOX ? "impossible in a browser" : "not implemented yet"));
    ok(m.indexOf(phrase) !== -1, "…and the message says why: " + JSON.stringify(phrase));
    // The API has to appear in its own message, or a stack trace from inside a
    // dependency still leaves you guessing which call it was.
    ok(/^Bun\.(spawn|spawnSync|udpSocket|redis|secrets|peek|mmap|dlopen|SQL|sql)|^new Bun\./.test(m), "…and names the API it came from");
  }

  // Bun.listen/Bun.connect are NOT on that list any more, and the shape of what
  // they refuse is the reason to check them separately: the API works, the
  // DESTINATION is what the sandbox forbids. A blanket refusal reinstated by
  // accident would sail past a test that only asks "does it throw".
  {
    const outside = msg(() => Bun.listen({ hostname: "example.com", port: 1, socket: {} }));
    ok(outside.indexOf("cannot bind") !== -1, "Bun.listen refuses a non-loopback bind");
    ok(outside.indexOf("Bind localhost/127.0.0.1") !== -1, "…and says what does work instead");
    const tls = msg(() => Bun.listen({ port: 1, tls: {}, socket: {} }));
    ok(tls.indexOf(SHIM) !== -1 && tls.indexOf("nothing to negotiate") !== -1, "Bun.listen({ tls }) refuses, with the reason");
    // connect() is a promise in Bun, so its refusal is a rejection rather than a
    // throw — asserting it as a throw is how this would silently pass.
    let sync = "";
    let rejected = "";
    try {
      const p = Bun.connect({ hostname: "example.com", port: 1, socket: {} });
      rejected = await p.then(() => "", (e) => String((e && e.message) || e));
    } catch (e) {
      sync = String((e && e.message) || e);
    }
    ok(sync === "", "Bun.connect does not throw synchronously — it returns a promise, as in Bun");
    ok(rejected.indexOf("cannot reach") !== -1, "…and rejects for an outside host");
    ok(rejected.indexOf("loopback") !== -1, "…naming the one network there is");
  }

  // The two tiers must never blur into each other: a "cannot ever" message that
  // also says "not implemented" would send someone off to write a patch for
  // something no patch can fix.
  ok(msg(() => Bun.udpSocket({})).indexOf(SHIM) === -1, "an impossible API never says 'not implemented' too");
  ok(msg(() => Bun.spawn({ cmd: ["ls"], terminal: true })).indexOf(SANDBOX) === -1, "a not-implemented API never claims the sandbox forbids it");

  // Bun.spawn without `terminal` must be untouched by that guard.
  ok(msg(() => Bun.spawn({ cmd: ["true"] })).indexOf("pty") === -1, "Bun.spawn without `terminal` is not affected");

  // Bun.SQL picks its message from the adapter: Postgres and MySQL can never
  // work, SQLite can and simply is not this module's job. One blanket sentence
  // would give the SQLite user the wrong next step.
  const pg = msg(() => new Bun.SQL("postgres://u@h/db"));
  ok(pg.indexOf(SANDBOX) !== -1 && /PostgreSQL wire protocol/.test(pg), "Bun.SQL(postgres://…) names the Postgres wire protocol as the blocker");
  ok(/bun:sqlite/.test(pg) && /pglite/.test(pg), "…and points at bun:sqlite plus the wasm Postgres that does run in-VM");
  const my = msg(() => new Bun.SQL("mysql://u@h/db"));
  ok(my.indexOf(SANDBOX) !== -1 && /MySQL wire protocol/.test(my), "Bun.SQL(mysql://…) names the MySQL wire protocol");
  ok(!/pglite/.test(my), "…and does NOT recommend a Postgres engine for a MySQL URL");
  const lite = msg(() => new Bun.SQL("sqlite://app.db"));
  ok(lite.indexOf(SHIM) !== -1 && /bun:sqlite/.test(lite), "Bun.SQL(sqlite://…) is not-implemented (SQLite is possible here) and points at bun:sqlite");
  ok(msg(() => new Bun.SQL()).indexOf(SANDBOX) !== -1, "Bun.SQL() with no argument still fails loudly rather than returning a client");
  ok(msg(() => Bun.sql`select 1`).indexOf(SANDBOX) !== -1, "Bun.sql`…` (the default tagged-template client) throws on use");
  ok(msg(() => Bun.sql.begin(() => {})).indexOf(SANDBOX) !== -1, "Bun.sql.begin() throws too");
}

console.log("== bun:ffi is complete (and import-safe) ==");
{
  const proc = { env: {}, argv: ["bun"], cwd: () => "/", stdout: process.stdout, stderr: process.stderr, stdin: process.stdin };
  const { modules } = createBunRuntime({ process: proc, Buffer, require: nodeRequire });
  const ffi = modules["bun:ffi"];
  const msg = (fn) => { try { fn(); return ""; } catch (e) { return String((e && e.message) || e); } };

  // CFunction, linkSymbols and JSCallback were absent entirely: `import
  // { JSCallback } from "bun:ffi"` bound undefined, and the failure was "not a
  // constructor" at some later line, which says nothing about FFI or the sandbox.
  for (const name of ["dlopen", "CFunction", "linkSymbols", "JSCallback", "CString", "ptr", "toArrayBuffer", "cc", "read", "FFIType", "suffix"]) {
    ok(ffi[name] !== undefined, "bun:ffi exports " + name + " (so importing it cannot crash at load)");
  }
  for (const [name, call] of [
    ["dlopen", () => ffi.dlopen("libc.so", {})],
    ["CFunction", () => ffi.CFunction({ ptr: 1 })],
    ["linkSymbols", () => ffi.linkSymbols({})],
    ["ptr", () => ffi.ptr(new Uint8Array(1))],
    ["toArrayBuffer", () => ffi.toArrayBuffer(1)],
    ["cc", () => ffi.cc({ source: "int x(){return 1;}" })],
    ["read.u8", () => ffi.read.u8(1)],
    ["JSCallback", () => new ffi.JSCallback(() => {})],
    // Regression: CString was an empty class, so `new CString(ptr)` SUCCEEDED and
    // handed back an object with no string in it — a silent wrong answer of
    // exactly the kind this tier exists to remove.
    ["CString", () => new ffi.CString(1)],
  ]) {
    const m = msg(call);
    ok(m.indexOf("is not supported in Vivari (browser sandbox):") !== -1, "bun:ffi " + name + " throws the sandbox message on use");
    ok(/dlopen\(3\)|raw memory addresses/.test(m), "…naming dlopen(3) or the pointer problem, not just 'unavailable'");
  }
  ok(typeof ffi.suffix === "string" && typeof ffi.FFIType === "object", "FFIType/suffix stay plain data — code reads them while building a call that then throws at dlopen");
}

console.log("== native .node addons: the message, and the loader that produces it ==");
{
  const msgOf = (fn) => { try { fn(); return ""; } catch (e) { return String((e && e.message) || e); } };

  // The package a `.node` belongs to, which is what the substitution map is keyed
  // on. The binary almost never sits at the top of the package (bcrypt's is at
  // lib/binding/napi-v3/…), and a nested copy must be attributed to the INNER
  // package or the advice is about the wrong library.
  ok(packageNameFromPath("/app/node_modules/bcrypt/lib/binding/napi-v3/bcrypt_lib.node") === "bcrypt", "package name from a deep binding path");
  ok(packageNameFromPath("/app/node_modules/a/node_modules/sharp/build/Release/sharp.node") === "sharp", "a nested copy is attributed to the inner package");
  ok(packageNameFromPath("/app/node_modules/@next/swc-linux-x64-gnu/next-swc.node") === "@next/swc-linux-x64-gnu", "a scoped package keeps its scope");
  ok(packageNameFromPath("/app/build/Release/addon.node") === "", "a project-local addon has no package name");

  const bcrypt = nativeAddonMessage("/app/node_modules/bcrypt/lib/binding/napi-v3/bcrypt_lib.node");
  ok(/compiled machine code/.test(bcrypt) && /dlopen\(3\)/.test(bcrypt), "the addon message says what a .node file is and why it cannot load");
  ok(/`bcrypt` has a substitute that works here: `bcryptjs`/.test(bcrypt), "…and names the verified substitute for the package");
  ok(/installs it in place of bcrypt automatically/.test(bcrypt), "…including that Vivari normally aliases it at install time");

  // An honest "we do not know" is information too, and is the reason the map is
  // allowed to be short: a wrong recommendation costs more than a missing one.
  const sharp = nativeAddonMessage("/app/node_modules/sharp/build/Release/sharp.node");
  ok(/no substitute is verified in Vivari/.test(sharp), "a package with no verified substitute says so rather than guessing");
  ok(!/sharp-wasm|jimp|@napi-rs/.test(sharp), "…and does not invent one");

  const swc = nativeAddonMessage("/app/node_modules/@next/swc-linux-x64-gnu/next-swc.node");
  ok(/@next\/swc-wasm-nodejs/.test(swc), "a per-platform package is matched by prefix (@next/swc-* -> the wasm build)");
  const unknown = nativeAddonMessage("/app/node_modules/some-random-addon/x.node");
  ok(/no verified substitute for `some-random-addon`/.test(unknown) && /-wasm/.test(unknown), "an unknown package gets the generic 'look for a wasm build' advice");
  ok(nativeAddonError("/x/y.node").code === "ERR_DLOPEN_FAILED", "the error carries Node's ERR_DLOPEN_FAILED, so packages that branch on it take their pure-JS fallback");

  // And now the loader itself, with no kernel: createModuleSystem over host Node's
  // fs. This is the check that matters, because the message is only worth having
  // if require() actually produces it. Before this change the .node handler on
  // Module._extensions was never consulted — load() calls compile() directly — so
  // the binary was read as UTF-8 and the user got `SyntaxError: Invalid or
  // unexpected token` naming a file that was never source.
  const os = nodeRequire("node:os");
  const fsMod = nodeRequire("node:fs");
  const pathMod = nodeRequire("node:path");
  const dir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), "vv-addon-"));
  try {
    fsMod.mkdirSync(pathMod.join(dir, "node_modules/bcrypt/lib"), { recursive: true });
    fsMod.writeFileSync(pathMod.join(dir, "node_modules/bcrypt/package.json"), JSON.stringify({ name: "bcrypt", main: "bcrypt.js" }));
    fsMod.writeFileSync(pathMod.join(dir, "node_modules/bcrypt/bcrypt.js"), "module.exports = require('./lib/bcrypt_lib.node');\n");
    // Real ELF magic plus NUL bytes — the thing that used to be parsed as text.
    fsMod.writeFileSync(pathMod.join(dir, "node_modules/bcrypt/lib/bcrypt_lib.node"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0]));
    fsMod.writeFileSync(pathMod.join(dir, "plain.js"), "module.exports = 42;\n");

    const sys = createModuleSystem({
      fs: fsMod,
      path: pathMod,
      builtins: {},
      process,
      nodeModules: { has: () => false, require: () => ({}), internalBinding: () => ({}) },
    });
    const req = sys.makeRequire(dir);
    ok(req("./plain.js") === 42, "the module system under test still loads ordinary JavaScript");

    const direct = msgOf(() => req("./node_modules/bcrypt/lib/bcrypt_lib.node"));
    ok(/Cannot load the native addon/.test(direct), "require() of a .node file gives the addon message");
    ok(!/SyntaxError|Invalid or unexpected token/.test(direct), "…and NOT a SyntaxError about a binary file read as UTF-8 (the bug this replaces)");

    // The transitive path is the one real projects hit: nobody requires a .node
    // directly, their dependency does.
    const transitive = msgOf(() => req("bcrypt"));
    ok(/Cannot load the native addon/.test(transitive) && /bcryptjs/.test(transitive), "require('bcrypt') fails through its own JS entry with the substitute named");

    // Registered on the extension table too, pointing at the same compiler, for
    // tools that read or call require.extensions rather than going through load().
    ok(typeof sys.Module._extensions[".node"] === "function", "Module._extensions['.node'] is registered (rechoir and friends read these keys)");
    const viaExt = msgOf(() => sys.Module._extensions[".node"]({ exports: {} }, pathMod.join(dir, "node_modules/bcrypt/lib/bcrypt_lib.node")));
    ok(/Cannot load the native addon/.test(viaExt), "…and calling it directly gives the identical message");

    // Deliberately NOT resolvable by extension: a package that probes with
    // require.resolve('./build/foo') before falling back to pure JS must keep
    // getting "not found", or it takes the native branch and fails.
    let resolved = "";
    try { resolved = sys.resolveFilename("./node_modules/bcrypt/lib/bcrypt_lib", dir).id; } catch (e) { resolved = "MODULE_NOT_FOUND"; }
    ok(resolved === "MODULE_NOT_FOUND", ".node is NOT in the resolver's extension list, so an extensionless probe still finds nothing");
  } finally {
    fsMod.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("== bun build --compile fails loudly (BUN_PROGRAM as a real process) ==");
{
  const os = nodeRequire("node:os");
  const fsMod = nodeRequire("node:fs");
  const pathMod = nodeRequire("node:path");
  const { spawnSync } = nodeRequire("node:child_process");
  const dir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), "vv-bun-compile-"));
  try {
    const binBun = pathMod.join(dir, "bun-shim.js");
    fsMod.writeFileSync(binBun, BUN_PROGRAM);
    fsMod.writeFileSync(pathMod.join(dir, "app.ts"), "const x: number = 1; console.log(x);\n");
    const bun = (...args) => {
      const r = spawnSync(process.execPath, [binBun, ...args], { cwd: dir, encoding: "utf8" });
      return { code: r.status, text: (r.stdout || "") + (r.stderr || "") };
    };
    // Regression: --compile used to fall through to the transpile path and write
    // JAVASCRIPT to the path the user expected an executable at, then report
    // success. A build that "worked" and produced the wrong kind of file is the
    // worst outcome available.
    const compiled = bun("build", "app.ts", "--compile", "--outfile=app");
    ok(compiled.code === 1, "bun build --compile exits non-zero");
    ok(/--compile is not supported in Vivari \(browser sandbox\)/.test(compiled.text), "…with the sandbox message");
    ok(/native/i.test(compiled.text) && /--outfile/.test(compiled.text), "…naming what --compile emits and what to use instead");
    ok(!fsMod.existsSync(pathMod.join(dir, "app")), "…and writes no file at all (it used to write JS under the executable's name)");
    // The guard must fire for --compile and for nothing else. Off Vivari there is
    // no Bun global (installBun() is a guarded no-op), so a plain build cannot
    // finish in this harness — but it must get PAST the guard and fail on the
    // missing global instead, which is exactly what proves the guard is scoped.
    // The real in-VM build is exercised by scripts/spike-bun.mjs.
    const plain = bun("build", "app.ts", "--outfile=out.js");
    ok(!/--compile is not supported/.test(plain.text), "a build without --compile does not hit the guard");
    ok(/Bun is not defined/.test(plain.text), "…it reaches Bun.build (which needs the Bun global this harness has no kernel to install)");
  } finally {
    fsMod.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Phase 5B — Bun.build (a real dependency graph) and Bun.plugin.
//
// What this tier can prove and the kernel tier cannot: the OPTION POLICY (every
// option this bundler will not honour throws, naming itself), the tokenizer that
// finds dependencies and applies `define`, and the codegen for all three output
// formats. What it deliberately does NOT prove is that the graph walk survives
// the real VFS across the syscall bridge — that is scripts/spike-bun.mjs, and it
// is where the load-bearing "the bundle actually runs and computes the right
// answer" proof lives, because a bundler is exactly the kind of subsystem that
// passes over host Node's fs and then trips on the real one.
//
// The resolver is NOT stubbed here. `createModuleSystem` (the shipped loader) is
// driven over host Node's fs and its resolveFilename is what walks the graph —
// the same seam packages/runtime/index.js hands to createBunRuntime. A bundler
// tested against a toy resolver would prove nothing about which file ends up in
// the bundle, which is the only question that matters.
console.log("== Bun.build: the option policy (nothing is silently ignored) ==");
{
  const pathMod = nodeRequire("node:path");
  const norm = (opts) => normalizeBuildOptions({ entrypoints: ["./a.ts"], ...opts }, { path: pathMod, cwd: "/proj" });
  const threw = (opts) => { try { norm(opts); return ""; } catch (e) { return String((e && e.message) || e); } };

  // The four that are real compiler work, and the one that is impossible. Each
  // must name ITSELF in the message: "Bun.build failed" tells an author nothing
  // about which of their options was the problem.
  const REJECTED = [
    ["minify", { minify: true }, "no minifier"],
    ["minify (partial)", { minify: { whitespace: true } }, "no minifier"],
    ["splitting", { splitting: true }, "one file per entry point"],
    ["sourcemap", { sourcemap: "linked" }, "no position mappings"],
    ["sourcemap:true", { sourcemap: true }, "no position mappings"],
    ["bytecode", { bytecode: true }, "JavaScriptCore"],
    ["compile", { compile: true }, "NATIVE executable"],
    ["publicPath", { publicPath: "/s/" }, "no asset pipeline"],
    ["loader", { loader: { ".css": "text" } }, "loader plugins"],
    ["drop", { drop: ["console"] }, "does not reprint the AST"],
    ["conditions", { conditions: ["custom"] }, "fixed condition set"],
    ["packages", { packages: "external" }, "list the packages in `external`"],
    ["env", { env: "inline" }, "define-generation pass"],
    ["naming.chunk", { naming: { chunk: "[name].js" } }, "emits no chunks"],
    ["naming.asset", { naming: { asset: "[name].js" } }, "emits no assets"],
  ];
  for (const [name, opts, phrase] of REJECTED) {
    const m = threw(opts);
    ok(m.includes("Bun.build({"), `${name} throws a Bun.build-shaped message`);
    ok(m.includes(phrase), `…naming the specific reason (${JSON.stringify(phrase)}) rather than "unsupported"`);
  }
  // `sourcemap: "none"` / false are the DEFAULT, so they must not throw — a policy
  // that rejects the value meaning "I don't want one" would be a bug of its own.
  ok(threw({ sourcemap: "none" }) === "" && threw({ sourcemap: false }) === "" && threw({ minify: false }) === "", "the falsy/none forms of the rejected options are accepted (they ask for nothing)");

  // Validation that catches a typo before anything is written.
  ok(/must be one of browser, bun, node/.test(threw({ target: "deno" })), "an unknown target is rejected, listing the ones that exist");
  ok(/must be one of esm, cjs, iife/.test(threw({ format: "umd" })), "an unknown format is rejected the same way");
  ok(/non-empty array/.test((() => { try { normalizeBuildOptions({}, { path: pathMod, cwd: "/" }); return ""; } catch (e) { return e.message; } })()), "entrypoints is required");
  ok(/strings of SOURCE TEXT/.test(threw({ define: { A: 1 } })), "a non-string define value is rejected — Bun's values are source text, and guessing would change the meaning");
  ok(/identifier or a dotted member path/.test(threw({ define: { "a b": "1" } })), "a define key the tokenizer cannot match is rejected rather than silently never firing");

  // The defaults, which are Bun's.
  const { config } = norm({});
  ok(config.target === "browser" && config.format === "esm", "defaults: target browser, format esm (Bun's)");
  ok(config.entryNaming === "[dir]/[name].[ext]", "…and Bun's default entry naming");
  ok(config.root === "/proj", "…with `root` defaulting to the entry points' common directory");
  ok(config.throw === false, `…and \`throw\` defaulting to false, which is Bun ${BUN_VERSION}'s behaviour (later versions flipped it)`);
  // iife DEGRADES loudly rather than silently dropping the exports.
  const iife = norm({ format: "iife" });
  ok(iife.warnings.some((w) => w.key === "format" && /not exposed anywhere/.test(w.message)), "format:'iife' warns that the entry's exports go nowhere");
}

console.log("== Bun.build: naming templates and `external` matching ==");
{
  ok(applyNaming("[dir]/[name].[ext]", { dir: "", name: "index", ext: "js" }) === "index.js", "[dir] of the root collapses away instead of emitting ./index.js");
  ok(applyNaming("[dir]/[name].[ext]", { dir: "pages", name: "a", ext: "js" }) === "pages/a.js", "[dir] is the entry's path under `root`");
  ok(applyNaming("[name]-[hash].[ext]", { name: "a", ext: "js", hash: "deadbeef" }) === "a-deadbeef.js", "[hash] expands");
  ok(isExternalSpec("react", ["react"]), "external matches exactly");
  ok(isExternalSpec("react/jsx-runtime", ["react"]), "…and covers a subpath of the same package, which is how Bun reads it");
  ok(!isExternalSpec("react-dom", ["react"]), "…but not a different package that merely starts with the same letters");
  ok(isExternalSpec("anything", ["*"]), "`*` externalises everything");
  ok(isExternalSpec("@scope/a", ["@scope/*"]), "a glob is honoured");
}

console.log("== Bun.build: the dependency tokenizer (no phantoms, no desync) ==");
{
  // A phantom dependency is the dangerous direction: it fails to resolve and takes
  // a working build down. So a require inside a string or a comment must be
  // invisible, and a regex literal must not desync the scanner (a naive one reads
  // /["']/ as an unterminated string and then misses everything after it).
  const src = [
    'const a = require("./real");',
    'const s = "require(\'./in-a-string\')";',
    '// require("./in-a-comment")',
    '/* require("./in-a-block-comment") */',
    'const rx = /["\']/; const b = require("./after-a-regex");',
    'const t = `require("./in-a-template")`;',
    'const d = obj.require("./a-method-call");',
    'const dyn = __oc_import("./dynamic");',
    'const computed = require(someName);',
  ].join("\n");
  const { requires } = scanAndDefine(src, {});
  ok(requires.includes("./real"), "a plain require is found");
  ok(requires.includes("./after-a-regex"), "…and one that follows a regex literal containing a quote (the classic desync)");
  ok(requires.includes("./dynamic"), "…and a dynamic import(), which both ESM rewrites turn into __oc_import");
  ok(!requires.includes("./in-a-string"), "a require inside a string is NOT a dependency");
  ok(!requires.includes("./in-a-comment") && !requires.includes("./in-a-block-comment"), "…nor one in a comment");
  ok(!requires.includes("./in-a-template"), "…nor one in a template literal");
  ok(!requires.includes("./a-method-call"), "…nor a `.require()` method that merely shares the name");
  ok(requires.length === 3, `exactly the three real specifiers were found (got ${JSON.stringify(requires)})`);

  // `define` substitutes on the same pass, with the same boundaries.
  const defined = scanAndDefine(
    ['const x = process.env.NODE_ENV;', 'const y = "process.env.NODE_ENV";', 'const z = a.process.env.NODE_ENV;', 'const w = process.env.NODE_ENV_OTHER;'].join("\n"),
    { "process.env.NODE_ENV": '"production"' },
  ).code;
  ok(/const x = "production";/.test(defined), "define replaces the member path");
  ok(/const y = "process\.env\.NODE_ENV";/.test(defined), "…and never inside a string literal");
  ok(/const z = a\.process\.env\.NODE_ENV;/.test(defined), "…and not when it is the tail of a longer property access");
  ok(/const w = process\.env\.NODE_ENV_OTHER;/.test(defined), "…and not a longer identifier that starts with the key");
  // A define on a prefix must not eat the trailing access, which would change what
  // the expression means.
  const prefix = scanAndDefine("const v = process.env.HOME;", { "process.env": "({})" }).code;
  ok(prefix === "const v = ({}).HOME;", `a prefix define keeps the trailing member access (got ${JSON.stringify(prefix)})`);
}

// A real multi-module bundle, driven over host Node's fs with the SHIPPED
// resolver, run, and checked for the right answer.
console.log("== Bun.build: a real bundle that runs (multi-file + npm dep + JSON) ==");
{
  const os = nodeRequire("node:os");
  const fsMod = nodeRequire("node:fs");
  const pathMod = nodeRequire("node:path");
  const dir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), "vv-bun-build-"));
  const w = (rel, s) => {
    const p = pathMod.join(dir, rel);
    fsMod.mkdirSync(pathMod.dirname(p), { recursive: true });
    fsMod.writeFileSync(p, s);
  };
  // Evaluate a bundle and hand back its exports. A THROW comes back as a value
  // rather than escaping: a bundle that lost a module fails inside __vv_ext, and
  // an uncaught throw here would abort the whole spike with a stack trace instead
  // of one legible failing check.
  const run = (code, req) => {
    const m = { exports: {} };
    try {
      new Function("module", "exports", "require", code)(m, m.exports, req || (() => { throw new Error("this bundle should need no host require"); }));
    } catch (e) {
      return { __threw: String((e && e.message) || e) };
    }
    return m.exports;
  };
  try {
    w("src/index.ts", [
      'import { shout } from "./greet";',
      'import cfg from "./cfg.json";',
      'import { pad } from "leftpad";',
      "export const answer: string = pad(shout(cfg.who), 12);",
      "export default answer;",
    ].join("\n"));
    w("src/greet.ts", 'export function shout(who: string): string { return ("hi " + who).toUpperCase(); }');
    w("src/cfg.json", JSON.stringify({ who: "world" }));
    w("node_modules/leftpad/package.json", JSON.stringify({ name: "leftpad", version: "1.0.0", main: "index.js" }));
    w("node_modules/leftpad/index.js", 'exports.pad = function (s, n) { while (s.length < n) s = "." + s; return s; };');

    const sys = createModuleSystem({
      fs: fsMod,
      path: pathMod,
      // Enough of a builtin table for the target policy below to have something to
      // decide about: the bundler asks the RESOLVER whether a specifier is a
      // builtin, so a resolver with none would make "browser has no node:path"
      // untestable (it would just be an ordinary unresolved module).
      builtins: { path: pathMod, "node:path": pathMod, fs: fsMod, "node:fs": fsMod },
      process,
      nodeModules: { has: () => false, require: () => ({}), internalBinding: () => ({}) },
    });
    const proc = { env: {}, argv: ["bun"], cwd: () => dir, stdout: process.stdout, stderr: process.stderr, stdin: process.stdin };
    const Bun = createBunRuntime({
      process: proc,
      Buffer,
      require: nodeRequire,
      resolveFrom: (spec, from) => sys.resolveFilename(spec, from),
    }).Bun;

    const cjs = await Bun.build({ entrypoints: ["./src/index.ts"], target: "node", format: "cjs", root: "./src" });
    ok(cjs.success, "a three-module TS graph with an npm dependency and a JSON import bundles");
    if (!cjs.success) console.log("  logs:", cjs.logs.map(String).join("\n         "));
    // THE check: the bytes are not Bun's, so the only meaningful assertion is that
    // the output computes the right thing.
    ok(run(await cjs.outputs[0].text()).answer === "....HI WORLD", "…and the bundle RUNS, producing the answer all three modules had to agree on");
    ok(cjs.outputs.length === 1, "one entry point, one output (no splitting)");

    const art = cjs.outputs[0];
    ok(art.path === "./index.js" && art.kind === "entry-point" && art.loader === "js", "the artifact carries Bun's path/kind/loader");
    ok(/^[0-9a-f]{16}$/.test(art.hash), "…a content hash");
    ok(art.size === Buffer.byteLength(await art.text(), "utf8"), "…a size matching its bytes");
    ok(new TextDecoder().decode(new Uint8Array(await art.arrayBuffer())) === (await art.text()), "…and the Blob read protocol agrees with itself (.arrayBuffer() vs .text())");
    ok((await art.bytes()) instanceof Uint8Array, "…including .bytes()");

    // ESM output: the entry's named exports and default are re-exported, so the
    // bundle is importable rather than merely runnable.
    const esm = await Bun.build({ entrypoints: ["./src/index.ts"], target: "node", root: "./src" });
    const esmCode = await esm.outputs[0].text();
    ok(esm.success && /export \{ __vv_e_answer as answer \};/.test(esmCode), "format:'esm' re-exports the entry's named exports");
    ok(/export default __vv_entry\.default;/.test(esmCode), "…and its default");

    // A dependency graph is only a graph if a cycle terminates. The shape that
    // matters is the one real code has (yargs' command.js <-> yargs-factory.js): a
    // hoisted function reached through the cycle, which works because the bundle
    // links exports through getters exactly as the runtime's ESM rewrite does.
    w("cyc/a.ts", 'import { fromB } from "./b"; export function tag(s: string) { return "[" + s + "]"; } export const out = fromB();');
    w("cyc/b.ts", 'import { tag } from "./a"; export function fromB() { return tag("cycle"); }');
    const cyc = await Bun.build({ entrypoints: ["./cyc/a.ts"], target: "node", format: "cjs", root: "./cyc" });
    ok(cyc.success, "a circular import bundles instead of recursing forever");
    ok(run(await cyc.outputs[0].text()).out === "[cycle]", "…and a hoisted function reached across the cycle resolves through the export getters");

    // outdir writes real files, and `naming` decides where.
    const written = await Bun.build({ entrypoints: ["./src/index.ts"], target: "node", format: "cjs", root: "./src", outdir: "./dist", naming: "[name].[ext]" });
    ok(written.success && fsMod.existsSync(pathMod.join(dir, "dist/index.js")), "outdir writes the file that naming named");
    ok(written.outputs[0].path === pathMod.join(dir, "dist/index.js"), "…and the artifact reports where it went");

    // Failures are logs, not throws — Bun 1.1's contract — unless `throw: true`.
    const missing = await Bun.build({ entrypoints: ["./src/nope.ts"], target: "node" });
    ok(missing.success === false && missing.outputs.length === 0, "an unresolvable entry gives success:false with no outputs");
    ok(missing.logs.some((l) => l.level === "error" && /Could not resolve|Could not read/.test(l.message)), "…and an error log saying what could not be resolved");
    let aggregate = null;
    try { await Bun.build({ entrypoints: ["./src/nope.ts"], target: "node", throw: true }); } catch (e) { aggregate = e; }
    ok(aggregate instanceof AggregateError, "throw:true raises an AggregateError instead (Bun's opt-in)");

    // The browser target has no node builtins, and says so at build time rather
    // than emitting an import that dies in the page.
    w("src/nodeish.ts", 'import { join } from "node:path"; export const p = join("a", "b");');
    const browser = await Bun.build({ entrypoints: ["./src/nodeish.ts"], root: "./src" });
    ok(!browser.success && browser.logs.some((l) => /target "browser"/.test(l.message) && /node:path/.test(l.message)), "target:'browser' refuses a node builtin, naming the module");
    const external = await Bun.build({ entrypoints: ["./src/nodeish.ts"], root: "./src", external: ["node:path"] });
    ok(external.success && /^import \* as __vv_x0 from "node:path";/m.test(await external.outputs[0].text()), "…and listing it in `external` emits a real import instead");

    // A file the bundler has no loader for is an error, not an empty module.
    w("src/styles.css", "body { color: red }");
    w("src/withcss.ts", 'import "./styles.css"; export const ok = 1;');
    const css = await Bun.build({ entrypoints: ["./src/withcss.ts"], target: "node", root: "./src" });
    ok(!css.success && css.logs.some((l) => /No loader for/.test(l.message) && /styles\.css/.test(l.message)), "an unsupported file type is a build error naming the file, not a silently dropped import");

    // Build-time plugins: onResolve into a namespace + onLoad supplying it, and an
    // onLoad that changes how a real file on disk is read. Both async, because a
    // build may await (unlike a runtime plugin — see below).
    w("plug/entry.ts", 'import conf from "virtual:conf"; import raw from "./note.md"; export const out = conf.k + ":" + raw;');
    w("plug/note.md", "# hi");
    const plugged = await Bun.build({
      entrypoints: ["./plug/entry.ts"],
      target: "node",
      format: "cjs",
      root: "./plug",
      plugins: [
        {
          name: "vv-spike",
          setup(build) {
            build.onResolve({ filter: /^virtual:/ }, async (args) => ({ path: args.path.slice(8), namespace: "conf" }));
            build.onLoad({ filter: /.*/, namespace: "conf" }, async () => ({ contents: JSON.stringify({ k: "K" }), loader: "json" }));
            build.onLoad({ filter: /\.md$/ }, async (args) => ({ contents: "export default " + JSON.stringify(fsMod.readFileSync(args.path, "utf8")), loader: "ts" }));
          },
        },
      ],
    });
    ok(plugged.success, "a build plugin with onResolve + onLoad runs");
    if (!plugged.success) console.log("  logs:", plugged.logs.map(String).join("\n         "));
    ok(run(await plugged.outputs[0].text()).out === "K:# hi", "…and both hooks actually changed what ended up in the bundle");

    // A namespace nobody loads is a build error: a virtual module has no file, so
    // "not handled" must not fall through to an fs read of a path that never was.
    const orphan = await Bun.build({
      entrypoints: ["./plug/entry.ts"],
      target: "node",
      root: "./plug",
      plugins: [{ name: "resolve-only", setup: (b) => b.onResolve({ filter: /^virtual:/ }, (a) => ({ path: a.path, namespace: "nobody" })) }],
    });
    ok(!orphan.success && orphan.logs.some((l) => /No plugin onLoad/.test(l.message)), "a namespace with no onLoad is a build error, not a mysterious ENOENT");
    ok(/filter/.test((() => { try { new PluginHost({ sync: false }).register({ name: "x", setup: (b) => b.onLoad({ filter: "*.ts" }, () => ({})) }); return ""; } catch (e) { return e.message; } })()), "a string `filter` is rejected — Bun matches with a RegExp, and a string would just never match");

    // Runtime plugins, through the REAL loader. Bun.plugin() rewrites what
    // require() sees in this process, which is a different lifetime from the
    // build-time plugins above and shares the same hook shape.
    Bun.plugin({
      name: "vv-runtime",
      setup(build) {
        build.onResolve({ filter: /^spike:config$/ }, () => ({ path: "/config", namespace: "spike" }));
        build.onLoad({ filter: /.*/, namespace: "spike" }, () => ({ contents: JSON.stringify({ live: true }), loader: "json" }));
      },
    });
    const req = sys.makeRequire(dir);
    const tryRequire = (id) => { try { return req(id); } catch (e) { return { __threw: String((e && e.message) || e) }; } };
    ok(tryRequire("spike:config").live === true, "Bun.plugin() makes require() of a virtual specifier work in the running process");
    w("plain.js", "module.exports = 7;");
    ok(tryRequire("./plain.js") === 7, "…without disturbing ordinary resolution");
    const asyncSetup = (() => { try { Bun.plugin({ name: "async-setup", async setup() {} }); return ""; } catch (e) { return e.message; } })();
    ok(/synchronous all the way down/.test(asyncSetup) && /Bun\.build/.test(asyncSetup), "an async setup() on a RUNTIME plugin throws, pointing at Bun.build({plugins}) where awaiting is legal");
    Bun.plugin.clearAll();
    let cleared = "";
    try { req("spike:config"); } catch (e) { cleared = String(e.message); }
    ok(/Cannot find module/.test(cleared), "Bun.plugin.clearAll() really unregisters the hooks");
  } finally {
    fsMod.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("== bun build CLI: flags map onto Bun.build, unknown ones are refused ==");
{
  const os = nodeRequire("node:os");
  const fsMod = nodeRequire("node:fs");
  const pathMod = nodeRequire("node:path");
  const { spawnSync } = nodeRequire("node:child_process");
  const dir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), "vv-bun-buildcli-"));
  try {
    const binBun = pathMod.join(dir, "bun-shim.js");
    fsMod.writeFileSync(binBun, BUN_PROGRAM);
    fsMod.writeFileSync(pathMod.join(dir, "app.ts"), "export const x = 1;\n");
    const bun = (...args) => {
      const r = spawnSync(process.execPath, [binBun, ...args], { cwd: dir, encoding: "utf8" });
      return { code: r.status, text: (r.stdout || "") + (r.stderr || "") };
    };
    // There is no Bun global in this harness (no kernel to install one), so these
    // are exactly the failures the CLI can produce BEFORE it reaches Bun.build —
    // which is the half that lives in the CLI and nowhere else. The build itself
    // is proven in the VM by scripts/spike-bun.mjs.
    const unknown = bun("build", "app.ts", "--no-such-flag");
    ok(unknown.code === 1 && /unknown option --no-such-flag/.test(unknown.text), "an unknown build flag is refused");
    ok(/silently dropped an option/.test(unknown.text), "…saying why it is refused rather than ignored");
    const both = bun("build", "app.ts", "--outfile=a.js", "--outdir=out");
    ok(both.code === 1 && /mutually exclusive/.test(both.text), "--outfile and --outdir together is an error");
    const many = bun("build", "a.ts", "b.ts", "--outfile=a.js");
    ok(many.code === 1 && /single entry point/.test(many.text), "--outfile with several entry points is an error (use --outdir)");
    const none = bun("build");
    ok(none.code === 1 && /usage: bun build/.test(none.text), "no entry point prints usage");
    // The rejected options reach Bun.build rather than being handled twice: the CLI
    // must not grow its own opinion about --minify, or the two front doors drift.
    const minify = bun("build", "app.ts", "--minify", "--outfile=a.js");
    ok(!/unknown option/.test(minify.text), "--minify is a known flag, forwarded to Bun.build (which owns the refusal)");
  } finally {
    fsMod.rmSync(dir, { recursive: true, force: true });
  }
}

// ── bun:test runner parity (Phase 5A) ────────────────────────────────────────
// Everything below was captured from a REAL `bun test` (1.3.6, d530ed99) and is
// asserted byte-for-byte, per the rule in AGENTS.md: for an API with a defined
// answer, the test is a value from outside this repo. The `.each` titles and the
// snapshot bytes in particular are not "what looks right" — they are what the
// binary printed, upstream bugs included, and several of them are surprising.
console.log("== bun:test .each titles reproduce Bun's formatter, bugs included ==");
{
  // The printf pass substitutes %s only for STRINGS and %d/%i/%f only for NUMBERS:
  // a %s handed a number leaves the literal "%s" in the title AND still consumes
  // the argument. Every expectation here is a line of real `bun test` output.
  ok(formatEachTitle("A %s|%s", [1, "z"], 0) === "A %s|z", "%s substitutes a string and leaves the token for a number");
  ok(formatEachTitle("B %d|%s", [1, "z"], 0) === "B 1|z", "%d substitutes a number");
  ok(formatEachTitle("C %i|%j", [1, "z"], 0) === 'C 1|"z"', "%i integer, %j JSON");
  ok(formatEachTitle("D %f|%o", [1, "z"], 0) === 'D 1|"z"', "%f number, %o JSON");
  ok(formatEachTitle("E %p|%#", [1, "z"], 0) === "E 1|0", "%p pretty-format, %# the row index");
  ok(formatEachTitle("F %% %s", [1, "z"], 0) === "F % %s", "%% is a literal percent and consumes no argument");
  ok(formatEachTitle("index %# and %% and %s %j %o %p", [1, 2], 0) === "index 0 and % and %s 2 %o %p",
    "a token with no argument left stays literal");
  ok(formatEachTitle("A %s|%s|%s", [true, null, undefined], 0) === "A %s|%s|%s", "%s rejects true/null/undefined");
  ok(formatEachTitle("B %d|%d", ["s", 1], 0) === "B %d|1", "%d rejects a string but still consumes it");
  ok(formatEachTitle("C %j|%o", [new Map([["k", 1]]), { a: { b: 2 } }], 0) === 'C {}|{"a":{"b":2}}',
    "%j is JSON.stringify, so a Map renders as {}");
  // JSC stores 1.7 and -0 as doubles, and Bun's %i wants an int32 — so both come
  // back as the literal token. This is the sort of detail a from-scratch
  // reimplementation gets wrong in a way nobody notices until a title changes.
  ok(formatEachTitle("A i=%i", [1.7], 0) === "A i=%i", "%i rejects a float");
  ok(formatEachTitle("D i=%i", [-0], 0) === "D i=%i", "%i rejects -0 (JSC holds it as a double)");
  ok(formatEachTitle("B d=%d", [1.7], 0) === "B d=1.7" && formatEachTitle("E d=%d", [NaN], 0) === "E d=NaN", "%d takes any number");

  // The $property pass, and its off-by-one: on a MISS Bun emits the literal $path
  // and then swallows the next character.
  ok(formatEachTitle("E $a.b $n $#", { a: { b: 7 }, n: "q" }, 0) === "E 7 q $", "$path walks a dotted path; $# is not a token");
  ok(formatEachTitle("B $ end", { n: 1 }, 0) === "B $end", "a bare $ eats the following space (upstream off-by-one)");
  ok(formatEachTitle("C $n$n end", { n: 1 }, 0) === "C $n$nend", "$ is an identifier character, so $n$n is one (missing) path");
  ok(formatEachTitle("F $a-b end", { "a-b": 1 }, 0) === "F $ab end", "the path stops at '-', then the '-' is swallowed");
  ok(formatEachTitle("E pre$n.x post", { n: "s" }, 0) === "E pre$n.xpost", "a partial path miss eats the space too");
  ok(formatEachTitle("F $missing", { a: 1 }, 0) === "F $missing", "an unknown key is left alone");
  ok(formatEachTitle("G $0 $1", [10, 20], 0) === "G $0 $1", "$ substitution is inert for an ARRAY row — no character is eaten");
  ok(formatEachTitle("D $n end", { n: { a: 1 } }, 0) === 'D {\n  "a": 1,\n} end', "an object value is pretty-formatted into the title");
}

console.log("== bun:test snapshot serializer is byte-exact with Bun's ==");
{
  // Each expectation is the exact body real Bun wrote into a .snap file. This is
  // the check that lets the shim claim compatibility rather than resemblance: a
  // .snap written here was fed back to a real `bun test` and matched.
  ok(prettyFormat({ a: 1, b: [1, 2], c: "str", d: null, e: undefined }) ===
    '{\n  "a": 1,\n  "b": [\n    1,\n    2,\n  ],\n  "c": "str",\n  "d": null,\n  "e": undefined,\n}', "object/array/undefined");
  ok(prettyFormat("hello") === '"hello"' && prettyFormat("") === '""' && prettyFormat(42) === "42" &&
    prettyFormat(true) === "true" && prettyFormat(null) === "null" && prettyFormat(undefined) === "undefined", "primitives");
  ok(prettyFormat("a\nb") === '"a\nb"', "a top-level multi-line string keeps its newlines unescaped");
  ok(prettyFormat({ b: 1, A: 2, 10: 3, 2: 4, _z: 5, a: 6 }) ===
    '{\n  "10": 3,\n  "2": 4,\n  "A": 2,\n  "_z": 5,\n  "a": 6,\n  "b": 1,\n}', "keys are SORTED, by codepoint");
  ok(prettyFormat({ e: new Error("bad"), t: new TypeError("tt") }) === '{\n  "e": [Error: bad],\n  "t": [TypeError: tt],\n}', "errors");
  ok(prettyFormat({ p: Promise.resolve(1) }) === '{\n  "p": Promise {},\n}', "a promise is not awaited");
  ok(prettyFormat({ d: new Date(0), r: /x/ }) === '{\n  "d": 1970-01-01T00:00:00.000Z,\n  "r": /x/,\n}', "Date/RegExp are unquoted");
  ok(prettyFormat(Object.create(null)) === "{}", "a null-prototype object gets no prefix");
  // Bun prints a getter as [native code] rather than invoking it — which is also
  // the safe behaviour, since a snapshot must not run user code with side effects.
  ok(prettyFormat(Object.defineProperty({}, "g", { get: () => 1, enumerable: true })) === '{\n  "g": [native code],\n}', "a getter is not invoked");
  {
    const sparse = [1]; sparse[3] = 4;
    ok(prettyFormat(sparse) === "[\n  1,\n  undefined,\n  undefined,\n  4,\n]", "a hole prints as undefined");
    const cyc = { a: 1 }; cyc.self = cyc;
    ok(prettyFormat(cyc) === '{\n  "a": 1,\n  "self": [Circular],\n}', "a cycle is [Circular], not a stack overflow");
  }
  class Point { constructor() { this.x = 1; this.y = 2; } }
  // Bun reads a function's DECLARED name only: an arrow assigned to a property has
  // an inferred .name but still prints as plain [Function].
  ok(prettyFormat({ cls: new Point(), buf: new Uint8Array([1, 2]), big: 10n, sym: Symbol("s"), neg: -0, nan: NaN, inf: Infinity, fn: function named() {}, anon: () => {} }) ===
    '{\n  "anon": [Function],\n  "big": 10n,\n  "buf": Uint8Array [\n    1,\n    2,\n  ],\n  "cls": Point {\n    "x": 1,\n    "y": 2,\n  },\n  "fn": [Function: named],\n  "inf": Infinity,\n  "nan": NaN,\n  "neg": -0,\n  "sym": Symbol(s),\n}',
    "class instance / typed array / bigint / symbol / -0 / declared-vs-inferred function name");
  ok(prettyFormat(new Map([["k", 1]])) === 'Map {\n  "k" => 1,\n}' && prettyFormat(new Set([1])) === "Set {\n  1,\n}", "a TOP-LEVEL Map/Set");
  // Bun indents a nested multi-line string at column 0 and closes it with a lone
  // comma. That is an upstream bug, but it is stable and it is what a .snap file
  // written by the real binary contains, so it is reproduced rather than tidied.
  ok(prettyFormat({ s: "a\nb" }) === '{\n  "s": \n"a\nb"\n,\n}', "a nested multi-line string keeps Bun's odd layout");
  ok(prettyFormat({ x: { s: "a\nb" } }) === '{\n  "x": {\n    "s": \n"a\nb"\n,\n  },\n}', "…at any depth");
  ok(prettyFormat(["a\nb"]) === '[\n  \n"a\nb"\n,\n]', "…and inside an array");
  // A nested Map/Set is where Bun's layout stops being self-consistent (a nested
  // Set gains indent-width padding, a nested Map at the same depth gains none), so
  // there is no rule to encode and this refuses instead of inventing bytes.
  let nestedSet = "";
  try { prettyFormat({ s: new Set([1]) }); } catch (e) { nestedSet = e.message; }
  ok(/cannot snapshot a Set nested inside/.test(nestedSet), "a NESTED Set throws instead of writing bytes real Bun would reject");
  let nestedMap = "";
  try { prettyFormat([new Map()]); } catch (e) { nestedMap = e.message; }
  ok(/cannot snapshot a Map nested inside/.test(nestedMap) && /toEqual/.test(nestedMap), "…same for a nested Map, and the message says what to use instead");
}

console.log("== bun:test .snap file codec round-trips Bun's escaping ==");
{
  const body = '{\n  "a": "back`tick",\n  "b": "dollar${x}",\n  "c": "back\\slash",\n}';
  const text = formatSnapshotFile(new Map([["escapes 1", body]]));
  // A .snap file is executable CommonJS, so the body sits inside a template
  // literal: a backslash, a backtick or a ${ has to be escaped or the file stops
  // parsing. These are the exact bytes real Bun wrote for the same value.
  ok(text === '// Bun Snapshot v1, https://bun.sh/docs/test/snapshots\n\nexports[`escapes 1`] = `\n{\n  "a": "back\\`tick",\n  "b": "dollar\\${x}",\n  "c": "back\\\\slash",\n}\n`;\n',
    "backtick / ${ / backslash are escaped exactly as Bun escapes them");
  ok(parseSnapshotFile(text).get("escapes 1") === body, "…and reading undoes it");
  ok(parseSnapshotFile(formatSnapshotFile(new Map([["k 1", "42"]]))).get("k 1") === "42", "a single-line body is stored inline, not wrapped in newlines");
  // Bun writes an inline snapshot back into the source indented to the call site,
  // so the stored text carries the file's indentation and has to be stripped
  // before comparison — otherwise every inline snapshot inside a describe fails on
  // whitespace alone.
  ok(dedentInlineSnapshot('\n    {\n      "a": 1,\n    }\n  ') === '{\n  "a": 1,\n}', "an inline snapshot written at depth is dedented");
  ok(dedentInlineSnapshot('"plain"') === '"plain"', "a single-line inline snapshot is untouched");
}

// A bun:test runner is per-runtime state, and several checks below need a
// specific process env (CI in particular), so each builds its own.
function bunTestWith(env, cwd) {
  const logs = [];
  const proc = {
    env: env || {}, argv: ["bun"], cwd: () => cwd || "/",
    stdout: { write: (s) => logs.push(s) }, stderr: { write: (s) => logs.push(s) }, stdin: process.stdin,
  };
  const { modules } = createBunRuntime({ process: proc, Buffer, require: nodeRequire });
  return { t: modules["bun:test"], report: () => logs.join("") };
}

console.log("== bun:test describe/test modifiers ==");
{
  // describe was a plain function with no properties at all, and test had no
  // .each/.if/.failing — a suite using any of them died at load with "is not a
  // function", which at least was loud. The risk now is the opposite one: a
  // modifier that registers a test it should have skipped.
  const { t } = bunTestWith();
  const ran = [];
  t.describe.skip("s", () => t.test("a", () => ran.push("a")));
  t.describe.todo("td", () => t.test("b", () => ran.push("b")));
  t.describe("n", () => t.test("c", () => ran.push("c")));
  t.describe.if(true)("it", () => t.test("d", () => ran.push("d")));
  t.describe.if(false)("if", () => t.test("e", () => ran.push("e")));
  t.describe.skipIf(true)("si", () => t.test("f", () => ran.push("f")));
  t.describe.todoIf(true)("ti", () => t.test("g", () => ran.push("g")));
  t.test.if(false)("h", () => ran.push("h"));
  t.test.skipIf(true)("i", () => ran.push("i"));
  t.test.todoIf(true)("j", () => ran.push("j"));
  const code = await t.__run();
  ok(ran.join(",") === "c,d", "only the un-skipped tests run (ran: " + ran.join(",") + ")");
  ok(code === 0, "skipped and todo tests do not fail the run");
}
{
  const { t, report } = bunTestWith();
  // test.failing inverts the verdict — and a test that starts PASSING is a signal,
  // so Bun fails it with a message telling you to remove the modifier.
  t.test.failing("throws as designed", () => { throw new Error("x"); });
  t.test.failing("passes unexpectedly", () => {});
  const code = await t.__run();
  ok(code === 1, "test.failing: a throwing test passes, a passing one fails the run");
  ok(/marked as failing but it passed/.test(report()), "…with Bun's own explanation");
}
{
  const { t, report } = bunTestWith();
  t.test.each([[1, 2, 3], [2, 3, 5]])("t %i + %i = %i", (a, b, c) => { if (a + b !== c) throw new Error("bad"); });
  t.describe.each([[1, 2, 3]])("d %i + %i = %i", (a, b, c) => t.test("adds", () => { if (a + b !== c) throw new Error("bad"); }));
  t.test.each([{ name: "x", v: 1 }])("obj $name -> $v", (row) => { if (typeof row.v !== "number") throw new Error("bad"); });
  const code = await t.__run();
  const r = report();
  ok(code === 0 && /4 pass/.test(r) && /0 fail/.test(r), "each runs one test per row with the row spread as arguments");
  ok(r.includes("t 1 + 2 = 3") && r.includes("t 2 + 3 = 5"), "test.each titles are formatted per row");
  ok(r.includes("d 1 + 2 = 3 > adds"), "describe.each names the SUITE, and its tests nest under it");
  ok(r.includes("obj x -> 1"), "a non-array row is one argument and enables $property titles");
}

console.log("== bun:test per-test timeouts ==");
{
  // The options bag used to read only {skip, only} — Bun's public third argument is
  // `number | {timeout, retry, repeats}`, so a per-test timeout was silently
  // ignored and a hung test hung the run forever.
  const { t, report } = bunTestWith();
  t.test("async over budget", async () => { await new Promise((r) => setTimeout(r, 200)); }, 40);
  t.test("sync over budget", () => { const s = Date.now(); while (Date.now() - s < 120) { /* burn */ } }, 40);
  t.test("under budget", async () => { await new Promise((r) => setTimeout(r, 5)); }, { timeout: 500 });
  const code = await t.__run();
  const r = report();
  ok(code === 1, "a test over its timeout fails the run");
  ok((r.match(/timed out after 40ms/g) || []).length === 2, "both the number and the {timeout} form are honoured");
  // Nothing in JavaScript can interrupt a synchronous loop, and real Bun does not
  // either — it lets the body finish and reports the timeout afterwards. Matching
  // that is the honest behaviour; pretending to abort would be the lie.
  ok(/✓ under budget/.test(r) || /\u2713 under budget/.test(r), "a test inside its budget still passes");
}
{
  const { t } = bunTestWith();
  let attempts = 0, runs = 0;
  t.test("retried", () => { attempts++; if (attempts < 3) throw new Error("flaky"); }, { retry: 3 });
  t.test("repeated", () => { runs++; }, { repeats: 2 });
  const code = await t.__run();
  ok(code === 0 && attempts === 3, "retry re-runs a failing test (attempts: " + attempts + ")");
  ok(runs === 3, "repeats: 2 runs the body three times (runs: " + runs + ")");
}
{
  const { t, report } = bunTestWith();
  t.test("default budget", async () => { await new Promise((r) => setTimeout(r, 30)); });
  await t.__run({ timeout: 5 });
  ok(/timed out after 5ms/.test(report()), "--timeout sets the default for tests that declare none");
}

console.log("== bun:test .only is refused under CI (Bun's guard, and the reason for it) ==");
{
  // A committed `.only` narrows a CI run to one test and reports success. Bun
  // throws at REGISTRATION when $CI is truthy rather than letting that happen, and
  // this shim's own history (test.only used to filter nothing at all) is why the
  // guard is worth reproducing exactly.
  const { t } = bunTestWith({ CI: "true" });
  let onlyMsg = "", describeMsg = "";
  try { t.test.only("x", () => {}); } catch (e) { onlyMsg = e.message; }
  try { t.describe.only("y", () => {}); } catch (e) { describeMsg = e.message; }
  ok(/\.only is disabled in CI environments/.test(onlyMsg), "test.only throws under CI=true");
  ok(/\.only is disabled in CI environments/.test(describeMsg), "describe.only too");
  ok(/CI=false/.test(onlyMsg), "…and the message says how to override it");
  for (const v of ["false", "0", ""]) {
    const { t: t2 } = bunTestWith({ CI: v });
    let threw = false;
    try { t2.test.only("x", () => {}); } catch { threw = true; }
    ok(!threw, `CI=${JSON.stringify(v)} is not a CI environment`);
  }
}
{
  const { t } = bunTestWith();
  const ran = [];
  t.describe.only("focused", () => t.test("a", () => ran.push("a")));
  t.describe("other", () => t.test("b", () => ran.push("b")));
  await t.__run();
  ok(ran.join(",") === "a", "describe.only focuses the whole run, not just its own suite");
}

console.log("== bun:test toThrow: the argument forms are four different comparisons ==");
{
  const { t } = bunTestWith();
  const e = t.expect;
  const passes = (fn) => { try { fn(); return true; } catch { return false; } };
  const boom = () => { throw new Error("boom happened"); };
  class MyErr extends Error {}
  ok(passes(() => e(boom).toThrow("boom")), "a STRING is a substring match");
  ok(passes(() => e(boom).toThrow(/happ/)), "a REGEXP is tested against the message");
  // Regression: the old matcher fed a RegExp to `includes("")`, so every error
  // matched every pattern — an assertion that could not fail.
  ok(!passes(() => e(boom).toThrow(/nope/)), "…and a non-matching RegExp now FAILS (it used to always pass)");
  ok(passes(() => e(() => { throw new MyErr("c"); }).toThrow(MyErr)), "a CLASS is an instanceof check");
  ok(!passes(() => e(boom).toThrow(MyErr)), "…and the wrong class fails");
  // An Error INSTANCE compares the message for EQUALITY — the opposite of the
  // string form, which is the surprise worth pinning.
  ok(passes(() => e(boom).toThrow(new Error("boom happened"))), "an Error INSTANCE compares the message for equality");
  ok(!passes(() => e(boom).toThrow(new Error("boom"))), "…so a partial message does NOT match an instance");
  ok(passes(() => e(boom).not.toThrow("nope")) && !passes(() => e(boom).not.toThrow("boom")), "negation composes with the message argument");
  ok(passes(() => e(() => { throw "plain string"; }).toThrow("plain")), "a thrown non-Error is matched against its own string");
  ok(passes(() => e(boom).toThrowError("boom")), "toThrowError is the documented alias");
  ok(!passes(() => e(5).toThrow()), "a non-callable receiver is a usage error, not a passing assertion");
}

console.log("== bun:test .resolves / .rejects carry the whole matcher set ==");
{
  // `.resolves` had exactly two matchers and `.rejects.toThrow` ignored both its
  // message argument and negation — so `rejects.toThrow('anything at all')` passed
  // for every rejection.
  const { t } = bunTestWith();
  const e = t.expect;
  const settles = async (fn) => { try { await fn(); return true; } catch { return false; } };
  const rej = () => Promise.reject(new Error("nope happened"));
  ok(await settles(() => e(rej()).rejects.toThrow("nope")), "rejects.toThrow matches the message");
  ok(!(await settles(() => e(rej()).rejects.toThrow("something else"))), "…and a wrong message FAILS (the message used to be ignored)");
  ok(await settles(() => e(rej()).rejects.not.toThrow("something else")), "rejects.not composes (negation used to be ignored)");
  ok(!(await settles(() => e(rej()).rejects.not.toThrow("nope"))), "…in both directions");
  ok(await settles(() => e(Promise.reject(42)).rejects.toBe(42)), "the matcher runs against the rejection VALUE, not just Errors");
  ok(await settles(() => e(Promise.reject({ a: 1 })).rejects.toEqual({ a: 1 })), "…with any matcher");
  ok(await settles(() => e(Promise.resolve([1, 2])).resolves.toHaveLength(2)), "resolves has the full set too (it had toBe and toEqual)");
  ok(await settles(() => e(Promise.resolve(1)).resolves.not.toBe(2)), "resolves.not");
  ok(!(await settles(() => e(rej()).resolves.toBe(1))), "resolves on a rejecting promise fails");
  ok(!(await settles(() => e(Promise.resolve(1)).rejects.toThrow())), "rejects on a resolving promise fails");
  // Bun rejects a function here (Jest accepts one); reproduced so a suite written
  // against Bun behaves the same way.
  ok(!(await settles(() => e(rej).rejects.toThrow("nope"))), "a FUNCTION is not a promise — Bun refuses it and so do we");
  // Real Bun returns UNDEFINED from `.rejects.toThrow()` on an already-settled
  // promise: it peeks the settled value synchronously and throws. No browser engine
  // exposes that peek (see bun-unsupported.js), so ours always returns a promise —
  // the safe direction, since `await undefined` would silently assert nothing.
  const returned = e(Promise.resolve(1)).resolves.toBe(1);
  ok(!!returned && typeof returned.then === "function", "…and ours always returns a real promise");
  await returned;
}
{
  const { t } = bunTestWith();
  // The other half of that decision: a missing `await` must not turn a red test
  // green. The runner drains outstanding async assertions before it scores a test.
  t.test("forgot the await", () => { t.expect(Promise.resolve(1)).resolves.toBe(2); });
  ok(await t.__run() === 1, "an un-awaited .resolves failure still fails its test");
}

console.log("== bun:test mock / spy surface ==");
{
  const { t } = bunTestWith();
  const e = t.expect;
  const passes = (fn) => { try { fn(); return true; } catch { return false; } };
  const f = t.mock((x) => x * 2);
  f(1); f(2, 3);
  ok(passes(() => e(f).toHaveBeenCalled()) && passes(() => e(f).toHaveBeenCalledTimes(2)), "toHaveBeenCalled / Times");
  ok(passes(() => e(f).toHaveBeenCalledWith(2, 3)) && !passes(() => e(f).toHaveBeenCalledWith(9)), "toHaveBeenCalledWith compares arguments structurally");
  ok(passes(() => e(f).toHaveBeenLastCalledWith(2, 3)) && !passes(() => e(f).toHaveBeenLastCalledWith(1)), "toHaveBeenLastCalledWith");
  ok(passes(() => e(f).toHaveBeenNthCalledWith(1, 1)) && !passes(() => e(f).toHaveBeenNthCalledWith(2, 1)), "toHaveBeenNthCalledWith counts from 1");
  ok(passes(() => e(f).toHaveReturnedTimes(2)), "toHaveReturnedTimes");
  ok(!passes(() => e(() => {}).toHaveBeenCalled()), "a plain function is a usage error, not a silent pass");
  const thrower = t.mock(() => { throw new Error("e"); });
  try { thrower(); } catch { /* expected */ }
  ok(thrower.mock.results.map((r) => r.type).join() === "throw", "a throwing mock records {type:'throw'} (it used to record nothing)");
  ok(!passes(() => e(thrower).toHaveReturned()), "…so toHaveReturned does not count it");
  const once = t.mock().mockReturnValueOnce(1).mockReturnValue(2);
  ok(once() === 1 && once() === 2 && once() === 2, "mockReturnValueOnce queues ahead of mockReturnValue");
  ok(JSON.stringify(once.mock.lastCall) === "[]" && once.mock.calls.length === 3, "mock.lastCall / mock.calls");
}
{
  const { t } = bunTestWith();
  const obj = { m() { return "real"; } };
  const proto = { p() { return "proto"; } };
  const child = Object.create(proto);
  const s1 = t.spyOn(obj, "m");
  t.spyOn(child, "p");
  ok(obj.m() === "real" && s1.mock.calls.length === 1, "a spy calls through to the original by default");
  t.mock.restore();
  ok(obj.m() === "real" && s1.mock.calls.length === 1, "mock.restore() puts the original back (it used to be a no-op)");
  // An inherited method has to be DELETED on restore, not assigned back, or the
  // object keeps an own-property copy that shadows the prototype forever.
  ok(!Object.prototype.hasOwnProperty.call(child, "p") && child.p() === "proto", "restoring a spy on an INHERITED method removes the own property");
  let msg = "";
  try { t.spyOn(obj, "notAMethod"); } catch (e2) { msg = e2.message; }
  ok(/does not exist/.test(msg), "spyOn a property that does not exist throws instead of installing a spy nothing calls");
}

console.log("== bun:test asymmetric matchers + expect.extend ==");
{
  const { t } = bunTestWith();
  const e = t.expect;
  const passes = (fn) => { try { fn(); return true; } catch { return false; } };
  ok(passes(() => e({ id: 1, n: "x" }).toEqual({ id: e.any(Number), n: e.any(String) })), "expect.any inside toEqual");
  // expect.any(String) has to match the primitive as well as the wrapper, which a
  // bare instanceof does not.
  ok(passes(() => e("s").toEqual(e.any(String))) && passes(() => e(1n).toEqual(e.any(BigInt))), "expect.any covers primitives and their wrappers");
  ok(passes(() => e({ a: { b: [2] } }).toEqual({ a: { b: [e.any(Number)] } })), "asymmetric matchers are honoured RECURSIVELY");
  ok(!passes(() => e({ a: 1, b: 2 }).toEqual({ a: e.any(Number) })), "…and the surrounding comparison still counts keys");
  ok(passes(() => e({ a: 1, b: 2 }).toEqual(e.objectContaining({ a: 1 }))), "expect.objectContaining");
  ok(passes(() => e([1, 2, 3]).toEqual(e.arrayContaining([3, 2]))), "expect.arrayContaining");
  ok(passes(() => e("hello world").toEqual(e.stringContaining("lo wo"))), "expect.stringContaining");
  ok(passes(() => e("hello").toEqual(e.stringMatching(/^he/))), "expect.stringMatching");
  ok(passes(() => e({ v: 0.1 + 0.2 }).toEqual({ v: e.closeTo(0.3) })), "expect.closeTo");
  ok(passes(() => e({ a: 1 }).toEqual(e.not.objectContaining({ b: 1 }))) && !passes(() => e({ b: 1 }).toEqual(e.not.objectContaining({ b: 1 }))), "expect.not.*");
  ok(passes(() => e({ a: 1 }).toStrictEqual({ a: e.any(Number) })), "…inside toStrictEqual");
  ok(passes(() => e({ a: 1, b: 2 }).toMatchObject({ a: e.any(Number) })), "…inside toMatchObject");
  ok(passes(() => e([{ a: 1 }]).toContainEqual({ a: e.any(Number) })), "…inside toContainEqual");
  ok(passes(() => e(new Map([["k", 1]])).toEqual(new Map([["k", e.any(Number)]]))), "…inside a Map");
  const m = t.mock(); m({ id: 7 });
  ok(passes(() => e(m).toHaveBeenCalledWith({ id: e.any(Number) })), "…and inside toHaveBeenCalledWith");
  // Regression guard: the strict/loose split that Phase 0 fixed must survive the
  // asymmetric-aware walk, which only replaces Bun.deepEquals when a matcher is
  // actually present in the expected tree.
  ok(passes(() => e({ a: 1 }).toEqual({ a: 1, b: undefined })) && !passes(() => e({ a: 1 }).toStrictEqual({ a: 1, b: undefined })), "the loose/strict split is untouched");
  e.extend({ toBeWithin(received, lo, hi) { return { pass: received >= lo && received <= hi, message: () => `expected ${received} within ${lo}..${hi}` }; } });
  ok(passes(() => e(5).toBeWithin(1, 10)) && !passes(() => e(50).toBeWithin(1, 10)), "expect.extend registers a matcher");
  ok(passes(() => e(50).not.toBeWithin(1, 10)), "…and it composes with .not");
  let extendMsg = "";
  try { e(50).toBeWithin(1, 10); } catch (e2) { extendMsg = e2.message; }
  ok(/expected 50 within 1\.\.10/.test(extendMsg), "…and its message() is what the failure prints");
}

console.log("== bun:test matcher breadth ==");
{
  const { t } = bunTestWith();
  const e = t.expect;
  const passes = (fn) => { try { fn(); return true; } catch { return false; } };
  // Jest's rule, and not the obvious one: the tolerance is 10^-digits / 2, and
  // `digits` defaults to 2 — so toBeCloseTo(1.24, 1) passes for 1.23.
  ok(passes(() => e(0.1 + 0.2).toBeCloseTo(0.3)) && passes(() => e(0.1 + 0.2).toBeCloseTo(0.3, 5)), "toBeCloseTo");
  ok(passes(() => e(1.23).toBeCloseTo(1.24, 1)) && !passes(() => e(1.23).toBeCloseTo(1.24, 3)), "…with the digits argument");
  ok(passes(() => e({ a: { b: [1, 2] } }).toHaveProperty("a.b")) && passes(() => e({ a: { b: [1, 2] } }).toHaveProperty("a.b", [1, 2])), "toHaveProperty with a dotted path");
  // The array form is the only way to reach a key that contains a dot, so the two
  // spellings are not interchangeable.
  ok(passes(() => e({ "a.b": 1 }).toHaveProperty(["a.b"], 1)) && !passes(() => e({ "a.b": 1 }).toHaveProperty("a.b", 1)), "…and the ARRAY form reaches a key containing a dot");
  ok(passes(() => e({ a: undefined }).toHaveProperty("a")) && passes(() => e({ a: 1 }).not.toHaveProperty("z")), "toHaveProperty finds a present-but-undefined property");
  ok(passes(() => e([{ a: 1 }]).toContainEqual({ a: 1 })) && !passes(() => e([{ a: 1 }]).toContain({ a: 1 })), "toContainEqual is structural where toContain is identity");
  ok(passes(() => e([]).toBeEmpty()) && passes(() => e("").toBeEmpty()) && passes(() => e({}).toBeEmpty()) && passes(() => e(new Set()).toBeEmpty()) && !passes(() => e({ a: 1 }).toBeEmpty()), "toBeEmpty");
  ok(passes(() => e([1]).toBeArray()) && passes(() => e([1]).toBeArrayOfSize(1)) && passes(() => e("s").toBeString()) &&
    passes(() => e(1).toBeNumber()) && passes(() => e(true).toBeBoolean()) && passes(() => e(() => {}).toBeFunction()) &&
    passes(() => e({}).toBeObject()) && passes(() => e(null).toBeNil()) && passes(() => e(1).toBeTypeOf("number")) &&
    passes(() => e(1).toBeInteger()) && passes(() => e(1).toBeFinite()) && passes(() => e(new Date()).toBeDate()), "the type matchers");
  ok(passes(() => e("abc").toStartWith("ab")) && passes(() => e("abc").toEndWith("bc")) && passes(() => e("abc").toInclude("b")), "the string matchers");
  ok(passes(() => e(1).toBeOneOf([1, 2])) && passes(() => e(2).toSatisfy((n) => n > 1)), "toBeOneOf / toSatisfy");
}

console.log("== bun:test snapshots against a real filesystem ==");
{
  const fsMod = nodeRequire("node:fs");
  const osMod = nodeRequire("node:os");
  const pathMod = nodeRequire("node:path");
  const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "vv-bun-snap-"));
  try {
    const file = pathMod.join(dir, "a.test.js");
    const snapPath = pathMod.join(dir, "__snapshots__", "a.test.js.snap");
    const suite = (t) => {
      t.__setFile(file);
      t.describe("outer", () => t.describe("inner", () => t.test("nested", () => t.expect({ a: 1 }).toMatchSnapshot())));
      t.test("twice", () => { t.expect(1).toMatchSnapshot(); t.expect(2).toMatchSnapshot(); });
      t.test("named", () => t.expect({ z: 1 }).toMatchSnapshot("custom name"));
    };
    {
      const { t } = bunTestWith({}, dir);
      suite(t);
      ok(await t.__run() === 0, "a first run creates the snapshots and passes");
      // These are the bytes real Bun writes for the same suite — and a file with
      // exactly these bytes was fed back to a real `bun test`, which read it and
      // passed. Note the KEY: describe blocks are joined by a SPACE here while the
      // reporter joins them with " > ", and a second snapshot in one test gets a
      // counter rather than overwriting the first.
      ok(fsMod.readFileSync(snapPath, "utf8") ===
        '// Bun Snapshot v1, https://bun.sh/docs/test/snapshots\n\n' +
        'exports[`named: custom name 1`] = `\n{\n  "z": 1,\n}\n`;\n\n' +
        'exports[`outer inner nested 1`] = `\n{\n  "a": 1,\n}\n`;\n\n' +
        'exports[`twice 1`] = `1`;\n\nexports[`twice 2`] = `2`;\n',
        "…in Bun's exact .snap bytes, keyed the way Bun keys them");
    }
    {
      const { t } = bunTestWith({}, dir);
      suite(t);
      ok(await t.__run() === 0, "a second run MATCHES the stored snapshots");
    }
    {
      const { t, report } = bunTestWith({}, dir);
      t.__setFile(file);
      t.describe("outer", () => t.describe("inner", () => t.test("nested", () => t.expect({ a: 999 }).toMatchSnapshot())));
      ok(await t.__run() === 1 && /did not match/.test(report()), "a changed value fails against the stored snapshot");
    }
    {
      // Bun refuses to CREATE a snapshot under CI: the first green build would
      // otherwise prove nothing, because the run wrote its own expectations.
      const { t, report } = bunTestWith({ CI: "true" }, dir);
      t.__setFile(file);
      t.test("brand new", () => t.expect(1).toMatchSnapshot());
      ok(await t.__run() === 1 && /disabled in CI environments/.test(report()), "creating a snapshot under CI fails instead of writing one");
      const { t: t2 } = bunTestWith({ CI: "true" }, dir);
      t2.__setFile(file);
      t2.test("brand new", () => t2.expect(1).toMatchSnapshot());
      ok(await t2.__run({ updateSnapshots: true }) === 0, "…and --update-snapshots overrides the guard");
    }
    {
      const { t, report } = bunTestWith({}, dir);
      t.__setFile(file);
      t.test("ok", () => t.expect({ a: 1 }).toMatchInlineSnapshot('\n    {\n      "a": 1,\n    }\n  '));
      t.test("bad", () => t.expect({ a: 2 }).toMatchInlineSnapshot('\n{\n  "a": 1,\n}\n'));
      t.test("create", () => t.expect({ a: 1 }).toMatchInlineSnapshot());
      await t.__run();
      const r = report();
      ok(/\u2713 ok/.test(r) && /inline snapshot did not match/.test(r), "an inline snapshot compares (and fails) against the value");
      // Writing one back means editing the user's source at a position we would
      // have to take from a stack frame pointing at loader-transformed code.
      ok(/would have to WRITE the snapshot/.test(r) && /toMatchSnapshot\(\)/.test(r), "…and CREATING one is refused loudly, with the value to paste in");
    }
    {
      const { t } = bunTestWith({}, dir);
      t.__setFile(file);
      t.describe("alpha", () => { t.test("one", () => {}); t.test("two", () => { throw new Error("nope"); }); });
      const outfile = pathMod.join(dir, "junit.xml");
      await t.__run({ reporter: "junit", reporterOutfile: outfile });
      const xml = fsMod.readFileSync(outfile, "utf8");
      ok(/<testsuites name="bun test" tests="2"/.test(xml) && /failures="1"/.test(xml), "--reporter=junit writes a JUnit summary");
      ok(/classname="alpha"/.test(xml) && /<failure message="nope"/.test(xml), "…with the describe as the classname and the failure message");
    }
  } finally {
    fsMod.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("== bun:test run options: -t, --bail, --todo ==");
{
  const { t, report } = bunTestWith();
  const ran = [];
  t.describe("alpha", () => { t.test("one", () => ran.push("a1")); t.test("two", () => ran.push("a2")); });
  t.test("beta one", () => ran.push("b1"));
  // -t is a REGEX against the FULL name, describe prefix included and joined with
  // " > " — so "one$" catches "alpha > one" and "beta one" but not "alpha > two".
  ok(await t.__run({ testNamePattern: "one$" }) === 0, "-t run exits 0");
  ok(ran.join(",") === "a1,b1", "-t filters on the full 'describe > test' label (ran: " + ran.join(",") + ")");
  ok(/1 filtered out/.test(report()), "…and the filtered-out count is reported, not hidden");
}
{
  const { t, report } = bunTestWith();
  t.test("nothing matches this", () => {});
  ok(await t.__run({ testNamePattern: "zzz" }) === 1, "a -t that matches nothing exits 1 rather than reporting an empty green run");
  ok(/matched 0 tests/.test(report()), "…and says so");
}
{
  const { t, report } = bunTestWith();
  const ran = [];
  t.test("f1", () => { ran.push(1); throw new Error("a"); });
  t.test("f2", () => { ran.push(2); throw new Error("b"); });
  t.test("ok", () => ran.push(3));
  ok(await t.__run({ bail: 1 }) === 1 && ran.length === 1, "--bail stops at the first failure (ran " + ran.length + " tests)");
  ok(/Bailed out after 1 failure/.test(report()), "…and says it bailed");
}
{
  const { t } = bunTestWith();
  const ran = [];
  t.test.todo("later", () => ran.push("todo"));
  await t.__run();
  ok(ran.length === 0, "a todo test does not run by default");
  const { t: t2 } = bunTestWith();
  const ran2 = [];
  t2.test.todo("later", () => ran2.push("todo"));
  await t2.__run({ todo: true });
  ok(ran2.length === 1, "--todo runs it");
}
{
  // `--only` asks for the tests marked .only. With none marked, the answer is an
  // empty run — treating the flag as a no-op would run the whole suite under a
  // flag asking for the opposite.
  const { t } = bunTestWith();
  const ran = [];
  t.test("plain", () => ran.push("plain"));
  // Real bun 1.3.6 prints "0 pass / 0 fail" and exits 0 here — unlike a -t that
  // matches nothing, which is an error. Both were run against the binary.
  const code = await t.__run({ only: true });
  ok(ran.length === 0 && code === 0, "--only with nothing marked .only runs nothing, and exits 0 as real Bun does");
  const { t: t2 } = bunTestWith();
  const ran2 = [];
  t2.test("plain", () => ran2.push("plain"));
  t2.test.only("focused", () => ran2.push("focused"));
  await t2.__run({ only: true });
  ok(ran2.length === 1 && ran2[0] === "focused", "…and runs just the marked one when there is one");
}

console.log("== bun test CLI flags are parsed, not dropped (BUN_PROGRAM as a real process) ==");
{
  // Every flag below used to be discarded by `rest.filter(a => a[0] !== '-')`, so
  // `bun test -t auth` ran the entire suite and exited 0. That is the exact shape
  // of silent approximation this shim is not allowed to have.
  const osMod = nodeRequire("node:os");
  const fsMod = nodeRequire("node:fs");
  const pathMod = nodeRequire("node:path");
  const { spawnSync } = nodeRequire("node:child_process");
  const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "vv-bun-testcli-"));
  try {
    const binBun = pathMod.join(dir, "bun-shim.js");
    fsMod.writeFileSync(binBun, BUN_PROGRAM);
    fsMod.writeFileSync(pathMod.join(dir, "a.test.js"), "");
    const bun = (...args) => {
      const r = spawnSync(process.execPath, [binBun, ...args], { cwd: dir, encoding: "utf8" });
      return { code: r.status, text: (r.stdout || "") + (r.stderr || "") };
    };
    const unknown = bun("test", "--coverage");
    ok(unknown.code === 1 && /--coverage is not implemented/.test(unknown.text), "an unsupported flag is refused by name");
    ok(/Supported: -t\/--test-name-pattern/.test(unknown.text), "…and the supported set is listed");
    const badReporter = bun("test", "--reporter=tap");
    ok(badReporter.code === 1 && /--reporter=tap is not implemented/.test(badReporter.text), "an unknown reporter is refused");
    const noOutfile = bun("test", "--reporter=junit");
    ok(noOutfile.code === 1 && /requires --reporter-outfile/.test(noOutfile.text), "--reporter=junit without an outfile is refused (Bun requires it too)");
    const noValue = bun("test", "-t");
    ok(noValue.code === 1 && /-t needs a value/.test(noValue.text), "a flag missing its value is refused");
    // A positional that matches no file is a FILTER that selected nothing, which is
    // "no test files found" — not an attempt to require a path that does not exist.
    const noFiles = bun("test", "definitely-not-a-file");
    ok(noFiles.code === 1 && /no test files found/.test(noFiles.text), "a filter matching nothing reports no test files");
    ok(bun("test", "definitely-not-a-file", "--pass-with-no-tests").code === 0, "--pass-with-no-tests makes that exit 0");
  } finally {
    fsMod.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("== Bun.Transpiler.scan / scanImports (pinned to real Bun 1.3.6) ==");
{
  // Every row below is what a real `bun` binary answered (1.3.6, d530ed99),
  // captured rather than derived: the two methods report DIFFERENT sets, and no
  // amount of reading the docs would have predicted that a file whose only
  // dependency is `require("x")` scans as importing nothing. Columns are
  // [name, loader, source, scan().exports, scan().imports, scanImports()].
  const T = [
  ["default import", "ts", "import a from \"m1\";", [], [["import-statement","m1"]], [["import-statement","m1"]]],
  ["named import", "ts", "import { a, b as c } from \"m2\";", [], [["import-statement","m2"]], [["import-statement","m2"]]],
  ["namespace import", "ts", "import * as ns from \"m3\";", [], [["import-statement","m3"]], [["import-statement","m3"]]],
  ["side-effect import", "ts", "import \"m4\";", [], [["import-statement","m4"]], [["import-statement","m4"]]],
  ["default + named", "ts", "import d, { a as b } from \"m\";", [], [["import-statement","m"]], [["import-statement","m"]]],
  ["dynamic import", "ts", "const p = import(\"m5\");", [], [["dynamic-import","m5"]], [["dynamic-import","m5"]]],
  ["dynamic import template", "ts", "const p = import(`m6`);", [], [["dynamic-import","m6"]], [["dynamic-import","m6"]]],
  ["dynamic import variable", "ts", "const p = import(x);", [], [], []],
  ["require call", "ts", "const r = require(\"m7\");", [], [], [["require-call","m7"]]],
  ["require template", "ts", "const r = require(`tpl`);", [], [], [["require-call","tpl"]]],
  ["require.resolve", "ts", "const r = require.resolve(\"m8\");", [], [["require-resolve","m8"]], []],
  ["import attributes", "ts", "import a from \"m\" with { type: \"json\" };", [], [["import-statement","m"]], [["import-statement","m"]]],
  ["import.meta", "ts", "const u = import.meta.url;", [], [], []],
  ["export from", "ts", "export { a } from \"m9\";", ["a"], [["import-statement","m9"]], [["import-statement","m9"]]],
  ["export star from", "ts", "export * from \"m10\";", [], [["import-statement","m10"]], [["import-statement","m10"]]],
  ["export star as", "ts", "export * as ns from \"m11\";", ["ns"], [["import-statement","m11"]], [["import-statement","m11"]]],
  ["import type", "ts", "import type { T } from \"m12\";", [], [], []],
  ["inline type specifier", "ts", "import { type T, v } from \"m13\";", [], [["import-statement","m13"]], [["import-statement","m13"]]],
  ["export type from", "ts", "export type { T } from \"m14\";", [], [], []],
  ["export const/fn/class", "ts", "export const a = 1; export function b() {} export class C {}", ["C","a","b"], [], []],
  ["export default", "ts", "export default 1;", ["default"], [], []],
  ["export default fn", "ts", "export default function foo(){}", ["default"], [], []],
  ["export list with rename", "ts", "const a = 1, b = 2; export { a, b as c };", ["a","c"], [], []],
  ["export as default", "ts", "const a=1; export { a as default };", ["default"], [], []],
  ["export destructured", "ts", "export const { a, b } = obj; export const [c, d] = arr;", ["a","b","c","d"], [], []],
  ["export let/var", "ts", "export let a=1; export var b=2;", ["a","b"], [], []],
  ["export enum", "ts", "export enum E { A }", ["E"], [], []],
  ["export interface", "ts", "export interface I {}", [], [], []],
  ["export type alias", "ts", "export type X = number;", [], [], []],
  ["export ordering", "ts", "export const b=1; export const A=2; export const a=3; export const B=4;", ["A","B","a","b"], [], []],
  ["export ordering symbols", "ts", "export const _a=1; export const $b=2; export const c=3;", ["$b","_a","c"], [], []],
  ["cjs module.exports", "ts", "module.exports = { a: 1 };", [], [], []],
  ["empty source", "ts", "", [], [], []],
  ["require in string", "ts", "const s = 'require(\"no\")';", [], [], []],
  ["require in comment", "ts", "// require(\"no\")\nconst a = 1;", [], [], []],
  ["commented import", "ts", "// import x from \"commented\";\nconst a = 1;", [], [], []],
  ["member .require", "ts", "const r = obj.require(\"nope\");", [], [], []],
  ["require variable arg", "ts", "const r = require(x);", [], [], []],
  ["require concatenated", "ts", "const r = require(\"a\" + \"b\");", [], [], []],
  ["require conditional", "ts", "if (x) { require(\"cond\"); }", [], [], [["require-call","cond"]]],
  ["require shadowed param", "ts", "function f(require){ return require(\"shadow\"); }", [], [], [["require-call","shadow"]]],
  ["nested require", "ts", "function f() { return require(\"deep\"); }", [], [], [["require-call","deep"]]],
  ["source order", "ts", "require(\"z\"); import a from \"y\"; const p = import(\"x\");", [], [["import-statement","y"],["dynamic-import","x"]], [["require-call","z"],["import-statement","y"],["dynamic-import","x"]]],
  ["duplicates kept", "ts", "import a from \"dup\"; import b from \"dup\"; require(\"dup\");", [], [["import-statement","dup"],["import-statement","dup"]], [["import-statement","dup"],["import-statement","dup"],["require-call","dup"]]],
  ["import and require same", "ts", "import a from \"same\"; const r = require(\"same\");", [], [["import-statement","same"]], [["import-statement","same"],["require-call","same"]]],
  ["js loader", "js", "import a from \"m15\"; export const b = 1;", ["b"], [["import-statement","m15"]], [["import-statement","m15"]]],
  ["tsx no jsx used", "tsx", "import React from \"react\"; export const x = 1;", ["x"], [["import-statement","react"]], [["import-statement","react"]]],
  ];
  const pair = (list) => list.map((x) => [x.kind, x.path]);
  let mismatched = 0;
  for (const [name, loader, src, wantExports, wantImports, wantScanImports] of T) {
    const s = bunScan(src, loader);
    const i = bunScanImports(src, loader);
    const bad =
      JSON.stringify(s.exports) !== JSON.stringify(wantExports) ||
      JSON.stringify(pair(s.imports)) !== JSON.stringify(wantImports) ||
      JSON.stringify(pair(i)) !== JSON.stringify(wantScanImports);
    if (bad) {
      mismatched++;
      console.log("     " + name + ": exports=" + JSON.stringify(s.exports) + " imports=" + JSON.stringify(pair(s.imports)) + " scanImports=" + JSON.stringify(pair(i)));
      console.log("     " + " ".repeat(name.length) + "  want " + JSON.stringify(wantExports) + " / " + JSON.stringify(wantImports) + " / " + JSON.stringify(wantScanImports));
    }
  }
  ok(mismatched === 0, T.length + " scan/scanImports cases match real Bun byte-for-byte");

  // The two divergences, asserted so they cannot drift silently.
  //
  // 1) scan() drops require-call, scanImports() drops require-resolve. Spelled
  //    out separately because it is the single most surprising thing here.
  ok(bunScan('require("x");', "ts").imports.length === 0, "scan() reports NO import for a bare require() — as Bun does");
  ok(JSON.stringify(bunScanImports('require("x");', "ts")) === '[{"kind":"require-call","path":"x"}]', "…while scanImports() reports it");
  ok(JSON.stringify(bunScan('require.resolve("x");', "ts").imports) === '[{"kind":"require-resolve","path":"x"}]', "scan() reports require.resolve()");
  ok(bunScanImports('require.resolve("x");', "ts").length === 0, "…while scanImports() does NOT — the exact inverse");

  // 2) Real Bun's automatic JSX runtime injects `react/jsx-runtime` + `react`
  //    require-calls into scanImports() for a file that uses JSX. Ours emits
  //    classic React.createElement, which introduces no specifier at all, so
  //    they are absent. Reporting them would name a module Vivari never loads.
  const jsx = bunScanImports('import React from "react";\nexport const A = () => <div/>;', "tsx");
  ok(JSON.stringify(pair(jsx)) === '[["import-statement","react"]]', "a JSX file reports only its own import, not Bun's injected jsx-runtime pair");

  // Source order is preserved and duplicates are NOT collapsed, both of which a
  // dependency crawler depends on.
  ok(
    JSON.stringify(pair(bunScanImports('require("z"); import a from "y"; const p = import("x");', "ts"))) ===
      '[["require-call","z"],["import-statement","y"],["dynamic-import","x"]]',
    "the three kinds interleave in SOURCE order, not kind order",
  );
  ok(bunScanImports('import a from "d"; import b from "d";', "ts").length === 2, "a specifier imported twice is reported twice");

  // exports is sorted by code unit, which is Bun's order and not the source's.
  ok(JSON.stringify(bunScan("export const b=1; export const A=2;", "ts").exports) === '["A","b"]', "exports are sorted, uppercase first");

  // Argument and loader validation, in Bun's own words.
  for (const [method, fn] of [["scan", bunScan], ["scanImports", bunScanImports]]) {
    let msg = "";
    try { fn(undefined, "ts"); } catch (e) { msg = e.message; }
    ok(msg === "Expected code to be a string or Uint8Array for '" + method + "'.", method + "() names the accepted argument types exactly as Bun does");
  }
  ok(JSON.stringify(bunScan(new TextEncoder().encode('import a from "b";'), "ts").imports) === '[{"kind":"import-statement","path":"b"}]', "a Uint8Array source is decoded, not rejected");
  {
    let e1 = null, e2 = null;
    try { bunScan("", "nope"); } catch (e) { e1 = e; }
    try { bunScan("", "css"); } catch (e) { e2 = e; }
    ok(e1 && e1.code === "ERR_INVALID_ARG_TYPE" && /^invalid loader - must be js, jsx, tsx, ts, css/.test(e1.message), "an unknown loader name is refused with Bun's list");
    ok(e2 && e2.code === "ERR_INVALID_ARG_TYPE" && e2.message === "only JavaScript-like loaders supported for now", "a real but non-JS loader is refused separately, as Bun's constructor does");
  }
}

console.log("== the type stripper and module clauses ==");
{
  // Three bugs the scan work above uncovered, each of which corrupted ordinary
  // TypeScript long before Bun.Transpiler existed. They are checked here by
  // asserting the OUTPUT PARSES, which is what the previous check for this area
  // never did — it regex-matched for absent type names, so a statement stripped
  // down to a dangling ` from "./foo";` passed it.
  const parses = (src) => {
    try { new Function(transpileTypeScript(src, "t.ts").replace(/^\s*(import|export)\b.*$/gm, "")); return true; }
    catch { return false; }
  };
  const T = (src) => transpileTypeScript(src, "t.ts");

  // 1) `import type { X } from "m"` — dropStatement() ended the statement at the
  //    specifier list's `}`, stranding ` from "m";`. A SyntaxError at load.
  ok(!/from/.test(T('import type { Foo } from "./foo";\nconst a=1;')), "a braced type-only import is removed whole, not down to a dangling `from`");
  ok(!/from/.test(T('import type { Foo } from "./foo"\nconst a=1')), "…including without the semicolon, where ASI ends the statement");
  ok(!/from/.test(T('export type { Qux } from "./qux";\nconst a=1;')), "…and the `export type … from` form");
  ok(/const a=1/.test(T('import type { Foo } from "./foo";\nconst a=1;')), "…and the statement after it survives");

  // 2) `import * as ns from "m"` — the `as` rule treated a namespace RENAME as a
  //    cast and ate it, leaving `import * ;`. Every `import * as fs from "fs"`
  //    in a .ts file failed to load.
  ok(T('import * as ns from "m";') === 'import * as ns from "m";', "a namespace import is passed through untouched");
  ok(T('export * as ns from "m";') === 'export * as ns from "m";', "…as is `export * as`");

  // 3) `export { a, b as c }` — the same rule silently dropped the rename, so the
  //    importer got undefined and the process still exited 0. The worst shape a
  //    bug can take here, and the reason clauses are now copied verbatim.
  ok(T("const a=1,b=2; export { a, b as c };") === "const a=1,b=2; export { a, b as c };", "an export rename survives — it is a rename, not a cast");
  ok(T('import { a as b } from "m";') === 'import { a as b } from "m";', "…and an import rename");

  // Copying a clause verbatim means knowing exactly where it ENDS, and the
  // side-effect form is the one with no `from` and no clause to close. Without a
  // case of its own the end-of-statement search runs to the next `;` in the file
  // and swallows everything between, so the statement after it keeps its types
  // and never gets stripped. Every clause form is checked without a semicolon.
  for (const head of ['import "m"', 'import a from "m"', 'import * as ns from "m"', 'import { a } from "m"', "export { a }", 'export * from "m"']) {
    ok(!/: number/.test(T(head + "\nconst z: number = 1")), "`" + head + "` without a semicolon does not swallow the statement after it");
  }
  ok(T('import "m"') === 'import "m"', "…and a side-effect import as the last line of a file does not run off the end");

  // The cast rule itself still applies everywhere it should.
  ok(!/as/.test(T("const x = y as Foo;")), "`as` is still stripped in an expression");
  ok(!/satisfies/.test(T("const x = y satisfies Foo;")), "`satisfies` too");
  ok(/class X/.test(T("export default class X { private a = 1; }")) && !/private/.test(T("export default class X { private a = 1; }")), "`export default class` is still stripped — only clause forms are exempt");
  ok(parses("export const a = (b as number);"), "`export const` with a cast is still ordinary code");
}

// ---------------------------------------------------------------------------
// The type stripper and the shapes real code is actually written in.
//
// Everything below was found by writing the Bun templates — ordinary TypeScript
// that any user would type — rather than by reading the stripper. Each one
// produced a file that failed to PARSE, so the failure mode was a SyntaxError
// pointing at a line the author had no reason to suspect.
// ---------------------------------------------------------------------------
{
  console.log("\n== the type stripper, on shapes real code uses ==");
  const T = (src) => transpileTypeScript(src, "x.ts");
  const parses = (src) => { try { new Function(T(src)); return true; } catch { return false; } };
  // Left byte-for-byte alone: these are plain JavaScript, not types.
  const untouched = (src, why) => ok(T(src).replace(/\s+/g, " ").trim() === src.replace(/\s+/g, " ").trim(), why);

  // 1) An annotation inside an ARROW body. `enclosingContext()` classified a `{`
  //    that follows `=>` as an object literal, so every declaration inside an
  //    arrow looked like a property value and kept its type. A `{` after an arrow
  //    is the body, always — returning an object literal needs `() => ({…})`.
  //    The same declaration inside a `function` body or a bare block was fine,
  //    which is why this survived: the broken case is the one modern code uses.
  ok(!/: Cart/.test(T('describe("Cart", () => { let cart: Cart; });')), "an annotation inside an arrow body is stripped");
  ok(!/: string/.test(T("f(() => { const a: string = x; });")), "…including a const with an initialiser");
  ok(!/: T\b/.test(T("a(() => { b(() => { let z: T; }); });")), "…and nested two arrows deep");
  untouched("const f = () => ({ a: 1, b: cond ? 2 : 3 });", "an arrow RETURNING an object literal is still untouched");
  untouched("const o = { run: () => { let q = 1; } };", "…and an arrow that is an object's property value");

  // 2) An object type nested inside `<…>`. skipType() only counted braces at
  //    depth 0, so the `}` of `Array<{ detail: string }>` looked unbalanced, the
  //    type "ended" there, and the tail `}>;` was left behind as live code.
  ok(parses("const rows = q.all() as Array<{ detail: string }>;"), "a cast to a generic containing an object type");
  ok(parses("const p: Promise<{ a: number }> = go();"), "…and the same as an annotation");

  // 3) The generic-vs-less-than heuristic rejected ANY `{` inside the angles, so
  //    these were not recognised as type arguments at all and were left in place
  //    as `<` and `>` operators.
  ok(parses("const q = db.query<{ n: number }, []>('S').get();") && !/[<>]/.test(T("const q = db.query<{ n: number }, []>('S').get();")), "type arguments containing an object type are removed");
  ok(!/[<>]/.test(T("const m = new Map<string, { v: number }>();")), "…including on a constructor call");
  // The reason the `{` was rejected in the first place — do not regress it.
  untouched("if (a < b) { go(); }", "a comparison followed by a block is still not a generic");
  untouched("for (let i = 0; i < n; i++) { s += i; }", "…nor a for-loop condition");

  // 4) `as`/`satisfies` as a PROPERTY name. The guard here claimed to require an
  //    expression before the keyword but only tested `p >= 0`, which is true of
  //    any token — including the `.` of a member access. So the method call was
  //    eaten along with its "type". `satisfies` is the name of Bun's own semver
  //    API, so this broke `Bun.semver.satisfies(…)`.
  untouched('semver.satisfies("1.2.3", "^1.0.0")', "a method named `satisfies` is a call, not a cast");
  untouched('q.as("alias").from("t")', "…and one named `as`");
  untouched("const o = { satisfies: 1, as: 2 };", "…and both as object keys");
  ok(!/\bas\b/.test(T("const x = y as string;")), "a real `as` cast is still stripped");
  ok(!/satisfies/.test(T("const c = { a: 1 } satisfies Config;")), "…and a real `satisfies`");
}

// ---------------------------------------------------------------------------
// The bare `bun` module: `import { $, file, write } from "bun"`.
// ---------------------------------------------------------------------------
{
  console.log("\n== the `bun` module ==");
  // Registered alongside bun:test / bun:sqlite / …, and it is the SAME object as
  // the global rather than a curated re-export. Checked against a real binary:
  // `import * as ns from "bun"` has exactly the `Bun` global's key set, the same
  // object per key, and no default export.
  const rt = createBunRuntime({
    process: { env: {}, argv: ["bun", "/app/x.ts"], cwd: () => "/app" },
    Buffer,
    require: nodeRequire,
  });
  const mod = rt.modules.bun;
  ok(mod === rt.Bun, "`bun` resolves to the Bun global itself");
  ok(typeof mod.$ === "function" && typeof mod.file === "function" && typeof mod.write === "function", "…so $, file and write are all importable from it");
  ok(!("default" in mod), "there is no default export to import by mistake");
  for (const name of ["serve", "spawn", "hash", "password", "Glob", "semver", "YAML", "TOML", "Transpiler", "build"])
    ok(typeof mod[name] !== "undefined", "`" + name + "` is reachable through the module");
  ok(rt.modules["bun:test"] && rt.modules["bun:sqlite"], "the bun:* modules are still registered alongside it");
}

// ---------------------------------------------------------------------------
// Bun.sha, Bun.CSRF, Bun.dns and the Zstandard names.
// ---------------------------------------------------------------------------
{
  console.log("\n== Bun.sha is SHA-2 512/256 ==");
  const { Bun, Worker: BunWorker } = createBunRuntime({
    process: { env: {}, argv: ["bun", "/app/x.ts"], cwd: () => "/app" },
    Buffer,
    require: nodeRequire,
  });

  // Pinned to NIST FIPS 180-4's worked SHA-512/256 example rather than to our own
  // output, which would pass against any self-consistent wrong algorithm. The
  // second assertion is the one that matters: reading "sha" as SHA-512 and
  // truncating gives a different digest, and nothing about the shape would say so.
  const ABC = "53048e2681941ef99b2e29b76b4c7dabe4c2d0c634fc6d46e0e2f13107e7af23";
  ok(Bun.sha("abc", "hex") === ABC, "Bun.sha('abc') matches the NIST SHA-512/256 vector");
  const sha512Truncated = nodeRequire("crypto").createHash("sha512").update("abc").digest("hex").slice(0, 64);
  ok(Bun.sha("abc", "hex") !== sha512Truncated, "…and is NOT truncated SHA-512, which the name invites");
  ok(Bun.sha("abc").length === 32, "no encoding gives 32 raw bytes");
  ok(Bun.sha(Buffer.from("abc"), "hex") === ABC, "a Buffer hashes the same as the string");
  ok(Bun.sha("abc", "base64") === Buffer.from(ABC, "hex").toString("base64"), "base64 is the same digest, re-encoded");
  {
    const into = new Uint8Array(32);
    const returned = Bun.sha("abc", into);
    ok(returned === into && Buffer.from(into).toString("hex") === ABC, "a TypedArray is filled in place and returned");
    let tooSmall = "";
    try { Bun.sha("abc", new Uint8Array(31)); } catch (e) { tooSmall = e.message; }
    ok(/at least 32 bytes/.test(tooSmall), "a short TypedArray is refused, not silently truncated");
  }

  console.log("\n== Bun.CSRF ==");
  // The token format is ours (Bun does not document its own), so these checks pin
  // BEHAVIOUR, not bytes: what verifies, what does not, and which failures are a
  // false rather than a throw.
  const token = Bun.CSRF.generate("s3cret", { sessionId: "user-1" });
  ok(typeof token === "string" && token.length > 0, "generate() returns a string token");
  ok(Bun.CSRF.verify(token, { secret: "s3cret", sessionId: "user-1" }) === true, "the token verifies with the same secret and session");
  ok(Bun.CSRF.verify(token, { secret: "s3cret", sessionId: "user-2" }) === false, "a different session does not verify — the binding is real");
  ok(Bun.CSRF.verify(token, { secret: "wrong", sessionId: "user-1" }) === false, "a different secret does not verify");
  ok(Bun.CSRF.verify(token, { secret: "s3cret" }) === false, "a session-bound token does not verify unbound");
  {
    const bare = Bun.CSRF.generate("s3cret");
    ok(Bun.CSRF.verify(bare, { secret: "s3cret" }) === true, "an unbound token verifies unbound");
    ok(Bun.CSRF.verify(bare, { secret: "s3cret", sessionId: "user-1" }) === false, "…and fails when a session IS supplied, as Bun documents");
  }
  {
    // Flip a bit the MAC actually covers, and check that it landed. Flipping the
    // last CHARACTER does not qualify: the token is 64 bytes of base64url, so its
    // final character carries two significant bits and four that decode to
    // nothing. `A`→`B` moves only the latter, and one token in four ends in `A`,
    // which is a check that failed 25% of the time for no reason of the code's.
    const raw = Buffer.from(token, "base64url");
    const flipped = Buffer.from(raw);
    flipped[flipped.length - 1] ^= 1;
    const tampered = flipped.toString("base64url");
    ok(!Buffer.from(tampered, "base64url").equals(raw), "the tamper reached the bytes the MAC is over");
    ok(Bun.CSRF.verify(tampered, { secret: "s3cret", sessionId: "user-1" }) === false, "a tampered token does not verify");
  }
  ok(Bun.CSRF.verify("not-a-token", { secret: "s3cret" }) === false, "junk is a false, not a throw — it arrives from the network");
  ok(Bun.CSRF.verify("", { secret: "s3cret" }) === false, "so is an empty token");
  ok(Bun.CSRF.verify(token + "AA", { secret: "s3cret", sessionId: "user-1" }) === false, "appended bytes do not verify: the length check is exact");
  // Deterministic because the windows are half-open — see the note in
  // bun-crypto.js. With an inclusive bound these two pass or fail on clock tick.
  ok(Bun.CSRF.verify(Bun.CSRF.generate("s3cret", { expiresIn: 0 }), { secret: "s3cret" }) === false, "expiresIn: 0 is expired immediately, every time");
  ok(Bun.CSRF.verify(Bun.CSRF.generate("s3cret"), { secret: "s3cret", maxAge: 0 }) === false, "maxAge: 0 rejects a brand-new token, every time");
  {
    const hex = Bun.CSRF.generate("s3cret", { encoding: "hex", algorithm: "sha512" });
    ok(/^[0-9a-f]+$/.test(hex), "encoding: hex really is hex");
    ok(Bun.CSRF.verify(hex, { secret: "s3cret", encoding: "hex", algorithm: "sha512" }) === true, "…and round-trips with the matching options");
    ok(Bun.CSRF.verify(hex, { secret: "s3cret", algorithm: "sha512" }) === false, "a mismatched encoding does not verify");
    ok(Bun.CSRF.verify(hex, { secret: "s3cret", encoding: "hex" }) === false, "a mismatched algorithm does not verify");
  }
  ok(Bun.CSRF.verify(Bun.CSRF.generate()) === true, "the per-thread default secret round-trips when neither call names one");
  {
    // Pins the DEFAULTS, which is where this first went wrong: taking the head of
    // each allowed list gave blake2b256/base64 instead of Bun's sha256/base64url.
    // Both still round-trip against themselves, so only naming the expected
    // default explicitly catches it.
    const dflt = Bun.CSRF.generate("s3cret");
    ok(Bun.CSRF.verify(dflt, { secret: "s3cret", algorithm: "sha256", encoding: "base64url" }) === true, "the defaults really are sha256 + base64url");
    ok(Bun.CSRF.verify(dflt, { secret: "s3cret", algorithm: "sha512" }) === false, "…and not some other algorithm that would also self-verify");
    ok(!/[+/=]/.test(dflt), "a default token is base64url, so it is URL- and form-safe");
  }
  {
    // An unknown algorithm is a bug in the caller, so it throws on BOTH sides.
    // Returning false would present a broken deployment as a flood of "invalid
    // token" — the exact confusion this API is supposed to remove.
    let g = "", v = "";
    try { Bun.CSRF.generate("s", { algorithm: "md5" }); } catch (e) { g = e.message; }
    try { Bun.CSRF.verify(token, { algorithm: "md5" }); } catch (e) { v = e.message; }
    ok(/algorithm must be one of/.test(g) && /algorithm must be one of/.test(v), "an unsupported algorithm throws on generate and verify");
  }

  console.log("\n== Worker: what can be judged without a thread host ==");
  // The Worker itself needs a kernel, so the round trip lives in the kernel tier.
  // What belongs HERE is the part that is decided before any thread is spawned:
  // which specifiers are refused, and with which of the two vocabularies.
  {
    ok(typeof Bun.isMainThread === "boolean", "Bun.isMainThread is a boolean");
    ok(Bun.isMainThread === true, "…and true on the main thread");
    const refuse = (spec) => {
      try { new BunWorker(spec); return "no throw"; } catch (e) { return e.message; }
    };
    const blob = refuse("blob:0f8b");
    ok(/is not implemented in the Vivari shim/.test(blob), "blob: uses the not-YET wording: materialising the bytes to a temp file would close it");
    // Guards the REASON, not just the refusal. The first version of this message
    // blamed a missing URL.createObjectURL; guest code turns out to have one, so
    // the message named a cause that was not true.
    ok(/started by the kernel from a file/.test(blob), "…and gives the real reason: a worker is spawned from a file");
    const http = refuse("https://example.com/w.js");
    ok(/is not supported in Vivari \(browser sandbox\)/.test(http), "an http: URL uses the CANNOT-EVER wording: a worker here runs a file, not a URL");
    // `smol` and `preload` are the two options that cannot be honoured. They are
    // treated differently ON PURPOSE: smol is a JSC heap-size hint with no
    // observable semantics, so ignoring it changes nothing a program can detect,
    // while preload changes WHICH CODE RUNS and so must not be quietly dropped.
    let pre = "";
    try { new BunWorker("./w.ts", { preload: "./x.js" }); } catch (e) { pre = e.message; }
    ok(/preload.*is not implemented in the Vivari shim/.test(pre), "preload is refused rather than dropped: " + JSON.stringify(pre.slice(0, 48)));
    ok(/import the module at the top/i.test(pre), "…and the refusal names the one-line workaround");
  }

  console.log("\n== Bun.dns: one refusal, two honest no-ops ==");
  ok(Bun.dns.prefetch("example.com", 443) === undefined, "prefetch is inert and returns void — an advisory hint must not throw");
  {
    const stats = Bun.dns.getCacheStats();
    const keys = Object.keys(stats).sort().join(",");
    ok(keys === "cacheHitsCompleted,cacheHitsInflight,cacheMisses,errors,size,totalCount", "getCacheStats has Bun's exact shape: " + keys);
    ok(Object.values(stats).every((v) => v === 0), "…reporting a cache that really is empty, not invented numbers");
  }
  {
    let msg = "";
    try { Bun.dns.lookup("example.com"); } catch (e) { msg = e.message; }
    ok(/not supported in Vivari \(browser sandbox\)/.test(msg), "lookup uses the CANNOT-EVER wording, not the not-yet one");
    ok(/DNS-over-HTTPS/.test(msg), "…and names the alternative that does work from a page");
  }

  console.log("\n== Zstandard is absent, and says so ==");
  for (const name of ["zstdCompressSync", "zstdDecompressSync", "zstdCompress", "zstdDecompress"]) {
    ok(typeof Bun[name] === "function", "Bun." + name + " exists, so feature detection sees a function");
    let msg = "";
    try { Bun[name]("x"); } catch (e) { msg = e.message; }
    // The wording distinction is load-bearing (see bun-unsupported.js's header):
    // zstd is a GAP someone can close, not a wall like Bun.dns.lookup.
    ok(/is not implemented in the Vivari shim/.test(msg), "Bun." + name + " uses the not-YET wording");
    ok(/packages\/codec/.test(msg), "…and names where the engine would go");
  }

  console.log("\n== node:zlib's zstd handles fail with a sentence, not a TypeError ==");
  {
    // The Bun names above are only half the story: lib/zlib.js exports the zstd
    // family unconditionally, so anything doing
    // `typeof zlib.zstdCompressSync === "function"` takes that branch. Before
    // these handles existed the branch died on "binding.ZstdCompress is not a
    // constructor" from inside Node's own source.
    const binding = createZlibBinding({ makeZStream: null, process });
    for (const cls of ["ZstdCompress", "ZstdDecompress"]) {
      ok(typeof binding[cls] === "function", "the binding exposes " + cls);
      let msg = "";
      try { new binding[cls](); } catch (e) { msg = e.message; }
      ok(msg.indexOf("is not implemented in Vivari") !== -1 && msg.indexOf("Zstandard") !== -1, cls + " names the missing Zstandard engine");
      ok(/brotli/.test(msg), "…and points at the codecs that do work here");
    }
    // Brotli is no longer in that list — it has an engine now, so its handles
    // construct. Their round trip is spike-zlib-brotli.mjs's business; what this
    // holds is that they stopped being the "explain yourself" case, which is the
    // half of the change a reader of the paragraph above would otherwise miss.
    for (const cls of ["BrotliEncoder", "BrotliDecoder"]) {
      ok(typeof binding[cls] === "function", "the binding exposes " + cls);
      let threw = "";
      try { new binding[cls](8); } catch (e) { threw = e.message; }
      ok(threw === "", cls + " constructs rather than refusing" + (threw ? ": " + threw : ""));
    }
  }
}

console.log("== Bun.MD4/MD5/SHA1/SHA224/SHA256/SHA384/SHA512/SHA512_256 ==");
{
  // Every expected value here was produced by bun-1.3.14 on linux-x64, not by this
  // code: a digest that only agrees with itself is exactly what a broken hasher
  // also produces. The lifecycle assertions matter as much as the bytes — these
  // classes are CONSUMED by digest() where CryptoHasher resets, and inheriting the
  // reset would have been invisible here and fatal on the first real bun run.
  const Bun = freshBun();

  const HELLO = {
    MD4: "866437cb7a794bce2b727acc0362ee27",
    MD5: "5d41402abc4b2a76b9719d911017c592",
    SHA1: "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d",
    SHA224: "ea09ae9cc6768c50fcee903ed054556e5bfc8347907f12598aa24193",
    SHA256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    SHA384: "59e1748777448c69de6b800d7a33bbfb9ff1b463e44354c3553bcdb9c666fa90125a3c79f90397bdf5f6a13de828684f",
    SHA512: "9b71d224bd62f3785d96d46ad3ea3d73319bfbc2890caadae2dff72519673ca72323c3d99ba5c11d7c7acc6e14b8c5da0c4663475c2e5c3adef46f73bcdec043",
    SHA512_256: "e30d87cfa2a75db545eac4d61baf970366a8357c7f72fa95b52d0accb698f13a",
  };
  const BYTE_LENGTH = { MD4: 16, MD5: 16, SHA1: 20, SHA224: 28, SHA256: 32, SHA384: 48, SHA512: 64, SHA512_256: 32 };

  // This tier has no Wasm codec, so the digests come from the HOST's OpenSSL, and a
  // modern one refuses md4 outright ("digital envelope routines::unsupported").
  // Vivari's own codec does implement it (packages/crypto, RustCrypto's md4 crate),
  // so the vector is checked in the kernel tier instead of being quietly dropped —
  // skipping in silence is how an algorithm ends up untested everywhere.
  const hostHashes = new Set(nodeRequire("crypto").getHashes());
  const HOST_ALGO = { MD4: "md4", MD5: "md5", SHA1: "sha1", SHA224: "sha224", SHA256: "sha256", SHA384: "sha384", SHA512: "sha512", SHA512_256: "sha512-256" };

  for (const [name, expected] of Object.entries(HELLO)) {
    const Cls = Bun[name];
    ok(typeof Cls === "function", `Bun.${name} exists`);
    if (typeof Cls !== "function") continue;
    if (!hostHashes.has(HOST_ALGO[name])) {
      console.log(`  ~ Bun.${name}: no ${HOST_ALGO[name]} in this host's OpenSSL — bytes checked in the kernel tier (spike-bun)`);
      ok(Cls.byteLength === BYTE_LENGTH[name], `Bun.${name}.byteLength is ${BYTE_LENGTH[name]}`);
      ok(Cls.name === name, `the class is named ${name}, not a factory-local name`);
      continue;
    }
    ok(Cls.hash("hello", "hex") === expected, `Bun.${name}.hash("hello","hex") matches bun-1.3.14`);
    ok(new Cls().update("hello").digest("hex") === expected, `…and the instance path agrees`);
    ok(Cls.byteLength === BYTE_LENGTH[name], `Bun.${name}.byteLength is ${BYTE_LENGTH[name]}`);
    ok(new Cls().byteLength === BYTE_LENGTH[name], `…and the instance reports it too (undeclared in the types, real in the binary)`);
    ok(Cls.name === name, `the class is named ${name}, not a factory-local name`);
  }

  // Split updates must equal one update: this is the property the buffering
  // implementation could break without any single-shot vector noticing.
  const split = new Bun.SHA256();
  split.update("he");
  split.update("llo");
  ok(split.digest("hex") === HELLO.SHA256, "two updates hash the same as one");

  ok(new Bun.SHA256().digest("hex") === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "an untouched hasher digests the empty input rather than throwing");
  ok(Object.prototype.toString.call(new Bun.SHA256().update("x").digest()) === "[object Uint8Array]",
    "digest() with no argument returns a Uint8Array");
  const chained = new Bun.SHA256();
  ok(chained.update("a") === chained, "update() returns this");

  // The lifecycle, with Bun's own two messages.
  const spent = new Bun.SHA256();
  spent.update("hello");
  spent.digest("hex");
  let updateErr = "";
  try { spent.update("hello"); } catch (e) { updateErr = e.message; }
  ok(updateErr === "SHA256 hasher already digested, create a new instance to update",
    "update after digest throws Bun's message, naming the class");
  let digestErr = "";
  try { spent.digest("hex"); } catch (e) { digestErr = e.message; }
  ok(digestErr === "SHA256 hasher already digested, create a new instance to digest again",
    "…and so does a second digest");
  // The trap this guards: CryptoHasher DOES reset, and these must not.
  const reusable = new Bun.CryptoHasher("sha256");
  reusable.update("hello");
  reusable.digest("hex");
  ok(reusable.update("hello").digest("hex") === HELLO.SHA256,
    "…while a plain CryptoHasher still resets and is reusable (the two differ on purpose)");

  // Input handling, all measured against the binary.
  ok(Bun.SHA256.hash(new TextEncoder().encode("hello"), "hex") === HELLO.SHA256, "a typed array hashes");
  ok(Bun.SHA256.hash(new TextEncoder().encode("hello").buffer, "hex") === HELLO.SHA256, "an ArrayBuffer hashes");
  ok(Bun.SHA256.hash(Buffer.from("hello"), "hex") === HELLO.SHA256, "a Buffer hashes");
  let badInput = "";
  try { new Bun.SHA256().update(42); } catch (e) { badInput = e.message; }
  ok(badInput === "expected blob or string or buffer", "a number is refused with Bun's wording");
  let shortInto = "";
  try { Bun.SHA256.hash("hello", new Uint8Array(4)); } catch (e) { shortInto = e.message; }
  ok(shortInto === "TypedArray must be at least 32 bytes", "a short hashInto is refused with Bun's wording");
  const into = new Uint8Array(32);
  Bun.SHA256.hash("hello", into);
  ok(Buffer.from(into).toString("hex") === HELLO.SHA256, "hashInto is filled in place");
  ok(new Bun.SHA256().update("hello").digest("base64url") === "LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ",
    "digest('base64url') matches the binary");
}

console.log("== Bun.randomUUIDv5 is a real RFC 9562 v5 ==");
{
  // Two independent oracles agree on these: bun-1.3.14, and Python's uuid.uuid5
  // (an implementation nobody here wrote). Self-consistency would prove nothing —
  // swapping the namespace and name hashes just as deterministically, and the ids
  // only stop matching once they meet a system that did it right.
  const Bun = freshBun();
  ok(Bun.randomUUIDv5("www.example.com", "dns") === "2ed6657d-e927-568b-95e1-2665a8aea6a2", "dns namespace vector");
  ok(Bun.randomUUIDv5("python.org", "dns") === "886313e1-3b8a-5372-9b90-0c9aee199e5d", "…and a second dns vector");
  ok(Bun.randomUUIDv5("www.example.com", "url") === "b63cdfa4-3df9-568e-97ae-006c5b8fd652", "url namespace vector");
  ok(Bun.randomUUIDv5("1.3.6.1", "oid") === "1447fa61-5277-5fef-a9b3-fbc6e44f4af3", "oid namespace vector");
  ok(Bun.randomUUIDv5("CN=x", "x500") === "955bb643-faf8-5f69-a3de-891b89fea215", "x500 namespace vector");
  ok(Bun.randomUUIDv5("", "dns") === "4ebd0208-8328-5d69-8c44-ec50939c0967", "the empty name is a name");

  const id = Bun.randomUUIDv5("x", "dns");
  ok(id[14] === "5", "the version nibble is 5");
  ok("89ab".includes(id[19]), "the variant is RFC 4122");
  ok(Bun.randomUUIDv5("a", "dns") === Bun.randomUUIDv5("a", "dns"), "same name + namespace is the same id, always");
  ok(Bun.randomUUIDv5("a", "dns") !== Bun.randomUUIDv5("a", "url"), "…and the namespace actually participates");

  ok(Bun.randomUUIDv5("x", "6ba7b810-9dad-11d1-80b4-00c04fd430c8") === "05b16a01-46c6-56dd-bd6e-c6dfb4a1427a",
    "an explicit namespace UUID works");
  ok(Bun.randomUUIDv5("x", "6BA7B810-9DAD-11D1-80B4-00C04FD430C8") === "05b16a01-46c6-56dd-bd6e-c6dfb4a1427a",
    "…case-insensitively");
  ok(Bun.randomUUIDv5("x", "DNS") === "05b16a01-46c6-56dd-bd6e-c6dfb4a1427a", "the aliases are case-insensitive too");
  ok(Bun.randomUUIDv5("www.example.com", "dns", "base64") === "LtZlfeknVouV4SZlqK6mog==", "base64 encoding");
  ok(Bun.randomUUIDv5("www.example.com", "dns", "base64url") === "LtZlfeknVouV4SZlqK6mog", "base64url encoding");
  const buf = Bun.randomUUIDv5("www.example.com", "dns", "buffer");
  ok(Buffer.isBuffer(buf) && buf.length === 16 && buf.toString("hex") === "2ed6657de927568b95e12665a8aea6a2",
    "buffer encoding gives the same 16 bytes");
  ok(Bun.randomUUIDv5(new TextEncoder().encode("www.example.com"), "dns") === "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    "the name may be bytes");
  ok(Bun.randomUUIDv5("x", new Uint8Array(16).fill(1)) === "8ac90834-7dbc-53b0-b3c0-089c9265830f",
    "…and the namespace may be 16 raw bytes");

  // Bun's exact refusals: a caller who trips one should be able to search for it.
  const refuses = (label, fn, expected) => {
    let msg = "";
    try { fn(); } catch (e) { msg = e.message; }
    ok(msg === expected, `${label} -> "${expected}"` + (msg === expected ? "" : ` (got "${msg}")`));
  };
  refuses("no namespace", () => Bun.randomUUIDv5("x"), 'The "namespace" argument must be specified');
  refuses("a namespace that is not a uuid", () => Bun.randomUUIDv5("x", "nope"), "Invalid UUID format for namespace");
  refuses("urn:uuid: prefix", () => Bun.randomUUIDv5("x", "urn:uuid:6ba7b810-9dad-11d1-80b4-00c04fd430c8"), "Invalid UUID format for namespace");
  refuses("undashed hex", () => Bun.randomUUIDv5("x", "6ba7b8109dad11d180b400c04fd430c8"), "Invalid UUID format for namespace");
  refuses("15 raw bytes", () => Bun.randomUUIDv5("x", new Uint8Array(15)), "Namespace must be exactly 16 bytes");
  refuses("a numeric name", () => Bun.randomUUIDv5(123, "dns"), 'The "name" argument must be of type string or BufferSource');
  refuses("a bogus encoding", () => Bun.randomUUIDv5("x", "dns", "rot13"), "Encoding must be one of base64, base64url, hex, or buffer");
}

console.log("== Bun.embeddedFiles / enableANSIColors / unsafe, and two loud refusals ==");
{
  const Bun = freshBun();
  ok(Array.isArray(Bun.embeddedFiles) && Bun.embeddedFiles.length === 0,
    "Bun.embeddedFiles is the empty array a non-compiled run has");
  ok(Bun.embeddedFiles === Bun.embeddedFiles, "…one shared array, as in the binary (not a fresh one per read)");

  // NO_COLOR beats FORCE_COLOR beats isatty — the order the binary applies.
  const colorBun = (env, isTTY) =>
    createBunRuntime({
      process: { env, argv: ["bun"], cwd: () => "/", stdout: { isTTY }, stderr: process.stderr, stdin: process.stdin },
      Buffer,
      require: nodeRequire,
    }).Bun;
  ok(colorBun({}, false).enableANSIColors === false, "no tty, no env: colours off");
  ok(colorBun({}, true).enableANSIColors === true, "a tty turns them on");
  ok(colorBun({ FORCE_COLOR: "1" }, false).enableANSIColors === true, "FORCE_COLOR turns them on without a tty");
  ok(colorBun({ NO_COLOR: "1", FORCE_COLOR: "1" }, true).enableANSIColors === false, "NO_COLOR wins over both");

  ok(Bun.unsafe.arrayBufferToString(new Uint8Array([104, 101, 108, 108, 111])) === "hello",
    "unsafe.arrayBufferToString decodes 8-bit views");
  ok(Bun.unsafe.arrayBufferToString(new Uint8Array([0xff, 0xfe, 0x41])) === "\u00ff\u00feA",
    "…as latin1, so a high byte stays one character instead of becoming U+FFFD");
  ok(Bun.unsafe.arrayBufferToString(new Uint16Array([104, 105])) === "hi", "…and a Uint16Array decodes as UTF-16");
  ok(Bun.unsafe.arrayBufferToString(new TextEncoder().encode("hey").buffer) === "hey", "…an ArrayBuffer works too");
  let notBuffer = "";
  try { Bun.unsafe.arrayBufferToString("hey"); } catch (e) { notBuffer = e.message; }
  ok(notBuffer === "Expected an ArrayBuffer", "…and a string is refused with Bun's wording");
  ok(Bun.unsafe.gcAggressionLevel(2) === 0 && Bun.unsafe.gcAggressionLevel() === 2,
    "gcAggressionLevel returns the previous level and remembers the new one");

  for (const [name, needle] of [["generateHeapSnapshot", "heap"], ["openInEditor", "editor"]]) {
    ok(typeof Bun[name] === "function", `Bun.${name} is present, so a destructure still works`);
    let msg = "";
    try { Bun[name]("/tmp/x"); } catch (e) { msg = e.message; }
    ok(msg.includes(name) && msg.toLowerCase().includes(needle),
      `…and loud on call, naming the API and what is missing`);
  }
}

console.log("== the names that were absent entirely ==");
{
  // Thirteen properties real Bun has were not on our object at all, so a read gave
  // `undefined` — a VALUE, which nothing throws on. The mistake surfaced later and
  // somewhere else. Six of them are cheap and real; the rest belong to the
  // import-safe/call-loud catalogue and were skipping it.
  const Bun = freshBun();
  ok(typeof Bun.cwd === "string" && Bun.cwd.length > 0, "Bun.cwd is the working directory: " + JSON.stringify(Bun.cwd));
  // "" even while a server is running — checked against 1.3.6 rather than assumed,
  // because the plausible guess (the server's URL) is wrong.
  ok(Bun.origin === "", "Bun.origin is the empty string, as in a real bun process");
  ok(/^v\d+\.\d+\.\d+ \(.+\)$/.test(Bun.version_with_sha), "Bun.version_with_sha has Bun's shape: " + Bun.version_with_sha);
  ok(typeof Bun.fetch === "function" && Bun.fetch.name === "fetch", "Bun.fetch is a fetch function");
  ok(Bun.fetch !== globalThis.fetch, "…and is not identical to the global one, which is also true in Bun");
  ok(typeof Bun.fetch.preconnect === "function" && Bun.fetch.preconnect("https://x") === undefined,
    "…carrying preconnect, an advisory no-op here rather than a refusal");
  ok(typeof Bun.jest === "function" && typeof Bun.jest("f.test.ts").expect === "function", "Bun.jest(path) hands back the bun:test module");
  ok(Bun.shrink() === undefined, "Bun.shrink() is a no-op that returns undefined, as Bun's does");

  const msg = (fn) => { try { fn(); return ""; } catch (e) { return String((e && e.message) || e); } };
  const SANDBOX = "is not supported in Vivari (browser sandbox):";
  const SHIM = "is not implemented in the Vivari shim:";
  // The tier is the claim being made, and getting it wrong wastes real time: a pty
  // never can work here, while an Archive is only unwritten. S3 used to be on this
  // list at the SHIM tier for want of "a SigV4 signer plus a CORS policy" — it is
  // now real, and the sections at the end of this file are what replaced these
  // three rows.
  for (const [name, call, tier, phrase] of [
    ["postgres", () => Bun.postgres("postgres://x"), SANDBOX, "raw TCP socket"],
    ["Terminal", () => new Bun.Terminal(), SANDBOX, "pseudo-terminal"],
    // Bun.Archive was in this list and has graduated out of it — it is a real tar
    // codec now (builtins/bun-archive.js), gated by the sections at the end of
    // this file.
    ["registerMacro", () => Bun.registerMacro(1, () => {}), SHIM, "BUNDLE time"],
  ]) {
    let read = Bun, readThrew = false;
    try { for (const key of name.split(".")) read = read[key]; } catch { readThrew = true; }
    ok(!readThrew && typeof read === "function", "Bun." + name + " can be READ without throwing");
    const m = msg(call);
    ok(m.indexOf(tier) !== -1, "Bun." + name + " refuses at the right tier" + (m ? "" : " — IT DID NOT THROW"));
    ok(m.indexOf(phrase) !== -1, "…and says why: " + JSON.stringify(phrase));
  }
  ok(typeof Bun.FFI === "object" && typeof Bun.FFI.dlopen === "function", "Bun.FFI is the bun:ffi module, reachable off the global as it is in Bun");
}

console.log("== Bun.JSONC: JSON with comments, and NOT JSON5 ==");
{
  const Bun = freshBun();
  // Every expectation here was read off the 1.3 binary. The interesting ones are
  // the REFUSALS: JSON5 accepts NaN, Infinity, a leading + and unquoted keys, so
  // delegating this to the vendored JSON5 parser — the cheap implementation —
  // would have accepted files real Bun calls invalid.
  const parse = (src) => { try { return JSON.stringify(Bun.JSONC.parse(src)); } catch (e) { return "ERR:" + e.message; } };
  for (const [src, want, why] of [
    ['{ /*c*/ "a": 1, // line\n "b": [2,], }', '{"a":1,"b":[2]}', "comments and a trailing comma, which is what tsconfig.json is"],
    ["", "{}", "an empty file is an empty config, as in Bun — not a syntax error"],
    ['{"a":"// not a comment"}', '{"a":"// not a comment"}', "a comment marker inside a string is data"],
    ['{"a":0x10}', '{"a":16}', "hex, which Bun accepts and JSON does not"],
    ["{'a':'x'}", '{"a":"x"}', "single quotes"],
    ["42", "42", "a bare scalar is a document"],
  ]) {
    ok(parse(src) === want, "JSONC: " + why + " — " + JSON.stringify(src.slice(0, 34)));
  }
  for (const [src, phrase, why] of [
    ['{"a":NaN}', "Unexpected NaN", "NaN is rejected, though JSON5 would take it"],
    ['{"a":+1}', 'Unexpected "+"', "a leading + is rejected, though JSON5 would take it"],
    ["[1,,]", 'Unexpected ","', "a hole is not a trailing comma"],
    ['{"a":1} /*', 'Expected "*/"', "an unterminated block comment names what is missing"],
    ["   ", "Unexpected end of file", "whitespace alone is not an empty file"],
    ["// nothing", "Unexpected end of file", "nor is a lone comment"],
  ]) {
    const got = parse(src);
    ok(got.startsWith("ERR:") && got.indexOf(phrase) !== -1, "JSONC rejects: " + why + " — " + JSON.stringify(got.slice(4, 48)));
  }
  // Two places this is deliberately STRICTER than Bun, which are the only two
  // divergences and both reject input rather than accepting more.
  ok(parse("{a:1}").startsWith("ERR:"), "an unquoted key throws, where Bun silently returns {\"\": 1} and drops the name");
  ok(parse("{} {}").startsWith("ERR:"), "a second root throws, where Bun returns the first and ignores the rest of the file");
}

console.log("== bun:jsc: two that work, and honest refusals for the engine hatch ==");
{
  const { modules } = createBunRuntime({ process: { env: {}, argv: ["bun"], cwd: () => "/", stdout: process.stdout, stderr: process.stderr, stdin: process.stdin }, Buffer, require: nodeRequire });
  const jsc = modules["bun:jsc"];
  // Really changes the zone: Node re-reads TZ and drops its cached offset, so this
  // is the API doing its job rather than a stub that remembers a string.
  const before = new Date(0).getTimezoneOffset();
  jsc.setTimeZone("Asia/Tokyo");
  const tokyo = new Date(0).getTimezoneOffset();
  jsc.setTimezone("UTC");
  const utc = new Date(0).getTimezoneOffset();
  ok(tokyo === -540, "bun:jsc.setTimeZone('Asia/Tokyo') moves Date by nine hours (offset " + tokyo + ")");
  ok(utc === 0, "…and the lowercase spelling Bun also accepts works too");
  ok(typeof before === "number", "…starting from whatever the host had");
  ok((await jsc.drainMicrotasks()) === true, "bun:jsc.drainMicrotasks() drains the queue");
  for (const name of ["fullGC", "heapStats", "startSamplingProfiler", "noInline"]) {
    let m = "";
    try { jsc[name](); } catch (e) { m = String(e.message || e); }
    ok(m.indexOf("is not supported in Vivari (browser sandbox)") !== -1 && m.indexOf("JavaScriptCore internals") !== -1,
      "bun:jsc." + name + " refuses rather than being absent: " + JSON.stringify(m.slice(0, 48)));
  }
}

console.log("== bun:test's compat spellings ==");
{
  const { t } = freshBunTest();
  for (const n of ["xit", "xtest", "xdescribe", "setDefaultTimeout", "onTestFinished", "expectTypeOf"]) {
    ok(typeof t[n] === "function", "bun:test exports " + n);
  }
  ok(t.vi && typeof t.vi.fn === "function" && typeof t.vi.spyOn === "function", "…and vi, with the mocking half wired to the same functions");
  // A type-level assertion evaporates at run time in Bun too; what it must not do
  // is throw, however long the chain.
  ok(t.expectTypeOf(1).toEqualTypeOf().not.toBeString() !== undefined, "expectTypeOf chains without throwing");
  // Fake timers, which used to be the half that did not exist. Both names drive
  // the same queue, so this checks vi and jest reach one clock.
  let m = "";
  try { t.vi.advanceTimersByTime(1000); } catch (e) { m = String(e.message || e); }
  ok(m === "Fake timers are not active. Call useFakeTimers() first.", "advancing without useFakeTimers() is Bun's own error: " + JSON.stringify(m.slice(0, 50)));
  let outside = "";
  try { t.onTestFinished(() => {}); } catch (e) { outside = String(e.message || e); }
  ok(outside.indexOf("inside a test body") !== -1, "onTestFinished outside a test is an error, not a dropped callback");
}

// ---- 27) the clock seam: fake timers and setSystemTime ----------------------
// Both were refused for "there is no clock seam". For the event LOOP that was
// true; for a test it never was, since the code under test reads a global. The
// semantics below were read off the 1.3 binary and two of them are worth naming:
// setSystemTime FREEZES the clock rather than offsetting it, and fake timers
// leave Date alone, so the two features do not interact at all.
{
  const { t } = freshBunTest();
  const RealDate = Date;

  t.setSystemTime(new Date("2020-01-01T00:00:00Z"));
  ok(new Date().toISOString() === "2020-01-01T00:00:00.000Z", "setSystemTime moves what new Date() reports");
  ok(Date.now() === 1577836800000, "…and Date.now() with it");
  const before = Date.now();
  await new Promise((r) => RealDate && setTimeout(r, 15));
  ok(Date.now() === before, "…frozen, not offset: real time passing does not move it");
  ok(new Date() instanceof Date && Date.name === "Date", "…still a Date, still named Date");
  ok(new Date("1999-05-05").getFullYear() === 1999, "…and an explicit argument is untouched");
  t.setSystemTime();
  ok(new Date().getFullYear() >= 2025, "setSystemTime() with no argument restores the real clock");

  const j = t.jest;
  const order = [];
  j.useFakeTimers();
  setTimeout(() => order.push("t100"), 100);
  const iv = setInterval(() => order.push("i30"), 30);
  ok(j.getTimerCount() === 2, "getTimerCount sees both queued timers");
  j.advanceTimersByTime(100);
  // Due order, and for a tie the order they were scheduled — which is what puts
  // three interval firings before a timeout that was registered first.
  ok(JSON.stringify(order) === '["i30","i30","i30","t100"]', "advanceTimersByTime fires in due order: " + JSON.stringify(order));
  clearInterval(iv);
  ok(j.getTimerCount() === 0, "clearInterval removes a fake timer");

  order.length = 0;
  setTimeout(() => order.push("a"), 10);
  setTimeout(() => order.push("b"), 20);
  j.advanceTimersToNextTimer();
  ok(JSON.stringify(order) === '["a"]', "advanceTimersToNextTimer stops at the next one");
  j.runAllTimers();
  ok(JSON.stringify(order) === '["a","b"]', "runAllTimers drains the rest");

  let spun = "";
  setInterval(() => {}, 5);
  try { j.runAllTimers(); } catch (e) { spun = String(e.message || e); }
  // The one deliberate divergence: real Bun spins here forever.
  ok(spun.indexOf("Aborting after running 100000 timers") === 0, "runAllTimers on a live interval stops instead of hanging: " + JSON.stringify(spun.slice(0, 40)));
  j.clearAllTimers();
  ok(j.getTimerCount() === 0, "clearAllTimers empties the queue");

  ok(t.vi.isFakeTimers() === true, "vi and jest are the same clock");
  ok(new Date().getFullYear() >= 2025, "fake timers leave Date alone, as in Bun");
  j.useRealTimers();
  ok(t.vi.isFakeTimers() === false, "useRealTimers puts the globals back");
  let fired = false;
  setTimeout(() => { fired = true; }, 1);
  await new Promise((r) => setTimeout(r, 20));
  ok(fired, "…and a real timer fires again afterwards");

  // A test that installs fake timers and never restores them must not freeze the
  // next file, nor the runner's own per-test timeout.
  j.useFakeTimers();
  t.setSystemTime(new Date("2000-01-01T00:00:00Z"));
  t.__setFile("next.test.ts");
  ok(t.vi.isFakeTimers() === false && new Date().getFullYear() >= 2025, "a leaked fake clock is reset at the next file");
}

// ---- 28) the shells and the file body ---------------------------------------
// Bun's `$` carries seven names this did not: four that set defaults for every
// command that follows, and three classes that exist so `catch (e) { e
// instanceof $.ShellError }` — the handling Bun's own docs suggest — can work.
{
  // The host's own process, not the stub: these commands really run, so they need
  // a real cwd and a PATH to find `pwd` on.
  const B = createBunRuntime({ process, Buffer, require: nodeRequire }).Bun;
  for (const n of ["cwd", "env", "nothrow", "throws", "Shell", "ShellError", "ShellPromise"]) {
    ok(typeof B.$[n] === "function", "Bun.$." + n + " exists");
  }
  B.$.cwd("/tmp");
  ok((await B.$`pwd`.text()).trim() === "/tmp", "$.cwd() sets the directory for the commands after it");
  B.$.env({ VV_SHELL_DEFAULT: "yes", PATH: process.env.PATH });
  ok((await B.$`printenv VV_SHELL_DEFAULT`.text()).trim() === "yes", "$.env() sets the environment for them too");
  B.$.nothrow();
  ok((await B.$`exit 3`).exitCode === 3, "$.nothrow() turns a failing command into a result");
  B.$.throws(true);
  let shellErr = null;
  try { await B.$`exit 4`; } catch (e) { shellErr = e; }
  ok(shellErr instanceof B.$.ShellError && shellErr.exitCode === 4, "$.throws(true) throws a ShellError carrying the code");
  // The point of the class: a library that sets $.cwd() must not move the
  // caller's shell.
  const isolated = new B.$.Shell();
  ok((await isolated`pwd`.text()).trim() === process.cwd(), "new $.Shell() starts from the real cwd, not the other shell's default");
}

{
  const B = freshBun();
  const fs = await import("node:fs");
  const path = "/tmp/vv-spike-form.txt";
  fs.writeFileSync(path, "a=1&b=two");
  // Bun refuses a body it cannot classify rather than returning an empty
  // FormData: nothing in the bytes says urlencoded or multipart.
  let noType = "";
  try { await B.file(path).formData(); } catch (e) { noType = String(e.message || e); }
  ok(noType === "Invalid encoding", "BunFile.formData() without a type is Bun's 'Invalid encoding': " + JSON.stringify(noType));
  const fd = await B.file(path, { type: "application/x-www-form-urlencoded" }).formData();
  ok(JSON.stringify([...fd.entries()]) === '[["a","1"],["b","two"]]', "…and parses the form when the type says how");
  const boundary = "X";
  fs.writeFileSync(path, "--X\r\nContent-Disposition: form-data; name=\"k\"\r\n\r\nv\r\n--X--\r\n");
  const mp = await B.file(path, { type: "multipart/form-data; boundary=" + boundary }).formData();
  ok(mp.get("k") === "v", "…multipart too");
  fs.unlinkSync(path);
}

// ---- Bun.spawn({ ipc }) framing ---------------------------------------------
// The framing lives here, and NOT only in the kernel spike, for a measured
// reason: in this VM one socket write is delivered as exactly one `data` event —
// each write becomes one `pipe-data` message, the kernel relays it verbatim, and
// the net binding hands it to the reader whole. So the kernel tier cannot tell a
// length-prefixed stream from a naive one. Deleting the length prefix entirely
// and treating every chunk as a message leaves scripts/spike-bun.mjs completely
// green — that was tried, deliberately, before writing this block.
//
// A node net.Socket is a byte stream all the same, and nothing in its contract
// promises the 1:1 this transport happens to give. So the split and the coalesce
// are fed to the reader directly, which is what FrameReader is a pure class for.
console.log("\n== Bun.spawn({ ipc }) framing ==");
{
  const chunksOf = (bytes, size) => {
    const out = [];
    for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
    return out;
  };
  const drain = (reader, chunks) => {
    const messages = [];
    for (const chunk of chunks) {
      for (const frame of reader.push(chunk)) messages.push(decodeMessage(frame, "advanced"));
    }
    return messages;
  };
  const join = (frames) => {
    const total = frames.reduce((n, f) => n + f.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const f of frames) {
      out.set(f, at);
      at += f.length;
    }
    return out;
  };

  // Five messages written back-to-back in one tick, arriving as ONE chunk. An
  // unframed reader delivers this as a single message, or as one that fails to
  // decode; either way four messages are gone with no error anywhere.
  const five = [0, 1, 2, 3, 4].map((i) => encodeMessage({ i, tag: "m" + i }, "advanced"));
  const coalesced = drain(new FrameReader(), [join(five)]);
  ok(coalesced.length === 5, "five frames coalesced into one chunk are read back as five messages, not one: got " + coalesced.length);
  ok(
    coalesced.every((m, i) => m.i === i && m.tag === "m" + i),
    "…in order and with their contents intact",
  );

  // One message split across many chunks, INCLUDING a split inside the 4-byte
  // length prefix itself — the case a reader that peeks at the prefix before
  // checking it has arrived gets wrong.
  const big = encodeMessage({ payload: "z".repeat(300000), when: new Date(5) }, "advanced");
  const split = drain(new FrameReader(), chunksOf(big, 7));
  ok(split.length === 1, "a message split across " + Math.ceil(big.length / 7) + " chunks is reassembled into exactly one message: got " + split.length);
  ok(split[0] && split[0].payload.length === 300000 && split[0].when instanceof Date, "…with all 300000 bytes and its Date");
  const byteAtATime = drain(new FrameReader(), chunksOf(encodeMessage({ a: 1 }, "advanced"), 1));
  ok(byteAtATime.length === 1 && byteAtATime[0].a === 1, "…and one byte at a time works too, so a split length prefix is not read early");

  // The realistic mixture: a partial frame trailing a complete one, finished by
  // the next chunk. A reader that discards its remainder loses the second half.
  const [a, b] = [encodeMessage({ n: "first" }, "advanced"), encodeMessage({ n: "second" }, "advanced")];
  const reader = new FrameReader();
  const firstPass = reader.push(join([a, b.subarray(0, 5)])).map((f) => decodeMessage(f, "advanced"));
  const secondPass = reader.push(b.subarray(5)).map((f) => decodeMessage(f, "advanced"));
  ok(firstPass.length === 1 && firstPass[0].n === "first", "a complete frame followed by half of the next yields only the complete one");
  ok(secondPass.length === 1 && secondPass[0].n === "second", "…and the remainder is kept, so the next chunk completes it");

  // A length a peer controls is a request to allocate. It is capped, and the cap
  // is enforced before anything is read, so a corrupt stream fails loudly here
  // rather than by growing until the tab dies.
  const bogus = new Uint8Array(8);
  new DataView(bogus.buffer).setUint32(0, 0xfffffff0, true);
  let capped = "";
  try {
    new FrameReader().push(bogus);
  } catch (e) {
    capped = String(e.message || e);
  }
  ok(/exceeds the .* limit/.test(capped), "a frame length past the cap is refused instead of allocated: " + JSON.stringify(capped));

  // The two modes, and the difference between them, without a process in sight.
  const clone = decodeMessage(encodeMessage({ m: new Map([["k", 1]]), d: new Date(7) }, "advanced").subarray(4), "advanced");
  ok(clone.m instanceof Map && clone.d instanceof Date, "the default 'advanced' mode round-trips a Map and a Date");
  const asJson = decodeMessage(encodeMessage({ m: new Map([["k", 1]]), d: new Date(7) }, "json").subarray(4), "json");
  ok(!(asJson.m instanceof Map) && typeof asJson.d === "string", "…and 'json' mode flattens both, which is the whole cost of that mode");
  ok(normalizeMode(undefined) === "advanced" && normalizeMode("json") === "json", "an unspecified serialization mode is 'advanced', as it is in bun");

  let bare = "";
  try {
    requireMessage(undefined);
  } catch (e) {
    bare = e.name + ": " + e.message;
  }
  ok(bare === 'TypeError: The "message" argument must be specified', "send(undefined) is refused with bun's sentence: " + JSON.stringify(bare));
}

// ---- Bun.Archive -------------------------------------------------------------
// Bun.Archive was a refusal ("bytes in, bytes out, nobody has written it") and is
// now a real tar codec. The bug class these sections are aimed at: an archive
// writer that only ever round-trips against its own reader. That passes forever
// while agreeing with nothing — the Bun.hash trap in a different costume — so the
// bytes on the left of every comparison below came out of the real 1.3.6 binary,
// recorded by scripts/record-bun-archive.mjs into scripts/fixtures/bun-archive.json.
const ARCHIVE_FIXTURE = JSON.parse(
  nodeRequire("node:fs").readFileSync(new URL("./fixtures/bun-archive.json", import.meta.url), "utf8")
);
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));

console.log("== Bun.Archive reads bytes a real bun wrote ==");
{
  // Four archives, each shaped to break a plausible shortcut in the reader: a
  // plain one (including a zero-length entry), a name too long for a ustar header
  // (Bun writes a pax `x` header — NOT the GNU `L` extension GNU tar would), a
  // name that splits across the ustar `prefix` field, and one past the
  // 10240-byte record boundary.
  const B = freshBun();
  for (const [name, recorded] of Object.entries(ARCHIVE_FIXTURE.archives)) {
    const want = recorded.entries;
    for (const [label, bytes] of [["tar", unb64(recorded.tar)], ["tar.gz", unb64(recorded.gzip)]]) {
      const files = await new B.Archive(bytes).files();
      const got = Object.fromEntries([...files].map(([k, v]) => [k, v.size]));
      ok(
        JSON.stringify(got) === JSON.stringify(want),
        `${name} (${label}) read back from real Bun's bytes: ${JSON.stringify(Object.keys(got))}`
      );
    }
  }
  // The gzip half is not a formality: a gzipped archive is what `bun` writes with
  // { compress: "gzip" }, and detection is by the 1f 8b magic rather than by any
  // filename, since these bytes arrive with no name attached.
  ok(unb64(ARCHIVE_FIXTURE.archives.plain.gzip)[0] === 0x1f, "the recorded .gzip fixtures really are gzip streams");
  // Bun's own padding rule, which a writer that stops at the two zero blocks gets
  // wrong: every archive is rounded up to a multiple of 10240, so even {} is 10240
  // bytes and a 20000-byte payload lands on 30720.
  ok(unb64(ARCHIVE_FIXTURE.archives.multiRecord.tar).length === 30720, "a real 20000-byte archive is 30720 bytes (three records)");
}

console.log("== Bun.Archive writes tar a real bun (and GNU tar) can read ==");
{
  // Our writer's bytes, read back by our reader, would prove nothing on its own.
  // What makes this a real check is that the same entry sets were written by the
  // binary above, so the header LAYOUT is pinned: field-for-field agreement is
  // asserted here, and the round-trip is asserted through it.
  const B = freshBun();
  for (const [name, recorded] of Object.entries(ARCHIVE_FIXTURE.archives)) {
    const spec = Object.fromEntries(Object.entries(recorded.entries).map(([k, len]) => [k, "z".repeat(len)]));
    const mine = await new B.Archive(spec).bytes();
    const theirs = unb64(recorded.tar);
    ok(mine.length === theirs.length, `${name}: our archive is the same length as Bun's (${mine.length})`);
    // Everything except mtime (which is "now" in both) and the checksum that
    // covers it. Comparing whole blocks would fail on the clock alone.
    const fields = [[0, 100, "name"], [100, 8, "mode"], [108, 8, "uid"], [116, 8, "gid"],
      [124, 12, "size"], [156, 1, "typeflag"], [257, 8, "magic+version"], [265, 32, "uname"],
      [297, 32, "gname"], [329, 8, "devmajor"], [345, 155, "prefix"]];
    // Walk HEADER blocks only: the data blocks in between are payload, and
    // striding a flat 512 through them compares content against content and
    // reports a difference that is not one.
    let differing = "";
    let headers = 0;
    for (let off = 0; off + 512 <= theirs.length && !differing; ) {
      if (theirs.subarray(off, off + 512).every((b) => b === 0)) break;
      headers++;
      for (const [at, len, label] of fields) {
        const a = Buffer.from(mine.subarray(off + at, off + at + len)).toString("latin1");
        const b = Buffer.from(theirs.subarray(off + at, off + at + len)).toString("latin1");
        if (a !== b) { differing = `${label}@${off}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`; break; }
      }
      const size = parseInt(Buffer.from(theirs.subarray(off + 124, off + 136)).toString("latin1").trim(), 8) || 0;
      off += 512 + Math.ceil(size / 512) * 512;
    }
    ok(!differing, `${name}: every field of all ${headers} ustar headers matches Bun's byte for byte${differing ? " — " + differing : ""}`);
  }
  // The checksum is the one field a reader validates, so it has to be right in our
  // OWN bytes rather than merely equal to Bun's — hence the independent recompute.
  const bytes = await new B.Archive({ "a.txt": "hello" }).bytes();
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : bytes[i];
  ok(
    Buffer.from(bytes.subarray(148, 156)).toString("latin1") === sum.toString(8).padStart(6, "0") + "\0 ",
    "the octal header checksum we write is the checksum of the block we wrote"
  );
}

console.log("== Bun.Archive round-trips create -> bytes -> read ==");
{
  const B = freshBun();
  const payload = new Uint8Array(5000);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff;
  const archive = new B.Archive({
    "text.txt": "hello world",
    "nested/deep/bin.dat": payload,
    "from-buffer.dat": new Uint8Array([1, 2, 3, 4]).buffer,
    "from-blob.txt": new Blob(["blob contents"]),
    "empty.txt": "",
  });
  const files = await new B.Archive(await archive.bytes()).files();
  ok(files instanceof Map, "files() resolves to a Map, not a plain object");
  ok([...files.values()].every((v) => v instanceof Blob), "…whose values are Blobs");
  ok(typeof archive.files().then === "function", "…and files() is a Promise, so it has to be awaited");
  ok(await files.get("text.txt").text() === "hello world", "a string entry survives the round trip");
  ok(files.get("nested/deep/bin.dat").size === 5000, "a 5000-byte binary entry keeps its length");
  const back = new Uint8Array(await files.get("nested/deep/bin.dat").arrayBuffer());
  ok(back.every((b, i) => b === payload[i]), "…and every byte of it, across the 512-byte block padding");
  ok(await files.get("from-buffer.dat").text() === "\u0001\u0002\u0003\u0004", "an ArrayBuffer entry survives");
  ok(await files.get("from-blob.txt").text() === "blob contents", "a Blob entry is read for its bytes");
  ok(files.has("empty.txt") && files.get("empty.txt").size === 0, "a zero-length entry is kept, not dropped");
  ok([...files.keys()].join(",") === "text.txt,nested/deep/bin.dat,from-buffer.dat,from-blob.txt,empty.txt",
    "entry order is the object's key order, as Bun's is");
  // Bun's own encoding for a value that is not bytes: String(), which is why
  // `null` is four bytes and not a refusal.
  const odd = await new B.Archive({ n: 42, nul: null, u: undefined, o: { a: 1 }, arr: [1, 2] }).files();
  const shown = {};
  for (const [k, v] of odd) shown[k] = await v.text();
  ok(JSON.stringify(shown) === '{"n":"42","nul":"null","u":"undefined","o":"[object Object]","arr":"1,2"}',
    "a non-binary value is String()d, which is what the binary stores: " + JSON.stringify(shown));
}

console.log("== Bun.Archive reads what the host's own tar wrote ==");
{
  // A second implementation entirely, and the one whose extensions differ: GNU tar
  // uses its `L` long-name entry where Bun uses pax, emits real directory and
  // symlink entries (Bun's writer emits neither), and can be asked for pax or v7.
  // These fixtures are built at spike time by the host `tar`, so the reader is
  // gated against bytes nobody in this repo produced.
  const fs = nodeRequire("node:fs");
  const os = nodeRequire("node:os");
  const path = nodeRequire("node:path");
  const cp = nodeRequire("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-bunarc-tar-"));
  const src = path.join(dir, "src");
  const longName = "verylong/" + "seg/".repeat(30) + "leaf.txt";
  fs.mkdirSync(path.join(src, path.dirname(longName)), { recursive: true });
  fs.mkdirSync(path.join(src, "dir/nested"), { recursive: true });
  fs.writeFileSync(path.join(src, "a.txt"), "alpha contents\n");
  fs.writeFileSync(path.join(src, "dir/b.txt"), "beta\n");
  fs.writeFileSync(path.join(src, "dir/nested/c.txt"), "deep\n");
  fs.writeFileSync(path.join(src, longName), "longname\n");
  try { fs.symlinkSync("a.txt", path.join(src, "link.txt")); } catch {}
  const tar = (args) => {
    try { cp.execFileSync("tar", args, { cwd: src, stdio: ["ignore", "ignore", "pipe"] }); return true; }
    catch { return false; }
  };
  const have = tar(["--version"]);
  if (!have) {
    // A missing `tar` must be reported as a skip, not pass quietly — the ok-flag
    // rule in AGENTS.md. There is no `ok()` here on purpose: nothing was proven.
    console.log("  (skipped: no `tar` on this host)");
  } else {
    const cases = [
      ["gnu.tar", ["--format=gnu", "-cf", "gnu.tar", "a.txt", "dir", longName], ["a.txt", "dir/b.txt", "dir/nested/c.txt", longName],
        "GNU format, whose long names use the `L` entry Bun never writes"],
      ["pax.tar", ["--format=pax", "-cf", "pax.tar", "a.txt", "dir", longName], ["a.txt", "dir/b.txt", "dir/nested/c.txt", longName],
        "pax format, whose long names arrive as a `path=` record"],
      ["v7.tar", ["--format=v7", "-cf", "v7.tar", "a.txt"], ["a.txt"],
        "v7 format, which carries no `ustar` magic at all — only the checksum identifies it"],
      ["gz.tar.gz", ["--format=gnu", "-czf", "gz.tar.gz", "a.txt", "dir"], ["a.txt", "dir/b.txt", "dir/nested/c.txt"],
        "gzipped, detected by magic because these bytes have no filename"],
      ["sym.tar", ["--format=gnu", "-cf", "sym.tar", "a.txt", "link.txt", "dir"], ["a.txt", "dir/b.txt", "dir/nested/c.txt"],
        "with a symlink and directory entries, which files() drops as Bun's does"],
    ];
    const B = freshBun();
    for (const [file, args, want, why] of cases) {
      ok(tar(args), `host tar produced ${file}`);
      const files = await new B.Archive(fs.readFileSync(path.join(src, file))).files();
      ok(JSON.stringify([...files.keys()].sort()) === JSON.stringify([...want].sort()),
        `${file}: ${why} — ${JSON.stringify([...files.keys()].map((k) => k.slice(0, 24)))}`);
    }
    ok(await (await new B.Archive(fs.readFileSync(path.join(src, "gnu.tar"))).files()).get("a.txt").text() === "alpha contents\n",
      "…and the CONTENTS come back, not just the names");
    // The reverse direction: GNU tar reading what we wrote, including the pax
    // header our writer emits for a name it cannot split.
    const mine = path.join(src, "ours.tar");
    fs.writeFileSync(mine, await new B.Archive({ "a.txt": "ours", ["N".repeat(120)]: "pax path" }).bytes());
    let listed = "";
    try { listed = cp.execFileSync("tar", ["-tf", mine], { cwd: src }).toString(); } catch (e) { listed = "ERR " + e; }
    ok(listed.includes("a.txt") && listed.includes("N".repeat(120)),
      "GNU tar lists both entries of an archive we wrote, pax long name included");
    // A real, multi-entry, DEFLATED zip — over 512 bytes, so it reaches the header
    // check rather than being turned away on length. The committed fixture zip is
    // 175 bytes and cannot test that path.
    let zipped = false;
    try { cp.execFileSync("zip", ["-q", "-r", "big.zip", "a.txt", "dir", longName], { cwd: src, stdio: "ignore" }); zipped = true; } catch {}
    if (!zipped) {
      console.log("  (skipped: no `zip` on this host)");
    } else {
      const bytes = fs.readFileSync(path.join(src, "big.zip"));
      let message = "";
      try { await new B.Archive(bytes).files(); } catch (e) { message = String(e.message || e); }
      ok(bytes.length > 512, `the host's zip is ${bytes.length} bytes, past the one-block shortcut`);
      ok(message === "Unrecognized archive format",
        "…and a real multi-entry zip is refused in Bun's words, because Bun cannot read one either");
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("== Bun.Archive.extract writes into a directory ==");
{
  const fs = nodeRequire("node:fs");
  const os = nodeRequire("node:os");
  const path = nodeRequire("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-bunarc-x-"));
  const B = createBunRuntime({
    process: { env: {}, argv: ["bun"], cwd: () => dir, stdout: process.stdout, stderr: process.stderr, stdin: process.stdin },
    Buffer,
    require: nodeRequire,
  }).Bun;
  const dest = path.join(dir, "out");
  const count = await new B.Archive({ "a.txt": "hello", "dir/b.txt": "world", "dir/nested/c.bin": new Uint8Array([7, 8]) }).extract(dest);
  ok(count === 3, "extract() resolves to the number of entries, as Bun's does: " + count);
  ok(fs.readFileSync(path.join(dest, "a.txt"), "utf8") === "hello", "a top-level entry is written");
  ok(fs.readFileSync(path.join(dest, "dir/b.txt"), "utf8") === "world", "…and a nested one, with its directories created on the way");
  ok(fs.readFileSync(path.join(dest, "dir/nested/c.bin"))[1] === 8, "…binary content included");
  // Bun creates the destination itself, several levels deep if it has to.
  const deep = path.join(dir, "a/b/c");
  ok(await new B.Archive({ "x.txt": "x" }).extract(deep) === 1 && fs.existsSync(path.join(deep, "x.txt")),
    "extract() creates a destination that does not exist yet");
  // Extracting the same archive twice must overwrite rather than throw: this is
  // what an unpack-then-rebuild loop does every time.
  ok(await new B.Archive({ "a.txt": "second" }).extract(dest) === 1 && fs.readFileSync(path.join(dest, "a.txt"), "utf8") === "second",
    "extracting again overwrites the file instead of failing");
  // A tar.gz extracts too — the same decompression path files() uses.
  const gz = await new B.Archive({ "z.txt": "zipped" }, { compress: "gzip" }).bytes();
  ok(gz[0] === 0x1f && gz[1] === 0x8b, "{ compress: 'gzip' } really produces a gzip stream (1f 8b)");
  ok(await new B.Archive(gz).extract(path.join(dir, "fromgz")) === 1, "…and a gzipped archive extracts");
  ok(fs.readFileSync(path.join(dir, "fromgz/z.txt"), "utf8") === "zipped", "…with the right contents");

  // Path traversal. `../` in an entry name is the classic tar attack, and real Bun
  // strips it rather than escaping — the recorded fixture says where each of these
  // lands, so this is Bun's answer and not our opinion of a safe one.
  for (const [key, recorded] of Object.entries(ARCHIVE_FIXTURE.observed.traversal)) {
    const box = fs.mkdtempSync(path.join(dir, "trav-"));
    const inner = path.join(box, "sub");
    const count2 = await new B.Archive({ [key]: "T" }).extract(inner);
    const found = fs.existsSync(inner) ? fs.readdirSync(inner, { recursive: true }).sort() : [];
    ok(count2 === recorded.count, `extract(${JSON.stringify(key)}) counts ${recorded.count} entries, as the binary does`);
    ok(JSON.stringify(found) === JSON.stringify(recorded.files),
      `…and lands at ${JSON.stringify(recorded.files)} — inside the destination, never above it`);
    ok(!fs.existsSync(path.join(box, "escaped.txt")) && !fs.existsSync(path.join(box, "b.txt")),
      `…nothing was written into ${JSON.stringify("sub")}'s parent`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("== Bun.Archive.write always emits tar, whatever the path says ==");
{
  const fs = nodeRequire("node:fs");
  const os = nodeRequire("node:os");
  const path = nodeRequire("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-bunarc-w-"));
  const B = freshBun();
  ok(B.Archive.write.length === 2, "Archive.write.length is 2, as the binary reports, though it takes options as a third argument");
  // The quirk this section exists for: the extension is decoration. `out.zip` gets
  // 10240 bytes of ustar, and so does `{ format: "zip" }`. Reproduced rather than
  // improved, because a shim that wrote a real zip to a .zip path would produce a
  // file real Bun cannot read back.
  for (const [ext, recorded] of Object.entries(ARCHIVE_FIXTURE.observed.writeIgnoresExtension)) {
    if (ext === "formatZipOption") continue;
    const p = path.join(dir, "out." + ext);
    await B.Archive.write(p, { "x.txt": "x" });
    const bytes = fs.readFileSync(p);
    ok(bytes.length === recorded.length && bytes.subarray(257, 262).toString("latin1") === recorded.magic,
      `write("out.${ext}") is ${recorded.length} bytes of ${JSON.stringify(recorded.magic)}, exactly as the binary writes it`);
  }
  const fmt = path.join(dir, "fmt.tar");
  await B.Archive.write(fmt, { "x.txt": "x" }, { format: "zip" });
  ok(fs.readFileSync(fmt).subarray(257, 262).toString("latin1") === ARCHIVE_FIXTURE.observed.writeIgnoresExtension.formatZipOption.magic,
    "{ format: 'zip' } is accepted and ignored, which is also what the binary does");
  // Compression is the one option that changes the bytes.
  const gzPath = path.join(dir, "c.tar.gz");
  await B.Archive.write(gzPath, { "a.txt": "hello" }, { compress: "gzip" });
  const gz = fs.readFileSync(gzPath);
  ok(gz[0] === 0x1f && gz[1] === 0x8b, "{ compress: 'gzip' } writes a real gzip (1f 8b), not a tar with a .gz name");
  ok(gz.length < 10240, "…and it is smaller than the tar inside it: " + gz.length);
  ok((await (await new B.Archive(gz).files()).get("a.txt").text()) === "hello", "…and reads back through the gzip path");
  // The three second-argument forms that are not a plain object. Raw bytes are
  // written VERBATIM — Bun does not re-tar them, so three garbage bytes really do
  // produce a three-byte file.
  const arcPath = path.join(dir, "from-archive.tar");
  await B.Archive.write(arcPath, new B.Archive({ "z.txt": "zz" }));
  ok([...(await new B.Archive(fs.readFileSync(arcPath)).files()).keys()].join() === "z.txt",
    "write(path, archive) writes that archive's contents");
  const rawPath = path.join(dir, "raw.bin");
  await B.Archive.write(rawPath, new Uint8Array([1, 2, 3]));
  ok(fs.readFileSync(rawPath).length === 3, "write(path, bytes) copies the bytes through without re-tarring them");
  const blobPath = path.join(dir, "blob.tar");
  await B.Archive.write(blobPath, new Blob([await new B.Archive({ "b.txt": "bb" }).bytes()]));
  ok([...(await new B.Archive(fs.readFileSync(blobPath)).files()).keys()].join() === "b.txt", "write(path, Blob) writes the Blob's bytes");
  // Bun's write() has already touched the disk by the time it hands back its
  // promise. A guest that forgets to await it still finds the file, and losing
  // that would be a silent behaviour change.
  const eager = path.join(dir, "eager.tar");
  const pending = B.Archive.write(eager, { "e.txt": "e" });
  ok(fs.existsSync(eager), "write() has written the file before its promise settles, as the binary has");
  await pending;
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("== Bun.Archive refuses what Bun refuses, in Bun's words ==");
{
  // The error strings are API: someone will paste one into a search box, and a
  // `catch` that compares them has to keep working under the real binary. Each
  // expectation here is the message the 1.3.6 binary produced, not a paraphrase.
  const B = freshBun();
  const R = ARCHIVE_FIXTURE.refusals;
  const caught = async (fn) => {
    try { await fn(); return null; } catch (e) { return { name: e?.constructor?.name ?? null, message: String(e?.message ?? e), code: e?.code ?? null }; }
  };
  const zip = unb64(ARCHIVE_FIXTURE.zip);
  const truncated = (await new B.Archive({ "a.txt": "hello" }).bytes()).subarray(0, 512);
  // The same deterministic bytes record-bun-archive.mjs handed the binary.
  const bigBinary = new Uint8Array(4096);
  for (let i = 0; i < bigBinary.length; i++) bigBinary[i] = (i * 37 + 11) & 0xff;
  for (const [key, fn, why] of [
    ["ctorString", () => new B.Archive("hello"), "a string is not an archive — it is the mistake the types invite"],
    ["ctorNumber", () => new B.Archive(7), "nor is a number"],
    ["ctorNothing", () => new B.Archive(), "nor is nothing at all"],
    ["nonAsciiName", () => new B.Archive({ "ü.txt": "x" }).bytes(), "a non-ASCII entry name: libarchive will not encode one in a ustar header, and does not fall back to pax for it"],
    ["writeNoArgs", () => B.Archive.write(), "write() with no path"],
    ["writeNumberPath", () => B.Archive.write(7, { "a.txt": "x" }), "write() with a number for a path"],
    ["writeNoFiles", () => B.Archive.write("/tmp/vv-arc-none.tar"), "write() with nothing to write — note the message names Archive too, unlike the constructor's"],
    ["writeStringFiles", () => B.Archive.write("/tmp/vv-arc-none.tar", "str"), "write() handed a string instead of entries"],
    ["optionsNotObject", () => B.Archive.write("/tmp/vv-arc-none.tar", { a: "b" }, "gzip"), "the compression passed where the options go"],
    ["compressNotString", () => B.Archive.write("/tmp/vv-arc-none.tar", { a: "b" }, { compress: true }), "compress: true — a different message from a wrong string, because it is a different mistake"],
    ["compressNotGzip", () => B.Archive.write("/tmp/vv-arc-none.tar", { a: "b" }, { compress: "gz" }), "compress: 'gz', which is not the spelling Bun accepts"],
    ["extractNoPath", () => new B.Archive({ "a.txt": "x" }).extract(), "extract() with no destination"],
    ["extractNumberPath", () => new B.Archive({ "a.txt": "x" }).extract(7), "extract() with a number for a destination"],
    ["readZip", () => new B.Archive(zip).files(), "A REAL ZIP. Bun cannot read one, so neither may this — being a superset is how code passes here and throws in production"],
    ["readGarbage", () => new B.Archive(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])).files(), "eight bytes of garbage, which get the same words as the zip"],
    ["readEmpty", () => new B.Archive(new Uint8Array(0)).files(), "zero bytes"],
    ["readText", () => new B.Archive(new TextEncoder().encode("hello world, not an archive")).files(), "a text file"],
    // These three are the ones that actually exercise the header check. Everything
    // above is shorter than one 512-byte block and is refused on length alone, so a
    // reader with NO validation passes every short case and then reads garbage
    // entries out of a 4 KB file — which is exactly what happened when this
    // assertion was missing.
    ["readBigBinary", () => new B.Archive(bigBinary).files(), "4096 bytes of binary that is not a tar — longer than a block, so only the header checksum can reject it"],
    ["readLongText", () => new B.Archive(new TextEncoder().encode("A".repeat(1024))).files(), "1024 printable bytes"],
    ["readLongJson", () => new B.Archive(new TextEncoder().encode(JSON.stringify({ note: "not an archive", filler: "v".repeat(2000) }))).files(), "a 2 KB JSON file"],
    ["readTruncated", () => new B.Archive(truncated).files(), "a header whose payload was cut off — a DIFFERENT message from unrecognized, and the distinction is worth keeping"],
    ["extractGarbage", () => new B.Archive(new Uint8Array([1, 2, 3])).extract("/tmp/vv-arc-x"), "a corrupt archive through extract(), which reports Bun's unhelpful `ReadError` rather than the reader's message"],
    ["notAnArchive", () => B.Archive.prototype.files.call({}), "files() called on something that is not an Archive"],
  ]) {
    const got = await caught(fn);
    ok(got !== null, `${key}: throws at all — ${why}`);
    ok(got && got.message === R[key].message, `…with the binary's exact words: ${JSON.stringify(R[key].message)}${got && got.message !== R[key].message ? " (got " + JSON.stringify(got.message) + ")" : ""}`);
    ok(got && got.name === R[key].name && got.code === R[key].code,
      `…and its ${R[key].name}/${R[key].code} typing, which code branching on err.code depends on`);
  }
  // Reading is LAZY: bytes() and blob() hand back whatever they were given and
  // validate nothing, so only files()/extract() ever reject a format. A shim that
  // validated in the constructor would throw where Bun returns three bytes.
  const junk = new B.Archive(new Uint8Array([1, 2, 3]));
  ok((await junk.bytes()).length === 3, "bytes() on an unreadable archive returns its 3 bytes rather than throwing, as Bun's does");
  ok((await junk.blob()).size === 3, "…and so does blob()");
  // 512 zero bytes is a valid EMPTY tar, not garbage — the one input that looks
  // like nothing and is legal.
  ok((await new B.Archive(new Uint8Array(512)).files()).size === 0, "512 zero bytes reads as an empty archive, not as an unrecognized one");
}

console.log("== Bun.Archive refuses the four shapes real Bun silently empties ==");
{
  // The only place this implementation is deliberately stricter than the binary,
  // and the reason is in the fixture: `silentlyEmpty` was recorded by running each
  // of these under real 1.3.6, and every one came back with ZERO entries and no
  // error. `new Archive(await other.files())` is the dangerous one, because
  // files() hands back exactly the Map that loses everything. The Bun.JSONC
  // precedent applies: stricter is a workaround, looser is a corrupt artifact
  // nobody is told about.
  const B = freshBun();
  const E = ARCHIVE_FIXTURE.silentlyEmpty;
  ok(E.fromMap === 0 && E.fromSet === 0 && E.fromArchive === 0 && E.bunFileValueSize === 0,
    "the recorded binary really does produce empty archives for all four (that is what we refuse)");
  const caught = async (fn) => { try { await fn(); return ""; } catch (e) { return String(e?.message ?? e); } };
  const map = new Map([["a.txt", "hello"], ["b.txt", "world"]]);
  for (const [label, fn, needle] of [
    ["new Archive(map)", () => new B.Archive(map), "Object.fromEntries(map)"],
    ["Archive.write(path, map)", () => B.Archive.write("/tmp/vv-arc-map.tar", map), "Object.fromEntries(map)"],
    ["new Archive(set)", () => new B.Archive(new Set(["a.txt"])), "a plain object"],
    ["new Archive(archive)", () => new B.Archive(new B.Archive({ "a.txt": "x" })), "Bun.Archive.write(path, archive)"],
  ]) {
    const message = await caught(fn);
    ok(message.includes("Bun.Archive"), `${label} is refused, naming the API`);
    ok(message.includes("EMPTY archive"), "…saying that real Bun would have written an empty archive");
    ok(message.includes(needle), `…and pointing at the fix: ${JSON.stringify(needle)}`);
  }
  // A BunFile as a VALUE is the fourth, and the most inviting: it looks exactly
  // like the obvious way to archive a file, and real Bun stores nothing.
  const bunFileMessage = await caught(() => new B.Archive({ "a.txt": B.file("/tmp/vv-arc-src.txt") }).bytes());
  ok(bunFileMessage.includes("await Bun.file(path).bytes()"), "a BunFile entry value is refused, naming the read that fixes it");
  ok(bunFileMessage.includes("ZERO bytes"), "…and saying what real Bun would have stored instead");
  // Each message must name the shape that was actually passed, through the door it
  // was passed to. A single shared string got this wrong and told a Set caller
  // about a Map.
  ok((await caught(() => new B.Archive(new Set(["a"])))).includes("a Set"), "the Set refusal says Set, not Map");
  ok((await caught(() => new B.Archive(map))).includes("new Bun.Archive(map)"), "the constructor refusal quotes the constructor call");
  ok((await caught(() => B.Archive.write("/tmp/vv-arc-map.tar", map))).includes("Bun.Archive.write(path, map)"),
    "…and the write refusal quotes the write call");
  // The refusals must not spread: the round-trip Bun DOES support has to work.
  ok([...(await new B.Archive(Object.fromEntries(map)).files()).keys()].join() === "a.txt,b.txt",
    "the fix the message recommends actually works: Object.fromEntries(map) archives both entries");
  ok((await (await new B.Archive(await new B.Archive({ "a.txt": "hi" }).bytes()).files()).get("a.txt").text()) === "hi",
    "…and new Archive(await other.bytes()) copies an archive, which is the other recommendation");
}

console.log("== Bun.Archive's smaller observable shapes ==");
{
  const B = freshBun();
  const O = ARCHIVE_FIXTURE.observed;
  const archive = new B.Archive({ "a.txt": "hello" });
  const bytes = await archive.bytes();
  ok(Buffer.isBuffer(bytes) === O.bytesIsBuffer, "bytes() resolves to a Buffer, not a bare Uint8Array, matching the binary");
  ok(bytes instanceof Uint8Array, "…which is still a Uint8Array, so either check passes");
  const blob = await archive.blob();
  ok(blob instanceof Blob && blob.type === "", "blob() resolves to a Blob with no type, as Bun's does");
  ok(blob.size === bytes.length, "…covering the same bytes");
  ok((await new B.Archive({}).bytes()).length === O.emptyArchiveLength,
    `an empty archive is still ${O.emptyArchiveLength} bytes — tar's 20-block record, which surprises everyone once`);
  ok(Object.prototype.toString.call(archive) === O.toStringTag, `Object.prototype.toString.call(archive) is ${JSON.stringify(O.toStringTag)}`);
  ok((await new B.Archive([]).files()).size === 0, "an array is an object, so Bun accepts one — empty here");
  ok([...(await new B.Archive(["x", "y"]).files()).keys()].join() === "0,1", "…and archives its members under the keys \"0\" and \"1\"");
  // The constructor's second argument is not in the published types and
  // Archive.length hides it, so it is easy to drop from a shim entirely.
  const compressed = await new B.Archive({ "a.txt": "hello" }, { compress: "gzip" }).bytes();
  ok(compressed[0] === 0x1f && compressed[1] === 0x8b, "new Archive(spec, { compress: 'gzip' }) gzips what bytes() returns");
  ok([...(await new B.Archive({ "a.txt": "hello" }, { compress: "gzip" }).files()).keys()].join() === "a.txt",
    "…and files() still reads it, because the tar is what gets parsed");
  // Read mode: bytes() is the input AS SUPPLIED, so a gzipped archive hands the
  // gzip back rather than the tar it holds.
  const gz = await new B.Archive({ "a.txt": "hello" }, { compress: "gzip" }).bytes();
  const reread = await new B.Archive(gz).bytes();
  ok(reread[0] === 0x1f && Buffer.compare(Buffer.from(reread), Buffer.from(gz)) === 0,
    "bytes() on a gzipped archive returns the gzip it was given, not the tar inside");
  // Every call is a fresh object in Bun, so nothing can be cached and handed out
  // twice — a caller that mutates the Buffer must not corrupt the archive.
  ok((await archive.bytes()) !== (await archive.bytes()), "bytes() hands back a fresh Buffer each call");
  ok((await archive.files()) !== (await archive.files()), "…and files() a fresh Map");
  // Argument validation throws SYNCHRONOUSLY in Bun even though these methods
  // return promises, so `write(...).catch(h)` never reaches `h` for a bad path —
  // it takes the process down. Rejecting instead would look kinder and silently
  // change which handler runs.
  const throwsSync = (fn) => {
    try { const r = fn(); if (r && typeof r.then === "function") { r.catch(() => {}); return false; } return false; }
    catch { return true; }
  };
  ok(throwsSync(() => B.Archive.write(7, { a: "b" })), "Archive.write() throws a bad path synchronously, not as a rejection");
  ok(throwsSync(() => B.Archive.write("/tmp/vv-arc-sync.tar", "str")), "…and bad entries synchronously");
  ok(throwsSync(() => new B.Archive({ a: "b" }).extract()), "extract() throws a missing path synchronously");
  ok(throwsSync(() => new B.Archive({ "ü": "x" }).bytes()), "…and bytes() throws a non-ASCII name synchronously, as the binary does");
  ok(!throwsSync(() => new B.Archive(new Uint8Array([1, 2, 3])).files()), "while an unreadable FORMAT rejects rather than throwing, which is also Bun's split");
  // Shapes Bun accepts that a plain `typeof x === "object"` check would refuse.
  // Each archives its own enumerable properties, which is usually none.
  for (const [label, value] of [["a function", () => {}], ["a Date", new Date()], ["a RegExp", /x/]]) {
    ok((await new B.Archive(value).files()).size === 0, `${label} is accepted and archives nothing, as in Bun`);
  }
  // A NUL typeflag (v7) and '7' (POSIX contiguous) are regular files. Dropping
  // either would lose an entry with no error — the failure this file is full of.
  const withFlag = async (flag) => {
    const t = new Uint8Array(await new B.Archive({ "c.txt": "contig" }).bytes());
    t[156] = flag;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : t[i];
    const ck = sum.toString(8).padStart(6, "0") + "\0 ";
    for (let i = 0; i < 8; i++) t[148 + i] = ck.charCodeAt(i);
    return [...(await new B.Archive(t).files()).keys()].join();
  };
  ok((await withFlag("7".charCodeAt(0))) === "c.txt", "typeflag '7' (contiguous) reads as a regular file, as it does in Bun");
  ok((await withFlag(0)) === "c.txt", "…and so does a NUL typeflag, which is what a v7 tar writes");
  // Bun's own name/prefix split rule, which decides what goes on disk. The last
  // fitting `/` — not the first — and a pax header when none fits. Driven through
  // the exported writer so the header bytes themselves are the assertion.
  const split = (name) => {
    const b = archiveWriteTar([{ name, bytes: new TextEncoder().encode("X") }]);
    return {
      typeflag: String.fromCharCode(b[156]),
      name: Buffer.from(b.subarray(0, 100)).toString("latin1").replace(/\0+$/, "").length,
      prefix: Buffer.from(b.subarray(345, 500)).toString("latin1").replace(/\0+$/, "").length,
    };
  };
  for (const [name, want, why] of [
    ["x/y/z/" + "l".repeat(100), { typeflag: "0", name: 100, prefix: 5 }, "the last slash leaves exactly 100 in the name field"],
    ["s".repeat(50) + "/" + "t".repeat(50) + "/" + "u".repeat(50), { typeflag: "0", name: 50, prefix: 101 }, "the LAST fitting slash, not the first — the two disagree here"],
    ["p".repeat(100) + "/" + "q".repeat(60) + "/" + "r".repeat(5), { typeflag: "0", name: 66, prefix: 100 }, "an earlier slash when the last one overflows the 155-byte prefix"],
    ["a/" + "b".repeat(120), { typeflag: "x", name: 99, prefix: 0 }, "a pax header when no slash can split it, its label keeping the directory part"],
    ["L".repeat(120), { typeflag: "x", name: 97, prefix: 0 }, "…and a bare `PaxHeader/` label when there is no directory part"],
    ["p".repeat(160) + "/" + "q".repeat(90), { typeflag: "x", name: 97, prefix: 0 }, "…and a directory over 155 bytes dropped from the label entirely"],
  ]) {
    const got = split(name);
    ok(JSON.stringify(got) === JSON.stringify(want), `a ${name.length}-byte name: ${why} — ${JSON.stringify(got)}`);
    ok([...(await new B.Archive({ [name]: "X" }).files()).keys()][0] === name, `…and the ${name.length}-byte name round-trips exactly`);
  }
}

// ---- 29) SigV4 against AWS's own published test suite ------------------------
// The signer is the part of an S3 client that cannot be checked by using it: a
// wrong signature comes back as 403 SignatureDoesNotMatch, which looks exactly
// like wrong credentials, and there are no credentials here to be right or wrong.
// So it is pinned to AWS's "Signature Version 4 Test Suite" — the fixture set AWS
// publishes for exactly this purpose, mirrored in awslabs/aws-c-auth under
// tests/aws-signing-test-suite/v4. Each case fixes the key, the date and the
// request, so the canonical-request / string-to-sign / signature triple is a
// constant. The lesson is the one from Bun.hash above: a signer that only agrees
// with itself is worth nothing, and looks identical to one that works.
{
  const crypto = nodeRequire("node:crypto");
  const H = createSigv4Hashers(crypto);
  // Every case in the suite shares these, and `service` is deliberately the
  // suite's literal "service" rather than "s3" — the point is the algorithm.
  const SUITE = {
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "service",
    amzDate: "20150830T123600Z",
    dateStamp: "20150830",
    // sign_body is false throughout the suite, so the payload hash is SHA-256 of
    // the empty string — the one place this file needs SHA256_EMPTY.
    payloadHash: SHA256_EMPTY,
    hashers: H,
  };
  const sign = (over) => sigv4({ ...SUITE, ...over });
  const lines = (...l) => l.join("\n");

  // get-vanilla: GET / with nothing but a Host header. If this one is wrong,
  // nothing else can be right.
  const vanilla = sign({
    method: "GET",
    canonicalUri: "/",
    query: [],
    headers: { Host: "example.amazonaws.com", "X-Amz-Date": "20150830T123600Z" },
  });
  ok(
    vanilla.canonicalRequest ===
      lines("GET", "/", "", "host:example.amazonaws.com", "x-amz-date:20150830T123600Z", "", "host;x-amz-date", SHA256_EMPTY),
    "get-vanilla canonical request matches AWS's byte for byte"
  );
  ok(
    vanilla.stringToSign ===
      lines("AWS4-HMAC-SHA256", "20150830T123600Z", "20150830/us-east-1/service/aws4_request", "bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63"),
    "…and so does the string to sign, hash of the canonical request included"
  );
  ok(vanilla.signature === "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31", "…and the signature AWS publishes for it");

  // get-header-value-trim: sequential spaces inside a header value collapse, and
  // the value is trimmed. Getting this wrong breaks only requests with odd
  // headers, which is the kind of bug that ships.
  const trimmed = sign({
    method: "GET",
    canonicalUri: "/",
    query: [],
    headers: {
      Host: "example.amazonaws.com",
      "My-Header1": " value1 ",
      "My-Header2": ' "a   b   c" ',
      "X-Amz-Date": "20150830T123600Z",
    },
  });
  ok(
    /\nmy-header2:"a b c"\n/.test(trimmed.canonicalRequest),
    "get-header-value-trim collapses runs of spaces in a header value: " + JSON.stringify(/my-header2:.*/.exec(trimmed.canonicalRequest)[0])
  );
  ok(trimmed.signature === "acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736", "…to AWS's published signature");

  // get-utf8: the path is percent-encoded per RFC 3986 before it is signed, which
  // is the same encoder every object key goes through.
  const utf8 = sign({
    method: "GET",
    canonicalUri: awsUriEncode("/\u1234", false),
    query: [],
    headers: { Host: "example.amazonaws.com", "X-Amz-Date": "20150830T123600Z" },
  });
  ok(utf8.canonicalRequest.split("\n")[1] === "/%E1%88%B4", "get-utf8 signs the percent-encoded path: " + utf8.canonicalRequest.split("\n")[1]);
  ok(utf8.signature === "8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85", "…to AWS's published signature");

  // get-vanilla-query-order-key-case: query parameters are sorted by encoded name
  // before signing, whatever order the caller wrote them in. `list` depends on
  // this — it sends four of them.
  const ordered = sign({
    method: "GET",
    canonicalUri: "/",
    query: [
      ["Param2", "value2"],
      ["Param1", "value1"],
    ],
    headers: { Host: "example.amazonaws.com", "X-Amz-Date": "20150830T123600Z" },
  });
  ok(ordered.canonicalRequest.split("\n")[2] === "Param1=value1&Param2=value2", "query parameters are sorted, not passed through: " + ordered.canonicalRequest.split("\n")[2]);
  ok(ordered.signature === "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500", "…to AWS's published signature");

  // The query (presigned) flavour of the same suite case: the credential material
  // moves into the query string and x-amz-date leaves the header block, so this
  // exercises the path `presign` takes rather than the header path above.
  const presigned = sign({
    method: "GET",
    canonicalUri: "/",
    query: [
      ["Param1", "value1"],
      ["Param2", "value2"],
      ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
      ["X-Amz-Credential", "AKIDEXAMPLE/20150830/us-east-1/service/aws4_request"],
      ["X-Amz-Date", "20150830T123600Z"],
      ["X-Amz-Expires", "3600"],
      ["X-Amz-SignedHeaders", "host"],
    ],
    headers: { Host: "example.amazonaws.com" },
  });
  ok(presigned.signature === "86012e2c9ad4d77369f5d81c11f75158aae4f895a085212cc6d3f923d300bed5", "the query-string flavour matches AWS's published query signature too");

  // post-vanilla-query: the method really is part of the canonical request.
  const posted = sign({
    method: "POST",
    canonicalUri: "/",
    query: [["Param1", "value1"]],
    headers: { Host: "example.amazonaws.com", "X-Amz-Date": "20150830T123600Z" },
  });
  ok(posted.signature === "28038455d6de14eafc1f9222cf5aa6f1a96197d7deb8263271d420d138af7f11", "post-vanilla-query matches AWS's published signature (the verb is signed)");
  ok(posted.signature !== ordered.signature, "…and a POST does not sign like a GET");
}

// ---- 30) the requests this client actually puts on the wire ------------------
// Vector-correct signing over the wrong request is still the wrong request. These
// are frozen against a real `bun` 1.3.6 talking to a local HTTP server that
// recorded what arrived: same credentials, same clock (the date is injected), so
// the Authorization header is comparable byte for byte. Two measured details are
// asserted because they are the kind a from-scratch signer gets wrong in the safe
// direction: Bun sends `x-amz-content-sha256: UNSIGNED-PAYLOAD` on every request
// including PUT, and it signs ONLY host and the x-amz-* headers — Range and
// Content-Type go on the wire unsigned.
{
  const crypto = nodeRequire("node:crypto");
  const H = createSigv4Hashers(crypto);
  const config = resolveS3Config(
    {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      bucket: "bkt",
      endpoint: "http://127.0.0.1:9111",
    },
    {}
  );
  const DATE = Date.parse("2026-08-04T08:20:01Z");
  const build = (over) => buildS3Request({ config, date: DATE, hashers: H, ...over });
  const sigOf = (r) => /Signature=([a-f0-9]+)/.exec(r.headers.authorization)[1];
  const signedHeadersOf = (r) => /SignedHeaders=([^,]+)/.exec(r.headers.authorization)[1];

  const get = build({ method: "GET", key: "hello.txt" });
  ok(
    get.headers.authorization ===
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260804/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=3aa9ebdd141d5a98340c2d6e4dd1931db457a1fef7831be86804bf932d9afbde",
    "a GET's whole Authorization header is the one bun 1.3.6 sent for the same request and clock"
  );
  ok(get.url === "http://127.0.0.1:9111/bkt/hello.txt", "…to the path-style URL: " + get.url);
  ok(get.headers["x-amz-content-sha256"] === "UNSIGNED-PAYLOAD", "…with UNSIGNED-PAYLOAD, which is what the binary sends");
  ok(sigOf(build({ method: "HEAD", key: "hello.txt" })) === "580d2012ce432f8797d2ef4299ce00fd7abfdf22494a9ad59e389800b2546dc0", "HEAD (exists/stat/size) matches the binary");
  ok(sigOf(build({ method: "PUT", key: "out.txt" })) === "690e89d32f25afc831b77fac780bfb016e7c4ce6acf12095fbb409329b3b0efe", "PUT matches the binary — the body is NOT hashed into the signature");
  ok(sigOf(build({ method: "DELETE", key: "gone.txt" })) === "e743c26530ba0cbeb147867d86ed8086302f97d6d9cab88793e257ea39f40aa1", "DELETE matches the binary");

  const list = build({
    method: "GET",
    key: null,
    query: [
      ["list-type", "2"],
      ["prefix", "p/"],
      ["max-keys", "100"],
      ["delimiter", "/"],
    ],
  });
  ok(list.url === "http://127.0.0.1:9111/bkt/?delimiter=%2F&list-type=2&max-keys=100&prefix=p%2F", "list sorts and encodes its query: " + list.url);
  ok(sigOf(list) === "dc58364e75148c38178172a3ac7399eadebae27bbd9bd91cd69c6231c954891b", "…and signs it the way the binary did");

  // The header partition. `x-amz-*` in, everything else out — measured, not
  // chosen: a signature over Range breaks the moment anything between the page
  // and S3 rewrites it, and the binary does not take that risk either.
  const ranged = build({ method: "GET", key: "hello.txt", extraHeaders: { range: "bytes=0-4" } });
  ok(ranged.headers.range === "bytes=0-4", "a Range header goes on the wire");
  ok(signedHeadersOf(ranged) === "host;x-amz-content-sha256;x-amz-date", "…and stays out of SignedHeaders, like the binary: " + signedHeadersOf(ranged));
  ok(sigOf(ranged) === sigOf(get), "…so a ranged GET signs exactly like the whole-object GET");
  const acl = build({ method: "PUT", key: "acl.txt", extraHeaders: { "x-amz-acl": "public-read", "x-amz-storage-class": "GLACIER" } });
  ok(signedHeadersOf(acl) === "host;x-amz-acl;x-amz-content-sha256;x-amz-date;x-amz-storage-class", "x-amz-* headers ARE signed, sorted: " + signedHeadersOf(acl));
  const token = buildS3Request({ config: { ...config, sessionToken: "SESSIONTOKEN123" }, method: "PUT", key: "tok.txt", date: DATE, hashers: H });
  ok(signedHeadersOf(token) === "host;x-amz-content-sha256;x-amz-date;x-amz-security-token", "a session token rides as a signed x-amz-security-token: " + signedHeadersOf(token));

  // Endpoint styles. Virtual-hosted moves the bucket into the Host header, which
  // means it is signed there and NOT in the path — signing both is a classic way
  // to get a 403 that looks like bad credentials.
  // Key parsing, every case read off the binary. The surprises: Bun strips ANY
  // `<scheme>://` prefix, not just `s3://`, so `file("https://host/x")` is the KEY
  // `host/x` and not a URL fetch; nothing is normalised, so `..` stays in the key
  // because S3 treats it as a name; and the first segment becomes the bucket only
  // when none is configured. Guessing any of these produces a client that reads
  // and writes the wrong object.
  const B = freshBun();
  const keyed = new B.S3Client({ accessKeyId: "A", secretAccessKey: "B", bucket: "b" });
  const bucketless = new B.S3Client({ accessKeyId: "A", secretAccessKey: "B" });
  const target = (client, key) => {
    try { return decodeURIComponent(client.presign(key).split("?")[0].replace("https://s3.us-east-1.amazonaws.com/", "")); } catch (e) { return e.code; }
  };
  for (const [key, want, why] of [
    ["https://example.com/x", "b/example.com/x", "an https:// URL is a key, scheme stripped — not a fetch"],
    ["s3://other/k", "b/other/k", "an s3:// bucket is ignored when the client has one"],
    ["gs://x/y", "b/x/y", "any scheme is stripped, not just s3://"],
    ["file:///a/b", "b/a/b", "…and the extra slashes with it"],
    ["/leading", "b/leading", "a leading slash is dropped"],
    ["a//b", "b/a//b", "an interior empty segment is kept, because S3 keeps it"],
    ["a/../b", "b/a/../b", "`..` is a key segment, not a path to resolve"],
    ["", "ERR_S3_INVALID_PATH", "an empty key is refused"],
  ]) {
    ok(target(keyed, key) === want, "key " + JSON.stringify(key) + ": " + why + " (" + target(keyed, key) + ")");
  }
  ok(target(bucketless, "s3://bk/k") === "bk/k", "with no bucket configured, the first segment becomes the bucket");
  ok(target(bucketless, "single") === "ERR_S3_INVALID_PATH", "…so a single-segment key has nowhere to go and is refused");

  const vhost = buildS3Request({ config: resolveS3Config({ ...config, endpoint: undefined, virtualHostedStyle: true }, {}), method: "GET", key: "k", date: DATE, hashers: H });
  ok(vhost.host === "bkt.s3.us-east-1.amazonaws.com" && vhost.path === "/k", "virtualHostedStyle puts the bucket in Host and drops it from the path: " + vhost.host + vhost.path);
  ok(vhost.signed.canonicalRequest.split("\n")[1] === "/k", "…and signs the path without it");
}

// ---- 31) presign, independently recomputed -----------------------------------
// A presigned URL is the one thing here a user can hand to somebody else, so it
// is checked twice: against a URL a real bun printed, and against a SigV4 chain
// written out longhand below over node:crypto. The longhand version shares no
// code with the implementation, which is the only reason it is worth running.
{
  const crypto = nodeRequire("node:crypto");
  const H = createSigv4Hashers(crypto);
  const P = Date.parse("2026-08-04T08:19:18Z");
  const cfg = resolveS3Config({ accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", bucket: "examplebucket" }, {});
  const url = presignS3Url({ config: cfg, key: "test.txt", expiresIn: 86400, date: P, hashers: H }).url;
  ok(
    url ===
      "https://s3.us-east-1.amazonaws.com/examplebucket/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260804%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260804T081918Z&X-Amz-Expires=86400&X-Amz-Signature=63cf5e3846368f52e09b90da572dd7fb829fe0ed9caa93994b17f880caa32382&X-Amz-SignedHeaders=host",
    "presign reproduces the URL bun 1.3.6 printed for the same key, expiry and clock"
  );

  const q = new URL(url).searchParams;
  ok(q.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256", "the URL carries X-Amz-Algorithm");
  ok(q.get("X-Amz-Credential") === "AKIAIOSFODNN7EXAMPLE/20260804/us-east-1/s3/aws4_request", "…X-Amz-Credential with the full scope");
  ok(q.get("X-Amz-Date") === "20260804T081918Z" && q.get("X-Amz-Expires") === "86400", "…X-Amz-Date and X-Amz-Expires");
  ok(q.get("X-Amz-SignedHeaders") === "host", "…X-Amz-SignedHeaders=host, so the URL needs no headers to be usable");
  ok(!/x-amz-content-sha256/i.test(url), "…and no content hash, which is header-signing only");
  const params = [...q.keys()];
  ok(JSON.stringify(params) === JSON.stringify([...params].sort()), "the query is in sorted order, as the canonical request requires: " + params.join(","));

  // The independent chain: RFC-4 by hand, sharing nothing with bun-s3.js.
  const hmac = (key, data) => crypto.createHmac("sha256", key).update(data, "utf8").digest();
  const sha256hex = (data) => crypto.createHash("sha256").update(data, "utf8").digest("hex");
  const canonicalQuery = [...q.entries()]
    .filter(([k]) => k !== "X-Amz-Signature")
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => k + "=" + v)
    .join("&");
  const canonicalRequest = ["GET", "/examplebucket/test.txt", canonicalQuery, "host:s3.us-east-1.amazonaws.com", "", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", "20260804T081918Z", "20260804/us-east-1/s3/aws4_request", sha256hex(canonicalRequest)].join("\n");
  let signingKey = hmac("AWS4wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "20260804");
  for (const part of ["us-east-1", "s3", "aws4_request"]) signingKey = hmac(signingKey, part);
  const independent = crypto.createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  ok(independent === q.get("X-Amz-Signature"), "a SigV4 chain written out longhand here signs the same URL identically: " + independent.slice(0, 16) + "…");

  // Options that change the URL rather than only the signature.
  const abcfg = resolveS3Config({ accessKeyId: "A", secretAccessKey: "B", bucket: "bkt" }, {});
  ok(new URL(presignS3Url({ config: abcfg, key: "k", date: P, hashers: H }).url).searchParams.get("X-Amz-Expires") === "86400", "the default expiry is Bun's 86400 seconds");
  const put = presignS3Url({ config: abcfg, key: "k", method: "PUT", expiresIn: 60, acl: "public-read", date: P, hashers: H }).url;
  ok(new URL(put).searchParams.get("X-Amz-Acl") === "public-read", "presign('k', { acl }) signs the ACL into the URL");
  ok(
    put ===
      "https://s3.us-east-1.amazonaws.com/bkt/k?X-Amz-Acl=public-read&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=A%2F20260804%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260804T081918Z&X-Amz-Expires=60&X-Amz-Signature=af5b3abb9179a001718a2fb67ef855b7142e2fa9303f96464c475bb606aacbca&X-Amz-SignedHeaders=host",
    "…and the whole PUT URL is the binary's, ACL included"
  );
  ok(
    presignS3Url({ config: resolveS3Config({ accessKeyId: "A", secretAccessKey: "B", bucket: "bkt", endpoint: "http://127.0.0.1:9000" }, {}), key: "k", date: P, hashers: H }).url.indexOf("%2Fauto%2Fs3%2F") !== -1,
    "a custom endpoint with no region signs for region 'auto', which is what the binary does"
  );

  // The validation Bun does before signing, and it is fussier than it looks. Each
  // of these was read off 1.3.6, including the misspelling and the fact that POST
  // signs fine despite every message claiming four methods.
  const B = freshBun();
  const client = new B.S3Client({ accessKeyId: "A", secretAccessKey: "B", bucket: "bkt" });
  const failure = (fn) => { try { fn(); return "ok"; } catch (e) { return e.code + ": " + e.message; } };
  ok(failure(() => client.presign("k", { method: "POST" })) === "ok", "presign accepts POST, which the binary signs even though its error text lists four methods");
  ok(failure(() => client.presign("k", { method: "get" })) === "ok", "…and a lowercase method, which it upper-cases");
  ok(client.presign("k", { method: "" }) === client.presign("k"), "…and an empty method, which means GET");
  ok(
    failure(() => client.presign("k", { method: "PATCH" })) === "ERR_S3_INVALID_METHOD: Method must be GET, PUT, DELETE or HEAD when using s3:// protocol",
    "a real HTTP method S3 has no use for is ERR_S3_INVALID_METHOD: " + failure(() => client.presign("k", { method: "PATCH" }))
  );
  ok(
    failure(() => client.presign("k", { method: "GETX" })) === "ERR_INVALID_ARG_TYPE: method must be GET, PUT, DELETE or HEAD when using s3 protocol",
    "…while a token that is not a method at all is ERR_INVALID_ARG_TYPE, with the lowercase wording: " + failure(() => client.presign("k", { method: "GETX" }))
  );
  for (const bad of [-1, 0, "abc"]) {
    ok(
      failure(() => client.presign("k", { expiresIn: bad })) === "ERR_INVALID_ARG_TYPE: expiresIn must be greather than 0",
      "expiresIn " + JSON.stringify(bad) + " is refused in Bun's words, misspelling included"
    );
  }
}

// ---- 32) the browser is not the Bun binary: CORS and S3 errors ---------------
// The failure this section exists for: in a page, a bucket with no CORS policy
// makes fetch() reject with a bare `TypeError: Failed to fetch`. No status, no
// body, nothing to log — it reads as a bug in the caller's own code, and the
// caller cannot know that the fix is a bucket setting rather than their key. It
// must not be confused with the other failure, a bucket that answered and said
// no: that one has a status and an S3 error code, and this asserts both paths.
{
  const B = freshBun();
  const client = new B.S3Client({ accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", bucket: "bkt" });
  const realFetch = globalThis.fetch;
  const seen = [];
  const reply = (status, body, headers) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers || {}),
    text: async () => body || "",
    arrayBuffer: async () => new TextEncoder().encode(body || "").buffer,
    json: async () => JSON.parse(body),
  });
  const stub = (handler) => {
    seen.length = 0;
    globalThis.fetch = async (url, init) => {
      seen.push({ url, ...init });
      return handler(url, init);
    };
  };

  try {
    // The blocked case. `TypeError: Failed to fetch` is Chrome's wording; Firefox
    // says "NetworkError when attempting to fetch resource" and Safari something
    // else again, so the rethrow is driven by the fetch REJECTING, not by the text.
    stub(() => {
      throw new TypeError("Failed to fetch");
    });
    let blocked = null;
    try { await client.file("hello.txt").text(); } catch (e) { blocked = e; }
    ok(blocked && blocked.code === "ERR_S3_REQUEST_BLOCKED", "a rejected fetch becomes ERR_S3_REQUEST_BLOCKED, not a bare TypeError: " + (blocked && blocked.code));
    ok(/\bCORS\b/.test(blocked.message), "…and the message says CORS");
    ok(/browser/i.test(blocked.message), "…and says the request came from a browser");
    ok(/preflight/.test(blocked.message), "…and warns that x-amz-* headers trigger a preflight");
    ok(/x-amz-content-sha256/.test(blocked.message) && /authorization/.test(blocked.message), "…and names the headers the policy has to allow");
    ok(/no HTTP status to report/.test(blocked.message), "…and says plainly that nothing answered");
    ok(/AccessDenied/.test(blocked.message), "…contrasting it with the S3 codes a bucket that DID answer would return");
    ok(blocked.cause instanceof TypeError, "…keeping the original TypeError as `cause` for anyone who wants it");
    ok(blocked.name === "S3Error", "…under the name Bun uses for its own S3 errors");

    // The answered case. Same shape as Bun's: name, code from the XML, status, path.
    stub(() => reply(403, '<?xml version="1.0" encoding="UTF-8"?><Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match the signature you provided.</Message></Error>'));
    let denied = null;
    try { await client.file("hello.txt").text(); } catch (e) { denied = e; }
    ok(denied && denied.code === "SignatureDoesNotMatch", "a bucket that answers 403 gives S3's own error code: " + (denied && denied.code));
    ok(denied.status === 403 && denied.path === "hello.txt", "…with the HTTP status and the key");
    ok(!/CORS/.test(denied.message), "…and does NOT mention CORS, because the request plainly arrived");
    ok(denied.message === "The request signature we calculated does not match the signature you provided.", "…using S3's Message verbatim: " + JSON.stringify(denied.message));

    // A status with no usable body still has to say something. 404 is the one to
    // check because `exists()` treats it as an answer rather than an error.
    stub(() => reply(404, ""));
    let missing = null;
    try { await client.stat("nope.txt"); } catch (e) { missing = e; }
    ok(missing && missing.code === "NoSuchKey" && missing.message === "The specified key does not exist.", "a bodyless 404 is still NoSuchKey with Bun's message: " + (missing && missing.code));
    ok((await client.exists("nope.txt")) === false, "…while exists() reads that same 404 as false, not as a failure");

    // The requests themselves, driven through the public API this time.
    stub(() => reply(200, "hello world", { "content-type": "text/plain", "content-length": "11", etag: '"9a0364b9e99bb480dd25e1f0284c8555"', "last-modified": "Tue, 02 Jan 2024 03:04:05 GMT" }));
    ok((await client.file("hello.txt").text()) === "hello world", "file().text() returns the body S3 sent");
    ok(seen[0].method === "GET" && seen[0].url === "https://s3.us-east-1.amazonaws.com/bkt/hello.txt", "…from a GET to the path-style URL: " + seen[0].url);
    ok(seen[0].headers.host === "s3.us-east-1.amazonaws.com", "…with an explicit Host header, the one thing SigV4 always signs");

    stub(() => reply(206, "hello", { "content-range": "bytes 0-4/11" }));
    ok((await client.file("hello.txt").slice(0, 5).text()) === "hello", "file().slice() reads a window");
    ok(seen[0].headers.range === "bytes=0-4", "…as a Range header, so a slice of a large object transfers the slice: " + seen[0].headers.range);
    ok(seen.length === 1, "…and slice() itself fetched nothing until something read it");

    stub(() => reply(200, ""));
    ok((await client.write("out.txt", "hello world")) === 11, "write() returns the number of bytes it sent");
    ok(seen[0].method === "PUT" && seen[0].body.length === 11, "…as a single PUT carrying the body");
    ok(seen[0].headers["content-type"] === "application/octet-stream", "…typed application/octet-stream like the binary, even for a string: " + seen[0].headers["content-type"]);
    ok((await client.write("out.txt", "x", { type: "text/csv" })) === 1, "write(…, { type }) still returns the byte count");
    ok(seen[1].headers["content-type"] === "text/csv", "…and sends the type the caller asked for");

    stub(() => reply(200, ""));
    ok((await client.delete("gone.txt")) === true, "delete() resolves true");
    ok(seen[0].method === "DELETE", "…from a DELETE");

    stub(() => reply(200, "", { "content-length": "11", etag: '"deadbeef"', "content-type": "text/plain", "last-modified": "Tue, 02 Jan 2024 03:04:05 GMT" }));
    const stat = await client.stat("hello.txt");
    ok(seen[0].method === "HEAD", "stat() is a HEAD, so it moves no bytes");
    ok(stat.size === 11 && stat.etag === '"deadbeef"' && stat.type === "text/plain", "…and reports size, etag and type off the headers");
    ok(stat.lastModified instanceof Date && stat.lastModified.toISOString() === "2024-01-02T03:04:05.000Z", "…with lastModified as a Date, which is Bun's shape");
    ok((await client.size("hello.txt")) === 11, "size() is the same HEAD, reduced to the number");

    // The second CORS trap, and the quiet one. A cross-origin response only shows
    // script the headers the bucket lists in ExposeHeaders, so a HEAD can succeed
    // with Content-Length and ETag invisible. stat() reports what it can see;
    // size(), whose whole job is a number, refuses rather than returning null —
    // null becomes 0 in arithmetic and the object looks empty.
    stub(() => reply(200, "", { "content-type": "text/plain" }));
    const hidden = await client.stat("hello.txt");
    ok(hidden.size === null && hidden.etag === undefined, "with nothing exposed, stat() reports size null rather than inventing a number");
    let hiddenErr = null;
    try { await client.size("hello.txt"); } catch (e) { hiddenErr = e; }
    ok(hiddenErr && hiddenErr.code === "ERR_S3_HEADER_NOT_EXPOSED", "…and size() throws instead of handing back null: " + (hiddenErr && hiddenErr.code));
    ok(/ExposeHeaders/.test(hiddenErr.message) && /Content-Length/.test(hiddenErr.message), "…naming the CORS setting that fixes it");
    ok(/browser rule, not an S3 one/.test(hiddenErr.message), "…and saying whose rule it is, since the same call works in the binary");

    stub(() => reply(200, '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>bkt</Name><Prefix>p/</Prefix><KeyCount>1</KeyCount><MaxKeys>100</MaxKeys><IsTruncated>true</IsTruncated><NextContinuationToken>tok</NextContinuationToken><Contents><Key>p/a.txt</Key><LastModified>2024-01-02T03:04:05.000Z</LastModified><ETag>&quot;abc123&quot;</ETag><Size>11</Size><StorageClass>STANDARD</StorageClass><Owner><ID>oid</ID><DisplayName>od</DisplayName></Owner></Contents><CommonPrefixes><Prefix>p/sub/</Prefix></CommonPrefixes></ListBucketResult>'));
    const listed = await client.list({ prefix: "p/", maxKeys: 100, delimiter: "/" });
    ok(seen[0].url === "https://s3.us-east-1.amazonaws.com/bkt/?delimiter=%2F&list-type=2&max-keys=100&prefix=p%2F", "list() asks for ListObjectsV2 with a sorted query: " + seen[0].url);
    ok(listed.contents[0].key === "p/a.txt" && listed.contents[0].size === 11 && listed.contents[0].eTag === '"abc123"', "…and parses Contents into Bun's camelCase shape");
    // stat() hands back a Date and list() hands back the raw ISO string. That is
    // Bun, measured both ways, and it is the kind of inconsistency a shim
    // "tidies up" into a bug: `list()` results that suddenly have Date methods.
    ok(listed.contents[0].lastModified === "2024-01-02T03:04:05.000Z", "…with lastModified left as the string S3 sent, which is what list() does in Bun");
    ok(listed.commonPrefixes[0].prefix === "p/sub/" && listed.isTruncated === true && listed.nextContinuationToken === "tok", "…plus commonPrefixes and the truncation cursor");
    // The whole object, against what `bun run` printed for the same XML. Key order
    // included: it is visible in a log and in JSON.stringify, and a field Bun omits
    // when S3 omits it is different from one that is present and undefined.
    ok(
      JSON.stringify(listed) ===
        '{"name":"bkt","prefix":"p/","nextContinuationToken":"tok","isTruncated":true,"keyCount":1,"maxKeys":100,"contents":[{"key":"p/a.txt","eTag":"\\"abc123\\"","lastModified":"2024-01-02T03:04:05.000Z","size":11,"storageClass":"STANDARD","owner":{"id":"oid","displayName":"od"}}],"commonPrefixes":[{"prefix":"p/sub/"}]}',
      "…and the whole result serialises exactly as the binary's did, fields in Bun's order"
    );
    // Bun's own misspelling. `checksumAlgorithme` is the name callers destructure,
    // so correcting it would break them; it is copied, not fixed.
    stub(() => reply(200, '<?xml version="1.0"?><ListBucketResult><Name>bkt</Name><Prefix>p/</Prefix><Delimiter>/</Delimiter><KeyCount>1</KeyCount><MaxKeys>100</MaxKeys><IsTruncated>false</IsTruncated><Contents><Key>a</Key><LastModified>2024-01-02T03:04:06.000Z</LastModified><ETag>&quot;e2&quot;</ETag><Size>2</Size><StorageClass>GLACIER</StorageClass><ChecksumAlgorithm>CRC32</ChecksumAlgorithm></Contents></ListBucketResult>'));
    const checksummed = await client.list({ delimiter: "/" });
    ok(checksummed.contents[0].checksumAlgorithme === "CRC32", "a ChecksumAlgorithm arrives under Bun's misspelled `checksumAlgorithme`");
    ok(checksummed.delimiter === "/" && checksummed.commonPrefixes === undefined, "…and a delimiter with no common prefixes leaves commonPrefixes off the result entirely");

    // Bun.file()/Bun.write() route an s3:// path to the default client. With no
    // credentials in this process that has to be the credentials error, which is
    // also proof the routing happened at all.
    let routed = "";
    try { B.file("s3://bkt/k"); } catch (e) { routed = e.code || ""; }
    ok(routed === "ERR_S3_MISSING_CREDENTIALS", "Bun.file('s3://…') goes to the S3 client, not the filesystem: " + routed);
    ok(B.file("S3://bkt/k").name === "S3://bkt/k", "…while 'S3://' uppercase is a LOCAL file, as it is under bun — the test is case-sensitive there");

    // A file remembers which bucket it came from. This is the bug that made it
    // worth asserting: an S3File used to ask the client again through an
    // `s3://bucket/key` string, and a client with a bucket of its own parsed that
    // bucket a SECOND time — `client.file("s3://other/k")` on a client for `bkt`
    // signed `/bkt/bkt/other/k`. Bun ignores the bucket in the URL when the client
    // has one, so the key is `other/k` in `bkt`, and `name` keeps the whole
    // scheme-stripped string it was given.
    const embedded = client.file("s3://other/k");
    ok(embedded.name === "other/k" && embedded.bucket === "bkt", "a bucket inside the path is ignored when the client has one: " + embedded.bucket + "/" + embedded.name);
    ok(embedded.presign().indexOf("/bkt/other/k?") !== -1, "…and the presigned URL names that bucket once: " + embedded.presign().split("?")[0]);
    ok(client.file("k").slice(0, 5).name === "k", "slice() keeps the name it was sliced from");

    // The S3File surface, against the binary's prototype. The two sentinels are the
    // interesting part: an unread S3File reports `size: NaN` (not 0, not null) and
    // `lastModified: 2^52-1`, because answering either honestly would need a HEAD,
    // and a getter that fires a network request is not something a caller can see.
    const handle = client.file("k");
    for (const m of ["text", "json", "arrayBuffer", "bytes", "formData", "slice", "stream", "exists", "stat", "delete", "unlink", "write", "presign", "writer"]) {
      ok(typeof handle[m] === "function", "S3File." + m + "() exists, as it does on the binary's S3File");
    }
    ok(Number.isNaN(handle.size), "an unread S3File reports size NaN, which is the binary's sentinel: " + handle.size);
    ok(handle.lastModified === 4503599627370495, "…and lastModified 2^52-1, WebKit's Blob placeholder: " + handle.lastModified);
    ok(handle.type === "" && client.file("k", { type: "text/csv" }).type === "text/csv", "type is empty until given, and kept when given");
    ok(handle.bucket === "bkt", "…and the file knows its bucket");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---- 33) the default client is the environment -------------------------------
// `Bun.s3` is not a class, it is a client already built from process.env, and the
// variable names and their precedence are part of the API: code written against a
// deploy that sets AWS_* must not silently get an unconfigured client here. The
// precedence below is measured — S3_* wins, and AWS_DEFAULT_REGION is not read at
// all, which is worth pinning because every AWS SDK does read it.
{
  const withEnv = (env) => createBunRuntime({ process: { env, argv: ["bun"], cwd: () => "/" }, Buffer, require: nodeRequire }).Bun;
  const scopeOf = (url) => decodeURIComponent(new URL(url).searchParams.get("X-Amz-Credential"));

  const s3 = withEnv({ S3_ACCESS_KEY_ID: "AKID", S3_SECRET_ACCESS_KEY: "SECRET", S3_BUCKET: "from-env", S3_REGION: "eu-west-1" }).s3;
  ok(typeof s3 === "object" && typeof s3.file === "function", "Bun.s3 is an object with the client methods on it, not a class");
  const url = s3.presign("k");
  ok(url.startsWith("https://s3.eu-west-1.amazonaws.com/from-env/k?"), "…pointed at the bucket and region from S3_*: " + url.split("?")[0]);
  ok(scopeOf(url) === "AKID/" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + "/eu-west-1/s3/aws4_request", "…signed with the S3_ACCESS_KEY_ID from the environment: " + scopeOf(url));

  const aws = withEnv({ AWS_ACCESS_KEY_ID: "AWSKID", AWS_SECRET_ACCESS_KEY: "AWSSECRET", AWS_BUCKET: "aws-bucket", AWS_REGION: "ap-south-1" }).s3;
  ok(aws.presign("k").startsWith("https://s3.ap-south-1.amazonaws.com/aws-bucket/k?"), "the AWS_* spellings work on their own: " + aws.presign("k").split("?")[0]);
  const both = withEnv({ S3_ACCESS_KEY_ID: "S3KID", S3_SECRET_ACCESS_KEY: "S3SECRET", S3_REGION: "us-west-1", AWS_ACCESS_KEY_ID: "AWSKID", AWS_SECRET_ACCESS_KEY: "AWSSECRET", AWS_REGION: "ap-south-1", S3_BUCKET: "b" }).s3;
  ok(scopeOf(both.presign("k")).startsWith("S3KID/"), "S3_* wins over AWS_* when both are set: " + scopeOf(both.presign("k")));
  ok(scopeOf(both.presign("k")).indexOf("/us-west-1/") !== -1, "…for the region too");
  const dflt = withEnv({ S3_ACCESS_KEY_ID: "A", S3_SECRET_ACCESS_KEY: "B", S3_BUCKET: "b", AWS_DEFAULT_REGION: "sa-east-1" }).s3;
  ok(scopeOf(dflt.presign("k")).indexOf("/us-east-1/") !== -1, "AWS_DEFAULT_REGION is ignored, exactly as the binary ignores it: " + scopeOf(dflt.presign("k")));

  // The two names that are easy to leave out and impossible to notice missing:
  // without the session token an STS credential signs and is refused, and without
  // the endpoint every request quietly goes to AWS instead of MinIO or R2.
  const base = { S3_ACCESS_KEY_ID: "A", S3_SECRET_ACCESS_KEY: "B", S3_BUCKET: "b" };
  for (const name of ["S3_SESSION_TOKEN", "AWS_SESSION_TOKEN"]) {
    const url = withEnv({ ...base, [name]: "TOK" }).s3.presign("k");
    ok(new URL(url).searchParams.get("X-Amz-Security-Token") === "TOK", name + " becomes X-Amz-Security-Token");
  }
  for (const name of ["S3_ENDPOINT", "AWS_ENDPOINT"]) {
    const url = withEnv({ ...base, [name]: "http://127.0.0.1:9000" }).s3.presign("k");
    ok(url.startsWith("http://127.0.0.1:9000/b/k?"), name + " redirects the client at an S3-compatible server: " + url.split("?")[0]);
    ok(scopeOf(url).indexOf("/auto/") !== -1, "…signing for region 'auto' when no region is set, as the binary does");
  }
  ok(
    withEnv({ ...base, S3_ENDPOINT: "http://s3e:1", AWS_ENDPOINT: "http://awse:1" }).s3.presign("k").startsWith("http://s3e:1/"),
    "S3_ENDPOINT wins over AWS_ENDPOINT, like every other pair"
  );

  // No credentials. This must be an error and not a client that builds URLs
  // nobody can use — and it must arrive on use, not on import, because reading
  // `Bun.s3` at module scope has to stay safe.
  const bare = withEnv({});
  ok(typeof bare.s3 === "object", "an unconfigured Bun.s3 still exists rather than throwing on access");
  for (const call of [() => bare.s3.presign("k"), () => bare.s3.file("k"), () => bare.s3.list({}), () => bare.s3.write("k", "v"), () => bare.s3.delete("k")]) {
    let code = "";
    let message = "";
    try { const r = call(); if (r && typeof r.catch === "function") await r.catch((e) => { throw e; }); } catch (e) { code = e.code || ""; message = String(e.message || e); }
    ok(code === "ERR_S3_MISSING_CREDENTIALS", "…and every call on it is ERR_S3_MISSING_CREDENTIALS: " + code);
    ok(message === "Missing S3 credentials. 'accessKeyId', 'secretAccessKey', 'bucket', and 'endpoint' are required", "…in Bun's exact words: " + JSON.stringify(message.slice(0, 30)));
  }
  // Credentials but nowhere to put the object: a different error, in Bun's order.
  // The binary reports the missing credentials FIRST when both are missing, so
  // this only appears once the keys are there.
  let noBucket = "";
  try { new (withEnv({}).S3Client)({ accessKeyId: "A", secretAccessKey: "B" }).presign("k"); } catch (e) { noBucket = e.code + ": " + e.message; }
  ok(noBucket === "ERR_S3_INVALID_PATH: Invalid S3 bucket, key combination", "credentials with no bucket is Bun's ERR_S3_INVALID_PATH: " + noBucket);
  ok(new (withEnv({}).S3Client)({ accessKeyId: "A", secretAccessKey: "B" }).presign("s3://named/k").startsWith("https://s3.us-east-1.amazonaws.com/named/k?"), "…unless the path names the bucket, which s3:// URLs do");

  // The statics take the credentials as their last argument, so a one-off call
  // needs no client. They must not read the environment of the client they don't
  // have.
  let staticCode = "";
  try { withEnv({}).S3Client.presign("k"); } catch (e) { staticCode = e.code || ""; }
  ok(staticCode === "ERR_S3_MISSING_CREDENTIALS", "S3Client.presign('k') with no credentials argument refuses: " + staticCode);
  ok(withEnv({}).S3Client.presign("k", { accessKeyId: "A", secretAccessKey: "B", bucket: "b" }).startsWith("https://s3.us-east-1.amazonaws.com/b/k?"), "…and signs when the call carries them");

  // A secret in an enumerable field is a secret in every log line. Bun's client
  // has no own properties; so does this one.
  const client = new (withEnv({}).S3Client)({ accessKeyId: "A", secretAccessKey: "SECRETVALUE", bucket: "b" });
  ok(Object.getOwnPropertyNames(client).length === 0, "an S3Client has no own properties, like Bun's: " + JSON.stringify(Object.getOwnPropertyNames(client)));
  ok(JSON.stringify(client) === "{}" && !JSON.stringify(client).includes("SECRETVALUE"), "…so JSON.stringify(client) cannot leak the secret key");
  const file = new (withEnv({}).S3Client)({ accessKeyId: "A", secretAccessKey: "SECRETVALUE", bucket: "b" }).file("k");
  ok(Object.getOwnPropertyNames(file).length === 0 && !JSON.stringify(file).includes("SECRETVALUE"), "…and neither can stringifying a file handle from it");
}

// ---- 34) what a page cannot do, refused by name -----------------------------
// Everything above is what works. These are the edges where the browser or an
// unwritten piece stops the shim, and the point of the section is that each one
// says so instead of half-working: a partial upload is worse than a refused one,
// because it leaves an object behind.
{
  const B = freshBun();
  const client = new B.S3Client({ accessKeyId: "A", secretAccessKey: "B", bucket: "bkt" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) });
  try {
    // writer(): a real FileSink below the part size, a refusal above it. Bun
    // switches to a multipart upload there; this cannot, and multipart from a page
    // additionally needs the bucket to expose ETag to script.
    const sink = client.file("small.bin").writer();
    sink.write("chunk one");
    sink.write(new Uint8Array([1, 2, 3]));
    ok((await sink.end()) === 12, "writer() buffers and flushes as one PUT, returning the byte count");
    let big = "";
    try { client.file("big.bin").writer().write(new Uint8Array(6 * 1024 * 1024)); } catch (e) { big = String(e.message || e); }
    ok(/multipart/i.test(big), "past 5 MiB it names multipart as the thing it will not do: " + JSON.stringify(big.slice(0, 60)));
    ok(/not implemented in the Vivari shim/.test(big), "…at the SHIM tier, which is this repo's word for unwritten rather than impossible");
    ok(/ETag/.test(big), "…and names the CORS setting multipart would need, so the refusal is actionable");

    // A stream body is drained before the PUT. Bun 1.3.6 has a bug here — it
    // stringifies the stream and uploads "[object ReadableStream]" — and this
    // deliberately does not reproduce it, because reproducing it corrupts data.
    let sent = null;
    globalThis.fetch = async (url, init) => {
      sent = init;
      return { ok: true, status: 200, headers: new Headers(), text: async () => "" };
    };
    await client.write("s.txt", new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("streamed")); c.close(); } }));
    ok(Buffer.from(sent.body).toString() === "streamed", "a ReadableStream body is drained into the PUT, not stringified: " + JSON.stringify(Buffer.from(sent.body).toString()));
    ok(sent.headers["content-length"] === undefined || Number(sent.headers["content-length"]) === 8, "…with a length the browser can send, since fetch() cannot stream a request body here");

    // A key containing `?` is the other place the binary loses data quietly: it
    // truncates the key there and operates on a DIFFERENT object.
    let q = "";
    try { client.presign("report?v=2.csv"); } catch (e) { q = String(e.message || e); }
    ok(/truncates a key at the first/.test(q), "a key containing '?' is refused with the binary's behaviour spelled out");
    ok(/report/.test(q) && q.indexOf('"report"') !== -1, "…naming the key Bun would have used instead: " + JSON.stringify(q.slice(-90)));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---- 35) two failures that pointed at the wrong culprit ----------------------
// Both of these reported a problem in a way that blamed the guest's code, which
// is the expensive kind of wrong: the user goes looking in the wrong file.
{
  const B = freshBun();

  // A missing command used to KILL THE CALLING GUEST. child_process.spawn is
  // right not to throw (Node's contract is an async `error` event) but nothing
  // listened, and an `error` with no listener is rethrown by EventEmitter, so a
  // typo in a command name ended the program that typed it with a stack pointing
  // into the runtime. Real Bun throws synchronously; both are now that.
  for (const api of ["spawn", "spawnSync"]) {
    let e = null;
    try { B[api](["no-such-cmd-xyz"]); } catch (err) { e = err; }
    ok(e !== null, "Bun." + api + "() throws for a command that is not on PATH, instead of killing the caller later");
    ok(e && e.message === 'Executable not found in $PATH: "no-such-cmd-xyz"', "…in the binary's own words: " + JSON.stringify(e && e.message));
    ok(e && e.code === "ENOENT", "…with the binary's ENOENT code, which callers branch on");
  }
  // A real path still spawns; the check must not become a PATH-only check.
  const okRun = B.spawnSync(["/bin/sh", "-c", "exit 0"]);
  ok(okRun && okRun.exitCode === 0, "…and an absolute path is still spawned, since it is not a PATH lookup");
}


console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: all offline Bun checks passed");
process.exit(failed ? 1 : 0);