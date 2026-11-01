//! vfs 对上层能力（memory / media / qbank）的回调注册点。
//!
//! 拆分后 vfs 是低层 crate，不能反向依赖这些业务域；由 `extensions::register_extensions()`
//! 在启动时接线。所有回调在“全部注册”时的可观察行为与拆分前直接调用一致。
//!
//! 注册机制统一走 `dstu-kernel`：多订阅者用 [`HookSet`]，单提供方用 [`Slot`]。
//! `register_*` 返回 [`Disposer`]，由 `extensions.rs` 的插件 `Scope` 持有；槽位被
//! 占用时保持“先注册者生效”（返回 `Err(SlotOccupied)`，调用方忽略即等价于旧
//! `let _ = set(..)`）。

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use dstu_kernel::{Disposer, HookSet, Slot, SlotOccupied};
use serde_json::Value;
use tauri::AppHandle;
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;

use crate::database::Database;
use crate::llm_manager::LLMManager;
use crate::vfs::database::VfsDatabase;

// ============================================================================
// 笔记删除（memory）
// ============================================================================

pub trait NoteDeleteHook: Send + Sync {
    /// 删除前调用；返回删除成功后要执行的收尾动作，保持“先取上下文、后清理”的原顺序。
    fn capture_delete(
        &self,
        db: &Arc<VfsDatabase>,
        note_id: &str,
    ) -> Option<Box<dyn FnOnce() + Send>>;
}

static NOTE_DELETE_HOOKS: HookSet<dyn NoteDeleteHook> = HookSet::new();

pub fn register_note_delete_hook(hook: Arc<dyn NoteDeleteHook>) -> Disposer {
    NOTE_DELETE_HOOKS.register(hook)
}

pub(crate) fn note_delete_continuations(
    db: &Arc<VfsDatabase>,
    note_id: &str,
) -> Vec<Box<dyn FnOnce() + Send>> {
    // 先快照再回调（不持锁执行 capture_delete）。
    NOTE_DELETE_HOOKS
        .snapshot()
        .iter()
        .filter_map(|hook| hook.capture_delete(db, note_id))
        .collect()
}

// ============================================================================
// 媒体转写（media）
// ============================================================================

pub struct MediaTranscriptionProgress {
    pub stage: String,
    pub percent: f32,
    pub completed_segments: Option<i64>,
    pub total_segments: Option<i64>,
}

pub struct MediaTranscriptionSummary {
    pub transcript_chars: usize,
    pub done_segments: i64,
    pub total_segments: i64,
    pub failed_segments: i64,
}

pub struct MediaTranscriptionFailure {
    pub cancelled: bool,
    /// 旧代码 warn! 里的 Display 文本
    pub display: String,
    /// 旧代码 set_error / emit_error 用的 payload 字符串
    pub payload: String,
}

pub struct MediaTranscriptionRequest {
    pub vfs_db: Arc<VfsDatabase>,
    pub llm_manager: Arc<LLMManager>,
    pub settings_db: Arc<Database>,
    pub file_id: String,
    pub temp_dir: PathBuf,
    pub cancel: CancellationToken,
    /// 字幕导入的计划不构建 ASR 后端
    pub imported: bool,
    pub progress: UnboundedSender<MediaTranscriptionProgress>,
}

pub trait MediaTranscriber: Send + Sync {
    fn transcribe(
        &self,
        req: MediaTranscriptionRequest,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<MediaTranscriptionSummary, MediaTranscriptionFailure>>
                + Send,
        >,
    >;
}

static MEDIA_TRANSCRIBER: Slot<dyn MediaTranscriber> = Slot::new();

/// 注册媒体转写实现；槽位已占用时返回 `Err(SlotOccupied)`（先注册者生效）。
pub fn register_media_transcriber(
    transcriber: Arc<dyn MediaTranscriber>,
) -> Result<Disposer, SlotOccupied> {
    MEDIA_TRANSCRIBER.provide(transcriber)
}

pub(crate) fn media_transcriber() -> Option<Arc<dyn MediaTranscriber>> {
    MEDIA_TRANSCRIBER.get()
}

pub trait ResourceCreatedHook: Send + Sync {
    fn on_resource_created(&self, app: &AppHandle, resource_id: &str);
}

static RESOURCE_CREATED_HOOKS: HookSet<dyn ResourceCreatedHook> = HookSet::new();

pub fn register_resource_created_hook(hook: Arc<dyn ResourceCreatedHook>) -> Disposer {
    RESOURCE_CREATED_HOOKS.register(hook)
}

pub fn notify_resource_created(app: &AppHandle, resource_id: &str) {
    // 先快照再调用：回调期间不持锁，之后被移除的钩子本轮仍会执行。
    let hooks = RESOURCE_CREATED_HOOKS.snapshot();
    for hook in hooks {
        hook.on_resource_created(app, resource_id);
    }
}

// ============================================================================
// 题目集导出（qbank）
// ============================================================================

pub trait ExamDocumentExporter: Send + Sync {
    fn export_document(&self, db: &VfsDatabase, exam_id: &str) -> Result<Value, String>;
}

static EXAM_DOCUMENT_EXPORTER: Slot<dyn ExamDocumentExporter> = Slot::new();

/// 注册题目集导出实现；槽位已占用时返回 `Err(SlotOccupied)`（先注册者生效）。
pub fn register_exam_document_exporter(
    exporter: Arc<dyn ExamDocumentExporter>,
) -> Result<Disposer, SlotOccupied> {
    EXAM_DOCUMENT_EXPORTER.provide(exporter)
}

pub(crate) fn exam_document_exporter() -> Option<Arc<dyn ExamDocumentExporter>> {
    EXAM_DOCUMENT_EXPORTER.get()
}
