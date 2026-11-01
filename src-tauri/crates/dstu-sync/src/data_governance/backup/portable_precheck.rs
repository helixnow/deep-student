//! [0824-W2R5] 便携/密封 ZIP 显式备份密码的导入前置检查（fail-fast）
//!
//! ## 动机
//!
//! 既有 [`super::zip_export`] 的 `precheck_sealed_payload_password` 只覆盖
//! 「密封包 + 缺密码」方向；**显式提供了密码**的两种失败形态此前都要等
//! 全量解压之后才在解封阶段（`unseal_encrypted_secrets`）被拒绝：
//!
//! 1. **便携包 + 显式密码**：外层没有 `portable_secrets.dsbk` 条目，解封层
//!    `(declared=false, present=false) + Some(password)` 分支必然报
//!    「该 ZIP 不是加密全保真备份」；
//! 2. **密封包 + 显式错密码**：解封层 AEAD 校验必然失败，报
//!    `E_BACKUP_SEALED_DECRYPT_FAILED`。
//!
//! 非续传命令路径失败后会整目录清理（commands_zip.rs 的 zip_import 失败
//! 分支），这两种形态都白白浪费一次全量解压 IO。本模块把检查前置到
//! **解压任何条目之前**（调用点位于 `precheck_sealed_payload_password`
//! 顶部，早于 `validate_import_target_root`，因此目标目录完全不被触碰）：
//!
//! - 形态 1：纯条目名判定（与 [`super::zip_export::zip_contains_encrypted_secrets`]
//!   同口径，不解密不解压），零成本，续传/非续传都启用；
//! - 形态 2：把密封条目单独取出到临时文件并**试解密**（Argon2id 派生 +
//!   AEAD 逐块校验，走公开的 `decrypt_backup_file` 审计路径，不复制任何
//!   加密实现细节），只在**非续传**路径启用。
//!
//! ## 为什么试解密只做非续传？
//!
//! - 非续传：失败后命令层整目录清理，错密码晚发现 = 一次全量解压 IO 报废；
//!   试解密把损失压缩为「一次 Argon2id + 一次载荷解密」。
//! - 续传：失败**不**清理目标目录，已解压的外层条目本身就是下次续传的
//!   进度（既有测试 `test_resumable_import_encrypted_zip_wrong_password_then_retry_with_correct`
//!   锚定了「错密码 → 外层条目保留 → 携正确密码重试时跳过已存在文件」的
//!   语义）；且续传每次重试都强制先付一次 Argon2id + 整载荷解密并不划算。
//!   错密码仍由解封层的 AEAD 校验拒绝，目标保持可续传。
//! - **Step 22 不受影响**：sealed 续传缺密码必须在改动目标目录之前失败的
//!   门禁完整保留在 `precheck_sealed_payload_password` 原有分支里——本模块
//!   在 `password.is_none()` 时原样放行、一行不改那条链路。
//!
//! ## 成本取舍（有意为之，如实声明）
//!
//! 非续传 + 正确密码的成功路径会多付一次 Argon2id 派生（默认参数约数百
//! 毫秒）与一次密封载荷解密（明文写入临时文件后立即丢弃，解封阶段仍会
//! 再解密一次）。密封载荷只含敏感材料（crypto/ 密钥、审计库、导出隔离
//! 域），体积远小于外层归档全量（聊天库、VFS、资产），这笔前置成本换来
//! 错密码时避免整包解压 + 整目录清理的往返。
//!
//! ## 错误契约
//!
//! 文案与稳定错误码与解封层完全一致，前端既有映射照常生效：
//! - 形态 1 复用解封层原话（无稳定码，历史如此）；
//! - 形态 2 携带 [`super::zip_export::SEALED_BACKUP_DECRYPT_FAILED_CODE`]，
//!   且措辞诚实覆盖「密码错误或载荷损坏」（AEAD 无法区分两者）。

use std::io::{Read, Seek};

use tracing::debug;

use super::zip_export::{
    ZipExportError, ENCRYPTED_SECRETS_ENTRY, SEALED_BACKUP_DECRYPT_FAILED_CODE,
};

/// 便携包（无密封载荷）收到显式备份密码时的拒绝文案。
///
/// 必须与 `unseal_encrypted_secrets` 的 `(false, false) + Some` 分支逐字
/// 一致：既有测试（如 `test_resumable_import_unencrypted_zip_rejects_password`）
/// 与调用方按「不是加密全保真备份」子串断言，前置化不得改变对外措辞。
pub(crate) const PORTABLE_ZIP_PASSWORD_NOT_NEEDED_MESSAGE: &str =
    "该 ZIP 不是加密全保真备份，无需提供备份密码；请去掉密码后重试导入";

/// 显式备份密码的导入前置检查（在解压任何条目之前调用）。
///
/// - `password = None`：立即放行——缺密码方向（含 Step 22 sealed 续传
///   必须输入密码）由 `precheck_sealed_payload_password` 的既有分支负责，
///   本函数不重复、不接管。
/// - `Some(password)` 且外层**没有** `portable_secrets.dsbk` 条目：便携包
///   收到密码，解封阶段必然拒绝 → 直接 fail-fast（续传/非续传都启用，
///   此判定只读条目名，零成本）。
/// - `Some(password)` 且外层**有**密封条目：
///   - 非续传（`resumable = false`）：把密封条目取到临时文件试解密；
///     错密码/载荷损坏在这里 fail-fast，不再先做全量解压。
///   - 续传（`resumable = true`）：跳过试解密，错密码留给解封层拒绝
///     （失败不清理目标，已解压条目是续传进度；语义与既有测试一致）。
pub(crate) fn precheck_explicit_import_password<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    password: Option<&str>,
    resumable: bool,
) -> Result<(), ZipExportError> {
    let Some(password) = password else {
        return Ok(());
    };
    let has_sealed_entry = archive
        .file_names()
        .any(|name| name == ENCRYPTED_SECRETS_ENTRY);
    if !has_sealed_entry {
        return Err(ZipExportError::ExportFailed(
            PORTABLE_ZIP_PASSWORD_NOT_NEEDED_MESSAGE.to_string(),
        ));
    }
    if resumable {
        return Ok(());
    }
    trial_decrypt_sealed_entry(archive, password)
}

/// 把密封载荷条目复制到临时文件并试解密，验证显式密码可用。
///
/// 全程不触碰导入目标目录：密文副本与解密输出都是 `NamedTempFile`，
/// 函数返回即删除。解密走 [`crate::crypto::backup_crypto::decrypt_backup_file`]
/// 公开审计路径（DSBK v1/v2 兼容、KDF 参数上限、逐块 AEAD 校验全部生效），
/// 本模块不复制任何容器布局或密钥派生逻辑。
///
/// 明文解密输出会短暂落入临时文件后立即丢弃——与解封层既有的
/// `inner_plain` 临时文件同一取向；成功后解封阶段会按原契约再次解密落盘。
fn trial_decrypt_sealed_entry<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    password: &str,
) -> Result<(), ZipExportError> {
    let mut entry = archive.by_name(ENCRYPTED_SECRETS_ENTRY)?;
    if entry.is_dir() {
        return Err(ZipExportError::ExportFailed(format!(
            "密封载荷必须是普通文件条目: {}",
            ENCRYPTED_SECRETS_ENTRY
        )));
    }
    let declared_size = entry.size();

    // 密文副本：条目以 Stored 方式写入外层，复制即解压。读取预算取
    // declared+1，与中央目录不一致的条目在这里被识破（外层归档策略
    // validate_import_archive 已在调用本函数之前跑过，此处是逐字节兜底）。
    let mut sealed_copy = tempfile::NamedTempFile::new()?;
    let mut limited = (&mut entry).take(declared_size.saturating_add(1));
    let copied = std::io::copy(&mut limited, sealed_copy.as_file_mut())?;
    if copied != declared_size {
        return Err(ZipExportError::ExportFailed(format!(
            "密封载荷实际大小与中央目录不一致: expected={}, actual={}",
            declared_size, copied
        )));
    }
    drop(entry);

    // 试解密到临时输出并立即丢弃。失败文案/稳定码与解封层逐字对齐，
    // AEAD 无法区分错密码与载荷损坏，措辞诚实覆盖两者。
    let plaintext_sink = tempfile::NamedTempFile::new()?;
    crate::crypto::backup_crypto::decrypt_backup_file(
        sealed_copy.path(),
        plaintext_sink.path(),
        password,
    )
    .map_err(|error| {
        ZipExportError::ExportFailed(format!(
            "[{}] 解封加密备份失败（备份密码错误或载荷损坏）: {}",
            SEALED_BACKUP_DECRYPT_FAILED_CODE, error
        ))
    })?;

    debug!(
        "备份密码前置校验通过：密封载荷（{} 字节密文）可解密，继续解压",
        declared_size
    );
    Ok(())
}

// ============================================================================
// 测试（[0824-W2R5] 只写不跑；运行由后续轮次统一执行）
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_governance::backup::zip_export::{
        export_backup_to_zip, import_backup_from_zip_with_password,
        import_backup_from_zip_with_progress, ZipExportOptions, ZipImportPhase,
    };
    use crate::data_governance::backup::{
        persistent_domain_registry, BackupFile, BackupManifest, CoverageStatus,
    };
    use rusqlite::Connection;
    use std::fs::File;
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use tempfile::TempDir;
    use zip::write::FileOptions;
    use zip::{CompressionMethod, ZipWriter};

    const TEST_PASSWORD: &str = "precheck-secret-1";

    fn open_archive(path: &Path) -> zip::ZipArchive<File> {
        zip::ZipArchive::new(File::open(path).unwrap()).unwrap()
    }

    /// 便携形态：无 `portable_secrets.dsbk` 条目的最小合成 ZIP。
    fn write_portable_zip(dir: &Path, file_name: &str) -> PathBuf {
        let path = dir.join(file_name);
        let mut writer = ZipWriter::new(File::create(&path).unwrap());
        let options = FileOptions::default().compression_method(CompressionMethod::Stored);
        writer.start_file("manifest.json", options).unwrap();
        writer.write_all(b"{}").unwrap();
        writer.start_file("vfs.db", options).unwrap();
        writer.write_all(b"synthetic-db-bytes").unwrap();
        writer.finish().unwrap();
        path
    }

    /// 密封形态：`portable_secrets.dsbk` = `encrypt_backup_file(payload, TEST_PASSWORD)`。
    fn write_sealed_zip(dir: &Path, file_name: &str, payload: &[u8]) -> PathBuf {
        let plain = dir.join(format!("{file_name}.plain"));
        std::fs::write(&plain, payload).unwrap();
        let encrypted = dir.join(format!("{file_name}.dsbk"));
        crate::crypto::backup_crypto::encrypt_backup_file(&plain, &encrypted, TEST_PASSWORD)
            .unwrap();

        let path = dir.join(file_name);
        let mut writer = ZipWriter::new(File::create(&path).unwrap());
        let options = FileOptions::default().compression_method(CompressionMethod::Stored);
        writer.start_file("manifest.json", options).unwrap();
        writer.write_all(b"{}").unwrap();
        writer.start_file(ENCRYPTED_SECRETS_ENTRY, options).unwrap();
        writer
            .write_all(&std::fs::read(&encrypted).unwrap())
            .unwrap();
        writer.finish().unwrap();
        path
    }

    /// 密封条目是无法解密的垃圾字节（模拟载荷损坏/被改写）。
    fn write_corrupted_sealed_zip(dir: &Path, file_name: &str) -> PathBuf {
        let path = dir.join(file_name);
        let mut writer = ZipWriter::new(File::create(&path).unwrap());
        let options = FileOptions::default().compression_method(CompressionMethod::Stored);
        writer.start_file("manifest.json", options).unwrap();
        writer.write_all(b"{}").unwrap();
        writer.start_file(ENCRYPTED_SECRETS_ENTRY, options).unwrap();
        writer.write_all(b"not-a-dsbk-container-at-all").unwrap();
        writer.finish().unwrap();
        path
    }

    // ---------------- 单元：precheck 判定矩阵 ----------------

    /// 缺密码方向必须原样放行：Step 22（sealed 续传必须输入密码）的门禁
    /// 保持在 `precheck_sealed_payload_password` 既有分支，本模块不得接管。
    #[test]
    fn no_password_is_left_to_existing_missing_password_gate() {
        let dir = TempDir::new().unwrap();
        let portable = write_portable_zip(dir.path(), "portable.zip");
        let sealed = write_sealed_zip(dir.path(), "sealed.zip", b"sealed-inner-payload");
        for path in [&portable, &sealed] {
            for resumable in [false, true] {
                let mut archive = open_archive(path);
                precheck_explicit_import_password(&mut archive, None, resumable).unwrap_or_else(
                    |error| {
                        panic!(
                            "password=None 必须放行给既有缺密码门禁 (resumable={}): {}",
                            resumable, error
                        )
                    },
                );
            }
        }
    }

    /// 便携包 + 显式密码：续传/非续传都在解压任何条目之前 fail-fast，
    /// 文案与解封层既有措辞逐字一致（既有测试按该子串断言）。
    #[test]
    fn explicit_password_on_portable_zip_fails_fast_in_both_modes() {
        let dir = TempDir::new().unwrap();
        let portable = write_portable_zip(dir.path(), "portable.zip");
        for resumable in [false, true] {
            let mut archive = open_archive(&portable);
            let error =
                precheck_explicit_import_password(&mut archive, Some(TEST_PASSWORD), resumable)
                    .unwrap_err();
            assert!(
                error.to_string().contains("不是加密全保真备份"),
                "resumable={} unexpected error: {}",
                resumable,
                error
            );
        }
    }

    /// 密封包 + 显式错密码（非续传）：试解密在前置阶段就拒绝，
    /// 携带稳定码且措辞与解封层一致。
    #[test]
    fn wrong_password_on_sealed_zip_fails_fast_without_resume() {
        let dir = TempDir::new().unwrap();
        let sealed = write_sealed_zip(dir.path(), "sealed.zip", b"sealed-inner-payload");
        let mut archive = open_archive(&sealed);
        let error = precheck_explicit_import_password(
            &mut archive,
            Some("definitely-wrong-password"),
            false,
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains(SEALED_BACKUP_DECRYPT_FAILED_CODE),
            "fail-fast 拒绝必须携带稳定码: {}",
            error
        );
        assert!(
            error.to_string().contains("解封加密备份失败"),
            "fail-fast 文案必须与解封层一致: {}",
            error
        );
    }

    /// 密封包 + 正确密码（非续传）：试解密通过，前置检查放行。
    #[test]
    fn correct_password_on_sealed_zip_passes_precheck() {
        let dir = TempDir::new().unwrap();
        let sealed = write_sealed_zip(dir.path(), "sealed.zip", b"sealed-inner-payload");
        let mut archive = open_archive(&sealed);
        precheck_explicit_import_password(&mut archive, Some(TEST_PASSWORD), false).unwrap();
    }

    /// 续传路径不做试解密：错密码留给解封层拒绝——失败不清理目标目录，
    /// 已解压条目是续传进度（语义由 zip_export.rs 的
    /// `test_resumable_import_encrypted_zip_wrong_password_then_retry_with_correct` 锚定）。
    #[test]
    fn resumable_sealed_zip_defers_wrong_password_to_unseal_layer() {
        let dir = TempDir::new().unwrap();
        let sealed = write_sealed_zip(dir.path(), "sealed.zip", b"sealed-inner-payload");
        let mut archive = open_archive(&sealed);
        precheck_explicit_import_password(&mut archive, Some("definitely-wrong-password"), true)
            .expect("续传路径必须跳过试解密，把错密码留给解封层");
    }

    /// 载荷损坏（非 DSBK 容器）+ 任意密码（非续传）：同样 fail-fast，
    /// 稳定码诚实覆盖「密码错误或载荷损坏」（AEAD 无法区分两者）。
    #[test]
    fn corrupted_sealed_payload_fails_fast_with_any_password() {
        let dir = TempDir::new().unwrap();
        let corrupted = write_corrupted_sealed_zip(dir.path(), "corrupted.zip");
        let mut archive = open_archive(&corrupted);
        let error = precheck_explicit_import_password(&mut archive, Some(TEST_PASSWORD), false)
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains(SEALED_BACKUP_DECRYPT_FAILED_CODE),
            "损坏载荷的拒绝必须携带稳定码: {}",
            error
        );
    }

    // ---------------- 端到端：经真实导出/导入链路 ----------------

    /// 与 zip_export.rs 测试同构的最小完整备份目录（四库 + 全覆盖 ledger）。
    fn create_test_backup_dir() -> TempDir {
        let dir = TempDir::new().unwrap();
        let backup_dir = dir.path();

        let mut manifest = BackupManifest::new("1.0.0-test");
        for database_id in ["vfs", "chat_v2", "mistakes", "llm_usage"] {
            let path = backup_dir.join(format!("{}.db", database_id));
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE test_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
                     INSERT INTO test_data(value) VALUES ('password-precheck-test');",
                )
                .unwrap();
            drop(connection);

            manifest.add_file(BackupFile {
                path: format!("{}.db", database_id),
                size: std::fs::metadata(&path).unwrap().len(),
                sha256: crate::backup_common::calculate_file_hash(&path).unwrap(),
                database_id: Some(database_id.to_string()),
            });
            manifest
                .record_coverage(
                    &format!("database:{}", database_id),
                    CoverageStatus::Complete,
                    vec![format!("{}.db", database_id)],
                    None,
                )
                .unwrap();
        }
        for domain in persistent_domain_registry()
            .into_iter()
            .filter(|domain| !domain.id.starts_with("database:"))
        {
            manifest
                .record_coverage(&domain.id, CoverageStatus::Absent, Vec::new(), None)
                .unwrap();
        }
        manifest.mark_full().unwrap();
        manifest
            .save_to_file(&backup_dir.join("manifest.json"))
            .unwrap();

        dir
    }

    /// 便携包 + 显式密码：非续传导入在创建/写入目标目录之前失败
    /// （旧行为是全量解压后才在解封阶段报错、随后命令层整目录清理）。
    #[test]
    fn import_portable_zip_with_explicit_password_fails_before_touching_target() {
        let backup_dir = create_test_backup_dir();
        let export_dir = TempDir::new().unwrap();
        let zip_path = export_dir.path().join("portable.zip");
        export_backup_to_zip(
            backup_dir.path(),
            &ZipExportOptions {
                output_path: Some(zip_path.clone()),
                ..Default::default()
            },
        )
        .unwrap();

        let import_dir = TempDir::new().unwrap();
        let target = import_dir.path().join("restored");
        let error = import_backup_from_zip_with_password(&zip_path, &target, Some(TEST_PASSWORD))
            .unwrap_err();

        assert!(
            error.to_string().contains("不是加密全保真备份"),
            "unexpected error: {}",
            error
        );
        assert!(
            !target.exists(),
            "便携包 + 显式密码必须在触碰目标目录之前 fail-fast"
        );
    }

    /// 密封包 + 显式错密码：非续传导入在创建/写入目标目录之前失败，
    /// 携带稳定码（旧行为：全量解压 → 解封阶段报错 → 命令层整目录清理）。
    #[test]
    fn import_sealed_zip_with_wrong_password_fails_before_touching_target() {
        let backup_dir = create_test_backup_dir();
        let export_dir = TempDir::new().unwrap();
        let zip_path = export_dir.path().join("sealed.zip");
        export_backup_to_zip(
            backup_dir.path(),
            &ZipExportOptions {
                output_path: Some(zip_path.clone()),
                encryption_password: Some(TEST_PASSWORD.to_string()),
                ..Default::default()
            },
        )
        .unwrap();

        let import_dir = TempDir::new().unwrap();
        let target = import_dir.path().join("restored");
        let error = import_backup_from_zip_with_password(
            &zip_path,
            &target,
            Some("definitely-wrong-password"),
        )
        .unwrap_err();

        assert!(
            error
                .to_string()
                .contains(SEALED_BACKUP_DECRYPT_FAILED_CODE),
            "错密码 fail-fast 必须携带稳定码: {}",
            error
        );
        assert!(
            error.to_string().contains("解封加密备份失败"),
            "错密码 fail-fast 文案必须与解封层一致: {}",
            error
        );
        assert!(
            !target.exists(),
            "密封包 + 错密码必须在触碰目标目录之前 fail-fast"
        );
    }

    /// 带进度的非续传导入：错密码时任何 Extract 阶段工作都不得发生
    /// （与既有缺密码测试同构，把「错密码」补进同一 fail-fast 断言面）。
    #[test]
    fn progress_import_sealed_zip_wrong_password_never_reaches_extract_phase() {
        let backup_dir = create_test_backup_dir();
        let export_dir = TempDir::new().unwrap();
        let zip_path = export_dir.path().join("sealed.zip");
        export_backup_to_zip(
            backup_dir.path(),
            &ZipExportOptions {
                output_path: Some(zip_path.clone()),
                encryption_password: Some(TEST_PASSWORD.to_string()),
                ..Default::default()
            },
        )
        .unwrap();

        let import_dir = TempDir::new().unwrap();
        let target = import_dir.path().join("restored");
        let mut saw_extract_phase = false;
        let error = import_backup_from_zip_with_progress(
            &zip_path,
            &target,
            |progress| {
                if progress.phase == ZipImportPhase::Extract {
                    saw_extract_phase = true;
                }
            },
            || false,
            Some("definitely-wrong-password"),
        )
        .unwrap_err();

        assert!(
            error
                .to_string()
                .contains(SEALED_BACKUP_DECRYPT_FAILED_CODE),
            "unexpected error: {}",
            error
        );
        assert!(
            !saw_extract_phase,
            "错密码前置检查必须先于任何 Extract 阶段工作"
        );
        assert!(!target.exists());
    }
}
