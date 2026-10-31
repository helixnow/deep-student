//! vfs 对上层能力（memory / media / qbank）的回调注册点。
//!
//! 拆分后 vfs 是低层 crate，不能反向依赖这些业务域；由 `extensions::register_extensions()`
//! 在启动时接线。所有回调在“全部注册”时的可观察行为与拆分前直接调用一致。

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, OnceLock, RwLock};

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

static NOTE_DELETE_HOOKS: RwLock<Vec<Arc<dyn NoteDeleteHook>>> = RwLock::new(Vec::new());

pub fn register_note_delete_hook(hook: Arc<dyn NoteDeleteHook>) {
    NOTE_DELETE_HOOKS
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .push(hook);
}

pub(crate) fn note_delete_continuations(
    db: &Arc<VfsDatabase>,
    note_id: &str,
) -> Vec<Box<dyn FnOnce() + Send>> {
    NOTE_DELETE_HOOKS
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
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

static MEDIA_TRANSCRIBER: OnceLock<Arc<dyn MediaTranscriber>> = OnceLock::new();

pub fn register_media_transcriber(transcriber: Arc<dyn MediaTranscriber>) {
    let _ = MEDIA_TRANSCRIBER.set(transcriber);
}

pub(crate) fn media_transcriber() -> Option<Arc<dyn MediaTranscriber>> {
    MEDIA_TRANSCRIBER.get().cloned()
}

pub trait ResourceCreatedHook: Send + Sync {
    fn on_resource_created(&self, app: &AppHandle, resource_id: &str);
}

static RESOURCE_CREATED_HOOKS: RwLock<Vec<Arc<dyn ResourceCreatedHook>>> = RwLock::new(Vec::new());

pub fn register_resource_created_hook(hook: Arc<dyn ResourceCreatedHook>) {
    RESOURCE_CREATED_HOOKS
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .push(hook);
}

pub fn notify_resource_created(app: &AppHandle, resource_id: &str) {
    let hooks = RESOURCE_CREATED_HOOKS
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
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

static EXAM_DOCUMENT_EXPORTER: OnceLock<Arc<dyn ExamDocumentExporter>> = OnceLock::new();

pub fn register_exam_document_exporter(exporter: Arc<dyn ExamDocumentExporter>) {
    let _ = EXAM_DOCUMENT_EXPORTER.set(exporter);
}

pub(crate) fn exam_document_exporter() -> Option<Arc<dyn ExamDocumentExporter>> {
    EXAM_DOCUMENT_EXPORTER.get().cloned()
}
