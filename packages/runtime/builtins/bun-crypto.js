// Bun.CryptoHasher and Bun.password — the two Bun members whose output is a
// SECURITY artefact rather than a convenience value.
//
// Split out of bun.js for the usual reason (bulk), but the reason this file is
// written the way it is, is narrower: everything here either agrees with real Bun
// byte for byte or is worse than useless.
//
//   * A CryptoHasher digest that disagrees with Bun's is a signature that will not
//     verify, or worse, one that verifies something other than what was signed.
//   * A Bun.password hash is written to somebody's user table. If the sandbox and
//     production do not produce mutually verifiable strings, the failure surfaces
//     as "nobody can log in", months later, on the day you move off the sandbox.
//
// The shim this replaced got the second one wrong in the loudest possible way: it
// ran node's scrypt and emitted a bespoke `$vv-<algo>$<salt>$<key>` string. That
// is not argon2, not bcrypt, not PHC, not modular-crypt, and not parseable by
// anything on earth except the twelve lines that produced it — while `Bun.password
// .hash(pw)` reported "algorithm: argon2id" to the caller. Now both algorithms are
// real (RustCrypto argon2 + bcrypt in packages/crypto) and both emit and accept the
// standard encodings, so a hash round-trips with real Bun in either direction.
//
// Bun.hash — the NON-cryptographic family — is a different thing entirely and
// lives in bun-hash.js. Nothing here is interchangeable with anything there.
//
// Everything is verified against known-answer vectors taken from OUTSIDE this
// repo: Bun's published docs, Bun's own test suite, RFC/Openwall test vectors and
// OpenSSL. Round-tripping our own output against itself is exactly the property
// the old broken implementation already had, so it proves nothing.

// ---- algorithm tables -------------------------------------------------------
// Bun's `SupportedCryptoAlgorithms`, in Bun's own order. This is the complete
// list: it is `EVP.Algorithm` (BoringSSL) plus `CryptoHasherZig.algo_map` (the
// sha3/shake/blake2s ones BoringSSL does not carry), and it is what
// `CryptoHasher.algorithms` returns.
//
// blake3 is deliberately ABSENT. It is not in Bun's documented list, not in
// EVP.Algorithm and not in CryptoHasherZig — `new Bun.CryptoHasher("blake3")`
// throws under real Bun. Accepting it here would be a divergence in the more
// dangerous direction than omitting it: code written and tested in the sandbox
// would fail on the first real `bun` run. See the note in bun.js's header.
export const CRYPTO_HASHER_ALGORITHMS = [
  "blake2b256",
  "blake2b512",
  "blake2s256",
  "md4",
  "md5",
  "ripemd160",
  "sha1",
  "sha224",
  "sha256",
  "sha384",
  "sha512",
  "sha512-224",
  "sha512-256",
  "sha3-224",
  "sha3-256",
  "sha3-384",
  "sha3-512",
  "shake128",
  "shake256",
];

// Digest sizes in bytes, i.e. `hasher.byteLength`. shake128/shake256 are
// extendable-output functions with no intrinsic length; 16 and 32 are the
// defaults Bun uses (CryptoHasherZig.digestLength) and node:crypto agrees.
const DIGEST_BYTE_LENGTH = {
  blake2b256: 32,
  blake2b512: 64,
  blake2s256: 32,
  md4: 16,
  md5: 16,
  ripemd160: 20,
  sha1: 20,
  sha224: 28,
  sha256: 32,
  sha384: 48,
  sha512: 64,
  "sha512-224": 28,
  "sha512-256": 32,
  "sha3-224": 28,
  "sha3-256": 32,
  "sha3-384": 48,
  "sha3-512": 64,
  shake128: 16,
  shake256: 32,
};

// The alias table from Bun's EVP.zig, matched case-insensitively. Callers really
// do write "sha-256" and "SHA512-256", and Bun accepts them; `sha128` mapping to
// sha1 is Bun's, odd but real. `.algorithm` reports the CANONICAL name whichever
// spelling went in, which is why this is a map to a canonical name rather than a
// normalising regex.
const ALGORITHM_ALIASES = {
  rmd160: "ripemd160",
  sha128: "sha1",
  "sha-1": "sha1",
  "sha-224": "sha224",
  "sha-256": "sha256",
  "sha-384": "sha384",
  "sha-512": "sha512",
  "sha-512/224": "sha512-224",
  "sha-512_224": "sha512-224",
  "sha-512224": "sha512-224",
  "sha-512/256": "sha512-256",
  "sha-512_256": "sha512-256",
  "sha-512256": "sha512-256",
};

/** Bun's algorithm-name resolution: canonical name, or null if unsupported. */
export function canonicalCryptoAlgorithm(name) {
  if (typeof name !== "string") return null;
  const lower = name.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(DIGEST_BYTE_LENGTH, lower)) return lower;
  if (Object.prototype.hasOwnProperty.call(ALGORITHM_ALIASES, lower)) return ALGORITHM_ALIASES[lower];
  return null;
}

// Algorithms Bun's HMAC path accepts. This is NOT the same set as the hashing
// path: shake128/shake256 have no HMAC (an XOF has no fixed block/digest pairing
// to key), and blake2s256 is absent from Bun's documented HMAC list. Bun throws
// at CONSTRUCTION time for those, not at digest time, so we do too.
//
// Version note: at the commit whose source we read, Bun additionally rejected
// ripemd160 and the whole sha3 family for HMAC. Bun's current tests and its
// published docs both include them, so this follows current Bun. If we are wrong
// about a given Bun version, we are wrong in the direction of accepting a call
// that version rejects — never in the direction of returning a wrong digest.
const HMAC_ALGORITHMS = new Set([
  "blake2b256",
  "blake2b512",
  "md4",
  "md5",
  "ripemd160",
  "sha1",
  "sha224",
  "sha256",
  "sha384",
  "sha512",
  "sha512-224",
  "sha512-256",
  "sha3-224",
  "sha3-256",
  "sha3-384",
  "sha3-512",
]);

/** Exported for the offline spike: is `algo` keyable as an HMAC under Bun? */
export const supportsHmac = (algo) => {
  const canonical = canonicalCryptoAlgorithm(algo);
  return canonical != null && HMAC_ALGORITHMS.has(canonical);
};

/** Digest length in bytes for a canonical or aliased algorithm name. */
export const digestByteLength = (algo) => {
  const canonical = canonicalCryptoAlgorithm(algo);
  return canonical == null ? null : DIGEST_BYTE_LENGTH[canonical];
};

// Bun's message, so a caller searching for it finds Bun's documentation.
export const HMAC_CONSUMED = "HMAC has been consumed and is no longer usable";

// ---- Bun.password parameters ------------------------------------------------
// Bun's defaults, read out of PasswordObject.zig rather than guessed:
//   argon2id, memory_cost = pwhash.argon2.Params.interactive_2id.m = 65536 KiB,
//   time_cost = .t = 2, and toParams() hard-codes p = 1 (Bun does not expose
//   parallelism). Zig's pwhash.argon2 uses a 32-byte salt and a 32-byte tag,
//   which is why Bun's documented sample PHC string has two 43-char b64 fields.
// bcrypt: `bcrpyt_default = 10` (Bun's spelling), encoding `.crypt` -> `$2b$`.
export const BUN_ARGON2_DEFAULTS = { memoryCost: 65536, timeCost: 2, parallelism: 1 };
export const BUN_BCRYPT_DEFAULT_COST = 10;

// bcrypt's Blowfish key schedule consumes at most 72 bytes of key material, so
// every byte past 72 is silently ignored. Bun refuses to silently ignore them and
// SHA-512s the password first. See bcryptKeyMaterial() for why the exact shape of
// that matters more than it looks.
export const BCRYPT_MAX_INPUT_BYTES = 72;

/**
 * Bun's bcrypt pre-hash, isolated so it can be pinned without a wasm build.
 *
 * PasswordObject.zig, in BOTH hash() and verify():
 *
 *     if (password.len > 72) { sha_512.update(password); sha_512.final(&outbuf);
 *                              password_to_use = &outbuf; }
 *
 * Two details carry the whole interop story:
 *
 *  1. The comparison is `> 72`, not `>= 72`. A password of exactly 72 bytes is
 *     passed through untouched. Getting this off by one silently produces an
 *     unverifiable hash for exactly one password length.
 *  2. What bcrypt receives is the RAW 64-byte digest — not hex, not base64. The
 *     "obvious" hardening (base64 so the key material cannot contain a NUL, which
 *     is what OWASP suggests for hand-rolled pre-hashing) is a DIFFERENT
 *     construction and produces a hash real Bun cannot verify.
 *
 * Interior NUL bytes in that digest are safe on both sides: Zig builds
 * `password[0..min(len,72)] ++ {0}` and hands the Blowfish key schedule an
 * explicit length, and the Rust `bcrypt` crate appends a NUL and truncates the
 * result to 72 — neither treats an interior NUL as a terminator. The two agree at
 * every input length. Pinned by Bun's own cross-version vector in
 * scripts/spike-bun-offline.mjs (a hash Bun 1.2.4 wrote for a 500-byte password,
 * which Bun's test suite keeps precisely so this construction cannot drift).
 *
 * @param bytes  the password as bytes
 * @param sha512 (bytes) => 64 raw digest bytes
 */
export function bcryptKeyMaterial(bytes, sha512) {
  return bytes.length > BCRYPT_MAX_INPUT_BYTES ? sha512(bytes) : bytes;
}

// The format the old shim emitted: `$vv-<algo>$<salt b64>$<scrypt key b64>`.
//
// MIGRATION DECISION: verify() still ACCEPTS these; hash() can no longer produce
// one. Silently rejecting them (returning false, i.e. "wrong password") was never
// an option — it is the same delayed, unexplainable failure this change exists to
// remove. Between the two defensible answers, accepting wins because the
// divergence it creates is unobservable: real Bun THROWS UnsupportedAlgorithm on a
// `$vv-` string, and no real Bun deployment can ever hold one, because only this
// shim ever wrote the prefix. So we accept a string Bun would reject, in a
// namespace Bun can never encounter, and every string Bun CAN encounter behaves
// identically. The alternative — throwing with an explanatory message — would be
// defensible too, but it breaks sandbox fixtures seeded before this change for no
// interop gain. Hashes are re-emitted as real argon2id the next time hash() runs.
const LEGACY_PREFIX = "$vv-";

/**
 * Bun's `Algorithm.get()`: which algorithm a stored hash string was made with,
 * decided purely by its prefix. Returns null when nothing matches, which is what
 * makes Bun's verify() THROW rather than answer "wrong password".
 *
 * `vv-legacy` is ours and is not a Bun value — see LEGACY_PREFIX above.
 */
export function detectPasswordAlgorithm(stored) {
  const s = String(stored);
  if (s.charCodeAt(0) !== 36 /* $ */) return null;
  if (s.startsWith(LEGACY_PREFIX)) return "vv-legacy";
  if (s.startsWith("$argon2id$")) return "argon2id";
  if (s.startsWith("$argon2i$")) return "argon2i";
  if (s.startsWith("$argon2d$")) return "argon2d";
  if (s.startsWith("$bcrypt") || s.startsWith("$2")) return "bcrypt";
  return null;
}

/**
 * Bun's option parsing (`PasswordObject.Algorithm.Value.fromJS`), normalised.
 * Accepts a bare algorithm string or an options object, exactly like Bun.
 */
export function parsePasswordOptions(opts) {
  const algorithm = typeof opts === "string" ? opts : opts && opts.algorithm ? opts.algorithm : "argon2id";
  if (algorithm === "bcrypt") {
    let cost = BUN_BCRYPT_DEFAULT_COST;
    if (opts && typeof opts === "object" && opts.cost != null) {
      if (typeof opts.cost !== "number") throw new TypeError("cost must be a number");
      cost = opts.cost | 0;
      if (cost < 4 || cost > 31) throw new Error("Rounds must be between 4 and 31");
    }
    return { algorithm, cost };
  }
  if (algorithm !== "argon2id" && algorithm !== "argon2i" && algorithm !== "argon2d") {
    throw new TypeError(
      'unknown algorithm, expected one of: "bcrypt", "argon2id", "argon2d", "argon2i" (default is "argon2id")'
    );
  }
  let { memoryCost, timeCost } = BUN_ARGON2_DEFAULTS;
  if (opts && typeof opts === "object") {
    if (opts.timeCost != null) {
      if (typeof opts.timeCost !== "number") throw new TypeError("timeCost must be a number");
      timeCost = opts.timeCost | 0;
      if (timeCost < 1) throw new Error("Time cost must be greater than 0");
    }
    if (opts.memoryCost != null) {
      if (typeof opts.memoryCost !== "number") throw new TypeError("memoryCost must be a number");
      memoryCost = opts.memoryCost | 0;
      if (memoryCost < 1) throw new Error("Memory cost must be greater than 0");
    }
  }
  return { algorithm, memoryCost, timeCost, parallelism: BUN_ARGON2_DEFAULTS.parallelism };
}

// ---- factory ----------------------------------------------------------------

export function createBunCrypto({ lazy, Buffer, process }) {
  // The wasm crypto codec, reached through the same internalBinding('crypto')
  // seam node:crypto uses (packages/runtime/node/bindings/crypto.js). Resolved
  // lazily and cached: a process that never hashes never touches it.
  //
  // CryptoHasher prefers the binding but can fall back to node:crypto, which in
  // the runtime IS the same binding and outside it (the Wasm-free spike tier) is
  // the host's OpenSSL. Bun.password has no fallback — node:crypto has no argon2
  // and no bcrypt, and approximating a password KDF is the bug we are deleting.
  let bindingCache;
  function cryptoBinding() {
    if (bindingCache !== undefined) return bindingCache;
    bindingCache = null;
    try {
      if (process && typeof process.binding === "function") {
        const b = process.binding("crypto");
        if (b && typeof b.digest === "function") bindingCache = b;
      }
    } catch {
      bindingCache = null;
    }
    return bindingCache;
  }

  function passwordBinding(api) {
    const b = cryptoBinding();
    if (!b || typeof b.argon2Hash !== "function" || !b.hasCodec) {
      throw new Error(
        `Bun.password.${api} needs Vivari's Rust/Wasm crypto codec (packages/crypto), which is ` +
          `not available in this process. It is not emulated: argon2id and bcrypt have no ` +
          `JavaScript stand-in here, and a password hash that is not really argon2id or bcrypt ` +
          `cannot be verified anywhere else — which is worse than failing now.`
      );
    }
    return b;
  }

  const toBytes = (data, encoding) => {
    if (typeof data === "string") return Buffer.from(data, encoding || "utf8");
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    throw new TypeError("expected a string, ArrayBuffer or typed array");
  };

  const sha512 = (bytes) => rawDigest("sha512", bytes);

  // One-shot digest/HMAC over whichever backend this process has.
  function rawDigest(algo, bytes) {
    const b = cryptoBinding();
    if (b) return Buffer.from(b.digest(algo, bytes));
    return Buffer.from(lazy("crypto").createHash(algo).update(bytes).digest());
  }
  function rawHmac(algo, key, bytes) {
    const b = cryptoBinding();
    if (b) return Buffer.from(b.hmac(algo, key, bytes));
    return Buffer.from(lazy("crypto").createHmac(algo, key).update(bytes).digest());
  }

  // ---- Bun.CryptoHasher -----------------------------------------------------
  //
  // KNOWN DIVERGENCE, deliberate: this is a BUFFERING hasher, not a streaming
  // one. `.update()` appends to a chunk list and the digest is computed in one
  // shot at `.digest()` — the same shape as the vendored node:crypto Hash, and
  // forced by the wasm boundary (the crate exposes one-shot `digest`/
  // `hmac_digest`; there is no way to hand a half-finished BoringSSL/RustCrypto
  // context back and forth across wasm-bindgen without keeping the state Rust-side
  // behind a handle, which is a much larger change than this batch).
  //
  // That makes `.copy()` a clone of the buffered input rather than a clone of a
  // mid-state hash context, and the two are OBSERVATIONALLY IDENTICAL for every
  // documented operation: a hash is a pure function of its concatenated input, so
  // `h.copy().update(x).digest()` produces the same bytes either way, `.digest()`
  // resets the same way, and `.byteLength`/`.algorithm` do not depend on state.
  // It is not "replaying buffered input" into a second hasher after the fact —
  // there is only ever one hash computation per digest, over the same bytes Bun
  // would have absorbed incrementally.
  //
  // What genuinely differs is memory: we hold the whole input until `.digest()`,
  // where Bun holds a fixed-size context. That is a performance contract, not a
  // behavioural one, and it is the same trade the rest of this runtime's crypto
  // already makes. It does mean a large `.update()` stream costs memory, and that
  // hashed secrets stay resident until digest — noted here so nobody assumes
  // otherwise.
  class CryptoHasher {
    constructor(algorithm = "sha256", hmacKey) {
      const canonical = canonicalCryptoAlgorithm(algorithm);
      if (canonical == null) {
        // Bun's wording, so the error is searchable against Bun's own docs.
        throw new Error(`Unsupported algorithm ${typeof algorithm === "string" ? algorithm : String(algorithm)}`);
      }
      this._algorithm = canonical;
      this._chunks = [];
      this._key = null;
      this._consumed = false;
      if (hmacKey != null) {
        if (!HMAC_ALGORITHMS.has(canonical)) {
          // Bun throws at construction for these, not at digest time.
          throw new Error(
            `HMAC is not supported for this algorithm yet (${canonical}). Bun keys HMAC over: ` +
              `${[...HMAC_ALGORITHMS].join(", ")}.`
          );
        }
        this._key = toBytes(hmacKey);
      }
    }

    // Every accessor on a consumed HMAC throws — see _live().
    get algorithm() {
      this._live();
      return this._algorithm;
    }
    get byteLength() {
      this._live();
      return DIGEST_BYTE_LENGTH[this._algorithm];
    }

    // THE TRAP, reproduced on purpose. In real Bun an HMAC hasher is *not* reset
    // by `.digest()`; its context is released and every later use throws. A plain
    // hasher IS reset and can be reused from empty. The natural implementation —
    // reset both, keep hashing — is silently wrong: code written against it keeps
    // producing digests that real Bun refuses to produce at all, so the bug only
    // shows up once the code leaves the sandbox. Documented at
    // https://bun.com/docs/api/hashing ("the HMAC Bun.CryptoHasher instance is not
    // reset after .digest() is called, and using the same instance again throws").
    _live() {
      if (this._consumed) throw new Error(HMAC_CONSUMED);
    }

    update(data, inputEncoding) {
      this._live();
      if (data == null) throw new TypeError("expected a string, ArrayBuffer or typed array");
      if (typeof data === "string" && inputEncoding && String(inputEncoding).toLowerCase() === "hex" && data.length % 2) {
        // node:crypto (and current Bun) reject odd-length hex rather than hashing
        // the longest valid even prefix, which is a silent wrong answer.
        const err = new TypeError(
          `The argument 'encoding' is invalid for data of length ${data.length}. Received '${inputEncoding}'`
        );
        err.code = "ERR_INVALID_ARG_VALUE";
        throw err;
      }
      this._chunks.push(toBytes(data, inputEncoding));
      return this;
    }

    copy() {
      this._live();
      const next = new CryptoHasher(this._algorithm, this._key == null ? undefined : this._key);
      next._chunks = this._chunks.slice();
      return next;
    }

    digest(encodingOrArray) {
      this._live();
      const input = this._chunks.length === 1 ? this._chunks[0] : Buffer.concat(this._chunks);
      const out = this._key == null
        ? rawDigest(this._algorithm, input)
        : rawHmac(this._algorithm, this._key, input);
      // HMAC is consumed; a plain hasher resets and is reusable from empty.
      if (this._key == null) this._chunks = [];
      else this._consumed = true;
      return encodeDigest(out, encodingOrArray, DIGEST_BYTE_LENGTH[this._algorithm]);
    }
  }

  function encodeDigest(out, encodingOrArray, size) {
    if (encodingOrArray == null) return out;
    if (ArrayBuffer.isView(encodingOrArray)) {
      if (encodingOrArray.byteLength < size) throw new Error(`TypedArray must be at least ${size} bytes`);
      new Uint8Array(
        encodingOrArray.buffer,
        encodingOrArray.byteOffset,
        encodingOrArray.byteLength
      ).set(out.subarray(0, size));
      return encodingOrArray;
    }
    if (encodingOrArray === "buffer") return out;
    return out.toString(encodingOrArray);
  }

  CryptoHasher.hash = (algorithm, input, encodingOrArray) =>
    new CryptoHasher(algorithm).update(input).digest(encodingOrArray);
  // Bun exposes the supported list as a static. Copied per call so a caller
  // mutating the array cannot corrupt the next reader.
  Object.defineProperty(CryptoHasher, "algorithms", { get: () => CRYPTO_HASHER_ALGORITHMS.slice() });

  // ---- Bun.password ---------------------------------------------------------
  function hashSync(pw, opts) {
    const params = parsePasswordOptions(opts);
    const bytes = toBytes(pw);
    const b = passwordBinding("hash");
    if (params.algorithm === "bcrypt") {
      return b.bcryptHash(bcryptKeyMaterial(bytes, sha512), params.cost);
    }
    return b.argon2Hash(bytes, params.algorithm, params.memoryCost, params.timeCost, params.parallelism);
  }

  function verifySync(pw, stored, algorithm) {
    // Bun: an empty stored hash is `false`, not an error, and is checked before
    // the algorithm is resolved.
    const s = stored == null ? "" : String(stored);
    if (s.length === 0) return false;

    const kind = algorithm || detectPasswordAlgorithm(s);
    if (kind == null) {
      throw new Error(
        `Bun.password.verify: '${s.slice(0, 16)}…' is not a recognised password hash. Expected a PHC ` +
          `argon2 string ($argon2id$…) or a modular-crypt bcrypt string ($2b$…). Real Bun throws ` +
          `UnsupportedAlgorithm here too — a hash we cannot parse is not the same answer as a wrong ` +
          `password, and returning false for it would hide the difference.`
      );
    }
    const bytes = toBytes(pw);
    if (kind === "vv-legacy") return verifyLegacy(bytes, s);
    const b = passwordBinding("verify");
    if (kind === "bcrypt") return b.bcryptVerify(bcryptKeyMaterial(bytes, sha512), s);
    return b.argon2Verify(bytes, s);
  }

  // The pre-argon2 `$vv-<algo>$<salt b64>$<scrypt key b64>` strings. Read-only:
  // see LEGACY_PREFIX for why these are still accepted and why nothing emits them.
  function verifyLegacy(bytes, stored) {
    try {
      const crypto = lazy("crypto");
      const parts = stored.split("$");
      const salt = Buffer.from(parts[2], "base64");
      const key = Buffer.from(parts[3], "base64");
      if (key.length === 0) return false;
      const check = crypto.scryptSync(bytes, salt, key.length);
      return crypto.timingSafeEqual(key, check);
    } catch {
      return false;
    }
  }

  // Bun's async entry points are thread-pooled; ours run on the calling thread
  // and resolve. The signature and the return values match, the concurrency does
  // not — argon2id at Bun's default cost blocks for the duration (see roadmap.md).
  const password = {
    hash: async (pw, opts) => hashSync(pw, opts),
    verify: async (pw, stored, algorithm) => verifySync(pw, stored, algorithm),
    hashSync,
    verifySync,
  };

  return { CryptoHasher, password };
}