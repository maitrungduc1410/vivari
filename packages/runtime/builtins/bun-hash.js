// Bun.hash — the non-cryptographic hash family.
//
// This lives in its own file rather than in bun.js because it is bulk: eight
// algorithms, each of which has to be byte-exact or it is worse than useless.
// `Bun.hash` is a *stable* API — people persist its output in cache keys, shard
// ids and bloom filters — so a hash that is merely "stable within this session"
// (which is what the shim used to ship) silently disagrees with production the
// moment the same code runs under real Bun.
//
// Every function here is a faithful port, and every one is pinned by a
// known-answer test in scripts/spike-bun-offline.mjs rather than by a
// round-trip: self-consistency is exactly the property the old wrong
// implementation already had.
//
// Sources ported from, and how each is verified:
//   wyhash      — wyhash "final version 3" (github.com/wangyi-fudan/wyhash), the
//                 variant Zig's std.hash.Wyhash implements and therefore the one
//                 Bun exposes. Verified against the two vectors Bun publishes on
//                 https://bun.com/docs/runtime/hashing.
//   xxHash32/64 — the xxHash specification (Cyan4973/xxHash doc/xxhash_spec.md).
//   murmur*     — MurmurHash2 32/64A and MurmurHash3 x86_32.
//   cityHash*   — CityHash32 / CityHash64, as in Zig's std.hash.cityhash.
// The last three groups are verified with the SMHasher verification code, the
// standard known-answer procedure for this class of hash: hash the keys {0},
// {0,1}, … {0..254} with seed 256-N, concatenate the little-endian digests, hash
// that with seed 0 and keep the low 32 bits. The expected codes are the ones
// Zig's own test suite asserts, so a typo anywhere in a port shows up as a
// mismatch.
//
// NOT implemented, and loud about it (see bun.js): xxHash3 and rapidhash.
// Both are real algorithms we simply have not ported — XXH3 is a much larger
// construction than the rest of this file put together, and rapidhash is not in
// Zig's standard library, so we have no reference we can pin a vector against.
// Guessing at either would reintroduce precisely the bug this file exists to fix.

// ---- 64-bit helpers ---------------------------------------------------------
// JS has no u64, so the 64-bit algorithms run on BigInt with an explicit mask
// after every operation. That is a few times slower than the 32-bit paths, which
// is an acceptable trade here: these are called on cache keys, not in inner
// loops, and the alternative (hand-split hi/lo limbs) is where transcription
// bugs live. The 32-bit algorithms use Math.imul and stay on plain numbers.

const M64 = (1n << 64n) - 1n;
const u64 = (x) => x & M64;
const rotr64 = (x, r) => u64((x >> r) | (x << (64n - r)));
const rotl64 = (x, r) => u64((x << r) | (x >> (64n - r)));

// Little-endian reads. `r8`/`r4` are the workhorses; both are safe to call on
// any in-bounds offset because callers only ever index within `bytes`.
function r8(b, i) {
  let v = 0n;
  for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(b[i + k]);
  return v;
}
function r4(b, i) {
  return BigInt(((b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0));
}
const r4n = (b, i) => ((b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0);

const rotl32 = (x, r) => (((x << r) | (x >>> (32 - r))) >>> 0);
const rotr32 = (x, r) => (((x >>> r) | (x << (32 - r))) >>> 0);
const bswap32 = (x) =>
  ((((x >>> 24) & 0xff) | ((x >>> 8) & 0xff00) | ((x << 8) & 0xff0000) | ((x << 24) & 0xff000000)) >>> 0);

// Seed coercion. Bun's typings give the 64-bit hashes `seed?: bigint` and the
// 32-bit ones `seed?: number`, but its own docs pass a plain number to both
// (`Bun.hash("some data here", 1234)`), so accept either and normalise. Default
// is 0, which the unseeded wyhash doc vector confirms for wyhash.
//
// One honest caveat, because it is the only thing here not pinned by a vector:
// CityHash is the one algorithm whose reference library exposes two DIFFERENT
// entry points — a plain `CityHash64(s)` and a `CityHash64WithSeed(s, seed)`,
// where the seeded form is `HashLen16(CityHash64(s) - k2, seed)` and therefore
// `WithSeed(s, 0) != CityHash64(s)`. We treat an omitted seed as the plain form,
// since that is the value every other CityHash64 implementation agrees on and so
// the one a caller comparing against another library would expect. If Bun turns
// out to route the unseeded call through WithSeed(…, 0) instead, this one line
// is the fix; the seeded path is verified either way.
export const seed64 = (s) => (s == null ? 0n : u64(BigInt(s)));
export const seed32 = (s) => (s == null ? 0 : Number(BigInt.asUintN(32, BigInt(s))) >>> 0);

// ---- wyhash (final version 3) -----------------------------------------------
// The algorithm behind a bare `Bun.hash(data)`. The secrets below are wyhash's
// default `_wyp`; the 4.x line uses a different set and produces different
// digests, which is why the vector check in the spike matters.

const WYP = [0xa0761d6478bd642fn, 0xe7037ed1a0b428dbn, 0x8ebc6af09c88c6e3n, 0x589965cc75374cc3n];

// _wymum: the full 64x64->128 multiply, returning (low, high).
function wymum(a, b) {
  const r = u64(a) * u64(b);
  return [u64(r), u64(r >> 64n)];
}
function wymix(a, b) {
  const [lo, hi] = wymum(a, b);
  return u64(lo ^ hi);
}
// _wyr3: the <4-byte read, which deliberately re-reads the middle byte so that
// 1-, 2- and 3-byte inputs all fill three lanes.
const wyr3 = (b, i, k) => (BigInt(b[i]) << 16n) | (BigInt(b[i + (k >> 1)]) << 8n) | BigInt(b[i + k - 1]);

export function wyhash(bytes, seedIn) {
  const len = bytes.length;
  let seed = seed64(seedIn);
  seed = u64(seed ^ wymix(u64(seed ^ WYP[0]), WYP[1]));
  let a, b, p = 0;

  if (len <= 16) {
    if (len >= 4) {
      a = u64((r4(bytes, p) << 32n) | r4(bytes, p + ((len >> 3) << 2)));
      b = u64((r4(bytes, p + len - 4) << 32n) | r4(bytes, p + len - 4 - ((len >> 3) << 2)));
    } else if (len > 0) {
      a = wyr3(bytes, p, len);
      b = 0n;
    } else {
      a = 0n;
      b = 0n;
    }
  } else {
    let i = len;
    if (i > 48) {
      // Three independent lanes over 48-byte blocks, folded together after.
      let see1 = seed, see2 = seed;
      do {
        seed = wymix(u64(r8(bytes, p) ^ WYP[1]), u64(r8(bytes, p + 8) ^ seed));
        see1 = wymix(u64(r8(bytes, p + 16) ^ WYP[2]), u64(r8(bytes, p + 24) ^ see1));
        see2 = wymix(u64(r8(bytes, p + 32) ^ WYP[3]), u64(r8(bytes, p + 40) ^ see2));
        p += 48;
        i -= 48;
      } while (i > 48);
      seed = u64(seed ^ see1 ^ see2);
    }
    while (i > 16) {
      seed = wymix(u64(r8(bytes, p) ^ WYP[1]), u64(r8(bytes, p + 8) ^ seed));
      i -= 16;
      p += 16;
    }
    // The final two words overlap the tail rather than being padded.
    a = r8(bytes, p + i - 16);
    b = r8(bytes, p + i - 8);
  }

  a = u64(a ^ WYP[1]);
  b = u64(b ^ seed);
  const [lo, hi] = wymum(a, b);
  return wymix(u64(lo ^ WYP[0] ^ BigInt(len)), u64(hi ^ WYP[1]));
}

// ---- xxHash32 / xxHash64 ----------------------------------------------------
// Straight from the xxHash spec. XXH32 stays in 32-bit land (Math.imul); XXH64
// needs BigInt.

const P32_1 = 0x9e3779b1, P32_2 = 0x85ebca77, P32_3 = 0xc2b2ae3d, P32_4 = 0x27d4eb2f, P32_5 = 0x165667b1;

export function xxHash32(bytes, seedIn) {
  const seed = seed32(seedIn);
  const len = bytes.length;
  let i = 0, h;

  if (len >= 16) {
    let a1 = (seed + P32_1 + P32_2) | 0;
    let a2 = (seed + P32_2) | 0;
    let a3 = seed | 0;
    let a4 = (seed - P32_1) | 0;
    const round = (acc, lane) => rotl32(Math.imul(acc, 1) + Math.imul(lane, P32_2) | 0, 13);
    for (; i <= len - 16; i += 16) {
      a1 = Math.imul(round(a1, r4n(bytes, i)), P32_1);
      a2 = Math.imul(round(a2, r4n(bytes, i + 4)), P32_1);
      a3 = Math.imul(round(a3, r4n(bytes, i + 8)), P32_1);
      a4 = Math.imul(round(a4, r4n(bytes, i + 12)), P32_1);
    }
    h = (rotl32(a1 >>> 0, 1) + rotl32(a2 >>> 0, 7) + rotl32(a3 >>> 0, 12) + rotl32(a4 >>> 0, 18)) | 0;
  } else {
    h = (seed + P32_5) | 0;
  }

  h = (h + len) | 0;
  for (; i <= len - 4; i += 4) {
    h = Math.imul(rotl32((h + Math.imul(r4n(bytes, i), P32_3)) | 0, 17), P32_4);
  }
  for (; i < len; i++) {
    h = Math.imul(rotl32((h + Math.imul(bytes[i], P32_5)) | 0, 11), P32_1);
  }
  h = Math.imul(h ^ (h >>> 15), P32_2);
  h = Math.imul(h ^ (h >>> 13), P32_3);
  h = h ^ (h >>> 16);
  return h >>> 0;
}

const P64_1 = 0x9e3779b185ebca87n, P64_2 = 0xc2b2ae3d27d4eb4fn, P64_3 = 0x165667b19e3779f9n,
      P64_4 = 0x85ebca77c2b2ae63n, P64_5 = 0x27d4eb2f165667c5n;

const xxRound64 = (acc, lane) => u64(rotl64(u64(acc + u64(lane * P64_2)), 31n) * P64_1);
const xxMerge64 = (acc, lane) => u64(u64(acc ^ xxRound64(0n, lane)) * P64_1 + P64_4);

export function xxHash64(bytes, seedIn) {
  const seed = seed64(seedIn);
  const len = bytes.length;
  let i = 0, h;

  if (len >= 32) {
    let a1 = u64(seed + P64_1 + P64_2);
    let a2 = u64(seed + P64_2);
    let a3 = u64(seed);
    let a4 = u64(seed - P64_1);
    for (; i <= len - 32; i += 32) {
      a1 = xxRound64(a1, r8(bytes, i));
      a2 = xxRound64(a2, r8(bytes, i + 8));
      a3 = xxRound64(a3, r8(bytes, i + 16));
      a4 = xxRound64(a4, r8(bytes, i + 24));
    }
    h = u64(rotl64(a1, 1n) + rotl64(a2, 7n) + rotl64(a3, 12n) + rotl64(a4, 18n));
    h = xxMerge64(h, a1);
    h = xxMerge64(h, a2);
    h = xxMerge64(h, a3);
    h = xxMerge64(h, a4);
  } else {
    h = u64(seed + P64_5);
  }

  h = u64(h + BigInt(len));
  for (; i <= len - 8; i += 8) {
    h = u64(u64(rotl64(u64(h ^ xxRound64(0n, r8(bytes, i))), 27n) * P64_1) + P64_4);
  }
  if (i <= len - 4) {
    h = u64(u64(rotl64(u64(h ^ u64(r4(bytes, i) * P64_1)), 23n) * P64_2) + P64_3);
    i += 4;
  }
  for (; i < len; i++) {
    h = u64(rotl64(u64(h ^ u64(BigInt(bytes[i]) * P64_5)), 11n) * P64_1);
  }
  h = u64(u64(h ^ (h >> 33n)) * P64_2);
  h = u64(u64(h ^ (h >> 29n)) * P64_3);
  return u64(h ^ (h >> 32n));
}

// ---- MurmurHash ------------------------------------------------------------
// murmur32v2 / murmur64v2 are MurmurHash2 and MurmurHash64A; murmur32v3 is
// MurmurHash3 x86_32. Note MurmurHash2's tail only multiplies once, after the
// last byte is folded in — a detail that is easy to get wrong and that the
// SMHasher code catches.

const M2_32 = 0x5bd1e995;

export function murmur32v2(bytes, seedIn) {
  const seed = seed32(seedIn);
  const len = bytes.length;
  let h = (seed ^ len) | 0;
  const blocks = len >> 2;
  for (let i = 0; i < blocks; i++) {
    let k = Math.imul(r4n(bytes, i * 4), M2_32);
    k = Math.imul(k ^ (k >>> 24), M2_32);
    h = Math.imul(h, M2_32) ^ k;
  }
  const off = len & ~3, rest = len & 3;
  if (rest >= 3) h ^= bytes[off + 2] << 16;
  if (rest >= 2) h ^= bytes[off + 1] << 8;
  if (rest >= 1) {
    h ^= bytes[off];
    h = Math.imul(h, M2_32);
  }
  h = Math.imul(h ^ (h >>> 13), M2_32);
  return (h ^ (h >>> 15)) >>> 0;
}

const M2_64 = 0xc6a4a7935bd1e995n;

export function murmur64v2(bytes, seedIn) {
  const seed = seed64(seedIn);
  const len = bytes.length;
  let h = u64(seed ^ u64(BigInt(len) * M2_64));
  const blocks = Math.floor(len / 8);
  for (let i = 0; i < blocks; i++) {
    let k = u64(r8(bytes, i * 8) * M2_64);
    k = u64(u64(k ^ (k >> 47n)) * M2_64);
    h = u64(u64(h ^ k) * M2_64);
  }
  const rest = len & 7;
  if (rest > 0) {
    // The tail is a zero-padded little-endian word, not a byte-at-a-time fold.
    let k = 0n;
    for (let j = rest - 1; j >= 0; j--) k = (k << 8n) | BigInt(bytes[len - rest + j]);
    h = u64(u64(h ^ k) * M2_64);
  }
  h = u64(u64(h ^ (h >> 47n)) * M2_64);
  return u64(h ^ (h >> 47n));
}

const M3_C1 = 0xcc9e2d51, M3_C2 = 0x1b873593;

export function murmur32v3(bytes, seedIn) {
  const len = bytes.length;
  let h = seed32(seedIn) | 0;
  const blocks = len >> 2;
  for (let i = 0; i < blocks; i++) {
    let k = Math.imul(r4n(bytes, i * 4), M3_C1);
    k = Math.imul(rotl32(k >>> 0, 15), M3_C2);
    h ^= k;
    h = (Math.imul(rotl32(h >>> 0, 13), 5) + 0xe6546b64) | 0;
  }
  let k = 0;
  const off = len & ~3, rest = len & 3;
  if (rest === 3) k ^= bytes[off + 2] << 16;
  if (rest >= 2) k ^= bytes[off + 1] << 8;
  if (rest >= 1) {
    k ^= bytes[off];
    k = Math.imul(k, M3_C1);
    k = Math.imul(rotl32(k >>> 0, 15), M3_C2);
    h ^= k;
  }
  h ^= len;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// ---- CityHash32 / CityHash64 ------------------------------------------------
// CityHash32 takes no seed — Bun's typings give it `(data) => number` with no
// second parameter, and the reference implementation has no seeded form. bun.js
// therefore accepts and ignores a seed here rather than pretending to use it.

const CH_C1 = 0xcc9e2d51, CH_C2 = 0x1b873593;

const chFmix = (h0) => {
  let h = Math.imul(h0 ^ (h0 >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
};
const chMur = (a0, h0) => {
  let a = Math.imul(a0, CH_C1);
  a = Math.imul(rotr32(a >>> 0, 17), CH_C2);
  let h = rotr32((h0 ^ a) >>> 0, 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
};

export function cityHash32(bytes) {
  const len = bytes.length;

  if (len <= 24) {
    if (len <= 4) {
      let b = 0, c = 9;
      for (let i = 0; i < len; i++) {
        // The byte is sign-extended to 32 bits before being added.
        b = (Math.imul(b, CH_C1) + ((bytes[i] << 24) >> 24)) | 0;
        c = (c ^ b) | 0;
      }
      return chFmix(chMur(b, chMur(len, c)));
    }
    if (len <= 12) {
      let a = len | 0;
      let b = Math.imul(a, 5) | 0;
      const d = b;
      let c = 9;
      a = (a + r4n(bytes, 0)) | 0;
      b = (b + r4n(bytes, len - 4)) | 0;
      c = (c + r4n(bytes, (len >> 1) & 4)) | 0;
      return chFmix(chMur(c, chMur(b, chMur(a, d))));
    }
    const a = r4n(bytes, (len >> 1) - 4), b = r4n(bytes, 4), c = r4n(bytes, len - 8);
    const d = r4n(bytes, len >> 1), e = r4n(bytes, 0), f = r4n(bytes, len - 4);
    return chFmix(chMur(f, chMur(e, chMur(d, chMur(c, chMur(b, chMur(a, len)))))));
  }

  let h = len | 0;
  let g = Math.imul(CH_C1, len) | 0;
  let f = g;
  const mix = (off) => Math.imul(rotr32(Math.imul(r4n(bytes, off), CH_C1) >>> 0, 17), CH_C2) | 0;
  const a0 = mix(len - 4), a1 = mix(len - 8), a2 = mix(len - 16), a3 = mix(len - 12), a4 = mix(len - 20);

  h ^= a0;
  h = (Math.imul(rotr32(h >>> 0, 19), 5) + 0xe6546b64) | 0;
  h ^= a2;
  h = (Math.imul(rotr32(h >>> 0, 19), 5) + 0xe6546b64) | 0;
  g ^= a1;
  g = (Math.imul(rotr32(g >>> 0, 19), 5) + 0xe6546b64) | 0;
  g ^= a3;
  g = (Math.imul(rotr32(g >>> 0, 19), 5) + 0xe6546b64) | 0;
  f = (f + a4) | 0;
  f = (Math.imul(rotr32(f >>> 0, 19), 5) + 0xe6546b64) | 0;

  let iters = Math.floor((len - 1) / 20);
  let p = 0;
  while (iters !== 0) {
    const b0 = Math.imul(rotr32(Math.imul(r4n(bytes, p), CH_C1) >>> 0, 17), CH_C2) | 0;
    const b1 = r4n(bytes, p + 4);
    const b2 = Math.imul(rotr32(Math.imul(r4n(bytes, p + 8), CH_C1) >>> 0, 17), CH_C2) | 0;
    const b3 = Math.imul(rotr32(Math.imul(r4n(bytes, p + 12), CH_C1) >>> 0, 17), CH_C2) | 0;
    const b4 = r4n(bytes, p + 16);

    h ^= b0;
    h = (Math.imul(rotr32(h >>> 0, 18), 5) + 0xe6546b64) | 0;
    f = (f + b1) | 0;
    f = Math.imul(rotr32(f >>> 0, 19), CH_C1) | 0;
    g = (g + b2) | 0;
    g = (Math.imul(rotr32(g >>> 0, 18), 5) + 0xe6546b64) | 0;
    h ^= (b3 + b1) | 0;
    h = (Math.imul(rotr32(h >>> 0, 19), 5) + 0xe6546b64) | 0;
    g ^= b4;
    g = Math.imul(bswap32(g >>> 0), 5) | 0;
    h = (h + Math.imul(b4, 5)) | 0;
    h = bswap32(h >>> 0) | 0;
    f = (f + b0) | 0;
    const t = h; h = f; f = g; g = t;
    p += 20;
    iters--;
  }
  g = Math.imul(rotr32(g >>> 0, 11), CH_C1) | 0;
  g = Math.imul(rotr32(g >>> 0, 17), CH_C1) | 0;
  f = Math.imul(rotr32(f >>> 0, 11), CH_C1) | 0;
  f = Math.imul(rotr32(f >>> 0, 17), CH_C1) | 0;
  h = rotr32((h + g) >>> 0, 19);
  h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  h = Math.imul(rotr32(h >>> 0, 17), CH_C1) | 0;
  h = rotr32((h + f) >>> 0, 19);
  h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  h = Math.imul(rotr32(h >>> 0, 17), CH_C1) | 0;
  return h >>> 0;
}

const CK0 = 0xc3a5c85c97cb3127n, CK1 = 0xb492b66fbe98f273n, CK2 = 0x9ae16a3b2f90404fn;

const shiftmix = (v) => u64(v ^ (v >> 47n));
function hashLen16Mul(low, high, mul) {
  let a = u64(u64(low ^ high) * mul);
  a = u64(a ^ (a >> 47n));
  let b = u64(u64(high ^ a) * mul);
  b = u64(b ^ (b >> 47n));
  return u64(b * mul);
}
const hashLen16 = (lo, hi) => hashLen16Mul(lo, hi, 0x9ddfea08eb382d69n);

function chLen0To16(b) {
  const len = b.length, lenB = BigInt(len);
  if (len >= 8) {
    const mul = u64(CK2 + lenB * 2n);
    const a = u64(r8(b, 0) + CK2);
    const bb = r8(b, len - 8);
    const c = u64(rotr64(bb, 37n) * mul + a);
    const d = u64(u64(rotr64(a, 25n) + bb) * mul);
    return hashLen16Mul(c, d, mul);
  }
  if (len >= 4) {
    const mul = u64(CK2 + lenB * 2n);
    const a = r4(b, 0);
    return hashLen16Mul(u64(lenB + (a << 3n)), r4(b, len - 4), mul);
  }
  if (len > 0) {
    const y = (b[0] + (b[len >> 1] << 8)) >>> 0;
    const z = (len + (b[len - 1] << 2)) >>> 0;
    return u64(shiftmix(u64(BigInt(y) * CK2) ^ u64(BigInt(z) * CK0)) * CK2);
  }
  return CK2;
}

function chLen17To32(b) {
  const len = b.length, mul = u64(CK2 + BigInt(len) * 2n);
  const a = u64(r8(b, 0) * CK1);
  const bb = r8(b, 8);
  const c = u64(r8(b, len - 8) * mul);
  const d = u64(r8(b, len - 16) * CK2);
  return hashLen16Mul(
    u64(rotr64(u64(a + bb), 43n) + rotr64(c, 30n) + d),
    u64(a + rotr64(u64(bb + CK2), 18n) + c),
    mul,
  );
}

function chLen33To64(b) {
  const len = b.length, mul = u64(CK2 + BigInt(len) * 2n);
  const a = u64(r8(b, 0) * CK2);
  const bb = r8(b, 8);
  const c = r8(b, len - 24);
  const d = r8(b, len - 32);
  const e = u64(r8(b, 16) * CK2);
  const f = u64(r8(b, 24) * 9n);
  const g = r8(b, len - 8);
  const h = u64(r8(b, len - 16) * mul);

  const u = u64(rotr64(u64(a + g), 43n) + u64(u64(rotr64(bb, 30n) + c) * 9n));
  const v = u64(u64(u64(a + g) ^ d) + f + 1n);
  const w = u64(BigInt(bswap64(u64((u + v) * mul))) + h);
  const x = u64(rotr64(u64(e + f), 42n) + c);
  const y = u64(u64(BigInt(bswap64(u64((v + w) * mul))) + g) * mul);
  const z = u64(e + f + c);
  const a1 = u64(BigInt(bswap64(u64(u64((x + z) * mul) + y))) + bb);
  const b1 = u64(shiftmix(u64(u64((z + a1) * mul) + d + h)) * mul);
  return u64(b1 + x);
}

function bswap64(v) {
  let out = 0n;
  for (let i = 0; i < 8; i++) out = (out << 8n) | ((v >> BigInt(i * 8)) & 0xffn);
  return out;
}

function weakHashLen32WithSeeds(w, x, y, z, a, b) {
  let a1 = u64(a + w);
  let b1 = rotr64(u64(b + a1 + z), 21n);
  const c = a1;
  a1 = u64(a1 + x + y);
  b1 = u64(b1 + rotr64(a1, 44n));
  return [u64(a1 + z), u64(b1 + c)];
}
const weakHash = (b, off, a, bs) =>
  weakHashLen32WithSeeds(r8(b, off), r8(b, off + 8), r8(b, off + 16), r8(b, off + 24), a, bs);

function cityHash64Raw(b) {
  const n = b.length;
  if (n <= 32) return n <= 16 ? chLen0To16(b) : chLen17To32(b);
  if (n <= 64) return chLen33To64(b);

  let len = BigInt(n);
  let x = r8(b, n - 40);
  let y = u64(r8(b, n - 16) + r8(b, n - 56));
  let z = hashLen16(u64(r8(b, n - 48) + len), r8(b, n - 24));
  let v = weakHash(b, n - 64, len, z);
  let w = weakHash(b, n - 32, u64(y + CK1), x);

  x = u64(u64(x * CK1) + r8(b, 0));
  len = (len - 1n) & ~63n;

  let p = 0;
  for (;;) {
    x = u64(rotr64(u64(x + y + v[0] + r8(b, p + 8)), 37n) * CK1);
    y = u64(rotr64(u64(y + v[1] + r8(b, p + 48)), 42n) * CK1);
    x = u64(x ^ w[1]);
    y = u64(y + v[0] + r8(b, p + 40));
    z = u64(rotr64(u64(z + w[0]), 33n) * CK1);
    v = weakHash(b, p, u64(v[1] * CK1), u64(x + w[0]));
    w = weakHash(b, p + 32, u64(z + w[1]), u64(y + r8(b, p + 16)));
    const t = z; z = x; x = t;
    p += 64;
    len -= 64n;
    if (len === 0n) break;
  }
  return hashLen16(
    u64(hashLen16(v[0], w[0]) + u64(shiftmix(y) * CK1) + z),
    u64(hashLen16(v[1], w[1]) + x),
  );
}

export function cityHash64(bytes, seedIn) {
  // CityHash64WithSeed(s, seed) == HashLen16(CityHash64(s) - k2, seed).
  if (seedIn == null) return cityHash64Raw(bytes);
  return hashLen16(u64(cityHash64Raw(bytes) - CK2), seed64(seedIn));
}