use chrono::{DateTime, Utc};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard, RwLock,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::backup::ImportProgress;

// ============================================================================
// 安全锁访问辅助函数（处理锁中毒问题）
// ============================================================================

/// 安全地获取 Mutex 锁，在中毒时恢复锁并返回 guard
/// 这样可以防止单个线程 panic 导致整个程序崩溃
fn safe_lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            error!(
                "[BackupJobManager] Mutex poisoned! Attempting recovery for type: {:?}",
                std::any::type_name::<T>()
            );
            poisoned.into_inner()
        }
    }
}

/// 安全地获取 Mutex 锁的克隆值，在中毒时返回默认值而非 panic
fn safe_lock_clone<T: Clone + Default>(mutex: &Mutex<T>) -> T {
    match mutex.lock() {
        Ok(guard) => (*guard).clone(),
        Err(poisoned) => {
            error!(
                "[BackupJobManager] Mutex poisoned! Recovering clone for type: {:?}",
                std::any::type_name::<T>()
            );
            poisoned.into_inner().clone()
        }
    }
}

/// 安全地获取 Option<T> 类型的 Mutex 锁值的拷贝
fn safe_lock_option<T: Copy>(mutex: &Mutex<Option<T>>) -> Option<T> {
    match mutex.lock() {
        Ok(guard) => *guard,
        Err(poisoned) => {
            error!(
                "[BackupJobManager] Mutex poisoned! Recovering Option value for type: {:?}",
                std::any::type_name::<T>()
            );
            *poisoned.into_inner()
        }
    }
}

/// 备份任务类型：导出或导入。
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BackupJobKind {
    Export,
    Import,
}

/// 任务状态机：排队、运行、完成、失败、已取消。
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BackupJobStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl BackupJobStatus {
    /// 是否为终态（完成/失败/已取消）
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            BackupJobStatus::Completed | BackupJobStatus::Failed | BackupJobStatus::Cancelled
        )
    }

    /// 验证状态转换是否合法（状态机单调性）
    ///
    /// 合法转换：
    /// - Queued → Running / Failed / Cancelled
    /// - Running → Completed / Failed / Cancelled
    /// - 终态（Completed / Failed / Cancelled）→ 不允许转换
    pub fn can_transition_to(&self, target: BackupJobStatus) -> bool {
        if *self == target {
            return true; // 同状态幂等更新
        }
        match self {
            BackupJobStatus::Queued => matches!(
                target,
                BackupJobStatus::Running | BackupJobStatus::Failed | BackupJobStatus::Cancelled
            ),
            BackupJobStatus::Running => matches!(
                target,
                BackupJobStatus::Completed | BackupJobStatus::Failed | BackupJobStatus::Cancelled
            ),
            // 终态不允许转换
            BackupJobStatus::Completed | BackupJobStatus::Failed | BackupJobStatus::Cancelled => {
                false
            }
        }
    }
}

/// 任务阶段。对于导出：`scan`、`checkpoint`、`compress`、`verify`；对于导入：`scan`、`extract`、`verify`、`replace`、`cleanup`。
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BackupJobPhase {
    Queued,
    Scan,
    Checkpoint,
    Compress,
    Verify,
    Extract,
    Replace,
    Cleanup,
    Completed,
    Failed,
    Cancelled,
}

/// 任务执行结果，用于完成后的事件与查询。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct BackupJobResultPayload {
    pub success: bool,
    #[serde(alias = "outputPath")]
    pub output_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(alias = "resolvedPath")]
    pub resolved_path: Option<String>,
    pub message: Option<String>,
    pub error: Option<String>,
    #[serde(alias = "durationMs")]
    pub duration_ms: Option<u64>,
    /// 可选的统计信息（如文件数、压缩率等）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<serde_json::Value>,
    /// P0 修复：导入完成后是否需要强制重启
    /// 当数据库连接刷新失败时，此字段为 true
    #[serde(default, alias = "requiresRestart")]
    pub requires_restart: bool,
    /// P1 优化：断点续传支持 - 已完成的文件列表路径
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(alias = "checkpointPath")]
    pub checkpoint_path: Option<String>,
    /// P1 优化：可恢复的导出任务 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(alias = "resumableJobId")]
    pub resumable_job_id: Option<String>,
}

/// 前端监听的事件载荷。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BackupJobEvent {
    #[serde(alias = "jobId")]
    pub job_id: String,
    pub kind: BackupJobKind,
    pub status: BackupJobStatus,
    pub phase: BackupJobPhase,
    pub progress: f32,
    pub message: Option<String>,
    #[serde(alias = "processedItems")]
    pub processed_items: u64,
    #[serde(alias = "totalItems")]
    pub total_items: u64,
    #[serde(alias = "etaSeconds")]
    pub eta_seconds: Option<u64>,
    pub cancellable: bool,
    #[serde(alias = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(alias = "startedAt")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(alias = "finishedAt")]
    pub finished_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<BackupJobResultPayload>,
}

/// 列表查询返回的任务摘要。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BackupJobSummary {
    #[serde(alias = "jobId")]
    pub job_id: String,
    pub kind: BackupJobKind,
    pub status: BackupJobStatus,
    pub phase: BackupJobPhase,
    pub progress: f32,
    pub message: Option<String>,
    #[serde(alias = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(alias = "startedAt")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(alias = "finishedAt")]
    pub finished_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<BackupJobResultPayload>,
    /// 是否可恢复（仅在失败状态下有效）
    #[serde(default)]
    pub resumable: bool,
}

// ============================================================================
// 任务持久化相关结构
// ============================================================================

/// 持久化的任务状态（用于存储到文件系统）
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PersistedJob {
    /// 任务 ID
    #[serde(alias = "jobId")]
    pub job_id: String,
    /// 任务类型
    pub kind: BackupJobKind,
    /// 任务状态
    pub status: BackupJobStatus,
    /// 任务阶段
    pub phase: BackupJobPhase,
    /// 当前进度
    pub progress: f32,
    /// 创建时间
    #[serde(alias = "createdAt")]
    pub created_at: DateTime<Utc>,
    /// 开始时间
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(alias = "startedAt")]
    pub started_at: Option<DateTime<Utc>>,
    /// 任务参数（用于恢复）
    pub params: serde_json::Value,
    /// 断点信息
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<JobCheckpoint>,
    /// 错误信息（如果失败）
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(alias = "errorMessage")]
    pub error_message: Option<String>,
}

/// 任务检查点（断点续传支持）
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JobCheckpoint {
    /// 已处理的文件/数据库列表
    #[serde(alias = "processedItems")]
    pub processed_items: Vec<String>,
    /// 输出路径（部分完成的文件）
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(alias = "partialOutput")]
    pub partial_output: Option<String>,
    /// 最后更新时间
    #[serde(alias = "lastUpdated")]
    pub last_updated: DateTime<Utc>,
    /// 当前处理的项目索引
    #[serde(alias = "currentIndex")]
    pub current_index: usize,
    /// 总项目数
    #[serde(alias = "totalItems")]
    pub total_items: usize,
}

impl JobCheckpoint {
    /// 创建新的检查点
    pub fn new(total_items: usize) -> Self {
        Self {
            processed_items: Vec::new(),
            partial_output: None,
            last_updated: Utc::now(),
            current_index: 0,
            total_items,
        }
    }

    /// 标记一个项目为已处理
    pub fn mark_processed(&mut self, item: &str) {
        if !self.processed_items.contains(&item.to_string()) {
            self.processed_items.push(item.to_string());
        }
        self.current_index = self.processed_items.len();
        self.last_updated = Utc::now();
    }

    /// 检查项目是否已处理
    pub fn is_processed(&self, item: &str) -> bool {
        self.processed_items.contains(&item.to_string())
    }

    /// 设置部分输出路径
    pub fn set_partial_output(&mut self, path: &str) {
        self.partial_output = Some(path.to_string());
        self.last_updated = Utc::now();
    }
}

/// 任务参数（用于恢复任务）
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BackupJobParams {
    /// 备份类型（full, incremental, tiered）
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(alias = "backupType")]
    pub backup_type: Option<String>,
    /// 基础版本（增量备份用）
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(alias = "baseVersion")]
    pub base_version: Option<String>,
    /// 是否包含资产
    #[serde(default, alias = "includeAssets")]
    pub include_assets: bool,
    /// 资产类型列表
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(alias = "assetTypes")]
    pub asset_types: Option<Vec<String>>,
    /// ZIP 导出/导入路径
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(alias = "zipPath")]
    pub zip_path: Option<String>,
    /// 备份 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(alias = "backupId")]
    pub backup_id: Option<String>,
    /// 输出路径
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(alias = "outputPath")]
    pub output_path: Option<String>,
    /// 压缩级别
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(alias = "compressionLevel")]
    pub compression_level: Option<u32>,
    /// 是否包含校验和
    #[serde(default, alias = "includeChecksums")]
    pub include_checksums: bool,
}

impl Default for BackupJobParams {
    fn default() -> Self {
        Self {
            backup_type: Some("full".to_string()),
            base_version: None,
            include_assets: false,
            asset_types: None,
            zip_path: None,
            backup_id: None,
            output_path: None,
            compression_level: Some(6),
            include_checksums: true,
        }
    }
}

struct JobRuntimeState {
    status: BackupJobStatus,
    phase: BackupJobPhase,
    progress: f32,
    message: Option<String>,
    processed_items: u64,
    total_items: u64,
    result: Option<BackupJobResultPayload>,
    /// 任务参数（用于持久化和恢复）
    params: Option<BackupJobParams>,
    /// 检查点信息（断点续传支持）
    checkpoint: Option<JobCheckpoint>,
}

impl Default for JobRuntimeState {
    fn default() -> Self {
        Self {
            status: BackupJobStatus::Queued,
            phase: BackupJobPhase::Queued,
            progress: 0.0,
            message: None,
            processed_items: 0,
            total_items: 0,
            result: None,
            params: None,
            checkpoint: None,
        }
    }
}

struct JobState {
    id: String,
    kind: BackupJobKind,
    cancel_flag: AtomicBool,
    created_at: DateTime<Utc>,
    started_at: Mutex<Option<DateTime<Utc>>>,
    started_instant: Mutex<Option<Instant>>,
    finished_at: Mutex<Option<DateTime<Utc>>>,
    runtime: Mutex<JobRuntimeState>,
    /// 最大执行时间，超时后在 cleanup 中标记为失败
    max_duration: Mutex<Option<Duration>>,
}

impl JobState {
    fn new(id: String, kind: BackupJobKind) -> Self {
        Self {
            id,
            kind,
            cancel_flag: AtomicBool::new(false),
            created_at: Utc::now(),
            started_at: Mutex::new(None),
            started_instant: Mutex::new(None),
            finished_at: Mutex::new(None),
            runtime: Mutex::new(JobRuntimeState::default()),
            max_duration: Mutex::new(Some(Duration::from_secs(DEFAULT_JOB_MAX_DURATION_SECS))),
        }
    }

    fn set_started(&self) {
        {
            let mut started_at = safe_lock(&self.started_at);
            if started_at.is_none() {
                *started_at = Some(Utc::now());
            }
        }
        {
            let mut started_instant = safe_lock(&self.started_instant);
            if started_instant.is_none() {
                *started_instant = Some(Instant::now());
            }
        }
    }

    fn set_finished(&self) {
        let mut finished_at = safe_lock(&self.finished_at);
        if finished_at.is_none() {
            *finished_at = Some(Utc::now());
        }
    }

    fn compute_eta(&self, progress: f32) -> Option<u64> {
        if progress <= 0.0 || progress >= 100.0 {
            return None;
        }
        let started_instant_guard = safe_lock(&self.started_instant);
        let started = started_instant_guard.as_ref()?;
        let elapsed = started.elapsed().as_secs_f32();
        if elapsed <= 0.0 {
            return None;
        }
        let ratio = (100.0 - progress) / progress;
        Some((elapsed * ratio).max(0.0) as u64)
    }

    fn snapshot(&self) -> BackupJobEvent {
        let runtime = safe_lock(&self.runtime);
        let started_at = safe_lock_option(&self.started_at);
        let finished_at = safe_lock_option(&self.finished_at);
        BackupJobEvent {
            job_id: self.id.clone(),
            kind: self.kind,
            status: runtime.status,
            phase: runtime.phase,
            progress: runtime.progress.clamp(0.0, 100.0),
            message: runtime.message.clone(),
            processed_items: runtime.processed_items,
            total_items: runtime.total_items,
            eta_seconds: self.compute_eta(runtime.progress),
            cancellable: !matches!(
                runtime.status,
                BackupJobStatus::Completed | BackupJobStatus::Failed | BackupJobStatus::Cancelled
            ),
            created_at: self.created_at,
            started_at,
            finished_at,
            result: runtime.result.clone(),
        }
    }

    fn summary(&self) -> BackupJobSummary {
        let runtime = safe_lock(&self.runtime);
        let started_at = safe_lock_option(&self.started_at);
        let finished_at = safe_lock_option(&self.finished_at);
        // 任务在失败状态且有检查点时可恢复
        let resumable = runtime.status == BackupJobStatus::Failed && runtime.checkpoint.is_some();
        BackupJobSummary {
            job_id: self.id.clone(),
            kind: self.kind,
            status: runtime.status,
            phase: runtime.phase,
            progress: runtime.progress.clamp(0.0, 100.0),
            message: runtime.message.clone(),
            created_at: self.created_at,
            started_at,
            finished_at,
            result: runtime.result.clone(),
            resumable,
        }
    }
}

/// 任务上下文，提供进度更新、取消检测等能力。
#[derive(Clone)]
pub struct BackupJobContext {
    manager: BackupJobManager,
    pub job_id: String,
}

impl BackupJobContext {
    pub fn new(manager: BackupJobManager, job_id: String) -> Self {
        Self { manager, job_id }
    }

    pub fn is_cancelled(&self) -> bool {
        self.manager
            .with_state(&self.job_id, |state| {
                state.cancel_flag.load(Ordering::Relaxed)
            })
            .unwrap_or(true)
    }

    /// 检查是否应该继续执行，如果已取消则返回 Err
    ///
    /// 用于在长时间操作的检查点位置调用，以支持更细粒度的取消响应。
    ///
    /// # Example
    /// ```ignore
    /// job_ctx.check_continue()?;
    /// let result = manager.backup_full();
    /// job_ctx.check_continue()?;
    /// ```
    pub fn check_continue(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err("任务已被取消".to_string())
        } else {
            Ok(())
        }
    }

    pub fn mark_running(
        &self,
        phase: BackupJobPhase,
        progress: f32,
        message: Option<String>,
        processed: u64,
        total: u64,
    ) {
        self.manager.update_runtime(
            &self.job_id,
            BackupJobStatus::Running,
            phase,
            progress,
            message,
            processed,
            total,
            None,
        );
    }

    pub fn complete(
        &self,
        message: Option<String>,
        processed: u64,
        total: u64,
        result: BackupJobResultPayload,
    ) {
        self.manager.update_runtime(
            &self.job_id,
            BackupJobStatus::Completed,
            BackupJobPhase::Completed,
            100.0,
            message,
            processed,
            total,
            Some(result),
        );
        // 任务完成后删除持久化文件
        let _ = self.manager.delete_persisted_job(&self.job_id);
        // 延迟从内存中移除（给前端时间获取最终状态）
        self.manager.schedule_job_removal(&self.job_id);
    }

    pub fn fail(&self, error: String) {
        // 获取当前进度信息（而非重置为 0），以便用户知道失败时的进度
        let (current_progress, current_processed, current_total) = self
            .manager
            .with_state(&self.job_id, |state| {
                let runtime = safe_lock(&state.runtime);
                (
                    runtime.progress,
                    runtime.processed_items,
                    runtime.total_items,
                )
            })
            .unwrap_or((0.0, 0, 0));

        self.manager.update_runtime(
            &self.job_id,
            BackupJobStatus::Failed,
            BackupJobPhase::Failed,
            current_progress, // 保留当前进度
            Some(error.clone()),
            current_processed, // 保留已处理数
            current_total,     // 保留总数
            Some(BackupJobResultPayload {
                success: false,
                output_path: None,
                resolved_path: None,
                message: None,
                error: Some(error.clone()),
                duration_ms: None,
                stats: None,
                requires_restart: false,
                checkpoint_path: None,
                resumable_job_id: Some(self.job_id.clone()),
            }),
        );
        // 失败时持久化任务状态以供恢复
        if let Err(e) = self.manager.persist_job(&self.job_id) {
            warn!("[BackupJob] 持久化失败任务时出错: {}", e);
        }
    }

    pub fn cancelled(&self, message: Option<String>) {
        self.manager.update_runtime(
            &self.job_id,
            BackupJobStatus::Cancelled,
            BackupJobPhase::Cancelled,
            0.0,
            message.clone(),
            0,
            0,
            Some(BackupJobResultPayload {
                success: false,
                output_path: None,
                resolved_path: None,
                message,
                error: Some("任务已取消".to_string()),
                duration_ms: None,
                stats: None,
                requires_restart: false,
                checkpoint_path: None,
                resumable_job_id: None,
            }),
        );
        // 任务取消后删除持久化文件
        let _ = self.manager.delete_persisted_job(&self.job_id);
        // 延迟从内存中移除（给前端时间获取最终状态）
        self.manager.schedule_job_removal(&self.job_id);
    }

    pub fn emit_legacy_progress(&self, progress: &ImportProgress) {
        self.manager.emit_legacy_progress(progress);
    }

    // ========================================================================
    // 检查点支持方法
    // ========================================================================

    /// 设置任务参数（用于持久化和恢复）
    pub fn set_params(&self, params: BackupJobParams) {
        self.manager.with_state(&self.job_id, |state| {
            let mut runtime = safe_lock(&state.runtime);
            runtime.params = Some(params);
        });
    }

    /// 初始化检查点（在开始处理之前调用）
    pub fn init_checkpoint(&self, total_items: usize) {
        self.manager.with_state(&self.job_id, |state| {
            let mut runtime = safe_lock(&state.runtime);
            runtime.checkpoint = Some(JobCheckpoint::new(total_items));
        });
    }

    /// 更新检查点（每处理完一个文件/数据库调用）
    pub fn update_checkpoint(&self, item: &str) {
        self.manager.with_state(&self.job_id, |state| {
            let mut runtime = safe_lock(&state.runtime);
            if let Some(ref mut checkpoint) = runtime.checkpoint {
                checkpoint.mark_processed(item);
            }
        });
        // 定期持久化检查点（可选：根据需要调整频率）
        let _ = self.manager.persist_job(&self.job_id);
    }

    /// 设置部分输出路径
    pub fn set_partial_output(&self, path: &str) {
        self.manager.with_state(&self.job_id, |state| {
            let mut runtime = safe_lock(&state.runtime);
            if let Some(ref mut checkpoint) = runtime.checkpoint {
                checkpoint.set_partial_output(path);
            }
        });
    }

    /// 获取已处理的项列表
    pub fn get_processed_items(&self) -> Vec<String> {
        self.manager
            .with_state(&self.job_id, |state| {
                let runtime = safe_lock(&state.runtime);
                runtime
                    .checkpoint
                    .as_ref()
                    .map(|cp| cp.processed_items.clone())
                    .unwrap_or_default()
            })
            .unwrap_or_default()
    }

    /// 检查某项是否已处理
    pub fn is_item_processed(&self, item: &str) -> bool {
        self.manager
            .with_state(&self.job_id, |state| {
                let runtime = safe_lock(&state.runtime);
                runtime
                    .checkpoint
                    .as_ref()
                    .map(|cp| cp.is_processed(item))
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    }

    /// 获取检查点
    pub fn get_checkpoint(&self) -> Option<JobCheckpoint> {
        self.manager
            .with_state(&self.job_id, |state| {
                let runtime = safe_lock(&state.runtime);
                runtime.checkpoint.clone()
            })
            .flatten()
    }

    /// 从持久化数据恢复检查点
    pub fn restore_checkpoint(&self, checkpoint: JobCheckpoint) {
        self.manager.with_state(&self.job_id, |state| {
            let mut runtime = safe_lock(&state.runtime);
            runtime.checkpoint = Some(checkpoint);
        });
    }

    /// 设置任务最大执行时间
    ///
    /// 超过此时间的运行中任务将在 cleanup 时被标记为失败。
    /// 传入 `None` 可取消超时限制。
    pub fn set_max_duration(&self, duration: Option<Duration>) {
        self.manager.with_state(&self.job_id, |state| {
            let mut guard = safe_lock(&state.max_duration);
            *guard = duration;
        });
    }
}

/// 备份任务持久化目录名
const BACKUP_JOBS_DIR: &str = "backup_jobs";

/// 已完成任务在内存中保留的时间（秒）
/// 给前端足够的时间获取最终状态
const COMPLETED_JOB_RETENTION_SECS: u64 = 60;

/// 默认任务最大执行时间（4 小时）
const DEFAULT_JOB_MAX_DURATION_SECS: u64 = 4 * 60 * 60;

#[derive(Clone)]
pub struct BackupJobManager {
    app_handle: Arc<AppHandle>,
    jobs: Arc<DashMap<String, Arc<JobState>>>,
    /// 持久化目录路径
    persist_dir: Arc<RwLock<Option<PathBuf>>>,
}

/// 备份任务管理器全局状态（Tauri State 包装器）
///
/// 用于在 Tauri 应用中作为单例状态管理备份任务。
/// 所有 Tauri 命令应通过 `State<BackupJobManagerState>` 注入获取管理器实例，
/// 而不是每次创建新的 `BackupJobManager`。
pub struct BackupJobManagerState(pub Arc<BackupJobManager>);

impl BackupJobManagerState {
    /// 创建新的状态包装器
    pub fn new(app_handle: AppHandle) -> Self {
        Self(Arc::new(BackupJobManager::new(app_handle)))
    }

    /// 获取内部的 BackupJobManager 引用
    pub fn get(&self) -> Arc<BackupJobManager> {
        Arc::clone(&self.0)
    }

    /// 获取内部的 BackupJobManager 不可变引用（用于简单查询）
    pub fn inner(&self) -> &BackupJobManager {
        &self.0
    }
}

impl BackupJobManager {
    pub fn new(app_handle: AppHandle) -> Self {
        // 尝试获取应用数据目录作为持久化目录的基础
        let persist_dir = app_handle
            .path()
            .app_data_dir()
            .ok()
            .map(|dir| dir.join(BACKUP_JOBS_DIR));

        Self {
            app_handle: Arc::new(app_handle),
            jobs: Arc::new(DashMap::new()),
            persist_dir: Arc::new(RwLock::new(persist_dir)),
        }
    }

    pub fn app_handle(&self) -> AppHandle {
        self.app_handle.as_ref().clone()
    }

    pub fn create_job(&self, kind: BackupJobKind) -> BackupJobContext {
        let id = Uuid::new_v4().to_string();
        let state = Arc::new(JobState::new(id.clone(), kind));
        self.jobs.insert(id.clone(), state);
        self.emit(&id);
        BackupJobContext::new(self.clone(), id)
    }

    /// 使用指定的 ID 创建任务（用于恢复任务）
    pub fn create_job_with_id(&self, job_id: String, kind: BackupJobKind) -> BackupJobContext {
        let state = Arc::new(JobState::new(job_id.clone(), kind));
        self.jobs.insert(job_id.clone(), state);
        self.emit(&job_id);
        BackupJobContext::new(self.clone(), job_id)
    }

    pub fn request_cancel(&self, job_id: &str) -> bool {
        self.with_state(job_id, |state| {
            if state
                .cancel_flag
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                debug!("[BackupJob] 请求取消任务 {}", job_id);
                true
            } else {
                false
            }
        })
        .unwrap_or(false)
    }

    pub fn list_jobs(&self) -> Vec<BackupJobSummary> {
        self.jobs
            .iter()
            .map(|entry| entry.value().summary())
            .collect()
    }

    pub fn get_job(&self, job_id: &str) -> Option<BackupJobSummary> {
        self.jobs.get(job_id).map(|state| state.summary())
    }

    fn update_runtime(
        &self,
        job_id: &str,
        status: BackupJobStatus,
        phase: BackupJobPhase,
        progress: f32,
        message: Option<String>,
        processed: u64,
        total: u64,
        result: Option<BackupJobResultPayload>,
    ) {
        if let Some(state) = self.jobs.get(job_id) {
            {
                let mut guard = safe_lock(&state.runtime);
                // 验证状态转换合法性（状态机单调性）
                if !guard.status.can_transition_to(status) {
                    warn!(
                        "[BackupJob] 无效的状态转换: {:?} -> {:?}, job_id={}",
                        guard.status, status, job_id
                    );
                    return;
                }
                guard.status = status;
                guard.phase = phase;
                guard.progress = progress;
                guard.message = message;
                guard.processed_items = processed;
                guard.total_items = total;
                if let Some(res) = result.clone() {
                    guard.result = Some(res);
                }
            }
            // 在 runtime 锁释放后设置时间戳（避免嵌套锁）
            if status == BackupJobStatus::Running {
                state.set_started();
            } else if status.is_terminal() {
                state.set_finished();
            }
            drop(state);
            self.emit(job_id);
        } else {
            warn!("[BackupJob] 尝试更新不存在的任务状态，job_id={}", job_id);
        }
    }

    fn emit(&self, job_id: &str) {
        if let Some(state) = self.jobs.get(job_id) {
            let snapshot = state.snapshot();
            if let Err(err) = self
                .app_handle
                .emit("backup-job-progress", snapshot.clone())
            {
                warn!("[BackupJob] 任务事件广播失败: {}", err);
            }
            drop(state);
        }
    }

    pub fn emit_legacy_progress(&self, progress: &ImportProgress) {
        if let Err(err) = self.app_handle.emit("backup-import-progress", progress) {
            warn!("[BackupJob] legacy progress emit failed: {}", err);
        }
    }

    fn with_state<F, R>(&self, job_id: &str, f: F) -> Option<R>
    where
        F: FnOnce(&JobState) -> R,
    {
        self.jobs.get(job_id).map(|state| f(&state))
    }

    // ========================================================================
    // 任务持久化方法
    // ========================================================================

    /// 获取持久化目录路径
    fn get_persist_dir(&self) -> Option<PathBuf> {
        self.persist_dir
            .read()
            .unwrap_or_else(|e| {
                error!("[BackupJobManager] persist_dir RwLock poisoned! Attempting recovery");
                e.into_inner()
            })
            .clone()
    }

    /// 确保持久化目录存在
    fn ensure_persist_dir(&self) -> Result<PathBuf, String> {
        let dir = self
            .get_persist_dir()
            .ok_or_else(|| "无法获取持久化目录路径".to_string())?;

        if !dir.exists() {
            fs::create_dir_all(&dir).map_err(|e| format!("创建持久化目录失败: {}", e))?;
        }

        Ok(dir)
    }

    /// 保存任务状态到文件
    pub fn persist_job(&self, job_id: &str) -> Result<(), String> {
        let persist_dir = self.ensure_persist_dir()?;
        let file_path = persist_dir.join(format!("{}.json", job_id));

        let persisted = self.with_state(job_id, |state| {
            let runtime = safe_lock(&state.runtime);
            let started_at = safe_lock_option(&state.started_at);

            PersistedJob {
                job_id: state.id.clone(),
                kind: state.kind,
                status: runtime.status,
                phase: runtime.phase,
                progress: runtime.progress,
                created_at: state.created_at,
                started_at,
                params: runtime
                    .params
                    .as_ref()
                    .map(|p| serde_json::to_value(p).unwrap_or_default())
                    .unwrap_or_default(),
                checkpoint: runtime.checkpoint.clone(),
                error_message: runtime.result.as_ref().and_then(|r| r.error.clone()),
            }
        });

        let persisted = persisted.ok_or_else(|| format!("任务不存在: {}", job_id))?;

        let json = serde_json::to_string_pretty(&persisted)
            .map_err(|e| format!("序列化任务状态失败: {}", e))?;

        // 使用临时文件 + 原子重命名
        let temp_path = file_path.with_extension("json.tmp");
        fs::write(&temp_path, &json).map_err(|e| format!("写入临时文件失败: {}", e))?;
        fs::rename(&temp_path, &file_path).map_err(|e| format!("重命名文件失败: {}", e))?;

        debug!("[BackupJob] 任务已持久化: {} -> {:?}", job_id, file_path);

        Ok(())
    }

    /// 加载所有持久化的任务
    pub fn load_persisted_jobs(&self) -> Result<Vec<PersistedJob>, String> {
        let persist_dir = match self.get_persist_dir() {
            Some(dir) if dir.exists() => dir,
            _ => return Ok(Vec::new()),
        };

        let mut jobs = Vec::new();

        let entries =
            fs::read_dir(&persist_dir).map_err(|e| format!("读取持久化目录失败: {}", e))?;

        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    warn!("[BackupJob] 读取目录条目失败: {}", e);
                    continue;
                }
            };

            let path = entry.path();
            if !path.is_file() || path.extension().map(|e| e != "json").unwrap_or(true) {
                continue;
            }

            // 跳过临时文件
            if path
                .file_name()
                .map(|n| n.to_string_lossy().ends_with(".tmp"))
                .unwrap_or(false)
            {
                continue;
            }

            match fs::read_to_string(&path) {
                Ok(content) => match serde_json::from_str::<PersistedJob>(&content) {
                    Ok(job) => {
                        info!("[BackupJob] 加载持久化任务: {}", job.job_id);
                        jobs.push(job);
                    }
                    Err(e) => {
                        warn!("[BackupJob] 解析持久化任务失败 {:?}: {}", path, e);
                    }
                },
                Err(e) => {
                    warn!("[BackupJob] 读取持久化任务失败 {:?}: {}", path, e);
                }
            }
        }

        Ok(jobs)
    }

    /// 删除持久化文件
    pub fn delete_persisted_job(&self, job_id: &str) -> Result<(), String> {
        let persist_dir = match self.get_persist_dir() {
            Some(dir) if dir.exists() => dir,
            _ => return Ok(()), // 目录不存在，无需删除
        };

        let file_path = persist_dir.join(format!("{}.json", job_id));

        if file_path.exists() {
            fs::remove_file(&file_path).map_err(|e| format!("删除持久化文件失败: {}", e))?;
            debug!("[BackupJob] 已删除持久化文件: {:?}", file_path);
        }

        Ok(())
    }

    /// 从持久化数据恢复任务到内存
    pub fn restore_job_from_persisted(&self, persisted: &PersistedJob) -> BackupJobContext {
        // 创建新任务
        let ctx = self.create_job_with_id(persisted.job_id.clone(), persisted.kind);

        // 恢复参数
        if let Ok(params) = serde_json::from_value::<BackupJobParams>(persisted.params.clone()) {
            ctx.set_params(params);
        }

        // 恢复检查点
        if let Some(checkpoint) = &persisted.checkpoint {
            ctx.restore_checkpoint(checkpoint.clone());
        }

        ctx
    }

    /// 获取可恢复的任务列表
    pub fn list_resumable_jobs(&self) -> Result<Vec<PersistedJob>, String> {
        let jobs = self.load_persisted_jobs()?;
        Ok(jobs
            .into_iter()
            .filter(|job| {
                // 只返回失败且有检查点的任务
                job.status == BackupJobStatus::Failed && job.checkpoint.is_some()
            })
            .collect())
    }

    /// 清理所有已完成或已取消的持久化任务
    pub fn cleanup_finished_persisted_jobs(&self) -> Result<usize, String> {
        let jobs = self.load_persisted_jobs()?;
        let mut cleaned = 0;

        for job in jobs {
            if matches!(
                job.status,
                BackupJobStatus::Completed | BackupJobStatus::Cancelled
            ) {
                if let Err(e) = self.delete_persisted_job(&job.job_id) {
                    warn!("[BackupJob] 清理持久化任务失败 {}: {}", job.job_id, e);
                } else {
                    cleaned += 1;
                }
            }
        }

        Ok(cleaned)
    }

    /// 从内存中移除任务
    ///
    /// 通常在任务完成/取消后延迟调用，给前端时间获取最终状态
    pub fn remove_job(&self, job_id: &str) {
        if self.jobs.remove(job_id).is_some() {
            debug!("[BackupJob] 任务已从内存移除: {}", job_id);
        }
    }

    /// 延迟从内存中移除任务
    ///
    /// 在任务完成/取消后调用，等待一段时间后再从内存中移除，
    /// 给前端足够的时间获取最终状态
    pub fn schedule_job_removal(&self, job_id: &str) {
        let jobs = Arc::clone(&self.jobs);
        let job_id_owned = job_id.to_string();

        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(COMPLETED_JOB_RETENTION_SECS)).await;
            if jobs.remove(&job_id_owned).is_some() {
                debug!("[BackupJob] 任务已从内存移除（延迟清理）: {}", job_id_owned);
            }
        });
    }

    /// 清理已完成的内存任务（定期清理）
    ///
    /// 移除内存中超过保留时间的已完成/失败/取消任务。
    /// 同时检测运行超时的任务并标记为失败。
    pub fn cleanup_completed_jobs(&self, max_age_secs: u64) {
        let now = Utc::now();

        // Phase 1: 收集所有任务条目（Arc clone），立即释放 DashMap shard 锁
        let entries: Vec<(String, Arc<JobState>)> = self
            .jobs
            .iter()
            .map(|entry| (entry.key().clone(), Arc::clone(entry.value())))
            .collect();

        let mut to_remove: Vec<(String, i64)> = Vec::new();
        let mut to_timeout: Vec<String> = Vec::new();

        // Phase 2: 在 DashMap 锁外检查每个任务状态（仅持有单个 Mutex 锁）
        for (job_id, state) in &entries {
            let status = {
                let runtime = safe_lock(&state.runtime);
                runtime.status
            };

            match status {
                BackupJobStatus::Completed
                | BackupJobStatus::Failed
                | BackupJobStatus::Cancelled => {
                    let finished_at = safe_lock_option(&state.finished_at);
                    if let Some(finished) = finished_at {
                        let age_secs = (now - finished).num_seconds();
                        if age_secs > max_age_secs as i64 {
                            to_remove.push((job_id.clone(), age_secs));
                        }
                    }
                }
                BackupJobStatus::Running => {
                    // 检查作业是否超时
                    let max_dur = safe_lock_option(&state.max_duration);
                    if let Some(max_dur) = max_dur {
                        let started = safe_lock_option(&state.started_instant);
                        if let Some(started) = started {
                            if started.elapsed() > max_dur {
                                to_timeout.push(job_id.clone());
                            }
                        }
                    }
                }
                _ => {} // Queued 任务保留
            }
        }

        // Phase 3: 标记超时任务为失败
        for job_id in &to_timeout {
            warn!("[BackupJob] 任务执行超时，标记为失败: {}", job_id);
            self.mark_failure(job_id, "任务执行超时".to_string());
        }

        // Phase 4: 批量移除过期任务
        let removed_count = to_remove.len();
        for (job_id, age_secs) in &to_remove {
            debug!(
                "[BackupJob] 清理过期任务: {} (已完成 {}s)",
                job_id, age_secs
            );
            self.jobs.remove(job_id);
        }

        let timeout_count = to_timeout.len();
        if removed_count > 0 || timeout_count > 0 {
            info!(
                "[BackupJob] 定期清理完成: 移除了 {} 个过期任务, {} 个任务超时标记为失败",
                removed_count, timeout_count
            );
        }
    }
}

impl BackupJobManager {
    pub fn mark_failure(&self, job_id: &str, error: String) {
        // 获取当前进度信息（而非重置为 0），以便用户知道失败时的进度
        let (current_progress, current_processed, current_total) = self
            .with_state(job_id, |state| {
                let runtime = safe_lock(&state.runtime);
                (
                    runtime.progress,
                    runtime.processed_items,
                    runtime.total_items,
                )
            })
            .unwrap_or((0.0, 0, 0));

        self.update_runtime(
            job_id,
            BackupJobStatus::Failed,
            BackupJobPhase::Failed,
            current_progress, // 保留当前进度
            Some(error.clone()),
            current_processed, // 保留已处理数
            current_total,     // 保留总数
            Some(BackupJobResultPayload {
                success: false,
                output_path: None,
                resolved_path: None,
                message: None,
                error: Some(error),
                duration_ms: None,
                stats: None,
                requires_restart: false,
                checkpoint_path: None,
                resumable_job_id: Some(job_id.to_string()),
            }),
        );
        // 失败时持久化任务状态以供恢复
        if let Err(e) = self.persist_job(job_id) {
            warn!("[BackupJob] 持久化失败任务时出错: {}", e);
        }
    }

    pub fn mark_cancelled(&self, job_id: &str, message: Option<String>) {
        self.update_runtime(
            job_id,
            BackupJobStatus::Cancelled,
            BackupJobPhase::Cancelled,
            0.0,
            message.clone(),
            0,
            0,
            Some(BackupJobResultPayload {
                success: false,
                output_path: None,
                resolved_path: None,
                message,
                error: Some("任务已取消".to_string()),
                duration_ms: None,
                stats: None,
                requires_restart: false,
                checkpoint_path: None,
                resumable_job_id: None,
            }),
        );
        // 任务取消后删除持久化文件
        let _ = self.delete_persisted_job(job_id);
        // 延迟从内存中移除（给前端时间获取最终状态）
        self.schedule_job_removal(job_id);
    }
}
