//! G07：candidate_complete + TaskFinalizer 任务验收
//!
//! 把「Agent 结束说话」与「任务验收完成」分离：
//! - `attempt_completion` 工具调用只代表模型**申报**任务完成
//!   （candidate complete），不再等同于任务验收通过；
//! - [`TaskFinalizer`] 在工具循环终止前对任务产物做确定性核查，产出
//!   [`FinalizationVerdict`] 终态，写入完成块 `toolOutput.finalization`。
//!
//! ## 检查器构成（G07-a 实装 ArtifactsExist；G07-b 补齐其余两者）
//! - [`ArtifactsExistCheck`]：核对模型显式申报的产物文件在对应 runtime
//!   root 下真实存在、申报了 sha256 的内容哈希匹配；
//! - [`BatchCoverageCheck`]：任务上下文存在批次清单（执行器输出的
//!   `batch_manifest` / todo 批次）时，核对实际成功产出数 == 接受时固定
//!   的分母；缺项记 `batch_item_missing` 例外并降 partial。分母固定在
//!   任务接受时（批次计划确认 / 本轮首次 todo_init），不随执行中增删
//!   漂移；无批次的任务该检查器 NotApplicable（不记录 checks_run）；
//! - [`SideEffectsSettledCheck`]：按会话查 connector_operations 账本，
//!   存在 submitting / outcome_unknown 未决外部副作用时拒绝升级
//!   verified_complete，并逐条列出未决操作 id。
//!
//! ## 任务类型分流
//! 纯解释性回答（无产物申报/要求、无批次清单、会话无 connector 操作
//! 痕迹）跳过全部硬检查直接 [`FinalizationVerdict::VerifiedComplete`]
//! ——与 G07-a 之前的现状行为完全一致；有任一类痕迹才运行对应检查器。
//!
//! ## 防伪纪律
//! - 检查器只从后端证据取数：runtime root 文件系统、执行器 toolOutput
//!   中的 batch_manifest / todo 步骤快照、connector_operations 持久账本。
//!   模型自述（attempt_completion 的 artifacts 申报）只是**待核声明**，
//!   从来不是证据；
//! - 检查器注册表**编译期封闭**：[`TaskFinalizer::standard`] 返回固定
//!   集合，不提供运行期注册 API——agent 无法通过注册/替换检查器放宽
//!   自己的验收规则（G07-a 骨架曾预留 `with_check`，G07-b 按此要求移除；
//!   由 `g07b_registry_is_compile_time_closed` 测试锁定）。
//!
//! 验收结论只写进完成块 toolOutput（不落新表、不做数据库迁移）。

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use super::connector_ledger;
use super::context::PipelineContext;
use super::database::ChatV2Database;
use super::repo::ChatV2Repo;
use super::runtime_roots;
use super::task_objects::{BatchItemStatus, BatchManifest};
use super::tools::strip_tool_namespace;
use super::tools::todo_executor::{tool_names as todo_tool_names, TodoStatus};
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
    /// 检查器无法完成核查（root 解析失败 / IO 错误 / 账本查询失败）
    CheckUnavailable,
    /// 批次清单缺项：接受时分母中的条目未成功产出或无记录产出（G07-b）
    BatchItemMissing,
    /// 外部副作用未决：connector 操作停在 submitting / outcome_unknown（G07-b）
    SideEffectPending,
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
    fn resolve(&self, root_id: Option<&str>, relative: &Path)
        -> Result<ArtifactResolution, String>;
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
// 批次与侧效证据（G07-b）
// ============================================================================

/// todo 批次中单个接受步骤的终态快照
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodoBatchStep {
    /// 步骤 id（todo_init 接受时分配，如 `step_1`）
    pub step_id: String,
    /// 步骤描述（例外消息用）
    pub description: String,
    /// 验收时刻后端记录的状态
    pub final_status: TodoStatus,
}

/// todo 批次快照：接受时分母 + 逐步骤终态。
///
/// 分母在本轮**首次** `todo_init` 时固定——之后的 todo_add / 再次 init
/// 不改变分母，防止执行中增删漂移把"未完成"洗成"全覆盖"；终态取自本轮
/// 最后一个 todo 写工具输出中的 steps 快照（执行器后端记录，非模型自述）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodoBatchSnapshot {
    pub list_id: String,
    pub title: String,
    pub steps: Vec<TodoBatchStep>,
}

/// 未决 connector 操作（submitting / outcome_unknown）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingSideEffect {
    pub operation_id: String,
    /// 账本状态字符串（`submitting` / `outcome_unknown`）
    pub state: String,
    pub provider_id: String,
    pub action: String,
}

/// 会话 connector 侧效账本摘要
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SideEffectSummary {
    /// 会话关联的 connector 操作总数（任意状态；0 = 会话无侧效痕迹）
    pub total_operations: usize,
    /// 未决操作（submitting / outcome_unknown）
    pub pending: Vec<PendingSideEffect>,
}

// ============================================================================
// 验收检查器
// ============================================================================

/// 检查器运行状态
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckStatus {
    /// 检查完整执行（例外与否看 exceptions）
    Ran,
    /// 检查因基础设施缺失根本无法运行（如 locator 不可用 / 账本查询失败）
    Unavailable,
    /// 任务上下文无该检查器针对的痕迹（如无批次清单 / 会话无 connector
    /// 操作）——不记录进报告 checks_run
    NotApplicable,
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

    /// 任务无该检查器针对的痕迹：跳过且不记录 checks_run
    fn not_applicable() -> Self {
        Self {
            status: CheckStatus::NotApplicable,
            exceptions: Vec::new(),
        }
    }
}

/// 验收上下文：检查器所需的只读事实
pub struct FinalizationContext<'a> {
    pub session_id: &'a str,
    /// 模型显式申报的产物清单（**待核声明**，不是证据）
    pub declared_artifacts: &'a [DeclaredArtifact],
    /// 任务上下文是否要求产物。
    /// 当前恒为 false；后续阶段从 role_pack verification gates /
    /// task_audit 清单推断。
    pub artifacts_required: bool,
    /// 产物定位器；None = 验收基础设施缺失（检查器报 Unavailable）
    pub locator: Option<&'a dyn ArtifactLocator>,
    /// G07-b：本轮工具输出中执行器写入的批次清单（`batch_manifest` 键，
    /// 后端证据）
    pub batch_manifests: &'a [BatchManifest],
    /// G07-b：todo 批次快照；None = 本任务无 todo 批次活动
    pub todo_batch: Option<&'a TodoBatchSnapshot>,
    /// G07-b：会话 connector 侧效账本证据：
    /// - `None`：未提供账本（仅无 db 的测试场景；生产接线恒查询）→ 检查器
    ///   NotApplicable；
    /// - `Some(Err(_))`：账本查询失败 → 检查器 Unavailable（OutcomeUnknown）；
    /// - `Some(Ok(summary))`：账本事实（total==0 → NotApplicable）。
    pub side_effects: Option<&'a Result<SideEffectSummary, String>>,
}

/// 验收检查器接口（G07 验收规则的编译期扩展点——注册表封闭，见
/// [`TaskFinalizer::standard`]）
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
        // 无产物申报且任务无产物要求：产物维度不适用（G07-b——批次/侧效
        // 类任务进入检查流程时，不应因无申报误报 Unavailable）
        if ctx.declared_artifacts.is_empty() && !ctx.artifacts_required {
            return CheckOutcome::not_applicable();
        }

        let Some(locator) = ctx.locator else {
            return CheckOutcome::unavailable(
                self.id(),
                "artifact locator unavailable (no app handle / main database); \
                 cannot verify declared artifacts",
            );
        };

        let mut exceptions = Vec::new();

        // 任务要求产物但模型未申报（artifacts_required 当前恒 false，
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
            let relative = match runtime_roots::normalize_runtime_relative_path(Some(raw_path)) {
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
                            artifact
                                .root_id
                                .as_deref()
                                .unwrap_or(DEFAULT_ARTIFACT_ROOT_ID)
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

/// BatchCoverage（G07-b）：批次清单覆盖率核查。
///
/// 证据全部来自后端执行器输出（`batch_manifest` / todo 写工具的 steps
/// 快照），不读模型自述。分母固定在任务接受时：
/// - `BatchManifest.expected_items` 在批次计划确认（preview）时写入，
///   执行中不漂移；
/// - todo 批次分母 = 本轮首次 `todo_init` 接受的步骤集
///   （见 [`TodoBatchSnapshot`]）。
///
/// 缺项（状态非 Succeeded / 分母缺口无记录产出）记 `batch_item_missing`
/// 例外 → partial。多产物申报的逐件核查由 [`ArtifactsExistCheck`] 覆盖，
/// 本检查器不重复核对申报产物，避免同一缺失双重计例外。
pub struct BatchCoverageCheck;

impl AcceptanceCheck for BatchCoverageCheck {
    fn id(&self) -> &'static str {
        "batch_coverage"
    }

    fn run(&self, ctx: &FinalizationContext) -> CheckOutcome {
        if ctx.batch_manifests.is_empty() && ctx.todo_batch.is_none() {
            // 无批次任务：跳过且不记录 checks_run
            return CheckOutcome::not_applicable();
        }

        let mut exceptions = Vec::new();

        for manifest in ctx.batch_manifests {
            for item in &manifest.items {
                if item.status != BatchItemStatus::Succeeded {
                    exceptions.push(FinalizationException {
                        check: self.id().to_string(),
                        kind: ExceptionKind::BatchItemMissing,
                        path: None,
                        message: format!(
                            "batch '{}' item '{}' did not succeed (status: {:?}){}",
                            manifest.manifest_id,
                            item.item_id,
                            item.status,
                            item.error
                                .as_deref()
                                .map(|error| format!(": {}", error))
                                .unwrap_or_default(),
                        ),
                    });
                }
            }
            // 分母缺口：expected_items 在接受时固定；listed < expected 即
            // 有条目连结果都没记录（如截断），按缺项计
            let listed = manifest.items.len() as u64;
            if manifest.expected_items > listed {
                exceptions.push(FinalizationException {
                    check: self.id().to_string(),
                    kind: ExceptionKind::BatchItemMissing,
                    path: None,
                    message: format!(
                        "batch '{}' accepted {} items but only {} have recorded outcomes \
                         (truncated={}): {} item(s) unaccounted",
                        manifest.manifest_id,
                        manifest.expected_items,
                        listed,
                        manifest.truncated,
                        manifest.expected_items - listed,
                    ),
                });
            }
        }

        if let Some(todo) = ctx.todo_batch {
            for step in &todo.steps {
                if step.final_status != TodoStatus::Completed {
                    exceptions.push(FinalizationException {
                        check: self.id().to_string(),
                        kind: ExceptionKind::BatchItemMissing,
                        path: None,
                        message: format!(
                            "todo batch '{}' step '{}' ({}) was not completed \
                             (final status: {})",
                            todo.list_id, step.step_id, step.description, step.final_status
                        ),
                    });
                }
            }
        }

        CheckOutcome::ran(exceptions)
    }
}

/// SideEffectsSettled（G07-b）：外部副作用落账核查。
///
/// 按会话查 connector_operations 账本（G04 持久状态机）：存在
/// `submitting` / `outcome_unknown` 未决操作时拒绝升级
/// verified_complete，并逐条列出未决 operation id。
///
/// 状态口径：`draft` / `confirmed` 尚未向 provider 发送（预览未确认），
/// 不构成"已发出但结果未知"，不阻塞验收；`committed` / `failed` 为终态。
/// 即"全部 committed/failed 才通过"指**已提交发送**的操作全部到达终态。
pub struct SideEffectsSettledCheck;

impl AcceptanceCheck for SideEffectsSettledCheck {
    fn id(&self) -> &'static str {
        "side_effects_settled"
    }

    fn run(&self, ctx: &FinalizationContext) -> CheckOutcome {
        let Some(evidence) = ctx.side_effects else {
            // 未提供账本证据（仅无 db 的测试场景）——生产接线恒查询账本
            return CheckOutcome::not_applicable();
        };
        let summary = match evidence {
            Ok(summary) => summary,
            Err(error) => {
                return CheckOutcome::unavailable(
                    self.id(),
                    format!("connector ledger query failed: {}", error),
                );
            }
        };
        if summary.total_operations == 0 {
            // 会话无任何 connector 操作痕迹：跳过且不记录 checks_run
            return CheckOutcome::not_applicable();
        }

        let exceptions = summary
            .pending
            .iter()
            .map(|op| FinalizationException {
                check: self.id().to_string(),
                kind: ExceptionKind::SideEffectPending,
                path: None,
                message: format!(
                    "connector operation '{}' ({} {}) is '{}': external side effect \
                     has not reached a terminal state",
                    op.operation_id, op.provider_id, op.action, op.state
                ),
            })
            .collect();
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
    /// 标准检查器注册表：ArtifactsExist（G07-a）+ BatchCoverage /
    /// SideEffectsSettled（G07-b）。
    ///
    /// **注册表编译期封闭**：不提供运行期注册 API——验收规则只能经代码
    /// 评审变更，agent / 模型无法注册或替换检查器来放宽自己的验收。
    /// （G07-a 骨架曾预留 `with_check` 运行期注册位，G07-b 按防伪要求
    /// 移除；新增检查器 = 改这里 + 评审 + 测试锁定，见
    /// `g07b_registry_is_compile_time_closed`。）
    pub fn standard() -> Self {
        Self {
            checks: vec![
                Box::new(ArtifactsExistCheck),
                Box::new(BatchCoverageCheck),
                Box::new(SideEffectsSettledCheck),
            ],
        }
    }

    /// 执行验收。
    ///
    /// 任务类型分流（G07-b）：纯解释性回答（无产物申报/要求、无批次
    /// 清单、会话无 connector 侧效痕迹）→ 直接
    /// [`FinalizationVerdict::VerifiedComplete`]，不运行任何检查器
    /// （现状行为零变化）；任一痕迹存在才进入检查流程。单个检查器对无
    /// 对应痕迹的任务返回 NotApplicable，不记录进 checks_run。
    pub fn finalize(&self, ctx: &FinalizationContext) -> FinalizationReport {
        if !has_acceptance_evidence(ctx) {
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
            let outcome = check.run(ctx);
            match outcome.status {
                CheckStatus::NotApplicable => continue,
                CheckStatus::Unavailable => any_unavailable = true,
                CheckStatus::Ran => {}
            }
            checks_run.push(check.id().to_string());
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
        Self::standard()
    }
}

/// 任务类型分流（G07-b）：任务是否带有需要硬核查的痕迹。
///
/// 注意账本查询失败（`Some(Err(_))`）也算痕迹——"可能有未决侧效但查
/// 不到"必须走检查流程报 Unavailable，不能走纯解释直通误标 verified。
fn has_acceptance_evidence(ctx: &FinalizationContext) -> bool {
    if !ctx.declared_artifacts.is_empty()
        || ctx.artifacts_required
        || !ctx.batch_manifests.is_empty()
        || ctx.todo_batch.is_some()
    {
        return true;
    }
    match ctx.side_effects {
        Some(Ok(summary)) => summary.total_operations > 0,
        Some(Err(_)) => true,
        None => false,
    }
}

/// 终态推导优先级：
/// 检查器根本无法运行 → OutcomeUnknown；
/// 无例外 → VerifiedComplete；
/// 核查受阻（root / IO / 账本查询失败） → Blocked；
/// 产物缺失 / 申报非法 / 批次缺项 → Partial；
/// 仅剩未决外部副作用（submitting / outcome_unknown）→ OutcomeUnknown
/// （G07：外部发送结果未知时无法升级为 verified_complete）；
/// 其余组合（哈希不符、未决副作用叠加其他例外）→ CompleteWithExceptions。
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
            ExceptionKind::ArtifactMissing
                | ExceptionKind::InvalidDeclaration
                | ExceptionKind::BatchItemMissing
        )
    }) {
        return FinalizationVerdict::Partial;
    }
    if exceptions
        .iter()
        .all(|e| e.kind == ExceptionKind::SideEffectPending)
    {
        // 任务产物维度齐全，但外部发送结果未知——诚实标 OutcomeUnknown
        return FinalizationVerdict::OutcomeUnknown;
    }
    FinalizationVerdict::CompleteWithExceptions
}

// ============================================================================
// tool_loop 接线
// ============================================================================

/// 从 `attempt_completion` 工具入参解析申报产物。
pub fn parse_declared_artifacts(input: &Value) -> Result<Vec<DeclaredArtifact>, String> {
    match input.get("artifacts") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(value) => serde_json::from_value(value.clone())
            .map_err(|error| format!("invalid artifacts declaration: {}", error)),
    }
}

/// 从本轮工具输出收集执行器写入的批次清单（`batch_manifest` 键）。
///
/// 执行器输出是后端证据；反序列化失败（schema 漂移的后端 bug）只 warn
/// 跳过——畸形清单既不能证明覆盖也不能证明缺项，不据此判任务。
fn collect_batch_manifests(tool_results: &[ToolResultInfo]) -> Vec<BatchManifest> {
    let mut manifests = Vec::new();
    for result in tool_results {
        if let Some(value) = result.output.get("batch_manifest") {
            match serde_json::from_value::<BatchManifest>(value.clone()) {
                Ok(manifest) => manifests.push(manifest),
                Err(error) => log::warn!(
                    "[Finalizer] ignoring unparseable batch_manifest from tool '{}': {}",
                    result.tool_name,
                    error
                ),
            }
        }
    }
    manifests
}

/// todo 写工具判定（todo_get 只读，不构成本任务的批次承诺）
fn is_todo_write_tool(tool_name: &str) -> bool {
    let bare = strip_tool_namespace(tool_name);
    bare == todo_tool_names::TODO_INIT
        || bare == todo_tool_names::TODO_UPDATE
        || bare == todo_tool_names::TODO_ADD
}

/// todo 步骤快照的反序列化形状（对执行器输出字段漂移防御性宽容）
#[derive(Debug, Clone, Deserialize)]
struct TodoStepEvidence {
    id: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    status: TodoStatus,
}

fn parse_todo_steps(output: &Value) -> Vec<TodoStepEvidence> {
    output
        .get("steps")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default()
}

/// 从本轮工具输出构建 todo 批次快照（G07-b）。
///
/// - 触发：本轮出现 todo 写工具（init/update/add）活动——否则上一轮
///   遗留清单不属于本任务上下文，避免污染无关任务；
/// - 分母：本轮**首次** `todo_init` 接受的步骤集（固定，不随 todo_add /
///   再次 init 漂移）；本轮无 init（续作既有清单）时以最新快照为分母
///   （best effort——跨轮清单无更早的接受证据）；
/// - 终态：本轮最后一个 todo 写工具输出的 steps 快照；分母中在终态
///   快照找不到的步骤按 pending（未交付）计。
fn collect_todo_batch(tool_results: &[ToolResultInfo]) -> Option<TodoBatchSnapshot> {
    if !tool_results
        .iter()
        .any(|r| is_todo_write_tool(&r.tool_name))
    {
        return None;
    }

    let init_result = tool_results
        .iter()
        .find(|r| strip_tool_namespace(&r.tool_name) == todo_tool_names::TODO_INIT);
    let last_result = tool_results
        .iter()
        .rev()
        .find(|r| is_todo_write_tool(&r.tool_name));

    let final_steps = last_result
        .map(|result| parse_todo_steps(&result.output))
        .unwrap_or_default();
    let accepted = match init_result {
        Some(result) => parse_todo_steps(&result.output),
        None => final_steps.clone(),
    };
    if accepted.is_empty() {
        log::warn!(
            "[Finalizer] todo write activity found but no steps could be parsed; \
             skipping todo batch evidence"
        );
        return None;
    }

    let list_id = init_result
        .and_then(|result| result.output.get("todoListId"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let title = init_result
        .or(last_result)
        .and_then(|result| result.output.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let steps = accepted
        .into_iter()
        .map(|step| {
            let final_status = final_steps
                .iter()
                .find(|final_step| final_step.id == step.id)
                .map(|final_step| final_step.status)
                .unwrap_or(TodoStatus::Pending);
            TodoBatchStep {
                step_id: step.id,
                description: step.description,
                final_status,
            }
        })
        .collect();

    Some(TodoBatchSnapshot {
        list_id,
        title,
        steps,
    })
}

/// 查会话 connector 侧效账本（G07-b）。
///
/// 查询失败不抛出——作为 `Err` 证据交给检查器报 Unavailable
/// （OutcomeUnknown），由终态推导统一处理。
fn query_side_effects(db: &ChatV2Database, session_id: &str) -> Result<SideEffectSummary, String> {
    connector_ledger::session_side_effect_summary(db, session_id).map(|summary| SideEffectSummary {
        total_operations: summary.total_operations,
        pending: summary
            .pending
            .iter()
            .map(|op| PendingSideEffect {
                operation_id: op.operation_id.clone(),
                state: op.state.as_str().to_string(),
                provider_id: op.provider_id.clone(),
                action: op.action.clone(),
            })
            .collect(),
    })
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
                "[Finalizer] G07 task finalization: verdict={:?}, exceptions={}, session={}",
                report.verdict,
                report.exceptions.len(),
                ctx.session_id
            );
        }
        Ok(None) => {}
        Err(error) => {
            log::warn!(
                "[Finalizer] G07 finalizer failed, degraded to legacy behavior: {}",
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
        log::warn!(
            "[Finalizer] failed to re-parse declared artifacts: {}",
            error
        );
        Vec::new()
    });

    // 3. 收集 G07-b 后端证据：批次清单 / todo 批次 / connector 侧效账本。
    //    全部来自执行器输出与持久账本，不读模型自述。
    let batch_manifests = collect_batch_manifests(&ctx.tool_results);
    let todo_batch = collect_todo_batch(&ctx.tool_results);
    let side_effects = query_side_effects(db, &ctx.session_id);

    // 4. 构建验收上下文并执行（locator 借用在此块内结束，之后才能改 ctx）
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
            artifacts_required: false, // 任务上下文产物要求后续阶段接入
            locator: locator
                .as_ref()
                .map(|locator| locator as &dyn ArtifactLocator),
            batch_manifests: &batch_manifests,
            todo_batch: todo_batch.as_ref(),
            side_effects: Some(&side_effects),
        };
        TaskFinalizer::standard().finalize(&finalization_ctx)
    };

    // 5. 终态写入完成块 toolOutput.finalization（内存 + 落库）
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
    if let Some(output) = block.tool_output.as_mut().and_then(Value::as_object_mut) {
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
        finalize_full(FinalizationContext {
            session_id: "sess-test",
            declared_artifacts,
            artifacts_required,
            locator,
            batch_manifests: &[],
            todo_batch: None,
            side_effects: None,
        })
    }

    fn finalize_full(ctx: FinalizationContext) -> FinalizationReport {
        TaskFinalizer::standard().finalize(&ctx)
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
    // G07-b：BatchCoverage 检查器
    // ----------------------------------------------------------------

    use crate::chat_v2::task_objects::BatchManifestItem;

    fn batch_manifest(expected: u64, items: Vec<(&str, BatchItemStatus)>) -> BatchManifest {
        let listed = items.len() as u64;
        BatchManifest {
            manifest_id: "manifest_test".to_string(),
            expected_items: expected,
            observed_items: listed,
            coverage_complete: listed == expected,
            truncated: listed < expected,
            items: items
                .into_iter()
                .map(|(item_id, status)| BatchManifestItem {
                    item_id: item_id.to_string(),
                    object_handle_id: None,
                    status,
                    attempts: 1,
                    error: (status == BatchItemStatus::Failed).then(|| "boom".to_string()),
                })
                .collect(),
        }
    }

    fn ctx_with_batches<'a>(
        manifests: &'a [BatchManifest],
        todo: Option<&'a TodoBatchSnapshot>,
    ) -> FinalizationContext<'a> {
        FinalizationContext {
            session_id: "sess-test",
            declared_artifacts: &[],
            artifacts_required: false,
            locator: None,
            batch_manifests: manifests,
            todo_batch: todo,
            side_effects: None,
        }
    }

    /// 批次缺 2 项（分母 4，2 成功 2 失败）→ Partial + 缺失清单带条目 id
    #[test]
    fn g07b_batch_missing_two_items_is_partial_with_missing_list() {
        let manifests = vec![batch_manifest(
            4,
            vec![
                ("a", BatchItemStatus::Succeeded),
                ("b", BatchItemStatus::Succeeded),
                ("c", BatchItemStatus::Failed),
                ("d", BatchItemStatus::Failed),
            ],
        )];
        let report = finalize_full(ctx_with_batches(&manifests, None));
        assert_eq!(report.verdict, FinalizationVerdict::Partial);
        assert_eq!(report.checks_run, vec!["batch_coverage".to_string()]);
        let missing: Vec<_> = report
            .exceptions
            .iter()
            .filter(|e| e.kind == ExceptionKind::BatchItemMissing)
            .collect();
        assert_eq!(missing.len(), 2);
        assert!(missing.iter().any(|e| e.message.contains("'c'")));
        assert!(missing.iter().any(|e| e.message.contains("'d'")));
    }

    /// 分母缺口（截断：分母 5 只有 3 条记录且全成功）→ Partial，缺口按缺项计
    #[test]
    fn g07b_truncated_batch_deficit_is_missing() {
        let manifests = vec![batch_manifest(
            5,
            vec![
                ("a", BatchItemStatus::Succeeded),
                ("b", BatchItemStatus::Succeeded),
                ("c", BatchItemStatus::Succeeded),
            ],
        )];
        let report = finalize_full(ctx_with_batches(&manifests, None));
        assert_eq!(report.verdict, FinalizationVerdict::Partial);
        assert_eq!(report.exceptions.len(), 1);
        assert_eq!(report.exceptions[0].kind, ExceptionKind::BatchItemMissing);
        assert!(report.exceptions[0]
            .message
            .contains("2 item(s) unaccounted"));
    }

    /// 全批次成功（分母 == 成功数）→ 通过，检查器记录在 checks_run
    #[test]
    fn g07b_full_batch_passes_and_records_check() {
        let manifests = vec![batch_manifest(
            2,
            vec![
                ("a", BatchItemStatus::Succeeded),
                ("b", BatchItemStatus::Succeeded),
            ],
        )];
        let report = finalize_full(ctx_with_batches(&manifests, None));
        assert_eq!(report.verdict, FinalizationVerdict::VerifiedComplete);
        assert_eq!(report.checks_run, vec!["batch_coverage".to_string()]);
    }

    fn todo_snapshot(steps: Vec<(&str, &str, TodoStatus)>) -> TodoBatchSnapshot {
        TodoBatchSnapshot {
            list_id: "todo_test".to_string(),
            title: "demo".to_string(),
            steps: steps
                .into_iter()
                .map(|(id, desc, status)| TodoBatchStep {
                    step_id: id.to_string(),
                    description: desc.to_string(),
                    final_status: status,
                })
                .collect(),
        }
    }

    /// todo 批次：接受 3 步、终态 2 完成 1 待办 → Partial，缺项带步骤 id
    #[test]
    fn g07b_todo_batch_incomplete_step_is_missing() {
        let todo = todo_snapshot(vec![
            ("step_1", "调研", TodoStatus::Completed),
            ("step_2", "整理", TodoStatus::Completed),
            ("step_3", "输出", TodoStatus::Pending),
        ]);
        let report = finalize_full(ctx_with_batches(&[], Some(&todo)));
        assert_eq!(report.verdict, FinalizationVerdict::Partial);
        assert_eq!(report.checks_run, vec!["batch_coverage".to_string()]);
        assert_eq!(report.exceptions.len(), 1);
        assert_eq!(report.exceptions[0].kind, ExceptionKind::BatchItemMissing);
        assert!(report.exceptions[0].message.contains("step_3"));
    }

    /// todo 批次全部完成 → 通过
    #[test]
    fn g07b_todo_batch_all_completed_passes() {
        let todo = todo_snapshot(vec![
            ("step_1", "调研", TodoStatus::Completed),
            ("step_2", "整理", TodoStatus::Completed),
        ]);
        let report = finalize_full(ctx_with_batches(&[], Some(&todo)));
        assert_eq!(report.verdict, FinalizationVerdict::VerifiedComplete);
        assert_eq!(report.checks_run, vec!["batch_coverage".to_string()]);
    }

    // ----------------------------------------------------------------
    // G07-b：SideEffectsSettled 检查器
    // ----------------------------------------------------------------

    fn pending_op(operation_id: &str, state: &str) -> PendingSideEffect {
        PendingSideEffect {
            operation_id: operation_id.to_string(),
            state: state.to_string(),
            provider_id: "google-work".to_string(),
            action: "send".to_string(),
        }
    }

    fn side_effect_ctx(evidence: &Result<SideEffectSummary, String>) -> FinalizationContext<'_> {
        FinalizationContext {
            session_id: "sess-test",
            declared_artifacts: &[],
            artifacts_required: false,
            locator: None,
            batch_manifests: &[],
            todo_batch: None,
            side_effects: Some(evidence),
        }
    }

    /// outcome_unknown 操作 → 不得升级 verified_complete：单独存在时
    /// verdict = OutcomeUnknown，例外列出未决操作 id
    #[test]
    fn g07b_outcome_unknown_operation_is_not_verified_complete() {
        let evidence = Ok(SideEffectSummary {
            total_operations: 1,
            pending: vec![pending_op("op-1", "outcome_unknown")],
        });
        let report = finalize_full(side_effect_ctx(&evidence));
        assert_eq!(report.verdict, FinalizationVerdict::OutcomeUnknown);
        assert_eq!(report.checks_run, vec!["side_effects_settled".to_string()]);
        assert_eq!(report.exceptions.len(), 1);
        assert_eq!(report.exceptions[0].kind, ExceptionKind::SideEffectPending);
        assert!(report.exceptions[0].message.contains("op-1"));
    }

    /// submitting（发送中）同样不得升级 verified_complete
    #[test]
    fn g07b_submitting_operation_is_not_verified_complete() {
        let evidence = Ok(SideEffectSummary {
            total_operations: 1,
            pending: vec![pending_op("op-2", "submitting")],
        });
        let report = finalize_full(side_effect_ctx(&evidence));
        assert_eq!(report.verdict, FinalizationVerdict::OutcomeUnknown);
        assert!(report.exceptions[0].message.contains("op-2"));
    }

    /// 会话操作全部到达终态（committed/failed）→ 通过
    #[test]
    fn g07b_all_terminal_operations_pass() {
        let evidence = Ok(SideEffectSummary {
            total_operations: 2,
            pending: Vec::new(),
        });
        let report = finalize_full(side_effect_ctx(&evidence));
        assert_eq!(report.verdict, FinalizationVerdict::VerifiedComplete);
        assert_eq!(report.checks_run, vec!["side_effects_settled".to_string()]);
    }

    /// 会话无任何 connector 操作 → 检查器跳过；且无其他痕迹时整体走
    /// 纯解释直通（checks_run 为空）
    #[test]
    fn g07b_no_operations_is_pure_explanation_fast_path() {
        let evidence = Ok(SideEffectSummary {
            total_operations: 0,
            pending: Vec::new(),
        });
        let report = finalize_full(side_effect_ctx(&evidence));
        assert_eq!(report.verdict, FinalizationVerdict::VerifiedComplete);
        assert!(report.checks_run.is_empty());
    }

    /// 账本查询失败 → 检查器 Unavailable → OutcomeUnknown（不能误标 verified）
    #[test]
    fn g07b_ledger_query_failure_is_outcome_unknown() {
        let evidence = Err("db locked".to_string());
        let report = finalize_full(side_effect_ctx(&evidence));
        assert_eq!(report.verdict, FinalizationVerdict::OutcomeUnknown);
        assert_eq!(report.checks_run, vec!["side_effects_settled".to_string()]);
        assert_eq!(report.exceptions[0].kind, ExceptionKind::CheckUnavailable);
    }

    // ----------------------------------------------------------------
    // G07-b：组合场景与注册表封闭性
    // ----------------------------------------------------------------

    /// 组合：批次缺 1 项 + 申报产物 hash 错 → Partial，且两类例外齐全
    #[test]
    fn g07b_batch_missing_plus_hash_mismatch_is_partial_with_both_exceptions() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("report.md"), b"hello").unwrap();
        let locator = TempDirLocator {
            root: temp.path().to_path_buf(),
        };
        let wrong = hex::encode(Sha256::digest(b"other content"));
        let artifacts = vec![declared("report.md", Some(wrong))];
        let manifests = vec![batch_manifest(
            2,
            vec![
                ("a", BatchItemStatus::Succeeded),
                ("b", BatchItemStatus::Failed),
            ],
        )];

        let report = finalize_full(FinalizationContext {
            session_id: "sess-test",
            declared_artifacts: &artifacts,
            artifacts_required: false,
            locator: Some(&locator),
            batch_manifests: &manifests,
            todo_batch: None,
            side_effects: None,
        });
        assert_eq!(report.verdict, FinalizationVerdict::Partial);
        assert_eq!(report.exceptions.len(), 2);
        assert!(report
            .exceptions
            .iter()
            .any(|e| e.kind == ExceptionKind::BatchItemMissing));
        assert!(report
            .exceptions
            .iter()
            .any(|e| e.kind == ExceptionKind::HashMismatch));
        assert_eq!(
            report.checks_run,
            vec!["artifacts_exist".to_string(), "batch_coverage".to_string()]
        );
    }

    /// 组合：未决副作用 + 其他例外（hash 错）→ CompleteWithExceptions
    /// （outcome_unknown 单独 → outcome_unknown；有其他例外 →
    /// complete_with_exceptions）
    #[test]
    fn g07b_pending_side_effect_plus_other_exception_is_complete_with_exceptions() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("report.md"), b"hello").unwrap();
        let locator = TempDirLocator {
            root: temp.path().to_path_buf(),
        };
        let wrong = hex::encode(Sha256::digest(b"other content"));
        let artifacts = vec![declared("report.md", Some(wrong))];
        let evidence = Ok(SideEffectSummary {
            total_operations: 1,
            pending: vec![pending_op("op-9", "outcome_unknown")],
        });

        let report = finalize_full(FinalizationContext {
            session_id: "sess-test",
            declared_artifacts: &artifacts,
            artifacts_required: false,
            locator: Some(&locator),
            batch_manifests: &[],
            todo_batch: None,
            side_effects: Some(&evidence),
        });
        assert_eq!(report.verdict, FinalizationVerdict::CompleteWithExceptions);
        assert!(report
            .exceptions
            .iter()
            .any(|e| e.kind == ExceptionKind::HashMismatch));
        assert!(report
            .exceptions
            .iter()
            .any(|e| e.kind == ExceptionKind::SideEffectPending));
    }

    /// 防伪锁定：检查器注册表编译期封闭——standard() 恰好包含三个检查器、
    /// 按固定顺序执行；不存在运行期注册 API（`with_check` 已按 G07-b 防伪
    /// 要求移除，agent 无法注册/替换检查器放宽自己的验收）。
    #[test]
    fn g07b_registry_is_compile_time_closed() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("report.md"), b"hello").unwrap();
        let locator = TempDirLocator {
            root: temp.path().to_path_buf(),
        };
        let artifacts = vec![declared("report.md", None)];
        let manifests = vec![batch_manifest(1, vec![("a", BatchItemStatus::Succeeded)])];
        let evidence = Ok(SideEffectSummary {
            total_operations: 1,
            pending: vec![pending_op("op-1", "submitting")],
        });

        let report = finalize_full(FinalizationContext {
            session_id: "sess-test",
            declared_artifacts: &artifacts,
            artifacts_required: false,
            locator: Some(&locator),
            batch_manifests: &manifests,
            todo_batch: None,
            side_effects: Some(&evidence),
        });
        assert_eq!(
            report.checks_run,
            vec![
                "artifacts_exist".to_string(),
                "batch_coverage".to_string(),
                "side_effects_settled".to_string(),
            ]
        );
        // 产物存在 + 批次全覆盖 → 唯一例外是未决副作用 → OutcomeUnknown
        assert_eq!(report.verdict, FinalizationVerdict::OutcomeUnknown);
    }

    /// 新例外类别序列化为 snake_case
    #[test]
    fn g07b_new_exception_kinds_serialize_snake_case() {
        assert_eq!(
            serde_json::to_value(ExceptionKind::BatchItemMissing).unwrap(),
            json!("batch_item_missing")
        );
        assert_eq!(
            serde_json::to_value(ExceptionKind::SideEffectPending).unwrap(),
            json!("side_effect_pending")
        );
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
        let mut blocks = vec![completion_block(block_id, tool_results[0].output.clone())];
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
            ctx.interleaved_blocks[0].tool_output.as_ref().unwrap()["finalization"]["verdict"],
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

    // ----------------------------------------------------------------
    // G07-b：tool_loop 接线侧证据采集
    // ----------------------------------------------------------------

    /// G07-b 接线测试共享脚手架：已迁移库 + 会话/消息/完成块落库 +
    /// 带完成块的 PipelineContext（prior_results 在完成块之前入列）
    fn finalization_harness(
        session_id: &str,
        block_id: &str,
        prior_results: Vec<ToolResultInfo>,
    ) -> (tempfile::TempDir, Arc<ChatV2Database>, PipelineContext) {
        use crate::data_governance::migration::coordinator::MigrationCoordinator;
        use crate::data_governance::schema_registry::DatabaseId;

        let temp_dir = tempfile::TempDir::new().unwrap();
        let mut coordinator =
            MigrationCoordinator::new(temp_dir.path().to_path_buf()).with_audit_db(None);
        coordinator
            .migrate_single(DatabaseId::ChatV2)
            .expect("ChatV2 migrations should apply cleanly");
        let db = Arc::new(ChatV2Database::new(temp_dir.path()).unwrap());

        let request = crate::chat_v2::types::SendMessageRequest {
            session_id: session_id.to_string(),
            content: "hi".to_string(),
            options: None,
            user_message_id: None,
            assistant_message_id: None,
            user_context_refs: None,
            path_map: None,
            workspace_id: None,
        };
        let mut ctx = PipelineContext::new(request);
        for result in prior_results {
            ctx.tool_results.push(result);
        }
        let tool_result = completion_tool_result(block_id);
        let block = completion_block(block_id, tool_result.output.clone());
        ctx.tool_results.push(tool_result);
        ctx.interleaved_blocks.push(block.clone());

        {
            let conn = db.get_conn_safe().unwrap();
            // 外键约束（V20260130 起 foreign_keys=ON）：先落父会话行再插消息占位。
            conn.execute(
                "INSERT OR IGNORE INTO chat_v2_sessions (id, mode, created_at, updated_at) \
                 VALUES (?1, 'general_chat', datetime('now'), datetime('now'))",
                rusqlite::params![session_id],
            )
            .unwrap();
            conn.execute(
                "INSERT OR IGNORE INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp) \
                 VALUES (?1, ?2, 'assistant', '[]', 0)",
                rusqlite::params![block.message_id, session_id],
            )
            .unwrap();
            ChatV2Repo::create_block_v2(&db, &block).unwrap();
        }

        (temp_dir, db, ctx)
    }

    fn bare_tool_result(tool_name: &str, output: Value) -> ToolResultInfo {
        ToolResultInfo {
            tool_call_id: None,
            block_id: None,
            tool_name: tool_name.to_string(),
            input: json!({}),
            output,
            success: true,
            error: None,
            duration_ms: Some(1),
            reasoning_content: None,
            thought_signature: None,
        }
    }

    /// 接线：批次清单从执行器 toolOutput 采集——缺 1 项 → Partial 落块落库
    #[test]
    fn g07b_try_finalize_collects_batch_manifest_from_tool_outputs() {
        let batch_result = bare_tool_result(
            "file_manager_commit",
            json!({
                "complete": false,
                "batch_manifest": {
                    "manifestId": "manifest_e2e",
                    "expectedItems": 2,
                    "observedItems": 2,
                    "coverageComplete": true,
                    "truncated": false,
                    "items": [
                        {"itemId": "a", "status": "succeeded", "attempts": 1},
                        {"itemId": "b", "status": "failed", "attempts": 1, "error": "disk full"}
                    ]
                }
            }),
        );
        let (_dir, db, mut ctx) = finalization_harness(
            "sess-g07b-batch",
            "blk_completion_batch",
            vec![batch_result],
        );

        let report = try_finalize_task_completion(&mut ctx, &db, None)
            .unwrap()
            .expect("completion block should be finalized");
        assert_eq!(report.verdict, FinalizationVerdict::Partial);
        assert_eq!(report.checks_run, vec!["batch_coverage".to_string()]);
        assert_eq!(report.exceptions.len(), 1);
        assert_eq!(report.exceptions[0].kind, ExceptionKind::BatchItemMissing);
        assert!(report.exceptions[0].message.contains("'b'"));

        // 终态落库
        let persisted = ChatV2Repo::get_block_v2(&db, "blk_completion_batch")
            .unwrap()
            .expect("block row should exist");
        assert_eq!(
            persisted.tool_output.as_ref().unwrap()["finalization"]["verdict"],
            json!("partial")
        );
    }

    /// 接线：侧效证据来自 connector_operations 账本——outcome_unknown 操作
    /// → OutcomeUnknown，例外列出未决操作 id
    #[test]
    fn g07b_try_finalize_reads_connector_ledger_pending_ops() {
        use super::connector_ledger::{
            system_idempotency_key, ConnectorLedger, NewConnectorOperation,
        };

        let (_dir, db, mut ctx) =
            finalization_harness("sess-g07b-ledger", "blk_completion_ledger", vec![]);

        // 账本经 G04 状态机合法路径落一行 outcome_unknown
        let ledger = ConnectorLedger::new(db.clone());
        let preview_sha256 = "a".repeat(64);
        ledger
            .insert_draft(&NewConnectorOperation {
                operation_id: "op-e2e".to_string(),
                session_id: "sess-g07b-ledger".to_string(),
                provider_id: "google-work".to_string(),
                capability: Some("mail".to_string()),
                action: "send".to_string(),
                preview_sha256: preview_sha256.clone(),
                idempotency_key: system_idempotency_key("op-e2e", &preview_sha256),
                account_id: None,
                capability_fingerprint: None,
                preview_json: "{}".to_string(),
                expires_at_ms: None,
                created_at: "2026-09-07T00:00:00Z".to_string(),
            })
            .unwrap();
        ledger
            .mark_confirmed("op-e2e", &preview_sha256, "t1")
            .unwrap();
        ledger.mark_submitting("op-e2e", "t2", "h").unwrap();
        ledger.mark_outcome_unknown("op-e2e", "transient").unwrap();

        let report = try_finalize_task_completion(&mut ctx, &db, None)
            .unwrap()
            .expect("completion block should be finalized");
        assert_eq!(report.verdict, FinalizationVerdict::OutcomeUnknown);
        assert_eq!(report.checks_run, vec!["side_effects_settled".to_string()]);
        assert_eq!(report.exceptions.len(), 1);
        assert_eq!(report.exceptions[0].kind, ExceptionKind::SideEffectPending);
        assert!(report.exceptions[0].message.contains("op-e2e"));
    }

    /// 接线：todo 批次从本轮写工具输出采集——接受 3 步终态缺 1 → Partial
    #[test]
    fn g07b_try_finalize_collects_todo_batch_from_tool_outputs() {
        let init_result = bare_tool_result(
            "todo_init",
            json!({
                "success": true,
                "todoListId": "todo_e2e",
                "title": "三步任务",
                "totalSteps": 3,
                "steps": [
                    {"id": "step_1", "description": "调研", "status": "pending", "createdAt": 1},
                    {"id": "step_2", "description": "整理", "status": "pending", "createdAt": 1},
                    {"id": "step_3", "description": "输出", "status": "pending", "createdAt": 1}
                ]
            }),
        );
        let update_result = bare_tool_result(
            "todo_update",
            json!({
                "success": true,
                "steps": [
                    {"id": "step_1", "description": "调研", "status": "completed", "createdAt": 1},
                    {"id": "step_2", "description": "整理", "status": "completed", "createdAt": 1},
                    {"id": "step_3", "description": "输出", "status": "pending", "createdAt": 1}
                ]
            }),
        );
        let (_dir, db, mut ctx) = finalization_harness(
            "sess-g07b-todo",
            "blk_completion_todo",
            vec![init_result, update_result],
        );

        let report = try_finalize_task_completion(&mut ctx, &db, None)
            .unwrap()
            .expect("completion block should be finalized");
        assert_eq!(report.verdict, FinalizationVerdict::Partial);
        assert_eq!(report.checks_run, vec!["batch_coverage".to_string()]);
        assert_eq!(report.exceptions.len(), 1);
        assert!(report.exceptions[0].message.contains("step_3"));
    }

    /// 分母防漂移：本轮再次 todo_init 缩小步骤数，分母仍钉在首次 init——
    /// 被裁掉的步骤在终态快照中找不到，按 pending（未交付）计缺
    #[test]
    fn g07b_todo_denominator_pinned_at_first_init() {
        let first_init = bare_tool_result(
            "builtin-todo_init", // 带命名空间前缀也应被剥离识别
            json!({
                "success": true,
                "todoListId": "todo_drift",
                "title": "原计划",
                "steps": [
                    {"id": "step_1", "description": "a", "status": "pending", "createdAt": 1},
                    {"id": "step_2", "description": "b", "status": "pending", "createdAt": 1},
                    {"id": "step_3", "description": "c", "status": "pending", "createdAt": 1}
                ]
            }),
        );
        // 再次 init 把清单缩成 1 步（执行中漂移）
        let re_init = bare_tool_result(
            "todo_init",
            json!({
                "success": true,
                "todoListId": "todo_drift",
                "title": "缩水计划",
                "steps": [
                    {"id": "step_1", "description": "a", "status": "completed", "createdAt": 2}
                ]
            }),
        );
        let (_dir, db, mut ctx) = finalization_harness(
            "sess-g07b-drift",
            "blk_completion_drift",
            vec![first_init, re_init],
        );

        let report = try_finalize_task_completion(&mut ctx, &db, None)
            .unwrap()
            .expect("completion block should be finalized");
        assert_eq!(report.verdict, FinalizationVerdict::Partial);
        // step_2 / step_3 未交付（终态快照中不存在 → pending）
        assert_eq!(report.exceptions.len(), 2);
        assert!(report
            .exceptions
            .iter()
            .any(|e| e.message.contains("step_2")));
        assert!(report
            .exceptions
            .iter()
            .any(|e| e.message.contains("step_3")));
    }
}
