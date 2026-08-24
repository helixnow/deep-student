//! [R12-delta-format] backup-v2 codec 的格式门禁（DELTA-R11 §3–§5）。
//!
//! 只测 codec 本身：往返、未来版本拒绝、路径穿越拒绝、超限拒绝、重复路径、
//! `logicalSize` 不一致、非法 hex，以及一条**源码锁**：生产 `sync_manager.rs`
//! 仍是整 ZIP 单对象 `put_file`，未接入 delta codec。本文件全绿**不代表**
//! 增量备份已实现。

use deep_student_lib::cloud_storage::delta_format::{
    BackupV2RepoConfig, SnapshotDescriptorV2, SnapshotFileRefV2, BACKUP_V2_FORMAT,
    DELTA_FORMAT_VERSION, MAX_LOGICAL_PATH_BYTES, MAX_OBJECT_KEY_BYTES, MAX_SNAPSHOT_FILES,
    SNAPSHOT_V2_FORMAT,
};

const HEX_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEX_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn file_ref(path: &str, size: u64) -> SnapshotFileRefV2 {
    SnapshotFileRefV2 {
        logical_path: path.to_string(),
        size,
        plaintext_sha256: HEX_A.to_string(),
        object_key: format!("backup-v2/objects/device-1/{}.dsbk", path.replace('/', "-")),
        object_cipher_sha256: HEX_B.to_string(),
    }
}

fn descriptor(files: Vec<SnapshotFileRefV2>) -> SnapshotDescriptorV2 {
    let logical_size = files.iter().map(|f| f.size).sum();
    SnapshotDescriptorV2 {
        format: SNAPSHOT_V2_FORMAT.to_string(),
        format_version: DELTA_FORMAT_VERSION,
        version_id: "20260824-140000-000-abc123-deadbeef".to_string(),
        device_id: "device-1".to_string(),
        created_at: "2026-08-24T14:00:00+00:00".to_string(),
        files,
        logical_size,
    }
}

fn repo_config() -> BackupV2RepoConfig {
    BackupV2RepoConfig {
        format: BACKUP_V2_FORMAT.to_string(),
        format_version: DELTA_FORMAT_VERSION,
        id_key_epoch: 1,
    }
}

// ============================================================================
// 往返：decode(encode(x)) == x
// ============================================================================

#[test]
fn r12_descriptor_roundtrip_is_lossless() {
    let original = descriptor(vec![
        file_ref("db/chat_v2.db", 1024),
        file_ref("assets/图片 01.png", 0),
        file_ref("assets/notes.bin", u64::from(u32::MAX)),
    ]);
    let bytes = original.encode().expect("encode valid descriptor");
    let decoded = SnapshotDescriptorV2::decode(&bytes).expect("decode own encoding");
    assert_eq!(decoded, original);

    // 空文件表也是合法快照（零变化恢复点），同样必须无损往返。
    let empty = descriptor(vec![]);
    let decoded_empty =
        SnapshotDescriptorV2::decode(&empty.encode().expect("encode empty")).expect("decode");
    assert_eq!(decoded_empty, empty);
}

#[test]
fn r12_repo_config_roundtrip_is_lossless() {
    let original = repo_config();
    let bytes = original.encode().expect("encode valid config");
    let decoded = BackupV2RepoConfig::decode(&bytes).expect("decode own encoding");
    assert_eq!(decoded, original);
}

#[test]
fn r12_encoded_field_names_are_camel_case() {
    let bytes = descriptor(vec![file_ref("a.bin", 1)])
        .encode()
        .expect("encode");
    let text = String::from_utf8(bytes).expect("utf8");
    for field in [
        "\"format\"",
        "\"formatVersion\"",
        "\"versionId\"",
        "\"deviceId\"",
        "\"createdAt\"",
        "\"files\"",
        "\"logicalSize\"",
        "\"logicalPath\"",
        "\"plaintextSha256\"",
        "\"objectKey\"",
        "\"objectCipherSha256\"",
    ] {
        assert!(text.contains(field), "missing field {field} in {text}");
    }
}

// ============================================================================
// 未来版本 / 错误 format：fail-closed
// ============================================================================

#[test]
fn r12_future_format_version_is_rejected() {
    let mut future = descriptor(vec![file_ref("a.bin", 1)]);
    future.format_version = 3;
    assert!(future.encode().is_err(), "encode must refuse version 3");
    let json = serde_json::to_vec(&future).expect("raw serialize");
    assert!(
        SnapshotDescriptorV2::decode(&json).is_err(),
        "decode must refuse future formatVersion"
    );

    let mut past = descriptor(vec![]);
    past.format_version = 1;
    assert!(
        past.encode().is_err(),
        "version 1 is not this format either"
    );

    let mut future_cfg = repo_config();
    future_cfg.format_version = 3;
    let cfg_json = serde_json::to_vec(&future_cfg).expect("raw serialize");
    assert!(BackupV2RepoConfig::decode(&cfg_json).is_err());
}

#[test]
fn r12_wrong_format_string_is_rejected() {
    let mut wrong = descriptor(vec![]);
    wrong.format = "snapshot-v3".to_string();
    assert!(wrong.encode().is_err());

    let mut wrong_cfg = repo_config();
    wrong_cfg.format = "backup-v1".to_string();
    assert!(wrong_cfg.encode().is_err());
}

#[test]
fn r12_parent_or_patch_fields_are_rejected_not_ignored() {
    // 恢复链依赖禁令的 schema 面：多出的 parent/patch 字段必须让解码失败，
    // 而不是被 serde 静默忽略后当成自包含快照。
    let bytes = descriptor(vec![file_ref("a.bin", 1)])
        .encode()
        .expect("encode");
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).expect("parse");
    value["parent"] = serde_json::json!("20260101-000000-000-old-version");
    let with_parent = serde_json::to_vec(&value).expect("serialize");
    assert!(SnapshotDescriptorV2::decode(&with_parent).is_err());

    value.as_object_mut().expect("object").remove("parent");
    value["patchOf"] = serde_json::json!("base-version");
    let with_patch = serde_json::to_vec(&value).expect("serialize");
    assert!(SnapshotDescriptorV2::decode(&with_patch).is_err());
}

#[test]
fn r12_repo_config_refuses_key_material_and_zero_epoch() {
    let bytes = repo_config().encode().expect("encode");
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).expect("parse");
    value["wrappedIdKey"] = serde_json::json!("base64-key-material");
    let with_key = serde_json::to_vec(&value).expect("serialize");
    assert!(
        BackupV2RepoConfig::decode(&with_key).is_err(),
        "config schema must not silently accept key material fields"
    );

    let mut zero = repo_config();
    zero.id_key_epoch = 0;
    assert!(
        zero.encode().is_err(),
        "idKeyEpoch=0 is uninitialized, fail-closed"
    );
}

// ============================================================================
// 路径穿越 / objectKey 穿越
// ============================================================================

#[test]
fn r12_logical_path_traversal_is_rejected() {
    for bad in [
        "../escape.bin",
        "a/../b.bin",
        "..",
        "/abs/path.bin",
        "a//b.bin",
        "a/",
        "/",
        "",
        "a\\b.bin",
        "a/./b.bin",
        "c:/windows.bin",
        "a/\u{0}null.bin",
    ] {
        let d = descriptor(vec![file_ref(bad, 1)]);
        assert!(d.encode().is_err(), "logicalPath {bad:?} must be rejected");
    }
}

#[test]
fn r12_object_key_traversal_is_rejected() {
    for bad in [
        "../../manifests/device.json",
        "/backup-v2/objects/x.dsbk",
        "backup-v2/objects/../../marker",
        "backup-v2//objects/x.dsbk",
        "backup-v2\\objects\\x.dsbk",
        "",
    ] {
        let mut f = file_ref("a.bin", 1);
        f.object_key = bad.to_string();
        let d = descriptor(vec![f]);
        assert!(d.encode().is_err(), "objectKey {bad:?} must be rejected");
    }
}

// ============================================================================
// 上限：超限拒绝、不截断
// ============================================================================

#[test]
fn r12_file_count_over_limit_is_rejected() {
    let mut files = Vec::with_capacity(MAX_SNAPSHOT_FILES + 1);
    for i in 0..=MAX_SNAPSHOT_FILES {
        files.push(file_ref(&format!("f/{i}.bin"), 1));
    }
    let over = descriptor(files);
    assert_eq!(over.files.len(), MAX_SNAPSHOT_FILES + 1);
    assert!(over.encode().is_err(), "100001 files must be rejected");

    // 恰好等于上限时合法（校验是 ≤，不是 <）。
    let mut at_limit = over.clone();
    let removed = at_limit.files.pop().expect("pop");
    at_limit.logical_size -= removed.size;
    at_limit.validate().expect("exactly 100000 files is legal");
}

#[test]
fn r12_path_and_object_key_length_limits_reject_not_truncate() {
    // path 上限按字节计：恰好 4096 合法，4097 拒绝。
    // objectKey 固定为短值，避免 helper 由 path 派生的 key 先触发 512 上限。
    let short_key = |path: &str| {
        let mut f = file_ref(path, 1);
        f.object_key = "backup-v2/objects/device-1/fixed.dsbk".to_string();
        f
    };
    let at_limit = format!("d/{}", "p".repeat(MAX_LOGICAL_PATH_BYTES - 2));
    assert_eq!(at_limit.len(), MAX_LOGICAL_PATH_BYTES);
    descriptor(vec![short_key(&at_limit)])
        .validate()
        .expect("4096-byte path is legal");

    let over = format!("d/{}", "p".repeat(MAX_LOGICAL_PATH_BYTES - 1));
    let d = descriptor(vec![short_key(&over)]);
    let err = d.encode().expect_err("4097-byte path must be rejected");
    assert!(
        format!("{err:?}").contains("4096"),
        "error should state the limit, got {err:?}"
    );

    let mut f = file_ref("a.bin", 1);
    f.object_key = format!("k/{}", "o".repeat(MAX_OBJECT_KEY_BYTES - 1));
    assert!(
        descriptor(vec![f]).encode().is_err(),
        "513-byte objectKey must be rejected"
    );
}

// ============================================================================
// 重复 path / logicalSize / 非法 hex
// ============================================================================

#[test]
fn r12_duplicate_logical_path_is_rejected() {
    let d = descriptor(vec![file_ref("dup/a.bin", 1), file_ref("dup/a.bin", 2)]);
    assert!(
        d.encode().is_err(),
        "duplicate logicalPath must fail-closed"
    );
}

#[test]
fn r12_logical_size_mismatch_is_rejected() {
    let mut d = descriptor(vec![file_ref("a.bin", 10), file_ref("b.bin", 20)]);
    d.logical_size = 31;
    assert!(
        d.encode().is_err(),
        "logicalSize != sum(files.size) must fail"
    );
    let json = serde_json::to_vec(&d).expect("raw serialize");
    assert!(SnapshotDescriptorV2::decode(&json).is_err());

    d.logical_size = 30;
    d.validate().expect("exact sum is legal");
}

#[test]
fn r12_invalid_hex_digests_are_rejected() {
    for bad in [
        "aaaa",                               // 太短
        &HEX_A[..63],                         // 63 位
        &format!("{}a", HEX_A),               // 65 位
        &format!("{}g", &HEX_A[..63]),        // 非 hex 字符
        &format!("{}\u{4e2d}", &HEX_A[..63]), // 非 ASCII
        "",
    ] {
        let mut f = file_ref("a.bin", 1);
        f.plaintext_sha256 = bad.to_string();
        assert!(
            descriptor(vec![f]).encode().is_err(),
            "plaintextSha256 {bad:?} must be rejected"
        );

        let mut f2 = file_ref("a.bin", 1);
        f2.object_cipher_sha256 = bad.to_string();
        assert!(
            descriptor(vec![f2]).encode().is_err(),
            "objectCipherSha256 {bad:?} must be rejected"
        );
    }
}

// ============================================================================
// 源码锁：生产上传路径仍是整 ZIP 单对象 put_file，codec 未接线
// ============================================================================

#[test]
fn r12_source_lock_sync_manager_still_uploads_whole_zip() {
    let source = include_str!("../src/cloud_storage/sync_manager.rs");

    // 生产备份仍构造 backups/<version>.zip 并整包 put_file。
    assert!(
        source.contains(r#"format!("{}/{}.zip", BACKUPS_DIR, version_id)"#),
        "sync_manager.rs no longer builds the whole-ZIP remote key; \
         if delta upload landed, replace this lock with real integration tests"
    );
    assert!(
        source.contains(".put_file(&remote_key, zip_path, progress)"),
        "sync_manager.rs no longer PUTs the whole ZIP as one object"
    );

    // codec 尚未接线：生产 sync_manager 不得引用 delta_format / backup-v2。
    assert!(
        !source.contains("delta_format"),
        "sync_manager.rs references delta_format; R12-delta-format is codec-only \
         and must not be wired into upload"
    );
    assert!(
        !source.contains("backup-v2"),
        "sync_manager.rs references the backup-v2 namespace; integration belongs \
         to R12-delta-integration, not this codec-only route"
    );
}
