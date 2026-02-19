//! 进度事件发射器
//!
//! 负责将同步进度事件发送到前端，支持节流以避免过于频繁的更新。

use super::progress::{SyncPhase, SyncProgress};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

/// 进度事件名称
pub const EVENT_NAME: &str = "data-governance-sync-progress";

/// 节流间隔（毫秒）
const THROTTLE_INTERVAL: Duration = Duration::from_millis(100);

/// 进度发射器
///
/// 负责向前端发送同步进度事件。
/// 使用节流机制避免过于频繁的事件发送，但阶段变化时会强制发送。
pub struct SyncProgressEmitter {
    /// Tauri AppHandle
    app: AppHandle,
    /// 上次发射时间
    last_emit: Arc<Mutex<Option<Instant>>>,
    /// 上次发射的阶段（用于检测阶段变化）
    last_phase: Arc<Mutex<Option<SyncPhase>>>,
}

impl SyncProgressEmitter {
    /// 创建新的进度发射器
    ///
    /// # 参数
    /// * `app` - Tauri AppHandle
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            last_emit: Arc::new(Mutex::new(None)),
            last_phase: Arc::new(Mutex::new(None)),
        }
    }

    /// 发射进度事件（带节流）
    ///
    /// 正常情况下会根据节流间隔限制发送频率，但以下情况会强制发送：
    /// - 阶段发生变化
    /// - 进度达到终止状态（完成或失败）
    ///
    /// # 参数
    /// * `progress` - 当前进度
    pub async fn emit(&self, progress: SyncProgress) {
        let now = Instant::now();

        let mut last_emit_guard = self.last_emit.lock().await;
        let mut last_phase_guard = self.last_phase.lock().await;

        // 检查是否需要强制发射
        let phase_changed = last_phase_guard.map_or(true, |p| p != progress.phase);
        let is_terminal = progress.phase.is_terminal();

        // 如果阶段变化或达到终止状态，强制发射
        if phase_changed || is_terminal {
            self.do_emit(&progress);
            *last_emit_guard = Some(now);
            *last_phase_guard = Some(progress.phase);
            return;
        }

        // 检查是否满足节流条件
        let should_emit = match *last_emit_guard {
            None => true,
            Some(last) => now.duration_since(last) >= THROTTLE_INTERVAL,
        };

        if should_emit {
            self.do_emit(&progress);
            *last_emit_guard = Some(now);
            *last_phase_guard = Some(progress.phase);
        }
    }

    /// 强制发射进度事件（不节流）
    ///
    /// 无论节流状态如何，立即发送进度事件。
    ///
    /// # 参数
    /// * `progress` - 当前进度
    pub fn emit_force(&self, progress: SyncProgress) {
        self.do_emit(&progress);
    }

    /// 发射准备中状态
    pub async fn emit_preparing(&self) {
        self.emit(SyncProgress::preparing()).await;
    }

    /// 发射检测变更状态
    pub async fn emit_detecting_changes(&self) {
        self.emit(SyncProgress::detecting_changes()).await;
    }

    /// 发射上传进度
    ///
    /// # 参数
    /// * `current` - 当前项目数
    /// * `total` - 总项目数
    /// * `current_item` - 当前处理的项目名（可选）
    pub async fn emit_uploading(&self, current: u64, total: u64, current_item: Option<String>) {
        let mut progress = SyncProgress::uploading(current, total);
        if let Some(item) = current_item {
            progress = progress.with_current_item(item);
        }
        self.emit(progress).await;
    }

    /// 发射下载进度
    ///
    /// # 参数
    /// * `current` - 当前项目数
    /// * `total` - 总项目数
    /// * `current_item` - 当前处理的项目名（可选）
    pub async fn emit_downloading(&self, current: u64, total: u64, current_item: Option<String>) {
        let mut progress = SyncProgress::downloading(current, total);
        if let Some(item) = current_item {
            progress = progress.with_current_item(item);
        }
        self.emit(progress).await;
    }

    /// 发射应用变更进度
    ///
    /// # 参数
    /// * `current` - 当前项目数
    /// * `total` - 总项目数
    /// * `current_item` - 当前处理的项目名（可选）
    pub async fn emit_applying(&self, current: u64, total: u64, current_item: Option<String>) {
        let mut progress = SyncProgress::applying(current, total);
        if let Some(item) = current_item {
            progress = progress.with_current_item(item);
        }
        self.emit(progress).await;
    }

    /// 发射完成状态
    pub async fn emit_completed(&self) {
        self.emit(SyncProgress::completed()).await;
    }

    /// 发射失败状态
    ///
    /// # 参数
    /// * `error` - 错误信息
    pub async fn emit_failed(&self, error: impl Into<String>) {
        self.emit(SyncProgress::failed(error.into())).await;
    }

    /// 发射带速度信息的进度
    ///
    /// # 参数
    /// * `progress` - 基础进度
    /// * `speed_bytes_per_sec` - 传输速度（字节/秒）
    /// * `eta_seconds` - 预计剩余时间（秒）
    pub async fn emit_with_speed(
        &self,
        progress: SyncProgress,
        speed_bytes_per_sec: u64,
        eta_seconds: Option<u64>,
    ) {
        let progress = progress.with_speed(speed_bytes_per_sec, eta_seconds);
        self.emit(progress).await;
    }

    /// 实际发射事件
    fn do_emit(&self, progress: &SyncProgress) {
        if let Err(e) = self.app.emit(EVENT_NAME, progress) {
            tracing::error!("[sync_emitter] 发送进度事件失败: {}", e);
        } else {
            tracing::trace!(
                "[sync_emitter] 进度事件: phase={:?}, percent={:.1}%, current={}/{}",
                progress.phase,
                progress.percent,
                progress.current,
                progress.total
            );
        }
    }
}

impl Clone for SyncProgressEmitter {
    fn clone(&self) -> Self {
        Self {
            app: self.app.clone(),
            last_emit: Arc::clone(&self.last_emit),
            last_phase: Arc::clone(&self.last_phase),
        }
    }
}

/// 同步进度回调 trait
///
/// 为需要接收进度回调的同步操作提供统一接口。
#[async_trait::async_trait]
pub trait SyncProgressCallback: Send + Sync {
    /// 报告进度
    async fn on_progress(&self, progress: SyncProgress);

    /// 报告完成
    async fn on_complete(&self) {
        self.on_progress(SyncProgress::completed()).await;
    }

    /// 报告失败
    async fn on_error(&self, error: String) {
        self.on_progress(SyncProgress::failed(error)).await;
    }
}

#[async_trait::async_trait]
impl SyncProgressCallback for SyncProgressEmitter {
    async fn on_progress(&self, progress: SyncProgress) {
        self.emit(progress).await;
    }
}

/// 空进度回调（用于不需要进度报告的场景）
pub struct NoopProgressCallback;

#[async_trait::async_trait]
impl SyncProgressCallback for NoopProgressCallback {
    async fn on_progress(&self, _progress: SyncProgress) {
        // 不做任何事
    }
}

/// 可选的进度发射器包装
///
/// 用于同步方法中可选地接收进度回调。
pub struct OptionalEmitter {
    emitter: Option<SyncProgressEmitter>,
}

impl OptionalEmitter {
    /// 创建有发射器的包装
    pub fn with_emitter(emitter: SyncProgressEmitter) -> Self {
        Self {
            emitter: Some(emitter),
        }
    }

    /// 创建无发射器的包装
    pub fn none() -> Self {
        Self { emitter: None }
    }

    /// 发射进度（如果有发射器）
    pub async fn emit(&self, progress: SyncProgress) {
        if let Some(ref emitter) = self.emitter {
            emitter.emit(progress).await;
        }
    }

    /// 发射准备中状态
    pub async fn emit_preparing(&self) {
        self.emit(SyncProgress::preparing()).await;
    }

    /// 发射检测变更状态
    pub async fn emit_detecting_changes(&self) {
        self.emit(SyncProgress::detecting_changes()).await;
    }

    /// 发射上传进度
    pub async fn emit_uploading(&self, current: u64, total: u64, current_item: Option<String>) {
        let mut progress = SyncProgress::uploading(current, total);
        if let Some(item) = current_item {
            progress = progress.with_current_item(item);
        }
        self.emit(progress).await;
    }

    /// 发射下载进度
    pub async fn emit_downloading(&self, current: u64, total: u64, current_item: Option<String>) {
        let mut progress = SyncProgress::downloading(current, total);
        if let Some(item) = current_item {
            progress = progress.with_current_item(item);
        }
        self.emit(progress).await;
    }

    /// 发射应用变更进度
    pub async fn emit_applying(&self, current: u64, total: u64, current_item: Option<String>) {
        let mut progress = SyncProgress::applying(current, total);
        if let Some(item) = current_item {
            progress = progress.with_current_item(item);
        }
        self.emit(progress).await;
    }

    /// 发射完成状态
    pub async fn emit_completed(&self) {
        self.emit(SyncProgress::completed()).await;
    }

    /// 发射失败状态
    pub async fn emit_failed(&self, error: impl Into<String>) {
        self.emit(SyncProgress::failed(error.into())).await;
    }

    /// 是否有发射器
    pub fn has_emitter(&self) -> bool {
        self.emitter.is_some()
    }

    /// 同步强制发射（不节流）—— 专供 sync 回调闭包使用
    ///
    /// 与 `emit` 不同，此方法为同步，可在非 async 上下文（如上传进度回调）中安全调用。
    pub fn emit_force_sync(&self, progress: SyncProgress) {
        if let Some(ref emitter) = self.emitter {
            emitter.emit_force(progress);
        }
    }
}

impl Clone for OptionalEmitter {
    fn clone(&self) -> Self {
        Self {
            emitter: self.emitter.clone(),
        }
    }
}

impl From<Option<SyncProgressEmitter>> for OptionalEmitter {
    fn from(emitter: Option<SyncProgressEmitter>) -> Self {
        Self { emitter }
    }
}

impl From<SyncProgressEmitter> for OptionalEmitter {
    fn from(emitter: SyncProgressEmitter) -> Self {
        Self::with_emitter(emitter)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 注意：由于 SyncProgressEmitter 需要 AppHandle，
    // 实际的集成测试需要在 Tauri 环境中运行。
    // 这里只测试辅助结构。

    #[tokio::test]
    async fn test_optional_emitter_none() {
        let emitter = OptionalEmitter::none();
        assert!(!emitter.has_emitter());

        // 这些调用应该不会 panic
        emitter.emit_preparing().await;
        emitter
            .emit_uploading(1, 10, Some("test.txt".to_string()))
            .await;
        emitter.emit_completed().await;
    }

    #[test]
    fn test_optional_emitter_from_none() {
        let emitter: OptionalEmitter = None.into();
        assert!(!emitter.has_emitter());
    }

    #[tokio::test]
    async fn test_noop_callback() {
        let callback = NoopProgressCallback;
        // 这些调用应该不会 panic
        callback.on_progress(SyncProgress::preparing()).await;
        callback.on_complete().await;
        callback.on_error("test error".to_string()).await;
    }
}
