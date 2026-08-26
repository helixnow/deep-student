//! P0-ZIP 契约测试：导出 ZIP → 导入 → restore 的端到端行为锁定。
//!
//! 契约（本文件锁定的不变量）：
//! 1. 真实 `backup_with_assets` 产物的分类必须自洽：
//!    `snapshot_kind == Full` 当且仅当 `validate_for_slot_restore` 通过
//!    （disaster_recovery 标签只能来自证据，不允许分叉）。
//! 2. `export_backup_to_zip` 会把清单改写为便携归档（剥离本地加密材料，
//!    `mark_partial` + `key_policy=excluded_portable`），`import_backup_from_zip`
//!    必须能完整导入该 ZIP，且导入的数据库字节与源备份逐位一致。
//! 3. 对导入产物执行恢复时，结果必须二选一：
//!    - 要么 `validate_for_slot_restore` 通过且 `restore_with_assets` 真正
//!      恢复成功（数据落回数据槽）；
//!    - 要么返回**可操作错误**（明确拒绝，用户可依此走部分恢复/重新导出路径）。
//!    绝不允许第三种状态：被归类为 disaster_recovery（validate 通过）却恢复
//!    失败，或恢复未发生却被当成功——`classify_recovery_kind` 与实际 restore
//!    共用 `validate_for_slot_restore`，两者必须一致。
//! 4. **加密全保真闭环**（R02 新增）：提供备份密码导出时，敏感数据连同原始
//!    manifest 一起密封进 `portable_secrets.dsbk`；导入时提供同一密码即可解封
//!    回原始完整快照，`validate_for_slot_restore` 通过且整槽恢复真正成功。
//!    缺少密码或密码错误时导入必须返回可操作错误。
//! 5. **诚实分类**：未加密便携 ZIP 导入后恒为 partial_archive
//!    （`key_policy=excluded_portable` + `PartialOverlay`），validate 与
//!    restore 都必须显式拒绝，不允许伪装成 disaster_recovery。
//!
//! 全流程在临时目录内完成，不触碰真实数据。

#![cfg(feature = "data_governance")]

use std::io::Write;
use std::path::{Path, PathBuf};

use deep_student_lib::data_governance::backup::{
    export_backup_to_zip,
    zip_export::{
        import_backup_from_zip, import_backup_from_zip_with_password,
        zip_contains_encrypted_secrets, ENCRYPTED_SECRETS_ENTRY,
    },
    BackupKeyPolicy, BackupManager, BackupManifest, SnapshotKind, ZipExportOptions,
};
use deep_student_lib::data_governance::commands_zip::{
    resolve_import_zip_password, resolve_zip_encryption_password,
};
use rusqlite::Connection;
use tempfile::TempDir;

const MARKER_VALUE: &str = "p0-zip-roundtrip-marker";
const ENCRYPTION_PASSWORD: &str = "test-backup-passphrase";

/// 在 `base/slots/slotA` 布局下创建四个核心数据库（含标记数据），
/// 返回 slotA 路径。传入 slot 路径可让 BackupManager 不依赖全局
/// DataSpaceManager（`app_data_dir.parent() == "slots"` 时直接使用）。
fn create_slot_with_databases(base: &Path) -> PathBuf {
    let slot = base.join("slots").join("slotA");
    std::fs::create_dir_all(slot.join("databases")).expect("create slot layout");

    let databases = [
        slot.join("databases").join("vfs.db"),
        slot.join("chat_v2.db"),
        slot.join("mistakes.db"),
        slot.join("llm_usage.db"),
    ];
    for path in &databases {
        let conn = Connection::open(path).expect("open sqlite db");
        conn.execute_batch(&format!(
            "CREATE TABLE roundtrip_marker (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO roundtrip_marker(value) VALUES ('{MARKER_VALUE}');"
        ))
        .expect("seed marker data");
    }
    slot
}

fn read_marker(db_path: &Path) -> Option<String> {
    let conn = Connection::open(db_path).ok()?;
    conn.query_row("SELECT value FROM roundtrip_marker LIMIT 1", [], |row| {
        row.get::<_, String>(0)
    })
    .ok()
}

/// 完整链路：backup_full → 导出 ZIP → 导入 → 恢复契约。
#[test]
fn zip_roundtrip_restore_succeeds_or_returns_actionable_error() {
    // ---------- 1. 源数据槽 + 真实完整备份 ----------
    let source_root = TempDir::new().expect("source root");
    let source_slot = create_slot_with_databases(source_root.path());

    let backup_dir = source_root.path().join("recovery").join("backups");
    let mut manager = BackupManager::new(backup_dir.clone());
    manager.set_app_data_dir(source_slot.clone());
    manager.set_app_version(env!("CARGO_PKG_VERSION").to_string());

    // backup_with_assets 是 disaster_recovery 自动备份的生产路径
    // （backup_core 产物恒为 PartialOverlay，只有带资产覆盖证据的备份
    // 才可能升级为 Full）。
    let manifest = manager
        .backup_with_assets(None)
        .expect("backup_with_assets 应成功");
    // 源头分类一致性：Full ⇔ validate_for_slot_restore 通过。
    // 任何一侧分叉都意味着本地备份会被错误标注 disaster_recovery/partial。
    assert_eq!(
        manifest.snapshot_kind == SnapshotKind::Full,
        manifest.validate_for_slot_restore().is_ok(),
        "snapshot_kind 与 validate_for_slot_restore 分类出现分叉: kind={:?}, validate={:?}",
        manifest.snapshot_kind,
        manifest
            .validate_for_slot_restore()
            .map_err(|e| e.to_string())
    );
    let backup_subdir = backup_dir.join(&manifest.backup_id);
    assert!(backup_subdir.is_dir(), "备份目录应存在");

    // ---------- 2. 导出 ZIP ----------
    let export_root = TempDir::new().expect("export root");
    let zip_path = export_root.path().join("roundtrip.zip");
    let export_result = export_backup_to_zip(
        &backup_subdir,
        &ZipExportOptions {
            output_path: Some(zip_path.clone()),
            include_checksums: true,
            ..Default::default()
        },
    )
    .expect("导出 ZIP 应成功");
    assert!(zip_path.is_file(), "ZIP 文件应已生成");
    assert!(export_result.file_count > 0, "ZIP 应包含文件");

    // ---------- 3. 导入 ZIP（模拟另一台设备 / 灾后环境） ----------
    let restore_root = TempDir::new().expect("restore root");
    let restore_slot = create_slot_with_databases(restore_root.path());
    // 恢复目标槽先写入不同数据，验证 restore 是否真的发生
    for db in ["chat_v2.db", "mistakes.db", "llm_usage.db"] {
        let conn = Connection::open(restore_slot.join(db)).expect("open target db");
        conn.execute("UPDATE roundtrip_marker SET value = 'pre-restore-data'", [])
            .expect("seed pre-restore data");
    }

    let restore_backup_dir = restore_root.path().join("recovery").join("backups");
    let imported_dir = restore_backup_dir.join(&manifest.backup_id);
    std::fs::create_dir_all(&restore_backup_dir).expect("create restore backup dir");
    let imported_files = import_backup_from_zip(&zip_path, &imported_dir).expect("导入 ZIP 应成功");
    assert!(imported_files > 0, "导入应至少解出一个文件");

    // 导入的数据库字节必须与源备份逐位一致（ZIP 往返不丢数据）。
    for db in ["vfs.db", "chat_v2.db", "mistakes.db", "llm_usage.db"] {
        let original =
            deep_student_lib::backup_common::calculate_file_hash(&backup_subdir.join(db))
                .expect("hash original");
        let imported = deep_student_lib::backup_common::calculate_file_hash(&imported_dir.join(db))
            .expect("hash imported");
        assert_eq!(original, imported, "{db} 在 ZIP 往返后字节不一致");
    }

    let imported_manifest = BackupManifest::load_from_file(&imported_dir.join("manifest.json"))
        .expect("导入产物必须携带可解析的 manifest");

    // ---------- 4. 恢复契约：成功，或可操作错误；分类与结果必须一致 ----------
    let mut restore_manager = BackupManager::new(restore_backup_dir.clone());
    restore_manager.set_app_data_dir(restore_slot.clone());
    restore_manager.set_app_version(env!("CARGO_PKG_VERSION").to_string());

    let slot_restore_verdict = imported_manifest.validate_for_slot_restore();
    let restore_result = restore_manager.restore_with_assets(&imported_manifest, false);

    match slot_restore_verdict {
        Ok(()) => {
            // 被归类为 disaster_recovery（restorable=true）→ 恢复必须真正成功。
            restore_result.expect("被归类为 disaster_recovery 的备份恢复必须成功");
            for db in ["chat_v2.db", "mistakes.db", "llm_usage.db"] {
                assert_eq!(
                    read_marker(&restore_slot.join(db)).as_deref(),
                    Some(MARKER_VALUE),
                    "disaster_recovery 恢复后 {db} 必须回到备份内容"
                );
            }
        }
        Err(classification_error) => {
            // 被归类为 partial_archive（restorable=false）→ restore 必须显式拒绝，
            // 且给出可操作错误；绝不能悄悄“成功”。
            let restore_error = restore_result.expect_err(
                "validate_for_slot_restore 拒绝的备份，restore_with_assets 不得报成功\
                 （否则 partial_archive 会被当成 disaster_recovery 成功）",
            );
            let message = restore_error.to_string();
            assert!(!message.trim().is_empty(), "恢复拒绝必须携带可操作错误信息");
            assert!(
                !classification_error.to_string().trim().is_empty(),
                "分类拒绝必须携带可操作错误信息"
            );
            // 恢复未发生：目标槽数据必须保持原状，不能被半恢复破坏。
            for db in ["chat_v2.db", "mistakes.db", "llm_usage.db"] {
                assert_eq!(
                    read_marker(&restore_slot.join(db)).as_deref(),
                    Some("pre-restore-data"),
                    "被拒绝的恢复不得改动目标槽 {db}"
                );
            }
        }
    }
}

/// 便携 ZIP 的分类必须与实际 restore 门禁使用同一判定：
/// 对同一份导入清单，`validate_for_slot_restore`（classify_recovery_kind 的
/// 依据）为 Err 时，restore 也必须为 Err —— 二者不允许出现分叉。
#[test]
fn imported_manifest_classification_matches_restore_gate() {
    let source_root = TempDir::new().expect("source root");
    let source_slot = create_slot_with_databases(source_root.path());

    let backup_dir = source_root.path().join("recovery").join("backups");
    let mut manager = BackupManager::new(backup_dir.clone());
    manager.set_app_data_dir(source_slot);
    manager.set_app_version(env!("CARGO_PKG_VERSION").to_string());
    let manifest = manager
        .backup_with_assets(None)
        .expect("backup_with_assets 应成功");

    let zip_dir = TempDir::new().expect("zip dir");
    let zip_path = zip_dir.path().join("classification.zip");
    export_backup_to_zip(
        &backup_dir.join(&manifest.backup_id),
        &ZipExportOptions {
            output_path: Some(zip_path.clone()),
            ..Default::default()
        },
    )
    .expect("导出 ZIP 应成功");

    let import_root = TempDir::new().expect("import root");
    let imported_dir = import_root.path().join("backups").join(&manifest.backup_id);
    std::fs::create_dir_all(imported_dir.parent().unwrap()).expect("create import parent");
    import_backup_from_zip(&zip_path, &imported_dir).expect("导入 ZIP 应成功");

    let imported_manifest = BackupManifest::load_from_file(&imported_dir.join("manifest.json"))
        .expect("导入 manifest 可解析");

    let import_slot = create_slot_with_databases(import_root.path());
    let mut restore_manager = BackupManager::new(import_root.path().join("backups"));
    restore_manager.set_app_data_dir(import_slot);
    restore_manager.set_app_version(env!("CARGO_PKG_VERSION").to_string());

    let classified_restorable = imported_manifest.validate_for_slot_restore().is_ok();
    let restore_outcome = restore_manager.restore_with_assets(&imported_manifest, false);

    assert_eq!(
        classified_restorable,
        restore_outcome.is_ok(),
        "recovery_kind 分类（validate_for_slot_restore）与实际 restore 门禁出现分叉：\
         classified_restorable={classified_restorable}, restore={restore_outcome:?}"
    );
}

/// 构造一份来自合成数据槽的完整备份，返回（备份根目录守卫、备份根、清单）。
fn create_full_backup() -> (TempDir, PathBuf, BackupManifest) {
    let source_root = TempDir::new().expect("source root");
    let source_slot = create_slot_with_databases(source_root.path());

    let backup_dir = source_root.path().join("recovery").join("backups");
    let mut manager = BackupManager::new(backup_dir.clone());
    manager.set_app_data_dir(source_slot);
    manager.set_app_version(env!("CARGO_PKG_VERSION").to_string());
    let manifest = manager
        .backup_with_assets(None)
        .expect("backup_with_assets 应成功");
    (source_root, backup_dir, manifest)
}

/// R02 加密全保真闭环：带密码导出 → 带密码导入解封 → validate 通过 → 整槽恢复成功。
///
/// 这是换机（云盘/ZIP 搬运）场景的核心契约：加密 ZIP 在另一台设备上
/// 必须能还原为与本地完整快照同等的可恢复备份。
#[test]
fn encrypted_zip_roundtrip_restores_full_slot() {
    let (_source_guard, backup_dir, manifest) = create_full_backup();
    assert!(
        manifest.validate_for_slot_restore().is_ok(),
        "闭环前提：本地完整备份必须可整槽恢复，实际: {:?}",
        manifest
            .validate_for_slot_restore()
            .map_err(|e| e.to_string())
    );
    let backup_subdir = backup_dir.join(&manifest.backup_id);

    // ---------- 加密导出 ----------
    let export_root = TempDir::new().expect("export root");
    let zip_path = export_root.path().join("encrypted-full-fidelity.zip");
    export_backup_to_zip(
        &backup_subdir,
        &ZipExportOptions {
            output_path: Some(zip_path.clone()),
            encryption_password: Some(ENCRYPTION_PASSWORD.to_string()),
            ..Default::default()
        },
    )
    .expect("加密全保真导出应成功");

    // 外层 ZIP 必须携带密封载荷，且外层清单声明 included_encrypted、
    // 自身不可整槽恢复（未解封前不允许伪装成 disaster_recovery）。
    {
        let file = std::fs::File::open(&zip_path).expect("open zip");
        let mut archive = zip::ZipArchive::new(file).expect("parse zip");
        let names: Vec<String> = (0..archive.len())
            .map(|index| archive.by_index(index).unwrap().name().to_string())
            .collect();
        assert!(
            names.iter().any(|name| name == "portable_secrets.dsbk"),
            "加密导出必须包含密封载荷 portable_secrets.dsbk，实际条目: {names:?}"
        );
        let mut outer_manifest_bytes = Vec::new();
        std::io::Read::read_to_end(
            &mut archive.by_name("manifest.json").expect("outer manifest"),
            &mut outer_manifest_bytes,
        )
        .expect("read outer manifest");
        let outer: BackupManifest =
            serde_json::from_slice(&outer_manifest_bytes).expect("parse outer manifest");
        assert_eq!(outer.key_policy, BackupKeyPolicy::IncludedEncrypted);
        assert_eq!(outer.snapshot_kind, SnapshotKind::PartialOverlay);
        let sealed_error = outer
            .validate_for_slot_restore()
            .expect_err("未解封的外层清单不得通过整槽恢复验证")
            .to_string();
        assert!(
            sealed_error.contains("密码"),
            "未解封清单的拒绝必须提示提供备份密码，实际: {sealed_error}"
        );
    }

    // ---------- 另一台设备：带密码导入并解封 ----------
    let restore_root = TempDir::new().expect("restore root");
    let restore_slot = create_slot_with_databases(restore_root.path());
    for db in ["chat_v2.db", "mistakes.db", "llm_usage.db"] {
        let conn = Connection::open(restore_slot.join(db)).expect("open target db");
        conn.execute("UPDATE roundtrip_marker SET value = 'pre-restore-data'", [])
            .expect("seed pre-restore data");
    }
    let restore_backup_dir = restore_root.path().join("recovery").join("backups");
    let imported_dir = restore_backup_dir.join(&manifest.backup_id);
    std::fs::create_dir_all(&restore_backup_dir).expect("create restore backup dir");
    import_backup_from_zip_with_password(&zip_path, &imported_dir, Some(ENCRYPTION_PASSWORD))
        .expect("带密码导入加密全保真 ZIP 应成功");

    // 解封后：载荷已删除，原始清单还原，数据库字节与源备份一致。
    assert!(
        !imported_dir.join("portable_secrets.dsbk").exists(),
        "解封完成后密封载荷不得残留"
    );
    for db in ["vfs.db", "chat_v2.db", "mistakes.db", "llm_usage.db"] {
        let original =
            deep_student_lib::backup_common::calculate_file_hash(&backup_subdir.join(db))
                .expect("hash original");
        let imported = deep_student_lib::backup_common::calculate_file_hash(&imported_dir.join(db))
            .expect("hash imported");
        assert_eq!(original, imported, "{db} 在加密 ZIP 往返后字节不一致");
    }
    let imported_manifest = BackupManifest::load_from_file(&imported_dir.join("manifest.json"))
        .expect("解封后的原始清单可解析");
    assert_eq!(imported_manifest.snapshot_kind, SnapshotKind::Full);
    assert_ne!(
        imported_manifest.key_policy,
        BackupKeyPolicy::IncludedEncrypted,
        "解封必须还原原始 key_policy"
    );
    imported_manifest
        .validate_for_slot_restore()
        .expect("解封后的清单必须通过整槽恢复验证（加密全保真闭环）");

    // ---------- 整槽恢复必须真正成功 ----------
    let mut restore_manager = BackupManager::new(restore_backup_dir);
    restore_manager.set_app_data_dir(restore_slot.clone());
    restore_manager.set_app_version(env!("CARGO_PKG_VERSION").to_string());
    restore_manager
        .restore_with_assets(&imported_manifest, false)
        .expect("加密全保真 ZIP 解封后的整槽恢复必须成功");
    for db in ["chat_v2.db", "mistakes.db", "llm_usage.db"] {
        assert_eq!(
            read_marker(&restore_slot.join(db)).as_deref(),
            Some(MARKER_VALUE),
            "加密闭环恢复后 {db} 必须回到备份内容"
        );
    }
}

/// 加密全保真 ZIP 缺少密码时，导入必须返回提示提供备份密码的可操作错误。
#[test]
fn encrypted_zip_import_without_password_returns_actionable_error() {
    let (_source_guard, backup_dir, manifest) = create_full_backup();
    let export_root = TempDir::new().expect("export root");
    let zip_path = export_root.path().join("needs-password.zip");
    export_backup_to_zip(
        &backup_dir.join(&manifest.backup_id),
        &ZipExportOptions {
            output_path: Some(zip_path.clone()),
            encryption_password: Some(ENCRYPTION_PASSWORD.to_string()),
            ..Default::default()
        },
    )
    .expect("加密导出应成功");

    let import_root = TempDir::new().expect("import root");
    let imported_dir = import_root.path().join("imported");
    let error = import_backup_from_zip(&zip_path, &imported_dir)
        .expect_err("缺少密码导入加密 ZIP 必须失败")
        .to_string();
    assert!(
        error.contains("备份密码"),
        "缺少密码的拒绝必须提示提供备份密码，实际: {error}"
    );
}

/// 密码错误时导入必须失败，且错误信息可操作（提示密码错误或载荷损坏）。
#[test]
fn encrypted_zip_import_with_wrong_password_fails() {
    let (_source_guard, backup_dir, manifest) = create_full_backup();
    let export_root = TempDir::new().expect("export root");
    let zip_path = export_root.path().join("wrong-password.zip");
    export_backup_to_zip(
        &backup_dir.join(&manifest.backup_id),
        &ZipExportOptions {
            output_path: Some(zip_path.clone()),
            encryption_password: Some(ENCRYPTION_PASSWORD.to_string()),
            ..Default::default()
        },
    )
    .expect("加密导出应成功");

    let import_root = TempDir::new().expect("import root");
    let imported_dir = import_root.path().join("imported");
    let error = import_backup_from_zip_with_password(
        &zip_path,
        &imported_dir,
        Some("totally-wrong-password"),
    )
    .expect_err("错误密码导入必须失败")
    .to_string();
    assert!(
        error.contains("备份密码错误") || error.contains("解封"),
        "错误密码的拒绝必须可操作，实际: {error}"
    );
}

/// R04 错密码不改槽：错误密码导入失败后，目标数据槽必须保持原状；
/// 即使导入目录残留了外层密封产物，其清单也必须继续拒绝整槽恢复，
/// restore 门禁同样拒绝，且拒绝过程不得触碰数据槽。
///
/// 这是「错密码」与「改槽」之间的最后一道防线：解压发生在解封之前，
/// 密码错误时磁盘上可能已有外层条目，绝不允许这些半成品被当作可恢复
/// 备份写回数据槽。
#[test]
fn encrypted_zip_wrong_password_never_touches_target_slot() {
    let (_source_guard, backup_dir, manifest) = create_full_backup();
    let export_root = TempDir::new().expect("export root");
    let zip_path = export_root.path().join("wrong-password-slot-guard.zip");
    export_backup_to_zip(
        &backup_dir.join(&manifest.backup_id),
        &ZipExportOptions {
            output_path: Some(zip_path.clone()),
            encryption_password: Some(ENCRYPTION_PASSWORD.to_string()),
            ..Default::default()
        },
    )
    .expect("加密导出应成功");

    // 目标设备：数据槽内已有用户数据（哨兵值），错密码导入绝不能动它。
    let restore_root = TempDir::new().expect("restore root");
    let restore_slot = create_slot_with_databases(restore_root.path());
    let slot_databases = ["vfs.db", "chat_v2.db", "mistakes.db", "llm_usage.db"];
    for db in ["chat_v2.db", "mistakes.db", "llm_usage.db"] {
        let conn = Connection::open(restore_slot.join(db)).expect("open target db");
        conn.execute("UPDATE roundtrip_marker SET value = 'pre-restore-data'", [])
            .expect("seed pre-restore data");
    }
    let slot_hashes_before: Vec<String> = slot_databases
        .iter()
        .map(|db| {
            let path = if *db == "vfs.db" {
                restore_slot.join("databases").join(db)
            } else {
                restore_slot.join(db)
            };
            deep_student_lib::backup_common::calculate_file_hash(&path)
                .expect("hash slot db before import")
        })
        .collect();

    // ---------- 1. 错密码导入必须失败，且错误可操作 ----------
    let restore_backup_dir = restore_root.path().join("recovery").join("backups");
    let imported_dir = restore_backup_dir.join(&manifest.backup_id);
    std::fs::create_dir_all(&restore_backup_dir).expect("create restore backup dir");
    let import_error = import_backup_from_zip_with_password(
        &zip_path,
        &imported_dir,
        Some("totally-wrong-password"),
    )
    .expect_err("错误密码导入必须失败")
    .to_string();
    assert!(
        import_error.contains("备份密码错误") || import_error.contains("解封"),
        "错误密码的拒绝必须可操作，实际: {import_error}"
    );

    // ---------- 2. 残留的外层清单（若有）必须继续拒绝整槽恢复 ----------
    let leftover_manifest_path = imported_dir.join("manifest.json");
    if leftover_manifest_path.is_file() {
        let leftover = BackupManifest::load_from_file(&leftover_manifest_path)
            .expect("残留清单若存在必须可解析（否则无法诚实拒绝）");
        assert_eq!(
            leftover.key_policy,
            BackupKeyPolicy::IncludedEncrypted,
            "错密码解封失败后残留的只能是未解封的外层密封清单"
        );
        leftover
            .validate_for_slot_restore()
            .expect_err("未解封的密封清单不得通过整槽恢复验证");

        // 即使有人拿残留清单强行走 restore 门禁，也必须被拒绝。
        let mut restore_manager = BackupManager::new(restore_backup_dir.clone());
        restore_manager.set_app_data_dir(restore_slot.clone());
        restore_manager.set_app_version(env!("CARGO_PKG_VERSION").to_string());
        restore_manager
            .restore_with_assets(&leftover, false)
            .expect_err("错密码残留产物的整槽恢复必须显式拒绝");
    }

    // ---------- 3. 数据槽必须逐字节保持原状 ----------
    for (db, hash_before) in slot_databases.iter().zip(&slot_hashes_before) {
        let path = if *db == "vfs.db" {
            restore_slot.join("databases").join(db)
        } else {
            restore_slot.join(db)
        };
        let hash_after = deep_student_lib::backup_common::calculate_file_hash(&path)
            .expect("hash slot db after failed import");
        assert_eq!(
            &hash_after, hash_before,
            "错密码导入/恢复被拒后，数据槽 {db} 不得有任何字节变化"
        );
    }
    for db in ["chat_v2.db", "mistakes.db", "llm_usage.db"] {
        assert_eq!(
            read_marker(&restore_slot.join(db)).as_deref(),
            Some("pre-restore-data"),
            "错密码流程后 {db} 的用户数据必须原样保留"
        );
    }
}

/// 未加密便携 ZIP 的诚实分类：导入产物恒为 partial_archive，
/// validate 与 restore 都必须显式拒绝（锁定去除误导 disaster_recovery 标签）。
#[test]
fn unencrypted_portable_zip_is_honestly_partial() {
    let (_source_guard, backup_dir, manifest) = create_full_backup();
    let export_root = TempDir::new().expect("export root");
    let zip_path = export_root.path().join("portable.zip");
    export_backup_to_zip(
        &backup_dir.join(&manifest.backup_id),
        &ZipExportOptions {
            output_path: Some(zip_path.clone()),
            ..Default::default()
        },
    )
    .expect("未加密便携导出应成功");

    let import_root = TempDir::new().expect("import root");
    let imported_dir = import_root.path().join("backups").join(&manifest.backup_id);
    std::fs::create_dir_all(imported_dir.parent().unwrap()).expect("create import parent");
    import_backup_from_zip(&zip_path, &imported_dir).expect("导入未加密便携 ZIP 应成功");

    let imported_manifest = BackupManifest::load_from_file(&imported_dir.join("manifest.json"))
        .expect("导入清单可解析");
    assert_eq!(
        imported_manifest.key_policy,
        BackupKeyPolicy::ExcludedPortable
    );
    assert_eq!(
        imported_manifest.snapshot_kind,
        SnapshotKind::PartialOverlay
    );
    let classification_error = imported_manifest
        .validate_for_slot_restore()
        .expect_err("未加密便携 ZIP 不得通过整槽恢复验证（诚实分类）")
        .to_string();
    assert!(
        !classification_error.trim().is_empty(),
        "分类拒绝必须携带可操作错误信息"
    );

    let import_slot = create_slot_with_databases(import_root.path());
    let mut restore_manager = BackupManager::new(import_root.path().join("backups"));
    restore_manager.set_app_data_dir(import_slot);
    restore_manager.set_app_version(env!("CARGO_PKG_VERSION").to_string());
    restore_manager
        .restore_with_assets(&imported_manifest, false)
        .expect_err("未加密便携 ZIP 的整槽恢复必须显式拒绝");
}

fn zip_contains_sealed_secrets(zip_path: &Path) -> bool {
    let file = std::fs::File::open(zip_path).expect("open zip");
    let mut archive = zip::ZipArchive::new(file).expect("parse zip");
    (0..archive.len()).any(|index| {
        archive
            .by_index(index)
            .map(|entry| entry.name() == "portable_secrets.dsbk")
            .unwrap_or(false)
    })
}

/// 模拟旧版本已用短口令写出的同格式密封 ZIP：0824 导出端仍应拒绝新设短口令，
/// 因此测试先用合规口令生成生产 ZIP，再只把 DSBK 密封载荷换成短口令加密。
fn rewrap_sealed_payload_password(
    source_zip: &Path,
    target_zip: &Path,
    old_password: &str,
    new_password: &str,
) {
    let source = std::fs::File::open(source_zip).expect("open source sealed zip");
    let mut archive = zip::ZipArchive::new(source).expect("parse source sealed zip");
    let target = std::fs::File::create(target_zip).expect("create rewrapped zip");
    let mut writer = zip::ZipWriter::new(target);
    let scratch = TempDir::new().expect("rewrap scratch");

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).expect("read source zip entry");
        let name = entry.name().to_string();
        let options = zip::write::FileOptions::default().compression_method(entry.compression());
        if entry.is_dir() {
            writer
                .add_directory(name, options)
                .expect("copy zip directory");
            continue;
        }

        writer
            .start_file(&name, options)
            .expect("start copied zip file");
        if name != ENCRYPTED_SECRETS_ENTRY {
            std::io::copy(&mut entry, &mut writer).expect("copy regular zip entry");
            continue;
        }

        let old_payload = scratch.path().join("old.dsbk");
        let inner_plain = scratch.path().join("inner.zip");
        let new_payload = scratch.path().join("short-password.dsbk");
        let mut old_payload_file = std::fs::File::create(&old_payload).expect("create old payload");
        std::io::copy(&mut entry, &mut old_payload_file).expect("extract old payload");
        old_payload_file.flush().expect("flush old payload");
        deep_student_lib::crypto::backup_crypto::decrypt_backup_file(
            &old_payload,
            &inner_plain,
            old_password,
        )
        .expect("decrypt original payload");
        deep_student_lib::crypto::backup_crypto::encrypt_backup_file(
            &inner_plain,
            &new_payload,
            new_password,
        )
        .expect("encrypt payload with legacy short password");
        let mut new_payload_file =
            std::fs::File::open(new_payload).expect("open rewrapped payload");
        std::io::copy(&mut new_payload_file, &mut writer).expect("write rewrapped payload");
    }

    writer.finish().expect("finish rewrapped zip");
}

/// 解密兼容必须落到真实 DSBK + ZIP 解封链，而不只是移除前端文案/校验。
#[test]
fn encrypted_zip_import_really_accepts_a_legacy_short_password() {
    const LEGACY_SHORT_PASSWORD: &str = "short6";

    let (_source_guard, backup_dir, manifest) = create_full_backup();
    let export_root = TempDir::new().expect("export root");
    let current_zip = export_root.path().join("current-password.zip");
    export_backup_to_zip(
        &backup_dir.join(&manifest.backup_id),
        &ZipExportOptions {
            output_path: Some(current_zip.clone()),
            encryption_password: Some(ENCRYPTION_PASSWORD.to_string()),
            ..Default::default()
        },
    )
    .expect("create production sealed zip");

    let legacy_zip = export_root.path().join("legacy-short-password.zip");
    rewrap_sealed_payload_password(
        &current_zip,
        &legacy_zip,
        ENCRYPTION_PASSWORD,
        LEGACY_SHORT_PASSWORD,
    );
    assert!(
        zip_contains_encrypted_secrets(&legacy_zip).expect("peek legacy sealed zip"),
        "rewrapped fixture must retain portable_secrets.dsbk"
    );

    let resolved_password = resolve_import_zip_password(
        Some(LEGACY_SHORT_PASSWORD.to_string()),
        Some(false),
        None,
        true,
    )
    .expect("legacy short password must reach the unseal layer");
    let import_root = TempDir::new().expect("legacy short import root");
    let imported_dir = import_root.path().join("imported");
    import_backup_from_zip_with_password(&legacy_zip, &imported_dir, resolved_password.as_deref())
        .expect("real DSBK unseal must accept the legacy short password");

    let imported = BackupManifest::load_from_file(&imported_dir.join("manifest.json"))
        .expect("load unsealed manifest");
    imported
        .validate_for_slot_restore()
        .expect("short-password import must recover a restorable full snapshot");
}

/// stored-password 解析接到现有 ZIP 导出模式：未请求 stored→便携；开关无密码→拒绝；开关+stored→加密全保真；显式覆盖 stored。
#[test]
fn stored_password_resolution_selects_portable_or_encrypted_export() {
    let (_source_guard, backup_dir, manifest) = create_full_backup();
    let backup_subdir = backup_dir.join(&manifest.backup_id);
    let export_root = TempDir::new().expect("export root");

    assert!(
        resolve_zip_encryption_password(None, Some(true), None).is_err(),
        "开关打开但无密码必须 fail-closed，不得默默便携"
    );

    let portable_password =
        resolve_zip_encryption_password(None, Some(false), None).expect("未请求 stored 应保持便携");
    assert_eq!(portable_password, None, "未请求 stored 不得发明密码");
    let portable_zip = export_root.path().join("resolved-portable.zip");
    export_backup_to_zip(
        &backup_subdir,
        &ZipExportOptions {
            output_path: Some(portable_zip.clone()),
            encryption_password: portable_password,
            ..Default::default()
        },
    )
    .expect("未请求 stored 应走便携导出");
    assert!(
        !zip_contains_sealed_secrets(&portable_zip),
        "未请求 stored 不得写出 portable_secrets.dsbk"
    );
    assert!(
        !zip_contains_encrypted_secrets(&portable_zip).expect("peek portable zip"),
        "便携 ZIP peek 必须为 false"
    );
    assert_eq!(
        resolve_import_zip_password(
            None,
            Some(true),
            Some(ENCRYPTION_PASSWORD.to_string()),
            zip_contains_encrypted_secrets(&portable_zip).expect("peek portable zip")
        )
        .expect("便携导入应忽略 stored"),
        None,
        "便携云端包不得套用已存密码"
    );

    let stored_password =
        resolve_zip_encryption_password(None, Some(true), Some(ENCRYPTION_PASSWORD.to_string()))
            .expect("stored 应解析成功");
    assert_eq!(stored_password.as_deref(), Some(ENCRYPTION_PASSWORD));
    let stored_zip = export_root.path().join("resolved-stored.zip");
    export_backup_to_zip(
        &backup_subdir,
        &ZipExportOptions {
            output_path: Some(stored_zip.clone()),
            encryption_password: stored_password,
            ..Default::default()
        },
    )
    .expect("stored 密码且开关打开应走加密全保真");
    assert!(
        zip_contains_sealed_secrets(&stored_zip),
        "stored 密码导出必须包含 portable_secrets.dsbk"
    );

    assert!(
        zip_contains_encrypted_secrets(&stored_zip).expect("peek stored zip"),
        "加密全保真 ZIP peek 必须为 true"
    );
    assert_eq!(
        resolve_import_zip_password(
            None,
            Some(true),
            Some(ENCRYPTION_PASSWORD.to_string()),
            zip_contains_encrypted_secrets(&stored_zip).expect("peek stored zip")
        )
        .expect("密封导入应使用 stored")
        .as_deref(),
        Some(ENCRYPTION_PASSWORD)
    );

    const OVERRIDE_PASSWORD: &str = "explicit-override-pass";
    let explicit_password = resolve_zip_encryption_password(
        Some(OVERRIDE_PASSWORD.to_string()),
        Some(true),
        Some(ENCRYPTION_PASSWORD.to_string()),
    )
    .expect("显式密码应覆盖 stored");
    assert_eq!(explicit_password.as_deref(), Some(OVERRIDE_PASSWORD));
    let explicit_zip = export_root.path().join("resolved-explicit.zip");
    export_backup_to_zip(
        &backup_subdir,
        &ZipExportOptions {
            output_path: Some(explicit_zip.clone()),
            encryption_password: explicit_password,
            ..Default::default()
        },
    )
    .expect("显式密码覆盖 stored 后仍应走加密全保真");
    assert!(
        zip_contains_sealed_secrets(&explicit_zip),
        "显式密码导出必须包含 portable_secrets.dsbk"
    );

    let import_root = TempDir::new().expect("import override");
    let explicit_import_dir = import_root.path().join("explicit");
    import_backup_from_zip_with_password(
        &explicit_zip,
        &explicit_import_dir,
        Some(OVERRIDE_PASSWORD),
    )
    .expect("显式覆盖密码必须能解封");
    let stored_import_dir = import_root.path().join("stored-should-fail");
    import_backup_from_zip_with_password(
        &explicit_zip,
        &stored_import_dir,
        Some(ENCRYPTION_PASSWORD),
    )
    .expect_err("stored 密码不得解封被显式密码覆盖的 ZIP");
}
