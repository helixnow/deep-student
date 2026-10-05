//! 媒体转写 Tauri 命令（设计契约 §1.3）
//!
//! | 命令 | 说明 |
//! |---|---|
//! | `media_transcribe_estimate(resourceId)` | `{durationMs, plannedSegments, asrModel, asrConfigured, exact}` |
//! | `media_transcribe_start(resourceId)` | 入队；已在队 / 已完成返回现状 |
//! | `media_transcribe_cancel(resourceId)` | 取消；已完成段保留 |
//! | `media_transcript_get(resourceId)` | `{status, segments:[{idx,startMs,endMs,text,status}], progress}` |
//! | `media_transcript_import(resourceId, path)` | `.srt/.vtt/BCC .json` → `source='import'` 段并触发索引 |
//! | `media_transcript_export(resourceId, format, dest)` | `srt`/`vtt`/`txt`（含 content:// 目标） |
//! | `media_progress_get(resourceId)` / `media_progress_set(resourceId, …)` | 断点续播与观看时长 |
//!
//! `resourceId` 为 `files.id`（`file_*` / `att_*`），也接受 `res_*`。
//! 错误以 `{"code":…,"message":…}` JSON 字符串返回（code 见 [`MediaError::code`]）。

use std::sync::Arc;

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use tauri::{State, Window};
use tokio_util::sync::CancellationToken;

use super::pipeline::{
    link_only_error, load_media_file, resolve_media_source, write_transcript_text, MediaFileInfo,
};
use super::subtitle::{export_segments, parse_subtitle, ExportFormat, MAX_SUBTITLE_BYTES};
use super::MediaError;
use crate::commands::AppState;
use crate::vfs::database::VfsDatabase;
use crate::vfs::pdf_processing_service::PdfProcessingService;
use crate::vfs::repos::media_transcript_repo::{
    MediaProgressRow, MediaProgressUpdate, MediaTranscriptRepo, SegmentCounts,
};

type CmdResult<T> = Result<T, String>;

fn err(e: MediaError) -> String {
    e.to_payload_string()
}

/// 精确估算（解码 + VAD）的时长上限；更长的媒体走容器头快速探测 + 经验段长
const EXACT_ESTIMATE_MAX_MS: i64 = 20 * 60 * 1000;
/// 快速估算时每段平均时长（经验值：讲课语速下 VAD 段约 8–10 s）
const HEURISTIC_SEGMENT_MS: i64 = 9_000;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeEstimate {
    pub duration_ms: Option<i64>,
    pub planned_segments: Option<i64>,
    pub asr_model: String,
    pub asr_configured: bool,
    /// true = 实际解码 + VAD 得到；false = 按时长经验估算
    pub exact: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegmentView {
    pub idx: i64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub status: i64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptProgressView {
    /// 任务阶段（queued / decode / vad / asr / indexing / completed / completed_with_issues / error / cancelled）
    pub stage: Option<String>,
    pub percent: f32,
    pub completed_segments: i64,
    pub total_segments: i64,
    pub failed_segments: i64,
    pub duration_ms: Option<i64>,
    /// 段来源：asr | import
    pub source: Option<String>,
    pub plan_version: Option<i64>,
    pub error: Option<String>,
}

/// 转写状态：none | queued | running | completed | partial | error | cancelled
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptStatusView {
    pub resource_id: String,
    pub media_type: String,
    pub status: String,
    pub progress: TranscriptProgressView,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptView {
    pub resource_id: String,
    pub media_type: String,
    pub status: String,
    pub segments: Vec<TranscriptSegmentView>,
    pub progress: TranscriptProgressView,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptExportResult {
    pub path: String,
    pub format: String,
    pub segments: usize,
    pub bytes: usize,
}

/// 由任务状态与段计数推导对外状态
pub fn derive_status(
    running: bool,
    processing_status: Option<&str>,
    counts: &SegmentCounts,
) -> &'static str {
    if running {
        return match processing_status {
            Some("queued") | Some("pending") | None => "queued",
            _ => "running",
        };
    }
    if counts.total == 0 {
        return match processing_status {
            Some("error") => "error",
            Some("cancelled") => "cancelled",
            _ => "none",
        };
    }
    if counts.done == counts.total {
        return "completed";
    }
    match processing_status {
        Some("error") => "error",
        Some("cancelled") => "cancelled",
        _ => "partial",
    }
}

struct TaskRow {
    status: Option<String>,
    progress_json: Option<String>,
    error: Option<String>,
}

fn load_task_row(vfs_db: &VfsDatabase, file_id: &str) -> Result<TaskRow, MediaError> {
    let conn = vfs_db.get_conn_safe()?;
    let row = conn
        .query_row(
            "SELECT processing_status, processing_progress, processing_error FROM files WHERE id = ?1",
            params![file_id],
            |r| {
                Ok(TaskRow {
                    status: r.get(0)?,
                    progress_json: r.get(1)?,
                    error: r.get(2)?,
                })
            },
        )
        .optional()?;
    Ok(row.unwrap_or(TaskRow {
        status: None,
        progress_json: None,
        error: None,
    }))
}

fn media_type_label(info: &MediaFileInfo) -> String {
    match info.kind() {
        Some(super::MediaKind::Video) => "video".to_string(),
        _ => "audio".to_string(),
    }
}

/// 组装状态视图（`with_segments=false` 时 segments 为空）
pub fn build_view(
    vfs_db: &VfsDatabase,
    info: &MediaFileInfo,
    running: bool,
    with_segments: bool,
) -> Result<TranscriptView, MediaError> {
    let task = load_task_row(vfs_db, &info.file_id)?;
    let conn = vfs_db.get_conn_safe()?;
    let counts = MediaTranscriptRepo::counts_with_conn(&conn, &info.file_id)?;
    let plan = MediaTranscriptRepo::plan_info_with_conn(&conn, &info.file_id)?;
    let progress_row = MediaTranscriptRepo::get_progress_with_conn(&conn, &info.file_id)?;
    let segments = if with_segments {
        MediaTranscriptRepo::list_segments_with_conn(&conn, &info.file_id)?
            .into_iter()
            .map(|s| TranscriptSegmentView {
                idx: s.idx,
                start_ms: s.start_ms,
                end_ms: s.end_ms,
                text: s.text,
                status: s.status,
            })
            .collect()
    } else {
        Vec::new()
    };
    let status = derive_status(running, task.status.as_deref(), &counts).to_string();
    let percent = task
        .progress_json
        .as_deref()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
        .and_then(|v| v.get("percent").and_then(|p| p.as_f64()))
        .map(|p| p as f32)
        .unwrap_or(if status == "completed" { 100.0 } else { 0.0 });
    let error = if status == "error" || status == "partial" {
        task.error.clone()
    } else {
        None
    };
    Ok(TranscriptView {
        resource_id: info.file_id.clone(),
        media_type: media_type_label(info),
        status,
        segments,
        progress: TranscriptProgressView {
            stage: task.status,
            percent,
            completed_segments: counts.done,
            total_segments: counts.total,
            failed_segments: counts.failed,
            duration_ms: progress_row.and_then(|p| p.duration_ms),
            source: plan.as_ref().map(|(_, s)| s.clone()),
            plan_version: plan.map(|(v, _)| v),
            error,
        },
    })
}

fn status_view(view: TranscriptView) -> TranscriptStatusView {
    TranscriptStatusView {
        resource_id: view.resource_id,
        media_type: view.media_type,
        status: view.status,
        progress: view.progress,
    }
}

fn vfs(state: &State<'_, Arc<VfsDatabase>>) -> Arc<VfsDatabase> {
    Arc::clone(state.inner())
}

pub(crate) async fn load(vfs_db: &Arc<VfsDatabase>, id: &str) -> Result<MediaFileInfo, MediaError> {
    let db = Arc::clone(vfs_db);
    let id = id.to_string();
    tokio::task::spawn_blocking(move || load_media_file(&db, &id))
        .await
        .map_err(|e| MediaError::Io(e.to_string()))?
}

/// 估算：已有计划 → 直接返回；短媒体解码 + VAD；长媒体容器头探测 + 经验段长
pub fn estimate_impl(
    vfs_db: &VfsDatabase,
    info: &MediaFileInfo,
) -> Result<(Option<i64>, Option<i64>, bool), MediaError> {
    {
        let conn = vfs_db.get_conn_safe()?;
        let counts = MediaTranscriptRepo::counts_with_conn(&conn, &info.file_id)?;
        if counts.total > 0 {
            let duration = MediaTranscriptRepo::get_progress_with_conn(&conn, &info.file_id)?
                .and_then(|p| p.duration_ms);
            return Ok((duration, Some(counts.total), true));
        }
    }
    if info.is_link_item() {
        return Err(link_only_error());
    }
    let source = resolve_media_source(vfs_db, &info.file_id)?;
    let ext = info.extension();
    let probed = super::decoder::probe(&source.path, ext.as_deref())?;
    let short_enough = probed
        .duration_ms
        .map(|d| d <= EXACT_ESTIMATE_MAX_MS)
        // 无时长头（部分 MP3/MKV）：小文件才实测
        .unwrap_or(info.size <= 30 * 1024 * 1024);
    if short_enough {
        let (duration, planned) = super::pipeline::estimate_segments(
            &source.path,
            ext.as_deref(),
            &CancellationToken::new(),
        )?;
        return Ok((Some(duration), Some(planned as i64), true));
    }
    let planned = probed
        .duration_ms
        .map(|d| (d + HEURISTIC_SEGMENT_MS - 1) / HEURISTIC_SEGMENT_MS);
    Ok((probed.duration_ms, planned, false))
}

#[tauri::command]
pub async fn media_transcribe_estimate(
    resource_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    state: State<'_, AppState>,
) -> CmdResult<TranscribeEstimate> {
    let db = vfs(&vfs_db);
    let info = load(&db, &resource_id).await.map_err(err)?;
    let (asr_model, configured) =
        match crate::voice_input::resolve_asr_endpoint(&state.llm_manager, &state.database).await {
            Ok(endpoint) => (endpoint.model, true),
            Err(error) => (error.model, false),
        };
    let (duration_ms, planned_segments, exact) = {
        let db = Arc::clone(&db);
        tokio::task::spawn_blocking(move || estimate_impl(&db, &info))
            .await
            .map_err(|e| err(MediaError::Io(e.to_string())))?
            .map_err(err)?
    };
    Ok(TranscribeEstimate {
        duration_ms,
        planned_segments,
        asr_model,
        asr_configured: configured,
        exact,
    })
}

#[tauri::command]
pub async fn media_transcribe_start(
    resource_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    pdf_processing_service: State<'_, Arc<PdfProcessingService>>,
    state: State<'_, AppState>,
) -> CmdResult<TranscriptStatusView> {
    let db = vfs(&vfs_db);
    let service = Arc::clone(pdf_processing_service.inner());
    let info = load(&db, &resource_id).await.map_err(err)?;
    if service.is_running(&info.file_id) {
        return build_view(&db, &info, true, false)
            .map(status_view)
            .map_err(err);
    }
    let current = build_view(&db, &info, false, false).map_err(err)?;
    if current.status == "completed" {
        return Ok(status_view(current));
    }
    if current.progress.source.as_deref() != Some("import") {
        if info.is_link_item() {
            return Err(err(link_only_error()));
        }
        if let Err(error) =
            crate::voice_input::resolve_asr_endpoint(&state.llm_manager, &state.database).await
        {
            return Err(err(MediaError::AsrFatal {
                code: error.code.into(),
                message: error.message,
            }));
        }
    }
    service
        .start_pipeline(&info.file_id, None)
        .await
        .map_err(|e| err(MediaError::Database(e.to_string())))?;
    let running = service.is_running(&info.file_id);
    build_view(&db, &info, running, false)
        .map(status_view)
        .map_err(err)
}

#[tauri::command]
pub async fn media_transcribe_cancel(
    resource_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    pdf_processing_service: State<'_, Arc<PdfProcessingService>>,
) -> CmdResult<TranscriptStatusView> {
    let db = vfs(&vfs_db);
    let info = load(&db, &resource_id).await.map_err(err)?;
    pdf_processing_service
        .cancel_media(&info.file_id)
        .map_err(|e| err(MediaError::Database(e.to_string())))?;
    build_view(&db, &info, false, false)
        .map(status_view)
        .map_err(err)
}

#[tauri::command]
pub async fn media_transcript_get(
    resource_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    pdf_processing_service: State<'_, Arc<PdfProcessingService>>,
) -> CmdResult<TranscriptView> {
    let db = vfs(&vfs_db);
    let info = load(&db, &resource_id).await.map_err(err)?;
    let running = pdf_processing_service.is_running(&info.file_id);
    tokio::task::spawn_blocking(move || build_view(&db, &info, running, true))
        .await
        .map_err(|e| err(MediaError::Io(e.to_string())))?
        .map_err(err)
}

/// 导入字幕：替换为 `source='import'` 段并立即写入转写文本，返回导入条数
pub fn import_subtitle_impl(
    vfs_db: &VfsDatabase,
    info: &MediaFileInfo,
    file_name: &str,
    bytes: &[u8],
) -> Result<usize, MediaError> {
    let cues = parse_subtitle(file_name, bytes)?;
    {
        let conn = vfs_db.get_conn_safe()?;
        MediaTranscriptRepo::set_imported_segments_with_conn(&conn, &info.file_id, &cues)?;
        if let Some(last) = cues.iter().map(|(span, _)| span.end_ms).max() {
            // 时长未知时用最后一条字幕的结束时间兜底，不覆盖解码得到的真实时长
            let known = MediaTranscriptRepo::get_progress_with_conn(&conn, &info.file_id)?
                .and_then(|p| p.duration_ms)
                .is_some();
            if !known {
                MediaTranscriptRepo::record_duration_with_conn(&conn, &info.file_id, last)?;
            }
        }
    }
    write_transcript_text(vfs_db, &info.file_id)?;
    Ok(cues.len())
}

#[tauri::command]
pub async fn media_transcript_import(
    window: Window,
    resource_id: String,
    path: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    pdf_processing_service: State<'_, Arc<PdfProcessingService>>,
) -> CmdResult<TranscriptView> {
    let db = vfs(&vfs_db);
    let service = Arc::clone(pdf_processing_service.inner());
    let info = load(&db, &resource_id).await.map_err(err)?;
    let bytes =
        crate::unified_file_manager::read_all_bytes_bounded(&window, &path, MAX_SUBTITLE_BYTES)
            .map_err(|e| err(MediaError::Io(e.message)))?;
    let file_name = crate::unified_file_manager::extract_file_name(&path);
    import_subtitle_bytes(&db, &service, &info, file_name, bytes)
        .await
        .map_err(err)
}

/// 字幕字节 → 替换为导入段 → 刷新检索 → 交给媒体任务承载方完成索引（文件导入与 B 站字幕共用）
pub(crate) async fn import_subtitle_bytes(
    db: &Arc<VfsDatabase>,
    service: &Arc<PdfProcessingService>,
    info: &MediaFileInfo,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<TranscriptView, MediaError> {
    // 正在 ASR：先停（字幕导入替换整份计划）
    if service.is_running(&info.file_id) {
        service
            .cancel_media(&info.file_id)
            .map_err(|e| MediaError::Database(e.to_string()))?;
    }
    let count = {
        let db = Arc::clone(db);
        let info = info.clone();
        tokio::task::spawn_blocking(move || import_subtitle_impl(&db, &info, &file_name, &bytes))
            .await
            .map_err(|e| MediaError::Io(e.to_string()))??
    };
    super::pipeline::refresh_index(db, &info.file_id);
    log::info!(
        "[media::commands] imported {} subtitle cues for {}",
        count,
        info.file_id
    );
    // 导入计划不跑 ASR、不占全局转写槽位，只完成索引
    if let Err(e) = service.start_pipeline(&info.file_id, None).await {
        log::warn!(
            "[media::commands] failed to schedule indexing for {}: {}",
            info.file_id,
            e
        );
    }
    let running = service.is_running(&info.file_id);
    build_view(db, info, running, true)
}

/// 生成导出内容（无已完成段时报错）
pub fn export_impl(
    vfs_db: &VfsDatabase,
    info: &MediaFileInfo,
    format: ExportFormat,
) -> Result<(String, usize), MediaError> {
    let conn = vfs_db.get_conn_safe()?;
    let segments = MediaTranscriptRepo::list_segments_with_conn(&conn, &info.file_id)?;
    let done = segments
        .iter()
        .filter(|s| {
            s.status == crate::vfs::repos::media_transcript_repo::SEGMENT_STATUS_DONE
                && !s.text.trim().is_empty()
        })
        .count();
    if done == 0 {
        return Err(MediaError::InvalidInput(
            "还没有可导出的字幕（请先转写或导入字幕）".into(),
        ));
    }
    Ok((export_segments(&segments, format), done))
}

#[tauri::command]
pub async fn media_transcript_export(
    window: Window,
    resource_id: String,
    format: String,
    dest: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> CmdResult<TranscriptExportResult> {
    let db = vfs(&vfs_db);
    let info = load(&db, &resource_id).await.map_err(err)?;
    let format = ExportFormat::parse(&format).map_err(err)?;
    let (content, count) = {
        let db = Arc::clone(&db);
        let info = info.clone();
        tokio::task::spawn_blocking(move || export_impl(&db, &info, format))
            .await
            .map_err(|e| err(MediaError::Io(e.to_string())))?
            .map_err(err)?
    };
    crate::unified_file_manager::write_text_file(&window, &dest, &content)
        .map_err(|e| err(MediaError::Io(e.message)))?;
    Ok(TranscriptExportResult {
        path: dest,
        format: format.extension().to_string(),
        segments: count,
        bytes: content.len(),
    })
}

#[tauri::command]
pub async fn media_progress_get(
    resource_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> CmdResult<Option<MediaProgressRow>> {
    let db = vfs(&vfs_db);
    let info = load(&db, &resource_id).await.map_err(err)?;
    let conn = db.get_conn_safe().map_err(|e| err(e.into()))?;
    MediaTranscriptRepo::get_progress_with_conn(&conn, &info.file_id).map_err(|e| err(e.into()))
}

#[tauri::command]
pub async fn media_progress_set(
    resource_id: String,
    position_ms: Option<i64>,
    duration_ms: Option<i64>,
    watched_delta_ms: Option<i64>,
    finished: Option<bool>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> CmdResult<MediaProgressRow> {
    let db = vfs(&vfs_db);
    let info = load(&db, &resource_id).await.map_err(err)?;
    let conn = db.get_conn_safe().map_err(|e| err(e.into()))?;
    MediaTranscriptRepo::set_progress_with_conn(
        &conn,
        &info.file_id,
        &MediaProgressUpdate {
            position_ms,
            duration_ms,
            watched_delta_ms,
            finished,
        },
    )
    .map_err(|e| err(e.into()))
}

/// 导入后是否自动开始转写：仅音频、尚无字幕段、时长 < 10 分钟（无时长头时按 ≤ 10 MB 判断）
pub fn auto_transcribe_eligible(vfs_db: &VfsDatabase, file_id: &str) -> Result<bool, MediaError> {
    let info = load_media_file(vfs_db, file_id)?;
    if info.kind() != Some(super::MediaKind::Audio) {
        return Ok(false);
    }
    {
        let conn = vfs_db.get_conn_safe()?;
        if MediaTranscriptRepo::counts_with_conn(&conn, &info.file_id)?.total > 0 {
            return Ok(false);
        }
    }
    let source = resolve_media_source(vfs_db, &info.file_id)?;
    let ext = info.extension();
    let duration = match super::decoder::probe(&source.path, ext.as_deref()) {
        Ok(p) => p.duration_ms,
        // 解码器都不认识的文件：不自动转写（用户手动转写时会看到明确原因）
        Err(_) => return Ok(false),
    };
    Ok(match duration {
        Some(d) => d < super::AUTO_TRANSCRIBE_MAX_DURATION_MS,
        None => info.size <= 10 * 1024 * 1024,
    })
}

/// 音频导入后的自动转写（替代旧的 ≤25 MB 整段转写路径）：异步、不阻塞导入；
/// ASR 未配置或不满足条件时静默跳过（预览页"转写"按钮仍可手动触发）。
pub fn spawn_auto_transcribe_if_short_audio(app: &tauri::AppHandle, file_id: String) {
    use tauri::Manager;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (Some(vfs_db), Some(service), Some(state)) = (
            app.try_state::<Arc<VfsDatabase>>(),
            app.try_state::<Arc<PdfProcessingService>>(),
            app.try_state::<AppState>(),
        ) else {
            return;
        };
        if let Err(error) =
            crate::voice_input::resolve_asr_endpoint(&state.llm_manager, &state.database).await
        {
            log::info!(
                "[media::commands] ASR not configured ({}), skip auto transcription for {}",
                error.code,
                file_id
            );
            return;
        }
        let db = Arc::clone(vfs_db.inner());
        let service = Arc::clone(service.inner());
        let id = file_id.clone();
        let eligible = tokio::task::spawn_blocking(move || auto_transcribe_eligible(&db, &id))
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or(false);
        if !eligible {
            return;
        }
        if let Err(e) = service.start_pipeline(&file_id, None).await {
            log::warn!(
                "[media::commands] auto transcription failed to start for {}: {}",
                file_id,
                e
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::pipeline::tests::{insert_media_file, lecture_wav};
    use crate::vfs::database::setup_migrated_test_db;

    fn counts(total: i64, done: i64, failed: i64) -> SegmentCounts {
        SegmentCounts {
            total,
            done,
            failed,
            pending: total - done - failed,
        }
    }

    #[test]
    fn status_derivation() {
        assert_eq!(
            derive_status(true, Some("queued"), &counts(0, 0, 0)),
            "queued"
        );
        assert_eq!(
            derive_status(true, Some("asr"), &counts(5, 2, 0)),
            "running"
        );
        assert_eq!(derive_status(false, None, &counts(0, 0, 0)), "none");
        assert_eq!(
            derive_status(false, Some("error"), &counts(0, 0, 0)),
            "error"
        );
        assert_eq!(
            derive_status(false, Some("completed"), &counts(5, 5, 0)),
            "completed"
        );
        assert_eq!(
            derive_status(false, Some("cancelled"), &counts(5, 2, 0)),
            "cancelled"
        );
        assert_eq!(
            derive_status(false, Some("completed_with_issues"), &counts(5, 4, 1)),
            "partial"
        );
        // 崩溃遗留的中间态（尚未被启动恢复接管）按已有段判断
        assert_eq!(
            derive_status(false, Some("asr"), &counts(5, 2, 0)),
            "partial"
        );
    }

    #[test]
    fn import_get_export_flow() {
        let (tmp, db) = setup_migrated_test_db();
        let path = tmp.path().join("talk.wav");
        lecture_wav(&path, &[(1.0, true), (1.0, false)], 16_000);
        insert_media_file(&db, "file_talk", &path);
        let info = load_media_file(&db, "file_talk").unwrap();
        assert_eq!(media_type_label(&info), "audio");

        let view = build_view(&db, &info, false, true).unwrap();
        assert_eq!(view.status, "none");
        assert!(export_impl(&db, &info, ExportFormat::Srt).is_err());

        let srt = "1\n00:00:00,500 --> 00:00:01,200\n第一句\n\n2\n00:01:05,000 --> 00:01:07,000\n第二句\n";
        let n = import_subtitle_impl(&db, &info, "talk.srt", srt.as_bytes()).unwrap();
        assert_eq!(n, 2);

        let view = build_view(&db, &info, false, true).unwrap();
        assert_eq!(view.status, "completed");
        assert_eq!(view.segments.len(), 2);
        assert_eq!(view.progress.source.as_deref(), Some("import"));
        assert_eq!(view.progress.duration_ms, Some(67_000));
        let json = serde_json::to_value(&view).unwrap();
        assert_eq!(json["segments"][1]["startMs"], 65_000);
        assert_eq!(json["progress"]["completedSegments"], 2);

        let extracted: String = db
            .get_conn_safe()
            .unwrap()
            .query_row(
                "SELECT extracted_text FROM files WHERE id='file_talk'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(extracted, "[00:00] 第一句\n[01:05] 第二句");

        let (vtt, count) = export_impl(&db, &info, ExportFormat::Vtt).unwrap();
        assert_eq!(count, 2);
        assert!(vtt.contains("00:01:05.000 --> 00:01:07.000\n第二句"));

        // 估算：已有计划 → 精确返回段数
        let (_, planned, exact) = estimate_impl(&db, &info).unwrap();
        assert_eq!(planned, Some(2));
        assert!(exact);
    }

    #[test]
    fn estimate_decodes_short_media() {
        let (tmp, db) = setup_migrated_test_db();
        let path = tmp.path().join("short.wav");
        lecture_wav(
            &path,
            &[(0.5, false), (2.0, true), (2.0, false), (2.0, true)],
            22_050,
        );
        insert_media_file(&db, "file_short", &path);
        let info = load_media_file(&db, "file_short").unwrap();
        let (duration, planned, exact) = estimate_impl(&db, &info).unwrap();
        assert_eq!(duration, Some(6_500));
        assert_eq!(planned, Some(2));
        assert!(exact);
    }

    #[test]
    fn auto_transcribe_only_for_short_untranscribed_audio() {
        let (tmp, db) = setup_migrated_test_db();
        let path = tmp.path().join("memo.wav");
        lecture_wav(&path, &[(1.0, true)], 16_000);
        insert_media_file(&db, "file_memo", &path);
        assert!(auto_transcribe_eligible(&db, "file_memo").unwrap());
        let info = load_media_file(&db, "file_memo").unwrap();
        import_subtitle_impl(
            &db,
            &info,
            "m.srt",
            b"1\n00:00:00,000 --> 00:00:01,000\nhi\n",
        )
        .unwrap();
        assert!(!auto_transcribe_eligible(&db, "file_memo").unwrap());
    }

    #[test]
    fn non_media_files_are_rejected() {
        let (_tmp, db) = setup_migrated_test_db();
        let conn = db.get_conn_safe().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO files (id, sha256, file_name, size, mime_type, status, created_at, updated_at)
             VALUES ('file_pdf', 'sha_pdf', 'a.pdf', 10, 'application/pdf', 'active', ?1, ?1)",
            params![now],
        )
        .unwrap();
        let e = load_media_file(&db, "file_pdf").unwrap_err();
        assert_eq!(e.code(), "invalid-input");
        let e = load_media_file(&db, "file_nope").unwrap_err();
        assert_eq!(e.code(), "not-found");
    }
}
