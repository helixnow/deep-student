//! 恢复流程全局密钥发布的持久化 journal 与启动侧恢复。
//!
//! 恢复切槽把备份中的 `.master_key`/`.secure` 发布到应用根目录，并在同一
//! 事务内登记 restore cutover lease。发布涉及多次 rename 与一次 state 落盘，
//! 进程若在中间崩溃，磁盘上会留下「活跃槽仍旧库 + 全局密钥已换」或
//! 「根目录暂时无密钥」的撕裂状态。本模块在发布前写入 fsync 的 journal
//! （记录旧密钥是否存在、将安装哪些文件、对应的 backup/target slot），
//! 使下次启动可以确定性地收敛：
//!
//! - lease 已持久化且与 journal 匹配 → 发布视为已提交，前滚清理回滚目录；
//! - lease 缺失 → 发布未提交，把旧密钥从固定回滚目录还原回根目录；
//! - lease 存在但与 journal 不匹配 → 状态不可判定，fail-close 拒绝启动。
//!
//! journal 与回滚目录都放在应用根目录下的固定路径，与密钥同一文件系统，
//! rename 保持原子。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

pub const CRYPTO_PUBLICATION_JOURNAL_FILE: &str = ".crypto_restore_journal.json";
pub const CRYPTO_PUBLICATION_ROLLBACK_DIR: &str = ".crypto_restore_rollback";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CryptoPublicationJournal {
    pub version: u32,
    /// 切槽恢复流程填写；启动侧据此与 restore cutover lease 匹配判定前滚。
    /// 非切槽调用方（如 pre-restore 密钥回滚）为 `None`，崩溃后一律回滚。
    pub backup_id: Option<String>,
    pub target_slot: Option<String>,
    /// 发布前应用根目录是否已有旧 `.master_key` / `.secure`。
    pub had_old_master: bool,
    pub had_old_secure: bool,
    /// 本次发布计划安装的内容。
    pub installs_master: bool,
    pub installs_secure: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CryptoPublicationRecovery {
    /// 没有未决的密钥发布事务。
    Clean,
    /// lease 已持久化，发布视为已提交，仅清理回滚目录与 journal。
    RolledForward,
    /// 发布未提交，已把全局密钥还原到发布前状态。
    RolledBack,
}

pub fn journal_path(app_data_root: &Path) -> PathBuf {
    app_data_root.join(CRYPTO_PUBLICATION_JOURNAL_FILE)
}

pub fn rollback_dir(app_data_root: &Path) -> PathBuf {
    app_data_root.join(CRYPTO_PUBLICATION_ROLLBACK_DIR)
}

pub(crate) fn sync_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        fs::File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

fn remove_path_if_exists(path: &Path) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_dir() {
                fs::remove_dir_all(path)
            } else {
                fs::remove_file(path)
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// 原子写入 journal：同目录临时文件 fsync 后 persist，再 fsync 目录。
pub fn write_journal(
    app_data_root: &Path,
    journal: &CryptoPublicationJournal,
) -> std::io::Result<()> {
    use std::io::Write;

    fs::create_dir_all(app_data_root)?;
    let bytes = serde_json::to_vec_pretty(journal).map_err(|error| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("序列化密钥发布 journal 失败: {error}"),
        )
    })?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".crypto-journal-")
        .suffix(".tmp")
        .tempfile_in(app_data_root)?;
    temporary.write_all(&bytes)?;
    temporary.as_file().sync_all()?;
    temporary
        .into_temp_path()
        .persist(journal_path(app_data_root))
        .map_err(|error| error.error)?;
    sync_directory(app_data_root)
}

pub fn remove_journal(app_data_root: &Path) -> std::io::Result<()> {
    match fs::remove_file(journal_path(app_data_root)) {
        Ok(()) => sync_directory(app_data_root),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// 启动时收敛未决的密钥发布事务。
///
/// `active_lease` 是当前持久化的 restore cutover lease `(backup_id, target_slot)`；
/// 调用方需已确认 lease 与活跃槽一致（不一致时应在调用前 fail-close）。
pub fn recover_crypto_publication(
    app_data_root: &Path,
    active_lease: Option<(&str, &str)>,
) -> std::io::Result<CryptoPublicationRecovery> {
    let journal_file = journal_path(app_data_root);
    let rollback = rollback_dir(app_data_root);
    let journal_bytes = match fs::read(&journal_file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // 没有未决事务；无 journal 的回滚目录来自已解决的发布，仅作清理。
            remove_path_if_exists(&rollback)?;
            return Ok(CryptoPublicationRecovery::Clean);
        }
        Err(error) => return Err(error),
    };
    let journal: CryptoPublicationJournal =
        serde_json::from_slice(&journal_bytes).map_err(|error| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("密钥发布 journal 损坏，拒绝在不确定密钥状态上启动: {error}"),
            )
        })?;

    let journal_cutover = journal
        .backup_id
        .as_deref()
        .zip(journal.target_slot.as_deref());
    match (journal_cutover, active_lease) {
        (Some((journal_backup, journal_slot)), Some((lease_backup, lease_slot)))
            if journal_backup == lease_backup && journal_slot == lease_slot =>
        {
            // 切槽 lease 已持久化：密钥发布视为已提交，前滚清理。
            remove_path_if_exists(&rollback)?;
            remove_journal(app_data_root)?;
            info!("[CryptoPublication] 检测到已提交的密钥发布 journal，已前滚清理");
            return Ok(CryptoPublicationRecovery::RolledForward);
        }
        (_, Some((lease_backup, lease_slot))) => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "密钥发布 journal 与恢复维护租约不匹配（lease backup={lease_backup}, target={lease_slot}），拒绝自动修复"
                ),
            ));
        }
        _ => {}
    }

    rollback_entry(
        app_data_root,
        &rollback,
        ".master_key",
        journal.had_old_master,
        journal.installs_master,
        false,
    )?;
    rollback_entry(
        app_data_root,
        &rollback,
        ".secure",
        journal.had_old_secure,
        journal.installs_secure,
        true,
    )?;
    remove_path_if_exists(&rollback)?;
    sync_directory(app_data_root)?;
    remove_journal(app_data_root)?;
    warn!("[CryptoPublication] 检测到未提交的密钥发布 journal，已回滚到发布前的全局密钥");
    Ok(CryptoPublicationRecovery::RolledBack)
}

fn rollback_entry(
    app_data_root: &Path,
    rollback: &Path,
    name: &str,
    had_old: bool,
    installs: bool,
    is_dir: bool,
) -> std::io::Result<()> {
    let target = app_data_root.join(name);
    let saved = rollback.join(name);
    if fs::symlink_metadata(&saved).is_ok() {
        // 旧文件已被移入回滚目录：目标上无论是新密钥还是空缺都还原为旧文件。
        remove_path_if_exists(&target)?;
        fs::rename(&saved, &target)?;
        restore_permissions(&target, is_dir);
        return Ok(());
    }
    if !had_old && installs {
        // 发布前目标不存在：目前存在的只可能是未提交的新文件。
        remove_path_if_exists(&target)?;
    }
    // had_old 且回滚目录中缺失：旧文件从未被移出，目标保持原样。
    Ok(())
}

fn restore_permissions(path: &Path, is_dir: bool) {
    crate::secure_store::SecureStore::restrict_permissions(path, is_dir);
    if is_dir {
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    crate::secure_store::SecureStore::restrict_permissions(&entry.path(), false);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn cutover_journal(had_old: bool) -> CryptoPublicationJournal {
        CryptoPublicationJournal {
            version: 1,
            backup_id: Some("backup-1".to_string()),
            target_slot: Some("slotB".to_string()),
            had_old_master: had_old,
            had_old_secure: had_old,
            installs_master: true,
            installs_secure: true,
            created_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    fn seed_torn_publication(root: &Path, had_old: bool) {
        let rollback = rollback_dir(root);
        fs::create_dir_all(&rollback).unwrap();
        if had_old {
            fs::write(rollback.join(".master_key"), b"old-master").unwrap();
            let old_secure = rollback.join(".secure");
            fs::create_dir_all(&old_secure).unwrap();
            fs::write(old_secure.join(".key_seed"), b"old-seed").unwrap();
            fs::write(old_secure.join("old.enc"), b"old-credential").unwrap();
        }
        fs::write(root.join(".master_key"), b"new-master").unwrap();
        let new_secure = root.join(".secure");
        fs::create_dir_all(&new_secure).unwrap();
        fs::write(new_secure.join(".key_seed"), b"new-seed").unwrap();
        write_journal(root, &cutover_journal(had_old)).unwrap();
    }

    #[test]
    fn recover_without_journal_is_clean_and_sweeps_stale_rollback() {
        let root = TempDir::new().unwrap();
        fs::create_dir_all(rollback_dir(root.path())).unwrap();
        fs::write(rollback_dir(root.path()).join(".master_key"), b"stale").unwrap();

        let outcome = recover_crypto_publication(root.path(), None).unwrap();

        assert_eq!(outcome, CryptoPublicationRecovery::Clean);
        assert!(!rollback_dir(root.path()).exists());
    }

    #[test]
    fn uncommitted_publication_rolls_back_previous_keys() {
        let root = TempDir::new().unwrap();
        seed_torn_publication(root.path(), true);

        let outcome = recover_crypto_publication(root.path(), None).unwrap();

        assert_eq!(outcome, CryptoPublicationRecovery::RolledBack);
        assert_eq!(
            fs::read(root.path().join(".master_key")).unwrap(),
            b"old-master"
        );
        assert_eq!(
            fs::read(root.path().join(".secure/.key_seed")).unwrap(),
            b"old-seed"
        );
        assert_eq!(
            fs::read(root.path().join(".secure/old.enc")).unwrap(),
            b"old-credential"
        );
        assert!(!journal_path(root.path()).exists());
        assert!(!rollback_dir(root.path()).exists());
    }

    #[test]
    fn uncommitted_publication_removes_new_keys_when_no_previous_generation() {
        let root = TempDir::new().unwrap();
        seed_torn_publication(root.path(), false);

        let outcome = recover_crypto_publication(root.path(), None).unwrap();

        assert_eq!(outcome, CryptoPublicationRecovery::RolledBack);
        assert!(!root.path().join(".master_key").exists());
        assert!(!root.path().join(".secure").exists());
        assert!(!journal_path(root.path()).exists());
        assert!(!rollback_dir(root.path()).exists());
    }

    #[test]
    fn crash_before_moving_old_keys_leaves_target_untouched() {
        let root = TempDir::new().unwrap();
        // journal 已写入但 rename 尚未开始：目标仍是旧密钥，回滚目录为空。
        fs::write(root.path().join(".master_key"), b"old-master").unwrap();
        let old_secure = root.path().join(".secure");
        fs::create_dir_all(&old_secure).unwrap();
        fs::write(old_secure.join(".key_seed"), b"old-seed").unwrap();
        fs::create_dir_all(rollback_dir(root.path())).unwrap();
        write_journal(root.path(), &cutover_journal(true)).unwrap();

        let outcome = recover_crypto_publication(root.path(), None).unwrap();

        assert_eq!(outcome, CryptoPublicationRecovery::RolledBack);
        assert_eq!(
            fs::read(root.path().join(".master_key")).unwrap(),
            b"old-master"
        );
        assert_eq!(
            fs::read(root.path().join(".secure/.key_seed")).unwrap(),
            b"old-seed"
        );
        assert!(!journal_path(root.path()).exists());
    }

    #[test]
    fn committed_publication_rolls_forward_and_keeps_new_keys() {
        let root = TempDir::new().unwrap();
        seed_torn_publication(root.path(), true);

        let outcome =
            recover_crypto_publication(root.path(), Some(("backup-1", "slotB"))).unwrap();

        assert_eq!(outcome, CryptoPublicationRecovery::RolledForward);
        assert_eq!(
            fs::read(root.path().join(".master_key")).unwrap(),
            b"new-master"
        );
        assert_eq!(
            fs::read(root.path().join(".secure/.key_seed")).unwrap(),
            b"new-seed"
        );
        assert!(!journal_path(root.path()).exists());
        assert!(!rollback_dir(root.path()).exists());
    }

    #[test]
    fn mismatched_lease_fails_closed() {
        let root = TempDir::new().unwrap();
        seed_torn_publication(root.path(), true);

        let error = recover_crypto_publication(root.path(), Some(("other-backup", "slotA")))
            .expect_err("mismatched lease must not be auto-repaired");

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert!(journal_path(root.path()).exists());
    }

    #[test]
    fn corrupted_journal_fails_closed() {
        let root = TempDir::new().unwrap();
        fs::write(journal_path(root.path()), b"not-json").unwrap();

        let error = recover_crypto_publication(root.path(), None)
            .expect_err("corrupted journal must not be auto-repaired");

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }
}
