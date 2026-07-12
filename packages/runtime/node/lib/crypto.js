// `crypto` builtin (Phase 2 #12) — hand-written lib on top of
// internalBinding('crypto'), which is backed by the Rust/Wasm crypto codec
// (packages/crypto: RustCrypto). Node's crypto API is synchronous and
// SubtleCrypto is async-only, so the primitives live in Wasm (like zlib #11).
//
// Covered (S2): createHash (md5/sha1/sha224/256/384/512/512-256), createHmac,
// pbkdf2/pbkdf2Sync, createCipheriv/createDecipheriv for AES-CBC (128/192/256)
// and AES-GCM (128/256) incl. setAAD/getAuthTag/setAuthTag, and WebCrypto-backed
// randomBytes/randomFill/randomInt/randomUUID.
//
// NOT covered: sign/verify, RSA/EC keygen, DH, scrypt, X.509 — they throw.

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
        this._key = toBytes(key);
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

    _classes = { Hash, Hmac };
    return _classes;
  }

  // --- AES ciphers --------------------------------------------------------
  // Node's Cipheriv/Decipheriv stream; our codec is one-shot, so update()
  // buffers and final() does the work (Buffer.concat([c.update(x), c.final()])
  // yields the full result). GCM appends/consumes a 16-byte auth tag.
  function parseAlgo(algorithm) {
    const parts = String(algorithm).toLowerCase().split("-");
    if (parts[0] !== "aes" || parts.length < 3) {
      throw new Error(`OpenContainer crypto: unsupported cipher '${algorithm}' (only aes-<128|192|256>-<cbc|gcm>)`);
    }
    const mode = parts[2];
    if (mode !== "cbc" && mode !== "gcm") {
      throw new Error(`OpenContainer crypto: unsupported cipher mode '${mode}' (only cbc, gcm)`);
    }
    return { mode };
  }

  class Cipheriv {
    constructor(algorithm, key, iv) {
      this._mode = parseAlgo(algorithm).mode;
      this._key = toBytes(key);
      this._iv = toBytes(iv);
      this._chunks = [];
      this._aad = null;
      this._authTag = null;
      this._autoPad = true;
      this._done = false;
    }
    setAutoPadding(v = true) {
      if (this._mode === "cbc" && !v) {
        throw new Error("OpenContainer crypto: cipher.setAutoPadding(false) is not supported");
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
      this._key = toBytes(key);
      this._iv = toBytes(iv);
      this._chunks = [];
      this._aad = null;
      this._authTag = null;
      this._done = false;
    }
    setAutoPadding(v = true) {
      if (this._mode === "cbc" && !v) {
        throw new Error("OpenContainer crypto: decipher.setAutoPadding(false) is not supported");
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

  const notSupported = (name) => () => {
    throw new Error(`OpenContainer crypto: ${name} is not supported yet`);
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
    // Explicitly-unsupported surfaces fail loudly rather than silently misbehave.
    createSign: notSupported("createSign"),
    createVerify: notSupported("createVerify"),
    generateKeyPair: notSupported("generateKeyPair"),
    generateKeyPairSync: notSupported("generateKeyPairSync"),
    scrypt: notSupported("scrypt"),
    scryptSync: notSupported("scryptSync"),
  };
}
