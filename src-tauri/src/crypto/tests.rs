//! 加密服务单元测试
//!
//! 测试加密解密、密钥管理等核心功能


#[tokio::test]
async fn test_crypto_service_creation() {
    let temp_dir = TempDir::new().unwrap();
    let crypto = CryptoService::new(temp_dir.path()).unwrap();

    // 验证密钥完整性
    assert!(crypto.verify_key_integrity().unwrap());
}

#[tokio::test]
async fn test_encrypt_decrypt_cycle() {
    let temp_dir = TempDir::new().unwrap();
    let crypto = CryptoService::new(temp_dir.path()).unwrap();

    let original_data = "sk-test-api-key-12345";

    // 加密
    let encrypted = crypto.encrypt_api_key(original_data).unwrap();
    assert!(!encrypted.ciphertext.is_empty());
    assert!(!encrypted.nonce.is_empty());

    // 解密
    let decrypted = crypto.decrypt_api_key(&encrypted).unwrap();
    assert_eq!(original_data, decrypted);
}

#[tokio::test]
async fn test_encrypted_format_detection() {
    let temp_dir = TempDir::new().unwrap();
    let crypto = CryptoService::new(temp_dir.path()).unwrap();

    // 测试明文不被识别为加密格式
    assert!(!CryptoService::is_encrypted_format("plain-text-key"));
    assert!(!CryptoService::is_encrypted_format("sk-1234567890"));

    // 测试加密数据被正确识别
    let encrypted = crypto.encrypt_api_key("test-key").unwrap();
    let encrypted_json = serde_json::to_string(&encrypted).unwrap();
    assert!(CryptoService::is_encrypted_format(&encrypted_json));
}

#[tokio::test]
async fn test_migrate_plaintext_key() {
    let temp_dir = TempDir::new().unwrap();
    let crypto = CryptoService::new(temp_dir.path()).unwrap();

    let plaintext_key = "sk-original-plaintext-key";

    // 迁移明文密钥
    let encrypted_json = crypto.migrate_plaintext_key(plaintext_key).unwrap();

    // 验证迁移结果
    assert!(CryptoService::is_encrypted_format(&encrypted_json));

    // 验证可以正确解密
    let encrypted_data: EncryptedData = serde_json::from_str(&encrypted_json).unwrap();
    let decrypted = crypto.decrypt_api_key(&encrypted_data).unwrap();
    assert_eq!(plaintext_key, decrypted);
}

#[tokio::test]
async fn test_key_rotation() {
    let temp_dir = TempDir::new().unwrap();
    let original_crypto = CryptoService::new(temp_dir.path()).unwrap();

    // 加密一些数据
    let test_data = "sensitive-data-before-rotation";
    let original_encrypted = original_crypto.encrypt_api_key(test_data).unwrap();

    // 轮换密钥
    let new_crypto = original_crypto.rotate_master_key(temp_dir.path()).unwrap();

    // 验证新服务正常工作
    assert!(new_crypto.verify_key_integrity().unwrap());

    // 原有加密数据应该无法用新密钥解密（这是预期的安全行为）
    let decrypt_result = new_crypto.decrypt_api_key(&original_encrypted);
    assert!(decrypt_result.is_err());
}

#[tokio::test]
async fn test_empty_and_invalid_data() {
    let temp_dir = TempDir::new().unwrap();
    let crypto = CryptoService::new(temp_dir.path()).unwrap();

    // 测试空字符串加密
    let encrypted_empty = crypto.encrypt_api_key("").unwrap();
    let decrypted_empty = crypto.decrypt_api_key(&encrypted_empty).unwrap();
    assert_eq!("", decrypted_empty);

    // 测试无效的加密数据
    let invalid_encrypted = EncryptedData {
        ciphertext: "invalid-base64-data!@#".to_string(),
        nonce: "invalid-nonce-data!@#".to_string(),
        version: Some(2),
    };

    let decrypt_result = crypto.decrypt_api_key(&invalid_encrypted);
    assert!(decrypt_result.is_err());
}

#[test]
fn test_encrypted_data_serialization() {
    let encrypted = EncryptedData {
        ciphertext: "dGVzdC1jaXBoZXJ0ZXh0".to_string(),
        nonce: "dGVzdC1ub25jZQ==".to_string(),
        version: Some(2),
    };

    // 测试序列化
    let json = serde_json::to_string(&encrypted).unwrap();
    assert!(json.contains("ciphertext"));
    assert!(json.contains("nonce"));

    // 测试反序列化
    let deserialized: EncryptedData = serde_json::from_str(&json).unwrap();
    assert_eq!(encrypted.ciphertext, deserialized.ciphertext);
    assert_eq!(encrypted.nonce, deserialized.nonce);
}
