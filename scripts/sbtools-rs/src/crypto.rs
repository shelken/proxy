//! 基于 X25519 + HKDF-SHA256 + AES-256-GCM 的端到端非对称加密模块。
//! 客户端利用服务端公钥加密配置参数；服务端利用自身私钥解密。

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::Sha256;
pub use x25519_dalek::StaticSecret as CryptoStaticSecret;
use x25519_dalek::{EphemeralSecret, PublicKey, StaticSecret};

const HKDF_SALT: &[u8] = b"sb-sync-v1";
const HKDF_INFO: &[u8] = b"aes-256-gcm";
const NONCE_LEN: usize = 12;
const PK_LEN: usize = 32;
const TAG_LEN: usize = 16;
const MIN_PAYLOAD_LEN: usize = PK_LEN + NONCE_LEN + TAG_LEN;

/// 生成随机的服务端 X25519 公私钥对（Hex 编码）
pub fn generate_keypair_hex() -> (String, String) {
    let secret = StaticSecret::random_from_rng(OsRng);
    let public = PublicKey::from(&secret);
    (
        hex::encode(secret.to_bytes()),
        hex::encode(public.as_bytes()),
    )
}

/// 解析 Hex 编码的 32 字节私钥
pub fn parse_private_key_hex(hex_str: &str) -> Result<StaticSecret, String> {
    let bytes = hex::decode(hex_str.trim()).map_err(|e| format!("私钥 Hex 解析失败: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!("私钥长度必须为 32 字节，当前为 {}", bytes.len()));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(StaticSecret::from(arr))
}

/// 解析 Hex 编码的 32 字节公钥
pub fn parse_public_key_hex(hex_str: &str) -> Result<PublicKey, String> {
    let bytes = hex::decode(hex_str.trim()).map_err(|e| format!("公钥 Hex 解析失败: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!("公钥长度必须为 32 字节，当前为 {}", bytes.len()));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(PublicKey::from(arr))
}

/// 私钥 Hex → 公钥 Hex。服务端启动时用它从 `SERVER_PRIVATE_KEY` 推出 `GET /pubkey` 的返回值，
/// 客户端因此无需手工配置公钥。
pub fn derive_public_key_hex(private_key_hex: &str) -> Result<String, String> {
    let sk = parse_private_key_hex(private_key_hex)?;
    Ok(hex::encode(PublicKey::from(&sk).as_bytes()))
}

/// 客户端加密：生成临时密钥对 -> 计算共享密钥 -> HKDF 派生 AES 密钥 -> AES-256-GCM 加密 -> base64url
pub fn encrypt_payload(server_pk: &PublicKey, plaintext: &[u8]) -> Result<String, String> {
    let ephemeral_secret = EphemeralSecret::random_from_rng(OsRng);
    let ephemeral_public = PublicKey::from(&ephemeral_secret);

    // 1. Diffie-Hellman 计算共享密钥
    let shared_secret = ephemeral_secret.diffie_hellman(server_pk);

    // 2. HKDF-SHA256 派生 32 字节 AES 密钥
    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), shared_secret.as_bytes());
    let mut derived_key = [0u8; 32];
    hk.expand(HKDF_INFO, &mut derived_key)
        .map_err(|e| format!("HKDF 密钥派生失败: {e}"))?;

    // 3. 随机 12 字节 Nonce
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    // 4. AES-256-GCM 加密
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&derived_key));
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| format!("AES-256-GCM 加密失败: {e}"))?;

    // 5. 拼装: [32B 临时公钥] + [12B Nonce] + [密文 + Tag]
    let mut payload = Vec::with_capacity(PK_LEN + NONCE_LEN + ciphertext.len());
    payload.extend_from_slice(ephemeral_public.as_bytes());
    payload.extend_from_slice(&nonce_bytes);
    payload.extend_from_slice(&ciphertext);

    // 6. Base64 URL-safe 无填充编码
    Ok(URL_SAFE_NO_PAD.encode(&payload))
}

/// 服务端解密：base64url 解码 -> 提取临时公钥与 Nonce -> 计算共享密钥 -> HKDF -> AES-256-GCM 解密
pub fn decrypt_payload(server_sk: &StaticSecret, encoded: &str) -> Result<Vec<u8>, String> {
    let payload = URL_SAFE_NO_PAD
        .decode(encoded.trim())
        .map_err(|e| format!("Base64URL 解码失败: {e}"))?;

    if payload.len() < MIN_PAYLOAD_LEN {
        return Err(format!(
            "载荷长度不足: 当前 {} 字节，最小需要 {} 字节",
            payload.len(),
            MIN_PAYLOAD_LEN
        ));
    }

    let mut epk_bytes = [0u8; PK_LEN];
    epk_bytes.copy_from_slice(&payload[..PK_LEN]);
    let ephemeral_pk = PublicKey::from(epk_bytes);

    let nonce_bytes = &payload[PK_LEN..PK_LEN + NONCE_LEN];
    let nonce = Nonce::from_slice(nonce_bytes);
    let ciphertext = &payload[PK_LEN + NONCE_LEN..];

    // 1. Diffie-Hellman
    let shared_secret = server_sk.diffie_hellman(&ephemeral_pk);

    // 2. HKDF-SHA256 派生相同 32 字节 AES 密钥
    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), shared_secret.as_bytes());
    let mut derived_key = [0u8; 32];
    hk.expand(HKDF_INFO, &mut derived_key)
        .map_err(|e| format!("HKDF 密钥派生失败: {e}"))?;

    // 3. AES-256-GCM 解密
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&derived_key));
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("AES-256-GCM 解密失败: {e}"))?;

    Ok(plaintext)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_keygen_and_roundtrip() {
        let (sk_hex, pk_hex) = generate_keypair_hex();
        let sk = parse_private_key_hex(&sk_hex).expect("解析私钥");
        let pk = parse_public_key_hex(&pk_hex).expect("解析公钥");

        let original = b"{\"subs\":[\"https://airport.example/sub\"],\"nodes\":[\"hy2://...\"]}";
        let encrypted = encrypt_payload(&pk, original).expect("加密成功");

        let decrypted = decrypt_payload(&sk, &encrypted).expect("解密成功");
        assert_eq!(decrypted, original);
    }

    /// 回归：服务端 `GET /pubkey` 的返回值由私钥推出，必须与 keygen 输出的公钥逐字节一致，
    /// 否则客户端拿到的公钥加出的密文服务端解不开。
    #[test]
    fn derived_public_key_matches_generated() {
        let (sk_hex, pk_hex) = generate_keypair_hex();
        assert_eq!(derive_public_key_hex(&sk_hex).unwrap(), pk_hex);

        // 推导出的公钥必须能真的加密，并被对应私钥解开
        let derived = parse_public_key_hex(&derive_public_key_hex(&sk_hex).unwrap()).unwrap();
        let sk = parse_private_key_hex(&sk_hex).unwrap();
        let sealed = encrypt_payload(&derived, b"payload").unwrap();
        assert_eq!(decrypt_payload(&sk, &sealed).unwrap(), b"payload");
    }

    #[test]
    fn derive_public_key_rejects_bad_hex() {
        assert!(derive_public_key_hex("not-hex").is_err());
        assert!(derive_public_key_hex("aabb").is_err());
    }

    #[test]
    fn test_tamper_fails() {
        let (sk_hex, pk_hex) = generate_keypair_hex();
        let sk = parse_private_key_hex(&sk_hex).unwrap();
        let pk = parse_public_key_hex(&pk_hex).unwrap();

        let original = b"secret content";
        let encrypted = encrypt_payload(&pk, original).unwrap();

        // 篡改密文最后一位
        let mut bytes = URL_SAFE_NO_PAD.decode(&encrypted).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        let tampered = URL_SAFE_NO_PAD.encode(&bytes);

        let err = decrypt_payload(&sk, &tampered).unwrap_err();
        assert!(err.contains("解密失败"), "报错内容: {err}");
    }

    #[test]
    fn test_wrong_key_fails() {
        let (_sk1_hex, pk1_hex) = generate_keypair_hex();
        let (sk2_hex, _pk2_hex) = generate_keypair_hex();
        let pk1 = parse_public_key_hex(&pk1_hex).unwrap();
        let sk2 = parse_private_key_hex(&sk2_hex).unwrap();

        let original = b"another secret";
        let encrypted = encrypt_payload(&pk1, original).unwrap();

        // 用错误的私钥解密
        let err = decrypt_payload(&sk2, &encrypted).unwrap_err();
        assert!(err.contains("解密失败"), "报错内容: {err}");
    }

    #[test]
    fn test_truncated_payload_fails() {
        let (sk_hex, _) = generate_keypair_hex();
        let sk = parse_private_key_hex(&sk_hex).unwrap();

        let short_payload = URL_SAFE_NO_PAD.encode(b"too-short");
        let err = decrypt_payload(&sk, &short_payload).unwrap_err();
        assert!(err.contains("载荷长度不足"), "报错内容: {err}");
    }
}
