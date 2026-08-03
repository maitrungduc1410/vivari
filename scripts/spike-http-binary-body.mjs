// Spike (offline, needs the Wasm VFS): a REQUEST body reaches an in-VM server
// byte for byte, whatever bytes it is.
//
// The inbound path had no binary story at all. The Service Worker read the
// request with `.text()`, which UTF-8-decodes — so every non-text upload (a PNG,
// a zip, a tarball) arrived as replacement characters. Driving the kernel
// directly with a Buffer was worse than lossy: the inbox crosses to the process
// worker as JSON, the Buffer serialised to `{type:'Buffer',data:[…]}`, and the
// guest's `creq.end()` never completed — the request HUNG, forever, with no
// error anywhere.
//
// The response direction had solved this long ago with `{body, bodyEncoding:
// 'base64'}`. This gate holds the request direction to the same standard.
//
// No install and no network: a plain node:http server, so this runs in the
// offline tier where a regression is caught on every push.
//
// Run: node scripts/spike-http-binary-body.mjs

import crypto from "node:crypto";
import { bootSpikeKernel, writeProject, waitListen } from "./lib/spike-harness.mjs";

const DIR = "/app";
const PORT = Number(process.env.VV_PORT || 3000);

const h = await bootSpikeKernel();

writeProject(h.kernel, DIR, {
  // Echoes back what it received, hashed. A length alone would not catch a body
  // that arrived the right size and the wrong bytes.
  "server.js": `const http = require('http');
const crypto = require('crypto');
http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ len: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') }));
  });
}).listen(${PORT}, () => console.log('echo listening on ${PORT}'));
`,
});

const bound = await waitListen(h, { dir: DIR, port: PORT, argv: ["server.js"] });
console.log(`  server bound: ${bound}`);

let failed = 0;
async function roundTrip(payload, label) {
  const buf = typeof payload === "string" ? Buffer.from(payload) : Buffer.from(payload);
  const want = crypto.createHash("sha256").update(buf).digest("hex");
  // A hang is the original symptom, so it has to be a failure rather than a
  // stalled run: race the request against a deadline.
  const res = await Promise.race([
    h.kernel.handleHttpRequest(PORT, {
      port: PORT,
      method: "PUT",
      url: "/",
      headers: {
        host: `127.0.0.1:${PORT}`,
        "content-type": "application/octet-stream",
        "content-length": String(buf.length),
      },
      body: payload,
    }),
    new Promise((r) => setTimeout(() => r({ status: 0, body: '{"timeout":true}' }), 15000)),
  ]);
  const text = typeof res.body === "string" ? res.body : Buffer.from(res.body || "").toString();
  let got = null;
  try { got = JSON.parse(text); } catch { /* not json */ }
  const ok = res.status === 200 && got && got.len === buf.length && got.sha256 === want;
  if (!ok) failed++;
  const why = got && got.timeout ? "TIMED OUT (the pre-fix symptom)" : got ? `len=${got.len} sha=${String(got.sha256).slice(0, 12)}…` : text.slice(0, 60);
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label.padEnd(28)} ${buf.length} bytes  ${ok ? "" : why}`);
}

if (bound) {
  console.log("\n── the body arrives byte for byte ──");
  await roundTrip("plain ascii string", "string body");
  await roundTrip(Buffer.from("plain ascii buffer"), "Buffer, ascii");
  await roundTrip(Buffer.from("xin chào — π ≈ 3.14159", "utf8"), "Buffer, multi-byte UTF-8");
  // The cases `.text()` destroyed and a Buffer inbox hung on.
  await roundTrip(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "PNG magic bytes");
  await roundTrip(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]), "JPEG magic bytes");
  await roundTrip(Buffer.from([0xc3, 0x28, 0xa0, 0xa1, 0xf0, 0x28, 0x8c, 0x28]), "invalid UTF-8 sequences");
  await roundTrip(crypto.randomBytes(64 * 1024), "64 KB random");
  await roundTrip(Buffer.alloc(0), "empty body");

  // Past the 1 MiB syscall window. These used to take the whole kernel down with
  // `RangeError: offset is out of bounds` from inside respondOk — an upload of an
  // ordinary photo was enough. They now spill through the VFS.
  console.log("\n── past the 1 MiB syscall window ──");
  await roundTrip(crypto.randomBytes(2 * 1024 * 1024), "2 MB random (binary)");
  await roundTrip(Buffer.from("a".repeat(3 * 1024 * 1024)), "3 MB text");
  await roundTrip(crypto.randomBytes(12 * 1024 * 1024), "12 MB random (binary)");
}

const ok = bound && failed === 0;
console.log(
  `\nRESULT: ${ok ? "PASS — request bodies survive the kernel JSON boundary intact" : "FAIL — see logs above"}`,
);
process.exit(ok ? 0 : 1);