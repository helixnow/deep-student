//! [R12-delta-inventory] 已验证 staging → 规范文件清单的门禁（DELTA-R11 §R12）。
//!
//! 只测清单本身：小 staging 往返、volatile-only 变化的复用判定、SQLite
//! 单行变化的最小 upload-new 集、路径穿越/超长拒绝，以及一条**源码锁**：
//! 生产 `sync_manager.rs` 仍是整 ZIP 单对象 `put_file`；`delta_inventory`
//! 仅被未接线的 `delta_upload` 积木复用，命令/UI 零调用方。本文件全绿
//! **不代表**增量备份已实现。

use std::fs;
use std::path::{Path, PathBuf};

use deep_student_lib::data_governance::backup::delta_inventory::{
    build_inventory, build_inventory_cross_checked, diff, manifest_unchanged_ignoring_volatile,
    validate_logical_path, MANIFEST_LOGICAL_PATH, VOLATILE_MANIFEST_FIELDS,
};
use deep_student_lib::data_governance::backup::{BackupFile, BackupManifest};
use sha2::{Digest, Sha256};

const DB_PATH: &str = "study_law.db";
const ASSET_PATH: &str = "assets/images/图 01.png";
const CRYPTO_PATH: &str = "crypto/master.key";

fn sha256_hex(path: &Path) -> String {
    let bytes = fs::read(path).expect("read file for hashing");
    format!("{:x}", Sha256::digest(&bytes))
}

fn write_file(root: &Path, relative: &str, bytes: &[u8]) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent dirs");
    }
    fs::write(&path, bytes).expect("write staging file");
}

/// 用 rusqlite 生成一个真实 SQLite 文件（`rows` 行）。回滚日志模式，
/// 关闭连接后 staging 里只留单个 .db 文件。
fn write_sqlite(root: &Path, relative: &str, rows: u32) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent dirs");
    }
    let conn = rusqlite::Connection::open(&path).expect("open sqlite");
    conn.execute_batch("CREATE TABLE progress (id INTEGER PRIMARY KEY, note TEXT NOT NULL);")
        .expect("create table");
    for i in 0..rows {
        conn.execute(
            "INSERT INTO progress (id, note) VALUES (?1, ?2)",
            rusqlite::params![i64::from(i) + 1, format!("note-{i}")],
        )
        .expect("insert row");
    }
    conn.close().expect("close sqlite");
}

/// 为 staging 根目录写一个合法的 v3 manifest.json，files 列出全部数据文件
/// （SHA 按磁盘真实内容计算，保证 staging 是「已验证」状态）。
fn write_manifest(root: &Path, data_files: &[&str]) {
    let mut manifest = BackupManifest::new("1.2.3");
    for relative in data_files {
        let path = root.join(relative);
        manifest.add_file(BackupFile {
            path: (*relative).to_string(),
            size: fs::metadata(&path).expect("stat staged file").len(),
            sha256: sha256_hex(&path),
            database_id: None,
        });
    }
    manifest
        .save_to_file(&root.join(MANIFEST_LOGICAL_PATH))
        .expect("save manifest");
}

/// SQLite + 资产 + crypto 文件各一，外加 manifest.json 的最小已验证 staging。
fn make_staging(root: &Path, db_rows: u32) {
    write_sqlite(root, DB_PATH, db_rows);
    write_file(root, ASSET_PATH, b"png-bytes-not-really-a-png");
    write_file(root, CRYPTO_PATH, b"fake-master-key-material");
    write_manifest(root, &[DB_PATH, ASSET_PATH, CRYPTO_PATH]);
}

fn copy_dir_recursive(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).expect("create copy target");
    for entry in fs::read_dir(src).expect("read src dir") {
        let entry = entry.expect("dir entry");
        let target = dst.join(entry.file_name());
        if entry.file_type().expect("file type").is_dir() {
            copy_dir_recursive(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).expect("copy file");
        }
    }
}

/// 只改 manifest.json 的 volatile 字段（created_at / backup_id /
/// snapshot_epoch），模拟「数据零变化、再出一版」的 staging。
fn bump_manifest_volatile_fields(root: &Path) {
    let path = root.join(MANIFEST_LOGICAL_PATH);
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&path).expect("read manifest")).expect("parse manifest");
    value["created_at"] = serde_json::json!("2027-01-01T00:00:00+00:00");
    value["backup_id"] = serde_json::json!("zerochange-second-run-0001");
    value["snapshot_epoch"] = serde_json::json!("00000000-0000-4000-8000-00000000feed");
    fs::write(
        &path,
        serde_json::to_string_pretty(&value).expect("serialize"),
    )
    .expect("write manifest");
}

// ============================================================================
// 1. 小 staging 往返：真实文件 → 规范清单 → 交叉核对
// ============================================================================

#[test]
fn r12_inventory_roundtrip_small_staging() {
    let dir = tempfile::tempdir().expect("tempdir");
    make_staging(dir.path(), 1);

    let (inventory, manifest) =
        build_inventory_cross_checked(dir.path()).expect("verified staging must yield inventory");

    // 规范排序：logical_path 字节序。
    let paths: Vec<&str> = inventory
        .entries
        .iter()
        .map(|e| e.logical_path.as_str())
        .collect();
    assert_eq!(
        paths,
        vec![ASSET_PATH, CRYPTO_PATH, MANIFEST_LOGICAL_PATH, DB_PATH],
        "entries must be sorted by logical_path byte order"
    );

    // hash 以磁盘内容为准，逐一独立复算。
    for entry in &inventory.entries {
        let on_disk = dir.path().join(&entry.logical_path);
        assert_eq!(entry.size, fs::metadata(&on_disk).expect("stat").len());
        assert_eq!(entry.plaintext_sha256, sha256_hex(&on_disk));
        assert_eq!(entry.plaintext_sha256.len(), 64);
        assert!(entry
            .plaintext_sha256
            .bytes()
            .all(|b| b.is_ascii_hexdigit()));
    }

    // logical_size = size 之和。
    let sum: u64 = inventory.entries.iter().map(|e| e.size).sum();
    assert_eq!(inventory.logical_size, sum);
    assert_eq!(manifest.files.len(), 3);

    // 磁盘内容偏离 manifest 声称值 → 交叉核对 fail-closed（磁盘为准，拒绝出清单）。
    write_file(dir.path(), ASSET_PATH, b"tampered-after-verification");
    assert!(
        build_inventory_cross_checked(dir.path()).is_err(),
        "disk/manifest divergence means the staging is no longer verified"
    );
}

// ============================================================================
// 2. 零变化（只动 manifest volatile 字段）：除 manifest 外全部 reuse
// ============================================================================

#[test]
fn r12_zero_change_reuses_everything_except_manifest() {
    let dir = tempfile::tempdir().expect("tempdir");
    let prev_root = dir.path().join("prev");
    let curr_root = dir.path().join("curr");
    fs::create_dir_all(&prev_root).expect("mkdir prev");
    make_staging(&prev_root, 1);
    copy_dir_recursive(&prev_root, &curr_root);
    bump_manifest_volatile_fields(&curr_root);

    let (prev, _) = build_inventory_cross_checked(&prev_root).expect("prev inventory");
    let (curr, _) = build_inventory_cross_checked(&curr_root).expect("curr inventory");

    let d = diff(&prev, &curr);
    let reuse_paths: Vec<&str> = d.reuse.iter().map(|e| e.logical_path.as_str()).collect();
    let upload_paths: Vec<&str> = d
        .upload_new
        .iter()
        .map(|e| e.logical_path.as_str())
        .collect();
    assert_eq!(
        reuse_paths,
        vec![ASSET_PATH, CRYPTO_PATH, DB_PATH],
        "all data files are byte-identical and must be reusable"
    );
    assert_eq!(
        upload_paths,
        vec![MANIFEST_LOGICAL_PATH],
        "only the volatile manifest itself changed"
    );
    assert!(d.deleted.is_empty());

    // reuse_candidates() 永远不含 manifest（always-changed 策略），
    // 即使某一版 manifest 字节恰好相同也不例外。
    let candidates: Vec<&str> = d
        .reuse_candidates()
        .iter()
        .map(|e| e.logical_path.as_str())
        .collect();
    assert_eq!(candidates, vec![ASSET_PATH, CRYPTO_PATH, DB_PATH]);

    let self_diff = diff(&prev, &prev);
    assert!(self_diff
        .reuse
        .iter()
        .any(|e| e.logical_path == MANIFEST_LOGICAL_PATH));
    assert!(self_diff
        .reuse_candidates()
        .iter()
        .all(|e| e.logical_path != MANIFEST_LOGICAL_PATH));

    // canonicalized 比较：剥离 volatile 字段后两版 manifest 内容一致。
    assert_eq!(
        VOLATILE_MANIFEST_FIELDS,
        ["created_at", "backup_id", "snapshot_epoch"]
    );
    let prev_bytes = fs::read(prev_root.join(MANIFEST_LOGICAL_PATH)).expect("read prev manifest");
    let curr_bytes = fs::read(curr_root.join(MANIFEST_LOGICAL_PATH)).expect("read curr manifest");
    assert!(
        manifest_unchanged_ignoring_volatile(&prev_bytes, &curr_bytes)
            .expect("both manifests are legal JSON"),
        "volatile-only changes must compare as unchanged"
    );

    // 真实字段变化（files[].sha256）不得被 canonicalization 吞掉。
    let mut mutated: serde_json::Value =
        serde_json::from_slice(&curr_bytes).expect("parse manifest");
    mutated["files"][0]["sha256"] =
        serde_json::json!("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    let mutated_bytes = serde_json::to_vec(&mutated).expect("serialize");
    assert!(
        !manifest_unchanged_ignoring_volatile(&prev_bytes, &mutated_bytes).expect("legal JSON")
    );
}

// ============================================================================
// 3. SQLite 一行变化：只有该文件 upload-new
// ============================================================================

#[test]
fn r12_sqlite_row_change_marks_only_that_file_upload_new() {
    let dir = tempfile::tempdir().expect("tempdir");
    let prev_root = dir.path().join("prev");
    let curr_root = dir.path().join("curr");
    fs::create_dir_all(&prev_root).expect("mkdir prev");
    make_staging(&prev_root, 1);

    // 当前版：其余文件字节级复制，只有 SQLite 多一行。
    copy_dir_recursive(&prev_root, &curr_root);
    fs::remove_file(curr_root.join(DB_PATH)).expect("drop copied db");
    write_sqlite(&curr_root, DB_PATH, 2);

    let prev = build_inventory(&prev_root).expect("prev inventory");
    let curr = build_inventory(&curr_root).expect("curr inventory");

    let d = diff(&prev, &curr);
    let upload_paths: Vec<&str> = d
        .upload_new
        .iter()
        .map(|e| e.logical_path.as_str())
        .collect();
    assert_eq!(
        upload_paths,
        vec![DB_PATH],
        "a one-row SQLite change must invalidate exactly that file"
    );
    let reuse_paths: Vec<&str> = d.reuse.iter().map(|e| e.logical_path.as_str()).collect();
    assert_eq!(
        reuse_paths,
        vec![ASSET_PATH, CRYPTO_PATH, MANIFEST_LOGICAL_PATH]
    );
    assert!(d.deleted.is_empty());
    // manifest 字节没变，diff 层面在 reuse，但复用候选仍必须排除它。
    assert!(d
        .reuse_candidates()
        .iter()
        .all(|e| e.logical_path != MANIFEST_LOGICAL_PATH));
}

#[test]
fn r12_diff_marks_deleted_paths() {
    let dir = tempfile::tempdir().expect("tempdir");
    let prev_root = dir.path().join("prev");
    let curr_root = dir.path().join("curr");
    fs::create_dir_all(&prev_root).expect("mkdir prev");
    make_staging(&prev_root, 1);
    copy_dir_recursive(&prev_root, &curr_root);
    fs::remove_file(curr_root.join(CRYPTO_PATH)).expect("delete staged file");

    let prev = build_inventory(&prev_root).expect("prev inventory");
    let curr = build_inventory(&curr_root).expect("curr inventory");
    let d = diff(&prev, &curr);
    assert_eq!(d.deleted, vec![CRYPTO_PATH.to_string()]);
    assert!(d.upload_new.is_empty());
}

// ============================================================================
// 4. 路径穿越 / 超长：fail-closed
// ============================================================================

#[test]
fn r12_logical_path_traversal_and_overlong_are_rejected() {
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
        assert!(
            validate_logical_path(bad).is_err(),
            "logical path {bad:?} must be rejected"
        );
    }

    // 上限按字节计（与 delta_format 的 MAX_LOGICAL_PATH_BYTES 一致）：
    // 恰好 4096 合法，4097 fail-closed，不截断。
    let at_limit = format!("d/{}", "p".repeat(4094));
    assert_eq!(at_limit.len(), 4096);
    validate_logical_path(&at_limit).expect("4096-byte path is legal");
    let over = format!("d/{}", "p".repeat(4095));
    let err = validate_logical_path(&over).expect_err("4097-byte path must be rejected");
    assert!(
        format!("{err:?}").contains("4096"),
        "error should state the limit, got {err:?}"
    );
}

#[cfg(unix)]
#[test]
fn r12_staging_with_backslash_filename_or_symlink_fails_closed() {
    // Linux 允许文件名里带 `\`；逻辑路径规则不允许，整个清单必须拒绝。
    let dir = tempfile::tempdir().expect("tempdir");
    make_staging(dir.path(), 1);
    write_file(dir.path(), r"weird\name.bin", b"x");
    assert!(
        build_inventory(dir.path()).is_err(),
        "backslash in a real filename must fail the whole inventory"
    );

    // 符号链接不属于已验证 staging，fail-closed。
    let dir2 = tempfile::tempdir().expect("tempdir");
    make_staging(dir2.path(), 1);
    std::os::unix::fs::symlink(dir2.path().join(CRYPTO_PATH), dir2.path().join("link.key"))
        .expect("create symlink");
    assert!(
        build_inventory(dir2.path()).is_err(),
        "symlinks inside staging must fail-closed"
    );
}

// ============================================================================
// 5. 源码锁：生产上传仍是整 ZIP put_file；本模块零生产调用方
// ============================================================================

#[test]
fn r12_source_lock_inventory_has_no_production_callers() {
    // 生产备份仍构造 backups/<version>.zip 并整包 put_file。
    let sync_manager = include_str!("../src/cloud_storage/sync_manager.rs");
    assert!(
        sync_manager.contains(r#"format!("{}/{}.zip", BACKUPS_DIR, version_id)"#),
        "sync_manager.rs no longer builds the whole-ZIP remote key; \
         if delta upload landed, replace this lock with real integration tests"
    );
    assert!(
        sync_manager.contains(".put_file(&remote_key, zip_path, progress)"),
        "sync_manager.rs no longer PUTs the whole ZIP as one object"
    );
    assert!(
        !sync_manager.contains("delta_inventory"),
        "sync_manager.rs references delta_inventory; inventory is not wired to upload"
    );

    // 本路不分配云端对象名：模块里不得出现 object_key 字段或 put_file 调用。
    let module_src = include_str!("../src/data_governance/backup/delta_inventory.rs");
    assert!(
        !module_src.contains("object_key:") && !module_src.contains("pub object_key"),
        "delta_inventory must not assign cloud object keys (that is the upload route)"
    );
    assert!(
        !module_src.contains(".put_file(") && !module_src.contains("CloudStorageProvider"),
        "delta_inventory must not talk to cloud storage"
    );

    // 全 src 扫描：除声明行、模块自身、未接线 upload 积木外，生产代码零引用。
    let src_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut referencing_files = Vec::new();
    collect_files_mentioning(&src_root, "delta_inventory", &mut referencing_files);
    referencing_files.sort();
    let names: Vec<String> = referencing_files
        .iter()
        .map(|p| {
            p.strip_prefix(&src_root)
                .expect("under src")
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect();
    assert_eq!(
        names,
        vec![
            "cloud_storage/delta_upload.rs".to_string(),
            "data_governance/backup/delta_inventory.rs".to_string(),
            "data_governance/backup/mod.rs".to_string(),
        ],
        "delta_inventory callers must stay unwired primitives only \
         (upload 积木可复用清单；sync_manager / 命令 / UI 仍不得引用)"
    );

    // backup/mod.rs 只允许出现声明行本身。
    let backup_mod = include_str!("../src/data_governance/backup/mod.rs");
    assert_eq!(
        backup_mod.matches("delta_inventory").count(),
        1,
        "backup/mod.rs may only declare the module, not call it"
    );
    assert!(backup_mod.contains("pub mod delta_inventory;"));
}

fn collect_files_mentioning(root: &Path, needle: &str, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(root).expect("read src dir") {
        let entry = entry.expect("dir entry");
        let path = entry.path();
        if entry.file_type().expect("file type").is_dir() {
            collect_files_mentioning(&path, needle, out);
        } else if path.extension().is_some_and(|ext| ext == "rs")
            && fs::read_to_string(&path)
                .expect("read source file")
                .contains(needle)
        {
            out.push(path);
        }
    }
}
