// `crypto` builtin (Phase 2 #12) — hand-written lib on top of
// internalBinding('crypto'), which is backed by the Rust/Wasm crypto codec
// (packages/crypto: RustCrypto). Node's crypto API is synchronous and
// SubtleCrypto is async-only, so the primitives live in Wasm (like zlib #11).
//
// Covered (S2): createHash (md5/sha1/sha224/256/384/512/512-256), createHmac,
// pbkdf2/pbkdf2Sync, createCipheriv/createDecipheriv for AES-CBC (128/192/256)
// and AES-GCM (128/256) incl. setAAD/getAuthTag/setAuthTag, WebCrypto-backed
// randomBytes/randomFill/randomInt/randomUUID, and a SYMMETRIC KeyObject
// (KeyObject + createSecretKey) so jsonwebtoken@9 HS256/384/512 works.
//
// Covered (S3): scrypt/scryptSync, and the ELLIPTIC asymmetric surface —
// createPrivateKey/createPublicKey (PKCS#8 'PRIVATE KEY' + SPKI 'PUBLIC KEY',
// PEM or DER), asymmetric KeyObjects (ec/ed25519), createSign/createVerify +
// one-shot sign/verify, and generateKeyPair(Sync) for 'ec' (prime256v1/secp384r1)
// and 'ed25519'. Unlocks ES256/ES384 + EdDSA JWTs (jsonwebtoken/jose native path).
// The Rust codec does the math; this layer handles PEM<->DER + the stream shape.
//
// NOT covered yet (throw loudly): RSA (RS/PS, publicEncrypt/privateDecrypt),
// SEC1 'EC PRIVATE KEY' / PKCS#1, encrypted/passphrase keys, DH/ECDH, X.509, JWK.

export default function (exports, require, module, process, internalBinding) {
  const { Buffer } = require("buffer");
  const binding = internalBinding("crypto");

  // --- byte helpers -------------------------------------------------------
  function toBytes(data, inputEncoding) {
    if (data == null) return new Uint8Array(0);
    if (typeof data === "string") return new Uint8Array(Buffer.from(data, inputEncoding || "utf8"));
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new Uint8Array(Buffer.from(data));
  }
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
  function encodeOut(bytes, encoding) {
    if (!encoding || encoding === "buffer") return Buffer.from(bytes);
    return Buffer.from(bytes).toString(encoding);
  }

  // --- KeyObject (secret only) --------------------------------------------
  // Minimal `crypto.KeyObject` + `createSecretKey`. This exists so libraries
  // that route key material through Node's KeyObject API work with our
  // HMAC-backed algorithms — chiefly jsonwebtoken@9, whose sign()/verify() do
  // `secret instanceof KeyObject`, convert raw secrets via createSecretKey()
  // (falling back from createPrivateKey/createPublicKey), and require
  // `key.type === 'secret'` before HS* dispatch. jwa (jws' engine) also gates
  // KeyObject support on `typeof crypto.createPublicKey === 'function'` and
  // then feeds the KeyObject straight into `crypto.createHmac(...)`.
  //
  // Only symmetric (secret) keys are real here. createPrivateKey/createPublicKey
  // are callable stubs that THROW — that is deliberate and load-bearing:
  // jsonwebtoken tries them first and falls back to createSecretKey on throw, so
  // a raw HMAC secret becomes a secret KeyObject; and an asymmetric PEM ends up
  // as a secret key that fails the later `type === 'private'/'public'` check with
  // a clear "must be an asymmetric key" error (RS/ES/PS stay unsupported).
  const kKeyObjectBrand = Symbol.for("vivari.crypto.KeyObject");
  const kKeyMaterial = Symbol("kKeyMaterial");

  class KeyObject {
    constructor(type) {
      if (type !== "secret" && type !== "public" && type !== "private") {
        throw new TypeError(`Invalid KeyObject type: ${type}`);
      }
      this._type = type;
      Object.defineProperty(this, kKeyObjectBrand, { value: true });
    }
    get type() {
      return this._type;
    }
  }

  class SecretKeyObject extends KeyObject {
    constructor(bytes) {
      super("secret");
      this[kKeyMaterial] = bytes;
    }
    get symmetricKeySize() {
      return this[kKeyMaterial].length;
    }
    get asymmetricKeyType() {
      return undefined;
    }
    export(options) {
      const buf = Buffer.from(this[kKeyMaterial]);
      if (options && options.format === "jwk") {
        return { kty: "oct", k: buf.toString("base64url") };
      }
      return buf;
    }
  }

  function createSecretKey(key, encoding) {
    const bytes =
      typeof key === "string" ? new Uint8Array(Buffer.from(key, encoding || "utf8")) : toBytes(key);
    return new SecretKeyObject(bytes);
  }

  // Accept a raw secret (string/Buffer/TypedArray) OR a secret KeyObject in the
  // key position of HMAC/cipher and return its raw bytes.
  function keyToBytes(key, inputEncoding) {
    if (key != null && typeof key === "object" && key[kKeyObjectBrand]) {
      if (key.type !== "secret") {
        throw new TypeError("Vivari crypto: expected a secret KeyObject for symmetric operations");
      }
      return key[kKeyMaterial];
    }
    return toBytes(key, inputEncoding);
  }

  // --- Hash / Hmac (one-shot over the binding, buffered in JS) -------------
  // Real Node's Hash/Hmac ARE streams (Transform), so idiomatic code pipes bytes
  // *into* them and then calls .digest() — e.g. corepack does
  // `hash = stream.pipe(createHash(algo))` on a package-manager tarball download,
  // then `hash.digest('hex')`. So Hash/Hmac extend the vendored `Writable`: piped
  // chunks land in `_write` -> update(), and digest() finalises the buffer as
  // before. Built lazily so requiring `crypto` never forces `stream` at boot.
  let _classes = null;
  function classes() {
    if (_classes) return _classes;
    const { Writable } = require("stream");

    class Hash extends Writable {
      constructor(algo, options) {
        super(options);
        this._algo = algo;
        this._chunks = [];
        this._done = false;
      }
      _write(chunk, _enc, cb) {
        try {
          this._chunks.push(toBytes(chunk));
          cb();
        } catch (e) {
          cb(e);
        }
      }
      update(data, inputEncoding) {
        if (this._done) throw new Error("Digest already called");
        this._chunks.push(toBytes(data, inputEncoding));
        return this;
      }
      digest(encoding) {
        if (this._done) throw new Error("Digest already called");
        this._done = true;
        return encodeOut(binding.digest(this._algo, concat(this._chunks)), encoding);
      }
      copy() {
        const h = new Hash(this._algo);
        h._chunks = this._chunks.slice();
        return h;
      }
    }

    class Hmac extends Writable {
      constructor(algo, key, options) {
        super(options);
        this._algo = algo;
        this._key = keyToBytes(key);
        this._chunks = [];
        this._done = false;
      }
      _write(chunk, _enc, cb) {
        try {
          this._chunks.push(toBytes(chunk));
          cb();
        } catch (e) {
          cb(e);
        }
      }
      update(data, inputEncoding) {
        if (this._done) throw new Error("Digest already called");
        this._chunks.push(toBytes(data, inputEncoding));
        return this;
      }
      digest(encoding) {
        if (this._done) throw new Error("Digest already called");
        this._done = true;
        return encodeOut(binding.hmac(this._algo, this._key, concat(this._chunks)), encoding);
      }
    }

    // Sign/Verify are Writable streams too (Node's are), so `stream.pipe(sign)`
    // then `sign.sign(key)` works. Buffered like Hash, signed one-shot in Wasm.
    class Sign extends Writable {
      constructor(algorithm, options) {
        super(options);
        this._algo = algorithm;
        this._chunks = [];
      }
      _write(chunk, enc, cb) {
        try {
          this._chunks.push(toBytes(chunk, enc));
          cb();
        } catch (e) {
          cb(e);
        }
      }
      update(data, inputEncoding) {
        this._chunks.push(toBytes(data, inputEncoding));
        return this;
      }
      sign(privateKey, outputEncoding) {
        const { der, dsaEncoding } = resolveSignKey(privateKey, "private");
        const sig = binding.asymSign(
          der,
          normalizeSignAlgo(this._algo),
          concat(this._chunks),
          dsaEncoding === "ieee-p1363",
        );
        return outputEncoding ? Buffer.from(sig).toString(outputEncoding) : Buffer.from(sig);
      }
    }

    class Verify extends Writable {
      constructor(algorithm, options) {
        super(options);
        this._algo = algorithm;
        this._chunks = [];
      }
      _write(chunk, enc, cb) {
        try {
          this._chunks.push(toBytes(chunk, enc));
          cb();
        } catch (e) {
          cb(e);
        }
      }
      update(data, inputEncoding) {
        this._chunks.push(toBytes(data, inputEncoding));
        return this;
      }
      verify(key, signature, signatureEncoding) {
        const { der, dsaEncoding } = resolveSignKey(key, "public");
        const sig =
          typeof signature === "string"
            ? new Uint8Array(Buffer.from(signature, signatureEncoding || "hex"))
            : toBytes(signature);
        return binding.asymVerify(
          der,
          normalizeSignAlgo(this._algo),
          concat(this._chunks),
          sig,
          dsaEncoding === "ieee-p1363",
        );
      }
    }

    _classes = { Hash, Hmac, Sign, Verify };
    return _classes;
  }

  // --- AES ciphers --------------------------------------------------------
  // Node's Cipheriv/Decipheriv stream; our codec is one-shot, so update()
  // buffers and final() does the work (Buffer.concat([c.update(x), c.final()])
  // yields the full result). GCM appends/consumes a 16-byte auth tag.
  function parseAlgo(algorithm) {
    const parts = String(algorithm).toLowerCase().split("-");
    if (parts[0] !== "aes" || parts.length < 3) {
      throw new Error(`Vivari crypto: unsupported cipher '${algorithm}' (only aes-<128|192|256>-<cbc|gcm>)`);
    }
    const mode = parts[2];
    if (mode !== "cbc" && mode !== "gcm") {
      throw new Error(`Vivari crypto: unsupported cipher mode '${mode}' (only cbc, gcm)`);
    }
    return { mode };
  }

  class Cipheriv {
    constructor(algorithm, key, iv) {
      this._mode = parseAlgo(algorithm).mode;
      this._key = keyToBytes(key);
      this._iv = toBytes(iv);
      this._chunks = [];
      this._aad = null;
      this._authTag = null;
      this._autoPad = true;
      this._done = false;
    }
    setAutoPadding(v = true) {
      if (this._mode === "cbc" && !v) {
        throw new Error("Vivari crypto: cipher.setAutoPadding(false) is not supported");
      }
      return this;
    }
    setAAD(buffer) {
      this._aad = toBytes(buffer);
      return this;
    }
    update(data, inputEncoding, outputEncoding) {
      this._chunks.push(toBytes(data, inputEncoding));
      return outputEncoding ? "" : Buffer.alloc(0);
    }
    final(outputEncoding) {
      if (this._done) throw new Error("Cipher final already called");
      this._done = true;
      const pt = concat(this._chunks);
      let out;
      if (this._mode === "gcm") {
        const ctTag = this._aesGcm(pt);
        this._authTag = Buffer.from(ctTag.subarray(ctTag.length - 16));
        out = ctTag.subarray(0, ctTag.length - 16);
      } else {
        out = binding.aesCbcEncrypt(this._key, this._iv, pt);
      }
      return encodeOut(out, outputEncoding);
    }
    _aesGcm(pt) {
      return binding.aesGcmEncrypt(this._key, this._iv, this._aad, pt);
    }
    getAuthTag() {
      if (this._mode !== "gcm") throw new Error("getAuthTag is only valid for GCM");
      if (!this._authTag) throw new Error("getAuthTag can only be called after final()");
      return this._authTag;
    }
  }

  class Decipheriv {
    constructor(algorithm, key, iv) {
      this._mode = parseAlgo(algorithm).mode;
      this._key = keyToBytes(key);
      this._iv = toBytes(iv);
      this._chunks = [];
      this._aad = null;
      this._authTag = null;
      this._done = false;
    }
    setAutoPadding(v = true) {
      if (this._mode === "cbc" && !v) {
        throw new Error("Vivari crypto: decipher.setAutoPadding(false) is not supported");
      }
      return this;
    }
    setAAD(buffer) {
      this._aad = toBytes(buffer);
      return this;
    }
    setAuthTag(buffer) {
      this._authTag = toBytes(buffer);
      return this;
    }
    update(data, inputEncoding, outputEncoding) {
      this._chunks.push(toBytes(data, inputEncoding));
      return outputEncoding ? "" : Buffer.alloc(0);
    }
    final(outputEncoding) {
      if (this._done) throw new Error("Decipher final already called");
      this._done = true;
      const ct = concat(this._chunks);
      let out;
      if (this._mode === "gcm") {
        if (!this._authTag) throw new Error("Decipher (GCM) requires setAuthTag() before final()");
        out = binding.aesGcmDecrypt(this._key, this._iv, this._aad, concat([ct, this._authTag]));
      } else {
        out = binding.aesCbcDecrypt(this._key, this._iv, ct);
      }
      return encodeOut(out, outputEncoding);
    }
  }

  // --- PBKDF2 -------------------------------------------------------------
  function pbkdf2Sync(password, salt, iterations, keylen, digest = "sha1") {
    return Buffer.from(binding.pbkdf2(digest, toBytes(password), toBytes(salt), iterations, keylen));
  }
  function pbkdf2(password, salt, iterations, keylen, digest, callback) {
    if (typeof digest === "function") {
      callback = digest;
      digest = "sha1";
    }
    let out = null;
    let err = null;
    try {
      out = pbkdf2Sync(password, salt, iterations, keylen, digest);
    } catch (e) {
      err = e;
    }
    queueMicrotask(() => (err ? callback(err) : callback(null, out)));
  }

  // --- randomness (WebCrypto-backed, synchronous) -------------------------
  const webcrypto = globalThis.crypto;
  function fillRandom(view) {
    const u8 = view instanceof Uint8Array ? view : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    for (let off = 0; off < u8.length; off += 65536) {
      webcrypto.getRandomValues(u8.subarray(off, Math.min(off + 65536, u8.length)));
    }
    return view;
  }
  function randomBytes(size, cb) {
    const buf = Buffer.alloc(size);
    fillRandom(buf);
    if (typeof cb === "function") {
      queueMicrotask(() => cb(null, buf));
      return undefined;
    }
    return buf;
  }
  function randomFillSync(buf, offset = 0, size) {
    const len = size == null ? buf.length - offset : size;
    fillRandom(buf.subarray ? buf.subarray(offset, offset + len) : new Uint8Array(buf.buffer, buf.byteOffset + offset, len));
    return buf;
  }
  function randomFill(buf, offset, size, cb) {
    if (typeof offset === "function") { cb = offset; offset = 0; size = buf.length; }
    else if (typeof size === "function") { cb = size; size = buf.length - offset; }
    randomFillSync(buf, offset, size);
    queueMicrotask(() => cb(null, buf));
  }
  function randomInt(min, max, cb) {
    if (max === undefined) { max = min; min = 0; }
    const range = max - min;
    const val = min + Math.floor((fillRandom(new Uint32Array(1))[0] / 4294967296) * range);
    if (typeof cb === "function") { queueMicrotask(() => cb(null, val)); return undefined; }
    return val;
  }
  function randomUUID() {
    if (webcrypto && typeof webcrypto.randomUUID === "function") return webcrypto.randomUUID();
    const b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  // --- S3: asymmetric KeyObjects + PEM<->DER ------------------------------
  // Keys cross into the Wasm codec as PKCS#8 DER (private) / SPKI DER (public);
  // this layer parses/emits the PEM envelope and tracks type + curve for the
  // Node-facing KeyObject surface (asymmetricKeyType / asymmetricKeyDetails).
  function pemToDer(pem) {
    const m = /-----BEGIN ([A-Z0-9 ]+?)-----([\s\S]*?)-----END \1-----/.exec(pem);
    if (!m) return null;
    const b64 = m[2].replace(/[^A-Za-z0-9+/=]/g, "");
    return { label: m[1], der: new Uint8Array(Buffer.from(b64, "base64")) };
  }
  function derToPem(der, label) {
    const b64 = Buffer.from(der).toString("base64");
    const lines = b64.match(/.{1,64}/g) || [""];
    return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
  }

  // Pull a PKCS#8/SPKI DER out of any accepted key input; `isPrivate` records
  // which envelope it came from (PEM label wins; DER falls back to `want`).
  function extractKeyDer(input, want) {
    let keyData = input;
    let format = "pem";
    const isOpts =
      input &&
      typeof input === "object" &&
      typeof input !== "string" &&
      !Buffer.isBuffer(input) &&
      !ArrayBuffer.isView(input) &&
      !(input instanceof ArrayBuffer) &&
      "key" in input;
    if (isOpts) {
      if (input.passphrase != null) {
        throw new Error("Vivari crypto: encrypted/passphrase-protected keys are not supported yet");
      }
      keyData = input.key;
      format = input.format || "pem";
    }
    if (typeof keyData === "string") format = "pem";
    if (format === "pem") {
      const pemStr = typeof keyData === "string" ? keyData : Buffer.from(toBytes(keyData)).toString("utf8");
      const parsed = pemToDer(pemStr);
      if (!parsed) throw new Error("Vivari crypto: could not parse PEM key");
      if (parsed.label === "PRIVATE KEY") return { der: parsed.der, isPrivate: true };
      if (parsed.label === "PUBLIC KEY") return { der: parsed.der, isPrivate: false };
      if (parsed.label === "ENCRYPTED PRIVATE KEY") {
        throw new Error("Vivari crypto: encrypted PKCS#8 keys are not supported yet");
      }
      throw new Error(
        `Vivari crypto: unsupported PEM key '${parsed.label}' (phase 1: PKCS#8 'PRIVATE KEY' / SPKI 'PUBLIC KEY'; SEC1/PKCS#1 not yet)`,
      );
    }
    if (format === "der") return { der: toBytes(keyData), isPrivate: want === "private" };
    throw new Error(`Vivari crypto: unsupported key format '${format}'`);
  }

  class AsymmetricKeyObject extends KeyObject {
    constructor(type, der, descriptor) {
      super(type);
      this[kKeyMaterial] = der;
      const [kt, curve] = String(descriptor).split(":");
      this._asymmetricKeyType = kt;
      this._namedCurve = curve;
    }
    get asymmetricKeyType() {
      return this._asymmetricKeyType;
    }
    get asymmetricKeyDetails() {
      return this._namedCurve ? { namedCurve: this._namedCurve } : {};
    }
    export(options = {}) {
      const format = options.format || "pem";
      if (format === "jwk") throw new Error("Vivari crypto: JWK key export is not supported yet");
      const der = this[kKeyMaterial];
      if (format === "der") return Buffer.from(der);
      if (options.type && options.type !== "pkcs8" && options.type !== "spki") {
        throw new Error(`Vivari crypto: key export type '${options.type}' is not supported yet (pkcs8/spki only)`);
      }
      return derToPem(der, this._type === "private" ? "PRIVATE KEY" : "PUBLIC KEY");
    }
  }

  function unwrapKeyObjectOpts(input) {
    if (
      input &&
      typeof input === "object" &&
      !input[kKeyObjectBrand] &&
      "key" in input &&
      input.key &&
      input.key[kKeyObjectBrand]
    ) {
      return input.key;
    }
    return input;
  }

  function createPrivateKey(input) {
    input = unwrapKeyObjectOpts(input);
    if (input && typeof input === "object" && input[kKeyObjectBrand]) {
      if (input.type === "private") return input;
      throw new Error("Vivari crypto: createPrivateKey requires a private key");
    }
    const { der, isPrivate } = extractKeyDer(input, "private");
    if (!isPrivate) throw new Error("Vivari crypto: expected a private key, got a public key");
    return new AsymmetricKeyObject("private", der, binding.inspectPrivate(der));
  }

  function createPublicKey(input) {
    input = unwrapKeyObjectOpts(input);
    if (input && typeof input === "object" && input[kKeyObjectBrand]) {
      if (input.type === "public") return input;
      if (input.type === "private") {
        const spki = binding.publicFromPrivate(input[kKeyMaterial]);
        return new AsymmetricKeyObject("public", spki, binding.inspectPublic(spki));
      }
      throw new Error("Vivari crypto: cannot derive a public key from a secret key");
    }
    const { der, isPrivate } = extractKeyDer(input, "public");
    if (isPrivate) {
      const spki = binding.publicFromPrivate(der);
      return new AsymmetricKeyObject("public", spki, binding.inspectPublic(spki));
    }
    return new AsymmetricKeyObject("public", der, binding.inspectPublic(der));
  }

  // OpenSSL-style algorithm names ('RSA-SHA256', 'sha256', 'SHA256') -> digest.
  // Ignored for Ed25519 (algorithm is null/undefined there).
  function normalizeSignAlgo(algo) {
    if (!algo) return "";
    return String(algo).toLowerCase().replace(/^rsa-/, "");
  }

  // Resolve a key argument (KeyObject | PEM | DER | { key, dsaEncoding, ... }) to
  // its DER + the ECDSA signature encoding preference.
  function resolveSignKey(key, want) {
    let dsaEncoding;
    if (
      key &&
      typeof key === "object" &&
      typeof key !== "string" &&
      !key[kKeyObjectBrand] &&
      !Buffer.isBuffer(key) &&
      !ArrayBuffer.isView(key) &&
      !(key instanceof ArrayBuffer) &&
      "key" in key
    ) {
      dsaEncoding = key.dsaEncoding;
    }
    const ko = want === "private" ? createPrivateKey(key) : createPublicKey(key);
    return { der: ko[kKeyMaterial], dsaEncoding };
  }

  // --- S3: one-shot sign / verify (crypto.sign / crypto.verify) -----------
  function sign(algorithm, data, key, callback) {
    const { der, dsaEncoding } = resolveSignKey(key, "private");
    const sig = Buffer.from(
      binding.asymSign(der, normalizeSignAlgo(algorithm), toBytes(data), dsaEncoding === "ieee-p1363"),
    );
    if (typeof callback === "function") {
      queueMicrotask(() => callback(null, sig));
      return undefined;
    }
    return sig;
  }
  function verify(algorithm, data, key, signature, callback) {
    const { der, dsaEncoding } = resolveSignKey(key, "public");
    const ok = binding.asymVerify(
      der,
      normalizeSignAlgo(algorithm),
      toBytes(data),
      toBytes(signature),
      dsaEncoding === "ieee-p1363",
    );
    if (typeof callback === "function") {
      queueMicrotask(() => callback(null, ok));
      return undefined;
    }
    return ok;
  }

  // --- S3: scrypt ---------------------------------------------------------
  const SCRYPT_DEFAULTS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
  function scryptSync(password, salt, keylen, options = {}) {
    const N = options.N ?? options.cost ?? SCRYPT_DEFAULTS.N;
    const r = options.r ?? options.blockSize ?? SCRYPT_DEFAULTS.r;
    const p = options.p ?? options.parallelization ?? SCRYPT_DEFAULTS.p;
    const maxmem = options.maxmem ?? SCRYPT_DEFAULTS.maxmem;
    if (128 * N * r > maxmem) {
      throw new Error("Vivari crypto: scrypt: memory limit exceeded (raise `maxmem`)");
    }
    return Buffer.from(binding.scrypt(toBytes(password), toBytes(salt), N, r, p, keylen));
  }
  function scrypt(password, salt, keylen, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    let out = null;
    let err = null;
    try {
      out = scryptSync(password, salt, keylen, options);
    } catch (e) {
      err = e;
    }
    queueMicrotask(() => (err ? callback(err) : callback(null, out)));
  }

  // --- S3: generateKeyPair (ec / ed25519) ---------------------------------
  function encodeGeneratedKey(keyObj, encoding) {
    return encoding ? keyObj.export(encoding) : keyObj;
  }
  function generateKeyPairSync(type, options = {}) {
    const kp = binding.generateKeyPair(type, options);
    const priv = new AsymmetricKeyObject("private", kp.privateDer, binding.inspectPrivate(kp.privateDer));
    const pub = new AsymmetricKeyObject("public", kp.publicDer, binding.inspectPublic(kp.publicDer));
    return {
      publicKey: encodeGeneratedKey(pub, options.publicKeyEncoding),
      privateKey: encodeGeneratedKey(priv, options.privateKeyEncoding),
    };
  }
  function generateKeyPair(type, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    let res = null;
    let err = null;
    try {
      res = generateKeyPairSync(type, options);
    } catch (e) {
      err = e;
    }
    queueMicrotask(() => (err ? callback(err) : callback(null, res.publicKey, res.privateKey)));
  }

  const notSupported = (name) => () => {
    throw new Error(`Vivari crypto: ${name} is not supported yet`);
  };

  module.exports = {
    createHash: (algo, options) => new (classes().Hash)(algo, options),
    createHmac: (algo, key, options) => new (classes().Hmac)(algo, key, options),
    // One-shot hash (Node 20.12+/21.7+). Vite's dep optimizer uses it for the
    // lockfile/dep hash. Default output is 'hex' (not a Buffer, unlike digest()).
    hash: (algorithm, data, outputEncoding) =>
      encodeOut(binding.digest(algorithm, toBytes(data)), outputEncoding || "hex"),
    createCipheriv: (algorithm, key, iv) => new Cipheriv(algorithm, key, iv),
    createDecipheriv: (algorithm, key, iv) => new Decipheriv(algorithm, key, iv),
    get Hash() {
      return classes().Hash;
    },
    get Hmac() {
      return classes().Hmac;
    },
    Cipheriv,
    Decipheriv,
    pbkdf2,
    pbkdf2Sync,
    randomBytes,
    randomFill,
    randomFillSync,
    randomInt,
    randomUUID,
    getRandomValues: (arr) => webcrypto.getRandomValues(arr),
    getHashes: () => binding.getHashes(),
    getCiphers: () => ["aes-128-cbc", "aes-192-cbc", "aes-256-cbc", "aes-128-gcm", "aes-256-gcm"],
    constants: {},
    webcrypto,
    // Key material. Secret (symmetric) via createSecretKey; asymmetric (ec/
    // ed25519) via createPrivateKey/createPublicKey. Note: createPrivateKey still
    // THROWS on a raw secret (it isn't parseable PEM/DER), so jsonwebtoken's HS*
    // fallback to createSecretKey is preserved.
    KeyObject,
    createSecretKey,
    createPrivateKey,
    createPublicKey,
    // S3: elliptic asymmetric sign/verify + scrypt + keygen (Rust/Wasm backed).
    createSign: (algorithm, options) => new (classes().Sign)(algorithm, options),
    createVerify: (algorithm, options) => new (classes().Verify)(algorithm, options),
    sign,
    verify,
    generateKeyPair,
    generateKeyPairSync,
    scrypt,
    scryptSync,
    // Still genuinely unsupported (later phases): RSA encrypt/decrypt + DH.
    publicEncrypt: notSupported("publicEncrypt"),
    privateDecrypt: notSupported("privateDecrypt"),
    privateEncrypt: notSupported("privateEncrypt"),
    publicDecrypt: notSupported("publicDecrypt"),
    createDiffieHellman: notSupported("createDiffieHellman"),
    createECDH: notSupported("createECDH"),
  };
}
