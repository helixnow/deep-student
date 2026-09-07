//! G07-a：candidate_complete + TaskFinalizer 骨架
//!
//! 把「Agent 结束说话」与「任务验收完成」分离：
//! - `attempt_completion` 工具调用只代表模型**申报**任务完成
//!   （candidate complete），不再等同于任务验收通过；
//! - [`TaskFinalizer`] 在工具循环终止前对任务产物做确定性核查，产出
//!   [`FinalizationVerdict`] 终态，写入完成块 `toolOutput.finalization`。
//!
//! ## 骨架版范围
//! - 实装检查器：[`ArtifactsExistCheck`]——核对模型显式申报的产物文件在
//!   对应 runtime root 下真实存在、申报了 sha256 的内容哈希匹配；
//! - 兼容语义：未申报 artifacts 且任务上下文无产物要求时直接
//!   [`FinalizationVerdict::VerifiedComplete`]——纯解释性回答的默认路径
//!   与现状行为完全一致（零行为变化）；
//! - 预留注册位：`BatchCoverage`（批处理覆盖率，接 session ledger /
//!   task_audit 清单）与 `SideEffectsSettled`（副作用落账，接
//!   workspace_change_set 账本）在后续阶段以 [`TaskFinalizer::with_check`]
//!   注册进同一 finalize 流程。
//!
//! 验收结论只写进完成块 toolOutput（骨架版不落新表、不做数据库迁移）。

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use super::context::PipelineContext;
use super::database::ChatV2Database;
use super::repo::ChatV2Repo;
use super::runtime_roots;
use super::types::{MessageBlock, ToolResultInfo};
use crate::database::Database;

/// 产物申报的缺省 runtime root（会话级 artifacts root）
pub const DEFAULT_ARTIFACT_ROOT_ID: &str = "artifacts";

// ============================================================================
// 验收终态与报告
// ============================================================================

/// 任务验收终态
///
/// 与「模型说了完成」正交：verdict 只由后端确定性核查产生。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinalizationVerdict {
    /// 所有已执行检查通过：申报产物全部存在且哈希匹配（或任务本无产物要求）
    VerifiedComplete,
    /// 任务完成但存在例外项（如产物存在但哈希与申报不符）
    CompleteWithExceptions,
    /// 部分完成：申报的产物缺失 / 申报本身非法
    Partial,
    /// 验收受阻：检查器已运行但无法完成核查（root 未配置 / IO 失败）
    Blocked,
    /// 无法判定：验收基础设施缺失（如无 AppHandle / 主库，检查器无法运行）
    OutcomeUnknown,
}

/// 验收例外类别
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExceptionKind {
    /// 申报的产物在对应 runtime root 下不存在
    ArtifactMissing,
    /// 产物存在但 SHA-256 与申报不符
    HashMismatch,
    /// 申报本身非法（绝对路径 / 父目录逃逸 / 空路径 / 非普通文件）
    InvalidDeclaration,
    /// 检查器无法完成核查（root 解析失败 / IO 错误）
    CheckUnavailable,
}

/// 单条验收例外
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FinalizationException {
    /// 产生该例外的检查器 id（如 `artifacts_exist`）
    pub check: String,
    pub kind: ExceptionKind,
    /// 相关产物路径（如适用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// 人类可读原因
    pub message: String,
}

/// 验收报告——写入完成块 `toolOutput.finalization`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FinalizationReport {
    pub verdict: FinalizationVerdict,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exceptions: Vec<FinalizationException>,
    /// 实际执行的检查器 id 列表
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checks_run: Vec<String>,
}

// ============================================================================
// 产物申报与定位
// ============================================================================

/// 模型经 `attempt_completion` 显式申报的产物
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeclaredArtifact {
    /// 产物相对路径（相对对应 runtime root；拒绝绝对路径与 `..`）
    pub path: String,
    /// 可选：产物内容 SHA-256（hex，大小写不敏感）；申报即校验
    #[serde(default)]
    pub sha256: Option<String>,
    /// 可选：产物所在 runtime root（默认 `artifacts`；
    /// 可选值同 runtime_roots：workspace / temp / authorized_* / skill:*）
    #[serde(default)]
    pub root_id: Option<String>,
}

/// 产物定位结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtifactResolution {
    /// 文件真实存在（路径已 canonicalize、已验证不逃逸 root）
    Found(PathBuf),
    /// 申报路径合法但文件不存在
    Missing(PathBuf),
    /// 路径存在但不是常规文件（目录 / 符号链接）
    NotAFile(PathBuf),
}

/// 产物定位器：把 `(root_id, 相对路径)` 解析为宿主文件系统定位。
///
/// 生产实现 = [`RuntimeRootLocator`]（复用 runtime_roots 设施）；测试可用
/// 单目录实现。只读语义：实现方**不得**为核查创建目录或文件。
pub trait ArtifactLocator: Send + Sync {
    fn resolve(
        &self,
        root_id: Option<&str>,
        relative: &Path,
    ) -> Result<ArtifactResolution, String>;
}

/// 在已解析的 root 目录下定位产物（生产 locator 与测试共享的实现）
fn resolve_under_root(root_path: &Path, relative: &Path) -> Result<ArtifactResolution, String> {
    let candidate = root_path.join(relative);
    let metadata = match fs::symlink_metadata(&candidate) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(ArtifactResolution::Missing(candidate));
        }
        Err(error) => {
            return Err(format!(
                "failed to inspect artifact '{}': {}",
                candidate.display(),
                error
            ));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(ArtifactResolution::NotAFile(candidate));
    }
    // 防逃逸：canonicalize 后必须仍在 root 内
    let root_canon = root_path
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize runtime root: {}", error))?;
    let candidate_canon = candidate
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize artifact: {}", error))?;
    if !candidate_canon.starts_with(&root_canon) {
        return Err(format!(
            "artifact '{}' escapes its runtime root",
            candidate.display()
        ));
    }
    Ok(ArtifactResolution::Found(candidate_canon))
}

/// 生产定位器：经 `runtime_roots::runtime_root_by_id` 解析 root 后定位
/// （与 office_output / attachment_stage_executor 同一套 root 设施）。
pub struct RuntimeRootLocator<'a> {
    pub app: &'a AppHandle,
    pub database: &'a Database,
    pub session_id: &'a str,
    pub skill_package_roots: Option<&'a HashMap<String, String>>,
}

impl ArtifactLocator for RuntimeRootLocator<'_> {
    fn resolve(
        &self,
        root_id: Option<&str>,
        relative: &Path,
    ) -> Result<ArtifactResolution, String> {
        let root = runtime_roots::runtime_root_by_id(
            self.app,
            self.database,
            self.session_id,
            self.skill_package_roots,
            Some(root_id.unwrap_or(DEFAULT_ARTIFACT_ROOT_ID)),
            false, // 验收只读：不为核查创建 session root
        )?;
        resolve_under_root(&root.path, relative)
    }
}

fn sha256_file_hex(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("failed to open artifact '{}': {}", path.display(), error))?;
    let mut hasher = Sha256::new();
    io::copy(&mut file, &mut hasher)
        .map_err(|error| format!("failed to read artifact '{}': {}", path.display(), error))?;
    Ok(hex::encode(hasher.finalize()))
}

// ============================================================================
// 验收检查器
// ============================================================================

/// 检查器运行状态
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckStatus {
    /// 检查完整执行（例外与否看 exceptions）
    Ran,
    /// 检查因基础设施缺失根本无法运行（如 locator 不可用）
    Unavailable,
}

/// 单个检查器的运行结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckOutcome {
    pub status: CheckStatus,
    pub exceptions: Vec<FinalizationException>,
}

impl CheckOutcome {
    fn ran(exceptions: Vec<FinalizationException>) -> Self {
        Self {
            status: CheckStatus::Ran,
            exceptions,
        }
    }

    fn unavailable(check: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: CheckStatus::Unavailable,
            exceptions: vec![FinalizationException {
                check: check.to_string(),
                kind: ExceptionKind::CheckUnavailable,
                path: None,
                message: message.into(),
            }],
        }
    }
}

/// 验收上下文：检查器所需的只读事实
pub struct FinalizationContext<'a> {
    pub session_id: &'a str,
    /// 模型显式申报的产物清单
    pub declared_artifacts: &'a [DeclaredArtifact],
    /// 任务上下文是否要求产物。
    /// 骨架版恒为 false；后续阶段从 role_pack verification gates /
    /// todo 清单 / task_audit 清单推断。
    pub artifacts_required: bool,
    /// 产物定位器；None = 验收基础设施缺失（检查器报 Unavailable）
    pub locator: Option<&'a dyn ArtifactLocator>,
}

/// 验收检查器接口（G07 后续阶段接账本的扩展点）
pub trait AcceptanceCheck: Send + Sync {
    /// 稳定检查器 id（写入例外与报告 checks_run）
    fn id(&self) -> &'static str;
    fn run(&self, ctx: &FinalizationContext) -> CheckOutcome;
}

/// ArtifactsExist：核对申报产物真实存在、申报哈希匹配
pub struct ArtifactsExistCheck;

impl AcceptanceCheck for ArtifactsExistCheck {
    fn id(&self) -> &'static str {
        "artifacts_exist"
    }

    fn run(&self, ctx: &FinalizationContext) -> CheckOutcome {
        let Some(locator) = ctx.locator else {
            return CheckOutcome::unavailable(
                self.id(),
                "artifact locator unavailable (no app handle / main database); \
                 cannot verify declared artifacts",
            );
        };

        let mut exceptions = Vec::new();

        // 任务要求产物但模型未申报（骨架版 artifacts_required 恒 false，
        // 此分支为后续阶段语义补全）
        if ctx.declared_artifacts.is_empty() && ctx.artifacts_required {
            exceptions.push(FinalizationException {
                check: self.id().to_string(),
                kind: ExceptionKind::ArtifactMissing,
                path: None,
                message: "task context requires artifacts but none were declared".to_string(),
            });
        }

        for artifact in ctx.declared_artifacts {
            let raw_path = artifact.path.trim();
            let relative =
                match runtime_roots::normalize_runtime_relative_path(Some(raw_path)) {
                    Ok(relative) if !relative.as_os_str().is_empty() => relative,
                    _ => {
                        exceptions.push(FinalizationException {
                            check: self.id().to_string(),
                            kind: ExceptionKind::InvalidDeclaration,
                            path: Some(artifact.path.clone()),
                            message: "declared artifact path must be a non-empty relative \
                                 path without parent traversal"
                                .to_string(),
                        });
                        continue;
                    }
                };

            match locator.resolve(artifact.root_id.as_deref(), &relative) {
                Ok(ArtifactResolution::Found(path)) => {
                    if let Some(declared_sha) = artifact.sha256.as_deref() {
                        match sha256_file_hex(&path) {
                            Ok(actual) if actual.eq_ignore_ascii_case(declared_sha.trim()) => {}
                            Ok(actual) => {
                                exceptions.push(FinalizationException {
                                    check: self.id().to_string(),
                                    kind: ExceptionKind::HashMismatch,
                                    path: Some(artifact.path.clone()),
                                    message: format!(
                                        "artifact sha256 mismatch: declared {}, actual {}",
                                        declared_sha, actual
                                    ),
                                });
                            }
                            Err(error) => {
                                exceptions.push(FinalizationException {
                                    check: self.id().to_string(),
                                    kind: ExceptionKind::CheckUnavailable,
                                    path: Some(artifact.path.clone()),
                                    message: error,
                                });
                            }
                        }
                    }
                }
                Ok(ArtifactResolution::Missing(_)) => {
                    exceptions.push(FinalizationException {
                        check: self.id().to_string(),
                        kind: ExceptionKind::ArtifactMissing,
                        path: Some(artifact.path.clone()),
                        message: format!(
                            "declared artifact does not exist under root '{}'",
                            artifact.root_id.as_deref().unwrap_or(DEFAULT_ARTIFACT_ROOT_ID)
                        ),
                    });
                }
                Ok(ArtifactResolution::NotAFile(_)) => {
                    exceptions.push(FinalizationException {
                        check: self.id().to_string(),
                        kind: ExceptionKind::InvalidDeclaration,
                        path: Some(artifact.path.clone()),
                        message: "declared artifact path exists but is not a regular file"
                            .to_string(),
                    });
                }
                Err(error) => {
                    exceptions.push(FinalizationException {
                        check: self.id().to_string(),
                        kind: ExceptionKind::CheckUnavailable,
                        path: Some(artifact.path.clone()),
                        message: error,
                    });
                }
            }
        }

        CheckOutcome::ran(exceptions)
    }
}

// ============================================================================
// TaskFinalizer
// ============================================================================

/// 任务验收器：汇总已注册检查器的结果，推导验收终态。
pub struct TaskFinalizer {
    checks: Vec<Box<dyn AcceptanceCheck>>,
}

impl TaskFinalizer {
    /// 骨架版检查器注册表：仅实装 ArtifactsExist。
    ///
    /// 后续阶段预留（接入后以 `with_check(...)` 注册）：
    /// - `BatchCoverageCheck`：对照 session ledger / task_audit 清单核对
    ///   批处理覆盖率（role_packs 的 source_evidence_complete /
    ///   delivery_manifest_reconciled 门）；
    /// - `SideEffectsSettledCheck`：对照 workspace_change_set 账本核对
    ///   副作用全部落账（change receipts / rollback 状态）。
    pub fn skeleton() -> Self {
        Self {
            checks: vec![Box::new(ArtifactsExistCheck)],
        }
    }

    /// 注册额外检查器（后续阶段扩展点）
    pub fn with_check(mut self, check: impl AcceptanceCheck + 'static) -> Self {
        self.checks.push(Box::new(check));
        self
    }

    /// 执行验收。
    ///
    /// 兼容语义：未申报产物且任务上下文无产物要求 → 直接
    /// [`FinalizationVerdict::VerifiedComplete`]，不运行任何检查器
    /// （纯解释性回答的默认路径零行为变化）。
    pub fn finalize(&self, ctx: &FinalizationContext) -> FinalizationReport {
        if ctx.declared_artifacts.is_empty() && !ctx.artifacts_required {
            return FinalizationReport {
                verdict: FinalizationVerdict::VerifiedComplete,
                exceptions: Vec::new(),
                checks_run: Vec::new(),
            };
        }

        let mut exceptions = Vec::new();
        let mut checks_run = Vec::new();
        let mut any_unavailable = false;
        for check in &self.checks {
            checks_run.push(check.id().to_string());
            let outcome = check.run(ctx);
            if outcome.status == CheckStatus::Unavailable {
                any_unavailable = true;
            }
            exceptions.extend(outcome.exceptions);
        }

        FinalizationReport {
            verdict: derive_verdict(&exceptions, any_unavailable),
            exceptions,
            checks_run,
        }
    }
}

impl Default for TaskFinalizer {
    fn default() -> Self {
        Self::skeleton()
    }
}

/// 终态推导优先级：
/// 检查器根本无法运行 → OutcomeUnknown；
/// 核查受阻（root / IO） → Blocked；
/// 产物缺失 / 申报非法 → Partial；
/// 仅剩哈希不符 → CompleteWithExceptions；
/// 无例外 → VerifiedComplete。
fn derive_verdict(
    exceptions: &[FinalizationException],
    any_check_unavailable: bool,
) -> FinalizationVerdict {
    if any_check_unavailable {
        return FinalizationVerdict::OutcomeUnknown;
    }
    if exceptions.is_empty() {
        return FinalizationVerdict::VerifiedComplete;
    }
    if exceptions
        .iter()
        .any(|e| e.kind == ExceptionKind::CheckUnavailable)
    {
        return FinalizationVerdict::Blocked;
    }
    if exceptions.iter().any(|e| {
        matches!(
            e.kind,
            ExceptionKind::ArtifactMissing | ExceptionKind::InvalidDeclaration
        )
    }) {
        return FinalizationVerdict::Partial;
    }
    FinalizationVerdict::CompleteWithExceptions
}

// ============================================================================
// tool_loop 接线（G07-a）
// ============================================================================

/// 从 `attempt_completion` 工具入参解析申报产物。
pub fn parse_declared_artifacts(input: &Value) -> Result<Vec<DeclaredArtifact>, String> {
    match input.get("artifacts") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(value) => serde_json::from_value(value.clone())
            .map_err(|error| format!("invalid artifacts declaration: {}", error)),
    }
}

/// tool_loop 接线点：检测到 `task_completed` 后、终止工具循环前调用。
///
/// 对完成块做骨架验收并把终态写入完成块 `toolOutput.finalization`
/// （内存块 + tool_results + 立即落库；末轮 save_results 以同内容覆盖）。
///
/// 验收器自身任何失败只降级为 warn log——绝不能搞挂主循环终止路径。
pub(crate) fn finalize_task_completion(
    ctx: &mut PipelineContext,
    db: &ChatV2Database,
    main_db: Option<&Arc<Database>>,
) {
    match try_finalize_task_completion(ctx, db, main_db) {
        Ok(Some(report)) => {
            log::info!(
                "[Finalizer] G07-a task finalization: verdict={:?}, exceptions={}, session={}",
                report.verdict,
                report.exceptions.len(),
                ctx.session_id
            );
        }
        Ok(None) => {}
        Err(error) => {
            log::warn!(
                "[Finalizer] G07-a finalizer failed, degraded to legacy behavior: {}",
                error
            );
        }
    }
}

fn try_finalize_task_completion(
    ctx: &mut PipelineContext,
    db: &ChatV2Database,
    main_db: Option<&Arc<Database>>,
) -> Result<Option<FinalizationReport>, String> {
    // 1. 定位完成块对应的 tool_result（最后一个带 task_completed 标志的）
    let Some(result_index) = ctx.tool_results.iter().rposition(|r| {
        r.output
            .get("task_completed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }) else {
        return Ok(None);
    };
    let input = ctx.tool_results[result_index].input.clone();
    let block_id = ctx.tool_results[result_index].block_id.clone();

    // 2. 解析申报产物（executor 已校验过格式，此处失败按无申报降级）
    let declared = parse_declared_artifacts(&input).unwrap_or_else(|error| {
        log::warn!("[Finalizer] failed to re-parse declared artifacts: {}", error);
        Vec::new()
    });

    // 3. 构建验收上下文并执行（locator 借用在此块内结束，之后才能改 ctx）
    let report = {
        let locator = match (crate::get_global_app_handle(), main_db) {
            (Some(app), Some(database)) => Some(RuntimeRootLocator {
                app,
                database,
                session_id: &ctx.session_id,
                skill_package_roots: ctx.options.skill_package_roots.as_ref(),
            }),
            _ => None,
        };
        let finalization_ctx = FinalizationContext {
            session_id: &ctx.session_id,
            declared_artifacts: &declared,
            artifacts_required: false, // 骨架版：任务上下文产物要求后续阶段接入
            locator: locator
                .as_ref()
                .map(|locator| locator as &dyn ArtifactLocator),
        };
        TaskFinalizer::skeleton().finalize(&finalization_ctx)
    };

    // 4. 终态写入完成块 toolOutput.finalization（内存 + 落库）
    let report_value = serde_json::to_value(&report)
        .map_err(|error| format!("failed to serialize finalization report: {}", error))?;
    if let Some(block) = inject_finalization_into_blocks(
        &mut ctx.tool_results,
        &mut ctx.interleaved_blocks,
        result_index,
        block_id.as_deref(),
        &report_value,
    ) {
        // executor 防闪退保存过旧 output，这里立即覆盖；失败由末轮
        // save_results 兜底（同内容 upsert）
        if let Err(error) = ChatV2Repo::update_block_v2(db, &block) {
            log::warn!(
                "[Finalizer] failed to persist finalization to block {} \
                 (save_results will retry): {}",
                block.id,
                error
            );
        }
    }

    Ok(Some(report))
}

/// 把验收报告写进完成块的 toolOutput（内存结构）。
///
/// 返回更新后的完成块克隆供调用方持久化；找不到完成块时返回 None。
fn inject_finalization_into_blocks(
    tool_results: &mut [ToolResultInfo],
    interleaved_blocks: &mut [MessageBlock],
    result_index: usize,
    block_id: Option<&str>,
    report_value: &Value,
) -> Option<MessageBlock> {
    if let Some(result) = tool_results.get_mut(result_index) {
        if let Some(output) = result.output.as_object_mut() {
            output.insert("finalization".to_string(), report_value.clone());
        }
    }

    let block_id = block_id?;
    let block = interleaved_blocks.iter_mut().find(|b| b.id == block_id)?;
    if let Some(output) = block
        .tool_output
        .as_mut()
        .and_then(Value::as_object_mut)
    {
        output.insert("finalization".to_string(), report_value.clone());
    }
    Some(block.clone())
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 单目录测试 locator：所有 root_id 都解析到同一临时目录
    struct TempDirLocator {
        root: PathBuf,
    }

    impl ArtifactLocator for TempDirLocator {
        fn resolve(
            &self,
            _root_id: Option<&str>,
            relative: &Path,
        ) -> Result<ArtifactResolution, String> {
            resolve_under_root(&self.root, relative)
        }
    }

    /// 永远失败的 locator（模拟 root 未配置 / 不可用）
    struct FailingLocator;

    impl ArtifactLocator for FailingLocator {
        fn resolve(
            &self,
            _root_id: Option<&str>,
            _relative: &Path,
        ) -> Result<ArtifactResolution, String> {
            Err("root not configured".to_string())
        }
    }

    fn declared(path: &str, sha256: Option<String>) -> DeclaredArtifact {
        DeclaredArtifact {
            path: path.to_string(),
            sha256,
            root_id: None,
        }
    }

    fn finalize_with(
        declared_artifacts: &[DeclaredArtifact],
        artifacts_required: bool,
        locator: Option<&dyn ArtifactLocator>,
    ) -> FinalizationReport {
        let ctx = FinalizationContext {
            session_id: "sess-test",
            declared_artifacts,
            artifacts_required,
            locator,
        };
        TaskFinalizer::skeleton().finalize(&ctx)
    }

    // ----------------------------------------------------------------
    // 四条主路径：未申报 / 存在 / 缺失 / hash 不符
    // ----------------------------------------------------------------

    /// 未申报 artifacts 且无产物要求 → VerifiedComplete（兼容语义：
    /// 纯解释性回答不受影响；不运行检查器、不需要 locator）
    #[test]
    fn no_declared_artifacts_is_verified_complete_without_locator() {
        let report = finalize_with(&[], false, None);
        assert_eq!(report.verdict, FinalizationVerdict::VerifiedComplete);
        assert!(report.exceptions.is_empty());
        assert!(report.checks_run.is_empty());
    }

    /// 申报产物真实存在（无 hash）→ VerifiedComplete
    #[test]
    fn declared_existing_artifact_is_verified_complete() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("report.md"), b"hello").unwrap();
        let locator = TempDirLocator {
            root: temp.path().to_path_buf(),
        };

        let artifacts = vec![declared("report.md", None)];
        let report = finalize_with(&artifacts, false, Some(&locator));
        assert_eq!(report.verdict, FinalizationVerdict::VerifiedComplete);
        assert!(report.exceptions.is_empty());
        assert_eq!(report.checks_run, vec!["artifacts_exist".to_string()]);
    }

    /// 申报产物存在且 sha256 匹配 → VerifiedComplete
    #[test]
    fn declared_artifact_with_matching_sha256_is_verified_complete() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("report.md"), b"hello").unwrap();
        let locator = TempDirLocator {
            root: temp.path().to_path_buf(),
        };
        let expected = hex::encode(Sha256::digest(b"hello"));

        let artifacts = vec![declared("report.md", Some(expected))];
        let report = finalize_with(&artifacts, false, Some(&locator));
        assert_eq!(report.verdict, FinalizationVerdict::VerifiedComplete);
        assert!(report.exceptions.is_empty());
    }

    /// 申报产物缺失 → Partial + artifact_missing 例外
    #[test]
    fn missing_declared_artifact_is_partial() {
        let temp = tempfile::tempdir().unwrap();
        let locator = TempDirLocator {
            root: temp.path().to_path_buf(),
        };

        let artifacts = vec![declared("missing.md", None)];
        let report = finalize_with(&artifacts, false, Some(&locator));
        assert_eq!(report.verdict, FinalizationVerdict::Partial);
        assert_eq!(report.exceptions.len(), 1);
        assert_eq!(report.exceptions[0].kind, ExceptionKind::ArtifactMissing);
        assert_eq!(report.exceptions[0].path, Some("missing.md".to_string()));
    }

    /// 产物存在但 sha256 不符 → CompleteWithExceptions + hash_mismatch 例外
    #[test]
    fn sha256_mismatch_is_complete_with_exceptions() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("report.md"), b"hello").unwrap();
        let locator = TempDirLocator {
            root: temp.path().to_path_buf(),
        };
        let wrong = hex::encode(Sha256::digest(b"other content"));

        let artifacts = vec![declared("report.md", Some(wrong))];
        let report = finalize_with(&artifacts, false, Some(&locator));
        assert_eq!(report.verdict, FinalizationVerdict::CompleteWithExceptions);
        assert_eq!(report.exceptions.len(), 1);
        assert_eq!(report.exceptions[0].kind, ExceptionKind::HashMismatch);
    }

    // ----------------------------------------------------------------
    // 受阻 / 无法判定 / 非法申报
    // ----------------------------------------------------------------

    /// root 解析失败 → Blocked + check_unavailable 例外
    #[test]
    fn unresolvable_root_is_blocked() {
        let artifacts = vec![declared("report.md", None)];
        let report = finalize_with(&artifacts, false, Some(&FailingLocator));
        assert_eq!(report.verdict, FinalizationVerdict::Blocked);
        assert_eq!(report.exceptions[0].kind, ExceptionKind::CheckUnavailable);
    }

    /// 有申报但 locator 整体缺失（无 AppHandle / 主库）→ OutcomeUnknown
    #[test]
    fn missing_locator_is_outcome_unknown() {
        let artifacts = vec![declared("report.md", None)];
        let report = finalize_with(&artifacts, false, None);
        assert_eq!(report.verdict, FinalizationVerdict::OutcomeUnknown);
        assert_eq!(report.exceptions[0].kind, ExceptionKind::CheckUnavailable);
        assert_eq!(report.checks_run, vec!["artifacts_exist".to_string()]);
    }

    /// 申报路径非法（父目录逃逸 / 绝对路径）→ Partial + invalid_declaration
    #[test]
    fn invalid_declared_path_is_partial() {
        let temp = tempfile::tempdir().unwrap();
        let locator = TempDirLocator {
            root: temp.path().to_path_buf(),
        };

        for bad in ["../escape.txt", "/etc/passwd", "  "] {
            let artifacts = vec![declared(bad, None)];
            let report = finalize_with(&artifacts, false, Some(&locator));
            assert_eq!(report.verdict, FinalizationVerdict::Partial, "path={}", bad);
            assert_eq!(report.exceptions[0].kind, ExceptionKind::InvalidDeclaration);
        }
    }

    /// 任务上下文要求产物但未申报 → Partial（后续阶段语义补全）
    #[test]
    fn artifacts_required_but_none_declared_is_partial() {
        let temp = tempfile::tempdir().unwrap();
        let locator = TempDirLocator {
            root: temp.path().to_path_buf(),
        };
        let report = finalize_with(&[], true, Some(&locator));
        assert_eq!(report.verdict, FinalizationVerdict::Partial);
        assert_eq!(report.exceptions[0].kind, ExceptionKind::ArtifactMissing);
    }

    /// 目录不是有效产物 → Partial + invalid_declaration
    #[test]
    fn directory_artifact_is_invalid_declaration() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("subdir")).unwrap();
        let locator = TempDirLocator {
            root: temp.path().to_path_buf(),
        };
        let artifacts = vec![declared("subdir", None)];
        let report = finalize_with(&artifacts, false, Some(&locator));
        assert_eq!(report.verdict, FinalizationVerdict::Partial);
        assert_eq!(report.exceptions[0].kind, ExceptionKind::InvalidDeclaration);
    }

    // ----------------------------------------------------------------
    // serde 形状与解析
    // ----------------------------------------------------------------

    /// verdict / exception kind 序列化为 snake_case
    #[test]
    fn verdict_serializes_snake_case() {
        assert_eq!(
            serde_json::to_value(FinalizationVerdict::VerifiedComplete).unwrap(),
            json!("verified_complete")
        );
        assert_eq!(
            serde_json::to_value(FinalizationVerdict::CompleteWithExceptions).unwrap(),
            json!("complete_with_exceptions")
        );
        assert_eq!(
            serde_json::to_value(FinalizationVerdict::Partial).unwrap(),
            json!("partial")
        );
        assert_eq!(
            serde_json::to_value(FinalizationVerdict::Blocked).unwrap(),
            json!("blocked")
        );
        assert_eq!(
            serde_json::to_value(FinalizationVerdict::OutcomeUnknown).unwrap(),
            json!("outcome_unknown")
        );
        assert_eq!(
            serde_json::to_value(ExceptionKind::ArtifactMissing).unwrap(),
            json!("artifact_missing")
        );
    }

    /// 报告序列化形状：{verdict, exceptions, checks_run}
    #[test]
    fn report_serializes_expected_shape() {
        let report = FinalizationReport {
            verdict: FinalizationVerdict::Partial,
            exceptions: vec![FinalizationException {
                check: "artifacts_exist".to_string(),
                kind: ExceptionKind::ArtifactMissing,
                path: Some("a.md".to_string()),
                message: "missing".to_string(),
            }],
            checks_run: vec!["artifacts_exist".to_string()],
        };
        let value = serde_json::to_value(&report).unwrap();
        assert_eq!(value["verdict"], json!("partial"));
        assert_eq!(value["exceptions"][0]["kind"], json!("artifact_missing"));
        assert_eq!(value["exceptions"][0]["path"], json!("a.md"));
        assert_eq!(value["checks_run"], json!(["artifacts_exist"]));
    }

    /// parse_declared_artifacts：缺省 / null / 正常 / 非法
    #[test]
    fn parse_declared_artifacts_handles_all_shapes() {
        assert!(parse_declared_artifacts(&json!({"result": "done"}))
            .unwrap()
            .is_empty());
        assert!(parse_declared_artifacts(&json!({"artifacts": null}))
            .unwrap()
            .is_empty());

        let parsed = parse_declared_artifacts(&json!({
            "artifacts": [{"path": "a.md", "sha256": "abc", "root_id": "workspace"}]
        }))
        .unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].path, "a.md");
        assert_eq!(parsed[0].sha256, Some("abc".to_string()));
        assert_eq!(parsed[0].root_id, Some("workspace".to_string()));

        assert!(parse_declared_artifacts(&json!({"artifacts": [{"sha256": "abc"}]})).is_err());
        assert!(parse_declared_artifacts(&json!({"artifacts": "not-an-array"})).is_err());
    }

    // ----------------------------------------------------------------
    // tool_loop 集成侧：finalization 字段落块
    // ----------------------------------------------------------------

    fn completion_tool_result(block_id: &str) -> ToolResultInfo {
        ToolResultInfo {
            tool_call_id: Some("call_1".to_string()),
            block_id: Some(block_id.to_string()),
            tool_name: "attempt_completion".to_string(),
            input: json!({"result": "done"}),
            output: json!({
                "completed": true,
                "result": "done",
                "command": null,
                "task_completed": true,
            }),
            success: true,
            error: None,
            duration_ms: Some(1),
            reasoning_content: None,
            thought_signature: None,
        }
    }

    fn completion_block(block_id: &str, output: Value) -> MessageBlock {
        MessageBlock {
            id: block_id.to_string(),
            message_id: "msg_1".to_string(),
            block_type: "mcp_tool".to_string(),
            status: "success".to_string(),
            content: None,
            tool_name: Some("attempt_completion".to_string()),
            tool_input: Some(json!({"result": "done"})),
            tool_output: Some(output),
            citations: None,
            error: None,
            started_at: Some(1),
            ended_at: Some(2),
            first_chunk_at: Some(1),
            block_index: 0,
        }
    }

    /// tool_loop 终止路径的落块逻辑：finalization 同时写进
    /// ctx.tool_results 与 ctx.interleaved_blocks 的完成块 toolOutput，
    /// 并返回更新后的块供持久化。
    #[test]
    fn completion_block_receives_finalization_field() {
        let block_id = "blk_completion";
        let mut tool_results = vec![completion_tool_result(block_id)];
        let mut blocks = vec![completion_block(
            block_id,
            tool_results[0].output.clone(),
        )];
        let report = FinalizationReport {
            verdict: FinalizationVerdict::Partial,
            exceptions: vec![FinalizationException {
                check: "artifacts_exist".to_string(),
                kind: ExceptionKind::ArtifactMissing,
                path: Some("missing.md".to_string()),
                message: "not found".to_string(),
            }],
            checks_run: vec!["artifacts_exist".to_string()],
        };
        let report_value = serde_json::to_value(&report).unwrap();

        let updated = inject_finalization_into_blocks(
            &mut tool_results,
            &mut blocks,
            0,
            Some(block_id),
            &report_value,
        );

        // tool_results 内存结构已带 finalization
        assert_eq!(
            tool_results[0].output["finalization"]["verdict"],
            json!("partial")
        );
        // interleaved 块 toolOutput 已带 finalization
        assert_eq!(
            blocks[0].tool_output.as_ref().unwrap()["finalization"]["verdict"],
            json!("partial")
        );
        assert_eq!(
            blocks[0].tool_output.as_ref().unwrap()["finalization"]["exceptions"][0]["kind"],
            json!("artifact_missing")
        );
        // 返回的块克隆携带同一终态（供 update_block_v2 落库）
        let updated = updated.expect("completion block should be found");
        assert_eq!(
            updated.tool_output.as_ref().unwrap()["finalization"]["verdict"],
            json!("partial")
        );
        // 既有字段不受影响
        assert_eq!(
            blocks[0].tool_output.as_ref().unwrap()["task_completed"],
            json!(true)
        );
    }

    /// 找不到完成块时不 panic、返回 None
    #[test]
    fn inject_finalization_tolerates_missing_block() {
        let mut tool_results = vec![completion_tool_result("blk_a")];
        let mut blocks = vec![completion_block("blk_other", json!({}))];
        let report_value = json!({"verdict": "verified_complete"});
        let updated = inject_finalization_into_blocks(
            &mut tool_results,
            &mut blocks,
            0,
            Some("blk_a"),
            &report_value,
        );
        assert!(updated.is_none());
        // tool_results 仍被更新
        assert_eq!(
            tool_results[0].output["finalization"]["verdict"],
            json!("verified_complete")
        );
    }

    /// try_finalize_task_completion 端到端（无申报产物 → VerifiedComplete）：
    /// finalization 落内存块 + tool_results + 立即落库。
    #[test]
    fn try_finalize_writes_report_into_completion_block_and_db() {
        use crate::data_governance::migration::coordinator::MigrationCoordinator;
        use crate::data_governance::schema_registry::DatabaseId;

        let temp_dir = tempfile::TempDir::new().unwrap();
        let mut coordinator =
            MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::ChatV2)
            .expect("ChatV2 migrations should apply cleanly");
        let db = ChatV2Database::new(temp_dir.path()).unwrap();

        let request = crate::chat_v2::types::SendMessageRequest {
            session_id: "sess-finalizer".to_string(),
            content: "hi".to_string(),
            options: None,
            user_message_id: None,
            assistant_message_id: None,
            user_context_refs: None,
            path_map: None,
            workspace_id: None,
        };
        let mut ctx = PipelineContext::new(request);

        let block_id = "blk_completion_e2e";
        let tool_result = completion_tool_result(block_id);
        let block = completion_block(block_id, tool_result.output.clone());
        ctx.tool_results.push(tool_result);
        ctx.interleaved_blocks.push(block.clone());

        // 模拟 executor 防闪退保存：消息占位行 + 块行（无 finalization）
        {
            let conn = db.get_conn_safe().unwrap();
            // 外键约束（V20260130 起 foreign_keys=ON）：先落父会话行再插消息占位。
            conn.execute(
                "INSERT OR IGNORE INTO chat_v2_sessions (id, mode, created_at, updated_at) \
                 VALUES ('sess-finalizer', 'general_chat', datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT OR IGNORE INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp) \
                 VALUES (?1, ?2, 'assistant', '[]', 0)",
                rusqlite::params![block.message_id, "sess-finalizer"],
            )
            .unwrap();
            ChatV2Repo::create_block_v2(&db, &block).unwrap();
        }

        let report = try_finalize_task_completion(&mut ctx, &db, None)
            .unwrap()
            .expect("completion block should be finalized");
        assert_eq!(report.verdict, FinalizationVerdict::VerifiedComplete);

        // 内存结构已带 finalization
        assert_eq!(
            ctx.tool_results[0].output["finalization"]["verdict"],
            json!("verified_complete")
        );
        assert_eq!(
            ctx.interleaved_blocks[0]
                .tool_output
                .as_ref()
                .unwrap()["finalization"]["verdict"],
            json!("verified_complete")
        );

        // DB 行已覆盖为带 finalization 的终态
        let persisted = ChatV2Repo::get_block_v2(&db, block_id)
            .unwrap()
            .expect("block row should exist");
        assert_eq!(
            persisted.tool_output.as_ref().unwrap()["finalization"]["verdict"],
            json!("verified_complete")
        );
    }

    /// 无 task_completed 标志时 try_finalize 是 no-op（不触碰任何块）
    #[test]
    fn try_finalize_without_completion_flag_is_noop() {
        let request = crate::chat_v2::types::SendMessageRequest {
            session_id: "sess-noop".to_string(),
            content: "hi".to_string(),
            options: None,
            user_message_id: None,
            assistant_message_id: None,
            user_context_refs: None,
            path_map: None,
            workspace_id: None,
        };
        let mut ctx = PipelineContext::new(request);
        let mut ordinary = completion_tool_result("blk_ordinary");
        ordinary.output = json!({"some": "output"});
        ctx.tool_results.push(ordinary);

        // db 不会被触达；传一个未迁移的内存库路径也应安然 no-op。
        // 这里直接复用临时目录构造的库即可（无需建表）。
        let temp_dir = tempfile::TempDir::new().unwrap();
        let db = ChatV2Database::new(temp_dir.path()).unwrap();
        let report = try_finalize_task_completion(&mut ctx, &db, None).unwrap();
        assert!(report.is_none());
        assert!(ctx.tool_results[0].output.get("finalization").is_none());
    }
}
