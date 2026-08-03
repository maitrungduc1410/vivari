// Spike (offline, needs the Wasm VFS): a RESPONSE body leaves an in-VM server
// byte for byte, whatever bytes it is — and does not pay for base64 when it
// doesn't have to.
//
// `spike-http-binary-body.mjs` gates the request direction. This is its mirror,
// and the response direction turned out to be the broken one.
//
// Bodies cross the kernel seam as JSON, so binary is base64-encoded and marked
// `bodyEncoding:'base64'`. Deciding *which* bodies are binary was the bug: the
// runtime asked the Content-Type. A header is a claim about how to interpret
// bytes, not a promise that they are utf8 — `text/html; charset=iso-8859-1` is
// explicitly a promise that they are NOT. Every such response was decoded as
// utf8 anyway, turning each high byte into U+FFFD. A latin-1 page, a CSV
// exported from a spreadsheet, `text/plain` carrying arbitrary bytes: all
// silently corrupted, with a 200 and a plausible-looking body.
//
// Separately, the protocol's shared TextDecoder ran with the default
// `ignoreBOM: false`, which STRIPS a leading U+FEFF. Bodies from BOM-prefixed
// files — the normal thing for anything Windows ever wrote — crossed three
// bytes shorter than they left, on a path where every byte was valid utf8 and
// no check could have fired.
//
// So this asserts two things per case, because either alone hides a bug:
//   1. the bytes are exact, and
//   2. the encoding chosen is the right one — utf8 text that starts arriving as
//      base64 is a silent 33% inflation on every dev-server response.
//
// No install and no network: a plain node:http server, offline tier, every push.
//
// Run: node scripts/spike-http-response-bytes.mjs

import { bootSpikeKernel, writeProject, waitListen } from "./lib/spike-harness.mjs";

const DIR = "/app";
const PORT = Number(process.env.VV_PORT || 3100);

// [label, bytes, content-type, expected encoding]. The content-type is the
// point of several of these: the same bytes must cross intact no matter what
// the server calls them.
const B = (a) => Buffer.from(a);
const CASES = [
  // The regression that started this. Valid latin-1, declared as such, not utf8.
  ["latin-1 page, declared iso-8859-1", B([0x43, 0x61, 0x66, 0xe9]), "text/html; charset=iso-8859-1", "base64"],
  ["latin-1 CSV", B([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0xe9, 0xe8]), "text/csv", "base64"],
  // Arbitrary bytes wearing a text/plain label — the label must not be believed.
  ["text/plain carrying raw bytes", B([0x00, 0x01, 0xfe, 0xff, 0x80]), "text/plain", "base64"],
  // Valid utf8 that the old decoder ate the front of.
  ["utf8 with BOM", B([0xef, 0xbb, 0xbf, 0x68, 0x69]), "text/plain; charset=utf-8", "utf8"],
  ["BOM with no content-type", B([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), null, "utf8"],
  // Real text must STAY text: base64 here would be a silent inflation.
  ["multi-byte utf8", B("xin chào — π ≈ 3.14159", "utf8"), "text/plain; charset=utf-8", "utf8"],
  ["JSON", B('{"k":"giá trị"}', "utf8"), "application/json", "utf8"],
  ["JS bundle", B("export const a = 1; // ✓\n", "utf8"), "application/javascript", "utf8"],
  ["SVG", B('<svg xmlns="http://www.w3.org/2000/svg"/>', "utf8"), "image/svg+xml", "utf8"],
  ["ascii, no content-type", B("plain ascii"), null, "utf8"],
  // Binary that was already handled — kept so the fix cannot swing the other way.
  ["PNG magic", B([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png", "base64"],
  ["JPEG magic", B([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]), "image/jpeg", "base64"],
  // The other direction of the same principle: `application/wasm` is as binary
  // as a type gets, but these particular bytes ARE valid utf8 (NULs and "asm"),
  // so they cross as text and skip base64. Byte-exactness is the contract; the
  // encoding is just how it is paid for. A type-driven rule would have inflated
  // this by a third for nothing.
  ["wasm magic (valid utf8 by accident)", B([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]), "application/wasm", "utf8"],
  // A wasm body with a high byte in it, which is the normal case.
  ["wasm with a real high byte", B([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x8b, 0x80]), "application/wasm", "base64"],
  ["invalid utf8 sequences", B([0xc3, 0x28, 0xa0, 0xa1, 0xf0, 0x28, 0x8c, 0x28]), "text/html", "base64"],
  ["lone surrogate (WTF-8)", B([0xed, 0xa0, 0x80]), "text/plain; charset=utf-8", "base64"],
  ["empty body", B([]), "text/plain", "utf8"],
];

// Sizes that exercise the multi-frame path: the SAB window is 1 MiB, so these
// are reassembled from several OP_RESPOND frames, and a seam between frames is
// exactly where a byte goes missing. They are generated rather than embedded —
// a few MB of base64 in the server source does not fit through the VFS write
// window — from ONE copy of the formulas, evaluated on both sides, so the
// expectation cannot drift away from what the server actually serves.
const GEN_SRC = `
function bin(n){ const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 2654435761) & 0xff; return b; }
function latin(n){ const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = 0xa0 + (i % 0x40); return b; }
function text(n){ return Buffer.from('chào '.repeat(n), 'utf8'); }
`;
const gen = new Function("Buffer", `${GEN_SRC}; return { bin, latin, text };`)(Buffer);
const BIG = [
  ["2 MiB pseudo-random binary", "bin", 2 * 1024 * 1024, "application/octet-stream", "base64"],
  ["3.6 MiB utf8 text", "text", 600 * 1024, "text/plain; charset=utf-8", "utf8"],
  ["1.5 MiB latin-1", "latin", 1536 * 1024, "text/html; charset=iso-8859-1", "base64"],
];
for (const [label, fn, n, ct, enc] of BIG) CASES.push([label, gen[fn](n), ct, enc, [fn, n]]);

const h = await bootSpikeKernel();

// The server holds the payloads itself and serves them by index, so the bytes
// under test never make a round trip through the request direction (which has
// its own gate, and whose bugs would otherwise be blamed on this one).
writeProject(h.kernel, DIR, {
  "server.js": `const http = require('http');
${GEN_SRC}
const CASES = ${JSON.stringify(
    CASES.map(([label, buf, ct, , generated]) => [label, generated ? null : buf.toString("base64"), ct, generated || null]),
  )};
const bodies = CASES.map(([, b64, , g]) => (g ? { bin, latin, text }[g[0]](g[1]) : Buffer.from(b64, 'base64')));
http.createServer((req, res) => {
  const i = Number(req.url.slice(1));
  const ct = CASES[i] && CASES[i][2];
  res.writeHead(200, ct ? { 'content-type': ct } : {});
  res.end(bodies[i]);
}).listen(${PORT}, () => console.log('responder listening on ${PORT}'));
`,
});

const bound = await waitListen(h, { dir: DIR, port: PORT, argv: ["server.js"] });
console.log(`  server bound: ${bound}`);
if (!bound) process.exit(1);

let failed = 0;
for (let i = 0; i < CASES.length; i++) {
  const [label, want, , wantEnc] = CASES[i];
  const res = await Promise.race([
    h.kernel.handleHttpRequest(PORT, {
      port: PORT,
      method: "GET",
      url: `/${i}`,
      headers: { host: `127.0.0.1:${PORT}` },
      body: "",
    }),
    new Promise((r) => setTimeout(() => r({ status: 0, timeout: true }), 30000)),
  ]);

  const enc = res.bodyEncoding === "base64" ? "base64" : "utf8";
  const got =
    res.timeout || res.status !== 200
      ? null
      : enc === "base64"
        ? Buffer.from(res.body, "base64")
        : Buffer.from(res.body, "utf8");

  const exact = got !== null && got.equals(want);
  const encOk = enc === wantEnc;
  const ok = exact && encOk;
  if (!ok) failed++;

  let why = "";
  if (res.timeout) why = "  TIMED OUT";
  else if (res.status !== 200) why = `  status ${res.status}`;
  else if (!exact)
    why =
      got.length !== want.length
        ? `  ${want.length} bytes out, ${got.length} back`
        : `  same length, different bytes (first diff at ${[...want].findIndex((b, j) => b !== got[j])})`;
  else if (!encOk) why = `  crossed as ${enc}, expected ${wantEnc}`;

  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label.padEnd(34)} ${String(want.length).padStart(9)} B  ${enc}${why}`);
}

console.log(`\nRESULT: ${failed === 0 ? `PASS — ${CASES.length} response bodies exact` : `FAIL — ${failed}/${CASES.length}`}`);
process.exit(failed === 0 ? 0 : 1);