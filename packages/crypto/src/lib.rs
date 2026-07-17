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
// Scope (S3, this file's second half): scrypt, and the ELLIPTIC asymmetric
// primitives — ECDSA over P-256/P-384 and Ed25519 (keygen, sign, verify, PKCS#8/
// SPKI DER key handling). Keygen needs entropy, so getrandom's `js` backend is
// enabled (WebCrypto in the browser Worker, node:crypto under the nodejs target).
// Still out of scope (throw loudly in JS): RSA, DH/ECDH and X.509 — later phases.

use wasm_bindgen::prelude::*;

use sha2::Digest; // the digest::Digest 0.10 trait, shared by md-5/sha1/sha2

fn norm(algo: &str) -> String {
    algo.to_ascii_lowercase().replace('-', "")
}

// --- one-shot digest ------------------------------------------------------
#[wasm_bindgen]
pub fn digest(algo: &str, data: &[u8]) -> Result<Vec<u8>, JsError> {
    use md5::Md5;
    use sha1::Sha1;
    use sha2::{Sha224, Sha256, Sha384, Sha512, Sha512_256};
    Ok(match norm(algo).as_str() {
        "md5" => Md5::digest(data).to_vec(),
        "sha1" => Sha1::digest(data).to_vec(),
        "sha224" => Sha224::digest(data).to_vec(),
        "sha256" => Sha256::digest(data).to_vec(),
        "sha384" => Sha384::digest(data).to_vec(),
        "sha512" => Sha512::digest(data).to_vec(),
        "sha512256" => Sha512_256::digest(data).to_vec(),
        other => return Err(JsError::new(&format!("unsupported digest '{other}'"))),
    })
}

// --- one-shot HMAC --------------------------------------------------------
#[wasm_bindgen]
pub fn hmac_digest(algo: &str, key: &[u8], data: &[u8]) -> Result<Vec<u8>, JsError> {
    use hmac::{Hmac, Mac};
    use md5::Md5;
    use sha1::Sha1;
    use sha2::{Sha224, Sha256, Sha384, Sha512, Sha512_256};
    macro_rules! mac {
        ($t:ty) => {{
            let mut m = <Hmac<$t>>::new_from_slice(key)
                .map_err(|_| JsError::new("invalid HMAC key"))?;
            m.update(data);
            m.finalize().into_bytes().to_vec()
        }};
    }
    Ok(match norm(algo).as_str() {
        "md5" => mac!(Md5),
        "sha1" => mac!(Sha1),
        "sha224" => mac!(Sha224),
        "sha256" => mac!(Sha256),
        "sha384" => mac!(Sha384),
        "sha512" => mac!(Sha512),
        "sha512256" => mac!(Sha512_256),
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
}

fn kind_str(k: Kind) -> String {
    match k {
        Kind::Ed25519 => "ed25519".into(),
        Kind::P256 => "ec:prime256v1".into(),
        Kind::P384 => "ec:secp384r1".into(),
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
    Err(JsError::new(
        "unsupported/invalid private key (expected Ed25519 / P-256 / P-384 PKCS#8)",
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
    Err(JsError::new(
        "unsupported/invalid public key (expected Ed25519 / P-256 / P-384 SPKI)",
    ))
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
        Kind::Ed25519 => unreachable!(),
    }
}

// --- key inspection + public-from-private ------------------------------------
// Returns "ed25519" | "ec:prime256v1" | "ec:secp384r1" for the JS KeyObject.
#[wasm_bindgen]
pub fn inspect_private_der(der: &[u8]) -> Result<String, JsError> {
    Ok(kind_str(detect_private(der)?))
}

#[wasm_bindgen]
pub fn inspect_public_der(der: &[u8]) -> Result<String, JsError> {
    Ok(kind_str(detect_public(der)?))
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
