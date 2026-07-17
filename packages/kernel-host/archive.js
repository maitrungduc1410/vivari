// Import / export / share codecs (P2).
//
// Environment-agnostic like dep-cache.js / opfs-persistence.js: it uses only web
// platform primitives that exist in BOTH a browser main thread and modern Node
// (>=18) — `CompressionStream`/`DecompressionStream`, `TextEncoder`/`TextDecoder`,
// `DataView`, and `btoa`/`atob`. No npm zip/gzip dependency: ZIP entries are
// DEFLATE-compressed with the platform's own `CompressionStream('deflate-raw')`,
// and the shareable-URL payload is gzipped project source, base64url-encoded.
//
// The studio imports this from the main thread (`packages/studio/src/vv/*`); a
// headless spike imports the same module so the pack/round-trip logic is proven
// offline (`scripts/spike-zip-share.mjs`).

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- stream helpers --------------------------------------------------------
// Run `bytes` through a (De)CompressionStream and collect the output. We write
// and read concurrently: awaiting write+close before reading can deadlock once
// the stream's internal buffer fills.
async function pump(bytes, stream) {
  const writer = stream.writable.getWriter();
  const writing = (async () => {
    await writer.write(bytes);
    await writer.close();
  })();
  const reader = stream.readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await writing;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const asU8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b || 0));

export const deflateRaw = (bytes) => pump(asU8(bytes), new CompressionStream("deflate-raw"));
export const inflateRaw = (bytes) => pump(asU8(bytes), new DecompressionStream("deflate-raw"));
export const gzip = (bytes) => pump(asU8(bytes), new CompressionStream("gzip"));
export const gunzip = (bytes) => pump(asU8(bytes), new DecompressionStream("gzip"));

// ---- CRC-32 (IEEE, for ZIP entries) ----------------------------------------
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (CRC_TABLE = t);
}
export function crc32(bytes) {
  const u8 = asU8(bytes);
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = t[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- base64 / base64url ----------------------------------------------------
function toBase64(u8) {
  let s = "";
  const CHUNK = 0x8000; // stay under String.fromCharCode arg limits
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(s);
}
function fromBase64(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}
const base64url = (u8) => toBase64(u8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function fromBase64url(str) {
  let b = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4) b += "=";
  return fromBase64(b);
}

// ---- ZIP writer ------------------------------------------------------------
// Minimal, correct PKZIP: one local header + (DEFLATE|STORE) body per file, a
// central directory, and an end-of-central-directory record. STORE is used when
// DEFLATE wouldn't shrink the file (tiny/incompressible), so archives are never
// larger than raw. `files` is `[{ path, bytes }]`; returns the archive bytes.
export async function createZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const DOS_DATE = 0x21; // 1980-01-01, a valid fixed timestamp

  for (const f of files) {
    const nameBytes = enc.encode(f.path);
    const data = asU8(f.bytes);
    const crc = crc32(data);
    let method = 8;
    let body = await deflateRaw(data);
    if (body.length >= data.length) {
      method = 0; // STORE
      body = data;
    }

    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 filename flag
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);
    parts.push(lh, body);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    central.push(ch);

    offset += lh.length + body.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const c of central) {
    parts.push(c);
    cdSize += c.length;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);
  parts.push(eocd);

  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---- shareable-URL payload -------------------------------------------------
// A project's source (node_modules already excluded by the caller) serialized to
// a compact gzipped JSON manifest, base64url-encoded for a URL hash. Text files
// are stored inline as UTF-8; binary as base64. Symmetric decode reconstructs
// `{ name, files: [{ path, bytes }] }`.
function isUtf8Text(u8) {
  try {
    const s = new TextDecoder("utf-8", { fatal: true }).decode(u8);
    return !s.includes("\u0000");
  } catch {
    return false;
  }
}

export async function encodeShare({ name, files }) {
  const entries = files.map((f) => {
    const bytes = asU8(f.bytes);
    return isUtf8Text(bytes)
      ? { p: f.path, t: dec.decode(bytes) }
      : { p: f.path, b: toBase64(bytes) };
  });
  const json = enc.encode(JSON.stringify({ v: 1, name, files: entries }));
  return base64url(await gzip(json));
}

export async function decodeShare(payload) {
  const json = await gunzip(fromBase64url(payload));
  const manifest = JSON.parse(dec.decode(json));
  if (!manifest || !Array.isArray(manifest.files)) throw new Error("invalid share payload");
  const files = manifest.files.map((e) => ({
    path: e.p,
    bytes: e.t !== undefined ? enc.encode(e.t) : fromBase64(e.b || ""),
  }));
  return { name: manifest.name || "shared-project", files };
}
