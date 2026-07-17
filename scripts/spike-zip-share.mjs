// Headless proof for the import/export/share codecs (packages/kernel-host/archive.js).
//
// archive.js is environment-agnostic — it uses only web platform primitives that
// also exist in modern Node (CompressionStream / DecompressionStream / DataView /
// btoa|atob) — so we can prove the ZIP writer and the shareable-URL codec offline,
// without a browser or a wasm rebuild:
//
//   * createZip() output is parsed with Node's own zlib (inflateRawSync) as an
//     independent decoder, and every entry's bytes + CRC-32 are checked.
//   * encodeShare()/decodeShare() must round-trip a mixed text+binary tree.
//   * deflate/inflate and gzip/gunzip must round-trip.
//
//   node scripts/spike-zip-share.mjs

import { inflateRawSync } from "node:zlib";
import {
  createZip, encodeShare, decodeShare, crc32, deflateRaw, inflateRaw, gzip, gunzip,
} from "../packages/kernel-host/archive.js";

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const enc = new TextEncoder();

// A representative source tree: text, nested, empty, and a binary blob (all 256
// byte values) that STORE-fallback + base64 paths must preserve exactly.
const binary = new Uint8Array(256);
for (let i = 0; i < 256; i++) binary[i] = i;
const files = [
  { path: "package.json", bytes: enc.encode('{\n  "name": "demo",\n  "scripts": { "dev": "vite" }\n}\n') },
  { path: "src/main.ts", bytes: enc.encode("console.log('hello, \u4e16\u754c');\n".repeat(50)) },
  { path: "src/empty.txt", bytes: new Uint8Array(0) },
  { path: "assets/blob.bin", bytes: binary },
];

// Independent ZIP reader: parse the central directory, then inflate each entry
// with Node's zlib so we're not just trusting our own writer.
function parseZip(zip) {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const u16 = (o) => dv.getUint16(o, true);
  const u32 = (o) => dv.getUint32(o, true);
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) if (u32(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("no EOCD record");
  const count = u16(eocd + 10);
  let off = u32(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (u32(off) !== 0x02014b50) throw new Error("bad central-directory signature");
    const method = u16(off + 10);
    const crc = u32(off + 16);
    const compSize = u32(off + 20);
    const nameLen = u16(off + 28);
    const extraLen = u16(off + 30);
    const commentLen = u16(off + 32);
    const lho = u32(off + 42);
    const name = new TextDecoder().decode(zip.subarray(off + 46, off + 46 + nameLen));
    if (u32(lho) !== 0x04034b50) throw new Error("bad local-header signature");
    const dataStart = lho + 30 + u16(lho + 26) + u16(lho + 28);
    const body = zip.subarray(dataStart, dataStart + compSize);
    const data = method === 8 ? new Uint8Array(inflateRawSync(body)) : body.slice();
    out.push({ name, method, crc, data });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

console.log("stream round-trips:");
{
  const sample = enc.encode("the quick brown fox ".repeat(1000));
  const back = await inflateRaw(await deflateRaw(sample));
  check(bytesEqual(sample, back), "deflate-raw → inflate-raw round-trips");
  const gback = await gunzip(await gzip(sample));
  check(bytesEqual(sample, gback), "gzip → gunzip round-trips");
}

console.log("zip export:");
{
  const zip = await createZip(files);
  const entries = parseZip(zip);
  check(entries.length === files.length, `entry count (${entries.length} === ${files.length})`);
  for (const f of files) {
    const e = entries.find((x) => x.name === f.path);
    if (!e) { check(false, `entry present: ${f.path}`); continue; }
    check(bytesEqual(e.data, f.bytes), `content matches: ${f.path}`);
    check(e.crc === crc32(f.bytes), `CRC-32 matches: ${f.path}`);
  }
}

console.log("shareable-URL codec:");
{
  const payload = await encodeShare({ name: "demo", files });
  check(/^[A-Za-z0-9_-]+$/.test(payload), "payload is URL-safe (base64url)");
  const decoded = await decodeShare(payload);
  check(decoded.name === "demo", "name round-trips");
  check(decoded.files.length === files.length, `file count (${decoded.files.length})`);
  for (const f of files) {
    const g = decoded.files.find((x) => x.path === f.path);
    if (!g) { check(false, `file present: ${f.path}`); continue; }
    check(bytesEqual(g.bytes, f.bytes), `content matches: ${f.path}`);
  }
  const raw = enc.encode(JSON.stringify(files.map((f) => f.path))).length;
  console.log(`  payload: ${payload.length} chars for a ${files.length}-file tree`);
  void raw;
}

if (failures) {
  console.error(`\nFAIL: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: zip export + shareable-URL codecs verified.");
