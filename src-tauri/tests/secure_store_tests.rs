//! 安全存储模块的单元测试

use deep_student_lib::database::Database;
use deep_student_lib::secure_store::{SecureStore, SecureStoreConfig};
use tempfile::TempDir;

async fn create_test_database() -> (Database, TempDir) {
    let temp_dir = TempDir::new().expect("Failed to create temp dir");
    let db_path = temp_dir.path().join("test.db");
    let db = Database::new(&db_path).expect("Failed to create database");
    (db, temp_dir)
}

#[tokio::test]
async fn test_secure_store_basic_operations() {
    let config = SecureStoreConfig::default();
    let secure_store = SecureStore::new(config.clone());

    // 测试可用性检查（同步）
    let is_available = secure_store.is_available();
    println!("Secure store available: {is_available}");

    if is_available {
        // 测试保存和获取
        let test_key = "test.api_key.example";
        let test_value = "secret_api_key_12345";

        let save_result = secure_store.save_secret(test_key, test_value);
        assert!(
            save_result.is_ok(),
            "Failed to save secret: {save_result:?}"
        );

        let retrieved_value = secure_store.get_secret(test_key);
        assert!(
            retrieved_value.is_ok(),
            "Failed to get secret: {retrieved_value:?}"
        );
        assert_eq!(retrieved_value.unwrap(), Some(test_value.to_string()));

        // 测试删除
        let delete_result = secure_store.delete_secret(test_key);
        assert!(
            delete_result.is_ok(),
            "Failed to delete secret: {delete_result:?}"
        );

        let retrieved_after_delete = secure_store.get_secret(test_key);
        assert!(retrieved_after_delete.is_ok());
        assert_eq!(retrieved_after_delete.unwrap(), None);
    }
}

#[tokio::test]
async fn test_sensitive_key_detection() {
    // 测试敏感键检测
    assert!(SecureStore::is_sensitive_key("web_search.api_key.bing"));
    assert!(SecureStore::is_sensitive_key(
        "web_search.api_key.google_cse"
    ));
    assert!(SecureStore::is_sensitive_key("api_configs"));
    assert!(SecureStore::is_sensitive_key(
        "mcp.transport.ssh_private_key"
    ));

    // 测试非敏感键
    assert!(!SecureStore::is_sensitive_key("web_search.engine"));
    assert!(!SecureStore::is_sensitive_key("web_search.timeout_ms"));
    assert!(!SecureStore::is_sensitive_key("general.theme"));
}

#[tokio::test]
async fn test_database_secure_integration() {
    let (db, _temp_dir) = create_test_database().await;

    let test_key = "web_search.api_key.test";
    let test_value = "secret_test_key";

    // 测试保存敏感数据
    let save_result = db.save_secret(test_key, test_value);
    assert!(
        save_result.is_ok(),
        "Failed to save secret: {save_result:?}"
    );

    // 测试获取敏感数据
    let retrieved_value = db.get_secret(test_key);
    assert!(
        retrieved_value.is_ok(),
        "Failed to get secret: {retrieved_value:?}"
    );
    if let Ok(Some(value)) = retrieved_value {
        assert_eq!(value, test_value);
    }

    // 测试删除敏感数据
    let delete_result = db.delete_secret(test_key);
    assert!(
        delete_result.is_ok(),
        "Failed to delete secret: {delete_result:?}"
    );
}

#[tokio::test]
async fn test_fallback_behavior() {
    let (db, _temp_dir) = create_test_database().await;

    // 测试在安全存储不可用时的回退行为
    let test_key = "test.non_sensitive.key";
    let test_value = "test_value";

    // 保存非敏感数据（应该直接进入数据库）
    let save_result = db.save_secret(test_key, test_value);
    assert!(save_result.is_ok());

    // 获取非敏感数据（应该从数据库获取）
    let retrieved_value = db.get_secret(test_key);
    assert!(retrieved_value.is_ok());
    assert_eq!(retrieved_value.unwrap(), Some(test_value.to_string()));
}
