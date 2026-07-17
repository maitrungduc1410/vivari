// Headless proof for the tar reader (packages/kernel-host/tar.js) used by the
// GitHub/npm importer.
//
// tar.js is environment-agnostic (TextDecoder + typed arrays), so we can prove it
// offline: hand-build a real ustar archive here (Node has no tar writer), gzip it
// with Node's zlib, then decode it with archive.js gunzip() + tar.js parseTar()
// and check every entry byte-for-byte. Also covers stripFirstSegment() and the
// ustar `prefix` field (deep paths).
//
//   node scripts/spike-tar.mjs

import { gzipSync } from "node:zlib";
import { gunzip } from "../packages/kernel-host/archive.js";
import { parseTar, stripFirstSegment } from "../packages/kernel-host/tar.js";

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  \u2713 ${msg}`);
  else { console.error(`  \u2717 ${msg}`); failures++; }
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const enc = new TextEncoder();

// Minimal ustar writer. `name`/`prefix` split lets us exercise deep paths.
function header(name, size, prefix = "") {
  const h = new Uint8Array(512);
  const put = (str, off, len) => {
    const b = enc.encode(str);
    h.set(b.subarray(0, len), off);
  };
  put(name, 0, 100);
  put("0000644\0", 100, 8); // mode
  put("0000000\0", 108, 8); // uid
  put("0000000\0", 116, 8); // gid
  put(size.toString(8).padStart(11, "0") + "\0", 124, 12);
  put("00000000000\0", 136, 12); // mtime
  h[156] = 0x30; // typeflag '0' (regular file)
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  if (prefix) put(prefix, 345, 155);
  // checksum: sum of all bytes with the chksum field treated as spaces
  for (let i = 148; i < 156; i++) h[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}
function buildTar(entries) {
  const chunks = [];
  for (const e of entries) {
    chunks.push(header(e.name, e.bytes.length, e.prefix));
    chunks.push(e.bytes);
    const pad = (512 - (e.bytes.length % 512)) % 512;
    if (pad) chunks.push(new Uint8Array(pad));
  }
  chunks.push(new Uint8Array(1024)); // two zero blocks terminate the archive
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// A representative package tree, everything under a `package/` root (npm style),
// including a nested path via the ustar prefix field and a full-range binary blob.
const binary = new Uint8Array(256);
for (let i = 0; i < 256; i++) binary[i] = i;
const entries = [
  { name: "package/package.json", bytes: enc.encode('{"name":"demo","version":"1.0.0"}\n') },
  { name: "package/index.js", bytes: enc.encode("module.exports = 42;\n".repeat(30)) },
  { name: "blob.bin", prefix: "package/assets", bytes: binary },
];

console.log("stripFirstSegment:");
check(stripFirstSegment("package/index.js") === "index.js", "drops npm 'package/' root");
check(stripFirstSegment("repo-main/src/a.ts") === "src/a.ts", "drops GitHub '<repo>-<ref>/' root");
check(stripFirstSegment("toplevel") === "", "top-level entry -> empty (skipped)");

console.log("tar parse (gzipped):");
{
  const gz = new Uint8Array(gzipSync(Buffer.from(buildTar(entries))));
  const tar = await gunzip(gz);
  const files = parseTar(tar);
  check(files.length === entries.length, `entry count (${files.length} === ${entries.length})`);
  for (const e of entries) {
    const full = e.prefix ? e.prefix + "/" + e.name : e.name;
    const g = files.find((x) => x.name === full);
    if (!g) { check(false, `entry present: ${full}`); continue; }
    check(bytesEqual(g.bytes, e.bytes), `content matches: ${full}`);
  }
  const rels = files.map((f) => stripFirstSegment(f.name));
  check(rels.includes("assets/blob.bin"), "prefix field yields nested path assets/blob.bin");
}

if (failures) {
  console.error(`\nFAIL: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: tar reader verified.");
