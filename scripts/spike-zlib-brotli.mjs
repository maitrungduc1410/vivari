// Headless proof for node:zlib's brotli entry points, which until now threw
// "not implemented" from the binding while `typeof zlib.brotliCompressSync ===
// "function"` said otherwise — the shape every content-negotiating library
// checks before choosing an encoding.
//
// Brotli is worth the codec's weight because `Accept-Encoding: br` is what a
// browser sends first: undici/fetch decompresses `br` responses, Vite and Nitro
// report brotli asset sizes at build time, and `compression`/`shrink-ray` pick
// brotli when the client offers it. Every one of those paths chose brotli, found
// a function, and got an exception naming a Rust crate.
//
// The gate is a round trip THROUGH THE VM plus a cross-check against the host's
// real libbrotli: bytes we compress must decompress on the host, and bytes the
// host compressed must decompress in here. A codec that only agrees with itself
// is exactly the failure this cannot catch on its own.
import zlib from "node:zlib";
import { bootSpikeKernel, writeProject } from "./lib/spike-harness.mjs";

const src = ("Vivari brotli round trip. " + "the quick brown fox jumps over the lazy dog. ").repeat(40);
// Compressed on the host by real libbrotli, decompressed inside the VM below.
const hostBr = zlib.brotliCompressSync(Buffer.from(src)).toString("base64");

const guest = `
const zlib = require("node:zlib");
const { Readable } = require("node:stream");

const src = ${JSON.stringify(src)};
const hostBr = Buffer.from(${JSON.stringify(hostBr)}, "base64");
const out = {};

// 1. sync round trip, entirely in here
const c = zlib.brotliCompressSync(Buffer.from(src));
out.syncSmaller = c.length < Buffer.byteLength(src);
out.syncRoundTrip = zlib.brotliDecompressSync(c).toString() === src;
out.ourBytes = c.toString("base64");

// 2. the host's brotli bytes must decode in here
out.decodesHostBytes = zlib.brotliDecompressSync(hostBr).toString() === src;

// 3. quality is honoured: q1 and q11 must not produce identical output
const q = (quality) =>
  zlib.brotliCompressSync(Buffer.from(src), {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality },
  });
out.qualityMatters = Buffer.compare(q(1), q(11)) !== 0;
out.q1RoundTrips = zlib.brotliDecompressSync(q(1)).toString() === src;

// 4. corrupt input must surface as an error, not as silence or a hang
try {
  zlib.brotliDecompressSync(Buffer.from("this is not brotli at all"));
  out.rejectsGarbage = false;
} catch (e) {
  out.rejectsGarbage = true;
  out.garbageCode = String(e.code || e.message);
}

// 5. streaming, chunk by chunk — the path a server response actually takes,
//    and the one that exercises flush/finish rather than a single one-shot call.
const chunks = [];
for (let i = 0; i < src.length; i += 997) chunks.push(Buffer.from(src.slice(i, i + 997)));
const streamed = await new Promise((resolve, reject) => {
  const parts = [];
  const gz = zlib.createBrotliCompress();
  const un = zlib.createBrotliDecompress();
  un.on("data", (d) => parts.push(d));
  un.on("end", () => resolve(Buffer.concat(parts).toString()));
  un.on("error", reject);
  gz.on("error", reject);
  Readable.from(chunks).pipe(gz).pipe(un);
});
out.streamRoundTrip = streamed === src;

// 6. async callback form, since that is what most libraries call
out.asyncRoundTrip = await new Promise((resolve) => {
  zlib.brotliCompress(Buffer.from(src), (err, buf) => {
    if (err) return resolve("compress: " + err.message);
    zlib.brotliDecompress(buf, (err2, back) => {
      resolve(err2 ? "decompress: " + err2.message : back.toString() === src);
    });
  });
});

// 7. zstd is still absent, and must say so in a way the caller can act on
try {
  zlib.zstdCompressSync(Buffer.from("x"));
  out.zstdThrew = false;
} catch (e) {
  out.zstdThrew = /packages\\/codec/.test(e.message) && /brotli/.test(e.message);
}

console.log("VVRESULT" + JSON.stringify(out));
`;

const h = await bootSpikeKernel();
writeProject(h.kernel, "/app", { "brotli.mjs": guest });
const res = await h.kernel.start("node", ["brotli.mjs"], { cwd: "/app", capture: true });
const line = ((res.stdout || "").split("\n").find((l) => l.startsWith("VVRESULT")) || "").slice(8);
if (!line) {
  console.log(res.stdout);
  console.log(String(res.stderr || "").slice(0, 1500));
  console.log("\nRESULT: FAIL — the guest produced no result");
  process.exit(1);
}
const out = JSON.parse(line);

let failed = 0;
const ok = (cond, label) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}`);
  if (!cond) failed++;
};

console.log("node:zlib brotli:");
ok(out.syncSmaller, "brotliCompressSync actually compresses");
ok(out.syncRoundTrip, "brotliCompressSync -> brotliDecompressSync round trips");
ok(out.decodesHostBytes, "decompresses bytes produced by the host's libbrotli");
ok(out.qualityMatters, "BROTLI_PARAM_QUALITY reaches the encoder (q1 !== q11)");
ok(out.q1RoundTrips, "a q1 stream round trips");
ok(out.rejectsGarbage, `non-brotli input is rejected (${out.garbageCode})`);
ok(out.streamRoundTrip, "createBrotliCompress -> createBrotliDecompress streams round trip");
ok(out.asyncRoundTrip === true, `brotliCompress/brotliDecompress callbacks round trip (${out.asyncRoundTrip})`);
ok(out.zstdThrew, "zstd still reports its absence with an actionable message");

// The other half of the cross-check: the host's real libbrotli must accept what
// the VM produced. Self-consistency proves nothing about the wire format.
const decodedOnHost = zlib.brotliDecompressSync(Buffer.from(out.ourBytes, "base64")).toString();
ok(decodedOnHost === src, "the host's libbrotli decompresses the VM's output");

if (failed) {
  console.log(`\nRESULT: FAIL — ${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS: node:zlib brotli compresses and decompresses, interoperably with libbrotli.");
process.exit(0);
