//! Real cloud provider contract tests.
//!
//! Start the local services first:
//! `docker compose -f scripts/dev/docker-compose.sync-test.yml up -d`
//!
//! Then run:
//! `DS_SYNC_TEST_DOCKER=1 cargo test --test sync_provider_contract_tests -- --ignored`

use deep_student_lib::cloud_storage::{
    create_storage, CloudStorage, CloudStorageConfig, CloudSyncManager, S3Config, StorageProvider,
    WebDavConfig,
};
use deep_student_lib::crypto::backup_crypto;
use deep_student_lib::data_governance::migration::MigrationCoordinator;
use deep_student_lib::data_governance::sync::{MergeStrategy, SyncChangeWithData, SyncManager};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tempfile::{NamedTempFile, TempDir};
use uuid::Uuid;

fn docker_contract_enabled() -> bool {
    std::env::var("DS_SYNC_TEST_DOCKER").as_deref() == Ok("1")
}

fn unique_root(provider: &str) -> String {
    format!("deep-student-sync-contract/{provider}/{}", Uuid::new_v4())
}

async fn run_basic_object_contract(storage: Box<dyn CloudStorage>) {
    storage
        .check_connection()
        .await
        .expect("provider connection should work");

    let small_key = "objects/basic/hello.txt";
    let nested_key = "objects/中文 空格/nested.txt";
    let missing_key = "objects/missing/nope.txt";

    assert!(
        storage
            .get(missing_key)
            .await
            .expect("missing get should work")
            .is_none(),
        "missing object should return None"
    );

    storage
        .put(small_key, b"hello cloud sync")
        .await
        .expect("put small object");
    storage
        .put(nested_key, "路径编码".as_bytes())
        .await
        .expect("put nested unicode object");

    assert_eq!(
        storage
            .get(small_key)
            .await
            .expect("get small object")
            .as_deref(),
        Some(b"hello cloud sync".as_slice())
    );
    assert_eq!(
        storage
            .get(nested_key)
            .await
            .expect("get unicode object")
            .as_deref(),
        Some("路径编码".as_bytes())
    );

    let stat = storage
        .stat(small_key)
        .await
        .expect("stat small object")
        .expect("small object should exist");
    assert_eq!(stat.key, small_key);
    assert_eq!(stat.size, b"hello cloud sync".len() as u64);

    let listed = storage.list("objects/").await.expect("list object prefix");
    let listed_keys: Vec<String> = listed.into_iter().map(|info| info.key).collect();
    assert!(
        listed_keys.iter().any(|key| key == small_key),
        "list should include {small_key}; got {listed_keys:?}"
    );
    assert!(
        listed_keys.iter().any(|key| key == nested_key),
        "list should include {nested_key}; got {listed_keys:?}"
    );

    storage
        .delete(small_key)
        .await
        .expect("delete small object");
    assert!(
        storage
            .get(small_key)
            .await
            .expect("get deleted object")
            .is_none(),
        "deleted object should disappear"
    );
}

async fn run_object_semantics_contract(storage: Box<dyn CloudStorage>) {
    storage
        .check_connection()
        .await
        .expect("provider connection should work");

    let base = format!("objects/semantics-{}/", Uuid::new_v4().simple());
    let empty_prefix = format!("{base}empty/");
    assert!(
        storage
            .list(&empty_prefix)
            .await
            .expect("list empty prefix")
            .is_empty(),
        "empty prefix should list no objects"
    );

    let primary_key = format!("{base}prefix/item.txt");
    let nested_key = format!("{base}prefix/deep/nested.bin");
    let sibling_key = format!("{base}prefixish/item.txt");
    let special_key = format!("{base}special/空格 & plus+ percent% hash# question?/quote'.txt");

    assert!(
        storage
            .stat(&primary_key)
            .await
            .expect("stat missing key")
            .is_none(),
        "missing stat should be None"
    );

    storage
        .put(&primary_key, b"first payload")
        .await
        .expect("put primary object");
    storage
        .put(&nested_key, &deterministic_payload(4099))
        .await
        .expect("put nested object");
    storage
        .put(&sibling_key, b"sibling payload")
        .await
        .expect("put sibling object");
    storage
        .put(&special_key, "特殊路径内容".as_bytes())
        .await
        .expect("put special-character object");

    storage
        .put(&primary_key, b"overwritten payload with a different length")
        .await
        .expect("overwrite primary object");
    let stat = storage
        .stat(&primary_key)
        .await
        .expect("stat overwritten key")
        .expect("overwritten key should exist");
    assert_eq!(stat.key, primary_key);
    assert_eq!(
        stat.size,
        b"overwritten payload with a different length".len() as u64
    );
    assert_eq!(
        storage
            .get(&primary_key)
            .await
            .expect("get overwritten key")
            .as_deref(),
        Some(b"overwritten payload with a different length".as_slice())
    );
    assert_eq!(
        storage
            .get(&special_key)
            .await
            .expect("get special-character key")
            .as_deref(),
        Some("特殊路径内容".as_bytes())
    );

    let prefix = format!("{base}prefix/");
    let listed = storage.list(&prefix).await.expect("list isolated prefix");
    let listed_keys: Vec<String> = listed.into_iter().map(|info| info.key).collect();
    assert!(
        listed_keys.iter().any(|key| key == &primary_key),
        "isolated prefix list should include {primary_key}; got {listed_keys:?}"
    );
    assert!(
        listed_keys.iter().any(|key| key == &nested_key),
        "isolated prefix list should include {nested_key}; got {listed_keys:?}"
    );
    assert!(
        !listed_keys.iter().any(|key| key == &sibling_key),
        "prefix listing must not leak sibling prefix {sibling_key}; got {listed_keys:?}"
    );

    storage
        .delete(&primary_key)
        .await
        .expect("delete primary key");
    storage
        .delete(&primary_key)
        .await
        .expect("repeated delete should be idempotent");
    assert!(
        storage
            .stat(&primary_key)
            .await
            .expect("stat deleted primary")
            .is_none(),
        "deleted key stat should be None"
    );
}

async fn run_file_checksum_contract(storage: Box<dyn CloudStorage>) {
    storage
        .check_connection()
        .await
        .expect("provider connection should work");

    let mut source = NamedTempFile::new().expect("create source file");
    let payload = deterministic_payload(2 * 1024 * 1024 + 17);
    std::io::Write::write_all(&mut source, &payload).expect("write source payload");
    let expected_hash = sha256_hex(&payload);

    let remote_key = "files/payload.bin";
    let uploaded_hash = storage
        .put_file(remote_key, source.path(), None)
        .await
        .expect("put file");
    assert_eq!(uploaded_hash, expected_hash);

    let target = NamedTempFile::new().expect("create target file");
    let downloaded_hash = storage
        .get_file(remote_key, target.path(), Some(&expected_hash), None)
        .await
        .expect("get file with checksum");
    assert_eq!(downloaded_hash, expected_hash);
    let downloaded = std::fs::read(target.path()).expect("read downloaded file");
    assert_eq!(downloaded, payload);
}

async fn run_file_checksum_mismatch_preserves_local_target_contract(
    storage: Box<dyn CloudStorage>,
) {
    storage
        .check_connection()
        .await
        .expect("provider connection should work");

    let mut source = NamedTempFile::new().expect("create source file");
    let payload = deterministic_payload(512 * 1024 + 29);
    std::io::Write::write_all(&mut source, &payload).expect("write source payload");
    let expected_hash = sha256_hex(&payload);

    let mut different_payload = payload.clone();
    for byte in &mut different_payload {
        *byte ^= 0x5a;
    }
    let wrong_same_size_hash = sha256_hex(&different_payload);
    assert_eq!(different_payload.len(), payload.len());
    assert_ne!(wrong_same_size_hash, expected_hash);

    let remote_key = "files/checksum-mismatch.bin";
    let uploaded_hash = storage
        .put_file(remote_key, source.path(), None)
        .await
        .expect("put file");
    assert_eq!(uploaded_hash, expected_hash);

    let mut target = NamedTempFile::new().expect("create existing target file");
    let sentinel = b"existing local file should remain untouched";
    std::io::Write::write_all(&mut target, sentinel).expect("write target sentinel");

    let err = storage
        .get_file(remote_key, target.path(), Some(&wrong_same_size_hash), None)
        .await
        .expect_err("checksum mismatch must fail");
    assert!(
        format!("{err:?}").contains("校验"),
        "checksum mismatch should report validation failure, got {err:?}"
    );
    assert_file_bytes(target.path(), sentinel);
}

async fn run_encrypted_backup_payload_contract(storage: Box<dyn CloudStorage>) {
    storage
        .check_connection()
        .await
        .expect("provider connection should work");

    let plaintext = [
        b"PK\x03\x04deep-student backup fixture\n".as_slice(),
        deterministic_payload(32 * 1024 + 37).as_slice(),
    ]
    .concat();
    let password = "provider-contract-password";
    let encrypted =
        backup_crypto::encrypt_backup(&plaintext, password).expect("encrypt backup fixture");
    assert!(backup_crypto::is_encrypted_backup(&encrypted));
    assert!(
        !encrypted
            .windows(plaintext.len().min(256))
            .any(|window| window == &plaintext[..plaintext.len().min(256)]),
        "encrypted backup should not contain a plaintext prefix"
    );

    let mut encrypted_file = NamedTempFile::new().expect("create encrypted backup file");
    std::io::Write::write_all(&mut encrypted_file, &encrypted)
        .expect("write encrypted backup file");

    let manager = CloudSyncManager::new(
        storage,
        format!("device-backup-{}", Uuid::new_v4().simple()),
    );
    let upload = manager
        .upload(
            encrypted_file.path(),
            Some("provider-contract".to_string()),
            Some("encrypted backup contract".to_string()),
        )
        .await
        .expect("upload encrypted backup payload");
    assert_eq!(upload.version.size, encrypted.len() as u64);
    assert_eq!(upload.version.checksum, sha256_hex(&encrypted));

    let versions = manager.list_versions().await.expect("list backup versions");
    assert!(
        versions
            .iter()
            .any(|version| version.id == upload.version.id),
        "uploaded encrypted backup version should be listed"
    );

    let download_dir = TempDir::new().expect("create backup download dir");
    let downloaded = manager
        .download(Some(&upload.version.id), download_dir.path())
        .await
        .expect("download encrypted backup payload");
    let downloaded_bytes = std::fs::read(&downloaded.local_path).expect("read downloaded backup");
    assert_eq!(downloaded_bytes, encrypted);
    assert!(backup_crypto::is_encrypted_backup(&downloaded_bytes));
    assert_eq!(
        backup_crypto::decrypt_backup(&downloaded_bytes, password)
            .expect("decrypt downloaded backup"),
        plaintext
    );
    assert!(
        backup_crypto::decrypt_backup(&downloaded_bytes, "wrong-password").is_err(),
        "wrong backup password must fail"
    );
}

fn deterministic_payload(len: usize) -> Vec<u8> {
    (0..len)
        .map(|index| {
            let mixed = index.wrapping_mul(31).wrapping_add(index / 7);
            (mixed % 251) as u8
        })
        .collect()
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

fn sha256_zeroes_hex(len: u64) -> String {
    let mut hasher = Sha256::new();
    let chunk = [0u8; 1024 * 1024];
    let mut remaining = len;
    while remaining > 0 {
        let take = remaining.min(chunk.len() as u64) as usize;
        hasher.update(&chunk[..take]);
        remaining -= take as u64;
    }
    format!("{:x}", hasher.finalize())
}

fn write_workspace_database(active_dir: &Path, ws_id: &str, marker: &str) -> PathBuf {
    let workspaces_dir = active_dir.join("workspaces");
    std::fs::create_dir_all(&workspaces_dir).expect("create source workspaces dir");
    let path = workspaces_dir.join(format!("{ws_id}.db"));
    {
        let conn = Connection::open(&path).expect("create source workspace database");
        conn.execute_batch(
            "CREATE TABLE contract_marker (id INTEGER PRIMARY KEY, marker TEXT NOT NULL);",
        )
        .expect("create workspace marker table");
        conn.execute(
            "INSERT INTO contract_marker (id, marker) VALUES (1, ?1)",
            params![marker],
        )
        .expect("insert workspace marker row");
    }
    path
}

fn assert_workspace_marker(path: &Path, expected: &str) {
    let conn = Connection::open(path).expect("open downloaded workspace database");
    let actual: String = conn
        .query_row(
            "SELECT marker FROM contract_marker WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .expect("read workspace marker row");
    assert_eq!(actual, expected);
}

fn assert_file_bytes(path: &Path, expected: &[u8]) {
    let actual =
        std::fs::read(path).unwrap_or_else(|e| panic!("read local file {}: {e}", path.display()));
    assert_eq!(actual, expected);
}

async fn assert_remote_file_present(storage: &dyn CloudStorage, key: &str) {
    assert!(
        storage
            .stat(key)
            .await
            .unwrap_or_else(|e| panic!("stat remote file {key}: {e}"))
            .is_some(),
        "remote file should exist: {key}"
    );
}

async fn assert_remote_file_missing(storage: &dyn CloudStorage, key: &str) {
    assert!(
        storage
            .get(key)
            .await
            .unwrap_or_else(|e| panic!("get remote file {key}: {e}"))
            .is_none(),
        "remote file should be absent: {key}"
    );
}

struct MigratedWorkspace {
    _temp_dir: TempDir,
    paths: BTreeMap<&'static str, PathBuf>,
}

impl MigratedWorkspace {
    fn open(&self, database: &str) -> Connection {
        let path = self
            .paths
            .get(database)
            .unwrap_or_else(|| panic!("missing migrated database path for {database}"));
        Connection::open(path)
            .unwrap_or_else(|e| panic!("failed to open migrated {database} database: {e}"))
    }
}

fn migrate_workspace() -> MigratedWorkspace {
    let temp_dir = TempDir::new().expect("create temp app data dir");
    let root = temp_dir.path().to_path_buf();
    let mut coordinator = MigrationCoordinator::new(root.clone()).with_audit_db(None);
    let report = coordinator.run_all().expect("real migrations should run");
    assert!(
        report.success,
        "migration report should be successful: {report:?}"
    );

    let paths = BTreeMap::from([
        ("vfs", root.join("databases").join("vfs.db")),
        ("chat_v2", root.join("chat_v2.db")),
        ("mistakes", root.join("mistakes.db")),
        ("llm_usage", root.join("llm_usage.db")),
    ]);

    for (database, path) in &paths {
        assert!(
            path.exists(),
            "migration should create {database} database at {}",
            path.display()
        );
    }

    MigratedWorkspace {
        _temp_dir: temp_dir,
        paths,
    }
}

fn clear_change_log(conn: &Connection) {
    conn.execute("DELETE FROM __change_log", [])
        .expect("clear migrated change log");
}

fn pending_count(conn: &Connection) -> usize {
    SyncManager::get_pending_changes(conn, None, None)
        .expect("read pending changes")
        .total_count
}

fn insert_vfs_note_bundle(conn: &Connection, suffix: &str) -> (String, String, String, String) {
    let res_id = format!("res_contract_{suffix}");
    let note_id = format!("note_contract_{suffix}");
    let hash = format!("hash_contract_{suffix}");
    let title = format!("Provider contract note {suffix}");
    let created_ms = 1_714_000_000_000i64;
    let created_iso = "2024-04-24T00:00:00Z";

    conn.execute(
        "INSERT INTO resources (
            id, hash, type, storage_mode, data, metadata_json, ref_count, created_at, updated_at
         ) VALUES (?1, ?2, 'note', 'inline', ?3, '{}', 1, ?4, ?4)",
        params![res_id, hash, format!("body for {title}"), created_ms],
    )
    .expect("insert real vfs resource");
    conn.execute(
        "INSERT INTO notes (
            id, resource_id, title, tags, is_favorite, created_at, updated_at
         ) VALUES (?1, ?2, ?3, '[]', 0, ?4, ?4)",
        params![note_id, res_id, title, created_iso],
    )
    .expect("insert real vfs note");

    (res_id, note_id, hash, title)
}

fn enriched_vfs_changes(conn: &Connection) -> (Vec<SyncChangeWithData>, Vec<i64>) {
    let pending = SyncManager::get_pending_changes(conn, None, None).expect("read pending changes");
    assert!(pending.has_changes(), "source should have pending changes");

    let mut changes = SyncManager::enrich_changes_with_data(conn, &pending.entries, None)
        .expect("enrich pending changes");
    for change in &mut changes {
        change.database_name = Some("vfs".to_string());
        change.suppress_change_log = Some(true);
    }

    (changes, pending.get_change_ids())
}

async fn upload_vfs_changes_and_manifest(
    storage: &dyn CloudStorage,
    manager: &SyncManager,
    conn: &Connection,
) -> Vec<i64> {
    let (changes, change_ids) = enriched_vfs_changes(conn);
    manager
        .upload_enriched_changes(storage, &changes, None)
        .await
        .expect("upload enriched changes to provider");

    let marked = SyncManager::mark_synced_with_timestamp(conn, &change_ids)
        .expect("mark source changes synced");
    assert_eq!(marked, change_ids.len());

    let mut states = HashMap::new();
    states.insert(
        "vfs".to_string(),
        SyncManager::get_database_sync_state(conn, "vfs").expect("source sync state"),
    );
    let manifest = manager.create_manifest(states);
    manager
        .upload_manifest(storage, &manifest)
        .await
        .expect("upload provider manifest");

    change_ids
}

fn local_manifest(
    manager: &SyncManager,
    conn: &Connection,
) -> deep_student_lib::data_governance::sync::SyncManifest {
    let mut states = HashMap::new();
    states.insert(
        "vfs".to_string(),
        SyncManager::get_database_sync_state(conn, "vfs").expect("local sync state"),
    );
    manager.create_manifest(states)
}

async fn run_sync_manager_roundtrip_contract(storage: Box<dyn CloudStorage>) {
    storage
        .check_connection()
        .await
        .expect("provider connection should work");

    let source = migrate_workspace();
    let target = migrate_workspace();
    let source_vfs = source.open("vfs");
    let target_vfs = target.open("vfs");
    clear_change_log(&source_vfs);
    clear_change_log(&target_vfs);

    let (_res_id, note_id, hash, title) = insert_vfs_note_bundle(&source_vfs, "roundtrip");
    let source_manager = SyncManager::new(format!("device-src-{}", Uuid::new_v4()));
    let target_manager = SyncManager::new(format!("device-dst-{}", Uuid::new_v4()));

    upload_vfs_changes_and_manifest(storage.as_ref(), &source_manager, &source_vfs).await;
    assert_eq!(
        pending_count(&source_vfs),
        0,
        "source should be marked synced"
    );

    let target_manifest = local_manifest(&target_manager, &target_vfs);
    let (download_result, downloaded_changes) = target_manager
        .execute_download(
            storage.as_ref(),
            &target_manifest,
            MergeStrategy::KeepLatest,
        )
        .await
        .expect("download provider changes");
    assert!(download_result.success);
    assert!(
        downloaded_changes.len() >= 2,
        "expected source resource and note changes, got {}",
        downloaded_changes.len()
    );

    let applied = SyncManager::apply_downloaded_changes(&target_vfs, &downloaded_changes, None)
        .expect("apply downloaded changes");
    assert_eq!(
        applied.failure_count, 0,
        "apply failures: {:?}",
        applied.failures
    );
    assert!(applied.success_count >= 2);

    let actual_title: String = target_vfs
        .query_row(
            "SELECT title FROM notes WHERE id = ?1",
            params![note_id],
            |row| row.get(0),
        )
        .expect("target note should exist");
    let actual_hash: String = target_vfs
        .query_row(
            "SELECT hash FROM resources WHERE hash = ?1",
            params![hash],
            |row| row.get(0),
        )
        .expect("target resource should exist");
    assert_eq!(actual_title, title);
    assert_eq!(actual_hash, hash);
    assert_eq!(pending_count(&target_vfs), 0, "replay must not create echo");
}

fn assert_bytes_do_not_contain(haystack: &[u8], needle: &str) {
    let needle_bytes = needle.as_bytes();
    assert!(
        !haystack
            .windows(needle_bytes.len())
            .any(|window| window == needle_bytes),
        "encrypted payload must not contain plaintext marker: {needle}"
    );
}

async fn run_encrypted_data_governance_payload_contract(storage: Box<dyn CloudStorage>) {
    storage
        .check_connection()
        .await
        .expect("provider connection should work");

    let source = migrate_workspace();
    let target = migrate_workspace();
    let source_vfs = source.open("vfs");
    let target_vfs = target.open("vfs");
    clear_change_log(&source_vfs);
    clear_change_log(&target_vfs);

    let (_res_id, note_id, hash, title) = insert_vfs_note_bundle(&source_vfs, "encrypted");
    let password = "data-governance-provider-contract-password";
    let source_device_id = format!("device-src-{}", Uuid::new_v4());
    let target_device_id = format!("device-dst-{}", Uuid::new_v4());
    let wrong_password_device_id = format!("device-wrong-{}", Uuid::new_v4());
    let plaintext_device_id = format!("device-plain-{}", Uuid::new_v4());

    let source_manager =
        SyncManager::with_encryption(source_device_id.clone(), Some(password.to_string()));
    let target_manager = SyncManager::with_encryption(target_device_id, Some(password.to_string()));

    upload_vfs_changes_and_manifest(storage.as_ref(), &source_manager, &source_vfs).await;

    let manifest_key = format!("data_governance/manifests/{source_device_id}.json");
    let manifest_bytes = storage
        .get(&manifest_key)
        .await
        .expect("download encrypted data governance manifest")
        .expect("encrypted manifest should exist");
    assert!(
        backup_crypto::is_encrypted_backup(&manifest_bytes),
        "data governance manifest should be encrypted"
    );
    for marker in [&source_device_id, &title, &hash] {
        assert_bytes_do_not_contain(&manifest_bytes, marker);
    }

    let change_files = storage
        .list(&format!("data_governance/changes/{source_device_id}/"))
        .await
        .expect("list encrypted data governance changes");
    assert_eq!(
        change_files.len(),
        1,
        "one encrypted enriched change file should be uploaded"
    );
    let change_key = change_files[0].key.clone();
    let change_bytes = storage
        .get(&change_key)
        .await
        .expect("download encrypted data governance changes")
        .expect("encrypted change file should exist");
    assert!(
        backup_crypto::is_encrypted_backup(&change_bytes),
        "data governance change file should be encrypted"
    );
    for marker in [&source_device_id, &title, &hash] {
        assert_bytes_do_not_contain(&change_bytes, marker);
    }

    let target_manifest = local_manifest(&target_manager, &target_vfs);
    let (download_result, downloaded_changes) = target_manager
        .execute_download(
            storage.as_ref(),
            &target_manifest,
            MergeStrategy::KeepLatest,
        )
        .await
        .expect("download encrypted provider changes");
    assert!(
        download_result.success,
        "encrypted download should succeed: {download_result:?}"
    );
    assert!(
        downloaded_changes.len() >= 2,
        "expected encrypted resource and note changes"
    );
    let applied = SyncManager::apply_downloaded_changes(&target_vfs, &downloaded_changes, None)
        .expect("apply encrypted downloaded changes");
    assert_eq!(
        applied.failure_count, 0,
        "encrypted apply failures: {:?}",
        applied.failures
    );
    let actual_title: String = target_vfs
        .query_row(
            "SELECT title FROM notes WHERE id = ?1",
            params![note_id],
            |row| row.get(0),
        )
        .expect("target encrypted note should exist");
    assert_eq!(actual_title, title);
    assert_eq!(
        pending_count(&target_vfs),
        0,
        "encrypted replay must not create echo"
    );

    let wrong_password_manager = SyncManager::with_encryption(
        wrong_password_device_id,
        Some("wrong-data-governance-password".to_string()),
    );
    let wrong_password_download = wrong_password_manager
        .download_changes(storage.as_ref(), 0, None)
        .await
        .expect("wrong password should report decode failures without failing the batch");
    assert!(
        wrong_password_download.changes.is_empty(),
        "wrong password must not return decrypted changes"
    );
    assert_eq!(
        wrong_password_download.decode_failures,
        vec![change_key.clone()],
        "wrong password should identify the encrypted change file"
    );

    let plaintext_manager = SyncManager::new(plaintext_device_id);
    let plaintext_download = plaintext_manager
        .download_changes(storage.as_ref(), 0, None)
        .await
        .expect("missing password should report decode failures without failing the batch");
    assert!(
        plaintext_download.changes.is_empty(),
        "missing password must not return encrypted changes as plaintext"
    );
    assert_eq!(
        plaintext_download.decode_failures,
        vec![change_key],
        "missing password should identify the encrypted change file"
    );
}

async fn run_mixed_plaintext_and_encrypted_change_contract(storage: Box<dyn CloudStorage>) {
    storage
        .check_connection()
        .await
        .expect("provider connection should work");

    let plaintext_source = migrate_workspace();
    let encrypted_source = migrate_workspace();
    let target = migrate_workspace();
    let plaintext_vfs = plaintext_source.open("vfs");
    let encrypted_vfs = encrypted_source.open("vfs");
    let target_vfs = target.open("vfs");
    clear_change_log(&plaintext_vfs);
    clear_change_log(&encrypted_vfs);
    clear_change_log(&target_vfs);

    let (plain_res_id, plain_note_id, _plain_hash, plain_title) =
        insert_vfs_note_bundle(&plaintext_vfs, "mixed_plaintext");
    let (_encrypted_res_id, encrypted_note_id, encrypted_hash, encrypted_title) =
        insert_vfs_note_bundle(&encrypted_vfs, "mixed_encrypted");

    let password = "mixed-data-governance-password";
    let plaintext_device_id = format!("device-plain-{}", Uuid::new_v4());
    let encrypted_device_id = format!("device-encrypted-{}", Uuid::new_v4());
    let target_device_id = format!("device-target-{}", Uuid::new_v4());
    let unauthenticated_device_id = format!("device-no-password-{}", Uuid::new_v4());

    let plaintext_manager = SyncManager::new(plaintext_device_id.clone());
    let encrypted_manager =
        SyncManager::with_encryption(encrypted_device_id.clone(), Some(password.to_string()));
    let target_manager = SyncManager::with_encryption(target_device_id, Some(password.to_string()));

    let (plain_changes, _plain_change_ids) = enriched_vfs_changes(&plaintext_vfs);
    plaintext_manager
        .upload_enriched_changes(storage.as_ref(), &plain_changes, None)
        .await
        .expect("upload plaintext compatibility changes");

    let (encrypted_changes, _encrypted_change_ids) = enriched_vfs_changes(&encrypted_vfs);
    encrypted_manager
        .upload_enriched_changes(storage.as_ref(), &encrypted_changes, None)
        .await
        .expect("upload encrypted compatibility changes");

    let plain_files = storage
        .list(&format!("data_governance/changes/{plaintext_device_id}/"))
        .await
        .expect("list plaintext compatibility changes");
    assert_eq!(plain_files.len(), 1);
    let plain_bytes = storage
        .get(&plain_files[0].key)
        .await
        .expect("download plaintext compatibility change")
        .expect("plaintext compatibility change should exist");
    assert!(
        !backup_crypto::is_encrypted_backup(&plain_bytes),
        "legacy plaintext data-governance change should remain plaintext"
    );

    let encrypted_files = storage
        .list(&format!("data_governance/changes/{encrypted_device_id}/"))
        .await
        .expect("list encrypted compatibility changes");
    assert_eq!(encrypted_files.len(), 1);
    let encrypted_key = encrypted_files[0].key.clone();
    let encrypted_bytes = storage
        .get(&encrypted_key)
        .await
        .expect("download encrypted compatibility change")
        .expect("encrypted compatibility change should exist");
    assert!(
        backup_crypto::is_encrypted_backup(&encrypted_bytes),
        "new data-governance change should be encrypted"
    );
    for marker in [&encrypted_device_id, &encrypted_hash, &encrypted_title] {
        assert_bytes_do_not_contain(&encrypted_bytes, marker);
    }

    let authenticated_download = target_manager
        .download_changes(storage.as_ref(), 0, None)
        .await
        .expect("download mixed plaintext and encrypted changes with password");
    assert!(
        authenticated_download.decode_failures.is_empty(),
        "password-equipped clients should decode both plaintext and encrypted changes"
    );
    assert_eq!(
        authenticated_download.changes.len(),
        plain_changes.len() + encrypted_changes.len(),
        "authenticated target should receive every mixed-format change"
    );
    let applied =
        SyncManager::apply_downloaded_changes(&target_vfs, &authenticated_download.changes, None)
            .expect("apply mixed-format provider changes");
    assert_eq!(
        applied.failure_count, 0,
        "mixed-format apply failures: {:?}",
        applied.failures
    );
    for (note_id, expected_title) in [
        (plain_note_id.as_str(), plain_title.as_str()),
        (encrypted_note_id.as_str(), encrypted_title.as_str()),
    ] {
        let actual_title: String = target_vfs
            .query_row(
                "SELECT title FROM notes WHERE id = ?1",
                params![note_id],
                |row| row.get(0),
            )
            .unwrap_or_else(|e| panic!("target note {note_id} should exist: {e}"));
        assert_eq!(actual_title, expected_title);
    }
    assert_eq!(
        pending_count(&target_vfs),
        0,
        "mixed-format replay must not create echo changes"
    );

    let unauthenticated_manager = SyncManager::new(unauthenticated_device_id);
    let unauthenticated_download = unauthenticated_manager
        .download_changes(storage.as_ref(), 0, None)
        .await
        .expect("download mixed changes without password");
    assert_eq!(
        unauthenticated_download.decode_failures,
        vec![encrypted_key],
        "clients without the new password should report only encrypted change files"
    );
    assert_eq!(
        unauthenticated_download.changes.len(),
        plain_changes.len(),
        "clients without a password should still read legacy plaintext changes"
    );
    assert!(
        unauthenticated_download
            .changes
            .iter()
            .all(|change| change.record_id == plain_note_id || change.record_id == plain_res_id),
        "unauthenticated download must not expose encrypted records"
    );
}

async fn run_duplicate_enriched_change_files_are_idempotent_contract(
    storage: Box<dyn CloudStorage>,
) {
    storage
        .check_connection()
        .await
        .expect("provider connection should work");

    let source = migrate_workspace();
    let target = migrate_workspace();
    let source_vfs = source.open("vfs");
    let target_vfs = target.open("vfs");
    clear_change_log(&source_vfs);
    clear_change_log(&target_vfs);

    let (res_id, note_id, hash, title) = insert_vfs_note_bundle(&source_vfs, "duplicate_retry");
    let source_device_id = format!("device-retry-{}", Uuid::new_v4());
    let source_manager = SyncManager::new(source_device_id.clone());
    let target_manager = SyncManager::new(format!("device-target-{}", Uuid::new_v4()));
    let (changes, _change_ids) = enriched_vfs_changes(&source_vfs);

    source_manager
        .upload_enriched_changes(storage.as_ref(), &changes, None)
        .await
        .expect("upload first retry copy");
    source_manager
        .upload_enriched_changes(storage.as_ref(), &changes, None)
        .await
        .expect("upload second retry copy");

    let retry_files = storage
        .list(&format!("data_governance/changes/{source_device_id}/"))
        .await
        .expect("list duplicate retry change files");
    assert_eq!(
        retry_files.len(),
        2,
        "retry uploads should be visible as two immutable change files"
    );

    let downloaded = target_manager
        .download_changes(storage.as_ref(), 0, None)
        .await
        .expect("download duplicate retry changes");
    assert!(
        downloaded.decode_failures.is_empty(),
        "duplicate retry files should decode cleanly"
    );
    assert_eq!(
        downloaded.changes.len(),
        changes.len() * retry_files.len(),
        "target should see both retry files before idempotent apply"
    );

    let applied = SyncManager::apply_downloaded_changes(&target_vfs, &downloaded.changes, None)
        .expect("apply duplicate retry changes");
    assert_eq!(
        applied.failure_count, 0,
        "duplicate retry apply failures: {:?}",
        applied.failures
    );
    let resource_count: i64 = target_vfs
        .query_row(
            "SELECT COUNT(*) FROM resources WHERE id = ?1 AND hash = ?2",
            params![res_id, hash],
            |row| row.get(0),
        )
        .expect("count retried resource rows");
    assert_eq!(resource_count, 1);
    let note_count: i64 = target_vfs
        .query_row(
            "SELECT COUNT(*) FROM notes WHERE id = ?1 AND title = ?2",
            params![note_id, title],
            |row| row.get(0),
        )
        .expect("count retried note rows");
    assert_eq!(note_count, 1);
    assert_eq!(
        pending_count(&target_vfs),
        0,
        "duplicate retry replay must not create echo changes"
    );
}

async fn run_corrupt_change_file_contract(storage: Box<dyn CloudStorage>) {
    storage
        .check_connection()
        .await
        .expect("provider connection should work");

    let source = migrate_workspace();
    let source_vfs = source.open("vfs");
    clear_change_log(&source_vfs);
    let (_res_id, _note_id, _hash, _title) = insert_vfs_note_bundle(&source_vfs, "corrupt");

    let source_manager = SyncManager::new(format!("device-src-{}", Uuid::new_v4()));
    let target_manager = SyncManager::new(format!("device-dst-{}", Uuid::new_v4()));
    let (changes, _change_ids) = enriched_vfs_changes(&source_vfs);
    source_manager
        .upload_enriched_changes(storage.as_ref(), &changes, None)
        .await
        .expect("upload valid changes");

    let ts = chrono::Utc::now().timestamp() as u64;
    let corrupt_key = format!(
        "data_governance/changes/device-corrupt/{}-{}.json.zst",
        ts,
        Uuid::new_v4()
    );
    storage
        .put(&corrupt_key, b"not zstd and not sync json")
        .await
        .expect("upload corrupt change file");

    let downloaded = target_manager
        .download_changes(storage.as_ref(), 0, None)
        .await
        .expect("download changes with corrupt neighbor");
    assert!(
        downloaded.changes.len() >= changes.len(),
        "valid changes should survive corrupt neighbor"
    );
    assert_eq!(
        downloaded.decode_failures.len(),
        1,
        "corrupt file should be reported, not silently ignored"
    );
    assert_eq!(downloaded.decode_failures[0], corrupt_key);
}

async fn run_corrupt_manifest_contract(storage: Box<dyn CloudStorage>) {
    storage
        .check_connection()
        .await
        .expect("provider connection should work");

    let source = migrate_workspace();
    let source_vfs = source.open("vfs");
    clear_change_log(&source_vfs);
    insert_vfs_note_bundle(&source_vfs, "manifest");

    let source_manager = SyncManager::new(format!("device-src-{}", Uuid::new_v4()));
    let target_manager = SyncManager::new(format!("device-dst-{}", Uuid::new_v4()));
    upload_vfs_changes_and_manifest(storage.as_ref(), &source_manager, &source_vfs).await;

    storage
        .put(
            "data_governance/manifests/device-corrupt.json",
            b"{not valid manifest json",
        )
        .await
        .expect("upload corrupt manifest");

    let manifest = target_manager
        .download_manifest(storage.as_ref())
        .await
        .expect("download manifest with corrupt neighbor");
    assert!(
        manifest.databases.contains_key("vfs"),
        "valid manifest should survive corrupt neighbor"
    );
}

async fn run_prune_old_changes_contract(storage: Box<dyn CloudStorage>) {
    storage
        .check_connection()
        .await
        .expect("provider connection should work");

    let manager = SyncManager::new("device-prune".to_string());
    let now = chrono::Utc::now().timestamp() as u64;
    let old = now - 5 * 86400;
    let recent = now;
    let old_own = format!(
        "data_governance/changes/device-prune/{}-{}.json.zst",
        old,
        Uuid::new_v4()
    );
    let old_other = format!(
        "data_governance/changes/device-retired/{}-{}.json.zst",
        old,
        Uuid::new_v4()
    );
    let recent_own = format!(
        "data_governance/changes/device-prune/{}-{}.json.zst",
        recent,
        Uuid::new_v4()
    );

    for key in [&old_own, &old_other, &recent_own] {
        storage
            .put(key, b"placeholder")
            .await
            .expect("seed change file");
    }

    let deleted = manager
        .prune_old_changes(storage.as_ref(), 1)
        .await
        .expect("prune old provider changes");
    assert_eq!(deleted, 2);
    assert!(storage.get(&old_own).await.expect("read old own").is_none());
    assert!(storage
        .get(&old_other)
        .await
        .expect("read old other")
        .is_none());
    assert!(storage
        .get(&recent_own)
        .await
        .expect("read recent own")
        .is_some());
}

async fn run_workspace_database_file_sync_contract(storage: Box<dyn CloudStorage>) {
    storage
        .check_connection()
        .await
        .expect("provider connection should work");

    let source_active = TempDir::new().expect("create source active dir");
    let target_active = TempDir::new().expect("create target active dir");
    let ws_id = format!("ws_{}", Uuid::new_v4().simple());
    let marker = format!("workspace-marker-{ws_id}");
    let source_db = write_workspace_database(source_active.path(), &ws_id, &marker);
    let remote_key = format!("data_governance/workspaces/{ws_id}.db");
    let target_db = target_active
        .path()
        .join("workspaces")
        .join(format!("{ws_id}.db"));

    let source_manager = SyncManager::new(format!("device-ws-src-{}", Uuid::new_v4()));
    let target_manager = SyncManager::new(format!("device-ws-dst-{}", Uuid::new_v4()));

    source_manager
        .sync_workspace_databases(storage.as_ref(), source_active.path())
        .await
        .expect("upload source workspace database");
    assert_remote_file_present(storage.as_ref(), &remote_key).await;

    target_manager
        .sync_workspace_databases(storage.as_ref(), target_active.path())
        .await
        .expect("download workspace database to target directory");
    assert!(
        target_db.exists(),
        "target workspace database should be downloaded to {}",
        target_db.display()
    );
    assert_workspace_marker(&source_db, &marker);
    assert_workspace_marker(&target_db, &marker);
}

async fn run_workspace_remote_same_size_corruption_rejected_contract(
    storage: Box<dyn CloudStorage>,
) {
    storage
        .check_connection()
        .await
        .expect("provider connection should work");

    let source_active = TempDir::new().expect("create source active dir");
    let target_active = TempDir::new().expect("create target active dir");
    let ws_id = format!("ws_{}", Uuid::new_v4().simple());
    let source_db = write_workspace_database(source_active.path(), &ws_id, "workspace-good");
    let source_bytes = std::fs::read(&source_db).expect("read source workspace database");
    let mut corrupted = source_bytes.clone();
    let flip_index = corrupted.len() / 2;
    corrupted[flip_index] ^= 0x55;
    assert_eq!(corrupted.len(), source_bytes.len());
    assert_ne!(sha256_hex(&corrupted), sha256_hex(&source_bytes));

    let source_manager = SyncManager::new(format!("device-ws-src-{}", Uuid::new_v4()));
    let target_manager = SyncManager::new(format!("device-ws-dst-{}", Uuid::new_v4()));
    source_manager
        .sync_workspace_databases(storage.as_ref(), source_active.path())
        .await
        .expect("upload source workspace database");

    let remote_key = format!("data_governance/workspaces/{ws_id}.db");
    storage
        .put(&remote_key, &corrupted)
        .await
        .expect("overwrite remote workspace database with same-size corrupted bytes");

    target_manager
        .sync_workspace_databases(storage.as_ref(), target_active.path())
        .await
        .expect("workspace sync should skip corrupted download without failing whole pass");
    let target_db = target_active
        .path()
        .join("workspaces")
        .join(format!("{ws_id}.db"));
    assert!(
        !target_db.exists(),
        "workspace checksum failure must not leave a corrupted local database at {}",
        target_db.display()
    );
}

async fn run_vfs_blob_file_sync_and_tombstone_contract(storage: Box<dyn CloudStorage>) {
    storage
        .check_connection()
        .await
        .expect("provider connection should work");

    let source_blobs = TempDir::new().expect("create source blobs dir");
    let target_blobs = TempDir::new().expect("create target blobs dir");
    let payload = deterministic_payload(16 * 1024 + 31);
    let blob_hash = sha256_hex(&payload);
    let bucket = &blob_hash[..2];
    let relative_path = format!("{bucket}/{blob_hash}.bin");
    let source_blob = source_blobs.path().join(&relative_path);
    let target_blob = target_blobs.path().join(&relative_path);
    let remote_key = format!("data_governance/blobs/{relative_path}");

    std::fs::create_dir_all(source_blob.parent().expect("blob parent"))
        .expect("create source blob bucket");
    std::fs::write(&source_blob, &payload).expect("write source blob");

    let source_manager = SyncManager::new(format!("device-blob-src-{}", Uuid::new_v4()));
    let target_manager = SyncManager::new(format!("device-blob-dst-{}", Uuid::new_v4()));

    let upload = source_manager
        .sync_vfs_blobs(storage.as_ref(), source_blobs.path())
        .await
        .expect("upload source blob");
    assert_eq!(upload.uploaded, 1);
    assert!(!upload.has_failures(), "blob upload failures: {upload:?}");
    assert_remote_file_present(storage.as_ref(), &remote_key).await;

    let download = target_manager
        .sync_vfs_blobs(storage.as_ref(), target_blobs.path())
        .await
        .expect("download blob to target directory");
    assert_eq!(download.downloaded, 1);
    assert!(
        !download.has_failures(),
        "blob download failures: {download:?}"
    );
    assert_file_bytes(&target_blob, &payload);

    std::fs::remove_file(&source_blob).expect("delete source blob before tombstone");
    source_manager
        .mark_blob_deleted(
            storage.as_ref(),
            &blob_hash,
            Some(relative_path.clone()),
            Some(payload.len() as u64),
        )
        .await
        .expect("upload blob tombstone");

    let tombstone_sync = target_manager
        .sync_vfs_blobs_with_tombstones(storage.as_ref(), target_blobs.path())
        .await
        .expect("apply blob tombstone on target");
    assert!(
        !tombstone_sync.has_failures(),
        "blob tombstone sync failures: {tombstone_sync:?}"
    );
    assert!(
        !target_blob.exists(),
        "target blob should be deleted after tombstone propagation"
    );
    assert_remote_file_missing(storage.as_ref(), &remote_key).await;
}

async fn run_vfs_blob_remote_same_size_corruption_rejected_contract(
    storage: Box<dyn CloudStorage>,
) {
    storage
        .check_connection()
        .await
        .expect("provider connection should work");

    let source_blobs = TempDir::new().expect("create source blobs dir");
    let target_blobs = TempDir::new().expect("create target blobs dir");
    let payload = deterministic_payload(24 * 1024 + 17);
    let blob_hash = sha256_hex(&payload);
    let bucket = &blob_hash[..2];
    let relative_path = format!("{bucket}/{blob_hash}.bin");
    let source_blob = source_blobs.path().join(&relative_path);
    let target_blob = target_blobs.path().join(&relative_path);
    let remote_key = format!("data_governance/blobs/{relative_path}");

    std::fs::create_dir_all(source_blob.parent().expect("blob parent"))
        .expect("create source blob bucket");
    std::fs::write(&source_blob, &payload).expect("write source blob");

    let source_manager = SyncManager::new(format!("device-blob-src-{}", Uuid::new_v4()));
    let target_manager = SyncManager::new(format!("device-blob-dst-{}", Uuid::new_v4()));

    let upload = source_manager
        .sync_vfs_blobs(storage.as_ref(), source_blobs.path())
        .await
        .expect("upload source blob");
    assert_eq!(upload.uploaded, 1);
    assert!(!upload.has_failures(), "blob upload failures: {upload:?}");

    let mut corrupted = payload.clone();
    for byte in &mut corrupted {
        *byte ^= 0x7d;
    }
    assert_eq!(corrupted.len(), payload.len());
    assert_ne!(sha256_hex(&corrupted), blob_hash);
    storage
        .put(&remote_key, &corrupted)
        .await
        .expect("overwrite remote blob with same-size corrupted payload");

    let download = target_manager
        .sync_vfs_blobs(storage.as_ref(), target_blobs.path())
        .await
        .expect("sync should report per-file blob failure instead of failing whole pass");
    assert_eq!(download.downloaded, 0);
    assert!(
        download.download_failures.contains(&blob_hash),
        "corrupted blob must be reported as failed: {download:?}"
    );
    assert!(
        !target_blob.exists(),
        "checksum failure must not leave a corrupted local blob at {}",
        target_blob.display()
    );
}

async fn run_asset_directories_file_sync_and_tombstone_contract(storage: Box<dyn CloudStorage>) {
    storage
        .check_connection()
        .await
        .expect("provider connection should work");

    let source_active = TempDir::new().expect("create source active dir");
    let source_app_data = TempDir::new().expect("create source app data dir");
    let target_active = TempDir::new().expect("create target active dir");
    let target_app_data = TempDir::new().expect("create target app data dir");

    let active_asset_rel = Path::new("images").join("contract").join("diagram.bin");
    let active_asset_key = "active/images/contract/diagram.bin";
    let active_remote_key = format!("data_governance/assets/{active_asset_key}");
    let active_payload = deterministic_payload(12 * 1024 + 19);
    let source_active_asset = source_active.path().join(&active_asset_rel);
    let target_active_asset = target_active.path().join(&active_asset_rel);
    std::fs::create_dir_all(source_active_asset.parent().expect("active asset parent"))
        .expect("create source active asset dir");
    std::fs::write(&source_active_asset, &active_payload).expect("write source active asset");

    let app_asset_rel = Path::new("pdf_ocr_sessions")
        .join("contract")
        .join("page.json");
    let app_asset_key = "app_data/pdf_ocr_sessions/contract/page.json";
    let app_remote_key = format!("data_governance/assets/{app_asset_key}");
    let app_payload = br#"{"page":1,"text":"provider contract"}"#;
    let source_app_asset = source_app_data.path().join(&app_asset_rel);
    let target_app_asset = target_app_data.path().join(&app_asset_rel);
    std::fs::create_dir_all(source_app_asset.parent().expect("app asset parent"))
        .expect("create source app asset dir");
    std::fs::write(&source_app_asset, app_payload).expect("write source app asset");

    let source_manager = SyncManager::new(format!("device-asset-src-{}", Uuid::new_v4()));
    let target_manager = SyncManager::new(format!("device-asset-dst-{}", Uuid::new_v4()));

    let upload = source_manager
        .sync_asset_directories(
            storage.as_ref(),
            source_active.path(),
            source_app_data.path(),
        )
        .await
        .expect("upload source asset directories");
    assert_eq!(upload.uploaded, 2);
    assert!(!upload.has_failures(), "asset upload failures: {upload:?}");
    assert_remote_file_present(storage.as_ref(), &active_remote_key).await;
    assert_remote_file_present(storage.as_ref(), &app_remote_key).await;

    let download = target_manager
        .sync_asset_directories(
            storage.as_ref(),
            target_active.path(),
            target_app_data.path(),
        )
        .await
        .expect("download assets to target directories");
    assert_eq!(download.downloaded, 2);
    assert!(
        !download.has_failures(),
        "asset download failures: {download:?}"
    );
    assert_file_bytes(&target_active_asset, &active_payload);
    assert_file_bytes(&target_app_asset, app_payload);

    std::fs::remove_file(&source_active_asset)
        .expect("delete source active asset before tombstone");
    source_manager
        .mark_asset_deleted(
            storage.as_ref(),
            active_asset_key,
            Some(active_payload.len() as u64),
        )
        .await
        .expect("upload asset tombstone");

    let tombstone_sync = target_manager
        .sync_asset_directories_with_tombstones(
            storage.as_ref(),
            target_active.path(),
            target_app_data.path(),
        )
        .await
        .expect("apply asset tombstone on target");
    assert!(
        !tombstone_sync.has_failures(),
        "asset tombstone sync failures: {tombstone_sync:?}"
    );
    assert!(
        !target_active_asset.exists(),
        "target active asset should be deleted after tombstone propagation"
    );
    assert_remote_file_missing(storage.as_ref(), &active_remote_key).await;
    assert_file_bytes(&target_app_asset, app_payload);
}

async fn run_asset_remote_same_size_corruption_rejected_contract(storage: Box<dyn CloudStorage>) {
    storage
        .check_connection()
        .await
        .expect("provider connection should work");

    let source_active = TempDir::new().expect("create source active dir");
    let source_app_data = TempDir::new().expect("create source app data dir");
    let target_active = TempDir::new().expect("create target active dir");
    let target_app_data = TempDir::new().expect("create target app data dir");

    let asset_rel = Path::new("documents").join("contract").join("corrupt.bin");
    let asset_key = "active/documents/contract/corrupt.bin";
    let remote_key = format!("data_governance/assets/{asset_key}");
    let payload = deterministic_payload(20 * 1024 + 11);
    let source_asset = source_active.path().join(&asset_rel);
    let target_asset = target_active.path().join(&asset_rel);
    std::fs::create_dir_all(source_asset.parent().expect("source asset parent"))
        .expect("create source asset parent");
    std::fs::write(&source_asset, &payload).expect("write source asset");

    let source_manager = SyncManager::new(format!("device-asset-src-{}", Uuid::new_v4()));
    let target_manager = SyncManager::new(format!("device-asset-dst-{}", Uuid::new_v4()));
    let upload = source_manager
        .sync_asset_directories(
            storage.as_ref(),
            source_active.path(),
            source_app_data.path(),
        )
        .await
        .expect("upload source asset");
    assert_eq!(upload.uploaded, 1);
    assert!(!upload.has_failures(), "asset upload failures: {upload:?}");

    let mut corrupted = payload.clone();
    for byte in &mut corrupted {
        *byte ^= 0x33;
    }
    assert_eq!(corrupted.len(), payload.len());
    assert_ne!(sha256_hex(&corrupted), sha256_hex(&payload));
    storage
        .put(&remote_key, &corrupted)
        .await
        .expect("overwrite remote asset with same-size corrupted payload");

    let download = target_manager
        .sync_asset_directories(
            storage.as_ref(),
            target_active.path(),
            target_app_data.path(),
        )
        .await
        .expect("asset sync should report per-file failure");
    assert_eq!(download.downloaded, 0);
    assert!(
        download.download_failures.contains(&asset_key.to_string()),
        "corrupted asset must be reported as failed: {download:?}"
    );
    assert!(
        !target_asset.exists(),
        "checksum failure must not leave a corrupted local asset at {}",
        target_asset.display()
    );
}

async fn webdav_storage() -> Box<dyn CloudStorage> {
    create_storage(&CloudStorageConfig {
        provider: StorageProvider::WebDav,
        webdav: Some(WebDavConfig {
            endpoint: std::env::var("DS_SYNC_WEBDAV_ENDPOINT")
                .unwrap_or_else(|_| "http://127.0.0.1:8080/".to_string()),
            username: std::env::var("DS_SYNC_WEBDAV_USERNAME")
                .unwrap_or_else(|_| "webdav".to_string()),
            password: std::env::var("DS_SYNC_WEBDAV_PASSWORD")
                .unwrap_or_else(|_| "webdav123".to_string()),
        }),
        root: Some(unique_root("webdav")),
        ..Default::default()
    })
    .await
    .expect("create WebDAV storage")
}

async fn webdav_storage_with_password(password: &str) -> Box<dyn CloudStorage> {
    create_storage(&CloudStorageConfig {
        provider: StorageProvider::WebDav,
        webdav: Some(WebDavConfig {
            endpoint: std::env::var("DS_SYNC_WEBDAV_ENDPOINT")
                .unwrap_or_else(|_| "http://127.0.0.1:8080/".to_string()),
            username: std::env::var("DS_SYNC_WEBDAV_USERNAME")
                .unwrap_or_else(|_| "webdav".to_string()),
            password: password.to_string(),
        }),
        root: Some(unique_root("webdav-bad-auth")),
        ..Default::default()
    })
    .await
    .expect("create WebDAV storage")
}

#[cfg(feature = "cloud_storage_s3")]
async fn s3_storage() -> Box<dyn CloudStorage> {
    create_storage(&CloudStorageConfig {
        provider: StorageProvider::S3,
        s3: Some(S3Config {
            endpoint: std::env::var("DS_SYNC_S3_ENDPOINT")
                .unwrap_or_else(|_| "http://127.0.0.1:9000".to_string()),
            bucket: std::env::var("DS_SYNC_S3_BUCKET")
                .unwrap_or_else(|_| "deep-student".to_string()),
            access_key_id: std::env::var("DS_SYNC_S3_ACCESS_KEY")
                .unwrap_or_else(|_| "minioadmin".to_string()),
            secret_access_key: std::env::var("DS_SYNC_S3_SECRET_KEY")
                .unwrap_or_else(|_| "minioadmin123".to_string()),
            region: Some(
                std::env::var("DS_SYNC_S3_REGION").unwrap_or_else(|_| "us-east-1".to_string()),
            ),
            path_style: true,
        }),
        root: Some(unique_root("s3")),
        ..Default::default()
    })
    .await
    .expect("create S3 storage")
}

#[cfg(feature = "cloud_storage_s3")]
async fn s3_storage_with_secret(secret: &str) -> Box<dyn CloudStorage> {
    create_storage(&CloudStorageConfig {
        provider: StorageProvider::S3,
        s3: Some(S3Config {
            endpoint: std::env::var("DS_SYNC_S3_ENDPOINT")
                .unwrap_or_else(|_| "http://127.0.0.1:9000".to_string()),
            bucket: std::env::var("DS_SYNC_S3_BUCKET")
                .unwrap_or_else(|_| "deep-student".to_string()),
            access_key_id: std::env::var("DS_SYNC_S3_ACCESS_KEY")
                .unwrap_or_else(|_| "minioadmin".to_string()),
            secret_access_key: secret.to_string(),
            region: Some(
                std::env::var("DS_SYNC_S3_REGION").unwrap_or_else(|_| "us-east-1".to_string()),
            ),
            path_style: true,
        }),
        root: Some(unique_root("s3-bad-auth")),
        ..Default::default()
    })
    .await
    .expect("create S3 storage")
}

#[cfg(feature = "cloud_storage_s3")]
async fn run_s3_list_pagination_contract(storage: Box<dyn CloudStorage>) {
    storage
        .check_connection()
        .await
        .expect("provider connection should work");

    let object_count = 1_105usize;
    for index in 0..object_count {
        let key = format!("pagination/page/object-{index:04}.txt");
        storage
            .put(&key, format!("payload-{index}").as_bytes())
            .await
            .expect("put pagination object");
    }

    let listed = storage
        .list("pagination/page/")
        .await
        .expect("list paginated prefix");
    assert_eq!(
        listed.len(),
        object_count,
        "S3 list must follow continuation tokens past 1000 objects"
    );
}

#[cfg(feature = "cloud_storage_s3")]
async fn run_s3_multipart_file_contract(storage: Box<dyn CloudStorage>) {
    storage
        .check_connection()
        .await
        .expect("provider connection should work");

    let file_size = 101 * 1024 * 1024u64;
    let source = NamedTempFile::new().expect("create sparse multipart source file");
    source
        .as_file()
        .set_len(file_size)
        .expect("size sparse multipart source file");
    let expected_hash = sha256_zeroes_hex(file_size);
    let progress_events: Arc<Mutex<Vec<(u64, u64)>>> = Arc::new(Mutex::new(Vec::new()));
    let upload_events = Arc::clone(&progress_events);

    let uploaded_hash = storage
        .put_file(
            "multipart/large-zeroes.bin",
            source.path(),
            Some(Box::new(move |uploaded, total| {
                upload_events.lock().unwrap().push((uploaded, total));
            })),
        )
        .await
        .expect("multipart upload should work");
    assert_eq!(uploaded_hash, expected_hash);

    let events = progress_events.lock().unwrap().clone();
    assert!(
        events
            .iter()
            .any(|(uploaded, total)| *uploaded == file_size && *total == file_size),
        "multipart upload should report final progress"
    );

    let target = NamedTempFile::new().expect("create multipart download target");
    let downloaded_hash = storage
        .get_file(
            "multipart/large-zeroes.bin",
            target.path(),
            Some(&expected_hash),
            None,
        )
        .await
        .expect("multipart download should pass checksum");
    assert_eq!(downloaded_hash, expected_hash);
}

#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn webdav_basic_object_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_basic_object_contract(webdav_storage().await).await;
}

#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn webdav_object_semantics_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_object_semantics_contract(webdav_storage().await).await;
}

#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn webdav_file_checksum_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_file_checksum_contract(webdav_storage().await).await;
}

#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn webdav_encrypted_backup_payload_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_encrypted_backup_payload_contract(webdav_storage().await).await;
}

#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn webdav_file_checksum_mismatch_preserves_local_target_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_file_checksum_mismatch_preserves_local_target_contract(webdav_storage().await).await;
}

#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn webdav_sync_manager_roundtrip_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_sync_manager_roundtrip_contract(webdav_storage().await).await;
}

#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn webdav_encrypted_data_governance_payload_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_encrypted_data_governance_payload_contract(webdav_storage().await).await;
}

#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn webdav_mixed_plaintext_and_encrypted_change_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_mixed_plaintext_and_encrypted_change_contract(webdav_storage().await).await;
}

#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn webdav_duplicate_enriched_change_files_are_idempotent_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_duplicate_enriched_change_files_are_idempotent_contract(webdav_storage().await).await;
}

#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn webdav_corrupt_change_file_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_corrupt_change_file_contract(webdav_storage().await).await;
}

#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn webdav_corrupt_manifest_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_corrupt_manifest_contract(webdav_storage().await).await;
}

#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn webdav_prune_old_changes_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_prune_old_changes_contract(webdav_storage().await).await;
}

#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn webdav_workspace_database_file_sync_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_workspace_database_file_sync_contract(webdav_storage().await).await;
}

#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn webdav_workspace_remote_same_size_corruption_rejected_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_workspace_remote_same_size_corruption_rejected_contract(webdav_storage().await).await;
}

#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn webdav_vfs_blob_file_sync_and_tombstone_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_vfs_blob_file_sync_and_tombstone_contract(webdav_storage().await).await;
}

#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn webdav_vfs_blob_remote_same_size_corruption_rejected_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_vfs_blob_remote_same_size_corruption_rejected_contract(webdav_storage().await).await;
}

#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn webdav_asset_directories_file_sync_and_tombstone_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_asset_directories_file_sync_and_tombstone_contract(webdav_storage().await).await;
}

#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn webdav_asset_remote_same_size_corruption_rejected_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_asset_remote_same_size_corruption_rejected_contract(webdav_storage().await).await;
}

#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn webdav_bad_credentials_rejected() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    let storage = webdav_storage_with_password("definitely-wrong-password").await;
    assert!(
        storage.check_connection().await.is_err(),
        "WebDAV bad credentials must fail check_connection"
    );
}

#[cfg(feature = "cloud_storage_s3")]
#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn s3_basic_object_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_basic_object_contract(s3_storage().await).await;
}

#[cfg(feature = "cloud_storage_s3")]
#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn s3_object_semantics_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_object_semantics_contract(s3_storage().await).await;
}

#[cfg(feature = "cloud_storage_s3")]
#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn s3_file_checksum_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_file_checksum_contract(s3_storage().await).await;
}

#[cfg(feature = "cloud_storage_s3")]
#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn s3_encrypted_backup_payload_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_encrypted_backup_payload_contract(s3_storage().await).await;
}

#[cfg(feature = "cloud_storage_s3")]
#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn s3_file_checksum_mismatch_preserves_local_target_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_file_checksum_mismatch_preserves_local_target_contract(s3_storage().await).await;
}

#[cfg(feature = "cloud_storage_s3")]
#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn s3_sync_manager_roundtrip_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_sync_manager_roundtrip_contract(s3_storage().await).await;
}

#[cfg(feature = "cloud_storage_s3")]
#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn s3_encrypted_data_governance_payload_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_encrypted_data_governance_payload_contract(s3_storage().await).await;
}

#[cfg(feature = "cloud_storage_s3")]
#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn s3_mixed_plaintext_and_encrypted_change_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_mixed_plaintext_and_encrypted_change_contract(s3_storage().await).await;
}

#[cfg(feature = "cloud_storage_s3")]
#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn s3_duplicate_enriched_change_files_are_idempotent_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_duplicate_enriched_change_files_are_idempotent_contract(s3_storage().await).await;
}

#[cfg(feature = "cloud_storage_s3")]
#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn s3_corrupt_change_file_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_corrupt_change_file_contract(s3_storage().await).await;
}

#[cfg(feature = "cloud_storage_s3")]
#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn s3_corrupt_manifest_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_corrupt_manifest_contract(s3_storage().await).await;
}

#[cfg(feature = "cloud_storage_s3")]
#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn s3_prune_old_changes_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_prune_old_changes_contract(s3_storage().await).await;
}

#[cfg(feature = "cloud_storage_s3")]
#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn s3_workspace_database_file_sync_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_workspace_database_file_sync_contract(s3_storage().await).await;
}

#[cfg(feature = "cloud_storage_s3")]
#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn s3_workspace_remote_same_size_corruption_rejected_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_workspace_remote_same_size_corruption_rejected_contract(s3_storage().await).await;
}

#[cfg(feature = "cloud_storage_s3")]
#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn s3_vfs_blob_file_sync_and_tombstone_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_vfs_blob_file_sync_and_tombstone_contract(s3_storage().await).await;
}

#[cfg(feature = "cloud_storage_s3")]
#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn s3_vfs_blob_remote_same_size_corruption_rejected_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_vfs_blob_remote_same_size_corruption_rejected_contract(s3_storage().await).await;
}

#[cfg(feature = "cloud_storage_s3")]
#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn s3_asset_directories_file_sync_and_tombstone_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_asset_directories_file_sync_and_tombstone_contract(s3_storage().await).await;
}

#[cfg(feature = "cloud_storage_s3")]
#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn s3_asset_remote_same_size_corruption_rejected_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_asset_remote_same_size_corruption_rejected_contract(s3_storage().await).await;
}

#[cfg(feature = "cloud_storage_s3")]
#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn s3_bad_credentials_rejected() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    let storage = s3_storage_with_secret("definitely-wrong-secret").await;
    assert!(
        storage.check_connection().await.is_err(),
        "S3 bad credentials must fail check_connection"
    );
}

#[cfg(feature = "cloud_storage_s3")]
#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn s3_list_pagination_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_s3_list_pagination_contract(s3_storage().await).await;
}

#[cfg(feature = "cloud_storage_s3")]
#[tokio::test]
#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]
async fn s3_multipart_file_contract() {
    assert!(docker_contract_enabled(), "set DS_SYNC_TEST_DOCKER=1");
    run_s3_multipart_file_contract(s3_storage().await).await;
}
