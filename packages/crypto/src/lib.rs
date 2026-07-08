// OpenContainer crypto codec — the Rust/Wasm core beneath Node's real
// lib/crypto.js (Phase 2 #12). Node's crypto API is SYNCHRONOUS
// (createHash().digest(), pbkdf2Sync, createCipheriv().update()); the Web
// Platform's SubtleCrypto is async-only, so — exactly like the zlib codec (#11)
// — the sync primitives live in Wasm. The JS internalBinding('crypto') layer
// buffers input and calls these one-shot functions, keeping lib/crypto's
// streaming shape on top.
//
// Backend: RustCrypto (md-5/sha1/sha2/hmac/pbkdf2/aes/cbc/aes-gcm), pure Rust,
// no getrandom (JS always passes explicit salt/iv from WebCrypto). Scope (S2):
// digests, HMAC, PBKDF2, AES-CBC (128/192/256) and AES-GCM (128/256). Sign/
// verify, RSA/EC, DH and X.509 are out of scope and throw loudly in JS.

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
