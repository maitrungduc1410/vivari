// internalBinding('crypto') — the native seam beneath our lib/crypto.js
// (Phase 2 #12). In real Node this is the C++ wrapper around OpenSSL. Here it's
// a thin JS adapter over the Rust/Wasm crypto codec (packages/crypto:
// RustCrypto md-5/sha1/sha2/hmac/pbkdf2/aes/cbc/aes-gcm), driven one-shot: the
// lib/crypto layer buffers streamed input and calls these once.
//
// Robustness: hashing keeps pure-JS md5/sha1/sha256 cores as a FALLBACK when the
// wasm codec isn't wired, so createHash (e.g. Express's `etag` at load) still
// works. The extra digests (sha224/384/512), HMAC over any digest, PBKDF2 and
// the AES ciphers need the codec and throw loudly without it.

const EMPTY = new Uint8Array(0);

function concat(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// --- pure-JS fallback cores (md5 / sha1 / sha256), all 64-byte block size ----
function md5(bytes) {
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = (Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)) | 0;
  const len = bytes.length;
  const withOne = len + 1;
  const total = withOne + ((56 - (withOne % 64) + 64) % 64) + 8;
  const msg = new Uint8Array(total);
  msg.set(bytes);
  msg[len] = 0x80;
  const bitLen = len * 8;
  msg[total - 8] = bitLen & 0xff;
  msg[total - 7] = (bitLen >>> 8) & 0xff;
  msg[total - 6] = (bitLen >>> 16) & 0xff;
  msg[total - 5] = (bitLen >>> 24) & 0xff;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Int32Array(16);
  const rol = (x, c) => (x << c) | (x >>> (32 - c));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      M[i] = msg[j] | (msg[j + 1] << 8) | (msg[j + 2] << 16) | (msg[j + 3] << 24);
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + rol(F, s[i])) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16);
  [a0, b0, c0, d0].forEach((v, i) => {
    out[i * 4] = v & 0xff;
    out[i * 4 + 1] = (v >>> 8) & 0xff;
    out[i * 4 + 2] = (v >>> 16) & 0xff;
    out[i * 4 + 3] = (v >>> 24) & 0xff;
  });
  return out;
}

function sha1(bytes) {
  const len = bytes.length;
  const withOne = len + 1;
  const total = withOne + ((56 - (withOne % 64) + 64) % 64) + 8;
  const msg = new Uint8Array(total);
  msg.set(bytes);
  msg[len] = 0x80;
  const bitLen = len * 8;
  const dv = new DataView(msg.buffer);
  dv.setUint32(total - 4, bitLen >>> 0, false);
  dv.setUint32(total - 8, Math.floor(bitLen / 4294967296), false);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);
  const rol = (x, c) => (x << c) | (x >>> (32 - c));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4, false);
    for (let i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (rol(a, 5) + f + e + k + w[i]) | 0;
      e = d; d = c; c = rol(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((v, i) => odv.setInt32(i * 4, v, false));
  return out;
}

const K256 = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
function sha256(bytes) {
  const len = bytes.length;
  const withOne = len + 1;
  const total = withOne + ((56 - (withOne % 64) + 64) % 64) + 8;
  const msg = new Uint8Array(total);
  msg.set(bytes);
  msg[len] = 0x80;
  const bitLen = len * 8;
  const dv = new DataView(msg.buffer);
  dv.setUint32(total - 4, bitLen >>> 0, false);
  dv.setUint32(total - 8, Math.floor(bitLen / 4294967296), false);
  const h = new Int32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Int32Array(64);
  const rr = (x, c) => (x >>> c) | (x << (32 - c));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i] + w[i]) | 0;
      const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setInt32(i * 4, h[i], false);
  return out;
}

const JS_CORES = { md5, sha1, sha256 };

function hmacJs(core, blockSize, key, bytes) {
  let k = key;
  if (k.length > blockSize) k = core(k);
  const kpad = new Uint8Array(blockSize);
  kpad.set(k);
  const ipad = new Uint8Array(blockSize);
  const opad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    ipad[i] = kpad[i] ^ 0x36;
    opad[i] = kpad[i] ^ 0x5c;
  }
  const inner = core(concat([ipad, bytes]));
  return core(concat([opad, inner]));
}

const norm = (a) => String(a).toLowerCase().replace(/-/g, "");

// codec = the wasm module namespace (packages/crypto pkg[-node]) or null.
export function createCryptoBinding({ codec } = {}) {
  const needCodec = (what) => {
    if (!codec) throw new Error(`OpenContainer crypto: ${what} needs the wasm crypto codec (not available in this process)`);
  };

  function digest(algo, bytes) {
    const n = norm(algo);
    if (codec) return new Uint8Array(codec.digest(n, bytes));
    const core = JS_CORES[n];
    if (core) return core(bytes);
    throw new Error(`OpenContainer crypto: digest '${algo}' needs the wasm codec (md5/sha1/sha256 work without it)`);
  }

  function hmac(algo, key, bytes) {
    const n = norm(algo);
    if (codec) return new Uint8Array(codec.hmac_digest(n, key, bytes));
    const core = JS_CORES[n];
    if (!core) throw new Error(`OpenContainer crypto: HMAC-${algo} needs the wasm codec`);
    return hmacJs(core, 64, key, bytes);
  }

  function pbkdf2(algo, pass, salt, iterations, keylen) {
    needCodec("pbkdf2");
    return new Uint8Array(codec.pbkdf2(norm(algo), pass, salt, iterations >>> 0, keylen >>> 0));
  }

  function aesCbcEncrypt(key, iv, pt) {
    needCodec("createCipheriv (aes-cbc)");
    return new Uint8Array(codec.aes_cbc_encrypt(key, iv, pt));
  }
  function aesCbcDecrypt(key, iv, ct) {
    needCodec("createDecipheriv (aes-cbc)");
    return new Uint8Array(codec.aes_cbc_decrypt(key, iv, ct));
  }
  function aesGcmEncrypt(key, iv, aad, pt) {
    needCodec("createCipheriv (aes-gcm)");
    return new Uint8Array(codec.aes_gcm_encrypt(key, iv, aad || EMPTY, pt));
  }
  function aesGcmDecrypt(key, iv, aad, ctTag) {
    needCodec("createDecipheriv (aes-gcm)");
    return new Uint8Array(codec.aes_gcm_decrypt(key, iv, aad || EMPTY, ctTag));
  }

  const HASHES = codec
    ? ["md5", "sha1", "sha224", "sha256", "sha384", "sha512", "sha512-256"]
    : ["md5", "sha1", "sha256"];

  return {
    digest,
    hmac,
    pbkdf2,
    aesCbcEncrypt,
    aesCbcDecrypt,
    aesGcmEncrypt,
    aesGcmDecrypt,
    getHashes: () => HASHES.slice(),
    hasCodec: !!codec,
  };
}
