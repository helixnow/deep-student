//! DomainRestorePlan 消费：整槽恢复编排的域分发与未消费断言（P7）。
//!
//! 本模块把「看路径后缀/目录名」的第二套恢复规则替换为按
//! [`super::BackupManifest::domain_restore_plan`] 显式分发：
//!
//! - Data + ActiveDataSpace + 非数据库域（webview-settings /
//!   custom-grading-modes）：把 plan.files 拷贝到候选槽的 restore_target，
//!   不再被 `restore_non_database_manifest_files` 的 `persistent/` 跳过吞噬；
//! - audit（Explicit / ApplicationData）：走既有
//!   [`super::BackupManager::restore_audit_db_from_manifest`]（此前生产零调用）；
//! - crypto（Explicit / ApplicationData）：**不重复恢复**——主编排在切槽提交时
//!   已通过 `restore_crypto_keys_from_manifest_transactional` 事务消费，本模块
//!   只登记终态；
//! - UntrustedExecutable（agents / user-skills）：**禁止**写入正式
//!   restore_target（`workspaces/agents`、`~/.deep-student/skills`），完整拷入
//!   候选槽内的隔离目录 [`RESTORE_PENDING_TRUST_DIR_NAME`]`/<domain_id>/`，终态
//!   `IsolatedPendingTrust`；
//! - Absent / Empty / Excluded：对应 `SkippedAbsent` / `SkippedExcluded`，
//!   不算未消费；
//! - 核心库 / workspaces / 资产根（主编排既有路径恢复）：按 plan 逐文件验证
//!   产物已存在于候选槽后登记 `Restored`，缺失即 fail-closed。
//!
//! 成功前必须通过 [`assert_no_unconsumed_complete_domains`]：coverage ledger
//! 中任何 status == Complete 的域没有被消费登记，恢复任务不得宣告成功
//! （稳定码 `E_RESTORE_DOMAIN_UNCONSUMED`）。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

use super::{
    archive_path_requires_explicit_trust, calculate_file_sha256_exact, persistent_domain_registry,
    prepare_backup_restore_destination, resolve_existing_backup_file, validate_safe_relative_path,
    BackupError, BackupManager, BackupManifest, CoverageStatus, DomainRestoreFile,
    DomainRestorePlan, PersistentDomainSpec, RestoreScope, RestoreTrustPolicy,
};
use crate::data_governance::restore_codes::{
    tagged_message, RESTORE_DOMAIN_FAILED_CODE, RESTORE_DOMAIN_UNCONSUMED_CODE,
    RESTORE_UNTRUSTED_ISOLATED_CODE,
};

/// 候选槽内隔离待信任内容的目录名（`<slot>/.restore_pending_trust/<domain_id>/`）。
///
/// 隔离目录保留归档内的原始相对路径，供后续显式信任决定按 plan 激活；
/// 前缀 `.` 保证不会与任何持久域的 restore_target 冲突。目录名与 R3
/// 恢复矩阵测试（tests/restore_domain_plan_tests.rs）的契约一致。
pub const RESTORE_PENDING_TRUST_DIR_NAME: &str = ".restore_pending_trust";

/// 一个持久域在整槽恢复中的终态。
///
/// 序列化为 snake_case（`restored` / `merged` / `isolated_pending_trust` /
/// `failed` / `skipped_absent` / `skipped_excluded`），随恢复任务结果与审计
/// 日志 details 一起对前端可见。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DomainRestoreOutcome {
    /// 域内容已恢复到其 restore_target（或已由主编排/事务路径恢复并验证）。
    Restored,
    /// 域内容与既有数据合并（保留给增量/合并型消费方，当前编排未使用）。
    Merged,
    /// UntrustedExecutable 域已完整落盘到隔离目录，等待显式信任决定。
    IsolatedPendingTrust,
    /// 域消费失败或无人消费；任何 Failed 报告都禁止恢复任务成功。
    Failed,
    /// 备份声明该域 Absent/Empty，无内容可恢复（不算未消费）。
    SkippedAbsent,
    /// 备份显式排除该域（不算未消费；Full 快照入场校验不含 Excluded 域）。
    SkippedExcluded,
}

/// 恢复编排侧使用的别名：报告字段名为 `state`，与 outcome 枚举同义。
pub type DomainRestoreOutcomeState = DomainRestoreOutcome;

impl DomainRestoreOutcome {
    /// 该终态是否算作「已被消费」（Restored / Merged / IsolatedPendingTrust）。
    pub fn is_consumed(self) -> bool {
        matches!(
            self,
            DomainRestoreOutcome::Restored
                | DomainRestoreOutcome::Merged
                | DomainRestoreOutcome::IsolatedPendingTrust
        )
    }
}

/// 单个持久域的消费报告。`consume_complete_domains` 对 coverage ledger 中
/// 每个有记录的域产生一条（Complete 域必有），供审计 details 与
/// [`assert_no_unconsumed_complete_domains`] 使用。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainRestoreReport {
    /// 持久域 id（`persistent_domain_registry` 中的 id）。
    pub domain_id: String,
    /// 域终态。
    pub state: DomainRestoreOutcome,
    /// 实际落盘/验证的文件数。
    pub restored_files: usize,
    /// 实际落盘/验证的字节数。
    pub restored_bytes: u64,
    /// 写入目标（槽内相对路径；隔离域为隔离目录相对路径）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// 稳定码：`E_RESTORE_DOMAIN_FAILED` / `E_RESTORE_DOMAIN_UNCONSUMED` /
    /// `E_RESTORE_UNTRUSTED_ISOLATED`（隔离态为信息性稳定码，非错误）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// 人类可读说明（失败时以 `[稳定码] 说明` 形式携带稳定码）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl DomainRestoreReport {
    fn skipped(domain_id: &str, state: DomainRestoreOutcome, detail: String) -> Self {
        Self {
            domain_id: domain_id.to_string(),
            state,
            restored_files: 0,
            restored_bytes: 0,
            target: None,
            code: None,
            detail: Some(detail),
        }
    }

    fn failed(domain_id: &str, code: &str, detail: String) -> Self {
        Self {
            domain_id: domain_id.to_string(),
            state: DomainRestoreOutcome::Failed,
            restored_files: 0,
            restored_bytes: 0,
            target: None,
            code: Some(code.to_string()),
            detail: Some(detail),
        }
    }
}

/// 核心库 / 工作区库 / 资产根由主编排的专用路径恢复；本模块对它们只做
/// 「产物已在候选槽」的存在性验证，不重复拷贝。
fn domain_consumed_by_primary_orchestration(spec: &PersistentDomainSpec) -> bool {
    spec.id.starts_with("database:")
        || spec.id == "workspaces-root"
        || spec.id.starts_with("asset-root:")
}

/// 把 Data 域的归档路径映射为槽内相对路径：archive_root 前缀替换为
/// restore_target（如 `persistent/webview_settings.json` → `webview_settings.json`）。
fn data_domain_slot_relative_path(
    spec: &PersistentDomainSpec,
    archive_path: &str,
) -> Result<PathBuf, BackupError> {
    let relative = if archive_path == spec.archive_root {
        PathBuf::from(&spec.restore_target)
    } else if let Some(suffix) = archive_path
        .strip_prefix(&spec.archive_root)
        .and_then(|suffix| suffix.strip_prefix('/'))
    {
        Path::new(&spec.restore_target).join(suffix)
    } else {
        return Err(BackupError::Manifest(format!(
            "持久域 {} 的恢复计划包含越界归档路径: {}",
            spec.id, archive_path
        )));
    };
    validate_safe_relative_path(&relative)?;
    Ok(relative)
}

/// 主编排恢复产物在槽内的相对路径：
/// - `database:*` → 注册表 restore_target（如 `databases/vfs.db`）；
/// - `workspaces-root` → 归档路径本身（`workspaces/ws_*.db`）；
/// - `asset-root:*` → manifest.assets 中该文件的 original_path，退化为
///   去掉 `assets/` 前缀的归档路径。
fn primary_slot_relative_path(
    spec: &PersistentDomainSpec,
    manifest: &BackupManifest,
    archive_path: &str,
) -> Result<PathBuf, BackupError> {
    let relative = if spec.id.starts_with("database:") {
        PathBuf::from(&spec.restore_target)
    } else if spec.id == "workspaces-root" {
        PathBuf::from(archive_path)
    } else {
        manifest
            .assets
            .as_ref()
            .and_then(|assets| {
                assets
                    .files
                    .iter()
                    .find(|asset| asset.relative_path == archive_path && !asset.is_directory)
            })
            .map(|asset| PathBuf::from(&asset.original_path))
            .unwrap_or_else(|| {
                PathBuf::from(archive_path.strip_prefix("assets/").unwrap_or(archive_path))
            })
    };
    validate_safe_relative_path(&relative)?;
    Ok(relative)
}

/// 拷贝后逐文件验证大小与 SHA-256（plan 元数据来自已通过整体校验的清单）。
fn verify_restored_domain_file(
    domain_id: &str,
    file: &DomainRestoreFile,
    destination: &Path,
) -> Result<(), BackupError> {
    let restored_size = fs::metadata(destination)?.len();
    if restored_size != file.size {
        return Err(BackupError::RestoreFailed(format!(
            "域 {} 文件恢复后大小不匹配 {}: expected={}, actual={}",
            domain_id, file.path, file.size, restored_size
        )));
    }
    if let Some(expected) = &file.sha256 {
        let actual = calculate_file_sha256_exact(destination, file.size)?;
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(BackupError::RestoreFailed(format!(
                "域 {} 文件恢复后 SHA-256 不匹配: {}",
                domain_id, file.path
            )));
        }
    }
    Ok(())
}

impl BackupManager {
    /// 遍历 [`persistent_domain_registry`]，按每个域的
    /// [`DomainRestorePlan`] 显式分发恢复，对 coverage ledger 中有记录的
    /// 每个域产生一条 [`DomainRestoreReport`]（Complete 域必有一条）。
    ///
    /// 调用契约（整槽恢复编排）：
    /// - 在核心库 / 工作区库 / 资产恢复与 crypto 事务发布**之后**调用——
    ///   这些域由本函数验证产物存在性（crypto 只登记，不触盘）；
    /// - `target_dir` 为候选（非活跃）槽目录；audit 是唯一例外，按其
    ///   ApplicationData scope 写入应用数据目录（切槽登记已过不可回退点）；
    /// - UntrustedExecutable 域绝不写入正式 restore_target，只落
    ///   `<target_dir>/.restore_pending_trust/<domain_id>/`；
    /// - 单个域执行失败被登记为 `Failed` 报告（携带稳定码），不会中断其余
    ///   域的消费；调用方必须对任何 `Failed` 报告拒绝宣告任务成功。
    pub fn consume_complete_domains(
        &self,
        manifest: &BackupManifest,
        backup_subdir: &Path,
        target_dir: &Path,
    ) -> Result<Vec<DomainRestoreReport>, BackupError> {
        let mut reports = Vec::new();
        for spec in persistent_domain_registry() {
            // 无 coverage 记录（legacy 清单）的域没有可证明的恢复计划；
            // 整槽恢复入场校验已拒绝 legacy，这里保持防御性跳过。
            let Some(plan) = manifest.domain_restore_plan(&spec.id) else {
                continue;
            };
            let report = match plan.status {
                CoverageStatus::Absent | CoverageStatus::Empty => DomainRestoreReport::skipped(
                    &spec.id,
                    DomainRestoreOutcome::SkippedAbsent,
                    format!("备份声明该域为 {:?}，无内容可恢复", plan.status),
                ),
                CoverageStatus::Excluded => DomainRestoreReport::skipped(
                    &spec.id,
                    DomainRestoreOutcome::SkippedExcluded,
                    "备份显式排除该域（Excluded）".to_string(),
                ),
                CoverageStatus::Failed => DomainRestoreReport::failed(
                    &spec.id,
                    RESTORE_DOMAIN_FAILED_CODE,
                    tagged_message(
                        RESTORE_DOMAIN_FAILED_CODE,
                        format!("域 {} 的备份侧覆盖证据为 Failed，不可恢复", spec.id),
                    ),
                ),
                CoverageStatus::Complete => match self.consume_one_complete_domain(
                    &spec,
                    &plan,
                    manifest,
                    backup_subdir,
                    target_dir,
                ) {
                    Ok(report) => report,
                    Err(error) => {
                        warn!("[Restore] 持久域 {} 消费失败: {}", spec.id, error);
                        DomainRestoreReport::failed(
                            &spec.id,
                            RESTORE_DOMAIN_FAILED_CODE,
                            tagged_message(
                                RESTORE_DOMAIN_FAILED_CODE,
                                format!("域 {} 消费失败: {}", spec.id, error),
                            ),
                        )
                    }
                },
            };
            reports.push(report);
        }
        Ok(reports)
    }

    fn consume_one_complete_domain(
        &self,
        spec: &PersistentDomainSpec,
        plan: &DomainRestorePlan,
        manifest: &BackupManifest,
        backup_subdir: &Path,
        target_dir: &Path,
    ) -> Result<DomainRestoreReport, BackupError> {
        if plan.files.len() != plan.archive_paths.len() {
            return Err(BackupError::Manifest(format!(
                "域 {} 的恢复计划文件元数据不完整: files={}, archive_paths={}",
                spec.id,
                plan.files.len(),
                plan.archive_paths.len()
            )));
        }
        // UntrustedExecutable 优先于任何其他分派（agents 也匹配资产前缀）。
        if spec.restore_trust == RestoreTrustPolicy::UntrustedExecutable {
            return self.isolate_untrusted_domain(spec, plan, backup_subdir, target_dir);
        }
        if spec.id == "crypto" {
            // 主编排已在切槽提交时通过
            // restore_crypto_keys_from_manifest_transactional 消费该 plan
            // （发布失败任务早已终止，控制流到不了这里）；绝不重复触盘。
            return Ok(DomainRestoreReport {
                domain_id: spec.id.clone(),
                state: DomainRestoreOutcome::Restored,
                restored_files: plan.file_count,
                restored_bytes: plan.total_size,
                target: None,
                code: None,
                detail: Some(
                    "已由事务性密钥发布路径消费（密钥发布与切槽登记原子提交），本路径不重复写入"
                        .to_string(),
                ),
            });
        }
        if spec.id == "audit" {
            return self.consume_audit_domain(spec, plan, manifest, backup_subdir);
        }
        if domain_consumed_by_primary_orchestration(spec) {
            return Self::verify_primary_orchestration_domain(spec, plan, manifest, target_dir);
        }
        if spec.restore_trust == RestoreTrustPolicy::Data
            && spec.restore_scope == RestoreScope::ActiveDataSpace
        {
            return self.restore_data_domain_to_slot(spec, plan, backup_subdir, target_dir);
        }
        // 注册表新增域若没有对应消费路径，fail-closed 而不是静默吞掉。
        Ok(DomainRestoreReport::failed(
            &spec.id,
            RESTORE_DOMAIN_UNCONSUMED_CODE,
            tagged_message(
                RESTORE_DOMAIN_UNCONSUMED_CODE,
                format!(
                    "Complete 域 {} 没有已注册的消费路径（scope={:?}, trust={:?}）",
                    spec.id, spec.restore_scope, spec.restore_trust
                ),
            ),
        ))
    }

    /// Data + ActiveDataSpace + 非数据库域：把 plan.files 拷贝到候选槽的
    /// restore_target 并逐文件校验（webview-settings / custom-grading-modes）。
    fn restore_data_domain_to_slot(
        &self,
        spec: &PersistentDomainSpec,
        plan: &DomainRestorePlan,
        backup_subdir: &Path,
        target_dir: &Path,
    ) -> Result<DomainRestoreReport, BackupError> {
        let mut restored_bytes = 0u64;
        for file in &plan.files {
            if archive_path_requires_explicit_trust(&file.path) {
                return Err(BackupError::Manifest(format!(
                    "Data 域 {} 的恢复计划引用需显式信任的可执行路径: {}",
                    spec.id, file.path
                )));
            }
            let relative_target = data_domain_slot_relative_path(spec, &file.path)?;
            let source = resolve_existing_backup_file(backup_subdir, Path::new(&file.path))?;
            let destination = prepare_backup_restore_destination(target_dir, &relative_target)?;
            fs::copy(&source, &destination)?;
            verify_restored_domain_file(&spec.id, file, &destination)?;
            restored_bytes += file.size;
        }
        info!(
            "[Restore] 已按 DomainRestorePlan 恢复域 {}: {} 个文件 -> {}",
            spec.id,
            plan.files.len(),
            target_dir.join(&spec.restore_target).display()
        );
        Ok(DomainRestoreReport {
            domain_id: spec.id.clone(),
            state: DomainRestoreOutcome::Restored,
            restored_files: plan.files.len(),
            restored_bytes,
            target: Some(spec.restore_target.clone()),
            code: None,
            detail: None,
        })
    }

    /// audit 域：走既有的 manifest 感知恢复入口（SHA-256 校验后按
    /// ApplicationData scope 恢复 `databases/audit.db`）。
    fn consume_audit_domain(
        &self,
        spec: &PersistentDomainSpec,
        plan: &DomainRestorePlan,
        manifest: &BackupManifest,
        backup_subdir: &Path,
    ) -> Result<DomainRestoreReport, BackupError> {
        let restored = self.restore_audit_db_from_manifest(manifest, backup_subdir)?;
        if !restored {
            // plan.status == Complete 时该入口要么恢复要么报错；防御性兜底。
            return Err(BackupError::RestoreFailed(
                "audit 域声明 Complete 但恢复入口未落盘任何文件".to_string(),
            ));
        }
        Ok(DomainRestoreReport {
            domain_id: spec.id.clone(),
            state: DomainRestoreOutcome::Restored,
            restored_files: plan.files.len(),
            restored_bytes: plan.total_size,
            target: Some(spec.restore_target.clone()),
            code: None,
            detail: Some("经 restore_audit_db_from_manifest 恢复到应用数据目录".to_string()),
        })
    }

    /// UntrustedExecutable 域（agents / user-skills）：完整拷入候选槽内的
    /// 隔离目录（保留归档相对路径），绝不写入正式 restore_target，也绝不
    /// 触碰 UserHome。
    fn isolate_untrusted_domain(
        &self,
        spec: &PersistentDomainSpec,
        plan: &DomainRestorePlan,
        backup_subdir: &Path,
        target_dir: &Path,
    ) -> Result<DomainRestoreReport, BackupError> {
        let quarantine_relative = Path::new(RESTORE_PENDING_TRUST_DIR_NAME).join(&spec.id);
        let mut restored_bytes = 0u64;
        for file in &plan.files {
            let source = resolve_existing_backup_file(backup_subdir, Path::new(&file.path))?;
            let destination_relative = quarantine_relative.join(&file.path);
            let destination =
                prepare_backup_restore_destination(target_dir, &destination_relative)?;
            fs::copy(&source, &destination)?;
            verify_restored_domain_file(&spec.id, file, &destination)?;
            restored_bytes += file.size;
        }
        let quarantine_display = quarantine_relative.to_string_lossy().replace('\\', "/");
        info!(
            "[Restore] 已隔离待信任域 {}: {} 个文件 -> {}（未写入 {}）",
            spec.id,
            plan.files.len(),
            target_dir.join(&quarantine_relative).display(),
            spec.restore_target
        );
        Ok(DomainRestoreReport {
            domain_id: spec.id.clone(),
            state: DomainRestoreOutcome::IsolatedPendingTrust,
            restored_files: plan.files.len(),
            restored_bytes,
            target: Some(quarantine_display),
            code: Some(RESTORE_UNTRUSTED_ISOLATED_CODE.to_string()),
            detail: Some(format!(
                "可执行内容已完整隔离，等待显式信任决定后才可落地到 {}",
                spec.restore_target
            )),
        })
    }

    /// 核心库 / 工作区库 / 资产根：主编排的专用路径已恢复，这里按 plan 逐
    /// 文件验证产物存在于候选槽（缺失即未消费，fail-closed）。归属
    /// UntrustedExecutable 域的重叠路径（agents 资产同时出现在
    /// asset-root:workspaces 的 coverage 中）被刻意排除——它们由隔离路径
    /// 处置，不应出现在槽内。
    fn verify_primary_orchestration_domain(
        spec: &PersistentDomainSpec,
        plan: &DomainRestorePlan,
        manifest: &BackupManifest,
        target_dir: &Path,
    ) -> Result<DomainRestoreReport, BackupError> {
        let mut verified_files = 0usize;
        let mut verified_bytes = 0u64;
        let mut isolated_overlap = 0usize;
        let mut missing: Vec<String> = Vec::new();
        for file in &plan.files {
            if archive_path_requires_explicit_trust(&file.path) {
                isolated_overlap += 1;
                continue;
            }
            let relative = primary_slot_relative_path(spec, manifest, &file.path)?;
            match fs::symlink_metadata(target_dir.join(&relative)) {
                Ok(metadata) if metadata.is_file() => {
                    verified_files += 1;
                    verified_bytes += file.size;
                }
                _ => missing.push(relative.to_string_lossy().replace('\\', "/")),
            }
        }
        if !missing.is_empty() {
            return Ok(DomainRestoreReport::failed(
                &spec.id,
                RESTORE_DOMAIN_UNCONSUMED_CODE,
                tagged_message(
                    RESTORE_DOMAIN_UNCONSUMED_CODE,
                    format!(
                        "域 {} 声明 Complete，但候选槽缺少 {} 个文件（如 {}）",
                        spec.id,
                        missing.len(),
                        missing[0]
                    ),
                ),
            ));
        }
        let detail = if isolated_overlap > 0 {
            format!(
                "由主编排恢复并已验证存在性；{} 个待信任可执行文件由隔离路径处置",
                isolated_overlap
            )
        } else {
            "由主编排恢复并已验证存在性".to_string()
        };
        Ok(DomainRestoreReport {
            domain_id: spec.id.clone(),
            state: DomainRestoreOutcome::Restored,
            restored_files: verified_files,
            restored_bytes: verified_bytes,
            target: Some(spec.restore_target.clone()),
            code: None,
            detail: Some(detail),
        })
    }
}

/// 成功前的未消费断言：coverage ledger 中每个 status == Complete 的域必须
/// 出现在 `consumed_domain_ids`（主编排专用路径 + `consume_complete_domains`
/// 报告的并集）中，否则以稳定码 `E_RESTORE_DOMAIN_UNCONSUMED` 拒绝，禁止
/// 恢复任务宣告成功。
pub fn assert_no_unconsumed_complete_domains(
    manifest: &BackupManifest,
    consumed_domain_ids: &[String],
) -> Result<(), BackupError> {
    let coverage = manifest.coverage.as_ref().ok_or_else(|| {
        BackupError::RestoreFailed(tagged_message(
            RESTORE_DOMAIN_UNCONSUMED_CODE,
            "备份缺少 coverage ledger，无法证明 Complete 域均被消费",
        ))
    })?;
    let unconsumed: Vec<&str> = coverage
        .domains
        .iter()
        .filter(|(domain_id, evidence)| {
            evidence.status == CoverageStatus::Complete
                && !consumed_domain_ids
                    .iter()
                    .any(|consumed| consumed == *domain_id)
        })
        .map(|(domain_id, _)| domain_id.as_str())
        .collect();
    if unconsumed.is_empty() {
        return Ok(());
    }
    Err(BackupError::RestoreFailed(tagged_message(
        RESTORE_DOMAIN_UNCONSUMED_CODE,
        format!(
            "Complete 持久域未被任何恢复路径消费: {}",
            unconsumed.join(", ")
        ),
    )))
}

#[cfg(test)]
mod tests {
    use super::super::tests::setup_test_env;
    use super::super::{calculate_file_sha256, BackupFile};
    use super::*;
    use tempfile::TempDir;

    /// 模拟主编排的核心库恢复：把归档中的数据库文件放到候选槽的
    /// restore_target（consume_complete_domains 对这些域只做存在性验证）。
    fn simulate_primary_database_restore(backup_subdir: &Path, target_dir: &Path) {
        for spec in persistent_domain_registry() {
            if !spec.id.starts_with("database:") {
                continue;
            }
            let source = backup_subdir.join(&spec.archive_root);
            let destination = target_dir.join(&spec.restore_target);
            fs::create_dir_all(destination.parent().unwrap()).unwrap();
            fs::copy(&source, &destination).unwrap();
        }
    }

    #[test]
    fn consume_restores_persistent_settings_and_reports_every_ledger_domain() {
        let (manager, _backup_dir, app_data_dir) = setup_test_env();
        let active_dir = app_data_dir.path().join("slots").join("slotA");
        fs::write(
            active_dir.join("webview_settings.json"),
            br#"{"theme":"dark"}"#,
        )
        .unwrap();
        fs::write(
            active_dir.join("custom_grading_modes.json"),
            br#"{"modes":[]}"#,
        )
        .unwrap();

        let manifest = manager.backup_with_assets(None).unwrap();
        let backup_subdir = manager.backup_dir().join(&manifest.backup_id);
        let target = TempDir::new().unwrap();
        simulate_primary_database_restore(&backup_subdir, target.path());

        let reports = manager
            .consume_complete_domains(&manifest, &backup_subdir, target.path())
            .unwrap();

        // coverage ledger 中每个域都有一条报告。
        let ledger = manifest.coverage.as_ref().unwrap();
        for domain_id in ledger.domains.keys() {
            assert!(
                reports.iter().any(|report| &report.domain_id == domain_id),
                "missing report for domain {}",
                domain_id
            );
        }

        // webview-settings / custom-grading-modes 不再被 persistent/ 跳过吞噬。
        for (domain_id, target_name, expected) in [
            (
                "webview-settings",
                "webview_settings.json",
                br#"{"theme":"dark"}"#.as_slice(),
            ),
            (
                "custom-grading-modes",
                "custom_grading_modes.json",
                br#"{"modes":[]}"#.as_slice(),
            ),
        ] {
            let report = reports
                .iter()
                .find(|report| report.domain_id == domain_id)
                .unwrap();
            assert_eq!(report.state, DomainRestoreOutcome::Restored);
            assert_eq!(report.restored_files, 1);
            let restored = fs::read(target.path().join(target_name)).unwrap();
            assert_eq!(restored, expected);
        }

        // 主编排恢复的核心库被验证为 Restored；Absent 域是 SkippedAbsent。
        let vfs = reports
            .iter()
            .find(|report| report.domain_id == "database:vfs")
            .unwrap();
        assert_eq!(vfs.state, DomainRestoreOutcome::Restored);
        let workspaces = reports
            .iter()
            .find(|report| report.domain_id == "workspaces-root")
            .unwrap();
        assert_eq!(workspaces.state, DomainRestoreOutcome::SkippedAbsent);
        assert!(reports
            .iter()
            .all(|report| report.state != DomainRestoreOutcome::Failed));

        // 报告的域 id 集合能通过未消费断言。
        let consumed: Vec<String> = reports
            .iter()
            .map(|report| report.domain_id.clone())
            .collect();
        assert_no_unconsumed_complete_domains(&manifest, &consumed).unwrap();
    }

    #[test]
    fn untrusted_user_skills_are_quarantined_not_written_to_restore_target() {
        let (manager, _backup_dir, app_data_dir) = setup_test_env();
        let mut manifest = manager.backup_with_assets(None).unwrap();
        let backup_subdir = manager.backup_dir().join(&manifest.backup_id);

        // 向归档注入一个 Complete 的 user-skills 域。
        let skill_relative = "persistent/user_skills/demo/SKILL.md";
        let skill_source = backup_subdir.join(skill_relative);
        fs::create_dir_all(skill_source.parent().unwrap()).unwrap();
        fs::write(&skill_source, b"# demo skill\nrm -rf nothing\n").unwrap();
        manifest.add_file(BackupFile {
            path: skill_relative.to_string(),
            size: fs::metadata(&skill_source).unwrap().len(),
            sha256: calculate_file_sha256(&skill_source).unwrap(),
            database_id: None,
        });
        manifest
            .record_coverage(
                "user-skills",
                CoverageStatus::Complete,
                vec![skill_relative.to_string()],
                None,
            )
            .unwrap();

        let target = TempDir::new().unwrap();
        simulate_primary_database_restore(&backup_subdir, target.path());
        let reports = manager
            .consume_complete_domains(&manifest, &backup_subdir, target.path())
            .unwrap();

        let skills = reports
            .iter()
            .find(|report| report.domain_id == "user-skills")
            .unwrap();
        assert_eq!(skills.state, DomainRestoreOutcome::IsolatedPendingTrust);
        assert_eq!(
            skills.code.as_deref(),
            Some(RESTORE_UNTRUSTED_ISOLATED_CODE)
        );
        assert!(skills.state.is_consumed());

        // 载荷完整落盘在隔离目录，且保留归档相对路径。
        let quarantined = target
            .path()
            .join(RESTORE_PENDING_TRUST_DIR_NAME)
            .join("user-skills")
            .join(skill_relative);
        assert_eq!(
            fs::read(&quarantined).unwrap(),
            b"# demo skill\nrm -rf nothing\n"
        );
        // 正式 restore_target 未被触碰（候选槽内没有 persistent/，也没有
        // 任何 skills 目录）。
        assert!(!target.path().join("persistent").exists());
        assert!(!target.path().join(".deep-student").exists());
        assert!(!target.path().join("skills").exists());
    }

    #[test]
    fn unconsumed_complete_domain_fails_with_stable_code() {
        let (manager, _backup_dir, _app_data_dir) = setup_test_env();
        let manifest = manager.backup_with_assets(None).unwrap();

        let mut consumed: Vec<String> = manifest
            .coverage
            .as_ref()
            .unwrap()
            .domains
            .iter()
            .filter(|(_, evidence)| evidence.status == CoverageStatus::Complete)
            .map(|(domain_id, _)| domain_id.clone())
            .collect();
        assert_no_unconsumed_complete_domains(&manifest, &consumed).unwrap();

        let dropped = consumed.pop().unwrap();
        let error = assert_no_unconsumed_complete_domains(&manifest, &consumed)
            .expect_err("dropping a complete domain must fail the assertion");
        let message = format!("{}", error);
        assert!(message.contains(RESTORE_DOMAIN_UNCONSUMED_CODE));
        assert!(message.contains(&dropped));
    }

    #[test]
    fn primary_domain_missing_from_slot_is_reported_unconsumed() {
        let (manager, _backup_dir, _app_data_dir) = setup_test_env();
        let manifest = manager.backup_with_assets(None).unwrap();
        let backup_subdir = manager.backup_dir().join(&manifest.backup_id);

        // 不模拟主编排恢复：候选槽为空，核心库域必须报 Failed（未消费码）。
        let target = TempDir::new().unwrap();
        let reports = manager
            .consume_complete_domains(&manifest, &backup_subdir, target.path())
            .unwrap();
        let vfs = reports
            .iter()
            .find(|report| report.domain_id == "database:vfs")
            .unwrap();
        assert_eq!(vfs.state, DomainRestoreOutcome::Failed);
        assert_eq!(vfs.code.as_deref(), Some(RESTORE_DOMAIN_UNCONSUMED_CODE));
        assert!(vfs
            .detail
            .as_deref()
            .unwrap()
            .contains(RESTORE_DOMAIN_UNCONSUMED_CODE));
    }
}
