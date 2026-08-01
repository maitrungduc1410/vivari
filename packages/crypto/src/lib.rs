// Vivari crypto codec — the Rust/Wasm core beneath Node's real
// lib/crypto.js (Phase 2 #12). Node's crypto API is SYNCHRONOUS
// (createHash().digest(), pbkdf2Sync, createCipheriv().update()); the Web
// Platform's SubtleCrypto is async-only, so — exactly like the zlib codec (#11)
// — the sync primitives live in Wasm. The JS internalBinding('crypto') layer
// buffers input and calls these one-shot functions, keeping lib/crypto's
// streaming shape on top.
//
// Backend: RustCrypto (md-5/sha1/sha2/hmac/pbkdf2/aes/cbc/aes-gcm), pure Rust.
// Scope (S2): digests, HMAC, PBKDF2, AES-CBC (128/192/256) and AES-GCM (128/256).
// Scope (S3, this file's second half): scrypt, and the asymmetric primitives —
// ECDSA over P-256/P-384 and Ed25519 (phase 1), plus RSA (phase 2: RS256/384/512
// PKCS#1v15 + PS256/384/512 PSS sign/verify, OAEP/PKCS1v15 encrypt/decrypt,
// keygen), plus X.509 certificate parsing + signature verify and SEC1 'EC PRIVATE
// KEY' parsing (phase 3). Keys cross as PKCS#8/SPKI DER (RSA also reads PKCS#1, EC
// also reads SEC1), kind auto-detected by trial-parse. Keygen/PSS/OAEP need
// entropy, so getrandom's `js` backend is enabled (WebCrypto in the browser
// Worker, node:crypto under nodejs). Still out of scope (throw loudly in JS):
// DH/ECDH and JWK — later phases.

use wasm_bindgen::prelude::*;

use sha2::Digest; // the digest::Digest 0.10 trait, shared by md-5/sha1/sha2

fn norm(algo: &str) -> String {
    algo.to_ascii_lowercase().replace('-', "")
}

// --- one-shot digest ------------------------------------------------------
// The second group (blake2/sha3/shake/ripemd160/md4/sha512-224) is P2D: it is
// the rest of Bun.CryptoHasher's documented algorithm list, which the Bun shim
// reaches through internalBinding('crypto') directly. Note `norm()` strips
// dashes, so "sha3-256" arrives here as "sha3256" and "blake2b256" unchanged.
//
// shake128/shake256 are extendable-output functions with no intrinsic digest
// length; 16 and 32 bytes are the defaults both Bun and Node use, and are what
// the callers ask for.
#[wasm_bindgen]
pub fn digest(algo: &str, data: &[u8]) -> Result<Vec<u8>, JsError> {
    use blake2::{Blake2b512, Blake2s256};
    use digest::consts::U32;
    use md4::Md4;
    use md5::Md5;
    use ripemd::Ripemd160;
    use sha1::Sha1;
    use sha2::{Sha224, Sha256, Sha384, Sha512, Sha512_224, Sha512_256};
    use sha3::digest::ExtendableOutput;
    use sha3::{Sha3_224, Sha3_256, Sha3_384, Sha3_512, Shake128, Shake256};
    // BLAKE2b-256 is NOT truncated BLAKE2b-512: the output length is mixed into
    // the parameter block, so it is its own function. Blake2b<U32> is that
    // function, and matches what OpenSSL/BoringSSL call "blake2b256".
    type Blake2b256 = blake2::Blake2b<U32>;
    macro_rules! xof {
        ($t:ty, $len:expr) => {{
            let mut out = vec![0u8; $len];
            let mut h = <$t>::default();
            sha3::digest::Update::update(&mut h, data);
            h.finalize_xof_into(&mut out);
            out
        }};
    }
    Ok(match norm(algo).as_str() {
        "md5" => Md5::digest(data).to_vec(),
        "sha1" => Sha1::digest(data).to_vec(),
        "sha224" => Sha224::digest(data).to_vec(),
        "sha256" => Sha256::digest(data).to_vec(),
        "sha384" => Sha384::digest(data).to_vec(),
        "sha512" => Sha512::digest(data).to_vec(),
        "sha512224" => Sha512_224::digest(data).to_vec(),
        "sha512256" => Sha512_256::digest(data).to_vec(),
        "md4" => Md4::digest(data).to_vec(),
        "ripemd160" => Ripemd160::digest(data).to_vec(),
        "blake2b256" => Blake2b256::digest(data).to_vec(),
        "blake2b512" => Blake2b512::digest(data).to_vec(),
        "blake2s256" => Blake2s256::digest(data).to_vec(),
        "sha3224" => Sha3_224::digest(data).to_vec(),
        "sha3256" => Sha3_256::digest(data).to_vec(),
        "sha3384" => Sha3_384::digest(data).to_vec(),
        "sha3512" => Sha3_512::digest(data).to_vec(),
        "shake128" => xof!(Shake128, 16),
        "shake256" => xof!(Shake256, 32),
        other => return Err(JsError::new(&format!("unsupported digest '{other}'"))),
    })
}

// --- one-shot HMAC --------------------------------------------------------
// Everything except BLAKE2 goes through RustCrypto's `hmac`. BLAKE2 cannot: its
// core uses a *lazy* block buffer (the last block is held back so the finalizer
// can mark it), and hmac 0.12 requires an eager one — RustCrypto's position is
// that BLAKE2 has its own native keyed mode, so it deliberately does not wrap.
// But BoringSSL (and therefore Bun) exposes plain HMAC over blake2b, and the
// HMAC construction itself is algorithm-agnostic, so it is spelled out below
// against the 128-byte BLAKE2b block size. Pinned by Bun's own published
// HMAC-blake2b512 vector in scripts/spike-bun-offline.mjs (which is also what
// OpenSSL produces — the two were cross-checked).
//
// shake128/shake256 have no HMAC here, matching Bun: `new CryptoHasher(algo,
// key)` throws for both.
#[wasm_bindgen]
pub fn hmac_digest(algo: &str, key: &[u8], data: &[u8]) -> Result<Vec<u8>, JsError> {
    use blake2::Blake2b512;
    use digest::consts::U32;
    use hmac::{Hmac, Mac};
    use md4::Md4;
    use md5::Md5;
    use ripemd::Ripemd160;
    use sha1::Sha1;
    use sha2::{Sha224, Sha256, Sha384, Sha512, Sha512_224, Sha512_256};
    use sha3::{Sha3_224, Sha3_256, Sha3_384, Sha3_512};
    type Blake2b256 = blake2::Blake2b<U32>;
    macro_rules! mac {
        ($t:ty) => {{
            let mut m = <Hmac<$t>>::new_from_slice(key)
                .map_err(|_| JsError::new("invalid HMAC key"))?;
            m.update(data);
            m.finalize().into_bytes().to_vec()
        }};
    }
    // HMAC (RFC 2104) written out for the digests hmac 0.12 will not wrap.
    fn hmac_manual<D: sha2::Digest>(block: usize, key: &[u8], data: &[u8]) -> Vec<u8> {
        let mut k = vec![0u8; block];
        if key.len() > block {
            let h = D::digest(key);
            k[..h.len()].copy_from_slice(&h);
        } else {
            k[..key.len()].copy_from_slice(key);
        }
        let ipad: Vec<u8> = k.iter().map(|b| b ^ 0x36).collect();
        let opad: Vec<u8> = k.iter().map(|b| b ^ 0x5c).collect();
        let mut inner = D::new();
        inner.update(&ipad);
        inner.update(data);
        let inner = inner.finalize();
        let mut outer = D::new();
        outer.update(&opad);
        outer.update(&inner);
        outer.finalize().to_vec()
    }
    const BLAKE2B_BLOCK: usize = 128;
    Ok(match norm(algo).as_str() {
        "md5" => mac!(Md5),
        "sha1" => mac!(Sha1),
        "sha224" => mac!(Sha224),
        "sha256" => mac!(Sha256),
        "sha384" => mac!(Sha384),
        "sha512" => mac!(Sha512),
        "sha512224" => mac!(Sha512_224),
        "sha512256" => mac!(Sha512_256),
        "md4" => mac!(Md4),
        "ripemd160" => mac!(Ripemd160),
        "sha3224" => mac!(Sha3_224),
        "sha3256" => mac!(Sha3_256),
        "sha3384" => mac!(Sha3_384),
        "sha3512" => mac!(Sha3_512),
        "blake2b256" => hmac_manual::<Blake2b256>(BLAKE2B_BLOCK, key, data),
        "blake2b512" => hmac_manual::<Blake2b512>(BLAKE2B_BLOCK, key, data),
        other => return Err(JsError::new(&format!("unsupported HMAC digest '{other}'"))),
    })
}

// --- PBKDF2 (HMAC) --------------------------------------------------------
#[wasm_bindgen]
pub fn pbkdf2(
    algo: &str,
    password: &[u8],
    salt: &[u8],
    iterations: u32,
    keylen: usize,
) -> Result<Vec<u8>, JsError> {
    use pbkdf2::pbkdf2_hmac;
    use sha1::Sha1;
    use sha2::{Sha224, Sha256, Sha384, Sha512};
    let mut out = vec![0u8; keylen];
    match norm(algo).as_str() {
        "sha1" => pbkdf2_hmac::<Sha1>(password, salt, iterations, &mut out),
        "sha224" => pbkdf2_hmac::<Sha224>(password, salt, iterations, &mut out),
        "sha256" => pbkdf2_hmac::<Sha256>(password, salt, iterations, &mut out),
        "sha384" => pbkdf2_hmac::<Sha384>(password, salt, iterations, &mut out),
        "sha512" => pbkdf2_hmac::<Sha512>(password, salt, iterations, &mut out),
        other => return Err(JsError::new(&format!("unsupported PBKDF2 digest '{other}'"))),
    }
    Ok(out)
}

// --- AES-CBC (PKCS#7) -----------------------------------------------------
// Node's createCipheriv('aes-<n>-cbc'): key 16/24/32 bytes, iv 16 bytes.
#[wasm_bindgen]
pub fn aes_cbc_encrypt(key: &[u8], iv: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, JsError> {
    use cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
    type Enc128 = cbc::Encryptor<aes::Aes128>;
    type Enc192 = cbc::Encryptor<aes::Aes192>;
    type Enc256 = cbc::Encryptor<aes::Aes256>;
    if iv.len() != 16 {
        return Err(JsError::new("aes-cbc iv must be 16 bytes"));
    }
    macro_rules! enc {
        ($t:ty) => {{
            <$t>::new_from_slices(key, iv)
                .map_err(|_| JsError::new("bad key/iv"))?
                .encrypt_padded_vec_mut::<Pkcs7>(plaintext)
        }};
    }
    Ok(match key.len() {
        16 => enc!(Enc128),
        24 => enc!(Enc192),
        32 => enc!(Enc256),
        _ => return Err(JsError::new("aes-cbc key must be 16/24/32 bytes")),
    })
}

#[wasm_bindgen]
pub fn aes_cbc_decrypt(key: &[u8], iv: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, JsError> {
    use cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    type Dec128 = cbc::Decryptor<aes::Aes128>;
    type Dec192 = cbc::Decryptor<aes::Aes192>;
    type Dec256 = cbc::Decryptor<aes::Aes256>;
    if iv.len() != 16 {
        return Err(JsError::new("aes-cbc iv must be 16 bytes"));
    }
    if ciphertext.len() % 16 != 0 || ciphertext.is_empty() {
        return Err(JsError::new("aes-cbc: invalid ciphertext length"));
    }
    macro_rules! dec {
        ($t:ty) => {{
            <$t>::new_from_slices(key, iv)
                .map_err(|_| JsError::new("bad key/iv"))?
                .decrypt_padded_vec_mut::<Pkcs7>(ciphertext)
                .map_err(|_| JsError::new("aes-cbc: bad padding"))?
        }};
    }
    Ok(match key.len() {
        16 => dec!(Dec128),
        24 => dec!(Dec192),
        32 => dec!(Dec256),
        _ => return Err(JsError::new("aes-cbc key must be 16/24/32 bytes")),
    })
}

// --- AES-GCM --------------------------------------------------------------
// Returns ciphertext || tag(16). JS splits the trailing 16 bytes as authTag
// (Node exposes it via getAuthTag()). Decrypt takes ciphertext || tag.
// IV must be 12 bytes (Node's default; aes-gcm's standard nonce size).
#[wasm_bindgen]
pub fn aes_gcm_encrypt(
    key: &[u8],
    iv: &[u8],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, JsError> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use aes_gcm::{Aes128Gcm, Aes256Gcm, Nonce};
    if iv.len() != 12 {
        return Err(JsError::new("aes-gcm iv must be 12 bytes"));
    }
    let nonce = Nonce::from_slice(iv);
    let payload = Payload { msg: plaintext, aad };
    let ct = match key.len() {
        16 => Aes128Gcm::new_from_slice(key)
            .map_err(|_| JsError::new("bad key"))?
            .encrypt(nonce, payload),
        32 => Aes256Gcm::new_from_slice(key)
            .map_err(|_| JsError::new("bad key"))?
            .encrypt(nonce, payload),
        _ => return Err(JsError::new("aes-gcm key must be 16 or 32 bytes")),
    }
    .map_err(|_| JsError::new("aes-gcm encrypt failed"))?;
    Ok(ct)
}

#[wasm_bindgen]
pub fn aes_gcm_decrypt(
    key: &[u8],
    iv: &[u8],
    aad: &[u8],
    ct_and_tag: &[u8],
) -> Result<Vec<u8>, JsError> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use aes_gcm::{Aes128Gcm, Aes256Gcm, Nonce};
    if iv.len() != 12 {
        return Err(JsError::new("aes-gcm iv must be 12 bytes"));
    }
    let nonce = Nonce::from_slice(iv);
    let payload = Payload { msg: ct_and_tag, aad };
    let pt = match key.len() {
        16 => Aes128Gcm::new_from_slice(key)
            .map_err(|_| JsError::new("bad key"))?
            .decrypt(nonce, payload),
        32 => Aes256Gcm::new_from_slice(key)
            .map_err(|_| JsError::new("bad key"))?
            .decrypt(nonce, payload),
        _ => return Err(JsError::new("aes-gcm key must be 16 or 32 bytes")),
    }
    .map_err(|_| JsError::new("aes-gcm: authentication failed"))?;
    Ok(pt)
}

// =============================================================================
// S3 — scrypt + elliptic asymmetric (ECDSA P-256/P-384, Ed25519)
//
// Node's sign/verify/keygen are SYNCHRONOUS, so — like the rest of this codec —
// the primitives live here in Wasm; lib/crypto.js orchestrates PEM<->DER (base64)
// and the streaming Sign/Verify shape on top. Keys move across the JS boundary as
// PKCS#8 DER (private) / SPKI DER (public); key kind + curve are auto-detected by
// trial-parse so the JS layer stays thin.
// =============================================================================

use ecdsa::signature::hazmat::{PrehashSigner, PrehashVerifier};
use pkcs8::{DecodePrivateKey, EncodePrivateKey};
use rand_core::OsRng;
use spki::{DecodePublicKey, EncodePublicKey};

fn je<E: core::fmt::Display>(e: E) -> JsError {
    JsError::new(&e.to_string())
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Ed25519,
    P256,
    P384,
    Rsa,
}

fn kind_str(k: Kind) -> String {
    match k {
        Kind::Ed25519 => "ed25519".into(),
        Kind::P256 => "ec:prime256v1".into(),
        Kind::P384 => "ec:secp384r1".into(),
        Kind::Rsa => "rsa".into(),
    }
}

// Node's namedCurve / OpenSSL aliases -> our internal Kind.
fn norm_curve(curve: &str) -> Result<Kind, JsError> {
    match curve.to_ascii_lowercase().replace(['-', '_'], "").as_str() {
        "p256" | "prime256v1" | "secp256r1" => Ok(Kind::P256),
        "p384" | "secp384r1" => Ok(Kind::P384),
        other => Err(JsError::new(&format!(
            "unsupported EC curve '{other}' (phase 1: prime256v1 / secp384r1)"
        ))),
    }
}

// EC key DER (PKCS#8/SPKI) is handled at the SecretKey/PublicKey level (that's
// where RustCrypto implements the pkcs8/spki traits); ecdsa Signing/Verifying keys
// are derived from them only for the sign/verify math.
fn detect_private(der: &[u8]) -> Result<Kind, JsError> {
    if ed25519_dalek::SigningKey::from_pkcs8_der(der).is_ok() {
        return Ok(Kind::Ed25519);
    }
    if p256::SecretKey::from_pkcs8_der(der).is_ok() {
        return Ok(Kind::P256);
    }
    if p384::SecretKey::from_pkcs8_der(der).is_ok() {
        return Ok(Kind::P384);
    }
    // SEC1 "EC PRIVATE KEY" (traditional OpenSSL EC private keys); phase 3.
    if p256::SecretKey::from_sec1_der(der).is_ok() {
        return Ok(Kind::P256);
    }
    if p384::SecretKey::from_sec1_der(der).is_ok() {
        return Ok(Kind::P384);
    }
    // RSA: PKCS#8 or the traditional PKCS#1 ("RSA PRIVATE KEY").
    if load_rsa_private(der).is_ok() {
        return Ok(Kind::Rsa);
    }
    Err(JsError::new(
        "unsupported/invalid private key (expected Ed25519 / P-256 / P-384 / RSA, PKCS#8 / PKCS#1 / SEC1)",
    ))
}

fn detect_public(der: &[u8]) -> Result<Kind, JsError> {
    if ed25519_dalek::VerifyingKey::from_public_key_der(der).is_ok() {
        return Ok(Kind::Ed25519);
    }
    if p256::PublicKey::from_public_key_der(der).is_ok() {
        return Ok(Kind::P256);
    }
    if p384::PublicKey::from_public_key_der(der).is_ok() {
        return Ok(Kind::P384);
    }
    if load_rsa_public(der).is_ok() {
        return Ok(Kind::Rsa);
    }
    Err(JsError::new(
        "unsupported/invalid public key (expected Ed25519 / P-256 / P-384 / RSA, SPKI or PKCS#1)",
    ))
}

// RSA keys arrive as PKCS#8/SPKI (modern) or PKCS#1 (traditional OpenSSL); accept both.
fn load_rsa_private(der: &[u8]) -> Result<rsa::RsaPrivateKey, JsError> {
    use rsa::pkcs1::DecodeRsaPrivateKey;
    use rsa::pkcs8::DecodePrivateKey;
    rsa::RsaPrivateKey::from_pkcs8_der(der)
        .or_else(|_| rsa::RsaPrivateKey::from_pkcs1_der(der))
        .map_err(|_| JsError::new("invalid RSA private key (PKCS#8 or PKCS#1)"))
}
fn load_rsa_public(der: &[u8]) -> Result<rsa::RsaPublicKey, JsError> {
    use rsa::pkcs1::DecodeRsaPublicKey;
    use rsa::pkcs8::DecodePublicKey;
    rsa::RsaPublicKey::from_public_key_der(der)
        .or_else(|_| rsa::RsaPublicKey::from_pkcs1_der(der))
        .map_err(|_| JsError::new("invalid RSA public key (SPKI or PKCS#1)"))
}

fn hash_for_ecdsa(algo: &str, data: &[u8]) -> Result<Vec<u8>, JsError> {
    use sha1::Sha1;
    use sha2::{Sha224, Sha256, Sha384, Sha512};
    Ok(match norm(algo).as_str() {
        "sha1" => Sha1::digest(data).to_vec(),
        "sha224" => Sha224::digest(data).to_vec(),
        "sha256" => Sha256::digest(data).to_vec(),
        "sha384" => Sha384::digest(data).to_vec(),
        "sha512" => Sha512::digest(data).to_vec(),
        other => {
            return Err(JsError::new(&format!(
                "unsupported digest '{other}' for ECDSA sign/verify"
            )))
        }
    })
}

// --- keygen: PKCS#8 (private) + SPKI (public) DER ----------------------------
#[wasm_bindgen]
pub struct AsymKeyPair {
    private_der: Vec<u8>,
    public_der: Vec<u8>,
}

#[wasm_bindgen]
impl AsymKeyPair {
    #[wasm_bindgen(getter, js_name = privateDer)]
    pub fn private_der(&self) -> Vec<u8> {
        self.private_der.clone()
    }
    #[wasm_bindgen(getter, js_name = publicDer)]
    pub fn public_der(&self) -> Vec<u8> {
        self.public_der.clone()
    }
}

#[wasm_bindgen]
pub fn generate_ed25519_keypair() -> Result<AsymKeyPair, JsError> {
    let sk = ed25519_dalek::SigningKey::generate(&mut OsRng);
    let vk = sk.verifying_key();
    Ok(AsymKeyPair {
        private_der: sk.to_pkcs8_der().map_err(je)?.as_bytes().to_vec(),
        public_der: vk.to_public_key_der().map_err(je)?.as_bytes().to_vec(),
    })
}

#[wasm_bindgen]
pub fn generate_ec_keypair(curve: &str) -> Result<AsymKeyPair, JsError> {
    match norm_curve(curve)? {
        Kind::P256 => {
            let sk = p256::SecretKey::random(&mut OsRng);
            Ok(AsymKeyPair {
                private_der: sk.to_pkcs8_der().map_err(je)?.as_bytes().to_vec(),
                public_der: sk.public_key().to_public_key_der().map_err(je)?.as_bytes().to_vec(),
            })
        }
        Kind::P384 => {
            let sk = p384::SecretKey::random(&mut OsRng);
            Ok(AsymKeyPair {
                private_der: sk.to_pkcs8_der().map_err(je)?.as_bytes().to_vec(),
                public_der: sk.public_key().to_public_key_der().map_err(je)?.as_bytes().to_vec(),
            })
        }
        Kind::Ed25519 | Kind::Rsa => unreachable!(),
    }
}

// --- key inspection + public-from-private ------------------------------------
// Returns "ed25519" | "ec:prime256v1" | "ec:secp384r1" for the JS KeyObject.
#[wasm_bindgen]
pub fn inspect_private_der(der: &[u8]) -> Result<String, JsError> {
    use rsa::traits::PublicKeyParts;
    let k = detect_private(der)?;
    if k == Kind::Rsa {
        let bits = load_rsa_private(der)?.n().bits();
        return Ok(format!("rsa:{bits}"));
    }
    Ok(kind_str(k))
}

#[wasm_bindgen]
pub fn inspect_public_der(der: &[u8]) -> Result<String, JsError> {
    use rsa::traits::PublicKeyParts;
    let k = detect_public(der)?;
    if k == Kind::Rsa {
        let bits = load_rsa_public(der)?.n().bits();
        return Ok(format!("rsa:{bits}"));
    }
    Ok(kind_str(k))
}

#[wasm_bindgen]
pub fn public_der_from_private_der(der: &[u8]) -> Result<Vec<u8>, JsError> {
    match detect_private(der)? {
        Kind::Ed25519 => {
            let sk = ed25519_dalek::SigningKey::from_pkcs8_der(der).map_err(je)?;
            Ok(sk.verifying_key().to_public_key_der().map_err(je)?.as_bytes().to_vec())
        }
        Kind::P256 => {
            let sk = p256::SecretKey::from_pkcs8_der(der).map_err(je)?;
            Ok(sk.public_key().to_public_key_der().map_err(je)?.as_bytes().to_vec())
        }
        Kind::P384 => {
            let sk = p384::SecretKey::from_pkcs8_der(der).map_err(je)?;
            Ok(sk.public_key().to_public_key_der().map_err(je)?.as_bytes().to_vec())
        }
        Kind::Rsa => {
            use rsa::pkcs8::EncodePublicKey;
            let sk = load_rsa_private(der)?;
            let pk = rsa::RsaPublicKey::from(&sk);
            Ok(pk.to_public_key_der().map_err(je)?.as_bytes().to_vec())
        }
    }
}

// Canonicalize a key's DER to PKCS#8 (private) / SPKI (public). EC/Ed25519 inputs
// are already canonical (returned as-is); RSA PKCS#1 is converted so the JS
// KeyObject always stores — and re-exports — a uniform PKCS#8/SPKI encoding.
#[wasm_bindgen]
pub fn normalize_private_der(der: &[u8]) -> Result<Vec<u8>, JsError> {
    match detect_private(der)? {
        Kind::Rsa => {
            use rsa::pkcs8::EncodePrivateKey;
            Ok(load_rsa_private(der)?.to_pkcs8_der().map_err(je)?.as_bytes().to_vec())
        }
        // EC keys may arrive as SEC1 ("EC PRIVATE KEY"); re-encode to PKCS#8 so the
        // stored/re-exported DER is uniform and asym_sign always sees PKCS#8.
        Kind::P256 => {
            let sk = p256::SecretKey::from_pkcs8_der(der)
                .or_else(|_| p256::SecretKey::from_sec1_der(der))
                .map_err(je)?;
            Ok(sk.to_pkcs8_der().map_err(je)?.as_bytes().to_vec())
        }
        Kind::P384 => {
            let sk = p384::SecretKey::from_pkcs8_der(der)
                .or_else(|_| p384::SecretKey::from_sec1_der(der))
                .map_err(je)?;
            Ok(sk.to_pkcs8_der().map_err(je)?.as_bytes().to_vec())
        }
        // Ed25519 is already canonical PKCS#8.
        Kind::Ed25519 => Ok(der.to_vec()),
    }
}
#[wasm_bindgen]
pub fn normalize_public_der(der: &[u8]) -> Result<Vec<u8>, JsError> {
    match detect_public(der)? {
        Kind::Rsa => {
            use rsa::pkcs8::EncodePublicKey;
            Ok(load_rsa_public(der)?.to_public_key_der().map_err(je)?.as_bytes().to_vec())
        }
        _ => Ok(der.to_vec()),
    }
}

// --- scrypt ------------------------------------------------------------------
// n is the CPU/memory cost (a power of two, e.g. 16384); r block size; p parallel.
#[wasm_bindgen]
pub fn scrypt_kdf(
    password: &[u8],
    salt: &[u8],
    n: u32,
    r: u32,
    p: u32,
    keylen: usize,
) -> Result<Vec<u8>, JsError> {
    if n < 2 || (n & (n - 1)) != 0 {
        return Err(JsError::new("scrypt: N must be a power of two greater than 1"));
    }
    let log_n = n.trailing_zeros() as u8;
    let params = scrypt::Params::new(log_n, r, p, keylen).map_err(je)?;
    let mut out = vec![0u8; keylen];
    scrypt::scrypt(password, salt, &params, &mut out).map_err(je)?;
    Ok(out)
}

// =============================================================================
// P2D — password hashing for Bun.password: argon2(id/i/d) + bcrypt
//
// These are the only two primitives in this crate whose OUTPUT is a string that
// leaves the sandbox and has to be understood elsewhere: a password hash gets
// written to somebody's database. So both emit the standard encodings — PHC
// (`$argon2id$v=19$m=…,t=…,p=…$salt$hash`) for argon2, modular-crypt
// (`$2b$10$…`) for bcrypt — and both verify strings produced by any other
// implementation. The shim this replaced invented a `$vv-scrypt$…` format,
// which meant a hash written in the sandbox was meaningless in production and
// vice versa.
//
// Salts come from the same OsRng the keygen entry points use. Bun's parameters
// are matched exactly by the JS layer (argon2id m=65536 KiB, t=2, p=1, 32-byte
// salt, 32-byte tag; bcrypt cost 10, `$2b$`), so the strings are byte-compatible.
//
// NOT done here, on purpose: bcrypt's 72-byte input limit. Bun SHA-512-prehashes
// longer passwords before bcrypt sees them, and that decision lives in the JS
// layer (packages/runtime/builtins/bun-crypto.js) where it can be unit-tested
// without a wasm build — exactly the split Bun itself uses (PasswordObject
// prehashes; its pwhash module does not).
// =============================================================================

// argon2's memory cost is a real allocation. wasm32 has a 4 GiB address space
// and Rust aborts the whole module on allocation failure (an abort here would
// poison the instance, not throw), so an absurd m= from a hostile or corrupt
// hash string must be rejected BEFORE it reaches the allocator. Real Bun caps
// verification at m = 2^22 KiB (4 GiB); we cap lower because we cannot survive
// getting it wrong. 1 GiB is ~16x the default and far past anything a real
// deployment uses.
const ARGON2_MAX_MEMORY_KIB: u32 = 1024 * 1024;
const ARGON2_MAX_TIME_COST: u32 = 1 << 16;
const ARGON2_MAX_PARALLELISM: u32 = 64;

fn argon2_algorithm(name: &str) -> Result<argon2::Algorithm, JsError> {
    match name {
        "argon2id" => Ok(argon2::Algorithm::Argon2id),
        "argon2i" => Ok(argon2::Algorithm::Argon2i),
        "argon2d" => Ok(argon2::Algorithm::Argon2d),
        other => Err(JsError::new(&format!("unsupported argon2 variant '{other}'"))),
    }
}

fn argon2_guard(m_cost: u32, t_cost: u32, p_cost: u32) -> Result<(), JsError> {
    if m_cost > ARGON2_MAX_MEMORY_KIB {
        return Err(JsError::new(&format!(
            "argon2 memoryCost {m_cost} KiB exceeds the {ARGON2_MAX_MEMORY_KIB} KiB the Vivari \
             sandbox can allocate (wasm32 address space); real Bun would accept it"
        )));
    }
    if t_cost > ARGON2_MAX_TIME_COST || p_cost > ARGON2_MAX_PARALLELISM {
        return Err(JsError::new("argon2 timeCost/parallelism out of range"));
    }
    Ok(())
}

/// argon2 hash -> PHC string. `mode` is "argon2id" | "argon2i" | "argon2d".
#[wasm_bindgen]
pub fn argon2_hash(
    password: &[u8],
    mode: &str,
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
) -> Result<String, JsError> {
    use argon2::password_hash::{PasswordHasher, SaltString};
    argon2_guard(m_cost, t_cost, p_cost)?;
    // 32-byte salt + 32-byte tag: Bun's DEFAULT_SALT_LEN / DEFAULT_HASH_LEN.
    let mut salt = [0u8; 32];
    rand_core::RngCore::fill_bytes(&mut OsRng, &mut salt);
    let salt = SaltString::encode_b64(&salt).map_err(je)?;
    let params = argon2::Params::new(m_cost, t_cost, p_cost, Some(32)).map_err(je)?;
    let hasher = argon2::Argon2::new(argon2_algorithm(mode)?, argon2::Version::V0x13, params);
    Ok(hasher.hash_password(password, &salt).map_err(je)?.to_string())
}

/// Verify a PHC argon2 string. A malformed/foreign string is an ERROR (like
/// Bun's), not a `false` — "this is not an argon2 hash" and "wrong password"
/// are different answers and the caller must be able to tell them apart.
#[wasm_bindgen]
pub fn argon2_verify(password: &[u8], encoded: &str) -> Result<bool, JsError> {
    use argon2::password_hash::{PasswordHash, PasswordVerifier};
    let parsed = PasswordHash::new(encoded).map_err(je)?;
    // The params in the STRING drive the computation, so they are what has to be
    // guarded — this is the hostile-input path.
    let params = argon2::Params::try_from(&parsed).map_err(je)?;
    argon2_guard(params.m_cost(), params.t_cost(), params.p_cost())?;
    match argon2::Argon2::default().verify_password(password, &parsed) {
        Ok(()) => Ok(true),
        Err(argon2::password_hash::Error::Password) => Ok(false),
        Err(e) => Err(je(e)),
    }
}

/// bcrypt hash -> modular-crypt `$2b$<cost>$<22 salt><31 hash>` (60 chars).
/// `password` is expected to be <= 72 bytes; the caller has already applied
/// Bun's SHA-512 prehash if it was longer.
#[wasm_bindgen]
pub fn bcrypt_hash(password: &[u8], cost: u32) -> Result<String, JsError> {
    if !(4..=31).contains(&cost) {
        return Err(JsError::new("bcrypt cost must be between 4 and 31"));
    }
    let mut salt = [0u8; 16];
    rand_core::RngCore::fill_bytes(&mut OsRng, &mut salt);
    let parts = bcrypt::hash_with_salt(password, cost, salt).map_err(je)?;
    Ok(parts.format_for_version(bcrypt::Version::TwoB))
}

/// Verify a modular-crypt bcrypt hash. Like the crate (and like Bun), the
/// version prefix is not part of the comparison: `$2a$`/`$2b$`/`$2y$` hashes
/// with the same salt and digest all verify.
#[wasm_bindgen]
pub fn bcrypt_verify(password: &[u8], encoded: &str) -> Result<bool, JsError> {
    bcrypt::verify(password, encoded).map_err(je)
}

// --- sign / verify (auto-detect key kind) ------------------------------------
// digest_algo is ignored for Ed25519 (PureEdDSA hashes internally). For ECDSA,
// ieee_p1363=true returns the raw r||s (JOSE) encoding; false returns ASN.1 DER
// (Node's default). On verify, the signature is interpreted the same way.
#[wasm_bindgen]
pub fn asym_sign(
    priv_der: &[u8],
    digest_algo: &str,
    data: &[u8],
    ieee_p1363: bool,
) -> Result<Vec<u8>, JsError> {
    match detect_private(priv_der)? {
        Kind::Rsa => Err(JsError::new("internal: RSA keys use rsa_sign")),
        Kind::Ed25519 => {
            use ed25519_dalek::Signer;
            let sk = ed25519_dalek::SigningKey::from_pkcs8_der(priv_der).map_err(je)?;
            Ok(sk.sign(data).to_bytes().to_vec())
        }
        Kind::P256 => {
            let sk = p256::SecretKey::from_pkcs8_der(priv_der).map_err(je)?;
            let signing = p256::ecdsa::SigningKey::from(&sk);
            let hash = hash_for_ecdsa(digest_algo, data)?;
            let sig: p256::ecdsa::Signature = signing.sign_prehash(&hash).map_err(je)?;
            Ok(if ieee_p1363 {
                sig.to_bytes().to_vec()
            } else {
                sig.to_der().as_bytes().to_vec()
            })
        }
        Kind::P384 => {
            let sk = p384::SecretKey::from_pkcs8_der(priv_der).map_err(je)?;
            let signing = p384::ecdsa::SigningKey::from(&sk);
            let hash = hash_for_ecdsa(digest_algo, data)?;
            let sig: p384::ecdsa::Signature = signing.sign_prehash(&hash).map_err(je)?;
            Ok(if ieee_p1363 {
                sig.to_bytes().to_vec()
            } else {
                sig.to_der().as_bytes().to_vec()
            })
        }
    }
}

#[wasm_bindgen]
pub fn asym_verify(
    pub_der: &[u8],
    digest_algo: &str,
    data: &[u8],
    sig: &[u8],
    ieee_p1363: bool,
) -> Result<bool, JsError> {
    match detect_public(pub_der)? {
        Kind::Rsa => Err(JsError::new("internal: RSA keys use rsa_verify")),
        Kind::Ed25519 => {
            use ed25519_dalek::Verifier;
            let vk = ed25519_dalek::VerifyingKey::from_public_key_der(pub_der).map_err(je)?;
            let signature = match ed25519_dalek::Signature::try_from(sig) {
                Ok(s) => s,
                Err(_) => return Ok(false),
            };
            Ok(vk.verify(data, &signature).is_ok())
        }
        Kind::P256 => {
            let pk = p256::PublicKey::from_public_key_der(pub_der).map_err(je)?;
            let vk = p256::ecdsa::VerifyingKey::from(&pk);
            let hash = hash_for_ecdsa(digest_algo, data)?;
            let signature = if ieee_p1363 {
                p256::ecdsa::Signature::from_slice(sig)
            } else {
                p256::ecdsa::Signature::from_der(sig)
            };
            match signature {
                Ok(s) => Ok(vk.verify_prehash(&hash, &s).is_ok()),
                Err(_) => Ok(false),
            }
        }
        Kind::P384 => {
            let pk = p384::PublicKey::from_public_key_der(pub_der).map_err(je)?;
            let vk = p384::ecdsa::VerifyingKey::from(&pk);
            let hash = hash_for_ecdsa(digest_algo, data)?;
            let signature = if ieee_p1363 {
                p384::ecdsa::Signature::from_slice(sig)
            } else {
                p384::ecdsa::Signature::from_der(sig)
            };
            match signature {
                Ok(s) => Ok(vk.verify_prehash(&hash, &s).is_ok()),
                Err(_) => Ok(false),
            }
        }
    }
}

// =============================================================================
// S3 phase 2 — RSA (RS256/384/512 + PSS, OAEP/PKCS1v15 encrypt, keygen)
//
// Node signs a message by hashing then padding, so — like ECDSA — we prehash in
// Rust and feed the digest to RSA's low-level SignatureScheme (Pkcs1v15Sign /
// Pss with the digest's OID). PSS + OAEP need entropy (getrandom `js`). Keys are
// PKCS#8/SPKI (normalized from PKCS#1 by the JS layer before these are called).
// =============================================================================

// Map a digest name to a closure over the right RustCrypto Digest type. Each RSA
// entry point matches the algo once and dispatches to the monomorphized body.
macro_rules! rsa_dispatch {
    ($algo:expr, $body:ident $(, $arg:expr)*) => {{
        use sha1::Sha1;
        use sha2::{Sha256, Sha384, Sha512};
        match norm($algo).as_str() {
            "sha1" => $body::<Sha1>($($arg),*),
            "sha256" => $body::<Sha256>($($arg),*),
            "sha384" => $body::<Sha384>($($arg),*),
            "sha512" => $body::<Sha512>($($arg),*),
            other => Err(JsError::new(&format!("unsupported RSA hash '{other}'"))),
        }
    }};
}

#[wasm_bindgen]
pub fn generate_rsa_keypair(bits: usize) -> Result<AsymKeyPair, JsError> {
    use rsa::pkcs8::{EncodePrivateKey, EncodePublicKey};
    if bits < 1024 || bits > 8192 {
        return Err(JsError::new("RSA modulusLength must be between 1024 and 8192"));
    }
    let sk = rsa::RsaPrivateKey::new(&mut OsRng, bits).map_err(je)?;
    let pk = rsa::RsaPublicKey::from(&sk);
    Ok(AsymKeyPair {
        private_der: sk.to_pkcs8_der().map_err(je)?.as_bytes().to_vec(),
        public_der: pk.to_public_key_der().map_err(je)?.as_bytes().to_vec(),
    })
}

fn rsa_sign_body<D>(sk: &rsa::RsaPrivateKey, hash: &[u8], pss: bool, salt_len: i32) -> Result<Vec<u8>, JsError>
where
    D: digest::Digest + digest::DynDigest + const_oid::AssociatedOid + Send + Sync + 'static,
{
    if pss {
        let scheme = if salt_len >= 0 {
            rsa::Pss::new_with_salt::<D>(salt_len as usize)
        } else {
            rsa::Pss::new::<D>()
        };
        sk.sign_with_rng(&mut OsRng, scheme, hash).map_err(je)
    } else {
        sk.sign(rsa::Pkcs1v15Sign::new::<D>(), hash).map_err(je)
    }
}

#[wasm_bindgen]
pub fn rsa_sign(
    priv_der: &[u8],
    digest_algo: &str,
    data: &[u8],
    pss: bool,
    salt_len: i32,
) -> Result<Vec<u8>, JsError> {
    let sk = load_rsa_private(priv_der)?;
    let hash = hash_for_ecdsa(digest_algo, data)?;
    rsa_dispatch!(digest_algo, rsa_sign_body, &sk, &hash, pss, salt_len)
}

fn rsa_verify_body<D>(pk: &rsa::RsaPublicKey, hash: &[u8], sig: &[u8], pss: bool, salt_len: i32) -> Result<bool, JsError>
where
    D: digest::Digest + digest::DynDigest + const_oid::AssociatedOid + Send + Sync + 'static,
{
    let ok = if pss {
        let scheme = if salt_len >= 0 {
            rsa::Pss::new_with_salt::<D>(salt_len as usize)
        } else {
            rsa::Pss::new::<D>()
        };
        pk.verify(scheme, hash, sig).is_ok()
    } else {
        pk.verify(rsa::Pkcs1v15Sign::new::<D>(), hash, sig).is_ok()
    };
    Ok(ok)
}

#[wasm_bindgen]
pub fn rsa_verify(
    pub_der: &[u8],
    digest_algo: &str,
    data: &[u8],
    sig: &[u8],
    pss: bool,
    salt_len: i32,
) -> Result<bool, JsError> {
    let pk = load_rsa_public(pub_der)?;
    let hash = hash_for_ecdsa(digest_algo, data)?;
    rsa_dispatch!(digest_algo, rsa_verify_body, &pk, &hash, sig, pss, salt_len)
}

fn rsa_encrypt_body<D>(pk: &rsa::RsaPublicKey, data: &[u8]) -> Result<Vec<u8>, JsError>
where
    D: digest::Digest + digest::DynDigest + Send + Sync + 'static,
{
    pk.encrypt(&mut OsRng, rsa::Oaep::new::<D>(), data).map_err(je)
}
fn rsa_decrypt_body<D>(sk: &rsa::RsaPrivateKey, data: &[u8]) -> Result<Vec<u8>, JsError>
where
    D: digest::Digest + digest::DynDigest + Send + Sync + 'static,
{
    sk.decrypt(rsa::Oaep::new::<D>(), data).map_err(je)
}

// oaep=true -> RSA-OAEP with `oaep_hash`; oaep=false -> RSAES-PKCS1-v1_5.
#[wasm_bindgen]
pub fn rsa_encrypt(pub_der: &[u8], data: &[u8], oaep: bool, oaep_hash: &str) -> Result<Vec<u8>, JsError> {
    let pk = load_rsa_public(pub_der)?;
    if oaep {
        rsa_dispatch!(oaep_hash, rsa_encrypt_body, &pk, data)
    } else {
        pk.encrypt(&mut OsRng, rsa::Pkcs1v15Encrypt, data).map_err(je)
    }
}
#[wasm_bindgen]
pub fn rsa_decrypt(priv_der: &[u8], data: &[u8], oaep: bool, oaep_hash: &str) -> Result<Vec<u8>, JsError> {
    let sk = load_rsa_private(priv_der)?;
    if oaep {
        rsa_dispatch!(oaep_hash, rsa_decrypt_body, &sk, data)
    } else {
        sk.decrypt(rsa::Pkcs1v15Encrypt, data).map_err(je)
    }
}

// =============================================================================
// S3 phase 3 — X.509 certificate parsing + signature verify
//
// `new X509Certificate(pem|der)` in lib/crypto.js converts PEM->DER, then calls
// x509_parse() once: the structured, text-y fields come back as JSON (safe
// escaping of subject/SAN strings), and the SubjectPublicKeyInfo comes back as
// raw DER so the JS layer can build `.publicKey` via the existing createPublicKey
// path. Fingerprints are computed in JS from the raw DER (createHash). cert
// signature verification (`cert.verify(key)`) dispatches on the signature
// algorithm OID to the RSA / ECDSA / Ed25519 primitives already in this file.
// =============================================================================

use serde::Serialize;

#[derive(Serialize)]
struct Rdn {
    oid: String,
    value: String,
}

#[derive(Serialize)]
struct San {
    kind: String,
    value: String,
}

#[derive(Serialize)]
struct X509Info {
    subject: Vec<Rdn>,
    issuer: Vec<Rdn>,
    #[serde(rename = "serialNumber")]
    serial_number: String,
    #[serde(rename = "notBefore")]
    not_before: i64,
    #[serde(rename = "notAfter")]
    not_after: i64,
    #[serde(rename = "subjectAltName")]
    subject_alt_name: Vec<San>,
    #[serde(rename = "keyUsage")]
    key_usage: Vec<String>,
    ca: bool,
    #[serde(rename = "sigAlgOid")]
    sig_alg_oid: String,
}

// A parsed cert crossing to JS: `json` (the X509Info above) + the raw SPKI DER
// (fed straight back into createPublicKey for `.publicKey`).
#[wasm_bindgen]
pub struct X509Parsed {
    json: String,
    spki_der: Vec<u8>,
}

#[wasm_bindgen]
impl X509Parsed {
    #[wasm_bindgen(getter)]
    pub fn json(&self) -> String {
        self.json.clone()
    }
    #[wasm_bindgen(getter, js_name = spkiDer)]
    pub fn spki_der(&self) -> Vec<u8> {
        self.spki_der.clone()
    }
}

// Extract a printable string from an RDN AttributeValue (Any), trying the common
// directory-string encodings; falls back to uppercase hex of the raw octets.
fn atv_value_to_string(v: &x509_cert::der::Any) -> String {
    use x509_cert::der::asn1::{Ia5StringRef, PrintableStringRef, TeletexStringRef, Utf8StringRef};
    if let Ok(s) = v.decode_as::<Utf8StringRef>() {
        return s.as_str().to_string();
    }
    if let Ok(s) = v.decode_as::<PrintableStringRef>() {
        return s.as_str().to_string();
    }
    if let Ok(s) = v.decode_as::<Ia5StringRef>() {
        return s.as_str().to_string();
    }
    if let Ok(s) = v.decode_as::<TeletexStringRef>() {
        return s.as_str().to_string();
    }
    // Unknown/binary directory-string type: hex of the DER-encoded value.
    use x509_cert::der::Encode;
    v.to_der()
        .map(|d| d.iter().map(|b| format!("{:02X}", b)).collect::<String>())
        .unwrap_or_default()
}

fn name_to_rdns(name: &x509_cert::name::Name) -> Vec<Rdn> {
    let mut out = Vec::new();
    for rdn in name.0.iter() {
        for atv in rdn.0.iter() {
            out.push(Rdn {
                oid: atv.oid.to_string(),
                value: atv_value_to_string(&atv.value),
            });
        }
    }
    out
}

fn format_ip(octets: &[u8]) -> String {
    match octets.len() {
        4 => octets.iter().map(|b| b.to_string()).collect::<Vec<_>>().join("."),
        16 => octets
            .chunks(2)
            .map(|p| format!("{:x}", ((p[0] as u16) << 8) | p[1] as u16))
            .collect::<Vec<_>>()
            .join(":"),
        _ => octets.iter().map(|b| format!("{:02x}", b)).collect(),
    }
}

#[wasm_bindgen]
pub fn x509_parse(der: &[u8]) -> Result<X509Parsed, JsError> {
    use x509_cert::der::{Decode, Encode};
    use x509_cert::ext::pkix::name::GeneralName;
    use x509_cert::ext::pkix::{BasicConstraints, ExtendedKeyUsage, SubjectAltName};

    let cert = x509_cert::Certificate::from_der(der).map_err(je)?;
    let tbs = &cert.tbs_certificate;

    // Node/OpenSSL print the serial's magnitude (BN_bn2hex): drop the DER sign
    // byte / leading zeros so a high-bit-set serial matches host node:crypto.
    let serial_bytes = tbs.serial_number.as_bytes();
    let start = serial_bytes
        .iter()
        .position(|&b| b != 0)
        .unwrap_or(serial_bytes.len().saturating_sub(1));
    let serial_number = serial_bytes[start..]
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<String>();

    let not_before = tbs.validity.not_before.to_unix_duration().as_secs() as i64;
    let not_after = tbs.validity.not_after.to_unix_duration().as_secs() as i64;

    let mut subject_alt_name = Vec::new();
    if let Some((_crit, san)) = tbs.get::<SubjectAltName>().ok().flatten() {
        for gn in san.0.iter() {
            let entry = match gn {
                GeneralName::DnsName(s) => Some(San { kind: "DNS".into(), value: s.as_str().to_string() }),
                GeneralName::Rfc822Name(s) => Some(San { kind: "email".into(), value: s.as_str().to_string() }),
                GeneralName::UniformResourceIdentifier(s) => {
                    Some(San { kind: "URI".into(), value: s.as_str().to_string() })
                }
                GeneralName::IpAddress(os) => Some(San { kind: "IP Address".into(), value: format_ip(os.as_bytes()) }),
                GeneralName::DirectoryName(n) => Some(San {
                    kind: "DirName".into(),
                    value: name_to_rdns(n)
                        .iter()
                        .map(|r| format!("{}={}", r.oid, r.value))
                        .collect::<Vec<_>>()
                        .join(","),
                }),
                _ => None,
            };
            if let Some(e) = entry {
                subject_alt_name.push(e);
            }
        }
    }

    let mut key_usage = Vec::new();
    if let Some((_crit, eku)) = tbs.get::<ExtendedKeyUsage>().ok().flatten() {
        for oid in eku.0.iter() {
            key_usage.push(oid.to_string());
        }
    }

    let ca = tbs
        .get::<BasicConstraints>()
        .ok()
        .flatten()
        .map(|(_c, bc)| bc.ca)
        .unwrap_or(false);

    let info = X509Info {
        subject: name_to_rdns(&tbs.subject),
        issuer: name_to_rdns(&tbs.issuer),
        serial_number,
        not_before,
        not_after,
        subject_alt_name,
        key_usage,
        ca,
        sig_alg_oid: cert.signature_algorithm.oid.to_string(),
    };

    let spki_der = tbs.subject_public_key_info.to_der().map_err(je)?;
    let json = serde_json::to_string(&info).map_err(je)?;
    Ok(X509Parsed { json, spki_der })
}

// Verify a certificate's signature against an issuer's SPKI (self-signed when the
// issuer is the cert's own public key). Dispatches on the signatureAlgorithm OID.
#[wasm_bindgen]
pub fn x509_verify(cert_der: &[u8], issuer_spki_der: &[u8]) -> Result<bool, JsError> {
    use x509_cert::der::{Decode, Encode};
    let cert = x509_cert::Certificate::from_der(cert_der).map_err(je)?;
    let tbs_der = cert.tbs_certificate.to_der().map_err(je)?;
    let sig = cert
        .signature
        .as_bytes()
        .ok_or_else(|| JsError::new("x509: signature is not octet-aligned"))?;
    // A wrong key type (issuer key doesn't match the signature algorithm) is not
    // an error — like Node's cert.verify(key), it just means "does not verify".
    Ok(match cert.signature_algorithm.oid.to_string().as_str() {
        "1.2.840.113549.1.1.5" => rsa_verify(issuer_spki_der, "sha1", &tbs_der, sig, false, -1).unwrap_or(false),
        "1.2.840.113549.1.1.11" => rsa_verify(issuer_spki_der, "sha256", &tbs_der, sig, false, -1).unwrap_or(false),
        "1.2.840.113549.1.1.12" => rsa_verify(issuer_spki_der, "sha384", &tbs_der, sig, false, -1).unwrap_or(false),
        "1.2.840.113549.1.1.13" => rsa_verify(issuer_spki_der, "sha512", &tbs_der, sig, false, -1).unwrap_or(false),
        // RSASSA-PSS: hash is carried in params; assume sha256 (salt = digest).
        "1.2.840.113549.1.1.10" => rsa_verify(issuer_spki_der, "sha256", &tbs_der, sig, true, -1).unwrap_or(false),
        "1.2.840.10045.4.3.2" => asym_verify(issuer_spki_der, "sha256", &tbs_der, sig, false).unwrap_or(false),
        "1.2.840.10045.4.3.3" => asym_verify(issuer_spki_der, "sha384", &tbs_der, sig, false).unwrap_or(false),
        "1.2.840.10045.4.3.4" => asym_verify(issuer_spki_der, "sha512", &tbs_der, sig, false).unwrap_or(false),
        "1.3.101.112" => asym_verify(issuer_spki_der, "", &tbs_der, sig, false).unwrap_or(false),
        other => {
            return Err(JsError::new(&format!(
                "x509: unsupported signature algorithm OID {other}"
            )))
        }
    })
}